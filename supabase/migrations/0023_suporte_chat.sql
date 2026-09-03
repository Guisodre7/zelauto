-- =============================================================================
-- 0023 — Suporte: conversa (chat) dentro do chamado
--
-- O chamado deixa de ser um bilhete de mão única e vira uma conversa. O caminho
-- que o lojista percorre é: perguntas frequentes → conversa com a gente →
-- (só se não resolver) autorizar acesso ao painel.
--
-- Quem ESCREVE aqui é sempre server-side:
--   * lojista  → Edge Function `suporte-chat` (confere o perfil, carimba o nome
--                do autor e dispara o e-mail para o operador)
--   * operador → Edge Function `suporte`     (confere `operadores`)
-- Pelo app, o lojista só LÊ (RLS) e marca como lida (função dedicada). Assim
-- ninguém consegue forjar uma mensagem "do suporte" dentro da própria loja.
--
-- Não é destrutivo: só cria tabela e funções.
-- =============================================================================

create table public.suporte_mensagens (
  id               uuid primary key default gen_random_uuid(),
  chamado_id       uuid not null references public.suporte_chamados(id) on delete cascade,
  loja_id          uuid not null references public.lojas(id) on delete cascade,
  autor            text not null check (autor in ('lojista','operador')),
  autor_id         uuid,                       -- auth.uid() do lojista ou id do operador
  autor_nome       text not null,              -- carimbado no servidor, nunca pelo cliente
  texto            text not null,
  criado_em        timestamptz not null default now(),
  lida_lojista_em  timestamptz,                -- quando o lojista leu (mensagem do operador)
  lida_operador_em timestamptz                 -- quando o operador leu (mensagem do lojista)
);
create index on public.suporte_mensagens (chamado_id, criado_em);
create index on public.suporte_mensagens (loja_id, criado_em desc);

-- ---------------------------------------------------------------------------
-- RLS: isolamento por loja (restritiva), leitura pela própria loja e nada mais.
-- ---------------------------------------------------------------------------
alter table public.suporte_mensagens enable row level security;
alter table public.suporte_mensagens force  row level security;

create policy guarda_loja on public.suporte_mensagens
  as restrictive for all to authenticated
  using (loja_id = app.loja_id()) with check (loja_id = app.loja_id());

create policy ler on public.suporte_mensagens
  for select to authenticated using (loja_id = app.loja_id());

-- Escrita só pelas Edge Functions (service_role). O app do lojista não insere.
revoke insert, update, delete on public.suporte_mensagens from authenticated;

-- ---------------------------------------------------------------------------
-- Marcar como lidas as mensagens do suporte naquele chamado. Qualquer usuário
-- da loja pode (é a caixa de entrada da loja); presa ao loja_id do JWT.
-- ---------------------------------------------------------------------------
create or replace function public.marcar_suporte_lido(p_chamado uuid)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare v_n integer;
begin
  update public.suporte_mensagens
     set lida_lojista_em = now()
   where chamado_id = p_chamado
     and loja_id    = app.loja_id()          -- nunca a caixa de outra loja
     and autor      = 'operador'
     and lida_lojista_em is null;
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke execute on function public.marcar_suporte_lido(uuid) from public, anon;
grant  execute on function public.marcar_suporte_lido(uuid) to authenticated;
