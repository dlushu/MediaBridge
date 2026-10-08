# #10 `GET /api/emby/Users/{UserId}/Items/{ItemId}`（条目详情 / `BaseItemDto` 本体）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（nyamedia 4.8.0.62；OkEmby / 予初Emby 待补测）

- 登录：nyamedia 账号（用户名 / UserId / ServerId 见本机 `data/真机环境.md`）、空密码 → 200；样本 token `（令牌不入库）`。
- 取一条电影：`GET /Users/$U/Items/232431` → **200**（14044 字节）。本样本是**电影**（`Type:"Movie"`）；剧 / 季 / 集的样本待补。

**鉴权分支**

| 场景 | 含义 / 客户端用途 | 真机 | 面板（改前） | 处理 |
|---|---|---|---|---|
| 无 token / 无效 token | 全局守卫，客户端回登录页 | **401 纯文本** `Access token is invalid or expired.` | 401 纯文本 | 一致 |
| 有效 token + **合法 Guid 但不存在的 UserId** | 客户端换号 / 重登后仍带旧 UserId | **200**（照常出条目；`UserData`/`CanDelete` 随上下文变） | **401**（`authorize` 先比对 UserId 拦下） | **差异** → 已对齐，见 10-1 |
| 有效 token + 真 UserId + **不存在的 ItemId**（`999999999`） | 客户端拿了个已下架 / 拼错的 Id | **500 纯文本** `Object reference not set to an instance of an object.` | 501（Id 前缀认不出）/ 404（认得出但查不到） | **差异**（真机是误码），见 10-2 |
| 有效 token + **非 Guid 格式的 UserId**（如 `WRONGID`） | 真机把 UserId 当 Guid 解析 | **500 纯文本** `Guid should contain 32 digits with 4 dashes (xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).` | 401 纯文本 | **差异**（真机是误码），见 10-2 |

**判读**：详情端点真机**只验 token**（有有效 token 即放行），路径里的 `UserId` **只用来取用户上下文**（`UserData` 进度、`CanDelete` 等），**不参与鉴权** —— 属**读取类端点**，**适用「只验 token」的自动对齐例外**。

**`BaseItemDto` 字段**（真机 vs 面板）

真机顶层 **49 键**：`Name` / `OriginalTitle` / `ServerId` / `Id` / `Etag` / `DateCreated` / `CanDelete` / `CanDownload` / `PresentationUniqueKey` / `Container` / `SortName` / `ForcedSortName` / `PremiereDate` / `ExternalUrls` / `MediaSources` / `ProductionLocations` / `Path` / `Overview` / `Taglines` / `Genres` / `CommunityRating` / `RunTimeTicks` / `Size` / `FileName` / `Bitrate` / `ProductionYear` / `RemoteTrailers` / `ProviderIds` / `IsFolder` / `ParentId` / `Type` / `People` / `Studios` / `GenreItems` / `TagItems` / `LocalTrailerCount` / `UserData` / `DisplayPreferencesId` / `PrimaryImageAspectRatio` / `MediaStreams` / `PartCount` / `ImageTags` / `BackdropImageTags` / `Chapters` / `MediaType` / `LockedFields` / `LockData` / `Width` / `Height`。

骨架键（`Id`/`Name`/`Type`/`ServerId`/`ParentId`/`IsFolder`/`UserData`/`ImageTags`/`BackdropImageTags`/`SortName`/`ForcedSortName`/`PresentationUniqueKey`/`DisplayPreferencesId`/`PartCount`/`LockData`/`LockedFields`/`CanDelete`/`LocalTrailerCount`/`TagItems`/`MediaType`/`Etag`）面板**均已给、与真机一致**。下列为**有差异**的字段：

| 字段 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| `Path` | 媒体文件路径 | 文件绝对路径（`/data/concert/…`） | **本面板 Stream 端点**（**相对路径** `/Items/…`） | 取值仍有意不同（不放源文件路径，见 [ADR-0006](../adr/0006-redirect-for-playback.md)）；**形态改为相对**（见 [#11](11-items-playbackinfo.md) 的 11-4） |
| `MediaSources` | 版本清单 | 单文件条目 1 条 | 线路=版本（聚合层给，**依赖聚合配置**） | 形状一致、来源不同——不改 |
| `ProviderIds` | 外部 id | `{Tmdb:"1317366"}` | `{MediaBridge:"<站>/<线路>\|<vod>", <域>:"<编号>"}` | 有意不同（自家域 + 源绑定）——不改；**品牌净化改名 `Catpaw` → `MediaBridge` 已落码、未复测** |
| `DateCreated` | 条目创建时间 | **文件**创建时间 | 上游**发行日期**近似 | 有意近似（见 `baseItem` 注释）——不改 |
| `PrimaryImageAspectRatio` | 主图宽高比 | 按实际图算（`0.7012…`） | 固定 `0.6666667` | 差异（面板无真实图尺寸）——不改 |
| `Chapters` | 章节 | 真实章节（本样本 20 条） | `[]`（面板不产出章节） | 差异（面板无从得知）——不复刻 |
| `PrimaryImageTag` / `PrimaryImageItemId` | 主图 tag 便捷位 | 本样本**未给**（只在 `ImageTags.Primary`） | **有** | 面板多给（为兼容只读便捷位的客户端，见 `baseItem` 注释）——有意，不改 |
| `DateModified` | 条目修改时间 | 本样本**未给** | 有（= `DateCreated`） | 面板多给（用于「最近添加」排序）——有意，不改 |
| `Tags` / `SpecialFeatureCount` | 标签 / 花絮数 | 本样本**未给** | 有（`[]` / `0`） | 面板多给（兜底数组）——不改 |
| `RemoteTrailers[].Name`、`People[].Role` | 预告片名 / 演职角色 | 只给 `Url` / `{Name,Id,Type}` | 给 `Name` / 多给 `Role`、头像 | 面板多给——不改 |
| `CanDownload` | 本条目能否下载 | `false` | 跟随实例级「下载」开关（默认开 → `true`） | **差异，已定案（见 10-3）** |
| `Width` / `Height` | 视频分辨率 | 有（`3840`×`2160`） | 条目级**已补**（取所选线路视频流；插件没给就没有） | **对齐（见 10-3，未复测）** |
| `MediaStreams[]` | 音视频轨（编码 / 分辨率 / HDR） | 有 | 有（来自源在集名里的标注） | 形状一致；逐键细节**待复测** |

**差异处理**

- 10-1 **UserId 校验 → 适用自动对齐例外、已对齐「只验 token」**（鉴权分支第 2 行）：真机详情端点**不比对 UserId**（有效 token + 合法 Guid 但不存在的 UserId → **200**），属读取类，按既定口径直接对齐 —— 路由 `service.authorize(req, params.userId)` → `service.authorize(req)`；`service.getItem` 去掉 `assertUser(requestedId)`（连带 `getSeasons(showKey, requestedId)` 的第二参与 `getPlaybackInfo` 透传的 `requestedId` 一并清理）。进度仍由 `applyUserData(out, params.userId, req)` 按 **token 解出的账号**补（`accountIdFor` token 优先）—— 带别人的 `UserId` 也只看到自己 token 账号的进度，**不引入跨账号可见性**。
  - **已落码，未复测**（待端到端复核：有效 token + 不存在的 UserId 应回 200）。
- 10-2 **错误码 → 不复刻**：真机对「不存在的 ItemId」回 **500** `Object reference not set to an instance of an object.`、对「非 Guid 的 UserId」回 **500** `Guid should contain 32 digits…`；两处都是真机的**实现误码**（异常直冒）。按本层「不编、防枚举」口径**维持原码**：Id 前缀认不出 → **501**、查不到 → **404**、UserId 与 token 不匹配 → **401**（不用 404，防账号枚举，同 #9）。
- 10-3 **两处已定案**（下载做成**产品能力**、分辨率**只在片源插件给了才显示**）：
  - `CanDownload` / 下载能力：真机样本为 `false`（那台服务器的配置），本面板做成**实例级「下载」开关、默认开**（`instances.json` 的 `allowDownload`，与 `enabled` 同类）。开关驱动**三处同一口径**：握手 `Policy.EnableContentDownloading`、条目 `CanDownload`、`Items/{ItemId}/Download` 端点门禁（关闭时 **403 纯文本** `Downloading is disabled on this server.`）。⚠️ 这**修正了 #9 遗留的自相矛盾**（此前 policy 写死 `false`、条目却给 `true`、注释还写着「与 policy 对齐（true）」）—— 三处现在统一跟随开关，注释已改。**偏离真机样本属有意产品取舍**，理由见 [ADR-0049](../adr/0049-emby-instance-download-switch.md)。**已落码，未复测**（待复核：开关开 → 三处都为「能下」；关 → policy `false` + `CanDownload: false` + 下载端点 403）。
  - `Width` / `Height`（条目级）：真机有（`3840`×`2160`），面板此前只在 `MediaStreams[]` 里给。现**提到条目级**（`getItem` 条目级块取所选线路视频流的 `Width`/`Height`）。**契约已存在** —— 插件契约（另仓库 `media-bridge-plugins/docs/plugin-contract.md`）**早已声明 `width`/`height`**，面板已把它解析进视频流，本次只是提到条目级，**不改插件契约**。**插件没给就没有这俩字段**（面板**不从集名正则反推** —— 避免与真机"扫过文件"的语义混淆）。**已落码，未复测**。
- 10-4 **其余多给可选字段**（`Tags` / `SpecialFeatureCount` / `DateModified` / `RemoteTrailers[].Name` / `People[].Role` / `PrimaryImageTag`+`PrimaryImageItemId`）：真机本样本未给、面板给了；皆为**可选键、客户端忽略**，且各有既有理由（兜底数组、排序、"只读便捷位"客户端），**判定不改**。

**不能模拟**：真机 `Chapters` 来自实际扫描媒体文件（面板没有文件）；`MediaSources` 的文件级事实（`Path` / `Size` / `Bitrate` / `MediaStreams`）面板只能取源在集名里的标注，粒度不如真机。

**状态：10-1 已落码（未复测）；10-2 判定不复刻；10-3 两处已定案并落码（未复测）；10-4 判定不改。** 本样本为**电影**；剧 / 季 / 集的样本待补测（OkEmby / 予初Emby 恢复后补）。
