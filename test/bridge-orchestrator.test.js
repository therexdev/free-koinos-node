"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { nextAction, MAX_BRIDGE_ETH } = require("../electron/lib/bridge-orchestrator");

test("nextAction maps an active status to the next driver step", () => {
  assert.equal(nextAction("awaiting_signatures"), "poll");
  assert.equal(nextAction("redeeming"), "redeem");
  assert.equal(nextAction("swapping"), "swap");
});

test("nextAction returns 'none' for terminal / non-drivable states", () => {
  for (const s of ["idle", "depositing", "done", "error", undefined, null, "bogus"]) {
    assert.equal(nextAction(s), "none");
  }
});

test("bridge is capped to a small amount", () => {
  assert.ok(Number(MAX_BRIDGE_ETH) > 0 && Number(MAX_BRIDGE_ETH) <= 0.05);
});
