# ZelAuto — Especificação da infraestrutura

Documento único para construir o backend multi-loja no Supabase.
Escrito para ser colado no conhecimento de um projeto do Claude e consultado
por qualquer sessão do Claude Code.

**Regra de ouro deste documento:** nada aqui é opcional na fase 1. O que for
pulado agora custa reescrita quando houver cliente pagando.

---

## 1. Decisões travadas

Estas decisões não se rediscutem durante a construção. Se alguma precisar mudar,
muda-se aqui primeiro e o documento vira a fonte da verdade.

| Decisão | Escolha | Por quê |
|---|---|---|
| Banco | Supabase (Postgres) | Relatórios são `SUM`/`GROUP BY`; isolamento por RLS declarativa |
| Arquitetura | **Um projeto, muitas lojas** | Deploy único; um projeto por loja não escala além de 3 |
| Isolamento | RLS com `loja_id` vindo do JWT | Enforcement no banco, não na aplicação |
| Região | `sa-east-1` (São Paulo) | Latência e dados pessoais em território nacional |
| Identidade | Supabase Auth, e-mail + senha | Telefone depois, se necessário |
| Frontend | HTML/JS atual + `@supabase/supabase-js` | Reaproveita o protótipo inteiro |
| Migrations | Arquivos versionados no Git | Nunca alterar schema pelo painel |
| Segredos | Somente em Edge Functions | Nenhuma credencial fiscal no navegador |

### O que NÃO entra na fase 1

Emissão real de NF-e, integração com portais de anúncio e assinatura eletrônica
com validade jurídica. São integrações com terceiros, com homologação própria,
e cada uma é um projeto. **A fase 1 entrega o sistema gravando de verdade.**

---

## 2. Modelo de dados

Todas as tabelas de negócio têm `loja_id uuid not null`. Sem exceção.
Todas têm `criado_em`, `atualizado_em` e, onde faz sentido, `criado_por`.

A coluna de data de criação chama-se `criado_em` em **todas** as tabelas,
inclusive `lojas` — padronizado, sem variação de gênero.

### 2.0 Função de atualizado_em

As colunas `atualizado_em` não se atualizam sozinhas. Uma função e um trigger
`before update` mantêm a coluna em dia em toda tabela que a tenha
(hoje: `veiculos` e `clientes`).

```sql
create or replace function app.toca_atualizado_em()
returns trigger
language plpgsql
set search_path = ''   -- só usa now() (pg_catalog); search_path fixo evita aviso do linter
as $$
begin
  new.atualizado_em := now();
  return new;
end;
$$;

-- Aplicar em toda tabela que tenha a coluna atualizado_em:
create trigger toca_atualizado_em
  before update on public.veiculos
  for each row execute function app.toca_atualizado_em();

create trigger toca_atualizado_em
  before update on public.clientes
  for each row execute function app.toca_atualizado_em();
```

### 2.1 Núcleo

```sql
-- schema auxiliar para funções internas
create schema if not exists app;

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
```

### 2.2 Pátio

```sql
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
  contrato_id   uuid,   -- FK para contratos(id), adicionada por ALTER no fim da migration
  criado_em     timestamptz not null default now()
);
create index on public.consignacoes (loja_id);

-- A FK de contrato_id é adicionada no fim da migration porque a tabela
-- contratos (seção 2.6) só existe depois:
-- alter table public.consignacoes
--   add constraint consignacoes_contrato_id_fkey
--   foreign key (contrato_id) references public.contratos(id) on delete set null;
```

### 2.3 Clientes

```sql
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
```

### 2.4 Negócios

```sql
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
```

### 2.5 Carnê próprio

```sql
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
```

### 2.6 Papelada

```sql
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
```

### 2.7 Anúncios e auditoria

```sql
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

-- toda alteração sensível fica registrada
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
```

---

## 3. Segurança — a parte que não pode falhar

Duas lojas do mesmo auto shopping usando o sistema. Se uma enxergar o preço de
compra da outra, o negócio acaba. Isolamento é requisito, não recurso.

### 3.1 O `loja_id` vem do token, não de consulta

Colocar o `loja_id` numa claim do JWT evita consulta extra em toda política e
impede recursão de RLS. **Precisa ser `app_metadata`** — `user_metadata` é
editável pelo próprio usuário e não serve para autorização.

```sql
create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql stable
as $$
declare
  claims  jsonb;
  v_loja  uuid;
  v_papel text;
begin
  select loja_id, papel into v_loja, v_papel
    from public.perfis
   where id = (event->>'user_id')::uuid
     and ativo = true;

  claims := event->'claims';
  if claims->'app_metadata' is null then
    claims := jsonb_set(claims, '{app_metadata}', '{}'::jsonb);
  end if;

  if v_loja is not null then
    claims := jsonb_set(claims, '{app_metadata,loja_id}', to_jsonb(v_loja::text));
    claims := jsonb_set(claims, '{app_metadata,papel}',   to_jsonb(v_papel));
  end if;

  return jsonb_set(event, '{claims}', claims);
end;
$$;

grant usage  on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
grant select on public.perfis to supabase_auth_admin;
```

Depois: **Dashboard → Authentication → Hooks → Customize Access Token → ativar.**

> Ao mudar `perfis.loja_id` ou `papel`, o usuário só vê o efeito no próximo
> refresh de token. Force `supabase.auth.refreshSession()` após alterar.

### 3.2 Função de leitura da claim

```sql
create or replace function app.loja_id()
returns uuid
language sql stable
as $$
  select nullif(
    ((select auth.jwt()) -> 'app_metadata' ->> 'loja_id'), ''
  )::uuid
$$;

create or replace function app.papel()
returns text
language sql stable
as $$
  select coalesce((select auth.jwt()) -> 'app_metadata' ->> 'papel', 'vendedor')
$$;
```

O `(select auth.jwt())` entre parênteses é intencional: o Postgres passa a
avaliar uma vez por consulta em vez de uma vez por linha. Em tabela de mil
veículos isso é a diferença entre instantâneo e travado.

### 3.3 O guarda restritivo

Duas camadas. A **restritiva** vale para todas as políticas ao mesmo tempo e é a
rede de segurança: mesmo que alguém escreva uma política permissiva errada, ela
não fura o isolamento.

```sql
-- aplicar em TODA tabela de negócio
alter table public.veiculos enable row level security;
alter table public.veiculos force row level security;

create policy guarda_loja on public.veiculos
  as restrictive for all to authenticated
  using      (loja_id = app.loja_id())
  with check (loja_id = app.loja_id());

create policy ler on public.veiculos
  for select to authenticated using (true);

create policy escrever on public.veiculos
  for insert to authenticated with check (true);

create policy alterar on public.veiculos
  for update to authenticated using (true) with check (true);

create policy apagar on public.veiculos
  for delete to authenticated
  using (app.papel() in ('proprietario','gerente'));
```

O `true` das políticas permissivas é seguro porque a restritiva já filtrou.

**Repetir para:** `veiculo_custos`, `consignacoes`, `clientes`, `interacoes`,
`vendas`, `despesas`, `carne_contratos`, `carne_parcelas`, `config_fiscal`,
`numeracao_fiscal`, `notas_fiscais`, `contratos`, `portais`, `anuncios`,
`auditoria`, `perfis`.

`lojas` é diferente — cada um vê só a própria:

```sql
alter table public.lojas enable row level security;
alter table public.lojas force row level security;
create policy ver_minha_loja on public.lojas
  for select to authenticated using (id = app.loja_id());
create policy editar_minha_loja on public.lojas
  for update to authenticated
  using (id = app.loja_id() and app.papel() = 'proprietario')
  with check (id = app.loja_id());
```

### 3.4 O que a RLS não protege

RLS decide **linhas**, não **colunas**. Um vendedor com permissão de alterar
`perfis` poderia alterar o próprio `papel` para proprietário. Isso se fecha com
privilégio de coluna:

```sql
revoke update on public.perfis from authenticated;
grant update (nome, telefone) on public.perfis to authenticated;
-- papel, modulos, ver_custos, ver_lucro e loja_id só via função ou service_role
```

Mesmo raciocínio em `veiculos`: um vendedor não deve poder alterar `compra`.

```sql
revoke update on public.veiculos from authenticated;
grant update (alvo, foto_url, km, cor, renave_fase, atualizado_em)
  on public.veiculos to authenticated;
grant update (compra, entrada_em, status, origem)
  on public.veiculos to authenticated;  -- restringir por papel na aplicação + trigger
```

> **Custo e lucro**: as colunas `compra` e `custo_total` existem no banco e a RLS
> não esconde coluna. Para o vendedor não ver, exponha uma **view** sem essas
> colunas e faça o app do vendedor consultar a view, não a tabela. Alternativa
> mais simples na fase 1: manter o filtro no frontend e aceitar que é
> conveniência, não segurança — **e não prometer ao cliente que é segurança.**

### 3.5 Storage

Um bucket por finalidade, caminho começando pelo `loja_id`.

```
veiculos/{loja_id}/{veiculo_id}/{arquivo}
contratos/{loja_id}/{contrato_id}.pdf
fiscal/{loja_id}/{nota_id}.xml
```

```sql
create policy ler_fotos on storage.objects
  for select to authenticated
  using (bucket_id = 'veiculos'
         and (storage.foldername(name))[1] = app.loja_id()::text);

create policy subir_fotos on storage.objects
  for insert to authenticated
  with check (bucket_id = 'veiculos'
              and (storage.foldername(name))[1] = app.loja_id()::text);
```

Buckets `contratos` e `fiscal` ficam **privados**, com URL assinada de validade
curta gerada por Edge Function.

---

## 4. Numeração fiscal — o único ponto que exige transação

Nota fiscal não pode ter número repetido nem buraco. Isso é bloqueio de linha,
não contador em `jsonb`.

```sql
create or replace function app.proximo_numero_nf(p_serie int)
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v_loja uuid := app.loja_id();
  v_num  int;
begin
  if v_loja is null then raise exception 'sem loja no token'; end if;

  insert into public.numeracao_fiscal (loja_id, serie, proximo)
  values (v_loja, p_serie, 1)
  on conflict (loja_id, serie) do nothing;

  select proximo into v_num
    from public.numeracao_fiscal
   where loja_id = v_loja and serie = p_serie
   for update;                       -- bloqueia a linha até o commit

  update public.numeracao_fiscal
     set proximo = proximo + 1
   where loja_id = v_loja and serie = p_serie;

  return v_num;
end;
$$;
```

Chamar sempre dentro da mesma transação que grava a nota.

---

## 5. Colocar uma loja no ar em menos de um dia

Este é o fluxo que sustenta a promessa comercial dos sete dias.

### 5.1 Função de provisionamento

Roda com `service_role`, dentro de uma Edge Function chamada por você:

```sql
create or replace function app.criar_loja(
  p_nome text, p_cnpj text, p_cidade text, p_uf char(2),
  p_email_dono text, p_nome_dono text
) returns uuid
language plpgsql security definer
set search_path = public
as $$
declare v_loja uuid;
begin
  insert into public.lojas (nome, cnpj, cidade, uf)
  values (p_nome, p_cnpj, p_cidade, p_uf)
  returning id into v_loja;

  insert into public.config_fiscal (loja_id, cnpj) values (v_loja, p_cnpj);
  insert into public.numeracao_fiscal (loja_id, serie, proximo) values (v_loja, 1, 1);

  insert into public.portais (loja_id, portal, ativo)
  select v_loja, p, false from unnest(array['Webmotors','OLX','iCarros','Mercado Livre']) p;

  insert into public.despesas (loja_id, categoria, descricao, valor, tipo)
  values (v_loja,'Aluguel','Aluguel da loja',0,'fixa'),
         (v_loja,'Pessoal','Folha da equipe',0,'fixa');

  return v_loja;
end;
$$;
```

### 5.2 Roteiro de entrega

| Etapa | O que fazer | Tempo |
|---|---|---|
| 1 | `criar_loja(...)` com os dados do CNPJ | 2 min |
| 2 | Criar o usuário do dono no Auth e o `perfis` com `papel='proprietario'` e todos os módulos | 5 min |
| 3 | Importar o estoque a partir de planilha ou digitando | 30–60 min |
| 4 | Lançar as despesas fixas reais | 15 min |
| 5 | Criar os usuários da equipe com os módulos certos | 10 min |
| 6 | Enviar o link e um vídeo de 3 minutos gravado da tela dele | 20 min |

**Meta: loja no ar no mesmo dia da visita.** A garantia de sete dias só começa a
contar depois da etapa 6.

### 5.3 Importador de estoque

Faça um comando que aceite CSV com `marca, modelo, ano, km, placa, cor, compra,
preparacao, alvo, entrada_em`. É o que transforma uma hora de digitação em cinco
minutos, e é o que faz a demonstração virar contrato.

---

## 6. Ambientes e migrations

```
supabase/
  migrations/
    20260101000000_schema_base.sql
    20260101000100_rls.sql
    20260101000200_funcoes.sql
    20260101000300_seed_demo.sql
  functions/
    provisionar-loja/
    exportar-dados/
  tests/
    isolamento.test.sql
```

- **Nunca** alterar schema pelo painel do Supabase. Só migration versionada.
- Dois projetos: `zelauto-dev` e `zelauto-prod`.
- Rodar `supabase db reset` local antes de subir qualquer coisa.
- Antes de cada deploy em produção: rodar os testes da seção 7.

---

## 7. Testes de isolamento — obrigatórios

Sem isto, você não tem garantia nenhuma. Escreva junto com as políticas, não
depois.

```sql
-- pgTAP
begin;
select plan(6);

-- duas lojas fictícias, dois usuários
insert into public.lojas (id, nome) values
  ('11111111-1111-1111-1111-111111111111','Loja A'),
  ('22222222-2222-2222-2222-222222222222','Loja B');

-- ... criar usuários e perfis vinculados ...

-- assume o token da Loja A
set local role authenticated;
set local request.jwt.claims to
  '{"sub":"aaa...","app_metadata":{"loja_id":"11111111-1111-1111-1111-111111111111","papel":"proprietario"}}';

select is(
  (select count(*) from public.veiculos where loja_id = '22222222-2222-2222-2222-222222222222'),
  0::bigint,
  'Loja A não enxerga veículo da Loja B'
);

select throws_ok(
  $$ insert into public.veiculos (loja_id, marca, modelo)
     values ('22222222-2222-2222-2222-222222222222','X','Y') $$,
  'Loja A não consegue gravar na Loja B'
);

-- repetir para clientes, vendas, notas_fiscais, contratos e storage
select * from finish();
rollback;
```

**Rode este teste para toda tabela nova.** Uma tabela sem teste de isolamento é
uma tabela que ainda não existe.

---

## 8. Checklist antes de cada entrega

- [ ] Toda tabela nova tem `loja_id`, índice em `loja_id` e RLS habilitada
- [ ] Toda tabela tem `force row level security`
- [ ] Toda tabela tem a política `guarda_loja` restritiva
- [ ] Nenhuma tabela com RLS ligada e zero políticas (fica inacessível)
- [ ] Toda política de `update` tem política de `select` correspondente
- [ ] Nenhuma chave `service_role` no código do navegador
- [ ] Avisos de segurança do Supabase revisados e zerados
- [ ] Testes de isolamento passando
- [ ] Backup automático ativo (PITR no plano pago)

---

## 9. Exportação de dados

Você prometeu no site que os dados são do lojista e saem quando ele quiser.
Isso precisa existir de verdade, não como boa vontade.

Edge Function `exportar-dados` que gera um `.zip` com um CSV por tabela da loja
e devolve URL assinada de 24h. Um botão em Configurações. Leva meia hora para
construir e é o que sustenta a resposta da objeção "e se vocês sumirem".

---

## 10. Ligando o protótipo

O HTML atual usa um objeto `DB` em memória. A troca é cirúrgica:

1. Trocar `DB.veiculos` por `await sb.from('veiculos').select('*')`
2. Trocar cada `salvarX()` por `insert`/`update`
3. Cada `render()` passa a ser assíncrono
4. `USER` deixa de vir de `DB.usuarios` e passa a vir de `perfis` do usuário logado
5. `pode(m)` lê `USER.modulos` vindo do banco

**Não reescreva as telas.** Elas estão prontas e testadas. Troque só a camada de
dados. Sugestão: crie `dados.js` com uma função por entidade
(`listarVeiculos`, `salvarVeiculo`, …) e substitua as chamadas uma a uma.

Ordem recomendada: login → veículos → clientes → vendas → despesas → resto.

---

## 11. Fases

| Fase | Entrega | Prazo alvo |
|---|---|---|
| **1** | Auth, RLS, veículos, clientes, vendas, despesas, equipe, fotos | 1–2 semanas |
| **2** | Carnê com parcelas, contratos em PDF, exportação de dados | 1 semana |
| **3** | RENAVE (acompanhamento), relatórios, auditoria | 1 semana |
| **4** | NF-e real via provedor | 3–4 semanas |
| **5** | Integrador de anúncios (exige homologação por portal) | meses |

**Só venda o que estiver na fase entregue.** Fases 4 e 5 são módulo à parte, com
preço à parte, e só se anunciam quando estiverem no ar.

---

## 12. Prompts prontos para o Claude Code

Cole um por vez. Não peça tudo de uma vez.

**Migration inicial**
> Leia a seção 2 da especificação em anexo. Crie a migration
> `supabase/migrations/0001_schema_base.sql` com exatamente essas tabelas,
> tipos, checks e índices. Não invente colunas. Ao final, liste o que criou.

**RLS**
> Leia a seção 3. Crie `0002_rls.sql` habilitando RLS e `force row level
> security` em todas as tabelas de negócio, com a política restritiva
> `guarda_loja` e as permissivas. Crie também as funções `app.loja_id()`,
> `app.papel()` e o `custom_access_token_hook` com os grants corretos.

**Testes**
> Leia a seção 7. Crie `supabase/tests/isolamento.test.sql` com pgTAP cobrindo
> leitura e escrita cruzada entre duas lojas, para todas as tabelas de negócio.
> Rode e me mostre o resultado.

**Camada de dados**
> Leia a seção 10 e o arquivo `zelauto.html`. Crie `dados.js` com uma função por
> entidade usando `@supabase/supabase-js`. Não altere nenhuma função de tela
> ainda — só crie a camada e me mostre a interface pública.

**Auditoria de segurança**
> Rode os avisos de segurança do projeto Supabase. Para cada apontamento,
> explique o risco em uma frase e proponha a correção. Não aplique nada sem
> minha confirmação.

---

## 13. Armadilhas conhecidas

| Armadilha | Consequência | Prevenção |
|---|---|---|
| Usar `user_metadata` para `loja_id` | O usuário edita e vê outra loja | Só `app_metadata`, preenchido pelo hook |
| `auth.jwt()` sem `select` na política | Consulta lenta em tabela grande | `(select auth.jwt())` |
| Esquecer `loja_id` numa tabela nova | Vazamento entre lojas | Checklist da seção 8 |
| RLS ligada sem política | Tabela some para todo mundo | Teste de isolamento pega |
| `update` sem `select` | Update falha em silêncio | Sempre criar o par |
| `service_role` no frontend | Ignora toda a RLS | Só em Edge Function |
| Alterar `papel` e não renovar token | Permissão não muda | `refreshSession()` após alterar |
| Schema alterado pelo painel | Dev e produção divergem | Só migration versionada |
| Vender NF-e antes de existir | Cliente cobra o que não há | Fase 4, módulo à parte |

---

## 14. Custo esperado

| Item | Estimativa mensal |
|---|---|
| Supabase Pro | ~US$ 25 (cobre as primeiras dezenas de lojas) |
| Hospedagem do frontend | R$ 0 a 50 |
| Domínio | ~R$ 5 |
| **Por loja, na fase 1** | **próximo de zero** |

O custo real aparece na fase 4: provedor de NF-e cobra por CNPJ. Trate como
repasse, não como custo absorvido.

---

## 15. Ordem de execução

1. Criar projeto `zelauto-dev` em São Paulo
2. Migration 0001 (schema)
3. Migration 0002 (RLS + hook) e **ativar o hook no painel**
4. Testes de isolamento — só avance quando passarem
5. `criar_loja` e uma loja de demonstração com dados fictícios
6. `dados.js` e troca do login
7. Veículos gravando de verdade
8. Resto das telas, uma por vez
9. Storage de fotos
10. Exportação de dados
11. `zelauto-prod` e o primeiro cliente real

---

*Última revisão: agosto de 2026. Ao mudar qualquer decisão, atualize este
documento antes de escrever código.*
