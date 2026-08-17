"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  toChecksumAddress,
  isValidAddress,
  privateKeyToAddress,
  deriveEthPrivateKey,
  deriveEthAddress,
  weiToEth,
} = require("../electron/lib/eth");

test("privateKeyToAddress matches canonical Ethereum test vectors", () => {
  assert.equal(
    privateKeyToAddress("0000000000000000000000000000000000000000000000000000000000000001"),
    "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
  );
  assert.equal(
    privateKeyToAddress("0x0000000000000000000000000000000000000000000000000000000000000002"),
    "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF"
  );
});

test("toChecksumAddress produces EIP-55 casing (spec vectors)", () => {
  for (const a of [
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ]) {
    assert.equal(toChecksumAddress(a.toLowerCase()), a);
    assert.equal(toChecksumAddress(a), a); // idempotent
  }
});

test("isValidAddress accepts valid, rejects bad checksums and shapes", () => {
  assert.ok(isValidAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed"));
  assert.ok(isValidAddress("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed")); // all-lower ok
  // Flip one letter's case -> invalid EIP-55 checksum.
  assert.ok(!isValidAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"));
  assert.ok(!isValidAddress("0x1234")); // too short
  assert.ok(!isValidAddress("not-an-address"));
});

test("deriveEthPrivateKey is deterministic and a valid scalar", () => {
  const koinosPriv = "1".repeat(64);
  const a = deriveEthPrivateKey(koinosPriv);
  const b = deriveEthPrivateKey(koinosPriv);
  assert.equal(a, b); // deterministic
  assert.match(a, /^[0-9a-f]{64}$/);
  const k = BigInt("0x" + a);
  assert.ok(k >= 1n && k < BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141"));
});

test("deriveEthAddress: different Koinos keys give different ETH addresses", () => {
  const addr1 = deriveEthAddress("1".repeat(64));
  const addr2 = deriveEthAddress("2".repeat(64));
  assert.ok(isValidAddress(addr1));
  assert.ok(isValidAddress(addr2));
  assert.notEqual(addr1, addr2);
});

test("deriveEthAddress ignores 0x prefix / matches padded form", () => {
  assert.equal(deriveEthAddress("0x" + "ab".repeat(32)), deriveEthAddress("ab".repeat(32)));
});

test("weiToEth formats hex/decimal/bigint wei correctly", () => {
  assert.equal(weiToEth("0x0"), "0");
  assert.equal(weiToEth(0n), "0");
  assert.equal(weiToEth("1500000000000000000"), "1.5"); // 1.5 ETH
  assert.equal(weiToEth("0x2c68af0bb140000"), "0.2"); // 0.2 ETH in hex
  assert.equal(weiToEth("12300000000000000"), "0.0123"); // trims trailing zeros
  assert.equal(weiToEth("1000000000000000000"), "1"); // whole number, no decimals
  assert.equal(weiToEth(1n), "0"); // 1 wei rounds to 0 at 6 decimals
  assert.equal(weiToEth("1000000000000", 9), "0.000001"); // custom precision
});
