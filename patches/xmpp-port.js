"use strict";

// Stock EveJS opens its XMPP chat listener on a fixed port (5222), so two
// trees can't run at once. This patch makes EVEJS_XMPP_SERVER_PORT move it,
// through the `port` option the chat edge runtime already takes; the chat
// worker binds whatever port the runtime hands it. `detect` finds equivalent
// code without the patch's marker (the LU fork has its own).

const TARGET = "edge/chat/chatEdgeRuntime.js";

module.exports = {
  id: "xmpp-port",
  version: 1,
  title: "EVEJS_XMPP_SERVER_PORT moves the XMPP chat listener",
  headline: "Run two servers side by side",
  gain: "Each tree's chat listener gets its own port. `gridcheck up` picks it for you, so two stock trees can run at the same time.",
  without: "Every tree wants chat port `5222`, so only one server can be up at a time.",
  hunks: [{
    file: TARGET,
    anchor: ["const address = Object.freeze({"],
    insert: "before",
    lines: [
      "  if (!Object.prototype.hasOwnProperty.call(options, \"port\") && process.env.EVEJS_XMPP_SERVER_PORT) {",
      "    options = { ...options, port: process.env.EVEJS_XMPP_SERVER_PORT };",
      "  }",
    ],
  }],
  detect({ read }) {
    const text = read(TARGET);
    return text !== null && text.includes("EVEJS_XMPP_SERVER_PORT");
  },
};
