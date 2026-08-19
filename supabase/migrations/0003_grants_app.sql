-- =============================================================================
-- ZelAuto — 0003_grants_app.sql
-- Correção: dar acesso ao schema `app` para o papel authenticated.
--
-- Sintoma (pego pelo teste de isolamento, rodando como authenticated):
--   ERROR: 42501: permission denied for schema app
--
-- Causa: um schema novo (CREATE SCHEMA app) NÃO concede USAGE a ninguém por
-- padrão — diferente do schema `public`, que historicamente já vem com USAGE
-- para PUBLIC. Como as políticas guarda_loja chamam app.loja_id(), sem o USAGE
-- o papel authenticated não consegue nem avaliar a política: toda leitura/escrita
-- dele quebrava com 42501 (falha funcional, não vazamento — ninguém via nada).
--
-- Isso não é destrutivo (só concede privilégio). Idempotente.
-- =============================================================================

grant usage on schema app to authenticated;

-- EXECUTE já é concedido a PUBLIC por padrão em funções, mas deixamos explícito
-- para não depender desse default (e para o dia em que ele for revogado).
grant execute on function app.loja_id() to authenticated;
grant execute on function app.papel()  to authenticated;
