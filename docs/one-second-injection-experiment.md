# 1 秒级注入实验版

本实验版依据 `1秒注入架构设计.md`，验证“CDP 只传程序和配置、媒体走本机 HTTP Range”的路线。它位于独立分支 `experiment/one-second-injection`，不会替换 0.5.1 稳定版。

## 架构决策记录

- **决策点**：如何让大视频文件大小不再影响 Codex 注入耗时。
- **候选方案 A**：继续优化 Base64/Blob 分块大小和并发数。
- **候选方案 B**：常驻 loopback 媒体服务，轻量 `srcdoc` 子页面直接读取 HTTP Range 地址。
- **候选方案 C**：WebSocket + MediaSource + fragmented MP4。
- **选择**：方案 B。
- **选择理由**：现有媒体服务已经支持 Range 与扫描 ID 白名单；CDP 只需传几十 KiB Runtime 和数 KiB 配置，媒体大小不进入注入复杂度。
- **反选论证**：方案 A 仍需把完整文件送进 CDP，无法满足 10 GiB 场景；方案 C 对编码格式、分片和 SourceBuffer 生命周期要求更高，不适合作为第一版验证。
- **接受的代价**：动态壁纸播放期间桌面程序必须驻留托盘；完全退出后本地媒体 URL 会失效。
- **实机修正**：Store 版父 renderer 会拒绝直接 loopback URL，CDP Fetch 没有拦截到该安全检查，renderer WebSocket 也被拒绝；无 sandbox 的固定 `srcdoc` 子页面能够读取 loopback 视频，因此方案 B 采用子页面媒体桥。Web 壁纸仍放在内层 `sandbox="allow-scripts"` iframe 中。
- **撤销条件**：目标 Store/本地 Chromium 中 `srcdoc` Range 播放不稳定，或安全边界无法继续保持时，重新评估方案 C。
- **验证**：自动化检查脚本体积、无媒体 Base64、URL 边界、Range 206/416、reload/restore；真实 Store 版记录到 Runtime 1.7 ms、DOM 32 ms、总计 35.1 ms，3840×1758 视频 `readyState=4`、`playing`、无错误。

## 非功能需求设计

| 维度 | 决策 |
|---|---|
| 并发/竞态 | 每个 target 独立 Runtime；媒体由 Chromium 自身按 Range 并发读取，配置更新复用同一背景节点。 |
| 幂等 | Bootstrap 版本一致时复用 Runtime；apply 复用 DOM，restore 可重复调用。 |
| 超时/重试 | CDP 命令有固定上限；target 扫描按现有间隔重试。 |
| 降级 | Runtime/DOM 验证失败直接报错；第一版不伪装成成功或自动回退模糊预览。 |
| 容量/规模 | 媒体由文件流和 Range 提供，不读取完整视频进 JavaScript 内存。 |
| 可观测性 | 分开记录 runtime、DOM apply、媒体加载/播放状态与耗时。 |
| 安全 | 服务仅绑定 127.0.0.1，路径含随机 token，媒体只能通过扫描 ID 获取。 |

## 运行约束

实验版的“注入完成”表示 Runtime 与 DOM 已安装完成，不等于任意编码的视频都已显示首帧。视频首帧仍取决于磁盘、编码、关键帧位置和 Chromium 解码支持。
