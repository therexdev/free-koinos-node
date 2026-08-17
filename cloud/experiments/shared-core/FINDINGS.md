# Spike: shared core + per-user producer — FINDINGS

**Question.** Can we drastically cut the per-user cloud-node cost *without* becoming
a pool — by running **one** shared Koinos core (chain/mempool/block_store/p2p/amqp)
that serves **many independent block producers**, each with its own signing key,
its own `--producer` address, its own vote, and 100% of its own rewards?

**Verdict: YES — validated at the source level and empirically.** Two producers ran
against one shared core with no AMQP collision, each generating its own key and each
receiving its own copy of every head update. Marginal cost of an added user ≈ **3 MB
RAM + a 28 KB key file.**

This is the opposite of Fogata: Fogata shares the *funds and the producer identity*
(a pool); here we share only the *read-only chain infrastructure*, and every user
stays a fully independent, self-sovereign producer.

---

## Why it works (source level)

From `koinos/koinos-block-producer` and `koinos/koinos-mq-cpp`:

1. **The signing key is per-instance.** `koinos_block_producer.cpp` reads
   `basedir/block_producer/private.key`, generating one if absent, and writes
   `public.key`. Give each producer its own basedir → its own key.
2. **The producer (reward) address is a per-instance flag.** `--producer <addr>`
   (`-f`), required for PoB. Rewards mint to that address. Each user sets their own.
3. **The producer subscribes, it doesn't serve.** It only calls
   `add_broadcast_handler("koinos.mempool.block_accepted")` and
   `("koinos.gossip.status")`. It registers **no** RPC handler.
4. **Broadcast handlers get a private queue.** In `request_handler::on_connect`,
   a broadcast (`competing_consumer = false`) declares the queue as
   `declare_queue("" /*server-named*/, durable=false, exclusive=true, …)` on the
   `koinos.event` **topic** exchange. So every instance gets its **own** `amq.gen-*`
   queue → true fanout. Only `add_rpc_handler` uses a shared named queue
   (`competing_consumer = true`), and the producer registers none.

⇒ N producers on one AMQP core cannot collide, and each one independently sees
every block-accepted event (so each tracks the true head and schedules its own
production from its own VHP).

## Why it works (empirical)

`docker-compose.yml` here: one `amqp`+`chain`+`mempool`+`block_store` core + two
`koinos-block-producer` containers with separate basedirs and different
`--producer` addresses. Observed:

**Two distinct keys, two distinct reward addresses, both on the same core:**
```
producer1  Public address: 1FmHSBaK6Th7SUthxZy8reMHQQcGF86cZ2   Producer address: 19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK
producer2  Public address: 1J9iegAScnwjYuHTEj5o4BwYhetniFHvMJ   Producer address: 12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq
both  ->  Established connection to chain / mempool  ->  Starting block producer   (no errors, no restarts)
```

**The broker proves fanout, not round-robin** (RabbitMQ management API):
```
koinos.event  ->  koinos.mempool.block_accepted   ->  2 distinct queues (one per producer)
koinos.event  ->  koinos.gossip.status            ->  2 distinct queues (one per producer)
every producer queue:  exclusive = True,  consumers = 1
only shared/named queues in the broker:  koinos.rpc.chain, koinos.rpc.mempool, koinos.rpc.block_store  (the CORE services)
```
If producers shared a competing queue, there'd be **one** queue with 2 consumers and
each would see only ~half the head updates. There were **two** exclusive queues — each
producer gets the full stream.

**Resource footprint** (`docker stats`, idle at genesis):

| Container | RAM | Notes |
|---|---|---|
| producer1 | **3.1 MB** | ← marginal cost of one user |
| producer2 | **3.0 MB** | ← marginal cost of one user |
| chain | 6.9 MB | shared |
| mempool | 2.6 MB | shared |
| block_store | 24 MB | shared |
| amqp (RabbitMQ) | 145 MB | shared, fixed |

Per-producer disk (`p1/`, `p2/`) = **28 KB** each — literally just
`block_producer/{private,public}.key` + config + a log.

## The cost model this unlocks

- **Fixed, shared (once per host):** RabbitMQ (~150 MB) + chain/mempool/block_store/p2p,
  and the chain **state on disk (~40 GB on mainnet, growing)** — the real cost driver,
  now **O(1) instead of O(N)**.
- **Marginal, per user:** one ~3 MB producer + a key file ≈ **negligible**.

So a single modest host (say a Hetzner box with the chain state + RabbitMQ) can host
**dozens** of independent producers. Split the fixed host cost across them and the
per-user price falls toward **well under $1/mo** — while each user keeps their own key,
own vote, and 100% of rewards. Solo, that same user pays for a whole VM.

## Still not a pool (self-sovereignty preserved)

| | Fogata (pool) | Shared core (this) |
|---|---|---|
| Funds / VHP | in a pool contract | stay in each user's own address |
| Producer identity | one shared pool address | each user's own `--producer` |
| Block-producer vote | the operator's | **each user's own** |
| Rewards | split by contract, minus cut | 100% mint to each user |
| What's shared | the funds + the producer | only read-only chain data |

## Honest caveats / what's left to test

1. **Availability coupling.** All co-located producers depend on the one shared core;
   if it stops, they all stop (no fund/key risk — just liveness). Mitigate by running
   a few redundant cores and spreading users; a user can also point their producer at
   any other chain node (the key is theirs).
2. **Path trust.** Blocks gossip out through the shared p2p, so the host is on the
   path. The user's key is theirs, so they can always re-home; but in our hosting we're
   the route (same mild trust as any host).
3. **Memory here is idle/genesis.** A synced mainnet chain uses more RAM (RocksDB
   caches) and ~40 GB disk. That's the **shared** cost and doesn't multiply per user;
   the ~3 MB **marginal** figure is the one that matters for density.
4. **Reward variance still applies per user.** Small VHP ⇒ infrequent blocks. Density
   fixes the *cost* side, not the variance side; that's inherent to solo production and
   is the honest limit of "individual, not pool."
5. **Production under load — RESOLVED.** A follow-up test
   ([`production-test/`](production-test/)) ran two producer microservices
   producing **concurrently** on one shared core (federated, same authorized key =
   maximal contention: competing blocks at *every* height). Both advanced to
   Height 20 in lockstep on a single canonical head, both had blocks accepted,
   **zero chain errors**, no restarts. The shared chain + mempool stay consistent
   under concurrent production. Not reproduced here: a full **PoB** devnet with VHP
   allocated to two distinct addresses (needs difficulty tuning) — but PoB
   eligibility is computed independently per producer from (own VHP, shared head via
   the proven fanout), so it is strictly easier than the same-key contention shown.
   Reproduce end-to-end on Harbinger testnet when convenient.

## How this feeds Phase 3 (control plane + billing)

The control plane provisions **shared cores** (reusing Phase 1's node setup) and, per
subscriber, drops in **one producer container** (their key + their `--producer`). The
agent already reports each producer's public key for the phone to register. Billing
(the monthly card charge) meters per-producer — which is exactly the unit this spike
shows is cheap to add and remove.
