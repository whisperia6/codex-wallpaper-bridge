# Codex Wallpaper Desktop 1.2.2

2026-11-24 稳定性与安全加固版，Windows x64 NSIS 安装包。

## 程序与校验

- 安装包：[CodexWallpaperDesktop-1.2.2-Setup.exe](https://github.com/whisperia6/codex-wallpaper-bridge/releases/download/v1.2.2/CodexWallpaperDesktop-1.2.2-Setup.exe)（Release 附件）。
- 文件大小：105,263,275 字节（100.39 MiB）。
- SHA-256：`CAE2DC77D7E820F06FAD318B032614C8E29B6BD3D0DA1289C45385AFF30EB2E6`。
- 校验清单：[SHA256SUMS.txt](https://github.com/whisperia6/codex-wallpaper-bridge/releases/download/v1.2.2/SHA256SUMS.txt)。

## 从 1.2.1 到本版的更新

### 1. 应用图标更新与 NSIS 覆盖升级优雅退出
- 替换全新的多分辨率应用图标（`build/icon.ico`，覆盖主程序 EXE、NSIS 安装/卸载向导、窗口与系统托盘图标）。
- 新增 `--quit-running-instance` 单实例退出参数与 NSIS 安装钩子（`build/installer.nsh`），覆盖安装或卸载前先通知正在运行的旧实例优雅还原并退出。

### 2. CDP 还原、Store 激活与进程识别稳定性修复
- 修复 `CdpWallpaperInjector` 在端点提前断开（`ECONNABORTED` / `TimeoutError` / `AbortError`）或目标窗口数为 0 时的还原判定与 `appliedPlanVersion` 版本竞态；`restore({ preserveTheme: true })` 时同步停止主题观察器，避免资源残留。
- 延长预览子进程默认退出等待超时至 15 秒，降低高负载下误判超时的概率。
- 为 Microsoft Store AUMID 激活补全 `[PreserveSig]` 并在激活前快照已有 PID，返回 `createdNew` 标记，避免命中已有 Codex 实例时误注册强杀回调。
- 统一按当前 Windows `SessionId` 过滤进程枚举、关闭与监控，强化 `ChatGPT.exe` / `Codex.exe` 身份与 Electron 桌面布局校验，Store `AppxManifest.xml` 同时兼容 `ChatGPT.exe` 与 `Codex.exe`。
- 改进 `cwb-win-helper` 错误处理与降级：补全 DLL 加载器初始化失败码（`0xC0000142` / `0xC0000135` / `0xC0000022`），瞬态 `EBUSY` 不再永久禁用原生助手；非中止异常自动回退 PowerShell，提权进程核验保留 native 查询路径。

### 3. 本地服务与宿主安全加固
- `runtime.json` 改为仅记录 `bridgeOrigin`，不再明文落盘含访问令牌的 `bridgeUrl`。
- 本地媒体服务的 `#static` 与 `#web` 路由关闭宽泛 CORS 并附加 `X-Content-Type-Options: nosniff`，为 `#web` 全部响应施加严格 sandbox CSP，为 `#static` HTML 增加 `frame-ancestors` 策略。
- 宿主通信 `postMessage` 的 `targetOrigin` 与入站 `event.origin` 严格锁定为 `cwb-desktop://shell`，本地控制请求统一携带 `Origin` 头。
- 为 Electron 默认 Session 安装全拒绝权限处理器；手动选择本地 EXE 时增加元数据校验并在不匹配 Codex 时给出告警。
- 移除打包脚本中的本机 `F:\` 路径硬编码，统一默认使用 `out/.nsis-build`。
