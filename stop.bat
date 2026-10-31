@echo off
setlocal
cd /d "%~dp0"
node.exe server.js --stop
pause
