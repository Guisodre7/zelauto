// =============================================================================
// ZelAuto — Edge Function `suporte` (Console do Operador · Fase 1)
//
// CONTROL PLANE de suporte. Só operador ZelAuto age. Abre/fecha sessões de
// acesso ao painel do lojista — SEMPRE com consentimento (autoriza_acesso),
// com prazo (padrão 2h), e tudo registrado em operador_log.
//
// Desde a 0024 o acesso é EDITÁVEL: `entrar` prepara um usuário de verdade
// daquela loja ("Suporte ZelAuto", papel gerente) e devolve a credencial de uma
// vez só, para o operador abrir o app real. Quem segura isso é a 0024: o token
// de suporte só enxerga a loja enquanto houver linha em `app.suporte_ativo`, e
// `encerrar` apaga essa linha — o corte é imediato, sem esperar token expirar.
//
// Ações:
//   listar    -> chamados abertos (com a loja) + sessões ativas + não lidas
//   mensagens -> a conversa de um chamado (e marca as do lojista como lidas)
//   responder -> escreve no chamado como Suporte ZelAuto
//   entrar    -> cria a sessão de acesso (exige consentimento + prazo)
//   encerrar  -> fecha uma sessão que este operador abriu
//   resolver  -> marca o chamado como resolvido
//   testar_email -> dispara um e-mail de teste (confere a chave do Resend)
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

// O suporte enxerga a operação, não o dinheiro da loja: sem custo de compra
// (ver_custos), sem margem (ver_lucro), sem DRE e sem mexer na equipe.
const MODULOS_SUPORTE = [
  'dash', 'estoque', 'vendas', 'crm', 'renave', 'nfe', 'anuncios', 'vitrine',
  'avaliacao', 'contratos', 'despesas', 'fin', 'carne', 'consig',
];

// Senha de uso único: vale enquanto durar a sessão e é trocada na próxima.
function senhaDescartavel() {
  const b = new Uint8Array(24); crypto.getRandomValues(b);
  return 'Zs' + Array.from(b, (x) => x.toString(36)).join('').slice(0, 34) + '!7';
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
  const { data: op } = await admin.from('operadores').select('id, nome').eq('id', user.id).maybeSingle();
  if (!op) return json({ error: 'acesso restrito ao operador ZelAuto' }, 403);

  const log = (acao: string, loja_id: string | null, detalhe: unknown) =>
    admin.from('operador_log').insert({ operador_id: op.id, acao, loja_id, detalhe: detalhe || {} });

  // Fecha o acesso de verdade. A linha de `app.suporte_ativo` é o que corta na
  // hora; o banimento e o perfil inativo são o cinto e o suspensório, para o
  // usuário de suporte não conseguir voltar sozinho depois.
  async function fecharAcesso(sessaoId: string, usuario: string | null, loja: string) {
    await admin.rpc('suporte_acesso_fechar', { p_sessao: sessaoId });
    if (!usuario) return;
    // O usuário de suporte é o MESMO em toda sessão daquela loja. Fechar uma
    // sessão velha não pode trancar o usuário de uma sessão que está em curso —
    // era assim que a credencial recém-entregue nascia morta.
    const { count } = await admin.from('suporte_sessoes')
      .select('id', { count: 'exact', head: true })
      .eq('usuario_suporte', usuario).is('encerrada_em', null)
      .gt('expira_em', new Date().toISOString()).neq('id', sessaoId);
    if ((count || 0) > 0) return;
    await admin.from('perfis').update({ ativo: false }).eq('id', usuario).eq('loja_id', loja);
    await admin.auth.admin.updateUserById(usuario, { ban_duration: '876000h' });
  }

  // Sessão que venceu não precisa de ninguém para morrer: o relógio já a
  // desligou na RLS (`app.loja_id()` compara `expira_em`). Esta faxina só
  // arruma a casa depois — fecha no histórico e tranca o usuário de suporte.
  async function faxinaAcessos() {
    const agora = new Date().toISOString();
    const { data: vencidas } = await admin.from('suporte_sessoes')
      .select('id, loja_id, usuario_suporte')
      .is('encerrada_em', null).lte('expira_em', agora)
      .not('usuario_suporte', 'is', null).limit(50);
    for (const v of vencidas || []) {
      await admin.from('suporte_sessoes')
        .update({ encerrada_em: agora, motivo_fim: 'prazo' }).eq('id', v.id);
      await fecharAcesso(v.id as string, v.usuario_suporte as string, v.loja_id as string);
    }
  }

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'corpo inválido' }, 400); }
  const acao = body?.acao;

  // ------------------------------------------------------------------- LISTAR
  if (acao === 'listar') {
    await faxinaAcessos();     // fecha o que venceu, antes de dizer o que está ativo
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
  // Prepara o acesso EDITÁVEL: garante o usuário "Suporte ZelAuto" daquela loja,
  // troca a senha dele por uma descartável, liga o interruptor com prazo e
  // devolve a credencial. O operador abre o app de verdade com ela.
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

    const email = `suporte+${ch.loja_id}@zelauto.app`;
    const senha = senhaDescartavel();
    const meta = { loja_id: ch.loja_id, papel: 'gerente', suporte: true };

    // Endereço fixo do usuário de suporte desta loja (0025). Antes isso vinha do
    // histórico de sessões — e um `entrar` que falhasse no meio deixava o
    // usuário órfão, travando todo `entrar` seguinte por e-mail duplicado.
    const { data: reg } = await admin.rpc('suporte_usuario_de', { p_loja: ch.loja_id });
    let uid = (reg as string) || '';
    if (uid) {
      const { error } = await admin.auth.admin.updateUserById(uid, {
        password: senha, app_metadata: meta, ban_duration: 'none',
      });
      if (error) uid = '';                       // sumiu do auth: cria de novo
    }
    if (!uid) {
      const { data: novo, error } = await admin.auth.admin.createUser({
        email, password: senha, email_confirm: true, app_metadata: meta,
      });
      if (error || !novo?.user) return json({ error: 'não consegui preparar o acesso: ' + (error?.message || '') }, 400);
      uid = novo.user.id;
      await admin.rpc('suporte_usuario_registrar', { p_loja: ch.loja_id, p_usuario: uid });
    }

    // O perfil na loja: é ele que dá nome à auditoria e libera as telas.
    const { error: pErr } = await admin.from('perfis').upsert({
      id: uid, loja_id: ch.loja_id, nome: 'Suporte ZelAuto', papel: 'gerente',
      modulos: MODULOS_SUPORTE, ver_custos: false, ver_lucro: false, ativo: true,
    });
    if (pErr) return json({ error: 'não consegui criar o perfil de suporte: ' + pErr.message }, 400);

    const expira = new Date(Date.now() + minutos * 60000).toISOString();
    const { data: sess, error: sErr } = await admin.from('suporte_sessoes')
      .insert({ chamado_id: ch.id, loja_id: ch.loja_id, operador_id: op.id,
                operador_nome: op.nome, expira_em: expira, usuario_suporte: uid })
      .select('id, loja_id, expira_em').single();
    if (sErr) return json({ error: 'falha ao abrir a sessão: ' + sErr.message }, 400);

    // O interruptor. Sem esta linha, o token de suporte não enxerga nada.
    const { error: aErr } = await admin.rpc('suporte_acesso_abrir', {
      p_usuario: uid, p_loja: ch.loja_id, p_sessao: sess.id, p_expira: expira,
    });
    if (aErr) return json({ error: 'falha ao liberar o acesso: ' + aErr.message }, 400);

    await admin.from('suporte_chamados').update({ status: 'em_atendimento' }).eq('id', ch.id);
    await log('suporte_entrar', ch.loja_id, { chamado_id: ch.id, sessao_id: sess.id, minutos, modo: 'edicao' });
    return json({
      ok: true, sessao_id: sess.id, loja_id: sess.loja_id, expira_em: sess.expira_em,
      loja_nome: (ch as any).lojas?.nome || '', email, senha,
    });
  }

  // ----------------------------------------------------------------- ENCERRAR
  // QUALQUER operador ZelAuto encerra QUALQUER sessão — não só quem abriu. Antes
  // amarrava em operador_id = op.id, e uma sessão aberta pelo Pedro não fechava
  // quando o Guisodre clicava (0 linhas, banner do lojista preso). São todos
  // staff; a auditoria já registra quem de fato encerrou.
  if (acao === 'encerrar') {
    const sessaoId = String(body.sessao_id || '');
    if (!sessaoId) return json({ error: 'informe a sessão' }, 400);
    const { data: s } = await admin.from('suporte_sessoes')
      .update({ encerrada_em: new Date().toISOString(), motivo_fim: 'operador' })
      .eq('id', sessaoId).is('encerrada_em', null)
      .select('id, loja_id, usuario_suporte').maybeSingle();
    if (s) {
      await fecharAcesso(sessaoId, (s.usuario_suporte as string) || null, s.loja_id as string);
      await log('suporte_encerrar', s.loja_id, { sessao_id: sessaoId });
    }
    return json({ ok: true });
  }

  // ------------------------------------------------------------- TESTAR E-MAIL
  // Confere de dentro do Supabase se o Resend está de pé: usa o MESMO segredo
  // que os avisos de chamado usam, e devolve o erro cru quando não usa.
  if (acao === 'testar_email') {
    const chave = Deno.env.get('RESEND_API_KEY');
    if (!chave) return json({ ok: false, motivo: 'RESEND_API_KEY não está configurada nesta função' });

    const { data: u } = await admin.auth.admin.getUserById(op.id);
    const para = u?.user?.email;
    if (!para) return json({ ok: false, motivo: 'este operador não tem e-mail no auth' });

    const from = Deno.env.get('SUPORTE_EMAIL_FROM') || 'ZelAuto Suporte <onboarding@resend.dev>';
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from, to: [para], subject: 'ZelAuto — teste do aviso de suporte',
          html: '<p>Se você está lendo isto, os avisos de chamado vão chegar.</p>',
        }),
      });
      const txt = await r.text();
      await log('suporte_testar_email', null, { status: r.status, para });
      return r.ok
        ? json({ ok: true, para, remetente: from })
        : json({ ok: false, motivo: `Resend respondeu ${r.status}: ${txt.slice(0, 400)}` });
    } catch (e) {
      return json({ ok: false, motivo: 'não consegui falar com o Resend: ' + String(e) });
    }
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
