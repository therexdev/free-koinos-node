# Production test — two producers minting concurrently on one shared core

Closes caveat #5 from [`../FINDINGS.md`](../FINDINGS.md): *do two co-located
producers actually **produce** on one shared core without interference?* The
coexistence spike proved they connect + each tracks head (fanout); this proves
they **both produce blocks** against one shared chain + mempool and the chain
stays consistent.

## What it does

`docker-compose.yml` here runs the **known-interoperable current stack**
(`chain v1.5.2` + `mempool v1.5.0` + `block_store v1.1.0` + `block-producer
v1.3.1`) fed the **local-koinos devnet genesis + its authorized key**, with two
`block-producer` containers in **federated** mode (`--gossip-production false`,
since there's no p2p). Both use the same authorized key on purpose — that makes
both eligible **every** slot, i.e. **maximal contention** (they produce competing
blocks at every height). PoB, where distinct producers are staggered by their VHP
lottery, is strictly easier on the shared core than this.

## Setup

The genesis + key come from the local-koinos package (not vendored here):

```bash
npm pack @roamin/local-koinos && tar -xzf roamin-local-koinos-*.tgz
mkdir -p core/chain p1/block_producer p2/block_producer config
cp package/config/genesis_data.json core/chain/genesis_data.json
cp package/config/private.key       p1/block_producer/private.key
cp package/config/private.key       p2/block_producer/private.key
cp ../../../../node-template/common/rabbitmq.conf config/rabbitmq.conf
cat > config/config.yml <<'YAML'
global:
  amqp: amqp://guest:guest@amqp:5672/
  log-level: info
  fork-algorithm: fifo
YAML
docker compose up -d
```

## Observed result

```
chain    Wrote 11 genesis objects into new database    (fork resolution: fifo)
producer1  Produced block - Height: 1,2,3 … 20   (15 accepted)
producer2  Produced block - Height: 1,2,3 … 20   (17 accepted)
# competing blocks at the SAME height (different IDs, ~4ms apart):
producer1  Produced block - Height: 5, ID: 0x1220e4f7…c5acc39
producer2  Produced block - Height: 5, ID: 0x12207634…7c4471
```

- Both producers advanced to **Height 20 in lockstep** → one canonical head; the
  shared chain resolved the competing blocks into a single consistent chain.
- Both had blocks accepted (both are winning slots and being credited).
- **Zero chain errors/exceptions**, no container restarts, over sustained
  production.

## Conclusion

Two producer microservices producing **concurrently** against one shared
chain + mempool stay fully consistent even under maximal (same-key) contention.
Combined with the coexistence/fanout proof and per-instance identity, the
shared-core + per-user-producer design holds under real production. The only
piece not reproduced in this ephemeral sandbox is a full **PoB** devnet with VHP
allocated to two distinct addresses + difficulty tuning — but PoB eligibility is
computed independently per producer from (own VHP, shared head, which each
receives via the proven fanout), so it's strictly easier than what's shown here.
Reproduce that end-to-end on a Harbinger testnet when convenient.
