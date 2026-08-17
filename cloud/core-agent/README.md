# Core-agent — on-demand producer provisioning (Phase 3.1)

Runs on a **shared-core host** and provisions/deprovisions **per-user block
producers** on that core on demand. It's the concrete unit behind
[the control-plane design](../../docs/cloud-control-plane.md): each subscriber
maps to one small producer container the agent can start, stop, resume, and
delete. Dependency-free Node (18+) + the `docker` CLI.

> **Free while testing.** There is no payment gate here — the shared token is the
> only gate. A thin control plane (accounts + **PayPal** billing, later — not
> Stripe) will sit in front and call this same API. See the [control-plane
> doc](../../docs/cloud-control-plane.md).

## What a "producer" is

One `koinos-block-producer` container with **its own self-generated signing key**
and **its own `--producer` (reward) address**, attached to the shared core's AMQP.
The agent only ever reads the producer's **public** key (to hand back for
registration) — the private key stays in the producer's basedir on the host, and
the user's main key is never involved.

## Run

The agent runs on the core host (alongside the shared core), talking to the local
Docker engine. Point it at the core's docker network + AMQP:

```bash
AGENT_TOKEN=$(openssl rand -hex 32) \
CORE_NETWORK=koinos-core_default \
CORE_AMQP=amqp://guest:guest@amqp:5672/ \
PRODUCER_IMAGE=koinos/koinos-block-producer:v1.3.1 \
PRODUCERS_DIR=/opt/koinos-core/producers \
node agent.js
```

| Env | Default | Purpose |
|---|---|---|
| `AGENT_TOKEN` | — | Shared secret (`x-agent-token`); required in practice. |
| `AGENT_PORT` | `3738` | HTTP port. |
| `CORE_NETWORK` | `koinos-core_default` | Docker network of the shared core (producers attach here). |
| `CORE_AMQP` | `amqp://guest:guest@amqp:5672/` | AMQP URL producers connect to. |
| `PRODUCER_IMAGE` | `koinos/koinos-block-producer:v1.3.1` | Block-producer image. |
| `PRODUCERS_DIR` | `/opt/koinos-core/producers` | Host dir holding each producer's basedir (key + meta). |
| `PRODUCER_ALGO` | `pob` | Consensus algorithm. |
| `GOSSIP_PRODUCTION` | `true` | Leave true on a real core (p2p supplies gossip); `false` for a local core with no p2p. |
| `LOCAL_RPC` / `NETWORK_RPC` | localhost:8080 / api.koinos.io | For `/core` sync status. |

## API

Every route except `/health` needs `x-agent-token`.

| Method + path | Does |
|---|---|
| `GET /health` | Liveness (no auth). |
| `GET /core` | Core sync status (local vs network head, producer count). |
| `POST /producers` `{ "producerAddress": "1…" }` | **Provision** a producer; returns its `id` + `publicKey`. |
| `GET /producers` | List all producers + status. |
| `GET /producers/:id` | One producer's status. |
| `POST /producers/:id/stop` | **Pause** (stop container, keep the key — billing grace). |
| `POST /producers/:id/start` | **Resume** with the same key. |
| `DELETE /producers/:id` | **Delete** (remove container + wipe key). |

### Example

```bash
export H='-H x-agent-token:TOKEN -H content-type:application/json'
# provision — returns the public key to register from the phone
curl -s $H -X POST localhost:3738/producers -d '{"producerAddress":"1YourKoinosAddress"}'
# -> {"id":"e39efa63","producerAddress":"1Your…","publicKey":"AoMsbsMtZV…","status":"running"}

curl -s $H localhost:3738/producers                      # list
curl -s $H -X POST localhost:3738/producers/e39efa63/stop   # pause (key kept)
curl -s $H -X POST localhost:3738/producers/e39efa63/start  # resume (same key)
curl -s $H -X DELETE localhost:3738/producers/e39efa63      # delete (key wiped)
```

## Lifecycle & state

- **Provision** creates the basedir, starts the container, waits for the producer
  to self-generate `block_producer/public.key`, and returns it.
- **Stop/start** map to `docker stop`/`docker start` — the basedir (signing key)
  is preserved, so a resumed producer keeps its already-registered key. This is
  the subscription-lapsed **grace** state.
- **Delete** removes the container and wipes the basedir (the user must register a
  fresh key to run again).
- State is **restart-safe**: `list`/`status` are derived from the on-disk
  producer basedirs (`meta.json`) + `docker inspect`, so restarting the agent
  re-discovers everything.

## Validated

This was run live against a real shared core (`chain v1.5.2` + `mempool v1.5.0` +
`block_store v1.1.0`): two producers provisioned with distinct self-generated keys
and distinct reward addresses, both attached to the shared chain/mempool;
stop→start preserved the key; delete removed container + key; bad addresses
rejected (400); auth enforced (401 without token).

## Security notes

- Never exposes or transmits a producer's **private** key.
- `docker` is invoked with argument arrays (no shell) — the `producerAddress` is
  validated (`^1…$`) but cannot inject regardless.
- The control port must not be public — put it behind the control plane
  (mTLS/signed tokens); only p2p (8888) and the agent port face outward, the
  latter reachable only by the control plane.
