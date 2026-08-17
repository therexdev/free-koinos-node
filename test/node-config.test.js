"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { buildEnv, buildConfigYml, parseComposePs } = require("../electron/lib/node-manager");
const { NETWORKS } = require("../electron/lib/constants");

const ADDR = "1L62VUwpA28dkaZ5mHKGdLmrxeYduBFBBu";

test("env for a producing mainnet node", () => {
  const env = buildEnv(NETWORKS.mainnet, "/data/basedir", true);
  assert.match(env, /^BASEDIR=\/data\/basedir$/m);
  assert.match(env, /^COMPOSE_PROFILES=jsonrpc,account_history,block_producer$/m);
  assert.match(env, /^JSONRPC_PORT=8080$/m);
  assert.match(env, /^P2P_PORT=8888$/m);
  assert.match(env, /^CHAIN_TAG=v1\.5\.2$/m);
});

test("env for a sync-only harbinger node", () => {
  const env = buildEnv(NETWORKS.harbinger, "/data/hb", false);
  assert.match(env, /^COMPOSE_PROFILES=jsonrpc,account_history$/m);
  assert.match(env, /^JSONRPC_PORT=8081$/m);
  assert.match(env, /^P2P_PORT=8889$/m);
  assert.match(env, /^CHAIN_TAG=v1\.4\.1$/m);
  assert.doesNotMatch(env, /block_producer/);
});


test("account_history runs with the API tier so our node serves its own history", () => {
  // The dashboard, reward returns and community distribution all read block
  // reward/burn history; without this service the local node cannot answer and
  // the app is stuck depending on a public endpoint.
  assert.match(buildEnv(NETWORKS.mainnet, "/d", false), /^COMPOSE_PROFILES=jsonrpc,account_history$/m);
  // …but memory-saver exists to drop the optional tier on a small machine.
  assert.match(buildEnv(NETWORKS.mainnet, "/d", true, true), /^COMPOSE_PROFILES=block_producer$/m);
  assert.match(buildEnv(NETWORKS.mainnet, "/d", false, true), /^COMPOSE_PROFILES=$/m);
});

test("config.yml embeds the producer address when producing", () => {
  const yml = buildConfigYml(NETWORKS.mainnet, ADDR);
  assert.match(yml, /algorithm: pob/);
  assert.match(yml, new RegExp(`^  producer: ${ADDR}`, "m"));
  assert.match(yml, /seed\.koinosblocks\.com/);
  assert.match(yml, /fork-algorithm: pob/);
});

test("config.yml keeps producer commented without an address", () => {
  const yml = buildConfigYml(NETWORKS.mainnet, null);
  assert.match(yml, /^  # producer:/m);
});

test("harbinger config uses harbinger seeds", () => {
  const yml = buildConfigYml(NETWORKS.harbinger, ADDR);
  assert.match(yml, /harbinger-seed\.koinos\.io/);
  assert.doesNotMatch(yml, /seed\.koinosblocks\.com/);
});

test("parseComposePs handles json-lines and array output", () => {
  const lines = `{"Name":"koinos-chain-1","Service":"chain","State":"running","Status":"Up 2 minutes"}
{"Name":"koinos-p2p-1","Service":"p2p","State":"running","Status":"Up 2 minutes"}`;
  const a = parseComposePs(lines);
  assert.equal(a.length, 2);
  assert.equal(a[0].service, "chain");
  assert.equal(a[1].state, "running");

  const arr = JSON.stringify([{ Name: "x", Service: "amqp", State: "exited", Status: "Exited (0)" }]);
  const b = parseComposePs(arr);
  assert.equal(b.length, 1);
  assert.equal(b[0].service, "amqp");

  assert.deepEqual(parseComposePs(""), []);
});
