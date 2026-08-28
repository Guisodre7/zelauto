// =============================================================================
// ZelAuto — Edge Function `cobranca` (assinatura da loja via AbacatePay)
//
// O PROPRIETÁRIO gera a cobrança do plano. Aqui, server-side, porque a chave da
// AbacatePay é segredo (nunca no navegador). Ações:
//   - 'pix'    : cria uma cobrança PIX transparente e devolve o copia-e-cola
//                (brCode) + QR em base64 (brCodeBase64) para pagar na hora.
//   - 'status' : consulta a cobrança PIX atual no provedor.
//   - 'cartao' : cria um checkout hospedado (cartão) e devolve a URL.
// Quem CONFIRMA o pagamento e libera a assinatura é o webhook (abacate-webhook),
// a partir do evento real do provedor — nunca o cliente.
//
// Segredos (supabase secrets set ...): ABACATE_API_KEY, e opcionalmente
// ABACATE_BASE (default https://api.abacatepay.com/v2), ZELAUTO_PLANO_VALOR
// (centavos, default 9900), ZELAUTO_PLANO_NOME, APP_URL.
//
// Deploy:  supabase functions deploy cobranca
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const ABACATE_BASE = Deno.env.get('ABACATE_BASE') || 'https://api.abacatepay.com/v2';
const PLANO_VALOR = Number(Deno.env.get('ZELAUTO_PLANO_VALOR') || '9900');   // centavos
const PLANO_NOME = Deno.env.get('ZELAUTO_PLANO_NOME') || 'ZelAuto — mensalidade';

async function abacate(path: string, method: string, key: string, body?: unknown) {
  const r = await fetch(`${ABACATE_BASE}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let data: any = null;
  try { data = txt ? JSON.parse(txt) : null; } catch { data = { raw: txt }; }
  return { ok: r.ok, status: r.status, data };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'método não permitido' }, 405);

  const URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;
  const KEY = Deno.env.get('ABACATE_API_KEY');
  if (!KEY) return json({ error: 'cobrança não configurada (falta ABACATE_API_KEY)' }, 503);

  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) return json({ error: 'sem autenticação' }, 401);

  const userClient = createClient(URL, ANON, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: uErr } = await userClient.auth.getUser();
  if (uErr || !user) return json({ error: 'sessão inválida' }, 401);

  const admin = createClient(URL, SERVICE);
  const { data: caller, error: cErr } = await admin
    .from('perfis').select('loja_id, papel, nome, ativo').eq('id', user.id).single();
  if (cErr || !caller) return json({ error: 'perfil não encontrado' }, 403);
  if (!caller.ativo) return json({ error: 'perfil inativo' }, 403);
  if (caller.papel !== 'proprietario') return json({ error: 'só o proprietário gerencia o plano' }, 403);

  const body = await req.json().catch(() => ({}));
  const acao = body.acao || 'pix';
  const lojaId = caller.loja_id;

  // dados da loja para o cliente da cobrança
  const { data: loja } = await admin.from('lojas').select('nome, cnpj, telefone, config').eq('id', lojaId).single();
  const razao = (loja?.config?.razao_social) || loja?.nome || 'Loja ZelAuto';

  // ---- PIX transparente (copia-e-cola + QR) -----------------------------
  if (acao === 'pix') {
    const r = await abacate('/transparents/create', 'POST', KEY, {
      amount: PLANO_VALOR,
      expiresIn: 3600,                     // 1h para pagar
      description: `${PLANO_NOME} — ${razao}`,
      customer: {
        name: razao,
        taxId: loja?.cnpj || undefined,
        cellphone: loja?.telefone || undefined,
      },
    });
    const d = r.data?.data || r.data || {};
    if (!r.ok || !d.brCode) return json({ error: (r.data?.error || r.data?.message || 'falha ao gerar PIX') }, 400);

    // guarda o id/brcode na assinatura (sem mudar o status — quem muda é o webhook)
    await admin.from('assinaturas').upsert({
      loja_id: lojaId, plano: 'padrao', valor_centavos: PLANO_VALOR,
      provedor: 'abacatepay', cobranca_id: d.id || null, brcode: d.brCode || null,
      atualizado_em: new Date().toISOString(),
    }, { onConflict: 'loja_id' });

    return json({ ok: true, id: d.id, brCode: d.brCode, brCodeBase64: d.brCodeBase64, expiresAt: d.expiresAt });
  }

  // ---- status da cobrança PIX atual -------------------------------------
  if (acao === 'status') {
    const { data: a } = await admin.from('assinaturas').select('cobranca_id, status, vence_em').eq('loja_id', lojaId).single();
    if (!a?.cobranca_id) return json({ ok: true, status: a?.status || 'trial', vence_em: a?.vence_em || null, pago: false });
    const r = await abacate(`/transparents/${encodeURIComponent(a.cobranca_id)}`, 'GET', KEY);
    const d = r.data?.data || r.data || {};
    const pago = String(d.status || '').toUpperCase() === 'PAID';
    return json({ ok: true, status: a.status, vence_em: a.vence_em, pago, provedorStatus: d.status || null });
  }

  // ---- checkout hospedado (cartão) --------------------------------------
  if (acao === 'cartao') {
    const APP = Deno.env.get('APP_URL') || '';
    const r = await abacate('/checkouts/create', 'POST', KEY, {
      frequency: 'ONE_TIME',
      methods: ['CARD'],
      products: [{ externalId: `plano-${lojaId}`, name: PLANO_NOME, quantity: 1, price: PLANO_VALOR }],
      returnUrl: APP || undefined,
      completionUrl: APP || undefined,
      customer: { name: razao, taxId: loja?.cnpj || undefined, cellphone: loja?.telefone || undefined },
    });
    const d = r.data?.data || r.data || {};
    if (!r.ok || !d.url) return json({ error: (r.data?.error || r.data?.message || 'falha ao criar checkout') }, 400);
    await admin.from('assinaturas').upsert({
      loja_id: lojaId, plano: 'padrao', valor_centavos: PLANO_VALOR, provedor: 'abacatepay',
      cobranca_id: d.id || null, atualizado_em: new Date().toISOString(),
    }, { onConflict: 'loja_id' });
    return json({ ok: true, url: d.url, id: d.id });
  }

  return json({ error: 'ação desconhecida' }, 400);
});
