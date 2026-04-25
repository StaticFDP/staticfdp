# ORCID-Authenticated GitHub Issues Forms

A step-by-step guide to adding ORCID login to any static HTML form that
submits to GitHub Issues — with no server, no database, and no password
management. The submitter's ORCID iD and (optionally) their RoR organisation
are recorded automatically as part of every issue.

---

## How it works

```
Static page → /auth/login → ORCID OAuth → Worker callback
    ↑                                            │
    └──── redirect back with ?orcid_id=… ────────┘
    
User fills form → POST /submit → Worker creates GitHub Issue
```

1. The user clicks "Sign in with ORCID" on your static page  
2. They are redirected to a **Cloudflare Worker** which starts the ORCID OAuth flow  
3. After approval ORCID sends them back to the Worker; the Worker looks up their
   employer in the ORCID Employments API to derive a **RoR organisation ID**  
4. The Worker redirects back to your page with identity fields in the URL:
   `?orcid_id=0000-…&orcid_name=Jane+Doe&ror_id=…&ror_name=…`  
5. Your page stores these in `sessionStorage` and pre-fills the form  
6. On submit the Worker posts a structured GitHub Issue to your repo using the
   identity fields, a GitHub fine-grained PAT, and optionally a Codeberg/Forgejo
   token for a EU mirror

No GitHub account is required from the submitter. No cookies are needed on your
static page. The Worker's HMAC-signed session cookie only matters for server-side
form pages (see §5).

---

## Prerequisites

| What | Where to get it |
|---|---|
| ORCID public API client | [orcid.org/developer-tools](https://orcid.org/developer-tools) — free |
| Cloudflare account (Workers free tier) | [cloudflare.com](https://cloudflare.com) |
| GitHub fine-grained PAT | Repo settings → Developer settings → Fine-grained tokens; scope: **Issues: Read & Write** |
| (optional) Codeberg/Forgejo token | User settings → Applications |

---

## 1 — Set up the Cloudflare Worker

### 1.1 Create the project

```bash
npm create cloudflare@latest my-form-worker
cd my-form-worker
```

### 1.2 `wrangler.toml`

```toml
name            = "my-form-worker"
main            = "src/index.js"
compatibility_date = "2024-09-23"

[vars]
GITHUB_REPO             = "OWNER/REPO"
LANDING_PAGE            = "https://your-static-site.example.org/"
# Comma-separated list of origins allowed as post-login redirect targets.
# Your static site's origin must be listed here.
ALLOWED_RETURN_ORIGINS  = "https://your-static-site.example.org"

# Optional EU mirror (Codeberg/Forgejo)
# FORGEJO_BASE_URL = "https://codeberg.org"
# FORGEJO_REPO     = "OWNER/REPO"
```

### 1.3 Set secrets (run once, never committed)

```bash
wrangler secret put GITHUB_TOKEN        # fine-grained PAT
wrangler secret put ORCID_CLIENT_ID
wrangler secret put ORCID_CLIENT_SECRET
wrangler secret put SESSION_SECRET      # any random 32+ char string
# wrangler secret put FORGEJO_TOKEN     # optional
```

### 1.4 Register your redirect URI with ORCID

In your ORCID developer app settings add:

```
https://my-form-worker.YOUR-SUBDOMAIN.workers.dev/auth/orcid/callback
```

---

## 2 — Worker skeleton

Below is the minimal Worker that handles ORCID login, RoR derivation, and
GitHub Issue creation. Copy this into `src/index.js` and add your form logic.

```javascript
// ── Constants ────────────────────────────────────────────────────────────────

const SESSION_COOKIE  = 'form_session';
const SESSION_TTL     = 60 * 60 * 24;          // 24 h
const ORCID_AUTH      = 'https://orcid.org/oauth/authorize';
const ORCID_TOKEN     = 'https://orcid.org/oauth/token';
const ORCID_API_PUB   = 'https://pub.orcid.org/v3.0';
const ORCID_API_W     = 'https://api.orcid.org/v3.0';

// ── HMAC session helpers ──────────────────────────────────────────────────────

async function makeSession(payload, secret) {
  const data   = JSON.stringify({ ...payload, exp: Date.now() + SESSION_TTL * 1000 });
  const key    = await importHmacKey(secret);
  const sig    = b64(await crypto.subtle.sign('HMAC', key, enc(data)));
  return b64(enc(data)) + '.' + sig;
}

async function readSession(cookieHeader, secret) {
  if (!cookieHeader || !secret) return null;
  const raw = cookieHeader.split(';').map(c => c.trim())
    .find(c => c.startsWith(SESSION_COOKIE + '='));
  if (!raw) return null;
  const value = raw.slice(SESSION_COOKIE.length + 1);
  try {
    const [datab64, sigb64] = value.split('.');
    const dataBytes = decb64(datab64);
    const key       = await importHmacKey(secret);
    const valid     = await crypto.subtle.verify('HMAC', key, decb64(sigb64), dataBytes);
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(dataBytes));
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch { return null; }
}

async function importHmacKey(s) {
  return crypto.subtle.importKey('raw', enc(s), { name:'HMAC', hash:'SHA-256' }, false, ['sign','verify']);
}

const enc    = s   => new TextEncoder().encode(s);
const b64    = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const decb64 = s   => Uint8Array.from(atob(s), c => c.charCodeAt(0));

function sessionCookie(value) {
  return `${SESSION_COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL}`;
}

// ── OAuth state ───────────────────────────────────────────────────────────────

function makeState(returnTo) {
  const rand = b64(crypto.getRandomValues(new Uint8Array(16)));
  return encodeURIComponent(JSON.stringify({ rand, returnTo }));
}

function parseState(raw) {
  try { return JSON.parse(decodeURIComponent(raw)); }
  catch { return { returnTo: '/' }; }
}

// ── Return-URL allowlist (prevents open-redirect abuse) ───────────────────────

function isAllowedReturn(returnTo, workerOrigin, env) {
  try {
    const dest = new URL(returnTo);
    if (dest.origin === workerOrigin) return true;
    const allowed = (env.ALLOWED_RETURN_ORIGINS || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    return allowed.some(o => dest.origin === o);
  } catch { return false; }
}

// ── RoR derivation from ORCID employments ─────────────────────────────────────
// Finds the first current employment that has a RoR disambiguated-organisation.
// Requires /read-limited scope (to see private entries too).

async function fetchOrcidRoR(orcidId, accessToken) {
  try {
    const resp = await fetch(`${ORCID_API_PUB}/${orcidId}/employments`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    for (const group of (data['affiliation-group'] || [])) {
      for (const item of (group.summaries || [])) {
        const emp = item['employment-summary'];
        if (!emp || emp['end-date']) continue;        // skip past positions
        const org    = emp.organization;
        const disamb = org?.['disambiguated-organization'];
        if (disamb?.['disambiguation-source'] === 'ROR') {
          return {
            ror_id:      disamb['disambiguated-organization-identifier'],
            ror_name:    org.name || '',
            ror_country: org?.address?.country || '',
          };
        }
      }
    }
  } catch {}
  return null;
}

// ── ORCID OAuth ───────────────────────────────────────────────────────────────

function orcidStart(request, env) {
  const url      = new URL(request.url);
  const returnTo = url.searchParams.get('return') || env.LANDING_PAGE || '/';
  const auth     = new URL(ORCID_AUTH);
  auth.searchParams.set('client_id',     env.ORCID_CLIENT_ID);
  auth.searchParams.set('response_type', 'code');
  // /read-limited  — read private employments (for RoR derivation)
  // /activities/update — write employment back (for "Save to ORCID" UX)
  // Remove /activities/update if you don't need write-back.
  auth.searchParams.set('scope',         '/authenticate /read-limited /activities/update');
  auth.searchParams.set('redirect_uri',  `${url.origin}/auth/orcid/callback`);
  auth.searchParams.set('state',         makeState(returnTo));
  return Response.redirect(auth.toString(), 302);
}

async function orcidCallback(request, env) {
  const url         = new URL(request.url);
  const code        = url.searchParams.get('code');
  const { returnTo } = parseState(url.searchParams.get('state') || '');
  const landing     = env.LANDING_PAGE || '/';

  if (!code) return new Response('ORCID login failed — no code.', { status: 400 });

  const tokenResp = await fetch(ORCID_TOKEN, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.ORCID_CLIENT_ID, client_secret: env.ORCID_CLIENT_SECRET,
      grant_type: 'authorization_code', code,
      redirect_uri: `${url.origin}/auth/orcid/callback`,
    }),
  });
  if (!tokenResp.ok) return new Response('Token exchange failed', { status: 502 });

  const data        = await tokenResp.json();
  const orcidId     = data.orcid || data['orcid-identifier']?.path || 'unknown';
  const orcidName   = data.name  || '';
  const accessToken = data.access_token || '';

  const ror     = await fetchOrcidRoR(orcidId, accessToken);
  const session = await makeSession({
    provider: 'orcid', id: orcidId, name: orcidName, access_token: accessToken,
    ror_id: ror?.ror_id || '', ror_name: ror?.ror_name || '', ror_country: ror?.ror_country || '',
  }, env.SESSION_SECRET);

  // Validate return URL; fall back to landing page if disallowed
  const safe = returnTo && isAllowedReturn(returnTo, url.origin, env) ? returnTo : landing;
  const dest  = new URL(safe, url.origin);

  // Append identity as URL params — readable by any static page without cookies
  dest.searchParams.set('orcid_id',   orcidId);
  dest.searchParams.set('orcid_name', orcidName);
  if (ror) {
    dest.searchParams.set('ror_id',      ror.ror_id);
    dest.searchParams.set('ror_name',    ror.ror_name);
    dest.searchParams.set('ror_country', ror.ror_country);
  }

  const headers = new Headers({ Location: dest.toString() });
  headers.append('Set-Cookie', sessionCookie(session));
  if (ror) {
    // Non-HttpOnly cookies: readable by JS on same-origin pages
    const ck = (k, v) => `${k}=${encodeURIComponent(v)}; Path=/; SameSite=Lax; Max-Age=${SESSION_TTL}`;
    headers.append('Set-Cookie', ck('ror_id',      ror.ror_id));
    headers.append('Set-Cookie', ck('ror_name',    ror.ror_name));
    headers.append('Set-Cookie', ck('ror_country', ror.ror_country));
  }
  return new Response(null, { status: 302, headers });
}

// ── GitHub Issue creation ─────────────────────────────────────────────────────
// Call this from your POST /submit handler after reading the session.

async function createGitHubIssue(env, { title, body, labels = [] }) {
  const resp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${env.GITHUB_TOKEN}`,
      Accept:         'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent':   'my-form-worker/1.0',
    },
    body: JSON.stringify({ title, body, labels }),
  });
  if (!resp.ok) throw new Error(`GitHub ${resp.status}: ${await resp.text()}`);
  return resp.json();
}

// ── Drop-in identity script (/orcid-identity.js) ─────────────────────────────

function orcidIdentityScript(request) {
  const workerUrl = new URL(request.url).origin;
  const js = `
(function () {
  var WORKER = '${workerUrl}';
  var KEYS   = ['orcid_id','orcid_name','ror_id','ror_name','ror_country'];

  var p = new URLSearchParams(location.search);
  if (p.get('orcid_id')) {
    KEYS.forEach(function(k) { if (p.get(k)) sessionStorage.setItem(k, p.get(k)); });
    var clean = new URL(location.href);
    KEYS.forEach(function(k) { clean.searchParams.delete(k); });
    history.replaceState({}, '', clean.toString());
  }

  window.OrcidIdentity = {
    get loggedIn()   { return !!sessionStorage.getItem('orcid_id'); },
    get id()         { return sessionStorage.getItem('orcid_id')    || ''; },
    get name()       { return sessionStorage.getItem('orcid_name')  || ''; },
    get rorId()      { return sessionStorage.getItem('ror_id')      || ''; },
    get rorName()    { return sessionStorage.getItem('ror_name')    || ''; },
    get rorCountry() { return sessionStorage.getItem('ror_country') || ''; },
    loginUrl: function(returnTo) {
      return WORKER + '/auth/login?return=' + encodeURIComponent(returnTo || location.href);
    },
    logout: function() { KEYS.forEach(function(k) { sessionStorage.removeItem(k); }); },
  };

  // Auto-render into <span data-orcid-badge></span>
  function renderBadge() {
    var el = document.querySelector('[data-orcid-badge]');
    if (!el) return;
    var chip = 'display:inline-flex;align-items:center;gap:6px;font-size:13px;' +
               'background:#a6ce39;color:#000;padding:4px 12px;border-radius:20px;font-weight:600;';
    if (window.OrcidIdentity.loggedIn) {
      el.innerHTML = '<span style="' + chip + '">' +
        window.OrcidIdentity.name + ' · ' + window.OrcidIdentity.id + '<\/span>';
    } else {
      el.innerHTML = '<a href="' + window.OrcidIdentity.loginUrl() +
        '" style="' + chip + 'text-decoration:none;">Sign in with ORCID<\/a>';
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', renderBadge);
  } else { renderBadge(); }

  document.dispatchEvent(new CustomEvent('orcid-identity', { detail: window.OrcidIdentity }));
})();`;
  return new Response(js, {
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ── Router ────────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url  = new URL(request.url);
    const path = url.pathname;

    if (path === '/orcid-identity.js')   return orcidIdentityScript(request);
    if (path === '/auth/login')          return Response.redirect(
      `${url.origin}/auth/orcid?return=${url.searchParams.get('return') || ''}`, 302);
    if (path === '/auth/orcid')          return orcidStart(request, env);
    if (path === '/auth/orcid/callback') return orcidCallback(request, env);

    if (request.method === 'POST' && path === '/submit') {
      const session = await readSession(request.headers.get('Cookie'), env.SESSION_SECRET);
      if (!session) return new Response('Unauthorised', { status: 401 });

      const body = await request.json();
      // Build your issue title and body here, using session.id (ORCID),
      // session.ror_name, and any fields from the submitted form.
      const issue = await createGitHubIssue(env, {
        title: body.title || 'New submission',
        body:  formatIssueBody(body, session),
        labels: ['submission'],
      });
      return new Response(JSON.stringify({ url: issue.html_url }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};

// ── Issue body formatter (customise for your form) ────────────────────────────

function formatIssueBody(form, session) {
  return [
    `### Submission`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    // Add your form fields here, e.g.:
    // `| Title | ${form.title} |`,
    ``,
    `### Submitted by`,
    `- **ORCID:** https://orcid.org/${session.id}`,
    session.name       ? `- **Name:** ${session.name}` : '',
    session.ror_name   ? `- **Organisation:** [${session.ror_name}](https://ror.org/${session.ror_id})` : '',
    session.ror_country ? `- **Country:** ${session.ror_country}` : '',
  ].filter(Boolean).join('\n');
}
```

---

## 3 — Drop-in identity script

Include one script tag on any static page:

```html
<script src="https://YOUR-WORKER.workers.dev/orcid-identity.js"></script>
```

The script:
- Reads `orcid_id`, `orcid_name`, `ror_id`, `ror_name`, `ror_country` from the
  URL after the ORCID redirect and moves them into `sessionStorage`
- Cleans the URL so the params don't stay visible in the address bar
- Exposes `window.OrcidIdentity` (see §4)
- Auto-renders a badge into any element with `data-orcid-badge`
- Fires a `'orcid-identity'` DOM event when ready

### Auto badge

```html
<span data-orcid-badge></span>
```

Shows "Sign in with ORCID" (linked to the worker login) when logged out, or the
user's name + ORCID iD when logged in.

---

## 4 — `window.OrcidIdentity` API

```javascript
OrcidIdentity.loggedIn   // boolean
OrcidIdentity.id         // "0000-0001-9773-4008"
OrcidIdentity.name       // "Andra Waagmeester"
OrcidIdentity.rorId      // "https://ror.org/027bh9e22" or ""
OrcidIdentity.rorName    // "Micelio" or ""
OrcidIdentity.rorCountry // "BE" or ""
OrcidIdentity.loginUrl(returnTo?)   // full URL to the worker login page
OrcidIdentity.logout()              // clears sessionStorage
```

---

## 5 — Adding login to a static form

### Minimal HTML pattern

```html
<!DOCTYPE html>
<html>
<head>
  <title>Submit a record</title>
</head>
<body>

<!-- 1. Include the identity script -->
<script src="https://YOUR-WORKER.workers.dev/orcid-identity.js"></script>

<!-- 2. Auth banner — shown before login -->
<div id="auth-banner">
  <span data-orcid-badge></span>
</div>

<!-- 3. Your form -->
<form id="my-form">
  <label>Title <input name="title" required></label>
  <!-- hidden field auto-filled from identity -->
  <input type="hidden" name="submitted_by" id="submitted-by">
  <input type="hidden" name="organisation" id="organisation">
  <button type="submit">Submit</button>
</form>

<script>
  // Fill hidden fields once identity is known
  document.addEventListener('orcid-identity', function(e) {
    var id = e.detail;
    document.getElementById('submitted-by').value = id.id;
    document.getElementById('organisation').value  = id.rorName;

    // Disable form if not logged in
    document.querySelector('#my-form button').disabled = !id.loggedIn;
  });

  document.getElementById('my-form').addEventListener('submit', async function(e) {
    e.preventDefault();
    const form = Object.fromEntries(new FormData(e.target));
    const resp = await fetch('https://YOUR-WORKER.workers.dev/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',           // sends session cookie
      body: JSON.stringify(form),
    });
    if (resp.ok) {
      const { url } = await resp.json();
      alert('Submitted! Issue: ' + url);
    }
  });
</script>
</body>
</html>
```

### No-worker fallback: GitHub issue template pre-fill

If you don't want to use the Worker for submission (or as a fallback), pre-fill
a GitHub issue template URL and open it directly:

```javascript
document.addEventListener('orcid-identity', function(e) {
  var id = e.detail;
  if (!id.loggedIn) return;

  var params = new URLSearchParams({
    template:     'my-template.yml',
    submitted_by: id.id,
    organisation: id.rorName,
    title:        'New submission from ' + id.name,
  });

  document.getElementById('github-btn').href =
    'https://github.com/OWNER/REPO/issues/new?' + params.toString();
});
```

```html
<a id="github-btn" href="#" target="_blank">Open GitHub Issue →</a>
```

---

## 6 — GitHub Issue template

Create `.github/ISSUE_TEMPLATE/my-template.yml`:

```yaml
name: My form
description: Describe what this form is for
labels: ["submission"]
body:
  - type: input
    id: submitted_by
    attributes:
      label: Submitted by (ORCID)
      description: Your ORCID iD — filled automatically if you signed in
    validations:
      required: true

  - type: input
    id: organisation
    attributes:
      label: Organisation (RoR)
      description: Your organisation — derived from your ORCID profile
    validations:
      required: false

  - type: input
    id: title
    attributes:
      label: Title
    validations:
      required: true

  # Add more fields here
```

---

## 7 — Security checklist

| Item | Why |
|---|---|
| Set `ALLOWED_RETURN_ORIGINS` | Prevents using your worker as an open redirect to steal tokens |
| Use a random `SESSION_SECRET` (32+ chars) | HMAC signature keeps sessions tamper-proof |
| Grant the PAT only Issues: R&W on the specific repo | Least-privilege principle |
| Use `/read-limited` ORCID scope | Reads private employments for RoR; without it only public employers are found |
| Drop `/activities/update` if you don't write back | Minimise OAuth scopes requested |
| `SameSite=Lax` + `HttpOnly` on session cookie | Prevents CSRF and JS access to the auth token |

---

## 8 — Deploying to Cloudflare

```bash
wrangler deploy
```

The first deploy shows your worker URL (`https://my-form-worker.YOUR-SUBDOMAIN.workers.dev`).
Go back to your ORCID developer app and add that URL + `/auth/orcid/callback` as a redirect URI.

### Custom domain (optional)

```toml
# wrangler.toml
routes = [{ pattern = "forms.example.org", custom_domain = true }]
```

---

## 9 — Writing RoR back to ORCID (optional)

If a user's RoR is missing from their ORCID profile, offer to add it.
The Worker needs the `/activities/update` scope (already in §2).

```javascript
// POST /auth/orcid/update-affiliation from your page
await fetch('https://YOUR-WORKER.workers.dev/auth/orcid/update-affiliation', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ ror_id: '...', ror_name: '...', country: 'NL' }),
});
```

Worker endpoint:

```javascript
async function updateAffiliation(request, env) {
  const session = await readSession(request.headers.get('Cookie'), env.SESSION_SECRET);
  if (!session?.access_token) return new Response('Unauthorised', { status: 401 });

  const { ror_id, ror_name, country } = await request.json();
  const body = {
    'employment-summary': {
      organization: {
        name: ror_name,
        address: { city: '', region: '', country },
        'disambiguated-organization': {
          'disambiguated-organization-identifier': ror_id,
          'disambiguation-source': 'ROR',
        },
      },
    },
  };
  const resp = await fetch(`${ORCID_API_W}/${session.id}/employment`, {
    method: 'POST',
    headers: {
      Authorization:  `Bearer ${session.access_token}`,
      Accept:         'application/vnd.orcid+json',
      'Content-Type': 'application/vnd.orcid+json',
    },
    body: JSON.stringify(body),
  });
  return new Response(JSON.stringify({ ok: resp.ok }), {
    status: resp.ok ? 200 : resp.status,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

---

## 10 — Adapting to Gitlab / Forgejo

Replace `createGitHubIssue` with the appropriate API call:

**GitLab:**
```javascript
fetch(`${GITLAB_BASE}/api/v4/projects/${encodeURIComponent(PROJECT_ID)}/issues`, {
  method: 'POST',
  headers: { 'PRIVATE-TOKEN': env.GITLAB_TOKEN, 'Content-Type': 'application/json' },
  body: JSON.stringify({ title, description: body, labels: labels.join(',') }),
});
```

**Forgejo / Codeberg:**
```javascript
fetch(`${FORGEJO_BASE}/api/v1/repos/${OWNER}/${REPO}/issues`, {
  method: 'POST',
  headers: { Authorization: `token ${env.FORGEJO_TOKEN}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ title, body, labels }),
});
```

---

## Summary

| Component | Purpose |
|---|---|
| `ORCID developer app` | OAuth client credentials |
| `Cloudflare Worker` | ORCID OAuth, RoR lookup, session, Issue POST |
| `/orcid-identity.js` | Drop-in script for any static page |
| `window.OrcidIdentity` | JS API exposing id, name, ror* |
| `ALLOWED_RETURN_ORIGINS` | Security: which domains can receive the post-login redirect |
| GitHub Issue template | Structured data capture; ORCID/RoR fields pre-filled |
