-- =============================================================================
-- ZelAuto — 0012_marca_loja.sql
-- Marca por loja: slug (URL própria), logo e cor (seção 5.7).
--
-- IMPORTANTE: o slug é só MARCA e ROTA, nunca acesso. A loja da sessão vem sempre
-- do perfil no JWT (§3.1). O slug na URL só decide qual marca a tela de login
-- mostra — não concede nada.
--
-- Não é destrutivo (colunas nullable + bucket idempotente).
-- =============================================================================

alter table public.lojas
  add column if not exists slug     text,
  add column if not exists logo_url text,
  add column if not exists cor      text;

-- slug vira URL: minúsculas, números e hífen; sem hífen nas pontas; 2 a 40 chars
alter table public.lojas drop constraint if exists lojas_slug_formato;
alter table public.lojas
  add constraint lojas_slug_formato
  check (slug is null or (slug ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?$' and length(slug) between 2 and 40));

create unique index if not exists lojas_slug_uidx on public.lojas (slug) where slug is not null;

-- --- bucket público das marcas ------------------------------------------------
-- Logo aparece na tela de login, ANTES da sessão -> bucket público de propósito.
-- Leitura é aberta (público); escrita só do dono, no prefixo da própria loja.
insert into storage.buckets (id, name, public)
values ('marcas', 'marcas', true)
on conflict (id) do nothing;

do $$
begin
  -- escrita restrita ao prefixo {loja_id}/ da loja do autor
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='marca_subir') then
    create policy marca_subir on storage.objects for insert to authenticated
      with check (bucket_id = 'marcas' and (storage.foldername(name))[1] = app.loja_id()::text);
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='marca_trocar') then
    create policy marca_trocar on storage.objects for update to authenticated
      using (bucket_id = 'marcas' and (storage.foldername(name))[1] = app.loja_id()::text);
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='marca_apagar') then
    create policy marca_apagar on storage.objects for delete to authenticated
      using (bucket_id = 'marcas' and (storage.foldername(name))[1] = app.loja_id()::text);
  end if;
end $$;
