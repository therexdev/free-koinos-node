"use strict";

// Shared helpers for talking to the mana-sponsor relayer: resolve its endpoint,
// read its Koinos address, and co-sign+broadcast a user-signed transaction. The
// original BridgeOrchestrator has its own inline copies (left untouched so Route B
// keeps working); Route C uses these standalone functions.

const DEFAULT_SPONSOR_ENDPOINT = "https://koinos-node.vercel.app/api/sponsor";

function sponsorEndpoint(settings) {
  const override = settings.get("sponsorEndpoint", "");
  if (override) return override;
  const onramp = settings.get("onrampEndpoint", "");
  if (onramp) return onramp.replace(/\/[^/]*$/, "/sponsor");
  return DEFAULT_SPONSOR_ENDPOINT;
}

async function fetchSponsorAddress(settings) {
  const resp = await fetch(sponsorEndpoint(settings), { method: "GET" });
  if (!resp.ok) throw new Error(`Sponsor endpoint HTTP ${resp.status}`);
  const data = await resp.json();
  if (!data.address) throw new Error("Sponsor endpoint returned no address");
  return data.address;
}

async function coSignAndBroadcast(settings, appKey, transaction) {
  const resp = await fetch(sponsorEndpoint(settings), {
    method: "POST",
    headers: { "content-type": "application/json", "x-koinoskit-app": appKey },
    body: JSON.stringify({ transaction }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.ok) throw new Error(data.error || `Relayer HTTP ${resp.status}`);
  return data;
}

module.exports = { DEFAULT_SPONSOR_ENDPOINT, sponsorEndpoint, fetchSponsorAddress, coSignAndBroadcast };
