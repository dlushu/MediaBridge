# 变更记录

本文件记录值得用户注意的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 变更

- 公告与登录后弹窗增加 Telegram 交流群入口，移除公告正文中的维护说明。

## [1.9.4] - 2026-10-10

### 变更

- **集名里的 `.iso` 现在认作容器**：`parseEpisodeMeta` 的容器清单补 `iso`（光盘原盘镜像，
  老片合集常见）。此前 `.iso` 播放项的 `container` 解析为空、标准文件名还会兜底拼成 `.mkv`；
  现在 `MediaSource.Container` / 版本文件名如实标 `iso`。**客户端无需改动**（能不能播 ISO
  由客户端自己决定，面板如实透传）。
- **聚合搜索「这条的版本」弹窗的字幕轨显示来源**：每条字幕轨多标一个**字幕插件名**（面板自用 API
  `/api/agg/detail` 的 `subtitles[]` 新增 `source`），装多个字幕插件时能看出这条轨从哪来。
  对 Emby 客户端零影响（`source` 只走面板自用 API，emby 层不读它）。同时修掉**长文件名撑破弹窗**
  的老问题（字幕轨名字是文件名，含长哈希 / 无空格长串时不再溢出，改为折行）。

## [1.9.3] - 2026-10-09

### 新增

- **agg 流端点增加带后缀的别名 `/api/agg/stream.m3u8`**：有些播放器 / 客户端按 URL 后缀识别容器，
  缺后缀就把面板这条 HLS 出口当普通文件拒掉。新路径与 `/api/agg/stream` **同一个 handler**、
  同一套凭证与搬运语义，只是路由落在带 `.m3u8` 的形状上；面板内部改写出的签名子地址仍走原路径
  （见 [ADR-0075](docs/adr/0075-stream-suffix-alias.md)）。
  - 面向面板之外的客户端（出口插件 / FW / Rex widget 等）；**面板 Web 与 Emby 客户端不受影响**。
    契约行见 [docs/develop.md](docs/develop.md) 的聚合层接口表。

## [1.9.2] - 2026-10-09

### 变更

- **聚合搜索「这条的版本」弹窗显示字幕**：面板聚合层新增字幕编排 —— 打开「这条的版本」时，
  为一个播放目标问一次字幕插件（`tracks`），把字幕轨列在弹窗里。此前字幕只在 Emby 客户端可见。
  字幕插件转接处由 emby 层迁到聚合层，web 与 Emby **共用同一处字幕来源**
  （见 [ADR-0073](docs/adr/0073-subtitle-tracks-in-agg-detail.md)）。
  - 面板自用 API `/api/agg/detail` 响应**新增 `subtitles`**（`[{lang, format, label?}]`；
    内部 `ref` 凭据**不在 HTTP 出口下发**）。契约行见 [docs/develop.md](docs/develop.md)。
  - **对 Emby 客户端无任何可见变化** —— 字幕轨形状、字幕内容端点、鉴权口径、`MediaSourceId` 载荷
    均与上一版一致（客户端无需改动）。

### 修复

- **字幕地址自带 token，修客户端取字幕 401**：字幕流的 `DeliveryUrl` 此前是**裸相对路径、不带 token**，
  而客户端（实测 **Streama/1.0.55 android**）把它**原样**发出、不自己追加 token → 面板判「没带 token」→
  字幕一律 **401**（拉流因 `DirectStreamUrl` 本就埋了 `api_key` 所以正常）。现在字幕地址与 `DirectStreamUrl`
  同口径，末尾自带本请求的 access token（`…/Stream.{Format}?api_key=…`，见
  [ADR-0074](docs/adr/0074-subtitle-deliveryurl-embedded-token.md)）。
  - **影响端点**：详情与播放信息里**字幕流**的 `DeliveryUrl`（多一个 `api_key`）；字幕内容端点本身、
    鉴权口径、`MediaSourceId` 载荷、`Path` / `DirectStreamUrl` 均不变。**客户端无需改动。**
    逐条见 [emby-realdevice #23](docs/emby-realdevice/23-subtitles.md) 的 23-5（**未复测**）。
- **插件动作失败回执保留真因**：插件动作抛异常时，面板除 `code` / `message` 外**一并带回异常的
  `cause`**（`error.cause = { code?, message? }`）。Node `fetch()` 失败时 `message` 恒为一句
  `fetch failed`，真因（如 DNS 的 `ENOTFOUND`、端口非法的 `bad port`）在 `cause` —— 此前会被压成
  通用的 `PLUGIN_ERROR: fetch failed`（[runner.js](server/modules/plugin/runner.js) 动作异常回执）。
  影响面：`POST /api/plugins/:type/:id/call` 及其下游（如 Emby 字幕端点）现在能看到更具体的失败原因；
  成功路径与既有 `code` / `message` 字段不变（**兼容追加**，见插件契约 devkit `plugin-contract.md` 第十节）。

## [1.9.1] - 2026-10-09

### 新增

- **品牌图标**（详见 [ADR-0069](docs/adr/0069-brand-graphic-assets.md)）：
  新增品牌图形资产，落地到浏览器标签页与 Emby 默认头像；**界面内（顶栏、日志）仍只有文字**。
  - `public/logo.png`（512×512 透明底）作为浏览器标签页图标（favicon），
    `public/index.html` 与 `public/login.html` 各加一条 `<link rel="icon">`；README 顶部也引用这张图。
  - `server/modules/emby/assets/default-avatar.png` 换成同一张品牌图（仍是 606×606 透明底，
    Emby 默认头像口径不变）。
  - **对客户端的影响**：浏览器标签页多一个图标；Emby 默认头像换图 —— 尺寸与 `tag` 口径不变
    （`tag` 仍是文件内容 md5），客户端会因内容变化重新拉一次头像。**不涉及任何 Emby 端点契约。**

- **「关于」页内嵌公告**（详见 [ADR-0068](docs/adr/0068-about-page-embedded-notice.md)）：
  「设置 → 关于」页新增一张**公告**卡，内容取自**仓库里的 `notice.html`** —— 交流群地址、贡献者名单
  这类内容与代码分开维护，改仓库里那个文件即生效，不需要重新发版。
  - **新增端点**：`GET /api/panel/notice` → `{html, url, error?}`（带 5 分钟缓存）。
    `html` 默认取自 `https://raw.githubusercontent.com/<repo>/main/notice.html`，**经取源候选**
    （`APP_MIRRORS`，与面板更新、插件库共用，见 [ADR-0067](docs/adr/0067-mirror-fallback-sources.md)）。
  - 新增环境变量 `PANEL_NOTICE_URL` 可覆盖取回地址（显式给出时不套镜像前缀）；置 `off` / `none` / `-`
    关闭这张卡。
  - **内容为空或取不到 → 整张卡不显示**；内容以隔离的内嵌 frame 渲染，**不执行脚本**、样式与面板隔离。
  - **对客户端的影响**：仅面板「关于」页多一张卡；不涉及 Emby 端点。
    ⚠️ 走第三方代理时取回的内容可能与仓库原文不同，故按不可信内容渲染（不跑脚本）。

- **字幕插件（第五类插件）与 Emby 标准字幕端点**（契约变更记录见 [docs/emby-compat.md](docs/emby-compat.md)；
  插件侧契约见插件仓库 `media-bridge-plugins/docs/plugin-contract.md`「七、字幕插件的动作」）：
  面板新增第五类插件 `subtitle`，并落地 Emby 标准的字幕取用端点。
  - **新增端点**：`GET /api/emby/Videos/{ItemId}/{MediaSourceId}/Subtitles/{Index}/Stream.{Format}`
    （含带 `StartPositionTicks` 的变体）—— `{Format}` ∈ `srt/ass/ssa/vtt`。面板从版本 Id 载荷里
    取出该轨的 `ref`，交给字幕插件的 `fetch` 动作取回内容后回**字节**
    （`Content-Type` 优先取插件给的，没给才按 `Format` 兜底）。
  - **详情 / 播放信息里挂字幕轨**：条目详情、`PlaybackInfo` 的 `MediaSources[].MediaStreams[]`
    追加 `Type:'Subtitle'` 的流（`Index` / `Codec` / `Language` / `DisplayTitle` / `DeliveryUrl` 等），
    轨来自字幕插件 `tracks` 动作的申报。版本 Id 载荷由 `{r, v?}` 扩为 `{r, v?, s?}`
    （`s` = 流序号 → 字幕 ref 的映射；**无字幕则不写**，载荷与旧版完全一致）。
  - **影响哪些端点**：`GET /api/emby/Users/{UserId}/Items/{ItemId}`（详情）、
    `POST /api/emby/Items/{ItemId}/PlaybackInfo`，以及上面新增的字幕内容端点。
  - **对客户端的影响**：装并启用字幕插件后，版本会多出字幕轨、客户端可选中取用；**没装字幕插件
    则一切与从前完全一样**（不出字幕轨、载荷不变）。字幕插件是**软依赖** —— 没装 / 没在跑 /
    `tracks` 失败都只降级（不出字幕轨、记一行日志），**不破坏详情本身**。
  - 真机对照见 [docs/emby-realdevice/23-subtitles.md](docs/emby-realdevice/23-subtitles.md)（**未复测**：
    本仓库内没有真机样本，落地依据是 Emby 官方端点形状 + 插件契约，不是抓包）。

- **取源候选：内置公共 gh 代理，国内默认直连**（详见 [ADR-0067](docs/adr/0067-mirror-fallback-sources.md)）：
  - **改的是什么**：从 GitHub 取东西时，**默认先试内置公共 gh 代理**（`https://gh-proxy.com`、
    `https://ghfast.top`），失败再退到官方直连；单次请求 20 秒超时。**面板更新与插件库共用这一套**：
    - 应用代码（查最新版本 + 下版本包 + 下校验）；插件库（取清单 `index.json` + 取插件包）。
  - 新增环境变量 `APP_MIRRORS`（逗号分隔、有序）可覆盖；置 `off` / `none` / `-` 只走官方。
  - **影响哪些端点**：面板侧「版本与更新」、容器首启的取源，以及 `GET /api/plugins/library` 的
    `sourceUrl` 与插件安装取包（不涉及 Emby 端点）。
  - **对客户端的影响**：国内部署无需再手工找代理即可取源（含插件库）；原来只有显式 `PLUGIN_*_URL`
    才能指定源，现在留空即走候选、失败自动降级；在意校验的用户可关掉镜像。
  - ⚠️ **安全口径**：走第三方代理时包体与其校验值（应用代码 `.sha256`、插件 md5）同源，校验
    **只防传输损坏、不防代理替换**（有意接受的取舍，见 ADR-0067）；要真实校验就把
    `APP_SOURCE_URL`（或 `PLUGIN_INDEX_URL` / `PLUGIN_SOURCE_URL`）指向自己信任的镜像。
  - 引导脚本在 `docker/`（不入库），本次同改；**需重推镜像**才对新容器生效。

### 变更

- **品牌净化：对外 DTO 的自家字段与不透明 Id 前缀去掉 `catpaw`**（契约变更记录见
  [docs/emby-compat.md](docs/emby-compat.md)）：
  - **改的是什么**：`ProviderIds.Catpaw` → `ProviderIds.MediaBridge`；非标准字段
    `CatpawSource` → `MediaBridgeSource`（其 `LineFilter` 子对象同改）；版本 / 媒体源 Id 前缀
    `catpaw:` → `mbp:`（`catpawSourceId` / `parseCatpawSourceId` → `mbpSourceId` / `parseMbpSourceId`）；
    媒体库（Views）Id 前缀 `catpawhome_` → `mbphome_`；`PresentationUniqueKey` 前缀 `p-catpaw-` → `p-mbp-`。
    另：面板自述 `GET /api/meta` 的 `service` 由 `catpaw-panel` 改为 `mbp-panel`；登录 cookie 名
    `catpaw_panel` → `mbp_panel`；备份包 manifest 的 `service` 同步改为 `mbp-panel`（**旧备份包不再接受还原**）。
  - **影响哪些端点**：`GET /api/emby/Users/{UserId}/Items/{ItemId}`（详情）、`POST /api/emby/Items/{ItemId}/PlaybackInfo`、
    拉流 / 下载 / 字幕各端点里出现的版本 Id，以及 `GET /Users/{UserId}/Views`（库 Id）。
  - **对客户端的影响**：改的**全是不透明标识或面板自用字段**（客户端只当字符串、或直接忽略），
    **客户端无需改动**；但客户端若缓存了旧的库 Id / 版本 Id，换版后对不上会取不到内容，**清一次客户端缓存 /
    重新拉库列表**即可。**服务端数据无迁移**：这些前缀都是运行时现算、不落库（`emby.db` 五表无任何
    `catpaw` 列），故不注册迁移任务、数据版本不动。
  - 真机对照见 [docs/emby-realdevice/04](docs/emby-realdevice/04-users-userid-views.md) /
    [10](docs/emby-realdevice/10-items-itemid-detail.md) / [23](docs/emby-realdevice/23-subtitles.md)（**未复测**）。
  - 同时清掉面板自身文案 / 注释 / 示例里点名具体源的写法（设置项提示、聚合层注释、`develop.md` 的
    `source` 示例、`package.json` 关键词、`CONTRIBUTING.md` 术语表），面板不点名任何源、也不假设源的形态。
    这些不进契约、对客户端无影响。

- **仓库与镜像改名，统一到 `MediaBridge` / `mediabridge`**：
  - **GitHub 仓库** `dlushu/media-bridge-panel` → `dlushu/MediaBridge`：自更新取 Release 的默认仓库路径
    （`APP_REPO`）随之改为 `dlushu/MediaBridge`，`package.json` 的 `repository.url` 与 README 同步更新。
    旧地址由 GitHub 重定向仍可访问，已装环境无需改动。
  - **Docker Hub 镜像** `dlushu/media-bridge-panel` → `dlushu/mediabridge`（Docker Hub 名称须小写，
    故用 `mediabridge`）。**旧镜像名不再更新**，用旧名的部署需把 `docker run` / compose 里的镜像名换成
    `dlushu/mediabridge` 后再拉取。数据卷名 `media_bridge-data`、容器名、发布资产名
    `media-bridge-panel-<版本>.tar.gz`、备份文件名等均未变，改名不影响已有数据。

- **登录态有效期可调，且改为「滑动过期」**（语义与取舍见 [ADR-0064](docs/adr/0064-panel-session-sliding-expiry.md)）：
  面板会话的有效期不再写死 30 天，可在「面板设置 → 安全」页按「数值 + 单位（分钟 / 小时 / 天）」调整，
  **默认 15 分钟、最大 30 天**。语义由"到点强制退出"改为**空闲计时** —— 从**最后一次操作**起算，
  一直在用就自动顺延，只有**空闲满这一时长**才需要重新登录（会话在用到有效期的 1/4 时自动续签）。
  密码 / 登录接口的响应形状不变，`iat` 字段对前端不可见（会话是 HttpOnly cookie）。

- **登录改为独立页面 `/login.html`**：未登录访问面板会跳到该页，登录后跳回原地址。
  「记住密码」有两条路：① **浏览器 / 密码管理器的表单记忆**（真实 `<form>` + 命名输入框 + `autocomplete`）；
  ② 页上的**「记住密码」勾选框** —— 勾选且登录成功后，密码经 **Base64 混淆**存进本机浏览器存储
  （localStorage），下次打开登录页自动预填，取消勾选即清除。混淆不是加密（防随手翻看、防不了懂行的人），
  默认不勾，请按设备信任程度取舍。

- **开源协议由 MIT 改为 AGPL-3.0**。

### 修复

- **测速汇总行口径写错**：`成功 N（含 M 个无结果）` 里 M 其实**不在** N 里
  （计数是三桶互斥：有结果 / 无结果 / 失败），M > N 时读来矛盾。按业务口径
  「无结果 = 站活着、不算失败」改为 `成功 N+M（其中 M 个无结果）`，数字对得上总数。
  只改日志措辞，`okCount` / `emptyCount` 的 API 口径不变。

- **开机时首页插件行清单空打一轮 `NOT_READY`**：启动顺序是拉起插件进程后立刻预热行清单，
  但插件握手是异步的——还没就绪的插件（日志里两行 `✘ …插件还没就绪`）纯属启动竞态。
  现在预热先等插件就绪（轮询 `running`，起不来 / 崩了 / 超时就跳过）再拉行清单，
  这两行噪音日志消除，预热一次到位；拿不到的老兜底（快照过期自动重刷）不变。

- **老内核 / 网络盘环境缓存库连环报错**（GitHub issue #3，`disk I/O error` → `no such table: line_cache`）：
  - **根因一**：缓存库（线路结果 / 图片索引）开 WAL 需要共享内存，CentOS 7 老内核 overlayfs、
    NFS / SMB 卷上拿不到，`PRAGMA journal_mode = WAL` 直接抛 `disk I/O error`。
  - **根因二（面板 bug）**：`cachedb.open()` 先把句柄赋给模块级变量、后跑 pragma 与建表，
    pragma 一抛错就留下**半初始化句柄**——之后所有访问报 `no such table`，完全掩盖真实原因。
  - **改的是什么**（[ADR-0072](docs/adr/0072-cachedb-wal-fallback-delete-journal.md)）：
    `open()` 原子化（全部初始化成功才登记句柄，失败关库重抛）；WAL 起不来时打一条 `✘` 级日志
    并**降级 DELETE journal 继续跑**——缓存是可丢数据，不该为它让整个功能不可用。
  - **对用户的影响**：老内核 / 网络盘环境面板照常可用（丢一点缓存读写并发收益，无感）；
    卷本身坏掉（盘满 / 断连）时报的是真实原因，不再是误导性的 `no such table`。

- **「日志」页的「仅错误」过滤抓不到业务失败行**：面板约定失败行打 `✘` 前缀，但调用点走的
  是 `console.log`（级别是 `log`）——`logbus` 只按 `console` 方法分级，导致这些行进不了
  「仅错误」、也不标红。现在按行首符号归级（`✘`→error、`⚠️`→warn），几十处调用点不用改；
  标红样式（CSS 早已备好）随之生效。

- **HamHub 点播时反复失败（等几秒才起播）**：HamHub 把面板下发的**根相对**拉流地址
  （`/videos/{id}/stream.hls?…`）**按 origin 解析**（RFC 3986：根相对替换整个 path），把 `/emby` 丢掉，
  打的是 `http://<主机>:<实例端口>/videos/…` —— 撞上实例端口的 404 守卫，反复退避重试（抓包里
  `/videos/…` 404 四次、改用 `/emby/videos/…` 才 200）。
  - **改的是什么**：**实例端口**的路径归一化多认一条 —— 不以 `/api/` 开头的路径一律当作 Emby 根路径
    （真机 Emby 本就把端点挂在根路径，见 [ADR-0065](docs/adr/0065-instance-port-root-path-fallback.md)）。
  - **影响哪些端点**：**实例端口上的全部 Emby 端点**（重点：直连拉流 `videos/{ItemId}/stream`、
    `Items/{ItemId}/Stream`、下载、字幕内容）。面板端口（面板 UI 所在）**不变**。
  - **对客户端的影响**：**更宽容、客户端无需改动** —— 按 origin 解析（HamHub）与字符串拼接（AfuseKt）
    两种行为都能命中；下发的地址一字未改；面板自用端点（`accounts` / `instances` 等）仍照旧拒绝。
  - 真机对照见 [docs/emby-realdevice/12-direct-stream.md](docs/emby-realdevice/12-direct-stream.md) 的 12-6（**未复测**）。

- **Yamby 打不开带字幕轨条目的播放页**：字幕流（`MediaStreams[]` 里 `Type:'Subtitle'`）缺
  `IsDefault` / `IsForced` 字段，Yamby 把 `IsDefault` 当必填，整条 `PlaybackInfo` 反序列化直接抛
  `SerializationException`。已补 `IsDefault:false` / `IsForced:false`（外挂字幕本就不是默认/强制轨，
  与真机一致）。其余客户端不受影响（它们读不到该字段时按 `false` 处理）。真机对照见
  [docs/emby-realdevice/23-subtitles.md](docs/emby-realdevice/23-subtitles.md) 的 23-4（**未复测**）。

- **`DirectStreamUrl` 容器后缀：`hls` 映射为 `m3u8`（曾为对齐真机去掉后缀，实测回归后恢复）**（契约变更记录见
  [docs/emby-compat.md](docs/emby-compat.md)；决策见 [ADR-0071](docs/adr/0071-direct-stream-url-container-suffix.md)，
  取代 [ADR-0070](docs/adr/0070-direct-stream-url-bare-stream.md)）：
  - **改的是什么**：`MediaSources[].DirectStreamUrl` 保持带后缀形态
    `/videos/{ItemId}/stream.{容器}?…`，但**不照抄 `Container` 字段**：`hls` → **`stream.m3u8`**
    （`hls` 是 DTO 容器枚举值、不是播放器认得的扩展名；ExoPlayer 系按后缀推断类型只认 `.m3u8`，
    真机的 HLS 拉流地址本就是 `*.m3u8`），其余容器原样拼（`stream.mkv` / `stream.mp4`）。
  - **来龙去脉**：本发布周期内曾按真机形态（予初Emby 4.9.5.0 的 `DirectStreamUrl` 是裸 `stream`）
    去掉过后缀（ADR-0070），实测**打断了一批靠 URL 后缀判类型的客户端**（如 CapyPlayer/1.1.6：
    面板清单中继正常回 200，客户端却把 m3u8 文本当普通文件嗅探，报
    `UnrecognizedInputFormatException`）—— 恢复后缀，**能播优先于真机形态对齐**。详见
    [docs/emby-realdevice/11-items-playbackinfo.md](docs/emby-realdevice/11-items-playbackinfo.md) 的 11-5（**未复测**）。
  - **影响哪些端点**：仅 `POST /api/emby/Items/{ItemId}/PlaybackInfo` 的
    `MediaSources[].DirectStreamUrl`。`MediaSources[].Id`（版本 Id）、`Path`、`Container` 字段本身不变。
  - **对客户端的影响**：**客户端无需改动** —— 拉流路由 `stream(\.[a-z0-9]+)?` 对裸 `stream` 与
    `stream.{ext}` 一并认；HLS 源的 `DirectStreamUrl` 由裸 `stream` 变为 `stream.m3u8`，
    靠后缀判类型的客户端恢复播放。

## [1.9.0] - 2026-10-07

### 变更

- **Emby 版本行标题位改由聚合层供给**（契约变更记录见 [docs/emby-compat.md](docs/emby-compat.md)）：
  版本行的**标题位**（`MediaSources[].Name` 与视频流 `DisplayTitle`）不再由 emby 层自己拼，
  改为直接读聚合层写好的 `versionLabel`，出口插件（FW/Rex）读同一个字段 —— 规则只实现一次。
  - **改的是什么**：标题位**格式不变**（仍是 `[体积] 站点标签 · 线路flag [· 变体标注] [· 项标注]`），
    拼装从 emby 层下沉到聚合层；emby 层不留旧拼装兜底。聚合层同步给详情站条目补上 `sourceName`。
  - **影响哪些端点**：`POST /api/emby/Items/{ItemId}/PlaybackInfo`、
    `GET /api/emby/Users/{UserId}/Items/{ItemId}`（详情）的 `MediaSources`。
  - **对客户端的影响**：**多源命中时标题多出源名前缀**（形如 `源名 站点标签 · 线路`）——
    此前聚合层详情站条目不带 `sourceName`，这条「多源前置源名」**实际从未生效**；现生效，属新可见文本。
    单源场景标题不变。客户端无需改动（只当显示名读）。agg 详情缓存 key 版本号随之升级
    （`aggdetail4` → `aggdetail5`）。
  - 决策见 [ADR-0063](docs/adr/0063-version-label-at-aggregate-output.md)（与
    [ADR-0043](docs/adr/0043-line-filter-at-aggregate-output.md) 同一模式）。

- **Emby「接下来看」端点改为对外恒空**（契约变更记录见 [docs/emby-compat.md](docs/emby-compat.md)）：
  `GET /api/emby/Shows/NextUp` **保留端点、不删路由、不加开关**，但响应恒为
  `200 {Items:[], TotalRecordCount:0}`。
  - **改的是什么**：客户端首页的「继续观看」（`Items/Resume`）与「接下来看」（`Shows/NextUp`）
    在常规顺序观看下常指向同一集、两行重复；现让 `Shows/NextUp` 不再出数据，藏掉那一行。
    算「该看哪一集」的实现**留着但暂不调用**（恢复时改回即可）。鉴权口径不变（无 token → 401）。
  - **影响哪些端点**：仅 `GET /api/emby/Shows/NextUp`（含带 `SeriesId` 的请求）。
    `Items/Resume`、`Items?Filters=IsPlayed` 等**不受影响**。
  - **对客户端的影响**：只认 `Shows/NextUp` 渲染「接下来看」那一行的客户端将不再显示该行；
    「继续观看」仍由 `Resume` 提供。**客户端无需改动**（它本就该容忍空列表）。
  - 决策见 [ADR-0060](docs/adr/0060-nextup-hidden.md)（取代 [ADR-0023](docs/adr/0023-playback-progress.md) 的
    `Shows/NextUp` 那一格）。

- **Emby 播放地址由绝对 URL 改为相对路径**（AfuseKt 起播 404）
  （契约变更记录见 [docs/emby-compat.md](docs/emby-compat.md)）：
  - **改的是什么**：`DirectStreamUrl`（`PlaybackInfo`）与 `MediaSources[].Path`（详情 / `PlaybackInfo`）
    此前给**绝对 URL**（`{proto}://{host}/api/emby/…`），现改为**相对路径**
    （`/videos/…?…&Static=true`、`/Items/…`），对齐真机形态。连带去掉
    `getItem` / `getPlaybackInfo` / `buildMediaSource` 的 `host` / `proto` 参数与 `protoOf` 工具函数。
  - **影响哪些端点**：`POST /api/emby/Items/{ItemId}/PlaybackInfo`、
    `GET /api/emby/Users/{UserId}/Items/{ItemId}`（详情）。
  - **对客户端的影响**：**AfuseKt/3.2.0 起播恢复**。此前它把面板给的绝对地址**当相对路径**再拼在
    自己的 base（已含 `/emby`）之后，得到双重拼接的畸形地址 → 实例端口 404；改为相对后两种 base
    都能命中。走官方协议的客户端无需改动。
  - 决策见 [ADR-0062](docs/adr/0062-relative-playback-urls.md)；真机逐条见
    [docs/emby-realdevice/11-items-playbackinfo.md](docs/emby-realdevice/11-items-playbackinfo.md)（**未复测**）。

### 新增

- **Emby 收藏功能**（契约变更记录见 [docs/emby-compat.md](docs/emby-compat.md)）：新增写端点
  `POST|DELETE /api/emby/Users/{UserId}/FavoriteItems/{ItemId}`，并让读取类端点出**真收藏数据**。
  - **改的是什么**：面板新增收藏存储 —— `favorite` 表（一行 = 账号 + 条目 + 收藏时的列表元数据**快照**，
    随 `emby.db` 持久化，属**用户数据**、不随缓存清理，`SCHEMA_VERSION` 4→5）。**收藏动作时快照、读侧 0 上游请求**。
  - **影响哪些端点**：`POST|DELETE …/FavoriteItems/{ItemId}`（此前落 501 通配 → 现 **200 + `UserItemDataDto`**，
    `IsFavorite` 真值；无 token → 401，Id 认不出 / 反查失败 → **204 不写库**）；
    `GET …/Items?Filters=IsFavorite`（此前**恒空** → 现**读 `favorite` 表**、快照重建出真实条目）；
    `UserData.IsFavorite` **全链路**（列表 / 详情 / 季集）由恒 `false` → 按收藏库查出的**真值**。
  - **对客户端的影响**：客户端**无需改动**。收藏 / 取消收藏由「未实现」转为可用，首页「收藏」入口由空列表转为真实集合；
    可收藏条目类型对齐真机（电影 / 剧 / 季 / 集全认）。
  - 决策见 [ADR-0058](docs/adr/0058-favorite-items.md)；真机逐条见
    [docs/emby-realdevice/21-favorite-items.md](docs/emby-realdevice/21-favorite-items.md)（**未复测**，待端到端复核）。

- **片源认证：插件认准的候选，面板直接采信**：聚合层新增一条**候选行级**的认证标 ——
  片源插件在 `search` 返回的候选上写 `vod_exact: true`，表示「这一条已认准、就是目标作品」，
  面板见到就把它的分数**直接记 1、不再判名字**（其余流转一律不变：仍受分数线与条数上限约束，
  只因分最高排在最前、优先取详情）。这解决**番号片**的老问题：番号查询的名字相似度会被
  三四十字的长标题稀释、导致正确候选被名字闸门拒掉；而番号站自己按番号精确过滤过，
  「这条对不对」它比面板更清楚。**契约在插件仓库**
  [media-bridge-plugins](https://github.com/dlushu/media-bridge-plugins)（`docs/plugin-contract.md` 第五节），
  本仓库只是消费方。**missav 片源**先行适配（番号精确过滤后的候选带 `vod_exact`）。
  决策见 [ADR-0059](docs/adr/0059-source-certified-candidate.md)。

- **Emby 认领旧版播放上报族 `Users/{UserId}/PlayingItems/*`（HamHub Android 进度一条未落）**
  （契约变更记录见 [docs/emby-compat.md](docs/emby-compat.md)）：面板此前只实现新版族
  `POST /api/emby/Sessions/Playing[/Progress|/Stopped]`；抓包发现 **HamHub Android/1.0.0** 走的是
  Emby **旧版族** `POST|DELETE /api/emby/Users/{UserId}/PlayingItems/{ItemId}[/Progress]`
  （`ItemId` 在**路径**、参数在 **query**、**无 JSON body**），此前全落 501 通配 → 播放进度一条没记、
  `Resume` / `IsPlayed` 拿不到真数据。现认领这一族的 **3 条**（开始 / 心跳 / 结束），
  把 path / query 拼成现有 `recordPlayback` 认的形状，**落库口径与新版族完全一致**（含 204 空体）。
  - **影响哪些端点**：新增 `POST …/PlayingItems/{ItemId}`、`POST …/PlayingItems/{ItemId}/Progress`、
    `DELETE …/PlayingItems/{ItemId}`（此前落 501 通配）。
  - **对客户端的影响**：走旧版族的客户端进度由「一条不记」转为正常入库，**无需改动**。
  - **已知限制**：旧版族**不带 `RunTimeTicks`** ⇒ 面板拿不到时长，只能按位置记、「看完」可能判不出。
  - 真机逐条见 [docs/emby-realdevice/22-users-userid-playingitems.md](docs/emby-realdevice/22-users-userid-playingitems.md)（**未复测**）。

### 修复

- **Emby 条目不再回空串 `PremiereDate` / `Overview`（客户端 `FormatException: Invalid date format`）**：
  插件没给首播日期时，条目 DTO 上此前会出现 `"PremiereDate": ""`；客户端（如 Hills）对它做
  `DateTime.parse(value)`，`parse('')` 直接抛 `FormatException`、**整条响应解码失败**（列表整个打不开）。
  真机拿不到就**不含这个键**（不是回空串）——现对齐：`PremiereDate` / `Overview` 改为**拿不到就不挂键**
  （口径同 `DateCreated` / `DateModified`）。**数组类字段仍先铺 `[]`**，不变。
  - **影响哪些端点**：一切补 `baseItem` 的条目 DTO —— `Items` 列表、`Items/Latest`、`Items/Resume`、
    详情、季 / 集、相似等。
  - **对客户端的影响**：`PremiereDate` / `Overview` 由**恒在（可能为空串）**变为**可能缺失**；
    对空串做类型转换的客户端不再崩，其余客户端无感（**无需改动**）。`Etag` 哈希对 `undefined` / `''`
    同化，**值不变、无缓存抖动**。
  - 决策见 [ADR-0061](docs/adr/0061-omit-missing-scalar-fields.md)（细化 [ADR-0008](docs/adr/0008-no-fabricated-data.md)）；
    真机逐条见 [docs/emby-realdevice/06-users-userid-items-latest.md](docs/emby-realdevice/06-users-userid-items-latest.md)（**未复测**）。

- **Emby 登录不认小写 `pw`（HamHub Android 登不上）**：`POST /api/emby/Users/AuthenticateByName` 的
  请求体取值此前只认固定拼写（`Username`/`username`、`Pw`/`Password`/`password`），客户端发全小写
  `{"username":…,"pw":…}` 时密码被读成空串 → 401 `无效用户名或密码。请重试。`。真机（.NET 反序列化）
  字段名大小写不敏感 —— 实测 OkEmby / itsmygo 发 `Pw` 与 `pw` 均登录成功。现对齐真机：`Username` / `Pw`
  （含兼容 `Password`）**不再区分大小写**。响应结构与错误文案不变，**客户端无需改动**。
  （契约变更记录见 [docs/emby-compat.md](docs/emby-compat.md)；真机逐条见
  [docs/emby-realdevice/02-users-authenticatebyname.md](docs/emby-realdevice/02-users-authenticatebyname.md)）

- **Emby 登录不认 `Authorization` 头里的 appName**：`POST /api/emby/Users/AuthenticateByName`
  取 appName 时此前**只读** `X-Emby-Authorization`，客户端按官方文档把 `Client="…"` 放在 `Authorization` 里时
  被误判「缺 appName」→ 400 `Value cannot be null. (Parameter 'appName')`。真机两头都认 —— 实测
  OkEmby / nyamedia / 予初Emby：只发任一头 → 200 登录成功，两头都缺 → 400 登不上。现对齐真机：
  `X-Emby-Authorization` 缺失时回退读 `Authorization`。响应结构与错误文案不变，**客户端无需改动**。
  日志里的客户端标记（`[Client/版本]`）同步改为两个头都看（此前只认前者，缺了就退到 UA）。

- **Emby 登录不认授权头里不写引号的 `Client=`（部分客户端登不上）**：`POST /api/emby/Users/AuthenticateByName`
  解析 appName 时此前正则写死 `Key="值"`、只认带引号的写法，客户端发 `Emby Client=SomeApp, …`（省引号）
  就取不到 appName → 400。真机对引号**可选** —— 实测 nyamedia 4.8.0.62：`Emby Client="Filmly"` 与
  `Emby Client=Filmly` 均 200 登录成功。现对齐真机：`Client=` / `Device=` / `DeviceId=` / `Version=` 的
  值**引号可省**（日志的客户端标记同一口径；从授权头取 `Token=` 的路径一并放宽）。响应结构与错误文案不变，**客户端无需改动**。
  （契约变更记录见 [docs/emby-compat.md](docs/emby-compat.md)；真机逐条见
  [docs/emby-realdevice/02-users-authenticatebyname.md](docs/emby-realdevice/02-users-authenticatebyname.md)）

- **Emby 登录不认 query 里的 appName（Filmly / 网易爆米花登不上）**：`POST /api/emby/Users/AuthenticateByName`
  取 appName 时此前**只看授权头**。抓包发现 Filmly 把客户端名放在 query（`?X-Emby-Client=网易爆米花 Android`），
  授权头里只有 `Device` / `DeviceId` / `Version`、**没有 `Client=`**，于是被误判「缺 appName」→ 400
  `Value cannot be null. (Parameter 'appName')`。真机对同一形状的请求实测（nyamedia 4.8.0.62）：头无 `Client=`
  + query 带 `X-Emby-Client` → **200** 登录成功；头无 `Client=` + 无 query → 400。现对齐真机：头里取不到 `Client=`
  时**回退读 query `X-Emby-Client`**（参数名大小写不敏感）。响应结构与错误文案不变，**客户端无需改动**。
  （契约变更记录见 [docs/emby-compat.md](docs/emby-compat.md)；真机逐条见
  [docs/emby-realdevice/02-users-authenticatebyname.md](docs/emby-realdevice/02-users-authenticatebyname.md)）

- **Emby 路径大小写写错就落 501（AfuseKt 登不上）**：`core/router.js` 的路径匹配此前**字面段大小写敏感**，
  客户端把 `/api/emby/Users/AuthenticateByName` 写成全小写 `authenticatebyname` 就落 `ANY /api/emby/*rest`
  通配 → 501。真机（.NET 路由）**大小写不敏感**，故这类客户端在真机能登、在面板 501（实测 AfuseKt/3.2.0
  就把登录路径写成全小写）。现对齐真机：字面段**大小写不敏感**比对（`:param` / `*wildcard` 的取值照原样给）。
  **影响面为全局**（所有走该路由器的路径，含面板自身 `/api/*`）：此前大小写写错会 404 / 501 的路径现在都能命中；
  方法与段数约束不变（段数不齐仍 404、方法不符仍 405）。此前正确大小写的请求行为不变，**客户端无需改动**。
  同轮删除冗余的 `Videos` 重复注册（现一条认下大小写两种），端点集合不变。
  （契约变更记录见 [docs/emby-compat.md](docs/emby-compat.md)；真机逐条见
  [docs/emby-realdevice/02-users-authenticatebyname.md](docs/emby-realdevice/02-users-authenticatebyname.md)）

- **Emby 登录不认表单体（AfuseKt 登不上）**：`core/http.js` 的 `readBody()` 此前**只认 JSON**，
  客户端发 `Content-Type: application/x-www-form-urlencoded`、体为 `Username=…&Pw=…&appName=…`
  就解析失败 → 400（即便路径修好也登不上）。真机（.NET 模型绑定）JSON 与表单都读 —— 实测 AfuseKt/3.2.0
  的登录体就是表单。现对齐真机：`readBody` 按 `content-type` 分流，**另认 `application/x-www-form-urlencoded`**
  （未发 `content-type` 但形状像表单的也按表单解，否则照旧报 400）。响应结构、错误文案均不变，
  发 JSON 的客户端**无需改动**。（契约变更记录见 [docs/emby-compat.md](docs/emby-compat.md)；真机逐条见
  [docs/emby-realdevice/02-users-authenticatebyname.md](docs/emby-realdevice/02-users-authenticatebyname.md)）

- **Filmly / 网易爆米花首页空白（`Items` 裸列表查询）**：客户端登录后打的
  `GET /api/emby/Users/{UserId}/Items` 不带 `ParentId`、也不带 `SortBy`/`Filters`/`SearchTerm`，
  只带 `ExcludeItemTypes`/`StartIndex`/`Limit`/`Fields` 这类通用参数 —— 此前落「其余查询 → 空」，
  于是首页一片空白（`Items: []`、`TotalRecordCount: 0`）。**真机对照（予初Emby 4.9.5.0）**：这类查询
  真机回的是**顶层库列表**（26 个 `CollectionFolder`，与 `GET /Users/{id}/Views` 一字不差）——
  真机对「无 `ParentId` 且不递归」的 `Items` 默认回根节点的直接子级（要条目客户端须自带 `Recursive=true`）。
  现对齐真机：**无 `ParentId` 的裸列表查询改为回顶层库列表**（复用 `Views` 那支，条目形状、`TotalRecordCount`
  与 `Views` 一致）；轮播推荐位（`SortBy=IsFavoriteOrLiked,…`）仍路由到 `feed: 'random'` 行，不受影响。
  **不新增插件契约字段**，插件无需改动；**客户端无需改动**（决策见
  [ADR-0055](docs/adr/0055-bare-items-query-returns-views.md)，取代
  [ADR-0054](docs/adr/0054-bare-items-query-uses-random-feed.md)；契约变更记录见
  [docs/emby-compat.md](docs/emby-compat.md)；真机逐条见
  [docs/emby-realdevice/05-users-userid-items.md](docs/emby-realdevice/05-users-userid-items.md)）

- **Emby 端点带 `?api_key=` 但无 `X-Emby-Authorization` 头时 500**：取 token 时按名字读头，
  头缺失会拿到 `undefined`，`undefined.match(...)` 把**整个请求**打成 500
  （`{"error":"Cannot read properties of undefined (reading 'match')"}`）—— 只带 `api_key`、
  不带授权头的客户端（实测就踩这条）在 `Views` / `Items` 等取 token 的端点上全中。现将取不到的
  头如实当「没有」，端点正常回数据或 401，不再 500。

- **「装一个插件」卡的上传包选择框没有字段框样式**：那个文件选择框此前只给里面的原生按钮写了样式，
  外圈既没有底色也没有描边、高度还比同行的输入框矮一截 —— 摆在卡片上像一颗孤零零的按钮。
  现按统一的字段框补齐（底色 / 描边 / 圆角 / 34px 高度，窄屏随其它输入框一起长到 40px），
  聚焦有描边与光晕，里面那颗按钮收进框内不再顶边。

- **开机那一轮站点测速启动过早，撞上源还没起来**：面板启动后排的那一轮固定「2 分钟后」开跑，
  而插件报的 ready 只是「入口加载完」，它托管的源实例（下包 / 起进程 / 绑端口）在其后**串行**启动 ——
  源还在 `starting` 时站点清单里缺这些实例的站点，好站被记成失败，还会被后续几轮按
  「上次失败就跳过」漏掉。现改为**到点先看源起没起**：还在起就每 30s 再看一眼，最多等到开机后
  10 分钟；等满了照跑（如实测、如实记，不再等）。判据只看源实例状态，不影响手动点的那一轮。
  （实现见 [server/modules/agg/site-test.js](server/modules/agg/site-test.js)）

- **中继取块超时收尾漏成「未处理的 Promise 拒绝」**：`proxy` 线路读满一块超时（`readTimeout` 先到）时
  调 `res.body.cancel()` 收尾，但**没 await** —— 此刻 `res.arrayBuffer()` 还占着流的锁，`cancel()` 回的是
  **被拒的 Promise**（非同步抛错），同步 `try/catch` 兜不住，于是每发超时都往日志刷一条
  `TypeError [ERR_INVALID_STATE]: Invalid state: ReadableStream is locked`（服务本身不受影响，异常被全局拦截）。
  现改为 `await`，超时收尾不再漏告警。对外契约与中继取块行为不变，客户端无感。
  （实现见 [server/modules/agg/stream.js](server/modules/agg/stream.js)）

- **Emby 拉流鉴权不认 query 里的 `X-Emby-Token`（客户端拉流 401）**：直连拉流端点
  （`GET /api/emby/videos/{ItemId}/stream` 等）取 token 时此前只认请求头与 query `api_key`，
  而客户端会把同一个 token **照着头名**塞进 query（`?X-Emby-Token=…`，**大小写照发**），于是认不出
  → 401 `token 校验不过：没带 token`。现 `service.tokenFrom()` 的 query 兜底**同时认 `api_key` 与
  `X-Emby-Token`**。影响端点：一切靠 `tokenFrom()` 鉴权的读取 / 拉流端点；对客户端的影响：此前只带
  query token 的拉流由 401 转为正常，其余无感。
  （契约变更记录见 [docs/emby-compat.md](docs/emby-compat.md)；真机逐条见
  [docs/emby-realdevice/12-direct-stream.md](docs/emby-realdevice/12-direct-stream.md) 的 12-5，**未复测**）

### 变更

- **Emby 补一条端点 `GET /api/emby/System/Ping`（连通性探针）**（真机实测见
  [docs/emby-compat.md](docs/emby-compat.md)）：新客户端 **Lenna/1.0.16** 登录时会先打它探「服务器活着吗」，
  此前落到 501；现照真机回 **200 `text/plain`**、正文常量 `Emby Server`，并**豁免 token**
  （真机 OkEmby / nyamedia 免鉴权、itsmygo 要 token —— 对齐多数）。**客户端无需改动。**

- **Emby 补一条端点 `GET /api/emby/System/Info`（完整服务器信息，取诚实子集）**：新客户端
  **Filmly/2.12.11-439** 登录后打它取服务器信息，此前落到 501 通配；现认领该端点、回 **200 JSON**。
  响应只给面板真有的 **17** 个字段 —— `ServerName` / `Version` / `Id` / `OperatingSystem` / `LocalAddress` /
  `LocalAddresses`(空) / `RemoteAddresses`(空) / `CompletedInstallations`(空) 如实给值，能力位
  `HasPendingRestart` / `IsShuttingDown` / `SupportsLibraryMonitor` / `CanSelfRestart` / `CanSelfUpdate` /
  `CanLaunchWebBrowser` / `SupportsHttps` / `HasUpdateAvailable` / `SupportsAutoRunAtStartup` **一律 `false`**；
  面板无对应物的 8 个字段（`SystemUpdateLevel` / `WebSocketPortNumber` / `HttpsPortNumber` / `WanAddress` 等）**不回**
  —— **不编造面板没有的能力与数值**。鉴权**只验 token**（同类读取端点口径）。字段集**小于真机**
  （真机 4.8 / 4.9 同构 25 字段），属**有意诚实子集**，客户端本就该容忍字段缺失，**无需改动**。
  （决策见 [ADR-0057](docs/adr/0057-emby-system-info-honest-subset.md)；契约变更记录见
  [docs/emby-compat.md](docs/emby-compat.md)；真机逐条见
  [docs/emby-realdevice/20-system-info.md](docs/emby-realdevice/20-system-info.md)）

- **模板页两个页签调换**：进页面默认落在「选站点」（原来是「填参数」），页签顺序一并调过来 ——
  选站点在前、填参数在后。站点是这套模板的主体（上百行的那张表），进页面先看到它；
  参数是偶尔调一次的旋钮，要看再切过去。本次会话内点过的另一档仍会记住，刷新页面才回到默认。

- **中继取块策略优化（客户端无感）**：面板 `proxy` 线路的字节中继在排序并发取块的基础上，新增
  三项按 [media-bridge-relay](https://github.com/dlushu/media-bridge-relay) Worker 对齐的策略 ——
  **慢判死**（连接/响应头 15s + 读满一块 10s〔头部块〕/ 30s〔普通块〕，超时即判该块失败并走重试，
  不再拖死整条有序流）、**头部对冲**（前 4 块各发 2 路取先成功者，直接压 TTFB）、
  **重试口径**（每块 3 发、间隔 200/500ms，仅对 `429`/`5xx` 多试，其余 `4xx` 再确认一发即走）。
  对外契约与 `playVia` 落法不变，客户端无需改动。设计取舍见
  [docs/adr/0050](docs/adr/0050-relay-chunk-policy-aligned-with-worker.md)。

- **Emby 协议契约变更：读取类端点不再用 `UserId` 鉴权**（真机实测不校验；契约变更记录见
  [docs/emby-compat.md](docs/emby-compat.md)）：`Views` / `Users/{UserId}/Items` / `Items/Latest` /
  `Shows/{Id}/Seasons` / `Shows/{Id}/Episodes` / 条目详情 `Users/{UserId}/Items/{ItemId}` /
  播放信息 `Items/{ItemId}/PlaybackInfo` / 直连拉流 `videos/{ItemId}/{file}` 与 `Items/{ItemId}/Stream/{token}` /
  下载 `Items/{ItemId}/Download` / 继续观看 `Users/{UserId}/Items/Resume` / 接下来看 `Shows/NextUp` /
  相似推荐 `Items/{ItemId}/Similar` 十三条端点由
  「`UserId` 必须属于该 token 账号，否则 401」改为「**只验 token、不比对 `UserId`**」—— 有效 token +
  不匹配 / 不存在的 `UserId` 现在一律回 **200**（拉流 / 下载则**照常出字节**）。鉴权身份收敛到 token 一处；
  用户私有进度仍按 token 的账号取，
  **不引入跨账号泄露**（`PlaybackInfo` 虽为 POST，但只返回版本清单、不写用户私有数据；拉流 / 下载取的是内容字节，
  均与用户无关，故按读取类处理）。
  其余端点（`Users/{UserId}`、写端点的 `PlayedItems` / `HideFromResume` 等）暂维持旧口径，
  留待各自真机对照。**客户端无需改动。**
- **Emby 协议契约变更：`Studios` 收紧为「只验 token」**（真机实测要求；契约变更记录见
  [docs/emby-compat.md](docs/emby-compat.md)）：`GET /api/emby/Studios` 由**完全豁免 token** 改为
  **无 token / 无效 token 一律 401 纯文本** `Access token is invalid or expired.`（与 `Items` / `Items/Latest`
  同口径）。响应仍是**如实回空** `{"Items":[],"TotalRecordCount":0}`（面板没有片库可枚举，不复刻真机的全量清单）。
  正常客户端都带 token，**客户端无需改动**。
- **Emby 协议契约变更：`Items/Counts` 收紧为「只验 token」**（真机实测要求；契约变更记录见
  [docs/emby-compat.md](docs/emby-compat.md)）：`GET /api/emby/Items/Counts` 由**完全不校验账号**（连 token 都不看）
  改为**无 token / 无效 token 一律 401 纯文本** `Access token is invalid or expired.`（与 `Items` / `Studios` 同口径），
  有效 token + 任意 `UserId` 照旧 **200**（不比对 UserId）。响应**填 `MovieCount` / `SeriesCount` / `EpisodeCount`**
  （前两者取首页插件申报的库总数、后者取剧库行申报的集数，见下一条），其余 11 类仍为 0（面板没有片库索引，不复刻真机的全类别计数）。
  正常客户端都带 token，**客户端无需改动**。
- **`Shows/{Id}/Seasons` / `Shows/{Id}/Episodes` 按真机对齐**（响应形状变更）：
  - **`Seasons` 返回特别篇**：不再过滤 `IndexNumber: 0` 的那一季（真机会返回）。
  - **季 `UserData` 补 `UnplayedItemCount`**：由 4 键补到真机的 5 键（本季未看集数）。
  - **`Episodes` 集条目补 `SeriesName`（剧名）**：真机每条集都带；取剧名照 `progressItem` 的做法再 `lookup`
    一次，命中元数据插件缓存、**不额外打上游**；查不到只少这一个可选字段，不影响分集照常返回。
- **Emby 实例新增「下载」开关（默认开）**：实例编辑弹窗可开关客户端下载能力，开关驱动
  **同一口径的三处** —— 握手 `Policy.EnableContentDownloading`、条目 `CanDownload`、
  `Items/{ItemId}/Download` 端点（关闭时回 **403 纯文本**）。默认开 = 行为与以往一致；关闭后
  客户端不再显示下载入口、直接请求下载端点也被拒。
- **条目详情补条目级 `Width` / `Height`（视频分辨率）**：数据来自**片源插件申报的 `width`/`height`**
  （该契约早已存在，见插件仓库 `media-bridge-plugins/docs/plugin-contract.md`）。**插件没给就没有这俩字段**
  （面板不从集名反推）。对齐真机条目级分辨率。

- **媒体库角标 / 条目计数显示真实库总数（首页插件新增可选申报 `total`）**（契约变更记录见
  [docs/emby-compat.md](docs/emby-compat.md)，设计取舍见 [docs/adr/0051](docs/adr/0051-home-row-declared-total.md) /
  [docs/adr/0052](docs/adr/0052-items-counts-library-total.md)）：
  - **`Views` 库条目 `ChildCount`**：首页插件的行申报（`rows`）新增**可选**字段 `total` —— 申报这个库
    **总共有多少条**（口径同 `run` 的 `total`）。面板据此三级取数：**行申报 `total` → 插件点开过一次后
    记下的数 → 占位 `1`**。客户端**还没点开库**就能看到真数（此前未点开的库一律显示占位 1）。插件
    **取不到就不申报**（回退占位 1，不编数）。
  - **`Items/Counts` 的 `MovieCount` / `SeriesCount` / `EpisodeCount`**：前两者取**同一份**「首页插件申报的库总数」
    （按库类型归并，**同类型多行取最大值**、`mixed` 行不参与），`EpisodeCount` 取**剧库行申报的集数**
    （`episodes`，只对 `tvshows` 行有意义），其余 11 个字段仍回 0。此前这三个字段恒回 0
    （设计取舍见 [docs/adr/0053](docs/adr/0053-home-row-declared-episodes.md)）。
  - 契约正文在插件仓库 `media-bridge-plugins/docs/emby-home-plugin.md`。**TMDB 首页插件**已按此申报：
    抓官网 About 页的全库规模，按库类型映射（`movies` → 电影数、`tvshows` → 剧集数、`mixed` → 两者之和），
    并解析同页的 `TV Episodes` 作为剧库集数（`episodes`），带缓存、不阻塞面板的行轮询。**客户端无需改动。**

- **Emby `Items` 补「按类型计数」分支（客户端首页总统计不再显示 0）**（真机对照见
  [docs/emby-realdevice/05-users-userid-items.md](docs/emby-realdevice/05-users-userid-items.md)，
  契约变更记录见 [docs/emby-compat.md](docs/emby-compat.md)）：Rex 等客户端首页**在拿库列表之前**
  先打两条无 `ParentId` 的 `Items?Recursive=true&IncludeItemTypes=Movie|Series&Limit=1&SortBy=SortName&SortOrder=Ascending`
  （除类型外参数相同），**只读 `TotalRecordCount`** 当「总统计」；此前落到兜底、回 0（首页总统计恒显示 0）。
  现按类型取**首页插件申报的库规模**（`home.libraryTotals()`，与 `Items/Counts` 同一份数据，见
  [docs/adr/0052](docs/adr/0052-items-counts-library-total.md)）填 `TotalRecordCount`；**`Items` 仍回空**
  （不给样本条目）。只认**单类型**，`Movie,Series` 这类多值仍回空（无样本可循）。**客户端无需改动。**

- **Emby 版本行副标题改为「标准文件名」**（契约变更记录见 [docs/emby-compat.md](docs/emby-compat.md)）：
  客户端版本行的**副标题**（取 `MediaSources[].Path` 解码后「最后一个 `/` 之后」的文字）此前是
  「站点来源标签 · 集名」（如 `小雅 Alist · 4K · <原始文件名>`），现改为聚合层拼好的**标准文件名**
  （scene naming，`标题.年份.季集.分辨率.来源.音频(含声道).Atmos.动态范围.视频编码.容器`），例如
  `蜘蛛侠：崭新之日.2026.2160p.WEB-DL.DDP5.1.Atmos.DV.H.265.mkv`。**不再带站点前缀**
  （来源 / 线路已在标题位 `MediaSources[].Name` 显示）；`WEB-DL` 等来源由聚合层识别补出，
  `H.265` / `DDP5.1` / `DV` 等规格用圈内通行写法。**只动副标题** —— 标题位、`MediaStreams`
  各字段、播放路径（走 `/videos/{Id}/stream.{ext}`，不读这个 `Path`）均不变，**客户端无需改动**。

## [1.8.4] - 2026-10-06

### 变更

- **Emby 客户端协议继续按真机对齐**（逐条对照与取样见 [docs/emby-realdevice/](docs/emby-realdevice/)）：
  - **`Users/{UserId}` 不再核对 UserId 与 token 是否同一人**：实测真机不校验，只要有有效 token，
    UserId 换成任意合法值照样回数据。`Views` 也同步放宽（`authorize(req)` 不再比对 userId）。
  - **`Items` / `Items/Latest` 收紧守卫**：无 token 一律 **401**（原来部分空查询分支会「照常回空」）；
    userId 与 `Views` 同口径放宽。两条端点的推荐/收藏/已看/搜索等分支形状逐一对过真机样本。
  - **`Views` 补齐字段**：`ParentId` 给占位值 `"2"`；`ChildCount` 优先用该行**已知的真实条数**
    （首页插件记过就有），没记过时回退 `1`。
- **用户头像改用部署者提供的品牌图标**：`GET /api/emby/Users/{UserId}/Images/{type}` 不再回按 `UserId`
  派生的纯色 PNG，改为统一回 `server/modules/emby/assets/default-avatar.png`（606×606 透明底，所有用户
  共用一张）。`User.PrimaryImageTag` / `SessionInfo.UserPrimaryImageTag` = **该文件内容的 md5**
  （32 位 hex，与真机同形状）—— 换图标文件即自动失效客户端图片缓存，无需手动改版本号。

## [1.8.3] - 2026-10-05

### 修复

- **HTTPS 反代下绝对地址退成 `http://`**：`MediaSources[].Path` 与 `DirectStreamUrl` 只用请求的 `Host`
  拼绝对 URL，而 `Host` 头里**没有协议** —— 面板挂在 HTTPS 反代后面时仍一律吐 `http://`，
  客户端可能降级到 80 端口、或被浏览器的混合内容策略拦掉。现先读反代写入的 `X-Forwarded-Proto`、
  缺省才回退 `http`（口径与聚合层的 `originOf` 一致）。实测：带 `X-Forwarded-Proto: https` 时两条地址均为
  `https://`，不带头时仍为 `http://`。

### 变更

- **登录与握手响应按真机样本对齐**（逐条对照见 [docs/emby-realdevice/](docs/emby-realdevice/)）：
  - `System/Info/Public` 只回真机那 5 个字段：补 `LocalAddresses` / `RemoteAddresses`（空数组），
    删 `LocalAddress` / `ProductName` / `OperatingSystem` / `StartupWizardCompleted`。
  - `User`（UserDto）补 `Prefix` / `DateCreated` / `PrimaryImageTag` / `PrimaryImageAspectRatio`，
    删真机没有的 `HasConfiguredEasyPassword` / `EnableAutoLogin`；`Configuration` 取真机 15 键
    （`SubtitleMode: Smart`），`Policy` 取真机 44 键（非管理员、`IsHidden`、下载与转码全 false 等）。
  - `SessionInfo` 从 8 键补到真机 20 键（`PlayState` / `RemoteEndPoint` / `Protocol` / `InternalDeviceId` /
    `SupportedCommands` / `UserPrimaryImageTag` 等）。
- **登录与取用户的错误体改为纯文本**（真机如此）：缺 `X-Emby-Authorization` → 400
  `Value cannot be null. (Parameter 'appName')`；用户名或密码不对 → 401 `无效用户名或密码。请重试。`
  （不区分哪一个不匹配，避免暴露用户名是否存在）；`Users/{id}` 认不出 → 404 纯文本。
- **新增用户头像端点** `GET /api/emby/Users/{UserId}/Images/{type}`（**豁免 AccessToken**，与条目图片同理）：
  只认 `Primary`，回一张按 `UserId` 派生的**稳定纯色 PNG**（160×160，Node 内置 zlib 生成，不引三方库）。
  `User.PrimaryImageTag` 现在有值，客户端登录后会来拉这张图，不给就是破图。

## [1.8.2] - 2026-10-05

### 修复

- **302 跳转地址被二次编码**：面板给 `Location` 头编码时用了 `encodeURI`，它会连 `%` 一起转义
  （`%3D` → `%253D`），把源直链里已有的签名编坏 —— 上游校验不过直接 400，表现为「播放/取图莫名失败」。
  改用 `new URL(url).href` 做归一化：只补编 URL 不允许的字符（中文、空格等），已编码的 `%XX` 原样保留。
  涉及播放取流（`serveStream` / 中继 302）与图片跳转两条路。
- **`E<数字>` 集名定位不到**（插件 `catpaw-resolve` → **1.0.12**）：花卷等源把每集写成
  `[1.4GB]E161.mp4【XIANNI2026】`（字母 `E` + 集号），集名解析器此前不认这种前缀式写法，
  该线路「源里明明有、却定位不到这一集」，版本列表里看不到它。现支持 `E<数字>` 前缀集号
  （只认**前面不是字母**的 `E`，`HEVC` / `MPEG4` 这类词里的 E 不受影响）。

### 变更

- **中继首块自适应**：探测式请求（`bytes=0-`，或无 Range 从头全量）的前 4 块用 256KB，
  小块更早吐字节、起播更快，也少浪费在飞数据（播放器常读几百 KB 就 seek）；整片重试次数 1 → 2。
- **新建模板「续接补位」默认 `0` → `8`**（[ADR-0027](docs/adr/0027-extra-fetch-only-when-zero.md) 的兜底档）：
  新建模板不再默认「不补打」—— 前 8 条命中一条能用的都没拿到时，按分数继续往下试最多 8 条。
  已保存的模板不受影响（盘上存着的值优先；填 `0` 仍是不补打）。

## [1.8.1] - 2026-10-04

### 新增

- **外部字节代理**（面板设置 → 播放中继设置）：打开「外转到外部字节代理」并填上代理地址后，
  需要鉴权头的线路不再由面板搬字节 —— 面板 302 把上游地址、请求头、并发参数一并交给外部代理
  （Cloudflare Worker，配套仓库 [media-bridge-relay](https://github.com/dlushu/media-bridge-relay)，支持一键部署），
  字节全部走代理出口。面板只发路条不碰字节；「中继并发路数 / 分块 KB」设置随链接带过去、对代理同样生效。
  可选「外部代理签名密钥」：与 Worker 侧 SECRET 填同一个值，302 链接带 HMAC 签名防白嫖。
  关掉开关即回面板内置中继，填过的 URL 保留不丢。

### 修复

- **CapyPlayer 客户端兼容性**：它在部分端点上发小写 `userId` / `seasonId`（Emby 约定是驼峰 `UserId`/`SeasonId`），
  以前取不到就 404 或静默空列表 —— 剧页季列表、分集列表、相似推荐整条铺不出来。现在两种写法都认。
- **「接下来看」对零进度的剧回第一集**：客户端指名 `SeriesId` 而库里没有任何这部剧的进度时，
  `Shows/NextUp` 回第一集（CapyPlayer 拿到空列表就不往下走）；全看完的剧仍如实回空。

## [1.8.0] - 2026-10-04

### 变更

- **插件包可以同时是多种类型**（[ADR-0046](docs/adr/0046-plugin-multiple-types.md)）：包的身份从「类型 + id」改成**只看 id** ——
  一个 id 一个目录、一个进程、一个开关、一份数据。`plugin.json` 用 `"types": ["home","metadata","source"]`
  声明它同时是哪几类；只写单个 `"type"` 的旧包照旧兼容。插件目录随之拍平（`plugins/<类型>/<id>/` → `plugins/<id>/`），
  多类型包每个类型各有自己的侧栏入口与 webui 页，插件管理 / 插件库里一包一行、带多个类型徽章。
- **数据格式升级改为自动完成**（[ADR-0047](docs/adr/0047-data-migration-gate.md)）：面板开始记录「数据版本」，代码比数据新时
  **先迁移再启业务** —— 迁移期间其它接口返回 503，跑完直接进面板，不用重启。
  没有需要人工决定的事就**启动时自动静默跑完**（无人值守升级、全新安装都不必等有人打开面板）；
  只有「同一个插件 id 装在多个类型下」这种冲突才会停下来问每组保留哪一份。
  过程可断点续跑（失败后从断点接着来），向导里可先下载一份完整备份，迁移前还会自动留一份 `registry.json` 备份。
- **MissAV 与 TMDB 插件合并发布**：MissAV 的首页 / 元数据 / 源三个包合并为 **1.1.0**，
  TMDB 的元数据与首页示例合并为 **1.1.0**。升级后到插件库装这两个新包即可；
  装着旧包的迁移向导会先处置同 id 冲突（默认删掉旧副本），首页示例那个旧包（id `example`）装完新包后可在插件管理里卸载。
- **撤销「外部访问令牌」总开关**（1.7.6 加的那个）：外部入口与外部拉流**一律**要令牌 ——
  开关一旦关掉，任何能访问面板端口的人都能读聚合数据、起播拉流，风险大于便利；面板设置里的对应项一并去掉。

## [1.7.6] - 2026-10-03

### 变更

- **FW/Rex 输出改为直接选聚合模板取片**：设置页从「勾选聚合域」改成「选一套模板」，
  搜索、详情、播放全走这一套。不再依赖元数据域 —— 首页条目已自带片名 / 年份 / 季集，
  直接拿模板调 detail / play 即可；`/api/agg/detail`、`/api/agg/play` 与流入口
  `/api/agg/stream` 都支持 `tpl` 参数（与原 `domain` 二选一，作用域等价）。
  fwrex 插件需更新到 **1.0.20**。
- **外部访问令牌增加总开关**：「面板设置」里可关掉外部访问令牌。关掉后插件入口与外部拉流
  免令牌，任何能访问面板端口的人都能用 —— 只在可信网络关，默认开启。

## [1.7.5] - 2026-10-03

### 变更

- **插件设置页统一到面板样式**：新增两个稳定入口 —— `/sdk/plugin-ui.css`（样式）与
  `/sdk/plugin-ui.js`（主题跟随）。插件只认这两个 URL，内部实现（daisyUI 或其它）可随时替换、
  插件零改动；自带 9 个插件页全部改用统一入口，各自的内联样式（约 489 行重复 CSS）删除。
- **插件页移动端修复**：
  - 实例 / 网盘 / 统计表在手机上**摊成卡片**，每格带列名 —— 以前 4~5 列被压成横向滚动条。
  - 实例状态每 2 秒的轮询在内容（id + 状态）无变化时跳过重绘：修了「列表滑着滑着被弹回」——
    拆表重建会把容器滚动位置清零，触屏滑动途中重建还会打断手势。
  - 修了移动端 `.chk` 规则误伤嵌在其中的数字框：「自动更新」的小时数被压成 17px 高、光秃秃没边框。

## [1.7.0] - 2026-10-03

### 变更

- **新增暗 / 亮双主题（默认亮色）**：侧栏品牌行与窄屏顶栏各一颗图标切换钮，只留「亮色 / 暗色」两档。
  两套颜色走 CSS 变量（`:root` 与 `html[data-theme='light']`），原生控件（文件选择框、滚动条、下拉展开列表）
  也跟着主题走 —— 以前暗色界面上这些控件由浏览器按亮色画，白得刺眼。引入 daisyUI 作为组件层，
  其组件变量桥接到本项目的令牌，配色与扁平外观不变。弹窗与状态点的类名改成 `.mbox*` / `.status-line`，
  避开 daisyUI 同名组件导致的「弹窗看不见点不动」。
- **全站表单与列表的界面一致性整改**：
  - 表单统一为「标签在上、控件在下」的字段格（`.fld`）与自适应字段组（`.fset`）；**单位写进标签**
    （如「测速间隔（小时）」），不再在输入框后面挂一个窄屏会脱离的单位字；除季 / 集 / 年份外输入框不再定宽。
  - **保存、改密等按钮一律独立成行**，不再和输入框横排（窄屏不再挤成一团）。
  - 面板设置文案精简：去掉大段原理说明，每张卡只留一句必要提示。
  - 卡片间距统一为 16px：修了「面板设置三张卡片间距不一样」—— 卡片外面多套的容器会让相邻卡片的间距规则失效。
  - **插件管理 / 插件库列表放宽行距**；每张插件卡的操作按钮统一挪到整块右下角独占一行（窄屏不再有的挂行尾、
    有的掉行），版本与作者单独一行放在标题下面；「支持自更新」字样去掉（能不能更新看按钮即可）。
  - Emby 实例 / 账号列表的行尾按钮同口径成组、右下角独占一行（修手机上「删除」孤零零掉到下一行），
    实例地址旁的「复制」按钮去掉（地址就在行上，可直接选中复制）。
  - 「缓存设置」里「长期有效」勾选与「线路结果保留（天）」输入框放在同一格：勾上即锁定天数框，
    与「续接补位」处的勾选样式一致。
- **Emby 实例 / 账号**：
  - 实例的**启用开关搬到列表行**（点一下即 PATCH，不用再开编辑窗）；「首页」插件选择收进编辑弹窗，
    列表行因此不再被整宽下拉挤成三行。新建实例默认启用。
  - 去掉实例与账号行上的绿色状态点 —— 那颗勾选（开关）本身就代表状态，绿点是重复信息。
  - **账号改密改成模态框**（以前行内展开密码框会把整行撑得错位）；账号行新增**删除账号**：
    删除即作废该账号已签发的登录凭证（客户端需重新登录），忘了密码也可以直接删掉重建。
  - 空选项文案统一：域→模板的空选项是「不选择」，实例首页插件的空选项是「空库」。
- **聚合**：
  - 模板站点表的「能力」列改为**「层次」**，按插件契约的新字段 **`directLines`** 判定：
    搜索结果直接带线路 = 一层式，搜索只出候选、要再取详情 = 两层式。PikPak（磁力索引→种子清单）
    与 MissAV（搜索→影片页取 m3u8）现在都如实标为**两层式**；以前读的是猫爪适配器内部字段
    `filterable` / `indexs`，自写插件没这两个字段会被误标成一层。**猫爪插件需更新到 1.0.5
    （自解析版 1.0.7）才会重新申报该字段**；更新前猫爪站点会暂时都显示两层式。
  - **同键搜索在途合并**：网页聚合搜索与客户端播放链同时搜同一片时，面板只向源插件放一发搜索，
    后来的请求等同一个结果 —— MissAV 这类首搜要 20 秒以上的慢站，以前并发两发会实打实打上游两遍。
    详情合并仍在插件侧；站点测速故意不合并（测速测的就是真实往返延迟）。
  - 模板编辑器拆成「填参数」「选站点」两个页签（切走再回来草稿不丢）；站点表新增「全部站点」页签
    （带「来源」列）、名称筛选 / 显示 / 排序的筛选栏、延迟排序改成「原序 / 快→慢 / 慢→快」分段控件，
    站点表超高时内部滚动并吸顶表头（上百个站点的源不再把卡片拉成几屏长）。
  - 聚合搜索分「电影 / 剧集」两档（剧集必填季与集）；搜索结果没拿到封面时保留同尺寸占位块，
    不再让图片控件直接消失导致列表左右错位。
- **插件管理**：打开「管理」页即自动查一遍插件自更新（之后每 5 分钟复查一次），那颗主按钮按检查结果
  变脸 —— 查到更新时是「全部更新（N）」（一键串行装完），没查到时是「检查更新」（点它再查一遍），
  不再出现「点了全部更新只弹一句已是最新」；安装 / 更新成功后更新提示立即消失（缓存当场作废）。
  修了插件库页尾残留一张「正在加载…」卡片的问题。

## [1.6.0] - 2026-10-02

### 变更

- **要鉴权头的线路在 Emby 客户端也能播了**：有些线路（实测夸克网盘类）的地址**必须带一串请求头**
  （`Cookie` / `User-Agent` / `Referer`）才播得动，而播放器手里没有这些头 —— 以前面板只能 302 过去，
  客户端被 CDN 挡回 **412**，表现就是"点了播放没反应"（清单那一跳能取回来，分片全被挡）。
  现在这类线路由**面板代持请求头搬字节**：非清单地址整段经面板；HLS 清单则把里面每个分片地址改写成
  **面板签名的子地址**，由面板逐发带头取回（见 [ADR-0042](docs/adr/0042-auth-line-byte-relay.md)、
  [ADR-0044](docs/adr/0044-emby-stream-playvia-relay.md)）。**哪条线路走这条路只看源插件的 `playVia` 声明**，
  面板不按"头非空"反推（漏标 / 标错由插件自负）。Emby 层把 `playVia` 编进版本 Id，实例端口上新增
  `/api/emby/stream` 作为子地址落点（实例端口只收 `/api/emby/` 前缀，指到 `/api/agg/stream` 会 404）；
  `/api/agg/stream`（出口插件那条路）同样接了这一档，两处共用一份流内核。**字节只搬要鉴权的那些线路**，
  其余照旧 302，图片端点也照旧（见 [ADR-0036](docs/adr/0036-image-endpoint-redirect.md)）。
  子地址只认签名（`signStreamPart`，不校验 token），但"代持哪份头"存在面板内存里，重启后子地址会回 410，客户端重取一次清单即可。
- **中继搬运改成分块并发**：网盘 CDN **按 Range 的形态限速** —— 开放式 `bytes=0-` 实测约 0.1MB/s，
  有界 Range 约 3.5MB/s。所以不再单连接透传，改成"先探总长 → 按块切有界 Range → 多路在飞 → 按序吐回"，
  默认 **16 路 / 512KB**（与猫爪引擎的网盘档对齐）；上游不认 Range 或探不出总长时退回单连接透传。
  只想覆盖这一次播放，可以在拉流地址上带 `?threads=8&chunkKB=256`；面板设置里新加「播放中继设置」一栏，
  也能关掉并发退回单连接做对比排查（见 [ADR-0045](docs/adr/0045-relay-chunked-concurrent.md)）。
- **线路过滤下沉到聚合层产出处**：以前"哪些线路能被客户端看到"由各消费方自己过滤，模板里配的
  `lineFilter` 对出口插件形同虚设。现在**聚合层产出线路时就用掉规则**，Emby 与出口插件拿到的 `lines`
  已经是滤过的那份（见 [ADR-0043](docs/adr/0043-line-filter-at-aggregate-output.md)）。
  线路结果缓存的键跟着换了版本号（`aggdetail2`），旧口径的快照不再命中，会重新取一次。
- **「缓存设置」增加「清除全部缓存（含插件）」**：以前那个按钮只清面板自己的两份缓存
  （图片索引 + 线路结果），插件自己的缓存在插件那边、得逐个进各插件的设置页清。现在多一个按钮
  **一次清到底**：面板那两份 **+ 各插件的落盘缓存**（元数据与源插件的取数缓存、首页插件的行结果）。
  插件的设置与登录态（网盘 Cookie、源实例清单、`auth.json`）不在缓存里，所以清完**不用重新登录**。
  旧按钮跟着改名为「清空面板缓存」，两个口径分开（插件进程里留着的那份内存缓存清不掉，要等它自己的
  有效期过去或重启面板 —— 界面与日志都如实写明）。

## [1.5.2] - 2026-09-30

### 变更

- **备份包的大小不再是"内容未压缩字节和"**：以前界面显示的数把 63MB 的原始内容当成包大小，
  实际打包后只有 19MB（差异来自压缩），于是"显示的大小"和下载到的文件永远对不上。
  现在显示与响应头 `X-Backup-Size` 都给**包的实际字节数**，与磁盘上那个文件一致。
  顺带：`cache.db` 的 `-wal`/`-shm` 旁文件跟着它一起排除（白占 4MB，运行中拷走也不保证一致）；
  zip 的 CRC32 改用 Node 内置实现（同样 64MB 数据 120ms → 2ms，包内容不变）。
- **备份文件名与项目名一致**：下载下来的是 `media-bridge-panel-backup-20260930-1830.zip`，
  前缀取自品牌短标识（`branding.slug`，前后端各一份 branding 的那个字段），不再是写死的旧标识
  `catpaw-panel-backup-`。已有备份包的还原不受影响（文件名只是下载时用的名字）。
- **客户端按外部 id 找条目时，一串编号不再被当成"没这条查询"**：`AnyProviderIdEquals` 是**逗号分隔的多值**
  （Emby 的 OR 语义，任一条对上就算），实测 Rex/0.5.0 打的是 `tmdb.282326,imdb.tt32500958`，
  而面板的判据只认单值 —— 多值一律回空，客户端拿不到条目 Id、后面进详情和播放整条链路断在这里。
  现在按序**逐个试、先命中先返回**；认不出的候选（前缀不是已注册域、形状不对）只跳过、不作废整条查询，
  并在日志里点名；候选都取不到照实回失败码；一个都没认出来仍回空但逐条点名
  （见 [ADR-0041](docs/adr/0041-any-provider-id-multi-value.md)）。前缀仍按插件注册的域认，**不做 `imdb.` → `tmdb` 这类猜测**。
- **HLS 线路播不了修掉了**：清单（`.m3u8`）里的地址是**相对的**，客户端按"自己最初请求的那条 URL"补全，
  而那条 URL 是面板 —— 302 一跳过去，客户端就把 `360p/video.m3u8` 拼到面板身上
  （实测 VidHub 的 ffmpeg 打 `videos/{Id}/360p/video.m3u8` → 501，播放位置恒为 0.0s；
  直链 mkv/mp4 没这个问题，它们一跳到底）。现在**地址以 `.m3u8` 结尾时不再 302**：
  由面板取回清单、把地址补成绝对、以 `application/vnd.apple.mpegurl` 200 回；档位清单与分片仍全直连 CDN
  （面板搬的是一份几百字节的文本，不是媒体流量，见 [ADR-0040](docs/adr/0040-hls-playlist-relay.md)）。
  取回失败（超时 / 过大 / 不是清单）就如实记一行并**退回 302**，行为与改前一致。
- **修掉"同一个视频，一个客户端能播、另一个播不了"**：版本 Id（`MediaSourceId`）原先只做 base64url，
  最长实测 5098 字符，而 SenPlayer 把请求 URL **硬截在 4095 字符**（留给 Id 的只有 4048）——
  客户端发出去的是半截串，面板认不出就回 400 并让它反复重试；Rex 没有这个上限，所以同一个条目正常播。
  现在 Id 的载荷**编码前先 deflate**：同一批 19 个版本最长 5098 → 3395 字符，全部落到 4048 以内
  （见 [ADR-0039](docs/adr/0039-compressed-source-id.md)）。**代价：改动前发出去的 Id 一律作废**，
  客户端手里缓存的那批会先吃一个 400，进一次播放页就会重取（口径同 ADR-0034）。
- **非托管运行方式的「面板重启」也能用了**：原先只有"由容器引导脚本托管"时才允许，
  直接跑源码时如实回一句"请重起容器或手动重起进程"；现在那种情况下面板**退出前自己拉起一个新进程**
  （同一份代码、同一个版本、同一个端口，只换进程），于是面板上就能重启，
  不用再回终端按 Ctrl+C（见 [ADR-0038](docs/adr/0038-self-relaunch-when-unmanaged.md)）。
  例外是带文件看护的启动方式（`npm run dev` / `node --watch`、nodemon）：它们自己就会重起子进程，
  两下叠加会抢端口，所以如实拒绝并说明。**自更新仍然只受容器托管时可用**。
  代价：重启后的进程与启动它的那个终端脱钩（终端关掉面板照常跑），但日志仍写在那个终端里。
- **插件源码与打包工具移到插件仓库** [media-bridge-plugins](https://github.com/dlushu/media-bridge-plugins)：
  本仓库不再有 `plugins/` 与 `tools/plugin-pack.js`（`plugins/` 本来就已在 `.gitignore` 里，
  只是本机留一份源码供打包）；插件文档（契约、首页插件规范、架构讨论存档、施工批次计划）也搬过去，
  本仓库那四份只剩一条指路 —— 面板代码里 `见 docs/plugin-contract.md` 之类的引用仍指旧路径，不会断。
  **打包工具改成一次只打指定的插件**：`node tools/plugin-pack.js <类型>/<id>`（`--all` 才全量重建），
  清单 `index.json` 每次按 `packages/` 里现有的包重算，不再"打一个插件要重打全部"。
- **插件进程崩了不再自动重启**：原先"启用中"的插件自己退出后，宿主会按退避策略最多重启它 5 次 / 5 分钟；
  现在只**如实记账**（管理页显示「已启用（没在跑）」、退出码进日志），要它继续跑就回管理页点「启动」——
  一直崩的插件不会再把日志刷屏、也不会反复抢端口（见 [ADR-0037](docs/adr/0037-no-plugin-auto-restart.md)）。
  管理页那条说明文案、状态里的「重启过 N 次」与「重启」按钮的提示一并去掉。
- 「关于 → 版本与更新」只剩两颗按钮：「检查更新」只刷新摘要、「更新到 x」弹更新弹窗
  （说明 + 真正执行更新的按钮，倒计时 3 秒防误点）。原先还有一颗「查看更新内容」，
  且「检查更新」查到新版本时也会自动弹一个只有「知道了」的说明框 —— 三处入口重叠，
  看说明这件事现在统一放到"决定要更新"的那一下。
- **Emby 图片端点改为一律 302**：面板不再代为取图，只回一个 `Location`（tag 或本地索引里的图片 URL），
  字节由客户端直连图床 —— 与拉流 / 下载同一条取向（见 [ADR-0036](docs/adr/0036-image-endpoint-redirect.md)）。
  随之删掉"单张 8MB 上限"与"取图失败 → 502"两条只为转发而存在的分支。
  **代价**：客户端要能自己连到图床；图床不可达时图片整体失败，面板不再兜底。
- missav 三个插件（首页 / 元数据 / 片源）的封面统一改用大图 `cover-n.jpg`（原来列表侧拼的是缩略图
  `cover-t.jpg`，详情侧用的是页面的 `og:image`）—— 修掉"首页 / 列表糊、点进详情才清晰"。

## [1.5.1] - 2026-09-29

### 变更

- 「面板设置」的侧栏子项重排，按"性质"分开，不再一张长页：
  「概览」多了运行环境之外的两个整机动作 —— **面板重启**（`POST /api/panel/restart`，写 `.restart`
  让引导脚本拉起同一版本，容器与版本都不变；插件进程跟着重起一轮）与**退出登录**（原先在设置页底部）；
  重启完成的判定看 `/api/panel/info` 新增的进程启动时间 `startedAt`（模块加载时算一次、同进程恒定），
  不看版本号（重启不换版本）也不看日志序号（实测交接约 0.4 秒、启动日志又多，序号涨得比轮询快）；
  「设置」只剩缓存设置与站点测速；**备份与还原**、**安全**（改面板密码）各单开一页。
  默认密码警告改到「概览」页，并指向「安全」页；备份/还原那几处"需重启才生效"的文案一并指向新按钮。
- 插件库页删掉「装完默认是停用状态……」那句说明 —— 与「装完就启用」默认勾选的实际行为不符。
- README 去掉点名具体插件的写法：「第一次使用」原先写死「填 TMDB Token」「片源插件（如猫爪源）」，
  改成通用口径（装插件 → 到插件自己的设置页里配它要的东西 → 加一个源实例 → 配一套模板）；
  开头「当前支持猫爪 / CatPawOpen 源」「内置 `catpaw`」一并去掉，`package.json` 的 description 同步。

### 修复

- 「聚合设置 → 域 → 模板」页看不到刚装的元数据域：域表原先只在**面板启动**与**面板端口上的
  `/api/emby/*` 请求**时重建，而这一页取数的 `/api/agg/templates`（与 `/api/agg/sites`）读它却不触发
  重建 —— 面板跑着的时候装完元数据插件，要等重启面板或访问一次 Emby 页才看得见。这两条端点现在
  读之前也顺手同步一次（指纹短接，插件清单没变则不做任何事）。

## [1.5.0] - 2026-09-28

### 变更

- **端口方案调整：面板改用 8088，实例端口从 8090 起依次 +1**：
  - **面板默认端口 `8099` → `8088`**（`server.js`、`server/modules/panel/index.js`；部署示例、Dockerfile、
    compose、README 与 SECURITY 一并改）。面板端口上仍只提供面板自用端点 + `System/Info/Public` 垫片。
  - **Emby 实例与源实例的端口都从 `8090` 起**（`instance.js` 的 `PORT_START`、
    `plugins/source/catpaw/lib/runner.js`）：新建时**端口留空**就依次往后找一个空闲的（被占了继续 +1，不设上限）。
    原先的 8096 起步与 9988-9998 源段、以及"不能占 9988-9998"的校验一并去掉；只剩"不能占面板本体端口"。
  - **全新安装不再自动建默认实例**：`instance.migrate()` 只在盘上确实留着老单实例痕迹
    （`settings/emby.json` 的老字段或 `data/emby/emby.db`）时才生成 `default` 那条；
    否则清单为空，用的人在「Emby → 实例」页自己加。已有实例的端口**原地不动**。
  - 部署建议（README / compose）：`-p 8088:8088 -p 8090-8100:8090-8100`，不够就把 8090-8100 往后加。
- **运行时镜像 tag 改成 `1.0`（并更新 `:latest`）**：镜像里只有 Node 运行时 + `entrypoint.js`，
  应用代码在数据卷 `app/<版本>/`、版本走 GitHub Release —— 所以这个 tag 标识的是**运行时契约**
  （引导脚本 + 默认 `WEB_PORT` + 健康检查），与 `package.json` 的应用版本无关。
  原先那版（`runtime-1`，2026-09-22 构建）里 `WEB_PORT` 默认还是 `8099`、健康检查也打 8099，
  端口换成 8088 之后健康检查必然失败（容器一直显示 unhealthy），故重推一版并把这些默认值一并改到 8088。
- **侧栏改成常驻的真侧边栏**（`public/index.html` + `core/shell.js` + `core/registry.js` + `style.css`）：
  宽屏不再有横跨整页的顶栏，品牌移到侧栏顶部（下面一条分隔线）；每个栏目一行 ——
  **图标 + 常规字号名称 + 右侧折叠箭头**（原先父节点是小灰标题 + 左侧箭头，看着像"页签底下的次级列表"）。
  侧栏宽屏**常驻不收起**（220px，去掉了宽度动画与"整栏收起"状态）；窄屏仍是盖在内容上的抽屉，
  由顶栏那颗 ☰ 拉起。栏目**默认全部折叠**，当前页所在那一栏进入时自动展开。
- **猫爪源的实例去掉三个开关，一律按默认行为走**（`plugins/source/catpaw/`）：
  原先添加实例时有「开机自动启动 / 参与聚合 / 加完就启动」三个复选框，现在**没有这些概念、界面上也不显示** ——
  添加后就下载并拉起；面板每次启动都把本地实例一并拉起；实例一律参与聚合。
  「启动 / 停止 / 重启 / 更新 / 删除」这些**动作按钮照旧**留着（临时停一个实例仍要能停）。
  实例清单里已废弃的 `enabled` / `autostart` 键在下次写入时被丢掉。
- **更新前弹窗展示更新内容并倒计时 3 秒**（`public/modules/panel/settings.js`）：
  点「更新到 x」不再走原生 `confirm`，而是先把该版本的 Release 说明摆进弹窗，
  确认按钮**倒计时 3 秒**后才可点 —— 更新不可逆，不给"没看就点确定"的机会。
- **数据备份改成 zip 包，范围扩到全部数据**（`server/modules/panel/backup.js`，新增 `server/core/zip.js`）：
  备份打成一个 `.zip`，包含设置、模板、插件（包本体 + 插件数据）、Emby 账号与播放进度，
  **不含缓存**（`cache/`、`emby/cache.db`、各插件 `data/cache/`）与**应用代码 `app/`**；
  还原改为选 `.zip` 覆盖回数据卷（覆盖前二次确认，还原后需重启面板生效）。
  zip 的读写用 Node 内置 `zlib` 自实现（零依赖，不依赖镜像里的 `zip` 命令）。
- **插件化改造：源、元数据、首页都变成插件**（决策见 [ADR-0028](docs/adr/0028-plugin-system.md)~[0034](docs/adr/0034-fresh-install-no-migration.md)，
  契约见 [docs/plugin-contract.md](docs/plugin-contract.md)）。
  - **源不再托管在面板里**：源实例清单、下载与起停、自动更新、配置中心入口全归**源插件**
    （`plugins/source/catpaw/`）。面板不再认识任何"源地址"，`/api/sources*`、`/api/run*`、`/api/base*`、
    `/website*` 与 `/api/settings` 旧兼容端点一并删除。
  - **元数据变成插件**：TMDB 的 token / 基地址 / 语言 / 缓存都搬到**元数据插件**
    （`plugins/metadata/tmdb/`）自己的数据目录，UI 是它自带的设置页；条目 Id 的前缀改由
    **元数据域注册表**认，见 [ADR-0031](docs/adr/0031-metadata-by-domain.md)。
  - **首页插件搬进统一插件宿主**（`plugins/home/example/`）：行清单、取数、设置都归插件，
    面板侧只剩一层薄适配层（媒体库 Id 形状 + 条目归一化）。
  - **新增「插件」宿主与管理页**：装 / 卸 / 启停 / 重启 / 动作调用 / 日志 / 崩溃自动重启 /
    webui 托管与转发。三个类型的插件各挂一栏在侧栏（元数据 / 片源 / 首页），
    点进去内嵌打开它自己的设置页。
  - **站点勾选与打分参数变成「模板」**（[ADR-0033](docs/adr/0033-template-and-domain.md)）：
    一份模板 = 站点集合 + 打分过滤参数 + 超时与并发，按**域**选用；原「站点与参数」「聚合参数」两页
    合成「模板」页。测速的开关与间隔挪到「面板设置」。
  - **缓存分两级**（[ADR-0032](docs/adr/0032-cache-two-levels.md)）：面板侧只挡"点一次播放连问三遍"
    （线路结果缓存，按天），更长的热度由插件自己的缓存承担。
  - **插件不随面板发行，改从独立的插件仓库装**（[ADR-0035](docs/adr/0035-plugin-library.md)）：
    面板 Release 包里**没有插件**，装完是**零插件**；新增「插件 → 插件库」页，从
    `dlushu/media-bridge-plugins`（`PLUGIN_REPO` 可换）取清单与包安装，也可以在「插件 → 管理」
    上传 `.tar.gz` 手装。同时**删掉后端的开机同步内置插件** ——
    原先"卸载一个内置插件、重启又被装回来"的毛病随之消失。
    仓库里的包与 `index.json` 由 `node tools/plugin-pack.js --out <插件仓库工作目录>` 产出
    （打包时给包里的 `plugin.json` 注入 `files` 逐文件 md5，第二道校验这才真正生效）。
- **侧栏改成树，模板页重做**：侧栏不再在内容区顶上另开一条子标签栏 —— 一栏一个父节点，
  栏里的页（含三类插件栏下各插件自己的设置页）挂在它下面；父节点点一下**收起 / 展开**这一栏。
  - **模板页只管模板的增 / 删 / 改**：左边挑一套（新建 / 删除），右边编辑这一套。
  - 站点按**来源**（插件实例）分成**横向页签**，一次只开一个来源，页签上带着"这一组勾了几个"；
    组头带「整组全选 / 整组反选」。不再把上百条站点堆成一张扁平表，也不再让几个来源的表上下叠着。
  - 参数**不再折叠**；名称、参数、站点按**一个**「保存」一次写回（原先"改名"与"存参数"是两个按钮）。
  - 勾选只记在页面草稿里，**不落全局状态、不落服务端**，换模板前会拦一下未保存的改动。
  - 「哪个元数据域用哪套模板」从模板页挪到新页「聚合设置 → 域 → 模板」。
- **「聚合搜索」页按模板选，不再填打分参数**：作用域从"按域"改成"**按模板**"—— 页面上直接挑一套，
  站点与参数都从那套来（"域 → 模板"那份对照仍留给客户端那条路）。页面上**不再填**分数线 / 最多几条
  （它们是这套模板的属性，在「聚合设置 · 模板」里改一处），也不再填"上游第几页"（客户端那条路
  固定取第 1 页）。
- **「聚合设置 → 其他设置」改名「域 → 模板」**（`public/core/registry.js`）：这一栏里只有一张
  「哪个元数据域用哪套模板」的对照表，名字直接说明它是什么。同时删掉自检用的示例插件
  「自检 · 回声」（`plugins/source/echo/`）。**插件源码不再纳入本版本库**（`.gitignore` 增加 `plugins/`）：
  插件由独立插件仓库分发（[ADR-0035](docs/adr/0035-plugin-library.md)），源码留本地供
  `node tools/plugin-pack.js` 打包。
- 插件声明新增可选的 `author` 字段：插件库与管理页各显示一行「作者」，插件仓库清单也带上它。
  不写这个字段照装，只是不显示（见 [插件契约](docs/plugin-contract.md)第一节）。

### 升级须知

**本版当作全新安装，不做数据迁移**（见 [ADR-0034](docs/adr/0034-fresh-install-no-migration.md)）。
会因此重来的东西：

| 类别 | 内容 |
|---|---|
| 配置类 | `panel.json` 里的缓存设置；`agg.json` 的站点勾选与打分参数（模板制下本来就要重配） |
| 缓存类 | `cache/` 下的详情快照与元数据缓存（本来就是可丢弃数据，见 [ADR-0011](docs/adr/0011-cache-split-by-consumer.md)） |
| **用户数据** | `emby/emby.db` 里的**客户端账号与观看进度** —— 客户端要重新登录，"继续观看 / 已看"清空 |
| 已安装的插件 | 本版起**插件不随面板发行**，已装的插件要重新从「插件库」装一遍（[ADR-0035](docs/adr/0035-plugin-library.md)）；已安装的源包与其部署的实例（`sources/`）要重新装 |

## [1.3.4] - 2026-09-24

### 变更

- **接续补打的触发条件收成"一条能用的都没有"**（见 [ADR-0027](docs/adr/0027-extra-fetch-only-when-zero.md)，
  取代 ADR-0005 的触发与停止口径）：原先"没凑够 N 条就继续往下打"，前面已经拿到 5 条能用的还会再打
  8 条去凑第 6~8 条 —— 每条都是一次 10 秒级的站源 `/detail`，换来的只是"版本列表多几行"。
  现在：**前面只要拿到 1 条能用的就一条都不补打**；只有一条都没拿到（客户端版本列表会是 0）时才补打。
  补打仍是**整批并发**（批宽 = 最多留几条命中），**第一批拿到就不再发第二批**，批内结果全部落账。
  上限也改回字面口径："最多再试 K 条" = 阶段一实际条数 + K（原先按 `N + K` 算，
  会出现"上限 8 却打了 10 条"那种自相矛盾）。「匹配到底」跟着变成"一直打到拿到一条或名单打完"。

- **打分匹配的两个默认值调整**：「最多留几条命中」`matchMaxItems` 默认 `3` → **`8`**；
  「一条都没拿到时再往下打几条」（原「没凑够时再往下打几条」）`matchExtraK` 默认 `8` → **`0`**（默认不补打）。
  后者是因为实测"补打"很容易变成最贵的那一段 —— 每批按 `maxItems` 条并发去打 `/detail`
  （单站 10 秒档），而它换来的可用条目常常是 0（实测一轮往下打了 10 条、一条都没能用）。
  想要旧行为把 K 填回去即可，或勾「匹配到底」（那个不看 K）。
  ⚠️ 已经保存过设置的实例不会跟着变 —— 盘上的 `agg.json` 里写着旧值，
  要生效得在「聚合设置 → 聚合参数 → 打分设置」里改，或删掉那两个键。

## [1.3.3] - 2026-09-24

### 新增

- **站点测速改成服务端后台任务，默认每 6 小时自动测一轮**（`server/modules/agg/site-test.js`）：
  并发 3、**全部站点**，跑完才排下一轮；面板开机 2 分钟后先跑一次，之后按间隔。
  也可以在「站点与参数」页手动开一轮（只测当前筛选出来的那批）或点「停止测速」。
  测速跑在服务端 —— **关掉页面也继续**（原先是浏览器逐站循环，一关页面就断）。
  开关与间隔在「聚合设置 → 聚合参数」；保存设置时**只有测速这两项变了才重排** ——
  勾选站点、改线路过滤这类保存不会把下一轮自动测速往后推。
- **某个源起来 / 重启后自动测一轮它的站点**：只测那个源；撞上正在跑的一轮则排队、这轮结束后补测。
  顺带把该源的 `/init` 重新预热一遍（源换端口后缓存键变化，业务侧本来要重新 init）。
- **「站点与参数」页新增「按延迟排序」按钮**（三态：默认 → 快→慢 → 慢→快）。
  只影响这张表的显示顺序，**不改聚合取站优先级**；失败与没测过的排在最后。
- **站点表每行新增「测速」小按钮（单点测速）**：只测那一个站（服务端一发 `/search`，片名随机取、
  非 200 换一个再测），同步返回并把结果直接写进「延迟」列 —— 顺带把"因测速失败被跳过"的状态改掉
  （复测成功即恢复参与聚合）。它**不碰后台任务**（不改进度、不重排自动测速）。
- **「聚合参数」页新增一张「运行时流程与耗时」卡**：把聚合参数 / 打分设置 / 线路过滤翻译成
  "跑一次会发生什么、大概等多久"（①搜索 → ②打分 → ③取详情 → ④凑够 N 条 → ⑤线路过滤，
  并给出最坏与正常两个量级）。**数字跟着输入框实时变**，不用先保存 —— 给的都是上限并注明
  "实测通常远小于它"，只报上限会吓人、只报"一般 2 秒"又与实测（确实有 15 秒级的站）不符。

### 变更

- **测速改打 `POST /search`，片名从常见影视名里随机取，非 200 就换一个再测一发**（两发都失败才算真失败）。
  原先用固定关键词：站里没有那个词时会回 404 或空列表，等于给每个站预设了不同条件；
  而且实测**源侧对搜索结果有 3 分钟内存缓存**（`SEARCH_CACHE_MINUTES`，命中会打
  `[cache] Using search cache for "…"`），固定词量到的可能是缓存。
  超时改为**固定 15 秒**（不再读「单站超时」—— 默认 5 秒会把慢站一律记成超时，量到的是设置而不是站）。
- **站点表原先两列「搜索速度 / 详情速度」合并为一列「延迟」**（= 测速结果），
  并且**每站只留最近一次**（删除样本数组与"（N 次）"计数）。悬停能看到这次用的哪个片名、第几发，
  以及**真实业务**的最近一次搜索 / 取详情耗时 —— 那份只在站点被真的用过时才有值，如实留空。
- **删除「全选可搜索」按钮**：源的 `searchable` 常漏报，照它批量勾选会漏掉能用的站（「清空聚合」保留）。
- **删除「首次搜索先 POST /init」开关**：init 恒开 —— 有的源不 init 就搜不出来，这是源的性质、
  不是可选项。测速每轮都走同一处，所以**一轮测速跑完等于全站都已 init**。
- **详情不再由测速测量**：详情耗时只在**真实取详情**时记账。
- **新增「取详情超时」参数（默认 10 秒），与「单站超时」分开**
  （见 [ADR-0026](docs/adr/0026-seconds-and-detail-timeout.md)）：「单站超时」管
  搜索 / 播放 / 首次 `/init`，「取详情超时」只管 `POST /detail`。剧集的详情动辄几十上百集
  （响应体大、上游拼装慢），跟搜索共用一个超时会大量"定位不到"；详情超时也
  **进详情快照的 key**（改了就等于换了规则，第一次会重算）。
- **聚合参数的时间单位统一成秒**：`timeoutMs`（毫秒）→ `timeoutSec`（搜索，默认 5 秒）+
  `detailTimeoutSec`（详情，默认 10 秒），页面上不再需要数零。盘上残留的 `timeoutMs` 会
  **按秒四舍五入搬过去**（`12000` → `12`），不会静默退回默认值。
- **「聚合参数」页去掉那段测速说明**：测速口径（服务端跑、3 并发、单站 15 秒、片名随机取）
  在「站点与参数」页的脚注里已经说了一遍，参数页只留两个超时自己的说明，不再重复一遍。

### 修复

- **线路过滤现在参与"这条详情对客户端有没有用"的判据，并且进了详情快照的 key**
  （见 [ADR-0025](docs/adr/0025-line-filter-in-usable-judgement.md)）。原先过滤只在客户端那侧生效：
  实测某站命中、详情也取到了（4 条线路、定位到这一集），但规则 `/夸克原画/` 把这 4 条全滤掉 →
  客户端 0 个版本，而这份"对客户端没用"的结果照样被存成快照，在有效期内反复点开都是 0 版本、
  且不再尝试源站。现在：
  - **判据与客户端一致**：过滤后一条都列不出来的条目不算"能用"（`stats.usable`），
    **接续补打会继续往下找**（实测同一请求由"前 3 条里 2 条可用"补到 3 条可用）；
  - **这种结果不存快照**（判据由"有站拿到详情"改成"过滤后至少有一条能列出来"）；
  - **规则进 key**：改过滤规则后第一次请求会重算（原先"改规则立刻生效、不必重取数"，
    代价与备选见 ADR-0025）；
  - 聚合层多一行日志：`· agg 线路过滤 /…/：过滤前能用 X 条 → 过滤后能用 Y 条`；
  - ⚠️ 规则写得太窄（谁都不匹配）时，同一部片每次点开都会重算（10~20 秒）—— 这行日志就是信号。

- **"跳过失败站"改成直接看最近一次测速结果，并去掉那个十分钟窗口**：原先的判据是"真实业务里
  最近一次搜索请求失败、且发生在十分钟内"（测速结论不参与）——于是会出现"表里已经标红、搜索却还在打它"，
  以及"站其实已经恢复、却因为窗口没到还在被跳"。现在只看 `speed.search`：表里标红的站与聚合里
  被跳过的站是**同一个集合**，恢复与否完全由测速周期决定（默认 6 小时一轮，也可以点行内「测速」立刻复测）。
  业务那一份（`call.*`）只用于单元格 `title` 的诊断显示。

## [1.3.2] - 2026-09-23

### 新增

- **面板设置新增「关于」卡**：面板名称、版本、代码仓库地址（点开就是 GitHub 仓库）。
  仓库地址取自后端（`APP_REPO` 可覆盖），前端不写死 —— 自建或换仓库时不用改前端。
- **「更新内容」改用弹窗显示**。以前它摊在「版本与更新」卡里，而 Release 说明动辄几十行，
  会把卡片撑得老长，连「更新到 x」那个按钮都要往下滚才看得见。现在：
  手动点「检查更新」查到新版本时**直接把内容弹出来**，卡片上再留一个「查看更新内容」随时回看，
  弹窗底下给 **GitHub 上那个 Release** 的链接（说明的来源一目了然）。
  打开页面那一次不弹 —— 一进页面就糊一个弹窗很烦。
- **支持客户端「下载」**：`GET /api/emby/Items/{ItemId}/Download` —— SenPlayer/6.2.1 实测会打这条
  （12 小时里试了 8 次，之前每次落进"未实现"，它就一直重试）。做法与播放**同一条链路**：按
  `MediaSourceId` 现取播放地址后 **302 到源站**，面板不扛流量，也没有新增任何取数逻辑。
  同时把条目上的 **`CanDownload` 从 `false` 改成 `true`** —— 握手的 `EnableContentDownloading` 一直是
  `true`，两处不一致会让客户端"照 policy 去试、又按条目不提供下载入口"。现在两边一致了。
  （库条目 `CollectionFolder` 那条仍是 `false`：文件夹下不了；`CanDelete` 也仍是 `false`。）
  ⚠️ 302 之后 **文件名（`Content-Disposition`）/断点续传由源站决定**，面板拿不到、改不了 ——
  想要"片名.S01E01.mkv"那种名字只能让面板代为转发全量字节，那会推翻"播放一律 302、面板不扛流量"
  （ADR-0006）的既定取舍，所以没做。

### 变更

- **「站点与参数」的站点表去掉 `key` 与 `api` 两列**。那两列是源内部的标识与路由，
  挑站点、勾聚合时用不上，窄屏还多出两列横向滚动。站点身份照旧（按行内数据走），只是不摆在表里。
- **聚合详情快照放宽：有站失败也存**（判据收敛成"只要有站拿到了详情"）。
  原先"有站失败 / 有详情失败就整份不存"，而这一趟是 **10 秒级**的活（实测中位 10.8 秒）——
  5 个启用站里只要有一个慢或抖一下，客户端点一次播放连着问的三遍（详情 → 播放信息① → 播放信息②）
  **全部重算**，一次播放要等 20~30 秒。
  放宽后照存，代价是**可能缺某个源那几条线路**（那个有效期内点开都会缺它）——
  所以写快照那行日志会**点名**缺了谁（`⚠️ 但不完整：…`），不再让"快照缺线路"和"源里本来就没有"长得一样。
  负结果（完全没命中）仍不缓存。
  ⚠️ 顺带提醒：**别把这个快照设成「长期有效」** —— 一条不完整的快照会一直缺下去。
- **聚合参数的默认值调整为**：单站超时 `12000` → **`5000`** ms；「没凑够时再往下打几条」`3` → **`8`**
  （「最多留几条命中」仍是 `3`）。同时**删掉**「聚合参数」页那两行提示
  （"单站超时按最慢的站源设…并发数建议 3~8…"）—— 它是按"有的源单次要 15s+"写的，与新默认 5 秒相矛盾。
  ⚠️ 只影响**新装或重置后**取到的默认值；已经存过 `data/settings/agg.json` 的实例不受影响（文件里的值优先）。
  ⚠️ 实测补充：`/search`、`/detail`、`/play` **共用这一个超时**，而单站取详情实测要 2~10 秒
  （同一部片也会 2~3 倍波动）—— **把它往小调会掐掉本来能成功的详情、版本列表里的线路变少**，
  要提速应该少勾慢站，而不是压这个值。

## [1.3.1] - 2026-09-23

### 变更

- **客户端地址两种填法都能用了：填主机 或 填完整路径**。真机 Emby 把 API 挂在 `/emby/` 下，
  客户端给的主机没带 `/emby` 时会自己补一层 —— 本面板原先只认 `/api/emby`，所以"只填主机"那条路是 404。
  现在面板把 `/emby/**` 归一成 `/api/emby/**`（填了 `…/api/emby` 的客户端若又补一层，也一并归一），
  于是 `http://<面板地址>:8099` 与 `http://<面板地址>:8099/api/emby` 都通。
  「Emby → 连接设置」的「客户端怎么连」卡也改成**只显示主机**，并留一句"连不上就换成 `/api/emby`"。
  另附：README 的「第一次使用」补上**必做的一步：填 TMDB Token —— 不填就没有元数据**。

### 修复

- **聚合搜索页填了「季」就一条都不命中**。页面把输入框的值当**字符串**发出去（`season: "1"`），
  而判季号用的是**严格相等**（`"1" === 1` 为 false）—— 于是所有条目都被判成"季不同"、季集分归 0，
  总分掉到 0.739、低于 0.85 分数线（连名字完全对上的「第一季」也是 0.74）。
  现在页面按数字发，判据入口也统一把季/集归一成数字（任何调用方给字符串都不会再中招）。
  客户端那条路一直不受影响（`parseItemId` 给的是数字）。
- **主标题是英文的片子，改用 TMDB 的中文别名去源里搜**。TMDB 上有些剧的 `zh-CN` 主标题就是英文
  （实测 `tv/95396` 人生切割术的 `name` 是 "Severance"，中文只登记在别名 `人生切割术(CN)`），
  而面板是拿这个名字去源里搜的 —— 英文名搜出来的中文名条目在名字硬闸那关就被拒（中英文没有公共主干），
  于是命中源里的空壳条目、客户端**一个版本都拿不到**（实测：该剧 S1E1 版本数 0 → 1）。
  现在：语言设置为中文系、且主标题里一个汉字都没有时，问一次别名表并取带汉字的那条
  （简体地区 CN/SG 优先，再港澳台）；**别名也全是英文就用主标题**。
  只影响"拿什么名字去源里搜"，**显示给客户端的名字不变**；别名表与元数据同一个缓存（不会每次详情都打 TMDB）。

## [1.3.0] - 2026-09-23

### 新增

- **播放进度：客户端上报落库，「继续观看 / 接下来看 / 已看」出真数据**。
  `POST /Sessions/Playing`、`/Sessions/Playing/Progress`（实测每 10 秒一次心跳）、`/Sessions/Playing/Stopped`
  三条从 501 通配改为真正收下（一律 **204** 空体，与真机一致），落进 `data/emby/emby.db` 的新表 `playback`
  （一行 = 一个账号 + 一条片，覆盖写；关联键是账号，不是会变的 `user_id`）。
  随之变成真数据的读端点：`Items/Resume`（有位置、未看完，最近在前）、`Shows/NextUp`（看完这一集给下一集，
  下一集必须在 TMDB 季数据里真实存在）、`Items?Filters=IsPlayed`，以及列表 / 详情 / 季 / 集 / 最新 / 相似
  这些端点里每个条目的 `UserData`。**这三条读端点现在都要 token**（回的是某个账号的观看记录）。
  "看完"按位置 ≥ 时长 90% 判定（客户端不报 `Played`），判为看完时位置归零、进「已看」。
  决策见 [ADR-0023](docs/adr/0023-playback-progress.md)，真机实测与取舍见
  [docs/playback-progress.md](docs/playback-progress.md)。

- **客户端能改观看状态了：`HideFromResume` 与 `PlayedItems`**（此前都落 501）。
  「从继续观看里移除 / 恢复」来自 Rex，`POST|DELETE PlayedItems`（标记已看 / 标记未看）来自 SenPlayer：
  三条都收下（`playback` 新增 `hidden` 列，`SCHEMA_VERSION` 3 → 4），一律校验账号、回 `UserItemDataDto`
  —— 响应与语义都按真机实测对齐（Emby 4.9.5.0 上量过：隐藏不动 `UserData`、「标记已看」不动 `PlayCount`）。
  观看状态因此第一次变成**可写**的 —— 移除**不会抹掉进度**（位置还在，`Hide=false` 就回来），
  重新开始播放会自动取消隐藏；标记已看会让它从「继续观看」进「已看」，标记未看则两处都消失。
  「接着看」里那条**还没看过**的下一集也能被移除（库里有没有它的行都记得住），移除后「接下来看」让位给下一集；
  「继续观看 / 接下来看」的日志顺带带上列出的条目 Id（以前只报条数，分不清列的是哪一条）。
  见 [ADR-0023](docs/adr/0023-playback-progress.md) 的补充一段。

### 变更

- **「聚合详情」缓存的字节上限改成可调**（「面板设置 → 缓存设置」→「聚合详情上限 MB」，默认 32MB，填 `0` = 不限）。
  原先这个上限写死在代码里。它会这么大是因为一条快照含**全站的线路与选集**，而每个"选集 ID"就是
  **600~720 字符**的 token（同一条详情里还存了两份：站源原始响应 + 解析结果）—— 实测 22 条占 5.9MB。
  与元数据 / 图片索引同一套口径：上限调小后**保存设置时立刻按新上限淘汰**，不用等下次写入。
- **检查到更新时直接显示更新内容**：「面板设置 → 版本与更新」在"有新版本"时会把该版本的更新说明一并列出来
  （内容取自 Release 说明，也就是 CHANGELOG 里那一节），并给出 Release 页面链接；该版本没写说明时如实说一句。
- **未实现端点的日志带上请求体摘要**（掩码 + 压平 + 限长 300 字符）：通配路由此前把 POST 的 body
  读完即丢，导致「客户端到底报了什么」完全看不见（播放进度的 `POST /Sessions/Playing*` 三条就是这样，
  日志里只剩一个路径名）。现在键名像 `api_key` / `token` / `password` 的值一律记 `***`，
  嵌套结构与数组只报形状，避免把凭据或几 KB 的播放队列写进日志。

### 修复

- **大写 `Videos` 的拉流路径也认了**：路由是区分大小写的，而 Emby 官方路径是**大写** `Videos` ——
  实测 Lumenic/1.0.0 打的就是大写，先白吃一个 501（播放多一次无谓重试）才退回小写拿到 302。
  现在两种大小写走**同一条实现**。
- **条目上看不到进度条**：观看进度原先只给了 `UserData.PlaybackPositionTicks`，而客户端画进度条要的是
  `UserData.PlayedPercentage` 与**条目级 `RunTimeTicks`** —— 对比真机发现真机两条都给、本层一条都没有
  （电影条目本来就不带时长）。现在有位置的条目会带上 `PlayedPercentage`（小数百分比，位置为 0 时不给，
  与真机一致）、客户端上报的时长，以及 `LastPlayedDate`。

## [1.2.0] - 2026-09-23

### 变更

- **更新即完整替换：只保留当前版本**。原先每装一版就在数据卷里留一份 `app/<版本>/`（可在本机回退），
  现在**每次启动成功后**清掉当前版本之外的版本目录与暂存残留，磁盘上恒只有一份。
  清理由**新版本自己**执行（启动成功后延迟十几秒动手），所以旧版本不需要任何配合，
  第一次更新就能把历史版本收干净；受保护、绝不删的是：正在运行的这一版、`current.json` 记的那一版、
  `APP_VERSION` 指定的那一版。代价是**本机不再留可回退的旧版本** —— 回退改用
  `APP_VERSION=<旧版本>` + 重启容器，由引导脚本按 Release 重新下载。
  决策见 [ADR-0021](docs/adr/0021-update-replaces-app-dir.md)。

### 修复

- **电影点开没有版本列表（20 部里 19 部）**。站源里电影是「一条线路 + 若干播放项」，
  而拼版本列表要求"定位到这一集"才列；电影的**文件名里没有集号**（只有体积 / 年份 / 分辨率 / 编码），
  定位规则却只按集名里的集号匹配 —— 实测 20 部 TMDB 首页电影里 **19 部**源里明明有 4~20 条线路，
  却一条都定位不到 ⇒ 客户端版本列表恒为 **0 条**（「生化危机：爆发夜」就是这样）。
  现在**电影改用独立取法**：每条线路下的**每个播放项**各成一个版本（同一部片的多个压制版本全都列出来，
  由客户端自己挑），版本 Id 里多一个 `i`（第几项；`i = 0` 不写进载荷 ⇒ 老 Id 天然可用）。
  剧集**完全不受影响**（仍按季集号定位，版本 Id 一个字都没变）。决策见
  [ADR-0022](docs/adr/0022-movie-all-play-items.md)。

## [1.1.1] - 2026-09-22

### 变更

- **同一部片的详情只问源一次，有效期内重复点开秒回**。客户端点一次播放会连问三遍同一件事
  （条目详情 → 播放信息① → 播放信息②），原先每一步都要重跑「搜源 → 逐站取详情 → 定位这一集」，
  三次串行约 20 秒。现在把这步的结果存成**详情快照**（`data/cache/detail.db`），第二、三次直接复用：
  实测面板侧「条目详情 → 第一跳 `302` 地址」从约 18 秒降到 **0.47 秒**，
  整条链（到客户端上报开播）从 22 秒降到 **5.2 秒**；整段日志里一条"打分"都没有 —— 一个源站请求都没打。
  有效期在「面板设置 → 设置 → 缓存设置 → 聚合详情」里填（默认 60 分钟；填 `0` = 不缓存；
  勾「长期有效」则不过期）。**播放地址仍然每次现取**（它会过期），快照只到"这一集在源里的 id"为止。
  决策与边界见 [ADR-0020](docs/adr/0020-detail-snapshot.md)。附带的两条口径：**有站失败不写快照**、
  **没命中或没拿到详情不写快照**（一次网络抖动不会被钉住一整个有效期）。

### 修复

- **「剧集详情」不再白跑一趟源站**。剧与季在客户端里是容器，本来按设计就不给版本列表，
  但原先会先把整条源链跑完（5~6 秒）、算出线路与定位，然后才发现类型不可播、把结果全丢掉。
  现在拿到 TMDB 元数据后直接按类型返回：实测 5~6 秒 → **0.3 秒**左右，返回内容与从前完全一致。
- **点播等待从约 2.6 秒降到约 0.1 秒**。面板返回 `302` 之前，要拿到"这一集在这一线路里的播放 id"，
  原先为此**再取一次源详情**（实测那次详情约 2 秒，而源自己的 `/play` 只要 0.07 秒）。
  现在构建版本列表时就把这个 id 记进服务端备忘（`(条目 Id, 源, 站点, 线路, vod) → 集 id`），
  播放时先查它：**命中就直接取地址**；没命中（面板重启、超过 30 分钟、换了源）照旧取详情 ——
  **只影响快慢，不影响对错**（实测：命中 0.10~0.13 秒；重启后回退 2.3~3.7 秒，仍照常 302）。
  为什么不用"把 id 编进 `MediaSourceId`"：夸克类集 id 约 460 字符，编进去会让客户端访问的 URL
  涨到 700 字符上下，客户端与中间代理对 URL 长度的容忍度未知，一旦被截断就是"点了播不了"。
- **`DirectStreamUrl` / `Path` 里的令牌改用 query 的 `api_key`**。原先写成 `X-Emby-Token=`，
  而本层只认**请求头**里的 `X-Emby-Token`（query 只认 `api_key`）—— 客户端自己会带鉴权头，
  所以平时看不出来；但把这个 URL 单独交给外部播放器或投屏时就会 401。`api_key` 这种 query 形式真机也认。

## [1.1.0] - 2026-09-22

### 变更

- **镜像不再包含应用代码**。应用代码安装在数据卷的 `<DATA_DIR>/app/<版本>/` 下：容器首次启动时
  自动取得（`APP_VERSION` 可指定版本，否则取最新 Release），之后在「面板设置 → 设置 → 版本与更新」
  里**手动**更新。更新完成后由容器的引导脚本把新版本拉起，**不需要重建容器、也不需要重新拉镜像**。
  决策与理由见 [ADR-0019](docs/adr/0019-self-update-from-release.md)。
- 发布方式：推送 `v<版本>` 标签后，由 GitHub Actions 打包出
  `media-bridge-panel-<版本>.tar.gz` 与 `.sha256` 并附到 Release；面板**只安装正式 Release 的资产**，
  且**必须**通过 sha256 校验。
- 镜像 tag 因此改标识"运行时契约"（`dlushu/media-bridge-panel:runtime-1`），与应用的版本号解耦：
  当前运行的是哪一版，看面板界面、`/api/meta` 或 `/api/panel/update`。

### 说明

- 首次启动需要能访问 Release 地址。网络受限时用 `APP_SOURCE_URL` 指向镜像地址或本地包
  （支持 `http(s)://` 与容器内可见的本地路径）。
- `<DATA_DIR>/app` 不进入配置备份（它可以从 Release 重新取得）。

## [1.0.0] - 2026-09-22

首次公开发布。

### 新增

- **源托管**：填入可下载 `index.js` 的源地址，面板负责下载、校验并托管运行；支持多个源并存、
  开机自启，以及按间隔自动检查更新（默认关闭）。
- **聚合搜索**：一次请求并发查询多个源站点；对片名做规范化清洗后按权重打分（名字 0.7 / 季集 0.2 /
  年份 0.1），命中与未命中分别可见，并给出分数与未命中原因。
- **版本合并**：同一作品的多条线路合并成客户端可用的版本列表；支持按线路名过滤（正则），
  以及「最多保留条数」与「未凑够时继续向后尝试」两个旋钮。
- **Emby 兼容层**：实现握手、登录、媒体库、条目列表与详情、图片、相似推荐、播放跳转（302）等端点，
  可被 Emby 兼容客户端直接接入。
- **首页插件机制**：内置示例插件行，可自行编写插件决定条目数据。
- **面板**：源 / 站点 / 聚合 / Emby 四组设置页，运行日志，配置备份，密码登录。

### 说明

- 默认登录密码为 `123456`，首次登录后应立即修改。
- 运行数据只存在于数据目录（Docker 部署下是具名卷），备份该目录即可完整迁移。
- 源子进程监听的端口没有鉴权，只应暴露在受信任的网络内。
