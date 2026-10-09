'use strict';
/**
 * 聚合层路由（**多源**）：
 *   GET  /api/agg/sources 源清单（来自源插件的申报）
 *   GET  /api/agg/sites   源清单 + 站点清单（同一趟拿全；插件自己那个动作一次给齐）
 *   POST /api/agg/search  按片名并发搜**多个源的多个站源**，并**顺手打分**：
 *                         `{tpl?|domain?, wd, page?, year?, season?, episode?, minScore?, maxItems?, keys?}` →
 *                         出参里每个条目带 `score`/`matched`/`matchReason`，顶层给 `matched` 与
 *                         `unmatched`（**失败也回，带原因**）+ `match` 计数。打分口径见 `match.js`。
 *                         ⚠️ 作用域二选一：`tpl` = 直接点名一套模板（web 那页就是这么选的），
 *                         `domain` = 按域查（客户端那条路）；两者都落到同一份模板上（见 api.scopeOf）。
 *   POST /api/agg/detail  取某部影视的详情：**内部含搜索**（或 `source+site+vodId` 快路径），
 *                         把站源协议（`$$$` / `#` / `$`）拆成「线路 → 选集」，需要时可定位某一集；
 *                         有站拿到详情时随详情回一份 `subtitles`（字幕轨，`ref` 在出口剥掉）
 *                         （作用域同上：`tpl` 或 `domain` 二选一）
 *   POST /api/agg/play    按 `{tpl?|domain?, ref}` 取播放地址（`ref` 由源插件编，面板不解释它）
 *
 * 源清单与站点清单都**来自源插件**（`站点清单` 动作，见 `agg/source-bridge.js`）：
 * 面板这边不再有"聚合源配置"，也不再自己去打每个源的 `/config`。
 * 站点身份是 `(source, key)` 这一对：source 是「插件 id / 实例 id」，key 只在各自实例内唯一，
 * 跨实例同名是常事 —— 所以入参/出参里 source 与 key 是**两个字段**，绝不用裸 key 对齐。
 *
 * 本层只管 HTTP：解 body → 调 api → 按 `error.status` 决定状态码。
 * emby 层走的是同一个 api（见 api.js 的说明）。
 */
const { sendJson, sendError, readBody } = require('../../core/http');
const auth = require('../../core/auth');
const api = require('./api');
const stream = require('./stream');
const templates = require('./templates');
const providers = require('../../core/providers');
const registry = require('../../core/registry');
const siteTest = require('./site-test');
const { aggregateSearch, selectSites } = require('./service');

/** api 的失败形状（`{ok:false, error:{code,status,message}}`）→ HTTP */
function fail(res, out) {
  const e = out.error || {};
  return sendError(res, e.status || 400, e.message || '聚合层调用失败');
}

/**
 * 域表（`providers`）由元数据插件申报、由 emby 层按插件清单重建（见 emby/meta.js）。
 * 下面两条读它的端点（模板页 / 「域 → 模板」页）**读之前先顺手同步一次** ——
 * 不然面板跑着的时候装/启用了元数据插件，要等重启或碰一次 `/api/emby/*` 才看得见新域。
 * 与 server.js、emby/routes.js 同一口径：指纹短接，插件清单没变就什么都不做。
 */
function refreshDomains() {
  const emby = registry.get('emby');
  if (emby && typeof emby.ensureMetaProviders === 'function') emby.ensureMetaProviders();
}

module.exports = function routes(r) {

  /**
   * GET /api/agg/sources —— 源清单（前端"先渲染、后台探测"的第一遍）。
   *
   * ⚠️ 它现在也要**过插件**（源与站点都归源插件申报）：插件那边缓存着站点清单（一分钟），
   * 所以除了缓存到期那一发，这就是一次管道往返 —— 比原先"挨个打源的 `/config`"更快。
   * 形状与 `/api/agg/sites` 一致（都带 `ok/ms/siteCount`），不再有"探测 vs 不探测"之分。
   */
  r.add('GET', '/api/agg/sources', async (req, res) => {
    const { sources } = await api.loadSites();
    return sendJson(res, 200, { sources });
  });

  r.add('GET', '/api/agg/sites', async (req, res) => {
    refreshDomains();
    const { sources, sites } = await api.loadSites();
    const bad = sources.filter((s) => !s.ok);
    if (sources.length) {
      console.log(
        `  ✔ agg 站点清单 → ${sources.length} 个源 · ${sites.length} 个站点` +
          (bad.length ? `（${bad.length} 个源取不到：${bad.map((s) => s.id + ' ' + s.error).join('；')}）` : '')
      );
    }
    /* 站点表上要能看出**每个站点被哪几套模板用了**（否则以后查不清"为什么这个域用了这个站"，
     * 见 docs/adr/0033）。反查表在这里现算，不额外存一份。 */
    const tplList = templates.list();
    const usedBy = new Map();
    for (const t of tplList) {
      for (const x of t.sites) {
        const id = `${x.source}\u0001${x.key}`;
        if (!usedBy.has(id)) usedBy.set(id, []);
        usedBy.get(id).push({ id: t.id, name: t.name });
      }
    }
    return sendJson(res, 200, {
      sources,
      sites: sites.map((x) => Object.assign({}, x, { templates: usedBy.get(`${x.source}\u0001${x.key}`) || [] })),
      templates: tplList,
      domains: templates.domains(),
      /* 已注册的元数据域（前缀就是域 id）—— 由元数据插件注册，面板这一层不认识具体域（见 docs/adr/0031） */
      providers: providers.list().map((x) => ({ id: x.id, prefix: x.prefix, label: x.label, series: x.series })),
    });
  });

  /* ------------------------------- 模板：读 / 存 / 删 / 指给哪个域 */

  r.add('GET', '/api/agg/templates', (req, res) => {
    refreshDomains();
    return sendJson(res, 200, {
      templates: templates.list(),
      domains: templates.domains(),
      providers: providers.list().map((x) => ({ id: x.id, prefix: x.prefix, label: x.label, series: x.series })),
    });
  });

  r.add('POST', '/api/agg/templates', async (req, res) => {
    const body = (await readBody(req)) || {};
    let out;
    try {
      out = templates.save(body.template || body);
    } catch (e) {
      return sendError(res, 400, (e && e.message) || '模板保存失败');
    }
    console.log(`  ✔ agg 模板已保存「${out.name}」(${out.id})：${out.sites.length} 个站点`);
    return sendJson(res, 200, { template: out });
  });

  r.add('DELETE', '/api/agg/templates/:id', (req, res, { params }) => {
    const gone = templates.remove(params.id);
    if (!gone) return sendError(res, 404, '没有这份模板');
    console.log(`  · agg 模板已删除：${params.id}`);
    return sendJson(res, 200, { removed: params.id, domains: templates.domains() });
  });

  /** 把某个域指到某份模板上（`templateId` 传空 = 取消这个域的指向）。一个域最多一条对照。 */
  r.add('POST', '/api/agg/domains/:domain', async (req, res, { params }) => {
    const body = (await readBody(req)) || {};
    try {
      const map = templates.setDomain(params.domain, body.templateId);
      console.log(`  · agg 域 ${params.domain} → 模板 ${body.templateId || '(取消)'}`);
      return sendJson(res, 200, { domains: map });
    } catch (e) {
      return sendError(res, 400, (e && e.message) || '设置失败');
    }
  });

  r.add('POST', '/api/agg/search', async (req, res) => {
    const body = await readBody(req);
    if (!body || !String(body.wd || '').trim()) return sendError(res, 400, '请提供搜索关键字 wd');

    /* 作用域（参数与站点都来自那一套模板）：web「聚合搜索」页按**模板**选（`tpl`），
     * 客户端按**域**选（`domain`，由"域 → 模板"对照翻译）。**没配模板就如实为空并点名**（见 docs/adr/0033） */
    const dom = api.scopeOf(body);
    if (dom.error) return fail(res, dom.error);
    const cfg = dom.params;
    const { sources, sites } = await api.loadSites();
    if (!sources.length) return sendError(res, 400, '还没有可用的源：先在「插件」里装一个源插件，再到它的设置页里加一个实例');
    const picked = selectSites(sites, dom.selection, body.keys);
    if (!picked.length) {
      if (!api.liveSources(sources).length) {
        return sendError(res, 400, '所有聚合源都取不到站点：' + sources.map((s) => `${s.id} ${s.error || '未知错误'}`).join('；'));
      }
      return sendError(res, 400, '没有可聚合的站源：请到「模板」页把要用的站点勾进选中的那套模板');
    }

    const out = await aggregateSearch(sources, picked, {
      wd: body.wd,
      page: body.page || '1',
      timeoutMs: body.timeoutMs,
      concurrency: body.concurrency,
      /* 打分：`year` / `season` / `episode` 是"目标是哪部片"的信号（web 上填季集就是给它用），
       * `minScore` / `maxItems` 不传就用**这套模板**的参数。`minScore: 0` = 不按分数线筛选。 */
      want: { name: body.name || body.wd, year: body.year, season: body.season, episode: body.episode },
      matchOptions: { minScore: body.minScore, maxItems: body.maxItems, unmatchedMax: body.unmatchedMax },
      /* 参数与站点顺序都来自这套模板（上面已按模板解析过） */
      params: dom.params,
    });
    /* `ranked` 是"过关全量的排名"，只给聚合层内部（detail 的接续补打）用；
     * 回给前端等于把同一批条目再序列化一遍（响应大一倍），这里删掉。 */
    delete out.ranked;
    return sendJson(res, 200, out);
  });

  /**
   * 站点测速（**服务端异步任务**，实现见 `./site-test.js`）—— 「站点与参数」页那一列「延迟」的来源。
   *
   *   GET  /api/agg/site-test         进度 + 配置 + 上次/下次（前端据此画进度条与"上次测速"）
   *   POST /api/agg/site-test/start   开一轮；body 可带 `keys`（`{source,key}[]` = 只测这些站，
   *                                   缺省 = 全部站点）；上一次没跑完 → **409**（与猫源自动更新一致）
   *   POST /api/agg/site-test/stop    请求停止当前这一轮（已测完的结果照常保留）
   *
   * 为什么挪到服务端：一轮要打上百个站、按 3 并发跑几分钟。原先是前端逐站调、
   * 进度与中止都在浏览器里 —— 一关页面就断，而"每 6 小时自动测一轮""源起来后自动测一轮"
   * 这两件事本来就不可能是前端干的。
   */
  r.add('GET', '/api/agg/site-test', (req, res) => sendJson(res, 200, siteTest.state()));

  r.add('POST', '/api/agg/site-test/start', async (req, res) => {
    const body = (await readBody(req)) || {};
    const out = siteTest.start({ reason: 'manual', keys: Array.isArray(body.keys) ? body.keys : undefined });
    /* 撞上正在跑的一轮 → 409，别让前端以为"点了就跑起来了" */
    return sendJson(res, out.busy ? 409 : 200, out);
  });

  r.add('POST', '/api/agg/site-test/stop', (req, res) => sendJson(res, 200, siteTest.stop()));

  /**
   * POST /api/agg/site-test/one —— **单站测速**（站点表里那一行的小按钮）。
   *
   * body：`source` + `key`（+ 可选 `api`，站点清单里就有）。**同步**返回这一发的结果，
   * 并且**不碰后台任务**（不改它的进度、不重排自动测速）—— 它只把结果写进同一个统计槽，
   * 所以刷新出来的就是"当前测速结果"（也顺带把"因测速失败被跳过"的状态改掉）。
   * 会真的打上游（1~2 发 `/search`，单站最多 15 秒），所以按钮点击期间要禁用。
   */
  r.add('POST', '/api/agg/site-test/one', async (req, res) => {
    const out = await api.probeSearch((await readBody(req)) || {});
    if (!out.ok) return fail(res, out);
    return sendJson(res, 200, out);
  });

  /**
   * POST /api/agg/detail —— 取影视详情（**内部含搜索**）
   *
   * body：**tpl 或 domain（作用域二选一，决定用哪套模板）** / name（影视名，必填）/ year（消歧）/
   *       season + episode（定位某一集）/
   *       keys（限定站点，`{source,key}[]`）/ `source`+`site`+`vodId`（快路径：已知绑定就直查，跳过搜索）/
   *       minScore + maxItems（打分阈值与"最多留几条"，不传读设置）
   *       —— **没有 `all` 了：命中的站一律全取**（见 service.aggregateDetail）
   *       判据是 `match.js` 的打分（不再有上游反查）
   * 一律 200（每站的成败在 `sites[].ok` / `error` 里）—— 与 search 同一风格；
   * 只有"调用方搞错了"（没给 name、没配源、没勾站点）才 400。
   */
  r.add('POST', '/api/agg/detail', async (req, res) => {
    const out = await api.detail((await readBody(req)) || {});
    if (!out.ok) return fail(res, out);
    /* `subtitles[].ref` 是字幕插件编的取内容凭据，只给**进程内的 emby 层**用（它调 `agg.fetchSubtitle`）。
     * HTTP 出口（前端诊断台 / 外部插件）只拿得到"有哪些轨"，拿不到 `ref` —— 与 `/api/agg/search`
     * 出口删 `ranked` 同一口径：内部字段不外泄。 */
    if (Array.isArray(out.subtitles)) {
      out.subtitles = out.subtitles.map((s) => ({ lang: s.lang, format: s.format, label: s.label }));
    }
    return sendJson(res, 200, out);
  });

  /**
   * POST /api/agg/play —— 取播放地址
   *
   * body：**tpl 或 domain（作用域二选一，决定用哪套模板）** / **ref（版本 Id 里那段，必填）** /
   *       clientHost（客户端访问用的主机名，可选 —— emby 层会传）
   * 成功 200 `{ok:true, play:{urls, header, parse, nonHttp}}`；
   * 失败按原因给码（BAD_REQUEST 400 / NO_PLAY_URL 502 / 上游的码照搬 / …）。
   * 地址会过期：**每次播放都现取**，别缓存（缓存在插件自己那边）。
   */
  r.add('POST', '/api/agg/play', async (req, res) => {
    const out = await api.play((await readBody(req)) || {});
    return sendJson(res, out.ok ? 200 : (out.error && out.error.status) || 502, out);
  });

  /**
   * GET /api/agg/stream —— **外部客户端直接拉流**（FW/Rex widget 等）。
   *
   * 两种取法（同一条路径，见 `./stream.js` 头注）：
   *   ① `?domain=&ref=&token=` —— 按版本坐标取地址。`playVia` 由**出口插件**按契约的线路声明
   *      带过来（缺省 `client`）：`client` 非清单 302 / 清单 200 中继；`proxy` 由面板**代持鉴权头**
   *      中继（清单里的分片地址会被改写成面板子地址，见 ②）。
   *   ② `?seg=&sid=` —— ①里那份清单**改写出来的分片 / 子清单 / 密钥**地址，只认面板自己签的名
   *      （`core/auth.js` 的 `signStreamPart`），所以**不要求令牌**：它是面板发出去的子地址。
   *
   * 这条路径在 `core/auth.js` 的 `needsAuth` 里**豁免了面板 cookie 门禁**，改由**本路由自验凭证**
   * （① 同 `plugin/ingress.js` 的口径：query token / Bearer / X-Access-Token；② 验签名）。
   *
   * 搬运参数（`proxy` 档才用得上）可以在 URL 上带 `?threads=&chunkKB=` 覆盖这一次播放：
   * 优先级 URL 参数 > 源插件 `play` 返回 > 面板设置 `streamRelay` > 默认 16 路 / 512KB
   * （读取在 `stream.js` 的 `relayBytes` / `urlRelayParams`，这里不做转发，见 ADR-0045）。
   */
  r.add('GET', '/api/agg/stream', async (req, res, { query }) => {
    const seg = String(query.get('seg') || '').trim();
    if (seg) return stream.servePart(req, res, { seg, sid: String(query.get('sid') || '').trim() });

    /* 这条流入口的凭证统一是外部访问令牌（query token / Bearer / X-Access-Token） */
    if (!auth.verifyIngressToken(auth.ingressTokenOf(req, query))) {
      return sendError(res, 401, '这条流入口需要外部访问令牌（在插件设置页复制；或先登录面板）');
    }
    const domain = String(query.get('domain') || '').trim();
    const tpl = String(query.get('tpl') || '').trim();
    const ref = String(query.get('ref') || '').trim();
    if (!ref || (!domain && !tpl)) {
      return sendError(res, 400, '请提供 ref，以及 tpl 或 domain');
    }
    /* clientHost = 客户端访问面板用的主机名（本地实例回的是回环地址，源插件拿它换成客户端够得着的） */
    return stream.serveByRef(req, res, {
      domain,
      tpl,
      ref,
      playVia: String(query.get('playVia') || 'client').trim(),
      clientHost: req.headers.host || '',
    });
  });
};
