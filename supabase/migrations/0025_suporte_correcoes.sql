-- =============================================================================
-- 0025 — Correções do suporte assistido (revisão de código da 0023/0024)
--
-- Cinco consertos, nenhum cosmético:
--
--  1. PERFORMANCE: a 0024 tornou `app.loja_id()` SECURITY DEFINER, e com isso o
--     Postgres deixou de fazer inlining dela — virava uma chamada de função por
--     linha, em TODAS as tabelas, para todo mundo. Agora só o ramo do suporte é
--     definer (`app.suporte_loja()`); `app.loja_id()` volta a ser uma função SQL
--     simples, inlineável, e o `case` nem avalia o ramo do suporte para um token
--     de lojista.
--
--  2. CONSENTIMENTO: abrir chamado deixa de poder já vir autorizado. Liberar o
--     painel é decisão do PROPRIETÁRIO, por um ato separado (`autorizar`) — um
--     vendedor não entrega a loja sem o dono saber.
--
--  3. REVOGAR É REVOGAR: encerrar a sessão zera `autoriza_acesso` do chamado.
--     Sem isso, o operador reentrava com um clique e a revogação virava pausa.
--
--  4. O usuário de suporte da loja passa a ter endereço fixo em
--     `app.suporte_usuario`, em vez de ser reencontrado pelo histórico de
--     sessões. Se um `entrar` falhava no meio, o usuário ficava órfão e todo
--     `entrar` seguinte falhava por e-mail duplicado, para sempre.
--
-- Não é destrutivo.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. O ramo do suporte, isolado numa função definer própria.
-- ---------------------------------------------------------------------------
create or replace function app.suporte_loja()
returns uuid
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select sa.loja_id
    from app.suporte_ativo sa
   where sa.usuario_id = (select auth.uid())
     and sa.expira_em  > now()
$$;
revoke execute on function app.suporte_loja() from public, anon;
grant  execute on function app.suporte_loja() to authenticated;

-- `app.loja_id()` volta a ser inlineável: sem SECURITY DEFINER, sem search_path.
-- Para um token de lojista o `case` sequer olha o ramo do suporte.
create or replace function app.loja_id()
returns uuid
language sql
stable
as $$
  select case
    when ((select auth.jwt()) -> 'app_metadata' ->> 'suporte') = 'true'
      then app.suporte_loja()
    else nullif(((select auth.jwt()) -> 'app_metadata' ->> 'loja_id'), '')::uuid
  end
$$;

-- ---------------------------------------------------------------------------
-- 2. Chamado nasce SEM autorização de acesso, sempre.
-- ---------------------------------------------------------------------------
drop policy if exists abrir on public.suporte_chamados;
create policy abrir on public.suporte_chamados
  for insert to authenticated
  with check (loja_id = app.loja_id() and autoriza_acesso = false);

-- ---------------------------------------------------------------------------
-- 3 e 4. Revogar zera o consentimento; endereço fixo do usuário de suporte.
-- ---------------------------------------------------------------------------
create or replace function public.encerrar_suporte(p_sessao uuid)
returns boolean
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare v_loja uuid; v_chamado uuid;
begin
  select loja_id, chamado_id into v_loja, v_chamado
    from public.suporte_sessoes
   where id = p_sessao and encerrada_em is null and expira_em > now();
  if v_loja is null then return false; end if;
  if v_loja <> app.loja_id() or app.papel() <> 'proprietario' then
    raise exception 'sem permissão para encerrar este acesso';
  end if;

  update public.suporte_sessoes
     set encerrada_em = now(), motivo_fim = 'lojista'
   where id = p_sessao;
  delete from app.suporte_ativo where sessao_id = p_sessao;   -- corta na hora

  -- Revogar é revogar: para voltar, o dono autoriza de novo.
  if v_chamado is not null then
    update public.suporte_chamados set autoriza_acesso = false where id = v_chamado;
  end if;
  return true;
end $$;
revoke execute on function public.encerrar_suporte(uuid) from public, anon;
grant  execute on function public.encerrar_suporte(uuid) to authenticated;

create table if not exists app.suporte_usuario (
  loja_id    uuid primary key,
  usuario_id uuid not null,
  criado_em  timestamptz not null default now()
);
revoke all on app.suporte_usuario from authenticated, anon;

create or replace function public.suporte_usuario_registrar(p_loja uuid, p_usuario uuid)
returns void language sql security definer set search_path = app, public, pg_temp as $$
  insert into app.suporte_usuario (loja_id, usuario_id) values (p_loja, p_usuario)
  on conflict (loja_id) do update set usuario_id = excluded.usuario_id;
$$;

create or replace function public.suporte_usuario_de(p_loja uuid)
returns uuid language sql stable security definer set search_path = app, public, pg_temp as $$
  select usuario_id from app.suporte_usuario where loja_id = p_loja;
$$;

revoke execute on function public.suporte_usuario_registrar(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.suporte_usuario_de(uuid) from public, anon, authenticated;
grant  execute on function public.suporte_usuario_registrar(uuid, uuid) to service_role;
grant  execute on function public.suporte_usuario_de(uuid) to service_role;

-- Semeia com o que já existe no histórico, para não recriar usuário à toa.
insert into app.suporte_usuario (loja_id, usuario_id)
select distinct on (loja_id) loja_id, usuario_suporte
  from public.suporte_sessoes
 where usuario_suporte is not null
 order by loja_id, criada_em desc
on conflict (loja_id) do nothing;
