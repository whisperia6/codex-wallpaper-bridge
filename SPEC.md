# Electron 双版本兼容桌面版规格

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

### Scenario 3：运行中确认关闭、启动并自动注入

- Given 选定的 Codex 正在普通模式运行且 CDP 端口空闲
- When 用户点击“启动调试并注入”
- Then 桌面版显示原生确认弹窗，且“取消”为默认动作
- And 选择取消时不关闭、启动或注入任何进程
- And 选择“关闭并继续”时只关闭完整可执行路径匹配的 Codex 进程
- And 关闭完成后以独立 profile 和仅监听 `127.0.0.1` 的 CDP 参数启动
- And CDP 就绪后自动完成壁纸层与自适应兼容层的一次性注入

### Scenario 4：一次性注入

- Given CDP 端点存在
- When 用户点击“一次性注入”
- Then 桌面版调用仓库内置桥接运行时完成壁纸注入，再安装自适应兼容层；命令结束后无需常驻桌面版，当前 renderer 保留效果

### Scenario 5：跨版本透明适配

- Given Store 与本地版存在 DOM 属性或哈希类名差异
- When 自适应兼容层运行
- Then 已知新旧语义节点直接透明化，未知的大型不透明 shell 表面和背景透明但带 `backdrop-filter` 的大型滤镜表面由受限几何规则标记，并随 DOM 变化增量更新

### Scenario 6：恢复

- Given 现有桥接层和自适应兼容层均可能存在
- When 用户点击“恢复官方外观”
- Then 两层样式、观察器、标记和壁纸节点均被撤销

### Scenario 7：诊断导出

- Given 另一台 Store 电脑无法在当前开发机复现
- When 用户点击“导出兼容诊断”
- Then 桌面版导出 Codex/Chromium 版本、CDP targets、语义选择器命中数、大型表面背景/滤镜摘要和壁纸媒体安全指标，不包含媒体 URL 或对话正文

### Scenario 8：同窗壁纸设置与保存握手

- Given Electron 主窗口已经打开
- When 用户在右侧内嵌壁纸面板选择壁纸或调节显示效果
- Then 不创建第二个 `BrowserWindow`
- And 点击启动或一次性注入时，必须等待最近一次配置写入进入静默完成状态
- And 控制页明确显示保存失败或等待超时时，阻止注入并给出错误提示

### Scenario 9：Windows 系统托盘

- Given Electron 控制器正在运行
- When 用户最小化或关闭主窗口
- Then 应用隐藏到 Windows 系统托盘而不是退出
- And 托盘支持显示主窗口、打开壁纸设置、启动并注入、重新注入、恢复和退出
- And 托盘触发注入时仍复用同一保存握手流程

## 非目标

- 不依赖、修改、覆盖或删除仓库外部父目录中的源码、脚本、锁文件和配置。
- 当前不包含代码签名和自动更新；发布前需自行配置合法的 Windows 代码签名证书。
- 不承诺皮肤跨 Codex 重启或 renderer 重建永久存在；这些事件后需重新注入。
