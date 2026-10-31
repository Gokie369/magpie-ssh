@echo off
setlocal
title Magpie Tunnel Panel
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install Node.js 18 or newer.
  pause
  exit /b 1
)
for /f "tokens=1 delims=." %%v in ('node.exe -p "process.versions.node"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 18 (
  echo Node.js 18 or newer is required. Found version %NODE_MAJOR%.
  pause
  exit /b 1
)
node.exe server.js
if errorlevel 1 pause
