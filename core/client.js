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
// stay empty too); readConsole reads that console instead. The pid is the
// launcher's: exefile.exe hands off to a second process, whose pid the agent reports.
function startClient({ exe, args, env, spawnImpl = spawn }) {
  const child = spawnImpl(exe, args, { cwd: path.dirname(exe), env, detached: true, stdio: "ignore" });
  child.unref();
  return child;
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
// D3D window from outside. A minimized window can't be drawn.
const SCREENSHOT_PS1 = String.raw`param([int]$TargetPid, [string]$Out, [int]$MaxWidth = 0, [string]$Format = 'png')
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
[void][GridcheckShot]::GetWindowText($h, $t, 256)
Write-Output ("OK {0} {1} {2}" -f $outW, $outH, $t.ToString())
`;

// -> { file, width, height, title } or { error }.
function takeScreenshot({ pid, out, maxWidth = 0, format = "png", run = spawnSync }) {
  if (process.platform !== "win32") return { error: "screenshots use Windows' PrintWindow; this isn't Windows" };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const reply = runPowerShell(SCREENSHOT_PS1,
    ["-TargetPid", String(pid), "-Out", out, "-MaxWidth", String(maxWidth), "-Format", format], run);
  const text = `${reply.stdout || ""}`.trim();
  const ok = /^OK (\d+) (\d+) ?(.*)$/m.exec(text);
  if (ok) return { file: out, width: Number(ok[1]), height: Number(ok[2]), title: ok[3] || null };
  const failed = /^ERROR (.*)$/m.exec(text);
  return { error: failed ? failed[1] : `the screenshot script failed: ${(text || reply.stderr || String(reply.error || "")).trim().slice(0, 400)}` };
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

module.exports = {
  CONSOLE_PS1,
  LAUNCHER_CONFIG,
  SCREENSHOT_PS1,
  clientEnvironment,
  defaultResFiles,
  diffBallpark,
  findClientExe,
  readConsole,
  startClient,
  takeScreenshot,
};
