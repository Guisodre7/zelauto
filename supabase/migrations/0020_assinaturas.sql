-- =============================================================================
-- 0020 — Assinatura da loja (cobrança recorrente via AbacatePay)
--
-- Plano pago por loja, com suspensão após 3 dias de carência do vencimento.
-- REGRAS DE SEGURANÇA:
--   * O lojista (proprietário) só LÊ o próprio plano — nunca escreve status nem
--     vencimento. Quem escreve é o servidor (Edge Functions cobranca/webhook,
--     via service_role), a partir do evento REAL de pagamento do provedor.
--   * Isolamento por loja como todas as tabelas de negócio.
--   * A chave da API e o segredo do webhook ficam em segredo de Edge Function,
--     nunca no navegador.
-- =============================================================================

-- Uma assinatura por loja (loja_id é a PK).
create table public.assinaturas (
  loja_id        uuid primary key references public.lojas(id) on delete cascade,
  plano          text not null default 'padrao',
  valor_centavos int  not null default 0,
  status         text not null default 'trial'
                 check (status in ('trial','ativa','vencida','suspensa','cancelada')),
  vence_em       date,                       -- pago-até (paid-through)
  provedor       text not null default 'abacatepay',
  cobranca_id    text,                        -- id da última cobrança no provedor
  brcode         text,                        -- último PIX copia-e-cola (conveniência)
  atualizado_em  timestamptz not null default now()
);

-- Log de pagamentos (histórico + idempotência do webhook).
create table public.pagamentos (
  id             uuid primary key default gen_random_uuid(),
  loja_id        uuid not null references public.lojas(id) on delete cascade,
  cobranca_id    text,
  valor_centavos int  not null default 0,
  metodo         text,                        -- 'pix' | 'cartao'
  status         text not null,               -- 'pago' | 'pendente' | ...
  pago_em        timestamptz,
  criado_em      timestamptz not null default now(),
  payload        jsonb
);
create index on public.pagamentos (loja_id, criado_em desc);
create unique index on public.pagamentos (cobranca_id) where cobranca_id is not null;

-- ---------------------------------------------------------------------------
-- RLS: leitura só do proprietário da loja; escrita só service_role (sem policy
-- de insert/update/delete para authenticated + revogação do privilégio).
-- ---------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['assinaturas','pagamentos'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);
    -- isolamento por loja (restritiva)
    execute format($f$
      create policy guarda_loja on public.%I
        as restrictive for all to authenticated
        using (loja_id = app.loja_id()) with check (loja_id = app.loja_id())
    $f$, t);
    -- leitura só do proprietário
    execute format($f$
      create policy ler on public.%I for select to authenticated
        using (loja_id = app.loja_id() and app.papel() = 'proprietario')
    $f$, t);
    -- sem escrita direta pelo app
    execute format('revoke insert, update, delete on public.%I from authenticated', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Gate de acesso: a loja está ativa? (trial/ativa, ou vencida dentro dos 3 dias
-- de carência). FAIL-SAFE: sem linha de assinatura => ativa, para um problema de
-- cobrança nunca trancar uma loja por engano. Suspensa/cancelada => bloqueada.
-- ---------------------------------------------------------------------------
create or replace function app.loja_ativa(p_loja uuid default null)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select case
      when a.status in ('trial','ativa')            then true
      when a.status in ('suspensa','cancelada')      then false
      when a.vence_em is not null
           and current_date <= a.vence_em + 3        then true   -- 3 dias de carência
      else false
    end
    from public.assinaturas a
    where a.loja_id = coalesce(p_loja, app.loja_id())
  ), true);
$$;

revoke execute on function app.loja_ativa(uuid) from public, anon;
grant  execute on function app.loja_ativa(uuid) to authenticated;

-- Wrapper em `public` para o app chamar via rpc (PostgREST só expõe `public`).
-- Devolve a situação da própria loja do token, para o gate de acesso na tela.
create or replace function public.minha_loja_ativa()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$ select app.loja_ativa(app.loja_id()); $$;

revoke execute on function public.minha_loja_ativa() from public, anon;
grant  execute on function public.minha_loja_ativa() to authenticated;
