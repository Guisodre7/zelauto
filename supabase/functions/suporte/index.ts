// =============================================================================
// ZelAuto — Edge Function `suporte` (Console do Operador · Fase 1)
//
// CONTROL PLANE de suporte. Só operador ZelAuto age. Abre/fecha sessões de
// acesso ao painel do lojista — SEMPRE com consentimento (autoriza_acesso),
// com prazo (padrão 2h), e tudo registrado em operador_log.
//
// Ações:
//   listar    -> chamados abertos (com a loja) + sessões ativas + não lidas
//   mensagens -> a conversa de um chamado (e marca as do lojista como lidas)
//   responder -> escreve no chamado como Suporte ZelAuto
//   entrar    -> cria a sessão de acesso (exige consentimento + prazo)
//   encerrar  -> fecha uma sessão que este operador abriu
//   resolver  -> marca o chamado como resolvido
//
// Deploy: supabase functions deploy suporte
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const PADRAO_MIN = 120;   // 2h
const MAX_MIN = 480;      // teto de 8h

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

  const log = (acao: string, loja_id: string | null, detalhe: unknown) =>
    admin.from('operador_log').insert({ operador_id: op.id, acao, loja_id, detalhe: detalhe || {} });

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'corpo inválido' }, 400); }
  const acao = body?.acao;

  // ------------------------------------------------------------------- LISTAR
  if (acao === 'listar') {
    const { data: chamados } = await admin.from('suporte_chamados')
      .select('id, loja_id, mensagem, autoriza_acesso, status, criado_em, lojas(nome, slug)')
      .neq('status', 'resolvido').order('criado_em', { ascending: false }).limit(100);
    const nowIso = new Date().toISOString();
    const { data: sessoes } = await admin.from('suporte_sessoes')
      .select('id, loja_id, chamado_id, expira_em, criada_em, lojas(nome)')
      .is('encerrada_em', null).gt('expira_em', nowIso).order('criada_em', { ascending: false });

    // Quantas mensagens do lojista ainda não foram lidas, por chamado — é o que
    // diz onde a resposta está atrasada.
    const ids = (chamados || []).map((c: any) => c.id);
    const naoLidas: Record<string, number> = {};
    if (ids.length) {
      const { data: pend } = await admin.from('suporte_mensagens')
        .select('chamado_id').in('chamado_id', ids)
        .eq('autor', 'lojista').is('lida_operador_em', null);
      for (const m of pend || []) naoLidas[(m as any).chamado_id] = (naoLidas[(m as any).chamado_id] || 0) + 1;
    }
    return json({ chamados: chamados || [], sessoes_ativas: sessoes || [], nao_lidas: naoLidas });
  }

  // ---------------------------------------------------------------- MENSAGENS
  if (acao === 'mensagens') {
    const chamadoId = String(body.chamado_id || '');
    if (!chamadoId) return json({ error: 'informe o chamado' }, 400);
    const { data: msgs } = await admin.from('suporte_mensagens')
      .select('id, autor, autor_nome, texto, criado_em')
      .eq('chamado_id', chamadoId).order('criado_em', { ascending: true }).limit(400);
    // Abrir a conversa é ler: zera o contador do lado do operador.
    await admin.from('suporte_mensagens')
      .update({ lida_operador_em: new Date().toISOString() })
      .eq('chamado_id', chamadoId).eq('autor', 'lojista').is('lida_operador_em', null);
    return json({ mensagens: msgs || [] });
  }

  // ---------------------------------------------------------------- RESPONDER
  if (acao === 'responder') {
    const chamadoId = String(body.chamado_id || '');
    const texto = String(body.texto || '').trim().slice(0, 4000);
    if (!chamadoId) return json({ error: 'informe o chamado' }, 400);
    if (!texto) return json({ error: 'escreva a mensagem' }, 400);

    const { data: ch } = await admin.from('suporte_chamados')
      .select('id, loja_id, status').eq('id', chamadoId).maybeSingle();
    if (!ch) return json({ error: 'chamado não encontrado' }, 404);

    const { error: mErr } = await admin.from('suporte_mensagens').insert({
      chamado_id: ch.id, loja_id: ch.loja_id, autor: 'operador',
      autor_id: op.id, autor_nome: op.nome || 'Suporte ZelAuto', texto,
    });
    if (mErr) return json({ error: 'não consegui enviar: ' + mErr.message }, 400);

    if (ch.status === 'aberto')
      await admin.from('suporte_chamados').update({ status: 'em_atendimento' }).eq('id', ch.id);
    await log('suporte_responder', ch.loja_id, { chamado_id: ch.id });
    return json({ ok: true });
  }

  // ------------------------------------------------------------------- ENTRAR
  if (acao === 'entrar') {
    const chamadoId = String(body.chamado_id || '');
    let minutos = parseInt(String(body.minutos || PADRAO_MIN), 10);
    if (!Number.isFinite(minutos) || minutos <= 0) minutos = PADRAO_MIN;
    minutos = Math.min(minutos, MAX_MIN);
    if (!chamadoId) return json({ error: 'informe o chamado' }, 400);

    const { data: ch } = await admin.from('suporte_chamados')
      .select('id, loja_id, autoriza_acesso, lojas(nome)').eq('id', chamadoId).maybeSingle();
    if (!ch) return json({ error: 'chamado não encontrado' }, 404);
    if (!ch.autoriza_acesso) return json({ error: 'o lojista não autorizou acesso neste chamado' }, 403);

    const expira = new Date(Date.now() + minutos * 60000).toISOString();
    const { data: sess, error: sErr } = await admin.from('suporte_sessoes')
      .insert({ chamado_id: ch.id, loja_id: ch.loja_id, operador_id: op.id, operador_nome: op.nome, expira_em: expira })
      .select('id, loja_id, expira_em').single();
    if (sErr) return json({ error: 'falha ao abrir a sessão: ' + sErr.message }, 400);

    await admin.from('suporte_chamados').update({ status: 'em_atendimento' }).eq('id', ch.id);
    await log('suporte_entrar', ch.loja_id, { chamado_id: ch.id, sessao_id: sess.id, minutos });
    return json({ ok: true, sessao_id: sess.id, loja_id: sess.loja_id, expira_em: sess.expira_em, loja_nome: (ch as any).lojas?.nome || '' });
  }

  // ----------------------------------------------------------------- ENCERRAR
  if (acao === 'encerrar') {
    const sessaoId = String(body.sessao_id || '');
    if (!sessaoId) return json({ error: 'informe a sessão' }, 400);
    const { data: s } = await admin.from('suporte_sessoes')
      .update({ encerrada_em: new Date().toISOString(), motivo_fim: 'operador' })
      .eq('id', sessaoId).eq('operador_id', op.id).is('encerrada_em', null)
      .select('id, loja_id').maybeSingle();
    if (s) await log('suporte_encerrar', s.loja_id, { sessao_id: sessaoId });
    return json({ ok: true });
  }

  // ----------------------------------------------------------------- RESOLVER
  if (acao === 'resolver') {
    const chamadoId = String(body.chamado_id || '');
    if (!chamadoId) return json({ error: 'informe o chamado' }, 400);
    const { data: c } = await admin.from('suporte_chamados')
      .update({ status: 'resolvido', resolvido_em: new Date().toISOString() })
      .eq('id', chamadoId).select('id, loja_id').maybeSingle();
    if (c) await log('suporte_resolver', c.loja_id, { chamado_id: chamadoId });
    return json({ ok: true });
  }

  return json({ error: 'ação desconhecida' }, 400);
});
