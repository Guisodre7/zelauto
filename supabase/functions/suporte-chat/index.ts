// =============================================================================
// ZelAuto — Edge Function `suporte-chat` (lado do LOJISTA)
//
// A escrita do lojista no suporte passa toda por aqui, por três motivos:
//   1. o nome do autor é carimbado no servidor (ninguém forja "Suporte ZelAuto"
//      dentro da própria loja);
//   2. autorizar o acesso ao painel é decisão do PROPRIETÁRIO, e isso precisa
//      ser conferido fora do navegador;
//   3. é aqui que sai o e-mail avisando o operador — o lojista não fica falando
//      sozinho enquanto ninguém olha o Console.
//
// O app só LÊ (RLS) e marca como lida (função `marcar_suporte_lido`).
//
// Ações: abrir | enviar | autorizar
// Segredos: RESEND_API_KEY (opcional — sem ela, o chamado grava e o e-mail é
// apenas pulado, com aviso no log). SUPORTE_EMAIL_FROM / SUPORTE_CONSOLE_URL.
//
// Deploy: supabase functions deploy suporte-chat
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const LIMITE_TEXTO = 4000;
const esc = (s: string) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'método não permitido' }, 405);

  const URL_ = Deno.env.get('SUPABASE_URL')!;
  const SERVICE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const ANON = Deno.env.get('SUPABASE_ANON_KEY')!;

  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader) return json({ error: 'sem autenticação' }, 401);

  const userClient = createClient(URL_, ANON, { global: { headers: { Authorization: authHeader } } });
  const { data: { user }, error: uErr } = await userClient.auth.getUser();
  if (uErr || !user) return json({ error: 'sessão inválida' }, 401);

  const admin = createClient(URL_, SERVICE);

  // Perfil do chamador: fonte da verdade de loja, papel e nome.
  const { data: perfil } = await admin
    .from('perfis').select('loja_id, papel, ativo, nome').eq('id', user.id).maybeSingle();
  if (!perfil || !perfil.ativo) return json({ error: 'perfil não encontrado ou inativo' }, 403);
  const loja = perfil.loja_id as string;
  const autorNome = (perfil.nome as string) || 'Lojista';

  let body: any;
  try { body = await req.json(); } catch { return json({ error: 'corpo inválido' }, 400); }
  const acao = body?.acao;

  const texto = String(body?.texto ?? body?.mensagem ?? '').trim().slice(0, LIMITE_TEXTO);

  // Confere que o chamado é DESTA loja antes de qualquer escrita.
  async function chamadoDaLoja(id: string) {
    if (!id) return null;
    const { data } = await admin.from('suporte_chamados')
      .select('id, loja_id, status, autoriza_acesso, mensagem').eq('id', id).maybeSingle();
    return data && data.loja_id === loja ? data : null;
  }

  // ------------------------------------------------------------------ e-mail
  // Avisa TODOS os operadores. Falha de e-mail nunca derruba o chamado: o dado
  // já está gravado; o e-mail é conveniência.
  async function avisarOperadores(assunto: string, corpo: string) {
    const chave = Deno.env.get('RESEND_API_KEY');
    if (!chave) { console.warn('[suporte-chat] RESEND_API_KEY ausente — e-mail não enviado'); return; }
    try {
      const { data: ops } = await admin.from('operadores').select('id');
      const emails: string[] = [];
      for (const o of ops || []) {
        const { data } = await admin.auth.admin.getUserById(o.id as string);
        const e = data?.user?.email; if (e) emails.push(e);
      }
      if (!emails.length) return;
      const from = Deno.env.get('SUPORTE_EMAIL_FROM') || 'ZelAuto Suporte <onboarding@resend.dev>';
      const console_ = Deno.env.get('SUPORTE_CONSOLE_URL') || '';
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${chave}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from, to: emails, subject: assunto,
          html: `<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;line-height:1.6;color:#141413">
            ${corpo}
            ${console_ ? `<p style="margin-top:22px"><a href="${console_}" style="background:#F79A1B;color:#17130A;text-decoration:none;font-weight:700;padding:11px 18px;border-radius:10px;display:inline-block">Abrir o Console</a></p>` : ''}
            <p style="color:#6F6F68;font-size:13px;margin-top:24px">ZelAuto · aviso automático do suporte</p>
          </div>`,
        }),
      });
      if (!r.ok) console.error('[suporte-chat] Resend', r.status, await r.text());
    } catch (e) { console.error('[suporte-chat] falha ao notificar:', e); }
  }

  const { data: lojaRow } = await admin.from('lojas').select('nome').eq('id', loja).maybeSingle();
  const lojaNome = (lojaRow?.nome as string) || 'loja';

  // ------------------------------------------------------------------- ABRIR
  // Abre o chamado e já grava a primeira mensagem — a conversa começa cheia.
  if (acao === 'abrir') {
    if (!texto) return json({ error: 'escreva a sua dúvida' }, 400);
    const autoriza = !!body?.autoriza;

    const { data: ch, error: cErr } = await admin.from('suporte_chamados')
      .insert({ loja_id: loja, aberto_por: user.id, mensagem: texto, autoriza_acesso: autoriza })
      .select('id, criado_em').single();
    if (cErr) return json({ error: 'não consegui abrir o chamado: ' + cErr.message }, 400);

    await admin.from('suporte_mensagens').insert({
      chamado_id: ch.id, loja_id: loja, autor: 'lojista',
      autor_id: user.id, autor_nome: autorNome, texto,
    });

    await avisarOperadores(
      `Novo chamado — ${lojaNome}`,
      `<p><b>${esc(lojaNome)}</b> abriu um chamado de suporte.</p>
       <p style="background:#F5F5F3;border-radius:10px;padding:13px 15px"><i>${esc(texto)}</i></p>
       <p>${autoriza ? '<b>O lojista autorizou o acesso ao painel.</b>' : 'Sem autorização de acesso — responda pela conversa.'}</p>`,
    );
    return json({ ok: true, chamado_id: ch.id });
  }

  // ------------------------------------------------------------------ ENVIAR
  if (acao === 'enviar') {
    if (!texto) return json({ error: 'escreva a mensagem' }, 400);
    const ch = await chamadoDaLoja(String(body?.chamado_id || ''));
    if (!ch) return json({ error: 'chamado não encontrado' }, 404);

    const { error: mErr } = await admin.from('suporte_mensagens').insert({
      chamado_id: ch.id, loja_id: loja, autor: 'lojista',
      autor_id: user.id, autor_nome: autorNome, texto,
    });
    if (mErr) return json({ error: 'não consegui enviar: ' + mErr.message }, 400);

    // Resolvido que volta a falar reabre — senão a resposta some da caixa.
    if (ch.status === 'resolvido')
      await admin.from('suporte_chamados').update({ status: 'aberto', resolvido_em: null }).eq('id', ch.id);

    await avisarOperadores(
      `Mensagem de ${lojaNome}`,
      `<p><b>${esc(autorNome)}</b> (${esc(lojaNome)}) respondeu no suporte:</p>
       <p style="background:#F5F5F3;border-radius:10px;padding:13px 15px"><i>${esc(texto)}</i></p>`,
    );
    return json({ ok: true });
  }

  // --------------------------------------------------------------- AUTORIZAR
  // Liberar o painel é decisão do dono — nem gerente, nem vendedor.
  if (acao === 'autorizar') {
    if (perfil.papel !== 'proprietario')
      return json({ error: 'só o proprietário pode autorizar o acesso ao painel' }, 403);
    const ch = await chamadoDaLoja(String(body?.chamado_id || ''));
    if (!ch) return json({ error: 'chamado não encontrado' }, 404);
    if (ch.autoriza_acesso) return json({ ok: true, ja: true });

    await admin.from('suporte_chamados').update({ autoriza_acesso: true }).eq('id', ch.id);
    await admin.from('suporte_mensagens').insert({
      chamado_id: ch.id, loja_id: loja, autor: 'lojista', autor_id: user.id, autor_nome: autorNome,
      texto: 'Autorizei o suporte a acessar o meu painel para resolver isto.',
    });
    await avisarOperadores(
      `Acesso autorizado — ${lojaNome}`,
      `<p><b>${esc(lojaNome)}</b> autorizou o acesso ao painel neste chamado.</p>
       <p style="background:#F5F5F3;border-radius:10px;padding:13px 15px"><i>${esc(String(ch.mensagem || ''))}</i></p>`,
    );
    return json({ ok: true });
  }

  return json({ error: 'ação desconhecida' }, 400);
});
