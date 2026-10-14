'use strict';
/**
 * 媒体桥面板 · 入口（薄壳）
 *
 * 这里只做四件事：注册模块 → 搬迁旧设置 → 起 HTTP 服务 → 优雅关闭。
 * 所有业务端点都在 server/modules/<模块>/ 里，加模块只需往 MODULES 里加一行。
 */
const http = require('http');

const { serveStatic, sendError, sendJson, notFound } = require('./server/core/http');
const router = require('./server/core/router');
const settings = require('./server/core/settings');
const registry = require('./server/core/registry');
const { DATA_DIR } = require('./server/core/paths');
const logbus = require('./server/core/logbus');
const auth = require('./server/core/auth');
const pluginIngress = require('./server/modules/plugin/ingress');
const migrations = require('./server/core/migrations');
const BRAND = require('./server/core/branding');

/* ⚠️ **必须在加载模块之前装**（就在这一行）：模块顶层、路由注册、启动横幅都会打日志，
 * 装晚了那批就进不了「面板设置 → 日志」页。`logbus` 自己不碰 console，不会递归。
 * 条数上限先给默认值，等设置读完（下面 `settings.read('panel')`）再按 `logMax` 调一次。 */
logbus.install();

// ————————————————— 模块清单（加模块只改这里）—————————————————
const MODULES = [
  require('./server/modules/agg'), // 聚合层：多站并发聚合（取数转给源插件）
  require('./server/modules/emby'), // 消费层：待开发（基于聚合）
  require('./server/modules/plugin'), // 插件宿主：装/卸/启停 + 每插件一个常驻子进程（见 docs/adr/0028）
  require('./server/modules/panel'), // 宿主层：面板自身与模块总览
];

for (const m of MODULES) {
  if (m.settings) settings.define(m.id, m.settings);
  registry.register(m);
  if (typeof m.routes === 'function') m.routes(router);
}

/* 数据迁移 API（/api/migration/*）：平时只是一条查状态的路由，门禁触发时它是向导的后端。
 * 必须在 listen 前登记好 —— 迁移模式下面板仍 listen，只是不起业务（见 docs/adr/0047）。 */
migrations.registerRoutes(router);

/* 启动门禁：数据版本落后 / 超前时进入迁移模式。
 * 迁移模式下不 boot 插件、不起 Emby，业务 API 一律 503（前端只显示迁移向导）。 */
const migrationGate = migrations.evaluate();
if (migrationGate.phase !== 'ok') {
  console.log(
    `\n  ⚠ 数据迁移门禁：data v${migrationGate.dataVersion} / 代码 v${migrationGate.currentVersion}` +
      `（${migrationGate.phase === 'ahead' ? '数据版本超前' : '数据版本落后，等待迁移'}）`
  );
}

// 旧版单文件 data/settings.json → data/settings/<模块>.json
const migrated = settings.migrateLegacy();

const panel = settings.read('panel');
const WEB_PORT = Number(process.env.WEB_PORT || panel.port || 8088);
const WEB_HOST = process.env.WEB_HOST || panel.host || '0.0.0.0';

/* 面板端口上**只放行**两类 `/api/emby/*`：
 *   ① 面板自用端点（账号 / 实例 / 首页插件清单 / 元数据域清单）—— 要登面板，名单与 core/auth.js 的 needsAuth 同一份；
 *   ② `System/Info/Public` 这一条垫片 —— 老镜像的 HEALTHCHECK 与客户端探测打它。
 *
 * 其余全是 **Emby 客户端协议端点**，归**实例端口**（见 emby/listener.js）：面板端口与 Emby
 * 不再共用一个端口（决策见 .trae/documents/emby-多实例与首页切换-plan.md），
 * 这里在面板端口上把那些路径一律挡成 404 并指路。与 listener.js 的 PANEL_ONLY_RE 正好对称
 * —— 那边挡面板自用端点，这边挡客户端协议端点。 */
const EMBY_PANEL_ONLY_RE = [
  /^\/api\/emby\/accounts\b/,
  /^\/api\/emby\/instances\b/,
  /^\/api\/emby\/home-plugins\b/,
  /^\/api\/emby\/meta-domains\b/,
];

/**
 * **客户端回头来取的中继端点**（图片中继 / HLS 分片中继）。
 *
 * 它们是**面板自己签发出去的地址**（`Items/{id}/Images/Primary` 的 302、HLS 清单里改写出的分片），
 * 客户端照着取时落在**它连进来的那个端口**上 —— 只填面板端口的客户端就会打到面板端口来。
 * 与"面板自用端点"无关，两个端口都放行。
 *
 * ⚠️ 漏放的代价是静默的：客户端拿到 404，封面全空白 / 分片全断，而面板日志里只有一条 404 指路语。
 */
const EMBY_CLIENT_RELAY_RE = /^\/api\/emby\/(?:img|hls)\b/;

function embyServedOnPanelPort(pathname) {
  return pathname === '/api/emby/System/Info/Public'
    || EMBY_CLIENT_RELAY_RE.test(pathname)
    || EMBY_PANEL_ONLY_RE.some((re) => re.test(pathname));
}

/* 设置读完了，按 `panel.logMax` 落实日志缓冲条数（默认 500）。
 * `resize` 会清空缓冲但不重置序号 —— 这里紧跟着启动，丢掉的那几条本来就还没产生。 */
logbus.resize(panel.logMax);

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  let pathname = decodeURIComponent(parsed.pathname);

  /* Emby 兼容端点的**前缀归一化** —— 让"只填主机"和"填完整路径"两种配法都能用。
   *
   * 真机 Emby 把 API 挂在 `/emby/` 下，而本面板挂在 `/api/emby`。客户端的行为是
   * **给的主机没带 `/emby` 就自己补一层**（文档里那条真机样例：给的是裸域名，它打的是 `/emby/Shows/…`），
   * 所以只填 `http://<面板地址>:8088` 时它来的是 `/emby/...` —— 以前这里没路由，直接 404。
   * 这里统一成规范形态（`/api/emby/...`），三种填法于是都通：
   *
   *   `/emby/xxx`            → `/api/emby/xxx`    （只填主机，或填了 `…/emby`）
   *   `/api/emby/emby/xxx`   → `/api/emby/xxx`    （填了 `…/api/emby` 的客户端又多补了一层）
   *
   * 只动这两个前缀；`/api/agg`、静态文件、`/website` 等一律原样。写法放在最前面是为了
   * "进门禁与路由时路径已经是规范形态"，免得后面按前缀判断的地方各判一套。 */
  if (pathname === '/emby' || pathname.startsWith('/emby/')) {
    pathname = '/api/emby' + pathname.slice('/emby'.length);
  } else if (pathname === '/api/emby/emby' || pathname.startsWith('/api/emby/emby/')) {
    pathname = '/api/emby' + pathname.slice('/api/emby/emby'.length);
  }

  try {
    /* 面板自有健康检查：**永远 200、不属任何模块、不进门禁**。容器的 HEALTHCHECK 打它。
     *
     * 为什么要单开一条：Emby 兼容端点在多实例之后归**实例端口**（见 emby/listener.js），
     * 面板端口 8088 上那些端点是"面板自己的页面在用"，不能拿来做存活探针
     * （实例没起来 / 首页没选都会影响它）。这条只回答"这个进程还活着吗"。
     * ⚠️ 必须放在下面那道门禁**之前**：探针不带面板 cookie，被拦成 401 就是假告警。 */
    if (pathname === '/api/health') return sendJson(res, 200, { ok: true });

    // 面板接口（各模块注册的路由；插件宿主那几条也在其中）
    if (pathname.startsWith('/api/')) {
      /* 数据迁移门禁（见 docs/adr/0047）：非 ok 相位下只放行登录、迁移 API 与只读备份下载，
       * 其余业务接口一律 503 —— 前端见到 MIGRATION_REQUIRED 就铺全屏迁移向导，不起业务。
       * 静态壳（非 /api 路径）照常服务，向导页面本身要能打开。 */
      if (migrations.phase() !== 'ok') {
        const allowed =
          pathname.startsWith('/api/auth/') ||
          pathname.startsWith('/api/migration/') ||
          (req.method === 'GET' && pathname === '/api/panel/backup');
        if (!allowed) {
          return sendJson(res, 503, {
            error: '数据版本与面板代码不一致，需要先完成数据迁移（或确认强制启动）',
            code: 'MIGRATION_REQUIRED',
          });
        }
      }
      /* 插件 ingress 先判一道（单端口入口：/api/plugins/<类型>/<id>/(ui|api)/...）。
       * 插件在 plugin.json 里声明 public（匿名）/ token（外部令牌或面板 cookie）路径；
       * 名单外的路径返回 null，继续走下面的面板登录门禁 —— 默认收紧。 */
      const inr = pluginIngress.check(pathname, req, parsed.searchParams);
      if (inr && inr.access === 'deny') {
        return sendError(res, 401, inr.reason || '需要外部访问令牌');
      }
      if (!inr) {
        /* 面板门禁（单密码，见 core/auth.js）：**只拦面板自己的接口**。
         * `/api/auth/*` 由 auth.needsAuth 放行（不然登录不了）；`/api/emby/*` 下
         * 只有面板自用端点要登录（名单与 auth.needsAuth 同一份），客户端协议端点
         * 根本不在这里提供（见下面那条 404）。
         * ⚠️ 容器健康检查**不再走这里**：它打的是上面那条 `/api/health`（本进程存活即可）。 */
        const deny = auth.guard(req, res, pathname);
        if (deny) {
          res.setHeader('Set-Cookie', auth.cookieHeader('', req)); // 顺手清掉过期/无效的那个 cookie
          return sendError(res, 401, deny);
        }
      }
      /* 面板端口不再伺候 Emby 客户端协议（理由见上面 embyServedOnPanelPort）——
       * 放在门禁之后、路由之前：面板自用端点照旧要登录，客户端协议端点直接指路。 */
      if (pathname.startsWith('/api/emby/') && !embyServedOnPanelPort(pathname)) {
        return sendError(res, 404, 'Emby 客户端协议在**实例端口**上提供，不在面板端口；连接地址见面板「Emby → 实例」页');
      }
      /* Emby 客户端打进来的请求：顺手同步一次**元数据域表** ——
       * "装/启用了元数据插件"这件事要当场生效，不该等到重启面板（认哪个前缀由插件说了算，
       * 见 core/providers.js 与 emby/meta.js；读一次插件清单，没变就什么都不做）。 */
      if (pathname.startsWith('/api/emby/') && embyModule && typeof embyModule.ensureMetaProviders === 'function') {
        embyModule.ensureMetaProviders();
      }
      return await router.handle(req, res, { pathname, searchParams: parsed.searchParams });
    }
    // 其余一律当作 public/ 下的静态文件（含 core/ modules/ docs/ styles/ 子目录）
    if (serveStatic(req, res, pathname)) return;
    return notFound(res);
  } catch (e) {
    const code = e.code === 404 ? 404 : e.code === 400 ? 400 : 500;
    return sendError(res, code, e.message || '服务器内部错误');
  }
});

const aggModule = registry.get('agg');
const embyModule = registry.get('emby');
const pluginModule = registry.get('plugin');
const panelModule = registry.get('panel');

/**
 * 业务启动序列（门禁放行后才跑）。
 *
 * 正常启动时在 listen 回调里跑；数据迁移在进程内跑完后由 migrations 框架回调这同一个函数 ——
 * 不依赖容器 / 进程重启（见 docs/adr/0047）。只允许跑一次（迁移完成那次）。
 */
let businessBooted = false;
async function bootBusiness() {
  if (businessBooted) return;
  businessBooted = true;
  /* 站点测速的开机计时（接线在这儿做，理由见 agg/site-test.js 顶部）：
   * 默认每 6 小时自动一轮，2 分钟后先跑一次。
   * ⚠️ 原先还有"某个源起来就测一轮它的站点"那条 —— 源实例现在活在源插件里，
   * 面板收不到"它起来了"，已随源插件化去掉（开机那一轮会覆盖自启的实例）。 */
  if (aggModule && typeof aggModule.startSiteTest === 'function') aggModule.startSiteTest();
  /* 插件：拉起所有**启用中**的插件（见 modules/plugin/index.js 的 autostart）。失败不挡面板启动。
   * ⚠️ **源实例由源插件自己起**（它自己的"开机自启"那份逻辑），不在这里管。 */
  if (pluginModule && typeof pluginModule.autostart === 'function') await pluginModule.autostart();
  /* emby 层：把各首页插件的行清单预热进面板内存快照（免得开机后第一发 `Views` 拿到空）。
   * **必须排在插件起来之后** —— 它要调 home 插件的 `rows` 动作（见 emby/index.js warmHome）。
   * 失败不挡面板启动。 */
  if (embyModule && typeof embyModule.warmHome === 'function') await embyModule.warmHome();
  /* Emby 实例：每个启用中的实例在**它自己的端口**上挂一个监听（见 emby/listener.js）。
   * **必须排在上面的 warmHome 之后** —— 清单首次生成时要读插件清单挑一个首页插件（instance.migrate），
   * 插件没起来就挑不到。单个实例的端口被占只记运行态、**不挡面板启动**（面板上红字提示）。 */
  if (embyModule && typeof embyModule.startListeners === 'function') await embyModule.startListeners();
  /* 元数据域表：插件的清单与开关决定"哪些条目 Id 前缀认得出来"（见 core/providers.js 与 emby/meta.js）。
   * 必须排在插件起来之后；再顺手把每个域的声明拉一份（图片基地址这类值早一点就是对的）。 */
  if (embyModule && typeof embyModule.syncMetaProviders === 'function') {
    embyModule.syncMetaProviders();
    if (typeof embyModule.warmMeta === 'function') {
      try {
        await embyModule.warmMeta();
      } catch (e) {
        console.log('  ✘ 元数据域声明读取失败（面板继续）：' + ((e && e.message) || e));
      }
    }
  }
  /* 更新即完整替换：**每次启动成功后**清掉当前版本之外的版本目录（旧版本不留档，也不作本地回退，
   * 决策见 docs/adr/0021-update-replaces-app-dir.md）。它自己会延迟几秒再动手，
   * 也会在非受管运行方式下跳过（直接跑源码时数据目录里的 app/ 不该被动）。 */
  if (panelModule && typeof panelModule.pruneOnBoot === 'function') panelModule.pruneOnBoot();
}

/* 迁移（或超前强制启动）在进程内完成后，直接在本进程拉起业务，不要求重启进程/容器。 */
migrations.onReady(bootBusiness);

server.listen(WEB_PORT, WEB_HOST, async () => {
  /* 名字读 core/branding.js（改名只改那一处 + 前端那份 + package.json + index.html 兜底）；
   * 依既定决策**不摆图标**，所以这里与顶栏都只有文字。 */
  console.log(`\n  ${BRAND.panelName}已启动`);
  console.log(`     面板地址: http://127.0.0.1:${WEB_PORT}`);
  console.log(`     数据目录: ${DATA_DIR}`);
  console.log(`     模块: ${registry.list().map((m) => m.id).join(' · ')}`);
  if (migrated) console.log(`     ↻ 设置已拆分: settings.json → ${migrated.to}（旧文件留档 ${migrated.backup}）`);
  console.log('');
  if (migrationGate.phase === 'ok') {
    await bootBusiness();
  } else if (migrationGate.phase === 'migrate' && !migrations.needsDecision()) {
    /* 预检没有要人决定的事 → 启动时就静默迁移，再启业务（见 docs/adr/0047 第 4 节）。
     * 无人值守升级 / 全新安装因此不必等有人打开面板点一下。
     * ⚠️ run() 跑完会在进程内回调 bootBusiness()，这里**不要再叫一次**；
     * 失败则退回"迁移模式"（HTTP 只留静态壳与迁移 API），下次启动还会重试 —— 步骤是幂等的。 */
    console.log('  ⏳ 数据版本落后且预检无冲突：自动迁移中…');
    try {
      const out = await migrations.run({});
      const chain = (out.ran || []).map((v) => 'v' + v).join(' → ') || '无待办任务';
      console.log(`  ✔ 自动迁移完成（${chain}），业务已启动。\n`);
    } catch (e) {
      console.error('  ✘ 自动迁移失败（退回迁移模式，可在面板向导里处置）：' + ((e && e.message) || e));
    }
  } else {
    /* 迁移模式：HTTP 只留静态壳 + /api/migration/*（+登录与只读备份），业务全部不启动。
     * 用户在向导里跑完迁移后，migrations 框架会在进程内回调 bootBusiness()。 */
    console.log('  ⏸ 迁移模式：插件 / Emby / 聚合均未启动，请在面板向导里完成数据迁移。\n');
  }
});

/* 进程级兜底：**一个请求出问题不该把整个面板带走**。曾出现过整进程退出 ——
 * 代理拉流被 `AbortSignal.timeout` 掐断，body 流上的 'error' 无人监听，进程随之退出。
 * 这里只记录 + 继续跑：不静默吞掉（日志里有完整堆栈），也不自杀。 */
process.on('uncaughtException', (e) => {
  console.error('  ✘ 未捕获异常（已拦截，服务继续）：' + ((e && e.stack) || e));
});
process.on('unhandledRejection', (e) => {
  console.error('  ✘ 未处理的 Promise 拒绝（已拦截，服务继续）：' + ((e && e.stack) || e));
});

/**
 * 真正退出：**只做一次**（server.close 的回调与下面那个兜底定时器都会走到这里）。
 * 顺序很关键 —— 先让 `relaunchIfPending` 把"重启自己"的副本拉起来，再 `process.exit`：
 * 到这一步监听已经关了（`server.close()` 一调用就放开端口，`stopListeners()` 放开了实例端口），
 * 副本这时起来才不会撞端口。托管运行方式下它什么都不做（由引导脚本拉起）。
 */
let quitting = false;
function finishQuit() {
  if (quitting) return;
  quitting = true;
  if (panelModule && typeof panelModule.relaunchIfPending === 'function') {
    try {
      panelModule.relaunchIfPending();
    } catch (e) {
      console.error('  ✗ 自拉起新进程失败（面板即将退出，请手动重起进程）：' + ((e && e.message) || e));
    }
  }
  process.exit(0);
}

async function shutdown() {
  /* Emby 实例的监听（每个一个 http.Server）先关 —— 它们挂在同一个进程里，
   * 不关就会在 `server.close()` 之后继续占着那些端口（见 emby/listener.js）。 */
  if (embyModule && typeof embyModule.stopListeners === 'function') {
    try {
      embyModule.stopListeners();
    } catch (e) {
      console.error('  ✗ 停止 Emby 实例监听失败：' + e.message);
    }
  }
  /* 插件子进程（含源插件**自己**起的那些源实例）由**宿主**直接终止 —— 见 docs/adr/0028：
   * 宿主杀了插件，插件自己起的进程也跟着没（它的子进程挂在它下面）。
   * 插件要额外清理的东西，由它在收到停止指令时自行处理。 */
  if (pluginModule && typeof pluginModule.stopAll === 'function') {
    try {
      const n = pluginModule.stopAll().length;
      if (n) console.log(`  已停止 ${n} 个插件进程`);
    } catch (e) {
      console.error('  ✗ 停止插件失败：' + e.message);
    }
  }
  server.close(finishQuit);
  setTimeout(finishQuit, 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
