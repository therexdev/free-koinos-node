"use strict";

// Money-moving execution for Route C's Ethereum legs. Two swaps, run as separate
// transactions so the intermediate USDT amount is known exactly (no dust loss)
// and any mid-flow failure leaves funds in a plain ERC-20 the orchestrator can
// resume from:
//   1. ETH  -> USDT   via Uniswap v3 SwapRouter02 (native ETH, auto-wrapped)
//   2. USDT -> vKOIN  via Uniswap v4 UniversalRouter (+ Permit2)
//
// Everything here just BUILDS calldata or sends a single pre-estimated tx; the
// orchestrator owns sequencing, confirmation, and persistence. Real funds move
// through sendTx(), so callers estimate/guard before calling.

const { ethers } = require("ethers");
const RC = require("./route-constants");

const coder = ethers.AbiCoder.defaultAbiCoder();
const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT160 = (1n << 160n) - 1n;

// ---- generic ERC-20 helpers (shared with eth-bridge-token) ----
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
];
function erc20(provider, token) {
  return new ethers.Contract(token, ERC20_ABI, provider);
}
async function balanceOf(provider, token, owner) {
  return await erc20(provider, token).balanceOf(owner);
}
async function allowance(provider, token, owner, spender) {
  return await erc20(provider, token).allowance(owner, spender);
}
function buildApproveTx(token, spender, amount) {
  const data = new ethers.Interface(ERC20_ABI).encodeFunctionData("approve", [spender, amount]);
  return { to: token, data, value: 0n };
}

// ---- Uniswap v3 SwapRouter02: ETH -> USDT ----
const SWAP_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
];
// Native ETH in: send value = amountWei with tokenIn = WETH; SwapRouter02 wraps it.
function buildEthToUsdtTx({ recipient, amountWei, fee, minUsdtOut }) {
  if (!recipient) throw new Error("recipient required");
  const amt = BigInt(amountWei);
  if (amt <= 0n) throw new Error("amountWei must be > 0");
  const data = new ethers.Interface(SWAP_ROUTER_ABI).encodeFunctionData("exactInputSingle", [
    { tokenIn: RC.WETH, tokenOut: RC.USDT, fee, recipient, amountIn: amt, amountOutMinimum: BigInt(minUsdtOut), sqrtPriceLimitX96: 0 },
  ]);
  return { to: RC.V3_SWAP_ROUTER, data, value: amt };
}

// ---- Permit2 ----
const PERMIT2_ABI = [
  "function approve(address token, address spender, uint160 amount, uint48 expiration)",
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
];
async function permit2Allowance(provider, owner, token, spender) {
  const [amount, expiration, nonce] = await new ethers.Contract(RC.PERMIT2, PERMIT2_ABI, provider).allowance(owner, token, spender);
  return { amount, expiration, nonce };
}
function buildPermit2ApproveTx({ token, spender, amount, expiration }) {
  const data = new ethers.Interface(PERMIT2_ABI).encodeFunctionData("approve", [token, spender, BigInt(amount), BigInt(expiration)]);
  return { to: RC.PERMIT2, data, value: 0n };
}

// ---- Uniswap v4 UniversalRouter: USDT -> vKOIN ----
const UR_ABI = ["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"];
// Universal Router command + v4 action opcodes.
const CMD_V4_SWAP = 0x10;
const ACT_SWAP_EXACT_IN_SINGLE = 0x06;
const ACT_SETTLE_ALL = 0x0c;
const ACT_TAKE_ALL = 0x0f;
const hx = (n) => n.toString(16).padStart(2, "0");

// Exact-input single swap of `usdtAmount` USDT for at least `minVkoinOut` vKOIN.
// USDT is the pool's currency1, so USDT->vKOIN is currency1->0 (zeroForOne=false).
// SETTLE_ALL pulls the USDT from the user via Permit2; TAKE_ALL sends vKOIN to the
// user and reverts unless at least `minVkoinOut` is delivered (the slippage floor).
function buildUsdtToVkoinTx({ usdtAmount, minVkoinOut, deadline }) {
  const amtIn = BigInt(usdtAmount);
  const minOut = BigInt(minVkoinOut);
  if (amtIn <= 0n) throw new Error("usdtAmount must be > 0");
  if (amtIn > MAX_UINT160) throw new Error("usdtAmount too large"); // uint128 in swap params
  const k = RC.VKOIN_USDT_POOL;
  const poolKey = [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks];

  const commands = "0x" + hx(CMD_V4_SWAP);
  const actions = "0x" + hx(ACT_SWAP_EXACT_IN_SINGLE) + hx(ACT_SETTLE_ALL) + hx(ACT_TAKE_ALL);
  const swapParams = coder.encode(
    ["tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,bytes)"],
    [[poolKey, false, amtIn, minOut, "0x"]]
  );
  const settleParams = coder.encode(["address", "uint256"], [RC.USDT, amtIn]); // pay exactly amountIn USDT
  const takeParams = coder.encode(["address", "uint256"], [RC.VKOIN, minOut]); // require >= minOut vKOIN
  const input = coder.encode(["bytes", "bytes[]"], [actions, [swapParams, settleParams, takeParams]]);

  const data = new ethers.Interface(UR_ABI).encodeFunctionData("execute", [commands, [input], BigInt(deadline)]);
  return { to: RC.UNIVERSAL_ROUTER, data, value: 0n };
}

// ---- single-tx sender with gas estimation + EIP-1559 fees ----
// Estimates first so a would-revert tx throws before anything is broadcast.
async function sendTx(wallet, req, { gasNumerator = 12n, gasDenominator = 10n } = {}) {
  const txReq = { to: req.to, data: req.data, value: req.value ? BigInt(req.value) : 0n };
  let gas;
  try {
    gas = await wallet.estimateGas(txReq);
  } catch (e) {
    throw new Error(`Transaction would revert: ${e.shortMessage || e.message || e}`);
  }
  const fee = await wallet.provider.getFeeData();
  const sent = await wallet.sendTransaction({
    ...txReq,
    gasLimit: (gas * gasNumerator) / gasDenominator,
    ...(fee.maxFeePerGas ? { maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas ?? undefined } : { gasPrice: fee.gasPrice ?? undefined }),
  });
  return { hash: sent.hash };
}

module.exports = {
  ERC20_ABI,
  balanceOf,
  allowance,
  buildApproveTx,
  buildEthToUsdtTx,
  permit2Allowance,
  buildPermit2ApproveTx,
  buildUsdtToVkoinTx,
  sendTx,
  MAX_UINT256,
  MAX_UINT160,
  PERMIT2_ABI,
  UR_ABI,
};
