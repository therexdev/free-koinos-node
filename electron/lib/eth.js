"use strict";

// Minimal Ethereum key/address helpers for the "Fund Node" flow. Phase 1 only
// needs a receiving address; ETH transaction signing (for the Vortex bridge)
// comes in Phase 2. secp256k1 and keccak256 are already available via koilib's
// dependency tree, so no new packages are added.

const secp = require("@noble/secp256k1");
const { keccak_256 } = require("@noble/hashes/sha3.js");
const { hmac } = require("@noble/hashes/hmac.js");
const { sha256 } = require("@noble/hashes/sha256.js");

// Order of the secp256k1 group; a valid private key is in [1, n-1].
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function hexToBytes(hex) {
  const clean = String(hex).replace(/^0x/i, "");
  if (clean.length === 0 || clean.length % 2 !== 0 || /[^0-9a-fA-F]/.test(clean)) {
    throw new Error("Invalid hex string");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function bytesToBigInt(bytes) {
  return BigInt("0x" + (bytesToHex(bytes) || "0"));
}

// EIP-55 mixed-case checksum encoding of a 20-byte address.
function toChecksumAddress(address) {
  const lower = String(address).replace(/^0x/i, "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error("Invalid Ethereum address");
  const hash = bytesToHex(keccak_256(Buffer.from(lower, "utf8")));
  let out = "0x";
  for (let i = 0; i < 40; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

function isValidAddress(address) {
  const s = String(address);
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) return false;
  const body = s.slice(2);
  // All-one-case is accepted (no checksum to verify); mixed-case must match.
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  try {
    return toChecksumAddress(s) === s;
  } catch {
    return false;
  }
}

// Ethereum address = last 20 bytes of keccak256(uncompressed pubkey without the
// 0x04 prefix), EIP-55 checksummed.
function privateKeyToAddress(privHex) {
  const clean = String(privHex).replace(/^0x/i, "");
  const pub = secp.getPublicKey(clean, false); // 65-byte uncompressed
  const hash = keccak_256(pub.slice(1));
  return toChecksumAddress(bytesToHex(hash.slice(-20)));
}

// Deterministically derive the wallet's Ethereum private key from its Koinos
// private key, so the single Koinos backup (WIF) also recovers the ETH funds —
// the user never has a second secret to write down. Domain-separated HMAC,
// validated against the curve order (re-hash on the astronomically rare
// out-of-range result). This is a KoinosKit-specific derivation, not BIP-44.
function deriveEthPrivateKey(koinosPrivHex) {
  const seed = hexToBytes(String(koinosPrivHex).replace(/^0x/i, "").padStart(64, "0"));
  let cur = hmac(sha256, seed, new TextEncoder().encode("koinoskit/eth/v1"));
  for (let i = 0; i < 1000; i++) {
    const k = bytesToBigInt(cur);
    if (k >= 1n && k < SECP256K1_N) return bytesToHex(cur);
    cur = hmac(sha256, seed, cur);
  }
  throw new Error("Could not derive an Ethereum key");
}

function deriveEthAddress(koinosPrivHex) {
  return privateKeyToAddress(deriveEthPrivateKey(koinosPrivHex));
}

// Format a wei amount (hex string "0x…", decimal string, or BigInt) as an ETH
// decimal string with up to maxDecimals places, trailing zeros trimmed.
function weiToEth(wei, maxDecimals = 6) {
  let v;
  if (typeof wei === "bigint") v = wei;
  else v = BigInt(String(wei == null ? 0 : wei).trim() || "0");
  const WEI = 10n ** 18n;
  const whole = v / WEI;
  const frac = v % WEI;
  if (maxDecimals <= 0) return whole.toString();
  const scale = 10n ** BigInt(maxDecimals);
  const fracStr = ((frac * scale) / WEI).toString().padStart(maxDecimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole.toString()}.${fracStr}` : whole.toString();
}

module.exports = {
  SECP256K1_N,
  toChecksumAddress,
  isValidAddress,
  privateKeyToAddress,
  deriveEthPrivateKey,
  deriveEthAddress,
  weiToEth,
};
