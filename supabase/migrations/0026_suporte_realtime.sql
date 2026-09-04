-- =============================================================================
-- 0026 — Suporte em tempo real (fluxo instantâneo, sem F5)
--
-- O lojista precisa ver na hora: a mensagem que o suporte manda, e o momento em
-- que o acesso ao painel é encerrado (o banner tem que sumir sozinho). Polling
-- de 60s é lento demais para uma conversa. Ligamos o Realtime do Supabase nas
-- duas tabelas do suporte — o lojista já pode LER as duas (RLS `ler`), então o
-- Realtime respeita o mesmo isolamento: cada loja só recebe o que é dela.
--
-- O Console do operador NÃO usa isto (ele lê pela Edge com service_role, não tem
-- perfil de loja); lá o tempo real é polling curto no próprio painel.
--
-- Não é destrutivo: só adiciona as tabelas à publicação do Realtime.
-- =============================================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public' and tablename = 'suporte_mensagens'
  ) then
    alter publication supabase_realtime add table public.suporte_mensagens;
  end if;

  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public' and tablename = 'suporte_sessoes'
  ) then
    alter publication supabase_realtime add table public.suporte_sessoes;
  end if;
end $$;
