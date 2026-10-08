# #11 `POST /api/emby/Items/{ItemId}/PlaybackInfo`（播放信息 / `PlaybackInfoResult`）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（予初Emby 4.9.5.0；动漫Emby 4.10.1.0；OkEmby 4.9.1.90）

- 登录均 **200**。样本：予初Emby 电影 `864879`（版本 Id `mediasource_864879`）与剧集 `585872`；动漫Emby 电影 `204658`（爱宠大机密）；OkEmby 电影 `47156`（版本 Id `mediasource_47156`）。
- **路径形态**（同一请求两种带法）：
  - `POST /Users/{UserId}/Items/{ItemId}/PlaybackInfo`（Users-form）：予初Emby **200**（4146 字节）；OkEmby **404 纯文本**（`找不到文件 …` —— 该形态未注册）。
  - `POST /Items/{ItemId}/PlaybackInfo?UserId=…`（Items-form）：**两台都 200**。
  - **判读**：Items-form 是**安全共同分母**；面板正是只注册 Items-form，**无需增补 Users-form 别名**。

**鉴权分支**（予初Emby 实测，POST）

| 场景 | 含义 / 客户端用途 | 真机 | 面板（改前） | 处理 |
|---|---|---|---|---|
| 无 token / 无效 token | 全局守卫，客户端回登录页 | **401 纯文本** | 401 纯文本 | 一致 |
| 有效 token + **合法 Guid 但不存在的 UserId** | 客户端换号 / 重登后仍带旧 UserId | **200** | **401**（`authorize` 先比对 UserId 拦下） | **差异** → 已对齐，见 11-1 |
| 有效 token + **非 Guid 格式的 UserId** | 真机把 UserId 当普通参数 | **200** | **401** | **差异** → 已对齐，见 11-1 |
| 有效 token + 真 UserId + **不存在的 ItemId** | 客户端拿了个已下架 / 拼错的 Id | **404 纯文本** `找不到文件 "…" 。` | 501（Id 前缀认不出）/ 404（认得出但查不到） | 差异（真机是反代/插件口径的纯文本），见 11-2 |

**判读**：播放信息真机**只验 token** —— 有有效 token 即放行，路径/query 里的 `UserId` **只当参数**（连 Guid 格式都不校验）。本端点**只返回版本清单、无用户私有数据、面板无持久化写入**，属**读取类端点**，**适用「只验 token」的自动对齐例外**（虽为 POST）。

**顶层结构与字段**（真机 vs 面板）

真机顶层**仅 2 键**：`MediaSources` / `PlaySessionId` —— 面板**一致** ✓。

`MediaSources[]`（版本）真机 予初Emby **28 键**（含 `DirectStreamUrl`）、动漫Emby / OkEmby **27 键**（**不含 `DirectStreamUrl` 键**）；面板在条件字段齐时**恰好 28 键、逐键与真机一致** ✓。下列为**有差异**的字段：

| 字段 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| `DirectStreamUrl` | 直连拉流地址 | 予初Emby（4.9.5.0）相对路径 **裸 `stream`**（`/videos/…/stream?MediaSourceId=…&api_key=…&Static=true`，`Container='mkv'` 也**不拼 `.mkv`**，电影 `864879` / 剧集 `585872` 两条原文一致）；动漫Emby（4.10.1.0）/ OkEmby **未给该键** | **相对路径带容器后缀**（`/videos/…/stream.{容器}?…`，`hls` 映射为 `m3u8`，见 11-5） | **有意不同**：真机形态为裸 `stream`，但裸后缀打断靠 URL 后缀判类型的客户端（ExoPlayer 系只认 `.m3u8`），能播优先于形态对齐（见 [ADR-0071](../adr/0071-direct-stream-url-container-suffix.md)） |
| `Path` | 版本对应的媒体路径 | 文件绝对路径（OkEmby `/mnt/EmbyResource01/…`）或远程 http URL（予初Emby） | **本面板 Stream 端点**（**相对路径** `/Items/…`，末段为**标准文件名**，见 11-3） | 取值仍有意不同（不放源文件路径，见 [ADR-0006](../adr/0006-redirect-for-playback.md)）；**形态改为相对**（见 11-4） |
| `Protocol` | 拉取协议 | OkEmby（本地）`File` | `Http` | 有意不同（一律走本面板 Stream）——不改 |
| `IsRemote` | 是否远端 | OkEmby（本地）`false` | 恒 `true` | 有意不同（一律走本面板 Stream）——不改 |
| `Name` | 版本显示名 | 文件名派生（`480p H264` / `2160p`） | `站点标签 · 线路` | 有意不同（聚合层命名）——不改 |
| `SupportsProbing` | 是否支持探测 | `true` | `false` | 有意（面板不扫文件，注释已说明）——不改 |
| `Chapters` | 章节 | OkEmby 23 条 / 予初Emby 0 | 恒 `[]` | 差异（面板无文件）——不复刻 |
| `MediaStreams[]` | 音视频 / 字幕轨 | Video 33/32 键、Audio 24/22 键、含**字幕轨** 25 键 | `STREAM_BASE`(5) + 源申报规格；**无字幕轨** | 形状一致、粒度不同（面板只取源在集名里的标注）——不改 |

**差异处理**

- 11-1 **UserId 校验 → 适用自动对齐例外、已对齐「只验 token」**（鉴权分支第 2、3 行）：真机播放信息端点**不比对 UserId**（有效 token + 不存在 / 非 Guid 的 UserId → **200**）。虽为 POST，但只返回版本清单、**无用户私有数据、无持久化写入**，属读取类，按既定口径直接对齐 —— 路由 `service.authorize(req, userIdOf(query))` → `service.authorize(req)`。**不引入跨账号可见性**（返回的版本清单与用户无关）。**已落码，未复测**（待端到端复核：有效 token + 任意 UserId 应回 200）。
- 11-2 **错误码 → 不复刻真机口径**：真机对「不存在的 ItemId」回 **404 纯文本** `找不到文件 "…" 。`（予初Emby 是中文反代 / 插件口径）；面板维持 **501**（Id 前缀认不出）/ **404**（认得出但查不到），与 #10-2 同口径。
- 11-3 **版本行副标题 → 改为「标准文件名」**：`Path` 末段（客户端取「最后一个 `/` 之后」当版本行副标题）由「站点来源标签 · 集名」改为聚合层拼好的**标准文件名**（`标题.年份.季集.分辨率.来源.音频(含声道).Atmos.动态范围.视频编码.容器`，如 `蜘蛛侠：崭新之日.2026.2160p.WEB-DL.DDP5.1.Atmos.DV.H.265.mkv`），**不带站点前缀**。只动副标题 —— 标题位 `Name` / `MediaStreams` 不变、播放不读这个 `Path`。**已落码，未复测**（待端到端复核副标题文本）。
- 11-4 **`DirectStreamUrl` / `Path` 的地址形态 → 绝对 URL 改为相对路径**（对齐真机，修 AfuseKt 起播）：此前 `DirectStreamUrl` 与 `MediaSources[].Path` 都是**绝对 URL**（`{proto}://{host}/api/emby/…`），理由是「绝对地址在任何解析规则下都不会错」。实测 **AfuseKt/3.2.0** 把返回的地址**当相对路径直接字符串拼在自己的 base 之后**（`base` 已含 `/emby`），于是拼成双重地址 `…/emby` + `http://…/api/emby/videos/…` → 实例端口 `normalize` 后不以 `/api/emby/` 开头 → **404**（日志：`GET /emby/http://…`）。现两处都改**相对路径**：`DirectStreamUrl` → `/videos/{ItemId}/stream…?…`（当时拼的是 `stream.{Container}`；后缀后来经 11-5 去掉又恢复，现行为见 11-5），`Path` → `/Items/{ItemId}/Stream/{token}/{文件名}`（去掉 `/api/emby` 前缀）。去掉前缀后 base 是 `/emby` 还是 `/api/emby` 都能命中。随之下掉 `getItem`/`getPlaybackInfo`/`buildMediaSource` 的 `host`/`proto` 参数（routes 里那个 `protoOf` 也随之删除）。见 [ADR-0062](../adr/0062-relative-playback-urls.md)。**已落码，未复测**（待 AfuseKt 端到端复核起播）。
- 11-5 **`DirectStreamUrl` 容器后缀：去掉后又恢复，`hls` 映射为 `m3u8`**（回归修复）：最初拼 `stream${container ? '.' + container : ''}`（mkv 源出 `stream.mkv`、missav 的 hls 源出 `stream.hls`）；复核予初Emby 原文（电影 `864879` / 剧集 `585872` 两条 `DirectStreamUrl` 均为裸 `stream`，`Container='mkv'` 也不拼）后曾按「形态对齐真机」去掉后缀（ADR-0070）。上线实测**回归**：靠 URL 后缀判类型的客户端（ExoPlayer 系，如 CapyPlayer/1.1.6）把裸 `stream` 当普通文件嗅探，拿到 m3u8 文本不走 HLS 解析器，报 `UnrecognizedInputFormatException`（`NoDeclaredBrand`）—— 面板侧清单中继全程 200 正常，故障在客户端的类型判定。⇒ 恢复带后缀（ADR-0071，**能播优先于真机形态对齐**），但**不照抄 `Container`**：`hls` → **`m3u8`**（`hls` 是 DTO 容器枚举值、不在 ExoPlayer 的后缀推断表里；真机 HLS 拉流地址本就是 `*.m3u8`），其余容器原样拼。路由正则 `stream(\.[a-z0-9]+)?` 不受影响，裸 `stream` / `.m3u8` / `.mkv` 都收。**已落码，未复测**（待 CapyPlayer 等端到端复核起播）。

**不能模拟**：真机 `MediaSources` 的**文件级事实**（`Path` / `Size` / `Bitrate` / `Chapters` / `MediaStreams` 全轨道）来自实际扫描媒体文件，面板只能取源在集名里申报的规格，粒度天然不如真机。

**状态：11-1 已落码（未复测）；11-2 判定不复刻；11-3 已落码（未复测）；11-4 已落码（未复测）；11-5 已落码（未复测）。** 样本已含**电影**（予初Emby `864879` / 动漫Emby `204658` / OkEmby `47156`）与**剧集**（予初Emby `585872`）。
