"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { recordToRedeemArgs } = require("../electron/lib/koinos-bridge");

const full = {
  id: "0xabc123",
  koinosToken: "1Tf1QKv3gVYLjq34yURSHw5ErTYbFjqTG",
  relayer: "",
  recipient: "1CZ4AV3jbGB7fi9bqarouyquFQ94DpLsqi",
  amount: "100000000",
  payment: "0",
  metadata: "",
  signatures: ["c2ln1", "c2ln2"],
  expiration: "1754700000000",
};

test("recordToRedeemArgs maps proxy fields to complete_transfer args", () => {
  const a = recordToRedeemArgs(full);
  assert.equal(a.transactionId, "0xabc123");
  assert.equal(a.token, "1Tf1QKv3gVYLjq34yURSHw5ErTYbFjqTG");
  assert.equal(a.recipient, "1CZ4AV3jbGB7fi9bqarouyquFQ94DpLsqi");
  assert.equal(a.value, "100000000");
  assert.equal(a.payment, "0");
  assert.deepEqual(a.signatures, ["c2ln1", "c2ln2"]);
  assert.equal(a.expiration, "1754700000000");
});

test("recordToRedeemArgs defaults optionals and coerces numbers to strings", () => {
  const a = recordToRedeemArgs({
    id: "x",
    koinosToken: "t",
    recipient: "r",
    amount: 5, // number
    signatures: ["s"],
    expiration: 9, // number
  });
  assert.equal(a.relayer, "");
  assert.equal(a.payment, "0");
  assert.equal(a.metadata, "");
  assert.equal(a.value, "5");
  assert.equal(a.expiration, "9");
});

test("recordToRedeemArgs rejects incomplete records", () => {
  assert.throws(() => recordToRedeemArgs(null), /Missing bridge record/);
  assert.throws(() => recordToRedeemArgs({ id: "x" }), /recipient/);
  assert.throws(() => recordToRedeemArgs({ id: "x", recipient: "r" }), /koinosToken/);
  assert.throws(
    () => recordToRedeemArgs({ id: "x", recipient: "r", koinosToken: "t", signatures: [] }),
    /no signatures/
  );
});
