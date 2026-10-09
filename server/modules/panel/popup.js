'use strict';
/**
 * 登录后弹窗：把仓库里一份 HTML 原样取回，连同它的类型配置一起交给前端弹出。
 *
 * 内容与配置**分开维护**：弹窗正文与类型放在仓库根目录 `popup.html`，改它并推送即生效，
 * 不必重新发版。取回地址默认
 * `https://raw.githubusercontent.com/<repo>/main/popup.html`（`<repo>` 与「设置 → 关于」的
 * 仓库地址同源，见 update.js 的 `repoInfo`）。
 *
 * 类型与秒数写在内容文件的 `<meta>` 里（改类型不必改面板代码）：
 *   · `mbp-popup-mode`    always | dismissible | toast | off（缺省 / 未知按 dismissible）；
 *   · `mbp-popup-seconds` toast 自动隐藏秒数（缺省 / 非法按 10）。
 * `hash` 是正文（去掉上面两条配置 meta）的 sha256 短值，前端据此记「已关过哪一版」——
 * 正文一改，哈希就变，弹窗重新出现。
 *
 * 取源与面板更新、插件库、公告**共用一套候选**（`core/mirrors`，见 docs/adr/0067）。
 * `PANEL_POPUP_URL` 可覆盖取回地址 —— 显式给出时**不套镜像前缀**（与 ADR-0067 的
 * 「用户指哪打哪」一致）；置 `off` / `none` / `-` 关闭弹窗。
 *
 * ⚠️ 走第三方代理时，取回的内容可能与仓库里的原文不同（ADR-0067 的安全口径）—— 前端**不执行
 *    它的脚本**、样式也隔离在内嵌 frame 里（见 public/core/popup.js）。
 *
 * 失败与「没内容」都回空串 `html`，前端据此不弹：取不到弹窗不是错误，不必弹提示。
 */
const crypto = require('node:crypto');
const { withMirrors, fetchOnce } = require('../../core/mirrors');
const update = require('./update');

/** 结果缓存时长：弹窗是低频内容，没必要每次打开面板都去打一次取源 */
const POPUP_TTL_MS = 5 * 60 * 1000;

/** 没声明 / 声明非法时的兜底：类型与自动隐藏秒数 */
const DEFAULT_MODE = 'dismissible';
const DEFAULT_SECONDS = 10;
const MODES = ['always', 'dismissible', 'toast', 'off'];

/** 上一次取回的结果（含空串结果）——失败也缓存，免得网络不好时每次打开面板都重试一遍 */
let cache = null; // { at, value }

/** 取回地址的候选表（有序，官方直连收尾）；关闭或显式指定时按对应口径收窄 */
function candidates() {
  const custom = String(process.env.PANEL_POPUP_URL || '').trim();
  if (/^(off|none|-)$/i.test(custom)) return [];
  const repo = update.repoInfo().repo;
  const base = custom || `https://raw.githubusercontent.com/${repo}/main/popup.html`;
  return custom ? [base] : withMirrors(base);
}

/** 从单个地址取一次弹窗正文 */
async function fetchOne(url) {
  const res = await fetchOnce(url, { redirect: 'follow', headers: { 'user-agent': 'media-bridge-panel' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 取一个属性值（容忍属性顺序，以及双引号 / 单引号 / 无引号三种写法） */
function attr(tag, key) {
  const m = new RegExp(`\\b${key}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  if (!m) return '';
  return (m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] || '').trim();
}

/** 从正文里的 `<meta name="mbp-popup-*">` 读配置；未声明 / 非法的项落回默认值 */
function parseConfig(html) {
  const found = {};
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const name = attr(m[0], 'name').toLowerCase();
    if (name === 'mbp-popup-mode' || name === 'mbp-popup-seconds') found[name] = attr(m[0], 'content');
  }
  const mode = found['mbp-popup-mode'];
  const seconds = parseInt(found['mbp-popup-seconds'], 10);
  return {
    mode: MODES.includes(mode) ? mode : DEFAULT_MODE,
    seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_SECONDS,
  };
}

/** 正文哈希（去掉配置用的那两条 meta）：正文一改即视为「新弹窗」，前端据此重弹 */
function bodyHash(html) {
  const body = html.replace(/<meta\b[^>]*mbp-popup-(?:mode|seconds)[^>]*>/gi, '');
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
}

/** 取一次弹窗：按候选串行降级，第一个成功的胜出；全失败**不抛**，回空串、原因放进 `error` */
async function load() {
  const list = candidates();
  if (!list.length) {
    return { html: '', mode: 'off', seconds: DEFAULT_SECONDS, hash: '', url: '', error: '弹窗已关闭（PANEL_POPUP_URL=off）' };
  }

  const errors = [];
  for (const url of list) {
    try {
      const html = (await fetchOne(url)).trim();
      const cfg = parseConfig(html);
      return { html, mode: cfg.mode, seconds: cfg.seconds, hash: html ? bodyHash(html) : '', url };
    } catch (e) {
      errors.push(`${url}：${(e && e.message) || String(e)}`);
    }
  }
  return { html: '', mode: DEFAULT_MODE, seconds: DEFAULT_SECONDS, hash: '', url: list[0], error: errors.join('；') };
}

/**
 * 弹窗内容与配置（带缓存）。返回 `{ html, mode, seconds, hash, url, error? }`：
 *   · `html`    正文（空串 = 没内容 / 取不到，前端不弹）；
 *   · `mode`    弹窗类型（always / dismissible / toast / off）；
 *   · `seconds` toast 自动隐藏秒数；
 *   · `hash`    正文哈希（dismissible 记「已关过哪一版」用）；
 *   · `url`     实取胜出的地址（排查用）；
 *   · `error`   取回失败的原因（排查用，前端不展示）。
 */
async function get() {
  const now = Date.now();
  if (cache && now - cache.at < POPUP_TTL_MS) return cache.value;
  const value = await load();
  cache = { at: now, value };
  return value;
}

module.exports = { get };
