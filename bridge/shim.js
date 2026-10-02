"use strict";

// Shim: the agent bridge lives in tools/gridcheck/bridge/. Loading it costs
// nothing until EVEJS_AGENT_BRIDGE=1 starts it. `gridcheck vendor update` installs
// this file from tools/gridcheck/bridge/shim.js and `gridcheck vendor check` fails
// if it differs, so change it in the Gridcheck repo.
const path = require("path");

const SERVER_ROOT = path.resolve(__dirname, "..", "..", "..");

module.exports = require(path.join(SERVER_ROOT, "..", "tools", "gridcheck", "bridge", "entry.js"))
  .createService({ serverRoot: SERVER_ROOT });
