'use strict';
/**
 * Emby 实例监听器
 *
 * 每个**启用中**的实例在它自己的端口上挂一个 http 服务（与面板同一 Node 进程，理由见
 * `instance.js` 顶部那段）：客户端填 `http://<面板主机>:<实例端口>` 就能连上，
 * Emby 给客户端用的地址不再与面板本体端口混用。
 *
 * 与面板端口上那一套的两点不同：
 *   ① **只伺候 Emby 客户端协议** —— 实例端口不放行面板自用端点
 *      （`/api/emby/accounts`、`/api/emby/instances`、`/api/emby/home-plugins`、`/api/emby/meta-domains`：
 *      那些要登面板，见 core/auth.js 的 needsAuth，客户端没有面板 cookie）；
 *   ② 每个请求都包在 `instance.runWith(inst, …)` 里 —— 下游（service.js / db.js / home）
 *      靠这份上下文认"这是哪个实例"，账号、会话、进度、首页插件全跟着它走。
 *
 * 路径归一化：前两条与面板端口一致（`/emby/xxx` 与 `/api/emby/emby/xxx` 都收成 `/api/emby/xxx`），
 * 这样"只填主机"的客户端照旧能用；本端口**多一条根路径兜底**（非 `/api/` 开头的一律当 Emby 根路径，
 * 见 `normalize` 注释）——面板端口根部是面板 UI，不能这么做，故这条只在这里。
 *
 * 端口被占**不拖垮面板**：记一行日志 + 在清单里标 `error`（面板「Emby → 实例」上红字提示），
 * 面板本体照常起。
 */
const http = require('http');

const router = require('../../core/router');
const { sendError } = require('../../core/http');
const instance = require('./instance');
const meta = require('./meta');

/** 面板自用端点：实例端口一律不提供（它们只在面板端口上、走面板门禁） */
const PANEL_ONLY_RE = [
  /^\/api\/emby\/accounts\b/,
  /^\/api\/emby\/instances\b/,
  /^\/api\/emby\/home-plugins\b/,
  /^\/api\/emby\/meta-domains\b/,
];

/** iid → { inst, server, port, error } */
const listeners = new Map();

/** 前两条与 server.js 同一套前缀归一化（这两条必须一致，否则"只填主机"的客户端在一处通、另一处不通）；
 * 第三条是本端口独有的**根路径兜底**（见下）。 */
function normalize(pathname) {
  if (pathname === '/emby' || pathname.startsWith('/emby/')) return '/api/emby' + pathname.slice('/emby'.length);
  if (pathname === '/api/emby/emby' || pathname.startsWith('/api/emby/emby/')) {
    return '/api/emby' + pathname.slice('/api/emby/emby'.length);
  }
  /* 根路径兜底：真机 Emby 的端点本就挂在根路径（`/videos/…`、`/Items/…`、`/Videos/…`，见
   * emby-realdevice #12），有些客户端（实测 HamHub/1.0）拿到面板下发的**根相对**地址后
   * **按 origin 解析**（RFC 3986：根相对替换整个 path），把 `/emby` 丢掉、不带前缀地打上来。
   * 面板端口根部是面板自己的 UI，不能这么映射；实例端口只伺候 Emby，非 `/api/` 开头的一律
   * 当 Emby 根路径收下（面板自用端点仍由下面的 PANEL_ONLY_RE 挡掉）。 */
  if (!pathname.startsWith('/api/')) return '/api/emby' + pathname;
  return pathname;
}

async function handle(inst, req, res) {
  const parsed = new URL(req.url, 'http://127.0.0.1');
  const pathname = normalize(decodeURIComponent(parsed.pathname));
  try {
    if (!pathname.startsWith('/api/emby/')) {
      return sendError(res, 404, '这个端口只伺候 Emby 客户端协议；面板自己的页面与接口在面板端口上');
    }
    if (PANEL_ONLY_RE.some((re) => re.test(pathname))) {
      return sendError(res, 404, '这条是面板自用端点，只在面板端口上提供（要登录面板）');
    }
    /* 与面板端口一致：装 / 启用元数据插件当场生效（读一次插件清单，没变就什么都不做） */
    meta.ensureProviders();
    return await instance.runWith(inst, () => router.handle(req, res, { pathname, searchParams: parsed.searchParams }));
  } catch (e) {
    const code = e.code === 404 ? 404 : e.code === 400 ? 400 : 500;
    return sendError(res, code, e.message || '服务器内部错误');
  }
}

/** 起一个实例的监听；已经在同一端口上听着就什么都不做。**永不抛**：失败如实回 { ok:false, error } */
function start(inst) {
  if (!inst || !inst.enabled) return Promise.resolve({ ok: false, error: '实例未启用' });
  const port = Number(inst.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return Promise.resolve({ ok: false, error: '端口不合法' });

  const hit = listeners.get(inst.id);
  if (hit && hit.port === port && hit.server.listening) return Promise.resolve({ ok: true });

  stop(inst.id);

  const server = http.createServer((req, res) => {
    void handle(inst, req, res);
  });
  const entry = { inst, server, port, error: '' };
  listeners.set(inst.id, entry);

  return new Promise((resolve) => {
    const fail = (e) => {
      entry.error = e && e.code === 'EADDRINUSE' ? `端口 ${port} 被占用` : (e && e.message) || '监听失败';
      console.log(`  ✘ Emby 实例「${inst.name}」未能监听 ${port}：${entry.error}（面板继续）`);
      try {
        server.close();
      } catch {
        /* 没起来就没什么可关 */
      }
      resolve({ ok: false, error: entry.error });
    };
    server.once('error', fail);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', fail);
      /* 起来之后再出错（罕见）只记日志：已经给过客户端响应，不该把进程带走 */
      server.on('error', (e) => console.log(`  ✘ Emby 实例「${inst.name}」（${port}）监听出错：${(e && e.message) || e}`));
      entry.error = '';
      console.log(`  ✔ Emby 实例「${inst.name}」监听 ${port}（首页插件 ${inst.homePlugin || '未选择'}）`);
      resolve({ ok: true });
    });
  });
}

/** 停一个实例的监听；没在跑就是空操作 */
function stop(iid) {
  const entry = listeners.get(String(iid || '').trim());
  if (!entry) return false;
  listeners.delete(entry.inst.id);
  try {
    entry.server.close();
  } catch {
    /* 已经关了 */
  }
  return true;
}

/** 改端口 / 改启停之后重开：先停再起（端口变了必须重开） */
async function restart(iid) {
  const inst = instance.get(iid);
  stop(iid);
  if (!inst) return { ok: false, error: '没有这个实例' };
  return start(inst);
}

function stopAll() {
  for (const iid of Array.from(listeners.keys())) stop(iid);
}

/** 各实例的运行态（面板列表用）：`{ [iid]: { running, port, error } }` */
function states() {
  const out = {};
  for (const [iid, e] of listeners) {
    out[iid] = { running: e.server.listening, port: e.port, error: e.error || '' };
  }
  return out;
}

/** 面板启动时：先把实例清单补出来（老装法首次启动要迁移），再把启用中的逐个起上 */
async function startAll() {
  instance.migrate();
  const list = instance.list();
  for (const inst of list) {
    if (!inst.enabled) {
      console.log(`  · Emby 实例「${inst.name}」已停用（${inst.port}），不监听`);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    await start(inst);
  }
  const n = Object.values(states()).filter((x) => x.running).length;
  if (n) console.log(`  · Emby 实例：${n} 个已在各自端口上监听`);
}

module.exports = {
  normalize,
  start,
  stop,
  restart,
  startAll,
  stopAll,
  states,
};