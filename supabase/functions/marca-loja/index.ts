// =============================================================================
// ZelAuto — Edge Function `marca-loja` (seção 5.7 de docs/backend.md)
//
// PÚBLICA (anon). Recebe UM slug exato e devolve só a MARCA de uma loja ativa:
// { nome, logo_url, cor }. Não lista lojas — sem diretório público, para
// concorrente não enumerar clientes. É a primeira superfície anônima do sistema;
// devolve só campos de marca, nada sensível. O slug é marca/rota, nunca acesso.
//
// Deploy:  supabase functions deploy marca-loja
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'método não permitido' }, 405);

  const URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'corpo inválido' }, 400); }

  const slug = String(body.slug || '').trim().toLowerCase();
  if (!slug || !SLUG_RE.test(slug)) return json({ error: 'slug inválido' }, 400);

  const admin = createClient(URL, SERVICE);
  // Só campos de marca, uma loja ativa, por slug EXATO. Nunca lista.
  const { data, error } = await admin
    .from('lojas').select('nome, logo_url, cor')
    .eq('slug', slug).eq('ativa', true).maybeSingle();
  if (error) return json({ error: 'falha ao buscar a marca' }, 400);
  if (!data) return json({ error: 'loja não encontrada' }, 404);

  return json({ nome: data.nome, logo_url: data.logo_url || null, cor: data.cor || null });
});
