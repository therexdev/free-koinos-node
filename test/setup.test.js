"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { decodeWinText } = require("../electron/lib/setup");

// Regression test for the WSL "restart loop": wsl.exe prints UTF-16LE, which
// Node decodes as UTF-8 into "W\0S\0L\0…" so /wsl/ never matched, leaving
// detection stuck at not-installed after a reboot.

test("decodes UTF-16LE wsl.exe output so /wsl/ matches", () => {
  const buf = Buffer.from("WSL version: 2.2.4.0", "utf16le");
  const text = decodeWinText(buf);
  assert.equal(text, "WSL version: 2.2.4.0");
  assert.ok(/wsl/i.test(text));
});

test("raw UTF-8 decode of the same bytes is what the old code failed on", () => {
  // Demonstrates the bug: reading UTF-16LE bytes as UTF-8 interleaves NULs.
  const raw = Buffer.from("WSL", "utf16le").toString("utf8");
  assert.ok(!/wsl/i.test(raw), "interleaved NULs should defeat a naive match");
  assert.ok(/wsl/i.test(decodeWinText(Buffer.from("WSL", "utf16le"))));
});

test("strips a leading UTF-16LE BOM", () => {
  const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("WSL version: 2.0", "utf16le")]);
  assert.equal(decodeWinText(buf), "WSL version: 2.0");
});

test("passes plain UTF-8 through unchanged", () => {
  const buf = Buffer.from("Docker version 27.0.3", "utf8");
  assert.equal(decodeWinText(buf), "Docker version 27.0.3");
});

test("handles empty / missing input", () => {
  assert.equal(decodeWinText(Buffer.alloc(0)), "");
  assert.equal(decodeWinText(null), "");
  assert.equal(decodeWinText(undefined), "");
});

test("decodes a realistic multi-line UTF-16LE --status output", () => {
  const status = "Default Version: 2\r\nWSL is installed\r\n";
  assert.ok(/(default version|wsl)/i.test(decodeWinText(Buffer.from(status, "utf16le"))));
});
