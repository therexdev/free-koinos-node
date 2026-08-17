"use strict";

// Uniswap swap for Route C: ETH → USDT (v3) → vKOIN (v4). vKOIN is 1:1 with KOIN,
// so the vKOIN amount out IS the KOIN you'll receive after bridging. This module
// has the READ-ONLY quoting; the money-moving execution lives in eth-swap-exec.js
// so the signing code stays small and separately reviewable.

const { ethers } = require("ethers");
const RC = require("./route-constants");
const { makeProvider } = require("./eth-bridge");

const V3_QUOTER_ABI = [
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96)) returns (uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
];
const V4_QUOTER_ABI = [
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData)) returns (uint256 amountOut,uint256 gasEstimate)",
];

// Reduce an amount by a slippage tolerance (basis points) to a floor.
function applySlippage(amount, slippageBps) {
  const a = BigInt(amount);
  const bps = BigInt(slippageBps);
  if (bps < 0n || bps >= 10000n) throw new Error("slippage out of range");
  return (a * (10000n - bps)) / 10000n;
}

// Best WETH→USDT quote across the candidate fee tiers. Returns { usdt, fee } or
// throws if no tier has liquidity.
async function quoteEthToUsdt(quoter, amountWei) {
  let best = 0n;
  let bestFee = null;
  for (const fee of RC.ETH_USDT_FEES) {
    try {
      const r = await quoter.quoteExactInputSingle.staticCall({
        tokenIn: RC.WETH, tokenOut: RC.USDT, amountIn: amountWei, fee, sqrtPriceLimitX96: 0,
      });
      if (r[0] > best) { best = r[0]; bestFee = fee; }
    } catch {
      /* tier has no pool/liquidity — skip */
    }
  }
  if (best <= 0n || bestFee == null) throw new Error("No ETH→USDT liquidity");
  return { usdt: best, fee: bestFee };
}

// USDT→vKOIN quote through the v4 pool. USDT is currency1, so zeroForOne=false.
async function quoteUsdtToVkoin(quoter, usdtAmount) {
  const k = RC.VKOIN_USDT_POOL;
  const r = await quoter.quoteExactInputSingle.staticCall({
    poolKey: { currency0: k.currency0, currency1: k.currency1, fee: k.fee, tickSpacing: k.tickSpacing, hooks: k.hooks },
    zeroForOne: false,
    exactAmount: usdtAmount,
    hookData: "0x",
  });
  return r[0];
}

// Full read-only quote for ETH → USDT → vKOIN (== KOIN, 1:1). Never signs.
// Returns amounts as strings (BigInt-safe): koinOut is vKOIN satoshis (8-dec),
// which equals the native KOIN satoshis delivered after the 1:1 bridge.
async function quoteEthToVkoin({ amountEth, slippageBps = 150, provider } = {}) {
  const amountWei = ethers.parseEther(String(amountEth));
  if (amountWei <= 0n) throw new Error("Amount must be greater than 0");
  const p = provider || (await makeProvider());

  const v3 = new ethers.Contract(RC.V3_QUOTER, V3_QUOTER_ABI, p);
  const { usdt, fee } = await quoteEthToUsdt(v3, amountWei);

  const v4 = new ethers.Contract(RC.V4_QUOTER, V4_QUOTER_ABI, p);
  const koin = await quoteUsdtToVkoin(v4, usdt);
  if (koin <= 0n) throw new Error("USDT→vKOIN quote returned nothing (pool illiquid)");

  return {
    amountEth: ethers.formatEther(amountWei),
    amountWei: amountWei.toString(),
    usdtOut: usdt.toString(),
    ethUsdtFee: fee,
    koinOut: koin.toString(), // vKOIN sats == KOIN sats (both 8-dec, bridged 1:1)
    koinOutMin: applySlippage(koin, slippageBps).toString(),
    slippageBps,
  };
}

// Convenience wrappers the orchestrator uses to re-quote a single leg live right
// before it swaps (fresh slippage floor on the actual amount).
async function quoteUsdtOut({ amountWei, provider }) {
  const v3 = new ethers.Contract(RC.V3_QUOTER, V3_QUOTER_ABI, provider);
  return await quoteEthToUsdt(v3, BigInt(amountWei)); // { usdt, fee }
}
async function quoteVkoinOut({ usdtSats, provider }) {
  const v4 = new ethers.Contract(RC.V4_QUOTER, V4_QUOTER_ABI, provider);
  return await quoteUsdtToVkoin(v4, BigInt(usdtSats)); // bigint vKOIN sats
}

module.exports = {
  applySlippage,
  quoteEthToUsdt,
  quoteUsdtToVkoin,
  quoteEthToVkoin,
  quoteUsdtOut,
  quoteVkoinOut,
  V3_QUOTER_ABI,
  V4_QUOTER_ABI,
};
