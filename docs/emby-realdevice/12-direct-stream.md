# #12 直连拉流（`GET /api/emby/videos/{ItemId}/{file}` · `Items/{ItemId}/Stream/{token}` · `Items/{ItemId}/Download`）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（予初Emby 4.9.5.0 电影 `864879`，源 `Protocol:Http`；OkEmby 4.9.1.90 电影 `47156`，源 `Protocol:File`）

- 登录均 **200**；`PlaybackInfo` 取到版本 Id（予初Emby `mediasource_864879`）。请求一律带 `Range: bytes=0-1`。
- 逐形态：

| 请求（有效 token） | 含义 / 客户端用途 | 予初Emby | OkEmby |
|---|---|---|---|
| `GET /videos/{id}/stream?Static=true&MediaSourceId=…` | 客户端直连拉流 | **307** → 真实文件 URL（`http://<源站反代主机>:<端口>/d/…`，反代 body 带 `<a href>`） | **206** 直出字节（`Content-Range: bytes 0-1/12019829154`、`Accept-Ranges: bytes`） |
| 同上，无 `Range` | 全量取 | 307 | **200** 全量 |
| 同上，`/stream.mkv` | 扩展名变体 | 307 | 200（本机容器 matroska） |
| 同上，大写 `/Videos/` | 官方路径大小写 | 307 | **206** |
| `GET /Items/{id}/File?MediaSourceId=…` | 同族「取文件」下载 | **206** | **206** |
| `GET /Items/{id}/Download?MediaSourceId=…` | 下载 | **307**（本机下载开着） | **403** `User … does not have access to DownloadContent feature.`（本机下载能力关闭，印证 #10-3） |
| `GET /Items/{id}/Stream/{msId}` | 面板写在 `Path` 里的形状 | **404** 中文 `找不到文件…` | **404** |

**鉴权分支**（两台实测，`Range: bytes=0-1`）

| 场景 | 含义 / 客户端用途 | 真机 | 面板（改前） | 处理 |
|---|---|---|---|---|
| 无 token / 无效 token | 全局守卫，客户端回登录页 | **401**（予初Emby `/videos` 是反代文案 `鉴权失败`；`/File`、`/Download` 与 OkEmby 全为原生 `Access token is invalid or expired.`） | 401 纯文本 | 一致 |
| 有效 token + **合法 Guid 但不存在的 UserId** | 客户端换号 / 重登后仍带旧 UserId | **307 / 206**（照样出字节） | **401**（`authorize` 先比对 UserId 拦下）；UserId 认不出还回 **404** | **差异** → 已对齐，见 12-1 |
| 有效 token + **非 Guid 格式的 UserId** | 真机把 UserId 当普通参数 | **307 / 206** | **401** | **差异** → 已对齐，见 12-1 |

**判读**：直连拉流 / `File` / `Download` 在真机上**只验 token** —— query 里的 `UserId` **只当参数**（缺失、不存在、非 Guid 一律不影响出字节）。端点**取的是内容字节（与用户无关）**，属读取类，**适用「只验 token」的自动对齐例外**。

**状态码形态**：真机**本地文件**（OkEmby `Protocol:File`）→ **200/206 直出字节**（自带 `Accept-Ranges: bytes` 断点续传）；**远端 http 源**（予初Emby `Protocol:Http`）→ **307 重定向**到真实文件地址、字节由源站应答。面板一律 **302**（`client` 档）/ 200 中继（`proxy` 档）/ 200 清单（HLS），见 [ADR-0006](../adr/0006-redirect-for-playback.md)。

**差异处理**

- 12-1 **UserId 校验 → 适用自动对齐例外、已对齐「只验 token」**（鉴权分支第 2、3 行）：真机拉流端点**不比对 UserId**（有效 token + 不存在 / 非 Guid 的 UserId → 照样 307 / 206 出字节）。取字节属读取类，按既定口径直接对齐 —— 路由 `service.authorize(req, userIdOf(query))` → `service.authorize(req)`（`videos/*` 两条、`Stream/{token}` 两条、`Stream?src`、`Download` 共 6 条路由）；`service.resolveStream(itemId, src, requestedId, req)` 去掉 `requestedId` 形参与 `assertUser` 调用。**不引入跨账号可见性**（返回的是内容字节，与用户无关；身份仍由 token 决定）。**已落码，未复测**（待端到端复核：有效 token + 任意 UserId 应出字节）。
- 12-2 **状态码 → 不复刻真机形态**：真机本地文件回 **206/200**、远端 http 源回 **307**；面板统一 **302**（`client` 档交给源站）/ 200（`proxy` 档中继）—— 属拉流设计（面板不扛流量，[ADR-0006](../adr/0006-redirect-for-playback.md)），**判定不复刻**。断点续传：真机本地文件自带 `Accept-Ranges: bytes`；面板 `client` 档交给源站、`proxy` 档由中继层处理。
- 12-3 **`Items/{ItemId}/File` → 不实现（登记为已知未实现）**：真机两台都支持（有效 token 回 **206** 字节），面板**未注册**（落到 501 通配）。按既有取舍「等客户端日志暴露再接线」**先不做**（客户端日志里从没出现过这条），与 `Items/{ItemId}/Download` 同族；出现即照 Download 加一条同样的路由。**已知未实现，非遗漏。**
- 12-4 **`Items/{ItemId}/Stream/{token}` 是面板特有形状**：真机对这条（`/Items/{id}/Stream/{msId}`）回 **404**；面板把它写进 `MediaSource.Path` 当拉流渠道 ①。属**有意设计**（[ADR-0006](../adr/0006-redirect-for-playback.md)），**不改**。
- 12-5 **拉流鉴权补认 query `X-Emby-Token`（已落码，未复测）**：客户端抓包（HamHub Android/1.0.0）显示，它在探测 / 拉流时把 token 放进 **query `X-Emby-Token=`**（不带头 `X-Emby-Token`），此前本层只从请求头取 token ⇒ 判成「没带 token」回 **401**，客户端随后改用面板发出去的 `DirectStreamUrl`（query `api_key`）才成功。现 `service.tokenFrom()` 在 query 兜底里**并列认 `api_key` / `X-Emby-Token`**（`URLSearchParams` 键区分大小写，客户端发的正是大写那种）。真机对「query 带 token」的接受度待补测。
- 12-6 **实例端口对 Emby 根路径兜底（已落码，未复测）**：真机端点本就挂在**根路径**（上表 `GET /videos/{id}/stream?…` 两台真机都命中），面板此前要求客户端带 `/emby` 或 `/api/emby` 前缀，否则在**实例端口**命中 404 守卫。实测 **HamHub/1.0**（Android，`HamHub/1.0`）把面板下发的**根相对** `DirectStreamUrl`（`/videos/{id}/stream.hls?…`，见 [ADR-0062](../adr/0062-relative-playback-urls.md)）**按 origin 解析**（RFC 3986：根相对替换整个 path），`/emby` 被丢掉 → `http://host:8090/videos/…` → 404；抓包里同一会话**两种路径都发**：`/videos/…` 404 四次（1s/2s/4s 退避）、改用 `/emby/videos/…` 才 **200**（拿到主清单）。现 `listener.js` 的 `normalize()` 在两条与面板端口一致的规则之外**加第三条**：pathname **不以 `/api/` 开头**的一律前缀 `/api/emby`（见 [ADR-0065](../adr/0065-instance-port-root-path-fallback.md)）。**只改实例端口**；面板端口（`server.js`）不动。鉴权口径与 DTO 一字未改；`PANEL_ONLY_RE`（`accounts` / `instances` / `home-plugins` / `meta-domains`）与 `/api/`（非 emby）照旧 404。**待复测**：HamHub 点播时根路径 `/videos/…` 不再 404、主清单 200。

**不能模拟**：真机 `Accept-Ranges` / `Content-Range` / `Content-Length` 这些字节级事实来自实际文件（本地）或源站（远端）；面板两档（`client` 交给源站 / `proxy` 中继）都不在 emby 层自己生成。

**状态：12-1 已落码（未复测）；12-2 判定不复刻；12-3 登记为已知未实现；12-4 判定不改；12-5 已落码（未复测）；12-6 已落码（未复测）。** 样本为**电影**；剧 / 集样本待补测。
