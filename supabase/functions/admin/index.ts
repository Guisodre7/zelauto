// =============================================================================
// ZelAuto — Edge Function `admin` (Console do Operador, seção 5.8)
//
// CONTROL PLANE. Só um operador ZelAuto (linha em public.operadores) age aqui.
// Verifica sessão + membership em operadores (service_role) antes de tudo. As
// ações cruzam lojas / provisionam — por isso ficam SÓ aqui, nunca no cliente.
//
// Ações (campo `acao` no corpo):
//   criar_loja  -> cria a loja (nome/slug/cor) + login do dono (senha provisória)
//   metricas    -> KPIs por loja e totais (cross-loja)
//   importar    -> insere estoque/clientes já mapeados numa loja
//
// Deploy:  supabase functions deploy admin
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

// slug: 2 a 40 chars, minúsculas/números/hífen, sem hífen nas pontas (bate com o
// check da 0012; evita passar aqui e falhar no insert com erro cru).
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const MODULOS_TODOS = ['dash','estoque','vendas','crm','renave','nfe','anuncios','vitrine','avaliacao','contratos','despesas','fin','carne','consig','dre','equipe'];

// Número no formato BR ("45.000,00", "45000,00") e US ("45000.00"). CSV do lojista
// vem em pt-BR: ponto de milhar e vírgula decimal. Number() cru zeraria tudo isso.
const num = (v: unknown) => {
  if (v == null) return 0;
  let s = String(v).trim().replace(/[^\d.,-]/g, '');
  if (!s) return 0;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');        // BR: . milhar, , decimal
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');   // 1.234.567 -> milhar
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

function senhaProvisoria(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const a = new Uint32Array(12); crypto.getRandomValues(a);
  return Array.from(a, (n) => abc[n % abc.length]).join('');
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
  // GATE: o chamador precisa ser operador ZelAuto.
  const { data: op } = await admin.from('operadores').select('id, nome').eq('id', user.id).maybeSingle();
  if (!op) return json({ error: 'acesso restrito ao operador ZelAuto' }, 403);

  const log = (acao: string, loja_id: string | null, detalhe: unknown) =>
    admin.from('operador_log').insert({ operador_id: op.id, acao, loja_id, detalhe: detalhe || {} });

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'corpo inválido' }, 400); }
  const acao = body?.acao;

  // ---------------------------------------------------------------- CRIAR LOJA
  if (acao === 'criar_loja') {
    const nome = String(body.nome || '').trim();
    const slug = String(body.slug || '').trim().toLowerCase();
    const cor = body.cor ? String(body.cor).trim() : null;
    const dono = body.dono || {};
    const donoNome = String(dono.nome || '').trim();
    const donoEmail = String(dono.email || '').trim().toLowerCase();

    if (!nome) return json({ error: 'informe o nome da loja' }, 400);
    if (!slug || !SLUG_RE.test(slug)) return json({ error: 'slug inválido (minúsculas, números e hífen)' }, 400);
    if (cor && !/^#?[0-9a-fA-F]{6}$/.test(cor)) return json({ error: 'cor inválida (use #RRGGBB)' }, 400);
    if (!donoNome) return json({ error: 'informe o nome do dono' }, 400);
    if (!donoEmail || !donoEmail.includes('@')) return json({ error: 'informe um e-mail válido para o dono' }, 400);

    const { data: jaSlug } = await admin.from('lojas').select('id').eq('slug', slug).maybeSingle();
    if (jaSlug) return json({ error: 'esse endereço (slug) já está em uso' }, 409);

    const { data: loja, error: lErr } = await admin.from('lojas')
      .insert({ nome, slug, cor: cor ? (cor[0] === '#' ? cor : '#' + cor) : null, ativa: true })
      .select('id').single();
    if (lErr) return json({ error: 'falha ao criar a loja: ' + lErr.message }, 400);

    const senha = senhaProvisoria();
    const { data: novo, error: aErr } = await admin.auth.admin.createUser({
      email: donoEmail, password: senha, email_confirm: true,
    });
    if (aErr || !novo?.user) {
      await admin.from('lojas').delete().eq('id', loja.id);   // desfaz a loja órfã
      const msg = /already|registered|exists/i.test(aErr?.message || '') ? 'já existe um usuário com esse e-mail' : (aErr?.message || 'falha ao criar o login do dono');
      return json({ error: msg }, 400);
    }

    const { error: pErr } = await admin.from('perfis').insert({
      id: novo.user.id, loja_id: loja.id, nome: donoNome,
      papel: 'proprietario', modulos: MODULOS_TODOS, ver_custos: true, ver_lucro: true, ativo: true,
    });
    if (pErr) {
      await admin.auth.admin.deleteUser(novo.user.id);
      await admin.from('lojas').delete().eq('id', loja.id);
      return json({ error: 'falha ao criar o perfil do dono: ' + pErr.message }, 400);
    }

    await log('criar_loja', loja.id, { slug, dono_email: donoEmail });
    return json({ ok: true, loja_id: loja.id, slug, email: donoEmail, senha });
  }

  // ------------------------------------------------------------------ MÉTRICAS
  if (acao === 'metricas') {
    const { data: lojas } = await admin.from('lojas')
      .select('id, nome, slug, ativa, criado_em').order('criado_em', { ascending: true });
    // contagem EXATA por loja (head:true count — não sofre o teto de 1000 linhas
    // que um select cru sofreria). Poucas lojas -> poucas queries; escala linear.
    const contar = async (t: string, lojaId: string) => {
      const { count } = await admin.from(t).select('id', { count: 'exact', head: true }).eq('loja_id', lojaId);
      return count || 0;
    };
    const linhas = [];
    for (const l of (lojas || []) as any[]) {
      const [veiculos, clientes, vendas] = await Promise.all([
        contar('veiculos', l.id), contar('clientes', l.id), contar('vendas', l.id),
      ]);
      linhas.push({ id: l.id, nome: l.nome, slug: l.slug, ativa: l.ativa, criado_em: l.criado_em, veiculos, clientes, vendas });
    }
    const soma = (k: 'veiculos' | 'clientes' | 'vendas') => linhas.reduce((s, x) => s + (x as any)[k], 0);
    return json({ lojas: linhas, totais: { lojas: linhas.length, veiculos: soma('veiculos'), clientes: soma('clientes'), vendas: soma('vendas') } });
  }

  // ------------------------------------------------------------------ IMPORTAR
  if (acao === 'importar') {
    const lojaId = String(body.loja_id || '');
    if (!lojaId) return json({ error: 'informe a loja de destino' }, 400);
    const { data: loja } = await admin.from('lojas').select('id').eq('id', lojaId).maybeSingle();
    if (!loja) return json({ error: 'loja não encontrada' }, 404);

    let nVeic = 0, nCli = 0, veicPulados = 0;
    const veiculos = Array.isArray(body.veiculos) ? body.veiculos : [];
    const clientes = Array.isArray(body.clientes) ? body.clientes : [];

    if (veiculos.length) {
      const rows = veiculos.slice(0, 5000).map((v: any) => ({
        loja_id: lojaId,
        marca: String(v.marca || '').trim() || 'Sem marca',
        modelo: String(v.modelo || '').trim() || 'Sem modelo',
        ano_fab: v.ano ? parseInt(String(v.ano).slice(0, 4), 10) || null : null,
        km: v.km != null ? Math.trunc(num(v.km)) : null,
        placa: v.placa ? String(v.placa).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || null : null,
        cor: v.cor ? String(v.cor) : null,
        compra: num(v.compra),
        alvo: num(v.alvo),
        entrada_em: v.entrada || undefined,
        status: 'estoque',
      }));
      // placa é única por loja: dedup dentro do CSV + pula as que já existem, para
      // uma placa repetida não abortar o lote inteiro. Sem placa entra sempre.
      const semPlaca = rows.filter((r) => !r.placa);
      const vistos = new Set<string>();
      const comPlaca = rows.filter((r) => r.placa && !vistos.has(r.placa!) && vistos.add(r.placa!));
      const existentes = new Set<string>();
      if (comPlaca.length) {
        const { data: ex } = await admin.from('veiculos').select('placa')
          .eq('loja_id', lojaId).in('placa', comPlaca.map((r) => r.placa));
        for (const x of ex || []) existentes.add((x as any).placa);
      }
      const finais = [...semPlaca, ...comPlaca.filter((r) => !existentes.has(r.placa!))];
      veicPulados = rows.length - finais.length;
      if (finais.length) {
        const { error } = await admin.from('veiculos').insert(finais);
        if (error) return json({ error: 'falha ao importar estoque: ' + error.message }, 400);
      }
      nVeic = finais.length;
    }
    if (clientes.length) {
      const rows = clientes.slice(0, 5000).map((c: any) => ({
        loja_id: lojaId,
        nome: String(c.nome || '').trim() || 'Sem nome',
        telefone: c.telefone ? String(c.telefone) : null,
        origem: c.origem ? String(c.origem) : 'outro',
        etapa: 'novo',
        interesse: c.interesse ? String(c.interesse) : null,
        orcamento: c.orcamento != null ? num(c.orcamento) : null,
      }));
      const { error } = await admin.from('clientes').insert(rows);
      if (error) return json({ error: 'falha ao importar clientes: ' + error.message }, 400);
      nCli = rows.length;
    }

    await log('importar', lojaId, { veiculos: nVeic, clientes: nCli, veiculos_pulados: veicPulados });
    return json({ ok: true, veiculos: nVeic, clientes: nCli, veiculos_pulados: veicPulados });
  }

  return json({ error: 'ação desconhecida' }, 400);
});
