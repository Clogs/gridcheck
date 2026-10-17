"use strict";

// check-ui: assertions on the client's UI state (agent.py op_ui_state), and a
// wait until one holds, optionally for a stable stretch. A snapshot the agent
// cut short can't prove a count or an absence, so it fails the check.

const SELECTOR_KEYS = ["path", "cls", "name", "text", "exact"];
const CHECK_KEYS = ["selector", "count", "visible", "enabled", "focused", "modal", "fullscreen", "scene",
  "minWidth", "minHeight", "withinDesktop", "opacityMin", "opacityMax"];
const BOOLEAN_CHECKS = ["enabled", "focused", "modal", "fullscreen", "scene", "withinDesktop"];
// The check's key, and the node field it reads.
const NODE_FIELDS = [["enabled", "effectiveEnabled"], ["fullscreen", "fullscreen"], ["scene", "scenePresent"]];
const MAX_WAIT_SECONDS = 300;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Throws on anything check-ui wouldn't understand; returns the spec.
function validateCheck(spec) {
  if (!isObject(spec)) throw new Error("a UI check is an object: { \"selector\": { \"name\": ... }, ... }");
  for (const key of Object.keys(spec)) {
    if (!CHECK_KEYS.includes(key)) throw new Error(`unknown UI check key ${key}; ${CHECK_KEYS.join(", ")}`);
  }
  const selector = spec.selector;
  if (!isObject(selector)) throw new Error("a UI check needs a selector: { \"path\" | \"cls\" | \"name\" | \"text\": ..., \"exact\"?: true }");
  for (const [key, value] of Object.entries(selector)) {
    if (!SELECTOR_KEYS.includes(key)) throw new Error(`unknown selector key ${key}; ${SELECTOR_KEYS.join(", ")}`);
    if (key === "exact" ? typeof value !== "boolean" : typeof value !== "string" || !value) {
      throw new Error(key === "exact" ? "selector exact: true or false" : `selector ${key}: text`);
    }
  }
  if (!["path", "cls", "name", "text"].some((key) => selector[key])) throw new Error("the selector needs a path, cls, name or text");
  if (spec.visible !== undefined && spec.visible !== "any" && typeof spec.visible !== "boolean") {
    throw new Error("visible: true, false or \"any\"");
  }
  for (const key of BOOLEAN_CHECKS) {
    if (spec[key] !== undefined && typeof spec[key] !== "boolean") throw new Error(`${key}: true or false`);
  }
  if (spec.count !== undefined && !(Number.isInteger(spec.count) && spec.count >= 0 && spec.count <= 20000)) {
    throw new Error("count: a whole number from 0 through 20000");
  }
  for (const key of ["minWidth", "minHeight"]) {
    if (spec[key] !== undefined && !(Number.isFinite(spec[key]) && spec[key] >= 0)) throw new Error(`${key}: pixels, 0 or more`);
  }
  for (const key of ["opacityMin", "opacityMax"]) {
    if (spec[key] !== undefined && !(Number.isFinite(spec[key]) && spec[key] >= 0 && spec[key] <= 1)) throw new Error(`${key}: 0 through 1`);
  }
  if (spec.opacityMin !== undefined && spec.opacityMax !== undefined && spec.opacityMin > spec.opacityMax) {
    throw new Error("opacityMin is above opacityMax");
  }
  return spec;
}

function selected(node, selector) {
  return Object.entries(selector).every(([key, wanted]) => {
    if (key === "exact") return true;
    const actual = String(node[key] ?? "");
    return key === "path" || selector.exact ? actual === wanted : actual.toLowerCase().includes(wanted.toLowerCase());
  });
}

function inside(rect, outer) {
  if (!rect || !outer) return null;
  return rect[0] >= outer[0] && rect[1] >= outer[1] && rect[0] + rect[2] <= outer[0] + outer[2] && rect[1] + rect[3] <= outer[1] + outer[3];
}

// One snapshot against one check: { ok, matched, failures, matches, matchKey, focus, modal, session, truncated }.
// visible defaults to true: only shown nodes count, so a closed but kept window has count 0.
function checkUi(snapshot, spec) {
  validateCheck(spec);
  if (!snapshot || snapshot.schema !== 1 || !Array.isArray(snapshot.nodes) || snapshot.nodes.some((node) => typeof node.uid !== "string")) {
    throw new Error("the client agent didn't answer a UI state this Gridcheck reads; restart the client so it gets the current agent");
  }
  const visible = spec.visible === undefined ? true : spec.visible;
  const matches = snapshot.nodes.filter((node) => selected(node, spec.selector) &&
    (visible === "any" || node.effectiveDisplay === visible));
  const count = spec.count === undefined ? 1 : spec.count;
  const failures = [];
  if (snapshot.truncated) failures.push("the UI state was cut short, so it can't show a count or an absence; raise --limit");
  if (matches.length !== count) failures.push(`expected ${count} node(s), found ${matches.length}`);
  const desktop = snapshot.desktop && snapshot.desktop.rect;
  for (const node of matches) {
    for (const [key, field] of NODE_FIELDS) {
      if (spec[key] !== undefined && node[field] !== spec[key]) failures.push(`${node.path}: ${key} is ${node[field] ?? "unknown"}`);
    }
    if (spec.focused !== undefined && ((snapshot.focus && snapshot.focus.uid) === node.uid) !== spec.focused) {
      failures.push(`${node.path}: ${spec.focused ? "doesn't have" : "has"} focus`);
    }
    if (spec.modal !== undefined && ((snapshot.modal && snapshot.modal.uid) === node.uid) !== spec.modal) {
      failures.push(`${node.path}: ${spec.modal ? "isn't" : "is"} the modal window`);
    }
    if (spec.minWidth !== undefined && !(node.rect && node.rect[2] >= spec.minWidth)) failures.push(`${node.path}: narrower than ${spec.minWidth}`);
    if (spec.minHeight !== undefined && !(node.rect && node.rect[3] >= spec.minHeight)) failures.push(`${node.path}: shorter than ${spec.minHeight}`);
    if (spec.opacityMin !== undefined && !(Number.isFinite(node.opacity) && node.opacity >= spec.opacityMin)) {
      failures.push(`${node.path}: opacity ${node.opacity ?? "unknown"}, below ${spec.opacityMin}`);
    }
    if (spec.opacityMax !== undefined && !(Number.isFinite(node.opacity) && node.opacity <= spec.opacityMax)) {
      failures.push(`${node.path}: opacity ${node.opacity ?? "unknown"}, above ${spec.opacityMax}`);
    }
    if (spec.withinDesktop !== undefined) {
      const within = inside(node.rect, desktop);
      if (within !== spec.withinDesktop) failures.push(`${node.path}: ${within === null ? "geometry unknown" : within ? "within the desktop" : "outside the desktop"}`);
    }
  }
  return {
    ok: failures.length === 0,
    matched: matches.length,
    failures,
    matches: matches.slice(0, 50),
    // The same nodes from one snapshot to the next: what "stable" holds to.
    matchKey: matches.map((node) => node.uid).join(","),
    focus: snapshot.focus,
    modal: snapshot.modal,
    session: snapshot.session,
    truncated: snapshot.truncated,
  };
}

// Reads the UI state until the check holds for stableMs on the same character
// and the same nodes, or seconds are up. seconds 0 reads once.
async function waitForUi({ read, spec, seconds = 0, stableMs = 0, pollMs = 250, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  validateCheck(spec);
  if (!(Number.isFinite(seconds) && seconds >= 0 && seconds <= MAX_WAIT_SECONDS)) throw new Error(`the wait is 0 through ${MAX_WAIT_SECONDS} seconds`);
  if (!(Number.isFinite(stableMs) && stableMs >= 0 && stableMs <= seconds * 1000)) throw new Error("stable is milliseconds within the wait");
  const startedAt = now();
  const deadline = startedAt + seconds * 1000;
  let heldSince = null;
  let identity = null;
  let result;
  do {
    const snapshot = await read();
    result = checkUi(snapshot, spec);
    const current = JSON.stringify([snapshot.session && snapshot.session.charid, result.matchKey]);
    if (!result.ok) heldSince = null;
    else if (heldSince === null || current !== identity) heldSince = now();
    identity = current;
    // A read that comes back after the deadline doesn't pass a wait.
    if (result.ok && now() - heldSince >= stableMs && (seconds === 0 || now() <= deadline)) {
      return { ...result, elapsedMs: now() - startedAt };
    }
    if (now() >= deadline) break;
    await sleep(Math.min(pollMs, deadline - now()));
  } while (now() <= deadline);
  return { ...result, ok: false, elapsedMs: now() - startedAt,
    failures: [...result.failures, result.ok ? `it didn't hold for ${stableMs} ms` : `not within ${seconds} s`] };
}

module.exports = { validateCheck, checkUi, waitForUi };
