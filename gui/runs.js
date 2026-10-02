"use strict";

// The GUI's Runs tab (gui/index.html), in two views over the same run:
//
//   Workbench  a rail of runs grouped by scenario; the replay in the middle
//              (map, a compact event track, the event list); the run's
//              summary, expectations, frames, report and facts on the right.
//              Clicking an expectation, a frame or an event seeks the replay.
//   Trace      one timeline with a lane per ball: its modes as spans and its
//              locks, shots, hits and kills as marks, expectations as flags
//              and the frames as a filmstrip above. The map, the event at the
//              cursor and what diverged sit below and follow the cursor.
//
// The run's timeline comes from /viewer/timeline in chunks, live while a run
// writes it; gui/replay.js turns it into the model this file draws. Every
// element is built with textContent, never HTML. Positions go through
// element.style, which the page's CSP (style-src 'self') allows.

(() => {
  const R = window.E2EReplay;
  const SVG = "http://www.w3.org/2000/svg";
  const $ = (id) => document.getElementById(id);
  const LIVE_IDLE_MS = 30_000;
  const SHOT_MS = 4000;
  const FLASH_MS = 3000;
  const DIVERGE_MS = 10_000;
  const ZOOMS = [["auto", "auto"], ["5000", "5 km"], ["20000", "20 km"], ["50000", "50 km"], ["150000", "150 km"], ["500000", "500 km"]];
  const SPEEDS = [1, 4, 15, 60];
  const HISTORY = 8;
  const COLOURS = {
    self: "#6fc3ff", hostile: "#d4614e", drone: "#4fd1c5", concord: "#e0b341", player: "#57b87a", drifter: "#a48bf0",
    neutral: "#7d8b9a", weapon: "#f0a848", div: "#a48bf0", dim: "#5b6b7c",
    others: ["#e8845a", "#ef7fbf", "#9fd36b", "#5fa8d3", "#c79bf2", "#d8b46a"],
  };
  const ITABS = [["summary", "Summary"], ["expect", "Expectations"], ["perf", "Perf"], ["frames", "Frames"], ["report", "Report"], ["facts", "Facts"]];

  function el(name, attributes = {}) {
    const node = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attributes)) {
      if (value === undefined || value === null) continue;
      if (key === "className") node.setAttribute("class", value);
      else node.setAttribute(key, String(value));
    }
    return node;
  }

  function svgTitle(text) {
    const node = el("title");
    node.textContent = text;
    return node;
  }

  function niceLength(target) {
    if (!(target > 0)) return 1000;
    const power = 10 ** Math.floor(Math.log10(target));
    for (const step of [5, 2, 1]) if (step * power <= target) return step * power;
    return power;
  }

  function ago(ms, nowMs = Date.now()) {
    if (!Number.isFinite(ms)) return "";
    const s = Math.max(0, Math.round((nowMs - ms) / 1000));
    if (s < 90) return `${s} s`;
    if (s < 5400) return `${Math.round(s / 60)} min`;
    if (s < 129600) return `${Math.round(s / 3600)} h`;
    return `${Math.round(s / 86400)} d`;
  }

  function create(shell) {
    const { api, h } = shell;
    const q = encodeURIComponent;
    const state = {
      runs: [], nowMs: 0, runID: shell.params.get("run") || null, detail: null, model: R.createModel(),
      generation: 0, bytes: 0, result: null, mtimeMs: 0, runNowMs: 0, loading: false,
      at: null, playing: false, speed: 4, follow: true, zoom: "auto",
      off: new Set(["CLIENT", "PERF", "PROFILE"]), grep: null,
      view: ["workbench", "trace"].includes(shell.params.get("view")) ? shell.params.get("view") : (localStorage.getItem("e2eGuiView") || "workbench"),
      itab: ITABS.some(([id]) => id === shell.params.get("tab")) ? shell.params.get("tab") : "summary", selBall: null, selEvent: -1, win: null,
      openGroups: new Set(), closedGroups: new Set(), only: "all", filter: "",
      colourRules: [], palette: new Map(), current: -1, rows: [], frameURLs: new Map(),
      visible: false, treeKey: null, startT: Number(shell.params.get("t")),
    };
    if (!["workbench", "trace"].includes(state.view)) state.view = "workbench";

    // ---------- run list ----------

    const runName = (run) => (run.result && run.result.name) || run.runID.replace(/^\d{8}-\d{6}-/, "") || run.runID;
    const runStamp = (run) => (/^(\d{8}-\d{6})/.exec(run.runID) || [run.runID])[0];
    const isLive = (run) => !run.result && state.nowMs - run.mtimeMs < LIVE_IDLE_MS;

    function verdictOf(result, live = false) {
      if (!result) return live ? { text: "live", cls: "ok", st: "live", hist: "n" } : { text: "no result", cls: "mute", st: "", hist: "n" };
      if (result.exitCode === 2) return { text: "did not complete", cls: "warn", st: "warn", hist: "d" };
      return result.passed ? { text: "passed", cls: "ok", st: "ok", hist: "p" } : { text: "failed", cls: "bad", st: "bad", hist: "f" };
    }

    function badge(v) {
      return h("span", { className: `badge ${v.cls}` }, h("i", { className: "dot" }), v.text);
    }

    function groups() {
      const map = new Map();
      for (const run of state.runs) {
        const name = runName(run);
        if (!map.has(name)) map.set(name, []);
        map.get(name).push(run);
      }
      return [...map.entries()].map(([name, runs]) => ({ name, runs }));
    }

    async function loadRuns() {
      const body = await api(`/gui/api/runs?tree=${q(shell.treeID())}`);
      state.runs = body.runs || [];
      state.nowMs = body.nowMs || Date.now();
      shell.setCount("runs", state.runs.length);
      renderRail();
      renderRunSelect();
    }

    function renderRail() {
      const all = groups();
      const shown = all.filter((g) => !state.filter || g.name.toLowerCase().includes(state.filter.toLowerCase()))
        .filter((g) => state.only === "all" || g.runs.some((run) => run.result && !run.result.passed));
      // Latest verdict per scenario.
      const tally = { ok: 0, bad: 0, warn: 0 };
      for (const g of all) {
        const finished = g.runs.find((run) => run.result);
        if (finished) tally[verdictOf(finished.result).st] += 1;
      }
      const total = tally.ok + tally.bad + tally.warn;
      const sum = $("rail-sum");
      sum.textContent = "";
      if (total) {
        const stack = h("div", { className: "stack" });
        for (const key of ["ok", "warn", "bad"]) {
          if (!tally[key]) continue;
          const bar = h("i", { className: key });
          bar.style.flex = String(tally[key]);
          stack.append(bar);
        }
        sum.append(stack, h("div", { className: "rsum-l" },
          h("span", {}, h("b", { text: all.length }), " scenarios"),
          h("span", {}, h("b", { text: tally.ok }), " passing"),
          tally.bad ? h("span", {}, h("b", { text: tally.bad }), " failing") : null,
          tally.warn ? h("span", {}, h("b", { text: tally.warn }), " incomplete") : null));
      } else {
        sum.append(h("div", { className: "rsum-l" }, `${state.runs.length} run(s), none finished`));
      }

      const liveBox = $("rail-live");
      liveBox.textContent = "";
      for (const run of state.runs.filter(isLive).slice(0, 2)) {
        liveBox.append(h("div", { className: "live" }, h("span", { className: "srcpill", text: "live" }),
          h("div", {}, h("b", { text: runName(run) }), h("small", { text: `${runStamp(run)} · written ${ago(run.mtimeMs, state.nowMs)} ago` })),
          h("button", { type: "button", className: "btn sm", text: "Follow", onclick: () => { state.follow = true; openRun(run.runID); } })));
      }

      const box = $("rail-groups");
      box.textContent = "";
      if (!state.runs.length) {
        box.append(h("div", { className: "empty" }, "No runs with a timeline yet. ", h("code", { text: "gridcheck run <scenario>" }), " makes one."));
        return;
      }
      if (!shown.length) box.append(h("div", { className: "empty", text: "No scenario matches." }));
      for (const g of shown) {
        const open = state.openGroups.has(g.name) || (g.runs.some((run) => run.runID === state.runID) && !state.closedGroups.has(g.name));
        const hist = h("span", { className: "hist", title: "the last runs, oldest first" });
        for (const run of g.runs.slice(0, HISTORY).reverse()) hist.append(h("i", { className: verdictOf(run.result, isLive(run)).hist, title: `${runStamp(run)} ${verdictOf(run.result, isLive(run)).text}` }));
        const head = h("div", { className: "grp-h", onclick: () => {
          if (open) {
            state.openGroups.delete(g.name);
            state.closedGroups.add(g.name);
          } else {
            state.openGroups.add(g.name);
            state.closedGroups.delete(g.name);
          }
          renderRail();
        } }, h("span", { className: "caret", text: open ? "▾" : "▸" }), h("span", { className: "nm", text: g.name, title: g.name }), hist);
        const grp = h("div", { className: `grp${open ? " open" : ""}` }, head);
        if (open) {
          const list = h("div", { className: "grp-runs" });
          for (const run of g.runs) {
            const v = verdictOf(run.result, isLive(run));
            const took = run.result && run.result.startedAtMs && run.result.stoppedAtMs ? `${R.seconds(run.result.stoppedAtMs - run.result.startedAtMs)} · ` : "";
            const met = run.result && run.result.expectations ? ` · ${run.result.expectations - run.result.missing}/${run.result.expectations}` : "";
            list.append(h("div", { className: `r${run.runID === state.runID ? " sel" : ""}`, title: `${run.runID}  ${v.text}${met}`, onclick: () => openRun(run.runID) },
              h("span", { className: `st ${v.st}` }), h("span", { className: "mono", text: runStamp(run) }),
              h("span", { className: "muted", text: `${took}${ago(run.mtimeMs, state.nowMs)}` })));
          }
          grp.append(list);
        }
        box.append(grp);
      }
    }

    function renderRunSelect() {
      const select = $("tr-run");
      select.textContent = "";
      for (const run of state.runs) {
        select.append(h("option", { value: run.runID, text: `${runName(run)} · ${runStamp(run)}  (${verdictOf(run.result, isLive(run)).text})` }));
      }
      if (state.runID && !state.runs.some((run) => run.runID === state.runID)) select.prepend(h("option", { value: state.runID, text: state.runID }));
      if (state.runID) select.value = state.runID;
    }

    // ---------- opening and reading a run ----------

    const live = () => state.runID && !state.result && !state.model.ended && state.runNowMs - state.mtimeMs < LIVE_IDLE_MS;
    const t0 = () => state.model.t0;
    const tEnd = () => state.model.tEnd;
    const rel = (at) => (t0() === null || at === null ? 0 : at - t0());
    const watchStart = () => (state.detail && state.detail.result && state.detail.result.watchStartedAtMs) || null;
    const timeOf = (ref) => state.model.timeOf(ref, watchStart());

    function resetRun(runID) {
      state.generation += 1;
      shell.freeBlobs();
      Object.assign(state, { runID, detail: null, model: R.createModel(), bytes: 0, result: null, mtimeMs: 0, runNowMs: 0, loading: false,
        at: null, selBall: null, selEvent: -1, win: null, current: -1, rows: [], frameURLs: new Map(), palette: new Map() });
      setPlaying(false);
      $("wb-events").textContent = "";
      shell.saveHash();
    }

    async function openRun(runID) {
      if (!runID) return;
      resetRun(runID);
      renderRail();
      renderRunSelect();
      $("runs-empty").hidden = true;
      const generation = state.generation;
      renderInspector();
      await Promise.all([loadDetail(generation), pull()]);
      if (generation !== state.generation) return;
      const startAt = state.startT;
      state.startT = NaN;
      if (t0() !== null && Number.isFinite(startAt) && startAt > 0) {
        state.follow = false;
        state.at = Math.min(tEnd(), t0() + startAt * 1000);
      } else {
        state.at = live() && state.follow ? tEnd() : t0();
      }
      renderData();
    }

    async function loadDetail(generation = state.generation) {
      try {
        const body = await api(`/gui/api/run?tree=${q(shell.treeID())}&run=${q(state.runID)}`);
        if (generation !== state.generation) return;
        state.detail = body;
      } catch (error) {
        shell.message(error.message);
      }
      renderInspector();
      shell.refreshContext();
      if (state.view === "trace") renderTrace();
    }

    async function pull() {
      if (state.loading || !state.runID) return;
      state.loading = true;
      const generation = state.generation;
      const added = [];
      const hadResult = Boolean(state.result);
      try {
        for (;;) {
          const body = await api(`/viewer/timeline?tree=${q(shell.treeID())}&run=${q(state.runID)}&from=${state.bytes}`);
          if (generation !== state.generation) return;
          added.push(...state.model.ingest(body.text, body.summaries));
          state.bytes = body.next;
          state.result = body.result;
          state.mtimeMs = body.mtimeMs;
          state.runNowMs = body.nowMs;
          if (body.next >= body.size || !body.text) break;
        }
      } catch (error) {
        shell.message(error.message);
      } finally {
        if (generation === state.generation) state.loading = false;
      }
      if (generation !== state.generation) return;
      if (added.length) appendRows(added);
      if (!hadResult && state.result && state.detail) loadDetail().then(() => loadRuns().catch(() => {}));
      if (state.at === null || (state.follow && live())) state.at = tEnd();
      if (added.length && state.at !== null) renderData();
      else render();
    }

    // ---------- the event list ----------

    let grepText = "";
    function visible(event) {
      if (R.HIDDEN_KINDS.has(event.kind) || state.off.has(event.kind)) return false;
      return !state.grep || state.grep.test(`${event.kind} ${R.summary(event)}`);
    }

    function appendRows(indices) {
      const list = $("wb-events");
      const frag = document.createDocumentFragment();
      for (const index of indices) {
        const event = state.model.events[index];
        if (R.HIDDEN_KINDS.has(event.kind)) continue;
        const kc = R.kindClass(event.kind);
        const row = h("div", { className: `ev ${kc}${event.kind === "STEP" && !event.ok ? " fail" : ""}`, "data-index": index },
          h("span", { className: "et", text: R.offset(rel(event.atMs)) }),
          h("span", { className: `ek ${kc}`, text: event.kind }),
          h("span", { className: "ex", text: R.summary(event).slice(0, 400) }));
        row.hidden = !visible(event);
        state.rows[index] = row;
        frag.append(row);
      }
      list.append(frag);
      state.current = -1;
    }

    function refilter() {
      for (let index = 0; index < state.rows.length; index += 1) {
        const row = state.rows[index];
        if (row) row.hidden = !visible(state.model.events[index]);
      }
      state.current = -1;
      renderChips();
      render();
    }

    function renderChips() {
      const box = $("wb-chips");
      box.textContent = "";
      const kinds = [...state.model.counts.keys()];
      const order = (kind) => {
        const i = R.TRACK_KINDS.indexOf(kind);
        return i >= 0 ? i : kind === "LOG" ? 90 : kind === "CLIENT" ? 91 : 50;
      };
      kinds.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
      for (const kind of kinds) {
        box.append(h("button", { type: "button", className: `chip ${R.kindClass(kind)}${state.off.has(kind) ? "" : " on"}`, title: `Show or hide ${kind} lines`,
          onclick: () => {
            if (state.off.has(kind)) state.off.delete(kind);
            else state.off.add(kind);
            refilter();
          } }, h("i"), kind, h("span", { text: state.model.counts.get(kind) })));
      }
    }

    function renderEventsCursor() {
      const events = state.model.events;
      let current = -1;
      for (let index = events.length - 1; index >= 0; index -= 1) {
        if (events[index].atMs <= state.at && state.rows[index] && !state.rows[index].hidden) {
          current = index;
          break;
        }
      }
      if (current === state.current) return;
      state.current = current;
      for (let index = 0; index < state.rows.length; index += 1) {
        const row = state.rows[index];
        if (!row) continue;
        row.classList.toggle("future", events[index].atMs > state.at);
        row.classList.toggle("current", index === current);
      }
      const node = state.rows[current];
      if (node && state.view === "workbench") node.scrollIntoView({ block: "nearest" });
    }

    // ---------- the map ----------

    function colourFor(ball) {
      if (ball.who === "self") return COLOURS.self;
      if (ball.who === "concord") return COLOURS.concord;
      if (ball.who === "drifter") return COLOURS.drifter;
      if (ball.who === "player") return COLOURS.player;
      const rule = state.colourRules.find((entry) => Object.entries(entry.match || {})
        .every(([field, value]) => String(((ball.ext && ball.ext[entry.plugin]) || {})[field]) === String(value)));
      if (rule) return rule.colour;
      if (ball.who === "npc" || ball.who === "hostile") return COLOURS.hostile;
      if (ball.kind === "drone" || ball.kind === "fighter") return COLOURS.drone;
      if (!ball.who) return COLOURS.neutral;
      const key = ball.group || (ball.corp ? `corp:${ball.corp}` : `name:${String(ball.label || "").split(" ")[0]}`);
      if (!state.palette.has(key)) state.palette.set(key, COLOURS.others[state.palette.size % COLOURS.others.length]);
      return state.palette.get(key);
    }

    function laneColour(lane) {
      if (lane.self) return COLOURS.self;
      return colourFor({ who: lane.who, kind: lane.kind, label: lane.name });
    }

    function drawMap(prefix) {
      const svg = $(`${prefix}-map`);
      const W = Math.max(200, Math.round(svg.clientWidth || 800));
      const H = Math.max(160, Math.round(svg.clientHeight || 500));
      svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
      svg.textContent = "";
      const cx = W / 2;
      const cy = H / 2;
      const defs = el("defs");
      const pattern = el("pattern", { id: `${prefix}-gridpat`, width: 50, height: 50, patternUnits: "userSpaceOnUse", x: cx % 50, y: cy % 50 });
      pattern.append(el("path", { d: "M50 0H0V50", className: "m-gridline" }));
      defs.append(pattern);
      svg.append(defs, el("rect", { width: W, height: H, className: "m-grid", fill: `url(#${prefix}-gridpat)` }),
        el("line", { className: "m-axis", x1: cx, y1: 0, x2: cx, y2: H }), el("line", { className: "m-axis", x1: 0, y1: cy, x2: W, y2: cy }));
      const north = el("text", { className: "m-ringlbl", x: cx - 4, y: 14 });
      north.textContent = "N";
      svg.append(north);

      const frame = state.model.frameAt(state.at);
      const setScale = (barPx, text) => {
        $(`${prefix}-scale-bar`).style.width = `${Math.max(0, barPx).toFixed(0)}px`;
        $(`${prefix}-scale-text`).textContent = text;
      };
      if (!frame) {
        const note = el("text", { className: "m-note", x: 24, y: 70 });
        note.textContent = !state.runID ? "" : state.model.positions.length ? "no position sample near this time"
          : "no positions in this run: watch with --positions, or use gridcheck run";
        svg.append(note);
        setScale(0, "");
        return { tracked: 0 };
      }
      const { pos, balls, velocity } = frame;
      const byID = new Map(balls.map((ball) => [ball.id, ball]));
      const self = byID.get(pos.selfID) || null;
      const centre = self || balls[0] || { x: 0, y: 0, z: 0 };
      const planar = (ball) => Math.hypot(ball.x - centre.x, ball.z - centre.z);
      const fromSelf = (ball) => Math.hypot(ball.x - centre.x, (ball.y || 0) - (centre.y || 0), ball.z - centre.z);
      const tracked = balls.filter((ball) => R.TRACKED.has(ball.kind));
      let half = Number(state.zoom);
      if (!(half > 0)) {
        const near = tracked.filter((ball) => planar(ball) <= 300_000).reduce((max, ball) => Math.max(max, planar(ball)), 0);
        half = Math.max(5000, 1.15 * near);
      }
      const radius = Math.min(W, H) / 2 - 18;
      const scale = radius / half;
      const project = (ball) => ({ x: cx + (ball.x - centre.x) * scale, y: cy - (ball.z - centre.z) * scale });
      const inside = (p) => p.x >= 4 && p.x <= W - 4 && p.y >= 4 && p.y <= H - 4;
      const colour = new Map(balls.map((ball) => [ball.id, colourFor(ball)]));
      const selfLocks = new Set(self && Array.isArray(self.locks) ? self.locks : []);

      const bar = niceLength((2 * half) / 5);
      for (let ring = 1; ring * bar * scale <= Math.hypot(cx, cy) && ring <= 8; ring += 1) {
        const r = ring * bar * scale;
        svg.append(el("circle", { className: "m-ring", cx, cy, r: r.toFixed(1) }));
        if (ring <= 3) {
          const label = el("text", { className: "m-ringlbl", x: (cx + r * 0.7071 + 4).toFixed(1), y: (cy - r * 0.7071 - 4).toFixed(1) });
          label.textContent = R.distance(ring * bar);
          svg.append(label);
        }
      }
      setScale(bar * scale, R.distance(bar));

      // Intent: self's orbit, movement toward a target, drones at theirs.
      for (const ball of balls) {
        const target = ball.target ? byID.get(Number(ball.target)) : null;
        if (!target) continue;
        const from = project(ball);
        const to = project(target);
        if (ball.kind === "drone" || ball.kind === "fighter") {
          svg.append(el("line", { className: "m-link", x1: from.x, y1: from.y, x2: to.x, y2: to.y }));
        } else if (ball === self && ball.mode === "ORBIT") {
          svg.append(el("circle", { className: "m-orbit", cx: to.x, cy: to.y, r: Math.hypot(from.x - to.x, from.y - to.y).toFixed(1) }));
        } else if (R.MOVING.has(ball.mode)) {
          svg.append(el("line", { className: "m-move", x1: from.x, y1: from.y, x2: to.x, y2: to.y, stroke: colour.get(ball.id) }));
        }
      }
      // Locks on self.
      for (const ball of balls) {
        if (ball === self || !Array.isArray(ball.locks) || !ball.locks.includes(pos.selfID) || !self) continue;
        const a = project(ball);
        const b = project(self);
        svg.append(el("line", { className: "m-lockline", x1: a.x, y1: a.y, x2: b.x, y2: b.y, stroke: COLOURS.hostile }));
      }
      // Weapons and effects the client was told about (FX). A repeating module
      // sends one FX for all its cycles, so it is drawn while they last, the
      // shooter still locks the target and the target is alive.
      const shots = state.model.recent("FX", state.at, 30 * 60_000, (event) => {
        if (!event.itemID || !event.targetID) return false;
        const cycles = Number(event.repeat) > 1 ? Number(event.durationMs) * Number(event.repeat) : SHOT_MS;
        const destroyed = state.model.destroyedAt.get(Number(event.targetID));
        return state.at - event.atMs <= Math.max(SHOT_MS, cycles || 0) && !(destroyed && destroyed <= state.at);
      });
      for (const shot of shots) {
        const a = byID.get(Number(shot.itemID));
        const b = byID.get(Number(shot.targetID));
        if (!a || !b) continue;
        if (state.at - shot.atMs > SHOT_MS && Array.isArray(a.locks) && !a.locks.includes(b.id)) continue;
        const p = project(a);
        const t = project(b);
        const line = el("line", { className: "m-weapon", x1: p.x, y1: p.y, x2: t.x, y2: t.y });
        line.append(svgTitle(`${R.offset(rel(shot.atMs))}  FX  ${R.summary(shot)}`));
        svg.append(line);
      }
      const hit = new Set(state.model.recent("DAMAGE", state.at, FLASH_MS).map((event) => Number(event.itemID)));
      const diverged = new Map();
      for (const event of state.model.recent("DIVERGE", state.at, DIVERGE_MS, (e) => e.itemID && e.status !== "cleared")) {
        const id = event.itemID === "self" ? pos.selfID : Number(event.itemID);
        if (!diverged.has(id)) diverged.set(id, event);
      }

      const order = [...balls].sort((a, b) => planar(b) - planar(a));
      const labelAll = tracked.filter((ball) => ball.kind === "ship").length <= 16;
      const swarms = new Map();
      const edge = [];
      for (const ball of order) {
        const p = project(ball);
        if (!inside(p)) {
          edge.push({ ball, p });
          continue;
        }
        const c = colour.get(ball.id);
        const isTracked = R.TRACKED.has(ball.kind);
        const shape = shapeFor(ball, p.x, p.y, isTracked ? 7 : 5, c);
        shape.dataset.id = String(ball.id);
        shape.append(svgTitle(`${ball.label}${ball.type ? ` (${ball.type})` : ""}  ${R.distance(fromSelf(ball))}` +
          `${ball.mode ? `  ${ball.mode}` : ""}${ball.group ? `  ${ball.group}` : ""}  #${ball.id}`));
        if (selfLocks.has(ball.id)) {
          const r = 13;
          svg.append(el("path", { className: "m-lock", d: `M${p.x - r} ${p.y - r + 8}v-8h8 M${p.x + r - 8} ${p.y - r}h8v8 M${p.x + r} ${p.y + r - 8}v8h-8 M${p.x - r + 8} ${p.y + r}h-8v-8` }));
        }
        const v = velocity.get(ball.id);
        if (v && ball.kind === "ship" && v.speed >= 1) {
          const len = Math.min(60, v.speed * 4 * scale);
          if (len >= 3) {
            const k = len / Math.hypot(v.vx, v.vz || 1e-9);
            svg.append(el("line", { className: "m-vel", x1: p.x, y1: p.y, x2: (p.x + v.vx * k).toFixed(1), y2: (p.y - v.vz * k).toFixed(1), stroke: c }));
          }
        }
        svg.append(shape);
        if (hit.has(ball.id)) svg.append(el("circle", { className: "m-dmg", cx: p.x, cy: p.y, r: 14 }));
        if (diverged.has(ball.id)) {
          svg.append(el("circle", { className: "m-div", cx: p.x, cy: p.y, r: 18 }));
          const tag = el("text", { className: "m-divtag", x: p.x + 20, y: p.y + 18 });
          tag.textContent = `DIVERGE ${diverged.get(ball.id).reason}`;
          svg.append(tag);
        }
        if (String(ball.id) === String(state.selBall)) svg.append(el("circle", { className: "m-selring", cx: p.x, cy: p.y, r: 11 }));
        if (ball.kind === "drone" || ball.kind === "fighter") {
          const key = `${ball.label}|${ball.who || ""}`;
          if (!swarms.has(key)) swarms.set(key, { label: ball.label, n: 0, x: 0, y: 0, c });
          const s = swarms.get(key);
          s.n += 1;
          s.x += p.x;
          s.y += p.y;
        } else if (isTracked ? (labelAll || ball.who === "self" || String(ball.id) === String(state.selBall) || selfLocks.has(ball.id))
          : planar(ball) * scale < radius) {
          const isSelf = ball.who === "self";
          const name = el("text", { className: isTracked ? `m-lbl${isSelf ? " self" : ""}` : "m-dimlbl", x: p.x + 12, y: p.y - 3 });
          if (isTracked && !isSelf) name.style.fill = c;
          name.textContent = isSelf ? `self${ball.type ? ` · ${ball.type}` : ""}` : String(ball.label || "").slice(0, 30);
          svg.append(name);
          if (isTracked) {
            const sub = el("text", { className: "m-sub", x: p.x + 12, y: p.y + 11 });
            sub.textContent = isSelf
              ? `${v ? `${Math.round(v.speed).toLocaleString("en-US")} m/s` : "-"}${ball.mode ? ` · ${ball.mode}` : ""}`
              : `${R.distance(fromSelf(ball))}${ball.mode ? ` · ${ball.mode}` : ""}${selfLocks.has(ball.id) ? " · locked" : ""}`;
            svg.append(sub);
          }
        }
      }
      for (const s of swarms.values()) {
        const text = el("text", { className: "m-lbl", x: (s.x / s.n + 12).toFixed(1), y: (s.y / s.n - 12).toFixed(1) });
        text.style.fill = s.c;
        text.textContent = `${s.label}${s.n > 1 ? ` × ${s.n}` : ""}`;
        svg.append(text);
      }
      for (const { ball, p } of edge) {
        const dx = p.x - cx;
        const dy = p.y - cy;
        const t = Math.min((cx - 12) / Math.abs(dx || 1e-9), (cy - 12) / Math.abs(dy || 1e-9));
        const arrow = el("path", { className: "m-edge", d: "M0 -5L10 0L0 5Z", fill: R.TRACKED.has(ball.kind) ? colour.get(ball.id) : COLOURS.dim,
          transform: `translate(${(cx + dx * t).toFixed(1)} ${(cy + dy * t).toFixed(1)}) rotate(${(Math.atan2(dy, dx) * 180 / Math.PI).toFixed(1)})` });
        arrow.dataset.id = String(ball.id);
        arrow.append(svgTitle(`${ball.label} ${R.distance(fromSelf(ball))}`));
        svg.append(arrow);
      }
      return { tracked: tracked.length, pos, self };
    }

    function shapeFor(ball, x, y, r, c) {
      if (ball.kind === "wreck") {
        return el("path", { className: "m-wreck", d: `M${x - r * 0.7} ${y - r * 0.7}L${x + r * 0.7} ${y + r * 0.7}M${x - r * 0.7} ${y + r * 0.7}L${x + r * 0.7} ${y - r * 0.7}`, stroke: COLOURS.neutral });
      }
      if (ball.kind === "drone" || ball.kind === "fighter") return el("circle", { className: "m-ball", cx: x, cy: y, r: r * 0.5, fill: c });
      if (ball.kind === "container") return el("rect", { className: "m-ball", x: x - r * 0.6, y: y - r * 0.6, width: r * 1.2, height: r * 1.2, fill: c });
      if (!R.TRACKED.has(ball.kind) || ball.kind === "structure") {
        return el("rect", { className: "m-struct", x: x - r, y: y - r, width: r * 2, height: r * 2, stroke: c });
      }
      if (ball.who === "self") return el("path", { className: "m-ball", d: `M${x} ${y - r * 1.5}L${x + r * 1.5} ${y}L${x} ${y + r * 1.5}L${x - r * 1.5} ${y}Z`, fill: c });
      return el("path", { className: "m-ball", d: `M${x} ${y - r * 1.2}L${x + r * 1.1} ${y + r * 0.9}L${x - r * 1.1} ${y + r * 0.9}Z`, fill: c });
    }

    // ---------- the compact track ----------

    function renderTrack() {
      const box = $("wb-track");
      box.textContent = "";
      const span = t0() === null ? 0 : tEnd() - t0();
      if (!span) {
        box.append(h("div", { className: "notrack", text: state.runID ? "No events with a time yet." : "" }));
        return;
      }
      for (const kind of R.TRACK_KINDS) {
        if (!state.model.counts.get(kind)) continue;
        const kc = R.kindClass(kind);
        const lt = h("div", { className: "lt" });
        const seen = new Set();
        for (const event of state.model.events) {
          if (event.kind !== kind) continue;
          const p = ((event.atMs - t0()) / span) * 100;
          const bucket = Math.round(p * 4);
          if (seen.has(bucket)) continue;
          seen.add(bucket);
          const tick = h("i", { className: `tick ${kc}`, title: `${R.offset(rel(event.atMs))}  ${R.summary(event).slice(0, 160)}` });
          tick.style.left = `${p.toFixed(2)}%`;
          lt.append(tick);
        }
        box.append(h("div", { className: "lane" }, h("span", { className: `lk ${kc}`, text: kind }), lt));
      }
      const area = h("div", { className: "track-area" }, h("div", { className: "played", id: "wb-played" }), h("div", { className: "playhead", id: "wb-playhead" }));
      const axis = h("div", { className: "taxis" });
      const step = R.niceStep(span, 5);
      for (let ms = 0; ms <= span - step * 0.6; ms += step) {
        const label = h("span", { text: R.axisLabel(ms, step) });
        label.style.left = `${(ms / span) * 100}%`;
        if (ms > 0) label.style.transform = "translateX(-50%)";
        axis.append(label);
      }
      const endLabel = h("span", { text: `${R.axisLabel(span, step)}${state.model.ended || state.result ? " · end" : ""}` });
      endLabel.style.right = "0";
      axis.append(endLabel);
      box.append(area, axis);
    }

    function trackSeek(event) {
      const box = $("wb-track");
      const rect = box.getBoundingClientRect();
      const left = rect.left + 84;
      const f = Math.min(1, Math.max(0, (event.clientX - left) / Math.max(1, rect.right - left)));
      if (t0() !== null) seek(t0() + f * (tEnd() - t0()), { pause: false });
    }

    // ---------- the inspector ----------

    function expectations() {
      const result = state.detail && state.detail.result;
      const list = (result && Array.isArray(result.expectations)) ? result.expectations : [];
      return list.map((x, i) => {
        const at = x.first ? timeOf(x.first) : null;
        const ok = x.met === true;
        const kind = (x.first && x.first.kind) || (/^(?:no\s+)?([A-Z_]+)/.exec(x.text || "") || [])[1] || "";
        return { i, text: x.text, note: x.note, ok, absent: Boolean(x.absent), count: x.count, at, kind };
      });
    }

    function framesList() {
      const detail = state.detail;
      if (!detail) return [];
      const meta = (detail.result && Array.isArray(detail.result.frames)) ? detail.result.frames : [];
      return (detail.frames || []).map((file) => {
        const m = meta.find((row) => String(row.file || "").endsWith(`/${file}`) || row.file === file) || {};
        return { file, reason: m.reason || file.replace(/^\d+-/, "").replace(/\.svg$/, ""), stop: Boolean(m.stop), at: timeOf(m) };
      });
    }

    function frameURL(file) {
      if (!state.frameURLs.has(file)) {
        state.frameURLs.set(file, shell.blobURL(`/gui/api/frame?tree=${q(shell.treeID())}&run=${q(state.runID)}&file=${q(file)}`));
      }
      return state.frameURLs.get(file);
    }

    function frameFigure(frame, { caption = true } = {}) {
      const img = h("img", { className: "thumb", alt: frame.file, loading: "lazy" });
      frameURL(frame.file).then((url) => { img.src = url; }).catch(() => { img.alt = `${frame.file} (failed to load)`; });
      const fig = h("figure", { title: `${frame.file}${frame.at !== null ? `  ${R.offset(rel(frame.at))}` : ""}`,
        onclick: () => frameURL(frame.file).then((url) => shell.showFrame(url, frame.file, frame.at, (at) => seek(at))) }, img);
      if (caption) {
        fig.append(h("figcaption", {}, frame.at !== null ? R.offset(rel(frame.at)) : "", h("span", { text: `${frame.reason}${frame.stop ? " · stop" : ""}` })));
      }
      return fig;
    }

    function stopAt() {
      const result = state.detail && state.detail.result;
      if (result && result.stop && result.stop.event) {
        const at = timeOf(result.stop.event);
        if (at !== null) return at;
      }
      const stop = state.model.events.find((event) => event.kind === "STOP");
      return stop ? stop.atMs : null;
    }

    function divergeCount() {
      return state.model.events.filter((event) => event.kind === "DIVERGE" && event.status !== "cleared").length;
    }

    function renderInspector() {
      const detail = state.detail;
      const result = detail && detail.result;
      const v = verdictOf(state.result || (result && { passed: result.passed === true, exitCode: result.exitCode }) || null, live());
      $("insp-crumbs").textContent = state.runID ? `${(result && result.name) || "run"} / ${state.runID}` : "";
      $("insp-name").textContent = state.runID ? (result && result.name) || state.runID : "No run";
      const verdict = $("insp-verdict");
      verdict.textContent = "";
      if (state.runID) verdict.append(badge(v));
      const pop = $("insp-popout");
      pop.hidden = !state.runID;
      pop.href = `/viewer#token=${q(shell.token)}&tree=${q(shell.treeID())}&run=${q(state.runID || "")}`;
      $("insp-refresh").disabled = !state.runID;

      const xs = expectations();
      const frames = framesList();
      const tabs = $("itabs");
      tabs.textContent = "";
      for (const [id, label] of ITABS) {
        const n = id === "expect" ? xs.length : id === "frames" ? frames.length : null;
        tabs.append(h("button", { type: "button", className: state.itab === id ? "on" : "", onclick: () => { state.itab = id; renderInspector(); } },
          label, n !== null ? h("span", { className: "muted", text: n }) : null));
      }
      const body = $("ibody");
      body.textContent = "";
      if (!state.runID) {
        body.append(h("div", { className: "empty", text: "Pick a run on the left." }));
        return;
      }
      if (!detail) {
        body.append(h("div", { className: "muted", text: "loading..." }));
        return;
      }
      if (state.itab === "summary") {
        const met = xs.filter((x) => x.ok).length;
        const start = result && result.startedAtMs;
        const stop = result && result.stoppedAtMs;
        const sAt = stopAt();
        const tot = h("div", { className: "mini-tot" });
        const cell = (k, value, cls = "", id = null) => tot.append(h("div", {}, h("span", { className: "k", text: k }), h("span", { className: `v ${cls}`, text: value, id })));
        cell("Expect", xs.length ? `${met}/${xs.length}` : "-", xs.length ? (met === xs.length ? "ok" : "bad") : "");
        cell("Stop", sAt !== null ? `t+${Math.round(rel(sAt) / 1000)}` : "-");
        cell("Took", start && stop ? R.seconds(stop - start) : live() ? "running" : "-");
        const d = divergeCount();
        cell("Diverge", String(d), d ? "div" : "");
        cell("On grid", "-", "", "x-ongrid");
        cell("Events", String([...state.model.counts.values()].reduce((a, b) => a + b, 0)), "", "x-events");
        body.append(tot);
        const strip = perfStrip();
        if (strip) body.append(strip);
        if (xs.length) {
          body.append(h("div", {}, h("div", { className: "shead" }, h("h2", { text: "Expectations" }), h("span", { className: "count", text: "click to seek" })),
            h("ul", { className: "xlist", id: "x-list" }, xs.map((x) => h("li", { "data-at": x.at === null ? "" : x.at, className: x.at === null ? "nowhen" : "",
              title: `${x.text}${x.note ? `\n${x.note}` : ""}`, onclick: () => { if (x.at !== null) seek(x.at); } },
            h("span", { className: `ck${x.ok ? "" : " bad"}`, text: x.ok ? "✓" : "✗" }),
            h("span", { className: "et", text: x.at !== null ? R.clockShort(rel(x.at)) : x.absent && x.ok ? "never" : "-" }),
            h("span", { className: "xx", text: x.note || x.text }),
            x.kind ? h("span", { className: `ek ${R.kindClass(x.kind)}`, text: x.kind }) : h("span"))))));
        } else if (result) {
          body.append(h("p", { className: "muted", text: "This run lists no expectations." }));
        }
        body.append(h("div", { id: "x-sel" }));
        if (frames.length) {
          body.append(h("div", {}, h("div", { className: "shead" }, h("h2", { text: "Frames" }), h("span", { className: "count", text: frames.length })),
            h("div", { className: "fgrid" }, frames.slice(0, 6).map((frame) => frameFigure(frame)))));
        }
      } else if (state.itab === "expect") {
        if (!xs.length) body.append(h("p", { className: "muted", text: "This run lists no expectations." }));
        body.append(h("ul", { className: "xfull" }, xs.map((x) => h("li", { className: `${x.ok ? "" : "miss"}${x.at === null ? " nowhen" : ""}`,
          onclick: () => { if (x.at !== null) seek(x.at); } },
        h("div", { className: "row" }, h("span", { className: `ck${x.ok ? "" : " bad"}`, text: x.ok ? "✓" : "✗" }), h("span", { className: "xt", text: x.text })),
        x.note ? h("div", { className: "xn", text: x.note }) : null,
        h("div", { className: "row" },
          h("span", { text: x.absent ? (x.ok ? "never happened, as expected" : "happened, and shouldn't have") : x.ok ? "met" : "MISSING" }),
          Number.isFinite(x.count) && x.count > 0 ? h("span", { text: `× ${x.count}` }) : null,
          x.at !== null ? h("span", { className: "mono", text: `first ${R.offset(rel(x.at))}` }) : null,
          h("span", { className: "spacer" }),
          x.kind ? h("span", { className: `ek ${R.kindClass(x.kind)}`, text: x.kind }) : null)))));
      } else if (state.itab === "perf") {
        body.append(perfPanel());
      } else if (state.itab === "frames") {
        if (!frames.length) body.append(h("p", { className: "muted", text: "No frames: the run has no position samples." }));
        body.append(h("div", { className: "fgrid one" }, frames.map((frame) => frameFigure(frame))));
      } else if (state.itab === "report") {
        const report = h("article", { className: "report" });
        if (detail.report === null) report.append(h("p", { className: "muted", text: "No report.md: the run didn't finish writing one." }));
        else shell.renderMarkdown(detail.report, report, (file) => frameURL(file), (url, file) => shell.showFrame(url, file, null, null));
        body.append(report);
      } else if (state.itab === "facts") {
        body.append(factsTable(detail));
      }
      renderInspectorCursor();
    }

    function factsTable(detail) {
      const result = detail.result || {};
      const rows = [];
      const add = (k, value) => { if (value !== undefined && value !== null && value !== "") rows.push(h("tr", {}, h("th", { text: k }), h("td", {}, value))); };
      add("Scenario", result.name);
      add("File", result.scenarioFile ? h("span", { className: "mono", text: result.scenarioFile }) : null);
      add("World", result.world);
      add("Run", h("span", { className: "mono", text: detail.run }));
      add("Folder", h("span", { className: "mono", text: detail.dir }));
      add("Commit", result.commit ? h("span", { className: "mono", text: typeof result.commit === "string" ? result.commit : JSON.stringify(result.commit) }) : null);
      add("Started", result.startedAtMs ? new Date(result.startedAtMs).toLocaleString() : null);
      add("Took", result.startedAtMs && result.stoppedAtMs ? R.seconds(result.stoppedAtMs - result.startedAtMs) : null);
      if (result.stop) add("Stop", `${result.stop.reason || "?"}${result.stop.condition ? `: ${result.stop.condition}` : ""}${result.stop.error ? ` (${result.stop.error})` : ""}`);
      if (result.failure) add("Failure", h("span", { className: "badc", text: typeof result.failure === "string" ? result.failure : JSON.stringify(result.failure) }));
      if (Array.isArray(result.until) && result.until.length) add("Until", result.until.map((u) => `${u.fired ? "✓" : "–"} ${u.text}`).join("\n"));
      if (result.bindings && Object.keys(result.bindings).length) {
        add("Bindings", h("span", { className: "mono", text: Object.entries(result.bindings).map(([k, value]) => `$${k} = ${[].concat(value).join(", ")}`).join("\n") }));
      }
      if (result.down) add("Server down", result.down.ok ? "ok" : `failed: ${result.down.error}`);
      add("Events", Number.isFinite(result.eventCount) ? String(result.eventCount) : null);
      const table = h("table", { className: "kvt" }, h("tbody", {}, rows));
      const steps = Array.isArray(result.steps) ? result.steps : [];
      const wrap = h("div", {}, table);
      if (steps.length) {
        wrap.append(h("div", { className: "shead" }, h("h2", { text: "Steps" }), h("span", { className: "count", text: steps.length })),
          h("ul", { className: "xlist" }, steps.map((step) => h("li", { title: `${step.text || ""}${step.note ? `\n${step.note}` : ""}`,
            onclick: () => { if (step.startedAtMs) seek(step.startedAtMs); } },
          h("span", { className: `ck${step.ok ? "" : " bad"}`, text: step.ok ? "✓" : "✗" }),
          h("span", { className: "et", text: step.startedAtMs && t0() !== null ? R.clockShort(Math.max(0, step.startedAtMs - t0())) : "" }),
          h("span", { className: "xx", text: step.step }),
          h("span", { className: "ek k-step", text: step.phase || "step" })))));
      }
      if (!rows.length && !steps.length) wrap.append(h("p", { className: "muted", text: "No result.json yet." }));
      return wrap;
    }

    // ---------- server performance ----------

    // The run's PERF and PROFILE lines, as the report reads them (core/perf.js,
    // served as /gui/perf.js), recomputed when more of the timeline arrives.
    const P = window.E2EPerf;
    let perfCache = { version: -1, record: null, ticks: [] };
    function perf() {
      if (!P) return perfCache;
      if (perfCache.version !== state.model.version) {
        const record = P.perfRecord(state.model.events);
        const ticks = record ? state.model.events.filter((event) => event.kind === "PERF").flatMap(P.ticksOf).sort((a, b) => a.atMs - b.atMs) : [];
        perfCache = { version: state.model.version, record, ticks };
      }
      return perfCache;
    }

    const fmtMs = (value) => (value === null || value === undefined ? "-" : `${Number(value).toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ms`);
    // Green well inside the budget, amber past half of it, red over it.
    const budgetClass = (value, budget) => (value === null || value === undefined ? "" : value > budget ? "bad" : value > budget / 2 ? "warn" : "ok");

    function niceCeil(value) {
      if (!(value > 0)) return 1;
      const power = 10 ** Math.floor(Math.log10(value));
      for (const step of [1, 2, 2.5, 5, 10]) if (step * power >= value) return step * power;
      return 10 * power;
    }

    // Each tick's duration over the run: the worst tick per pixel column as a
    // band, the average as a line, the budget dashed, the steps as markers.
    function perfChart(record, ticks) {
      const W = 352;
      const H = 156;
      const pad = { l: 34, r: 6, t: 10, b: 18 };
      const pw = W - pad.l - pad.r;
      const ph = H - pad.t - pad.b;
      const o = record.overall;
      const budget = record.budgetMs;
      // Scaled to the run's own ticks, so a quiet run isn't a flat line under the budget.
      const yMax = niceCeil(Math.max(o.tickP99Ms * 1.6, o.tickAvgMs * 3, Math.min(o.tickMaxMs, budget * 1.25), 1));
      const from = t0();
      const to = Math.max(tEnd(), from + 1000);
      const x = (at) => pad.l + ((at - from) / (to - from)) * pw;
      const y = (ms) => pad.t + ph - (Math.min(ms, yMax) / yMax) * ph;
      const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, className: "pf-chart", id: "pf-chart", role: "img", "aria-label": "Tick duration over the run" });
      for (let i = 0; i <= 4; i += 1) {
        const value = (yMax / 4) * i;
        svg.append(el("line", { x1: pad.l, x2: W - pad.r, y1: y(value), y2: y(value), className: i ? "pf-grid" : "pf-axis" }));
        const label = el("text", { x: pad.l - 4, y: y(value) + 3, className: "pf-yl", "text-anchor": "end" });
        label.textContent = value >= 10 || value === 0 ? String(Math.round(value)) : value.toFixed(1);
        svg.append(label);
      }
      const bins = Math.max(1, Math.floor(pw / 2));
      const cols = Array.from({ length: bins }, () => ({ max: null, sum: 0, n: 0 }));
      for (const tick of ticks) {
        const index = Math.min(bins - 1, Math.max(0, Math.floor(((tick.atMs - from) / (to - from)) * bins)));
        const col = cols[index];
        col.max = col.max === null ? tick.ms : Math.max(col.max, tick.ms);
        col.sum += tick.ms;
        col.n += 1;
      }
      const colX = (index) => pad.l + ((index + 0.5) / bins) * pw;
      let band = "";
      let line = "";
      cols.forEach((col, index) => {
        if (!col.n) return;
        band += `M${colX(index).toFixed(1)},${y(0).toFixed(1)}V${y(col.max).toFixed(1)}`;
        line += `${line ? "L" : "M"}${colX(index).toFixed(1)},${y(col.sum / col.n).toFixed(1)}`;
        if (col.max > budget) svg.append(el("rect", { x: colX(index) - 1, y: pad.t, width: 2, height: 3, className: "pf-over" }));
      });
      svg.append(el("path", { d: band, className: "pf-band" }));
      svg.append(el("path", { d: line, className: "pf-avg" }));
      if (budget <= yMax) {
        svg.append(el("line", { x1: pad.l, x2: W - pad.r, y1: y(budget), y2: y(budget), className: "pf-budget" }));
        const label = el("text", { x: W - pad.r - 2, y: y(budget) - 3, className: "pf-bl", "text-anchor": "end" });
        label.textContent = `budget ${budget} ms`;
        svg.append(label);
      } else {
        const label = el("text", { x: W - pad.r - 2, y: pad.t + 8, className: "pf-yl", "text-anchor": "end" });
        label.textContent = `budget ${budget} ms is off the top`;
        svg.append(label);
      }
      // Each setup and during step, numbered as in the phase table. Steps that
      // end within a few pixels of each other share one label, "2,3".
      let lastLabel = null;
      record.phases.forEach((phase, index) => {
        if (!phase.step) return;
        const px = x(phase.fromMs);
        if (px < pad.l || px > W - pad.r) return;
        const mark = el("g", { className: "pf-step" });
        mark.append(el("line", { x1: px, x2: px, y1: pad.t, y2: pad.t + ph }), svgTitle(`${phase.label} at ${R.offset(rel(phase.fromMs))}`));
        if (lastLabel && px - lastLabel.px < 12) {
          lastLabel.node.textContent += `,${index}`;
        } else {
          const label = el("text", { x: px + 2, y: H - 5 });
          label.textContent = String(index);
          mark.append(label);
          lastLabel = { px, node: label };
        }
        svg.append(mark);
      });
      svg.append(el("line", { id: "pf-cur", className: "pf-cur", x1: pad.l, x2: pad.l, y1: pad.t, y2: pad.t + ph }));
      svg.addEventListener("click", (event) => {
        const rect = svg.getBoundingClientRect();
        const fx = ((event.clientX - rect.left) / Math.max(1, rect.width)) * W;
        seek(from + Math.min(1, Math.max(0, (fx - pad.l) / pw)) * (to - from));
      });
      svg.dataset.from = String(from);
      svg.dataset.to = String(to);
      return svg;
    }

    function perfPanel() {
      const { record, ticks } = perf();
      if (!record) {
        return h("div", { className: "muted pf-none" },
          h("p", { text: "This run has no PERF lines, so there are no tick figures." }),
          h("p", {}, "A scenario records them with ", h("code", { text: "\"up\": { \"profile\": true }" }), " or ",
            h("code", { text: "\"watch\": { \"perf\": true }" }), ", and a watch with ", h("code", { text: "--perf" }), "."));
      }
      const o = record.overall;
      const budget = record.budgetMs;
      const wrap = h("div", { className: "pf" });
      const tot = h("div", { className: "mini-tot" });
      const cell = (k, value, cls = "", title = null) => tot.append(h("div", { title }, h("span", { className: "k", text: k }), h("span", { className: `v ${cls}`, text: value })));
      cell("Ticks", String(o.ticks), "", `${record.windows} windows of ticks${record.missedTicks ? `, ${record.missedTicks} ticks missed between samples` : ""}`);
      cell("Avg", fmtMs(o.tickAvgMs), budgetClass(o.tickAvgMs, budget));
      cell("p95", fmtMs(o.tickP95Ms), budgetClass(o.tickP95Ms, budget));
      cell("p99", fmtMs(o.tickP99Ms), budgetClass(o.tickP99Ms, budget));
      cell("Max", fmtMs(o.tickMaxMs), budgetClass(o.tickMaxMs, budget));
      cell("Over budget", String(o.overBudget), o.overBudget ? "bad" : "ok", `ticks that took longer than the ${budget} ms a tick has`);
      wrap.append(tot);

      wrap.append(h("div", {}, h("div", { className: "shead" }, h("h2", { text: "Tick time, ms" }),
        h("span", { className: "count", text: "worst per column, average line; click to seek" })), perfChart(record, ticks)));

      if (record.phases.length) {
        const rows = record.phases.map((phase, index) => h("tr", { "data-from": phase.fromMs, "data-to": phase.toMs, title: `${phase.label}\nfrom ${R.offset(rel(phase.fromMs))}`,
          onclick: () => seek(phase.fromMs) },
        h("td", { className: "pn", text: String(index) }),
        h("td", { className: "pl", text: phase.label.replace(/^after /, "") }),
        h("td", { text: String(phase.ticks) }),
        h("td", { className: budgetClass(phase.tickAvgMs, budget), text: fmtMs(phase.tickAvgMs).replace(" ms", "") }),
        h("td", { className: budgetClass(phase.tickP95Ms, budget), text: fmtMs(phase.tickP95Ms).replace(" ms", "") }),
        h("td", { className: budgetClass(phase.tickMaxMs, budget), text: fmtMs(phase.tickMaxMs).replace(" ms", "") }),
        h("td", { className: phase.overBudget ? "bad" : "", text: String(phase.overBudget) })));
        wrap.append(h("div", {}, h("div", { className: "shead" }, h("h2", { text: "Phases" }),
          h("span", { className: "count", text: "each starts where a step ended" })),
        h("table", { className: "pf-phases", id: "pf-phases" },
          h("thead", {}, h("tr", {}, ["#", "After", "Ticks", "Avg", "p95", "Max", "Over"].map((title) => h("th", { text: title })))),
          h("tbody", {}, rows))));
      }

      const proc = h("div", { className: "mini-tot" });
      const pcell = (k, value, cls = "", title = null) => proc.append(h("div", { title }, h("span", { className: "k", text: k }), h("span", { className: `v ${cls}`, text: value })));
      pcell("Loop p99", fmtMs(o.loopP99Ms), budgetClass(o.loopP99Ms, budget), "event-loop delay: how long a timer waited for the process to be free");
      pcell("CPU", o.cpuPctMax === null ? "-" : `${Math.round(o.cpuPctMax)}%`, "", "the busiest window, as a share of one core");
      pcell("Heap", o.heapMBMax === null ? "-" : `${Math.round(o.heapMBMax)} MB`, "", o.rssMBMax ? `rss up to ${Math.round(o.rssMBMax)} MB` : null);
      pcell("Entities", o.entitiesMax === null ? "-" : String(o.entitiesMax), "", "the most at once, in every scene that ticked");
      pcell("TiDi", o.tidiMin === null ? "-" : o.tidiMin < 1 ? String(o.tidiMin) : "none", o.tidiMin !== null && o.tidiMin < 1 ? "bad" : "", "the lowest time dilation any scene ran at");
      pcell("Profiler", record.profile ? `${record.profile.windows} win` : record.profiler ? "on" : "off", record.profile ? "ok" : "");
      wrap.append(h("div", {}, h("div", { className: "shead" }, h("h2", { text: "Process" }), h("span", { className: "count", text: "worst window" })), proc));

      const sub = h("div", {});
      sub.append(h("div", { className: "shead" }, h("h2", { text: "Subsystems" }),
        h("span", { className: "count", text: record.profile ? `${fmtMs(record.profile.totalMsPerTick)} a tick, ${record.profile.windows} profiler windows` : "tick profiler" })));
      if (!record.profile) {
        sub.append(h("p", { className: "muted" }, "The server ran without the tick profiler. Boot it with ", h("code", { text: "gridcheck up --profile" }),
          ", or give the scenario ", h("code", { text: "\"up\": { \"profile\": true }" }), ", to see where each tick goes."));
      } else {
        const rows = record.profile.sections.slice(0, 14);
        const top = Math.max(...rows.map((row) => row.msPerTick), 0.001);
        const list = h("ul", { className: "pf-bars" });
        for (const row of rows) {
          const kind = row.afterTick ? "after" : row.nested ? "nested" : P.isRemainder(row.label) ? "rest" : "top";
          const fill = h("i");
          fill.style.width = `${Math.max(0.5, (Math.max(0, row.msPerTick) / top) * 100).toFixed(1)}%`;
          list.append(h("li", { className: kind, title: `${row.label}${row.afterTick ? " (after the tick)" : ""}: ${row.msPerTick} ms a tick` +
            `${row.pct !== null ? `, ${row.pct}% of it` : ""}${row.calls ? `, ${row.calls} calls${row.msPerCall !== null ? `, ${row.msPerCall} ms each` : ""}` : ""}` +
            `${row.nested ? "\ninside the row above, so it doesn't add to the total" : ""}` },
          h("span", { className: "pf-lab", text: `${row.nested ? "↳ " : ""}${row.label}` }),
          h("span", { className: "pf-bar" }, fill),
          h("span", { className: "pf-val", text: fmtMs(row.msPerTick).replace(" ms", "") }),
          h("span", { className: "pf-pct", text: row.pct === null ? "--" : `${Math.round(row.pct)}%` })));
        }
        sub.append(list);
      }
      wrap.append(sub);
      return wrap;
    }

    // The Summary tab's one line about the server, when the run has PERF lines.
    function perfStrip() {
      const { record } = perf();
      if (!record) return null;
      const o = record.overall;
      return h("button", { type: "button", className: `pf-strip ${budgetClass(o.tickP99Ms, record.budgetMs)}`, onclick: () => { state.itab = "perf"; renderInspector(); } },
        h("span", { className: "k", text: "Server tick" }),
        h("span", { className: "pf-sv", title: `${o.overBudget} ticks over the ${record.budgetMs} ms budget`,
          text: `p99 ${fmtMs(o.tickP99Ms)} · max ${fmtMs(o.tickMaxMs)} · ${o.overBudget} over` }),
        h("span", { className: "spacer" }), h("span", { className: "muted", text: "Perf ›" }));
    }

    function renderPerfCursor() {
      const svg = $("pf-chart");
      const cur = $("pf-cur");
      if (svg && cur && state.at !== null) {
        const from = Number(svg.dataset.from);
        const to = Number(svg.dataset.to);
        const f = Math.min(1, Math.max(0, (state.at - from) / Math.max(1, to - from)));
        const px = 34 + f * (352 - 34 - 6);
        cur.setAttribute("x1", px.toFixed(1));
        cur.setAttribute("x2", px.toFixed(1));
      }
      const table = $("pf-phases");
      if (table) {
        for (const row of table.tBodies[0].rows) {
          const from = Number(row.dataset.from);
          const to = Number(row.dataset.to);
          row.classList.toggle("cur", state.at !== null && state.at >= from && state.at < to);
        }
      }
    }

    function selectedBall(frame) {
      if (!frame) return null;
      const byID = new Map(frame.balls.map((ball) => [String(ball.id), ball]));
      if (state.selBall && byID.has(String(state.selBall))) return byID.get(String(state.selBall));
      const self = byID.get(String(frame.pos.selfID));
      if (self && self.target && byID.has(String(self.target))) return byID.get(String(self.target));
      return self || null;
    }

    function renderInspectorCursor() {
      if (state.view !== "workbench" || !state.runID) return;
      renderPerfCursor();
      const list = $("x-list");
      if (list) {
        let currentAt = -Infinity;
        for (const li of list.children) {
          const at = li.dataset.at === "" ? null : Number(li.dataset.at);
          if (at !== null && at <= state.at && at > currentAt) currentAt = at;
        }
        for (const li of list.children) {
          const at = li.dataset.at === "" ? null : Number(li.dataset.at);
          li.classList.toggle("next", at !== null && at === currentAt);
          li.classList.toggle("ahead", at !== null && at > state.at);
        }
      }
      const frame = state.model.frameAt(state.at);
      const onGrid = $("x-ongrid");
      if (onGrid) onGrid.textContent = frame ? String(frame.balls.filter((ball) => R.TRACKED.has(ball.kind)).length) : "-";
      const box = $("x-sel");
      if (!box) return;
      box.textContent = "";
      const ball = selectedBall(frame);
      if (!ball) return;
      const self = frame.balls.find((b) => b.id === frame.pos.selfID);
      const hp = state.model.hpAt(ball.id, state.at);
      const card = h("div", { className: "sel-card" });
      for (const [layer, name, cls] of [["shield", "Shield", "sh"], ["armor", "Armor", "ar"], ["hull", "Hull", "hu"]]) {
        const value = hp[layer];
        const fill = h("i");
        if (value !== null) fill.style.width = `${Math.max(0, Math.min(100, value))}%`;
        card.append(h("div", { className: "hp", title: value === null ? "the run has no DAMAGE on this layer" : "" }, h("span", { text: name }),
          h("span", { className: `hpbar ${cls}${value === null ? " unknown" : ""}` }, fill), h("b", { text: value === null ? "?" : `${Math.round(value)}%` })));
      }
      const lockedBy = frame.balls.filter((b) => Array.isArray(b.locks) && b.locks.includes(ball.id)).map((b) => (b.id === frame.pos.selfID ? "self" : b.label));
      const target = ball.target ? frame.balls.find((b) => b.id === Number(ball.target)) : null;
      card.append(h("div", { className: "kv" },
        self && ball !== self ? h("span", {}, "Range ", h("b", { text: R.distance(Math.hypot(ball.x - self.x, (ball.y || 0) - (self.y || 0), ball.z - self.z)) })) : null,
        ball.mode ? h("span", {}, "Mode ", h("b", { text: `${ball.mode}${target ? ` ${target.id === frame.pos.selfID ? "self" : target.label}` : ""}` })) : null,
        !ball.mode && target ? h("span", {}, "Target ", h("b", { text: target.id === frame.pos.selfID ? "self" : target.label })) : null,
        lockedBy.length ? h("span", {}, "Locked by ", h("b", { text: lockedBy.slice(0, 3).join(", ") })) : null));
      box.append(h("div", { className: "shead" }, h("h2", { text: "Selected" }),
        h("span", { className: "count", text: `${ball.id === frame.pos.selfID ? "self" : ball.label}${ball.type ? ` (${ball.type})` : ""} · ${ball.id}` })), card);
    }

    // ---------- the trace view ----------

    const window_ = () => {
      if (t0() === null) return [0, 1];
      const full = [t0(), Math.max(tEnd(), t0() + 1000)];
      if (!state.win) return full;
      return [Math.max(full[0], state.win[0]), Math.min(full[1], state.win[1])];
    };
    const pct = (at) => {
      const [v0, v1] = window_();
      return ((at - v0) / (v1 - v0)) * 100;
    };
    const inWin = (at, margin = 2) => {
      const p = pct(at);
      return p >= -margin && p <= 100 + margin;
    };

    function trRow(className, label, sub, area) {
      const lab = h("div", { className: "tr-lab" }, label, sub ? h("small", { text: sub }) : null);
      return h("div", { className: `tr-row ${className}` }, lab, area);
    }

    function gridLines(area, ticks) {
      for (const p of ticks) {
        const line = h("i", { className: "tr-grid" });
        line.style.left = `${p}%`;
        area.append(line);
      }
    }

    function place(node, at) {
      node.style.left = `${pct(at).toFixed(3)}%`;
      return node;
    }

    function renderTrace() {
      const box = $("trace");
      const scrollTop = box.scrollTop;
      box.textContent = "";
      if (t0() === null) {
        box.append(h("div", { className: "empty", text: state.runID ? "No events with a time yet." : "Pick a run." }));
        renderTraceCursor();
        return;
      }
      const [v0, v1] = window_();
      const step = R.niceStep(v1 - v0, 14);
      const ticks = [];
      const ruler = h("div", { className: "tr-area" });
      for (let ms = Math.ceil((v0 - t0()) / step) * step; t0() + ms <= v1; ms += step) {
        const p = pct(t0() + ms);
        ticks.push(p.toFixed(3));
        const tick = h("span", { className: "rt", text: R.axisLabel(ms, step) });
        tick.style.left = `${p}%`;
        if (p < 1) tick.style.transform = "none";
        ruler.append(tick);
      }
      box.append(trRow("ruler", null, null, ruler));

      // Expectations as flags, and the stop.
      const xs = expectations();
      const flags = h("div", { className: "tr-area" });
      gridLines(flags, ticks);
      let missingSlot = 0;
      xs.forEach((x, i) => {
        const flag = h("span", { className: `flag${x.ok ? "" : " miss"}`, title: `${i + 1}. ${x.text}${x.note ? `\n${x.note}` : ""}${x.at !== null ? `\n${R.offset(rel(x.at))}` : ""}`,
          onclick: (event) => { event.stopPropagation(); if (x.at !== null) seek(x.at); } }, h("b", { text: i + 1 }));
        if (x.at !== null) {
          if (!inWin(x.at, 0)) return;
          place(flag, x.at);
          flag.style.top = i % 2 ? "22px" : "2px";
        } else {
          if (x.ok) return;
          flag.style.left = "calc(100% - 12px)";
          flag.style.top = `${2 + (missingSlot++ % 2) * 20}px`;
        }
        flags.append(flag);
      });
      const sAt = stopAt();
      if (sAt !== null && inWin(sAt, 0)) {
        const result = state.detail && state.detail.result;
        flags.append(place(h("span", { className: "stopline" }, h("em", { text: result && result.stop && result.stop.reason === "until" ? "stop condition" : "stop" })), sAt));
      }
      const met = xs.filter((x) => x.ok).length;
      box.append(trRow("flags", h("b", { text: "Expectations" }), xs.length ? `${met} of ${xs.length} met` : "none", flags));

      // Frames, kept apart so they don't overlap; a pin marks each one's time.
      const frames = framesList().filter((frame) => frame.at !== null);
      if (frames.length) {
        const film = h("div", { className: "tr-area" });
        gridLines(film, ticks);
        const width = film.clientWidth || (box.clientWidth - 220) || 900;
        let nextFree = -Infinity;
        for (const frame of frames) {
          if (!inWin(frame.at, 0)) continue;
          const p = pct(frame.at);
          film.append(place(h("i", { className: "pin" }), frame.at));
          const leftPx = Math.max(p / 100 * width - 52, nextFree);
          nextFree = leftPx + 110;
          const fig = frameFigure(frame, { caption: false });
          fig.append(h("figcaption", { text: `t+${Math.round(rel(frame.at) / 1000)}${frame.stop ? " · stop" : ""}` }));
          fig.style.left = `${Math.max(0, leftPx)}px`;
          film.append(fig);
        }
        box.append(trRow("film", h("b", { text: "Frames" }), `${frames.length} SVG`, film));
      }

      // Server tick time: the worst tick per column, red over the budget.
      const { record: perfRecord, ticks: perfTicks } = perf();
      if (perfRecord && perfTicks.length) {
        const bins = 160;
        const worst = new Array(bins).fill(null);
        for (const tick of perfTicks) {
          const p = pct(tick.atMs);
          if (p < 0 || p > 100) continue;
          const index = Math.min(bins - 1, Math.floor((p / 100) * bins));
          worst[index] = worst[index] === null ? tick.ms : Math.max(worst[index], tick.ms);
        }
        const o = perfRecord.overall;
        const scale = niceCeil(Math.max(o.tickP99Ms * 1.6, o.tickAvgMs * 3, 1));
        const bars = h("div", { className: "bars" });
        const binMs = (v1 - v0) / bins;
        worst.forEach((value, index) => {
          const bar = h("i", { className: value === null ? "" : budgetClass(value, perfRecord.budgetMs),
            title: value === null ? "" : `${R.offset(rel(v0 + index * binMs))}  worst tick ${fmtMs(value)}` });
          bar.style.height = `${value === null ? 0 : Math.max(4, Math.min(100, (value / scale) * 100))}%`;
          bars.append(bar);
        });
        const area = h("div", { className: "tr-area" }, bars);
        box.append(trRow("dens srvtick", h("b", { text: "Server tick" }), `p99 ${fmtMs(o.tickP99Ms)} · max ${fmtMs(o.tickMaxMs)} · scale ${scale} ms`, area));
      }

      // One lane per ball.
      const { lanes, hidden } = state.model.lanes({ maxLanes: 40 });
      for (const lane of lanes) {
        const c = laneColour(lane);
        const area = h("div", { className: "tr-area" });
        gridLines(area, ticks);
        for (const span of lane.spans) {
          if (span.end < v0 || span.start > v1) continue;
          const node = h("span", { className: "span", text: span.text, title: `${span.text || "(no mode)"}  ${R.offset(rel(span.start))} - ${R.offset(rel(span.end))}` });
          node.style.setProperty("--c", c);
          const a = Math.max(0, pct(span.start));
          const b = Math.min(100, pct(span.end));
          node.style.left = `${a.toFixed(3)}%`;
          node.style.width = `${Math.max(0.15, b - a).toFixed(3)}%`;
          area.append(node);
        }
        let shown = 0;
        for (const mark of lane.marks) {
          if (!inWin(mark.at, 0) || shown > 1500) continue;
          shown += 1;
          const event = state.model.events[mark.index];
          const text = `${R.offset(rel(mark.at))}  ${event.kind}  ${R.summary(event).slice(0, 160)}`;
          const open = (e) => { e.stopPropagation(); selectEvent(mark.index); };
          if (mark.kind === "DESTROYED") area.append(place(h("b", { className: "xmk", text: "✕", title: text, onclick: open }), mark.at));
          else area.append(place(h("i", { className: `mk ${R.kindClass(event.kind)}${mark.kind === "UNTARGET" ? " dimmed" : ""}`, title: text, onclick: open }), mark.at));
        }
        const sw = h("span", { className: "sw" });
        sw.style.background = c;
        const row = trRow(`ent${lane.ids.some((id) => String(id) === String(state.selBall)) ? " sel" : ""}`, [sw, h("b", { text: lane.name, title: lane.name })], lane.sub, area);
        row.firstChild.addEventListener("click", () => { state.selBall = String(lane.ids[0]); renderTrace(); render(); });
        box.append(row);
      }
      if (!lanes.length) box.append(h("div", { className: "tr-more", text: state.model.positions.length ? "No ships or drones in the position samples." : "No position samples, so no lanes: watch with --positions, or use gridcheck run." }));
      if (hidden) box.append(h("div", { className: "tr-more", text: `${hidden} more ball(s) on grid not shown; the 40 above have the most to show.` }));

      // Divergences.
      const divs = state.model.events.map((event, index) => ({ event, index })).filter(({ event }) => event.kind === "DIVERGE");
      const divArea = h("div", { className: "tr-area" });
      gridLines(divArea, ticks);
      for (const { event, index } of divs) {
        if (!inWin(event.atMs, 0)) continue;
        divArea.append(place(h("span", { className: `divmk${event.status === "cleared" ? " cleared" : ""}`, text: `${event.status} ${event.reason} · ${event.label || event.itemID}`,
          title: `${R.offset(rel(event.atMs))}  ${R.summary(event)}`, onclick: (e) => { e.stopPropagation(); selectEvent(index); } }), event.atMs));
      }
      const open = divs.filter(({ event }) => event.status !== "cleared").length;
      box.append(trRow("divrow", h("b", { className: "divc", text: "Divergence" }), `${open} · server vs client`, divArea));

      // Log density.
      const logs = state.model.events.filter((event) => event.kind === "LOG");
      if (logs.length) {
        const bins = 120;
        const counts = new Array(bins).fill(0);
        for (const event of logs) {
          const p = pct(event.atMs);
          if (p < 0 || p > 100) continue;
          counts[Math.min(bins - 1, Math.floor((p / 100) * bins))] += 1;
        }
        const max = Math.max(1, ...counts);
        const bars = h("div", { className: "bars" });
        for (const n of counts) {
          const bar = h("i");
          bar.style.height = `${(n / max) * 100}%`;
          bars.append(bar);
        }
        const area = h("div", { className: "tr-area" }, bars);
        box.append(trRow("dens", h("b", { text: "Log lines" }), `${logs.length} · per ${R.seconds((v1 - v0) / bins)}`, area));
      }
      const overlay = h("div", { className: "tr-overlay" }, h("div", { className: "tcursor", id: "tr-cursor" }, h("b", { id: "tr-cursor-t" })));
      box.append(overlay);
      overlay.style.height = `${box.scrollHeight}px`;
      box.scrollTop = scrollTop;
      renderTraceCursor();
    }

    function renderTraceCursor() {
      const cursor = $("tr-cursor");
      if (cursor && state.at !== null) {
        const p = pct(state.at);
        cursor.hidden = p < 0 || p > 100;
        cursor.style.left = `${p}%`;
        $("tr-cursor-t").textContent = `t+${(rel(state.at) / 1000).toFixed(2)}`;
      }
    }

    function traceSeek(event) {
      const area = event.target.closest(".tr-area");
      if (!area || t0() === null) return false;
      const rect = area.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)));
      const [v0, v1] = window_();
      state.selEvent = -1;
      seek(v0 + f * (v1 - v0), { pause: false });
      return true;
    }

    function zoomTrace(kind, centreAt = state.at) {
      if (t0() === null) return;
      const full = [t0(), Math.max(tEnd(), t0() + 1000)];
      const [v0, v1] = window_();
      let span = v1 - v0;
      if (kind === "fit") {
        state.win = null;
      } else {
        span = kind === "in" ? span / 2 : span * 2;
        span = Math.max(500, Math.min(full[1] - full[0], span));
        const c = Number.isFinite(centreAt) ? centreAt : (v0 + v1) / 2;
        const f = v1 > v0 ? (c - v0) / (v1 - v0) : 0.5;
        let a = c - span * Math.min(1, Math.max(0, f));
        a = Math.max(full[0], Math.min(full[1] - span, a));
        state.win = span >= full[1] - full[0] ? null : [a, a + span];
      }
      renderTrace();
    }

    function panTrace(fraction) {
      if (!state.win) return;
      const full = [t0(), Math.max(tEnd(), t0() + 1000)];
      const span = state.win[1] - state.win[0];
      const a = Math.max(full[0], Math.min(full[1] - span, state.win[0] + span * fraction));
      state.win = [a, a + span];
      renderTrace();
    }

    function selectEvent(index) {
      state.selEvent = index;
      seek(state.model.events[index].atMs);
    }

    function cursorEventIndex() {
      if (state.selEvent >= 0 && state.model.events[state.selEvent] && Math.abs(state.model.events[state.selEvent].atMs - state.at) < 1) return state.selEvent;
      return state.model.indexAt(state.at, (event) => !R.HIDDEN_KINDS.has(event.kind) && event.kind !== "LOG");
    }

    function fieldValue(key, value) {
      if (value === null || value === undefined) return "-";
      if (/(^itemID$|ID$)/.test(key) && /^\d+$|^self$/.test(String(value))) {
        const label = state.model.label(value === "self" ? state.model.selfID : value);
        return label && label !== String(value) ? `${label}  ${value}` : String(value);
      }
      if (/Meters$/.test(key) && Number.isFinite(Number(value))) return R.distance(value);
      if (/Ms$/.test(key) && key !== "atMs" && Number.isFinite(Number(value)) && Number(value) < 1e11) return R.seconds(value);
      if (typeof value === "object") return JSON.stringify(value).slice(0, 300);
      return String(value);
    }

    function renderTraceBottom() {
      const pane = $("tr-event");
      pane.textContent = "";
      const index = cursorEventIndex();
      const events = state.model.events;
      const shown = events.filter((event) => !R.HIDDEN_KINDS.has(event.kind));
      if (index < 0) {
        pane.append(h("div", { className: "shead" }, h("h2", { text: "Event" })), h("p", { className: "note", text: state.runID ? "No event at or before the cursor." : "" }));
      } else {
        const event = events[index];
        const nth = shown.indexOf(event) + 1;
        const step = (dir) => {
          const list = events.map((e, i) => ({ e, i })).filter(({ e }) => !R.HIDDEN_KINDS.has(e.kind) && e.kind !== "LOG");
          const at = list.findIndex(({ i }) => i === index);
          const next = list[at + dir];
          if (next) selectEvent(next.i);
        };
        pane.append(h("div", { className: "shead" }, h("h2", { text: "Event" }), h("span", { className: `ek ${R.kindClass(event.kind)}`, text: event.kind }),
          h("span", { className: "count", text: `${R.offsetFine(rel(event.atMs))} · ${nth} of ${shown.length}` }),
          h("button", { type: "button", className: "btn sm", text: "◀", title: "Previous event", onclick: () => step(-1) }),
          h("button", { type: "button", className: "btn sm", text: "▶", title: "Next event", onclick: () => step(1) })));
        pane.append(h("p", { className: "note", text: R.summary(event) }));
        const skip = new Set(["kind", "seq", "t", "atMs", "summary_", "balls", "members"]);
        const rows = Object.entries(event).filter(([key, value]) => !skip.has(key) && value !== null && value !== undefined && value !== "")
          .slice(0, 18).map(([key, value]) => h("tr", {}, h("th", { text: key }), h("td", { className: /ID$/.test(key) ? "mono" : "", text: fieldValue(key, value) })));
        if (Array.isArray(event.members) && event.members.length) {
          rows.push(h("tr", {}, h("th", { text: "members" }), h("td", { text: event.members.slice(0, 8).map((m) => `${m.label || m.itemID}${m.distanceMeters !== undefined ? ` ${R.distance(m.distanceMeters)}` : ""}`).join(", ") })));
        }
        pane.append(h("table", { className: "kvt" }, h("tbody", {}, rows)));
        const raw = { ...event };
        delete raw.summary_;
        pane.append(h("pre", { text: JSON.stringify(raw, null, 2).slice(0, 4000) }));
      }

      const svc = $("tr-svc");
      svc.textContent = "";
      const { open, ahead } = state.model.divergenceAt(state.at);
      const start = events.find((event) => event.kind === "START");
      svc.append(h("div", { className: "shead" }, h("h2", { text: "Server vs client" }), h("span", { className: "count", text: `at cursor${start && start.clientMode ? ` · client view ${start.clientMode}` : ""}` })));
      if (open.length || ahead.length) {
        const rows = [h("tr", {}, h("th", { text: "Ball" }), h("th", { text: "Reason" }), h("th", { text: "Server" }), h("th", { text: "Client" }), h("th"))];
        for (const event of open) {
          rows.push(h("tr", { className: "clickable", onclick: () => selectEvent(events.indexOf(event)) }, h("td", { text: event.label || event.itemID }), h("td", { text: event.reason }),
            h("td", { text: event.serverMode || (event.errorMeters ? "position" : "-") }),
            h("td", { text: event.clientMode || (event.errorMeters ? `off ${R.distance(event.errorMeters)}` : "-") }), h("td", { className: "divc", text: "≠" })));
        }
        for (const event of ahead) {
          rows.push(h("tr", { className: "ahead clickable", title: "ahead of the cursor", onclick: () => selectEvent(events.indexOf(event)) },
            h("td", { text: `${event.label || event.itemID} @${Math.round(rel(event.atMs) / 1000)}` }), h("td", { text: `${event.status} ${event.reason}` }),
            h("td", { text: event.serverMode || "-" }), h("td", { text: event.clientMode || (event.errorMeters ? `off ${R.distance(event.errorMeters)}` : "-") }),
            h("td", { className: event.status === "cleared" ? "okc" : "divc", text: event.status === "cleared" ? "=" : "≠" })));
        }
        svc.append(h("table", { className: "svc" }, h("tbody", {}, rows)));
      }
      if (!open.length) {
        const any = state.model.counts.get("DIVERGE");
        svc.append(h("p", { className: "note", text: any ? "Nothing open at the cursor: what the client was sent agrees with the server here."
          : "No DIVERGE in this run: the client was sent what the server had." }));
      }
      const { rows: logs, nearest } = state.model.logNear(state.at, 2000, 8);
      svc.append(h("div", { className: "shead" }, h("h2", { text: "Log near cursor" }), h("span", { className: "count", text: "±2 s" })));
      if (!logs.length) svc.append(h("p", { className: "note", text: "No log lines within 2 s." }));
      svc.append(h("div", { className: "loglines mono" }, logs.map((event) => h("div", { className: event === nearest ? "cur" : "", title: event.text,
        text: `${(rel(event.atMs) / 1000).toFixed(2)} ${event.text}`, onclick: () => seek(event.atMs) }))));
    }

    function renderTraceBar() {
      const detail = state.detail;
      const result = detail && detail.result;
      const v = verdictOf(state.result || (result && { passed: result.passed === true, exitCode: result.exitCode }) || null, live());
      const verdict = $("tr-verdict");
      verdict.textContent = "";
      if (state.runID) verdict.append(badge(v));
      const stats = $("tr-stats");
      stats.textContent = "";
      if (!state.runID) return;
      const xs = expectations();
      const sAt = stopAt();
      const stopEvent = result && result.stop && result.stop.event;
      const d = divergeCount();
      stats.append(
        h("span", { className: "rb" }, h("span", { className: "lbl", text: "Expect" }), xs.length ? `${xs.filter((x) => x.ok).length}/${xs.length}` : "-"),
        h("span", { className: "rb" }, h("span", { className: "lbl", text: "Stop" }), sAt !== null ? `${R.offset(rel(sAt))}${stopEvent && stopEvent.kind ? ` ${stopEvent.kind}` : ""}` : "-"),
        h("span", { className: "rb" }, h("span", { className: "lbl", text: "Took" }), result && result.startedAtMs && result.stoppedAtMs ? R.seconds(result.stoppedAtMs - result.startedAtMs) : live() ? "running" : "-"),
        h("span", { className: "rb" }, h("span", { className: "lbl", text: "Diverge" }), h("b", { className: d ? "divc" : "", text: d })));
    }

    // ---------- rendering and the clock ----------

    // After new data: everything that depends on the events.
    function renderData() {
      renderChips();
      if (state.view === "workbench") {
        renderTrack();
        renderInspector();
      } else {
        renderTraceBar();
        renderTrace();
      }
      render();
    }

    // After the cursor moves.
    function render() {
      const atRel = rel(state.at);
      const total = t0() === null ? 0 : tEnd() - t0();
      const clock = $("wb-clock");
      clock.textContent = R.offset(atRel);
      clock.append(h("small", { text: ` / ${R.offset(total).slice(2)}` }));
      $("tr-clock").textContent = R.offsetFine(atRel);
      for (const button of document.querySelectorAll("#tab-runs [data-act='play']")) {
        button.textContent = state.playing ? (button.closest(".runbar") ? "❚❚" : "❚❚ Pause") : (button.closest(".runbar") ? "▶" : "▶ Play");
        button.classList.toggle("on", state.playing || Boolean(button.closest(".controls")));
      }
      for (const input of document.querySelectorAll("#tab-runs .follow")) input.checked = state.follow;
      if (!state.visible) return;
      if (state.view === "workbench") {
        $("wb-map-clock").textContent = R.offset(atRel);
        const drawn = drawMap("wb");
        $("wb-map-what").textContent = drawn.pos ? `Top-down · ${drawn.self ? "centred on self" : "centred on the first ball"}${drawn.pos.systemName ? ` · ${drawn.pos.systemName}` : ""}` : "Top-down";
        const f = total ? Math.min(1, Math.max(0, atRel / total)) : 0;
        const played = $("wb-played");
        if (played) {
          played.style.width = `${f * 100}%`;
          $("wb-playhead").style.left = `${f * 100}%`;
        }
        renderEventsCursor();
        renderInspectorCursor();
      } else {
        if (state.win && state.at !== null && (state.at < state.win[0] || state.at > state.win[1])) {
          const span = state.win[1] - state.win[0];
          const a = Math.max(t0(), Math.min(tEnd() - span, state.at - span * 0.1));
          state.win = [a, a + span];
          renderTrace();
        }
        $("tr-map-clock").textContent = R.offset(atRel);
        drawMap("tr");
        renderTraceCursor();
        renderTraceBottom();
      }
    }

    function seek(atMs, { pause = true } = {}) {
      if (t0() === null) return;
      state.at = Math.min(Math.max(atMs, t0()), tEnd());
      if (pause) setPlaying(false);
      if (state.at < tEnd()) state.follow = false;
      render();
    }

    let lastTick = 0;
    function setPlaying(on) {
      if (on && t0() === null) return;
      state.playing = on;
      if (on) {
        if (state.at >= tEnd() && !live()) state.at = t0();
        lastTick = performance.now();
        requestAnimationFrame(tick);
      }
      render();
    }

    function tick(nowMs) {
      if (!state.playing) return;
      const dt = nowMs - lastTick;
      lastTick = nowMs;
      state.at = Math.min(tEnd(), state.at + dt * state.speed);
      if (state.at >= tEnd() && !live()) {
        setPlaying(false);
        return;
      }
      render();
      requestAnimationFrame(tick);
    }

    function stepEvent(direction, kind = null) {
      const list = state.model.events.filter((event) => (kind ? event.kind === kind : visible(event)));
      const found = direction > 0
        ? list.find((event) => event.atMs > state.at + 1)
        : [...list].reverse().find((event) => event.atMs < state.at - 1);
      if (found) {
        state.selEvent = state.model.events.indexOf(found);
        seek(found.atMs);
      }
    }

    function act(name) {
      if (name === "play") setPlaying(!state.playing);
      else if (name === "start") seek(t0());
      else if (name === "prev") stepEvent(-1);
      else if (name === "next") stepEvent(1);
      else if (name === "diverge") stepEvent(1, "DIVERGE");
    }

    // ---------- views ----------

    function setView(view) {
      state.view = view === "trace" ? "trace" : "workbench";
      localStorage.setItem("e2eGuiView", state.view);
      for (const button of document.querySelectorAll("#view-switch [data-view]")) button.classList.toggle("on", button.dataset.view === state.view);
      $("runs-wb").hidden = state.view !== "workbench";
      $("runs-trace").hidden = state.view !== "trace";
      shell.saveHash();
      if (state.runID) renderData();
      else render();
    }

    function wire() {
      for (const box of document.querySelectorAll("#tab-runs .speed")) {
        for (const speed of SPEEDS) {
          box.append(h("button", { type: "button", "data-speed": speed, text: `${speed}×`, onclick: () => {
            state.speed = speed;
            for (const b of document.querySelectorAll("#tab-runs [data-speed]")) b.classList.toggle("on", Number(b.dataset.speed) === speed);
          } }));
        }
      }
      for (const b of document.querySelectorAll("#tab-runs [data-speed]")) b.classList.toggle("on", Number(b.dataset.speed) === state.speed);
      for (const prefix of ["wb", "tr"]) {
        const box = $(`${prefix}-zoom`);
        for (const [value, label] of ZOOMS) {
          box.append(h("button", { type: "button", "data-zoom": value, text: label, className: value === state.zoom ? "on" : "", onclick: () => {
            state.zoom = value;
            for (const b of document.querySelectorAll("#tab-runs [data-zoom]")) b.classList.toggle("on", b.dataset.zoom === value);
            render();
          } }));
        }
        const svg = $(`${prefix}-map`);
        svg.addEventListener("click", (event) => {
          const node = event.target.closest("[data-id]");
          state.selBall = node ? node.dataset.id : null;
          if (state.view === "trace") renderTrace();
          render();
        });
        new ResizeObserver(() => { if (state.visible) render(); }).observe($(`${prefix}-mapwrap`));
      }
      $("wb-legend").append(...[["self", "self"], ["drone", "drone"], ["hostile", "npc"], ["weapon", "weapon"], ["dmg", "damage"], ["div", "DIVERGE"]]
        .map(([cls, text]) => h("span", {}, h("i", { className: `lg ${cls}` }), text)));
      for (const button of document.querySelectorAll("#tab-runs [data-act]")) button.addEventListener("click", () => act(button.dataset.act));
      for (const input of document.querySelectorAll("#tab-runs .follow")) {
        input.addEventListener("change", () => {
          state.follow = input.checked;
          if (state.follow && live()) seek(tEnd(), { pause: false });
        });
      }
      for (const button of document.querySelectorAll("#view-switch [data-view]")) button.addEventListener("click", () => setView(button.dataset.view));
      for (const button of document.querySelectorAll("[data-tz]")) button.addEventListener("click", () => zoomTrace(button.dataset.tz));

      $("rail-filter").addEventListener("input", () => { state.filter = $("rail-filter").value.trim(); renderRail(); });
      for (const button of document.querySelectorAll("#rail-only [data-only]")) {
        button.addEventListener("click", () => {
          state.only = button.dataset.only;
          for (const b of document.querySelectorAll("#rail-only [data-only]")) b.classList.toggle("on", b === button);
          renderRail();
        });
      }
      $("wb-grep").addEventListener("input", () => {
        const text = $("wb-grep").value.trim();
        if (text === grepText) return;
        grepText = text;
        try {
          state.grep = text ? new RegExp(text, "i") : null;
          $("wb-grep").classList.remove("bad");
        } catch (_error) {
          $("wb-grep").classList.add("bad");
          return;
        }
        refilter();
      });
      $("wb-events").addEventListener("click", (event) => {
        const row = event.target.closest("[data-index]");
        if (row) selectEvent(Number(row.dataset.index));
      });
      $("tr-run").addEventListener("change", () => openRun($("tr-run").value));
      $("insp-refresh").addEventListener("click", () => { if (state.runID) openRun(state.runID); });

      const track = $("wb-track");
      track.addEventListener("pointerdown", (event) => {
        if (t0() === null) return;
        track.setPointerCapture(event.pointerId);
        trackSeek(event);
      });
      track.addEventListener("pointermove", (event) => { if (track.hasPointerCapture(event.pointerId)) trackSeek(event); });

      const trace = $("trace");
      let dragging = false;
      trace.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || event.target.closest(".mk, .xmk, .flag, .divmk, figure, .tr-lab")) return;
        if (traceSeek(event)) {
          dragging = true;
          trace.setPointerCapture(event.pointerId);
        }
      });
      trace.addEventListener("pointermove", (event) => { if (dragging) traceSeek(event); });
      trace.addEventListener("pointerup", () => { dragging = false; });
      trace.addEventListener("wheel", (event) => {
        if (event.ctrlKey || event.metaKey) {
          event.preventDefault();
          const area = trace.querySelector(".tr-area");
          let centre = state.at;
          if (area) {
            const rect = area.getBoundingClientRect();
            const [v0, v1] = window_();
            centre = v0 + Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * (v1 - v0);
          }
          zoomTrace(event.deltaY < 0 ? "in" : "out", centre);
        } else if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
          if (!state.win) return;
          event.preventDefault();
          panTrace(((event.shiftKey ? event.deltaY : event.deltaX) > 0 ? 1 : -1) * 0.15);
        }
      }, { passive: false });

      document.addEventListener("keydown", (event) => {
        if (!state.visible || !state.runID) return;
        if (event.target instanceof HTMLElement && event.target.closest("input, select, textarea, dialog[open]")) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const keys = { " ": "play", ArrowRight: "next", ArrowLeft: "prev", Home: "start", d: "diverge", D: "diverge" };
        if (event.key === "End") {
          event.preventDefault();
          seek(tEnd());
        } else if (keys[event.key]) {
          event.preventDefault();
          act(keys[event.key]);
        } else if (state.view === "trace" && (event.key === "+" || event.key === "=" || event.key === "-")) {
          zoomTrace(event.key === "-" ? "out" : "in");
        }
      });
    }

    // ---------- the shell's calls ----------

    async function load() {
      const key = shell.treeID();
      if (state.treeKey !== key) {
        state.treeKey = key;
        state.runs = [];
        try {
          state.colourRules = (await api(`/viewer/config?tree=${q(key)}`)).colours || [];
        } catch (_error) {
          state.colourRules = [];
        }
      }
      await loadRuns();
      if (state.runID && !state.runs.some((run) => run.runID === state.runID) && state.runs.length) state.runID = null;
      if (!state.runID && state.runs.length) state.runID = state.runs[0].runID;
      $("runs-empty").hidden = true;
      if (state.runID && state.detail === null && state.model.t0 === null) await openRun(state.runID);
      else if (!state.runID) {
        resetRun(null);
        renderInspector();
        renderData();
      }
    }

    function treeChanged() {
      shell.params.delete("run");
      state.treeKey = null;
      resetRun(null);
      state.openGroups.clear();
    }

    function show() {
      state.visible = true;
      $("view-switch").hidden = false;
      setView(state.view);
    }

    function hide() {
      state.visible = false;
      $("view-switch").hidden = true;
      setPlaying(false);
    }

    function context() {
      const result = state.detail && state.detail.result;
      const start = state.model.events.find((event) => event.kind === "START");
      return {
        world: result ? result.world || null : null,
        client: start ? start.clientMode || null : null,
        runsDir: state.detail ? state.detail.dir.replace(/\/[^/]+$/, "") : null,
      };
    }

    function tick15() {
      if (!state.visible) return;
      loadRuns().catch(() => {});
    }

    wire();
    setInterval(() => { if (state.visible && live() && !state.loading) pull(); }, 1000);
    setInterval(tick15, 15_000);

    return {
      load, treeChanged, show, hide, context,
      hashParts: () => [state.runID ? `run=${q(state.runID)}` : null, `view=${state.view}`].filter(Boolean),
    };
  }

  window.E2ERuns = { create };
})();
