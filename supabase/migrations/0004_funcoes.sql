-- =============================================================================
-- ZelAuto — 0004_funcoes.sql
-- Função de provisionamento de loja (seção 5.1 de docs/backend.md).
--
-- app.criar_loja: cria a loja e todo o esqueleto que uma loja precisa para não
-- abrir em branco — config_fiscal, numeração fiscal, os 4 portais e as duas
-- despesas fixas padrão (zeradas, para o lojista preencher).
--
-- security definer: roda como o dono da função (postgres), que ignora RLS —
-- necessário porque no momento de criar a loja ainda não há loja_id no token.
-- Só service_role chama (via Edge Function). NUNCA exposta ao navegador.
--
-- Guarda de duplicidade: a tabela lojas não tem unique em cnpj; a função
-- recusa criar se já existir loja com o mesmo CNPJ, para não duplicar sem querer.
-- =============================================================================

create or replace function app.criar_loja(
  p_nome text, p_cnpj text, p_cidade text, p_uf char(2),
  p_email_dono text, p_nome_dono text
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_loja uuid;
begin
  -- falha limpo se o CNPJ já existir (evita loja duplicada)
  if p_cnpj is not null
     and exists (select 1 from public.lojas where cnpj = p_cnpj) then
    raise exception 'Já existe uma loja com o CNPJ %', p_cnpj
      using errcode = 'unique_violation';
  end if;

  insert into public.lojas (nome, cnpj, cidade, uf)
  values (p_nome, p_cnpj, p_cidade, p_uf)
  returning id into v_loja;

  insert into public.config_fiscal (loja_id, cnpj) values (v_loja, p_cnpj);
  insert into public.numeracao_fiscal (loja_id, serie, proximo) values (v_loja, 1, 1);

  insert into public.portais (loja_id, portal, ativo)
  select v_loja, p, false
    from unnest(array['Webmotors','OLX','iCarros','Mercado Livre']) p;

  insert into public.despesas (loja_id, categoria, descricao, valor, tipo)
  values (v_loja,'Aluguel','Aluguel da loja',0,'fixa'),
         (v_loja,'Pessoal','Folha da equipe',0,'fixa');

  return v_loja;
end;
$$;

-- Só service_role executa. Fecha para navegador (anon/authenticated) e público.
revoke execute on function app.criar_loja(text,text,text,char,text,text)
  from anon, authenticated, public;
grant  execute on function app.criar_loja(text,text,text,char,text,text)
  to service_role;
