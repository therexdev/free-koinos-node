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
//   2. The profit is then carved up BY PERCENTAGE:
//        reburnPct        compounded back into VHP, on top of (1)
//        sharePct.ai        to every node running a Koinos AI Node
//        sharePct.producing to every node producing with the minimum VHP
//        sharePct.both      to nodes doing both, ON TOP of the two above
//      Membership overlaps: qualify for both requirements and you are paid from
//      all three pools. Each slice is split between the members of its pool
//      (plus that pool's carry from earlier cycles), and whatever the
//      percentages leave over simply stays in the wallet. This node counts as a
//      member like any other and keeps its own share.
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

// The three pools profit can be paid into. Membership OVERLAPS: a node running
// a Koinos AI Node is in `ai`, a node producing with the minimum VHP is in
// `producing`, and a node doing both is in all three — the `both` pool is a
// bonus on top of the two it already earns from, not an alternative to them.
const TIERS = ["both", "producing", "ai"];
const TIER_LABELS = {
  both: "AI node and producing",
  producing: "producing with the VHP minimum",
  ai: "Koinos AI Node",
};

function pctOf(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(100, n);
}

// Bring an older config forward.
//
//   ≤0.6  two on/off gates decided who shared a single pool
//   0.7   three exclusive groups, keyed aiOnly / vhpOnly / both
//
// Both become the current overlapping pools, keyed ai / producing / both, with
// the same percentages paying at least the same people. The old keys are then
// dropped — validate() returns the new shape, so the first save cleans them out
// of settings.json for good.
function migrateDistributionConfig(raw) {
  const cfg = { ...(raw || {}) };
  const share = cfg.sharePct && typeof cfg.sharePct === "object" ? { ...cfg.sharePct } : null;
  if (share && (share.aiOnly !== undefined || share.vhpOnly !== undefined)) {
    // 0.7's "only" groups are simply these pools before membership overlapped:
    // a node doing both now also earns from them rather than instead of them.
    share.ai ??= share.aiOnly;
    share.producing ??= share.vhpOnly;
  }
  if (share) {
    cfg.sharePct = { ai: pctOf(share.ai), producing: pctOf(share.producing), both: pctOf(share.both) };
  } else {
    const vhp = cfg.requireVhpMinimum === undefined ? true : !!cfg.requireVhpMinimum;
    const ai = !!cfg.requireAiNode;
    cfg.sharePct = vhp && ai
      ? { ai: 0, producing: 0, both: 100 }
      : ai
        ? { ai: 100, producing: 0, both: 0 }
        : { ai: 0, producing: 100, both: 0 };
    // "Neither gate on" meant every producer, whatever its VHP. The producing
    // pool expresses that as a zero minimum.
    if (!vhp && !ai) cfg.minVhpKoin = "0";
    cfg.reburnPct = pctOf(cfg.reburnPct ?? 0);
  }
  delete cfg.requireVhpMinimum;
  delete cfg.requireAiNode;
  return cfg;
}

// Which requirements actually have to be measured, given what is funded. A
// requirement no pool depends on is not measured at all — with no AI pool
// funded the roster is never fetched, and with no producing pool funded VHP is
// never read.
function activeDimensions(sharePct = {}) {
  return {
    produceActive: pctOf(sharePct.producing) > 0 || pctOf(sharePct.both) > 0,
    aiActive: pctOf(sharePct.ai) > 0 || pctOf(sharePct.both) > 0,
  };
}

function validateDistributionConfig(cfg) {
  const c = migrateDistributionConfig(cfg);
  const minVhpKoin = String(c.minVhpKoin ?? "").trim();
  // "0" is allowed and means "any producer counts, whatever its stake".
  if (cmpSats(parseAmount(minVhpKoin), "0") < 0) {
    throw new Error("Minimum VHP can't be negative");
  }
  // A blank roster URL is allowed even with an AI slice funded — the engine
  // then fails closed at settlement (pays nobody from the AI pools, carries
  // their slice) and says so, rather than refusing to save an intent the user
  // can't yet fill in. A non-blank URL must be well-formed.
  const aiRosterUrl = String(c.aiRosterUrl ?? "").trim();
  if (aiRosterUrl) validateRosterUrl(aiRosterUrl);
  const hour = Number(c.payoutHourUtc);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new Error("Distribution hour must be a whole number between 0 and 23 (UTC)");
  }
  const minPayoutKoin = String(c.minPayoutKoin ?? "").trim();
  parseAmount(minPayoutKoin); // throws when invalid; "0" is allowed
  const poll = Number(c.pollMinutes);
  if (!Number.isFinite(poll) || poll < 1 || poll > 24 * 60) {
    throw new Error("Check interval must be between 1 minute and 24 hours");
  }
  const weighting = c.weighting === undefined ? "participation" : String(c.weighting);
  if (!["participation", "even"].includes(weighting)) {
    throw new Error("Share weighting must be participation or even");
  }
  const reburnPct = pctOf(c.reburnPct);
  const sharePct = {
    ai: pctOf(c.sharePct?.ai),
    producing: pctOf(c.sharePct?.producing),
    both: pctOf(c.sharePct?.both),
  };
  const allocated = reburnPct + sharePct.ai + sharePct.producing + sharePct.both;
  if (allocated > 100) {
    throw new Error(
      `Reburn plus the three share percentages come to ${allocated}% — they can't add up to more than 100% of the profit`
    );
  }
  return {
    enabled: !!c.enabled,
    weighting,
    reburnPct,
    sharePct,
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

// Which pools an address belongs to at a given moment — none, one, or all
// three. This is the whole eligibility model in one pure function:
//
//   ai         on the AI roster
//   producing  producing blocks with the minimum VHP
//   both       doing both — earned IN ADDITION to the two above
//
// Membership overlaps deliberately: someone meeting both requirements should
// not be paid instead of the two pools they qualify for, but as well as them.
//
// A requirement nobody is paid for is not measured at all — with no AI pool
// funded the roster is never consulted, which keeps "pay every producer"
// expressible without a roster and saves the network call. Because membership
// overlaps, that can never cost anyone a pool they qualify for.
//
// A VHP balance that couldn't be read never counts as meeting the minimum.
// `candidate` is { producing, aiNode, vhpSat }.
function tiersFor(candidate, { minVhpSat = "0", produceActive = true, aiActive = false } = {}) {
  const needsStake = cmpSats(minVhpSat, "0") > 0;
  const meetsStake = !needsStake || (candidate.vhpSat != null && cmpSats(candidate.vhpSat, minVhpSat) >= 0);
  const produces = produceActive && !!candidate.producing && meetsStake;
  const ai = aiActive && !!candidate.aiNode;
  const tiers = [];
  if (produces && ai) tiers.push("both");
  if (produces) tiers.push("producing");
  if (ai) tiers.push("ai");
  return tiers;
}

// Sort candidates into their pools. Returns { tiers: {tier: [address]},
// rejected } — an address can appear in more than one, and rejection reasons
// are tallied for the UI.
function classifyCandidates(candidates, opts = {}) {
  const tiers = { both: [], producing: [], ai: [] };
  const rejected = { notProducing: 0, belowVhp: 0, vhpUnknown: 0, notAiNode: 0 };
  const needsStake = cmpSats(opts.minVhpSat ?? "0", "0") > 0;
  for (const c of candidates || []) {
    const belongs = tiersFor(c, opts);
    if (belongs.length > 0) {
      for (const tier of belongs) tiers[tier].push(c.address);
      continue;
    }
    if (opts.produceActive && !c.producing) rejected.notProducing += 1;
    else if (opts.produceActive && needsStake && c.vhpSat == null) rejected.vhpUnknown += 1;
    else if (opts.produceActive && needsStake) rejected.belowVhp += 1;
    else rejected.notAiNode += 1;
  }
  return { tiers, rejected };
}

// Split one pool between the addresses holding credit in it.
// Pure; BigInt in, satoshi strings out.
function splitPool(poolSat, ledger, { weighting, minPayoutSat, selfAddress }) {
  const entries = Object.entries(ledger || {}).map(([address, credit]) => {
    let weight;
    try {
      weight = weighting === "even" ? 1n : BigInt(credit ?? 0);
    } catch {
      weight = 0n;
    }
    return { address, weight: weight > 0n ? weight : 0n };
  }).filter((e) => e.weight > 0n);

  const pool = BigInt(poolSat);
  const W = entries.reduce((sum, e) => sum + e.weight, 0n);
  const empty = {
    recipients: [], paidAddresses: [], selfKeptSat: "0", distributedSat: "0",
    shareSat: "0", perWeightSat: "0", totalWeight: W.toString(),
    count: entries.length, skippedBelowMin: 0,
  };
  if (pool <= 0n || W <= 0n) return empty;

  const recipients = [];
  const paidAddresses = [];
  let selfKept = 0n;
  let distributed = 0n;
  let skippedBelowMin = 0;
  let topShare = 0n;
  for (const e of entries) {
    const amount = (pool * e.weight) / W; // floor; the remainder carries
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
    if (e.address === selfAddress) selfKept += amount;
    else recipients.push({ address: e.address, amountSat: amount.toString() });
  }
  return {
    ...empty,
    recipients,
    paidAddresses,
    selfKeptSat: selfKept.toString(),
    distributedSat: distributed.toString(),
    shareSat: topShare.toString(),
    perWeightSat: (pool / W).toString(),
    skippedBelowMin,
  };
}

// Close one cycle: what to reburn, what each pool is paid, what carries and
// what the wallet simply keeps. Pure — everything in satoshi strings.
//
//   periodRewardsSat / periodVhpConsumedSat — this node's production this cycle
//   carry     — { tier: satoshis } undistributed from earlier cycles
//   credits   — { tier: { address: satoshis } } earned this cycle and before
//   reburnPct — % of this cycle's profit to compound back into VHP. Applying it
//               once at settlement is identical to taking it from every reward
//               as it lands, since it is a flat fraction either way.
//   sharePct  — { ai, producing, both } % of this cycle's profit per pool
//   heldTiers — pools whose requirement couldn't be verified this cycle: they
//               are still allocated, but the money carries rather than paying
//               anyone, so an outage never turns other people's share into
//               profit for this node.
//
// A pool nobody was in earns nothing: its slice is not allocated at all and
// stays in the wallet along with whatever the percentages left unallocated.
function settleCycle({
  periodRewardsSat,
  periodVhpConsumedSat,
  carry,
  credits,
  selfAddress,
  minPayoutSat,
  weighting = "participation",
  reburnPct = 0,
  sharePct = {},
  heldTiers = [],
}) {
  const rewards = cmpSats(periodRewardsSat, "0") > 0 ? periodRewardsSat : "0";
  const vhpConsumed = cmpSats(periodVhpConsumedSat, "0") > 0 ? periodVhpConsumedSat : "0";
  // Reburn exactly what production consumed, so VHP ends the cycle level.
  const levelReburn = BigInt(vhpConsumed);
  const profitSat = cmpSats(rewards, vhpConsumed) > 0 ? subSats(rewards, vhpConsumed) : "0";
  const profit = BigInt(profitSat);
  const held = new Set(heldTiers);

  const extraReburn = (profit * BigInt(pctOf(reburnPct))) / 100n;
  let kept = profit - extraReburn; // shrinks as each pool's slice is allocated
  const tiers = {};
  const byAddress = new Map(); // one transfer per address, however many pools
  const paidAddresses = {};
  let selfKept = 0n;
  let poolTotal = 0n;
  let topShare = 0n;
  let eligibleCount = 0;
  let skippedBelowMin = 0;
  const carryOut = {};

  for (const tier of TIERS) {
    const ledger = credits?.[tier] ?? {};
    const carryIn = BigInt(carry?.[tier] ?? "0");
    const hasCredit = Object.values(ledger).some((c) => {
      try { return BigInt(c ?? 0) > 0n; } catch { return false; }
    });
    const isHeld = held.has(tier);
    const alloc = hasCredit || isHeld ? (profit * BigInt(pctOf(sharePct[tier]))) / 100n : 0n;
    kept -= alloc;
    const pool = alloc + carryIn;
    poolTotal += pool;

    const split = isHeld
      ? splitPool("0", {}, { weighting, minPayoutSat, selfAddress })
      : splitPool(pool.toString(), ledger, { weighting, minPayoutSat, selfAddress });

    for (const r of split.recipients) {
      byAddress.set(r.address, (byAddress.get(r.address) ?? 0n) + BigInt(r.amountSat));
    }
    paidAddresses[tier] = split.paidAddresses;
    selfKept += BigInt(split.selfKeptSat);
    if (BigInt(split.shareSat) > topShare) topShare = BigInt(split.shareSat);
    eligibleCount += split.count;
    skippedBelowMin += split.skippedBelowMin;
    const out = pool - BigInt(split.distributedSat);
    carryOut[tier] = out.toString();
    tiers[tier] = {
      pct: pctOf(sharePct[tier]),
      allocSat: alloc.toString(),
      carryInSat: carryIn.toString(),
      poolSat: pool.toString(),
      count: split.count,
      recipientCount: split.recipients.length,
      paidSat: split.distributedSat,
      selfKeptSat: split.selfKeptSat,
      shareSat: split.shareSat,
      perWeightSat: split.perWeightSat,
      totalWeight: split.totalWeight,
      skippedBelowMin: split.skippedBelowMin,
      carryOutSat: out.toString(),
      held: isHeld,
    };
  }

  const recipients = [...byAddress.entries()].map(([address, amount]) => ({
    address,
    amountSat: amount.toString(),
  }));

  return {
    levelReburnSat: levelReburn.toString(),
    extraReburnSat: extraReburn.toString(),
    reburnSat: (levelReburn + extraReburn).toString(),
    profitSat,
    poolSat: poolTotal.toString(),
    keptSat: (kept > 0n ? kept : 0n).toString(),
    tiers,
    recipients,
    paidAddresses,
    selfKeptSat: selfKept.toString(),
    shareSat: topShare.toString(),
    carryOut,
    carryOutSat: Object.values(carryOut).reduce((a, v) => addSats(a, v), "0"),
    eligibleCount,
    skippedBelowMin,
    weighting,
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

// Which pool a single-pool config maps onto — where pre-0.7 state, which knew
// only one pool and one credit ledger, belongs now.
function primaryTier(cfg) {
  const pct = cfg?.sharePct ?? {};
  let best = "producing";
  for (const tier of TIERS) if (pctOf(pct[tier]) > pctOf(pct[best])) best = tier;
  return best;
}

// Move older state onto the per-pool shape. The old flat carry and credit
// ledger belong to whichever pool the migrated config maps the old rules onto,
// so an upgrade never orphans money or the credit that earned it.
function migrateState(st, cfg) {
  const zero = () => ({ both: "0", producing: "0", ai: "0" });
  const home = primaryTier(cfg);
  // 0.7 keyed the same pools aiOnly/vhpOnly; carry them over by name.
  const rename = (o) => ({ ...o, ai: o.ai ?? o.aiOnly, producing: o.producing ?? o.vhpOnly });
  if (typeof st.carry === "string") {
    st.carry = { ...zero(), [home]: st.carry };
  } else {
    const c = rename(st.carry ?? {});
    st.carry = { both: c.both ?? "0", producing: c.producing ?? "0", ai: c.ai ?? "0" };
  }
  // A pre-0.7 ledger is flat — { address: satoshis }, so every value is a
  // string. A per-pool one holds an object under each pool key.
  const credits = st.credits && typeof st.credits === "object" ? st.credits : {};
  const POOL_KEYS = ["both", "producing", "ai", "vhpOnly", "aiOnly"];
  const tiered = Object.entries(credits).every(
    ([k, v]) => POOL_KEYS.includes(k) && v && typeof v === "object"
  );
  if (tiered) {
    const r = rename(credits);
    st.credits = { both: r.both ?? {}, producing: r.producing ?? {}, ai: r.ai ?? {} };
  } else {
    st.credits = { both: {}, producing: {}, ai: {} };
    st.credits[home] = { ...credits };
  }
  return st;
}

// What a given profit would be carved into right now. Mirrors settleCycle's
// arithmetic so the Status panel and the cycle it eventually closes agree.
function previewSplit(profitSat, cfg) {
  const profit = BigInt(cmpSats(profitSat, "0") > 0 ? profitSat : "0");
  const slice = (pct) => ((profit * BigInt(pctOf(pct))) / 100n).toString();
  const out = {
    reburnPct: pctOf(cfg.reburnPct),
    reburn: slice(cfg.reburnPct),
    tiers: {},
    keptPct: 100 - pctOf(cfg.reburnPct),
  };
  for (const tier of TIERS) {
    const pct = pctOf(cfg.sharePct?.[tier]);
    out.tiers[tier] = { pct, amount: slice(pct) };
    out.keptPct -= pct;
  }
  out.kept = ((profit * BigInt(Math.max(0, out.keptPct))) / 100n).toString();
  return out;
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
    return migrateDistributionConfig(this.settings.get("distribution"));
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

  _readState(key, cfg = this.config()) {
    const st = this.state.get(key, null) ?? {
      anchor: null,            // { rewards, vhpConsumed } totals at cycle start
      cycleStartedAt: null,
      lastClosedAt: null,
      lastScannedHeight: null, // network snapshot progress
      seen: {},                // { [producer]: { blocks, lastSeenHeight, lastSeenMs } }
      aiSeen: {},              // { [address]: { reads, firstSeenMs, lastSeenMs } }
      ticks: 0,                // presence samples taken this cycle
      // Earned credit per address, per pool: every time this node collects a
      // block reward, each address is credited with it in every pool it was in
      // AT THAT MOMENT. A share is that credit over its pool's total —
      // so an address is paid for the rewards it was actually present for, in
      // the capacity it was present in, and nothing else. Credits survive a
      // cycle that pays nobody, so a pool that rolls over still belongs to
      // whoever was around when it was earned.
      credits: { both: {}, producing: {}, ai: {} },
      lastRewardTotal: null,   // lifetime rewards at the previous tick
      vhp: {},                 // { [address]: vhpSat } — refreshed hourly
      vhpCheckedAt: 0,
      // Roster reads this cycle. `accepted`/`rejected` count addresses, not
      // reads: a roster that answers happily but only ever returns unusable
      // addresses (a display endpoint that truncates them, say) must be
      // distinguishable from one that genuinely has no workers online.
      aiReads: { ok: 0, failed: 0, accepted: 0, rejected: 0, lastError: null },
      carry: { both: "0", producing: "0", ai: "0" }, // undistributed, per pool
      reburnOwed: "0",         // KOIN still to burn back into VHP
      payouts: [],             // [{ address, amountSat }] waiting to be sent
      history: [],             // closed cycles (newest first)
      actions: [],             // executed reburn/payout txs (newest first)
    };
    st.seen ??= {};
    st.aiSeen ??= {};
    st.ticks ??= 0;
    st.vhp ??= {};
    st.vhpCheckedAt ??= 0;
    st.lastRewardTotal ??= null;
    st.aiReads ??= { ok: 0, failed: 0, accepted: 0, rejected: 0, lastError: null };
    st.aiReads.accepted ??= 0;
    st.aiReads.rejected ??= 0;
    st.payouts ??= [];
    st.history ??= [];
    st.actions ??= [];
    migrateState(st, cfg);
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
    // the AI network right now. Only polled when a pool that depends on it is
    // funded; failures are recorded (settlement fails closed on them) but never
    // stall the tick.
    const { aiActive, produceActive } = activeDimensions(cfg.sharePct);
    let rosterError = null;
    let aiNowSet = new Set(); // AI addresses live in THIS tick's roster read
    if (aiActive) {
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

    // A roster read that failed means nobody's AI status is known right now, so
    // the AI pools accrue nothing this interval — but the producing pool is
    // unaffected, since production is knowable without the roster. (That the
    // outage costs producers nothing is a property of overlapping membership:
    // their pool never depended on who else is on the AI network.)
    const aiKnown = aiActive && !rosterError;
    const minVhpSat = parseAmount(cfg.minVhpKoin);

    if (cmpSats(rewardDelta, "0") > 0) {
      const present = Object.entries(st.seen)
        .filter(([, rec]) => now - (rec.lastObservedMs || 0) <= PRESENCE_WINDOW_MS)
        .map(([address]) => address);
      const candidateNow = [...new Set([...present, ...aiNowSet])].filter((a) =>
        this.chain.isValidAddress(a)
      );

      // Refresh VHP at most hourly — slow-moving data, and one read per
      // candidate per tick would be an RPC storm.
      const needsStake = produceActive && cmpSats(minVhpSat, "0") > 0;
      if (needsStake && candidateNow.length > 0 && now - st.vhpCheckedAt > VHP_RECHECK_MS) {
        try {
          const fresh = await this.chain.vhpBalances(candidateNow);
          for (const [a, v] of Object.entries(fresh)) if (v != null) st.vhp[a] = v;
          st.vhpCheckedAt = now;
        } catch {
          /* keep the last known balances; an address we've never read stays unqualified */
        }
      }

      // Sort this instant into pools with the very same logic settlement uses.
      const presentSet = new Set(present);
      const { tiers: tieredNow } = classifyCandidates(
        candidateNow.map((address) => ({
          address,
          producing: presentSet.has(address),
          aiNode: aiNowSet.has(address),
          vhpSat: needsStake ? st.vhp[address] ?? null : null,
        })),
        { minVhpSat, produceActive, aiActive: aiKnown }
      );
      for (const tier of TIERS) {
        // No credit in a pool nobody is paid from: it could never be settled,
        // and holding it would pay retroactively for a period the operator
        // hadn't funded if the percentage were later turned up.
        if (pctOf(cfg.sharePct[tier]) <= 0) continue;
        for (const a of tieredNow[tier]) {
          st.credits[tier][a] = addSats(st.credits[tier][a] ?? "0", rewardDelta);
        }
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
      const reburnNote =
        cmpSats(c.extraReburn ?? "0", "0") > 0
          ? `reburning ${formatAmount(c.reburn)} KOIN (${formatAmount(c.levelReburn)} to restore VHP, ` +
            `${formatAmount(c.extraReburn)} compounded)`
          : `reburning ${formatAmount(c.reburn)} KOIN to restore VHP`;
      const msg = c.holdReason
        ? `Cycle closed but held: ${c.holdReason}`
        : c.recipientCount > 0 || cmpSats(c.selfKept, "0") > 0
          ? `Cycle closed: ${formatAmount(c.pool)} KOIN split between ${c.eligibleCount} nodes ` +
            `(top share ${formatAmount(c.share)} KOIN) — ${reburnNote}.`
          : `Cycle closed: nothing to distribute yet (${formatAmount(c.pool)} KOIN carries over` +
            `${cmpSats(c.reburn, "0") > 0 ? `; ${reburnNote}` : ""}).`;
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
    const aiNote = aiActive
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

  // Compute the cycle's figures, work out what each pool is owed, and queue
  // the work.
  async _closeCycle(cfg, st, statsRes, selfAddress, now) {
    const periodRewardsSat = subSats(statsRes.totals.rewards, st.anchor.rewards);
    const periodVhpConsumedSat = subSats(statsRes.totals.vhpConsumed, st.anchor.vhpConsumed);

    // Who earned what. Pool membership was already applied tick by tick as the
    // credits accrued, so settlement is just "pay out in proportion to credit"
    // — no second, later judgement that a node could game by arriving (or
    // buying VHP) just before the cycle closes.
    const producers = Object.keys(st.seen).filter((a) => this.chain.isValidAddress(a));
    const { aiActive } = activeDimensions(cfg.sharePct);

    // Fail closed: with an AI-dependent pool funded, a cycle where the roster
    // never answered (or only ever returned unusable addresses — the giveaway
    // for a status page that shortens them for display) cannot know who
    // qualified. Reburn still happens, since the node's VHP must stay level;
    // those pools pay nobody and their slice carries rather than being kept.
    // The producing pool is untouched — it never needed the roster.
    const rosterNeverAnswered = aiActive && st.aiReads.ok === 0;
    const rosterAllUnusable =
      aiActive && st.aiReads.ok > 0 && st.aiReads.accepted === 0 && st.aiReads.rejected > 0;
    const aiUnavailable = rosterNeverAnswered || rosterAllUnusable;
    const heldTiers = aiUnavailable ? ["ai", "both"] : [];

    // Only pay addresses that still read as valid — a credit ledger outlives
    // the cycle that filled it, so re-check rather than trusting it blindly.
    const credits = {};
    for (const tier of TIERS) {
      credits[tier] = Object.fromEntries(
        Object.entries(st.credits[tier] ?? {}).filter(
          ([address, credit]) => this.chain.isValidAddress(address) && cmpSats(credit, "0") > 0
        )
      );
    }

    const settle = settleCycle({
      periodRewardsSat,
      periodVhpConsumedSat,
      carry: st.carry,
      credits,
      selfAddress,
      minPayoutSat: parseAmount(cfg.minPayoutKoin),
      weighting: cfg.weighting,
      reburnPct: cfg.reburnPct,
      sharePct: cfg.sharePct,
      heldTiers,
    });

    if (cmpSats(settle.reburnSat, "0") > 0) st.reburnOwed = addSats(st.reburnOwed, settle.reburnSat);
    st.payouts.push(...settle.recipients);
    st.carry = settle.carryOut;

    const record = {
      time: now,
      periodRewards: cmpSats(periodRewardsSat, "0") > 0 ? periodRewardsSat : "0",
      periodVhpConsumed: cmpSats(periodVhpConsumedSat, "0") > 0 ? periodVhpConsumedSat : "0",
      profit: settle.profitSat,
      pool: settle.poolSat,
      reburn: settle.reburnSat,
      levelReburn: settle.levelReburnSat,
      extraReburn: settle.extraReburnSat,
      kept: settle.keptSat,
      share: settle.shareSat,
      weighting: settle.weighting,
      tiers: settle.tiers,
      ticks: st.ticks,
      skippedBelowMin: settle.skippedBelowMin,
      eligibleCount: settle.eligibleCount,
      recipientCount: settle.recipients.length,
      selfKept: settle.selfKeptSat,
      carryOut: settle.carryOutSat,
      carryOutByTier: settle.carryOut,
      seenCount: producers.length,
      aiSeenCount: Object.keys(st.aiSeen).length,
      poolCount: settle.eligibleCount,
      splits: {
        reburnPct: cfg.reburnPct,
        ...cfg.sharePct,
        keptPct: 100 - cfg.reburnPct - cfg.sharePct.ai - cfg.sharePct.producing - cfg.sharePct.both,
        minVhpKoin: cfg.minVhpKoin,
      },
      // Set when the AI roster never answered this cycle — explains why the
      // AI pools paid nobody, so an empty distribution is never a silent
      // mystery.
      holdReason: rosterAllUnusable
        ? `The AI node roster answered, but none of the ${st.aiReads.rejected} addresses it returned were valid Koinos addresses — a status/display endpoint that shortens addresses can't be paid to. The AI pools paid nobody and their share carried over.`
        : rosterNeverAnswered
          ? `Koinos AI Node roster unavailable all cycle (${st.aiReads.lastError ?? "no successful read"}) — the AI pools paid nobody and their share carried over.`
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
    for (const tier of TIERS) {
      for (const address of settle.paidAddresses?.[tier] ?? []) delete st.credits[tier][address];
    }
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
          // How the profit so far would be carved up if the cycle closed now.
          split: previewSplit(cmpSats(r, v) > 0 ? subSats(r, v) : "0", cfg),
        };
      }
      const payoutTotal = st.payouts.reduce((acc, p) => addSats(acc, p.amountSat), "0");
      // Who currently holds credit in each pool — the live answer to "would I
      // be paid, and out of which pot?".
      const creditCounts = {};
      for (const tier of TIERS) creditCounts[tier] = Object.keys(st.credits[tier] ?? {}).length;
      derived = {
        anchored: !!st.anchor,
        cycle,
        carry: Object.values(st.carry).reduce((a, v) => addSats(a, v), "0"),
        carryByTier: st.carry,
        creditCounts,
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
  migrateDistributionConfig,
  activeDimensions,
  nextCycleClose,
  mergeSeen,
  mergeAiSeen,
  tiersFor,
  classifyCandidates,
  splitPool,
  settleCycle,
  previewSplit,
  planTick,
  TIERS,
  TIER_LABELS,
};
