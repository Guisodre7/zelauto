// =============================================================================
// ZelAuto — Edge Function `equipe` (seção 5.4 de docs/backend.md)
//
// Gestão de time pelo próprio lojista, SEM sair do navegador para o painel/CLI.
// Roda com service_role (só aqui, nunca no front). Confere quem chamou pelo JWT
// e só então cria membros / altera permissões — porque papel, modulos,
// ver_custos, ver_lucro e a criação de login no Auth não podem sair do cliente
// (§3.4), senão um vendedor se promoveria.
//
// Autorização: o chamador precisa estar ativo e ser proprietario ou gerente.
// A loja alvo é SEMPRE a do chamador. Gerente tem teto: não cria/promove
// proprietario nem altera um proprietario.
//
// Deploy:  supabase functions deploy equipe
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const PAPEIS = ['proprietario', 'gerente', 'vendedor', 'administrativo'];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

// Senha provisória legível (sem 0/O/1/l/I) — fácil de ditar ao funcionário.
function senhaProvisoria(): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const arr = new Uint32Array(12);
  crypto.getRandomValues(arr);
  return Array.from(arr, (n) => abc[n % abc.length]).join('');
}

const limpaModulos = (m: unknown) =>
  Array.isArray(m) ? m.filter((x) => typeof x === 'string').slice(0, 40) : [];
const papelValido = (p: unknown) => typeof p === 'string' && PAPEIS.includes(p);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'método não permitido' }, 405);

  const URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;

  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) return json({ error: 'sem autenticação' }, 401);

  // client escopo-usuário: identifica quem chamou (pelo token da sessão)
  const userClient = createClient(URL, ANON, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: uErr } = await userClient.auth.getUser();
  if (uErr || !user) return json({ error: 'sessão inválida' }, 401);

  // client service_role: operações privilegiadas (bypassa RLS)
  const admin = createClient(URL, SERVICE);

  // perfil do chamador — fonte da verdade de loja e papel (nunca confiar no corpo)
  const { data: caller, error: cErr } = await admin
    .from('perfis').select('loja_id, papel, ativo').eq('id', user.id).single();
  if (cErr || !caller) return json({ error: 'perfil não encontrado' }, 403);
  if (!caller.ativo || !['proprietario', 'gerente'].includes(caller.papel))
    return json({ error: 'sem permissão para gerenciar a equipe' }, 403);

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'corpo inválido' }, 400); }
  const acao = body?.acao;

  // Garante que a loja não fique sem proprietário ativo por uma demissão/rebaixamento.
  async function restariaSemDono(alvoId: string): Promise<boolean> {
    const { count } = await admin.from('perfis')
      .select('id', { count: 'exact', head: true })
      .eq('loja_id', caller.loja_id).eq('papel', 'proprietario').eq('ativo', true)
      .neq('id', alvoId);
    return (count || 0) === 0;
  }

  // ---------------------------------------------------------------- CRIAR
  if (acao === 'criar') {
    const nome = String(body.nome || '').trim();
    const email = String(body.email || '').trim().toLowerCase();
    const telefone = body.telefone ? String(body.telefone).trim() : null;
    const papel = papelValido(body.papel) ? body.papel : 'vendedor';
    const modulos = limpaModulos(body.modulos);
    const ver_custos = !!body.ver_custos;
    const ver_lucro = !!body.ver_lucro;

    if (!nome) return json({ error: 'informe o nome do membro' }, 400);
    if (!email || !email.includes('@')) return json({ error: 'informe um e-mail válido' }, 400);
    if (caller.papel === 'gerente' && papel === 'proprietario')
      return json({ error: 'gerente não pode criar proprietário' }, 403);

    const senha = senhaProvisoria();
    const { data: novo, error: aErr } = await admin.auth.admin.createUser({
      email, password: senha, email_confirm: true,
    });
    if (aErr || !novo?.user) {
      const msg = /already|registered|exists/i.test(aErr?.message || '')
        ? 'já existe um usuário com esse e-mail'
        : (aErr?.message || 'falha ao criar o login');
      return json({ error: msg }, 400);
    }

    const { error: pErr } = await admin.from('perfis').insert({
      id: novo.user.id, loja_id: caller.loja_id, nome, telefone,
      papel, modulos, ver_custos, ver_lucro, ativo: true,
    });
    if (pErr) {
      // desfaz o usuário órfão no Auth se o perfil falhar (evita login sem perfil)
      await admin.auth.admin.deleteUser(novo.user.id);
      return json({ error: 'falha ao criar o perfil: ' + pErr.message }, 400);
    }
    return json({ ok: true, email, senha });
  }

  // ------------------------------------------------------------- ATUALIZAR
  if (acao === 'atualizar') {
    const id = String(body.id || '');
    if (!id) return json({ error: 'id do membro ausente' }, 400);

    const { data: alvo, error: tErr } = await admin
      .from('perfis').select('loja_id, papel, ativo').eq('id', id).single();
    if (tErr || !alvo) return json({ error: 'membro não encontrado' }, 404);
    if (alvo.loja_id !== caller.loja_id) return json({ error: 'membro de outra loja' }, 403);
    if (caller.papel === 'gerente' && alvo.papel === 'proprietario')
      return json({ error: 'gerente não pode alterar um proprietário' }, 403);

    const patch: Record<string, unknown> = {};
    if (typeof body.nome === 'string' && body.nome.trim()) patch.nome = body.nome.trim();
    if ('telefone' in body) patch.telefone = body.telefone ? String(body.telefone).trim() : null;
    if (papelValido(body.papel)) {
      if (caller.papel === 'gerente' && body.papel === 'proprietario')
        return json({ error: 'gerente não pode promover a proprietário' }, 403);
      patch.papel = body.papel;
    }
    if (Array.isArray(body.modulos)) patch.modulos = limpaModulos(body.modulos);
    if ('ver_custos' in body) patch.ver_custos = !!body.ver_custos;
    if ('ver_lucro' in body) patch.ver_lucro = !!body.ver_lucro;
    if ('ativo' in body) patch.ativo = !!body.ativo;

    if (Object.keys(patch).length === 0) return json({ error: 'nada para atualizar' }, 400);

    // trava de segurança: não deixar a loja sem proprietário ativo
    const rebaixa = alvo.papel === 'proprietario' && patch.papel !== undefined && patch.papel !== 'proprietario';
    const desativa = alvo.papel === 'proprietario' && patch.ativo === false;
    if ((rebaixa || desativa) && await restariaSemDono(id))
      return json({ error: 'a loja precisa de ao menos um proprietário ativo' }, 400);

    const { error: upErr } = await admin.from('perfis').update(patch).eq('id', id);
    if (upErr) return json({ error: 'falha ao atualizar: ' + upErr.message }, 400);
    return json({ ok: true });
  }

  return json({ error: 'ação desconhecida' }, 400);
});
