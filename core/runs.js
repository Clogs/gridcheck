"use strict";

// A tree's runs as the agents read them: whether one is still going, its
// verdict, its report by section, the markdown to cite it in a PR, and runs
// started in the background. The MCP tools report and run_scenario
// { wait: false }, and the CLI's `report` and `run --detach`, all use this,
// each naming its own commands in the text. Guide: docs/GUIDE.md "Runs".

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const { formatOffset, formatTimelineEvent } = require("./timeline");
const { TREE_SCENARIO_DIR } = require("./scenario");

const OUTPUT_LIMIT = 20_000;
const REPORT_SECTIONS = Object.freeze(["summary", "full", "result", "pr"]);

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_error) {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  } catch (_error) {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

// Same form as the CLI's run IDs.
function runStamp(ms) {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
}

function safeRunID(text) {
  return String(text).replace(/[^A-Za-z0-9._-]/g, "_");
}

function clip(text, limit = OUTPUT_LIMIT, where = "") {
  if (text.length <= limit) return text;
  const head = Math.floor(limit * 0.3);
  return `${text.slice(0, head)}\n... ${text.length - limit} characters cut` +
    `${where ? `; the full text is in ${where}` : ""} ...\n${text.slice(-(limit - head))}`;
}

function tailLines(text, count) {
  return String(text || "").trimEnd().split("\n").slice(-count).join("\n");
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function verdictOf(result) {
  if (!result) return null;
  return result.failure ? "DID NOT COMPLETE" : result.exitCode === 1 ? "FAILED" : "PASSED";
}

// report.md split at its "## " headings.
function reportSections(text) {
  const sections = { head: [] };
  let current = "head";
  for (const line of text.split("\n")) {
    if (line.startsWith("## ")) {
      current = line.slice(3).trim();
      sections[current] = [];
    }
    sections[current].push(line);
  }
  return Object.fromEntries(Object.entries(sections).map(([key, lines]) => [key, lines.join("\n").trim()]));
}

function reportSummary(report) {
  const index = report.indexOf("\n## Timeline");
  return index >= 0 ? `${report.slice(0, index).trimEnd()}\n\n(The timeline is left out; section "full" has it.)` : report;
}

function frameWhy(frame) {
  return `${frame.reason}${frame.stop && frame.reason !== "stop" ? " + stop" : ""}`;
}

// How each surface names its commands in the texts below.
const SURFACES = {
  mcp: {
    waitAgain: () => "Call report again with waitSeconds to wait for it.",
    saveHint: "(run_scenario with save: true)",
    detached: (runID, maxWait) => `Call report with run "${runID}" and waitSeconds (up to ${maxWait}) to wait for it and read the verdict.`,
  },
  cli: {
    waitAgain: (runID) => `\`gridcheck report ${runID} --wait 600\` waits for it.`,
    saveHint: "(move its file into tools/gridcheck-scenarios/)",
    detached: (runID) => `\`gridcheck report ${runID} --wait 600\` waits for it and prints the verdict.`,
  },
};

// treeRoot, runsDir, e2eDir: the tree's (core/treeConfig.js). surface: "mcp" or "cli".
function createRuns({ treeRoot, runsDir, e2eDir, surface = "mcp" }) {
  const say = SURFACES[surface] || SURFACES.mcp;
  const backgroundDir = path.join(e2eDir, "background");
  const relativePath = (file) => path.relative(treeRoot, file).split(path.sep).join("/");

  const backgroundRecord = (runID) => readJSON(path.join(backgroundDir, `${runID}.json`));

  function runState(runID) {
    const dir = path.join(runsDir, runID);
    const result = readJSON(path.join(dir, "result.json"));
    const background = backgroundRecord(runID);
    return {
      runID,
      dir,
      exists: fs.existsSync(dir),
      result,
      background,
      running: !result && Boolean(background && pidAlive(background.pid)),
      hasTimeline: fs.existsSync(path.join(dir, "timeline.jsonl")),
    };
  }

  function recentRuns(limit = 15) {
    let names = [];
    try {
      names = fs.readdirSync(runsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (_error) {
      return [];
    }
    return names
      .map((name) => ({ name, mtimeMs: fs.statSync(path.join(runsDir, name)).mtimeMs }))
      .sort((left, right) => right.mtimeMs - left.mtimeMs)
      .slice(0, limit)
      .map(({ name, mtimeMs }) => {
        const state = runState(name);
        const met = state.result ? state.result.expectations.filter((row) => row.met).length : 0;
        const what = state.result
          ? `${verdictOf(state.result)} ${met}/${state.result.expectations.length}  ${state.result.name}`
          : state.running ? "running"
            : state.hasTimeline ? "watch, no report" : "no timeline";
        return { name, mtimeMs, text: `${new Date(mtimeMs).toISOString().slice(0, 16)}  ${name.padEnd(36)} ${what}` };
      });
  }

  function frameLines(state) {
    const frames = (state.result && Array.isArray(state.result.frames)) ? state.result.frames : [];
    if (!frames.length) return [];
    return [`- frames (SVG; render a PNG with headless Chrome, see the guide):`,
      ...frames.map((frame) => `  - ${path.join(state.dir, frame.file)}  ${frameWhy(frame)}`)];
  }

  function filesBlock(state) {
    return [
      "Files:",
      `- report: ${path.join(state.dir, "report.md")}`,
      `- result: ${path.join(state.dir, "result.json")}`,
      `- timeline: ${path.join(state.dir, "timeline.jsonl")}`,
      ...frameLines(state),
    ].join("\n");
  }

  // A scenario committed with the tree or the tool, which a reviewer can rerun by name.
  function committedScenario(scenarioFile) {
    const file = String(scenarioFile || "");
    return file.startsWith(`${relativePath(TREE_SCENARIO_DIR)}/`) || file.startsWith("tools/gridcheck/scenarios/") ||
      /^tools\/gridcheck\/plugins\/[^/]+\/scenarios\//.test(file);
  }

  // Markdown to paste into a PR description: what ran, on what, and what was
  // seen. Frame links in report.md are relative to the run dir, so they are
  // listed as files to attach instead.
  function prCitation(state, report) {
    const result = state.result;
    const sections = reportSections(report);
    const verdictLine = sections.head.split("\n").find((line) => /expectations met\./.test(line)) || "";
    const scenarioFile = String(result.scenarioFile || "");
    const inTree = committedScenario(scenarioFile);
    const reproduce = inTree ? path.basename(scenarioFile, ".json") : scenarioFile || result.name;
    const commit = result.commit
      ? `\`${result.commit.sha}\`${result.commit.dirty ? " plus uncommitted changes" : ""}`
      : "(commit not recorded: run before the CLI recorded it)";
    const seconds = Math.round((result.stoppedAtMs - result.startedAtMs) / 1000);
    const frames = (Array.isArray(result.frames) ? result.frames : []);
    const lines = [
      `### End-to-end check \`${result.name}\`: ${verdictOf(result)}`,
      "",
      `Run \`${state.runID}\` of \`${scenarioFile || result.name}\` on commit ${commit}, ` +
        `from world \`${result.world}\`, ${seconds} s including boot and shutdown.`,
      "",
      verdictLine,
      "",
    ];
    if (sections["Expected against observed"]) lines.push(sections["Expected against observed"].replace(/^## /, "#### "), "");
    if (frames.length) {
      lines.push("#### Tactical frames", "");
      lines.push("| t | Why | Frame |", "| --- | --- | --- |");
      for (const frame of frames) {
        lines.push(`| ${formatOffset(frame.t || 0)} | ${frameWhy(frame)} | ${path.basename(frame.file)} (attached) |`);
      }
      lines.push("");
    }
    lines.push(`Reproduce: \`node tools/gridcheck/bin/gridcheck.js run ${reproduce}\`.`);
    const attach = frames.map((frame) => path.join(state.dir, frame.file));
    return [
      lines.join("\n"),
      "",
      "---",
      ...(inTree ? [] : [`The scenario is not in tools/gridcheck-scenarios/, so a reviewer can't rerun it. Save it there ` +
        `${say.saveHint} and commit it with the feature.`]),
      `Paste the markdown above. Attach these, or PNGs rendered from them, so reviewers see the frames:`,
      ...(attach.length ? attach.map((file) => `- ${file}`) : ["- (no frames in this run)"]),
      `Full report: ${path.join(state.dir, "report.md")}. _local/ is not committed, so don't link into it.`,
    ].join("\n");
  }

  function lastTimelineLines(state, count = 60) {
    const text = readText(path.join(state.dir, "timeline.jsonl")) || "";
    const events = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.kind !== "POS") events.push(event);
      } catch (_error) {
        // A line cut off by a watch still writing.
      }
    }
    return events.slice(-count).map((event) => formatTimelineEvent(event)).join("\n");
  }

  function describeRunning(state) {
    const background = state.background;
    const log = readText(path.join(treeRoot, background.log)) || "";
    const seconds = Math.round((Date.now() - background.startedAtMs) / 1000);
    return `run ${state.runID} is still running (pid ${background.pid}, ${seconds} s so far). ` +
      `${say.waitAgain(state.runID)}\nLast lines of its console (${background.log}):\n` +
      tailLines(log, 30);
  }

  // Starts `node <cli> <args>` detached, its console in the background dir.
  // -> { pid, log } with log relative to the tree.
  function startBackground({ cliPath, args, runID, scenarioFile }) {
    fs.mkdirSync(backgroundDir, { recursive: true });
    const logPath = path.join(backgroundDir, `${runID}.log`);
    const out = fs.openSync(logPath, "w");
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: treeRoot,
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
    });
    child.unref();
    fs.closeSync(out);
    fs.writeFileSync(path.join(backgroundDir, `${runID}.json`), `${JSON.stringify({
      runID, pid: child.pid, startedAtMs: Date.now(), scenario: scenarioFile, log: relativePath(logPath), args,
    }, null, 2)}\n`);
    return { pid: child.pid, log: relativePath(logPath) };
  }

  // -> { text, isError }. run: an ID, "latest", or empty for the recent runs.
  // waitSeconds: how long to wait for a run still going in the background.
  async function readReport({ run, section = "summary", waitSeconds = 0, signal = null, onLine = () => {} } = {}) {
    if (!REPORT_SECTIONS.includes(section)) {
      return { text: `section: one of ${REPORT_SECTIONS.join(", ")}`, isError: true };
    }
    if (!run) {
      const runs = recentRuns(15);
      return { text: runs.length ? `Recent runs, newest first:\n${runs.map((row) => row.text).join("\n")}` : "no runs yet", isError: false };
    }
    const runID = run === "latest" ? (recentRuns(1)[0] || {}).name : safeRunID(run);
    if (!runID) return { text: "no runs yet", isError: true };
    let state = runState(runID);
    const deadline = Date.now() + Math.max(0, Number(waitSeconds) || 0) * 1000;
    let lastLine = "";
    while (state.running && Date.now() < deadline && !(signal && signal.aborted)) {
      await sleep(2000, signal);
      const line = tailLines(readText(path.join(treeRoot, state.background.log)) || "", 1);
      if (line && line !== lastLine) onLine(line);
      lastLine = line;
      state = runState(runID);
    }
    if (state.running) return { text: describeRunning(state), isError: false, running: true };
    if (!state.result) {
      if (state.background) {
        const log = readText(path.join(treeRoot, state.background.log)) || "";
        return { text: `run ${runID} ended without a report. Last lines of its console (${state.background.log}):\n` +
          tailLines(log, 40), isError: true };
      }
      if (state.hasTimeline) {
        return { text: `${runID} is a watch with no report. Last timeline lines:\n${lastTimelineLines(state)}\n\n` +
          `Timeline: ${path.join(state.dir, "timeline.jsonl")}`, isError: false };
      }
      const runs = recentRuns(10);
      return { text: `no run ${runID}. Recent runs:\n${runs.map((row) => row.text).join("\n")}`, isError: true };
    }
    const reportPath = path.join(state.dir, "report.md");
    const report = readText(reportPath) || "";
    const result = { isError: false, exitCode: state.result.exitCode };
    switch (section) {
      case "full": return { ...result, text: clip(report, OUTPUT_LIMIT, reportPath) };
      case "result": return { ...result, text: clip(JSON.stringify(state.result, null, 2)) };
      case "pr": return { ...result, text: prCitation(state, report) };
      default: return { ...result, text: `${clip(reportSummary(report))}\n\n${filesBlock(state)}` };
    }
  }

  return {
    backgroundDir, runState, recentRuns, filesBlock, committedScenario, prCitation, describeRunning,
    startBackground, readReport, detachedText: say.detached,
  };
}

module.exports = {
  OUTPUT_LIMIT, REPORT_SECTIONS, createRuns, clip, readText, reportSections, reportSummary, runStamp, safeRunID,
  sleep, tailLines, verdictOf,
};
