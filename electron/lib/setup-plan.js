"use strict";

// Pure logic for the guided requirements setup. Given what's detected on the
// machine, produce an ordered list of steps with a status and (optionally) a
// one-click action. No side effects — unit tested across platforms.

// Docker Desktop / Engine download + docs URLs.
const DOCKER_DOCS = {
  win32: "https://docs.docker.com/desktop/install/windows-install/",
  darwin: "https://docs.docker.com/desktop/install/mac-install/",
  linux: "https://docs.docker.com/engine/install/",
};

function dockerAsset(platform, arch) {
  if (platform === "win32") {
    const a = arch === "arm64" ? "arm64" : "amd64";
    return {
      kind: "exe",
      filename: "DockerDesktopInstaller.exe",
      url: `https://desktop.docker.com/win/main/${a}/Docker%20Desktop%20Installer.exe`,
    };
  }
  if (platform === "darwin") {
    const a = arch === "arm64" ? "arm64" : "amd64";
    return {
      kind: "dmg",
      filename: "Docker.dmg",
      url: `https://desktop.docker.com/mac/main/${a}/Docker.dmg`,
    };
  }
  return null; // Linux installs Docker Engine via the distro, not a single asset.
}

// The WSL feature install, run elevated. Passed to wsl.exe.
const WSL_INSTALL_ARGS = ["--install", "--no-distribution"];

function computeSetupPlan({ platform, wsl = {}, docker = {} } = {}) {
  const steps = [];

  if (platform === "win32") {
    // Step 1: WSL 2 (Docker Desktop's engine needs it).
    if (wsl.installed) {
      steps.push(step("wsl", "WSL 2 is installed", "The Windows Subsystem for Linux is ready.", "done"));
    } else if (wsl.rebootPending) {
      steps.push(step(
        "wsl",
        "Restart Windows to finish enabling WSL 2",
        "WSL was installed. Restart Windows, then reopen the app — setup continues automatically. If you already restarted and this still shows, click “Already restarted”.",
        "reboot",
        { channel: "setup:restart", label: "Restart Windows" },
        { channel: "setup:markWslReady", label: "Already restarted" }
      ));
    } else {
      steps.push(step(
        "wsl",
        "Enable WSL 2",
        "One click installs the Windows Subsystem for Linux (Windows will ask for permission). No command line needed.",
        "active",
        { channel: "setup:installWsl", label: "Enable WSL" }
      ));
    }
  }

  // Docker install + start steps (all platforms).
  const wslReady = platform !== "win32" || !!wsl.installed;

  if (platform === "linux") {
    if (docker.running) {
      steps.push(step("docker", "Docker is running", "Docker Engine is installed and running.", "done"));
    } else if (docker.installed) {
      steps.push(step(
        "docker-start",
        "Start the Docker service",
        "Docker is installed but the daemon isn't running. Start it, e.g. `sudo systemctl start docker`.",
        "manual",
        { channel: "setup:openDockerDocs", label: "Docker docs" }
      ));
    } else {
      steps.push(step(
        "docker",
        "Install Docker Engine",
        "Follow the official install for your Linux distribution, then make sure your user can run Docker.",
        "manual",
        { channel: "setup:openDockerDocs", label: "Install guide" }
      ));
    }
    return finalize(steps);
  }

  // Windows / macOS: Docker Desktop.
  if (docker.installed) {
    steps.push(step("docker", "Docker Desktop is installed", "The Docker Desktop app is installed.", "done"));
  } else if (!wslReady) {
    steps.push(step(
      "docker",
      "Install Docker Desktop",
      "Available after WSL is enabled above.",
      "pending"
    ));
  } else {
    steps.push(step(
      "docker",
      "Install Docker Desktop",
      "Downloads the official Docker Desktop installer and launches it for you — no need to find it yourself. It's free.",
      "active",
      { channel: "setup:installDocker", label: "Install Docker Desktop" }
    ));
  }

  // Start Docker.
  if (docker.running) {
    steps.push(step("docker-start", "Docker is running", "Docker Desktop is running and ready.", "done"));
  } else if (docker.installed) {
    steps.push(step(
      "docker-start",
      "Start Docker Desktop",
      "Docker Desktop is installed but not running yet. Start it — the first launch can take a minute.",
      "active",
      { channel: "setup:startDocker", label: "Start Docker" }
    ));
  } else {
    steps.push(step("docker-start", "Start Docker Desktop", "Available after Docker Desktop is installed.", "pending"));
  }

  return finalize(steps);
}

function step(key, title, detail, status, action = null, altAction = null) {
  return { key, title, detail, status, action, altAction };
}

function finalize(steps) {
  const ready = steps.every((s) => s.status === "done");
  // The step the user should act on next (first non-done with an action).
  const active = steps.find((s) => s.action && s.status !== "done" && s.status !== "pending") ?? null;
  return { ready, steps, activeKey: active?.key ?? null };
}

module.exports = { computeSetupPlan, dockerAsset, DOCKER_DOCS, WSL_INSTALL_ARGS };
