"use strict";

// The shape of a JSON value, for a reply too long to read whole: each key with
// its type, each array's length and its first element's shape, and a sample of
// each plain value. `client rpc --shape` and `lu-rpc --shape` print it.

const SAMPLE_CHARS = 60;

function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function sample(value) {
  const text = JSON.stringify(value);
  return text.length > SAMPLE_CHARS ? `${text.slice(0, SAMPLE_CHARS)}...` : text;
}

// -> the lines, two spaces a level. An object past maxKeys keys, or a value
// deeper than maxDepth, is cut short and says so.
function describeShape(value, { maxDepth = 6, maxKeys = 60 } = {}) {
  const lines = [];
  const walk = (node, label, depth) => {
    const indent = "  ".repeat(depth);
    const type = typeName(node);
    if (type === "array") {
      const kinds = [...new Set(node.map(typeName))];
      const of = node.length ? ` of ${kinds.join(" | ")}${kinds.length === 1 && kinds[0] !== "object" && kinds[0] !== "array"
        ? `, e.g. ${sample(node[0])}` : ""}` : "";
      lines.push(`${indent}${label}array[${node.length}]${of}`);
      const first = node.find((item) => item && typeof item === "object");
      if (first !== undefined) {
        if (depth >= maxDepth) lines.push(`${indent}  ...`);
        else walk(first, "[0]: ", depth + 1);
      }
      return;
    }
    if (type === "object") {
      const keys = Object.keys(node);
      lines.push(`${indent}${label}object (${keys.length} key${keys.length === 1 ? "" : "s"})`);
      if (depth >= maxDepth) {
        if (keys.length) lines.push(`${indent}  ...`);
        return;
      }
      for (const key of keys.slice(0, maxKeys)) walk(node[key], `${key}: `, depth + 1);
      if (keys.length > maxKeys) lines.push(`${indent}  ... ${keys.length - maxKeys} more key(s)`);
      return;
    }
    lines.push(`${indent}${label}${type === "null" ? "null" : `${type} ${sample(node)}`}`);
  };
  walk(value, "", 0);
  return lines;
}

module.exports = { describeShape };
