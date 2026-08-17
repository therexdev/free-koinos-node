"use strict";

// Pure helpers for the quick-sync (backup restore) flow, following the
// safety rules from the official koinos-docs backup-restore procedure.

// The published .sha256 file's first field is the digest; the second is the
// seed host's absolute source path, which must be ignored.
function parseSha256File(text) {
  const first = String(text ?? "").trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(first)) {
    throw new Error("Published checksum file has an unexpected format");
  }
  return first.toLowerCase();
}

// Validates the archive member list (tar -tzf output) and locates the prefix
// that contains chain/ and block_store/. Rejects absolute paths and parent
// traversal outright — per the docs, an unexpected layout means stop, never
// guess.
function analyzeMembers(listText) {
  const members = String(listText ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (members.length === 0) {
    return { ok: false, error: "Archive listing is empty" };
  }
  for (const m of members) {
    if (m.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(m)) {
      return { ok: false, error: `Unsafe archive member path: ${m}` };
    }
  }
  // Find directory entries for chain/ and block_store/ and require a common
  // prefix (e.g. ".koinos/"). A top-level "chain/" (empty prefix) is fine.
  const prefixOf = (suffix) => {
    const dirs = members.filter((m) => m.endsWith(`${suffix}/`));
    if (dirs.length === 0) {
      // Some tars omit the bare directory entry; fall back to file members.
      const files = members.filter((m) => m.includes(`${suffix}/`));
      if (files.length === 0) return null;
      const idx = files[0].indexOf(`${suffix}/`);
      return files[0].slice(0, idx);
    }
    dirs.sort((a, b) => a.length - b.length);
    return dirs[0].slice(0, dirs[0].length - suffix.length - 1);
  };
  const chainPrefix = prefixOf("chain");
  const blockStorePrefix = prefixOf("block_store");
  if (chainPrefix === null || blockStorePrefix === null) {
    return { ok: false, error: "Archive does not contain chain/ and block_store/" };
  }
  if (chainPrefix !== blockStorePrefix) {
    return {
      ok: false,
      error: `chain/ and block_store/ have different prefixes ("${chainPrefix}" vs "${blockStorePrefix}")`,
    };
  }
  if (chainPrefix.includes("/") && !chainPrefix.endsWith("/")) {
    return { ok: false, error: `Unexpected archive layout prefix: ${chainPrefix}` };
  }
  return { ok: true, prefix: chainPrefix };
}

// Space needed at the staging/data volume: the compressed archive, the
// extracted copy, and headroom for the rolled-aside previous state.
function requiredSpace(archiveBytes) {
  return Math.ceil(Number(archiveBytes || 0) * 2.6);
}

function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return "?";
  if (v >= 1e12) return `${(v / 1e12).toFixed(2)} TB`;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} GB`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(0)} kB`;
  return `${v} B`;
}

module.exports = { parseSha256File, analyzeMembers, requiredSpace, fmtBytes };
