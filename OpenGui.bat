@echo off
rem Opens the Gridcheck GUI in your browser. Close this window, or press Ctrl-C, to stop it.
rem From a Gridcheck checkout it manages any EveJS tree; from a tree's tools/gridcheck/ it
rem manages that tree. Arguments go to `gridcheck gui`, e.g. OpenGui.bat --tree <tree>
setlocal
rem title and color work in every console, Windows Terminal included. A batch file can't set
rem its window's icon; a shortcut to this file can (Properties, Change Icon).
title Gridcheck GUI
color 06
echo.
echo   ^<^> Gridcheck GUI
echo   Your browser opens on the page. Keep this window open while you use it;
echo   close it, or press Ctrl-C, to stop the GUI.
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Gridcheck needs Node.js 24 or later on PATH: https://nodejs.org/
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 24 ? 0 : 1)"
if errorlevel 1 (
  for /f "delims=" %%v in ('node -v') do echo Gridcheck needs Node.js 24 or later; this is %%v: https://nodejs.org/
  pause
  exit /b 1
)
node "%~dp0bin/gridcheck.js" gui --open %*
if errorlevel 1 (
  color 0C
  echo.
  echo   The Gridcheck GUI stopped with an error; the lines above say why.
  pause
)
rem Run from an open prompt, give it back its own colours.
color
