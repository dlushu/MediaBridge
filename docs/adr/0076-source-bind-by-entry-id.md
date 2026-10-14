# ADR-0076 直绑元数据域条目 Id：搜索精度差的站点按 entryId 直连，失败回落按名搜

- 状态：已采纳
- 相关：[0003](0003-local-title-scoring.md)（本地打分，不做反查）·
  [0033](0033-template-and-domain.md)（打分与过滤留在面板）·
  [0059](0059-source-certified-candidate.md)（`vod_exact`：同类的"声明性标注"）·
  [0027](0027-extra-fetch-only-when-zero.md)（接续补打）·
  [0002](0002-in-process-emby-to-agg.md)（emby 进程内直调聚合层）·
  [service.js](../../server/modules/agg/service.js)（`aggregateDetail` 直绑分支）·
  [source-bridge.js](../../server/modules/agg/source-bridge.js)（站点清单带 `binds`、`vod_id` 回传）·
  [service.js](../../server/modules/emby/service.js)（`getItem` 透传坐标）
- 契约：插件仓库 `MediaBridge-plugin-devkit` 的 `framework/contracts/contract-source.md`
  「直绑元数据域条目 Id（`binds`）」（面板是消费方，本仓库不改契约、也不留副本，见 [AGENTS](../../AGENTS.md)）

## 背景

聚合层取详情只有一条**通用兜底**：**按名搜**（`search` → `match.js` 打分）再取命中项的详情
（[0003](0003-local-title-scoring.md)）。它对聚合站那类"返回一堆候选、要挑"的源是对的，
但**对搜索精度极差的站点天然失效**：

- **典型是 Pornhub**：实测对任意查询都回一批泛化结果，**首条从不是目标作品**，
  按名搜必然命中 0 ⇒ 这些条目的版本列表永远是空的（在 Emby 里表现为"条目在、点开没有版本"）。
- **更麻烦的是失败与"没搜到"分不开**：站点把"搜索页 404"当作上游错误抛上来时，
  面板无从区分"这个站没有这部片"与"这个站坏了"。修了插件侧（404 归一为空列表）也救不回精度。

问题的根子是：**用户点的是"这部片"（元数据域的条目），而"这部片"在源站的编号（entryId）面板已经知道**
（条目 Id 就是面板自己发的，域 + entryId 都在里面）——**有坐标却只能按名字重新猜一遍**。

## 决定

**源插件在 `plugin.json` 里声明 `binds`（域 id 数组），即"本插件认领某个元数据域的条目 Id"。
面板见到声明，就把该域条目的 entryId **直接交给该插件 `detail`**，跳过按名搜索。**

- **声明位置**：`plugin.json` 的 `binds`（形状同 `domain`），**包级、对该插件每个站点生效**。
  例：`"binds": ["pornhub"]`。只有 `source` 类型用得到（别的类型声明直接拒）。
- **面板取数优先级（契约规定，面板不得自由发挥）**：
  1. **先直绑**：从条目 Id 解出域 + entryId，对**所有声明了该域 `binds`** 的源插件以
     `detail({ id: entryId })` 直调（多个插件声明同一域 ⇒ 都试，各算一个版本）。
  2. **成功即用**：`detail` 回了可用线路的站**不再执行它的按名搜索**（省一发扇出）。
  3. **失败必须回落**：`detail` 失败（抛错 / 回 `error` / `target` 为 `null` / `items` 为空）时
     **回落**到该站原有的 `search` → 打分路径，判据 / 分数线 / `maxItems` / `maxSources` 一律不变。
  4. **二选一不双算**：直绑成功与按名搜**只对同一个站执行其一**。
  - 仅当条目 Id 解不出域 / entryId 时，面板跳过直绑、直接走按名搜（没坐标可直传）。
- **`vod_id` 回传**：直绑调用 `detail` 时，插件须在出参**资源级**回一个 `vod_id`（形状自定，
  通常就是源站自己的编号）；面板**不解释、不校验**它，原样记入 `ProviderIds` 并编进播放 `ref`。
  插件必须保证它**稳定、可在后续 `play` 阶段复用**（给错就是绑错）。
- **落点**：面板侧在 [agg/service.js](../../server/modules/agg/service.js) 的 `aggregateDetail`；
  站点清单的 `binds` 由 [source-bridge.js](../../server/modules/agg/source-bridge.js) 从插件状态带过来；
  emby 链的 `entryId` 由 `getItem` 透传（web / 出口插件只给 `name`，走不到直绑）。

## 理由

- **把确定性锚在"条目 Id 本身"上**：直绑时"这是不是目标作品"由**元数据域已确认的 entryId** 锚定，
  面板不再打分 —— 不存在"猜错片"的空间，也不依赖搜索精度。这是 [0003](0003-local-title-scoring.md)
  打分判据之外的**第二条取数通道**，两者只在"同一条目"上二选一。
- **这是插件的「声明性标注」，判据不分叉**（与 [0059](0059-source-certified-candidate.md) 的
  `vod_exact`、[0042](0042-auth-line-byte-relay.md) 的 `playVia` 同性质）：`binds` 只声明
  "本插件能直接吃下这个域的 entryId"，**怎么用仍由面板定** —— 先直绑、失败回落、不双算都由面板执行，
  "这是不是目标作品"的判据（`match.js`）仍只有面板一处实现。
- **回落是契约义务**：直绑只是**优先尝试**，不是取代。声明了 `binds` 的站若某条目直绑失败，
  面板**必须**回到该站原来的按名搜路径 —— 否则会把"声明即只走直绑、失败即放弃"的退化行为引入，
  比不声明更糟。
- **不扩大面板的启发式**：另一条路是让面板对某些站点开特例（认 PH 的搜索特性），
  但那需要面板认识各站协议（站点协议千差万别，[0033](0033-template-and-domain.md) 明确不让面板去认识）。
  `binds` 把这件事交回**最知道的插件**。

## 备选

- **面板给搜索精度差的站点开特例**：面板要去认识各站协议，判据分叉、且每来一个新站都要改面板。**否**。
- **插件把候选改写成面板会认的名字**：等于插件**编数据**（[0008](0008-no-fabricated-data.md)），
  且改写后的名字仍可能被面板闸门再拒一次。**否**。
- **插件自己挑最终结果、只回一条**：判据分叉，违背 [0033](0033-template-and-domain.md)。**否**。
- **声明了 `binds` 就只走直绑、失败即放弃**：把"乐观声明"当成"唯一通道"，
  一个条目直绑失败就整条不可播。**否**，回落是义务。
- **让直绑绕过线路过滤 / 分数线 / `maxItems`**：直绑给的是**线路**不是候选，
  分数线 / `maxItems` 本就管不到它；但**产出前的线路过滤（`applyLineFilter`）仍然生效**
  （与按名搜共用同一口径，见 [0025](0025-line-filter-in-usable-judgement.md)）。

## 后果

- **诊断新增一档**：`stats.bind = { sites, usable }`（声明该域的站数 / 直绑拿到可用线路的站数），
  日志一行「agg 直绑「域/entryId」：N 个站 → M 个拿到可用线路（其余回落按名搜）」。
  `picked.matchedBy` 增加取值 `bind`（代表值来自直绑，全直绑时没有搜索命中）。
- **直绑成功的站没有搜索候选**：该站的代表条目 `sameNameCount` / `variantCount` 记 0、
  `score` 为 `null` —— 它不经过打分，这是有意如实标注。
- **`vod_id` 落点归一**：插件回在 `detail` 出参**顶层**的 `vod_id`，面板在 `fetchDetailOnce`
  归一进 `detail.vodId`（下游读的一直是后者）；插件本就在 `detail` 里给了 `vodId` 的不覆盖。
- **emby 链是直绑的唯一入口**：`getItem` 把条目 Id 里解出的 `domain` + `entryId` 一起交给
  `agg.detail`；web 聚合搜索与出口插件只给 `name`，条目身份解不出 → 自然跳过直绑，行为不变。
- **详情快照 key 加一格**：有 `entryId` 时 key 追加 `域/entryId`（条目级身份）；
  非直绑调用这一格为空、key 与从前**逐字一致**，不会无故失效。
- **`binds` 声明即承诺**：面板见到声明就**无条件**先直绑。声明了却常失败会白烧一发直绑扇出 ——
  拿不准就别声明。`binds` 落在 `plugin.json`、随安装 / 更新写进插件清单（`registry.json`）：
  **声明了 `binds` 的插件版本必须被（重新）安装或更新**，面板才能在运行时看到它。
- **契约同步面**：字段与语义写在插件仓库 `framework/contracts/contract-source.md`；
  本仓库改 [develop.md](../develop.md) 的接口表、「挑片判据」一节与
  [CHANGELOG.md](../../CHANGELOG.md)。
