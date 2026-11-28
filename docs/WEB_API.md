# Web 壁纸接口

本文面向 Web 壁纸作者，说明 Lumina 的兼容接口。它不是 Wallpaper Engine 官方运行时的完整替代；具体视觉效果仍取决于壁纸及浏览器兼容性。

## 作者属性

工作台读取工程声明的颜色、开关、滑块、下拉、文本、文件和目录属性，并按壁纸分别保存。壁纸通过 `window.wallpaperPropertyListener` 接收更新：

```js
window.wallpaperPropertyListener = {
  applyUserProperties(properties) {
    // Read the properties declared by this wallpaper.
  },
  applyGeneralProperties(properties) {
    // fps, paused, audiovolume.
  },
  setPaused(paused) {
    // Suspend or resume the wallpaper's own work.
  },
};
```

文件与目录选择使用程序管理的副本，不会更改作者原始工程，也不向壁纸暴露本机磁盘路径。

对于 `mode: "fetchall"` 的目录属性，可提供：

- `userDirectoryFilesAddedOrChanged(propertyName, filePaths)`
- `userDirectoryFilesRemoved(propertyName, filePaths)`

按需随机取一个目录资源：

```js
window.wallpaperRequestRandomFileForProperty("backgrounds", (propertyName, filePath) => {
  if (filePath) {
    // Use the returned private resource URL; an empty string means no resource.
  }
});
```

返回的资源 URL 仅对应当前工程已核验的文件。不支持借此读取任意本机文件，也没有额外定义 `wallpaperRequestFileForProperty`。

## 系统音频与媒体信息

以下接口在相应功能被用户启用后提供回调：

| 接口 | 数据 |
| --- | --- |
| `wallpaperRegisterAudioListener(callback)` | 系统输出音频频谱 |
| `wallpaperRegisterMediaPropertiesListener(callback)` | 曲目、歌手、专辑等元数据 |
| `wallpaperRegisterMediaThumbnailListener(callback)` | 封面与相关颜色字段 |
| `wallpaperRegisterMediaPlaybackListener(callback)` | 播放状态 |
| `wallpaperRegisterMediaTimelineListener(callback)` | 播放时间线 |
| `wallpaperRegisterMediaStatusListener(callback)` | 媒体功能启用状态 |

`wallpaperMediaIntegration` 定义 `PLAYBACK_STOPPED = 0`、`PLAYBACK_PLAYING = 1`、`PLAYBACK_PAUSED = 2`。系统音频和媒体读取默认关闭；播放器未提供数据时，不能仅凭注册成功判定数据可用。

## 本项目扩展

`window.cwbMediaIntegration` 是本项目扩展，不是 Wallpaper Engine 官方 API：

- `registerLyricsListener(callback)`：注册歌词回调。
- `capabilities()`：查询当前允许的播放器控制命令。
- `control(command)`：返回 Promise，执行当前能力允许的控制。

播放器控制需要用户显式开启；不可用、暂停或会话过期时请处理 Promise 拒绝。Scene 目前接入系统频谱，不代表同时具备完整的 Web 媒体和歌词 API。

## 参考

- [Wallpaper Engine 属性监听](https://docs.wallpaperengine.io/en/web/api/propertylistener.html)
- [Wallpaper Engine 媒体集成](https://docs.wallpaperengine.io/en/web/audio/media.html)
- [项目功能与已知限制](../README.md)
