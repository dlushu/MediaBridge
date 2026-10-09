'use strict';
/**
 * 聚合模块 · 「聚合搜索」页：一个关键字并发打多源多站，结果按站点顺序拼接（不去重）。
 * 结果只有**合并视图**一种摆法（renderMerged，不设视图开关）。
 *
 * **打分匹配**：搜索这一步就给每条结果打分（口径见 `server/modules/agg/match.js`）：
 *   · 搜索行里带**电影 / 剧集**这次要的是哪种，以及**季 / 集 / 年份**（"要哪一部"的坐标，与关键字同属搜索参数）；
 *     选剧集时季与集必填（少一个，详情那步定位不到那一集），选电影不问季集 —— 这一条与客户端那条路一致
 *     （客户端对电影是按「每条线路的全部播放项」列的，见 docs/adr/0022）；
 *   · 每条结果上标 `命中 0.95` / `没进 0.72（为什么）`，命中的左边有一道高亮；
 *   · 「这条的版本」→ 拿 `source+site+vodId` 走快路径调 `detail`，**弹窗**显示客户端会看到什么
 *     （线路 N · 定位到这一集 M、逐条线路的定位情况）。
 *     弹窗里**逐条标出「线路过滤」与「定位」的结论**。
 *
 * 布局上的取舍：**模板选择器 + 电影/剧集**打头，后面跟搜索参数（关键字 / 季 / 集 / 年份）与按钮，同一行；
 * 下面一行只放「全量站点」这个调试开关
 * —— **打分与调优旋钮一概不放这里**（分数线 / 条数 / 超时 / 并发 / 线路过滤都是"这一套模板"的属性，
 * 在「聚合设置 · 模板」里改一处，见 docs/adr/0033）；**上游第几页也不放**（客户端那条路固定取第 1 页，
 * 翻页只会看到客户端拿不到的结果）；
 * 结果里**命中的排前面、长列表折叠**；不单列"匹配失败"卡片（合并视图里每条都写着"没进 + 原因"）；
 * 版本详情**弹窗**显示，而不是追加到页面最底部（追加在最底部时不易发现）。
 *
 * ⚠️ 这一页的定位是**诊断台**而不是日常入口：客户端要片子走的是 `/api/agg/*`（Emby 那侧调），
 * 不经过这个页面。这里用来回答"这个名字为什么一条都没命中""某个站到底回了什么""客户端点开
 * 这个条目会看到哪些线路"。
 */
import { el, toast, modal } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { ensureAggSites, ensureTemplates } from '../../core/store.js';
import { renderPage } from '../../core/shell.js';

/** 一个站超过这么多条就先折叠，点「展开」再看（一个站挂上百条同名很常见） */
const FOLD_AT = 12;

export async function renderAgg(v) {
  /* 模板决定"这次搜索用哪批站点、默认参数是多少"，模板就在**这一页上挑**（见 docs/adr/0033）。
   * 模板清单不走源探测，几十毫秒 —— 等它一下，页面才不会先用错默认值画一遍。 */
  try {
    await ensureTemplates();
  } catch {
    /* 拿不到就按空模板画：下面的模板选择器会显示"（还没有模板）" */
  }
  const tpls = S.aggTemplates || [];
  /* 模板是**页面上显式选的**，不猜：选过的那套被删了就重挑一套 ——
   * 先跟「模板」页正在编的那套（多半就是刚调过参数的那套），再退到第一套。 */
  if (!S.aggTpl || !tpls.some((t) => t.id === S.aggTpl)) {
    S.aggTpl = (tpls.some((t) => t.id === S.tplId) ? S.tplId : (tpls[0] || {}).id) || '';
  }
  const tpl = tpls.find((t) => t.id === S.aggTpl) || null;
  const tplSites = (tpl && tpl.sites) || [];

  const wdInput = el('input', { type: 'text', placeholder: '搜索关键字，例如：斗破苍穹', value: S.aggKeyword, spellcheck: 'false' });
  wdInput.addEventListener('input', () => (S.aggKeyword = wdInput.value));
  wdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run();
  });
  const useAllCb = el('input', { type: 'checkbox', checked: S.aggUseAll });
  useAllCb.addEventListener('change', () => {
    S.aggUseAll = useAllCb.checked;
    renderPage();
  });

  /* ---- 电影 / 剧集：这次要的是哪种 ----
   * 它决定两件事（都是"客户端会怎么要这部片"的形状）：
   *   ① 必填项：**剧集必须填季与集**（客户端是按上游的季集号来要片子的，缺了定位不到那一集）；
   *      电影不问季集 —— 客户端对电影是按「每条线路的全部播放项」列的；
   *   ② 弹窗用哪套取法：电影走 `pick: 'items'`，剧集按季集定位（见 docs/adr/0022）。 */
  const kind = S.aggKind === 'movie' ? 'movie' : 'tv';
  const isMovie = kind === 'movie';
  const kindSel = el('select', { title: '这次要的是电影还是剧集：电影不问季集，剧集必须填季与集' });
  for (const [val, text] of [['tv', '剧集'], ['movie', '电影']]) {
    kindSel.append(el('option', { value: val, text, selected: val === kind }));
  }
  kindSel.addEventListener('change', () => {
    S.aggKind = kindSel.value;
    renderPage();
  });

  /* ---- 打分用的输入（只有季 / 集 / 年份）----
   * 分数线、最多几条、超时、并发、线路过滤**这一页都不填** —— 它们属于模板，
   * 在「聚合设置 · 模板」里改一处（读一份模板就能拿到全部调优项，见 docs/adr/0033）。
   * 季 / 集 / 年份是"这次要哪一部"的坐标，与关键字同属搜索参数，留在这一行。
   * 宽度档位见 style.css 的 `.fld > input.w-*`：季 / 集 / 年份只要小框（w-xs）。 */
  const numInput = (key, fallback, min, max, title, cls, ph) => {
    const cur = S[key] === undefined || S[key] === null ? fallback : S[key];
    const inp = el('input', {
      type: 'number',
      class: cls || 'w-sm',
      value: String(cur),
      min: String(min),
      max: String(max),
      title: title || '',
      placeholder: ph || '',
    });
    inp.addEventListener('input', () => (S[key] = inp.value));
    return inp;
  };
  /* 三个框并排，里面靠占位字说明各是哪个（标签写"剧集定位"就够，不必再重复一遍"季/集/年份"） */
  const seasonInput = numInput('aggSeason', '', 0, 99, '剧集必填：客户端是按上游的季号来要片子的；源里集名的季号对不上会判「季不同」', 'w-xs', '季');
  const episodeInput = numInput('aggEpisode', '', 0, 9999, '剧集必填：想让这一集「能定位到」就必须填它（客户端是按上游的集号来要片子的）', 'w-xs', '集');
  const yearInput = numInput('aggYear', '', 1900, 2100, '打分用：年份权重最低（0.1），填错也不会一票否决', 'w-xs', '年份');

  /**
   * 输入框取值 → 数字（留空 = 不传这一项）。
   *
   * ⚠️ **必须转成数字**：`input.value` 拿到的是**字符串**，而判季号用的是严格相等
   * （见 match.js 的 `want.season === sig.season`）—— 发 `season: "1"` 会被判成"季不同"，
   * 所有条目季集分归 0、全体掉到 0.739 被分数线淘汰（实测：页面上填了「季」就一条都不命中）。
   * 数字解析不出来（如 `-`、`1e`）按"没填"处理，别把 `NaN` 传下去。
   */
  const num = (inp) => {
    const raw = String(inp.value === undefined || inp.value === null ? '' : inp.value).trim();
    if (raw === '') return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  };

  async function run() {
    const wd = wdInput.value.trim();
    if (!wd) return toast('请输入关键字', true);
    /* 剧集必须给足季与集：少了集号，详情那一步没法定位到这一集（打回来的全是"没定位到"）；
     * 少了季号，打分就判不出"这部片对不对得上那一季"。电影不问这两个（见上面那段）。 */
    if (!isMovie) {
      if (num(seasonInput) === undefined) return toast('选「剧集」时要填季号', true);
      if (num(episodeInput) === undefined) return toast('选「剧集」时要填集号', true);
    }
    /* 源清单是「模板」页负责拉的 —— 直接打开/刷新本页时它是空的，
     * 早先这里一句"还没有源"就挡住了页面（刷新后无法搜索）。补一次就行（面板转给源插件，很快）。 */
    if (!(S.aggSources || []).length) {
      try {
        await ensureAggSites();
      } catch (e) {
        return toast('拿源清单失败：' + e.message, true);
      }
    }
    if (!(S.aggSources || []).length) return toast('还没有源：先在「插件」里装一个源插件，再在它的设置页里加一个实例', true);
    if (S.aggUseAll) await ensureAggSites();
    const keys = S.aggUseAll ? S.aggSites.filter((s) => s.searchable).map((s) => ({ source: s.source, key: s.key })) : null;
    if (!S.aggUseAll && !tplSites.length) {
      return toast(
        tpl
          ? `「${tpl.name}」这套模板还没勾站点，去「聚合设置 · 模板」勾`
          : '还没有模板：先去「聚合设置 · 模板」建一套',
        true
      );
    }
    if (S.aggUseAll && !keys.length) return toast('拿不到可搜索站点列表，先去「聚合设置 · 模板」刷新站点', true);
    S.aggBusy = true;
    S.aggResult = { loading: true, wd, keyCount: keys ? keys.length : tplSites.length };
    renderPage();
    try {
      const r = await api('/api/agg/search', {
        method: 'POST',
        body: {
          tpl: S.aggTpl,
          wd,
          keys: keys || undefined,
          /* 电影不传季集 —— 客户端对电影也不看这两个（它们只在剧集那条路上参与打分与定位）。 */
          season: isMovie ? undefined : num(seasonInput),
          episode: isMovie ? undefined : num(episodeInput),
          year: num(yearInput),
          /* 分数线 / 最多几条 / 超时 / 并发都**不在这里传**：服务端按这套模板取名下的值
           * （见 server/modules/agg/service.js 的 matchOptions）。`page` 也不传 —— 服务端缺省取上游
           * 第 1 页（与客户端那条路一致）。这一页只决定"搜什么"。 */
        },
      });
      S.aggResult = r;
    } catch (e) {
      S.aggResult = { error: e.message, wd };
    } finally {
      S.aggBusy = false;
      renderPage();
    }
  }

  /**
   * 「这条的版本」：拿 `source+site+vodId` 走**快路径**调 `/api/agg/detail`（跳过搜索），
   * 结果**弹窗**显示 —— 而不是追加到页面最底部（追加在最底部时不易发现）。
   * 看到的形状就是 **Emby 客户端点开这条时拿到的**那份（同一条链）。
   *
   * 取法跟着页面上选的「电影 / 剧集」走（与客户端那条路同一条）：
   *   · 剧集：季/集就取搜索行里填的那两个，按季集定位到这一集；
   *   · 电影：不传季集，用 `pick: 'items'`（每条线路的全部播放项 —— 客户端对电影就是这么列的）。
   * 同时把「线路过滤」（模板的 `lineFilter`，只匹配线路名）的结果也标出来：过滤**只作用在
   * 客户端那侧的版本列表**，弹窗给的是原始线路 —— 所以必须标出来，否则看着像"过滤没生效"。
   */
  async function showItemVersions(m) {
    const useSeason = isMovie ? undefined : num(seasonInput);
    const useEpisode = isMovie ? undefined : num(episodeInput);
    const usePick = isMovie ? 'items' : undefined;
    /* 字幕坐标里的「名字」= 那次搜索编辑框里的文字（同一条搜索链路，客户端那侧由 emby 反查后注入，
     * 见 docs/adr/0073）。这里用上次搜索记下的 `wd`，输入框现读值兜底。 */
    const wd = String((S.aggResult && S.aggResult.wd) || S.aggKeyword || '').trim();
    try {
      /* 过滤规则与详情一起拿（两个请求并发；规则读的是模块端点 —— 权威那份） */
      const [d, st] = await Promise.all([
        api('/api/agg/detail', {
          method: 'POST',
          body: { tpl: S.aggTpl, name: wd || undefined, source: m.source, site: m.siteKey, vodId: m.vod_id, season: useSeason, episode: useEpisode, pick: usePick },
        }),
        api('/api/agg/templates').catch(() => null),
      ]);
      /* 线路过滤跟着模板走（见 docs/adr/0033）：按**这份模板**现读一次，
       * 免得用内存里可能过期的那份 */
      const tnow = ((st && st.templates) || []).find((x) => x.id === S.aggTpl) || null;
      const raw = String(((tnow && tnow.params) || {}).lineFilter || '').trim();
      let re = null;
      try {
        if (raw) re = new RegExp(raw, 'i');
      } catch {
        re = null; // 规则坏了 → 按"不过滤"显示（后端运行时也是这个兜底）
      }
      openVersionsModal(`${m.siteName || m.siteKey} · ${m.vod_name || ''}`, d, {
        pickItems: usePick === 'items',
        filterRaw: raw,
        filterRe: re,
      });
    } catch (e) {
      toast('取版本失败：' + e.message, true);
    }
  }

  /* 搜索行：**模板 + 电影/剧集 + 关键字 +（剧集才有的）季/集 + 年份 + 按钮**全是"这次要搜什么"的参数，
   * 摆在一起。（季集年份曾是按钮下面单独一行；它们与关键字同属搜索参数，放在搜索按钮之前更贴合语义。） */
  /* 模板选择器：**这条搜索用哪套模板** —— 站点与参数（分数线 / 条数 / 超时 / 并发 / 线路过滤）全从它来。
   * 不按"域"选：域 → 模板那份对照是**客户端**那条路要的（Emby 按元数据域前缀问，见 docs/adr/0033），
   * 面板上直接挑模板更直白，也少一步"这属于哪个域"的心算。
   * 放在搜索行最前面：它是这一页的**前提**，比关键字更靠前。 */
  const tplSel = el('select', { title: '这条搜索用哪套模板：站点与参数都来自它' });
  if (!tpls.length) tplSel.append(el('option', { value: '', text: '（还没有模板）' }));
  for (const x of tpls) {
    tplSel.append(el('option', { value: x.id, text: `${x.name}（${(x.sites || []).length} 站）`, selected: x.id === S.aggTpl }));
  }
  tplSel.addEventListener('change', () => {
    S.aggTpl = tplSel.value;
    renderPage();
  });

  /* 每个字段收进一个 `.fld`（见 style.css）：标签在上一行、控件在下一行 —— 同一行里所有字段的
   * 控件都从**同一条左边缘**起排，不会因为标签长短不一而忽左忽右。窄屏换行的最小单位是**整个字段**。
   * 季与集只在「剧集」下出现 —— 选电影时它们既不参与打分也不参与定位，摆着只会让人以为要填。 */
  const searchRow = el(
    'div',
    { class: 'toolbar' },
    el('div', { class: 'fld', title: tplSel.getAttribute('title') }, el('span', { class: 'lbl', text: '模板' }), el('div', { class: 'ctl' }, tplSel)),
    el('div', { class: 'fld', title: kindSel.getAttribute('title') }, el('span', { class: 'lbl', text: '类型' }), el('div', { class: 'ctl' }, kindSel)),
    el('div', { class: 'fld grow' }, el('span', { class: 'lbl', text: '关键字' }), el('div', { class: 'ctl' }, wdInput)),
    isMovie
      ? el('div', { class: 'fld', title: yearInput.getAttribute('title') }, el('span', { class: 'lbl', text: '年份' }), el('div', { class: 'ctl' }, yearInput))
      : el(
          'div',
          { class: 'fld', title: '按季集定位到这一集：季 / 集 / 年份都要对得上才命中' },
          el('span', { class: 'lbl', text: '剧集定位' }),
          el('div', { class: 'ctl' }, seasonInput, episodeInput, yearInput)
        ),
    el('button', { class: 'btn primary go', text: S.aggBusy ? '聚合中…' : '聚合搜索', disabled: S.aggBusy, onclick: run })
  );

  /* 调试开关：低频，另起一行。
   * 分数线 / 最多几条**这一页不再填** —— 它们与站点、超时、并发同属"这一套模板"的调优项，
   * 改一处就行（「聚合设置 · 模板」）；上游第几页也不填 —— 客户端那条路**固定只取上游第 1 页**
   * （见源插件的搜索动作与 `server/modules/emby/service.js` 的注释），
   * 这里翻页只会看到客户端拿不到的结果。 */
  const optRow = el(
    'div',
    { class: 'toolbar' },
    el('label', { class: 'chk', title: '忽略模板里勾的站点，改用全部标了"可搜索"的站点（调试用）' }, useAllCb, '全量站点'),
    el('span', { class: 'spacer' })
  );

  /* 表单与结果各占**一张卡**（与其它页同一个形状）。早先是直接往页面容器上摊元素的：
   * 输入行与结果框都贴着页面底色，跟别处一比像少了一层，看着就"不是一页"。 */
  const formCard = el('div', { class: 'card' }, searchRow, optRow);

  if (!S.aggResult) {
    v.append(el('div', { class: 'grid' }, formCard));
    return;
  }
  if (S.aggResult.loading) {
    v.append(
      el(
        'div',
        { class: 'grid' },
        formCard,
        el('div', { class: 'card' }, el('span', { class: 'muted', text: `正在并发搜索 ${S.aggResult.keyCount || tplSites.length} 个站源…` }))
      )
    );
    return;
  }
  if (S.aggResult.error) {
    v.append(el('div', { class: 'grid' }, formCard, el('div', { class: 'card' }, el('div', { class: 'hint warn', text: '聚合失败：' + S.aggResult.error }))));
    return;
  }

  const r = S.aggResult;
  const stats = r.stats;
  const missed = r.match ? Math.max(0, r.match.scanned - r.match.matched) : 0;
  const missTitle = r.match
    ? `没进的原因：低分 ${r.match.belowLine} · 超上限 ${r.match.overCap} · 名字不过闸 ${r.match.rejected}` +
      `（分数线 ${r.match.minScore || '关'}，上限 ${r.match.maxItems || '不封顶'}；同站同名 ${r.match.sameNameSameSite || 0} 条照收）`
    : '';
  const bar = el(
    'div',
    { class: 'toolbar' },
    el('span', { class: 'badge', text: `${stats.ok}站 / ${stats.totalItems || 0}条` }),
    r.match ? el('span', { class: 'badge ok', text: `命中 ${r.match.matched}`, title: '会被用来取版本的那几条（≤ 最多几条）' }) : null,
    missed ? el('span', { class: 'badge', title: missTitle, text: `没进 ${missed}` }) : null,
    stats.failed ? el('span', { class: 'badge err', text: `${stats.failed}站失败` }) : null,
    el('span', { class: 'badge', text: `${r.elapsedMs} ms` })
  );

  const resultCard = el('div', { class: 'card' });
  v.append(el('div', { class: 'grid' }, formCard, resultCard));
  resultCard.append(bar);
  /* 上次**请求失败**的站这次被**跳过**了（勾选没变、只跳过，见 agg/site-stats.js 的 shouldSkip）——
   * 明说一句：不然"某站没进结果"看着像它坏了或没勾选。 */
  const skipped = (r.sites || []).filter((x) => x && x.skipped);
  if (skipped.length) {
    resultCard.append(
      el('div', {
        class: 'hint warn',
        text:
          `跳过了 ${skipped.length} 个「上次测速失败」的站点（勾选没动）：` +
          skipped.map((x) => `${x.name || x.key}（${x.error}）`).join(' / ') +
          ' —— 点该站的「测速」可立刻重试，或取消模板里的「跳过测速失败的站点」。',
      })
    );
  }
  renderMerged(resultCard, r, showItemVersions);
}

/**
 * 版本弹窗：`detail` 的返回里，每站「线路 N · 定位到这一集 M」+ 逐条线路的定位情况。
 *
 * `opts`：
 *   · `pickItems`  —— 这次用的是**电影取法**（`pick: 'items'`）：每条线路的**每个播放项**各成一个版本。
 *                     客户端对电影走的就是这条，所以弹窗的判定与它一致，不再有"没定位到"这回事。
 *   · `filterRaw` / `filterRe` —— 「线路过滤」规则（只匹配线路名）。**过滤只在客户端那侧生效**
 *                     （`emby/service.js` 拼版本列表时），弹窗给的是原始线路 ⇒ 得逐条标出来。
 *
 * 另：`d.subtitles` 是**这个播放目标**的字幕轨（面板问一次字幕插件得的，`ref` 已在出口剥掉，
 * 见 docs/adr/0073）——挂在整个目标上，不分线路，所以单独一块列在最后；每条轨带 `source`
 * （申报它的字幕插件名，多个字幕插件时可区分来源）。
 *
 * 剧集这条路**一定带季与集**（页面上填不齐就不让搜），所以不再有"没填集号 ⇒ 没做定位"那种分支。
 */
function openVersionsModal(title, d, opts = {}) {
  const sites = d.sites || [];
  const body = [];
  if (!sites.length) {
    body.push(el('div', { class: 'muted', text: '这次没有站点返回（条目取不到 / 站点失败，看面板日志）。' }));
  }
  if (opts.pickItems) {
    body.push(
      el('div', {
        class: 'hint',
        text: '电影取法：每条线路的每个播放项各成一个版本。',
      })
    );
  }
  for (const s of sites) {
    const box = el('div', { class: 'site-group' });
    const entries = [];
    if (s.detail) entries.push({ label: '', det: s.detail });
    for (const v of s.variants || []) if (v && v.detail) entries.push({ label: v.label || '', det: v.detail });
    const allLines = entries.reduce((a, e) => a.concat(e.det.lines || []), []);
    const kept = allLines.filter((l) => !opts.filterRe || opts.filterRe.test(String(l.flag || '')));
    const tgtAll = kept.filter((l) => l.target).length;
    /* 电影取法下"进客户端的版本数" = **各项之和**（线路 × 播放项），不是线路数 */
    const itemAll = kept.reduce((n, l) => n + ((l.items || []).length || 0), 0);

    box.append(
      el(
        'div',
        { class: 'site-head' },
        el('span', { class: 'dot ' + (s.detail ? 'running' : 'error') }),
        el('span', { class: 'chip tag', text: (s.sourceName ? s.sourceName + ' · ' : '') + (s.name || s.key) }),
        s.detail
          ? opts.pickItems
            ? el('span', { class: 'badge' + (itemAll ? ' ok' : ''), text: `进客户端版本列表 ${itemAll} 个版本` })
            : el('span', { class: 'badge' + (tgtAll ? ' ok' : ''), text: `进客户端版本列表 ${tgtAll} 条线路` })
          : el('span', { class: 'badge err', text: s.error || '这条没取到详情' })
      )
    );
    for (const e of entries) {
      if (e.label) box.append(el('div', { class: 'note', text: `变体 · ${e.label}` }));
      const lines = e.det.lines || [];
      if (!lines.length) {
        if (!e.label) box.append(el('div', { class: 'muted', text: '这条没有线路（`lines: []`）。' }));
        continue;
      }
      for (const l of lines) {
        const dropped = !!opts.filterRe && !opts.filterRe.test(String(l.flag || ''));
        const items = l.items || [];
        /* 两种取法的"进不进列表"判据不同：电影看**播放项**，剧集看**定位到的那一项** */
        const inList = !dropped && (opts.pickItems ? items.length > 0 : !!l.target);
        const count = opts.pickItems ? items.length : (l.episodes || []).length;
        const unit = opts.pickItems ? '项' : '集';
        let why;
        if (opts.pickItems) {
          why = items.length
            ? `✔ 有 ${items.length} 个播放项 → 列 ${items.length} 个版本`
            : '✘ 没有播放项，不进版本列表';
          if (items.length && dropped) why += ` —— 但线路名不匹配 /${opts.filterRaw}/，不进版本列表`;
        } else if (l.target) {
          why = `✔ 定位到：${l.target.name}（${l.target.matchedBy || ''}）` +
            (dropped ? ` —— 但线路名不匹配 /${opts.filterRaw}/，不进版本列表` : '');
        } else if (dropped) {
          why = `✘ 线路名不匹配 /${opts.filterRaw}/，不进版本列表`;
        } else {
          why = '✘ 这一集在这条线路里没定位到，不进版本列表';
        }
        box.append(
          el(
            'div',
            { class: 'agg-item' + (inList ? ' matched' : '') },
            el(
              'div',
              { class: 'agg-body' },
              el('div', { class: 'agg-name' }, l.flag || '-', el('span', { class: 'badge ml-sm', text: `${count} ${unit}` })),
              el('div', { class: 'note', text: why })
            )
          )
        );
      }
    }
    body.push(box);
  }
  /* 字幕轨：整个播放目标共用一份（不分线路），所以单独一块列在最后。无轨时给一行 muted 说明，
   * 免得看着像"漏显示"。 */
  const subs = Array.isArray(d.subtitles) ? d.subtitles : [];
  const subBox = el('div', { class: 'site-group' });
  subBox.append(
    el(
      'div',
      { class: 'site-head' },
      el('span', { class: 'chip tag', text: '字幕' }),
      subs.length
        ? el('span', { class: 'badge ok', text: `${subs.length} 条轨` })
        : el('span', { class: 'badge', text: '无' })
    )
  );
  if (subs.length) {
    for (const s of subs) {
      subBox.append(
        el(
          'div',
          { class: 'agg-item' },
          el(
            'div',
            { class: 'agg-body' },
            el(
              'div',
              { class: 'agg-name' },
              s.label || s.lang || '-',
              el('span', { class: 'badge ml-sm', text: s.lang || '' }),
              el('span', { class: 'badge ml-sm', text: s.format }),
              s.source ? el('span', { class: 'badge ml-sm', text: s.source }) : null
            )
          )
        )
      );
    }
  } else {
    subBox.append(el('div', { class: 'muted', text: '这次没有字幕轨（没配字幕插件 / 插件没返回，看面板日志）。' }));
  }
  body.push(subBox);
  modal({ title: '版本 · ' + title, body, actions: [{ label: '关闭', primary: true }] });
}

function aggNorm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·・.,，。:：;；!！?？'"“”‘’()（）\[\]【】《》\-_—~～、/\\|+*&#@%$^]/g, '');
}

/** 跨站点统计同名条目数量（仅用于提示，不做合并） */
function aggDupMap(r) {
  const m = new Map();
  for (const entry of r.sites || []) {
    for (const it of (entry.data && entry.data.list) || []) {
      const n = aggNorm(it.vod_name);
      m.set(n, (m.get(n) || 0) + 1);
    }
  }
  return m;
}

function renderMerged(host, r, onVersions) {
  const sites = r.sites || [];
  if (!sites.length) {
    host.append(el('div', { class: 'muted', text: '没有任何站点返回结果。' }));
    return;
  }
  const dupMap = aggDupMap(r);

  for (const s of sites) {
    const raw = (s.data && s.data.list) || [];
    /* **命中的排前面**（同分保持源里的顺序）—— 一个站挂上百条同名时，
     * 先看到"会被用到的那几条"比看源顺序有用得多（否则长列表显得杂乱）。 */
    const list = raw
      .map((it, i) => ({ it, i }))
      .sort((a, b) => (b.it.matched ? 1 : 0) - (a.it.matched ? 1 : 0) || (b.it.score || 0) - (a.it.score || 0) || a.i - b.i)
      .map((x) => x.it);
    const hitN = raw.filter((x) => x.matched).length;
    const box = el('div', { class: 'site-group' });
    box.append(
      el(
        'div',
        { class: 'site-head' },
        el('span', { class: 'dot ' + (s.ok ? 'running' : 'error') }),
        el('span', { class: 'chip tag', text: (s.sourceName ? s.sourceName + ' · ' : '') + (s.name || s.key) }),
        el('span', { class: 'badge' + (s.ok ? ' ok' : ' err'), text: s.ok ? `${list.length} 条${hitN ? ` · 命中 ${hitN}` : ''} · ${s.ms}ms` : s.error || '失败' }),
        s.http ? el('span', { class: 'badge', text: 'HTTP ' + s.http }) : null
      )
    );

    if (!list.length) {
      box.append(el('div', { class: 'note', text: s.ok ? '无结果' : '请求失败' }));
      host.append(box);
      continue;
    }

    const ul = el('div', { class: 'agg-list' });
    const shown = S.aggFold && S.aggFold[sid(s.source, s.key)] ? list.length : Math.min(list.length, FOLD_AT);
    for (const m of list.slice(0, shown)) {
      const dupN = dupMap.get(aggNorm(m.vod_name)) || 1;
      ul.append(
        el(
          'div',
          { class: 'agg-item' + (m.matched ? ' matched' : '') },
          /* 没图的时候**也要占位**：列表是一行一行齐的，缺一块图会让这一行的名字、
           * 备注整体左移、上下错位。所以拿不到图（没有地址，或者地址加载失败）都换成
           * 同一块灰底占位，宽度与真图完全一致。 */
          m.vod_pic
            ? el('img', {
                class: 'agg-pic',
                src: m.vod_pic,
                loading: 'lazy',
                referrerpolicy: 'no-referrer',
                onerror: (e) => e.target.replaceWith(el('div', { class: 'agg-pic ph' })),
              })
            : el('div', { class: 'agg-pic ph' }),
          el(
            'div',
            { class: 'agg-body' },
            el(
              'div',
              { class: 'agg-name' },
              m.vod_name || '-',
              dupN > 1 ? el('span', { class: 'badge ml-sm', text: `同名 ×${dupN}` }) : null,
              m.score !== undefined
                ? el('span', { class: 'badge ml-sm' + (m.matched ? ' ok' : ''), text: (m.matched ? '命中 ' : '没进 ') + Number(m.score).toFixed(2), title: m.matchReason || '' })
                : null
            ),
            m.vod_remarks ? el('div', { class: 'note', text: m.vod_remarks }) : null,
            /* 没进的写明原因（**合并视图里就能看到，所以不单列一张"匹配失败"卡片**，避免重复） */
            m.score !== undefined && !m.matched ? el('div', { class: 'note', text: '没进原因：' + (m.matchReason || '') }) : null,
            el(
              'div',
              { class: 'agg-sources' },
              el('button', { class: 'chip', text: '原始条目', onclick: (e) => toggleRaw(e.target, m) }),
              m.source && m.vod_id
                ? el('button', { class: 'chip', text: '这条的版本', onclick: () => onVersions(m) })
                : null
            )
          )
        )
      );
    }
    if (list.length > shown) {
      ul.append(
        el('button', {
          class: 'chip',
          text: `展开其余 ${list.length - shown} 条（大多是没进的同名片源）`,
          onclick: () => {
            S.aggFold = Object.assign({}, S.aggFold, { [sid(s.source, s.key)]: true });
            renderPage();
          },
        })
      );
    }
    box.append(ul);
    host.append(box);
  }
}

/** 折叠用的复合键（与后端一致的 `source + \\u0001 + key`） */
function sid(source, key) {
  return `${source}\u0001${key}`;
}

/** 折叠显示「原响应里的这一条」（原封不动） */
function toggleRaw(btn, obj) {
  const parent = btn.closest('.agg-item');
  const old = parent.querySelector('.raw-json');
  if (old) {
    old.remove();
    btn.classList.remove('active');
    return;
  }
  btn.classList.add('active');
  parent.querySelector('.agg-body').append(el('pre', { class: 'json raw-json', text: JSON.stringify(obj, null, 2) }));
}
