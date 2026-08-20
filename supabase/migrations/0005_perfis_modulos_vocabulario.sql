-- =============================================================================
-- ZelAuto — 0005_perfis_modulos_vocabulario.sql
-- Alinha o vocabulário de perfis.modulos ao do protótipo (fonte: MODULOS e
-- pode() em prototipo/zelauto.html). Duas listas de nomes para a mesma coisa
-- vira bug de permissão no primeiro vendedor cadastrado.
--
-- Chaves válidas (16): dash, estoque, vendas, crm, renave, nfe, anuncios,
-- vitrine, avaliacao, contratos, despesas, fin, carne, consig, dre, equipe.
--
-- Só altera default e traduz linhas antigas — não é destrutivo.
-- =============================================================================

-- 1) Novo default: visão operacional mínima de vendedor (as telas que ele usa
--    na frente do cliente: painel, estoque, CRM, financiamento e avaliação).
alter table public.perfis
  alter column modulos set default '{dash,estoque,crm,fin,avaliacao}';

-- 2) Traduz o vocabulário antigo, token a token, em qualquer perfil existente.
--    hoje -> dash | patio -> estoque | clientes -> crm
update public.perfis
   set modulos = array_replace(
                   array_replace(
                     array_replace(modulos, 'hoje',     'dash'),
                                            'patio',    'estoque'),
                                            'clientes', 'crm')
 where modulos && array['hoje','patio','clientes'];
