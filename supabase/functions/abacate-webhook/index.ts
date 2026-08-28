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

  // acha a loja dona desta cobrança (guardada quando a cobrança foi gerada)
  const { data: assin } = await admin
    .from('assinaturas').select('loja_id, vence_em').eq('cobranca_id', cobrancaId).single();
  if (!assin) return json({ ok: true, semLoja: true });   // cobrança que não é nossa/estranha: ignora

  // idempotência: registra o pagamento; se já existia (mesmo cobranca_id), não renova de novo
  const { data: novoPg, error: pgErr } = await admin.from('pagamentos')
    .insert({ loja_id: assin.loja_id, cobranca_id: cobrancaId, valor_centavos: valor,
      metodo, status: 'pago', pago_em: new Date().toISOString(), payload: evt })
    .select('id').maybeSingle();
  if (pgErr && !String(pgErr.message || '').includes('duplicate')) {
    return json({ error: 'falha ao registrar pagamento: ' + pgErr.message }, 400);
  }
  if (!novoPg) return json({ ok: true, jaProcessado: true });   // webhook repetido

  // renova a assinatura: paga-até = max(vence_em atual, hoje) + PERIODO_DIAS
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  const base = assin.vence_em ? new Date(assin.vence_em + 'T00:00:00') : hoje;
  const inicio = base > hoje ? base : hoje;
  inicio.setDate(inicio.getDate() + PERIODO_DIAS);
  const venceEm = inicio.toISOString().slice(0, 10);

  await admin.from('assinaturas').update({
    status: 'ativa', vence_em: venceEm, atualizado_em: new Date().toISOString(),
  }).eq('loja_id', assin.loja_id);

  return json({ ok: true, loja_id: assin.loja_id, vence_em: venceEm });
});
