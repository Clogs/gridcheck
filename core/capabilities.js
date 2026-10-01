"use strict";

// What a tree can do for this tool. `e2e doctor` reads it without the
// server running; GET /capabilities answers the same from inside a running
// server. Every check returns plain data; bin/e2e.js prints it.
//
//   gateway    which of the gateway calls the CLI makes the tree allows
//   destiny    whether the decoder reads the tree's ball layout (else the
//              client view stays off)
//   patches    which optional stock edits are applied, detected or absent
//   plugins    active, and skipped with the reason
//   listeners  which ports `e2e up` can move (e2e.config.json)
//   loadout    whether the stock exports POST /loadout builds a ship from are there

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const patchEngine = require("./patches");
const { LOADOUT_EXPORTS } = require("../bridge/loadout");

const COPY_ROOT = path.join(__dirname, "..");
const { PATCHES_DIR, PATCH_MARKER } = patchEngine;

// Every gateway call (service, method) the CLI makes, and what needs it.
// Gateway routes (account, characters, session) aren't on the allowlist.
const REQUIRED_GATEWAY_CALLS = Object.freeze([
  ["charUnboundMgr", "CreateCharacterWithDoll", "login, for a new character"],
  ["ship", "Undock", "undock"],
  ["beyonce", "MachoBindObject", "undock and teleport (the remote park bind)"],
  ["invbroker", "GetInventoryFromId", "act: reading the ship's modules"],
  ["invbroker", "ListByFlags", "act: reading the ship's modules"],
  ["beyonce", "CmdFollowBall", "act approach, keepAtRange"],
  ["beyonce", "CmdOrbit", "act orbit"],
  ["beyonce", "CmdWarpToStuff", "act warpTo"],
  ["beyonce", "CmdStop", "act stop"],
  ["dogmaIM", "AddTarget", "act lock"],
  ["dogmaIM", "GetTargets", "act lock"],
  ["dogmaIM", "RemoveTarget", "act unlock"],
  ["dogmaIM", "Activate", "act activate"],
  ["dogmaIM", "Deactivate", "act deactivate"],
  ["dogmaIM", "LoadAmmo", "act loadAmmo"],
  ["ship", "LaunchDrones", "act launchDrones"],
  ["entity", "CmdEngage", "act engageDrones"],
].map(([service, method, usedBy]) => Object.freeze({ service, method, usedBy })));

const GATEWAY_MODULE = "_secondary/express/evejsWebGatewayRuntime";
const ENCODER_MODULE = "space/destiny/stream/statePayloads";

// allowlist: [{ service, method }] as the gateway exports it, or null when unknown.
function checkGatewayCalls(allowlist, error = null) {
  if (!Array.isArray(allowlist)) {
    return { known: false, error: error || "the tree's gateway allowlist could not be read", calls: [], missing: [] };
  }
  const allowed = new Set(allowlist.map((pair) => `${pair.service}.${pair.method}`));
  const calls = REQUIRED_GATEWAY_CALLS.map((call) => ({ ...call, allowed: allowed.has(`${call.service}.${call.method}`) }));
  return { known: true, error: null, calls, missing: calls.filter((call) => !call.allowed) };
}

function errorText(error) {
  return error && error.message ? error.message : String(error);
}

function loadPatches(dir = PATCHES_DIR, load = require) {
  return patchEngine.loadPatches(dir, load);
}

// Each patch as the tree has it (core/patches.js patchState): applied,
// partial, detected, absent, no-target or unknown.
function detectPatches(serverRoot, { patches = loadPatches() } = {}) {
  return patchEngine.patchStates(serverRoot, { patches });
}

// The tree's allowlist and destiny probe without its server running: one
// child process loads the gateway module and the ball encoder and exits, so
// nothing either starts stays behind.
function probeTreeOffline(serverRoot, { timeoutMs = 60_000 } = {}) {
  const script = `
    const path = require("node:path");
    const out = { allowlist: null, allowlistError: null, destiny: null };
    const src = ${JSON.stringify(path.join(serverRoot, "src"))};
    try {
      const gateway = require(path.join(src, ${JSON.stringify(GATEWAY_MODULE)}));
      if (Array.isArray(gateway.WEB_CALL_ALLOWLIST)) {
        out.allowlist = gateway.WEB_CALL_ALLOWLIST.map(({ service, method }) => ({ service, method }));
      } else out.allowlistError = "the gateway exports no WEB_CALL_ALLOWLIST";
    } catch (error) { out.allowlistError = "the gateway module failed to load: " + error.message; }
    try {
      const encoder = require(path.join(src, ${JSON.stringify(ENCODER_MODULE)}));
      const { probeDestinyLayout } = require(${JSON.stringify(path.join(COPY_ROOT, "bridge", "destiny.js"))});
      out.destiny = typeof encoder.buildAddBallsStateBuffer === "function"
        ? probeDestinyLayout((stamp, entities) => encoder.buildAddBallsStateBuffer(stamp, entities))
        : { ok: false, error: "the tree has no buildAddBallsStateBuffer", balls: 0 };
    } catch (error) { out.destiny = { ok: false, error: "the ball encoder failed to load: " + error.message, balls: 0 }; }
    process.stdout.write("\\n@@capabilities@@" + JSON.stringify(out) + "\\n");
    process.exit(0);
  `;
  const env = { ...process.env };
  delete env.EVEJS_AGENT_BRIDGE;
  const result = spawnSync(process.execPath, ["-e", script], {
    cwd: serverRoot, env, encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  const line = String(result.stdout || "").split(/\r?\n/).find((text) => text.startsWith("@@capabilities@@"));
  if (!line) {
    const why = result.error ? errorText(result.error) : String(result.stderr || "").trim().split(/\r?\n/).slice(-3).join(" ");
    return { allowlist: null, allowlistError: `probe failed: ${why || "no output"}`, destiny: { ok: false, error: `probe failed: ${why}`, balls: 0 } };
  }
  return JSON.parse(line.slice("@@capabilities@@".length));
}

// The loadout's stock exports, read from the files without loading them: the
// ship runtime pulls in the whole space runtime. A name counts when it appears
// in the file's last `module.exports =` block (not `module.exports._testing`).
function probeLoadoutExports(serverRoot) {
  const missing = [];
  for (const [relativePath, names] of Object.values(LOADOUT_EXPORTS)) {
    let text;
    try {
      text = fs.readFileSync(path.join(serverRoot, "src", `${relativePath}.js`), "utf8");
    } catch (_error) {
      missing.push(`${relativePath} is not in the tree`);
      continue;
    }
    const assignments = [...text.matchAll(/module\.exports\s*=/g)];
    const exportsBlock = assignments.length ? text.slice(assignments[assignments.length - 1].index) : "";
    const absent = names.filter((name) => !new RegExp(`\\b${name}\\b`).test(exportsBlock));
    if (absent.length) missing.push(`${relativePath} has no ${absent.join(", ")}`);
  }
  return { missing };
}

// The vendored copy's VENDOR.json, or this checkout's package.json.
function copyInfo(root = COPY_ROOT) {
  const read = (file) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    } catch (_error) {
      return null;
    }
  };
  const vendored = read("VENDOR.json");
  if (vendored) return { version: vendored.version || null, commit: vendored.commit || null, vendored: true };
  const pkg = read("package.json");
  return { version: pkg ? pkg.version : null, commit: null, vendored: false };
}

function pluginReport(registryOrStatus) {
  if (!registryOrStatus) return { active: [], skipped: [] };
  const active = (registryOrStatus.plugins || registryOrStatus.active || []).map((entry) => (typeof entry === "string" ? entry : entry.name));
  return { active, skipped: (registryOrStatus.skipped || []).map(({ name, reason }) => ({ name, reason })) };
}

// The fields of a session the tee depends on (destiny.js isGatewaySession).
function sessionShape(session) {
  if (!session) return null;
  return {
    clientID: Number(session.clientID) || null,
    gatewayClientID: Number(session.clientID) >= 2_000_000_000,
    socket: Boolean(session.socket),
    socketWrites: Boolean(session.socket && typeof session.socket.write === "function"),
    sendNotification: typeof session.sendNotification === "function",
    sendSessionChange: typeof session.sendSessionChange === "function",
    characterID: Number(session.characterID || session.charid) || null,
    keys: Object.keys(session).sort(),
  };
}

// One report from what the caller could find. Offline, `probe` is
// probeTreeOffline's answer; live, the bridge passes the same shape.
function buildReport({ treeRoot, serverRoot, config = null, registry = null, probe = null, live = null,
  patches = detectPatches(serverRoot) }) {
  const gateway = checkGatewayCalls(probe ? probe.allowlist : null, probe ? probe.allowlistError : null);
  const destiny = probe && probe.destiny ? probe.destiny : { ok: false, error: "not probed", balls: 0 };
  const loadout = probe && probe.loadout ? probe.loadout : probeLoadoutExports(serverRoot);
  return {
    tool: copyInfo(),
    tree: { root: treeRoot, serverRoot, config: config ? { file: config.file, exists: config.exists, mode: config.mode,
      problems: config.problems } : null },
    gateway,
    destiny: { ...destiny, tee: destiny.ok ? "on" : "off" },
    patches,
    plugins: pluginReport(registry),
    listeners: config ? config.listeners : {},
    loadout: { ok: !loadout.missing.length, missing: loadout.missing },
    ...(live ? { live } : {}),
  };
}

module.exports = {
  PATCH_MARKER,
  PATCHES_DIR,
  REQUIRED_GATEWAY_CALLS,
  buildReport,
  checkGatewayCalls,
  copyInfo,
  detectPatches,
  loadPatches,
  probeLoadoutExports,
  probeTreeOffline,
  sessionShape,
};
