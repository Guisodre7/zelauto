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
    // compra não vem no SELECT (privilégio removido na 0009); entra no merge do
    // custo via Edge Function para quem pode ver. Default 0 para não dar NaN.
    compra: v.compra == null ? 0 : Number(v.compra), alvo: Number(v.alvo),
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

// Colunas de veículos legíveis pelo authenticated (compra ficou de fora na 0009).
const VEIC_COLS = 'id, loja_id, marca, modelo, ano_fab, ano_mod, km, placa, chassi, renavam, cor, alvo, entrada_em, status, renave_fase, foto_url, origem, criado_por, criado_em, atualizado_em';

/* Custo (compra/preparação dos veículos e custo_total das vendas) vem só pela
   Edge Function `custos`, que confere a permissão do perfil. Sem permissão,
   devolve mapas vazios e o app segue sem custo. */
let _custosEmVoo = null;
async function custosDaLoja() {
  // dedupe: no login, listarVeiculos e listarVendas chamam isto em paralelo —
  // uma requisição em voo é compartilhada. Limpa ao concluir (edições futuras
  // buscam de novo).
  if (_custosEmVoo) return _custosEmVoo;
  _custosEmVoo = (async () => {
    const { data, error } = await sb.functions.invoke('custos', { body: {} });
    if (error) return { custos: {}, vendas: {} };
    return { custos: (data && data.custos) || {}, vendas: (data && data.vendas) || {} };
  })().finally(() => { _custosEmVoo = null; });
  return _custosEmVoo;
}

async function listarVeiculos() {
  const { lojaId } = exigirContexto();
  const { data: veic, error } = await sb.from('veiculos')
    .select(VEIC_COLS).eq('loja_id', lojaId).order('entrada_em', { ascending: false });
  if (error) throw error;

  const lista = (veic || []).map(v => veiculoParaProto(v, {}));  // custo entra no merge

  // funde compra/prep para quem pode ver custo (Edge Function service_role)
  try {
    const { custos } = await custosDaLoja();
    for (const v of lista) { const c = custos[v.id]; if (c) { v.compra = Number(c.compra) || 0; v.prep = Number(c.prep) || 0; } }
  } catch (_) { /* sem custo visível: segue com 0 */ }

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

  // RETURNING só id e entrada_em: `compra` perdeu o SELECT na 0009, então um
  // .select() cheio (RETURNING *) seria negado por privilégio de coluna.
  if (ehUuid(v.id)) {
    const { data, error } = await sb.from('veiculos').update(row).eq('id', v.id).select('id, entrada_em').single();
    if (error) throw error; salvo = data;
  } else {
    const { data, error } = await sb.from('veiculos')
      .insert({ ...row, loja_id: lojaId, criado_por: userId }).select('id, entrada_em').single();
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

/* Edição de veículo: atualiza SÓ os campos enviados (whitelist das colunas que o
   authenticated tem privilégio de UPDATE: km, cor, alvo, status, compra). Não usa
   o mapeador cheio de propósito — assim, quando quem edita não vê custo, compra e
   prep simplesmente não são enviados e ficam intactos (nada de zerar). marca,
   modelo, ano e placa são imutáveis pelo cliente (sem grant de update). */
async function atualizarVeiculo(id, campos) {
  const row = {};
  if (campos.km    != null) row.km     = num(campos.km);
  if (campos.cor   != null) row.cor    = campos.cor || null;
  if (campos.alvo  != null) row.alvo   = num(campos.alvo) ?? 0;
  if (campos.status!= null) row.status = campos.status;
  if (campos.compra!= null) row.compra = num(campos.compra) ?? 0;
  if (Object.keys(row).length) {
    const { error } = await sb.from('veiculos').update(row).eq('id', id);
    if (error) throw error;
  }
  // prep é uma linha em veiculo_custos — só mexe se veio (cost-viewer)
  if (campos.prep != null) {
    const { lojaId } = exigirContexto();
    await sb.from('veiculo_custos').delete().eq('veiculo_id', id).eq('categoria', 'preparacao');
    const p = num(campos.prep);
    if (p && p > 0) {
      const { error } = await sb.from('veiculo_custos')
        .insert({ loja_id: lojaId, veiculo_id: id, descricao: 'Preparação', categoria: 'preparacao', valor: p });
      if (error) throw error;
    }
  }
  return id;
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

// Colunas de vendas legíveis pelo authenticated (custo_total ficou de fora na 0010).
const VENDA_COLS = 'id, loja_id, veiculo_id, cliente_id, cliente_nome, descricao, placa, valor, forma, comissao, retorno_banco, vendedor_id, dias_patio, data, criado_em';

function vendaParaProto(s) {
  return {
    id: s.id, desc: s.descricao, placa: s.placa || '',
    // custo_total não vem no SELECT (0010); default 0, preenchido no merge do custo
    custo: s.custo_total == null ? 0 : Number(s.custo_total), valor: Number(s.valor), data: s.data,
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
    .select(VENDA_COLS + ', clientes(nome)').eq('loja_id', lojaId).order('data', { ascending: false });
  if (error) throw error;
  const lista = (data || []).map(vendaParaProto);
  // funde custo_total congelado para quem pode ver custo (Edge Function)
  try {
    const { vendas } = await custosDaLoja();
    for (const s of lista) if (vendas[s.id] != null) s.custo = Number(vendas[s.id]) || 0;
  } catch (_) { /* sem custo visível: segue com 0 */ }
  return lista;
}

async function salvarVenda(s) {
  if (ehUuid(s.id)) {
    // edição de venda existente: NÃO mexe no custo congelado (custo_total sai fora)
    const row = vendaParaBanco(s); delete row.custo_total;
    const { data, error } = await sb.from('vendas').update(row).eq('id', s.id).select('id').single();
    if (error) throw error; return data.id;
  }
  // nova venda: gravada pelo servidor (congela o custo real e baixa o carro),
  // porque o custo foi tirado do acesso do cliente (0009/0010).
  const { data, error } = await sb.functions.invoke('vender', {
    body: {
      veiculoId: s.veiculoId || null, valor: num(s.valor), forma: s.forma,
      comissao: num(s.comissao), retornoBanco: num(s.retornoBanco),
      clienteNome: s.cliente || null, clienteId: s.clienteId || null,
      data: s.data || null, descricao: s.desc, placa: s.placa || null,
      diasPatio: num(s.diasPatio),
    },
  });
  if (error) throw new Error(await mensagemErroFn(error));
  if (data && data.error) throw new Error(data.error);
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
  return (error && error.message) || 'não foi possível concluir a operação';
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

/* ============================ EXPORTAÇÃO ================================= */
/* Gera o .zip (um CSV por tabela da loja) pela Edge Function e devolve a URL
   assinada de 24h. Só o proprietário (a função confere). */
async function exportarDados() {
  const { data, error } = await sb.functions.invoke('exportar-dados', { body: {} });
  if (error) throw new Error(await mensagemErroFn(error));
  if (data && data.error) throw new Error(data.error);
  return data;   // { ok, url, arquivo }
}

/* ============================ MARCA DA LOJA ============================== */
/* Busca a marca (nome/logo/cor) por slug ANTES do login, pela Edge Function
   pública. O slug é só marca/rota — nunca dá acesso. Devolve null se não achar. */
async function marcaDaLoja(slug) {
  if (!slug) return null;
  try {
    const { data, error } = await sb.functions.invoke('marca-loja', { body: { slug } });
    if (error || !data || data.error) return null;
    return { nome: data.nome, logoUrl: data.logo_url || '', cor: data.cor || '' };
  } catch (_) { return null; }
}

/* ============================ INTERFACE PÚBLICA =========================== */

window.Dados = {
  // conexão / sessão
  entrar, sair, sessaoAtual, carregarPerfil, contexto,
  // veículos
  listarVeiculos, salvarVeiculo, atualizarVeiculo, removerVeiculo, subirFotoVeiculo,
  // clientes
  listarClientes, salvarCliente, removerCliente,
  // vendas
  listarVendas, salvarVenda,
  // despesas
  listarDespesas, salvarDespesa, removerDespesa,
  // custos (Edge Function)
  custosDaLoja,
  // exportação de dados (Edge Function)
  exportarDados,
  // marca da loja (login com slug)
  marcaDaLoja,
  // equipe / perfis
  listarEquipe, salvarPerfilBasico, criarMembro, atualizarMembro,
  // acesso cru ao client, se precisar
  _sb: sb,
};
