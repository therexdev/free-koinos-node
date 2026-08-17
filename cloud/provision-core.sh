#!/usr/bin/env bash
#
# Koinos cloud node — shared-CORE host provisioning (Phase 3.1).
#
# Turns a bare Ubuntu VM into a shared-core host: it runs the heavy, stateful,
# quick-synced Koinos core (amqp + chain + mempool + block_store + p2p + jsonrpc,
# but NO block producer) and installs the core-agent, which provisions one small
# block-producer container per user on demand (see cloud/core-agent). This is the
# host behind the "<$1/user" density model — one core serves many independent
# producers, each with its own key + reward address + vote.
#
# It reuses the same node layout the desktop app / Phase 1 node use, minus the
# producer, plus a fixed compose project ("koinos-core") so the docker network
# name is predictable for the agent to attach producers to.
#
# Usage (as root on a fresh Ubuntu 22.04/24.04 x86_64 VM, >= 4 GB RAM, >= 80 GB):
#   AGENT_TOKEN=$(openssl rand -hex 32) bash provision-core.sh
#
# Re-running is safe (idempotent); it won't re-download the chain if already synced.
#
set -euo pipefail

# ---------------------------------------------------------------------------
# Config (override via environment)
# ---------------------------------------------------------------------------
KOINOS_DIR="${KOINOS_DIR:-/opt/koinos-core}"
CORE_PROJECT="${CORE_PROJECT:-koinos-core}"          # docker compose project -> network "<project>_default"
CORE_NETWORK="${CORE_NETWORK:-${CORE_PROJECT}_default}"
REPO_URL="${REPO_URL:-https://github.com/therexdev/Koinos-Node}"
REPO_REF="${REPO_REF:-main}"
AGENT_PORT="${AGENT_PORT:-3738}"
PRODUCER_IMAGE="${PRODUCER_IMAGE:-koinos/koinos-block-producer:v1.3.1}"
NETWORK_RPC="${NETWORK_RPC:-https://api.koinos.io/}"
QUICK_SYNC="${QUICK_SYNC:-1}"
FORCE_SYNC="${FORCE_SYNC:-}"

BACKUP_URL="https://seed.koinosfoundation.org/backups/koinos-backup.tar.gz"
BACKUP_SHA_URL="${BACKUP_URL}.sha256"

JSONRPC_PORT=8080
P2P_PORT=8888
AMQP_PORT=5672
AMQP_ADMIN_PORT=15672
GRPC_PORT=50051
REST_PORT=3000

# Pinned image tags (koinos/koinos env.example — mainnet), in lockstep with
# electron/lib/constants.js. PRODUCER_IMAGE above must match BLOCK_PRODUCER_TAG.
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
SRC_DIR="${KOINOS_DIR}/src"
SRC_ROOT=""
AGENT_DIR="${KOINOS_DIR}/core-agent"
PRODUCERS_DIR="${KOINOS_DIR}/producers"
CONFIG_DIR="${KOINOS_DIR}/config"
BASEDIR="${KOINOS_DIR}/basedir"
RESTORE_DIR="${KOINOS_DIR}/restore"
AGENT_ENV_FILE="/etc/koinos-core-agent.env"
AGENT_UNIT_FILE="/etc/systemd/system/koinos-core-agent.service"

# ---------------------------------------------------------------------------
log()  { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

require_root() { [ "$(id -u)" -eq 0 ] || die "Run as root (or sudo -E bash provision-core.sh)"; }

check_env() {
  [ -n "${AGENT_TOKEN:-}" ] || die "AGENT_TOKEN is required (shared secret for the core-agent; e.g. \$(openssl rand -hex 32))."
  local arch; arch="$(uname -m)"
  [ "$arch" = "x86_64" ] || warn "Architecture is $arch; koinos/* images are amd64. Use an x86_64 VM."
}

install_prereqs() {
  log "Installing base packages…"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl ca-certificates tar git coreutils >/dev/null
}

install_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    log "Docker + Compose already installed."
    return
  fi
  log "Installing Docker Engine + Compose (get.docker.com)…"
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 not available after install."
}

install_node() {
  if command -v node >/dev/null 2>&1; then
    local major; major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "${major:-0}" -ge 18 ]; then log "Node $(node --version) already installed."; return; fi
    warn "Node $(node --version) too old; installing Node 20."
  fi
  log "Installing Node.js 20 (NodeSource)…"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
  command -v node >/dev/null 2>&1 || die "Node install failed."
}

resolve_source() {
  mkdir -p "$KOINOS_DIR"
  local local_root; local_root="$(cd "$SCRIPT_DIR/.." && pwd)"
  if [ -f "$local_root/node-template/docker-compose.yml" ] && [ -f "$local_root/cloud/core-agent/agent.js" ]; then
    SRC_ROOT="$local_root"
    log "Using node template + core-agent from local checkout ($SRC_ROOT)."
    return
  fi
  if [ -d "$SRC_DIR/.git" ]; then
    log "Updating source repo ($REPO_REF)…"
    git -C "$SRC_DIR" fetch --depth 1 origin "$REPO_REF" >/dev/null 2>&1 || warn "git fetch failed; using existing checkout."
    git -C "$SRC_DIR" reset --hard "origin/$REPO_REF" >/dev/null 2>&1 || git -C "$SRC_DIR" reset --hard FETCH_HEAD >/dev/null 2>&1 || true
  else
    log "Cloning source from $REPO_URL ($REPO_REF)…"
    git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$SRC_DIR" >/dev/null 2>&1 \
      || git clone --depth 1 "$REPO_URL" "$SRC_DIR" >/dev/null 2>&1 || die "Could not clone $REPO_URL"
  fi
  SRC_ROOT="$SRC_DIR"
  [ -f "$SRC_ROOT/node-template/docker-compose.yml" ] || die "node-template/docker-compose.yml missing."
  [ -f "$SRC_ROOT/cloud/core-agent/agent.js" ] || die "cloud/core-agent/agent.js missing."
}

write_core_files() {
  log "Laying out shared-core directory at $KOINOS_DIR…"
  mkdir -p "$CONFIG_DIR" "$BASEDIR" "$PRODUCERS_DIR"
  local tpl="$SRC_ROOT/node-template"

  cp -f "$tpl/docker-compose.yml"           "$KOINOS_DIR/docker-compose.yml"
  cp -f "$tpl/common/koinos_descriptors.pb" "$CONFIG_DIR/koinos_descriptors.pb"
  cp -f "$tpl/common/rabbitmq.conf"         "$CONFIG_DIR/rabbitmq.conf"
  cp -f "$tpl/mainnet/genesis_data.json"    "$CONFIG_DIR/genesis_data.json"

  # config.yml — NO block_producer section (producers run as separate containers,
  # added by the core-agent). p2p on 0.0.0.0:8888; jsonrpc on 127.0.0.1:8080.
  cat > "$CONFIG_DIR/config.yml" <<YAML
# Generated by cloud/provision-core.sh — shared core (no block producer).

global:
  amqp: amqp://guest:guest@amqp:5672/
  log-level: info
  log-color: false
  log-datetime: true
  log-dir: logs
  instance-id: KoinosCore
  fork-algorithm: pob
  blacklist:
    - block_store.add_block
    - chain.propose_block

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

  # .env — COMPOSE_PROFILES=jsonrpc only (amqp/chain/mempool/block_store/p2p have no
  # profile so always run). block_producer is intentionally NOT enabled here.
  cat > "$KOINOS_DIR/.env" <<ENV
# Generated by cloud/provision-core.sh
BASEDIR=${BASEDIR}

AMQP_PORT=${AMQP_PORT}
AMQP_ADMIN_PORT=${AMQP_ADMIN_PORT}
P2P_PORT=${P2P_PORT}
JSONRPC_PORT=${JSONRPC_PORT}
GRPC_PORT=${GRPC_PORT}
REST_PORT=${REST_PORT}

COMPOSE_PROFILES=jsonrpc

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
    log "QUICK_SYNC=0 — skipping backup restore (core will sync from p2p, slower)."
    return
  fi
  if [ -d "$BASEDIR/chain" ] && [ -z "$FORCE_SYNC" ]; then
    log "Chain data already present — skipping quick-sync (set FORCE_SYNC=1 to redo)."
    return
  fi
  mkdir -p "$RESTORE_DIR"
  local archive="$RESTORE_DIR/koinos-backup.tar.gz" staging="$RESTORE_DIR/extracted"

  log "Fetching published checksum…"
  local expected; expected="$(curl -fsSL "$BACKUP_SHA_URL" | awk '{print $1}')"
  [ -n "$expected" ] || die "Could not read published sha256."
  log "Downloading chain backup (large; resumes if interrupted)…"
  curl -fL --retry 5 --retry-delay 5 -C - -o "$archive" "$BACKUP_URL"
  log "Verifying SHA-256…"
  local actual; actual="$(sha256sum "$archive" | awk '{print $1}')"
  [ "$actual" = "$expected" ] || { rm -f "$archive"; die "Checksum mismatch — corrupt download deleted. Re-run."; }
  log "Checksum OK."

  log "Inspecting archive layout…"
  local tops prefix
  tops="$(set +o pipefail; tar -tzf "$archive" 2>/dev/null | head -200 | awk -F/ 'NF{print $1}' | sort -u)"
  if printf '%s\n' "$tops" | grep -qx "chain"; then prefix="";
  elif [ "$(printf '%s\n' "$tops" | grep -c .)" -eq 1 ]; then prefix="$(printf '%s' "$tops")/";
  else die "Unexpected backup layout (top-level: $(printf '%s ' $tops))."; fi
  log "Archive layout OK (prefix \"${prefix:-none}\")."

  log "Extracting chain + block_store…"
  rm -rf "$staging"; mkdir -p "$staging"
  tar -xzf "$archive" -C "$staging" "${prefix}chain" "${prefix}block_store"
  [ -d "$staging/${prefix}chain" ] && [ -d "$staging/${prefix}block_store" ] || die "Extraction missing chain/ or block_store/."
  log "Installing restored chain data…"
  rm -rf "$BASEDIR/chain" "$BASEDIR/block_store"
  mv "$staging/${prefix}chain" "$BASEDIR/chain"
  mv "$staging/${prefix}block_store" "$BASEDIR/block_store"
  rm -rf "$staging"; rm -f "$archive"
}

start_core() {
  log "Starting the shared core (docker compose -p ${CORE_PROJECT} up -d)…"
  ( cd "$KOINOS_DIR" && docker compose -p "$CORE_PROJECT" up -d --remove-orphans )
  log "Core up. Producers will be added to docker network '${CORE_NETWORK}' by the agent."
}

install_core_agent() {
  log "Installing the core-agent as a systemd service…"
  local node_bin; node_bin="$(command -v node)"
  mkdir -p "$AGENT_DIR"
  cp -f "$SRC_ROOT/cloud/core-agent/agent.js" "$AGENT_DIR/agent.js"
  [ -f "$SRC_ROOT/cloud/core-agent/package.json" ] && cp -f "$SRC_ROOT/cloud/core-agent/package.json" "$AGENT_DIR/package.json"

  umask 077
  cat > "$AGENT_ENV_FILE" <<ENV
AGENT_TOKEN=${AGENT_TOKEN}
AGENT_PORT=${AGENT_PORT}
CORE_NETWORK=${CORE_NETWORK}
CORE_AMQP=amqp://guest:guest@amqp:5672/
PRODUCER_IMAGE=${PRODUCER_IMAGE}
PRODUCERS_DIR=${PRODUCERS_DIR}
PRODUCER_ALGO=pob
GOSSIP_PRODUCTION=true
LOCAL_RPC=http://127.0.0.1:${JSONRPC_PORT}/
NETWORK_RPC=${NETWORK_RPC}
ENV
  chmod 600 "$AGENT_ENV_FILE"
  umask 022

  cat > "$AGENT_UNIT_FILE" <<UNIT
[Unit]
Description=Koinos core-agent (per-user producer provisioning)
After=network-online.target docker.service
Wants=network-online.target
Requires=docker.service

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
  systemctl enable --now koinos-core-agent.service
  sleep 1
  systemctl is-active --quiet koinos-core-agent.service \
    && log "core-agent running on :${AGENT_PORT} (systemctl status koinos-core-agent)." \
    || warn "core-agent did not start — check: journalctl -u koinos-core-agent -e"
}

print_summary() {
  cat <<SUMMARY

$(printf '\033[1;32m✓ Koinos shared-core host provisioned.\033[0m')

  Core dir     : ${KOINOS_DIR}   (compose project: ${CORE_PROJECT}, network: ${CORE_NETWORK})
  core-agent   : http://<this-vm-ip>:${AGENT_PORT}   (header: x-agent-token)
  Producers    : ${PRODUCERS_DIR}   (one basedir per user, created on demand)

Firewall: open inbound TCP ${P2P_PORT} (p2p) and ${AGENT_PORT} (agent, to the control
plane only). Keep ${JSONRPC_PORT}/${AMQP_PORT}/${GRPC_PORT} closed to the internet.

Provision a producer (free tier — no payment):
  curl -s -H "x-agent-token: \$AGENT_TOKEN" -H 'content-type: application/json' \\
    -X POST http://127.0.0.1:${AGENT_PORT}/producers \\
    -d '{"producerAddress":"1UserKoinosWalletAddress"}'
  # -> returns the block-signing public key to register from the user's phone

Handy:
  Core logs   : cd ${KOINOS_DIR} && docker compose -p ${CORE_PROJECT} logs -f --tail=100
  Core status : curl -s -H "x-agent-token: \$AGENT_TOKEN" http://127.0.0.1:${AGENT_PORT}/core
  Agent logs  : journalctl -u koinos-core-agent -f
SUMMARY
}

main() {
  require_root
  check_env
  install_prereqs
  install_docker
  install_node
  resolve_source
  write_core_files
  quick_sync
  start_core
  install_core_agent
  print_summary
}

main "$@"
