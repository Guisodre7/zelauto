-- =============================================================================
-- 0022 — Suporte assistido (Fase 1: chamado + acesso SÓ-LEITURA)
--
-- Regras aprovadas:
--   * Consentimento SEMPRE obrigatório: sem `autoriza_acesso`, não há sessão.
--   * Prazo padrão 2h (ajustável por sessão); o acesso EXPIRA sozinho.
--   * Auditado: cada sessão registra operador, loja, quando e até quando.
--   * O lojista VÊ o histórico de acessos de suporte da própria loja e pode
--     REVOGAR uma sessão ativa (encerrar_suporte).
--   * Isolamento por loja como toda tabela de negócio (guarda_loja restritiva).
--
-- Fase 2 (não aqui): habilitar ESCRITA no modo suporte, sempre pela porta e
-- registrada como "feito pelo suporte".
-- =============================================================================

-- Chamado: o lojista abre; um por dúvida.
create table public.suporte_chamados (
  id              uuid primary key default gen_random_uuid(),
  loja_id         uuid not null references public.lojas(id) on delete cascade,
  aberto_por      uuid default auth.uid() references auth.users(id) on delete set null,
  mensagem        text not null,
  autoriza_acesso boolean not null default false,   -- consentimento explícito
  status          text not null default 'aberto'
                  check (status in ('aberto','em_atendimento','resolvido')),
  criado_em       timestamptz not null default now(),
  resolvido_em    timestamptz
);
create index on public.suporte_chamados (loja_id, criado_em desc);

-- Sessão: um acesso concedido de operador àquela loja, com prazo.
-- operador_id/nome são denormalizados (o lojista não pode ler `operadores`).
create table public.suporte_sessoes (
  id           uuid primary key default gen_random_uuid(),
  chamado_id   uuid references public.suporte_chamados(id) on delete set null,
  loja_id      uuid not null references public.lojas(id) on delete cascade,
  operador_id  uuid,
  operador_nome text,
  criada_em    timestamptz not null default now(),
  expira_em    timestamptz not null,
  encerrada_em timestamptz,
  motivo_fim   text                                 -- 'operador' | 'lojista' | 'prazo'
);
create index on public.suporte_sessoes (loja_id, criada_em desc);

-- ---------------------------------------------------------------------------
-- RLS: isolamento por loja (restritiva) em ambas.
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['suporte_chamados','suporte_sessoes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    execute format($f$
      create policy guarda_loja on public.%I
        as restrictive for all to authenticated
        using (loja_id = app.loja_id()) with check (loja_id = app.loja_id())
    $f$, t);
  end loop;
end $$;

-- Chamados: o lojista lê os da própria loja e abre novos. Sem update/delete pelo
-- app (o status muda pela Edge `suporte`, service_role).
create policy ler   on public.suporte_chamados for select to authenticated using (loja_id = app.loja_id());
create policy abrir on public.suporte_chamados for insert to authenticated with check (loja_id = app.loja_id());
revoke update, delete on public.suporte_chamados from authenticated;

-- Sessões: o lojista SÓ LÊ o histórico da própria loja. Quem cria/encerra pelo
-- lado do operador é a Edge (service_role). A revogação pelo lojista é a função
-- dedicada abaixo (não um update solto).
create policy ler on public.suporte_sessoes for select to authenticated using (loja_id = app.loja_id());
revoke insert, update, delete on public.suporte_sessoes from authenticated;

-- ---------------------------------------------------------------------------
-- Revogar uma sessão ativa: só o PROPRIETÁRIO da própria loja. Fecha na hora.
-- ---------------------------------------------------------------------------
create or replace function public.encerrar_suporte(p_sessao uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_loja uuid;
begin
  select loja_id into v_loja from public.suporte_sessoes
    where id = p_sessao and encerrada_em is null and expira_em > now();
  if v_loja is null then return false; end if;                 -- já encerrada/expirada/inexistente
  if v_loja <> app.loja_id() or app.papel() <> 'proprietario' then
    raise exception 'sem permissão para encerrar este acesso';
  end if;
  update public.suporte_sessoes
     set encerrada_em = now(), motivo_fim = 'lojista'
   where id = p_sessao;
  return true;
end $$;

revoke execute on function public.encerrar_suporte(uuid) from public, anon;
grant  execute on function public.encerrar_suporte(uuid) to authenticated;
