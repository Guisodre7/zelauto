-- =============================================================================
-- ZelAuto — 0011_bucket_exportacoes.sql
-- Bucket privado para os .zip de exportação de dados (seção 9).
--
-- "Os dados são do lojista e saem quando ele quiser." A Edge Function
-- `exportar-dados` gera um .zip (um CSV por tabela da loja) e devolve URL
-- assinada de 24h. O objeto é gravado aqui, no prefixo da loja.
--
-- Bucket PRIVADO. Não precisa de policy para o authenticated: só a Edge Function
-- (service_role) grava e assina; a URL assinada dá o acesso temporário. Caminho:
-- exportacoes/{loja_id}/{timestamp}.zip
--
-- Não é destrutivo.
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('exportacoes', 'exportacoes', false)
on conflict (id) do nothing;
