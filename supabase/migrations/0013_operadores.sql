-- =============================================================================
-- ZelAuto — 0013_operadores.sql
-- Control plane: registro de STAFF ZelAuto (operadores) + log de auditoria.
--
-- Padrão de SaaS: o operador que gerencia as lojas é uma identidade SEPARADA dos
-- usuários das lojas. Não tem perfil de loja — logo, pela RLS normal, não vê dado
-- de loja nenhuma. Só age pela Edge Function `admin` (service_role), que confere
-- se o uid está aqui antes de qualquer ação. Estas tabelas NÃO são legíveis pela
-- API (nem authenticated nem anon): só o service_role, dentro da função.
--
-- Não é destrutivo.
-- =============================================================================

create table if not exists public.operadores (
  id        uuid primary key references auth.users(id) on delete cascade,
  nome      text not null,
  criado_em timestamptz not null default now()
);
alter table public.operadores enable row level security;
alter table public.operadores force  row level security;
-- Negação EXPLÍCITA (não deixar "RLS ligada e zero políticas" — checklist do
-- CLAUDE.md e aviso rls_enabled_no_policy do Supabase). Só o service_role, que
-- ignora RLS, lê — dentro da Edge Function. Revogamos o grant padrão por garantia.
revoke all on public.operadores from authenticated, anon;
create policy nega_tudo on public.operadores as restrictive for all to authenticated, anon using (false) with check (false);

-- Auditoria do control plane: uma linha por ação de operador (criar loja, importar…)
create table if not exists public.operador_log (
  id          uuid primary key default gen_random_uuid(),
  operador_id uuid references public.operadores(id) on delete set null,
  acao        text not null,
  loja_id     uuid,
  detalhe     jsonb not null default '{}'::jsonb,
  criado_em   timestamptz not null default now()
);
alter table public.operador_log enable row level security;
alter table public.operador_log force  row level security;
revoke all on public.operador_log from authenticated, anon;
create policy nega_tudo on public.operador_log as restrictive for all to authenticated, anon using (false) with check (false);

-- Para promover alguém a operador (uma vez, no SQL Editor), o id vem de auth.users:
--   insert into public.operadores (id, nome)
--   select id, 'Seu Nome' from auth.users where email = 'voce@exemplo.com';
