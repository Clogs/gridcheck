"use strict";

// The agent bridge's routes, free of HTTP: each takes the parsed request and
// answers { statusCode, body }. Every rule a slash command has stays in the
// command handler; this only finds the session and passes the line through,
// the way the LU Monitor bridge does.
//
//   GET  /health                     liveness, no token
//   POST /slash    { characterID, command }  -> { handled, success, message }
//   GET  /grid     ?characterID=      what that character's session can see
//   POST /watch    { characterID, forSeconds, everySeconds, offGridEverySeconds, client, divergeMeters, positions }
//                                     NDJSON stream of grid and LU changes; one call per watch.
//                                     client: "all" (default), "diverge" or "off"
//   POST /tee      { characterID }    start keeping the client's view of that gateway session
//   POST /shutdown                    graceful stop, as if the process got SIGTERM
//   GET  /clock                       Living Universe clock, warp state, backlog, pulse timing
//   GET  /economy  ?since=<simMs>     economy status and telemetry snapshots since then
//   POST /warp     { forSeconds, stepMs, sliceMs }  NDJSON stream; runs off-grid LU faster
//   POST /warp/stop                   end a running warp at the next slice
//   POST /trigger/<name>  { characterID, ... }  scout, hunt, fleet or materialize; see
//                                     plugins/lu/server/triggers.js. Answers the flight or hunt ID.

const { LIMITS } = require("./watch");

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

const NOT_ONLINE = "That character has no live session. Log it in first (e2e login).";

function createAgentBridgeRoutes({
  findSession, executeChatCommand, readGrid, watcher, requestShutdown, log, warp = null, warpBridge = null,
  destinyTee = null, triggers = null, gridAnnotate = null, viewer = null,
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
        success: Boolean(result && result.success),
        message: String((result && result.message) || ""),
      };
      logger.debug(`[AgentBridge] ${found.session.characterID} ${command} -> ${reply.success ? "ok" : "refused"}`);
      return { statusCode: 200, body: reply };
    };
    // null chat hub: the reply comes back to the caller instead of into chat.
    const result = executeChatCommand(found.session, command, null, {});
    return result && typeof result.then === "function" ? result.then(settle) : settle(result);
  }

  // ?lu=1 adds each LU ship's flightID and family, so a player action can
  // pick its target by flight (`e2e act lock flight=$fleet`).
  function grid(query) {
    const found = sessionFor(query && query.characterID);
    if (found.error) return found.error;
    const options = query && query.lu === "1" && typeof gridAnnotate === "function"
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
    // The off-grid scan walks every flight, so it runs less often than the grid sample.
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

  function shutdown() {
    if (typeof requestShutdown !== "function") {
      return { statusCode: 503, body: { ok: false, error: "Shutdown is not available." } };
    }
    requestShutdown();
    return { statusCode: 202, body: { ok: true, stopping: true } };
  }

  function clock() {
    if (!warpBridge) return { statusCode: 503, body: { ok: false, error: "This server has no Living Universe clock." } };
    return { statusCode: 200, body: { ok: true, clock: warpBridge.clockStatus() } };
  }

  function economy(query) {
    if (!warpBridge) return { statusCode: 503, body: { ok: false, error: "This server has no living economy." } };
    return { statusCode: 200, body: { ok: true, economy: warpBridge.economyReport(query && query.since) } };
  }

  // Answers a stream: START, PROGRESS every 2 s, then END with the final numbers.
  // The warp stops if the caller hangs up, so a dead CLI never leaves a world
  // racing ahead.
  function startWarp(body) {
    if (!warp) return { statusCode: 503, body: { ok: false, error: "This server has no warp driver." } };
    const forSeconds = Number(body && body.forSeconds);
    let sinkRef = null;
    const started = warp.start({
      forMs: forSeconds * 1000,
      stepMs: body && body.stepMs,
      sliceMs: body && body.sliceMs,
      economyBudgetMs: body && body.economyBudgetMs,
    }, (progress) => {
      if (!sinkRef) return;
      if (sinkRef.closed()) { warp.stop(); return; }
      sinkRef.write({ kind: "PROGRESS", ...progress });
    });
    if (!started.ok) return { statusCode: 409, body: { ok: false, error: started.error } };
    logger.debug(`[AgentBridge] warp ${forSeconds}s`);
    return {
      statusCode: 200,
      stream: async (sink) => {
        sinkRef = sink;
        sink.write({ kind: "START", ...started.status() });
        const final = await started.done;
        sink.write({ kind: "END", ...final });
      },
    };
  }

  function stopWarp() {
    if (!warp) return { statusCode: 503, body: { ok: false, error: "This server has no warp driver." } };
    return { statusCode: 200, body: { ok: true, stopping: warp.stop() } };
  }

  function handle(method, route, query, body) {
    if (method === "GET" && route === "/clock") return clock();
    if (method === "GET" && route === "/economy") return economy(query);
    if (method === "POST" && route === "/warp") return startWarp(body || {});
    if (method === "POST" && route === "/warp/stop") return stopWarp();
    if (method === "POST" && route === "/slash") return slash(body);
    if (method === "GET" && route === "/grid") return grid(query);
    if (method === "POST" && route === "/watch") return watch(body || {});
    if (method === "POST" && route === "/tee") return tee(body || {});
    if (method === "POST" && route === "/shutdown") return shutdown();
    if (viewer && route.startsWith("/viewer/")) return viewer.handle(method, route, query);
    if (method === "POST" && route.startsWith("/trigger/")) {
      if (!triggers) return { statusCode: 503, body: { ok: false, error: "This server has no Living Universe triggers." } };
      logger.debug(`[AgentBridge] trigger ${route.slice(9)}`);
      return triggers.run(route.slice("/trigger/".length), body || {});
    }
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
};
