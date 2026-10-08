'use strict';
/**
 * 插件模块 · 「插件库」页：从**插件仓库**里挑一个装。
 *
 * 为什么有这一页（见 docs/adr/0035）：**插件不随面板发行** —— 全新安装的面板一个插件都没有，
 * 元数据与片源都得人去装。插件包集中放在一个独立仓库里（只放包 + 清单，不放源码），
 * 这一页拉它的 `index.json`，把"可装的"列出来；点一下就下载 → 校验 → 安装。
 *
 * ⚠️ 面板**不解释清单的内容**：清单里的字段由契约规定（见 docs/plugin-contract.md），
 * 这里只是把"可装的"画出来、把 type/id 交给后端。装包这件事本身与手动上传走的是同一套。
 *
 * 手动装（本地的 `.tar.gz`）在「插件 → 管理」页 —— 两条入口分开，是因为"从哪拿包"不同。
 */
import { $, el, toast, confirmModal, fmtTime } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { refreshNav } from '../../core/shell.js';

const TYPE_LABEL = { metadata: '元数据', source: '片源', home: '首页', output: '输出', subtitle: '字幕' };
const fmtKB = (n) => (Number(n) > 0 ? `约 ${Math.max(1, Math.round(Number(n) / 1024))}KB` : '');
/** 一条清单的类型数组（后端 v2 清单给 types；兼容单值） */
const typesOf = (p) => (Array.isArray(p.types) ? p.types : p.type ? [p.type] : []);
/** 多类型徽章（与管理页同一口径，见 docs/adr/0046） */
const typeBadges = (p) =>
  typesOf(p).map((t) => el('span', { class: 'badge', title: '类型：' + t, text: TYPE_LABEL[t] || t }));

export async function renderPluginLibrary(v) {
  const host = el('div', { id: 'pluginLibHost' });
  /* 「装完就启用」这颗复选框跨重绘保留：清单每次重画都把它原样挂回去，勾选状态不会丢 */
  const enableCb = el('input', { type: 'checkbox', checked: true });
  /* 只往 `#view` 里挂这一个宿主，占位卡放进**宿主内部** —— 挂在宿主外面的话，
   * `load()` 清的是宿主、那张「正在加载…」永远留在页尾；而且宿主外面那两张卡的间距
   * 也吃不到 `.card + .card`（多一层 div 就断了）。 */
  v.append(host);
  host.append(el('div', { class: 'card' }, el('h3', { text: '插件库' }), el('div', { class: 'muted', text: '正在加载…' })));
  await load();

  /** 拉一次清单（`force` = 绕过后端那 60 秒缓存）并重绘 */
  async function load(force = false) {
    const box = $('#pluginLibHost');
    if (!box) return;
    box.textContent = '';
    let d = null;
    try {
      d = await api('/api/plugins/library' + (force ? '?refresh=1' : ''));
    } catch (e) {
      box.append(el('div', { class: 'card' }, el('h3', { text: '插件库' }), el('div', { class: 'hint warn', text: '读取插件库失败：' + e.message })));
      return;
    }
    paint(d || {});
  }

  /** 装完刷新「已装」清单：侧栏那四栏是按插件清单现算的，新插件的设置页入口要立刻出现 */
  async function refreshInstalled() {
    try {
      S.plugins = await api('/api/plugins');
      refreshNav();
    } catch {
      /* 侧栏没刷新不算装失败：下次进这一页会重拉 */
    }
  }

  async function install(p, btn) {
    const types = typesOf(p);
    const typeText = types.map((t) => TYPE_LABEL[t] || t).join('/');
    const ok = await confirmModal({
      title: `装插件「${p.name || p.id}」`,
      text: `v${p.version}（${typeText} · ${p.id}）\n\n` + '插件能读写数据、能联网、能起进程 —— 只装信得过的来源。',
      okLabel: '装上去',
    });
    if (!ok) return;
    btn.disabled = true;
    btn.textContent = '正在下载…';
    try {
      const r = await api('/api/plugins/library/install', {
        method: 'POST',
        body: { type: types[0] || '', id: p.id, version: p.version, enable: enableCb.checked },
      });
      toast('已装上：' + ((r.plugin && r.plugin.name) || p.name || p.id));
      await load(true);
      await refreshInstalled();
    } catch (e) {
      toast('装失败：' + e.message, true);
      btn.textContent = p.installed ? '重装' : '安装';
      btn.disabled = false;
    }
  }

  function rowOf(p) {
    const types = typesOf(p);
    const label = !p.installed ? '安装' : p.hasUpdate ? `更新到 v${p.version}` : '重装';
    const btn = el('button', { class: 'btn mini primary', text: label, title: `装 ${types.join('/')}/${p.id} v${p.version}` });
    btn.addEventListener('click', () => install(p, btn));
    const bits = [
      p.id,
      fmtKB(p.bytes),
      p.domain ? `域 ${p.domain}` : '',
      p.author ? `作者 ${p.author}` : '',
      (p.depends || []).length ? `依赖 ${p.depends.join(' / ')}` : '',
    ].filter(Boolean);
    /* 与管理页同一个形状：标题行只留名称与徽章，明细在下，按钮组是整块的最后一件（右下角） */
    return el(
      'div',
      { class: 'plugin-row' },
      el(
        'div',
        { class: 'plugin-head' },
        el('span', { class: 'plugin-name', text: p.name || p.id }),
        ...typeBadges(p),
        el('span', { class: 'badge', text: 'v' + p.version }),
        p.installed ? el('span', { class: 'badge ok', text: '已装 v' + (p.installedVersion || '?') }) : null
      ),
      el('div', { class: 'note', text: bits.join(' · ') }),
      p.description ? el('div', { class: 'note', text: p.description }) : null,
      el('div', { class: 'row plugin-acts' }, btn)
    );
  }

  function paint(d) {
    const box = $('#pluginLibHost');
    if (!box) return;

    /* ---- 头一张卡：这是哪个仓库、索引什么时候生成的、要不要装完就起来 ---- */
    const head = el(
      'div',
      { class: 'card' },
      el('h3', { text: '插件库' }),
      el(
        'div',
        { class: 'row' },
        el('span', { class: 'muted', text: '来源：' }),
        el('a', { href: d.repoUrl || '#', target: '_blank', rel: 'noreferrer', text: d.repo || '（未知）' }),
        el('span', { class: 'spacer' }),
        el('button', { class: 'btn mini', text: '刷新', title: '重新拉一次清单（绕过后端 60 秒缓存）', onclick: () => load(true) })
      ),
      el('label', { class: 'chk', title: '装完立刻启用（起它的进程）' }, enableCb, '装完就启用')
    );
    if (d.error) head.append(el('div', { class: 'hint warn', text: '清单取不到：' + d.error }));
    else if (d.generatedAt) head.append(el('div', { class: 'note', text: '索引生成于 ' + fmtTime(d.generatedAt) }));
    box.append(head);

    /* ---- 第二张卡：可装的插件（含已装的"重装 / 更新"） ---- */
    const list = el('div', { class: 'card' }, el('h3', { text: '可装的插件' }));
    if (!(d.plugins || []).length) {
      list.append(el('div', { class: 'note', text: d.error ? '清单没取到，所以这里没有可装的插件。' : '这个仓库的清单里没有插件。' }));
    } else {
      for (const p of d.plugins) list.append(rowOf(p));
    }
    if ((d.bad || []).length) {
      list.append(
        el('div', {
          class: 'hint warn',
          text:
            `清单里有 ${d.bad.length} 条读不懂，已跳过：` +
            d.bad.map((x) => `${((x.types || []).join('/')) || '?'}/${x.id || '?'}（${x.reason}）`).join('；'),
        })
      );
    }
    box.append(list);
  }
}