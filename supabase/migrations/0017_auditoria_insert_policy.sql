-- =============================================================================
-- 0017 — Política de INSERT da auditoria (correção da 0016)
--
-- A 0016 endureceu a auditoria (log imutável, leitura só de gestão) mas, sob
-- `force row level security`, faltava uma política PERMISSIVA de INSERT para o
-- trigger `app.audita()` conseguir gravar quando o dono da função não tem
-- BYPASSRLS. Sem isso, o log poderia ficar silenciosamente vazio (o trigger é
-- fail-open: engole o erro e a operação de negócio segue).
--
-- Esta política sozinha NÃO abre a porta: a 0016 já revogou o privilégio de
-- INSERT do `authenticated`, então só o trigger (que roda com o privilégio do
-- dono) consegue gravar. Idempotente — pode rodar mesmo que a 0016 tenha sido
-- aplicada numa versão que já a continha.
-- =============================================================================

drop policy if exists trigger_grava on public.auditoria;
create policy trigger_grava on public.auditoria
  for insert with check (true);
