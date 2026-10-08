# ADR-0062 播放地址给相对路径：`DirectStreamUrl` / `MediaSources[].Path`

- 状态：已采纳（修正 0006 落地时「给绝对 URL」的取巧做法）
- 相关：[0006](0006-redirect-for-playback.md)（播放一律 302、不代理字节）· [0007](0007-emby-dto-shape.md)（对齐真机 DTO 形状）·
  [emby-compat.md](../emby-compat.md) · [11-items-playbackinfo](../emby-realdevice/11-items-playbackinfo.md) ·
  [service.js](../../server/modules/emby/service.js)（`directStreamUrl` / `streamPath`）· [server.js](../../server.js)（`normalize` 注释）

## 背景

`PlaybackInfo` 的 `MediaSources[].DirectStreamUrl` 与详情 `MediaSources[].Path` 是本面板发出去、
供客户端**起播 / 拉流**用的地址。落地时两处都写成**绝对 URL**（`{proto}://{host}/api/emby/…`），
理由写在注释里：「绝对地址在任何解析规则（按 base 拼还是按 host 拼）下都不会错」。

这个理由只对「客户端把返回的地址当**独立 URL**」成立。实测 **AfuseKt/3.2.0** 不是这样：
它把面板给的地址**当相对路径，直接字符串拼在自己的 base 之后** —— 而它的 base 已经含 `/emby`。
于是发出去的是双重地址：

```
http://<面板主机>:<端口>/emby   +   http://<面板主机>:<端口>/api/emby/videos/{ItemId}/stream.mp4?…
```

实例端口把路径 `normalize` 之后（见 [listener.js](../../server/modules/emby/listener.js) / [server.js](../../server.js)），
它不以 `/api/emby/` 开头 → 命中实例端口的 **404 守卫**（「这个端口只伺候 Emby 客户端协议」）。
客户端表现为「点了播放没反应」。

真机（予初Emby）的 `DirectStreamUrl` 本就是**相对路径**（`/videos/…stream?…&Static=true`）；
真机的 `Path` 是文件绝对路径（那是**有文件库**的语义，本项目没有文件，见 [0006](0006-redirect-for-playback.md)），
但**形态**上也是「客户端能拼」的路径，不是越权的绝对 URL。

## 决定

`DirectStreamUrl` 与 `MediaSources[].Path` 一律给**相对路径**，不带主机、不带协议、也不带
`/api/emby` 与 `/emby` 前缀：

- `DirectStreamUrl` → `/videos/{ItemId}/stream.{Container}?MediaSourceId=…&Static=true&api_key=…`
  （与真机同形；`api_key` 仍是客户端自己的 token）。
- `MediaSources[].Path` → `/Items/{ItemId}/Stream/{base64url(版本 Id)}/{标准文件名}`。

为什么去掉 `/api/emby`：客户端 base 已含 `/emby`，所以

- base `/emby` + `/videos/…` = `/emby/videos/…` → normalize → `/api/emby/videos/…` ✓
- base `/api/emby` + `/videos/…` = `/api/emby/videos/…` ✓

而若保留 `/api/emby` 前缀，在 `/emby` base 下会变成 `/emby/api/emby/videos/…` → 仍 404。
**去掉前缀是两种 base 都能命中的唯一形态。**

随之下掉不再需要的 `host` / `proto` 参数：`getItem` / `getPlaybackInfo` / `buildMediaSource`
的签名相应收窄，routes 里为拼绝对地址而生的 `protoOf` 一并删除。

## 理由

- **对齐真机**：真机 `DirectStreamUrl` 就是相对路径；本层的 `Path` 也改成与之一致的「客户端可拼路径」。
- **修掉登录级客户端**：AfuseKt 的实际拼接行为已被 HAR 逐字证实（`…/emby` + `http://…/api/emby/…`），
  相对路径直接消除双重地址。
- **不再猜主机 / 协议**：绝对 URL 要求面板先知道「客户端是从哪个主机、哪个协议进来的」。本地实例回的是
  回环地址，反代后面 Host 里没有协议 —— 猜错就拼出客户端够不着的地址。相对路径把这层不确定性
  交回给**客户端自己**（它最清楚自己的 base）。
- **两种 base 都兼容**：去前缀的形态在 `/emby` 与 `/api/emby` 下都能命中，不需要客户端配合调整。

## 备选

- **维持绝对 URL，由实例端口兜住双重拼接**（识别 `…/emby/http(s)://…` 并剥一层）：能在服务端救回来，
  但那是**为客户端的一次误用打补丁**，且形态仍与真机不一致。否决（且用户已选「改面板发出的地址为相对」）。
- **给带 `/api/emby` 前缀的相对路径**（`/api/emby/videos/…`）：在 `/api/emby` base 下能命中，但在
  `/emby` base 下变成 `/emby/api/emby/…` → 仍 404，修不好 AfuseKt。否决。
- **两条都做**（既改相对、又加服务端兜底）：兜底对已修的路径是死代码，只增复杂度。否决。

## 后果

- **`DirectStreamUrl` / `MediaSources[].Path` 由绝对变为相对**：走官方协议的客户端本就把它拼在 base 之后，
  **无需改动**（AfuseKt 因此可起播）；只读这两个字段、当**绝对地址**直接用的第三方（外部播放器 /
  调试脚本）需自行补 base。
- **签名收窄**：`getItem(itemId)` / `getPlaybackInfo(itemId, token)` / `buildMediaSource({…})` 不再收
  `host` / `proto`；routes 的 `protoOf` 删除。拉流端点本身的落法（302 / 中继，见 [0006](0006-redirect-for-playback.md)）不变。
- **`Path` 取值仍与真机不同**（本层放 Stream 端点，不成源文件路径）—— 那是 [0006](0006-redirect-for-playback.md) 的既定取向，不变；
  本次只改**形态**（绝对 → 相对）。
- 逐条契约与真机登记见 [emby-compat.md](../emby-compat.md)「契约变更记录」与
  [11-items-playbackinfo](../emby-realdevice/11-items-playbackinfo.md) 的 11-4。
