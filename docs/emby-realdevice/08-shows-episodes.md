# #8 `GET /api/emby/Shows/{Id}/Episodes`（剧 / 季的分集列表）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（OkEmby 4.9.1.90；予初Emby 仍不可达）

- 登录：`POST /Users/AuthenticateByName`（body `{"Username":"（账号不入库）","Pw":"（口令不入库）"}` + 头 `X-Emby-Authorization: MediaBrowser Client="probe", Device="mac", DeviceId="probe-8", Version="1.0"`）→ 200。
  **token** `（令牌不入库）`，账号 / UserId / ServerId 见本机 `data/真机环境.md`。
  样本剧 Id `66972`（斯巴达克斯）、季 Id `81051`、集 Id `81068`。

**错误分支**

| 场景 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| 无 token（带/不带 `UserId`） | 全局守卫，客户端回登录页 | **401 纯文本** `Access token is invalid or expired.` | 401 纯文本（`authorize`） | 一致 |
| **有效 token + 合法但不存在的 UserId**（32 位 hex Guid） | 真机**不校验 UserId 与 token 的匹配** | **200 照常回集列表**（不校验） | 原 `getEpisodes` 内 `assertUser` → 404 JSON `{error:'用户不存在'}`；**8-2 已删** | **已改**（对齐真机：只验 token，UserId 降为进度兜底，见下 8-2） |
| 有效 token + 缺 `UserId` | 真机不校验 | **200** | 200 | 一致 |
| 有效 token + 非法格式 UserId（如 `WRONGID`） | 真机把 UserId 当 Guid 解析 | **500 纯文本** `Unrecognized Guid format.` | 404 JSON | 不模拟（同 5-2 / 7 附注：放宽后此分支在面板上自然成 200） |
| `Id` 不存在（合法 Guid） | 客户端拿了错的剧 Id | **404 纯文本** `找不到所请求的项目。可能已从服务器中删除了。` | 404 JSON `{error:'没有这个剧'}` | 语义一致；形状差异（真机纯文本 vs 面板 JSON，属 L1158 遗留） |
| `Id` 非 Guid 形状（如 `NOPE`） | — | **500 纯文本** | 404 JSON | 不模拟（面板 Id 非 Guid 形状） |
| `Id` 是集（如 `81068`，非剧 / 季） | 客户端拿了错的 Id | **404 纯文本** | 404 JSON | 语义一致；形状差异 |
| **季 Id 当路径、不带 `SeasonId`** | 客户端把季 Id 当剧 Id 发（少见） | **404 纯文本** | **200**（季号从路径里的季 Id 解出 → 回该季分集） | **保留**（面板更宽容；带 `SeasonId` 时两边都 200/19 集，Lumenic/1.0.0 实测打的就是带 `SeasonId` 的那种） |

**成功分支 / 查询参数**

| 查询形状 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| 顶层形状 | 集列表容器 | `{Items, TotalRecordCount}` | 同 | 一致 |
| `SeasonId=<季Id>` | 客户端是剧/季页发的，指定要哪一季 | 200，19 集 / `TotalRecordCount=19` | 同 | 一致 |
| `Limit=5` | 客户端分页 | Items 截 5，`TotalRecordCount=45` | 忽略 → 回全量 / 真实数 | 保留（超集无害，同 #5） |
| `StartIndex=10&Limit=3` | 客户端翻页 | 3 条 | 忽略 → 回全量 | 保留（超集无害） |
| `EnableTotalRecordCount=false` | 客户端嫌数数贵 | `TotalRecordCount=0` | 忽略 → 真实数 | 保留（超集无害） |
| `Fields=Overview` | 客户端要额外字段 | 条目**多出 `Overview`** | 忽略 | 保留（可选字段，同 #5） |

**分集 DTO 逐字段**（真机 24 键 vs 面板）

| 字段 | 真机 | 面板 | 含义 / 客户端用途 | 处理 |
|---|---|---|---|---|
| `Id`/`ServerId`/`Name`/`Type`/`IsFolder`/`MediaType`/`IndexNumber`/`ParentIndexNumber` | 有（`Type:Episode`、`IsFolder:false`、`IndexNumber` 集号、`ParentIndexNumber` 季号） | 有 | 集名 / 服务器 / 集 Id / 类型 / 非文件夹 / 媒体类型 / 集号 / 季号 | 一致 |
| `SeriesId`/`SeasonId`/`SeasonName` | 有 | 有 | 反向指回剧 / 季（客户端跳转 / 标题 / 面包屑） | 一致 |
| **`SeriesName`** | 有（剧名） | 有（**8-3 已补**：额外 `lookup` 取剧名，命中插件缓存） | 剧名（客户端标题 / 面包屑） | **已改**（见下 8-3） |
| `ImageTags`/`PrimaryImageAspectRatio` | 有（`Primary` 图 = 剧照） | 有（剧照，ratio `1.7777778`） | 集缩略图 | 一致 |
| `RunTimeTicks` | 有（已定档的集） | 有（`runtime` 有值才填） | 时长（客户端进度条分母） | 一致 |
| `PremiereDate` | 有 | 有 | 首播日期 | 一致 |
| **`UserData`** | **4 键**：`{PlaybackPositionTicks, PlayCount, IsFavorite, Played}` | **4 键**（同，`emptyUserData`） | 播放进度 / 已看次数 / 收藏 / 已看 | 一致 |
| **系列级父图字段**（`ParentLogoItemId`/`ParentLogoImageTag`/`ParentThumbItemId`/`ParentThumbImageTag`/`ParentBackdropItemId`/`ParentBackdropImageTags`/`SeriesPrimaryImageTag`） | 有（指回剧的图） | **无** | 父级图（客户端集缩略图 / 背景兜底） | **不改**（回退原则，同 7-4） |

**不能模拟**：真机 `Id` 是数字/`Guid` 形状（面板 Id 是派生字符串）；系列级父图字段的**真实 tag 值**（面板需先有真实图源，同 7-4）。

**差异处理（能补的就补 + 回退原则）**

- 8-1 **季 Id 当路径（不带 `SeasonId`）→ 不改**：真机 404、面板 200。面板更宽容（季 Id 里本就带着剧号与季号，信息不缺），且**收紧成 404 会打破 Lumenic/1.0.0 的实测用法**（它打的是带 `SeasonId` 的那种，但形态相邻，无需为对齐一个少见分支去动主路径）。保留现状。
- 8-2 **UserId 放宽 → 已改**（对齐真机，同 5-2/6-2/7-2）：路由 `authorize(req, userIdOf(query))` → `authorize(req)`；`getEpisodes(showId, seasonId)` 删 `assertUser` 且签名收敛（不再收 `requestedId`）；`getItem` 调用点同步。用户私有进度改由 `applyUserData` 按 token 解出的账号补，`UserId` 只当兜底。
- 8-3 **`SeriesName` → 已补**（对齐真机）：真机每条集都带剧名。取法照 `progressItem` 的做法**再 `lookup` 一次**剧接口取 `title` —— 走**元数据插件自己的缓存**（用户确认可多打，插件侧有缓存），**实际不额外打上游**；查不到只少一个可选字段，**不影响主结构**（回退原则，见「四」）。**不新增第二套逻辑**。
- 8-4 **系列级父图字段 → 不改**。依据**回退原则**（见「四」）：**emby 层不认识、也不为任何元数据插件特调**。与 7-4 同一判据（TMDB 插件无 series thumb / banner，各插件能给的还不一样），故不加。
- 8-5 **`Limit`/`StartIndex`/`EnableTotalRecordCount=false`/`Fields` → 不改**：面板忽略这些、回全量 / 真实数，对客户端是**超集**（客户端照单全收），同 #5 口径。
- 8-6 **未播出集默认不列 → 新增（有意偏离真机"照单全收"的取向，但与"只列磁盘上存在的文件"的真机**观感**一致）**：元数据给的是整季（issue #6 的两类样本：未来 `premiereDate` 的集与「末尾无日期占位」的集），真机只扫描磁盘文件、天然不出现未播出集；面板按元数据照列，客户端点开是空壳。默认两条规则过滤（未来日期 / 末尾占位；整季无日期不判），**实例页可关**（实例级 `hideUnairedEpisodes`，字段缺席 = 开；关掉即"元数据给什么列什么"）。逐字段影响：仅**列表条数**（未播出集所在位置之后少 1~N 条），`Id` 派生与字段形状不变。**未涉及**：季列表的 `ChildCount` / `UnplayedItemCount` 仍是元数据口径，整季都在未来时季本身仍会列出（点进去是 0 集，`getSeasons` 不改）；`Items/Counts`、`Items?Ids` 不变。另：真机「只列磁盘上存在的文件」是对 Emby 扫描行为的**推断**，本条没有复测「元数据带未播集时真机怎么列」这个场景，实测数字来自本面板部署实例。见 [ADR-0081](../adr/0081-hide-unaired-episodes.md)。

**状态：8-2 / 8-3 / 8-6 已落码（8-6 经部署实例实测：过滤开 = 「仙逆」162 集、「毛雪汪」159 集；过滤关 = 200 / 160 集，其余集不变）**；8-1 / 8-4 / 8-5 判定不改；**本条无开放差异**。`node tools/check-syntax.js` / `node tools/check-style.js` 通过；面板端到端待批量复测。予初Emby 恢复后补测本条。
