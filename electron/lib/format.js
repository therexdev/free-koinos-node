"use strict";

// BigInt-safe conversions between human amounts ("1.5") and satoshi strings
// ("150000000"). KOIN and VHP both use 8 decimals.

const DECIMALS = 8;
const ONE = 10n ** BigInt(DECIMALS);

function parseAmount(input) {
  const s = String(input ?? "").trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`Invalid amount: "${input}"`);
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > DECIMALS) {
    throw new Error(`Amount has more than ${DECIMALS} decimal places`);
  }
  const sats = BigInt(whole) * ONE + BigInt(frac.padEnd(DECIMALS, "0") || "0");
  return sats.toString();
}

function formatAmount(sats, { grouping = true, maxDecimals = DECIMALS } = {}) {
  let v;
  try {
    v = BigInt(String(sats ?? "0"));
  } catch {
    return "0";
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const whole = v / ONE;
  let frac = (v % ONE).toString().padStart(DECIMALS, "0");
  frac = frac.slice(0, maxDecimals).replace(/0+$/, "");
  const wholeStr = grouping
    ? whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
    : whole.toString();
  return `${neg ? "-" : ""}${wholeStr}${frac ? "." + frac : ""}`;
}

// pct may be fractional (e.g. 12.5). Uses basis points internally.
function percentOf(satsStr, pct) {
  const p = Number(pct);
  if (!Number.isFinite(p) || p < 0 || p > 100) {
    throw new Error(`Invalid percentage: ${pct}`);
  }
  const bp = BigInt(Math.round(p * 100));
  return ((BigInt(satsStr) * bp) / 10000n).toString();
}

function addSats(a, b) {
  return (BigInt(a) + BigInt(b)).toString();
}

function subSats(a, b) {
  return (BigInt(a) - BigInt(b)).toString();
}

function cmpSats(a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

module.exports = {
  DECIMALS,
  parseAmount,
  formatAmount,
  percentOf,
  addSats,
  subSats,
  cmpSats,
};
