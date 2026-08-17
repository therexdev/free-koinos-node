"use strict";

// Compares the funding routes and picks the one that yields the most KOIN for a
// given ETH input, so the app can route through the best and show the runners-up.
//
//   Route B: ETH → Vortex (vETH) → KoinDX (vETH/KOIN) → KOIN
//   Route C: ETH → USDT → vKOIN (Uniswap v4) → Vortex → KOIN
//
// This file is PURE (no network): callers quote each route however they like and
// pass the results in. Keeping the ranking pure makes it trivially testable and
// keeps the money-moving quote calls out of the comparison logic.

// Static descriptors the UI renders. `koinOut`/`koinOutMin` (vKOIN|KOIN
// satoshis, 8-dec) are filled in by the caller after quoting.
const ROUTES = {
  B: {
    id: "B",
    label: "Bridge ETH, swap on KoinDX",
    steps: ["Bridge ETH → vETH (Vortex)", "Swap vETH → KOIN (KoinDX)"],
    note: "The original path. KOIN comes from KoinDX's shallow vETH/KOIN pool.",
  },
  C: {
    id: "C",
    label: "Swap to vKOIN, bridge to KOIN",
    steps: ["Swap ETH → USDT → vKOIN (Uniswap)", "Bridge vKOIN → KOIN (Vortex, 1:1)"],
    note: "Uses the deeper vKOIN/USDT market, so usually far more KOIN per ETH.",
  },
};

function descriptor(id) {
  const d = ROUTES[id];
  if (!d) throw new Error(`Unknown route ${id}`);
  return { ...d, steps: [...d.steps] };
}

// Pure ranking. Takes an array of route quotes:
//   { id, koinOut (string sats | null), koinOutMin?, executable?, error?, ... }
// Sorts the successfully-quoted ones by KOIN out (desc), flags the winner, and
// annotates every route with how it compares to the best (percent of best, and
// how much more the best yields than this one). Failed quotes (koinOut null) keep
// their place but never win. Returns { best, routes }.
function compareRoutes(quotes) {
  const list = Array.isArray(quotes) ? quotes : [];
  const quoted = list.filter((r) => r && r.koinOut != null && safeBig(r.koinOut) > 0n);
  quoted.sort((a, b) => cmpBig(safeBig(b.koinOut), safeBig(a.koinOut)));
  const best = quoted[0] || null;
  const bestKoin = best ? safeBig(best.koinOut) : 0n;

  const routes = list.map((r) => {
    if (!r) return r;
    const has = r.koinOut != null && safeBig(r.koinOut) > 0n;
    const isBest = !!(best && has && r.id === best.id);
    let pctOfBest = null; // this route's KOIN as a % of the best (100 = best)
    let bestMultiple = null; // how many× more the best yields than this route
    if (has && bestKoin > 0n) {
      const mine = safeBig(r.koinOut);
      pctOfBest = Number((mine * 10000n) / bestKoin) / 100;
      bestMultiple = Number((bestKoin * 1000n) / mine) / 1000;
    }
    return { ...r, isBest, pctOfBest, bestMultiple };
  });

  return { best, routes };
}

function safeBig(v) {
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}
function cmpBig(a, b) {
  return a > b ? 1 : a < b ? -1 : 0;
}

module.exports = { ROUTES, descriptor, compareRoutes };
