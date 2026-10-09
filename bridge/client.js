"use strict";

// Client agent: lets the bridge drive a real EVE client. Needs the client-agent
// patch (patches/client-agent.js), which calls the hook this installs on
// globalThis from the login handshake.
//
// 1. `POST /client/token` mints a token for an account. The client is started
//    with /ssoToken=<token>; it sends that token in its login dict, and
//    resolveLogin names the account it was minted for.
// 2. For that login, wrapLoginExpression adds client/bootstrap.py to the
//    expression the client runs at login. The bootstrap calls
//    gridcheckClient.Attach, which answers with client/agent.py.
// 3. `POST /client/command` sends { id, op, args } to the agent as an
//    OnGridcheckClient notification and waits for gridcheckClient.Reply.
//
// Only a client that logged in with a minted token runs anything.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const HOOK_KEY = Symbol.for("gridcheck.clientAgent.v1");
const SERVICE_NAME = "gridcheckClient";
const NOTIFY = "OnGridcheckClient";
const AGENT_DIR = path.join(__dirname, "client");
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 300000;

function readAgentFile(name) {
  return fs.readFileSync(path.join(AGENT_DIR, name), "utf8");
}

// Stock's marshal hands strings over as a string, a Buffer or a wstring.
function text(value) {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value && typeof value === "object" && value.type === "wstring") return String(value.value);
  return "";
}

function setDictEntry(dict, key, value, strVal) {
  const entry = dict.entries.find(([name]) => strVal(name) === key);
  if (entry) entry[1] = value;
  else dict.entries.push([key, value]);
}

function alive(session) {
  return Boolean(session && session.socket && !session.socket.destroyed);
}

// patched: () -> whether the tree's handshake has the client-agent patch. Without
// it the client's token login reaches stock as the account "EVE-SSO-CONNECTION",
// so no token is minted.
function createClientAgent({ log, patched = () => false, read = readAgentFile, now = Date.now,
  mintToken = () => crypto.randomBytes(24).toString("hex") }) {
  const tokens = new Map(); // token -> { username, accountID }
  const loginsByAccount = new Map(); // accountID -> token, from login until the signedFunc is built
  const agents = new Map(); // token -> { token, username, accountID, session, attachedAtMs, lastSeenMs }
  const waiting = new Map(); // command id -> { token, settle }
  let nextCommandID = 1;

  function mint({ username }) {
    const name = String(username || "").trim();
    if (!name) return { ok: false, error: "username is required" };
    const token = mintToken();
    tokens.set(token, { username: name, accountID: null });
    return { ok: true, token, username: name };
  }

  // Called from the handshake (client-agent patch) with the decoded login dict.
  function resolveLogin(loginData, { accountStore, dictGet, strVal }) {
    try {
      const raw = dictGet(loginData, "user_sso_token");
      if (raw === undefined || raw === null) return false;
      const token = strVal(raw);
      const entry = token ? tokens.get(token) : null;
      if (!entry) return false;
      const account = accountStore.readAccountsTable()[entry.username];
      if (!account) {
        log.warn(`[AgentBridge] client login: token for ${entry.username}, but the store has no such account`);
        return false;
      }
      setDictEntry(loginData, "user_name", entry.username, strVal);
      setDictEntry(loginData, "user_password_hash", typeof account.passwordhash === "string" ? account.passwordhash : "", strVal);
      entry.accountID = Number(account.id);
      loginsByAccount.set(entry.accountID, token);
      log.info(`[AgentBridge] client login: ${entry.username} (account ${entry.accountID}) by token`);
      return true;
    } catch (error) {
      log.warn(`[AgentBridge] client login hook failed, login left as it was: ${error.message}`);
      return false;
    }
  }

  // Called from buildTidiSignedFunc. clientId is 1000000 * accountID + the proxy node.
  function wrapLoginExpression(expr, clientId) {
    try {
      const accountID = Math.floor(Number(clientId) / 1000000);
      const token = loginsByAccount.get(accountID);
      if (!token) return expr;
      loginsByAccount.delete(accountID);
      const source = `_gc_token = ${JSON.stringify(token)}\n${read("bootstrap.py")}`;
      const encoded = Buffer.from(source, "utf8").toString("base64");
      const run = `eval(compile(__import__('base64').b64decode('${encoded}'), '<gridcheck-client>', 'exec'), ` +
        "{'__builtins__': __builtins__, '_gc_context': globals()})";
      log.info(`[AgentBridge] client login: bootstrap sent to account ${accountID}`);
      return `(lambda _gc_result: (${run}, _gc_result)[1])(${expr})`;
    } catch (error) {
      log.warn(`[AgentBridge] client bootstrap not sent: ${error.message}`);
      return expr;
    }
  }

  function createService(BaseService) {
    class GridcheckClientService extends BaseService {
      constructor() {
        super(SERVICE_NAME);
      }

      // Attach(token) -> the agent's source.
      Handle_Attach(args, session) {
        const token = text(args && args[0]);
        const entry = tokens.get(token);
        if (!entry || !session || Number(session.userid) !== entry.accountID) {
          log.warn("[AgentBridge] client attach refused: unknown token or another account's session");
          return null;
        }
        const at = now();
        agents.set(token, { token, username: entry.username, accountID: entry.accountID, session, attachedAtMs: at, lastSeenMs: at });
        log.info(`[AgentBridge] client agent attached: ${entry.username} (account ${entry.accountID})`);
        return read("agent.py");
      }

      // Reply(token, json): the answer to one command.
      Handle_Reply(args, session) {
        const token = text(args && args[0]);
        const agent = agents.get(token);
        if (!agent || agent.session !== session) return false;
        agent.lastSeenMs = now();
        let reply;
        try {
          reply = JSON.parse(text(args[1]));
        } catch (_error) {
          return false;
        }
        const pending = waiting.get(reply && reply.id);
        if (!pending || pending.token !== token) return false;
        pending.settle(reply);
        return true;
      }
    }
    return new GridcheckClientService();
  }

  function describe(agent) {
    const session = agent.session;
    return {
      username: agent.username,
      accountID: agent.accountID,
      characterID: Number(session && session.characterID) || null,
      online: alive(session),
      attachedAtMs: agent.attachedAtMs,
      lastSeenMs: agent.lastSeenMs,
    };
  }

  function pick(body) {
    const live = [...agents.values()].filter((agent) => alive(agent.session));
    const user = body.user === undefined || body.user === null ? "" : String(body.user);
    if (user) {
      const hit = live.find((agent) => agent.username === user);
      return hit ? { agent: hit } : { error: `no client agent online for ${user}` };
    }
    if (live.length === 1) return { agent: live[0] };
    return { error: live.length ? `${live.length} client agents are online; name one with user` : "no client agent is online" };
  }

  function command(body) {
    const op = String(body.op || "");
    if (!/^[a-z][a-zA-Z_]*$/.test(op)) return { statusCode: 400, body: { ok: false, error: "op must be a word, such as ping or eval" } };
    const found = pick(body);
    if (found.error) return { statusCode: 409, body: { ok: false, error: found.error } };
    const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, Math.trunc(Number(body.timeoutMs) || DEFAULT_TIMEOUT_MS)));
    const id = nextCommandID++;
    const { agent } = found;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({ statusCode: 504, body: { ok: false, error: `the client didn't answer ${op} within ${timeoutMs} ms` } });
      }, timeoutMs);
      waiting.set(id, {
        token: agent.token,
        settle(reply) {
          clearTimeout(timer);
          waiting.delete(id);
          resolve({
            statusCode: 200,
            body: reply.ok
              ? { ok: true, op, username: agent.username, value: reply.value }
              : { ok: false, op, username: agent.username, error: String(reply.error || "the client agent failed") },
          });
        },
      });
      agent.session.sendNotification(NOTIFY, "clientID", [JSON.stringify({ id, op, args: body.args || {} })]);
    });
  }

  const routes = {
    "POST /client/token": ({ body }) => {
      if (!patched()) {
        return { statusCode: 409, body: { ok: false, error: "the client-agent patch isn't applied: gridcheck patch apply client-agent, then restart the server" } };
      }
      const reply = mint(body);
      return { statusCode: reply.ok ? 200 : 400, body: reply };
    },
    "GET /client/agents": () => ({ statusCode: 200, body: { ok: true, patched: patched(), agents: [...agents.values()].map(describe) } }),
    "POST /client/command": ({ body }) => command(body),
  };

  function install(serviceManager, BaseService) {
    if (!serviceManager || typeof serviceManager.lookup !== "function" || typeof serviceManager.register !== "function") {
      log.warn("[AgentBridge] client agent off: the server passed no service manager");
      return false;
    }
    if (typeof BaseService !== "function") {
      log.warn("[AgentBridge] client agent off: the tree has no services/baseService");
      return false;
    }
    if (serviceManager.lookup(SERVICE_NAME)) {
      log.warn(`[AgentBridge] client agent off: a ${SERVICE_NAME} service is registered already`);
      return false;
    }
    serviceManager.register(createService(BaseService));
    globalThis[HOOK_KEY] = Object.freeze({ resolveLogin, wrapLoginExpression });
    return true;
  }

  function uninstall() {
    if (globalThis[HOOK_KEY] && globalThis[HOOK_KEY].resolveLogin === resolveLogin) delete globalThis[HOOK_KEY];
    for (const pending of waiting.values()) pending.settle({ ok: false, error: "the bridge stopped" });
  }

  return { install, uninstall, routes, resolveLogin, wrapLoginExpression, createService, mint };
}

module.exports = { createClientAgent, HOOK_KEY, NOTIFY, SERVICE_NAME };
