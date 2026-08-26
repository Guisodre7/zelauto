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
  cliente_nome  text,                   -- congelado: nome do comprador na venda
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

-- IMPORTANTE: perfis tem `force row level security`, então o GRANT acima NÃO
-- basta — o hook (que roda como supabase_auth_admin) precisa de uma POLÍTICA
-- para ler perfis. Sem ela, o JWT sai sem loja_id, app.loja_id() vira null e o
-- usuário nem enxerga o próprio perfil (login retorna 406). Aplicada na 0006.
create policy hook_auth_le_perfis on public.perfis
  as permissive for select to supabase_auth_admin
  using (true);
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

-- Um schema NOVO não concede USAGE a ninguém por padrão (diferente do `public`).
-- Sem isto, o papel authenticated não avalia as políticas (elas chamam
-- app.loja_id()) e toda leitura/escrita quebra com 42501. Aplicado na 0003.
grant usage on schema app to authenticated;
grant execute on function app.loja_id() to authenticated;
grant execute on function app.papel()  to authenticated;
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

> **Implementado (migration 0009, seção 5.5):** custo virou segurança de verdade.
> `veiculos.compra` e a tabela `veiculo_custos` tiveram o SELECT **removido do
> papel `authenticated`** (privilégio de coluna/tabela). Como dono e vendedor são
> o mesmo papel de banco, o custo some para todos no acesso via API e volta só
> pela Edge Function `custos`, que confere `ver_custos`/papel do perfil e devolve
> compra + preparação escopados à loja. Testes de isolamento cobrem o SELECT
> negado. O isolamento entre lojas segue sendo a RLS — isto é o reforço interno.

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

**Implementado (migration 0007) para `veiculos`:** o bucket `veiculos` também é
**privado** — foto de carro é anúncio, mas o isolamento de leitura vale a decisão.
Caminho dos objetos: `{loja_id}/{veiculo_id}/foto.jpg`, então
`(storage.foldername(name))[1] = app.loja_id()::text`. Políticas de select,
insert, **update e delete** (as duas últimas para trocar/remover a foto), todas
restritas ao prefixo da loja. A coluna `veiculos.foto_url` guarda o **path** do
objeto; o front resolve para **URL assinada** (`createSignedUrl`, ~1h) na
exibição. O `authenticated` já tem `grant update(foto_url)` (seção 3.4).

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

### 5.4 Edge Function `equipe` — gestão de time pelo próprio lojista

O dono precisa **criar membros e definir permissões sozinho**, sem CLI e sem
abrir o painel. Mas `papel`, `modulos`, `ver_custos`, `ver_lucro` e a criação de
login no Auth **não podem sair do navegador** (§3.4) — senão um vendedor se
promove. A ponte é uma Edge Function `equipe` que roda com `service_role`,
**confere quem chamou pelo JWT** e só então age.

**Autorização (dentro da função):**
- Identifica o chamador pelo token (client escopo-usuário → `auth.getUser()`),
  lê o `perfis` dele com `service_role` e exige `ativo = true` e
  `papel ∈ {proprietario, gerente}`.
- A loja alvo é **sempre** a `loja_id` do chamador — nunca o que o corpo mandar.
- **Gerente tem teto:** não cria nem promove a `proprietario`, e não altera um
  membro que já é `proprietario`.

**Ações (uma função, campo `acao` no corpo):**

| `acao` | O que faz | Retorno |
|---|---|---|
| `criar` | `auth.admin.createUser({email, password, email_confirm:true})` + `insert` em `perfis` (loja do chamador, papel, modulos, ver_custos, ver_lucro) | `{ email, senha }` provisória para exibir |
| `atualizar` | `update` em `perfis` do alvo (nome, telefone, papel, modulos, ver_custos, ver_lucro, ativo), validando mesma loja e o teto do gerente | `{ ok: true }` |

A **senha provisória** é gerada na função e devolvida **uma vez** para o dono
repassar; o funcionário troca depois. Não vai por e-mail na fase 1 (não depende
de SMTP configurado). O `email_confirm:true` deixa o membro entrar de imediato.
O hook de token (§3.1) preenche `loja_id`/`papel` no JWT no primeiro login,
porque o `perfis` já foi inserido.

Segredos: a função usa `SUPABASE_SERVICE_ROLE_KEY` e `SUPABASE_URL`, injetados
automaticamente no runtime da Edge Function. **Nada de service_role no front.**

Deploy: `supabase functions deploy equipe`.

### 5.5 Edge Function `custos` — custo só para quem pode ver

A migration 0009 tira `veiculos.compra` e a tabela `veiculo_custos` do SELECT do
papel `authenticated`. Como dono e vendedor compartilham esse papel (o que os
separa é o token, que a RLS usa para LINHAS, não colunas), esconder o custo por
privilégio some com ele para todos no cliente. A Edge Function `custos` devolve o
custo de volta só para quem pode:

- Autentica o chamador pelo JWT, lê o perfil dele com `service_role`.
- Se `ver_custos = true` **ou** papel ∈ {proprietario, gerente}: devolve
  `{ custos: { veiculo_id: { compra, prep } } }` da loja do chamador.
- Senão: devolve `{ custos: {} }` (não é erro; o pátio segue sem custo).

O front (`listarVeiculos`) lê os veículos **sem** `compra`, chama `custos` e
funde compra/preparação para quem tem direito. Gravação de custo continua na
tabela por insert/update (o `.select()` do RETURNING foi restringido a `id`/
`entrada_em`, senão bateria no SELECT negado de `compra`). Escrita de `compra`
segue com o grant de update por coluna (§3.4).

Deploy: `supabase functions deploy custos`.

### 5.6 Edge Function `vender` — registra a venda congelando o custo real

A migration 0010 tira `vendas.custo_total` do SELECT do `authenticated` (mesmo
motivo da 0009). Aí surge um efeito: o vendedor, sem ver o custo, não conseguiria
calcular `custo_total` na hora de vender. Então a **gravação da venda** passa a
ser feita pela Edge Function `vender` (service_role):

- Autentica o chamador; qualquer perfil ativo da loja pode registrar (o vendedor
  fecha o negócio). Loja e vendedor saem do JWT, nunca do corpo.
- Lê `compra + preparação` do veículo (service_role) e **congela** em
  `custo_total`. O veículo tem de ser da mesma loja.
- Insere a venda e marca o veículo como `vendido` — os dois passos num lugar só,
  sem meio-estado.

A leitura de volta do `custo_total` (para quem pode ver) vem pela função `custos`
(campo `vendas`). Edição de venda existente no cliente não toca `custo_total`.

Deploy: `supabase functions deploy vender`.

### 5.7 Marca por loja e login com slug

O lojista entra por uma URL própria — `app.zelauto…/vancar` — e vê a tela de
login **com a marca da loja dele** (nome, logo, cor). Detalhe que não pode ser
esquecido: **o `slug` é só marca e rota, nunca acesso.** A loja da sessão vem
SEMPRE do perfil no JWT (§3.1); o slug digitado/na URL só escolhe qual marca
mostrar. Se alguém abrir o slug de outra loja e logar, continua vendo a própria
loja — o slug errado não dá acesso a nada.

- `lojas` ganha `slug` (único, `^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`), `logo_url`, `cor`.
- Bucket público `marcas` (`{loja_id}/logo.png`) — logo aparece antes da sessão,
  então é público de propósito; escrita só do dono, no prefixo da própria loja.
- Edge Function `marca-loja` (pública, anon): recebe **um slug exato** e devolve
  só `{nome, logo_url, cor}` de uma loja ativa, ou 404. **Não lista lojas** — sem
  diretório público, para concorrente não enumerar clientes. É a primeira
  superfície anônima do sistema; devolve só campos de marca, nada sensível.
- A tela de login (protótipo) lê o slug da URL, chama `marca-loja`, pinta a marca
  e segue com o `entrar(email, senha)` de sempre. Traz um selo **"por ZelAuto"**
  ligado à landing institucional.
- **Sem slug** (ex.: `app.zelauto…` puro): NÃO mostra login — só uma página
  "acesse pelo link da sua loja", com botão **"Não tenho o link"** que abre o
  WhatsApp do suporte. Sem campo de e-mail, sem busca, sem lista. Cada lojista
  recebe o link na entrega e salva nos favoritos. (WhatsApp e site saem de
  `dados.config.js`: `suporteWhatsapp`, `siteInstitucional`.)

Deploy: `supabase functions deploy marca-loja`.

### 5.8 Console do Operador — o control plane da ZelAuto

Uma superfície SEPARADA (`admin/index.html`, em produção `admin.zelauto…`), só do
operador ZelAuto, para provisionar e acompanhar as lojas sem processo manual.

**Padrão de segurança (control plane, como nos grandes SaaS):**
- Operador é identidade separada do lojista: fica em `public.operadores`
  (migration 0013), **não tem perfil de loja**. Logo, pela RLS normal, não vê
  dado de loja nenhuma; só age pelo console.
- `operadores` e `operador_log` **não são legíveis pela API** (force RLS + sem
  política + grants revogados). Só o `service_role`, dentro da função.
- Toda ação passa pela Edge Function `admin` (service_role), que confere
  **sessão válida + membership em operadores** antes de qualquer coisa (403 se
  não for operador). Defense in depth: mesmo com a UI vazada, o servidor barra.
- Cada ação vira uma linha em `operador_log` (auditoria do control plane).

**Ações da função `admin`:**
- `criar_loja`: cria a loja (nome/slug/cor) + o login do dono (senha provisória)
  + perfil `proprietario` com todos os módulos. **Banco limpo, sem seed.**
  Devolve o link de acesso (`app…?loja=slug`), e-mail e senha do dono.
- `metricas`: KPIs por loja e totais (cross-loja) — lojas, veículos, clientes,
  vendas.
- `importar`: recebe estoque/clientes já mapeados (o console faz o parse do CSV
  do sistema atual do lojista, cabeçalho → colunas) e insere na loja de destino.

Para promover o primeiro operador (uma vez, no SQL Editor):
`insert into public.operadores (id, nome) select id, 'Nome' from auth.users where email = '…';`

Deploy: `supabase functions deploy admin`.

### 5.9 Site da loja — SSR público (indexável no Google)

O "Site no ar": fica pronto sozinho assim que o lojista sobe o primeiro carro.
Renderizado no SERVIDOR pela Edge Function `site-loja` (SSR — é o que faz o
Google indexar sem trabalho), pública (GET), por slug.

- Lê com `service_role` **só campos públicos** do estoque (marca, modelo, ano,
  km, cor, `alvo` = preço de anúncio, foto) — **nunca compra/custo**. Só carros
  `status='estoque'` de loja `ativa` e `site_ativo`.
- Rotas: `?slug=` (catálogo), `?slug=&carro=<id>` (página do carro),
  `?slug=&sitemap=1` (sitemap.xml). Em produção, um rewrite mapeia
  `zelauto.com.br/vancar` → a função; a env `SITE_BASE` deixa os links bonitos.
- SEO: `<title>`/description/canonical/OpenGraph + **JSON-LD** (`AutoDealer` no
  catálogo, `Car`+`Offer` na página do carro). Cada carro tem URL própria.
- Marca do lojista: logo (bucket `marcas`) e **banner** (bucket `banners`,
  migration 0014) + cor. Fotos de carro saem por URL assinada (bucket privado),
  re-renderadas a cada visita.
- Não expõe endpoint de dados anônimo: a função é o portão; devolve HTML, não JSON.

Deploy: `supabase functions deploy site-loja`  ·  Feed de portais e upload de
banner/logo pela UI: passos seguintes.

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
| Schema novo (ex.: `app`) sem `grant usage` ao `authenticated` | Toda leitura/escrita quebra com 42501 — a política não consegue chamar `app.loja_id()` | `grant usage on schema app to authenticated` + `grant execute` nas funções (migration 0003) |
| Verificar RLS só como superuser/painel | O superuser ignora RLS; o bug do `authenticated` passa batido | Teste de isolamento rodando com `set role authenticated` |
| Hook do token sob `force RLS` sem política para `supabase_auth_admin` | O hook não lê `perfis`, o JWT sai sem `loja_id` e o login volta 406 | Política `for select to supabase_auth_admin using (true)` (migration 0006) |
| Testar só com `set request.jwt.claims` na mão | Pula o hook; o furo do hook só aparece no login real ponta-a-ponta | Fazer um login de verdade antes de dar o passo por pronto |
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
