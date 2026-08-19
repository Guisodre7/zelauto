-- =============================================================================
-- ZelAuto — 0001_schema_base.sql
-- Schema base (fase 1). Corresponde à seção 2 de docs/backend.md.
--
-- ATENÇÃO — SEGURANÇA:
--   Esta migration cria APENAS o schema (tabelas, tipos, checks, índices,
--   função e triggers de atualizado_em). NÃO habilita RLS.
--   As tabelas ficam SEM Row Level Security até a migration 0002 ser aplicada.
--   NUNCA subir para produção com apenas a 0001: sem a 0002 não há isolamento
--   entre lojas.
-- =============================================================================

-- schema auxiliar para funções internas
create schema if not exists app;

-- -----------------------------------------------------------------------------
-- Função e trigger de atualizado_em
-- Mantém a coluna atualizado_em em dia automaticamente em todo UPDATE.
-- Aplicada apenas às tabelas que possuem essa coluna (veiculos, clientes).
-- -----------------------------------------------------------------------------
create or replace function app.toca_atualizado_em()
returns trigger
language plpgsql
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

-- =============================================================================
-- 2.1 Núcleo
-- =============================================================================

create table public.lojas (
  id            uuid primary key default gen_random_uuid(),
  nome          text not null,
  cnpj          text,
  cidade        text,
  uf            char(2),
  telefone      text,
  plano         text not null default 'padrao',
  ativa         boolean not null default true,
  config        jsonb not null default '{}'::jsonb,
  criado_em     timestamptz not null default now()
);

-- 1 linha por usuário; espelha auth.users
create table public.perfis (
  id            uuid primary key references auth.users(id) on delete cascade,
  loja_id       uuid not null references public.lojas(id) on delete restrict,
  nome          text not null,
  telefone      text,
  papel         text not null default 'vendedor'
                check (papel in ('proprietario','gerente','vendedor','administrativo')),
  modulos       text[] not null default '{hoje,patio,clientes}',
  ver_custos    boolean not null default false,
  ver_lucro     boolean not null default false,
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now()
);
create index on public.perfis (loja_id);

-- =============================================================================
-- 2.2 Pátio
-- =============================================================================

create table public.veiculos (
  id            uuid primary key default gen_random_uuid(),
  loja_id       uuid not null references public.lojas(id) on delete cascade,
  marca         text not null,
  modelo        text not null,
  ano_fab       int,
  ano_mod       int,
  km            int,
  placa         text,
  chassi        text,
  renavam       text,
  cor           text,
  compra        numeric(12,2) not null default 0,
  alvo          numeric(12,2) not null default 0,   -- preço de anúncio
  entrada_em    date not null default current_date,
  status        text not null default 'estoque'
                check (status in ('estoque','vendido','devolvido')),
  renave_fase   text not null default 'fora'
                check (renave_fase in ('fora','entrada','regular','saida')),
  foto_url      text,
  origem        text not null default 'proprio'
                check (origem in ('proprio','consignado')),
  criado_por    uuid references public.perfis(id),
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index on public.veiculos (loja_id, status);
create index on public.veiculos (loja_id, entrada_em);
create unique index on public.veiculos (loja_id, placa) where placa is not null;

create trigger toca_atualizado_em
  before update on public.veiculos
  for each row execute function app.toca_atualizado_em();

-- custos lançados um a um, não num campo só
create table public.veiculo_custos (
  id            uuid primary key default gen_random_uuid(),
  loja_id       uuid not null references public.lojas(id) on delete cascade,
  veiculo_id    uuid not null references public.veiculos(id) on delete cascade,
  descricao     text not null,
  categoria     text not null default 'preparacao'
                check (categoria in ('preparacao','documentacao','funilaria','outros')),
  valor         numeric(12,2) not null,
  data          date not null default current_date,
  criado_em     timestamptz not null default now()
);
create index on public.veiculo_custos (loja_id, veiculo_id);

-- dados do proprietário quando o veículo é de terceiro
create table public.consignacoes (
  id            uuid primary key default gen_random_uuid(),
  loja_id       uuid not null references public.lojas(id) on delete cascade,
  veiculo_id    uuid not null references public.veiculos(id) on delete cascade,
  dono_nome     text not null,
  dono_doc      text,
  dono_telefone text,
  minimo        numeric(12,2) not null,
  comissao_pct  numeric(5,2) not null default 6,
  contrato_id   uuid,   -- FK para contratos(id) adicionada no fim desta migration
  criado_em     timestamptz not null default now()
);
create index on public.consignacoes (loja_id);

-- =============================================================================
-- 2.3 Clientes
-- =============================================================================

create table public.clientes (
  id            uuid primary key default gen_random_uuid(),
  loja_id       uuid not null references public.lojas(id) on delete cascade,
  nome          text not null,
  telefone      text,
  doc           text,
  origem        text default 'outro',
  etapa         text not null default 'novo'
                check (etapa in ('novo','contato','testdrive','proposta','fechado','perdido')),
  interesse     text,
  veiculo_id    uuid references public.veiculos(id) on delete set null,
  orcamento     numeric(12,2),
  troca         text,
  ultimo_contato date,
  proximo_contato date,
  responsavel_id uuid references public.perfis(id),
  obs           text,
  criado_em     timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index on public.clientes (loja_id, etapa);
create index on public.clientes (loja_id, proximo_contato)
  where etapa not in ('fechado','perdido');

create trigger toca_atualizado_em
  before update on public.clientes
  for each row execute function app.toca_atualizado_em();

create table public.interacoes (
  id            uuid primary key default gen_random_uuid(),
  loja_id       uuid not null references public.lojas(id) on delete cascade,
  cliente_id    uuid not null references public.clientes(id) on delete cascade,
  usuario_id    uuid references public.perfis(id),
  tipo          text not null default 'nota',
  texto         text,
  criado_em     timestamptz not null default now()
);
create index on public.interacoes (loja_id, cliente_id, criado_em desc);

-- =============================================================================
-- 2.4 Negócios
-- =============================================================================

create table public.vendas (
  id            uuid primary key default gen_random_uuid(),
  loja_id       uuid not null references public.lojas(id) on delete cascade,
  veiculo_id    uuid references public.veiculos(id) on delete set null,
  cliente_id    uuid references public.clientes(id) on delete set null,
  descricao     text not null,          -- congelado no momento da venda
  placa         text,
  custo_total   numeric(12,2) not null, -- congelado: compra + custos
  valor         numeric(12,2) not null,
  forma         text not null
                check (forma in ('avista','financiamento','consorcio','carne','troca')),
  comissao      numeric(12,2) not null default 0,
  retorno_banco numeric(12,2) not null default 0,
  vendedor_id   uuid references public.perfis(id),
  dias_patio    int,
  data          date not null default current_date,
  criado_em     timestamptz not null default now()
);
create index on public.vendas (loja_id, data desc);

create table public.despesas (
  id            uuid primary key default gen_random_uuid(),
  loja_id       uuid not null references public.lojas(id) on delete cascade,
  categoria     text not null,
  descricao     text not null,
  valor         numeric(12,2) not null,
  tipo          text not null default 'fixa' check (tipo in ('fixa','variavel')),
  competencia   date not null default date_trunc('month', current_date),
  dia_vencimento int,
  criado_em     timestamptz not null default now()
);
create index on public.despesas (loja_id, competencia);

-- =============================================================================
-- 2.5 Carnê próprio
-- =============================================================================

create table public.carne_contratos (
  id            uuid primary key default gen_random_uuid(),
  loja_id       uuid not null references public.lojas(id) on delete cascade,
  venda_id      uuid references public.vendas(id) on delete set null,
  cliente_id    uuid references public.clientes(id) on delete set null,
  cliente_nome  text not null,
  veiculo_desc  text not null,
  valor_veiculo numeric(12,2) not null,
  entrada       numeric(12,2) not null,
  financiado    numeric(12,2) not null,
  taxa_mes      numeric(5,2) not null,
  parcelas      int not null,
  inicio        date not null,
  score         char(1) default 'B',
  criado_em     timestamptz not null default now()
);

create table public.carne_parcelas (
  id            uuid primary key default gen_random_uuid(),
  loja_id       uuid not null references public.lojas(id) on delete cascade,
  contrato_id   uuid not null references public.carne_contratos(id) on delete cascade,
  numero        int not null,
  vencimento    date not null,
  valor         numeric(12,2) not null,
  pago_em       date,
  valor_pago    numeric(12,2),
  unique (contrato_id, numero)
);
create index on public.carne_parcelas (loja_id, vencimento) where pago_em is null;

-- =============================================================================
-- 2.6 Papelada
-- =============================================================================

create table public.config_fiscal (
  loja_id       uuid primary key references public.lojas(id) on delete cascade,
  cnpj          text,
  ie            text,
  regime        text default 'simples',
  serie         int not null default 1,
  provedor      text,
  ambiente      text not null default 'homologacao'
                check (ambiente in ('homologacao','producao')),
  cert_vence_em date,
  cfop_venda    text default '5102',
  ncm           text default '8703.23.10'
);

-- numeração fiscal isolada: uma linha por loja/série
create table public.numeracao_fiscal (
  loja_id       uuid not null references public.lojas(id) on delete cascade,
  serie         int not null,
  proximo       int not null default 1,
  primary key (loja_id, serie)
);

create table public.notas_fiscais (
  id            uuid primary key default gen_random_uuid(),
  loja_id       uuid not null references public.lojas(id) on delete cascade,
  numero        int not null,
  serie         int not null,
  tipo          text not null default 'saida' check (tipo in ('entrada','saida')),
  venda_id      uuid references public.vendas(id) on delete set null,
  destinatario  text not null,
  doc           text,
  descricao     text,
  valor         numeric(12,2) not null,
  status        text not null default 'processando'
                check (status in ('processando','autorizada','rejeitada','cancelada')),
  chave         text,
  protocolo     text,
  rejeicao      text,
  xml_path      text,
  emitida_em    timestamptz not null default now(),
  unique (loja_id, serie, numero)
);

create table public.contratos (
  id            uuid primary key default gen_random_uuid(),
  loja_id       uuid not null references public.lojas(id) on delete cascade,
  tipo          text not null,
  cliente_nome  text not null,
  cliente_doc   text,
  veiculo_desc  text,
  valor         numeric(12,2),
  status        text not null default 'rascunho'
                check (status in ('rascunho','aguardando','assinado','cancelado')),
  hash          text,
  enviado_em    timestamptz,
  assinado_em   timestamptz,
  pdf_path      text,
  criado_em     timestamptz not null default now()
);
create index on public.contratos (loja_id, status);

-- =============================================================================
-- 2.7 Anúncios e auditoria
-- =============================================================================

create table public.portais (
  id            uuid primary key default gen_random_uuid(),
  loja_id       uuid not null references public.lojas(id) on delete cascade,
  portal        text not null,
  ativo         boolean not null default false,
  limite        int default 10,
  ultimo_sync   timestamptz,
  unique (loja_id, portal)
);

create table public.anuncios (
  id            uuid primary key default gen_random_uuid(),
  loja_id       uuid not null references public.lojas(id) on delete cascade,
  veiculo_id    uuid not null references public.veiculos(id) on delete cascade,
  portal        text not null,
  externo_id    text,
  status        text not null default 'no_ar',
  publicado_em  timestamptz default now(),
  unique (veiculo_id, portal)
);

-- toda alteração sensível fica registrada.
-- loja_id INTENCIONALMENTE sem FK: o log nunca deve cascatear nem quebrar
-- quando a loja de origem for apagada.
create table public.auditoria (
  id            bigserial primary key,
  loja_id       uuid not null,
  usuario_id    uuid,
  tabela        text not null,
  registro_id   uuid,
  acao          text not null,
  antes         jsonb,
  depois        jsonb,
  criado_em     timestamptz not null default now()
);
create index on public.auditoria (loja_id, criado_em desc);

-- =============================================================================
-- FK adiada: consignacoes.contrato_id -> contratos(id)
-- Declarada aqui porque a tabela contratos só existe a partir da seção 2.6.
-- =============================================================================
alter table public.consignacoes
  add constraint consignacoes_contrato_id_fkey
  foreign key (contrato_id) references public.contratos(id) on delete set null;
