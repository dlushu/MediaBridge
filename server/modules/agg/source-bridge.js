'use strict';
/**
 * 源插件转接处：**面板侧唯一一处**知道"取数要去调哪个插件的哪个动作"。
 *
 * 存在的理由：聚合层（`service.js`）那套判据是按"上游 HTTP 响应"写的 ——
 * `status === 404` 就是"这个站没有这部片"、超时要与别的错分开报、每站都要记账……
 * 这些口径这一批**一个字都不该改**。所以这里把插件的回复**还原成上游那份形状**
 * （`{ status, ok, text, json }`；失败抛异常，超时抛 `AbortError`），
 * 上面那几处调用点于是只换了一行 —— 这是本批"行为不变"的实现手法。
 *
 * 身份：**`source` = `插件 id / 实例 id`**（契约第九节：站点身份按"插件 + 站点 key"记）。
 * 面板不关心实例背后的地址与端口 —— 那是插件自己的事；这里只做"拆开、转过去、还原回来"。
 *
 * ⚠️ 面板也是**从这里**才知道"有哪些源、有哪些站点"：源不再是面板的配置，
 * 而是插件申报上来的（`站点清单`）。
 */
const host = require('../plugin/host');

/** 默认每次调用插件的超时；取数动作都会带上自己的超时，这个只是兜底 */
const DEFAULT_TIMEOUT_MS = 60000;

/** `插件 id / 实例 id` —— 实例 id 里不允许出现 `/`，所以按第一个斜杠拆是安全的 */
function joinRef(pluginId, instanceId) {
  return String(pluginId || '') + '/' + String(instanceId || '');
}

function splitRef(ref) {
  const s = String(ref || '');
  const at = s.indexOf('/');
  if (at < 0) return { pluginId: '', instanceId: '' };
  return { pluginId: s.slice(0, at), instanceId: s.slice(at + 1) };
}

/**
 * 参与聚合的源插件 = **已安装且启用**的 `source` 类型插件。
 * 没在跑（崩了 / 还没起来）也照样算进来 —— 它会如实报"没在运行"，而不是从清单里消失。
 */
function sourcePlugins() {
  return host.states().filter((x) => x.type === 'source' && x.enabled);
}

/** 转一次动作；`NOT_RUNNING` / `NO_ACTION` 之类**如实抛**（调用方各自决定怎么呈现） */
async function callPlugin(pluginId, action, args, timeoutMs) {
  const r = await host.call('source', pluginId, action, args, {
    timeoutMs: Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
  });
  if (!r.ok) {
    const err = r.error || {};
    const e = new Error(err.message || '插件调用失败');
    e.code = err.code || 'PLUGIN_ERROR';
    e.plugin = pluginId;
    e.action = action;
    throw e;
  }
  return r.value;
}

/**
 * 插件回复 → 上游响应形状。
 *
 * 成功：`{ status, ok, text, json }` 原样（`ok` = 那个站回的 HTTP 是不是 2xx，判据在 service.js）
 * 失败：抛。**超时抛 `AbortError`** —— 面板那几处 catch 就是靠它把"超时"与别的错分开的
 *       （文案由调用方按自己的超时值拼，所以这里一个字都不用编）。
 */
function asUpstream(res) {
  if (res && res.error) {
    const err = res.error;
    const e = new Error(err.message || '取数失败');
    e.code = err.code || 'UPSTREAM';
    if (err.code === 'TIMEOUT') e.name = 'AbortError';
    throw e;
  }
  return {
    status: Number(res && res.status) || 0,
    ok: !!(res && res.ok),
    text: String((res && res.text) || ''),
    json: (res && res.json) || null,
    initCalled: !!(res && res.initCalled),
    /* 下面这几样是"插件替面板做好的那半件事"，必须原样带过来（漏一样就会静默走错分支）：
     *   · `detail` / `detailNote` = 「线路 → 选集」结构（面板不再自己解析 `$$$`）
     *   · `urls` / `header` / `parse` = 「解析地址」的结果（面板只负责 302）
     *   · `name` = 实例的显示名（单站测速的回执要写"测的是哪个源"） */
    detail: (res && res.detail) || null,
    detailNote: String((res && res.detailNote) || ''),
    /* 直绑回传的资源级坐标（契约 `binds`）：插件在 `detail` 出参顶层回的 `vod_id` —— 面板**不解释**，
     * 原样往上传（聚合层把它记进绑定，见 `contract-source.md`「直绑元数据域条目 Id」）。
     * ⚠️ 必须显式带过来：本函数是"白名单"式的，漏一行这个字段就静默丢了。 */
    vod_id: String((res && res.vod_id) || ''),
    urls: Array.isArray(res && res.urls) ? res.urls : [],
    header: (res && res.header) || {},
    parse: Number((res && res.parse) || 0),
    name: String((res && res.name) || ''),
  };
}

/** 站点清单：**所有启用的源插件各报一份**，这里合并成面板那一份形状 */
async function loadSites() {
  const plugins = sourcePlugins();
  const rows = [];
  const sites = [];

  for (const p of plugins) {
    let out;
    try {
      // eslint-disable-next-line no-await-in-loop
      out = await callPlugin(p.id, 'sites', {}, 60000);
    } catch (e) {
      /* 整个插件问不动 —— 也占一行如实说，别让它静默消失（否则界面看起来像"这个插件根本没站点"） */
      rows.push({
        id: joinRef(p.id, ''),
        plugin: p.id,
        url: '',
        name: p.name || p.id,
        enabled: true,
        mode: 'plugin',
        deployed: false,
        port: null,
        status: p.status,
        running: false,
        ok: false,
        ms: 0,
        siteCount: 0,
        error: `源插件「${p.name || p.id}」问不动：${(e && e.message) || e}`,
      });
      continue;
    }
    for (const r of (out && out.sources) || []) {
      rows.push(
        Object.assign({}, r, {
          id: joinRef(p.id, r.id),
          plugin: p.id,
          /* `deployed` = "本地部署"（面板原来那个词）—— 前端与 emby 层照旧按它区分两类源 */
          deployed: r.mode === 'local',
        })
      );
    }
    for (const s of (out && out.sites) || []) {
      sites.push(
        Object.assign({}, s, {
          source: joinRef(p.id, s.source || ''),
          /* 该插件声明的直绑域（契约 binds，包级、对它每个站点生效）——
           * 聚合层据此把对应域的 entryId 直接交给 detail、跳过按名搜索 */
          binds: Array.isArray(p.binds) ? p.binds.slice() : [],
        })
      );
    }
  }

  return { sources: rows, sites };
}

/** 找一个启用中的源插件；认不出就如实报（不猜、不回退到别的插件） */
function requirePlugin(pluginId) {
  const id = String(pluginId || '');
  const plugin = sourcePlugins().find((x) => x.id === id);
  if (!plugin) {
    const e = new Error(`源插件 ${id} 没安装或没启用`);
    e.code = 'NO_PLUGIN';
    throw e;
  }
  return plugin;
}

/** 一个动作的通用调用：按 `插件 id / 实例 id` 转过去 */
async function callAction(ref, action, args) {
  const { pluginId, instanceId } = splitRef(ref);
  if (!pluginId) {
    const e = new Error(`认不出这个源：${ref || '(空)'}（形状是「插件 id / 实例 id」）`);
    e.code = 'BAD_SOURCE_REF';
    throw e;
  }
  requirePlugin(pluginId);
  return callPlugin(pluginId, action, Object.assign({ source: instanceId }, args));
}

/**
 * 在途的 search：同键（实例 + 站点 + 词 + 页）并发**只放一发**，后来的等同一个结果。
 *
 * 为什么在面板这一层合：插件自己的缓存是"返回后才写入"的读穿缓存，网页聚合搜索与客户端
 * 播放链**同时**问同一片时，两发都赶在缓存写入前，会实打实打上游两遍（MissAV 首搜 >20s，
 * 撞上的概率不低）。在这里合，所有源插件一处受益。
 *
 * 不合另外两个：
 *   · `detail` —— 插件侧已各自做了同键 inflight 合并；
 *   · `probe` —— 测速测的就是真实往返，合到在途搜索上读出来的延迟是假的。
 */
const searchInFlight = new Map();

/** 搜索一个站（两层式站点的第一步） */
async function search(ref, args) {
  const a = args || {};
  const key = JSON.stringify([String(ref), String(a.key || ''), String(a.wd || ''), Number(a.page) || 1]);
  const going = searchInFlight.get(key);
  if (going) return asUpstream(await going);
  const job = callAction(ref, 'search', a).then(
    (v) => {
      searchInFlight.delete(key);
      return v;
    },
    (e) => {
      searchInFlight.delete(key);
      throw e;
    }
  );
  searchInFlight.set(key, job);
  return asUpstream(await job);
}

/** 取一个站的详情（**插件自己解析**成「线路 → 选集」，每项带一个面板不解释的 `ref`） */
async function detail(ref, args) {
  return asUpstream(await callAction(ref, 'detail', args));
}

/**
 * 解析播放地址：面板把**插件自己编的 `ref`** 原样交回去（面板不解释它的内容，只按第一段路由）。
 *
 * 与上面那三个的区别：那三个的 `ref` 是「插件 id / 实例 id」（面板知道实例 id），
 * 这一个的 `ref` 是**插件自己的东西**（面板只把它当一串不透明文本）。
 * 客户端主机名（`clientHost`）要一起给过去 —— 本地部署的实例回的是回环地址，
 * 插件要拿它拼成"客户端够得着"的地址（这一步归源插件）。
 */
async function play(ref, args) {
  const { pluginId } = splitRef(ref);
  if (!pluginId) {
    const e = new Error(`认不出这个播放 ref：${String(ref || '').slice(0, 80) || '(空)'}`);
    e.code = 'BAD_REF';
    throw e;
  }
  const plugin = requirePlugin(pluginId);
  return asUpstream(await callPlugin(pluginId, 'play', Object.assign({ ref: String(ref) }, args)));
}

/** 站点测速（体检口径的一发） */
async function probe(ref, args) {
  return asUpstream(await callAction(ref, 'probe', args));
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  joinRef,
  splitRef,
  sourcePlugins,
  callPlugin,
  callAction,
  loadSites,
  search,
  detail,
  play,
  probe,
};
