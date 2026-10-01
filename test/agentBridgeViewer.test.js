"use strict";

// The human viewer the agent bridge serves (agentBridgeViewer.js and its page
// in viewer/), through the real HTTP layer: the page loads without a token,
// run data needs one, and a run ID can't reach outside _local/e2e/runs/. The
// live path is in docs/GUIDE.md "Viewer".

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { createAgentBridgeHttp } = require("../bridge/http");
const { createAgentBridgeRoutes } = require("../bridge/routes");
const { createAgentBridgeViewer } = require("../bridge/viewer");

function tempRuns() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-viewer-"));
  const runs = path.join(root, "runs");
  const write = (run, lines, result) => {
    fs.mkdirSync(path.join(runs, run), { recursive: true });
    fs.writeFileSync(path.join(runs, run, "timeline.jsonl"), lines.map((line) => `${JSON.stringify(line)}\n`).join(""));
    if (result) fs.writeFileSync(path.join(runs, run, "result.json"), JSON.stringify(result));
  };
  write("old-run", [{ seq: 1, kind: "START", atMs: 1000 }], { name: "old", passed: true, exitCode: 0, missing: 0, expectations: [] });
  write("live-run", [{ seq: 1, kind: "START", atMs: 1000 }, { seq: 2, kind: "POS", atMs: 1500, selfID: 1, balls: [] },
    { seq: 3, kind: "DIVERGE", atMs: 2000, reason: "server-only", itemID: 7 }]);
  fs.mkdirSync(path.join(runs, "economy-only"));
  fs.writeFileSync(path.join(root, "secret.txt"), "not a run");
  const now = Date.now() / 1000;
  fs.utimesSync(path.join(runs, "old-run", "timeline.jsonl"), now - 600, now - 600);
  return { root, runs };
}

async function startBridge(viewer) {
  const routes = createAgentBridgeRoutes({ findSession: () => null, executeChatCommand: null, readGrid: () => ({}), watcher: null,
    viewer });
  const handshakePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "e2e-viewer-hs-")), "bridge.json");
  const http = createAgentBridgeHttp({ routes, port: 0, handshakePath });
  const port = await http.start();
  return { http, base: `http://127.0.0.1:${port}`, auth: { authorization: `Bearer ${http.token}` } };
}

test("the page loads without the token, under a policy that keeps it to the bridge's own files", async () => {
  const { runs } = tempRuns();
  const { http, base } = await startBridge(createAgentBridgeViewer({ runsDir: runs }));
  try {
    const page = await fetch(`${base}/viewer`);
    assert.strictEqual(page.status, 200);
    assert.match(page.headers.get("content-type"), /^text\/html/);
    assert.match(page.headers.get("content-security-policy"), /default-src 'none'; script-src 'self'/);
    assert.strictEqual(page.headers.get("x-frame-options"), "DENY");
    const html = await page.text();
    assert.match(html, /<script src="\/viewer\/viewer.js"><\/script>/);
    assert.doesNotMatch(html, /<script>|style="/, "no inline script or style, which the policy would block");
    const script = await fetch(`${base}/viewer/viewer.js`);
    assert.match(script.headers.get("content-type"), /^text\/javascript/);
    assert.match(await script.text(), /Bearer \$\{token\}/);
    assert.strictEqual((await fetch(`${base}/viewer/viewer.css`)).status, 200);
    assert.strictEqual((await fetch(`${base}/viewer/runs`)).status, 401, "run data needs the token");
    assert.strictEqual((await fetch(`${base}/viewer/../package.json`)).status, 401, "nothing else is public");
  } finally {
    await http.stop();
  }
});

test("runs list newest first with their verdicts; only runs with a timeline", async () => {
  const { runs } = tempRuns();
  const { http, base, auth } = await startBridge(createAgentBridgeViewer({ runsDir: runs }));
  try {
    const body = await (await fetch(`${base}/viewer/runs`, { headers: auth })).json();
    assert.deepStrictEqual(body.runs.map((run) => run.runID), ["live-run", "old-run"]);
    assert.strictEqual(body.runs[0].result, null);
    assert.deepStrictEqual(body.runs[1].result, { name: "old", passed: true, exitCode: 0, missing: 0, expectations: 0 });
  } finally {
    await http.stop();
  }
});

test("a timeline comes in whole lines from a byte offset, and a run ID can't leave the runs directory", async () => {
  const { runs } = tempRuns();
  const viewer = createAgentBridgeViewer({ runsDir: runs, maxChunkBytes: 80 });
  const { http, base, auth } = await startBridge(viewer);
  try {
    const read = async (query) => {
      const response = await fetch(`${base}/viewer/timeline?${query}`, { headers: auth });
      return { status: response.status, body: await response.json() };
    };
    const lines = [];
    let from = 0;
    for (let calls = 0; calls < 10; calls += 1) {
      const { body } = await read(`run=live-run&from=${from}`);
      assert.ok(body.text === "" || body.text.endsWith("\n"), "never half a line");
      lines.push(...body.text.split("\n").filter(Boolean).map((line) => JSON.parse(line).kind));
      from = body.next;
      if (body.next >= body.size) break;
    }
    assert.deepStrictEqual(lines, ["START", "POS", "DIVERGE"]);
    const done = await read(`run=live-run&from=${from}`);
    assert.strictEqual(done.body.text, "");
    assert.strictEqual(done.body.next, done.body.size);

    for (const run of ["..", "../secret.txt", "..%2Fsecret.txt", ".hidden", "a/b", ""]) {
      const { status } = await read(`run=${run}`);
      assert.strictEqual(status, 400, `refused: ${run}`);
    }
    assert.strictEqual((await read("run=economy-only")).status, 404);
  } finally {
    await http.stop();
  }
});

test("the page gets the plugins' colours, and a plugin kind's line comes with the plugin's own text", async () => {
  const { runs } = tempRuns();
  fs.mkdirSync(path.join(runs, "plugin-run"));
  fs.writeFileSync(path.join(runs, "plugin-run", "timeline.jsonl"), [
    { seq: 1, t: 0, kind: "START", atMs: 1000 },
    { seq: 2, t: 500, kind: "RAID", atMs: 1500, gang: "g1", size: 3 },
  ].map((line) => `${JSON.stringify(line)}\n`).join(""));
  const { createToolRegistry } = require("../core/plugins");
  const registry = createToolRegistry({ active: [{ name: "demo", plugin: { tool: {
    kinds: { RAID: { gang: "id", size: "num" } },
    format: { RAID: (event) => [`${event.gang} x${event.size}`, "raiding"] },
    colours: [{ match: { side: "raiders" }, colour: "#aa0000", label: "dark red raiders" }],
  } } }] });
  const { http, base, auth } = await startBridge(createAgentBridgeViewer({ runsDir: runs, registry }));
  try {
    const config = await (await fetch(`${base}/viewer/config`, { headers: auth })).json();
    assert.deepStrictEqual(config.colours, [{ plugin: "demo", match: { side: "raiders" }, colour: "#aa0000", label: "dark red raiders" }]);
    assert.strictEqual((await fetch(`${base}/viewer/config`)).status, 401);
    const body = await (await fetch(`${base}/viewer/timeline?run=plugin-run&from=0`, { headers: auth })).json();
    assert.deepStrictEqual(body.summaries, [[1, "g1 x3  raiding"]], "line 1 is the RAID; START is the page's own");
  } finally {
    await http.stop();
  }
});

test("without a viewer the bridge answers as before", async () => {
  const { http, base, auth } = await startBridge(null);
  try {
    assert.strictEqual((await fetch(`${base}/viewer`)).status, 401);
    assert.strictEqual((await fetch(`${base}/viewer/runs`, { headers: auth })).status, 404);
  } finally {
    await http.stop();
  }
});
