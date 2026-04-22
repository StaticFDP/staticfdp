# StaticFDP Ecosystem — Deployment Guide

This guide explains how to deploy the three layers of the StaticFDP ecosystem
(**staticfdp**, **staticfdp-index**, **staticfdp-vp**) across four infrastructure
modes — from a simple GitHub Pages setup to a fully air-gapped internal GitLab
instance.

---

## 1. Choose your deployment mode

Start here. Pick the mode that matches your jurisdiction, security requirements,
and available infrastructure.

| Mode | Hosting | CI/CD | Best for |
|------|---------|-------|----------|
| **A — GitHub** | GitHub Pages | GitHub Actions | Quick start, no restrictions on metadata |
| **B — Codeberg** | Codeberg Pages | Woodpecker CI | EU-only, GDPR preference, non-US jurisdiction |
| **C — Dual (active-active)** | Both simultaneously | Both CI systems | Maximum availability, community visibility |
| **D — Self-hosted** | GitLab Pages / Gitea / any static host | GitLab CI / Forgejo Actions / Woodpecker | Sensitive metadata, internal networks, air-gapped, regional instances |

```
Is your metadata public?
    ├── Yes, and GitHub jurisdiction is fine → Mode A
    ├── Yes, but must stay in EU → Mode B or C
    └── No (restricted/internal) → Mode D
             ├── Have GitLab? → Mode D-GitLab
             ├── Have Gitea/Forgejo? → Mode D-Gitea
             └── Other static host? → Mode D-Generic
```

> **Note on what "metadata" means here:** The data itself never enters the
> StaticFDP system — only DCAT-formatted *pointers* (titles, URLs, descriptions,
> licenses). Even so, some institutions require that even descriptive metadata
> live on internal infrastructure.

---

## Mode A — GitHub Pages + GitHub Actions

The default. Requires a GitHub account and a public repository.

### Prerequisites
- GitHub account
- ORCID developer app (free at [orcid.org/developer-tools](https://orcid.org/developer-tools))
- Cloudflare account for the worker (free tier sufficient)

### Steps

```bash
# 1. Use the template repository
#    Go to https://github.com/StaticFDP/staticfdp → "Use this template"
#    Name your repo, make it public

# 2. Clone and configure
git clone https://github.com/YOUR-ORG/YOUR-REPO
cd YOUR-REPO
bash scripts/setup.sh          # sets vp-config.yaml / fdp-config.yaml

# 3. Enable GitHub Pages
#    Settings → Pages → Branch: main, Folder: /docs → Save

# 4. Deploy the worker (handles ORCID login + issue submission)
cd worker
cp wrangler.toml.example wrangler.toml
# Edit wrangler.toml: set GITHUB_REPO and LANDING_PAGE
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN     # fine-grained PAT: Issues read/write
npx wrangler secret put ORCID_CLIENT_ID
npx wrangler secret put ORCID_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET   # any random 32+ char string

# 5. Add worker URL to branding config in docs/contribute.html
#    Set "worker_url": "https://your-worker.workers.dev"

# 6. Trigger first build
#    Actions → "Build FDP" → Run workflow
```

### Secrets required

| Secret | Where | How to create |
|--------|-------|---------------|
| `GITHUB_TOKEN` | Cloudflare Worker secret | GitHub → Settings → Developer settings → Fine-grained PATs → Issues: Read & Write |
| `ORCID_CLIENT_ID` | Cloudflare Worker secret | orcid.org/developer-tools |
| `ORCID_CLIENT_SECRET` | Cloudflare Worker secret | Same ORCID app |
| `SESSION_SECRET` | Cloudflare Worker secret | `openssl rand -hex 32` |

---

## Mode B — Codeberg Pages + Woodpecker CI

EU-hosted. Codeberg is run by [Codeberg e.V.](https://codeberg.org/Codeberg/org/src/branch/main/Imprint.md),
a German non-profit, on Hetzner infrastructure in Frankfurt.

### Prerequisites
- Codeberg account ([codeberg.org](https://codeberg.org))
- Woodpecker CI enabled at [ci.codeberg.org](https://ci.codeberg.org)
- ORCID developer app (same app as Mode A, just add a second redirect URI)
- Deno or a Hetzner VPS for the worker (see [EU worker](infra/hetzner-deploy.sh))

### Steps

```bash
# 1. Fork on Codeberg
#    https://codeberg.org/StaticFDP/staticfdp → Fork

# 2. Clone and configure
git clone https://codeberg.org/YOUR-ORG/YOUR-REPO
cd YOUR-REPO
bash scripts/setup.sh   # choose option 2 (Codeberg only)

# 3. Enable Codeberg Pages
#    Codeberg Pages serves from the `pages` branch automatically.
#    Create it from main:
git checkout --orphan pages
git rm -rf .
git checkout main -- docs/
git add docs/ && git commit -m "init pages"
git push codeberg pages
#    Your site is now at: https://YOUR-ORG.codeberg.page/YOUR-REPO/

# 4. Activate Woodpecker CI
#    Go to ci.codeberg.org → Add repository
#    Add secrets in Woodpecker dashboard:
#      FORGEJO_TOKEN   — Codeberg PAT (Issues: Read & Write)
#      ORCID_CLIENT_ID, ORCID_CLIENT_SECRET, SESSION_SECRET

# 5. Deploy the EU worker (Deno on Hetzner)
bash infra/hetzner-deploy.sh   # sets up Deno + systemd service
#    Then edit /opt/staticfdp-worker/.env with your secrets
```

### Woodpecker secrets

| Secret name | Purpose |
|-------------|---------|
| `FORGEJO_TOKEN` | Create issues on Codeberg (Issues: Read & Write) |
| `ORCID_CLIENT_ID` | ORCID OAuth |
| `ORCID_CLIENT_SECRET` | ORCID OAuth |
| `SESSION_SECRET` | Cookie signing |

### ORCID redirect URI for Codeberg

In your ORCID developer app, add a second redirect URI:
```
https://your-worker.eu.example.org/auth/orcid/callback
```
The same ORCID app works for both GitHub and Codeberg deployments.

---

## Mode C — Dual active-active (GitHub + Codeberg)

Both platforms receive every form submission simultaneously. Either can serve
the data independently. Use this for maximum resilience and community reach.

```
User submits form
      │
      ├──► POST GitHub Issues → GitHub Actions → GitHub Pages
      │
      └──► POST Codeberg Issues → Woodpecker CI → Codeberg Pages
```

### Steps

```bash
# 1. Create repos on both platforms
gh repo create YOUR-ORG/YOUR-REPO --public   # GitHub
#    Manually create on Codeberg, then:
git remote add codeberg git@codeberg.org:YOUR-ORG/YOUR-REPO.git

# 2. Configure for both
bash scripts/setup.sh   # choose option 3 (both)

# 3. Push to both
git push github main
git push codeberg main

# 4. Deploy Cloudflare Worker with Forgejo dual-write
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put FORGEJO_TOKEN   # enables dual-write automatically
#    Set FORGEJO_REPO and FORGEJO_BASE_URL in wrangler.toml

# 5. Enable Pages on both platforms (see Modes A and B above)
```

The worker's `handleSubmit()` always writes to GitHub first (awaited), then fires
a non-fatal parallel write to Codeberg/Forgejo. If the Forgejo write fails,
GitHub still has the submission.

---

## Mode D — Self-hosted (GitLab / Gitea / Forgejo / internal)

Use this when metadata cannot live on public commercial infrastructure:
clinical data portals, hospital networks, national research institutes,
air-gapped environments, or regional deployments (Japan, China, Brazil, etc.).

### D-1: GitLab (CE or EE) + GitLab Pages

GitLab Community Edition is free to self-host. GitLab Pages works from a
`public/` directory produced by CI.

#### `.gitlab-ci.yml`

```yaml
# Place in repo root. Adjust image and script for FDP/Index/VP.
stages: [build, pages]

build:
  stage: build
  image: python:3.12-slim
  script:
    - pip install rdflib
    - python3 scripts/build_vp.py        # or harvest_fdps.py / issues_to_datasets.py
  artifacts:
    paths: [docs/]
  rules:
    - if: $CI_PIPELINE_SOURCE == "schedule"
    - if: $CI_PIPELINE_SOURCE == "web"
    - if: $CI_COMMIT_BRANCH == "main"

pages:
  stage: pages
  script:
    - mkdir -p public
    - cp -r docs/. public/
  artifacts:
    paths: [public/]
  rules:
    - if: $CI_COMMIT_BRANCH == "main"
```

#### Schedule (replace GitHub Actions cron)

GitLab → CI/CD → Schedules → New schedule:
- Interval: `40 4 * * *`
- Target branch: `main`

#### GitLab Issues API (worker adaptation)

The worker uses a simple POST. For GitLab, change the endpoint:

```javascript
// In worker/src/index.js, replace the GitHub issue POST:
const GITLAB_BASE = env.GITLAB_BASE_URL || 'https://gitlab.example.org';
const GITLAB_PROJECT_ID = env.GITLAB_PROJECT_ID; // numeric or URL-encoded path

const resp = await fetch(
  `${GITLAB_BASE}/api/v4/projects/${encodeURIComponent(GITLAB_PROJECT_ID)}/issues`,
  {
    method: 'POST',
    headers: {
      'PRIVATE-TOKEN': env.GITLAB_TOKEN,   // or 'Authorization': `Bearer ${token}`
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      title: issue.title,
      description: issue.body,       // GitLab uses "description" not "body"
      labels: issue.labels?.join(','),
    }),
  }
);
```

Add to `wrangler.toml`:
```toml
GITLAB_BASE_URL    = "https://gitlab.your-org.org"
GITLAB_PROJECT_ID  = "your-org/your-repo"   # or numeric ID
```

Add secret:
```bash
npx wrangler secret put GITLAB_TOKEN   # GitLab PAT: api scope
```

#### GitLab Pages URL

By default: `https://YOUR-GROUP.gitlab.your-org.org/YOUR-REPO/`  
Or with a custom domain: configure in Settings → Pages → Custom domains.

---

### D-2: Gitea / Forgejo (self-hosted) + Forgejo Actions

[Forgejo](https://forgejo.org) is a soft-fork of Gitea and fully API-compatible.
The GitHub Actions workflow syntax is supported natively — no changes required
to `.github/workflows/*.yml` except the runner label.

#### Register a self-hosted runner

```bash
# On your Forgejo instance:
# Admin panel → Actions → Runners → Create new runner
# Copy the registration token, then on your server:

docker run -d \
  --name forgejo-runner \
  -e FORGEJO_INSTANCE_URL=https://git.your-org.org \
  -e FORGEJO_RUNNER_SECRET=REGISTRATION_TOKEN \
  -v /var/run/docker.sock:/var/run/docker.sock \
  code.forgejo.org/forgejo/runner:latest
```

#### Workflow label

In your workflow files, change the runner label from `ubuntu-latest` to your
self-hosted runner label:

```yaml
# .github/workflows/harvest.yml  (no rename needed — Forgejo reads same path)
jobs:
  harvest:
    runs-on: self-hosted   # or the label you gave your runner
```

#### Forgejo API (same as Codeberg)

The Forgejo Issues API is identical to the Codeberg one — the worker's existing
Forgejo dual-write works unchanged. Just set:

```toml
FORGEJO_BASE_URL = "https://git.your-org.org"
FORGEJO_REPO     = "your-org/your-repo"
```

#### Forgejo Pages

Forgejo Pages is served from the `pages` branch (same as Codeberg). Create it
the same way:

```bash
git checkout --orphan pages
git checkout main -- docs/
git add docs/ && git commit -m "init pages"
git push origin pages
```

Enable in repo settings → Git Hooks (or your Forgejo admin panel → Pages).

---

### D-3: Any static host (S3, Nginx, Caddy, institutional web server)

The `docs/` folder is plain HTML + Turtle files — no server-side rendering.
It can be served from any static host.

```bash
# After CI generates docs/:
rsync -avz docs/ user@webserver.your-org.org:/var/www/fdp/
# or
aws s3 sync docs/ s3://your-bucket/ --delete
# or
# GitLab CI → artifact → deploy to Pages or an S3-compatible store
```

The worker still needs to run somewhere (Cloudflare, Deno Deploy, or a VPS).
For fully air-gapped environments, see [No-worker mode](#no-worker-mode) below.

#### No-worker mode (GitHub/Forgejo Issues only)

If you cannot run a worker, the forms' fallback buttons ("Open GitHub Issue" /
"Open Forgejo Issue") still work — they open a pre-filled issue form directly in
the browser. No worker needed. ORCID login and RoR lookup are unavailable in
this mode; contributors identify themselves manually in the issue body.

---

### D-4: Regional instances

Any Mode D setup can serve as a regional mirror. Examples:

| Region | Infrastructure | Notes |
|--------|---------------|-------|
| **Japan** | NII Academic Cloud, RIKEN, Sakura Internet VPS | Forgejo + Woodpecker on a Tokyo VPS; Deno Deploy has Tokyo edge nodes |
| **China** | Gitea on Alibaba Cloud / Tencent Cloud | ORCID access may need proxy; RoR API is globally accessible |
| **Brazil** | RNP (Rede Nacional de Ensino e Pesquisa) GitLab | Mode D-GitLab; ORCID sandbox available for testing |
| **Australia** | ARDC Nectar Cloud, AARNet | Forgejo or GitLab; Cloudflare Workers has Sydney PoP |

Regional instances participate in the federation by registering their
`index.ttl` with the global Virtual Platform — or running their own VP if
they need a fully regional discovery hub.

```
Global VP (vp.erdera.org)
  ├── EU FDP Index (Codeberg, Frankfurt)
  ├── US FDP Index (GitHub, global CDN)
  └── Japan FDP Index (Forgejo, Tokyo VPS)
           └── Institute A FDP
           └── Institute B FDP
```

---

## Branding and theming

Every HTML file (`contribute.html`, `register.html`, `index.html`) contains a
`<script id="branding" type="application/json">` block at the top of the
`<body>`. Edit this block to customise the look for your deployment — no
changes to the logic are needed.

### What you can set

```json
{
  "title":        "Your FDP Title",
  "subtitle":     "Your organisation's FAIR Data Point",
  "logo_url":     "https://your-org.org/logo.svg",
  "logo_alt":     "Your Organisation Logo",
  "header_bg":    "linear-gradient(135deg,#003366 0%,#0055a5 60%,#006699 100%)",
  "accent_color": "#003366",
  "footer_text":  "© 2026 Your Organisation",
  "footer_links": [
    { "label": "Your website",  "url": "https://your-org.org/" },
    { "label": "Privacy policy","url": "https://your-org.org/privacy" }
  ],
  "worker_url":   "https://your-worker.workers.dev",
  "custom_css":   "https://your-org.org/fdp-overrides.css"
}
```

### Fields reference

| Field | Default | Effect |
|-------|---------|--------|
| `title` | `"StaticFDP — Add Metadata"` | `<h1>` in header and `<title>` |
| `subtitle` | (StaticFDP tagline) | Second line in header |
| `logo_url` | *(none)* | Image shown left of the title |
| `logo_alt` | `"Logo"` | Alt text for the logo image |
| `header_bg` | Green-blue gradient | CSS `background` of the `<header>` |
| `accent_color` | `#1a6b5a` | CSS `--accent` variable (buttons, focus rings, links) |
| `footer_text` | `"StaticFDP Ecosystem"` | Footer left text |
| `footer_links` | GitHub + Codeberg links | Footer right links |
| `worker_url` | `""` (same origin) | Base URL of the ORCID/submit worker |
| `custom_css` | *(none)* | URL of an additional stylesheet loaded last |

### Example: ELIXIR Netherlands branding

```json
{
  "title":        "ELIXIR-NL FAIR Data Point",
  "subtitle":     "Register datasets with the Dutch node of ELIXIR",
  "logo_url":     "https://elixir-europe.org/sites/default/files/images/logos/elixir-nl.png",
  "header_bg":    "linear-gradient(135deg,#f47920 0%,#e35c00 60%,#c24400 100%)",
  "accent_color": "#f47920",
  "footer_text":  "ELIXIR Netherlands — DTL",
  "footer_links": [
    {"label": "ELIXIR-NL", "url": "https://www.elixir-europe.org/about-us/who-we-are/nodes/netherlands"},
    {"label": "DTL",       "url": "https://www.dtls.nl/"}
  ],
  "worker_url": "https://elixir-nl-fdp-worker.workers.dev"
}
```

### Applying a custom stylesheet

Set `"custom_css": "https://your-org.org/fdp-theme.css"` and place your
overrides there. The file is loaded after the built-in styles, so any CSS
variable or rule you define takes precedence:

```css
/* fdp-theme.css */
:root {
  --green:   #003366;
  --green-l: #e6eef7;
  --blue:    #0055a5;
}
header { font-family: "Myriad Pro", sans-serif; }
```

---

## Worker deployment options

The worker handles three things: ORCID OAuth login, RoR lookup from ORCID
profile, and form submission to GitHub/Forgejo Issues.

### Option 1 — Cloudflare Workers (default, free tier)

```bash
cd worker
npx wrangler deploy
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put ORCID_CLIENT_ID
npx wrangler secret put ORCID_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
# Optional — enables Codeberg dual-write:
npx wrangler secret put FORGEJO_TOKEN
```

Cloudflare's free tier covers 100,000 requests/day. ORCID OAuth requires a
publicly reachable HTTPS endpoint, which Cloudflare provides automatically.

### Option 2 — Deno Deploy (EU-friendly, free tier)

```bash
# worker/src/index.deno.js is the Deno-adapted version (same logic)
# Deploy at: https://dash.deno.com → New project → GitHub repo → index.deno.js
# Set environment variables in the Deno Deploy dashboard
```

Deno Deploy runs on Deno's global edge network, including Frankfurt nodes.

### Option 3 — Deno on a VPS (full control, any region)

```bash
bash infra/hetzner-deploy.sh   # tested on Hetzner CX22, Ubuntu 22.04
# Works on any VPS: Hetzner, DigitalOcean, Sakura (Japan), OVH (FR), etc.
# Creates a systemd service: staticfdp-worker
# Edit /opt/staticfdp-worker/.env with your secrets
```

Costs approximately €3–5/month. Runs in any region. Full control over data
residency — nothing leaves your VPS except the ORCID OAuth redirect and the
GitHub/Forgejo API calls.

### Option 4 — No worker (fallback mode)

Forms include "Open GitHub Issue" and "Open Codeberg Issue" direct buttons.
These open a pre-filled Issue in the browser — no worker, no server.
ORCID login and RoR auto-population are unavailable. Suitable for:
- Internal pilots with trusted contributors
- Deployments where the metadata repository is the same platform users already log into
- Testing before a worker is configured

---

## Security considerations by mode

| Concern | Mode A | Mode B | Mode C | Mode D |
|---------|--------|--------|--------|--------|
| Metadata stored in EU | ✗ | ✅ | ✅ (Codeberg copy) | ✅ (self-hosted) |
| Metadata on public internet | ✅ | ✅ | ✅ | Optional |
| GDPR-compliant hosting | ✗ | ✅ | Partial | ✅ |
| No US jurisdiction | ✗ | ✅ | Partial | ✅ |
| Air-gapped possible | ✗ | ✗ | ✗ | ✅ |
| ORCID login | ✅ | ✅ | ✅ | ✅ (ORCID is global) |
| RoR lookup | ✅ | ✅ | ✅ | ✅ (RoR API is public) |
| Form worker required | ✅ | ✅ | ✅ | Optional |

> **What leaves your infrastructure:**  
> In all modes with ORCID login: the ORCID iD and name are returned by orcid.org  
> to your worker. The RoR lookup hits `api.ror.org` (hosted by California Digital  
> Library / Internet Archive). If either is unacceptable, use no-worker mode.

---

## Checklist: first deployment

- [ ] Choose a deployment mode (A / B / C / D)
- [ ] Fork or clone the appropriate template repo
- [ ] Run `bash scripts/setup.sh` and commit `*-config.yaml`
- [ ] Edit the `<script id="branding">` block in `docs/*.html`
- [ ] Create ORCID developer app; note Client ID and Secret
- [ ] Deploy the worker; set all secrets
- [ ] Add ORCID redirect URI pointing to your worker
- [ ] Enable Pages (GitHub / Codeberg / GitLab / static host)
- [ ] Trigger first CI build manually
- [ ] Register your FDP with an FDP Index
- [ ] Register your FDP Index with a Virtual Platform (optional)
