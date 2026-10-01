"use strict";

// What a tree can do for the tool (core/capabilities.js), the bridge's
// GET /capabilities, the handshake attach mode reads, and the client view
// turning itself off when the destiny layout check fails.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  REQUIRED_GATEWAY_CALLS, buildReport, checkGatewayCalls, detectPatches, loadPatches, sessionShape,
} = require("../core/capabilities");
const { createDestinyTee, probeDestinyLayout } = require("../bridge/destiny");
const { createAgentBridgeRoutes } = require("../bridge/routes");
const { createService } = require("../bridge/entry");
const { formatTimelineEvent } = require("../core/timeline");
const { emptyRegistry } = require("../core/plugins");

function scratch(t, prefix = "e2e-capabilities-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

test("the gateway check names each refused call and what needs it", () => {
  const all = REQUIRED_GATEWAY_CALLS.map(({ service, method }) => ({ service, method }));
  const full = checkGatewayCalls(all);
  assert.equal(full.known, true);
  assert.deepEqual(full.missing, []);
  const without = checkGatewayCalls(all.filter((pair) => pair.method !== "CmdEngage" && pair.method !== "Undock"));
  assert.deepEqual(without.missing.map((call) => `${call.service}.${call.method}: ${call.usedBy}`),
    ["ship.Undock: undock", "entity.CmdEngage: act engageDrones"]);
  const unknown = checkGatewayCalls(null, "the gateway module failed to load: boom");
  assert.equal(unknown.known, false);
  assert.match(unknown.error, /boom/);
});

test("a patch reads as applied by its marker, detected by its check, absent, unknown or missing its file", (t) => {
  const root = scratch(t);
  const serverRoot = path.join(root, "server");
  write(serverRoot, "src/a.js", "const x = 1; // evejs-e2e:patch marked v2\n");
  write(serverRoot, "src/b.js", "const port = process.env.DEMO_PORT;\n");
  const patches = [
    { id: "marked", files: ["a.js"], detect: () => false },
    { id: "equivalent", files: ["b.js"], detect: ({ read }) => read("b.js").includes("DEMO_PORT") },
    { id: "absent", files: ["b.js"], detect: ({ read }) => read("b.js").includes("NOPE") },
    { id: "unsurveyed", files: [], detect: null },
    { id: "elsewhere", files: ["gone.js"], detect: () => true },
    { id: "throws", files: ["a.js"], detect: () => { throw new Error("bad check"); } },
  ];
  assert.deepEqual(detectPatches(serverRoot, { patches }).map((row) => [row.id, row.state, row.version || null]), [
    ["marked", "applied", 2],
    ["equivalent", "detected", null],
    ["absent", "absent", null],
    ["unsurveyed", "unknown", null],
    ["elsewhere", "no-target", null],
    ["throws", "unknown", null],
  ]);
  assert.deepEqual(loadPatches().map((patch) => patch.id), ["last-decision", "slash-success", "xmpp-port"]);
});

test("the shipped patches' checks find the LU fork's equivalent code and nothing in stock", (t) => {
  const stock = path.join(scratch(t), "server");
  write(stock, "src/edge/chat/chatEdgeRuntime.js", "const port = config.xmppPort;\n");
  write(stock, "src/space/npc/npcBehaviorLoop.js", "function tickController(controller) { return; }\n");
  const fork = path.join(scratch(t), "server");
  write(fork, "src/edge/chat/chatEdgeRuntime.js", "const port = Number(process.env.EVEJS_XMPP_SERVER_PORT) || 5222;\n");
  write(fork, "src/space/npc/npcBehaviorLoop.js", "controller.lastDecision = \"engage\";\n");
  const states = (serverRoot) => Object.fromEntries(detectPatches(serverRoot).map((row) => [row.id, row.state]));
  assert.deepEqual(states(stock), { "last-decision": "absent", "slash-success": "unknown", "xmpp-port": "absent" });
  assert.deepEqual(states(fork), { "last-decision": "detected", "slash-success": "unknown", "xmpp-port": "detected" });
});

test("a session's shape is what the client view checks before it attaches", () => {
  const shape = sessionShape({ clientID: 2_000_000_007, characterID: 9, socket: { destroyed: false },
    sendNotification() {}, sendSessionChange() {} });
  assert.deepEqual({ ...shape, keys: undefined }, { clientID: 2_000_000_007, gatewayClientID: true, socket: true,
    socketWrites: false, sendNotification: true, sendSessionChange: true, characterID: 9, keys: undefined });
  assert.deepEqual(shape.keys, ["characterID", "clientID", "sendNotification", "sendSessionChange", "socket"]);
  assert.equal(sessionShape(null), null);
});

test("an encoder that throws or writes another layout fails the probe with a reason", () => {
  const threw = probeDestinyLayout(() => { throw new Error("no deps"); });
  assert.equal(threw.ok, false);
  assert.match(threw.error, /encoder threw: no deps/);
  const garbage = probeDestinyLayout(() => Buffer.from([1, 0x92, 0x10, 0, 0, 7, 7, 7]));
  assert.equal(garbage.ok, false);
  assert.match(garbage.error, /not the one the decoder reads/);
});

test("an off tee attaches nothing and says why", () => {
  const tee = createDestinyTee({ off: "layout changed" });
  assert.equal(tee.off, "layout changed");
  const attached = tee.attach({ clientID: 2_000_000_001, socket: {}, sendNotification() {} });
  assert.deepEqual(attached, { ok: false, error: "client view off: layout changed" });
  assert.equal(createDestinyTee().off, null);
});

test("GET /capabilities answers through the route table, with the asked character's session", () => {
  const session = { clientID: 2_000_000_001 };
  const seen = [];
  const routes = createAgentBridgeRoutes({
    findSession: (id) => (id === 7 ? session : null),
    capabilities: (query) => { seen.push(query); return { gateway: { known: true } }; },
  });
  const reply = routes.handle("GET", "/capabilities", { characterID: "7" });
  assert.equal(reply.statusCode, 200);
  assert.deepEqual(reply.body, { ok: true, gateway: { known: true } });
  routes.handle("GET", "/capabilities", {});
  assert.deepEqual(seen, [{ session, characterID: 7 }, { session: undefined, characterID: null }]);
  assert.equal(createAgentBridgeRoutes({ findSession: () => null }).handle("GET", "/capabilities", {}).statusCode, 503);
});

test("an offline report reads a tree with no server and no config", (t) => {
  const root = scratch(t);
  const report = buildReport({ treeRoot: root, serverRoot: path.join(root, "server"), registry: emptyRegistry(),
    probe: { allowlist: null, allowlistError: "probe failed: no gateway", destiny: { ok: false, error: "probe failed", balls: 0 } } });
  assert.equal(report.gateway.known, false);
  assert.equal(report.destiny.tee, "off");
  assert.deepEqual(report.plugins, { active: [], skipped: [] });
  assert.equal(report.tool.vendored, false, "this checkout has no VENDOR.json");
});

// The whole bridge on a stock-like tree whose encoder writes another layout.
function fakeStock({ encoder }) {
  const session = { characterID: 7, clientID: 2_000_000_001, socket: { destroyed: false }, sendNotification() {},
    _space: { systemID: 30000142 } };
  const ego = { itemID: 1, typeID: 587, mode: "STOP", position: { x: 0, y: 0, z: 0 }, radius: 40 };
  const scene = { getShipEntityForSession: () => ego, getVisibleEntitiesForSession: () => [ego], getCurrentSimTimeMs: () => 0 };
  const shutdownHooks = [];
  const lines = [];
  const logger = { debug() {}, info: (line) => lines.push(line), warn: (line) => lines.push(line), err: (line) => lines.push(line) };
  const stock = {
    sessionRegistry: { findSessionByCharacterID: (id) => (Number(id) === 7 ? session : null) },
    chatCommands: { executeChatCommand: () => ({ handled: true, success: true, message: "" }) },
    space: { getSceneForSession: () => scene },
    webGateway: {
      WEB_CALL_ALLOWLIST: REQUIRED_GATEWAY_CALLS.map(({ service, method }) => ({ service, method })),
      projectSpaceEntity: (entity, egoID) => ({ itemID: entity.itemID, kind: "ship", typeID: entity.typeID,
        isSelf: entity.itemID === egoID, mode: entity.mode, position: entity.position, radius: entity.radius }),
    },
    itemTypeRegistry: { resolveItemByTypeID: () => ({ name: "Rifter" }) },
    worldData: { getSolarSystemByID: () => ({ solarSystemName: "Jita", security: 0.9 }) },
    killmailState: { listKillmailsForCharacter: () => [], listKillmailsForCorporation: () => [] },
    gameStore: { registerShutdownHook: (name, fn) => shutdownHooks.push(fn) },
    marshal: { marshalDecodeExact: () => null },
    config: { serverPort: 26000, microservicesPort: 26002 },
    dataRoot: { resolveDataRootPath: (...parts) => path.join("/data-root", ...parts) },
    storeRoot: { resolveDataDir: () => "/store/data" },
    statePayloads: { buildAddBallsStateBuffer: encoder },
    logger,
  };
  return { stock, shutdownHooks, lines };
}

test("a bridge whose tree writes another destiny layout keeps the client view off, and says so in the log, START and /capabilities", async (t) => {
  const root = scratch(t, "e2e-layout-tree-");
  const serverRoot = path.join(root, "server");
  fs.mkdirSync(path.join(serverRoot, "src"), { recursive: true });
  const handshakePath = path.join(root, "hs", "bridge.json");
  // The stock layout with one byte more after the header: every ball reads shifted.
  const { stock, shutdownHooks, lines } = fakeStock({ encoder: () => Buffer.from([1, 0x92, 0x10, 0, 0, 0, 1, 2, 3]) });
  const service = createService({ serverRoot, stock, port: 0, env: { EVEJS_AGENT_BRIDGE: "1", EVEJS_AGENT_BRIDGE_HANDSHAKE: handshakePath } });
  assert.ok(service.exec());
  t.after(() => Promise.all(shutdownHooks.map((stop) => stop())));
  let handshake = null;
  for (let tries = 0; tries < 250 && !handshake; tries += 1) {
    if (fs.existsSync(handshakePath)) handshake = JSON.parse(fs.readFileSync(handshakePath, "utf8"));
    else await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(handshake, "the bridge wrote its handshake");
  assert.deepEqual(handshake.ports, { game: 26000, gateway: 26002 }, "attach mode reads the server's own ports");
  assert.equal(handshake.logFile, path.join("/data-root", "logs", "server.log"));
  assert.equal(handshake.dataDir, "/store/data");
  assert.equal(handshake.treeRoot, root);
  assert.ok(lines.some((line) => /client view off: this tree's destiny ball layout is not the one the decoder reads/.test(line)),
    lines.join("\n"));

  const call = async (method, route, body) => (await fetch(`http://127.0.0.1:${handshake.port}${route}`, {
    method, headers: { authorization: `Bearer ${handshake.token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  })).text();
  const capabilities = JSON.parse(await call("GET", "/capabilities?characterID=7"));
  assert.equal(capabilities.destiny.tee, "off");
  assert.match(capabilities.destiny.error, /not the one the decoder reads/);
  assert.deepEqual(capabilities.gateway.missing, []);
  assert.deepEqual(capabilities.plugins.skipped.map((row) => row.name), ["lu"]);
  assert.equal(capabilities.live.session.gatewayClientID, true);
  assert.deepEqual(capabilities.live.ports, { game: 26000, gateway: 26002, agentBridge: handshake.port });

  const tee = JSON.parse(await call("POST", "/tee", { characterID: 7 }));
  assert.equal(tee.ok, false);
  assert.match(tee.error, /^client view off: /);
  const events = (await call("POST", "/watch", { characterID: 7, forSeconds: 1, everySeconds: 0.5 }))
    .trim().split("\n").map((line) => JSON.parse(line));
  const start = events[0];
  assert.equal(start.kind, "START");
  assert.equal(start.clientMode, "off");
  assert.match(start.clientOff, /not the one the decoder reads/);
  assert.match(formatTimelineEvent({ ...start, t: 0 }), /client=off \(this tree's destiny ball layout/);
  assert.ok(!events.some((event) => event.kind === "DIVERGE"), "no DIVERGE from a view that isn't there");
});
