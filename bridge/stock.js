"use strict";

// The stock EveJS modules the bridge reads, by path under the tree's
// server/src. Each loads on first use: requiring space/runtime builds the
// world, so nothing here may load while the service loader only scans.
// Every path exists in stock EveJS 0.12.9.

const path = require("node:path");

const STOCK_MODULES = Object.freeze({
  sessionRegistry: "services/chat/sessionRegistry",
  chatCommands: "services/chat/chatCommands",
  space: "space/runtime",
  worldData: "space/worldData",
  itemTypeRegistry: "services/inventory/itemTypeRegistry",
  npcRegistry: "space/npc/npcRegistry",
  killmailState: "services/killmail/killmailState",
  gameStore: "gameStore",
  marshal: "network/tcp/utils/marshal",
  logger: "utils/logger",
  webGateway: "_secondary/express/evejsWebGatewayRuntime",
});

function createStock(serverRoot, { load = require } = {}) {
  const srcRoot = path.join(serverRoot, "src");
  const stock = {};
  for (const [name, relativePath] of Object.entries(STOCK_MODULES)) {
    let loaded;
    Object.defineProperty(stock, name, {
      enumerable: true,
      get() {
        // A failed load stays retryable, as in modApi.
        if (loaded === undefined) loaded = load(path.join(srcRoot, relativePath));
        return loaded;
      },
    });
  }
  return Object.freeze(stock);
}

// A module under server/src, for code that is specific to one tree.
function serverRequire(serverRoot, { load = require } = {}) {
  const srcRoot = path.join(serverRoot, "src");
  return (relativePath) => load(path.join(srcRoot, relativePath));
}

module.exports = {
  STOCK_MODULES,
  createStock,
  serverRequire,
};
