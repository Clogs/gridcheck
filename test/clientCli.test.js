"use strict";

// `gridcheck client` as a process, against a loopback bridge that answers its
// commands the way a client agent would: what it prints, saves and exits with.

const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const { spawn } = require("node:child_process");

const CLI = path.join(__dirname, "..", "bin", "gridcheck.js");
const TOKEN = "fixture-token";

// A tree in attach mode whose bridge handshake names the fixture; answer(op, args) is the agent.
async function fixture(answer) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), "gridcheck-client-cli-"));
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const ok = req.headers.authorization === `Bearer ${TOKEN}`;
    const command = ok ? JSON.parse(body) : null;
    if (command) calls.push(command);
    res.setHeader("content-type", "application/json");
    res.statusCode = ok ? 200 : 401;
    res.end(JSON.stringify(ok ? { ok: true, value: answer(command.op, command.args) } : { ok: false, error: "token" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  fs.mkdirSync(path.join(tree, "server", "src"), { recursive: true });
  fs.mkdirSync(path.join(tree, "_local", "agentBridge"), { recursive: true });
  fs.writeFileSync(path.join(tree, "gridcheck.config.json"), JSON.stringify({ configVersion: 1, mode: "attach" }));
  fs.writeFileSync(path.join(tree, "_local", "agentBridge", "bridge.json"),
    JSON.stringify({ pid: process.pid, host: "127.0.0.1", port: server.address().port, token: TOKEN }));
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "client", ...args], { cwd: tree, env: { ...process.env, GRIDCHECK_TREE: tree },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill(); reject(new Error(`gridcheck client ${args.join(" ")} timed out`)); }, 15000);
    child.on("error", reject);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
  const close = async () => {
    server.close();
    await once(server, "close");
    fs.rmSync(tree, { recursive: true, force: true });
  };
  return { tree, calls, run, close };
}

test("ui-state saves its JSON; check-ui exits 1 when the check fails, and a state cut short can't pass an absence", async () => {
  const uiState = { schema: 1, truncated: false, session: { charid: 123 }, desktop: { rect: [0, 0, 800, 600] }, focus: null, modal: null,
    nodes: [{ uid: "1", path: "/desktop/mod", name: "mod", effectiveDisplay: true, effectiveEnabled: true, rect: [0, 0, 800, 600] }] };
  const client = await fixture(() => uiState);
  try {
    const out = path.join(client.tree, "state.json");
    const saved = await client.run(["ui-state", "--out", out]);
    assert.strictEqual(saved.code, 0, saved.stderr);
    assert.strictEqual(JSON.parse(fs.readFileSync(out, "utf8")).nodes.length, 1);

    let checked = await client.run(["check-ui", "--spec", JSON.stringify({ selector: { name: "mod" }, enabled: true })]);
    assert.strictEqual(checked.code, 0, checked.stderr);
    assert.strictEqual(JSON.parse(checked.stdout).ok, true);

    const file = path.join(client.tree, "gone.json");
    fs.writeFileSync(file, JSON.stringify({ selector: { name: "mod" }, count: 0 }));
    checked = await client.run(["check-ui", "--file", file, "--out", path.join(client.tree, "verdict.json")]);
    assert.strictEqual(checked.code, 1);
    assert.match(JSON.parse(checked.stdout).failures[0], /expected 0 node/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(client.tree, "verdict.json"), "utf8")).result.ok, false);

    uiState.truncated = true;
    checked = await client.run(["check-ui", "--spec", JSON.stringify({ selector: { name: "missing" }, count: 0 })]);
    assert.strictEqual(checked.code, 1, "a state cut short can't show a node is gone");

    const typo = await client.run(["check-ui", "--spec", "{\"selector\":"]);
    assert.notStrictEqual(typo.code, 0);
    assert.match(typo.stderr, /--spec isn't JSON/);
  } finally {
    await client.close();
  }
});

test("eval --assert exits 1 unless the value is exactly True; --file sends the file's Python", async () => {
  const client = await fixture((op, args) => {
    const code = args.code.trim();
    return { json: code === "True" ? true : code === "1" ? 1 : false, repr: code, truncated: false };
  });
  try {
    for (const [code, exit] of [["True", 0], ["False", 1], ["1", 1]]) {
      const evaluated = await client.run(["eval", code, "--assert"]);
      assert.strictEqual(evaluated.code, exit, `${code}: ${evaluated.stderr}`);
      if (exit) assert.match(evaluated.stderr, /not True/);
    }
    const file = path.join(client.tree, "probe.py");
    fs.writeFileSync(file, "True\n");
    const out = path.join(client.tree, "answer.json");
    const evaluated = await client.run(["eval", "--file", file, "--assert", "--out", out]);
    assert.strictEqual(evaluated.code, 0, evaluated.stderr);
    assert.strictEqual(client.calls.at(-1).args.code, "True\n");
    assert.strictEqual(JSON.parse(fs.readFileSync(out, "utf8")).json, true);

    const both = await client.run(["eval", "True", "--file", file]);
    assert.notStrictEqual(both.code, 0);
    assert.match(both.stderr, /not both/);
  } finally {
    await client.close();
  }
});
