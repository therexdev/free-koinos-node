"use strict";

// KoinDX swap: vETH -> KOIN, the final hop of the Fund-node pipeline. The user
// signs approve + swap_tokens_in; the sponsor pays mana (payer/payee), same as
// the redeem. Addresses/route verified on-chain 2026-08-09.
//
// Gotcha that cost us: KoinDX keys system tokens by STRING, so KOIN in a path or
// get_pair is the literal "koin", not its contract address. vETH stays base58.

const { Contract, Transaction } = require("koilib");
// ABIs vendored from @koindx/v2-sdk so the swap works in a packaged/asar build
// without depending on the SDK's module resolution at runtime.
const PeripheryAbi = require("./abi/koindx-periphery-abi.json");
const CoreAbi = require("./abi/koindx-core-abi.json");
const { BRIDGE } = require("./bridge-constants");
const { TOKEN_ABI } = require("./constants");

const KOINDX = {
  mainnet: { router: "17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s" },
  testnet: { router: null },
};
const KOIN_KEY = "koin"; // KoinDX's string key for KOIN (not its address)
const DEFAULT_SLIPPAGE_BPS = 100; // 1%
const DEFAULT_SWAP_RC = "400000000"; // 4 KOIN ceiling for approve + swap

// Uniswap-v2 constant-product output with KoinDX's 0.25% fee (9975/10000).
// Matches the router's on-chain get_amount_out exactly (verified).
function getAmountOut(amountIn, reserveIn, reserveOut) {
  const aIn = BigInt(amountIn), rIn = BigInt(reserveIn), rOut = BigInt(reserveOut);
  if (aIn <= 0n) throw new Error("amountIn must be greater than 0");
  if (rIn <= 0n || rOut <= 0n) throw new Error("Pool has no liquidity");
  const inWithFee = aIn * 9975n;
  return (inWithFee * rOut) / (rIn * 10000n + inWithFee);
}

// Reduce an amount by a slippage tolerance (basis points) to a floor.
function applySlippage(amount, slippageBps) {
  const a = BigInt(amount), bps = BigInt(slippageBps);
  if (bps < 0n || bps >= 10000n) throw new Error("slippage out of range");
  return (a * (10000n - bps)) / 10000n;
}

function swapPath(network = "mainnet") {
  return [BRIDGE[network].veth, KOIN_KEY];
}

// Quote vETH -> KOIN from live reserves. Returns the expected out and the
// slippage-protected minimum. Read-only, no mana.
async function quoteSwap({ amountInSats, slippageBps = DEFAULT_SLIPPAGE_BPS, network = "mainnet", provider } = {}) {
  const cfg = KOINDX[network];
  if (!cfg || !cfg.router) throw new Error(`KoinDX not configured for ${network}`);
  const veth = BRIDGE[network].veth;
  const router = new Contract({ id: cfg.router, abi: PeripheryAbi, provider }).functions;
  const pool = (await router.get_pair({ tokenA: veth, tokenB: KOIN_KEY })).result?.value;
  if (!pool) throw new Error("No vETH/KOIN pool found on KoinDX");

  const token = new Contract({ id: veth, abi: TOKEN_ABI, provider }).functions;
  const reserves = (await new Contract({ id: pool, abi: CoreAbi, provider }).functions.get_reserves()).result;
  // Reserve A/B -> token mapping isn't implied by ordering; derive it from the
  // pool's actual vETH balance.
  const vethInPool = (await token.balance_of({ owner: pool })).result?.value ?? "0";
  let reserveIn, reserveOut;
  if (String(vethInPool) === String(reserves.reserveA)) {
    reserveIn = reserves.reserveA;
    reserveOut = reserves.reserveB;
  } else {
    reserveIn = reserves.reserveB;
    reserveOut = reserves.reserveA;
  }
  const amountOut = getAmountOut(amountInSats, reserveIn, reserveOut);
  return {
    pool,
    amountOut: amountOut.toString(),
    amountOutMin: applySlippage(amountOut, slippageBps).toString(),
    reserveIn: String(reserveIn),
    reserveOut: String(reserveOut),
    path: swapPath(network),
    slippageBps,
  };
}

// Build the sponsored swap transaction: approve(vETH -> router) + swap_tokens_in,
// USER-signed as payee with the sponsor as payer. Returns the tx for the relayer
// to co-sign and broadcast. Nothing is broadcast here.
async function buildSwapTransaction({ userSigner, amountInSats, amountOutMin, sponsorAddress, rcLimit, network = "mainnet", provider } = {}) {
  const cfg = KOINDX[network];
  if (!cfg || !cfg.router) throw new Error(`KoinDX not configured for ${network}`);
  if (!userSigner) throw new Error("User signer required");
  if (!sponsorAddress) throw new Error("Sponsor address required");
  if (BigInt(amountInSats) <= 0n) throw new Error("amountIn must be greater than 0");
  if (BigInt(amountOutMin) <= 0n) throw new Error("amountOutMin must be set (slippage floor)");

  const veth = BRIDGE[network].veth;
  const p = provider || userSigner.provider;
  const user = userSigner.getAddress();

  const vethToken = new Contract({ id: veth, abi: TOKEN_ABI, provider: p, signer: userSigner });
  const router = new Contract({ id: cfg.router, abi: PeripheryAbi, provider: p, signer: userSigner });

  const tx = new Transaction({
    signer: userSigner,
    provider: p,
    options: { payer: sponsorAddress, payee: user, rcLimit: String(rcLimit || DEFAULT_SWAP_RC) },
  });
  await tx.pushOperation(vethToken.functions.approve, { owner: user, spender: cfg.router, value: String(amountInSats) });
  await tx.pushOperation(router.functions.swap_tokens_in, {
    from: user,
    receiver: user,
    amountIn: String(amountInSats),
    amountOutMin: String(amountOutMin),
    path: swapPath(network),
  });
  await tx.prepare();
  await tx.sign();
  return tx.transaction;
}

module.exports = {
  getAmountOut,
  applySlippage,
  swapPath,
  quoteSwap,
  buildSwapTransaction,
  KOINDX,
  KOIN_KEY,
  DEFAULT_SWAP_RC,
};
