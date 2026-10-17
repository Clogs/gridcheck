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
const { EVENT_FIELDS, parseCondition, resolveField } = require("../core/conditions");
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
  return createClientAgent({ log: quiet, patched: () => true, testTree: () => true, mintToken: () => `token${++next}`, ...overrides });
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

test("no token is minted in a tree without gridcheck.config.json, though EVEJS_AGENT_BRIDGE=1 turned the bridge on", () => {
  let configured = false;
  const agent = agentFor({ testTree: () => configured });
  const reply = agent.routes["POST /client/token"]({ body: { username: "e2eclient" } });
  assert.equal(reply.statusCode, 409);
  assert.match(reply.body.error, /isn't a gridcheck test tree/);
  configured = true;
  assert.equal(agent.routes["POST /client/token"]({ body: { username: "e2eclient" } }).statusCode, 200, "read at each mint");
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
  const hello = JSON.stringify({ pid: 4242, build: 3396210, checkedBuild: 3396210, agent: 4 });
  assert.equal(service.Handle_Hello([token, hello], fakeSession(7)), false, "another session");
  assert.equal(service.Handle_Hello([token, Buffer.from(hello)], session), true);
  const [row] = agent.routes["GET /client/agents"]().body.agents;
  assert.deepEqual([row.pid, row.build, row.checkedBuild, row.agentVersion], [4242, "3396210", "3396210", 4]);

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

test("the retail client's content-host gaierror is noise: conditions skip it unless they name noise", () => {
  const { agent, service, token, session } = attached({ characterID: 140000006 });
  const seen = [];
  agent.subscribe((event) => seen.push(event));
  const root = "C:\\BuildAgent\\work\\20d73f1b24eed06e\\eve\\release\\V24.01\\packages\\";
  service.Handle_Events([token, JSON.stringify({ events: [
    { seq: 1, kind: "exception", type: "gaierror", message: "[Errno 11001] getaddrinfo failed",
      where: `${root}content\\client\\flatbuffer\\repository.py(107) _request_update_task` },
    { seq: 2, kind: "exception", type: "gaierror", message: "[Errno 11001] getaddrinfo failed",
      where: `${root}eve\\client\\script\\somewhere.py(12) Fetch` },
    { seq: 3, kind: "exception", type: "UserError", message: "PerformSessionChangeInProgress", where: "sessions.py(429) __RaisePSCIP" },
  ] })], session);
  assert.deepEqual(seen.map((event) => event.noise), ["content-host", null, null], "a gaierror from anywhere else is no noise");

  const matching = (text) => seen.filter((event) => parseCondition(text).test(event)).map((event) => event.clientSeq);
  assert.deepEqual(matching("CLIENT_EXCEPTION"), [2, 3]);
  assert.deepEqual(matching("CLIENT_EXCEPTION type=gaierror"), [2]);
  assert.deepEqual(matching("CLIENT_EXCEPTION noise"), [1]);
  assert.deepEqual(matching("CLIENT_EXCEPTION noise=content-host"), [1]);
  assert.deepEqual(matching("CLIENT_EXCEPTION !noise"), [2, 3]);
  assert.deepEqual(matching("CLIENT_EXCEPTION type!=gaierror"), [3], "the old way still reads the same");
  assert.match(formatTimelineEvent({ t: 0, ...seen[0] }), /CLIENT_EXCEPTION \(noise: content-host\) e2eclient: gaierror/);
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

test("an account with another live session gets no client: not at mint, not at login", () => {
  const headless = { userid: 7, socket: { destroyed: false } };
  const sessions = [headless];
  const agent = agentFor({ liveSessions: () => sessions });
  const refused = agent.routes["POST /client/token"]({ body: { username: "e2eclient", accountID: 7 } });
  assert.equal(refused.statusCode, 409);
  assert.match(refused.body.error, /already has a session/);
  assert.equal(refused.body.statusCode, undefined, "the status isn't part of the body");

  const { token } = agent.mint({ username: "e2eclient" });
  const login = ssoLogin(token);
  assert.equal(agent.resolveLogin(login, { accountStore, dictGet, strVal }), false, "the headless pilot is still on");
  assert.equal(dictGet(login, "user_name"), "EVE-SSO-CONNECTION");
  sessions.length = 0;
  assert.equal(agent.resolveLogin(login, { accountStore, dictGet, strVal }), true);
});

test("a client that reconnects carries on: same token at login, its agent rebound to the new session", () => {
  const sessions = [];
  const agent = agentFor({ read: () => "", liveSessions: () => sessions });
  const service = agent.createService(FakeBase);
  const { token } = agent.mint({ username: "e2eclient", accountID: 7 });
  agent.resolveLogin(ssoLogin(token), { accountStore, dictGet, strVal });
  const first = { ...fakeSession(7, 140000006), socket: { destroyed: false, write() {} } };
  sessions.push(first);
  service.Handle_Attach([token], first);

  first.socket.destroyed = true;
  sessions.length = 0;
  sessions.push({ userid: 7, socket: { destroyed: false } });
  assert.deepEqual(agent.routes["GET /client/agents"]().body.agents.map((row) => row.online), [false],
    "a gateway session for the account isn't the client's");
  assert.equal(agent.resolveLogin(ssoLogin(token), { accountStore, dictGet, strVal }), false, "nor may the client log in beside it");

  sessions.length = 0;
  assert.equal(agent.resolveLogin(ssoLogin(token), { accountStore, dictGet, strVal }), true,
    "the dead first session doesn't block its own token");
  const second = { ...fakeSession(7, 140000006), socket: { destroyed: false, write() {} } };
  sessions.push(second);
  const [row] = agent.routes["GET /client/agents"]().body.agents;
  assert.deepEqual([row.online, typeof row.reconnectedAtMs], [true, "number"]);
  agent.routes["POST /client/command"]({ body: { op: "ping", timeoutMs: 1000 } });
  assert.equal(second.sent.length, 1, "commands go to the new session");
  assert.equal(service.Handle_Hello([token, JSON.stringify({ pid: 5 })], second), true, "and its answers are taken");
});

test("a new client for the account isn't taken for the old one reconnecting", () => {
  const sessions = [];
  const agent = agentFor({ read: () => "", liveSessions: () => sessions });
  const service = agent.createService(FakeBase);
  const login = () => {
    const { token } = agent.mint({ username: "e2eclient", accountID: 7 });
    agent.resolveLogin(ssoLogin(token), { accountStore, dictGet, strVal });
    return token;
  };
  const oldToken = login();
  const first = { ...fakeSession(7), socket: { destroyed: false, write() {} } };
  service.Handle_Attach([oldToken], first);
  first.socket.destroyed = true;

  const newToken = login();
  const second = { ...fakeSession(7), socket: { destroyed: false, write() {} } };
  sessions.push(second);
  assert.deepEqual(agent.routes["GET /client/agents"]().body.agents.map((row) => row.online), [false],
    "before the new client attaches, the old agent stays gone");
  service.Handle_Attach([newToken], second);
  const rows = agent.routes["GET /client/agents"]().body.agents;
  assert.deepEqual(rows.map((row) => [row.online, row.reconnectedAtMs]), [[true, null]], "one client: the new one");
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

const SHOT_PATH = path.join(os.tmpdir(), "gridcheck-shot.png");
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
# A sleep moves the client's sim clock on (blue time: 100 ns) and returns at once.
clock = [0]
def sleep_wallclock(ms):
    clock[0] += ms
blue.pyos = types.SimpleNamespace(synchro=types.SimpleNamespace(SleepWallclock=sleep_wallclock))
blue.os = types.SimpleNamespace(GetWallclockTime=lambda: 134360520949600009, GetSimTime=lambda: clock[0] * 10000)
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
trinity = types.ModuleType('trinity')
shot = []
class Target(object):
    def __init__(self, width, height, fmt, readable):
        self.width, self.height, self.format, self.isReadable = width, height, fmt, readable
    def Resolve(self, into):
        shot.append(['resolve', into.width, into.height, into.isReadable])
class HostBitmap(object):
    def __init__(self, source):
        self.format = source.format
    def ChangeFormat(self, fmt):
        self.format = fmt
    def Save(self, path):
        shot.append(['save', path, self.format])
        return True
trinity.PIXEL_FORMAT = types.SimpleNamespace(B8G8R8A8_UNORM=87, B8G8R8X8_UNORM=88)
trinity.device = types.SimpleNamespace(GetRenderContext=lambda: types.SimpleNamespace(
    GetDefaultBackBuffer=lambda: Target(1839, 870, 87, False)))
trinity.Tr2RenderTarget = lambda width, height, mips, fmt: Target(width, height, fmt, True)
trinity.Tr2HostBitmap = HostBitmap
sys.modules.update(blue=blue, uthread=uthread, logmodule=logmodule, eveprefs=eveprefs, trinity=trinity)
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
did = []
class Recorder(object):
    def __init__(self, name):
        self.name = name
    def __getattr__(self, method):
        return lambda *args, **kwargs: did.append([self.name, method] + list(args) + sorted(kwargs.items()))
class Targets(Recorder):
    def GetTargets(self):
        return {555: 1}
    def GetTargeting(self):
        return [556]
movement = types.ModuleType('eve.client.script.ui.services.menuSvcExtras.movementFunctions')
for fn in ('WarpToItem', 'Approach', 'Orbit', 'KeepAtRange', 'DockOrJumpOrActivateGate'):
    setattr(movement, fn, getattr(Recorder('movement'), fn))
parts = movement.__name__.split('.')
for n in range(1, len(parts)):
    package = types.ModuleType('.'.join(parts[:n]))
    package.__path__ = []
    sys.modules[package.__name__] = package
sys.modules['eve.client.script.ui.services.menuSvcExtras'].movementFunctions = movement
sys.modules[movement.__name__] = movement
undocked = []
class Undocking(object):
    def ExitDockableLocation(self):
        undocked.append(clock[0])
        builtins.session.stationid = None
        builtins.session.solarsystemid = 30002537
class SM(object):
    listeners = {}
    def RemoteSvc(self, name):
        assert name == 'gridcheckClient'
        return Remote()
    def GetService(self, name):
        if name == 'michelle':
            return Michelle()
        if name == 'undocking':
            return Undocking()
        return Targets(name) if name == 'target' else Recorder(name)
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
    def press(self):
        did.append(['press', self.name])
    def OnClick(self, *args):
        self.press()
class Edit(Node):
    value = ''
    def SetValue(self, text):
        self.value = text
    def GetText(self):
        return self.value
nameEdit = Edit('nameEdit')
lobby = Node('lobbyWnd', [UndockButton('undockButton', [Node('label', text='Undock')], text='Undock'), nameEdit])
desktop = Node('Desktop', [Node('l_main', [lobby], state=3), Node('l_hidden', [UndockButton('ghost', text='Undock')], display=False)])
desktop.width, desktop.height = 1280, 720
class Registry(object):
    focus = None
    modal = None
    def GetWindows(self):
        return [lobby]
    def GetModalWindow(self):
        return self.modal
    def GetFocus(self):
        return self.focus
    def SetFocus(self, item):
        self.focus = item
registry = Registry()
class UILib(object):
    def _OnChar(self, char, flags, dead):
        if char == 8:
            registry.focus.value = registry.focus.value[:-1]
        elif char >= 32:
            registry.focus.value += chr(char)
    def _OnKeyDown(self, vk, flags):
        did.append(['keydown', vk])
    def _OnKeyUp(self, vk, flags):
        did.append(['keyup', vk])
class Mapping(object):
    def __init__(self, name):
        self.name, self.category = name, 'window'
    def GetDescription(self):
        return 'Label ' + self.name
    def GetShortcutAsString(self):
        return 'Alt+I' if self.name == 'OpenInventory' else ''
class CommandMap(object):
    byName = dict((name, Mapping(name)) for name in ('CmdStopShip', 'OpenInventory', 'CmdBlocked'))
    def GetAllCommands(self):
        return list(self.byName.values())
    def GetCommandByName(self, name):
        return self.byName.get(name)
class Cmd(object):
    commandMap = CommandMap()
    def IsCommandEnabled(self, mapping):
        return mapping.name != 'CmdBlocked'
    def ExecuteCommand(self, mapping, *args):
        did.append(['cmd', mapping.name] + list(args))
        return 7
    def AskSomething(self):
        registry.modal = Node('modal', text='Are you sure?')
class Effect(object):
    isActive = False
class ModuleButton(object):
    def __init__(self, itemID, flag):
        self.moduleinfo = types.SimpleNamespace(itemID=itemID, typeID=3082)
        self.locationFlag, self.online, self.def_effect = flag, True, Effect()
    def ActivateModule(self):
        did.append(['activate', self.moduleinfo.itemID])
    def DeactivateModule(self):
        did.append(['deactivate', self.moduleinfo.itemID])
    def ActivateEffect(self, effect, targetID=None):
        did.append(['effect', self.moduleinfo.itemID, targetID])
        effect.isActive = True
shipui = types.SimpleNamespace(isopen=True, slotsContainer=types.SimpleNamespace(modulesByID={101: ModuleButton(101, 27), 102: ModuleButton(102, 20)}))
builtins.uicore = types.SimpleNamespace(desktop=desktop, registry=registry, dpiScaling=1.25, uilib=UILib(), cmd=Cmd(),
                                        layer=types.SimpleNamespace(shipui=shipui))
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
send(12, 'find', {'cls': 'undock', 'hidden': True})
send(13, 'find', {'name': 'label'})
send(14, 'click', {'text': 'undock'})
send(15, 'type', {'into': {'name': 'nameEdit'}, 'text': 'Abc'})
send(16, 'key', {'vk': 8})
send(17, 'key', {'vk': 0x41, 'into': {'name': 'nameEdit'}})
send(18, 'cmd', {'filter': 'inv'})
send(19, 'cmd', {'name': 'OpenInventory'})
send(20, 'cmd', {'name': 'CmdBlocked'})
send(21, 'cmd', {'name': 'AskSomething'})
send(22, 'act', {'action': 'modules'})
send(23, 'act', {'action': 'activate', 'module': 'high1', 'target': 555})
send(24, 'act', {'action': 'warpTo', 'target': 2, 'range': 10000})
send(25, 'act', {'action': 'undock'})
send(26, 'act', {'action': 'deactivate', 'module': 'med2'})
send(27, 'click', {'path': '/Desktop/l_main/lobbyWnd/nameEdit'})
eveprefs.boot.build = 3400000
send(28, 'ui', {'depth': 0})
send(29, 'eval', {'code': '1'})
send(30, 'ui', {'depth': 0, 'anyBuild': True})
eveprefs.boot.build = 3396210
send(31, 'screenshot', {'path': ${JSON.stringify(SHOT_PATH)}})
send(32, 'screenshot', {'path': 'shot.png'})
send(33, 'eval', {'code': 'y = 5\\ny * 2'})
send(34, 'eval', {'code': 'blue.os.GetSimTime() >= 0, uthread is not None'})
# Docked, with the client's session-change timer running for 3 s more.
builtins.session.stationid = 60000001
builtins.session.solarsystemid = None
builtins.session.nextSessionChange = (clock[0] + 3000) * 10000
held_from = clock[0]
send(35, 'act', {'action': 'undock'})
send(36, 'act', {'action': 'stop', 'wait': 0})
# flush: a late exception's batch waits on a tasklet that hasn't run yet; flush sends it before it
# answers, and the tasklet, when it runs, finds nothing left to send.
tasklets = []
uthread.new = lambda fn, *args: tasklets.append((fn, args))
try:
    1 / 0
except ZeroDivisionError:
    logmodule.LogException('late')
batches_before = len(batches)
owner.run(json.dumps({'id': 37, 'op': 'flush', 'args': {}}))
flushed = [len(batches) - batches_before]
for fn, args in tasklets:
    fn(*args)
flushed.append(len(batches) - batches_before)
print(json.dumps({'replies': replies, 'hellos': hellos, 'batches': batches, 'logged': logged, 'did': did,
                  'edit': nameEdit.value, 'shot': shot, 'undocked': [at - held_from for at in undocked],
                  'flushed': flushed}))
`;
  // A file, not -c: with agent.py inside, the harness passes Windows' 32 KB command-line limit.
  const script = path.join(os.tmpdir(), `gridcheck-agent-harness-${process.pid}.py`);
  fs.writeFileSync(script, harness);
  const run = spawnSync(PYTHON, [script], { encoding: "utf8" });
  fs.rmSync(script, { force: true });
  assert.equal(run.status, 0, run.stderr || String(run.error));
  const lines = run.stdout.trim().split(/\r?\n/);
  assert.ok(lines.includes("GRIDCHECK_CLIENT:READY"), run.stdout);
  const { replies, hellos, batches, logged, did, edit, shot, undocked, flushed } = JSON.parse(lines[lines.length - 1]);
  const byID = Object.fromEntries(replies.map((reply) => [reply.id, reply]));
  assert.deepEqual(replies.map((reply) => [reply.id, reply.ok]), [[1, true], [2, true], [3, true], [4, false], [5, false],
    [6, true], [7, true], [8, true], [9, true], [10, true], [11, true], [12, false], [13, true], [14, true], [15, true],
    [16, true], [17, true], [18, true], [19, true], [20, false], [21, true], [22, true], [23, true], [24, true], [25, false],
    [26, true], [27, false], [28, false], [29, true], [30, true], [31, true], [32, false], [33, true], [34, true], [35, true],
    [36, true], [37, true]], JSON.stringify(replies.filter((reply) => !reply.ok).map((reply) => [reply.id, reply.error.trim().split("\n").pop()])));

  assert.deepEqual([hellos.length, hellos[0].agent, hellos[0].build, hellos[0].checkedBuild, typeof hellos[0].pid],
    [1, 8, 3396210, 3396210, "number"]);
  assert.match(byID[28].error, /ui uses client code checked against build 3396210; this client is build 3400000/,
    "another build: ops that use client names refuse, eval and anyBuild still run");
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
  const early = recorded.slice(0, 3);
  assert.deepEqual(early.map((event) => event.kind), ["agent-error", "notify", "exception"],
    "a failed eval is its caller's alone, not an agent-error event");
  assert.deepEqual([early[0].op, early[1].event], ["nope", "OnDamageStateChange"]);
  assert.deepEqual([early[2].type, early[2].message, early[2].extra], ["ZeroDivisionError", "division by zero", "boom"]);
  assert.deepEqual(logged, ["boom", "late"], "the client's own logging still runs");
  assert.deepEqual(byID[11].value.events.map((event) => event.kind), early.map((event) => event.kind));

  // Driving: find and click go to the nearest node with a click handler.
  assert.match(byID[12].error, /2 nodes match; pass index or path:\n {2}\[0\] \/Desktop\/l_main\/lobbyWnd\/undockButton\n {2}\[1\] \/Desktop\/l_hidden\/ghost/);
  const found = byID[13].value;
  assert.deepEqual([found.node.path, found.target.path],
    ["/Desktop/l_main/lobbyWnd/undockButton/label", "/Desktop/l_main/lobbyWnd/undockButton"]);
  assert.deepEqual([byID[14].value.finished, byID[14].value.clicked.path, byID[14].value.modal],
    [true, "/Desktop/l_main/lobbyWnd/undockButton", null]);
  assert.match(byID[27].error, /nor a node above it has OnClick/);
  assert.deepEqual([byID[15].value.focus.value, byID[16].value.focus.value, byID[17].value.focus.value, edit],
    ["Abc", "Ab", "Aba", "Aba"], "typed into the edit it focused, a backspace, then the A key into the named edit");
  assert.deepEqual(byID[18].value.commands, [{ name: "OpenInventory", label: "Label OpenInventory", shortcut: "Alt+I",
    category: "window", enabled: true }]);
  assert.deepEqual([byID[19].value.result, byID[19].value.bound], [7, true]);
  assert.match(byID[20].error, /CmdBlocked is disabled or blocked/);
  assert.deepEqual([byID[21].value.bound, byID[21].value.modal.text], [false, "Are you sure?"], "the dialog it opened is named");
  assert.deepEqual(byID[22].value, { targets: [555], modules: [
    { itemID: 101, typeID: 3082, name: null, slot: "high1", flag: 27, online: true, activatable: true, active: false },
    { itemID: 102, typeID: 3082, name: null, slot: "med2", flag: 20, online: true, activatable: true, active: false }] });
  assert.match(byID[25].error, /not docked/);
  assert.deepEqual([byID[23].value.targets, byID[23].value.locking], [[555], [556]], "where the locks stand after activating on one");
  assert.deepEqual(did, [["press", "undockButton"], ["keydown", 8], ["keyup", 8], ["keydown", 65], ["keyup", 65], ["cmd", "OpenInventory"],
    ["effect", 101, 555], ["movement", "WarpToItem", 2, ["warpRange", 10000]], ["deactivate", 102], ["cmd", "CmdStopShip"]]);
  // The back buffer can't be read directly: resolved into a readable copy, its alpha dropped, saved where asked.
  assert.deepEqual([byID[31].value.file, byID[31].value.width, byID[31].value.height], [SHOT_PATH, 1839, 870]);
  assert.deepEqual(shot, [["resolve", 1839, 870, true], ["save", SHOT_PATH, 88]]);
  assert.match(byID[32].error, /path: an absolute path ending \.png/);
  const actions = recorded.filter((event) => event.kind === "action");
  assert.deepEqual(actions.map((event) => [event.op, event.args.replace(/\d+\.\d s/, "N s")]), [
    ["click /Desktop/l_main/lobbyWnd/undockButton", "finished"], ["cmd OpenInventory", "finished"],
    ["cmd AskSomething", "finished"], ["act activate 555 module high1", "done in N s"],
    ["act warpTo 2", "the ship never entered warp"], ["act deactivate module med2", "done in N s"],
    ["act undock", "done in N s"], ["act stop", "finished"]]);

  // REPL-style eval: statements answer their last expression; blue and uthread are there.
  assert.deepEqual([byID[33].value.json, byID[34].value.json], [10, [true, true]]);
  // act waits until it is done and says where the client is then.
  assert.deepEqual([byID[23].value.done.reached, byID[26].value.done.reached], [true, true]);
  assert.deepEqual([byID[24].value.done.reached, byID[24].value.done.why], [false, "the ship never entered warp"],
    "a warp the ship never starts gives up once it sits still, not at the 120 s budget");
  const undock = byID[35].value;
  assert.ok(undocked[0] >= 3000, `undock waited out the session-change timer before it started (${undocked[0]} ms)`);
  assert.deepEqual([undock.done.reached, undock.done.heldMs >= 3000, undock.state.inSpace, undock.state.docked,
    undock.state.ego.mode], [true, true, true, null, "STOP"]);
  assert.deepEqual([byID[36].value.done, byID[36].value.finished], [undefined, true], "wait 0 answers once it has started");
  assert.deepEqual(Object.keys(byID[1].value.where).sort(), ["changeMs", "charID", "docked", "ego", "inSpace", "solarSystemID"]);

  assert.deepEqual([byID[37].value.sent, byID[37].value.pending, flushed], [1, 0, [1, 1]],
    "flush sent the late exception before it answered; the waiting batch had nothing left");
  assert.deepEqual([recorded.at(-1).type, recorded.at(-1).extra], ["ZeroDivisionError", "late"]);
});

// The client's own interpreter is Python 2.7. GRIDCHECK_PYTHON27 names one (a portable 2.7 does);
// else the py launcher's 2.7, python2.7 or python2 on PATH.
const PYTHON27 = [process.env.GRIDCHECK_PYTHON27 && [process.env.GRIDCHECK_PYTHON27], ["py", "-2.7"], ["python2.7"], ["python2"]]
  .filter(Boolean)
  .find(([exe, ...pre]) => spawnSync(exe, [...pre, "-c", "import sys; assert sys.version_info[:2] == (2, 7)"]).status === 0);

test("the client's Python 2.7 compiles the wrapped login expression, the bootstrap it carries and the agent",
  { skip: !PYTHON27 && "no Python 2.7: set GRIDCHECK_PYTHON27 to a python.exe" }, () => {
    const agent = createClientAgent({ log: quiet, patched: () => true, mintToken: () => "tok" });
    agent.mint({ username: "e2eclient" });
    agent.resolveLogin(ssoLogin("tok"), { accountStore, dictGet, strVal });
    const wrapped = agent.wrapLoginExpression("eval(compile(\"x = 1\", \"<tidi>\", \"exec\"))", CLIENT_ID);
    const encoded = /b64decode\('([A-Za-z0-9+/=]+)'\)/.exec(wrapped)[1];
    const check = path.join(os.tmpdir(), `gridcheck-py27-check-${process.pid}.py`);
    fs.writeFileSync(check, [
      "import base64, sys",
      "compile(sys.argv[1], '<signedFunc>', 'eval')",
      "compile(base64.b64decode(sys.argv[2]), '<gridcheck-client>', 'exec')",
      "compile(open(sys.argv[3], 'rb').read(), '<gridcheck-client-agent>', 'exec')",
      "print('compiled')",
    ].join("\n"));
    const [exe, ...pre] = PYTHON27;
    const run = spawnSync(exe, [...pre, check, wrapped, encoded, path.join(__dirname, "..", "bridge", "client", "agent.py")],
      { encoding: "utf8" });
    fs.rmSync(check, { force: true });
    assert.equal(run.status, 0, run.stderr || String(run.error));
    assert.equal(run.stdout.trim(), "compiled");
  });

// Activity SP (an LU mod) wraps buildTidiSignedFunc from outside: its loader appends this to
// handshake.js as Node compiles it, and its compose wraps the marshaled expression again.
// Copied from activity-sp lib/loginDelivery.js (extendHandshakeSource, createDelivery's compose).
const ACTIVITY_SP_KEY = Symbol.for("evejs.activity-sp.loader.v1");
const ACTIVITY_SP_SOURCE = `
// Activity SP login delivery v1
const __activitySpPreviousBuildTidiSignedFunc = buildTidiSignedFunc;
buildTidiSignedFunc = function() {
  const original = __activitySpPreviousBuildTidiSignedFunc.apply(this, arguments);
  try {
    const state = globalThis[Symbol.for("evejs.activity-sp.loader.v1")];
    return state && state.delivery ? state.delivery.compose(original) : original;
  } catch (error) {
    console.error("[Activity SP] Client delivery failed; the normal login handshake was preserved.");
    return original;
  }
};
`;
function activitySpCompose(original) {
  if (!Buffer.isBuffer(original) || original.length < 5 || original[0] !== 0x74 || original.readUInt32LE(1) !== original.length - 5) {
    throw new Error("Unsupported login expression envelope");
  }
  const encoded = Buffer.from("_asp_context['asp_ran'] = True", "utf8").toString("base64");
  const expression = `eval(compile(__import__('base64').b64decode('${encoded}'), '<activity-sp-login>', 'exec'), ` +
    "{'__builtins__': __builtins__, '_asp_context': globals()})";
  const data = Buffer.from(`(lambda _asp_result: (${expression}, _asp_result)[1])(${original.subarray(5).toString("ascii")})`, "ascii");
  const header = Buffer.alloc(5);
  header[0] = 0x74;
  header.writeUInt32LE(data.length, 1);
  return Buffer.concat([header, data]);
}

// The parts of stock's handshake.js the patch and Activity SP anchor on.
const HANDSHAKE_FIXTURE = `"use strict";
function buildMarshaledString(str) {
  const buf = Buffer.alloc(1 + 4 + str.length);
  buf[0] = 0x74;
  buf.writeInt32LE(str.length, 1);
  buf.write(str, 5, "ascii");
  return buf;
}
function buildTidiSignedFunc(clientId) {
  const pyCode = "stock_ran = True\\\\nstock_client = " + clientId;
  const expr = 'eval(compile("' + pyCode + '", "<tidi>", "exec"))';
  return buildMarshaledString(expr);
}
function authenticate(decoded, accountStore, dictGet, strVal) {
  const loginData = decoded[1];
  return loginData;
}
function signedFunc() {
  return [buildTidiSignedFunc(this.clientId), false];
}
module.exports = { authenticate, signedFunc };
`;

test("with Activity SP's wrap around the patched handshake, the stock expression, Activity SP and the bootstrap all run, in either nesting",
  { skip: !PYTHON && !PYTHON27 && "no Python" }, () => {
    const Module = require("node:module");
    const { loadPatches, planApply } = require("../core/patches");
    const patch = loadPatches().find((entry) => entry.id === "client-agent");
    const read = (file) => (file === "network/tcp/handshake.js" ? HANDSHAKE_FIXTURE : null);
    const plan = planApply(patch, read);
    assert.ok(plan.ok, plan.problems.join("; "));
    // Activity SP's loader checks its anchors on the patched text, then appends its wrap.
    const patched = plan.files[0].after;
    for (const anchor of ["function buildTidiSignedFunc(", "[buildTidiSignedFunc(this.clientId), false]"]) {
      assert.equal(patched.split(anchor).length, 2, `Activity SP's anchor ${anchor} is still there once`);
    }
    const file = path.join(os.tmpdir(), "gridcheck-handshake-fixture.js");
    const handshake = new Module(file);
    handshake.filename = file;
    handshake._compile(patched + ACTIVITY_SP_SOURCE, file);

    const { HOOK_KEY } = require("../bridge/client");
    const agent = createClientAgent({ log: quiet, patched: () => true, testTree: () => true, mintToken: () => "tok" });
    const login = () => {
      agent.mint({ username: "e2eclient" });
      handshake.exports.authenticate([null, ssoLogin("tok")], accountStore, dictGet, strVal);
    };
    globalThis[HOOK_KEY] = { resolveLogin: agent.resolveLogin, wrapLoginExpression: agent.wrapLoginExpression };
    globalThis[ACTIVITY_SP_KEY] = { delivery: { compose: activitySpCompose } };
    let expressions;
    try {
      // As installed: gridcheck's wrap inside the function, Activity SP's around its result.
      login();
      const outer = handshake.exports.signedFunc.call({ clientId: CLIENT_ID })[0];
      // The other nesting: gridcheck's wrap around an expression Activity SP already wrapped.
      delete globalThis[HOOK_KEY];
      const aspOnly = handshake.exports.signedFunc.call({ clientId: CLIENT_ID })[0];
      agent.mint({ username: "e2eclient" });
      agent.resolveLogin(ssoLogin("tok"), { accountStore, dictGet, strVal });
      const inner = agent.wrapLoginExpression(aspOnly.subarray(5).toString("ascii"), CLIENT_ID);
      expressions = [outer.subarray(5).toString("ascii"), inner];
      assert.equal(outer.readUInt32LE(1), outer.length - 5, "the envelope's length is right");
    } finally {
      delete globalThis[HOOK_KEY];
      delete globalThis[ACTIVITY_SP_KEY];
    }
    assert.ok(expressions[0].startsWith("(lambda _asp_result:") && expressions[0].includes("_gc_result"));
    assert.ok(expressions[1].startsWith("(lambda _gc_result:") && expressions[1].includes("_asp_result"));

    const input = path.join(os.tmpdir(), `gridcheck-coexist-${process.pid}.json`);
    const script = path.join(os.tmpdir(), `gridcheck-coexist-${process.pid}.py`);
    fs.writeFileSync(input, JSON.stringify(expressions));
    fs.writeFileSync(script, [
      "import json, sys, types",
      "blue = types.ModuleType('blue')",
      "uthread = types.ModuleType('uthread')",
      "started = []",
      "uthread.new = lambda fn, *args: started.append(fn.__name__)",
      "sys.modules.update(blue=blue, uthread=uthread)",
      "rows = []",
      "for expr in json.load(open(sys.argv[1])):",
      "    del started[:]",
      "    g = {'__builtins__': __builtins__}",
      "    result = eval(str(expr), g)",
      "    rows.append([result, g.get('stock_ran'), g.get('stock_client'), g.get('asp_ran'), list(started)])",
      "print(json.dumps(rows))",
    ].join("\n"));
    try {
      for (const python of [PYTHON && [PYTHON], PYTHON27].filter(Boolean)) {
        const [exe, ...pre] = python;
        const run = spawnSync(exe, [...pre, script, input], { encoding: "utf8" });
        assert.equal(run.status, 0, run.stderr || String(run.error));
        const rows = JSON.parse(run.stdout.trim().split(/\r?\n/).pop());
        for (const row of rows) {
          assert.deepEqual(row, [null, true, CLIENT_ID, true, ["_gc_attach"]],
            `${exe}: stock's result kept and its code run, Activity SP's payload run, the bootstrap's attach started`);
        }
      }
    } finally {
      fs.rmSync(input, { force: true });
      fs.rmSync(script, { force: true });
    }
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

test("a clientDiff's line: the diff's counts and IDs; ok only with both sides in space in one system", () => {
  const { ballparkEvent } = require("../core/client");
  const grid = { solarSystemID: 30002537, inSpace: true, entities: [{ itemID: 1, name: "self" }, { itemID: 4, typeName: "Wreck" }] };
  const client = { inSpace: true, solarSystemID: 30002537, balls: [{ itemID: 1 }, { itemID: 99, name: "ghost", categoryID: 6 }] };
  const event = ballparkEvent(diffBallpark(client, grid), { username: "e2eclient", characterID: 7, grid, atMs: 5, waitedMs: 2000 });
  assert.deepEqual(event, { kind: "CLIENT_BALLPARK", atMs: 5, username: "e2eclient", characterID: 7, ok: false, inSpace: true,
    serverInSpace: true, sameSystem: true, systemID: 30002537, server: 2, client: 2, shared: 1, missing: 1, extra: 1, moved: 0, modes: 0,
    missingIDs: [4], extraIDs: [99], movedIDs: [], waitedMs: 2000 });
  const docked = { inSpace: false, solarSystemID: 30002537, balls: [] };
  const both = ballparkEvent(diffBallpark(docked, { ...grid, inSpace: false, entities: [] }), { username: "e2eclient" });
  assert.equal(both.ok, false, "two empty lists agree, but docked isn't a ballpark");
  for (const key of Object.keys(event).filter((name) => name !== "kind")) {
    assert.ok(resolveField("CLIENT_BALLPARK", key), `CLIENT_BALLPARK names ${key}`);
  }
  assert.ok(parseCondition("CLIENT_BALLPARK missingIDs=4 extra>=1").test(event));
  assert.match(formatTimelineEvent({ ...event, t: 1000 }), /CLIENT_BALLPARK e2eclient: disagrees with the server's grid \(server 2, client 2, shared 1\) +1 missing, 1 extra$/);
});

test("the ballpark sampler: an arrival held with its lag, a ball the client never gets missing once, a ghost extra once", () => {
  const { createBallparkSampler } = require("../core/client");
  const sampler = createBallparkSampler({ lateMs: 10_000 });
  const who = { username: "e2eclient", characterID: 7 };
  const row = (itemID, extra = {}) => ({ itemID, typeID: 600, typeName: "Rifter", distanceMeters: 1234.4, ...extra });
  const sample = (atMs, server, client, { system = 1, inSpace = true } = {}) => sampler.step({ atMs, ...who,
    grid: { solarSystemID: system, inSpace, entities: server.map((id) => row(id)) },
    park: { solarSystemID: system, inSpace, balls: client.map((id) => (typeof id === "object" ? id : { itemID: id })) } });
  const brief = (events) => events.map((event) => [event.status, event.itemID, event.lagMs === undefined ? event.sinceMs : event.lagMs]);

  assert.deepEqual(sample(0, [1, 2, 3], [1, 2]), [], "the first sample is the baseline; 3 may still be loading");
  assert.deepEqual(brief(sample(2000, [1, 2, 3, 4], [1, 2, 3, 4])), [["held", 4, 0]], "3 loaded in time: no news; 4 arrived and was held at once");
  assert.deepEqual(brief(sample(4000, [1, 2, 3, 4, 5], [1, 2, 3, 4])), [], "5 is new and not held yet");
  assert.deepEqual(brief(sample(8000, [1, 2, 3, 4, 5], [1, 2, 3, 4, 5])), [["held", 5, 4000]]);
  assert.deepEqual(brief(sample(10_000, [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, { itemID: 99, categoryID: 6 }, { itemID: 60000001, categoryID: 3 }])), [],
    "a station only the client holds never counts");
  assert.deepEqual(brief(sample(20_000, [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, { itemID: 99, categoryID: 6 }])), [["missing", 6, 10_000], ["extra", 99, 10_000]]);
  assert.deepEqual(sample(30_000, [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, { itemID: 99, categoryID: 6 }]), [], "each said once");
  assert.deepEqual(brief(sample(32_000, [1, 2, 3, 4, 5, 6], [1, 2, 3, 4, 5, 6])), [["held", 6, 22_000]], "a missing ball that comes late is held, with its lag");

  const [line] = sample(33_000, [1, 2, 3, 4, 5, 6, 7], [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(line, { kind: "CLIENT_BALL", source: "ballpark", atMs: 33_000, username: "e2eclient", characterID: 7, status: "held",
    itemID: 7, label: "Rifter", typeID: 600, typeName: "Rifter", distanceMeters: 1234, lagMs: 0 });
  for (const key of Object.keys(line).filter((name) => name !== "kind")) assert.ok(resolveField("CLIENT_BALL", key), `CLIENT_BALL names ${key}`);
  assert.ok(parseCondition("CLIENT_BALL status=held lagMs<=5s itemID=7").test(line));
  assert.match(formatTimelineEvent({ ...line, t: 33_000 }), /CLIENT_BALL +e2eclient: Rifter held after 0s$/);

  const grid = [1, 2, 3, 4, 5, 6, 7];
  const warped = [21, 22, 23, 24, 25, 26, 27, 1];
  assert.deepEqual(sample(40_000, warped, [1, 21, 22]), [], "most of the grid is new: a new grid's baseline, not seven arrivals");
  assert.deepEqual(sample(42_000, warped, warped), [], "and its balls loading in time are no news");
  assert.deepEqual(sample(44_000, grid, [], { inSpace: false }), [], "docked");
  assert.deepEqual(sample(46_000, grid, [1]), [], "undocked again: a new baseline");
  assert.deepEqual(brief(sample(56_000, grid, [1])), grid.slice(1).map((id) => ["missing", id, 10_000]));
});

test("a scenario's node names the agent's arguments; a screenshot taken without blocking parses the script's answer", async () => {
  const { captureScreenshot, nodeArgs } = require("../core/client");
  assert.deepEqual(nodeArgs({ class: "Button", name: "undockButton", hidden: undefined }), { cls: "Button", name: "undockButton" });
  assert.deepEqual(nodeArgs({ path: "/a/b", index: 0 }), { path: "/a/b", index: 0 });
  if (process.platform !== "win32") return;
  const { EventEmitter } = require("node:events");
  const out = path.join(os.tmpdir(), `gridcheck-shot-test-${process.pid}`, "x.jpg");
  let script = null;
  const fake = (reply, expected = ["-TargetPid", "42", "-Out", out, "-MaxWidth", "1600", "-Format", "jpg"]) => (exe, args) => {
    script = args[args.indexOf("-File") + 1];
    assert.ok(fs.existsSync(script), "the script is written before PowerShell starts");
    assert.deepEqual(args.slice(args.indexOf("-TargetPid")), expected);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit("data", reply);
      child.emit("close", 0);
    });
    return child;
  };
  assert.deepEqual(await captureScreenshot({ pid: 42, out, maxWidth: 1600, format: "jpg", spawnImpl: fake("OK 1600 900 EVE - Client Observer\r\n") }),
    { file: out, width: 1600, height: 900, title: "EVE - Client Observer" });
  assert.equal(fs.existsSync(script), false, "and removed after");
  assert.deepEqual(await captureScreenshot({ pid: 42, out, maxWidth: 1600, format: "jpg", spawnImpl: fake("ERROR the client window is minimized\r\n") }),
    { error: "the client window is minimized" });
  // A picture the client saved itself is scaled and converted by the same script, from its file.
  const from = path.join(os.tmpdir(), "raw.png");
  const converting = fake("OK 1600 757 \r\n", ["-TargetPid", "0", "-Out", out, "-MaxWidth", "1600", "-Format", "jpg", "-FromFile", from]);
  assert.deepEqual(await captureScreenshot({ from, out, maxWidth: 1600, format: "jpg", spawnImpl: converting }),
    { file: out, width: 1600, height: 757, title: null });
  fs.rmSync(path.dirname(out), { recursive: true, force: true });
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
  assert.deepEqual(cliArgs("client_screenshot", { source: "window" }),
    ["client", "--max-width=1600", "--format=jpg", "--source=window", "--json", "--", "screenshot"]);
  assert.deepEqual(cliArgs("client_click", { text: "Undock", double: true, wait: 5 }),
    ["client", "--text=Undock", "--double", "--wait=5", "--", "click"]);
  assert.deepEqual(cliArgs("client_type", { text: "--hi", name: "chatEdit", enter: true }),
    ["client", "--name=chatEdit", "--enter", "--", "type", "--hi"], "the typed text goes after --; text isn't a filter here");
  assert.deepEqual(cliArgs("client_type", { text: "x", intoText: "Search" }), ["client", "--text=Search", "--", "type", "x"]);
  assert.deepEqual(cliArgs("client_key", { key: "escape" }), ["client", "--", "key", "escape"]);
  assert.deepEqual(cliArgs("client_cmd", { filter: "inv" }), ["client", "--filter=inv", "--", "cmd"]);
  assert.deepEqual(cliArgs("client_cmd", { name: "OpenInventory" }), ["client", "--", "cmd", "OpenInventory"]);
  assert.deepEqual(cliArgs("client_act", { action: "warpTo", target: 40491241, range: 0, user: "e2eclient2" }),
    ["client", "--user=e2eclient2", "--range=0", "--", "act", "warpTo", "40491241"]);
  assert.deepEqual(cliArgs("client_act", { action: "activate", module: "high1" }), ["client", "--module=high1", "--", "act", "activate"]);
});

test("key names: a single key; combinations are refused, as the client reads modifiers from the keyboard", () => {
  const { parseKey } = require("../core/client");
  assert.deepEqual([parseKey("Enter"), parseKey("a"), parseKey("f3"), parseKey("7")], [{ key: 13 }, { key: 65 }, { key: 0x72 }, { key: 55 }]);
  assert.match(parseKey("ctrl+a").error, /can't be sent from inside/);
  assert.match(parseKey("hyper").error, /isn't a key gridcheck knows/);
  assert.match(parseKey("").error, /a key is a name/);
});

test("a node path Git Bash turned into a Windows path is the desktop path again; a bare Desktop/ path gets its slash", () => {
  const { repairNodePath } = require("../core/client");
  assert.deepEqual([repairNodePath("C:/Program Files/Git/Desktop/l_main/lobbyWnd"), repairNodePath("Desktop/l_main"),
    repairNodePath("/Desktop/l_main"), repairNodePath(undefined)], ["/Desktop/l_main/lobbyWnd", "/Desktop/l_main", "/Desktop/l_main", undefined]);
});

test("a client error keeps the client's and the eval's frames and drops the agent's own", () => {
  const { clientErrorText } = require("../core/client");
  const agentFrame = (line) => `  File "<gridcheck-client-agent>", line ${line}, in run`;
  assert.equal(clientErrorText(`Traceback (most recent call last):\n${agentFrame(547)}\n${agentFrame(974)}\nValueError: the ship HUD is not open\n`),
    "ValueError: the ship HUD is not open");
  assert.equal(clientErrorText(`Traceback (most recent call last):\n${agentFrame(547)}\n  File "<gridcheck-eval>", line 1, in <module>\nZeroDivisionError: x`),
    "Traceback (most recent call last):\n  File \"<gridcheck-eval>\", line 1, in <module>\nZeroDivisionError: x");
  assert.equal(clientErrorText("Traceback (most recent call last):\n" + agentFrame(547) + "\nRuntimeError: act dock failed in the client: UserError\n" +
    "Traceback (most recent call last):\n  File \"menusvc.py\", line 9, in Dock\nUserError: PerformSessionChangeInProgress"),
  "RuntimeError: act dock failed in the client: UserError\nTraceback (most recent call last):\n  File \"menusvc.py\", line 9, in Dock\n" +
    "UserError: PerformSessionChangeInProgress");
});

test("an act's answer reads as done or not, where the client is, and what it logged meanwhile", () => {
  const { actSummary } = require("../core/client");
  assert.deepEqual(actSummary({ finished: true, done: { reached: true, ms: 6900, heldMs: 10500 },
    state: { docked: null, inSpace: true, solarSystemID: 30100035, changeMs: 8100, ego: { mode: "GOTO", speed: 338.6, followID: null } },
    events: [{ kind: "notify", event: "OnSessionChanged" }, { kind: "exception", type: "gaierror", message: "getaddrinfo failed" },
      { kind: "exception", type: "gaierror", message: "getaddrinfo failed" }] }), [
    "  done in 6.9 s (after 10.5 s for the client's session-change timer)",
    "  now in space in 30100035, GOTO 339 m/s; next session change in 9 s",
    "  meanwhile: OnSessionChanged; gaierror: getaddrinfo failed (x2)"]);
  assert.deepEqual(actSummary({ finished: true, done: { reached: false, ms: 5000, heldMs: 0, why: "the ship never entered warp" } }),
    ["  not done: the ship never entered warp"]);
  assert.deepEqual(actSummary({ finished: false, modal: { name: "modal", text: "Are you sure?" } }), ["  waiting on a dialog: modal \"Are you sure?\""]);
});
