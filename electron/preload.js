"use strict";

const { contextBridge, ipcRenderer } = require("electron");

const CHANNELS = new Set([
  "app:info",
  "settings:update",
  "wallet:status",
  "wallet:create",
  "wallet:import",
  "wallet:unlock",
  "wallet:lock",
  "wallet:revealWif",
  "wallet:remove",
  "chain:balances",
  "chain:burn",
  "chain:send",
  "chain:sync",
  "chain:maxBurn",
  "producer:status",
  "producer:register",
  "node:status",
  "node:start",
  "node:stop",
  "node:setAutoRecover",
  "node:logs",
  "node:quickSyncInfo",
  "node:quickSync",
  "node:quickSyncCancel",
  "setup:status",
  "setup:installWsl",
  "setup:restart",
  "setup:cancelRestart",
  "setup:installDocker",
  "setup:cancelInstallDocker",
  "setup:startDocker",
  "setup:markWslReady",
  "setup:openDockerDocs",
  "dashboard:summary",
  "rewards:status",
  "rewards:configure",
  "rewards:runNow",
  "distribution:status",
  "distribution:configure",
  "distribution:runNow",
  "distribution:distributeNow",
  "fund:status",
  "fund:buyUrl",
  "fund:ethBalance",
  "fund:bridgeStatus",
  "fund:bridgeStart",
  "fund:bridgeQuote",
  "fund:bridgeMax",
  "fund:bridgeAdvance",
  "fund:bridgeReset",
  "fund:routeCompare",
  "fund:routeCStart",
  "fund:routeCStatus",
  "fund:routeCAdvance",
  "fund:routeCReset",
  "fund:routeCResume",
  "fund:cryptoBalances",
  "fund:usdtSendQuote",
  "fund:usdtSendMax",
  "fund:usdtSend",
  "fund:usdtFundQuote",
  "fund:vkoinSendQuote",
  "fund:vkoinSendMax",
  "fund:vkoinSend",
  "fund:routeMaxEth",
  "fund:ethSendQuote",
  "fund:ethSendMax",
  "fund:ethSend",
  "util:copy",
  "util:qr",
  "util:openExternal",
  "util:openPath",
]);

contextBridge.exposeInMainWorld("koinos", {
  invoke: (channel, payload) => {
    if (!CHANNELS.has(channel)) {
      return Promise.resolve({ ok: false, error: `Unknown channel: ${channel}` });
    }
    return ipcRenderer.invoke(channel, payload);
  },
  onEvent: (cb) => {
    const listener = (_evt, data) => cb(data);
    ipcRenderer.on("app:event", listener);
    return () => ipcRenderer.removeListener("app:event", listener);
  },
});
