# Deploy na Vercel

A Vercel hospeda só o **frontend estático** (`app/`, `site/`, `admin/`,
`assets/`). O **backend continua no Supabase** (banco, Auth, Edge Functions) —
a Vercel não roda nada disso; o navegador fala direto com o Supabase pela chave
publishable/anon (protegida pela RLS).

## O que já está pronto no repo
- `vercel.json` — build + rotas limpas:
  - `/` → site institucional (`site/`)
  - `/app` → app do lojista (`app/zelauto.html`)
  - `/admin` → Console do Operador
- `scripts/gen-dados-config.mjs` — gera `app/dados.config.js` no build a partir de
  variáveis de ambiente (a chave **não fica no git**).

## Passo a passo (uma vez)
1. Na Vercel, **Import Git Repository** → escolha `guisodre7/zelauto`.
2. **Framework Preset: Other.** O `vercel.json` já define o build e a saída;
   não precisa mexer em Build/Output.
3. **Environment Variables** (Settings → Environment Variables):
   - `SUPABASE_URL` = `https://SEU-PROJETO.supabase.co`
   - `SUPABASE_ANON_KEY` = a **publishable/anon** key (nunca a service_role)
   - Opcionais: `SUPORTE_WHATSAPP` (só dígitos, ex. `5571900000000`),
     `SITE_INSTITUCIONAL` (ex. `https://zelauto.com.br`),
     `APP_URL` (ex. `https://SEU-PROJETO.vercel.app/app`)
4. **Deploy.** Você recebe um domínio `https://SEU-PROJETO.vercel.app`.

## Testar
- `…/` → landing institucional
- `…/app?loja=<slug>` → app do lojista (login com a marca da loja)
- `…/admin` → Console do Operador

## Trocar o domínio depois (é só na Vercel)
- Settings → **Domains** → adicione `zelauto.com.br` (e `www`).
- A Vercel mostra o DNS (um `A`/`CNAME`) para apontar no seu registrador.
- Atualize a env `APP_URL` para o domínio final e faça um redeploy.
- **Nada muda no código** — as rotas seguem iguais no novo domínio.

## Site público da loja (opcional, pelo seu domínio)
O catálogo público (SSR) roda na Edge Function `site-loja` do Supabase, com URL
própria. Para servi-lo em `seudominio/loja/<slug>`, acrescente ao array
`rewrites` do `vercel.json` (troque `<ref>` pelo ref do seu projeto Supabase):
```json
{ "source": "/loja/:slug", "destination": "https://<ref>.functions.supabase.co/site-loja?slug=:slug" }
```

## Observações
- **CORS**: as Edge Functions já mandam `Access-Control-Allow-Origin: *`, então
  o front na Vercel fala com elas sem ajuste.
- **Auth**: o login é e-mail/senha (sem redirect de OAuth), então não precisa
  cadastrar a URL da Vercel em nenhum lugar do Supabase.
- **`app/dados.config.js`** segue no `.gitignore`: no local você cria à mão (copie
  do `.example`); na Vercel ele é **gerado no build** pelas env vars.
- O `dev.html` na raiz é só o atalho de desenvolvimento local; em produção a home
  é o site institucional.
