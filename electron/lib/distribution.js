"use strict";

const { parseAmount, addSats, subSats, cmpSats, formatAmount } = require("./format");
const { BURN_MANA_CUSHION } = require("./constants");

// Community profit distribution.
//
// While the node produces, the engine watches the whole network: every check
// interval it reads the latest block headers and records each block's signer —
// a snapshot of which nodes are actually live and producing. Once a day (at a
// configurable UTC hour) it closes the cycle:
//
//   rewards      = KOIN minted to this node by block production this cycle
//   vhpConsumed  = VHP this node burned producing those blocks
//   profit       = rewards − vhpConsumed
//
//   1. The vhpConsumed portion is re-burned (KOIN → VHP) so this node's VHP —
//      and with it, its share of block production — stays level.
//   2. The profit (plus any carry from earlier cycles) is split EVENLY between
//      every producer seen this cycle whose VHP balance is at least the
//      configured threshold (default 10,000 VHP). Even means even: a node with
//      1M VHP gets the same share as one with 10k. This node counts as one of
//      the eligible producers and simply keeps its own share.
//
// Both the reburn and the payouts go into a queue that is drained across
// checks, capped by the mana available right now (burning and sending KOIN
// each require mana >= amount on-chain), so a large distribution settles in
// chunks over hours instead of reverting.
//
// All figures come from on-chain block-production events (via ProducerStats),
// never balance deltas — deposits and manual burns are never distributed.

const DAY_MS = 86400000;
const MAX_SCAN_BLOCKS = 1200;     // per tick; ~1 hour of chain at 3s blocks
const SNAPSHOT_BACKFILL = 400;    // first scan reaches this far back (~20 min)
const MAX_TX_PER_TICK = 8;        // bound each tick's signing work
const HISTORY_KEEP = 30;          // distribution cycles kept for the UI
const ACTIONS_KEEP = 80;          // recent reburn/payout txs kept for the UI
const REBURN_MIN_CHUNK = "100000000"; // don't reburn dust chunks (< 1 KOIN)…

function validateDistributionConfig(cfg) {
  const minVhpKoin = String(cfg.minVhpKoin ?? "").trim();
  if (cmpSats(parseAmount(minVhpKoin), "0") <= 0) {
    throw new Error("Minimum VHP must be greater than zero");
  }
  const hour = Number(cfg.payoutHourUtc);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("Distribution hour must be a whole number between 0 and 23 (UTC)");
  }
  const minPayoutKoin = String(cfg.minPayoutKoin ?? "").trim();
  parseAmount(minPayoutKoin); // throws when invalid; "0" is allowed
  const poll = Number(cfg.pollMinutes);
  if (!Number.isFinite(poll) || poll < 1 || poll > 24 * 60) {
    throw new Error("Check interval must be between 1 minute and 24 hours");
  }
  return {
    enabled: !!cfg.enabled,
    minVhpKoin,
    payoutHourUtc: hour,
    minPayoutKoin,
    pollMinutes: poll,
  };
}

// The first moment at `hourUtc:00 UTC` strictly after `afterMs` — cycles close
// at most once a day, at the configured hour.
function nextCycleClose(afterMs, hourUtc) {
  const d = new Date(Number(afterMs));
  const sameDay = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hourUtc, 0, 0, 0);
  return sameDay > Number(afterMs) ? sameDay : sameDay + DAY_MS;
}

// Fold block headers into the cycle's seen-producers map. Mutates + returns.
function mergeSeen(seen, headers) {
  for (const h of headers || []) {
    if (!h?.signer) continue;
    const cur = seen[h.signer] ?? { blocks: 0, lastSeenHeight: 0, lastSeenMs: 0 };
    cur.blocks += 1;
    if (h.height > cur.lastSeenHeight) cur.lastSeenHeight = h.height;
    if (h.timestamp > cur.lastSeenMs) cur.lastSeenMs = h.timestamp;
    seen[h.signer] = cur;
  }
  return seen;
}

// Close one cycle: how much to reburn, and how the profit pool splits.
// Pure — everything in satoshi strings.
//
//   periodRewardsSat / periodVhpConsumedSat — this node's production this cycle
//   carrySat      — undistributed remainder from earlier cycles
//   eligible      — producer addresses seen this cycle with VHP >= threshold
//                   (may include selfAddress; self keeps its share, no transfer)
//   minPayoutSat  — when the even share is below this, nothing is paid and the
//                   whole pool carries into the next cycle
function settleCycle({ periodRewardsSat, periodVhpConsumedSat, carrySat, eligible, selfAddress, minPayoutSat }) {
  const rewards = cmpSats(periodRewardsSat, "0") > 0 ? periodRewardsSat : "0";
  const vhpConsumed = cmpSats(periodVhpConsumedSat, "0") > 0 ? periodVhpConsumedSat : "0";
  // Reburn exactly what production consumed, so VHP ends the cycle level.
  const reburnSat = vhpConsumed;
  const profitSat = cmpSats(rewards, vhpConsumed) > 0 ? subSats(rewards, vhpConsumed) : "0";
  const poolSat = addSats(profitSat, carrySat ?? "0");

  const n = eligible.length;
  const base = {
    reburnSat,
    profitSat,
    poolSat,
    eligibleCount: n,
    shareSat: "0",
    recipients: [],
    selfKeptSat: "0",
    carryOutSat: poolSat,
  };
  if (n === 0 || cmpSats(poolSat, "0") <= 0) return base;

  const share = (BigInt(poolSat) / BigInt(n)).toString();
  if (cmpSats(share, minPayoutSat) < 0) return base; // pool too small — carry it all

  const recipients = eligible.filter((a) => a !== selfAddress).map((address) => ({ address, amountSat: share }));
  const selfKeptSat = eligible.includes(selfAddress) ? share : "0";
  // The share×n floor remainder carries; self's share stays in the wallet.
  const carryOutSat = subSats(poolSat, (BigInt(share) * BigInt(n)).toString());
  return { ...base, shareSat: share, recipients, selfKeptSat, carryOutSat };
}

// Which transactions to attempt this tick, given what mana/liquid allow.
// Reburn first (protect the VHP level), then payouts in queue order. Each
// payout moves its full share in one transfer — when the next one doesn't fit,
// the queue simply waits for mana to recharge. Pure.
function planTick({ reburnOwedSat, payouts, availableLiquidSat, availableManaSat, maxActions = MAX_TX_PER_TICK }) {
  let liquid = BigInt(availableLiquidSat);
  let mana = BigInt(availableManaSat);
  const actions = [];
  let limitedBy = null;

  const fit = (amountSat) => {
    const a = BigInt(amountSat);
    if (a <= liquid && a <= mana) return true;
    limitedBy = mana < a ? "mana" : "liquid";
    return false;
  };
  const spend = (amountSat) => {
    liquid -= BigInt(amountSat);
    mana -= BigInt(amountSat);
  };

  let owed = BigInt(reburnOwedSat);
  if (owed > 0n) {
    let chunk = owed;
    if (chunk > liquid) { chunk = liquid; limitedBy = "liquid"; }
    if (chunk > mana) { chunk = mana; limitedBy = "mana"; }
    // A partial chunk below the dust floor isn't worth a transaction — wait.
    const isFinal = chunk === owed;
    if (chunk > 0n && (isFinal || chunk >= BigInt(REBURN_MIN_CHUNK))) {
      actions.push({ kind: "reburn", amountSat: chunk.toString() });
      spend(chunk.toString());
    }
  }

  for (const p of payouts) {
    if (actions.length >= maxActions) break;
    if (cmpSats(p.amountSat, "0") <= 0) continue;
    if (!fit(p.amountSat)) break; // FIFO: don't skip ahead of a blocked payout
    actions.push({ kind: "payout", address: p.address, amountSat: p.amountSat });
    spend(p.amountSat);
  }
  return { actions, limitedBy };
}

// Watches the network, closes a distribution cycle once a day, and drains the
// resulting reburn + payout queue. Mirrors RewardEngine's shape so main.js and
// the UI treat both engines the same way.
class DistributionEngine {
  constructor({ chain, wallet, settings, state, stats, onEvent }) {
    this.chain = chain;
    this.wallet = wallet;
    this.settings = settings;
    this.state = state;
    this.stats = stats;
    this.onEvent = onEvent || (() => {});
    this._timer = null;
    this._busy = false;
    this.last = null;
    this.nextRunAt = null;
  }

  config() {
    return this.settings.get("distribution");
  }

  configure(patch) {
    const cfg = validateDistributionConfig({ ...this.config(), ...patch });
    this.settings.set("distribution", cfg);
    this.start();
    return cfg;
  }

  start() {
    this.stop();
    const cfg = this.config();
    if (!cfg.enabled) return;
    const ms = cfg.pollMinutes * 60 * 1000;
    this.nextRunAt = Date.now() + ms;
    this._timer = setInterval(() => {
      this.nextRunAt = Date.now() + ms;
      this.tick("timer").catch(() => {});
    }, ms);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    this.nextRunAt = null;
  }

  _stateKey(networkId, address) {
    return `distribution.${networkId}.${address}`;
  }

  _readState(key) {
    const st = this.state.get(key, null) ?? {
      anchor: null,            // { rewards, vhpConsumed } totals at cycle start
      cycleStartedAt: null,
      lastClosedAt: null,
      lastScannedHeight: null, // network snapshot progress
      seen: {},                // { [producer]: { blocks, lastSeenHeight, lastSeenMs } }
      carry: "0",              // undistributed profit carried between cycles
      reburnOwed: "0",         // KOIN still to burn back into VHP
      payouts: [],             // [{ address, amountSat }] waiting to be sent
      history: [],             // closed cycles (newest first)
      actions: [],             // executed reburn/payout txs (newest first)
    };
    st.seen ??= {};
    st.payouts ??= [];
    st.history ??= [];
    st.actions ??= [];
    return st;
  }

  _queueEmpty(st) {
    return cmpSats(st.reburnOwed, "0") <= 0 && st.payouts.length === 0;
  }

  async tick(trigger = "timer", { forceClose = false } = {}) {
    if (this._busy) return this.status();
    this._busy = true;
    try {
      return await this._tick(trigger, forceClose);
    } finally {
      this._busy = false;
    }
  }

  async _tick(trigger, forceClose) {
    const done = (outcome, detail = {}) => {
      this.last = { time: Date.now(), trigger, outcome, ...detail };
      return this.status();
    };
    const cfg = this.config();
    if (!cfg.enabled && trigger === "timer") return done("disabled");
    const ws = this.wallet.status();
    if (!ws.exists) return done("no-wallet");

    const networkId = this.chain.network().id;
    const address = ws.address;
    const key = this._stateKey(networkId, address);

    // Production figures come from on-chain reward/burn events via
    // ProducerStats — the same source the Dashboard and Reward returns use.
    let statsRes;
    try {
      statsRes = await this.stats.refresh(address);
    } catch (e) {
      return done("rpc-error", { message: String(e.message) });
    }
    if (!statsRes || statsRes.available === false) {
      return done("history-unavailable", {
        message: "Block-reward history isn't available on this network's RPC, so distribution can't run here.",
      });
    }
    if (statsRes.syncing) {
      return done("syncing", { message: "Reading reward history… distribution resumes once it's caught up." });
    }

    const st = this._readState(key);
    const now = Date.now();

    // First run: anchor the cycle at the current lifetime totals — only
    // production from here forward is distributed.
    if (!st.anchor) {
      st.anchor = { rewards: statsRes.totals.rewards, vhpConsumed: statsRes.totals.vhpConsumed };
      st.cycleStartedAt = now;
      this.state.set(key, st);
      return done("anchored", {
        message: `Tracking production from now. The first distribution closes at ${new Date(nextCycleClose(now, cfg.payoutHourUtc)).toUTCString()}.`,
      });
    }

    // Snapshot who is producing on the network right now (best-effort — an RPC
    // hiccup here must not stall accounting or the payout queue).
    let snapshotError = null;
    try {
      const head = await this.chain.headInfo();
      const headHeight = head.height;
      if (headHeight > 0) {
        let from = st.lastScannedHeight == null
          ? Math.max(1, headHeight - SNAPSHOT_BACKFILL + 1)
          : st.lastScannedHeight + 1;
        // After a long offline gap, skip ahead — regular producers will show
        // up again within the next scans.
        if (headHeight - from + 1 > MAX_SCAN_BLOCKS) from = headHeight - MAX_SCAN_BLOCKS + 1;
        if (from <= headHeight) {
          const { headers } = await this.chain.blockHeaders(from, headHeight);
          mergeSeen(st.seen, headers);
          st.lastScannedHeight = headHeight;
        }
      }
    } catch (e) {
      snapshotError = String(e.message);
    }

    // Close the cycle when the daily boundary has passed — but never while the
    // previous cycle's queue is still draining, so cycles can't overlap.
    const dueAt = nextCycleClose(st.lastClosedAt ?? st.cycleStartedAt, cfg.payoutHourUtc);
    let closed = null;
    if ((now >= dueAt || forceClose) && this._queueEmpty(st)) {
      try {
        closed = await this._closeCycle(cfg, st, statsRes, address, now);
      } catch (e) {
        this.state.set(key, st);
        return done("rpc-error", { message: `Couldn't close the cycle: ${String(e.message)}` });
      }
    }

    // Drain the queue (reburn first, then payouts), capped by mana/liquid.
    let progress = null;
    if (!this._queueEmpty(st)) {
      if (!ws.unlocked) {
        this.state.set(key, st);
        return done("locked", {
          closed,
          message: "Unlock the wallet so the pending reburn and payouts can be signed.",
        });
      }
      progress = await this._drainQueue(cfg, st, address);
    }

    this.state.set(key, st);

    if (progress?.txError) {
      return done("tx-error", { closed, progress, message: progress.txError });
    }
    if (closed) {
      const c = closed;
      const msg =
        c.eligibleCount > 0 && cmpSats(c.share, "0") > 0
          ? `Cycle closed: ${formatAmount(c.pool)} KOIN profit split between ${c.eligibleCount} nodes ` +
            `(${formatAmount(c.share)} KOIN each) — reburning ${formatAmount(c.reburn)} KOIN to restore VHP.`
          : `Cycle closed: nothing to distribute yet (${formatAmount(c.pool)} KOIN carries over` +
            `${cmpSats(c.reburn, "0") > 0 ? `; reburning ${formatAmount(c.reburn)} KOIN to restore VHP` : ""}).`;
      this.onEvent({ type: "distribution", message: msg });
      return done("cycle-closed", { closed, progress, snapshotError, message: msg });
    }
    if (progress) {
      const doneCount = progress.executed.length;
      const left = st.payouts.length;
      const reburnLeft = cmpSats(st.reburnOwed, "0") > 0 ? `${formatAmount(st.reburnOwed)} KOIN reburn` : null;
      const parts = [];
      if (doneCount > 0) parts.push(`${doneCount} transaction${doneCount === 1 ? "" : "s"} sent`);
      if (reburnLeft) parts.push(`${reburnLeft} still queued`);
      if (left > 0) parts.push(`${left} payout${left === 1 ? "" : "s"} still queued`);
      const waiting = progress.limitedBy === "mana" ? " — waiting for mana to recharge." : progress.limitedBy === "liquid" ? " — waiting for liquid KOIN." : "";
      const message = (parts.join(", ") || "Queue idle") + waiting;
      if (doneCount > 0) this.onEvent({ type: "distribution", message });
      return done(this._queueEmpty(st) ? "distributed" : "distributing", { progress, snapshotError, message });
    }
    return done("watching", {
      snapshotError,
      message: snapshotError
        ? `Watching the network (snapshot hiccup: ${snapshotError})`
        : `Watching the network — ${Object.keys(st.seen).length} producers seen this cycle. Next distribution at ${new Date(dueAt).toUTCString()}.`,
    });
  }

  // Compute the cycle's figures, find who qualifies, and queue the work.
  async _closeCycle(cfg, st, statsRes, selfAddress, now) {
    const periodRewardsSat = subSats(statsRes.totals.rewards, st.anchor.rewards);
    const periodVhpConsumedSat = subSats(statsRes.totals.vhpConsumed, st.anchor.vhpConsumed);

    // Who was live this cycle, and who has the VHP to qualify.
    const seenAddresses = Object.keys(st.seen).filter((a) => this.chain.isValidAddress(a));
    const minVhpSat = parseAmount(cfg.minVhpKoin);
    let eligible = [];
    let checked = 0;
    if (seenAddresses.length > 0) {
      const balances = await this.chain.vhpBalances(seenAddresses);
      for (const a of seenAddresses) {
        if (balances[a] == null) continue; // balance lookup failed — not judged
        checked += 1;
        if (cmpSats(balances[a], minVhpSat) >= 0) eligible.push(a);
      }
    }

    const settle = settleCycle({
      periodRewardsSat,
      periodVhpConsumedSat,
      carrySat: st.carry,
      eligible,
      selfAddress,
      minPayoutSat: parseAmount(cfg.minPayoutKoin),
    });

    if (cmpSats(settle.reburnSat, "0") > 0) st.reburnOwed = addSats(st.reburnOwed, settle.reburnSat);
    st.payouts.push(...settle.recipients);
    st.carry = settle.carryOutSat;

    const record = {
      time: now,
      periodRewards: cmpSats(periodRewardsSat, "0") > 0 ? periodRewardsSat : "0",
      periodVhpConsumed: cmpSats(periodVhpConsumedSat, "0") > 0 ? periodVhpConsumedSat : "0",
      profit: settle.profitSat,
      pool: settle.poolSat,
      reburn: settle.reburnSat,
      share: settle.shareSat,
      eligibleCount: settle.eligibleCount,
      recipientCount: settle.recipients.length,
      selfKept: settle.selfKeptSat,
      carryOut: settle.carryOutSat,
      seenCount: seenAddresses.length,
      checkedCount: checked,
      minVhpKoin: cfg.minVhpKoin,
    };
    st.history.unshift(record);
    st.history = st.history.slice(0, HISTORY_KEEP);

    // Start the next cycle from the current totals, with a fresh snapshot.
    st.anchor = { rewards: statsRes.totals.rewards, vhpConsumed: statsRes.totals.vhpConsumed };
    st.seen = {};
    st.cycleStartedAt = now;
    st.lastClosedAt = now;
    return record;
  }

  // Execute as much of the queue as balances allow right now.
  async _drainQueue(cfg, st, address) {
    let balances;
    try {
      balances = await this.chain.balances(address);
    } catch (e) {
      return { executed: [], limitedBy: null, txError: `RPC error reading balances: ${String(e.message)}` };
    }
    const keep = parseAmount(this.settings.get("keepLiquidKoin", "10"));
    const availableLiquidSat = cmpSats(balances.koin, keep) > 0 ? subSats(balances.koin, keep) : "0";
    const manaFree = subSats(balances.mana ?? "0", BURN_MANA_CUSHION);
    const availableManaSat = cmpSats(manaFree, "0") > 0 ? manaFree : "0";

    const plan = planTick({
      reburnOwedSat: st.reburnOwed,
      payouts: st.payouts,
      availableLiquidSat,
      availableManaSat,
    });

    const executed = [];
    let txError = null;
    for (const action of plan.actions) {
      try {
        if (action.kind === "reburn") {
          const tx = await this.chain.burn(this.wallet.signer, action.amountSat);
          st.reburnOwed = subSats(st.reburnOwed, action.amountSat);
          this._logAction(st, { kind: "reburn", amount: action.amountSat, txId: tx.txId });
          executed.push({ ...action, txId: tx.txId });
        } else {
          const tx = await this.chain.transfer(this.wallet.signer, {
            to: action.address,
            amountSat: action.amountSat,
            token: "koin",
          });
          // Remove exactly this payout from the queue.
          const i = st.payouts.findIndex((p) => p.address === action.address && p.amountSat === action.amountSat);
          if (i >= 0) st.payouts.splice(i, 1);
          this._logAction(st, { kind: "payout", to: action.address, amount: action.amountSat, txId: tx.txId });
          executed.push({ ...action, txId: tx.txId });
        }
      } catch (e) {
        txError = `${action.kind === "reburn" ? "Reburn" : `Payout to ${action.address}`} failed: ${String(e.message)}`;
        break; // leave the rest queued; next tick retries
      }
    }
    return { executed, limitedBy: plan.limitedBy, txError };
  }

  _logAction(st, action) {
    st.actions.unshift({ time: Date.now(), ...action });
    st.actions = st.actions.slice(0, ACTIONS_KEEP);
  }

  status() {
    const cfg = this.config();
    const ws = this.wallet.status();
    const networkId = this.chain.network().id;
    const st = ws.address ? this._readState(this._stateKey(networkId, ws.address)) : null;

    let derived = null;
    if (st) {
      // Cycle-so-far figures from the cached stats (no RPC from status()).
      const cached = this.stats.get(networkId, ws.address);
      let cycle = null;
      if (st.anchor && cached?.totals) {
        const rewards = subSats(cached.totals.rewards, st.anchor.rewards);
        const vhpConsumed = subSats(cached.totals.vhpConsumed, st.anchor.vhpConsumed);
        const r = cmpSats(rewards, "0") > 0 ? rewards : "0";
        const v = cmpSats(vhpConsumed, "0") > 0 ? vhpConsumed : "0";
        cycle = {
          startedAt: st.cycleStartedAt,
          dueAt: nextCycleClose(st.lastClosedAt ?? st.cycleStartedAt, cfg.payoutHourUtc),
          rewards: r,
          vhpConsumed: v,
          profit: cmpSats(r, v) > 0 ? subSats(r, v) : "0",
          seenCount: Object.keys(st.seen).length,
        };
      }
      const payoutTotal = st.payouts.reduce((acc, p) => addSats(acc, p.amountSat), "0");
      derived = {
        anchored: !!st.anchor,
        cycle,
        carry: st.carry,
        queue: {
          reburnOwed: st.reburnOwed,
          payouts: st.payouts,
          payoutTotal,
          empty: this._queueEmpty(st),
        },
        lastDistribution: st.history[0] ?? null,
        history: st.history,
        actions: st.actions,
      };
    }
    return {
      config: cfg,
      running: !!this._timer,
      nextRunAt: this.nextRunAt,
      last: this.last,
      derived,
      network: networkId,
      address: ws.address,
    };
  }
}

module.exports = {
  DistributionEngine,
  validateDistributionConfig,
  nextCycleClose,
  mergeSeen,
  settleCycle,
  planTick,
};
