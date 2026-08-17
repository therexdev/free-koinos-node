"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { computeSetupPlan, dockerAsset, WSL_INSTALL_ARGS } = require("../electron/lib/setup-plan");

const keys = (plan) => plan.steps.map((s) => `${s.key}:${s.status}`);

test("windows: fresh machine needs WSL first, Docker steps wait", () => {
  const plan = computeSetupPlan({ platform: "win32", wsl: { installed: false }, docker: { installed: false } });
  assert.deepEqual(keys(plan), ["wsl:active", "docker:pending", "docker-start:pending"]);
  assert.equal(plan.activeKey, "wsl");
  assert.equal(plan.ready, false);
  assert.equal(plan.steps[0].action.channel, "setup:installWsl");
});

test("windows: WSL install pending reboot", () => {
  const plan = computeSetupPlan({
    platform: "win32",
    wsl: { installed: false, rebootPending: true },
    docker: { installed: false },
  });
  assert.equal(plan.steps[0].status, "reboot");
  assert.equal(plan.steps[0].action.channel, "setup:restart");
  assert.equal(plan.activeKey, "wsl");
});

test("windows: WSL ready, Docker not installed -> install active", () => {
  const plan = computeSetupPlan({ platform: "win32", wsl: { installed: true }, docker: { installed: false } });
  assert.deepEqual(keys(plan), ["wsl:done", "docker:active", "docker-start:pending"]);
  assert.equal(plan.activeKey, "docker");
  assert.equal(plan.steps[1].action.channel, "setup:installDocker");
});

test("windows: Docker installed but not running -> start active", () => {
  const plan = computeSetupPlan({
    platform: "win32",
    wsl: { installed: true },
    docker: { installed: true, running: false },
  });
  assert.deepEqual(keys(plan), ["wsl:done", "docker:done", "docker-start:active"]);
  assert.equal(plan.steps[2].action.channel, "setup:startDocker");
  assert.equal(plan.ready, false);
});

test("windows: everything ready", () => {
  const plan = computeSetupPlan({
    platform: "win32",
    wsl: { installed: true },
    docker: { installed: true, running: true },
  });
  assert.deepEqual(keys(plan), ["wsl:done", "docker:done", "docker-start:done"]);
  assert.equal(plan.ready, true);
  assert.equal(plan.activeKey, null);
});

test("macOS: no WSL step; Docker install then start", () => {
  const plan = computeSetupPlan({ platform: "darwin", docker: { installed: false } });
  assert.deepEqual(keys(plan), ["docker:active", "docker-start:pending"]);
  assert.ok(!plan.steps.some((s) => s.key === "wsl"));
});

test("linux: single manual Docker step with docs link", () => {
  const notInstalled = computeSetupPlan({ platform: "linux", docker: { installed: false } });
  assert.deepEqual(keys(notInstalled), ["docker:manual"]);
  assert.equal(notInstalled.steps[0].action.channel, "setup:openDockerDocs");

  const running = computeSetupPlan({ platform: "linux", docker: { installed: true, running: true } });
  assert.equal(running.ready, true);
});

test("dockerAsset builds per-platform URLs", () => {
  assert.match(dockerAsset("win32", "x64").url, /win\/main\/amd64\/Docker%20Desktop%20Installer\.exe$/);
  assert.match(dockerAsset("win32", "arm64").url, /win\/main\/arm64\//);
  assert.match(dockerAsset("darwin", "arm64").url, /mac\/main\/arm64\/Docker\.dmg$/);
  assert.match(dockerAsset("darwin", "x64").url, /mac\/main\/amd64\/Docker\.dmg$/);
  assert.equal(dockerAsset("linux", "x64"), null);
});

test("WSL install args are non-interactive and distro-free", () => {
  assert.deepEqual(WSL_INSTALL_ARGS, ["--install", "--no-distribution"]);
});
