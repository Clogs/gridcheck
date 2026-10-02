@echo off
rem Opens the evejs-e2e GUI in your browser. Close this window, or press Ctrl-C, to stop it.
rem From an evejs-e2e checkout it manages any EveJS tree; from a tree's tools/evejs-e2e/ it
rem manages that tree. Arguments go to `e2e gui`, e.g. OpenGui.bat --tree F:/EveJS-0.12.9
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo evejs-e2e needs Node.js 24 or later on PATH: https://nodejs.org/
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  for /f "delims=" %%v in ('node -v') do echo evejs-e2e needs Node.js 24 or later; this is %%v: https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0bin/e2e.js" gui --open %*
if errorlevel 1 pause
