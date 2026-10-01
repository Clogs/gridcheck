"use strict";

// The X-Eve Living Universe mod's half of the e2e tool. Nothing here loads the
// mod until server(ctx) runs, and that runs only in a tree that has it.

// What a tree needs for this plugin; none of these exist in stock EveJS.
const REQUIRED = [
  "modApi",
  "space/npc/ambientTraffic/livingUniverseRuntime",
  "_secondary/pirateScouts",
];

module.exports = {
  name: "lu",
  apiVersion: 1,
  applies({ resolve }) {
    const missing = REQUIRED.find((relativePath) => !resolve(relativePath));
    return missing ? { ok: false, reason: `no Living Universe in this tree (no server/src/${missing}.js)` } : true;
  },
  server(ctx) {
    return require("./server").createLuServer(ctx);
  },
};
