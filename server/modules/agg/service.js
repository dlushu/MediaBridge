'use strict';
/**
 * 聚合层服务：一个请求并发打**多个源**的多个站源，按站点顺序拼接
 *
 * ⚠️ **取数一律走 `source-bridge.js`**（转给源插件的动作）：本层不再认识 `/search`、`/detail`、
 * `/play` 这些路径，也不再知道源的地址与端口 —— 站点身份是 `插件 id / 实例 id`。
 * 转接回来的形状与"上游 HTTP 响应"一致，所以下面这套判据（404 = 没搜到、超时单独报、
 * 逐站记账）一个字都没改。
 *
 * 协议细节（`$$$` / `#` / `$`）留在本层，消费方拿到的是「(源, 站点) → 原样输出」。
 *
 * **多源**：站点身份是 `(source, key)` 这一对 ——
 *   站点 key 只在**各自实例内**唯一，两个实例都有 `nodejs_muou` 是常事，所以任何
 *   "按 key 对齐/去重/排序"的地方都必须带上 source（否则会静默互相覆盖）。
 *   对外形状里 source 与 key 是**两个字段**；只有内部做 Map 键时才拼成一个复合键。
 */
const bridge = require('./source-bridge');
const match = require('./match'); // 片名清洗 + 打分（"这是不是目标作品"的唯一判据）
const normName = match.normName; // 片名归一化（跨站同名比较用；它属于打分知识，见 match.js）
const siteStats = require('./site-stats'); // 顺手记测速统计（见那个文件顶部）

/** 内部复合键：`源 + \\u0001 + 站点key`（用控制字符分隔，配置里不可能出现，零歧义） */
const sid = (source, key) => String(source || '') + '\u0001' + String(key || '');

/** 源清单 → id 查表；找不到就抛（说明站点清单与源清单不一致） */
function sourceMap(sources) {
  const m = new Map();
  for (const s of sources || []) m.set(s.id, s);
  return m;
}

function needSource(byId, id) {
  const s = byId.get(id);
  if (!s) throw new Error(`源清单里没有 ${id}（可能已被删除，刷新一下站点清单）`);
  return s;
}

/**
 * 打分参数：调用方给的优先，没给就用**这套模板**的参数。
 *
 * ⚠️ 模板参数由域决定（`templates.templateFor(domain).params`，见 docs/adr/0033）——
 * 所以这里的 `params` 是必传的：调用方必须先把域解析成模板，再进来。
 */
function matchDefaults(params, opts) {
  const cfg = params || {};
  const o = opts || {};
  const num = (v, d) => (v === undefined || v === null || v === '' ? d : Number(v));
  return {
    minScore: num(o.minScore, num(cfg.matchMinScore, 0.85)),
    maxItems: num(o.maxItems, num(cfg.matchMaxItems, 8)),
    unmatchedMax: num(o.unmatchedMax, 20),
    /* K 的兜底是 0（与 `agg.json` 的默认一致）：取不到设置时**不补打**，
     * 宁可少几条版本，也不要因为读不到配置而按 8 条去烧上游 */
    extraK: num(o.extraK, num(cfg.matchExtraK, 0)),
  };
}

/**
 * 单站超时：**设置里是秒、内部一律毫秒**（两层之间传的就是毫秒）。
 *
 * 三个超时**刻意分开**（原来只有一项 `timeoutMs`）：
 *   · `searchTimeoutMs` —— 搜索 / 首次 `/init`：这一发本来就该快，默认 5 秒；
 *   · `detailTimeoutMs` —— 取详情：**剧集动辄几十上百集**（响应体大、上游拼装慢），
 *     与搜索共用一个超时会让"目录里内容多的那种"一律记成超时 / 定位不到，默认 10 秒；
 *   · `playTimeoutMs` —— 取播放地址：**网盘类线路要串行打好几发**（登录 → 查已保存 → 提交离线下载
 *     → 等完成 → 取直链），跟"搜一下就回"完全不是一个量级。仍和搜索共用 5 秒档的那阵子，
 *     这类线路一律在 5 秒处被 abort，客户端拿到 502 就原样重试、再走一遍整条链 —— 越重试越慢。
 * 上限与模板保存时的校验一致（60s / 120s），这里再兜一次 —— 手改模板文件也不至于把请求挂死。
 */
const searchTimeoutMs = (cfg) => Math.min(60000, Math.max(1000, Math.round((Number((cfg || {}).timeoutSec) || 5) * 1000)));
const detailTimeoutMs = (cfg) => Math.min(120000, Math.max(1000, Math.round((Number((cfg || {}).detailTimeoutSec) || 10) * 1000)));
const playTimeoutMs = (cfg) => Math.min(120000, Math.max(1000, Math.round((Number((cfg || {}).playTimeoutSec) || 25) * 1000)));

const round3 = (n) => Math.round(Number(n || 0) * 1000) / 1000;

/**
 * 「先 POST /init 再搜」的记账。
 *
 * ⚠️ **init 已搬进源插件**（它属于源协议的内部逻辑，见 docs/plugin-contract.md 的 contract-source.md）：
 * 插件按「实例地址 + 站点」记住，重启换端口后自然重来。面板这边只把插件回的
 * `initCalled` 照实记进结果里（诊断用，不参与打分）—— 原来那份 `initialized` 集合已删。
 */

async function searchSite(source, site, wd, page, timeoutMs) {
  const t0 = Date.now();
  const r = {
    source: source.id, // 多源：结果里必须带上是哪个源
    key: site.key,
    name: site.name,
    api: site.api,
    group: site.group,
    page: null,
    total: null,
    ok: false,
    ms: 0,
    count: 0,
    list: [],
    error: null,
    noResultBy: null, // 有值 = "无结果"是由站源的哪种表达推出来的（如 http-404），见 searchSite
    response: null, // 站源 /search 的原样响应体
    responseStatus: null,
    request: { action: 'search', source: source.id, site: site.key, body: { wd, page: String(page) } },
    initRequest: { action: 'search 内先打 init', source: source.id, site: site.key },
    initCalled: false,
  };
  try {
    const res = await bridge.search(source.id, { key: site.key, wd, page, timeoutMs });
    r.initCalled = !!res.initCalled;
    r.responseStatus = res.status;

    /* 站源表达「没搜到」的方式**不止一种**，这里把两种都归成**无结果**（`ok: true` + 空列表）：
     *   ① 规范的：HTTP 200 + `list` 为空；
     *   ② **HTTP 404** —— 一部分站就是这么表达的（实测：同一部片，`nodejs_wogg`
     *      回 200 空、`nodejs_muou` / `nodejs_huban` 回 404；而拿站里**确实有**的片名去搜它们
     *      又是 200，说明站没坏，404 就是它的"没有"）。
     * 不归的话，404 会被当成"站点故障"一路记进 `sites.*.error` 与面板日志（`搜了 3 站…：HTTP 404`），
     * 把"源里没这部片"误报成"出错"。
     * **但仍然留痕**：`responseStatus` 与 `noResultBy` 都记着，想区分"真的站点故障"还有据可查
     * （站点若真下线，多站会一起哑，而不会只有"没搜到"这一个码）。 */
    if (res.status === 404) {
      r.ok = true;
      r.noResultBy = 'http-404';
      r.response = res.json && typeof res.json === 'object' ? res.json : null;
    } else {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = res.json;
      if (!j || typeof j !== 'object') throw new Error('返回不是 JSON');
      r.response = j;
      r.list = j.list || [];
      r.count = r.list.length;
      r.page = j.page;
      r.total = j.total;
      r.ok = true;
    }
  } catch (e) {
    r.error = e && e.name === 'AbortError' ? `超时(${timeoutMs}ms)` : String((e && e.message) || e);
  }
  r.ms = Date.now() - t0;
  /* **顺手记账**（不额外打请求 —— 这个 ms 本来就在结果里；失败也记，超时那下最有用）：
   * 只用于界面诊断（单元格 title 里那句"最近一次真实搜索"）。
   * ⚠️ 它写 `call` 槽、口径跟着业务走（404 = 无结果，不算失败）；"要不要跳过这个站"看的是
   * 测速那一槽（`speed.search`），两者分开存 —— 见 site-stats.js 顶部。 */
  siteStats.recordCall(r.source, r.key, 'search', r.ms, r.ok, r.error);
  return r;
}

/**
 * 并发池：一次请求打多个源的多个站源，单站/单源失败不影响整体。
 * `sites` 里每一项都必须带 `source`（源 id）—— 由调用方（routes / agg.sites）打好。
 * 返回的 `sites` 是**数组**（每项带 source），不再是「key → entry」的映射：
 * 多源下同名 key 会撞，映射形状没法表达"两条不同的站点"。
 */
/**
 * 并发搜多个站的 `/search`，**并顺手打分**（打分是这一步的职责）。
 *
 * `want`：`{ name, year, season, episode }` —— 打分要的"目标片"。`name` 缺省用 `wd`。
 * `matchOptions`：`{ minScore, maxItems, unmatchedMax }` —— 缺省读 `agg.json` 的设置
 *   （`matchMinScore` / `matchMaxItems`）。`minScore = 0` 就是**不做分数线筛选**、只按分数排名取前 N。
 *
 * 打分口径与两道闸门见 `match.js` 顶部。结果里：
 *   · 每个条目多出 `score` / `matched` / `matchReason`（web 要显示"为什么它进了/没进"）；
 *   · 顶层多出 `matched` / `unmatched`（失败也回，带原因）+ `stats.match`（各桶计数）。
 */
async function aggregateSearch(sources, sites, { wd, page = '1', timeoutMs, concurrency, want, matchOptions, params } = {}) {
  if (!wd || !String(wd).trim()) throw new Error('请提供搜索关键字 wd');
  const cfg = params || {};
  const t = Math.max(1000, Number(timeoutMs) || searchTimeoutMs(cfg));
  const c = Math.max(1, Math.min(32, Number(concurrency) || cfg.concurrency || 8));
  /* 「最近一次测速失败的站要不要先跳过」——**按模板开关**（`skipFailedSites`，缺省开，
   * 即原有的行为；关掉就照打，用来确认那几个站现在到底行不行）。 */
  const skipFailed = cfg.skipFailedSites !== false;
  const byId = sourceMap(sources);
  const queue = (sites || []).slice();
  const results = [];
  const t0 = Date.now();
  let cursor = 0;
  let skipped = 0;

  await Promise.all(
    new Array(Math.min(c, queue.length || 1)).fill(0).map(async () => {
      for (;;) {
        const i = cursor++;
        if (i >= queue.length) return;
        const site = queue[i];
        /* **最近一次测速失败**的站：这几轮**跳过**，不打它 —— 不动勾选，站还在清单里；
         * 下一轮测速（或点该站的「测速」）成功即自动恢复。判据见 site-stats.shouldSkip。
         * 这一条按模板开关（`skipFailedSites`）走：关掉就照打。 */
        const skip = skipFailed ? siteStats.shouldSkip(site.source, site.key) : null;
        if (skip) {
          skipped += 1;
          results.push({
            source: site.source,
            key: site.key,
            name: site.name,
            api: site.api,
            group: site.group,
            page: null,
            total: null,
            ok: false,
            skipped: true,
            ms: 0,
            count: 0,
            list: [],
            error: `最近一次测速失败（${skip.error}），先跳过 —— 下一轮测速会自动重试，也可以点该站的「测速」立刻复测`,
          });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const r = await searchSite(needSource(byId, site.source), site, String(wd).trim(), String(page), t);
        results.push(r);
      }
    })
  );
  if (skipped) {
    console.log(
      `  · agg 搜索跳过了 ${skipped} 个"最近一次测速失败"的站点（不打它们，勾选不变；下一轮测速会自动重试）`
    );
  }

  /* 按 `(源, 站点)` 对齐回 queue 顺序 —— **不能只按 key**（跨源同名会取错） */
  const ordered = queue.map((site) => results.find((r) => r.source === site.source && r.key === site.key)).filter(Boolean);

  const outSites = [];
  const nameCount = new Map();
  let totalItems = 0;
  for (const r of ordered) {
    /* `sourceName` 一起给：多源下同名站点是常事（两个源都叫"木偶"），前端分组标题只显示站名时
     * 根本分不清是哪个源的。 */
    const owner = byId.get(r.source);
    const entry = {
      source: r.source,
      sourceName: (owner && owner.name) || '',
      key: r.key,
      name: r.name,
      api: r.api,
      ok: r.ok,
      ms: r.ms,
    };
    if (r.ok) {
      entry.data = r.response != null ? r.response : { page: r.page, total: r.total, list: r.list };
      if (r.noResultBy) entry.noResultBy = r.noResultBy; // "无结果"是哪来的（如 http-404），诊断用
      totalItems += r.count;
      for (const it of r.list || []) {
        const n = normName(it.vod_name);
        nameCount.set(n, (nameCount.get(n) || 0) + 1);
      }
    } else {
      entry.error = r.error;
      /* `skipped` = 这次**没打它**（最近一次测速失败，见上面那段）—— 界面靠这个把"跳过"与"这次失败"分开说 */
      if (r.skipped) entry.skipped = true;
      if (r.responseStatus && r.responseStatus !== 200) entry.http = r.responseStatus;
    }
    outSites.push(entry);
  }
  let duplicatedItems = 0;
  for (const n of nameCount.values()) if (n > 1) duplicatedItems += n;

  /* ---- 打分：**把各站的条目摊平，一次算完**（跨站排序 / 同站去重 / 卡 N 都得全局看）----
   * 条目上挂 `source` / `siteKey` / `siteName` 是为了让打分器知道"这是哪个站的"
   * （同站同名要去重，跨站不能），返回给前端的失败项也因此能自己说明来处。 */
  const flat = [];
  for (const e of outSites) {
    for (const it of (e.data && e.data.list) || []) {
      it.source = e.source;
      it.siteKey = e.key;
      it.siteName = e.name;
      it.sourceName = e.sourceName || '';
      flat.push(it);
    }
  }
  const picked = match.select(flat, { name: (want && want.name) || wd, ...(want || {}) }, matchDefaults(params, matchOptions));
  /* 每条都写回分数与去留（`all` 不截断）—— web 上逐条显示"命中/没进 + 为什么"靠的就是这两个字段 */
  for (const a of picked.all) {
    a.item.score = round3(a.score);
    a.item.matched = !!a.hit;
    a.item.matchReason = a.reason;
  }

  return {
    wd: String(wd).trim(),
    page: String(page),
    elapsedMs: Date.now() - t0,
    sites: outSites,
    /* 命中的条目（≤ N，按分数降序）与没进的（带原因，供 web 展示；上限 `unmatchedMax`） */
    matched: picked.matched.map((m) => m.item),
    unmatched: picked.unmatched.map((u) => u.item),
    /* 内部用：过关的全量排名（`aggregateDetail` 的"接续补打"要按它往下走）。
     * ⚠️ 它是**同一批条目对象的引用**，别直接回给前端（响应会大一倍）—— 路由里 `delete out.ranked`。 */
    ranked: (picked.ranked || []).map((x) => x.item),
    match: picked.counts,
    stats: {
      requested: queue.length,
      ok: ordered.filter((r) => r.ok).length,
      failed: ordered.filter((r) => !r.ok && !r.skipped).length,
      /* 这次**没打**的（最近一次测速失败，见 shouldSkip）—— 与"这次失败"分开报，别混成一个数 */
      skipped: ordered.filter((r) => r.skipped).length,
      empty: ordered.filter((r) => r.ok && r.count === 0).length,
      totalItems,
      duplicatedItems,
      timeoutMs: t,
      concurrency: c,
      sources: new Set(queue.map((s) => s.source)).size,
    },
  };
}

/**
 * **线路过滤**（模板参数，一个正则，**只匹配线路名** `line.flag`）—— 读它的实现只此一处。
 *
 * 三处用途，必须是同一套判据：
 *   ① **产出**：`aggregateDetail` 返回前，把不匹配的线路从 `detail.lines` 里去掉
 *      （`applyLineFilter`）—— 这是"客户端能看到什么"的**唯一来源**，emby 与出口插件
 *      （FW/Rex）拿到的就是滤过的那份，谁都不必自己再实现一遍规则（见 docs/develop.md
 *      的「能力的设计不参照已有插件角色」：规则属于模板，线路是聚合层产出的东西）；
 *   ② 本层判断"这条详情对客户端有没有用"时（`detailUsable` 的 `re` 参数，见 ADR-0025）——
 *      不然就会出现"聚合以为这条有用、客户端却列出 0 条"（实测踩过：4 条线路全被规则滤掉，
 *      客户端 0 个版本，而快照照样存了下来）；
 *   ③ 详情快照的 key（`api.js` 的 `cacheKey`）：规则变了就该重算，不能命中按旧规则算的结论。
 *
 * ⚠️ 语义不变：**只影响"列出来的版本"，不影响播放**（`resolveStream` 按版本 Id 回查，不查这个列表）。
 * 规则写错时**不抛**（保存时已校验；这里是运行时兜底）：`re:null + invalid:true`，调用方按"不过滤"走。
 */
function lineFilter(params) {
  const raw = String(((params || {}).lineFilter) || '').trim();
  if (!raw) return { raw: '', re: null, invalid: false };
  try {
    return { raw, re: new RegExp(raw, 'i'), invalid: false };
  } catch {
    return { raw, re: null, invalid: true };
  }
}

/**
 * 「这条线路能不能被客户端列出来」—— 与 emby 层 `getItem` 里那处 `continue` **是同一个判据**
 *（只在这里实现一次，改一处就得改另一处）：
 *
 *   `const targets = movie ? line.items || [] : line.target ? [line.target] : [];`
 *   `if (!targets.length) continue;`                             没有可播目标 → 不进版本列表
 *
 * `re` = 编译好的线路过滤正则（`null` = 不过滤）。**这里是在"账"上判的**：`detailUsable`
 * 拿它算"过滤后还剩几条能用的"（`usableItems`，决定要不要接续补打），这时 `lines` 还是全量 ——
 * 产出上那次过滤在 `applyLineFilter`，跑在这一步之后。
 */
function lineVisible(line, need, re) {
  if (re && !re.test(String((line && line.flag) || ''))) return false;
  if (need === 'item') return ((line && line.items) || []).length > 0;
  return !need || !!(line && line.target);
}

/**
 * **一条条目（一个 `vod_id`）取回来的详情能不能用** —— 这是"有没有拿到一条能用的"里那"一条"的判据：
 *   · 必须有线路；
 *   · 剧集（`need === true`，即请求带了集号）：**至少要有一条线路定位到了这一集** ——
 *     只有线路、却定位不到这一集的那种，Emby 那边会因为"点了必然 404"把它过滤掉
 *     （`emby/service.js` 的 `if (!targets.length) continue`），等于白打一次 `/detail`
 *     （实测：`斗破苍穹年番` 那条 10 条线路里有 6 条能定位、虎斑那条 0 条）；
 *   · 电影（`need === 'item'`）：**至少要有一条线路带播放项**（同一条理由）。
 *
 * `re` = 线路过滤正则（`lineFilter().re`）。**带上它，"能用"就等于"客户端真能列出至少一条版本"**
 * —— 这正是"接续补打还要不要继续"与"这份快照值不值得存"的判据（ADR-0025）：
 * 规则把那几条线路全滤掉的条目，对客户端是 0 个版本，不该占着名额、也不该被存成快照。
 *
 * ⚠️ 计数单位是**条目**，不是站点、也不是线路：一个站可以有多条条目（代表 + 变体），
 * 每一条都可能是"能用"的那一条（实测就是靠变体才拿到 E211 的）。
 */
function detailUsable(d, need, re) {
  const lines = (d && d.lines) || [];
  if (!lines.length) return false;
  return lines.some((l) => lineVisible(l, need, re));
}

/**
 * 把线路过滤**落到产出上**：规则不匹配的线路直接从 `detail.lines` 里去掉。
 *
 * 为什么放在这一层：规则是**模板**的一部分、线路是**聚合层产出**的东西 —— 在这里滤一次，
 * 后面谁都拿到同一份结果（emby、出口插件）。反过来"各客户端拼版本列表时自己滤"会让同一份
 * 模板在不同客户端有两种口径，且每接一个客户端就得再实现一遍（见 docs/develop.md 的
 * 「能力的设计不参照已有插件角色」）。
 *
 * 只动 `lines`：`target` / `items` 本来就挂在各自线路的对象上。整站的线路被滤空时那条站项
 * **留着**（如实为空、不回退成全部 —— 否则规则写错根本发现不了）。
 *
 * 返回**过滤前后的条数**，供日志与诊断字段说清"源里多少条 → 留下多少条"。
 */
function filterDetailLines(detail, re) {
  const lines = (detail && detail.lines) || [];
  if (!re || !lines.length) return { before: lines.length, kept: lines.length };
  const kept = lines.filter((l) => re.test(String((l && l.flag) || '')));
  detail.lines = kept;
  return { before: lines.length, kept: kept.length };
}

/**
 * 对一份聚合结果里**所有条目**跑一遍线路过滤，并把账记进 `out.stats.lineFilter`。
 *
 * 一个站可能有多条条目：代表在 `site.detail`，同片变体在 `site.variants[].detail` —— 各有各的
 * `lines`，**都要滤**（变体的线路同样会进客户端的版本列表）。
 */
function applyLineFilter(out, lf) {
  const st = { raw: lf.raw, invalid: lf.invalid, before: 0, kept: 0 };
  for (const site of out.sites || []) {
    for (const item of [site].concat(site.variants || [])) {
      const r = filterDetailLines(item.detail, lf.re);
      st.before += r.before;
      st.kept += r.kept;
    }
  }
  out.stats.lineFilter = st;
}

/* ============================================================
 * 详情 / 播放：把站源协议（$$$ / # / $、url 字符串或数组、parse）
 * 全留在本层，对外只给「线路 → 选集」和「归一化后的播放地址」。
 * ============================================================ */

/** 站点清单里按 `(source, key)` 找站点（play/detail 只要这两个就能反查该站 api 前缀） */
function siteByKey(sites, source, key) {
  const s = String(source || '').trim();
  const k = String(key || '').trim();
  return (sites || []).find((x) => x.source === s && x.key === k) || null;
}

/**
 * 参与聚合的站点：按 keys 白名单过滤，再按 order 排序。
 * **顺序就是 picked 的优先级**（同名时先取排前面的站）—— search / detail 共用这一处。
 * `keys` / `cfg.enabled` / `cfg.order` 里都是 `{source, key}` 对象（多源下不能只比 key）。
 */
function selectSites(sites, cfg = {}, keys) {
  const wanted = Array.isArray(keys) && keys.length ? keys : cfg.enabled || [];
  const order = cfg.order || [];
  const wantedSet = new Set(wanted.map((x) => sid(x && x.source, x && x.key)));
  const orderIdx = new Map(order.map((x, i) => [sid(x && x.source, x && x.key), i]));
  return (sites || [])
    .filter((x) => wantedSet.has(sid(x.source, x.key)))
    .sort((a, b) => {
      const ia = orderIdx.has(sid(a.source, a.key)) ? orderIdx.get(sid(a.source, a.key)) : 9999;
      const ib = orderIdx.has(sid(b.source, b.key)) ? orderIdx.get(sid(b.source, b.key)) : 9999;
      return ia - ib;
    });
}

/** 按要求过滤站点：`keys` 白名单（`{source,key}[]`）/ `source + site` 单点 */
function pickSites(sites, { keys, site, source } = {}) {
  if (site) return (sites || []).filter((s) => s.key === site && (source === undefined || s.source === source));
  if (Array.isArray(keys) && keys.length) {
    const set = new Set(keys.map((x) => sid(x && x.source, x && x.key)));
    return (sites || []).filter((s) => set.has(sid(s.source, s.key)));
  }
  return sites || [];
}

/**
 * 从**集名**里读源自己标注的规格 —— **只认明确写法，读不出就是空**（不猜、不推断）。
 * 例：`[1.8GB]Lanterns.2026.S01E01.2160p.MAX.WEB-DL.H.265.DV.HDR.DDP5.1.Atmos.mkv【L 绿灯军团】`
 *   → { container:'mkv', sizeBytes:1932735283, width:3840, height:2160, videoCodec:'hevc',
 *       videoRange:'DOVI', audioCodec:'eac3', channelLayout:'5.1', channels:6, atmos:true }
 *
 * 用途：消费方要拿它填 Emby 的 MediaSource / MediaStreams（客户端据此决定能不能直连播放）。
 * 注意这是**源标的元信息**，精度有限（尤其体积是近似值），缺失一律给空值而不是补默认值。
 *
 * 覆盖字段（源标题里能读到的都读）：容器 / 体积 / 分辨率 / 视频编码 / 档位 / 位深 /
 * 帧率 / 动态范围 / 音频编码 / 声道布局 / Atmos。**帧率、位深、Profile 这类只在源明确写了才有**
 * （`60fps`、`10bit`、`Main10`）—— 想要"一定有"就得真去探测文件（ffprobe），本项目**不做**探测
 * （源是远程流，为元数据去读它的头部是另一条链路的事，见 docs）。
 */
function parseEpisodeMeta(raw) {
  const s = String(raw || '');
  const out = {
    container: '',
    sizeBytes: 0,
    width: 0,
    height: 0,
    videoCodec: '',
    videoProfile: '',
    bitDepth: 0,
    frameRate: 0,
    videoRange: '',
    audioCodec: '',
    channelLayout: '',
    channels: 0,
    atmos: false,
  };

  const ext = /\.(mkv|mp4|avi|ts|m2ts|flv|mov|webm|rmvb)\b/i.exec(s);
  if (ext) out.container = ext[1].toLowerCase();

  const size = /\[?\s*(\d+(?:\.\d+)?)\s*(GB|G|MB|M)\s*\]?/i.exec(s);
  if (size) {
    const n = Number(size[1]);
    out.sizeBytes = Math.round(n * (/^G/i.test(size[2]) ? 1024 ** 3 : 1024 ** 2));
  }

  const res = /\b(8K|4K|2160p|1080p|720p|480p)\b/i.exec(s);
  const size4k = { '8k': [7680, 4320], '4k': [3840, 2160], '2160p': [3840, 2160], '1080p': [1920, 1080], '720p': [1280, 720], '480p': [854, 480] };
  if (res) {
    const wh = size4k[res[1].toLowerCase()];
    if (wh) {
      out.width = wh[0];
      out.height = wh[1];
    }
  }

  if (/\b(h\.?265|hevc|x265)\b/i.test(s)) out.videoCodec = 'hevc';
  else if (/\b(h\.?264|avc|x264)\b/i.test(s)) out.videoCodec = 'h264';
  else if (/\bav1\b/i.test(s)) out.videoCodec = 'av1';

  /* 编码档位：只认 `Main10` / `Main 10` / `High 10` 这三个明确写法（裸的 `main` 太泛，不认） */
  if (/\bmain\s?10\b/i.test(s)) out.videoProfile = 'Main 10';
  else if (/\bhigh\s?10\b/i.test(s)) out.videoProfile = 'High 10';

  /* 位深：`10bit` / `10-bit` / `8 bit`（写成 `Main10` 不算，那是档位不是位深） */
  const bits = /\b(\d{1,2})\s*-?\s?bit\b/i.exec(s);
  if (bits) out.bitDepth = Number(bits[1]);

  /* 帧率：只认带单位的写法（`60fps` / `23.976fps`）—— 裸的 `23.976` 不认，那串数字太容易误伤 */
  const fps = /\b(\d{2,3}(?:\.\d+)?)\s*fps\b/i.exec(s);
  if (fps) out.frameRate = Number(fps[1]);

  /* 注意 `DDP5.1` 这种写法：`ddp` 后面紧跟数字，用 \b 词边界匹配不到 → 必须用前瞻 */
  if (/\b(eac3|e-ac-3|dd\+|ddp)(?=[.\d\s]|$)/i.test(s)) out.audioCodec = 'eac3';
  else if (/\b(truehd|dts-?hd)\b/i.test(s)) out.audioCodec = 'truehd';
  else if (/\bdts\b/i.test(s)) out.audioCodec = 'dts';
  else if (/\bac3\b/i.test(s)) out.audioCodec = 'ac3';
  else if (/\baac\b/i.test(s)) out.audioCodec = 'aac';
  else if (/\bflac\b/i.test(s)) out.audioCodec = 'flac';

  /* 声道布局（`5.1` / `7.1` / `2.0`）：**只看后面是不是分隔符**，不看前面 ——
   * `DDP5.1` 的 `5.1` 前面紧贴字母，要求"前面也是分隔符"会漏；而 `H.265` 里的 `2.6` 由前瞻挡掉
   * （后面是 `5`，不是分隔符）。5.1 → 6 声道、7.1 → 8、2.0 → 2。 */
  const ch = /([1-8]\.[0-9])(?=[.\s\])\-]|$)/.exec(s);
  if (ch) {
    out.channelLayout = ch[1];
    const parts = ch[1].split('.');
    out.channels = Number(parts[0]) + (parts[1] === '1' ? 1 : 0);
  }
  if (/\batmos\b/i.test(s)) out.atmos = true;

  /* 动态范围（客户端拿它决定能不能直连解码）：Dolby Vision > HDR10+ > HDR10 > HDR > HLG。
   * 分细是为了让消费方填 `ExtendedVideoType`（只有 DolbyVision 一个值时说不出 HDR10/HLG 的区别）。 */
  if (/\b(dv|dovi|dolby\s*vision)\b/i.test(s)) out.videoRange = 'DOVI';
  else if (/\bhdr10\s*\+|\bhdr10plus\b/i.test(s)) out.videoRange = 'HDR10+';
  else if (/\bhdr10\b/i.test(s)) out.videoRange = 'HDR10';
  else if (/\bhdr\b/i.test(s)) out.videoRange = 'HDR';
  else if (/\bhlg\b/i.test(s)) out.videoRange = 'HLG';

  /* 来源（WEB-DL / BluRay / HDTV / DVD）：集名里写了才认 */
  if (/\b(web-?dl|webrip)\b/i.test(s)) out.source = 'WEB-DL';
  else if (/\b(bluray|blu-?ray|bdrip)\b/i.test(s)) out.source = 'BluRay';
  else if (/\bhdtv\b/i.test(s)) out.source = 'HDTV';
  else if (/\bdvd\b/i.test(s)) out.source = 'DVD';

  return out;
}

/* 规格 token → 标准文件名（scene naming）写法。`parseEpisodeMeta` 为了填 Emby DTO 用的是
 * 引擎枚举（`hevc` / `eac3` / `DOVI`…），文件名副标题则换成圈内通行写法（`H.265` / `DDP` / `DV`…）。
 * 认不出的值原样大写兜底，不编。 */
const NAME_CODEC = { hevc: 'H.265', h264: 'H.264', av1: 'AV1' };
const NAME_AUDIO = { eac3: 'DDP', ac3: 'DD', truehd: 'TrueHD', dts: 'DTS', aac: 'AAC', flac: 'FLAC' };
const NAME_RANGE = { DOVI: 'DV' };

/**
 * 用解析出的规格拼一个标准文件名
 * （`标题.年份.季集.分辨率.来源.音频(含声道).Atmos.动态范围.视频编码.容器`）。
 * `title` / `year` 来自搜索标题（`rawTitle`），规格来自 `parseEpisodeMeta`；
 * 缺哪个字段就跳过哪段，不编。音频与声道并成一段（`DDP` + `5.1` → `DDP5.1`），与样例一致。
 */
function buildStandardName(title, year, meta, season, episode) {
  const parts = [];
  if (title) parts.push(title);
  if (year) parts.push(year);
  if (season !== undefined && season !== null && episode !== undefined && episode !== null) {
    parts.push(`S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`);
  } else if (episode !== undefined && episode !== null) {
    parts.push(`E${String(episode).padStart(2, '0')}`);
  }
  const video = meta.videoCodec ? (NAME_CODEC[meta.videoCodec] || meta.videoCodec.toUpperCase()) : '';
  const audioBase = meta.audioCodec ? (NAME_AUDIO[meta.audioCodec] || meta.audioCodec.toUpperCase()) : '';
  const audio = `${audioBase}${meta.channelLayout || ''}`;
  const range = meta.videoRange ? (NAME_RANGE[meta.videoRange] || meta.videoRange) : '';
  if (meta.height) parts.push(`${meta.height}p`);
  if (meta.source) parts.push(meta.source);
  if (audio) parts.push(audio);
  if (meta.atmos) parts.push('Atmos');
  if (range) parts.push(range);
  if (video) parts.push(video);
  const ext = meta.container || 'mkv';
  return parts.length ? `${parts.join('.')}.${ext}` : '';
}

/** 变体的标注后缀：取名字里**括号段的内容**拼一句（`蜘蛛侠（臻彩）` → `臻彩`，多个用空格连）。 */
function variantLabel(fullName) {
  const parts = [];
  String(fullName || '').replace(/[（(【\[]\s*([^）)】\]]*?)\s*[）)】\]]/g, (m, inner) => {
    const t = String(inner || '').trim();
    if (t) parts.push(t);
    return m;
  });
  return parts.join(' ');
}

/**
 * 取一个站的详情（source = 它所属的源）。
 *
 * ⚠️ **线路与选集的解析已经搬进源插件**（那套编码是源插件自己的约定，见
 * docs/plugin-migration-plan.md 批次 7）：这一层只把结构化结果接住，再做**面板自己那半件事** ——
 * 把集名里源的规格标注（容器 / 分辨率 / 编码 / 体积）解析出来挂在 target/items 上，
 * 消费方（emby 层）要用它填 MediaSource / MediaStreams。那是"填 Emby DTO"的知识，归面板。
 *
 * `pick` 决定"什么算可播目标"（电影/剧集两套取法，见 docs/adr/0022），由插件那边执行：
 *   · 缺省 `''`  —— **剧集**取法：按传进来的季集号定位，每条线路的 `line.target` 是**这一集**；
 *   · `'items'` —— **电影**取法：**每条线路的每个播放项**各成一个目标（`line.items[]`）。
 * 季集号在这里**只负责转给插件**；能不能定位到是插件的事（它认的是集名里的集号，规则见 lib/lines.js）。
 */
async function fetchDetailOnce(source, site, vodId, timeoutMs, season, episode, pick) {
  /* 站点字段统一叫 `key`（与 searchSite / 对外形状一致）—— 曾用名 `site`，与 search 混用会使消费方读不到 key */
  const r0 = { source: source.id, key: site.key, name: site.name, api: site.api, ok: false, ms: 0, data: null, detail: null, error: null };
  const t0 = Date.now();
  try {
    const res = await bridge.detail(source.id, {
      key: site.key,
      id: vodId,
      season: season === undefined || season === null ? undefined : Number(season),
      episode: episode === undefined || episode === null ? undefined : Number(episode),
      pick,
      timeoutMs,
    });
    r0.ms = Date.now() - t0;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const j = res.json;
    if (!j || typeof j !== 'object') throw new Error('返回不是 JSON');
    r0.data = j;
    /* `msearch:` 这类 id：detail 返回空，是**如实**的空，不是失败（插件用 note 说明原因） */
    if (!res.detail) {
      r0.ok = true;
      r0.detail = null;
      r0.error = res.detailNote || '站源 detail 返回空';
      return r0;
    }
    r0.ok = true;
    r0.detail = res.detail;
    /* 把源标的规格挂上去（面板这半件事，见函数头）。`items` 与 `target` 是**同一个对象的引用**
     * （电影取法里 target = items[0]），所以按线路各补一次就行 —— 别重复补两遍。
     *
     * ⚠️ **插件自己给的规格优先**，从集名里正则猜的那份只做兜底（原先是 `Object.assign` 直接盖掉）：
     * 插件手里那份常常是准的（PikPak 的种子清单里就有每个文件的字节数），而集名不一定带标注 ——
     * 种子里的文件名写成 `4k688.com@SNOS-377.mp4` 时，猜出来的体积是 0，Emby 那条 `Size` 就一直空着。
     * 判"这项插件给没给"用**空值**：`undefined` / `null` / `''` / `0` / `false` 都算没给。 */
    for (const line of r0.detail.lines || []) {
      for (const x of [].concat(line.items || [], line.target ? [line.target] : [])) {
        const guessed = parseEpisodeMeta(x.name);
        for (const k of Object.keys(guessed)) {
          const own = x[k];
          if (own === undefined || own === null || own === '' || own === 0 || own === false) x[k] = guessed[k];
        }
      }
    }
    return r0;
  } catch (e) {
    r0.ms = Date.now() - t0;
    r0.error = e && e.name === 'AbortError' ? `超时(${timeoutMs}ms)` : String((e && e.message) || e);
    return r0;
  }
}

/**
 * 取详情 + **顺手记账**（写 `call.detail`）。
 *
 * 记账放在这层薄壳里而不是塞进 `fetchDetailOnce`：那个函数有**好几处提前 return**
 * （`msearch:` 这类 id 的详情是空、解析不出线路等），塞在里面就得每处都记一次、迟早漏一处。
 * 壳子只做一件事，所有路径都经过它。
 *
 * ⚠️ 现在**只有这一处**会写"详情耗时"（测速那一轮不再测详情，理由见 site-stats.js 顶部）：
 * 所以界面那一列的含义是"这站最近一次被**真的点开**取详情时花了多久" ——
 * 没人点过它就是空的（如实留空，不编）。
 */
async function fetchDetail(source, site, vodId, timeoutMs, season, episode, pick) {
  const r0 = await fetchDetailOnce(source, site, vodId, timeoutMs, season, episode, pick);
  /* **失败也记**（超时那一下是最有用的数据）；"无结果"不算失败，`ok` 的定义见 fetchDetailOnce */
  siteStats.recordCall(r0.source, r0.key, 'detail', r0.ms, r0.ok, r0.error);
  return r0;
}

/**
 * 详情主流程：**内部含搜索**（调用方只给影视名）。
 *
 *   name + year + 季集        → 并发搜各站 → **打分挑片**（`match.js`）→ 命中项取 detail
 *   source + site + vodId     → 快路径，跳过搜索（emby 层已缓存绑定时用）
 *
 * **筛选在"搜索"那一步就做完了**（`aggregateSearch` 里调 `match.select`），这里只是拿筛好的条目去取
 * 线路 —— 所以 Emby 那条链与 web 的聚合搜索**共用同一套判据与阈值**，不存在"两处判断不一致"。
 *
 * 返回里每站独立、不去重（与 /api/agg/search 同风格，`sites` 也是**数组**、每项带 source）；
 * 一条都没命中 → picked:null，`stats.match` 里写着"扫了多少条、各桶为什么没进"。
 *
 * ⚠️ **已去掉 picked 挑选：命中即全取**（原为"默认只取 picked 那一站，省时间"）。
 * `picked` 字段仍然返回 —— 但它只是"分最高的那条"**代表值**，不再用来筛掉别的站。
 * `maxItems`（默认 8）是上限：命中越多，"取链"的上游请求就越多，太慢。
 */
async function aggregateDetail(sources, sites, opts = {}) {
  const cfg = opts.params || {};
  const byId = sourceMap(sources);
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || searchTimeoutMs(cfg));
  /* 取详情**单独一项超时**（默认 10 秒，比搜索宽）—— 下面每一次 `fetchDetail` 都用它。 */
  const detailMs = Math.max(1000, Number(opts.detailTimeoutMs) || detailTimeoutMs(cfg));
  const t0 = Date.now();
  const out = {
    name: String(opts.name || ''),
    year: String(opts.year || ''),
    searched: false,
    picked: null,
    sites: [],
    stats: { searched: 0, sameName: 0, variants: 0, detailOk: 0, detailFailed: 0, timeoutMs, detailTimeoutMs: detailMs, sources: 0 },
  };

  const season = opts.season === undefined || opts.season === null || opts.season === '' ? null : Number(opts.season);
  const episode = opts.episode === undefined || opts.episode === null || opts.episode === '' ? null : Number(opts.episode);
  /* 取法：`items` = 电影（每条线路列出**全部播放项**），缺省 = 剧集（按季集号定位一条）。
   * 两者互斥地决定"什么算可播目标"，判据与理由见 `fetchDetail` 顶部。 */
  const pick = opts.pick === 'items' ? 'items' : '';
  /* 线路过滤规则：一笔两用 —— **产出时滤掉**（`applyLineFilter`，返回前那一步）与
   * **参与"能用"的判据**（见 `detailUsable` 与 ADR-0025）。后者不能省：否则会出现
   * "命中 3 条、客户端 0 个版本"，而接续补打还以为已经有能用的了。 */
  const lf = lineFilter(cfg);

  /* ---- 快路径：已知绑定（source + site + vodId），跳过搜索 ---- */
  if (opts.site && opts.vodId) {
    const s = siteByKey(sites, opts.source, opts.site);
    if (!s) {
      out.sites = [{ source: opts.source, key: opts.site, name: '', ok: false, error: `站点清单里没有 ${opts.source} / ${opts.site}` }];
      out.elapsedMs = Date.now() - t0;
      return out;
    }
    const r = await fetchDetail(needSource(byId, s.source), s, opts.vodId, detailMs, season, episode, pick);
    out.sites = [r];
    out.picked = { source: s.source, key: s.key, vodId: opts.vodId, matchedBy: 'given', sameNameCount: 1 };
    if (r.ok) out.stats.detailOk += 1; else out.stats.detailFailed += 1;
    out.stats.sources = 1;
    /* 产出前滤掉规则不匹配的线路（快路径与正常路径**都要做**，见 `applyLineFilter`） */
    if (lf.raw) applyLineFilter(out, lf);
    fillStandardNames(out, opts.name, opts.year, season, episode);
    fillVersionLabels(out, pick, byId);
    out.elapsedMs = Date.now() - t0;
    return out;
  }

  /* ---- 正常路径：先搜（**搜索那一步已经把分打好了**），再按命中项取 detail ---- */
  const searchSites = pickSites(sites, opts);
  const search = await aggregateSearch(sources, searchSites, {
    wd: opts.name,
    page: '1',
    timeoutMs,
    /* 打分要"目标是哪部片"：名字 + 年份 + 季集，全交给 match.js（筛选逻辑就在搜索这一步，
     * 所以 detail 只是"拿已经筛好的链"，不再自己判一遍）。 */
    want: { name: opts.name, year: opts.year, season, episode },
    /* 打分参数：调用方显式给了就用它的，没给就落回**这套模板** ——
     * ⚠️ `params` 必须传下去：漏了它，`aggregateSearch` 里的 `cfg` 就是空对象，
     * 分数线与条数会退回内置默认（0.85 / 8），于是"搜索页按模板筛、emby 这条链按 0.85 筛"，
     * 同一套模板两个口径（原先就是这个毛病）。 */
    matchOptions: { minScore: opts.minScore, maxItems: opts.maxItems },
    params: cfg,
  });
  out.searched = true;
  out.stats.searched = searchSites.length;
  out.stats.sources = search.stats.sources;
  out.stats.match = search.match;
  out.stats.sameName = (search.matched || []).length; // 老字段名：命中的条目数

  for (const e of search.sites || []) {
    if (!e.ok) out.sites.push({ source: e.source, key: e.key, name: e.name, api: e.api, ok: false, ms: e.ms, error: e.error || '搜索失败' });
  }
  /* 没命中 → 如实说（把"搜了但没一条够格"也带上，调用方/日志一眼能分清是没搜到还是没匹配上） */
  const picked = (search.matched || [])[0] || null;
  if (!picked) {
    for (const e of search.sites || []) {
      if (out.sites.some((x) => x.source === e.source && x.key === e.key)) continue;
      const item = { source: e.source, key: e.key, name: e.name, api: e.api, ok: e.ok, ms: e.ms, sameNameCount: 0 };
      if (e.noResultBy) item.noResultBy = e.noResultBy;
      out.sites.push(item);
    }
    out.elapsedMs = Date.now() - t0;
    return out;
  }

  /* 要收的条目 = **每个站分数最高的那条当代表** + **同站其余命中当"变体"**（各自独立条目，各有自己的
   * `vod_id`）—— 变体分别取 detail，一条失败不影响代表。
   * 跨站不复用代表：不同站就是不同线路，那正是版本列表的意义（打分里的去重只去"同站同名"）。 */
  const bySite = new Map();
  const pushItem = (it, variant) => {
    const k = sid(it.source, it.siteKey);
    if (!bySite.has(k)) bySite.set(k, []);
    bySite.get(k).push({ item: it, variant });
  };
  const repOfSite = new Set();
  for (const it of search.matched || []) {
    const k = sid(it.source, it.siteKey);
    if (repOfSite.has(k)) pushItem(it, true);
    else {
      repOfSite.add(k);
      pushItem(it, false);
    }
  }
  out.stats.variants = (search.matched || []).length - repOfSite.size;

  /* 命中的站**全部取 detail**（不再只取 picked 那一站）。
   * 顺序按**模板里勾的站点顺序**排 —— 否则并发搜索"谁先回来谁在前"，客户端版本列表每次刷新顺序都在跳
   * （同一条线路位置换来换去，找不着）。模板里有它就是那个名次，不在里面的排到最后。 */
  const orderIdx = new Map((cfg.order || []).map((x, i) => [sid(x && x.source, x && x.key), i]));
  const wanted = Array.from(bySite.keys()).sort((a, b) => {
    const ia = orderIdx.has(a) ? orderIdx.get(a) : 9999;
    const ib = orderIdx.has(b) ? orderIdx.get(b) : 9999;
    return ia - ib;
  });
  /* 接续补打要用的两本账（判据见下面那段说明）：
   *   `attempted`  = 已经打过 `/detail` 的条目（`vod_id`）—— 补打时别再打一遍，也是"试了多少条"的账；
   *   `usableItems`= 其中**能用**的条数（`detailUsable`）—— 它是不是 0，决定要不要补打。
   * `usableBefore` 是同一批条目**不看线路过滤**时的可用条数：只用于日志诊断
   *（"规则挡掉了几条"一眼可见）；补打与判据一律用 `usableItems`（过滤后）。 */
  const needTarget = episode !== null && episode !== undefined;
  out.stats.needTarget = needTarget;
  /* "这条详情能不能用"的判据跟着取法走：电影看**有没有播放项**，剧集看**有没有定位到这一集**；
   * 再加上线路过滤（`lf.re`）—— 过滤后一条都列不出来的，对客户端就是 0 个版本。 */
  const usableNeed = pick === 'items' ? 'item' : needTarget;
  const attempted = new Set();
  let usableItems = 0;
  let usableBefore = 0;

  const done = new Map();
  await Promise.all(
    wanted.map(async (composite) => {
      const s = siteByKey(sites, ...composite.split('\u0001'));
      const list = bySite.get(composite) || [];
      if (!s || !list.length) return;
      const src = needSource(byId, s.source);
      /* 代表条目：`picked` 落在本站就用它（完全同名、年份优先），否则退本站第一条同名。 */
      const sameList = list.filter((x) => !x.variant).map((x) => x.item);
      const rep = (picked && sid(picked.source, picked.siteKey) === composite ? picked : null) || sameList[0] || (list[0] && list[0].item);
      if (!rep) return;
      // eslint-disable-next-line no-await-in-loop
      const repR = await fetchDetail(src, s, rep.vod_id, detailMs, season, episode, pick);
      repR.sameNameCount = sameList.length;
      repR.variantCount = list.length - sameList.length;
      if (repR.ok) out.stats.detailOk += 1; else out.stats.detailFailed += 1;
      attempted.add(String(rep.vod_id || ''));
      if (detailUsable(repR.detail, usableNeed)) usableBefore += 1;
      if (detailUsable(repR.detail, usableNeed, lf.re)) usableItems += 1;

      /* 变体**各自**取详情，挂在该站的 `variants[]`（代表仍占 `detail`，不重复塞一遍 ——
       * 免得多变体时把最大的那块 `lines` 在响应里序列化两遍）。取不到的**如实不带**，不猜。 */
      const rest = list.filter((x) => x.variant);
      if (rest.length) {
        const vs = await Promise.all(
          rest.map(async (x) => {
            // eslint-disable-next-line no-await-in-loop
            const r = await fetchDetail(src, s, x.item.vod_id, detailMs, season, episode, pick);
            if (r.ok) out.stats.detailOk += 1; else out.stats.detailFailed += 1;
            attempted.add(String(x.item.vod_id || ''));
            if (detailUsable(r.detail, usableNeed)) usableBefore += 1;
            if (detailUsable(r.detail, usableNeed, lf.re)) usableItems += 1;
            if (!r.detail) return null;
            return {
              variant: true,
              /* 版本行副标题：优先取括号里那截（`蜘蛛侠（臻彩）` → `臻彩`）；
               * 括号是空的（`斗破苍穹2018`、`斗破苍穹年番4更211`）就用**清洗后的主干**——
               * 不然同一站的多条变体在客户端里全叫同一个名字，分不出谁是谁。 */
              label: variantLabel(x.item.vod_name) || match.cleanTitle(x.item.vod_name) || String(x.item.vod_name || ''),
              vodName: String(x.item.vod_name || ''),
              vodId: r.detail.vodId,
              detail: r.detail,
            };
          })
        );
        const kept = vs.filter(Boolean);
        if (kept.length) repR.variants = kept;
      }
      done.set(composite, repR);
    })
  );

  /* ---- 接续补打：**前面一条能用的都没拿到时，才往下补打** ----
   * 口径（**取代了上一版的"没凑够 N 条就往下打"**，见 ADR-0027）：
   * `maxItems`（N）只决定**阶段一取哪几条**；只有当阶段一**一条能用的都没拿到**
   *（过滤后客户端的版本列表会是 0）时，才按分数继续往下打，**最多再试 K 条**（`matchExtraK`），
   * **第一批拿到能用的就不再发第二批**。勾了 **「匹配到底」**（`matchExtraAll`）= 不看 K，
   * 一直往下打到拿到一条或名单打完。
   *
   * 为什么要它：命中 ≠ 能播 —— 前 N 条可能全是空壳、或定位不到这一集，那样客户端的版本列表
   * 直接是空的；而真正有这一集的条目排在 N 名之外（被 `maxItems` 截掉了）。但**前面已经有版本时
   * 不值得再往下打**：多打的那几条换来的只是"更多版本"，而每一条都是 10 秒级的站源 `/detail`。
   *
   * 怎么打：**整批并发**（批宽 = 阶段一的条数 `N`），一批的墙钟耗时 ≈ 其中**最慢的那条**，
   * 而不是逐条相加 —— 代价是"批内已经发出去的都得等"（一批里只有一条是必要的）。
   */
  const cfgNow = cfg;
  const extraAll = !!(opts.extraAll === undefined ? cfgNow.matchExtraAll : opts.extraAll);
  const extraK = Math.max(0, Number(opts.extraK === undefined ? cfgNow.matchExtraK : opts.extraK) || 0);
  /* `targetN` 仍然只表示"阶段一要取几条"（批宽按它算）；补打的判据是"一条能用的都没有" */
  const targetN = Math.max(1, Number((search.match || {}).maxItems) || 1);
  /* 上限 = **阶段一实际打了几条 + K**（"最多再试 K 条"的字面口径）——
   * 阶段一因为命中不足而少打时，省下的额度**不转给**补打（原先按 `N + K` 算会有这个副作用）。 */
  const stage1Tried = attempted.size;
  const attemptCap = extraAll ? Infinity : stage1Tried + extraK;
  out.stats.targetN = targetN;
  out.stats.matchUsable = usableItems;
  out.stats.usableBeforeFilter = usableBefore;
  /* 规则生效时**必须说出来**：不然"为什么还在往下补打""为什么一条都不列"都看不出原因 */
  if (lf.raw) {
    console.log(
      `  · agg 线路过滤 /${lf.raw}/${lf.invalid ? '（规则非法，已忽略）' : ''}：` +
        `过滤前能用 ${usableBefore} 条 → 过滤后能用 ${usableItems} 条`
    );
  }
  /* **只有一条能用的都没有**才补打：前面已经有版本时，多打几条只换来"更多版本"，
   * 不值那几发 10 秒级的站源请求（触发判据的这一版见 ADR-0027）。 */
  if (usableItems === 0 && (extraAll || extraK > 0)) {
    const rest = (search.ranked || []).filter((x) => !attempted.has(String(x.vod_id || '')));
    let extraN = 0;
    let extraUsable = 0;
    /* **批宽 = 「最多留几条命中」（`targetN`）**：一批就发这么多，并发打。
     * 取舍：一批发出去之后，"拿到就不再打"只能**在批与批之间**生效 ——
     * 批内多打的（最多 `width - 1` 条）是白烧的；换来的是耗时从"逐条相加"变成
     * "每批取最慢的那条"（串行时最坏是 K 条 × 取详情超时，那是最贵的一段）。 */
    const width = Math.max(1, targetN);

    /** 一条候选的结果落账（与串行版逐条做的事完全一样，只是挪到批量之后按名次顺序跑） */
    const settle = (cand, r2) => {
      if (r2.ok) out.stats.detailOk += 1;
      else out.stats.detailFailed += 1;
      if (!r2.detail) return;
      const composite2 = sid(cand.source, cand.siteKey);
      if (done.has(composite2)) {
        const base = done.get(composite2);
        base.variants = (base.variants || []).concat([
          {
            variant: true,
            label: variantLabel(cand.vod_name) || match.cleanTitle(cand.vod_name) || String(cand.vod_name || ''),
            vodName: String(cand.vod_name || ''),
            vodId: r2.detail.vodId,
            detail: r2.detail,
          },
        ]);
        base.variantCount = (base.variantCount || 0) + 1;
      } else {
        r2.sameNameCount = 1;
        r2.variantCount = 0;
        done.set(composite2, r2);
        if (!wanted.includes(composite2)) wanted.push(composite2);
      }
      if (detailUsable(r2.detail, usableNeed)) usableBefore += 1;
      if (detailUsable(r2.detail, usableNeed, lf.re)) {
        usableItems += 1;
        extraUsable += 1;
        out.stats.usableExtra = extraUsable;
        /* 补打命中的那条当"代表"（emby 层拿它填 ProviderIds —— 那是"真正能播的那个绑定"）。
         * 只取**第一条**能用的（它分最高），再往下即使能用也只进版本列表。 */
        if (!out.pickedFromExtra) out.pickedFromExtra = cand;
      }
    };

    let from = 0;
    for (;;) {
      /* 封顶：试过的条数到 `attemptCap` 就收手；**拿到能用的就不发下一批**。
       * `attempted` 里既有阶段一打过的、也有本阶段打过的。 */
      if (attempted.size >= attemptCap || usableItems >= 1) break;
      const room = Math.max(1, Math.min(width, attemptCap - attempted.size));
      const batch = [];
      while (from < rest.length && batch.length < room) {
        const cand = rest[from++];
        if (attempted.has(String(cand.vod_id || ''))) continue; // 阶段一已经打过这条
        if (!siteByKey(sites, cand.source, cand.siteKey)) continue; // 那个站这次没进清单
        batch.push(cand);
      }
      if (!batch.length) break;
      for (const cand of batch) attempted.add(String(cand.vod_id || ''));
      extraN += batch.length;
      out.stats.extraTried = extraN;
      // eslint-disable-next-line no-await-in-loop
      const got = await Promise.all(
        batch.map(async (cand) => {
          const site0 = siteByKey(sites, cand.source, cand.siteKey);
          const r2 = await fetchDetail(needSource(byId, site0.source), site0, cand.vod_id, detailMs, season, episode, pick);
          return { cand, r2 };
        })
      );
      /* 按**名次**顺序落账（`Promise.all` 保序）：谁先回来不影响"代表取分最高那条"。
       * 这一批的**全部**结果都落账 —— 请求已经发出去了，不列出来等于白烧；
       * "拿到就收手"只作用在**要不要发下一批**上（见循环开头那个 break）。 */
      for (const { cand, r2 } of got) settle(cand, r2);
    }
    out.stats.extraHit = extraUsable;
    console.log(
      `  ${extraUsable ? '↻' : '·'} agg 接续补打：阶段一 ${(search.matched || []).length} 条里能用 0 条 →` +
        ` 往下打了 ${extraN} 条${extraAll ? '（匹配到底）' : `（上限 ${extraK} 条）`}，` +
        (extraUsable ? `拿到 ${extraUsable} 条能用的` : '仍是一条都没拿到（如实为空）')
    );
  }

  /* 上面是**并发**完成的（谁先回来谁在前）—— 不稳。这里按 `wanted`（即 `order` 优先级）重排：
   * 消费方拿到的站点/版本顺序才是确定的；其余项（搜索失败、没同名的站）原样跟在后面。 */
  const ordered = [];
  for (const composite of wanted) if (done.has(composite)) ordered.push(done.get(composite));
  for (const x of out.sites) if (!done.has(sid(x.source, x.key))) ordered.push(x);
  out.sites = ordered;

  const pickedFinal = out.pickedFromExtra || picked;
  delete out.pickedFromExtra;
  out.picked = {
    source: pickedFinal.source,
    key: pickedFinal.siteKey,
    vodId: String(pickedFinal.vod_id || ''),
    /* `picked` = **分数最高的那条**（跨站），它是"代表值"：emby 层拿它填 ProviderIds/老字段。
     * 现在只有一种来源 —— 打分（`match.js`），所以带上分数与理由，别让人再去猜。 */
    matchedBy: out.stats.extraHit ? 'score+extra' : 'score',
    score: round3(pickedFinal.score),
    matchReason: pickedFinal.matchReason || '',
    /* 该站一共命中几条（1 条代表 + N 条变体）。诊断用：以前这里只算"完全同名"的条数，
     * 在 `bySite`（代表+变体混装）上直接 `.length` 会把变体也算进去（已知的错误来源）。 */
    sameNameCount: (bySite.get(sid(pickedFinal.source, pickedFinal.siteKey)) || []).length || (out.stats.extraHit ? 1 : 0),
  };
  /* 产出前滤掉规则不匹配的线路 —— **这一步之后 `lines` 才是"客户端能看到什么"**。
   * 账（过滤前后条数）记进 `stats.lineFilter`，日志与 emby 的诊断字段读它。 */
  if (lf.raw) applyLineFilter(out, lf);
  /* 「这份详情对客户端有没有用」= **过滤后**至少有一条能列出来 ——
   * `api.js` 的 `cacheableLines` 读它决定存不存这份线路结果（见 ADR-0025 / ADR-0032）。 */
  out.stats.usable = usableItems;

  fillStandardNames(out, opts.name, opts.year, season, episode);
  fillVersionLabels(out, pick, byId);
  out.elapsedMs = Date.now() - t0;
  return out;
}

/** 给每个 item/target 拼标准文件名（`标题.年份.季集.规格.容器`），供 emby 层当 Path 末段。
 * 遍历所有 detail 的 target/items，插件给了的字段优先，没给的用解析出的兜底。 */
function fillStandardNames(out, name, year, season, episode) {
  const fillDetail = (detail) => {
    for (const line of (detail && detail.lines) || []) {
      for (const x of [].concat(line.items || [], line.target ? [line.target] : [])) {
        if (x.standardName) continue;
        const meta = {};
        for (const k of ['height', 'source', 'videoCodec', 'audioCodec', 'atmos', 'videoRange', 'channelLayout', 'container']) {
          if (x[k] !== undefined && x[k] !== null && x[k] !== '' && x[k] !== 0 && x[k] !== false) meta[k] = x[k];
        }
        x.standardName = buildStandardName(name, year, meta, season, episode);
      }
    }
  };
  for (const site of out.sites) {
    /* 代表条目与**同片别名变体**各有一份 detail（变体也有自己的 `lines` / `target`，
     * emby 层两条都展开成版本行，见 `getItem`）—— 漏掉变体就会出现「同一个站有的版本有标准名、
     * 有的还是原始文件名」（实测：`三体 S01E10` 代表条目 0 线路、10 条变体在扛，副标题全没拼上）。 */
    fillDetail(site.detail);
    for (const v of site.variants || []) fillDetail(v.detail);
  }
}

/** 版本行**标题位**的体积前缀：播放项带体积时挂十进制大小（GB = 10⁹）：`[8.0G]` / `[943M]`；
 * 没有体积返回空串（不标，不编）。≥1GB 保留一位小数，<1GB 取整 MB。 */
function sizeTag(t) {
  const n = Number(t && t.sizeBytes) || 0;
  if (!n) return '';
  if (n >= 10 ** 9) return `[${(n / 10 ** 9).toFixed(1)}G]`;
  return `[${Math.round(n / 10 ** 6)}M]`;
}

/** 电影多版本标题位用的**清晰度**短标签（体积已统一放前缀，这里不重复）。读不出返回空。例：`1080p`。 */
function itemSpecLabel(t) {
  if (t.width && t.height) return t.height >= 2000 ? '4K' : `${t.height}p`;
  return '';
}

/** 一条线路下**全部播放项**的短标签（电影专用）：清晰度互不相同就直接用清晰度；有重复（同一部片的
 * 两个压制版本体积+清晰度一样）或读不出时补 `· 第 N 项`，保证**互不相同**（同片变体踩过"标题撞名"）。
 * ⚠️ 去重判据仍是「体积 + 清晰度」：体积显示在前缀，同清晰度、不同体积的两个版本靠前缀区分。 */
function itemLabelsOf(items) {
  const specs = items.map((t) => itemSpecLabel(t));
  const keys = items.map((t, i) => `${Number(t.sizeBytes) || 0}|${specs[i]}`);
  const seen = new Set();
  const dup = new Set();
  for (const k of keys) {
    if (seen.has(k)) dup.add(k);
    seen.add(k);
  }
  return keys.map((k, i) => (dup.has(k) ? `${specs[i] || '播放项'} · 第 ${i + 1} 项` : specs[i]));
}

/**
 * 给每个**可播目标**拼版本行标题位：`[体积] 站点标签 · 线路flag [· 变体标注] [· 项标注]`，
 * 消费方（emby 层、出口插件 FW/Rex）拿 `x.versionLabel` 直接当版本显示名 —— 规则只实现一次
 *（见 ADR-0063；与 ADR-0043「线路过滤在聚合层产出时滤」同一模式）。
 *
 * - 站点标签：命中**多个源**时前置源名（不同源可能有同名站点）；只命中一个源时保持原样（标题不变长）。
 * - 变体标注 = 同片别名（`（臻彩）`）；项标注 = 电影同一线路下多个压制版本的短标签（见 `itemLabelsOf`）。
 * - `pick` 决定"什么算可播目标"，与 emby 层一致：电影（`items`）每条线路的 `items[]` 各一个；
 *   剧集（缺省）每条线路的 `target`（定位到的这一集）。取不到的线路不写（emby 层也不列它）。
 *
 * 顺手把详情站条目的 `sourceName` 补齐（原先只有搜索条目带）—— 拼站点标签要用它，
 * 消费方读 `sites[].sourceName` 也才有值。
 */
function fillVersionLabels(out, pick, byId) {
  const sites = out.sites || [];
  for (const s of sites) {
    if (s && s.sourceName === undefined) s.sourceName = ((byId && byId.get(s.source)) || {}).name || '';
  }
  const multiSource = new Set(sites.filter((s) => s && s.detail).map((s) => s.source)).size > 1;
  const movie = pick === 'items';
  const labelDetail = (site, label, detail) => {
    const siteLabel = (multiSource && site.sourceName ? `${site.sourceName} ` : '') + (site.name || site.key || '');
    for (const line of (detail && detail.lines) || []) {
      const targets = movie ? line.items || [] : line.target ? [line.target] : [];
      if (!targets.length) continue;
      const itemLabels = movie ? itemLabelsOf(targets) : [];
      targets.forEach((t, i) => {
        const sizePrefix = sizeTag(t);
        t.versionLabel =
          `${sizePrefix ? `${sizePrefix} ` : ''}${siteLabel} · ${line.flag}` +
          `${label ? ` · ${label}` : ''}${itemLabels[i] ? ` · ${itemLabels[i]}` : ''}`;
      });
    }
  };
  for (const site of sites) {
    /* 代表条目与同片别名变体各有一份 detail（与 `fillStandardNames` 同一口径）。 */
    if (site.detail) labelDetail(site, '', site.detail);
    for (const v of site.variants || []) if (v.detail) labelDetail(site, v.label || '', v.detail);
  }
}

const NON_HTTP_URL = /^(push|magnet|ed2k|thunder|ftp|rtmp):/i;

/**
 * 播放：把**插件自己编的 `ref`** 交给插件动作「解析地址」，拿回一个**客户端够得着**的地址。
 *
 * 面板不再解释 `ref`（里面是什么、怎么变有效，都是插件的事，见 docs/plugin-migration-plan.md 批次 7），
 * 所以这里也没有"站点 / 线路 / 集 id"这些参数了 —— 只剩 `ref` 与**客户端访问用的主机名**
 * （本地部署的实例回的是回环地址，插件要拿它拼成客户端够得着的地址）。
 *
 * 地址会过期：**每次播放都现取、不缓存**（缓存在插件自己那边，它自己管有效期 —— 契约第八节）。
 */
async function playEpisode(opts = {}) {
  const cfg = opts.params || {};
  /* 播放走**自己那一档**超时（默认 25 秒，比搜索宽得多）—— 网盘类线路取一个地址要串行打好几发，
   * 跟搜索共用一个 5 秒档会让它们一律超时（见上面 `playTimeoutMs` 的说明）。 */
  const timeoutMs = Math.max(1000, Number(opts.timeoutMs) || playTimeoutMs(cfg));
  const t0 = Date.now();
  const ref = String(opts.ref || '').trim();
  const done = (payload) => Object.assign({ ref, elapsedMs: Date.now() - t0 }, payload);

  if (!ref) {
    return done({ ok: false, error: { code: 'BAD_REQUEST', status: 400, message: '缺少 ref（版本 Id 里那段）' } });
  }

  let res;
  try {
    res = await bridge.play(ref, { clientHost: opts.clientHost || '', timeoutMs });
  } catch (e) {
    /* 抛出来的都是"这次调用本身没成"（插件没在跑、管道断了、ref 认不出、站点认不出…）——
     * 面板如实照搬原因；只有超时按老口径报（那是唯一需要带上超时值的）。 */
    const code = (e && e.code) || 'NETWORK';
    const timeout = e && e.name === 'AbortError';
    const callerFault = code === 'BAD_REF' || code === 'NO_SITE' || code === 'NO_SOURCE';
    return done({
      ok: false,
      error: {
        code,
        status: timeout || !callerFault ? 502 : 400,
        message: timeout ? `超时(${timeoutMs}ms)` : (e && e.message) || '取播放地址失败',
      },
    });
  }
  if (!res.ok) {
    return done({ ok: false, error: { code: 'UPSTREAM_HTTP', status: res.status, message: '源返回 HTTP ' + res.status } });
  }

  const j = { urls: res.urls, header: res.header, parse: res.parse };
  /* 插件回的 `urls` 已经归一化过（源那边"字符串或扁平数组"的两种写法由它收口，见它的 normalizePlay） */
  const urls = (Array.isArray(j.urls) ? j.urls : []).map((x) => String(x || '')).filter(Boolean);
  if (!urls.length) {
    return done({ ok: false, data: j, error: { code: 'NO_PLAY_URL', status: 502, message: '源没给出播放地址（网盘类线路要解析，可能首次不完整）' } });
  }
  return done({
    ok: true,
    data: j,
    play: {
      urls,
      header: j.header && typeof j.header === 'object' ? j.header : {},
      parse: Number(j.parse) || 0,
      nonHttp: urls.filter((u) => NON_HTTP_URL.test(u)), // push:// 之类原样透传，交给调用方决定
    },
  });
}

module.exports = {
  aggregateSearch,
  searchSite,
  normName,
  sid,
  sourceMap,
  siteByKey,
  selectSites,
  parseEpisodeMeta,
  matchDefaults,
  searchTimeoutMs,
  detailTimeoutMs,
  playTimeoutMs,
  fetchDetail,
  aggregateDetail,
  playEpisode,
};
