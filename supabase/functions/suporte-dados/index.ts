// =============================================================================
// ZelAuto — Edge Function `suporte-dados` (Console do Operador · Fase 1)
//
// A PORTA. O operador em modo suporte NÃO acessa o banco como o lojista: ele
// pede os dados aqui. Esta função valida (service_role) que existe uma SESSÃO
// DE SUPORTE ATIVA (não encerrada, não expirada) daquele operador para aquela
// loja e só então devolve os dados — SÓ LEITURA, presos ao loja_id da sessão.
//
// Por segurança, NÃO devolve custo de compra, margem nem retorno de banco: para
// dar instrução ao lojista basta ver o painel, não os números de compra.
//
// Cada leitura fica em operador_log (auditoria do "o que viu").
//
// Deploy: supabase functions deploy suporte-dados
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

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
  const { data: op } = await admin.from('operadores').select('id, nome').eq('id', user.id).maybeSingle();
  if (!op) return json({ error: 'acesso restrito ao operador ZelAuto' }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'corpo inválido' }, 400); }

  const sessaoId = String(body.sessao_id || '');
  if (!sessaoId) return json({ error: 'informe a sessão de suporte' }, 400);

  // GATE: sessão precisa existir, ser deste operador, não encerrada e não expirada.
  const nowIso = new Date().toISOString();
  const { data: sess } = await admin.from('suporte_sessoes')
    .select('id, loja_id, expira_em, encerrada_em, operador_id')
    .eq('id', sessaoId).eq('operador_id', op.id).is('encerrada_em', null).gt('expira_em', nowIso)
    .maybeSingle();
  if (!sess) return json({ error: 'sessão de suporte inválida ou expirada' }, 403);

  const loja = sess.loja_id;

  // Só-leitura, preso ao loja_id da sessão. Sem colunas de custo/margem.
  const [lojaInfo, veiculos, clientes, vendas, despesas] = await Promise.all([
    admin.from('lojas').select('nome, slug, cidade, uf').eq('id', loja).maybeSingle(),
    admin.from('veiculos').select('id, marca, modelo, ano_fab, ano_mod, km, placa, cor, alvo, status, renave_fase, entrada_em')
      .eq('loja_id', loja).order('entrada_em', { ascending: false }).limit(300),
    admin.from('clientes').select('id, nome, telefone, origem, etapa, interesse, proximo_contato, criado_em')
      .eq('loja_id', loja).order('criado_em', { ascending: false }).limit(300),
    admin.from('vendas').select('id, descricao, cliente_nome, placa, valor, forma, data')
      .eq('loja_id', loja).order('data', { ascending: false }).limit(100),
    admin.from('despesas').select('id, categoria, descricao, valor, tipo, competencia')
      .eq('loja_id', loja).order('competencia', { ascending: false }).limit(100),
  ]);

  admin.from('operador_log').insert({
    operador_id: op.id, acao: 'suporte_ver', loja_id: loja,
    detalhe: { sessao_id: sessaoId },
  });

  return json({
    ok: true,
    expira_em: sess.expira_em,
    loja: lojaInfo.data || null,
    veiculos: veiculos.data || [],
    clientes: clientes.data || [],
    vendas: vendas.data || [],
    despesas: despesas.data || [],
  });
});
