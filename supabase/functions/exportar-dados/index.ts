// =============================================================================
// ZelAuto — Edge Function `exportar-dados` (seção 9 de docs/backend.md)
//
// "Os dados são do lojista e saem quando ele quiser." Gera um .zip com um CSV
// por tabela da loja e devolve URL assinada de 24h. Só o PROPRIETÁRIO exporta
// (é um dump completo, inclui custo). Roda com service_role, escopado à loja do
// chamador (isolamento).
//
// Deploy:  supabase functions deploy exportar-dados
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { zipSync, strToU8 } from 'https://esm.sh/fflate@0.8.2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Tabelas de negócio com loja_id (seção 2). Uma vira um CSV.
const TABELAS = [
  'veiculos', 'veiculo_custos', 'clientes', 'interacoes', 'vendas', 'despesas',
  'consignacoes', 'carne_contratos', 'carne_parcelas', 'contratos',
  'notas_fiscais', 'portais', 'anuncios', 'perfis',
];

function paraCsv(rows: any[]): string {
  if (!rows || !rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    if (v == null) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  const head = cols.join(',');
  const body = rows.map((r) => cols.map((c) => esc(r[c])).join(',')).join('\n');
  return head + '\n' + body + '\n';
}

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
    .from('perfis').select('loja_id, papel, ativo').eq('id', user.id).single();
  if (cErr || !caller) return json({ error: 'perfil não encontrado' }, 403);
  if (!caller.ativo || caller.papel !== 'proprietario')
    return json({ error: 'só o proprietário pode exportar os dados da loja' }, 403);

  // um CSV por tabela, sempre da loja do chamador
  const arquivos: Record<string, Uint8Array> = {};
  for (const t of TABELAS) {
    const { data, error } = await admin.from(t).select('*').eq('loja_id', caller.loja_id);
    if (error) continue;   // tabela ausente/sem loja_id não derruba o export
    arquivos[`${t}.csv`] = strToU8(paraCsv(data || []));
  }
  // um resumo no topo do zip
  arquivos['_leia-me.txt'] = strToU8(
    `Exportação ZelAuto\nLoja: ${caller.loja_id}\nGerado em: ${new Date().toISOString()}\n` +
    `Tabelas: ${Object.keys(arquivos).filter((n) => n.endsWith('.csv')).join(', ')}\n`,
  );

  const zipped = zipSync(arquivos, { level: 6 });

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const path = `${caller.loja_id}/${ts}.zip`;
  const { error: upErr } = await admin.storage.from('exportacoes')
    .upload(path, zipped, { contentType: 'application/zip', upsert: true });
  if (upErr) return json({ error: 'falha ao gravar o arquivo: ' + upErr.message }, 400);

  const { data: assinada, error: sErr } = await admin.storage.from('exportacoes')
    .createSignedUrl(path, 60 * 60 * 24);   // 24h
  if (sErr || !assinada) return json({ error: 'falha ao gerar o link: ' + (sErr?.message || '') }, 400);

  return json({ ok: true, url: assinada.signedUrl, arquivo: `${ts}.zip` });
});
