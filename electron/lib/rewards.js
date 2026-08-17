"use strict";

const { parseAmount, percentOf, addSats, subSats, cmpSats, formatAmount } = require("./format");
const { BURN_MANA_CUSHION } = require("./constants");

// "0" for an empty/zero/invalid cap (meaning "no cap"), otherwise the human
// amount string as entered (this is what gets stored in the config).
function normalizeMaxReturn(v) {
  const s = String(v ?? "").trim();
  if (!s || s === "0") return "0";
  parseAmount(s); // throws when invalid
  return s;
}

// The per-run cap in satoshis for computeReturn ("0" = no cap).
function maxReturnSats(v) {
  const s = normalizeMaxReturn(v);
  return s === "0" ? "0" : parseAmount(s);
}

// Given the real block rewards earned since auto-returns were enabled, decide
// how much to return now. Pure and unit-tested. Everything is in satoshis.
//
//   returnable  = rewards actually minted to the wallet from producing blocks,
//                 since the engine was enabled (NOT balance deltas — so
//                 deposits and manual burns never count as "rewards").
//   desired     = returnable * pct
//   pending     = desired - already returned
//
// The amount actually moved is `pending` clamped by every active constraint:
//   • maxReturnSat     — optional per-run cap; large pending is chunked
//   • availableLiquidSat — liquid KOIN above the keep-buffer
//   • availableManaSat — mana available now (burn AND transfer each require
//                        mana >= amount on-chain; mana recharges over ~5 days).
//                        Pass null to skip (no mana constraint).
// `limitedBy` names the tightest constraint so the UI can explain a hold, and
// when the clamp drops below the minimum we report which resource is short.
function computeReturn({
  rewardsSinceEnable,
  returnedSoFar,
  pct,
  minReturnSat,
  availableLiquidSat,
  availableManaSat = null,
  maxReturnSat = "0",
}) {
  const returnable = cmpSats(rewardsSinceEnable, "0") > 0 ? rewardsSinceEnable : "0";
  const desired = percentOf(returnable, pct);
  let pending = subSats(desired, returnedSoFar);
  if (cmpSats(pending, "0") < 0) pending = "0";

  if (cmpSats(pending, "0") === 0 || cmpSats(pending, minReturnSat) < 0) {
    return { action: "accumulate", returnAmount: "0", desired, pending, limitedBy: null };
  }

  let amount = pending;
  let limitedBy = null;
  const clamp = (limitSat, tag) => {
    if (limitSat == null) return;
    if (cmpSats(amount, limitSat) > 0) {
      amount = cmpSats(limitSat, "0") > 0 ? limitSat : "0";
      limitedBy = tag;
    }
  };
  if (maxReturnSat && cmpSats(maxReturnSat, "0") > 0) clamp(maxReturnSat, "max-per-return");
  clamp(availableLiquidSat, "liquid");
  clamp(availableManaSat, "mana");

  if (cmpSats(amount, minReturnSat) < 0) {
    // Can't reach the minimum this run — surface the binding resource so the UI
    // can say "waiting for mana to recharge" vs "not enough liquid KOIN".
    const action = limitedBy === "mana" ? "insufficient-mana" : "insufficient-liquid";
    return { action, returnAmount: "0", desired, pending, limitedBy, capped: amount };
  }
  return { action: "return", returnAmount: amount, desired, pending, limitedBy };
}

function validateRewardsConfig(cfg) {
  const pct = Number(cfg.pct);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new Error("Return percentage must be between 0 and 100");
  }
  if (!["burn", "send"].includes(cfg.mode)) {
    throw new Error("Return mode must be burn or send");
  }
  const poll = Number(cfg.pollMinutes);
  if (!Number.isFinite(poll) || poll < 1 || poll > 24 * 60) {
    throw new Error("Check interval must be between 1 minute and 24 hours");
  }
  parseAmount(cfg.minReturnKoin); // throws when invalid
  const maxReturnKoin = normalizeMaxReturn(cfg.maxReturnKoin);
  if (maxReturnKoin !== "0" && cmpSats(parseAmount(maxReturnKoin), parseAmount(cfg.minReturnKoin)) < 0) {
    throw new Error("Max per return must be at least the minimum return");
  }
  return {
    enabled: !!cfg.enabled,
    pct,
    mode: cfg.mode,
    toAddress: String(cfg.toAddress ?? "").trim(),
    minReturnKoin: String(cfg.minReturnKoin),
    maxReturnKoin,
    pollMinutes: poll,
  };
}

// Periodically compounds/sends the configured percentage of the block rewards
// the node actually earns. Rewards are read from on-chain block-reward events
// (via ProducerStats) — the same source the Dashboard uses — so the two always
// agree, and deposits or manual burns are never mistaken for rewards.
class RewardEngine {
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
    return this.settings.get("rewards");
  }

  configure(patch) {
    const cfg = validateRewardsConfig({ ...this.config(), ...patch });
    if (cfg.enabled && cfg.mode === "send" && !this.chain.isValidAddress(cfg.toAddress)) {
      throw new Error("Enter a valid Koinos address to send returns to");
    }
    this.settings.set("rewards", cfg);
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
    return `returns.${networkId}.${address}`;
  }

  _readState(key) {
    return (
      this.state.get(key, null) ?? {
        anchor: null,          // lifetime rewards (sat) when auto-returns began
        returned: "0",         // KOIN returned since then
        lifetimeRewards: "0",  // last-seen lifetime rewards, for display
        actions: [],
      }
    );
  }

  async tick(trigger = "timer") {
    if (this._busy) return this.status();
    this._busy = true;
    try {
      return await this._tick(trigger);
    } finally {
      this._busy = false;
    }
  }

  async _tick(trigger) {
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

    // Real block rewards come from ProducerStats (on-chain reward events).
    let statsRes;
    try {
      statsRes = await this.stats.refresh(address);
    } catch (e) {
      return done("rpc-error", { message: String(e.message) });
    }
    if (!statsRes || statsRes.available === false) {
      return done("history-unavailable", {
        message: "Block-reward history isn't available on this network's RPC, so returns can't run here.",
      });
    }
    if (statsRes.syncing) {
      return done("syncing", { message: "Reading reward history… returns resume once it's caught up." });
    }

    const st = this._readState(key);
    st.lifetimeRewards = statsRes.totals.rewards;

    // Anchor on first run: only rewards earned from here forward are returned.
    if (st.anchor === null) {
      st.anchor = statsRes.totals.rewards;
      this.state.set(key, st);
      return done("anchored", {
        message: `Tracking rewards from now (lifetime so far: ${formatAmount(st.anchor)} KOIN). New block rewards will be returned.`,
      });
    }

    const rewardsSinceEnable = cmpSats(st.lifetimeRewards, st.anchor) > 0
      ? subSats(st.lifetimeRewards, st.anchor)
      : "0";

    let balances;
    try {
      balances = await this.chain.balances(address);
    } catch (e) {
      this.state.set(key, st);
      return done("rpc-error", { message: String(e.message) });
    }
    const keep = parseAmount(this.settings.get("keepLiquidKoin", "10"));
    const availableLiquid = cmpSats(balances.koin, keep) > 0 ? subSats(balances.koin, keep) : "0";

    // Both compounding (burn) and sending move KOIN, and on-chain each requires
    // mana >= amount (mana recharges over ~5 days). Cap by the mana available
    // now, minus a cushion for the transaction's own resource cost — otherwise
    // a large pending return reverts with the opaque "could not burn KOIN".
    const manaFree = subSats(balances.mana ?? "0", BURN_MANA_CUSHION);
    const availableMana = cmpSats(manaFree, "0") > 0 ? manaFree : "0";

    const plan = computeReturn({
      rewardsSinceEnable,
      returnedSoFar: st.returned,
      pct: cfg.pct,
      minReturnSat: parseAmount(cfg.minReturnKoin),
      availableLiquidSat: availableLiquid,
      availableManaSat: availableMana,
      maxReturnSat: maxReturnSats(cfg.maxReturnKoin),
    });
    this.state.set(key, st); // persist refreshed lifetimeRewards

    if (plan.action === "accumulate") {
      return done("accumulating", {
        plan,
        message: cmpSats(plan.pending, "0") > 0
          ? `Pending return ${formatAmount(plan.pending)} KOIN — waiting until it reaches ${cfg.minReturnKoin} KOIN.`
          : "No new rewards to return yet.",
      });
    }
    if (plan.action === "insufficient-mana") {
      return done("insufficient-mana", {
        plan,
        message:
          `Return of ${formatAmount(plan.pending)} KOIN is pending, but only ${formatAmount(plan.capped)} KOIN ` +
          `can be moved right now — burning and sending each spend mana, which recharges over ~5 days. ` +
          `It will catch up automatically as mana refills.`,
      });
    }
    if (plan.action === "insufficient-liquid") {
      return done("insufficient-liquid", {
        plan,
        message: `Return of ${formatAmount(plan.pending)} KOIN is pending, but not enough liquid KOIN is free above your ${formatAmount(keep)} mana buffer.`,
      });
    }

    // plan.action === "return" — needs a signer.
    if (!ws.unlocked) {
      return done("locked", { plan, message: "Unlock the wallet so the pending return can be signed." });
    }
    if (cfg.mode === "send" && !this.chain.isValidAddress(cfg.toAddress)) {
      return done("config-error", { message: "Return mode is `send` but the target address is invalid." });
    }

    let tx;
    try {
      tx =
        cfg.mode === "burn"
          ? await this.chain.burn(this.wallet.signer, plan.returnAmount)
          : await this.chain.transfer(this.wallet.signer, {
              to: cfg.toAddress,
              amountSat: plan.returnAmount,
              token: "koin",
            });
    } catch (e) {
      return done("tx-error", { plan, message: String(e.message) });
    }

    st.returned = addSats(st.returned, plan.returnAmount);
    st.actions.unshift({
      time: Date.now(),
      network: networkId,
      mode: cfg.mode,
      amount: plan.returnAmount,
      txId: tx.txId,
      confirmed: tx.confirmed,
    });
    st.actions = st.actions.slice(0, 50);
    this.state.set(key, st);

    const base =
      cfg.mode === "burn"
        ? `Compounded ${formatAmount(plan.returnAmount)} KOIN → VHP (${cfg.pct}% of block rewards)`
        : `Sent ${formatAmount(plan.returnAmount)} KOIN to ${cfg.toAddress} (${cfg.pct}% of block rewards)`;
    // When a per-run cap (mana or max-per-return) chunked the return, tell the
    // user the rest is still queued so partial progress doesn't look stuck.
    const remaining = subSats(plan.pending, plan.returnAmount);
    const more =
      plan.limitedBy && cmpSats(remaining, parseAmount(cfg.minReturnKoin)) >= 0
        ? ` — ${formatAmount(remaining)} KOIN still pending, continuing on the next check.`
        : "";
    const msg = base + more;
    this.onEvent({ type: "rewards", message: msg, txId: tx.txId });
    return done("returned", { plan, tx, message: msg });
  }

  status() {
    const cfg = this.config();
    const ws = this.wallet.status();
    const networkId = this.chain.network().id;
    const st = ws.address ? this._readState(this._stateKey(networkId, ws.address)) : null;

    let derived = null;
    if (st) {
      const rewardsSinceEnable =
        st.anchor == null
          ? "0"
          : cmpSats(st.lifetimeRewards, st.anchor) > 0
            ? subSats(st.lifetimeRewards, st.anchor)
            : "0";
      const desired = percentOf(rewardsSinceEnable, cfg.pct);
      let pending = subSats(desired, st.returned);
      if (cmpSats(pending, "0") < 0) pending = "0";
      derived = {
        anchored: st.anchor != null,
        lifetimeRewards: st.lifetimeRewards,
        rewardsSinceEnable,
        returned: st.returned,
        pending,
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

module.exports = { RewardEngine, computeReturn, validateRewardsConfig };
