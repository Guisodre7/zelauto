// =============================================================================
// Gera app/dados.config.js a partir de variáveis de ambiente (Vercel/CI).
//
// Assim a URL e a chave PUBLISHABLE/ANON do Supabase entram no build sem ficarem
// no git (o arquivo segue no .gitignore; é criado fresco a cada deploy). A chave
// anon é pública por natureza — vai para o navegador de qualquer jeito, protegida
// pela RLS. NUNCA use a service_role aqui.
//
// Variáveis (defina no painel da Vercel → Settings → Environment Variables):
//   SUPABASE_URL              (obrigatória)  ex.: https://xxxx.supabase.co
//   SUPABASE_ANON_KEY         (obrigatória)  a publishable/anon key
//   SUPORTE_WHATSAPP          (opcional)     só dígitos, ex.: 5571900000000
//   SITE_INSTITUCIONAL        (opcional)     ex.: https://zelauto.com.br
//   APP_URL                   (opcional)     ex.: https://zelauto.com.br/app
// =============================================================================

import { writeFileSync, mkdirSync } from 'node:fs';

const url  = process.env.SUPABASE_URL || '';
const anon = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || '';

if (!url || !anon) {
  console.error('\n[gen-dados-config] Faltam SUPABASE_URL e/ou SUPABASE_ANON_KEY nas env vars da Vercel.');
  process.exit(1);
}

const cfg = {
  url,
  anonKey: anon,
  suporteWhatsapp:   process.env.SUPORTE_WHATSAPP   || '',
  siteInstitucional: process.env.SITE_INSTITUCIONAL || '',
  appUrl:            process.env.APP_URL            || '/app',
};

const body =
  '/* GERADO NO BUILD (scripts/gen-dados-config.mjs) — não editar à mão. */\n' +
  'window.ZELAUTO_CONFIG = ' + JSON.stringify(cfg, null, 2) + ';\n';

mkdirSync('app', { recursive: true });
writeFileSync('app/dados.config.js', body);
console.log('[gen-dados-config] app/dados.config.js gerado para', url);
