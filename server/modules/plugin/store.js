'use strict';
/**
 * 插件仓库：`data/plugins/` 的目录布局 + 清单读写 + 安装 / 卸载。
 *
 *   data/plugins/
 *     registry.json              清单：只放元数据（id / types / 版本 / 启用 / 来源 / md5），**不放代码**
 *     <插件 id>/                  包本体（解包后的目录）—— **id 全局唯一、目录拍平**
 *     <插件 id>/data/             插件自己的数据（设置与缓存都在这儿）
 *
 * ⚠️ **一个包一个 id 一个目录**（见 docs/adr/0046）：一个包可同时具备多个平级类型
 * （`types:["metadata","source"]`），但仍只有一个目录、一个进程、一个开关、一份数据。
 * 路由里的 `:type` 只是**角色参数**：`get(type,id)` 按 id 定位包，并校验该类型 ∈ types。
 *
 * ⚠️ **"清空插件数据"就是删 `<目录>/data`** —— 声明与存储在插件自己那边，面板不碰内容。
 *
 * ⚠️ **插件不随面板发行**（见 docs/adr/0035）—— 装进来的两条路都是外部的
 * （插件库 / 手动上传），卸载也一定持久。
 */
const fs = require('fs');
const path = require('path');
const { PLUGINS_DIR } = require('../../core/paths');
const contract = require('./contract');

const ROOT = PLUGINS_DIR;
const REGISTRY = path.join(ROOT, 'registry.json');

function ensureRoot() {
  fs.mkdirSync(ROOT, { recursive: true });
}

function readJson(file, dft) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' ? v : dft;
  } catch {
    return dft;
  }
}

/** 原子写（tmp + rename），与 core/settings、source/store 同款 */
function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
  return obj;
}

/** 清单（数组，按安装先后） */
function list() {
  const r = readJson(REGISTRY, []);
  return Array.isArray(r) ? r : [];
}

function saveAll(arr) {
  ensureRoot();
  return writeJsonAtomic(REGISTRY, arr);
}

/** 角色键分隔符（不会出现在 type / id 里的控制字符） */
const SID_SEP = String.fromCharCode(1);
/** 角色键：展开状态行 / 前端 join 用（一个包按 types 展开成多行） */
const sid = (type, id) => `${type}${SID_SEP}${id}`;

/** 两个 types 集合是否相同（与顺序无关） */
function sameTypes(a, b) {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  if (x.length !== y.length) return false;
  const ys = new Set(y);
  return x.every((t) => ys.has(t));
}

/** 按 id 找包（身份就是 id） */
function byId(id) {
  return list().find((x) => x && x.id === id) || null;
}

/**
 * 按"角色 + id"找包：id 定位，`:type` 必须是它声明的类型之一。
 * 路由 /ingress /host 都走这里 —— types 里没有这个角色就当作没有，
 * 这样 `/api/plugins/home/missav/...` 不会误落到一个纯 source 的同名包上。
 */
function get(type, id) {
  const e = byId(id);
  return e && Array.isArray(e.types) && e.types.includes(type) ? e : null;
}

/** 按身份键找（兼容老调用点） */
function getBySid(s) {
  const [type, id] = String(s || '').split(SID_SEP);
  return get(type, id);
}

/** 包目录：拍平后只有 id 一层（见 docs/adr/0046） */
const dirOf = (id) => path.join(ROOT, String(id));
const dataDirOf = (id) => path.join(dirOf(id), 'data');

function upsert(entry) {
  const arr = list();
  const i = arr.findIndex((x) => x && x.id === entry.id);
  if (i >= 0) arr[i] = Object.assign({}, arr[i], entry);
  else arr.push(entry);
  saveAll(arr);
  return byId(entry.id);
}

/** 改一个插件的几个字段（不动别的）。角色参数仅用于定位包。 */
function patch(type, id, fields) {
  const cur = get(type, id);
  if (!cur) return null;
  const arr = list();
  const i = arr.findIndex((x) => x && x.id === cur.id);
  if (i < 0) return null;
  arr[i] = Object.assign({}, arr[i], fields);
  saveAll(arr);
  return arr[i];
}

/**
 * 删除一个插件。（由调用方先把进程停掉。）
 * `keepData` = 保留它的 `data/` 目录（默认跟着删 —— "卸载"就该干净）。
 */
function remove(type, id, { keepData = false } = {}) {
  const cur = get(type, id);
  if (!cur) return { kept: '' };
  const dir = dirOf(cur.id);
  let kept = '';
  if (keepData && fs.existsSync(dataDirOf(cur.id))) {
    kept = path.join(ROOT, `.kept-${cur.id}-${Date.now()}`);
    fs.renameSync(dataDirOf(cur.id), kept);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  saveAll(list().filter((x) => !(x && x.id === cur.id)));
  return { kept };
}

/** 递归复制（`installDir` 用：把解开的包复制进暂存目录） */
function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (ent.name === 'data') continue; // 插件数据不属于"包"
    const a = path.join(from, ent.name);
    const b = path.join(to, ent.name);
    if (ent.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

/**
 * 安装 / 覆盖一个插件：把 `srcDir`（已经解包好的目录）放到 `<id>/` 下。
 *
 * `origin` = 'library' / 'manual'，只影响显示。覆盖时**保留 `data/`**。
 *
 * 身份口径（见 docs/adr/0046）：
 *   · id 全局唯一：同 id 已装时只允许**类型集合完全相同**的包覆盖（自更新同款）；
 *     同 id 但 types 不同 → 拒绝（先卸载旧包，别让"更新"换掉包的身份）。
 *   · metadata 域全局唯一：另一个 id 的包已注册同域 → 拒绝。
 */
function installDir(srcDir, { origin = 'manual', md5 = '', enabled } = {}) {
  ensureRoot();
  const m = contract.readManifest(srcDir); // 第二道校验在这里（files 逐文件核对）

  const existed = byId(m.id);
  if (existed && !sameTypes(existed.types, m.types)) {
    const e2 = new Error(
      `已装过同 id「${m.id}」但类型不同的包（已装 ${(existed.types || []).join(' / ')}，新包 ${m.types.join(' / ')}）。` +
        '一个 id 只能有一个包；请先卸载旧包再装。'
    );
    e2.code = 'IDENTITY_MISMATCH';
    throw e2;
  }
  if (m.domain) {
    const clash = list().find((x) => x && x.id !== m.id && x.domain === m.domain);
    if (clash) {
      const e2 = new Error(`元数据域「${m.domain}」已被插件 ${clash.id} 注册，一个域只能有一个插件`);
      e2.code = 'DOMAIN_CONFLICT';
      throw e2;
    }
  }

  const dir = dirOf(m.id);

  /* 先把新版放到临时目录，验完再原子换过去 —— 不让"解到一半"的包留在插件目录里 */
  const stage = path.join(ROOT, `.staging-${m.id}-${Date.now()}`);
  fs.rmSync(stage, { recursive: true, force: true });
  copyDir(srcDir, stage);

  /* ⚠️ 换包时**必须把 `data/` 挪到一边再挪回来**（它是插件自己的数据，不属于"包"）。 */
  const dataDir = dataDirOf(m.id);
  const stash = path.join(ROOT, `.data-${m.id}-${Date.now()}`);
  const hadData = fs.existsSync(dataDir);
  if (hadData) fs.renameSync(dataDir, stash);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(ROOT, { recursive: true });
    fs.renameSync(stage, dir);
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    if (hadData && fs.existsSync(stash)) {
      try {
        fs.renameSync(stash, dataDir);
      } catch {
        /* 换包失败时数据先留在 stash 里，别因为回挪失败把原错盖掉 */
      }
    }
    throw e;
  }
  if (hadData && fs.existsSync(stash)) fs.renameSync(stash, dataDir);
  fs.mkdirSync(dataDirOf(m.id), { recursive: true }); // 插件自己的数据目录

  const stat = contract.dirDigest(dir);
  const entry = {
    types: m.types,
    id: m.id,
    name: m.name,
    author: m.author,
    version: m.version,
    description: m.description,
    domain: m.domain,
    /* 源插件声明的直绑域（契约 binds；没有就是空数组）—— 聚合层按它决定"先按 entryId 直调 detail" */
    binds: Array.isArray(m.binds) ? m.binds.slice() : [],
    series: m.series,
    hasWebui: Object.keys(m.webui || {}).length > 0,
    /* webui 归一化成 {类型:入口}（见 contract.readManifest）；网关/路由按角色取 */
    webui: m.webui || {},
    /* ingress 路径名单包级共享（不按类型分家）。 */
    ingress: m.ingress || { public: [], token: [] },
    /* 自更新清单地址（插件自带；没有就是空串，管理页不显示更新按钮） */
    updateUrl: m.updateUrl || '',
    depends: m.depends,
    origin,
    md5: md5 || stat.digest,
    digest: stat.digest,
    files: stat.files,
    bytes: stat.bytes,
    installedAt: Date.now(),
    /* 覆盖安装时保留原来的启用状态；新建默认**不启用**（装完由人明确打开） */
    enabled: enabled === undefined ? (existed ? !!existed.enabled : false) : !!enabled,
  };
  return upsert(entry);
}

/** 一个路径占的字节（目录递归；不存在就是 0） */
function sizeOf(p) {
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    return 0;
  }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const ent of fs.readdirSync(p, { withFileTypes: true })) n += sizeOf(path.join(p, ent.name));
  return n;
}

/**
 * 清掉**已装插件**的落盘缓存（面板「清除全部缓存」按钮用）。
 *   · 所有插件：`<包>/data/cache/`
 *   · types 含 home 的包：再加 `<包>/data/storage.json`（行结果缓存）
 * 两份都是**可丢弃**数据 —— 设置与凭据不在这两处，清完不用重新登录。
 * （多类型包只清一次 storage.json —— 一个包一份 data。）
 */
function clearCaches() {
  const plugins = [];
  for (const m of list()) {
    if (!m || !m.id) continue;
    const data = dataDirOf(m.id);
    const targets = [path.join(data, 'cache')];
    if (Array.isArray(m.types) && m.types.includes('home')) targets.push(path.join(data, 'storage.json'));
    let bytes = 0;
    for (const p of targets) {
      const n = sizeOf(p);
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch {
        continue; // 删不掉就不记它，别把没清掉的算进账里
      }
      bytes += n;
    }
    if (bytes > 0) plugins.push({ id: m.id, types: m.types, bytes });
  }
  return { plugins, bytes: plugins.reduce((n, x) => n + x.bytes, 0) };
}

module.exports = {
  ROOT,
  REGISTRY,
  sid,
  sameTypes,
  dirOf,
  dataDirOf,
  list,
  get,
  byId,
  getBySid,
  upsert,
  patch,
  remove,
  installDir,
  clearCaches,
  copyDir,
  ensureRoot,
};
