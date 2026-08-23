"use strict";

const { parseAmount, addSats, subSats, cmpSats, formatAmount } = require("./format");
const { BURN_MANA_CUSHION } = require("./constants");
const { fetchAiRoster, validateRosterUrl } = require("./ai-roster");

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
// How long after its last block a producer still counts as present. Block
// production is a lottery weighted by stake, so a node at the VHP minimum can
// go hours between blocks while being online the whole time. A generous window
// keeps presence measuring UPTIME rather than stake — the opposite of what a
// short window would do.
const PRESENCE_WINDOW_MS = 3 * 60 * 60 * 1000;
// VHP balances change slowly; re-reading every candidate every tick would be a
// storm of RPC calls. Hourly bounds the cost and still closes the window on
// buying stake right before a payout.
const VHP_RECHECK_MS = 60 * 60 * 1000;

function validateDistributionConfig(cfg) {
  const minVhpKoin = String(cfg.minVhpKoin ?? "").trim();
  if (cmpSats(parseAmount(minVhpKoin), "0") <= 0) {
    throw new Error("Minimum VHP must be greater than zero");
  }
  // A blank roster URL is allowed even with the AI gate on — the engine then
  // fails closed at settlement (pays nobody, carries the pool) and says so,
  // rather than refusing to save an intent the user can't yet fill in. A
  // non-blank URL must be well-formed.
  const aiRosterUrl = String(cfg.aiRosterUrl ?? "").trim();
  if (aiRosterUrl) validateRosterUrl(aiRosterUrl);
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
  const weighting = cfg.weighting === undefined ? "participation" : String(cfg.weighting);
  if (!["participation", "even"].includes(weighting)) {
    throw new Error("Share weighting must be participation or even");
  }
  return {
    enabled: !!cfg.enabled,
    weighting,
    requireVhpMinimum: !!cfg.requireVhpMinimum,
    requireAiNode: !!cfg.requireAiNode,
    minVhpKoin,
    aiRosterUrl,
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
function mergeSeen(seen, headers, nowMs = Date.now()) {
  for (const h of headers || []) {
    if (!h?.signer) continue;
    const cur = seen[h.signer] ?? { blocks: 0, lastSeenHeight: 0, lastSeenMs: 0, lastObservedMs: 0 };
    cur.blocks += 1;
    if (h.height > cur.lastSeenHeight) cur.lastSeenHeight = h.height;
    if (h.timestamp > cur.lastSeenMs) cur.lastSeenMs = h.timestamp;
    // When OUR scan saw them, as distinct from the block's own timestamp.
    // Presence is judged on this: a header carrying a skewed or bogus
    // timestamp must not cost a node the credit for a block we just watched
    // it produce.
    cur.lastObservedMs = nowMs;
    seen[h.signer] = cur;
  }
  return seen;
}

// Fold a roster of live Koinos AI Nodes into the cycle. Mutates + returns.
function mergeAiSeen(aiSeen, addresses, nowMs) {
  for (const address of addresses || []) {
    if (!address) continue;
    const cur = aiSeen[address] ?? { reads: 0, firstSeenMs: nowMs, lastSeenMs: 0 };
    cur.reads += 1;
    cur.lastSeenMs = nowMs;
    aiSeen[address] = cur;
  }
  return aiSeen;
}

// Decide who shares in a cycle's pool. Two independent gates, both optional:
//
//   requireVhpMinimum — the node must be producing blocks AND hold at least
//                       minVhpSat of VHP ("an active node with the stake")
//   requireAiNode     — the node must have been seen running a Koinos AI Node
//                       during the cycle
//
// The four combinations, all of which this one function expresses:
//
//   neither  → every node seen producing blocks qualifies
//   VHP only → nodes producing blocks with enough VHP
//   AI only  → nodes seen on the AI network, whether or not they produce
//   both     → must be on an AI node *and* producing with enough VHP
//
// Block production is required unless the AI gate is carrying the selection on
// its own — that is what makes "AI only" mean "anyone seen running an AI node".
// A candidate whose VHP couldn't be read is never assumed to qualify.
// Pure; `candidates` are { address, producing, aiNode, vhpSat }.
function selectEligible({ candidates, requireVhpMinimum, requireAiNode, minVhpSat }) {
  const needsProducing = requireVhpMinimum || !requireAiNode;
  const eligible = [];
  const rejected = { notProducing: 0, belowVhp: 0, vhpUnknown: 0, notAiNode: 0 };

  for (const c of candidates || []) {
    if (needsProducing && !c.producing) {
      rejected.notProducing += 1;
      continue;
    }
    if (requireVhpMinimum) {
      if (c.vhpSat == null) {
        rejected.vhpUnknown += 1; // balance lookup failed — not judged, not paid
        continue;
      }
      if (cmpSats(c.vhpSat, minVhpSat) < 0) {
        rejected.belowVhp += 1;
        continue;
      }
    }
    if (requireAiNode && !c.aiNode) {
      rejected.notAiNode += 1;
      continue;
    }
    eligible.push(c.address);
  }
  return { eligible, rejected };
}

// How much of the cycle a node was actually around for, in ticks (one tick per
// check interval). This is what stops a node that appears in the last ten
// minutes from collecting a full share of a day's — or a rolled-over week's —
// rewards.
//
// Producers are measured by the SPAN between their first and last block in the
// window, not by how many blocks they signed. Block count is proportional to
// stake, so paying by it would quietly undo "everyone gets an equal share
// regardless of VHP". A span says "they were here from tick 4 to tick 141",
// which a 10k-VHP node and a 1M-VHP node can report identically.
//
// AI nodes are measured by actual roster appearances, because the roster is a
// true liveness list — no inference needed.
//
// With both gates on, a node is credited for the smaller of the two: it only
// earns while it genuinely satisfied both requirements.
function participationWeight({ producerSpanTicks = 0, aiTicks = 0, totalTicks = 0, requireVhpMinimum, requireAiNode }) {
  const span = Math.max(0, Number(producerSpanTicks) || 0);
  const ai = Math.max(0, Number(aiTicks) || 0);
  let w;
  if (requireAiNode && requireVhpMinimum) w = Math.min(span, ai);
  else if (requireAiNode) w = ai;
  else w = span;
  const cap = Math.max(0, Number(totalTicks) || 0);
  if (cap > 0) w = Math.min(w, cap);
  return w;
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
function settleCycle({
  periodRewardsSat,
  periodVhpConsumedSat,
  carrySat,
  eligible,
  selfAddress,
  minPayoutSat,
  weighting = "participation",
}) {
  const rewards = cmpSats(periodRewardsSat, "0") > 0 ? periodRewardsSat : "0";
  const vhpConsumed = cmpSats(periodVhpConsumedSat, "0") > 0 ? periodVhpConsumedSat : "0";
  // Reburn exactly what production consumed, so VHP ends the cycle level.
  const reburnSat = vhpConsumed;
  const profitSat = cmpSats(rewards, vhpConsumed) > 0 ? subSats(rewards, vhpConsumed) : "0";
  const poolSat = addSats(profitSat, carrySat ?? "0");

  // Accept plain addresses (every share equal) or {address, weight} entries.
  // "even" collapses the weights, which is the old flat split.
  const entries = (eligible ?? []).map((e) => {
    const address = typeof e === "string" ? e : e.address;
    let raw;
    try {
      raw = typeof e === "string" ? 1n : BigInt(e.weight ?? 0);
    } catch {
      raw = 0n;
    }
    if (raw < 0n) raw = 0n;
    return { address, weight: weighting === "even" ? 1n : raw };
  });

  const n = entries.length;
  const base = {
    reburnSat,
    profitSat,
    poolSat,
    eligibleCount: n,
    shareSat: "0",
    perWeightSat: "0",
    recipients: [],
    paidAddresses: [],
    selfKeptSat: "0",
    carryOutSat: poolSat,
    weighting,
    totalWeight: "0",
    skippedBelowMin: 0,
  };
  if (n === 0 || cmpSats(poolSat, "0") <= 0) return base;

  const W = entries.reduce((sum, e) => sum + e.weight, 0n);
  if (W <= 0n) return base; // nobody earned any credit in this window

  const pool = BigInt(poolSat);
  const totalWeight = W.toString();
  const recipients = [];
  const paidAddresses = []; // exactly who got their credit settled this cycle
  let selfKeptSat = "0";
  let distributed = 0n;
  let skippedBelowMin = 0;
  let topShare = 0n;

  for (const e of entries) {
    const amount = (pool * e.weight) / W; // floor; remainder carries
    // A share below the minimum is not worth a transaction — each payout spends
    // mana 1:1. It carries into the next cycle instead of being dusted away,
    // and so does the credit that earned it (see the reset in _closeCycle).
    if (amount <= 0n || cmpSats(amount.toString(), minPayoutSat) < 0) {
      skippedBelowMin += 1;
      continue;
    }
    distributed += amount;
    paidAddresses.push(e.address);
    if (amount > topShare) topShare = amount;
    if (e.address === selfAddress) selfKeptSat = amount.toString();
    else recipients.push({ address: e.address, amountSat: amount.toString() });
  }

  return {
    ...base,
    // What one tick of presence was worth, and the largest share paid (they are
    // the same figure when every node was present the whole window).
    perWeightSat: (pool / W).toString(),
    shareSat: topShare.toString(),
    recipients,
    paidAddresses,
    selfKeptSat,
    carryOutSat: (pool - distributed).toString(),
    totalWeight,
    skippedBelowMin,
  };
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

  // The network read of the live Koinos AI Node roster. Isolated on the class
  // so it is the one seam tests replace — everything else about a cycle stays
  // exercised for real.
  async _fetchRoster(url) {
    return fetchAiRoster(url, { isValidAddress: (a) => this.chain.isValidAddress(a) });
  }

  _readState(key) {
    const st = this.state.get(key, null) ?? {
      anchor: null,            // { rewards, vhpConsumed } totals at cycle start
      cycleStartedAt: null,
      lastClosedAt: null,
      lastScannedHeight: null, // network snapshot progress
      seen: {},                // { [producer]: { blocks, lastSeenHeight, lastSeenMs } }
      aiSeen: {},              // { [address]: { reads, firstSeenMs, lastSeenMs } }
      ticks: 0,                // presence samples taken this cycle
      // Earned credit per address: every time this node collects a block
      // reward, each address qualifying AT THAT MOMENT is credited with it.
      // A share is that credit over the total — so an address is paid for the
      // rewards it was actually present for, and nothing else. Credits survive
      // a cycle that pays nobody, so a pool that rolls over still belongs to
      // whoever was around when it was earned.
      credits: {},             // { [address]: creditSats }
      lastRewardTotal: null,   // lifetime rewards at the previous tick
      vhp: {},                 // { [address]: vhpSat } — refreshed hourly
      vhpCheckedAt: 0,
      // Roster reads this cycle. `accepted`/`rejected` count addresses, not
      // reads: a roster that answers happily but only ever returns unusable
      // addresses (a display endpoint that truncates them, say) must be
      // distinguishable from one that genuinely has no workers online.
      aiReads: { ok: 0, failed: 0, accepted: 0, rejected: 0, lastError: null },
      carry: "0",              // undistributed profit carried between cycles
      reburnOwed: "0",         // KOIN still to burn back into VHP
      payouts: [],             // [{ address, amountSat }] waiting to be sent
      history: [],             // closed cycles (newest first)
      actions: [],             // executed reburn/payout txs (newest first)
    };
    st.seen ??= {};
    st.aiSeen ??= {};
    st.ticks ??= 0;
    st.credits ??= {};
    st.vhp ??= {};
    st.vhpCheckedAt ??= 0;
    st.lastRewardTotal ??= null;
    st.aiReads ??= { ok: 0, failed: 0, accepted: 0, rejected: 0, lastError: null };
    st.aiReads.accepted ??= 0;
    st.aiReads.rejected ??= 0;
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
      // Credit accrual measures rewards BETWEEN checks, so it needs a baseline
      // from the moment tracking starts — without it the first interval's
      // rewards would be credited to nobody.
      st.lastRewardTotal = statsRes.totals.rewards;
      st.cycleStartedAt = now;
      this.state.set(key, st);
      return done("anchored", {
        message: `Tracking production from now. The first distribution closes at ${new Date(nextCycleClose(now, cfg.payoutHourUtc)).toUTCString()}.`,
      });
    }

    // Lifetime totals can legitimately go BACKWARDS when the history source
    // changes: our own node's account_history indexes forward from the moment
    // it is first enabled, so it knows less than a public endpoint that has the
    // whole chain. Measuring this cycle against a higher anchor would read as
    // "no rewards yet" for as long as it took to catch up — distribution would
    // quietly stall. Re-anchor to the new baseline instead and keep going; the
    // cost is one cycle's accounting, never a wrong payout.
    if (
      cmpSats(statsRes.totals.rewards, st.anchor.rewards) < 0 ||
      cmpSats(statsRes.totals.vhpConsumed, st.anchor.vhpConsumed) < 0
    ) {
      st.anchor = { rewards: statsRes.totals.rewards, vhpConsumed: statsRes.totals.vhpConsumed };
      st.cycleStartedAt = now;
      this.state.set(key, st);
      return done("re-anchored", {
        message:
          "Reward history now reports lower lifetime totals than when this cycle started — " +
          "usually the chain data source changing (your own node indexes history from when it " +
          "was enabled). Re-anchored to the new baseline; distribution continues from here.",
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
          mergeSeen(st.seen, headers, now);
          st.lastScannedHeight = headHeight;
        }
      }
    } catch (e) {
      snapshotError = String(e.message);
    }

    // Snapshot the live Koinos AI Node roster the same way — who is serving on
    // the AI network right now. Only polled when the AI gate is on; failures
    // are recorded (settlement fails closed on them) but never stall the tick.
    let rosterError = null;
    let aiNowSet = new Set(); // AI addresses live in THIS tick's roster read
    if (cfg.requireAiNode) {
      if (!cfg.aiRosterUrl) {
        rosterError = "No Koinos AI Node roster URL is configured";
        st.aiReads.failed += 1;
        st.aiReads.lastError = rosterError;
      } else {
        try {
          const roster = await this._fetchRoster(cfg.aiRosterUrl);
          aiNowSet = new Set(roster.addresses);
          mergeAiSeen(st.aiSeen, roster.addresses, now);
          st.aiReads.ok += 1;
          st.aiReads.accepted += roster.addresses.length;
          st.aiReads.rejected += roster.rejected ?? 0;
          st.aiReads.lastError =
            roster.addresses.length === 0 && roster.rejected > 0
              ? `Roster answered but all ${roster.rejected} addresses were unusable — is this a display endpoint that shortens addresses?`
              : null;
        } catch (e) {
          rosterError = String(e.message);
          st.aiReads.failed += 1;
          st.aiReads.lastError = rosterError;
        }
      }
    }

    // ---- credit the rewards earned since the last check ----
    //
    // This is the whole fairness model in one step: work out what this node
    // actually earned since the previous tick, then credit that amount to every
    // address qualifying RIGHT NOW. Someone present for two of three reward
    // intervals ends up with two credits against another's one, and is paid
    // exactly that ratio. Turning up at the last minute earns the last minute.
    st.ticks += 1;
    const rewardsNow = statsRes.totals.rewards;
    const rewardDelta =
      st.lastRewardTotal != null && cmpSats(rewardsNow, st.lastRewardTotal) > 0
        ? subSats(rewardsNow, st.lastRewardTotal)
        : "0";
    st.lastRewardTotal = rewardsNow;

    if (cmpSats(rewardDelta, "0") > 0) {
      const present = Object.entries(st.seen)
        .filter(([, rec]) => now - (rec.lastObservedMs || 0) <= PRESENCE_WINDOW_MS)
        .map(([address]) => address);
      const candidateNow = [...new Set([...present, ...(cfg.requireAiNode ? aiNowSet : [])])].filter(
        (a) => this.chain.isValidAddress(a)
      );

      // Refresh VHP at most hourly — slow-moving data, and one read per
      // candidate per tick would be an RPC storm.
      if (cfg.requireVhpMinimum && candidateNow.length > 0 && now - st.vhpCheckedAt > VHP_RECHECK_MS) {
        try {
          const fresh = await this.chain.vhpBalances(candidateNow);
          for (const [a, v] of Object.entries(fresh)) if (v != null) st.vhp[a] = v;
          st.vhpCheckedAt = now;
        } catch {
          /* keep the last known balances; an address we've never read stays unqualified */
        }
      }

      // Judge this instant with the very same gate logic settlement uses.
      const presentSet = new Set(present);
      const { eligible: qualifyingNow } = selectEligible({
        candidates: candidateNow.map((address) => ({
          address,
          producing: presentSet.has(address),
          aiNode: aiNowSet.has(address),
          vhpSat: cfg.requireVhpMinimum ? st.vhp[address] ?? null : null,
        })),
        requireVhpMinimum: cfg.requireVhpMinimum,
        requireAiNode: cfg.requireAiNode,
        minVhpSat: parseAmount(cfg.minVhpKoin),
      });
      for (const a of qualifyingNow) {
        st.credits[a] = addSats(st.credits[a] ?? "0", rewardDelta);
      }
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
      const msg = c.holdReason
        ? `Cycle closed but held: ${c.holdReason}`
        : c.eligibleCount > 0 && cmpSats(c.share, "0") > 0
          ? `Cycle closed: ${formatAmount(c.pool)} KOIN profit split between ${c.eligibleCount} nodes ` +
            `(${formatAmount(c.share)} KOIN each) — reburning ${formatAmount(c.reburn)} KOIN to restore VHP.`
          : `Cycle closed: nothing to distribute yet (${formatAmount(c.pool)} KOIN carries over` +
            `${cmpSats(c.reburn, "0") > 0 ? `; reburning ${formatAmount(c.reburn)} KOIN to restore VHP` : ""}).`;
      this.onEvent({ type: "distribution", message: msg });
      return done(c.holdReason ? "cycle-held" : "cycle-closed", {
        closed, progress, snapshotError, rosterError, message: msg,
      });
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
    const aiNote = cfg.requireAiNode
      ? `, ${Object.keys(st.aiSeen).length} AI nodes seen${rosterError ? ` (roster error: ${rosterError})` : ""}`
      : "";
    return done("watching", {
      snapshotError,
      rosterError,
      message: snapshotError
        ? `Watching the network (snapshot hiccup: ${snapshotError})`
        : `Watching the network — ${Object.keys(st.seen).length} producers seen this cycle${aiNote}. Next distribution at ${new Date(dueAt).toUTCString()}.`,
    });
  }

  // Compute the cycle's figures, find who qualifies, and queue the work.
  async _closeCycle(cfg, st, statsRes, selfAddress, now) {
    const periodRewardsSat = subSats(statsRes.totals.rewards, st.anchor.rewards);
    const periodVhpConsumedSat = subSats(statsRes.totals.vhpConsumed, st.anchor.vhpConsumed);

    // Who earned what. Eligibility was already applied tick by tick as the
    // credits accrued, so settlement is just "pay out in proportion to credit"
    // — no second, later judgement that a node could game by arriving (or
    // buying VHP) just before the cycle closes.
    const producers = Object.keys(st.seen).filter((a) => this.chain.isValidAddress(a));

    // Fail closed: with the AI gate on, a cycle where the roster never answered
    // (or only ever returned unusable addresses — the giveaway for a status
    // page that shortens them for display) cannot know who qualified. Reburn
    // still happens, since the node's VHP must stay level; nobody is paid and
    // the credits stand for the next cycle.
    const rosterNeverAnswered = cfg.requireAiNode && st.aiReads.ok === 0;
    const rosterAllUnusable =
      cfg.requireAiNode && st.aiReads.ok > 0 && st.aiReads.accepted === 0 && st.aiReads.rejected > 0;
    const aiUnavailable = rosterNeverAnswered || rosterAllUnusable;

    const weighted = aiUnavailable
      ? []
      : Object.entries(st.credits)
          .filter(([address, credit]) => this.chain.isValidAddress(address) && cmpSats(credit, "0") > 0)
          .map(([address, credit]) => ({ address, weight: credit }));
    const rejected = { notProducing: 0, belowVhp: 0, vhpUnknown: 0, notAiNode: 0 };

    const settle = settleCycle({
      periodRewardsSat,
      periodVhpConsumedSat,
      carrySat: st.carry,
      eligible: weighted,
      selfAddress,
      minPayoutSat: parseAmount(cfg.minPayoutKoin),
      weighting: cfg.weighting,
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
      perWeight: settle.perWeightSat,
      weighting: settle.weighting,
      totalWeight: settle.totalWeight,
      ticks: st.ticks,
      skippedBelowMin: settle.skippedBelowMin,
      eligibleCount: settle.eligibleCount,
      recipientCount: settle.recipients.length,
      selfKept: settle.selfKeptSat,
      carryOut: settle.carryOutSat,
      seenCount: producers.length,
      aiSeenCount: Object.keys(st.aiSeen).length,
      poolCount: weighted.length,
      rejected,
      gates: {
        requireVhpMinimum: cfg.requireVhpMinimum,
        requireAiNode: cfg.requireAiNode,
        minVhpKoin: cfg.minVhpKoin,
      },
      // Set when the AI roster never answered this cycle — explains a payout of
      // nobody, so an empty distribution is never a silent mystery.
      holdReason: rosterAllUnusable
        ? `The AI node roster answered, but none of the ${st.aiReads.rejected} addresses it returned were valid Koinos addresses — a status/display endpoint that shortens addresses can't be paid to. Nobody was paid and the pool carried over.`
        : rosterNeverAnswered
          ? `Koinos AI Node roster unavailable all cycle (${st.aiReads.lastError ?? "no successful read"}) — nobody was paid and the pool carried over.`
          : null,
    };
    st.history.unshift(record);
    st.history = st.history.slice(0, HISTORY_KEEP);

    // Start the next cycle from the current totals, with a fresh snapshot.
    st.anchor = { rewards: statsRes.totals.rewards, vhpConsumed: statsRes.totals.vhpConsumed };
    st.seen = {};
    st.aiSeen = {};
    st.ticks = 0;
    // Clear ONLY the credit that was actually settled. Wiping every credit
    // whenever anyone got paid quietly starved small and newly-joined nodes:
    // their share lands below the minimum payout, so they are skipped — and
    // then their credit is deleted anyway because somebody else was paid. They
    // restart from zero every cycle, never accumulate enough to cross the
    // minimum, and the share they earned is absorbed by the larger nodes.
    // Keeping a skipped node's credit lets it build across cycles until it does
    // cross, which is the whole point of carrying the money forward with it.
    for (const address of settle.paidAddresses ?? []) delete st.credits[address];
    st.aiReads = { ok: 0, failed: 0, accepted: 0, rejected: 0, lastError: null };
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
          ticks: st.ticks,
          aiSeenCount: Object.keys(st.aiSeen).length,
          aiReads: st.aiReads,
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
  mergeAiSeen,
  selectEligible,
  participationWeight,
  settleCycle,
  planTick,
};
