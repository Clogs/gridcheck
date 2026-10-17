"use strict";

// Pictures of the client compared offline: two PNGs pixel by pixel, two
// sampled frame sequences frame by frame and by their timing, and taking such
// a sequence. Only non-interlaced 8-bit RGB and RGBA PNGs, which is what the
// client saves; anything else is refused rather than half-read.

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_PIXELS = 8 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 * 1024;
// PNG colour type -> channels: 2 RGB, 6 RGBA.
const CHANNELS = { 2: 3, 6: 4 };
const MAX_FRAMES = 120;
const MAX_IGNORED = 100;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// A PNG's bytes -> { width, height, pixels } with pixels RGBA, 4 bytes each.
function decodePng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length > MAX_BYTES || !buffer.subarray(0, 8).equals(SIGNATURE)) {
    throw new Error("not a PNG of at most 64 MiB");
  }
  let offset = 8;
  let header = null;
  let ended = false;
  const data = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new Error("the PNG is cut short");
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const body = buffer.subarray(offset + 8, end - 4);
    if (crc32(buffer.subarray(offset + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) throw new Error(`the PNG's ${type} chunk fails its checksum`);
    if (type === "IHDR") {
      if (header || offset !== 8 || length !== 13) throw new Error("the PNG's header is malformed");
      header = { width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], channels: CHANNELS[body[9]],
        compression: body[10], filter: body[11], interlace: body[12] };
      if (!header.width || !header.height || header.width * header.height > MAX_PIXELS) throw new Error("the PNG is empty or over 8 million pixels");
      if (header.depth !== 8 || !header.channels || header.compression || header.filter || header.interlace) {
        throw new Error("only non-interlaced 8-bit RGB or RGBA PNGs are compared");
      }
    } else if (type === "IDAT") {
      if (!header) throw new Error("the PNG's data comes before its header");
      data.push(body);
    } else if (type === "IEND") {
      ended = true;
      offset = end;
      break;
    } else if (type !== "PLTE" && type[0] === type[0].toUpperCase()) {
      // A critical chunk this reader doesn't know would change the pixels.
      throw new Error(`the PNG has a ${type} chunk this reader doesn't know`);
    }
    offset = end;
  }
  if (!header || !ended || !data.length || offset !== buffer.length) throw new Error("the PNG is incomplete");
  const { width, height, channels } = header;
  const stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(data), { maxOutputLength: (stride + 1) * height });
  if (raw.length !== (stride + 1) * height) throw new Error("the PNG's pixel data is the wrong length");
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[at];
    at += 1;
    if (filter > 4) throw new Error(`the PNG uses scanline filter ${filter}, which doesn't exist`);
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      const predicted = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, upLeft)][filter];
      row[x] = (raw[at] + predicted) & 0xff;
      at += 1;
    }
    for (let x = 0; x < width; x += 1) {
      const to = (y * width + x) * 4;
      const from = x * channels;
      pixels[to] = row[from];
      pixels[to + 1] = row[from + 1];
      pixels[to + 2] = row[from + 2];
      pixels[to + 3] = channels === 4 ? row[from + 3] : 255;
    }
    previous = row;
  }
  return { width, height, pixels };
}

function chunk(type, body) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  const named = Buffer.concat([Buffer.from(type, "ascii"), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(named));
  return Buffer.concat([length, named, crc]);
}

// { width, height, pixels (RGBA) } -> PNG bytes, unfiltered.
function encodePng({ width, height, pixels }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > MAX_PIXELS ||
    pixels.length !== width * height * 4) {
    throw new Error("an image is whole width x height RGBA pixels, at most 8 million");
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) pixels.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([SIGNATURE, chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// Comparison options, checked: threshold (a channel may differ by this much,
// 0-255), maxChangedFraction (of compared pixels, 0-1), ignore ([x, y, w, h]
// rectangles), maxTimingDriftMs (sequences).
function comparisonOptions(raw = {}) {
  const keys = ["threshold", "maxChangedFraction", "ignore", "maxTimingDriftMs"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("options is an object");
  for (const key of Object.keys(raw)) if (!keys.includes(key)) throw new Error(`unknown option ${key}; ${keys.join(", ")}`);
  const options = { threshold: 0, maxChangedFraction: 0, ignore: [], maxTimingDriftMs: 100, ...raw };
  for (const [key, most] of [["threshold", 255], ["maxChangedFraction", 1], ["maxTimingDriftMs", 60000]]) {
    if (!(Number.isFinite(options[key]) && options[key] >= 0 && options[key] <= most)) throw new Error(`${key}: 0 through ${most}`);
  }
  const rectangle = (r) => Array.isArray(r) && r.length === 4 && r.every((n) => Number.isInteger(n) && n >= 0) && r[2] > 0 && r[3] > 0;
  if (!Array.isArray(options.ignore) || options.ignore.length > MAX_IGNORED || !options.ignore.every(rectangle)) {
    throw new Error(`ignore: up to ${MAX_IGNORED} rectangles [x, y, width, height] in pixels`);
  }
  return options;
}

// Two decoded images -> { ok, changedPixels, changedFraction, rmse, maxDelta, diff }.
// A pixel changed when any RGBA channel differs by more than threshold. In the
// diff, changed pixels are red, ignored ones blue, the rest green by how much they differ.
function compareImages(reference, actual, raw = {}) {
  const options = comparisonOptions(raw);
  if (reference.width !== actual.width || reference.height !== actual.height) {
    return { ok: false, reason: `the sizes differ: ${reference.width}x${reference.height} against ${actual.width}x${actual.height}` };
  }
  const { width, height } = actual;
  const ignored = new Uint8Array(width * height);
  for (const [x, y, w, h] of options.ignore) {
    if (x + w > width || y + h > height) throw new Error(`ignored rectangle [${x}, ${y}, ${w}, ${h}] goes past the ${width}x${height} image`);
    for (let row = y; row < y + h; row += 1) ignored.fill(1, row * width + x, row * width + x + w);
  }
  const diff = Buffer.alloc(width * height * 4);
  let compared = 0;
  let changed = 0;
  let squares = 0;
  let maxDelta = 0;
  for (let p = 0; p < width * height; p += 1) {
    const i = p * 4;
    diff[i + 3] = 255;
    if (ignored[p]) {
      diff[i + 2] = 128;
      continue;
    }
    compared += 1;
    let delta = 0;
    for (let c = 0; c < 4; c += 1) {
      const d = Math.abs(reference.pixels[i + c] - actual.pixels[i + c]);
      delta = Math.max(delta, d);
      squares += d * d;
    }
    maxDelta = Math.max(maxDelta, delta);
    if (delta > options.threshold) {
      changed += 1;
      diff[i] = 255;
    } else {
      diff[i + 1] = delta;
    }
  }
  if (!compared) throw new Error("the ignored rectangles cover every pixel");
  return { ok: changed / compared <= options.maxChangedFraction, width, height, comparedPixels: compared, changedPixels: changed,
    changedFraction: changed / compared, rmse: Math.sqrt(squares / (compared * 4)), maxDelta, diff: { width, height, pixels: diff } };
}

function readImage(file) {
  if (fs.statSync(file).size > MAX_BYTES) throw new Error(`${file} is over 64 MiB`);
  try {
    return decodePng(fs.readFileSync(file));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

// Two PNG files; diffFile, when given, must not exist yet: evidence isn't overwritten.
function compareFiles(reference, actual, options = {}, diffFile = null) {
  if (diffFile && fs.existsSync(diffFile)) throw new Error(`${diffFile} exists already; name a new file for the diff`);
  const { diff, ...summary } = compareImages(readImage(reference), readImage(actual), options);
  if (diff && diffFile) {
    fs.mkdirSync(path.dirname(diffFile), { recursive: true });
    fs.writeFileSync(diffFile, encodePng(diff), { flag: "wx" });
    summary.diffFile = diffFile;
  }
  return summary;
}

// A frames.json: { schema: 1, frames: [{ file, atMs }, ...] }, files relative to it.
function readSequence(file) {
  const base = path.dirname(path.resolve(file));
  const sequence = JSON.parse(fs.readFileSync(file, "utf8"));
  if (sequence.schema !== 1 || !Array.isArray(sequence.frames) || sequence.frames.length < 2 || sequence.frames.length > MAX_FRAMES) {
    throw new Error(`${file}: a sequence is schema 1 with 2 to ${MAX_FRAMES} frames`);
  }
  let last = -1;
  const frames = sequence.frames.map((frame, index) => {
    if (!frame || typeof frame.file !== "string" || !(Number.isFinite(frame.atMs) && frame.atMs > last)) {
      throw new Error(`${file}: frame ${index} needs a file and an atMs after the frame before`);
    }
    last = frame.atMs;
    return { ...frame, file: path.resolve(base, frame.file) };
  });
  return { ...sequence, frames };
}

// Frame by frame: the pixels, and each frame's time from the first against the reference's.
function compareSequences(referenceFile, actualFile, raw = {}, diffDir = null) {
  const options = comparisonOptions(raw);
  const reference = readSequence(referenceFile);
  const actual = readSequence(actualFile);
  if (reference.frames.length !== actual.frames.length) {
    return { ok: false, reason: `${reference.frames.length} reference frames against ${actual.frames.length}` };
  }
  const frames = actual.frames.map((frame, index) => {
    const against = reference.frames[index];
    const driftMs = Math.abs((frame.atMs - actual.frames[0].atMs) - (against.atMs - reference.frames[0].atMs));
    const pixels = compareFiles(against.file, frame.file, options, diffDir ? path.join(diffDir, `diff-${index}.png`) : null);
    return { index, ...pixels, timingDriftMs: driftMs, ok: pixels.ok && driftMs <= options.maxTimingDriftMs };
  });
  return { ok: frames.every((frame) => frame.ok), frames };
}

// A pointer command's arguments, checked before anything is sent.
function validatePointer(raw) {
  const keys = ["action", "points", "button", "durationMs", "delta"];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("a pointer is { \"action\": ..., \"points\": [[x, y], ...] }");
  for (const key of Object.keys(raw)) if (!keys.includes(key)) throw new Error(`unknown pointer key ${key}; ${keys.join(", ")}`);
  const spec = { action: "move", button: 0, durationMs: 0, ...raw };
  if (!["move", "click", "drag", "wheel"].includes(spec.action)) throw new Error("pointer action: move, click, drag or wheel");
  if (![0, 1, 2].includes(spec.button)) throw new Error("pointer button: 0 left, 1 right, 2 middle");
  if (!(Number.isFinite(spec.durationMs) && spec.durationMs >= 0 && spec.durationMs <= 3000)) throw new Error("pointer durationMs: 0 through 3000");
  const point = (p) => Array.isArray(p) && p.length === 2 && p.every((n) => Number.isFinite(n) && n >= 0);
  if (!Array.isArray(spec.points) || spec.points.length < 1 || spec.points.length > MAX_FRAMES || !spec.points.every(point)) {
    throw new Error(`pointer points: 1 to ${MAX_FRAMES} [x, y] pairs in UI pixels`);
  }
  if (spec.action === "drag" && spec.points.length < 2) throw new Error("a drag needs two points or more");
  if (spec.action === "wheel" && !(Number.isFinite(spec.delta) && spec.delta !== 0 && Math.abs(spec.delta) <= 12000)) {
    throw new Error("wheel delta: not 0, -12000 through 12000 (120 a notch)");
  }
  return spec;
}

// count frames, intervalMs apart, at most a minute of them.
function captureOptions(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("a capture is { \"count\": 10, \"intervalMs\": 100 }");
  for (const key of Object.keys(raw)) if (!["count", "intervalMs"].includes(key)) throw new Error(`unknown capture key ${key}; count or intervalMs`);
  const options = { count: 10, intervalMs: 100, ...raw };
  if (!(Number.isInteger(options.count) && options.count >= 2 && options.count <= MAX_FRAMES)) throw new Error(`count: 2 to ${MAX_FRAMES} frames`);
  if (!(Number.isFinite(options.intervalMs) && options.intervalMs >= 50 && options.intervalMs <= 5000)) throw new Error("intervalMs: 50 through 5000");
  if ((options.count - 1) * options.intervalMs > 60000) throw new Error("a capture spans at most 60 s");
  return options;
}

// Takes count frames into a new directory and writes its frames.json. Each
// frame's atMs is the middle of its capture call: an estimate, not when the GPU
// showed it. identity() names the client (pid, character, build); a change, a
// missing picture or a change of size fails the capture.
async function captureSequence({ directory, spec = {}, capture, identity, now = () => performance.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const options = captureOptions(spec);
  if (fs.existsSync(directory)) throw new Error(`${directory} exists already; name a new folder for the frames`);
  const first = await identity();
  if (!first || !first.charid) throw new Error("the client has no character in game to capture");
  const same = async () => JSON.stringify(await identity()) === JSON.stringify(first);
  fs.mkdirSync(directory, { recursive: true });
  const startedAt = now();
  const frames = [];
  for (let index = 0; index < options.count; index += 1) {
    const due = startedAt + index * options.intervalMs;
    if (now() < due) await sleep(due - now());
    if (!(await same())) throw new Error("the client changed (process, character or build) during the capture");
    const file = path.join(directory, `frame-${String(index).padStart(3, "0")}.png`);
    const before = now();
    const shot = await capture(file);
    const after = now();
    if ((shot && shot.error) || !fs.existsSync(file)) throw new Error(`frame ${index}: ${(shot && shot.error) || "the client saved no picture"}`);
    const image = readImage(file);
    if (frames.length && (image.width !== frames[0].width || image.height !== frames[0].height)) {
      throw new Error(`frame ${index} is ${image.width}x${image.height}, the first ${frames[0].width}x${frames[0].height}: the window changed size`);
    }
    frames.push({ file: path.basename(file), atMs: (before + after) / 2 - startedAt, captureMs: after - before,
      lateMs: Math.max(0, before - due), width: image.width, height: image.height });
  }
  if (!(await same())) throw new Error("the client changed (process, character or build) during the capture");
  const manifest = { schema: 1, identity: first, intervalMs: options.intervalMs, frames };
  fs.writeFileSync(path.join(directory, "frames.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

module.exports = {
  captureOptions,
  captureSequence,
  compareFiles,
  compareImages,
  compareSequences,
  comparisonOptions,
  decodePng,
  encodePng,
  readSequence,
  validatePointer,
};
