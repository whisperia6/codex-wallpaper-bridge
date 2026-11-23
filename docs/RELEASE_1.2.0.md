# Codex Wallpaper Desktop 1.2.0

2026-11-23 正式版，Windows x64 NSIS 安装包。

## 程序与校验

- 安装包：[CodexWallpaperDesktop-1.2.0-Setup.exe](https://github.com/whisperia6/codex-wallpaper-bridge/releases/download/v1.2.0/CodexWallpaperDesktop-1.2.0-Setup.exe)（Release 附件）。
- 文件大小：105,122,657 字节（100.25 MiB）。
- SHA-256：`6BB5ADA88A56042810FFCB446F8B412840C2C977329B0F692CBE4B7CA87AD100`。
- 校验清单：[SHA256SUMS.txt](https://github.com/whisperia6/codex-wallpaper-bridge/releases/download/v1.2.0/SHA256SUMS.txt)。

## 从 1.1.0 到本版的更新

### 1. 注入与启动速度大幅提升
- 新增构建期预编译的原生 Windows 辅助程序 `cwb-win-helper.exe`，使用 `iphlpapi`、`NtQueryInformationProcess` 与 `QueryFullProcessImageName` 替代高频 PowerShell 冷启动与运行时 C# 编译。
- 单次 CDP 端口归属核验耗时从 3.5–8.5 秒降至 ~130 ms，热重注流程缩短至约 1 秒左右；原有端口/进程归属安全校验全部保留，低权限或异常环境下自动平滑回退。
- 合并静态安装发现并引入 60 秒缓存（运行进程仍实时查询），缩短端口探测、页面等待与文档刷新的轮询间隔。

### 2. 修复 Microsoft Store 版任务栏双图标
- 发现 Store 安装时解析 `PackageFamilyName!ApplicationId`（AUMID），启动时通过 Windows COM `IApplicationActivationManager` 以原生 Store 身份拉起调试实例，消除任务栏双图标；激活失败时自动回退直接启动。

### 3. 修复 Scene / Web 背景模糊与新版 Codex 底部黑边
- 为 `direct-gpu` 渲染器补齐背景模糊（含防边缘黑边过扫描）、亮度、饱和度、对比度与不透明度样式，修复 Scene / Web 壁纸调节模糊等参数无效的问题。
- 适配新版 Codex（`26.1117.4957.0`），使用语义 `:has()` 选择器清除底部输入框外层页脚容器及 `::before` / `::after` 伪元素的深色遮罩，保留输入框主体与弹窗样式。
- 修复工作台切换/重试与引擎状态同步问题。

### 4. 工作台界面改版与正式 NSIS 安装包
- 重构壁纸工作台深浅色主题、双列壁纸网格与 5 标签右侧设置面板（画面 / 作者 / 过场 / 音乐 / 视频）。
- 发布格式由单文件自解压 Portable 切换为 **NSIS 正式安装包**：支持中文安装向导、自选安装目录（如 D / F 盘）、安装后秒开且不再往 C 盘 `Temp` 解压 370 MB 临时目录，卸载默认保留个人配置。
- 裁剪 Electron 多余语言包，仅保留 `zh-CN` / `en-US`（安装占用减少约 45 MB）；保留 ASAR 完整性校验与 Electron Fuses 安全开关。
