-- =============================================================================
-- 0021 — registrar_pagamento: confirmação de pagamento ATÔMICA e idempotente
--
-- Corrige o webhook (0020): a loja era achada pelo `cobranca_id` guardado na
-- ÚNICA linha de assinatura, que cada nova cobrança sobrescrevia — pagar uma
-- cobrança antiga "sumia". Agora cada cobrança vira uma linha em `pagamentos`
-- (pendente) na hora de gerar, e a confirmação acha a loja por ali.
--
-- Tudo numa transação (uma função): acha a loja, checa idempotência (já pago?),
-- renova a assinatura e marca o pagamento — sem janela para perder a renovação.
-- vence_em é calculado em `date` (sem fuso). SECURITY DEFINER: só o servidor
-- (service_role, via webhook) chama.
-- =============================================================================

create or replace function public.registrar_pagamento(
  p_cobranca_id text, p_valor int, p_metodo text, p_payload jsonb, p_dias int
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_loja  uuid;
  v_ja    boolean;
  v_base  date;
  v_vence date;
begin
  if coalesce(p_cobranca_id,'') = '' then return jsonb_build_object('ok', true, 'semId', true); end if;

  -- acha a loja desta cobrança (linha criada quando a cobrança foi gerada);
  -- fallback na assinatura (compatibilidade).
  select loja_id into v_loja from public.pagamentos where cobranca_id = p_cobranca_id limit 1;
  if v_loja is null then
    select loja_id into v_loja from public.assinaturas where cobranca_id = p_cobranca_id;
  end if;
  if v_loja is null then return jsonb_build_object('ok', true, 'semLoja', true); end if;

  -- idempotência: já existe pagamento 'pago' para esta cobrança?
  select exists(select 1 from public.pagamentos where cobranca_id = p_cobranca_id and status = 'pago')
    into v_ja;
  if v_ja then return jsonb_build_object('ok', true, 'jaProcessado', true); end if;

  -- renova a assinatura (paga-até = max(vence_em, hoje) + dias)
  select vence_em into v_base from public.assinaturas where loja_id = v_loja;
  v_vence := greatest(coalesce(v_base, current_date), current_date) + coalesce(p_dias, 30);
  update public.assinaturas
     set status = 'ativa', vence_em = v_vence, atualizado_em = now()
   where loja_id = v_loja;

  -- marca o pagamento como pago (atualiza a linha pendente; se não houver, cria)
  update public.pagamentos
     set status = 'pago', pago_em = now(), valor_centavos = coalesce(p_valor,0),
         metodo = coalesce(p_metodo, metodo), payload = p_payload
   where cobranca_id = p_cobranca_id and status <> 'pago';
  if not found then
    insert into public.pagamentos (loja_id, cobranca_id, valor_centavos, metodo, status, pago_em, payload)
    values (v_loja, p_cobranca_id, coalesce(p_valor,0), coalesce(p_metodo,'pix'), 'pago', now(), p_payload);
  end if;

  return jsonb_build_object('ok', true, 'loja_id', v_loja, 'vence_em', v_vence);
end $$;

revoke execute on function public.registrar_pagamento(text,int,text,jsonb,int) from public, anon, authenticated;
grant  execute on function public.registrar_pagamento(text,int,text,jsonb,int) to service_role;
