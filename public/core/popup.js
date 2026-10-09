'use strict';
/**
 * 登录面板后的弹窗：取回后端那份内容（见 server/modules/panel/popup.js），按类型弹出。
 *
 * 类型（由内容文件的 `<meta name="mbp-popup-mode">` 决定）：
 *   · always      大弹窗，每次打开 / 刷新面板都弹，关闭只关当次；
 *   · dismissible 大弹窗，点「不再显示」后把正文哈希记进本机 localStorage，正文再改才重弹；
 *   · toast       右下角小弹窗，`seconds` 秒后自动隐藏；
 *   · off         不弹。
 *
 * 内容一律用 `iframe` + `srcdoc` + `sandbox` 渲染，**不给 `allow-scripts`**：远程内容是别人
 * 维护的，这样能隔离它的样式、也不执行脚本与内联事件属性（口径同「关于」页的公告，见 ADR-0068）。
 *
 * 取不到 / 内容为空一律静默不弹：弹窗不是关键功能，失败不该打扰用户。
 */
import { el } from './dom.js';
import { api } from './api.js';

/** 记「已关过哪一版」的 localStorage 键（前缀为品牌短标识，与全站一致） */
const SEEN_KEY = 'mbp-popup-seen';
const DEFAULT_SECONDS = 10;

/** 取回并弹出（后端不可达 / 没内容 / 已关过 → 什么都不做） */
export async function showEntryPopup() {
  let d;
  try {
    d = await api('/api/panel/popup');
  } catch {
    return; // 取不到不弹，也不提示
  }
  const html = String((d && d.html) || '').trim();
  if (!html) return;
  const mode = String(d.mode || 'dismissible');
  if (mode === 'off') return;
  if (mode === 'toast') return mountToast(html, d.seconds);

  const hash = String(d.hash || '');
  /* dismissible：同一版正文已点过「不再显示」就不再弹；正文一改哈希变，重新弹 */
  if (mode === 'dismissible' && hash && seenHash() === hash) return;
  mountModal(html, mode === 'dismissible' ? hash : '');
}

/**
 * 内嵌 frame：srcdoc 文档与面板同源，加载后量一次内容高度把 frame 撑到刚好；内容里有图片
 * 这类异步资源时首次量得偏小，所以 `load` 后再补量一次。量不到（例如浏览器不给同源）时退回
 * 一个够用的固定高度，别把内容压成一条线。
 */
function makeFrame(html) {
  const frame = el('iframe', {
    class: 'popup-frame',
    sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
  });
  const fit = () => {
    let h = 0;
    try {
      const doc = frame.contentDocument;
      if (doc) h = Math.max((doc.body && doc.body.scrollHeight) || 0, doc.documentElement.scrollHeight || 0);
    } catch {
      h = 0;
    }
    frame.style.height = (h > 0 ? h : 120) + 'px';
  };
  frame.addEventListener('load', () => {
    fit();
    setTimeout(fit, 300);
  });
  frame.srcdoc = html; // 事件已挂好再设正文，避免漏掉首次 load
  setTimeout(fit, 300);
  return frame;
}

/** 大弹窗（always / dismissible）：遮罩 + 居中框，点遮罩 / Esc / 关闭按钮关掉当次 */
function mountModal(html, dismissHash) {
  const close = () => {
    document.removeEventListener('keydown', onKey);
    mask.remove();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };

  const actions = el('div', { class: 'popup-actions' });
  if (dismissHash) {
    actions.append(
      el('button', {
        class: 'btn',
        text: '不再显示',
        onclick: () => {
          markSeen(dismissHash);
          close();
        },
      })
    );
  }
  actions.append(el('button', { class: 'btn primary', text: '关闭', onclick: close }));

  const box = el(
    'div',
    { class: 'popup-box', role: 'dialog', 'aria-modal': 'true' },
    el('div', { class: 'popup-body' }, makeFrame(html)),
    actions
  );
  const mask = el('div', { class: 'popup-mask' }, box);
  mask.addEventListener('click', (e) => {
    if (e.target === mask) close();
  });

  document.body.append(mask);
  document.addEventListener('keydown', onKey);
  /* 焦点给到弹窗框，键盘用户不用先点一下；框本身不可聚焦时退而给关闭按钮。 */
  setTimeout(() => {
    const btn = box.querySelector('.popup-actions .btn.primary');
    if (btn) btn.focus();
  }, 20);
}

/** 小弹窗（toast）：右下角一个卡片，`seconds` 秒后自动隐藏 */
function mountToast(html, seconds) {
  const box = el('div', { class: 'popup-toast', role: 'status' }, makeFrame(html));
  document.body.append(box);
  setTimeout(() => box.remove(), normalizeSeconds(seconds) * 1000);
}

/** 秒数兜底：非正数 / 非法值一律按默认值算 */
function normalizeSeconds(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SECONDS;
}

function seenHash() {
  try {
    return localStorage.getItem(SEEN_KEY) || '';
  } catch {
    return ''; // 隐私模式等读不到就当作没记过
  }
}

function markSeen(hash) {
  try {
    localStorage.setItem(SEEN_KEY, hash);
  } catch {
    /* 写不进去（隐私模式 / 配额满）就只关当次，下次仍会弹 —— 是能接受的结果 */
  }
}
