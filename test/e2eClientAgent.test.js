"use strict";

// The client agent (bridge/client.js): a minted token logs its account in, only
// that login's signedFunc carries the bootstrap, and a command goes out as a
// notification and comes back through Reply. The last test runs the wrapped
// login expression, bootstrap.py and agent.py under Python 3 with stub client
// modules; it says nothing about the real client's Python 2.7.

const test = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");

const { createClientAgent, NOTIFY } = require("../bridge/client");

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

function fakeSession(userid) {
  const sent = [];
  return { userid, characterID: 0, socket: { destroyed: false }, sent, sendNotification: (...args) => sent.push(args) };
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

const PYTHON = ["python3", "python"].find((name) => spawnSync(name, ["-c", "import sys; assert sys.version_info >= (3,)"]).status === 0);

test("the wrapped login expression installs the agent, which answers ping and eval (Python 3, stub client)", { skip: !PYTHON && "no Python 3" }, () => {
  const agent = createClientAgent({ log: quiet, patched: () => true, mintToken: () => "tok" });
  agent.mint({ username: "e2eclient" });
  agent.resolveLogin(ssoLogin("tok"), { accountStore, dictGet, strVal });
  const wrapped = agent.wrapLoginExpression("41 + 1", CLIENT_ID);
  const agentSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "bridge", "client", "agent.py"), "utf8");
  const harness = `
import builtins, json, sys, types
blue = types.ModuleType('blue')
blue.pyos = types.SimpleNamespace(synchro=types.SimpleNamespace(SleepWallclock=lambda ms: None))
blue.os = types.SimpleNamespace(GetWallclockTime=lambda: 1234)
uthread = types.ModuleType('uthread')
uthread.new = lambda fn, *args: fn(*args)
sys.modules['blue'] = blue
sys.modules['uthread'] = uthread
replies = []
class Remote(object):
    def Attach(self, token):
        assert token == 'tok'
        return ${JSON.stringify(agentSource)}
    def Reply(self, token, text):
        replies.append(json.loads(text))
class SM(object):
    listeners = []
    def RemoteSvc(self, name):
        assert name == 'gridcheckClient'
        return Remote()
    def RegisterForNotifyEvent(self, owner, event):
        self.listeners.append(owner)
builtins.sm = SM()
builtins.session = types.SimpleNamespace(userid=7, charid=90000001, solarsystemid2=30002537)
result = eval(${JSON.stringify(wrapped)})
assert result == 42, result
assert getattr(builtins, '_gridcheck_client_agent_v1') is not None
owner = builtins.sm.listeners[0]
owner.OnGridcheckClient(json.dumps({'id': 1, 'op': 'ping', 'args': {}}))
owner.OnGridcheckClient(json.dumps({'id': 2, 'op': 'eval', 'args': {'code': 'session.charid'}}))
owner.OnGridcheckClient(json.dumps({'id': 3, 'op': 'eval', 'args': {'code': 'x = 2\\nresult = [x, session.solarsystemid2]'}}))
owner.OnGridcheckClient(json.dumps({'id': 4, 'op': 'eval', 'args': {'code': '1/0'}}))
owner.OnGridcheckClient(json.dumps({'id': 5, 'op': 'nope', 'args': {}}))
print(json.dumps(replies))
`;
  const run = spawnSync(PYTHON, ["-c", harness], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trim().split(/\r?\n/);
  assert.ok(lines.includes("GRIDCHECK_CLIENT:READY"), run.stdout);
  const replies = JSON.parse(lines[lines.length - 1]);
  assert.deepEqual(replies.map((reply) => [reply.id, reply.ok]), [[1, true], [2, true], [3, true], [4, false], [5, false]]);
  assert.equal(replies[0].value.session.charid, 90000001);
  assert.deepEqual(replies[1].value, { repr: "90000001", truncated: false, json: 90000001 });
  assert.deepEqual(replies[2].value.json, [2, 30002537]);
  assert.match(replies[3].error, /ZeroDivisionError/);
  assert.match(replies[4].error, /unknown op: nope/);
});
