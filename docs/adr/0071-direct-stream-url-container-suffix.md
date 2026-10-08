# ADR-0071 `DirectStreamUrl` 恢复容器后缀，`hls` 映射为 `m3u8`

- 状态：已采纳（取代 [0070](0070-direct-stream-url-bare-stream.md)；回归修复，优先级高于真机形态对齐）
- 相关：[0070](0070-direct-stream-url-bare-stream.md)（被取代的裸 `stream` 决定）· [0062](0062-relative-playback-urls.md)（播放地址给相对路径）·
  [emby-compat.md](../emby-compat.md) · [11-items-playbackinfo](../emby-realdevice/11-items-playbackinfo.md) ·
  [service.js](../../server/modules/emby/service.js)（`directStreamUrl`）

## 背景

[0070](0070-direct-stream-url-bare-stream.md) 为对齐真机（予初Emby 4.9.5.0 的 `DirectStreamUrl` 是裸 `stream`），
把面板下发的 `DirectStreamUrl` 从 `stream.{Container}` 改成了裸 `stream`。上线后实测**回归**：
多个此前能播的客户端播不了了。

典型样本（CapyPlayer/1.1.6，ExoPlayer 系）：

- 面板侧日志正常：`✔ emby 拉流 videos/…/stream → HTTP 200 …清单中继（3 个地址补成绝对）` ——
  面板回的是正确可播的 HLS 主清单。
- 客户端报 `Error 3003: UnrecognizedInputFormatException … sniff failures: [NoDeclaredBrand]` ——
  这是 ExoPlayer **渐进式抽取器**嗅探失败的报错：播放器把拿到的 m3u8 文本当普通媒体文件嗅，
  压根没走 HLS 解析器。

原因：这批客户端**靠 URL 后缀判媒体类型**。ExoPlayer 的 `Util.inferContentType` 按路径后缀推断，
HLS 只认 `.m3u8`；裸 `stream` 没有任何后缀 → 判不出 → 退到渐进式抽取器 → 抛错。
`Content-Type: application/vnd.apple.mpegurl` 救不了 —— 这类客户端不拿它当判据。

## 决定

`DirectStreamUrl` 恢复带后缀：`/videos/{ItemId}/stream.{容器}?MediaSourceId=…&Static=true&api_key=…`，
但**后缀不照抄 `Container` 字段**，过一层映射：

- `Container='hls'` → **`stream.m3u8`**。`hls` 是 Emby DTO 的容器枚举值，**不是播放器认得的扩展名**
  （ExoPlayer 只认 `.m3u8`；真机的 HLS 拉流地址也是 `master.m3u8` / `*.m3u8` 形态）。若照抄出
  `stream.hls`，嗅探型客户端照样不认，等于白改。
- 其余容器（`mkv` / `mp4` / …）容器名本身就是扩展名，原样拼。
- `Container` 为空 → 裸 `stream`（无前缀可拼，只能如此）。

`directStreamUrl()` 恢复 `container` 参数并内置 `hls→m3u8` 映射，`getPlaybackInfo` 调用点恢复传
`container: m.Container`。路由不变：`stream(\.[a-z0-9]+)?` 对 `.m3u8` / `.mkv` / 裸 `stream` 都收。

## 理由

- **能播优先于形态对齐**：真机（原生 Emby 服务端 + 官方/主流客户端）不受裸 `stream` 影响，
  是因为官方客户端走 Emby 协议字段而不是靠后缀猜；面板面对的是更杂的客户端生态，
  后缀是这批客户端**唯一**的类型线索。
- `.m3u8` 不是妥协反而是**更贴近真机行为**：真机的 HLS 拉流地址本来就以 `.m3u8` 结尾。

## 备选

- **维持裸 `stream`**（0070 的决定）：真机形态一致，但靠后缀判类型的客户端全挂。否决。
- **照抄 `Container` 出 `stream.hls`**：后缀有了，但 `.hls` 不在 ExoPlayer 的推断表里，等于没修。否决。
- **给两条字段**（裸 + 带后缀各一条）：DTO 没有第二个直连地址字段，编不出来。否决。

## 后果

- **`DirectStreamUrl` 值由裸 `stream` 变为 `stream.m3u8`（HLS 源）/ `stream.mkv` 等（文件源）**：
  靠后缀判类型的客户端恢复播放；走协议字段的客户端不受影响（本层路由两种都认）。
- 与真机下发形态（裸 `stream`）**有意不一致**，登记为取舍而非偏离：
  [11-items-playbackinfo](../emby-realdevice/11-items-playbackinfo.md) 11-5 已改判。
- 相对路径口径、`MediaSources[].Id` / `Path` / `Container` 字段本身均不变。
- 逐条契约登记见 [emby-compat.md](../emby-compat.md)「契约变更记录」。
