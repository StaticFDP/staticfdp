#!/usr/bin/env bash
# setup.sh — Interactive FDP infrastructure configurator
# =======================================================
# Asks where your FAIR Data Point and form submissions should live,
# then writes fdp-config.yaml and updates wrangler.toml accordingly.
#
# Usage:
#   bash scripts/setup.sh
#
# What it does:
#   1. Asks which platform(s) should host the FDP data
#   2. Asks for repo names and public URLs
#   3. Writes fdp-config.yaml (commit this to your repo)
#   4. Updates worker/wrangler.toml with the chosen vars
#   5. Prints the secrets you still need to supply manually

set -euo pipefail

# ── Colours ───────────────────────────────────────────────────────────────────
R='\033[0;31m'; G='\033[0;32m'; Y='\033[1;33m'
B='\033[0;34m'; C='\033[0;36m'; W='\033[1;37m'; N='\033[0m'

h1()  { echo -e "\n${W}$*${N}"; }
h2()  { echo -e "\n${C}$*${N}"; }
ok()  { echo -e "  ${G}✓${N}  $*"; }
ask() { echo -e -n "  ${Y}?${N}  $* "; }
note(){ echo -e "  ${B}i${N}  $*"; }
warn(){ echo -e "  ${R}!${N}  $*"; }

# ── Banner ────────────────────────────────────────────────────────────────────
clear
echo -e "${W}"
echo "  ╔══════════════════════════════════════════════════════════╗"
echo "  ║   StaticFDP — Infrastructure Setup                       ║"
echo "  ║   A reusable FAIR Data Point on static hosting           ║"
echo "  ╚══════════════════════════════════════════════════════════╝"
echo -e "${N}"
echo "  This script asks where your FDP data and form submissions"
echo "  should live, then writes fdp-config.yaml."
echo ""

# ── Working directory — must be repo root ─────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "${REPO_ROOT}"

# ── Question 1: Platform ──────────────────────────────────────────────────────
h1 "Question 1 of 4 — Where should your FDP data live?"
echo ""
echo "  Select the platform that will store form submissions (Issues)"
echo "  and serve the FAIR Data Point pages."
echo ""
echo -e "  ${W}[1]${N} GitHub     — github.com    (Microsoft infrastructure, US jurisdiction)"
echo -e "  ${W}[2]${N} Codeberg   — codeberg.org  (German non-profit, EU / Hetzner Frankfurt)"
echo -e "  ${W}[3]${N} Both       — dual-write; issues go to both, pages served from both"
echo ""
ask "Your choice [1/2/3, default 1]:"
read -r PLATFORM_CHOICE
PLATFORM_CHOICE="${PLATFORM_CHOICE:-1}"

case "${PLATFORM_CHOICE}" in
  1) PRIMARY="github"   ; USE_GH=true  ; USE_CB=false ;;
  2) PRIMARY="codeberg" ; USE_GH=false ; USE_CB=true  ;;
  3) PRIMARY="both"     ; USE_GH=true  ; USE_CB=true  ;;
  *) warn "Invalid choice — defaulting to GitHub"; PRIMARY="github"; USE_GH=true; USE_CB=false ;;
esac

ok "Selected: ${PRIMARY}"

# ── Question 2: GitHub repo (if using GitHub) ─────────────────────────────────
GH_REPO=""
GH_PAGES_URL=""

if $USE_GH; then
  h1 "Question 2 of 4 — GitHub repository"
  echo ""
  note "This is the GitHub repo that will receive Issues from form submissions"
  note "and serve the FDP as GitHub Pages."
  echo ""
  ask "GitHub repo (owner/name) [StaticFDP/ga4gh-rare-disease-trajectories]:"
  read -r GH_REPO
  GH_REPO="${GH_REPO:-StaticFDP/ga4gh-rare-disease-trajectories}"

  ask "GitHub Pages base URL [https://fdp.semscape.org/ga4gh-rare-disease-trajectories]:"
  read -r GH_PAGES_URL
  GH_PAGES_URL="${GH_PAGES_URL:-https://fdp.semscape.org/ga4gh-rare-disease-trajectories}"
  ok "GitHub: ${GH_REPO}  →  ${GH_PAGES_URL}"
else
  h1 "Question 2 of 4 — GitHub repository (skipped)"
  note "GitHub platform not selected."
  GH_REPO="StaticFDP/ga4gh-rare-disease-trajectories"
  GH_PAGES_URL="https://fdp.semscape.org/ga4gh-rare-disease-trajectories"
fi

# ── Question 3: Codeberg repo (if using Codeberg) ─────────────────────────────
CB_REPO=""
CB_BASE_URL="https://codeberg.org"
CB_PAGES_URL=""

if $USE_CB; then
  h1 "Question 3 of 4 — Codeberg repository"
  echo ""
  note "This is the Codeberg (Forgejo) repo that will receive Issues"
  note "and serve the FDP as Codeberg Pages at eu.fdp.semscape.org (or your domain)."
  echo ""
  ask "Codeberg repo (owner/name) [StaticFDP/ga4gh-rare-disease-trajectories]:"
  read -r CB_REPO
  CB_REPO="${CB_REPO:-StaticFDP/ga4gh-rare-disease-trajectories}"

  ask "Codeberg Pages base URL [https://eu.fdp.semscape.org/ga4gh-rare-disease-trajectories]:"
  read -r CB_PAGES_URL
  CB_PAGES_URL="${CB_PAGES_URL:-https://eu.fdp.semscape.org/ga4gh-rare-disease-trajectories}"
  ok "Codeberg: ${CB_REPO}  →  ${CB_PAGES_URL}"
else
  h1 "Question 3 of 4 — Codeberg repository (skipped)"
  note "Codeberg platform not selected."
  CB_REPO="StaticFDP/ga4gh-rare-disease-trajectories"
  CB_PAGES_URL="https://eu.fdp.semscape.org/ga4gh-rare-disease-trajectories"
fi

# ── Question 4: FDP canonical URL and title ───────────────────────────────────
h1 "Question 4 of 4 — FDP canonical URL"
echo ""
note "This URL is embedded in all RDF metadata as the FDP identifier."
note "Use the primary platform's Pages URL, or your own domain."
echo ""

DEFAULT_FDP_URL="${GH_PAGES_URL}"
if [ "${PRIMARY}" = "codeberg" ]; then
  DEFAULT_FDP_URL="${CB_PAGES_URL}"
fi

ask "FDP canonical base URL [${DEFAULT_FDP_URL}]:"
read -r FDP_BASE_URL
FDP_BASE_URL="${FDP_BASE_URL:-${DEFAULT_FDP_URL}}"

ask "FDP title [My FAIR Data Point]:"
read -r FDP_TITLE
FDP_TITLE="${FDP_TITLE:-My FAIR Data Point}"

ok "FDP URL: ${FDP_BASE_URL}"

# ── Write fdp-config.yaml ─────────────────────────────────────────────────────
h2 "Writing fdp-config.yaml..."

GH_ENABLED="true"
CB_ENABLED="true"
$USE_GH || GH_ENABLED="false"
$USE_CB || CB_ENABLED="false"

cat > "${REPO_ROOT}/fdp-config.yaml" <<YAML
# FDP Infrastructure Configuration
# Generated by scripts/setup.sh on $(date -u +"%Y-%m-%d %H:%M UTC")
# Re-run  scripts/setup.sh  to change these settings.

infrastructure:
  primary: ${PRIMARY}          # github | codeberg | both

  github:
    enabled: ${GH_ENABLED}
    repo: ${GH_REPO}
    pages_url: ${GH_PAGES_URL}

  codeberg:
    enabled: ${CB_ENABLED}
    repo: ${CB_REPO}
    base_url: ${CB_BASE_URL}
    pages_url: ${CB_PAGES_URL}

fdp:
  title: "${FDP_TITLE}"
  base_url: ${FDP_BASE_URL}
  license: https://creativecommons.org/licenses/by/4.0/
  publisher_name: "GA4GH Rare Disease Phenotyping Working Group"
  publisher_url: https://www.ga4gh.org/
YAML

ok "fdp-config.yaml written"

# ── Update worker/wrangler.toml ───────────────────────────────────────────────
h2 "Updating worker/wrangler.toml..."

WRANGLER="${REPO_ROOT}/worker/wrangler.toml"
if [ -f "${WRANGLER}" ]; then
  # Replace the relevant [vars] lines using sed
  sed -i.bak \
    -e "s|^GITHUB_REPO.*|GITHUB_REPO      = \"${GH_REPO}\"|" \
    -e "s|^LANDING_PAGE.*|LANDING_PAGE     = \"${FDP_BASE_URL}/\"|" \
    -e "s|^FORGEJO_BASE_URL.*|FORGEJO_BASE_URL = \"${CB_BASE_URL}\"|" \
    -e "s|^FORGEJO_REPO.*|FORGEJO_REPO     = \"${CB_REPO}\"|" \
    "${WRANGLER}"
  rm -f "${WRANGLER}.bak"
  ok "wrangler.toml updated"
else
  warn "worker/wrangler.toml not found — skipping"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
h1 "Setup complete"
echo ""
echo -e "  ${W}Infrastructure:${N} ${PRIMARY}"
echo -e "  ${W}FDP URL:${N}        ${FDP_BASE_URL}"
if $USE_GH; then
  echo -e "  ${W}GitHub:${N}         ${GH_REPO}"
fi
if $USE_CB; then
  echo -e "  ${W}Codeberg:${N}       ${CB_REPO}"
fi

echo ""
h2 "Secrets you still need to configure:"
echo ""

if $USE_GH; then
  echo -e "  GitHub (wrangler secret put):"
  echo -e "    ${Y}GITHUB_TOKEN${N}  — fine-grained PAT, Issues: Read+Write on ${GH_REPO}"
  echo -e "    ${Y}cd worker && npx wrangler secret put GITHUB_TOKEN${N}"
  echo ""
fi

if $USE_CB; then
  echo -e "  Codeberg:"
  echo -e "    ${Y}FORGEJO_TOKEN${N} — Codeberg access token, Issues: Read+Write on ${CB_REPO}"
  echo -e "    ${Y}cd worker && npx wrangler secret put FORGEJO_TOKEN${N}"
  echo ""
  echo -e "  Woodpecker CI (Codeberg repo → Settings → Secrets):"
  echo -e "    ${Y}FORGEJO_TOKEN${N} (same token)"
  echo ""
fi

echo -e "  ORCID OAuth (both platforms share the same app):"
echo -e "    ${Y}ORCID_CLIENT_ID${N}     — from orcid.org/developer-tools"
echo -e "    ${Y}ORCID_CLIENT_SECRET${N} — same"
echo -e "    ${Y}SESSION_SECRET${N}      — any random 32+ char string"
echo -e "    ${Y}cd worker && npx wrangler secret put ORCID_CLIENT_ID${N}"
echo ""

h2 "Next steps:"
echo ""
echo "  1. Commit fdp-config.yaml:"
echo -e "     ${Y}git add fdp-config.yaml worker/wrangler.toml${N}"
echo -e "     ${Y}git commit -m 'config: set FDP infrastructure to ${PRIMARY}'${N}"
echo ""
if $USE_GH; then
  echo "  2. Push to GitHub:"
  echo -e "     ${Y}git push origin main${N}"
  echo ""
fi
if $USE_CB; then
  echo "  3. Push to Codeberg:"
  echo -e "     ${Y}git remote add codeberg git@codeberg.org:${CB_REPO}.git${N}"
  echo -e "     ${Y}git push codeberg main${N}"
  echo ""
  echo "  4. Enable Codeberg Pages (repo Settings → Pages → branch: main, path: /docs)"
  echo ""
fi
echo "  Run  ${Y}python3 scripts/issues_to_datasets.py${N}  to regenerate all datasets."
echo ""
