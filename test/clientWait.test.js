"use strict";

// The CLI's half of client wait, menu, rpc and the screenshot scale, the
// messages the agent records as timeline lines, and the unique node paths
// check-ui matches. The agent's half is test/clientAgentPy.test.js.

const test = require("node:test");
const assert = require("node:assert");

const { needsPlugin } = require("./tree");
const { createClientAgent } = require("../bridge/client");
const { waitForClient } = require("../core/clientWait");
const { evalTruth, scaleText, uiScale, actSummary } = require("../core/client");
const { checkUi, pathMatches } = require("../core/clientUi");
const { EVENT_FIELDS, parseCondition } = require("../core/conditions");
const { formatTimelineEvent } = require("../core/timeline");

const LU = needsPlugin("lu");

function poller(answers, { step = 500 } = {}) {
  let clock = 0;
  let index = 0;
  const calls = [];
  return {
    calls,
    options: {
      now: () => clock,
      sleep: async (ms) => { clock += ms; },
      evaluate: async () => {
        calls.push(clock);
        const answer = answers[Math.min(index++, answers.length - 1)];
        clock += step / 5;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    },
  };
}

test("wait polls until the value is true, and says how long it took", async () => {
  const { options, calls } = poller([{ repr: "False", truth: false }, { repr: "False", truth: false }, { repr: "'ready'", truth: true }]);
  const result = await waitForClient({ ...options, seconds: 10, everySeconds: 0.5 });
  assert.equal(result.ok, true);
  assert.equal(result.last.repr, "'ready'");
  assert.equal(result.tries, 3);
  assert.deepEqual(calls, [0, 600, 1200], "one try, then every half second (plus the try's own time)");
  assert.equal(result.elapsedMs, 1300);
});

test("wait gives up at the timeout with the last value, and an error counts as not yet", async () => {
  const { options } = poller([new Error("client eval: the client didn't answer"), { repr: "[]", truth: false, error: null }]);
  const result = await waitForClient({ ...options, seconds: 2, everySeconds: 0.5 });
  assert.equal(result.ok, false);
  assert.equal(result.last.repr, "[]");
  assert.ok(result.tries >= 3);
  assert.ok(result.elapsedMs <= 2000 + 500);

  const failing = poller([new Error("client eval: the client didn't answer")]);
  const never = await waitForClient({ ...failing.options, seconds: 1, everySeconds: 0.5 });
  assert.deepEqual([never.ok, never.last, never.error], [false, null, "client eval: the client didn't answer"]);

  const soft = poller([{ repr: null, truth: false, error: "NameError: name 'x' is not defined" }]);
  const named = await waitForClient({ ...soft.options, seconds: 1, everySeconds: 0.5 });
  assert.equal(named.error, "NameError: name 'x' is not defined", "an error the code raised comes back with the last value");
});

test("wait stops at once for a client that isn't there or code that can't parse", async () => {
  for (const message of ["client eval: no client agent is online", "client eval: 2 client agents are online; name one with --user",
    "client eval: SyntaxError: invalid syntax"]) {
    const { options, calls } = poller([new Error(message)]);
    await assert.rejects(waitForClient({ ...options, seconds: 30, everySeconds: 0.5 }), (error) => error.message === message);
    assert.equal(calls.length, 1);
  }
  await assert.rejects(waitForClient({ ...poller([]).options, seconds: -1 }), /--timeout takes seconds/);
  await assert.rejects(waitForClient({ ...poller([]).options, everySeconds: 0 }), /--every takes seconds/);
});

test("truth is the agent's own answer; an older agent's is guessed from the value's JSON", () => {
  assert.equal(evalTruth({ truth: true, json: 0 }), true);
  assert.equal(evalTruth({ truth: false, json: 1 }), false);
  for (const [value, expected] of [[{ json: [] }, false], [{ json: [0] }, true], [{ json: {} }, false], [{ json: { a: 1 } }, true],
    [{ json: 0 }, false], [{ json: "" }, false], [{ json: "x" }, true], [{ json: false }, false], [{ json: true }, true],
    [{ json: null, repr: "None" }, false], [{ json: null, repr: "<Window object>" }, true]]) {
    assert.equal(Boolean(evalTruth(value)), expected, JSON.stringify(value));
  }
});

test("a screenshot says how pointer coordinates relate to its pixels, scaled or not", () => {
  assert.deepEqual(uiScale({ width: 1600, uiWidth: 1920, uiHeight: 1080 }), { uiWidth: 1920, uiHeight: 1080, uiPerPixel: 1.2 });
  assert.deepEqual(uiScale({ width: 2304, uiWidth: 1920, uiHeight: 1080 }), { uiWidth: 1920, uiHeight: 1080, uiPerPixel: 0.8333 });
  assert.equal(uiScale({ width: 1600 }), null, "an agent that doesn't say the UI size");
  assert.equal(scaleText({ width: 1600, height: 900, ...uiScale({ width: 1600, uiWidth: 1920 }) }), "1600x900; pointer coordinates are pixels x 1.2");
  assert.match(scaleText({ width: 1600, height: 900 }), /^1600x900; pointer coordinates are in UI pixels/);
});

test("a path without [n] matches each sibling with the label; one with it names one node", () => {
  const here = "/Desktop/l_main/Container/Button[3]";
  assert.equal(pathMatches(here, here), true);
  assert.equal(pathMatches("/Desktop/l_main/Container/Button", here), true);
  assert.equal(pathMatches("/Desktop/l_main/Container/Button[2]", here), false);
  assert.equal(pathMatches("/Desktop/l_main/Container/Button", "/Desktop/l_main/Container/Button"), true);
  assert.equal(pathMatches("/Desktop/l_main/Button", here), false, "the same depth");
  assert.equal(pathMatches("/Desktop/l_main/Container[0]/Button[3]", here), false, "a suffix the node lacks is not ignored");

  const node = (path, text) => ({ uid: path, path, text, effectiveDisplay: true, rect: [0, 0, 1, 1] });
  const snapshot = { schema: 1, truncated: false, nodes: [node("/Desktop/Row/Button[0]", "1d"), node("/Desktop/Row/Button[1]", "Hauler"),
    node("/Desktop/Row/Other", "x")] };
  assert.equal(checkUi(snapshot, { selector: { path: "/Desktop/Row/Button[1]" } }).ok, true);
  assert.equal(checkUi(snapshot, { selector: { path: "/Desktop/Row/Button" }, count: 2 }).ok, true, "an old path matches both");
  assert.equal(checkUi(snapshot, { selector: { path: "/Desktop/Row/Button", text: "haul" } }).ok, true, "path and text together");
});

test("a message the agent recorded is a CLIENT_EVENT line a condition can match", () => {
  const FakeBase = class { constructor(name) { this.name = name; } };
  const quiet = { info() {}, warn() {}, debug() {} };
  const agent = createClientAgent({ log: quiet, patched: () => true, testTree: () => true, read: () => "", mintToken: () => "tok" });
  const service = agent.createService(FakeBase);
  agent.mint({ username: "e2eclient" });
  agent.resolveLogin({ type: "dict", entries: [["user_name", "EVE-SSO-CONNECTION"], ["user_sso_token", Buffer.from("tok")]] }, {
    accountStore: { readAccountsTable: () => ({ e2eclient: { id: 7, passwordhash: "" } }) },
    dictGet: (dict, key) => (dict.entries.find(([name]) => String(name) === key) || [])[1],
    strVal: (value) => String(value),
  });
  const session = { userid: 7, characterID: 9, socket: { destroyed: false }, sendNotification() {} };
  service.Handle_Attach(["tok"], session);
  const seen = [];
  agent.subscribe((event) => seen.push(event));
  service.Handle_Events(["tok", JSON.stringify({ events: [
    { seq: 1, atMs: 100, kind: "message", key: "CustomNotify", text: "That system has no asteroid belt", type: "notify" },
    { seq: 2, atMs: 200, kind: "message", key: null, text: "Mined 5 units", type: "mining" },
  ] })], session);
  assert.deepEqual(seen.map((event) => [event.kind, event.event, event.key, event.text, event.messageType]), [
    ["CLIENT_EVENT", "message", "CustomNotify", "That system has no asteroid belt", "notify"],
    ["CLIENT_EVENT", "message", null, "Mined 5 units", "mining"]]);
  for (const event of seen) {
    for (const key of Object.keys(event).filter((name) => !["seq", "atMs", "kind"].includes(name))) {
      assert.ok(key in EVENT_FIELDS.CLIENT_EVENT, `CLIENT_EVENT.${key} is a field conditions know`);
    }
  }
  assert.equal(parseCondition("CLIENT_EVENT event=message text~asteroid").test(seen[0]), true);
  assert.equal(parseCondition("CLIENT_EVENT event=message text~asteroid").test(seen[1]), false);
  assert.equal(parseCondition("CLIENT_EVENT key=CustomNotify").test(seen[0]), true);
  assert.match(formatTimelineEvent({ t: 0, ...seen[0] }, null), /e2eclient: message CustomNotify: That system has no asteroid belt/);
  assert.match(formatTimelineEvent({ t: 0, ...seen[1] }, null), /e2eclient: message: Mined 5 units/);
});

test("an act's or click's answer carries the messages the client showed", () => {
  const lines = actSummary({ done: { reached: true, ms: 1000 }, events: [{ kind: "message", text: "You cannot warp there right now" },
    { kind: "message", text: "You cannot warp there right now" }] });
  assert.ok(lines.some((line) => /meanwhile: message: You cannot warp there right now \(x2\)/.test(line)), lines.join("\n"));
});

test("the MCP tools client_menu, client_wait and client_rpc map onto gridcheck client", () => {
  const { cliArgs, TOOLS } = require("../bin/mcp");
  assert.deepEqual(cliArgs("client_menu", { text: "Roster", entries: ["Expel Member", "Confirm Expel Member"], wait: 5 }),
    ["client", "--text=Roster", "--wait=5", "--", "menu", "Expel Member", "Confirm Expel Member"]);
  assert.deepEqual(cliArgs("client_menu", { itemID: 40001, entries: ["Warp to"], user: "u" }), ["client", "--user=u", "--item=40001", "--", "menu", "Warp to"]);
  assert.throws(() => cliArgs("client_menu", { text: "x", itemID: 1, entries: ["a"] }), /node .* or itemID, not both/);
  assert.throws(() => cliArgs("client_menu", { text: "x", entries: [] }), /needs entries/);
  assert.deepEqual(cliArgs("client_wait", { code: "session.stationid", timeout: 30, every: 1 }),
    ["client", "--timeout=30", "--every=1", "--", "wait", "session.stationid"]);
  assert.deepEqual(cliArgs("client_rpc", { service: "svc", method: "Do", payload: { a: 1 } }),
    ["client", '--payload={"a":1}', "--", "rpc", "svc", "Do"]);
  assert.deepEqual(cliArgs("client_rpc", { service: "svc", method: "Do", args: [1, "two"], user: "u" }),
    ["client", "--user=u", '--args=[1,"two"]', "--", "rpc", "svc", "Do"]);
  assert.throws(() => cliArgs("client_rpc", { service: "svc", method: "Do", payload: {}, args: [] }), /payload or args, not both/);
  const names = TOOLS.map((tool) => tool.name);
  const act = names.indexOf("client_act");
  assert.deepEqual(names.slice(act + 1, act + 4), ["client_menu", "client_wait", "client_rpc"], "right after client_act");
  for (const name of ["client_menu", "client_wait", "client_rpc"]) {
    const tool = TOOLS.find((entry) => entry.name === name);
    assert.ok(tool.inputSchema.required.length >= 1);
  }
});

test("lu_rpc is a plugin tool for `gridcheck lu-rpc`, and the plugin's primer says so", LU, () => {
  const { cliArgs } = require("../bin/mcp");
  const { defaultRegistry } = require("../core/plugins");
  assert.deepEqual(cliArgs("lu_rpc", { method: "Status" }), ["lu-rpc", "--", "Status"]);
  assert.deepEqual(cliArgs("lu_rpc", { method: "Draft", payload: { system: "Amamake" }, user: "u", json: true }),
    ["lu-rpc", '--payload={"system":"Amamake"}', "--user=u", "--json", "--", "Draft"]);
  const registry = defaultRegistry();
  assert.ok(registry.commands["lu-rpc"], "the command is registered");
  assert.match(registry.primers.find((entry) => entry.plugin === "lu").text, /lu_rpc \{ method, payload \}/);
});

test("lu-rpc passes the payload as one object to the client's rpc, defaulting to {}", LU, async () => {
  const { defaultRegistry } = require("../core/plugins");
  const command = defaultRegistry().commands["lu-rpc"];
  const calls = [];
  const printed = [];
  const io = {
    CliError: class extends Error {},
    print: (line) => printed.push(line),
    clientCommand: async (op, args, flags) => {
      calls.push([op, args, flags]);
      return { value: { json: { ok: true }, repr: "{}" } };
    },
  };
  await command.run(["Status"], {}, io);
  await command.run(["Draft"], { payload: '{"system":"Amamake"}', user: "u2" }, io);
  assert.deepEqual(calls, [
    ["rpc", { service: "luCommand", method: "Status", payload: {} }, {}],
    ["rpc", { service: "luCommand", method: "Draft", payload: { system: "Amamake" } }, { user: "u2" }]]);
  assert.equal(printed[0], JSON.stringify({ ok: true }, null, 2));
  await assert.rejects(command.run(["Draft"], { payload: "{nope" }, io), /--payload isn't JSON/);
  await assert.rejects(command.run([], {}, io), /usage: gridcheck lu-rpc/);
});
