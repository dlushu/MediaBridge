'use strict';
/**
 * 面板鉴权（单密码门禁）
 *
 * 定位：**这是一道"门"，不是一套用户体系**。一个密码、一个共享会话，
 * 足以挡住"局域网里随手打开面板的人"，但——
 *   · 面板默认是 **http 明文**，密码在链路上也是明文（除非前面套了 https 反代）；
 *   · 没有多用户、没有权限分级、没有审计。
 * 因此：**不要把面板直接暴露到公网**（README 里也写了这句）。
 *
 * 凭证落在 `data/auth.json`（**不在 settings/ 里** —— 那个目录会被 `/api/modules/:id/settings`
 * 与「配置备份」原样导出，密码哈希和会话密钥不该走那条路）：
 *
 *   { "passwordHash": "scrypt$<salt>$<hash>", "secret": "<会话签名密钥>", "updatedAt": 123 }
 *
 * 三条设计选择：
 *   ① **密码只存 scrypt 哈希**，从不落明文（比对用 `timingSafeEqual`）；
 *   ② **会话是无状态签名 cookie**（`exp` + `iat` + `pv` 三段签名）—— 面板重启不必重新登录，
 *      而 `pv` 是"密码哈希"的指纹，所以**改密码 = 旧会话立刻全失效**；
 *      有效期**可配且滑动**（默认 15 分钟、上限 30 天，改设置见面板「安全」页）；
 *   ③ Emby 客户端那套端点（`/api/emby/*`）**必须放行** —— 它们有自己的 AccessToken 校验，
 *      面板门禁只管"面板自己的接口与被代理的源配置页"。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./paths');
const settings = require('./settings');

const FILE = path.join(DATA_DIR, 'auth.json');
/** 默认密码：**首次使用时才写进 auth.json 的哈希**，之后随便改（README 里也提了这句） */
const DEFAULT_PASSWORD = '123456';
/** 新密码下限（默认密码 6 位，故下限取 6） */
const MIN_LEN = 6;
/**
 * 会话有效期：**默认 15 分钟、上限 30 天**（单位分钟，可在「面板设置 → 安全」里改）。
 * 语义是**滑动过期**（空闲计时）—— 从"最后一次使用"起算，一直在用就自动顺延，
 * 空闲满这一时长才失效，而不是到点强制退出（实现见下面的 guard）。
 */
const DEFAULT_SESSION_MIN = 15;
const MAX_SESSION_MIN = 30 * 24 * 60;
const COOKIE = 'mbp_panel';
/** 失败节流：连续 5 次 → 锁 60 秒（同一 IP） */
const MAX_FAILS = 5;
const LOCK_MS = 60 * 1000;

/* ---------------------------------------------------------------- 外部访问令牌
 *
 * 给**跑在面板进程之外的程序**用（例如装在 FW/Rex 播放器里的 output 插件 JS）：
 * 它们没有浏览器会话 cookie，只有自己声明的静态 HTTP 能力，访问面板必须有个凭证。
 *
 * 与登录密码的区别：
 *   · 密码 = 人用浏览器登面板（换发签名会话 cookie）；
 *   · 令牌 = 外部程序调插件 ingress 数据接口（query `?token=` 或 `Authorization: Bearer`）。
 * 令牌只能碰到**插件自己在 plugin.json 里声明 `ingress.token` 的那些路径**，
 * 碰不到别的面板接口（见 modules/plugin/ingress.js）。
 *
 * 落在同一份 auth.json（同样**不进 settings 备份明文面**的口径与密码一致；它本就是凭证）：
 *   { …, ingressToken: "mbp_<48 字符随机>" }
 * 懒生成：没人用就一直没有；`重置`后老令牌立即失效。
 */
const INGRESS_PREFIX = 'mbp_';

/* ---------------------------------------------------------------- 密码哈希 */

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(pw, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, want] = parts;
  let got;
  try {
    got = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  } catch {
    return false;
  }
  const a = Buffer.from(got, 'hex');
  const b = Buffer.from(want, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------------------------------------------------------- 落盘 */

let cache = null;

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && raw.passwordHash && raw.secret) {
      cache = {
        passwordHash: String(raw.passwordHash),
        secret: String(raw.secret),
        updatedAt: Number(raw.updatedAt) || 0,
        ingressToken: raw.ingressToken ? String(raw.ingressToken) : '',
      };
      return cache;
    }
  } catch {
    /* 没有 / 读坏了 → 下面按默认密码建一份 */
  }
  cache = { passwordHash: hashPassword(DEFAULT_PASSWORD), secret: crypto.randomBytes(32).toString('hex'), updatedAt: Date.now(), ingressToken: '' };
  save(cache);
  console.log(`  🔑 面板鉴权：已初始化（默认密码 ${DEFAULT_PASSWORD} —— 请尽快在「面板设置」里改掉）`);
  return cache;
}

function save(next) {
  cache = next;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

/** 现在还在用默认密码吗（前端拿它显示提醒；不泄露密码本身） */
function isDefaultPassword() {
  return verifyPassword(DEFAULT_PASSWORD, load().passwordHash);
}

/** 改密码：先验旧的。返回 {ok} 或 {error} */
function setPassword(oldPw, newPw) {
  const cur = load();
  if (!verifyPassword(oldPw, cur.passwordHash)) return { error: '当前密码不对' };
  const next = String(newPw || '');
  if (next.length < MIN_LEN) return { error: `新密码至少 ${MIN_LEN} 位` };
  if (next === DEFAULT_PASSWORD) return { error: '新密码不能和默认密码一样' };
  if (verifyPassword(next, cur.passwordHash)) return { error: '新密码和当前密码一样' };
  save({ passwordHash: hashPassword(next), secret: cur.secret, updatedAt: Date.now(), ingressToken: cur.ingressToken || '' });
  return { ok: true };
}

/* -------------------------------------------------------- 外部访问令牌 */

function mintIngressToken() {
  return INGRESS_PREFIX + crypto.randomBytes(24).toString('hex');
}

/** 取外部访问令牌；**懒生成**（第一次要时才写进 auth.json） */
function getIngressToken() {
  const cur = load();
  if (!cur.ingressToken) {
    cur.ingressToken = mintIngressToken();
    save(cur);
    console.log('  🔑 已生成外部访问令牌（output 插件等外部程序用；可在插件设置页重置）');
  }
  return cur.ingressToken;
}

/** 重置：老令牌立即失效，回新令牌 */
function resetIngressToken() {
  const cur = load();
  cur.ingressToken = mintIngressToken();
  save(cur);
  console.log('  🔑 外部访问令牌已重置（旧令牌立即失效）');
  return cur.ingressToken;
}

/** 常量时间比对一个外部令牌（空令牌一律不认） */
function verifyIngressToken(t) {
  const want = load().ingressToken;
  const got = String(t || '');
  if (!want || !got) return false;
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * 从请求里取外部令牌：`?token=` 或 `Authorization: Bearer …`（也认 `X-Access-Token`）。
 * query 优先 —— 跑在播放器里的脚本拼 URL 最省事。
 */
function ingressTokenOf(req, searchParams) {
  const q = searchParams && typeof searchParams.get === 'function' ? String(searchParams.get('token') || '') : '';
  if (q) return q;
  const authz = String((req.headers && req.headers.authorization) || '');
  const m = /^Bearer\s+(.+)$/i.exec(authz.trim());
  if (m) return m[1].trim();
  return String((req.headers && req.headers['x-access-token']) || '').trim();
}

/* ---------------------------------------------------------------- 会话 */

/** 密码哈希的指纹：进签名载荷 —— 一改密码，所有旧 cookie 立刻失效 */
function pvOf() {
  return crypto.createHash('sha256').update(load().passwordHash).digest('hex').slice(0, 16);
}

function sign(payload) {
  return crypto.createHmac('sha256', load().secret).update(payload).digest('base64url');
}

/**
 * 给**面板自己发出去的子地址**签名（与上面会话签名的用途完全不同，故加前缀隔离）。
 *
 * 用在哪：`playVia:'proxy'` 的 HLS 清单要中继，而清单里的分片地址**得改成面板自己的地址**
 * 才能给每一发分片带上鉴权头（见 modules/agg/stream.js）。这一发**不看会话 cookie、也不认 token** ——
 * 唯一的凭证就是这道签名；没有它，那个端点就是一个人人可用的**开放代理**（拿别人的面板当跳板）。
 *
 * ⚠️ 签名过了只是第一关：面板还得凭地址里的 `sid` 去**内存**那份 `sid → 鉴权头` 表里取头
 * （见 modules/agg/stream.js 的 `getPart`）。那张表是进程内的，所以面板重启后旧子地址取不到头、
 * 按 410 回 —— 客户端重取一次清单即可。
 *
 * 密钥用面板自己的 `secret`，重启不换、改密码不换。
 */
function signStreamPart(payload) {
  return crypto.createHmac('sha256', load().secret).update('seg:' + String(payload)).digest('base64url');
}

/** 验上面那道签名（长度不等直接否，再常量时间比对） */
function verifyStreamPart(payload, mac) {
  const want = signStreamPart(payload);
  const a = Buffer.from(String(mac || ''));
  const b = Buffer.from(want);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* -------------------------------------------- 会话有效期（可配 · 滑动过期） */

/**
 * 当前会话有效期（分钟）：读「面板设置 → 安全」的 `sessionMinutes`。
 *
 * 缓存一份在内存里 —— `guard` 每个请求都要用，而 `settings.read` 每次同步读盘。
 * 改设置由 panel 模块的 `onSettingsChange` 调 `invalidateTtl()` 失效（见 modules/panel/index.js）。
 * 读不到 / 越界一律退回默认 15 分钟（不让一个坏值把时长搞成 0 或无限）。
 */
let ttlCache = null;

function sessionMinutes() {
  if (ttlCache === null) {
    let m = DEFAULT_SESSION_MIN;
    try {
      const v = Number((settings.read('panel') || {}).sessionMinutes);
      if (Number.isFinite(v) && v >= 1 && v <= MAX_SESSION_MIN) m = Math.floor(v);
    } catch {
      m = DEFAULT_SESSION_MIN;
    }
    ttlCache = m;
  }
  return ttlCache;
}

function ttlMs() {
  return sessionMinutes() * 60 * 1000;
}

/** 设置改了就失效缓存（由 panel 模块的 onSettingsChange 调用） */
function invalidateTtl() {
  ttlCache = null;
}

function issueToken() {
  const now = Date.now();
  const payload = Buffer.from(JSON.stringify({ exp: now + ttlMs(), iat: now, pv: pvOf() }), 'utf8').toString('base64url');
  return payload + '.' + sign(payload);
}

/**
 * 验签 + 解出载荷（**不判过期**，也校验密码指纹）—— 坏 token 回 null。
 * `iat` 是签发时刻，`guard` 靠它判断够不够旧、要不要滑动续签。
 */
function readToken(token) {
  const s = String(token || '');
  const dot = s.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = s.slice(0, dot);
  const mac = s.slice(dot + 1);
  const want = sign(payload);
  if (mac.length !== want.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!o || o.pv !== pvOf()) return null;
    return o;
  } catch {
    return null;
  }
}

function verifyToken(token) {
  const o = readToken(token);
  return !!o && !!o.exp && o.exp >= Date.now();
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** 当前请求带的面板会话有效吗 */
function isAuthed(req) {
  return verifyToken(parseCookies(req)[COOKIE]);
}

function cookieHeader(token, req) {
  /* 只在**确实是 https** 时加 Secure —— 面板通常跑在局域网 http 上，
   * 加了 Secure 浏览器会直接丢掉这个 cookie，变成"登录了还是被拦"。 */
  const https = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  const base = `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`;
  return token ? `${base}; Max-Age=${Math.floor(ttlMs() / 1000)}${https ? '; Secure' : ''}` : `${base}; Max-Age=0${https ? '; Secure' : ''}`;
}

/* ---------------------------------------------------------------- 门禁 */

/**
 * 门禁规则。**方向很关键**：`/api/emby/*` 下绝大多数是 **Emby 客户端打的协议端点**
 * （客户端带着自己的 AccessToken），但有少数几条是**面板自己的管理端点** ——
 * 它们混在同一个前缀下，必须挑出来拦住：
 *
 *   `/api/emby/accounts*`      账号管理（增删改面板给客户端用的账号）
 *   `/api/emby/instances*`     Emby 实例管理（多实例：增删改、改端口、选首页插件、限定搜索域）
 *   `/api/emby/home-plugins`   可选首页插件清单（实例编辑弹窗的下拉用）
 *   `/api/emby/meta-domains`   可选元数据域清单（实例编辑弹窗的多选用）
 *
 * ⚠️ 后两条与 `accounts` 是同一类东西：**面板自用端点**，长在 Emby 前缀下只是因为它们
 * 操作的是 Emby 那摊东西（见 `emby/routes.js`）。它们由"实例化"新增 —— 实例端口那一侧
 * 由 `emby/listener.js` 的 PANEL_ONLY_RE 用同一份名单挡掉（客户端没有面板 cookie）。
 *
 * ⚠️ 原先还列着 `/api/emby/home/*`（老首页插件的上传/删除/改参数/逐行预览）——
 * 那条机制已随批次 9 整套删掉（首页插件的设置改在插件自带的 webui 里，
 * 走 `/api/plugins/…`，本来就受门禁），所以这条也去掉了。
 *
 * 为什么不反过来列"哪些放行"：客户端协议面很宽（Users/Items/Shows/videos/Images/…，
 * 还有那个专门记 501 的 `ANY /api/emby/*rest` 通配），漏一个就是**客户端直接 401**；
 * 而"面板自己那几条"是有限的、由本项目维护 —— 所以**默认放行、只拦这几条**。
 *
 * ⚠️ 已移除两条：元数据设置与测试那条（随插件化搬到**元数据插件自己的设置页**）
 * 与 `/api/emby/cache`（缓存跨两个库了，用量/清空搬到 `/api/panel/cache`）——
 * 而 `/api/panel/*` 本来就在下面那条"一律要登录"里，不必再列。
 */
const EMBY_PANEL_RE = [/^\/api\/emby\/accounts\b/, /^\/api\/emby\/instances\b/, /^\/api\/emby\/home-plugins\b/, /^\/api\/emby\/meta-domains\b/];

function needsAuth(pathname) {
  if (pathname.startsWith('/api/auth/')) return false; // 登录本身（还有 status/logout）
  /* 外部播放器的流入口（FW/Rex widget 等）**豁免 cookie 门禁** —— 它只有插件 ingress 令牌，
   * 没有浏览器会话；凭证由路由**自己验**：按坐标取地址那一发验 ingress 令牌，清单改写出来的
   * 子地址（`?seg=`）验面板签名（`signStreamPart`）。见 agg/routes.js 的 `/api/agg/stream`。 */
  if (pathname.startsWith('/api/agg/stream')) return false;
  if (pathname.startsWith('/api/emby/')) return EMBY_PANEL_RE.some((re) => re.test(pathname));
  /* ⚠️ 原先这里还带 `/website`：那是"配置中心同源代理"的路径，随源插件化去掉了
   * （配置中心现在由插件的设置页直连实例端口，不再过面板）。 */
  return pathname.startsWith('/api/');
}

const fails = new Map(); // ip → { n, until }

function clientIp(req) {
  return String((req.socket && req.socket.remoteAddress) || '');
}

/**
 * 拦一道：需要鉴权且没通过 → 返回一句给前端看的错误（调用方回 401）；通过 → null。
 *
 * 通过时顺带做**滑动续期**：够旧的会话（已用掉有效期的 1/4，或旧 token 没有 `iat`）
 * 就重签一枚、回写 `Set-Cookie` —— 这样"一直在用"就不过期，只有**空闲满时长**才失效。
 * 未通过时不在这里清 cookie（那由调用方做，见 server.js），免得和续签逻辑混在一起。
 *
 * 只有一处调用点：`server.js` 在处理 `/api/*` 之前。原先还有个 `force` 选项，
 * 是给"配置中心的兜底转发"用的（那些路径不在名单里，只能一律要登录）——
 * 那条兜底随源插件化去掉了（配置中心由插件设置页直连实例端口），这个选项也一起删掉。
 */
function guard(req, res, pathname) {
  if (!needsAuth(pathname)) return null;
  const payload = readToken(parseCookies(req)[COOKIE]);
  if (!payload) return '需要登录面板（浏览器里打开面板登录一次即可；接口调用请先登录拿 cookie）';
  const now = Date.now();
  if (!(payload.exp > now)) return '会话已过期，请重新登录';
  /* 够旧就续签：活跃则一直有效，空闲满时长才失效。 */
  const iat = Number(payload.iat) || 0;
  if ((!iat || now - iat > ttlMs() / 4) && res && typeof res.setHeader === 'function') {
    res.setHeader('Set-Cookie', cookieHeader(issueToken(), req));
  }
  return null;
}

/** 登录尝试的节流（同一 IP 连续失败就锁一会儿）—— 返回剩余秒数，0 = 可以试 */
function lockedFor(ip) {
  const hit = fails.get(ip);
  if (!hit || !hit.until) return 0;
  const left = Math.ceil((hit.until - Date.now()) / 1000);
  if (left <= 0) {
    fails.delete(ip);
    return 0;
  }
  return left;
}

function noteFail(ip) {
  const hit = fails.get(ip) || { n: 0, until: 0 };
  hit.n += 1;
  if (hit.n >= MAX_FAILS) {
    hit.until = Date.now() + LOCK_MS;
    hit.n = 0;
  }
  fails.set(ip, hit);
  return hit.until ? Math.ceil(LOCK_MS / 1000) : 0;
}

function noteOk(ip) {
  fails.delete(ip);
}

/** 登录：对 → 回 token；错 → 回 {error}（带节流） */
function login(req, password) {
  const ip = clientIp(req);
  const lock = lockedFor(ip);
  if (lock) return { error: `试错太多次，请 ${lock} 秒后再试`, locked: lock };
  if (!verifyPassword(password, load().passwordHash)) {
    const locked = noteFail(ip);
    console.log(`  ✘ 面板登录失败（ip=${ip}）${locked ? ` —— 已锁定 ${locked} 秒` : ''}`);
    return { error: '密码不对' };
  }
  noteOk(ip);
  console.log(`  ✔ 面板登录成功（ip=${ip}）`);
  return { token: issueToken() };
}

module.exports = {
  DEFAULT_PASSWORD,
  MIN_LEN,
  DEFAULT_SESSION_MIN,
  MAX_SESSION_MIN,
  needsAuth,
  guard,
  isAuthed,
  sessionMinutes,
  invalidateTtl,
  parseCookies,
  isDefaultPassword,
  setPassword,
  login,
  logout: () => ({ token: '' }),
  cookieHeader,
  issueToken,
  COOKIE,
  getIngressToken,
  resetIngressToken,
  verifyIngressToken,
  ingressTokenOf,
  signStreamPart,
  verifyStreamPart,
};
