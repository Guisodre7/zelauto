// =============================================================================
// ZelAuto — Edge Function `custos` (seção 5.5 de docs/backend.md)
//
// Devolve o CUSTO dos veículos (compra + preparação) SÓ para quem pode ver:
// perfil com ver_custos = true, ou papel proprietario/gerente. A leitura dessas
// colunas foi tirada do acesso via API na migration 0009 — então some para todo
// authenticated no cliente e volta só por aqui, com service_role, depois da
// checagem do perfil. Escopo sempre a loja do chamador (isolamento).
//
// Deploy:  supabase functions deploy custos
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

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
  // O token de suporte é gerente, mas não é a loja: o papel 'gerente' liberaria
  // custo de compra e margem aqui, apagando o `ver_custos:false` do perfil.
  // Suporte enxerga a operação; o dinheiro da loja é do lojista.
  if ((user.app_metadata as any)?.suporte === true)
    return json({ error: 'o acesso de suporte não vê custo de compra nem margem' }, 403);

  const { data: caller, error: cErr } = await admin
    .from('perfis').select('loja_id, papel, ver_custos, ver_lucro, ativo').eq('id', user.id).single();
  if (cErr || !caller) return json({ error: 'perfil não encontrado' }, 403);
  if (!caller.ativo) return json({ error: 'perfil inativo' }, 403);

  // Sem permissão → mapas vazios (não é erro; o front segue sem custo).
  // ver_lucro TAMBÉM libera o custo: o lucro não fecha sem o custo (e revelaria
  // o custo de qualquer jeito, valor − lucro). Então quem vê lucro precisa do custo.
  const pode = caller.ver_custos === true || caller.ver_lucro === true
    || ['proprietario', 'gerente'].includes(caller.papel);
  if (!pode) return json({ custos: {}, vendas: {} });

  // compra por veículo + preparação somada, sempre da loja do chamador.
  const { data: veic, error: vErr } = await admin
    .from('veiculos').select('id, compra').eq('loja_id', caller.loja_id);
  if (vErr) return json({ error: 'falha ao ler veículos: ' + vErr.message }, 400);

  const { data: custos, error: kErr } = await admin
    .from('veiculo_custos').select('veiculo_id, valor')
    .eq('loja_id', caller.loja_id).eq('categoria', 'preparacao');
  if (kErr) return json({ error: 'falha ao ler custos: ' + kErr.message }, 400);

  const prep: Record<string, number> = {};
  for (const c of custos || []) prep[c.veiculo_id] = (prep[c.veiculo_id] || 0) + Number(c.valor);

  const mapa: Record<string, { compra: number; prep: number }> = {};
  for (const v of veic || []) mapa[v.id] = { compra: Number(v.compra) || 0, prep: prep[v.id] || 0 };

  // custo congelado das vendas (vendas.custo_total também saiu do SELECT — 0010)
  const { data: vend, error: sErr } = await admin
    .from('vendas').select('id, custo_total').eq('loja_id', caller.loja_id);
  if (sErr) return json({ error: 'falha ao ler custo de vendas: ' + sErr.message }, 400);
  const vendas: Record<string, number> = {};
  for (const s of vend || []) vendas[s.id] = Number(s.custo_total) || 0;

  return json({ custos: mapa, vendas });
});
