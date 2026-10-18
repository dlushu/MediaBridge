'use strict';
/**
 * Emby 实例注册表 + **请求级实例上下文**
 *
 * 面板支持**多个 Emby 实例**：每个实例有自己的端口（见 `listener.js`）、自己的账号 / 会话 / 播放进度
 * （各自一个 sqlite 文件）、自己选定的首页插件（见 `home/index.js`）。这份清单是**面板侧的唯一真源**：
 *   `data/emby/instances.json`
 *
 * 为什么不进 settings：settings 是"配置项"（有 defaults/fields/validate 与通用读写端点），
 * 而实例是"实体"（要增删改、要分配端口、要各挂一个库文件）—— 两件事混在一起会互相拖累。
 * 与 `db.js` 对账号的处理是同一个理由。
 *
 * **实例怎么贯穿到下层**：用 `AsyncLocalStorage`（`node:async_hooks`）。
 * `service.js` 里 `serverId()` / `serverName()` / `imageKey()` 与 `db.js` 的取库都靠
 * `current()` 拿当前实例 —— 这样 `service.js` 那几千行调用点一个字都不用改。
 * 为什么不用普通全局变量：下游有 `await` 上游请求，并发请求之间会串味；
 * ALS 是"跟着这条异步调用链走"的，串不了。
 *
 * 没有上下文时（面板自用端点在面板端口上直接调 service/db）回落清单里的 `default`，
 * 再退回第一条；**一条实例都没有时回 null** —— 全新安装不再自动建实例（见 `migrate`），
 * 调用方按"没有可用实例"处理。
 */
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('node:async_hooks');

const { EMBY_DIR } = require('../../core/paths');
const settings = require('../../core/settings');
const BRAND = require('../../core/branding');

/** 实例清单文件（含 serverId / imageKey，不要外发） */
const INSTANCES_FILE = path.join(EMBY_DIR, 'instances.json');

/** 迁移出来的那个实例的 id —— 老数据（`data/emby/emby.db`）挂在它身上，只此一处会用到它 */
const DEFAULT_ID = 'default';

/** 端口留空时从这个值起往上找第一个空闲的（被占了就 +1，不设上限） */
const PORT_START = 8090;

/** 一份实例清单最多这么多条 —— 端口与 sqlite 句柄都跟着涨，得有个头 */
const MAX_INSTANCES = 8;

const INSTANCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** 首页插件 id 的合法形状 —— 与 `home/index.js` 的 `PLUGIN_ID_RE` 同一套（插件 id 允许 `.`/`_`/`-`） */
const PLUGIN_ID_RE = /^[a-z][a-z0-9._-]{1,63}$/i;

/** 元数据域前缀的合法形状 —— 与 `core/providers.js` 的 `PREFIX_RE` 同一套（只允许字母数字，首字符为字母） */
const DOMAIN_RE = /^[a-z][a-z0-9]*$/i;

/** 一个实例最多能限定这么多个搜索域（域本身就少，给个上界防脏数据） */
const MAX_META_DOMAINS = 32;

const als = new AsyncLocalStorage();

/** 清单的内存副本（惰性加载一次）；写盘后同步更新 */
let store = null;

/* 打开的 sqlite 句柄：`dbFile` → DatabaseSync。一个实例一个库，删实例时一起关掉。 */
const handles = new Map();

/* ------------------------------------------------------------------ 读写盘 */

function validInstance(x) {
  return !!x && typeof x === 'object' && INSTANCE_ID_RE.test(String(x.id || '')) && typeof x.dbFile === 'string' && x.dbFile;
}

/** 读清单；文件没有 / 坏了都当作"还没建"，交给 migrate() 生成 */
function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(INSTANCES_FILE, 'utf8'));
    const list = Array.isArray(raw && raw.instances) ? raw.instances.filter(validInstance) : [];
    if (list.length) return { version: 1, instances: list };
  } catch {
    /* 首次启动（文件不存在）或文件损坏 —— 都走迁移 */
  }
  return null;
}

function load() {
  if (store) return store;
  store = read();
  if (!store) {
    store = { version: 1, instances: [] };
    migrate();
  }
  return store;
}

/** 原子写：先写临时文件再 rename，避免写一半断电留下半个 JSON */
function save() {
  const s = load();
  fs.mkdirSync(EMBY_DIR, { recursive: true });
  const tmp = `${INSTANCES_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, INSTANCES_FILE);
  try {
    fs.chmodSync(INSTANCES_FILE, 0o600); // 含 serverId / imageKey，别让同机其它用户读
  } catch {
    /* 平台不支持就算了，不因此起不来 */
  }
  return s;
}

/* ------------------------------------------------------------------ 迁移 */

/**
 * 把老的**单实例**数据接过来 —— **只有盘上确实留着老痕迹时才接**。
 *
 * 命中任一判据即迁移：
 *   ① `settings/emby.json` 里留着老的单实例字段（serverName / serverId / imageKey / port）；
 *   ② `data/emby/emby.db` 已经存在（老账号与观看进度都在里面）。
 * 两条都不命中 = 全新安装，**一条实例都不建** —— 需要时在「Emby → 实例」页自己加，
 * 端口留空就从 `PORT_START` 起自动挑一个。
 *
 * **数据原地不动**：`dbFile` 指向老的 `emby.db`，账号与进度一个都不搬。
 * `homePlugin` 取**第一个启用中的首页插件** —— 老版本是"所有启用插件的所有行全量叠加"，
 * 升级后总得指定一个，不指定就等于客户端突然库全空（比"只留一个"更糟）。
 * 调用时机必须**在插件起来之后**（见 `emby/index.js` 的 startListeners），否则读不到插件清单。
 *
 * 幂等：清单里已经有实例就什么都不做。
 */
function migrate() {
  const s = load();
  if (s.instances.length) return s;

  const old = settings.read('emby') || {};
  const oldPort = Number(old.port);
  const hasOldSettings = !!(String(old.serverName || '').trim() || String(old.serverId || '').trim() || String(old.imageKey || '').trim() || oldPort > 0);
  if (!hasOldSettings && !fs.existsSync(path.join(EMBY_DIR, 'emby.db'))) return s;

  const firstHome = firstEnabledHomePlugin();
  s.instances.push({
    id: DEFAULT_ID,
    name: String(old.serverName || '').trim() || BRAND.embyServerName,
    port: oldPort > 0 ? oldPort : PORT_START,
    enabled: true,
    /* 下载开关：默认开（老装法沿用「能下载」，客户端行为不变） */
    allowDownload: true,
    homePlugin: firstHome,
    serverId: String(old.serverId || '').trim(),
    imageKey: String(old.imageKey || '').trim(),
    dbFile: 'emby.db',
    createdAt: new Date().toISOString(),
  });
  save();
  console.log(
    `  ↻ Emby 实例清单已生成：${DEFAULT_ID}（端口 ${s.instances[0].port}，沿用原 emby.db，` +
      `首页插件 ${firstHome || '未选择'}）`
  );
  return s;
}

/** 第一个启用中的首页插件 id（读插件宿主的清单；插件还没起来就回空串） */
function firstEnabledHomePlugin() {
  try {
    const host = require('../plugin/host'); // 延迟 require：启动顺序上插件模块可能还没装配完
    const st = host.states().find((x) => x.type === 'home' && x.enabled && x.id);
    return st ? st.id : '';
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ 上下文 */

/** 当前请求所属的实例；不在任何实例上下文里就回落清单里的第一条（老装法命中 `default`） */
function current() {
  const inst = als.getStore();
  if (inst) return inst;
  const s = load();
  return s.instances.find((x) => x.id === DEFAULT_ID) || s.instances[0] || null;
}

/** 把这条异步调用链标记成"属于 inst" —— listener.js 每个请求包一次 */
function runWith(inst, fn) {
  return als.run(inst, fn);
}

/* ------------------------------------------------------------------ 清单 */

function list() {
  return load().instances.map((x) => ({ ...x }));
}

function get(iid) {
  const id = String(iid || '').trim();
  if (!INSTANCE_ID_RE.test(id)) return null;
  return load().instances.find((x) => x.id === id) || null;
}

/** 对外一份（不含 dbFile 这类内部路径）—— 面板列表用 */
function publicInstance(x) {
  if (!x) return null;
  return {
    id: x.id,
    name: x.name,
    port: x.port,
    enabled: !!x.enabled,
    /* 下载开关：字段缺席 = 开（老实例升级后保持「能下载」） */
    allowDownload: x.allowDownload === undefined ? true : !!x.allowDownload,
    /* 「隐藏未播集」：字段缺席 = 开（老实例升级后默认获得该行为，与真机一致） */
    hideUnairedEpisodes: x.hideUnairedEpisodes === undefined ? true : !!x.hideUnairedEpisodes,
    homePlugin: x.homePlugin || '',
    /* 搜索通过的域：回副本不回引用；**null = 全部**（字段缺席，老实例与未限定时的口径） */
    metaDomains: Array.isArray(x.metaDomains) ? x.metaDomains.slice() : null,
    isDefault: x.id === DEFAULT_ID,
    createdAt: x.createdAt,
  };
}

function normName(v) {
  return String(v === undefined || v === null ? '' : v).trim();
}

/**
 * 归一化「搜索通过的域」清单：trim → 小写 → 去重（空项与形状不合法的项丢弃，形状校验在 `validate` 里）。
 * 统一存小写，与 `core/providers.byPrefixOf` 的大小写不敏感口径对齐。
 */
function normDomains(v) {
  const out = [];
  for (const x of Array.isArray(v) ? v : []) {
    const d = normName(x).toLowerCase();
    if (d && DOMAIN_RE.test(d) && !out.includes(d)) out.push(d);
  }
  return out;
}

/**
 * 面板本体端口 —— 实例不能占用它（面板与实例挂在同一个进程里，占了就起不来）。
 * 取值口径与 `server.js` 的 `WEB_PORT` 保持一致：环境变量 → 面板设置 → 默认值。
 */
function panelPort() {
  const env = Number(process.env.WEB_PORT);
  if (Number.isInteger(env) && env > 0) return env;
  const p = Number(settings.read('panel').port);
  return Number.isInteger(p) && p > 0 ? p : 8088;
}

/** 校验一份"要写进去的字段"；返回错误文案或 null */
function validate(o, self) {
  if (!o || typeof o !== 'object') return '请求体必须是对象';
  if (o.name !== undefined) {
    const n = normName(o.name);
    if (!n) return '实例名不能为空';
    if (n.length > 40) return `实例名最长 40 个字符（当前 ${n.length} 个）`;
  }
  if (o.port !== undefined) {
    const p = Number(o.port);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return '端口必须是 1-65535 的整数';
    if (p === panelPort()) return `${p} 是面板本体端口，Emby 实例不能占用它`;
    const taken = load().instances.find((x) => x.port === p && (!self || x.id !== self.id));
    if (taken) return `端口 ${p} 已被实例「${taken.name}」占用`;
  }
  if (o.homePlugin !== undefined) {
    const h = normName(o.homePlugin);
    if (h && !PLUGIN_ID_RE.test(h)) return '首页插件 id 不合法';
  }
  /* 「隐藏未播集」：布尔校验（缺席不校验，add/patch 各自的缺席口径是开） */
  if (o.hideUnairedEpisodes !== undefined && typeof o.hideUnairedEpisodes !== 'boolean') {
    return '「隐藏未播集」必须是布尔值';
  }
  /* 「搜索通过的域」：必须是数组，逐项是合法前缀。**空数组合法**（= 一个域都不搜；
   * 字段缺席 = 全部域，所以这里只在显式传了的时候校验）。 */
  if (o.metaDomains !== undefined) {
    if (!Array.isArray(o.metaDomains)) return '搜索域必须是数组';
    if (o.metaDomains.length > MAX_META_DOMAINS) return `最多只能限定 ${MAX_META_DOMAINS} 个搜索域`;
    for (const x of o.metaDomains) {
      const d = normName(x).toLowerCase();
      if (d && !DOMAIN_RE.test(d)) return `搜索域不合法：${d}（只允许字母数字）`;
    }
  }
  return null;
}

/**
 * 挑一个空闲端口：先排除**清单里已声明**的（哪怕它现在没在监听），再真去 bind 试一次。
 * 两步都要 —— 只看 bind 会挑中"已分配但进程还没绑上"的端口（源实例那边踩过）。
 */
function isFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

async function findFreePort(from = PORT_START) {
  const held = new Set(load().instances.map((x) => Number(x.port)));
  for (let p = from; p <= 65535; p++) {
    if (held.has(p)) continue;
    // eslint-disable-next-line no-await-in-loop
    if (await isFree(p)) return p;
  }
  return 0;
}

/** 把一个 id 变成合法且不重复的实例 id */
function uniqueId(base) {
  const s = load();
  const seed = normName(base)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  let id = seed && INSTANCE_ID_RE.test(seed) ? seed : `emby-${crypto.randomBytes(3).toString('hex')}`;
  while (s.instances.some((x) => x.id === id)) id = `${id}-${crypto.randomBytes(2).toString('hex')}`;
  return id;
}

/** 新增；`o.port` 留空则自动挑一个空闲端口 */
async function add(o = {}) {
  const s = load();
  if (s.instances.length >= MAX_INSTANCES) throw new Error(`最多 ${MAX_INSTANCES} 个 Emby 实例`);
  const err = validate(o, null);
  if (err) throw new Error(err);

  const id = uniqueId(o.name);
  const port = o.port === undefined || o.port === null || o.port === '' ? await findFreePort() : Number(o.port);
  if (!port) throw new Error('没有找到空闲端口，请手动指定一个');

  const inst = {
    id,
    name: normName(o.name) || `Emby ${id}`,
    port,
    enabled: o.enabled === undefined ? true : !!o.enabled,
    /* 下载开关：默认开（缺席按开） */
    allowDownload: o.allowDownload === undefined ? true : !!o.allowDownload,
    /* 「隐藏未播集」：字段落盘，缺席 = 开（publicInstance 的缺省口径） */
    hideUnairedEpisodes: o.hideUnairedEpisodes === undefined ? true : !!o.hideUnairedEpisodes,
    homePlugin: normName(o.homePlugin),
    serverId: crypto.randomBytes(8).toString('hex'),
    imageKey: crypto.randomBytes(32).toString('hex'),
    /* 每个实例一个库文件：账号 / 会话 / 进度都在里面，互不相通 */
    dbFile: path.posix.join('instances', id, 'emby.db'),
    createdAt: new Date().toISOString(),
  };
  /* 「搜索通过的域」：只有显式给了才落盘 —— 缺席 = 全部域（老实例与新实例的默认口径） */
  if (o.metaDomains !== undefined) inst.metaDomains = normDomains(o.metaDomains);
  s.instances.push(inst);
  save();
  return inst;
}

/** 改名 / 改端口 / 改首页 / 启停；返回改后的实例（没有这个 id 回 null） */
function patch(iid, o = {}) {
  const inst = get(iid);
  if (!inst) return null;
  const err = validate(o, inst);
  if (err) throw new Error(err);

  if (o.name !== undefined) inst.name = normName(o.name);
  if (o.port !== undefined) inst.port = Number(o.port);
  if (o.enabled !== undefined) inst.enabled = !!o.enabled;
  if (o.allowDownload !== undefined) inst.allowDownload = !!o.allowDownload;
  if (o.hideUnairedEpisodes !== undefined) inst.hideUnairedEpisodes = !!o.hideUnairedEpisodes;
  if (o.homePlugin !== undefined) inst.homePlugin = normName(o.homePlugin);
  if (o.metaDomains !== undefined) inst.metaDomains = normDomains(o.metaDomains);
  save();
  return inst;
}

/** 删实例：连带关掉它的库句柄、删掉它的库文件（默认实例不给删） */
function remove(iid) {
  const s = load();
  const i = s.instances.findIndex((x) => x.id === String(iid || '').trim());
  if (i < 0) return null;
  const inst = s.instances[i];
  if (inst.id === DEFAULT_ID) throw new Error('默认实例不能删除');

  closeDb(inst);
  s.instances.splice(i, 1);
  save();

  /* 连带删掉它的数据目录 —— 账号 / 会话 / 进度全在 `instances/<id>/` 下，删实例就该一起清掉。
   * 默认实例不走这条路（它的 emby.db 直接躺在 EMBY_DIR 下，且它根本不给删）。 */
  try {
    fs.rmSync(path.join(EMBY_DIR, 'instances', inst.id), { recursive: true, force: true });
  } catch {
    /* 删不掉就留着，不影响功能 */
  }
  return inst;
}

/* ------------------------------------------------------------------ 身份 */

/**
 * 实例的服务器身份：`serverId`（客户端据此认服务器，必须稳定）、`imageKey`（图片 tag 的签名密钥）。
 * 首次用到时就地生成并落盘 —— 老逻辑写在 `settings/emby.json`，现在跟着实例走。
 * 实例名即握手里的 `ServerName`（客户端「服务器列表」里显示的就是它）。
 */
function identityOf(inst) {
  const i = inst || current();
  if (!i) return { serverId: '', serverName: BRAND.embyServerName, imageKey: '' };

  let dirty = false;
  if (!i.serverId) {
    i.serverId = crypto.randomBytes(8).toString('hex');
    dirty = true;
  }
  if (!i.imageKey) {
    i.imageKey = crypto.randomBytes(32).toString('hex');
    dirty = true;
  }
  if (dirty) save();

  return {
    serverId: i.serverId,
    serverName: normName(i.name) || BRAND.embyServerName,
    imageKey: i.imageKey,
  };
}

/* ------------------------------------------------------------------ 库句柄 */

/**
 * 按实例拿 sqlite 句柄（惰性打开、按 `dbFile` 缓存）。
 * **只负责打开**：建表与迁移在 `db.js`（那才是库的形状的定义处）。
 */
function dbOf(inst) {
  const i = inst || current();
  if (!i) throw new Error('没有可用的 Emby 实例');
  const hit = handles.get(i.dbFile);
  if (hit) return hit;

  let DatabaseSync;
  try {
    ({ DatabaseSync } = require('node:sqlite'));
  } catch {
    throw new Error(`本面板需要 Node ≥ 22.13 才能使用内置 sqlite（当前 ${process.version}），请升级 Node 后重启`);
  }

  const file = dbFileOf(i);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const h = new DatabaseSync(file);
  try {
    fs.chmodSync(file, 0o600); // 含密码哈希，别让同机其它用户读
  } catch {
    /* 平台不支持就算了 */
  }
  handles.set(i.dbFile, h);
  return h;
}

/** `dbFile` → 绝对路径；只允许落在 `data/emby/` 里面 */
function dbFileOf(inst) {
  const rel = String((inst && inst.dbFile) || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) throw new Error('实例的 dbFile 不合法');
  return path.join(EMBY_DIR, rel);
}

function closeDb(inst) {
  const key = inst && inst.dbFile;
  const h = key && handles.get(key);
  if (!h) return;
  try {
    h.close();
  } catch {
    /* ignore */
  }
  handles.delete(key);
}

function closeAll() {
  for (const [k, h] of handles) {
    try {
      h.close();
    } catch {
      /* ignore */
    }
    handles.delete(k);
  }
}

/* 进程退出时收尾（server.js 的 shutdown 只停源，没有库钩子） */
process.on('exit', closeAll);

module.exports = {
  DEFAULT_ID,
  PORT_START,
  INSTANCES_FILE,
  MAX_INSTANCES,
  migrate,
  list,
  get,
  add,
  patch,
  remove,
  publicInstance,
  current,
  runWith,
  identityOf,
  dbOf,
  dbFileOf,
  closeDb,
  closeAll,
  findFreePort,
  isFree,
  load,
  save,
};