"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { DAY_MS, dayKey, addBlockToDaily, pruneDaily, computeWindows, projectReturns } = require("../electron/lib/profit-metrics");

const now = 100 * DAY_MS + 43200000; // noon of day 100

test("dayKey floors a timestamp to its UTC day index", () => {
  assert.equal(dayKey(now), 100);
  assert.equal(dayKey(0), 0);
  assert.equal(dayKey(DAY_MS - 1), 0);
  assert.equal(dayKey(DAY_MS), 1);
});

test("addBlockToDaily accumulates block profit per day, ignores non-blocks", () => {
  const daily = {};
  addBlockToDaily(daily, { type: "block", time: now, profit: "100" });
  addBlockToDaily(daily, { type: "block", time: now - 3600000, profit: "50" }); // same day
  addBlockToDaily(daily, { type: "burn", time: now, amount: "999" }); // ignored
  addBlockToDaily(daily, null); // ignored
  assert.deepEqual(daily, { 100: "150" });
});

test("computeWindows: 24h from recent, 7d/30d from buckets, avg + span", () => {
  const daily = { 100: "100", 99: "200", 95: "300", 71: "400", 60: "500" };
  const recent = [
    { time: now - 3600000, profit: "50" }, // within 24h
    { time: now - 25 * 3600000, profit: "70" }, // outside 24h
  ];
  const w = computeWindows(daily, recent, now);
  assert.equal(w.last24h, "50");
  assert.equal(w.last7d, "600"); // days >= 94: 100+200+300
  assert.equal(w.last30d, "1000"); // days >= 71: 100+200+300+400 (day 60 excluded)
  assert.equal(w.daysTracked, 30); // span capped at 30
  assert.equal(w.avgDailyProfit, "33"); // 1000 / 30 (integer)
});

test("computeWindows on a young node divides by actual days tracked", () => {
  const daily = { 100: "300", 99: "300", 98: "300" }; // first bucket 2 days ago
  const w = computeWindows(daily, [], now);
  assert.equal(w.daysTracked, 3); // today..2-days-ago inclusive
  assert.equal(w.avgDailyProfit, "300"); // 900 / 3
});

test("computeWindows handles no history", () => {
  const w = computeWindows({}, [], now);
  assert.deepEqual(w, { last24h: "0", last7d: "0", last30d: "0", avgDailyProfit: "0", daysTracked: 0 });
});

test("pruneDaily drops buckets older than the retention window", () => {
  const daily = { [dayKey(now)]: "1", [dayKey(now) - 10]: "1", [dayKey(now) - 500]: "1" };
  pruneDaily(daily, now, 400);
  assert.deepEqual(Object.keys(daily).map(Number).sort((a, b) => a - b), [dayKey(now) - 10, dayKey(now)]);
});

test("projectReturns: simple APR against stake", () => {
  const r = projectReturns({ avgDailyProfitSats: "33", stakeSats: "1000000", reburnFraction: 0 });
  assert.equal(r.yearlyProfitSats, String(33 * 365));
  assert.ok(Math.abs(r.yearlyReturnPct - (33 * 365) / 1000000 * 100) < 1e-9);
  // reburn 0 → compounded equals simple
  assert.ok(Math.abs(r.yearlyReturnReburnPct - r.yearlyReturnPct) < 1e-9);
});

test("projectReturns: reburn compounding beats the simple rate", () => {
  const r = projectReturns({ avgDailyProfitSats: "33", stakeSats: "1000000", reburnFraction: 0.5 });
  assert.ok(r.yearlyReturnReburnPct > r.yearlyReturnPct, "compounding should exceed simple");
  assert.ok(r.yearlyReturnReburnPct < r.yearlyReturnPct * 1.05, "small daily yield → small compounding gap");
  assert.equal(r.reburnFraction, 0.5);
});

test("projectReturns: full reburn is standard compounding", () => {
  const avgDaily = 100, stake = 100000;
  const r = projectReturns({ avgDailyProfitSats: String(avgDaily), stakeSats: String(stake), reburnFraction: 1 });
  const expected = (Math.pow(1 + avgDaily / stake, 365) - 1) * 100;
  assert.ok(Math.abs(r.yearlyReturnReburnPct - expected) < 1e-9);
});

test("projectReturns: unknown stake → percentages null, KOIN still projected", () => {
  const r = projectReturns({ avgDailyProfitSats: "33", stakeSats: "0", reburnFraction: 0.5 });
  assert.equal(r.yearlyReturnPct, null);
  assert.equal(r.yearlyReturnReburnPct, null);
  assert.equal(r.yearlyProfitReburnSats, null);
  assert.equal(r.yearlyProfitSats, String(33 * 365)); // absolute projection still available
});
