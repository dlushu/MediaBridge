'use strict';
/**
 * 首页（`home` 类型插件）· **面板侧适配层**
 *
 * 对外只暴露 emby 层要的那几个函数（`enabledRows` / `viewId` / `parseViewId` / `peekRowItems`
 * / `rowByFeed` / `listByQuery`），**签名与改造前一字不差** —— 这样
 * `server/modules/emby/service.js` 那几个调用点一个字都不用改，客户端行为照旧。
 *
 * 改造前这一层自己就是一套宿主（vm 沙箱 + 单文件插件 + 自己落盘），现在**宿主归统一插件**：
 *   · 行清单：问插件的 `rows` 动作（面板在内存里存一份快照，`Views` 是高频端点，不每次问）
 *   · 取行内容：问插件的 `run` 动作（分页原样透传，切不切片是插件的事）
 *   · 参数、缓存、取数用的 token：全是插件自己的事（契约第十/十一节）
 * 这一层只剩两件**面板才知道**的事：
 *   ① 媒体库 Id 的形状（`mbphome_` + base64url，见 `viewId`）；
 *   ② 条目归一化（子进程里跑着插件代码，不该由它决定进缓存什么）。
 *
 * ⚠️ 快照是**异步**刷新的（`rows` 是插件动作），而 `enabledRows` / `rowByFeed` /
 * `peekRowItems` 被 emby 层**同步**调用 —— 所以这三个读的是快照/记忆，刷新在后台跑
 * （见 `rowsOf` 的过期判据与 `warmHome()`）。改行参数后最迟几秒内反映到「媒体库」上。
 */
const host = require('../../plugin/host');
const instance = require('../instance');

/** 一个库最多放这么多条目（与改造前一致） */
const MAX_ITEMS = 200;

/** 快照的保鲜期：过了就在后台刷一次（不阻塞同步调用方） */
const SNAPSHOT_STALE_MS = 5000;

/** 所有 `home` 类型且启用中的插件；没在跑（崩了 / 还没起来）也照样算进来，它会如实报状态 */
function allHomePlugins() {
  return host.states().filter((x) => x.type === 'home' && x.enabled);
}

/**
 * **当前 Emby 实例选中的那个首页插件** —— 它决定这个实例的媒体库长什么样。
 *
 * 实例级"选一个首页插件"（见 `instance.js`）：没选就给空数组，客户端看到的是**空库列表**
 * （面板「Emby → 实例」里会红字提示"未选择首页"，不会静默地把别人的库塞过去）。
 * 选中的插件被停用 / 卸掉了，同样回空 —— 如实反映"这个实例现在没有首页"。
 */
function homePlugins() {
  const cur = instance.current();
  const want = String((cur && cur.homePlugin) || '').trim();
  if (!want) return [];
  return allHomePlugins().filter((x) => x.id === want);
}

/**
 * 可选的首页插件清单 —— 面板「Emby → 实例」里那个下拉用。
 *
 * 列的是**所有** `home` 类型插件（含未启用的）：没启用也要如实出现在下拉里，
 * 否则会出现"下拉里看不见、盘上却存着"这种对不上的状态（该实例的库为空但看不出原因）。
 * `rowCount` 只在启用时读快照 —— 未启用本来就取不到行，回 0 而不是编一个数。
 */
function pluginChoices() {
  return host
    .states()
    .filter((x) => x.type === 'home' && x.id)
    .map((x) => ({
      id: x.id,
      name: x.name || x.id,
      enabled: !!x.enabled,
      running: x.status === 'running',
      rowCount: x.enabled ? rowsOf(x.id).length : 0,
    }));
}

/* ------------------------------------------------------- 行清单快照 */

/** pluginId → { rows: [{id,title,collectionType,feed?}], at } */
const snapshots = new Map();
const refreshing = new Set();

/** 后台刷一次某插件的行清单；失败**保留上一份快照**（别让一次抖动把库全弄没了） */
async function refreshRows(pluginId) {
  if (refreshing.has(pluginId)) return;
  refreshing.add(pluginId);
  try {
    const r = await host.call('home', pluginId, 'rows', {}, { timeoutMs: 10000 });
    if (!r.ok) {
      console.log(`  ✘ 首页插件 ${pluginId} 的行清单没取到：${(r.error && r.error.message) || '未知原因'}`);
      return;
    }
    const rows = (r.value && Array.isArray(r.value.rows) ? r.value.rows : []).filter((x) => x && x.id);
    snapshots.set(pluginId, { rows, at: Date.now() });
  } catch (e) {
    console.log(`  ✘ 首页插件 ${pluginId} 的行清单没取到：${(e && e.message) || e}`);
  } finally {
    refreshing.delete(pluginId);
  }
}

/** 取某插件的行快照；没有或过期就**顺手踢一次后台刷新**，本次仍返回手上这份 */
function rowsOf(pluginId) {
  const snap = snapshots.get(pluginId);
  if (!snap || Date.now() - snap.at > SNAPSHOT_STALE_MS) refreshRows(pluginId);
  return snap ? snap.rows : [];
}

/** 等某个首页插件就绪（`running`）再拉它的行；起不来 / 崩了 / 超时就不等了 —— 后面 `rowsOf` 过期会自己再试 */
async function waitReady(pluginId, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const st = host.stateOf('home', pluginId);
    if (!st || st.status === 'running') return;
    if (st.status === 'broken' || st.status === 'stopped') return;
    if (Date.now() >= deadline) return;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * 开局预热：面板启动时（插件起来之后）把**所有启用中**首页插件的行清单拉一遍，
 * 免得第一发 `Views` 拿到空。**预热的是全部插件、不是只有被选中的那个** ——
 * 这样在面板上切换首页是瞬时的，不用等上游。
 * 插件进程从「启动中」到握手完成是异步的，所以**先等就绪再拉**（见 `waitReady`），
 * 不在就绪前空打一轮 `NOT_READY`。失败不挡启动 —— 反正过期会自己重试。
 */
async function warmHome() {
  const list = allHomePlugins();
  for (const st of list) {
    // eslint-disable-next-line no-await-in-loop
    await waitReady(st.id);
    // eslint-disable-next-line no-await-in-loop
    await refreshRows(st.id);
  }
  const total = allHomePlugins().reduce((n, st) => n + (snapshots.get(st.id) || { rows: [] }).rows.length, 0);
  if (list.length) console.log(`  ✔ 首页插件：${list.length} 个启用中，共 ${total} 行（每个实例选一个插件，其行 = 该实例客户端上的媒体库）`);
  return { plugins: list.length, rows: total };
}

/* ------------------------------------------------- 媒体库 Id（Views 端点用） */

/**
 * 首页插件的一行 → Emby 的一个媒体库（`Users/{id}/Views` 里的 `CollectionFolder`）。
 *
 * Id = `mbphome_` + base64url(`<插件id>|<行id>`)：
 *   - **稳定**：插件行不变则 Id 不变 —— 客户端拿它当主键缓存，飘了「已看」就丢；
 *   - **必须整体编码**：插件 id 与行 id 都允许 `.`/`_`/`-`，用分隔符硬拼根本没法可靠反解；
 *     而 base64url 的字符集只有 `[A-Za-z0-9_-]`，URL 安全（不会像 `#` 那样被客户端当锚点吃掉）；
 *   - 与条目 Id 前缀天然不冲突：`parseItemId` 认不出它，所以它只属于 Views。
 */
const VIEW_PREFIX = 'mbphome_';
const PLUGIN_ID_RE = /^[a-z][a-z0-9._-]{1,63}$/i;
const ROW_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

function viewId(pluginId, rowId) {
  return VIEW_PREFIX + Buffer.from(`${pluginId}|${rowId}`, 'utf8').toString('base64url');
}

/** viewId() 的逆 —— 与它挨着放（改格式时一眼看到要一起改）；认不出返回 null */
function parseViewId(id) {
  const s = String(id || '').trim();
  if (!s.startsWith(VIEW_PREFIX)) return null;
  let payload;
  try {
    payload = Buffer.from(s.slice(VIEW_PREFIX.length), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const i = payload.indexOf('|');
  if (i <= 0 || i === payload.length - 1) return null;
  const pluginId = payload.slice(0, i);
  const rowId = payload.slice(i + 1);
  if (!PLUGIN_ID_RE.test(pluginId) || !ROW_ID_RE.test(rowId)) return null;
  return { pluginId, rowId };
}

/* ------------------------------------------------- 行清单（同步读快照） */

/**
 * 所有「启用的」首页插件的行 —— Views 每个行做一个库。
 * 读的是**快照**：Views 是高频端点，没必要每次现问插件。
 */
function enabledRows() {
  const out = [];
  for (const st of homePlugins()) {
    for (const row of rowsOf(st.id)) {
      const declared = Number(row.total);
      const declaredEpisodes = Number(row.episodes);
      out.push({
        pluginId: st.id,
        rowId: row.id,
        title: row.title,
        pluginName: st.name,
        /* 行自己申报的库类型（插件已按当前参数定好）；没申报就如实当混合 */
        collectionType: row.collectionType || 'mixed',
        /* 行申报的**库总数**（可选，与 `run` 的 `total` 同口径）：客户端还没点开这个库时
         * 也能看到真数（`service.homeViewItem` 的 `ChildCount`）。没申报 / 拿不准就是 0 ——
         * 调用方回退占位值，别把 0 当成"库是空的"（见那条注释）。 */
        total: Number.isFinite(declared) && declared > 0 ? declared : 0,
        /* 行申报的**集数规模**（可选，只对剧库有意义）：供 `Items/Counts` 的 `EpisodeCount`
         * 用（`libraryTotals`）。没申报 / 拿不准就是 0，含义同上 —— 不编。 */
        episodes: Number.isFinite(declaredEpisodes) && declaredEpisodes > 0 ? declaredEpisodes : 0,
      });
    }
  }
  return out;
}

/**
 * 当前实例首页插件申报的**库规模**，按库类型归并（该类没有来源就是 `null`）。
 *
 * 行申报的 `total` 是**整个库的规模**（与 `run` 的 `total` 同口径，见 ADR-0051），所以同类型的
 * 多行是同一份规模的重述 —— **取最大的那个**，不相加（相加等于重复计数）。`mixed` 行说不清
 * 是电影还是剧集，**不参与**（宁可缺，不可编）。
 *
 * `episodes` 同理，只从**剧库**行归并（`mixed` 行不参与）：它填 `Items/Counts` 的 `EpisodeCount`。
 *
 * 给 `Items/Counts` 用（见 `service.getItemCounts`）。**只读快照、不触发上游**。
 */
function libraryTotals() {
  const out = { movies: null, tvshows: null, episodes: null };
  for (const r of enabledRows()) {
    if (r.collectionType === 'movies') {
      if (r.total > 0) out.movies = Math.max(out.movies || 0, r.total);
    } else if (r.collectionType === 'tvshows') {
      if (r.total > 0) out.tvshows = Math.max(out.tvshows || 0, r.total);
      if (r.episodes > 0) out.episodes = Math.max(out.episodes || 0, r.episodes);
    }
  }
  return out;
}

/**
 * 找**声明接某个 `feed` 的行**（第一个命中的），没找到回 `null`。
 *
 * 用来把客户端"不要库 Id、只要推荐"的查询路由到插件指定的那一行。
 * **返回 null 就让调用方如实回空** —— 绝不"随便挑一行顶上"：挑错了等于用内容撒谎，
 * 而且哪个插件接哪条查询只有插件作者知道（行里申报的 `feed` 就是他的声明）。
 */
function rowByFeed(feed) {
  const want = String(feed || '').trim();
  if (!want) return null;
  for (const st of homePlugins()) {
    for (const row of rowsOf(st.id)) {
      if (row.feed === want) return { pluginId: st.id, rowId: row.id, title: row.title };
    }
  }
  return null;
}

/* --------------------------------------------- 「最后一次看到的条目」 */

/**
 * 每个行**最近一次成功取到的条目**（面板侧记忆，给 `Views` 的库封面用）。
 *
 * 只在面板成功跑到一次内容时才更新；**重启即空**（与改造前"刚重启那一次没有封面"一致）。
 * 这不是缓存（没有存活期、也不落盘）—— 缓存归插件，这里只是"客户端的库封面从哪儿取一张图"。
 */
const seen = new Map();
const seenKey = (pluginId, rowId) => `${pluginId}\u0001${rowId}`;

function remember(pluginId, rowId, items, total) {
  if (items && items.length) seen.set(seenKey(pluginId, rowId), { items, total: Number(total) || 0 });
  if (seen.size > 500) seen.clear(); // 规模不需要 LRU，超了就整份丢（下次取到会再记）
}

/**
 * 只读地看一眼某一行**最近一次取到的条目**（没有就 `null`）—— **绝不触发上游**。
 *
 * 给 `Views` 的库封面用（见 `service.homeViewItem`）：封面只能从"这一行已经拿到过的条目"里取，
 * 而**专门为封面去打一次上游是不行的** —— 那份代价随行数线性增长（已定为红线）。
 */
function peekRowItems(pluginId, rowId) {
  const v = seen.get(seenKey(pluginId, rowId));
  return v ? v.items : null;
}

/**
 * 该行**最近一次取数时插件申报的总条数**（没有就 `null`）—— 同样**绝不触发上游**。
 * 给 `Views` 的 `ChildCount` 用（见 `service.homeViewItem`）：客户端点开过这一行就有真实数，
 * 没点开过就回退占位值（真假取舍写在那边）。
 */
function peekRowTotal(pluginId, rowId) {
  const v = seen.get(seenKey(pluginId, rowId));
  return v && v.total > 0 ? v.total : null;
}

/* --------------------------------------------------------- 条目归一化 */

/**
 * 一个 HomeItem。**只保留规范里列出的字段，其余一律丢弃**（含原型上的东西）——
 * 这样将来映射到 Emby BaseItemDto 时形状是可控的。缺 id / title / 合法 type 的条目直接丢。
 *
 * 这一步刻意留在面板侧：输入虽来自子进程，但子进程里跑着插件代码，不该由它决定进缓存什么。
 */
function normalizeItem(it) {
  if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
  const id = String(it.id || '').trim();
  const title = String(it.title || '').trim();
  const type = String(it.type || '').trim().toLowerCase();
  if (!id || !title) return null;
  if (type !== 'movie' && type !== 'tv') return null;

  const out = { id, type, title };
  if (it.originalTitle !== undefined) out.originalTitle = String(it.originalTitle || '').trim();
  const year = Number(it.year);
  if (Number.isFinite(year) && year > 0) out.year = Math.trunc(year);
  if (it.overview !== undefined) out.overview = String(it.overview || '').trim();
  const rating = Number(it.rating);
  if (Number.isFinite(rating) && rating > 0) out.rating = rating;
  const poster = httpUrl(it.poster);
  if (poster) out.poster = poster;
  const backdrop = httpUrl(it.backdrop);
  if (backdrop) out.backdrop = backdrop;
  if (Array.isArray(it.genres)) {
    const g = it.genres.map((x) => String(x || '').trim()).filter(Boolean);
    if (g.length) out.genres = g.slice(0, 20);
  }
  if (it.providerIds && typeof it.providerIds === 'object' && !Array.isArray(it.providerIds)) {
    const p = {};
    for (const [k, v] of Object.entries(it.providerIds)) {
      const s = String(v || '').trim();
      if (s && k) p[String(k).trim()] = s;
    }
    if (Object.keys(p).length) out.providerIds = p;
  }
  /* 片源定位坐标（可选）：`{source?, site, vodId}` —— 拿着它能跳过再搜索直接要详情。 */
  const loc =
    it.sourceLoc && typeof it.sourceLoc === 'object' && !Array.isArray(it.sourceLoc)
      ? it.sourceLoc
      : null;
  if (loc) {
    const source = String(loc.source || '').trim();
    const site = String(loc.site || '').trim();
    const vodId = String(loc.vodId || '').trim();
    if (site || vodId) out.sourceLoc = Object.assign({}, source ? { source } : {}, { site, vodId });
  }
  return out;
}

const httpUrl = (v) => {
  const s = String(v || '').trim();
  return /^https?:\/\//i.test(s) ? s : '';
};

/** 归一化一整行：接受数组或 `{items:[…]}`；按 id 去重；超过上限的计入 dropped */
function normalizeItems(raw) {
  const list = raw && typeof raw === 'object' && !Array.isArray(raw) && Array.isArray(raw.items) ? raw.items : raw;
  if (!Array.isArray(list)) throw fail('BAD_RESULT', '插件必须返回数组（或 {items:[…]}）');

  const items = [];
  const set = new Set();
  let dropped = 0;
  let dup = 0;
  for (const it of list) {
    const n = normalizeItem(it);
    if (!n) {
      dropped++;
      continue;
    }
    if (set.has(n.id)) {
      dup++;
      continue;
    }
    if (items.length >= MAX_ITEMS) {
      dropped++;
      continue;
    }
    set.add(n.id);
    items.push(n);
  }
  return { items, dropped, dup };
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/* ------------------------------------------------------------ 取数 */

/**
 * 把一条 Emby 列表查询路由到某个插件行 —— **列表数据由首页插件决定，emby 层只调这一个口子**。
 *
 * 现在只认 `ParentId=<mbphome_…>`（= 本层发给客户端的某个媒体库，见 `viewId`）；
 * 其余查询回 `null` =「不归本模块管」，由 emby 层如实回空。
 *
 * **分页是原样透传的**：客户端的 `StartIndex` / `Limit` 直接进插件动作，
 * 取哪一页、要不要按页打上游由**插件**决定；emby 层与这里都**不切片**。
 *
 * @returns {Promise<{items:object[], total:number, pluginId:string, rowId:string, cached:boolean}|null>}
 *          插件取数失败时**抛错**（调用方照实回失败码，不编空数据）
 */
async function listByQuery(query) {
  const get = (k) => (query && typeof query.get === 'function' ? query.get(k) || '' : '');
  const parsed = parseViewId(get('ParentId'));
  if (!parsed) return null;

  const r = await host.call(
    'home',
    parsed.pluginId,
    'run',
    {
      rowId: parsed.rowId,
      startIndex: Number(get('StartIndex')) || 0,
      limit: Number(get('Limit')) || 0,
    },
    { timeoutMs: 30000 }
  );
  if (!r.ok) {
    const info = r.error || {};
    const e = fail(info.code || 'PLUGIN_ERROR', info.message || '首页插件取数失败');
    if (info.status !== undefined) e.status = info.status;
    if (info.data !== undefined) e.data = info.data;
    throw e;
  }

  const v = r.value || {};
  const n = normalizeItems(v.items);
  const declared = Number(v.total);
  const total = Number.isFinite(declared) && declared > 0 ? declared : n.items.length;
  remember(parsed.pluginId, parsed.rowId, n.items, total);
  return {
    items: n.items,
    total,
    pluginId: parsed.pluginId,
    rowId: parsed.rowId,
    cached: !!v.cached,
  };
}

module.exports = {
  MAX_ITEMS,
  viewId,
  parseViewId,
  enabledRows,
  libraryTotals,
  peekRowItems,
  peekRowTotal,
  /** 首页插件原始条目 → HomeItem（output 插件 hostCall home.run 复用同一口径，勿再造一份） */
  normalizeItems,
  rowByFeed,
  listByQuery,
  warmHome,
  pluginChoices,
};