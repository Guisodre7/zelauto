-- =============================================================================
-- 0024 — Suporte com acesso EDITÁVEL ao painel (Opção A, aprovada)
--
-- O que muda de conceito: o operador em suporte não olha uma cópia só-leitura.
-- Ele entra no app de verdade, como um usuário de verdade daquela loja —
-- "Suporte ZelAuto", papel gerente. Mesmas telas, mesma experiência, edição
-- funcionando. O que segura isso não é tirar o poder, é o cerco:
--
--   * consentimento obrigatório do proprietário (já existia);
--   * prazo curto que expira SOZINHO;
--   * nome próprio: toda escrita cai na auditoria como "Suporte ZelAuto",
--     nunca disfarçada de usuário do lojista;
--   * revogação de um clique, que corta o acesso no mesmo instante.
--
-- A peça central é `app.suporte_ativo`. Um token de suporte só enxerga alguma
-- coisa enquanto existir uma linha válida ali: `app.loja_id()` — a função que
-- TODA política de RLS já usa — devolve NULL quando não existe. Ou seja, o
-- corte vale para o sistema inteiro de uma vez, sem tocar em política nenhuma,
-- e a expiração acontece por comparação de relógio, sem depender de ninguém
-- lembrar de encerrar (nem de um cron rodar na hora certa).
--
-- Um token de LOJISTA não passa por esse caminho: para ele nada muda.
-- Não é destrutivo.
-- =============================================================================

-- Quem é o usuário de suporte daquela sessão (para deslogar e banir no fim).
alter table public.suporte_sessoes add column if not exists usuario_suporte uuid;

-- ---------------------------------------------------------------------------
-- O interruptor. Fica no schema `app`, SEM RLS e SEM grant para authenticated:
-- ninguém lê nem escreve pela API. Só as funções SECURITY DEFINER abaixo.
--
-- Sem RLS por necessidade, não por descuido: `app.loja_id()` é chamada DENTRO
-- das políticas, então se esta tabela tivesse política que chamasse
-- `app.loja_id()`, a RLS entraria em recursão infinita.
-- ---------------------------------------------------------------------------
create table if not exists app.suporte_ativo (
  usuario_id uuid primary key,
  loja_id    uuid not null,
  sessao_id  uuid not null,
  expira_em  timestamptz not null
);
revoke all on app.suporte_ativo from authenticated, anon;

-- ---------------------------------------------------------------------------
-- `app.loja_id()`: para o lojista, exatamente o que era. Para um token marcado
-- `suporte`, a loja só existe enquanto a sessão estiver viva e no prazo.
-- ---------------------------------------------------------------------------
create or replace function app.loja_id()
returns uuid
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select case
    when ((select auth.jwt()) -> 'app_metadata' ->> 'suporte') = 'true' then
      (select sa.loja_id
         from app.suporte_ativo sa
        where sa.usuario_id = (select auth.uid())
          and sa.expira_em  > now())
    else
      nullif(((select auth.jwt()) -> 'app_metadata' ->> 'loja_id'), '')::uuid
  end
$$;

-- ---------------------------------------------------------------------------
-- Abrir/fechar o acesso. Só a Edge Function (service_role) chama.
-- ---------------------------------------------------------------------------
create or replace function public.suporte_acesso_abrir(
  p_usuario uuid, p_loja uuid, p_sessao uuid, p_expira timestamptz)
returns void
language sql
security definer
set search_path = app, public, pg_temp
as $$
  insert into app.suporte_ativo (usuario_id, loja_id, sessao_id, expira_em)
  values (p_usuario, p_loja, p_sessao, p_expira)
  on conflict (usuario_id) do update
    set loja_id = excluded.loja_id,
        sessao_id = excluded.sessao_id,
        expira_em = excluded.expira_em;
$$;

create or replace function public.suporte_acesso_fechar(p_sessao uuid)
returns void
language sql
security definer
set search_path = app, public, pg_temp
as $$
  delete from app.suporte_ativo where sessao_id = p_sessao;
$$;

revoke execute on function public.suporte_acesso_abrir(uuid, uuid, uuid, timestamptz) from public, anon, authenticated;
revoke execute on function public.suporte_acesso_fechar(uuid) from public, anon, authenticated;
grant  execute on function public.suporte_acesso_abrir(uuid, uuid, uuid, timestamptz) to service_role;
grant  execute on function public.suporte_acesso_fechar(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Revogação pelo lojista: além de fechar a sessão no histórico, apaga o
-- interruptor. O acesso do operador morre no comando seguinte dele.
-- ---------------------------------------------------------------------------
create or replace function public.encerrar_suporte(p_sessao uuid)
returns boolean
language plpgsql
security definer
set search_path = app, public, pg_temp
as $$
declare v_loja uuid;
begin
  select loja_id into v_loja from public.suporte_sessoes
    where id = p_sessao and encerrada_em is null and expira_em > now();
  if v_loja is null then return false; end if;              -- já encerrada/expirada/inexistente
  if v_loja <> app.loja_id() or app.papel() <> 'proprietario' then
    raise exception 'sem permissão para encerrar este acesso';
  end if;
  update public.suporte_sessoes
     set encerrada_em = now(), motivo_fim = 'lojista'
   where id = p_sessao;
  delete from app.suporte_ativo where sessao_id = p_sessao;  -- corta na hora
  return true;
end $$;

revoke execute on function public.encerrar_suporte(uuid) from public, anon;
grant  execute on function public.encerrar_suporte(uuid) to authenticated;
