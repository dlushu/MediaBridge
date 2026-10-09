# ADR-0075 agg 流端点加带后缀的别名 `/api/agg/stream.m3u8`

- 状态：已采纳
- 相关：[0071](0071-direct-stream-url-container-suffix.md)（Emby `DirectStreamUrl` 按容器补后缀）·
  [0042](0042-auth-line-byte-relay.md)（agg 流端点与字节中继）·
  [0044](0044-emby-stream-playvia-relay.md)（Emby 侧同一条流内核、不同 base-path）·
  [stream.js](../../server/modules/agg/stream.js) · [agg/routes.js](../../server/modules/agg/routes.js) ·
  [core/router.js](../../server/core/router.js) · [develop.md](../develop.md)

## 背景

`GET /api/agg/stream` 是**面给面板之外客户端**的流入口（出口插件 / FW / Rex widget 等，见
[0042](0042-auth-line-byte-relay.md)）：按版本坐标取地址（`?domain=|tpl=&ref=&token=`）或回上一跳清单
改写出的签名子地址（`?seg=&sid=`）。上游是 HLS 时它回的是 `application/vnd.apple.mpegurl` 清单
（`stream.js` 的 `PLAYLIST_MIME`）。

问题在于**这条路径的 URL 不带任何文件后缀**。有些播放器 / 客户端按 URL 后缀识别容器：
后缀不是 `.m3u8` 就把响应当普通文件处理、直接拒掉，于是同一条流在别的客户端能播、在它这里播不了。

对照项：Emby 层直连端点 `/videos/{ItemId}/stream[.{ext}]` 早已按容器补后缀（HLS 源 →
`stream.m3u8`，见 [0071](0071-direct-stream-url-container-suffix.md)）——**既有范式就是「后缀按内容给」**，
agg 这条出口缺了同一步。

## 决定

在保留 `GET /api/agg/stream` 的同时，**另挂一条带后缀的别名** `GET /api/agg/stream.m3u8`：

- 两条路径**共用同一个 handler**（`agg/routes.js` 的 `serveAggStream`）——凭证、取法、搬运、
  失败语义**逐字相同**，区别只在路由落点。
- 后缀取 **`.m3u8`**：面板这条出口回 HLS 清单时就是 `.m3u8`（与 [0071](0071-direct-stream-url-container-suffix.md)
  对 HLS 源的取法一致）。
- **只加别名、不改内部子地址**：面板改写清单时生成的签名子地址仍落在裸 `/api/agg/stream?seg=&sid=`
  （`stream.js` 的 `signPartUrl` 缺省 path），别名不参与改写。
- `core/auth.js` 的 `needsAuth` 早以 `pathname.startsWith('/api/agg/stream')` 豁免这条路径的面板
  cookie 门禁，**别名天然被覆盖**，无需改动。

路由层不支持「段内后缀」（`core/router.js` 的 `:param` 只认整段、`*wildcard` 必须整段以 `*` 起头），
所以别名**显式登记**，而不是靠一条带参路由去兜。

## 理由

- **按内容给后缀是既有口径**：Emby 层的 `stream[.{ext}]`（[0071](0071-direct-stream-url-container-suffix.md)）
  已经这么做，agg 出口对齐它，后来者不必分辨「哪条流端点要不要后缀」。
- **零行为分支**：别名与主路径进同一个 handler，不存在「两条路径逻辑漂移」的风险 ——
  比新写一条端点或做内容嗅探都轻。
- **不改内部契约**：签名子地址、清单改写、鉴权面、搬参数一字不动，影响的只有**外部客户端怎么拼这条 URL**。

## 备选

- **不做别名，让客户端自己认**：实测就是有客户端按后缀拒流，要求客户端改等于修不好。否决。
- **把所有后缀（`stream.<任意ext>`）一起认、或按内容嗅探后 302 到带后缀的地址**：
  路由层不支持段内后缀，做「任意后缀」只能靠一条兜底带参路由（会遮蔽其它 `/api/agg/*` 的 404 语义）；
  内容嗅探则给这条出口引入额外分支与延迟。**当前只需要 `.m3u8` 这一档**，按需再加。否决。
- **把内部子地址也改成带后缀的别名**：面板自己完全掌控这些 URL，改它们只有成本没有收益。否决。

## 后果

- **多出一条对外路径**：`GET /api/agg/stream.m3u8` 与 `GET /api/agg/stream` 等价；按后缀认容器的
  客户端改用前者即可播。**面板 Web 与 Emby 客户端不受影响**（后者走 `/api/emby/*`，另有一套端点）。
- **契约面新增一条**：登记在 [develop.md](../develop.md) 的聚合层接口表；面向用户的说明记
  [CHANGELOG.md](../../CHANGELOG.md)。
- **可扩展**：若后续有客户端要别的后缀，照此显式再登记一条并进同一 handler 即可。
