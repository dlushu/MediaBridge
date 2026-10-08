# ADR-0070 `DirectStreamUrl` 去容器后缀：改回裸 `stream`

- 状态：**已被 [0071](0071-direct-stream-url-container-suffix.md) 取代**（裸 `stream` 实测打断靠后缀判类型的客户端，恢复带后缀）
- 相关：[0062](0062-relative-playback-urls.md)（播放地址给相对路径）· [0007](0007-emby-dto-shape.md)（Emby 响应按真机 DTO 形状对齐）·
  [emby-compat.md](../emby-compat.md) · [11-items-playbackinfo](../emby-realdevice/11-items-playbackinfo.md) ·
  [service.js](../../server/modules/emby/service.js)（`directStreamUrl`）

## 背景

`PlaybackInfo` 的 `MediaSources[].DirectStreamUrl` 是本面板发出去、供客户端**起播 / 拉流**用的地址。

[0062](0062-relative-playback-urls.md) 把它从绝对 URL 改为相对路径时，沿用了「拼上容器后缀」的写法：
`/videos/{ItemId}/stream.{Container}?…` —— mkv 源出 `stream.mkv`、missav 的 hls 源出 `stream.hls`。
当时的落点注释称「与真机同形」，但**并没有逐字核对真机原文**，只是从「Emby 有 `stream.{Container}` 这个端点形态」推的。

复核真机 `PlaybackInfo` 原文后，这个推断站不住：

- **予初Emby（4.9.5.0）**：电影 `864879` 与剧集 `585872` 两条的 `DirectStreamUrl` 都是**裸 `stream`**
  （`/videos/{id}/stream?MediaSourceId=…&api_key=…&Static=true`）—— 即便 `Container='mkv'` 也**不拼 `.mkv`**。
- **动漫Emby（4.10.1.0）** 与 **OkEmby（4.9.1.90）**：`MediaSources[]` **根本不返回 `DirectStreamUrl` 这个键**。
- 真机带 `.mkv` 的地方是 **`Path`**（远程文件 URL / 文件绝对路径），**不是** `DirectStreamUrl`。

⇒ 真机自己下发的直连地址**从不带容器后缀**；面板拼 `stream.{Container}` 属**形态偏离**。

## 决定

`DirectStreamUrl` 一律给**裸 `stream`**（相对路径，见 [0062](0062-relative-playback-urls.md)）：

- `/videos/{ItemId}/stream?MediaSourceId=…&Static=true&api_key=…`（`api_key` 仍是客户端自己的 token）。

`directStreamUrl()` 去掉 `container` 参数，`getPlaybackInfo` 调用点去掉 `container: m.Container`。

## 理由

- **对齐真机**：真机下发的就是裸 `stream`（予初Emby 两条原文一致，且更新的版本干脆不返该字段）。
- **后缀本就是客户端的事**：Emby 官方**客户端**才按 `MediaSource.Container` 自拼 `videos/{Id}/stream.{ext}`
  （实测日志打的是 `stream.mkv`）；服务端在 `DirectStreamUrl` 里给的从来是裸 `stream`。面板此前把
  「客户端自拼」的形态错当成了「服务端下发」的形态。
- **本层两种都认，改了下发不影响命中**：拉流路由的正则是 `stream(\.[a-z0-9]+)?` —— 裸 `stream` 与
  `stream.{ext}` 都收。故无论客户端**直接取本字段**（裸 `stream`）还是**自拼带后缀**（`stream.mkv`），
  都能落到同一条实现（见 [emby-compat.md](../emby-compat.md) 的 `videos/*` 行）。

## 备选

- **维持 `stream.{Container}`**：能播（路由认），但形态与真机不一致 —— 正是本次要修的点。否决。
- **干脆不给该字段**（学动漫Emby / OkEmby）：那两台不返它，但予初Emby 返，且实测 **AfuseKt/3.2.0**
  是**读这个字段起播**的（见 [0062](0062-relative-playback-urls.md)）。不给会丢掉一批客户端的起播路径。否决。
- **给带后缀、同时再兜一条裸 `stream` 的路由**：路由本就两条都认，无需再加。否决。

## 后果

- **`DirectStreamUrl` 值由 `stream.mkv` / `stream.hls` 变为裸 `stream`**：走官方协议的客户端本就
  自拼带后缀或直接取本字段，**无需改动**；本层路由对两者一并认。
- **只在 `PlaybackInfo` 里给，详情端点不返回该字段** —— 与真机同此，本次不变。
- 相对路径口径、`MediaSources[].Id`（版本 Id）、`Path`、`Container` 字段本身均不变。
- 逐条契约与真机登记见 [emby-compat.md](../emby-compat.md)「契约变更记录」与
  [11-items-playbackinfo](../emby-realdevice/11-items-playbackinfo.md) 的 11-5。
