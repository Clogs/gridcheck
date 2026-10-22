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

// Exceptions the retail client logs on its own, each named by what it means. A
// condition on CLIENT_EXCEPTION skips them unless it names noise
// (core/conditions.js). Match where it is raised, so the same type from
// anywhere else still counts.
const CLIENT_NOISE = [
  // The content repository can't reach its host: at login, and at every undock and dock.
  { name: "content-host", type: "gaierror", where: /[\\/]content[\\/]client[\\/]flatbuffer[\\/]repository\.py\(\d+\) _request_update_task$/ },
];

function clientNoise({ type, where }) {
  const hit = CLIENT_NOISE.find((known) => known.type === type && known.where.test(where || ""));
  return hit ? hit.name : null;
}

// patched: () -> whether the tree's handshake has the client-agent patch. Without
// it the client's token login reaches stock as the account "EVE-SSO-CONNECTION",
// so no token is minted.
// liveSessions() -> every live server session (stock sessionRegistry.getSessions):
// a client's account must have no other, such as a headless pilot's.
// testTree() -> whether the tree has a gridcheck.config.json. EVEJS_AGENT_BRIDGE=1
// turns the bridge on without one, but a tree players use never gets a token.
function createClientAgent({ log, patched = () => false, testTree = () => false, read = readAgentFile, now = Date.now,
  mintToken = () => crypto.randomBytes(24).toString("hex"), liveSessions = () => [] }) {
  const tokens = new Map(); // token -> { username, accountID }
  // The token login the handshake is handling: { accountID, token } from resolveLogin until its
  // signedFunc is built. The handshake makes both calls in one synchronous _handleAuthentication,
  // so no other login comes between them. The client ID can't name the login instead: since
  // EveJS 261018.1 it counts connections and no longer holds the account.
  let pendingLogin = null;
  const lastLogin = new Map(); // accountID -> the token that logged in last
  const agents = new Map(); // token -> { token, username, accountID, session, attachedAtMs, lastSeenMs, pid, build, ... }
  const waiting = new Map(); // command id -> { token, settle }
  const events = []; // the last EVENT_RING timeline events from every client, oldest first
  const subscribers = new Set();
  let nextCommandID = 1;
  let eventSeq = 0;
  let state = { on: false, reason: "not installed yet" };

  function sessionsOf(accountID) {
    try {
      return (liveSessions() || []).filter((session) => session && Number(session.userid) === accountID);
    } catch (error) {
      log.warn(`[AgentBridge] client agent: the session list failed: ${error.message}`);
      return [];
    }
  }

  // A live session for the account that isn't this token's own client.
  function otherSession(accountID, token) {
    const own = token ? agents.get(token) : null;
    return sessionsOf(accountID).find((session) => !own || session !== own.session) || null;
  }

  function mint({ username, accountID }) {
    const name = String(username || "").trim();
    if (!name) return { ok: false, error: "username is required" };
    const account = Number(accountID) || 0;
    if (account && otherSession(account, null)) {
      return { ok: false, statusCode: 409, error: `account ${name} (${account}) already has a session on the server, a headless pilot's ` +
        "or another client's. A client needs an account of its own: pass another --user." };
    }
    const token = mintToken();
    tokens.set(token, { username: name, accountID: null });
    return { ok: true, token, username: name };
  }

  // Called from the handshake (client-agent patch) with the decoded login dict.
  function resolveLogin(loginData, { accountStore, dictGet, strVal }) {
    pendingLogin = null;
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
      const accountID = Number(account.id);
      if (otherSession(accountID, token)) {
        log.warn(`[AgentBridge] client login refused: ${entry.username} (account ${accountID}) already has a session, ` +
          "a headless pilot's or another client's");
        return false;
      }
      setDictEntry(loginData, "user_name", entry.username, strVal);
      setDictEntry(loginData, "user_password_hash", typeof account.passwordhash === "string" ? account.passwordhash : "", strVal);
      entry.accountID = accountID;
      pendingLogin = { accountID, token };
      lastLogin.set(entry.accountID, token);
      log.info(`[AgentBridge] client login: ${entry.username} (account ${entry.accountID}) by token`);
      return true;
    } catch (error) {
      log.warn(`[AgentBridge] client login hook failed, login left as it was: ${error.message}`);
      return false;
    }
  }

  // Called from buildTidiSignedFunc, right after resolveLogin for the same login.
  function wrapLoginExpression(expr, _clientId) {
    const login = pendingLogin;
    pendingLogin = null;
    try {
      if (!login) return expr;
      const { accountID, token } = login;
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
      const line = { kind: "CLIENT_EXCEPTION", ...who, type: str(raw.type), message: str(raw.message), extra: str(raw.extra),
        channel: str(raw.channel), where: str(raw.where),
        traceback: Array.isArray(raw.traceback) ? raw.traceback.map(String) : [] };
      return { ...line, noise: clientNoise(line) };
    }
    if (raw.kind === "message") {
      return { kind: "CLIENT_EVENT", ...who, event: "message", key: str(raw.key), text: str(raw.text), messageType: str(raw.type) };
    }
    if (raw.kind === "notify") return { kind: "CLIENT_EVENT", ...who, event: str(raw.event), args: str(raw.args) };
    return { kind: "CLIENT_EVENT", ...who, event: str(raw.kind) || "unknown", op: str(raw.op), error: str(raw.error),
      args: str(raw.args) };
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
        // A new client for the account replaces the ones before it; the login
        // guard leaves it the account's only client.
        for (const [other, agent] of agents) {
          if (other !== token && agent.username === entry.username) agents.delete(other);
        }
        agents.set(token, { token, username: entry.username, accountID: entry.accountID, session, attachedAtMs: at,
          lastSeenMs: at, pid: null, build: null, checkedBuild: null, agentVersion: null, goneAtMs: null });
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
        agent.checkedBuild = hello.checkedBuild === undefined || hello.checkedBuild === null ? null : String(hello.checkedBuild);
        log.info(`[AgentBridge] client agent ${agent.username}: pid ${agent.pid}, build ${agent.build}`);
        if (agent.checkedBuild && agent.build !== agent.checkedBuild) {
          log.warn(`[AgentBridge] client agent ${agent.username}: build ${agent.build}, but the agent was checked against ` +
            `build ${agent.checkedBuild}; its ops other than ping, eval and events refuse`);
        }
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

  // A client that reconnected has a new session for its account; the agent in
  // it is the same and keeps its token, so it carries on there. Sessions
  // another agent holds aren't taken, nor the gateway's (headless) sessions,
  // whose duck socket has no write.
  function rebind(agent) {
    // A new client for the account (another token) is not this one reconnecting.
    if (lastLogin.get(agent.accountID) !== agent.token) return false;
    const held = new Set([...agents.values()].map((other) => other.session));
    const next = sessionsOf(agent.accountID)
      .find((session) => !held.has(session) && session.socket && typeof session.socket.write === "function");
    if (!next) return false;
    agent.session = next;
    agent.reboundAtMs = now();
    log.info(`[AgentBridge] client agent ${agent.username}: carried on to its reconnected session`);
    return true;
  }

  // A client that closed stays listed as gone for GONE_KEEP_MS, then is dropped.
  function prune() {
    const at = now();
    for (const [token, agent] of agents) {
      if (alive(agent.session) || rebind(agent)) {
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
      checkedBuild: agent.checkedBuild,
      agentVersion: agent.agentVersion,
      attachedAtMs: agent.attachedAtMs,
      lastSeenMs: agent.lastSeenMs,
      goneAtMs: agent.goneAtMs,
      reconnectedAtMs: agent.reboundAtMs || null,
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
      if (!testTree()) {
        return { statusCode: 409, body: { ok: false, error: "this tree has no gridcheck.config.json, so it isn't a gridcheck test tree " +
          "and gets no client tokens. `gridcheck init` writes one; never in a tree players use." } };
      }
      const { statusCode, ...reply } = mint(body || {});
      return { statusCode: reply.ok ? 200 : statusCode || 400, body: reply };
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
