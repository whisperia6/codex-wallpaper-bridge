@echo off
setlocal
cd /d "%~dp0"
set "npm_config_electron_mirror=https://npmmirror.com/mirrors/electron/"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"
if not exist "node_modules\electron\package.json" call npm install --no-audit --no-fund
call npm run make
endlocal
