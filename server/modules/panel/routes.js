'use strict';
/**
 * 面板层路由（宿主层）
 *   /api/meta                     服务自述（外部可用它确认地址是不是一个面板、暴露了哪些模块）
 *   /api/modules                  模块总览（含每个模块消费的上游地址）
 *   /api/modules/:id/settings     每个模块自己的设置（通用端点，加模块不用改这里）
 *   /api/panel/info, /api/panel/notice, /api/panel/popup, /api/panel/backup|restore
 *   /api/auth/*                   面板鉴权：status / login / logout / password（见 core/auth.js）
 *   /api/logs                     面板日志（内存环形缓冲的读取/清空，见 core/logbus.js）
 */
const settings = require('../../core/settings');
const registry = require('../../core/registry');
const cachedb = require('../../core/cachedb');
const BRAND = require('../../core/branding'); // 备份文件名前缀（品牌短标识，与项目名一致）
/* 面板层的「缓存设置」要顺带显示**按插件记的聚合耗时**（ADR-0032 第 4 条）——
 * 那份账写在 `agg_stat`（agg/cache.js），所以这里直接读它。方向是单向的：
 * agg 层不 require panel（只 require core），不会转圈。 */
const cache = require('../agg/cache');
/* 「清除全部缓存」要**连插件的落盘缓存一起清** —— 那些路径只有插件模块知道
 * （`data/plugins/<类型>/<id>/data/` 是它管的），所以借它那一处，不在这里各拼一遍。 */
const pluginStore = require('../plugin/store');
const logbus = require('../../core/logbus');
const auth = require('../../core/auth');
const { sendJson, sendError, sendBuffer, readBody, readRawBody } = require('../../core/http');
const { DATA_DIR, SETTINGS_DIR } = require('../../core/paths');
const backup = require('./backup');
const update = require('./update');
const notice = require('./notice');
const popup = require('./popup');
const pkg = require('../../../package.json');

/**
 * 一次性搬迁（同款第二步）：缓存设置原来归 **emby 层**（`emby.json` 的 `cache.*`），
 * 现已归**面板层**（`panel.json` 的 `cache.*`）—— 因为面板这边的缓存跨两个库
 * （core 的 `data/cache/detail.db` 与 emby 的 `data/emby/cache.db`），
 * 用量/清空/淘汰要一把抓两个，设置跟着面板走才不会"面板管一半、模块管一半"。
 *
 * 规则：emby 那边**有这几个键**就搬过来（用户调过的数值不该静默丢失），随后清掉 emby 那段。
 * 面板这边已经有的值会被**覆盖成 emby 的** —— 搬迁只会在 emby 还在写这几个键时发生一次
 * （搬完就删），此后 emby 那份不再存在，是空操作。
 */
function migrateCacheFromEmby() {
  const emby = settings.read('emby') || {};
  const old = emby.cache;
  if (!old || typeof old !== 'object') return;

  /* ⚠️ 只搬**还在面板管**的那两项：元数据缓存那两个键已随元数据插件化归插件，
   * 面板这边不再有它们（盘上老值就留着，谁都不读它）。 */
  const keys = ['imageTtlDays', 'imageMaxMB'];
  const next = {};
  for (const k of keys) {
    if (old[k] !== undefined && old[k] !== null && old[k] !== '') next[k] = old[k];
  }
  if (Object.keys(next).length) settings.patch('panel', { cache: next });

  const embyNext = Object.assign({}, emby);
  delete embyNext.cache;
  settings.write('emby', embyNext);

  console.log(`  ↻ 缓存设置已从 emby 层搬到面板层：${Object.keys(next).join(' / ') || '(空)'}（面板「缓存设置」可改）`);
}

module.exports = function routes(r) {
  migrateCacheFromEmby();
  /* ---------------------------------------------------------------- 面板鉴权 */
  /* `/api/auth/*` 是**唯一不需要登录的面板接口**（见 core/auth.js 的 OPEN_PREFIXES）——
   * 登录、登出、以及当前登录状态（前端靠它决定显示登录框还是面板）。 */

  r.add('GET', '/api/auth/status', (req, res) =>
    sendJson(res, 200, {
      required: true,
      authed: auth.isAuthed(req),
      /* 还在用默认密码时前端显示一条提醒（只回布尔，不回密码/哈希） */
      isDefault: auth.isDefaultPassword(),
      minLength: auth.MIN_LEN,
    })
  );

  r.add('POST', '/api/auth/login', async (req, res) => {
    const body = await readBody(req);
    const out = auth.login(req, (body && (body.password || body.Password)) || '');
    if (out.error) return sendJson(res, out.locked ? 429 : 401, { error: out.error });
    res.setHeader('Set-Cookie', auth.cookieHeader(out.token, req));
    return sendJson(res, 200, { ok: true });
  });

  r.add('POST', '/api/auth/logout', (req, res) => {
    res.setHeader('Set-Cookie', auth.cookieHeader('', req));
    return sendJson(res, 200, { ok: true });
  });

  /** 改密码：要登录（门禁已保证），再验一次旧密码。**改完旧会话全部失效**（token 里签了密码指纹）。 */
  r.add('POST', '/api/auth/password', async (req, res) => {
    const body = await readBody(req);
    const out = auth.setPassword(String((body && body.oldPassword) || ''), String((body && body.newPassword) || ''));
    if (out.error) return sendJson(res, 400, { error: out.error });
    console.log('  🔑 面板密码已修改（旧会话已失效，请重新登录）');
    /* 顺手把当前这个 cookie 也清掉：让前端明确回到登录页，而不是"看起来还登着" */
    res.setHeader('Set-Cookie', auth.cookieHeader('', req));
    return sendJson(res, 200, { ok: true });
  });

  /* ---------------- 外部访问令牌（output 插件等外部程序用，见 core/auth.js）----------------
   * 只给**已登录面板**的人看 / 重置；外部程序本身拿令牌走插件自己声明的 ingress token 路径。
   *   GET  取（懒生成）  POST /reset 重置（老令牌立即失效）
   */
  r.add('GET', '/api/panel/ingress-token', (req, res) => sendJson(res, 200, { token: auth.getIngressToken() }));

  r.add('POST', '/api/panel/ingress-token/reset', async (req, res) => {
    await readBody(req);
    return sendJson(res, 200, { token: auth.resetIngressToken() });
  });

  r.add('GET', '/api/meta', (req, res) =>
    sendJson(res, 200, {
      service: 'mbp-panel',
      version: pkg.version,
      node: process.version,
      modules: registry.describe(settings.read),
    })
  );

  r.add('GET', '/api/modules', (req, res) => sendJson(res, 200, { modules: registry.describe(settings.read) }));

  /* 模块设置：一个模块一份文件，走同一组通用端点 */
  r.add('GET', '/api/modules/:id/settings', (req, res, { params }) => {
    if (!registry.get(params.id)) return sendError(res, 404, '模块不存在：' + params.id);
    return sendJson(res, 200, { id: params.id, settings: settings.read(params.id) });
  });

  r.add('PUT', '/api/modules/:id/settings', async (req, res, { params }) => {
    const mod = registry.get(params.id);
    if (!mod) return sendError(res, 404, '模块不存在：' + params.id);
    const body = await readBody(req);
    const next = settings.patch(params.id, body && body.settings ? body.settings : body);
    /* 设置变更钩子（可选）：让模块对"新配置"做点收尾 —— 例如 emby 按新上限立刻淘汰缓存
     * （见 emby/index.js onSettingsChange）。钩子出错不该让保存本身失败，所以吞掉。 */
    if (typeof mod.onSettingsChange === 'function') {
      try {
        mod.onSettingsChange(next, params.id);
      } catch {
        /* 收尾失败不影响保存结果 */
      }
    }
    return sendJson(res, 200, { id: params.id, settings: next });
  });

  r.add('DELETE', '/api/modules/:id/settings', (req, res, { params }) => {
    if (!registry.get(params.id)) return sendError(res, 404, '模块不存在：' + params.id);
    return sendJson(res, 200, { id: params.id, settings: settings.reset(params.id) });
  });

  /* 进程身份（进程启动时刻）：**模块加载时算一次** —— 必须在同一进程内恒定。
   * 不能每个请求现算（`Date.now() - uptime()` 毫秒取整会有 ±1ms 抖动，会被误认成新进程）。
   * 「面板重启」只换进程不换版本，前端靠它认出"回来的是个新进程"。 */
  const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1000).toISOString();

  /* 面板自身 */
  r.add('GET', '/api/panel/info', (req, res) =>
    sendJson(res, 200, {
      version: pkg.version,
      node: process.version,
      /* 见 PROCESS_STARTED_AT：「面板重启」等待判定的进程身份；pid 仅作展示/排查。 */
      pid: process.pid,
      startedAt: PROCESS_STARTED_AT,
      dataDir: DATA_DIR,
      settingsDir: SETTINGS_DIR,
      /* 仓库地址（「设置 → 关于」与「版本与更新」的 Release 链接都用它，见 update.js 的 repoInfo） */
      ...update.repoInfo(),
      modules: registry.describe(settings.read),
    })
  );

  /* ---- 「设置 → 关于」页内嵌的**公告**（见 notice.js）----
   * 内容取自仓库里的 `notice.html`，经镜像候选取回（与面板更新同一套，见 ADR-0067）。
   * **取不到 / 内容为空都回空串**，前端据此把整张卡去掉 —— 所以这里不返回错误码，
   * 失败原因只放在 `error` 里供排查。带 5 分钟缓存。 */
  r.add('GET', '/api/panel/notice', async (req, res) => sendJson(res, 200, await notice.get()));

  /* ---- 登录面板后的**弹窗**（见 popup.js）----
   * 内容与类型取自仓库里的 `popup.html`，经镜像候选取回（与面板更新同一套，见 ADR-0067）。
   * **取不到 / 内容为空都回空串**，前端据此不弹 —— 所以这里不返回错误码，失败原因只放在
   * `error` 里供排查。带 5 分钟缓存。 */
  r.add('GET', '/api/panel/popup', async (req, res) => sendJson(res, 200, await popup.get()));

  /* 备份：回一份 **zip 字节**（不是 JSON）。摘要放响应头，前端下载后凭它显示"含多少文件 / 多大"。
   * 范围与排除项见 backup.js 顶部注释（全部数据、不含缓存与应用代码）。
   * ⚠️ 摘要里的"多大"是**包的实际大小**（`out.size` = zip 字节数），不是内容原始字节和 ——
   *    两者实测差三倍多，拿错了界面上显示的数就与下载到的文件对不上。 */
  r.add('GET', '/api/panel/backup', (req, res) => {
    const out = backup.exportAll();
    /* 文件名前缀取品牌短标识（`branding.slug`）—— 与项目名一致，不写死；
     * 前端下载时用它拼带时间戳的名字（那份 branding 与这份成对，见 core/branding.js）。 */
    res.setHeader('Content-Disposition', `attachment; filename="${BRAND.slug}-backup.zip"`);
    res.setHeader('X-Backup-Files', String(out.files));
    res.setHeader('X-Backup-Size', String(out.size));
    res.setHeader('X-Backup-Exported-At', out.exportedAt);
    console.log(
      `  ↑ 面板数据备份：${out.files} 个文件 / ${Math.round(out.size / 1024)} KB` +
        `（内容未压缩 ${Math.round(out.contentBytes / 1024)} KB，不含缓存与应用代码）`
    );
    return sendBuffer(res, 200, out.buffer, 'application/zip');
  });

  /* 还原：请求体是备份 zip 的**原始二进制**（前端直接以 File 为 body），不做 JSON/base64 包装。
   * 上限放宽到 256MB —— 全量数据（含插件包本体）可能到几十 MB，默认 8MB 不够。 */
  r.add('POST', '/api/panel/restore', async (req, res) => {
    let raw = null;
    try {
      raw = await readRawBody(req, 256 * 1024 * 1024);
    } catch (e) {
      return sendError(res, 400, '备份文件读取失败：' + ((e && e.message) || String(e)));
    }
    if (!raw || !raw.length) return sendError(res, 400, '请求体为空，没有收到备份文件');
    try {
      const out = backup.restore(raw);
      console.log(`  ↻ 面板数据还原：${out.restored.join(' / ') || '(空)'}（重启后生效）`);
      return sendJson(res, 200, out);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      console.log(`  ✘ 面板数据还原失败：${msg}`);
      return sendError(res, 400, msg);
    }
  });

  /**
   * GET    /api/panel/cache     —— 缓存用量（面板「缓存设置」显示「已用 x / 上限 y」）
   * DELETE /api/panel/cache     —— 清空**面板那两份**缓存
   * DELETE /api/panel/cache/all —— 上面那份 **+ 各插件的落盘缓存**（见下面那条的说明）
   *
   * 建这个端点时缓存已跨两个库（原 `/api/emby/cache` 只有 emby 那张库）——
   *   core  `data/cache/lines.db`    line_cache（面板侧的**线路结果**）+ agg_stat（按插件的聚合耗时）
   *   emby  `data/emby/cache.db`     image_index（图片索引）
   * ⚠️ 插件自己的缓存不归这里（元数据插件、源插件各自的都在自己的数据目录里）—— 那是 `/all` 那条。
   * "清空"与"用量"**只能有一个入口**，否则以后加一张表就会漏清一处 —— 所以收敛到面板层，
   * 走 `core/cachedb.js` 的 `statsAll()` / `clearAll()`（各 store 自己登记，见那个文件）。
   * 清它**永远不动账号**（账号在 emby.db）—— 缓存出问题就删掉重建，这是当初分库的理由之一。
   */
  const cacheView = () => {
    const c = cachedb.cfg();
    const all = cachedb.statsAll();
    const img = ((all.image || {}).tables) || {};
    const lines = ((all.lines || {}).tables) || {};
    const one = (tbl, fallback) => Object.assign({ rows: 0, bytes: 0 }, tbl || fallback);
    const imgTbl = one(img.image_index);
    const lineTbl = one(lines.line_cache);
    return {
      /* 每组数字一一对应 UI 上那一行；`maxBytes`/`ttl*` 是**当前策略**（面板设置里可改）。
       * ⚠️ 插件自己的缓存在各自的设置页里看，不在这里。 */
      image: {
        rows: imgTbl.rows,
        bytes: imgTbl.bytes,
        maxBytes: c.imageMaxBytes,
        ttlDays: c.imageTtlMs / 86400000,
        path: (all.image || {}).path || '',
      },
      lines: {
        rows: lineTbl.rows,
        bytes: lineTbl.bytes,
        maxBytes: c.lineMaxBytes,
        /* 「长期有效」时 ttlMs 是个很远的数 —— 如实报出去，由 UI 决定怎么显示 */
        ttlMs: c.lineTtlMs,
        ttlForever: !!(((settings.read('panel') || {}).cache || {}).linesNeverExpire),
        path: (all.lines || {}).path || '',
      },
      /* 按插件记的**最近一次聚合耗时**（ADR-0032 第 4 条）：`{ <插件 id>: {ms, sites, at} }` */
      agg: cache.aggStats(),
    };
  };

  r.add('GET', '/api/panel/cache', (req, res) => sendJson(res, 200, cacheView()));

  r.add('DELETE', '/api/panel/cache', (req, res) => {
    cachedb.clearAll();
    console.log('  ✔ 缓存已清空（lines.db 线路结果、cache.db 图片索引；账号不受影响。插件自己的缓存在各自那边）');
    return sendJson(res, 200, cacheView());
  });

  /**
   * DELETE /api/panel/cache/all —— **清到底**：面板那两份 + 各插件的**落盘缓存**
   * （`plugin/store.js` 的 `clearCaches`：元数据/源插件的 `data/cache/`、首页插件的行结果
   * `data/storage.json`；设置与凭据不在这两处，清完不用重新登录）。
   *
   * 与上面那条分成两个入口的理由：清插件缓存要**删进插件的目录**，而缓存位置由插件自己定
   * （契约第十节）—— 只想清面板那份、不惊动插件时仍然用上面那条。
   * ⚠️ 插件进程里的内存态清不掉（如实：那要等它自己的有效期过去或重启那个插件）。
   */
  r.add('DELETE', '/api/panel/cache/all', (req, res) => {
    cachedb.clearAll();
    const pc = pluginStore.clearCaches();
    const which = pc.plugins.map((x) => `${(x.types || []).join('/')}/${x.id}`).join(' / ') || '（没有可清的）';
    console.log(`  ✔ 全部缓存已清空（面板：lines.db 线路结果、cache.db 图片索引；插件落盘缓存：${which}）`);
    return sendJson(res, 200, Object.assign({ plugins: pc }, cacheView()));
  });

  /* ---- 版本与更新（见 docs/adr/0019-self-update-from-release.md）----
   * GET  查版本（带 60 秒缓存；失败把原因放在 error 里，不抛）
   * POST 安装某个版本并请求监督者重启（`{"version":"1.1.0"}`，省略则装最新）
   * 只有受引导脚本托管时才允许安装：否则换掉代码也没人把新版本拉起来。
   */
  r.add('GET', '/api/panel/update', async (req, res, { query }) =>
    sendJson(res, 200, await update.status({ force: query.get('force') === '1' }))
  );

  r.add('POST', '/api/panel/update', async (req, res) => {
    if (!update.isManaged()) {
      return sendError(
        res,
        400,
        '当前不是由容器引导脚本托管的运行方式，面板无法自更新（直接跑源码时请自行更新并重启）'
      );
    }
    const body = await readBody(req);
    let version = String((body && body.version) || '').trim().replace(/^v/, '');
    try {
      if (!version) version = await update.resolveLatest({ force: true });
      const r0 = await update.install(version);
      update.requestRestart(version);
      console.log(`  ↻ 面板更新：已安装 ${r0.version}，即将重启到该版本`);
      return sendJson(res, 200, { ok: true, installed: r0.version, downloaded: r0.downloaded, restarting: true });
    } catch (e) {
      const msg = (e && e.message) || String(e);
      console.log(`  ✘ 面板更新失败：${msg}`);
      return sendError(res, 400, msg);
    }
  });

  /* ---- 面板重启 ----
   * 只把**应用进程**重起一遍，容器不动，版本不变：
   *   · 受托管（引导脚本）→ 写 `.restart` 再退出，由它按 `current.json` 拉起同一个版本；
   *   · 非托管（直接跑源码等）→ 退出前**自拉起**一个同代码的副本（见 update.js 的 `relaunchIfPending`）。
   * 只有带文件看护的启动方式（npm run dev / node --watch、nodemon）如实拒绝 —— 那套自己会重起子进程，
   * 与自拉起叠加就是两个进程抢端口（判据见 update.js 的 `restartRefusal`）。
   * `reason` 记成 restart，日志里与"更新触发的重启"区分得开（自更新那条路仍然只受托管时才允许）。 */
  r.add('POST', '/api/panel/restart', async (req, res) => {
    const refuse = update.restartRefusal();
    if (refuse) return sendError(res, 400, refuse);
    await readBody(req); // 请求体（若有）读掉，避免连接挂着
    const version = update.currentVersion();
    const managed = update.isManaged();
    update.requestRestart(version, 'restart');
    console.log(
      managed
        ? `  ↻ 面板重启：应用进程即将重起（版本 ${version}，容器不动）`
        : `  ↻ 面板重启：非托管运行方式，本进程退出前自拉起（版本 ${version}）`
    );
    return sendJson(res, 200, { ok: true, restarting: true, version });
  });

  /* ---------------- 面板日志（内存环形缓冲，见 core/logbus.js）----------------
   * 给「面板设置 → 日志」页看。**纯内存**：重启清空，长期留档看 `docker logs`。
   * ⚠️ 这两条**自己不打任何日志** —— 日志页每 2 秒轮询一次，打了会把日志量放大。 */
  r.add('GET', '/api/logs', (req, res, { query }) =>
    sendJson(res, 200, logbus.list({ since: query.get('since'), limit: query.get('limit') }))
  );

  r.add('DELETE', '/api/logs', (req, res) => {
    logbus.clear();
    return sendJson(res, 200, { ok: true });
  });

  /* 兼容层（`GET/PUT /api/settings` 那份聚合视图）已随源插件化删除：
   * 前端的「源托管」「聚合参数」「源列表」三页先后没了，没有调用方；
   * 而它读的 `agg.json`（`upstream.source` / `sources` / `enabled` / `order`）也都不再是设置的来源
   * —— 源与站点归源插件，站点与参数归模板（见 docs/plugin-migration-plan.md 批次 2 / 4）。 */
};
