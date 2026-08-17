"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { Contract } = require("koilib");
const { POB_ABI, TOKEN_ABI, NETWORKS } = require("../electron/lib/constants");

// Entry points cross-checked against the deployed mainnet PoB contract
// (contract meta store, contract 159myq5YUhhoVWu3wsHKHiJYKPKGUrGiyv).
test("PoB ABI entry points match the deployed contract", () => {
  assert.equal(POB_ABI.methods.burn.entry_point, 0x859facc5);
  assert.equal(POB_ABI.methods.register_public_key.entry_point, 0x53192be1);
  assert.equal(POB_ABI.methods.get_public_key.entry_point, 0x96634f68);
  assert.equal(POB_ABI.methods.get_metadata.entry_point, 0xfcf7a68f);
  assert.equal(POB_ABI.methods.get_consensus_parameters.entry_point, 0x5fd7ac0f);
});

const ADDR = "1L62VUwpA28dkaZ5mHKGdLmrxeYduBFBBu";

function pobContract() {
  return new Contract({ id: NETWORKS.mainnet.contracts.pob, abi: POB_ABI });
}

test("burn operation serializes to the expected bytes", async () => {
  const op = await pobContract().encodeOperation({
    name: "burn",
    args: { token_amount: "12345678900", burn_address: ADDR, vhp_address: ADDR },
  });
  assert.equal(op.call_contract.contract_id, NETWORKS.mainnet.contracts.pob);
  assert.equal(op.call_contract.entry_point, 0x859facc5);
  assert.equal(
    op.call_contract.args,
    "CLS48P4tEhkA0V224ZZzlWPtvD_ll-qJUy_PJ9njXhCwGhkA0V224ZZzlWPtvD_ll-qJUy_PJ9njXhCw"
  );
});

test("register_public_key serializes producer + base64url key", async () => {
  const op = await pobContract().encodeOperation({
    name: "register_public_key",
    args: { producer: ADDR, public_key: "Aq4Ps_Ch-f8OZDnpQOov2SiMvdYyA5tn0oWa36QWnTeH" },
  });
  assert.equal(op.call_contract.entry_point, 0x53192be1);
  assert.equal(
    op.call_contract.args,
    "ChkA0V224ZZzlWPtvD_ll-qJUy_PJ9njXhCwEiECrg-z8KH5_w5kOelA6i_ZKIy91jIDm2fShZrfpBadN4c="
  );
});

test("token ABI matches the deployed KOIN contract", () => {
  assert.equal(TOKEN_ABI.methods.balance_of.entry_point, 0x5c721497);
  assert.equal(TOKEN_ABI.methods.transfer.entry_point, 0x27f576ca);
  assert.equal(TOKEN_ABI.methods.balance_of.read_only, true);
});

test("token transfer operation encodes and decodes", async () => {
  const koin = new Contract({ id: NETWORKS.mainnet.contracts.koin, abi: TOKEN_ABI });
  const args = { from: ADDR, to: "1FaSvLjQJsCJKq5ybmGsMMQs8RQYyVv8ju", value: "150000000" };
  const op = await koin.encodeOperation({ name: "transfer", args });
  assert.equal(op.call_contract.entry_point, 0x27f576ca);
  const dec = await koin.decodeOperation(op);
  assert.deepEqual(dec.args, args);
});

test("KCS-4 approve is present with the expected entry point", () => {
  assert.equal(TOKEN_ABI.methods.approve.entry_point, 1960973952);
  assert.equal(TOKEN_ABI.methods.allowance.read_only, true);
});

test("burn bundles approve + pob.burn in one transaction (KCS-4 flow)", async () => {
  const { Transaction, Signer } = require("koilib");
  const signer = Signer.fromSeed("burn tx test");
  const address = signer.getAddress();
  const pobId = NETWORKS.mainnet.contracts.pob;
  const koin = new Contract({ id: NETWORKS.mainnet.contracts.koin, abi: TOKEN_ABI, signer });
  const pob = new Contract({ id: pobId, abi: POB_ABI, signer });

  const tx = new Transaction({ signer });
  await tx.pushOperation(koin.functions.approve, { owner: address, spender: pobId, value: "500000000" });
  await tx.pushOperation(pob.functions.burn, {
    token_amount: "500000000",
    burn_address: address,
    vhp_address: address,
  });

  const ops = tx.transaction.operations;
  assert.equal(ops.length, 2);
  assert.equal(ops[0].call_contract.contract_id, NETWORKS.mainnet.contracts.koin);
  assert.equal(ops[0].call_contract.entry_point, 1960973952); // approve
  assert.equal(ops[1].call_contract.contract_id, pobId);
  assert.equal(ops[1].call_contract.entry_point, 0x859facc5); // pob.burn

  const approveArgs = await koin.decodeOperation(ops[0]);
  assert.deepEqual(approveArgs.args, { owner: address, spender: pobId, value: "500000000" });
});

test("burn operation decodes back to the original args", async () => {
  const c = pobContract();
  const op = await c.encodeOperation({
    name: "burn",
    args: { token_amount: "42", burn_address: ADDR, vhp_address: ADDR },
  });
  const dec = await c.decodeOperation(op);
  assert.equal(dec.name, "burn");
  assert.deepEqual(dec.args, { token_amount: "42", burn_address: ADDR, vhp_address: ADDR });
});
