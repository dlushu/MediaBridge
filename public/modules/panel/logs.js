'use strict';
/**
 * 面板设置 · 「日志」页
 *
 * 数据来自 `GET /api/logs`（见 `server/core/logbus.js`）：**进程内存里最近 N 条**，不落盘。
 * 它抓的是整个面板的 `console` 输出（启动横幅、插件沙箱、emby 的失败行、源/聚合的异常…）。
 * 长期留档看 `docker logs` —— docker 的 json-file 自带轮转（10MB × 3），所以这里不需要落盘。
 *
 * 三个「跑久了别出问题」的细节：
 *   ① **增量拉取**：带上 `since=<上次的 lastSeq>`，只取新行，不重复传全量；
 *   ② **离开页面就停**：渲染开头先清掉上一个定时器，并每轮用 `node.isConnected` 守一次 ——
 *      `renderPage()` 每次导航都会**克隆** `#view`，不守卫就会往已经脱离的节点里写；
 *   ③ **页面不可见时暂停**（`document.hidden`）：切到后台就别再轮询了。
 *   另外 DOM 也设了上限（`DOM_MAX`）：面板内存只留 N 条，页面上再多也只是一屏历史。
 */
import { el, toast } from '../../core/dom.js';
import { api } from '../../core/api.js';

/** 轮询间隔 —— 2 秒够"即时"，又不会把面板刷爆 */
const POLL_MS = 2000;
/** 一次最多取多少条（首次加载给 200；之后靠 since 增量，回不了几条） */
const FETCH_LIMIT = 200;
/** 页面上最多保留多少行（超过就把最老的删掉 —— 别让浏览器卡住） */
const DOM_MAX = 500;

/** 上一次渲染留下的定时器：**跨渲染**保存，用来在下次进来时清掉 */
let timer = null;

/** 毫秒时间戳 → `HH:MM:SS` */
function hms(t) {
  const d = new Date(Number(t) || 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function renderPanelLogs(v) {
  /* ② 先清掉上一次的定时器（切走再回来、或反复点这一页，都不会叠加） */
  if (timer) {
    clearInterval(timer);
    timer = null;
  }

  let lastSeq = 0; // 增量游标（服务端的累计序号）
  let paused = false;
  let level = 'all'; // all | warn | error
  let max = 0; // 服务端的缓冲上限
  let missed = 0; // 因缓冲覆盖而漏掉的条数

  const listEl = el('pre', { class: 'json log-list' });
  const statEl = el('span', { class: 'muted', text: '正在加载…' });
  const noteEl = el('span', { class: 'note' });

  /* ---------------- 工具条 ---------------- */
  const pauseBtn = el('button', { class: 'btn mini', text: '暂停' });
  const clearBtn = el('button', { class: 'btn mini danger', text: '清空' });
  const exportBtn = el('button', { class: 'btn mini', text: '导出日志' });
  const checkBtn = el('button', { class: 'btn mini', text: '系统自检' });

  /* 级别过滤：全部（含 info/log）/ 警告以上 / 仅错误。
   * 用分段控件而不是一排按钮 —— 它只换"看哪些"，不产生动作，按钮样式会让人以为点了会执行什么。 */
  const LEVELS = [
    ['all', '全部'],
    ['warn', '警告以上'],
    ['error', '仅错误'],
  ];
  const levelBtns = LEVELS.map(([key, label]) =>
    el('button', {
      class: 'seg-item' + (key === level ? ' active' : ''),
      text: label,
      'data-level': key,
      onclick: () => {
        level = key;
        for (const x of levelBtns) x.classList.toggle('active', x.dataset.level === key);
        applyFilter();
      },
    })
  );
  const levelSeg = el('div', { class: 'seg' }, ...levelBtns);

  function applyFilter() {
    const ok = (lv) => level === 'all' || (level === 'warn' && (lv === 'warn' || lv === 'error')) || (level === 'error' && lv === 'error');
    for (const row of listEl.children) row.classList.toggle('hidden', !ok(row.dataset.level));
  }

  function stat() {
    statEl.textContent = `已显示 ${listEl.childElementCount} 行 / 上限 ${max || '?'} 条`;
    noteEl.textContent = missed ? `⚠️ 有 ${missed} 条已被覆盖（只保留最近 ${max} 条）` : '';
  }

  /** 追加一批（服务端给的是按行拆好的条目） */
  function addItems(items) {
    const atBottom = listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 8;
    for (const it of items) {
      listEl.append(
        el(
          'div',
          { class: 'log-line', 'data-level': it.level },
          el('span', { class: 'muted', text: hms(it.t) + '  ' }),
          el('span', { text: it.text })
        )
      );
    }
    while (listEl.childElementCount > DOM_MAX) listEl.firstElementChild.remove();
    applyFilter();
    stat();
    if (atBottom) listEl.scrollTop = listEl.scrollHeight; // 用户没在上翻时才自动跟到底
  }

  /* ---------------- 轮询（增量） ---------------- */
  async function poll() {
    if (paused || document.hidden || !v.isConnected) return;
    /* ③ `v.isConnected`：页面已切走（`#view` 被克隆过）就什么都不做 */
    try {
      const r = await api(`/api/logs?since=${lastSeq}&limit=${FETCH_LIMIT}`);
      if (typeof r.max === 'number') max = r.max;
      if (r.missed) missed += r.missed;
      if (Array.isArray(r.items) && r.items.length) addItems(r.items);
      else stat();
      if (typeof r.lastSeq === 'number') lastSeq = r.lastSeq;
    } catch {
      /* 面板正在重启时接口会短暂失败 —— 静默重试，别弹提示刷屏 */
    }
  }

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? '继续' : '暂停';
    if (!paused) poll(); // 恢复时立刻补一次，不用等下一个 2 秒
  });

  clearBtn.addEventListener('click', async () => {
    if (!confirm('清空面板内存里的日志？（docker logs 里的不受影响）')) return;
    try {
      await api('/api/logs', { method: 'DELETE' });
      listEl.replaceChildren();
      lastSeq = 0;
      missed = 0;
      stat();
      toast('已清空');
    } catch (e) {
      toast(e.message, true);
    }
  });

  /* 导出日志：下载带系统环境信息的完整日志文件 */
  exportBtn.addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = '/api/logs/export';
    a.download = ''; // 让浏览器用 Content-Disposition 里的文件名
    document.body.append(a);
    a.click();
    a.remove();
    toast('日志导出中…');
  });

  /* 系统自检：检查关键路径与配置状态 */
  checkBtn.addEventListener('click', async () => {
    try {
      const r = await api('/api/panel/selfcheck');
      const lines = [`系统自检 ${r.ok ? '✔ 通过' : '✘ 有问题'}\n`];
      for (const c of r.checks) {
        lines.push(`${c.ok ? '✔' : '✘'} ${c.name}: ${c.detail}`);
      }
      alert(lines.join('\n'));
    } catch (e) {
      toast('自检失败: ' + e.message, true);
    }
  });

  /* ---------------- 组装 ---------------- */
  v.append(
    el(
      'div',
      { class: 'card' },
      el('h3', { text: '日志' }),
      el(
        'div',
        { class: 'toolbar' },
        pauseBtn,
        clearBtn,
        el('span', { class: 'sep' }),
        exportBtn,
        checkBtn,
        el('span', { class: 'sep' }),
        levelSeg,
        el('span', { class: 'spacer' }),
        statEl
      ),
      noteEl,
      listEl
    )
  );

  stat();
  poll(); // 首次（`since=0` → 服务端回最后 N 条）
  timer = setInterval(poll, POLL_MS);
}
