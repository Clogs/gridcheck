"use strict";

// The client agent (bridge/client.js): a minted token logs its account in, only
// that login's signedFunc carries the bootstrap, a command goes out as a
// notification and comes back through Reply, and Hello and Events report the
// client's pid and its exceptions. The Python test runs the wrapped login
// expression, bootstrap.py and agent.py under Python 3 with stub client
// modules; it says nothing about the real client's Python 2.7. Then the CLI's
// half (core/client.js), doctor's client section and the MCP mapping.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { createClientAgent, NOTIFY } = require("../bridge/client");
const { diffBallpark, findClientExe } = require("../core/client");
const { EVENT_FIELDS } = require("../core/conditions");
const { formatTimelineEvent } = require("../core/timeline");

const strVal = (value) => (Buffer.isBuffer(value) ? value.toString("utf8") : String(value));
const dictGet = (dict, key) => {
  const entry = dict.entries.find(([name]) => strVal(name) === key);
  return entry ? entry[1] : undefined;
};
const quiet = { info() {}, warn() {}, debug() {} };
const accountStore = { readAccountsTable: () => ({ e2eclient: { id: 7, passwordhash: "" } }) };
const CLIENT_ID = 7 * 1000000 + 888444;

function agentFor(overrides = {}) {
  let next = 0;
  return createClientAgent({ log: quiet, patched: () => true, mintToken: () => `token${++next}`, ...overrides });
}

function ssoLogin(token) {
  return { type: "dict", entries: [["user_name", "EVE-SSO-CONNECTION"], ["user_password_hash", "a1b2"], ["user_sso_token", Buffer.from(token)]] };
}

class FakeBase {
  constructor(name) {
    this.name = name;
  }
}

function fakeSession(userid, characterID = 0) {
  const sent = [];
  return { userid, characterID, socket: { destroyed: false }, sent, sendNotification: (...args) => sent.push(args) };
}

// An agent with one attached client for e2eclient (account 7).
function attached({ now = Date.now, characterID = 0 } = {}) {
  const agent = agentFor({ read: () => "", now });
  const service = agent.createService(FakeBase);
  const { token } = agent.mint({ username: "e2eclient" });
  agent.resolveLogin(ssoLogin(token), { accountStore, dictGet, strVal });
  const session = fakeSession(7, characterID);
  service.Handle_Attach([token], session);
  return { agent, service, token, session };
}

test("a minted token logs in as its account; any other login is left alone", () => {
  const agent = agentFor();
  const { token } = agent.mint({ username: "e2eclient" });
  const login = ssoLogin(token);
  assert.equal(agent.resolveLogin(login, { accountStore, dictGet, strVal }), true);
  assert.equal(dictGet(login, "user_name"), "e2eclient");
  assert.equal(dictGet(login, "user_password_hash"), "");

  const stranger = ssoLogin("not-minted");
  assert.equal(agent.resolveLogin(stranger, { accountStore, dictGet, strVal }), false);
  assert.equal(dictGet(stranger, "user_name"), "EVE-SSO-CONNECTION");
  const password = { type: "dict", entries: [["user_name", "someone"], ["user_password_hash", "a1b2"]] };
  assert.equal(agent.resolveLogin(password, { accountStore, dictGet, strVal }), false);

  const { token: orphan } = agent.mint({ username: "nobody" });
  assert.equal(agent.resolveLogin(ssoLogin(orphan), { accountStore, dictGet, strVal }), false, "a token for a missing account");
});

test("only the token login's signedFunc carries the bootstrap, once", () => {
  const agent = agentFor({ read: (name) => `# ${name}\n` });
  const expr = "eval(compile(\"pass\", \"<tidi>\", \"exec\"))";
  assert.equal(agent.wrapLoginExpression(expr, CLIENT_ID), expr, "no token login yet");
  const { token } = agent.mint({ username: "e2eclient" });
  agent.resolveLogin(ssoLogin(token), { accountStore, dictGet, strVal });
  assert.equal(agent.wrapLoginExpression(expr, 8 * 1000000 + 888444), expr, "another account");
  const wrapped = agent.wrapLoginExpression(expr, CLIENT_ID);
  assert.match(wrapped, /^\(lambda _gc_result: \(eval\(compile\(__import__\('base64'\)/);
  assert.ok(wrapped.endsWith(`)(${expr})`), "the stock expression still runs, and its result is the result");
  assert.ok(/^[\x20-\x7e]*$/.test(wrapped), "ASCII, as buildMarshaledString writes it");
  const source = Buffer.from(/b64decode\('([^']+)'\)/.exec(wrapped)[1], "base64").toString("utf8");
  assert.equal(source, `_gc_token = "${token}"\n# bootstrap.py\n`);
  assert.equal(agent.wrapLoginExpression(expr, CLIENT_ID), expr, "the next login needs the token login again");
});

test("no token is minted without the patch, which would log the client in as EVE-SSO-CONNECTION", () => {
  const agent = agentFor({ patched: () => false });
  const reply = agent.routes["POST /client/token"]({ body: { username: "e2eclient" } });
  assert.equal(reply.statusCode, 409);
  assert.match(reply.body.error, /client-agent patch/);
});

test("Attach answers the agent to the token's own session; a command round-trips through Reply", async () => {
  const agent = agentFor({ read: (name) => `# ${name}` });
  const service = agent.createService(FakeBase);
  const { token } = agent.mint({ username: "e2eclient" });
  agent.resolveLogin(ssoLogin(token), { accountStore, dictGet, strVal });

  assert.equal(service.Handle_Attach([token], fakeSession(8)), null, "another account's session");
  assert.equal(service.Handle_Attach(["guess"], fakeSession(7)), null, "an unknown token");
  const session = fakeSession(7);
  assert.equal(service.Handle_Attach([Buffer.from(token)], session), "# agent.py");

  const listed = agent.routes["GET /client/agents"]();
  assert.deepEqual(listed.body.agents.map((row) => [row.username, row.accountID, row.online]), [["e2eclient", 7, true]]);

  const pending = agent.routes["POST /client/command"]({ body: { op: "ping", timeoutMs: 5000 } });
  assert.equal(session.sent.length, 1);
  const [notify, idType, [payload]] = session.sent[0];
  assert.deepEqual([notify, idType], [NOTIFY, "clientID"]);
  const command = JSON.parse(payload);
  assert.deepEqual([command.op, command.args], ["ping", {}]);
  assert.equal(service.Handle_Reply([token, JSON.stringify({ id: command.id, ok: true, value: 1 })], fakeSession(7)), false,
    "a reply from another session");
  assert.equal(service.Handle_Reply([token, JSON.stringify({ id: command.id, ok: true, value: { charid: 9 } })], session), true);
  const reply = await pending;
  assert.deepEqual(reply, { statusCode: 200, body: { ok: true, op: "ping", username: "e2eclient", value: { charid: 9 } } });

  const refused = agent.routes["POST /client/command"]({ body: { op: "ping", user: "someone-else" } });
  assert.equal(refused.statusCode, 409);
});

test("Hello records the client's own pid and build; Events reach subscribers and GET /client/events as timeline lines", () => {
  let clock = 1000;
  const { agent, service, token, session } = attached({ now: () => clock, characterID: 140000006 });
  const hello = JSON.stringify({ pid: 4242, build: 3396210, agent: 2 });
  assert.equal(service.Handle_Hello([token, hello], fakeSession(7)), false, "another session");
  assert.equal(service.Handle_Hello([token, Buffer.from(hello)], session), true);
  const [row] = agent.routes["GET /client/agents"]().body.agents;
  assert.deepEqual([row.pid, row.build, row.agentVersion], [4242, "3396210", 2]);

  const seen = [];
  const unsubscribe = agent.subscribe((event) => seen.push(event));
  clock = 2000;
  assert.equal(service.Handle_Events([token, JSON.stringify({ dropped: 3, events: [
    { seq: 1, atMs: 1500, kind: "exception", type: "ZeroDivisionError", message: "division by zero", extra: "boom",
      channel: "general", where: "x.py(1) f", traceback: ["x.py(1) f"] },
    { seq: 2, atMs: 1600, kind: "notify", event: "OnSessionChanged", args: "(True,)" },
    { seq: 3, atMs: 1700, kind: "agent-error", op: "ui", error: "ValueError: x" },
  ] })], session), true);
  assert.deepEqual(seen.map((event) => [event.kind, event.event || event.type]), [["CLIENT_EVENT", "dropped"],
    ["CLIENT_EXCEPTION", "ZeroDivisionError"], ["CLIENT_EVENT", "OnSessionChanged"], ["CLIENT_EVENT", "agent-error"]]);
  assert.deepEqual([seen[1].username, seen[1].characterID, seen[1].clientAtMs, seen[1].atMs], ["e2eclient", 140000006, 1500, 2000]);
  for (const event of seen) {
    const { seq: _seq, atMs: _atMs, kind, ...fields } = event;
    for (const key of Object.keys(fields)) assert.ok(key in EVENT_FIELDS[kind], `${kind}.${key} is a field conditions know`);
  }
  unsubscribe();
  service.Handle_Events([token, JSON.stringify({ events: [{ seq: 4, kind: "notify", event: "OnSessionChanged" }] })], session);
  assert.equal(seen.length, 4, "an unsubscribed listener hears nothing more");

  const listed = agent.routes["GET /client/events"]({ query: { since: "2" } }).body;
  assert.deepEqual(listed.events.map((event) => event.seq), [3, 4, 5]);
  assert.equal(listed.seq, 5);
  assert.equal(agent.routes["GET /client/events"]({ query: { user: "someone-else" } }).body.events.length, 0);
});

test("a closed client is listed as gone, dropped ten minutes later, and replaced at once by a new client for its account", () => {
  let clock = 1000;
  const { agent, service, session } = attached({ now: () => clock });
  session.socket.destroyed = true;
  const list = () => agent.routes["GET /client/agents"]().body.agents;
  assert.deepEqual(list().map((row) => [row.online, row.goneAtMs]), [[false, 1000]]);
  clock += 9 * 60 * 1000;
  assert.equal(list().length, 1);
  clock += 2 * 60 * 1000;
  assert.equal(list().length, 0);

  const again = attached();
  again.session.socket.destroyed = true;
  const { token } = again.agent.mint({ username: "e2eclient" });
  again.agent.resolveLogin(ssoLogin(token), { accountStore, dictGet, strVal });
  again.service.Handle_Attach([token], fakeSession(7));
  assert.deepEqual(again.agent.routes["GET /client/agents"]().body.agents.map((row) => row.online), [true]);
  assert.equal(service.Handle_Hello(["token1", "{}"], session), false, "the dropped agent's token no longer answers");
});

test("install says why the client agent is off", () => {
  const agent = agentFor();
  assert.equal(agent.install(null, FakeBase), false);
  assert.match(agent.status().reason, /no service manager/);
  const registered = [];
  const manager = { lookup: (name) => registered.find((service) => service.name === name), register: (service) => registered.push(service) };
  assert.equal(agent.install(manager, FakeBase), true);
  assert.deepEqual(agent.status(), { service: "on", reason: null, patched: true, agents: 0 });
  const second = agentFor();
  assert.equal(second.install(manager, FakeBase), false);
  assert.match(second.status().reason, /registered already/);
  agent.uninstall();
});

const PYTHON = ["python3", "python"].find((name) => spawnSync(name, ["-c", "import sys; assert sys.version_info >= (3,)"]).status === 0);

test("the wrapped login expression installs the agent, which answers its ops and reports events (Python 3, stub client)", { skip: !PYTHON && "no Python 3" }, () => {
  const agent = createClientAgent({ log: quiet, patched: () => true, mintToken: () => "tok" });
  agent.mint({ username: "e2eclient" });
  agent.resolveLogin(ssoLogin("tok"), { accountStore, dictGet, strVal });
  const wrapped = agent.wrapLoginExpression("41 + 1", CLIENT_ID);
  const agentSource = fs.readFileSync(path.join(__dirname, "..", "bridge", "client", "agent.py"), "utf8");
  const harness = `
import builtins, json, sys, types
blue = types.ModuleType('blue')
blue.pyos = types.SimpleNamespace(synchro=types.SimpleNamespace(SleepWallclock=lambda ms: None))
blue.os = types.SimpleNamespace(GetWallclockTime=lambda: 134360520949600009)
uthread = types.ModuleType('uthread')
uthread.new = lambda fn, *args: fn(*args)
logged = []
logmodule = types.ModuleType('logmodule')
def _LogException(exc_info, extraText, channel, *rest):
    logged.append(extraText)
logmodule._LogException = _LogException
def LogException(extraText='', channel='general'):
    logmodule._LogException(sys.exc_info(), extraText, channel, 1, 1, None, 1, None, 1)
logmodule.LogException = LogException
eveprefs = types.ModuleType('eveprefs')
eveprefs.boot = types.SimpleNamespace(build=3396210)
sys.modules.update(blue=blue, uthread=uthread, logmodule=logmodule, eveprefs=eveprefs)
replies, hellos, batches = [], [], []
class Remote(object):
    def Attach(self, token):
        assert token == 'tok'
        return ${JSON.stringify(agentSource)}
    def Reply(self, token, text):
        replies.append(json.loads(text))
    def Hello(self, token, text):
        hellos.append(json.loads(text))
    def Events(self, token, text):
        batches.append(json.loads(text))
def ball(id, x, mode, vx=0.0):
    return types.SimpleNamespace(id=id, x=float(x), y=0.0, z=0.0, vx=vx, vy=0.0, vz=0.0, mode=mode, radius=50.0,
                                 followId=0, followRange=0.0, isFree=True)
def slim(typeID, name=None):
    return types.SimpleNamespace(typeID=typeID, groupID=25, categoryID=6, ownerID=1, name=name)
class Park(object):
    ego = 1
    currentTime = 77
    balls = {1: ball(1, 0, 2), 2: ball(2, 5000, 4, 30.0), -5: ball(-5, 1, 2)}
    def GetBall(self, id):
        return self.balls.get(id)
    def GetBallsAndItems(self):
        return [(self.balls[1], slim(587, 'Rifter')), (self.balls[2], slim(594))]
class Michelle(object):
    def GetBallpark(self):
        return Park()
class SM(object):
    listeners = {}
    def RemoteSvc(self, name):
        assert name == 'gridcheckClient'
        return Remote()
    def GetService(self, name):
        assert name == 'michelle'
        return Michelle()
    def RegisterForNotifyEvent(self, owner, event):
        self.listeners.setdefault(event, []).append(owner)
    def UnregisterForNotifyEvent(self, owner, event):
        self.listeners[event].remove(owner)
class Node(object):
    def __init__(self, name, children=(), text=None, display=True, state=0):
        self.name, self.children, self.display, self.state = name, list(children), display, state
        if text is not None:
            self.text = text
    def GetAbsolute(self):
        return (1.4, 2, 30, 40)
    def IsEnabled(self):
        return self.state == 0
class UndockButton(Node):
    pass
lobby = Node('lobbyWnd', [UndockButton('undockButton', [Node('label', text='Undock')], text='Undock')])
desktop = Node('Desktop', [Node('l_main', [lobby], state=3), Node('l_hidden', [UndockButton('ghost', text='Undock')], display=False)])
builtins.uicore = types.SimpleNamespace(desktop=desktop, registry=types.SimpleNamespace(GetWindows=lambda: [lobby]))
builtins.sm = SM()
builtins.session = types.SimpleNamespace(userid=7, charid=90000001, solarsystemid2=30002537, role=7348784299939993600)
result = eval(${JSON.stringify(wrapped)})
assert result == 42, result
assert getattr(builtins, '_gridcheck_client_agent_v1') is not None
owner = builtins.sm.listeners['OnGridcheckClient'][0]
def send(id, op, args):
    owner.OnGridcheckClient(json.dumps({'id': id, 'op': op, 'args': args}))
send(1, 'ping', {})
send(2, 'eval', {'code': 'session.charid'})
send(3, 'eval', {'code': 'x = 2\\nresult = [x, session.solarsystemid2]'})
send(4, 'eval', {'code': '1/0'})
send(5, 'nope', {})
send(6, 'eval', {'code': '2 ** 60'})
send(7, 'ui', {'text': 'undock'})
send(8, 'ui', {'depth': 1})
send(9, 'ballpark', {})
send(10, 'events', {'notify': ['OnDamageStateChange'], 'limit': 0})
for listener in builtins.sm.listeners['OnDamageStateChange']:
    listener.OnDamageStateChange(2, {'shield': 0.5})
try:
    1 / 0
except ZeroDivisionError:
    logmodule.LogException('boom')
send(11, 'events', {'since': 0})
print(json.dumps({'replies': replies, 'hellos': hellos, 'batches': batches, 'logged': logged}))
`;
  const run = spawnSync(PYTHON, ["-c", harness], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split(/\r?\n/);
  assert.ok(lines.includes("GRIDCHECK_CLIENT:READY"), run.stdout);
  const { replies, hellos, batches, logged } = JSON.parse(lines[lines.length - 1]);
  const byID = Object.fromEntries(replies.map((reply) => [reply.id, reply]));
  assert.deepEqual(replies.map((reply) => [reply.id, reply.ok]), [[1, true], [2, true], [3, true], [4, false], [5, false],
    [6, true], [7, true], [8, true], [9, true], [10, true], [11, true]]);

  assert.deepEqual([hellos.length, hellos[0].agent, hellos[0].build, typeof hellos[0].pid], [1, 2, 3396210, "number"]);
  assert.equal(byID[1].value.session.charid, 90000001);
  assert.equal(byID[1].value.session.role, "7348784299939993600", "an integer past 2^53 goes as a string");
  assert.equal(byID[1].value.wallclock, "134360520949600009");
  assert.deepEqual(byID[2].value, { repr: "90000001", truncated: false, json: 90000001 });
  assert.deepEqual(byID[3].value.json, [2, 30002537]);
  assert.match(byID[4].error, /ZeroDivisionError/);
  assert.match(byID[5].error, /unknown op: nope/);
  assert.deepEqual(byID[6].value, { repr: "1152921504606846976", truncated: false, json: "1152921504606846976" });

  const ui = byID[7].value;
  assert.deepEqual(ui.matches.map((node) => node.path),
    ["/Desktop/l_main/lobbyWnd/undockButton", "/Desktop/l_main/lobbyWnd/undockButton/label"], "a hidden subtree isn't walked");
  assert.deepEqual([ui.matches[0].cls, ui.matches[0].rect, ui.matches[0].state, ui.matches[1].text],
    ["UndockButton", [1, 2, 30, 40], "normal", "Undock"]);
  assert.deepEqual(ui.windows.map((window) => window.name), ["lobbyWnd"]);
  const tree = byID[8].value.tree;
  assert.deepEqual(tree.kids.map((node) => [node.name, node.state, node.children, "kids" in node]), [["l_main", "pickChildren", 1, false]]);

  const park = byID[9].value;
  assert.deepEqual([park.inSpace, park.egoID, park.solarSystemID, park.count, park.ballCount], [true, 1, 30002537, 2, 3]);
  assert.deepEqual(park.balls.map((ball) => [ball.itemID, ball.mode, ball.distanceMeters, ball.name]),
    [[1, "STOP", 0, "Rifter"], [2, "ORBIT", 5000, null]]);
  assert.deepEqual(park.balls[1].velocity, [30, 0, 0]);
  assert.deepEqual(byID[10].value.notify, ["OnDamageStateChange"], "notify replaces OnSessionChanged");

  const recorded = batches.flatMap((batch) => batch.events);
  assert.deepEqual(recorded.map((event) => event.seq), recorded.map((_event, index) => index + 1), "each event sent once, in order");
  assert.deepEqual(recorded.map((event) => event.kind), ["agent-error", "agent-error", "notify", "exception"]);
  assert.deepEqual([recorded[1].op, recorded[2].event], ["nope", "OnDamageStateChange"]);
  assert.deepEqual([recorded[3].type, recorded[3].message, recorded[3].extra], ["ZeroDivisionError", "division by zero", "boom"]);
  assert.deepEqual(logged, ["boom"], "the client's own logging still runs");
  assert.deepEqual(byID[11].value.events.map((event) => event.kind), recorded.map((event) => event.kind));
});

test("the client is --exe, EVEJS_CLIENT_EXE, or EVEJS_CLIENT_PATH from the environment or the launcher config", () => {
  const clientPath = path.join(os.tmpdir(), "eve", "tq");
  const exe = path.join(clientPath, "bin64", "exefile.exe");
  const exists = (file) => path.resolve(file) === exe;
  const config = `@echo off\r\nset "EVEJS_CLIENT_PATH=${clientPath}"\r\n`;
  assert.deepEqual(findClientExe({ treeRoot: "T", env: {}, exists, readText: () => config }),
    { exe, source: "tools/ClientSETUP/scripts/EvEJSConfig.bat" });
  assert.deepEqual(findClientExe({ treeRoot: "T", env: { EVEJS_CLIENT_PATH: clientPath }, exists, readText: () => "" }),
    { exe, source: "EVEJS_CLIENT_PATH" });
  assert.deepEqual(findClientExe({ exe, env: {}, exists }), { exe, source: "--exe" });
  assert.match(findClientExe({ exe: "nope.exe", env: {}, exists }).error, /doesn't exist/);
  assert.match(findClientExe({ env: { EVEJS_CLIENT_EXE: "nope.exe" }, exists }).error, /EVEJS_CLIENT_EXE/);
  assert.match(findClientExe({ treeRoot: "T", env: {}, exists, readText: () => "" }).error, /no EVE client found/);
  assert.match(findClientExe({ treeRoot: "T", env: { EVEJS_CLIENT_PATH: os.tmpdir() }, exists, readText: () => "" }).error, /no bin64/);
});

test("diff: what the server sent and the client lacks, what only the client holds, moved and mode differences", () => {
  const at = (x) => ({ x, y: 0, z: 0 });
  const grid = { solarSystemID: 30002537, inSpace: true, entities: [
    { itemID: 1, name: "self", position: at(0), velocity: at(0), mode: "STOP" },
    { itemID: 2, typeName: "Rifter", kind: "ship", position: at(5000), velocity: at(300), mode: "ORBIT", distanceMeters: 5000 },
    { itemID: 3, typeName: "Pirate", kind: "ship", position: at(9000), velocity: at(0), mode: "STOP" },
    { itemID: 4, typeName: "Wreck", kind: "wreck", position: at(100), velocity: at(0), distanceMeters: 100.4 },
  ] };
  const client = { inSpace: true, solarSystemID: 30002537, balls: [
    { itemID: 1, position: [0, 0, 0], mode: "STOP" },
    { itemID: 2, position: [6500, 0, 0], mode: "ORBIT" },
    { itemID: 3, position: [10200, 0, 0], mode: "GOTO" },
    { itemID: 60000001, categoryID: 3, position: [1e9, 0, 0], mode: "RIGID" },
    { itemID: 99, name: "ghost", categoryID: 6, position: [1, 1, 1], mode: "STOP", distanceMeters: 1.7 },
  ] };
  const diff = diffBallpark(client, grid);
  assert.equal(diff.ok, false);
  assert.deepEqual(diff.counts, { server: 4, client: 5, shared: 3, staticOnlyInClient: 1 });
  assert.deepEqual(diff.missing, [{ itemID: 4, label: "Wreck", kind: "wreck", typeID: null, distanceMeters: 100 }]);
  assert.deepEqual(diff.extra, [{ itemID: 99, label: "ghost", typeID: null, mode: "STOP", distanceMeters: 2 }]);
  assert.deepEqual(diff.moved, [{ itemID: 3, label: "Pirate", errorMeters: 1200, allowedMeters: 1000 }],
    "the Rifter's 1500 m is within 1000 m plus 2 s at 300 m/s");
  assert.deepEqual(diff.modes, [{ itemID: 3, label: "Pirate", server: "STOP", client: "GOTO" }]);

  const agree = diffBallpark({ ...client, balls: client.balls.slice(0, 2).concat(client.balls[3]) },
    { ...grid, entities: grid.entities.slice(0, 2) });
  assert.equal(agree.ok, true);
  assert.equal(diffBallpark({ ...client, solarSystemID: 1, balls: [] }, { ...grid, entities: [] }).ok, false, "another system");
});

test("client events read as timeline lines, with the clock when asked", () => {
  const line = formatTimelineEvent({ t: 6000, kind: "CLIENT_EXCEPTION", username: "e2eclient", type: "ZeroDivisionError",
    message: "integer division or modulo by zero", where: "<gridcheck-eval>(1) <lambda>" });
  assert.match(line, /^t\+00:00:06  CLIENT_EXCEPTION e2eclient: ZeroDivisionError: integer division or modulo by zero +<gridcheck-eval>/);
  const atMs = new Date(2026, 9, 9, 22, 41, 30).getTime();
  assert.match(formatTimelineEvent({ atMs, kind: "CLIENT_EVENT", username: "e2eclient", event: "OnSessionChanged" }, null, { clock: true }),
    /^22:41:30  CLIENT_EVENT e2eclient: OnSessionChanged$/);
});

test("doctor's client section names each missing part with its fix", () => {
  const { buildReport } = require("../core/capabilities");
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "gridcheck-client-"));
  try {
    const report = buildReport({ treeRoot: tree, serverRoot: tree, patches: [{ id: "client-agent", state: "absent" }],
      probe: { client: { service: "off", reason: "the tree has no services/baseService" } }, env: { EVEJS_CLIENT_EXE: path.join(tree, "nope.exe") } });
    assert.equal(report.client.ok, false);
    assert.deepEqual([report.client.patch, report.client.service, report.client.exe], ["absent", "off", null]);
    assert.deepEqual(report.client.fixes.map((fix) => fix.split(/ \(|: | names /)[0]),
      ["gridcheck patch apply client-agent, then restart the server", "the bridge's gridcheckClient service is off", "EVEJS_CLIENT_EXE"]);
    const offline = buildReport({ treeRoot: tree, serverRoot: tree, patches: [{ id: "client-agent", state: "applied" }],
      env: { EVEJS_CLIENT_EXE: tree } });
    assert.deepEqual([offline.client.ok, offline.client.service, offline.client.fixes], [true, "unknown", []]);
  } finally {
    fs.rmSync(tree, { recursive: true, force: true });
  }
});

test("the MCP client tools map onto `gridcheck client`; free text and the subcommand go after --", () => {
  const { cliArgs } = require("../bin/mcp");
  assert.deepEqual(cliArgs("client_eval", { code: "--x", user: "u" }), ["client", "--user=u", "--", "eval", "--x"]);
  assert.deepEqual(cliArgs("client_launch", { wait: 0 }), ["client", "--wait=0", "--", "launch"]);
  assert.deepEqual(cliArgs("client_ui", { cls: "Button", hidden: true }), ["client", "--class=Button", "--hidden", "--", "ui"]);
  assert.deepEqual(cliArgs("client_events", { notify: [] }), ["client", "--notify=", "--", "events"], "an empty list clears");
  assert.deepEqual(cliArgs("client_screenshot", {}), ["client", "--max-width=1600", "--format=jpg", "--json", "--", "screenshot"]);
});
