"use strict";

// Ethereum side of the Vortex bridge: deposit native ETH so it can be redeemed
// as vETH on Koinos. Real ETH moves in sendDeposit(), so every path validates
// first and the amount is capped. Uses ethers v6 for battle-tested EIP-1559
// signing rather than hand-rolling RLP for real money.

const { ethers } = require("ethers");
const { utils } = require("koilib");
const { BRIDGE } = require("./bridge-constants");
const { weiToVethSats } = require("./bridge");

// Only the entrypoints we call/read on the Vortex ETH bridge.
const BRIDGE_ABI = [
  "function wrapAndTransferETH(uint256 payment, string relayer, string recipient, string metadata, uint32 toChain) payable",
  "function RequestNewSignatures(bytes txId)",
  "function paused() view returns (bool)",
];

// Public Ethereum RPCs, tried in order.
const ETH_RPCS = [
  "https://ethereum-rpc.publicnode.com",
  "https://eth.llamarpc.com",
  "https://cloudflare-eth.com",
  "https://rpc.ankr.com/eth",
];

// Absolute safety cap: a bug can never move more than this in one deposit.
const DEFAULT_MAX_ETH = "0.25";

function validKoinosAddress(a) {
  try {
    return utils.isChecksumAddress(String(a).trim());
  } catch {
    return false;
  }
}

function normPriv(hex) {
  const h = String(hex).replace(/^0x/i, "");
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error("Invalid Ethereum private key");
  return "0x" + h;
}

async function makeProvider(rpcUrls = ETH_RPCS) {
  let lastErr;
  for (const url of rpcUrls) {
    try {
      const p = new ethers.JsonRpcProvider(url, undefined, { staticNetwork: true });
      await p.getBlockNumber(); // liveness probe
      return p;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`No Ethereum RPC reachable: ${lastErr?.shortMessage || lastErr?.message || lastErr}`);
}

// Read-only feasibility + cost quote. Never signs or sends.
async function quoteDeposit({ fromAddress, amountEth, koinosRecipient, network = "mainnet", provider } = {}) {
  const cfg = BRIDGE[network];
  if (!cfg || !cfg.ethBridge) throw new Error(`Bridge not configured for ${network}`);
  if (!validKoinosAddress(koinosRecipient)) throw new Error("Invalid Koinos recipient address");
  const amountWei = ethers.parseEther(String(amountEth));
  if (amountWei <= 0n) throw new Error("Amount must be greater than 0");
  const { bridgeable, sats } = weiToVethSats(amountWei);
  if (!bridgeable) throw new Error("Amount is below the bridge minimum (10,000,000,000 wei)");

  const p = provider || (await makeProvider());
  const bridge = new ethers.Contract(cfg.ethBridge, BRIDGE_ABI, p);
  if (await bridge.paused()) throw new Error("The Vortex bridge is currently paused");

  const balance = await p.getBalance(fromAddress);
  let gasLimit;
  try {
    gasLimit = await bridge.wrapAndTransferETH.estimateGas(0, "", koinosRecipient, "", cfg.toChain, {
      value: amountWei,
      from: fromAddress,
    });
  } catch (e) {
    throw new Error(`Deposit would revert: ${e.shortMessage || e.message}`);
  }
  const fee = await p.getFeeData();
  const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  const gasCost = gasLimit * perGas;
  const total = amountWei + gasCost;

  return {
    amountEth: ethers.formatEther(amountWei),
    amountWei: amountWei.toString(),
    gasCostEth: ethers.formatEther(gasCost),
    totalEth: ethers.formatEther(total),
    balanceEth: ethers.formatEther(balance),
    sufficient: balance >= total,
    vethSats: sats,
    recipient: koinosRecipient,
  };
}

// The most a user can bridge right now: ETH balance minus a gas reserve (with a
// 30% buffer for gas-price movement), capped at the safety limit. Read-only.
async function maxBridgeable({ fromAddress, koinosRecipient, network = "mainnet", provider, capEth = DEFAULT_MAX_ETH } = {}) {
  const cfg = BRIDGE[network];
  if (!cfg || !cfg.ethBridge) throw new Error(`Bridge not configured for ${network}`);
  const p = provider || (await makeProvider());
  const bridge = new ethers.Contract(cfg.ethBridge, BRIDGE_ABI, p);
  const balance = await p.getBalance(fromAddress);

  // Gas for wrapAndTransferETH is ~constant regardless of value; estimate with a
  // nominal 1 wei, falling back to a safe default if the address is empty.
  let gasLimit;
  try {
    gasLimit = await bridge.wrapAndTransferETH.estimateGas(0, "", koinosRecipient || fromAddress, "", cfg.toChain, { value: 1n, from: fromAddress });
  } catch {
    gasLimit = 150000n;
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

// Sign + broadcast the deposit. REAL ETH MOVES HERE. Validation runs before any
// network use so bad input never reaches the chain.
async function sendDeposit({ ethPrivHex, amountEth, koinosRecipient, network = "mainnet", provider, maxEth = DEFAULT_MAX_ETH } = {}) {
  const cfg = BRIDGE[network];
  if (!cfg || !cfg.ethBridge) throw new Error(`Bridge not configured for ${network}`);
  if (!validKoinosAddress(koinosRecipient)) throw new Error("Invalid Koinos recipient address");
  const priv = normPriv(ethPrivHex);
  const amountWei = ethers.parseEther(String(amountEth));
  if (amountWei <= 0n) throw new Error("Amount must be greater than 0");
  if (maxEth && amountWei > ethers.parseEther(String(maxEth))) {
    throw new Error(`Amount ${ethers.formatEther(amountWei)} ETH exceeds the safety cap of ${maxEth} ETH`);
  }
  if (!weiToVethSats(amountWei).bridgeable) throw new Error("Amount is below the bridge minimum");

  const p = provider || (await makeProvider());
  const wallet = new ethers.Wallet(priv, p);
  const bridge = new ethers.Contract(cfg.ethBridge, BRIDGE_ABI, wallet);
  if (await bridge.paused()) throw new Error("The Vortex bridge is currently paused");

  const balance = await p.getBalance(wallet.address);
  const gasLimit = await bridge.wrapAndTransferETH.estimateGas(0, "", koinosRecipient, "", cfg.toChain, { value: amountWei });
  const fee = await p.getFeeData();
  const perGas = fee.maxFeePerGas ?? fee.gasPrice ?? 0n;
  if (balance < amountWei + gasLimit * perGas) {
    throw new Error("Insufficient ETH to cover the amount plus gas");
  }

  const tx = await bridge.wrapAndTransferETH(0, "", koinosRecipient, "", cfg.toChain, {
    value: amountWei,
    gasLimit: (gasLimit * 12n) / 10n, // 20% headroom
  });
  return { hash: tx.hash, from: wallet.address, amountWei: amountWei.toString(), recipient: koinosRecipient };
}

// Ask guardians to re-sign a deposit whose signatures expired (>60 min).
async function requestNewSignatures({ ethPrivHex, ethTxHash, network = "mainnet", provider } = {}) {
  const cfg = BRIDGE[network];
  if (!cfg || !cfg.ethBridge) throw new Error(`Bridge not configured for ${network}`);
  const priv = normPriv(ethPrivHex);
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(ethTxHash))) throw new Error("Invalid Ethereum tx hash");
  const p = provider || (await makeProvider());
  const wallet = new ethers.Wallet(priv, p);
  const bridge = new ethers.Contract(cfg.ethBridge, BRIDGE_ABI, wallet);
  const tx = await bridge.RequestNewSignatures(ethTxHash);
  return { hash: tx.hash };
}

module.exports = {
  quoteDeposit,
  maxBridgeable,
  sendDeposit,
  requestNewSignatures,
  makeProvider,
  validKoinosAddress,
  BRIDGE_ABI,
  ETH_RPCS,
  DEFAULT_MAX_ETH,
};
