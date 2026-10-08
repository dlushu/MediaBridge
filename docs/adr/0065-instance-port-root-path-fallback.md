# ADR-0065 实例端口对 Emby 根路径兜底

- 状态：已采纳（延伸 [0062](0062-relative-playback-urls.md)；不改变下发的 DTO）
- 相关：[0062](0062-relative-playback-urls.md)（播放地址给相对路径）· [0006](0006-redirect-for-playback.md)（播放一律 302）·
  [emby-compat.md](../emby-compat.md) · [12-direct-stream](../emby-realdevice/12-direct-stream.md) ·
  [listener.js](../../server/modules/emby/listener.js)（`normalize`）· [server.js](../../server.js)（面板端口归一化）

## 背景

面板的 Emby 端点注册在 `/api/emby/…` 下，客户端「只填主机」时靠前缀归一化把 `/emby/…`、
`/api/emby/emby/…` 收成 `/api/emby/…`。**实例端口**在此之上还有一条守卫：路径不以 `/api/emby/`
开头即 **404**（「这个端口只伺候 Emby 客户端协议」）。

[0062](0062-relative-playback-urls.md) 把 `DirectStreamUrl` / `Path` 改成了**根相对**路径
（`/videos/{id}/stream.hls?…`），前提假设是「客户端把它**字符串拼**在自己的 base（已含 `/emby`）之后」。
这个假设只对部分客户端成立。实测 **HamHub/1.0**（Android）是**按 origin 解析**（RFC 3986 语义：
根相对地址替换整个 path），`/emby` 被丢掉 → 实际打的是 `http://host:8090/videos/…` → 撞 404 守卫。

抓包逐字印证（同一播放会话）：`GET /videos/{id}/stream.hls?…` **404 四次**（退避 ~1s/2s/4s），
改用 `GET /emby/videos/{id}/stream.hls?…` 才 **200**（拿到主清单）；`api_key` 风格同样「404 → 200」。

而**真机 Emby 的端点本就挂在根路径**（`GET /videos/{id}/stream?…` 两台真机都命中，见
[12-direct-stream](../emby-realdevice/12-direct-stream.md)）。即：客户端的行为是对齐真机的，面板的入口少了一条。

## 决定

**实例端口**的 `normalize()` 在原有两条规则之外，**加第三条**：pathname **不以 `/api/` 开头**的，
一律前缀 `/api/emby`。

- `/videos/{ItemId}/stream.hls?…` → `/api/emby/videos/{ItemId}/stream.hls?…` ✓（命中既有路由）
- `/Items/{ItemId}/Stream/…`、`/Videos/{ItemId}/{MediaSourceId}/Subtitles/…` 同理 ✓

**只改实例端口**。[server.js](../../server.js)（面板端口）**不动**：面板端口根部是**面板自己的 UI**
（index.html / 静态资源），把根路径映射到 `/api/emby` 会让面板页面全废。这正是两个端口归一化
不再「完全一致」的原因，原注释里「两处必须一致」的措辞相应收窄为「**前两条**必须一致」。

守卫与隔离不变：

- `/api/…`（非 emby）照旧 404；
- `PANEL_ONLY_RE`（`accounts` / `instances` / `home-plugins` / `meta-domains`）仍生效 —— 根路径
  `/accounts` 归一化后变 `/api/emby/accounts`，仍命中并 404，**面板自用端点的隔离不破**。

## 理由

- **对齐真机**：真机就在根路径提供这些端点，客户端按 origin 解析是合规行为；面板补上这条即与真机可互换。
- **修掉 HamHub**：`/videos/…` 先 404 再退避改用 `/emby/…` 才成功，表现为「点了播放要等好几秒 / 反复重试」；
  根路径兜底后第一发即命中。
- **不改下发内容**：DTO（`DirectStreamUrl` / `Path` / 字幕 `DeliveryUrl`）一字不改，只是多认几条入口路径。
  按字符串拼接的客户端（[0062](0062-relative-playback-urls.md) 里的 AfuseKt）**不受影响**。
- **风险可控**：兜底只放宽**入口路径**；鉴权口径（身份以 token 为准）与各端点自身校验一字未改，
  不引入跨账号可见性。

## 备选

- **改下发地址为「带 `/emby` 前缀的相对路径」**（`/emby/videos/…`）：对 HamHub 的 origin 解析有效，
  但对 base 已含 `/emby` 的字符串拼接客户端会变成 `/emby/emby/videos/…`（归一化能救回，但形态与真机不一致），
  且只修一类客户端。否决 —— 服务端兜底一次覆盖两种行为。
- **只修 HamHub、不动服务端**（指望客户端改）：客户端按真机语义写、且真机本就支持根路径，
  面板是少数派。否决。
- **面板端口也做同样兜底**：会给面板 UI 造成根路径冲突。否决（故只改实例端口）。

## 后果

- **实例端口入口更宽容**：根路径与带前缀两种打法都命中；**客户端无需改动**。
  逐条契约见 [emby-compat.md](../emby-compat.md)「契约变更记录」，真机登记见
  [12-direct-stream](../emby-realdevice/12-direct-stream.md) 的 12-6（**已落码，未复测**）。
- **两处归一化不再完全一致**：`listener.js` 比 `server.js` 多一条根路径兜底；两边的注释已注明差异
  （同 `/emby`、`/api/emby/emby` 两条规则仍必须一致）。
- **下发的 DTO 不变**：仍按 [0062](0062-relative-playback-urls.md) 给根相对路径；本 ADR 只补入口，不改出参。
