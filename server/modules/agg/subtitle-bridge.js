'use strict';
/**
 * 字幕插件转接处：**面板侧唯一一处**知道"字幕要去调哪个插件的哪个动作"。
 *
 * 两件事（正文在开发套件仓 `MediaBridge-plugin-devkit/framework/contracts/contract-subtitle.md`）：
 *   ① `tracks` —— 为一个播放目标**问一次**：所有启用的字幕插件各报一份字幕轨，这里合成一份；
 *   ② `fetch`  —— 客户端点开某条轨时，按**插件自己编的 `ref`**（形状 `<插件 id>/<插件自己的东西>`）
 *      路由到那个插件取内容。面板只按**第一段**路由，其余**不解释**。
 *
 * **字幕与线路无关**：`tracks` 的坐标是"这一集 / 这一部片"（片名、原名、年份、季集号），
 * 不带线路。本文件归**聚合层**（与源插件一样走 `plugin/host`）：聚合层在 `detail()` 里问一次，
 * 把轨挂在该目标的详情响应上；emby 层再读那份结果、逐版本引用（见 `agg/api.js` / `emby/service.js`）。
 * 这样"面板 web 看到的版本"与"客户端点开的版本"字幕来自同一处，emby 层不再自己问插件。
 *
 * **失败语义**：`tracks` 失败**只降级**（少几条轨、记一行日志，不破坏详情）；`fetch` 失败
 * **如实抛**（调用方用 `metaBridge.httpStatusOf` 归类成状态码，不编、不静默回退）。
 *
 * **缓存归插件**：字幕内容缓存是插件自己的事（契约第七节），面板侧**不另开字幕缓存**
 * （线路结果缓存里也不含字幕 —— 见 `agg/api.js`）。
 */
const host = require('../plugin/host');

/** 默认每次调用插件的超时（`tracks` / `fetch` 自己也会带，这个只是兜底） */
const DEFAULT_TIMEOUT_MS = 20000;
/** 同一个插件连续失败时的日志节流：插件停着的时候不该每次调用都刷一行 */
const WARN_MIN_MS = 60000;
/** 认得的字幕格式（大小写不敏感）；面板据此填 `Codec`、也是内容端点地址后缀 */
const FORMATS = ['srt', 'ass', 'ssa', 'vtt'];

const warnedAt = new Map();

function warnOnce(pluginId, line) {
  const key = String(pluginId || '');
  const last = warnedAt.get(key) || 0;
  if (Date.now() - last < WARN_MIN_MS) return;
  warnedAt.set(key, Date.now());
  console.log('  ✘ 字幕 ' + line);
}

/** `插件 id / 插件自己的东西` —— 插件 id 里不允许出现 `/`，所以按第一个斜杠拆是安全的 */
function splitRef(ref) {
  const s = String(ref || '');
  const at = s.indexOf('/');
  if (at < 0) return { pluginId: '', rest: '' };
  return { pluginId: s.slice(0, at), rest: s.slice(at + 1) };
}

/** 参与的字幕插件 = **已安装且启用**的 `subtitle` 类型插件（没在跑也照样算，会如实报"没在运行"） */
function subtitlePlugins() {
  return host.states().filter((x) => x.type === 'subtitle' && x.enabled);
}

/** 找一个启用中的字幕插件；认不出就如实报（不猜、不回退到别的插件） */
function requirePlugin(pluginId) {
  const id = String(pluginId || '');
  const plugin = subtitlePlugins().find((x) => x.id === id);
  if (!plugin) {
    const e = new Error(`字幕插件 ${id || '(空)'} 没安装或没启用`);
    e.code = 'NO_PLUGIN';
    throw e;
  }
  return plugin;
}

/**
 * 转一次动作。`NOT_RUNNING` / `NOT_READY` / `IPC_DOWN` 归一到 `PLUGIN_DOWN`，
 * 好让 `metaBridge.httpStatusOf` 一致地判成 503（与元数据那层同一口径）。
 */
async function callPlugin(pluginId, action, args, timeoutMs) {
  const r = await host.call('subtitle', pluginId, action, args, {
    timeoutMs: Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
  });
  if (r.ok) return r.value;
  const err = r.error || {};
  const down = err.code === 'NOT_RUNNING' || err.code === 'NOT_READY' || err.code === 'IPC_DOWN';
  const e = new Error(err.message || '插件调用失败');
  e.code = down ? 'PLUGIN_DOWN' : err.code || 'PLUGIN_ERROR';
  e.plugin = pluginId;
  e.action = action;
  throw e;
}

/** 一条轨的轻校验：`lang` / `format` / `ref` 缺一就丢（契约要求这三个必填）；`format` 必须是认得的四种 */
function normTrack(one) {
  const lang = String((one && one.lang) || '').trim();
  const ref = String((one && one.ref) || '').trim();
  const format = String((one && one.format) || '').trim().toLowerCase();
  if (!lang || !ref || !FORMATS.includes(format)) return null;
  const label = String((one && one.label) || '').trim();
  return { lang, format, label: label || '', ref };
}

/**
 * 为一个播放目标问一次 `tracks`：**所有启用的字幕插件各问一发**，合成一份。
 * 单个插件失败**只跳过它**（记一行日志），不影响别的插件、也不抛 —— 契约规定 `tracks` 失败只降级。
 */
async function tracks(coord, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const out = [];
  for (const p of subtitlePlugins()) {
    let list;
    try {
      // eslint-disable-next-line no-await-in-loop
      list = await callPlugin(p.id, 'tracks', coord, timeoutMs);
    } catch (e) {
      warnOnce(p.id, `字幕插件 ${p.name || p.id} 的 tracks 失败：${(e && e.message) || e}`);
      continue;
    }
    if (!Array.isArray(list)) {
      warnOnce(p.id, `字幕插件 ${p.name || p.id} 的 tracks 没回数组（契约要求直接回轨数组），已忽略`);
      continue;
    }
    for (const one of list) {
      const n = normTrack(one);
      if (n) out.push(n);
      else warnOnce(p.id, `字幕插件 ${p.name || p.id} 申报了一条不合法的轨（lang/format/ref 缺、或 format 不认得），已忽略`);
    }
  }
  return out;
}

/**
 * 取字幕内容：按 `ref` 的**第一段**路由到那个插件，调 `fetch`。
 * 失败**如实抛**（不编、不静默回退）—— 调用方据此回真实失败码。
 */
async function fetch(ref, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const r = String(ref || '');
  const { pluginId } = splitRef(r);
  if (!pluginId) {
    const e = new Error(`认不出这个字幕 ref：${r.slice(0, 80) || '(空)'}`);
    e.code = 'BAD_REF';
    throw e;
  }
  requirePlugin(pluginId);
  return callPlugin(pluginId, 'fetch', { ref: r }, timeoutMs);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  FORMATS,
  splitRef,
  subtitlePlugins,
  tracks,
  fetch,
};
