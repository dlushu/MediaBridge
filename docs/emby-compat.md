# Emby 兼容开发指南

本面板要能对接真实 Emby 客户端。做法是**先只看客户端要什么，再逐条补齐被指定的端点**——不猜测、不预置。

---

## 一、铁律（不可绕过）

> **补哪些端点由部署者指定。实现方不得自行扩展。**
>
> 本文档中「部署者」= 部署并配置本面板的人；「用户」= Emby 客户端那一侧的用户（如「用户数据」「用户级数据」）。

具体含义：

- 只实现**被明确指定**的端点，一次一个。
- **不预置**任何 Emby 响应，**不猜测** API 形状，**不额外**加"看起来可能要"的接口或字段。
- 需要新端点时的顺序固定：**日志里先看到它 → 由部署者指定 → 才实现 → 记入本文档「已实现端点」表**。
- 本文档是端点清单的唯一来源；代码里不放未经指定的端点。
- **「留白端点」不算违反本条**：可以明确要求「端点通、数据空」——此时只返回 Emby 的合法空响应，并在代码与本文档里标注「留白」。判断标准是**这个决定由部署者做出**，不是实现方推测「先返回个空壳应该没错」。
- **补之前先划范围**：只补「这条 API 背后的能力属于面板」的端点（**界内**）；属于官方服务器自身能力的（转码、本地库扫描、用户权限 / 家长控制等）属**界外**，一律不认领。范围与判据见 [ADR-0056](adr/0056-emby-compat-scope.md)。

### 另一条：项目未发布 —— 不为「迁移 / 旧状态」妥协

> **本项目尚未发布。不要为了"平滑过渡""兼容旧数据""照顾已有客户端状态"而留分支、加开关、留旧格式。**

- 判断标准是：**这条分支是为了"现在的代码更正确"，还是为了"迁就过去的状态"？** 后者一律不做。
- 实例：AccessToken 校验一度做成 `auth.mode`（`warn` 只记日志放行 / `strict` 回 401），理由是"客户端手上是校验上线前发的旧 token"——**已拆除**。正确做法是让客户端**重登一次**，而不是让校验长期存在一条"放行"路径。
- 与「数据搬迁」区分开：**一次性的 `migrateLegacy()` 可以有**（单账号明文 → sqlite、老 `settings.json` → `settings/`），因为那是"数据真的要丢"；**运行时的兼容分支/多模式开关不要有**。
- 同理适用于：Id 编码格式、设置字段名、备份格式 —— 该改就改，不留双写与双读。

## 二、日志（怎么看、看得到什么）

**两条查看路径**：

| | 看什么 | 留多久 |
|---|---|---|
| **面板「面板设置 → 日志」** | 整个面板进程的日志（内存里最近 N 条，默认 500，面板设置里改 `logMax`） | 进程重启即清空，**不落盘**（磁盘零增长） |
| **`docker logs media-bridge-panel`** | 同一份输出的**长期留档** | docker 的 json-file 自带轮转：`max-size 10m` × `max-file 3`，更老的自删 |

两者是**同一份输出的两个出口**：`server/core/logbus.js` 在启动时把 `console.log/warn/error` 包了一层 ——
**先照原样写到 stdout**（docker 那份一字不差），**再**存一份进内存环形缓冲（面板那份）。

### 日志口径：**每个请求都记一行，不做筛选**

**每个打到 `/api/emby/**` 的请求都记一行**，不按状态码筛：

| 结果 | 记哪些 |
|---|---|
| 成功 | 2xx：握手 / 登录 / 取用户资料 / 媒体库列表 / 条目列表 / 最新条目 / 详情 / 季集 / 相似 / 播放信息 / 拉流 302 / 下载 302 / 出图 200 / 账号列表 |
| 失败 | ≥400：401 没带 token、404 认不出的 Id、502 上游挂了、504 超时、400 参数不合法 |
| 失败 | 未实现端点（501 通配），行首是 `未实现#N` |
| 成功 / 失败 | 面板自用端点的**增删改**（账号增改删、元数据插件测试、清空缓存）—— 那是动凭据 / 动缓存的动作，留审计 |

**量靠别处压，不靠"少记"**：记录**不筛选** ——
① 面板「日志」页是**固定条数的内存环形缓冲**（默认 500，`panel.logMax` 可调），满了覆盖最老的，内存有硬上限；
② 页面上的「全部 / 警告以上 / 仅错误」是**看的时候再筛**，不影响记录；
③ docker 那份有 10MB × 3 的轮转。
⇒ 所以"哪条重要"由**查看者**决定，日志层不替部署者挑。

> 最近一次调整：一度做成"只记失败"，随即改回全记 ——
> 因为有了带过滤器的日志页，"量"已经不是问题；而"看不到正常请求"反而无法判断客户端在做什么。

### 结果行的形状（成功与失败是同一个形状，只差行首标记）

```
✔ emby 条目列表 Users/…/Items → HTTP 200 ?ParentId=mbphome_…&Limit=30 items=20  example/popular 库内容 → 本页 20 条 / 共 20001  [Rex/0.1.0]
✔ emby 最新条目 Users/…/Items/Latest → HTTP 200 ?ParentId=mbphome_…&Limit=20 items=20  example/now_playing 最新 → 20 条（顺序由模块决定） [VidHub/3.0.6]
✔ emby 图片 Items/{域}_1204680_movie/Images/Primary → HTTP 200  76748 字节（索引） 573ms [Rex/0.1.0]
✘ emby 条目列表 Users/…/Items → HTTP 502 ?ParentId=mbphome_…&Limit=30 items=-  example/popular 库内容 → 上游连不上 [Rex/0.1.0]
✘ emby 条目列表 Users/probe/Items → HTTP 401 ?ParentId=…&Limit=20 items=-  token 校验不过：没带 token [VidHub/3.0.6]
```

| 部分 | 说明 |
|---|---|
| 标签（`条目列表 Users/…/Items`） | 哪条端点 |
| `HTTP <状态码>` | 200 / 302 / 401 / 404 / 502 / 504 … |
| query 摘要 | 客户端带了什么参数（**哪一页、哪个 `ParentId` / `MediaSourceId`**） |
| `items=N` | 回了多少条（`countOf`）。**失败时是 `-` 而不是 0** —— 不要把"没查成"看成"查到但是空的" |
| 原因 | `service` 给的 `log`：`token 校验不过` / `上游连不上` … |
| `[客户端/版本]` | 取自 `x-emby-authorization` 的 `Client=`，退回 UA。**没有它等于没记**：三个客户端都打同一条端点，分不清是谁 |

### 未实现端点（501）的形状

```
✘ emby 未实现#12 GET /api/emby/System/Ext/ServerDomains?api_key=…&X-Emby-Token=… [SenPlayer/6.1.8]
```

一行：序号 + 方法 + 完整路径 + **query**（截断 400 字符）+ 客户端。响应体：

```json
{ "error": "EMBY_ENDPOINT_NOT_IMPLEMENTED", "path": "/api/emby/xxx", "logSeq": 12,
  "hint": "该端点尚未实现，已记录到面板日志" }
```

- `logSeq` 就是那行的 `#12`，便于把"这条响应 ↔ 日志里哪一行"对上。
- **query 一定留着**（虽然长）：那是判断"客户端到底要什么"的唯一线索 ——
  `Fields=` 里往往写着它想要哪些字段，`ParentId=` 写着它在逛哪个库。
  ⚠️ **但敏感参数一律掩码**：客户端把凭据塞在 query 里是常态（`?api_key=` / `?X-Emby-Token=`），
  原样打出来就是把凭据写进日志。判据是**子串**匹配（`log.js` 的 `SENSITIVE_KEY`：
  `token / secret / password / api_key / authorization / credential`…）——
  实测曾漏掉 `?X-Emby-Token=…` 一条（旧 `monitor.js` 用的是精确匹配，同样漏）。
- **不再打印 headers / body**：那几行既是噪音，也是内存占用的大头
  （body 上限 2000 字符，进内存缓冲很占地方）。`client / device / ver / ip` 那几个头也一并省了 ——
  客户端标记已经在行尾。body 里可能的明文密码（`Pw`）因此**根本不会再进日志**。

### query 摘要的规则（`emby/log.js` 的 `queryBrief`）

敏感参数（`api_key`、`token`…）值掩码；`Fields` / `EnableImageTypes` 这类超长又没诊断价值的压成 `…`；
单值截断 60 字符、总长封顶 300；**顺序保持客户端原样**（Emby 把 `ParentId` 放前面，关键信息不会被截掉）。

> 这段的起因很具体：已实现端点原先只打一行结果、不带参数，于是
> **"`Items` 到底带没带 `ParentId=<本面板的库Id>`"完全无从判断**，排查因此受阻。

### 怎么查看

```bash
# 面板里：「面板设置 → 日志」页（带 暂停 / 清空 / 复制 / 级别过滤）
docker logs media-bridge-panel                 # 长期那份（全部）
docker logs --since 10m media-bridge-panel     # 最近 10 分钟
docker logs -t media-bridge-panel              # 带时间戳
```

> **本机部署（路由器 docker）下即上述用法**。⚠️ **`docker logs --tail N` 在文件被截断过之后会卡住**
> （docker 还按旧偏移量找行），用 `--since` 没有这个问题 —— 清空之后一律用 `--since`。

### 清空

- **面板那份**：日志页上点「清空」（等价于 `DELETE /api/logs`）—— 只清内存缓冲，docker 那份不动。
- **docker 那份**：收到清空请求时直接清空（截断 json-file，**不用重启**）：

  ```bash
  : > "$(docker inspect --format='{{.LogPath}}' media-bridge-panel)"
  ```

  清空前**不要**先读取、统计或打印里面已有的内容（其中可能带客户端登录信息）；清空后只需回报「已清空」。

## 三、工作流

1. 启动面板（`npm start`）。
2. 在 Emby 客户端里把服务器地址指向**某个 Emby 实例的端口**（面板「Emby → 实例」页每行给出的连接地址，
   新建实例端口留空时从 `8090` 起依次 +1，形如 `http://<面板地址>:8090`）：填主机即可，客户端会自己去打 `/emby/...`，实例监听把它归一成
   `/api/emby/...`（也可以直接填 `http://<面板地址>:8090/api/emby`，两种都收）。
   **面板端口（`8088`）不再提供客户端协议端点**，只有面板自用端点与 `System/Info/Public` 垫片。
3. 在客户端里正常操作（登录、进媒体库、播放……）。
4. **看日志**，把客户端要的端点与其参数记下来。
5. 把「这次要补的端点」交给实现方 —— **一次一个**。
6. 实现后，该端点返回正常响应，并把一条记录填进下面「已实现端点」表。

> 日志里所有 `501` 的端点 = 客户端想要、但还没有的端点。按需要挑，不必全补。
> 例外：已记进「六、界外：明确不认领的请求」的，连提都不用提。

## 四、实现一个端点时的要求

- 只动 `server/modules/emby/`；**不要**改其它模块来做兼容（需要聚合能力就走聚合层的 HTTP 接口）。
- 端点必须注册在通配路由 `ANY /api/emby/*rest` **之前**，否则会被通配吞掉。
- emby 层只依赖**聚合层**的接口，且是**进程内直调**：`require('../agg/api')` 拿 `detail()` / `play()`，**不再打自己的 `/api/agg/*`** —— 那条自调用不带面板 cookie，会被面板门禁（`core/auth.js` 的 `needsAuth`，`/api/` 开头一律要登录）挡成 **401**，表现为"每条详情只回元数据、播放链路全断"，而日志里只写 `UPSTREAM_HTTP http://127.0.0.1:<端口>`，看不出是 401。`/api/agg/detail` / `/play` 两个端点仍保留给前端与外部用，与 emby 层**共用 `agg/api.js` 里同一套编排**。
- 协议细节（`vod_play_from` 的 `$$$`、`vod_play_url` 的 `#`/`$`、`push://`、`play.url` 既可能是字符串也可能是数组）**留在聚合层**，emby 层不要重复解析——需要哪种形状时，先让聚合层提供对应的对外契约。
- **元数据插件是「可选能力」，查不到不能动主结构（回退原则）**：**emby 层不认识、也不该认识是哪个元数据插件**
  —— 前端可换插件，各家能给的字段本就不同（有的给 logo，有的连背景只有一张；同名字段未必人人都有）。
  由此两条硬约束：
  ① **不为任何插件特调** —— 字段按数据通路该有就有、没给就没有，emby 层不猜、不补、更不为"某家插件缺这个字段"写特例分支；
  ② **可选字段缺失只降级、不牵连**：图片、标签这类"锦上添花"的字段，有就填、没有就**照常省略**，**绝不影响主结构**
  （`Id`/`Name`/`Type`/`ParentId`/季集坐标/播放链路/数组字段容器一律照旧成立）。
  与上面「不知道就空字段」同一条口径，只是把"哪个字段"换成"哪个插件"：**插件差异止步于取数，不要渗进 DTO 的形状**。
- 响应尽量贴 Emby 客户端的期望（字段名、大小写、分页参数），以客户端实测为准。
- **端点一律校验 AccessToken**（现行口径，取代早先的"回空不校验"）：真机对齐后不再按"这个查询会不会出数据"分档 ——
  `Items`（「十」#5）、`Items/Latest`（#6）、`Studios`（#14）、`Items/Counts`（#16）等**无 / 无效 token 一律 401 纯文本**。
  早先的"回空不校验"取向及其判据函数 `service.itemsWillReturnData()` **已作废 / 已删**（[ADR-0009](adr/0009-unauthenticated-empty-responses.md) 后记）
  —— 正常客户端都带 token，无人被误伤；收藏等曾按「待补」对待的端点现已出真数据，本就该校验，口径一致。
  **唯一豁免**是握手类（`System/Info/Public` / `System/Ping`）、登录、面板自用端点、501 通配与图片端点，
  各豁免理由见 `server/modules/emby/routes.js` 头部与本文「五」。
- ⚠️ **DTO 要给"完整形状"—— 客户端会因为缺字段而整条失败**（由 SenPlayer 实测发现，**这条代价最大**）：
  - **症状**：客户端拿到 `200` 之后**不再发任何后续请求**（正常时点开一条会紧跟一条 `Similar`），
    界面提示「网络错误 / 当前媒体库不存在该项目」。**它不是在抱怨某个字段为空，而是整条响应解不出来。**
  - **判据（怎么确认是形状问题而不是别的问题）**：拿**真机 Emby 的响应**当模板回同一路径
    —— 立刻正常就说明是形状；还不行才是别的原因。不要被"自己造的更丰富的假数据"误导：
    自造数据只能证明"缺 `MediaSources`"，证明不了"字段形状对不对"。
  - **哪些属于"必须有"**：真机每条都带的**结构性字段**。本项目已按真机（Emby 4.9.5）逐项对齐，
    清单与实测见「五」的**结构性字段**那条。要点：
    `ParentId`、`DateCreated`/`DateModified`、`Etag`、`SortName`、`PartCount`、`CanDelete`/`CanDownload`、
    `LockData`/`LockedFields`、条目级 `Container`/`MediaStreams`/`Path`、以及 **`People[].Id` / `Studios[].Id`**。
  - **数组字段一律给 `[]`，不要整个省略** —— 客户端把数组声明成非可选时，键缺失同样会整条失败。
  - **类型必须对**：真机 `Studios[].Id` 与 `GenreItems[].Id` 是**数字**、`People[].Id` 是**字符串**。
    原实现把 `GenreItems[].Id` 给成字符串、`Studios`/`People` 则不给 Id。
  - **客户端自己会说要什么**：Emby 客户端请求上带 `Fields=`（SenPlayer 的清单里有 `BasicSyncInfo`、
    `Container`、`MediaStreams`、`DateCreated`…）。**当前实现忽略 `Fields`、一律全给**（超集不会出错），
    但**它明确要求的字段一定要有** —— 排查时先把客户端的 `Fields` 抄下来逐项对。
- **「不知道就空字段」，不要照抄真机充数**（既定口径）：
  真机有、但**本项目并不掌握**的字段一律**不填**。据此**删掉**过这几个照抄来的：
  `SupportsProbing`、流级 `Protocol`（真机是 `File` 因为文件在本地，本项目是从 http 拉的）、
  `TimeBase`（真机来自**文件解析**）、`IsAnamorphic`/`IsInterlaced`/`IsHearingImpaired`（要探测文件才知道）、
  `ExtendedVideoType`（要知道 HDR 细类）。
  同理 `VideoRange` / 色彩三元组**只在源标了 HDR 时才给**，不假设 `SDR`/`bt709`。
  **能如实推导的可以给**（如 `AspectRatio` 由源给的宽高化简）；**纯占位标识符**（`Etag`、`PresentationUniqueKey`、
  `DisplayPreferencesId`）可以给，但**必须由内容/Id 稳定派生** —— 每次请求都变会让客户端缓存反复失效。
  ⚠️ 唯一一处"近似"是 `DateCreated`/`DateModified`：真机给**文件**的创建/修改时间，本项目没有文件，
  改用 **上游发行日期**（拿不到发行日期就不给这两个字段）。

## 五、已实现端点

| 方法 | 路径 | 入参 | 响应 | 依据 |
|---|---|---|---|---|
| GET | `/api/emby/System/Info/Public` | 无 | 握手信息：`ServerName`（**= 该实例的 `name`**，在面板「Emby → 实例」页的编辑弹窗里改；留空回落 `媒体桥`（`core/branding.js` 的 `name`））/ `Version(4.8.0.0)` / `Id` / `LocalAddresses`(空) / `RemoteAddresses`(空)。**字段集对齐真机样本**（两台真机实测只回这 5 个字段；`LocalAddress` / `ProductName` / `OperatingSystem` / `StartupWizardCompleted` 已按真机删除） | 部署者指定（客户端需先握手）；字段集以真机样本为准（方案 A，见「十、真机对照记录」#1） |
| GET | `/api/emby/System/Info` | 无 | 200 **完整服务器信息**（**诚实子集**：只回面板真有的 **17** 个字段 —— `ServerName` / `Version(4.8.0.0)` / `Id` / `OperatingSystem`（面板运行 OS）/ `LocalAddress`（请求 `Host` 去端口）/ `LocalAddresses`(空) / `RemoteAddresses`(空) / `CompletedInstallations`(空)，能力位 `HasPendingRestart` / `IsShuttingDown` / `SupportsLibraryMonitor` / `CanSelfRestart` / `CanSelfUpdate` / `CanLaunchWebBrowser` / `SupportsHttps` / `HasUpdateAvailable` / `SupportsAutoRunAtStartup` **一律 `false`**）；面板无对应物的 `SystemUpdateLevel` / `OperatingSystemDisplayName` / `SupportsLocalPortConfiguration` / `WebSocketPortNumber` / `HttpServerPortNumber` / `HttpsPortNumber` / `HardwareAccelerationRequiresPremiere` / `WanAddress` **不回**；**只验 token、不比对 UserId**（与 `Studios` / `Items/Counts` 同口径） | 部署者指定（新客户端 **Filmly/2.12.11-439** 登录后打到 501）；字段取舍见 [ADR-0057](adr/0057-emby-system-info-honest-subset.md)；**真机对照见「十」#20：真机 4.8 / 4.9 同构 25 字段，面板取诚实子集、字段集小于真机** |
| GET | `/api/emby/System/Ping` | 无 | **200 `text/plain`**，body 常量 `Emby Server`（11 字节，**非 JSON**）；**豁免 AccessToken**（连通性探针，要求 token 会让探针失败） | 部署者指定（新客户端 **Lenna/1.0.16** 的连通性探针，落到 501 后接线）；**真机对照见「十」#19：予初Emby / OkEmby / nyamedia 回 200 纯文本 `Emby Server` 且免鉴权，itsmygo 要 token（无 / 无效 → 401 JSON `{"error":"unauthorized"}`）—— 对齐多数、豁免 token，itsmygo 差异登记不复刻** |
| POST | `/api/emby/Users/AuthenticateByName` | `{Username, Pw}`（字段名**大小写不敏感**，兼容 `Password`）；请求体**认 JSON，也认 `application/x-www-form-urlencoded`**（实测 AfuseKt/3.2.0 发表单体 `Username=…&Pw=…&appName=…`，见「十」#2）；appName 取 `X-Emby-Authorization` **或** `Authorization` 头里的 `Client=`（两头都认，值**引号可省**），**头里取不到时回退 query `X-Emby-Client`**（真机同此，Filmly / 网易爆米花靠这一手，见「十」#2）；四处都取不到 appName 则 400 | 200 `{User, SessionInfo, AccessToken, ServerId}`；**缺 appName → 400 纯文本** `Value cannot be null. (Parameter 'appName')`；账号未设置或校验不过 → **401 纯文本** `无效用户名或密码。请重试。`（对齐真机，见「十、#2」） | 部署者指定（日志 #6 抓到该端点） |
| GET | `/api/emby/Users/{UserId}` | 路径参数 `UserId` | 200 `UserDto` 本体（不包层）；Id 与 token 不符 → **401**（`authorize` 先拦；同规则下 authorize 过了必命中账号，故实现里的 404 分支实际不可达）；未设账号 → 401 | 部署者指定（客户端登录后紧接着就会要）；**真机对照见「十」#9：真机按 UserId 解析、不是「只验 token」，故不适用「只验 token」的自动对齐例外；判定维持现状、不放开跨账号，见 [ADR-0048](adr/0048-emby-userid-not-identity.md)** |
| GET | `/api/emby/Users/{UserId}/Views` | 路径参数 `UserId`；客户端另带 `?IncludeExternalContent=false`（忽略） | 200 `QueryResult<BaseItemDto>`：**每个「启用」的首页插件行 = 一个库**，每项 `Id=mbphome_<base64url(插件id\|行id)>`、`Name=行标题`、`Type=CollectionFolder`、`IsFolder=true`，**其余字段按真机逐项补齐（含封面 + `CollectionType`，见「五」下面那条）**；没有启用的插件行 → 空 `{Items:[],TotalRecordCount:0}`（与留白时期形状一致）；**只验 token、不比对 UserId**（4-3 起对齐真机）；未设账号 → 401 | 部署者指定（由「留白」改为插件行的媒体库；其后补齐字段与封面） |
| GET | `/api/emby/Users/{UserId}/Items` | `ParentId=<库Id>`（面板发给客户端的 `mbphome_…`，见 Views）；**无 `ParentId` 的「轮播推荐位」**（`SortBy` 含 `IsFavoriteOrLiked`，如 Rex 首页第一发）；**无 `ParentId` 的「裸列表查询」**（只带 `ExcludeItemTypes`/`StartIndex`/`Limit`/`Fields`、不递归，如 Filmly / 网易爆米花首页）；`StartIndex`/`Limit`（**原样透传给模块**，emby 不切片）；`Filters` | 200 `QueryResult<BaseItemDto>`：`ParentId` 是本面板的库 → **跑对应插件行**、HomeItem→BaseItemDto（`TotalRecordCount` = **模块返回的 `total`**）；**「轮播推荐位」→ 跑插件声明了 `feed: 'random'` 的那一行**；**「裸列表查询」→ 回顶层库列表**（`service.libraryQueryOf()` 命中即走 `Views` 那支，与 `Views` 一字不差，对齐真机 —— 真机对「无 `ParentId` 且不递归」的 `Items` 默认回根的直接子级）；`Filters=IsPlayed` → 已看真数据（`playback` 表）；`Filters=IsFavorite` → **收藏真数据（`favorite` 表，快照重建、0 上游请求，见 [ADR-0058](adr/0058-favorite-items.md)）**；**`AnyProviderIdEquals={域}.{编号}` → 按外部 id 搜一条**（`{域}` 是元数据域 id，Emby 惯例；回 1 条带本面板 Id 的条目，见「五」）；**`SearchTerm=<词>` → 按名字搜**（上游 `search/tv`+`search/movie`，回带本面板 Id 的多条，见「五」的「搜索」那条）；其余查询 → 空；**插件行取数失败 → 照实回失败码**；**AccessToken 一律校验**（5-1 起对齐真机：无 token 一律 401 纯文本，不再分"回空/出数据"支路）；**只验 token、不比对 UserId**（5-2 起对齐真机） | 部署者指定（改为「**列表数据由首页模块决定**」，emby 层只做端点映射 + 翻译；其后接上「推荐」查询、「按名字搜」；裸列表查询经真机校正后回库列表，见 [ADR-0055](adr/0055-bare-items-query-returns-views.md)） |
| GET | `/api/emby/Users/{UserId}/Items/Latest` | 路径参数 `UserId`；`ParentId=<库Id>`；`Limit`（**缺省 20**，真机默认值）、`StartIndex`（有效）；`Fields`/`Recursive`/`MediaTypes`/`IsPlayed`/`EnableImageTypes`（忽略） | 200 **裸数组** `BaseItemDto[]`（**不是 `QueryResult`**，真机实测响应直接以 `[` 开头）：`ParentId` 是本面板的库 → **跑对应插件行**、顺序**由模块决定**（emby 层不排序、不筛"入库时间"）；`ParentId` 不是本面板的库（含不带）→ **空数组**；**插件行取数失败 → 照实回失败码**；**AccessToken 一律校验**（6-1 起对齐真机）；**只验 token、不比对 UserId**（6-2 起） | **VidHub 3.0.6 的整个首页都靠它**（实测拿到 `Views` 后逐库打，10 个库 = 10 次）；此前被详情路由吞掉 → 501 → 首页空白（其后接上） |
| GET | `/api/emby/Shows/{Id}/Seasons` | 路径参数 `Id`（形如 `{域}_95350_tv`）；**`UserId` 在 query 里**（只当进度兜底）；`Fields`/`EnableTotalRecordCount=false`（忽略） | 200 `QueryResult<BaseItemDto>`：每季 `Id={域}_{编号}_tv_s{n}`、`Type=Season`、`IndexNumber`(季号)、`SeriesId`/`SeriesName`、`ChildCount`(集数)、`UserData`（含 `UnplayedItemCount`，本季未看集数）；**特别篇（`season_number=0`）照真机返回**；非剧 Id → 404；上游失败 → **照实回失败码**；**AccessToken 一律校验**（无 token → 401 纯文本）；**只验 token、不比对 UserId**（7-2 起对齐真机） | 部署者指定（**占位**：上游的 `seasons[]`，日志 emby#3 实测该端点；7-1/7-2/7-3 已按真机对齐，**未复测**） |
| GET | `/api/emby/Shows/{Id}/Episodes` | 路径参数 `Id`（**剧 Id，或季 Id —— 见下条**）；**`UserId` 与 `SeasonId` 都在 query**；`EnableTotalRecordCount`/`Fields`（忽略） | 200 `QueryResult<BaseItemDto>`：每集 `Id={域}_{编号}_tv_s{n}_e{m}`、`Type=Episode`、`IndexNumber`(集号)、`ParentIndexNumber`(季号)、`SeriesId`/`SeriesName`/`SeasonId`/`SeasonName`、`Primary` 图=剧照、`RunTimeTicks`(有 runtime 才填)；**季定不下来（没带/认不出/不属于本剧）→ 200 空**；路径 Id 非剧 → 404；**AccessToken 一律校验**（无 token → 401 纯文本）；**只验 token、不比对 UserId**（8-2 起对齐真机）；上游失败 → **照实回失败码** | 部署者指定（**占位**：上游 season 接口，日志 emby#1 实测该端点；8-2 / 8-3 已按真机对齐，**未复测**） |
| GET | `/api/emby/Users/{UserId}/Items/Resume` | 路径参数 `UserId`；`Limit`（截断用，硬顶 100）；`MediaTypes`/`Recursive`/`Fields`/`EnableImageTypes`（忽略） | 200 `QueryResult<BaseItemDto>`：**该账号有位置、还没看完的条目**，最近看的在前（数据来自 `playback` 表，见 [ADR-0023](adr/0023-playback-progress.md)，**排除被 `HideFromResume` 隐藏的**）；取不到元数据的行**不列出**（不编）；**无 token → 401**（回的是某个账号的观看记录）；**只验 token、不比对 `UserId`**（13-1 起对齐真机 —— 观看记录按 token 解出的账号取） | 部署者指定（先是"如实回空"，后按 0023 换成真数据）；**真机对照见「十」#13：只验 token、适用自动对齐例外** |
| POST | `/api/emby/Sessions/Playing` | body JSON：`ItemId`（**本面板发出去的 Id**）、`PositionTicks`、`RunTimeTicks`（可缺）、`PlaySessionId`/`MediaSourceId`/`PlayMethod`（忽略） | **204 空体**（真机实测同为 204）；**无 token → 401**；`ItemId` 认不出（不是本面板的 Id）→ 也回 204 但**不写库**，日志写明被忽略 | 客户端上报（实测 SenPlayer 6.2.1 开始播放时发 1 次） |
| POST | `/api/emby/Sessions/Playing/Progress` | 同上（实测**每 10 秒一次**；`RunTimeTicks` 只有部分心跳带，缺了就用库里已有的顶住） | **204 空体**；其余同上 | 客户端上报（心跳；实测被 501 拒了也照发，所以必须收下） |
| POST | `/api/emby/Sessions/Playing/Stopped` | 同上（**空 body 也接受**，当空操作） | **204 空体**；位置 ≥ 时长 90% 判为看完（`played=1`、位置归零、进「已看」） | 客户端上报（实测停止/退出时发 1 次） |
| POST | `/api/emby/Users/{UserId}/PlayingItems/{ItemId}` | **Emby 旧版族**：`ItemId` 在**路径**、参数在 **query**（`PositionTicks` / `RunTimeTicks`）、**无 JSON body** | **204 空体**（与新版族同一落库）；**无 token → 401**；`ItemId` 认不出 → 204 **不写库** | 客户端上报（实测 **HamHub Android/1.0.0** 用的是这一族，见「十」#22） |
| POST | `/api/emby/Users/{UserId}/PlayingItems/{ItemId}/Progress` | 同上（旧版族心跳，参数在 query） | 同上（**204 空体**） | 客户端上报（同上） |
| DELETE | `/api/emby/Users/{UserId}/PlayingItems/{ItemId}` | 同上（旧版族停止，参数在 query） | 同上（**204 空体**；**空 query 也接受**，当空操作） | 客户端上报（同上） |
| POST | `/api/emby/Users/{UserId}/Items/{ItemId}/HideFromResume` | 路径参数 `ItemId`（**本面板发出去的 Id**）；query `Hide=true`（移除）/ `Hide=false`（恢复）—— **缺省当 `true`** | 200 **`UserItemDataDto`**（真机实测同此，`UserData` 一个字段都不动）；本层只翻 `playback.hidden`，**不动位置**（`Hide=false` 之后位置还在）；**重新开始播放会自动取消隐藏**；库里**没有这一行**时：隐藏 → 写一行**占位**（位置 0，记下来才不会「移除了还在」）、恢复 → 不动库；**无 token → 401** | 客户端写（实测 Rex/0.1.0 / SenPlayer/6.2.1：在「继续观看 / 接着看」那一行上做移除） |
| POST | `/api/emby/Users/{UserId}/PlayedItems/{ItemId}` | 路径参数 `ItemId`（**本面板发出去的 Id**） | 200 **`UserItemDataDto`**（`Played:true`、位置归零，**`PlayCount` 不动** —— 真机实测同此）；**无 token → 401**；Id 认不出 → 204 且不写库 | 客户端写（实测 SenPlayer/6.2.1：标记已看） |
| DELETE | `/api/emby/Users/{UserId}/PlayedItems/{ItemId}` | 同上 | 200 **`UserItemDataDto`**（`Played:false`、`PlayCount:0`、位置归零，真机实测同此 —— 它还会去掉 `LastPlayedDate`）—— 行**留着**（重看时不必重新攒；时长与季集坐标随行保留） | 客户端写（同客户端：标记未看） |
| POST | `/api/emby/Users/{UserId}/FavoriteItems/{ItemId}` | 路径参数 `ItemId`（**本面板发出去的 Id**，放宽到 `movie`/`show`/`season`/`episode`） | 200 **`UserItemDataDto`**（`IsFavorite:true`，真机实测同此）；**收藏时反查元数据、快照落 `favorite` 表**（见 [ADR-0058](adr/0058-favorite-items.md)）；**无 token → 401**；Id 认不出 / 反查失败 → 204 且**不写库** | 客户端写（实测 Rex/1.0.0 收藏）；**真机对照见「十」#21：四类条目均 200、写端点 200 + `UserItemDataDto`** |
| DELETE | `/api/emby/Users/{UserId}/FavoriteItems/{ItemId}` | 同上 | 200 **`UserItemDataDto`**（`IsFavorite:false`，真机实测同此）；**取消收藏 = 删 `favorite` 行**（不反查）；**无 token → 401**；Id 认不出 → 204 且不写库 | 客户端写（同客户端：取消收藏） |
| GET | `/api/emby/Users/{UserId}/Items/{ItemId}` | 路径参数 `ItemId`（面板发出去的条目 Id：`{域}_{编号}_{tv\|movie}[_s{n}][_e{m}]`）；`EnableImageTypes`/`Fields`（忽略） | 200 **单个 `BaseItemDto` 本体**（不包 `QueryResult`）：上游元数据 + `ProviderIds.MediaBridge="<站点key>\|<vod_id>"` + `MediaBridgeSource{Lines, Target}` + **集才有 `MediaSources`（线路=版本，`Id` = `mbp:` + base64url(deflateRaw(JSON `{r: ref}`))，`Path` 留到 PlaybackInfo 现取）**；**聚合取数失败只降级不回失败**（元数据照常 200）；Id 认不出 → **501**（如 `Items/ResumeXyz`）；上游失败 → 照实回失败码；**AccessToken 校验**（无 token → 401 纯文本）；**只验 token、不比对 UserId**（10-1 起对齐真机 —— 真机对「不存在的 ItemId」「非 Guid 的 UserId」回 500 误码，本面板**不复刻**，照常按 Id 是否认得出给 501 / 200）；未设账号 → 401 | 部署者指定（**元数据走上游 + 线路/绑定走设置里的聚合地址**）；**真机对照见「十」#10：详情只验 token、适用自动对齐例外** |
| GET | `/api/emby/Studios` | 无路径参数；query `UserId`/`Limit`/`StartIndex`/`SearchTerm`/`Fields`（**全忽略**） | 200 **空** `QueryResult`：`{Items:[], TotalRecordCount:0}`（**如实**：服务端没有片库可枚举，详见「五」下面那条）；**只验 token**（14-1 起对齐真机：无 token / 无效 token → **401 纯文本**；回空也照样校验） | 部署者指定（**回空，不是 501**）；**真机对照见「十」#14：回空不复刻真机全量清单、鉴权对齐「只验 token」** |
| GET | `/api/emby/Shows/NextUp` | `UserId`（在 **query**）、`SeriesId`（可选 —— SenPlayer 实测会带，只问某一部剧）、`Limit`（截断用）；`MediaTypes`/`Recursive`/`Fields`/`EnableImageTypes`（忽略） | 200 `QueryResult<BaseItemDto>`：**恒为空**（`{Items:[], TotalRecordCount:0}`）—— **端点保留、对外恒空**，只为藏掉首页那行「接下来看」（它与「继续观看」重复），算「该看哪一集」的实现留着但**暂不调用**，见 [ADR-0060](adr/0060-nextup-hidden.md)；**只验 token、不比对 UserId**（无 token → 401 纯文本；有效 token + 错配 / 不存在的 UserId 照旧 200） | 部署者指定（SenPlayer 实测在要）；**真机对照见「十」#15：只验 token、适用自动对齐例外**；"出真数据"的旧口径见 [ADR-0023](adr/0023-playback-progress.md)（该格已被 0060 取代） |
| GET | `/api/emby/Items/Counts` | 全部忽略（含 `ParentId`） | 200 **`ItemCounts` 全 0**（14 个字段：`MovieCount`/`SeriesCount`/`EpisodeCount`/`GameCount`/`ArtistCount`/`ProgramCount`/`GameSystemCount`/`TrailerCount`/`SongCount`/`AlbumCount`/`MusicVideoCount`/`BoxSetCount`/`BookCount`/`ItemCount`）；**只验 token、不比对 UserId**（16-1 起对齐真机：无 token / 无效 token → 401 纯文本；有效 token + 任意 UserId → 200）。**全 0 = "数不出来"，不是"库是空的"** —— 详见「五」下面那条 | 部署者指定（SenPlayer 实测在要）；**真机对照见「十」#16：回全 0 不复刻真机真实计数、鉴权对齐「只验 token」** |
| POST | `/api/emby/Items/{ItemId}/PlaybackInfo` | 路径参数 `ItemId`（**必须是集或电影**）；`UserId` 在 query（可缺；**只验 token、不比对 UserId**，11-1 起对齐真机 —— 无 / 无效 token → 401 纯文本；有效 token + 错配 / 不存在 / 不带 UserId 照旧 200） | 200 `{MediaSources:[…], PlaySessionId}`：每条线路一个版本，`Id` = `mbp:` + base64url(deflateRaw(JSON `{r: ref}`))（客户端播直连时回传的 `MediaSourceId` 就是它 —— **vod 编在里面**，拉流那一格才不用回头再搜一次；**为什么必须编码**见下面「线路 + 源绑定」那条，一句话：线路名里的 `#` 会被 URL 当锚点吃掉）、**`Path` 指向本面板的 Stream 端点**（稳定坐标，不含时效 token；实测客户端**不读它**，走 `videos/{Id}/stream.{ext}`）、`RequiredHttpHeaders:{}`、**`Container`/`Size`/`RunTimeTicks`/`MediaStreams`（编码/分辨率/HDR，来自源在集名里的标注）**；Id 不是集 → 404；上游 / 聚合失败 → 照实回 | 部署者指定（客户端点播放前必来） |
| GET | `/api/emby/Items/{ItemId}/Stream` | 两种形状：**① `Path` 用的** `/Stream/{token}[/{文件名}]`（`token` = base64url 的版本 Id，自带站点/线路/vod；末段文件名（标准文件名）只为版本行副标题）；**② 手工调试** `?src=<版本 Id>`（`parseMbpSourceId()` 只认当前那一种形状 —— 见下面「版本 Id 只认一种形状」）、`vod` 可缺（src 里自带就用自带的）。两种都可带 `UserId`（**只验 token、不比对 UserId**，12-1 起对齐真机 —— 无 / 无效 token → 401 纯文本；有效 token + 错配 / 不存在 / 非 Guid 的 UserId 照样出字节） | **一律 302**（"面板代为转发"那条路已删，见下面「拉流」一节）；`src` 认不出 → 400、两个来源都没有 vod → 400；Id 非集 / 定位不到这一集 → 404；聚合或 play 失败 → 502（照搬上游码）；`push://` 之类非直连 → 501 | 部署者指定（拉流最后一格；**实测客户端走的是下一行那条**，这条留作备用/调试） |
| GET | `/api/emby/videos|Videos/{ItemId}/stream[.{扩展名}]` | 路径参数 `ItemId`（集/电影）；**`MediaSourceId=<版本 Id>`（必填，base64url 的 Id，vod 编在里面）**、`Static=true`/`PlaySessionId`（忽略）；**token 三种带法都认**（头 `X-Emby-Token` / 头 `X-Emby-Authorization` 里的 `Token="…"` / query `api_key` **或** `X-Emby-Token` —— 见 [ADR-0009](adr/0009-unauthenticated-empty-responses.md) 与「十」#12 的 12-5）；面板自己发出去的 `DirectStreamUrl` / `Path` 带的是 query 的 **`api_key`**（真机也有 `AddApiKeyToDirectStreamUrl` 这个取向）—— 客户端改写成 query `X-Emby-Token` 现在也认（此前只认头 ⇒ 会 401）；扩展名来自 `MediaSource.Container`（实测客户端自拼 `stream.mkv`）—— ⚠️ **带后缀的是客户端按此规则自拼的请求**；**面板自己下发的 `DirectStreamUrl` 已改为裸 `stream`、不带后缀**（见「十」#11 的 11-5），本条路由对裸 `stream` 与 `stream.{ext}` 一并认 | 与上一行**同一条实现**（路由层共用 `serveStream`）：**一律 302**；`MediaSourceId` 认不出 → 400；`:file` 不是 `stream[.ext]` → **501**（记日志，`original.{ext}` 未见过不提前实现） | **实测要求**（日志 emby#39~#45：客户端播直连打的是**这条**，不是 `Path`）。**大小写两种都认**：Emby 官方路径是**大写** `Videos`，实测 Lumenic/1.0.0 打的是大写；路由字面段**大小写不敏感**（见契约变更记录），故一条注册认下 `videos` / `Videos` 两种写法。**另：实例端口对「根路径」兜底** —— 不带 `/emby` / `/api/emby` 前缀的 `/videos/{ItemId}/stream[.{ext}]`（以及 `/Items/…`、`/Videos/…` 等同族根路径）在实例端口也一并收下（对齐真机、兼容 HamHub/1.0，见契约变更记录与「十」#12 的 12-6） |
| GET | `/api/emby/Items/{ItemId}/Download` | 路径参数 `ItemId`（集/电影）；**`MediaSourceId=<版本 Id>`（必填，base64url 的 Id，vod 编在里面）**、`DeviceId`/`PlaySessionId`（忽略）；`UserId` 可选（**只验 token、不比对 UserId**，12-1 起对齐真机），token 三种带法都认 | **一律 302**（与拉流**同一条实现** —— 路由层共用 `serveStream`，只是日志那行写「下载」）；`MediaSourceId` 认不出 → 400；Id 非集 / 定位不到这一集 → 404；聚合或 play 失败 → 502（照搬上游码）。⚠️ 302 之后 `Content-Disposition`（文件名）/`Content-Type`/断点续传**全由源站决定**，面板改不了 —— 要「片名.S01E01.mkv」那种名字只能代为转发全量字节，与 [ADR-0006](adr/0006-redirect-for-playback.md)「面板不扛流量」冲突，故不做 | 客户端实测（SenPlayer/6.2.1 12 小时里试 8 次、每次吃 501 → 一直重试）。同族的 `Items/{ItemId}/File` 日志里**没出现过**，按"等客户端日志暴露再接线"**先不做** |
| GET | `/api/emby/Items/{ItemId}/Images/{type}[/{index}]` | 路径参数 `ItemId`（面板发出去的条目 Id）、`type`（`Primary`/`Backdrop`/`Logo`…）、`index`（多张背景图时客户端逐张要；**忽略**）；query `tag`（**本面板签发的签名 tag —— 本侧的唯一取图凭证**）、`maxWidth`/`quality`/`ImageTypeLimit`（忽略） | **302 到原图**（面板**不再代取字节**，`Location` = tag / 索引里的图片 URL，见 [ADR-0036](adr/0036-image-endpoint-redirect.md)）；`tag` 缺失/验签不过 → **404**。**豁免 AccessToken**；tag = `cpimg.<base64url(图片URL)>.<签名>`。官方把 `Tag` 定义为**可选**（只影响缓存强弱），但直链只存在于 tag 里，故**认不出即 404**；按 `Id` 反查上游的兜底**已拆除**（见下「图片」那条） | **实测要求**（客户端点开条目后随即请求 `Images/Primary` / `Images/Backdrop`，且**不带任何凭证**；`/index` 形状随多张背景图一并加上）；**真机对照见「十」#18：予初Emby / nyamedia / OkEmby 的图片端点不校验 token（无 / 无效 token 照样 200 出图），itsmygo 校验 token（401 JSON）；四台都把 `tag` 当可选缓存键、都忽略 `/index`；`maxWidth`（按宽等比缩放）予初Emby / nyamedia / OkEmby 响应、itsmygo 忽略，面板亦忽略（302 原图、不代取不缩放 → **有意偏离**，见 18-7）。面板维持「豁免 AccessToken + 认签名 tag」，与客户端取图不带凭证的现实一致（见 [ADR-0036](adr/0036-image-endpoint-redirect.md)）** |
| GET | `/api/emby/Items/{ItemId}/Similar` | 路径参数 `ItemId`（面板发出去的条目 Id）；`UserId` 在 query（**只验 token、不比对 UserId**，17-1 起对齐真机 —— 无 / 无效 token → 401 纯文本；有效 token + 错配 / 不存在 / 不带 UserId 照旧 200）、`Limit`（切前 N 条）、`Fields`（忽略） | 200 `QueryResult<BaseItemDto>`：**上游的相似推荐**（`recommendations`，与详情**同一次请求**就拿到），`{Items, TotalRecordCount}`；Id 认不出 → 404；上游失败 → 照实回失败码。**响应形状经真机实测复核、一致 ✓**（真机确为 `{Items, TotalRecordCount}`） | 部署者指定（**归 emby 层** —— 按坐标反查上游，与季/集同类；不是"有什么"，所以不走首页模块） |
| GET | `/api/emby/Users/{UserId}/Images/{type}` | 路径参数 `UserId`、`type`（任意） | **200 `image/png`**：回品牌图标 `assets/default-avatar.png`（606×606 透明底，所有用户共用一张）；文件缺失才 404。**豁免 AccessToken**。tag = 文件内容 md5（见「十、#2」2-5） | 部署者指定（真机回用户设置的头像；面板用品牌图标统一代替，UserDto 给的 `PrimaryImageTag` 与之同源） |
| GET | `/api/emby/Videos|videos/{ItemId}/{MediaSourceId}/Subtitles/{Index}/Stream.{Format}` | 路径参数 `ItemId`（集/电影）、`MediaSourceId`（**版本 Id**，`mbp:` + base64url(deflateRaw(JSON))，**载荷含 `s` 字段承载「流序号 → 字幕 `ref`」的映射**）、`Index`（`MediaStreams[]` 里该字幕流的 `Index`）、`Format`（`srt`/`ass`/`ssa`/`vtt`，大小写不敏感）；`UserId` 可带（**只验 token、不比对 UserId**，与拉流同口径）；另有带起播位置的官方变体 `…/{Index}/{StartPositionTicks}/Stream.{Format}`（`StartPositionTicks` **忽略**） | **200 `text/*`**：解出 `s[Index]` 得 `ref` → 按第一段路由到字幕插件 → 调 `fetch({ ref })` → 回插件给的 `body`（`Content-Type` 优先取插件 `contentType`，否则按 `Format` 落：`srt→application/x-subrip` / `ass`/`ssa→text/x-ssa` / `vtt→text/vtt`，均加 `; charset=utf-8`）；`{Index}` 认不出 → **404**；版本 Id 认不出 → **400**；Id 非集/电影 → **404**；插件取内容失败 → **照实回失败码**（`metaBridge.httpStatusOf`：插件没在跑 / 没这个动作 → 503、超时 → 504、其余 → 502） | 字幕插件落地（**新增**：Emby 标准外挂字幕取用形状；此前落到通配 → 501）。**真机对照见「十」#23：无真机样本、未复测** |

**实现约定**

- **账号来源（多账号）**：面板「Emby → 账号」页（先选实例，账号按实例分）→ `data/emby/emby.db` 或 `data/emby/instances/<id>/emby.db`（Node 内置 sqlite，见 `db.js`）。
  - **可以有多个客户端登录账号**，各自派生一个独立的 `User.Id`；账号表为空时登录一律 401，并在响应与日志里提示先去添加
  - 用户名比较：`NFKC` 归一 + 忽略大小写（**登录、查重、UserId 派生三处必须同一套规则**，否则会出现「登录成功但取资料 404」）
  - 密码存 **scrypt 哈希**（`scrypt$N$r$p$klen$salt$hash`，参数自描述便于以后换算法）；**忘了只能删掉重建**，库里没有明文
  - 老的单账号（`settings/emby.json` 的 `account.{username,password}` 明文）在首次用到库时自动迁移成第一条账号，**并把设置里的明文清空**（清空是无条件的：只靠"表为空才导入"会漏 —— 从旧备份还原出带明文的设置时会跳过导入、明文却留着）
  - 面板自用端点：`GET/POST /api/emby/accounts`、`PUT/DELETE /api/emby/accounts/{id}`（见「五」末尾的表）
- **服务器 Id**：首次握手时生成一次并写入设置（`serverId`），保证客户端缓存的服务器身份稳定；`User.Id` 由「serverId + 用户名」派生（**多账号下规则不变**）。
  - 推论：**改用户名或删账号 = 那个账号的 `User.Id` 变了 → 该客户端必须退出重登**（面板上有提示）
- **UserDto 复用**：登录响应里的 `User` 与 `GET /Users/{id}` 返回的是同一个对象（同一个 `buildUser`），避免两处字段不一致。
- **取用户资料的分支**：按 `Id` 反解账号（**不存 user_id 列，运行时现算**：serverId 一变库里那列就全废，现算永远自洽）—— 解析不出时，账号表为空 401、否则 404（不是 403）。
- **媒体库（`Users/{UserId}/Views`）—— 不再是留白**：把**每个「启用」的首页插件行**做成一个 Emby 媒体库（`Type: CollectionFolder`），客户端据此在首页列出这些库。数据取自插件 `registry` 的**快照**（不加载插件代码、不起沙箱 —— Views 是高频端点）。
  - **Id = `mbphome_` + base64url(`<插件id>|<行id>`）**：插件 id 与行 id 都允许 `.`/`_`/`-`，用分隔符硬拼没法可靠反解，所以**整体编码**；base64url 字符集只有 `[A-Za-z0-9_-]`，URL 安全（不会像 `#` 那样被客户端当锚点吃掉 —— 同 `mbpSourceId` 那次的问题）。派生与解析是一对（`home.viewId` / `home.parseViewId`），**代码里挨着放**。
  - **与 `{域}_*` 不冲突**：`metaBridge.parseItemId()` 认不出 `mbphome_*`，所以这类 Id 只属于 Views。
  - **库条目的字段（按真机逐字段补齐）**：真机 25 个库的响应逐项对过，现在两边字段**一一对应**。取值来源如下，**推不出来的一律不填**：

    | 字段 | 本面板给什么 | 依据 |
    |---|---|---|
    | `Guid` / `PresentationUniqueKey` / `DisplayPreferencesId` | `md5('view|'+库Id)` | 真机 25/25 里这三个是**同一个 GUID**；本面板的库 Id 不是 GUID 形状，派生一个**稳定**的 |
    | `Etag` | `md5(库Id\|库名\|封面URL)` | 真机是库内容指纹；本面板的"库"就是这一行 |
    | `DateCreated` | **占位值** `0001-01-01T00:00:00.0000000Z`（与下一行同一个，Emby 自己的零值） | 真机是库创建时间，本面板既没有"建库"动作、上游里也没有"这一行"这个实体 —— 拿不到任何真实时间。**改法**：原先用"库首次出现在响应里的时刻"（`view_seen` 表）近似，但那是个**不可再生**的值（表一丢所有库就"全新建了"），为它维护一张表代价过高；既定口径是"给个一看就知道是占位的值"。⚠️ 必须是**合法时间**：`0000-00-00` 那种非法日期会让客户端的 DateTime 解析整条失败 |
    | `DateModified` | `0001-01-01T00:00:00.0000000Z` | 真机 25/25 **全是**这个零值（Emby 的"从未修改"），照给同一个值 |
    | `CanDelete` / `CanDownload` | `false` | 真值 |
    | `SortName` / `ForcedSortName` | 库名 | 真机也是名字 |
    | `ExternalUrls` / `Taglines` / `RemoteTrailers` | `[]` | 真机 25/25 就是空 |
    | `ProviderIds` | `{}` | 同上 |
    | `BackdropImageTags` | `[]` | 真机**有封面的库**这里也是 `[]`（封面只在 `ImageTags.Primary`） |
    | `LockedFields` / `LockData` | `[]` / `false` | 真值 |
    | `CollectionType` | 行声明（`movies`/`tvshows`/`mixed`）→ 按该行 `type` 参数推 → `mixed` | 真机每个库都有；见首页插件指南的 `collectionType` |
    | `ImageTags.Primary` + `PrimaryImageAspectRatio` | 封面见下；**没有就都不给**（`ImageTags: {}`、不给 ratio） | 真机无图的库正是这个形状 |
    | `UserData` | `{PlaybackPositionTicks, IsFavorite, Played}` | 真机库条目就是这三个（比普通条目**少** `PlayCount`） |
    | `ChildCount` | **行申报的库总数优先** → 该行被取过内容后记下的数 → 占位 `1` | 真机 12/12 都有（样本全 `1`，客户端拿它判断空库/画角标）。三级取数：① 行在 `rows` 里**申报的 `total`**（客户端还没点开库就有真数，见首页插件指南的 `rows.total`，[ADR-0051](adr/0051-home-row-declared-total.md)）→ ② 面板内存里 `peekRowTotal` 记下的插件申报总数 → ③ 都拿不到回退 `1`（不取 0：0 会被客户端当空库）。**不为此打上游** |
    | `ParentId` | **不给** | 真机 25/25 都是 `"2"`（服务器根节点），本面板没有那个节点 —— 给了就是指向不存在的东西 |
  - **库封面**：封面用的是**该行里第一个带横图（`backdrop`）的条目** —— 那是上游顺路带回来的数据，**为零个额外上游请求**。
    - 两条取值路：① 图片索引（持久，默认 90 天，重启后仍在）→ ② 该行的**内存结果缓存**（客户端逛过一次就有）。两条路都**只在本地读**；**绝不为了封面单独打上游**（代价随库数线性增长）。
    - 只用**横图**，所以 `PrimaryImageAspectRatio` 恒为 `1.7777777777777777`（真机库封面基本 16:9）；竖图海报硬当库封面会变形，宁可不给。
    - **冷启动**（面板刚重启、客户端还没逛过）那一轮就是**没有封面**——如实，不编。（`peekRowItems` 只读缓存，不触发上游。）
  - **行内容**：客户端为某个库去要条目时打 `Items?ParentId=<库Id>`（见「五」），由 `home.listByQuery` 路由到那一行。
  - 停用/启用的插件行即时生效（Views 每次现读 registry），客户端可能要**重启或清缓存**才会刷新库列表。
- **AccessToken 校验（已实现）**：登录发的 token 落 `data/emby/emby.db` 的 `sessions` 表，之后每个受保护端点都校验它 —— **没有"宽松/严格"之分，校验就是校验**（拿不到有效 token 一律 401，与官方对 401 的定义一致：token 无效或被吊销，客户端应回登录界面）。
  - **token 就是「登录」本身**：它是登录成功后服务端签发的凭据，**指认这条凭据属于哪个账号**；后续请求的**鉴权身份以 token 为准**。请求里的 `UserId` 只是客户端按惯例带上的参数，**不是身份来源**。
  - **三种带法都认**（`service.tokenFrom`）：头 `X-Emby-Token`（官方文档写明的标准带法）、`X-Emby-Authorization` / `Authorization` 里的 `Token=…`（**值引号可省**，真机同此，见「十、#2」）、query `api_key=`（官方把它归为 API Key 认证，可实测客户端把**用户 token** 也塞在这个槽里拉流）
  - **保护范围**：`Users/{id}` / `Views` / `Items` / `Items/Latest` / `Items/{id}`（详情）/ `Shows/*/Seasons` / `Shows/*/Episodes` / `PlaybackInfo` / `Stream`×2 / `videos/*` / `Items/{id}/Download` / 继续观看 `Items/Resume` / 接下来看 `Shows/NextUp` / 相似推荐 `Items/{ItemId}/Similar` / 工作室 `Studios` / 条目计数 `Items/Counts` / 服务器信息 `System/Info`，共 18 条。
  - ⚠️ **`UserId` 不参与鉴权（契约变更，见下面的变更记录）**：**读取类**端点（`Views` / `Items` / `Items/Latest` / `Shows/*/Seasons` / `Shows/*/Episodes` / 条目详情 `Users/{UserId}/Items/{ItemId}` / 播放信息 `Items/{ItemId}/PlaybackInfo` / 继续观看 `Users/{UserId}/Items/Resume` / 接下来看 `Shows/NextUp` / 相似推荐 `Items/{ItemId}/Similar` / 工作室 `Studios` / 条目计数 `Items/Counts` / 服务器信息 `System/Info` / 直连拉流 `videos/{ItemId}/{file}`、`Items/{ItemId}/Stream/{token}` / 下载 `Items/{ItemId}/Download`）**只验 token、不比对 UserId** —— 带了 `UserId` 也**不再要求它属于该 token 账号**。用户私有数据（观看进度）**一律按 token 解出的账号算**（`accountIdFor`：token 优先、`UserId` 兜底）。
  - **豁免**：握手 `System/Info/Public`、登录 `AuthenticateByName`、面板自用端点（账号管理、元数据插件测试）、以及 **501 通配**。**图片端点也必须豁免**：实测**图片请求的凭证携带并不统一** —— 同一批 8 条 `Items/{id}/Images/*` 里，5 条带 `x-emby-authorization`（Rex-Standard），**3 条什么凭证都不带**（原生 `Rex/13 CFNetwork` 客户端，头里只有 `accept`/`user-agent`）。要求 token 会让那部分客户端图全挂。（对照：**非图片请求 9/9 都带 `x-emby-token`**。）
  - **生命周期**：改密或删账号 → 该账号的所有 token 一并作废（客户端需重新登录）；`last_seen_at` 每次请求更新（60 秒节流，拉流时不会每个 Range 都写库）
  - **还没做**：官方登出端点 `POST /Sessions/Logout`（客户端"退出登录"目前打到 501 通配，token 不会被吊销）、`/Users/Public`（登录界面取用户列表）
  - **换新号/重登**：校验上线**之前**发出的 token 不在表里 → 客户端会被一路 401，**在客户端退出重登一次**即可（`sessions` 表里就有了）

> ⚠️ **契约变更记录（不许默不作声）**：把 `UserId` 从"**必须属于该 token 的账号，否则 401**"改为"**读取类端点只当参数、不参与鉴权**"。
> - **改的是什么**：鉴权身份**收敛到 token 一处**；`UserId` 不再是身份来源（真机同样如此 —— 有效 token + 合法但不存在的 UserId → 200）。
> - **影响端点**：`Views`（#4-3）/ `Users/{UserId}/Items`（#5-2）/ `Items/Latest`（#6-2）/ `Shows/{Id}/Seasons`（#7-2）/ `Shows/{Id}/Episodes`（#8-2）/ 条目详情 `Users/{UserId}/Items/{ItemId}`（#10-1）/ 播放信息 `Items/{ItemId}/PlaybackInfo`（#11-1）/ 直连拉流 `videos/{ItemId}/{file}`（#12-1）/ 拉流 `Items/{ItemId}/Stream/{token}`（#12-1）/ 下载 `Items/{ItemId}/Download`（#12-1）/ 继续观看 `Users/{UserId}/Items/Resume`（#13-1）/ 接下来看 `Shows/NextUp`（#15-1）/ 相似推荐 `Items/{ItemId}/Similar`（#17-1）。这 13 条由「有效 token + 不匹配/不存在的 UserId → 401 / 404」变为「**→ 200 / 出字节**」。
> - **影响方向**：**更宽容**（客户端换号 / 重登后手上带着旧 `UserId` 也能正常出数据）。**客户端无需改动** —— 它本就是照真机行为写的。
> - **安全**：**不引入跨账号泄露** —— 内容数据（库 / 季 / 集 / 条目详情）与拉流 / 下载取的**内容字节**都与用户无关；用户私有进度按 **token 的账号**取（`accountIdFor` token 优先），传别人的 `UserId` 也只看得到自己 token 账号的进度。
> - **尚未放宽（仍是旧口径）**：写用户数据的 `PlayedItems` / `HideFromResume` 等 —— 它们**仍比对 `UserId`**。这些**留待各自的真机对照**逐条定，不一次性全放。**未对齐期间"两条口径并存"是已知状态，不是遗漏。**
>   - `Users/{UserId}`（#9 已对照）：真机**按路径 UserId 解析用户、与 token 无关**（不是「只验 token」），**不适用自动对齐例外**；判定**维持现状、不放开跨账号**（见 [ADR-0048](adr/0048-emby-userid-not-identity.md)）。不匹配一律 **401**（不用 404，防账号枚举）。
>   - 条目详情 `Users/{UserId}/Items/{ItemId}`（#10-1 已对照）：真机**只验 token、不比对 UserId**（有效 token + 合法但不存在的 UserId → 200），**适用自动对齐例外、已对齐**；真机对「不存在的 ItemId」「非 Guid 的 UserId」回 500 误码（`NullReferenceException` / `Guid 解析失败`），本面板**不复刻**。逐条见「十、#10」。
>   - 播放信息 `Items/{ItemId}/PlaybackInfo`（#11-1 已对照）：虽为 POST，但本端点只**返回版本清单**、不写用户私有数据（进度、播放位置都不在这里落库），**内容是内容数据、与用户无关**；真机**只验 token、不比对 UserId**（有效 token + 任意 UserId → 200），**适用自动对齐例外、已对齐**。逐条见「十、#11」。
>   - 直连拉流 `videos/{ItemId}/{file}`、拉流 `Items/{ItemId}/Stream/{token}`、下载 `Items/{ItemId}/Download`（#12-1 已对照）：端点是**取内容字节**（与用户无关、不写用户私有数据）；真机**只验 token、不比对 UserId**（有效 token + 不存在 / 非 Guid 的 UserId → 照样 307 / 206 出字节），**适用自动对齐例外、已对齐** —— 路由 `authorize(req, userIdOf(query))` → `authorize(req)`，`service.resolveStream` 去掉 `assertUser(requestedId)`。逐条见「十、#12」。
>   - 继续观看 `Users/{UserId}/Items/Resume`（#13-1 已对照）：端点是**读 token 账号的观看记录**（用户私有进度，`accountIdFor` token 优先 —— 传别人的 `UserId` 也只看到自己 token 账号的记录）；真机**只验 token、不比对 UserId**（有效 token + 全 0 guid UserId → 200，两台；第三台 nyamedia 回 500 空指针误码，属真机自身 bug、不复刻），**适用自动对齐例外、已对齐** —— `service.getResume` 的 `authorize(req, requestedId)` → `authorize(req)`。逐条见「十、#13」。
>   - 接下来看 `Shows/NextUp`（#15-1 已对照）：端点是**按 token 账号的观看进度算下一集**（用户私有进度，`accountIdFor` token 优先 —— 传别人的 `UserId` 也只看到自己 token 账号的进度）；真机**只验 token、不比对 UserId**（有效 token + 全 0 guid / 随机 guid / 不带 UserId → 一律 200 回空，两台实测），**适用自动对齐例外、已对齐** —— `service.getNextUp` 的 `authorize(req, requestedId)` → `authorize(req)`。逐条见「十」#15。
>   - 相似推荐 `Items/{ItemId}/Similar`（#17-1 已对照）：端点是**按条目坐标去上游反查关联内容**（内容数据、与具体用户无关；进度由 `applyUserData` 按 token 账号补）；真机**只验 token、不比对 UserId**（有效 token + 全 0 guid / 随机 guid / 不带 UserId → 均 200，予初Emby / OkEmby 实测；nyamedia 对不可解析的 UserId 回 500 空指针误码、属真机自身 bug），**适用自动对齐例外、已对齐** —— 路由 `authorize(req, userIdOf(query))` → `authorize(req)`，`service.getSimilar` 去掉 `assertUser(requestedId)`（连带去掉其第二参）。逐条见「十」#17。
> - **同轮还有「下载能力」契约变更（一并声明，产品取向、非鉴权）**：新增 Emby **实例级「下载」开关**（`instances.json` 的 `allowDownload`，**默认开**，与 `enabled` 同类）。
>   - **改的是什么**：`Policy.EnableContentDownloading` 由**写死 `false`**（#9 时对齐真机）改为**跟随实例开关**（默认开 → 回 `true`）；条目级 `CanDownload` 同样跟随（默认 `true`）；`Items/{ItemId}/Download` 端点**新增门禁** —— 开关关闭时回 **403 纯文本** `Downloading is disabled on this server.`（此前恒放行）。三处**同一口径**（握手/条目/端点）。
>   - **影响端点**：`Users/AuthenticateByName` + `Users/{UserId}`（`Policy.EnableContentDownloading` 取值随开关变）/ `Users/{UserId}/Items`、`Items/Latest`、详情（条目 `CanDownload` 随开关变）/ `Items/{ItemId}/Download`（关闭时 403）。
>   - **影响方向**：**默认行为不变**（默认开 = 一直以来的「能下载」）；只在**部署者主动关闭**后，下载能力对客户端整体消失（三处一致，客户端不再显示下载入口，且直接请求下载端点也拿到 403）。**客户端无需改动**。
>   - **与真机的关系**：真机样本（OkEmby / nyamedia）`EnableContentDownloading` 与 `CanDownload` **同为 `false`** —— 那是**那台服务器的配置**，不是协议形状。本面板把它做成**部署者可配**、默认开（偏离真机样本，属有意产品取舍，理由见 [ADR-0049](adr/0049-emby-instance-download-switch.md)），逐条见「十、#10」的 10-3。
> - **同轮还有「条目级分辨率」契约变更（新增字段）**：详情条目顶层**新增 `Width` / `Height`**（取所选线路视频流的分辨率，数据源是**片源插件申报的 `width`/`height`**）—— 对齐真机条目级分辨率（真机 `3840`×`2160`）。**插件没给就没有这俩字段**（不反推、不编）。对客户端是**新增字段**。逐字段见「十、#10」的 10-3。
> - **同轮还有「库总数」契约变更（新增字段取值，一并声明）**：`Views` 里库条目的 **`ChildCount` 由"点开过才有真数、否则占位 1"改为"行可申报库总数"**。
>   - **改的是什么**：首页插件契约新增**可选**行申报字段 `total`（口径同 `run` 的 `total` = 这个库有多大），面板的 `ChildCount` 取数变为「**行申报 `total` → `peekRowTotal` → 占位 1**」三级。插件取不到就**不申报**（回退占位 1，不编数，见 [ADR-0008](adr/0008-no-fabricated-data.md) / [ADR-0051](adr/0051-home-row-declared-total.md)）。
>   - **影响端点**：`GET /api/emby/Users/{UserId}/Views`（库条目 `ChildCount` 取值）。
>   - **影响方向**：对客户端是**新可见值** —— 命中行申报的库，`ChildCount` 从**占位 1** 变为**该库真实总数**；未申报 / 取不到的库仍为 1，行为不变。**客户端无需改动**（它本就按真机语义读这个字段）。
>   - **未涉及**：`Views` 的其它字段不变；本变更**不含**服务端级 `GET /Items/Counts`。
>   - **插件侧**：契约正文在**另一仓库** [media-bridge-plugins](https://github.com/dlushu/media-bridge-plugins) 的 `docs/emby-home-plugin.md` 与 `docs/plugin-contract.md`（本仓库不复制）。TMDB 首页插件已按此申报（抓官网 About 页全库规模）。
> - **同轮还有「`Items/Counts` 填库总数」契约变更（一并声明）**：`GET /Items/Counts` 的 **`MovieCount` / `SeriesCount` 由恒回 0 改为"取首页插件申报的库总数"**（数据源与上一条的 `ChildCount` 同一条 `rows.total`，见 [ADR-0052](adr/0052-items-counts-library-total.md)）。此前「`Items/Counts` 恒回全 0」的取向**作废**。
>   - **改的是什么**：电影 / 剧集两类各自取当前实例首页插件行申报的 `total`，按库类型归并 —— 同类型多行**取最大值**（每行报的都是**整个库的规模**，相加等于重复计数），`mixed` 行说不清是哪种、**不参与**。其余 12 个字段**仍回 0**（面板没有片库索引、数不出来；**0 = 数不出来，不是库空**）。
>   - **影响端点**：仅 `GET /api/emby/Items/Counts`。参数（`ParentId` 等）仍全忽略：这个端点回的是实例级总数。
>   - **影响方向**：对客户端是**新可见值** —— 插件申报了该类型库规模的实例，该字段由 0 变为真实总数；没申报 / 取不到的仍是 0，行为不变。**客户端无需改动**（它本就按真机语义读）。
> - **同轮还有「`Items/Counts` 填集数」契约变更（一并声明）**：`GET /Items/Counts` 的 **`EpisodeCount` 由恒回 0 改为"取首页插件行申报的剧库集数"**（同一条 `rows` 契约新增可选字段 `episodes`，见 [ADR-0053](adr/0053-home-row-declared-episodes.md)）。
>   - **改的是什么**：首页插件契约的 `rows` 行申报新增**可选**字段 `episodes`（「这个剧库里的剧一共多少集」的上游规模，只对 `collectionType: tvshows` 有意义）。面板从**剧库行**归并（同类型多行取最大值、`mixed` 不参与），填 `EpisodeCount`。其余字段**仍回 0**（0 = 数不出来，不是没有集）。
>   - **影响端点**：仅 `GET /api/emby/Items/Counts`（`EpisodeCount` 取值）。参数仍全忽略。
>   - **影响方向**：对客户端是**新可见值** —— 插件申报了剧库集数的实例，`EpisodeCount` 由 0 变为该数；没申报 / 取不到的仍是 0，行为不变。**客户端无需改动**。
> - **同轮还有「`Items` 按类型计数探针」契约变更（一并声明）**：`GET /Users/{UserId}/Items` 在**无 `ParentId` 且 `IncludeItemTypes` 为单一 `Movie` / `Series`** 时，**`TotalRecordCount` 由恒回 0 改为"取首页插件申报的库规模"**（与 `Items/Counts` 同一条 `libraryTotals()`，见 [ADR-0052](adr/0052-items-counts-library-total.md)）；**`Items` 仍回空**（不给样本条目）。
>   - **改的是什么**：Rex 等客户端首页**在拿库列表之前**先打两条无 `ParentId` 的 `Items?Recursive=true&IncludeItemTypes=Movie|Series&Limit=1&SortBy=SortName&SortOrder=Ascending`（除类型外参数相同），**只读 `TotalRecordCount`** 当「总统计」。此前面板落「没有可识别的查询参数 → 空」，`TotalRecordCount=0`（**客户端首页总统计恒显示 0**）。改后按类型取 `libraryTotals()` 的 `movies` / `tvshows`（真机就是回该类型库总数：itsmygo 255/189、nyamedia 714/1635）。只认**单类型** —— `Movie,Series` 这类多值不猜（无样本）。
>   - **影响端点**：仅 `GET /api/emby/Users/{UserId}/Items`（无 `ParentId` 的类型探针）。其它分支（`SearchTerm` / `ParentId` / 推荐 / `Filters` / `AnyProviderIdEquals` / 其余）不变。
>   - **影响方向**：对客户端是**新可见值** —— 插件申报了该类型库规模的实例，探针 `TotalRecordCount` 由 0 变为真实总数；没申报 / 取不到的仍是 0，行为不变。**客户端无需改动**（它本就按真机语义读这个字段）。
>   - **未涉及**：探针的 `Items` 仍为空数组（真机回 `Limit=1` 那 1 条，面板**不给** —— 用户定夺）；真机响应多一个 `StartIndex` 键，面板**不加**（各分支形状一致）；`Items?Ids=…` 仍回空（本变更不含）。逐条见「十、#5」。
> - **既定对齐口径（已定，不必逐条请示）**：真机对照里**只要看到真机不校验 `UserId` 的（读取类）端点，就直接对齐「只验 token」、不再逐条问**；只有「别的情况」（写端点 / 对齐会引入跨账号可见性 / 其它安全影响）才单独确认。
> - **与插件契约无关**：插件契约（另仓库）讲的是**取数能力**（元数据 / 源 / 首页要产出什么，见「四」的回退原则）；鉴权是 **emby 层对客户端**的契约。两件事不交叉，本次变更不触及插件契约。
> - **同轮还有「响应形状」契约变更（一并声明，非鉴权）**：`Shows/{Id}/Seasons` 由"**过滤掉特别篇**"改为"**照真机返回特别篇**"（#7-1）；季 `UserData` 由 **4 键**补到 **5 键**（新增 `UnplayedItemCount`，#7-3）；`Shows/{Id}/Episodes` 的分集**新增 `SeriesName`（剧名）**（#8-3，取剧名照 `progressItem` 再 `lookup` 一次、命中插件缓存）。三处均**对齐真机**，对客户端是**新增可见项 / 新增字段**（`Seasons` 会多出 `IndexNumber: 0` 的那一季；集条目多出 `SeriesName`）。**属同一轮变更，一并声明，不许默不作声。** 逐字段见「十、#7」「十、#8」。
> - **同轮还有「`Studios` 补校验 token」契约变更（一并声明）**：`GET /Studios` 由**不校验账号**改为**只验 token**。
>   - **改的是什么**：真机三台实测**无 token / 无效 token → 401 纯文本**（`Access token is invalid or expired.`）。本端点在路由层加 `authorize(req)`（同 `Items` 5-1 / `Items/Latest` 6-1 口径）。此前"回空没有数据可保护、故豁免校验"的取向**作废**。
>   - **影响端点**：仅 `GET /api/emby/Studios`。有效 token 仍照常回空 `QueryResult`（不变）；**不带 / 带无效 token 由 200 空变为 401**。
>   - **影响方向**：**更严格**（只在缺有效 token 时）；正常客户端都带 token，行为不变。**客户端无需改动**。
>   - **未涉及**：真机回的是**全库去重工作室清单**（予初 15601 / OkEmby 8181 / nyamedia 1324 条），本面板无片库索引、仍是**如实回空**（既有决策、**不复刻**）。逐条见「十、#14」。
>   - **同族待办**：`Items/Counts` 是否同样补校验 —— **已对照、已对齐**，见下一条。
> - **同轮还有「`Items/Counts` 补校验 token」契约变更（一并声明）**：`GET /Items/Counts` 由**不校验账号**改为**只验 token**。
>   - **改的是什么**：真机实测（OkEmby / nyamedia）**无 token / 无效 token → 401 纯文本**（`Access token is invalid or expired.`）。本端点在路由层加 `authorize(req)`（同 `Studios` 14-1 / `Items` 5-1 口径）。此前"回空没有数据可保护、故豁免校验"的取向**作废**。
>   - **影响端点**：仅 `GET /api/emby/Items/Counts`。此处**只改鉴权**：有效 token 照常回 `ItemCounts`；**不带 / 带无效 token 由 200 变为 401**。（其 `MovieCount` / `SeriesCount` 的取值后由「填库总数」变更另改，见上。）
>   - **影响方向**：**更严格**（只在缺有效 token 时）；正常客户端都带 token，行为不变。**客户端无需改动**。
>   - **未涉及**：真机回的是**真实计数**（OkEmby 7550 部电影 / 2592 部剧 / 82747 集；nyamedia 722 / 1710 / 52806），本面板无片库索引、**不复刻**真机真实计数（电影 / 剧集两类后改为取插件申报的库总数，其余仍 0，见上）。逐条见「十、#16」。
> - **同轮还有「版本行副标题」契约变更（一并声明，非鉴权）**：Emby 版本行的**副标题**（客户端取 `MediaSources[].Path` 解码后「最后一个 `/` 之后」的文字）由**「站点来源标签 · 集名」改为「标准文件名」（scene naming）**。
>   - **改的是什么**：`Path` 末段由 `…/{站点标签 · 集名}` 改为 `…/{标准文件名}`（聚合层新增 `standardName`，形状 `标题.年份.季集.分辨率.来源.音频(含声道).Atmos.动态范围.视频编码.容器`，如 `蜘蛛侠：崭新之日.2026.2160p.WEB-DL.DDP5.1.Atmos.DV.H.265.mkv`）。**不再带站点前缀**（来源/线路已在标题位 `MediaSources[].Name` 显示）；`WEB-DL` 等来源由 agg 的 source 识别补出；`H.265`/`DDP5.1`/`DV` 等规格换成 scene 通行写法。agg 拿不到规格的线路退回原始文件名。
>   - **影响端点**：`Items/{ItemId}/PlaybackInfo`（`MediaSources[].Path` 末段）与 `Items/{ItemId}/Stream`（末段文件名）。**只动副标题**：标题位 `MediaSources[].Name` / 视频流 `DisplayTitle` / `MediaStreams` 各字段**均不变**。
>   - **影响方向**：对客户端是**可见文本变化**（版本行副标题换了写法）；**不影响播放**（客户端播放走 `/videos/{Id}/stream.{ext}`，不读这个 `Path`）。**客户端无需改动**。
>   - **缓存口径**：agg 详情缓存的 key 版本号随之升级（`aggdetail3` → `aggdetail4`），换代后旧快照不再命中。逐条见「十、#11」。
> - **同轮还有「appName 可来自 query `X-Emby-Client`」契约变更（一并声明，放宽）**：`POST /api/emby/Users/AuthenticateByName` 在授权头里取不到 `Client=` 时，**再回退读 query `X-Emby-Client`**。
>   - **改的是什么**：面板此前只看授权头。抓包发现 Filmly / 网易爆米花把 appName 放在 **query**（`?X-Emby-Client=网易爆米花 Android`）、授权头里只有 `Device` / `DeviceId` / `Version`、**没有 `Client=`**，于是被误判「缺 appName」→ 400。真机对**同一形状**的请求实测（nyamedia 4.8.0.62）：头无 `Client=` + query 带 `X-Emby-Client` → **200**；头无 `Client=` + 无 query → 400。即真机取 appName 是「头 `Client=` 优先、缺了退 query」，现按真机对齐。
>   - **影响端点**：仅 `Users/AuthenticateByName`（appName 取值；响应结构、错误文案均不变）。query 参数名比对**大小写不敏感**。
>   - **影响方向**：**更宽容** —— 此前能登的仍能登；此前因 appName 只在 query 而被挡的客户端（Filmly / 网易爆米花）现可登录。**客户端无需改动。** 逐条见「十、#2」。
> - **同轮还有「appName 可来自 `Authorization` 头」契约变更（一并声明，放宽）**：`POST /api/emby/Users/AuthenticateByName` 取 appName 时，`X-Emby-Authorization` 缺失则回退读 `Authorization`。
>   - **改的是什么**：面板此前**只读** `x-emby-authorization`，客户端按官方文档把 `Client="…"` 放在 `Authorization` 里时被误判「缺 appName」→ 400。真机**两头都认**（实测 OkEmby / nyamedia / 予初Emby：只发任一 → 200；两头都缺 → 400），现按真机对齐。
>   - **影响端点**：仅 `Users/AuthenticateByName`（读 appName 的头来源；响应结构、错误文案均不变）。
>   - **影响方向**：**更宽容** —— 此前能登的仍能登；此前因把 appName 发在 `Authorization` 而被挡的客户端现可登录。**客户端无需改动。** 逐条见「十、#2」。
> - **同轮还有「授权头里 `Client=` 值引号可省」契约变更（一并声明，放宽）**：`POST /api/emby/Users/AuthenticateByName` 解析 appName 时，`Client="Filmly"` 与 `Client=Filmly`（不写引号）**都认**。
>   - **改的是什么**：面板此前正则写死 `Key="值"`、**只认带引号**的写法，客户端省掉引号就取不到 appName → 被误判 400。真机对引号**可选**（实测 nyamedia 4.8.0.62：`Emby Client="Filmly"` 与 `Emby Client=Filmly` 均 200），现按真机对齐（改为引号可选）。真机另有「值需以 `Emby `/`MediaBrowser ` 开头」的要求，面板**不校验前缀**（更宽、不收紧，避免误伤在用客户端）。
>   - **影响端点**：`Users/AuthenticateByName`（appName 取值）+ **所有受保护端点**（`tokenFrom` 从授权头取 `Token=` 时同口径放宽）；响应结构、错误文案均不变。日志的客户端标记（`[Client/版本]`）同一口径。
>   - **影响方向**：**更宽容** —— 此前能登的仍能登；此前因不写引号而被挡的客户端现可登录（含把 `Token=` 写进授权头的客户端）。**客户端无需改动。** 逐条见「十、#2」。
> - **同轮还有「登录请求体字段名大小写不敏感」契约变更（一并声明，放宽）**：`POST /api/emby/Users/AuthenticateByName` 的 `Username` / `Pw`（含兼容的 `Password`）取值**不再区分大小写** —— 客户端发 `username` / `pw` 也认。
>   - **改的是什么**：面板此前手写取值只认固定拼写（`Username` / `username`、`Pw` / `Password` / `password`），全小写的 `pw` 会取到**空密码** → 401。真机是 .NET 反序列化、字段名**大小写不敏感**（实测 OkEmby / itsmygo：同一口令发 `Pw` 与 `pw` 均 200），现按真机对齐。
>   - **影响端点**：仅 `Users/AuthenticateByName`（请求体取值；响应结构、错误文案均不变）。
>   - **影响方向**：**更宽容** —— 此前能登的仍能登；此前因拼写被挡的客户端（如 HamHub Android `1.0.17+29` 发 `{"username":…,"pw":…}`）现可登录。**客户端无需改动。** 逐条见「十、#2」。
> - **同轮还有「无 `ParentId` 的裸列表查询」契约变更（一并声明）**：`GET /Users/{UserId}/Items` 在**无 `ParentId` 且不命中任何已有专属支路**（无 `Filters` / `SearchTerm` / `AnyProviderIdEquals` / `Ids`，也不是无 `ParentId` 的按类型计数探针）时，**由恒回空改为"路由到插件声明了 `feed: 'random'` 的那一行"**（与轮播推荐位共用同一 `feed` 取值，见 [ADR-0054](adr/0054-bare-items-query-uses-random-feed.md)）。
>   - **改的是什么**：`service.feedOfQuery()` 判据由"`SortBy` 含 `IsFavoriteOrLiked` 的推荐位"**放宽到"推荐位 + 无 `ParentId` 的裸列表查询"** —— 判据是「**不指名库** + **不命中任何已有专属支路**」。此前 Filmly / 网易爆米花首页打的就是这条（只带 `ExcludeItemTypes` / `StartIndex` / `Limit` / `Fields`，无 `ParentId` / `SortBy` / `Filters`），落「其余查询 → 空」，客户端首页一片空白。**插件没声明 `feed: 'random'` → 仍回空**（不挑一行顶上）。
>   - **影响端点**：仅 `GET /api/emby/Users/{UserId}/Items`（无 `ParentId` 的裸查询分支）。其它分支（`ParentId` / `SearchTerm` / 推荐位 / `Filters` / `AnyProviderIdEquals` / 计数探针 / `Ids` / 其余）不变。
>   - **影响方向**：对客户端是**新可见行为** —— 命中插件声明的实例，裸查询由**回空**变为**跑 `feed: 'random'` 行**；无声明 / 取不到的仍回空，行为不变。**客户端无需改动**（它本就按真机语义读；真机此处回的是它自己的片库内容）。逐条见「十、#5」。
>   - **未涉及**：`feed` 取值**不新增**（轮播推荐位与裸查询共用 `feed: 'random'`，插件契约不改）；`Items?Ids=…` 仍回空（本变更不含）。
> - **同轮另有「无 `ParentId` 的裸列表查询改回库列表」契约变更（一并声明，**推翻上一条**）**：`GET /Users/{UserId}/Items` 在**无 `ParentId` 且不递归**的裸查询下，**由"路由 `feed: 'random'` 回条目"改为"回顶层库列表"**（与 `GET /Users/{UserId}/Views` 一字不差），见 [ADR-0055](adr/0055-bare-items-query-returns-views.md)（取代 [ADR-0054](adr/0054-bare-items-query-uses-random-feed.md)）。
>   - **改的是什么**：予初Emby 4.9.5.0 实测该形状（无 `ParentId` + 不递归，只带 `ExcludeItemTypes`/`StartIndex`/`Limit`/`Fields`）真机回 **26 个 `CollectionFolder`（＝顶层库列表）**，与 `Views` 一字不差 —— 真机对「无 `ParentId` 且不递归」的 `Items` 默认回根节点的直接子级（要条目客户端须自带 `Recursive=true`）。上一条（ADR-0054）据无样本的推断把它路由到 `feed: 'random'` 回条目，与真机相反，现予推翻。落码：`service.libraryQueryOf(query)` 命中即 `return getViews()`；`feedOfQuery()` 收窄回**只认轮播推荐位**。
>   - **影响端点**：仅 `GET /api/emby/Users/{UserId}/Items`（无 `ParentId` 的裸查询分支）。其它分支（`ParentId` / `SearchTerm` / 轮播推荐位 / `Filters` / `AnyProviderIdEquals` / 计数探针 / `Ids` / 其余）不变。
>   - **影响方向**：对客户端是**可见行为变化** —— 该分支由回**条目**改为回**库列表**（对齐真机）。**客户端无需改动**（它本就按真机语义读这个形状）。逐条见「十、#5」。
>   - **未涉及**：`feed: 'random'` 取值仍在、仍只服务**轮播推荐位**（`SortBy` 含 `IsFavoriteOrLiked`）；插件契约不改；`Items?Ids=…` 仍回空。
> - **同轮另有「新增 `System/Info` 端点」契约变更（一并声明，新增可见端点）**：`GET /api/emby/System/Info` 由**落到 501 通配**改为**认领并回诚实子集**。
>   - **改的是什么**：新增 `GET /api/emby/System/Info` 路由（此前无此路由，客户端请求落入 `ANY /api/emby/*rest` 通配 → 501）。响应为**诚实子集**：只给面板真有的 **17** 个字段，其中 `ServerName` / `Version` / `Id` / `OperatingSystem` / `LocalAddress` / `LocalAddresses`(空) / `RemoteAddresses`(空) / `CompletedInstallations`(空) 如实给值，能力位 `HasPendingRestart` / `IsShuttingDown` / `SupportsLibraryMonitor` / `CanSelfRestart` / `CanSelfUpdate` / `CanLaunchWebBrowser` / `SupportsHttps` / `HasUpdateAvailable` / `SupportsAutoRunAtStartup` **一律 `false`**（面板确无这些能力，不是"能而不用"）；面板无对应物的 `SystemUpdateLevel` / `OperatingSystemDisplayName` / `SupportsLocalPortConfiguration` / `WebSocketPortNumber` / `HttpServerPortNumber` / `HttpsPortNumber` / `HardwareAccelerationRequiresPremiere` / `WanAddress` **不回**（不编造，见 [ADR-0008](adr/0008-no-fabricated-data.md)）。鉴权**只验 token、不比对 UserId**（同类读取端点口径）。取舍见 [ADR-0057](adr/0057-emby-system-info-honest-subset.md)。
>   - **影响端点**：新增 `GET /api/emby/System/Info`。握手 `System/Info/Public` 不变。
>   - **影响方向**：对客户端是**新可见端点** —— 此前 501，现 200；字段集**小于真机**（真机 4.8 / 4.9 同构 25 字段），属**有意诚实子集**（面板没有的字段不编）。**客户端无需改动**（它本就该容忍字段缺失；VidHub 此前 501 也照常往下走）。逐条见「五」与「十」#20。
>   - **未涉及**：`System/Info/Public` 字段集不变；501 通配仍保留（`System/Ext/ServerDomains` 等仍走它）。
> - **同轮另有「收藏」契约变更（一并声明，新增可见端点 + 读侧由空转真数据）**：新增写端点 `POST|DELETE /Users/{UserId}/FavoriteItems/{ItemId}`；`Items?Filters=IsFavorite` 由「必然空」改为**读 `favorite` 表出真数据**；`UserData.IsFavorite` 由写死 `false` 改为**真值**（见 [ADR-0058](adr/0058-favorite-items.md)）。
>   - **改的是什么**：`emby.db` 新增 `favorite` 表（`SCHEMA_VERSION` 4 → 5；`account_id, item_id, payload(JSON 快照), updated_at`，主键 `(account_id, item_id)` 覆盖写）—— 属**用户数据**、不随缓存清理。收藏动作时**反查元数据、快照落库**；读侧 `Filters=IsFavorite` 只读快照、**快照重建**（**0 上游请求**、无 1→N 扇出）。收藏对象放宽到 `movie`/`show`/`season`/`episode`（**不复用** `playableOf`）。`removeAccount` 一并清收藏。
>   - **影响端点**：新增 `POST|DELETE /api/emby/Users/{UserId}/FavoriteItems/{ItemId}`（200 + `UserItemDataDto`；Id 认不出 / 反查失败 → 204 且**不写库**）；`GET /api/emby/Users/{UserId}/Items`（`Filters=IsFavorite` 分支）；`UserData.IsFavorite` 在**一切补 `UserData` 的端点**（列表 / 详情 / 季 / 集 / 继续观看 / 接下来看 / 相似等）上出真值。
>   - **影响方向**：写端点由 **501 通配 → 200**；收藏列表由 **恒空 → 真数据**；`IsFavorite` 由 **恒 `false` → 真值**。**客户端无需改动**（它本就按真机语义读）。
>   - **未涉及**：`Items/{ItemId}` 条目**详情**仍走既定 `richItemDto` 反查、与收藏快照无关；轮播推荐位（`SortBy=IsFavoriteOrLiked`）仍走 `feed: 'random'` **随机推荐**、**不按收藏过滤**。逐条见「五」与「十」#21。
> - **同轮另有「`Shows/NextUp` 改为对外恒空」契约变更（一并声明，响应由真数据转空）**：`GET /api/emby/Shows/NextUp` 由**出真数据**改为**恒回空 `{Items:[], TotalRecordCount:0}`**（见 [ADR-0060](adr/0060-nextup-hidden.md)，取代 [0023](adr/0023-playback-progress.md) 的 `Shows/NextUp` 那一格）。
>   - **改的是什么**：端点**保留、不删路由、不加开关**；`service.getNextUp` 在 token 校验之后直接回空。算「该看哪一集」的实现（`nextEpisodeItem` / `episodeExists` / `firstEpisodeItem` 与 `db.listRecentBySeries`）**留着但暂不调用**（恢复时把空返回换回原逻辑即可）。**鉴权口径不变**（无 token → 401 纯文本；有效 token + 错配 / 不存在的 UserId → 200，见 [0048](adr/0048-emby-userid-not-identity.md)）。
>   - **影响端点**：仅 `GET /api/emby/Shows/NextUp`（含带 `SeriesId` 的请求）。`Items/Resume`、`Items?Filters=IsPlayed` 等**不受影响**。
>   - **影响方向**：响应由**真数据**变为**恒空** —— 只认这条端点渲染「接下来看」那一行的客户端将不再显示该行（「继续观看」仍由 `Resume` 提供）；带 / 不带无效 token 的 401 行为不变。**客户端无需改动**（它本就该容忍空列表）。
>   - **缘由**：常规顺序观看下，「接下来看」与「继续观看」常指向同一集、两行重复；与其对齐一个验不了（已验四台真机全是聚合类）、对齐了也仍重复的语义，不如直接不重复。逐条见「五」与「十」#15。
> - **同轮另有「条目 `PremiereDate` / `Overview` 不再回空串」契约变更（一并声明，空串转「省略键」）**：`service.baseItem()` 里 `PremiereDate` / `Overview` 由**空串兜底**改为**拿不到就不挂这个键**（见 [ADR-0061](adr/0061-omit-missing-scalar-fields.md)）。
>   - **改的是什么**：`PremiereDate` / `Overview` 只在插件给了非空值时才出现在条目 DTO 上；拿不到就整个键省略（口径与同函数末尾的 `DateCreated` / `DateModified` 一致）。**数组类字段仍先铺 `[]`**（[ADR-0007](adr/0007-emby-dto-shape.md)，不动）。
>   - **影响端点**：一切补 `baseItem` 的端点 —— 列表（`Users/{UserId}/Items`、`Items/Latest`）/ 详情 / 季 / 集 / 继续观看（`Items/Resume`）/ 相似等条目 DTO。
>   - **影响方向**：这两个键由**恒在（可能为空串）**变为**可能缺失**。空串是**非法 DateTime** —— 客户端对它做 `DateTime.parse(value)` 会抛 `FormatException`、**整条响应解码失败**（实测 Hills 1.9.1 就是这么崩的），省略后与真机一致（真机拿不到就不含该键）。`Etag` 哈希含这两个字段，但 `Array.join` 对 `undefined` / `''` 同化 → **Etag 值不变**、无缓存抖动。**客户端无需改动**（它本就该容忍字段缺失）。逐条见「十」#6。
> - **同轮另有「认领 Emby 旧版播放上报族 `Users/{UserId}/PlayingItems/*`」契约变更（一并声明，新增可见端点）**：新增三条端点 `POST /Users/{UserId}/PlayingItems/{ItemId}`（开始）、`POST …/PlayingItems/{ItemId}/Progress`（心跳）、`DELETE …/PlayingItems/{ItemId}`（停止），映射到既有的 `recordPlayback` 落库。
>   - **改的是什么**：把 Emby **旧版族**（`ItemId` 在**路径**、参数在 **query**、**无 JSON body**）接进与新版族 `Sessions/Playing*` **同一套落库**；响应一律 **204 空体**，`ItemId` 认不出 → 204 **不写库**（与新版族同口径）。**鉴权口径同新版族**（无 token → 401）。
>   - **影响端点**：新增上述三条；`Items/Resume` / `Items?Filters=IsPlayed` 的**读侧不变**（它们读同一张 `playback` 表）。
>   - **影响方向**：这三条由 **501 通配 → 204**。只发旧版族的客户端（实测 **HamHub Android/1.0.0**）此前进度全丢、「继续观看」看不到它看过的集，现在会落库生效。**客户端无需改动**（它本就按真机语义发）。
>   - **已知限制**：旧版族**不带 `RunTimeTicks`** ⇒ 时长未知时判「看完」失去依据（`recordPlayback` 照实记「时长未知」）。逐条见「五」与「十」#22。
> - **同轮另有「拉流鉴权补认 query `X-Emby-Token`」契约变更（一并声明，放宽 token 带法）**：`service.tokenFrom()` 取 token 时，query 兜底由**只认 `api_key`** 改为**并列认 `api_key` / `X-Emby-Token`**（`URLSearchParams` 键区分大小写，客户端发的正是大写那种）。
>   - **影响端点**：一切走 `authorize` 的端点，重点是**拉流 / 下载**（`videos|Videos/{ItemId}/stream`、`Items/{ItemId}/Stream`、`Items/{ItemId}/Download`）。
>   - **影响方向**：客户端把 token 放进 query `X-Emby-Token`（**不带请求头**）时，由 **401（判成「没带 token」）→ 正常出字节**；走请求头 / query `api_key` 的老带法**不变**。**客户端无需改动**。逐条见「十」#12 的 12-5。
> - **同轮另有「路由字面段比对改为大小写不敏感」契约变更（一并声明，全局放宽匹配）**：`core/router.js` 的路径匹配由**字面段大小写敏感**改为**大小写不敏感**（`*wildcard` 与 `:param` 的**取值照原样**给，不做转换）。
>   - **改的是什么**：此前字面段逐字比对（`p !== reqSegs[i]`），客户端把 `/Users/AuthenticateByName` 写成全小写 `authenticatebyname` 就落 `ANY /api/emby/*rest` 通配 → 501。真机（.NET 路由）**大小写不敏感**，故这类客户端在真机能登、在面板吃 501（实测 **AfuseKt/3.2.0** 就这么发，见「十」#2）。现按真机对齐：字面段小写比对；通配段取值不变。
>   - **影响端点**：**全局** —— 所有走 `core/router.js` 的路由，含面板自身 `/api/*`（`/api/panel/*` 等）。此前大小写写错会 404 / 501 的路径，现在都能命中；方法与段数约束不变（段数不齐仍 404，方法不符仍 405）。
>   - **影响方向**：**更宽容**（只放宽路径大小写）—— 此前能命中的路径必命中（小写比对对已正确大小写的请求是恒等），新增命中此前因大小写写错而落空的路由。**客户端无需改动**。
>   - **未涉及**：同轮顺带删除冗余的 `GET /api/emby/Videos/:itemId/:file` 重复注册（早前为同时认大小写 `videos` / `Videos` 而写两条，现一条认下，见「五」）—— 端点集合不变。
> - **同轮另有「登录请求体认 `application/x-www-form-urlencoded`」契约变更（一并声明，放宽请求体格式）**：`core/http.js` 的 `readBody()` 由**只认 JSON** 改为**另认 `application/x-www-form-urlencoded`**（按 `content-type` 判定；未发 `content-type` 但形状像表单的也按表单解，否则照旧报 400）。
>   - **改的是什么**：真机（.NET 模型绑定）JSON 与表单都读。实测 **AfuseKt/3.2.0** 的登录体就是 `Username=…&Pw=…&appName=…`（`content-type` 为表单），此前只认 JSON → 解析失败 → 400，即便路径修好也登不上。
>   - **影响端点**：一切走 `readBody` 的端点，重点是**登录** `Users/AuthenticateByName`（其请求体字段名取值口径不变，仍大小写不敏感）。响应结构、错误文案均不变。
>   - **影响方向**：**更宽容** —— 发 JSON 的客户端行为不变；发表单体的客户端（AfuseKt）由 400 变为可登录。**客户端无需改动**。逐条见「十」#2。
> - **同轮另有「播放地址（`DirectStreamUrl` / `MediaSources[].Path`）由绝对 URL 改为相对路径」契约变更（一并声明，改响应形状）**：`service.directStreamUrl()` 与 `service.streamPath()` 的输出由**绝对 URL** 改为**相对路径**（见 [ADR-0062](adr/0062-relative-playback-urls.md)）。
>   - **改的是什么**：`DirectStreamUrl` 由 `{proto}://{host}/api/emby/videos/{ItemId}/stream.{Container}?…` 改为 `/videos/{ItemId}/stream.{Container}?…`；`MediaSources[].Path` 由 `{proto}://{host}/api/emby/Items/{ItemId}/Stream/{token}/{文件名}` 改为 `/Items/{ItemId}/Stream/{token}/{文件名}`。随之下掉 `getItem` / `getPlaybackInfo` / `buildMediaSource` 的 `host` / `proto` 参数（routes 里的 `protoOf` 一并删除）。
>   - **影响端点**：`POST /api/emby/Items/{ItemId}/PlaybackInfo`（`MediaSources[].DirectStreamUrl`）、`GET /api/emby/Users/{UserId}/Items/{ItemId}`（`MediaSources[].Path`）。拉流端点本身（`videos/*`、`Items/{ItemId}/Stream`）不变。
>   - **影响方向**：两字段**由绝对变为相对**。客户端本就把它拼在自己的 base 之后（base 已含 `/emby`）——给绝对 URL 会被**再拼一次**成双重地址（`…/emby` + `http://…/api/emby/…`）→ 实例端口 normalize 后不以 `/api/emby/` 开头 → **404**（实测 **AfuseKt/3.2.0**，见「十」#11）。改相对后，base 是 `/emby` 还是 `/api/emby` 都能命中。**只读这两个字段、当绝对地址直接用的第三方**（外部播放器 / 调试脚本）需自行补 base；走官方协议的客户端**无需改动**。逐条见「十」#11 的 11-4。
> - **同轮另有「版本行标题位改由聚合层供给」契约变更（一并声明，非鉴权；标题格式不变）**：Emby 版本行的**标题位**（`MediaSources[].Name` 与视频流 `DisplayTitle`）由**本层自己拼**改为**直接读聚合层写好的 `versionLabel`**（规则只实现一次，出口插件 FW/Rex 读同一个字段，见 [ADR-0063](adr/0063-version-label-at-aggregate-output.md)；与 [ADR-0043](adr/0043-line-filter-at-aggregate-output.md)「线路过滤在聚合层产出时滤」同一模式）。
>   - **改的是什么**：标题位格式**不变**（仍是 `[体积] 站点标签 · 线路flag [· 变体标注] [· 项标注]`），拼装从 emby 层 `buildMediaSource` 下沉到聚合层 `fillVersionLabels`，写在各可播目标的 `versionLabel` 上；emby 层不再自己拼、也不留旧拼装兜底。聚合层同步给详情站条目补上 `sourceName`（此前只有搜索条目带）。
>   - **影响端点**：`POST /api/emby/Items/{ItemId}/PlaybackInfo`（`MediaSources[].Name` / 视频流 `DisplayTitle`）、`GET /api/emby/Users/{UserId}/Items/{ItemId}`（条目详情的 `MediaSources`）。其余字段不变。
>   - **影响方向**：**多源场景下标题多出源名前缀** —— 命中多个源时标题形如 `源名 站点标签 · 线路`（不同源可能有同名站点，加前缀才分得清）。此前聚合层详情站条目**不带 `sourceName`**，「多源时前置源名」这一条**实际从未生效**（恒无前缀）；现补齐后生效，属**新可见文本**。单源场景标题**不变**。**客户端无需改动**（它只当显示名读）。
>   - **缓存口径**：agg 详情缓存的 key 版本号随之升级（`aggdetail4` → `aggdetail5`），换代后旧快照不再命中。
>   - **插件侧**：出口插件读同一个 `versionLabel`（取法：剧集 `line.target.versionLabel`、电影 `line.items[].versionLabel`），契约正文在**另一仓库** [media-bridge-plugins](https://github.com/dlushu/media-bridge-plugins)（本仓库不复制）。
> - **同轮另有「字幕插件」契约变更（一并声明，新增插件类型 + 新增可见端点 + 版本 Id 载荷扩展）**：新增第五类插件 **`subtitle`**（申报字幕轨 + 取字幕内容），新增 Emby 标准字幕内容端点，`MediaSourceId` 载荷由 `{r, v?}` 扩为 `{r, v?, s?}`。
>   - **改的是什么**：
>     - **插件类型新增 `subtitle`**：面板 [server/modules/plugin/contract.js](server/modules/plugin/contract.js) 的 `TYPES` 由四类加为五类；插件仓库 `tools/contract.js` 同步。字幕插件两个动作：`tracks`（申报字幕轨，直接回 `[{lang, format, label?, ref}]`，可能被重复调用、要能重复答，报空数组 = 该目标无字幕）与 `fetch`（`{ref}` → `{body, contentType?}`）。契约正文在**另一仓库** `docs/plugin-contract.md`「七、字幕插件的动作」（本仓库不复制）。
>     - **版本里挂字幕流**：条目详情 / 播放信息里每条版本的 `MediaStreams[]` 追加 `Type:'Subtitle'` 流（`Index` **顺延在视频/音频流之后**、`Codec` 按 `format` 映射 `srt→subrip`/`ass→ass`/`ssa→ssa`/`vtt→webvtt`、`Language`=插件 `lang` 原样、`DisplayTitle`=`label||lang`、`IsExternal`/`IsTextSubtitleStream`/`SupportsExternalStream`=`true`、`DeliveryMethod:'External'`、`DeliveryUrl` 指向字幕内容端点）。**字幕与线路无关**：面板为一个播放目标问一次 `tracks`、挂到该目标**每个版本**上；`tracks` 失败**只降级**（不出字幕轨、记一行日志，不破坏详情）。
>     - **新增字幕内容端点**：`GET /api/emby/Videos|videos/{ItemId}/{MediaSourceId}/Subtitles/{Index}/Stream.{Format}`（含带 `StartPositionTicks` 的官方变体，`StartPositionTicks` 忽略）。此前落到通配 → 501。
>     - **`MediaSourceId` 载荷扩展**：`mbpSourceId` 的 JSON 载荷由 `{r, v?}` 扩为 `{r, v?, s?}`，`s` = `{ "<流序号>": "<字幕 ref>" }`。**无字幕时不写 `s`**（载荷与旧版一致）；`parseMbpSourceId` 旧载荷照常解析（`s` 缺省为空）。`ref` 由**字幕插件自己**构造、自带 `<插件 id>/` 前缀，面板**不代加**前缀、只按第一段路由。
>   - **影响端点**：`GET /api/emby/Users/{UserId}/Items/{ItemId}`（详情 `MediaSources[].MediaStreams[]` 新增字幕流）、`POST /api/emby/Items/{ItemId}/PlaybackInfo`（同上）、新增 `GET /api/emby/Videos|videos/{ItemId}/{MediaSourceId}/Subtitles/{Index}/Stream.{Format}`。
>   - **影响方向**：对客户端是**新可见端点 + 新可见流**（此前无字幕轨、无内容端点；插件没申报字幕时行为不变）；鉴权**只验 token、不比对 UserId**（与拉流同口径）。**客户端无需改动**（它本就按真机语义认 `Type:'Subtitle'` 流、打标准字幕端端点）。
>   - **未涉及**：拉流 / 下载端点的重定向口径、版本其它字段、`tracks` 是否触网（**契约不规定**，面板按最坏情况记扇出账、不给它加特殊限制/超时）均不变；字幕内容**缓存归插件自己**、面板侧**不另开字幕缓存**。逐条见「五」与「十」#23（**无真机样本、未复测**）。
> - **同轮另有「实例端口对 Emby 根路径兜底」契约变更（一并声明，放宽实例端口的路径匹配）**：实例端口（`listener.js`）的路径归一化在**与面板端口一致的两条规则**（`/emby/…`、`/api/emby/emby/…` → `/api/emby/…`）之外，**多加一条**：pathname **不以 `/api/` 开头**的，一律前缀 `/api/emby`（见 [ADR-0065](adr/0065-instance-port-root-path-fallback.md)）。
>   - **改的是什么**：真机 Emby 的端点本就挂在**根路径**（`/videos/…`、`/Items/…`、`/Videos/…`，见「十」#12）；面板此前要求客户端必须带 `/emby` 或 `/api/emby` 前缀，否则在实例端口命中 **404 守卫**（「这个端口只伺候 Emby 客户端协议」）。现补上根路径兜底：`/videos/{ItemId}/stream.hls?…` → `/api/emby/videos/{ItemId}/stream.hls?…` → 命中既有路由。**只改实例端口**，面板端口（`server.js`）不动（其根部是面板自己的 UI，不能这么映射）。
>   - **影响端点**：**实例端口上的一切 Emby 端点**（此前只能靠带前缀访问的那批）——重点是直连拉流 `videos|Videos/{ItemId}/stream`、`Items/{ItemId}/Stream`、下载 `Items/{ItemId}/Download`、字幕内容 `Videos/{ItemId}/{MediaSourceId}/Subtitles/…`（客户端拿到的 `DirectStreamUrl` / `Path` / 字幕 `DeliveryUrl` 都是**根相对**，见 [ADR-0062](adr/0062-relative-playback-urls.md)）。
>   - **影响方向**：**更宽容**（只放宽实例端口的入口路径）。**客户端无需改动** —— 按 origin 解析根相对地址（实测 **HamHub/1.0**：`/videos/…` 404 四次退避、改用 `/emby/videos/…` 才 200）与字符串拼接（AfuseKt）两种行为都能命中。**面板自用端点的隔离不破**：`/api/…`（非 emby）与 `PANEL_ONLY_RE`（`accounts` / `instances` / `home-plugins` / `meta-domains`）照旧 404。
>   - **安全**：不引入跨账号可见性 —— 只是多认几条入口路径，鉴权口径（token 为准）与各端点自身校验一字未改。
>   - **未涉及**：下发的 DTO（`DirectStreamUrl` / `Path` / `DeliveryUrl` 仍是根相对）一字不改；`server.js` 的面板端口归一化不动。逐条见「十」#12 的 12-6（**已落码，未复测**）。
> - **同轮另有「品牌净化：对外 DTO 的自家字段与不透明 Id 前缀去 `catpaw`」契约变更（一并声明，改字段名 + 改 Id 前缀）**：把面板自起的字段名与不透明 Id 前缀从 `catpaw` 统一改为 `mbp`（面板品牌短标识）。
>   - **改的是什么**（只改**值 / 字段名**，Emby 协议字段名不动）：
>     - `ProviderIds.Catpaw` → **`ProviderIds.MediaBridge`**（`ProviderIds` 是协议字段；`MediaBridge` 是面板自起的键，客户端会忽略）；
>     - 非标准字段 `CatpawSource` → **`MediaBridgeSource`**（含其 `LineFilter` 子对象，`Site` / `Sites` 等子字段名不变）；
>     - 版本 / 媒体源 Id 前缀 `catpaw:` → **`mbp:`**（派生与解析一对改名：`catpawSourceId` / `parseCatpawSourceId` → `mbpSourceId` / `parseMbpSourceId`，形状仍是 `mbp:` + base64url(deflateRaw(JSON `{r, v?, s?}`))）；
>     - 媒体库（Views）Id 前缀 `catpawhome_` → **`mbphome_`**（形状不变，仍是 `mbphome_` + base64url(`<插件id>|<行id>`)）；
>     - `PresentationUniqueKey` 前缀 `p-catpaw-` → **`p-mbp-`**。
>   - **影响端点**：`GET /api/emby/Users/{UserId}/Views`（库 Id）、`GET /api/emby/Users/{UserId}/Items`（`ParentId` 认前缀 + 列表）、详情 `GET /api/emby/Users/{UserId}/Items/{ItemId}`（`ProviderIds` / `MediaBridgeSource` / `MediaSources[].Id` / `PresentationUniqueKey`）、`POST /api/emby/Items/{ItemId}/PlaybackInfo`（`MediaSources[].Id`）、拉流 `videos/*` 与 `Items/{ItemId}/Stream`（`MediaSourceId` 前缀）、字幕内容端点（`MediaSourceId` 载荷）。
>   - **影响方向**：这些**全是不透明标识或面板自用字段**（客户端只当字符串，或直接忽略）——**客户端无需改动**。但要留意**缓存态**：客户端若缓存了旧的库 Id / 版本 Id（`catpawhome_*` / `catpaw:*`），换版后对不上会取不到内容，**清一次客户端缓存 / 重新拉库列表**即可。**服务端数据无迁移**：这些前缀都是**运行时现算、不落库**（`recordPlayback` 落的是条目**域坐标** `tmdb_*` / `missav_*`，`emby.db` 五表无任何 `catpaw` 列），故不注册迁移任务、数据版本不动。
>   - **未涉及**：条目 Id 本身（`tmdb_*` / `missav_*` 是元数据插件的域坐标，与面板品牌无关）不变；`ProviderIds` / `PresentationUniqueKey` 两个**协议字段名**不变；落库数据不变。逐条见「十」#4 / #10 / #23（**已落码，未复测**）。
> - **同轮另有「直连播放地址（`DirectStreamUrl`）去容器后缀」契约变更（一并声明，改响应形状）**：`service.directStreamUrl()` 的输出由 `/videos/{ItemId}/stream.{Container}?…` 改为 **`/videos/{ItemId}/stream?…`（裸 `stream`，不带后缀）**（见 [ADR-0070](adr/0070-direct-stream-url-bare-stream.md)）。
>   - **改的是什么**：`DirectStreamUrl` 去掉 `.{Container}` 后缀（`directStreamUrl` 去 `container` 参数、`getPlaybackInfo` 调用点去 `container: m.Container`）。**相对路径口径不变**（见上一轮「播放地址由绝对 URL 改为相对路径」）；`MediaSources[].Id`（版本 Id）、`Path`、`Container` 字段本身都不变。
>   - **影响端点**：仅 `POST /api/emby/Items/{ItemId}/PlaybackInfo` 的 `MediaSources[].DirectStreamUrl`（详情端点本就不返回该字段，不变）。拉流端点（`videos|Videos/{ItemId}/stream[.{ext}]`）本身不变。
>   - **影响方向**：字段值由 `stream.mkv` / `stream.hls` 变为**裸 `stream`**（对齐真机予初Emby 4.9.5.0：电影 `864879` / 剧集 `585872` 两条原文均为裸 `stream`，`Container='mkv'` 也不拼 `.mkv`；更新的动漫Emby 4.10.1.0 / OkEmby **根本不返该字段**）。**客户端无需改动** —— 客户端要么自拼 `videos/{Id}/stream.{ext}`（本层路由正则 `stream(\.[a-z0-9]+)?` 裸后缀都收），要么直接取本字段（裸 `stream` 同样命中）。逐条见「十」#11 的 11-5（**已落码，未复测**）。
> - **上游失败一律照实回失败**：**不编占位数据、不回空的假成功**。状态码 = 上游的真实原因，由 `metaBridge.httpStatusOf()` 一处决定：

| 失败原因 | 回的码 |
|---|---|
| 上游给过状态码（`401/403/404/429/5xx`…） | **照搬那个码** |
| 网络不可达（连不上） | `502` |
| 请求超时（10s） | `504` |
| 面板还没配 token | `500`（是面板没配好，不是客户端的问题） |
| 条目 id 不合法 | `400` |

  响应体形如 `{"error":"连不上上游：ECONNRESET","code":"NETWORK","meta":"tv/95350"}`（`code` 是内部错误分类，便于日志对照）。
  **网络类失败会先立即重试一次**（元数据插件的请求层 `requestWithRetry`，日志里是 `↻ <域> NETWORK，立即重试一次：…`）——
  经过代理的网络里上游链路可能不稳定（实测会在握手阶段被中断），重试能把单次抖动的成功率拉回来；
  **确定性失败（401/404）不重试**（重试没有意义），失败仍然**不写缓存**。
- **兼容取向**：握手对外自称 `Emby Server 4.8.0.0` —— 客户端按 Emby 的版本号判断能力，这是刻意的兼容选择。
- **条目列表（`Users/{UserId}/Items`）—— 「列表数据由首页模块决定」**（部署者指定）：
  emby 层在这里只做**端点映射 + DTO 转换**，不再自己造列表数据。八条分支：
  0. **`SearchTerm=<词>` → 按名字搜**（见下面「搜索」那条）—— 排在前面因为它最具体
  1. `ParentId=<mbphome_…>` → `home.listByQuery()` 跑对应插件行 → `HomeItem` → `BaseItemDto`；**`StartIndex`/`Limit` 原样透传给模块**（进 `ctx.startIndex`/`ctx.limit`，**emby 层不切片** —— 取哪一页是模块的决定），`SortBy`/`Recursive`/`IncludeItemTypes` 忽略；`TotalRecordCount` 用**模块给的 `total`**
  2. **「轮播推荐位」**（无 `ParentId` + `SortBy` 含 `IsFavoriteOrLiked`）→ 路由到**插件声明了 `feed: 'random'` 的那一行**（见下面「轮播推荐位」那条）
  2.5 **「裸列表查询」**（无 `ParentId` + 无 `SortBy` + 不递归 + 无 `Filters`/`SearchTerm`/`AnyProviderIdEquals`/`Ids`，也不是计数探针 —— 如 Filmly / 网易爆米花首页）→ **回顶层库列表**（`service.libraryQueryOf()` 命中即走 `Views` 那支，与 `Views` 一字不差，对齐真机；见下面「裸列表查询」那条 + [ADR-0055](adr/0055-bare-items-query-returns-views.md)）
  3. `Filters=IsPlayed` → **读 `playback` 表**出已看的条目（真数据，要 token）；`Filters=IsFavorite` → **读 `favorite` 表**出收藏的条目（真数据，快照重建、**0 上游请求**，见 [ADR-0058](adr/0058-favorite-items.md)）
  3.5 `AnyProviderIdEquals={域}.{编号}`（**可逗号分隔多值**）→ **按外部 id 搜一条**（见下面那条）—— 与「搜索」同类：**检索归 emby 层**，不归首页模块
  3.6 **无 `ParentId` 的「按类型计数」探针**（`IncludeItemTypes` 归一后是**单一** `Movie` / `Series`）→ 取 `home.libraryTotals()` 的库规模回 `TotalRecordCount`，`Items` 回空 —— Rex 等客户端首页拿它读「总统计」（见下面那条 + 「十」#5）
  4. 其余查询（含认不出的 `AnyProviderIdEquals`、`Ids=…` 按条目 id 点名取）→ 空
  - **搜索（`SearchTerm=<词>`）**：**按名字搜**，数据来自上游的 `search/tv` 与 `search/movie`。
    - **为什么要加**：SenPlayer 6.1.8 的搜索框打的就是这条 —— `Items?...&IncludeItemTypes=Movie,Series,Video,Person&Recursive=true&SearchTerm=斗破苍穹`，
      以前落到「没有可识别的查询参数 → 空」，日志里连打 4 次 `Items=0`（搜索框永远是空的）。
    - **归属**：**归 emby 层**（与详情/相似同类）—— 它是"按名字去上游反查"，不是"这台服务器上有哪些片"。
    - **真机模板**（`emby.example.com`，实测）：同一条 query → `TotalRecordCount: 7`（剧 + 电影混排），
      列表项只有 **11 个字段**（`AirDays/BackdropImageTags/DateCreated/Id/ImageTags/IsFolder/Name/RunTimeTicks/ServerId/Type/UserData`）
      ⇒ 客户端对"搜索卡片"没有更多期待；本面板给的 42 个字段是**超集**（超集不会出错，见「四」）。
      顺带实测：真机的 `GET /Search/Hints` 回的是**空数组**（该服务器没实现）—— 所以不照抄那条，只做客户端真正在用的这条。
    - **三条实现口径**（都写在 `getSearchItems()` 的注释里）：
      ① **不为结果再打 `lookup()`** —— 搜索行里的名字/简介/海报/横图/年份/评分够画卡片，`lookup({rich:true})` 留给**详情**
        （客户端点进某条时本来就会打详情）；代价是**每类型 1 次上游**，不是"结果数 × 1 次"。
      ② **只取上游第 1 页**（每类型 20 条，`Limit` 缺省 20 / 硬顶 40）：`StartIndex`/`Limit` 在这堆结果里切片，
        `TotalRecordCount` = **手里的条数**（"上游里有多少条"无从得知，不编）。
      ③ **跨类型按名次轮流合并**（tv#1, movie#1, tv#2, …）：两份列表各自保留上游的相关度次序。
        曾按 `popularity` 降序合并，**实测是错的**：搜「斗破苍穹」会把一个叫 `111` 的剧排到第 7 位、把真正相关的电影挤下去。
    - **`IncludeItemTypes`**：`Series`→tv、`Movie`→movie，**两个都没给 = 都搜**；`Video`/`Person` 忽略（分集搜索要按剧集层级走，人物不是本项目的条目 —— 不假搜）。
    - **失败**：全失败 → 照实回失败码；一类型失败另一类型有结果 → 回有结果的部分 + 日志写明（部分失败 ≠ 整条失败）。
    - **鉴权**：`Items` 一律校验 token ⇒ 无 token 一律 **401**（实测 `curl` 不带 token → 401）。
    - 实测（路由器）：`斗破苍穹` → **14 条**（剧 + 电影，`{域}_79481_tv` / `{域}_1206282_movie` …，均带图、可点进详情）；
      `律师` + `IncludeItemTypes=Series` + `Limit=5` → 20 条里切 5 条；不存在的词 → **0 条**；
      第 1 次 250~1300ms（看上游抖动）→ **第 2 次 111ms**（走插件那边「名字 → 搜索结果」的缓存，见「本地缓存」那条）。
      ⇒ 客户端侧已生效：日志里紧接着出现 `Items/{域}_241007_tv/Images/Primary`、`{域}_1599184_movie` 等**取图请求**（搜索卡片在渲染）。

  - **`AnyProviderIdEquals={域}.{编号}`**：**按外部 id 搜一条**。
    客户端手里只有一个外部条目号（外部链接 / 书签 / 它自己记着的），**拼不出本面板的 Id**，需要向本面板确认
    「这条在本面板的 Id」；本面板回**一条带 Id 的条目**（`{域}_{编号}_{movie|tv}`，`TotalRecordCount: 1`），
    它拿到就接着打详情。类型从 `IncludeItemTypes` 推（`Series`→tv / `Movie`→movie / 都没给→tv）；
    取不到 **照实回失败码**（不编占位条目）。
    - **它被删过一次又恢复**：曾以「emby 层自己造列表数据、与首页模块口径冲突」为由删掉，
      依据是「实测客户端 0 次使用」。但 —— ① **模块管的是首页渲染**（给客户端什么样的行列、每个条目的 Id），
      **详情 / 搜索 / 播放本来就归 emby 层**；② 删它之后**详情那条路一直在做同一件事**（`richItemDto()` 按坐标反查），
      只会让两条路不自洽；③ 那条「0 次使用」的依据**已被 Rex/0.1.0 推翻**（它连打两条
      `AnyProviderIdEquals={域}.1339713`，回空之后拿不到 Id、链路就断在那儿）。
    - 结论同 `Items/Latest`：某条查询「没人要」**只对当时那批客户端成立**。
    - **多值**（[0041](adr/0041-any-provider-id-multi-value.md)）：该参数**可逗号分隔多个**（Emby 的 OR 语义，同名参数重复也收），
      实测 Rex/0.5.0 打的就是 `tmdb.282326,imdb.tt32500958` —— 原先只认单值的正则把它整个判成「没有可识别的查询参数」，
      于是回空、客户端拿不到 Id，链路断在这里。现在**按序逐个试、先命中先返回**；认不出的候选（前缀不是已注册域、形状不对）
      **只跳过、不作废整条查询**，并在日志里点名；候选都取不到 → 照实回失败码；一条都没认出来 → 仍回空但逐条点名。
      **不猜域**（不做 `imdb.` → `tmdb` 这类别名映射）。候选至多 8 条。
  - **「按类型计数」探针（无 `ParentId` + 单一 `IncludeItemTypes=Movie|Series`）**：
    Rex 等客户端首页**在拿库列表之前**先打两条 `Items?Recursive=true&IncludeItemTypes=Movie|Series&Limit=1&SortBy=SortName&SortOrder=Ascending`
    （除类型外参数完全相同），**只读 `TotalRecordCount`** 当「总统计」（`Limit=1` 是探针痕迹，顺手要的那 1 条它不看）。
    真机就是回该类型的**库总数**（itsmygo：Movie 255 / Series 189；nyamedia：Movie 714 / Series 1635），响应里那一条 `Items` 是本面板**不复刻**的。
    本面板没有按类型的条目索引，取**插件申报的库规模**（`home.libraryTotals()`，与 `Items/Counts` 同一份数据）填 `TotalRecordCount`；
    **`Items` 仍回空**（不给样本条目）。只认**单类型** —— `Movie,Series` 这类多值不猜（无样本）。见 [ADR-0052](adr/0052-items-counts-library-total.md)、「十」#5。
  - **顺带修了一处回归**：`Items/{ItemId}` 详情原本靠「复用列表实现挑那一条」拿电影/剧的元数据，列表改口径后它会 404 —— 现在改成**直接 `richItemDto()` 反查**（季/集仍复用 `getSeasons`/`getEpisodes`）。**"点进去 → 上游反查"这一环不能断**。
  - 条目 Id 由插件给出，**建议**（非强制）是 `{域}_{编号}_{tv|movie}` —— 点进去要靠这个坐标反查（见插件指南「五」）；插件给了别的 Id 也能显示，只是点进去没有资源，**emby 层不兜底**。
  - **条目给 `ImageTags`**：图片端点已实现，所以列表/详情都照给；tag 是**签名 tag**（见下面「图片」那条）。
  - `Filters=IsFavorite` 读 `favorite` 表出**收藏的条目**（见 [ADR-0058](adr/0058-favorite-items.md)）：收藏动作时把列表元数据**快照**落库，读时**快照重建**、**0 上游请求**（不像 `IsPlayed` 的读时反查）；`Filters=IsPlayed` 读 `playback` 表出**已看条目**（见 [0023](adr/0023-playback-progress.md)），因此**要 token**。
  - 响应形状就是 Emby 的 `QueryResult<BaseItemDto>`：`{Items, TotalRecordCount}`。官方定义只有这两个字段（已核实）。
  - `Id` 由条目坐标派生：`{域}_{编号}_tv` / `{域}_{编号}_movie`（带类型是因为上游里 tv 与 movie 是两套数据）。**不含源信息** —— 客户端把它当主键缓存，掺进"哪个站点、哪次搜索"就会因为源变动而变 Id，客户端缓存的「已看」会全丢。
  - `ImageTags` / `BackdropImageTags` 的 tag 是**签名 tag**，内容就是"这张图的完整 URL"，见下面「图片」那条。
  - `UserData` 由路由层 `applyUserData` 按 token 解出的账号补**真实**观看状态：进度（`Played`/`PlayCount`/`PlaybackPositionTicks`）读 `playback` 表（见 [0023](adr/0023-playback-progress.md)），`IsFavorite` 读 `favorite` 表（见 [ADR-0058](adr/0058-favorite-items.md)）；库里没有记录的条目保持空形状。
  - **「轮播推荐位」（无 `ParentId` + `SortBy` 含 `IsFavoriteOrLiked`）**：
    这条 query 喂的是**客户端首页顶部轮播图**（实测 Rex 首页**第一发**，比 `Views` 还早 42ms —— 它在**还不知道有哪些库**的时候就要结果，按库驱动的行不可能这么发）。
    - **怎么认出它**（`service.feedOfQuery`）：**没有 `ParentId`**、且**不命中任何一条已有专属支路**（没有 `Filters` / `SearchTerm` / `AnyProviderIdEquals` / `Ids`，也不是裸列表查询、不是无 `ParentId` 的按类型计数探针）→ 归 `'random'`。**别抢别支**：上述每一条都是各支路的判据，本函数一律让开，让开后各自照旧处理（裸列表回库列表、探针取库规模，其余回空）。
    - **路由到哪一行**：**插件自己声明** —— 清单一行的可选字段 `feed: 'random'`（见插件指南「三」）。
      宿主 `home.rowByFeed()` 找**第一个声明了它的启用行**；**没有插件声明 → 照旧回空**。
      绝不"挑一行顶上"：挑错了等于给出与内容不符的路由，而且哪一行该接这条只有插件作者知道。
    - **语义要说清**：`IsFavoriteOrLiked` 那条 query 的原意是"用户**收藏或喜欢的**、随机"。本支路**只认 `feed: 'random'`**，
      给的是**随机热门**，**不按收藏过滤** —— 收藏列表是**另一条支路**（`Filters=IsFavorite`，读 `favorite` 表，见 [ADR-0058](adr/0058-favorite-items.md)），
      两条判据互不相干。不要在任何地方把这条轮播 query 当作收藏。
    - 它是**受保护端点**：`Items` 一律校验 token，无 token 会 401（此前"回空故豁免"的取向已作废）。
  - **「裸列表查询」（无 `ParentId` + 无 `SortBy` + 不递归）**：
    这类 query 也是**客户端首页**发的（实测 Filmly / 网易爆米花首页即是：只带 `ExcludeItemTypes`/`StartIndex`/`Limit`/`Fields`，无 `ParentId` / `SortBy` / `Filters`）。
    - **回什么**：**回顶层库列表** —— `service.libraryQueryOf()` 命中即 `return getViews()`（复用 `Views` 那支，条目形状、`TotalRecordCount` 与 `Views` 一字不差）。
    - **为什么是库列表**：**予初Emby 4.9.5.0 实测**该形状真机回 **26 个 `CollectionFolder`（＝顶层库列表）**，与 `GET /Users/{id}/Views` 一字不差 —— 真机对「无 `ParentId` 且不递归」的 `Items` 默认回根节点的直接子级（那些库）；要条目客户端须自带 `Recursive=true`。**曾按无样本的推断把它路由到 `feed: 'random'` 回条目（[ADR-0054](adr/0054-bare-items-query-uses-random-feed.md)），与真机相反，已推翻**，见 [ADR-0055](adr/0055-bare-items-query-returns-views.md)。
    - **怎么认出它**（`service.libraryQueryOf`）：**没有 `ParentId`**、**没有 `SortBy`**、**非 `Recursive=true`**，且没有 `Filters` / `SearchTerm` / `AnyProviderIdEquals` / `Ids`，也不是无 `ParentId` 的按类型计数探针。判据取**最窄档**，只命中 Filmly / 网易爆米花那一族，轮播推荐位（带 `SortBy`）等各支路不受影响。
      - **未复测项**：真机只隔离出「无 `ParentId` + 不递归」两个条件，`SortBy` 是否为必要条件未单独验证（真机不稳，未补测）；当前保留 `SortBy` 这一条以零回归。
    - **不再与轮播推荐位共用 `feed`**：`feedOfQuery()` 已收窄回**只认轮播推荐位**；`feed: 'random'` 取值仍在、仍只服务轮播推荐位，插件契约不改。
- **图片（`Items/{Id}/Images/{type}`）**：客户端取图时**只回传 `Id` + `tag`，不回传 URL**，所以 tag 得自己带上"图在哪"：
  - **tag = `cpimg.<base64url(图片URL)>.<签名>`**（`service.imageTag` / `parseImageTag`）。签名 = HMAC-SHA256(密钥, `Id|URL`) 取前 22 位。
  - **为什么要签名**：这个端点**必须豁免 token**（实测图片请求的凭证携带不统一，8 条里 3 条啥都不带），那它就是个"面板代为取任意 URL"的接口 —— 不签名等于把面板变成局域网 / Tailscale 上的**开放代理（SSRF）**。签名绑 `Id|URL`：tag 挪到别的条目上用不了，也造不出新 URL（实测：篡改 tag / 换条目 / 伪造 URL 全部 404）。
  - **密钥 `imageKey`**：首次用到时随机生成、**按实例**落在 `data/emby/instances.json`（多实例之后身份是实例属性，见 `instance.js` 的 `identityOf`），**不随任何 DTO 外发**（`serverId` 是外发的，不能当密钥）。
  - URL 从哪来：**详情/季集**由 `metaBridge.imageUrlOf()` 拼图床地址；**列表/库内容**直接用插件给的 `poster`/`backdrop`（完整 URL，见插件指南「五」）。所以两种来源统一成同一种 tag 形状，端点不必分类讨论。
  - **一律 302**（见 [ADR-0036](adr/0036-image-endpoint-redirect.md)）：面板只回 `Location`，字节全在源站与客户端之间跑；随之删掉了"单张 8MB 上限"与"取图失败 → 502"这两条分支。代价是**客户端得自己连得到图床** —— 早先"面板代为取图"正是为兜"插件给的图地址客户端连不到"，现按需求改掉，取向回到 [ADR-0006](adr/0006-redirect-for-playback.md) 那条线上。
  - **协议背景（关键，不要再重新引入这条路）**：Emby 里 `BaseItemDto` **没有任何"图片直链"字段** —— 图片相关字段只有 `ImageTags`（类型→tag 映射）、`BackdropImageTags`（数组）、`PrimaryImageTag` / `PrimaryImageItemId`（主图的便捷字段）、`Parent*ImageTag`、`PrimaryImageAspectRatio`。客户端**一律自己拼** `{host}/Items/{Id}/Images/{Type}/{Index}?Tag=…`。所以"把直链交给客户端让它自己加载"在协议下**没有这条路**（面板自己的预览页能用直链，那是本项目的 UI，不是 Emby 客户端）。
  - **官方定性：`Tag` 是可选参数**（Images 文档原文："This is an optional parameter. You do not have to specify the tag, but without it you will only receive conditional http response caching."）。它的正经用途是**缓存**：图变了 tag 就变、URL 跟着变，客户端就能无条件永久缓存。本项目的非常规做法是**拿这个缓存字段当数据通道**（把直链 base64 编进去），因为协议里没别的地方能放直链。
  - **Primary 的 tag 有两个存放位置**：`ImageTags.Primary` **和**便捷字段 `PrimaryImageTag`。只填前者时，**读便捷字段的客户端会认为"这张图没有 tag"**，于是裸请求 `Images/Primary`。而 Backdrop 只有 `BackdropImageTags` 一处 —— 这正好解释实测里那个异常现象：**同一个客户端 Backdrop 带 tag（6/6 成功）、Primary 不带 tag（340 次 404）**。修法是 `baseItem()` 里两个字段都填（`PrimaryImageItemId` 一并指向自己）。
  - **补 `PrimaryImageTag` 并没有解决问题**（实测，别再重复这条路）：客户端照样裸请求，200 次全 404。决定性证据是**时序** ——
    ```
    12:33:03.287  ✔ 登录 Lumenic (iPhone)
    12:33:03.291  ✘ 图片 {域}_1423191/Primary 404   ← 登录后 4ms 就要图
    12:33:03.504  ✔ Views → 200                     ← 213ms 之后才拿到列表
    ```
    **要图发生在拿到列表之前** —— 客户端用它**自己持久缓存的条目 Id** 发起请求，这次会话给它的 DTO 根本没参与。所以"给它 tag 它就会带"这个假设不成立：这个客户端（以及很可能同类客户端）**按设计就不读 Primary 的 tag**，而这是合规的（tag 本就可选）。
  - **最终方案：两条取图路**
    | 路 | 触发 | 代价 |
    |---|---|---|
    | ① tag | 客户端把 tag 带回来了、验签通过 → base64 解出 URL | 0 上游 |
    | ② **本地图片索引** | 没带 / 验签不过 → 查 `image_index` 表 | 0 上游 |
    | ③ 都没有 | — | **404** |
  - **图片索引**（`service.tagAndRemember` 写、`service.imageUrlFromIndex` 读）：
    - **写入零成本**：`baseItem()` 本来就在算 tag（URL 就在手边），同时把 `Id|类型|索引 → 图片位置` 记进 `cache.db`。出 tag 与记账绑在**同一个函数**里，两者不可能漂移。
    - **按模块给的 id 记**，不依赖条目坐标 ⇒ **自定义 id 的插件也能取到图**（这条推翻了插件指南里原来那条警告）。
    - **索引里直接存完整 URL** —— 插件给什么就存什么，取的时候原样回；不再拆/拼基地址。
    - 落 `data/emby/cache.db` 的 `image_index` 表，TTL 90 天、上限 5MB（默认，面板可改）。**落库顺带解决了冷启动**：容器重启后索引还在，客户端启动那批缓存 Id 的请求直接命中（实测重启后无 tag 取图仍 200）。
  - **明确不做**：不回退"按条目 Id 反查上游"。那条路随片库规模**线性**烧配额（实测 340 次请求 ≈ 55 次调用，注意这是**元数据账**，与图片字节流量是两回事）—— 走了两个弯才定下来：先补 `PrimaryImageTag`（没用），再拆掉反查（对但没解决问题），最后用零成本的本地索引。
  - 日志会区分来源与成因：成功时 `（索引）` 表示走的是第②条；404 时会写明「客户端没带 tag」/「tag 非本面板格式」/「tag 验签不过」，并注明索引也没有。
  - **签名仍是这里唯一的 SSRF 防线**：端点豁免 token，URL 只认签过的（第①条）或自己记过的（第②条），客户端造不出新 URL。

- **详情页"丰富度"（一次性补齐）**：详情的元数据来自上游的 `lookup({rich:true})` —— **一次请求**带上 `append_to_response=credits,external_ids,keywords,videos,images,recommendations`（电影再加 `release_dates`、剧加 `content_ratings`），把下面这批一起拿回来（`service.applyRich`）：
  | 详情页上的东西 | Emby 字段 | 数据来源 |
  |---|---|---|
  | 年龄分级徽章 | `OfficialRating` | 电影 `release_dates`、剧 `content_ratings`（优先美国，没有就取第一个有值的） |
  | 时长 | `RunTimeTicks` | 电影 `runtime`、剧 `episode_run_time[0]`；1 分钟 = 6×10⁸ ticks |
  | 标语 | `Taglines[]` | `tagline` |
  | 演职人员 | `People[]`（**带 `Id`，有头像的还带 `PrimaryImageTag`**） | `credits`：演员前 20（`Role` = 角色名），幕后只要导演/编剧（翻成 Emby 的 `Type`）；`Id` = **上游人物 id**（是**真 id**，不是编的） |
  | 制片公司 | `Studios[]`（`{Id, Name}`） | `production_companies[]`；`Id` 是**数字**（上游公司 id），且按 Id **去重**（上游实测会把同一个公司给两次） |
  | 出品国家 | `ProductionLocations[]` | `production_countries[].name` |
  | 题材关键词 | `Tags[]` | 电影是 `keywords.keywords[]`、剧是 `keywords.results[]`（**上游两处形状不一样，注意区分**） |
  | 预告片 | `RemoteTrailers[]` + `TrailerCount` | `videos` 里 YouTube 的 Trailer/Teaser |
  | 外部链接 | `ExternalUrls[]` | 见下条 |
  | 片名艺术字 | `ImageTags.Logo` | `images.logos`（按语言挑，退化到无语言那张） |
  | 多张背景图 | `BackdropImageTags[]`（最多 8 张） | `images.backdrops` |
  | 可点的类型 | `GenreItems[]`（`{Id, Name}`，**`Id` 是数字**） | `genres[]`（上游的 genre id 本身就是数字，**别给字符串**） |
  | 相似推荐 | 走 `Items/{id}/Similar` | `recommendations`（同一次请求就带着，不额外打） |
  - **外部链接（`ExternalUrls`）—— 按真机补齐，同时去掉 Trakt**：真机的**名字与顺序**固定（实测电影与剧集两条都抓过）：

    | 名字 | 电影 | 剧集 | 怎么得到 |
    |---|---|---|---|
    | `IMDb` | 是 | 是 | 上游的 `external_ids.imdb_id`（**列表接口不给**，所以详情才有） |
    | `TheMovieDb` | 是 | 是 | 条目编号本身 |
    | `TheTVDB` | — | 是 | 上游的 `external_ids.tvdb_id`（**只有剧有**） |
    | ~~`Trakt`~~ | 否 | 否 | **刻意不给** —— 见下 |
    | `官网` | — | — | 上游的 `homepage` —— **真机没有这一条**，但它是真 URL，保留（放在最后） |

    - **Trakt 为什么去掉**（实测）：真机给的是 `https://trakt.tv/search/<上游名>/{id}?id_type=movie|show`，
      而 **Trakt 已经把这条深链下架了** —— 电影、剧集、`search/imdb/tt…` 三种形状实测**全部 404**
      （`404: Nothingness. The void.`），同站一个**有效**路由（`/shows/breaking-bad`）却正常 200
      ⇒ **是路由被删，不是被墙、也不是 UA**。
      Trakt 的条目页要用**它自己的 id / slug**，手上只有上游编号 / imdb 号，**造不出能用的直链** ——
      那就**不给**：发一条必 404 的死链比不发更差（同「不知道就空字段」的口径）。
      **哪天 Trakt 又支持了、或者能拿到它自己的 id，再加回来。**
    - **列表项也给**（真机列表项就有）：只有 `TheMovieDb` 一条 —— 列表接口没有 `imdb_id`/`tvdb_id`，**IMDb 不编**（不知道 tt 号就是不知道）。
    - IMDb 的 URL **结尾没有斜杠**（`…/title/tt41332009`）—— 原先多带了一个 `/`，已对齐真机。
    - 其余几条**都实测过能打开**：IMDb（浏览器正常）、TheMovieDb（电影/剧/季三种形状都 200 且标题对得上）、TheTVDB（200）。
  - **`SpecialFeatureCount: 0`**：真机**电影**条目列表与详情都带它（值 0，本项目没有花絮这类附加内容）。真机的**剧集**条目不给这个字段 —— 给了也无害（真机自己都不保证有）。
  - **`UserData` 去掉 `Key`**：真机条目是 `{IsFavorite, PlayCount, PlaybackPositionTicks, Played}`、**库条目**是 `{PlaybackPositionTicks, IsFavorite, Played}`（少 `PlayCount`）。原先多给一个 `Key`，真机既然不给，客户端就不可能依赖它 ⇒ 删掉；库条目单独一个 `emptyViewUserData()`，别复用条目的。
  - **简介放宽**：详情用 2000 字上限（列表仍用 400 —— 列表只要够画卡片）。
  - **上游的一处行为**：只要同时给了 `language` 和 `images`，它就把 images **按语言过滤** —— logo 一定带语言标记、背景图大多不带，结果两边都空。所以必须显式带 `include_image_language=null,<语言>`。
  - **刻意没做**（都写了理由，免得以后反复琢磨）：`OriginalLanguage`（上游给 2 位码、Emby 要 3 位码，映射表易错且客户端基本不显示 —— **又添一条硬证据：真机自己也不返回它**，带 `Fields=OriginalLanguage` 请求真机照样没有，所以加了反而偏离真机）；`CriticRating`（上游没有媒体评分）；`ScreenshotImageTags`（上游没有独立的"截图"类别，那些就是背景图）；合集 Boxset（Emby 里是另一类条目）；**`ExternalUrls` 里的 `Trakt`**（默认给的那个格式实测 404，造不出能用的直链 —— 见上面「外部链接」那条）。
  - **演职人员：`Id` 必须给，头像顺带做通**（**推翻了原来"不给 Id"的决定**）：
    - **`Id` 用上游人物 id**。原来刻意不给，理由是"人物不是本项目的条目，给了 Id 客户端就会去点、去要人物图片"。
      但真机 `People[]` **每条都带 `Id`**，而 **`People` 正在 SenPlayer 的 `Fields` 清单里** ——
      缺这个键会让客户端的解码器**整条响应失败**（表现成「网络错误/不存在该项目」），代价远大于收益。
    - **头像**：有 `profile_path` 的给 `PrimaryImageTag`，值由 `tagAndRemember(personId,'Primary',0,…)` 生成 ——
      **复用已有的图片端点**（`Items/{Id}/Images/{type}`），**不需要新增路由**：带 tag 走签名快路径、
      不带 tag 走本地索引，两条都通。**没有头像的就不给 tag**（客户端只在有 tag 时才去取图，不承诺就不产生 404）。
  - **`GenreItems` 给了 id 就等于承诺「点类型能进列表」** —— 那个端点**还没实现（会 501）**。这是**刻意**的"先给承诺、看客户端要什么"（当年 `ImageTags` 就是这么把图片端点逼出来的）。
    **`People[].Id` 同理**（点人物也会 501）—— 但它已经不能算是"刻意承诺"了，而是**必须给的**（见上条）。

- **条目 DTO 的「结构性字段」（按真机 Emby 4.9.5 逐项补齐）**：起因是
  **SenPlayer 详情页打不开**（拿到 `200` 却不再往下走、提示「网络错误/不存在该项目」），
  而换成真机响应就正常 ⇒ 缺字段会让客户端**整条解码失败**。判据与要求见「四」。
  - **条目级**（`service.baseItem`，列表项也受益）：`Etag` `SortName` `ForcedSortName` `PartCount`
    `Chapters` `TagItems` `LockData` `LockedFields` `CanDelete` `CanDownload` `LocalTrailerCount`
    `DisplayPreferencesId` `PresentationUniqueKey` `DateCreated` `DateModified`。
    ⚠️ 其中 `CanDownload` **跟随实例级「下载」开关（默认开）**，与握手 `Policy.EnableContentDownloading`、
    `Items/{ItemId}/Download` 端点**三处同一口径** —— 否则客户端"照 policy 去试、又按条目不提供下载入口"
    （实测 SenPlayer 就是照前者试了 8 次）。开关在产品上默认开（见 [ADR-0049](adr/0049-emby-instance-download-switch.md)），
    关掉时三处一起拒。**库条目**（`CollectionFolder`）那条**恒为 `false`**：文件夹下不了，真机也是 false。
    `CanDelete` 一律 `false`（删除确实没有）。
  - **条目级「线路派生」**（`getItem` 拿到线路后才补）：`Container` `Size` `Bitrate` `MediaStreams`
    `Width` `Height` `Path` `FileName`（`FileName` 用**源给的真文件名** `target.name`，不是版本副标题）。
    `Width`/`Height` 取自所选线路视频流的 `Width`/`Height`（数据源是**片源插件申报的 `width`/`height`**，
    见插件契约；**插件没给就没有这俩字段** —— 面板不从集名正则反推）。
  - **MediaSource 级**：`ItemId` `Chapters` `Formats` `RequiredHttpHeaders` `IsInfiniteStream`
    `ReadAtNativeFramerate` `HasMixedProtocols` `AddApiKeyToDirectStreamUrl`
    `RequiresOpening`/`Closing`/`Looping`（原有的 `VideoType` 已删 —— 真机没有）。
  - **MediaStream 级**：`AttachmentSize` `IsExternal` `IsForced` `IsTextSubtitleStream`
    `SupportsExternalStream`；视频另加 `AspectRatio`（宽高比**化简**成 `240:101` 这种）。
  - **`Etag` 是内容哈希**（`md5(名字+简介+上映+时长+分级+图片tag)`）—— 它必须**随内容变**，
    客户端才肯刷新缓存。**不是**由 Id 派生（那样内容变了 Etag 不变，客户端会一直吃旧缓存）。
  - **`DateCreated`/`DateModified` = 上游发行日期**；拿不到发行日期（插件行只有 `year`）就
    **不给这两个字段**。真机给的是**文件**的创建/修改时间 —— 本项目没有文件，这是"用上映日期近似"，
    语义如实记着。**佐证它非必需**：列表项一直没有这两个字段，而列表一直渲染正常。
    · **另一条路已否**：用"**条目首次见到的时刻**"当 `DateCreated`（当时真在 `cache.db` 里建过一张
      `item_seen(item_id, first_seen)`、写过 84 行）。**别再试它** —— 已否，改成用发行日期；
      那张表与它的数据已删除。
  - **`PremiereDate` / `Overview`：拿不到就不给这个键**（口径同上面的 `DateCreated`）。
    · **`PremiereDate` 是 DateTime 字段，绝不能写空串** —— 客户端对它做 `DateTime.parse(value)`，
      `parse('')` 抛 `FormatException`、**整条响应解码失败**（实测 Hills 1.9.1 报 `Invalid date format`
      即此）。真机拿不到就不含该键。见 [ADR-0061](adr/0061-omit-missing-scalar-fields.md)。
    · **`Overview`** 同理：空简介无意义，省略即"没有"。详情路径的 `applyRich` 本就是"有才覆盖"、同款口径。
  - **`ParentId`**：列表项 = **它所在的那个库（准确值）**；详情/相似**没有库上下文**
    （实测 SenPlayer 的详情请求连 query 都不带）⇒ `defaultLibraryId()` 兜底第一个启用的行。
    那是 **best-effort，不是事实** —— 同一部片可以同时出现在多个库里（`trending` + `top_rated`）。
  - **`Path` 一律给相对路径**（`/Items/…`，客户端把它拼在自己的 base 之后；见 [ADR-0062](adr/0062-relative-playback-urls.md)）：不去猜客户端用的是哪个主机/协议，
    所以 `getItem`/`getPlaybackInfo` 与 `buildMediaSource` 都**不再需要** `host`/`proto`。
  - **实测**（路由器，真实数据）：字段数 **54**（真机 48 + 本项目几个额外的）；对真机**逐项不缺**。
- **季列表（`Shows/{Id}/Seasons`）也是占位**：数据来自**同一个**上游接口（`GET /tv/{id}` 的响应里本来就有 `seasons[]`，不额外多打一次），**不加缓存，每次请求硬查**。
  - **季 Id 派生**：`{域}_{编号}_tv_s{n}`。派生与解析是一对（`metaBridge.itemId` / `metaBridge.parseItemId`），**代码里必须挨着放**，改格式时一起改 —— 否则发出去的 Id 回不来，客户端拿到 404。
  - **特别篇（`season_number === 0`）照真机返回**（见「十」#7-1）。注意上游的季 `name` 是**本地化文案**（zh-CN 下特别篇显示为「特别篇」，en-US 是 "Specials"），**判定只能看 `season_number`，绝不能匹配名字**。
  - 实测：`number_of_seasons` **不含**特别篇（GoT 上游返回 s0~s8 共 9 条，字段报 8）→ **只有常规季（`IndexNumber > 0`）的条数**与 `seasonCount` 对账，特别篇另算，不会把特别篇当成"多出来的一季"。
  - 季的 `Genres` 回空数组：上游的 season 对象没有 genres 字段，**不套用剧的**（如实，不编）。
  - 季海报缺失时回退用剧的海报（`s.posterPath || show.posterPath`），免得客户端显示白块。
  - **上游失败 → 照实回失败码**（与 Items 同一取向，见上面的映射表）。曾试过「回 200 空列表」，改成照实回是因为空列表会把"上游挂了"伪装成"这部剧没有季"。
  - Id 不是剧（如 `{域}_550_movie`）→ **404**：说明客户端拿了错的 Id，静默回空会掩盖问题。
  - `UserId` 在这条请求里是 **query 参数**（`&UserId=…`），不在路径里 —— 与 `Users/{UserId}/Items` 的写法不同。**只验 token、不比对 UserId**（7-2 起对齐真机）：真机在「有效 token + 合法但不存在的 UserId」下仍回 200，故把它降为**进度兜底**（`applyUserData` 按 token 解出的账号补观看进度，认不出才用 `UserId`）。
- **分集列表（`Shows/{Id}/Episodes`）也是占位**：数据来自 **season 接口** `GET /tv/{id}/season/{n}` —— 剧接口只有 `seasons[]` **汇总**，**没有** `episodes[]`，所以这条必须单独多打一次上游。
  - **入参**：路径 `Id` = 剧 Id（`{域}_{编号}_tv`）；`UserId` 与 `SeasonId` 都在 query，其中 `SeasonId` 就是上一步 Seasons 发出去的那个季 Id（`{域}_{编号}_tv_s{n}`）；`EnableTotalRecordCount` 与一长串 `Fields` 忽略（只回手里有的）。
  - `UserId` 在这条请求里是 **query 参数**（`&UserId=…`），不在路径里。**只验 token、不比对 UserId**（8-2 起对齐真机）：真机在「有效 token + 合法但不存在的 UserId」下仍回 200，故把它降为**进度兜底**（`applyUserData` 按 token 解出的账号补观看进度，认不出才用 `UserId`）。
  - **路径里给「季 Id」也算数**（依据是面板日志 + 真机实测）：
    官方文档写的是 `Id` = 剧，但**真机**（`emby.example.com`）实测
    `Shows/{季Id}/Episodes?SeasonId={季Id}` **回 200**（212 条，与剧 Id 那条一模一样）；
    而 **Lumenic/1.0.0 打的就是这种**（面板日志里 3 次 `Id 不是剧 → 404：{域}_79481_tv_s5`）。
    季 Id 里本来就带着剧号与季号，信息不缺 ⇒ 现在认它：**季号以路径为准**（它更具体），
    并在这条日志里写明「路径给的是季 Id」；**若路径季号与 `SeasonId` 的季号不一致**，以路径为准并额外记一句
    （不一致本身说明客户端与本面板的 Id 认知可能漂了）。实测：季 Id 当路径 → 200/219 集（不带 `SeasonId` 也认）；
    剧 Id 当路径 → 200/219 集（回归不变）；**集 Id 当路径 → 仍 404**；路径 S1 + query S5 → 按 S1 回并记日志。
  - **分集 Id** = `{域}_{编号}_tv_s{n}_e{m}`。`itemId()` / `parseItemId()` 已同步支持 `_e{m}`，并强制**集号必须挂在季号下**（`{域}_x_tv_e3` 这种解析返回 `null`）—— 派生与解析仍然互逆。
  - **季定不下来就回空（200）+ 日志写明原因**：没带 `SeasonId`（且路径也没给季）、`SeasonId` 认不出、`SeasonId` 不属于这部剧 —— 都回空 `QueryResult`。与 Items 同一思路：**先把客户端的真实调用逼出来**，不为没见过的形态现编数据。
  - 路径 Id 不是剧/季（如 `{域}_550_movie`、集 Id）→ **404**（与 Seasons 一致；静默回空会掩盖问题）。
  - **分集字段**：`IndexNumber`(集号) / `ParentIndexNumber`(季号) / `SeriesId` / `SeasonId` / `SeasonName`；`IsFolder=false` —— 集不是容器，而 `baseItem()` 默认给 `true`，**必须显式改掉**；`Primary` 图用**剧照** `still_path`，因此 `PrimaryImageAspectRatio` 改成 16:9 的 `1.7777778`（海报是 0.667）；`runtime` 有值才填 `RunTimeTicks`（1 分钟 = 6×10⁸ ticks），未定档的不编时长。
  - **填 `SeriesName`（剧名）**：真机每条集都带（见「十」#8-3）。取法是照 `progressItem` 的做法**再 `lookup` 一次**剧接口取剧名 —— 走**元数据插件自己的缓存**，实际不额外打上游；查不到只少这一个可选字段，**不影响主结构**（回退原则，见「四」）。
  - **上游失败 → 照实回失败码**（与 Items / Seasons 一致，见上面的映射表）。
  - 实测（Rex-Standard）：`Shows/{域}_95350_tv/Episodes?SeasonId={域}_95350_tv_s1` → 200、8 集，首集 `Name=试播集`、`PremiereDate=2026-08-16T00:00:00.0000000Z`。
- **单条详情（`Users/{UserId}/Items/{ItemId}`）—— 元数据来自上游，源绑定走聚合层（本面板自己）**。客户端点进某一条（剧 / 季 / 集）时来要，返回**单个 `BaseItemDto` 本体**（不包 `QueryResult`）。
  - **元数据**：按 Id 的层级直接**复用列表实现**（集→`getEpisodes`、季→`getSeasons`、剧影→`getItems`）再挑出那一条，**不重复组装逻辑**，形状与列表里那条完全一致 —— 客户端就是按发出去的 Id 回查的。
  - **线路 + 源绑定**：用上游的**影视名**（剧名，另有年份消歧）调聚合层 `detail()` —— 那个函数**内部含搜索**（挑同名 → 取站源 `/detail` → 拆线路），所以 emby 层**一次调用拿回线路与定位**，一个字节的 `$$$` / `#` / `$` 都不碰。是**进程内直调**（`require('../agg/api')`），地址不再有"配不配"的问题。给它的就是**名字 + 年份 + 季集**（不再传条目坐标 —— 挑片判据换成了聚合层自己的打分，见下条）。
  - **站源名字对不上时怎么找：本地打分**（**取代了早先的上游别名回退**）
    - 为什么换：原来的判据是"归一化后完全同名"，对不上就拿**源的原始标题**去上游反查。实测坏在**输入**上 ——
      源的标题常写成 `斗破苍穹年番4更211[2025][动漫]` / `…4K臻彩中字【1GB/集】更211集`，这种拿去上游查不到
      ⇒ 同名 0、回退 0 ⇒ **版本列表空**（Emby 里表现为"条目在、点开没版本"）。
    - 现在：搜索这一步就给每条结果打分（`server/modules/agg/match.js`）——
      **名字 0.7 · 季集 0.2 · 年份 0.1**，缺的项**不进分母**（源里常常没季集/年份，按"缺=0"算会把名字全对的条目也压到阈值以下）。
      分项：名字（清洗后相等 1.0 / 主干同名 + 受控限定词 0.95 / 其余按 LCS 相似度）、
      季集（`更211` / `更新至211集` / `第N集` / `EP14` / 季号；对不上只给 0、不扣分）、
      年份（标题里的四位数字，差 1 年算 0.6）。
    - **两道闸门**：① **名字硬拒**（清洗后没有公共主干、或相似度 < 0.5 → 直接出局，拦 `斗破苍穹4：逃亡`、`斗破苍穹·止戈`）；
      ② **分数线** `matchMinScore`（默认 0.85；**填 0 = 不筛选**，那就只按分数排名取前 `matchMaxItems` 条）。
    - **片源认证（`vod_exact`）短路在打分之前**：候选行若带 `vod_exact === true`（片源插件自行认准
      「这条就是目标作品」），面板**直接记分数 1、不判名字**，两道闸门都不走 —— 其余流转不变
      （仍受分数线与 `maxItems` 约束，只因分最高排最前、优先取详情）。这是插件在候选行上的
      **声明性标注**，判据实现仍在 `match.js`；契约在插件仓库 `docs/plugin-contract.md`，决策见
      [ADR-0059](adr/0059-source-certified-candidate.md)。典型场景：番号站按番号精确过滤后的候选，
      避免长标题把番号的相似度稀释掉而误拒。
    - **为什么限条数**：每条命中后面都要打一次站源 `/detail` 取链 —— 不限就是十几秒（实测 3 条 ≈ 2s）。
      阈值与条数在「聚合设置 · 模板」里改（web 的「聚合搜索」页只决定"搜什么"，不填这两项）。
    - **不去重**：同名的几条各有自己的 `vod_id`，谁能播要取过 `/detail` 才知道 ——
      按分数猜一条留、把别的丢掉就是"同名反而匹配错"的来源。所以源给了几条就算几条，只在
      `match.sameNameSameSite` 里数一下（诊断用）。
    - 诊断：日志 `✔ agg 打分「斗破苍穹」：扫 121 条 → 命中 3（分数线 0.85，上限 3）；没进：低分 33 / 超上限 0 / 名字不过闸 40；同站同名 45 条（照收，不去重）`；
      API 出参有 `match{…各桶计数}` 与 `unmatched[]`（带分数与原因）。
    - **接续补打 = 前面一条能用的都没拿到时才兜底往下打**：命中 ≠ 能播 —— 前
      `matchMaxItems`（N）条取详情后**一条能用的都没有**（空壳没线路、或集名定位不到这一集）时，
      按分数**继续往下打，最多再试 `matchExtraK`（K）条**，**整批并发、第一批拿到就不再发第二批**；
      K 填 0 = 不补打（默认 8，即前 8 条都没拿到能用的就补打）；`matchExtraAll` 开关 = **匹配到底**（不看 K，直到拿到一条或名单打完，可能很慢）。
      补打的能用的条目里**第一条当"代表"**（`picked.matchedBy = 'score+extra'`），其余进版本列表。
      诊断：`stats.targetN / matchUsable / extraTried / usableExtra`，日志 `↻ agg 接续补打：…`。
      前面只要有能用的就**一次都不补**（实测：首条可用 → 日志里不出现补打那一行）。
    - **仍然没有的，就如实为空** —— 不编、不回退到"随便挑一条"。
  - **命中落在三处**：
    - `ProviderIds.MediaBridge` = **所有命中站的绑定**，`<站点key>|<vod_id>` 用 `;` 分隔（多站之后不再只有一个）；
    - 非标准字段 `MediaBridgeSource`：老字段（`Site` / `SiteName` / `Api` / `VodId` / `VodName` / `VodPic` / `VodRemarks` / `Lines` / `Target`）取**第一个命中站**（兼容既有读取），新增 **`Sites`** 放**全部命中站**的同一套明细。客户端会忽略这个字段，纯给面板与日志核对；
    - **`MediaSources` —— 线路就是 Emby 的「版本」**：**命中站的每条线路都映射成一个版本**（已决定「去掉 picked 直接全部」，多站的线路全列出来），`Id` = `mbp:` + base64url(deflateRaw(JSON `{r: ref}`))（`mbpSourceId()` —— **站点与该站自己的 vod 都必须编在 Id 里**：客户端播直连时只回传这个 Id，播放那一格靠它回查那个站。**而且必须整体编码**：客户端把 Id 拼进 query 时不编码 `#`，而线路名里就有 `#`（如 `夸克原画#01`），于是 `#` 之后的 `01|<vod>` 被当成 URL 锚点**根本发不到服务端** → 服务端收到一个没有 vod 的 Id → 400，客户端反复重试。**实测**：`nodejs_wogg` 的线路名带 `#`，e1/e2 各失败 **34 次**；`nodejs_muou` / `nodejs_huban` 的线路名不带 `#`，一路正常 —— 这就是「有些能播、有些播不了」的全部原因。base64url 字符集只有 `[A-Za-z0-9_-]`，客户端编不编码都是同一串，**免疫**）；`Name` 与视频流 `DisplayTitle` = **`站点标签 · 线路`**，**同站其余命中条目再挂一段 ` · <变体标注>`**（变体＝**同一个站里其余被判定为同一部片的条目** —— 即"同片别名变体"这条口径；如 `虎斑|4K · 夸克原画 · 4K 偷跑`；站点用完整 `name`，如 `木偶|4K` —— 多站之后线路名会撞，必须带站点才分得清）。**「集」与「电影」都给** —— 剧/季是容器，给了会让客户端以为能播（电影那套见下面「电影也能播」）。
  - **电影（`{域}_{编号}_movie`）也给版本列表**：站源里电影就是「一条线路 + 若干播放项」，与剧集**同构**，只是**没有季集号**。
    - **电影取法 = `pick: 'items'`**（emby 层 `wantLocator()`）：聚合层把**每条线路下的每一个播放项**都算成一个可播目标 —— 同一部片的多个压制版本（`5.0GB 1080p` / `4.4GB` / `1.6GB` …）因此各自成为一个版本，由客户端自己挑。可播性判定收在 `isPlayable()` / `isPlayableId()`（集 = `Episode` 带季集，电影 = `Movie` 不带季集）。
    - **版本 Id 多一个 `i`**（该线路下的第几个播放项）：`Id` = `mbp:` + base64url(deflateRaw(JSON `{r: ref}`))，项序号 `i` 在**插件编的那串 `ref` 里**（见 [ADR-0030](adr/0030-play-address-handoff.md)：面板不解释 `ref` 的内容）。`resolveStream` 按 `i` 取项，与拼版本列表**同一口径**，否则会出现"版本列出来了、点了 404"。
    - **为什么不再借 `S1E1` 定位**：电影文件名里没有集号（只有体积 / 年份 / 分辨率 / 编码），而剧集那套定位三条路全是"按集名里的集号匹配"。实测 20 部上游首页电影里 **19 部一条都定位不到**（源里有 4~20 条线路，`target` 却全空）⇒ 客户端版本列表恒为 **0 条**。改动前的诊断字段里 `matchedBy` 是 `sequence`、日志写「电影第 1 项（借 S1E1）」；那个"按选集序号"的规则其实早已被 `locateEpisode()` 的 ③ 取代。
    - 代价如实记着：**版本数 = 线路 × 项**（实测「生化危机：爆发夜」经 `play.filter` 的 `夸克` 过滤后 **10 个版本**、不过滤 26 个）；若某条线路把「预告」与正片并列，预告也会成为一个可播版本 —— 不猜、不挑，由客户端自己选。
    - 实测：`Items/{域}_969681_movie` → **6 个版本** —— `虎斑|4K · 夸克原画` / `… · 夸克极速` / `… · 臻彩` / `… · 4K 偷跑`（代表 6 条 + 臻彩 2 条 + 4K 偷跑 2 条 = 10 条线路，经 `play.filter` 的 `夸克` 过滤后留 6 条，`LineFilter={Pattern:"夸克", Total:10, Kept:6}`）。
  - **同片变体（`（臻彩）` / `（4K 偷跑）`）也进版本列表**（「**收变体 + 标注来源**」）：站源里同一部片常有**多个独立条目**（各有自己的 `vod_id`），名字只在括号里差一点。聚合层 `pickByName()` 除"完全同名"（`sameName`）外，还会挑出**基础名相同**（`normBase()` —— 去掉**首尾**括号段后归一化）而名字不同的条目当 `variants`，逐条取详情；emby 层把**代表 + 变体**的线路**全部**展开成版本，标题位挂上括号里那截（`variantLabel()`）。**不加后缀不行**：同一部片的两个条目常常线路名完全一样（`虎斑|4K · 夸克原画` × 2），不标注就又变成"分不清哪条是哪条"。
    - 数据落在 `sites[key]`：代表仍占 **`detail`**（向后兼容，老消费方/面板不受影响），变体放 **`variants[]`**（`{variant:true, label, vodName, vodId, detail}`）；诊断字段 `MediaBridgeSource.Sites[].Details` 列该站的**全部条目**，老字段（`VodId` / `VodName` / `Lines` / `Target`）仍取**第一条**。
    - **"多条完全同名"（不同年份的翻拍）不算变体** —— 那边仍按规则②只取一条（年份优先），否则会把两部翻拍混进同一份版本列表。
    - **变体的线路一并展开 ⇒ 版本数按条目数倍增**（实测这部电影：代表 6 条 + 臻彩 2 条 + 4K 偷跑 2 条 = 10 个版本），所以标题位的变体后缀是必需的，`play.filter` 也可以用来收窄。
    - 实测：`agg/detail {"name":"蜘蛛侠：崭新之日","season":1,"episode":1}` → `stats={sameName:1, variants:2, detailOk:3, detailFailed:0}`，`sites.nodejs_huban` 三条 `vodId` 各不相同（`…/499280.html` 代表、`…/500071.html` 臻彩、`…/500069.html` 4K 偷跑），各自定位到自己的播放项。
  - **`MediaSources[].Path` 刻意留空**：播放地址会过期，留到 **PlaybackInfo** 那一步按 `MediaSourceId` 现取（聚合层 `POST /api/agg/play`：`{site, flag, episodeId}` → `{urls, header, parse}`）。**待实测**：客户端会不会显示没有 `Path` 的版本。
  - **季集定位归聚合层**：站源的集是扁平列表（`第1集…第N集`），没有 Emby 的 S/E 概念。聚合层按「集名里的 `第X季第Y集` / `SxEy` → 第 1 季按选集序号 → 集名只写集号」三级顺序定位，并**必须回 `matchedBy`**；定位不到就 `Target: null` + `TargetNote`，**不猜**。
  - **聚合只做补充，失败不降级成错误**：连不上 / 没配 / 没同名 / 站源没详情 → **元数据照常 200 返回**，日志写明原因（详情页不至于打不开）。这不与「上游失败照实回失败」冲突：**元数据是主体，线路是附加**。
  - **认不出的 Id 不静默吞掉**：路径形状与它相同、但不归它的请求 → 沿用通配那套，**记日志 + 501**（共用 `notImplemented()`）。
    **但「形状相同」的已实现端点必须注册在它前面**，否则会被这个 `:itemId` 吞掉 —— `Users/{id}/Items/Resume` 就出现过这个问题（此前它 501 就是因为落进这里、`parseItemId('Resume')` 认不出）。**同形状的路由，具体的排前面。**
  - 实测（三个启用站全命中）：`Items/{域}_95350_tv_s1_e1` → 200：`ProviderIds.MediaBridge=nodejs_huban\|/index.php/vod/detail/id/500036.html;nodejs_wogg\|/voddetail/130077.html;nodejs_muou\|/index.php/vod/detail/id/8471.html`、`MediaBridgeSource.Sites` **3 个站**（各自 `Lines` 为 6 / 12 / 6 条）、`MediaSources` **24 个版本**（`虎斑|4K · 夸克原画` … `玩偶|4K · 夸克原画#02` … `木偶|4K · 夸克原画`）；日志：`id=… → 3 站命中（nodejs_huban/nodejs_wogg/nodejs_muou） 24 线路，3 条目定位到 S1E1`。剧与季同样拿到 `Lines`，但**不给** `MediaSources`。

- **播放（`PlaybackInfo` + `Stream`）—— 线路即版本，Path 只放稳定坐标**
  - **`MediaSources` 每条线路给全**（客户端靠它决定能不能直连解码）：`Id` / `Name` / `Path` / `Protocol` / `Type:Default` / `IsRemote` / `VideoType:VideoFile` / `Container` / `Size` / `RunTimeTicks` / `Bitrate` / `SupportsDirectPlay|DirectStream|Transcoding` / `RequiredHttpHeaders` / `DefaultAudioStreamIndex` / `MediaStreams`。**字段形状按真实 Emby 服务端的输出来对齐**（逐字段差异见下面「多版本字段对照」）。
    - **规格类字段全部来自源在集名里的标注**，由聚合层 `parseEpisodeMeta()` 解析 —— **能提取的全部提取**（既定要求）：容器 / 体积 / 分辨率 / 视频编码 / 档位（`Main10`）/ 位深（`10bit`）/ 帧率（`60fps`）/ 动态范围（`DOVI`｜`HDR10+`｜`HDR10`｜`HDR`｜`HLG`）/ 音频编码 / 声道布局（`5.1`→6、`7.1`→8）/ Atmos。例：`[1.8GB]…2160p…H.265.DV.HDR.DDP5.1.Atmos.mkv` → `mkv` / `1932735283` / `3840×2160` / `hevc` / `DOVI` / `eac3` / `5.1` / `6` / `atmos`。
    - **视频流的 `DisplayTitle` = `站点标签 · 线路`**（完整的站点 `name`，如 `木偶|4K · 夸克原画`）—— 它是客户端「版本列表」那一行的**标题位**。实测（Rex）：不给这个字段时客户端拿 `VideoRange` 自己拼出 "Dolby Vision"，多条线路全显示成一模一样；`MediaSources[].Name` 填了它也不读。**多站之后必须带站点**（`夸克原画` 好几个站都有），而且**无论源有没有标规格都要建这条视频流** —— 否则没规格的线路会丢掉标题位（实测 24 条里曾有 4 条为空，见 `buildMediaSource`）。为什么不像真实 Emby 那样给规格串 —— 见下面「多版本字段对照」。
    - **动态范围两处一起给**：`VideoRange` 用 Emby 的词表（`DOVI → DolbyVision`、HDR 系 → `HDR`、`HLG → HLG`），细类放 `ExtendedVideoType`（`DolbyVision`｜`HDR10Plus`｜`HDR10`｜`HLG`）—— 只写 `HDR` 但没说是哪一种的**两边都不给细类**（可能是 HLG，猜就错了）。色彩三元组（`ColorSpace` / `ColorPrimaries` / `ColorTransfer`）**是规范定的、不是猜**：DV/HDR10/HDR10+ 一律 `bt2020nc` + `bt2020` + `smpte2084`，HLG 用 `arib-std-b67`；只写 `HDR` 的不给（传输函数定不下来）。
    - **码率是算出来的、标注了近似**：`Bitrate`（源级）与视频流 `BitRate` = `Size×8 ÷ 时长`（时长取上游的 `RunTimeTicks`）。源标的体积本身就是近似值，而且这算的是**整条流的平均码率**（音视频分不出来）——所以按"整条流"的口径同时给两处，缺体积或缺时长就都不给。
    - 音频流给 `DisplayTitle`（编解码 + 声道 + Atmos，如 `EAC3 5.1 Atmos`）、`Channels`、`ChannelLayout`，并让 `DefaultAudioStreamIndex` 指向它 —— 与真实 Emby 同款式（真实 Emby 是 `English EAC3 5.1 (默认)`，**语言本项目没有，不编**）。
    - **每条线路各自定位各自那一集**（不同线路的集名/顺序可能不同），所以规格是按线路给的，不是全剧一套。
    - 解析不出来的字段**一律留空**（`Container:''`、没有 `Size`、`MediaStreams:[]`），**绝不补默认值** —— 给假的比不给更有害。
  - **`Path` 不放源的真实地址**，而放**本面板的 Stream 端点**，形状 `/Items/{ItemId}/Stream/{base64url(版本 Id)}/{标准文件名}`（见 `service.streamPath` / `buildMediaSource`）。**给相对路径**：不带主机、也不带 `/api/emby` 前缀 —— 客户端把它拼在自己的 base 之后（base 已含 `/emby`），去前缀后 base 是 `/emby` 还是 `/api/emby` 都能命中（见 [ADR-0062](adr/0062-relative-playback-urls.md)）。季集号不放进去 —— Stream 路径里的 `ItemId` 解开就有。这样一个 Path **永久有效**，与源地址、时效 token 彻底解耦。
    - **为什么用 base64url 编版本 Id、末段放「标准文件名」**：客户端版本行的**副标题就是「Path 解码后最后一个 `/` 之后」** —— 明文 `vod` 里的 `…/id/8471.html` 会把副标题变成 `8471.html`（多条一模一样）；base64url 解码后**也不含 `/`**，末段才能安心放内容。末段放聚合层 `standardName` 拼好的**标准文件名**（`标题.年份.季集.规格.容器`，见「播放」段的「副标题」一条），如实反映这一版本的规格。**不再带站点前缀** —— 来源已在标题位 `MediaSources[].Name` 的站点标签里，副标题留纯文件名。
    - token → 版本 Id 用 `service.decodeSourceToken()` 拆（base64url → `mbp:…`）；认不出的 token → **400**，不猜。
    - 为什么不能直接放源地址：实测同一个 `S01E01` 两次 detail 返回的集 ID **不一样**，base64 解出来是 `{"providerId":"quark",…,"playToken":"{…stoken…}"}` —— **它自己就是时效令牌**，拼进 Path 会跟着过期。
    - **但客户端不读 `Path`**（日志实测）：它自己拼 Emby 的标准直连端点 `GET /videos/{ItemId}/stream.{Container}?Static=true&MediaSourceId=<版本 Id>`。所以 `Path` 目前只留着「给读它的客户端 / 手动调试」，真正播放靠下面这条。
    - **`DirectStreamUrl`**（只在 `PlaybackInfo` 里给，详情不给 —— 真机同此）：形状 `/videos/{ItemId}/stream?MediaSourceId={<版本 Id>}&Static=true&api_key={<客户端 token>}`，**同样是相对路径、且不带容器后缀（裸 `stream`）**。**裸 `stream` 是对齐真机**：予初Emby 4.9.5.0（电影 `864879` / 剧集 `585872`）的 `DirectStreamUrl` 就是裸 `stream`，`Container='mkv'` 也不拼 `.mkv`（见 [ADR-0070](adr/0070-direct-stream-url-bare-stream.md) 与「十」#11 的 11-5）；客户端自拼 `stream.mkv` 本层照样认（路由正则 `stream(\.[a-z0-9]+)?`）。带上客户端自己的 token（用 query `api_key`，**不能写 `X-Emby-Token`** —— 后者本层只认请求头），否则拿它直接去播会 401。实测 **AfuseKt/3.2.0** 就取这个字段起播；给绝对 URL 时它当相对路径再拼一次、拼成双重地址（见「十」#11）。
  - **直连渠道认 `MediaSourceId`**（修正自原先的「不认」）：客户端播直连时**只回传版本 Id**，不带任何路径参数 —— 因此 `MediaSources[].Id` 编成 `mbp:` + base64url(deflateRaw(JSON `{r: ref}`))（见 `mbpSourceId()`），播放那一格从 Id 里就能拿到站点/线路/vod，不必回头再搜一遍。两个渠道（`Items/{Id}/Stream` 与 `videos/{Id}/stream.{ext}`）共用 `resolveStream`：**显式 `vod` 参数优先，其次用 Id 里自带的**。
  - **版本 Id 只认一种形状**（`parseMbpSourceId()`）：`mbp:` + base64url(deflateRaw(JSON `{r: ref}`))。按 [ADR-0034](adr/0034-fresh-install-no-migration.md)「不为未发布的东西留兼容」**不留双读分支** —— 旧版明文 `<源>:<站点>:<线路>|<vod>`、以及只编码不压缩的那一版，一律解析失败 → 400「重新进一次播放页」（客户端进播放页必先问 `PlaybackInfo`，自会拿到新的）。但线路名带 `#` 的**旧明文** Id **救不回来**（`#` 之后的内容客户端根本没发出来），也只能等它重新取一次 Id。
  - **载荷是 JSON，编码前还压一道**：原来拼的是 `<源>:<站点>:<线路>|<vod>`，但 **vod 里就可能有 `|`** —— 站源把 meta 塞进 `vod_id` 是常态，`vod_remarks` 里带竖线（实测 Lmentor 的 `nodejs_bili_all`：`{"…","vod_remarks":"5分18秒|2.6万|19天前"}`）。老写法按「最后一个 `|`」切 vod，于是拉流时 vod 被切成 `19天前"}}` → 聚合层查不到这条绑定 → **404**，客户端表现为"点了播放没反应"。现在整段包成 JSON `{r: ref}`：字段边界靠结构，`|`/`:`/`#` 出现在任何字段里都不是问题。
  - **编码前先 deflate（见 [ADR-0039](adr/0039-compressed-source-id.md)）**：SenPlayer 把整条请求 URL **截在 4095 字符**（实测），留给 `MediaSourceId` 的只有 **4048** —— 而 `ref` 本身就是插件编的一串 base64（里面还嵌着站点自己的 playToken），只编码不压缩时实测最长 **5098** 字符：客户端发出去的是半截串 → 服务端按形状校验回 400「src 认不出」→ 反复重试（实测 SenPlayer/6.2.2 三条 400），**同一个视频换 Rex 却能播**（它没有这个上限）。deflate 对这类"base64 套 base64"的重复文本收益明显：同一批 19 个版本最长的 **5098 → 3395** 字符，全在 4048 以内。
  - **拉流时现取、不缓存**：`detail`（快路径 site+vodId，拿**新鲜**的集 ID）→ `agg.play`。代价是首帧要等两次上游调用（实测各 ≈2.5s）；先不缓存，等测出真实首帧延迟再说。
  - **下载（`Items/{ItemId}/Download`）走的是这一套，不是另写一套**：客户端的下载请求同样只带 `MediaSourceId`
    （`?MediaSourceId=mbp:<base64>&DeviceId=…`），要的东西与拉流逐项相同，所以那条路由就是
    「`MediaSourceId` → `resolveStream` → `serveStream` 落法」—— 与 `videos/*` 那段代码同构，不新增取数逻辑。
    差别只在两处：日志那行写「下载」（`serveStream` 的 `verb` 参数），以及**语义**上：302 之后
    `Content-Disposition`（文件名）/`Content-Type`/断点续传都由源站决定，面板改不了 ——
    想给「片名.S01E01.mkv」那种名字就必须由面板转发**全量字节**，那是 ADR-0006 明确不要的。
  - **拉流方式按版本 Id 里的 `playVia` 分档**（内核 `planStream`，见 [ADR-0042](adr/0042-auth-line-byte-relay.md) 与后继 ADR）：
    `playVia` 由源插件在 `detail.lines[].playVia` 申报、面板原样透传，并在拼版本列表时**编进版本 Id 载荷**
    （`mbpSourceId(ref, playVia)`：JSON `{r, v}`，`v` 缺席 = `client`），起播时从 Id 里取回交给 `planStream`。
    四档落法：
    - `client` 非清单 → **302**：面板只回一个 `Location`，视频字节全在客户端与源之间跑；
    - `client` `.m3u8` → **200 清单中继**（相对补绝对，[ADR-0040](adr/0040-hls-playlist-relay.md)）；
    - `proxy` 非清单 → **面板代持请求头字节中继**：客户端带不了那串鉴权头，由面板带头发给上游。
      搬运是**分块并发**的（探总长 → 有界 Range 切块 → 多路在飞 → 按序吐，默认 16 路 / 512KB；
      探不出总长才退回单连接透传），见 [ADR-0045](adr/0045-relay-chunked-concurrent.md)；
    - `proxy` `.m3u8` → **200 清单中继**，且清单里每个地址改成落在**本端口** `/api/emby/stream?seg=&sid=`
      上的**签名子地址**，客户端取分片时由面板补头（不给分片带头，清单拿回来也播不了）。
    - 两档的搬运参数都可以在**拉流地址上带 `?threads=&chunkKB=` 覆盖这一次播放**
      （优先级：URL 参数 > 源插件 `play` 返回 > 面板设置 `streamRelay` > 默认 16/512）。
      清单档的参数跟着 `sid` 存（`/api/emby/stream` 只有 `?seg=&sid=`），分片那几十发共用这一份 ——
      子地址是面板自己签发的，客户端不会把当初那对参数带回来。
    - **判据只能是声明，绝不看 `header` 是否非空**：源顺手给的头可能只是信息性的（实测 missav 给了头、302 照样能播）——
      按事实反推 = 面板替插件纠错，契约里明确不这么做（漏标 / 标错由插件自负）。
    - 为什么 `client` 档不再有面板代理：面板跑在路由器上（2G 内存、U 盘），把每条流的字节都接一遍是代价最高的做法；
      `client` 线路的字节一律不经面板（302 直连，地址改写见下一条）。`proxy` 档的中继是**能力缺口**（客户端带不了头）
      才付的代价，不是默认路径。
    - `client` 档 `play.header` 非空时，302 后客户端带不了那些头 —— **如实记一行日志**
      （`⚠️ 该线路要求请求头 X/Y，302 后客户端带不了`），不静默；这类线路本就该由插件标成 `proxy`。
    - 两档中继**共用同一个流内核**（[stream.js](../server/modules/agg/stream.js)）：
      agg 流端点与 Emby 层是同一份实现，Emby 只是把清单子地址落在 `/api/emby/stream`
      （实例端口只收 `/api/emby/` 前缀，指到 `/api/agg/stream` 会 404）。子地址**自验 HMAC 签名、不校验 Emby token**。
    - **下载端点（`Items/{ItemId}/Download`）同样走这四个形态**，不另写一套。
  - **302 前改写地址**（`service.redirectUrl()`）：**本地部署的源**回的播放地址是**回环地址**
    （源按"谁访问它"回填 host —— 聚合层是用 `http://127.0.0.1:<端口>` 打它的，它就回 `127.0.0.1`），
    那个地址对客户端毫无意义（客户端上的 `127.0.0.1` 是客户端自己）。所以换成
    **`http://<客户端访问面板用的域名>:<源端口>/…`**：用 192.168.1.100 进的 Emby 就回 `192.168.1.100:8090`，
    用 192.168.1.10 进的就回 `192.168.1.10:8090`（docker-compose 已把 8090-8100 发布到宿主）。
    · 只在地址**确实是回环**时才改（真直链如 `drive.example.com` 一律不动）；
    · **自定义（外部）源一律原样**——那种源在别的机器上，它的地址面板管不着，也不该管；
    · 源只回相对地址（`/proxy/…`）时按同一个域名 + 源端口补全（否则客户端会拼到**面板**身上）；
    · 拿不到 `Host` 头 / 认不出的地址 → 原样回，并把原因写进日志那一行。
    改写成功时日志会写全：`→ 302 地址改写 http://127.0.0.1:8090 → 客户端域名(192.168.1.100:8090)`。
  - 老配置里残留的 `play.mode` **不再读、也不再校验**（`PLAY_MODE_VALUES` 已删）：盘上留着那个键不影响任何一张卡片保存。
  - **线路过滤（可在面板配：「聚合设置 → 聚合参数 → 线路过滤」）**：一个正则，**只匹配线路名**（`line.flag`）—— 写 `夸克` 只留夸克类线路，写 `百度|UC` 留这两类；留空 = 不过滤。
    **已从 emby 层搬到聚合层、并落到产出上**（`agg.json` 的 `lineFilter`，理由是「放聚合设置里面更稳」）：
    线路本来就是聚合层产出的东西，规则跟它放一起才不「配置在 A、生效在 B」。规则**只在 `agg/service.js` 的 `lineFilter()` 实现一次**，
    由 `applyLineFilter()` 在 `aggregateDetail` 返回前**就把不匹配的线路从 `detail.lines` 去掉**（[ADR-0043](adr/0043-line-filter-at-aggregate-output.md)）——
    emby 与出口插件（FW/Rex）拿到的都是这份滤过的结果，**谁都不再自己滤**（原先 emby 层那处 `continue`
    与「经 `agg/api.js` 转发读规则」的口子已删）。盘上老的 `emby.json` 的 `play.filter`
    由 `server.js` 启动时搬一次（agg 侧为空、emby 侧有值才搬）。语义没变：**只影响列出的版本，不影响播放**。
    ⚠️ 但它现在**还参与聚合层"这条详情对客户端有没有用"的判据**（[ADR-0025](adr/0025-line-filter-in-usable-judgement.md)）：
    过滤后一条都列不出来的条目不算"能用"（补打继续找、快照也不存），并且规则进了快照 key
    （改规则后第一次请求要重算）。客户端看到的版本列表行为不变。
    - **只影响客户端「列出来的版本」，不影响播放**：`resolveStream` 是按版本 Id（`site + flag + vod`）回查的，**不查这个列表** —— 否则改一次规则，客户端缓存里的旧版本 Id 再来拉流就 404 了。
    - **站点维度的取舍不在这里**（那是聚合层的 `agg.enabled` / `agg.order`）—— 一条正则只管线路名，两个维度各管各的。
    - **过滤后为空就是空的**（既定口径）：**不回退成全部**。emby 层日志写清 `线路过滤(/<规则>/)(聚合层已滤)：源里 N 条 → 到手 M 条`，M=0 时再加「（规则把线路全滤掉了）」—— 免得规则写错还误以为生效了。诊断字段 `MediaBridgeSource.LineFilter = { Pattern, Total, Kept, Invalid }`（`Total` = **过滤前**条数、`Kept` = 列出条数，两个数都来自聚合层 `stats.lineFilter`；客户端会忽略）便于面板核对。
    - 正则在**保存时**就校验（面板直接拒绝非法写法）；运行时另有一层兜底：万一仍然非法，**当不过滤**走并在日志里写明 `规则非法，已忽略` —— 规则坏了不该把版本列表整个清空。
    - 实测：`filter=夸克` → 24 条降到 **10 条**（三个站的夸克类线路）；`filter=zzz没有这种线路` → **0 条**并留下上面那行日志；`filter=[` → 保存直接 **HTTP 400**（提示 `线路过滤不是合法正则：…`）。
    - 搬完之后复验：把 `agg.lineFilter` 设成匹配不到任何线路的正则 → Emby 那条 `{域}_79481_tv_s5_e211` 的 `MediaSources` **0 个**；清空 → **1 个**（证明 emby 侧确实在读聚合层这份）。
  - **源回报回环地址这件事已经不再需要"选代理"来躲**：本地部署的源按"谁访问它"回填 host 是常态，
    以前只能靠面板代理绕过去；现在 302 前会把那个回环地址换成**客户端访问用的域名 + 源端口**（见上面那条）。
    **仍然够不到的是**：源在**别的机器**上（自定义源）而它自己回报了一个客户端够不着的地址 —— 那种源面板管不着，如实 302。
  - **走 302 不等于绕过中转**：实测站源 `/play` 返回的常常就是**源自己的** `/proxy/<provider>/<uuid>?pst=…` 地址 —— 解 `pst` 载荷能看到真直链（`drive.example.com`）、必需请求头（`User-Agent` / `Cookie` / `Referer`）、分片参数（`threads=16`、`chunkKB=256`），真直链的 `auth_key` 比 `createdAt` 大约 **21 小时**（限时签名）。所以选 302 只是「**本面板**不扛流量」，**源那边的流量与压力照旧**。要直连网盘得**改源**、由源提供直链契约（`pst` 是源私有格式，emby 层不该去解）。
  - **实测发现**：夸克线路的 `play.header` 是 `{}`，因为源把 `User-Agent` / `Cookie` / `Referer` **内嵌在自己 proxy URL 的载荷里**（`pst=` base64 解出来就含 `headers`），由源服务端自己加。所以「302」这条轻路径实际覆盖了大部分线路。
  - **流端点不做强制账号校验**（有 `UserId` 就校验，没有也放行）—— 客户端拉流不保证带上 `UserId`。**但 AccessToken 要校验**：客户端拉直连流用的是 query `api_key=`，正好被 `tokenFrom` 认到，所以这条不需要额外要求 `UserId`。（曾经的"AccessToken 只发不校验"取向已作废；`MediaSourceId` / `Path` 里的 `vod` 仍然相当于第二重凭据。）
  - 实测（端到端复现客户端的原样请求）：`PlaybackInfo` → **24 个版本**（3 个站 × 各自线路，标题形如 `虎斑|4K · 夸克原画` / `玩偶|4K · 夸克原画#02` / `木偶|4K · 夸克原画`，**无一为空**）；逐个验证**非首个站**的线路也能播：`MediaSourceId=catpaw:nodejs_huban:夸克原画|/index.php/vod/detail/id/500036.html` 与 `catpaw:nodejs_wogg:夸克原画#01|/voddetail/130077.html` → **302** → 跟随并带 `Range: bytes=0-1023` → **HTTP 206 / 1024 字节 / `video/x-matroska`**，魔数 `1a45dfa3`（EBML/Matroska）→ 说明 Id 里**各站自己的 vod** 回查正确。
  - **由此得到的结论**：在此之前只实现了 `Items/{ItemId}/Stream`（本面板在 `Path` 里指的那条），客户端**从未调用过它** —— 播放请求全部落到通配器吃 **501**，客户端只会反复重试（日志 emby#39~#45 连打 7 次）。**"端点通了"不等于"播放通了"**：以客户端**实际发出的路径**为准。
  - **"版本列表为空"先查聚合源地址**：`data/settings/agg.json` 的 `upstream.source` **一旦被手动填成固定地址就不再回落本地源** —— 而那个地址很可能是**面板崩溃后留下的孤儿源进程**（崩溃不走优雅退出，`stopAll` 没执行，源进程被 PID 1 收养并一直占着旧端口；那次是崩溃留下的 `192.168.1.101:9988`）。症状：`PlaybackInfo` 一直是 **0 个版本**，日志 `聚合取数失败（UPSTREAM_HTTP）`，每次卡满 20s 超时；源列表里那个有问题的源**看起来还是 running**。定位与修法：面板「聚合设置 → 托管源」会明说生效地址与来源是 `local`（本地运行中的源）还是 `manual`（配置里那个）（`GET /api/settings` 的 `base` 字段同源）——`manual` 指向的端口必须能与 `resolveLocal()` 的一致；清空 `upstream.source` 回落本地、并杀掉孤儿进程（`lsof -nP -iTCP:<端口>` 找 PID）。根因（流错误把进程带崩）已在 `serveStream` / `server.js` 两面堵住。

- **工作室清单（`GET /Studios`）—— 如实回空**：回空 `QueryResult`（`{Items:[],TotalRecordCount:0}`），**不是 501、也不是没做**。
  - 一个关键问题是"**工作室内容上游已经给了吗？**" —— 给了，而且已经在输出：详情页每条片的 `Studios[]` 就是从上游的 `production_companies` 映射的（`service.applyRich`），实测 `movie/603` 给 4 个（`Village Roadshow Pictures` / `Groucho II Film Partnership` / `Silver Pictures` / **`Warner Bros. Pictures`**）。
  - 那为什么还回空？**不是"缺一张匹配表"，是缺被匹配的那个源**：
    | | 内容 | 有吗 |
    |---|---|---|
    | **有**的 | `某条片 → 它的工作室` | 只有详情查过的那些（列表项**不带工作室** —— 插件 `HomeItem` 里根本没这个字段） |
    | `/Studios` **要**的 | `全库去重后的工作室清单` | 否，需要全量片库才能算 |
    | `/Studios/{Name}/Items` **要**的 | `某工作室 → 哪些片` | 否，同上 |
  - 关键在于**服务端没有"库里有哪些片"这份索引**：列表数据由首页插件在**请求时**现跑，从不存片库。所以不是匹配不上，是**没有东西可枚举**。
  - 若一定要凑出这份清单，只有一条路：跑一遍启用的行、把工作室名聚合去重。但那拿到的是**行返回的那几页**里的工作室（榜单片 ≠ 片库），**清单会随榜单波动** —— 用户拿一个会变的清单去筛选，结果没法解释。那是**编数据，比回空更差**（同 `getResume` 的取向）。
  - 另外上游的 `production_companies` 噪音很大：一条片常 4~8 个，很多是为单部片临时成立的空壳公司（上面那 4 个里就有 2 个）。
  - 顺带：详情里的 `Studios[]` **现在给 `{Id, Name}`**（原来只给 `Name`，
    而真机每条都带 `Id`，缺它会让客户端整条响应解码失败，见「四」）。`Id` 用上游的公司 id（**数字**）。
    给了 Id 就等于承诺"点公司能进列表"，而 `/Studios/{Name}/Items` 没实现（会 501）——
    但这条**只能这样**：**完整性优先**，宁可点了 501，也不能让整页打不开。
  - **要 token**（14-1 起对齐真机）：真机三台实测**无 token / 无效 token 一律 401 纯文本**
    （`Access token is invalid or expired.`），故在路由层加 `authorize(req)` ——
    与 `Items`（5-1）/ `Items/Latest`（6-1）同口径。此前"回空没有数据可保护、故豁免校验"的取向
    **已作废**（真机不这么判；正常客户端都带 token，无人被误伤）。逐条见「十、#14」。
- **「如实回空」这一家子**：`Studios`，以及 `Items` 里认不出的查询。共同点：**确实没有那份数据**，所以回空。
  （`Items?Filters=IsFavorite` 已**移出这一家**：自 [ADR-0058](adr/0058-favorite-items.md) 起读 `favorite` 表出真数据，
  详见「五」的「条目列表」那支。）
  （`Items/Counts` 原本也在这家 —— 现已「部分出数」，见下；它自 16-1 起与 `Studios` 一样**要 token**，
  两者都对齐了真机：真机三台实测无 token / 无效 token → 401 纯文本。）
  | 端点 | 为什么是空的 | 缺的是什么 |
  |---|---|---|
  | `Studios` | 没有片库可枚举 | 片库索引 |
  | `Items/Counts`（**只剩其余字段**） | 数不出来 | 片库索引 |
  - **`Items/Counts` 已「部分出数」**：电影 / 剧集两类取**首页插件申报的库总数**（申报在 `rows` 里行的
    `total`，见 [ADR-0052](adr/0052-items-counts-library-total.md)），**集数取剧库行申报的 `episodes`**
    （见 [ADR-0053](adr/0053-home-row-declared-episodes.md)），其余字段**仍回 0**。
    0 的意思是**"数不出来"**、**不是"库是空的"**（`ItemCounts` 的 14 个字段都是数字、没有"未知"这种取值）。
    ⚠️ **别拿"这一榜的条数"当库总数**：`top_rated` 这类行 `run` 出来报的 `total`（如 `11216`）是**上游榜单
    的总数**，不是库规模 —— 拿它当"库里有 11216 部片"就是**编数据**，比 0 更差。库规模只认 `rows` 里行
    **专门申报的**那个 `total`。
  - **`Items/Resume` / `Shows/NextUp` 已不在这一家**：自 [0023](adr/0023-playback-progress.md) 起它们读
    `playback` 表出真数据，也**因此改成要 token**（回的是某个账号的观看记录）。
  - `Shows/NextUp` 与 `Items/Resume` 的分工（都靠观看历史，见 [0023](adr/0023-playback-progress.md)）：
    `Resume` = **有播放进度、还没看完**的条目；`NextUp` = 正在追的剧里**下一集**该看哪一集
    （最近看的那集没看完 → 回它自己；看完 → 回下一集，且必须在上游季数据里真实存在；
    指名 `SeriesId` 而库里没有它任何进度 → 回**第一集**）。
  - 路由形状提醒：这两条都**没有**同名冲突（没有裸的 `Shows/:showId`、条目详情那条是
    `Users/:userId/Items/:itemId` 而不是 `Items/:itemId`）。但 `Items/Resume` 与 `Items/Latest`
    **都**被同形状路由吞过一次（后者曾导致 VidHub 首页全空）——
    **以后若新增 `Items/{Id}` 之类，记得把这几个挪到它前面**。

### 多版本字段对照（真实 Emby 服务端样例）

参考样例：某线上 Emby 服务（`emby.example.com`）的 `GET /emby/Shows/943883/Episodes`（Rex 发的，`Fields` 里明确写出 `MediaSources,MediaStreams`）。同一集它给了**两个版本**：

| 版本 | `MediaSources[].Name` | 视频流 `DisplayTitle` | 分辨率/编码/HDR | 码率 | 体积 |
|---|---|---|---|---|---|
| `mediasource_943887` | `H.264.(mkv)` | `4K Dolby Vision HEVC` | 3840×1920 · hevc · DolbyVision | 4557767 | 1.93 GB |
| `mediasource_943886` | `DV.HDR.H.265.(mkv)` | `4K Dolby Vision HEVC` | 3840×1920 · hevc · DolbyVision | 19807913 | 8.39 GB |

逐字段对照（**真实 Emby 的那套形状就是客户端的期待值**）：

| 字段 | 真实 Emby | 本面板 | 说明 |
|---|---|---|---|
| `MediaSources[].Id` | `mediasource_943887` | `mbp:` + base64url(deflateRaw(JSON `{r: ref}`)) | 客户端只当唯一键，但**必须 URL 安全**：它拼进 query 时不编码 `#`，明文 Id 里线路名带 `#` 的话后半段会被当锚点丢掉（实测） |
| `MediaSources[].Name` | 文件名尾段，**版本标识** | **`站点标签 · 线路`**（`虎斑|4K · 夸克原画` / `木偶|4K · 夸克原画`），取聚合层写好的 `versionLabel`（[ADR-0063](adr/0063-version-label-at-aggregate-output.md)） | 多站之后才分得清 |
| 视频流 `DisplayTitle` | `4K Dolby Vision HEVC`（规格描述） | **`站点标签 · 线路`**（同上；**源没标规格也照建这条流**，否则标题位会空） | 见下面的「为什么」 |
| 音频流 `DisplayTitle` | `English EAC3 5.1 (默认)` | `EAC3` | 语言/声道没数据，不给 |
| `VideoRange` | `DolbyVision`（Emby 词表） | `DOVI` 经 `embyVideoRange()` 翻成 `DolbyVision` | 词表不对口客户端认不出 |
| `ExtendedVideoType` | `DolbyVision` | 同左（DoVi 时才给） | |
| `DefaultAudioStreamIndex` | 有 | 有 | |
| `VideoType` | `None` | `VideoFile` | 本项目是 http 流，不是本地文件，如实给 |
| `Path` | 真实文件 URL（末段是文件名） | 本面板 Stream 端点，**末段放标准文件名**：`/Stream/{base64url(版本 Id)}/{标准文件名}` —— 客户端版本行的副标题就显示它 | 形状见「播放」段 |
| 其余流字段（`Profile` / `ColorSpace` / `BitDepth` / `ChannelLayout` / 语言 / `ExtendedVideoSubType`…） | 全套（本地库 + ffprobe 探得） | **只给源在集名里标了的** | 解析不出来就留空，不编 |
| Episode 项自带 `MediaSources` / `MediaStreams` | 有 | 无（只在详情与 `PlaybackInfo` 给） | 真实 Emby 是本地库扫出来的；本项目是**在线聚合**，分集列表要给每集配版本就得多打上游，代价过高。**待观察**：Rex 既然在 Episodes 里明确要求 `MediaSources`，将来若发现它靠列表渲染版本，再议 |

**为什么 `DisplayTitle` 必须给「站点标签 · 线路」**（而不是像真实 Emby 那样给规格串）：真实 Emby 的两个版本是**两个不同文件**（码率/体积不同、`Name` 也不同），规格串本来就能替它区分；而本项目是**同一个源条目里的多条线路、甚至多个站的同名条目** —— `VideoRange` / `Codec` / `Size` 往往完全相同，规格串会撞成一片，**只有站点标签能把它们分开**。而版本行的标题位只认流上的 `DisplayTitle`：缺了就退回 `VideoRange` 拼出的 `Dolby Vision`，`MediaSources[].Name` 填了它也不读。站点的完整 `name`（`木偶|4K`）比截短的"木偶"多带画质后缀，标题位与副标题现在用**同一个标签**。

**副标题：已修**。版本行的副标题是客户端把 `Path` 解码后取「最后一个 `/` 之后」得来的：之前 `Path` 是 `…/Stream?src=…&vod=…/id/8471.html`，于是六条全显示 `8471.html`。现在改成 `/Stream/{base64url(版本 Id)}/{标准文件名}` —— token 用 base64url（**解码后也不含 `/`**）承载源路径，使其不出现在 URL 里，末段放聚合层拼好的**标准文件名**（scene naming，`标题.年份.季集.分辨率.来源.音频(含声道).Atmos.动态范围.视频编码.容器`），副标题就变成：

```
蜘蛛侠：崭新之日.2026.2160p.WEB-DL.DDP5.1.Atmos.DV.H.265.mkv
蜘蛛侠：崭新之日.2026.1080p.WEB-DL.DDP5.1.H.264.mkv
```

**不再带站点前缀**（`小雅 Alist · …` 那截去掉）：来源与线路已经在标题位 `MediaSources[].Name` 里显示，副标题只留文件名。`标题` / `年份` 取自搜索标题（`rawTitle`），规格取自 `parseEpisodeMeta`（`WEB-DL` 由 agg 的 source 识别补出；`H.265`/`DDP5.1`/`DV` 等换成 scene 通行写法）；缺哪段就跳过哪段，不编。agg 拿不到规格的线路退回「原始文件名」。（注意客户端**播放并不读这个 Path**，它只影响副标题与手工调试 —— 播放走 `/videos/{Id}/stream.{ext}`。）

**流字段能提取的都提取，但"有才有、没有就空"**（既定口径：**只用 `agg/detail` 的数据，不做探测**）。分三类：

| 类别 | 字段 | 依据 |
|---|---|---|
| **算出来的**（近似） | `Bitrate`、视频流 `BitRate` | `Size×8÷时长`；源标的体积本身是近似值，且分不出音视频，故按"整条流"口径给 |
| **由已解析项推导**（规范确定） | `ColorSpace` / `ColorPrimaries` / `ColorTransfer` | DV/HDR10/HDR10+ → `bt2020nc`+`bt2020`+`smpte2084`；HLG → `arib-std-b67` |
| **源写了才有** | `BitDepth`（`10bit`）、`Profile`（`Main10`）、`AverageFrameRate`/`RealFrameRate`（`60fps`）、`Channels`/`ChannelLayout`（`5.1`）、Atmos、`ExtendedVideoType` 细类 | 集名里的明确写法 |

本例集名 `…2160p…H.265.DV.HDR.DDP5.1.Atmos.mkv` **没写**帧率、位深、档位 —— 所以那三项**就是空的**（不是漏了，是源没说）。想要"一定有"只有一条路：真去探测文件头（ffprobe）。**本项目不做** —— 源是远程流，为元数据去读它的头部是另一条链路的事；既定要求是"就通过 `agg/detail` 最大限度拿数据"。

### 面板自用端点（不属于 Emby 客户端协议）

这些是面板自己用的接口，**同样必须注册在通配之前**（否则会被 501 通配吞掉），但**不参与** Emby 兼容语义，客户端永远不会请求它们。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/emby/accounts` | 账号列表（`id/username/createdAt/updatedAt/lastLoginAt/lastClient`，**绝不含密码或哈希**） |
| POST | `/api/emby/accounts` | 新增账号 `{username,password}` → 200 `{account}`；400 空/用户名>64/密码<6；409 用户名已存在 |
| PUT | `/api/emby/accounts/{id}` | 改 `{username?,password?}`（只传 password 就是改密）→ 200；400 没内容可改/格式不对；404；409 |
| DELETE | `/api/emby/accounts/{id}` | 删除（**允许删最后一个**，删光后退化成"还没有账号 → 登录 401"）→ 200 `{ok,remaining}`；404 |
| GET / DELETE | `/api/panel/cache` | **缓存用量 / 清空**：面板这边那两个库一把抓（`data/cache/detail.db` 的 `detail_cache`、`data/emby/cache.db` 的 `image_index`），走 `core/cachedb.js` 的 `statsAll()`/`clearAll()`。**取代了 `/api/emby/cache`**（缓存分家后"清空"必须只有一个入口）。⚠️ 元数据插件的缓存不在这里，它自己在插件的数据目录里 |
| GET / DELETE | `/api/logs` | **面板日志**（属**面板层**，不是 emby）：`GET ?since=&limit=` 增量取内存缓冲、`DELETE` 清空。给「面板设置 → 日志」页用，契约见「二」 |

- **首页插件没有面板自用端点**：它的设置与行参数在**插件自带的 webui** 里（入口是「插件 → 管理」页那一行的「设置」按钮），面板侧不再提供 `/api/emby/home/**` 这类端点。行与条目的规范见 [emby-home-plugin.md](emby-home-plugin.md)。
- 账号接口的**响应与日志绝不出现 `password` / `password_hash` / `salt`**：对外形状统一走 `db.publicAccount()`（只此一处做字段映射），日志只打 `id` 与 `username`。
- 这些**面板自用端点不校验 AccessToken**：它们（如 `/api/emby/accounts*`）在**面板门禁**的保护范围内，访问需要面板登录会话，因此不再叠加客户端 token 校验（见 [ADR-0017](adr/0017-panel-auth-single-password.md)）。
- 查重先给友好的 409，同时靠 `username_lc UNIQUE` 兜并发。

- body 可带 `token / apiBase / imageBase / language`（用界面里**尚未保存**的当前值）与 `entryId / type`；合并规则：基地址**带了这个键就算数**（空串 = 用官方），token/language 的空串视为「没改」回落已保存值。
- **HTTP 一律 200**，成败看 `ok` 与 `error.code`（`NO_TOKEN` / `INVALID_TOKEN` / `NOT_FOUND` / `NETWORK` / `TIMEOUT` / `UPSTREAM_HTTP`）—— 前端 `api()` 在非 2xx 时只能拿到一句 error 字符串，看不到细节。
- **绝不回显 token**：响应里只有 `tokenSet` / `tokenLength`，日志里只有基地址、探测对象、状态与耗时。

### 元数据插件自己的设置

- **归元数据插件**：元数据插件自己存 token / 基地址 / 语言 /
  它自己的缓存，落在**插件自己的数据目录**（它自己的 `data/settings.json`）；
  UI 是插件自己的设置页（「插件」页 → 该插件 → 「设置」），连通性自检也在那一页（动作 `test`）。
  **面板不读也不写这份设置** —— 它只从插件的「注册」动作里拿**图片基地址**（替客户端取图要拼串，
  见 `server/modules/emby/meta.js`）。决策见 [adr/0031](adr/0031-metadata-by-domain.md)。
- **凭证只支持 v4 API Read Access Token**（`Authorization: Bearer`）；v3 `api_key` 不支持 —— 两种凭证在上游侧权限完全相同，token 是官方推荐且不会出现在 URL/日志里。
- `apiBase` / `imageBase` 留空即用官方（上游 API 基地址、上游图片基地址），直连不通时可填反代/镜像；插件设置页只校验非空时必须是 `http(s)://`。
- Token 以**明文**落在插件的数据目录里（本地面板；含凭证的 `data/` 已在 `.gitignore`）。

### 上游出口全清单（做缓存/限速/记账前必看）

上游流量分**两类**，走的路完全不同 —— 混在一起算账一定会算错：

| # | 谁发起 | 代码位置 | 落到哪 | 走插件的上游客户端？ |
|---|---|---|---|---|
| 1 | 详情/影剧反查 | `service.richItemDto` → `metaBridge.lookup()` | 上游 API 基地址 | 是 |
| 2 | 季/集反查 | `service.getEpisodes` → `metaBridge.lookupSeason()` | 上游 API 基地址 | 是 |
| 3 | 首页插件取上游数据 | 首页插件自己的上游客户端（插件自己的子进程，带**插件自己存的** token） | 上游 API 基地址 | 否 |
| 4 | 插件设置页的「测试连接」 | 插件的 `test` 动作（打 `/configuration` + 实查一个 id，**都绕缓存**） | 上游 API 基地址 | 视插件 |
| 5 | **图片端点**（**已移除出网**） | `routes.js` 的 `imagesByType` 改为**一律 302**，面板不再出网取字节（见 [ADR-0036](adr/0036-image-endpoint-redirect.md)） | — | 否 |
| 6 | 首页插件取图床 / 其他上游 | 插件自带的 HTTP 客户端，可打任意地址 | 任意 URL | 否 |

统一的底层是 `server/core/upstream.js` 的 `request(baseUrl, path, {timeout, headers})`；元数据插件与首页插件各带一份同形状的实现（元数据插件自带的那个上游客户端、首页插件自己的上游客户端），表里各条按发起方落到对应那一份。

- **已删除的一条**（原表中的聚合层「别名回退」反查）：那时**只在"站源没有同名"这一条失败路径上**才会打（每次最多 5 个候选名），正常请求一次都不打；它走的那个按名字搜索的接口带着缓存。已删 —— 挑片判据换成聚合层本地打分（`agg/match.js`），聚合层不再出网；按名字搜索现在只服务 emby 的搜索端点，经元数据插件的「搜索」动作。

**第 1、2 条 = 面板侧发起的「API 调用」**（消耗配额）：面板把请求转给元数据插件，
真正出网的是元数据插件里的请求层（协议层 + 缓存，归一化在它自己的另一个模块里；
`server/modules/emby/meta-bridge.js` 只做转发与 DTO 拼装）。

**第 3 条 = 首页插件发起的「API 调用」**（消耗配额）：首页插件是**独立子进程**，
**自己存 token、自己带** —— 统一宿主不给插件回调面板的通道，插件之间也不能互相调用，
所以它借不到面板或元数据插件的凭证。它自己的上游客户端就是首页插件自己那份
（不带元数据那份响应缓存：首页取的都是榜单 / 发现 / 趋势这类每天都在变的路径）。
⇒ 给 API 调用做**统一记账/限速/缓存**时，这两处上游客户端要各自覆盖。

**第 5 条 = 已移除**：图片端点曾是**唯一一处"取字节"**（不消耗配额，但要走网络）。
现改为**一律 302**（见 [ADR-0036](adr/0036-image-endpoint-redirect.md)），面板不再发起这条出网请求，
字节全在源站与客户端之间跑。⇒ 记账时**这一条不再存在**：`routes.js` 的图片端点既不消耗配额，
也不产生面板侧流量。客户端仍靠 `Cache-Control: max-age=86400` 自己缓存。

**第 6 条 = 首页插件的自由网络**：插件在自己的子进程里能请求任意地址（这是插件的自由度，面板不代做也不收窄成只准打上游）。它打到哪儿算哪儿，不在上游记账范围内。

> ⚠️ **不要把图片请求算进「上游请求数」**。讨论「按 Id 反查」的代价时算的是**第 1、2 条**那张账
> （实测 340 次图片请求 ≈ 55 次 API 调用）—— 那是**元数据账**；图片字节现在由客户端直连图床，与配额无关。

### 本地缓存（面板两个库：`data/cache/detail.db` + `data/emby/cache.db`；元数据另有插件自己的一份）

**按"谁用"分家**（判据不是"是不是上游数据"—— 图片索引里混着插件给的自定义图地址，
按来源切对它不成立）：

| 表 | 存什么 | 写入时机 | 谁读 | 库 |
|---|---|---|---|---|
| `detail_cache` | 聚合线路结果（影视名 + 季集 → 线路与定位） | `agg/cache.js` | 聚合层与 emby 层 | `data/cache/detail.db` |
| `image_index` | 条目 Id → 图片位置（无头相对路径或绝对 URL） | `baseItem()` 里出 tag 的那一刻 | 图片端点（没带 tag 时） | `data/emby/cache.db` |

**元数据与名字搜索的缓存在插件那边**（表 `meta` 与 `names`，一条一个文件，落
插件自己的数据目录）：什么进缓存、多久过期、上限多少，全由插件自己定 —— 面板不干预
（见 [adr/0032](adr/0032-cache-two-levels.md)）。判据与口径与原先那份一致（元数据类才缓存、
只缓存成功响应、名字负结果不存）。

- **为什么这么切**：缓存归**产生数据的人** —— 元数据归插件（它最清楚自己的数据什么时候会变），
  面板只留自己用的那两份（图片索引的读写都在 emby，聚合线路结果归 agg）。
  通用设施（开库 / TTL / 按字节 LRU / 统计 / 清空）下沉到 **`server/core/cachedb.js`**，
  面板这边两个库各自建一个 store 复用它 —— 不这么抽，TTL 与淘汰会变成两份必然漂移的实现。
- **面板这边的设置、用量、清空统一在面板层**：`cache.*` 存 `panel.json`（UI 在「面板设置 → 缓存设置」），
  端点 `GET|DELETE /api/panel/cache`（**原 `/api/emby/cache` 已删**）—— 面板这边的缓存跨两个库，
  "清空"必须只有一个入口，散在各模块里迟早漏清一处。清的是 `detail_cache` + `image_index`；
  元数据插件那份缓存由它自己那页管（它自己清）。
- **名字搜索缓存的口径**（现在是插件里那张 `names`）：TTL **6 小时**、上限 **2MB**（写死在插件里，
  不是要调的旋钮）；**负结果（空数组）不存** —— 存了会让新上线的别名条目永远看不见；
  TTL 故意不拉长：emby 的搜索端点要用它，"现在有哪些"要新鲜。
  它从"进程内 Map"改成落盘，直接原因是 **dev 模式 `--watch` 一重启就全丢**，
  刚查过的名字马上又打一遍上游、正好撞上上游的抖动窗口（实测：第 1 次 1.08s、第 2 次 3ms）。
- **网络失败会立即重试一次**（元数据插件的请求层里的 `requestWithRetry`）：路由器上上游链路是抖的
  （实测会在握手阶段被中断），而一次搜索要连打多个名字 —— 全撞上坏窗口的概率不低，
  表现就是"版本列表空"。**只重试网络/超时**（401/404 这类确定性失败重试没意义）；
  失败照旧**不缓存**，所以重试是唯一能压住抖动的动作。

- **删掉的孤儿表 `item_seen`**（`item_id` + `first_seen`，84 行）：它是"用**条目首次见到的时刻**
  当 `DateCreated`"那次尝试的残留，那个口径**已被否**（改用上游发行日期，见「五」）。
- **其后又删掉两张**：`view_seen`（库首见时刻 —— 库 `DateCreated` 改占位值后失去唯一用途，
  见「五」）与旧的元数据插件缓存（已随元数据插件化搬进插件的数据目录）。现在 `emby/cache.db` 里**只剩 `image_index`**。
  ⇒ 规矩照旧：**不可再生的表（`*_seen` 丢了就再也算不出来）做实验时要么叫 `_tmp`、要么删干净**。

**为什么图片索引独立文件、不并进 `emby.db`**：`emby.db` 存账号（scrypt 哈希），它的两句话是"写入量极小 + 文件级备份不漏数据"（DELETE journal）与"chmod 0600"。缓存正好相反：**高写入、可随时删掉重建**。混在一起会让备份把可丢的缓存混进不可丢的账号，还会在缓存写盘时锁住整个库、挡住登录。
⇒ 运维上就一句话：**缓存出问题就删掉重建，账号不受影响、不用重新登录**（面板「缓存设置」里有「清空面板缓存」按钮；要连各插件自己的落盘缓存一起清，用旁边的「清除全部缓存（含插件）」）。
⇒ 因此两个缓存库反过来**用 WAL + `synchronous=NORMAL`**（缓存要的是写吞吐，掉电丢几条无所谓），与 `emby.db` 的取舍**正好相反**，这是刻意的。

**只缓存元数据，不缓存榜单**：判据是**请求的性质**而非"谁问的"（判据在插件的请求层里：要求 id 是**纯数字**，否则 `/movie/top_rated` 会被误伤）。所以榜单/搜索/`/configuration` 一律不进元数据缓存 —— 榜单归首页模块自己的 `cacheDuration` 管；`/configuration` 是连通性测试，缓存了会让自检结果失真。
顺带一个好处：面板经元数据插件取**元数据**也享受这份缓存；榜单照旧不缓存（首页插件自己那份客户端不带这份缓存）。
（名字搜索缓存是**另一张表**（`names`）：它缓存的是"检索结果"，与元数据缓存那条判据无关，见上面那行。）

**只缓存成功响应**：401/404/5xx/超时一律不写。否则一次网络抖动会把"404"钉在缓存里，部署者改了 token 还是错的。

**淘汰：TTL + 字节上限 + LRU，三者各管一件事**
- TTL 管**正确性**（元数据会变：评分、简介、海报更换）
- 字节上限管**空间**（片库不封顶）
- 两者都不管冷热 ⇒ 按 `used_at` 做 LRU（读命中时按**每小时**节流刷 `used_at`，避免把缓存变成写放大源）
- **上限必须按字节不能按条数**：实测同一条元数据 **lean 1.9KB vs rich 119KB，差 60 倍**，按条数算不准

**默认值与面板**：`cache.{imageTtlDays,imageMaxMB,linesTtlDays,linesMaxMB}` = 90 天 / 5MB / 1 天 / 32MB，
存在 **`panel.json`**（已从 `emby.json` 搬来，启动时自动搬迁、数值不丢），
面板「**面板设置 → 缓存设置**」可改（还有用量显示与清空按钮；名字索引那两行也一并显示）。
元数据/榜单的缓存 TTL 与上限归各自插件自己定，面板不干预。
⚠️ 两个 0 的语义**不一样**：**天数 0 = 不缓存**（写完即过期）；**上限 0 = 不限**（不淘汰）。
改了设置后由 `panel/index.js` 的 `onSettingsChange` 钩子调 `cachedb.sweepAll()` 立刻扫一遍两个库 ——
否则把上限调小后要等下次写入才收拾，面板上会显示"已用 60MB / 上限 10MB"，看起来像故障。

**实测**（路由器）：

| 项 | 结果 |
|---|---|
| rich 元数据 第1次 / 第2次 | 1318ms → **9ms**（0 网络，行数不变） |
| lean 与 rich | 是两个键（`append_to_response` 在 query 里） |
| 失败不写缓存 | 404 → 下次仍走网络 |
| 无 tag 取图 | **200**（走索引） |
| **容器重启后** | 索引与元数据缓存**都还在** —— 无 tag 取图仍 200，冷启动窗口消失 |
| 上限 200MB→50KB | 立刻淘汰到 1 条 / 2.2KB（不等下次写入） |


## 六、界外：明确不认领的请求（不补、不报）

> 判为**界外**（不属于面板的东西）的请求，日志里再看到**直接跳过**：不认领、不实现、不上报、不进「待补端点」。
> 范围与判据见 [ADR-0056](adr/0056-emby-compat-scope.md)；界外是**整类**不认领（转码、本地库扫描、用户权限 / 家长控制等），不逐条列。

| 方法 | 路径 | 识别特征 | 决定 |
|---|---|---|---|
| （暂无） | | | |

- **收藏（`Filters=IsFavorite`）已移出本节**：此前判「无视 —— 不补」，按 [ADR-0056](adr/0056-emby-compat-scope.md) 改判**界内**，现已**实现**（读 `favorite` 表出真数据，见 [ADR-0058](adr/0058-favorite-items.md) 与「五」）。
- **`Filters=IsPlayed` 也不在本节**：自 [0023](adr/0023-playback-progress.md) 起它**出真数据**
  （读 `playback` 表的已看条目），不回空。
- **不是整体判定 `Users/{UserId}/Items`**：`Filters=IsFavorite` 读 `favorite` 表出真数据（见 [ADR-0058](adr/0058-favorite-items.md)）；`Filters=IsPlayed` 读库出真数据；`ParentId=<本面板的库Id>` 走首页模块（见「五」）；**`AnyProviderIdEquals={域}.{编号}` 归 emby 层**（按外部 id 搜一条 —— 删过、后恢复，理由见「五」）。

> **字段级**的"故意不给"记在别处（不是端点级，所以不列上面的表）：详情页哪些字段不给、为什么不给 —— 见「五」的**详情页"丰富度"**那条（`OriginalLanguage` / `CriticRating` / `ScreenshotImageTags` / 合集 Boxset）。
> 原来那份清单里还有"**演员头像**"和"**演职人员不给 `Id`**"两条，**已推翻**（缺 `Id` 会让客户端整条响应解码失败），改成了"给 Id + 头像顺带做通"，理由见同一条。
> **还没做、等指定的端点**：见「七」。

## 七、客户端要过的端点（记录 + 现状）

> 这张表是**客户端实际要过什么**的流水记录，不是"待办清单" —— 有的已实现、有的如实回空、有的判定不实现。
> 判断依据一律是**日志**（谁要的、要了什么），不靠猜；要补也得等明确指定。

| 方法 | 路径 | 用途 | 现状 |
|---|---|---|---|
| GET | `/api/emby/Users/{UserId}/Items/Resume` | ~~首页「继续观看」~~ | **已实现**（**真数据** —— 读 `playback` 表的未看完条目，见「五」与 [0023](adr/0023-playback-progress.md)） |
| GET | `/api/emby/Studios` | ~~工作室筛选列表~~ | **已实现**（**如实回空** + **只验 token** —— 回空理由是没有片库可枚举；鉴权自 14-1 起对齐真机，见「五」与「十」#14） |
| GET | `/api/emby/Items/{Id}/Images/{type}` | ~~图片~~ | **已实现**（见「五」；tag 验签通过 **或** 命中本地图片索引都出图，否则 404；端点豁免 token） |
| GET | `/api/emby/Users/{UserId}/Items/Latest` | ~~官方另一条「每库最新」路径（回裸数组，与 `QueryResult` 形状不同）~~ | **已实现**（见「五」；**VidHub 3.0.6 的整个首页都靠它** —— 实测拿到 `Views` 后逐库各打一次） |
| GET | `/api/emby/Users/{UserId}/Items?SearchTerm=<词>` | ~~搜索框（`IncludeItemTypes=Movie,Series,Video,Person&Recursive=true`）~~ | **已实现**（见「五」的「搜索」那条；**SenPlayer 6.1.8 实测在用**，以前回空 → 搜索框永远空） |
| GET | `/api/emby/Users/{UserId}/Items/{库Id}` | 客户端问「这个库是什么」（形状与 `Items/{ItemId}` 相同，现在会被 `parseItemId` 判成 501） | **未指定**（客户端尚未请求） |
| GET | `/api/emby/System/Info` | **带 token 的完整服务器信息**（`System/Info/Public` 的加强版：编码器位置、各类路径、能否自更新/自重启等 —— 大部分是**本项目没有的能力**） | **已实现**（**诚实子集**：认领端点，只给面板真有的 17 个字段、能力位一律 `false`，面板没有的 8 个字段不回（不编造）；鉴权**只验 token**；新客户端 **Filmly/2.12.11-439** 在要，此前落到 501 通配；见「五」与 [ADR-0057](adr/0057-emby-system-info-honest-subset.md) 及「十」#20） |
| GET | `/api/emby/System/Ping` | **连通性探针**（登录前/后测「这台服务器活着吗」） | **已实现**（**200 纯文本 `Emby Server` + 豁免 token** —— 新客户端 **Lenna/1.0.16** 在要，见「五」与「十」#19） |
| GET | `/api/emby/Shows/{Id}/Seasons` | **特别篇（上游 `season_number=0`）是否返回** | **已按真机改**（真机实测**返回**特别篇，面板原先过滤 → 7-1 已改为返回；见「十」#7） |
| GET | `/api/emby/Shows/NextUp` | ~~SenPlayer 的「接下来看」~~ | **已实现**（**端点保留、对外恒空** —— 藏掉与「继续观看」重复的那一行，只验 token，见「五」与 [ADR-0060](adr/0060-nextup-hidden.md) 及「十」#15；此前按 [0023](adr/0023-playback-progress.md) 出真数据，该口径已被 0060 取代） |
| POST | `/api/emby/Sessions/Playing` | ~~客户端上报「开始播放」~~ | **已实现**（落库；实测 SenPlayer 6.2.1 每次播放发 1 次） |
| POST | `/api/emby/Sessions/Playing/Progress` | ~~播放中的心跳（实测每 10 秒一次）~~ | **已实现**（落库；被 501 拒了客户端也照发，所以必须收下） |
| POST | `/api/emby/Sessions/Playing/Stopped` | ~~停止 / 退出上报~~ | **已实现**（落库；位置 ≥ 时长 90% 判为看完） |
| POST | `/api/emby/Users/{UserId}/Items/{ItemId}/HideFromResume` | ~~从「继续观看」里移除 / 恢复~~ | **已实现**（只翻 `hidden`，不动位置；重播会自动取消隐藏，见 [0023](adr/0023-playback-progress.md) 的补充） |
| POST | `/api/emby/Users/{UserId}/PlayedItems/{ItemId}` | ~~标记已看~~ | **已实现**（`played=1`、位置归零、`play_count` 加一；见 [0023](adr/0023-playback-progress.md) 的补充） |
| DELETE | `/api/emby/Users/{UserId}/PlayedItems/{ItemId}` | ~~标记未看~~ | **已实现**（`played=0`、位置归零、`play_count` 归 0） |
| POST | `/api/emby/Users/{UserId}/FavoriteItems/{ItemId}` | ~~收藏~~ | **已实现**（收藏时反查元数据、**快照落 `favorite` 表**；见「五」与 [ADR-0058](adr/0058-favorite-items.md)；**Rex/1.0.0** 实测在用，此前落到 501 通配） |
| DELETE | `/api/emby/Users/{UserId}/FavoriteItems/{ItemId}` | ~~取消收藏~~ | **已实现**（删 `favorite` 行，不反查） |
| GET | `/api/emby/Users/{UserId}/Items?Filters=IsFavorite` | ~~收藏列表~~ | **已实现**（**真数据** —— 读 `favorite` 表、快照重建、**0 上游请求**；**Rex/1.0.0** 实测在要，此前恒回空；见「五」与 [ADR-0058](adr/0058-favorite-items.md)） |
| GET | `/api/emby/Items/Counts` | ~~侧边栏每个库的条目数~~ | **已实现**（**`MovieCount`/`SeriesCount` 取首页插件申报的库总数（`rows.total`）、`EpisodeCount` 取剧库行申报的集数（`rows.episodes`）**，其余字段回 0 —— 数不出来，不是库空；**只验 token**，自 16-1 对齐真机，见「五」与「十」#16） |
| GET | `/api/emby/System/Ext/ServerDomains` | **不是 Emby 核心端点** —— 第三方插件 `uhdnow/emby_ext_domains` 提供的「服务器地址清单」（`{data:[{name,url}],ok}`，用于内网/外网/备用域名切换）。真 Emby 没装那插件也是 404 | **不实现**（不在 Emby 协议里；接了反而像冒充那个插件。客户端本就该容忍它不存在） |
| GET | `/api/emby/Users/{UserId}/Items/{ItemId}/SpecialFeatures` | **条目的「特别收录」**（花絮 / 删减片段 / 预告等**本地附加视频**；Emby 里每条是条目文件夹旁的一个可播文件） | **不实现（[界外](adr/0056-emby-compat-scope.md)）**（背后是「条目文件夹里的本地附加文件」，与本地库扫描同类，非面板的东西；**CapyPlayer 1.1.3** 在要，此前落到 501 通配。**片源插件只有正片、查不到花絮** —— 认领了也只能回空，客户端点「花絮」永远没内容，没意义。同族的 `LocalTrailers` / `Intros` 同判） |

> **这张表里"没实现 / 不实现"的现为三条**：`Items/{库Id}`（库详情，**未指定** —— 客户端尚未请求）、
> `System/Ext/ServerDomains`（判定**不实现** —— 不是 Emby 核心端点，是第三方插件提供的，接了像冒充它）、
> `Items/{ItemId}/SpecialFeatures`（判定**不实现** —— **[界外](adr/0056-emby-compat-scope.md)**；片源插件只有正片、查不到花絮，认领了也只能回空）。
> 其余各行**都已实现**（`Resume` / `Studios` / 图片 / `Items/Latest` / `NextUp` / `Items/Counts` / `System/Info` / `Views` /
> `Items?ParentId=` / `System/Ping` / 两版进度上报（新版族三条 + 旧版族三条）/ 三条观看状态写端点 / **收藏写端点 + 收藏列表**），其中 `Studios` 与 `NextUp` 是**回空** —— `Studios` 没有那份数据、空是如实
> （`Studios` 自 14-1 起**要 token**）；`NextUp` 是**端点保留、对外恒空**（藏掉与「继续观看」重复的一行，见 [ADR-0060](adr/0060-nextup-hidden.md)）；
> `Items/Counts` 自 16-1 起**也要 token**，且其 `MovieCount`/`SeriesCount`
> 已改为取**首页插件申报的库总数**、`EpisodeCount` 取**剧库行申报的集数**（其余字段仍回 0），见「五」；
> `Resume` / `Items?Filters=IsPlayed` 自 [0023](adr/0023-playback-progress.md) 起出**真数据**，
> `Items?Filters=IsFavorite` 自 [ADR-0058](adr/0058-favorite-items.md) 起出**真数据**（读 `favorite` 表、**0 上游请求**）。
> **还没做的端点级缺口**（`GenreItems` 的列表端点、`Sessions/Logout`、`/Users/Public`、用户级 `Similar`）
> 记录在 [develop.md](develop.md) 的「未实现」一节。

> **几个客户端的画像**（全部来自日志）：
>   · **Rex** —— 库内容走 `Items?ParentId=<库Id>`；另外发**无 `ParentId` 的「推荐」查询**（喂首页轮播图，见「五」）
>     与 **`AnyProviderIdEquals={域}.{编号}`**（只有上游编号 → 问本面板要 Id → 拿到就进详情）；要过 `Studios`；
>     也收藏条目（`POST FavoriteItems` + `Items?Filters=IsFavorite`，见「五」与 [ADR-0058](adr/0058-favorite-items.md)）。
>   · **VidHub 3.0.6** —— 首页**每一行**走 `Items/Latest?ParentId=<库Id>`；另外要 `System/Info`（它容忍过 501；现已实现，见「五」与「十」#20）。
>   · **Filmly 2.12.11-439** —— 要过 `System/Info`（此前落到 501；现已实现为诚实子集，见「五」与「十」#20）。
>   · **CapyPlayer 1.1.3** —— 打开条目详情后会要 **`Items/{ItemId}/SpecialFeatures`**（条目的花絮 / 特别收录）；
>     判**界外、不实现**（片源插件只有正片、查不到花絮，认领了也只能回空，见「七」）。
>   · **SenPlayer 6.1.8** —— 要过 `Shows/NextUp` / `Items/Counts` / `System/Ext/ServerDomains`；
>     **搜索框走 `Items?SearchTerm=`**（实测；以前回空 → 搜索永远是空的）；
>     另会打非 Emby 协议的 `api/danmu/{条目Id}`（弹幕插件，**501，暂不实现**）。
>   · **Lenna 1.0.16** —— 要过 **`System/Ping`**（连通性探针；此前落到 501，现已实现，见「五」与「十」#19）。
>     目前只见它打这一条，其余流程待后续日志补全。
>   · **结论**：某条端点"没人要"**只对当时那批客户端成立** —— `Items/Latest` 原先就记着
>     "实测客户端从没打过"，来了 VidHub 直接作废（Rex 走的是 `Items?ParentId=`，只盯 Rex 的日志根本看不到）。
>     所以不要把"没人要"当永久结论，新客户端一进来就得重新看一遍。
> `Shows/{Id}/Seasons`、`Shows/{Id}/Episodes` 仍是 **上游占位**（见「五」）—— 它们**不走聚合、没有源绑定**；
> 它们的「真实条目 + 源绑定」（上游编号 → 站点 `vod_id`）仍是待指定。

## 八、参考：源服务自带的相关能力

这些在**源服务**侧（`/website/api/**`，面板已同源代理到 `/website`），可作为实现时的参考，但不等于 Emby 客户端协议：

- `GET /website/api/emby/config`、`POST /website/api/emby/test`、`POST /website/api/emby/choose` —— 源里的多台 Emby 服务器配置与默认选择
- 源里的 `EmbyDiy` 通过 `ext` 的 `embynumber` 读取服务器序号
- 播放链路：`POST {api}/play` 得到 `url`（字符串或数组）+ `header`

## 九、相关文件

| 文件 | 作用 |
|---|---|
| `server/modules/emby/routes.js` | 已实现端点（握手 / 登录 / 取用户资料 / 媒体库留白 / 条目列表占位 / 季列表占位 / 分集列表占位 / 单条详情 / PlaybackInfo / Stream）+ 面板自用端点（账号管理 `GET/POST /api/emby/accounts`、`PUT/DELETE /api/emby/accounts/{id}`）+ 通配监控路由（记录 + 501，与 `notImplemented()` 共用），**通配必须注册在最后**。stream 端点在这一层**一律 302**（service 只回 `{url, headers, parse}` 描述，地址改写也在 service 做，见 `redirectUrl()`）；路由把 `req.headers.host` 传下去当"客户端域名" |
| `server/modules/emby/db.js` | emby 私有的本地库（**Node 内置 `node:sqlite`**，零依赖）：开库/建表/schema、`accounts` 表（用户名 + `username_lc UNIQUE` + scrypt 哈希 + 最近登录）、`sessions` 表（登录发的 AccessToken → 账号/设备/最后活跃）、`hashPassword/verifyPassword`、账号与会话的 CRUD、`publicAccount()`（**对外字段映射只此一处**，防手滑回传哈希）、`migrateLegacy()`（单账号明文 → 库，并**无条件清掉设置里的残留明文**）。文件 `data/emby/emby.db`，权限 600；**不存 `user_id` 列**（serverId 一变就全废，运行时现算） |
| `server/modules/emby/service.js` | 端点业务逻辑：服务器 Id、登录校验（多账号 + scrypt）、**AccessToken 校验（`tokenFrom` / `authorize`，无效即 401）**、UserDto 组装、媒体库（`getViews`——**按真机字段表补齐，含封面与 `CollectionType`**）、条目列表（`getItems`）、**最新条目（`getLatest`，回裸数组，顺序由模块决定）**、季列表、分集列表、单条详情（元数据复用列表实现 + 聚合取线路/绑定 + 线路→`MediaSources`）、播放信息（复用 getItem）、拉流解析（`resolveStream`：现取 detail+play，只回描述，不碰 res）；公共函数 `assertUser()`（账号校验，各端点共用）/ `baseItem()`（条目公共字段）/ `metaFailure()`（上游失败 → 状态码 + 错误体，各端点共用）/ `mbpSourceId()` + `parseMbpSourceId()`（`mbp:` + base64url(deflateRaw(JSON `{r, v?, s?}`)) 的编解码）/ `streamPath()`（稳定 Path 拼接）/ `emptyUserData()` + `emptyViewUserData()`（**条目与库条目的 `UserData` 形状不同**）/ `feedOfQuery()`（认出客户端"只要推荐"的轮播查询 → 路由到插件声明了 `feed` 的行）/ `libraryQueryOf()`（认出"无 `ParentId` 的裸列表查询" → 回顶层库列表，与 `Views` 同款）/ `imageTag()`；`X-Emby-Authorization` 解析 |
| `server/modules/agg/match.js` | **挑片判据（唯一一处）**：片名清洗（剥更新话术/画质/体积/年份/括号/分类后缀、去 emoji）+ 打分（名字 0.7 / 季集 0.2 / 年份 0.1，缺项不进分母）+ 两道闸门（名字硬拒 / 分数线可关）+ 按分数「取前 N」（**不去重**：同名照收，只统计）+ **片源认证短路**（候选行带 `vod_exact === true` → 直接记 1、不判名字，见 [ADR-0059](adr/0059-source-certified-candidate.md)）。取代了原来的「精确同名 + 上游别名回退」 |
| `server/modules/agg/api.js` | **聚合层的进程内调用面**：`loadSites()`、`detail()`（**内部含搜索**，可用 site+vodId 走快路径）、`play()`（→ 播放地址，PlaybackInfo 会用）。路由层（`/api/agg/detail` / `/play`）与 emby 层**共用这一套**；失败统一 `{ok:false, error:{code,status,message}}` |
| 聚合层契约（[develop.md](develop.md) 的「聚合层（agg）」一节） | `/api/agg/search`、`/api/agg/detail`、`/api/agg/play` 的入参、出参与错误码 |
| 元数据插件源码（不在本仓库） | **元数据插件（域由插件自己申报）**：它自己的请求层 = 上游协议层 + 落盘缓存（元数据缓存的判据 / `cacheKey()` / `requestCached()` / `requestWithRetry()` / `search()` / 图片拼串 / `test()`，表 `meta` 与 `names` 落它自己的 `data/cache/`）、归一化（rich 字段 / 别名回退 / 季集）、它自己的设置（token / 基地址 / 语言 / 缓存策略）、它自己的设置页；动作 `register` / `lookup` / `season` / `search` / `get` / `test` / `http`。**面板不读它的设置**，只从「注册」拿图片基地址（契约第六节，决策见 [adr/0031](adr/0031-metadata-by-domain.md)） |
| `server/core/cachedb.js` | **缓存的通用设施**（从 `emby/cache.js` 抽出来）：`createStore({label,dir,file,tables})`（**同 label 单例**：一库一句柄，避免 WAL 互锁）、`get`/`put`/`enforce`（TTL + 按字节 LRU）、`stats`/`clear`/`sweep`，以及跨 store 的 `statsAll()` / `clearAll()` / `sweepAll()`（面板的用量、清空、设置变更后扫一遍都走它们）；`cfg()`（缓存策略**只此一处**，读 `panel.json` 的 `cache.*`）。WAL + `synchronous=NORMAL`。⚠️ 元数据与名字搜索的缓存**不在面板**（随插件走，见上面「元数据插件」那条） |
| `server/modules/emby/meta-bridge.js` | **emby 专有那一层**（取数已搬进插件，这里只留 DTO 要的那点东西）：`itemId()`/`parseItemId()`（条目 Id 派生与解析，**互逆且必须挨着**，支持 `_{tv\|movie}[_s{n}][_e{m}]`，前缀来自 `core/providers.js`）、`lookup()` / `lookupSeason()` / `search()` / `get()`（转发给插件，字段名沿用插件那套域中立叫法）、`httpStatusOf()`（失败原因 → 回的 HTTP 码，**只此一处**）；图片：`imageUrlOf()`（基地址来自插件的域声明；插件给整串 URL 时原样返回，索引里存的就是完整 URL） |
| `server/modules/emby/cache.js` | emby 自用的缓存（**独立** SQLite `data/emby/cache.db`，与账号库 `emby.db` 分开）：**只剩 `image_index`**（条目 Id → 图片位置，含插件给的自定义图地址）；`getImage`/`putImage`、`cfg()`（转调 `core/cachedb.js`）、`sweepFromSettings()`。旧的元数据插件缓存与 `view_seen` 已搬走/删除（见上面「本地缓存」那条）；统计与清空**不在这里**（面板层统一，见 `core/cachedb.js`） |
| `server/modules/emby/log.js` | 请求日志（**每请求一行，不筛**）：`logResult` / `logMissing`（501 一行 + `logSeq`）/ `countOf`（只给日志数条数）/ `queryBrief` / `clientTag`；敏感信息掩码在 `queryBrief` 与 `logMissing` 里（见「二」） |
| `server/core/logbus.js` | 日志总线：`install()` 包一层 `console.log/warn/error`（**先透传 stdout，再入内存环形缓冲**）、按行拆分、单条截断 1000 字符、固定条数（默认 500，`panel.logMax` 可调）；`list()`/`clear()`/`resize()`/`stats()`。**纯内存、不落盘**（长期留档交给 docker 的 json-file）。在 `server.js` 里**加载模块之前**装（见「二」） |
| `server/modules/panel/routes.js` + `public/modules/panel/logs.js` | 日志页的数据口与页面：`GET /api/logs?since=&limit=`（增量）、`DELETE /api/logs`（清空）；页面「面板设置 → 日志」带暂停/清空/复制/级别过滤，增量轮询 + `isConnected` 守卫（见「二」） |
| `server/modules/emby/index.js` | 模块清单：`upstream: 'agg'`、账号空壳设置（`serverName` / `serverId` / `imageKey` **已从设置里移出** —— 它们是**实例属性**，落在 `data/emby/instances.json`，见 `instance.js` 的 `identityOf`）。**`play.filter` 已搬到聚合层**（`agg.json` 的 `lineFilter`，UI 在「聚合设置 → 聚合参数」），那份校验也跟着走了；`play.mode`（随"面板代理"一起删）、`cache.*` 与元数据的老设置键都不在这里了；这里也不再需要"放行老值"的兼容校验 —— 校验里没有那个键，盘上留着也不挡保存 |
| `server/modules/emby/instance.js` + `listener.js` | **多实例**：`instances.json` 是唯一真源（id / name / port / enabled / allowDownload / homePlugin / serverId / imageKey / dbFile）；`AsyncLocalStorage` 把"当前实例"贯穿到 `service.js` 与 `db.js`（不动那几千行）。`listener.js` 给每个启用实例在**它自己的端口**上挂一个 http 服务，与面板端口同一套路径归一化，但只放行客户端协议端点（面板自用端点由 `PANEL_ONLY_RE` 挡掉）。**面板端口反过来**：`server.js` 只放行面板自用端点 + `System/Info/Public` 垫片，其余客户端协议端点一律 404（两处名单互为对称） |
| `server/modules/panel/index.js` | 面板层设置与钩子：`logMax`（改了就 `resize`）、**`cache.*`**（面板这边那两份缓存；`onSettingsChange` 里调 `cachedb.sweepAll()` 落实新上限）。⚠️ 元数据的老设置键已不在面板层（归元数据插件） |
| `public/modules/emby/instances.js`（「Emby → 实例」页） | 实例列表：每行是名称 / 端口徽章 / **首页插件行内下拉**（点一下就 PATCH）/ 运行状态点（端口被占时红点 + 原因）/ 连接地址（一键复制）/ 编辑 / 删除（默认实例不给删）。编辑弹窗含名称、端口、首页插件、搜索域、**下载（允许下载，默认勾选）**、启用；**服务器名就是这个实例的 `name`** |
| `public/modules/emby/accounts.js`（「Emby → 账号」页） | 顶部**实例选择器**，下方账号增删改只作用于所选实例（端点 `/api/emby/instances/{iid}/accounts`）；每行带上该实例的 `UserId`（`md5(serverId\|用户名)`，服务端现算），便于对着客户端日志排查 |
| `public/modules/panel/settings.js`（「面板设置」页） | 「设置」子项：**缓存设置**（用量 + 上限 + 清空，端点 `GET\|DELETE /api/panel/cache`）/ **站点测速**（开关与间隔）；同模块另有「备份与还原」（`renderPanelBackup`）、「安全」（改面板密码，`renderPanelSecurity`）两个子项。⚠️ **元数据设置已不在这一页**（归元数据插件自己的设置页：「插件」→ 该插件 → 「设置」） |
| `public/modules/panel/overview.js`（「面板设置 → 概览」页） | 运行环境 + 两个整机动作：**面板重启**（`POST /api/panel/restart`，受托管时写 `.restart` 让引导脚本拉起同一版本；非托管时退出前自拉起，见 [ADR-0038](adr/0038-self-relaunch-when-unmanaged.md)。容器不动）与**退出登录** |
| `data/settings/emby.json` | `account`（**只剩空壳**，账号已搬到 sqlite）。（`serverId` / `imageKey` **已迁出**到 `data/emby/instances.json`，首次加载时从旧值搬一次；`cache.*` 搬到 `panel.json`、元数据的老设置键归元数据插件；`play.filter` 搬到 `agg.json` 的 `lineFilter`，盘上那几个老键既不读也不校验） |
| `data/settings/panel.json` | 面板监听参数、`logMax`、`modules`、`speedTest*`、**`cache.{imageTtlDays,imageMaxMB,linesTtlDays,linesMaxMB,linesNeverExpire}`**。⚠️ 元数据的老设置键已不在这里（归元数据插件自己的 `data/settings.json`）；盘上留着老键也没人读 |
| `data/emby/emby.db` | 客户端登录账号表（内置 sqlite；密码为 scrypt 哈希）。**数据备份包含它**（`backup.js` 打包整份数据卷，`emby/` 在其中）—— 还原后账号跟着回来，但需重启面板才生效 |

## 十、真机对照记录

逐条对照「面板实现」与「真机返回」。每条记：**真机样本 / 面板响应 / 差异 / 结论**（一致 · 已修 · 不能模拟）。**改代码前先在此登记差异，待确认后再动**。

**四台真机**（本机私有环境，**不入库**）：地址、端口、账号、口令、版本只写在**本机** `data/真机环境.md`（`data/` 已 gitignore）。本文以下只用**代号**指代：予初Emby / OkEmby / nyamedia / itsmygo。

**探针约定**（#18 起）：4 台**并行**打、单请求 8s 超时、超时即跳过该台，**有一台成功就继续**（网络不稳，不再逐台串行死等）。客户端身份照 `proxypin_itsmygotv` HAR 里的 **Rex 客户端**模拟：`X-Emby-Authorization: MediaBrowser Token="…", Emby UserId="…", Client="Rex", Device="iPhone17,1", Version="1.0.0"` 并另带 `X-Emby-Token`，`User-Agent: Rex-Standard/1.0.0`。

itsmygo 是 **openresty + Go 的仿 Emby 服务**（响应头 `X-Itsmygo-Backend: go`），端点挂在 **`/emby` 基路径**下，条目 `Id` 是标准 Guid。予初Emby / OkEmby / nyamedia **网络时通时断**（多轮出现整台超时）；itsmygo 稳定。取不到样本的行**留待补测**、不编数据。


### 索引

一条端点一份，明细在 [emby-realdevice/](emby-realdevice/)（本仓库，**改哪条读哪条**，别整读）。

| # | 端点 | 状态 | 明细 |
|---|---|---|---|
| 1 | `GET /api/emby/System/Info/Public`（握手） | 未复测 | [#1](emby-realdevice/01-system-info-public.md) |
| 2 | `POST /api/emby/Users/AuthenticateByName`（登录） | 未复测 | [#2](emby-realdevice/02-users-authenticatebyname.md) |
| 3 | `GET /api/emby/Users/{UserId}`（取用户资料） | 未复测 | [#3](emby-realdevice/03-users-userid.md) |
| 4 | `GET /api/emby/Users/{UserId}/Views`（媒体库列表） | 未复测 | [#4](emby-realdevice/04-users-userid-views.md) |
| 5 | `GET /api/emby/Users/{UserId}/Items`（条目列表） | 面板端已验（5-4 裸列表查询已按予初Emby 实测改正为回库列表；余量真机复测待做） | [#5](emby-realdevice/05-users-userid-items.md) |
| 6 | `GET /api/emby/Users/{UserId}/Items/Latest`（最新条目） | 未复测 | [#6](emby-realdevice/06-users-userid-items-latest.md) |
| 7 | `GET /api/emby/Shows/{Id}/Seasons`（剧的季列表） | 已落码（未复测） | [#7](emby-realdevice/07-shows-seasons.md) |
| 8 | `GET /api/emby/Shows/{Id}/Episodes`（剧 / 季的分集列表） | 已落码（未复测）；无开放差异 | [#8](emby-realdevice/08-shows-episodes.md) |
| 9 | `GET /api/emby/Users/{UserId}`（取用户资料 / `UserDto` 本体） | 维持现状（未改代码） | [#9](emby-realdevice/09-users-userid-dto.md) |
| 10 | `GET /api/emby/Users/{UserId}/Items/{ItemId}`（条目详情 / `BaseItemDto` 本体） | 已落码（未复测） | [#10](emby-realdevice/10-items-itemid-detail.md) |
| 11 | `POST /api/emby/Items/{ItemId}/PlaybackInfo`（播放信息 / `PlaybackInfoResult`） | 已落码（未复测） | [#11](emby-realdevice/11-items-playbackinfo.md) |
| 12 | 直连拉流（`GET /api/emby/videos/{ItemId}/{file}` · `Items/{ItemId}/Stream/{token}` · `Items/{ItemId}/Download`） | 已落码（未复测）；实例端口已加根路径兜底（[ADR-0065](adr/0065-instance-port-root-path-fallback.md)），**未复测** | [#12](emby-realdevice/12-direct-stream.md) |
| 13 | `GET /api/emby/Users/{UserId}/Items/Resume`（继续观看） | 已落码（未复测） | [#13](emby-realdevice/13-users-userid-items-resume.md) |
| 14 | `GET /api/emby/Studios`（工作室清单） | 已落码（未复测） | [#14](emby-realdevice/14-studios.md) |
| 15 | `GET /api/emby/Shows/NextUp`（接下来看） | 已落码（未复测）；**端点保留、对外恒空**（[ADR-0060](adr/0060-nextup-hidden.md)） | [#15](emby-realdevice/15-shows-nextup.md) |
| 16 | `GET /api/emby/Items/Counts`（条目计数） | 已落码（未复测） | [#16](emby-realdevice/16-items-counts.md) |
| 17 | `GET /api/emby/Items/{ItemId}/Similar`（相似推荐） | 已落码（未复测） | [#17](emby-realdevice/17-items-similar.md) |
| 18 | `GET /api/emby/Items/{ItemId}/Images/{type}[/{index}]`（条目图片） | 维持豁免（有意偏离 / 取 404） | [#18](emby-realdevice/18-items-images.md) |
| 19 | `GET /api/emby/System/Ping`（连通性探针） | 已落码（未复测） | [#19](emby-realdevice/19-system-ping.md) |
| 20 | `GET /api/emby/System/Info`（带 token 的完整服务器信息） | 已落码（未复测） | [#20](emby-realdevice/20-system-info.md) |
| 21 | `POST\|DELETE /api/emby/Users/{UserId}/FavoriteItems/{ItemId}`（收藏 / 取消收藏）+ `Items?Filters=IsFavorite`（收藏列表） | 已落码（未复测） | [#21](emby-realdevice/21-favorite-items.md) |
| 22 | `POST\|DELETE /api/emby/Users/{UserId}/PlayingItems/{ItemId}[/Progress]`（旧版播放上报族） | 已落码（未复测） | [#22](emby-realdevice/22-users-userid-playingitems.md) |
| 23 | `GET /api/emby/Videos/{ItemId}/{MediaSourceId}/Subtitles/{Index}/Stream.{Format}`（字幕内容） | 已落码（未复测）；无真机样本 | [#23](emby-realdevice/23-subtitles.md) |
