-- =============================================================================
-- ZelAuto — 0002_rls.sql
-- Isolamento entre lojas (fase 1). Corresponde à seção 3 de docs/backend.md.
--
-- Esta migration:
--   1. cria app.loja_id() e app.papel() (leem a claim do JWT)
--   2. cria public.custom_access_token_hook + grants
--   3. habilita RLS + force row level security em TODA tabela de negócio
--   4. cria a política restritiva guarda_loja e as permissivas em cada tabela
--   5. trata lojas (cada um vê só a própria)
--   6. endurece privilégio de coluna em perfis e veiculos (RLS não filtra coluna)
--
-- DEPOIS DE APLICAR, é OBRIGATÓRIO ativar o hook no painel:
--   Dashboard -> Authentication -> Hooks -> Customize Access Token -> ativar.
-- Sem isso, o JWT não recebe app_metadata.loja_id e app.loja_id() retorna null
-- (o guarda_loja bloqueia tudo). Ao alterar perfis.loja_id/papel, o efeito só
-- aparece no próximo refresh de token: force supabase.auth.refreshSession().
--
-- Próximo passo da seção 15: testes de isolamento (0002 não vai para produção
-- sem os testes da seção 7 passando).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3.2 Leitura das claims (o (select auth.jwt()) entre parênteses é intencional:
--     avalia uma vez por consulta, não uma vez por linha)
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- 3.1 Hook que injeta loja_id e papel em app_metadata (nunca user_metadata)
-- -----------------------------------------------------------------------------
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

grant usage   on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook from authenticated, anon, public;
grant select  on public.perfis to supabase_auth_admin;

-- -----------------------------------------------------------------------------
-- 3.3 O guarda restritivo + permissivas em toda tabela de negócio
--
-- Aplicado por laço para garantir que TODAS as tabelas recebam exatamente o
-- mesmo conjunto de políticas (sem esquecer nenhuma e sem divergência). O
-- template abaixo é idêntico ao exemplo de `veiculos` na seção 3.3:
--
--   enable + force row level security
--   guarda_loja  (RESTRICTIVE, for all)  using/with check (loja_id = app.loja_id())
--   ler          (select)   using (true)
--   escrever     (insert)   with check (true)
--   alterar      (update)   using (true) with check (true)   -- par select+update
--   apagar       (delete)   using (app.papel() in ('proprietario','gerente'))
--
-- O `true` das permissivas é seguro porque a restritiva já filtrou por loja.
-- A lista tem as 17 tabelas de negócio da seção 2 (lojas é tratada à parte).
-- -----------------------------------------------------------------------------
do $$
declare
  t text;
  tabelas text[] := array[
    'veiculos','veiculo_custos','consignacoes','clientes','interacoes',
    'vendas','despesas','carne_contratos','carne_parcelas','config_fiscal',
    'numeracao_fiscal','notas_fiscais','contratos','portais','anuncios',
    'auditoria','perfis'
  ];
begin
  foreach t in array tabelas loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force  row level security', t);

    execute format($f$
      create policy guarda_loja on public.%I
        as restrictive for all to authenticated
        using      (loja_id = app.loja_id())
        with check (loja_id = app.loja_id())
    $f$, t);

    execute format(
      'create policy ler on public.%I for select to authenticated using (true)', t);
    execute format(
      'create policy escrever on public.%I for insert to authenticated with check (true)', t);
    execute format(
      'create policy alterar on public.%I for update to authenticated using (true) with check (true)', t);
    execute format(
      $f$create policy apagar on public.%I for delete to authenticated
         using (app.papel() in ('proprietario','gerente'))$f$, t);
  end loop;
end $$;

-- -----------------------------------------------------------------------------
-- lojas é diferente — cada um vê e edita só a própria
-- -----------------------------------------------------------------------------
alter table public.lojas enable row level security;
alter table public.lojas force  row level security;

create policy ver_minha_loja on public.lojas
  for select to authenticated using (id = app.loja_id());

create policy editar_minha_loja on public.lojas
  for update to authenticated
  using      (id = app.loja_id() and app.papel() = 'proprietario')
  with check (id = app.loja_id());

-- -----------------------------------------------------------------------------
-- 3.4 Privilégio de coluna — RLS decide LINHA, não COLUNA
-- Impede que um vendedor altere o próprio papel, ou mexa no preço de compra.
-- -----------------------------------------------------------------------------
revoke update on public.perfis from authenticated;
grant  update (nome, telefone) on public.perfis to authenticated;
-- papel, modulos, ver_custos, ver_lucro e loja_id: só via função ou service_role

revoke update on public.veiculos from authenticated;
grant  update (alvo, foto_url, km, cor, renave_fase, atualizado_em)
  on public.veiculos to authenticated;
grant  update (compra, entrada_em, status, origem)
  on public.veiculos to authenticated;  -- restringir por papel na aplicação + trigger
