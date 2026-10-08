'use strict';
/**
 * 通用本地缓存（Node 内置 `node:sqlite`，零依赖）—— **所有缓存表的唯一设施**
 *
 * 由 `modules/emby/cache.js` 抽出：缓存不止一个调用方 ——
 * 图片索引归 emby、聚合的**线路结果**归 agg，而依赖是单向的 `emby → agg → core`。
 * 所以「开库 / TTL / 按字节 LRU 淘汰 / 统计 / 清空」这套通用能力放在 core，
 * 各有各策略的调用方（`modules/emby/cache.js`、`modules/agg/cache.js`、`modules/agg/site-stats.js`）
 * 各自建一个 store。
 *
 * ⚠️ **面板侧只剩"这一条目的线路结果"这一份**（`line_cache`，见 `modules/agg/cache.js`
 * 与 docs/adr/0032）：面板不再缓存"完整详情快照"，插件自己的取数缓存归插件自己管。
 * ⚠️ **元数据与名字搜索的缓存已经不在面板里了**：它们随元数据插件化搬进了插件自己的数据目录，
 * 由插件自己管（插件里那份实现不需要也不该 require 面板）。
 *
 * —— 淘汰策略：TTL + 字节上限 + LRU，三者各管一件事 ——
 *   · TTL（按时间）管**正确性** —— 元数据会变（评分、简介、海报更换）
 *   · 字节上限管**空间** —— 片库上不封顶，不设限会一直涨
 *   · 两者都不管「冷热」—— 所以按 `used_at` 做 LRU，把冷门挤出去
 * **上限必须按字节不能按条数**：实测 lean 响应 1.9KB、rich 119KB，**差 60 倍**，按条数根本算不准。
 *
 * ⚠️ **一个文件一个 store、一个 store 一个句柄**（同 label 重复 create 会拿到同一个实例）：
 * 同一进程里两个句柄指向同一个库，在 WAL 下会互相锁。
 *
 * ⚠️ 这里存的一律是**可丢弃**数据：删库 = 重新抓一遍。所以 `clearAll()`（面板「清空缓存」）
 * 可以放心清 - 但**别把不可再生的东西塞进来**（曾经的 `view_seen`「库首次出现时刻」就因为
 * 丢了会让所有库的 `DateCreated` 跳到今天，而被刻意排除在清空之外；那张表已随
 * 「库 DateCreated 改成占位值」一起删除）。
 */
const fs = require('fs');
const path = require('path');

const settings = require('./settings');

/** 读命中时**最多每小时**刷一次 used_at：LRU 需要"最近用过"这个信息，但每次读都写库
 * 会把缓存变成写放大源（尤其图片索引，一次列表渲染就是几十次读）。一小时粒度足够。 */
const USED_REFRESH_MS = 60 * 60 * 1000;

/** 面板可改的默认值（「面板设置 → 缓存设置」）。**只有这一处**，面板这边那两份缓存都从这里取 */
const DEFAULTS = {
  imageTtlDays: 90,
  imageMaxMB: 5,
  /** 线路结果缓存（`line_cache`，见 agg/cache.js）：**按天**，默认 1 天（口径见 docs/adr/0032）。
   *  0 = 不缓存（与上面「天数 0 = 不缓存」同一口径）；勾了「长期有效」时这个数不看。
   *  `linesMaxMB` = 总字节上限，**可调**（「面板设置 → 缓存设置」，0 = 不限）。
   *  默认 32MB 是实测值：一条结果含全站的线路与选集，而每个选集 ID 就是 600~720 字符的 token，
   *  实测几十~几百 KB 一条。 */
  linesTtlDays: 1,
  linesNeverExpire: false,
  linesMaxMB: 32,
};

/**
 * 「长期有效」用的 TTL：写 `expires_at = now + 这个数`（约 100 年）。
 * 不写 0/Infinity —— `enforce()` 判的是 `expires_at <= now`，0 等于"写完即过期"，
 * 而 Infinity 落库会变成 NULL/精度问题，所以给一个够远的有限值。
 */
const NEVER_TTL_MS = 100 * 365 * 86400000;

/**
 * 当前缓存策略（毫秒/字节），读**面板设置**的 `cache.*`（由 emby 设置迁入：
 * 缓存统一在「面板设置」管，见 panel/index.js 的 fields）。
 * ⚠️ 两个 0 的语义**不一样**：天数 0 = 不缓存（写完即过期）；上限 0 = **不限**（见 enforce）。
 */
function cfg() {
  const c = (settings.read('panel') || {}).cache || {};
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const linesDays = num(c.linesTtlDays, DEFAULTS.linesTtlDays);
  return {
    imageTtlMs: num(c.imageTtlDays, DEFAULTS.imageTtlDays) * 86400000,
    imageMaxBytes: num(c.imageMaxMB, DEFAULTS.imageMaxMB) * 1024 * 1024,
    /* 「长期有效」勾了就无视天数（`linesNeverExpire` 是布尔，不是数字） */
    lineTtlMs: c.linesNeverExpire ? NEVER_TTL_MS : linesDays * 86400000,
    lineMaxBytes: num(c.linesMaxMB, DEFAULTS.linesMaxMB) * 1024 * 1024,
  };
}

/** 各表的字节上限来自哪个设置的哪一项（sweepAll 用） */
const TABLE_CAP = {
  image_index: (c) => c.imageMaxBytes,
  line_cache: (c) => c.lineMaxBytes,
  /* 按插件记的聚合耗时：一张很小的统计表（几百字节一条 × 插件个数），固定上限就够，不进设置 */
  agg_stat: () => 512 * 1024,
};

/** 已建的 store（label → store）：面板的「用量 / 清空 / 设置变更后扫一遍」靠它一把抓 */
const stores = new Map();

/**
 * 建一个 store（同 label 幂等）。`tables` 里的每张表都是「key → value + TTL + LRU」的同一种形状。
 */
function createStore({ label, dir, file, tables }) {
  const existing = stores.get(label);
  if (existing) return existing;
  if (!label || !dir || !file || !Array.isArray(tables) || !tables.length) {
    throw new Error('createStore 需要 label / dir / file / tables');
  }

  const filePath = path.join(dir, file);
  let db = null;

  /** 打开（首次会建库建表）；老 Node 上给一句人话报错 */
  function open() {
    if (db) return db;

    let DatabaseSync;
    try {
      ({ DatabaseSync } = require('node:sqlite'));
    } catch {
      throw new Error(`本面板需要 Node ≥ 22.13 才能使用内置 sqlite（当前 ${process.version}），请升级 Node 后重启`);
    }

    fs.mkdirSync(dir, { recursive: true });

    /* ⚠️ 全程用局部变量，**最后一步才赋给 `db`**：建库/建表任何一步抛错都不能留下
     * 半初始化的句柄 —— 否则下次 `if (db) return db` 直接返回它，报错的会是
     * "no such table" 这种跟真实原因（多半是 WAL 起不来）毫不相干的误导信息。
     * （GitHub issue #3：CentOS 7 老内核上 WAL 拿不到 shm → 首抛 disk I/O error，
     *  之后所有访问变成 no such table。） */
    const h = new DatabaseSync(filePath);
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* 平台不支持就算了，不因此起不来 */
    }

    /* 与 `emby.db`（账号，DELETE journal）相反，缓存**优先用 WAL**：高写入负载要读写并发；
     * `synchronous = NORMAL` 少一次 fsync/事务 —— 掉电最多丢最近几条缓存，无所谓。
     * **WAL 起不来就降级 DELETE journal 继续跑**（ADR-0072）：缓存是可丢数据，
     * 为它让整个功能炸掉不值；降级只丢读写并发收益，对这些小库无所谓。 */
    try {
      try {
        h.exec('PRAGMA journal_mode = WAL;');
      } catch (e) {
        console.error(
          `  ✘ 缓存库 ${filePath} 开 WAL 失败（${(e && e.message) || e}），已降级 DELETE journal 继续跑` +
          ` —— 多半是数据卷的文件系统不支持 WAL 的共享内存（老内核 overlayfs / NFS / SMB）；` +
          `若之后写库仍报 disk I/O error，就是卷本身的问题（磁盘满 / 网络盘），请换本地盘挂载`
        );
        h.exec('PRAGMA journal_mode = DELETE;');
      }
      h.exec('PRAGMA synchronous = NORMAL;');
      h.exec('PRAGMA busy_timeout = 5000;');

      for (const t of tables) {
        h.exec(`
          CREATE TABLE IF NOT EXISTS ${t} (
            key        TEXT PRIMARY KEY,
            value      TEXT NOT NULL,
            bytes      INTEGER NOT NULL,   -- 为「按字节淘汰」记账；SQLite 不能对 TEXT 求和
            created_at INTEGER NOT NULL,
            used_at    INTEGER NOT NULL,   -- LRU 依据；读命中时按 USED_REFRESH_MS 节流刷新
            expires_at INTEGER NOT NULL
          );
          CREATE INDEX IF NOT EXISTS ${t}_expires ON ${t}(expires_at);
        `);
      }
    } catch (e) {
      /* 走到这 = 这个库没法用（连 DELETE journal 都建不了：卷只读 / 文件损坏 / 盘满…）：
       * 关掉句柄、不留脏状态，如实抛原始错 */
      try { h.close(); } catch { /* 关都关不上就算了，原始错更要紧 */ }
      throw e;
    }

    db = h;
    return db;
  }

  /** 读一条；过期视为不存在（顺手删掉，免得越积越多）。命中且久未刷新则刷 `used_at` */
  function get(table, key) {
    const d = open();
    const now = Date.now();
    const row = d.prepare(`SELECT value, used_at, expires_at FROM ${table} WHERE key = ?`).get(String(key));
    if (!row) return null;
    if (row.expires_at <= now) {
      d.prepare(`DELETE FROM ${table} WHERE key = ?`).run(String(key));
      return null;
    }
    if (now - row.used_at > USED_REFRESH_MS) {
      d.prepare(`UPDATE ${table} SET used_at = ? WHERE key = ?`).run(now, String(key));
    }
    return row.value;
  }

  /** 某表的总字节数 */
  function totalBytes(table) {
    return open().prepare(`SELECT COALESCE(SUM(bytes), 0) AS b FROM ${table}`).get().b;
  }

  /**
   * 淘汰：先清过期，再按 `used_at` 从旧到新删到上限以内。
   * `maxBytes <= 0` = 不限（只清过期）。
   */
  function enforce(table, maxBytes) {
    const d = open();
    d.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(Date.now());

    const cap = Number(maxBytes) || 0;
    if (cap <= 0) return;
    let total = totalBytes(table);
    if (total <= cap) return;

    /* 只在上限被突破时才全表排序 —— 日常写入不会走到这里 */
    const rows = d.prepare(`SELECT key, bytes FROM ${table} ORDER BY used_at ASC`).all();
    const del = d.prepare(`DELETE FROM ${table} WHERE key = ?`);
    for (const r of rows) {
      if (total <= cap) break;
      del.run(r.key);
      total -= r.bytes;
    }
  }

  /**
   * 写一条（已存在则覆盖，并把 created_at 一起刷新 —— 「重新拿到过」即视为新数据）。
   * 写完按 `maxBytes` 做一次淘汰。
   */
  function put(table, key, value, ttlMs, maxBytes) {
    const d = open();
    const now = Date.now();
    const text = String(value);
    d.prepare(
      `INSERT INTO ${table} (key, value, bytes, created_at, used_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, bytes = excluded.bytes, created_at = excluded.created_at,
         used_at = excluded.used_at, expires_at = excluded.expires_at`
    ).run(String(key), text, Buffer.byteLength(text, 'utf8'), now, now, now + Math.max(0, Number(ttlMs) || 0));
    enforce(table, maxBytes);
  }

  /** 各表各占多少（条数 + 字节）；面板据此显示「已用 x / 上限 y」 */
  function stats() {
    const d = open();
    const out = {};
    for (const t of tables) {
      const rows = d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
      out[t] = { rows, bytes: totalBytes(t) };
    }
    return out;
  }

  /** 清空本 store 的全部表（删的都是**可丢弃**数据；账号在别的库，永远不动） */
  function clear() {
    const d = open();
    for (const t of tables) d.exec(`DELETE FROM ${t}`);
    d.exec('VACUUM;');
  }

  /** 按给定上限扫一遍（`{ 表名: 字节上限 }`，缺的跳过） */
  function sweep(limits) {
    const l = limits || {};
    for (const t of Object.keys(l)) {
      if (tables.includes(t)) enforce(t, l[t]);
    }
  }

  const store = { label, path: filePath, tables, open, get, put, enforce, totalBytes, stats, clear, sweep };
  stores.set(label, store);
  return store;
}

/** 已建的 store（面板层用；顺序即创建顺序） */
function listStores() {
  return [...stores.values()];
}

/** 所有 store、所有表的用量：`{ <label>: { path, tables: { <table>: {rows, bytes} } } }` */
function statsAll() {
  const out = {};
  for (const s of stores.values()) out[s.label] = { path: s.path, tables: s.stats() };
  return out;
}

/** 清空**所有**缓存（面板「清空缓存」按钮 = 这一个入口，不散在各模块里） */
function clearAll() {
  for (const s of stores.values()) s.clear();
}

/**
 * 按**当前设置**把所有表扫到各自上限以内（设置改小后立刻落实，
 * 否则面板上会显示「已用 60MB / 上限 10MB」，看着像坏了）。
 */
function sweepAll(limits) {
  const c = limits || cfg();
  for (const s of stores.values()) {
    for (const t of s.tables) {
      const cap = TABLE_CAP[t] ? TABLE_CAP[t](c) : 0;
      if (cap) s.enforce(t, cap);
    }
  }
}

module.exports = {
  USED_REFRESH_MS,
  NEVER_TTL_MS,
  DEFAULTS,
  cfg,
  createStore,
  listStores,
  statsAll,
  clearAll,
  sweepAll,
};
