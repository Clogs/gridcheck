"use strict";

// Stock EveJS opens its XMPP chat listener on a fixed port, so two trees
// can't run at once. This patch makes EVEJS_XMPP_SERVER_PORT move it.
// `detect` finds equivalent code without the patch's marker (the LU fork has
// its own).

const TARGET = "edge/chat/chatEdgeRuntime.js";

module.exports = {
  id: "xmpp-port",
  version: 1,
  title: "EVEJS_XMPP_SERVER_PORT moves the XMPP chat listener",
  files: [TARGET],
  detect({ read }) {
    const text = read(TARGET);
    return text !== null && text.includes("EVEJS_XMPP_SERVER_PORT");
  },
};
