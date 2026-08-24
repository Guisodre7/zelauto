-- =============================================================================
-- ZelAuto — supabase/tests/isolamento.test.sql
-- Testes de isolamento entre lojas (seção 7 de docs/backend.md).
--
-- Rodar com:  supabase test db
-- Pré-requisito: 0001 e 0002 aplicadas e o hook custom_access_token_hook ligado
-- não é necessário aqui (o teste injeta as claims direto via set_config).
--
-- Cada tabela de negócio é checada em três frentes:
--   1. A VÊ o que é dela        (positivo — pega o falso-positivo de "RLS
--                                ligada e zero políticas", que esconde tudo)
--   2. A NÃO VÊ o que é da B     (isolamento de leitura)
--   3. A NÃO GRAVA em outra loja (isolamento de escrita -> SQLSTATE 42501)
--
-- A escrita ilegal mira a loja C (existe, mas não tem filhos) para o erro ser
-- sempre de RLS (42501) e nunca de unique/PK (23505).
-- =============================================================================

begin;
create extension if not exists pgtap;
select no_plan();

-- -----------------------------------------------------------------------------
-- SEED (roda como superuser do runner de testes; bypassa RLS)
-- -----------------------------------------------------------------------------
insert into public.lojas (id, nome) values
  ('11111111-1111-1111-1111-111111111111','Loja A'),
  ('22222222-2222-2222-2222-222222222222','Loja B'),
  ('33333333-3333-3333-3333-333333333333','Loja C');  -- alvo das escritas ilegais

-- usuários (perfis referencia auth.users). uC fica sem perfil, para a escrita
-- ilegal em perfis não colidir na PK.
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

-- storage (bucket 'veiculos' criado na 0007) — uma foto por loja
insert into storage.objects (bucket_id, name) values
  ('veiculos','11111111-1111-1111-1111-111111111111/va/foto.jpg'),
  ('veiculos','22222222-2222-2222-2222-222222222222/vb/foto.jpg');

-- -----------------------------------------------------------------------------
-- Assume o token da Loja A (proprietario)
-- -----------------------------------------------------------------------------
select set_config(
  'request.jwt.claims',
  '{"sub":"aaaa1111-1111-1111-1111-111111111111","role":"authenticated","app_metadata":{"loja_id":"11111111-1111-1111-1111-111111111111","papel":"proprietario"}}',
  true   -- is_local: vale só nesta transação
);
set local role authenticated;

-- checagem de sanidade: a claim está sendo lida
select is(app.loja_id(), '11111111-1111-1111-1111-111111111111'::uuid,
          'app.loja_id() lê a loja A do JWT');
select is(app.papel(), 'proprietario', 'app.papel() lê o papel do JWT');

-- -----------------------------------------------------------------------------
-- lojas — A vê só a própria
-- -----------------------------------------------------------------------------
select is((select count(*) from public.lojas), 1::bigint, 'lojas: A enxerga só 1 loja');
select is((select nome from public.lojas), 'Loja A', 'lojas: e é a Loja A');
select is((select count(*) from public.lojas
            where id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'lojas: A não enxerga a Loja B');

-- -----------------------------------------------------------------------------
-- veiculos
-- -----------------------------------------------------------------------------
select isnt((select count(*) from public.veiculos
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'veiculos: A vê os próprios');
select is((select count(*) from public.veiculos
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'veiculos: A não vê os da B');
select throws_ok(
  $$ insert into public.veiculos (loja_id, marca, modelo)
     values ('33333333-3333-3333-3333-333333333333','X','Y') $$,
  '42501', 'veiculos: A não grava em outra loja');

-- veiculo_custos — 0009: leitura tirada do authenticated (custo só via Edge Function)
select throws_ok(
  $$ select valor from public.veiculo_custos limit 1 $$,
  '42501', 'veiculo_custos: SELECT negado ao authenticated (0009)');
select throws_ok(
  $$ insert into public.veiculo_custos (loja_id, veiculo_id, descricao, valor)
     values ('33333333-3333-3333-3333-333333333333','b0000000-0000-0000-0000-0000000000b1','x',1) $$,
  '42501', 'veiculo_custos: A não grava em outra loja');

-- veiculos.compra — 0009: coluna de custo tirada do authenticated; o resto legível
select throws_ok(
  $$ select compra from public.veiculos limit 1 $$,
  '42501', 'veiculos.compra: SELECT negado ao authenticated (0009)');
select lives_ok(
  $$ select id, alvo, marca from public.veiculos limit 1 $$,
  'veiculos: colunas sem custo seguem legíveis');

-- vendas.custo_total — 0010: custo congelado da venda tirado do authenticated
select throws_ok(
  $$ select custo_total from public.vendas limit 1 $$,
  '42501', 'vendas.custo_total: SELECT negado ao authenticated (0010)');
select lives_ok(
  $$ select id, valor, forma from public.vendas limit 1 $$,
  'vendas: colunas sem custo seguem legíveis');

-- consignacoes
select isnt((select count(*) from public.consignacoes
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'consignacoes: A vê as próprias');
select is((select count(*) from public.consignacoes
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'consignacoes: A não vê as da B');
select throws_ok(
  $$ insert into public.consignacoes (loja_id, veiculo_id, dono_nome, minimo)
     values ('33333333-3333-3333-3333-333333333333','b0000000-0000-0000-0000-0000000000b1','z',1) $$,
  '42501', 'consignacoes: A não grava em outra loja');

-- clientes
select isnt((select count(*) from public.clientes
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'clientes: A vê os próprios');
select is((select count(*) from public.clientes
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'clientes: A não vê os da B');
select throws_ok(
  $$ insert into public.clientes (loja_id, nome)
     values ('33333333-3333-3333-3333-333333333333','X') $$,
  '42501', 'clientes: A não grava em outra loja');

-- interacoes
select isnt((select count(*) from public.interacoes
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'interacoes: A vê as próprias');
select is((select count(*) from public.interacoes
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'interacoes: A não vê as da B');
select throws_ok(
  $$ insert into public.interacoes (loja_id, cliente_id)
     values ('33333333-3333-3333-3333-333333333333','b0000000-0000-0000-0000-0000000000b2') $$,
  '42501', 'interacoes: A não grava em outra loja');

-- vendas
select isnt((select count(*) from public.vendas
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'vendas: A vê as próprias');
select is((select count(*) from public.vendas
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'vendas: A não vê as da B');
select throws_ok(
  $$ insert into public.vendas (loja_id, descricao, custo_total, valor, forma)
     values ('33333333-3333-3333-3333-333333333333','x',1,1,'avista') $$,
  '42501', 'vendas: A não grava em outra loja');

-- despesas
select isnt((select count(*) from public.despesas
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'despesas: A vê as próprias');
select is((select count(*) from public.despesas
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'despesas: A não vê as da B');
select throws_ok(
  $$ insert into public.despesas (loja_id, categoria, descricao, valor)
     values ('33333333-3333-3333-3333-333333333333','x','y',1) $$,
  '42501', 'despesas: A não grava em outra loja');

-- carne_contratos
select isnt((select count(*) from public.carne_contratos
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'carne_contratos: A vê os próprios');
select is((select count(*) from public.carne_contratos
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'carne_contratos: A não vê os da B');
select throws_ok(
  $$ insert into public.carne_contratos
       (loja_id, cliente_nome, veiculo_desc, valor_veiculo, entrada, financiado, taxa_mes, parcelas, inicio)
     values ('33333333-3333-3333-3333-333333333333','x','y',1,0,1,1,1,current_date) $$,
  '42501', 'carne_contratos: A não grava em outra loja');

-- carne_parcelas
select isnt((select count(*) from public.carne_parcelas
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'carne_parcelas: A vê as próprias');
select is((select count(*) from public.carne_parcelas
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'carne_parcelas: A não vê as da B');
select throws_ok(
  $$ insert into public.carne_parcelas (loja_id, contrato_id, numero, vencimento, valor)
     values ('33333333-3333-3333-3333-333333333333','b0000000-0000-0000-0000-0000000000b4',99,current_date,1) $$,
  '42501', 'carne_parcelas: A não grava em outra loja');

-- config_fiscal
select isnt((select count(*) from public.config_fiscal
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'config_fiscal: A vê a própria');
select is((select count(*) from public.config_fiscal
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'config_fiscal: A não vê a da B');
select throws_ok(
  $$ insert into public.config_fiscal (loja_id)
     values ('33333333-3333-3333-3333-333333333333') $$,
  '42501', 'config_fiscal: A não grava em outra loja');

-- numeracao_fiscal
select isnt((select count(*) from public.numeracao_fiscal
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'numeracao_fiscal: A vê a própria');
select is((select count(*) from public.numeracao_fiscal
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'numeracao_fiscal: A não vê a da B');
select throws_ok(
  $$ insert into public.numeracao_fiscal (loja_id, serie)
     values ('33333333-3333-3333-3333-333333333333',1) $$,
  '42501', 'numeracao_fiscal: A não grava em outra loja');

-- notas_fiscais
select isnt((select count(*) from public.notas_fiscais
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'notas_fiscais: A vê as próprias');
select is((select count(*) from public.notas_fiscais
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'notas_fiscais: A não vê as da B');
select throws_ok(
  $$ insert into public.notas_fiscais (loja_id, numero, serie, destinatario, valor)
     values ('33333333-3333-3333-3333-333333333333',1,1,'x',1) $$,
  '42501', 'notas_fiscais: A não grava em outra loja');

-- contratos
select isnt((select count(*) from public.contratos
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'contratos: A vê os próprios');
select is((select count(*) from public.contratos
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'contratos: A não vê os da B');
select throws_ok(
  $$ insert into public.contratos (loja_id, tipo, cliente_nome)
     values ('33333333-3333-3333-3333-333333333333','venda','x') $$,
  '42501', 'contratos: A não grava em outra loja');

-- portais
select isnt((select count(*) from public.portais
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'portais: A vê os próprios');
select is((select count(*) from public.portais
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'portais: A não vê os da B');
select throws_ok(
  $$ insert into public.portais (loja_id, portal)
     values ('33333333-3333-3333-3333-333333333333','OLX') $$,
  '42501', 'portais: A não grava em outra loja');

-- anuncios (portal diferente do semeado para não colidir no unique (veiculo_id,portal))
select isnt((select count(*) from public.anuncios
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'anuncios: A vê os próprios');
select is((select count(*) from public.anuncios
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'anuncios: A não vê os da B');
select throws_ok(
  $$ insert into public.anuncios (loja_id, veiculo_id, portal)
     values ('33333333-3333-3333-3333-333333333333','b0000000-0000-0000-0000-0000000000b1','Webmotors') $$,
  '42501', 'anuncios: A não grava em outra loja');

-- auditoria
select isnt((select count(*) from public.auditoria
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'auditoria: A vê a própria');
select is((select count(*) from public.auditoria
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'auditoria: A não vê a da B');
select throws_ok(
  $$ insert into public.auditoria (loja_id, tabela, acao)
     values ('33333333-3333-3333-3333-333333333333','veiculos','insert') $$,
  '42501', 'auditoria: A não grava em outra loja');

-- perfis (uC ainda não tem perfil, então não há colisão de PK)
select isnt((select count(*) from public.perfis
              where loja_id='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'perfis: A vê o próprio');
select is((select count(*) from public.perfis
            where loja_id='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'perfis: A não vê o da B');
select throws_ok(
  $$ insert into public.perfis (id, loja_id, nome)
     values ('cccc3333-3333-3333-3333-333333333333','33333333-3333-3333-3333-333333333333','x') $$,
  '42501', 'perfis: A não grava em outra loja');

-- storage (bucket veiculos): leitura e escrita de fotos isoladas por loja
select isnt((select count(*) from storage.objects
              where bucket_id='veiculos'
                and (storage.foldername(name))[1]='11111111-1111-1111-1111-111111111111'), 0::bigint,
            'storage: A vê a própria foto');
select is((select count(*) from storage.objects
            where bucket_id='veiculos'
              and (storage.foldername(name))[1]='22222222-2222-2222-2222-222222222222'), 0::bigint,
          'storage: A não vê foto da B');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('veiculos','33333333-3333-3333-3333-333333333333/x/foto.jpg') $$,
  '42501', 'storage: A não grava foto em outra loja');

-- -----------------------------------------------------------------------------
-- Controles positivos de escrita: A grava na própria loja
-- -----------------------------------------------------------------------------
select lives_ok(
  $$ insert into public.veiculos (loja_id, marca, modelo)
     values ('11111111-1111-1111-1111-111111111111','Ok','Ok') $$,
  'veiculos: A grava na própria loja');
select lives_ok(
  $$ insert into public.clientes (loja_id, nome)
     values ('11111111-1111-1111-1111-111111111111','Ok') $$,
  'clientes: A grava na própria loja');

-- -----------------------------------------------------------------------------
-- Bônus: delete cruzado não afeta linha alguma da outra loja
-- -----------------------------------------------------------------------------
select is(
  (with d as (delete from public.veiculos
               where loja_id='22222222-2222-2222-2222-222222222222' returning 1)
   select count(*) from d),
  0::bigint,
  'veiculos: delete de A não apaga nada da B');

select * from finish();
rollback;
