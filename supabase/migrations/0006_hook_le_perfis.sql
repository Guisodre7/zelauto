-- =============================================================================
-- ZelAuto — 0006_hook_le_perfis.sql
-- Corrige o custom_access_token_hook sob RLS forçada.
--
-- Sintoma (login real, ponta-a-ponta): o hook não injeta loja_id no JWT, então
-- app.loja_id() = null, a política guarda_loja esconde o PRÓPRIO perfil do
-- usuário, e GET /rest/v1/perfis?...&id=eq.<uid> volta 0 linhas -> PostgREST 406
-- no .single().
--
-- Causa: o hook roda como supabase_auth_admin. perfis tem `force row level
-- security`, então um GRANT SELECT não basta — é preciso uma POLÍTICA para esse
-- papel. A 0002 concedeu o grant mas não criou a política (a doc oficial do
-- Supabase para o hook cria as duas coisas).
--
-- Só adiciona uma política permissiva de SELECT para supabase_auth_admin.
-- guarda_loja é `to authenticated`, então não afeta este papel. Não é destrutivo.
-- =============================================================================

create policy hook_auth_le_perfis on public.perfis
  as permissive for select to supabase_auth_admin
  using (true);
