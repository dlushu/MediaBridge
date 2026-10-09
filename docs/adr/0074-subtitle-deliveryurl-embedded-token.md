# ADR-0074 字幕 `DeliveryUrl` 埋 access token

- 状态：已采纳
- 相关：[0062](0062-relative-playback-urls.md)（`DirectStreamUrl` 相对路径 + 自带 `api_key`）·
  [0073](0073-subtitle-tracks-in-agg-detail.md)（字幕轨随详情供给）·
  [emby-compat.md](../emby-compat.md) · [emby-realdevice/23-subtitles.md](../emby-realdevice/23-subtitles.md) ·
  [service.js](../../server/modules/emby/service.js)（`subtitleUrl` / `directStreamUrl` / `getItem` / `getPlaybackInfo`）

## 背景

字幕轨挂进版本时，每条 `Type:'Subtitle'` 流的 `DeliveryUrl` 由 `subtitleUrl()` 生成 ——
**裸相对路径、不带 token**（`/Videos/{ItemId}/{MediaSourceId}/Subtitles/{Index}/Stream.{Format}`）。
这条端点的鉴权与拉流同口径（只验 token、不比对 UserId），**没带 token 就是 401**。

实测 **Streama/1.0.55 (android)** 把版本里的 `DeliveryUrl` **原样**发出，**不自己追加 token**：
HAR `proxypin_1006403_8090_2026-10-09.har` 里这条字幕端点连打 7 次全 **401**
（`没带 token`），请求头只有 `User-Agent` / `Icy-MetaData` / `Accept-Encoding` / `Host` / `Connection`，
既无 `X-Emby-Token` / `X-Emby-Authorization` 头、也无 `api_key` query。

对照同一次会话：客户端拉流那次是 **200** —— 因为 `DirectStreamUrl` 由 `directStreamUrl()` 生成，
**末尾本就埋了 `api_key`**（见 [0062](0062-relative-playback-urls.md)），客户端原样用即可。
差别只在于「面板发出的地址带不带 token」。

## 决定

字幕流的 `DeliveryUrl` 与 `DirectStreamUrl` **同口径**：末尾**自带本请求的 access token**，用 query `api_key`：

```
/Videos/{ItemId}/{MediaSourceId}/Subtitles/{Index}/Stream.{Format}?api_key=<token>
```

- 用 query `api_key`，**不能写 `X-Emby-Token`**：后者本层只认请求头，写进 query 等于没带（同 `directStreamUrl` 的注释）。
- **无 token 时不埋**（`token ? '?api_key=…' : ''`），与 `directStreamUrl` 一致 —— 拿不到 token 的调用方本就过不了 `authorize`。
- 随之 `subtitleUrl` 增 `token` 参数，签名链把 token 递下去：`getItem(itemId, token)` →
  `buildMediaSource({ …, token })` → `subtitleUrl(…, token)`；`routes.js` 条目详情调用点传
  `service.tokenFrom(req).token`，`getPlaybackInfo` 内 `getItem(itemId, token)`。
- **鉴权口径不变**：字幕端点仍只验 token、不比对 UserId；变的只是**面板发出的 URL 自带 token**。

## 理由

- **客户端不会自己加 token**：Streama 原样发送已被 HAR 逐字证实；把「加 token」的责任放在面板这边，
  是唯一能让它取到字幕的做法。
- **与既有口径一致**：`DirectStreamUrl` 早就这么干（[0062](0062-relative-playback-urls.md)），字幕只是漏了同一步。
  两处同口径，后来者不必再分辨「哪种 URL 要埋 token」。
- **不动鉴权面**：不放宽端点校验、不新增凭据类型，只是把同一个 access token 放进 URL —— 权限模型一字不改。

## 备选

- **让客户端自己追加 token**：实测 Streama 不这么做（原样发 `DeliveryUrl`）；要求客户端改，等于修不好。
  否决。
- **放宽字幕端点鉴权（不验 token 也回）**：字幕是跟账号绑定的资源，放开即人人可取，是开洞。否决。
- **给字幕 URL 写 `X-Emby-Token` query**：本层 `tokenFrom` 对头名只认请求头（query 里只额外认
  `api_key` 与照抄头名的 `X-Emby-Token`）—— 用 `api_key` 最稳，真机也认。否决。

## 后果

- **字幕 `DeliveryUrl` 取值变化**：多一个 `api_key` query；客户端把它原样发送即可 **200**（此前 **401**），
  **客户端无需改动**。`Path` / `DirectStreamUrl` 形状不变，字幕端点的形状 / 鉴权 / `MediaSourceId` 载荷不变。
- **签名扩了一条**：`subtitleUrl` 增 `token`；`getItem` / `buildMediaSource` 各增 `token`（默认 `''`，不破坏其它调用点）。
- 逐条契约与实测登记见 [emby-compat.md](../emby-compat.md)「契约变更记录」与
  [emby-realdevice/23-subtitles.md](../emby-realdevice/23-subtitles.md) 的 23-5（**已落码，未复测**）。
