-- =============================================================================
-- ⚠️  NÃO É MIGRATION. NÃO RODE EM PRODUÇÃO. ⚠️
--
-- Script avulso de bootstrap da LOJA DE DEMONSTRAÇÃO "Vancar Veículos".
-- Serve só para popular um ambiente de dev/demo com dados fictícios, para o
-- painel não abrir em branco numa apresentação. Não vai para o histórico de
-- migrations e não deve ser aplicado no projeto de produção.
--
-- Pré-requisitos:
--   1. Migrations 0001–0004 aplicadas.
--   2. Criar o usuário do dono no painel: Authentication → Users → Add user
--      (e-mail + senha). Copiar o UUID gerado.
--   3. Colar esse UUID em v_dono, abaixo, e rodar este script inteiro.
--
-- Rode no SQL Editor (roda como superuser, então ignora RLS — correto aqui).
-- Idempotência: criar_loja recusa CNPJ repetido; rodar 2x aborta limpo.
-- =============================================================================

begin;

do $$
declare
  -- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>
  -- ⚠️ OBRIGATÓRIO: cole aqui o UUID do usuário dono JÁ CRIADO no painel Auth
  -- (Authentication → Users → Add user → copie o UID). Este é o UID com que o
  -- dono vai logar; o perfil da loja é vinculado a ele. Não invente nem gere um
  -- UUID novo — tem que ser o mesmo do Auth, senão o login não acha o perfil.
  v_dono uuid := '00000000-0000-0000-0000-000000000000';
  -- >>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>>

  v_loja uuid;
  v1 uuid; v2 uuid; v3 uuid; v4 uuid; v5 uuid; v6 uuid;   -- veículos
  n_veic int; n_cli int; n_vend int; n_desp_ins int; n_desp_upd int;
begin
  -- Única barreira: o usuário precisa existir em auth.users.
  -- Se você esquecer de colar o UUID (deixar o zero), esta checagem falha com
  -- mensagem clara. Edite APENAS a linha do `v_dono :=` acima — não use
  -- find-and-replace do UUID inteiro (havia um segundo ponto aqui e isso
  -- quebrava a barreira; por isso ela foi removida).
  if not exists (select 1 from auth.users where id = v_dono) then
    raise exception 'Usuário % não existe em auth.users — crie no painel Auth e cole o UUID em v_dono.', v_dono;
  end if;

  -- 1) Loja + esqueleto (config_fiscal, numeração, 4 portais, 2 despesas zeradas)
  v_loja := app.criar_loja(
    'Vancar Veículos', '41.234.567/0001-08', 'Lauro de Freitas', 'BA',
    'danilo@vancarveiculos.com.br', 'Danilo'
  );

  -- 2) Perfil do dono (módulos = os 16 do proprietário no protótipo)
  insert into public.perfis (id, loja_id, nome, telefone, papel, modulos, ver_custos, ver_lucro)
  values (
    v_dono, v_loja, 'Danilo', '(71) 99000-0000', 'proprietario',
    '{dash,estoque,vendas,crm,renave,nfe,anuncios,vitrine,avaliacao,contratos,despesas,fin,carne,consig,dre,equipe}',
    true, true
  );

  -- 3) 6 veículos (4 em estoque, 2 vendidos — para casar com as 2 vendas)
  v1 := gen_random_uuid(); v2 := gen_random_uuid(); v3 := gen_random_uuid();
  v4 := gen_random_uuid(); v5 := gen_random_uuid(); v6 := gen_random_uuid();

  insert into public.veiculos
    (id, loja_id, marca, modelo, ano_fab, ano_mod, km, placa, cor, compra, alvo, status, entrada_em, criado_por)
  values
    (v1, v_loja, 'Fiat',      'Argo 1.0 Drive',   2021, 2022, 38000, 'PKA1B23', 'Cinza',    58000, 66900,  'estoque', current_date - 22, v_dono),
    (v2, v_loja, 'Volkswagen','Gol 1.6 MSI',      2019, 2020, 62000, 'QLB2C34', 'Branco',   44000, 51900,  'estoque', current_date - 40, v_dono),
    (v3, v_loja, 'Hyundai',   'HB20 1.0 Vision',  2020, 2021, 45000, 'RMC3D45', 'Prata',    52000, 59900,  'estoque', current_date - 12, v_dono),
    (v4, v_loja, 'Jeep',      'Renegade 1.8',     2018, 2019, 78000, 'SND4E56', 'Preto',    76000, 87900,  'estoque', current_date - 55, v_dono),
    (v5, v_loja, 'Chevrolet', 'Onix 1.0 LT',      2022, 2023, 21000, 'TOE5F67', 'Vermelho', 62000, 71900,  'vendido', current_date - 48, v_dono),
    (v6, v_loja, 'Toyota',    'Corolla 2.0 XEI',  2020, 2021, 55000, 'UPF6G78', 'Prata',    98000, 112900, 'vendido', current_date - 60, v_dono);
  get diagnostics n_veic = row_count;

  -- 4) 4 clientes em etapas diferentes do funil
  insert into public.clientes
    (loja_id, nome, telefone, doc, origem, etapa, interesse, veiculo_id, orcamento, responsavel_id, proximo_contato, obs)
  values
    (v_loja, 'Marcos Andrade',  '(71) 98811-2233', '024.xxx.xxx-01', 'OLX',       'novo',      'HB20 até 60 mil',     v3, 60000, v_dono, current_date + 1, 'Ligou pelo anúncio da OLX'),
    (v_loja, 'Patrícia Lima',   '(71) 99622-4455', '031.xxx.xxx-02', 'Indicação', 'contato',   'SUV compacto',        v4, 90000, v_dono, current_date + 2, 'Prefere financiar em 48x'),
    (v_loja, 'João Pereira',    '(71) 98133-6677', '048.xxx.xxx-03', 'Loja',      'testdrive', 'Argo automático',     v1, 67000, v_dono, current_date,     'Agendou test drive para sábado'),
    (v_loja, 'Fernanda Costa',  '(71) 99744-8899', '055.xxx.xxx-04', 'Instagram', 'proposta',  'Sedan seminovo',      v6, 110000,v_dono, current_date + 1, 'Proposta enviada, aguardando retorno');
  get diagnostics n_cli = row_count;

  -- 5) 2 vendas (Onix e Corolla) — descrição e custo congelados no momento
  insert into public.vendas
    (loja_id, veiculo_id, descricao, placa, custo_total, valor, forma, comissao, retorno_banco, vendedor_id, dias_patio, data)
  values
    (v_loja, v5, 'Chevrolet Onix 1.0 LT 2022/2023',   'TOE5F67', 62000, 71900,  'financiamento', 1200, 800, v_dono, 34, current_date - 6),
    (v_loja, v6, 'Toyota Corolla 2.0 XEI 2020/2021',  'UPF6G78', 98000, 112900, 'avista',        1500, 0,   v_dono, 45, current_date - 15);
  get diagnostics n_vend = row_count;

  -- 6) Despesas fixas plausíveis para uma loja de 12 vagas em Lauro de Freitas.
  --    criar_loja já criou Aluguel e Pessoal zeradas -> atualiza os valores.
  update public.despesas set valor = 4500  where loja_id = v_loja and categoria = 'Aluguel';
  update public.despesas set valor = 9800  where loja_id = v_loja and categoria = 'Pessoal';
  get diagnostics n_desp_upd = row_count;

  --    e acrescenta as demais fixas/variáveis do mês corrente.
  insert into public.despesas (loja_id, categoria, descricao, valor, tipo, dia_vencimento)
  values
    (v_loja, 'Energia',    'Energia elétrica',          720, 'variavel', 15),
    (v_loja, 'Comunicação','Internet e telefone',       180, 'fixa',     10),
    (v_loja, 'Contador',   'Honorários contábeis',      950, 'fixa',      5),
    (v_loja, 'Marketing',  'Anúncios e impulsionamento',1200,'fixa',     20),
    (v_loja, 'Água',       'Conta de água',             140, 'variavel', 18);
  get diagnostics n_desp_ins = row_count;

  raise notice '----------------------------------------------------------------';
  raise notice 'Loja de demonstração criada: Vancar Veículos  (loja_id=%)', v_loja;
  raise notice 'veiculos inseridos ......... %', n_veic;
  raise notice 'clientes inseridos ......... %', n_cli;
  raise notice 'vendas inseridas ........... %', n_vend;
  raise notice 'despesas atualizadas ....... %  (Aluguel, Pessoal)', n_desp_upd;
  raise notice 'despesas inseridas ......... %', n_desp_ins;
  raise notice '(criar_loja também criou: 1 config_fiscal, 1 numeracao_fiscal, 4 portais)';
  raise notice '----------------------------------------------------------------';
end $$;

-- Placar final por tabela (grade de resultados)
with loja as (select id from public.lojas where nome = 'Vancar Veículos')
select 'lojas'            as tabela, count(*) as linhas from public.lojas            where id      = (select id from loja)
union all select 'perfis',            count(*) from public.perfis            where loja_id = (select id from loja)
union all select 'veiculos',          count(*) from public.veiculos          where loja_id = (select id from loja)
union all select 'clientes',          count(*) from public.clientes          where loja_id = (select id from loja)
union all select 'vendas',            count(*) from public.vendas            where loja_id = (select id from loja)
union all select 'despesas',          count(*) from public.despesas          where loja_id = (select id from loja)
union all select 'portais',           count(*) from public.portais           where loja_id = (select id from loja)
union all select 'config_fiscal',     count(*) from public.config_fiscal     where loja_id = (select id from loja)
union all select 'numeracao_fiscal',  count(*) from public.numeracao_fiscal  where loja_id = (select id from loja)
order by tabela;

commit;
