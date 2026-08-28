-- =============================================================================
-- 0016 — Auditoria (fase 3)
--
-- Registra QUEM mudou O QUÊ e QUANDO nas tabelas sensíveis, via TRIGGER — não
-- depende do app lembrar de gravar. O log é:
--   * imutável   — ninguém do app insere/edita/apaga direto (só o trigger);
--   * por loja   — a linha herda o loja_id do registro;
--   * restrito   — só proprietário/gerente leem (o `depois` guarda o registro
--                  inteiro em jsonb, inclusive compra/custo; um vendedor não
--                  pode ler isso, senão o custo vazaria por aqui).
--
-- Não é tabela nova: `auditoria` já existe (schema base) com loja_id e RLS. Aqui
-- endurecemos as políticas e ligamos os gatilhos.
-- =============================================================================

-- 1) Função do gatilho. SECURITY DEFINER: escreve na auditoria mesmo com o
--    usuário sem privilégio de INSERT (o log não pode ser forjado pelo app).
--    Extrai id/loja_id do jsonb para servir a qualquer tabela (inclusive
--    config_fiscal, que tem loja_id como PK e não tem coluna id).
create or replace function app.audita()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_antes  jsonb;
  v_depois jsonb;
  v_ref    jsonb;
begin
  v_antes  := case when TG_OP = 'INSERT' then null else to_jsonb(OLD) end;
  v_depois := case when TG_OP = 'DELETE' then null else to_jsonb(NEW) end;
  v_ref    := coalesce(v_depois, v_antes);

  -- A auditoria NUNCA pode derrubar a operação de negócio: se o log falhar
  -- (RLS, indisponibilidade, o que for), a venda/edição do carro segue e só o
  -- registro de auditoria é perdido. Falha-aberto é o correto aqui.
  begin
    insert into public.auditoria (loja_id, usuario_id, tabela, registro_id, acao, antes, depois)
    values (
      (v_ref ->> 'loja_id')::uuid,
      auth.uid(),
      TG_TABLE_NAME,
      (v_ref ->> 'id')::uuid,
      TG_OP,
      v_antes,
      v_depois
    );
  exception when others then
    null;
  end;

  return case when TG_OP = 'DELETE' then OLD else NEW end;
end $$;

-- 2) Endurece a auditoria: log imutável e leitura só para gestão.
alter table public.auditoria enable row level security;
alter table public.auditoria force  row level security;

-- remove as permissivas genéricas de escrita criadas no 0002 (o app não escreve)
drop policy if exists escrever on public.auditoria;
drop policy if exists alterar  on public.auditoria;
drop policy if exists apagar   on public.auditoria;

-- leitura: troca a permissiva ampla por uma restrita a proprietário/gerente
drop policy if exists ler on public.auditoria;
create policy ler on public.auditoria
  for select to authenticated
  using (loja_id = app.loja_id() and app.papel() in ('proprietario','gerente'));

-- defesa em profundidade: tira o privilégio de escrita direta do authenticated.
-- Só o trigger (SECURITY DEFINER, dono postgres) grava.
-- (A política permissiva de INSERT que o trigger precisa está na 0017 — foi
--  separada para não reescrever esta migration caso já tivesse sido aplicada.)
revoke insert, update, delete on public.auditoria from authenticated;

-- 3) Liga os gatilhos nas tabelas de negócio sensíveis.
do $$
declare
  t text;
  alvo text[] := array[
    'veiculos','vendas','despesas','clientes','contratos',
    'consignacoes','carne_contratos','perfis','config_fiscal'
  ];
begin
  foreach t in array alvo loop
    execute format('drop trigger if exists audita_%1$s on public.%1$s', t);
    execute format(
      'create trigger audita_%1$s after insert or update or delete on public.%1$s
         for each row execute function app.audita()', t);
  end loop;
end $$;
