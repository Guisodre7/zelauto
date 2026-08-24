-- =============================================================================
-- ZelAuto — 0010_vendas_custo.sql
-- Esconde o CUSTO congelado da venda (vendas.custo_total) do vendedor — mesmo
-- raciocínio da 0009 para veiculos.compra.
--
-- Consequência importante: se o vendedor não vê o custo, ele não pode calcular
-- custo_total na hora de vender. Por isso a GRAVAÇÃO da venda passa a ser feita
-- pela Edge Function `vender` (service_role), que congela o custo real do
-- veículo no momento da venda. A LEITURA de volta (para quem pode ver custo) vem
-- pela Edge Function `custos`.
--
-- Não é destrutivo (só privilégio). Isolamento entre lojas segue na RLS.
-- =============================================================================

-- Em Postgres o SELECT de tabela vence o de coluna: revoga o de tabela e concede
-- todas as colunas MENOS custo_total.
revoke select on public.vendas from authenticated;
grant select (
  id, loja_id, veiculo_id, cliente_id, cliente_nome, descricao, placa,
  valor, forma, comissao, retorno_banco, vendedor_id, dias_patio, data, criado_em
) on public.vendas to authenticated;
-- `custo_total` fica FORA de propósito.
