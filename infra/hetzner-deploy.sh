#!/usr/bin/env bash
# hetzner-deploy.sh
# =================
# One-shot setup script for a Hetzner CX11 VPS (Ubuntu 22.04 LTS).
# Deploys the BYOD form receiver as a Deno service with systemd auto-restart.
#
# Recommended server: Hetzner CX11, Frankfurt datacenter
#   CPU: 1 vCPU  RAM: 2 GB  Disk: 20 GB SSD  Price: €3.79/month
#   OS:  Ubuntu 22.04 LTS
#
# Usage (run as root on the VPS):
#   curl -fsSL https://raw.githubusercontent.com/StaticFDP/ga4gh-rare-disease-trajectories/main/infra/hetzner-deploy.sh | bash
#
# Or manually:
#   scp infra/hetzner-deploy.sh root@<server-ip>:/tmp/
#   ssh root@<server-ip> bash /tmp/hetzner-deploy.sh
#
# After running this script:
#   1. Edit /opt/byod-worker/.env with your actual secrets
#   2. systemctl start byod-worker
#   3. systemctl enable byod-worker
#   4. Set up a reverse proxy (nginx/caddy) to forward port 443 → 8080
#      and obtain a TLS certificate (certbot or Caddy auto-HTTPS)
# ===========================================================================

set -euo pipefail

WORKER_DIR="/opt/byod-worker"
SERVICE_USER="byodworker"
REPO_URL="https://github.com/StaticFDP/ga4gh-rare-disease-trajectories"
DENO_VERSION="1.44.1"

echo "=== BYOD Worker — Hetzner setup ==="
echo "    Worker dir : ${WORKER_DIR}"
echo "    Deno       : ${DENO_VERSION}"
echo ""

# ── 1. System packages ────────────────────────────────────────────────────────
apt-get update -qq
apt-get install -y --no-install-recommends curl unzip git nginx certbot python3-certbot-nginx

# ── 2. Create service user ────────────────────────────────────────────────────
if ! id "${SERVICE_USER}" &>/dev/null; then
  useradd --system --shell /usr/sbin/nologin --home-dir "${WORKER_DIR}" "${SERVICE_USER}"
  echo "Created user: ${SERVICE_USER}"
fi

# ── 3. Install Deno ───────────────────────────────────────────────────────────
if ! command -v deno &>/dev/null; then
  export DENO_INSTALL="/usr/local"
  curl -fsSL https://deno.land/install.sh | sh -s "v${DENO_VERSION}"
  echo "Installed Deno $(deno --version | head -1)"
else
  echo "Deno already installed: $(deno --version | head -1)"
fi

# ── 4. Clone / update the worker source ──────────────────────────────────────
mkdir -p "${WORKER_DIR}"

if [ -d "${WORKER_DIR}/.git" ]; then
  echo "Pulling latest worker source..."
  git -C "${WORKER_DIR}" pull --ff-only
else
  echo "Cloning repository..."
  git clone --depth 1 --filter=blob:none --sparse "${REPO_URL}" "${WORKER_DIR}"
  git -C "${WORKER_DIR}" sparse-checkout set worker/src
fi

# Copy the Deno entry point and the main Worker source to the worker dir root
cp "${WORKER_DIR}/worker/src/index.js"      "${WORKER_DIR}/index.js"
cp "${WORKER_DIR}/worker/src/index.deno.js" "${WORKER_DIR}/index.deno.js"

# ── 5. Write .env template (fill in secrets after setup) ─────────────────────
if [ ! -f "${WORKER_DIR}/.env" ]; then
  cat > "${WORKER_DIR}/.env" <<'ENV'
# BYOD Worker — environment variables
# Edit this file, then: systemctl restart byod-worker

# GitHub (primary)
GITHUB_TOKEN=ghp_REPLACE_ME
GITHUB_REPO=StaticFDP/ga4gh-rare-disease-trajectories

# Forgejo / Codeberg (EU mirror)
FORGEJO_TOKEN=REPLACE_ME
FORGEJO_REPO=StaticFDP/ga4gh-rare-disease-trajectories
FORGEJO_BASE_URL=https://codeberg.org

# ORCID OAuth
# Register at https://orcid.org/developer-tools
# Add redirect URI: https://eu.byod-worker.semscape.org/auth/orcid/callback
ORCID_CLIENT_ID=APP-REPLACE_ME
ORCID_CLIENT_SECRET=REPLACE_ME

# Session signing key — any random 32+ character string
SESSION_SECRET=REPLACE_WITH_RANDOM_STRING

# Landing page (used in redirects after login)
LANDING_PAGE=https://eu.fdp.semscape.org/ga4gh-rare-disease-trajectories/

# Server port (nginx proxies 443 → this port)
PORT=8080
ENV
  echo "Written .env template to ${WORKER_DIR}/.env"
  echo "  >>> EDIT THIS FILE WITH YOUR SECRETS BEFORE STARTING <<<"
fi

chmod 600 "${WORKER_DIR}/.env"
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${WORKER_DIR}"

# ── 6. Write systemd service unit ────────────────────────────────────────────
cat > /etc/systemd/system/byod-worker.service <<UNIT
[Unit]
Description=BYOD Form Receiver (Deno / EU mirror)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
WorkingDirectory=${WORKER_DIR}
ExecStart=/usr/local/bin/deno run --allow-net --allow-env --allow-read=${WORKER_DIR}/.env ${WORKER_DIR}/index.deno.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=byod-worker

# Security hardening
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ReadWritePaths=${WORKER_DIR}

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
echo "Systemd unit written: byod-worker.service"

# ── 7. Write nginx reverse-proxy config ──────────────────────────────────────
DOMAIN="eu.byod-worker.semscape.org"

cat > /etc/nginx/sites-available/byod-worker <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    # ACME challenge for Let's Encrypt
    location /.well-known/acme-challenge/ { root /var/www/html; }

    # Redirect everything else to HTTPS
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name ${DOMAIN};

    # TLS — managed by certbot (run: certbot --nginx -d ${DOMAIN})
    # ssl_certificate     /etc/letsencrypt/live/${DOMAIN}/fullchain.pem;
    # ssl_certificate_key /etc/letsencrypt/live/${DOMAIN}/privkey.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
    add_header X-Frame-Options DENY always;
    add_header X-Content-Type-Options nosniff always;

    # Proxy to Deno worker
    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 30s;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/byod-worker /etc/nginx/sites-enabled/byod-worker
nginx -t && systemctl reload nginx
echo "nginx config written and reloaded"

# ── 8. Summary ────────────────────────────────────────────────────────────────
cat <<SUMMARY

=== Setup complete ===

Next steps:
  1. Edit secrets:
       nano ${WORKER_DIR}/.env

  2. Start the worker:
       systemctl start byod-worker
       systemctl enable byod-worker
       systemctl status byod-worker

  3. Obtain TLS certificate (once DNS is pointing here):
       certbot --nginx -d ${DOMAIN}

  4. Verify:
       curl https://${DOMAIN}/auth/status
       # should return {"loggedIn":false}

  5. Add ORCID redirect URI in https://orcid.org/developer-tools:
       https://${DOMAIN}/auth/orcid/callback

DNS required:
  A    ${DOMAIN}  →  $(curl -s ifconfig.me)

SUMMARY
