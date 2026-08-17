"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAmount, formatAmount, percentOf, addSats, subSats, cmpSats } = require("../electron/lib/format");

test("parseAmount", () => {
  assert.equal(parseAmount("1"), "100000000");
  assert.equal(parseAmount("1.5"), "150000000");
  assert.equal(parseAmount("0.00000001"), "1");
  assert.equal(parseAmount("1,234.5"), "123450000000");
  assert.equal(parseAmount("0"), "0");
  assert.throws(() => parseAmount("abc"), /Invalid amount/);
  assert.throws(() => parseAmount("-1"), /Invalid amount/);
  assert.throws(() => parseAmount("1.123456789"), /decimal places/);
  assert.throws(() => parseAmount(""), /Invalid amount/);
});

test("formatAmount", () => {
  assert.equal(formatAmount("100000000"), "1");
  assert.equal(formatAmount("150000000"), "1.5");
  assert.equal(formatAmount("1"), "0.00000001");
  assert.equal(formatAmount("123450000000"), "1,234.5");
  assert.equal(formatAmount("123450000000", { grouping: false }), "1234.5");
  assert.equal(formatAmount("garbage"), "0");
});

test("parse/format roundtrip", () => {
  for (const v of ["0.1", "42", "123456.789", "0.00000001"]) {
    assert.equal(formatAmount(parseAmount(v), { grouping: false }), v);
  }
});

test("percentOf uses basis points and floors", () => {
  assert.equal(percentOf("10000000000", 50), "5000000000");
  assert.equal(percentOf("10000000000", 12.5), "1250000000");
  assert.equal(percentOf("3", 50), "1"); // floors 1.5
  assert.equal(percentOf("100", 0), "0");
  assert.equal(percentOf("100", 100), "100");
  assert.throws(() => percentOf("100", 101), /Invalid percentage/);
  assert.throws(() => percentOf("100", -1), /Invalid percentage/);
});

test("sat arithmetic", () => {
  assert.equal(addSats("1", "2"), "3");
  assert.equal(subSats("1", "2"), "-1");
  assert.equal(cmpSats("5", "3"), 1);
  assert.equal(cmpSats("3", "5"), -1);
  assert.equal(cmpSats("5", "5"), 0);
});
