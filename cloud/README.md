# Koinos cloud node — Phase 1 (node unit)

Run **your own** Koinos block producer in the cloud from a phone — keeping your
stake, your vote, and 100% of rewards — instead of handing them to a pool. This
directory is **Phase 1**: the replicable unit the whole service is built on — a
provisioning script + status agent that turn a bare Ubuntu VM into a running,
quick-synced node that generates its **own block-signing key** and reports
status. See [`../docs/cloud-node.md`](../docs/cloud-node.md) for the full
architecture and roadmap.

```
cloud/
├── provision.sh        # bare Ubuntu VM  ->  running, quick-synced node + agent
├── agent/
│   ├── agent.js        # token-protected HTTP status agent (no dependencies)
│   └── package.json
└── README.md
```

## Why this is self-sovereign, not a pool

Koinos separates two keys:

- **Main key — stays on the phone.** Holds KOIN/VHP, burns KOIN→VHP, registers
  the producer key, votes, and receives 100% of block rewards. **Never touches
  the VM.**
- **Block-signing key — lives on the cloud node.** Can do exactly one thing:
  sign blocks for the registered producer address. It can't move funds or vote.
  If it's ever compromised, you re-register a new one from your phone; funds and
  vote are never exposed.

So the VM is a **dumb, replaceable block-signer you rent** — the opposite of a
pool that custodies your stake and votes for you.

## What `provision.sh` does

Reproduces exactly what the desktop app's `node-manager.js` lays down, then
adds the agent:

1. Installs Docker Engine + Compose and Node.js 20 (the agent runs on the
   **host**, not in Docker, so it can still report "node down" if Docker breaks).
2. Clones this repo for `node-template/*` and `cloud/agent/agent.js`.
3. Writes the node directory (`/opt/koinos-node` by default):
   - `docker-compose.yml` + `config/` (`config.yml` with your producer address
     and the mainnet p2p seeds, `genesis_data.json`, `rabbitmq.conf`,
     `koinos_descriptors.pb`)
   - `.env` with pinned image tags and `COMPOSE_PROFILES=jsonrpc,block_producer`
4. **Quick-syncs** from the official Koinos backup (download → SHA-256 verify →
   extract `chain/` + `block_store/`) so the node is ready in minutes, not days.
5. `docker compose up -d`. The `block_producer` container generates its signing
   keypair on first start and writes `basedir/block_producer/public.key`.
6. Installs the status agent as a `systemd` service (`koinos-agent`).

Re-running is **idempotent**: it skips Docker/Node if present and won't
re-download the chain if `basedir/chain` already exists (use `FORCE_SYNC=1` to
redo).

## Quick start

On a fresh **Ubuntu 22.04/24.04 x86_64** VM (≥ 2 vCPU, 4 GB RAM, 80 GB disk),
as root:

```bash
git clone --depth 1 https://github.com/therexdev/Koinos-Node
cd Koinos-Node/cloud

PRODUCER_ADDRESS=1YourKoinosWalletAddress \
AGENT_TOKEN=$(openssl rand -hex 32) \
bash provision.sh
```

Save the `AGENT_TOKEN` you pass — the control plane/app needs it to read status.

### Environment variables

| Variable           | Required | Default                         | Purpose |
|--------------------|:--------:|---------------------------------|---------|
| `PRODUCER_ADDRESS` | ✅       | —                               | Your Koinos wallet address (receives rewards; the registered producer). |
| `AGENT_TOKEN`      | ✅       | —                               | Shared secret for the status agent (`x-agent-token`). |
| `KOINOS_DIR`       |          | `/opt/koinos-node`              | Where the node + agent live. |
| `AGENT_PORT`       |          | `3737`                          | Agent HTTP port. |
| `NETWORK_RPC`      |          | `https://api.koinos.io/`        | Public RPC used to compute "blocks behind". |
| `QUICK_SYNC`       |          | `1`                             | `0` skips the backup restore (sync from p2p only, slower). |
| `FORCE_SYNC`       |          | unset                           | Set to re-run quick-sync even if chain data exists. |
| `REPO_URL` / `REPO_REF` | |  `.../Koinos-Node` / `main`     | Source of `node-template` + the agent. |

## The status agent

A small dependency-free Node service (`agent/agent.js`) on `AGENT_PORT`. Every
route except `/health` requires the `x-agent-token` header.

| Route      | Auth | Returns |
|------------|:----:|---------|
| `/health`  | no   | `{ ok: true }` — liveness probe. |
| `/status`  | yes  | `running`, `producing`, `producerPublicKey`, `local`/`network` head heights, `blocksBehind`, `synced`. |
| `/pubkey`  | yes  | `{ publicKey }` — the block-signing **public** key to register. |

```bash
export AGENT_TOKEN=...   # the token you provisioned with
curl -s -H "x-agent-token: $AGENT_TOKEN" http://<vm-ip>:3737/status | jq
```

```json
{
  "running": true,
  "producing": true,
  "producerPublicKey": "PZ8Tyr4Nx8MHsRAGMpZmZ6TWY63dXWSV..",
  "local":   { "height": "24681012", "headBlockTime": "1754700000000" },
  "network": { "height": "24681013" },
  "blocksBehind": 1,
  "synced": true
}
```

The agent only ever reads the **public** key and RPC head info — it never has
access to the block-signing private key (that stays inside the container's
`basedir`) or your main key.

## Going live (registering the node)

1. Wait until `/status` shows `"synced": true` and a non-null
   `producerPublicKey`.
2. From your phone/app, sign `pob.register_public_key` with your **main key**,
   passing that public key — this authorizes the VM to produce blocks for your
   address.
3. Burn KOIN→VHP (from the app) so the producer has virtual hash power. Rewards
   mint straight to your address.

Revoke anytime by re-registering a different key (or unregistering) from your
phone. Rotating the VM's key never risks funds or vote.

## Firewall

Open inbound **TCP 8888** (p2p) and **TCP `AGENT_PORT`** (agent) in your cloud
security group. Keep JSON-RPC (8080), AMQP (5672/15672) and gRPC (50051) closed
to the internet — the compose file binds them to `127.0.0.1`, and the agent
reads JSON-RPC locally.

## Operating

```bash
cd /opt/koinos-node
docker compose ps                       # service states
docker compose logs -f --tail=100       # node logs
journalctl -u koinos-agent -f           # agent logs
cat basedir/block_producer/public.key   # the signing public key
```

## Cost

A full node is always-on (~2–4 GB RAM, ~30–60 GB disk, 24/7), roughly **$6–15/mo**
of cloud (e.g. Hetzner/DigitalOcean). Quick-sync makes a fresh node ready in
minutes — the good "Start my node" experience the subscription is built around.

## Where this fits

- **Phase 1 (this):** the node unit — testable on any single VM. ✅
- **Phase 2:** PWA (browser-adapted wallet + chain, the `register_public_key`
  flow) talking to a Phase-1 node.
- **Phase 3:** control plane + billing — fleet orchestration that calls
  `provision.sh` per user and polls each agent.
- **Phase 4:** native app + push notifications.
