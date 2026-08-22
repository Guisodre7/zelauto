-- =============================================================================
-- ZelAuto — 0007_storage_veiculos.sql
-- Storage de fotos de veículos (seção 3.5 de docs/backend.md).
--
-- Bucket PRIVADO. Leitura protegida por RLS: uma loja só acessa fotos no seu
-- próprio prefixo de caminho. O app exibe via URL assinada de validade curta.
-- Caminho dos objetos (name, dentro do bucket): {loja_id}/{veiculo_id}/foto.jpg
-- então (storage.foldername(name))[1] = loja_id.
--
-- Não é destrutivo. Se o `supabase db push` reclamar de permissão ao criar
-- policy em storage.objects ("must be owner of table objects"), crie o bucket e
-- as políticas pela UI de Storage do painel — o efeito é o mesmo.
-- =============================================================================

insert into storage.buckets (id, name, public)
values ('veiculos', 'veiculos', false)
on conflict (id) do nothing;

-- Ler: só objetos do prefixo da própria loja.
create policy fotos_veiculos_ler on storage.objects
  for select to authenticated
  using (bucket_id = 'veiculos'
         and (storage.foldername(name))[1] = app.loja_id()::text);

-- Subir (INSERT).
create policy fotos_veiculos_subir on storage.objects
  for insert to authenticated
  with check (bucket_id = 'veiculos'
              and (storage.foldername(name))[1] = app.loja_id()::text);

-- Substituir (UPDATE — usado pelo upload com upsert). 3.5 mostra só select/insert;
-- update/delete entram para permitir trocar/remover a foto, sempre no prefixo da loja.
create policy fotos_veiculos_atualizar on storage.objects
  for update to authenticated
  using      (bucket_id = 'veiculos'
              and (storage.foldername(name))[1] = app.loja_id()::text)
  with check (bucket_id = 'veiculos'
              and (storage.foldername(name))[1] = app.loja_id()::text);

-- Apagar.
create policy fotos_veiculos_apagar on storage.objects
  for delete to authenticated
  using (bucket_id = 'veiculos'
         and (storage.foldername(name))[1] = app.loja_id()::text);
