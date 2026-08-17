"use strict";

// Send native ETH out of the wallet's funding address to any Ethereum address.
// This exists so ETH parked in the app for bridging isn't trapped — a user can
// withdraw it to an exchange or another wallet at any time. REAL ETH moves in
// sendEth(); every path validates first and the amount is capped by a generous
// fat-finger guard. Uses ethers v6 (same as eth-bridge.js) rather than
// hand-rolling RLP for real money.

const { ethers } = require("ethers");
const { isValidAddress, toChecksumAddress } = require("./eth");
const { makeProvider } = require("./eth-bridge");

// Fat-finger guard, NOT a product limit — this is the user withdrawing their own
// funds, so the ceiling only needs to be higher than any plausible balance a
// KoinosKit user parks here. The UI's "Max" computes the real balance-minus-gas
// figure, which is what a full withdrawal actually uses.
const DEFAULT_MAX_ETH = "20";

// Gas for a plain ETH transfer to an EOA is exactly 21000; a contract recipient
// can need more, so we estimate and fall back to this.
const BASE_TRANSFER_GAS = 21000n;

function normPriv(hex) {
  const h = String(hex).replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("Invalid Ethereum private key");
  return "0x" + h;
}

// Validate + checksum the recipient. A mixed-case address whose checksum doesn't
// verify is rejected (catches a mistyped character); all-one-case is accepted and
// normalized.
function requireValidTo(toAddress) {
  const s = String(toAddress == null ? "" : toAddress).trim();
  if (!isValidAddress(s)) throw new Error("Invalid Ethereum recipient address");
  return toChecksumAddress(s);
}

async function estimateSendGas(provider, from, to, valueWei) {
  try {
    return BigInt(await provider.estimateGas({ from, to, value: valueWei }));
  } catch {
    return BASE_TRANSFER_GAS;
  }
}

// Read-only feasibility + cost quote. Never signs or sends.
async function quoteSend({ fromAddress, amountEth, toAddress, provider } = {}) {
  const to = requireValidTo(toAddress);
  const amountWei = ethers.parseEther(String(amountEth));
  if (amountWei <= 0n) throw new Error("Amount must be greater than 0");

  const p = provider || (await makeProvider());
  const balance = await p.getBalance(fromAddress);
  const gasLimit = await estimateSendGas(p, fromAddress, to, amountWei);
  const fee = await p.getFeeData();
  const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const gasCost = gasLimit * perGas;
  const total = amountWei + gasCost;

  return {
    to,
    amountEth: ethers.formatEther(amountWei),
    amountWei: amountWei.toString(),
    gasCostEth: ethers.formatEther(gasCost),
    totalEth: ethers.formatEther(total),
    balanceEth: ethers.formatEther(balance),
    sufficient: balance >= total,
  };
}

// The most ETH this address can send right now: balance minus a gas reserve
// (+30% headroom for gas-price movement), capped at the safety limit. Read-only.
async function maxSendable({ fromAddress, toAddress, provider, capEth = DEFAULT_MAX_ETH } = {}) {
  const p = provider || (await makeProvider());
  const balance = await p.getBalance(fromAddress);
  // Plain transfers are a fixed 21000; if a recipient is given, estimate against
  // it (a contract may cost more) with a nominal 1 wei value.
  let gasLimit = BASE_TRANSFER_GAS;
  const s = String(toAddress == null ? "" : toAddress).trim();
  if (s && isValidAddress(s)) {
    gasLimit = await estimateSendGas(p, fromAddress, toChecksumAddress(s), 1n);
  }
  const fee = await p.getFeeData();
  const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const gasReserve = (gasLimit * perGas * 13n) / 10n; // +30% headroom
  let maxWei = balance > gasReserve ? balance - gasReserve : 0n;
  const capWei = ethers.parseEther(String(capEth));
  if (maxWei > capWei) maxWei = capWei;

  return {
    maxWei: maxWei.toString(),
    maxEth: ethers.formatEther(maxWei),
    gasReserveEth: ethers.formatEther(gasReserve),
    balanceEth: ethers.formatEther(balance),
    capped: maxWei === capWei,
  };
}

// Sign + broadcast the transfer. REAL ETH MOVES HERE. Validation runs before any
// network use so bad input never reaches the chain.
async function sendEth({ ethPrivHex, amountEth, toAddress, provider, maxEth = DEFAULT_MAX_ETH } = {}) {
  const to = requireValidTo(toAddress);
  const priv = normPriv(ethPrivHex);
  const amountWei = ethers.parseEther(String(amountEth));
  if (amountWei <= 0n) throw new Error("Amount must be greater than 0");
  if (maxEth && amountWei > ethers.parseEther(String(maxEth))) {
    throw new Error(`Amount ${ethers.formatEther(amountWei)} ETH exceeds the safety cap of ${maxEth} ETH`);
  }

  const p = provider || (await makeProvider());
  const wallet = new ethers.Wallet(priv, p);
  const balance = await p.getBalance(wallet.address);
  const gasLimit = await estimateSendGas(p, wallet.address, to, amountWei);
  const fee = await p.getFeeData();
  const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  if (balance < amountWei + gasLimit * perGas) {
    throw new Error("Insufficient ETH to cover the amount plus gas");
  }

  const tx = await wallet.sendTransaction({
    to,
    value: amountWei,
    gasLimit: (gasLimit * 12n) / 10n, // 20% headroom
  });
  return { hash: tx.hash, from: wallet.address, to, amountWei: amountWei.toString() };
}

module.exports = {
  quoteSend,
  maxSendable,
  sendEth,
  requireValidTo,
  DEFAULT_MAX_ETH,
  BASE_TRANSFER_GAS,
};
