/**
 * BYOD Form Receiver — Cloudflare Worker
 *
 * Routes:
 *   GET  /auth/login                → ORCID login page
 *   GET  /auth/orcid                → start ORCID OAuth flow
 *   GET  /auth/orcid/callback       → handle ORCID redirect
 *   GET  /auth/logout               → clear session
 *   GET  /auth/status               → JSON session status (CORS, credentialed)
 *   GET  /forms/disease-case        → disease case form (auth required)
 *   GET  /forms/ontology-gap        → ontology gap form (auth required)
 *   GET  /forms/data-gap            → data / model gap form (auth required)
 *   GET  /forms/form-feedback       → form feedback (auth required)
 *   GET  /forms/disease-resource    → disease resource form (auth required)
 *   POST /submit                    → create GitHub Issue (auth required)
 *   GET  /                          → redirect to landing page
 *
 * Secrets (wrangler secret put):
 *   GITHUB_TOKEN        — fine-grained PAT, Issues: Read & Write
 *   ORCID_CLIENT_ID     — from orcid.org/developer-tools
 *   ORCID_CLIENT_SECRET
 *   SESSION_SECRET      — any random 32+ char string
 *   FORGEJO_TOKEN       — (optional) Forgejo/Codeberg token for EU mirror writes
 *
 * Vars (wrangler.toml):
 *   GITHUB_REPO      — e.g. "StaticFDP/ga4gh-rare-disease-trajectories"
 *   LANDING_PAGE     — e.g. "https://fdp.semscape.org/ga4gh-rare-disease-trajectories/"
 *   FORGEJO_BASE_URL — (optional) e.g. "https://codeberg.org"
 *   FORGEJO_REPO     — (optional) e.g. "StaticFDP/ga4gh-rare-disease-trajectories"
 */

// ── Session helpers (Web Crypto — no external deps) ───────────────────────────

const SESSION_COOKIE = 'byod_session';
const SESSION_TTL    = 60 * 60 * 24; // 24 hours in seconds

async function makeSession(payload, secret) {
  const data    = JSON.stringify({ ...payload, exp: Date.now() + SESSION_TTL * 1000 });
  const key     = await importHmacKey(secret);
  const sigBuf  = await crypto.subtle.sign('HMAC', key, enc(data));
  const sig     = b64(sigBuf);
  return b64(enc(data)) + '.' + sig;
}

async function readSession(cookieHeader, secret) {
  if (!cookieHeader || !secret) return null;
  const raw = cookieHeader.split(';')
    .map(c => c.trim())
    .find(c => c.startsWith(SESSION_COOKIE + '='));
  if (!raw) return null;
  const value = raw.slice(SESSION_COOKIE.length + 1);
  try {
    const [datab64, sigb64] = value.split('.');
    if (!datab64 || !sigb64) return null;
    const dataBytes = decb64(datab64);
    const key       = await importHmacKey(secret);
    const valid     = await crypto.subtle.verify('HMAC', key, decb64(sigb64), dataBytes);
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(dataBytes));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']
  );
}

function enc(s)    { return new TextEncoder().encode(s); }
function b64(buf)  { return btoa(String.fromCharCode(...new Uint8Array(buf))); }
function decb64(s) { return Uint8Array.from(atob(s), c => c.charCodeAt(0)); }

function sessionCookie(value, maxAge = SESSION_TTL) {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

// ── OAuth state (anti-CSRF) ───────────────────────────────────────────────────

function makeState(returnTo) {
  const rand = b64(crypto.getRandomValues(new Uint8Array(16)));
  return encodeURIComponent(JSON.stringify({ rand, returnTo }));
}

function parseState(raw) {
  try { return JSON.parse(decodeURIComponent(raw)); }
  catch { return { returnTo: '/' }; }
}

// ── Shared CSS ────────────────────────────────────────────────────────────────

const CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --brand: #1a6b5a; --brand-light: #e6f4f1; --brand-dark: #0f4c3a;
  --accent: #2563eb; --text: #1a1a2e; --muted: #6b7280;
  --border: #e5e7eb; --radius: 10px;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 15px; line-height: 1.6; color: var(--text);
  background: #f8fafc; padding-bottom: 64px;
}
a { color: var(--brand); }
.container { max-width: 720px; margin: 0 auto; padding: 0 20px; }
header {
  background: linear-gradient(135deg, var(--brand-dark) 0%, var(--brand) 60%, var(--accent) 100%);
  color: #fff; padding: 28px 20px 24px; margin-bottom: 36px;
}
header a.back {
  display: inline-block; font-size: 13px; opacity: .8; margin-bottom: 10px;
  color: rgba(255,255,255,.85); text-decoration: none;
}
header a.back:hover { opacity: 1; }
header h1 { font-size: 22px; font-weight: 800; margin-bottom: 4px; }
header p  { font-size: 14px; opacity: .85; }
.notice {
  background: var(--brand-light); border: 1px solid #a7d9ce;
  border-radius: var(--radius); padding: 11px 15px;
  font-size: 13px; color: var(--brand-dark); margin-bottom: 28px;
}
.section-title {
  font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: .07em; color: var(--muted);
  border-bottom: 1px solid var(--border); padding-bottom: 7px; margin-bottom: 18px;
}
.field { margin-bottom: 20px; }
label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 3px; }
label .req { color: #dc2626; margin-left: 2px; }
.hint { font-size: 13px; color: var(--muted); margin-bottom: 6px; }
input[type=text], input[type=url], textarea, select {
  width: 100%; padding: 8px 11px;
  border: 1.5px solid var(--border); border-radius: 8px;
  font-size: 14px; font-family: inherit; background: #fff;
  transition: border-color .15s;
}
input:focus, textarea:focus, select:focus {
  outline: none; border-color: var(--brand);
  box-shadow: 0 0 0 3px rgba(26,107,90,.1);
}
textarea { resize: vertical; min-height: 90px; }
.cb-group { display: flex; flex-direction: column; gap: 7px; }
.cb-group label {
  font-weight: 400; display: flex; align-items: flex-start;
  gap: 8px; cursor: pointer;
}
.cb-group input[type=checkbox] {
  margin-top: 3px; flex-shrink: 0; width: 15px; height: 15px;
  accent-color: var(--brand);
}
.cb-subhead {
  font-size: 11px; font-weight: 700; text-transform: uppercase;
  letter-spacing: .06em; color: var(--muted);
  margin-top: 12px; margin-bottom: 4px;
}
.id-hint {
  font-size: 12px; color: var(--muted); background: #f1f5f9;
  border: 1px solid var(--border); border-radius: 6px;
  padding: 8px 11px; margin-bottom: 6px; font-family: monospace;
  line-height: 1.8;
}
.btn-submit {
  display: block; width: 100%; padding: 13px;
  background: var(--brand); color: #fff; border: none;
  border-radius: 8px; font-size: 15px; font-weight: 700;
  cursor: pointer; margin-top: 32px;
  transition: filter .15s, transform .1s;
}
.btn-submit:hover { filter: brightness(.92); transform: translateY(-1px); }
.honeypot { display: none !important; }
/* ── Identity chip (auto-filled contributor) ── */
.identity-chip {
  display: flex; align-items: center; gap: 10px;
  background: #f0fdf4; border: 1px solid #86efac;
  border-radius: 8px; padding: 10px 14px; font-size: 14px;
}
.identity-chip .id-name { font-weight: 700; color: #15803d; }
.identity-chip .id-via  { font-size: 12px; color: var(--muted); margin-left: 4px; }
/* ── Auth page ── */
.login-page { max-width: 460px; margin: 48px auto; padding: 0 20px; text-align: center; }
.login-page h1 { font-size: 24px; font-weight: 800; margin-bottom: 8px; }
.login-page .sub { color: var(--muted); font-size: 14px; margin-bottom: 32px; }
.login-btn {
  display: flex; align-items: center; justify-content: center; gap: 12px;
  width: 100%; padding: 14px 20px; border-radius: 10px;
  font-size: 15px; font-weight: 700; text-decoration: none;
  margin-bottom: 12px; transition: filter .15s, transform .1s; border: none; cursor: pointer;
}
.login-btn:hover { filter: brightness(.93); transform: translateY(-1px); text-decoration: none; }
.login-btn.orcid  { background: #a6ce39; color: #000; }
.login-btn svg { flex-shrink: 0; }
.login-note { font-size: 12px; color: var(--muted); margin-top: 20px; }
/* ── Identity bar ── */
.id-bar {
  background: var(--brand-light); border-bottom: 1px solid #a7d9ce;
  padding: 8px 20px; font-size: 13px; color: var(--brand-dark);
  display: flex; justify-content: space-between; align-items: center;
}
.id-bar a { color: var(--brand-dark); font-weight: 600; }
/* ── Thank-you / error ── */
.thankyou { text-align: center; padding: 72px 20px; }
.thankyou h1 { font-size: 26px; font-weight: 800; margin-bottom: 10px; }
.thankyou p { color: var(--muted); margin-bottom: 6px; font-size: 15px; }
.thankyou a.btn-back {
  display: inline-block; margin-top: 24px; padding: 11px 22px;
  background: var(--brand); color: #fff; border-radius: 8px;
  font-weight: 600; font-size: 14px; text-decoration: none;
}
.error-box {
  background: #fef2f2; border: 1px solid #fca5a5;
  border-radius: var(--radius); padding: 16px; margin-top: 24px;
  font-size: 14px; color: #991b1b;
}
`;

// ── HTML helpers ──────────────────────────────────────────────────────────────

function html(status, body) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/html;charset=UTF-8' } });
}

function redirect(url, status = 302) {
  return new Response(null, { status, headers: { Location: url } });
}

function page(title, subtitle, idBar, body, landing) {
  return `<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} · Bring Your Own Disease</title>
  <style>${CSS}</style></head><body>
  ${idBar}
  <header><div class="container">
    <a class="back" href="${landing}">← Back to session page</a>
    <h1>${title}</h1>${subtitle ? `<p>${subtitle}</p>` : ''}
  </div></header>
  <div class="container">${body}</div>
  </body></html>`;
}

function identityBar(session, landing) {
  if (!session) return '';
  const label = `Signed in via ORCID &nbsp;·&nbsp; <strong>${session.name || session.id}</strong> <span style="font-family:monospace;font-size:11px">(${session.id})</span>`;
  return `<div class="id-bar">${label}<a href="/auth/logout">Sign out</a></div>`;
}

// ── Login page ────────────────────────────────────────────────────────────────

function loginPage(returnTo, env) {
  const landing = env.LANDING_PAGE || '/';
  const orcidUrl = `/auth/orcid?return=${encodeURIComponent(returnTo)}`;

  const hasOrcid = !!(env.ORCID_CLIENT_ID && env.ORCID_CLIENT_SECRET);

  const orcidBtn = hasOrcid ? `
    <a class="login-btn orcid" href="${orcidUrl}">
      <svg width="24" height="24" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
        <circle cx="128" cy="128" r="128" fill="#A6CE39"/>
        <path d="M86 74h28v108H86V74zm56 0h42c39 0 58 22 58 54s-19 54-58 54h-42V74zm28 88h14c19 0 29-11 29-34s-10-34-29-34h-14v68z" fill="#000"/>
      </svg>
      Sign in with ORCID
    </a>` : '';

  const body = `
  <div class="login-page">
    <h1>Sign in to contribute</h1>
    <p class="sub">
      A quick sign-in prevents spam and makes your submission attributable.
      Your identity will be visible on the GitHub Issue created from your submission.
    </p>
    ${orcidBtn}
    ${!hasOrcid ? '<p class="error-box">Authentication is not configured on this server.</p>' : ''}
    <p class="login-note">
      Don't have ORCID? <a href="https://orcid.org/register" target="_blank" rel="noopener">Register free in 30 seconds</a> —
      it's the standard researcher identifier used worldwide.
    </p>
  </div>`;

  return `<!DOCTYPE html><html lang="en"><head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sign in · Bring Your Own Disease</title>
  <style>${CSS}</style></head><body>
  <div style="background:linear-gradient(135deg,#0f4c3a,#1a6b5a 60%,#2563eb);padding:16px 20px;">
    <a href="${landing}" style="color:rgba(255,255,255,.8);font-size:13px;text-decoration:none;">← Back to session page</a>
  </div>
  ${body}</body></html>`;
}

// ── ORCID OAuth ───────────────────────────────────────────────────────────────

const ORCID_AUTH  = 'https://orcid.org/oauth/authorize';
const ORCID_TOKEN = 'https://orcid.org/oauth/token';

function orcidStart(request, env) {
  const url      = new URL(request.url);
  const returnTo = url.searchParams.get('return') || env.LANDING_PAGE || '/';
  const state    = makeState(returnTo);
  const redirect = `${url.origin}/auth/orcid/callback`;

  const auth = new URL(ORCID_AUTH);
  auth.searchParams.set('client_id',     env.ORCID_CLIENT_ID);
  auth.searchParams.set('response_type', 'code');
  auth.searchParams.set('scope',         '/authenticate');
  auth.searchParams.set('redirect_uri',  redirect);
  auth.searchParams.set('state',         state);

  return Response.redirect(auth.toString(), 302);
}

async function orcidCallback(request, env) {
  const url      = new URL(request.url);
  const code     = url.searchParams.get('code');
  const rawState = url.searchParams.get('state') || '';
  const { returnTo } = parseState(rawState);
  const landing  = env.LANDING_PAGE || '/';

  if (!code) return html(400, errorPage('ORCID login failed — no code received.', landing));
  if (!env.SESSION_SECRET) return html(500, errorPage('Server misconfiguration: SESSION_SECRET is not set. Please contact the administrator.', landing));

  const redirect = `${url.origin}/auth/orcid/callback`;

  try {
    const tokenResp = await fetch(ORCID_TOKEN, {
      method: 'POST',
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id:     env.ORCID_CLIENT_ID,
        client_secret: env.ORCID_CLIENT_SECRET,
        grant_type:    'authorization_code',
        code,
        redirect_uri:  redirect,
      }),
    });

    if (!tokenResp.ok) {
      const msg = await tokenResp.text();
      return html(502, errorPage(`ORCID token exchange failed (${tokenResp.status}): ${msg}`, landing));
    }

    const data = await tokenResp.json();
    // ORCID returns orcid iD and name directly in the token response
    const session = await makeSession({
      provider: 'orcid',
      id:       data.orcid || data['orcid-identifier']?.path || 'unknown',
      name:     data.name  || '',
    }, env.SESSION_SECRET);

    return new Response(null, {
      status: 302,
      headers: {
        Location: returnTo || env.LANDING_PAGE || '/',
        'Set-Cookie': sessionCookie(session),
      },
    });
  } catch (err) {
    return html(500, errorPage(`ORCID login error: ${err.message}`, landing));
  }
}


// ── Auth middleware ───────────────────────────────────────────────────────────

async function requireAuth(request, env, next) {
  const session = await readSession(request.headers.get('Cookie'), env.SESSION_SECRET);
  if (!session) {
    const returnTo = new URL(request.url).pathname;
    return redirect(`/auth/login?return=${encodeURIComponent(returnTo)}`);
  }
  return next(session);
}

// ── Shared field fragments ────────────────────────────────────────────────────

const DISEASE_ID_FIELD = `
<div class="field">
  <label>Disease identifiers <span style="font-weight:400;color:var(--muted)">(any ontology, any combination)</span></label>
  <div class="id-hint">
    ORPHA:803 &nbsp;·&nbsp; OMIM:105400 &nbsp;·&nbsp; ICD-11:8B60 &nbsp;·&nbsp;
    ICD-10:G12.2 &nbsp;·&nbsp; SNOMED:37340000 &nbsp;·&nbsp; GARD:0005765 &nbsp;·&nbsp;
    MONDO:0004976 &nbsp;·&nbsp; NANDO:1200263
  </div>
  <textarea name="disease_ids" rows="3"
    placeholder="One identifier per line, e.g.&#10;ORPHA:803&#10;OMIM:105400&#10;ICD-10:G12.2"></textarea>
</div>`;

function contributorField(session) {
  const name    = session?.name  || session?.login || session?.id || '';
  const isOrcid = session?.provider === 'orcid';
  const via     = isOrcid
    ? `ORCID — ${session.id}`
    : `GitHub — @${session?.login || session?.id || ''}`;
  return `
<div class="field">
  <label>Contributor — <span style="font-weight:400;color:var(--muted)">collected automatically from your login</span></label>
  <div class="identity-chip">
    <span class="id-name">${name}</span>
    <span class="id-via">via ${via}</span>
  </div>
  <input type="hidden" name="contributor" value="${name}">
</div>`;
}

const HONEYPOT = `<div class="honeypot"><input type="text" name="h_confirm" tabindex="-1" autocomplete="off"></div>`;

// ── Form renderers ────────────────────────────────────────────────────────────

function formDiseaseCase(session, env) {
  const landing = env.LANDING_PAGE || '/';
  const idBar   = identityBar(session, landing);
  const body = `
<div class="notice">Fill in as much as you can — partial entries are welcome.</div>
<form method="POST" action="/submit">
  ${HONEYPOT}
  <input type="hidden" name="form_type" value="disease-case">
  <div class="section-title">Disease identity</div>
  <div class="field">
    <label>Disease name <span class="req">*</span></label>
    <input type="text" name="disease_name" required placeholder="e.g. Amyotrophic Lateral Sclerosis">
  </div>
  ${DISEASE_ID_FIELD}
  <div class="field">
    <label>Registry or data source</label>
    <input type="text" name="registry" placeholder="e.g. ALS TDI Registry, PhenoDB, IAMRARE, RD-Connect…">
  </div>
  <div class="field">
    <label>Registry URL</label>
    <input type="url" name="registry_url" placeholder="https://…">
  </div>
  <div class="section-title" style="margin-top:28px">Clinical narrative</div>
  <div class="field">
    <label>Disease narrative — plain language <span class="req">*</span></label>
    <div class="hint">Describe the typical patient journey. No patient-identifying information.</div>
    <textarea name="narrative" rows="6" required
      placeholder="Onset: …&#10;Diagnostic odyssey: …&#10;Key clinical milestones: …&#10;Current management: …"></textarea>
  </div>
  <div class="field">
    <label>Key timeline events <span style="font-weight:400;color:var(--muted)">(one per line)</span></label>
    <textarea name="timeline_events" rows="4"
      placeholder="age:40y — first symptom&#10;onset+8mo — definitive diagnosis"></textarea>
  </div>
  <div class="section-title" style="margin-top:28px">Data types collected</div>
  <div class="field">
    <div class="cb-group">
      ${['Structured phenotype terms (HPO)','Clinical narrative / free text','Genetic / genomic data',
         'Lab results / biomarkers','Patient-reported outcomes (PROs)','Imaging',
         'Functional assessments','Family history / pedigree','Treatment / medication history',
         'Disease progression / longitudinal follow-up','Environmental / exposure history',
         'Facial / dysmorphology features','Other']
        .map(o => `<label><input type="checkbox" name="data_types" value="${o}"> ${o}</label>`).join('\n')}
    </div>
  </div>
  <div class="section-title" style="margin-top:28px">Phenotype &amp; gaps</div>
  <div class="field">
    <label>HPO phenotype terms <span style="font-weight:400;color:var(--muted)">(if known)</span></label>
    <div class="hint">One per line — look up at <a href="https://hpo.jax.org/" target="_blank">hpo.jax.org</a></div>
    <textarea name="hpo_terms" rows="3" placeholder="HP:0002360 — Sleep disturbance&#10;HP:0003473 — Fatigable weakness"></textarea>
  </div>
  <div class="field">
    <label>What clinical nuance is LOST when encoding this case in structured terms alone?</label>
    <textarea name="narrative_gaps" rows="3"
      placeholder="e.g. Rate of progression, caregiver burden…"></textarea>
  </div>
  <div class="field">
    <label>What information SHOULD be collected but currently is NOT?</label>
    <textarea name="missing_data" rows="3"
      placeholder="e.g. Time from first symptom to first specialist visit…"></textarea>
  </div>
  <div class="section-title" style="margin-top:28px">About you</div>
  ${contributorField(session)}
  <button type="submit" class="btn-submit">Submit disease case →</button>
</form>`;
  return page('Submit a disease case', 'Rare disease narrative, timeline, ontology identifiers', idBar, body, landing);
}

function formOntologyGap(session, env) {
  const landing = env.LANDING_PAGE || '/';
  const idBar   = identityBar(session, landing);
  const ontologies = ['Orphanet (ORDO) — rare disease classification','OMIM — Mendelian / genetic disease',
    'GARD — NIH rare disease catalogue','HPO (Human Phenotype Ontology)',
    'ECTO (Environmental Conditions and Treatments)','ICD-11 — WHO clinical classification (current)',
    'ICD-10 — WHO clinical classification (legacy)','SNOMED CT — clinical terminology',
    'Mondo — cross-ontology harmonisation','NANDO — neurological & neuromuscular diseases',
    'MeSH — NLM indexing vocabulary','DOID — Disease Ontology','Other / multiple not listed'];
  const gapTypes = ['Missing term — concept does not exist in any relevant ontology',
    'Term too broad — no sufficiently specific term','Term too narrow — existing term is over-specified',
    'Wrong axis — concept modelled under incorrect parent',
    'Modifier missing — no qualifier for severity / laterality / progression',
    'Temporal dimension missing — cannot express change over time',
    'Cross-ontology misalignment — same concept modelled inconsistently',
    'Rare disease not represented — disease in ORDO but absent elsewhere',
    'PRO / patient-reported concept out of scope','Caregiver / family impact not modelled','Other'];
  const body = `
<div class="notice">Flag concepts that cannot be adequately expressed using current ontology terms.</div>
<form method="POST" action="/submit">
  ${HONEYPOT}
  <input type="hidden" name="form_type" value="ontology-gap">
  <div class="section-title">Disease context</div>
  <div class="field">
    <label>Disease name <span style="font-weight:400;color:var(--muted)">(if disease-specific)</span></label>
    <input type="text" name="disease_name" placeholder="e.g. ALS, Stargardt — or leave blank for cross-disease gap">
  </div>
  ${DISEASE_ID_FIELD}
  <div class="section-title" style="margin-top:28px">Which ontology has the gap? <span class="req">*</span></div>
  <div class="field">
    <div class="cb-group">
      ${ontologies.map(o => `<label><input type="checkbox" name="ontology" value="${o}"> ${o}</label>`).join('\n')}
    </div>
  </div>
  <div class="field">
    <label>Is this a cross-ontology gap?</label>
    <div class="cb-group">
      <label><input type="checkbox" name="cross_ontology" value="yes">
        Yes — the concept exists in one ontology but is missing or misaligned in another
      </label>
    </div>
  </div>
  <div class="field">
    <label>Cross-ontology detail <span style="font-weight:400;color:var(--muted)">(if applicable)</span></label>
    <textarea name="cross_ontology_detail" rows="3"
      placeholder="Has it: ORPHA:803 (well-defined)&#10;Missing: ICD-11 — no equivalent code"></textarea>
  </div>
  <div class="section-title" style="margin-top:28px">Describing the gap</div>
  <div class="field">
    <label>Clinical concept that cannot be adequately expressed <span class="req">*</span></label>
    <textarea name="concept" rows="4" required
      placeholder="I am trying to represent: …&#10;Closest existing term: ORPHA:XXXX / HP:XXXX (label)&#10;Why it is insufficient: …"></textarea>
  </div>
  <div class="field">
    <label>Type of gap</label>
    <select name="gap_type">
      <option value="">— select —</option>
      ${gapTypes.map(t => `<option>${t}</option>`).join('\n')}
    </select>
  </div>
  <div class="field">
    <label>Concrete clinical examples</label>
    <textarea name="concrete_examples" rows="3" placeholder="e.g. A patient with ALS whose weakness progresses distally to proximally…"></textarea>
  </div>
  <div class="field">
    <label>Proposed solution <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
    <textarea name="proposed_solution" rows="3" placeholder="Suggested new term: …&#10;Suggested parent: HP:XXXXXXX&#10;Definition: …"></textarea>
  </div>
  <div class="field">
    <label>Priority</label>
    <select name="priority">
      <option value="">— select —</option>
      <option>Critical — blocks meaningful data sharing or patient identification</option>
      <option>High — significant clinical information lost in encoding</option>
      <option>Medium — workarounds exist but introduce ambiguity</option>
      <option>Low — minor nuance lost</option>
    </select>
  </div>
  <div class="section-title" style="margin-top:28px">About you</div>
  ${contributorField(session)}
  <button type="submit" class="btn-submit">Submit ontology gap →</button>
</form>`;
  return page('Report an ontology gap', 'Missing or misaligned terms across ORDO, HPO, ICD, SNOMED, Mondo and others', idBar, body, landing);
}

function formDataGap(session, env) {
  const landing = env.LANDING_PAGE || '/';
  const idBar   = identityBar(session, landing);
  const standards = {
    'Exchange formats & data models': ['Phenopackets (GA4GH)','FHIR (HL7) — core resources','FHIR — Genomics Reporting IG','OMOP CDM','openEHR'],
    'International rare disease platforms': ['RD-Connect / GPAP','EUPID','EPIRARE','ERDRI','ERN (European Reference Network) registry'],
    'National & disease-specific registries': ['IAMRARE (Global Genes / NORD)','RARE-X patient registry','ALS TDI Registry','PhenoDB','DECIPHER','NORD Patient Registry'],
    'Ontology-adjacent data models': ['Orphanet data model (ORDO)','GA4GH Variant Representation Specification (VRS)','GA4GH Pedigree Standard'],
  };
  const categories = {
    'Temporal / longitudinal': ['Longitudinal / trajectory data — change over time','Disease progression rate or slope','Age of onset / diagnostic delay','Time from symptom to diagnosis'],
    'Patient experience': ['Patient-reported outcomes not linkable to clinical terms','Quality of life / functional status / disability','Caregiver or family impact','Patient-reported diagnostic odyssey narrative'],
    'Clinical data elements': ['Diagnostic uncertainty or evolving diagnosis','Treatment response / lack of response','Off-label or compassionate use therapies','Imaging findings not mapped to structured terms','Biomarker / lab result without standard code'],
    'Structural / interoperability': ['Cross-registry linkage — same patient in multiple registries','Cross-border data harmonisation','Rare disease not representable in ICD-10','Social determinants of health','Environmental / exposure history','Genetic variant — phenotype correlation not capturable'],
    'Rare disease specific': ['Ultra-rare disease — model too coarse (<10 known cases)','Natural history data missing','No validated outcome measure exists for this disease'],
  };
  const renderGroups = (groups, prefix) => Object.entries(groups).map(([h, items]) =>
    `<div class="cb-subhead">${h}</div>` +
    items.map(i => `<label><input type="checkbox" name="${prefix}" value="${i}"> ${i}</label>`).join('\n')
  ).join('\n');

  const body = `
<div class="notice">Flag structural or coverage gaps in data models, registries, or standards. For missing <em>ontology terms</em>, use the ontology gap form.</div>
<form method="POST" action="/submit">
  ${HONEYPOT}
  <input type="hidden" name="form_type" value="data-gap">
  <div class="section-title">Disease context</div>
  <div class="field">
    <label>Disease name <span style="font-weight:400;color:var(--muted)">(if disease-specific)</span></label>
    <input type="text" name="disease_name" placeholder="e.g. ALS, Stargardt — or leave blank">
  </div>
  ${DISEASE_ID_FIELD}
  <div class="section-title" style="margin-top:28px">Affected standard or system <span class="req">*</span></div>
  <div class="field">
    <div class="cb-group">
      ${renderGroups(standards, 'standards')}
      <div class="cb-subhead">Other</div>
      <label><input type="checkbox" name="standards" value="Other / multiple not listed"> Other / multiple not listed</label>
    </div>
  </div>
  <div class="section-title" style="margin-top:28px">Describing the gap</div>
  <div class="field">
    <label>What cannot be captured and why? <span class="req">*</span></label>
    <textarea name="gap_description" rows="5" required
      placeholder="I am trying to represent: …&#10;The current model handles this by: …&#10;What is lost: …"></textarea>
  </div>
  <div class="section-title" style="margin-top:28px">Category of gap</div>
  <div class="field">
    <div class="cb-group">
      ${renderGroups(categories, 'categories')}
      <div class="cb-subhead">Other</div>
      <label><input type="checkbox" name="categories" value="Other"> Other</label>
    </div>
  </div>
  <div class="field">
    <label>Proposed solution <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
    <textarea name="proposed_solution" rows="3" placeholder="e.g. Add a Measurement element with LOINC code…"></textarea>
  </div>
  <div class="field">
    <label>Priority</label>
    <select name="priority">
      <option value="">— select —</option>
      <option>Critical — blocks meaningful data sharing or cross-registry linkage</option>
      <option>High — significant information loss; no good workaround</option>
      <option>Medium — workarounds exist but introduce ambiguity</option>
      <option>Low — minor nuance lost; workarounds adequate</option>
    </select>
  </div>
  <div class="field">
    <label>Evidence or prior discussion <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
    <textarea name="evidence" rows="2" placeholder="Links to papers, GitHub issues, working group outputs…"></textarea>
  </div>
  <div class="section-title" style="margin-top:28px">About you</div>
  ${contributorField(session)}
  <button type="submit" class="btn-submit">Submit data gap →</button>
</form>`;
  return page('Report a data / model gap', 'Gaps in Phenopackets, FHIR, OMOP, rare disease registries, and exchange standards', idBar, body, landing);
}

function formDiseaseResource(session, env) {
  const landing = env.LANDING_PAGE || '/';
  const idBar   = identityBar(session, landing);

  const resourceTypes = [
    'Scientific paper / preprint',
    'Systematic review / meta-analysis',
    'Clinical guideline / protocol',
    'Expert panel / working group',
    'Excellence centre / reference centre',
    'Patient organisation / advocacy group',
    'Patient registry / database',
    'Social media community (Facebook, Reddit, Discord, …)',
    'News article / media coverage',
    'Documentary / video',
    'Podcast / audio',
    'Conference presentation / poster',
    'Grant / funding programme',
    'Policy document / white paper',
    'Other',
  ];

  const body = `
<div class="notice">Share any resource relevant to a rare disease — a paper, a patient group, an expert panel, a news article, a social media community, or anything else that adds to the collective knowledge.</div>
<form method="POST" action="/submit">
  ${HONEYPOT}
  <input type="hidden" name="form_type" value="disease-resource">

  <div class="section-title">Disease context <span style="font-weight:400;font-size:.85em;text-transform:none">(leave blank for cross-disease resources)</span></div>
  <div class="field">
    <label>Disease name</label>
    <input type="text" name="disease_name" placeholder="e.g. ALS, Duchenne MD — or leave blank">
  </div>
  ${DISEASE_ID_FIELD}

  <div class="section-title" style="margin-top:28px">Resource details</div>
  <div class="field">
    <label>Resource type <span class="req">*</span></label>
    <div class="cb-group">
      ${resourceTypes.map(t => `<label><input type="checkbox" name="resource_type" value="${t}"> ${t}</label>`).join('\n')}
    </div>
  </div>
  <div class="field">
    <label>Title or name <span class="req">*</span></label>
    <input type="text" name="resource_title" required placeholder="e.g. ALS Association, Nature 2023 — Smith et al., ALS Warriors Facebook Group">
  </div>
  <div class="field">
    <label>URL / DOI / link</label>
    <input type="url" name="resource_url" placeholder="https://… or https://doi.org/10.…">
  </div>
  <div class="field">
    <label>Description <span class="req">*</span></label>
    <div class="hint">What does this resource cover? Why is it relevant to the disease?</div>
    <textarea name="description" rows="5" required
      placeholder="e.g. The ALS Association is a US-based patient advocacy organisation providing research funding, patient services, and policy advocacy for ALS. It maintains the ALS Registry and runs the annual Walk to Defeat ALS campaign."></textarea>
  </div>
  <div class="field">
    <label>Language <span style="font-weight:400;color:var(--muted)">(if not English)</span></label>
    <input type="text" name="language" placeholder="e.g. Dutch, French, Spanish">
  </div>
  <div class="field">
    <label>Contact or maintainer <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
    <input type="text" name="contact" placeholder="e.g. info@alsassociation.org, @ALSAssociation">
  </div>
  <div class="field">
    <label>Additional notes <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
    <textarea name="notes" rows="3"
      placeholder="Any caveats, related resources, or context worth noting…"></textarea>
  </div>

  <div class="section-title" style="margin-top:28px">About you</div>
  ${contributorField(session)}
  <button type="submit" class="btn-submit">Submit resource →</button>
</form>`;
  return page('Submit a disease resource', 'Papers, patient organisations, expert panels, communities — any knowledge about a rare disease', idBar, body, landing);
}

function formFeedback(session, env) {
  const landing = env.LANDING_PAGE || '/';
  const idBar   = identityBar(session, landing);
  const body = `
<div class="notice">Tell us what is missing, wrong, or confusing — or propose an entirely new form.</div>
<form method="POST" action="/submit">
  ${HONEYPOT}
  <input type="hidden" name="form_type" value="form-feedback">
  <div class="section-title">Which form? <span class="req">*</span></div>
  <div class="field">
    <div class="cb-group">
      ${['01 — Submit a disease case','02 — Report an ontology gap','03 — Report a data / model gap',
         'All forms (applies across the board)','None — I am proposing a new form']
        .map(o => `<label><input type="checkbox" name="target_form" value="${o}"> ${o}</label>`).join('\n')}
    </div>
  </div>
  <div class="section-title" style="margin-top:28px">Type of feedback <span class="req">*</span></div>
  <div class="field">
    <div class="cb-group">
      ${['Missing field','Field is incomplete','Field is wrong','Field is confusing',
         'Ontology or standard missing from a list','Too many fields','Proposing a new form','Other']
        .map(o => `<label><input type="checkbox" name="feedback_type" value="${o}"> ${o}</label>`).join('\n')}
    </div>
  </div>
  <div class="section-title" style="margin-top:28px">Your perspective</div>
  <div class="field">
    <div class="cb-group">
      ${['Clinician / physician','Clinical geneticist','Genetic counsellor',
         'Nurse / allied health professional','Patient or family member / carer',
         'Patient advocacy organisation','Rare disease registry manager',
         'Biomedical informatician / data engineer','Ontologist / terminology expert',
         'Researcher / scientist','Bioinformatician / computational biologist',
         'Software developer / data architect','Other']
        .map(o => `<label><input type="checkbox" name="perspective" value="${o}"> ${o}</label>`).join('\n')}
    </div>
  </div>
  <div class="section-title" style="margin-top:28px">Your feedback</div>
  <div class="field">
    <label>What is missing, wrong, or confusing? <span class="req">*</span></label>
    <textarea name="what_is_wrong" rows="5" required placeholder="The disease case form has no field for: …"></textarea>
  </div>
  <div class="field">
    <label>Proposed fix <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
    <textarea name="proposed_fix" rows="4" placeholder="Add field: 'Genetic basis'&#10;Type: dropdown&#10;Options: Monogenic, Polygenic…"></textarea>
  </div>
  <div class="section-title" style="margin-top:28px">Proposing a new form? (optional)</div>
  <div class="field">
    <label>Working title</label>
    <input type="text" name="new_form_title" placeholder="e.g. Submit a natural history study">
  </div>
  <div class="field">
    <label>What would it capture?</label>
    <textarea name="new_form_purpose" rows="4" placeholder="Who: …&#10;Purpose: …&#10;Key fields: …"></textarea>
  </div>
  <div class="section-title" style="margin-top:28px">About you</div>
  ${contributorField(session)}
  <button type="submit" class="btn-submit">Submit feedback →</button>
</form>`;
  return page('Feedback on these forms', 'Missing fields, wrong framing, or a proposal for an entirely new form', idBar, body, landing);
}

// ── Issue body builders ───────────────────────────────────────────────────────

function section(heading, value) {
  if (!value || (Array.isArray(value) && value.length === 0)) return '';
  const content = Array.isArray(value) ? value.map(v => `- ${v}`).join('\n') : String(value).trim();
  if (!content) return '';
  return `\n### ${heading}\n${content}\n`;
}

function identitySection(session) {
  if (!session) return '';
  if (session.provider === 'orcid') {
    return `\n### Submitted by\nORCID: [${session.id}](https://orcid.org/${session.id})${session.name ? ` — ${session.name}` : ''}\n`;
  }
  return `\n### Submitted by\nGitHub: @${session.login || session.id}${session.name ? ` (${session.name})` : ''}\n`;
}

async function handleSubmit(request, env) {
  const landing = env.LANDING_PAGE || '/';
  const session = await readSession(request.headers.get('Cookie'), env.SESSION_SECRET);

  if (!session) return redirect('/auth/login');

  let fd;
  try { fd = await request.formData(); }
  catch { return html(400, errorPage('Could not read form data.', landing)); }

  if (fd.get('h_confirm')) return html(200, thankyouPage(null, landing)); // honeypot

  const formType = fd.get('form_type');
  let issue;

  if (formType === 'disease-case') {
    issue = {
      title:  `[CASE] ${fd.get('disease_name') || 'Unnamed disease'}`,
      labels: ['disease-case', 'needs-mapping'],
      body: [
        identitySection(session),
        section('Disease name',          fd.get('disease_name')),
        section('Disease identifiers',   fd.get('disease_ids')),
        section('Registry',              fd.get('registry')),
        section('Registry URL',          fd.get('registry_url')),
        section('Disease narrative',     fd.get('narrative')),
        section('Timeline events',       fd.get('timeline_events')),
        section('Data types collected',  fd.getAll('data_types')),
        section('HPO terms',             fd.get('hpo_terms')),
        section('Clinical nuance lost',  fd.get('narrative_gaps')),
        section('Missing information',   fd.get('missing_data')),
        section('Contributor',           fd.get('contributor')),
        '\n---\n_Submitted via BYOD web form_',
      ].join(''),
    };
  } else if (formType === 'ontology-gap') {
    const crossOntology = fd.get('cross_ontology') === 'yes';
    issue = {
      title:  `[GAP-ONTOLOGY] ${fd.get('disease_name') || 'unspecified'}`,
      labels: ['ontology-gap'],
      body: [
        identitySection(session),
        section('Disease name',        fd.get('disease_name')),
        section('Disease identifiers', fd.get('disease_ids')),
        section('Ontology with gap',   fd.getAll('ontology')),
        crossOntology ? section('Cross-ontology gap', 'Yes — concept exists in one ontology but missing or misaligned in another') : '',
        crossOntology ? section('Cross-ontology detail', fd.get('cross_ontology_detail')) : '',
        section('Clinical concept',    fd.get('concept')),
        section('Type of gap',         fd.get('gap_type')),
        section('Clinical examples',   fd.get('concrete_examples')),
        section('Proposed solution',   fd.get('proposed_solution')),
        section('Priority',            fd.get('priority')),
        section('Contributor',         fd.get('contributor')),
        '\n---\n_Submitted via BYOD web form_',
      ].join(''),
    };
  } else if (formType === 'data-gap') {
    issue = {
      title:  `[GAP-DATA] ${fd.get('disease_name') || 'unspecified'}`,
      labels: ['data-gap'],
      body: [
        identitySection(session),
        section('Disease name',            fd.get('disease_name')),
        section('Disease identifiers',     fd.get('disease_ids')),
        section('Affected standards',      fd.getAll('standards')),
        section('What cannot be captured', fd.get('gap_description')),
        section('Gap categories',          fd.getAll('categories')),
        section('Proposed solution',       fd.get('proposed_solution')),
        section('Priority',                fd.get('priority')),
        section('Evidence',                fd.get('evidence')),
        section('Contributor',             fd.get('contributor')),
        '\n---\n_Submitted via BYOD web form_',
      ].join(''),
    };
  } else if (formType === 'form-feedback') {
    issue = {
      title:  `[FORM] ${fd.get('new_form_title') || 'Form feedback'}`,
      labels: ['form-feedback', 'meta'],
      body: [
        identitySection(session),
        section('Target form(s)',      fd.getAll('target_form')),
        section('Type of feedback',    fd.getAll('feedback_type')),
        section('Perspective',         fd.getAll('perspective')),
        section('What is wrong',       fd.get('what_is_wrong')),
        section('Proposed fix',        fd.get('proposed_fix')),
        section('New form title',      fd.get('new_form_title')),
        section('New form purpose',    fd.get('new_form_purpose')),
        section('Contributor',         fd.get('contributor')),
        '\n---\n_Submitted via BYOD web form_',
      ].join(''),
    };
  } else if (formType === 'disease-resource') {
    issue = {
      title:  `[RESOURCE] ${fd.get('resource_title') || 'Untitled resource'}`,
      labels: ['disease-resource'],
      body: [
        identitySection(session),
        section('Disease name',        fd.get('disease_name')),
        section('Disease identifiers', fd.get('disease_ids')),
        section('Resource type',       fd.getAll('resource_type')),
        section('Title / name',        fd.get('resource_title')),
        section('URL / DOI',           fd.get('resource_url')),
        section('Description',         fd.get('description')),
        section('Language',            fd.get('language')),
        section('Contact / maintainer',fd.get('contact')),
        section('Additional notes',    fd.get('notes')),
        section('Contributor',         fd.get('contributor')),
        '\n---\n_Submitted via BYOD web form_',
      ].join(''),
    };
  } else {
    return html(400, errorPage('Unknown form type.', landing));
  }

  if (!env.GITHUB_TOKEN) return html(500, errorPage('Server not configured (missing GITHUB_TOKEN).', landing));

  // ── Mirror write to Forgejo (non-fatal, fires in parallel) ──────────────────
  // Enabled when FORGEJO_TOKEN + FORGEJO_REPO are set in wrangler.toml / secrets.
  if (env.FORGEJO_TOKEN && env.FORGEJO_REPO) {
    const base = env.FORGEJO_BASE_URL || 'https://codeberg.org';
    fetch(`${base}/api/v1/repos/${env.FORGEJO_REPO}/issues`, {
      method:  'POST',
      headers: {
        'Authorization': `token ${env.FORGEJO_TOKEN}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify(issue),
    }).catch(e => console.error('Forgejo mirror write failed (non-fatal):', e.message));
  }

  // ── Primary write to GitHub ──────────────────────────────────────────────────
  const resp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept':        'application/vnd.github.v3+json',
      'Content-Type':  'application/json',
      'User-Agent':    'byod-form-receiver/1.0',
    },
    body: JSON.stringify(issue),
  });

  if (!resp.ok) {
    const msg = await resp.text();
    console.error('GitHub API error', resp.status, msg);
    return html(502, errorPage(`GitHub API returned ${resp.status}. Please try again.`, landing));
  }

  const created = await resp.json();
  return html(200, thankyouPage(created.html_url, landing));
}

// ── Result pages ──────────────────────────────────────────────────────────────

function thankyouPage(issueUrl, landing) {
  const issueLink = issueUrl
    ? `<p>Your submission is publicly visible at:<br><a href="${issueUrl}" target="_blank" rel="noopener">${issueUrl}</a></p>`
    : '';
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Submitted · Bring Your Own Disease</title><style>${CSS}</style></head><body>
  <div class="thankyou">
    <h1>Thank you!</h1>
    <p>Your contribution has been received and added to the session repository.</p>
    ${issueLink}
    <p style="margin-top:12px;font-size:13px;color:var(--muted)">The session team will review and convert it to FAIR data.</p>
    <a class="btn-back" href="${landing}">← Back to session page</a>
  </div></body></html>`;
}

function errorPage(msg, landing) {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Error · Bring Your Own Disease</title><style>${CSS}</style></head><body>
  <div class="thankyou">
    <h1>Something went wrong</h1>
    <div class="error-box">${msg}</div>
    <a class="btn-back" href="${landing}">← Back to session page</a>
  </div></body></html>`;
}

// ── Auth status (cross-origin, credentialed) ──────────────────────────────────

async function authStatus(request, env) {
  const session = await readSession(request.headers.get('Cookie'), env.SESSION_SECRET);
  const origin  = request.headers.get('Origin') || '';
  // Allow credentialed reads from the landing page origin
  const allowed = env.LANDING_PAGE
    ? new URL(env.LANDING_PAGE).origin
    : 'https://fdp.semscape.org';
  const body = session
    ? JSON.stringify({
        loggedIn:  true,
        name:      session.name || session.login || session.id || '',
        provider:  session.provider,
        id:        session.id || session.login || '',
      })
    : JSON.stringify({ loggedIn: false });
  return new Response(body, {
    headers: {
      'Content-Type':                'application/json',
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Credentials': 'true',
      'Cache-Control':               'no-store',
    },
  });
}

// ── Router ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url     = new URL(request.url);
    const path    = url.pathname;
    const landing = env.LANDING_PAGE || '/';

    // ── Auth routes (no session required) ────────────────────────────────────
    if (path === '/auth/status')         return authStatus(request, env);
    if (path === '/auth/login')          return html(200, loginPage(url.searchParams.get('return') || env.LANDING_PAGE || '/', env));
    if (path === '/auth/orcid')          return orcidStart(request, env);
    if (path === '/auth/orcid/callback') return orcidCallback(request, env);
    if (path === '/auth/logout') {
      return new Response(null, {
        status: 302,
        headers: { Location: landing, 'Set-Cookie': sessionCookie('', 0) },
      });
    }

    // ── Form routes (session required) ────────────────────────────────────────
    if (request.method === 'GET') {
      if (path === '/forms/disease-case')     return requireAuth(request, env, s => html(200, formDiseaseCase(s, env)));
      if (path === '/forms/ontology-gap')     return requireAuth(request, env, s => html(200, formOntologyGap(s, env)));
      if (path === '/forms/data-gap')         return requireAuth(request, env, s => html(200, formDataGap(s, env)));
      if (path === '/forms/form-feedback')    return requireAuth(request, env, s => html(200, formFeedback(s, env)));
      if (path === '/forms/disease-resource') return requireAuth(request, env, s => html(200, formDiseaseResource(s, env)));
      if (path === '/' || path === '')     return redirect(landing);
    }

    if (request.method === 'POST' && path === '/submit') return handleSubmit(request, env);

    return new Response('Not found', { status: 404 });
  },
};
