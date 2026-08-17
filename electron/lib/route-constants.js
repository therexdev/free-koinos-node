"use strict";

// Route C — fund with KOIN by swapping on Ethereum, then bridging vKOIN → KOIN.
//   ETH → USDT (Uniswap v3) → vKOIN (Uniswap v4) → Vortex bridge → native KOIN
//
// Why this route exists: the only deep KOIN market reachable from Ethereum is the
// vKOIN/USDT Uniswap-v4 pool (~$32k), which is ~20× deeper than KoinDX's
// vETH/KOIN pool — so for the same ETH you end up with far more KOIN. vKOIN
// ("Vortex Koin") bridges 1:1 to native KOIN through the same Vortex bridge the
// ETH path already uses.
//
// EVERY address below was verified ON-CHAIN on 2026-08-10 (eth_getCode has code;
// the V4 Quoter returns live quotes through the pool key; the Vortex bridge
// accepts vKOIN in a transferTokens simulation — it reverts only on the caller's
// zero balance, not on "token is not supported"). Do not edit without re-verifying.

const VKOIN = "0xa50ad3a559A10f384a5bB2e27516f63E0B937b1A"; // "Vortex Koin", 8 decimals, 1:1 with KOIN
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7"; // 6 decimals
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

// Uniswap infrastructure (Ethereum mainnet).
const UNIVERSAL_ROUTER = "0x66a9893cC07D91D95644AEDD05D03f95e1dBA8Af"; // v4-capable Universal Router
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
const V3_SWAP_ROUTER = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"; // SwapRouter02 (ETH→USDT leg)
const V3_QUOTER = "0x61fFE014bA17989E743c5F6cB21bF9697530B21e"; // QuoterV2
const V4_QUOTER = "0x52F0E24D1c21C8A0cB1e5a5dD6198556BD9E1203";
const V4_POOL_MANAGER = "0x000000000004444c5dc75cB358380D2e3dE08A90";

// The vKOIN/USDT Uniswap-v4 pool — the only meaningful vKOIN liquidity. This
// PoolKey hashes to the pool's on-chain id 0xd833…687da6 (verified). vKOIN sorts
// below USDT, so it is currency0; a USDT→vKOIN swap is therefore currency1→0
// (zeroForOne = false).
const VKOIN_USDT_POOL = {
  currency0: VKOIN,
  currency1: USDT,
  fee: 10000, // 1%
  tickSpacing: 200,
  hooks: "0x0000000000000000000000000000000000000000", // no hooks
  id: "0xd833a3afa936ca389966a9ed3a3d9abf7ec45c11b0d575aaaf6ca4d354687da6",
};

// WETH/USDT v3 fee tiers to try for the ETH→USDT leg, deepest first. Both are
// very liquid, so this leg is effectively slippage-free at funding sizes.
const ETH_USDT_FEES = [500, 3000];

module.exports = {
  VKOIN,
  USDT,
  WETH,
  VKOIN_DECIMALS: 8,
  USDT_DECIMALS: 6,
  UNIVERSAL_ROUTER,
  PERMIT2,
  V3_SWAP_ROUTER,
  V3_QUOTER,
  V4_QUOTER,
  V4_POOL_MANAGER,
  VKOIN_USDT_POOL,
  ETH_USDT_FEES,
};
