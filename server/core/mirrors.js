'use strict';
/**
 * 「取 GitHub 资源」的镜像候选：公共 gh 代理前缀（前缀型，地址形如 `<前缀>/<官方地址>`）。
 *
 * 决策与安全口径见 docs/adr/0067-mirror-fallback-sources.md。两个应用侧消费方**共用这一份**：
 *   · 面板自身更新   server/modules/panel/update.js
 *   · 插件库取包     server/modules/plugin/library.js
 *
 * ⚠️ 容器引导脚本 `docker/entrypoint.js` 是独立文件（首装时应用代码还不存在，不能 import 应用代码），
 * 所以那边**另有一份同样的表**；改这里的默认候选，记得同步过去（ADR-0067「后果」有记）。
 *
 * ⚠️ 走镜像时包体与其校验值同源（都在代理手里），校验只防传输损坏、不防代理替换。
 */
const DEFAULT_MIRRORS = ['https://gh-proxy.com', 'https://ghfast.top'];

/** 单次取源请求的超时：候选串行往下试，不设超时会让一个挂死的候选把整次取源拖黄 */
const FETCH_TIMEOUT_MS = 20 * 1000;

/**
 * 镜像前缀列表：`APP_MIRRORS` 逗号分隔、有序。
 * 未设 / 留空 = 用内置默认；置 `off` / `none` / `-` = 关闭镜像、只走官方直连。
 * 只收 `http(s)` 前缀，空项与非法项丢弃。
 */
function mirrorPrefixes() {
  const spec = String(process.env.APP_MIRRORS === undefined ? '' : process.env.APP_MIRRORS).trim();
  if (!spec) return DEFAULT_MIRRORS.slice();
  if (/^(off|none|-)$/i.test(spec)) return [];
  return spec
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => /^https?:\/\//i.test(s));
}

/**
 * 把候选按镜像前缀展开成**有序地址表**：`[<前缀>/<base>, …, <base>]`。
 * 官方 `base` 恒为最后一个兜底；没有镜像时就只有它自己。
 */
function withMirrors(base) {
  const list = mirrorPrefixes().map((p) => `${p}/${base}`);
  list.push(base);
  return list;
}

/** 带超时的 fetch：候选串行往下试时，一个挂死的候选不该把整次取源拖黄 */
function fetchOnce(url, opts = {}) {
  return fetch(url, Object.assign({}, opts, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }));
}

module.exports = { DEFAULT_MIRRORS, FETCH_TIMEOUT_MS, mirrorPrefixes, withMirrors, fetchOnce };
