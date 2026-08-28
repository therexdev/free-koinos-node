"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  DistributionEngine,
  validateDistributionConfig,
  migrateDistributionConfig,
  activeDimensions,
  nextCycleClose,
  mergeSeen,
  mergeAiSeen,
  tiersFor,
  classifyCandidates,
  settleCycle,
  previewSplit,
  planTick,
} = require("../electron/lib/distribution");

const KOIN = (n) => String(BigInt(n) * 100000000n);

// ---------- config validation ----------

test("validateDistributionConfig normalizes and rejects bad values", () => {
  const cfg = validateDistributionConfig({
    enabled: 1, aiRosterUrl: "", reburnPct: "25",
    sharePct: { ai: "10", producing: 20, both: 30 },
    minVhpKoin: "10000", payoutHourUtc: "3", minPayoutKoin: "0.5", pollMinutes: "15",
  });
  assert.deepEqual(cfg, {
    enabled: true, weighting: "participation",
    reburnPct: 25, sharePct: { ai: 10, producing: 20, both: 30 },
    aiRosterUrl: "", minVhpKoin: "10000", payoutHourUtc: 3, minPayoutKoin: "0.5", pollMinutes: 15,
  });
  const base = { sharePct: { ai: 0, producing: 100, both: 0 }, minVhpKoin: "1", payoutHourUtc: 0, minPayoutKoin: "1", pollMinutes: 10 };
  assert.throws(() => validateDistributionConfig({ ...base, weighting: "sideways" }), /weighting/);
  // A blank roster URL stays allowed with an AI pool funded (the engine fails
  // closed at settlement instead), but a malformed one is rejected on save.
  assert.equal(
    validateDistributionConfig({ ...base, sharePct: { ai: 100, producing: 0, both: 0 }, aiRosterUrl: "" }).aiRosterUrl,
    ""
  );
  assert.throws(() => validateDistributionConfig({ ...base, aiRosterUrl: "not a url" }), /valid URL|https/);
  assert.throws(() => validateDistributionConfig({ ...base, aiRosterUrl: "http://evil.example/roster" }), /https/);
  assert.throws(() => validateDistributionConfig({ ...base, minVhpKoin: "x" }), /Invalid amount/);
  assert.throws(() => validateDistributionConfig({ ...base, payoutHourUtc: 24 }), /hour/);
  assert.throws(() => validateDistributionConfig({ ...base, payoutHourUtc: 2.5 }), /hour/);
  assert.throws(() => validateDistributionConfig({ ...base, minPayoutKoin: "-1" }), /Invalid amount/);
  assert.throws(() => validateDistributionConfig({ ...base, pollMinutes: 0 }), /interval/);
  // "0" minimum payout is allowed (pay any share, however small), and a "0"
  // VHP minimum now means "any producer counts".
  assert.equal(validateDistributionConfig({ ...base, minPayoutKoin: "0" }).minPayoutKoin, "0");
  assert.equal(validateDistributionConfig({ ...base, minVhpKoin: "0" }).minVhpKoin, "0");
});

test("the percentages can't promise more of the profit than exists", () => {
  const base = { minVhpKoin: "1", payoutHourUtc: 0, minPayoutKoin: "1", pollMinutes: 10 };
  assert.throws(
    () => validateDistributionConfig({ ...base, reburnPct: 50, sharePct: { ai: 20, producing: 20, both: 20 } }),
    /110%/
  );
  // Exactly 100% is fine, and so is leaving a remainder for the wallet.
  assert.equal(
    validateDistributionConfig({ ...base, reburnPct: 40, sharePct: { ai: 10, producing: 20, both: 30 } }).reburnPct, 40
  );
  const short = validateDistributionConfig({ ...base, reburnPct: 10, sharePct: { ai: 0, producing: 10, both: 10 } });
  assert.equal(short.reburnPct + short.sharePct.ai + short.sharePct.producing + short.sharePct.both, 30);
});

// ---------- upgrading from the two on/off gates ----------

test("the old gates migrate to percentages that pay exactly the same people", () => {
  const legacy = (requireVhpMinimum, requireAiNode) =>
    migrateDistributionConfig({ requireVhpMinimum, requireAiNode, minVhpKoin: "10000" });

  // VHP gate only -> the producing pool takes everything, and because no AI
  // pool is funded the roster is never consulted.
  assert.deepEqual(legacy(true, false).sharePct, { ai: 0, producing: 100, both: 0 });
  assert.equal(activeDimensions(legacy(true, false).sharePct).aiActive, false);
  // AI gate only -> the AI pool takes it, production irrelevant.
  assert.deepEqual(legacy(false, true).sharePct, { ai: 100, producing: 0, both: 0 });
  assert.equal(activeDimensions(legacy(false, true).sharePct).produceActive, false);
  // Both gates -> only the pool that satisfies both.
  assert.deepEqual(legacy(true, true).sharePct, { ai: 0, producing: 0, both: 100 });
  // Neither gate meant "every producer, whatever its VHP" — which is now a
  // producing pool with a zero minimum.
  const none = legacy(false, false);
  assert.deepEqual(none.sharePct, { ai: 0, producing: 100, both: 0 });
  assert.equal(none.minVhpKoin, "0");
  // The old keys are gone once migrated, so they can't contradict the new ones.
  assert.equal("requireVhpMinimum" in none, false);
  assert.equal("requireAiNode" in none, false);
  // Already-migrated config is left exactly as it is.
  const current = { sharePct: { ai: 5, producing: 10, both: 15 }, minVhpKoin: "10000", reburnPct: 20 };
  assert.deepEqual(migrateDistributionConfig(current).sharePct, current.sharePct);
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

// ---------- who lands in which pool ----------

const CANDIDATES = [
  { address: "produces-rich",  producing: true,  aiNode: false, vhpSat: KOIN(50000) },
  { address: "produces-poor",  producing: true,  aiNode: false, vhpSat: KOIN(500) },
  { address: "ai-and-mines",   producing: true,  aiNode: true,  vhpSat: KOIN(10000) },
  { address: "ai-only",        producing: false, aiNode: true,  vhpSat: "0" },
];
const pools = (sharePct, minVhpSat = KOIN(10000)) =>
  classifyCandidates(CANDIDATES, { minVhpSat, ...activeDimensions(sharePct) }).tiers;

test("with only the producing pool funded, the roster is not consulted at all", () => {
  // Membership overlaps, so zeroing the AI pools can never cost anyone the
  // producing pool — it just saves the network call.
  const t = pools({ ai: 0, producing: 100, both: 0 });
  assert.deepEqual(t.producing, ["produces-rich", "ai-and-mines"]);
  assert.deepEqual(t.both, []);
  assert.deepEqual(t.ai, []);
});

test("with only the AI pool funded, block production and VHP are irrelevant", () => {
  const t = pools({ ai: 100, producing: 0, both: 0 });
  assert.deepEqual(t.ai, ["ai-and-mines", "ai-only"]);
  assert.deepEqual(t.producing, []);
});

test("the pools overlap: doing both puts you in all three", () => {
  const t = pools({ ai: 10, producing: 20, both: 30 });
  // ai-and-mines qualifies for everything and is in every pool — the bonus is
  // on top of the two it already earns from, not instead of them.
  assert.deepEqual(t.both, ["ai-and-mines"]);
  assert.deepEqual(t.producing, ["produces-rich", "ai-and-mines"]);
  assert.deepEqual(t.ai, ["ai-and-mines", "ai-only"]);
  // produces-poor is below the minimum and on no roster: no pool at all.
  const all = [...t.both, ...t.producing, ...t.ai];
  assert.equal(all.includes("produces-poor"), false);
});

test("qualifying for one requirement never depends on the other", () => {
  // A producer's pool membership is identical whether or not the AI pools are
  // funded, which is what makes a roster outage cost producers nothing.
  const withAi = pools({ ai: 50, producing: 50, both: 0 });
  const withoutAi = pools({ ai: 0, producing: 50, both: 0 });
  assert.deepEqual(withAi.producing, withoutAi.producing);
});

test("a zero VHP minimum makes every producer count, stake unread", () => {
  const t = pools({ ai: 0, producing: 100, both: 0 }, "0");
  assert.deepEqual(t.producing, ["produces-rich", "produces-poor", "ai-and-mines"]);
});

test("exactly at the minimum VHP qualifies (>=, not >)", () => {
  assert.deepEqual(
    tiersFor({ producing: true, aiNode: false, vhpSat: KOIN(10000) },
      { minVhpSat: KOIN(10000), produceActive: true, aiActive: false }),
    ["producing"]
  );
  assert.deepEqual(
    tiersFor({ producing: true, aiNode: true, vhpSat: KOIN(10000) },
      { minVhpSat: KOIN(10000), produceActive: true, aiActive: true }),
    ["both", "producing", "ai"]
  );
});

test("an unreadable VHP balance is never assumed to meet the minimum", () => {
  const { tiers, rejected } = classifyCandidates(
    [{ address: "unknown", producing: true, aiNode: true, vhpSat: null }],
    { minVhpSat: KOIN(10000), produceActive: true, aiActive: false }
  );
  assert.deepEqual(tiers.producing, []);
  assert.equal(rejected.vhpUnknown, 1);
});

test("rejection reasons are tallied for the UI", () => {
  const { rejected } = classifyCandidates(CANDIDATES, {
    minVhpSat: KOIN(10000), produceActive: true, aiActive: false,
  });
  assert.equal(rejected.belowVhp, 1);     // produces-poor
  assert.equal(rejected.notProducing, 1); // ai-only
});

// ---------- cycle settlement ----------

const NO_CARRY = { both: "0", producing: "0", ai: "0" };
const ALL_TO_PRODUCERS = { ai: 0, producing: 100, both: 0 };

// Most scenarios below are about the split itself rather than about pools, so
// they fund one pool and put everyone in it. `credits` is { address: satoshis }.
const settleOne = (credits, extra = {}) =>
  settleCycle({
    periodVhpConsumedSat: "0",
    carry: NO_CARRY,
    credits: { both: {}, ai: {}, producing: credits },
    selfAddress: "SELF",
    minPayoutSat: KOIN(1),
    sharePct: ALL_TO_PRODUCERS,
    ...extra,
  });
// An equal-credit ledger, for the cases where the weighting isn't the point.
const flat = (addresses) => Object.fromEntries(addresses.map((a) => [a, KOIN(1)]));

test("the headline case: 100 KOIN profit over 10 nodes -> 10 KOIN each", () => {
  const s = settleOne(flat(Array.from({ length: 10 }, (_, i) => `N${i}`)), {
    periodRewardsSat: KOIN(1100), periodVhpConsumedSat: KOIN(1000),
  });
  assert.equal(s.reburnSat, KOIN(1000)); // restore the VHP that was consumed
  assert.equal(s.profitSat, KOIN(100));
  assert.equal(s.shareSat, KOIN(10));
  assert.equal(s.recipients.length, 10); // SELF not among them here
  assert.equal(s.carryOutSat, "0");
  assert.equal(s.keptSat, "0");          // 100% allocated, nothing left over
});

test("self counts for the split but keeps its share instead of a transfer", () => {
  const s = settleOne(flat(["A", "B", "SELF", "C", "D"]), {
    periodRewardsSat: KOIN(110), periodVhpConsumedSat: KOIN(100),
  });
  assert.equal(s.shareSat, KOIN(2)); // 10 profit / 5 nodes
  assert.equal(s.recipients.length, 4);
  assert.ok(!s.recipients.some((r) => r.address === "SELF"));
  assert.equal(s.selfKeptSat, KOIN(2));
  assert.equal(s.carryOutSat, "0");
});

test("integer split: the remainder carries to the next cycle", () => {
  const s = settleOne(flat(["A", "B", "C"]), {
    periodRewardsSat: KOIN(110), periodVhpConsumedSat: KOIN(100),
  });
  // 10 KOIN / 3 = 3.33333333 each, 1 sat left over
  assert.equal(s.shareSat, "333333333");
  assert.equal(s.carryOutSat, "1");
  assert.equal(s.carryOut.producing, "1"); // and it stays with the pool that earned it
});

test("share below the minimum payout -> the pool carries", () => {
  const s = settleOne(flat(["A", "B", "C"]), {
    periodRewardsSat: KOIN(101), periodVhpConsumedSat: KOIN(100), // 1 KOIN / 3 < 1 minimum
  });
  assert.equal(s.shareSat, "0");
  assert.equal(s.recipients.length, 0);
  assert.equal(s.carryOutSat, KOIN(1));
  assert.equal(s.reburnSat, KOIN(100)); // reburn still happens
});

test("a pool nobody was in is never allocated — its slice stays in the wallet", () => {
  // Carrying it instead would park money for a pool that may never fill,
  // growing a pool that can never be paid.
  const s = settleOne({}, { periodRewardsSat: KOIN(110), periodVhpConsumedSat: KOIN(100) });
  assert.equal(s.recipients.length, 0);
  assert.equal(s.carryOutSat, "0");
  assert.equal(s.keptSat, KOIN(10));
  assert.equal(s.reburnSat, KOIN(100));
});

test("carry from earlier cycles joins its own pool", () => {
  const s = settleOne(flat(["A", "B"]), {
    periodRewardsSat: KOIN(105), periodVhpConsumedSat: KOIN(100),
    carry: { ...NO_CARRY, producing: KOIN(5) },
  });
  assert.equal(s.poolSat, KOIN(10)); // 5 profit + 5 carried
  assert.equal(s.shareSat, KOIN(5));
});

test("negative period figures clamp to zero (fresh anchor edge cases)", () => {
  const s = settleOne(flat(["A"]), { periodRewardsSat: "-5", periodVhpConsumedSat: "-7" });
  assert.equal(s.reburnSat, "0");
  assert.equal(s.profitSat, "0");
  assert.equal(s.recipients.length, 0);
});

// ---------- percentage splits (reburn, three pools, the remainder) ----------

const ADDR = { ai: "1AiOnlyNode", vhp: "1ProducerNode", both: "1BothNode" };
// One address in each pool, each with the same credit, so the arithmetic on
// screen is exactly the configured percentages.
const threeGroups = (extra = {}) =>
  settleCycle({
    periodRewardsSat: KOIN(1100),
    periodVhpConsumedSat: KOIN(1000), // 100 KOIN profit
    carry: NO_CARRY,
    credits: {
      both: { [ADDR.both]: KOIN(1) },
      producing: { [ADDR.vhp]: KOIN(1) },
      ai: { [ADDR.ai]: KOIN(1) },
    },
    selfAddress: "SELF",
    minPayoutSat: "1",
    ...extra,
  });

test("each pool is paid its own percentage of the profit", () => {
  const s = threeGroups({ reburnPct: 40, sharePct: { ai: 10, producing: 20, both: 30 } });
  const paid = Object.fromEntries(s.recipients.map((r) => [r.address, r.amountSat]));
  assert.equal(paid[ADDR.ai], KOIN(10));
  assert.equal(paid[ADDR.vhp], KOIN(20));
  assert.equal(paid[ADDR.both], KOIN(30));
  // 40% of the profit is compounded, on top of restoring the VHP consumed.
  assert.equal(s.extraReburnSat, KOIN(40));
  assert.equal(s.levelReburnSat, KOIN(1000));
  assert.equal(s.reburnSat, KOIN(1040));
  assert.equal(s.keptSat, "0"); // 40+10+20+30 = 100%
});

test("what the percentages don't allocate simply stays in the wallet", () => {
  const s = threeGroups({ reburnPct: 25, sharePct: { ai: 5, producing: 10, both: 20 } });
  assert.equal(s.extraReburnSat, KOIN(25));
  assert.equal(s.tiers.ai.paidSat, KOIN(5));
  assert.equal(s.tiers.producing.paidSat, KOIN(10));
  assert.equal(s.tiers.both.paidSat, KOIN(20));
  assert.equal(s.keptSat, KOIN(40)); // the other 40% is never queued anywhere
  assert.equal(s.carryOutSat, "0");
});

test("a reburn of 100% distributes nothing and compounds the lot", () => {
  const s = threeGroups({ reburnPct: 100, sharePct: { ai: 0, producing: 0, both: 0 } });
  assert.equal(s.reburnSat, KOIN(1100)); // 1000 to stay level + 100 compounded
  assert.equal(s.recipients.length, 0);
  assert.equal(s.keptSat, "0");
});

test("with no percentages set at all the profit is simply kept", () => {
  const s = threeGroups({ reburnPct: 0, sharePct: { ai: 0, producing: 0, both: 0 } });
  assert.equal(s.reburnSat, KOIN(1000)); // VHP still restored
  assert.equal(s.recipients.length, 0);
  assert.equal(s.keptSat, KOIN(100));
});

test("one address in two pools is paid from both, in a single transfer", () => {
  // Producing all morning, then joining the AI roster, earns credit in two
  // pools. Both are owed; sending them separately would spend mana twice.
  const dual = "1DualNode";
  const s = settleCycle({
    periodRewardsSat: KOIN(100), periodVhpConsumedSat: "0",
    carry: NO_CARRY,
    credits: { both: { [dual]: KOIN(1) }, producing: { [dual]: KOIN(1) }, ai: {} },
    selfAddress: "SELF", minPayoutSat: "1",
    sharePct: { ai: 0, producing: 30, both: 50 },
  });
  assert.equal(s.recipients.length, 1);
  assert.equal(s.recipients[0].address, dual);
  assert.equal(s.recipients[0].amountSat, KOIN(80)); // 30% + 50%
  assert.equal(s.keptSat, KOIN(20));
});

test("a held pool is still allocated, and carries rather than being kept", () => {
  // The fail-closed guarantee: when the roster couldn't be read, the AI pools
  // pay nobody — but their share must not quietly become this node's profit.
  const s = settleCycle({
    periodRewardsSat: KOIN(100), periodVhpConsumedSat: "0",
    carry: NO_CARRY,
    credits: { both: {}, producing: { "1ProducerNode": KOIN(1) }, ai: {} },
    selfAddress: "SELF", minPayoutSat: "1",
    sharePct: { ai: 25, producing: 25, both: 25 },
    heldTiers: ["ai", "both"],
  });
  assert.equal(s.tiers.producing.paidSat, KOIN(25)); // the unaffected pool pays
  assert.equal(s.carryOut.ai, KOIN(25));       // held pools carry
  assert.equal(s.carryOut.both, KOIN(25));
  assert.equal(s.keptSat, KOIN(25));               // the unallocated quarter
});

// ---------- credit weighting (the anti-last-minute rule) ----------
//
// Every time this node collects a reward, each address qualifying at that
// moment is credited with it; shares are credit / that pool's total credit.

test("the worked example: A alone, then A and B -> 66% / 33%", () => {
  const R = KOIN(1); // one reward interval
  // Reward 1: only A qualifies. Reward 2: A and B both qualify.
  const s = settleOne({ A: (BigInt(R) * 2n).toString(), B: R }, {
    periodRewardsSat: KOIN(2), minPayoutSat: "1",
  });
  const paid = Object.fromEntries(s.recipients.map((r) => [r.address, r.amountSat]));
  // 2 KOIN pool, credits 2:1
  assert.equal(paid.A, "133333333"); // 66.6%
  assert.equal(paid.B, "66666666");  // 33.3%
});

test("the worked example continued: A leaves, C joins -> 40 / 40 / 20", () => {
  const R = BigInt(KOIN(1));
  // Three reward intervals. A: 1,2. B: 2,3. C: 3.
  const s = settleOne(
    { A: (R * 2n).toString(), B: (R * 2n).toString(), C: R.toString() },
    { periodRewardsSat: KOIN(3), minPayoutSat: "1" }
  );
  const paid = Object.fromEntries(s.recipients.map((r) => [r.address, r.amountSat]));
  assert.equal(paid.A, "120000000"); // 40% of 3 KOIN
  assert.equal(paid.B, "120000000"); // 40%
  assert.equal(paid.C, "60000000");  // 20%
});

test("a latecomer earns the rewards it was present for, not a full share", () => {
  const R = BigInt(KOIN(1));
  const s = settleOne(
    { allday: (R * 144n).toString(), latecomer: (R * 2n).toString() },
    { periodRewardsSat: KOIN(144), minPayoutSat: "1" }
  );
  const paid = Object.fromEntries(s.recipients.map((r) => [r.address, r.amountSat]));
  assert.equal(paid.allday, "14202739726");   // 144/146 of the pool
  assert.equal(paid.latecomer, "197260273");  // 2/146 — ~1.97 KOIN, not 72
});

test("even weighting still ignores credit and splits flat", () => {
  const s = settleOne({ allday: KOIN(144), latecomer: KOIN(2) }, {
    periodRewardsSat: KOIN(100), minPayoutSat: "1", weighting: "even",
  });
  const paid = Object.fromEntries(s.recipients.map((r) => [r.address, r.amountSat]));
  assert.equal(paid.allday, KOIN(50));
  assert.equal(paid.latecomer, KOIN(50));
});

test("a share below the minimum is skipped and carried, not dusted out", () => {
  // Paying dust is actively harmful: every payout spends mana 1:1.
  const s = settleOne({ steady: KOIN(144), blip: KOIN(1) }, { periodRewardsSat: KOIN(10) });
  assert.equal(s.recipients.length, 1);
  assert.equal(s.recipients[0].address, "steady");
  assert.equal(s.skippedBelowMin, 1);
  assert.ok(BigInt(s.carryOutSat) > 0n); // blip's slice rolls forward
});

test("a skipped node keeps its credit and is paid once it accumulates", () => {
  // The starvation case: a small or newly-joined node's share lands below the
  // minimum, so it is skipped — but the big node IS paid. If the skip also wiped
  // the small node's credit it would restart at zero every cycle and never cross
  // the minimum, while the share it earned quietly went to the big node.
  const s1 = settleOne({ big: KOIN(90), small: KOIN(10) }, {
    periodRewardsSat: KOIN(10), minPayoutSat: KOIN(2),
  });
  // big takes 9, small's 1 is under the 2 minimum -> skipped and carried.
  assert.deepEqual(s1.recipients.map((r) => r.address), ["big"]);
  assert.equal(s1.skippedBelowMin, 1);
  assert.deepEqual(s1.paidAddresses.producing, ["big"]); // ONLY big's credit is settled
  assert.equal(s1.carryOutSat, KOIN(1));

  // Next cycle: big's credit was cleared and re-earned, small's carried and grew.
  const s2 = settleOne({ big: KOIN(90), small: KOIN(20) }, {
    periodRewardsSat: KOIN(10), minPayoutSat: KOIN(2),
    carry: { ...NO_CARRY, producing: s1.carryOut.producing },
  });
  const paid = Object.fromEntries(s2.recipients.map((r) => [r.address, r.amountSat]));
  assert.ok(paid.small, "small must now be paid rather than skipped again");
  assert.equal(paid.small, "200000000"); // 20/110 of the 11 KOIN pool = 2 KOIN
  assert.deepEqual(s2.paidAddresses.producing.sort(), ["big", "small"]);
});

test("paidAddresses names exactly who settled, in which pool, self included", () => {
  const s = settleOne({ SELF: KOIN(50), other: KOIN(50) }, { periodRewardsSat: KOIN(10) });
  // SELF keeps its share rather than transferring, but its credit is still settled.
  assert.deepEqual(s.recipients.map((r) => r.address), ["other"]);
  assert.equal(s.selfKeptSat, KOIN(5));
  assert.deepEqual(s.paidAddresses.producing.sort(), ["SELF", "other"]);
});

test("credit of zero is not credit — the slice is never allocated", () => {
  const s = settleOne({ ghost: "0" }, {
    periodRewardsSat: KOIN(110), periodVhpConsumedSat: KOIN(100),
  });
  assert.equal(s.recipients.length, 0);
  assert.equal(s.keptSat, KOIN(10));
});

// ---------- what the Status panel previews ----------

test("previewSplit shows the same carve-up the cycle will make", () => {
  const cfg = { reburnPct: 40, sharePct: { ai: 10, producing: 20, both: 30 } };
  const p = previewSplit(KOIN(100), cfg);
  assert.equal(p.reburn, KOIN(40));
  assert.equal(p.tiers.ai.amount, KOIN(10));
  assert.equal(p.tiers.producing.amount, KOIN(20));
  assert.equal(p.tiers.both.amount, KOIN(30));
  assert.equal(p.keptPct, 0);
  const half = previewSplit(KOIN(100), { reburnPct: 10, sharePct: { ai: 0, producing: 40, both: 0 } });
  assert.equal(half.keptPct, 50);
  assert.equal(half.kept, KOIN(50));
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

test("engine: the reburn percentage compounds on top of restoring the VHP", async () => {
  const totals = { current: { rewards: KOIN(0), vhpConsumed: KOIN(0), blocks: 0 } };
  const world = makeWorld({
    totals,
    headers: [{ height: 1000, timestamp: 3, signer: A }],
    vhp: { [A]: KOIN(10000) },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
    cfg: { reburnPct: 40, sharePct: { ai: 0, producing: 60, both: 0 } },
  });
  await world.engine.tick("manual");
  totals.current = { rewards: KOIN(110), vhpConsumed: KOIN(100), blocks: 10 };

  const res = await world.engine.tick("manual", { forceClose: true });
  const rec = res.derived.lastDistribution;
  assert.equal(rec.profit, KOIN(10));
  assert.equal(rec.levelReburn, KOIN(100)); // what production consumed
  assert.equal(rec.extraReburn, KOIN(4));   // 40% of the profit, compounded
  assert.deepEqual(world.calls.burns, [KOIN(104)]);
  // The other 60% went out; nothing was left over to keep.
  assert.equal(world.calls.transfers.length, 1);
  assert.equal(world.calls.transfers[0].amountSat, KOIN(6));
  assert.equal(rec.kept, "0");
});

test("engine: unallocated percentage is kept — never burned, never sent", async () => {
  const totals = { current: { rewards: KOIN(0), vhpConsumed: KOIN(0), blocks: 0 } };
  const world = makeWorld({
    totals,
    headers: [{ height: 1000, timestamp: 3, signer: A }],
    vhp: { [A]: KOIN(10000) },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
    cfg: { reburnPct: 10, sharePct: { ai: 0, producing: 30, both: 0 } },
  });
  await world.engine.tick("manual");
  totals.current = { rewards: KOIN(110), vhpConsumed: KOIN(100), blocks: 10 };

  const res = await world.engine.tick("manual", { forceClose: true });
  const rec = res.derived.lastDistribution;
  assert.equal(rec.extraReburn, KOIN(1));
  assert.deepEqual(world.calls.burns, [KOIN(101)]);
  assert.equal(world.calls.transfers[0].amountSat, KOIN(3));
  assert.equal(rec.kept, KOIN(6));      // 60% simply stays in the wallet
  assert.equal(res.derived.carry, "0"); // and is NOT carried into next cycle
});

test("engine: doing both earns from all three pools, not instead of them", async () => {
  const totals = { current: { rewards: KOIN(0), vhpConsumed: KOIN(0), blocks: 0 } };
  const world = makeWorld({
    totals,
    headers: [
      { height: 999, timestamp: 2, signer: A },  // produces + on the roster -> both
      { height: 1000, timestamp: 3, signer: C }, // produces only            -> producing
    ],
    vhp: { [A]: KOIN(10000), [B]: "0", [C]: KOIN(10000) },
    balances: { koin: KOIN(5000), vhp: KOIN(15000), mana: KOIN(5000) },
    cfg: {
      reburnPct: 20,
      sharePct: { ai: 10, producing: 20, both: 50 },
      aiRosterUrl: "https://kai.example/workers",
    },
    roster: [A, B], // B serves AI without producing -> ai
  });
  await world.engine.tick("manual");
  totals.current = { rewards: KOIN(1100), vhpConsumed: KOIN(1000), blocks: 100 };

  const res = await world.engine.tick("manual", { forceClose: true });
  assert.equal(res.last.outcome, "cycle-closed");
  const paid = Object.fromEntries(world.calls.transfers.map((t) => [t.to, t.amountSat]));
  // 100 KOIN of profit. A produces AND serves AI, so it is in every pool:
  //   both      50% — A alone            -> 50
  //   producing 20% — A and C            -> 10 each
  //   ai        10% — A and B            -> 5 each
  assert.equal(paid[A], KOIN(65));
  assert.equal(paid[C], KOIN(10));
  assert.equal(paid[B], KOIN(5));
  assert.deepEqual(world.calls.burns, [KOIN(1020)]); // 1000 level + 20% compounded
  assert.equal(res.derived.lastDistribution.kept, "0");
  // One transfer each, even though A was paid out of three pools.
  assert.equal(world.calls.transfers.length, 3);
});

test("engine: a roster outage costs producers nothing", async () => {
  // Under overlapping pools the producing pool never depended on who else is
  // on the AI network, so an outage must not stall it — only the AI pools hold.
  const totals = { current: { rewards: KOIN(0), vhpConsumed: KOIN(0), blocks: 0 } };
  const world = makeWorld({
    totals,
    headers: [{ height: 1000, timestamp: 3, signer: A }],
    vhp: { [A]: KOIN(10000) },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
    cfg: {
      sharePct: { ai: 30, producing: 40, both: 30 },
      aiRosterUrl: "https://kai.example/workers",
    },
    roster: () => { throw new Error("roster offline"); },
  });
  await world.engine.tick("manual");
  totals.current = { rewards: KOIN(110), vhpConsumed: KOIN(100), blocks: 10 };

  const res = await world.engine.tick("manual", { forceClose: true });
  assert.equal(res.last.outcome, "cycle-held"); // the AI pools are held, and say so
  assert.equal(world.calls.transfers.length, 1);
  assert.equal(world.calls.transfers[0].to, A);
  assert.equal(world.calls.transfers[0].amountSat, KOIN(4)); // the producing 40%
  // The AI pools' 60% carried rather than being kept — an outage never turns
  // other people's share into this node's profit.
  assert.equal(res.derived.carry, KOIN(6));
  assert.equal(res.derived.lastDistribution.kept, "0");
  assert.deepEqual(world.calls.burns, [KOIN(100)]); // VHP still restored
});

test("engine: a pool with nobody in it doesn't hold up the others", async () => {
  const totals = { current: { rewards: KOIN(0), vhpConsumed: KOIN(0), blocks: 0 } };
  const world = makeWorld({
    totals,
    headers: [{ height: 1000, timestamp: 3, signer: A }], // producing only
    vhp: { [A]: KOIN(10000) },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
    cfg: {
      sharePct: { ai: 30, producing: 30, both: 30 },
      aiRosterUrl: "https://kai.example/workers",
    },
    roster: [], // nobody on the AI network at all
  });
  await world.engine.tick("manual");
  totals.current = { rewards: KOIN(110), vhpConsumed: KOIN(100), blocks: 10 };

  const res = await world.engine.tick("manual", { forceClose: true });
  const rec = res.derived.lastDistribution;
  assert.equal(world.calls.transfers.length, 1);
  assert.equal(world.calls.transfers[0].amountSat, KOIN(3)); // A's 30%
  // The two empty pools were never allocated, so their 60% stays put rather
  // than accumulating in a pool nobody can ever be paid from.
  assert.equal(rec.kept, KOIN(7)); // 60% unearned + the 10% never allocated
  assert.equal(res.derived.carry, "0");
});

test("engine: pre-0.7 state keeps its carry and credit through the upgrade", async () => {
  const totals = { current: { rewards: KOIN(100), vhpConsumed: KOIN(100), blocks: 10 } };
  const world = makeWorld({
    totals,
    headers: [{ height: 1000, timestamp: 3, signer: A }],
    vhp: { [A]: KOIN(10000) },
    balances: { koin: KOIN(500), vhp: KOIN(15000), mana: KOIN(400) },
    cfg: { requireVhpMinimum: true, requireAiNode: false }, // the old gates
  });
  // A cycle's worth of the old, single-pool state: one flat carry, one flat
  // credit ledger, both earned before the upgrade.
  world.state.set(`distribution.mainnet.${SELF}`, {
    anchor: { rewards: KOIN(100), vhpConsumed: KOIN(100) },
    cycleStartedAt: Date.now() - 1000,
    lastClosedAt: null,
    seen: {}, aiSeen: {}, ticks: 5,
    credits: { [A]: KOIN(1) },
    carry: KOIN(4),
    lastRewardTotal: KOIN(100),
    vhp: {}, vhpCheckedAt: 0,
    aiReads: { ok: 0, failed: 0, accepted: 0, rejected: 0, lastError: null },
    reburnOwed: "0", payouts: [], history: [], actions: [],
  });

  const res = await world.engine.tick("manual", { forceClose: true });
  assert.equal(res.last.outcome, "cycle-closed");
  // The carry and the credit both landed in the producing pool, so the money
  // earned under the old rules is paid to the address that earned it.
  assert.equal(world.calls.transfers.length, 1);
  assert.equal(world.calls.transfers[0].to, A);
  assert.equal(world.calls.transfers[0].amountSat, KOIN(4));
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
