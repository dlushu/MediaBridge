'use strict';
/**
 * 「插件库」：从**插件仓库**拉清单、按清单下载包（决策见 docs/adr/0035）。
 *
 * 插件不随面板发行 —— 面板全新安装时插件目录是空的，装什么由人决定：
 *   · 面板「插件库」页 → 拉 `<仓库>/index.json` → 挑一个 → 下载它的包 → 走安装链路
 *   · 面板「插件管理」页 → 手动上传 .tar.gz（与这里无关）
 *
 * 取数口径与「面板自身更新」同款（见 modules/panel/update.js）：
 *   · 常量给默认仓库，环境变量可覆盖（`PLUGIN_REPO` / `PLUGIN_INDEX_URL` / `PLUGIN_SOURCE_URL`）
 *   · 清单缓存 60 秒，失败**不缓存**；取不到时**不抛**，把原因交给调用方（页面内联显示）
 *   · 支持 `http(s)://` 与本地路径（内网镜像 / 离线核对时用得上）
 *
 * 取源按候选顺序**串行降级**（内置公共 gh 代理 → `raw.githubusercontent.com` 直连）：
 * 候选表与超时来自 `core/mirrors`（决策见 docs/adr/0067-mirror-fallback-sources.md，与面板更新共用一份）。
 * 显式设了 `PLUGIN_INDEX_URL` / `PLUGIN_SOURCE_URL` 就是唯一地址，不再套镜像前缀。
 *
 * ⚠️ **不跨模块 require**（分层见 docs/adr/0001）：面板更新那边的小工具在那边是模块私有的，
 * 这边各留一份小的 —— 但 `core/` 是共用基础设施，候选表放那儿两边一起用。
 */
const fs = require('fs');
const { withMirrors, fetchOnce } = require('../../core/mirrors');
const contract = require('./contract');
const store = require('./store');

/** 插件仓库（`OWNER/REPO`）—— 与「面板自己」的仓库是**两个**仓库：这里只放插件包，不放源码 */
const LIBRARY_REPO = String(process.env.PLUGIN_REPO || 'dlushu/media-bridge-plugins').trim();

/** 仓库里的清单文件名（约定，见 docs/plugin-contract.md） */
const INDEX_NAME = 'index.json';

/** 清单支持的结构版本：v2 起条目用 types 数组（多类型，见 docs/adr/0046） */
const SCHEMA = 2;
/** 归一化一条清单的类型字段：v2 types 数组；兼容仍带单 type 的旧镜像 */
function typesOf(x) {
  if (Array.isArray(x.types)) return x.types.map((t) => String(t || '').trim()).filter(Boolean);
  return x.type ? [String(x.type).trim()] : [];
}

const CHECK_TTL_MS = 60 * 1000;

const raw = (p) => `https://raw.githubusercontent.com/${LIBRARY_REPO}/main/${p}`;

/** 清单的候选地址表：显式设了 `PLUGIN_INDEX_URL` 就是唯一地址，否则走镜像候选 */
function indexCandidates() {
  const tpl = String(process.env.PLUGIN_INDEX_URL || '').trim();
  return tpl ? [tpl] : withMirrors(raw(INDEX_NAME));
}

/** 清单的主地址（对外展示与排障用：候选表的第一条） */
const indexUrl = () => indexCandidates()[0];

/** 渲染一个地址模板（占位符 `{repo}` `{path}` `{type}` `{id}` `{version}`） */
function renderSource(tpl, entry) {
  return tpl
    .replace(/\{repo\}/g, LIBRARY_REPO)
    .replace(/\{path\}/g, String(entry.path || ''))
    .replace(/\{type\}/g, String(entry.type || ''))
    .replace(/\{id\}/g, String(entry.id || ''))
    .replace(/\{version\}/g, String(entry.version || ''));
}

/**
 * 包地址的候选表：默认走仓库内的相对路径（`raw.githubusercontent.com` 直取）+ 镜像前缀；
 * `PLUGIN_SOURCE_URL` 可覆盖（覆盖即唯一地址，占位符见 `renderSource`）。
 */
function sourceCandidates(entry) {
  const tpl = String(process.env.PLUGIN_SOURCE_URL || '').trim();
  if (tpl) return [renderSource(tpl, entry)];
  return withMirrors(raw(String(entry.path || '')));
}

/** 包的主地址（对外展示与排障用：候选表的第一条） */
const sourceUrlOf = (entry) => sourceCandidates(entry)[0];

/** 取字节：`http(s)://` 走网络（跟随跳转、带超时），其余当本地路径读（与 update.js 的 fetchBytes 同款） */
async function fetchBytes(url, { what }) {
  if (!/^https?:\/\//i.test(url)) {
    const p = url.replace(/^file:\/\//, '');
    if (!fs.existsSync(p)) throw new Error(`${what} 不存在：${p}`);
    return fs.readFileSync(p);
  }
  const res = await fetchOnce(url, { redirect: 'follow', headers: { 'user-agent': 'media-bridge-panel' } });
  if (!res.ok) throw new Error(`${what} 下载失败：HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 沿候选表取第一份取到的字节（串行降级），并把实际取胜的地址带回去 */
async function fetchFirst(candidates, { what }) {
  const errors = [];
  for (const url of candidates) {
    try {
      return { buf: await fetchBytes(url, { what }), url };
    } catch (e) {
      const why = (e && e.message) || String(e);
      errors.push(`${url}：${why}`);
      console.log(`  · 插件库：${url} 取源失败（${why}），换下一个`);
    }
  }
  throw new Error(`${what} 取不到（已试 ${candidates.length} 个地址）：${errors.join('；')}`);
}

/** 版本比大小（只比三段数字，够用；与 update.js 那份口径一致） */
function compareVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

let cache = { at: 0, value: null };

/**
 * 校核清单里的一条。**不合格的如实点名**（进 `bad[]`），不连累整份清单 ——
 * 一个手写的清单里混进一条坏的，不该让整页打不开。
 */
function checkEntry(x) {
  if (!x || typeof x !== 'object') return '不是一个对象';
  const types = typesOf(x);
  if (!types.length) return `缺 types（${contract.TYPES.join(' / ')} 的数组）`;
  for (const t of types) {
    if (!contract.TYPES.includes(t)) return `types 里有不认识的类型：「${t}」`;
  }
  if (new Set(types).size !== types.length) return `types 有重复：${types.join(' / ')}`;
  const id = String(x.id || '').trim();
  if (!contract.ID_RE.test(id)) return `id 不合法：「${id || '(空)'}」`;
  if (types.includes('metadata') && !String(x.domain || '').trim()) return 'types 含 metadata 时缺 domain';
  if (!String(x.name || '').trim()) return '缺 name';
  if (!String(x.version || '').trim()) return '缺 version';
  if (!String(x.path || '').trim()) return '缺 path（包在仓库里的相对路径）';
  const md5 = String(x.md5 || '').trim();
  if (!/^[0-9a-f]{32}$/i.test(md5)) return 'md5 不是 32 位十六进制';
  /* path 是仓库内的相对路径：不许是绝对路径、不许往上跑 */
  const p = String(x.path).split('/');
  if (p.includes('..') || p[0] === '' || /^[a-z]:$/i.test(p[0])) return `path 不能越出仓库：「${x.path}」`;
  return null;
}

/** 拉清单（60 秒缓存；失败不缓存）。返回归一化后的 `{ generatedAt, plugins[] }` */
async function fetchIndex({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < CHECK_TTL_MS) return cache.value;
  const buf = (await fetchFirst(indexCandidates(), { what: `插件清单 ${INDEX_NAME}` })).buf;
  let raw0;
  try {
    raw0 = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new Error(`清单不是合法 JSON：${(e && e.message) || e}`);
  }
  if (!raw0 || typeof raw0 !== 'object') throw new Error('清单必须是一个对象');
  if (Number(raw0.schema) !== SCHEMA) throw new Error(`清单结构版本是 ${raw0.schema}，这个面板只认 ${SCHEMA}`);
  if (!Array.isArray(raw0.plugins)) throw new Error('清单里没有 plugins 数组');

  const plugins = [];
  const bad = [];
  for (const x of raw0.plugins) {
    const why = checkEntry(x);
    if (why) bad.push({ id: (x && x.id) || '', types: typesOf(x), reason: why });
    else {
      /* 归一化：v2 条目补一个 type=types[0] 给仍读单值的地方（无主类型语义） */
      const types = typesOf(x);
      plugins.push(Object.assign({}, x, { types, type: types[0] }));
    }
  }
  const value = { generatedAt: String(raw0.generatedAt || ''), plugins, bad };
  cache = { at: now, value };
  return value;
}

/** 清单取不到时的空壳：让页面能画出"哪儿出错了"，而不是一片空白 */
const emptyShape = (error, extra = {}) => ({
  repo: LIBRARY_REPO,
  repoUrl: `https://github.com/${LIBRARY_REPO}`,
  indexUrl: indexUrl(),
  generatedAt: '',
  fetchedAt: new Date().toISOString(),
  plugins: [],
  bad: [],
  error: error || null,
  ...extra,
});

/**
 * 清单 + **已装状态标注**（页面直接照这个画）。
 * 取不到清单时不抛：回 200 的空壳 + `error`（与 `/api/panel/update` 同口径）。
 */
async function index({ force = false } = {}) {
  let doc;
  try {
    doc = await fetchIndex({ force });
  } catch (e) {
    return emptyShape((e && e.message) || String(e));
  }
  /* 已装状态按 id 标注（身份就是 id；同 id 即同包） */
  const installed = new Map(store.list().map((x) => [x.id, x]));
  const plugins = doc.plugins.map((x) => {
    const cur = installed.get(x.id) || null;
    return Object.assign({}, x, {
      installed: !!cur,
      installedVersion: cur ? String(cur.version || '') : '',
      installedOrigin: cur ? String(cur.origin || '') : '',
      hasUpdate: !!cur && compareVersion(x.version, cur.version) > 0,
      /* 装在哪一条路上装的 —— 页面据此提示"重装会覆盖" */
      sourceUrl: sourceUrlOf(x),
    });
  });
  return Object.assign(emptyShape(null, { generatedAt: doc.generatedAt }), { plugins, bad: doc.bad });
}

/** 在清单里按 id 找一条（type 给了就顺带校验它在 types 里；支持点名版本）。找不到回 null */
async function find(id, { type = '', version = '' } = {}) {
  const doc = await fetchIndex({});
  return (
    doc.plugins.find(
      (x) =>
        String(x.id) === String(id) &&
        (!type || (x.types || []).includes(String(type))) &&
        (!version || String(x.version) === String(version))
    ) || null
  );
}

/**
 * 取包字节（`http(s)://` 走网络、其余当本地路径）。
 * **校验不在这里做**：第一道（包 md5）由 `bundle.extractToTemp` 做 —— 与本模块的
 * 手动上传那条路是同一个关卡，不重复实现一遍。
 */
async function download(entry) {
  const { buf, url } = await fetchFirst(sourceCandidates(entry), { what: `插件包 ${entry.id}-${entry.version}` });
  return { buf, url, bytes: buf.length };
}

/**
 * 从库里把一个插件包**下载下来**：找到清单条目 → 取回包字节。
 * 解包 / 校验 / 安装由调用方走统一的 `updater.replaceInstalled`（与手动上传同一条路），
 * 本函数只负责"从仓库拿字节"，不碰插件目录 —— 临时目录的清理也归调用方。
 */
async function install({ type = '', id, version = '' }) {
  const entry = await find(id, { type, version });
  if (!entry) throw new Error(`插件库里没有 ${id}${version ? '@' + version : ''}`);
  const { buf, url } = await download(entry);
  console.log(`  · 插件库：下载 ${entry.id} v${entry.version}（${(entry.types || []).join('/')}）← ${url}（${Math.round(buf.length / 1024)}KB）`);
  return { entry, buf };
}

module.exports = {
  LIBRARY_REPO,
  index,
  find,
  download,
  install,
  sourceUrlOf,
  /* 排障用 */
  indexUrl,
};