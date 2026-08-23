"use strict";

// KOIN's USD price, read from the Uniswap v4 USDT/vKOIN pool on Ethereum.
//
// vKOIN is Vortex-bridged KOIN at 1:1, so its pool price IS the KOIN price.
// This is the same pool Route C swaps through when funding a node, so the
// dashboard values a node at the rate it could actually be traded at, rather
// than at a listing scraped from somewhere unrelated.
//
// The math is separated from the network call: everything below `koinUsdFrom`
// is pure and unit-tested, and only `fetchKoinUsd` touches Ethereum.

const { ethers } = require("ethers");
const RC = require("./route-constants");

const V4_QUOTER_ABI = [
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)) returns (uint256 amountOut,uint256 gasEstimate)",
];

// A quote is a trade, so it carries price impact: quote too much and the price
// reads high, too little and rounding dominates. 100 USDT is small enough to
// sit near spot on this pool and large enough to be precise.
const PROBE_USDT = 100n * 10n ** BigInt(RC.USDT_DECIMALS);
const CACHE_MS = 5 * 60 * 1000; // the dashboard refreshes every 5s; the pool does not
const KOIN_DECIMALS = 8;

// Absurd values mean a broken/manipulated read, not a moonshot. Refuse them
// rather than telling someone their node is worth a fortune.
const MIN_USD = 0.000001;
const MAX_USD = 10000;

// USD per KOIN from one swap quote. `usdtIn` is USDT base units (6dp) and
// `koinOut` is vKOIN satoshis (8dp). Returns a Number — this is a display
// estimate, never an amount that gets moved on-chain.
function koinUsdFrom({ usdtIn, koinOut }) {
  const usdt = BigInt(usdtIn);
  const koin = BigInt(koinOut);
  if (usdt <= 0n) throw new Error("USDT probe amount must be positive");
  if (koin <= 0n) throw new Error("Pool returned no vKOIN — no liquidity?");
  const usdtUnits = Number(usdt) / 10 ** RC.USDT_DECIMALS;
  const koinUnits = Number(koin) / 10 ** KOIN_DECIMALS;
  return usdtUnits / koinUnits;
}

// The mid price between an executable buy and an executable sell.
//
// A single buy quote is not the market price: it includes the pool's fee (1% on
// this pool) plus the price impact of the probe, so it reads HIGH — about 1.6%
// above a mid-price feed at a 100 USDT probe. Both costs are symmetric, so
// quoting in both directions and taking the geometric mean cancels them and
// lands on the mid. Geometric, not arithmetic: the costs are multiplicative.
function midPriceFrom({ buy, sell }) {
  const b = Number(buy);
  const s = Number(sell);
  if (!(b > 0) || !(s > 0)) throw new Error("both directions need a positive quote");
  return Math.sqrt(b * s);
}

function assertSaneUsd(usd) {
  if (!Number.isFinite(usd) || usd < MIN_USD || usd > MAX_USD) {
    throw new Error(`KOIN price out of plausible range (${usd})`);
  }
  return usd;
}

// Value a satoshi amount in USD. Satoshi strings in, Number out.
function valueUsd(sats, usdPerKoin) {
  if (usdPerKoin == null) return null;
  let v;
  try {
    v = BigInt(String(sats ?? "0"));
  } catch {
    return null;
  }
  return (Number(v) / 10 ** KOIN_DECIMALS) * usdPerKoin;
}

// What the node is worth and what it earns, in USD.
//   koinSats/vhpSats     — the balances that make up the node
//   avgDailyProfitSats   — the rolling daily profit rate the dashboard tracks
// Weekly and yearly are that same rate extended, NOT separate measurements:
// they are projections and are labelled as such in the UI.
function nodeValueUsd({ koinSats, vhpSats, avgDailyProfitSats, usdPerKoin }) {
  if (usdPerKoin == null) {
    return { usdPerKoin: null, koin: null, vhp: null, total: null, daily: null, weekly: null, yearly: null };
  }
  const koin = valueUsd(koinSats ?? "0", usdPerKoin);
  const vhp = valueUsd(vhpSats ?? "0", usdPerKoin);
  const daily = valueUsd(avgDailyProfitSats ?? "0", usdPerKoin);
  return {
    usdPerKoin,
    koin,
    vhp,
    total: koin + vhp,
    daily,
    weekly: daily * 7,
    yearly: daily * 365,
  };
}

// Quote the pool. Cached, because the dashboard polls far faster than a price
// moves and every call is an Ethereum RPC round-trip.
class KoinPrice {
  constructor({ makeProvider, probeUsdt = PROBE_USDT, cacheMs = CACHE_MS } = {}) {
    this.makeProvider = makeProvider;
    this.probeUsdt = BigInt(probeUsdt);
    this.cacheMs = cacheMs;
    this._cache = null; // { usd, at }
    this._inflight = null;
    this.lastError = null;
  }

  // Last known price without touching the network — safe on any hot path.
  cached() {
    if (!this._cache) return null;
    return { ...this._cache, stale: Date.now() - this._cache.at > this.cacheMs };
  }

  async get({ force = false } = {}) {
    const c = this._cache;
    if (!force && c && Date.now() - c.at < this.cacheMs) return { ...c, stale: false };
    if (this._inflight) return this._inflight;
    this._inflight = this._fetch()
      .then((r) => {
        this._cache = r;
        this.lastError = null;
        return { ...r, stale: false };
      })
      .catch((e) => {
        this.lastError = String(e?.message ?? e);
        // A failed refresh must not erase a good price — the dashboard keeps
        // showing the last one, flagged stale, instead of blanking out.
        return c ? { ...c, stale: true } : null;
      })
      .finally(() => {
        this._inflight = null;
      });
    return this._inflight;
  }

  async _fetch() {
    const provider = await this.makeProvider();
    const k = RC.VKOIN_USDT_POOL;
    const quoter = new ethers.Contract(RC.V4_QUOTER, V4_QUOTER_ABI, provider);
    const poolKey = {
      currency0: k.currency0,
      currency1: k.currency1,
      fee: k.fee,
      tickSpacing: k.tickSpacing,
      hooks: k.hooks,
    };
    const quote = async (zeroForOne, exactAmount) => {
      const r = await quoter.quoteExactInputSingle.staticCall({
        poolKey,
        zeroForOne,
        exactAmount,
        hookData: "0x",
      });
      return BigInt(r[0]);
    };

    // Buy: USDT in, vKOIN out. USDT is currency1, so zeroForOne = false.
    const koinOut = await quote(false, this.probeUsdt);
    const buy = koinUsdFrom({ usdtIn: this.probeUsdt, koinOut });

    // Sell the same vKOIN straight back for the other side of the spread. If
    // this leg fails we still have a usable (if slightly high) buy price, so
    // degrade to it rather than losing the reading entirely.
    let usd = buy;
    let method = "buy-only";
    try {
      const usdtBack = await quote(true, koinOut);
      const sell = koinUsdFrom({ usdtIn: usdtBack, koinOut });
      usd = midPriceFrom({ buy, sell });
      method = "mid";
    } catch {
      /* one-sided price it is */
    }

    return {
      usd: assertSaneUsd(usd),
      at: Date.now(),
      probeUsdt: this.probeUsdt.toString(),
      method,
      source: "uniswap-v4-usdt-vkoin",
    };
  }
}

module.exports = { KoinPrice, koinUsdFrom, midPriceFrom, valueUsd, nodeValueUsd, assertSaneUsd, PROBE_USDT, CACHE_MS };
