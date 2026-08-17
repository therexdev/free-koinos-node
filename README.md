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
   - The **profit** is split **evenly** between every producer seen that day
     whose VHP balance is at least the threshold (default **10,000 VHP**, a
     setting). Even means even — a node with 1,000,000 VHP gets the same share
     as a node with 10,000. 100 KOIN of profit across 10 qualifying nodes is
     10 KOIN each. Your own node counts as one of them and simply keeps its
     share.
3. **Paced payouts.** Reburns and payouts go into a queue that drains over the
   following hours, automatically capped to the mana available at each check
   (burning and sending KOIN each spend mana 1:1 on-chain). Nothing is lost if
   the app is briefly closed or the wallet is locked — the queue picks up where
   it left off.

If the even share would be smaller than the minimum payout (a setting), nothing
is sent that day and the whole pool carries into the next day's pot. Integer
division remainders carry over too — satoshis are never dropped.

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
| Minimum VHP to qualify | 10,000 | A producer must hold at least this much VHP to receive a share |
| Distribute daily at | 0 (UTC) | Hour of day the cycle closes and payouts are queued |
| Minimum share to pay out | 0.5 KOIN | Below this the day's pool carries to the next day |
| Check every | 10 min | Snapshot + queue-draining interval |

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
