# Free Koinos Node

A desktop app that runs a block-producing Koinos node **for the network, not
just for yourself**. It is [Koinos Node Desktop](https://github.com/therexdev/Koinos-Node)
with one big difference: instead of keeping the block rewards it earns, it can
**redistribute the profit evenly to every node producing on the network** that
holds enough VHP — while automatically reburning the rest so its own VHP (and
its block production) never shrinks.

## How community distribution works

Producing a block on Koinos burns VHP from your balance and mints a slightly
larger KOIN reward to your wallet:

```
reward (KOIN minted)  =  VHP consumed  +  profit
```

With **Community distribution** enabled (Distribution tab):

1. **Snapshotting.** While your node runs, the app continuously reads the
   latest block headers from the chain and records every block's signer — a
   live census of which nodes are actually producing right now. Every producer
   seen during the day is a candidate for that day's distribution.
2. **Daily settlement.** Once a day (at a UTC hour you choose) the cycle
   closes:
   - The **VHP consumed** by your production that day is queued to be
     **re-burned** (KOIN → VHP), so your node's VHP ends the day level and it
     keeps producing at the same rate.
   - The **profit** is split between every node that met the eligibility
     requirements (below), in proportion to **the rewards each was qualifying
     for as they were earned** — never in proportion to stake. A node with 1,000,000 VHP
     earns exactly what a node with 10,000 earns for the same uptime. With
     everyone present the whole window, 100 KOIN across 10 nodes is 10 KOIN
     each. Your own node counts as one of them and simply keeps its share.
3. **Paced payouts.** Reburns and payouts go into a queue that drains over the
   following hours, automatically capped to the mana available at each check
   (burning and sending KOIN each spend mana 1:1 on-chain). Nothing is lost if
   the app is briefly closed or the wallet is locked — the queue picks up where
   it left off.

If the even share would be smaller than the minimum payout (a setting), nothing
is sent that day and the whole pool carries into the next day's pot. Integer
division remainders carry over too — satoshis are never dropped.

### How shares are sized — by the rewards you were there for

Every time your node collects a block reward, **each address qualifying at that
moment is credited with it**. At settlement the pool is divided in proportion to
those credits.

Worked through: your node mines a block while only A qualifies, then another
while A and B both qualify. Credits are A=2, B=1, so A takes 66% and B takes
33%. A third reward with A gone and C arrived makes it A=2, B=2, C=1 — 40/40/20.
Somebody who appears ten minutes before payout is credited for ten minutes of
rewards, not for the day.

Three properties fall out of this, all deliberate:

- **Stake never buys a bigger share.** Credits are per reward *event*, not per
  block signed, so a 1,000,000 VHP node and a 10,000 VHP node qualifying for the
  same rewards earn the same.
- **Rolled-over pools stay with who earned them.** Credits are cleared only when
  a pool is actually paid out — never when a cycle carries — so a node arriving
  after a quiet week cannot collect a share of that week.
- **Eligibility is judged as the credit accrues**, not once at the end. Buying
  VHP or joining the roster just before settlement earns nothing retroactively.
  (VHP balances are re-read hourly rather than every check, which bounds the RPC
  cost; that hour is the width of the window.)

Switch **How the pool is split** to *Evenly* for a flat split among everyone
holding credit, which ignores how much they earned.

A share that lands below the minimum payout is skipped and carried rather than
sent, because every payout spends mana 1:1 — dust transfers cost real resource
credits for no benefit.

### Who qualifies — two independent requirements

Eligibility is controlled by two checkboxes that can be used alone, together,
or not at all:

| Require VHP minimum | Running Koinos AI Node | Who earns a share |
| :---: | :---: | --- |
| ☐ | ☐ | Every node seen producing a block that day |
| ☑ | ☐ | Nodes producing blocks that hold at least the minimum VHP (default 10,000) |
| ☐ | ☑ | Every address seen running a Koinos AI Node, whether or not it produces blocks |
| ☑ | ☑ | Both: must be on a Koinos AI Node **and** producing blocks with the minimum VHP |

Block production is required in every combination except *AI only* — that mode
deliberately credits AI-node operators who aren't block producers at all.
A node whose VHP balance can't be read is never assumed to qualify.

**Verifying "Running Koinos AI Node."** The app reads a **roster URL** — an
endpoint listing the addresses currently serving on the Koinos AI network — and
snapshots it on the same schedule as block producers, so an address counts if it
was seen on the roster at any point during the day. The URL must be `https://`
(or `http://` on 127.0.0.1 for a scheduler running beside the app), responses are
size-capped, and every entry is checksum-validated before it can be paid.

> The roster decides who gets paid. Point it only at a roster you trust — whoever
> controls that endpoint can nominate payees (though never more than the day's
> profit, and never past the VHP gate when that is also on).

**It fails closed.** If the AI requirement is on and the roster could not be read
even once during a day — no URL set, endpoint down, bad response — that day pays
**nobody** and carries the entire pool into the next day. The VHP reburn still
happens, so your node's production is never affected. The cycle is recorded as
*held* with the reason, so an empty distribution is never a silent mystery.

**Turn it off and the app behaves exactly like Koinos Node Desktop**: you keep
your rewards, and the Reward-returns tab can compound them back into VHP for
you. The two engines manage the same reward KOIN, so enabling one automatically
turns the other off.

All figures come from your node's **on-chain block-production events** (reward
mints and VHP burns in block receipts) — never from balance changes — so
deposits into the wallet and manual burns are never mistaken for profit and
never distributed.

### Distribution settings

| Setting | Default | Meaning |
| --- | --- | --- |
| Enable community distribution | off | Off = behave like a normal node |
| How the pool is split | By rewards earned | Share ∝ the rewards each node was qualifying for; or a flat even split |
| Require VHP minimum | on | Gate 1: must be producing blocks with enough VHP |
| Running Koinos AI Node | off | Gate 2: must be seen on the Koinos AI network |
| Minimum VHP to qualify | 10,000 | A producer must hold at least this much VHP to receive a share |
| Koinos AI Node roster URL | *(unset)* | Where the live AI-node roster is read (required by gate 2) |
| Distribute daily at | 0 (UTC) | Hour of day the cycle closes and payouts are queued |
| Minimum share to pay out | 0.5 KOIN | Below this the day's pool carries to the next day |
| Check every | 10 min | Snapshot + queue-draining interval |

## Node value in USD

The dashboard values the node — liquid KOIN plus VHP — at KOIN's live USD price,
alongside daily, weekly and yearly earnings estimates.

The price is quoted from the **Uniswap v4 USDT/vKOIN pool** on Ethereum (vKOIN
is Vortex-bridged KOIN at 1:1), which is the same pool the Fund tab swaps
through — so a node is valued at a rate it could actually be traded at. The
quote is cached for five minutes, and a failed refresh keeps the last known
price, flagged stale, rather than blanking the figures.

**Daily is measured; weekly and yearly are projections.** Daily comes from the
rolling profit rate the dashboard already tracks; weekly and yearly are that
rate times 7 and 365. They assume network conditions and price hold, which they
will not — treat them as a run-rate, not a forecast. With no price available
every USD figure reads "—" rather than zero.

## Switching over from Koinos Node Desktop

Your existing producer key works here unchanged — either way, the node you
switch to keeps producing for the same address:

- **Import the WIF** (Wallet tab → Import): paste the private key backup from
  your current wallet, or
- **Copy the wallet file**: the encrypted `wallet.json` from Koinos Node
  Desktop is byte-compatible — copy it from the old app's data folder into this
  app's `wallet/` folder (paths are shown in Settings).

Then stop the old app's node, start this one (it uses its own Docker compose
project), let it sync — **Quick sync** restores the official chain snapshot in
hours instead of days — and re-use the same block-signing key registration if
the address is unchanged. Run only one node per producer address at a time.

## Everything else

The wallet, funding routes, burn tab, guided node setup, quick sync,
auto-recovery and reward-returns engine are inherited from Koinos Node Desktop —
see its [README](https://github.com/therexdev/Koinos-Node#readme) for the full
tour. In short:

1. **Create or import a wallet** — encrypted locally (scrypt + AES-256-GCM).
2. **Fund it and burn KOIN → VHP** — VHP is the stake that produces blocks.
3. **Start the node** (Docker, managed for you) and **register your signing
   key** with one click.
4. **Pick your reward policy** — keep and compound (Reward returns), or share
   with the network (Distribution).

## Run from source

```bash
git clone https://github.com/therexdev/free-koinos-node.git
cd free-koinos-node
npm install
npm start
```

Development:

```bash
npm test          # unit + integration tests (node --test)
```

```
electron/main.js            app bootstrap + IPC surface
electron/lib/
  distribution.js           community distribution engine (snapshot, daily
                            settlement, mana-paced reburn + payout queue)
  rewards.js                classic reward-returns engine
  chain.js                  balances, burn, transfer, block-header scanning,
                            VHP eligibility checks
  producer-stats.js         on-chain production totals (rewards, VHP consumed)
  wallet.js, keystore.js    encrypted keystore (compatible with Koinos Node
                            Desktop wallet.json)
ui/                         renderer (vanilla HTML/CSS/JS)
test/                       node --test suite
```

## Security notes

- Private keys never leave the Electron main process; payouts and reburns are
  signed locally, so the app must be open with the wallet unlocked for the
  queue to drain.
- Recipients are only ever addresses observed **signing blocks on-chain** with
  a verified VHP balance at settlement time — there is no recipient list to
  configure and nothing external can inject addresses.
- No telemetry. This app moves real funds — back up your WIF and test on
  Harbinger first if unsure.

## License

Application code: MIT. Vendored Koinos node files remain under their upstream
MIT license (see `node-template/NOTICE.md`).
