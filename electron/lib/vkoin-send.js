"use strict";

// Read vKOIN balance and send vKOIN out of the wallet's funding address. vKOIN
// ("Vortex Koin", 8 decimals) is the Ethereum-side token that bridges 1:1 to
// native KOIN; exposing balance + send lets a user rescue vKOIN that a funding
// run left in the wallet (e.g. a swap that succeeded before the bridge step).
// Mirrors usdt-send.js; gas is paid in ETH. REAL vKOIN moves in sendVkoin().

const { ethers } = require("ethers");
const { requireValidTo } = require("./eth-send");
const { makeProvider } = require("./eth-bridge");
const { VKOIN, VKOIN_DECIMALS } = require("./route-constants");

const DEFAULT_MAX_VKOIN = "100000000"; // fat-finger guard, not a product limit
const FALLBACK_TRANSFER_GAS = 100000n;

const VKOIN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 value)", // no bool return (safe for either)
];

function normPriv(hex) {
  const h = String(hex).replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("Invalid Ethereum private key");
  return "0x" + h;
}
function parseVkoin(amount) {
  return ethers.parseUnits(String(amount), VKOIN_DECIMALS);
}
function formatVkoin(sats) {
  return ethers.formatUnits(BigInt(sats), VKOIN_DECIMALS);
}

async function estimateTransferGas(provider, from, to, sats) {
  try {
    const data = new ethers.Interface(VKOIN_ABI).encodeFunctionData("transfer", [to, sats]);
    return BigInt(await provider.estimateGas({ from, to: VKOIN, data }));
  } catch {
    return FALLBACK_TRANSFER_GAS;
  }
}

async function vkoinBalance({ address, provider } = {}) {
  const p = provider || (await makeProvider());
  const bal = await new ethers.Contract(VKOIN, VKOIN_ABI, p).balanceOf(address);
  return { address, sats: bal.toString(), vkoin: formatVkoin(bal) };
}

async function quoteVkoinSend({ fromAddress, amountVkoin, toAddress, provider } = {}) {
  const to = requireValidTo(toAddress);
  const sats = parseVkoin(amountVkoin);
  if (sats <= 0n) throw new Error("Amount must be greater than 0");
  const p = provider || (await makeProvider());
  const c = new ethers.Contract(VKOIN, VKOIN_ABI, p);
  const [bal, ethBal] = await Promise.all([c.balanceOf(fromAddress), p.getBalance(fromAddress)]);
  const gasLimit = await estimateTransferGas(p, fromAddress, to, sats);
  const fee = await p.getFeeData();
  const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const gasCost = gasLimit * perGas;
  return {
    to,
    amountVkoin: formatVkoin(sats),
    amountSats: sats.toString(),
    gasCostEth: ethers.formatEther(gasCost),
    vkoinBalance: formatVkoin(bal),
    sufficientVkoin: bal >= sats,
    ethForGas: ethers.formatEther(ethBal),
    sufficientGas: ethBal >= gasCost,
  };
}

async function maxVkoinSendable({ fromAddress, provider, capVkoin = DEFAULT_MAX_VKOIN } = {}) {
  const p = provider || (await makeProvider());
  const bal = await new ethers.Contract(VKOIN, VKOIN_ABI, p).balanceOf(fromAddress);
  let maxSats = bal;
  const cap = parseVkoin(capVkoin);
  if (maxSats > cap) maxSats = cap;
  return { maxSats: maxSats.toString(), maxVkoin: formatVkoin(maxSats), balanceVkoin: formatVkoin(bal) };
}

async function sendVkoin({ ethPrivHex, amountVkoin, toAddress, provider, maxVkoin = DEFAULT_MAX_VKOIN } = {}) {
  const to = requireValidTo(toAddress);
  const priv = normPriv(ethPrivHex);
  const sats = parseVkoin(amountVkoin);
  if (sats <= 0n) throw new Error("Amount must be greater than 0");
  if (maxVkoin && sats > parseVkoin(maxVkoin)) {
    throw new Error(`Amount ${formatVkoin(sats)} vKOIN exceeds the safety cap of ${maxVkoin} vKOIN`);
  }
  const p = provider || (await makeProvider());
  const wallet = new ethers.Wallet(priv, p);
  const c = new ethers.Contract(VKOIN, VKOIN_ABI, wallet);
  const [bal, ethBal] = await Promise.all([c.balanceOf(wallet.address), p.getBalance(wallet.address)]);
  if (bal < sats) throw new Error("Insufficient vKOIN balance");
  const gasLimit = await estimateTransferGas(p, wallet.address, to, sats);
  const fee = await p.getFeeData();
  const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  if (ethBal < gasLimit * perGas) throw new Error("Insufficient ETH to cover gas for the vKOIN transfer");
  const tx = await c.transfer(to, sats, { gasLimit: (gasLimit * 12n) / 10n });
  return { hash: tx.hash, from: wallet.address, to, amountSats: sats.toString() };
}

module.exports = {
  vkoinBalance,
  quoteVkoinSend,
  maxVkoinSendable,
  sendVkoin,
  parseVkoin,
  formatVkoin,
  DEFAULT_MAX_VKOIN,
  VKOIN_ABI,
};
