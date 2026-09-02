@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\electron\package.json" call npm install --no-audit --no-fund
call npm run make
endlocal
