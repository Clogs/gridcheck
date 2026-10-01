"use strict";

// Shim: the agent bridge lives in tools/evejs-e2e/bridge/. Loading it costs
// nothing until EVEJS_AGENT_BRIDGE=1 starts it. `e2e vendor update` installs
// this file from tools/evejs-e2e/bridge/shim.js and `e2e vendor check` fails
// if it differs, so change it in the evejs-e2e repo.
const path = require("path");

const SERVER_ROOT = path.resolve(__dirname, "..", "..", "..");

module.exports = require(path.join(SERVER_ROOT, "..", "tools", "evejs-e2e", "bridge", "entry.js"))
  .createService({ serverRoot: SERVER_ROOT });
