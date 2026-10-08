'use strict';
/**
 * 聚合层的本地缓存 —— 面板侧**只剩"这一条目的线路结果"**这一份（口径见 docs/adr/0032）
 *
 *   line_cache  影视名 + 季集 + 所有影响结果的参数 → 面板聚合出来的那份线路结果
 *               （命中哪些站 / 各站线路与定位 / 代表条目；**不含插件的上游原样响应**）
 *   agg_stat    按插件记的聚合耗时（"慢插件"的账，见下面 `recordAgg`）
 *
 * —— 为什么需要它 ——
 * 客户端点一次「播放」会连着问三遍同一件事：条目详情 → 播放信息① → 播放信息②。
 * 而这条链每一步都要重跑「搜源 → 逐站取详情 → 定位到这一集」，实测每次 4~7 秒 ——
 * 三次串行 ≈ 20 秒，其中两遍是白重算的。缓存的就是这三遍共同的那一步。
 *
 * ⚠️ **面板侧只挡这三连问（几秒内）**：更长的热度由**插件自己的缓存**承担 ——
 * "插件应当自己缓存、把常见查询做到秒回"是契约里的义务（见 docs/plugin-contract.md 第八节），
 * 面板不替插件缓存它的取数结果，也不懂它的响应结构。
 * ⚠️ **只缓存到「集 id」为止，绝不缓存播放地址**：地址有时效（见 api.js 的 `play()`，
 * 那里明写"每次播放都现取"）。
 *
 * —— 为什么是独立库文件 `lines.db` ——
 * 照 `emby/cache.js` 的分家口径：缓存**按"谁使用"切，不按数据来源切** ——
 * 这张表由聚合层自己写、自己读（emby 层只是在 agg 里面间接用到），所以由 agg 声明；
 * 但文件落在共享缓存目录 `data/cache/`，与 `sitestat.db` 并列，运维口径仍是
 * 「缓存坏了就删 cache 目录里的库，账号不受影响」（账号在 emby.db）。
 * （旧版那份 `detail.db` 已不再读写 —— 里面是旧口径的"完整快照"，留着没人读，随手删掉即可。）
 *
 * 淘汰策略（TTL / 字节上限 / LRU）与"清空"入口都在 `core/cachedb.js`，这里只声明这两张表的用法。
 */
const { CACHE_DIR } = require('../../core/paths');
const cachedb = require('../../core/cachedb');

const store = cachedb.createStore({ label: 'lines', dir: CACHE_DIR, file: 'lines.db', tables: ['line_cache', 'agg_stat'] });

/** 库文件路径（日志/文档引用它） */
const CACHE_DB = store.path;

/** 取一条线路结果；没有/过期/内容坏了都回 null（坏的那条当没有，下次重写） */
function getLine(key) {
  const text = store.get('line_cache', key);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 写一条线路结果。
 *
 * **谁该写、谁不该写由调用方判断**（见 `api.js` 里那段：有线路就存、负结果不存）——
 * 这里只管"按当前设置写进去"。
 *
 * TTL 与字节上限都读面板设置（「缓存设置 → 线路结果」，见 `core/cachedb.js` 的 `cfg`）：
 * `lineTtlMs <= 0` = 不缓存（设置里填 0），勾了「长期有效」则是一个很远的过期时刻。
 */
function putLine(key, value) {
  const c = cachedb.cfg();
  if (!(c.lineTtlMs > 0)) return false;
  store.put('line_cache', key, JSON.stringify(value), c.lineTtlMs, c.lineMaxBytes);
  return true;
}

/** 聚合耗时统计的存活期：它是"最近的插件速度"，一个月足够（过期自动消失） */
const AGG_TTL_MS = 30 * 86400000;

/**
 * 记一笔**按插件的聚合耗时**（ADR-0032 第 4 条：不记就查不出"慢插件"）。
 *
 * `ms` = 这次聚合里**这个插件最慢的那一发取数**花了多久；`sites` = 这次打到它几个站点。
 * 为什么按插件而不是记一个总耗时：一次聚合同时打几个插件，总耗时说不出是谁慢。
 * 只留最近一次（单槽覆盖）—— 与站点统计同一口径，不留样本、不累计。
 */
function recordAgg(pluginId, ms, sites) {
  const id = String(pluginId || '').trim();
  if (!id) return null;
  const one = { ms: Math.max(0, Math.round(Number(ms) || 0)), sites: Math.max(0, Number(sites) || 0), at: Date.now() };
  try {
    store.put('agg_stat', id, JSON.stringify(one), AGG_TTL_MS, 0);
    return one;
  } catch {
    return null; // 统计坏了不该让取数跟着坏
  }
}

/** 给接口/前端看的形状：`{ <插件 id>: { ms, sites, at } }`（没记过就是空对象 —— 如实，不编） */
function aggStats() {
  const out = {};
  let rows = [];
  try {
    rows = store.open().prepare('SELECT key, value FROM agg_stat').all();
  } catch {
    return out;
  }
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      /* 坏的一条当没有 */
    }
  }
  return out;
}

module.exports = {
  CACHE_DB,
  AGG_TTL_MS,
  getLine,
  putLine,
  recordAgg,
  aggStats,
};