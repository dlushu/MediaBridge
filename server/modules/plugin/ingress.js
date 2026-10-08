'use strict';
/**
 * 插件入口（ingress）鉴权分类 —— **面板只有一个端口**，插件不自己 listen。
 *
 * 背景见 docs/plugin-contract.md 第九节：外部程序（例如 FW/Rex 播放器里跑的
 * output 插件 JS）不在面板进程内，手里只有 HTTP。它们经两条**通用入口**进面板：
 *
 *   GET  /api/plugins/<类型>/<id>/ui/<文件>    插件静态文件（面板直接吐）
 *   ANY  /api/plugins/<类型>/<id>/api/<路径>   原样经管道转给插件的 `http` 动作
 *
 * 默认这两条都要面板登录 cookie。插件可在 `plugin.json` 里声明 `ingress` 改口径：
 *   · `public`：匿名放行 —— 只该放"不含秘密的程序本身"（如 widget.js）；
 *   · `token` ：要带**外部访问令牌**（query token / Bearer / X-Access-Token），
 *               面板登录 cookie 也算过（人在浏览器里开插件 webui 同一套路径时）。
 *
 * 本文件只做一件事：给定请求路径与请求对象，回答三态 ——
 *   null            不是受 ingress 管理的路径（调用方走原来的 cookie 门禁）
 *   { access:'public' } / { access:'session', via }  放行
 *   { access:'deny', reason }                         声明了要令牌但没给/给错
 *
 * 安全口径：
 *   · 名单里没列的路径**一律回落到 cookie 门禁** —— 声明才放开，默认收紧；
 *   · 只认注册表里那份 ingress（安装时由 contract 校验字形，拒掉 `..` 等）。
 */
const store = require('./store');
const contract = require('./contract');
const auth = require('../../core/auth');

/**
 * `/api/plugins/<类型>/<id>/(ui|api)/<相对路径>`
 * 捕获四段；不匹配回 null（它不是插件 ui/api 入口，可能是 /call、/state 等管理路由）。
 */
const PATH_RE = /^\/api\/plugins\/([^/]+)\/([^/]+)\/(ui|api)(?:\/(.*))?$/;

/**
 * 分类一次请求。
 * @returns {null|{access:'public'|'session', via:'public'|'token'|'cookie'}|{access:'deny', reason:string}}
 */
function check(pathname, req, searchParams) {
  const m = PATH_RE.exec(String(pathname || ''));
  if (!m) return null;
  const [, type, id, section, restRaw] = m;
  const entry = store.get(type, id);
  if (!entry || !entry.ingress) return null; // 没装 / 老清单没这字段 → 交给默认门禁

  /* 归一化成 `ui/...` / `api/...`（空尾段 = 目录根，没有插件会声明它，落回默认门禁） */
  const rel = `${section}/${String(restRaw || '')}`;
  const hit = contract.ingressMatch(entry.ingress, rel);
  if (!hit) return null; // 名单外：默认门禁（cookie），不匿名、不验令牌

  if (hit === 'public') return { access: 'public', via: 'public' };

  /* token 路径：外部令牌 或 面板登录 cookie，二选一 */
  if (auth.isAuthed(req)) return { access: 'session', via: 'cookie' };
  const token = auth.ingressTokenOf(req, searchParams);
  if (auth.verifyIngressToken(token)) return { access: 'session', via: 'token' };
  return { access: 'deny', reason: '这条插件入口需要外部访问令牌（在该插件设置页复制；或先登录面板）' };
}

module.exports = { check, PATH_RE };
