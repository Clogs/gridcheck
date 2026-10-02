"use strict";

// Loopback HTTP for the agent bridge. The token lives in memory and in the
// handshake file only, written at listen and removed at close, so the file's
// absence means "no bridge".

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const MAX_BODY_BYTES = 16 * 1024;
const LOOPBACK_HOST = "127.0.0.1";

function sendJSON(response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

// A page or script for the viewer: { statusCode, raw: { contentType, body } }.
// The policy keeps it to this bridge's own files and calls, and off other sites' frames.
function sendRaw(response, result) {
  const body = Buffer.isBuffer(result.raw.body) ? result.raw.body : Buffer.from(String(result.raw.body), "utf8");
  response.writeHead(result.statusCode || 200, {
    "Content-Type": result.raw.contentType,
    "Content-Length": String(body.length),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
      "img-src 'self' data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("request body too large"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) { resolve({}); return; }
      try {
        const parsed = JSON.parse(text);
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch (error) {
        reject(Object.assign(new Error(`body is not JSON: ${error.message}`), { statusCode: 400 }));
      }
    });
    request.on("error", reject);
  });
}

// A handshake naming another live process is that server's only copy of its
// token; deleting it locks its clients out until it restarts.
function handshakeBelongsToAnotherLiveProcess(handshakePath) {
  let pid = 0;
  try {
    pid = Math.trunc(Number(JSON.parse(fs.readFileSync(handshakePath, "utf8")).pid) || 0);
  } catch (_error) {
    return false;
  }
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function removeHandshake(handshakePath, options = {}) {
  if (options.onlyIfOurs === true && handshakeBelongsToAnotherLiveProcess(handshakePath)) {
    return false;
  }
  try {
    fs.unlinkSync(handshakePath);
  } catch (_error) { /* already gone */ }
  return true;
}

// handshakeExtra(): more fields for the handshake, read once at listen.
// handshakePath null: no handshake file (`e2e gui` prints its URL instead).
function createAgentBridgeHttp({ routes, port, handshakePath, log, serviceName = "agentBridge", handshakeExtra = null }) {
  const logger = log || { debug() {}, err() {} };
  const token = crypto.randomBytes(32).toString("hex");
  let server = null;

  function authorized(request) {
    const match = /^Bearer\s+(.+)$/i.exec(String(request.headers.authorization || "").trim());
    if (!match) return false;
    const supplied = Buffer.from(match[1].trim());
    const expected = Buffer.from(token);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  }

  async function handleRequest(request, response) {
    const url = new URL(request.url, `http://${LOOPBACK_HOST}`);
    const route = url.pathname.replace(/\/+$/, "") || "/";
    if (request.method === "GET" && route === "/health") {
      sendJSON(response, 200, { ok: true, service: serviceName, pid: process.pid, serverTime: Date.now() });
      return;
    }
    const open = typeof routes.handlePublic === "function" ? routes.handlePublic(request.method, route) : null;
    if (open) {
      sendRaw(response, open);
      return;
    }
    if (!authorized(request)) {
      sendJSON(response, 401, { ok: false, error: "missing or wrong bearer token" });
      return;
    }
    const body = request.method === "POST" ? await readBody(request) : {};
    const query = Object.fromEntries(url.searchParams.entries());
    const result = await routes.handle(request.method, route, query, body);
    if (result.raw) {
      sendRaw(response, result);
      return;
    }
    if (typeof result.stream === "function") {
      await streamNDJSON(response, result.stream);
      return;
    }
    sendJSON(response, result.statusCode, result.body);
  }

  // One JSON object per line, flushed as written. `closed()` turns true when
  // the caller hangs up, which is how a long watch learns to stop.
  async function streamNDJSON(response, stream) {
    let closed = false;
    response.on("close", () => { closed = true; });
    response.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    const sink = {
      write(event) {
        if (!closed) response.write(`${JSON.stringify(event)}\n`);
      },
      closed: () => closed,
    };
    try {
      await stream(sink);
    } catch (error) {
      logger.err(`[AgentBridge] stream failed: ${error.stack || error.message}`);
      sink.write({ kind: "ERROR", error: error.message });
    }
    if (!closed) response.end();
  }

  function writeHandshake(boundPort) {
    if (!handshakePath) return;
    fs.mkdirSync(path.dirname(handshakePath), { recursive: true });
    let extra = {};
    if (typeof handshakeExtra === "function") {
      try {
        extra = handshakeExtra() || {};
      } catch (error) {
        logger.err(`[AgentBridge] handshake details failed: ${error.message}`);
      }
    }
    // processStartedAtMs: e2e log keeps a stock log line, which has no pid tag, by its time.
    const payload = { ...extra, host: LOOPBACK_HOST, port: boundPort, token, pid: process.pid, startedAtMs: Date.now(),
      processStartedAtMs: Math.round(Date.now() - process.uptime() * 1000) };
    fs.writeFileSync(handshakePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  }

  function start() {
    if (server) return Promise.resolve(server.address().port);
    return new Promise((resolve, reject) => {
      const created = http.createServer((request, response) => {
        handleRequest(request, response).catch((error) => {
          logger.err(`[AgentBridge] request failed: ${error.message}`);
          if (!response.headersSent) {
            sendJSON(response, error.statusCode || 500, { ok: false, error: error.message });
          }
        });
      });
      created.once("error", (error) => {
        logger.err(`[AgentBridge] could not listen on ${LOOPBACK_HOST}:${port}: ${error.message}`);
        if (handshakePath) removeHandshake(handshakePath, { onlyIfOurs: true });
        reject(error);
      });
      created.listen(port, LOOPBACK_HOST, () => {
        server = created;
        const boundPort = created.address().port;
        writeHandshake(boundPort);
        logger.debug(`[AgentBridge] listening on http://${LOOPBACK_HOST}:${boundPort} (token in ${handshakePath})`);
        resolve(boundPort);
      });
    });
  }

  function stop() {
    if (handshakePath) removeHandshake(handshakePath);
    if (!server) return Promise.resolve();
    const closing = server;
    server = null;
    return new Promise((resolve) => closing.close(() => resolve()));
  }

  return { start, stop, token, port: () => (server ? server.address().port : null) };
}

module.exports = {
  LOOPBACK_HOST,
  createAgentBridgeHttp,
  handshakeBelongsToAnotherLiveProcess,
  removeHandshake,
};
