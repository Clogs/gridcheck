"use strict";

// check-ui, eval --assert and the scenario steps that use them, against stub
// UI states and a stub client. agent.py's op_ui_state and its assert rewrite
// run under Python 3 with stubbed client modules.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { checkUi, waitForUi, validateCheck } = require("../core/clientUi");
const { validateScenario, describeStep } = require("../core/scenario");
const mcp = require("../bin/mcp");

const AGENT = path.join(__dirname, "..", "bridge", "client", "agent.py");
const PYTHON = ["python3", "python"].find((name) => spawnSync(name, ["-c", "import sys; assert sys.version_info >= (3,)"]).status === 0);

function state(nodes = []) {
  return { schema: 1, nodes, truncated: false, session: { charid: 123 }, desktop: { rect: [0, 0, 1000, 700] }, focus: null, modal: null };
}
const PANEL = { uid: "1", path: "/desktop/panel", name: "Compendium", cls: "Panel", text: "", rect: [0, 0, 1000, 700],
  effectiveDisplay: true, effectiveEnabled: true, fullscreen: true, scenePresent: true, opacity: 1 };

test("a check holds on count, shown, enabled, focus, modal, full screen, scene, size and opacity", () => {
  const both = state([PANEL]);
  both.focus = PANEL;
  both.modal = PANEL;
  assert.strictEqual(checkUi(both, { selector: { name: "Compendium", exact: true }, focused: true, modal: true, fullscreen: true,
    scene: true, withinDesktop: true, minWidth: 900, opacityMin: 1, opacityMax: 1 }).ok, true);
  assert.strictEqual(checkUi(state([PANEL]), { selector: { name: "compend" } }).ok, true, "contains, case-insensitive");
  assert.strictEqual(checkUi(state([PANEL]), { selector: { name: "compend", exact: true } }).ok, false);
  assert.strictEqual(checkUi(state([PANEL]), { selector: { name: "Compendium" }, focused: true }).ok, false);
  assert.strictEqual(checkUi(state([{ ...PANEL, effectiveEnabled: false }]), { selector: { name: "Compendium" }, enabled: true }).ok, false);
  assert.strictEqual(checkUi(state([{ ...PANEL, rect: [-1, 0, 1000, 700] }]), { selector: { name: "Compendium" }, withinDesktop: true }).ok, false);
  assert.strictEqual(checkUi(state([{ ...PANEL, rect: null }]), { selector: { name: "Compendium" }, withinDesktop: false }).ok, false,
    "unknown geometry fails either way");
  assert.strictEqual(checkUi(state([{ ...PANEL, scenePresent: null }]), { selector: { name: "Compendium" }, scene: false }).ok, false,
    "unknown isn't false");
  assert.strictEqual(checkUi(state([{ ...PANEL, opacity: 0.75 }]), { selector: { name: "Compendium" }, opacityMin: 1 }).ok, false);
});

test("count: two matches fail a one-node check; hidden nodes count only when asked; a cut-short state proves no absence", () => {
  assert.strictEqual(checkUi(state([PANEL, { ...PANEL, uid: "2" }]), { selector: { name: "Compendium" } }).ok, false);
  const hidden = state([{ ...PANEL, effectiveDisplay: false }]);
  assert.strictEqual(checkUi(hidden, { selector: { name: "Compendium" }, count: 0 }).ok, true, "closed but kept");
  assert.strictEqual(checkUi(hidden, { selector: { name: "Compendium" }, count: 0, visible: "any" }).ok, false, "not gone");
  assert.strictEqual(checkUi(hidden, { selector: { name: "Compendium" }, visible: false }).ok, true);
  const cut = checkUi({ ...state(), truncated: true }, { selector: { name: "Compendium" }, count: 0 });
  assert.strictEqual(cut.ok, false);
  assert.match(cut.failures[0], /cut short/);
});

test("a state the agent didn't write, or a check with a typo, is an error, not a verdict", () => {
  assert.throws(() => checkUi({ nodes: [] }, { selector: { name: "x" }, count: 0 }), /restart the client/);
  assert.throws(() => checkUi(state([{ name: "x" }]), { selector: { name: "x" } }), /restart the client/);
  for (const spec of [null, { selector: {} }, { selector: { name: "x", typo: true } }, { selector: { name: "x" }, count: -1 },
    { selector: { name: "x" }, visible: "all" }, { selector: { name: "x" }, minWidth: NaN }, { selector: { name: "x" }, colour: 1 },
    { selector: { name: "x" }, opacityMin: 0.8, opacityMax: 0.5 }]) {
    assert.throws(() => validateCheck(spec), undefined, JSON.stringify(spec));
  }
});

test("a wait holds out for stable on the same character and nodes, and a late read doesn't pass", async () => {
  let clock = 0;
  let reads = 0;
  const sleep = async (ms) => { clock += ms; };
  const held = await waitForUi({ spec: { selector: { name: "Compendium" } }, seconds: 2, stableMs: 500, now: () => clock, sleep,
    read: async () => {
      reads += 1;
      return { ...state([{ ...PANEL, uid: reads < 3 ? "old" : "new" }]), session: { charid: reads < 4 ? 123 : 456 } };
    } });
  assert.strictEqual(held.ok, true);
  assert.strictEqual(clock, 1250, "the node changed at 500 ms and the character at 750 ms; each starts the 500 ms again");

  clock = 0;
  const missing = await waitForUi({ spec: { selector: { name: "missing" } }, seconds: 1, now: () => clock, sleep, read: async () => state() });
  assert.strictEqual(missing.ok, false);
  assert.match(missing.failures.join(" "), /not within 1 s/);
  assert.strictEqual(clock, 1000);

  clock = 0;
  const late = await waitForUi({ spec: { selector: { name: "Compendium" } }, seconds: 1, now: () => clock, sleep,
    read: async () => { clock = 1500; return state([PANEL]); } });
  assert.strictEqual(late.ok, false);

  await assert.rejects(waitForUi({ spec: { selector: { name: "x" } }, seconds: 1, stableMs: 2000, read: async () => state() }), /within the wait/);
});

test("scenario steps: clientEval from a file with assert, clientCheckUi, clientKey, clientType and clientCmd", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridcheck-ui-"));
  try {
    fs.writeFileSync(path.join(dir, "probe.py"), "True\n");
    const source = path.join(dir, "ui.json");
    const scenario = validateScenario({ name: "ui", world: "fresh", setup: [
      { clientEval: { file: "probe.py" }, assert: true, timeout: 60 },
      { clientCheckUi: { selector: { name: "Panel", exact: true }, fullscreen: true }, timeout: 2, stable: 500 },
      { clientKey: "Tab", node: { name: "search" } },
      { clientType: "needle", node: { name: "search" }, set: true },
      { clientCmd: "OpenInventory", settle: 5 },
    ], until: { timeout: 2 }, expect: ["no CLIENT_EXCEPTION"] }, { source });
    const [evaluated, checked, key, typed, command] = scenario.setup.filter((step) => step.type.startsWith("client"));
    assert.deepStrictEqual([evaluated.code, evaluated.assert, evaluated.seconds], ["True\n", true, 60]);
    assert.deepStrictEqual([checked.seconds, checked.stable, checked.check.fullscreen], [2, 500, true]);
    assert.deepStrictEqual([key.key, key.keyName, key.node], [9, "tab", { name: "search" }]);
    assert.deepStrictEqual([typed.text, typed.set, typed.node], ["needle", true, { name: "search" }]);
    assert.deepStrictEqual([command.command, command.settleMs], ["OpenInventory", 5000]);
    assert.strictEqual(describeStep(checked), "clientCheckUi name~Panel (up to 2s)");
    assert.strictEqual(describeStep(key), "clientKey tab into name~search");

    const plain = validateScenario({ name: "ui", world: "fresh", setup: [{ clientEval: "session.charid" }], until: { timeout: 2 }, expect: ["GRID"] }, { source });
    assert.strictEqual(plain.setup.find((step) => step.type === "clientEval").seconds, undefined, "no timeout: nothing on the budget");

    for (const [step, problem] of [
      [{ clientEval: { file: "missing.py" } }, /no such file/],
      [{ clientEval: { file: "probe.py", code: "x" } }, /clientEval/],
      [{ clientEval: "True", assert: "yes" }, /assert/],
      [{ clientKey: "ctrl+a" }, /combination/],
      [{ clientCheckUi: { selector: { name: "Panel" } }, stable: 2000, timeout: 1 }, /stable/],
      [{ clientCheckUi: { selector: {} } }, /clientCheckUi/],
      [{ clientType: 5 }, /clientType/],
      [{ clientCmd: "" }, /clientCmd/],
    ]) {
      assert.throws(() => validateScenario({ name: "ui", world: "fresh", setup: [step], until: { timeout: 2 }, expect: ["GRID"] }, { source }), problem,
        JSON.stringify(step));
    }
    assert.throws(() => validateScenario({ name: "ui", world: "fresh", setup: [{ clientEval: { file: "probe.py" } }], until: { timeout: 2 }, expect: ["GRID"] }),
      /only a scenario file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the MCP tools pass a check as JSON and an eval as code or file, never both", () => {
  assert.deepStrictEqual(mcp.cliArgs("client_check_ui", { spec: { selector: { name: "Panel" }, count: 0 }, wait: 2, stable: 500, user: "ui" }),
    ["client", "--user=ui", '--spec={"selector":{"name":"Panel"},"count":0}', "--wait=2", "--stable=500", "--", "check-ui"]);
  assert.deepStrictEqual(mcp.cliArgs("client_eval", { file: "probe.py", assert: true, timeout: 45 }),
    ["client", "--timeout=45", "--file=probe.py", "--assert", "--", "eval"]);
  assert.deepStrictEqual(mcp.cliArgs("client_eval", { code: "1" }), ["client", "--", "eval", "1"]);
  assert.throws(() => mcp.cliArgs("client_eval", { code: "True", file: "probe.py" }), /one of them/);
  assert.throws(() => mcp.cliArgs("client_eval", {}), /one of them/);
  assert.ok(mcp.TOOLS.some((tool) => tool.name === "client_ui_state"));
});

// The agent with its client modules stubbed, as e2eClientAgent.test.js loads it.
function runAgent(body, { optimize = false } = {}) {
  const script = `import sys, types, json
sys.modules['blue'] = types.ModuleType('blue')
sys.modules['uthread'] = types.ModuleType('uthread')
scope = {}
exec(compile(open(sys.argv[1], encoding='utf8').read(), '<agent>', 'exec'), scope)
agent = scope['Agent'].__new__(scope['Agent'])
agent.namespace = {}
agent.sm = None
${body}`;
  return spawnSync(PYTHON, [...(optimize ? ["-O"] : []), "-c", script, AGENT], { encoding: "utf8" });
}

test("eval keeps assert though the client runs Python optimized (Python 3 -O, stub client)", { skip: !PYTHON && "no Python 3" }, () => {
  const run = runAgent(`agent.current_uicore = lambda: None
assert sys.flags.optimize
caught = []
for code in ['assert False, "top"; result = True', 'def check():\\n    assert 1 == 2, "nested"\\ncheck()']:
    try:
        agent.op_eval({'code': code})
    except AssertionError as error:
        caught.append(str(error))
held = agent.op_eval({'code': 'assert True\\nresult = True'})['json']
print(json.dumps({'caught': caught, 'held': held}))`, { optimize: true });
  assert.strictEqual(run.status, 0, run.stderr);
  assert.deepStrictEqual(JSON.parse(run.stdout), { caught: ["top", "nested"], held: true });
});

test("ui_state: shown and enabled count ancestors; focus, modal, full screen and scene; the limit cuts it short (Python 3, stub client)",
  { skip: !PYTHON && "no Python 3" }, () => {
    const run = runAgent(`import builtins
class Node(object):
    def __init__(self, name, children=None):
        self.name = name; self.children = children or []; self.display = True; self.state = 0; self.destroyed = False
    def GetAbsolute(self): return (0, 0, 800, 600)
    def IsEnabled(self): return True
class Panel(Node):
    def IsFullscreen(self): return True
edit = Node('edit'); box = Node('box', [edit]); box.display = False; box.state = 1
preview = Node('preview'); preview.scene = object(); preview.camera = object()
panel = Panel('panel', [box, preview]); desktop = Node('desktop', [panel])
registry = types.SimpleNamespace(GetFocus=lambda: edit, GetModalWindow=lambda: panel, GetWindows=lambda: [panel])
agent.current_uicore = lambda: types.SimpleNamespace(desktop=desktop, registry=registry)
builtins.session = types.SimpleNamespace(charid=123)
answer = agent.op_ui_state({})
rows = dict((row['name'], row) for row in answer['nodes'])
box.display = True; box.state = 3; edit.IsEnabled = lambda: False
picked = dict((row['name'], row) for row in agent.op_ui_state({})['nodes'])
print(json.dumps({
    'schema': answer['schema'], 'truncated': answer['truncated'], 'names': sorted(rows),
    'edit': [rows['edit']['effectiveDisplay'], rows['edit']['effectiveEnabled']],
    'fullscreen': rows['panel']['fullscreen'], 'scene': [rows['preview']['scenePresent'], rows['panel']['scenePresent']],
    'focus': answer['focus']['uid'] == rows['edit']['uid'], 'modal': answer['modal']['uid'] == rows['panel']['uid'],
    'parent': rows['edit']['parentUID'] == rows['box']['uid'],
    'cut': agent.op_ui_state({'limit': 2})['truncated'],
    'pickChildren': [picked['box']['effectiveEnabled'], picked['edit']['effectiveEnabled']],
}))`);
    assert.strictEqual(run.status, 0, run.stderr);
    assert.deepStrictEqual(JSON.parse(run.stdout), {
      schema: 1, truncated: false, names: ["box", "desktop", "edit", "panel", "preview"],
      edit: [false, false], fullscreen: true, scene: [true, null], focus: true, modal: true, parent: true, cut: true,
      // A pickChildren container doesn't disable its children; the edit's own IsEnabled() does.
      pickChildren: [true, false],
    });
  });
