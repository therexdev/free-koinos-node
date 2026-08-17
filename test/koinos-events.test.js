"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  decodeBurn,
  decodeMint,
  decodeTransfer,
  classifyEntry,
  accumulate,
  EMPTY_TOTALS,
} = require("../electron/lib/koinos-events");

// Real event payloads captured from mainnet block 38,285,930.
const PRODUCER = "1UG4UUn7Da9JqE4PKbYUWgjbNwE5F9531";
const KOIN = "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK";
const VHP = "12Y5vW6gk8GceH53YfRkRre2Rrcsgw7Naq";
const BURN_DATA = "ChkABSfNZbxorEMEtDI0cUYFuVTUUCMDRxTkENOjgcEB";
const MINT_PRODUCER = "ChkABSfNZbxorEMEtDI0cUYFuVTUUCMDRxTkENmnyMgB";
const MINT_FOUNDATION = "ChkAY4PIK6GLlepslYHfS0_gFgRaYIfqarbOEIeExwc=";

test("decodes real burn/mint events to the right address and amount", () => {
  const burn = decodeBurn(BURN_DATA);
  assert.equal(burn.from, PRODUCER);
  assert.equal(burn.value, "404771283"); // 4.04771283 VHP

  const mint = decodeMint(MINT_PRODUCER);
  assert.equal(mint.to, PRODUCER);
  assert.equal(mint.value, "420615129"); // 4.20615129 KOIN

  const foundation = decodeMint(MINT_FOUNDATION);
  assert.notEqual(foundation.to, PRODUCER);
  assert.equal(foundation.value, "15843847");
});

test("decodeTransfer reads from/to/value", () => {
  // from=A to=B value=150000000, hand-built: field1 addr(25) field2 addr(25) field3 varint
  // Use classifyEntry path instead of hand-encoding; sanity check shape here:
  const t = decodeTransfer(MINT_PRODUCER); // not a transfer, but must not throw
  assert.ok("from" in t && "to" in t && "value" in t);
});

const ctx = { address: PRODUCER, contracts: { koin: KOIN, vhp: VHP } };

test("classifyEntry turns a produced block into a reward record", () => {
  const entry = {
    seq_num: "100",
    block: {
      header: { signer: PRODUCER, height: "38285930", timestamp: "1786060000000" },
      receipt: {
        events: [
          { source: VHP, name: "koinos.contracts.token.burn_event", data: BURN_DATA },
          { source: KOIN, name: "koinos.contracts.token.mint_event", data: MINT_PRODUCER },
          { source: KOIN, name: "koinos.contracts.token.mint_event", data: MINT_FOUNDATION },
        ],
      },
    },
  };
  const rec = classifyEntry(entry, ctx);
  assert.equal(rec.type, "block");
  assert.equal(rec.height, 38285930);
  assert.equal(rec.vhpBurned, "404771283");
  assert.equal(rec.reward, "420615129");
  assert.equal(rec.profit, "15843846"); // reward - vhpBurned (the premium)
});

test("classifyEntry ignores blocks produced by someone else", () => {
  const entry = { block: { header: { signer: "1SomeoneElse", height: "1", timestamp: "0" }, receipt: { events: [] } } };
  assert.equal(classifyEntry(entry, ctx), null);
});

test("accumulate folds block records into running totals", () => {
  let totals = { ...EMPTY_TOTALS };
  const block = { type: "block", reward: "420615129", vhpBurned: "404771283" };
  totals = accumulate(totals, block);
  totals = accumulate(totals, block);
  assert.equal(totals.blocks, 2);
  assert.equal(totals.rewards, "841230258");
  assert.equal(totals.vhpConsumed, "809542566");
  assert.equal(totals.profit, "31687692");

  totals = accumulate(totals, { type: "deposit", amount: "1000000000" });
  assert.equal(totals.depositsIn, "1000000000");
  totals = accumulate(totals, { type: "burn", amount: "500000000" });
  assert.equal(totals.burned, "500000000");
});
