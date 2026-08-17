"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseSha256File, analyzeMembers, requiredSpace, fmtBytes } = require("../electron/lib/quicksync-utils");

test("parseSha256File extracts the digest and ignores the host path", () => {
  const digest = parseSha256File(
    "0e6f6b555382ce22916cb31273a352ec2da0dc3c4f88d998fd6d889fab0da32b  /mnt/HC_Volume/backups/koinos-backup.tar.gz\n"
  );
  assert.equal(digest, "0e6f6b555382ce22916cb31273a352ec2da0dc3c4f88d998fd6d889fab0da32b");
  assert.throws(() => parseSha256File("not-a-checksum file"), /unexpected format/);
  assert.throws(() => parseSha256File(""), /unexpected format/);
});

test("analyzeMembers accepts the documented .koinos/ layout", () => {
  const r = analyzeMembers(
    [".koinos/", ".koinos/chain/", ".koinos/chain/data.mdb", ".koinos/block_store/", ".koinos/block_store/x.sst"].join("\n")
  );
  assert.deepEqual(r, { ok: true, prefix: ".koinos/" });
});

test("analyzeMembers accepts a bare top-level layout", () => {
  const r = analyzeMembers(["chain/", "chain/a", "block_store/", "block_store/b"].join("\n"));
  assert.deepEqual(r, { ok: true, prefix: "" });
});

test("analyzeMembers rejects absolute and traversal paths", () => {
  assert.equal(analyzeMembers("/etc/passwd\n.koinos/chain/").ok, false);
  assert.equal(analyzeMembers(".koinos/chain/../../evil\n.koinos/block_store/").ok, false);
  assert.match(analyzeMembers("..\n").error, /Unsafe/);
});

test("analyzeMembers rejects missing or mismatched directories", () => {
  assert.match(analyzeMembers(".koinos/chain/\n").error, /chain\/ and block_store\//);
  assert.equal(analyzeMembers("a/chain/\nb/block_store/\n").ok, false);
  assert.match(analyzeMembers("").error, /empty/);
});

test("requiredSpace and fmtBytes", () => {
  assert.equal(requiredSpace(100), 260);
  assert.equal(fmtBytes(60976064163), "61.0 GB");
  assert.equal(fmtBytes(1500000), "1.5 MB");
  assert.equal(fmtBytes("garbage"), "?");
});
