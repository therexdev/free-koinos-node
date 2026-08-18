"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DistributionEngine,
  validateDistributionConfig,
  nextCycleClose,
  mergeSeen,
  mergeAiSeen,
  selectEligible,
  settleCycle,
  planTick,
} = require("../electron/lib/distribution");

const KOIN = (n) => String(BigInt(n) * 100000000n);

// ---------- config validation ----------

test("validateDistributionConfig normalizes and rejects bad values", () => {
  const cfg = validateDistributionConfig({
    enabled: 1, requireVhpMinimum: 1, requireAiNode: 0, aiRosterUrl: "",
    minVhpKoin: "10000", payoutHourUtc: "3", minPayoutKoin: "0.5", pollMinutes: "15",
  });
  assert.deepEqual(cfg, {
    enabled: true, weighting: "participation",
    requireVhpMinimum: true, requireAiNode: false, aiRosterUrl: "",
    minVhpKoin: "10000", payoutHourUtc: 3, minPayoutKoin: "0.5", pollMinutes: 15,
  });
  assert.throws(() => validateDistributionConfig({ weighting: "sideways", minVhpKoin: "1", payoutHourUtc: 0, minPayoutKoin: "1", pollMinutes: 10 }), /weighting/);
  // A blank roster URL stays allowed with the AI gate on (the engine fails
  // closed at settlement instead), but a malformed one is rejected on save.
  assert.equal(
    validateDistributionConfig({ requireAiNode: true, aiRosterUrl: "", minVhpKoin: "1", payoutHourUtc: 0, minPayoutKoin: "1", pollMinutes: 10 }).aiRosterUrl,
    ""
  );
  assert.throws(() => validateDistributionConfig({ aiRosterUrl: "not a url", minVhpKoin: "1", payoutHourUtc: 0, minPayoutKoin: "1", pollMinutes: 10 }), /valid URL|https/);
  assert.throws(() => validateDistributionConfig({ aiRosterUrl: "http://evil.example/roster", minVhpKoin: "1", payoutHourUtc: 0, minPayoutKoin: "1", pollMinutes: 10 }), /https/);
  assert.throws(() => validateDistributionConfig({ minVhpKoin: "0", payoutHourUtc: 0, minPayoutKoin: "1", pollMinutes: 10 }), /Minimum VHP/);
  assert.throws(() => validateDistributionConfig({ minVhpKoin: "x", payoutHourUtc: 0, minPayoutKoin: "1", pollMinutes: 10 }), /Invalid amount/);
  assert.throws(() => validateDistributionConfig({ minVhpKoin: "10000", payoutHourUtc: 24, minPayoutKoin: "1", pollMinutes: 10 }), /hour/);
  assert.throws(() => validateDistributionConfig({ minVhpKoin: "10000", payoutHourUtc: 2.5, minPayoutKoin: "1", pollMinutes: 10 }), /hour/);
  assert.throws(() => validateDistributionConfig({ minVhpKoin: "10000", payoutHourUtc: 0, minPayoutKoin: "-1", pollMinutes: 10 }), /Invalid amount/);
  assert.throws(() => validateDistributionConfig({ minVhpKoin: "10000", payoutHourUtc: 0, minPayoutKoin: "1", pollMinutes: 0 }), /interval/);
  // "0" minimum payout is allowed (pay any share, however small)
  assert.equal(validateDistributionConfig({ minVhpKoin: "1", payoutHourUtc: 0, minPayoutKoin: "0", pollMinutes: 10 }).minPayoutKoin, "0");
});

// ---------- daily boundary ----------

test("nextCycleClose picks the next occurrence of the UTC hour", () => {
  const t = Date.UTC(2026, 0, 10, 5, 30); // Jan 10, 05:30 UTC
  assert.equal(nextCycleClose(t, 6), Date.UTC(2026, 0, 10, 6, 0)); // later today
  assert.equal(nextCycleClose(t, 5), Date.UTC(2026, 0, 11, 5, 0)); // 05:00 already passed
  assert.equal(nextCycleClose(t, 0), Date.UTC(2026, 0, 11, 0, 0)); // midnight tomorrow
  // Exactly on the boundary → the NEXT day (strictly after)
  assert.equal(nextCycleClose(Date.UTC(2026, 0, 10, 6, 0), 6), Date.UTC(2026, 0, 11, 6, 0));
});

// ---------- snapshot merging ----------

test("mergeSeen accumulates blocks per signer and tracks last-seen", () => {
  const seen = {};
  mergeSeen(seen, [
    { height: 100, timestamp: 1000, signer: "A" },
    { height: 101, timestamp: 1003, signer: "B" },
    { height: 102, timestamp: 1006, signer: "A" },
    { height: 103, timestamp: 1009, signer: null }, // ignored
  ]);
  assert.equal(seen.A.blocks, 2);
  assert.equal(seen.A.lastSeenHeight, 102);
  assert.equal(seen.A.lastSeenMs, 1006);
  assert.equal(seen.B.blocks, 1);
  assert.equal(Object.keys(seen).length, 2);
});

test("mergeAiSeen records every address the roster reported", () => {
  const ai = {};
  mergeAiSeen(ai, ["A", "B"], 1000);
  mergeAiSeen(ai, ["A"], 2000);
  assert.equal(ai.A.reads, 2);
  assert.equal(ai.A.lastSeenMs, 2000);
  assert.equal(ai.B.reads, 1);
});

// ---------- the eligibility matrix (the two checkboxes) ----------

// Four candidates covering every interesting combination of signals.
const CANDIDATES = [
  { address: "produces-rich",  producing: true,  aiNode: false, vhpSat: KOIN(50000) },
  { address: "produces-poor",  producing: true,  aiNode: false, vhpSat: KOIN(500) },
  { address: "ai-and-mines",   producing: true,  aiNode: true,  vhpSat: KOIN(10000) },
  { address: "ai-only",        producing: false, aiNode: true,  vhpSat: "0" },
];
const matrix = (requireVhpMinimum, requireAiNode) =>
  selectEligible({ candidates: CANDIDATES, requireVhpMinimum, requireAiNode, minVhpSat: KOIN(10000) }).eligible;

test("neither box: every node seen producing earns a share", () => {
  assert.deepEqual(matrix(false, false), ["produces-rich", "produces-poor", "ai-and-mines"]);
});

test("VHP only: producing nodes at or above the minimum", () => {
  // "produces-poor" is below the 10k line; "ai-only" never produced a block.
  assert.deepEqual(matrix(true, false), ["produces-rich", "ai-and-mines"]);
});

test("AI only: anyone seen on an AI node, block production irrelevant", () => {
  assert.deepEqual(matrix(false, true), ["ai-and-mines", "ai-only"]);
});

test("both boxes: must be on an AI node AND mining with the minimum VHP", () => {
  assert.deepEqual(matrix(true, true), ["ai-and-mines"]);
});

test("exactly at the minimum VHP qualifies (>=, not >)", () => {
  const { eligible } = selectEligible({
    candidates: [{ address: "edge", producing: true, aiNode: true, vhpSat: KOIN(10000) }],
    requireVhpMinimum: true, requireAiNode: false, minVhpSat: KOIN(10000),
  });
  assert.deepEqual(eligible, ["edge"]);
});

test("an unreadable VHP balance is never assumed to qualify", () => {
  const { eligible, rejected } = selectEligible({
    candidates: [{ address: "unknown", producing: true, aiNode: true, vhpSat: null }],
    requireVhpMinimum: true, requireAiNode: false, minVhpSat: KOIN(10000),
  });
  assert.deepEqual(eligible, []);
  assert.equal(rejected.vhpUnknown, 1);
});

test("rejection reasons are tallied for the UI", () => {
  const { rejected } = selectEligible({
    candidates: CANDIDATES, requireVhpMinimum: true, requireAiNode: true, minVhpSat: KOIN(10000),
  });
  assert.equal(rejected.notProducing, 1); // ai-only
  assert.equal(rejected.belowVhp, 1);     // produces-poor
  assert.equal(rejected.notAiNode, 1);    // produces-rich
});

// ---------- cycle settlement ----------

const settleBase = { carrySat: "0", selfAddress: "SELF", minPayoutSat: KOIN(1) };

test("the headline case: 100 KOIN profit over 10 nodes -> 10 KOIN each", () => {
  const eligible = Array.from({ length: 10 }, (_, i) => `N${i}`);
  const s = settleCycle({
    periodRewardsSat: KOIN(1100), periodVhpConsumedSat: KOIN(1000),
    eligible, ...settleBase,
  });
  assert.equal(s.reburnSat, KOIN(1000)); // restore the VHP that was consumed
  assert.equal(s.profitSat, KOIN(100));
  assert.equal(s.shareSat, KOIN(10));
  assert.equal(s.recipients.length, 10); // SELF not among eligible here
  assert.equal(s.carryOutSat, "0");
});

test("self counts for the split but keeps its share instead of a transfer", () => {
  const s = settleCycle({
    periodRewardsSat: KOIN(110), periodVhpConsumedSat: KOIN(100),
    eligible: ["A", "B", "SELF", "C", "D"], ...settleBase,
  });
  assert.equal(s.shareSat, KOIN(2)); // 10 profit / 5 nodes
  assert.equal(s.recipients.length, 4);
  assert.ok(!s.recipients.some((r) => r.address === "SELF"));
  assert.equal(s.selfKeptSat, KOIN(2));
  assert.equal(s.carryOutSat, "0");
});

test("integer split: the remainder carries to the next cycle", () => {
  const s = settleCycle({
    periodRewardsSat: KOIN(110), periodVhpConsumedSat: KOIN(100),
    eligible: ["A", "B", "C"], ...settleBase,
  });
  // 10 KOIN / 3 = 3.33333333 each, 1 sat left over
  assert.equal(s.shareSat, "333333333");
  assert.equal(s.carryOutSat, "1");
});

test("share below the minimum payout -> whole pool carries", () => {
  const s = settleCycle({
    periodRewardsSat: KOIN(101), periodVhpConsumedSat: KOIN(100),
    eligible: ["A", "B", "C"], ...settleBase, // 1 KOIN / 3 < 1 KOIN minimum
  });
  assert.equal(s.shareSat, "0");
  assert.equal(s.recipients.length, 0);
  assert.equal(s.carryOutSat, KOIN(1));
  assert.equal(s.reburnSat, KOIN(100)); // reburn still happens
});

test("no eligible nodes -> profit carries, reburn still owed", () => {
  const s = settleCycle({
    periodRewardsSat: KOIN(110), periodVhpConsumedSat: KOIN(100),
    eligible: [], ...settleBase,
  });
  assert.equal(s.recipients.length, 0);
  assert.equal(s.carryOutSat, KOIN(10));
  assert.equal(s.reburnSat, KOIN(100));
});

test("carry from earlier cycles joins the pool", () => {
  const s = settleCycle({
    periodRewardsSat: KOIN(105), periodVhpConsumedSat: KOIN(100),
    carrySat: KOIN(5), eligible: ["A", "B"], selfAddress: "SELF", minPayoutSat: KOIN(1),
  });
  assert.equal(s.poolSat, KOIN(10)); // 5 profit + 5 carried
  assert.equal(s.shareSat, KOIN(5));
});

test("negative period figures clamp to zero (fresh anchor edge cases)", () => {
  const s = settleCycle({
    periodRewardsSat: "-5", periodVhpConsumedSat: "-7",
    eligible: ["A"], ...settleBase,
  });
  assert.equal(s.reburnSat, "0");
  assert.equal(s.profitSat, "0");
  assert.equal(s.recipients.length, 0);
});

// ---------- credit weighting (the anti-last-minute rule) ----------
//
// Every time this node collects a reward, each address qualifying at that
// moment is credited with it; shares are credit / total credit.

test("the worked example: A alone, then A and B -> 66% / 33%", () => {
  const R = KOIN(1); // one reward interval
  // Reward 1: only A qualifies. Reward 2: A and B both qualify.
  const credits = { A: (BigInt(R) * 2n).toString(), B: R };
  const s = settleCycle({
    periodRewardsSat: KOIN(2), periodVhpConsumedSat: "0",
    eligible: Object.entries(credits).map(([address, weight]) => ({ address, weight })),
    selfAddress: "SELF", minPayoutSat: "1", carrySat: "0",
  });
  const paid = Object.fromEntries(s.recipients.map((r) => [r.address, r.amountSat]));
  // 2 KOIN pool, credits 2:1
  assert.equal(paid.A, "133333333"); // 66.6%
  assert.equal(paid.B, "66666666");  // 33.3%
});

test("the worked example continued: A leaves, C joins -> 40 / 40 / 20", () => {
  const R = BigInt(KOIN(1));
  // Three reward intervals. A: 1,2. B: 2,3. C: 3.
  const s = settleCycle({
    periodRewardsSat: KOIN(3), periodVhpConsumedSat: "0",
    eligible: [
      { address: "A", weight: (R * 2n).toString() },
      { address: "B", weight: (R * 2n).toString() },
      { address: "C", weight: R.toString() },
    ],
    selfAddress: "SELF", minPayoutSat: "1", carrySat: "0",
  });
  const paid = Object.fromEntries(s.recipients.map((r) => [r.address, r.amountSat]));
  assert.equal(paid.A, "120000000"); // 40% of 3 KOIN
  assert.equal(paid.B, "120000000"); // 40%
  assert.equal(paid.C, "60000000");  // 20%
});

test("a latecomer earns the rewards it was present for, not a full share", () => {
  const R = BigInt(KOIN(1));
  const s = settleCycle({
    periodRewardsSat: KOIN(144), periodVhpConsumedSat: "0",
    eligible: [
      { address: "allday", weight: (R * 144n).toString() },
      { address: "latecomer", weight: (R * 2n).toString() },
    ],
    selfAddress: "SELF", minPayoutSat: "1", carrySat: "0",
  });
  const paid = Object.fromEntries(s.recipients.map((r) => [r.address, r.amountSat]));
  assert.equal(paid.allday, "14202739726");   // 144/146 of the pool
  assert.equal(paid.latecomer, "197260273");  // 2/146 — ~1.97 KOIN, not 72
});

test("even weighting still ignores credit and splits flat", () => {
  const s = settleCycle({
    periodRewardsSat: KOIN(100), periodVhpConsumedSat: "0",
    eligible: [
      { address: "allday", weight: KOIN(144) },
      { address: "latecomer", weight: KOIN(2) },
    ],
    selfAddress: "SELF", minPayoutSat: "1", carrySat: "0", weighting: "even",
  });
  const paid = Object.fromEntries(s.recipients.map((r) => [r.address, r.amountSat]));
  assert.equal(paid.allday, KOIN(50));
  assert.equal(paid.latecomer, KOIN(50));
});

test("a share below the minimum is skipped and carried, not dusted out", () => {
  // Paying dust is actively harmful: every payout spends mana 1:1.
  const s = settleCycle({
    periodRewardsSat: KOIN(10), periodVhpConsumedSat: "0",
    eligible: [{ address: "steady", weight: KOIN(144) }, { address: "blip", weight: KOIN(1) }],
    selfAddress: "SELF", minPayoutSat: KOIN(1), carrySat: "0",
  });
  assert.equal(s.recipients.length, 1);
  assert.equal(s.recipients[0].address, "steady");
  assert.equal(s.skippedBelowMin, 1);
  assert.ok(BigInt(s.carryOutSat) > 0n); // blip's slice rolls forward
});

test("nobody earned any credit -> the whole pool carries", () => {
  const s = settleCycle({
    periodRewardsSat: KOIN(110), periodVhpConsumedSat: KOIN(100),
    eligible: [{ address: "ghost", weight: "0" }],
    selfAddress: "SELF", minPayoutSat: KOIN(1), carrySat: "0",
  });
  assert.equal(s.recipients.length, 0);
  assert.equal(s.carryOutSat, KOIN(10));
});

// ---------- per-tick planning (mana/liquid chunking) ----------

test("planTick reburns first, then pays out FIFO", () => {
  const { actions, limitedBy } = planTick({
    reburnOwedSat: KOIN(50),
    payouts: [{ address: "A", amountSat: KOIN(10) }, { address: "B", amountSat: KOIN(10) }],
    availableLiquidSat: KOIN(1000),
    availableManaSat: KOIN(1000),
  });
  assert.equal(limitedBy, null);
  assert.deepEqual(actions.map((a) => a.kind), ["reburn", "payout", "payout"]);
  assert.equal(actions[0].amountSat, KOIN(50));
});

test("planTick chunks the reburn to the mana available now", () => {
  const { actions, limitedBy } = planTick({
    reburnOwedSat: KOIN(100),
    payouts: [{ address: "A", amountSat: KOIN(10) }],
    availableLiquidSat: KOIN(1000),
    availableManaSat: KOIN(30),
  });
  assert.equal(actions.length, 1); // partial reburn; no mana left for the payout
  assert.equal(actions[0].kind, "reburn");
  assert.equal(actions[0].amountSat, KOIN(30));
  assert.equal(limitedBy, "mana");
});

test("planTick skips a dust reburn chunk but always finishes the last crumb", () => {
  // 0.4 KOIN of mana against 100 owed -> not worth a tx yet
  const a = planTick({ reburnOwedSat: KOIN(100), payouts: [], availableLiquidSat: KOIN(10), availableManaSat: "40000000" });
  assert.equal(a.actions.length, 0);
  assert.equal(a.limitedBy, "mana");
  // …but when the whole remaining debt IS 0.4 KOIN, finish it off
  const b = planTick({ reburnOwedSat: "40000000", payouts: [], availableLiquidSat: KOIN(10), availableManaSat: KOIN(10) });
  assert.equal(b.actions.length, 1);
  assert.equal(b.actions[0].amountSat, "40000000");
});

test("planTick never lets a later payout jump a blocked one (FIFO fairness)", () => {
  const { actions, limitedBy } = planTick({
    reburnOwedSat: "0",
    payouts: [
      { address: "A", amountSat: KOIN(50) }, // doesn't fit
      { address: "B", amountSat: KOIN(1) },  // would fit, must still wait
    ],
    availableLiquidSat: KOIN(1000),
    availableManaSat: KOIN(10),
  });
  assert.equal(actions.length, 0);
  assert.equal(limitedBy, "mana");
});

test("planTick caps the number of transactions per tick", () => {
  const payouts = Array.from({ length: 20 }, (_, i) => ({ address: `N${i}`, amountSat: KOIN(1) }));
  const { actions } = planTick({
    reburnOwedSat: "0", payouts,
    availableLiquidSat: KOIN(1000), availableManaSat: KOIN(1000),
    maxActions: 5,
  });
  assert.equal(actions.length, 5);
});

// ---------- engine end-to-end (mocked chain) ----------

class MemStore {
  constructor(data = {}) { this.data = data; }
  get(key, fallback) {
    const v = key.split(".").reduce((o, k) => (o == null ? o : o[k]), this.data);
    return v === undefined ? fallback : v;
  }
  set(key, value) {
    const parts = key.split(".");
    let o = this.data;
    for (const p of parts.slice(0, -1)) {
      if (typeof o[p] !== "object" || o[p] === null) o[p] = {};
      o = o[p];
    }
    o[parts[parts.length - 1]] = value;
  }
}

const SELF = "1SelfProducerAddressXXXXXXXXXXXXXX";

function makeWorld({ totals, headers, vhp, balances, cfg = {}, roster = null }) {
  const settings = new MemStore({
    network: "mainnet",
    keepLiquidKoin: "10",
    distribution: {
      enabled: true,
      requireVhpMinimum: true,
      requireAiNode: false,
      aiRosterUrl: "",
      minVhpKoin: "10000",
      payoutHourUtc: 0,
      minPayoutKoin: "0.5",
      pollMinutes: 10,
      ...cfg,
    },
  });
  const state = new MemStore();
  const calls = { burns: [], transfers: [] };
  const chain = {
    network: () => ({ id: "mainnet" }),
    isValidAddress: (a) => typeof a === "string" && a.length > 20,
    headInfo: async () => ({ height: 1000, lastIrreversible: 995, headBlockTimeMs: Date.now() }),
    blockHeaders: async () => ({ headHeight: 1000, headers }),
    vhpBalances: async (addrs) => Object.fromEntries(addrs.map((a) => [a, vhp[a] ?? "0"])),
    balances: async () => balances,
    burn: async (_signer, amountSat) => {
      calls.burns.push(amountSat);
      return { txId: `burn-${calls.burns.length}`, confirmed: true };
    },
    transfer: async (_signer, { to, amountSat }) => {
      calls.transfers.push({ to, amountSat });
      return { txId: `send-${calls.transfers.length}`, confirmed: true };
    },
  };
  const wallet = {
    status: () => ({ exists: true, unlocked: true, address: SELF }),
    signer: {},
  };
  const stats = {
    refresh: async () => ({ available: true, syncing: false, totals: totals.current }),
    get: () => ({ totals: totals.current }),
  };
  const engine = new DistributionEngine({ chain, wallet, settings, state, stats, onEvent: () => {} });
  // Stand in for the network call to the Koinos AI Node roster: `roster` is
  // either an array of addresses or a function that may throw.
  if (roster) {
    const rosterFn = typeof roster === "function" ? roster : () => roster;
    engine._fetchRoster = async () => ({ addresses: rosterFn() });
  }
  return { engine, calls, settings, state, totals };
}

const mkAddr = (c) => `1${String(c).repeat(30)}Producer`;
const A = mkAddr("A");
const B = mkAddr("B");
const C = mkAddr("C");

test("engine: anchors first, then closes a cycle, reburns, and pays evenly", async () => {
  const totals = { current: { rewards: KOIN(1000), vhpConsumed: KOIN(900), blocks: 100 } };
  const world = makeWorld({
    totals,
    headers: [
      { height: 998, timestamp: 1, signer: A },
      { height: 999, timestamp: 2, signer: B },
      { height: 1000, timestamp: 3, signer: C },
      { height: 997, timestamp: 0, signer: SELF },
    ],
    vhp: { [A]: KOIN(10000), [B]: KOIN(250000), [C]: KOIN(500), [SELF]: KOIN(15000) },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
  });

  // First tick only anchors — nothing earned before enabling is touched.
  let res = await world.engine.tick("manual");
  assert.equal(res.last.outcome, "anchored");

  // Produce 110 KOIN of rewards consuming 100 VHP since the anchor.
  totals.current = { rewards: KOIN(1110), vhpConsumed: KOIN(1000), blocks: 110 };

  res = await world.engine.tick("manual", { forceClose: true });
  assert.equal(res.last.outcome, "cycle-closed");

  const closedRecord = res.derived.lastDistribution;
  assert.equal(closedRecord.profit, KOIN(10));
  assert.equal(closedRecord.reburn, KOIN(100));
  // A, B and SELF qualify (C has only 500 VHP): 10 / 3 each
  assert.equal(closedRecord.eligibleCount, 3);
  assert.equal(closedRecord.share, "333333333");
  assert.equal(closedRecord.selfKept, "333333333");
  assert.equal(closedRecord.recipientCount, 2);

  // The same tick drained the queue: one 100-KOIN reburn + two payouts.
  assert.deepEqual(world.calls.burns, [KOIN(100)]);
  assert.deepEqual(
    world.calls.transfers.map((t) => t.to).sort(),
    [A, B].sort()
  );
  assert.ok(world.calls.transfers.every((t) => t.amountSat === "333333333"));
  assert.equal(res.derived.queue.empty, true);
  // 1 sat of integer-division remainder carries into the next cycle.
  assert.equal(res.derived.carry, "1");
  // The next cycle re-anchored at the current totals.
  assert.equal(res.derived.cycle.rewards, "0");
});

test("engine: mana-limited reburn drains across ticks and pays out when it can", async () => {
  const totals = { current: { rewards: KOIN(0), vhpConsumed: KOIN(0), blocks: 0 } };
  const balances = { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(41) }; // 40 usable after the 1-KOIN cushion
  const world = makeWorld({
    totals,
    headers: [{ height: 1000, timestamp: 3, signer: A }],
    vhp: { [A]: KOIN(10000) },
    balances,
  });

  await world.engine.tick("manual"); // anchor
  totals.current = { rewards: KOIN(110), vhpConsumed: KOIN(100), blocks: 10 };

  let res = await world.engine.tick("manual", { forceClose: true });
  assert.equal(res.last.outcome, "cycle-closed");
  // Only 40 KOIN of mana available -> partial reburn, payout still queued.
  assert.deepEqual(world.calls.burns, [KOIN(40)]);
  assert.equal(world.calls.transfers.length, 0);
  assert.equal(res.derived.queue.reburnOwed, KOIN(60));
  assert.equal(res.derived.queue.payouts.length, 1);

  // Mana recharged: the rest of the reburn and the payout go out.
  balances.mana = KOIN(1000);
  res = await world.engine.tick("manual");
  assert.equal(res.last.outcome, "distributed");
  assert.deepEqual(world.calls.burns, [KOIN(40), KOIN(60)]);
  assert.equal(world.calls.transfers.length, 1);
  assert.equal(world.calls.transfers[0].to, A);
  assert.equal(world.calls.transfers[0].amountSat, KOIN(10)); // sole eligible node gets all profit
  assert.equal(res.derived.queue.empty, true);
});

test("engine: locked wallet holds the queue without losing it", async () => {
  const totals = { current: { rewards: KOIN(0), vhpConsumed: KOIN(0), blocks: 0 } };
  const world = makeWorld({
    totals,
    headers: [{ height: 1000, timestamp: 3, signer: A }],
    vhp: { [A]: KOIN(10000) },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
  });
  const wallet = { status: () => ({ exists: true, unlocked: false, address: SELF }), signer: {} };
  world.engine.wallet = wallet;

  await world.engine.tick("manual"); // anchor
  totals.current = { rewards: KOIN(110), vhpConsumed: KOIN(100), blocks: 10 };

  const res = await world.engine.tick("manual", { forceClose: true });
  assert.equal(res.last.outcome, "locked");
  assert.equal(world.calls.burns.length, 0);
  assert.equal(res.derived.queue.reburnOwed, KOIN(100));
  assert.equal(res.derived.queue.payouts.length, 1);
});

test("engine: disabled means dormant — behaves like a normal node", async () => {
  const totals = { current: { rewards: KOIN(100), vhpConsumed: KOIN(90), blocks: 10 } };
  const world = makeWorld({
    totals,
    headers: [{ height: 1000, timestamp: 3, signer: A }],
    vhp: { [A]: KOIN(10000) },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
  });
  world.settings.set("distribution.enabled", false);
  const res = await world.engine.tick("timer");
  assert.equal(res.last.outcome, "disabled");
  assert.equal(world.calls.burns.length, 0);
  assert.equal(world.calls.transfers.length, 0);
});

test("engine (AI only): pays an AI node that never produced a block", async () => {
  const totals = { current: { rewards: KOIN(0), vhpConsumed: KOIN(0), blocks: 0 } };
  const world = makeWorld({
    totals,
    headers: [{ height: 1000, timestamp: 3, signer: A }], // only A produces
    vhp: { [A]: KOIN(10000), [B]: "0" },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
    cfg: { requireVhpMinimum: false, requireAiNode: true, aiRosterUrl: "https://kai.example/workers" },
    roster: [B], // B serves AI but has no VHP and produces nothing
  });
  await world.engine.tick("manual");
  totals.current = { rewards: KOIN(110), vhpConsumed: KOIN(100), blocks: 10 };

  const res = await world.engine.tick("manual", { forceClose: true });
  assert.equal(res.last.outcome, "cycle-closed");
  // Only B qualifies — the AI gate ignores block production and VHP entirely.
  assert.equal(res.derived.lastDistribution.eligibleCount, 1);
  assert.equal(world.calls.transfers.length, 1);
  assert.equal(world.calls.transfers[0].to, B);
  assert.equal(world.calls.transfers[0].amountSat, KOIN(10));
  assert.deepEqual(world.calls.burns, [KOIN(100)]); // VHP restored either way
});

test("engine (both gates): only an AI node that also mines with the VHP is paid", async () => {
  const totals = { current: { rewards: KOIN(0), vhpConsumed: KOIN(0), blocks: 0 } };
  const world = makeWorld({
    totals,
    headers: [
      { height: 999, timestamp: 2, signer: A }, // mines, 10k VHP, on AI  -> pays
      { height: 1000, timestamp: 3, signer: C }, // mines, 10k VHP, no AI -> no
    ],
    vhp: { [A]: KOIN(10000), [B]: KOIN(999999), [C]: KOIN(10000) },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
    cfg: { requireVhpMinimum: true, requireAiNode: true, aiRosterUrl: "https://kai.example/workers" },
    roster: [A, B], // B is on AI but produces no blocks -> no
  });
  await world.engine.tick("manual");
  totals.current = { rewards: KOIN(110), vhpConsumed: KOIN(100), blocks: 10 };

  const res = await world.engine.tick("manual", { forceClose: true });
  assert.equal(res.derived.lastDistribution.eligibleCount, 1);
  assert.equal(world.calls.transfers.length, 1);
  assert.equal(world.calls.transfers[0].to, A);
});

test("engine (AI gate): a roster that never answers pays nobody and carries the pool", async () => {
  const totals = { current: { rewards: KOIN(0), vhpConsumed: KOIN(0), blocks: 0 } };
  const world = makeWorld({
    totals,
    headers: [{ height: 1000, timestamp: 3, signer: A }],
    vhp: { [A]: KOIN(10000) },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
    cfg: { requireVhpMinimum: false, requireAiNode: true, aiRosterUrl: "https://kai.example/workers" },
    roster: () => { throw new Error("roster offline"); },
  });
  await world.engine.tick("manual");
  totals.current = { rewards: KOIN(110), vhpConsumed: KOIN(100), blocks: 10 };

  const res = await world.engine.tick("manual", { forceClose: true });
  assert.equal(res.last.outcome, "cycle-held");
  assert.equal(world.calls.transfers.length, 0);        // nobody guessed at
  assert.deepEqual(world.calls.burns, [KOIN(100)]);      // VHP still restored
  assert.equal(res.derived.carry, KOIN(10));             // profit carried whole
  assert.match(res.derived.lastDistribution.holdReason, /roster offline/);
});

test("engine (AI gate): a roster of truncated display addresses is held, not silently empty", async () => {
  // The exact trap: pointing at a status page that shortens addresses for
  // display. Every read succeeds, so this is NOT the "roster offline" path —
  // it must still be caught and explained rather than closing as a normal
  // cycle that happened to pay nobody.
  const totals = { current: { rewards: KOIN(0), vhpConsumed: KOIN(0), blocks: 0 } };
  const world = makeWorld({
    totals,
    headers: [{ height: 1000, timestamp: 3, signer: A }],
    vhp: { [A]: KOIN(10000) },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
    cfg: { requireVhpMinimum: false, requireAiNode: true, aiRosterUrl: "https://koinosai.example/status" },
  });
  // A successful read that yielded no usable addresses: 10 rejected, 0 kept.
  world.engine._fetchRoster = async () => ({ addresses: [], rejected: 10 });

  await world.engine.tick("manual");
  totals.current = { rewards: KOIN(110), vhpConsumed: KOIN(100), blocks: 10 };

  const res = await world.engine.tick("manual", { forceClose: true });
  assert.equal(res.last.outcome, "cycle-held");
  assert.equal(world.calls.transfers.length, 0);
  assert.deepEqual(world.calls.burns, [KOIN(100)]); // VHP still restored
  assert.equal(res.derived.carry, KOIN(10));
  assert.match(res.derived.lastDistribution.holdReason, /none of the 10 addresses/);
});

test("engine (AI gate): a roster with some bad entries still pays the good ones", async () => {
  const totals = { current: { rewards: KOIN(0), vhpConsumed: KOIN(0), blocks: 0 } };
  const world = makeWorld({
    totals,
    headers: [{ height: 1000, timestamp: 3, signer: A }],
    vhp: { [A]: KOIN(10000) },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
    cfg: { requireVhpMinimum: false, requireAiNode: true, aiRosterUrl: "https://kai.example/roster" },
  });
  world.engine._fetchRoster = async () => ({ addresses: [A], rejected: 3 });

  await world.engine.tick("manual");
  totals.current = { rewards: KOIN(110), vhpConsumed: KOIN(100), blocks: 10 };

  const res = await world.engine.tick("manual", { forceClose: true });
  assert.equal(res.last.outcome, "cycle-closed"); // not held — one address was usable
  assert.equal(world.calls.transfers.length, 1);
  assert.equal(world.calls.transfers[0].to, A);
});

test("engine (AI gate): no roster URL configured also fails closed", async () => {
  const totals = { current: { rewards: KOIN(0), vhpConsumed: KOIN(0), blocks: 0 } };
  const world = makeWorld({
    totals,
    headers: [{ height: 1000, timestamp: 3, signer: A }],
    vhp: { [A]: KOIN(10000) },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
    cfg: { requireVhpMinimum: true, requireAiNode: true, aiRosterUrl: "" },
  });
  await world.engine.tick("manual");
  totals.current = { rewards: KOIN(110), vhpConsumed: KOIN(100), blocks: 10 };

  const res = await world.engine.tick("manual", { forceClose: true });
  assert.equal(res.last.outcome, "cycle-held");
  assert.equal(world.calls.transfers.length, 0);
  assert.equal(res.derived.carry, KOIN(10));
});

test("engine (no gates): every producer seen is paid, VHP never fetched", async () => {
  const totals = { current: { rewards: KOIN(0), vhpConsumed: KOIN(0), blocks: 0 } };
  let vhpLookups = 0;
  const world = makeWorld({
    totals,
    headers: [
      { height: 999, timestamp: 2, signer: A },
      { height: 1000, timestamp: 3, signer: C }, // tiny VHP, still paid
    ],
    vhp: { [A]: KOIN(10000), [C]: "1" },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
    cfg: { requireVhpMinimum: false, requireAiNode: false },
  });
  const realVhp = world.engine.chain.vhpBalances;
  world.engine.chain.vhpBalances = async (...a) => { vhpLookups += 1; return realVhp(...a); };

  await world.engine.tick("manual");
  totals.current = { rewards: KOIN(110), vhpConsumed: KOIN(100), blocks: 10 };
  const res = await world.engine.tick("manual", { forceClose: true });

  assert.equal(res.derived.lastDistribution.eligibleCount, 2);
  assert.equal(world.calls.transfers.length, 2);
  assert.equal(vhpLookups, 0); // gate off -> the balance round-trip is skipped
});

test("engine: a failed payout stays queued and is retried", async () => {
  const totals = { current: { rewards: KOIN(0), vhpConsumed: KOIN(0), blocks: 0 } };
  const world = makeWorld({
    totals,
    headers: [
      { height: 999, timestamp: 2, signer: A },
      { height: 1000, timestamp: 3, signer: B },
    ],
    vhp: { [A]: KOIN(10000), [B]: KOIN(10000) },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
  });
  await world.engine.tick("manual"); // anchor
  totals.current = { rewards: KOIN(120), vhpConsumed: KOIN(100), blocks: 10 };

  // First transfer attempt blows up (e.g. transient RPC failure).
  const realTransfer = world.engine.chain.transfer;
  let failures = 0;
  world.engine.chain.transfer = async (...args) => {
    failures += 1;
    throw new Error("network blip");
  };

  let res = await world.engine.tick("manual", { forceClose: true });
  assert.equal(res.last.outcome, "tx-error");
  assert.equal(failures, 1);
  assert.equal(res.derived.queue.payouts.length, 2); // both still queued
  assert.equal(res.derived.queue.reburnOwed, "0");   // reburn succeeded first

  world.engine.chain.transfer = realTransfer;
  res = await world.engine.tick("manual");
  assert.equal(res.last.outcome, "distributed");
  assert.equal(world.calls.transfers.length, 2);
  assert.equal(res.derived.queue.empty, true);
});
