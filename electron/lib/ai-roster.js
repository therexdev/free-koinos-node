"use strict";

// Reads the live roster of Koinos AI Nodes — the addresses currently serving
// on the Koinos AI compute network — so community distribution can require
// that a node be running one to earn a share.
//
// The roster is an HTTP endpoint returning the addresses of workers seen
// recently (the KAI scheduler tracks exactly this: workers register, poll and
// heartbeat, and drop out of the roster when they go silent). This module only
// fetches and sanitizes; deciding what to do with the result belongs to the
// distribution engine.
//
// SECURITY: the roster decides who gets paid, and it is plain external data
// fetched from a URL the user configured. Everything here is written for a
// hostile response — a size cap, a timeout, address validation, and a cap on
// how many addresses one response may contribute. Point this only at a roster
// you trust; an attacker who controls it can nominate payees (they still can't
// exceed the day's profit, and they still face the VHP gate when it is on).

const MAX_BYTES = 2 * 1024 * 1024; // refuse to read a huge response body
const MAX_ADDRESSES = 5000;        // sane ceiling on one roster response
const DEFAULT_TIMEOUT_MS = 15000;

// Only https, or plain http on the loopback host (a scheduler running beside
// the app). Anything else — including http to a remote host, which would leak
// the roster query and be trivially spoofable — is refused.
function validateRosterUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s) throw new Error("No Koinos AI Node roster URL is configured");
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error("Roster URL is not a valid URL");
  }
  if (u.protocol === "https:") return u.toString();
  if (u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
    return u.toString();
  }
  throw new Error("Roster URL must be https:// (or http:// on 127.0.0.1)");
}

// Pull addresses out of the shapes a roster endpoint plausibly returns:
//   ["1abc…", "1def…"]
//   { workers:   [{ address: "1abc…", … }, …] }
//   { addresses: ["1abc…", …] }
//   { nodes: […] } / { values: […] }
// Anything else yields nothing rather than throwing — a roster that changes
// shape should degrade to "couldn't read it", which fails closed upstream.
function extractAddresses(payload) {
  const list =
    (Array.isArray(payload) && payload) ||
    (Array.isArray(payload?.workers) && payload.workers) ||
    (Array.isArray(payload?.addresses) && payload.addresses) ||
    (Array.isArray(payload?.nodes) && payload.nodes) ||
    (Array.isArray(payload?.values) && payload.values) ||
    [];
  const out = [];
  for (const item of list) {
    if (out.length >= MAX_ADDRESSES) break;
    const a = typeof item === "string" ? item : item?.address ?? item?.worker ?? item?.producer;
    if (typeof a === "string" && a.trim()) out.push(a.trim());
  }
  return out;
}

// Fetch the roster and return the valid, de-duplicated addresses on it.
// `isValidAddress` comes from ChainService so roster entries are held to the
// same checksum rules as any other address the app touches.
async function fetchAiRoster(url, { isValidAddress, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl } = {}) {
  const target = validateRosterUrl(url);
  const doFetch = fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await doFetch(target, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch (e) {
    throw new Error(`Couldn't reach the AI node roster: ${String(e?.message ?? e)}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`AI node roster returned HTTP ${res.status}`);

  const body = await res.text();
  if (body.length > MAX_BYTES) throw new Error("AI node roster response is too large");
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new Error("AI node roster did not return JSON");
  }

  const seen = new Set();
  const addresses = [];
  let rejected = 0;
  for (const a of extractAddresses(payload)) {
    if (seen.has(a)) continue;
    if (isValidAddress && !isValidAddress(a)) {
      rejected += 1;
      continue;
    }
    seen.add(a);
    addresses.push(a);
  }
  return { addresses, rejected, fetchedAt: Date.now() };
}

module.exports = { fetchAiRoster, validateRosterUrl, extractAddresses, MAX_ADDRESSES };
