"use strict";

// The Living Universe plugin's bridge routes:
//
//   GET  /clock                       Living Universe clock, warp state, backlog, pulse timing
//   GET  /economy  ?since=<simMs>     economy status and telemetry snapshots since then
//   POST /warp     { forSeconds, stepMs, sliceMs }  NDJSON stream; runs off-grid LU faster
//   POST /warp/stop                   end a running warp at the next slice
//   POST /trigger/<name>  { characterID, ... }  scout, hunt, fleet or materialize; see
//                                     triggers.js. Answers the flight or hunt ID.

function createLuRoutes({ warp = null, warpBridge = null, triggers = null, log = null } = {}) {
  const logger = log || { debug() {} };

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

  function trigger(name, body) {
    if (!triggers) return { statusCode: 503, body: { ok: false, error: "This server has no Living Universe triggers." } };
    logger.debug(`[AgentBridge] trigger ${name}`);
    return triggers.run(name, body || {});
  }

  return {
    "GET /clock": () => clock(),
    "GET /economy": ({ query }) => economy(query),
    "POST /warp": ({ body }) => startWarp(body || {}),
    "POST /warp/stop": () => stopWarp(),
    "POST /trigger/*": ({ rest, body }) => trigger(rest, body),
  };
}

module.exports = {
  createLuRoutes,
};
