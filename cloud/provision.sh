#!/usr/bin/env bash
#
# Koinos cloud node — Phase 1 provisioning.
#
# Turns a bare Ubuntu VM into a running, quick-synced Koinos block producer that
# generates its OWN block-signing key and reports status over a small,
# token-protected HTTP agent. The VM never holds the user's main key: the user
# registers this node's block-signing PUBLIC key from their phone/app and can
# revoke it anytime. This is the replicable unit the whole cloud service is
# built on (see docs/cloud-node.md).
#
# It reproduces exactly what the desktop app's node-manager.js lays down:
#   - docker-compose.yml + config/ (config.yml with producer + mainnet seeds,
#     genesis_data.json, rabbitmq.conf, koinos_descriptors.pb)
#   - .env with pinned image tags and COMPOSE_PROFILES=jsonrpc,block_producer
#   - quick-sync from the official Koinos backup (download + sha256 + extract)
#
# Usage (as root on a fresh Ubuntu 22.04/24.04 x86_64 VM):
#   PRODUCER_ADDRESS=1YourKoinosAddress... \
#   AGENT_TOKEN=$(openssl rand -hex 32) \
#   bash provision.sh
#
# Re-running is safe: it skips steps that are already done (idempotent) and
# never re-downloads the chain if basedir/chain already exists.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Config (override via environment)
# ---------------------------------------------------------------------------
KOINOS_DIR="${KOINOS_DIR:-/opt/koinos-node}"
REPO_URL="${REPO_URL:-https://github.com/therexdev/Koinos-Node}"
REPO_REF="${REPO_REF:-main}"
AGENT_PORT="${AGENT_PORT:-3737}"
NETWORK_RPC="${NETWORK_RPC:-https://api.koinos.io/}"
QUICK_SYNC="${QUICK_SYNC:-1}"          # 1 = restore from backup, 0 = sync from p2p only
FORCE_SYNC="${FORCE_SYNC:-}"           # set to re-run quick-sync even if chain data exists

# Mainnet node parameters — kept in lockstep with electron/lib/constants.js.
BACKUP_URL="https://seed.koinosfoundation.org/backups/koinos-backup.tar.gz"
BACKUP_SHA_URL="${BACKUP_URL}.sha256"

JSONRPC_PORT=8080
P2P_PORT=8888
AMQP_PORT=5672
AMQP_ADMIN_PORT=15672
GRPC_PORT=50051
REST_PORT=3000

# Pinned image tags (koinos/koinos env.example — mainnet).
ACCOUNT_HISTORY_TAG="v1.1.0"
BLOCK_PRODUCER_TAG="v1.3.1"
BLOCK_STORE_TAG="v1.1.0"
CHAIN_TAG="v1.5.2"
CONTRACT_META_STORE_TAG="v1.1.0"
GRPC_TAG="v1.1.1"
JSONRPC_TAG="v1.2.0"
MEMPOOL_TAG="v1.5.0"
P2P_TAG="v1.3.0"
REST_TAG="v1.1.1"
TRANSACTION_STORE_TAG="v1.1.0"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${KOINOS_DIR}/src"       # used only when we have to clone
SRC_ROOT=""                        # resolved by resolve_source(): repo root with node-template/ + cloud/
AGENT_DIR="${KOINOS_DIR}/agent"    # stable install path for the agent
CONFIG_DIR="${KOINOS_DIR}/config"
BASEDIR="${KOINOS_DIR}/basedir"
RESTORE_DIR="${KOINOS_DIR}/restore"
AGENT_ENV_FILE="/etc/koinos-agent.env"
AGENT_UNIT_FILE="/etc/systemd/system/koinos-agent.service"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

require_root() {
  [ "$(id -u)" -eq 0 ] || die "Run as root (or via sudo). Try: sudo -E bash provision.sh"
}

check_env() {
  [ -n "${PRODUCER_ADDRESS:-}" ] || die "PRODUCER_ADDRESS is required (your Koinos wallet address — receives rewards)."
  [ -n "${AGENT_TOKEN:-}" ]      || die "AGENT_TOKEN is required (shared secret for the status agent; e.g. \$(openssl rand -hex 32))."
  case "$PRODUCER_ADDRESS" in
    1*) : ;;  # Koinos base58 addresses start with 1
    *) die "PRODUCER_ADDRESS '$PRODUCER_ADDRESS' does not look like a Koinos address (should start with 1)." ;;
  esac
  local arch; arch="$(uname -m)"
  [ "$arch" = "x86_64" ] || warn "Architecture is $arch; the koinos/* images are published for amd64. A x86_64 VM is recommended."
}

# ---------------------------------------------------------------------------
# Steps
# ---------------------------------------------------------------------------
install_prereqs() {
  log "Installing base packages (curl, ca-certificates, tar, git)…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates tar git coreutils >/dev/null
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker + Compose already installed ($(docker --version | awk '{print $3}' | tr -d ,))."
    return
  fi
  log "Installing Docker Engine + Compose (get.docker.com)…"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 not available after install."
}

install_node() {
  # The status agent is a small Node script (built-in fetch → Node 18+). Node
  # runs on the HOST (not in Docker) on purpose, so it can still report "node
  # down" if Docker itself is broken.
  if command -v node >/dev/null 2>&1; then
    local major; major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "${major:-0}" -ge 18 ]; then
      log "Node $(node --version) already installed."
      return
    fi
    warn "Node $(node --version) is too old (need 18+); installing Node 20."
  fi
  log "Installing Node.js 20 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  command -v node >/dev/null 2>&1 || die "Node install failed."
}

resolve_source() {
  mkdir -p "$KOINOS_DIR"
  # Prefer the checkout this script was run from (works on any branch, no network).
  local local_root; local_root="$(cd "$SCRIPT_DIR/.." && pwd)"
  if [ -f "$local_root/node-template/docker-compose.yml" ] && [ -f "$local_root/cloud/agent/agent.js" ]; then
    SRC_ROOT="$local_root"
    log "Using node template + agent from local checkout ($SRC_ROOT)."
    return
  fi
  # Otherwise fetch (e.g. when provision.sh was piped in via curl | bash).
  if [ -d "$SRC_DIR/.git" ]; then
    log "Updating node template repo ($REPO_REF)…"
    git -C "$SRC_DIR" fetch --depth 1 origin "$REPO_REF" >/dev/null 2>&1 || warn "git fetch failed; using existing checkout."
    git -C "$SRC_DIR" reset --hard "origin/$REPO_REF" >/dev/null 2>&1 \
      || git -C "$SRC_DIR" reset --hard FETCH_HEAD >/dev/null 2>&1 || true
  else
    log "Cloning node template + agent from $REPO_URL ($REPO_REF)…"
    git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$SRC_DIR" >/dev/null 2>&1 \
      || git clone --depth 1 "$REPO_URL" "$SRC_DIR" >/dev/null 2>&1 \
      || die "Could not clone $REPO_URL"
  fi
  SRC_ROOT="$SRC_DIR"
  [ -f "$SRC_ROOT/node-template/docker-compose.yml" ] || die "node-template/docker-compose.yml missing from checkout."
  [ -f "$SRC_ROOT/cloud/agent/agent.js" ] || die "cloud/agent/agent.js missing from checkout."
}

write_node_files() {
  log "Laying out node directory at $KOINOS_DIR…"
  mkdir -p "$CONFIG_DIR" "$BASEDIR"
  local tpl="$SRC_ROOT/node-template"

  cp -f "$tpl/docker-compose.yml"                 "$KOINOS_DIR/docker-compose.yml"
  cp -f "$tpl/common/koinos_descriptors.pb"       "$CONFIG_DIR/koinos_descriptors.pb"
  cp -f "$tpl/common/rabbitmq.conf"               "$CONFIG_DIR/rabbitmq.conf"
  cp -f "$tpl/mainnet/genesis_data.json"          "$CONFIG_DIR/genesis_data.json"

  # config.yml — producer address + mainnet p2p seeds. jsonrpc listens on 8080
  # and is bound to 127.0.0.1 by the compose file (the agent reads it locally);
  # p2p listens on 0.0.0.0:8888 so peers can reach it.
  cat > "$CONFIG_DIR/config.yml" <<YAML
# Generated by cloud/provision.sh — based on koinos/koinos config-example.

global:
  amqp: amqp://guest:guest@amqp:5672/
  log-level: info
  log-color: false
  log-datetime: true
  log-dir: logs
  instance-id: KoinosCloud
  fork-algorithm: pob
  blacklist:
    - block_store.add_block
    - chain.propose_block

block_producer:
  algorithm: pob
  producer: ${PRODUCER_ADDRESS}                # Address that receives block rewards (user's main wallet)

grpc:
  endpoint: 0.0.0.0:50051

jsonrpc:
  listen: /tcp/8080

p2p:
  listen: /ip4/0.0.0.0/tcp/8888
  peer:
    - /dns4/seed.koinosblocks.com/tcp/8888/p2p/QmUNURuZxSu5wLnmBNJdwGtwjLmV5JxGhu4uNSAS8ZNcze
    - /dns4/seed.koinosfoundation.org/tcp/8888/p2p/QmQVBuhg2j2BV1hvMMNoLVrZ9T9gPb8F9bRgifCspBz6WW
    - /dns4/seed-east.burnkoin.com/tcp/8888/p2p/QmYAC9nxqgVt2p8NvmxNFsoMpQS7c4zEBmsZndEBTRHNu4
    - /ip4/37.27.7.221/tcp/11394/p2p/QmY8NBHwoVrxBvrjS3wQoeTmWG4UUKMxmYHss7QYRXktrs
    - /ip4/46.62.245.240/tcp/8888/p2p/QmWmxqE6WhcMWZEKwqUAbu87Qgm6JroZLdM4Xmxouu1Mmi
YAML

  # .env — pinned image tags + jsonrpc,block_producer profiles.
  cat > "$KOINOS_DIR/.env" <<ENV
# Generated by cloud/provision.sh
BASEDIR=${BASEDIR}

AMQP_PORT=${AMQP_PORT}
AMQP_ADMIN_PORT=${AMQP_ADMIN_PORT}
P2P_PORT=${P2P_PORT}
JSONRPC_PORT=${JSONRPC_PORT}
GRPC_PORT=${GRPC_PORT}
REST_PORT=${REST_PORT}

COMPOSE_PROFILES=jsonrpc,block_producer

ACCOUNT_HISTORY_TAG=${ACCOUNT_HISTORY_TAG}
BLOCK_PRODUCER_TAG=${BLOCK_PRODUCER_TAG}
BLOCK_STORE_TAG=${BLOCK_STORE_TAG}
CHAIN_TAG=${CHAIN_TAG}
CONTRACT_META_STORE_TAG=${CONTRACT_META_STORE_TAG}
GRPC_TAG=${GRPC_TAG}
JSONRPC_TAG=${JSONRPC_TAG}
MEMPOOL_TAG=${MEMPOOL_TAG}
P2P_TAG=${P2P_TAG}
REST_TAG=${REST_TAG}
TRANSACTION_STORE_TAG=${TRANSACTION_STORE_TAG}
ENV
}

quick_sync() {
  if [ "$QUICK_SYNC" != "1" ]; then
    log "QUICK_SYNC=0 — skipping backup restore (node will sync from p2p, slower)."
    return
  fi
  if [ -d "$BASEDIR/chain" ] && [ -z "$FORCE_SYNC" ]; then
    log "Chain data already present — skipping quick-sync (set FORCE_SYNC=1 to redo)."
    return
  fi

  mkdir -p "$RESTORE_DIR"
  local archive="$RESTORE_DIR/koinos-backup.tar.gz"
  local staging="$RESTORE_DIR/extracted"

  log "Fetching published checksum…"
  local expected; expected="$(curl -fsSL "$BACKUP_SHA_URL" | awk '{print $1}')"
  [ -n "$expected" ] || die "Could not read published sha256."

  log "Downloading chain backup (large file; resumes if interrupted)…"
  curl -fL --retry 5 --retry-delay 5 -C - -o "$archive" "$BACKUP_URL"

  log "Verifying SHA-256…"
  local actual; actual="$(sha256sum "$archive" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    rm -f "$archive"
    die "Checksum mismatch — corrupt download deleted. Re-run to try again."
  fi
  log "Checksum OK."

  # Detect an optional single wrapping directory in the archive (prefix).
  log "Inspecting archive layout…"
  local tops prefix
  tops="$(set +o pipefail; tar -tzf "$archive" 2>/dev/null | head -200 | awk -F/ 'NF{print $1}' | sort -u)"
  if printf '%s\n' "$tops" | grep -qx "chain"; then
    prefix=""
  elif [ "$(printf '%s\n' "$tops" | grep -c .)" -eq 1 ]; then
    prefix="$(printf '%s' "$tops")/"
  else
    die "Unexpected backup layout (top-level: $(printf '%s ' $tops)). Restore manually per docs.koinos.io."
  fi
  log "Archive layout OK (prefix \"${prefix:-none}\")."

  log "Extracting chain + block_store (can take a while)…"
  rm -rf "$staging"; mkdir -p "$staging"
  tar -xzf "$archive" -C "$staging" "${prefix}chain" "${prefix}block_store"
  [ -d "$staging/${prefix}chain" ] && [ -d "$staging/${prefix}block_store" ] \
    || die "Extraction finished but chain/ or block_store/ is missing."

  log "Installing restored chain data into basedir…"
  rm -rf "$BASEDIR/chain" "$BASEDIR/block_store"
  mv "$staging/${prefix}chain"       "$BASEDIR/chain"
  mv "$staging/${prefix}block_store" "$BASEDIR/block_store"

  log "Cleaning up download + staging…"
  rm -rf "$staging"; rm -f "$archive"
}

start_node() {
  log "Starting the node (docker compose up -d)…"
  ( cd "$KOINOS_DIR" && docker compose up -d --remove-orphans )
  log "Node containers up. The block_producer generates its signing key on first"
  log "start and writes basedir/block_producer/public.key (the agent exposes it)."
}

install_agent() {
  log "Installing the status agent as a systemd service…"
  local node_bin; node_bin="$(command -v node)"

  # Copy the agent to a stable path so the unit doesn't depend on the checkout.
  mkdir -p "$AGENT_DIR"
  cp -f "$SRC_ROOT/cloud/agent/agent.js" "$AGENT_DIR/agent.js"
  [ -f "$SRC_ROOT/cloud/agent/package.json" ] && cp -f "$SRC_ROOT/cloud/agent/package.json" "$AGENT_DIR/package.json"

  umask 077
  cat > "$AGENT_ENV_FILE" <<ENV
KOINOS_DIR=${KOINOS_DIR}
AGENT_TOKEN=${AGENT_TOKEN}
AGENT_PORT=${AGENT_PORT}
LOCAL_RPC=http://127.0.0.1:${JSONRPC_PORT}/
NETWORK_RPC=${NETWORK_RPC}
ENV
  chmod 600 "$AGENT_ENV_FILE"   # holds the agent token
  umask 022

  cat > "$AGENT_UNIT_FILE" <<UNIT
[Unit]
Description=Koinos cloud node status agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
EnvironmentFile=${AGENT_ENV_FILE}
ExecStart=${node_bin} ${AGENT_DIR}/agent.js
Restart=always
RestartSec=5
User=root
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
UNIT

  systemctl daemon-reload
  systemctl enable --now koinos-agent.service
  sleep 1
  systemctl is-active --quiet koinos-agent.service \
    && log "Agent running on :${AGENT_PORT} (systemctl status koinos-agent)." \
    || warn "Agent did not start — check: journalctl -u koinos-agent -e"
}

print_summary() {
  cat <<SUMMARY

$(printf '\033[1;32m✓ Koinos cloud node provisioned.\033[0m')

  Node dir      : ${KOINOS_DIR}
  Producer      : ${PRODUCER_ADDRESS}
  Agent         : http://<this-vm-ip>:${AGENT_PORT}  (header: x-agent-token)
  Local JSON-RPC: http://127.0.0.1:${JSONRPC_PORT}/  (localhost only)

Next steps
  1. Open inbound TCP ${P2P_PORT} (p2p) and ${AGENT_PORT} (agent) in your cloud
     firewall / security group. Keep ${JSONRPC_PORT}/${AMQP_PORT}/${GRPC_PORT} closed to the internet.
  2. Wait for the node to catch up to head:
       curl -s -H "x-agent-token: \$AGENT_TOKEN" http://127.0.0.1:${AGENT_PORT}/status
     Look for "synced": true and a non-null "producerPublicKey".
  3. From your phone/app, register this node's block-signing public key with your
     MAIN key (pob.register_public_key), then burn KOIN→VHP to start producing.
     The VM only ever holds the block-signing key — never your main key.

Handy commands
  Node logs   : cd ${KOINOS_DIR} && docker compose logs -f --tail=100
  Node status : cd ${KOINOS_DIR} && docker compose ps
  Agent logs  : journalctl -u koinos-agent -f
  Public key  : cat ${BASEDIR}/block_producer/public.key
SUMMARY
}

# ---------------------------------------------------------------------------
main() {
  require_root
  check_env
  install_prereqs
  install_docker
  install_node
  resolve_source
  write_node_files
  quick_sync
  start_node
  install_agent
  print_summary
}

main "$@"
