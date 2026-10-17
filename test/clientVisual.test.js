"use strict";

// Offline picture comparison, frame capture against stubs, pointer arguments,
// and agent.py's op_pointer against a stub uilib under Python 3.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const visual = require("../core/clientVisual");
const { validateScenario, describeStep } = require("../core/scenario");
const mcp = require("../bin/mcp");

const AGENT = path.join(__dirname, "..", "bridge", "client", "agent.py");
const PYTHON = ["python3", "python"].find((name) => spawnSync(name, ["-c", "import sys; assert sys.version_info >= (3,)"]).status === 0);

// Two pixels: the first red by `red`, the second black.
const image = (red = 0) => ({ width: 2, height: 1, pixels: Buffer.from([red, 0, 0, 255, 0, 0, 0, 255]) });

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridcheck-visual-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a PNG round-trips; a changed pixel counts unless under the threshold, allowed or ignored", () => {
  const a = image();
  const b = image(50);
  assert.deepStrictEqual(visual.decodePng(visual.encodePng(a)), a);
  const result = visual.compareImages(a, b);
  assert.deepStrictEqual([result.ok, result.changedPixels, result.changedFraction, result.maxDelta], [false, 1, 0.5, 50]);
  assert.deepStrictEqual([...result.diff.pixels.subarray(0, 4)], [255, 0, 0, 255], "changed is red");
  assert.strictEqual(visual.compareImages(a, b, { threshold: 50 }).ok, true);
  assert.strictEqual(visual.compareImages(a, b, { maxChangedFraction: 0.5 }).ok, true);
  const masked = visual.compareImages(a, b, { ignore: [[0, 0, 1, 1]] });
  assert.deepStrictEqual([masked.ok, masked.comparedPixels], [true, 1]);
  assert.deepStrictEqual([...masked.diff.pixels.subarray(0, 4)], [0, 0, 128, 255], "ignored is blue");
  assert.throws(() => visual.compareImages(a, b, { ignore: [[0, 0, 2, 1]] }), /every pixel/);
  assert.throws(() => visual.compareImages(a, b, { ignore: [[0, 0, 3, 1]] }), /goes past/);
  assert.match(visual.compareImages(a, { width: 1, height: 1, pixels: Buffer.alloc(4) }).reason, /sizes differ/);
  for (const options of [{ threshold: NaN }, { maxChangedFraction: 2 }, { ignore: [[-1, 0, 1, 1]] }, { typo: 1 }]) {
    assert.throws(() => visual.comparisonOptions(options), undefined, JSON.stringify(options));
  }
});

test("the decoder reads RGB and RGBA through all five scanline filters, and refuses a corrupt file", () => {
  const paeth = (a, b, c) => {
    const p = a + b - c;
    if (Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)) return a;
    return Math.abs(p - b) <= Math.abs(p - c) ? b : c;
  };
  // A 2x2 image, both rows the same pixels, filtered by hand.
  const rgba = Buffer.from([10, 20, 30, 255, 40, 50, 60, 255]);
  for (const channels of [3, 4]) {
    const row = channels === 4 ? rgba : Buffer.from([10, 20, 30, 40, 50, 60]);
    for (let filter = 0; filter < 5; filter += 1) {
      const raw = Buffer.alloc((row.length + 1) * 2);
      for (let y = 0; y < 2; y += 1) {
        raw[y * (row.length + 1)] = filter;
        for (let x = 0; x < row.length; x += 1) {
          const left = x >= channels ? row[x - channels] : 0;
          const up = y ? row[x] : 0;
          const upLeft = y && x >= channels ? row[x - channels] : 0;
          raw[y * (row.length + 1) + 1 + x] = (row[x] - [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upLeft)][filter]) & 0xff;
        }
      }
      const png = rechunk(2, 2, channels === 4 ? 6 : 2, zlib.deflateSync(raw));
      assert.deepStrictEqual(visual.decodePng(png).pixels, Buffer.concat([rgba, rgba]), `channels ${channels}, filter ${filter}`);
    }
  }
  const corrupt = visual.encodePng(image());
  corrupt[20] ^= 1;
  assert.throws(() => visual.decodePng(corrupt), /checksum/);
  assert.throws(() => visual.decodePng(Buffer.from("not a png")), /not a PNG/);
});

// A PNG of the given size and colour type around already-filtered, compressed data.
function rechunk(width, height, colourType, data) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colourType;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([signature, crcChunk("IHDR", header), crcChunk("IDAT", data), crcChunk("IEND", Buffer.alloc(0))]);
}

// A chunk with its CRC-32, computed here independently of the module under test.
function crcChunk(type, body) {
  const named = Buffer.concat([Buffer.from(type, "ascii"), body]);
  let crc = 0xffffffff;
  for (const byte of named) {
    crc ^= byte;
    for (let k = 0; k < 8; k += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  const out = Buffer.alloc(body.length + 12);
  out.writeUInt32BE(body.length, 0);
  named.copy(out, 4);
  out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
  return out;
}

test("frame sequences: pixels, time from the first frame, counts and order", (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, "black.png"), visual.encodePng(image()));
  fs.writeFileSync(path.join(dir, "red.png"), visual.encodePng(image(255)));
  const write = (name, frames) => {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({ schema: 1, frames }));
    return file;
  };
  const reference = write("reference", [{ file: "black.png", atMs: 0 }, { file: "red.png", atMs: 100 }]);
  const shifted = write("shifted", [{ file: "black.png", atMs: 10 }, { file: "red.png", atMs: 110 }]);
  assert.strictEqual(visual.compareSequences(reference, shifted, {}, path.join(dir, "diff")).ok, true, "only time from the first frame counts");
  assert.ok(fs.existsSync(path.join(dir, "diff", "diff-1.png")));
  assert.throws(() => visual.compareSequences(reference, shifted, {}, path.join(dir, "diff")), /exists already/, "evidence isn't overwritten");
  assert.strictEqual(visual.compareSequences(reference, write("slow", [{ file: "black.png", atMs: 0 }, { file: "red.png", atMs: 500 }])).ok, false);
  assert.strictEqual(visual.compareSequences(reference, write("other", [{ file: "red.png", atMs: 0 }, { file: "red.png", atMs: 100 }])).ok, false);
  assert.strictEqual(visual.compareSequences(reference, write("three", [{ file: "black.png", atMs: 0 }, { file: "red.png", atMs: 100 },
    { file: "red.png", atMs: 200 }])).ok, false);
  assert.throws(() => visual.compareSequences(reference, write("one", [{ file: "red.png", atMs: 0 }])), /2 to 120 frames/);
  assert.throws(() => visual.compareSequences(reference, write("tie", [{ file: "red.png", atMs: 0 }, { file: "red.png", atMs: 0 }])), /after the frame before/);
});

test("a capture times each frame and fails on a new client, a missing picture or a new size", async (t) => {
  const dir = tempDir(t);
  let clock = 0;
  let who = { pid: 1, charid: 2, build: 3396210 };
  const base = { spec: { count: 3, intervalMs: 100 }, now: () => clock, sleep: async (ms) => { clock += ms; }, identity: async () => who,
    capture: async (file) => {
      clock += 20;
      fs.writeFileSync(file, visual.encodePng(image()));
      return {};
    } };
  const manifest = await visual.captureSequence({ ...base, directory: path.join(dir, "ok") });
  assert.deepStrictEqual(manifest.frames.map((frame) => frame.atMs), [10, 110, 210]);
  assert.strictEqual(manifest.frames[0].captureMs, 20);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "ok", "frames.json"), "utf8")).frames.length, 3);
  await assert.rejects(visual.captureSequence({ ...base, directory: path.join(dir, "ok") }), /exists already/);
  await assert.rejects(visual.captureSequence({ ...base, directory: path.join(dir, "gone"), capture: async () => ({}) }), /saved no picture/);
  await assert.rejects(visual.captureSequence({ ...base, directory: path.join(dir, "relog"), capture: async (file) => {
    fs.writeFileSync(file, visual.encodePng(image()));
    who = { ...who, charid: 9 };
    return {};
  } }), /client changed/);
  who = { pid: 1, charid: 2, build: 3396210 };
  let shots = 0;
  await assert.rejects(visual.captureSequence({ ...base, directory: path.join(dir, "resize"), capture: async (file) => {
    shots += 1;
    fs.writeFileSync(file, visual.encodePng(shots === 1 ? image() : { width: 1, height: 1, pixels: Buffer.alloc(4) }));
    return {};
  } }), /changed size/);
  for (const spec of [{ count: 1 }, { intervalMs: 10 }, { count: 120, intervalMs: 5000 }, { every: 1 }]) {
    assert.throws(() => visual.captureOptions(spec), undefined, JSON.stringify(spec));
  }
});

test("pointer and capture steps are checked when the scenario loads; MCP turns them into CLI arguments", () => {
  const drag = { action: "drag", points: [[1, 2], [3, 4]], durationMs: 100 };
  assert.strictEqual(visual.validatePointer(drag).button, 0);
  for (const spec of [{ points: [] }, { points: [[NaN, 0]] }, { action: "drag", points: [[0, 0]] }, { action: "wheel", points: [[0, 0]], delta: 0 },
    { points: [[0, 0]], button: 3 }, { points: [[0, 0]], speed: 1 }]) {
    assert.throws(() => visual.validatePointer(spec), undefined, JSON.stringify(spec));
  }
  const scenario = validateScenario({ name: "visual", world: "fresh", setup: [{ clientPointer: drag }, { clientCaptureFrames: { count: 3, intervalMs: 500 } }],
    until: { timeout: 2 }, expect: ["GRID"] });
  const [pointer, capture] = scenario.setup.filter((step) => step.type.startsWith("client"));
  assert.strictEqual(describeStep(pointer), "clientPointer drag 1,2 3,4");
  assert.strictEqual(describeStep(capture), "clientCaptureFrames 3 every 500 ms");
  assert.throws(() => validateScenario({ name: "visual", world: "fresh", setup: [{ clientPointer: { action: "fling", points: [[1, 1]] } }],
    until: { timeout: 2 }, expect: ["GRID"] }), /clientPointer: pointer action/);

  assert.deepStrictEqual(mcp.cliArgs("client_pointer", { action: "drag", points: [[1, 2], [3, 4]], durationMs: 100, button: 0 }),
    ["client", "--button=0", "--duration=100", "--json", "--", "pointer", "drag", "1,2", "3,4"]);
  assert.deepStrictEqual(mcp.cliArgs("client_compare_images", { reference: "a.png", actual: "b.png", threshold: 8, ignore: [[0, 0, 10, 10], [5, 5, 1, 1]] }),
    ["client", "--threshold=8", "--ignore=0,0,10,10;5,5,1,1", "--", "compare-images", "a.png", "b.png"]);
  assert.deepStrictEqual(mcp.cliArgs("client_capture_frames", { out: "f", count: 5 }), ["client", "--out=f", "--count=5", "--", "capture-frames"]);
});

test("compare-images runs with no server: exit 1 on a difference, the result and the diff saved", (t) => {
  const dir = tempDir(t);
  fs.mkdirSync(path.join(dir, "server", "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "gridcheck.config.json"), JSON.stringify({ configVersion: 1, mode: "attach" }));
  fs.writeFileSync(path.join(dir, "a.png"), visual.encodePng(image()));
  fs.writeFileSync(path.join(dir, "b.png"), visual.encodePng(image(255)));
  const run = (...args) => spawnSync(process.execPath, [path.join(__dirname, "..", "bin", "gridcheck.js"), "client", ...args],
    { cwd: dir, env: { ...process.env, GRIDCHECK_TREE: dir }, encoding: "utf8", windowsHide: true });
  const differ = run("compare-images", "a.png", "b.png", "--diff", "diff.png", "--out", "result.json");
  assert.strictEqual(differ.status, 1, differ.stderr);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8")).changedPixels, 1);
  assert.ok(fs.existsSync(path.join(dir, "diff.png")));
  const allowed = run("compare-images", "a.png", "b.png", "--max-changed", "0.5");
  assert.strictEqual(allowed.status, 0, allowed.stderr);
  const masked = run("compare-images", "a.png", "b.png", "--ignore", "0,0,1,1");
  assert.strictEqual(masked.status, 0, masked.stderr);
});

test("op_pointer checks the whole path first, drags through uilib, and lets go and puts the cursor back after an error (Python 3, stub client)",
  { skip: !PYTHON && "no Python 3" }, () => {
    const script = `import sys, types, json
sys.modules['blue'] = types.SimpleNamespace(pyos=types.SimpleNamespace(synchro=types.SimpleNamespace(SleepWallclock=lambda ms: None)))
sys.modules['uthread'] = types.ModuleType('uthread')
scope = {}
exec(compile(open(sys.argv[1], encoding='utf8').read(), '<agent>', 'exec'), scope)
class Lib(object):
    leftbtn = rightbtn = midbtn = False
    def __init__(self): self.x = 9; self.y = 8; self.cursorPos = (9, 8); self.calls = []
    def GetMouseCapture(self): return None
    def UpdateMouseOver(self): self.calls.append('pick %s,%s' % (self.x, self.y))
    def GetMouseOver(self): return None
    def _OnMouseMove(self, x, y): self.x = x; self.y = y; self.calls.append('move')
    def _OnMouseDown(self, *args): self.calls.append('down')
    def _OnMouseUp(self, *args): self.calls.append('up')
    def _OnMouseWheel(self, delta): self.calls.append('wheel %s' % delta)
lib = Lib()
core = types.SimpleNamespace(uilib=lib, desktop=types.SimpleNamespace(width=100, height=100), ScaleDpi=lambda value: value * 2)
agent = scope['Agent'].__new__(scope['Agent'])
agent.current_uicore = lambda: core
out = {}
out['drag'] = agent.op_pointer({'action': 'drag', 'points': [[1, 2], [3, 4]]})['points']
out['dragCalls'] = lib.calls; out['restored'] = [lib.x, lib.y, list(lib.cursorPos)]
lib.calls = []
agent.op_pointer({'action': 'wheel', 'points': [[5, 5]], 'delta': -120})
out['wheelCalls'] = lib.calls
lib.calls = []
for bad in [{'action': 'drag', 'points': [[1, 2], [300, 0]]}, {'action': 'click', 'points': [[True, 2]]}, {'action': 'wheel', 'points': [[1, 1]]}]:
    try:
        agent.op_pointer(bad)
    except ValueError:
        pass
    else:
        raise AssertionError('accepted %r' % (bad,))
out['afterBad'] = list(lib.calls)
def fail(*args):
    lib.calls.append('down'); raise RuntimeError('handler failed')
lib._OnMouseDown = fail
try:
    agent.op_pointer({'action': 'click', 'points': [[1, 2]]})
except RuntimeError:
    pass
out['failedTail'] = lib.calls[-2:]; out['busy'] = agent.pointer_busy; out['cursor'] = list(lib.cursorPos)
lib.leftbtn = True
try:
    agent.op_pointer({'action': 'move', 'points': [[1, 2]]})
except ValueError as error:
    out['held'] = 'button is down' in str(error)
print(json.dumps(out))`;
    const run = spawnSync(PYTHON, ["-c", script, AGENT], { encoding: "utf8" });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.deepStrictEqual(JSON.parse(run.stdout), {
      drag: 2,
      // Each point is picked where it is, then moved to; the press at the first, the release at the end, then the cursor goes back.
      dragCalls: ["pick 1,2", "move", "down", "pick 3,4", "move", "up", "pick 9,8"],
      restored: [9, 8, [9, 8]],
      wheelCalls: ["pick 5,5", "move", "wheel -120", "pick 9,8"],
      afterBad: [],
      failedTail: ["up", "pick 9,8"],
      busy: false,
      cursor: [9, 8],
      held: true,
    });
  });
