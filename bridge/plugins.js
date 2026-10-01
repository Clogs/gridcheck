"use strict";

// The server halves of the plugins (loader and tool halves: core/plugins.js).
// server(ctx) answers the hooks the bridge calls:
//   annotate(entity, { row, nowMs, characterID }) -> { groupKey, ext, hidden, pos } | null
//       per grid row: ext lands on row.ext[<plugin>] and rides on every event
//       about the ball; groupKey groups balls arriving and leaving together;
//       hidden is for the plugin's own onGrid hook; pos is the few fields a
//       tactical frame keeps for the plugin's colours
//   onGrid.watch({ characterID, startedAtMs }) -> { step(entries, ctx) -> events }
//       one per watch, run on every sample in space (watch.js createGridDiffer)
//   offGrid.watch({ characterID, startedAtMs }) -> { scan(systemID, context) -> { events, stats } }
//       one scanner per watch, run every offGridEveryMs while in space
//   routes: { "POST /trigger/*": ({ query, body, route, rest }) -> reply }
//   stop()
// The watch times every hook and reports each in END costs.hooks.

const { API_VERSION, DEFAULT_PLUGINS_DIR, loadPlugins } = require("../core/plugins");

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

// Calls each active plugin's server(ctx). A plugin that throws here is moved
// to skipped, so one broken plugin never stops the bridge.
function startPlugins(loaded, ctx, { log = null } = {}) {
  const hooks = [];
  const skipped = [...loaded.skipped];
  for (const { name, plugin } of loaded.active) {
    if (typeof plugin.server !== "function") {
      hooks.push({ name });
      continue;
    }
    try {
      const answer = plugin.server({ ...ctx, plugin: name }) || {};
      hooks.push({
        name,
        annotate: typeof answer.annotate === "function" ? answer.annotate : null,
        onGrid: answer.onGrid && typeof answer.onGrid.watch === "function" ? answer.onGrid : null,
        offGrid: answer.offGrid && typeof answer.offGrid.watch === "function" ? answer.offGrid : null,
        routes: answer.routes && typeof answer.routes === "object" ? answer.routes : {},
        stop: typeof answer.stop === "function" ? answer.stop : null,
      });
      if (log) log.info(`[AgentBridge] plugin ${name} active`);
    } catch (error) {
      skipped.push({ name, reason: `server() threw: ${errorText(error)}` });
      if (log) log.warn(`[AgentBridge] plugin ${name} skipped: server() threw: ${errorText(error)}`);
    }
  }
  return { hooks, skipped };
}

function stopPlugins(hooks, log = null) {
  for (const hook of hooks) {
    if (!hook.stop) continue;
    try {
      hook.stop();
    } catch (error) {
      if (log) log.warn(`[AgentBridge] plugin ${hook.name} stop() threw: ${errorText(error)}`);
    }
  }
}

module.exports = {
  API_VERSION,
  DEFAULT_PLUGINS_DIR,
  loadPlugins,
  startPlugins,
  stopPlugins,
};
