# Codex Wallpaper Bridge

把本机 Wallpaper Engine 素材库作为 Codex 桌面端背景。程序只读取壁纸项目，并通过本机媒体服务和 CDP 注入显示层；不会修改 `WindowsApps`、`app.asar` 或 Codex 签名。

## 当前原型能力

- 自动发现 Steam 与额外库目录，解析 Wallpaper Engine AppID `431960`。
- 扫描 `defaultprojects`、`myprojects` 和 Workshop 项目。
- 本机控制页支持搜索、类型筛选、视频/Web 预览、亮度、暗化、模糊、饱和度和适配模式。
- 视频接口完整支持 HTTP `Range`、`HEAD`、`206` 和 `416`。
- CDP 注入背景层、遮罩和基础玻璃样式；刷新/SPA 重建后会重新注入。
- 支持常驻同步、退出时保留当前皮肤，以及使用已保存配置的一次性注入。
- 一键恢复并清理 DOM、样式、observer、视频资源和 CSP bypass。
- 配置原子保存到 `%LOCALAPPDATA%\CodexWallpaperBridge\config.json`。

## 快速查看预览

双击：

```text
run-preview.cmd
```

或在 PowerShell 中运行：

```powershell
cd D:\path\to\codex-wallpaper-bridge
npm install
npm run preview
```

打开控制页后选择壁纸并调节效果。如果当前 Codex 已使用 CDP 端口 `9335` 启动，点击 **注入 Codex** 即可应用。

## 启动带注入能力的 Codex

先完全退出 Codex，再运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File .\scripts\start-codex-wallpaper.ps1
```

脚本默认查找 Microsoft Store 版。如果使用解压版或自定义安装，请显式指定主程序：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned `
  -File .\scripts\start-codex-wallpaper.ps1 `
  -CodexExe 'D:\path\to\Codex\ChatGPT.exe'
```

脚本使用：

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=9335
--user-data-dir=%LOCALAPPDATA%\CodexWallpaperBridge\cdp-profile
```

独立 Chromium profile 首次可能需要重新登录。不同 Codex/Owl 版本对启动参数的转发方式不同；脚本在端口没有真正监听时会失败退出，而不会修改官方安装包。

## 常驻、保留和一次性模式

默认模式会在桥接运行时持续同步皮肤，按 `Ctrl+C` 时恢复官方外观。

调好皮肤后退出桥接、但保留当前 Codex 窗口中的效果：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned `
  -File .\scripts\start-codex-wallpaper.ps1 `
  -CodexExe 'D:\path\to\Codex\ChatGPT.exe' `
  -KeepOnExit
```

此模式会打开控制页并实时同步；调节完成后按 `Ctrl+C`，桥接进程和本地媒体服务会退出，当前皮肤继续显示。以后需要修改时，保持这个调试版 Codex 窗口运行，再执行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned `
  -File .\scripts\start-codex-wallpaper.ps1 `
  -SkipCodexLaunch `
  -KeepOnExit
```

如果不需要打开控制页，只想用已保存的配置快速重注入：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned `
  -File .\scripts\start-codex-wallpaper.ps1 `
  -SkipCodexLaunch `
  -Once
```

也可以在首次启动时组合 `-CodexExe ... -Once`。一次性/保留模式会先移除刷新钩子并关闭 CSP bypass，再断开 CDP，因此只保证当前 renderer 生命周期内有效：普通 SPA 页面切换会保留，Codex 重启、窗口硬刷新或 renderer 崩溃重建后需要重新注入。

## 恢复

控制页点击 **恢复官方外观**，或运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned `
  -File .\scripts\restore-codex.ps1
```

要同时关闭由启动脚本记录的调试 Codex：

```powershell
powershell.exe -NoProfile -ExecutionPolicy RemoteSigned `
  -File .\scripts\restore-codex.ps1 `
  -CloseDebugCodex
```

## 壁纸类型

| 类型 | 控制页 | 注入 Codex |
|---|---|---|
| Video | 动态播放 | 小于等于 32 MiB 时动态；更大时使用预览图 |
| Web | 沙箱 iframe | 当前使用预览图 |
| Scene | 预览图 | 预览图 |
| Application | 不执行 | 不执行 |

Codex 的 `app://` renderer 会以 URL safety check 拒绝直接加载 `http://127.0.0.1` 视频，即使 CDP 已绕过 CSP。因此当前原型把不超过 32 MiB 的视频复制为 renderer 自有的 `data:` 媒体；这是为了先验证真实动态效果。后续版本可改成自定义协议或分段媒体桥，避免大视频回退为静态图。

## 安全边界

- HTTP 服务只绑定 `127.0.0.1` 的随机端口。
- 每次启动生成 128-bit 随机会话路径。
- 浏览器只看到 opaque project ID，不返回绝对路径。
- 所有项目文件执行 realpath/root containment 校验。
- Web 壁纸使用 `sandbox="allow-scripts"`，不启用 `allow-same-origin`。
- Application 壁纸永不执行。
- CDP 仅绑定回环地址，但本机其他进程仍可能连接；完整退出调试 Codex 才会关闭该端口。
- 一次性注入只关闭桥接进程，不会关闭 Codex 自己的 CDP 端口；不再使用皮肤时建议恢复外观并从普通入口重启 Codex。

## 测试

```powershell
npm test
node src/cli.mjs scan
```
