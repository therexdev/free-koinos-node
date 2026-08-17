"use strict";

// Vortex bridge + KoinDX addresses and configuration for the "Fund node" ETH→KOIN
// pipeline (Phase 2). Every mainnet value below was verified ON-CHAIN on
// 2026-08-09 (Ethereum RPC + Koinos api.koinos.io), not taken from the Vortex
// repos — whose committed mainnet configs are stale/placeholder.
//
// Flow: deposit ETH on Ethereum (wrapAndTransferETH) → guardians sign → redeem
// on Koinos (complete_transfer mints vETH) → swap vETH→KOIN on KoinDX.

const ETH_DECIMALS = 18;
const VETH_DECIMALS = 8; // vETH is 8 decimals, NOT 18 — verified on-chain.

const BRIDGE = {
  mainnet: {
    // --- Ethereum side ---
    // Verified: has bytecode, paused()=false, chainId()=2,
    // WETHAddress()=0xC02a…, getValidatorsLength()=3.
    ethBridge: "0x2F2f36A88DD5ff8d53Ba2505b2DbC0C153d910Ab",
    weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // internal accounting only
    toChain: 1, // destination chain-id the bridge expects for Koinos

    // --- Signature aggregator (guardians) ---
    proxyUrl: "https://proxy.vortexbridge.io",

    // --- Koinos side ---
    // Verified via get_metadata: initialized, chainId:1, nbValidators:3.
    koinosBridge: "1aqHtNRDkiAZeFtuM8fRFuurcje6eHqF8",
    // Verified: name "Vortex ETH", symbol "vETH", decimals 8.
    veth: "1Tf1QKv3gVYLjq34yURSHw5ErTYbFjqTG",
    koin: "19GYjDBVXU7keLbYvMLazsGQn3GTWHjHkK", // resolve at runtime too
    // --- KoinDX (swap vETH→KOIN) ---
    koindx: {
      periphery: "17e1q6Fh5RgnuA8K7v4KvXXH4k9qHgsT5s",
      factory: "19WxDJ9Kcvx4VqQFkpwVmwVEy1hMuwXtQE",
    },
  },

  // Testnet (Sepolia ⇄ Harbinger) for dry-runs. The live testnet addresses must
  // be pulled from test.vortexbridge.io and verified before any testnet run —
  // left null so nothing runs against an unverified address by accident.
  testnet: {
    ethBridge: null,
    weth: null,
    toChain: 1,
    proxyUrl: "https://proxy.test.vortexbridge.io",
    koinosBridge: null,
    veth: null,
    koin: null,
    koindx: { periphery: null, factory: null },
  },
};

module.exports = { BRIDGE, ETH_DECIMALS, VETH_DECIMALS };
