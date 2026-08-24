/* =============================================================================
 * ZelAuto — dados.js  (camada de dados / item 6 da seção 15)
 *
 * Só a CAMADA DE DADOS. Não toca em nenhuma tela. Expõe window.Dados com uma
 * função por operação, traduzindo entre o formato do protótipo (o objeto DB em
 * memória) e o schema do Supabase. A troca das telas vem depois, uma por vez.
 *
 * Carregue no HTML assim (config primeiro):
 *   <script src="dados.config.js"></script>
 *   <script type="module" src="dados.js"></script>
 *
 * Convenção de nomes: as funções recebem e devolvem SEMPRE no formato do
 * protótipo (ex.: veiculo.ano = '2018/2019', venda.custo, cliente.tel). Os
 * mapeadores privados fazem a ponte com as colunas do banco.
 * ========================================================================== */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cfg = window.ZELAUTO_CONFIG;
if (!cfg || !cfg.url || !cfg.anonKey) {
  throw new Error('dados.js: falta dados.config.js com window.ZELAUTO_CONFIG {url, anonKey}.');
}

const sb = createClient(cfg.url, cfg.anonKey);

/* Contexto da sessão — preenchido no login/carregarPerfil.
   loja_id NÃO é enviado nos inserts: a RLS (guarda_loja) exige loja_id =
   app.loja_id(), então guardamos o loja_id do perfil e o injetamos ao gravar. */
let _ctx = { userId: null, lojaId: null };

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ehUuid  = v => typeof v === 'string' && RE_UUID.test(v);
const num     = v => (v == null || v === '' ? null : Number(v));
const iniciais = nome => (nome || '').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase();

function exigirContexto() {
  if (!_ctx.lojaId) throw new Error('Sem sessão/loja. Chame Dados.entrar() e Dados.carregarPerfil() antes.');
  return _ctx;
}

/* ============================ AUTENTICAÇÃO ================================= */

async function entrar(email, senha) {
  const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
  if (error) throw error;
  await carregarPerfil();           // popula _ctx e valida que há perfil
  return data.session;
}

async function sair() {
  const { error } = await sb.auth.signOut();
  _ctx = { userId: null, lojaId: null };
  if (error) throw error;
}

async function sessaoAtual() {
  const { data } = await sb.auth.getSession();
  return data.session || null;
}

/* Devolve o USER no formato do protótipo, ou null se não houver sessão. */
async function carregarPerfil() {
  const { data: { user } } = await sb.auth.getUser();
  if (!user) { _ctx = { userId: null, lojaId: null }; return null; }

  const { data: p, error } = await sb.from('perfis').select('*').eq('id', user.id).single();
  if (error) throw error;

  _ctx = { userId: p.id, lojaId: p.loja_id };
  return {
    id: p.id,
    nome: p.nome,
    papel: p.papel,               // enum do banco (proprietario/gerente/vendedor/administrativo)
    tel: p.telefone || '',
    iniciais: iniciais(p.nome),
    modulos: p.modulos || [],
    verCustos: p.ver_custos,
    verLucro: p.ver_lucro,
    ativo: p.ativo,
  };
}

function contexto() { return { ..._ctx }; }

/* ============================== VEÍCULOS =================================== */
/* prep (preparação) no protótipo é um número único; no banco vira soma de
   veiculo_custos (categoria 'preparacao'). Na leitura somamos; na gravação
   sincronizamos uma única linha de custo 'preparacao'. */

function veiculoParaProto(v, prepPorVeiculo) {
  return {
    id: v.id,
    marca: v.marca, modelo: v.modelo,
    ano: (v.ano_fab && v.ano_mod) ? `${v.ano_fab}/${v.ano_mod}`
        : (v.ano_fab ? String(v.ano_fab) : ''),
    km: v.km, placa: v.placa || '', cor: v.cor || '',
    compra: Number(v.compra), alvo: Number(v.alvo),
    prep: prepPorVeiculo[v.id] || 0,
    entrada: v.entrada_em, status: v.status,
    foto: v.foto_url || '',            // mapeado p/ quando o Storage entrar
    rn: v.renave_fase || 'fora',       // fase RENAVE (fora da fase 1, mas fiel ao banco)
  };
}

function veiculoParaBanco(v) {
  const [af, am] = String(v.ano || '').split('/').map(s => parseInt(s, 10) || null);
  return {
    marca: v.marca, modelo: v.modelo,
    ano_fab: af, ano_mod: am,
    km: num(v.km), placa: v.placa || null, cor: v.cor || null,
    compra: num(v.compra) ?? 0, alvo: num(v.alvo) ?? 0,
    entrada_em: v.entrada || undefined, status: v.status || 'estoque',
  };
}

async function listarVeiculos() {
  const { lojaId } = exigirContexto();
  const { data: veic, error } = await sb.from('veiculos')
    .select('*').eq('loja_id', lojaId).order('entrada_em', { ascending: false });
  if (error) throw error;

  const { data: custos, error: e2 } = await sb.from('veiculo_custos')
    .select('veiculo_id, valor, categoria').eq('loja_id', lojaId).eq('categoria', 'preparacao');
  if (e2) throw e2;

  const prep = {};
  for (const c of custos || []) prep[c.veiculo_id] = (prep[c.veiculo_id] || 0) + Number(c.valor);
  const lista = (veic || []).map(v => veiculoParaProto(v, prep));

  // foto: veiculoParaProto colocou o PATH (foto_url) em v.foto; troca por URL
  // assinada (bucket privado). Uma chamada em lote (createSignedUrls) em vez de N.
  const comFoto = lista.filter(v => v.foto);
  if (comFoto.length) {
    const { data: assinadas } = await sb.storage.from('veiculos')
      .createSignedUrls(comFoto.map(v => v.foto), FOTO_TTL);
    const mapa = {};
    for (const a of assinadas || []) if (a && a.path && a.signedUrl) mapa[a.path] = a.signedUrl;
    for (const v of lista) v.foto = v.foto ? (mapa[v.foto] || '') : '';
  }
  return lista;
}

/* Foto: bucket privado 'veiculos', caminho {loja_id}/{veiculo_id}/foto.jpg */
const FOTO_TTL = 60 * 60 * 24;   // 24h: cobre um turno inteiro sem a foto quebrar

function dataUrlParaBlob(dataUrl) {
  const [meta, b64] = String(dataUrl).split(',');
  if (!b64) throw new Error('imagem inválida (dataURL sem conteúdo)');
  const mime = (meta.match(/data:(.*?);/) || [])[1] || 'image/jpeg';
  const bin = atob(b64); const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

async function urlFotoVeiculo(path) {
  if (!path) return '';
  const { data, error } = await sb.storage.from('veiculos').createSignedUrl(path, FOTO_TTL);
  if (error) return '';
  return data.signedUrl;
}

async function subirFotoVeiculo(veiculoId, dataUrl) {
  const { lojaId } = exigirContexto();
  const blob = dataUrlParaBlob(dataUrl);
  const path = `${lojaId}/${veiculoId}/foto.jpg`;
  const { error: upErr } = await sb.storage.from('veiculos')
    .upload(path, blob, { upsert: true, contentType: blob.type || 'image/jpeg' });
  if (upErr) throw upErr;
  const { error: updErr } = await sb.from('veiculos').update({ foto_url: path }).eq('id', veiculoId);
  if (updErr) throw updErr;
  return await urlFotoVeiculo(path);
}

async function salvarVeiculo(v) {
  const { lojaId, userId } = exigirContexto();
  const row = veiculoParaBanco(v);
  let salvo;

  if (ehUuid(v.id)) {
    const { data, error } = await sb.from('veiculos').update(row).eq('id', v.id).select().single();
    if (error) throw error; salvo = data;
  } else {
    const { data, error } = await sb.from('veiculos')
      .insert({ ...row, loja_id: lojaId, criado_por: userId }).select().single();
    if (error) throw error; salvo = data;
  }

  // sincroniza a preparação como uma única linha de custo
  await sb.from('veiculo_custos').delete().eq('veiculo_id', salvo.id).eq('categoria', 'preparacao');
  const prep = num(v.prep);
  if (prep && prep > 0) {
    const { error } = await sb.from('veiculo_custos')
      .insert({ loja_id: lojaId, veiculo_id: salvo.id, descricao: 'Preparação', categoria: 'preparacao', valor: prep });
    if (error) throw error;
  }
  return { id: salvo.id, entrada: salvo.entrada_em };   // devolve a data real do banco
}

async function removerVeiculo(id) {
  const { lojaId } = exigirContexto();
  // remove também a foto do Storage (evita objeto órfão no bucket privado)
  await sb.storage.from('veiculos').remove([`${lojaId}/${id}/foto.jpg`]);
  const { error } = await sb.from('veiculos').delete().eq('id', id);
  if (error) throw error;
}

/* ============================== CLIENTES =================================== */
/* No protótipo o array chama-se `leads`; a entidade é `clientes`. */

function clienteParaProto(c) {
  return {
    id: c.id, nome: c.nome, tel: c.telefone || '', origem: c.origem || '',
    interesse: c.interesse || '', orcamento: c.orcamento, etapa: c.etapa,
    ultimo: c.ultimo_contato, proximo: c.proximo_contato,
    troca: c.troca || '', obs: c.obs || '',
    veiculoId: c.veiculo_id, responsavelId: c.responsavel_id,
  };
}

function clienteParaBanco(c) {
  return {
    nome: c.nome, telefone: c.tel || null, origem: c.origem || 'outro',
    etapa: c.etapa || 'novo', interesse: c.interesse || null,
    orcamento: num(c.orcamento), troca: c.troca || null, obs: c.obs || null,
    ultimo_contato: c.ultimo || null, proximo_contato: c.proximo || null,
    veiculo_id: c.veiculoId || null,
  };
}

async function listarClientes() {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('clientes')
    .select('*').eq('loja_id', lojaId).order('criado_em', { ascending: false });
  if (error) throw error;
  return (data || []).map(clienteParaProto);
}

async function salvarCliente(c) {
  const { lojaId, userId } = exigirContexto();
  const row = clienteParaBanco(c);
  if (ehUuid(c.id)) {
    const { data, error } = await sb.from('clientes').update(row).eq('id', c.id).select().single();
    if (error) throw error; return data.id;
  }
  const { data, error } = await sb.from('clientes')
    .insert({ ...row, loja_id: lojaId, responsavel_id: c.responsavelId || userId }).select().single();
  if (error) throw error; return data.id;
}

async function removerCliente(id) {
  const { error } = await sb.from('clientes').delete().eq('id', id);
  if (error) throw error;
}

/* =============================== VENDAS ==================================== */
/* No protótipo a venda tem `cliente` como NOME (string). No banco o nome fica
   congelado em cliente_nome (não muda se o cadastro do cliente for editado);
   cliente_id é só o vínculo opcional. Na leitura preferimos o nome congelado e
   caímos no join só para vendas antigas sem cliente_nome. */

function vendaParaProto(s) {
  return {
    id: s.id, desc: s.descricao, placa: s.placa || '',
    custo: Number(s.custo_total), valor: Number(s.valor), data: s.data,
    forma: s.forma, comissao: Number(s.comissao), retornoBanco: Number(s.retorno_banco),
    diasPatio: s.dias_patio,
    cliente: s.cliente_nome || (s.clientes ? s.clientes.nome : ''),
    clienteId: s.cliente_id, veiculoId: s.veiculo_id,
  };
}

function vendaParaBanco(s) {
  return {
    descricao: s.desc, placa: s.placa || null,
    custo_total: num(s.custo) ?? 0, valor: num(s.valor) ?? 0,
    forma: s.forma, comissao: num(s.comissao) ?? 0, retorno_banco: num(s.retornoBanco) ?? 0,
    dias_patio: num(s.diasPatio), data: s.data || undefined,
    cliente_nome: s.cliente || null,
    cliente_id: s.clienteId || null, veiculo_id: s.veiculoId || null,
  };
}

async function listarVendas() {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('vendas')
    .select('*, clientes(nome)').eq('loja_id', lojaId).order('data', { ascending: false });
  if (error) throw error;
  return (data || []).map(vendaParaProto);
}

async function salvarVenda(s) {
  const { lojaId, userId } = exigirContexto();
  const row = vendaParaBanco(s);
  if (ehUuid(s.id)) {
    const { data, error } = await sb.from('vendas').update(row).eq('id', s.id).select().single();
    if (error) throw error; return data.id;
  }
  const { data, error } = await sb.from('vendas')
    .insert({ ...row, loja_id: lojaId, vendedor_id: s.vendedorId || userId }).select().single();
  if (error) throw error;
  // A venda tira o carro do pátio: marca o veículo como vendido no mesmo passo,
  // fechando o meio-estado (venda gravada, carro ainda em estoque). Não há
  // trigger no banco fazendo isso; a RLS por loja já garante o isolamento.
  if (s.veiculoId) {
    const { error: vErr } = await sb.from('veiculos')
      .update({ status: 'vendido' }).eq('id', s.veiculoId);
    if (vErr) throw vErr;
  }
  return data.id;
}

/* ============================== DESPESAS ================================== */

function despesaParaProto(d) {
  return { id: d.id, cat: d.categoria, desc: d.descricao, valor: Number(d.valor), tipo: d.tipo, dia: d.dia_vencimento, criado: d.criado_em };
}
function despesaParaBanco(d) {
  return { categoria: d.cat, descricao: d.desc, valor: num(d.valor) ?? 0, tipo: d.tipo || 'fixa', dia_vencimento: num(d.dia) };
}

async function listarDespesas() {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('despesas')
    .select('*').eq('loja_id', lojaId).order('criado_em', { ascending: false });
  if (error) throw error;
  return (data || []).map(despesaParaProto);
}

async function salvarDespesa(d) {
  const { lojaId } = exigirContexto();
  const row = despesaParaBanco(d);
  if (ehUuid(d.id)) {
    const { data, error } = await sb.from('despesas').update(row).eq('id', d.id).select().single();
    if (error) throw error; return data.id;
  }
  const { data, error } = await sb.from('despesas')
    .insert({ ...row, loja_id: lojaId }).select().single();
  if (error) throw error; return data.id;
}

async function removerDespesa(id) {
  const { error } = await sb.from('despesas').delete().eq('id', id);
  if (error) throw error;
}

/* ============================== EQUIPE / PERFIS ========================== */
/* Lê a equipe da loja (RLS já limita à loja). ATENÇÃO: por privilégio de coluna
   (§3.4 da spec), o authenticated só pode gravar nome e telefone em perfis —
   papel, modulos, ver_custos e ver_lucro exigem service_role (Edge Function),
   para um vendedor não se promover a proprietário pelo navegador. Criar um novo
   login também é server-side (cria usuário no Auth). Por isso aqui só há leitura
   e a gravação básica de nome/telefone. */

const PAPEL_LABEL = { proprietario: 'Proprietário', gerente: 'Gerente', vendedor: 'Vendedor', administrativo: 'Administrativo' };

function perfilParaProto(p) {
  return {
    id: p.id, nome: p.nome, tel: p.telefone || '',
    papel: PAPEL_LABEL[p.papel] || p.papel, papelChave: p.papel,
    iniciais: iniciais(p.nome),
    modulos: p.modulos || [], verCustos: p.ver_custos, verLucro: p.ver_lucro,
    ativo: p.ativo,
  };
}

async function listarEquipe() {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('perfis')
    .select('*').eq('loja_id', lojaId).order('criado_em', { ascending: true });
  if (error) throw error;
  return (data || []).map(perfilParaProto);
}

/* Só nome e telefone — as demais colunas de perfis são bloqueadas por privilégio
   de coluna e falhariam aqui de propósito. */
async function salvarPerfilBasico(p) {
  const { error } = await sb.from('perfis')
    .update({ nome: p.nome, telefone: p.tel || null }).eq('id', p.id);
  if (error) throw error;
  return p.id;
}

/* Criar membro e alterar permissões passam pela Edge Function `equipe`
   (service_role, server-side). O invoke já envia o token do usuário logado no
   Authorization; a função confere papel/loja e aplica o teto do gerente. */

async function mensagemErroFn(error) {
  // supabase-js põe o corpo do erro (não-2xx) em error.context (uma Response)
  try {
    if (error && error.context && typeof error.context.json === 'function') {
      const j = await error.context.json();
      if (j && j.error) return j.error;
    }
  } catch (_) { /* ignora */ }
  return (error && error.message) || 'erro na gestão de equipe';
}

async function criarMembro(m) {
  const { data, error } = await sb.functions.invoke('equipe', {
    body: {
      acao: 'criar', nome: m.nome, email: m.email, telefone: m.tel,
      papel: m.papelChave, modulos: m.modulos, ver_custos: m.verCustos, ver_lucro: m.verLucro,
    },
  });
  if (error) throw new Error(await mensagemErroFn(error));
  if (data && data.error) throw new Error(data.error);
  return data;   // { ok, email, senha }
}

async function atualizarMembro(m) {
  const body = { acao: 'atualizar', id: m.id };
  if (m.nome != null) body.nome = m.nome;
  if (m.tel != null) body.telefone = m.tel;
  if (m.papelChave) body.papel = m.papelChave;
  if (m.modulos) body.modulos = m.modulos;
  if (m.verCustos != null) body.ver_custos = m.verCustos;
  if (m.verLucro != null) body.ver_lucro = m.verLucro;
  if (m.ativo != null) body.ativo = m.ativo;
  const { data, error } = await sb.functions.invoke('equipe', { body });
  if (error) throw new Error(await mensagemErroFn(error));
  if (data && data.error) throw new Error(data.error);
  return data;   // { ok }
}

/* ============================ INTERFACE PÚBLICA =========================== */

window.Dados = {
  // conexão / sessão
  entrar, sair, sessaoAtual, carregarPerfil, contexto,
  // veículos
  listarVeiculos, salvarVeiculo, removerVeiculo, subirFotoVeiculo,
  // clientes
  listarClientes, salvarCliente, removerCliente,
  // vendas
  listarVendas, salvarVenda,
  // despesas
  listarDespesas, salvarDespesa, removerDespesa,
  // equipe / perfis
  listarEquipe, salvarPerfilBasico, criarMembro, atualizarMembro,
  // acesso cru ao client, se precisar
  _sb: sb,
};
