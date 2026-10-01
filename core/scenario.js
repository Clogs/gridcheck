"use strict";

// `e2e run <scenario>`: scenario files, their checks, the run itself and its
// report. A scenario names a saved world, setup steps, stop conditions and
// expectations (tools/evejs-e2e/scenarios/*.json, and each plugin's
// plugins/<name>/scenarios/). Plugins add steps and `up` options through the
// registry (core/plugins.js). The server calls come in as `ops`, so the run
// can be tested without a server. Guide: docs/E2E-GRID-TESTING.md "Scenarios".

const fs = require("node:fs");
const path = require("node:path");

const { parseCondition } = require("./conditions");
const { defaultRegistry } = require("./plugins");
const { formatOffset, formatTimelineEvent } = require("./timeline");
const actionTools = require("./actions");

const SCENARIO_DIR = path.join(__dirname, "..", "scenarios");

// The bridge ends a watch after an hour (agentBridgeWatch LIMITS). The run
// watches for that hour and stops it itself; this leaves room for the setup
// calls themselves (a trigger may take 90 s).
const BUDGET_SECONDS = 3000;

const TOP_KEYS = new Set(["name", "description", "world", "up", "setup", "during", "watch", "until", "expect"]);
const CORE_UP_KEYS = ["market", "timeout"];
const WATCH_KEYS = new Set(["every", "offgridEvery", "client", "divergeMeters", "log", "grep"]);
const UNTIL_KEYS = new Set(["any", "timeout", "grace", "from"]);
const UNTIL_FROM = ["setup", "start"];
const EXPECT_KEYS = new Set(["match", "absent", "note"]);

// Core steps and the keys each takes. Player actions (actions.js) are steps
// too, in setup and in `during`. Plugin steps (registry.steps) take their own
// keys, plus "as" when they bind and "retry" when they may be tried again:
//   { binds, retries, keys(raw) -> [key], parse(raw, ctx) -> fields, describe(step), run(step, io) }
// ctx: problem(key|null, message), bound(value, key), resolveSystemID(text).
const ACTION_STEP_KEYS = (type) => {
  const spec = actionTools.ACTIONS[type];
  return [type, "as", "retry",
    ...(spec.target === "optional" ? ["target"] : []),
    ...["range", "once", "timeout", "charge", "count"].filter((key) => spec[key] !== undefined)];
};
const CORE_STEP_KEYS = {
  login: ["login"],
  undock: ["undock"],
  dock: ["dock"],
  slash: ["slash"],
  teleport: ["teleport"],
  wait: ["wait"],
  waitFor: ["waitFor", "timeout"],
  ...Object.fromEntries(actionTools.ACTION_TYPES.map((type) => [type, ACTION_STEP_KEYS(type)])),
};
// What a step keeps that is not a $value to bind at run time.
const STEP_OWN_KEYS = new Set(["type", "note", "as", "retry", "implicit", "action", "condition", "seconds", "plugin"]);
const DEFAULT_WAIT_FOR_SECONDS = 300;

class ScenarioError extends Error {
  constructor(source, problems) {
    super(`${source}:\n  ${problems.join("\n  ")}`);
    this.problems = problems;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;

// The plugin steps a registry adds, without any that would shadow a core step.
function pluginSteps(registry) {
  return Object.fromEntries(Object.entries(registry.steps).filter(([name]) => CORE_STEP_KEYS[name] === undefined));
}

function stepTypes(registry) {
  return [...Object.keys(CORE_STEP_KEYS), ...Object.keys(pluginSteps(registry))];
}

// A step with its $names replaced by the first ID each binding holds. Player
// actions resolve their own targets against the grid, so they are left alone.
function bindStep(step, bindings) {
  const resolve = (value) => {
    if (typeof value === "string") {
      if (!value.startsWith("$")) return value;
      const ids = bindings[value.slice(1)];
      if (!ids || !ids.length) throw new Error(`${value} is not bound yet`);
      return ids[0];
    }
    if (Array.isArray(value)) return value.map(resolve);
    if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, resolve(inner)]));
    return value;
  };
  const bound = { ...step };
  for (const [key, value] of Object.entries(step)) {
    if (!STEP_OWN_KEYS.has(key)) bound[key] = resolve(value);
  }
  return bound;
}

function suffixes(step) {
  return `${step.as ? ` as $${step.as}` : ""}` +
    `${step.retry ? ` (retry every ${step.retry.every}s for ${step.retry.for}s)` : ""}`;
}

function describeStep(step, registry = defaultRegistry()) {
  switch (step.type) {
    case "login": return `login${step.user ? ` ${step.user}` : ""}${step.name ? ` "${step.name}"` : ""}`;
    case "undock":
    case "dock": return step.type;
    case "slash": return `slash ${step.command}`;
    case "teleport": return `teleport ${step.system}`;
    case "wait": return `wait ${step.seconds}s`;
    case "waitFor": return `waitFor ${step.condition.text} (up to ${step.seconds}s)`;
    default: {
      if (step.action) return `${actionTools.describeAction(step.action)}${suffixes(step)}`;
      const spec = registry.steps[step.type];
      if (spec && typeof spec.describe === "function") {
        try {
          return `${spec.describe(step)}${suffixes(step)}`;
        } catch (_error) {
          // Fall back on the type.
        }
      }
      return step.type;
    }
  }
}

// The `up` options a scenario takes: the core's and the plugins' upFlags.
function upDefaults(registry) {
  const up = { market: true, timeout: null };
  for (const flag of registry.upFlags) up[flag.key] = flag.scenarioDefault === undefined ? null : flag.scenarioDefault;
  return up;
}

// raw JSON -> a checked scenario, or a ScenarioError listing every problem.
// `context.worldExists(name)` and `context.resolveSystemID(text)` come from
// the CLI, which knows the tree; tests pass stubs. `context.registry` is the
// plugins' (core/plugins.js), by default this tree's.
function validateScenario(raw, { source = "scenario", defaultName = null, worldExists = () => true,
  resolveSystemID = (text) => text, registry = defaultRegistry() } = {}) {
  const extraSteps = pluginSteps(registry);
  const types = stepTypes(registry);
  const problems = [];
  const problem = (where, message) => problems.push(`${where}: ${message}`);
  if (!isObject(raw)) throw new ScenarioError(source, ["a scenario is a JSON object"]);
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) problem(key, `unknown key; a scenario has ${[...TOP_KEYS].join(", ")}`);
  }

  const name = raw.name === undefined ? defaultName : raw.name;
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/.test(name)) {
    problem("name", "letters, digits, dot, dash and underscore only");
  }
  if (raw.description !== undefined && typeof raw.description !== "string") problem("description", "a string");

  if (typeof raw.world !== "string" || !raw.world) {
    problem("world", "the saved world to start from (e2e world list)");
  } else if (!worldExists(raw.world)) {
    problem("world", `no saved world "${raw.world}" in _local/e2e/worlds/ (e2e world list)`);
  }

  const up = upDefaults(registry);
  const upFlags = new Map(registry.upFlags.map((flag) => [flag.key, flag]));
  const upKeys = [...CORE_UP_KEYS, ...upFlags.keys()];
  if (raw.up !== undefined) {
    if (!isObject(raw.up)) {
      problem("up", "an object");
    } else {
      for (const [key, value] of Object.entries(raw.up)) {
        const flag = upFlags.get(key);
        if (!upKeys.includes(key)) problem(`up.${key}`, `unknown key; up takes ${upKeys.join(", ")}`);
        else if ((key === "market" || (flag && flag.type === "bool")) && typeof value !== "boolean") problem(`up.${key}`, "true or false");
        else if (flag && flag.type === "number" && !(typeof value === "number" && value >= flag.min && value <= flag.max)) {
          problem(`up.${key}`, `a number from ${flag.min} through ${flag.max}`);
        } else if (key === "timeout" && !positive(value)) problem("up.timeout", "seconds, above 0");
        else up[key] = value;
      }
    }
  }

  const watch = { every: 2, offgridEvery: 5, client: "diverge", divergeMeters: null, log: true, grep: null };
  if (raw.watch !== undefined) {
    if (!isObject(raw.watch)) {
      problem("watch", "an object");
    } else {
      for (const [key, value] of Object.entries(raw.watch)) {
        if (!WATCH_KEYS.has(key)) problem(`watch.${key}`, `unknown key; watch takes ${[...WATCH_KEYS].join(", ")}`);
        else if (key === "every" && !(positive(value) && value >= 0.5 && value <= 60)) problem("watch.every", "seconds, 0.5 through 60");
        else if ((key === "offgridEvery" || key === "divergeMeters") && !positive(value)) problem(`watch.${key}`, "a number above 0");
        else if (key === "client" && !["all", "fx", "diverge", "off"].includes(value)) problem("watch.client", "all, fx, diverge or off");
        else if (key === "log" && typeof value !== "boolean") problem("watch.log", "true or false");
        else if (key === "grep") {
          try {
            new RegExp(String(value), "i");
            watch.grep = String(value);
          } catch (error) {
            problem("watch.grep", error.message);
          }
        } else watch[key] = value;
      }
    }
  }

  // Conditions on what the watch leaves out could never match.
  const bindings = new Set();
  const condition = (where, text) => {
    try {
      const parsed = parseCondition(text, { bindings, registry });
      if (parsed.kind === "CLIENT" && watch.client !== "all") {
        problem(where, `CLIENT needs "watch": { "client": "all" } (now ${watch.client})`);
      } else if (parsed.kind === "FX" && !["all", "fx"].includes(watch.client)) {
        problem(where, `FX needs "watch": { "client": "fx" } or "all" (now ${watch.client})`);
      } else if (parsed.kind === "DIVERGE" && watch.client === "off") {
        problem(where, 'DIVERGE needs the client view; watch.client is "off"');
      } else if (parsed.kind === "LOG" && !watch.log) {
        problem(where, "LOG needs watch.log true");
      }
      return parsed;
    } catch (error) {
      problem(where, error.message);
      return null;
    }
  };

  let budget = 0;
  // Setup runs before the watch's stop conditions; `during` runs beside them,
  // so its waits are bounded by until.timeout and add nothing to the budget.
  const parseSteps = (list, key) => {
    const steps = [];
    const during = key === "during";
    const retryOf = (rawStep, step, where) => {
      if (rawStep.retry === undefined) return;
      const retry = rawStep.retry;
      if (!isObject(retry) || Object.keys(retry).some((name) => !["every", "for"].includes(name)) || !positive(retry.for) ||
          (retry.every !== undefined && !positive(retry.every))) {
        problem(`${where}.retry`, '{ "every": seconds (default 15), "for": seconds }');
      } else {
        step.retry = { every: retry.every || 15, for: retry.for };
        if (!during) budget += retry.for;
      }
    };
    list.forEach((entry, index) => {
      const where = `${key}[${index}]`;
      const rawStep = typeof entry === "string" ? { [entry]: true } : entry;
      if (!isObject(rawStep)) {
        problem(where, "a step name or an object");
        return;
      }
      const present = types.filter((type) => rawStep[type] !== undefined);
      if (present.length !== 1) {
        problem(where, present.length ? `one step per entry, not ${present.join(" and ")}` :
          `unknown step; steps are ${types.join(", ")}`);
        return;
      }
      const type = present[0];
      const plugin = extraSteps[type] || null;
      let allowed;
      if (plugin) {
        let keys = [];
        try {
          keys = typeof plugin.keys === "function" ? plugin.keys(rawStep) || [] : [];
        } catch (_error) {
          keys = [];
        }
        allowed = new Set([type, "note", ...(plugin.binds ? ["as"] : []), ...(plugin.retries ? ["retry"] : []), ...keys]);
      } else {
        allowed = new Set([...CORE_STEP_KEYS[type], "note"]);
      }
      for (const key of Object.keys(rawStep)) {
        if (allowed.has(key)) continue;
        const which = plugin && typeof rawStep[type] === "string" ? `${type} ${rawStep[type]}` : type;
        problem(`${where}.${key}`, `unknown key for ${which}`);
      }
      const bound = (value, key) => {
        if (typeof value !== "string" || !value.startsWith("$")) return;
        if (!bindings.has(value.slice(1))) problem(`${where}.${key}`, `no earlier step binds ${value} ("as": "${value.slice(1)}")`);
      };
      const bindAs = (step) => {
        if (rawStep.as === undefined) return;
        if (typeof rawStep.as !== "string" || !/^[A-Za-z_]\w*$/.test(rawStep.as)) problem(`${where}.as`, "a name: letters, digits, underscore");
        else {
          step.as = rawStep.as;
          bindings.add(rawStep.as);
        }
      };
      const value = rawStep[type];
      const step = { type, note: typeof rawStep.note === "string" ? rawStep.note : null };
      if (plugin) {
        step.plugin = plugin.plugin;
        let fields = null;
        try {
          fields = plugin.parse(rawStep, {
            problem: (key, message) => problem(key ? `${where}.${key}` : where, message),
            bound,
            resolveSystemID,
            during,
          });
        } catch (error) {
          problem(where, error.message);
        }
        if (isObject(fields)) {
          for (const [key, field] of Object.entries(fields)) if (!STEP_OWN_KEYS.has(key)) step[key] = field;
        }
        // A step the feature refuses for now (a flight still warping, no gang
        // in the system yet) can be tried again until it is accepted.
        if (plugin.retries) retryOf(rawStep, step, where);
        if (plugin.binds) bindAs(step);
        steps.push(step);
        return;
      }
      switch (type) {
        case "login":
          if (during) problem(where, "login is a setup step");
          else if (index !== 0) problem(where, "login is the first step, or left out (an implicit login runs first)");
          if (value !== true && !isObject(value)) problem(where, 'login: true, or { "user": ..., "name": ... }');
          if (isObject(value)) {
            for (const key of Object.keys(value)) if (!["user", "name"].includes(key)) problem(`${where}.login.${key}`, "unknown key; user or name");
            if (value.user !== undefined) step.user = String(value.user);
            if (value.name !== undefined) step.name = String(value.name);
          }
          break;
        case "undock":
        case "dock":
          if (value !== true) problem(where, `"${type}" or { "${type}": true }`);
          break;
        case "slash":
          if (typeof value !== "string" || !value.trim().startsWith("/")) problem(where, 'slash: "/command ..."');
          else step.command = value.trim();
          break;
        case "teleport":
          if (typeof value !== "string" && typeof value !== "number") {
            problem(where, "teleport: a system name or ID");
          } else {
            step.system = String(value);
            try {
              step.systemID = resolveSystemID(String(value));
            } catch (error) {
              problem(where, error.message);
            }
          }
          break;
        case "wait":
          if (!positive(value)) problem(where, "wait: seconds, above 0");
          else {
            step.seconds = value;
            if (!during) budget += value;
          }
          break;
        case "waitFor": {
          step.condition = condition(`${where}.waitFor`, value);
          const seconds = rawStep.timeout === undefined ? DEFAULT_WAIT_FOR_SECONDS : rawStep.timeout;
          if (!positive(seconds)) problem(`${where}.timeout`, "seconds, above 0");
          else {
            step.seconds = seconds;
            if (!during) budget += seconds;
          }
          break;
        }
        default: {
          // A player action: { "lock": "nearest npc", "as": "mark" },
          // { "activate": "weapons", "target": "$mark" }, "stop".
          const spec = actionTools.ACTIONS[type];
          const action = { type };
          const named = value === true ? null : value;
          if (named !== null && typeof named !== "string" && typeof named !== "number") {
            problem(where, `${type}: a ${spec.target === "required" ? "target" : spec.drones !== undefined ? "drone selection" : "module selection"} string`);
            break;
          }
          if (spec.target === "required") {
            if (named === null) problem(where, `${type} needs a target, e.g. "nearest npc", "flight=$fleet" or an itemID`);
            else action.target = String(named);
          } else if (spec.modules !== undefined) {
            action.modules = named === null ? spec.modules : String(named);
          } else if (spec.drones !== undefined) {
            action.drones = named === null ? spec.drones : String(named);
          } else if (named !== null) {
            problem(where, `"${type}" or { "${type}": true }`);
          }
          if (rawStep.target !== undefined) action.target = String(rawStep.target);
          for (const key of ["range", "timeout", "count"]) if (rawStep[key] !== undefined) action[key] = rawStep[key];
          if (rawStep.once !== undefined) action.once = rawStep.once === true;
          if (rawStep.charge !== undefined) action.charge = String(rawStep.charge);
          try {
            actionTools.checkAction(action);
            if (action.target !== undefined) {
              for (const name of actionTools.parseTargetSpec(action.target).bindings) bound(`$${name}`, "target");
            }
          } catch (error) {
            problem(where, error.message);
          }
          step.action = action;
          retryOf(rawStep, step, where);
          bindAs(step);
          break;
        }
      }
      steps.push(step);
    });
    return steps;
  };

  let setup = [];
  if (!Array.isArray(raw.setup)) {
    problem("setup", "a list of steps, e.g. [\"undock\", { \"teleport\": \"Amamake\" }]");
  } else {
    setup = parseSteps(raw.setup, "setup");
  }
  if (!setup.length || setup[0].type !== "login") setup.unshift({ type: "login", note: "implicit", implicit: true });
  let during = [];
  if (raw.during !== undefined) {
    if (!Array.isArray(raw.during)) problem("during", "a list of steps run after setup, beside the stop conditions");
    else during = parseSteps(raw.during, "during");
  }

  const until = { any: [], timeout: null, grace: 0, from: "setup" };
  if (!isObject(raw.until)) {
    problem("until", 'an object: { "any": ["DESTROYED self"], "timeout": 600 }');
  } else {
    for (const key of Object.keys(raw.until)) {
      if (!UNTIL_KEYS.has(key)) problem(`until.${key}`, `unknown key; until takes ${[...UNTIL_KEYS].join(", ")}`);
    }
    if (raw.until.any !== undefined && !Array.isArray(raw.until.any)) problem("until.any", "a list of conditions");
    for (const [index, text] of (Array.isArray(raw.until.any) ? raw.until.any : []).entries()) {
      const parsed = condition(`until.any[${index}]`, text);
      if (parsed) until.any.push(parsed);
    }
    if (!positive(raw.until.timeout)) problem("until.timeout", "seconds, above 0: every run stops by then");
    else until.timeout = raw.until.timeout;
    if (raw.until.grace !== undefined) {
      if (!(typeof raw.until.grace === "number" && raw.until.grace >= 0)) problem("until.grace", "seconds, 0 or more");
      else until.grace = raw.until.grace;
    }
    if (raw.until.from !== undefined) {
      if (!UNTIL_FROM.includes(raw.until.from)) {
        problem("until.from", `"setup" (the default: only events after setup ends) or "start" (every event since the watch began)`);
      } else {
        until.from = raw.until.from;
      }
    }
    budget += (until.timeout || 0) + until.grace;
  }

  const expect = [];
  if (!Array.isArray(raw.expect) || !raw.expect.length) {
    problem("expect", "a list of at least one expected observation");
  } else {
    raw.expect.forEach((entry, index) => {
      const where = `expect[${index}]`;
      let text;
      let absent = false;
      let note = null;
      if (typeof entry === "string") {
        text = entry;
      } else if (isObject(entry)) {
        for (const key of Object.keys(entry)) if (!EXPECT_KEYS.has(key)) problem(`${where}.${key}`, "unknown key; match, absent or note");
        text = entry.match;
        if (entry.absent !== undefined && typeof entry.absent !== "boolean") problem(`${where}.absent`, "true or false");
        absent = entry.absent === true;
        if (entry.note !== undefined) note = String(entry.note);
      } else {
        problem(where, 'a condition string, or { "match": ..., "absent": true, "note": ... }');
        return;
      }
      if (typeof text === "string" && /^no\s+/i.test(text.trim())) {
        absent = true;
        text = text.trim().replace(/^no\s+/i, "");
      }
      const parsed = condition(where, text);
      if (parsed) expect.push({ condition: parsed, absent, note, text: `${absent ? "no " : ""}${parsed.text}` });
    });
  }

  if (budget > BUDGET_SECONDS) {
    problem("until.timeout", `waits, waitFor timeouts, until.timeout and grace add up to ${budget} s; ` +
      `a run fits in ${BUDGET_SECONDS} s (one bridge watch)`);
  }
  if (problems.length) throw new ScenarioError(source, problems);
  return { name, description: raw.description || "", world: raw.world, up, setup, during, watch, until, expect,
    bindings: [...bindings] };
}

// The folders scenarios live in: the core's, then each plugin's.
function scenarioDirs({ dir = SCENARIO_DIR, registry = defaultRegistry() } = {}) {
  return [{ plugin: null, dir }, ...registry.scenarioDirs];
}

// A bare name is a file in the first folder that has it; a path is a path.
function scenarioPath(nameOrPath, context = {}) {
  const text = String(nameOrPath || "");
  if (text.endsWith(".json") || text.includes("/") || text.includes("\\")) return path.resolve(text);
  const dirs = scenarioDirs(context);
  const found = dirs.map(({ dir }) => path.join(dir, `${text}.json`)).find((file) => fs.existsSync(file));
  return found || path.join(dirs[0].dir, `${text}.json`);
}

function loadScenario(nameOrPath, context = {}) {
  const file = scenarioPath(nameOrPath, context);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new ScenarioError(file, [error.code === "ENOENT" ? "no such scenario file" : `not valid JSON: ${error.message}`]);
  }
  const scenario = validateScenario(raw, { ...context, source: file, defaultName: path.basename(file, ".json") });
  return { file, scenario };
}

// Every scenario in every folder; a name the core has hides a plugin's.
function listScenarios(context = {}) {
  const rows = [];
  const seen = new Set();
  for (const { plugin, dir } of scenarioDirs(context)) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith(".json")).sort();
    } catch (_error) {
      continue;
    }
    for (const name of names) {
      const scenarioName = path.basename(name, ".json");
      if (seen.has(scenarioName)) continue;
      seen.add(scenarioName);
      const file = path.join(dir, name);
      try {
        const raw = JSON.parse(fs.readFileSync(file, "utf8"));
        rows.push({ name: scenarioName, file, plugin, description: String(raw.description || ""), world: raw.world });
      } catch (error) {
        rows.push({ name: scenarioName, file, plugin, description: `(unreadable: ${error.message})` });
      }
    }
  }
  return rows;
}

// ---------- the run ----------

function timer(ms, value) {
  let id = null;
  const promise = new Promise((resolve) => { id = setTimeout(() => resolve(value), Math.max(0, ms)); });
  return { promise, cancel: () => clearTimeout(id) };
}

function abortPromise(signal, value) {
  if (!signal) return { promise: new Promise(() => {}), cancel() {} };
  if (signal.aborted) return { promise: Promise.resolve(value), cancel() {} };
  let listener = null;
  const promise = new Promise((resolve) => {
    listener = () => resolve(value);
    signal.addEventListener("abort", listener, { once: true });
  });
  return { promise, cancel: () => signal.removeEventListener("abort", listener) };
}

async function race(entries) {
  try {
    return await Promise.race(entries.map((entry) => entry.promise));
  } finally {
    for (const entry of entries) entry.cancel();
  }
}

// ops:
//   up(scenario)                  boot the scenario's world; throws on failure
//   step(step, bindings)          one login, undock, dock, slash, teleport,
//                                 action or plugin step -> { ok, text, ids? }
//   startWatch(onEvent)           -> { push(event), stop(): Promise, ended: Promise<{ reason, error }> }
//   down()                        stop the server
async function runScenario(scenario, ops, { now = Date.now, signal = null, log = () => {} } = {}) {
  const events = [];
  const steps = [];
  const bindings = {};
  const waiters = new Set();
  const ctx = { bindings };
  let watch = null;
  let failure = null;
  let stop = null;
  const startedAtMs = now();

  const onEvent = (event) => {
    events.push(event);
    for (const waiter of waiters) {
      if (!waiter.accept(event)) continue;
      const hit = waiter.conditions.find((condition) => condition.test(event, ctx));
      if (hit) waiter.resolve({ type: "match", condition: hit, event });
    }
  };
  const waitFor = (conditions, sinceIndex, accept = () => true) => {
    for (const event of events.slice(sinceIndex)) {
      if (!accept(event)) continue;
      const hit = conditions.find((condition) => condition.test(event, ctx));
      if (hit) return { promise: Promise.resolve({ type: "match", condition: hit, event }), cancel() {} };
    }
    const waiter = { conditions, accept };
    const promise = new Promise((resolve) => { waiter.resolve = resolve; });
    waiters.add(waiter);
    return { promise, cancel: () => waiters.delete(waiter) };
  };
  const watchEnded = () => ({
    promise: watch.ended.then((ended) => ({ type: "ended", ...ended })),
    cancel() {},
  });
  const interrupted = () => abortPromise(signal, { type: "interrupted" });
  const runnerEvent = (event) => {
    if (watch) watch.push({ source: "runner", atMs: now(), ...event });
  };
  // `during` steps end when the run stops (stop condition, timeout, failure).
  let runStopped = false;
  let releaseStop = () => {};
  const stopGate = new Promise((resolve) => { releaseStop = resolve; });
  const stoppedEntry = () => ({ promise: stopGate.then(() => ({ type: "stopped" })), cancel() {} });
  let duringFailure = null;
  let failDuring = () => {};
  const duringFailed = new Promise((resolve) => { failDuring = resolve; });

  async function runStep(step, index, phase = "setup") {
    const during = phase === "during";
    const list = during ? scenario.during || [] : scenario.setup;
    const label = describeStep(step);
    const record = { index, phase, step: label, type: step.type, note: step.note, startedAtMs: now(), ok: false, text: "" };
    steps.push(record);
    log(`${during ? "during" : "step"} ${index + 1}/${list.length}: ${label}`);
    const stops = during ? [stoppedEntry()] : [];
    const otherwise = (type) => (type === "ended" ? "the watch ended" : type === "stopped" ? "the run stopped first" : "interrupted");
    try {
      if (step.type === "wait") {
        const outcome = await race([timer(step.seconds * 1000, { type: "done" }), ...(watch ? [watchEnded()] : []), interrupted(), ...stops]);
        record.ok = outcome.type === "done";
        record.stopped = outcome.type === "stopped";
        record.text = record.ok ? `waited ${step.seconds}s` : otherwise(outcome.type);
      } else if (step.type === "waitFor") {
        const outcome = await race([waitFor([step.condition], events.length),
          timer(step.seconds * 1000, { type: "timeout" }), watchEnded(), interrupted(), ...stops]);
        record.ok = outcome.type === "match";
        record.stopped = outcome.type === "stopped";
        record.text = record.ok
          ? `seen: ${formatTimelineEvent(outcome.event)}`
          : outcome.type === "timeout" ? `not seen in ${step.seconds}s` : otherwise(outcome.type);
      } else {
        const attempt = () => race([
          { promise: Promise.resolve().then(() => ops.step(bindStep(step, bindings), bindings))
            .then((result) => ({ type: "done", result }), (error) => ({ type: "refused", error })), cancel() {} },
          interrupted(),
          ...stops,
        ]);
        let outcome = await attempt();
        let attempts = 1;
        while (step.retry && (outcome.type === "refused" || (outcome.type === "done" && outcome.result.ok === false)) &&
            now() - record.startedAtMs + step.retry.every * 1000 <= step.retry.for * 1000) {
          const why = outcome.type === "refused" ? outcome.error.message : outcome.result.text;
          log(`${label}: refused (${String(why || "").split(/\r?\n/)[0]}); again in ${step.retry.every}s`);
          const paused = await race([timer(step.retry.every * 1000, { type: "done" }), ...(watch ? [watchEnded()] : []), interrupted(),
            ...stops]);
          if (paused.type !== "done") {
            outcome = paused;
            break;
          }
          outcome = await attempt();
          attempts += 1;
        }
        if (outcome.type === "refused") throw outcome.error;
        if (outcome.type === "ended" || outcome.type === "interrupted" || outcome.type === "stopped") {
          record.stopped = outcome.type === "stopped";
          record.text = otherwise(outcome.type);
        } else {
          record.ok = outcome.result.ok !== false;
          record.text = `${outcome.result.text || ""}${attempts > 1 ? ` (attempt ${attempts})` : ""}`;
          if (step.as && record.ok) {
            const ids = outcome.result.ids || [];
            bindings[step.as] = ids;
            record.bound = { [step.as]: ids };
            if (!ids.length) {
              record.ok = false;
              record.text = `${record.text}\nthe reply named no ID to bind as $${step.as}`.trim();
            }
          }
        }
      }
    } catch (error) {
      record.ok = false;
      record.text = error.message;
    }
    record.ms = now() - record.startedAtMs;
    if (!(during && runStopped)) {
      runnerEvent({ kind: "STEP", index, ...(during ? { phase } : {}), step: label, ok: record.ok,
        text: record.text.split("\n")[0] });
    }
    if (!record.ok && !record.stopped) {
      if (!during) {
        failure = { stage: "setup", step: label, error: record.text };
      } else if (!runStopped) {
        duringFailure = { stage: "during", step: label, error: record.text };
        failDuring({ type: "during-failed" });
      }
    }
    return record.ok;
  }

  try {
    try {
      await ops.up(scenario);
    } catch (error) {
      failure = { stage: "up", error: error.message };
    }
    if (!failure && await runStep(scenario.setup[0], 0)) {
      try {
        watch = await ops.startWatch(onEvent);
      } catch (error) {
        failure = { stage: "watch", error: error.message };
      }
      for (let index = 1; watch && !failure && index < scenario.setup.length; index += 1) {
        await runStep(scenario.setup[index], index);
      }
      if (watch && !failure) {
        const untilStartedAtMs = now();
        const duringRun = (async () => {
          for (let index = 0; index < (scenario.during || []).length && !runStopped; index += 1) {
            if (!await runStep(scenario.during[index], index, "during")) break;
          }
        })();
        const entries = [timer(scenario.until.timeout * 1000, { type: "timeout" }), watchEnded(), interrupted(),
          { promise: duringFailed, cancel() {} }];
        if (scenario.until.any.length) {
          // The watch reorders lines for 1.5 s before delivering them, so an
          // event that happened during setup can arrive after it; judge by the
          // event's own time, not its arrival.
          const afterSetup = (event) => !Number.isFinite(event.atMs) || event.atMs >= untilStartedAtMs;
          entries.unshift(scenario.until.from === "start"
            ? waitFor(scenario.until.any, 0)
            : waitFor(scenario.until.any, 0, afterSetup));
        }
        const outcome = await race(entries);
        stop = {
          reason: outcome.type === "match" ? "until" : outcome.type === "ended" ? "watch-ended" : outcome.type,
          condition: outcome.type === "match" ? outcome.condition.text : null,
          event: outcome.type === "match" ? outcome.event : null,
          waitedMs: now() - untilStartedAtMs,
          watchEnd: outcome.type === "ended" ? outcome.reason : null,
          error: outcome.type === "ended" ? outcome.error || null : null,
        };
        if (outcome.type === "ended") failure = { stage: "watch", error: `the watch ended early (${outcome.reason})${outcome.error ? `: ${outcome.error}` : ""}` };
        if (outcome.type === "interrupted") failure = { stage: "until", error: "interrupted" };
        if (outcome.type === "during-failed") failure = duringFailure;
        if (outcome.type === "match" && scenario.until.grace > 0) {
          log(`stop condition met: ${outcome.condition.text}; watching ${scenario.until.grace}s more`);
          await race([timer(scenario.until.grace * 1000, { type: "done" }), watchEnded(), interrupted()]);
        }
        runStopped = true;
        releaseStop();
        await duringRun;
      }
    }
  } catch (error) {
    failure = failure || { stage: "run", error: error.message };
  } finally {
    runStopped = true;
    releaseStop();
    if (!stop) stop = { reason: failure ? `${failure.stage}-failed` : "unknown", condition: null, event: null };
    if (watch) {
      runnerEvent({ kind: "STOP", reason: stop.reason, condition: stop.condition, matchedSeq: stop.event ? stop.event.seq : null });
      try {
        await watch.stop();
      } catch (error) {
        failure = failure || { stage: "watch", error: error.message };
      }
    }
    waiters.clear();
  }

  let down = { ok: true, error: null };
  try {
    await ops.down();
  } catch (error) {
    down = { ok: false, error: error.message };
    failure = failure || { stage: "down", error: error.message };
  }

  const expectations = scenario.expect.map((entry) => {
    const matches = events.filter((event) => entry.condition.test(event, ctx));
    return {
      text: entry.text,
      note: entry.note,
      absent: entry.absent,
      met: entry.absent ? matches.length === 0 : matches.length > 0,
      count: matches.length,
      first: matches[0] || null,
    };
  });
  const until = scenario.until.any.map((condition) => ({
    text: condition.text,
    fired: stop.reason === "until" && stop.condition === condition.text,
  }));
  const missing = expectations.filter((row) => !row.met).length;
  return {
    name: scenario.name,
    world: scenario.world,
    startedAtMs,
    stoppedAtMs: now(),
    watchStartedAtMs: (events.find((event) => event.kind === "START") || {}).atMs || null,
    stop,
    failure,
    down,
    steps,
    bindings,
    until,
    expectations,
    missing,
    eventCount: events.length,
    events,
    passed: !failure && missing === 0,
  };
}

function exitCodeFor(result) {
  if (result.failure) return 2;
  return result.missing ? 1 : 0;
}

// ---------- the report ----------

function cell(text) {
  return String(text === null || text === undefined ? "" : text).replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function code(text) {
  const value = cell(text);
  return value ? `\`${value.replace(/`/g, "'")}\`` : "";
}

function stopText(result) {
  const stop = result.stop || {};
  const at = stop.event ? ` at ${formatOffset(stop.event.t)}` : "";
  switch (stop.reason) {
    case "until": return `stop condition ${code(stop.condition)} met${at}`;
    case "timeout": return `no stop condition met; timed out after ${Math.round((stop.waitedMs || 0) / 1000)} s`;
    case "watch-ended": return `the watch ended early (${stop.watchEnd || "?"})`;
    case "interrupted": return "interrupted";
    default: return result.failure ? `${result.failure.stage} failed` : String(stop.reason || "?");
  }
}

// How a scenario's `up` options read in its report: each plugin flag's own
// words, then the core's.
function upText(up = {}, registry = defaultRegistry()) {
  const parts = [];
  for (const flag of registry.upFlags) {
    const value = up[flag.key];
    if (value === undefined || value === null || (flag.type === "number" && !value)) continue;
    try {
      parts.push(typeof flag.describe === "function" ? flag.describe(value) : `${flag.key} ${value}`);
    } catch (_error) {
      parts.push(`${flag.key} ${value}`);
    }
  }
  if (up.market === false) parts.push("no market");
  return parts.filter(Boolean).join(", ");
}

function renderReport(result, { runID, scenario, scenarioFile = null, timelineFile = "timeline.jsonl",
  framesSection = null, commit = null, registry = defaultRegistry() } = {}) {
  const met = result.expectations.filter((row) => row.met).length;
  const verdict = result.failure ? "DID NOT COMPLETE" : result.missing ? "FAILED" : "PASSED";
  const lines = [];
  lines.push(`# Scenario ${result.name}: ${verdict}`, "");
  if (scenario && scenario.description) lines.push(scenario.description, "");
  lines.push(`${met} of ${result.expectations.length} expectations met. ${stopText(result)}.`, "");
  if (result.failure) {
    lines.push(`**${result.failure.stage} failed**${result.failure.step ? ` at \`${result.failure.step}\`` : ""}: ` +
      `${cell(result.failure.error)}`, "");
  }
  const upLine = upText(scenario ? scenario.up : {}, registry);
  lines.push("| | |", "| --- | --- |");
  lines.push(`| Run | \`${cell(runID)}\` |`);
  if (scenarioFile) lines.push(`| Scenario | \`${cell(scenarioFile)}\` |`);
  if (commit) lines.push(`| Commit | \`${cell(commit.sha)}\`${commit.dirty ? " plus uncommitted changes" : ""} |`);
  lines.push(`| World | ${cell(result.world)}${upLine ? ` (${cell(upLine)})` : ""} |`);
  lines.push(`| Started | ${new Date(result.startedAtMs).toISOString()} |`);
  lines.push(`| Took | ${Math.round((result.stoppedAtMs - result.startedAtMs) / 1000)} s, server boot and shutdown included |`);
  lines.push(`| Stopped | ${stopText(result)} |`);
  lines.push(`| Events | ${result.eventCount}, all in \`${cell(timelineFile)}\` |`);
  if (!result.down.ok) lines.push(`| Shutdown | failed: ${cell(result.down.error)} |`);
  lines.push("");

  lines.push("## Expected against observed", "");
  lines.push("| Result | Expected | Observed |", "| --- | --- | --- |");
  for (const row of result.expectations) {
    const result_ = row.absent ? (row.met ? "clean" : "SEEN") : (row.met ? "met" : "MISSING");
    const expected = `${code(row.text)}${row.note ? ` ${cell(row.note)}` : ""}`;
    const observed = row.first
      ? `${code(formatTimelineEvent(row.first))}${row.count > 1 ? ` (${row.count} matches)` : ""}`
      : row.absent ? "none" : "not seen";
    lines.push(`| ${result_} | ${expected} | ${observed} |`);
  }
  lines.push("");

  lines.push("## Stop conditions", "");
  for (const row of result.until) lines.push(`- ${code(row.text)}${row.fired ? ` **fired** at ${formatOffset(result.stop.event.t)}` : ""}`);
  if (scenario) {
    if (result.until.length) {
      lines.push(scenario.until.from === "start"
        ? "- matched against every event since the watch began, setup included"
        : "- matched only against events after setup ended");
    }
    lines.push(`- timeout ${scenario.until.timeout} s after setup${result.stop.reason === "timeout" ? " **reached**" : ""}`);
    if (scenario.until.grace) lines.push(`- then ${scenario.until.grace} s more, for what follows`);
  }
  lines.push("");
  if (framesSection) lines.push(framesSection);

  const stepTable = (title, rows, intro) => {
    lines.push(`## ${title}`, "");
    if (intro) lines.push(intro, "");
    lines.push("| # | t | Step | Result |", "| --- | --- | --- | --- |");
    for (const step of rows) {
      const bound = step.bound ? ` ${Object.entries(step.bound).map(([key, ids]) => `$${key}=${ids.join(",")}`).join(" ")}` : "";
      const at = result.watchStartedAtMs && step.startedAtMs >= result.watchStartedAtMs
        ? formatOffset(step.startedAtMs - result.watchStartedAtMs) : "-";
      const verdict = step.ok ? "ok" : step.stopped ? "stopped" : "**failed**";
      lines.push(`| ${step.index + 1} | ${at} | ${code(step.step)} | ${verdict}: ${cell(step.text)}${cell(bound)} |`);
    }
    lines.push("");
  };
  stepTable("Setup", result.steps.filter((step) => step.phase !== "during"));
  const duringSteps = result.steps.filter((step) => step.phase === "during");
  if (duringSteps.length || (scenario && scenario.during && scenario.during.length)) {
    stepTable("During", duringSteps, "Player actions and waits run after setup, beside the stop conditions. " +
      "What they caused is in the timeline below.");
  }

  lines.push("## Timeline", "");
  lines.push("```text");
  for (const event of result.events) lines.push(formatTimelineEvent(event));
  lines.push("```", "");
  return lines.join("\n");
}

// The machine-readable summary beside report.md, without the events, which
// are in timeline.jsonl.
function resultRecord(result, { runID, scenarioFile }) {
  const { events, ...rest } = result;
  return {
    runID,
    scenarioFile,
    ...rest,
    expectations: result.expectations.map((row) => ({ ...row, first: row.first ? { seq: row.first.seq, t: row.first.t, kind: row.first.kind } : null })),
    stop: { ...result.stop, event: result.stop && result.stop.event ? { seq: result.stop.event.seq, t: result.stop.event.t, kind: result.stop.event.kind } : null },
    exitCode: exitCodeFor(result),
  };
}

module.exports = {
  BUDGET_SECONDS,
  SCENARIO_DIR,
  ScenarioError,
  bindStep,
  describeStep,
  exitCodeFor,
  listScenarios,
  loadScenario,
  renderReport,
  resultRecord,
  runScenario,
  scenarioDirs,
  scenarioPath,
  stepTypes,
  upDefaults,
  upText,
  validateScenario,
};
