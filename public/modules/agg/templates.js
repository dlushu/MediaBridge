'use strict';
/**
 * 聚合模块 · 「模板」页 —— **只管模板的增 / 删 / 改**。
 *
 * 一份模板 = 名字 + 选中的站点 + 打分过滤参数 + 超时与并发（见 docs/adr/0033）。
 * 左边挑一套（或新建 / 删除），右边编辑这一套，改完按**一个**「保存」整份写回
 * （`POST /api/agg/templates`）。「哪个域用哪套模板」不在这里 —— 见「聚合设置 → 域 → 模板」。
 * 「保存」跟在左边那张卡的「新建 / 删除」后面 —— 三者都是"对模板集本身"的动作，归一处；
 * 草稿动过时按钮下面亮一个「未保存」，换模板前先拦一句。
 * 页面里的问一句（新建 / 删除 / 切模板 / 全不选 / 测速）一律走 `modal()` —— 原生 `confirm`
 * 在窄屏上被浏览器画成一条窄横条，字挤成一团、按钮还点不准。
 *
 * ⚠️ 勾选、改名、参数都只活在**这一个模块的草稿**（`draft`）里：不写全局状态、不落服务端，
 * 点「保存」才整份提交；换模板或保存成功时草稿作废，按服务端那一份重画。
 *
 * 站点表按**来源**（`s.source` = 插件 id / 实例 id）分组：多实例下站点 key 只在各自实例内唯一，
 * 上百条堆成一张扁平表既对不上号，也看不出哪个实例勾了多少。来源做成**横向页签**、一次只开一个 ——
 * 两三个来源的表上下堆着，页面会被拉得很长。组头带「整组全选 / 整组反选」。
 *
 * ⚠️ **测速的开关与间隔不在这里**（已搬到「面板设置」）—— 测速是"这台机器与这条网络"的体检，
 * 与内容偏好无关，而测速的**结果**是面板级共享的一份、不跟模板走。本站点表里的「延迟」列
 * 与「立即测速」按钮仍在（那是"看结果"和"手点一轮"）。
 */
import { $, el, modal, toast } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { sid, ensureAggSites, ensureTemplates } from '../../core/store.js';
import { renderPage } from '../../core/shell.js';

/* ------------------------------------------------------------------ 草稿 */

/**
 * 一个参数字段：**标签在上、控件在下**，可带单位（原来是 `[6] 单站超时` 这种"控件在前"、
 * 以及"标签在左、控件紧跟"的写法 —— 标签长短不一就把输入框推得忽左忽右，整块看着就是乱的）。
 * 标签独占一行之后，同一组里所有字段的控件都从**同一条左边缘**起排。
 */
const pfld = (label, input, unit, title) =>
  el(
    'div',
    { class: 'fld', title: title || null },
    el('span', { class: 'lbl', text: label }),
    el('div', { class: 'ctl' }, input, unit ? el('span', { class: 'unit', text: unit }) : null)
  );

/** 正在编辑的那一份：`{id, name, sites:[{source,key}], params}`。null = 还没建草稿 */
let draft = null;
/** 草稿动过没有 —— 换模板前拿它拦一下，免得勾了半天被切走 */
let dirty = false;

/** 站点页签里"全部来源平铺成一张表"那一档（不是某个源的 id，只是个哨兵值）。 */
const ALL_SITES = '__all__';

/**
 * 分段控件：一排短选项，当前那档高亮。凡是"只是换个看法"的开关（看哪一页签、按什么排）
 * 都用它，而不是 `.btn` —— 按钮那身样式是在说"点一下会做事"，跟刷新 / 测速挤在一排时
 * 分不出主次；三态循环的按钮更看不出此刻停在哪一档。颜色在这里只表示"当前是这档"，不表示动作。
 */
function segControl(items, current, onPick) {
  const box = el('div', { class: 'seg' });
  for (const [val, label, title] of items) {
    const b = el('button', { type: 'button', class: 'seg-item' + (val === current ? ' active' : ''), text: label, title: title || null });
    b.addEventListener('click', () => {
      if (b.classList.contains('active')) return;
      box.querySelectorAll('.seg-item').forEach((x) => x.classList.toggle('active', x === b));
      onPick(val);
    });
    box.append(b);
  }
  return box;
}

/** 从服务端那一份抄出草稿（站点数组要深拷，免得改草稿顺手改了全局状态里那份） */
function draftOf(t) {
  return {
    id: t.id,
    name: t.name || '',
    sites: (t.sites || []).map((x) => ({ source: x.source, key: x.key })),
    params: Object.assign({}, t.params || {}),
  };
}

function curTpl() {
  const list = S.aggTemplates || [];
  return list.find((t) => t.id === S.tplId) || list[0] || null;
}

/** 切模板 / 存成功之后：草稿作废，下次渲染按服务端那一份重建 */
function resetDraft() {
  draft = null;
  dirty = false;
}

/** 草稿动过没有：改草稿的地方都走它，顶部操作条上那颗「未保存」跟着亮 */
function setDirty(on) {
  dirty = on;
  const chip = $('#tplDirty');
  if (chip) chip.classList.toggle('hidden', !dirty);
}

/** 页内确认框（替代原生 `confirm`）：resolve(true) = 用户点了确认那颗按钮。
 *  ✕ / Esc / 点遮罩关掉一律算"取消" —— 靠 modal 的 onClose 兜住。 */
function confirmModal({ title, text, okLabel = '确定', primary = true }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    modal({
      title,
      body: [el('p', { class: 'note', text })],
      actions: [
        { label: '取消', onclick: () => finish(false) },
        { label: okLabel, primary, onclick: () => finish(true) },
      ],
      onClose: () => finish(false),
    });
  });
}

/* ------------------------------------------------------------------ 页面 */

export async function renderTemplates(v) {
  await loadTemplates();

  if (!(S.aggTemplates || []).length) {
    v.append(emptyCard());
    return;
  }

  const t = curTpl();
  if (!draft || draft.id !== t.id) {
    draft = draftOf(t);
    dirty = false;
  }

  const ed = editor(t);
  v.append(el('div', { class: 'tpl-layout' }, tplList(t, ed.save), ed.node));

  /* 站点清单归源插件：它要挨个问自己那些实例的 `/config`（连不上的要等超时），先画别的卡片。 */
  paintSites();
  if (S.aggLoadedFor !== null) return;
  try {
    await ensureAggSites();
  } catch (e) {
    toast('读取站点失败：' + e.message, true);
    return;
  }
  paintSites();
}

/** 拉模板清单 / 域对照 / 已注册的域（走 store 那一份，页面与搜索页共用同一处）。
 *  失败不该让整页空白 —— 拿不到就按内存里那份画。 */
async function loadTemplates(force = false) {
  try {
    await ensureTemplates({ force });
  } catch (e) {
    S.aggTemplates = S.aggTemplates || [];
    toast('读取模板失败：' + e.message, true);
  }
  if (S.tplId && !(S.aggTemplates || []).some((t) => t.id === S.tplId)) S.tplId = '';
}

function emptyCard() {
  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '模板' }),
    el('p', {
      class: 'note',
      text: '一套模板 = 选中的站点 + 打分过滤参数 + 超时与并发。每个元数据域指定一套；没配的域搜不到内容。',
    }),
    el('div', { class: 'row' }, el('button', { class: 'btn primary', text: '新建一套模板', onclick: () => createTemplate() }))
  );
}

/* ------------------------------------------------------------------ ① 左边：挑一套 / 新建 / 删除 */

function tplList(t, save) {
  const list = el('div', { class: 'tpl-list' });
  for (const x of S.aggTemplates || []) {
    list.append(
      el(
        'button',
        { class: 'tpl-item' + (x.id === t.id ? ' active' : ''), title: x.name, onclick: () => selectTemplate(x.id) },
        el('span', { class: 'tpl-name', text: x.name }),
        el('span', { class: 'tpl-meta', text: `${(x.sites || []).length} 站` })
      )
    );
  }
  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '模板' }),
    list,
    /* 「保存」跟新建 / 删除挤在一行里（三者都是"对模板集本身"的动作，归一处看着顺） */
    el(
      'div',
      { class: 'row' },
      el('button', { class: 'btn', text: '新建', onclick: () => createTemplate() }),
      el('button', { class: 'btn', text: '删除', onclick: () => removeTemplate(t) }),
      save
    ),
    el('span', { class: 'dirty-chip' + (dirty ? '' : ' hidden'), id: 'tplDirty', text: '未保存' })
  );
}

/** 换一套编辑：草稿动过就先问一句（勾了半天被一句话切走最亏） */
async function selectTemplate(id) {
  if (draft && draft.id === id) return;
  if (dirty) {
    const go = await confirmModal({
      title: '切换模板',
      text: '这一套还没保存，切过去就不保留了。继续？',
      okLabel: '切过去',
    });
    if (!go) return;
  }
  S.tplId = id;
  resetDraft();
  renderPage();
}

function createTemplate() {
  const name = el('input', { type: 'text', value: '新模板', maxlength: '40', placeholder: '这套模板叫什么' });
  modal({
    title: '新建模板',
    body: [
      el('div', { class: 'field' }, el('label', { text: '名字（例如「影视」「动漫」）' }), name),
      el('p', { class: 'note', text: '先建一套空的，再在站点表里挑站点，最后点「保存这套模板」。' }),
    ],
    actions: [
      { label: '取消' },
      {
        label: '新建',
        primary: true,
        onclick: async () => {
          const nm = name.value.trim();
          if (!nm) {
            toast('名字不能空', true);
            return false;
          }
          try {
            const r = await api('/api/agg/templates', { method: 'POST', body: { template: { name: nm, sites: [] } } });
            S.tplId = r.template.id;
            resetDraft();
            await loadTemplates(true);
            toast('已新建模板：' + r.template.name);
            renderPage();
          } catch (e) {
            toast('新建失败：' + e.message, true);
            return false;
          }
        },
      },
    ],
  });
}

async function removeTemplate(t) {
  const used = Object.entries(S.aggDomains || {}).filter(([, id]) => id === t.id).map(([d]) => d);
  const tip =
    `删除模板「${t.name}」？` +
    (used.length ? `还被这些域用着：${used.join(' / ')}，删掉后它们搜不到内容。` : '');
  const go = await confirmModal({ title: '删除模板', text: tip, okLabel: '删除', primary: false });
  if (!go) return;
  try {
    const r = await api('/api/agg/templates/' + encodeURIComponent(t.id), { method: 'DELETE' });
    S.aggDomains = r.domains || {};
    S.tplId = '';
    resetDraft();
    await loadTemplates(true);
    toast('已删除');
    renderPage();
  } catch (e) {
    toast('删除失败：' + e.message, true);
  }
}

/* ------------------------------------------------------------------ ② 右边：编辑这一套 */

/** 名称 / 参数 / 站点在**同一份草稿**里，改完按一个「保存」整份写回。
 *  返回 `{ save, node }`：`save` 那颗按钮归左边那张卡（跟新建 / 删除排一起），`node` 是编辑器本体。 */
function editor(t) {
  const mark = () => setDirty(true);

  const name = el('input', { type: 'text', value: draft.name, maxlength: '40', placeholder: '这套模板叫什么' });
  name.addEventListener('input', mark);

  /* 参数是"偶尔调一次"的旋钮，但**不折叠** —— 它和名称、站点同属"这一套模板"，一屏看完比点开找强。
   * 输入框**一律不给定宽档**（早先按内容给了 w-sm / w-md / w-lg）：同一排里框长各不相同、
   * 窄屏换行后更参差；交给 `.ctl` 的弹性分配，每个框就自然铺满自己那一格。 */
  const p = draft.params || {};
  const num = (v, d) => (v === undefined || v === null || v === '' ? d : v);
  const to = el('input', { type: 'number', value: String(num(p.timeoutSec, 5)), min: '1', max: '60' });
  const dto = el('input', { type: 'number', value: String(num(p.detailTimeoutSec, 10)), min: '1', max: '120' });
  const pto = el('input', { type: 'number', value: String(num(p.playTimeoutSec, 25)), min: '1', max: '120' });
  const cc = el('input', { type: 'number', value: String(num(p.concurrency, 8)), min: '1', max: '32' });
  const minScore = el('input', { type: 'number', value: String(num(p.matchMinScore, 0.85)), min: '0', max: '1', step: '0.05' });
  const maxItems = el('input', { type: 'number', value: String(num(p.matchMaxItems, 8)), min: '1', max: '20' });
  const extraK = el('input', { type: 'number', value: String(num(p.matchExtraK, 8)), min: '0', max: '10' });
  const extraAllCb = el('input', { type: 'checkbox', checked: p.matchExtraAll === true });
  const lineFilter = el('input', {
    type: 'text',
    value: String(num(p.lineFilter, '')),
    /* 只留一个例子：原来那句"正则，匹配线路名；留空 = 不过滤"在窄屏上被截成半截，
     * 而标签写的已经是"线路名正则" —— 说明那句留在字段的 title 上（悬停即见）。 */
    placeholder: '例：夸克原画|百度原画',
    spellcheck: 'false',
  });
  for (const x of [to, dto, pto, cc, minScore, maxItems, extraK, lineFilter]) x.addEventListener('input', mark);
  /* 站点取数：最近一次测速失败的站要不要先跳过（口径见 server/modules/agg/templates.js 的 skipFailedSites）。
   * 默认勾着 —— 与原来一直就有的行为一致；取消勾选就照打，用来确认那几个站现在到底行不行。 */
  const skipFailedCb = el('input', { type: 'checkbox', checked: p.skipFailedSites !== false });
  skipFailedCb.addEventListener('change', mark);
  const extraKLabel = pfld(
    '续接补位',
    extraK,
    null,
    '前 N 条一条能用的都没拿到时，按分数继续往下打（续接补位），最多再试这么多条；第一批拿到能用的就不再往下打。填 0 = 不补打'
  );
  /* 勾上「匹配到底」= 不按上面那个数补位，一直往下打到有能用的。
   * ⚠️ 此时只把输入框**灰掉**，字段连标签一起留在原位 —— 整块 hidden 掉的话，勾选框旁边什么都不剩，
   * 就看不出这个勾到底在覆盖哪一项了。 */
  const syncExtra = () => {
    extraK.disabled = extraAllCb.checked;
  };
  extraAllCb.addEventListener('change', () => {
    mark();
    syncExtra();
  });
  syncExtra();

  const save = el('button', { class: 'btn primary', text: '保存这套模板' });
  save.addEventListener('click', async () => {
    const nm = name.value.trim();
    if (!nm) return toast('名字不能空', true);
    const params = {
      timeoutSec: Number(to.value),
      detailTimeoutSec: Number(dto.value),
      playTimeoutSec: Number(pto.value),
      concurrency: Number(cc.value),
      matchMinScore: Number(minScore.value),
      matchMaxItems: Number(maxItems.value),
      matchExtraK: Number(extraK.value),
      matchExtraAll: extraAllCb.checked,
      lineFilter: lineFilter.value.trim(),
      skipFailedSites: skipFailedCb.checked,
    };
    const bad = paramsError(params);
    if (bad) return toast(bad, true);
    save.disabled = true;
    try {
      const r = await api('/api/agg/templates', {
        method: 'POST',
        body: { template: { id: t.id, name: nm, sites: draft.sites, params } },
      });
      const i = (S.aggTemplates || []).findIndex((x) => x.id === r.template.id);
      if (i >= 0) S.aggTemplates[i] = r.template;
      resetDraft();
      toast(`已保存「${r.template.name}」：名称 / 参数 / 站点一起写回`);
      renderPage();
    } catch (e) {
      toast('保存失败：' + e.message, true);
      save.disabled = false;
    }
  });

  /* 参数是"偶尔调一次"的旋钮，但**不折叠** —— 它和名称、站点同属"这一套模板"，一屏看完比点开找强。
   * 分四小块排：八颗控件原来挤在同一行里，宽屏还能看，窄屏一折行就成了一大片没有归属感的数字。 */
  const group = (title, ...items) =>
    el('div', { class: 'param-block' }, el('div', { class: 'param-title', text: title }), el('div', { class: 'row' }, items));

  /* 参数与站点分**两页签**：两类东西的用法完全不同 —— 参数是"偶尔调一次的旋钮"，
   * 站点是"上百行的一张表"。堆在一页上时，站点表总把参数挤到上面很远处、两边都得滚。
   * 页签状态放在 S.tplTab：切开时整页重画（草稿还在模块作用域里，勾过的不会丢）。
   * 默认落在「选站点」：站点是这套模板的主体（上百行的那张表），进页面先看到它；
   * 参数是偶尔调一次的旋钮，要看再切过去。 */
  const tab = S.tplTab === 'params' ? 'params' : 'sites';
  const paramsCard = el(
    'div',
    { class: 'card' },
    el('div', { class: 'row' }, el('div', { class: 'fld grow' }, el('span', { class: 'lbl', text: '名称' }), el('div', { class: 'ctl' }, name))),
    /* 单位写进标签（`单站超时（秒）`）而不是跟一个 `秒` 字在框后面：
     * 框后那个单位会占掉一段宽度，同一排里带单位的框就比不带单位的窄一截。 */
    group(
      '超时与并发',
      pfld('单站超时（秒）', to, null, '搜索（以及首次 /init）的单站超时。慢站设太小会被一律判成超时'),
      pfld('取详情超时（秒）', dto, null, '取详情（POST /detail）的单站超时。比搜索更宽 —— 剧集动辄几十上百集，响应体大、上游拼装慢'),
      pfld(
        '播放超时（秒）',
        pto,
        null,
        '取播放地址（POST /play）的单站超时。要比搜索宽得多 —— 网盘类线路（PikPak 那种）' +
          '取一个地址要串行打登录、查已保存、提交离线下载、等完成、取直链好几发，' +
          '跟搜索共用一档会被一律判成超时（客户端拿到 502 就重试，越重试越慢）'
      ),
      pfld('并发数', cc)
    ),
    group(
      '打分与取条数',
      pfld('分数线', minScore, null, '打分 ≥ 它的才算命中。填 0 = 不过滤分数线（只按分数排名取前 N 条）'),
      pfld('最多留几条命中', maxItems, null, '阶段一要取几条（有线路、且定位到你要的那一集）。每多取一条就多打一次站源 /detail'),
      extraKLabel,
      el('label', { class: 'chk', title: '不看"续接补位"，一直往下打到拿到一条能用的或名单打完（每个候选都要打一次站源 /detail，可能慢）' }, extraAllCb, '匹配到底')
    ),
    group(
      '线路过滤',
      el(
        'div',
        { class: 'fld grow', title: '只匹配线路名（不看站名）。留空 = 不过滤' },
        el('span', { class: 'lbl', text: '线路名正则' }),
        el('div', { class: 'ctl' }, lineFilter)
      )
    ),
    group(
      '站点取数',
      el(
        'label',
        {
          class: 'chk',
          title:
            '勾上：最近一次测速失败的站点在聚合搜索时先跳过（模板里的勾选不动，下一轮测速成功就自动恢复）。' +
            '取消勾选：照打 —— 用来确认"那几个站现在到底行不行"',
        },
        skipFailedCb,
        '跳过测速失败的站点'
      )
    ),
    el('div', {
      class: 'note',
      text:
        '打分口径：名字 0.7 · 季集 0.2 · 年份 0.1（缺项不计），名字像不上的直接出局。' +
        '「能用的」= 有线路、且定位到这一集。打分与过滤只在两层式站点生效。',
    })
  );

  const tabSeg = segControl(
    [
      ['sites', '选站点'],
      ['params', '填参数'],
    ],
    tab,
    (v) => {
      S.tplTab = v;
      renderPage();
    }
  );

  return {
    save,
    node: el(
      'div',
      { class: 'grid' },
      /* 标题与页签同一行：左边"正在编哪一套"，右边"看它的哪一半" */
      el('div', { class: 'tpl-head' }, el('h3', { text: `编辑「${t.name}」` }), el('span', { class: 'spacer' }), tabSeg),
      tab === 'sites' ? sitesCard() : paramsCard
    ),
  };
}

/** 参数范围校验：返回错误文案；没问题回空串 */
function paramsError(p) {
  if (!(p.timeoutSec >= 1 && p.timeoutSec <= 60)) return '单站超时填 1~60 秒';
  if (!(p.detailTimeoutSec >= 1 && p.detailTimeoutSec <= 120)) return '取详情超时填 1~120 秒';
  if (!(p.playTimeoutSec >= 1 && p.playTimeoutSec <= 120)) return '播放超时填 1~120 秒';
  if (!(p.concurrency >= 1 && p.concurrency <= 32)) return '并发数填 1~32';
  if (!(p.matchMinScore >= 0 && p.matchMinScore <= 1)) return '分数线填 0~1（0 = 不过滤分数线）';
  if (!(p.matchMaxItems >= 1 && p.matchMaxItems <= 20)) return '最多留几条填 1~20';
  if (!(p.matchExtraK >= 0 && p.matchExtraK <= 10)) return '「续接补位」填 0~10（0 = 不补打）';
  return '';
}

/* ------------------------------------------------------------------ ③ 站点：按来源分组 */

function sitesCard() {
  const refresh = el('button', { class: 'btn', text: '刷新站点', onclick: () => { S.aggLoadedFor = null; renderPage(); } });
  const filter = el('input', { type: 'text', placeholder: '站点名', value: S.siteFilter });
  filter.addEventListener('input', () => { S.siteFilter = filter.value; paintSites(); });
  const viewSel = el('select', { title: '按"你自己的勾选"筛，不看源申报的能力' });
  for (const [val, label] of [['all', '全部站点'], ['on', '只看已勾选'], ['off', '只看未勾选']]) {
    const o = el('option', { value: val, text: label });
    if ((S.siteView || 'all') === val) o.selected = true;
    viewSel.append(o);
  }
  viewSel.addEventListener('change', () => { S.siteView = viewSel.value; paintSites(); });
  const testBtn = el('button', {
    class: 'btn',
    id: 'siteTestBtn',
    title: '对当前列出来的站点跑一轮测速（服务端执行：每站一发 /search，片名随机取、非 200 换一个再测一发）',
    text: '立即测速',
    onclick: () => startSpeedTest(),
  });
  /* 排序是**分段控件**而不是按钮：它只有三档、且"现在停在哪一档"必须一眼可见。
   * 原来是同一颗按钮点一下循环三态 —— 既看不出当前档位，那身按钮样式又让它跟「刷新站点 / 立即测速」
   * 混成一排"点一下会做事"的动作（给按钮换颜色只会让它更像主操作，方向是反的）。 */
  const sortSeg = segControl(
    [
      ['', '原序', '按源清单里的顺序'],
      ['fast', '快→慢', '延迟从快到慢；失败与没测过的排最后'],
      ['slow', '慢→快', '延迟从慢到快；失败与没测过的排最后'],
    ],
    S.siteSort || '',
    (v) => {
      S.siteSort = v;
      paintSites();
    }
  );

  /* 上半块是**筛选区**（框出来的一小块）：按名字筛、看哪种、怎么排 —— 只影响这张表怎么显示；
   * 下半行是动作按钮（刷新 / 测速 / 全不选）。两类东西原来混在同一条 toolbar 里，
   * 窄屏一折行就分不清哪个是筛选项、哪个是"点一下会做事"的按钮。 */
  return el(
    'div',
    { class: 'card' },
    el(
      'div',
      { class: 'filter-bar' },
      el(
        'div',
        { class: 'row' },
        el('div', { class: 'fld grow' }, el('span', { class: 'lbl', text: '按站点名筛' }), el('div', { class: 'ctl' }, filter)),
        el('div', { class: 'fld' }, el('span', { class: 'lbl', text: '显示' }), el('div', { class: 'ctl' }, viewSel)),
        el('div', { class: 'fld' }, el('span', { class: 'lbl', text: '按延迟排序' }), el('div', { class: 'ctl' }, sortSeg))
      ),
      el('div', { class: 'status-line' }, el('span', { id: 'aggCount' }), el('span', { id: 'siteTestMsg' }))
    ),
    el(
      'div',
      { class: 'row btn-fan' },
      refresh,
      testBtn,
      el('button', { class: 'btn mini hidden', id: 'siteTestStop', text: '停止测速', onclick: () => stopSpeedTest() }),
      el('button', { class: 'btn', text: '全部不选', onclick: () => clearAll() })
    ),
    el('div', { id: 'siteTableHost' })
  );
}

/** 重画站点表（勾一下就地重画，不必整页重刷）。勾选来自草稿，草稿来自服务端那一份。 */
function paintSites() {
  const host = $('#siteTableHost');
  if (!host || !draft) return;
  host.textContent = '';

  if (S.aggLoadedFor === null) {
    host.append(el('div', { class: 'hint', text: '正在加载…' }));
    return;
  }
  if (!(S.aggSources || []).length) {
    host.append(el('div', { class: 'hint warn' }, '还没有源 —— 先在「插件 → 插件库」装一个源插件，再到它的设置页加一个实例。'));
    return;
  }
  if (!(S.aggSites || []).length) {
    const bad = (S.aggSources || []).filter((s) => s.enabled !== false && !s.ok);
    host.append(el('div', { class: 'hint warn', text: '这些源都取不到站点：' + (bad.map((s) => `${s.id} ${s.error || '未知错误'}`).join('；') || '未知原因') }));
    return;
  }

  const chosenSet = new Set(draft.sites.map((x) => sid(x.source, x.key)));
  const list = sortSites((S.aggSites || []).filter((s) => siteVisible(s, chosenSet)));
  const srcN = new Set((S.aggSites || []).map((s) => s.source)).size;
  const cnt = $('#aggCount');
  if (cnt) cnt.textContent = `这套勾了 ${chosenSet.size} / ${(S.aggSites || []).length} 站点 · ${srcN} 个源`;

  if (!list.length) {
    host.append(el('div', { class: 'hint', text: '当前筛选下没有站点。' }));
    return;
  }

  /* 归组：按源清单里的出现顺序（Map 保序） */
  const groups = new Map();
  for (const s of list) {
    if (!groups.has(s.source)) groups.set(s.source, []);
    groups.get(s.source).push(s);
  }
  /* 来源做成**横向页签**、一次只开一个：两三个来源、上百条站点上下堆成好几张长表，
   * 页面会被拉得很长，而一组一组的表本来也是分开勾的。
   * 多来源时最前面多一档**「全部站点」**：把各源的站点平铺成一张表，供跨源挑。
   * 默认就落在这一档（进页面先看到全貌，不必先猜"要在哪个源里找"）。 */
  S.siteGroup = pickGroup(groups);
  if (groups.size > 1) host.append(srcTabs(groups, chosenSet));
  if (S.siteGroup === ALL_SITES) {
    host.append(srcGroup(ALL_SITES, list, chosenSet, `全部站点（${groups.size} 个源，共 ${list.length} 个）`));
  } else {
    host.append(srcGroup(S.siteGroup, groups.get(S.siteGroup), chosenSet));
  }

  host.append(
    el('div', {
      class: 'note',
      text: '「层次」按插件申报：搜索结果直接带线路 = 一层式。',
    })
  );
  void initSpeedTestUi();
}

/** 页签默认落在**「全部站点」**上（进页面先看到全貌）；点过某个来源之后在本次会话里记住它。
 *  只有一个来源时没有"全部"可言（那一档跟唯一的源是同一批站点），直接落在它上面。 */
function pickGroup(groups) {
  if (groups.size < 2) return [...groups.keys()][0];
  if (S.siteGroup === ALL_SITES || groups.has(S.siteGroup)) return S.siteGroup;
  return ALL_SITES;
}

/** 来源页签：一档「全部站点」+ 一个来源一颗，页签上带"这一组勾了几个 / 当前列出来几个" */
function srcTabs(groups, chosenSet) {
  const bar = el('div', { class: 'src-tabs' });
  const all = [...groups.values()].flat();
  const onAll = all.filter((s) => chosenSet.has(sid(s.source, s.key))).length;
  const allTab = el('button', {
    class: 'src-tab' + (S.siteGroup === ALL_SITES ? ' active' : ''),
    title: `各来源的站点平铺成一张表，方便跨源挑：${onAll}/${all.length} 已勾选`,
    onclick: () => {
      S.siteGroup = ALL_SITES;
      paintSites();
    },
  });
  allTab.append(el('span', { text: '全部站点' }), el('span', { class: 'src-tab-meta', text: `${onAll}/${all.length}` }));
  bar.append(allTab);

  for (const [src, sites] of groups) {
    const on = sites.filter((s) => chosenSet.has(sid(s.source, s.key))).length;
    /* 括号里只写插件 id，不带实例段：source 形如 "<插件id>/<实例段>"，实例段是实例坐标、
       对挑选站点没有信息量，写上反而让页签变长 */
    const name = `${sites[0].sourceName || src}（${src.split('/')[0]}）`;
    const tab = el('button', {
      class: 'src-tab' + (src === S.siteGroup ? ' active' : ''),
      title: `${name}：这一组 ${on}/${sites.length} 已勾选`,
      onclick: () => {
        S.siteGroup = src;
        paintSites();
      },
    });
    tab.append(el('span', { text: name }), el('span', { class: 'src-tab-meta', text: `${on}/${sites.length}` }));
    bar.append(tab);
  }
  return bar;
}

/** 一组站点：组头 + 一张表。`labelText` 只给「全部站点」那一档用（它没有单一的源名） */
function srcGroup(src, sites, chosenSet, labelText) {
  const on = sites.filter((s) => chosenSet.has(sid(s.source, s.key))).length;
  const head = el(
    'div',
    { class: 'src-head' },
    el('b', { text: labelText || `${sites[0].sourceName || src}（${src.split('/')[0]}）` }),
    el('span', { class: 'muted', text: `这一组 ${on}/${sites.length} 已勾选` }),
    el('span', { class: 'spacer' }),
    el('button', { class: 'btn mini', title: '把这一组当前列出来的站点全部勾上', text: '整组全选', onclick: () => bulk(sites, 'on') }),
    el('button', {
      class: 'btn mini',
      title: '把这一组当前列出来的站点整组翻转：勾上的取消、没勾的勾上',
      text: '整组反选',
      onclick: () => bulk(sites, 'invert'),
    })
  );

  const timeoutMs = (Number((draft.params || {}).timeoutSec) || 0) * 1000;
  /* 「全部站点」这一档把各源的站混在一张表里，所以多一列**来源**（分成一组一组看时就不用重复了） */
  const allView = src === ALL_SITES;
  const table = el('table', { class: 'sites-table' });
  table.append(
    el(
      'thead',
      {},
      el(
        'tr',
        {},
        el('th', { text: '这套模板' }),
        allView ? el('th', { text: '来源' }) : null,
        el('th', { text: '名称' }),
        el('th', { title: '测速结果：一发 POST /search 的往返耗时。悬停可看用的片名与真实业务的耗时', text: '延迟' }),
        el('th', { title: '一层式 = 搜索结果里直接带线路；两层式 = 搜索只出候选，线路要再取一次详情', text: '层次' })
      )
    )
  );
  const tb = el('tbody');
  for (const s of sites) {
    const cb = el('input', { type: 'checkbox', checked: chosenSet.has(sid(s.source, s.key)), class: 'switch' });
    cb.addEventListener('change', () => {
      setChosen(s, cb.checked);
      paintSites();
    });
    tb.append(
      el(
        'tr',
        {},
        el('td', {}, cb),
        allView ? el('td', { 'data-label': '来源', text: s.sourceName || s.source }) : null,
        el('td', { text: s.name || '-' }),
        delayCell(s, timeoutMs),
        layerCell(s)
      )
    );
  }
  table.append(tb);
  return el('div', { class: 'src-group' }, head, el('div', { class: 'table-wrap' }, table));
}

/**
 * 「层次」一格：这个站点是**一层式**还是**两层式**（契约字段 `directLines`）。
 *
 * 只认源在站点清单里申报的 `directLines`：true = 搜索结果直接带线路（一层式）；
 * 不申报 / false = 候选不带线路、要再取一次详情（两层式）。
 * 早先版本的源插件没申报这个字段，会暂时都显示两层式，更新插件后即正常 —— 不再读
 * filterable / indexs 这类适配器内部字段。
 */
function layerCell(s) {
  const one = s.directLines === true;
  return el('td', {
    'data-label': '层次',
    text: one ? '一层式' : '两层式',
    title: one
      ? '搜索结果里直接带线路，不用再取详情'
      : '搜索只出候选，线路要再取一次详情才有',
  });
}

/** 勾 / 不勾一条（站点身份 = (源, 站点 key)：多源下同名 key 是两条不同的站点） */
function setChosen(s, on) {
  const next = draft.sites.filter((x) => !(x.source === s.source && x.key === s.key));
  if (on) next.push({ source: s.source, key: s.key });
  draft.sites = next;
  setDirty(true);
}

/** 整组动作：`mode` = 'on' 全勾 / 'invert' 翻转 —— 只动**传进来这些**（= 当前列出来的）站点 */
function bulk(sites, mode) {
  const keys = new Set(sites.map((s) => sid(s.source, s.key)));
  const chosen = new Set(draft.sites.map((x) => sid(x.source, x.key)));
  const next = draft.sites.filter((x) => !keys.has(sid(x.source, x.key)));
  for (const s of sites) {
    if (mode === 'on' || !chosen.has(sid(s.source, s.key))) next.push({ source: s.source, key: s.key });
  }
  draft.sites = next;
  setDirty(true);
  paintSites();
}

async function clearAll() {
  if (!draft.sites.length) return toast('这一套本来就没勾站点');
  const go = await confirmModal({
    title: '清空勾选',
    text: '把这一套模板的站点全部取消勾选？（点顶部的「保存这套模板」才真正写回）',
    okLabel: '全部取消',
    primary: false,
  });
  if (!go) return;
  draft.sites = [];
  setDirty(true);
  paintSites();
}

/* ------------------------------------------------------------------ 站点表的小工具 */

function siteVisible(s, chosenSet) {
  if (S.siteView === 'on' && !chosenSet.has(sid(s.source, s.key))) return false;
  if (S.siteView === 'off' && chosenSet.has(sid(s.source, s.key))) return false;
  const f = String(S.siteFilter || '').trim().toLowerCase();
  if (f && !(String(s.name || '').toLowerCase().includes(f) || String(s.key || '').toLowerCase().includes(f))) return false;
  return true;
}

const fmtMs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : Math.round(ms) + 'ms');

function fmtTime(ts) {
  if (!ts) return '';
  const d = new Date(Number(ts));
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function sortKey(s) {
  const one = (s.stat || {}).probe || null;
  return one && one.ok ? one.ms : Infinity;
}

function sortSites(list) {
  if (!S.siteSort) return list;
  const dir = S.siteSort === 'slow' ? -1 : 1;
  return list.slice().sort((a, b) => dir * (sortKey(a) - sortKey(b)));
}

/** 「延迟」列：服务端测速结果 + 单点复测按钮（复测成功即恢复"不再被跳过"） */
function delayCell(s, timeoutMs) {
  const stat = s.stat || {};
  const one = stat.probe || null;
  const call = stat.call || {};
  const callNote = [
    call.search ? `真实搜索：最近一次 ${fmtMs(call.search.ms)}${call.search.ok ? '' : '（失败：' + call.search.error + '）'}` : '真实搜索：还没搜过',
    call.detail ? `真实取详情：最近一次 ${fmtMs(call.detail.ms)}${call.detail.ok ? '' : '（失败：' + call.detail.error + '）'}` : '真实取详情：还没点开过',
  ].join('\n');

  const btn = el('button', {
    class: 'btn mini ml-sm',
    text: '测速',
    title: '只测这一个站：服务端打一发 /search（片名随机取、非 200 换一个再测），结果直接写进这一列',
    onclick: async (e) => {
      const b = e.target;
      b.disabled = true;
      b.textContent = '…';
      try {
        /* 单站测速：只要「实例 + 站点 key」—— 接口前缀由插件自己知道（面板不再拼路径） */
        const r = await api('/api/agg/site-test/one', { method: 'POST', body: { source: s.source, key: s.key } });
        if (td.isConnected) td.replaceWith(delayCell(Object.assign({}, s, { stat: r.stat }), timeoutMs));
        toast(`${s.name || s.key}：${r.search.ok ? fmtMs(r.search.ms) + ` · ${r.search.count} 条` : r.search.error || '失败'}`);
      } catch (err) {
        toast((err && err.message) || '单站测速失败', true);
        b.disabled = false;
        b.textContent = '测速';
      }
    },
  });

  let td;
  if (!one) {
    td = el('td', { class: 'note', title: `还没测过 —— 点右边的「测速」，或用上面的「立即测速」整轮刷新。\n${callNote}` }, '—', btn);
  } else if (!one.ok) {
    const why = one.routeMissing
      ? '这个源里该站没有 /search 端点（文案是 Route POST:… not found，不是站坏了）'
      : one.timeout
        ? `超过测速超时（${fmtMs(one.ms)}）`
        : one.error || '请求失败';
    td = el(
      'td',
      {
        class: 'note err-note',
        title: `测速失败：${why}\n用的片名「${one.wd}」${one.tries > 1 ? `（第 ${one.tries} 发，首发失败后换过词）` : ''}\n这套模板开了「跳过测速失败的站点」时，聚合搜索会先跳过它 —— 点「测速」复测成功即恢复。\n${callNote}`,
      },
      one.status ? 'HTTP ' + one.status : '失败',
      btn
    );
  } else {
    const slow = timeoutMs > 0 && one.ms >= timeoutMs;
    td = el(
      'td',
      {
        class: slow ? 'note err-note' : 'mono',
        title:
          `测速：${fmtMs(one.ms)}（单发 /search，片名「${one.wd}」${one.tries > 1 ? `，第 ${one.tries} 发（首发失败换过词）` : ''}）\n` +
          `返回 ${one.count} 条${one.count === 0 ? '（这个词这站没有 —— 仍是有效样本）' : ''}\n测速时间：${fmtTime(one.at)}\n` +
          (slow ? `⚠️ 比这套模板的单站超时（${fmtMs(timeoutMs)}）还慢 —— 聚合里会被判超时\n` : '') +
          callNote,
      },
      fmtMs(one.ms),
      btn
    );
  }
  return td;
}

/* ------------------------------------------------------------------ 测速（服务端任务，页内 UI） */

let pollTimer = null;
let wasRunning = false;

function paintTestMsg(st) {
  const msg = $('#siteTestMsg');
  if (!msg || !st) return;
  if (st.running) {
    msg.textContent = `测速中… ${st.done}/${st.total}` + (st.badCount ? `（${st.badCount} 个失败）` : '');
    return;
  }
  const parts = st.lastRunAt
    ? [`上次测速 ${fmtTime(st.lastRunAt)}：${st.done}/${st.total} 个站 · ${Math.round((st.lastElapsedMs || 0) / 1000)}s` + (st.lastBad ? ` · ${st.lastBad} 个失败` : '')]
    : ['还没测过'];
  parts.push(st.enabled ? `下次自动 ${fmtTime(st.nextRunAt)}（每 ${st.hours} 小时）` : '自动测速已关（「面板设置」可开）');
  msg.textContent = parts.join(' · ');
}

async function refreshTestState() {
  try {
    const st = await api('/api/agg/site-test');
    paintTestMsg(st);
    return st;
  } catch {
    return null;
  }
}

function setTestBtns(running) {
  const btn = $('#siteTestBtn');
  const stopBtn = $('#siteTestStop');
  if (btn) {
    btn.disabled = !!running;
    btn.textContent = running ? '测速中…' : '立即测速';
  }
  if (stopBtn) stopBtn.classList.toggle('hidden', !running);
}

function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (!$('#siteTestMsg')) {
      clearInterval(pollTimer);
      pollTimer = null;
      return;
    }
    const st = await refreshTestState();
    if (!st) return;
    setTestBtns(st.running);
    if (st.running) {
      wasRunning = true;
      return;
    }
    if (!wasRunning) return;
    wasRunning = false;
    try {
      await ensureAggSites({ force: true });
    } catch {
      /* 拉不到就按内存里那份画 */
    }
    paintSites();
    toast('测速完成');
    clearInterval(pollTimer);
    pollTimer = null;
  }, 1500);
}

async function initSpeedTestUi() {
  const st = await refreshTestState();
  if (!st || !$('#siteTestMsg')) return;
  setTestBtns(st.running);
  wasRunning = st.running;
  if (st.running) startPolling();
}

async function startSpeedTest() {
  if (!draft) return;
  const chosenSet = new Set(draft.sites.map((x) => sid(x.source, x.key)));
  const list = (S.aggSites || []).filter((s) => siteVisible(s, chosenSet));
  if (!list.length) return toast('没有可测的站点（先调好筛选或视图）', true);
  const go = await confirmModal({
    title: '立即测速',
    text: `对当前列出来的 ${list.length} 个站点跑一轮测速？在服务端跑，关掉页面也会继续；随时可「停止测速」。`,
    okLabel: '开始测速',
  });
  if (!go) return;
  try {
    const r = await api('/api/agg/site-test/start', {
      method: 'POST',
      body: { keys: list.map((s) => ({ source: s.source, key: s.key })) },
    });
    paintTestMsg(r);
    setTestBtns(!!r.running);
    wasRunning = !!r.running;
    startPolling();
  } catch (e) {
    toast(e.message || '启动测速失败', true);
    refreshTestState();
  }
}

async function stopSpeedTest() {
  try {
    paintTestMsg(await api('/api/agg/site-test/stop', { method: 'POST' }));
  } catch (e) {
    toast(e.message || '停止测速失败', true);
  }
}