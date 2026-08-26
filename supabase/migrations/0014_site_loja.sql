-- =============================================================================
-- ZelAuto — 0014_site_loja.sql
-- Site público da loja ("Site no ar", seção 5.9): banner editável + flag on/off.
--
-- O site é renderizado no servidor pela Edge Function `site-loja` (SSR, para
-- indexar no Google). Logo já existe (lojas.logo_url + bucket marcas). Aqui
-- entram o banner e um interruptor do site.
--
-- Buckets públicos de propósito (aparecem no site, antes de qualquer login);
-- escrita só do dono, no prefixo da própria loja. Não é destrutivo.
-- =============================================================================

alter table public.lojas
  add column if not exists banner_url text,
  add column if not exists site_ativo boolean not null default true;

insert into storage.buckets (id, name, public)
values ('banners', 'banners', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='banner_subir') then
    create policy banner_subir on storage.objects for insert to authenticated
      with check (bucket_id='banners' and (storage.foldername(name))[1] = app.loja_id()::text);
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='banner_trocar') then
    create policy banner_trocar on storage.objects for update to authenticated
      using (bucket_id='banners' and (storage.foldername(name))[1] = app.loja_id()::text);
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='banner_apagar') then
    create policy banner_apagar on storage.objects for delete to authenticated
      using (bucket_id='banners' and (storage.foldername(name))[1] = app.loja_id()::text);
  end if;
end $$;
