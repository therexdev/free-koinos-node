"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { computeReturn, validateRewardsConfig } = require("../electron/lib/rewards");

const KOIN = (n) => String(BigInt(n) * 100000000n);
const base = { pct: 80, minReturnSat: KOIN(1), availableLiquidSat: KOIN(1000) };

test("no rewards yet -> accumulate nothing", () => {
  const p = computeReturn({ rewardsSinceEnable: "0", returnedSoFar: "0", ...base });
  assert.equal(p.action, "accumulate");
  assert.equal(p.returnAmount, "0");
});

test("returns the configured percentage of real rewards", () => {
  const p = computeReturn({ rewardsSinceEnable: KOIN(10), returnedSoFar: "0", ...base });
  assert.equal(p.action, "return");
  assert.equal(p.desired, KOIN(8)); // 80% of 10
  assert.equal(p.returnAmount, KOIN(8));
});

test("only the not-yet-returned remainder is returned", () => {
  // 10 KOIN rewards, 80% target = 8, already returned 5 -> return 3 more
  const p = computeReturn({ rewardsSinceEnable: KOIN(10), returnedSoFar: KOIN(5), ...base });
  assert.equal(p.action, "return");
  assert.equal(p.pending, KOIN(3));
  assert.equal(p.returnAmount, KOIN(3));
});

test("once caught up to target, nothing pending", () => {
  const p = computeReturn({ rewardsSinceEnable: KOIN(10), returnedSoFar: KOIN(8), ...base });
  assert.equal(p.action, "accumulate");
  assert.equal(p.pending, "0");
});

test("small rewards accumulate below the minimum", () => {
  const p = computeReturn({ rewardsSinceEnable: KOIN(1), returnedSoFar: "0", pct: 50, minReturnSat: KOIN(1), availableLiquidSat: KOIN(100) });
  assert.equal(p.action, "accumulate"); // 50% of 1 = 0.5 < 1
});

test("return is capped by available liquid above the mana buffer", () => {
  const p = computeReturn({ rewardsSinceEnable: KOIN(10), returnedSoFar: "0", pct: 80, minReturnSat: KOIN(1), availableLiquidSat: KOIN(5) });
  assert.equal(p.action, "return");
  assert.equal(p.pending, KOIN(8));
  assert.equal(p.returnAmount, KOIN(5)); // capped
  assert.equal(p.limitedBy, "liquid");
});

test("too little liquid to meet the minimum -> insufficient-liquid", () => {
  const p = computeReturn({ rewardsSinceEnable: KOIN(10), returnedSoFar: "0", pct: 80, minReturnSat: KOIN(1), availableLiquidSat: "50000000" });
  assert.equal(p.action, "insufficient-liquid");
  assert.equal(p.returnAmount, "0");
});

test("return is capped by available mana (burning spends mana 1:1)", () => {
  // 8 pending, plenty of liquid, but only 3 KOIN of mana free right now.
  const p = computeReturn({
    rewardsSinceEnable: KOIN(10), returnedSoFar: "0", pct: 80,
    minReturnSat: KOIN(1), availableLiquidSat: KOIN(1000), availableManaSat: KOIN(3),
  });
  assert.equal(p.action, "return");
  assert.equal(p.pending, KOIN(8));
  assert.equal(p.returnAmount, KOIN(3)); // mana-limited chunk
  assert.equal(p.limitedBy, "mana");
});

test("too little mana to meet the minimum -> insufficient-mana", () => {
  // This is the real bug: balance is there, but mana is depleted from prior burns.
  const p = computeReturn({
    rewardsSinceEnable: KOIN(500), returnedSoFar: "0", pct: 97,
    minReturnSat: KOIN(10), availableLiquidSat: KOIN(1000), availableManaSat: KOIN(4),
  });
  assert.equal(p.action, "insufficient-mana");
  assert.equal(p.returnAmount, "0");
  assert.equal(p.capped, KOIN(4));
  assert.equal(p.limitedBy, "mana");
});

test("max-per-return chunks a large pending amount", () => {
  const p = computeReturn({
    rewardsSinceEnable: KOIN(500), returnedSoFar: "0", pct: 100,
    minReturnSat: KOIN(1), availableLiquidSat: KOIN(1000), availableManaSat: KOIN(1000),
    maxReturnSat: KOIN(50),
  });
  assert.equal(p.action, "return");
  assert.equal(p.pending, KOIN(500));
  assert.equal(p.returnAmount, KOIN(50)); // one 50-KOIN chunk
  assert.equal(p.limitedBy, "max-per-return");
});

test("mana overrides a larger max-per-return cap", () => {
  const p = computeReturn({
    rewardsSinceEnable: KOIN(500), returnedSoFar: "0", pct: 100,
    minReturnSat: KOIN(1), availableLiquidSat: KOIN(1000), availableManaSat: KOIN(20),
    maxReturnSat: KOIN(50),
  });
  assert.equal(p.action, "return");
  assert.equal(p.returnAmount, KOIN(20)); // mana is the tighter bound
  assert.equal(p.limitedBy, "mana");
});

test("0% never returns", () => {
  const p = computeReturn({ rewardsSinceEnable: KOIN(100), returnedSoFar: "0", pct: 0, minReturnSat: KOIN(1), availableLiquidSat: KOIN(1000) });
  assert.equal(p.action, "accumulate");
});

test("deposits/burns can't inflate rewards (returnable clamps at 0)", () => {
  const p = computeReturn({ rewardsSinceEnable: "-500000000", returnedSoFar: "0", ...base });
  assert.equal(p.action, "accumulate");
  assert.equal(p.returnAmount, "0");
});

test("validateRewardsConfig normalizes and rejects bad values", () => {
  const cfg = validateRewardsConfig({
    enabled: 1, pct: "25", mode: "burn", toAddress: null, minReturnKoin: "2", maxReturnKoin: "50", pollMinutes: "15",
  });
  assert.deepEqual(cfg, {
    enabled: true, pct: 25, mode: "burn", toAddress: "", minReturnKoin: "2", maxReturnKoin: "50", pollMinutes: 15,
  });
  // maxReturnKoin defaults to "0" (no cap) and accepts blank/zero as "no cap".
  const noCap = validateRewardsConfig({ pct: 10, mode: "burn", minReturnKoin: "1", pollMinutes: 10 });
  assert.equal(noCap.maxReturnKoin, "0");
  assert.equal(validateRewardsConfig({ pct: 10, mode: "burn", minReturnKoin: "1", maxReturnKoin: "", pollMinutes: 10 }).maxReturnKoin, "0");
  assert.throws(() => validateRewardsConfig({ pct: 101, mode: "burn", minReturnKoin: "1", pollMinutes: 10 }), /percentage/);
  assert.throws(() => validateRewardsConfig({ pct: 10, mode: "yeet", minReturnKoin: "1", pollMinutes: 10 }), /mode/);
  assert.throws(() => validateRewardsConfig({ pct: 10, mode: "send", minReturnKoin: "1", pollMinutes: 0 }), /interval/);
  assert.throws(() => validateRewardsConfig({ pct: 10, mode: "burn", minReturnKoin: "x", pollMinutes: 10 }), /Invalid amount/);
  assert.throws(() => validateRewardsConfig({ pct: 10, mode: "burn", minReturnKoin: "1", maxReturnKoin: "abc", pollMinutes: 10 }), /Invalid amount/);
  // A set max below the minimum is a contradiction and is rejected.
  assert.throws(() => validateRewardsConfig({ pct: 10, mode: "burn", minReturnKoin: "10", maxReturnKoin: "5", pollMinutes: 10 }), /at least the minimum/);
});
