-- =============================================================================
-- ZelAuto — 0009_custos_vendedor.sql
-- Esconde CUSTO (compra) e PREPARAÇÃO do vendedor de verdade (seção 3.4 / 5.5).
--
-- Problema de fundo: dono e vendedor são o MESMO papel de banco (authenticated);
-- o que os separa é o token (a RLS separa LINHAS por loja). Privilégio de coluna
-- separa por PAPEL, não por pessoa — então não dá "esconder compra do vendedor"
-- sem escondê-la também do dono. A saída: tirar essas leituras do acesso via API
-- (some para TODO authenticated no cliente) e devolver o custo só pela Edge
-- Function `custos`, que roda com service_role e confere a permissão do perfil
-- (ver_custos ou papel proprietario/gerente).
--
-- Isolamento entre lojas continua intacto (RLS não muda). Isto endurece só o
-- caso dentro da mesma loja (vendedor não vê o custo lançado por outro).
--
-- Não é destrutivo (só mexe em privilégio). Idempotente o suficiente para reaplicar.
-- =============================================================================

-- --- veiculos.compra ----------------------------------------------------------
-- Em Postgres, o SELECT de TABELA cobre todas as colunas e vence o de coluna.
-- Para esconder só `compra`, revoga o SELECT de tabela e concede coluna a coluna,
-- deixando `compra` de fora.
revoke select on public.veiculos from authenticated;
grant select (
  id, loja_id, marca, modelo, ano_fab, ano_mod, km, placa, chassi, renavam, cor,
  alvo, entrada_em, status, renave_fase, foto_url, origem, criado_por,
  criado_em, atualizado_em
) on public.veiculos to authenticated;
-- `compra` fica FORA de propósito: só a Edge Function (service_role) a lê.

-- --- veiculo_custos -----------------------------------------------------------
-- A tabela inteira é custo (preparação etc.). Tira o SELECT do authenticated; a
-- gravação segue por insert/delete (que não precisam de select). Só a Edge
-- Function lê. A política `ler` continua existindo, mas sem o GRANT ela não tem
-- efeito para o authenticated.
revoke select on public.veiculo_custos from authenticated;
