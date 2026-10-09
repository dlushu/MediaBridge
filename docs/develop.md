# 开发文档

本文面向修改本项目的开发者，说明对外 API 契约、面板鉴权、数据目录布局、模块扩展方式与实现要点。
安装与使用见 [README.md](../README.md)（用户向，随镜像发布的那一份）。

相关文档：

- 分层、依赖方向与数据流：[ARCHITECTURE.md](../ARCHITECTURE.md)
- Emby 协议对齐：[emby-compat.md](emby-compat.md)
- 设计决策记录：[adr/](adr/)
- 插件（契约、首页插件规范、源码与打包工具）：**另一个仓库**
  [media-bridge-plugins](https://github.com/dlushu/media-bridge-plugins) ——
  本仓库的 `docs/plugin-contract.md` 等四份文档只剩一条指路。

## 目录

- [API](#api) —— 面板层 / 插件宿主 / 聚合层 / 汇总规则与错误语义 / 站点测速
- [面板鉴权](#面板鉴权)
- [数据目录](#数据目录)
- [开发：新增一个模块](#开发新增一个模块)
- [实现要点](#实现要点)
- [注意](#注意)

---

## API

按模块归类。路径中的 `<id>` 是模块 id（`plugin` / `agg` / `emby` / `panel`）。

### 面板层（panel）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/auth/status` | 当前会话是否已登录（前端据此决定是否跳登录页） |
| POST | `/api/auth/login` | 登录（单密码） |
| POST | `/api/auth/logout` | 退出登录 |
| POST | `/api/auth/password` | 改密码（旧会话立刻全部失效） |
| GET | `/api/meta` | 服务自述：`{service:"mbp-panel", version, node, modules}`；外部可据此确认一个地址是否为本面板 |
| GET | `/api/modules` | 模块总览：每个模块的 `apiPrefix`、`upstream` 与当前 `upstreamUrl` |
| GET/PUT/DELETE | `/api/modules/:id/settings` | 读写/重置某模块的设置（新增模块不需要改动此端点） |
| GET | `/api/panel/info` | 版本、Node、数据目录、模块列表，以及**仓库地址**（`repo` / `repoUrl` —— 面板「设置 → 关于」与 Release 链接用它，唯一来源是 `panel/update.js` 的 `REPO`，`APP_REPO` 可覆盖） |
| GET | `/api/panel/notice` | 「设置 → 关于」页内嵌的**公告**内容：回 `{html, url, error?}`。`html` 取自仓库根目录的 `notice.html`（默认 `https://raw.githubusercontent.com/<repo>/main/notice.html`，经镜像候选取回，见 [ADR-0068](adr/0068-about-page-embedded-notice.md)）；**取不到 / 内容为空都回空串**，前端据此隐藏整张卡。带 5 分钟缓存；`PANEL_NOTICE_URL` 可覆盖取回地址（显式给出时不套镜像前缀；置 `off` / `none` / `-` 关闭） |
| GET | `/api/panel/popup` | 登录面板后弹出的**弹窗**内容与类型：回 `{html, mode, seconds, hash, url, error?}`。`html` 取自仓库根目录的 `popup.html`（默认 `https://raw.githubusercontent.com/<repo>/main/popup.html`，经镜像候选取回，见 [ADR-0067](adr/0067-mirror-fallback-sources.md)）；类型与自动隐藏秒数写在该文件的 `<meta name="mbp-popup-mode">` / `<meta name="mbp-popup-seconds">` 里（`always` / `dismissible` / `toast` / `off`，缺省 / 非法按 `dismissible` / 10 秒）。`hash` 是正文（去掉那两条配置 meta）的短哈希，前端据此记「已关过哪一版」。**取不到 / 内容为空都回空串**，前端据此不弹；失败原因只放 `error`（前端不展示）。带 5 分钟缓存；`PANEL_POPUP_URL` 可覆盖取回地址（显式给出时不套镜像前缀；置 `off` / `none` / `-` 关闭） |
| GET | `/api/panel/backup` | 导出**数据备份**：回一份 zip 字节（`Content-Type: application/zip`），含设置、模板、插件（包本体 + 插件数据）、Emby 账号与播放进度；**不含**缓存与应用代码 `app/`（`cache.db` 连同它的 `-wal`/`-shm` 旁文件一起排除）。摘要放在 `X-Backup-*` 响应头：`X-Backup-Files`（文件数）/ `X-Backup-Size`（**包的实际字节数**，不是内容未压缩字节和）/ `X-Backup-Exported-At`；文件名前缀取品牌短标识（`branding.slug`） |
| POST | `/api/panel/restore` | 用备份 zip 还原：请求体是**原始二进制**（`Content-Type: application/zip`）。解包校验 `manifest.json` 后把顶层项逐个覆盖回 `DATA_DIR`，还原后需重启面板生效 |
| GET/DELETE | `/api/panel/cache` | 看面板侧两份缓存的用量 / 清空（线路结果与图片索引） |
| GET | `/api/panel/update` | 版本与更新状态：`{managed, current, latest, hasUpdate, repo, source, appRoot, runningDir, installed[], previous, error}`。查最新 Release 有 60 秒缓存，失败把原因写进 `error` 而不抛 |
| POST | `/api/panel/update` | 安装某个版本并请求重启：`{version?}`（省略则装最新）。装完写 `<DATA_DIR>/app/.restart` 并向自身发 `SIGTERM` 走正常关闭流程，由容器引导脚本拉起新版本。`managed:false`（非引导脚本托管）时返回 400 |
| POST | `/api/panel/restart` | 只重起**应用进程**（容器不动，版本不变）：受托管时写 `<DATA_DIR>/app/.restart` 再退出，由引导脚本按 `current.json` 拉起同一版本；**非托管时退出前自拉起**一个同代码的副本（见 [ADR-0038](adr/0038-self-relaunch-when-unmanaged.md)）。带文件看护的启动方式（`npm run dev` / `node --watch`、nodemon）如实回 400 —— 那套自己会重起子进程，与自拉起叠加会抢端口 |
| GET/DELETE | `/api/logs` | 面板日志的内存缓冲：读最近 N 条 / 清空 |

### 插件宿主（plugin）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/plugins` | 插件清单：每个插件的类型 / id / 版本 / 域 / 启用状态 / 运行状态 / pid / 动作 / 重启次数 / 已跑时长 / 来源（`library` 从插件库装的，`manual` 手动上传的），另带 `types`。**不含**任何"随包发行"的内置插件 |
| GET | `/api/plugins/library` | **插件库**：从插件仓库拉清单（`?refresh=1` 绕过 60 秒缓存），逐条标出 `installed` / `installedVersion` / `installedOrigin` / `hasUpdate` / `sourceUrl`（**首选取包地址**，实装可能经 `APP_MIRRORS` 镜像候选，见 [ADR-0067](adr/0067-mirror-fallback-sources.md)）。拉不到不抛，把原因写进 `error` |
| POST | `/api/plugins/library/install` | **从插件库装**：`{type, id, version?, enable?}` —— 按清单取包，走下面同一套两道校验 |
| POST | `/api/plugins/install` | 装一个本地包（`tar.gz` 的 base64 + 可选的包 md5；包里 `plugin.json` 声明了 `files` 就逐文件核对）。任一道对不上 → **400** |
| DELETE | `/api/plugins/:type/:id` | 卸载：停进程、删插件目录（含它自己的 `data/`） |
| POST | `/api/plugins/:type/:id/enable` / `disable` | 启用（立刻起进程）/ 停用 |
| POST | `/api/plugins/:type/:id/restart` | 重启（停干净再起） |
| POST | `/api/plugins/:type/:id/call` | **动作调用**：`{action, args?, timeoutMs?}` → 插件的回答（面板不解释，原样转回） |
| GET | `/api/plugins/:type/:id/ui/*rest` | **托管插件自带的 webui** 静态文件（编码过的路径穿越 → 400） |
| ANY | `/api/plugins/:type/:id/api/*rest` | **转发通道**：把请求转成插件的一条动作调用（GET/POST 都通，body 是 UTF-8 字符串、`contentType` 一并转过去） |

- 插件跑在**常驻子进程**里、走**管道**（Node child IPC）通信；宿主负责启停、健康与日志转发；
  进程自己退出只**如实记账，不自动重启**（见 [ADR-0037](adr/0037-no-plugin-auto-restart.md)）。
  契约在开发套件仓：[plugin-contract.md](https://github.com/dlushu/MediaBridge-plugin-devkit/blob/main/framework/contracts/plugin-contract.md)；
  决策见 [ADR-0028](adr/0028-plugin-system.md) 与 [ADR-0029](adr/0029-plugin-channel-and-actions.md)。
- `/ui/*` 与 `/api/*` 两条都在 `/api/` 下 ⇒ **天然受面板门禁**。
- **插件不随面板发行**（见 [ADR-0035](adr/0035-plugin-library.md)）：Release 包里没有插件，
  装完零插件；插件由「插件库」页从 `dlushu/media-bridge-plugins`（`PLUGIN_REPO` 可换）
  取包安装，或在管理页上传 `.tar.gz`。两条入口只差 `origin`（`library` / `manual`），
  卸载都**只在本机生效、重启不会装回来**（原先的开机同步内置插件已删除）。
- **插件源码与打包工具都在插件仓库**（本仓库不再有 `plugins/` 与 `tools/plugin-pack.js`）：
  `node tools/plugin-pack.js <类型>/<id>` 打一个、`--all` 全量重建，`index.json` 按 `packages/`
  里现有的包重算。

### 聚合层（agg）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/agg/sources` | **源清单**（源与站点都由源插件申报，经宿主的动作调用）：`{ sources[] }`，每项带 `ok`/`ms`/`siteCount` |
| GET | `/api/agg/sites` | **源清单 + 站点清单 + 模板 + 域 + 元数据域**：`sites[]` 每项带 `source`/`sourceName`/`stat` 与 `templates`（这个站被哪几套模板用了）；另带 `templates` / `domains` / `providers` |
| GET | `/api/agg/templates` | 模板与域对照（外加已注册的元数据域 `providers`） |
| POST | `/api/agg/templates` | 存一份模板（站点集合 + 打分过滤参数 + 超时与并发） |
| DELETE | `/api/agg/templates/:id` | 删一份模板（各域对它的指向一并清掉） |
| POST | `/api/agg/domains/:domain` | 把某个域指到某份模板上（`templateId` 传空 = 取消这个域的指向） |
| POST | `/api/agg/search` | **聚合搜索（带打分）**：`{tpl\|domain, wd, page?, year?, season?, episode?, minScore?, maxItems?, timeoutMs?, concurrency?, keys?}` → `{wd, page, elapsedMs, sites, matched, unmatched, match, stats}`；**作用域二选一**：`tpl` = 直接点名一套模板（web 的「聚合搜索」页就这么选），`domain` = 按域查（客户端那条路）—— 两者都落到同一份模板上（参数与站点都来自它，见 `agg/api.js` 的 `scopeOf`）；`keys` 是**站点白名单** `[{source,key}, …]`；每条结果带 `score`/`matched`/`matchReason` |
| POST | `/api/agg/detail` | 取详情（内部含搜索）：`{tpl\|domain, name, year?, season?, episode?, minScore?, maxItems?, extraK?, extraAll?, timeoutMs?, detailTimeoutMs?, keys?, source?+site?+vodId?}` → `{ok:true, sites, picked, stats, sources, elapsedMs, subtitles?}`（每站一条 `detail`：线路 → 选集；**每站条目带 `sourceName`**，**每个可播目标带拼好的 `versionLabel`** —— 版本行标题位，供 emby 层与出口插件共用，见 [ADR-0063](adr/0063-version-label-at-aggregate-output.md)）；作用域同上（`tpl` 或 `domain`）；调用方输入有误 → 400 `{error}`。**命中的站一律全取**（没有「全取」开关）。**有站拿到详情且给了 `name` 时**另回一份 `subtitles`（这个播放目标的字幕轨 `[{lang, format, label?, source?}]`，面板为一个目标问一次字幕插件、挂在整个目标上；`source` 是**申报该轨的字幕插件名**，供面板「这条的版本」弹窗标来源，多个字幕插件时可区分；**`ref` 已在 HTTP 出口剥掉**，见 [ADR-0073](adr/0073-subtitle-tracks-in-agg-detail.md)） |
| POST | `/api/agg/play` | 取播放地址：`{domain, ref, clientHost?}` → `{ok:true, play:{urls, header, parse, nonHttp}}`。地址会过期，**每次播放都现取**（缓存在插件那边） |
| GET | `/api/agg/stream` | **外部客户端直接拉流**（出口插件 / FW / Rex widget 等）：① `?domain\|tpl=&ref=&token=` 按版本坐标取地址（`playVia` 决定 302 / 清单中继 / 代持头中继）；② `?seg=&sid=` 上一跳清单改写出的签名子地址（自验 HMAC、不要求令牌）。凭证是**外部访问令牌**（query `token` / `Bearer` / `X-Access-Token`）；这条路径在 `core/auth.js` 的 `needsAuth` 里**豁免面板 cookie 门禁**、由本路由自验凭证。**另有同 handler 的带后缀别名 `GET /api/agg/stream.m3u8`**（部分播放器 / 客户端按 URL 后缀认容器，见 [ADR-0075](adr/0075-stream-suffix-alias.md)） |
| GET | `/api/agg/site-test` | **站点测速状态**（服务端后台任务）：`{enabled, hours, concurrency, timeoutMs, running, done, total, okCount, emptyCount, badCount, stopped, lastRunAt, lastElapsedMs, nextRunAt, pending}` |
| POST | `/api/agg/site-test/start` | **开一轮测速**：body 可带 `keys`（只测这些站；省略 = **全部站点**）；上一次没跑完 → **409** `{busy:true}` |
| POST | `/api/agg/site-test/stop` | **停止当前这一轮**（已测完的那些站的结果照常保留） |
| POST | `/api/agg/site-test/one` | **单站测速**（站点表每行的「测速」按钮）：`{source, key, api?}` → **同步**返回这一发的结果；不碰后台任务，只写同一个统计槽 |

`detail` / `play` 的编排位于 **`agg/api.js`**：路由层（上表两条端点）与 **emby 层**共用同一套实现，
emby 层直接 `require` 该模块而**不经过 HTTP**（原因见 [ARCHITECTURE.md](../ARCHITECTURE.md) 的
「例外：emby 层进程内直调聚合层」与 [ADR-0002](adr/0002-in-process-emby-to-agg.md)）。两处返回形状完全一致，
区别只在失败时：路由层把它翻成 HTTP 状态码，emby 层读 `error.code` / `error.message` 并写进日志。

**挑片判据：本地打分**（见 [ADR-0003](adr/0003-local-title-scoring.md)）

- 搜索阶段即给每条结果打分（实现见 `server/modules/agg/match.js`）。权重为
  **名字 0.7 · 季集 0.2 · 年份 0.1**，缺失项不计入分母。
- 两道闸门：
  - **名字硬拒** —— 清洗后无公共主干，或相似度 < 0.5，直接出局（用于拦掉 `斗破苍穹4：逃亡` 这类同系列不同作品）；
  - **分数线** —— `minScore`，**填 0 = 不做分数线筛选**，此时只按分数排名取前 `maxItems` 条。
- 早期实现为「名字完全相等，否则把候选名交给上游反查条目编号」，失败点在输入侧：站源标题常含更新话术与
  画质标注（如 `斗破苍穹年番4更211[2025][动漫]`），直接检索无法命中 ⇒ 版本列表为空
  （在 Emby 中表现为「条目在、点开没有版本」）。本地打分不需要外部依赖，且能说明「为什么是这一条」。
- **阈值与条数进模板**（`matchMinScore` 默认 0.85 / `matchMaxItems` 默认 8 / `matchExtraK` 默认 8，
  在「模板」页修改）。web 的「聚合搜索」页**不再填这两项**（它只决定"搜什么"：关键字 / 季 / 集 / 年份），
  要单次覆盖只能直接调接口（请求体里的 `minScore` / `maxItems`，见上面的接口表）。
- **条数为什么要限制**：每多保留一条命中，后续就要多打一次站源 `/detail` 取链。实测保留 3 条 ≈ 2s，
  全部保留要到十几秒。
- **三个超时分开、单位是秒**（见 [ADR-0026](adr/0026-seconds-and-detail-timeout.md)）：
  模板里的「单站超时」`timeoutSec`（秒，默认 5）= 搜索 / 首次 `/init`；
  「取详情超时」`detailTimeoutSec`（秒，默认 10）= 取详情 `POST /detail` 的单站上限；
  「播放超时」`playTimeoutSec`（秒，默认 25）= 取播放地址 `POST /play` 的单站上限。
  详情独自一档是因为**剧集目录动辄几十上百集**（响应体大、上游拼装慢），与搜索共用一个超时会
  大量"定位不到"；播放独自一档是因为**网盘类线路取一个地址要串行打好几发**
  （登录 → 查已保存 → 提交离线下载 → 等完成 → 取直链），与搜索共用一个 5 秒档会被一律判成超时。
  请求里可分别用 `timeoutMs` / `detailTimeoutMs`（**毫秒**）单次覆盖；
  详情超时**进详情快照的 key**（改了要重算一次）。
- **web 上可直接查看版本**：每条搜索结果上的「**这条的版本**」走 `source+site+vodId` 快路径（跳过搜索），
  以**弹窗**列出客户端会看到的内容 —— 每站「定位到这一集 N 条线路」+ 逐条线路的定位情况。
  核对「客户端点开到底会看到什么」看这里（同一套 `agg/api.js`，与 Emby 进程内直调是同一条链）。
- **接续补打 = 前面一条能用的都没拿到时才兜底往下打**（见 [ADR-0027](adr/0027-extra-fetch-only-when-zero.md)，
  它取代 [ADR-0005](adr/0005-continuation-fetch.md) 的触发与停止口径）：
  命中 ≠ 能播 —— 前 `matchMaxItems`（N）条取详情后**一条能用的都没有**（没有线路 / 未定位到这一集）时，
  按分数继续往下打，**最多再试 `matchExtraK`（K）条**，**整批并发、第一批拿到能用的就不再发第二批**；
  K 填 0 = 不补打（默认 8，即前 8 条都没拿到能用的就补打）。前面已经有版本时**一条都不补打**。
  `matchExtraAll`（开关）= **匹配到底**：不看 K，一直往下打到拿到一条或名单打完（可能很慢）。
  诊断字段：`stats.targetN / matchUsable / extraTried / usableExtra`、`picked.matchedBy='score+extra'`。
- **定位只认集号**：`detail` 传了 `episode` 就定位（`season` 可选）—— 源里的集名常常只有集号
  （如 `[842.5MB]211 4K.mp4`），只填集号而不给季号时，早期实现**一条都不定位**
  （看起来像源里没有这一集）。
- **失败可见**：`unmatched[]`（带 `score` + 原因：低分 / 超上限 / 名字不过闸）与
  `match{scanned,matched,belowLine,overCap,rejected,sameNameSameSite,minScore,maxItems}`；日志里也有一行摘要。

`POST /api/agg/search` 返回结构（`sites` 是**数组**，站点身份 = `source` + `key`）：

```jsonc
{
  "wd": "斗破苍穹", "page": "1", "elapsedMs": 1812,
  "sites": [                       // 每项：站点身份 + 该站原样输出
    { "source": "<源插件id>", "key": "nodejs_muou",
      "name": "木偶|4K", "api": "/spider/muou/3", "ok": true, "ms": 803,
      "data": { "page": 1, "pagecount": 1, "list": [ /* 站源原样条目 */ ] } },
    { "source": "<源插件id>", "key": "nodejs_slow",
      "name": "示例|慢", "api": "/spider/slow/3", "ok": false, "ms": 15000, "error": "超时(15000ms)" }
  ],
  "stats": { "requested": 3, "ok": 2, "failed": 1, "empty": 0,
             "totalItems": 2, "duplicatedItems": 0, "timeoutMs": 5000, "concurrency": 8 }
}
```

**多源**

- 聚合用的源 = **各源插件申报的实例清单**（源插件自己存实例、自己起进程、自己管自动更新）。
  面板不认识任何"源地址"，也没有源清单设置。
- 站点 key **只在各自源内唯一**，因此 `enabled` / `order` / 请求参数 / 响应里都带 `{source, key}` 两个字段，
  **绝不用裸 key 对齐**。

### 汇总规则与错误语义（聚合层）

- **只拼接、不去重**：每个站点的条目留在它自己的 `data.list` 里，不复制到顶层、不合并同名。
- **并发池**：按 `concurrency` 分批并发；单站失败/超时**只影响它自己**（该站 `ok:false` + `error`），
  整体仍返回 **200**。
- **首次 init**：每个站源请求前先 POST 一次 `/init`（**恒开** —— 原来那个 `initFirst` 开关已删：
  有的源不 init 就搜不出来，这是源的性质、不是选项），按「源地址 + 站点 key」缓存，不是每次请求都打。
  服务端测速任务每轮也走这一处，所以**一轮测速跑完 = 全站都已 init**；源重启换了端口时缓存键跟着变，
  业务侧会自动重新 init 一次。这一步由**源插件**完成，面板只发"搜索"这个动作。
- **同名统计**：`stats.totalItems` / `duplicatedItems` 与界面上的「同名 ×N」都用 `normName()`
  （去除空格与标点引号括号破折号后转小写比较）。
- **不做「同站同名去重」**（见 [ADR-0004](adr/0004-no-same-site-dedup.md)）：同名的几条各有自己的
  `vod_id`，哪条能播要取过 `/detail` 才知道 —— 按分数猜一条保留、把其余丢掉，正是
  「**同名反而匹配错**」的来源。因此**源给了几条就算几条**，只在 `match.sameNameSameSite` 里计数展示。
- **错误语义**：`wd` 为空 → 400；域没配模板 → 404（并点名）；未配源 → 400；
  勾选的站点一个都取不到 → 400（并指明是哪个源取不到站点）；单站 HTTP 非 200 → 该站 `ok:false`；
  详情按「命中才算数」统计 `stats.detailOk / detailFailed`。
- **线路过滤落地**（[ADR-0025](adr/0025-line-filter-in-usable-judgement.md) + [ADR-0043](adr/0043-line-filter-at-aggregate-output.md)）：
  规则**只在 `agg/service.js` 的 `lineFilter()` 实现一次**，两处用它：
  ① **产出上**（`applyLineFilter`，`aggregateDetail` 返回前）把不匹配的线路从 `detail.lines` 去掉 ——
  emby 与出口插件（FW/Rex）拿到的都是这份滤过的结果，**谁都不再自己滤**（接一个客户端不必再实现一遍）；
  ② **判据上**（`detailUsable` 带 `re`）：判断一条条目值不值得留着，用的是**过滤后**的可用条数
  （`stats.usable`，与客户端真能列出的版本一致），于是"过滤后一条都列不出来"的条目不算数 ——
  接续补打会继续往下找，**详情快照也不存它**。过滤前后条数记在 `stats.lineFilter`，日志里会写
  `· agg 线路过滤 /…/：过滤前能用 X 条 → 过滤后能用 Y 条`。

### 站点测速（agg）

「模板」页那一列「延迟」的来源 —— **服务端后台任务**（`agg/site-test.js`），
不是前端循环（原先前端逐站调，一关页面就断；而"每 6 小时自动一轮"这件事本来就不可能由前端做）。

- **测什么**：每站一发 `POST {api}/search`，**关键词从常见影视名数组里随机取**
  （`agg/api.js` 的 `PROBE_WORDS`）；**非 200 就换一个词再测一发**，两发都非 200 才算真失败。
  随机取是为了避开"固定词恰好这站没有"：站里没那个词时会回 404 或空列表（实测 duoduo / huban）。
- **口径**：`HTTP 200 = 成功`（**列表为空也算** —— 它已经尽了搜索的义务）；非 200 记失败并记下状态码
  （404 / 500 / 403 …）；超时与网络错记失败。⚠️ 这与业务侧**刻意不同**：`searchSite` 把 404 记成
  "无结果、不算失败"，所以两笔**分开存**（`speed` 槽 / `call` 槽），别互相覆盖。
- **"聚合搜索要不要跳过这个站"用的就是 `speed.search`**：失败即跳过、成功即恢复，**没有时间窗口** ——
  这样"表里标红的站"与"被跳过的站"是同一个集合；恢复时机由测速周期（定时或手动）决定。
  `call.*` 只用于单元格 `title` 的诊断显示。
- **单点测速**：`POST /api/agg/site-test/one`（`{source, key, api?}`）只测一个站、**同步**返回，
  并且**不碰后台任务**（不改进度、不重排自动测速），只写同一个统计槽 ——
  站点表每行那个「测速」按钮就是它。
- **固定 15 秒超时**（`SPEED_TEST_TIMEOUT_MS`），**不读模板里的超时** —— 拿 5 秒去测会把慢站
  一律记成超时，量到的是设置而不是站。
- **并发 3**、**全部站点**；**跑完才排下一轮**，不会因为一轮慢而堆起来。
- **触发**：① 每 `speedTestHours` 小时（面板设置，默认 6；`speedTestAuto` 默认开）；
  ② 手动 `POST /api/agg/site-test/start`（可带 `keys` 只测一批站）。
  ⚠️ 原先还有"某个源起来/重启后自动测一轮它的站点" —— 源实例现在活在源插件里，面板收不到那个事件，
  已随源插件化去掉（开机那一轮会覆盖自启的实例）。
- **只留最近一次**：`cache/sitestat.db` 里每站每类一个槽，**直接覆盖**（没有样本数组、没有次数累计），
  所以那一列只有"最近一次测出来多少"；TTL 30 天。
- **真实业务那一份不占列**：`searchSite` / `fetchDetail` 的顺手记账（`call.search` / `call.detail`）
  只出现在单元格的 `title` 里 —— "点开要等多久"只有站点被真的用过才有值，如实留空。

## 面板鉴权

面板自身有一道**单密码门禁**：浏览器打开面板需要先登录，未登录会跳到独立登录页 `/login.html`。
登录后默认 15 分钟内免登录，**滑动过期**（从最后一次操作起算，一直在用就顺延），
时长可在「面板设置 → 安全」改、上限 30 天（见 [ADR-0064](adr/0064-panel-session-sliding-expiry.md)）。
取向见 [ADR-0017](adr/0017-panel-auth-single-password.md)。

- **默认密码 `123456`**（首次启动时写进 `data/auth.json` 的是它的 scrypt 哈希，不是明文）——
  **打开面板后应立即到「面板设置 → 安全」修改**（仍在使用默认密码时，「概览」页会持续显示警告）。
- **改密码 = 旧会话立刻全部失效**（签名中带密码指纹）；「面板设置 → 概览」里也有「退出登录」。
- **保护范围**：面板自身的接口（`/api/agg*` / `/api/plugins*` / `/api/modules*` / `/api/panel*` /
  `/api/logs` …），**含插件 webui 与它的转发通道**（都在 `/api/plugins/<类型>/<id>/` 下）。
- **不拦截两类**：
  - `/api/auth/*` —— 登录本身（否则无法登录）；
  - `/api/emby/*` —— Emby 客户端使用的兼容端点，它们有自己的 AccessToken 校验。
    **面板门禁拦截它们 = 所有客户端立刻断开**（Docker 健康检查也走那条路），因此必须放行。
- 静态文件（首页 / JS / CSS）不拦截：那只是外壳、没有数据，登录页本身也依赖它。
- 试错节流：同一 IP 连续失败 5 次 → 锁定 60 秒（面板日志里能看到失败与锁定）。

**这不是一套用户体系。** 一句话：**一个密码、一个共享会话，用于挡住局域网内随手打开面板的人**。
面板默认是 **http 明文**（密码在链路上是明文，除非在前方套了 https 反向代理），没有多用户、没有权限分级 ——
**不要把面板直接暴露到公网**。

凭证落在 `data/auth.json`（**不在 `settings/` 下**：那是模块设置的地盘，鉴权不属于任何一个模块）。
它**会被数据备份一并打走**（备份含全部数据，见「数据目录」），备份文件本身要妥善保管。
删除该文件即回到默认密码 `123456`。

## 数据目录

```
data/
  app/<版本>/              **应用代码**（容器启动时从 GitHub Release 取得；面板可手动更新，见 [ADR-0019](adr/0019-self-update-from-release.md)）
    server.js  server/  public/  package.json  README.md
  app/current.json         当前运行版本（`{version, installedAt, source}`）
  app/.restart             更新时的重启标记：引导脚本读到即拉起新版本（正常运行时不存在）
  settings/<模块>.json     模块设置（plugin / emby / panel；`agg` 没有设置文件，它的配置是模板）
  settings.json.migrated   旧版单文件设置（升级留档，可删）
  templates/<模板 id>.json  模板：站点集合 + 打分过滤参数 + 超时与并发
  templates/domains.json    域 → 模板 id 的对照
  auth.json                面板门禁：密码的 scrypt 哈希 + 会话签名密钥（**不要外传**；删除即回到默认密码）
  emby/emby.db             Emby 客户端登录账号（内置 sqlite；密码只有 scrypt 哈希）
  emby/cache.db            图片索引（独立 SQLite）
  cache/lines.db           线路结果缓存（面板侧的聚合详情）
  cache/sitestat.db        站点统计与测速（可按"插件 + 站点"记账）
  plugins/<类型>/<id>/       插件包本体（从插件库装的或手动上传的，见 ADR-0035）
  plugins/<类型>/<id>/data/  插件自己的数据（设置与其缓存，如源插件存实例清单、元数据插件缓存响应）
```

- **数据备份**（`GET /api/panel/backup`，一个 zip）覆盖数据卷里的全部数据：设置、模板、插件（包本体 +
  插件数据）、Emby 账号库与播放进度、以及 `auth.json` 这类顶层文件。
  - **不含**应用代码 `data/app/`（可以从 Release 重新取得）与**缓存**（`cache/`、`emby/cache.db`、
    各插件的 `data/cache/`）—— 缓存随时可删掉重建。
  - ⚠️ 备份**含敏感内容**（插件数据里的网盘 cookie/token、账号库的密码哈希），备份文件本身要妥善保管。
  - 还原（`POST /api/panel/restore`）是**整项覆盖**：把 zip 里的顶层项逐个替换回数据卷，还原后要**重启面板**才生效。
- `data/` 已在 `.gitignore` 里（**含凭证**，不要提交）。
- 想完全清空：停掉面板后 `rm -rf data`。
- 想只清某个插件的数据：删 `data/plugins/<类型>/<id>/data/`（也就是面板里的「清空插件数据」）。

## 开发：新增一个模块

1. `server/modules/<id>/index.js` 声明清单：

```js
module.exports = {
  id: 'foo',
  label: 'Foo',
  apiPrefix: ['/api/foo'],          // 对外暴露的前缀（文档与总览使用）
  upstream: 'agg',                  // 所消费的上游模块（读它的地址）；null = 不依赖其它模块
  settings: { defaults: () => ({}), validate: (o) => null, fields: [] },
  routes: (r) => { r.add('GET', '/api/foo/ping', (req, res) => sendJson(res, 200, { ok: true })); },
};
```

2. `server.js` 的 `MODULES` 数组加一行 `require('./server/modules/foo')`。
3. 前端加一个模块文件、在 `public/core/registry.js` 的 `MODULES` 里登记（侧栏按钮由它现画）。

模块设置会自动多出 `data/settings/foo.json` 与 `/api/modules/foo/settings`，无需改动 `core`。

## 实现要点

- **插件只有两个动作面**：`agg` 经 `agg/source-bridge.js` 转源插件的动作（把插件的回复**还原成上游那份形状**
  `{status, ok, text, json}`，于是聚合层那套 404=无结果、超时文案、逐站记账一个字都不动）；
  `emby` 经 `emby/meta.js` 转元数据插件、经 `emby/home/index.js` 转首页插件。转接处只有这两处。
- **响应即「站点 key → 原样输出」**：`sites[key].data` 就是该站 `/search` 的原样响应体，不复制、不裁剪、
  不去重；前端按站点 key 分组渲染，同名条目显示「同名 ×N」角标（前端本地按相同归一化规则统计，仅作提示）。
- **可回溯**：聚合搜索页里每条结果都能展开**原样响应里的那一条**（`原始条目`），便于逐层对照排查。
- **并发池**：默认 8 并发、单站 5 秒超时、取详情 10 秒（模板里可改，下限 1000ms / 并发 1~32）；
  单站失败不影响整体，结果里带每站 `ok`/`ms`/`error`。
- **首次搜索先 `/init`**：按「地址 + 站点 key」缓存，避免每次搜索都多一次请求。
- **代理不解析协议**：请求原样转发，`/play` 返回的源内代理地址、`header`、`push://` 等语义完全保留。

## 注意

- **能力的设计不参照已有插件角色**：源 / 首页 / 元数据 / 出口插件都只是**可替换的角色**，
  面板给客户端提供的能力必须**对任何一个插件都成立**。判断"面板该不该做某件事"，
  依据是**契约中客户端与插件的通用前提**，不是现成插件的做法 —— 不能因为"某个源插件自己就把
  代理解决了"就认定"面板不需要做代理"，它的实现也**不构成面板的能力边界**。
  反过来同样成立：某个插件已经在做某件事，既不自动构成需求，也不构成豁免理由。
- **每个插件都有一份自己的文档记录**（放插件自己目录下，如 `NOTES.md`）：写清它**做什么、契约里
  声明了什么、依赖哪些外部前提、设置项、已知边界与取舍**。**没有文档的插件不算做完。**
  - 面板与插件是两套代码、各走各的演进节奏。判断"某段逻辑还要不要留"，依据只能是**文档里记下的
    那条依据**，靠记忆必然出错 —— 已经发生过两次同类的误判：
    ① 拿"某个源插件自带代理"当作"面板不需要代理"的依据；
    ② 把出口插件的「起播前预解析 + 把请求头交给播放器」误判成可退役的权宜 —— 它其实建立在
       **FW/Rex 宿主本身能把请求头交给播放器**这个真实能力上，与面板的字节代理是**并存关系**、
    不是替代关系（前者省面板带宽但要播放器配合，后者通杀但吃面板带宽）。
- 站源接口全部是 **POST + JSON body**（`/init` `/home` `/category` `/detail` `/play` `/search`），
  只有 `/config`、`/check` 是 GET。这些协议细节在**源插件内部**（各自的源码目录下），
  面板不再解析。
- 插件包的**两道 md5 校验**（见 [ADR-0015](adr/0015-source-bundle-integrity.md)）：
  ① 包本身的 md5（发布方给的那个，可省）；② 清单里 `files` 声明的**逐个文件** md5。
  任一道对不上就**当场拒绝**（400），不"先装上再说"、也不拿实际值去覆写清单假装成功。
- 关闭面板时会一并停止所有插件子进程（含源插件**自己**起的源实例）—— "面板停、插件就停"由宿主保证。
- 数据备份**含**插件数据与模板（见「数据目录」）；只有应用代码 `app/` 与缓存不在其中。
- Emby 兼容开发：
  - 端点的补齐顺序按实际客户端需求确定，规则与流程见 [emby-compat.md](emby-compat.md)；
    最新端点清单以 `server/modules/emby/routes.js` 为准。
  - 总口径：**列表数据由首页插件决定，emby 层做中介（端点映射 + DTO 转换）；点进条目后详情走
    元数据插件（点击时按域取元数据）+ 聚合资源**。DTO 形状按真机对齐的取舍见 [ADR-0007](adr/0007-emby-dto-shape.md)。
  - 其余未实现的 `/api/emby/**` 请求只记日志并返回 501。
- Emby + 元数据插件失败语义：**如实返回失败码，不编造占位数据、不返回空的假成功**
  （见 [ADR-0008](adr/0008-no-fabricated-data.md)）。
  - 上游给出状态码就照搬（401/403/404/429/5xx）。
  - 网络层归类为：连不上 `502` / 超时 `504` / 未配 token `500` / id 不合法 `400`。
  - 「如实回空」的端点不校验账号，见 [ADR-0009](adr/0009-unauthenticated-empty-responses.md)。
- Emby 条目 `Id` 由**元数据域坐标**派生（`{域前缀}_{条目 id}_{tv|movie}[_s{n}][_e{m}]`，
  如 `{域}_{编号}_tv_s1_e3`），**不含源信息** —— 客户端拿它当主键缓存，掺入「哪个站点」会因源变动而改变
  Id、丢失「已看」。认哪个前缀由 `core/providers.js` 这张注册表说了算（元数据插件申报，见
  [ADR-0031](adr/0031-metadata-by-domain.md)）；认不出就如实返回 null（调用方照 404 处理）。
  - `条目 id → 站点 vod_id` 的绑定留给后续实现（播放时才需要）。
  - 派生与解析是一对（`providers.itemId` / `providers.parseItemId`），代码中相邻放置。
- 元数据插件：设置**归元数据插件自己**（其数据目录下的 `settings.json`：
  凭证 / 基地址 / 语言 / 它自己的缓存），UI 是插件自带的 webui 设置页。
  - 面板只从插件的「注册」动作里拿**图片基地址与外链**（替客户端取图要拼串，见 `emby/meta.js`）。
  - 凭证与端点地址一概由元数据插件自己解释（明文落盘）；基地址留空即上游官方地址，可换成反向代理。
  - 插件的设置页有「测试连接」，会用**当前未保存**的输入值实查一个 id 并回显。
- Emby 账号（**多个**客户端登录账号）：存 `data/emby/emby.db`（Node 内置 sqlite，文件权限 600），
  密码只存 **scrypt 哈希**，遗忘后只能删除重建。
  - `UserId` 由「serverId + 用户名」派生，因此**改用户名或删账号 = 该账号的客户端需要重新登录**。
  - 「数据备份/还原」覆盖整份数据卷（**含**该账号库），还原后需重启面板生效。
- Emby **拉流（302 之前）**：构建版本列表时会把"这一集在这一线路里的播放 id"记进服务端备忘
  （`(条目 Id, 域, 站, 线路, vod) → 集 id`，TTL 30 分钟），拉流时先查它 —— 命中就直接调插件的 `/play`，
  省掉一次源详情（实测那一次约 2 秒，命中后整跳 0.1 秒上下）；未命中（重启/过期/换源）照旧取详情。
  **备忘只影响快慢，不影响对错。**
- Emby **AccessToken 校验**：登录签发的 token 存 `sessions` 表，多个端点校验它。
  - 三种携带方式都识别：`X-Emby-Token` / `Authorization`·`X-Emby-Authorization` 中的 `Token="…"` /
    query `api_key=`。
  - **无效或未携带 → 401**。
  - 豁免：握手、登录、账号管理、501 通配，以及**图片端点**（见
    [ADR-0013](adr/0013-image-endpoint-signing.md)）。图片请求的凭证携带方式不统一，实测 3/8 完全未携带，
    若强制要求会让这部分客户端的图片加载失败。
  - 改密码/删账号会作废该账号的所有 token。
- Emby **首页插件**：`home` 类型插件，经统一插件宿主运行（安装 / 启停 / 动作调用 / 自带 webui
  都由宿主处理），一行 = 客户端上的一个媒体库。
  - 插件向宿主提供两个动作：`rows`（无参，申报行清单，每个元素 `{id, title, collectionType?, feed?}`）、
    `run`（`{rowId, params?, startIndex?, limit?}` → `{items, total, cached?}`）。
  - 插件跑在自己的常驻子进程里，**自己存 token、自己带**（统一宿主不给插件回调面板的通道，
    插件之间也不能互相调用）；行的结果缓存也归插件自己（行里的 `cacheDuration`）。
  - 面板侧 `server/modules/emby/home/index.js` 只剩**薄适配层**：媒体库 Id 形状
    （`viewId` / `parseViewId`）与条目严格归一化，另存一份异步刷新的行清单快照给同步调用点读。
  - 面板侧不再有 `/api/emby/home/**` 自用端点；设置与行参数在插件自带 webui 里
    （侧栏「首页」栏下点插件名，或「插件 → 管理」页那一行的「设置」按钮）。
  - 已接客户端端点：`Views`（每个启用的行 = 一个库）/ `Items?ParentId=<库Id>` /
    `Items/Latest?ParentId=<库Id>`（VidHub 首页依赖它）/ 库封面 / **「轮播推荐位」查询**
    （没有 `ParentId` 的轮播推荐位 `SortBy=IsFavoriteOrLiked,…` → 路由到
    **声明了 `feed: 'random'` 的行**）/ **「裸列表查询」**
    （无 `ParentId` 且不递归、只带 `ExcludeItemTypes`/`StartIndex`/`Limit`/`Fields` 的查询如 Filmly 首页 →
    **回顶层库列表**，与 `Views` 一字不差，见 [ADR-0055](adr/0055-bare-items-query-returns-views.md)）；
    `startIndex` / `limit` **原样透传**，面板与插件层都不切片。
  - 规范见 [emby-home-plugin.md](emby-home-plugin.md)。

## 未实现

已知的缺口，按需要补齐；补哪个由实际客户端需求决定。

**端点**

- `GenreItems` 的列表端点（客户端点击类型之后会请求到它，当前落到 501）。
- 用户级变体 `Users/{uid}/Items/{id}/Similar`（条目级的 `Items/{id}/Similar` 已实现）。
- `POST /Sessions/Logout` —— 客户端"退出登录"会落到 501，**已签发的 token 不会被吊销**。
- `/Users/Public` —— 登录界面取用户列表用的那条。

**性能与稳定性**

- **条目详情是秒级**：`getItem` 每次都调用 `agg.detail({ name, year })`，即**按名字重新搜索**，
  从未走聚合层提供的 `source + site + vodId` 快路径 —— 聚合层为"已知绑定"预留了该路径，emby 层尚未接上。
  前置条件是先实现 `元数据 id → 站点 vod_id` 的懒绑定与落盘。
- **取图偶发 `502`**：到图床的链路抖动，同一 URL 重试即可成功；是否增加一次重试尚未决定。