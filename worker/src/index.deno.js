/**
 * BYOD Form Receiver — Deno runtime adaptation
 *
 * This file is a thin wrapper that adapts the Cloudflare Worker (index.js)
 * to run under Deno on a Hetzner VPS (or any server with Deno installed).
 *
 * Differences from index.js:
 *   - Environment variables come from Deno.env.get() instead of `env` parameter
 *   - Entry point is Deno.serve() instead of `export default { fetch }`
 *   - All crypto / fetch / URL / Request / Response APIs are identical in Deno
 *
 * Deploy:
 *   deno run --allow-net --allow-env /opt/byod-worker/index.deno.js
 *
 * Required environment variables (set in /opt/byod-worker/.env, loaded below):
 *   GITHUB_TOKEN        GITHUB_REPO         LANDING_PAGE
 *   ORCID_CLIENT_ID     ORCID_CLIENT_SECRET SESSION_SECRET
 *   FORGEJO_TOKEN       FORGEJO_REPO        FORGEJO_BASE_URL
 *   PORT                (default: 8080)
 *
 * Systemd unit: see infra/hetzner-deploy.sh
 */

// ── Load .env file if present ─────────────────────────────────────────────────
// Deno does not auto-load .env; we read it manually.
try {
  const envFile = new URL('.env', import.meta.url).pathname;
  const text = await Deno.readTextFile(envFile);
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!Deno.env.get(key)) Deno.env.set(key, val);
  }
} catch { /* .env not present — rely on real env vars */ }

// ── Build an `env` object that mirrors the Cloudflare Workers `env` param ─────
// This lets us import and call handleRequest(request, env) unchanged.
const env = new Proxy({}, {
  get: (_t, key) => Deno.env.get(String(key)) ?? undefined,
});

// ── Import and re-export the core handler ─────────────────────────────────────
// index.js exports: export default { fetch(request, env) }
// We import that and forward to Deno.serve.
//
// Because index.js uses `export default` (ES module), we use a dynamic import.
const { default: worker } = await import('./index.js');

// ── Start server ──────────────────────────────────────────────────────────────
const PORT = parseInt(Deno.env.get('PORT') || '8080', 10);

console.log(`BYOD Worker (Deno) listening on http://0.0.0.0:${PORT}`);
console.log(`  GITHUB_REPO:      ${env.GITHUB_REPO ?? '(not set)'}`);
console.log(`  FORGEJO_REPO:     ${env.FORGEJO_REPO ?? '(not set — EU mirror disabled)'}`);
console.log(`  LANDING_PAGE:     ${env.LANDING_PAGE ?? '(not set)'}`);

Deno.serve({ port: PORT, hostname: '0.0.0.0' }, (request) => {
  return worker.fetch(request, env);
});
