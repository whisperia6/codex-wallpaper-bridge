<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.svg" />
  <source media="(prefers-color-scheme: light)" srcset="docs/images/hero-light.svg" />
  <img alt="Lumina — 为 Windows 上的 Codex 与 Antigravity 桌面版换上动态壁纸与液态玻璃" src="docs/images/hero-dark.svg" width="100%" />
</picture>

<br /><br />

[![Release](https://img.shields.io/github/v/release/whisperia6/lumina?style=flat-square&label=Release&color=6366f1&labelColor=1e293b)](https://github.com/whisperia6/lumina/releases/latest)
![Windows x64](https://img.shields.io/badge/Windows-x64-0ea5e9?style=flat-square&labelColor=1e293b)
![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-10b981?style=flat-square&labelColor=1e293b)
![WebWallGL 3.1.0](https://img.shields.io/badge/WebWallGL-3.1.0-8b5cf6?style=flat-square&labelColor=1e293b)

<p>
  <a href="#界面预览">界面预览</a> &nbsp;·&nbsp;
  <a href="#核心特性">核心特性</a> &nbsp;·&nbsp;
  <a href="#支持壁纸类型">支持类型</a> &nbsp;·&nbsp;
  <a href="#快速开始">快速开始</a> &nbsp;·&nbsp;
  <a href="#构建与开发">构建与开发</a> &nbsp;·&nbsp;
  <a href="#安全与已知限制">安全与限制</a>
</p>

<p>
  <sub>通过本机 Chrome DevTools Protocol（CDP）在运行时无损挂载动态背景与液态玻璃，<strong>不修改目标应用安装文件</strong>，随时一键恢复官方外观。本项目为非官方工具。</sub>
</p>

</div>

---

## 界面预览

<table>
  <tr>
    <td width="50%" align="center">
      <a href="docs/images/控制台.png"><img src="docs/images/控制台.png" alt="深色工作台、桌面目标栏与画面设置" width="100%" /></a>
      <br /><sub><strong>六标签卡片工作台</strong> · 桌面目标栏 + 壁纸库 + 画面调校</sub>
    </td>
    <td width="50%" align="center">
      <a href="docs/images/液态玻璃.png"><img src="docs/images/液态玻璃.png" alt="液态玻璃材质预览、色调与界面叠加效果" width="100%" /></a>
      <br /><sub><strong>全局液态玻璃</strong> · 实时材质采样 + 界面叠加预览</sub>
    </td>
  </tr>
</table>

---

## 核心特性

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>WebWallGL 3.1.0 实时场景与多级回退</strong><br />
      <sub>内置离线校验的 WebWallGL 3.1.0 与 Mediabunny。首帧就绪前用预览图垫底防黑屏；按包体动态算超时并随分块传输进度延长；失败自动降级播放 <code>scene.pkg</code> 内嵌 MP4 / WebM 或静态回退图，支持手动重试。</sub>
    </td>
    <td width="50%" valign="top">
      <strong>Codex &amp; Antigravity 全局液态玻璃</strong><br />
      <sub>双宿主支持液态玻璃总开关与「左侧栏」「输入框 / 气泡」分面开关；可实时调节透明度、模糊、边框高光、饱和度及深邃 / 中性 / 冰霜色调，严格保护弹窗、菜单与原生输入控件，无需重启即刻生效。</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>六标签分组卡片工作台</strong><br />
      <sub>右侧设置按 <strong>画面 / 玻璃 / 播放 / 作者 / 音乐 / 视频</strong> 清晰分组，采用分段药丸、双列开关卡与玻璃材质实时采样卡；支持深浅双主题与「纯壁纸 / 界面叠加」预览切换。</sub>
    </td>
    <td width="50%" valign="top">
      <strong>Win32 遮挡自动暂停与智能省电</strong><br />
      <sub>支持窗口隐藏、<strong>窗口被其他不透明应用完全遮挡</strong>（原生 Win32 Z-order 联合矩形覆盖计算）、电池供电三路自动暂停，互不覆盖手动播放状态，挂后台零显卡浪费。</sub>
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>双宿主极速注入与原生加速</strong><br />
      <sub>自动发现 Store / EXE 版 Codex 与 Antigravity，Store 版以原生 AUMID 启动避免双图标；内置 <code>cwb-win-helper.exe</code> 将端口与进程核验压至 ~130 ms，保留代理参数并自动绕过 <code>127.0.0.1</code>。</sub>
    </td>
    <td width="50%" valign="top">
      <strong>播控过场、音乐联动与轻量更新提醒</strong><br />
      <sub>内置多播放列表、WE JSON 导入、7 种切换过场、20 GiB 大文件去重导入、系统输出频谱 / 歌词 / 反向控制、MP4 Faststart / ffmpeg 转码；启动后静默检查 GitHub Releases 新版（6 小时冷却 + URL 白名单校验）。</sub>
    </td>
  </tr>
</table>

---

## 支持壁纸类型

| 类型 | 支持能力 |
| --- | --- |
| **Scene 场景** | 内置 WebWallGL 3.1.0 GPU 实时渲染，支持作者属性、频谱响应、首帧海报垫底、内嵌 MP4 / WebM 自动降级与手动重试 |
| **Web 网页** | 加载本地网页项目，支持作者属性、系统频谱、媒体信息、自动单套循环及扩展控制回调 |
| **Video 视频** | 导入 MP4 或读取本地视频壁纸；本机 HTTP Range 按需流式读取，支持倍速、音量、Faststart 虚拟前置与 ffmpeg 后台转码 |
| **Image 图片** | 导入 JPG / PNG 或读取本地壁纸项目；实时取景、缩放、镜像与画质调校 |

---

## 快速开始

### 环境要求
- **Windows 10 / 11（x64）**，已安装 Codex 桌面版（Microsoft Store 版或本地 EXE 版）或 Antigravity 桌面版。
- 仅使用自有图片 / 视频时**不需要**安装 Wallpaper Engine；仅在视频转码优化时需要本机 `ffmpeg` / `ffprobe`。

### 方式一：下载安装包（推荐）

前往 [GitHub Releases](https://github.com/whisperia6/lumina/releases/latest) 下载最新版安装包（当前发布 `v1.3.1`：[Lumina-1.3.1-Setup.exe](https://github.com/whisperia6/lumina/releases/download/v1.3.1/Lumina-1.3.1-Setup.exe)）：
- 中文安装向导，支持自选安装目录（推荐 D / F 盘），安装后秒开；卸载默认保留个人壁纸设置。

### 方式二：从源码运行（Node.js 22+）

```powershell
git clone https://github.com/whisperia6/lumina.git
cd lumina
npm ci
npm start
```

安装依赖后也可直接双击根目录的 `run-electron.cmd`。

### 首次应用四步走
1. 在顶部目标栏选择 **Codex** 或 **Antigravity**（未自动发现时点击「选择 EXE」）。
2. 扫描本机 Wallpaper Engine 库，或直接导入自己的图片 / 视频，在右侧调整「画面」与「玻璃」参数。
3. 点击 **「应用到 Codex / Antigravity」**：匹配端口就绪时直接热注入；普通模式运行时按提示确认重启进入调试模式（请先保存未发送输入）。
4. 首次以独立调试 profile 启动目标应用可能需要重新登录。随时可点击 **「恢复官方外观」** 或从系统托盘退出。

---

## 构建与开发

<details>
<summary><strong>展开查看：打包命令、可选环境变量、目录结构与测试</strong></summary>

<br />

### 构建与打包

```powershell
npm ci
npm run package
```

或安装依赖后双击 `make-electron.cmd`（等价于 `npm run make`），产物输出至 `out/release-<版本号>/Lumina-<版本号>-Setup.exe`。

- 构建阶段自动同步 `bridge-overrides/`、用 `esbuild` 打包主进程与桥接运行时，并用系统 `.NET Framework` `csc.exe` 预编译 `windows-media.dll` 与 `cwb-win-helper.exe`。
- 使用 `electron-builder` 生成 NSIS x64 安装包，启用 ASAR 封装、嵌入式完整性校验及 Electron Fuses。

### 可选环境变量

| 变量名 | 说明 |
| --- | --- |
| `CWB_FFMPEG_PATH` / `CWB_FFPROBE_PATH` | 手动指定 `ffmpeg.exe` / `ffprobe.exe` 路径（未加入 `PATH` 时使用） |
| `CWB_CACHE_ROOT` | 覆盖视频转码缓存目录 |
| `CWB_BUILD_TEMP_ROOT` | 覆盖打包时的临时构建目录（默认使用 `out/.nsis-build`） |

### 项目目录结构

```text
lumina/
├── src/                      # Electron 主进程、IPC、目标发现、CDP 身份核验与渲染外壳
│   ├── main.mjs              # Electron 入口、托盘与生命周期管理
│   ├── cdp-owner.mjs         # CDP 监听端口与进程归属核验
│   ├── codex-launcher.mjs    # Store AUMID 激活、进程关闭与调试模式启动
│   ├── compatibility-script.mjs # 双宿主外观适配与恢复
│   ├── installations.mjs     # 宿主安装发现与缓存
│   ├── update-checker.mjs    # 稳定版本检查、冷却、URL 校验与按版本忽略
│   ├── win-helper.mjs        # 原生辅助程序调用、端口核验与窗口遮挡检测
│   └── renderer/             # 桌面外壳前端资源
├── bridge-runtime/           # 内置壁纸服务、工作台 UI、媒体传输与原生组件源码
│   ├── native/               # windows-media.cs / cwb-win-helper.cs
│   ├── public/               # 壁纸工作台前端界面
│   ├── src/
│   │   ├── liquid-glass.mjs  # 液态玻璃默认值与参数归一化
│   │   ├── playback-policy.mjs # 手动播放与自动暂停状态
│   │   └── scene-server.mjs  # 场景资源服务、Range 传输与首帧进度
│   └── vendor/webwallgl/     # 离线校验的 WebWallGL 3.1.0 + Mediabunny 1.56.0
├── bridge-overrides/         # Electron 桌面版对 bridge-runtime 的覆盖维护源
├── scripts/                  # 同步、构建、原生编译、NSIS 打包与验收脚本
├── test/                     # Node 自动化单元测试与浏览器渲染测试
├── docs/                     # 公开文档（WEB_API、版本说明）与界面截图
├── run-electron.cmd          # Windows 一键源码启动脚本
└── make-electron.cmd         # Windows 一键打包脚本
```

### 开发约定与测试

修改桥接逻辑时，若 `bridge-overrides/` 中存在同名文件，请修改 `bridge-overrides/` 并运行 `npm run sync:bridge`；请勿直接手改 `dist/`。

```powershell
npm run sync:bridge
npm run build:app
npm test
```

</details>

---

## 安全与已知限制

<details>
<summary><strong>展开查看：本地隐私、CSP 说明与已知限制</strong></summary>

<br />

- **本地数据与隐私**：所有壁纸配置均存放在本机；运行日志默认位于 `%LOCALAPPDATA%\CodexWallpaperDesktop\logs`（会话 URL 已脱敏）。本地媒体与控制服务仅监听 `127.0.0.1` 并校验随机令牌与请求来源。
- **CSP 说明**：图片、视频及 GPU 场景注入会在目标页面临时放宽 CSP（首次可能需要自动刷新一次页面），恢复外观时会还原。网页壁纸包含作者脚本，请仅加载可信的本地项目。
- **已知限制**：
  - 仅支持 Windows x64；不支持 macOS / Linux，也不适用于网页版 ChatGPT 或命令行 Codex。
  - Scene / Web 渲染并非 Wallpaper Engine 官方完整替代，部分高级脚本与插件特效可能不兼容。
  - 目标应用版本升级可能调整 DOM 结构，如出现界面遮挡或样式异常欢迎反馈。
  - 当前未配置商业代码签名证书，安装或运行时 Windows SmartScreen 可能出现“未知发布者”提示。

</details>

---

## 更多文档与致谢

- [运行时说明](bridge-runtime/README.md) · [Web 壁纸扩展接口](docs/WEB_API.md) · [1.3.1](docs/RELEASE_1.3.1.md) · [1.3.0](docs/RELEASE_1.3.0.md) · [1.2.2](docs/RELEASE_1.2.2.md) · [1.2.1](docs/RELEASE_1.2.1.md) · [1.2.0](docs/RELEASE_1.2.0.md) · [1.1.0](docs/RELEASE_1.1.0.md) · [1.0.0](docs/RELEASE_1.0.0.md)
- 场景渲染基于 **WebWallGL 3.1.0**，相关组件来源、版本与开源许可见 [第三方声明](bridge-runtime/vendor/webwallgl/NOTICE.md)。
