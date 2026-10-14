'use strict';
/**
 * **emby 层与元数据插件打交道的那一层**（面板中立：本文件不认识某个具体域）
 *
 * 四件事：
 *   ① `itemId` / `parseItemId` —— Emby 条目 Id 的派生与解析（形状由 `core/providers.js` 统一规定）；
 *   ② `httpStatusOf` —— 失败原因 → 该回给客户端的 HTTP 状态码；
 *   ③ **图片地址**：按插件申报的基地址拼串 + 出 tag（图片的代取与签名在面板这边，
 *      见 docs/adr/0013）。基地址来自**元数据插件的域声明**（同步快照，见 `meta.declSync`）；
 *   ④ **取数转发**：取元数据 / 取一季分集 / 按名字搜索 → 交给插件（面板不解析上游字段）。
 *
 * 插件回的就是**面板的中立字段**（`entryId` / `type` / `personId`…，形状由插件契约第六节规定）
 * —— 本层**不做任何改名**：`service.js` 直接消费这份中立形状，拼 DTO 时才翻成 Emby 的字段
 * （`Id` / `Type` / `People[]`…）。即「插件负责上游 → 面板形状，emby 层负责面板形状 → Emby DTO」。
 *
 * **域是参数，没有"默认域"**：`itemId()` / `imageUrlOf()` / `providerIdKey()` 都按域取数，
 * 域由 `parseItemId` 从条目 Id 的前缀带出来（`p.domain`）。确实没传域时，由 `defaultDomain()`
 * **按当前实例配置 / 已启用插件现算** —— 装哪个域就用哪个域。
 * 条目编号在这一层统一叫 `entryId`（与 `core/providers.js`、插件契约同一份词汇）——
 * 它是**提供者自己的编号**（数字或 slug 都可能），条目 Id 只透传它、不解释
 * （见 `core/providers.js` 与 docs/adr/0031）。
 */
const providers = require('../../core/providers');
const meta = require('./meta');
const { imageKindOf } = require('../../core/image-url');
const instance = require('./instance');

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');

/**
 * 没显式给域时的兜底域 —— **现算，不写死**。
 *
 * 顺序：
 *   ① 当前 Emby 实例限定的域里的第一个（`metaDomains[0]`）—— 实例自己选了搜哪些域，
 *      那就是这台实例的"默认"；`metaDomains` 是空数组（显式不搜任何域）时如实回空；
 *   ② 没实例上下文 → 取第一个**已装且启用**的元数据域；
 *   ③ 一个都没有 → 空串（调用方据此如实报"没有可用的元数据域"，别硬编一个域去问）。
 */
function defaultDomain() {
  const cur = instance.current();
  if (cur && Array.isArray(cur.metaDomains)) return String(cur.metaDomains[0] || '');
  const on = providers.list().find((p) => p.enabled);
  return on ? on.prefix : '';
}

/** 「没有可用的元数据域」的统一错误（503：这台服务器现在给不出元数据，不是客户端要的东西有问题） */
function noDomainError() {
  return { code: 'NO_PLUGIN', status: 503, message: '没有可用的元数据域（没装或没启用元数据插件）' };
}

/**
 * 失败原因 → 该回给客户端的 HTTP 状态码。
 *
 * 上游给过状态码就**照搬**（401/403/404/429/5xx…）—— 让客户端看到的就是真实失败原因；
 * 上游没给（网络层）才由本层归类：超时 504、连不上 502。
 * 插件这一层的四种（没装 / 没启用 / 没在跑 / 没这个动作）一律 503 ——
 * 那是"这台服务器现在给不出元数据"，不是客户端要的东西有问题。
 */
function httpStatusOf(error) {
  const e = error || {};
  if (e.status) return e.status;
  if (e.code === 'TIMEOUT') return 504;
  if (e.code === 'NO_TOKEN') return 500; // 插件还没配 token，不是客户端的问题
  if (e.code === 'BAD_ID') return 400;
  if (e.code === 'NO_PLUGIN' || e.code === 'PLUGIN_DISABLED' || e.code === 'PLUGIN_DOWN' || e.code === 'NO_ACTION') return 503;
  return 502;
}

/**
 * Emby 条目的 Id：只由「元数据坐标」派生，**不含源信息**。
 *
 * 客户端拿到它当主键回查（详情 / 季集 / 图片 / 播放都只带 Id），所以它必须稳定：
 * 掺进"哪次搜索、哪个站点"就会因为源变动而变 Id，客户端缓存的「已看」会全丢。
 * 带 type 是因为同一个编号在 tv 与 movie 下是两条不同数据。
 *
 * 形状与拼装规则住在 `core/providers.js`（**认哪个前缀**由那张注册表说了算）。
 * 传了 season 就是季：`{域}_{编号}_tv_s1`；再传 episode 就是集：`{域}_{编号}_tv_s1_e3`
 * （电影分不了季，季分不了集 —— 层级只能一级一级往下走）。
 */
function itemId(domain, type, entryId, season, episode) {
  return providers.itemId(domain, entryId, type, season, episode);
}

/**
 * itemId() 的逆 —— 必须与它互逆，所以紧挨着放（改格式时一眼能看到要一起改）。
 * 内部走注册表解析，字段名沿用 `core/providers.js` 的中立形状（`entryId`），
 * 只额外把 `prefix` 翻成 `domain`（聚合层按它解析"该用哪套模板"）。
 *
 * 认不出来 / 前缀没有对应的插件 / 条目编号为空或含非法字符 / 电影带季号 / 有集号却没有季号 → null。
 *
 * 另外回一个 `shape` —— id 的**形状**（`movie` / `show` / `season` / `episode`），认不出回 `null`。
 * 「哪种 id 归哪一支」的判定只此一处：详情 / 季 / 集的调用方一律照 `shape` 分派，
 * 不各自去拼 `type` / `season` / `episode` 重新推一遍（见 docs/emby-semantics.md「三、收敛纪律」）。
 * `shape` 是派生的，`parseItemId` 与 `itemId` 仍然互逆。
 */
function parseItemId(id) {
  const p = providers.parseItemId(id);
  if (!p) return null;
  /* 形状由上游解析结果派生：电影不带季号、集号必有季号，所以四种之外不会有别的组合。 */
  const shape = p.season === null ? (p.type === 'movie' ? 'movie' : 'show') : p.episode === null ? 'season' : 'episode';
  return { type: p.type, entryId: p.entryId, season: p.season, episode: p.episode, domain: p.prefix, shape };
}

/* ---------------------------------------------------------------- 图片 */

/**
 * 该域当前生效的图片基地址：插件的域声明里那个（插件没申报就如实回空）——
 * 面板不替任何域兜一个默认值，"官方地址"是插件自己 settings 里的默认，归它自己。
 */
function imageBase(domain) {
  const decl = meta.declSync(domain);
  return stripSlash((decl && decl.imageBase) || '');
}

/**
 * 拼图片地址（**写入侧**：插件给的图片字段 → 面板存进索引/编进 tag 的地址）。
 *
 * 按 `core/image-url.js` 的三形态分派（判据只有一条：是不是中继前缀，见 ADR-0079）：
 *   · `absolute` 完整 http(s) 地址 → **原样返回**（插件给整串 URL 时面板不擅自改写）；
 *   · `relay`    面板自己的图片中继形态（`/api/emby/img/…`）→ **原样返回**：出图那一跳补
 *     签名与本跳 origin（见 `emby/routes.js` 的 `imagesByType`）。⚠️ 这一形态**不能落进下面的
 *     "拼基地址"分支** —— 会被拼成空串，表现是插件把封面指到中继后条目一个 `ImageTags` 都没有。
 *   · `relative` **图床自己**的相对路径（TMDB 的 `poster_path` 就长这样）→ 按该域的 `imageBase`
 *     拼成完整地址。**这是这一档唯一正确的处置**：把它当成"面板自己的地址"补本机 origin，
 *     会产出客户端取不到的死地址（实测：整库封面刷 501，反例见 ADR-0079）。
 */
function imageUrlOf(domain, size, filePath) {
  const p = String(filePath || '');
  const kind = imageKindOf(p);
  if (kind === 'none') return '';
  if (kind === 'absolute' || kind === 'relay') return p;
  const base = imageBase(domain);
  return base ? `${base}/${size}${p}` : '';
}

/**
 * 域 → `ProviderIds` 里那个键（客户端拿它做外部 id 反查）：按域 id 首字母大写。
 * 客户端认的那几个键都正好是这条规则的结果，所以不需要一张映射表；
 * 多一个域也不该因为少一条映射就整条 DTO 拼不出来。
 */
function providerIdKey(domain) {
  const d = String(domain || defaultDomain() || '').trim().toLowerCase();
  if (!d) return 'Provider';
  return d.replace(/^[a-z]/, (c) => c.toUpperCase());
}

/**
 * 把客户端发来的**外部 id 引用前缀**认成一个已注册的元数据域（大小写不敏感）。
 *
 * 客户端的 `AnyProviderIdEquals` 是 `{前缀}.{编号}` 形状（Emby 惯例），前缀就是域 id。
 * **认不出就回 null，不猜** —— 同搜索分派的口径：认不出的前缀如实回空并点名
 * （见 docs/plugin-contract.md）。
 */
function domainOfRef(prefix) {
  const p = providers.byPrefixOf(prefix);
  return p ? p.prefix : null;
}

/**
 * 条目站点外链 —— 插件在 `register` 里申报的 `links`（`{ name, url }`，`url` 里的
 * `{type}` / `{id}` 由面板替换成 Emby 用的 `movie|tv` 与该条目的编号）。
 *
 * 为什么要插件申报：条目编号是**提供者自己的**，只有它知道该拿这个编号去哪个站点拼链接。
 * 面板不认识任何具体站点 —— 插件不申报就没有这一条，不猜也不兜。
 */
function entryLinks(domain, { type, entryId } = {}) {
  const decl = meta.declSync(domain);
  const tpls = decl && Array.isArray(decl.links) ? decl.links : [];
  const id = String(entryId === undefined || entryId === null ? '' : entryId).trim();
  if (!id) return [];
  const kind = type === 'movie' ? 'movie' : 'tv';
  const out = [];
  for (const one of tpls) {
    const name = String((one && one.name) || '').trim();
    const tpl = String((one && one.url) || '').trim();
    if (!name || !tpl) continue;
    out.push({ name, url: tpl.replace(/\{type\}/g, kind).replace(/\{id\}/g, encodeURIComponent(id)) });
  }
  return out;
}

/* ---------------------------------------------------------------- 取数（转发给元数据插件） */

/**
 * 当前 Emby 实例的 metaDomains 是否允许这个域。
 *
 * 实例上 `metaDomains` 有三种口径（见 instance.js 的 publicInstance）：
 *   null / undefined —— 字段缺席，**不限域**（默认实例与老实例），放行；
 *   空数组 `[]`      —— 显式"不允许任何域"，拒绝所有；
 *   非空数组         —— 只有列出来的域才放行；
 * 没有实例上下文（面板内部端点直接调本层）→ 也放行（面板自己不做域隔离）。
 *
 * 这条**是硬性契约**：客户端从一个实例里拿到的条目 id 前缀是 A，它就永远
 * 属于 A 域 —— 实例既然选了允许的域，任何端点（搜索/详情/图片/播放）都不能
 * 把不在清单里的域放进来。
 */
function domainAllowed(domain) {
  const inst = instance.current();
  if (!inst) return true; // 没有实例上下文时放行（面板自用端点）
  const only = inst.metaDomains;
  if (only === null || only === undefined) return true; // 字段缺席 = 不限域
  const want = String(domain || '').toLowerCase();
  return Array.isArray(only) && only.some((d) => String(d).toLowerCase() === want);
}

/**
 * 反查一个条目 —— 单一实现，Emby 各端点都走这里。
 * 不抛异常：`{ ok: true, item }` 或 `{ ok: false, error: {code,status?,message} }`
 *
 * `item` 是**插件契约的中立形状，原样返回**（`entryId` / `type` / `cast[].personId`…），
 * 翻译成 Emby DTO 是 service.js 的事，这一层不改名。
 *
 * withSeasons：把剧的 seasons[] 一并归一化挂到 item.seasons（季列表端点用）。
 * 默认关 —— 否则整包季数组会跟着条目一起回给客户端，纯噪声。
 * rich：详情页要的那一批（分级/时长/标语/演职/公司/关键词/预告/图集/相似）。
 */
async function lookup({ type = 'tv', entryId, rich = false, withSeasons = false, domain = defaultDomain() } = {}) {
  if (!domain) return { ok: false, error: noDomainError() };
  if (!domainAllowed(domain)) {
    return { ok: false, error: { code: 'DOMAIN_NOT_ALLOWED', status: 403, message: `实例未允许域 ${domain}` } };
  }
  const out = await meta.lookup(domain, { entryId, type, rich, withSeasons });
  if (!out.ok) return { ok: false, error: out.error };
  return { ok: true, item: out.item };
}

/**
 * 反查某一季的分集 —— 面板侧不再认识 `/tv/{id}/season/{n}`，那是插件的事。
 * 与 `lookup()` 同一取向：不抛异常、返回值保持插件契约的中立形状。
 */
async function lookupSeason({ entryId, season, domain = defaultDomain() } = {}) {
  if (!domain) return { ok: false, error: noDomainError() };
  if (!domainAllowed(domain)) {
    return { ok: false, error: { code: 'DOMAIN_NOT_ALLOWED', status: 403, message: `实例未允许域 ${domain}` } };
  }
  const out = await meta.season(domain, { entryId, season });
  if (!out.ok) return { ok: false, error: out.error };
  return { ok: true, item: out.item };
}

/**
 * 按名字搜索 —— 给 emby 的搜索端点用。
 *
 * 走每个**已装且启用**的元数据域的「搜索」动作，按域顺序拼接。
 * **域还被当前实例限定**：实例上存了「搜索通过的域」（`instance.metaDomains`）时只走那些域；
 * 字段缺席（`null`）= 全部域，空数组 = 一个都不搜（见 `instance.js`）。
 * 失败**照实抛**（调用方按类型分别 catch，一个域失败不影响别的域）。
 * 每一行都带上是哪个域的（`domain`）—— 条目 Id 将来就是按它拼的。
 * ⚠️ 行里是**归一化字段**（`entryId` / `title` / `posterPath`…），不翻成上游那套叫法：
 * 消费方（`searchRowDto`）读的就是这几个名字 —— 面板不该懂上游的字段形状。
 */
async function search(type, name, page) {
  const cur = instance.current();
  /* 实例限定的域（小写，见 instance.normDomains）；null = 不限，即全部域 */
  const only = cur && Array.isArray(cur.metaDomains) ? cur.metaDomains.map((d) => String(d).toLowerCase()) : null;
  const all = providers.list();
  const pool = only ? all.filter((p) => only.includes(String(p.prefix).toLowerCase())) : all;
  const on = pool.filter((p) => p.enabled);
  /* 一个开着的域都没有 ⇒ **如实报错，不回空列表**：客户端搜不到东西时，
   * "元数据插件没启用"与"上游确实没有这部片"是两件事，混成一样就查不下去了。 */
  if (!on.length) {
    const labels = pool.map((p) => p.label);
    const e = new Error(
      labels.length
        ? `元数据插件 ${labels.join('、')} 没启用（「插件」页可以打开）`
        : only && only.length
          ? `这个实例选定的搜索域（${only.join('、')}）都没有对应的元数据插件（「插件」页可以装/启用）`
          : only
            ? '这个实例没有勾选任何搜索域（客户端搜不到内容）'
            : '还没有装元数据插件（「插件」页可以装一个）'
    );
    e.code = labels.length ? 'PLUGIN_DISABLED' : 'NO_PLUGIN';
    throw e;
  }
  /* **电影式的域不接 `tv` 这一趟**：它声明的条目只有条目一层（`series: false`），
   * 拿 `tv` 去问它只会得到一串被标成剧集的行。这一趟如实回空，让 `movie` 那一趟去问它。 */
  const live = on.filter((p) => type === 'movie' || p.series !== false);
  const out = [];
  for (const p of live) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await meta.search(p.prefix, type, name, page);
    for (const r of rows || []) out.push(Object.assign({}, r, { domain: p.prefix }));
  }
  return out;
}

module.exports = {
  defaultDomain,
  httpStatusOf,
  itemId,
  parseItemId,
  providerIdKey,
  domainOfRef,
  entryLinks,
  lookup,
  lookupSeason,
  search,
  imageUrlOf,
};