-- =============================================================================
-- 0027 — A aba do suporte sabe quando foi cortada
--
-- Problema: o operador encerra o acesso (pelo Console ou o dono pelo banner), o
-- painel do lojista reage na hora — mas a ABA de suporte do operador seguia
-- aberta, contando o tempo e mostrando dados velhos. No servidor o acesso já
-- morreu (`app.suporte_ativo` apagado, `app.loja_id()` devolve NULL), mas a aba
-- não tinha como perguntar "ainda estou dentro?".
--
-- Esta função responde exatamente isso para o próprio chamador: true enquanto
-- houver acesso de suporte vivo, false quando acabou. A aba chama de tempos em
-- tempos e, no false, se expulsa (recarrega para a tela de login).
--
-- Não é destrutivo.
-- =============================================================================

create or replace function public.suporte_meu_acesso_ativo()
returns boolean
language sql
stable
security definer
set search_path = app, public, pg_temp
as $$
  select app.suporte_loja() is not null
$$;

revoke execute on function public.suporte_meu_acesso_ativo() from public, anon;
grant  execute on function public.suporte_meu_acesso_ativo() to authenticated;
