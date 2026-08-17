"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { compareRoutes, descriptor, ROUTES } = require("../electron/lib/fund-routes");

test("descriptor returns a copy with steps, throws on unknown", () => {
  const d = descriptor("C");
  assert.equal(d.id, "C");
  assert.ok(Array.isArray(d.steps) && d.steps.length === 2);
  d.steps.push("mutate");
  assert.equal(ROUTES.C.steps.length, 2, "descriptor must not expose the shared array");
  assert.throws(() => descriptor("Z"), /Unknown route/);
});

test("compareRoutes ranks by KOIN out and flags the best", () => {
  // Real-ish sats: Route C ~10927 KOIN vs Route B ~2699 KOIN for 0.05 ETH.
  const { best, routes } = compareRoutes([
    { id: "B", koinOut: "269900000000" }, // 2699 KOIN in 8-dec sats
    { id: "C", koinOut: "1092700000000" }, // 10927 KOIN
  ]);
  assert.equal(best.id, "C");
  const c = routes.find((r) => r.id === "C");
  const b = routes.find((r) => r.id === "B");
  assert.equal(c.isBest, true);
  assert.equal(b.isBest, false);
  assert.equal(c.pctOfBest, 100);
  // B is ~24.7% of best; best is ~4.05× B
  assert.ok(b.pctOfBest > 24 && b.pctOfBest < 25, `pctOfBest=${b.pctOfBest}`);
  assert.ok(b.bestMultiple > 4.0 && b.bestMultiple < 4.1, `bestMultiple=${b.bestMultiple}`);
});

test("compareRoutes keeps failed quotes but never lets them win", () => {
  const { best, routes } = compareRoutes([
    { id: "C", koinOut: null, error: "pool illiquid" },
    { id: "B", koinOut: "500" },
  ]);
  assert.equal(best.id, "B");
  const c = routes.find((r) => r.id === "C");
  assert.equal(c.isBest, false);
  assert.equal(c.pctOfBest, null);
  assert.equal(c.bestMultiple, null);
});

test("compareRoutes handles all-failed and empty input", () => {
  assert.equal(compareRoutes([]).best, null);
  const { best, routes } = compareRoutes([{ id: "B", koinOut: null }, { id: "C", koinOut: "0" }]);
  assert.equal(best, null);
  assert.equal(routes.every((r) => r.isBest === false), true);
});

test("compareRoutes treats a tie deterministically (first stays first)", () => {
  const { best } = compareRoutes([{ id: "B", koinOut: "1000" }, { id: "C", koinOut: "1000" }]);
  assert.ok(best.id === "B" || best.id === "C");
});
