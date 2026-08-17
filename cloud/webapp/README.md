# Koinos Cloud Node — web app (testing front-end / PWA seed)

A single-page, installable web app to run your own cloud block producer: it talks
to a [core-agent](../core-agent) to provision/stop/start/delete your producer, and
to a Koinos RPC to register the node's key and burn KOIN→VHP — all with your key
staying **in your browser**. This is the seed of the eventual phone PWA; for now
it's a testing tool.

```
webapp/
├── index.html            # UI (mobile-first, dark, installable)
├── app.js                # logic (talks to core-agent + Koinos RPC via koilib)
├── manifest.webmanifest  # PWA manifest
├── icon.svg
└── vendor/
    ├── koinos.min.js     # vendored koilib (browser UMD build) — no CDN needed
    ├── pob-abi.json      # PoB contract ABI (register_public_key / burn / get_public_key)
    └── token-abi.json    # KOIN/VHP ABI (balance_of / approve)
```

Self-contained (no build step, no CDN). It mirrors `electron/lib/chain.js` so the
on-chain behavior (register, burn) matches the desktop app.

## Serve it

Any static server; it must be served over http(s) (not `file://`) so `fetch`
works. **This can't be a claude.ai Artifact** — the strict Artifact CSP blocks the
cross-origin calls to your core-agent and RPC.

```bash
cd cloud/webapp
python3 -m http.server 8099        # then open http://localhost:8099
```

For real use, host it on any static host (Netlify/Vercel/GitHub Pages/S3) — it's
just files. Serve over HTTPS to make it installable as a PWA.

## Use it (testing flow)

1. **Connection settings** → your core-agent URL (e.g. `http://your-core-host:3738`),
   its token, and a Koinos RPC (default `https://api.koinos.io`). Save.
   - The core-agent already sends CORS headers so the browser can call it.
2. **Wallet** → *Generate new* (or *Import WIF*). Use a **throwaway/test wallet** —
   keys are stored in this browser. Export/back up the WIF.
3. **Start my node** → provisions a producer on the shared core and shows its
   **block-signing public key**.
4. **Register key with wallet** → signs `register_public_key` with your wallet and
   broadcasts, authorizing the node to produce for your address.
5. **Burn KOIN → VHP** → gives the producer virtual hash power so it actually wins
   slots. Rewards mint to your address.
6. **Pause / Resume / Delete** manage the node; status + core-sync + registration
   refresh automatically.

To fund the wallet with KOIN in the first place, use the desktop app's **Fund**
flow (ETH→KOIN) or any exchange/on-ramp, then send KOIN to the address shown here.

## Security notes (testing build)

- Your **main key never leaves the browser**; only the node's **public** key is
  sent to the agent. The agent never sees a private key.
- Keys are kept in `localStorage` for convenience while testing — **not** the
  eventual security model (the productized app will generate/store keys more
  securely, e.g. WebCrypto + IndexedDB, or a hardware/mobile keystore).
- No payment gate — free while testing. Billing (PayPal) comes later via the
  control plane in front of the agent.

## Validated

Smoke-tested in headless Chromium: the vendored koilib loads in-browser, a wallet
generates a valid address, and **Start my node** provisions a real producer on a
live shared core and returns its public key — with no page errors. The on-chain
register/burn steps need a funded wallet and are exercised against mainnet RPC.
