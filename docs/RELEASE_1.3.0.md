# Lumina 1.3.0

2026-11-26 品牌升级与 Antigravity 桌面版适配版，Windows x64 NSIS 安装包。

## 程序与校验

- 安装包：[Lumina-1.3.0-Setup.exe](https://github.com/whisperia6/codex-wallpaper-bridge/releases/download/v1.3.0/Lumina-1.3.0-Setup.exe)（Release 附件）。
- 文件大小：105,270,509 字节（100.39 MiB）。
- SHA-256：`6DDE9EBE5D5A173412D998D708C848714391A0ACFF78FABD5ABEBDFCF26DD113`。
- 校验清单：[SHA256SUMS.txt](https://github.com/whisperia6/codex-wallpaper-bridge/releases/download/v1.3.0/SHA256SUMS.txt)。

## 从 1.2.2 到本版的更新

### 1. 正式更名为 Lumina，全面支持 Codex 与 Antigravity 双宿主
- 桌面端正式更名为 **Lumina**（窗口标题、工作台品牌、系统托盘菜单/气泡提示及 NSIS 安装包 `Lumina-1.3.0-Setup.exe` / `Lumina.exe` 全面更新）；保留旧本地数据、配置与缓存目录兼容，升级后既有壁纸库与配置无损延续。
- 页面、状态提示与取消确认文案全面去除 Codex 硬编码，按当前所选目标动态显示 **Codex** 或 **Antigravity**。
- 新增 **Antigravity 2.0 桌面版** 自动发现与单目标一键切换：支持独立调试 profile（`antigravity-*`）、`https://127.0.0.1:<port>` 严格源校验、`cwb-win-helper.exe` 身份核验，并自动忽略 `data:` 启动页与 `--import=` 伴生子进程。

### 2. 界面无缝视觉适配与「左侧栏毛玻璃」可显隐开关
- 针对 Antigravity 桌面端提供完整壳层透明适配：清除外框留白、伪元素边框与底部渐变遮罩，统一输入框胶囊与用户气泡毛玻璃质感，同步透明化原生标题栏（`setTitleBarOverlay`）并在恢复官方外观时完整还原，同时保护弹窗、菜单、对话框与桌宠挂件。
- 在工作台 **显示设置 → 画面** 新增 **「左侧栏毛玻璃」** 显隐开关（默认开启，支持 Antigravity 与 Codex 双宿主实时切换，并与工作台「界面叠加预览」同步）。

### 3. 代理透传保护与实时壁纸切换稳定性修复
- 重启目标进入调试模式时自动提取并保留安全白名单内的代理启动参数（如 `--proxy-server`），同步至 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`，并自动附加 `--proxy-bypass-list=localhost;127.0.0.1;[::1];*.local`，避免本机 CDP 与壁纸媒体流误走代理；同时清理宿主继承的 `ELECTRON_RUN_AS_NODE`。
- 修复从 Scene 场景壁纸实时切换至 Video 视频壁纸时，在 Windows 窗口遮挡下 `requestVideoFrameCallback` 被 DWM 挂起引起的 15 秒加载超时问题，新增已解码首帧回退就绪判定。
