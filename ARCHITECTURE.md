# 架构说明

本项目把多个数据源（由源插件申报）聚合成一份可直接交给播放客户端的媒体源。
本文说明分层、依赖方向、目录结构与模块边界；设计取舍的理由记录在
[docs/adr/](docs/adr/)。

## 分层与依赖方向

```
插件（源 / 元数据 / 首页，各自跑在一个常驻子进程里）
        ▲
        │ 动作调用（经 plugin 宿主，走管道）
        │
   agg（聚合层） ← emby（消费层）
        ▲
        │
   panel（宿主层）：不参与数据链，只负责面板自身与模块注册
```

四条规则：

1. **依赖单向**：只允许 `emby → agg` 与 `聚合层 / emby → 插件` 两个方向，不得反向。
   详见 [ADR-0001](docs/adr/0001-module-layering.md)。
2. **插件与面板是独立包**：插件不 `require` 面板代码，面板也不 `require` 插件代码 ——
   两侧只通过宿主的**动作调用**通信（插件跑在子进程里，见
   [plugin-contract.md](docs/plugin-contract.md) 与 [ADR-0028](docs/adr/0028-plugin-system.md)）。
3. **跨模块的业务调用不互相 `require`**：模块之间走 `/api/**`。
4. **对插件只有一个入口**：`server/modules/plugin/host.js` 的 `call()` ——
   聚合层转源插件、emby 层转元数据 / 首页插件都从这里走。插件换实现、换端口，面板一个字都不用改。

### 例外：emby 层进程内直调聚合层

`emby` 层的聚合地址固定为本面板自身（两层同进程），且**不通过 HTTP 自调用**，而是
`require('../agg/api')` 直接调用。原因是面板门禁对 `/api/` 前缀一律要求登录，而进程内自调用不带
cookie，会得到 `401`。`/api/agg/detail` 与 `/api/agg/play` 两个端点保留给前端与外部使用，
与 emby 层共用同一套编排（`agg/api.js`），两条路径不会分叉。详见
[ADR-0002](docs/adr/0002-in-process-emby-to-agg.md)。

## 目录结构

```
server.js                 入口：注册模块 → 起服务 → 优雅关闭
server/core/              基础设施，不认识任何业务
  paths.js                路径集中定义（DATA_DIR 可由环境变量覆盖）
  branding.js             产品名的唯一来源（name / panelName / embyServerName / slug / ua）
  http.js                 sendJson / sendError / readBody / readRawBody / serveStatic
  router.js               注册式路由表：add(method, pattern, handler)，支持 :param 与 * 通配
  settings.js             模块设置：defaults 合并 → validate → 原子写
  upstream.js             上游客户端与转发；configuredUrl(消费方, 提供方)
  providers.js            元数据提供者注册表：条目 Id 的前缀 ↔ 元数据插件（见 ADR-0031）
  registry.js             模块注册表与总览自述
  logbus.js               日志总线：包装 console，透传 stdout 的同时在内存里留一份环形缓冲（面板「日志」页）
  auth.js                 面板门禁：单密码 + 会话签名
  cachedb.js              缓存通用设施：createStore（一库一句柄）+ TTL + 按字节 LRU + 统计/清空
  mirrors.js              GitHub 取源候选：公共 gh 代理前缀 + 单次请求超时（面板更新与插件库共用，见 ADR-0067）
server/modules/
  plugin/                 8 文件   /api/plugins/*
    index.js              模块清单（拉起启用中的插件、退出停全部）
    routes.js             管理面路由（装 / 卸 / 启停 / 重启 / 调用 / 日志 / webui 托管与转发）
    library.js            插件库：从独立插件仓库取清单与包（见 ADR-0035）
    bundle.js             解包与第一道 md5 校验（手动上传与插件库共用）
    host.js               插件进程托管（启动 / 停止 / 重启 / 动作调用 / 崩溃重启）
    runner.js             子进程管理（起进程、管道消息、留尾部日志、停进程）
    store.js              插件清单与包落盘（解出来的目录 → plugins/<类型>/<id>/）
    contract.js           契约常量（动作名、消息类型、超时、两道校验的清单读取）
  agg/                    10 文件  /api/agg/*
    index.js              模块清单（含测速任务的开机 / 设置变更两个钩子）
    routes.js             路由
    templates.js          模板存取与校验（data/templates/<id>.json + domains.json）
    service.js            搜索 / 详情 / 播放的编排（打分与线路过滤都在这一层）
    source-bridge.js      唯一的转接处：把源插件的回复还原成上游那份形状（status / ok / text / json）
    match.js              片名清洗与打分（挑片判据的唯一实现）
    api.js                进程内调用面：loadSites / detail / play / probeSearch
    cache.js              线路结果缓存（独立 SQLite，按天）
    site-stats.js         站点统计：测速结果（speed）+ 顺手记账（call），每站每类只留最近一次
    site-test.js          站点测速任务：每 6 小时自动一轮 / 手动开一轮
  emby/                   11 文件  /api/emby/**
    index.js              模块清单
    routes.js             端点注册（已实现端点与面板自用端点必须注册在 501 通配之前）
    service.js            各端点业务与公共函数；详情 / 播放走 agg/api.js
    meta.js               元数据域表的同步与转发（取数问元数据插件的动作）
    meta-bridge.js        面板中立的那层：条目 Id 派生与解析、图片基地址拼装、外部 id 反查
    subtitle-bridge.js    字幕插件转接处：tracks 聚合（挂进版本）/ fetch 转插件动作（按 ref 第一段路由）
    instance.js           Emby 实例注册表 + 请求级实例上下文（多实例的唯一真源）
    listener.js           每个启用中的实例在自己端口上挂一个 http 服务
    cache.js              图片索引缓存（独立 SQLite）
    db.js                 Emby 客户端账号库（内置 sqlite）
    log.js                请求日志（每请求一行，带 query 摘要与客户端标记）
    home/                 首页插件的面板侧薄适配层（不属于 Emby 客户端协议）
      index.js            媒体库 Id 形状（`viewId` / `parseViewId`）+ 条目严格归一化 +
                          行清单快照；行清单与取数都问 `home` 类型插件的动作
  panel/                  4 文件   /api/meta /api/modules /api/modules/:id/settings /api/panel/*
    index.js  routes.js  backup.js  update.js
plugins/                  插件源码（**不随面板发行、也不进版本库**，打包进独立插件仓库，见 ADR-0035）
  metadata/<id>/          元数据插件：取元数据 / 取一季分集 / 搜索 / 注册 + 自带 webui
  source/<id>/            源插件：站点清单 / 候选 / 取播放项 / 解析地址 / 站点测速 + 自带 webui
  home/<id>/              首页插件：各榜单做成客户端媒体库行 + 自带 webui 设置页
  subtitle/<id>/          字幕插件：申报字幕轨（tracks）/ 取字幕内容（fetch）+ 自带 webui 设置页
public/                   前端（原生 ES module，无构建步骤）
  index.html  app.js  style.css
  core/                   dom / api / auth / state / store / registry / shell / boot / branding / plugin-ui
  modules/agg/            templates（模板）· search（聚合搜索）· other（域 → 模板）
  modules/emby/           setup（连接设置）
  modules/panel/          overview（概览）· settings（设置）· logs（日志）
  modules/plugin/         library（插件库）· manage（插件管理）
docs/                     开发者文档（见 docs/index.md）
  adr/                    设计决策记录
tools/                    check-syntax.js（语法检查）· check-style.js（文风检查）
data/                     运行时数据（已 .gitignore，含凭证与密码哈希）
```

## 模块清单

| id | 层 | 对外前缀 | 消费的上游 | 状态 |
|---|---|---|---|---|
| `plugin` | 插件宿主 | `/api/plugins` | — | 可用（装 / 卸 / 启停 / 重启 / 动作调用 / webui 托管与转发 / 安装确认） |
| `agg` | 聚合层 | `/api/agg` | 源插件（经插件宿主） | 可用 |
| `emby` | 消费层 | `/api/emby` | 聚合层（进程内直调）、元数据与首页插件（经插件宿主） | 握手、登录（多账号，存内置 sqlite）、媒体库、条目列表与详情、搜索、图片、相似推荐、播放与下载跳转已实现；未实现的端点按 [emby-compat.md](docs/emby-compat.md) 逐个补齐；首页插件（`home` 类型）经统一插件宿主运行，见 [emby-home-plugin.md](docs/emby-home-plugin.md) |
| `panel` | 宿主层 | `/api/panel`、`/api/modules`、`/api/meta`、`/api/logs`、`/api/auth` | — | 可用（含数据备份与还原、自更新） |

## 配置与数据落点

```
data/settings/plugin.json   { confirmInstall }                       装插件前要不要那道安装确认
data/settings/emby.json     { serverName, imageKey, serverId,
                              servers, defaultIndex }
                            account / play 字段已废弃（账号在 sqlite 中）
data/settings/panel.json    { host, port, logMax, modules,
                              speedTestAuto, speedTestHours          站点测速（默认开 · 6 小时）
                              cache: { imageTtlDays, imageMaxMB,
                                       linesTtlDays, linesNeverExpire, linesMaxMB } }
data/templates/<模板 id>.json   站点集合 + 打分过滤参数 + 超时与并发
data/templates/domains.json     域 → 模板 id 的对照
data/plugins/<类型>/<id>/       插件包本体（代码 + 自带 webui + plugin.json）
data/plugins/<类型>/<id>/data/  插件自己的数据（设置与缓存）
data/cache/lines.db             线路结果缓存（面板侧）
data/emby/emby.db               Emby 客户端账号（内置 sqlite，密码只存 scrypt 哈希）
data/emby/cache.db              图片索引
```

- 默认值、校验与表单字段由**模块自己声明**（`server/modules/<id>/index.js` 的 `settings`），
  `core` 不认识任何具体键。通用端点读写：`GET/PUT/DELETE /api/modules/<id>/settings`；
  `PUT` 为局部深合并，校验不通过返回 `400`。
- **聚合层的配置不是模块设置，而是模板**（见下），`agg` 模块没有 `settings`。
  模板与域的对应关系见 [ADR-0033](docs/adr/0033-template-and-domain.md)。
- **插件自己的设置与缓存归插件**（都在它自己的 `data/` 下）；面板里的「清空插件数据」就是删这个目录。
- 早期的单文件 `data/settings.json` 仍会**搬迁一次**（原文件改名 `settings.json.migrated` 留档），
  只为不静默丢弃老部署留下的文件；全新安装不涉及。

## 模板与域

- **模板** = 一份配置数据文件，内容是"选中的站点 + 打分过滤参数 + 超时与并发"，有 id，一份一个文件。
- **域** = 一组内容偏好（例如某个元数据插件注册的域），`域 → 模板` 一对一，一个模板可被多个域共用。
- **没配模板的域如实为空**：不猜、不挑一个兜底，调用方据此如实回空并点名。
- 测速的**开关与间隔**在面板设置（它量的是这台机器与这条网络，与内容偏好无关）；
  测速的**结果**也是面板级共享的一份，不跟模板走。

## 数据流

**客户端播放链路**

```
Emby 客户端 → /api/emby/**（emby 层，token 校验）
           → agg/api.js（进程内）→ 聚合层搜索与打分
           → 源插件（宿主动作调用）→ 源实例 → 源站
```

**面板搜索链路**

```
浏览器 → /api/agg/search（聚合层，面板门禁）
       → 源插件（宿主动作调用）→ 源实例 → 源站
```

**元数据链路**

```
emby 层 → emby/meta.js → 元数据插件（宿主动作调用）→ 上游元数据服务
```

两条聚合链路共用 `agg/service.js` 与 `agg/match.js`，因此「面板里看到的」与「客户端拿到的」是同一套判据。