// =============================================================================
// ZelAuto — Edge Function `vender` (seção 5.6 de docs/backend.md)
//
// Grava a venda no servidor, congelando o CUSTO real do veículo (compra +
// preparação) no momento da venda. Necessário porque o custo foi tirado do
// acesso do vendedor (0009/0010): ele não conseguiria calcular custo_total no
// cliente. Também marca o veículo como vendido — os dois passos num lugar só,
// sem meio-estado.
//
// Autorização: qualquer perfil ativo da loja pode registrar uma venda (o
// vendedor fecha o negócio). A loja e o vendedor saem do JWT, nunca do corpo.
//
// Deploy:  supabase functions deploy vender
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const FORMAS = ['avista', 'financiamento', 'consorcio', 'carne', 'troca'];
const numero = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'método não permitido' }, 405);

  const URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;

  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) return json({ error: 'sem autenticação' }, 401);

  const userClient = createClient(URL, ANON, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: uErr } = await userClient.auth.getUser();
  if (uErr || !user) return json({ error: 'sessão inválida' }, 401);

  const admin = createClient(URL, SERVICE);
  const { data: caller, error: cErr } = await admin
    .from('perfis').select('loja_id, ativo').eq('id', user.id).single();
  if (cErr || !caller) return json({ error: 'perfil não encontrado' }, 403);
  if (!caller.ativo) return json({ error: 'perfil inativo' }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'corpo inválido' }, 400); }

  const veiculoId = body.veiculoId || null;
  const valor = numero(body.valor);
  const forma = FORMAS.includes(body.forma) ? body.forma : 'avista';
  if (!valor || valor <= 0) return json({ error: 'informe o valor da venda' }, 400);

  // custo_total congelado: compra + preparação do veículo, lidos com service_role.
  // O veículo precisa ser da MESMA loja do chamador (isolamento).
  let custoTotal = 0;
  let descricao = String(body.descricao || 'Venda');
  let placa = body.placa ? String(body.placa) : null;
  if (veiculoId) {
    const { data: v, error: vErr } = await admin
      .from('veiculos').select('id, marca, modelo, ano_fab, placa, compra, loja_id')
      .eq('id', veiculoId).single();
    if (vErr || !v) return json({ error: 'veículo não encontrado' }, 404);
    if (v.loja_id !== caller.loja_id) return json({ error: 'veículo de outra loja' }, 403);
    const { data: custos } = await admin
      .from('veiculo_custos').select('valor')
      .eq('veiculo_id', v.id).eq('categoria', 'preparacao');
    const prep = (custos || []).reduce((s: number, c: any) => s + numero(c.valor), 0);
    custoTotal = numero(v.compra) + prep;
    if (!body.descricao) descricao = `${v.marca} ${v.modelo} ${String(v.ano_fab || '').slice(0, 4)}`.trim();
    if (!placa) placa = v.placa || null;
  }

  const { data: venda, error: iErr } = await admin.from('vendas').insert({
    loja_id: caller.loja_id,
    veiculo_id: veiculoId,
    cliente_id: body.clienteId || null,
    cliente_nome: body.clienteNome || null,
    descricao, placa,
    custo_total: custoTotal,
    valor,
    forma,
    comissao: numero(body.comissao),
    retorno_banco: numero(body.retornoBanco),
    vendedor_id: user.id,
    dias_patio: body.diasPatio != null ? Math.trunc(numero(body.diasPatio)) : null,
    data: body.data || undefined,
  }).select('id').single();
  if (iErr) return json({ error: 'falha ao registrar a venda: ' + iErr.message }, 400);

  // tira o carro do pátio
  if (veiculoId) {
    const { error: upErr } = await admin.from('veiculos').update({ status: 'vendido' }).eq('id', veiculoId);
    if (upErr) return json({ error: 'venda gravada, mas falha ao baixar o veículo: ' + upErr.message }, 400);
  }

  return json({ ok: true, id: venda.id });
});
