"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Signer } = require("koilib");
const { WalletService } = require("../electron/lib/wallet");

function freshService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "knd-wallet-"));
  return new WalletService(dir);
}

test("create, lock, unlock roundtrip", () => {
  const w = freshService();
  assert.deepEqual(w.status(), { exists: false, unlocked: false, address: null, ethAddress: null, createdAt: null });

  const { address, ethAddress, wif } = w.create({ password: "pw12345678" });
  assert.equal(Signer.fromWif(wif).getAddress(), address);
  assert.equal(w.status().unlocked, true);
  assert.match(ethAddress, /^0x[0-9a-fA-F]{40}$/); // derived ETH address

  w.lock();
  assert.equal(w.status().unlocked, false);
  assert.equal(w.status().address, address); // address visible while locked
  assert.equal(w.status().ethAddress, ethAddress); // ETH address too (cached)

  // Same Koinos key must always derive the same ETH address.
  w.unlock("pw12345678");
  assert.equal(w.status().ethAddress, ethAddress);

  assert.throws(() => w.unlock("wrong password"), /Incorrect password/);
  w.unlock("pw12345678");
  assert.equal(w.status().unlocked, true);
  assert.equal(w.signer.getAddress(), address);
});

test("unlock backfills a derived ETH address for pre-Fund keystores", () => {
  const w = freshService();
  const { ethAddress } = w.create({ password: "pw12345678" });
  w.lock();

  // Simulate a wallet created before the Fund feature: strip ethAddress from disk.
  const ks = JSON.parse(fs.readFileSync(w.keystorePath, "utf8"));
  delete ks.ethAddress;
  fs.writeFileSync(w.keystorePath, JSON.stringify(ks));
  const w2 = new WalletService(path.dirname(w.keystorePath));
  assert.equal(w2.status().ethAddress, null); // absent while locked

  // Unlocking re-derives it (deterministically) and writes it back.
  const r = w2.unlock("pw12345678");
  assert.equal(r.ethAddress, ethAddress);
  assert.equal(w2.status().ethAddress, ethAddress);
  assert.equal(JSON.parse(fs.readFileSync(w.keystorePath, "utf8")).ethAddress, ethAddress);
});

test("import WIF preserves the address", () => {
  const seedSigner = Signer.fromSeed("wallet test seed");
  const wif = seedSigner.getPrivateKey("wif");
  const w = freshService();
  const { address } = w.importWif({ wif, password: "pw12345678" });
  assert.equal(address, seedSigner.getAddress());
  w.lock();
  w.unlock("pw12345678");
  assert.equal(w.signer.getAddress(), seedSigner.getAddress());
});

test("guards: weak password, invalid wif, existing wallet", () => {
  const w = freshService();
  assert.throws(() => w.create({ password: "short" }), /at least 8/);
  assert.throws(() => w.importWif({ wif: "garbage", password: "pw12345678" }), /Invalid private key/);
  w.create({ password: "pw12345678" });
  assert.throws(() => w.create({ password: "pw12345678" }), /already exists/);
  assert.throws(() => w.importWif({ wif: "x", password: "pw12345678" }), /already exists/);
});

test("revealWif requires the password even when unlocked", () => {
  const w = freshService();
  const { wif } = w.create({ password: "pw12345678" });
  assert.equal(w.revealWif("pw12345678").wif, wif);
  assert.throws(() => w.revealWif("nope-nope-nope"), /Incorrect password/);
});

test("remove needs password and typed confirmation", () => {
  const w = freshService();
  w.create({ password: "pw12345678" });
  assert.throws(() => w.remove({ password: "pw12345678", confirm: "nope" }), /REMOVE/);
  assert.throws(() => w.remove({ password: "wrong", confirm: "REMOVE" }), /Incorrect password/);
  w.remove({ password: "pw12345678", confirm: "REMOVE" });
  assert.equal(w.status().exists, false);
});
