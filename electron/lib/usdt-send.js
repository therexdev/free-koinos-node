"use strict";

// Read USDT balance and send USDT out of the wallet's funding address. Mirrors
// eth-send.js but for the USDT ERC-20: the amount is USDT (6 decimals) while gas
// is still paid in ETH, so quotes report both an ETH-gas cost and whether the
// address holds enough ETH to cover it. REAL USDT moves in sendUsdt().
//
// USDT is a non-standard ERC-20 whose transfer() returns nothing, so the ABI
// omits the bool return (declaring one makes ethers throw decoding the empty
// return). We wait on the receipt, not the return value, so this is safe.

const { ethers } = require("ethers");
const { requireValidTo } = require("./eth-send");
const { makeProvider } = require("./eth-bridge");
const { USDT, USDT_DECIMALS } = require("./route-constants");

// Fat-finger guard, NOT a product limit — the user is moving their own funds.
const DEFAULT_MAX_USDT = "100000";
const FALLBACK_TRANSFER_GAS = 100000n; // ERC-20 transfer; estimate normally

const USDT_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 value)", // USDT returns no bool
];

function normPriv(hex) {
  const h = String(hex).replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("Invalid Ethereum private key");
  return "0x" + h;
}
function parseUsdt(amount) {
  return ethers.parseUnits(String(amount), USDT_DECIMALS);
}
function formatUsdt(sats) {
  return ethers.formatUnits(BigInt(sats), USDT_DECIMALS);
}

async function estimateTransferGas(provider, from, to, sats) {
  try {
    const data = new ethers.Interface(USDT_ABI).encodeFunctionData("transfer", [to, sats]);
    return BigInt(await provider.estimateGas({ from, to: USDT, data }));
  } catch {
    return FALLBACK_TRANSFER_GAS;
  }
}

// Read-only USDT balance of an address.
async function usdtBalance({ address, provider } = {}) {
  const p = provider || (await makeProvider());
  const bal = await new ethers.Contract(USDT, USDT_ABI, p).balanceOf(address);
  return { address, sats: bal.toString(), usdt: formatUsdt(bal) };
}

// Read-only feasibility + cost quote for a USDT send. Never signs.
async function quoteUsdtSend({ fromAddress, amountUsdt, toAddress, provider } = {}) {
  const to = requireValidTo(toAddress);
  const sats = parseUsdt(amountUsdt);
  if (sats <= 0n) throw new Error("Amount must be greater than 0");
  const p = provider || (await makeProvider());
  const c = new ethers.Contract(USDT, USDT_ABI, p);
  const [bal, ethBal] = await Promise.all([c.balanceOf(fromAddress), p.getBalance(fromAddress)]);
  const gasLimit = await estimateTransferGas(p, fromAddress, to, sats);
  const fee = await p.getFeeData();
  const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const gasCost = gasLimit * perGas;
  return {
    to,
    amountUsdt: formatUsdt(sats),
    amountSats: sats.toString(),
    gasCostEth: ethers.formatEther(gasCost),
    usdtBalance: formatUsdt(bal),
    sufficientUsdt: bal >= sats,
    ethForGas: ethers.formatEther(ethBal),
    sufficientGas: ethBal >= gasCost,
  };
}

// The most USDT this address can send: its whole USDT balance (gas is separate,
// paid in ETH), capped by the fat-finger guard. Read-only.
async function maxUsdtSendable({ fromAddress, provider, capUsdt = DEFAULT_MAX_USDT } = {}) {
  const p = provider || (await makeProvider());
  const bal = await new ethers.Contract(USDT, USDT_ABI, p).balanceOf(fromAddress);
  let maxSats = bal;
  const cap = parseUsdt(capUsdt);
  if (maxSats > cap) maxSats = cap;
  return { maxSats: maxSats.toString(), maxUsdt: formatUsdt(maxSats), balanceUsdt: formatUsdt(bal) };
}

// Sign + broadcast the USDT transfer. REAL USDT MOVES HERE.
async function sendUsdt({ ethPrivHex, amountUsdt, toAddress, provider, maxUsdt = DEFAULT_MAX_USDT } = {}) {
  const to = requireValidTo(toAddress);
  const priv = normPriv(ethPrivHex);
  const sats = parseUsdt(amountUsdt);
  if (sats <= 0n) throw new Error("Amount must be greater than 0");
  if (maxUsdt && sats > parseUsdt(maxUsdt)) {
    throw new Error(`Amount ${formatUsdt(sats)} USDT exceeds the safety cap of ${maxUsdt} USDT`);
  }
  const p = provider || (await makeProvider());
  const wallet = new ethers.Wallet(priv, p);
  const c = new ethers.Contract(USDT, USDT_ABI, wallet);
  const [bal, ethBal] = await Promise.all([c.balanceOf(wallet.address), p.getBalance(wallet.address)]);
  if (bal < sats) throw new Error("Insufficient USDT balance");
  const gasLimit = await estimateTransferGas(p, wallet.address, to, sats);
  const fee = await p.getFeeData();
  const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  if (ethBal < gasLimit * perGas) throw new Error("Insufficient ETH to cover gas for the USDT transfer");
  const tx = await c.transfer(to, sats, { gasLimit: (gasLimit * 12n) / 10n });
  return { hash: tx.hash, from: wallet.address, to, amountSats: sats.toString() };
}

module.exports = {
  usdtBalance,
  quoteUsdtSend,
  maxUsdtSendable,
  sendUsdt,
  parseUsdt,
  formatUsdt,
  DEFAULT_MAX_USDT,
  USDT_ABI,
};
