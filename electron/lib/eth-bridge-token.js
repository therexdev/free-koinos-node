"use strict";

// Ethereum side of bridging an ERC-20 (vKOIN) to Koinos via the Vortex bridge's
// transferTokens entrypoint — the token mirror of wrapAndTransferETH. The token
// must already be approved to the bridge (ERC-20 allowance). Guardians then sign
// the lock exactly as for an ETH deposit, and the same complete_transfer redeem
// delivers the mapped Koinos token (vKOIN → native KOIN, 1:1).
//
// transferTokens(address,uint256,uint256,string,string,string,uint32) — selector
// 0x0b47c9da, verified present in the bridge bytecode on 2026-08-10.

const { ethers } = require("ethers");
const { BRIDGE } = require("./bridge-constants");
const { validKoinosAddress } = require("./eth-bridge");

const BRIDGE_TOKEN_ABI = [
  "function transferTokens(address token, uint256 amount, uint256 payment, string relayer, string recipient, string metadata, uint32 toChain) payable",
  "function paused() view returns (bool)",
];

// Build the transferTokens calldata: payment=0, relayer/metadata empty, recipient
// is the user's Koinos address, toChain is the bridge's Koinos chain id.
function buildTransferTokensTx({ token, amountSats, koinosRecipient, network = "mainnet" }) {
  const cfg = BRIDGE[network];
  if (!cfg || !cfg.ethBridge) throw new Error(`Bridge not configured for ${network}`);
  if (!token) throw new Error("token required");
  if (!validKoinosAddress(koinosRecipient)) throw new Error("Invalid Koinos recipient address");
  const amt = BigInt(amountSats);
  if (amt <= 0n) throw new Error("amount must be > 0");
  const data = new ethers.Interface(BRIDGE_TOKEN_ABI).encodeFunctionData("transferTokens", [
    token,
    amt,
    0n, // payment
    "", // relayer
    String(koinosRecipient),
    "", // metadata
    cfg.toChain,
  ]);
  return { to: cfg.ethBridge, data, value: 0n };
}

async function bridgePaused(provider, network = "mainnet") {
  const cfg = BRIDGE[network];
  if (!cfg || !cfg.ethBridge) throw new Error(`Bridge not configured for ${network}`);
  return await new ethers.Contract(cfg.ethBridge, BRIDGE_TOKEN_ABI, provider).paused();
}

module.exports = { BRIDGE_TOKEN_ABI, buildTransferTokensTx, bridgePaused };
