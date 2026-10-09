"use strict";

// Lets the agent bridge drive a real EVE client. Two hunks in the login
// handshake, both inert until the bridge installs its hook:
//
// - A client started with /ssoToken=<token> sends that token in the login
//   dict. When the bridge minted it, the hook names the token's account and
//   supplies its stored hash, so the stock checks that follow log it in. Any
//   other login is untouched.
// - The client runs the handshake's signedFunc expression at login. For a
//   client that logged in with a minted token, the hook wraps that expression
//   so it also starts the bridge's client agent (bridge/client.js).
//
// Opt-in: setup never applies it, because it runs server-sent code in the client.

const TARGET = "network/tcp/handshake.js";
const HOOK = "globalThis[Symbol.for(\"gridcheck.clientAgent.v1\")]";

module.exports = {
  id: "client-agent",
  version: 1,
  optIn: true,
  title: "a gridcheck-launched EVE client logs in by token and runs the client agent",
  headline: "Drive a real EVE client",
  gain: "`gridcheck client launch` starts the EVE client logged in and in game, and `gridcheck client eval` runs Python inside it.",
  without: "Gridcheck flies headless characters only.",
  hunks: [
    {
      file: TARGET,
      anchor: ["const loginData = decoded[1];"],
      insert: "after",
      lines: [
        `    const gridcheckClientLogin = ${HOOK};`,
        "    if (gridcheckClientLogin) gridcheckClientLogin.resolveLogin(loginData, { accountStore, dictGet, strVal });",
      ],
    },
    {
      file: TARGET,
      anchor: [
        "const expr = 'eval(compile(\"' + pyCode + '\", \"<tidi>\", \"exec\"))';",
        "return buildMarshaledString(expr);",
      ],
      insert: "after",
      at: 0,
      lines: [
        `  const gridcheckClientFunc = ${HOOK};`,
        "  if (gridcheckClientFunc) return buildMarshaledString(gridcheckClientFunc.wrapLoginExpression(expr, clientId));",
      ],
    },
  ],
  // No tree ships this hook, so only an unmarked copy of these lines counts.
  detect({ read }) {
    const text = read(TARGET);
    return text !== null && text.includes("gridcheck.clientAgent.v1");
  },
};
