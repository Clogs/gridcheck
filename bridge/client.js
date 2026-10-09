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
// 4. The agent reports its pid and build with gridcheckClient.Hello, and its
//    exceptions and notify events in batches with gridcheckClient.Events.
//    They are kept in a ring (`GET /client/events`) and handed to subscribers:
//    a watch puts them on its timeline.
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
const GONE_KEEP_MS = 10 * 60 * 1000;
const EVENT_RING = 1000;

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
  const agents = new Map(); // token -> { token, username, accountID, session, attachedAtMs, lastSeenMs, pid, build, ... }
  const waiting = new Map(); // command id -> { token, settle }
  const events = []; // the last EVENT_RING timeline events from every client, oldest first
  const subscribers = new Set();
  let nextCommandID = 1;
  let eventSeq = 0;
  let state = { on: false, reason: "not installed yet" };

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

  function parseJSON(value) {
    try {
      return JSON.parse(text(value));
    } catch (_error) {
      return null;
    }
  }

  // The agent behind a call: its token, from the session it attached on.
  function caller(args, session) {
    const agent = agents.get(text(args && args[0]));
    if (!agent || agent.session !== session) return null;
    agent.lastSeenMs = now();
    return agent;
  }

  // One agent event as a timeline line (core/conditions.js CLIENT_EXCEPTION, CLIENT_EVENT).
  function timelineEvent(agent, raw) {
    const who = {
      username: agent.username,
      characterID: Number(agent.session && agent.session.characterID) || null,
      clientSeq: Number(raw.seq) || null,
      clientAtMs: Number(raw.atMs) || null,
    };
    const str = (value) => (value === undefined || value === null ? null : String(value));
    if (raw.kind === "exception") {
      return { kind: "CLIENT_EXCEPTION", ...who, type: str(raw.type), message: str(raw.message), extra: str(raw.extra),
        channel: str(raw.channel), where: str(raw.where),
        traceback: Array.isArray(raw.traceback) ? raw.traceback.map(String) : [] };
    }
    if (raw.kind === "notify") return { kind: "CLIENT_EVENT", ...who, event: str(raw.event), args: str(raw.args) };
    return { kind: "CLIENT_EVENT", ...who, event: str(raw.kind) || "unknown", op: str(raw.op), error: str(raw.error) };
  }

  function publish(event) {
    const line = { seq: ++eventSeq, atMs: now(), ...event };
    events.push(line);
    if (events.length > EVENT_RING) events.splice(0, events.length - EVENT_RING);
    for (const listener of subscribers) {
      try {
        listener(line);
      } catch (error) {
        log.warn(`[AgentBridge] client event listener failed: ${error.message}`);
      }
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
        // A new client for the account replaces the closed ones it left behind.
        for (const [other, agent] of agents) {
          if (other !== token && agent.username === entry.username && !alive(agent.session)) agents.delete(other);
        }
        agents.set(token, { token, username: entry.username, accountID: entry.accountID, session, attachedAtMs: at,
          lastSeenMs: at, pid: null, build: null, agentVersion: null, goneAtMs: null });
        log.info(`[AgentBridge] client agent attached: ${entry.username} (account ${entry.accountID})`);
        return read("agent.py");
      }

      // Hello(token, json): the agent's pid (the client's own, not the launcher's), build and version.
      Handle_Hello(args, session) {
        const agent = caller(args, session);
        const hello = agent && parseJSON(args[1]);
        if (!hello) return false;
        agent.pid = Number(hello.pid) || null;
        agent.build = hello.build === undefined || hello.build === null ? null : String(hello.build);
        agent.agentVersion = Number(hello.agent) || null;
        log.info(`[AgentBridge] client agent ${agent.username}: pid ${agent.pid}, build ${agent.build}`);
        return true;
      }

      // Events(token, json): a batch of { kind, seq, atMs, ... } from the agent's ring.
      Handle_Events(args, session) {
        const agent = caller(args, session);
        const batch = agent && parseJSON(args[1]);
        if (!batch || !Array.isArray(batch.events)) return false;
        if (Number(batch.dropped) > 0) {
          publish({ kind: "CLIENT_EVENT", username: agent.username, characterID: Number(session.characterID) || null,
            event: "dropped", count: Number(batch.dropped) });
        }
        for (const raw of batch.events) if (raw && typeof raw === "object") publish(timelineEvent(agent, raw));
        return true;
      }

      // Reply(token, json): the answer to one command.
      Handle_Reply(args, session) {
        const agent = caller(args, session);
        const reply = agent && parseJSON(args[1]);
        const pending = reply && waiting.get(reply.id);
        if (!pending || pending.token !== agent.token) return false;
        pending.settle(reply);
        return true;
      }
    }
    return new GridcheckClientService();
  }

  // A client that closed stays listed as gone for GONE_KEEP_MS, then is dropped.
  function prune() {
    const at = now();
    for (const [token, agent] of agents) {
      if (alive(agent.session)) {
        agent.goneAtMs = null;
        continue;
      }
      if (agent.goneAtMs === null) agent.goneAtMs = at;
      else if (at - agent.goneAtMs >= GONE_KEEP_MS) agents.delete(token);
    }
  }

  function describe(agent) {
    const session = agent.session;
    return {
      username: agent.username,
      accountID: agent.accountID,
      characterID: Number(session && session.characterID) || null,
      online: alive(session),
      pid: agent.pid,
      build: agent.build,
      agentVersion: agent.agentVersion,
      attachedAtMs: agent.attachedAtMs,
      lastSeenMs: agent.lastSeenMs,
      goneAtMs: agent.goneAtMs,
    };
  }

  function pick(body) {
    prune();
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

  function listEvents(query) {
    const since = Math.max(0, Math.trunc(Number(query.since) || 0));
    const limit = Math.min(EVENT_RING, Math.max(1, Math.trunc(Number(query.limit) || 200)));
    const user = query.user ? String(query.user) : "";
    const rows = events.filter((event) => event.seq > since && (!user || event.username === user));
    return { ok: true, seq: eventSeq, events: rows.slice(-limit) };
  }

  const routes = {
    "POST /client/token": ({ body }) => {
      if (!patched()) {
        return { statusCode: 409, body: { ok: false, error: "the client-agent patch isn't applied: gridcheck patch apply client-agent, then restart the server" } };
      }
      const reply = mint(body);
      return { statusCode: reply.ok ? 200 : 400, body: reply };
    },
    "GET /client/agents": () => {
      prune();
      return { statusCode: 200, body: { ok: true, patched: patched(), agents: [...agents.values()].map(describe) } };
    },
    "GET /client/events": ({ query }) => ({ statusCode: 200, body: listEvents(query || {}) }),
    "POST /client/command": ({ body }) => command(body),
  };

  // listener(event) for every client event as it arrives; returns the unsubscribe.
  function subscribe(listener) {
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }

  function install(serviceManager, BaseService) {
    if (!serviceManager || typeof serviceManager.lookup !== "function" || typeof serviceManager.register !== "function") {
      state = { on: false, reason: "the server passed no service manager to the bridge; its loader predates the client agent" };
    } else if (typeof BaseService !== "function") {
      state = { on: false, reason: "the tree has no services/baseService" };
    } else if (serviceManager.lookup(SERVICE_NAME)) {
      state = { on: false, reason: `a ${SERVICE_NAME} service is registered already` };
    } else {
      serviceManager.register(createService(BaseService));
      globalThis[HOOK_KEY] = Object.freeze({ resolveLogin, wrapLoginExpression });
      state = { on: true, reason: null };
      return true;
    }
    log.warn(`[AgentBridge] client agent off: ${state.reason}`);
    return false;
  }

  function uninstall() {
    if (globalThis[HOOK_KEY] && globalThis[HOOK_KEY].resolveLogin === resolveLogin) delete globalThis[HOOK_KEY];
    for (const pending of waiting.values()) pending.settle({ ok: false, error: "the bridge stopped" });
    subscribers.clear();
  }

  // For capabilities: whether the service is registered, and if not why.
  function status() {
    return { service: state.on ? "on" : "off", reason: state.reason, patched: patched(), agents: agents.size };
  }

  return { install, uninstall, routes, resolveLogin, wrapLoginExpression, createService, mint, subscribe, status };
}

module.exports = { createClientAgent, HOOK_KEY, NOTIFY, SERVICE_NAME };
