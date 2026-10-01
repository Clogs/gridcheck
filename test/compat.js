#!/usr/bin/env node
"use strict";

// npm run compat -- --stock <EveJS zip or unpacked folder> --lu <LU tree>
//                   [--scratch <dir>] [--sde <dir>] [--only stock|lu] [--keep-lu] [--report <file>]
//
// The two compatibility lanes, live. For each tree it vendors this
// checkout's HEAD, boots the server, runs the round trips an agent would
// (init, doctor, login, undock, grid, watch, smoke-undock), records the
// fixtures again and compares them with the committed ones, and runs the
// tests that need a real tree. Writes compat-report.md and exits 1 on any
// failure.
//
// stock  the zip is unpacked once into --scratch (F:/LU/_compat by default,
//        outside every repo) and reused while the zip is unchanged. Its
//        reference data is built by the zip's own database creator from an
//        extracted SDE: --sde, EVEJS_E2E_SDE_DIR, or the one the LU tree's
//        data comes from. Managed mode boots a fresh world; attach mode
//        starts the server by hand, as a user would, on the tree's port block.
// lu     managed mode on the saved world lowsec-docked. The tree's vendored
//        copy (and an e2e.config.json this script wrote) is put back
//        afterwards unless --keep-lu.
//
// Lanes run one after the other: two big servers at once can lose a
// persistence lease on one machine.

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const { runTests } = require("./run");
const { captureDestiny, captureLive, committedFixtures, compareCaptures } = require("./fixtures/capture");

const REPO_ROOT = path.join(__dirname, "..");
const REPO_CLI = path.join(REPO_ROOT, "bin", "e2e.js");
const DEFAULT_SCRATCH = process.platform === "win32" ? "F:/LU/_compat" : path.join(os.homedir(), "evejs-compat");
const LU_WORLD = "lowsec-docked";
const VENDORED_PATHS = ["tools/evejs-e2e", "server/src/_secondary/agentBridge/server.js"];

class CompatError extends Error {}

// ---------- the report ----------

const rows = [];
const notes = [];

async function check(lane, name, run) {
  const startedAt = Date.now();
  try {
    const detail = await run();
    rows.push({ lane, name, result: "pass", detail: detail || "", seconds: (Date.now() - startedAt) / 1000 });
    process.stdout.write(`  pass  ${lane}  ${name}${detail ? `: ${String(detail).split("\n")[0]}` : ""}\n`);
    return true;
  } catch (error) {
    const detail = error instanceof CompatError ? error.message : error.stack || String(error);
    rows.push({ lane, name, result: "FAIL", detail, seconds: (Date.now() - startedAt) / 1000 });
    process.stdout.write(`  FAIL  ${lane}  ${name}: ${detail.split("\n").slice(0, 6).join("\n        ")}\n`);
    return false;
  }
}

function skip(lane, name, why) {
  rows.push({ lane, name, result: "skip", detail: why, seconds: 0 });
  process.stdout.write(`  skip  ${lane}  ${name}: ${why}\n`);
}

function cell(text) {
  return String(text || "").replace(/\r?\n/g, "<br>").replace(/\|/g, "\\|").slice(0, 600);
}

function writeReport(file, context) {
  const failed = rows.filter((row) => row.result === "FAIL");
  const lines = [
    "# evejs-e2e compatibility report",
    "",
    `${failed.length ? `**red**: ${failed.length} of ${rows.length} checks failed` : `**green**: ${rows.filter((row) => row.result === "pass").length} checks passed`}` +
      `${rows.some((row) => row.result === "skip") ? `, ${rows.filter((row) => row.result === "skip").length} skipped` : ""}.`,
    "",
    "| | |",
    "| --- | --- |",
    `| Checkout | ${cell(context.commit)} |`,
    `| Node | ${process.version} on ${process.platform} |`,
    `| Started | ${new Date(context.startedAtMs).toISOString()} |`,
    `| Took | ${Math.round((Date.now() - context.startedAtMs) / 1000)} s |`,
    ...context.trees.map((tree) => `| ${tree.lane} | ${cell(tree.text)} |`),
    "",
    "| Lane | Check | Result | Detail | s |",
    "| --- | --- | --- | --- | --- |",
    ...rows.map((row) => `| ${row.lane} | ${cell(row.name)} | ${row.result} | ${cell(row.detail)} | ${row.seconds.toFixed(1)} |`),
  ];
  if (notes.length) lines.push("", "## Notes", "", ...notes.map((note) => `- ${note}`));
  lines.push("");
  fs.writeFileSync(file, lines.join("\n"));
}

// ---------- processes ----------

function run(command, args, { cwd, env = process.env, timeoutMs = 600_000, shell = false } = {}) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: timeoutMs, windowsHide: true, shell,
    maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status, out: `${result.stdout || ""}${result.stderr || ""}`.trim(), error: result.error };
}

function npm(args, cwd) {
  // npm is a .cmd on Windows, which only a shell runs.
  return run(`npm ${args.join(" ")}`, [], { cwd, shell: true, timeoutMs: 900_000 });
}

function git(cwd, args) {
  return run("git", args, { cwd, timeoutMs: 60_000 });
}

// The tree's own copy of the CLI, as a person runs it. -> output; throws
// unless the exit code is `expect` (null: any).
function cliIn(tree, args, { expect = 0, timeoutMs = 900_000 } = {}) {
  const env = { ...process.env, EVEJS_E2E_TREE: tree };
  for (const name of ["EVEJS_AGENT_BRIDGE", "EVEJS_AGENT_BRIDGE_HANDSHAKE", "EVEJS_E2E_PORT_SLOT", "EVEJS_GAMESTORE_DATA_DIR",
    "EVEJS_DATA_ROOT"]) delete env[name];
  const result = run(process.execPath, [path.join(tree, "tools", "evejs-e2e", "bin", "e2e.js"), ...args], { cwd: tree, env, timeoutMs });
  if (result.code === null || (expect !== null && result.code !== expect)) {
    throw new CompatError(`e2e ${args.join(" ")} exited ${result.code}${result.error ? ` (${result.error.message})` : ""}:\n` +
      result.out.split(/\r?\n/).slice(-15).join("\n"));
  }
  return result.out;
}

function lastLine(text) {
  return String(text).trim().split(/\r?\n/).pop();
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function tcpOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(2000);
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.once("timeout", () => done(false));
  });
}

function sha256File(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.alloc(4 * 1024 * 1024);
  try {
    let read;
    while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, read));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

// ---------- the stock tree ----------

function unpack(zip, dir) {
  fs.mkdirSync(dir, { recursive: true });
  // bsdtar (Windows' tar, macOS) reads zips; GNU tar doesn't, so unzip is the fallback.
  const tar = run("tar", ["-xf", zip, "-C", dir], { timeoutMs: 900_000 });
  if (tar.code === 0) return;
  const unzip = run("unzip", ["-q", "-o", zip, "-d", dir], { timeoutMs: 900_000 });
  if (unzip.code !== 0) throw new CompatError(`could not unpack ${zip}: tar said ${tar.out || tar.error}; unzip said ${unzip.out || unzip.error}`);
}

// -> { tree, text }: the unpacked tree, reused while the zip is unchanged.
function stockTree(stock, scratch) {
  if (fs.statSync(stock).isDirectory()) return { tree: path.resolve(stock), text: `${path.resolve(stock)} (used in place)` };
  const sha = sha256File(stock);
  const name = path.basename(stock, path.extname(stock)).toLowerCase().replace(/^evejs-v/, "evejs-");
  const dir = path.join(path.resolve(scratch), name);
  const markerFile = path.join(dir, ".compat.json");
  const marker = readJSON(markerFile);
  if (marker && marker.zipSha256 === sha) return { tree: dir, text: `${stock} (sha256 ${sha.slice(0, 12)}), unpacked in ${dir} earlier` };
  if (fs.existsSync(dir) && fs.readdirSync(dir).length && !marker) {
    throw new CompatError(`${dir} exists and wasn't unpacked by this script (no .compat.json); move it or pass another --scratch`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  unpack(stock, dir);
  fs.writeFileSync(markerFile, `${JSON.stringify({ zip: stock, zipSha256: sha, unpackedAt: new Date().toISOString() }, null, 2)}\n`);
  return { tree: dir, text: `${stock} (sha256 ${sha.slice(0, 12)}), unpacked into ${dir}` };
}

function installDependencies(tree) {
  const done = [];
  for (const dir of [path.join(tree, "server"), tree]) {
    const pkg = readJSON(path.join(dir, "package.json"));
    if (!pkg || !Object.keys(pkg.dependencies || {}).length || fs.existsSync(path.join(dir, "node_modules"))) continue;
    const result = npm(["ci", "--no-audit", "--no-fund"], dir);
    if (result.code !== 0) throw new CompatError(`npm ci in ${dir} failed:\n${result.out.split(/\r?\n/).slice(-10).join("\n")}`);
    done.push(path.relative(tree, dir) || ".");
  }
  return done.length ? `npm ci in ${done.join(", ")}` : "already installed";
}

// The SDE build the tree's database creator expects.
function sdeBuild(tree) {
  const bat = path.join(tree, "tools", "DatabaseCreator", "CreateDatabase.bat");
  const match = fs.existsSync(bat) ? /set "SDE_BUILD=(\d+)"/.exec(fs.readFileSync(bat, "utf8")) : null;
  if (!match) throw new CompatError(`no SDE build in ${bat}`);
  return match[1];
}

function findSde(name, { sde, lu }) {
  const candidates = [];
  if (sde) candidates.push(path.resolve(sde));
  if (process.env.EVEJS_E2E_SDE_DIR) candidates.push(path.resolve(process.env.EVEJS_E2E_SDE_DIR));
  if (lu) {
    candidates.push(path.join(lu, "_local", "sde", name));
    try {
      // A linked tree's data dir points into the tree that holds the SDE.
      candidates.push(path.join(fs.realpathSync(path.join(lu, "_local", "gameStore", "data")), "..", "..", "sde", name));
    } catch (_error) {
      // No data dir to follow.
    }
  }
  return candidates.find((dir) => fs.existsSync(path.join(dir, "types.jsonl"))) || null;
}

function buildReferenceData(tree, { sde, lu }) {
  if (fs.existsSync(path.join(tree, "_local", "gameStore", "manifest.json"))) return "already built";
  const build = sdeBuild(tree);
  const name = `eve-online-static-data-${build}-jsonl`;
  const target = path.join(tree, "_local", "sde", name);
  if (!fs.existsSync(target)) {
    const source = findSde(name, { sde, lu });
    if (!source) {
      throw new CompatError(`no extracted SDE ${name}: pass --sde <dir> or set EVEJS_E2E_SDE_DIR, or run the tree's ` +
        "tools/DatabaseCreator/CreateDatabase.bat, which downloads it");
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(source, target, process.platform === "win32" ? "junction" : "dir");
  }
  const result = run(process.execPath, ["--max-old-space-size=8192", path.join(tree, "tools", "DatabaseCreator", "database-creator.js"),
    "--sde-dir", target, "--out", path.join(tree, "_local", "gameStore", "data"), "--build", build,
    "--sde-url", `https://developers.eveonline.com/static-data/tranquility/${name}.zip`, "--force"], { cwd: tree, timeoutMs: 1_800_000 });
  if (result.code !== 0) throw new CompatError(`the database creator failed:\n${result.out.split(/\r?\n/).slice(-10).join("\n")}`);
  return `built from ${fs.realpathSync(target)}: ${lastLine(result.out)}`;
}

// ---------- shared round trips ----------

function vendorInto(tree) {
  const result = run(process.execPath, [REPO_CLI, "vendor", "update", "--from", REPO_ROOT, "--tree", tree, "--force"], { cwd: REPO_ROOT });
  if (result.code !== 0) throw new CompatError(`vendor update failed:\n${result.out}`);
  return result.out.split(/\r?\n/)[0];
}

function doctorJSON(tree, args = []) {
  const out = cliIn(tree, ["doctor", "--json", ...args], { expect: null });
  const start = out.indexOf("{");
  const report = start >= 0 ? JSON.parse(out.slice(start)) : null;
  if (!report) throw new CompatError(`doctor printed no report:\n${out}`);
  return report;
}

function requireDoctor(report, { plugin = null, patches = {} } = {}) {
  const problems = [];
  if (!report.gateway.known) problems.push(`gateway unknown: ${report.gateway.error}`);
  else if (report.gateway.missing.length) problems.push(`refused calls: ${report.gateway.missing.map((call) => `${call.service}.${call.method}`).join(", ")}`);
  if (!report.destiny.ok) problems.push(`destiny: ${report.destiny.error}`);
  if (plugin && !report.plugins.active.includes(plugin)) problems.push(`plugin ${plugin} not active: ${JSON.stringify(report.plugins.skipped)}`);
  for (const [id, state] of Object.entries(patches)) {
    const row = report.patches.find((patch) => patch.id === id);
    if (!row || row.state !== state) problems.push(`patch ${id} is ${row ? row.state : "unknown"}, expected ${state}`);
  }
  if (problems.length) throw new CompatError(problems.join("; "));
  return `${report.gateway.calls.length} gateway calls allowed, client view on, ` +
    `patches ${report.patches.map((patch) => `${patch.id} ${patch.state}`).join(", ")}, ` +
    `plugins ${report.plugins.active.join(", ") || "none"} active`;
}

function treeTests(tree) {
  const result = runTests({ tree, stdio: "pipe" });
  const count = (label) => {
    const match = new RegExp(`ℹ ${label} (\\d+)`).exec(result.stdout);
    return match ? Number(match[1]) : null;
  };
  const summary = `${count("pass")} passed, ${count("fail")} failed, ${count("skipped")} skipped`;
  if (result.code !== 0) {
    const failures = result.stdout.split(/\r?\n/).filter((line) => /^not ok|^\s+not ok/.test(line)).slice(0, 10).join("\n");
    throw new CompatError(`${summary}\n${failures}`);
  }
  return summary;
}

function liveRoundTrips(lane, tree) {
  return [
    ["login", () => lastLine(cliIn(tree, ["login"]))],
    ["undock", () => lastLine(cliIn(tree, ["undock"]))],
    ["grid", () => {
      const out = cliIn(tree, ["grid"]);
      if (!/\(self\)/.test(out)) throw new CompatError(`no self row:\n${out}`);
      return out.split(/\r?\n/)[0];
    }],
    ["watch", () => {
      const out = cliIn(tree, ["watch", "--for", "10", "--every", "2"]);
      if (!/ START /.test(out) || !/ END /.test(out)) throw new CompatError(`no START and END:\n${out}`);
      if (/decode-error/.test(out)) throw new CompatError(`the client view hit decode errors:\n${out}`);
      return (out.split(/\r?\n/).find((line) => / END /.test(line)) || "").replace(/\s+/g, " ").trim();
    }],
  ].map(([name, fn]) => [`${name} (${lane})`, fn]);
}

async function compareFixtures(lane, tree, sections) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evejs-e2e-fixtures-"));
  try {
    const fresh = { destiny: captureDestiny({ tree, out: path.join(dir, "destiny.json") }), live: await captureLive({ tree }) };
    const differences = compareCaptures(committedFixtures(), fresh, { sections });
    if (differences.length) {
      throw new CompatError(`the committed fixtures no longer match this tree (npm run fixtures:capture -- --tree ${tree}):\n` +
        differences.slice(0, 20).join("\n"));
    }
    return `${Object.keys(fresh.destiny.encodings).length} destiny encodings and the ${sections.filter((part) => part !== "destiny").join(" and ")} shape match`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function runScenario(tree, args) {
  const out = cliIn(tree, ["run", "smoke-undock", ...args]);
  const verdict = out.split(/\r?\n/).find((line) => /^(passed|FAILED|did not complete):/.test(line));
  if (!verdict || !verdict.startsWith("passed")) throw new CompatError(out.split(/\r?\n/).slice(-12).join("\n"));
  return verdict;
}

// ---------- attach mode: a server started by hand ----------

async function startByHand(tree) {
  const config = require("../core/treeConfig").loadTreeConfig(tree, { env: {} });
  const { portsForTree, serverEnvironment } = require("../core/ports");
  // The tree's own port block, so a server the user runs on the stock ports is left alone.
  const ports = portsForTree(tree, {});
  fs.rmSync(config.handshake, { force: true });
  fs.mkdirSync(config.e2eDir, { recursive: true });
  const out = fs.openSync(path.join(config.e2eDir, "attach-server.out.log"), "w");
  const env = { ...process.env, ...serverEnvironment(ports), EVEJS_AGENT_BRIDGE: "1", EVEJS_GAMESTORE_DATA_DIR: config.dataDir };
  delete env.EVEJS_AGENT_BRIDGE_HANDSHAKE;
  const child = spawn(process.execPath, config.start.slice(1), { cwd: config.serverDir, env, detached: true,
    stdio: ["ignore", out, out], windowsHide: true });
  child.unref();
  fs.closeSync(out);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 600_000) {
    if (!pidAlive(child.pid)) throw new CompatError(`the server exited during boot (${path.join(config.e2eDir, "attach-server.out.log")})`);
    const handshake = readJSON(config.handshake);
    if (handshake && handshake.pid === child.pid && handshake.ports && await tcpOpen(handshake.ports.game)) {
      return { pid: child.pid, handshake, text: `pid ${child.pid} ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s, ` +
        `game :${handshake.ports.game}, gateway :${handshake.ports.gateway}` };
    }
    await sleep(2000);
  }
  throw new CompatError(`pid ${child.pid} not ready after 600s`);
}

async function stopByHand(server) {
  if (!server || !pidAlive(server.pid)) return "not running";
  try {
    await fetch(`http://127.0.0.1:${server.handshake.port}/shutdown`, { method: "POST",
      headers: { authorization: `Bearer ${server.handshake.token}` }, signal: AbortSignal.timeout(10_000) });
  } catch (_error) {
    // Checked below.
  }
  for (let waited = 0; waited < 120_000; waited += 500) {
    if (!pidAlive(server.pid)) return `pid ${server.pid} stopped`;
    await sleep(500);
  }
  process.kill(server.pid);
  throw new CompatError(`pid ${server.pid} ignored /shutdown for 120s and was killed`);
}

// ---------- the lanes ----------

async function stockLane(flags, context) {
  const lane = "stock";
  let tree = null;
  if (!await check(lane, "unpack", () => {
    const found = stockTree(flags.stock, flags.scratch);
    tree = found.tree;
    context.trees.push({ lane, text: found.text });
    return found.text;
  })) return;
  if (!await check(lane, "dependencies", () => installDependencies(tree))) return;
  if (!await check(lane, "reference data", () => buildReferenceData(tree, flags))) return;
  if (!await check(lane, "vendor this checkout", () => vendorInto(tree))) return;
  await check(lane, "tests against the tree", () => treeTests(tree));

  await check(lane, "init (managed)", () => lastLine(cliIn(tree, ["init", "--mode", "managed", "--force"])));
  await check(lane, "doctor (files)", () => requireDoctor(doctorJSON(tree, ["--offline"]), {
    patches: { "xmpp-port": "absent", "last-decision": "absent" } }));
  if (await check(lane, "up --fresh (managed)", () => lastLine(cliIn(tree, ["up", "--fresh"])))) {
    try {
      for (const [name, fn] of liveRoundTrips("managed", tree)) await check(lane, name, fn);
      await check(lane, "doctor (live)", () => {
        const report = doctorJSON(tree);
        if (!report.live) throw new CompatError("doctor didn't reach the running server");
        if (report.live.session && !report.live.session.gatewayClientID) throw new CompatError("the session isn't a gateway session");
        return requireDoctor(report);
      });
      await check(lane, "fixtures match a live capture", () => compareFixtures(lane, tree, ["destiny", "session", "grid"]));
    } finally {
      await check(lane, "down (managed)", () => lastLine(cliIn(tree, ["down"])));
    }
  }
  await check(lane, "run smoke-undock (managed)", () => runScenario(tree, []));

  await check(lane, "init (attach)", () => lastLine(cliIn(tree, ["init", "--mode", "attach", "--force"])));
  await check(lane, "up refuses (attach)", () => lastLine(cliIn(tree, ["up"], { expect: 1 })));
  // A new world, so the character starts docked and smoke-undock's protection check holds.
  require("../core/worlds").freshWorld(tree);
  let server = null;
  if (await check(lane, "server started by hand (attach)", async () => {
    server = await startByHand(tree);
    return server.text;
  })) {
    try {
      for (const [name, fn] of liveRoundTrips("attach", tree)) {
        if (!name.startsWith("watch")) await check(lane, name, fn);
      }
      await check(lane, "dock (attach)", () => lastLine(cliIn(tree, ["dock"], { expect: null })));
      await check(lane, "run smoke-undock (attach)", () => runScenario(tree, []));
    } finally {
      await check(lane, "server stopped (attach)", () => stopByHand(server));
    }
  }
}

function luVendoredClean(tree) {
  const status = git(tree, ["status", "--porcelain", "--", ...VENDORED_PATHS, "e2e.config.json"]);
  if (status.code !== 0) throw new CompatError(`git status failed in ${tree}: ${status.out}`);
  return status.out.trim();
}

async function luLane(flags, context) {
  const lane = "lu";
  const tree = path.resolve(flags.lu);
  const head = git(tree, ["rev-parse", "--short=12", "HEAD"]).out;
  const branch = git(tree, ["rev-parse", "--abbrev-ref", "HEAD"]).out;
  context.trees.push({ lane, text: `${tree} on ${branch} at ${head}` });
  const dirty = luVendoredClean(tree);
  if (dirty) {
    skip(lane, "all", `the tree has changes to its vendored copy or config; commit or discard them first:\n${dirty}`);
    return;
  }
  const configFile = path.join(tree, "e2e.config.json");
  const hadConfig = fs.existsSync(configFile);
  try {
    if (!await check(lane, "vendor this checkout", () => vendorInto(tree))) return;
    if (!hadConfig) await check(lane, "init (managed)", () => lastLine(cliIn(tree, ["init", "--mode", "managed"])));
    const mode = (readJSON(configFile) || {}).mode;
    await check(lane, "doctor (files)", () => requireDoctor(doctorJSON(tree, ["--offline"]), {
      plugin: "lu", patches: { "xmpp-port": "detected", "last-decision": "detected" } }));
    await check(lane, "tests against the tree", () => treeTests(tree));
    if (mode !== "managed") {
      skip(lane, "live checks", `the tree's e2e.config.json is in ${mode} mode`);
      return;
    }
    const worlds = require("../core/worlds").listWorlds(tree).map((row) => row.name);
    if (!worlds.includes(LU_WORLD)) {
      skip(lane, "live checks", `no saved world ${LU_WORLD} in the tree (saved: ${worlds.join(", ") || "none"})`);
      return;
    }
    if (await check(lane, `up --world ${LU_WORLD} (managed)`, () => lastLine(cliIn(tree, ["up", "--world", LU_WORLD])))) {
      try {
        for (const [name, fn] of liveRoundTrips("managed", tree)) await check(lane, name, fn);
        await check(lane, "doctor (live)", () => requireDoctor(doctorJSON(tree), { plugin: "lu" }));
        // Another world than the fixtures' stock one: only the encodings and the session must match.
        await check(lane, "fixtures match a live capture", () => compareFixtures(lane, tree, ["destiny", "session"]));
      } finally {
        await check(lane, "down (managed)", () => lastLine(cliIn(tree, ["down"])));
      }
    }
    await check(lane, `run smoke-undock --world ${LU_WORLD} (managed)`, () => runScenario(tree, ["--world", LU_WORLD]));
  } finally {
    if (flags.keepLu) {
      notes.push(`--keep-lu: ${tree} keeps this checkout's vendored copy${hadConfig ? "" : " and the e2e.config.json compat wrote"}`);
    } else {
      git(tree, ["checkout", "--", ...VENDORED_PATHS]);
      git(tree, ["clean", "-fdq", "--", "tools/evejs-e2e"]);
      if (!hadConfig) fs.rmSync(configFile, { force: true });
      const left = luVendoredClean(tree);
      if (left) notes.push(`restoring ${tree} left changes: ${left}`);
      else notes.push(`${tree}'s vendored copy is back as committed`);
    }
  }
}

// ---------- main ----------

function parseArgs(argv) {
  const flags = { stock: null, lu: null, scratch: DEFAULT_SCRATCH, sde: null, only: null, keepLu: false,
    report: path.join(REPO_ROOT, "compat-report.md") };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = () => {
      const next = argv[index + 1];
      if (!next || next.startsWith("--")) throw new CompatError(`${token} needs a value`);
      index += 1;
      return next;
    };
    if (token === "--stock") flags.stock = path.resolve(value());
    else if (token === "--lu") flags.lu = path.resolve(value());
    else if (token === "--scratch") flags.scratch = path.resolve(value());
    else if (token === "--sde") flags.sde = path.resolve(value());
    else if (token === "--only") flags.only = value();
    else if (token === "--report") flags.report = path.resolve(value());
    else if (token === "--keep-lu") flags.keepLu = true;
    else throw new CompatError(`unknown argument ${token}`);
  }
  if (flags.only && !["stock", "lu"].includes(flags.only)) throw new CompatError("--only takes stock or lu");
  if ((!flags.only || flags.only === "stock") && !flags.stock) throw new CompatError("--stock <zip or folder> is required");
  if ((!flags.only || flags.only === "lu") && !flags.lu) throw new CompatError("--lu <tree> is required");
  if (flags.stock && !fs.existsSync(flags.stock)) throw new CompatError(`no ${flags.stock}`);
  if (flags.lu && !fs.existsSync(path.join(flags.lu, "server", "src"))) throw new CompatError(`${flags.lu} is not an EveJS tree`);
  return flags;
}

async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv);
  const head = git(REPO_ROOT, ["rev-parse", "--short=12", "HEAD"]).out;
  const dirty = git(REPO_ROOT, ["status", "--porcelain"]).out.trim();
  const context = { startedAtMs: Date.now(), commit: `${head}${dirty ? " plus uncommitted changes (trees get HEAD; the tests ran on the working files)" : ""}`, trees: [] };
  if (dirty) notes.push("the checkout has uncommitted changes: the trees ran HEAD, the tests the working files");
  process.stdout.write(`compat: evejs-e2e ${context.commit}\n`);
  await check("repo", "npm test (no tree)", () => treeTests(null));
  if (!flags.only || flags.only === "stock") await stockLane(flags, context);
  if (!flags.only || flags.only === "lu") await luLane(flags, context);
  writeReport(flags.report, context);
  const failed = rows.filter((row) => row.result === "FAIL").length;
  process.stdout.write(`${failed ? `red: ${failed} failed` : "green"}; report ${flags.report}\n`);
  return failed ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    console.error(`compat: ${error instanceof CompatError ? error.message : error.stack}`);
    process.exitCode = 2;
  });
}

module.exports = { compareCaptures, parseArgs };
