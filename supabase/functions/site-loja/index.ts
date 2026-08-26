// =============================================================================
// ZelAuto — Edge Function `site-loja` (Site da loja, seção 5.9)
//
// SSR: renderiza no SERVIDOR o site público da loja, para indexar no Google sem
// trabalho. Público (GET). Lê com service_role só campos PÚBLICOS (nunca custo)
// dos veículos em estoque da loja (por slug). Fica "no ar" sozinho assim que há
// estoque.
//
//   ?slug=vancar             -> catálogo
//   ?slug=vancar&carro=<id>  -> página do carro
//   ?slug=vancar&sitemap=1   -> sitemap.xml
//
// Em produção, um rewrite mapeia zelauto.com.br/vancar -> esta função, e a env
// SITE_BASE (ex.: https://zelauto.com.br) deixa os links "bonitos".
//
// Deploy:  supabase functions deploy site-loja
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as any)[c]);
const brl = (n: number) => 'R$ ' + (Number(n) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
const anoStr = (v: any) => v.ano_fab ? (v.ano_mod && v.ano_mod !== v.ano_fab ? `${v.ano_fab}/${v.ano_mod}` : String(v.ano_fab)) : '';
const html = (body: string, status = 200) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=120' } });

const FOTO_TTL = 60 * 60 * 24 * 7;   // 7 dias: o servidor re-renderiza a cada visita

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const slug = (url.searchParams.get('slug') || url.pathname.split('/').filter(Boolean).pop() || '').trim().toLowerCase();
  const carroId = url.searchParams.get('carro') || '';
  const querSitemap = url.searchParams.get('sitemap');
  const SITE_BASE = (Deno.env.get('SITE_BASE') || '').replace(/\/$/, '');

  const urlLoja = (sl: string) => SITE_BASE ? `${SITE_BASE}/${sl}` : `?slug=${encodeURIComponent(sl)}`;
  const urlCarro = (sl: string, id: string) => SITE_BASE ? `${SITE_BASE}/${sl}/carro/${id}` : `?slug=${encodeURIComponent(sl)}&carro=${id}`;

  if (!slug || !/^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/.test(slug)) {
    return html('<!doctype html><meta charset="utf-8"><title>ZelAuto</title><p style="font:16px system-ui;padding:40px">Endereço de loja inválido.</p>', 400);
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  const { data: loja } = await admin.from('lojas')
    .select('id, nome, cidade, uf, telefone, slug, logo_url, banner_url, cor, ativa, site_ativo')
    .eq('slug', slug).maybeSingle();
  if (!loja || !loja.ativa || loja.site_ativo === false) {
    return html('<!doctype html><meta charset="utf-8"><title>Loja não encontrada</title><p style="font:16px system-ui;padding:40px">Loja não encontrada.</p>', 404);
  }

  // estoque público (só campos públicos; NUNCA compra/custo)
  const { data: veic } = await admin.from('veiculos')
    .select('id, marca, modelo, ano_fab, ano_mod, km, cor, alvo, foto_url, entrada_em')
    .eq('loja_id', loja.id).eq('status', 'estoque').order('entrada_em', { ascending: false });
  const carros = veic || [];

  // fotos: URLs assinadas em lote (bucket privado)
  const paths = carros.filter((c: any) => c.foto_url).map((c: any) => c.foto_url);
  const fotoDe: Record<string, string> = {};
  if (paths.length) {
    const { data: ass } = await admin.storage.from('veiculos').createSignedUrls(paths, FOTO_TTL);
    for (const a of ass || []) if (a && a.path && a.signedUrl) fotoDe[a.path] = a.signedUrl;
  }
  const foto = (c: any) => c.foto_url ? (fotoDe[c.foto_url] || '') : '';

  const cor = /^#?[0-9a-fA-F]{6}$/.test(loja.cor || '') ? (loja.cor[0] === '#' ? loja.cor : '#' + loja.cor) : '#14489E';
  const nome = loja.nome;
  const local = [loja.cidade, loja.uf].filter(Boolean).join(' · ');
  const wpp = (loja.telefone || '').replace(/\D/g, '');

  // -------- feed de portais (XML padrão do estoque) --------
  // O lojista aponta o portal (que aceita integração por feed) para esta URL.
  // Formato genérico; adaptamos por portal quando você fechar a homologação.
  if (url.searchParams.get('feed')) {
    const it = carros.map((c: any) => `  <veiculo>
    <id>${esc(c.id)}</id>
    <marca>${esc(c.marca)}</marca>
    <modelo>${esc(c.modelo)}</modelo>
    <ano>${esc(anoStr(c))}</ano>
    <km>${esc(c.km ?? '')}</km>
    <cor>${esc(c.cor ?? '')}</cor>
    <preco>${Number(c.alvo) || 0}</preco>
    <url>${esc(urlCarro(slug, c.id))}</url>
    <foto>${esc(foto(c))}</foto>
  </veiculo>`).join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<estoque loja="${esc(loja.nome)}" atualizado="${new Date().toISOString()}">\n${it}\n</estoque>`;
    return new Response(xml, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
  }

  // -------- sitemap --------
  if (querSitemap) {
    const u = (s: string) => `<url><loc>${esc(s)}</loc></url>`;
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${u(urlLoja(slug))}\n${carros.map((c: any) => u(urlCarro(slug, c.id))).join('\n')}\n</urlset>`;
    return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
  }

  // ---------- CSS comum ----------
  const cabeca = (titulo: string, desc: string, canonical: string, jsonld: string, extraOg = '') => `<!doctype html>
<html lang="pt-BR"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(titulo)}</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${esc(canonical)}">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(titulo)}">
<meta property="og:description" content="${esc(desc)}"><meta property="og:url" content="${esc(canonical)}">
${loja.logo_url ? `<meta property="og:image" content="${esc(loja.logo_url)}">` : ''}${extraOg}
<meta name="theme-color" content="${esc(cor)}">
<script type="application/ld+json">${jsonld}</script>
<style>
  :root{--cor:${cor}}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#16202b;background:#f4f6f8}
  a{color:inherit;text-decoration:none}
  .top{background:#fff;border-bottom:1px solid #e6eaef}
  .top .in{max-width:1080px;margin:0 auto;padding:14px 20px;display:flex;align-items:center;gap:14px}
  .top img.logo{height:40px;max-width:180px;object-fit:contain}
  .top b{font-size:19px}.top .loc{color:#6b7885;font-size:13px}
  .top .wpp{margin-left:auto;background:#25D366;color:#053d1e;font-weight:700;padding:9px 16px;border-radius:8px;font-size:14px}
  .banner{height:230px;background:linear-gradient(180deg,rgba(0,0,0,.05),rgba(0,0,0,.35)),var(--cor);background-size:cover;background-position:center;display:flex;align-items:flex-end}
  .banner .in{max-width:1080px;margin:0 auto;width:100%;padding:22px 20px;color:#fff}
  .banner h1{font-size:clamp(24px,4vw,38px);text-shadow:0 2px 12px rgba(0,0,0,.4)}
  .banner p{opacity:.95;text-shadow:0 1px 8px rgba(0,0,0,.4)}
  .wrap{max-width:1080px;margin:0 auto;padding:24px 20px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:18px}
  .card{background:#fff;border:1px solid #e6eaef;border-radius:14px;overflow:hidden;transition:.15s}
  .card:hover{box-shadow:0 10px 30px -18px rgba(16,32,48,.5);transform:translateY(-2px)}
  .card .ph{aspect-ratio:4/3;background:#e9edf1;display:grid;place-items:center;color:#9aa7b3;overflow:hidden}
  .card .ph img{width:100%;height:100%;object-fit:cover}
  .card .b{padding:13px 14px}
  .card .nm{font-weight:700;font-size:16px;line-height:1.25}
  .card .sp{color:#6b7885;font-size:13.5px;margin-top:3px}
  .card .pr{color:var(--cor);font-weight:800;font-size:19px;margin-top:9px}
  .vazio{background:#fff;border:1px dashed #cfd8e0;border-radius:14px;padding:44px;text-align:center;color:#6b7885}
  .det{display:grid;gap:24px}
  @media(min-width:760px){.det{grid-template-columns:1.1fr .9fr}}
  .det .foto{aspect-ratio:4/3;background:#e9edf1;border-radius:14px;overflow:hidden;display:grid;place-items:center;color:#9aa7b3}
  .det .foto img{width:100%;height:100%;object-fit:cover}
  .det h1{font-size:26px}.det .pr{color:var(--cor);font-weight:800;font-size:30px;margin:8px 0 16px}
  .specs{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e6eaef;border-radius:12px;overflow:hidden}
  .specs td{padding:11px 14px;border-bottom:1px solid #eef1f4;font-size:15px}.specs tr:last-child td{border-bottom:0}
  .specs td:first-child{color:#6b7885;width:45%}
  .cta{display:inline-flex;align-items:center;gap:9px;background:#25D366;color:#053d1e;font-weight:800;padding:13px 20px;border-radius:10px;margin-top:16px}
  .voltar{display:inline-block;color:#6b7885;font-size:14px;margin-bottom:16px}
  footer{border-top:1px solid #e6eaef;background:#fff;margin-top:36px}
  footer .in{max-width:1080px;margin:0 auto;padding:20px;color:#6b7885;font-size:13.5px;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
  footer .zl{margin-left:auto}
</style></head><body>`;

  const topo = `<header class="top"><div class="in">
    ${loja.logo_url ? `<img class="logo" src="${esc(loja.logo_url)}" alt="${esc(nome)}">` : `<b>${esc(nome)}</b>`}
    ${loja.logo_url ? `<div><b>${esc(nome)}</b>${local ? `<div class="loc">${esc(local)}</div>` : ''}</div>` : (local ? `<span class="loc">${esc(local)}</span>` : '')}
    ${wpp ? `<a class="wpp" href="https://wa.me/55${wpp}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
  </div></header>`;

  const rodape = `<footer><div class="in">
    <span>${esc(nome)}${local ? ' · ' + esc(local) : ''}</span>
    <span class="zl">feito com <b>ZelAuto</b></span>
  </div></footer></body></html>`;

  // ---------------- PÁGINA DO CARRO ----------------
  if (carroId) {
    const c: any = carros.find((x: any) => String(x.id) === String(carroId));
    if (!c) return html(cabeca('Carro não encontrado', nome, urlLoja(slug), '{}') + topo + `<div class="wrap"><a class="voltar" href="${esc(urlLoja(slug))}">← voltar ao estoque</a><div class="vazio">Este veículo não está mais disponível.</div></div>` + rodape, 404);
    const titulo = `${c.marca} ${c.modelo} ${anoStr(c)} — ${esc(nome)}`;
    const desc = `${c.marca} ${c.modelo} ${anoStr(c)}, ${c.km ? Number(c.km).toLocaleString('pt-BR') + ' km' : ''} ${c.cor || ''} por ${brl(c.alvo)} na ${nome}${local ? ' em ' + local : ''}.`.replace(/\s+/g, ' ').trim();
    const img = foto(c);
    const jsonld = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'Car', name: `${c.marca} ${c.modelo}`,
      brand: { '@type': 'Brand', name: c.marca }, model: c.modelo,
      ...(c.ano_mod || c.ano_fab ? { modelDate: String(c.ano_mod || c.ano_fab) } : {}),
      ...(c.km ? { mileageFromOdometer: { '@type': 'QuantitativeValue', value: Number(c.km), unitCode: 'KMT' } } : {}),
      ...(c.cor ? { color: c.cor } : {}), ...(img ? { image: img } : {}),
      offers: { '@type': 'Offer', price: Number(c.alvo) || 0, priceCurrency: 'BRL', availability: 'https://schema.org/InStock', seller: { '@type': 'AutoDealer', name: nome } },
    });
    const body = topo + `<div class="wrap">
      <a class="voltar" href="${esc(urlLoja(slug))}">← voltar ao estoque</a>
      <div class="det">
        <div class="foto">${img ? `<img src="${esc(img)}" alt="${esc(c.marca)} ${esc(c.modelo)}">` : 'sem foto'}</div>
        <div>
          <h1>${esc(c.marca)} ${esc(c.modelo)}</h1>
          <div class="pr">${brl(c.alvo)}</div>
          <table class="specs">
            <tr><td>Ano</td><td>${esc(anoStr(c) || '—')}</td></tr>
            <tr><td>Quilometragem</td><td>${c.km ? esc(Number(c.km).toLocaleString('pt-BR')) + ' km' : '—'}</td></tr>
            <tr><td>Cor</td><td>${esc(c.cor || '—')}</td></tr>
          </table>
          ${wpp ? `<a class="cta" href="https://wa.me/55${wpp}?text=${encodeURIComponent('Olá! Tenho interesse no ' + c.marca + ' ' + c.modelo + ' ' + anoStr(c))}" target="_blank" rel="noopener">Falar no WhatsApp sobre este carro</a>` : ''}
        </div>
      </div>
    </div>`;
    return html(cabeca(titulo, desc, urlCarro(slug, c.id), jsonld, img ? `<meta property="og:image" content="${esc(img)}">` : '') + body + rodape);
  }

  // ---------------- CATÁLOGO ----------------
  const titulo = `${nome} — Estoque de veículos${local ? ' · ' + local : ''}`;
  const desc = `Veja os ${carros.length} veículos à venda na ${nome}${local ? ' em ' + local : ''}. Preços, fotos e contato direto pelo WhatsApp.`;
  const jsonld = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'AutoDealer', name: nome,
    ...(loja.logo_url ? { logo: loja.logo_url } : {}),
    ...(loja.telefone ? { telephone: loja.telefone } : {}),
    ...(loja.cidade || loja.uf ? { address: { '@type': 'PostalAddress', addressLocality: loja.cidade || '', addressRegion: loja.uf || '', addressCountry: 'BR' } } : {}),
    makesOffer: carros.slice(0, 50).map((c: any) => ({ '@type': 'Offer', price: Number(c.alvo) || 0, priceCurrency: 'BRL', itemOffered: { '@type': 'Car', name: `${c.marca} ${c.modelo}`, url: urlCarro(slug, c.id) } })),
  });
  const banner = loja.banner_url ? `style="background-image:linear-gradient(180deg,rgba(0,0,0,.05),rgba(0,0,0,.35)),url('${esc(loja.banner_url)}')"` : '';
  const cards = carros.length ? carros.map((c: any) => {
    const img = foto(c);
    return `<a class="card" href="${esc(urlCarro(slug, c.id))}">
      <div class="ph">${img ? `<img src="${esc(img)}" alt="${esc(c.marca)} ${esc(c.modelo)}" loading="lazy">` : 'sem foto'}</div>
      <div class="b"><div class="nm">${esc(c.marca)} ${esc(c.modelo)}</div>
        <div class="sp">${esc(anoStr(c))}${c.km ? ' · ' + esc(Number(c.km).toLocaleString('pt-BR')) + ' km' : ''}${c.cor ? ' · ' + esc(c.cor) : ''}</div>
        <div class="pr">${brl(c.alvo)}</div>
      </div></a>`;
  }).join('') : `<div class="vazio">Estoque sendo atualizado. Fale com a gente pelo WhatsApp.</div>`;
  const body = topo + `<section class="banner" ${banner}><div class="in">
      <h1>${esc(nome)}</h1><p>${carros.length} ${carros.length === 1 ? 'veículo disponível' : 'veículos disponíveis'}${local ? ' · ' + esc(local) : ''}</p>
    </div></section>
    <div class="wrap"><div class="grid">${cards}</div></div>`;
  return html(cabeca(titulo, desc, urlLoja(slug), jsonld) + body + rodape);
});
