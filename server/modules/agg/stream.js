'use strict';
/**
 * agg 流入口：把源插件给的地址交给**面板之外的客户端**（FW/Rex widget、播放器、…）。
 *
 * 为什么需要它：插件契约的 `http` 动作出参只有 `{status?, body, contentType?}`，**带不出
 * `Location` 头** —— 所以插件自己没法 302（见 docs/plugin-contract.md 的 contract-source.md）。外部播放器
 * 又只拿得到一串面板地址，于是"怎么把地址交出去"这一步只能由面板做。
 *
 * 落法**只按契约里的 `playVia` 声明**（第五节；缺省 `client`），分两档：
 *
 *   · `client` —— 地址**裸用可播**，面板不碰字节：
 *       - 非 HLS（mp4/mkv/…） → **302**，只回一个 `Location`，字节全在源与客户端之间跑；
 *       - `.m3u8` 清单        → **200 中继**：取回、相对补绝对、原样回。清单不能 302 ——
 *         相对地址按客户端最初请求的那条 URL 补全，一跳过去就拼到面板身上了（实测 501；
 *         依据见面板 docs/adr/0040）。取不回来就如实退回 302，与改前一致、至少不变差。
 *
 *   · `proxy` —— 地址**必须带一串鉴权头才播得动**，而外部客户端带不了那些头 ⇒ 面板**代持头**：
 *       - 非 HLS → 取字节回给客户端：**先探总长，再按块切、多路并发发有界 Range**（见
 *         `relayBytes`；网盘 CDN 按 Range 形态限速，开放式 `bytes=0-` 只有 ~0.1MB/s）；
 *         探不出总长 / 上游不认 Range 就退回单连接原样透传（`relayPipe`，与改前一致）；
 *       - HLS 清单 → 取回后把**清单里每个地址**改写成面板自己的子地址（`?seg=…`，见下），
 *         客户端再来取时由面板带头发给上游 —— 不给分片带头，清单拿回来也播不了。
 *
 * ⚠️ **判据只能是声明，不看 `header` 是否非空**：源顺手给的头可能只是信息性的（实测 missav
 * 给了头、302 照样能播）。按事实反推 = 面板替插件纠错，契约里明确不这么做（漏标由插件自负）。
 *
 * 面板**不解释** `ref`（由源插件编），也不判断"这条线路要不要头" —— 那由出口插件按
 * `playVia` 决定：要头又不想走面板的，自己 `POST /api/agg/play` 拿头和地址直连（FW/Rex 就这么走）。
 */

const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { sendBuffer, sendError, encodeLocation } = require('../../core/http');
const auth = require('../../core/auth');
const settings = require('../../core/settings');
const api = require('./api');

/**
 * 清单单次最多读多少字节 —— 分片是兆级的，超了就不是清单。
 *
 * ⚠️ 原定 256KB，**实测不够**：夸克**转码档**给的是**整片 VOD 清单**（每片几秒一条分片行），
 * 一部剧的 4K 转码清单就有 **≈295KB**（实测 `content-length: 301863`），一读就撞上限、播放全挂。
 * 真正的判据是开头的 `#EXTM3U`（见下），字节上限只用来挡住"把媒体文件当清单读进内存"，
 * 放大到 2MB 既不误伤整片清单，也仍然远小于任何媒体分片。
 */
const PLAYLIST_MAX_BYTES = 2 * 1024 * 1024;
/** 取清单的超时（客户端在等这一跳，不能久留） */
const PLAYLIST_TIMEOUT_MS = 15000;
/** 回给客户端的清单 MIME（HLS 规范写的那个） */
const PLAYLIST_MIME = 'application/vnd.apple.mpegurl';

/* --------------------------------------------------------------- 落法判断 */

/**
 * 这份地址该怎么交给客户端 —— **内核里唯一的那个判断**，emby 层与 agg 层共用同一份。
 *
 * @param {{url: string, playVia?: string}} o
 * @returns {'redirect'|'playlist'|'relay'|'relay-playlist'}
 *   302 / 200 清单中继（补绝对）/ 面板代持头中继（字节）/ 面板代持头中继（清单）
 */
function planStream(o) {
  const playlist = isPlaylistUrl(String((o && o.url) || ''));
  if (String((o && o.playVia) || 'client') !== 'proxy') return playlist ? 'playlist' : 'redirect';
  return playlist ? 'relay-playlist' : 'relay';
}

/* --------------------------------------------------------------- 清单工具 */

/** 这份地址是不是 HLS 清单。**只看路径后缀**（`.m3u8`，query 里带 token 的照样算） */
function isPlaylistUrl(u) {
  try {
    return /\.m3u8$/i.test(new URL(u).pathname);
  } catch {
    return false;
  }
}

/**
 * 地址 → **绝对的 http(s) 形式**；不该动的返回空串（表示"这一处不动"）。
 *
 *   · 相对地址（含 `//host/path` 这种协议相对的）→ 按 `base` 补全；
 *   · **已经是 http(s) 的 → 返回其自身**（⚠️ 不能当"不用动"丢掉：`proxy` 档要把清单里
 *     **每一个**地址都换成面板子地址，绝对地址同样得换 —— 否则那种分片不带鉴权头，必播不了）；
 *   · 空串 / 非 http(s) 协议（`data:` / `skd:` 这类）/ 解析不了 → 空串，原样留着不猜。
 */
function absoluteUri(uri, base) {
  const s = String(uri || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '';
  try {
    return new URL(s, base).toString();
  } catch {
    return '';
  }
}

/**
 * 把清单里所有**地址**改一遍，其余一行不动。
 *
 * 两种都算地址：
 *   · 非 `#` 开头的整行（master 的变体行、媒体清单的分片行）；
 *   · 标签里 `URI="…"` 的值（`#EXT-X-KEY` / `#EXT-X-MAP` / `#EXT-X-MEDIA` /
 *     `#EXT-X-I-FRAME-STREAM-INF` / `#EXT-X-PART` …）—— 规范里这些 URI 都带引号。
 * 其它标签（`#EXT-X-TOKEN` 这种非标准的也在内）**原样保留**；认不出的地址（非 http(s) 协议 /
 * 解析不了）原样留着，不猜、不把清单改坏。
 *
 * ⚠️ 已经是绝对的 http(s) 地址**也走 `map`**（相对地址先补绝对）—— `proxy` 档要把清单里
 * **每一个**地址都换成面板子地址，绝对地址漏掉就带不上鉴权头。
 *
 * @param base 清单**最终**的地址（跟随过跳转的那个）—— 相对地址是相对它算的
 * @param map  可选：`(绝对地址) => 新地址`（`client` 档不传 = 只补绝对；`proxy` 档传 = 换成面板子地址）
 * @returns `{ text, count }`：`count` 是改了几处（只进日志）
 */
function rewriteUris(text, base, map) {
  let count = 0;
  const lines = String(text).split('\n').map((raw) => {
    const line = raw.replace(/\r$/, '');
    const s = line.trim();
    if (!s) return line;
    if (s.startsWith('#')) {
      return line.replace(/URI="([^"]*)"/g, (m, uri) => {
        const abs = absoluteUri(uri, base);
        if (!abs) return m;
        count++;
        return `URI="${(map && map(abs)) || abs}"`;
      });
    }
    const abs = absoluteUri(s, base);
    if (!abs) return line;
    count++;
    return (map && map(abs)) || abs;
  });
  return { text: lines.join('\n'), count };
}

/** 只把地址补成绝对（`client` 档的清单中继） */
function absolutizePlaylist(text, base) {
  return rewriteUris(text, base, null);
}

/**
 * 取回清单原文（**不落地、不缓存**）。三条硬约束：超时 / 边读边数超限即断 / 必须真以 `#EXTM3U` 开头。
 * 任一不满足 → 回 `{error}`（调用方按落法决定退回 302 还是如实报错）。
 */
async function fetchPlaylist(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PLAYLIST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: ctrl.signal });
    if (!res.ok) return { error: `上游 HTTP ${res.status}` };
    const chunks = [];
    let size = 0;
    let tooBig = false;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > PLAYLIST_MAX_BYTES) {
        tooBig = true;
        break; // ⚠️ 用 break（迭代器会 cancel 掉 body），别再 `ctrl.abort()`：
        //    那样抛出的 AbortError 会被下面的 catch 当成"超时"，把真实原因盖掉（实测踩过）。
      }
      chunks.push(Buffer.from(chunk));
    }
    if (tooBig) return { error: `响应超过 ${PLAYLIST_MAX_BYTES} 字节，不像是清单` };
    const text = Buffer.concat(chunks).toString('utf8');
    if (!/^\s*#EXTM3U/.test(text)) return { error: '取回的不是清单' };
    return { text, url: res.url || url };
  } catch (e) {
    const msg = e && e.name === 'AbortError' ? `取清单超时（${PLAYLIST_TIMEOUT_MS / 1000} 秒）` : String((e && e.message) || e);
    return { error: msg };
  } finally {
    clearTimeout(timer);
  }
}

/* ----------------------------------------------------------- 代持头中继 */

/**
 * 上游要的那串头只在这里落地 —— **不写进 URL**（Cookie/UA 进 URL 会超长、还会漏进日志与
 * 播放器的历史记录）。改出来的分片地址里只有一个签名与 `sid`，那串头按 `sid` 回这张表取。
 *
 * 只活在内存里、有 TTL 与条数上限：面板重启就没了（客户端重取一次清单即可）。
 */
const PART_TTL_MS = 6 * 3600 * 1000;
const PART_MAX = 256;
/** `sid → { headers, over, at }`（`over` = 这一份清单该用的搬运参数，可能就是空的） */
const parts = new Map();

function pruneParts() {
  const now = Date.now();
  for (const [k, v] of parts) {
    if (now - v.at > PART_TTL_MS) parts.delete(k);
  }
  while (parts.size > PART_MAX) parts.delete(parts.keys().next().value); // 先进先出
}

function putPart(headers, over) {
  pruneParts();
  const sid = crypto.randomBytes(9).toString('base64url');
  parts.set(sid, { headers: headers || {}, over: over || {}, at: Date.now() });
  return sid;
}

/**
 * 取回 `sid` 那一份（头 + 搬运参数）。**搬运参数跟着 `sid` 存**、不写进子地址：
 * 清单里的分片是客户端照着取的，URL 上多挂两个参数既没人保证带得回来，
 * 也平白把"这一份清单用什么参数搬"散到几十条地址上。
 */
function getPart(sid) {
  const key = String(sid || '');
  const hit = parts.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PART_TTL_MS) {
    parts.delete(key); // ⚠️ 删**键**：删 `hit` 是删值对象，条目会一直留在 Map 里（腾不出名额）
    return null;
  }
  hit.at = Date.now();
  return hit;
}

/**
 * 子地址 → 面板自己的地址。签名绑上 `sid`：拿着别人那串分片地址配一个自己编的 sid 也验不过。
 * 没有这道签名，这个端点就是**人人可用的开放代理**（见 core/auth.js 的 signStreamPart）。
 *
 * `path` = 子地址落在哪条流端点（缺省 `/api/agg/stream`）。Emby 层必须传 `/api/emby/stream`：
 * Emby 实例端口的监听**只收 `/api/emby/` 前缀**（见 `emby/listener.js`），清单改写出来的分片地址
 * 会被客户端打到实例端口上，指到 agg 那条会吃 404。两条端点只是路径不同，验签与中继同一份实现。
 */
function partLink(origin, url, sid, path) {
  const p = Buffer.from(String(url), 'utf8').toString('base64url');
  return `${origin}${path || '/api/agg/stream'}?seg=${p}.${auth.signStreamPart(sid + ':' + url)}&sid=${sid}`;
}

/** 验子地址，回真实地址（不合法回空串）。上限只防"超长串拿来塞爆日志/内存" */
function partUrl(seg, sid) {
  const s = String(seg || '');
  if (!s || s.length > 4096) return '';
  const dot = s.lastIndexOf('.');
  if (dot <= 0) return '';
  let url = '';
  try {
    url = Buffer.from(s.slice(0, dot), 'base64url').toString('utf8');
  } catch {
    return '';
  }
  if (!/^https?:\/\//i.test(url)) return '';
  if (!auth.verifyStreamPart(String(sid || '') + ':' + url, s.slice(dot + 1))) return '';
  return url;
}

/** 客户端访问面板用的来源（`Host` + 转发协议）—— 改出来的子地址必须是**绝对**的 */
function originOf(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  return `${proto}://${req.headers.host || ''}`;
}

/**
 * `proxy` 档的清单改写：**取回的鉴权头存进内存**，清单里每个地址换成面板自己的**签名子地址**。
 * 客户端照清单原样取每一发，头由面板补上（不带头，清单拿回来也播不了）。
 *
 * agg 流端点与 Emby 流端点共用这一份 —— 区别只有 `path`（子地址落在哪条流端点上）：
 * Emby 实例端口只收 `/api/emby/` 前缀，必须传 `/api/emby/stream`。
 *
 * @returns `{ text, count, sid }`：`count` 改了几处地址（只进日志），`sid` 进日志便于对账。
 */
function relayPlaylist(text, base, { origin, headers, path, over }) {
  const sid = putPart(headers, over);
  const fixed = rewriteUris(text, base, (abs) => partLink(origin, abs, sid, path));
  return { text: fixed.text, count: fixed.count, sid };
}

/* --------------------------------------------------------- 字节中继（分块并发） */

/**
 * 默认搬运参数 —— 16 路 / 512KB 一块。
 *
 * ⚠️ 为什么非得切块、还得并发：网盘 CDN **按 Range 的形态限速**（源插件 driver 里也实测记着）：
 *   · 开放式 `Range: bytes=0-`  → ~0.1MB/s；
 *   · 有界   `Range: bytes=N-M` → ~3.5MB/s。
 * 播放器发的多半是开放式（或干脆不带 Range），单连接原样透传正好撞在限速那一档上。
 * 切块并发不是为了"多开管子刷流量"，而是为了**让每一发都变成有界 Range**。
 */
const RELAY_DEFAULTS = { threads: 16, chunkKB: 512, timeout: 15000 };
/** 上限只防"参数填错把面板与上游打爆" */
const RELAY_MAX_THREADS = 32;
const RELAY_MIN_CHUNK_KB = 64;
const RELAY_MAX_CHUNK_KB = 8192;
/** 探测时先要多少字节（只为拿 `content-range` 里的总长，读完即断） */
const RELAY_PROBE_BYTES = 1024;
/** 首块自适应：播放器 `bytes=0-` 探测时，前 N 块用小尺寸
 *  （探测完读几百 KB 就 seek，大块全在飞浪费带宽，还拖慢首字节） */
const RELAY_HEAD_SMALL_COUNT = 4;
const RELAY_HEAD_SMALL_BYTES = 256 * 1024;
/** **慢判死**：一块从发起到数据读满的硬上限（对齐 media-bridge-relay 的 `CHUNK_TIMEOUT_MS`）。
 *  上游某块"慢但不挂"时，不再让按序吐块的那一处一直等它；到点就判这一块失败、走重试，
 *  别把后面所有块一起拖死。头部块用更短上限，卡住就尽快换路。 */
const RELAY_CHUNK_TIMEOUT_MS = 30000;
const RELAY_HEAD_CHUNK_TIMEOUT_MS = 10000;
/** **头部对冲**：前几块各发 2 路取先成功者（对齐 media-bridge-relay 的 `HEAD_HEDGE`），
 *  治起播被一过性拒连卡死 —— 起播 TTFB 就在这几块上。 */
const RELAY_HEAD_HEDGE = 2;
/** 取一块的重试节奏（对齐 media-bridge-relay：3 发，间隔 200/500ms） */
const RELAY_CHUNK_ATTEMPTS = 3;
const RELAY_CHUNK_RETRY_DELAYS = [200, 500];

/**
 * 搬运参数：**外部给的 > 面板设置 > 默认**。
 * 外部有两个来源，优先级 **拉流 URL 上的查询参数 > 源插件 `play` 返回里带的**（见 `mergeRelayOverrides`）。
 * 面板设置 `streamRelay.enabled` 是总开关：关掉整条退回单连接原样透传（便于对比与兜底）。
 */
function relayParams(over) {
  const o = over || {};
  let s = {};
  try {
    s = (settings.read('panel') || {}).streamRelay || {};
  } catch {
    s = {};
  }
  /* `undefined` / `null` / 空串都算"没给"，一律往下取（空串是设置页里最常见的"没填"） */
  const pick = (a, b, d) => {
    for (const v of [a, b]) {
      if (v !== undefined && v !== null && v !== '') return Number(v);
    }
    return d;
  };
  const clamp = (n, lo, hi, d) => (Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d);
  return {
    enabled: s.enabled !== false,
    threads: clamp(pick(o.threads, s.threads, RELAY_DEFAULTS.threads), 1, RELAY_MAX_THREADS, RELAY_DEFAULTS.threads),
    chunkKB: clamp(pick(o.chunkKB, s.chunkKB, RELAY_DEFAULTS.chunkKB), RELAY_MIN_CHUNK_KB, RELAY_MAX_CHUNK_KB, RELAY_DEFAULTS.chunkKB),
    timeout: RELAY_DEFAULTS.timeout,
  };
}

/**
 * **拉流地址上带的搬运参数**：`?threads=8&chunkKB=256`。
 *
 * 优先级最高 —— 这一发请求就是"这一次播放"，最贴近实际意图；不带就一路往下取
 * （源插件 `play` 返回 → 面板设置 → 默认）。取值不在这里校验：`relayParams` 的
 * `pick` 会把空串/null 当"没给"，`clamp` 会把越界值拉回合法区间。
 */
function urlRelayParams(req) {
  let q;
  try {
    q = new URL(String((req && req.url) || ''), 'http://placeholder').searchParams;
  } catch {
    return {};
  }
  return { threads: q.get('threads'), chunkKB: q.get('chunkKB') };
}

/**
 * 合并两处外部给的参数：`a`（拉流 URL）优先于 `b`（源插件 `play` 返回）。
 * 没给的键**不落进结果**，好让 `relayParams` 继续往下取面板设置与默认值。
 */
function mergeRelayOverrides(a, b) {
  const out = {};
  for (const k of ['threads', 'chunkKB']) {
    for (const src of [a, b]) {
      const v = src && src[k];
      if (v !== undefined && v !== null && v !== '') {
        out[k] = v;
        break;
      }
    }
  }
  return out;
}

/**
 * 解析客户端的 `Range` → `{start, end}`（**闭区间**，`end` 可以是 `Infinity`）。
 * 认不出（多段 `0-99,200-299` / 非法写法）回 `null` —— 那就退回单连接原样透传，不猜。
 */
function parseRange(h) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(h || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') return { suffix: Number(m[2]) };
  return { start: Number(m[1]), end: m[2] === '' ? Infinity : Number(m[2]) };
}

/** 把客户端的 Range 落到**已知总长**上（`bytes=-N` 这种要总长才算得出起点） */
function resolveRange(want, total) {
  if (!want) return { start: 0, end: total - 1, ranged: false };
  if (want.suffix !== undefined) {
    const n = Math.max(0, Math.min(want.suffix, total));
    return { start: total - n, end: total - 1, ranged: true };
  }
  return {
    start: Math.min(want.start, total),
    end: want.end === Infinity ? total - 1 : Math.min(want.end, total - 1),
    ranged: true,
  };
}

/**
 * 探一发 `Range: bytes=0-1023`，只为拿总长与"认不认 Range"。**读完即断**，一个字节都不留。
 * 回 `null` = 上游不认 Range（回 200）或形状认不出 —— 调用方据此退回单连接透传。
 */
async function probeRange(url, headers) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RELAY_DEFAULTS.timeout);
  try {
    const res = await fetch(url, {
      headers: Object.assign({}, headers, { Range: `bytes=0-${RELAY_PROBE_BYTES - 1}` }),
      redirect: 'follow',
      signal: ctrl.signal,
    });
    /* ⚠️ 必须**先看状态再断流**：上游要是不认 Range，这一发回的是**整个文件**的 200，
     * 断得晚一点就是白拉几百兆。 */
    if (res.status !== 206) return null;
    if (res.body) {
      try {
        await res.body.cancel();
      } catch {
        /* 断不干净也不影响结果 */
      }
    }
    const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(res.headers.get('content-range') || '').trim());
    if (!m) return null;
    const total = Number(m[3]);
    if (!Number.isFinite(total) || total <= 0) return null;
    return { total, headers: res.headers };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取一块有界 Range，**不再抛错**，失败一律回 `{ error, status? }`（对齐 media-bridge-relay 的结果形状，
 * 调用方按"这一块失败"处理，而不是让一个异常掀翻整条流）。
 * 重试口径与 media-bridge-relay 一致：3 发、间隔 200/500ms；429/5xx 值得多试一发，
 * 其余 4xx 再确认一发就走，别对 404/403 白重试。
 */
async function fetchChunk(url, headers, start, end, signal, timeout, readTimeout) {
  let last = '';
  let status;
  for (let attempt = 0; attempt < RELAY_CHUNK_ATTEMPTS; attempt += 1) {
    if (attempt) await new Promise((r) => setTimeout(r, RELAY_CHUNK_RETRY_DELAYS[attempt - 1] || 500));
    if (signal.aborted) break;
    const got = await fetchOneChunk(url, headers, start, end, signal, timeout, readTimeout);
    if (got.buf) return got;
    last = got.error || '取块失败';
    status = got.status;
    /* 429 / 5xx 值得再试；其余 4xx 再试一发确认，仍不行就如实把状态带回去 */
    if (!/^(429|5\d\d)$/.test(String(got.status)) && attempt >= 1) return got;
  }
  return { error: last || '客户端已断开', status };
}

/**
 * 竞速取块：并发跑多个 `fetchChunk`，**第一个成功**的胜出（对齐 media-bridge-relay 的 `firstOk`）。
 * 全部失败 → `null`，调用方按失败处理。
 * ⚠️ 与 Worker 的一处差异：面板这边每发都要把块读满才 resolve，"输了的"那发掐不断，
 *    会白拉完这一块（只用在头部小块上，256KB 级，代价可接受）。
 */
function firstOk(promises) {
  return new Promise((resolve) => {
    let done = false;
    let failed = 0;
    const onSettle = (r) => {
      if (done) return;
      if (r && r.buf) {
        done = true;
        resolve(r);
        return;
      }
      failed += 1;
      if (failed === promises.length) {
        done = true;
        resolve(null);
      }
    };
    for (const one of promises) one.then(onSettle, () => onSettle(null));
  });
}

/**
 * 取一发有界 Range。**两级超时**（对齐 media-bridge-relay）：
 *   · `timeout` 只管连接与响应头 —— 头一到就撤掉，不再掐这一发；
 *   · `readTimeout` 管"数据读满" —— 慢但不挂的块到点判失败、走重试，而不是无限占着在飞窗口。
 * 非 206（上游不理会切块范围）与空块一律判失败并**掐掉响应体**，绝不把整片读进内存。
 */
async function fetchOneChunk(url, headers, start, end, signal, timeout, readTimeout) {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    let res;
    try {
      res = await fetch(url, {
        headers: Object.assign({}, headers, { Range: `bytes=${start}-${end}` }),
        redirect: 'follow',
        signal: ctrl.signal,
      });
    } finally {
      /* 头到手就不再掐连接，接下来交给 readTimeout 判"读得完读不完" */
      clearTimeout(timer);
    }
    if (res.status !== 206) {
      /* 探针已确认上游认 Range，中途回 200 属异常：**先掐再判**，免得把整片读进来 */
      if (res.body) {
        try {
          await res.body.cancel();
        } catch {
          /* 断不干净也不影响结果 */
        }
      }
      return { error: `上游 HTTP ${res.status}`, status: res.status };
    }
    let readTimer = null;
    try {
      const buf = Buffer.from(
        await Promise.race([
          res.arrayBuffer(),
          new Promise((_, reject) => {
            readTimer = setTimeout(() => reject(new Error(`chunk timeout (${readTimeout}ms)`)), readTimeout);
          }),
        ]),
      );
      if (!buf.length) return { error: '上游回空块' };
      return { buf };
    } catch (e) {
      try {
        /* 必须 await：取消一个已被 reader 占住的流回的是**被拒的 Promise**（非同步抛错），
         * 不 await 就会漏成"未处理的 Promise 拒绝"（readTimeout 先到、arrayBuffer 还占着锁时就是这种）。 */
        await res.body.cancel();
      } catch {
        /* 无所谓 */
      }
      return { error: String((e && e.message) || e) };
    } finally {
      clearTimeout(readTimer);
    }
  } catch (e) {
    return { error: String((e && e.message) || e) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 分块并发中继：按 `chunkKB` 切块、**保持 `threads` 路在飞**，完成块**按序**写回客户端。
 * 内存里只留一个滚动窗口（`threads × chunkKB`），不留整片；背压交给 `pipeline`。
 * 客户端断开 → 整个窗口的上游连接一起断。
 *
 * 首块自适应：探测式请求（`bytes=0-`，或无 Range 从头全量）的前 4 块用 256KB ——
 * 播放器起播常发开放式 Range 探测，读几百 KB 就 seek；小块早吐字节，起播更快、少浪费在飞数据。
 *
 * 慢判死 / 头部对冲 / 重试口径**对齐 media-bridge-relay**（见各 `RELAY_*` 常量注释）：
 * 前 4 块各发 2 路竞速取先成功者；每块有硬超时（头部 10s / 普通 30s），慢块判失败走重试，
 * 不再让按序等它的那一步无限期挂着。
 */
async function relayChunked(req, res, { url, headers, label, probe, p }) {
  const head = String(req.method || 'GET').toUpperCase() === 'HEAD';
  const { total } = probe;
  const r = resolveRange(parseRange(req.headers.range), total);
  if (r.end < r.start) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}`, 'Cache-Control': 'no-store' });
    return res.end();
  }
  const out = { 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes', 'Content-Length': String(r.end - r.start + 1) };
  for (const k of ['content-type', 'etag', 'last-modified']) {
    const v = probe.headers.get(k);
    if (v) out[k] = v;
  }
  if (r.ranged) out['Content-Range'] = `bytes ${r.start}-${r.end}/${total}`;
  const status = r.ranged ? 206 : 200;
  console.log(`  ⇄ 中继 ${label || ''} → ${status}（${p.chunkKB}KB × ${p.threads} 路，共 ${total} 字节）`);
  res.writeHead(status, out);
  if (head) return res.end();

  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());

  /* 切块边界：探测式请求前 N 块小尺寸，其余正常 chunkSize */
  const isProbe = req.headers.range === 'bytes=0-' || (!req.headers.range && r.start === 0);
  const chunkSize = p.chunkKB * 1024;
  const bounds = [];
  let pos = r.start;
  while (pos <= r.end) {
    const size = isProbe && bounds.length < RELAY_HEAD_SMALL_COUNT ? RELAY_HEAD_SMALL_BYTES : chunkSize;
    const end = Math.min(pos + size - 1, r.end);
    bounds.push([pos, end]);
    pos = end + 1;
  }
  const count = bounds.length;
  const pending = new Map();
  let launched = 0;
  let bytes = 0;
  /* 只在"窗口没满"时补发：已下完但还没轮到的块最多 `threads` 个，内存因此有界。
   * ⚠️ 每块都要**挂一个空 catch**：客户端断开时窗口里的块会被一起 abort，而那些块
   * 未必轮到被 `await` —— 不挂就是把它们的 rejection 变成"未处理的 Promise 拒绝"（实测会直接
   * 掀掉进程）。`await` 那一处照旧能拿到错误，不受影响。 */
  const launch = () => {
    while (launched < count && pending.size < p.threads) {
      const i = launched;
      launched += 1;
      const [a, b] = bounds[i];
      /* 头部块：更短的读满超时 + 2 路对冲；其余块单发 */
      const isHead = i < RELAY_HEAD_SMALL_COUNT;
      const readTimeout = isHead ? RELAY_HEAD_CHUNK_TIMEOUT_MS : RELAY_CHUNK_TIMEOUT_MS;
      const one = isHead
        ? firstOk(
            Array.from({ length: RELAY_HEAD_HEDGE }, () =>
              fetchChunk(url, headers, a, b, ctrl.signal, p.timeout, readTimeout),
            ),
          )
        : fetchChunk(url, headers, a, b, ctrl.signal, p.timeout, readTimeout);
      one.catch(() => {});
      pending.set(i, one);
    }
  };
  launch();
  const body = Readable.from((async function* chunks() {
    try {
      for (let i = 0; i < count; i += 1) {
        const one = pending.get(i);
        pending.delete(i);
        const got = await one;
        if (!got || !got.buf) {
          /* 重试仍失败 / 超时：如实收场。客户端已断开就别再往死连接上写。 */
          throw new Error(`第${i + 1}块取失败：${(got && got.error) || '未知'}`);
        }
        bytes += got.buf.length;
        yield got.buf;
        launch(); // 吐出去一块，才补发下一块 —— 窗口恒定
      }
    } finally {
      ctrl.abort(); // 收尾 / 客户端断开，窗口里的上游连接一起断
    }
  })());
  res.on('close', () => {
    if (bytes) console.log(`  ⇄ 中继结束 ${label || ''}：搬了 ${(bytes / 1048576).toFixed(1)}MB（${p.chunkKB}KB × ${p.threads} 路）`);
  });
  try {
    await pipeline(body, res);
  } catch (e) {
    if (!ctrl.signal.aborted) console.log(`  ⇄ 中继中断 ${label || ''}：${String((e && e.message) || e)}`);
    res.destroy();
  }
}

/**
 * 单连接原样透传（**兜底**：面上游不认 Range / 探不出总长 / 总开关关掉时走这条）。
 * 三条口径：
 *   · 只搬运：不自攒缓冲、不做分块并发，靠背压限流；
 *   · **Range / 206 / 416 原样透传**：不给 seek 添乱，也不自己算长度；
 *   · 客户端断开就把上游一起断（否则连接挂在面板上直到超时）。
 */
async function relayPipe(req, res, { url, headers, label }) {
  const method = String(req.method || 'GET').toUpperCase();
  const send = method === 'HEAD' || method === 'GET' ? method : 'GET';
  const want = Object.assign({}, headers || {});
  if (req.headers.range) want.Range = req.headers.range;

  let up;
  try {
    up = await fetch(url, { method: send, headers: want, redirect: 'follow' });
  } catch (e) {
    return sendError(res, 502, `中继取流失败：${String((e && e.message) || e)}`);
  }
  /* 200/206 才算取到；416（越界）也如实回，让播放器自己收场 */
  if (up.status !== 200 && up.status !== 206 && up.status !== 416) {
    return sendError(res, 502, `中继取流失败：上游 HTTP ${up.status}`);
  }

  const out = { 'Cache-Control': 'no-store' };
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = up.headers.get(k);
    if (v) out[k] = v;
  }
  console.log(`  ⇄ 中继 ${label || ''} → ${up.status}（${up.headers.get('content-type') || '?'}，带 ${Object.keys(want).filter((k) => k.toLowerCase() !== 'range').length} 个头）`);
  res.writeHead(up.status, out);
  if (!up.body) return res.end();

  let bytes = 0;
  const body = Readable.fromWeb(up.body);
  body.on('data', (c) => {
    bytes += c.length;
  });
  /* 客户端先走（换台 / 拖进度）→ 上游一起断，别把连接挂在面板上。
   * ⚠️ 挂在 **`res`** 上而不是 `req`：`req` 的 `close` 在"请求体读完"时就会发（GET 是空体，
   * 等于一开始就发），照它断流会把正常播放掐死在半路。`res` 的 `close` 才是"这一跳真的结束了"；
   * 正常播完时它也在 `end` 之后到，那时 `destroy()` 落在已结束的流上，无副作用。 */
  res.on('close', () => {
    body.destroy();
    if (bytes) console.log(`  ⇄ 中继结束 ${label || ''}：搬了 ${(bytes / 1048576).toFixed(1)}MB`);
  });
  body.on('error', () => res.destroy());
  return body.pipe(res);
}

/**
 * 外部字节代理链接：面板设置 `streamRelay.forwardEnabled` 打开就 302 过去，字节交给
 * 外部代理（Cloudflare Worker，见 https://github.com/dlushu/media-bridge-relay 仓库）搬，面板只发 302 不碰字节。
 *
 * 参数全部放 URL 上（**无状态**：面板重启/换机都不影响已发出去的链接，比 `sid` 内存表抗造）：
 *   · u  上游地址（base64url）
 *   · h  发给上游的请求头 JSON（base64url）—— Cookie 这串头只活在面板内存里，代理拿不到
 *        就取不动上游；进 URL 会留在代理的访问日志里，属外部代理模式的固有代价
 *   · s  HMAC-SHA256(面板 forwardSecret, u[.h])，配了 secret 才带 —— 代理验签防白嫖
 *   · threads / chunkKB  搬运参数照旧带上（`enabled` 关掉时不带 → 代理单连接透传，
 *     与内置开关的语义一致），面板设置页改了即生效
 *
 * 回 '' = 没配外部代理（或拼不出），调用方走面板内置中继。
 */
function forwardLink(url, headers, p) {
  let base = '';
  let secret = '';
  try {
    const s = (settings.read('panel') || {}).streamRelay || {};
    /* 外转有独立开关：forwardEnabled 没开，即使填了 URL 也不转（URL 留着不丢） */
    if (!s.forwardEnabled) return '';
    base = String(s.forwardUrl || '').trim().replace(/\/+$/, '');
    secret = String(s.forwardSecret || '').trim();
  } catch {
    return '';
  }
  if (!base) return '';
  const u = Buffer.from(String(url), 'utf8').toString('base64url');
  const h = headers && Object.keys(headers).length
    ? Buffer.from(JSON.stringify(headers), 'utf8').toString('base64url')
    : '';
  let link = `${base}?u=${u}`;
  if (h) link += `&h=${h}`;
  if (secret) link += `&s=${crypto.createHmac('sha256', secret).update(u + (h ? '.' + h : '')).digest('base64url')}`;
  if (p && p.enabled) link += `&threads=${p.threads}&chunkKB=${p.chunkKB}`;
  return link;
}

/**
 * 字节中继（对外唯一入口，`servePart` / agg 壳 / emby 路由都走它）。两条路：
 *   ① **分块并发**（默认）：探总长 → 有界 Range 切块并发 → 按序吐（`relayChunked`）；
 *   ② **单连接原样透传**（兜底）：总开关关掉、或上游不认 Range / 探不出总长（`relayPipe`）。
 * 走哪条只影响"怎么搬"，不影响 `playVia` 的落法判断（那在 `planStream`）。
 *
 * **外转优先**：设置里 `streamRelay.forwardEnabled` 打开就不自己搬 —— 直接 302 到外部代理
 * （参数见 `forwardLink`），面板从"搬运工"退成"发路条的"。
 *
 * 搬运参数**在这一处合并**：拉流 URL 上的 `?threads=&chunkKB=` 覆盖 `opts` 里那对
 * （源插件 `play` 返回 / 清单子地址记着的），不带就继续往下取面板设置与默认（见 `relayParams`）。
 * ⚠️ 合并要用 `mergeRelayOverrides`（"没给就不带这个键"）—— 直接 `Object.assign` 会让 URL 上
 * 缺席的那个键以 `null` 盖掉 `opts` 里的值，清单子地址存的那份就白存了（实测踩过）。
 */
async function relayBytes(req, res, opts) {
  const { url, headers, label } = opts || {};
  if (!url) return sendError(res, 502, '中继缺地址');
  const p = relayParams(mergeRelayOverrides(urlRelayParams(req), opts));
  const fwd = forwardLink(url, headers, p);
  if (fwd) {
    console.log(`  ⇄ 中继外转 ${label || ''} → 外部字节代理（302，${p.enabled ? `${p.threads} 路 / ${p.chunkKB}KB` : '透传'}）`);
    res.writeHead(302, { Location: fwd, 'Cache-Control': 'no-store' });
    return res.end();
  }
  try {
    if (!p.enabled) return await relayPipe(req, res, { url, headers, label });
    const probe = await probeRange(url, headers);
    if (!probe) return await relayPipe(req, res, { url, headers, label });
    return await relayChunked(req, res, { url, headers, label, probe, p });
  } catch (e) {
    if (res.headersSent) return res.destroy();
    return sendError(res, 502, `中继取流失败：${String((e && e.message) || e)}`);
  }
}

/* --------------------------------------------------------------- agg 壳 */

/**
 * 按 `{tpl 或 domain, ref}` 取地址并落到响应上。
 *
 * `clientHost` = 客户端访问面板用的主机名（请求的 `Host` 头）：本地部署的实例回的是回环
 * 地址，源插件拿它换成客户端够得着的那台机器（与 emby 层同一口径）。
 */
async function serveByRef(req, res, { domain, tpl, ref, playVia, clientHost }) {
  const out = await api.play({ domain, tpl, ref, clientHost });
  if (!out.ok) {
    const e = out.error || {};
    return sendError(res, e.status || 502, e.message || '取播放地址失败');
  }
  const play = out.play || {};
  const url = (play.urls || [])[0] || '';
  if (!url) return sendError(res, 502, '源没给出播放地址');
  if ((play.nonHttp || []).includes(url)) {
    return sendError(res, 501, '这条线路给的不是可直连地址（push:// 之类），暂不支持');
  }
  const headers = play.header || {};
  const label = `${String(playVia || 'client')}·${String(tpl || domain || '')}/${String(ref || '').slice(0, 12)}…`;
  const mode = planStream({ url, playVia });

  /* ⚠️ `Location` 里的非 ASCII 必须先编码（同 emby 层 `serveStream`）：HTTP 头只认 ASCII，
   * Node 碰上中文会直接抛 —— 那时状态行已经写了一半（实测源回带中文站名的地址会这样）。
   * 用 `encodeLocation` 而**不是** `encodeURI`：后者连 `%` 一起转义，会把源直链里
   * 已有的签名（`%3D`/`%2F`）编成 `%253D`，上游校验不过直接 400。 */
  if (mode === 'redirect') {
    res.writeHead(302, { Location: encodeLocation(url), 'Cache-Control': 'no-store' });
    return res.end();
  }
  /* `proxy` 的非清单地址**直接开搬**，别先去"取清单" —— 那会把一个分片当清单读满 256KB 再判错。
   * 搬运参数：拉流 URL 上的查询参数（`relayBytes` 里读）> 源插件在 `play` 里带的 > 面板设置 > 默认。 */
  if (mode === 'relay') {
    return relayBytes(req, res, { url, headers, label, threads: play.threads, chunkKB: play.chunkKB });
  }

  const got = await fetchPlaylist(url, headers);
  if (got.error) {
    /* `client` 档取不回清单就如实退回 302（与改前一致、至少不变差）；
     * `proxy` 档退回 302 等于把"要头的地址"丢给带不了头的客户端 —— 那是必然播不了的死路，
     * 不如如实报错，让日志里看得见原因。 */
    if (mode === 'playlist') {
      res.writeHead(302, { Location: encodeLocation(url), 'Cache-Control': 'no-store' });
      return res.end();
    }
    return sendError(res, 502, `中继取清单失败：${got.error}`);
  }

  if (mode === 'playlist') {
    const fixed = absolutizePlaylist(got.text, got.url);
    return sendBuffer(res, 200, Buffer.from(fixed.text, 'utf8'), PLAYLIST_MIME);
  }

  /* 分片地址改成面板自己的子地址 —— 客户端照清单原样取每一发，头由面板补上。
   * 搬运参数**在这一跳定下来**、跟着 `sid` 存：分片那几十发不再各自去猜用什么参数。 */
  const over = mergeRelayOverrides(urlRelayParams(req), play);
  const fixed = relayPlaylist(got.text, got.url, { origin: originOf(req), headers, over });
  console.log(`  ⇄ 中继清单 ${label}：${fixed.count} 个地址改成面板子地址（sid=${fixed.sid}）`);
  return sendBuffer(res, 200, Buffer.from(fixed.text, 'utf8'), PLAYLIST_MIME);
}

/**
 * `?seg=…&sid=…`：清单改写出来的**分片 / 子清单 / 密钥**地址。
 * 验签 → 取回那一份鉴权头与搬运参数 → 转发。密钥在面板自己的 `secret` 里，签名是唯一的凭证。
 */
async function servePart(req, res, { seg, sid }) {
  const url = partUrl(seg, sid);
  if (!url) return sendError(res, 403, '这个子地址的签名对不上（面板重启或换了密钥后请重取一次清单）');
  const part = getPart(sid);
  if (!part) return sendError(res, 410, '这串鉴权头已过期（面板重启或超过有效期），请重取一次清单');
  /* 参数跟着 `sid` 存（见 `getPart`）：那一份清单当初用什么参数搬，它的分片就用什么参数搬 */
  const over = part.over || {};
  return relayBytes(req, res, { url, headers: part.headers, label: `seg/${String(sid)}`, threads: over.threads, chunkKB: over.chunkKB });
}

module.exports = {
  /* 判落法（emby 层共用这一份，别再各写一遍） */
  planStream,
  isPlaylistUrl,
  /* 清单工具（emby 层共用） */
  fetchPlaylist,
  absolutizePlaylist,
  rewriteUris,
  PLAYLIST_MIME,
  /* 代持头中继（emby 层共用）：清单改写 + 子地址 + 字节搬运 */
  relayPlaylist,
  originOf,
  servePart,
  relayBytes,
  /* 搬运参数（emby 层也要读一遍拉流地址上那对，见 finishStream） */
  urlRelayParams,
  mergeRelayOverrides,
  /* agg 壳 */
  serveByRef,
};