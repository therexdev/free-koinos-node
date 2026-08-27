# Free Koinos Node

A desktop app that runs a block-producing Koinos node **for the network, not
just for yourself**. It is [Koinos Node Desktop](https://github.com/therexdev/Koinos-Node)
with one big difference: instead of keeping the block rewards it earns, it can
**share the profit out to other nodes on the network** — by percentage, to the
groups you choose — while automatically reburning the VHP its blocks consumed
so its own stake (and its block production) never shrinks.

## How community distribution works

Producing a block on Koinos burns VHP from your balance and mints a slightly
larger KOIN reward to your wallet:

```
reward (KOIN minted)  =  VHP consumed  +  profit
```

With **Community distribution** enabled (Distribution tab):

1. **Snapshotting.** While your node runs, the app continuously reads the
   latest block headers from the chain and records every block's signer — a
   live census of which nodes are actually producing right now — and, when an
   AI group is funded, the Koinos AI Node roster alongside it.
2. **Daily settlement.** Once a day (at a UTC hour you choose) the cycle
   closes. The **VHP consumed** by your production that day is queued to be
   **re-burned** (KOIN → VHP), so your node's VHP ends the day level and it
   keeps producing at the same rate. The **profit** is then carved up by
   percentage (below).
3. **Paced payouts.** Reburns and payouts go into a queue that drains over the
   following hours, automatically capped to the mana available at each check
   (burning and sending KOIN each spend mana 1:1 on-chain). Nothing is lost if
   the app is briefly closed or the wallet is locked — the queue picks up where
   it left off.

### Where the profit goes — four percentages

Each cycle's profit is divided by percentages you set:

| Slice | What it does |
| --- | --- |
| ♻️ **Reburn** | Compounded back into VHP, on top of the VHP your blocks consumed — this is the slice that grows the node |
| 🤖 **Koinos AI Node only** | Split between addresses seen on the AI network that are *not* producing with the minimum VHP |
| ⛏️ **Producing only** | Split between nodes producing blocks with the minimum VHP that are *not* on the AI network |
| ⭐ **Both** | Split between nodes doing both |
| 👛 **Whatever is left** | Stays in your wallet |

The three groups are **mutually exclusive** — a node is in exactly one of them
at any moment — so a node doing both is paid from the *Both* slice and from
neither of the others. The Distribution tab shows the leftover percentage live
as you type, and warns if *Both* is left at 0% while the other two are funded,
since that would pay nodes doing less and nothing to the nodes doing more.

Worked through, with 100 KOIN of profit and 40 / 10 / 20 / 30:

```
40 KOIN  reburned into VHP        (on top of restoring the VHP consumed)
10 KOIN  split between the AI-only nodes
20 KOIN  split between the producing-only nodes
30 KOIN  split between the nodes doing both
 0 KOIN  left in the wallet
```

The reburn is applied once at settlement, which is identical to taking it from
every reward as it lands — it is a flat fraction either way. Set every share to
0% and the app behaves exactly like a normal node that compounds.

**A requirement nobody is paid for is never measured.** With no AI slice funded
the roster is never read at all, so an AI operator that produces blocks is
simply a producer; with no producing slice funded, block production and VHP are
irrelevant. Turning a group to 0% can never quietly disqualify someone from a
group that *is* funded.

**A group nobody was in earns nothing** — its slice is not allocated at all and
stays in the wallet, rather than accumulating in a pool that may never have
anyone to pay. The one exception is a group that was *held* (below).

### How shares are sized — by the rewards you were there for

Every time your node collects a block reward, **each address is credited with
it in whichever group it was in at that moment**. At settlement each group's
slice is divided in proportion to those credits.

Worked through: your node mines a block while only A qualifies, then another
while A and B both qualify. Credits are A=2, B=1, so A takes 66% and B takes
33%. A third reward with A gone and C arrived makes it A=2, B=2, C=1 — 40/40/20.
Somebody who appears ten minutes before payout is credited for ten minutes of
rewards, not for the day. An address that produces all morning and then joins
the AI roster holds credit in two groups and is paid from both — in one
transfer, since every payout spends mana.

Three properties fall out of this, all deliberate:

- **Stake never buys a bigger share.** Credits are per reward *event*, not per
  block signed, so a 1,000,000 VHP node and a 10,000 VHP node qualifying for the
  same rewards earn the same.
- **Rolled-over pools stay with who earned them.** Credits are cleared only when
  a pool is actually paid out — never when a cycle carries — so a node arriving
  after a quiet week cannot collect a share of that week. Carry is kept per
  group, so it is always re-split by the group that earned it.
- **Eligibility is judged as the credit accrues**, not once at the end. Buying
  VHP or joining the roster just before settlement earns nothing retroactively.
  (VHP balances are re-read hourly rather than every check, which bounds the RPC
  cost; that hour is the width of the window.)

Switch **How each group's share is split** to *Evenly* for a flat split among
everyone holding credit in that group, which ignores how much they earned.

A share that lands below the minimum payout is skipped and carried rather than
sent, because every payout spends mana 1:1 — dust transfers cost real resource
credits for no benefit.

**Verifying "Running Koinos AI Node."** The app reads a **roster URL** — an
endpoint listing the addresses currently serving on the Koinos AI network — and
snapshots it on the same schedule as block producers, so an address counts if it
was seen on the roster at any point during the day. The URL must be `https://`
(or `http://` on 127.0.0.1 for a scheduler running beside the app), responses are
size-capped, and every entry is checksum-validated before it can be paid.

> The roster decides who gets paid from the AI slices. Point it only at a roster
> you trust — whoever controls that endpoint can nominate payees (though never
> more than those slices, and never past the VHP gate for the *Both* group).

**It fails closed.** If a roster read fails, that interval credits nobody at all
rather than filing AI operators under "producing only" and paying them from the
wrong slice. If the roster could not be read even once during a day, the AI
groups pay **nobody** and their slices **carry** into the next day rather than
being kept — an outage must never quietly turn other people's share into your
profit. The VHP reburn still happens, so your node's production is never
affected, and the cycle is recorded as *held* with the reason.

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
| Reburn | 0% | Share of profit compounded back into VHP |
| Koinos AI Node only | — | Share of profit for AI nodes that don't produce |
| Producing only | 100% | Share of profit for producers not on the AI network |
| Both | — | Share of profit for nodes doing both |
| How each group's share is split | By rewards earned | Share ∝ the rewards each node was qualifying for; or a flat even split |
| Minimum VHP to count as producing | 10,000 | 0 means any producer counts, whatever its stake |
| Koinos AI Node roster URL | *(unset)* | Where the live AI-node roster is read (needed when an AI group is funded) |
| Distribute daily at | 0 (UTC) | Hour of day the cycle closes and payouts are queued |
| Minimum share to pay out | 0.5 KOIN | Below this a share is skipped and carries to the next day |
| Check every | 10 min | Snapshot + queue-draining interval |

Upgrading from an earlier version carries the old *Require VHP minimum* /
*Running Koinos AI Node* checkboxes over as percentages that pay exactly the
same people, and moves the pending carry and credits with them.

## Node value in USD

The dashboard values the node — liquid KOIN plus VHP — at KOIN's live USD price,
alongside daily, weekly and yearly earnings estimates.

The price is quoted from the **Uniswap v4 USDT/vKOIN pool** on Ethereum (vKOIN
is Vortex-bridged KOIN at 1:1), which is the same pool the Fund tab swaps
through. The quote is cached for five minutes, and a failed refresh keeps the
last known price, flagged stale, rather than blanking the figures.

It quotes **both directions and takes the mid**. A single buy quote is not the
market price: it pays the pool's 1% fee plus the probe's price impact, which
read about 1.6% high against a mid-price feed in practice. Buying and selling
cost the same in each direction, so the geometric mean of the two cancels both
and lands on the mid. If the sell leg fails the buy-only price is used instead,
and the tile says so.

**Daily is measured; weekly and yearly are projections.** Daily comes from the
rolling profit rate the dashboard already tracks; weekly and yearly are that
rate times 7 and 365. They assume network conditions and price hold, which they
will not — treat them as a run-rate, not a forecast. With no price available
every USD figure reads "—" rather than zero.

### Readings hold through a hiccup

The dashboard polls the chain every few seconds. When a poll fails — an RPC
timeout, the node restarting mid-request — the last good figures stay on screen
and the timestamp reads *reconnecting…*, instead of every tile emptying to "—"
and refilling on the next tick. Readings are held for up to ten minutes; past
that they clear, because a ten-minute-old balance is no longer worth showing.
Mana is read the same way rather than defaulting to zero, so a failed call can
never look like an empty mana bar.

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
  distribution.js           community distribution engine (snapshot, group
                            classification, percentage settlement, mana-paced
                            reburn + payout queue)
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
  a verified VHP balance, or returned by the AI roster you configured — there is
  no recipient list to configure and nothing else can inject addresses.
- No telemetry. This app moves real funds — back up your WIF and test on
  Harbinger first if unsure.

## License

Application code: MIT. Vendored Koinos node files remain under their upstream
MIT license (see `node-template/NOTICE.md`).
