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

/* Isolamento da sessão por aba/uso — CRÍTICO num mesmo navegador.
   O supabase-js grava a sessão em localStorage, com uma chave por origem. Como
   o app do lojista, o Console do operador e o acesso de suporte moram todos na
   MESMA origem, sem isto eles brigam pela mesma gaveta: entrar num sobrescreve
   o outro, e o app passa a mostrar "a conta errada".

   - App do lojista → chave própria em localStorage (persiste entre sessões).
   - Modo suporte (entrou pelo #sup= do Console) → chave própria em
     sessionStorage: vive só naquela aba, não encosta na sessão do lojista das
     outras abas, e morre sozinha quando a aba fecha. */
const _emSuporte = (typeof location !== 'undefined' && (location.hash || '').indexOf('#sup=') === 0);
const _authOpts = _emSuporte
  ? { storage: window.sessionStorage, storageKey: 'sb-zelauto-suporte', persistSession: true, autoRefreshToken: true }
  : { storageKey: 'sb-zelauto-app' };
const sb = createClient(cfg.url, cfg.anonKey, { auth: _authOpts });

/* Contexto da sessão — preenchido no login/carregarPerfil.
   loja_id NÃO é enviado nos inserts: a RLS (guarda_loja) exige loja_id =
   app.loja_id(), então guardamos o loja_id do perfil e o injetamos ao gravar. */
let _ctx = { userId: null, lojaId: null };

const RE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ehUuid  = v => typeof v === 'string' && RE_UUID.test(v);
const num     = v => (v == null || v === '' ? null : Number(v));
const iniciais = nome => (nome || '').trim().split(/\s+/).slice(0, 2).map(p => p[0] || '').join('').toUpperCase();

/* Choke point central de segurança na GRAVAÇÃO (defesa em profundidade).
   Tira os delimitadores de tag (< >) de campos curtos de identificação que
   NUNCA contêm HTML legítimo (marca, modelo, placa, cor, ano, chassi, renavam).
   Assim, mesmo que um dia um render esqueça o esc(), não há payload de <script>
   gravado no banco para explorar. A defesa PRIMÁRIA continua sendo o esc() no
   render; campos de texto livre (observação, descrição) NÃO são cortados aqui —
   eles são escapados na exibição para não perder o conteúdo do usuário. */
const semTags = v => (v == null ? v : String(v).replace(/[<>]/g, ''));

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

/* O lojista troca a própria senha. Depois disso, a senha provisória que o
   operador gerou na implantação deixa de valer — o operador não fica com o
   acesso. */
async function trocarSenha(nova) {
  const { error } = await sb.auth.updateUser({ password: nova });
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
    origem: v.origem || 'proprio',
  };
}

function veiculoParaBanco(v) {
  const [af, am] = String(v.ano || '').split('/').map(s => parseInt(s, 10) || null);
  return {
    marca: semTags(v.marca), modelo: semTags(v.modelo),
    ano_fab: af, ano_mod: am,
    km: num(v.km), placa: semTags(v.placa) || null, cor: semTags(v.cor) || null,
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
  // Estoque próprio só: consignados (origem='consignado') saem daqui e entram
  // por listarConsignados — não são capital da loja e têm tela própria.
  const { data: veic, error } = await sb.from('veiculos')
    .select(VEIC_COLS).eq('loja_id', lojaId).neq('origem', 'consignado')
    .order('entrada_em', { ascending: false });
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
  if (campos.cor   != null) row.cor    = semTags(campos.cor) || null;
  if (campos.alvo  != null) row.alvo   = num(campos.alvo) ?? 0;
  if (campos.status!= null) row.status = campos.status;
  if (campos.compra!= null) row.compra = num(campos.compra) ?? 0;
  if (campos.renave_fase != null && ['fora','entrada','regular','saida'].includes(campos.renave_fase))
    row.renave_fase = campos.renave_fase;
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

/* ============================== CONSIGNAÇÃO ============================== */
/* Consignado = um veículo (origem='consignado') + uma linha em consignacoes com
   o dono e a comissão. O carro fica na vitrine/site como qualquer outro, mas NÃO
   conta como capital da loja (listarVeiculos exclui origem='consignado'). O
   formato do protótipo junta os dados do carro (veiculos) e do dono
   (consignacoes) num objeto só. */

function consignadoParaProto(row) {
  const v = row.veiculos || {};
  return {
    id: v.id,                                   // id = veiculo_id (thumb/foto usam isso)
    consignacaoId: row.id,
    marca: v.marca, modelo: v.modelo,
    ano: (v.ano_fab && v.ano_mod) ? `${v.ano_fab}/${v.ano_mod}` : (v.ano_fab ? String(v.ano_fab) : ''),
    km: v.km, placa: v.placa || '',
    dono: row.dono_nome, tel: row.dono_telefone || '', doc: row.dono_doc || '',
    minimo: Number(row.minimo) || 0, anuncio: Number(v.alvo) || 0,
    comissao: Number(row.comissao_pct) || 0,
    entrada: v.entrada_em, status: 'anunciado', foto: v.foto_url || '',
  };
}

async function listarConsignados() {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('consignacoes')
    .select('id, dono_nome, dono_doc, dono_telefone, minimo, comissao_pct, veiculos!inner(id, marca, modelo, ano_fab, ano_mod, km, placa, alvo, entrada_em, foto_url)')
    .eq('loja_id', lojaId).order('criado_em', { ascending: false });
  if (error) throw error;
  const lista = (data || []).map(consignadoParaProto);
  // troca o path da foto por URL assinada (bucket privado), em lote
  const comFoto = lista.filter(c => c.foto);
  if (comFoto.length) {
    const { data: assinadas } = await sb.storage.from('veiculos')
      .createSignedUrls(comFoto.map(c => c.foto), FOTO_TTL);
    const mapa = {};
    for (const a of assinadas || []) if (a && a.path && a.signedUrl) mapa[a.path] = a.signedUrl;
    for (const c of lista) c.foto = c.foto ? (mapa[c.foto] || '') : '';
  }
  return lista;
}

/* Cria o veículo (origem='consignado') e a linha de consignação. Se a segunda
   falhar, apaga o veículo (evita carro de terceiro solto no estoque sem dono). */
async function salvarConsignado(c) {
  const { lojaId, userId } = exigirContexto();
  const [af, am] = String(c.ano || '').split('/').map(s => parseInt(s, 10) || null);
  const veic = {
    loja_id: lojaId, marca: semTags(c.marca), modelo: semTags(c.modelo),
    ano_fab: af, ano_mod: am, km: num(c.km), placa: semTags(c.placa) || null, cor: semTags(c.cor) || null,
    compra: 0, alvo: num(c.anuncio) ?? 0, status: 'estoque', origem: 'consignado',
    criado_por: userId || null,
  };
  const { data: vSalvo, error: eV } = await sb.from('veiculos').insert(veic).select('id, entrada_em').single();
  if (eV) throw eV;
  const veiculoId = vSalvo.id;

  const cons = {
    loja_id: lojaId, veiculo_id: veiculoId,
    dono_nome: c.dono || 'Não informado', dono_doc: c.doc || null, dono_telefone: c.tel || null,
    minimo: num(c.minimo) ?? 0, comissao_pct: num(c.comissao) ?? 6,
  };
  const { error: eC } = await sb.from('consignacoes').insert(cons);
  if (eC) {
    await sb.from('veiculos').delete().eq('id', veiculoId);   // rollback manual
    throw eC;
  }
  return veiculoId;
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

/* ===================== INTERAÇÕES (histórico do lead) =================== */
/* Cada contato/movimento do lead vira uma linha em interacoes (tipo 'nota' ou
   'etapa'), com quem registrou. A RLS isola por loja. */

async function listarInteracoes(clienteId) {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('interacoes')
    .select('id, tipo, texto, criado_em, perfis(nome)')
    .eq('loja_id', lojaId).eq('cliente_id', clienteId)
    .order('criado_em', { ascending: false });
  if (error) throw error;
  return (data || []).map(r => ({
    id: r.id, tipo: r.tipo, texto: r.texto || '',
    criado: r.criado_em, quem: (r.perfis && r.perfis.nome) || '',
  }));
}

async function registrarInteracao(clienteId, i) {
  const { lojaId, userId } = exigirContexto();
  const row = {
    loja_id: lojaId, cliente_id: clienteId, usuario_id: userId || null,
    tipo: i.tipo || 'nota', texto: i.texto || null,
  };
  const { data, error } = await sb.from('interacoes').insert(row).select('id, criado_em').single();
  if (error) throw error;
  return { id: data.id, criado: data.criado_em };
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

/* ============================== CARNÊ =================================== */
/* Carnê da casa persistido em duas tabelas: carne_contratos (o negócio) e
   carne_parcelas (uma linha por parcela). O protótipo fala em números derivados
   — `pagas` (quantas parcelas quitadas) e `atraso` (dias de atraso da parcela
   vencida mais antiga em aberto) — que aqui são calculados a partir das
   parcelas. O valor da parcela é fixado na criação (pmt) e gravado em cada
   linha, para que a carteira não dependa de recálculo. */

function carneParaProto(c) {
  const ps = c.carne_parcelas || [];
  const pagas = ps.filter(p => p.pago_em).length;
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  let atraso = 0;
  for (const p of ps) {
    if (p.pago_em) continue;
    const venc = new Date(p.vencimento + 'T00:00:00');
    const d = Math.floor((hoje - venc) / 864e5);
    if (d > atraso) atraso = d;
  }
  return {
    id: c.id, cliente: c.cliente_nome, tel: c.telefone || '',
    veiculo: c.veiculo_desc, valorVeic: Number(c.valor_veiculo),
    entrada: Number(c.entrada), financiado: Number(c.financiado),
    taxa: Number(c.taxa_mes), parcelas: c.parcelas, pagas,
    inicio: c.inicio, score: c.score || 'B', atraso,
    vendaId: c.venda_id || null, clienteId: c.cliente_id || null,
  };
}

async function listarCarne() {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('carne_contratos')
    .select('*, carne_parcelas(numero, vencimento, valor, pago_em, valor_pago)')
    .eq('loja_id', lojaId).order('criado_em', { ascending: false });
  if (error) throw error;
  return (data || []).map(carneParaProto);
}

/* Cria o contrato e gera as parcelas (vencimento mensal a partir de `inicio`).
   O valor de cada parcela vem pronto do protótipo (c.valorParcela = pmt). */
async function salvarCarne(c) {
  const { lojaId } = exigirContexto();
  const nParc = num(c.parcelas) ?? 0;
  const contrato = {
    loja_id: lojaId,
    venda_id: c.vendaId || null,
    cliente_id: c.clienteId || null,
    cliente_nome: c.cliente,
    telefone: c.tel || null,
    veiculo_desc: c.veiculo,
    valor_veiculo: num(c.valorVeic) ?? 0,
    entrada: num(c.entrada) ?? 0,
    financiado: num(c.financiado) ?? 0,
    taxa_mes: num(c.taxa) ?? 0,
    parcelas: nParc,
    inicio: c.inicio,
    score: c.score || 'B',
  };
  const { data, error } = await sb.from('carne_contratos').insert(contrato).select('id').single();
  if (error) throw error;
  const contratoId = data.id;

  const valorParc = num(c.valorParcela) ?? 0;
  const base = new Date(c.inicio + 'T12:00:00');
  const diaBase = base.getDate();
  const ymd = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const linhas = [];
  for (let n = 1; n <= nParc; n++) {
    // avança n meses preservando o dia; se o mês não tem esse dia (31→fev),
    // usa o último dia do mês em vez de rolar para o mês seguinte.
    const venc = new Date(base.getFullYear(), base.getMonth() + n, 1, 12, 0, 0);
    const ultimoDia = new Date(venc.getFullYear(), venc.getMonth() + 1, 0).getDate();
    venc.setDate(Math.min(diaBase, ultimoDia));
    linhas.push({
      loja_id: lojaId, contrato_id: contratoId, numero: n,
      vencimento: ymd(venc), valor: valorParc,
    });
  }
  if (linhas.length) {
    const { error: e2 } = await sb.from('carne_parcelas').insert(linhas);
    if (e2) {
      // rollback manual: parcelas são o carnê; sem elas o contrato não serve.
      // Evita contrato órfão (parcelas=N, zero linhas) que quebraria a carteira.
      await sb.from('carne_contratos').delete().eq('id', contratoId);
      throw e2;
    }
  }
  return contratoId;
}

/* Registra o recebimento da próxima parcela em aberto (a de menor número sem
   pago_em). Devolve o número da parcela quitada, ou null se já estava tudo
   pago. valorPago opcional (default = valor da parcela). */
async function pagarParcelaCarne(contratoId, valorPago) {
  const { data: aberto, error } = await sb.from('carne_parcelas')
    .select('id, numero, valor').eq('contrato_id', contratoId).is('pago_em', null)
    .order('numero', { ascending: true }).limit(1);
  if (error) throw error;
  if (!aberto || !aberto.length) return null;
  const p = aberto[0];
  const hoje = new Date().toISOString().slice(0, 10);
  const { error: e2 } = await sb.from('carne_parcelas')
    .update({ pago_em: hoje, valor_pago: valorPago != null ? (num(valorPago) ?? p.valor) : p.valor })
    .eq('id', p.id);
  if (e2) throw e2;
  return p.numero;
}

/* ============================== CONTRATOS =============================== */
/* Papelada: o contrato em si (partes, veículo, valor, status). O PDF é gerado
   no navegador (imprimir → salvar) a partir do cabeçalho da loja + este registro,
   então não guardamos arquivo no storage nesta fase. Assinatura eletrônica com
   validade jurídica é fase posterior (integração de terceiro): aqui o status
   'assinado' registra a assinatura física/manual, sem hash falso. */

function contratoParaProto(c) {
  return {
    id: c.id, tipo: c.tipo, cliente: c.cliente_nome, doc: c.cliente_doc || '—',
    veiculo: c.veiculo_desc || '', valor: Number(c.valor) || 0, status: c.status,
    data: (c.criado_em || '').slice(0, 10),
    enviadoEm: (c.enviado_em || '').slice(0, 10),
    assinadoEm: (c.assinado_em || '').slice(0, 10),
    hash: c.hash || '',
  };
}

async function listarContratos() {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('contratos')
    .select('*').eq('loja_id', lojaId).order('criado_em', { ascending: false });
  if (error) throw error;
  return (data || []).map(contratoParaProto);
}

async function salvarContrato(c) {
  const { lojaId } = exigirContexto();
  const row = {
    loja_id: lojaId, tipo: c.tipo, cliente_nome: c.cliente,
    cliente_doc: c.doc && c.doc !== '—' ? c.doc : null,
    veiculo_desc: c.veiculo || null, valor: num(c.valor) ?? 0,
    status: c.status || 'rascunho',
    enviado_em: c.status === 'aguardando' ? new Date().toISOString() : null,
  };
  const { data, error } = await sb.from('contratos').insert(row).select('id, criado_em').single();
  if (error) throw error;
  return { id: data.id, data: (data.criado_em || '').slice(0, 10) };
}

/* Move o status do contrato. Ao enviar carimba enviado_em; ao assinar,
   assinado_em. Sem service_role: RLS já isola por loja. */
async function atualizarStatusContrato(id, status) {
  const row = { status };
  if (status === 'aguardando') row.enviado_em = new Date().toISOString();
  if (status === 'assinado') row.assinado_em = new Date().toISOString();
  const { error } = await sb.from('contratos').update(row).eq('id', id);
  if (error) throw error;
  return id;
}

/* ===================== ONBOARDING / INTEGRAÇÕES ========================= */
/* Reúne, num lugar só, tudo que o operador precisa para ligar as integrações
   (NF-e, RENAVE, portais) na entrega. REGRA DE OURO: nada de SEGREDO passa pelo
   navegador — senha de certificado, token de portal e afins ficam com o operador
   (server-side/Vault, fase 4/5). Aqui gravamos só o NÃO-secreto: identidade
   fiscal, provedor/ambiente escolhidos, integradora, ids de anunciante e o
   STATUS de cada integração (pendente / com o operador / no ar). O certificado
   em si é entregue ao operador fora do navegador. */

async function carregarConfigFiscal() {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('config_fiscal').select('*').eq('loja_id', lojaId).maybeSingle();
  if (error) throw error;
  const c = data || {};
  return {
    cnpj: c.cnpj || '', ie: c.ie || '', regime: c.regime || 'simples',
    serie: c.serie ?? 1, provedor: c.provedor || '', ambiente: c.ambiente || 'homologacao',
    certVenceEm: c.cert_vence_em || '', cfopVenda: c.cfop_venda || '5102', ncm: c.ncm || '8703.23.10',
  };
}

/* Grava a identidade fiscal (config_fiscal tem loja_id como PK → upsert). Campos
   secretos NÃO entram aqui. */
async function salvarConfigFiscal(d) {
  const { lojaId } = exigirContexto();
  const row = { loja_id: lojaId };
  if (d.cnpj != null) row.cnpj = d.cnpj || null;
  if (d.ie != null) row.ie = d.ie || null;
  if (d.regime != null) row.regime = d.regime || 'simples';
  if (d.provedor != null) row.provedor = d.provedor || null;
  if (d.ambiente != null) row.ambiente = d.ambiente || 'homologacao';
  if (d.certVenceEm != null) row.cert_vence_em = d.certVenceEm || null;
  if (d.cfopVenda != null) row.cfop_venda = d.cfopVenda || null;
  if (d.ncm != null) row.ncm = d.ncm || null;
  const { error } = await sb.from('config_fiscal').upsert(row, { onConflict: 'loja_id' });
  if (error) throw error;
  return lojaId;
}

/* Status e escolhas das integrações moram no jsonb lojas.config.integracoes
   (sem coluna/tabela nova). Merge preservando as demais chaves de config. */
async function salvarIntegracoes(parcial) {
  return mergeConfig(config => {
    config.integracoes = { ...(config.integracoes || {}), ...parcial };
  });
}

/* ============================== NOTAS FISCAIS =========================== */
/* Fase 4: numeração isolada e persistência da nota. A emissão REAL na SEFAZ é do
   provedor (precisa de certificado/credencial server-side) — aqui a nota nasce
   'processando' e o provedor, quando ligado, a leva para 'autorizada'. Nada de
   autorização/chave falsa. */

function notaParaProto(n) {
  return {
    id: n.id, numero: n.numero, serie: n.serie, tipo: n.tipo,
    dest: n.destinatario, doc: n.doc || '—', desc: n.descricao || '',
    valor: Number(n.valor) || 0, data: (n.emitida_em || '').slice(0, 10),
    status: n.status, chave: n.chave || '',
  };
}

async function listarNotas() {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('notas_fiscais')
    .select('*').eq('loja_id', lojaId).order('numero', { ascending: false });
  if (error) throw error;
  return (data || []).map(notaParaProto);
}

/* Reserva o número e grava a nota numa transação só (RPC public.emitir_nota).
   A série vem da config fiscal da loja, no servidor — não do cliente. */
async function emitirNota(d) {
  const { data, error } = await sb.rpc('emitir_nota', {
    p_tipo: d.tipo || 'saida', p_dest: d.dest,
    p_doc: d.doc || null, p_desc: d.desc || null,
    p_valor: num(d.valor) ?? 0, p_venda_id: d.vendaId || null,
  });
  if (error) throw error;
  return notaParaProto(data);
}

/* ============================== PORTAIS ================================= */
/* Fase 5: status (ligado/desligado) e limite por portal, na tabela portais
   (unique loja_id+portal). O feed padrão já existe (Edge Function site-loja). O
   SYNC real — empurrar o estoque para o portal — precisa de credencial do
   anunciante e roda server-side (fase de onboarding). */

async function listarPortais() {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('portais')
    .select('portal, ativo, limite, ultimo_sync').eq('loja_id', lojaId);
  if (error) throw error;
  return (data || []).map(p => ({ nome: p.portal, ativo: !!p.ativo, limite: p.limite || 10, ultimo: p.ultimo_sync || '' }));
}

async function salvarPortal(nome, campos) {
  const { lojaId } = exigirContexto();
  const row = { loja_id: lojaId, portal: nome };
  if (campos.ativo != null) row.ativo = !!campos.ativo;
  if (campos.limite != null) row.limite = num(campos.limite);
  const { error } = await sb.from('portais').upsert(row, { onConflict: 'loja_id,portal' });
  if (error) throw error;
  return nome;
}

/* ============================== AUDITORIA =============================== */
/* Lê o log (só proprietário/gerente, por RLS — a política nega para vendedor).
   O nome de quem fez a ação é resolvido na tela pelo DB.usuarios (equipe), pois
   auditoria.usuario_id não tem FK declarada para perfis. */
async function listarAuditoria(limite = 120) {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('auditoria')
    .select('id, tabela, registro_id, acao, antes, depois, usuario_id, criado_em')
    .eq('loja_id', lojaId).order('criado_em', { ascending: false }).limit(limite);
  if (error) throw error;
  return (data || []).map(r => ({
    id: r.id, tabela: r.tabela, acao: r.acao, criado: r.criado_em,
    usuarioId: r.usuario_id || '', antes: r.antes, depois: r.depois, registroId: r.registro_id,
  }));
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

/* ===================== LOJA (marca própria do lojista) =================== */
/* O dono edita a própria loja: logo (bucket público marcas) e banner (bucket
   público banners). A RLS (editar_minha_loja) já limita ao dono da loja. */
async function carregarLoja() {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('lojas')
    .select('id, nome, slug, logo_url, banner_url, cor, cnpj, cidade, uf, telefone, config').eq('id', lojaId).single();
  if (error) return null;
  const cfg = data.config || {};
  return {
    id: data.id, nome: data.nome, slug: data.slug || '',
    logoUrl: data.logo_url || '', bannerUrl: data.banner_url || '', cor: data.cor || '',
    cnpj: data.cnpj || '', cidade: data.cidade || '', uf: data.uf || '', telefone: data.telefone || '',
    razaoSocial: cfg.razao_social || '', endereco: cfg.endereco || '',
    integracoes: cfg.integracoes || {},
    metaMes: Number(cfg.meta_mes) || 0,
  };
}

/* Único ponto de leitura-modificação-escrita do jsonb lojas.config: lê, aplica
   `mutar(config)` e grava, preservando o resto. Assume um escritor por vez (um
   lojista, um modal) — não é atômico contra escritas concorrentes de config. */
async function mergeConfig(mutar) {
  const { lojaId } = exigirContexto();
  const { data: atual, error: eSel } = await sb.from('lojas').select('config').eq('id', lojaId).single();
  if (eSel) throw eSel;
  const config = { ...((atual && atual.config) || {}) };
  mutar(config);
  const { error } = await sb.from('lojas').update({ config }).eq('id', lojaId);
  if (error) throw error;
  return lojaId;
}

/* Merge genérico de chaves na raiz de lojas.config. Ex.: meta_mes do DRE. */
async function salvarConfigLoja(parcial) {
  return mergeConfig(config => Object.assign(config, parcial));
}

/* Dados da empresa que entram no cabeçalho de contratos e notas. Só o
   proprietário grava (RLS editar_minha_loja). razão social e endereço moram no
   jsonb `config` (não têm coluna própria); os demais são colunas de lojas. */
async function salvarDadosEmpresa(d) {
  const { lojaId } = exigirContexto();
  // lê o config atual para não sobrescrever outras chaves; se a leitura falhar,
  // aborta — mesclar sobre {} apagaria chaves existentes do jsonb.
  const { data: atual, error: eSel } = await sb.from('lojas').select('config').eq('id', lojaId).single();
  if (eSel) throw eSel;
  const config = { ...((atual && atual.config) || {}) };
  if (d.razaoSocial != null) config.razao_social = d.razaoSocial || null;
  if (d.endereco != null) config.endereco = d.endereco || null;
  const row = { config };
  if (d.cnpj != null) row.cnpj = d.cnpj || null;
  if (d.cidade != null) row.cidade = d.cidade || null;
  if (d.uf != null) row.uf = (d.uf || '').toUpperCase().slice(0, 2) || null;
  if (d.telefone != null) row.telefone = d.telefone || null;
  const { error } = await sb.from('lojas').update(row).eq('id', lojaId);
  if (error) throw error;
  return lojaId;
}
async function subirMarca(tipo, dataUrl) {          // tipo: 'logo' | 'banner'
  const { lojaId } = exigirContexto();
  const bucket = tipo === 'logo' ? 'marcas' : 'banners';
  const path = `${lojaId}/${tipo}.png`;
  const blob = dataUrlParaBlob(dataUrl);
  const { error: up } = await sb.storage.from(bucket).upload(path, blob, { upsert: true, contentType: blob.type || 'image/png' });
  if (up) throw up;
  const pub = sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;
  const col = tipo === 'logo' ? { logo_url: pub } : { banner_url: pub };
  const { error: upd } = await sb.from('lojas').update(col).eq('id', lojaId);
  if (upd) throw upd;
  return pub + '?v=' + Date.now();                  // cache-busting só para exibir na hora
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

/* ============================ ASSINATURA / PLANO ========================= */
/* O proprietário lê o próprio plano e gera a cobrança (PIX copia-e-cola/QR ou
   checkout de cartão) pela Edge Function `cobranca`. Quem CONFIRMA o pagamento é
   o webhook — o cliente nunca marca "pago". A chave da AbacatePay é segredo de
   função (server-side). */

async function carregarAssinatura() {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('assinaturas')
    .select('plano, valor_centavos, status, vence_em').eq('loja_id', lojaId).maybeSingle();
  if (error) return null;                 // sem acesso (não é proprietário) ou sem linha
  if (!data) return { status: 'trial', valorCentavos: 0, venceEm: null };
  return { plano: data.plano, status: data.status, valorCentavos: data.valor_centavos, venceEm: data.vence_em };
}

async function gerarPixAssinatura() {
  const { data, error } = await sb.functions.invoke('cobranca', { body: { acao: 'pix' } });
  if (error) throw new Error(await mensagemErroFn(error));
  if (data && data.error) throw new Error(data.error);
  return data;                            // { brCode, brCodeBase64, id, expiresAt }
}

async function statusAssinatura() {
  const { data, error } = await sb.functions.invoke('cobranca', { body: { acao: 'status' } });
  if (error) throw new Error(await mensagemErroFn(error));
  if (data && data.error) throw new Error(data.error);
  return data;                            // { status, vence_em, pago }
}

/* Gate de acesso: a loja está ativa (paga/em carência)? Server-side via RPC. */
async function lojaAtiva() {
  const { data, error } = await sb.rpc('minha_loja_ativa');
  if (error) return true;                 // fail-safe: erro não tranca a loja
  return data !== false;
}

async function checkoutCartaoAssinatura() {
  const { data, error } = await sb.functions.invoke('cobranca', { body: { acao: 'cartao' } });
  if (error) throw new Error(await mensagemErroFn(error));
  if (data && data.error) throw new Error(data.error);
  return data;                            // { url }
}

/* ============================ SUPORTE (lojista) =========================== */
/* Escrita passa pela Edge `suporte-chat`: é lá que o nome do autor é carimbado,
   que se confere quem pode autorizar o acesso, e de onde sai o e-mail para o
   operador. Leitura continua direto pela RLS (mais barata e já isolada). */
async function chamarSuporteChat(acao, extra) {
  exigirContexto();
  const { data, error } = await sb.functions.invoke('suporte-chat', { body: { acao, ...(extra || {}) } });
  if (error) throw new Error(await mensagemErroFn(error));
  if (data && data.error) throw new Error(data.error);
  return data;
}

/* O lojista abre um chamado. `autoriza` = consentimento EXPLÍCITO para o
   operador acessar o painel. Sem isso, é só uma conversa. */
async function abrirChamadoSuporte(mensagem, autoriza) {
  return chamarSuporteChat('abrir', { mensagem: String(mensagem || '').trim(), autoriza: !!autoriza });
}

/* Manda uma mensagem dentro de um chamado que já existe. */
async function enviarMensagemSuporte(chamadoId, texto) {
  return chamarSuporteChat('enviar', { chamado_id: chamadoId, texto: String(texto || '').trim() });
}

/* O dono libera o acesso ao painel DEPOIS, se a conversa não resolveu. */
async function autorizarAcessoSuporte(chamadoId) {
  return chamarSuporteChat('autorizar', { chamado_id: chamadoId });
}

/* O chamado em andamento da loja (o mais recente que ainda não foi resolvido). */
async function chamadoAbertoSuporte() {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('suporte_chamados')
    .select('id, mensagem, autoriza_acesso, status, criado_em')
    .eq('loja_id', lojaId).neq('status', 'resolvido')
    .order('criado_em', { ascending: false }).limit(1);
  if (error) throw error;
  const c = (data || [])[0];
  return c ? { id: c.id, mensagem: c.mensagem, autorizaAcesso: c.autoriza_acesso, status: c.status, criadoEm: c.criado_em } : null;
}

/* A conversa daquele chamado, em ordem. */
async function listarMensagensSuporte(chamadoId) {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('suporte_mensagens')
    .select('id, autor, autor_nome, texto, criado_em')
    .eq('loja_id', lojaId).eq('chamado_id', chamadoId)
    .order('criado_em', { ascending: true }).limit(400);
  if (error) throw error;
  return (data || []).map(m => ({
    id: m.id, autor: m.autor, nome: m.autor_nome, texto: m.texto, criadoEm: m.criado_em,
  }));
}

/* Quantas respostas do suporte o lojista ainda não viu (badge do botão).
   Só do chamado em andamento: é o único que a conversa abre, e portanto o
   único que `marcar_suporte_lido` consegue zerar. Contar a loja inteira deixava
   o badge aceso para sempre por causa de chamado já resolvido. */
async function naoLidasSuporte() {
  const { lojaId } = exigirContexto();
  const aberto = await chamadoAbertoSuporte();
  if (!aberto) return 0;
  const { count, error } = await sb.from('suporte_mensagens')
    .select('id', { count: 'exact', head: true })
    .eq('loja_id', lojaId).eq('chamado_id', aberto.id)
    .eq('autor', 'operador').is('lida_lojista_em', null);
  if (error) return 0;
  return count || 0;
}

/* Abriu a conversa = leu. Função dedicada (a tabela não aceita update pelo app). */
async function marcarSuporteLido(chamadoId) {
  const { error } = await sb.rpc('marcar_suporte_lido', { p_chamado: chamadoId });
  if (error) throw error;
  return true;
}

/* Tempo real (Supabase Realtime): empurra para o app, na hora, mudanças nas
   sessões (o banner some quando o suporte encerra) e novas mensagens do suporte
   (a conversa chega sem F5). O Realtime respeita a RLS: cada loja só recebe o
   que é dela. Devolve uma função para cancelar a inscrição. */
function assinarSuporte(onSessao, onMensagem) {
  const { lojaId } = exigirContexto();
  const canal = sb.channel('suporte:' + lojaId)
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'suporte_sessoes', filter: 'loja_id=eq.' + lojaId },
      () => { try { onSessao && onSessao(); } catch (_) {} })
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'suporte_mensagens', filter: 'loja_id=eq.' + lojaId },
      (p) => { try { onMensagem && onMensagem(p.new || {}); } catch (_) {} })
    .subscribe();
  return () => { try { sb.removeChannel(canal); } catch (_) {} };
}

/* Histórico de acessos de suporte da loja + qual está ativa agora. */
async function listarSuporteSessoes() {
  const { lojaId } = exigirContexto();
  const { data, error } = await sb.from('suporte_sessoes')
    .select('id, operador_nome, criada_em, expira_em, encerrada_em, motivo_fim')
    .eq('loja_id', lojaId).order('criada_em', { ascending: false }).limit(50);
  if (error) throw error;
  const agora = Date.now();
  return (data || []).map(s => ({
    id: s.id,
    operador: s.operador_nome || 'Suporte ZelAuto',
    criadaEm: s.criada_em,
    expiraEm: s.expira_em,
    encerradaEm: s.encerrada_em,
    motivoFim: s.motivo_fim,
    ativa: !s.encerrada_em && new Date(s.expira_em).getTime() > agora,
  }));
}

/* O dono revoga (encerra) uma sessão ativa. Server-side: só proprietário. */
async function encerrarSuporte(sessaoId) {
  const { data, error } = await sb.rpc('encerrar_suporte', { p_sessao: sessaoId });
  if (error) throw error;
  return data === true;
}

/* ============================ INTERFACE PÚBLICA =========================== */

window.Dados = {
  // conexão / sessão
  entrar, sair, trocarSenha, sessaoAtual, carregarPerfil, contexto,
  // veículos
  listarVeiculos, salvarVeiculo, atualizarVeiculo, removerVeiculo, subirFotoVeiculo,
  // consignação
  listarConsignados, salvarConsignado,
  // clientes
  listarClientes, salvarCliente, removerCliente,
  // interações (histórico do lead)
  listarInteracoes, registrarInteracao,
  // vendas
  listarVendas, salvarVenda,
  // despesas
  listarDespesas, salvarDespesa, removerDespesa,
  // carnê
  listarCarne, salvarCarne, pagarParcelaCarne,
  // contratos (papelada)
  listarContratos, salvarContrato, atualizarStatusContrato,
  // notas fiscais (fase 4 — numeração + persistência; emissão real é do provedor)
  listarNotas, emitirNota,
  // portais (fase 5 — status/limite; sync real é do provedor)
  listarPortais, salvarPortal,
  // dados da empresa (cabeçalho de contrato/nota)
  salvarDadosEmpresa,
  // onboarding / integrações (reúne info; segredos ficam com o operador)
  carregarConfigFiscal, salvarConfigFiscal, salvarIntegracoes, salvarConfigLoja,
  // assinatura / plano (AbacatePay — cobrança via Edge Function)
  carregarAssinatura, gerarPixAssinatura, statusAssinatura, checkoutCartaoAssinatura, lojaAtiva,
  // custos (Edge Function)
  custosDaLoja,
  // exportação de dados (Edge Function)
  exportarDados,
  // marca da loja (login com slug)
  marcaDaLoja,
  // loja própria (site: logo/banner)
  carregarLoja, subirMarca,
  // equipe / perfis
  listarEquipe, salvarPerfilBasico, criarMembro, atualizarMembro,
  // auditoria (só proprietário/gerente)
  listarAuditoria,
  // suporte assistido (consentido, com prazo, revogável)
  abrirChamadoSuporte, listarSuporteSessoes, encerrarSuporte,
  enviarMensagemSuporte, autorizarAcessoSuporte, chamadoAbertoSuporte,
  listarMensagensSuporte, naoLidasSuporte, marcarSuporteLido, assinarSuporte,
  // acesso cru ao client, se precisar
  _sb: sb,
};
