// =============================================================================
// ZelAuto — Edge Function `abacate-webhook` (confirmação de pagamento)
//
// A AbacatePay chama esta URL quando um pagamento acontece. É ela — e SÓ ela —
// que libera/renova a assinatura. O cliente nunca marca "pago".
//
// Segurança: a URL cadastrada no painel da AbacatePay inclui ?webhookSecret=<seg>.
// Aqui conferimos que o segredo bate com ABACATE_WEBHOOK_SECRET. Sem isso, 401.
//
// Idempotente: cada cobrança (cobranca_id) só renova a assinatura UMA vez, mesmo
// que o webhook chegue repetido (índice único em pagamentos.cobranca_id).
//
// Segredos: ABACATE_WEBHOOK_SECRET.
// config.toml: verify_jwt = false (é público; a defesa é o segredo na URL).
// Deploy:  supabase functions deploy abacate-webhook
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const eq = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};
const PERIODO_DIAS = Number(Deno.env.get('ZELAUTO_PLANO_DIAS') || '30');

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'método não permitido' }, 405);

  const segredo = Deno.env.get('ABACATE_WEBHOOK_SECRET') || '';
  const url = new URL(req.url);
  const recebido = url.searchParams.get('webhookSecret') || req.headers.get('x-webhook-secret') || '';
  if (!segredo || !eq(recebido, segredo)) return json({ error: 'não autorizado' }, 401);

  const evt = await req.json().catch(() => null);
  if (!evt) return json({ error: 'payload inválido' }, 400);

  // extrai o essencial de forma resiliente (o payload varia por tipo de evento)
  const d = evt.data || {};
  const charge = d.pixQrCode || d.billing || d.transparent || d;
  const cobrancaId: string | null = charge?.id || d.id || null;
  const statusProv = String(charge?.status || d.status || evt.status || '').toUpperCase();
  const valor = Number(charge?.amount || d.amount || 0) || 0;
  const metodo = (charge?.kind || charge?.method || d.method || '').toString().toLowerCase().includes('card') ? 'cartao' : 'pix';
  const evento = String(evt.event || '').toLowerCase();

  const pago = statusProv === 'PAID' || evento.includes('paid');
  if (!pago || !cobrancaId) return json({ ok: true, ignorado: true });   // evento não-pagamento: ok, ignora

  const URLBASE = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(URLBASE, SERVICE);

  // Tudo numa transação (função): acha a loja pela cobrança, checa idempotência,
  // renova a assinatura e marca o pagamento. Sem janela para perder a renovação.
  const { data, error } = await admin.rpc('registrar_pagamento', {
    p_cobranca_id: cobrancaId, p_valor: valor, p_metodo: metodo,
    p_payload: evt, p_dias: PERIODO_DIAS,
  });
  if (error) return json({ error: 'falha ao registrar pagamento: ' + error.message }, 400);
  return json(data || { ok: true });
});
