'use strict';
/**
 * 聚合层 · **进程内调用面**（面板自己用）
 *
 * 谁在用，两条路共用**同一套编排**（此前两处各写一份，易出现改动不同步）：
 *   ① 路由层 `POST /api/agg/detail` / `/api/agg/play` —— 给前端与外部用，仍走 HTTP；
 *   ② emby 层 —— `emby/service.js` 直接 `require('../agg/api')` 拿详情与播放地址。
 *
 * **为什么 emby 层不走 HTTP**：
 * emby 层原来打自己的 `http://127.0.0.1:<port>/api/agg/*`，而那条自调用**不带面板 cookie** ——
 * 面板门禁（`core/auth.js` 的 `needsAuth`：`/api/` 开头一律要登录）会把它挡成 **401**，
 * 于是每条详情都退化成"只回元数据"、播放链路也断（日志只写 `UPSTREAM_HTTP http://127.0.0.1:<面板端口>`，
 * 看不出是 401 —— 因为 401 发生在进路由之前，连一条 agg 请求日志都没有）。
 * 两层本来就在**同一个进程**里，「地址 + HTTP」那层壳除了多一次鉴权与一次 JSON 往返，没有任何价值。
 *
 * ⚠️ 模块间直连只剩一处：emby → agg（本文件，原因见上）。
 * 源那侧**不再直连** —— 取数与"有哪些源、有哪些站点"都走 `source-bridge.js` 转给源插件
 * （`agg → source` 那份直连随源插件化去掉了：源不活在本进程里，它们由插件托管）。
 * 别的地方（面板 → 外部聚合地址）仍走「地址 + HTTP」—— 那些地址**可以在别的机器上**。
 *
 * 约定：**不抛异常**，成败看 `ok`。失败一律 `{ ok:false, error:{ code, status, message } }` ——
 * `status` 是"同样的错在 HTTP 上该回几"，路由层直接照搬，emby 层则拿 code/message 写日志。
 * 站点身份是 `(source, site)` 这一对，任何按 key 对齐的地方都必须带上 source。
 */
const settings = require('../../core/settings');
const bridge = require('./source-bridge');
const cache = require('./cache');
const templates = require('./templates');
const siteStats = require('./site-stats');
const { aggregateSearch, aggregateDetail, playEpisode, selectSites, matchDefaults, searchTimeoutMs, detailTimeoutMs } = require('./service');

/** 失败的统一形状（不抛异常：调用方可能是路由，也可能是 emby 层，各自决定怎么呈现） */
function fail(code, status, message) {
  return { ok: false, error: { code, status, message } };
}

/**
 * 某个域该用哪份模板 —— 把"域"解析成"这套模板的参数与站点"。
 *
 * 三条如实口径（见 docs/adr/0033）：
 *   · 请求没带域 ⇒ 400（面板侧要显式告诉面板"这条内容属于哪个域"）
 *   · 域还没有配模板 ⇒ **如实为空并点名**，不挑兜底、不猜
 *   · 解析出来之后，参数就跟着模板走（超时、并发、打分、过滤全在里面）
 */
function ensureDomain(domain) {
  const d = String(domain || '').trim();
  if (!d) return { error: fail('NO_DOMAIN', 400, '请求要带上 domain（这条内容属于哪个元数据域）') };
  const template = templates.templateFor(d);
  if (!template) {
    return {
      error: fail('NO_TEMPLATE', 404, `域 ${d} 还没有配模板 —— 如实为空（到「模板」页配一套，并把它指给这个域）`),
    };
  }
  return {
    domain: d,
    template,
    /* 站点顺序也由模板决定（模板里勾的顺序 = 聚合取站优先级），所以并进 params 一起往下传 */
    params: Object.assign({}, template.params, { order: template.sites }),
    /* 勾了哪些站点：`{enabled, order}` 就是 `selectSites` 要的形状 */
    selection: { enabled: template.sites, order: template.sites },
  };
}

/**
 * 直接按**模板 id** 定位作用域 —— web 的「聚合搜索」页是按模板选的，不必先知道"这属于哪个域"。
 * 形状与 `ensureDomain` 一致（`{template, params, selection}`），两处只是"怎么找到那份模板"不同。
 */
function ensureTemplate(tplId) {
  const id = String(tplId || '').trim();
  const template = id ? templates.read(id) : null;
  if (!template) return { error: fail('NO_TEMPLATE', 404, `没有这份模板：${id || '(空)'}`) };
  return {
    template,
    /* 站点顺序也由模板决定（模板里勾的顺序 = 聚合取站优先级），所以并进 params 一起往下传 */
    params: Object.assign({}, template.params, { order: template.sites }),
    selection: { enabled: template.sites, order: template.sites },
  };
}

/**
 * 搜索 / 取详情的**作用域** —— 两种入口最后都落到同一份模板上：
 *   · `tpl`    —— web「聚合搜索」页按**模板**选（面板上直接挑一套模板，见 docs/adr/0033）；
 *   · `domain` —— 客户端（Emby）那条路按**域**问（注册表里那些元数据域前缀），
 *                 由「其他设置」里的"域 → 模板"对照翻译成模板。
 * 两个都不给 ⇒ 报错点明缺什么：不猜、也不回退到内置默认值。
 */
function scopeOf(opts) {
  const o = opts || {};
  if (String(o.tpl || '').trim()) return ensureTemplate(o.tpl);
  return ensureDomain(o.domain);
}

/**
 * 拉所有**参与聚合**的源的站点清单；给每个站点打上 `source` / `sourceName`。
 *
 * **源与站点都来自源插件**（`站点清单` 动作）：面板这边不再有"聚合源配置"，
 * 也不再自己去问每个源的 `/config`。每个实例一行，实例自己的失败只影响它自己
 *（`sources[].ok/error`），它的站点就不出现在 `sites` 里。
 * 返回 `{ sources, sites }`；`sources` 里不含站点数组（响应不必背两份）。
 */
async function loadSites() {
  const { sources, sites } = await bridge.loadSites();
  const byId = new Map(sources.map((s) => [s.id, s]));
  return {
    sources,
    /* 站点清单只收"启用的源"的；关掉的源整体不参与聚合（站点勾选不用逐个取消） */
    sites: sites.map((x) =>
      Object.assign({}, x, {
        sourceName: (byId.get(x.source) || {}).name || x.source,
        /* 把**已记下的统计**带上（见 site-stats.js）：界面那一列「延迟」= `stat.home`（测速结果），
         * title 里的"最近一次真实搜索 / 取详情"= `stat.call.*`（顺手记账）。
         * 什么都没记过的站点这里是 null，界面显示 `—`（如实，不编）。 */
        stat: siteStats.view(x.source, x.key),
      })
    ),
  };
}

/** 参与聚合的源（拉得到站点的那些）—— 用来把"源都不可用"和"没勾选站点"两种空区分开报 */
const liveSources = (sources) => (sources || []).filter((s) => s.ok);

/* ⚠️ 线路过滤**不再从这里转发**：规则由 `service.js` 在产出线路时就用掉了
 *（`applyLineFilter`），消费方（emby / 出口插件）拿到的 `lines` 已经是滤过的那份 ——
 * 原先 emby 层那个"读规则、拼版本列表时自己滤"的口子已删（见 ADR-0043）。 */

/* ============================================================
 * 线路结果缓存 + 同键并发合并（表与库见 modules/agg/cache.js）
 *
 * 客户端点一次「播放」会连着问三遍同一件事（条目详情 → 播放信息① → 播放信息②），
 * 每遍都要「搜源 → 逐站取详情 → 定位到这一集」，实测 4~7 秒 —— 三次串行 ≈ 20 秒，
 * 其中两遍是白重算的。这里把那一步的结果存下来复用。
 *
 * ⚠️ 面板侧**只管这三连问**（几秒内）—— 更长的热度归**插件自己的缓存**
 * （"插件应当自己缓存"是契约义务，见 docs/plugin-contract.md 第八节与 docs/adr/0032）。
 * ============================================================ */

/** 正在跑的详情查询：同一个 key 的并发请求跟着同一趟走，不各打一次源站 */
const inflightDetail = new Map();

/**
 * 缓存 key = 「问的是什么」+「当时按什么规则问」。
 *
 * 把**规则**（参与站点、源地址、分数线、最多留几条、补打设置、站点顺序、**线路过滤**、
 * 两档单站超时、**取法**）一起拼进去，是为了让「改了设置」这件事**天然换 key** ——
 * 不必再写一套"设置变更后清缓存"的钩子，也不会读到按旧规则算出来的结论（ADR-0032）。
 *
 * ⚠️ **线路过滤进 key**（原先写的是"不进"，现已被 ADR-0025 取代）：它现在参与"这条详情
 * 对客户端有没有用"的判据（过滤后一条都列不出来 → 不算有用、也不存缓存），所以规则一改
 * 就必须换成另一个 key。代价如实记着：**改规则后第一次请求要重算**（那一趟是秒级的）——
 * 换来的是不会命中一份"按旧规则判定为有用"的结论。
 */
function detailCacheKey({ name, year, season, episode, scoped, sources, cfg, params, opts }) {
  const m = matchDefaults(params, opts);
  const extraAll = opts.extraAll === undefined ? !!cfg.matchExtraAll : !!opts.extraAll;
  const pair = (x) => `${(x && x.source) || ''}/${(x && x.key) || ''}`;
  const dim = (v) => (v === undefined || v === null || v === '' ? '' : String(v));
  return [
    /* ⚠️ `aggdetail` 后面那个 `5` 是**产出口径的版本号**：线路过滤从"客户端各自滤"改成了"聚合层产出时就滤"
     *（ADR-0043）→ 2；多了每个播放项的 `standardName`（emby 取它当版本行副标题）→ 3；
     * `standardName` 的规格 token 换成 scene 写法（`H.265`/`DDP5.1`/`DV`）→ 4；
     * 每个可播目标多了 `versionLabel`（版本行标题位，emby 与出口插件共用，ADR-0063）→ 5。
     * 同一份 key 下的旧快照是按旧口径算的 —— 不换 key 就会一直命中旧快照，看起来像"改完没生效"。
     * 以后只要"这份结果的内容口径"变了，这里就 +1。 */
    'aggdetail5',
    String(name || ''),
    String(year || ''),
    dim(season),
    dim(episode),
    /* 参与站点（顺序无关 → 排序）+ 源地址（改了地址等于换了后端，旧结果不能再用） */
    scoped.map(pair).sort().join(','),
    (sources || []).map((s) => `${s.id}|${s.url || ''}`).sort().join(';'),
    /* 这几项直接决定"命中哪些站"，必须进 key */
    [m.minScore, m.maxItems, m.extraK, extraAll ? 1 : 0, (cfg.order || []).map(pair).join(',')].join('|'),
    /* 取法（电影 `items` / 剧集按季集定位）：两种取法算出来的"可播目标"不是一回事，分开存 */
    String(opts.pick === 'items' ? 'items' : ''),
    /* 两档单站超时（秒）：它们决定"这一次哪几条线路取得到/哪些站搜得到"（超时的站那条就没了），
     * 与线路过滤同理 —— 改了规则就该重算，而不是命中一份按旧超时算出来的结论 */
    String(Math.round(searchTimeoutMs(cfg) / 1000)),
    String(Math.round(detailTimeoutMs(cfg) / 1000)),
    /* 线路过滤的原文（正则）：它决定"这份详情对客户端有没有用"，必须进 key（见上） */
    String(cfg.lineFilter || '').trim(),
  ].join('\u0001');
}

/**
 * 什么样的结果才值得存。
 *
 * **判据：`stats.usable > 0`** —— 即"至少有一条**过滤后仍能被客户端列出来**的线路"
 *（有线路、过了线路过滤、且定位到这一集 / 有播放项；由 `service.aggregateDetail` 统计）。
 *
 * ⚠️ 这就是 ADR-0032 那条"**只要有线路就存**"：它不要求"所有站点都通"（那是旧的
 * "完整快照"口径，ADR-0020 时代已经放宽过）。实测这一趟是 10 秒级的活，启用站里只要有一个
 * 慢一下或抖一下整份就不存的话，客户端点一次播放连着问的那三遍就**全部重算**。
 *
 * 但**"过滤后一条都列不出来"仍不算有用**（ADR-0025）：那等于给客户端 0 个版本，
 * 存下来会在整个有效期内一直挡着（实测：某站 4 条线路被 `/夸克原画/` 全滤掉，
 * 客户端反复点开都是 0 版本）。所以判据是"有**能用的**线路就存"。
 *
 * 代价**如实记着**：存下的可能是"缺某个源那几条线路"的半份结果，在那个有效期内点开都会缺它。
 * 所以不让这件事无声无息 —— 存那行日志会**点名**这次是哪个源没取到（见下面 `compute()` 里）。
 *
 * 仍然不存**负结果**（没命中、或全失败）：这两件事在返回值上不好区分，
 * 分不清就不缓存，每次如实去问（延续 ADR-0008）。
 */
function cacheableLines(out) {
  return Number((out.stats || {}).usable) > 0;
}

/**
 * 入库前**甩掉插件那份上游原样响应**（`sites[].data`）。
 *
 * 面板侧这份缓存只该装"面板聚合出来的线路结果"（ADR-0032：面板不必懂插件返回的全部结构）。
 * `data` 是插件的原样响应体，面板这边没有任何消费方读它（web 的「这条的版本」弹窗与 emby 层
 * 都只读 `detail` / `variants`），留着只是让缓存白白大一截。
 * ⚠️ 于是**缓存命中时回的响应里没有 `sites[].data`，而现算那次有** —— 这是刻意的：
 * 那个字段只当诊断用，别拿它做判据（要诊断去看插件自己的缓存与日志）。
 *
 * `sources`（这次的源清单）也不入库：源会增删改，命中时就地用**当次**读到的顶上。
 */
function slimLines(out) {
  const slim = Object.assign({}, out);
  delete slim.sources;
  slim.sites = (out.sites || []).map((x) => {
    if (!x || !x.data) return x;
    const one = Object.assign({}, x);
    delete one.data;
    return one;
  });
  return slim;
}

/**
 * **按插件记这次聚合的耗时**（ADR-0032 第 4 条：不记就查不出"慢插件"）——
 * 日志点名 + 写进统计（见 `cache.recordAgg`，面板「缓存设置」页会列出来）。
 *
 * 一次聚合会同时打几个插件，记一个总耗时说不出是谁慢，所以按插件分开记，
 * 每项取它**这次最慢的那一发取数**（插件内几个实例/站点并发，最慢的那发才是用户等的那段）。
 */
function noteAggPerPlugin(name, out) {
  const per = new Map();
  for (const x of out.sites || []) {
    if (!x || !x.source) continue;
    const pluginId = String(x.source).split('/')[0]; // 源身份是「插件 id / 实例 id」
    const ms = Number(x.ms) || 0;
    const cur = per.get(pluginId);
    if (!cur) per.set(pluginId, { ms, sites: 1 });
    else {
      cur.sites += 1;
      if (ms > cur.ms) cur.ms = ms;
    }
  }
  if (!per.size) return;
  const parts = [];
  for (const [id, v] of per) {
    cache.recordAgg(id, v.ms, v.sites);
    parts.push(`${id} ${(v.ms / 1000).toFixed(1)}s`);
  }
  console.log(`  · agg 聚合耗时「${name}」共 ${out.elapsedMs || 0}ms（按插件最慢的一发：${parts.join(' / ')}）`);
}

/**
 * 取影视详情（**内部含搜索**）。
 *
 * `opts`：`name`（影视名）/ `year`（消歧）/ `season` + `episode`（定位某一集）/
 * `keys`（限定站点 `{source,key}[]`）/ `source`+`site`+`vodId`（快路径：已知绑定就直查，跳过搜索）/
 * `pick`（取法：`items` = 电影，列出每条线路的**全部播放项**；缺省 = 剧集，按季集号定位一条）/
 * `timeoutMs`（搜索那一步的单站超时，毫秒）/ `detailTimeoutMs`（**取详情**的单站超时，毫秒，
 * 不传读 `agg.detailTimeoutSec` —— 默认比搜索宽，理由见 service.searchTimeoutMs）/
 * `minScore` + `maxItems`（打分阈值与"最多留几条"，不传就用 `agg.json` 里的设置）；
 * `extraK` / `extraAll`（接续补打：前面一条能用的都没拿到时再往下试几条 / 匹配到底，不传读设置）。
 * **没有 `all`**：命中的站一律全取（见 service.aggregateDetail），
 * 但条数受 `maxItems` 限制（每多一条命中就要多打一次 `/detail` 取链，太慢）。
 * ⚠️ **不再有上游反查**：判据是 `match.js` 的打分（理由见那个文件顶部）。
 * 成功回 `{ok:true, sites, picked, stats, sources, elapsedMs}`（每站的成败在 `sites[].ok/error` 里）；
 * 走缓存时多一个 `cached:true`，`elapsedMs` 是**当初算它那一次的耗时**，
 * 且**响应里没有 `sites[].data`**（那份上游原样响应不入库，见 `slimLines`）。
 */
async function detail(opts = {}) {
  const name = String(opts.name || '').trim();
  const source = String(opts.source || '').trim();
  const site = String(opts.site || '').trim();
  const vodId = String(opts.vodId || '').trim();
  if (!name && !(source && site && vodId)) {
    return fail('BAD_INPUT', 400, '请提供 name（影视名），或用 source + site + vodId 直接指定绑定');
  }

  const dom = scopeOf(opts);
  if (dom.error) return dom.error;
  const cfg = dom.params;
  const { sources, sites } = await loadSites();
  if (!sources.length) return fail('NO_SOURCE', 400, '还没有聚合源：本地部署一个源，或到「聚合设置 → 源列表」填一个外部地址');

  const scoped = site
    ? sites.filter((x) => x.key === site && (!source || x.source === source))
    : selectSites(sites, dom.selection, opts.keys);
  if (!scoped.length) {
    return fail(
      'NO_SITE',
      400,
      site
        ? `没有可用的站源：${source ? source + ' / ' : ''}${site}`
        : '没有可用的站源：请到「模板」页把要用的站点勾进这个域用的那套模板'
    );
  }

  /* 只有「按名字搜」这条路才值得缓存（那 4~7 秒就在它身上）。
   * 带 `source + site + vodId` 的快路径只打一个站，而且它是 `resolveStream` 取**新鲜**集 ID 的那条路 ——
   * 缓存它会拿到过期的集 ID，所以那条路一律不缓存、也不做合并。 */
  const cacheKey =
    !site && !vodId && name ? detailCacheKey({ name, year: opts.year, season: opts.season, episode: opts.episode, scoped, sources, cfg, params: dom.params, opts }) : '';

  if (cacheKey) {
    const hit = cache.getLine(cacheKey);
    if (hit) {
      /* 源清单用**这次**读到的（站点/端口会变），其余照旧 —— 缓存只省掉"打插件"那一段 */
      hit.sources = sources;
      hit.cached = true;
      console.log(
        `  · agg 线路结果缓存命中「${name}」→ ${(hit.sites || []).length} 站` +
          `（没打插件；当初算它花了 ${hit.elapsedMs || 0}ms）`
      );
      return Object.assign({ ok: true }, hit);
    }
  }

  /** 真正去打插件的那一趟（含写缓存） */
  const compute = async () => {
    const out = await aggregateDetail(sources, scoped, {
      name,
      year: opts.year,
      source,
      site,
      vodId,
      season: opts.season,
      episode: opts.episode,
      /* 取法：`items` = 电影（每条线路列出全部播放项）；缺省 = 剧集（按季集号定位一条）。 */
      pick: opts.pick,
      timeoutMs: opts.timeoutMs,
      detailTimeoutMs: opts.detailTimeoutMs,
      minScore: opts.minScore,
      maxItems: opts.maxItems,
      /* 接续补打（不传读设置）：一条能用的都没拿到时最多再试几条（`matchExtraK`）；
       * `extraAll` = 匹配到底（不看 K，一直往下打到拿到一条或名单打完） */
      extraK: opts.extraK,
      extraAll: opts.extraAll,
      /* 参数与站点顺序都来自这套模板（上面已按域解析过） */
      params: dom.params,
    });
    out.sources = sources;

    /* 打分的"一句话摘要"进日志：命中几条、扫了多少条、没进的都因为什么。
     * 没命中时这行就是唯一线索 —— 所以把各桶计数都写出来（web 上那三个输入框怎么调，看它）。 */
    const m = out.stats && out.stats.match;
    if (m) {
      const hit = Number(out.stats.sameName) || 0; // 命中的条目数（pick 为空时是 0）
      console.log(
        `  ${out.picked ? '✔' : '·'} agg 打分「${name}」：扫 ${m.scanned} 条 → 命中 ${m.matched}` +
          `（分数线 ${m.minScore || '关'}，上限 ${m.maxItems || '不封顶'}）` +
          `；没进：低分 ${m.belowLine} / 超上限 ${m.overCap} / 名字不过闸 ${m.rejected}` +
          `；同站同名 ${m.sameNameSameSite || 0} 条（照收，不去重）` +
          (out.picked ? `；代表 ${out.picked.source}/${out.picked.key} 分 ${out.picked.score}` : '') +
          (hit ? '' : ' → 结果为空')
      );
    }

    /* 按插件记这次聚合的耗时（日志 + 统计）—— 见 `noteAggPerPlugin` */
    noteAggPerPlugin(name, out);

    if (cacheKey) {
      if (!cacheableLines(out)) {
        console.log(
          '  · agg 线路结果不存缓存（没命中 / 没有任何站拿到详情 / **线路过滤后一条能用的都没有**）—— 下次仍如实去问'
        );
      } else if (cache.putLine(cacheKey, slimLines(out))) {
        /* **有站失败也照存**（见 `cacheableLines`），所以这里必须点名缺了谁 ——
         * 否则"缓存里少几条线路"跟"源里本来就没有"长得一模一样，事后无从分辨。 */
        const s = out.stats || {};
        const bad = (out.sites || []).filter((x) => x && x.ok === false).map((x) => x.name || x.key);
        const miss = [];
        if (bad.length) miss.push(`${bad.length} 个源没搜到（${bad.slice(0, 4).join(' / ')}${bad.length > 4 ? ' …' : ''}）`);
        if (Number(s.detailFailed)) miss.push(`${s.detailFailed} 条详情没取到`);
        console.log(
          `  ✔ agg 线路结果已存缓存（${(out.sites || []).length} 站` +
            (miss.length ? `；⚠️ 但不完整：${miss.join('，')} —— 这份缓存里没有它们的线路` : '') +
            `；有效期见「面板设置 → 缓存设置」）`
        );
      } else {
        console.log('  · agg 线路结果没存缓存（「缓存设置 → 线路结果」的有效期填了 0 = 不缓存）');
      }
    }
    return Object.assign({ ok: true }, out);
  };

  if (!cacheKey) return compute();

  /* 同键并发合并：同一时刻两个人点开同一部片，只打一趟插件 */
  const running = inflightDetail.get(cacheKey);
  if (running) {
    console.log(`  · agg 同键合并「${name}」—— 跟着同一趟插件查询走`);
    return running;
  }
  const p = compute();
  inflightDetail.set(cacheKey, p);
  try {
    return await p;
  } finally {
    inflightDetail.delete(cacheKey);
  }
}

/**
 * 取播放地址：`{domain, ref, clientHost?}`。
 *
 * `ref` 是**源插件编的**那一串（版本 Id 里带的），面板不解释它；`clientHost` 是客户端访问面板用的
 * 主机名（本地实例回的是回环地址，插件要拿它拼成客户端够得着的地址）。
 * 成功回 `{ok:true, play:{urls, header, parse, nonHttp}}`；失败按原因给码（见 service.playEpisode）。
 * 地址会过期：**每次播放都现取**，别缓存。
 */
async function play(opts = {}) {
  const ref = String(opts.ref || '').trim();
  if (!ref) return fail('BAD_INPUT', 400, '请提供 ref（版本 Id 里那段，由源插件编）');

  /* 作用域（tpl 或 domain）：只借它那一档超时（播放有**自己那一档** `playTimeoutSec`，见 service.playTimeoutMs）。
   * **站点与线路不再经过这里** ——
   * `ref` 里是什么、去哪儿取，都是插件的事（见 docs/plugin-migration-plan.md 批次 7）。 */
  const dom = scopeOf(opts);
  if (dom.error) return dom.error;
  return playEpisode({
    ref,
    /* 客户端访问面板用的主机名：本地部署的实例回的是回环地址，插件要拿它拼成客户端够得着的地址 */
    clientHost: String(opts.clientHost || ''),
    timeoutMs: opts.timeoutMs,
    params: dom.params,
  });
}

/**
 * 测速用的**固定超时** —— **不读 `agg.timeoutSec`**（那个是给搜索链路的，默认 5 秒）。
 * 拿 5 秒去测速，慢站会一律被记成"超时"，量到的是设置而不是站；15 秒够容下实测里最慢的
 * 几发搜索（冷回源 0.4~1s、个别站 5s+），也不至于让一轮测速拖太久。
 */
const SPEED_TEST_TIMEOUT_MS = 15000;

/**
 * 测速用的**探测词**（常见影视名）—— 每次**随机取一个**。
 *
 * 为什么要"一组 + 随机"而不是固定一个词：站里**没有**这个词时会回 404 或空列表
 * （实测 duoduo / huban：有词 200、无词 404），固定一个词等于给每个站预设了
 * "有没有结果"这个变量；随机取则长期看每个站都会被抽到有结果的词。
 * 选词口径：各站普遍收录的大众片，动画 / 国剧 / 老剧各占一些（避免整组都是同一类）。
 */
const PROBE_WORDS = [
  '斗破苍穹',
  '斗罗大陆',
  '庆余年',
  '甄嬛传',
  '西游记',
  '亮剑',
  '琅琊榜',
  '武林外传',
  '士兵突击',
  '狂飙',
  '三体',
  '人民的名义',
];

/** 随机取一个探测词；给了 `exclude` 就避开它（"换一个关键词再测"用它） */
function pickProbeWord(exclude) {
  const pool = PROBE_WORDS.filter((w) => w !== exclude);
  const list = pool.length ? pool : PROBE_WORDS;
  return list[Math.floor(Math.random() * list.length)];
}

/**
 * **单站测速**：向源插件要一发搜索探针（关键词随机取），量往返耗时并覆盖统计里的那一槽。
 *
 * 为什么是搜索：聚合真正走的就是它，只有它的数字对得上"用户会等多久"。
 * （`/home` 实测虽然普遍可用，但它返回的是**首页分类树** —— huban/duoduo 各 62KB / 208 个分类、
 * 盘搜类站是空壳 10ms —— 与搜索耗时背离：实测 duoduo 首页 2.0s / 搜索 0.4s、huban 1.4s / 0.1s，
 * 当"延迟"列会误导，所以不用它。）
 *
 * **失败换词再测一发**：非 200（404 / 5xx / 403 …）就换一个探测词重测；**两发都非 200 才算真失败**。
 * 这样"这站恰好没有那个词"不会被记成一次失败，而真的坏站（两发都失败）会如实标出来。
 * （"换词重测"是**面板侧的判据**，所以留在这一层；插件那边只负责"打一发、报结果"。）
 *
 * **口径与业务刻意不同**（见 `site-stats.js` 顶部）：`200 = 成功`，**列表为空也算**
 * （它已经尽了搜索的义务）；非 200 记失败并记下状态码；超时 / 网络错记失败。
 *
 * `init` 由插件自己做（它按「实例 + 站点」记住），返回里带 `initCalled` —— 测速顺手把
 * 那一标记做好，业务侧首次搜索不必再多打一次。
 *
 * 失败不可怕：`ok:true` 只表示"这次测速动作本身完成了"，站点结论在返回的 `search` 里。
 * `routeMissing` —— 404 且文案是 `Route POST:… not found`（**源里这个站没实现 /search**，
 * 不是站坏了）；其余非 200 / 超时 = 上游真实的错（HTTP 404 / 500 / 403 / 超时）。
 */
async function probeSearch({ source, key, wd, timeoutMs } = {}) {
  const siteKey = String(key || '').trim();
  const sourceId = String(source || '').trim();
  if (!siteKey) return fail('BAD_INPUT', 400, '请提供站点 key');
  if (!sourceId) return fail('BAD_INPUT', 400, '请提供源 id');

  const timeout = Math.max(1000, Number(timeoutMs) || SPEED_TEST_TIMEOUT_MS);
  let initCalled = false;
  let sourceName = '';

  /** 打一发搜索（`init` 由插件在第一次调用时自己兜） */
  const callSearch = async (word) => {
    const t0 = Date.now();
    let status = 0;
    let ok = false;
    let error = '';
    let text = '';
    let body = null;
    try {
      const r = await bridge.probe(sourceId, { key: siteKey, wd: word, timeoutMs: timeout });
      status = r.status;
      ok = r.ok;
      text = String(r.text || '');
      body = r.json;
      if (r.initCalled) initCalled = true;
      if (r.name) sourceName = String(r.name);
      if (!ok) error = 'HTTP ' + r.status;
    } catch (e) {
      /* 这两种不是"这一发测速失败"，而是**请求本身就不成立**（认不出站点 / 实例没在跑）——
       * 如实按业务错误回，不混进测速统计里（否则统计里会多一条"这个站坏了"的假账）。 */
      if (e && (e.code === 'NO_SITE' || e.code === 'NO_SOURCE')) {
        const err = new Error((e && e.message) || String(e));
        err.probeFail = e.code === 'NO_SITE'
          ? fail('BAD_INPUT', 400, `认不出站点 ${siteKey}（插件那边的站点清单里没有它）`)
          : fail('NO_SOURCE', 400, `源 ${sourceId} 现在不可用（没在运行？）`);
        throw err;
      }
      error = e && e.name === 'AbortError' ? `超时(${timeout}ms)` : String((e && e.message) || e);
    }
    const list = (body && Array.isArray(body.list) && body.list) || [];
    return {
      wd: word,
      ms: Date.now() - t0,
      status,
      ok,
      error,
      count: list.length,
      /* 源的路由级 404：这个站没实现 /search（文案与上游 404 不同，实测可区分） */
      routeMissing: status === 404 && /Route POST:/i.test(text),
      timeout: /^超时/.test(error),
    };
  };

  /* 第一发用调用方给的词（缺省随机取一个），非 200 就**换一个词再测一发**（只重试一次） */
  const first = String(wd || '').trim() || pickProbeWord();
  let attempts;
  try {
    attempts = [await callSearch(first)];
    if (!attempts[0].ok) attempts.push(await callSearch(pickProbeWord(first)));
  } catch (e) {
    if (e && e.probeFail) return e.probeFail;
    throw e;
  }

  const last = attempts[attempts.length - 1];
  const tries = attempts.length;
  siteStats.recordSpeed(sourceId, siteKey, Object.assign({}, last, { tries }));

  return {
    ok: true,
    source: sourceId,
    key: siteKey,
    name: sourceName || sourceId,
    timeoutMs: timeout,
    initCalled,
    search: Object.assign({}, last, { tries }),
    attempts,
    stat: siteStats.view(sourceId, siteKey),
  };
}

module.exports = {
  fail,
  templates,
  ensureDomain,
  ensureTemplate,
  /** 作用域：`tpl`（web 按模板选）或 `domain`（客户端按域选）二选一，见函数说明 */
  scopeOf,
  loadSites,
  liveSources,
  detail,
  play,
  aggregateSearch,
  selectSites,
  probeSearch,
  SPEED_TEST_TIMEOUT_MS,
  PROBE_WORDS,
};
