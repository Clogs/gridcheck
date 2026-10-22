"use strict";

// The real EVE client from the CLI's side: where its exefile is, how to start
// it as Play.bat does, a screenshot of its window, and how its ballpark
// compares with the server's grid. The bridge's half is bridge/client.js, the
// half inside the client bridge/client/agent.py.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const LAUNCHER_CONFIG = path.join("tools", "ClientSETUP", "scripts", "EvEJSConfig.bat");
// Celestial and Station: the client holds every one in the system, the server
// lists only those on the session's grid.
const STATIC_CATEGORIES = new Set([2, 3]);

// --exe, EVEJS_CLIENT_EXE, or the client folder EVEJS_CLIENT_PATH names, in the
// environment or the tree's launcher config (what Play.bat reads).
// -> { exe, source } or { error }.
function findClientExe({ treeRoot, exe = null, env = process.env, exists = fs.existsSync,
  readText = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "") } = {}) {
  if (exe) {
    const resolved = path.resolve(String(exe));
    return exists(resolved) ? { exe: resolved, source: "--exe" } : { error: `--exe ${resolved} doesn't exist` };
  }
  if (env.EVEJS_CLIENT_EXE) {
    return exists(env.EVEJS_CLIENT_EXE) ? { exe: env.EVEJS_CLIENT_EXE, source: "EVEJS_CLIENT_EXE" }
      : { error: `EVEJS_CLIENT_EXE names ${env.EVEJS_CLIENT_EXE}, which doesn't exist` };
  }
  let clientPath = env.EVEJS_CLIENT_PATH || null;
  let source = "EVEJS_CLIENT_PATH";
  if (!clientPath && treeRoot) {
    const configBat = path.join(treeRoot, LAUNCHER_CONFIG);
    const match = /^\s*set\s+"EVEJS_CLIENT_PATH=([^"]+)"/im.exec(readText(configBat));
    clientPath = match ? match[1].trim() : null;
    source = LAUNCHER_CONFIG.split(path.sep).join("/");
  }
  if (!clientPath) {
    return { error: "no EVE client found: pass --exe <exefile.exe>, or run the tree's Play.bat once so its launcher config names the client" };
  }
  for (const bin of ["bin64", "bin"]) {
    const candidate = path.join(clientPath, bin, "exefile.exe");
    if (exists(candidate)) return { exe: candidate, source };
  }
  return { error: `${source} names ${clientPath}, which has no bin64\\exefile.exe; pass --exe` };
}

// The resource cache Play.bat points EO_REMOTEFILECACHEFOLDER at: ResFiles beside tq.
function defaultResFiles(exe) {
  return path.resolve(path.dirname(exe), "..", "..", "ResFiles");
}

// What Play.bat sets: the resource cache (else the client reads the registry's
// CACHEFOLDER), and the gateway as the client's HTTP proxy.
function clientEnvironment({ env = process.env, resfiles, gatewayPort }) {
  const proxy = gatewayPort ? `http://127.0.0.1:${gatewayPort}/` : null;
  return {
    ...env,
    EO_REMOTEFILECACHEFOLDER: resfiles,
    ...(proxy ? {
      http_proxy: proxy, https_proxy: proxy, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, all_proxy: proxy, ALL_PROXY: proxy,
      EVE_CLIENT_SENTRY_DSN: `http://evejs@127.0.0.1:${gatewayPort}/1`,
    } : {}),
    no_proxy: "127.0.0.1,localhost,::1",
    NO_PROXY: "127.0.0.1,localhost,::1",
  };
}

// The client opens its own console ("[CCP] ... pid=N") and writes there with
// WriteConsole, so redirecting its stdio catches nothing (Play.bat's stdio logs
// stay empty too); readConsole reads that console instead. Started with
// /noconsole it writes to stdout, which logfile then holds. The pid is the
// launcher's: exefile.exe hands off to a second process, whose pid the agent reports.
function startClient({ exe, args, env, logfile = null, spawnImpl = spawn }) {
  // With /noconsole the client writes to stdout. It gets the file itself, not a
  // pipe, so its writes don't fail once the CLI that started it has exited.
  let fd = null;
  if (logfile) {
    fs.mkdirSync(path.dirname(logfile), { recursive: true });
    fd = fs.openSync(logfile, "w");
  }
  let child;
  try {
    child = spawnImpl(exe, args, { cwd: path.dirname(exe), env, detached: true, stdio: fd === null ? "ignore" : ["ignore", fd, fd] });
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
  const launch = { exited: false, exitCode: null, error: null };
  child.gridcheckLaunch = launch;
  if (typeof child.once === "function") {
    child.once("error", (error) => { launch.error = error.message; });
    child.once("exit", (code) => {
      launch.exited = true;
      launch.exitCode = code;
    });
  }
  child.unref();
  return child;
}

const SETTINGS_PROFILE = /^[A-Za-z0-9_-]{1,64}$/;
const GRAPHICS = ["dx11", "dx12"];

// launch's own client switches, each only when asked for: a settings profile
// of its own (the client's preferences, apart from a player's), the renderer,
// and /noconsole. -> { args } or { error }.
function launchSwitches({ settingsProfile, graphics, noConsole = false } = {}) {
  if (settingsProfile !== undefined && !(typeof settingsProfile === "string" && SETTINGS_PROFILE.test(settingsProfile))) {
    return { error: "--settings-profile takes 1 to 64 letters, digits, _ or -" };
  }
  if (graphics !== undefined && !GRAPHICS.includes(graphics)) return { error: `--graphics takes ${GRAPHICS.join(" or ")}` };
  return { args: [
    ...(settingsProfile === undefined ? [] : [`/settingsprofile=${settingsProfile}`]),
    ...(graphics === undefined ? [] : [`/triPlatform=${graphics}`]),
    ...(noConsole ? ["/noconsole"] : []),
  ] };
}

// What the client printed before it reached login, when it is one of the ways
// it fails to start: why, or null.
function diagnoseStartup(text) {
  if (/NoAdaptersFoundError/i.test(text)) return "the client found no graphics adapter it can use, so it never reached login";
  if (/DirectXRedist.*(?:not recognized|not found)|not recognized[^\n]*DirectXRedist/i.test(text)) {
    return "the client's graphics check ran DirectXRedist, which is missing, so it never reached login";
  }
  if (/Failed to import _trinity|ImportError.*(?:trinity|DLL)/i.test(text)) return "the client couldn't load its renderer before login";
  return null;
}

// Each token or login switch's value as [redacted].
function redactSwitches(text, args = []) {
  let out = String(text);
  for (const arg of args) {
    const match = /^\/(?:ssoToken|refreshToken|login)[=:](.+)$/i.exec(arg);
    if (match) out = out.split(match[1]).join("[redacted]");
  }
  return out.replace(/(\/(?:ssoToken|refreshToken|login)[=:])[^\s"']+/gi, "$1[redacted]");
}

// The end of a file, at most bytes of it; "" when there's none.
function readTail(file, bytes = 64 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, bytes));
    fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString("utf8");
  } catch (_error) {
    return "";
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Why a launch that no agent has attached from yet won't: the spawn failed,
// the client printed a known startup failure, or the launcher exited non-zero
// (zero is its hand-off to the real client). Null while it may still come up.
function launchFailure(launch, logfile = null) {
  if (!launch) return null;
  if (launch.error) return `the client didn't start: ${launch.error}`;
  const diagnosed = logfile ? diagnoseStartup(readTail(logfile)) : null;
  if (diagnosed) return diagnosed;
  if (launch.exited && launch.exitCode !== 0 && launch.exitCode !== null) return `the client's launcher exited with code ${launch.exitCode}`;
  return null;
}

// Attaches to the pid's console and reads its screen buffer up to the cursor.
// A row filled to the buffer's width continues on the next, so they're joined.
const CONSOLE_PS1 = String.raw`param([int]$TargetPid, [string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Text; using System.Text.RegularExpressions; using System.Runtime.InteropServices;
public static class GridcheckConsole {
  [StructLayout(LayoutKind.Sequential)] public struct COORD { public short X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct SMALL_RECT { public short L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct CSBI { public COORD size; public COORD cursor; public short attr; public SMALL_RECT win; public COORD max; }
  [DllImport("kernel32.dll")] static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr CreateFile(string n, uint a, uint s, IntPtr sa, uint c, uint f, IntPtr t);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetConsoleScreenBufferInfo(IntPtr h, out CSBI i);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern bool ReadConsoleOutputCharacter(IntPtr h, [Out] char[] b, uint len, COORD c, out uint read);
  public static string Read(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return "ERROR AttachConsole failed (" + Marshal.GetLastWin32Error() + "): pid " + pid + " has no console";
    try {
      IntPtr h = CreateFile("CONOUT$", 0xC0000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
      CSBI i; GetConsoleScreenBufferInfo(h, out i);
      StringBuilder all = new StringBuilder("OK\n");
      char[] row = new char[i.size.X];
      for (short y = 0; y <= i.cursor.Y; y++) {
        uint read; COORD c = new COORD(); c.X = 0; c.Y = y;
        if (!ReadConsoleOutputCharacter(h, row, (uint)row.Length, c, out read)) read = 0;
        string raw = Regex.Replace(new string(row, 0, (int)read), @"[\uD800-\uDFFF]", "?");
        string text = raw.TrimEnd();
        all.Append(text);
        if (text.Length < row.Length || y == i.cursor.Y) all.Append('\n');
      }
      CloseHandle(h);
      return all.ToString();
    } finally { FreeConsole(); }
  }
}
"@
[IO.File]::WriteAllText($Out, [GridcheckConsole]::Read([uint32]$TargetPid), (New-Object System.Text.UTF8Encoding $false))
`;

function runPowerShell(source, args, run) {
  const script = path.join(os.tmpdir(), `gridcheck-${process.pid}-${Date.now()}.ps1`);
  fs.writeFileSync(script, source);
  try {
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, ...args],
      { encoding: "utf8", timeout: 60000, windowsHide: true });
  } finally {
    fs.rmSync(script, { force: true });
  }
}

// -> { lines } (the console's text, oldest first) or { error }.
function readConsole({ pid, run = spawnSync }) {
  if (process.platform !== "win32") return { error: "the client's console is read with Windows' AttachConsole; this isn't Windows" };
  const out = path.join(os.tmpdir(), `gridcheck-console-${process.pid}-${Date.now()}.txt`);
  try {
    const reply = runPowerShell(CONSOLE_PS1, ["-TargetPid", String(pid), "-Out", out], run);
    const text = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
    if (text.startsWith("OK\n")) {
      const lines = text.slice(3).split("\n");
      while (lines.length && !lines[lines.length - 1]) lines.pop();
      return { lines };
    }
    return { error: text.startsWith("ERROR ") ? text.slice(6).trim()
      : `the console script failed: ${String(reply.stderr || reply.error || "").trim().slice(0, 400)}` };
  } finally {
    fs.rmSync(out, { force: true });
  }
}

// Finds the pid's largest visible window that isn't a console, and draws it
// with PrintWindow(PW_CLIENTONLY | PW_RENDERFULLCONTENT), which captures the
// D3D window from outside. A minimized window can't be drawn. With -FromFile
// it scales and converts that picture instead (one the client saved itself).
// -Crop "left,top,width,height" in UI units, with -UiWidth the desktop's width
// in them, cuts the picture to that rect before it is scaled.
const SCREENSHOT_PS1 = String.raw`param([int]$TargetPid, [string]$Out, [int]$MaxWidth = 0, [string]$Format = 'png', [string]$FromFile = '',
  [string]$Crop = '', [double]$UiWidth = 0)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class GridcheckShot {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  public static IntPtr Find(uint pid) {
    IntPtr best = IntPtr.Zero; long area = -1;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      uint owner; GetWindowThreadProcessId(h, out owner);
      if (owner != pid || !IsWindowVisible(h)) return true;
      StringBuilder c = new StringBuilder(256); GetClassName(h, c, 256);
      if (c.ToString() == "ConsoleWindowClass") return true;
      RECT r; GetClientRect(h, out r);
      long a = (long)(r.R - r.L) * (r.B - r.T);
      if (a > area) { area = a; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
}
"@
$h = [IntPtr]::Zero
if ($FromFile) {
  $src = [System.Drawing.Image]::FromFile($FromFile)
  $bmp = New-Object System.Drawing.Bitmap $src
  $src.Dispose()
  $w = $bmp.Width; $hh = $bmp.Height
} else {
  [void][GridcheckShot]::SetProcessDPIAware()
  $h = [GridcheckShot]::Find([uint32]$TargetPid)
  if ($h -eq [IntPtr]::Zero) { Write-Output "ERROR pid $TargetPid has no visible window"; exit 2 }
  if ([GridcheckShot]::IsIconic($h)) { Write-Output "ERROR the client window is minimized; PrintWindow can't draw it"; exit 3 }
  $r = New-Object GridcheckShot+RECT
  [void][GridcheckShot]::GetClientRect($h, [ref]$r)
  $w = $r.R - $r.L; $hh = $r.B - $r.T
  if ($w -le 0 -or $hh -le 0) { Write-Output "ERROR the client window has no area"; exit 4 }
  $bmp = New-Object System.Drawing.Bitmap $w, $hh
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $dc = $g.GetHdc()
  $ok = [GridcheckShot]::PrintWindow($h, $dc, 3)
  $g.ReleaseHdc($dc); $g.Dispose()
  if (-not $ok) { $bmp.Dispose(); Write-Output "ERROR PrintWindow failed"; exit 5 }
}
if ($Crop) {
  $c = $Crop.Split(',') | ForEach-Object { [double]$_ }
  $f = 1.0
  if ($UiWidth -gt 0) { $f = $w / $UiWidth }
  $cx = [int][Math]::Floor($c[0] * $f); $cy = [int][Math]::Floor($c[1] * $f)
  $cw = [int][Math]::Min($w - $cx, [Math]::Round($c[2] * $f)); $ch = [int][Math]::Min($hh - $cy, [Math]::Round($c[3] * $f))
  if ($cx -lt 0 -or $cy -lt 0 -or $cw -le 0 -or $ch -le 0) { $bmp.Dispose(); Write-Output "ERROR the crop $Crop lies outside the picture"; exit 6 }
  $part = $bmp.Clone((New-Object System.Drawing.Rectangle $cx, $cy, $cw, $ch), $bmp.PixelFormat)
  $bmp.Dispose(); $bmp = $part; $w = $cw; $hh = $ch
}
$outW = $w; $outH = $hh
if ($MaxWidth -gt 0 -and $w -gt $MaxWidth) {
  $outW = $MaxWidth; $outH = [int][Math]::Round($hh * $MaxWidth / $w)
  $small = New-Object System.Drawing.Bitmap $outW, $outH
  $sg = [System.Drawing.Graphics]::FromImage($small)
  $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $sg.DrawImage($bmp, 0, 0, $outW, $outH); $sg.Dispose(); $bmp.Dispose(); $bmp = $small
}
if ($Format -eq 'jpg') { $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Jpeg) } else { $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png) }
$bmp.Dispose()
$t = New-Object System.Text.StringBuilder 256
if ($h -ne [IntPtr]::Zero) { [void][GridcheckShot]::GetWindowText($h, $t, 256) }
Write-Output ("OK {0} {1} {2}" -f $outW, $outH, $t.ToString())
`;

// crop: { rect: [left, top, width, height], uiWidth } in UI units, or null.
function screenshotArgs({ pid, out, maxWidth, format, from, crop = null }) {
  return ["-TargetPid", String(pid || 0), "-Out", out, "-MaxWidth", String(maxWidth), "-Format", format, ...(from ? ["-FromFile", from] : []),
    ...(crop ? ["-Crop", crop.rect.join(","), "-UiWidth", String(crop.uiWidth)] : [])];
}

function screenshotReply(reply, out) {
  const text = `${reply.stdout || ""}`.trim();
  const ok = /^OK (\d+) (\d+) ?(.*)$/m.exec(text);
  if (ok) return { file: out, width: Number(ok[1]), height: Number(ok[2]), title: ok[3] || null };
  const failed = /^ERROR (.*)$/m.exec(text);
  return { error: failed ? failed[1] : `the screenshot script failed: ${(text || reply.stderr || String(reply.error || "")).trim().slice(0, 400)}` };
}

// The pid's window, or with from the picture in that file, saved as out. It
// doesn't block: a run keeps reading its watch while PowerShell draws.
// -> Promise of { file, width, height, title } or { error }.
function captureScreenshot({ pid, from = null, out, maxWidth = 0, format = "png", crop = null, spawnImpl = spawn }) {
  if (process.platform !== "win32") return Promise.resolve({ error: "screenshots are drawn with Windows' PowerShell; this isn't Windows" });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const script = path.join(os.tmpdir(), `gridcheck-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.ps1`);
  fs.writeFileSync(script, SCREENSHOT_PS1);
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timer = null;
    const done = (error = null) => {
      clearTimeout(timer);
      fs.rmSync(script, { force: true });
      resolve(screenshotReply({ stdout, stderr, error }, out));
    };
    let child;
    try {
      child = spawnImpl("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
        ...screenshotArgs({ pid, out, maxWidth, format, from, crop })], { windowsHide: true });
    } catch (error) {
      done(error);
      return;
    }
    timer = setTimeout(() => child.kill(), 60000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => done(error));
    child.on("close", () => done());
  });
}

const VIRTUAL_KEYS = Object.freeze({
  backspace: 0x08, tab: 0x09, enter: 0x0d, return: 0x0d, escape: 0x1b, esc: 0x1b, space: 0x20,
  pageup: 0x21, pagedown: 0x22, end: 0x23, home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  insert: 0x2d, delete: 0x2e, del: 0x2e,
});

// "enter", "f3", "a" -> { key } (a virtual-key code) or { error }.
function parseKey(spec) {
  const name = String(spec || "").toLowerCase().trim();
  if (!name) return { error: "a key is a name such as enter, escape, tab, f3 or a" };
  if (name.includes("+")) {
    return { error: "the client reads ctrl, shift and alt from the real keyboard, so a combination can't be sent from inside it; " +
      "client cmd runs what the combination is bound to" };
  }
  let key = VIRTUAL_KEYS[name];
  if (key === undefined && /^[a-z0-9]$/.test(name)) key = name.toUpperCase().charCodeAt(0);
  const fn = /^f([1-9]|1[0-2])$/.exec(name);
  if (key === undefined && fn) key = 0x6f + Number(fn[1]);
  if (key === undefined) return { error: `${name} isn't a key gridcheck knows: ${Object.keys(VIRTUAL_KEYS).join(", ")}, a-z, 0-9, f1-f12` };
  return { key };
}


function distance(a, b) {
  if (!a || !b || a.some((v) => !Number.isFinite(v)) || b.some((v) => !Number.isFinite(v))) return null;
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const vector = (value) => (Array.isArray(value) ? value.map(Number)
  : value && typeof value === "object" ? [Number(value.x), Number(value.y), Number(value.z)] : null);

// The client's ballpark (agent op ballpark) against the bridge's grid for the
// same character. A shared ball is "moved" when the two positions are further
// apart than toleranceMeters plus lagSeconds of its speed: the client
// interpolates, and the two are read a moment apart.
function diffBallpark(client, grid, { toleranceMeters = 1000, lagSeconds = 2 } = {}) {
  const serverRows = new Map(((grid && grid.entities) || []).map((row) => [String(row.itemID), row]));
  const clientRows = new Map(((client && client.balls) || []).map((ball) => [String(ball.itemID), ball]));
  const label = (row) => row.name || row.typeName || `#${row.itemID}`;
  const missing = [];
  const extra = [];
  const moved = [];
  const modes = [];
  let staticOnlyInClient = 0;
  for (const [id, row] of serverRows) {
    const ball = clientRows.get(id);
    if (!ball) {
      missing.push({ itemID: row.itemID, label: label(row), kind: row.kind || null, typeID: row.typeID || null,
        distanceMeters: Number.isFinite(row.distanceMeters) ? Math.round(row.distanceMeters) : null });
      continue;
    }
    const error = distance(vector(row.position), vector(ball.position));
    const speed = Math.hypot(...(vector(row.velocity) || [0, 0, 0]).map((v) => (Number.isFinite(v) ? v : 0)));
    const allowed = toleranceMeters + speed * lagSeconds;
    if (error !== null && error > allowed) {
      moved.push({ itemID: row.itemID, label: label(row), errorMeters: Math.round(error), allowedMeters: Math.round(allowed) });
    }
    if (row.mode && ball.mode && row.mode !== ball.mode) {
      modes.push({ itemID: row.itemID, label: label(row), server: row.mode, client: ball.mode });
    }
  }
  for (const [id, ball] of clientRows) {
    if (serverRows.has(id)) continue;
    if (STATIC_CATEGORIES.has(Number(ball.categoryID))) {
      staticOnlyInClient += 1;
      continue;
    }
    extra.push({ itemID: ball.itemID, label: ball.name || `#${ball.itemID}`, typeID: ball.typeID || null,
      mode: ball.mode || null, distanceMeters: Number.isFinite(ball.distanceMeters) ? Math.round(ball.distanceMeters) : null });
  }
  const shared = [...serverRows.keys()].filter((id) => clientRows.has(id)).length;
  const sameSystem = Boolean(grid && client && Number(grid.solarSystemID) === Number(client.solarSystemID));
  return {
    ok: sameSystem && !missing.length && !extra.length && !moved.length && !modes.length,
    sameSystem,
    inSpace: { server: Boolean(grid && grid.inSpace), client: Boolean(client && client.inSpace) },
    counts: { server: serverRows.size, client: clientRows.size, shared, staticOnlyInClient },
    missing,
    extra,
    moved,
    modes,
  };
}

// A diffBallpark result as one timeline line (core/conditions.js
// CLIENT_BALLPARK). ok also needs both sides in space in one system: docked,
// two empty lists would agree.
const ID_LIST_LIMIT = 50;

function ballparkEvent(diff, { username, characterID, grid = null, atMs = Date.now(), waitedMs = null } = {}) {
  const ids = (rows) => rows.slice(0, ID_LIST_LIMIT).map((row) => row.itemID);
  return {
    kind: "CLIENT_BALLPARK",
    atMs,
    username,
    characterID,
    ok: Boolean(diff.ok && diff.inSpace.client && diff.inSpace.server),
    inSpace: diff.inSpace.client,
    serverInSpace: diff.inSpace.server,
    sameSystem: diff.sameSystem,
    systemID: grid && grid.solarSystemID ? grid.solarSystemID : null,
    server: diff.counts.server,
    client: diff.counts.client,
    shared: diff.counts.shared,
    missing: diff.missing.length,
    extra: diff.extra.length,
    moved: diff.moved.length,
    modes: diff.modes.length,
    missingIDs: ids(diff.missing),
    extraIDs: ids(diff.extra),
    movedIDs: ids(diff.moved),
    ...(waitedMs === null ? {} : { waitedMs }),
  };
}

// How long a ball may be on one side only before the sampler says so.
const BALLPARK_LATE_MS = 10_000;
// A sample where at least this many balls are new, and they are most of the
// grid, is a new grid (a warp, a jump): a baseline, not a row of arrivals.
const NEW_GRID_MIN = 6;

// The run's ballpark sampler for one client: each step takes the client's
// ballpark and the server's grid for its character, read together, and returns
// CLIENT_BALL lines (core/conditions.js). A ball the server lists after the
// first sample is "held" once the client has it, lagMs after the server first
// listed it (to within a sample). Any ball the server has listed for lateMs
// that the client still lacks is "missing", once; a ball only the client holds
// for lateMs is "extra", once. Celestials and stations only the client holds
// don't count (diffBallpark). Docked, or in another system than the server's
// grid, it starts again.
function createBallparkSampler({ lateMs = BALLPARK_LATE_MS } = {}) {
  let scene = null;
  function step({ atMs, username, characterID, park, grid }) {
    const inSpace = Boolean(park && park.inSpace && grid && grid.inSpace && Number(park.solarSystemID) === Number(grid.solarSystemID));
    if (!inSpace) {
      scene = null;
      return [];
    }
    const serverRows = new Map((grid.entities || []).map((row) => [String(row.itemID), row]));
    const clientRows = new Map((park.balls || []).map((ball) => [String(ball.itemID), ball]));
    if (!scene || scene.systemID !== Number(grid.solarSystemID)) {
      scene = { systemID: Number(grid.solarSystemID), server: new Map(), extra: new Map() };
    }
    const events = [];
    const line = (status, row, fields) => ({
      kind: "CLIENT_BALL",
      source: "ballpark",
      atMs,
      username,
      characterID,
      status,
      itemID: row.itemID,
      label: row.name || row.typeName || `#${row.itemID}`,
      typeID: row.typeID || null,
      typeName: row.typeName || null,
      distanceMeters: Number.isFinite(row.distanceMeters) ? Math.round(row.distanceMeters) : null,
      ...fields,
    });
    const fresh = [...serverRows.keys()].filter((id) => !scene.server.has(id));
    const baseline = !scene.server.size || (fresh.length >= NEW_GRID_MIN && fresh.length * 2 > serverRows.size);
    for (const id of fresh) {
      const held = clientRows.has(id);
      scene.server.set(id, { firstAtMs: atMs, held, late: false, baseline });
      if (held && !baseline) events.push(line("held", serverRows.get(id), { lagMs: 0 }));
    }
    for (const [id, entry] of scene.server) {
      const row = serverRows.get(id);
      if (!row) {
        scene.server.delete(id);
        continue;
      }
      if (entry.held) continue;
      if (clientRows.has(id)) {
        entry.held = true;
        // A baseline ball the client loads in its first seconds is no news.
        if (!entry.baseline || entry.late) events.push(line("held", row, { lagMs: atMs - entry.firstAtMs }));
      } else if (!entry.late && atMs - entry.firstAtMs >= lateMs) {
        entry.late = true;
        events.push(line("missing", row, { sinceMs: atMs - entry.firstAtMs }));
      }
    }
    for (const id of scene.extra.keys()) {
      if (!clientRows.has(id) || serverRows.has(id)) scene.extra.delete(id);
    }
    for (const [id, ball] of clientRows) {
      if (serverRows.has(id) || STATIC_CATEGORIES.has(Number(ball.categoryID))) continue;
      const entry = scene.extra.get(id) || { firstAtMs: atMs, late: false };
      scene.extra.set(id, entry);
      if (!entry.late && atMs - entry.firstAtMs >= lateMs) {
        entry.late = true;
        events.push(line("extra", ball, { sinceMs: atMs - entry.firstAtMs }));
      }
    }
    return events;
  }
  return { step };
}

// A scenario's node ({ "class", "name", "text", "path", "index", "hidden" })
// as the agent's ui, find and click take it.
function nodeArgs(selector = {}) {
  const { class: cls, ...rest } = selector;
  return Object.fromEntries(Object.entries({ cls, ...rest }).filter(([, value]) => value !== undefined && value !== null));
}

// Git Bash turns an argument starting with / into a Windows path
// ("/Desktop/l_main" -> "C:/Program Files/Git/Desktop/l_main"); a node path
// always starts at the desktop, so the part from /Desktop on is the one meant.
function repairNodePath(value) {
  if (typeof value !== "string" || !value) return value;
  const at = value.search(/[\\/]Desktop([\\/]|$)/);
  if (/^[A-Za-z]:[\\/]/.test(value) && at > 0) return value.slice(at).replace(/\\/g, "/");
  return /^Desktop([\\/]|$)/.test(value) ? `/${value}` : value;
}

// The agent's error as the caller needs it: its own frames dropped (they name
// only agent.py lines), the client's and the eval's kept.
function clientErrorText(error) {
  const lines = String(error || "").replace(/\s+$/, "").split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] !== "Traceback (most recent call last):") {
      out.push(lines[i]);
      continue;
    }
    let next = i + 1;
    while (next < lines.length && /^\s+File "<gridcheck-client-agent>"/.test(lines[next])) next++;
    if (next < lines.length && /^\s+File /.test(lines[next])) out.push(lines[i]);
    i = next - 1;
  }
  return out.join("\n");
}

// Pointer coordinates are UI units (uicore.desktop's size); a picture is in pixels, scaled or not.
// uiWidth is the desktop's width the picture shows, width the saved picture's: a pointer
// coordinate is the pixel times uiPerPixel. Null when the UI size is unknown.
// A cropped picture shows uiWidth UI units from origin [left, top]: a pointer coordinate is
// the origin plus the pixel times uiPerPixel.
function uiScale({ width, uiWidth, uiHeight, origin = null }) {
  if (!(Number(width) > 0) || !(Number(uiWidth) > 0)) return null;
  return { uiWidth: Number(uiWidth), uiHeight: Number(uiHeight) || null, uiPerPixel: Math.round((Number(uiWidth) / Number(width)) * 10000) / 10000,
    ...(origin ? { uiOrigin: origin } : {}) };
}

// "1600x900; pointer coordinates are pixels x 1.2", for a picture that has a scale.
function scaleText(shot) {
  const size = `${shot.width}x${shot.height}`;
  if (!shot.uiPerPixel) return `${size}; pointer coordinates are in UI pixels, which this picture's size doesn't tell`;
  const origin = shot.uiOrigin && (shot.uiOrigin[0] || shot.uiOrigin[1]) ? `, plus (${shot.uiOrigin[0]}, ${shot.uiOrigin[1]})` : "";
  return `${size}; pointer coordinates are pixels x ${shot.uiPerPixel}${origin}`;
}

// What `client events` shows: the content host's noise hidden unless noise; with exceptions,
// only exceptions; with frame, only exceptions with a traceback line (or where) containing it,
// case-insensitive, e.g. "lu-luCommand" for the module LU delivers. -> { events, hiddenNoise }.
function filterClientEvents(rows, { noise = false, exceptions = false, frame = null } = {}) {
  const wanted = frame ? String(frame).toLowerCase() : null;
  let hiddenNoise = 0;
  const events = rows.filter((event) => {
    const exception = event.kind === "CLIENT_EXCEPTION";
    if (exception && event.noise && !noise) {
      hiddenNoise += 1;
      return false;
    }
    if ((exceptions || wanted) && !exception) return false;
    return !wanted || [event.where, ...(event.traceback || [])].some((line) => String(line || "").toLowerCase().includes(wanted));
  });
  return { events, hiddenNoise };
}

// Whether an eval's value is true in Python's sense: the agent's own answer (truth, from version 10),
// else a guess from what an older agent sent: its JSON, or the repr of what isn't plain data.
function evalTruth(value) {
  if (value && typeof value.truth === "boolean") return value.truth;
  const plain = value ? value.json : null;
  if (plain === null || plain === undefined) return value && value.repr !== "None" && value.repr !== undefined && value.repr !== null;
  if (Array.isArray(plain)) return plain.length > 0;
  if (typeof plain === "object") return Object.keys(plain).length > 0;
  return Boolean(plain);
}

// The lines `client act` prints after the action's name: whether it is done,
// where the client is now, and what it logged meanwhile.
function actSummary(value) {
  const lines = [];
  const done = value.done;
  if (value.modal && !value.done) {
    lines.push(`  waiting on a dialog: ${value.modal.name || value.modal.cls}${value.modal.text ? ` "${value.modal.text}"` : ""}`);
  } else if (!done) {
    lines.push(value.finished ? "  started" : "  still running");
  } else {
    const held = done.heldMs ? ` (after ${(done.heldMs / 1000).toFixed(1)} s for the client's session-change timer)` : "";
    lines.push(done.reached ? `  done in ${(done.ms / 1000).toFixed(1)} s${held}` : `  not done: ${done.why}${held}`);
  }
  const state = value.state;
  if (state) {
    const ego = state.ego;
    const where = state.docked ? `docked at ${state.docked}` : state.inSpace ? "in space" : "neither docked nor in space";
    lines.push(`  now ${where} in ${state.solarSystemID}${ego ? `, ${ego.mode} ${Math.round(ego.speed || 0)} m/s` +
      `${ego.followID ? ` on ${ego.followID}` : ""}` : ""}${state.changeMs ? `; next session change in ${Math.ceil(state.changeMs / 1000)} s` : ""}`);
  }
  const counts = new Map();
  for (const event of value.events || []) {
    const label = event.kind === "notify" ? event.event
      : event.kind === "message" ? `message: ${String(event.text || "").slice(0, 120)}`
        : `${event.type}: ${String(event.message || "").slice(0, 80)}`;
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  if (counts.size) {
    lines.push(`  meanwhile: ${[...counts].map(([label, count]) => (count > 1 ? `${label} (x${count})` : label)).join("; ")}`);
  }
  if (value.result !== null && value.result !== undefined) lines.push(`  returned ${JSON.stringify(value.result)}`);
  return lines;
}

module.exports = {
  BALLPARK_LATE_MS,
  CONSOLE_PS1,
  LAUNCHER_CONFIG,
  SCREENSHOT_PS1,
  actSummary,
  ballparkEvent,
  captureScreenshot,
  clientEnvironment,
  clientErrorText,
  createBallparkSampler,
  defaultResFiles,
  diagnoseStartup,
  diffBallpark,
  findClientExe,
  launchFailure,
  launchSwitches,
  nodeArgs,
  parseKey,
  readConsole,
  readTail,
  redactSwitches,
  repairNodePath,
  evalTruth,
  filterClientEvents,
  scaleText,
  screenshotArgs,
  startClient,
  uiScale,
};
