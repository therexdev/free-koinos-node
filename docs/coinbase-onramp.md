# Set up the "Buy ETH with Coinbase" button

The Fund node tab can open Coinbase Pay with your ETH address pre-filled. Since
mid-2025 Coinbase requires the purchase to be authorized by a **session token**
that is minted with your **CDP secret key** — so it can't live inside the
desktop app. You deploy a tiny endpoint that mints those tokens and paste its
URL into KoinosKit.

You do this once. It's free, you don't need a business, and you don't earn or
pay anything — Coinbase charges the buyer directly.

> Don't want to bother? You can skip all of this. Just use the ETH address shown
> in the Fund tab and send ETH to it from any exchange or wallet.

## 1. Get a free Coinbase Developer (CDP) key

1. Go to the [CDP Portal](https://portal.cdp.coinbase.com/) and sign in (email + 2FA — an individual account is fine).
2. Create a **Secret API Key**. You'll get a **key id** and a **key secret**.
3. Keep both somewhere safe — you'll paste them as environment variables next.

## 2. Deploy the endpoint (Vercel — easiest, free)

The endpoint is in this repo under [`onramp-endpoint/`](../onramp-endpoint). It's
one function (`api/session.js`) plus a `package.json`.

**Option A — Vercel web (no terminal):**
1. Put the `onramp-endpoint/` folder in its own GitHub repo (or fork this one).
2. On [vercel.com](https://vercel.com), **Add New → Project**, import that repo, set the **Root Directory** to `onramp-endpoint`.
3. Under **Environment Variables**, add:
   - `CDP_API_KEY_ID` = your CDP key id
   - `CDP_API_KEY_SECRET` = your CDP key secret
   - `ONRAMP_SHARED_SECRET` = `kkapp_71854dc40591df1aeb8811a514e3dbc302bb382f` (**required** — the app key KoinosKit sends in the `x-koinoskit-app` header; the endpoint rejects callers that don't send it, and refuses to mint tokens at all if this variable is unset. Coinbase's [security requirements](https://docs.cdp.coinbase.com/onramp/security-requirements) mandate authenticating callers before requesting a session token.)
   - `ALLOW_ORIGIN` (optional) — only needed if you call the endpoint from a web page. Must be an explicit origin like `https://yourapp.example`; a `*` wildcard is never emitted (also a Coinbase security requirement). The desktop app doesn't need CORS, so normally leave this unset.
4. **Deploy.** Your endpoint URL will be `https://<your-project>.vercel.app/api/session`.

> **App-owner note:** the desktop app ships with a built-in default endpoint of
> `https://koinos-node.vercel.app/api/session` (`DEFAULT_ONRAMP_ENDPOINT` in
> `electron/main.js`), served by the owner's Vercel project **koinos-node**.
> Vercel redeploys production whenever its configured **Production Branch**
> (Settings → Git) is pushed — changes to `onramp-endpoint/` only reach the
> live endpoint once they land on that branch. If the endpoint ever moves to a
> different project name or a custom domain (e.g. `api.koinoskit.site`),
> update that constant — and `DEFAULT_SPONSOR_ENDPOINT` in
> `electron/lib/sponsor-relay.js` and `electron/lib/bridge-orchestrator.js` —
> to match.

**Option B — Vercel CLI:**
```bash
cd onramp-endpoint
npm install
npm i -g vercel
vercel            # follow prompts
vercel env add CDP_API_KEY_ID
vercel env add CDP_API_KEY_SECRET
vercel --prod
```

(The same function works on Netlify or any Node serverless host — it just needs
the two env vars and Node 18+. Cloudflare Workers use a different runtime, so
prefer a Node host.)

## 3. Paste the URL into KoinosKit

In the app: **Fund node → Coinbase Onramp endpoint**, paste
`https://<your-project>.vercel.app/api/session`, and **Save**. The "Buy ETH with
Coinbase" button now works.

## Test it

```bash
curl -s -X POST https://<your-project>.vercel.app/api/session \
  -H 'content-type: application/json' \
  -H 'x-koinoskit-app: kkapp_71854dc40591df1aeb8811a514e3dbc302bb382f' \
  -d '{"address":"0x0000000000000000000000000000000000000000","asset":"ETH","network":"ethereum"}'
```
A healthy response looks like `{"token":"..."}`. Errors come back as
`{"error":"..."}` with the reason — without the `x-koinoskit-app` header you
should get `{"error":"Unauthorized"}`, which means the auth check is working.

## The function

See [`onramp-endpoint/api/session.js`](../onramp-endpoint/api/session.js). It:
1. reads the ETH address from the request,
2. generates a CDP JWT with `generateJwt` from `@coinbase/cdp-sdk`,
3. calls `POST https://api.developer.coinbase.com/onramp/v1/token` with
   `{ addresses: [{ address, blockchains: ["ethereum"] }], assets: ["ETH"] }`,
4. returns `{ token }`.

The desktop app then opens
`https://pay.coinbase.com/buy/select-asset?sessionToken=<token>&defaultAsset=ETH&defaultNetwork=ethereum`.

## Notes & security

- The secret key lives **only** in your endpoint's environment variables, never in the app.
- Callers are authenticated **before** the endpoint asks Coinbase for a session token: the `x-koinoskit-app` app key is required, requests are rate-limited per IP, and a deployment without `ONRAMP_SHARED_SECRET` fails closed. `Access-Control-Allow-Origin` is never `*`. Both are Coinbase [Onramp security requirements](https://docs.cdp.coinbase.com/onramp/security-requirements).
- The endpoint only mints session tokens for an address the caller supplies; it can't move funds.
- Session tokens expire after ~5 minutes, which is why they're minted on demand each time you click Buy.
- Coinbase Onramp availability and payment methods depend on the buyer's region; the hosted Coinbase Pay page handles all KYC/limits.
- Source of truth for the API: Coinbase's official [onramp-demo-application](https://github.com/coinbase/onramp-demo-application) and [Create session token](https://docs.cdp.coinbase.com/api-reference/rest-api/onramp-offramp/create-session-token) docs. If Coinbase changes the SDK import path or fields, follow the demo.
