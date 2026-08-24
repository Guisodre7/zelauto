-- =============================================================================
-- ZelAuto — isolamento_sql_editor.sql
-- Versão do teste de isolamento para COLAR NO SQL EDITOR do painel Supabase
-- (para quem não tem Postgres/Docker local e não roda `supabase test db`).
--
-- Como usar:
--   1. Abra o SQL Editor do projeto (garanta que NÃO está em modo "read only").
--   2. Cole este script inteiro e rode.
--   3. O resultado é uma tabela: uma linha por verificação, com PASS/FAIL.
--
-- Segurança: tudo roda dentro de begin ... rollback. O ROLLBACK no fim desfaz
-- todo o seed — NADA é gravado no banco. A grade de resultados mostra o SELECT
-- final (imediatamente antes do rollback).
--
-- Como funciona a checagem de RLS: o SQL Editor conecta como superuser, que
-- ignora RLS. Por isso o script troca para o papel `authenticated` e injeta a
-- claim da loja A via request.jwt.claims — só assim a RLS é de fato aplicada.
-- =============================================================================

begin;

-- coletor de resultados (sequência nomeada para poder dar GRANT ao authenticated)
create temp sequence _res_seq;
create temp table _res (
  id       bigint default nextval('_res_seq') primary key,
  verifica text,
  ok       boolean,
  detalhe  text
) on commit drop;
grant select, insert on _res to authenticated;
grant usage on sequence _res_seq to authenticated;

-- helper para as escritas ilegais: devolve o SQLSTATE (ex.: 42501 = RLS) ou
-- 'OK_SEM_ERRO' se a escrita passou. security invoker (padrão) => roda como o
-- papel atual (authenticated), então a RLS é aplicada de verdade.
create function pg_temp.tenta(sql text) returns text
language plpgsql as $$
begin
  execute sql;
  return 'OK_SEM_ERRO';
exception when others then
  return sqlstate;
end;
$$;

-- -----------------------------------------------------------------------------
-- SEED (como superuser; bypassa RLS)
-- -----------------------------------------------------------------------------
insert into public.lojas (id, nome) values
  ('11111111-1111-1111-1111-111111111111','Loja A'),
  ('22222222-2222-2222-2222-222222222222','Loja B'),
  ('33333333-3333-3333-3333-333333333333','Loja C');

insert into auth.users (instance_id, id, aud, role, email,
                        encrypted_password, email_confirmed_at, created_at, updated_at)
values
  ('00000000-0000-0000-0000-000000000000','aaaa1111-1111-1111-1111-111111111111',
     'authenticated','authenticated','a@zelauto.test','',now(),now(),now()),
  ('00000000-0000-0000-0000-000000000000','bbbb2222-2222-2222-2222-222222222222',
     'authenticated','authenticated','b@zelauto.test','',now(),now(),now()),
  ('00000000-0000-0000-0000-000000000000','cccc3333-3333-3333-3333-333333333333',
     'authenticated','authenticated','c@zelauto.test','',now(),now(),now());

insert into public.perfis (id, loja_id, nome) values
  ('aaaa1111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','Dono A'),
  ('bbbb2222-2222-2222-2222-222222222222','22222222-2222-2222-2222-222222222222','Dono B');

insert into public.veiculos (id, loja_id, marca, modelo) values
  ('a0000000-0000-0000-0000-0000000000a1','11111111-1111-1111-1111-111111111111','Fiat','Uno'),
  ('b0000000-0000-0000-0000-0000000000b1','22222222-2222-2222-2222-222222222222','VW','Gol');

insert into public.veiculo_custos (loja_id, veiculo_id, descricao, valor) values
  ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-0000000000a1','Lavagem',100),
  ('22222222-2222-2222-2222-222222222222','b0000000-0000-0000-0000-0000000000b1','Lavagem',100);

insert into public.consignacoes (loja_id, veiculo_id, dono_nome, minimo) values
  ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-0000000000a1','Ze A',1000),
  ('22222222-2222-2222-2222-222222222222','b0000000-0000-0000-0000-0000000000b1','Ze B',1000);

insert into public.clientes (id, loja_id, nome) values
  ('a0000000-0000-0000-0000-0000000000a2','11111111-1111-1111-1111-111111111111','Cliente A'),
  ('b0000000-0000-0000-0000-0000000000b2','22222222-2222-2222-2222-222222222222','Cliente B');

insert into public.interacoes (loja_id, cliente_id) values
  ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-0000000000a2'),
  ('22222222-2222-2222-2222-222222222222','b0000000-0000-0000-0000-0000000000b2');

insert into public.vendas (id, loja_id, descricao, custo_total, valor, forma) values
  ('a0000000-0000-0000-0000-0000000000a3','11111111-1111-1111-1111-111111111111','Uno',5000,9000,'avista'),
  ('b0000000-0000-0000-0000-0000000000b3','22222222-2222-2222-2222-222222222222','Gol',6000,10000,'avista');

insert into public.despesas (loja_id, categoria, descricao, valor) values
  ('11111111-1111-1111-1111-111111111111','Aluguel','Loja',1000),
  ('22222222-2222-2222-2222-222222222222','Aluguel','Loja',1000);

insert into public.carne_contratos
  (id, loja_id, cliente_nome, veiculo_desc, valor_veiculo, entrada, financiado, taxa_mes, parcelas, inicio) values
  ('a0000000-0000-0000-0000-0000000000a4','11111111-1111-1111-1111-111111111111','Cliente A','Uno',9000,1000,8000,2.0,12,current_date),
  ('b0000000-0000-0000-0000-0000000000b4','22222222-2222-2222-2222-222222222222','Cliente B','Gol',10000,1000,9000,2.0,12,current_date);

insert into public.carne_parcelas (loja_id, contrato_id, numero, vencimento, valor) values
  ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-0000000000a4',1,current_date,700),
  ('22222222-2222-2222-2222-222222222222','b0000000-0000-0000-0000-0000000000b4',1,current_date,800);

insert into public.config_fiscal (loja_id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222');

insert into public.numeracao_fiscal (loja_id, serie) values
  ('11111111-1111-1111-1111-111111111111',1),
  ('22222222-2222-2222-2222-222222222222',1);

insert into public.notas_fiscais (loja_id, numero, serie, destinatario, valor) values
  ('11111111-1111-1111-1111-111111111111',1,1,'Cliente A',9000),
  ('22222222-2222-2222-2222-222222222222',1,1,'Cliente B',10000);

insert into public.contratos (id, loja_id, tipo, cliente_nome) values
  ('a0000000-0000-0000-0000-0000000000a5','11111111-1111-1111-1111-111111111111','venda','Cliente A'),
  ('b0000000-0000-0000-0000-0000000000b5','22222222-2222-2222-2222-222222222222','venda','Cliente B');

insert into public.portais (loja_id, portal) values
  ('11111111-1111-1111-1111-111111111111','OLX'),
  ('22222222-2222-2222-2222-222222222222','OLX');

insert into public.anuncios (loja_id, veiculo_id, portal) values
  ('11111111-1111-1111-1111-111111111111','a0000000-0000-0000-0000-0000000000a1','OLX'),
  ('22222222-2222-2222-2222-222222222222','b0000000-0000-0000-0000-0000000000b1','OLX');

insert into public.auditoria (loja_id, tabela, acao) values
  ('11111111-1111-1111-1111-111111111111','veiculos','insert'),
  ('22222222-2222-2222-2222-222222222222','veiculos','insert');

-- storage (bucket 'veiculos' criado na 0007) — uma foto por loja.
-- Requer a 0007 aplicada; o bucket_id tem FK para storage.buckets.
insert into storage.objects (bucket_id, name) values
  ('veiculos','11111111-1111-1111-1111-111111111111/va/foto.jpg'),
  ('veiculos','22222222-2222-2222-2222-222222222222/vb/foto.jpg');

-- -----------------------------------------------------------------------------
-- Assume o token da Loja A
-- -----------------------------------------------------------------------------
select set_config(
  'request.jwt.claims',
  '{"sub":"aaaa1111-1111-1111-1111-111111111111","role":"authenticated","app_metadata":{"loja_id":"11111111-1111-1111-1111-111111111111","papel":"proprietario"}}',
  true
);
set local role authenticated;

-- Sanidade das claims
insert into _res(verifica, ok, detalhe)
select 'sanidade: app.loja_id() = Loja A',
       app.loja_id() = '11111111-1111-1111-1111-111111111111',
       coalesce(app.loja_id()::text,'null');
insert into _res(verifica, ok, detalhe)
select 'sanidade: app.papel() = proprietario',
       app.papel() = 'proprietario', app.papel();

-- lojas
insert into _res(verifica, ok, detalhe)
select 'lojas: A enxerga só 1 loja', (count(*) = 1), 'linhas='||count(*) from public.lojas;
insert into _res(verifica, ok, detalhe)
select 'lojas: e é a Loja A', (max(nome) = 'Loja A'), coalesce(max(nome),'—') from public.lojas;
insert into _res(verifica, ok, detalhe)
select 'lojas: A não vê a Loja B', (count(*) = 0), 'linhas='||count(*)
  from public.lojas where id = '22222222-2222-2222-2222-222222222222';

-- Macro de leitura por tabela (A vê o próprio / A não vê o da B) — feito à mão
-- para cada tabela abaixo, mais a escrita ilegal mirando a Loja C.

-- veiculos
insert into _res(verifica,ok,detalhe) select 'veiculos: A vê os próprios', (count(*)>0), 'linhas='||count(*) from public.veiculos where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'veiculos: A não vê os da B', (count(*)=0), 'linhas='||count(*) from public.veiculos where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'veiculos: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.veiculos (loja_id,marca,modelo) values ('33333333-3333-3333-3333-333333333333','X','Y')$$) r) t;

-- veiculo_custos — 0009: leitura tirada do authenticated (custo só via Edge Function)
insert into _res(verifica,ok,detalhe) select 'veiculo_custos: SELECT negado ao authenticated (0009)', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$select valor from public.veiculo_custos limit 1$$) r) t;
insert into _res(verifica,ok,detalhe) select 'veiculo_custos: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.veiculo_custos (loja_id,veiculo_id,descricao,valor) values ('33333333-3333-3333-3333-333333333333','b0000000-0000-0000-0000-0000000000b1','x',1)$$) r) t;

-- veiculos.compra — 0009: coluna de custo tirada do authenticated; o resto segue legível
insert into _res(verifica,ok,detalhe) select 'veiculos.compra: SELECT negado ao authenticated (0009)', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$select compra from public.veiculos limit 1$$) r) t;
insert into _res(verifica,ok,detalhe) select 'veiculos: colunas sem custo seguem legíveis', (r='OK_SEM_ERRO'), r from (select pg_temp.tenta($$select id, alvo, marca from public.veiculos limit 1$$) r) t;

-- vendas.custo_total — 0010: custo congelado da venda tirado do authenticated
insert into _res(verifica,ok,detalhe) select 'vendas.custo_total: SELECT negado ao authenticated (0010)', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$select custo_total from public.vendas limit 1$$) r) t;
insert into _res(verifica,ok,detalhe) select 'vendas: colunas sem custo seguem legíveis', (r='OK_SEM_ERRO'), r from (select pg_temp.tenta($$select id, valor, forma from public.vendas limit 1$$) r) t;

-- consignacoes
insert into _res(verifica,ok,detalhe) select 'consignacoes: A vê as próprias', (count(*)>0), 'linhas='||count(*) from public.consignacoes where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'consignacoes: A não vê as da B', (count(*)=0), 'linhas='||count(*) from public.consignacoes where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'consignacoes: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.consignacoes (loja_id,veiculo_id,dono_nome,minimo) values ('33333333-3333-3333-3333-333333333333','b0000000-0000-0000-0000-0000000000b1','z',1)$$) r) t;

-- clientes
insert into _res(verifica,ok,detalhe) select 'clientes: A vê os próprios', (count(*)>0), 'linhas='||count(*) from public.clientes where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'clientes: A não vê os da B', (count(*)=0), 'linhas='||count(*) from public.clientes where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'clientes: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.clientes (loja_id,nome) values ('33333333-3333-3333-3333-333333333333','X')$$) r) t;

-- interacoes
insert into _res(verifica,ok,detalhe) select 'interacoes: A vê as próprias', (count(*)>0), 'linhas='||count(*) from public.interacoes where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'interacoes: A não vê as da B', (count(*)=0), 'linhas='||count(*) from public.interacoes where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'interacoes: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.interacoes (loja_id,cliente_id) values ('33333333-3333-3333-3333-333333333333','b0000000-0000-0000-0000-0000000000b2')$$) r) t;

-- vendas
insert into _res(verifica,ok,detalhe) select 'vendas: A vê as próprias', (count(*)>0), 'linhas='||count(*) from public.vendas where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'vendas: A não vê as da B', (count(*)=0), 'linhas='||count(*) from public.vendas where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'vendas: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.vendas (loja_id,descricao,custo_total,valor,forma) values ('33333333-3333-3333-3333-333333333333','x',1,1,'avista')$$) r) t;

-- despesas
insert into _res(verifica,ok,detalhe) select 'despesas: A vê as próprias', (count(*)>0), 'linhas='||count(*) from public.despesas where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'despesas: A não vê as da B', (count(*)=0), 'linhas='||count(*) from public.despesas where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'despesas: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.despesas (loja_id,categoria,descricao,valor) values ('33333333-3333-3333-3333-333333333333','x','y',1)$$) r) t;

-- carne_contratos
insert into _res(verifica,ok,detalhe) select 'carne_contratos: A vê os próprios', (count(*)>0), 'linhas='||count(*) from public.carne_contratos where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'carne_contratos: A não vê os da B', (count(*)=0), 'linhas='||count(*) from public.carne_contratos where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'carne_contratos: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.carne_contratos (loja_id,cliente_nome,veiculo_desc,valor_veiculo,entrada,financiado,taxa_mes,parcelas,inicio) values ('33333333-3333-3333-3333-333333333333','x','y',1,0,1,1,1,current_date)$$) r) t;

-- carne_parcelas
insert into _res(verifica,ok,detalhe) select 'carne_parcelas: A vê as próprias', (count(*)>0), 'linhas='||count(*) from public.carne_parcelas where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'carne_parcelas: A não vê as da B', (count(*)=0), 'linhas='||count(*) from public.carne_parcelas where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'carne_parcelas: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.carne_parcelas (loja_id,contrato_id,numero,vencimento,valor) values ('33333333-3333-3333-3333-333333333333','b0000000-0000-0000-0000-0000000000b4',99,current_date,1)$$) r) t;

-- config_fiscal
insert into _res(verifica,ok,detalhe) select 'config_fiscal: A vê a própria', (count(*)>0), 'linhas='||count(*) from public.config_fiscal where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'config_fiscal: A não vê a da B', (count(*)=0), 'linhas='||count(*) from public.config_fiscal where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'config_fiscal: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.config_fiscal (loja_id) values ('33333333-3333-3333-3333-333333333333')$$) r) t;

-- numeracao_fiscal
insert into _res(verifica,ok,detalhe) select 'numeracao_fiscal: A vê a própria', (count(*)>0), 'linhas='||count(*) from public.numeracao_fiscal where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'numeracao_fiscal: A não vê a da B', (count(*)=0), 'linhas='||count(*) from public.numeracao_fiscal where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'numeracao_fiscal: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.numeracao_fiscal (loja_id,serie) values ('33333333-3333-3333-3333-333333333333',1)$$) r) t;

-- notas_fiscais
insert into _res(verifica,ok,detalhe) select 'notas_fiscais: A vê as próprias', (count(*)>0), 'linhas='||count(*) from public.notas_fiscais where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'notas_fiscais: A não vê as da B', (count(*)=0), 'linhas='||count(*) from public.notas_fiscais where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'notas_fiscais: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.notas_fiscais (loja_id,numero,serie,destinatario,valor) values ('33333333-3333-3333-3333-333333333333',1,1,'x',1)$$) r) t;

-- contratos
insert into _res(verifica,ok,detalhe) select 'contratos: A vê os próprios', (count(*)>0), 'linhas='||count(*) from public.contratos where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'contratos: A não vê os da B', (count(*)=0), 'linhas='||count(*) from public.contratos where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'contratos: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.contratos (loja_id,tipo,cliente_nome) values ('33333333-3333-3333-3333-333333333333','venda','x')$$) r) t;

-- portais
insert into _res(verifica,ok,detalhe) select 'portais: A vê os próprios', (count(*)>0), 'linhas='||count(*) from public.portais where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'portais: A não vê os da B', (count(*)=0), 'linhas='||count(*) from public.portais where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'portais: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.portais (loja_id,portal) values ('33333333-3333-3333-3333-333333333333','OLX')$$) r) t;

-- anuncios (portal diferente do semeado para não colidir no unique (veiculo_id,portal))
insert into _res(verifica,ok,detalhe) select 'anuncios: A vê os próprios', (count(*)>0), 'linhas='||count(*) from public.anuncios where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'anuncios: A não vê os da B', (count(*)=0), 'linhas='||count(*) from public.anuncios where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'anuncios: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.anuncios (loja_id,veiculo_id,portal) values ('33333333-3333-3333-3333-333333333333','b0000000-0000-0000-0000-0000000000b1','Webmotors')$$) r) t;

-- auditoria
insert into _res(verifica,ok,detalhe) select 'auditoria: A vê a própria', (count(*)>0), 'linhas='||count(*) from public.auditoria where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'auditoria: A não vê a da B', (count(*)=0), 'linhas='||count(*) from public.auditoria where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'auditoria: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.auditoria (loja_id,tabela,acao) values ('33333333-3333-3333-3333-333333333333','veiculos','insert')$$) r) t;

-- perfis (uC ainda não tem perfil -> sem colisão de PK)
insert into _res(verifica,ok,detalhe) select 'perfis: A vê o próprio', (count(*)>0), 'linhas='||count(*) from public.perfis where loja_id='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'perfis: A não vê o da B', (count(*)=0), 'linhas='||count(*) from public.perfis where loja_id='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'perfis: A não grava em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into public.perfis (id,loja_id,nome) values ('cccc3333-3333-3333-3333-333333333333','33333333-3333-3333-3333-333333333333','x')$$) r) t;

-- storage: leitura e escrita de fotos isoladas por prefixo de loja (bucket veiculos)
insert into _res(verifica,ok,detalhe) select 'storage: A vê a própria foto', (count(*)>0), 'linhas='||count(*) from storage.objects where bucket_id='veiculos' and (storage.foldername(name))[1]='11111111-1111-1111-1111-111111111111';
insert into _res(verifica,ok,detalhe) select 'storage: A não vê foto da B', (count(*)=0), 'linhas='||count(*) from storage.objects where bucket_id='veiculos' and (storage.foldername(name))[1]='22222222-2222-2222-2222-222222222222';
insert into _res(verifica,ok,detalhe) select 'storage: A não grava foto em outra loja', (r='42501'), 'sqlstate='||r from (select pg_temp.tenta($$insert into storage.objects (bucket_id,name) values ('veiculos','33333333-3333-3333-3333-333333333333/x/foto.jpg')$$) r) t;

-- Controles positivos de escrita (A grava na própria loja)
insert into _res(verifica,ok,detalhe) select 'veiculos: A grava na própria loja', (r='OK_SEM_ERRO'), r from (select pg_temp.tenta($$insert into public.veiculos (loja_id,marca,modelo) values ('11111111-1111-1111-1111-111111111111','Ok','Ok')$$) r) t;
insert into _res(verifica,ok,detalhe) select 'clientes: A grava na própria loja', (r='OK_SEM_ERRO'), r from (select pg_temp.tenta($$insert into public.clientes (loja_id,nome) values ('11111111-1111-1111-1111-111111111111','Ok')$$) r) t;

-- Delete cruzado não apaga nada da B
with d as (delete from public.veiculos where loja_id='22222222-2222-2222-2222-222222222222' returning 1)
insert into _res(verifica,ok,detalhe)
select 'veiculos: delete de A não apaga da B', (count(*)=0), 'apagadas='||count(*) from d;

-- volta a superuser para ler o coletor e imprimir o placar
reset role;

select
  count(*) filter (where ok)                    as pass,
  count(*) filter (where not ok)                as fail,
  case when count(*) filter (where not ok)=0
       then 'TUDO PASSOU ✅' else 'HÁ FALHAS ❌' end as veredito
from _res;

select id,
       case when ok then 'PASS' else 'FAIL' end as resultado,
       verifica,
       detalhe
from _res
order by ok, id;   -- FAILs primeiro

rollback;
