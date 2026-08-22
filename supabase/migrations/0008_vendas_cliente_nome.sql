-- =============================================================================
-- ZelAuto — 0008_vendas_cliente_nome.sql
-- Nome do comprador congelado na venda (seção 2 de docs/backend.md, tabela vendas).
--
-- No protótipo a venda guarda o NOME do comprador digitado na hora de fechar.
-- A tabela só tinha cliente_id (FK). Passamos a congelar também o nome, como já
-- fazem carne_contratos e contratos: o nome fica gravado no momento da venda e
-- não muda se o cadastro do cliente for depois editado ou removido.
--
-- Nullable: vendas já existentes (ex.: as duas da demo) não têm nome congelado.
-- Herda os grants de tabela; não há privilégio por coluna em vendas.
-- Não é destrutivo.
-- =============================================================================

alter table public.vendas
  add column if not exists cliente_nome text;   -- congelado no momento da venda
