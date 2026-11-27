# Lumina 1.3.1

2026-11-27 双宿主同时注入与 Microsoft Store 版 Codex 稳定性修复版，Windows x64 NSIS 安装包。

## 程序与校验

- 安装包：[Lumina-1.3.1-Setup.exe](https://github.com/whisperia6/codex-wallpaper-bridge/releases/download/v1.3.1/Lumina-1.3.1-Setup.exe)（Release 附件）。
- 文件大小：105,278,863 字节（100.40 MiB）。
- SHA-256：`68BB950FD8C014A73B073C0522F61A766C05602C8FFB3BDD09D70C30B89A1CA3`。
- 校验清单：[SHA256SUMS.txt](https://github.com/whisperia6/codex-wallpaper-bridge/releases/download/v1.3.1/SHA256SUMS.txt)。

## 从 1.3.0 到本版的更新

### 1. 支持 Codex 与 Antigravity 同时注入与独立维护
- **按宿主独立默认与记忆端口**：Codex 默认使用 `9335`、Antigravity 默认使用 `9336`，工作台切换目标下拉框时自动带出各自端口，并在 UI 与主进程两层前置拦截同端口冲突。
- **常驻控制进程与多端口解耦**：两个宿主共享同一个常驻媒体与控制进程及工作台 iframe，切换宿主或端口注入时不再重启/杀死控制进程或清除另一端已注入的壁纸。
- **桥接层多宿主并发注入器**：壁纸切换、画面参数调整、播放/暂停、重新扫描、电源状态、场景预加载与重试同步扇出至全部活跃宿主；单独恢复其中一个宿主不影响另一宿主，应用退出时统一清理全部活跃宿主。
- **主进程按端口实时核验与独立自动接管**：端口所有者映射改为按端口索引并保持每次实时核验；Codex 与 Antigravity 的自动接管监控独立运行、互不取消；强化 VP8 单接收端故障与慢端跳帧隔离、恢复连接端点绑定校验与待对账状态同步。

### 2. 修复 Microsoft Store 版 Codex 卡白屏、任务栏白图标与冷启动注入失败
- **MSIX 身份激活回退链路**：当原生 `cwb-win-helper.exe` 调用 COM `IApplicationActivationManager` 遇到 `E_ACCESSDENIED` 时自动回退到 PowerShell 激活；若 COM 激活均失败，优先通过经包族严格校验的 MSIX `AppExecutionAlias`（如 `chatgpt-desktop.exe`）启动，完整保留 MSIX 包身份与正常任务栏图标，避免裸启 `WindowsApps\...\ChatGPT.exe`。
- **根治 Codex 注入后 100% CPU 微任务死循环卡死白屏**：修复 `sidebarFrosted` 样式混用 `border-color` 简写与 `border-right-color` 长属性导致的 CSSOM 序列化不匹配循环，改为四边独立长属性、宏任务合并调度与 `takeRecords()` 屏蔽自触发，并加固主题观察器竞争熔断与卸载竞态。
- **冷启动稳定性增强**：恢复 Codex 语义就绪门槛并将 Codex 默认等待超时放宽至 45 秒；为普通媒体冷启动首次注入增加最多 1 次稳态自愈重试、刷新导航/断线保护、主题原偏好保护及 `attach-error` 安全枚举诊断字段。
