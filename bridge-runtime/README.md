# Lumina 运行时

本目录包含壁纸工作台、本机媒体服务、资源管理和 Codex 页面显示层。普通用户请从 [项目首页](../README.md) 获取使用说明，并在 [GitHub Releases](https://github.com/whisperia6/lumina/releases) 下载 EXE。

## 目录结构

| 目录 | 用途 |
| --- | --- |
| `src/` | 配置、资源库、媒体服务、Scene/Web 传输及作者属性 |
| `public/` | 工作台界面、主题与浏览器侧兼容接口 |
| `native/` | Windows 系统音频和媒体集成辅助代码 |
| `vendor/` | 固定版本的第三方渲染器、许可和对应源码归档 |

## 从源码运行

在仓库根目录执行：

```powershell
npm ci
npm start
```

根目录 Electron 程序负责安装发现、启动确认、常驻服务和托盘生命周期。工作台中选择目标 Codex，再选择壁纸并应用；需要重启目标或另开其他版本时，以程序的确认提示为准。

媒体资源由本机常驻服务按需读取，视频支持 HTTP Range/HEAD。关闭工作台到托盘后服务继续运行；彻底退出后，动态壁纸不能继续依赖本程序读取媒体。

## 配置与资源

- 配置默认位于 `%LOCALAPPDATA%\CodexWallpaperBridge\config.json`，当前 schemaVersion 为 2。
- 配置升级前备份；损坏或版本过新的配置不会被静默覆盖，写入失败不提交内存状态。
- Wallpaper Engine 原始项目只读；导入文件、作者属性文件和目录使用程序管理的副本。
- 资源库和缓存分别管理，迁移时复制并校验，旧副本保留以便回退。
- 视频优化需要用户自行安装 ffmpeg/ffprobe；没有工具仍可播放原片。可用 `CWB_FFMPEG_PATH`、`CWB_FFPROBE_PATH` 指定工具路径。
- `CWB_CACHE_ROOT` 可覆盖缓存位置；覆盖生效时禁用工作台目录迁移，避免修改配置却仍使用环境变量目录。

导入单文件最大 20 GiB；任务暂不支持断点续传。文件结构检查通过不代表其中的编码一定能被播放器解码。

## Web 与 Scene

Web 壁纸的作者属性、目录、音频和媒体回调见 [Web 壁纸接口](../docs/WEB_API.md)。兼容 Scene 由固定版本 WebWallGL 渲染；该集成不承诺支持 Wallpaper Engine 的所有脚本、插件和效果。

Scene/Web 渲染失败时可使用静态回退和手动重试。预览图、工作台预览以及自动化测试，不等同于真实 Codex 双版本中的动态显示和完整生命周期验收。已知限制见 [项目首页](../README.md#目前的限制)。

## 服务边界

- HTTP 服务仅监听 `127.0.0.1`，使用随机会话路径；写请求检查来源。
- 项目资源进行路径归属与链接检查，不能通过壁纸接口读取任意本机文件。
- 受管资源移除不删除 WE 原件；迁移不清理旧副本或未知文件。
- Web/Scene 使用独立资源与兼容消息边界，不向作者脚本开放 Node、任意命令或主服务控制接口。
- Application 壁纸不执行。CDP 调试端口属于所选 Codex 进程，退出本程序不等于关闭目标的调试端口。

第三方文件必须保留原始字节，不手工修改锁定资源。来源、版本和许可证见 [第三方声明](vendor/webwallgl/NOTICE.md)。

## 开发与测试

`bridge-overrides/` 中有同名文件时，以该目录为维护源；修改后在仓库根目录运行：

```powershell
npm run sync:bridge
node --test test/m3-provider-recovery.test.mjs test/m3-workbench-readiness.test.mjs
```

其余 runtime 模块直接在本目录维护。完整测试源码保留在根目录 `test/`；构建输出、调试日志、内部阶段记录和个人配置不提交。发布成品通过 Release 附件分发。
