"use strict";

// The page `e2e gui` serves (core/gui.js). It builds every element with
// textContent, never HTML, so nothing a run or a tree contains can run here.
// Every change goes through the preview dialog: the server runs the CLI
// command with --dry-run, the dialog shows its output, and Run asks the server
// to run that same command by the preview's ID.

(() => {
  const $ = (id) => document.getElementById(id);

  // The token arrives in the fragment once, then lives in this tab only.
  const params = new URLSearchParams(location.hash.slice(1));
  const token = params.get("token") || sessionStorage.getItem("e2eGuiToken") || "";
  if (params.get("token")) sessionStorage.setItem("e2eGuiToken", token);

  const state = {
    context: null,
    trees: [],
    treeID: params.get("tree") || null,
    tab: params.get("tab") || "runs",
    runID: params.get("run") || null,
    tree: null,
    preview: null,
    afterRun: null,
    blobs: [],
  };

  // ---------- helpers ----------

  function h(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "text") node.textContent = String(value);
      else if (key === "className") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? "" : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function message(text, ok = false) {
    $("message").textContent = text || "";
    $("message").className = ok ? "ok" : "";
  }

  async function api(route, { method = "GET", body } = {}) {
    const response = await fetch(route, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok || json.ok === false) throw new Error(json.error || `HTTP ${response.status}`);
    return json;
  }

  async function blobURL(route) {
    const response = await fetch(route, { headers: { authorization: `Bearer ${token}` }, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const url = URL.createObjectURL(await response.blob());
    state.blobs.push(url);
    return url;
  }

  function freeBlobs() {
    for (const url of state.blobs) URL.revokeObjectURL(url);
    state.blobs = [];
  }

  const q = (value) => encodeURIComponent(value);
  const short = (commit) => (commit ? String(commit).slice(0, 8) : "?");

  function saveHash() {
    const parts = [`tab=${q(state.tab)}`];
    if (state.treeID) parts.push(`tree=${q(state.treeID)}`);
    if (state.runID && state.tab === "runs") parts.push(`run=${q(state.runID)}`);
    history.replaceState(null, "", `#${parts.join("&")}`);
  }

  function ago(ms) {
    if (!Number.isFinite(ms)) return "";
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 90) return `${s} s ago`;
    if (s < 5400) return `${Math.round(s / 60)} min ago`;
    if (s < 129600) return `${Math.round(s / 3600)} h ago`;
    return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  }

  function verdict(result) {
    if (!result) return { text: "no result", className: "" };
    if (result.exitCode === 2) return { text: "did not complete", className: "warn" };
    return result.passed ? { text: "passed", className: "passed" } : { text: "failed", className: "failed" };
  }

  // ---------- trees and tabs ----------

  async function loadContext() {
    const body = await api("/gui/api/context");
    state.context = body.context;
    const c = state.context;
    $("context").textContent = c.mode === "vendored"
      ? `vendored copy ${c.version || "?"} at ${short(c.commit)}, managing ${c.tree}`
      : `checkout ${c.root}, ${c.version || "?"} at ${short(c.commit)}${c.dirty ? " (uncommitted changes aren't vendored)" : ""}`;
  }

  async function loadTrees() {
    const body = await api("/gui/api/trees");
    state.trees = body.trees || [];
    if (!state.trees.some((tree) => tree.id === state.treeID)) {
      state.treeID = (state.trees.find((tree) => tree.copy) || state.trees[0] || {}).id || null;
    }
    const select = $("tree");
    select.textContent = "";
    for (const tree of state.trees) {
      select.append(h("option", { value: tree.id, text: `${tree.name}  (${tree.root})` }));
    }
    if (state.treeID) select.value = state.treeID;
    renderTreeBadges();
    renderTreeCards();
  }

  function currentTree() {
    return state.trees.find((tree) => tree.id === state.treeID) || null;
  }

  function renderTreeBadges() {
    const box = $("tree-badges");
    box.textContent = "";
    const tree = currentTree();
    if (!tree) return;
    box.append(tree.copy ? h("span", { className: "badge ok", text: `e2e ${tree.copy.version || "?"} at ${short(tree.copy.commit)}` })
      : h("span", { className: "badge warn", text: "not installed" }));
    if (tree.mode) box.append(" ", h("span", { className: "badge", text: tree.mode }));
    if (tree.up) box.append(" ", h("span", { className: "badge warn", text: "server up" }));
  }

  function selectTree(id) {
    state.treeID = id;
    state.runID = null;
    $("tree").value = id;
    renderTreeBadges();
    renderTreeCards();
    saveHash();
    showTab(state.tab);
  }

  function showTab(tab) {
    state.tab = ["runs", "install", "patches"].includes(tab) ? tab : "runs";
    for (const button of document.querySelectorAll("#tabs button")) {
      button.setAttribute("aria-selected", String(button.dataset.tab === state.tab));
    }
    for (const section of document.querySelectorAll("section.tab")) section.hidden = section.id !== `tab-${state.tab}`;
    saveHash();
    if (!state.treeID) {
      message(state.tab === "install" ? "" : "add a tree on the Install tab");
      if (state.tab === "install") renderInstall(null);
      return;
    }
    const load = state.tab === "runs" ? loadRuns : state.tab === "install" ? loadInstall : loadPatches;
    load().catch((error) => message(error.message));
  }

  // ---------- Runs ----------

  async function loadRuns() {
    const tree = currentTree();
    const body = await api(`/gui/api/runs?tree=${q(state.treeID)}`);
    $("runs-where").textContent = tree ? `${body.runs.length}${body.more ? `+${body.more}` : ""} run(s) in ${tree.root}` : "";
    const tbody = $("runs").querySelector("tbody");
    tbody.textContent = "";
    $("runs-empty").hidden = body.runs.length > 0;
    for (const run of body.runs) {
      const v = verdict(run.result);
      const row = h("tr", { "data-run": run.runID, onclick: () => openRun(run.runID) },
        h("td", {}, h("div", { className: "run-id", text: run.runID })),
        h("td", {}, h("span", { className: `badge ${v.className}`, text: v.text })),
        h("td", { text: run.result ? `${run.result.expectations - run.result.missing} of ${run.result.expectations}` : "" }),
        h("td", { className: "muted", text: ago(run.mtimeMs) }));
      if (run.runID === state.runID) row.classList.add("selected");
      tbody.append(row);
    }
    if (state.runID && body.runs.some((run) => run.runID === state.runID) && $("run-detail").dataset.run !== state.runID) {
      await openRun(state.runID);
    } else if (!state.runID) {
      $("run-detail").hidden = true;
      $("run-empty").hidden = false;
    }
  }

  async function openRun(runID) {
    state.runID = runID;
    saveHash();
    for (const row of $("runs").querySelectorAll("tbody tr")) row.classList.toggle("selected", row.dataset.run === runID);
    const body = await api(`/gui/api/run?tree=${q(state.treeID)}&run=${q(runID)}`);
    freeBlobs();
    $("run-empty").hidden = true;
    $("run-detail").hidden = false;
    $("run-detail").dataset.run = runID;
    const result = body.result;
    const v = verdict(result && { passed: result.passed === true, exitCode: result.exitCode });
    $("run-title").textContent = (result && result.name) || runID;
    $("run-verdict").textContent = v.text;
    $("run-verdict").className = `badge ${v.className}`;
    $("run-dir").textContent = body.dir;
    const replay = $("run-replay");
    replay.hidden = !body.hasTimeline;
    replay.href = `/viewer#token=${q(token)}&tree=${q(state.treeID)}&run=${q(runID)}`;
    const frames = $("run-frames");
    frames.textContent = "";
    if (!body.frames.length) frames.append(h("p", { className: "muted", text: "No frames: the run has no position samples." }));
    for (const file of body.frames) {
      const img = h("img", { alt: file, loading: "lazy" });
      const figure = h("figure", { onclick: () => showFrame(img.src, file) }, img, h("figcaption", { text: file }));
      frames.append(figure);
      frameURL(runID, file).then((url) => { img.src = url; }).catch((error) => { figure.append(h("span", { className: "muted", text: error.message })); });
    }
    const report = $("run-report");
    report.textContent = "";
    if (body.report === null) report.append(h("p", { className: "muted", text: "No report.md: the run didn't finish writing one." }));
    else renderMarkdown(body.report, report, runID);
  }

  function frameURL(runID, file) {
    return blobURL(`/gui/api/frame?tree=${q(state.treeID)}&run=${q(runID)}&file=${q(file)}`);
  }

  function showFrame(src, file) {
    if (!src) return;
    $("frame-image").src = src;
    $("frame-image").alt = file;
    $("frame-view").showModal();
  }

  // ---------- a small Markdown reader for report.md ----------

  const FRAME_LINK = /^frames\/([A-Za-z0-9][A-Za-z0-9._-]*\.svg)$/;

  function inline(text, runID) {
    const out = [];
    const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(!?\[[^\]]*\]\([^)\s]+\))/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > last) out.push(text.slice(last, match.index));
      const piece = match[0];
      if (match[1]) out.push(h("code", { text: piece.slice(1, -1) }));
      else if (match[2]) out.push(h("strong", { text: piece.slice(2, -2) }));
      else {
        const link = /^(!?)\[([^\]]*)\]\(([^)\s]+)\)$/.exec(piece);
        const frame = FRAME_LINK.exec(link[3]);
        if (frame && link[1]) {
          const img = h("img", { alt: link[2] });
          frameURL(runID, frame[1]).then((url) => { img.src = url; }).catch(() => {});
          img.addEventListener("click", () => showFrame(img.src, frame[1]));
          out.push(img);
        } else if (frame) {
          out.push(h("a", { text: link[2], title: link[3], onclick: () => frameURL(runID, frame[1]).then((url) => showFrame(url, frame[1])) }));
        } else {
          out.push(h("span", { title: link[3], text: link[2] }));
        }
      }
      last = match.index + piece.length;
    }
    if (last < text.length) out.push(text.slice(last));
    return out;
  }

  function tableCells(line) {
    const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    const cells = [];
    let cell = "";
    let inCode = false;
    for (const char of body) {
      if (char === "`") inCode = !inCode;
      if (char === "|" && !inCode) {
        cells.push(cell.trim());
        cell = "";
      } else {
        cell += char;
      }
    }
    cells.push(cell.trim());
    return cells;
  }

  function renderMarkdown(text, into, runID) {
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    let index = 0;
    let paragraph = [];
    const flush = () => {
      if (paragraph.length) into.append(h("p", {}, inline(paragraph.join(" "), runID)));
      paragraph = [];
    };
    while (index < lines.length) {
      const line = lines[index];
      if (/^```/.test(line)) {
        flush();
        const code = [];
        index += 1;
        while (index < lines.length && !/^```/.test(lines[index])) code.push(lines[index++]);
        into.append(h("pre", { text: code.join("\n") }));
        index += 1;
        continue;
      }
      const heading = /^(#{1,4})\s+(.*)$/.exec(line);
      if (heading) {
        flush();
        into.append(h(`h${heading[1].length}`, {}, inline(heading[2], runID)));
        index += 1;
        continue;
      }
      if (/^\s*\|/.test(line) && index + 1 < lines.length && /^\s*\|[\s|:-]+\|\s*$/.test(lines[index + 1])) {
        flush();
        const head = tableCells(line);
        const table = h("table", {}, h("thead", {}, h("tr", {}, head.map((cell) => h("th", {}, inline(cell, runID))))));
        const tbody = h("tbody");
        index += 2;
        while (index < lines.length && /^\s*\|/.test(lines[index])) {
          tbody.append(h("tr", {}, tableCells(lines[index]).map((cell) => h("td", {}, inline(cell, runID)))));
          index += 1;
        }
        table.append(tbody);
        into.append(table);
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        flush();
        const list = h("ul");
        while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
          list.append(h("li", {}, inline(lines[index].replace(/^\s*[-*]\s+/, ""), runID)));
          index += 1;
        }
        into.append(list);
        continue;
      }
      if (!line.trim()) flush();
      else paragraph.push(line.trim());
      index += 1;
    }
    flush();
  }

  // ---------- Install ----------

  function renderTreeCards() {
    const list = $("trees");
    list.textContent = "";
    if (!state.trees.length) {
      list.append(h("li", { className: "muted", text: state.context && state.context.mode === "checkout"
        ? "No trees yet. Add one by its path below: an unpacked EveJS zip, or a fork's checkout." : "No tree." }));
    }
    for (const tree of state.trees) {
      const item = h("li", { onclick: () => { state.tab = "install"; selectTree(tree.id); } },
        tree.source === "added" ? h("button", { type: "button", className: "forget", text: "Forget", title: "Take it off this list",
          onclick: (event) => { event.stopPropagation(); forgetTree(tree.id); } }) : null,
        h("strong", { text: tree.name }), " ",
        tree.copy ? h("span", { className: "badge ok", text: `${tree.copy.version || "?"} at ${short(tree.copy.commit)}` })
          : h("span", { className: "badge warn", text: tree.isTree ? "not installed" : "not a tree" }),
        tree.mode ? [" ", h("span", { className: "badge", text: tree.mode })] : null,
        tree.up ? [" ", h("span", { className: "badge warn", text: "server up" })] : null,
        h("div", { className: "path", text: tree.root }),
        h("div", { className: "muted", text: tree.source === "nearby" ? "found beside this checkout" : tree.source }));
      if (tree.id === state.treeID) item.classList.add("selected");
      list.append(item);
    }
  }

  async function addTree(event) {
    event.preventDefault();
    const input = $("add-path");
    try {
      const body = await api("/gui/api/trees", { method: "POST", body: { path: input.value } });
      input.value = "";
      await loadTrees();
      selectTree(body.tree.id);
      message(`added ${body.tree.root}`, true);
    } catch (error) {
      message(error.message);
    }
  }

  async function forgetTree(id) {
    try {
      await api("/gui/api/trees/forget", { method: "POST", body: { tree: id } });
      if (state.treeID === id) state.treeID = null;
      await loadTrees();
      showTab(state.tab);
    } catch (error) {
      message(error.message);
    }
  }

  async function loadInstall() {
    const body = await api(`/gui/api/tree?tree=${q(state.treeID)}`);
    state.tree = body.tree;
    renderInstall(state.tree);
    message("");
  }

  function checkItem(ok, text, extra) {
    return h("li", { className: ok === null ? "info" : ok ? "ok" : "bad" }, text, extra ? [" ", h("span", { className: "muted", text: extra })] : null);
  }

  function renderInstall(tree) {
    $("install-empty").hidden = Boolean(tree);
    $("install-detail").hidden = !tree;
    if (!tree) return;
    const vendoredGui = state.context.mode === "vendored";
    $("install-title").textContent = tree.name;
    $("install-root").textContent = `${tree.root}${tree.git === false ? " (not a git checkout, so uncommitted changes can't be checked)" : ""}`;

    const copy = tree.copy || {};
    let status;
    if (!copy.present) status = "Not installed. Install copies this checkout's committed files into tools/evejs-e2e/ and adds the shim.";
    else if (!copy.vendored) status = "tools/evejs-e2e/ exists but has no VENDOR.json, so it wasn't vendored. Installing replaces it (--force).";
    else {
      status = `${copy.version} at ${short(copy.commit)}. ${copy.ok ? "It matches its VENDOR.json." : `It differs from its VENDOR.json in ${copy.problemCount} place(s):`}`;
      if (!vendoredGui) status += copy.upToDate ? " Same commit as this checkout." : ` This checkout is at ${short(state.context.commit)}.`;
    }
    $("copy-status").textContent = status;
    const problems = $("copy-problems");
    problems.textContent = "";
    for (const row of copy.problems || []) problems.append(h("li", {}, h("code", { text: row.file }), ` ${row.problem}`));
    const needsForce = copy.present && (!copy.vendored || !copy.ok);
    $("copy-force-label").hidden = !needsForce;
    $("copy-force").checked = needsForce && !copy.vendored;
    $("copy-from-row").hidden = !vendoredGui;
    $("copy-preview").textContent = copy.present ? "Preview update" : "Preview install";
    $("copy-preview").disabled = !vendoredGui && copy.upToDate && copy.ok;
    $("copy-preview").title = $("copy-preview").disabled ? "Already this checkout's commit" : "";
    $("shim-status").textContent = { missing: "missing", edited: "edited since it was vendored", matches: "matches", present: "present" }[tree.shim] || tree.shim;

    const config = tree.config || {};
    $("config-status").textContent = !copy.present ? "Install the copy first."
      : config.exists ? `${config.file}, mode ${config.mode}. Runs go to ${config.runsDir}.`
        : `No ${config.file || "e2e.config.json"} yet. Managed mode lets e2e start the server, restore worlds and build recipes; ` +
          "attach mode uses a server you start.";
    const configProblems = $("config-problems");
    configProblems.textContent = "";
    for (const problem of config.problems || []) configProblems.append(h("li", { text: problem }));
    $("config-mode").value = config.exists ? config.mode : "managed";
    $("config-preview").disabled = !copy.present;
    $("config-preview").textContent = config.exists ? "Preview rewrite" : "Preview config";

    const prereqs = $("prereqs");
    prereqs.textContent = "";
    for (const row of tree.prerequisites || []) prereqs.append(checkItem(row.ok, row.name, row.ok ? null : row.fix));
    $("server-status").textContent = tree.serverUp ? `${tree.serverUp}. Changes wait until it stops.` : "The tree's server is down.";

    const plugins = $("plugins");
    plugins.textContent = "";
    for (const name of tree.plugins.active) plugins.append(checkItem(true, `plugin ${name}`, "active"));
    for (const row of tree.plugins.skipped) plugins.append(checkItem(null, `plugin ${row.name}`, `skipped: ${row.reason}`));
    $("doctor-run").disabled = !copy.present;

    const next = $("next-steps");
    next.textContent = "";
    const cli = "node tools/evejs-e2e/bin/e2e.js";
    if (!copy.present) next.append("Install the copy, then write the config.");
    else if (!config.exists) next.append("Write the config.");
    else if ((tree.prerequisites || []).some((row) => !row.ok)) next.append("Finish what the tree needs (above), then run e2e doctor.");
    else {
      next.append("Apply the patches you want on the Patches tab, then from the tree's folder:",
        h("pre", { text: config.mode === "managed"
          ? `${cli} world build starter\n${cli} run loadout-npc-fight\n${cli} help`
          : `(start the server with EVEJS_AGENT_BRIDGE=1 set)\n${cli} login\n${cli} run smoke-undock\n${cli} help` }),
        "Each run shows up on the Runs tab.");
    }
  }

  async function runDoctor() {
    const out = $("doctor-output");
    out.hidden = false;
    out.textContent = "running e2e doctor...";
    $("doctor-run").disabled = true;
    try {
      const body = await api(`/gui/api/doctor?tree=${q(state.treeID)}`);
      const doctor = body.doctor;
      $("doctor-command").textContent = `${doctor.command}  (in ${doctor.cwd})`;
      out.textContent = doctor.json ? formatDoctor(doctor.json) : doctor.output;
      if (doctor.json && doctor.json.plugins) {
        const plugins = $("plugins");
        plugins.textContent = "";
        for (const name of doctor.json.plugins.active) plugins.append(checkItem(true, `plugin ${name}`, "active (the tree's copy says)"));
        for (const row of doctor.json.plugins.skipped) plugins.append(checkItem(null, `plugin ${row.name}`, `skipped: ${row.reason}`));
      }
    } catch (error) {
      out.textContent = error.message;
    } finally {
      $("doctor-run").disabled = false;
    }
  }

  // The same lines `e2e doctor` prints, from its --json report.
  function formatDoctor(report) {
    const lines = [];
    const tool = report.tool || {};
    lines.push(`evejs-e2e  ${tool.version || "?"}${tool.commit ? ` at ${short(tool.commit)}` : ""}${tool.vendored ? " (vendored)" : " (checkout)"}`);
    const config = report.tree && report.tree.config;
    lines.push(`tree       ${report.tree ? report.tree.root : "?"}; ${config && config.exists ? `e2e.config.json, mode ${config.mode}` : "no e2e.config.json"}`);
    for (const problem of (config && config.problems) || []) lines.push(`           config problem: ${problem}`);
    lines.push(`checked    ${report.source || "?"}`);
    const gateway = report.gateway || {};
    if (!gateway.known) lines.push(`gateway    unknown: ${gateway.error}`);
    else if (!gateway.missing.length) lines.push(`gateway    all ${gateway.calls.length} calls the CLI makes are allowed`);
    else {
      lines.push(`gateway    ${gateway.missing.length} of ${gateway.calls.length} calls the CLI makes are refused:`);
      for (const call of gateway.missing) lines.push(`             ${call.service}.${call.method} (${call.usedBy})`);
    }
    const destiny = report.destiny || {};
    lines.push(destiny.ok ? `destiny    the decoder reads this tree's ball layout (${destiny.balls} probe balls); client view on`
      : `destiny    client view OFF: ${destiny.error}`);
    lines.push(`patches    ${(report.patches || []).map((patch) => `${patch.id} ${patch.state}${patch.version ? ` v${patch.version}` : ""}`).join(", ") || "none known"}`);
    const listeners = Object.entries(report.listeners || {});
    lines.push(listeners.length ? `listeners  move: ${listeners.filter(([, row]) => row.movable).map(([name]) => name).join(", ") || "none"}` +
      `${listeners.some(([, row]) => !row.movable) ? `; stay on stock ports: ${listeners.filter(([, row]) => !row.movable).map(([name]) => name).join(", ")}` : ""}`
      : "listeners  not probed yet (e2e init)");
    if (report.loadout) lines.push(report.loadout.ok ? "loadout    the stock ship helpers are there" : `loadout    OFF: ${report.loadout.missing.join("; ")}`);
    return lines.join("\n");
  }

  // ---------- Patches ----------

  async function loadPatches() {
    const tbody = $("patches").querySelector("tbody");
    const tree = currentTree();
    if (!tree || !tree.copy) {
      tbody.textContent = "";
      $("patches-empty").hidden = false;
      $("patches-empty").textContent = "Install the copy into this tree first (Install tab).";
      return;
    }
    $("patches-empty").hidden = true;
    const body = await api(`/gui/api/patches?tree=${q(state.treeID)}`);
    const patches = body.patches;
    $("patches-command").textContent = `${patches.command}  (in ${patches.cwd})`;
    tbody.textContent = "";
    if (!Array.isArray(patches.json)) {
      $("patches-empty").hidden = false;
      $("patches-empty").textContent = patches.output || "patch status printed nothing";
      return;
    }
    for (const row of patches.json) {
      const stateClass = row.state === "applied" || row.state === "detected" ? "ok" : row.state === "absent" ? "" : "bad";
      const why = row.state === "detected" ? "equivalent code is already there, so this tree doesn't need it"
        : row.state === "absent" && row.applies ? "applies cleanly"
          : row.problems ? row.problems.join("; ") : row.missing ? `${row.missing.join(", ")} not in this tree` : row.error || "";
      const actions = h("td");
      if (row.state === "absent") actions.append(h("button", { type: "button", text: "Preview apply", onclick: () => preview({ action: "patch-apply", id: row.id }) }));
      if (row.state === "applied") actions.append(h("button", { type: "button", text: "Preview revert", onclick: () => preview({ action: "patch-revert", id: row.id }) }));
      tbody.append(h("tr", {},
        h("td", {}, h("code", { text: row.id })),
        h("td", {}, h("span", { className: `badge ${stateClass}`, text: `${row.state}${row.version ? ` v${row.version}` : ""}` })),
        h("td", {}, row.title, why ? h("div", { className: "muted", text: why }) : null),
        actions));
    }
  }

  // ---------- preview and run ----------

  const ACTION_TITLES = { vendor: "Install or update the copy", init: "Write e2e.config.json", "patch-apply": "Apply a patch", "patch-revert": "Revert a patch" };

  async function preview(request) {
    const dialog = $("preview");
    $("preview-title").textContent = `${ACTION_TITLES[request.action] || request.action}${request.id ? `: ${request.id}` : ""}`;
    $("preview-refused").textContent = "";
    $("preview-steps").textContent = "";
    $("preview-note").textContent = "Running the command with --dry-run...";
    $("preview-run").disabled = true;
    $("preview-run").hidden = false;
    state.preview = null;
    if (!dialog.open) dialog.showModal();
    try {
      const body = await api("/gui/api/preview", { method: "POST", body: { tree: state.treeID, ...request } });
      const p = body.preview;
      for (const reason of p.refused) $("preview-refused").append(h("li", { text: reason }));
      for (const step of p.steps) {
        $("preview-steps").append(h("div", { className: "step-block" },
          h("div", { className: "command", text: step.command }),
          h("div", { className: "muted", text: `in ${step.cwd}. Its dry run (${step.dryRun}) ${step.exitCode === 0 ? "printed" : `exited ${step.exitCode}:`}` }),
          h("pre", { text: step.output.trim() || "(no output)" })));
      }
      $("preview-note").textContent = p.note;
      state.preview = p.ok ? p.previewID : null;
      $("preview-run").disabled = !p.ok;
    } catch (error) {
      $("preview-note").textContent = error.message;
    }
  }

  async function runPreview() {
    if (!state.preview) return;
    const id = state.preview;
    state.preview = null;
    $("preview-run").disabled = true;
    $("preview-note").textContent = "Running...";
    try {
      const body = await api("/gui/api/run", { method: "POST", body: { previewID: id } });
      const result = body.result;
      $("preview-steps").textContent = "";
      $("preview-refused").textContent = "";
      for (const reason of result.refused) $("preview-refused").append(h("li", { text: reason }));
      for (const step of result.steps) {
        $("preview-steps").append(h("div", { className: "step-block" },
          h("div", { className: "command", text: step.command }),
          h("div", { className: `exit ${step.exitCode === 0 ? "" : "muted"}`, text: `exit ${step.exitCode}, ${Math.round(step.ms / 100) / 10} s` }),
          h("pre", { text: step.output.trim() || "(no output)" })));
      }
      $("preview-note").textContent = result.ok ? "Done." : "It didn't finish; the output above says why.";
      $("preview-run").hidden = true;
      message(result.ok ? "done" : "the command failed", result.ok);
    } catch (error) {
      $("preview-note").textContent = error.message;
    }
    await loadTrees().catch(() => {});
    showTab(state.tab);
  }

  // ---------- start ----------

  function wire() {
    for (const button of document.querySelectorAll("#tabs button")) button.addEventListener("click", () => showTab(button.dataset.tab));
    $("tree").addEventListener("change", () => selectTree($("tree").value));
    $("runs-refresh").addEventListener("click", () => loadRuns().catch((error) => message(error.message)));
    $("install-refresh").addEventListener("click", () => loadInstall().catch((error) => message(error.message)));
    $("patches-refresh").addEventListener("click", () => loadPatches().catch((error) => message(error.message)));
    $("add-tree").addEventListener("submit", addTree);
    $("doctor-run").addEventListener("click", runDoctor);
    $("copy-preview").addEventListener("click", () => preview({ action: "vendor", force: $("copy-force").checked, from: $("copy-from").value }));
    $("config-preview").addEventListener("click", () => preview({ action: "init", mode: $("config-mode").value }));
    $("preview-run").addEventListener("click", runPreview);
    $("preview-close").addEventListener("click", () => $("preview").close());
    $("frame-close").addEventListener("click", () => $("frame-view").close());
  }

  async function start() {
    wire();
    if (!token) {
      message("no token: open the URL e2e gui prints");
      return;
    }
    try {
      await loadContext();
      await loadTrees();
    } catch (error) {
      message(error.message);
      return;
    }
    showTab(state.tab);
    setInterval(() => {
      if (state.tab === "runs" && state.treeID && !document.hidden && !$("preview").open) loadRuns().catch(() => {});
    }, 15_000);
  }

  start();
})();
