"use strict";

// Koinos side of the Vortex bridge: redeem a deposit by calling complete_transfer,
// which mints vETH to the recipient. The recipient (user) must sign — but a
// brand-new user has no mana, so we build the transaction with the sponsor wallet
// as PAYER and the user as PAYEE: the user signs to authorize the mint, the
// sponsor co-signs (in the relayer) to pay the mana. Field mapping mirrors the
// reference client (VortexBridge/interface-bridge Redeem.jsx) exactly; koilib
// encodes the byte fields via the ABI's btype annotations.

const { Contract } = require("koilib");
const BRIDGE_ABI = require("./abi/koinos-bridge-abi.json");
const { BRIDGE } = require("./bridge-constants");

// Default mana ceiling the app sets on the redeem tx (3 KOIN in satoshis). The
// relayer re-validates this against its own SPONSOR_RC_MAX before co-signing.
const DEFAULT_REDEEM_RC = "300000000";

// Map a Vortex proxy record (GetEthereumTransaction response) to complete_transfer
// arguments. koilib accepts the camelCase keys and converts bytes/address fields
// per the ABI, so the proxy values pass through unchanged.
function recordToRedeemArgs(record) {
  if (!record || typeof record !== "object") throw new Error("Missing bridge record");
  if (!record.id) throw new Error("Bridge record missing id (ETH tx hash)");
  if (!record.recipient) throw new Error("Bridge record missing recipient");
  if (!record.koinosToken) throw new Error("Bridge record missing koinosToken");
  if (!Array.isArray(record.signatures) || record.signatures.length === 0) {
    throw new Error("Bridge record has no signatures");
  }
  return {
    transactionId: record.id,
    token: record.koinosToken,
    relayer: record.relayer || "",
    recipient: record.recipient,
    value: String(record.amount),
    payment: String(record.payment == null ? "0" : record.payment),
    metadata: record.metadata || "",
    signatures: record.signatures,
    expiration: String(record.expiration),
  };
}

// Build the complete_transfer transaction, USER-signed as payee, sponsor set as
// payer. Returns the transaction JSON (one signature so far — the user's) for the
// relayer to co-sign as payer and broadcast. sendTransaction:false means build +
// user-sign only; nothing is broadcast here.
async function buildRedeemTransaction({ userSigner, record, sponsorAddress, rcLimit, network = "mainnet", provider } = {}) {
  const cfg = BRIDGE[network];
  if (!cfg || !cfg.koinosBridge) throw new Error(`Bridge not configured for ${network}`);
  if (!userSigner) throw new Error("User signer required");
  if (!sponsorAddress) throw new Error("Sponsor address required");
  const args = recordToRedeemArgs(record);

  const bridge = new Contract({
    id: cfg.koinosBridge,
    abi: BRIDGE_ABI,
    provider: provider || userSigner.provider,
    signer: userSigner,
  });

  const { transaction } = await bridge.functions.complete_transfer(args, {
    payer: sponsorAddress, // sponsor pays mana
    payee: userSigner.getAddress(), // user's nonce increments (avoids sponsor nonce races)
    rcLimit: String(rcLimit || DEFAULT_REDEEM_RC),
    sendTransaction: false, // user-sign only; relayer co-signs + broadcasts
  });
  return transaction;
}

module.exports = { recordToRedeemArgs, buildRedeemTransaction, BRIDGE_ABI, DEFAULT_REDEEM_RC };
