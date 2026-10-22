"use strict";

// lu-reload (plugins/lu/tool/reload.js): the joined source split back into its files, the
// reload's Python against a stub module handle (Python 3), the command's answers, and the
// LU bridge route that serves a module's source.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const { RELOAD_PY, cmdLuReload, splitSource } = require("../plugins/lu/tool/reload");
const { createLuRoutes } = require("../plugins/lu/server/routes");

const PYTHON = ["python3", "python"].find((name) => spawnSync(name, ["-c", "import sys; assert sys.version_info >= (3,)"]).status === 0);

const WINDOW = "def install(sm, session, is_ready):\n    return Controller(helper())\n";
const ZOOM = "class Controller(object):\n    def __init__(self, value):\n        self.value = value\n    def dispose(self):\n        pass\n";
const CORP = "def helper():\n    return 7\n";

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gridcheck-lu-reload-"));
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

test("the joined source splits back into the files it was joined from, in order", () => {
  const root = "/tree";
  const candidates = [
    { file: "/tree/server/src/_secondary/luCommand/client/window.py", text: WINDOW },
    { file: "/tree/server/src/_secondary/luCommand/client/zoomView.py", text: ZOOM },
    { file: "/tree/server/src/_secondary/luCommand/client/corpWindow.py", text: CORP },
    { file: "/tree/server/src/_secondary/other/client/unused.py", text: "x = 1\n" },
    { file: "/tree/server/src/_secondary/empty.py", text: "" },
  ];
  const parts = splitSource([WINDOW, ZOOM, CORP].join("\n"), candidates, { treeRoot: root, moduleID: "luCommand" });
  assert.deepEqual(parts.map((part) => part.name), ["window.py", "zoomView.py", "corpWindow.py"]);
  assert.deepEqual(parts.map((part) => part.text), [WINDOW, ZOOM, CORP]);

  const generated = "# generated header\nTABLE = {}\n";
  const withGap = splitSource([generated, WINDOW, CORP].join("\n"), candidates, { treeRoot: root, moduleID: "luCommand" });
  assert.deepEqual(withGap.map((part) => [part.name, part.file === null]), [["luCommand-part1.py", true], ["window.py", false], ["corpWindow.py", false]],
    "code no file holds is a part of its own");

  const twins = splitSource([WINDOW, CORP].join("\n"), [candidates[0], { file: "/tree/server/src/b/window.py", text: CORP }], { treeRoot: root });
  assert.deepEqual(twins.map((part) => part.name), ["server/src/_secondary/luCommand/client/window.py", "server/src/b/window.py"],
    "two files with one name are named by their paths");

  assert.deepEqual(splitSource(CORP, [], { moduleID: "m" }).map((part) => part.name), ["m-part1.py"], "no file matched: the whole source");
});

function runReload(spec, handle = "Handle(True)") {
  const script = `
import builtins, json, types
class Old(object):
    disposed = []
    def dispose(self):
        Old.disposed.append(1)
class Handle(object):
    def __init__(self, ready):
        self.ready, self.controller, self.sm, self.session = ready, Old(), 'handle-sm', 'handle-session'
    def usable(self):
        return self.ready
handle = ${handle}
if handle is not None:
    builtins._lu_client_module_luCommand = handle
elif hasattr(builtins, '_lu_client_module_luCommand'):
    del builtins._lu_client_module_luCommand
space = {'sm': 'eval-sm', 'session': 'eval-session', '_gc_lu': json.loads(${JSON.stringify(JSON.stringify(spec))})}
code = ${JSON.stringify(RELOAD_PY)}
exec(code.rsplit('_gc_lu_reload(_gc_lu)', 1)[0], space)
out = space['_gc_lu_reload'](space['_gc_lu'])
controller = getattr(handle, 'controller', None)
print(json.dumps({'result': out, 'disposed': len(Old.disposed), 'value': getattr(controller, 'value', None),
                  'ready': controller.ready() if hasattr(controller, 'ready') else None,
                  'globals': sorted(k for k in ('lu_module', 'lu_controller') if k in space)}))
`;
  const file = path.join(os.tmpdir(), `gridcheck-lu-reload-${process.pid}-${Math.random().toString(36).slice(2)}.py`);
  fs.writeFileSync(file, script);
  try {
    const result = spawnSync(PYTHON, [file], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
  } finally {
    fs.rmSync(file, { force: true });
  }
}

const part = (name, text) => ({ name, source64: zlib.deflateSync(Buffer.from(text, "utf8")).toString("base64") });

test("the reload's Python: each file under its own name, the old controller disposed, install run (Python 3)", { skip: !PYTHON && "no Python 3" }, () => {
  const install = "def install(sm, session, is_ready):\n    c = Controller(helper())\n    c.ready = is_ready\n    c.args = (sm, session)\n    return c\n";
  const spec = { module: "luCommand", parts: [part("window.py", install), part("zoomView.py", ZOOM), part("corpWindow.py", CORP)] };
  const done = runReload(spec);
  assert.deepEqual(done.result, { ok: true, parts: ["window.py", "zoomView.py", "corpWindow.py"], bytes: install.length + ZOOM.length + CORP.length,
    disposed: "disposed", forced: false });
  assert.equal(done.value, 7, "a later file's function, called from install");
  assert.equal(done.disposed, 1);
  assert.equal(done.ready, true);
  assert.deepEqual(done.globals, ["lu_controller", "lu_module"], "then's names");

  const forced = runReload(spec, "Handle(False)");
  assert.equal(forced.result.forced, true, "a copy from an earlier server process gets is_ready forced true");
  assert.equal(forced.ready, true);

  const broken = runReload({ module: "luCommand", parts: [part("window.py", install), part("corpWindow.py", "def helper():\n    return 7\n\nx = (1,\n")] });
  assert.deepEqual([broken.result.ok, broken.result.stage, broken.result.file, broken.disposed], [false, "compile", "corpWindow.py", 0],
    "a syntax error names its file, and nothing is disposed");
  assert.ok(broken.result.line >= 4, `line ${broken.result.line}`);

  const raising = runReload({ module: "luCommand", parts: [part("window.py", "def install(sm, session, is_ready):\n    return helper()\n"),
    part("corpWindow.py", "def helper():\n    raise KeyError('crew')\n")] });
  assert.equal(raising.result.stage, "install");
  assert.match(raising.result.traceback, /File "lu-luCommand\/corpWindow\.py", line 2, in helper/);
  assert.equal(raising.result.disposed, "disposed");

  const checked = runReload({ module: "luCommand", check: true, parts: spec.parts });
  assert.deepEqual([checked.result.checked, checked.disposed], [true, 0], "check compiles and touches nothing");

  const none = runReload(spec, "None");
  assert.equal(none.result.stage, "handle");
  assert.match(none.result.message, /no luCommand module/);
});

test("lu-reload sends the server's source split by file, and names file:line when it fails", async () => {
  const root = tree({
    "server/src/_secondary/luCommand/client/window.py": WINDOW,
    "server/src/_secondary/luCommand/client/corpWindow.py": CORP,
  });
  try {
    const printed = [];
    const sent = [];
    let answer = { ok: true, parts: ["window.py", "corpWindow.py"], bytes: 10, disposed: "disposed", forced: true };
    const io = {
      CliError: class extends Error {},
      treeRoot: root,
      print: (line) => printed.push(line),
      bridge: async (method, route) => {
        sent.push([method, route]);
        return { ok: true, id: "luCommand", version: "0.9.0", source: [WINDOW, CORP].join("\n") };
      },
      clientCommand: async (op, args, flags) => {
        sent.push([op, args.vars ? args.vars._gc_lu : args.code, flags]);
        return { value: args.vars ? { json: answer } : { repr: "'operations'" } };
      },
    };
    await cmdLuReload(["luCommand"], { then: "lu_controller.page" }, io);
    assert.deepEqual(sent[0], ["GET", "/client-module?id=luCommand"]);
    const spec = sent[1][1];
    assert.deepEqual(spec.parts.map((row) => [row.name, zlib.inflateSync(Buffer.from(row.source64, "base64")).toString("utf8")]),
      [["window.py", WINDOW], ["corpWindow.py", CORP]]);
    assert.equal(spec.check, false);
    assert.deepEqual(sent[1][2], { timeout: 60 });
    assert.deepEqual(sent[2], ["eval", "lu_controller.page", { timeout: 60 }], "then runs after");
    assert.match(printed.join("\n"), /reloaded luCommand v0\.9\.0 from window\.py, corpWindow\.py[\s\S]*is_ready is forced true[\s\S]*then: 'operations'/);

    answer = { ok: false, stage: "compile", file: "corpWindow.py", line: 2, column: 5, message: "invalid syntax", text: "    retrun 7" };
    await assert.rejects(cmdLuReload([], {}, io),
      /SyntaxError at corpWindow\.py:2:5 \(server\/src\/_secondary\/luCommand\/client\/corpWindow\.py\): invalid syntax\n {4}retrun 7/);
    answer = { ok: false, stage: "install", disposed: "disposed", traceback: "Traceback (most recent call last):\n" +
      "  File \"<gridcheck-eval>\", line 40, in _gc_lu_reload\n  File \"lu-luCommand/corpWindow.py\", line 2, in helper\nKeyError: 'crew'\n" };
    await assert.rejects(cmdLuReload([], {}, io), (error) => {
      assert.match(error.message, /install\(\) raised\n {2}at corpWindow\.py:2 \(server\/src\/_secondary\/luCommand\/client\/corpWindow\.py:2\)/);
      assert.doesNotMatch(error.message, /gridcheck-eval/, "the reload's own frames are dropped");
      assert.match(error.message, /the previous controller was disposed; the client now has none/);
      return true;
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the bridge serves a module's source through its own readSource, and names the modules there are", () => {
  let reads = 0;
  const modules = new Map([["luCommand", { id: "luCommand", serviceName: "luCommand", version: "0.9.0", readSource: () => `src${++reads}` }]]);
  const routes = createLuRoutes({ delivery: () => ({ modules }) });
  const one = routes["GET /client-module"]({ query: {} });
  assert.deepEqual([one.statusCode, one.body.id, one.body.source], [200, "luCommand", "src1"], "the only module needs no id");
  assert.equal(routes["GET /client-module"]({ query: { id: "luCommand" } }).body.source, "src2", "read again on each call");
  const missing = routes["GET /client-module"]({ query: { id: "nope" } });
  assert.deepEqual([missing.statusCode, missing.body.error], [409, "no client module nope; this server delivers luCommand"]);
  const none = createLuRoutes({ delivery: () => undefined })["GET /client-module"]({ query: {} });
  assert.equal(none.statusCode, 503);
  modules.set("broken", { readSource: () => { throw new Error("ENOENT"); } });
  assert.match(routes["GET /client-module"]({ query: { id: "broken" } }).body.error, /broken's readSource failed: ENOENT/);
});
