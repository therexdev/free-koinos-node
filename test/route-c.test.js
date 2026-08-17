"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { ethers } = require("ethers");
const RC = require("../electron/lib/route-constants");
const { nextAction, MAX_ROUTE_C_ETH } = require("../electron/lib/route-c-orchestrator");
const swap = require("../electron/lib/eth-swap-exec");
const { buildTransferTokensTx, BRIDGE_TOKEN_ABI } = require("../electron/lib/eth-bridge-token");
const { applySlippage } = require("../electron/lib/eth-swap");

const coder = ethers.AbiCoder.defaultAbiCoder();

test("nextAction maps every state to the right driver action", () => {
  assert.equal(nextAction("swap_eth_usdt"), "eth");
  assert.equal(nextAction("approve_permit2"), "eth");
  assert.equal(nextAction("approve_ur"), "eth");
  assert.equal(nextAction("swap_usdt_vkoin"), "eth");
  assert.equal(nextAction("approve_bridge"), "eth");
  assert.equal(nextAction("bridge_token"), "eth");
  assert.equal(nextAction("awaiting_signatures"), "poll");
  assert.equal(nextAction("redeeming"), "redeem");
  assert.equal(nextAction("done"), "none");
  assert.equal(nextAction("error"), "none");
  assert.equal(nextAction("idle"), "none");
});

test("applySlippage floors correctly and rejects bad bps", () => {
  assert.equal(applySlippage(10000n, 150), 9850n); // 1.5%
  assert.equal(applySlippage(10000n, 0), 10000n);
  assert.throws(() => applySlippage(1n, 10000), /slippage out of range/);
});

test("buildEthToUsdtTx encodes a native-ETH v3 exact-in swap", () => {
  const amountWei = ethers.parseEther("0.02");
  const tx = swap.buildEthToUsdtTx({ recipient: "0x1111111111111111111111111111111111111111", amountWei, fee: 500, minUsdtOut: 37000000n });
  assert.equal(tx.to.toLowerCase(), RC.V3_SWAP_ROUTER.toLowerCase());
  assert.equal(tx.value, amountWei); // native ETH sent as value
  const iface = new ethers.Interface(["function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"]);
  const decoded = iface.decodeFunctionData("exactInputSingle", tx.data);
  const p = decoded[0];
  assert.equal(p.tokenIn.toLowerCase(), RC.WETH.toLowerCase());
  assert.equal(p.tokenOut.toLowerCase(), RC.USDT.toLowerCase());
  assert.equal(p.fee, 500n);
  assert.equal(p.amountIn, amountWei);
  assert.equal(p.amountOutMinimum, 37000000n);
});

test("buildUsdtToVkoinTx encodes the exact v4 swap actions + pool key", () => {
  const usdt = 100000000n; // 100 USDT
  const minOut = 11556100000n;
  const deadline = 1893456000; // fixed
  const tx = swap.buildUsdtToVkoinTx({ usdtAmount: usdt, minVkoinOut: minOut, deadline });
  assert.equal(tx.to.toLowerCase(), RC.UNIVERSAL_ROUTER.toLowerCase());
  assert.equal(tx.value, 0n);

  const ur = new ethers.Interface(swap.UR_ABI);
  const [commands, inputs, dl] = ur.decodeFunctionData("execute", tx.data);
  assert.equal(commands, "0x10"); // V4_SWAP
  assert.equal(dl, BigInt(deadline));
  assert.equal(inputs.length, 1);

  const [actions, params] = coder.decode(["bytes", "bytes[]"], inputs[0]);
  assert.equal(actions, "0x060c0f"); // SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL
  assert.equal(params.length, 3);

  const [sp] = coder.decode(["tuple(tuple(address,address,uint24,int24,address),bool,uint128,uint128,bytes)"], params[0]);
  const [poolKey, zeroForOne, amountIn, amountOutMin] = sp;
  assert.equal(poolKey[0].toLowerCase(), RC.VKOIN.toLowerCase()); // currency0 = vKOIN
  assert.equal(poolKey[1].toLowerCase(), RC.USDT.toLowerCase()); // currency1 = USDT
  assert.equal(poolKey[2], 10000n); // fee
  assert.equal(poolKey[3], 200n); // tickSpacing
  assert.equal(zeroForOne, false); // USDT (currency1) -> vKOIN (currency0)
  assert.equal(amountIn, usdt);
  assert.equal(amountOutMin, minOut);

  // SETTLE_ALL(USDT, amountIn) and TAKE_ALL(vKOIN, minOut)
  const [settleCur, settleMax] = coder.decode(["address", "uint256"], params[1]);
  const [takeCur, takeMin] = coder.decode(["address", "uint256"], params[2]);
  assert.equal(settleCur.toLowerCase(), RC.USDT.toLowerCase());
  assert.equal(settleMax, usdt);
  assert.equal(takeCur.toLowerCase(), RC.VKOIN.toLowerCase());
  assert.equal(takeMin, minOut);
});

test("buildPermit2ApproveTx targets Permit2 with amount + expiration", () => {
  const tx = swap.buildPermit2ApproveTx({ token: RC.USDT, spender: RC.UNIVERSAL_ROUTER, amount: 100000000n, expiration: 1893456000 });
  assert.equal(tx.to.toLowerCase(), RC.PERMIT2.toLowerCase());
  const iface = new ethers.Interface(swap.PERMIT2_ABI);
  const d = iface.decodeFunctionData("approve", tx.data);
  assert.equal(d[0].toLowerCase(), RC.USDT.toLowerCase());
  assert.equal(d[1].toLowerCase(), RC.UNIVERSAL_ROUTER.toLowerCase());
  assert.equal(d[2], 100000000n);
  assert.equal(d[3], 1893456000n);
});

test("buildTransferTokensTx encodes the vKOIN bridge deposit", () => {
  const koinosRecipient = "1NsQbH5AhQXgtSNg1ejpFqTi2hmCWz1eQS";
  const tx = buildTransferTokensTx({ token: RC.VKOIN, amountSats: 500000000000n, koinosRecipient, network: "mainnet" });
  assert.equal(tx.to.toLowerCase(), "0x2F2f36A88DD5ff8d53Ba2505b2DbC0C153d910Ab".toLowerCase());
  assert.equal(tx.value, 0n);
  const iface = new ethers.Interface(BRIDGE_TOKEN_ABI);
  const d = iface.decodeFunctionData("transferTokens", tx.data);
  assert.equal(d[0].toLowerCase(), RC.VKOIN.toLowerCase()); // token
  assert.equal(d[1], 500000000000n); // amount
  assert.equal(d[2], 0n); // payment
  assert.equal(d[3], ""); // relayer
  assert.equal(d[4], koinosRecipient); // recipient
  assert.equal(d[5], ""); // metadata
  assert.equal(d[6], 1n); // toChain
});

test("buildTransferTokensTx rejects an invalid Koinos recipient", () => {
  assert.throws(() => buildTransferTokensTx({ token: RC.VKOIN, amountSats: 1n, koinosRecipient: "not-an-address", network: "mainnet" }), /Invalid Koinos recipient/);
});

test("MAX_ROUTE_C_ETH is a small safety cap", () => {
  assert.ok(Number(MAX_ROUTE_C_ETH) > 0 && Number(MAX_ROUTE_C_ETH) <= 0.05);
});
