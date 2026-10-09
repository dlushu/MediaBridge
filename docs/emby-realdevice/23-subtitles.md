# #23 字幕内容端点（`GET /api/emby/Videos/{ItemId}/{MediaSourceId}/Subtitles/{Index}/Stream.{Format}`）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**：**本仓库内没有真机样本，本轮也未在真机上逐条对照** —— 下表的「真机」列待补测。改动的依据是 **Emby 官方端点形状 + 契约（插件仓库 `docs/plugin-contract.md`「七、字幕插件的动作」）**，不是真机对照。

这是**字幕插件的落地端点**：面板把字幕插件 `tracks` 动作申报的轨挂进版本（`MediaStreams[]` 里 `Type:'Subtitle'`），客户端点开某条轨时打这条端点；面板解出版本 Id 里的字幕 `ref`，交给插件 `fetch` 动作取回内容后回字节。端点形状取 Emby **标准**的一条（见下「为什么是这个形状」）。

**客户端实测**：**有**（Streama/1.0.55 android，HAR `proxypin_1006403_8090_2026-10-09.har`）。客户端**确实**来要字幕了（这条端点已存在并可命中），但首版因 `DeliveryUrl` **不带 token**、客户端**原样**发送 → **401**（详见 23-5）。

**判读**：Emby 客户端靠版本里的 `MediaStreams[]` 认字幕轨：`Type:'Subtitle'` + `Index`（流序号）+ `DeliveryMethod` / `DeliveryUrl`。真有字幕时，客户端会在用户选中某条轨后打这条内容端点。面板此前既不出字幕轨、也没有内容端点，所以字幕插件即便申报了轨也**无处可挂、无端点可取**。

**差异处理**

- 23-1 **字幕内容端点（已落码，未复测）**：新增 `GET /api/emby/Videos/{ItemId}/{MediaSourceId}/Subtitles/{Index}/Stream.{Format}` —— `{ItemId}` 是本面板发出去的条目 Id（集/电影）；`{MediaSourceId}` 是版本 Id（`mbp:` + base64url(deflateRaw(JSON))，**载荷新增 `s` 字段**承载"流序号 → 字幕 `ref`"的映射）；`{Index}` 是 `MediaStreams[]` 里该字幕流的 `Index`；`{Format}` ∈ `srt` / `ass` / `ssa` / `vtt`（大小写不敏感）。面板解出 `s[Index]` 得 `ref` → 按第一段路由到字幕插件 → 调 `fetch({ ref })` → **200 `text/*`** 回 `body`（`Content-Type` 优先取插件给的 `contentType`，否则按 `Format` 落）。**鉴权只验 token、不比对 UserId**（与拉流同口径）。
  - `{Index}` 认不出（版本 Id 里没有这条字幕 ref）→ **404**；版本 Id 认不出 → **400**；Id 非集/电影 → **404**；插件取内容失败 → **照实回失败码**（`metaBridge.httpStatusOf`：插件没在跑 / 没这个动作 → 503，超时 → 504，其余 → 502）。
  - Emby 官方还有一条带起播位置的变体 `…/Subtitles/{Index}/{StartPositionTicks}/Stream.{Format}`：**一并注册**（同一处理，`StartPositionTicks` 忽略 —— 面板回的是整段字幕，裁剪交给客户端）。
- 23-2 **版本里挂字幕流（已落码，未复测）**：条目详情 / 播放信息里，每条版本（`MediaSource`）的 `MediaStreams[]` 追加字幕流：`Type:'Subtitle'`、`Index`（**顺延在视频/音频流之后**）、`Codec`（按 `format` 映射：`srt→subrip` / `ass→ass` / `ssa→ssa` / `vtt→webvtt`）、`Language`（插件给的 `lang` **原样**）、`DisplayTitle`（插件给的 `label`，不写按 `lang`）、`IsDefault:false` / `IsForced:false`（外挂字幕非默认/强制轨，23-4）、`IsExternal:true` / `IsTextSubtitleStream:true` / `SupportsExternalStream:true` / `DeliveryMethod:'External'`、`DeliveryUrl`（指向 23-1 那条端点，相对路径）。
  - **字幕与线路无关**（契约 §七）：面板**为一个播放目标问一次** `tracks`，把回来的轨**挂到该目标的每个版本上**（电影多压制版本共用同一份轨）。**取源插件 `tracks` 失败只降级**（不出字幕轨、记一行日志，不破坏详情）。
- 23-4 **字幕流补 `IsDefault:false` / `IsForced:false`（已落码，未复测）**：字幕轨首版漏了这两个布尔字段。实测 **Yamby**（Kotlin 客户端）把 `MediaStream.IsDefault` 声明成**必填**，缺了整条 `PlaybackInfo` 反序列化直接抛 `SerializationException`（报文路径 `$.MediaSources[0].MediaStreams[2]` —— 恰是视频/音频之后的第一条字幕流），**整个播放页打不开**。宽容的客户端读不到当 `false` 处理所以此前没暴露。真机字幕流本就带 `IsDefault:false`；补上后语义一致（外挂字幕不是默认轨/强制轨）。
- 23-3 **版本 Id 载荷扩展（已落码，未复测）**：`mbpSourceId` 的 JSON 载荷由 `{r, v?}` 扩为 `{r, v?, s?}`；`s` = `{ "<流序号>": "<字幕 ref>" }`。**无字幕时不写 `s`**（载荷与旧版一致）；`parseMbpSourceId` 旧载荷照常解析（`s` 缺省为空）。`ref` 由**字幕插件自己**构造、自带 `<插件 id>/` 前缀，面板**不代加**前缀、只按第一段路由。
- 23-5 **字幕 `DeliveryUrl` 埋 access token（已落码，未复测）**：首版字幕流的 `DeliveryUrl`（23-2）是**裸相对路径**、**不带 token**；Streama（`Streama/1.0.55 android`）**把 `DeliveryUrl` 原样发出**，不自己追加 token → 本层 `authorize` 判「没带 token」→ **401**（HAR `proxypin_1006403_8090_2026-10-09.har` 实测：entry[8]–[13]、[15] 连打 7 次这条端点，请求头只有 `User-Agent` / `Icy-MetaData` / `Accept-Encoding` / `Host` / `Connection`，**无 `X-Emby-Token` / `X-Emby-Authorization` 头、也无 `api_key` query**）。对照：同一次会话里客户端拉流（`GET /emby/videos/…/stream.m3u8?…&api_key=…`，面板 `DirectStreamUrl` 埋了 `api_key`，客户端原样用）是 **200** —— 差别就在"URL 带不带 token"。
  - **处理**：字幕 `DeliveryUrl` 与 `DirectStreamUrl` 同口径，末尾埋**本请求的 access token**：`…/Stream.{Format}?api_key=<token>`（`DirectStreamUrl` 也用 query `api_key`，见 ADR-0062 / ADR-0074）。**鉴权口径不变**——端点仍只验 token、不比对 UserId；变的只是**面板发出的 URL 自带 token**，客户端不必自己加。
  - **影响面**：`subtitleUrl` 增 `token` 参数并埋 `?api_key=`；签名链 `getItem(itemId, token)` → `buildMediaSource({ …, token })` → `subtitleUrl(…, token)`；`routes.js` 的条目详情调用点把 `service.tokenFrom(req).token` 传进去，`getPlaybackInfo` 内 `getItem(itemId, token)`。**无 token 时不埋**（与 `directStreamUrl` 一致：拿不到 token 的调用方本就过不了 `authorize`）。

**为什么是这个形状**：`Videos/{ItemId}/{MediaSourceId}/Subtitles/{Index}/Stream.{Format}` 是 Emby 的**标准**字幕取用形状（外挂字幕流即由它交付）。面板路由**不支持段内**的 `Stream.:format`（见 `core/router.js`），故按 `serveDirectVideo` 的老范式：把 `:file` 收成**整段**，在处理器里用正则 `/^Stream\.(srt|ass|ssa|vtt)$/i` 校验。`Videos` 字面段**大小写不敏感**，官方大写与早期小写一并认下。

**不能模拟**：真机这条端点的**响应头与状态码细节**（`Content-Type` 取值、是否 `Content-Disposition`、无效 `Index` / 无效 token 时真机的确切回应）尚未取到，待补测。真机是否对**内嵌**字幕也走这条端点、`DeliveryMethod` 取值（`External` 还是别的）也未对照。

**状态：23-1 / 23-2 / 23-3 / 23-4 / 23-5 已落码（未复测）。**
