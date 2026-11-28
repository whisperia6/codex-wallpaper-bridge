# Lumina 1.4.0

2026-11-28 渲染引擎升级、全局液态玻璃、六标签工作台改版与智能省电更新，Windows x64 NSIS 安装包。

## 程序与校验

- 安装包：[Lumina-1.4.0-Setup.exe](https://github.com/whisperia6/lumina/releases/download/v1.4.0/Lumina-1.4.0-Setup.exe)（Release 附件）。
- 校验清单：[SHA256SUMS.txt](https://github.com/whisperia6/lumina/releases/download/v1.4.0/SHA256SUMS.txt)（由发版工作流自动生成并随附）。

## 从 1.3.1 到本版的更新

### 1. WebWallGL 3.1.0 升级与场景多级回退链
- **引擎升级与离线完整性校验**：内置场景渲染引擎从 WebWallGL 2.1.0 升级至 **WebWallGL 3.1.0**（配套 Mediabunny 1.56.0），启动前校验 SHA-256 供应锁，完全离线运行。
- **首帧海报垫底与防误判超时**：场景首帧就绪前使用预览图垫底防黑屏，确认首帧后平滑淡出；按 `scene.pkg` 包体大小动态计算首帧预算，缓存包改为 64 KiB 分块背压传输并随进度续期（上限对齐离屏、IPC、CDP 与 HTTP 全链路）。
- **内嵌 MP4 / WebM 自动降级**：实时渲染失败或超时后，按需通过 HTTP Range 优先播放 `scene.pkg` 中可用的内嵌视频，其次回退至指定静态图或默认预览图，并保留手动重试入口。

### 2. Codex 与 Antigravity 双宿主全局液态玻璃
- **多维度实时材质控制**：新增液态玻璃总开关、「左侧栏」「输入框 / 气泡」区域开关，以及透明度、模糊强度、边框高光、色彩饱和度与深邃（Dark）/ 中性（Neutral）/ 冰霜（Frost）三种色调。
- **双宿主实时生效与安全保护**：参数变更实时下发至已注入宿主，无需重启；严格保护弹窗、菜单、Portal 及各类可编辑输入控件（含 `textarea`、`contenteditable` 与 `plaintext-only`），恢复官方外观时彻底清理全部属性与 CSS 变量。

### 3. 全新六标签分组卡片式「显示设置」
- 右侧面板重组为 **画面 / 玻璃 / 播放 / 作者 / 音乐 / 视频** 六个标签，支持键盘导航与深浅双主题。
- 「填充方式」与「玻璃色调」升级为三段式分段按钮，短开关整理为双列卡片，「玻璃」页签内置实时材质采样预览卡，低频「取景与精细色彩」与「Web 壁纸循环设置」默认折叠。

### 4. Win32 原生窗口遮挡自动暂停
- 在原生 `cwb-win-helper.exe` 中新增 `window-occlusion` 命令，按 Win32 Z-order 对多个完全不透明顶层窗口执行有界联合矩形覆盖计算，准确区分半透明窗与遮挡窗。
- 目标窗口被完全遮挡时仅同步状态变化原地暂停/恢复视频、Web 与 Scene 壁纸，不覆盖用户手动暂停状态；工作台「播放」页签提供独立「遮挡暂停」开关。

### 5. 轻量版本更新提醒与 Lumina 品牌统一
- 桌面端启动约 4 秒后在后台静默检查 `whisperia6/lumina` 最新稳定版 Release（6 小时冷却、5 秒超时、严格 Release URL 白名单校验、支持按版本忽略），不自动下载或打断工作流。
- 统一文档、工作台、CLI 与更新接口至 **Lumina / `whisperia6/lumina`**，同时完整保留旧版数据目录、缓存目录与 NSIS `appId` 兼容。
