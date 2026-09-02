# Electron 双版本兼容桌面版规格（0.6.0-alpha.2 单工作台实验）

## 目标

提供一个可独立克隆、运行和打包的 Electron 桌面外壳，兼容 Microsoft Store 版 `OpenAI.Codex` 与用户选择的本地 `ChatGPT.exe`。

## 验收场景

### Scenario 1：自动发现安装

- Given 当前用户安装了 Store 版 Codex，或本机有正在运行的本地 `ChatGPT.exe`
- When 打开 Electron 桌面版
- Then 安装列表显示来源、版本、路径与运行状态，并合并相同可执行文件

### Scenario 2：手动选择本地 EXE

- Given 自动发现未覆盖自定义目录
- When 用户点击“选择 EXE”并选择 `ChatGPT.exe`
- Then 桌面版校验扩展名和文件存在性，并允许启动

### Scenario 3：统一应用入口与运行中确认关闭

- Given 选定的 Codex 正在普通模式运行且 CDP 端口空闲
- When 用户点击“应用到 Codex”
- Then 桌面版显示原生确认弹窗，且“取消”为默认动作
- And 选择取消时不关闭、启动或注入任何进程
- And 选择“关闭并继续”时只关闭完整可执行路径匹配的 Codex 进程
- And 关闭完成后以独立 profile 和仅监听 `127.0.0.1` 的 CDP 参数启动
- And CDP 就绪后自动完成轻量壁纸 Runtime、配置与自适应兼容层注入

### Scenario 4：已有调试端点时直接重新应用

- Given CDP 端点存在
- When 用户点击“应用到 Codex”
- Then 桌面版不重复启动 Codex，也不显示第二个“重新注入”入口
- Then 桌面版复用常驻壁纸面板进程，只发送小于 100 KiB 的 Runtime 和小于 10 KiB 的配置
- And Runtime 创建受控 `srcdoc` 媒体子页面，由子页面读取 token 保护的 `127.0.0.1` HTTP Range 服务
- And 注入成功必须验证 Runtime ready 与背景 DOM 存在，底层失败不得返回成功

### Scenario 5：跨版本透明适配

- Given Store 与本地版存在 DOM 属性或哈希类名差异
- When 自适应兼容层运行
- Then 已知新旧语义节点直接透明化，未知的大型不透明 shell 表面和背景透明但带 `backdrop-filter` 的大型滤镜表面由受限几何规则标记，并随 DOM 变化增量更新

### Scenario 6：恢复

- Given 现有桥接层和自适应兼容层均可能存在
- When 用户点击“恢复官方外观”
- Then 两层样式、观察器、标记和壁纸节点均被撤销

### Scenario 7：本地日志与自动兼容诊断

- Given 桌面版启动或执行操作
- When 产生运行输出
- Then 按日期写入 `%LOCALAPPDATA%\CodexWallpaperDesktop\logs`，并脱敏本地服务会话 token
- And 当“应用到 Codex”失败时，同目录自动生成 Codex/Chromium 版本、CDP targets、语义选择器命中数和大型表面摘要，不包含媒体 URL 或对话正文
- And 主窗口不展示运行日志或诊断正文

### Scenario 8：单工作台与保存握手

- Given Electron 主窗口已经打开
- When 用户在壁纸工作台选择壁纸或调节显示效果
- Then 不创建第二个 `BrowserWindow`
- And Codex 目标、端口、兼容开关、应用和恢复均位于同一工作台顶部
- And 不显示旧启动侧栏、快速操作、兼容诊断或运行日志面板
- And 点击“应用到 Codex”时，必须等待最近一次配置写入进入静默完成状态
- And 控制页明确显示保存失败或等待超时时，阻止注入并给出错误提示

### Scenario 9：Windows 系统托盘

- Given Electron 控制器正在运行
- When 用户最小化或关闭主窗口
- Then 应用隐藏到 Windows 系统托盘而不是退出
- And 托盘支持打开壁纸设置、应用到 Codex、恢复官方外观、打开本地日志目录和退出
- And 托盘触发注入时仍复用同一保存握手流程

### Scenario 10：文件大小与注入解耦

- Given 选择 1 MiB、500 MiB 或 10 GiB 的视频
- When 构建注入消息
- Then 三种情况的 Runtime 与配置消息大小基本一致
- And 消息中不存在媒体 Base64、完整文件字节或 renderer Blob 分块
- And 视频接口对有效 Range 返回 206，对无效 Range 返回 416

## 非目标

- 不依赖、修改、覆盖或删除仓库外部父目录中的源码、脚本、锁文件和配置。
- 当前不包含代码签名和自动更新；发布前需自行配置合法的 Windows 代码签名证书。
- 流式媒体播放期间桌面托盘进程必须保持运行；完全退出后不承诺动态壁纸继续播放。
- 第一版不实现 WebSocket + MediaSource 回退；实机已验证 Store 版可通过受控 `srcdoc` 子页面播放 Range 视频。
