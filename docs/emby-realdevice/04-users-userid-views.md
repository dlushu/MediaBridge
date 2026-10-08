# #4 `GET /api/emby/Users/{UserId}/Views`（媒体库列表）

> 索引：[emby-compat.md「十、真机对照记录」](../emby-compat.md)


**真机样本**（OkEmby 4.9.1.90，200，12 个库；予初Emby 不可达，补测后回填）

顶层形状 `{Items: [...], TotalRecordCount: 12}` —— 与面板一致。单个库条目（全部 12 个的键并集 = **28 键**）：

```jsonc
{
  "Name": "动画电影",                    // 库名
  "ServerId": "…",                       // 服务器 Id
  "Id": "4416",                          // 库 Id（真机是数字；面板是 mbphome_…）
  "Guid": "c825336c…",                   // 全局唯一标识
  "Etag": "36d39bf5…",                   // 内容指纹（缓存键；真机多个库有重复值）
  "DateCreated": "2025-11-17T14:26:10.0000000Z",  // 建库时间
  "DateModified": "0001-01-01T00:00:00.0000000Z", // 12/12 全是零值（从未修改）
  "CanDelete": false, "CanDownload": false,
  "PresentationUniqueKey": "c825336c…",  // 12/12 与 Guid 相同
  "SortName": "动画电影", "ForcedSortName": "动画电影",
  "ExternalUrls": [], "Taglines": [], "RemoteTrailers": [], "ProviderIds": {},
  "IsFolder": true,
  "ParentId": "2",                       // 12/12 全是 "2"（服务器根聚合节点）
  "Type": "CollectionFolder",
  "UserData": { "PlaybackPositionTicks": 0, "IsFavorite": false, "Played": false },
  "ChildCount": 1,                       // 12/12 都有（本样本全是 1）
  "DisplayPreferencesId": "c825336c…",   // 12/12 与 Guid 相同
  "PrimaryImageAspectRatio": 1.7777777777777777,  // 有封面才有；无封面的库没有此键
  "CollectionType": "movies",            // movies/tvshows/playlists/boxsets
  "ImageTags": { "Primary": "443e2f…" }, // 无封面的库是 {}（且无 PrimaryImageAspectRatio）
  "BackdropImageTags": [],
  "LockedFields": [],                    // 10 个库 []；「播放列表」「合集」为 ["SortName"]
  "LockData": false
}
```

**逐字段对照**（面板 `getViews` → `homeViewItem`）

| 字段 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| 顶层 `Items`/`TotalRecordCount` | 库列表与总数 | 有 | 有 | 一致 |
| `Name`/`ServerId`/`Type`/`IsFolder` | 库名、服务器 Id、固定 CollectionFolder | 有 | 有 | 一致 |
| `Id` | 库标识（客户端拿它取 `Items?ParentId=`） | 数字 `"4416"` | `mbphome_…` | 不能模拟（不透明标识，客户端只当字符串）；**品牌净化改名 `catpawhome_` → `mbphome_` 已落码、未复测** |
| `Guid`/`PresentationUniqueKey`/`DisplayPreferencesId` | 缓存/去重/显示偏好键，真机三者同值 | 真 GUID | 稳定派生 32hex（三者同值，对齐） | 一致（形状与关系对齐，值不同属正常） |
| `Etag` | 库内容指纹（缓存失效依据） | 有（真机多库重复同值） | 稳定派生 | 一致（用途对齐） |
| `DateCreated` | 建库时间 | 真实时间 | `0001-01-01…` 零值占位 | 不能模拟（无"建库"动作；非法日期会炸客户端解析，见 service 注释） |
| `DateModified` | 修改时间 | `0001-01-01…`（12/12） | 同零值 | 一致 |
| `CanDelete`/`CanDownload`/`ExternalUrls`/`Taglines`/`RemoteTrailers`/`ProviderIds`/`BackdropImageTags`/`LockData` | 操作权限与空集合 | 有 | 有 | 一致 |
| `SortName`/`ForcedSortName` | 排序名 | =库名 | =库名 | 一致 |
| `UserData` | 播放位置/收藏/已看 | `{0,false,false}` | 同 | 一致 |
| `CollectionType` | 库类型（客户端选图标/布局） | movies/tvshows/playlists/boxsets | 行申报，缺省 `mixed` | 一致（`mixed` 是 Emby 合法值，真机只是没用到） |
| `ImageTags`/`PrimaryImageAspectRatio` | 封面与宽高比 | 有图才给 AR，无图 `{}` | 同逻辑 | 一致 |
| **`ParentId`** | 父节点 Id（客户端"向上导航/取父级"用） | **12/12 = `"2"`**（根聚合节点） | **不给**（面板无此节点） | **待定夺**（见下 4-1） |
| **`ChildCount`** | 库内直接子项数（客户端判断空库/角标） | **12/12 都有（本样本=1）** | 行申报 `total` → `peekRowTotal` → 占位 `1` | **已改**（见下 4-2） |
| `LockedFields` | 被管理员锁定的字段 | 2 个库为 `["SortName"]` | 恒 `[]` | 不能模拟（面板无锁定概念，客户端无感知） |

**错误分支**

| 场景 | 含义 / 客户端用途 | 真机 | 面板 | 处理 |
|---|---|---|---|---|
| 无 token / token 无效 | 全局守卫，客户端回登录页 | 401 纯文本 `Access token is invalid or expired.` | 同（#3 已改） | 一致（未复测） |
| **有效 token + 任意/不存在 UserId** | 真机**不校验 UserId**，照常出库 | **200 全量库列表** | **200**（4-3 已放宽） | **已改**（未复测） |
| 账号表为空 | 面板独有 | — | 401 JSON | 保留（面板自造态） |

**不能模拟**：`Id` 数字形状、`DateCreated` 真实时间、`LockedFields` 锁定态、真机 `Etag` 多库同值（观察记录）。

**已按用户确认改（3 点）**：
- 4-1 **已改**：补 `ParentId: "2"`（占位值 —— 面板没有那个根聚合节点，客户端顺着取父级会 501/404，但客户端基本不这么干；字段集与真机一致）。落码：[service.js](../../server/modules/emby/service.js) `homeViewItem`。
- 4-2 **已改**：补 `ChildCount` —— **真实条数优先**，三级取数、都不为它打上游：
  ① 行在 `rows` 里**申报的库总数**（`r.total`，新契约，见首页插件指南的 `rows.total` + [ADR-0051](../adr/0051-home-row-declared-total.md)）—— 客户端**还没点开这个库**就有真数；
  ② 该行被点开过一次后，插件申报的总条数留在面板内存里（`home.peekRowTotal`，`remember` 时连同 items 一起存）；
  ③ 两个都拿不到才回退**占位值 1**（不取 0：0 会被客户端当空库）。
  TMDB 首页插件已按此申报（抓官网 About 页全库规模，`movies`/`tvshows`/`mixed` 分别映射，带缓存）。
- 4-3 **已改**：真机对 Views 不校验 UserId（有效 token + 任意 UserId → 200）。Views 路由的 `authorize(req, params.userId)` 改为 `authorize(req)`（只验 token，不比对 userId）；`getViews` 删掉 `assertUser` 调用（这条路上它本是死代码：能过 authorize 的 token 必然对应存在的账号）——「userId 不存在 → 404」「userId 与 token 用户不符 → 401」两个分支在 Views 上消失，与真机一致。

**状态：未复测**（`node --check` 通过；本地直调 `getViews('nonexistent')` → 200；面板端到端待批量复测）。
