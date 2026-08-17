# Cloud node from your phone — architecture & roadmap

Goal: someone with **only a phone** runs **their own** Koinos block producer in the
cloud — keeping their stake, their vote, and 100% of rewards — instead of handing
it to a pool. Turnkey managed hosting (we run the fleet), PWA-first phone app.

## Why it's self-sovereign, not a pool

Koinos separates two keys, and the app already uses this (`chain.js` →
`pob.register_public_key`):

- **Main key (stays on the phone):** holds KOIN/VHP, burns KOIN→VHP, registers the
  producer key, votes on governance, and receives 100% of block rewards (minted
  straight to the user's address). Never leaves the device.
- **Block-signing key (lives on the cloud node):** can do exactly one thing —
  sign blocks for the registered producer address. It cannot move funds or vote.
  If it's ever compromised, the user just re-registers a new key from their phone;
  funds and vote are never exposed.

So the cloud box is a **dumb, replaceable block-signer** the user rents. That's the
whole difference from a pool (which holds your stake, votes for you, takes a cut).

## Components

1. **PWA (phone)** — installable mobile web app. Reuses our existing `koilib`
   wallet + chain logic (browser-adapted: Web Crypto + IndexedDB instead of
   Node crypto + a keystore file). Screens: wallet, fund (reuse the ETH→KOIN
   flow), burn→VHP, **Start my node**, node status/rewards, governance vote,
   subscription.
2. **Control plane (our backend)** — provisions + manages the fleet: one isolated
   node per user, health/restart/upgrades, billing, and an API the PWA calls
   (start/stop/status/logs, and the node's block-signing public key to register).
   Never holds the user's main key.
3. **Node image + agent (each cloud box)** — the existing `node-template` docker
   compose + quick-sync-from-backup, plus a small agent that: generates the
   block-signing key locally, exposes its **public** key + sync/status to the
   control plane, and applies start/stop. Same unit whether we use one VM per
   user or dense containers.

## Security model

- The control plane and node boxes **only ever hold block-signing (hot) keys**,
  scoped to producing blocks. The user's main key is client-side only.
- Registration flow: node generates keypair → agent reports the **public** key →
  PWA asks the user to sign `register_public_key` with their **main key** →
  broadcast. The user can re-register or unregister anytime from the phone.
- Rewards mint to the user's address; we never custody them.

## Cost reality (drives the subscription)

- A full node is always-on: ~2–4 GB RAM, ~30–60 GB storage (grows), 24/7.
- Cheapest viable ≈ **$6–15/mo** of cloud per node (e.g., Hetzner/DO), so the
  subscription must cover that + ops + margin.
- **Quick-sync-from-backup** (already built) makes a fresh cloud node ready in
  minutes, not days — critical for a good "Start my node" experience.
- Density (1 VM/user vs many containers/host) is the main cost lever; start simple
  (1 VM/user), optimize later.

## Roadmap

- **Phase 1 — Node unit (de-risk the core):** a provisioning script + agent that
  turns a bare Ubuntu VM into a running, quick-synced node that generates a
  block-signing key and reports status. The replicable unit the whole service is
  built on. Testable on any single VM.
- **Phase 2 — PWA:** browser-adapted wallet + chain (reuse `koilib`), node
  status/monitor, and the `register_public_key` flow. Works against a Phase-1 node
  by RPC.
- **Phase 3 — Control plane + billing:** fleet orchestration (spin up per user,
  monitor, upgrade), subscription billing, isolation, dashboards.
- **Phase 4 — Native app** (wrap/rebuild once proven), push notifications.

## Cost lever: shared core + per-user producer (validated)

To make an *individual* node cheap without turning into a pool, a Koinos node
splits cleanly into an expensive shared half and a trivial per-user half:

- **Shared core (one per host):** `chain` + `mempool` + `block_store` + `p2p` +
  `amqp`. Holds the chain state (~40 GB, growing) and does all the syncing — the
  real cost driver, now **O(1) instead of O(N)**.
- **Per-user producer:** one `koinos-block-producer` with its **own** `private.key`
  and its **own** `--producer` address, pointed at the shared core. Still fully
  self-sovereign — own key, own vote, own 100% rewards; the core is just read-only
  chain data. **This is not a pool** (Fogata shares funds + producer; this shares
  only infrastructure).

A spike in [`../cloud/experiments/shared-core`](../cloud/experiments/shared-core)
confirmed this from the Koinos source (block producers declare **exclusive**
`amq.gen-*` event queues → fanout, never a shared/competing queue), empirically for
coexistence (two producers on one core, distinct keys/addresses, distinct queues,
no collision), **and empirically for production** (two producers minting
*concurrently* on one shared core reached a single consistent head with zero chain
errors under maximal same-key contention). Measured marginal cost of an added user:
**~3 MB RAM + a 28 KB key file** — so one modest host serves dozens of independent
producers and the per-user price falls well under **$1/mo**. Full write-up +
evidence in that folder's `FINDINGS.md` and `production-test/`.

## Roadmap

- **Phase 1 — Node unit (de-risk the core):** a provisioning script + agent that
  turns a bare Ubuntu VM into a running, quick-synced node that generates a
  block-signing key and reports status. The replicable unit the whole service is
  built on. Testable on any single VM. ✅
- **Phase 2 — PWA:** browser-adapted wallet + chain (reuse `koilib`), node
  status/monitor, and the `register_public_key` flow. Works against a Phase-1 node
  by RPC.
- **Phase 3 — Control plane:** fleet orchestration over **shared cores** (drop in
  one producer per subscriber — the cheap unit validated above), monitor, upgrade,
  isolation, dashboards. **Free while testing**; billing (PayPal, per producer)
  comes later. The **core-agent** (provision/stop/start/delete a producer) is built
  + validated ([`../cloud/core-agent`](../cloud/core-agent)). **Design:
  [`cloud-control-plane.md`](./cloud-control-plane.md).**
- **Phase 4 — Native app** (wrap/rebuild once proven), push notifications.

## Decisions needed before Phase 3 (not before Phase 1)

- Cloud provider (Hetzner = cheapest, DigitalOcean = easy API, AWS/GCP = scale).
- Density: **shared core + per-user producer** (validated above) vs. 1 VM/user
  (simpler, but ~10× the per-user cost). Shared core is the path to a viable price.
- Billing (card via Stripe, or crypto/KOIN subscription) and monthly price.
- Producer redundancy: how many shared cores to run so one core's downtime doesn't
  stall a whole cohort (liveness only — keys/funds are never at risk).
- PWA domain/branding.
