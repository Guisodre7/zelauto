/* =============================================================================
 * MODELO de configuração — copie este arquivo para `dados.config.js`
 * (que está no .gitignore) e preencha com os dados do SEU projeto Supabase.
 *
 *   cp dados.config.example.js dados.config.js
 *
 * A chave é a PUBLISHABLE/ANON (a que pode ficar no navegador — protegida pela
 * RLS). NUNCA use aqui a service_role.
 *
 * Onde achar: painel Supabase → Project Settings → API
 *   - Project URL          -> url
 *   - publishable/anon key -> anonKey
 *
 * O index (zelauto.html) deve carregar este arquivo ANTES do dados.js:
 *   <script src="dados.config.js"></script>
 *   <script type="module" src="dados.js"></script>
 * ========================================================================== */
window.ZELAUTO_CONFIG = {
  url:     'https://SEU-PROJETO.supabase.co',
  anonKey: 'COLE_AQUI_A_PUBLISHABLE_ANON_KEY',
};
