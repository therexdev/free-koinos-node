# Phase 3 — Control plane + billing (architecture)

The backend that turns the validated **shared core + per-user producer** unit into
a service: it provisions one producer per subscriber onto a shared core, exposes
the API the PWA calls, and **never holds the user's main key**. This is the design
doc; it builds directly on [`cloud-node.md`](./cloud-node.md), the [Phase 1
provisioner](../cloud/provision.sh), and the [shared-core
findings](../cloud/experiments/shared-core/FINDINGS.md).

> **Status.** The **core-agent** — the piece that actually provisions/stops/starts/
> deletes producers on a shared core — is **built and validated live**
> ([`../cloud/core-agent`](../cloud/core-agent)). **Payments are deferred: the
> service runs free while we test.** When we add billing it will be **PayPal**
> (not Stripe); the payment-driven parts below describe that future state, and the
> free tier simply skips the payment gate (a producer is provisioned on request).

## What's already de-risked (so Phase 3 doesn't re-litigate it)

- **The unit works.** One shared `chain/mempool/block_store/p2p/amqp` core serves
  many independent `block-producer` containers — each with its own key, its own
  `--producer` reward address, its own vote. Proven for coexistence, head-fanout,
  and concurrent production (single consistent head, zero errors).
- **Marginal cost of a subscriber ≈ 3 MB RAM + a 28 KB key file.** The heavy,
  growing part (chain state, RabbitMQ) is shared once per core.
- **Key boundary.** The producer self-generates its block-signing key; only the
  **public** key ever leaves the box. The main key is client-side only.

Phase 3 is orchestration + money + lifecycle around that unit — not new consensus
risk.

## Architecture

```mermaid
flowchart TB
  subgraph Phone["User's phone — PWA (Phase 2), holds MAIN key"]
    W["Wallet + chain (koilib)"]
  end

  subgraph CP["Control plane (our backend)"]
    API["API server (PWA-facing)"]
    ORCH["Orchestrator / reconciler"]
    BILL["Payment webhook handler (future)"]
    DB[("Postgres")]
  end

  S["PayPal — future (free tier skips this)"]

  subgraph Fleet["Fleet of core hosts"]
    subgraph CoreA["Core host A"]
      CA1["core-agent (control API)"]
      COREA[["shared core: chain / mempool / block_store / p2p / amqp"]]
      PA1["producer: userA (own key)"]
      PA2["producer: userB (own key)"]
    end
    subgraph CoreB["Core host B"]
      CA2["core-agent"]
      COREB[["shared core"]]
      PB1["producer: userC (own key)"]
    end
  end

  KN[("Koinos network")]

  W -->|"start / status (free tier: no payment)"| API
  API -.->|"future"| S
  S -.->|"webhook (future)"| BILL
  BILL -.-> ORCH
  API -->|"provision on request (free)"| ORCH
  API --> DB
  ORCH --> DB
  ORCH -->|"provision / deprovision"| CA1
  ORCH --> CA2
  API -->|"status / pubkey (proxied)"| CA1
  CA1 --> PA1 & PA2
  CA2 --> PB1
  W -->|"register_public_key — signed with MAIN key"| KN
  PA1 & PA2 & PB1 -->|"produce blocks → rewards mint to user"| KN
  COREA <-->|"p2p sync + gossip"| KN
```

### Components

1. **API server** — the only thing the PWA talks to. Auth (email/magic-link for the
   billing identity; the Koinos address is the on-chain identity). Endpoints for
   subscription, node lifecycle, and status. Stateless; reads/writes Postgres.
2. **Orchestrator / reconciler** — the control loop. Compares *desired* state
   (active subscriptions in Postgres) with *actual* state (producers running on
   cores, via core-agents) and converges: provision missing producers, stop ones
   whose subscription lapsed, pick a core with capacity, spin up a new core when
   all are full, migrate producers off an unhealthy core.
3. **core-agent** — evolves the [Phase 1 status agent](../cloud/agent/agent.js) into
   a small authenticated control API on each core host. It can `provision`
   (create + start a producer container with the user's `--producer` address,
   pointed at the local shared core), `deprovision` (stop + remove + wipe key),
   `list`, and report per-producer `status`/`pubkey`. It talks to the local Docker
   engine. **It only ever reads the producer's public key** — the private key stays
   in the producer's basedir on the host.
4. **Payment webhook handler (future — PayPal)** — verifies signatures, maps
   subscription lifecycle events to desired-state changes in Postgres (which the
   orchestrator then acts on). Absent in the free tier.
5. **Postgres** — the source of truth for users, subscriptions, producers, cores.

### Data model (Postgres)

```
users        (id, email, billing_customer_id, created_at)      -- billing_* null in free tier (PayPal later)
subscriptions(id, user_id, billing_subscription_id, status, current_period_end)
cores        (id, host, region, capacity, chain_status, image_tags, created_at)
producers    (id, user_id, core_id, producer_address, container_id,
              public_key, status, created_at)   -- status: provisioning|running|stopped|error
```

One **active subscription ⇒ one producer**. `producers.public_key` is what the PWA
reads to register. No private keys in this database — ever.

## The lifecycle (subscribe → provision → register → produce)

```mermaid
sequenceDiagram
  participant U as User (PWA · main key)
  participant CP as Control plane
  participant Pay as PayPal (future)
  participant CA as core-agent
  participant Pr as Producer (signing key)
  participant KN as Koinos network

  U->>CP: Start my node
  opt future (billing) — free tier skips this
    CP->>Pay: Create subscription
    Pay-->>CP: subscription active (webhook)
  end
  CP->>CA: provision(producerAddress)
  CA->>Pr: start container (self-generates signing key)
  Pr-->>CA: public.key
  CA-->>CP: public key
  CP-->>U: public key to register
  U->>KN: register_public_key(pubkey) — signed with MAIN key
  U->>KN: burn KOIN→VHP (existing Fund flow)
  Pr->>KN: produce blocks → rewards mint to user's address
  loop monitoring
    CP->>CA: GET status
    CA-->>CP: sync / producing / blocks-behind
  end
  U->>CP: Stop / cancel
  CP->>CA: stop (grace, keep key) — or delete (wipe key)
```

The user can re-register a new key or unregister from the phone at any time — the
control plane is never in that path.

## Trust & key custody (the line we don't cross)

| Asset | Where it lives | If the host is compromised |
|---|---|---|
| **Main key** (funds, vote, registration) | User's phone only | Untouched — never on our infra |
| **Block-signing key** | Generated on & confined to the producer container | Attacker could sign/censor *that user's* blocks — **cannot** move funds, vote stake, or re-register. User rotates the key from their phone; we re-provision. |
| **Rewards** | Mint directly to the user's address on-chain | Never custodied by us |

So the worst-case breach is a **liveness/grief** event on individual producers,
recoverable by key rotation — never a loss of funds or governance control. Signing
keys are encrypted at rest on the host and readable only by that producer.

## Billing design (free now → PayPal later)

- **v1 — free while testing.** No payment gate. "Start my node" provisions a
  producer immediately; "stop" pauses (grace) or deletes it. The core-agent already
  implements the full lifecycle; the control plane just calls it on request. This
  lets us prove the product end-to-end (fund → node → register → produce → monitor)
  before touching money.
- **Future — PayPal (not Stripe).** Flat monthly per producer (one subscription =
  one running node); predictable and matches the cost shape (always-on infra
  dominates, usage is negligible). Provisioning becomes webhook-driven off PayPal
  subscription events:
  - subscription **activated** → orchestrator provisions (or resumes) the producer.
  - payment **failed** → **grace** period → `stop` (keep the key, node reclaimable).
  - subscription **cancelled** → `stop` through grace, then `delete`.
- **Grace + reversibility is already in the agent:** `stop` keeps the signing key,
  so a resumed subscription brings the **same registered key** back online (proven
  in the core-agent test) — no re-registration needed. `delete` wipes the key for a
  clean exit.
- **Self-funding (later option):** the node earns KOIN and the
  [reward-return engine](../electron/lib) already exists — a future option can
  auto-convert a slice of rewards (via the KoinDX path we built) to offset the
  monthly charge for users above break-even. Kept out of v1 to avoid custody.

## Fleet operations

- **Capacity per core:** bounded by the shared chain's RAM/disk + **blast radius**,
  not by producers (they're ~3 MB each). Cap producers/core at a chosen N (e.g.
  25–50) so one core's failure affects a bounded cohort; run **≥2 cores** from day
  one for redundancy.
- **Placement:** orchestrator assigns a new producer to the least-loaded healthy
  core under capacity; provisions a new core (Phase 1 provisioner, core profile)
  when all are full.
- **Health & migration:** poll every producer's status via its core-agent. If a
  core is unhealthy, restart it or **migrate** its producers to another core —
  a producer is just a key + `--producer` flag, so migration = start an equivalent
  container elsewhere with the same key (liveness only; no on-chain change needed).
- **Upgrades:** roll cores one at a time (drain/migrate producers, upgrade images,
  return). Producers reconnect to their core's AMQP automatically.
- **Ports:** unchanged from Phase 1 — RPC/AMQP/gRPC bound to localhost on the core
  host; only p2p (8888) and the core-agent's control port are exposed (the latter
  mutually-authenticated to the control plane only).

## Security

- core-agent ↔ control-plane: mTLS or signed tokens; the control port is not public.
- API authz: a user can only read/act on **their own** producer.
- PayPal webhook signature verification; idempotent event handling (future).
- Signing keys encrypted at rest; least-privilege on core hosts.
- Rate limiting + audit logging on provision/deprovision.

## Cost & pricing

- Core-host cost (e.g. a Hetzner dedicated box, chain state + RabbitMQ) ÷ N
  producers + ops + margin. With N in the dozens, infra is well under **$1/user/mo**.
- Target price a few dollars/mo (covers infra + ops + margin, still far below a
  solo VM). Exact number is a business decision; the architecture supports any.

## Rollout (Phase 3 sub-phases)

- **3.1 — Prove the request→node loop (free).**
  - ✅ **core-agent built + validated** ([`../cloud/core-agent`](../cloud/core-agent)):
    provision / stop / start / delete a producer on a shared core, token-auth,
    restart-safe. Ran live against a real core.
  - Next: a minimal control-plane API in front (accounts + "Start my node" →
    calls the core-agent), no payment. Manual/single-core placement.
- **3.2 — Orchestrate the fleet.** Reconciler + multi-core + capacity-based
  placement + auto-provision new cores + per-producer status API for the PWA.
- **3.3 — Operate + monetize.** Monitoring/alerting, rolling upgrades, producer
  migration, admin dashboard; add **PayPal** billing (webhook → provision/grace/
  cancel) and the self-funding option.

## Open decisions (business, not blockers)

- Cloud provider + core-host size (Hetzner dedicated = cheapest; a managed k8s
  path if we prefer containers-as-a-service over raw hosts).
- Producers-per-core cap N (blast-radius vs. density) and the resulting price.
- Auth: email/magic-link vs. wallet-signature login for the billing identity.
- Monthly price + whether to offer the rewards-offset option at launch.
- Region strategy (single region to start; multi-region later for p2p latency).
