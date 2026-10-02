"use strict";

// The agent bridge's routes, free of HTTP: each takes the parsed request and
// answers { statusCode, body }. Every rule a slash command has stays in the
// command handler; this only finds the session and passes the line through.
//
//   GET  /health                     liveness, no token
//   POST /slash    { characterID, command }  -> { handled, success, message }
//   GET  /grid     ?characterID=      what that character's session can see
//   POST /watch    { characterID, forSeconds, everySeconds, offGridEverySeconds, client, divergeMeters, positions,
//                    perfEverySeconds }
//                                     NDJSON stream of grid changes and plugin events; one call per watch.
//                                     client: "all" (default), "diverge" or "off". perfEverySeconds adds a PERF
//                                     window that often, and the tick profiler's PROFILE windows (perf.js)
//   GET  /perf                        the server's last ticks, from the runtime's ring; no character needed
//   POST /perf     { seconds }        sample that long, then the ticks, CPU, loop delay and profiler windows
//   POST /tee      { characterID }    start keeping the client's view of that gateway session
//   POST /loadout  { characterID, ship, modules, drones, cargo, charges }
//                                     a new ship by item name, fitted and boarded (loadout.js)
//   POST /shutdown                    graceful stop, as if the process got SIGTERM
//   GET  /capabilities ?characterID=  what this tree can do for the tool (core/capabilities.js);
//                                     with characterID, also that session's shape
//
// Plugins add their own routes through the route table (plugins.js). A
// plugin can't replace a core route.

const { LIMITS } = require("./watch");
const { LIMITS: PERF_LIMITS } = require("./perf");

function toPositiveInt(value) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : 0;
}

function secondsIn(value, fallback, min, max) {
  const numeric = value === undefined || value === null || value === "" ? fallback : Number(value);
  return Number.isFinite(numeric) && numeric >= min && numeric <= max ? numeric : null;
}

// fx: DIVERGE plus the client's special effects (weapons firing), no CLIENT lines.
const CLIENT_MODES = new Set(["all", "fx", "diverge", "off"]);

const NOT_ONLINE = "That character has no live session. Log it in first (gridcheck login).";

// "METHOD /path" -> handler, where a path ending in /* matches everything
// under it and passes the remainder as `rest`. Core routes are added first and
// win; a plugin route that collides with one is dropped with a warning.
function createRouteTable(log) {
  const exact = new Map();
  const prefixes = [];

  function add(key, handler, owner) {
    const match = /^(GET|POST|PUT|DELETE) (\/\S*)$/.exec(String(key));
    if (!match || typeof handler !== "function") {
      log.warn(`[AgentBridge] ${owner}: ignored route ${JSON.stringify(key)}; expected "METHOD /path" and a function`);
      return false;
    }
    const [, method, routePath] = match;
    if (routePath.endsWith("/*")) {
      const prefix = routePath.slice(0, -1);
      if (prefixes.some((entry) => entry.method === method && entry.prefix === prefix)) {
        log.warn(`[AgentBridge] ${owner}: ${key} is taken`);
        return false;
      }
      prefixes.push({ method, prefix, handler, owner });
      prefixes.sort((left, right) => right.prefix.length - left.prefix.length);
      return true;
    }
    const id = `${method} ${routePath}`;
    if (exact.has(id)) {
      log.warn(`[AgentBridge] ${owner}: ${key} is taken by ${exact.get(id).owner}`);
      return false;
    }
    exact.set(id, { handler, owner });
    return true;
  }

  function find(method, route) {
    const hit = exact.get(`${method} ${route}`);
    if (hit) return { ...hit, rest: "" };
    const prefixed = prefixes.find((entry) => entry.method === method && route.startsWith(entry.prefix));
    return prefixed ? { ...prefixed, rest: route.slice(prefixed.prefix.length) } : null;
  }

  return { add, find };
}

function createAgentBridgeRoutes({
  findSession, executeChatCommand, readGrid, watcher, requestShutdown, log, destinyTee = null, gridAnnotate = null,
  viewer = null, extraRoutes = [], capabilities = null, loadout = null, perf = null,
}) {
  const logger = log || { debug() {} };

  function sessionFor(characterID) {
    const id = toPositiveInt(characterID);
    if (!id) {
      return { error: { statusCode: 400, body: { ok: false, error: "A positive characterID is required." } } };
    }
    const session = findSession(id);
    if (!session) {
      return { error: { statusCode: 409, body: { ok: false, error: NOT_ONLINE } } };
    }
    return { session };
  }

  function slash(body) {
    const found = sessionFor(body && body.characterID);
    if (found.error) return found.error;
    const command = String((body && body.command) || "").trim();
    if (!command.startsWith("/") && !command.startsWith(".")) {
      return { statusCode: 400, body: { ok: false, error: "command must start with / or ." } };
    }
    if (typeof executeChatCommand !== "function") {
      return { statusCode: 503, body: { ok: false, error: "This server has no chat command handler loaded." } };
    }
    const settle = (result) => {
      const reply = {
        ok: true,
        command,
        handled: Boolean(result && result.handled),
        // null: the tree's command didn't say (stock EveJS never does; the
        // slash-success patch makes the commands this tool drives say).
        success: result && typeof result.success === "boolean" ? result.success : null,
        message: String((result && result.message) || ""),
      };
      logger.debug(`[AgentBridge] ${found.session.characterID} ${command} -> ` +
        `${reply.success === null ? "done, outcome not reported" : reply.success ? "ok" : "refused"}`);
      return { statusCode: 200, body: reply };
    };
    // null chat hub: the reply comes back to the caller instead of into chat.
    const result = executeChatCommand(found.session, command, null, {});
    return result && typeof result.then === "function" ? result.then(settle) : settle(result);
  }

  // ?ext=1 runs the plugins' annotate hooks on each row, so a player action
  // can pick its target by a plugin's data or a group a step bound.
  function grid(query) {
    const found = sessionFor(query && query.characterID);
    if (found.error) return found.error;
    const wantsExt = query && query.ext === "1";
    const options = wantsExt && typeof gridAnnotate === "function"
      ? { annotate: (row, entity) => gridAnnotate(row, entity, found.session) } : {};
    return { statusCode: 200, body: { ok: true, grid: readGrid(found.session, options) } };
  }

  // Answers { statusCode, stream(sink) }: the HTTP layer writes each event as
  // one JSON line until the watch ends or the caller hangs up.
  function watch(body) {
    const found = sessionFor(body && body.characterID);
    if (found.error) return found.error;
    if (!watcher) {
      return { statusCode: 503, body: { ok: false, error: "This server has no grid watcher loaded." } };
    }
    const forSeconds = secondsIn(body.forSeconds, 600, 1, LIMITS.maxForSeconds);
    const everySeconds = secondsIn(body.everySeconds, 2, LIMITS.minEverySeconds, LIMITS.maxEverySeconds);
    // An off-grid scan may walk the whole world, so it runs less often than the grid sample.
    const offGridEverySeconds = secondsIn(body.offGridEverySeconds, Math.max(5, everySeconds || 2),
      LIMITS.minEverySeconds, LIMITS.maxEverySeconds);
    if (forSeconds === null || everySeconds === null || offGridEverySeconds === null) {
      return {
        statusCode: 400,
        body: {
          ok: false,
          error: `forSeconds must be 1-${LIMITS.maxForSeconds}; everySeconds and offGridEverySeconds ` +
            `${LIMITS.minEverySeconds}-${LIMITS.maxEverySeconds}.`,
        },
      };
    }
    const clientMode = body.client === undefined || body.client === null ? "all" : String(body.client);
    if (!CLIENT_MODES.has(clientMode)) {
      return { statusCode: 400, body: { ok: false, error: "client must be all, fx, diverge or off." } };
    }
    const divergeMeters = body.divergeMeters === undefined || body.divergeMeters === null
      ? null : Number(body.divergeMeters);
    if (divergeMeters !== null && !(divergeMeters > 0)) {
      return { statusCode: 400, body: { ok: false, error: "divergeMeters must be a positive number." } };
    }
    const perfEverySeconds = body.perfEverySeconds === undefined || body.perfEverySeconds === null || body.perfEverySeconds === 0
      ? 0 : secondsIn(body.perfEverySeconds, 5, 1, LIMITS.maxEverySeconds);
    if (perfEverySeconds === null) {
      return { statusCode: 400, body: { ok: false, error: `perfEverySeconds must be 1-${LIMITS.maxEverySeconds}, or 0 for none.` } };
    }
    if (perfEverySeconds && !perf) {
      return { statusCode: 503, body: { ok: false, error: "This server has no perf monitor loaded." } };
    }
    if (watcher.busy()) {
      return { statusCode: 429, body: { ok: false, error: `${LIMITS.maxConcurrent} watches are already running.` } };
    }
    const characterID = toPositiveInt(body.characterID);
    logger.debug(`[AgentBridge] watch ${characterID} for ${forSeconds}s every ${everySeconds}s client=${clientMode}`);
    return {
      statusCode: 200,
      stream: (sink) => watcher.run({
        characterID,
        forMs: forSeconds * 1000,
        everyMs: everySeconds * 1000,
        offGridEveryMs: offGridEverySeconds * 1000,
        clientMode,
        divergeMeters,
        positions: body.positions === true,
        perfEveryMs: perfEverySeconds * 1000,
      }, sink),
    };
  }

  // Attach before undock, so the client model starts from the SetState the
  // undock sends. A watch attaches by itself, but then waits for the next one.
  function tee(body) {
    const found = sessionFor(body && body.characterID);
    if (found.error) return found.error;
    if (!destinyTee) return { statusCode: 503, body: { ok: false, error: "This server has no destiny tee loaded." } };
    const attached = destinyTee.attach(found.session);
    if (!attached.ok) return { statusCode: 409, body: { ok: false, error: attached.error } };
    return { statusCode: 200, body: { ok: true, attached: attached.attached, client: destinyTee.describe(attached.state) } };
  }

  // loadout: () -> the builder, or { error } when this tree lacks what it needs.
  function buildLoadout(body) {
    const found = sessionFor(body && body.characterID);
    if (found.error) return found.error;
    const builder = typeof loadout === "function" ? loadout() : null;
    if (!builder || typeof builder.run !== "function") {
      return { statusCode: 503, body: { ok: false, error: `This tree can't build a loadout: ${(builder && builder.error) || "not loaded"}.` } };
    }
    const { characterID: _characterID, ...spec } = body;
    try {
      const reply = builder.run(found.session, spec);
      logger.debug(`[AgentBridge] ${found.session.characterID} loadout ${spec.ship} -> ${reply.body.ok ? "boarded" : reply.body.error}`);
      return reply;
    } catch (error) {
      return { statusCode: 500, body: { ok: false, error: `loadout failed: ${error.message}` } };
    }
  }

  // GET answers at once from the runtime's ring; POST samples for `seconds`.
  function perfRoute(method, body) {
    if (!perf) return { statusCode: 503, body: { ok: false, error: "This server has no perf monitor loaded." } };
    if (method === "GET") return { statusCode: 200, body: { ok: true, ...perf.snapshot() } };
    const seconds = secondsIn(body.seconds, 10, 1, PERF_LIMITS.maxSampleSeconds);
    if (seconds === null) {
      return { statusCode: 400, body: { ok: false, error: `seconds must be 1-${PERF_LIMITS.maxSampleSeconds}.` } };
    }
    return perf.sample(seconds).then((reply) => (reply.busy
      ? { statusCode: 429, body: { ok: false, error: `${PERF_LIMITS.maxConcurrent} perf samples are already running.` } }
      : { statusCode: 200, body: { ok: true, ...reply } }));
  }

  function shutdown() {
    if (typeof requestShutdown !== "function") {
      return { statusCode: 503, body: { ok: false, error: "Shutdown is not available." } };
    }
    requestShutdown();
    return { statusCode: 202, body: { ok: true, stopping: true } };
  }

  const table = createRouteTable({ warn: (message) => typeof logger.warn === "function" && logger.warn(message) });
  table.add("POST /slash", ({ body }) => slash(body), "core");
  table.add("GET /grid", ({ query }) => grid(query), "core");
  table.add("POST /watch", ({ body }) => watch(body), "core");
  table.add("POST /tee", ({ body }) => tee(body), "core");
  table.add("POST /loadout", ({ body }) => buildLoadout(body), "core");
  table.add("POST /shutdown", () => shutdown(), "core");
  table.add("GET /perf", () => perfRoute("GET", {}), "core");
  table.add("POST /perf", ({ body }) => perfRoute("POST", body), "core");
  table.add("GET /capabilities", ({ query }) => {
    if (typeof capabilities !== "function") return { statusCode: 503, body: { ok: false, error: "Capabilities are not available." } };
    const id = toPositiveInt(query.characterID);
    return { statusCode: 200, body: { ok: true, ...capabilities({ session: id ? findSession(id) : undefined, characterID: id || null }) } };
  }, "core");
  for (const { owner, routes } of extraRoutes) {
    for (const [key, handler] of Object.entries(routes || {})) table.add(key, handler, owner);
  }

  function handle(method, route, query, body) {
    if (viewer && route.startsWith("/viewer/")) return viewer.handle(method, route, query);
    const found = table.find(method, route);
    if (found) return found.handler({ query: query || {}, body: body || {}, route, rest: found.rest });
    return { statusCode: 404, body: { ok: false, error: `no such route: ${method} ${route}` } };
  }

  // The viewer's page and script carry no data, so they load without the
  // token; the page sends the token on every data call.
  function handlePublic(method, route) {
    return viewer ? viewer.handlePublic(method, route) : null;
  }

  return { handle, handlePublic };
}

module.exports = {
  createAgentBridgeRoutes,
  createRouteTable,
};
