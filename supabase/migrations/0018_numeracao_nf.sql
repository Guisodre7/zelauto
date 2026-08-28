-- =============================================================================
-- 0018 — Numeração fiscal atômica (fase 4, pré-requisito da NF-e)
--
-- Nota fiscal não pode ter número repetido nem buraco: é bloqueio de linha, não
-- contador em memória. Esta função reserva o próximo número por loja/série com
-- `for update`. Deve ser chamada na MESMA transação que grava a nota.
--
-- A emissão REAL na SEFAZ é do provedor (fase 4, precisa de certificado/credencial
-- server-side). Aqui entregamos a numeração isolada e correta; a nota nasce
-- 'processando' e o provedor a leva para 'autorizada'.
-- =============================================================================

create or replace function app.proximo_numero_nf(p_serie int)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
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

revoke execute on function app.proximo_numero_nf(int) from public, anon;
grant  execute on function app.proximo_numero_nf(int) to authenticated;

-- Emissão da nota numa transação só: reserva o número E grava a linha juntos
-- (se a gravação falhar, o número não é queimado — sem buraco). Exposta em
-- `public` para o PostgREST/supabase-js chamar via rpc. A nota nasce
-- 'processando'; o provedor de NF-e (fase 4) a leva para 'autorizada'.
create or replace function public.emitir_nota(
  p_serie int, p_tipo text, p_dest text, p_doc text, p_desc text,
  p_valor numeric, p_venda_id uuid
)
returns public.notas_fiscais
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_loja uuid := app.loja_id();
  v_num  int;
  v_nota public.notas_fiscais;
begin
  if v_loja is null then raise exception 'sem loja no token'; end if;
  if coalesce(p_dest,'') = '' then raise exception 'destinatário obrigatório'; end if;

  v_num := app.proximo_numero_nf(p_serie);

  insert into public.notas_fiscais
    (loja_id, numero, serie, tipo, venda_id, destinatario, doc, descricao, valor, status)
  values
    (v_loja, v_num, p_serie, coalesce(p_tipo,'saida'), p_venda_id, p_dest, p_doc,
     p_desc, coalesce(p_valor,0), 'processando')
  returning * into v_nota;

  return v_nota;
end $$;

revoke execute on function public.emitir_nota(int,text,text,text,text,numeric,uuid) from public, anon;
grant  execute on function public.emitir_nota(int,text,text,text,text,numeric,uuid) to authenticated;
