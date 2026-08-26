-- =============================================================================
-- 0015 — Telefone no contrato de carnê
--
-- O carnê próprio vive de cobrança: quando uma parcela atrasa, a loja precisa
-- do telefone do comprador para acionar (WhatsApp/ligação) antes de virar 30
-- dias. O schema base guardava cliente_nome mas não o contato quando o
-- comprador não é um cliente formal do CRM. Esta coluna fecha essa lacuna.
--
-- Não é tabela nova: carne_contratos já tem loja_id, índice, RLS force e a
-- política restritiva guarda_loja (0002), então o isolamento já está coberto
-- e testado. É só uma coluna a mais na mesma tabela isolada.
-- =============================================================================

alter table public.carne_contratos
  add column if not exists telefone text;
