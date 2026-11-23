# Codex Wallpaper Desktop 1.2.1

2026-11-23 修复版，Windows x64 NSIS 安装包。

## 程序与校验

- 安装包：[CodexWallpaperDesktop-1.2.1-Setup.exe](https://github.com/whisperia6/codex-wallpaper-bridge/releases/download/v1.2.1/CodexWallpaperDesktop-1.2.1-Setup.exe)（Release 附件）。
- 文件大小：105,126,591 字节（100.26 MiB）。
- SHA-256：`3627FC0D96F194DB76FA16046A1B801CF544C4B52B8856592244880C48EEC0C6`。
- 校验清单：[SHA256SUMS.txt](https://github.com/whisperia6/codex-wallpaper-bridge/releases/download/v1.2.1/SHA256SUMS.txt)。

## 从 1.2.0 到本版的更新

### 1. 修复 Codex 关闭重启后二次注入失效
- 串行化常驻 `CdpWallpaperInjector` 的目标扫描流程，并为每个会话记录 `appliedPlanVersion`。
- 当 Codex 退出重启、桌面版保持运行时，再次点击「应用到 Codex」会先等待进行中的扫描/附着完成并主动执行 `scanOnce()`，重新发现并注入新的 Codex 页面，不再出现无响应或误报失败。
- Codex 暂时关闭时，修改壁纸配置正常落盘保存，不再因当前无附着会话而误报保存失败。

### 2. 修复本地 EXE 版进程发现、关闭与权限提示
- 取消进程查询、关闭与监控中对 `ChatGPT.exe` 的硬编码，改为按目标可执行文件的实际进程名处理，兼容 `Codex.exe` 与手动选择的本地 `.exe`。
- 改进关闭流程：先结束主/浏览器进程再结束子进程，非接管模式下等待期间对残余或新拉起进程继续补杀（自动接管模式仍严格保持白名单父 PID 校验）。
- 捕获并上报进程关闭时的权限不足（如 `ERROR_ACCESS_DENIED` / `win32:5`）：若目标 Codex 以管理员身份运行导致普通权限无法结束，快速给出明确的权限提示而不再干等 12 秒超时。

### 3. 修复隐藏窗口确认框与托盘退出清理问题
- 弹出“关闭/另开 Codex”确认框前，若主窗口处于隐藏或最小化到托盘状态会先自动唤起，避免弹窗不可见或阻断交互。
- 修复 Codex 已退出后从托盘退出 CWB 时因 CDP 端口不可达导致「退出清理未完成」的问题。
- 对连续相同的 `[CDP] waiting` 状态去重，避免 Codex 关闭期间日志持续刷屏。
