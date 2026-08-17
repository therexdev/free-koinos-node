# Mana relayer (sponsor endpoint)

Coinbase gets users ETH; the bridge gets them vETH on Koinos — but a brand-new
account has **no KOIN, so no mana**, and can't sign the redeem or swap. This
endpoint fixes that: the user signs their transaction as **payee**, and this
endpoint co-signs as **payer** with your sponsor wallet, paying the mana. It only
co-signs transactions that do the specific operations we're willing to pay for.

Same idea and safety model as your marketplace's server-side co-signer.

## Deploy

It lives in the **same Vercel project** as the Coinbase function
(`onramp-endpoint/`), as `api/sponsor.js` — so just **redeploy** to pick it up
(it also pulls in `koilib`, now in `package.json`).

## Environment variables

| Var | Required | Purpose |
|---|---|---|
| `KOINOS_SPONSOR_WIF` | ✅ | Sponsor wallet WIF (pays mana). |
| `ONRAMP_SHARED_SECRET` | ✅ | Same app key as the Coinbase endpoint. POST fails closed without it. |
| `SPONSOR_RC_MAX` | optional | Per-tx mana ceiling in satoshis (default `500000000` = 5 KOIN). |
| `KOINOS_NETWORK` | optional | `mainnet` (default). |
| `KOINOS_RPC` | optional | Comma-separated RPC override (default `https://api.koinos.io`). |

## Endpoints

- **`GET /api/sponsor`** → `{ "address": "1…", "network": "mainnet" }` — the app fetches this to set the transaction's payer.
- **`POST /api/sponsor`** with `{ "transaction": <user-signed tx> }` and the `x-koinoskit-app` header → validates, co-signs as payer, broadcasts, returns `{ ok, id, receipt }`.

## Safety rails (what protects your sponsor wallet)

- **payer must be the sponsor**, **payee must be the user** (not the sponsor).
- **Every operation must be allowlisted** — currently `complete_transfer` on the Vortex bridge; KoinDX approve+swap are added in Phase 2.5. Nothing else is co-signed.
- **`rc_limit` is capped** at `SPONSOR_RC_MAX`.
- **The payee must already have signed** the transaction (verified via signature recovery).
- **Rate limited** per payee (6/hr) and per IP (30/hr).

Remember: the sponsor spends **mana, not KOIN** — the balance stays put and the mana regenerates (~20%/day). Keep a little liquid KOIN in the wallet for headroom.

## Quick check after deploy

```bash
curl -s https://<your-project>.vercel.app/api/sponsor
```
Should return your sponsor wallet's `address`.
