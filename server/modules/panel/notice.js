'use strict';
/**
 * 「关于」页的内嵌公告：把仓库里一份 HTML 原样取回，交给前端内嵌显示。
 *
 * 内容与面板代码**分开维护**：公告（交流群地址、贡献者名单这类）放在仓库根目录 `notice.html`，
 * 改它并推送即生效，不必重新发版。取回地址默认
 * `https://raw.githubusercontent.com/<repo>/main/notice.html`（`<repo>` 与「设置 → 关于」的
 * 仓库地址同源，见 update.js 的 `repoInfo`）。
 *
 * 取源与面板更新、插件库**共用一套候选**（`core/mirrors`）：默认先试公共 gh 代理、失败退官方直连
 * （决策见 docs/adr/0067-mirror-fallback-sources.md）。`PANEL_NOTICE_URL` 可覆盖取回地址
 * —— 显式给出时**不套镜像前缀**（与 ADR-0067 的「用户指哪打哪」一致）；置 `off` / `none` / `-` 关闭。
 *
 * ⚠️ 走第三方代理时，取回的内容可能与仓库里的原文不同（ADR-0067 的安全口径）—— 因此前端**不执行
 *    它的脚本**、样式也隔离在内嵌 frame 里（见 public/modules/panel/settings.js 的 noticeCard）。
 *
 * 失败与「没内容」都回空串，前端据此把整张卡去掉：取不到公告不是错误，不必弹提示。
 */
const { withMirrors, fetchOnce } = require('../../core/mirrors');
const update = require('./update');

/** 结果缓存时长：公告是低频内容，没必要每次打开「关于」页都去打一次取源 */
const NOTICE_TTL_MS = 5 * 60 * 1000;

/** 上一次取回的结果（含空串结果）——失败也缓存，免得网络不好时每次打开「关于」页都重试一遍 */
let cache = null; // { at, value }

/** 取回地址的候选表（有序，官方直连收尾）；关闭或显式指定时按对应口径收窄 */
function candidates() {
  const custom = String(process.env.PANEL_NOTICE_URL || '').trim();
  if (/^(off|none|-)$/i.test(custom)) return [];
  const repo = update.repoInfo().repo;
  const base = custom || `https://raw.githubusercontent.com/${repo}/main/notice.html`;
  return custom ? [base] : withMirrors(base);
}

/** 从单个地址取一次公告正文 */
async function fetchOne(url) {
  const res = await fetchOnce(url, { redirect: 'follow', headers: { 'user-agent': 'media-bridge-panel' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/** 取一次公告：按候选串行降级，第一个成功的胜出；全失败**不抛**，回空串并把原因记下 */
async function load() {
  const list = candidates();
  if (!list.length) return { html: '', url: '', error: '公告已关闭（PANEL_NOTICE_URL=off）' };

  const errors = [];
  for (const url of list) {
    try {
      return { html: (await fetchOne(url)).trim(), url };
    } catch (e) {
      errors.push(`${url}：${(e && e.message) || String(e)}`);
    }
  }
  console.log(`  · 公告：取回失败（已试 ${errors.length} 个地址）：${errors.join('；')}`);
  return { html: '', url: list[0], error: errors.join('；') };
}

/**
 * 公告内容（带缓存）。返回 `{ html, url, error? }`：
 *   · `html`  正文（空串 = 没内容 / 取不到，前端隐藏整张卡）；
 *   · `url`   实取胜出的地址（排查用）；
 *   · `error` 取回失败的原因（排查用，前端不展示）。
 */
async function get() {
  const now = Date.now();
  if (cache && now - cache.at < NOTICE_TTL_MS) return cache.value;
  const value = await load();
  cache = { at: now, value };
  return value;
}

module.exports = { get };
