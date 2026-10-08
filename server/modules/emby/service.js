'use strict';
/**
 * Emby 层服务：服务器标识、登录校验、用户资料、条目（元数据一律走插件，本层不认识具体域）
 *
 * 只做已实现端点所需的事：
 *   GET  /api/emby/System/Info/Public        握手：告诉客户端这是个 Emby 服务器
 *   GET  /api/emby/System/Info               完整服务器信息（**诚实子集**：只给面板真有的字段，见 systemInfo）
 *   POST /api/emby/Users/AuthenticateByName  登录：校验面板账号，发一个 AccessToken
 *   GET  /api/emby/Users/{UserId}            取用户资料（客户端登录后紧接着就会要）
 *   GET  /api/emby/Users/{UserId}/Views      媒体库列表（每个启用的插件行 = 一个库，见 getViews）
 *   GET  /api/emby/Users/{UserId}/Items      条目列表（**列表数据由首页模块决定**：认 ParentId=<库Id>；其余如实空，见 getItems）
 *   GET  /api/emby/Shows/{Id}/Seasons        剧的季列表（**占位**：元数据插件的 seasons[]，见 getSeasons）
 *   GET  /api/emby/Shows/{Id}/Episodes       某一季的分集列表（**占位**：元数据插件 season 接口，见 getEpisodes）
 *
 * 条目 Id 由「域坐标」派生（`{域}_{编号}_{tv|movie}[_s{n}]`，形状由 core/providers.js 统一规定），
 * 派生与解析是一对：metaBridge.itemId / metaBridge.parseItemId。域来自已装元数据插件的声明
 * （没有"默认域"，装哪个域就用哪个域）。
 * 元数据取数失败一律**照实回失败**（状态码与上游一致，网络层由 metaBridge.httpStatusOf 归类）—— 不编占位数据。
 *
 * 账号（**多账号**）：存 `data/emby/emby.db`（内置 sqlite，见 db.js），密码只存 scrypt 哈希；
 * 老的单账号（设置文件里的 `account.{username,password}` 明文）会在首次用到库时自动迁移并清明文。
 * UserId 仍由「serverId + 用户名」派生 —— 规则没变，多账号各自不同。
 * AccessToken 校验：登录时把 token 存进 `sessions` 表，之后各端点先过 `authorize()`
 * —— 无效/缺失一律 401，且 `UserId` 必须属于该 token 的账号。
 * 三种带法都认：`X-Emby-Token` / `Authorization`·`X-Emby-Authorization` 里的 `Token="…"` / query `api_key=`。
 * 改密或删账号会作废该账号的所有 token。豁免：握手、登录、面板自用端点、501 通配（图片端点将来也要豁免）。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib'); // 版本 Id 的载荷要压一道（客户端对 URL 长度有硬上限，见 mbpSourceId）
const metaBridge = require('./meta-bridge');
const agg = require('../agg/api'); // 聚合层的进程内调用面（原来是打自己的 /api/agg/*，会撞面板门禁 → 见那个文件顶部）
/* 拉流的**落法内核**（判 302 / 清单中继、清单改写工具）—— 与 agg 的流入口共用同一份，
 * 别再各写一遍（曾经就是逐行两份拷贝）。见 agg/stream.js 顶部。 */
const streamKernel = require('../agg/stream');
const BRAND = require('../../core/branding'); // 默认服务器名（客户端「服务器列表」里显示的那个）
const home = require('./home');
const db = require('./db');
const cache = require('./cache');
const instance = require('./instance'); // 当前请求属于哪个 Emby 实例（见 instance.js）
const subtitleBridge = require('./subtitle-bridge'); // 字幕插件转接处（tracks 聚合 / fetch 转插件动作）

/** 兼容目标版本：客户端按 Emby 的版本号判断能力，这里报一个常见的 Emby 4.8 */
const EMBY_VERSION = '4.8.0.0';

/**
 * 服务器 Id：**每个 Emby 实例各一个**，首次用到时生成一次并落到实例清单里，
 * 保证客户端缓存的服务器身份稳定（见 instance.identityOf）。
 */
function serverId() {
  return instance.identityOf().serverId;
}

/**
 * 当前实例允不允许下载 —— 实例级开关（见 instance.js），**默认开**。
 * 驱动三处：握手 `Policy.EnableContentDownloading`、条目 `CanDownload`、
 * `Items/{ItemId}/Download` 端点门禁，三处口径必须一致（说支持就得真给下）。
 */
function allowDownload() {
  const inst = instance.current();
  return !inst || inst.allowDownload === undefined ? true : !!inst.allowDownload;
}

/**
 * 用户 Id：由「服务器 Id + 用户名」派生，稳定且无需额外存储（多账号各自不同）。
 * 归一化走 db.normName —— 登录、查重、UserId 必须同一套规则，否则会出现
 * 「登录成功但 /Users/{id} 404」（用户名带大小写/全角时最明显）。
 */
function userId(username) {
  return crypto.createHash('md5').update(serverId() + '|' + db.normName(username)).digest('hex');
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * 按 UserId 反解账号 —— 多账号下 `assertUser` 靠它判断"这个 id 属于谁"。
 * 不把 user_id 存库：serverId 一变（重装/误删设置）库里那列就全废，现算永远自洽；
 * 账号数是个位数，逐个算 md5 可忽略。
 */
function resolveAccountById(requestedId) {
  const want = String(requestedId || '').toLowerCase();
  if (!want) return null;
  const sid = serverId(); // 循环外读一次，别每个账号都去读设置文件
  for (const acc of db.listAccounts()) {
    const id = crypto.createHash('md5').update(sid + '|' + db.normName(acc.username)).digest('hex');
    if (id === want) return acc;
  }
  return null;
}

/**
 * 取授权头里某个 `Key=值`。
 *
 * **真机对引号可选**（实测 nyamedia 4.8.0.62：`Client="Filmly"` 与 `Client=Filmly` 都 200），
 * 面板原先只认带引号的写法，客户端省掉引号就取不到 appName、登录被误判 400（真机反而放行）。
 * 故两种都收：优先带引号的整段，其次取到逗号为止（真机这串以逗号分隔字段，值里不含逗号）。
 * `Device` 不会误吃 `DeviceId=`（`Device` 后面是 `I` 不是 `=`）。
 */
function pickHeaderValue(text, key) {
  /* `text` 可能是 `undefined`：调用方（`tokenFrom`）按名字取头，缺哪个名字就是 `undefined`。
   * 直接 `undefined.match` 会把**整个请求**打成 500（只剩 `api_key`、不带 `X-Emby-Authorization`
   * 的客户端，实测就踩这条）—— 这里如实当"取不到"（Boundary 上的防御）。 */
  const m = String(text || '').match(new RegExp(key + '\\s*=\\s*(?:"([^"]*)"|([^",]*))', 'i'));
  if (!m) return '';
  return (m[1] !== undefined ? m[1] : m[2]).trim();
}

/** 解析客户端的 X-Emby-Authorization：MediaBrowser Client="…", Device="…", DeviceId="…", Version="…"（引号可省） */
function parseClientHeader(raw) {
  const out = { Client: '', Device: '', DeviceId: '', Version: '' };
  const text = String(raw || '');
  for (const key of ['Client', 'Device', 'DeviceId', 'Version']) {
    out[key] = pickHeaderValue(text, key);
  }
  return out;
}

/**
 * 取 URL query 里某个参数（字段名**大小写不敏感**，对齐真机 ASP.NET 的绑定口径）。
 *
 * Emby 允许客户端把 appName 放在 query（如 `?X-Emby-Client=…`）而不是授权头里 ——
 * 实测 Filmly / 网易爆米花就只发 query、头里**没有** `Client=`（见 docs/emby-realdevice/02-…）。
 * 面板原先只看头，遇到这类客户端把登录误判成「缺 appName」400；真机却放行。
 */
function queryParam(req, name) {
  const qs = String((req && req.url) || '');
  const start = qs.indexOf('?');
  if (start === -1) return '';
  const want = name.toLowerCase();
  for (const pair of qs.slice(start + 1).split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq === -1 ? pair : pair.slice(0, eq);
    let k = key;
    try {
      k = decodeURIComponent(key);
    } catch {
      /* 非法转义就按原样比 */
    }
    if (k.toLowerCase() !== want) continue;
    const val = eq === -1 ? '' : pair.slice(eq + 1);
    try {
      return decodeURIComponent(val.replace(/\+/g, ' '));
    } catch {
      return val;
    }
  }
  return '';
}

/**
 * 用户名的「首字母」—— 真机 `User.Prefix` 就是首字母大写（实测 `dlushu` → `D`），
 * 客户端在用户列表里按它分组/排序。空名回空串；取首个字符按码点取（别劈开代理对）。
 */
function prefixOf(username) {
  const s = String(username || '').trim();
  return s ? Array.from(s)[0].toUpperCase() : '';
}

/**
 * 默认头像（品牌图标）—— 所有用户共用同一张图：`assets/default-avatar.png`（606×606 透明底）。
 *
 * **懒读一次**：头像请求低频，不为它拖慢启动；读到后缓存字节与 tag。
 * tag = 文件内容的 md5 —— 形状与真机的 `PrimaryImageTag` 同款（32 位 hex，真机实测就是这种），
 * 而且**换图标文件 tag 就变**，客户端的图片缓存自动失效，不用手动管版本。
 * 文件缺失/读失败 → `{png:null}`，调用方回 404（不崩服务）。
 */
let brandAvatarCache;
function brandAvatar() {
  if (brandAvatarCache) return brandAvatarCache;
  try {
    const png = fs.readFileSync(path.join(__dirname, 'assets', 'default-avatar.png'));
    brandAvatarCache = { png, tag: crypto.createHash('md5').update(png).digest('hex') };
  } catch (e) {
    brandAvatarCache = { png: null, tag: '', error: e };
  }
  return brandAvatarCache;
}

/** 用户头像的 `PrimaryImageTag`（品牌图标的内容哈希；所有用户同值，见 brandAvatar） */
function userAvatarTag() {
  return brandAvatar().tag;
}

/**
 * 组装 UserDto —— 登录响应里的 User 与 GET /Users/{id} 返回的是同一个对象，
 * 共用这里以保证两处字段一致。
 *
 * **字段集与取值严格对齐真机样本**（OkEmby 4.9.1.90 实测，见 docs/emby-compat.md「十、#2」）：
 *   · 顶层只回真机那 13 个键；`HasConfiguredEasyPassword` / `EnableAutoLogin` 真机没有 → 删。
 *   · `Prefix` / `DateCreated` 真机有 → 补。
 *   · `PrimaryImageTag` / `PrimaryImageAspectRatio` 真机有 → 补（用部署者提供的
 *     品牌图标，见 `brandAvatar`；图标文件缺失时 tag 为空、不挂这两个键）。
 *   · `Configuration` 取真机那 15 个键（`SubtitleMode:'Smart'`，含 HidePlayedInMoreLikeThis /
 *     HidePlayedInSuggestions / ResumeRewindSeconds / IntroSkipMode；删掉真机没有的
 *     SubtitleLanguagePreference / GroupedFolders / DisplayCollectionsView）。
 *   · `Policy` 取真机那 44 个权限键，取值也照真机（非管理员、IsHidden、下载/转码/remux 全 false …）。
 */
function buildUser(username, account) {
  const now = new Date().toISOString();
  const u = {
    Name: username,
    ServerId: serverId(),
    Prefix: prefixOf(username),
    DateCreated: (account && account.created_at) || now,
    Id: userId(username),
    HasPassword: true,
    HasConfiguredPassword: true,
    LastLoginDate: (account && account.last_login_at) || now,
    LastActivityDate: now,
    Configuration: {
      PlayDefaultAudioTrack: true,
      DisplayMissingEpisodes: false,
      SubtitleMode: 'Smart',
      OrderedViews: [],
      LatestItemsExcludes: [],
      MyMediaExcludes: [],
      HidePlayedInLatest: true,
      HidePlayedInMoreLikeThis: false,
      HidePlayedInSuggestions: false,
      RememberAudioSelections: true,
      RememberSubtitleSelections: true,
      EnableNextEpisodeAutoPlay: true,
      ResumeRewindSeconds: 0,
      IntroSkipMode: 'ShowButton',
      EnableLocalPassword: false,
    },
    Policy: {
      IsAdministrator: false,
      IsHidden: true,
      IsHiddenRemotely: true,
      IsHiddenFromUnusedDevices: true,
      IsDisabled: false,
      LockedOutDate: 0,
      AllowTagOrRating: false,
      BlockedTags: [],
      IsTagBlockingModeInclusive: false,
      IncludeTags: [],
      EnableUserPreferenceAccess: true,
      AccessSchedules: [],
      BlockUnratedItems: [],
      EnableRemoteControlOfOtherUsers: false,
      EnableSharedDeviceControl: false,
      EnableRemoteAccess: true,
      EnableLiveTvManagement: false,
      EnableLiveTvAccess: true,
      EnableMediaPlayback: true,
      EnableAudioPlaybackTranscoding: false,
      EnableVideoPlaybackTranscoding: false,
      EnablePlaybackRemuxing: false,
      EnableContentDeletion: false,
      RestrictedFeatures: [],
      EnableContentDeletionFromFolders: [],
      /* 跟随实例级「下载」开关（默认开）；与条目 `CanDownload`、Download 端点同一口径 */
      EnableContentDownloading: allowDownload(),
      EnableSubtitleDownloading: false,
      EnableSubtitleManagement: false,
      EnableSyncTranscoding: false,
      EnableMediaConversion: false,
      EnabledChannels: [],
      EnableAllChannels: true,
      EnabledFolders: [],
      EnableAllFolders: true,
      InvalidLoginAttemptCount: 0,
      EnablePublicSharing: true,
      RemoteClientBitrateLimit: 0,
      AuthenticationProviderId: 'Emby.Server.Implementations.Library.DefaultAuthenticationProvider',
      ExcludedSubFolders: [],
      SimultaneousStreamLimit: 2,
      EnabledDevices: [],
      EnableAllDevices: true,
      AllowCameraUpload: false,
      AllowSharingPersonalItems: false,
    },
  };
  /* 头像两键随图标文件走：文件在就挂（方形图，比例 1）；读不到就不挂 ——
   * 不挂 tag 客户端不会去拉，显它自己的默认占位（见 brandAvatar）。 */
  const avatarTag = userAvatarTag();
  if (avatarTag) {
    u.PrimaryImageTag = avatarTag;
    u.PrimaryImageAspectRatio = 1;
  }
  return u;
}

/** GET /System/Info/Public —— 客户端握手 */
/**
 * 服务器名 —— 客户端「服务器列表」里显示的就是它。
 *
 * 默认 `BRAND.embyServerName`（core/branding.js），**每个实例一个名字**，在面板「Emby → 实例」
 * 里改（存实例清单 `data/emby/instances.json` 的 `name`，见 instance.js）。
 * **取不到 / 空 / 全空白就回默认值**：客户端拿空 ServerName 会显示成空白条目，比显示默认名更糟。
 * 长度上限在实例的 `validate` 里管（不在这一层兜）。
 */
function serverName() {
  return instance.identityOf().serverName;
}

/**
 * 字段集严格对齐**真机样本**（两台实测一致）：只回
 * `LocalAddresses` / `RemoteAddresses` / `ServerName` / `Version` / `Id` 五个字段。
 * 两个地址数组真机为空（面板同样不对外广播直连地址），客户端据此回落到当前连接地址；
 * 多出的 `LocalAddress` / `ProductName` / `OperatingSystem` / `StartupWizardCompleted` 已按真机删掉。
 */
function publicInfo() {
  return {
    LocalAddresses: [],
    RemoteAddresses: [],
    ServerName: serverName(),
    Version: EMBY_VERSION,
    Id: serverId(),
  };
}

/**
 * 本机入口地址 —— 从请求 `Host` 头取、去掉端口（与 routes.js 拼「连接地址」用的对外主机名同一份实现）。
 * 真机 `LocalAddress` 回的是服务器自己的内网 IP；面板不对外广播直连地址，照实回客户端连进来的那个主机名。
 * 取不到回环；IPv6 字面量（`[::1]:8096`）只取方括号里的部分。
 */
function hostOf(req) {
  const h = String((req && req.headers && req.headers.host) || '').trim();
  if (!h) return '127.0.0.1';
  if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1);
  return h.split(':')[0];
}

/**
 * 面板运行所在的操作系统 —— 照 Emby 的展示写法（真机样本为 `Linux`）。
 * Node 的 `process.platform` 取值（`linux` / `darwin` / `win32` …）与 Emby 不同，做一次映射；
 * 没覆盖到的平台原样回（照实，不编）。
 */
function operatingSystem() {
  const names = { linux: 'Linux', darwin: 'OSX', win32: 'Windows', freebsd: 'FreeBSD' };
  return names[process.platform] || process.platform;
}

/**
 * GET /System/Info —— 带 token 的完整服务器信息（客户端登录后拿它判断"这台服务器有哪些能力"）。
 *
 * **诚实子集**（取舍见 [ADR-0057](docs/adr/0057-emby-system-info-honest-subset.md) 与
 * docs/emby-realdevice/20-system-info.md）：端点认领，但字段**只给面板真有的** ——
 * 面板不是 Emby 服务端：本地媒体库扫描 / 转码 / 自重启 / 自更新 / Wake-on-LAN 一概没有，
 * 对应能力位**一律如实 `false`**；两个地址数组照 `publicInfo` 回空。
 * `WebSocketPortNumber` / `HttpServerPortNumber` / `HttpsPortNumber` / `SupportsLocalPortConfiguration` /
 * `WanAddress` / `SystemUpdateLevel` / `OperatingSystemDisplayName` / `HardwareAccelerationRequiresPremiere`
 * 这些面板**没有对应物**的字段**不回**（不编造数值），故字段集小于真机 4.8 的 25 个。
 */
function systemInfo(req) {
  return {
    /* 能力位：面板没有的能力一律如实 false（不是"关掉了"，是根本没有） */
    HasPendingRestart: false,
    IsShuttingDown: false,
    SupportsLibraryMonitor: false,
    CanSelfRestart: false,
    CanSelfUpdate: false,
    CanLaunchWebBrowser: false,
    SupportsHttps: false,
    HasUpdateAvailable: false,
    SupportsAutoRunAtStartup: false,
    /* 面板自己 */
    ServerName: serverName(),
    Version: EMBY_VERSION,
    Id: serverId(),
    OperatingSystem: operatingSystem(),
    /* 地址：入口主机名（请求 Host 去端口）+ 与握手同口径的空数组 */
    LocalAddress: hostOf(req),
    LocalAddresses: [],
    RemoteAddresses: [],
    CompletedInstallations: [],
  };
}

/**
 * 从请求里取客户端带来的 AccessToken —— Emby 客户端几种带法都认：
 *   ① 头 `X-Emby-Token`（绝大多数请求）
 *   ② 头 `X-Emby-Authorization` 里的 `Token="…"`（部分客户端把 token 塞进那串）
 *   ③ query `api_key=`（实测客户端拉直连流时是这个）
 *   ④ query `X-Emby-Token=`（部分客户端探测 / 拉流时把同一个 token 也塞进 query，**大小写照发**）
 */
function tokenFrom(req) {
  const h = (req && req.headers) || {};
  const direct = String(h['x-emby-token'] || '').trim();
  if (direct) return { token: direct, from: 'x-emby-token' };
  /* MediaBrowser / Emby 授权头：`Client="…", Device="…", Token="…"`（值引号可省，见 parseClientHeader）
   *   客户端实测发在 `X-Emby-Authorization`；官方文档写的是 `Authorization` —— 两个都看 */
  for (const name of ['x-emby-authorization', 'authorization']) {
    const v = pickHeaderValue(h[name], 'Token');
    if (v) return { token: v, from: name };
  }
  /* query 带法：`api_key` 是官方名，`X-Emby-Token` 是客户端把 token **照着头名**塞进 query 的写法。
   * ⚠️ `URLSearchParams` 的键**区分大小写**，客户端发的正是 `X-Emby-Token`（不能只查小写）。 */
  try {
    const sp = new URL(String((req && req.url) || ''), 'http://local').searchParams;
    for (const name of ['api_key', 'X-Emby-Token', 'x-emby-token']) {
      const q = sp.get(name);
      if (q) return { token: String(q).trim(), from: name };
    }
  } catch {
    /* url 解析不了就当没带 */
  }
  return { token: '', from: '' };
}

/**
 * 受保护端点的统一守卫：AccessToken 必须有效，且（请求里给了 UserId 时）那个 Id 必须属于这个 token 的账号。
 *   通过 → null；拒绝 → { status, body, log }（调用方直接回给客户端，401）
 *
 * 没有"宽松/严格"之分 —— 校验就是校验。客户端拿不到 token 时应当回登录界面，
 * 这与官方 Emby 对 401 的定义一致（401 = token 无效或被吊销）。
 */
function authorize(req, requestedUserId) {
  const { token, from } = tokenFrom(req);
  const sess = token ? db.findSession(token) : null;

  let problem = '';
  if (!sess) problem = token ? `token 无效（来自 ${from}）` : '没带 token';
  else if (requestedUserId && userId(sess.username).toLowerCase() !== String(requestedUserId).toLowerCase()) {
    problem = `token 属于「${sess.username}」，请求的却是别的 UserId`;
  }
  if (!problem) {
    db.touchSession(token);
    return null;
  }
  return { status: 401, text: 'Access token is invalid or expired.', log: `token 校验不过：${problem}` };
}

/**
 * 客户端来源地址 —— 真机 `SessionInfo.RemoteEndPoint` 回的是客户端 IP（实测形如 `113.194.246.0`）。
 * 面板前面可能有反代（`X-Forwarded-For` 取第一个），否则用 TCP 对端地址；
 * IPv4-mapped IPv6（`::ffff:1.2.3.4`）去掉前缀，回真机那样的纯 IPv4。
 */
function remoteEndPoint(req) {
  const xff = String((req && req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
  const raw = xff || (req && req.socket && req.socket.remoteAddress) || '';
  return String(raw).replace(/^::ffff:/, '');
}

/**
 * 真机 `SessionInfo.InternalDeviceId` 是个数字（实测 171320）—— 由 DeviceId 派生一个**稳定**的
 * 32 位内整数（同一台设备每次都同值，客户端据此认设备）。
 */
function internalDeviceId(deviceId) {
  const h = crypto.createHash('md5').update(String(deviceId || '')).digest();
  return h.readUInt32BE(0) % 1000000;
}

/**
 * 从请求体里按字段名取值，**大小写不敏感**：真机是 .NET 反序列化，字段名换大小写都认
 * （实测 `Pw` / `pw` 都登录成功，见 docs/emby-realdevice/02-…）；面板手写取值时照此对齐，
 * 免得客户端换个拼写（如 HamHub 发 `pw`）就登不上。`names` 按优先级排列，
 * 返回第一个「存在且非空」的值，都没有则回 ''。
 */
function pickBodyField(body, names) {
  if (!body || typeof body !== 'object') return '';
  const keys = Object.keys(body);
  for (const want of names) {
    const hit = keys.find((k) => k.toLowerCase() === want.toLowerCase());
    if (hit !== undefined) {
      const v = body[hit];
      if (v !== undefined && v !== null && v !== '') return v;
    }
  }
  return '';
}

/**
 * POST /Users/AuthenticateByName —— 登录（多账号：按用户名查库 + scrypt 校验）
 * 返回 { status, body, log }（JSON）或 { status, text, log }（纯文本，见下）；
 * 账号不存在 / 密码错都回 401（与 Emby 行为一致）。
 *
 * **错误响应严格对齐真机**（OkEmby 4.9.1.90 实测，见 docs/emby-compat.md「十、#2」）：
 *   · 缺 appName 头（`X-Emby-Authorization` / `Authorization` 都没有）→ 400 **纯文本** `Value cannot be null. (Parameter 'appName')`
 *   · 用户名/密码不对 → 401 **纯文本** `无效用户名或密码。请重试。`（不区分哪个不匹配，避免暴露用户名是否存在）
 *
 * 请求体字段名**大小写不敏感**（对齐真机 .NET 反序列化）：`Username`、`Pw`（兼容 `Password`）任意大小写均可。
 * appName 可从 `X-Emby-Authorization` **或** `Authorization` 任一取（真机两头都认，见 docs/emby-realdevice/02-…）；
 * 两头都没有 `Client=` 时再回退到 query `X-Emby-Client`（真机如此，Filmly / 网易爆米花就靠这一手）。
 */
function authenticate(req, body) {
  const username = String(pickBodyField(body, ['Username'])).trim();
  const password = String(pickBodyField(body, ['Pw', 'Password']));
  const client = parseClientHeader(req.headers['x-emby-authorization'] || req.headers['authorization']);
  /* 头里没有就找 query：真机 appName 取头 `Client=` 优先、缺了退 query `X-Emby-Client`（见 docs/emby-realdevice/02-…） */
  if (!client.Client) client.Client = queryParam(req, 'X-Emby-Client');

  /* 真机先校验参数头（在任何账号逻辑之前），缺 appName 一律 400 纯文本 */
  if (!client.Client) {
    return {
      status: 400,
      text: "Value cannot be null. (Parameter 'appName')",
      log: '缺 appName（X-Emby-Authorization / Authorization 头与 X-Emby-Client query 都没有）',
    };
  }

  if (!db.countAccounts()) {
    return {
      status: 401,
      body: { error: '面板还没有 Emby 账号：请到「Emby → 账号管理」先添加一个账号' },
      log: '还没有账号',
    };
  }

  const acc = db.findAccountByName(username);
  if (!acc || !db.verifyPassword(password, acc.password_hash)) {
    /* 只说"用户名或密码不正确"，**不要**分别标出哪个不匹配 —— 那等于告诉别人某个用户名存不存在 */
    return {
      status: 401,
      text: '无效用户名或密码。请重试。',
      log: `校验失败（用户=${username || '(空)'}）`,
    };
  }

  const clientLabel = [client.Client, client.Device].filter(Boolean).join(' / ');
  try {
    db.touchLogin(acc.id, clientLabel);
  } catch {
    /* 记登录时间失败不该拦住登录 */
  }

  /* token 落到 sessions 表 —— 之后每个受保护端点都靠它认人（见 authorize）。
   * 这里**不吞异常**：存不下 token 的登录等于发了个假凭证，宁可 500 让它显形。 */
  const token = newToken();
  db.createSession(token, acc.id, { client: clientLabel, deviceId: client.DeviceId });

  const now = new Date().toISOString();
  return {
    status: 200,
    log: `登录成功（${acc.username}${clientLabel ? ' · ' + clientLabel : ''}）`,
    body: {
      User: buildUser(acc.username, acc),
      /* SessionInfo 的**键集与取值对齐真机那 20 个键**（缺了会让客户端的会话面板/设备列表残缺） */
      SessionInfo: {
        PlayState: {
          CanSeek: false,
          IsPaused: false,
          IsMuted: false,
          RepeatMode: 'RepeatNone',
          SleepTimerMode: 'None',
          SubtitleOffset: 0,
          Shuffle: false,
          PlaybackRate: 1,
        },
        AdditionalUsers: [],
        RemoteEndPoint: remoteEndPoint(req),
        Protocol: 'HTTP/' + ((req && req.httpVersion) || '1.1'),
        PlayableMediaTypes: [],
        PlaylistIndex: 0,
        PlaylistLength: 0,
        Id: crypto.randomBytes(16).toString('hex'),
        ServerId: serverId(),
        UserId: userId(acc.username),
        UserName: acc.username,
        /* 文件缺失时 tag 为 '' → JSON 序列化省略该键（同 buildUser 的挂法） */
        UserPrimaryImageTag: userAvatarTag(),
        Client: client.Client,
        LastActivityDate: now,
        DeviceName: client.Device,
        InternalDeviceId: internalDeviceId(client.DeviceId),
        DeviceId: client.DeviceId,
        ApplicationVersion: client.Version,
        SupportedCommands: [],
        SupportsRemoteControl: false,
      },
      AccessToken: token,
      ServerId: serverId(),
    },
  };
}

/**
 * 校验 requestedId 是不是**某个账号**派生的 User Id —— /Users/{UserId} 这一族端点共用。
 * 通过 → null（调用方继续）；不通过 → { status, body, log }（调用方直接 return）。
 * （多账号前这里只认唯一账号；现在认库里任意一个账号。）
 */
function assertUser(requestedId) {
  if (!db.countAccounts()) {
    return { status: 401, body: { error: '面板还没有 Emby 账号' }, log: '还没有账号' };
  }
  if (!resolveAccountById(requestedId)) {
    return { status: 404, body: { error: '用户不存在' }, log: 'id 不属于任何账号 → 404：' + requestedId };
  }
  return null;
}

/**
 * GET /Users/{UserId} —— 取用户资料（返回 UserDto 本体，不包一层）
 * 按 Id 找回对应账号：找不到时，表为空 401、否则 404。
 */
/* ------------------------------------------------ 观看进度（写端点落库，读端点共用） */

/**
 * 「看完」的判定阈值：位置 ≥ 时长的 90%。
 *
 * 客户端**不报 `Played` 字段**（实测 SenPlayer 6.2.1 / Rex 0.1.0 的 body 里都没有），
 * 所以只能按比例判 —— 阈值只此一处。真机同样是按比例判的（实测：报 95% 后 `Stopped`
 * 即变 `Played: true`，见 docs/playback-progress.md §11）。
 */
const PLAYED_RATIO = 0.9;

/** tick → 人话（**只给日志用**；10^7 tick = 1 秒）。日志上要一眼看出"看到了第几分钟"。 */
function ticksText(t) {
  const s = Math.max(0, Number(t) || 0) / 1e7;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

/** 这个请求是哪个账号发的（token → 会话）；没带 token 或 token 无效 → null */
function sessionOf(req) {
  const { token } = tokenFrom(req);
  return token ? db.findSession(token) : null;
}

/** 请求对应的账号 id：优先 token 认出的那个（权威），其次按 `UserId` 反查（客户端有时只给 UserId） */
function accountIdFor(req, requestedUserId) {
  const sess = sessionOf(req);
  if (sess) return sess.account_id;
  const acc = resolveAccountById(requestedUserId);
  return acc ? acc.id : null;
}

/** `Limit` 查询参数 → 实际条数（默认 `def`，硬顶 100：别让一个客户端一次把整库拉走） */
function limitOf(query, def) {
  const v = Number(query && typeof query.get === 'function' ? query.get('Limit') : 0);
  if (!Number.isFinite(v) || v <= 0) return def;
  return Math.min(Math.floor(v), 100);
}

/**
 * 日志里"这次列出的是哪几条"（最多 5 个 Id，多了只报总数）。
 *
 * 为什么值得占这点位置：「列表对不对」是排查的第一问，而原来只报 `Items=1` ——
 * 客户端"移除之后还在"那次就卡在这里：分不清它列的是被移除的那一集还是下一集。
 */
function briefIds(items, max = 5) {
  const ids = (items || []).map((i) => i && i.Id).filter(Boolean);
  if (!ids.length) return '';
  return `（${ids.slice(0, max).join(', ')}${ids.length > max ? ` …共 ${ids.length} 条` : ''}）`;
}

/** 这个账号收藏了这条吗（读 `favorite` 表，见 ADR-0058）；读进度与 `UserData.IsFavorite` 都问它 */
function favoriteOf(accountId, itemId) {
  return !!(accountId && itemId && db.getFavorite(accountId, itemId));
}

/**
 * 库里这条的记录 → `{ userData, runtimeTicks }`；**没有记录返回 null**（调用方保持空形状）。
 *
 * `PlayedPercentage` 与 `LastPlayedDate` 是**实测对真机补齐**的两个字段：
 *   · 真机在有位置的条目上给 `PlayedPercentage`（小数，如 `4.333496627087306`；位置为 0 时**不给**）；
 *   · 客户端画进度条主要靠它 —— 只给 `PlaybackPositionTicks` 而条目又没有 `RunTimeTicks` 时，
 *     界面上就是**光秃秃没有进度条**（对比真机发现的那次）。
 * `LastPlayedDate` 用进度行最后一次更新的时间（就是"最后观看时间"）。
 *
 * `IsFavorite` 是**真值**（查 `favorite` 表，见 ADR-0058）—— 一条只有收藏、没有进度的条目
 * 也要给出正确的 `UserData`，所以「进度行」与「收藏行」任一存在就返回非 null。
 */
function progressOf(accountId, itemId) {
  if (!accountId || !itemId) return null;
  const r = db.getPlayback(accountId, itemId);
  const isFav = favoriteOf(accountId, itemId);
  if (!r && !isFav) return null;
  const position = Math.max(0, Number(r && r.position_ticks) || 0);
  const runtime = Math.max(0, Number(r && r.runtime_ticks) || 0);
  const userData = {
    IsFavorite: isFav,
    PlayCount: Number(r && r.play_count) || 0,
    PlaybackPositionTicks: position,
    Played: !!(r && r.played),
  };
  if (position > 0 && runtime > 0) userData.PlayedPercentage = (position / runtime) * 100;
  if (r && r.updated_at) userData.LastPlayedDate = String(r.updated_at).replace(/\.\d+Z$/, '.0000000Z'); // 真机是 7 位小数
  return { userData, runtimeTicks: runtime };
}

/**
 * 把进度与时长落到条目上（`progressItem` 与 `applyUserData` **共用同一口径**）。
 *
 * `RunTimeTicks` 只在条目本来没有时补：值来自**客户端上报的 `RunTimeTicks`**（源给的时长，
 * 不是编的）；集条目通常已由元数据插件的 `runtimeMinutes` 填过，就以那个为准。
 */
function applyProgressToItem(item, prog) {
  if (!prog || !item) return item;
  item.UserData = Object.assign({}, item.UserData || emptyUserData(), prog.userData);
  if (!item.RunTimeTicks && prog.runtimeTicks > 0) item.RunTimeTicks = prog.runtimeTicks;
  return item;
}

/**
 * 就地给响应里的条目补**真实**观看状态（`UserData`）；库里没记录的条目**保持原来的空形状**
 * （字段集合与 `emptyUserData()` 完全一致，见 ADR-0007）。
 *
 * 为什么做成"响应后处理"而不是给每个 DTO 都加账号参数：读侧有 6 处会产出条目 DTO
 * （列表 / 详情 / 季 / 集 / 最新 / 相似），逐个改签名既啰嗦又容易漏；而入参形状就那么几种
 * （`{Items:[…]}` / 裸数组 / 单条），处理一次全覆盖。数据库是**同步**的（`node:sqlite`），
 * 所以这一步不必 async 化。
 *
 * 剧级条目（`{域}_{编号}_tv`）**不补任何东西**：进度记在集上，而"整剧是否看完"要知道总集数，
 * 本层不知道 —— 宁可不给，也不编（ADR-0008）。
 *
 * 季条目额外补 `UserData.UnplayedItemCount`（本季未看集数；真机有，见 docs/emby-compat.md #7-3）：
 * 它要按「剧 + 季」聚合已看集数，而进度是按集记账的 —— 季自身没有进度行，靠 `item.Id` 取不到。
 */
function applyUserData(out, requestedUserId, req) {
  const accountId = accountIdFor(req, requestedUserId);
  if (!accountId || !out || !out.body) return out;
  const patch = (item) => {
    if (!item || !item.Id) return;
    applyProgressToItem(item, progressOf(accountId, item.Id));
    if (item.Type === 'Season' && item.SeriesId && Number.isFinite(item.IndexNumber) && Number.isFinite(item.ChildCount)) {
      const played = db.countPlayedInSeason(accountId, item.SeriesId, item.IndexNumber);
      item.UserData = Object.assign({}, item.UserData || emptyUserData(), {
        UnplayedItemCount: Math.max(0, item.ChildCount - played),
      });
    }
  };
  const b = out.body;
  if (Array.isArray(b)) b.forEach(patch);
  else if (Array.isArray(b.Items)) b.Items.forEach(patch);
  else patch(b);
  return out;
}

/**
 * 三条上报端点的共同入口：`Sessions/Playing`（开始）/ `/Playing/Progress`（心跳）/ `/Playing/Stopped`（结束）。
 *
 * 客户端实测（SenPlayer 6.2.1，见 docs/playback-progress.md §11）：
 *   · `ItemId` 就是**本面板发出去的 Id**（`{域}_{编号}_tv_s{n}_e{m}` / `{域}_{编号}_movie`）—— 原样回传，不做解析；
 *   · 心跳每 10 秒一次，带 `PositionTicks`，**部分**心跳才带 `RunTimeTicks`；
 *   · **没有 `Played` 字段** ⇒ "看完"只能按位置/时长比例判（真机同样如此）；
 *   · 一律**不报 `UserId`** ⇒ 账号从 token 认。
 *
 * 响应一律 **204 空体**（真机实测三条都是 204；Progress 连 token 都不校验，但本层按 ADR-0009 校验）。
 * 认不出的 `ItemId` **不写库**，但**记一行日志**说明被忽略 —— 不静默吞掉。
 */
function recordPlayback(req, kind, body) {
  const denied = authorize(req, body && body.UserId);
  if (denied) return denied;
  const sess = sessionOf(req);
  if (!sess) return { status: 401, body: { error: '需要有效的 AccessToken' }, log: 'token 校验不过' };

  const t = playableOf(body && body.ItemId);
  if (!t) {
    return { status: 204, body: null, log: `上报的 ItemId 认不出（不是本面板发出去的电影/集 Id）→ 不写库：${(body && body.ItemId) || '(空)'}` };
  }
  const itemId = t.itemId;
  const prev = db.getPlayback(sess.account_id, itemId) || {};
  const position = Math.max(0, Number((body && body.PositionTicks) || 0) || 0);
  const runtime = Math.max(0, Number((body && body.RunTimeTicks) || 0) || Number(prev.runtime_ticks) || 0);

  let played = !!prev.played;
  let playCount = Number(prev.play_count) || 0;
  let storePos = position;
  let note = '';
  /* 又开始播了 → 从「继续观看」的隐藏状态里放出来（用户又在看它了，它该回到那一行）。
   * 只在这条被隐藏过时才写，免得每次开始播放都多一次 UPDATE。 */
  if (kind === 'start' && Number(prev.hidden)) {
    db.setHidden(sess.account_id, itemId, false);
    note = '重新开始播放 → 取消「已从继续观看移除」';
  }
  if (kind === 'stop') {
    const ratio = runtime > 0 ? position / runtime : 0;
    if (body && body.Played === true) {
      played = true;
      playCount += 1;
      storePos = 0;
      note = '客户端明确说看完 → 标记已看';
    } else if (runtime > 0 && ratio >= PLAYED_RATIO) {
      played = true;
      playCount += 1;
      storePos = 0; // 已看的条目不该再出现在「继续观看」里（真机的 `PlaybackPositionTicks` 也是 0）
      note = `位置 ${Math.round(ratio * 100)}% ≥ ${PLAYED_RATIO * 100}% → 标记已看`;
    }
  } else if (played && position > 0) {
    /* 重看：已看的条目又有了进度 → 退回"未看完"，否则「继续观看」永远看不到它 */
    played = false;
    note = '重看 → 取消已看标记';
  }

  /* 名称里的 `kind` 直接写进日志，三种端点共用一行格式 */
  const label = kind === 'start' ? '开始' : kind === 'progress' ? '心跳' : '停止';
  db.upsertPlayback(sess.account_id, itemId, {
    positionTicks: storePos,
    runtimeTicks: runtime,
    played,
    playCount,
    seriesId: t.seriesId,
    season: t.season,
    episode: t.episode,
  });
  return {
    status: 204,
    body: null,
    log:
      `${label} ${itemId} 位置 ${ticksText(storePos)}` +
      (runtime ? ` / ${ticksText(runtime)}` : ' / 时长未知') +
      (note ? ` · ${note}` : ''),
  };
}

/**
 * 请求里的条目 Id → 「库里那一行的主键 + 集的坐标」；**认不出返回 null**。
 *
 * 三条上报 + 三个写端点共用：认不出的 Id 一律**不写库**，与上报端点同口径 ——
 * 客户端只是想让状态变一下，回 4xx/501 只会让它弹一个错误框。
 */
function playableOf(rawItemId) {
  const p = metaBridge.parseItemId(String(rawItemId || '').trim());
  if (!p || !isPlayableId(p)) return null;
  return {
    itemId: metaBridge.itemId(p.domain, p.type, p.entryId, p.season, p.episode),
    seriesId: p.season !== null ? metaBridge.itemId(p.domain, 'tv', p.entryId) : null,
    season: p.season,
    episode: p.episode,
  };
}

/** 一个条目的 `UserData` 形状（库里没记录就是空形状）—— 三个写端点的响应体用它 */
function userDataOf(accountId, itemId) {
  const prog = progressOf(accountId, itemId);
  return prog ? prog.userData : emptyUserData();
}

/**
 * `POST /Users/{UserId}/Items/{ItemId}/HideFromResume?Hide=true|false` ——「从继续观看里移除 / 恢复」。
 *
 * 只翻 `playback.hidden`，**不动位置**（真机实测同此：隐藏前后 `UserData` 一个字段都没变）——
 * `Hide=false` 之后位置还在，回来还是原来那一行。重新开始播放会**自动取消隐藏**（见 `recordPlayback`）。
 *
 * 库里**没有这一行**时：隐藏 → 写一行**占位**（否则"移除"记不住，下次拉列表它又回来；
 * 实测 SenPlayer 就会对「接着看」里那条还没看过的下一集发这条）；恢复 → 不动库。
 * 读侧随之要跳过被隐藏的：`Items/Resume` 与 `Shows/NextUp` 都排除 `hidden`
 * （见 `db.listResume` / `db.listRecentBySeries`，以及 `nextEpisodeItem` 里"往后找下一个没被隐藏的集"）。
 *
 * 回 **200 + 该条目的 `UserData`**；Id 认不出 → **204 且不写库**（记一行日志）。
 */
function setHiddenFromResume(req, requestedUserId, rawItemId, hide) {
  const denied = authorize(req, requestedUserId);
  if (denied) return denied;
  const sess = sessionOf(req);
  if (!sess) return { status: 401, body: { error: '需要有效的 AccessToken' }, log: 'token 校验不过' };

  const t = playableOf(rawItemId);
  if (!t) {
    return {
      status: 204,
      body: null,
      log: `HideFromResume 的 ItemId 认不出（不是本面板发出去的电影/集 Id）→ 不写库：${rawItemId || '(空)'}`,
    };
  }
  const hadRow = !!db.getPlayback(sess.account_id, t.itemId);
  const changed = db.setHidden(sess.account_id, t.itemId, hide, t);
  return {
    status: 200,
    body: userDataOf(sess.account_id, t.itemId),
    log:
      `${hide ? '移出' : '恢复'}「继续观看」${t.itemId}` +
      (hide && !hadRow ? '（库里本来没有这条 → 写一行占位记住它）' : '') +
      (!hide && !hadRow ? '（库里本来就没有这条 → 不动库）' : ''),
  };
}

/**
 * `POST|DELETE /Users/{UserId}/PlayedItems/{ItemId}` ——「标记已看 / 标记未看」。
 *
 *   · 已看（`POST`）→ `played=1`、位置归零、`play_count` **抬到至少 1**（真机实测：`0 → 1`、`1 → 1`，
 *     它不是每次 +1）—— 于是它从「继续观看」消失、进「已看」；
 *   · 未看（`DELETE`）→ `played=0`、位置归零、`play_count` 归 0 —— 行**留着**：
 *     时长与季集坐标对「接下来看」还有用，重看时也不必重新攒。
 *
 * 回 **200 + 该条目的 `UserData`**（真机这两条回的就是 `UserItemDataDto`）；认不出的 Id → **204 且不写库**。
 */
function setPlayed(req, requestedUserId, rawItemId, played) {
  const denied = authorize(req, requestedUserId);
  if (denied) return denied;
  const sess = sessionOf(req);
  if (!sess) return { status: 401, body: { error: '需要有效的 AccessToken' }, log: 'token 校验不过' };

  const t = playableOf(rawItemId);
  if (!t) {
    return {
      status: 204,
      body: null,
      log: `PlayedItems 的 ItemId 认不出（不是本面板发出去的电影/集 Id）→ 不写库：${rawItemId || '(空)'}`,
    };
  }
  const prev = db.getPlayback(sess.account_id, t.itemId) || {};
  const wasPlayed = !!prev.played;
  db.upsertPlayback(sess.account_id, t.itemId, {
    positionTicks: 0,
    /* 传 0 = **保持库里已有的时长**（upsert 里的 CASE 只在传入 > 0 时才覆盖）——
     * 标记已看 / 未看都不该把客户端上报过的时长弄丢。 */
    runtimeTicks: Number(prev.runtime_ticks) || 0,
    played,
    /* 「标记已看」把 `play_count` **抬到至少 1**（真机两次实测都吻合：`0 → 1`、`1 → 1`）——
     * 它不是"每次 +1"，那是播放上报的事；「标记未看」归 0（真机实测同此）。 */
    playCount: played ? Math.max(1, Number(prev.play_count) || 0) : 0,
    seriesId: t.seriesId,
    season: t.season,
    episode: t.episode,
  });
  return {
    status: 200,
    body: userDataOf(sess.account_id, t.itemId),
    log: `${played ? '标记已看' : '标记未看'} ${t.itemId}` + (played && wasPlayed ? '（本来就是已看）' : ''),
  };
}

/**
 * 收藏时把「列表要用的元数据」按坐标从元数据插件**快照**下来（见 ADR-0058）。
 *
 * 与进度不同：这是**写时一次**（点收藏那一下），所以可以打上游；读侧只读这份快照，0 上游请求。
 * 按 `shape` 分派 —— 电影 / 剧 / 季 / 集**都认**（真机四类都能收藏，见 docs/emby-realdevice/21-favorite-items.md #21-6）。
 * 取不到（上游没有这条 / 反查失败）→ `{ ok:false, error }`，调用方按「认不出」处理：**204 不写库**。
 *
 * 快照里只放**列表字段**（标题 / 年份 / 简介 / 评分 / 图片路径 / 集数 / 剧名…），不放 rich（硬约束③）。
 * **图片存路径、不存地址**：读时按当前域的 `imageBase` 现拼（硬约束见 ADR-0058）。
 */
async function favoriteSnapshot(p) {
  const { domain, entryId } = p;
  if (p.shape === 'movie' || p.shape === 'show') {
    const look = await metaBridge.lookup({ type: p.type, entryId, domain });
    if (!look.ok) return { ok: false, error: look.error };
    const it = look.item;
    return {
      ok: true,
      snap: {
        shape: p.shape,
        domain,
        entryId,
        title: it.title,
        year: it.year,
        overview: it.overview,
        communityRating: it.communityRating,
        posterPath: it.posterPath,
        backdropPath: it.backdropPath,
        originalTitle: it.originalTitle,
        genres: it.genres,
        seasonCount: it.seasonCount,
      },
    };
  }

  /* 季 / 集都要那份剧详情：季名字与剧名在同一次 `withSeasons` 里带回；集的分集数据另走 season 接口。 */
  const showLook = await metaBridge.lookup({ type: 'tv', entryId, withSeasons: true, domain });
  if (!showLook.ok) return { ok: false, error: showLook.error };
  const show = showLook.item;

  if (p.shape === 'season') {
    const s = (show.seasons || []).find((x) => Number(x.seasonNumber) === Number(p.season));
    if (!s) return { ok: false, error: { code: 'NOT_FOUND', status: 404, message: `上游没有 S${p.season}` } };
    return {
      ok: true,
      snap: {
        shape: 'season',
        domain,
        entryId,
        seasonNumber: p.season,
        title: s.name || `第 ${p.season} 季`,
        year: s.year,
        premiereDate: s.premiereDate,
        overview: s.overview,
        communityRating: s.rating,
        posterPath: s.posterPath || show.posterPath, // 季海报缺失时退回剧海报（与 getSeasons 同口径）
        episodeCount: s.episodeCount,
        seriesTitle: show.title || '',
      },
    };
  }

  if (p.shape !== 'episode') return { ok: false, error: { code: 'BAD_ID', status: 400, message: '认不出的收藏对象' } };
  const seasonLook = await metaBridge.lookupSeason({ entryId, season: p.season, domain });
  if (!seasonLook.ok) return { ok: false, error: seasonLook.error };
  const e = (seasonLook.item.episodes || []).find((x) => Number(x.episodeNumber) === Number(p.episode));
  if (!e) return { ok: false, error: { code: 'NOT_FOUND', status: 404, message: `上游没有 S${p.season}E${p.episode}` } };
  return {
    ok: true,
    snap: {
      shape: 'episode',
      domain,
      entryId,
      seasonNumber: p.season,
      episodeNumber: p.episode,
      title: e.name || `第 ${p.episode} 集`,
      year: e.year,
      premiereDate: e.premiereDate,
      overview: e.overview,
      communityRating: e.rating,
      stillPath: e.stillPath,
      runtimeMinutes: e.runtimeMinutes,
      seasonName: seasonLook.item.name || `第 ${p.season} 季`,
      seriesTitle: show.title || '',
    },
  };
}

/**
 * 快照 → 一条列表 `BaseItemDto`（`Filters=IsFavorite` 读侧用，**纯 CPU、0 上游请求**）。
 *
 * 按 `shape` 分派：电影 / 剧走 `leanItemDto`（与列表项同一形状），季 / 集仿 `getSeasons` / `getEpisodes`
 * 用 `baseItem` 拼（同一套字段，只是数据来自快照）。认不出的形状 → null，调用方跳过并计数。
 */
function favoriteDto(snap) {
  if (!snap || !snap.domain) return null;
  const domain = snap.domain;

  if (snap.shape === 'movie' || snap.shape === 'show') {
    return leanItemDto({
      type: snap.shape === 'movie' ? 'movie' : 'tv',
      domain,
      entryId: snap.entryId,
      parentId: defaultLibraryId(),
      title: snap.title,
      year: snap.year,
      overview: snap.overview,
      communityRating: snap.communityRating,
      posterPath: snap.posterPath,
      backdropPath: snap.backdropPath,
      originalTitle: snap.originalTitle,
      genres: snap.genres,
      seasonCount: snap.seasonCount,
    });
  }

  if (snap.shape === 'season') {
    const item = baseItem({
      id: metaBridge.itemId(domain, 'tv', snap.entryId, snap.seasonNumber),
      parentId: defaultLibraryId(),
      name: snap.title,
      type: 'Season',
      year: snap.year,
      premiereDate: snap.premiereDate,
      overview: snap.overview,
      communityRating: snap.communityRating,
      providerIds: { [metaBridge.providerIdKey(domain)]: String(snap.entryId) },
      posterUrl: metaBridge.imageUrlOf(domain, 'w500', snap.posterPath),
    });
    item.Genres = []; // 上游的季没有 genres（与 getSeasons 一致）
    item.ChildCount = snap.episodeCount;
    item.IndexNumber = snap.seasonNumber;
    item.SeriesId = metaBridge.itemId(domain, 'tv', snap.entryId);
    item.SeriesName = snap.seriesTitle || '';
    return item;
  }

  if (snap.shape !== 'episode') return null;
  const item = baseItem({
    id: metaBridge.itemId(domain, 'tv', snap.entryId, snap.seasonNumber, snap.episodeNumber),
    parentId: defaultLibraryId(),
    name: snap.title,
    type: 'Episode',
    year: snap.year,
    premiereDate: snap.premiereDate,
    overview: snap.overview,
    communityRating: snap.communityRating,
    providerIds: { [metaBridge.providerIdKey(domain)]: String(snap.entryId) },
    posterUrl: metaBridge.imageUrlOf(domain, 'w300', snap.stillPath),
  });
  item.IsFolder = false;
  item.IndexNumber = snap.episodeNumber;
  item.ParentIndexNumber = snap.seasonNumber;
  item.SeriesId = metaBridge.itemId(domain, 'tv', snap.entryId);
  item.SeasonId = metaBridge.itemId(domain, 'tv', snap.entryId, snap.seasonNumber);
  item.SeasonName = snap.seasonName || `第 ${snap.seasonNumber} 季`;
  item.SeriesName = snap.seriesTitle || '';
  if (snap.runtimeMinutes) item.RunTimeTicks = snap.runtimeMinutes * 600000000;
  if (snap.stillPath) item.PrimaryImageAspectRatio = 1.7777778;
  return item;
}

/**
 * `POST|DELETE /Users/{UserId}/FavoriteItems/{ItemId}` ——「收藏 / 取消收藏」。
 *
 *   · 收藏（`POST`）→ 把**列表元数据快照**（`favoriteSnapshot`）落 `favorite` 表（覆盖写）；
 *   · 取消（`DELETE`）→ 删掉那一行。
 *
 * 与进度**刻意不对称**（见 ADR-0058）：收藏是低频显式动作，所以**写时快照**、读侧 0 上游请求；
 * 进度是高频心跳，读侧才反查上游。两条路都回 **200 + 该条目的 `UserData`**（真机同此，见 #21-1）。
 * Id 认不出 / 反查不到 → **204 且不写库**（#21-2，与三条上报同口径）；一律**校验 token**（#21-3）。
 */
async function setFavorite(req, requestedUserId, rawItemId, favorite) {
  const denied = authorize(req, requestedUserId);
  if (denied) return denied;
  const sess = sessionOf(req);
  if (!sess) return { status: 401, body: { error: '需要有效的 AccessToken' }, log: 'token 校验不过' };

  const p = metaBridge.parseItemId(String(rawItemId || '').trim());
  if (!p) {
    return { status: 204, body: null, log: `FavoriteItems 的 ItemId 认不出 → 不写库：${rawItemId || '(空)'}` };
  }
  const itemId = metaBridge.itemId(p.domain, p.type, p.entryId, p.season, p.episode);

  if (!favorite) {
    const removed = db.removeFavorite(sess.account_id, itemId);
    return {
      status: 200,
      body: userDataOf(sess.account_id, itemId),
      log: `取消收藏 ${itemId}` + (removed ? '' : '（本来就没收藏）'),
    };
  }

  const snap = await favoriteSnapshot(p);
  if (!snap.ok) {
    const why = (snap.error && snap.error.code) || '反查失败';
    return { status: 204, body: null, log: `收藏 ${itemId} → 元数据取不到（${why}）→ 不写库` };
  }
  const had = !!db.getFavorite(sess.account_id, itemId);
  db.upsertFavorite(sess.account_id, itemId, JSON.stringify(snap.snap));
  return {
    status: 200,
    body: userDataOf(sess.account_id, itemId),
    log: `收藏 ${itemId}「${snap.snap.title}」（写时快照列表元数据）` + (had ? '（本来就收藏了）' : ''),
  };
}

/** 账号被删时清掉它的进度（`/api/emby/accounts` 的删除走 `db.removeAccount`，那里已经带了） */

/**
 * 一条进度行 → 一条 `BaseItemDto`（「继续观看」/「已看」/「接下来看」共用）。
 *
 * 元数据**按坐标反查元数据插件**（缓存归插件；播过的东西刚查过，基本是命中）。
 * **查不到就返回 null**，由调用方跳过 —— 不编名字、不编封面（ADR-0008）。
 * 集的拼装与 `getEpisodes()` 保持一致（同样是剧照当 Primary、`IsFolder=false`、带季集号）。
 */
async function progressItem(r, accountId) {
  const p = metaBridge.parseItemId(r.item_id);
  if (!p) return null;
  const domain = p.domain;
  const prog = progressOf(accountId, r.item_id);

  if (p.type === 'movie') {
    const look = await metaBridge.lookup({ type: 'movie', entryId: p.entryId, domain });
    if (!look.ok) return null;
    const item = leanItemDto({
      type: 'movie',
      domain,
      entryId: p.entryId,
      parentId: defaultLibraryId(),
      title: look.item.title,
      year: look.item.year,
      overview: look.item.overview,
      communityRating: look.item.communityRating,
      posterPath: look.item.posterPath,
      backdropPath: look.item.backdropPath,
    });
    item.IsFolder = false;
    applyProgressToItem(item, prog);
    return item;
  }

  if (p.season === null || p.episode === null) return null; // 剧（`_tv`）本身没有进度，见 applyUserData 的说明
  const seasonLook = await metaBridge.lookupSeason({ entryId: p.entryId, season: p.season, domain });
  if (!seasonLook.ok) return null;
  const e = (seasonLook.item.episodes || []).find((x) => Number(x.episodeNumber) === Number(p.episode));
  if (!e) return null; // 这一季里没有这一集（源与上游对不上）→ 不列，不编

  const showLook = await metaBridge.lookup({ type: 'tv', entryId: p.entryId, domain }); // 只为剧名（缓存里通常已有）
  const item = baseItem({
    id: metaBridge.itemId(domain, 'tv', p.entryId, p.season, p.episode),
    parentId: defaultLibraryId(),
    name: e.name || `第 ${p.episode} 集`,
    type: 'Episode',
    year: e.year,
    premiereDate: e.premiereDate,
    overview: e.overview,
    communityRating: e.rating,
    providerIds: { [metaBridge.providerIdKey(domain)]: String(p.entryId) },
    posterUrl: metaBridge.imageUrlOf(domain, 'w300', e.stillPath),
  });
  item.IsFolder = false;
  item.IndexNumber = e.episodeNumber;
  item.ParentIndexNumber = p.season;
  item.SeriesId = metaBridge.itemId(domain, 'tv', p.entryId);
  if (showLook.ok) item.SeriesName = showLook.item.title || '';
  item.SeasonId = metaBridge.itemId(domain, 'tv', p.entryId, p.season);
  item.SeasonName = seasonLook.item.name || `第 ${p.season} 季`;
  if (e.runtimeMinutes) item.RunTimeTicks = e.runtimeMinutes * 600000000;
  if (e.stillPath) item.PrimaryImageAspectRatio = 1.7777778;
  applyProgressToItem(item, prog);
  return item;
}

/** 一组进度行 → `QueryResult<BaseItemDto>`（取不到元数据的行**跳过并计数**，日志里说明） */
async function progressList(rows, accountId, label) {
  const items = [];
  let skipped = 0;
  for (const r of rows) {
    const it = await progressItem(r, accountId);
    if (it) items.push(it);
    else skipped += 1;
  }
  return {
    status: 200,
    body: { Items: items, TotalRecordCount: items.length },
    log:
      `${label}：库里 ${rows.length} 条 → 列出 ${items.length} 条${skipped ? `（${skipped} 条取不到元数据，未列出）` : ''}` +
      briefIds(items),
  };
}

/**
 * GET /Users/{UserId} —— 取用户资料（返回 UserDto 本体，不包一层）
 * 按 Id 找回对应账号：找不到时，表为空 401、否则 404。
 */
function getUser(requestedId) {
  const acc = resolveAccountById(requestedId);
  if (!acc) {
    if (!db.countAccounts()) {
      return { status: 401, body: { error: '面板还没有 Emby 账号' }, log: '还没有账号' };
    }
    return { status: 404, text: '找不到请求的用户。最近可能已从服务器中删除了。', log: 'id 不属于任何账号 → 404：' + requestedId };
  }
  return { status: 200, body: buildUser(acc.username, acc), log: 'ok（' + acc.username + '）' };
}

/**
 * GET /Users/{UserId}/Views —— 媒体库列表
 *
 * **不再留白**：每个「启用」的首页插件行做成一个 Emby 媒体库
 * （`Type: CollectionFolder`），客户端据此在首页列出这些库。
 *
 * 行内容走 `Items?ParentId=<库Id>`（见 `getItems` → `home.listByQuery`）。
 *
 * 条目的字段形状见 `homeViewItem()`（按真机逐字段补齐，含封面）。
 *
 * 数据取自 registry 快照（不加载插件代码、不起沙箱）；没有启用的插件行时回空 ——
 * 与留白时期的空响应形状完全一致，客户端不受影响。
 *
 * **不校验 requestedId**：真机对 Views 不看 UserId —— 有效 token + 任意/不存在的
 * UserId 都回 200 全量库（OkEmby 实测，见 docs/emby-compat.md「十、#4」）。
 * 路由层 `authorize` 已保证 token 有效，这里无需再查账号（原来的 `assertUser`
 * 在这条路上本来就是死代码：能过 authorize 的 token 必然对应存在的账号）。
 */
function getViews() {
  const items = home.enabledRows().map(homeViewItem);
  return {
    status: 200,
    body: { Items: items, TotalRecordCount: items.length },
    log: items.length ? `${items.length} 个库（来自启用的首页插件行）` : '0 个库（没有启用的首页插件行）',
  };
}

/**
 * 首页插件行 → Emby 的媒体库条目（`CollectionFolder`）。
 *
 * 刻意**不复用 `baseItem()`**：那是"媒体条目"的形状（`MediaType: Video`、`ProductionYear: 0`、
 * `PremiereDate: ''`…），容器套上那些会让客户端按"影片"去理解它。
 *
 * **按真机字段表补齐**：拿真机 25 个库的响应逐字段对过
 * （`docs/emby-compat.md` 有实测值）。每个值的来源都写在下面各自那一行上 ——
 * **推不出来的一律不填**，不为凑字段编值。
 *
 * `ParentId` 按真机补**占位值** `"2"`（真机 25/25 都是它，指服务器根聚合节点；本层没有
 * 那个节点，值是占位 —— 字段集与真机一致优先（4-1）：客户端顺着它取父级会拿到
 * 501/404，但实测客户端基本不这么干）。
 */
function homeViewItem(r) {
  const id = home.viewId(r.pluginId, r.rowId);
  const name = r.title || r.rowId;

  /* ---- 封面（真机每个有图的库都有，且**只**放在 `ImageTags.Primary`）----
   * 两条路都**零上游请求**：
   *   ① 图片索引（持久，默认 90 天）—— 发过 tag 就记下了，重启后仍在；
   *   ② 该行的**内存缓存结果** —— 客户端逛过一次就会有。
   * **绝不为了封面单独打一次上游**：那份代价随库数线性增长（已定为红线）。
   * 取不到就不给 `ImageTags` / `PrimaryImageAspectRatio` —— 真机无图的库正是这个形状
   * （实测：`ImageTags: {}`、`BackdropImageTags: []`、**没有** `PrimaryImageAspectRatio` 这个键）。
   *
   * 只用**横图**（`backdrop`）：真机库封面基本是 16:9，客户端按横图布局时不会把图裁烂；
   * 也因此 ratio 恒为 1.777…（竖图海报硬当库封面会变形，宁可不给）。 */
  let cover = imageUrlFromIndex(id, 'Primary', 0);
  if (!cover) {
    const first = (home.peekRowItems(r.pluginId, r.rowId) || []).find((it) => it && it.backdrop);
    if (first) cover = first.backdrop;
  }

  /* 三个标识：真机里 `Guid` = `PresentationUniqueKey` = `DisplayPreferencesId`（同一个 GUID，
   * 实测 25/25 相同）。库 Id 不是 GUID 形状，就用它派生一个**稳定**的 32 位 hex ——
   * 客户端拿它们做缓存键，每次请求都变会让缓存反复失效。 */
  const guid = stableHash('view|' + id);
  const item = {
    Name: name,
    ServerId: serverId(),
    Id: id,
    Guid: guid,
    /* 真机的 `Etag` 是**库内容**的指纹。这里的"库"就是这一行：库名或封面变了才算变。
     * （上游榜单内容每天在变，但本层无从观察 —— 那就只对能观察到的部分负责。） */
    Etag: stableHash([id, name, cover || ''].join('|')),
    /* `DateCreated` = **占位值**。
     * 真机那是库的创建时间，而本层没有"建库"这个动作 —— 上游里也没有"这一行"这个实体，
     * 拿不到任何真实时间可用。曾经用"库首次出现在 `Views` 的时刻"（`view_seen` 表）近似，
     * 但那是个**不可再生**的值（表一丢，所有库看起来就"全新建了"），为它养一张表不划算；
     * 占位值取 Emby 自己的零值（与 DateModified 同一个），这样"一看就知道是占位"，
     * 也**必须是合法时间**：`0000-00-00` 这种非法日期会让客户端的 DateTime 解析整条失败
     * （文档里记过的最贵那种故障）。 */
    DateCreated: ZERO_STAMP,
    /* `DateModified` 真机 25/25 全是这个值 —— Emby 里"从未修改"的零值，照给。 */
    DateModified: ZERO_STAMP,
    CanDelete: false,
    /* ⚠️ **库这一条保持 `false`**：`CanDownload` 说的是"这个条目本身能下"，而库是个
     * `CollectionFolder` 文件夹 —— 下不了（真机这里也是 false）。
     * 要下的是**条目**，那条在 `baseItem()` 里给 `true`（见那个函数）。 */
    CanDownload: false,
    PresentationUniqueKey: guid,
    SortName: name,
    ForcedSortName: name,
    ExternalUrls: [],
    Taglines: [],
    RemoteTrailers: [],
    ProviderIds: {},
    IsFolder: true,
    Type: 'CollectionFolder',
    /* 真机 25/25 都带 `"2"`（服务器根聚合节点）。**占位值**：本层没有那个节点（见函数头注释 4-1） */
    ParentId: '2',
    UserData: emptyViewUserData(),
    DisplayPreferencesId: guid,
    BackdropImageTags: [],
    LockedFields: [],
    LockData: false,
  };

  /* `CollectionType`：真机每个库都有（`movies`/`tvshows`/`playlists`/`boxsets`）。
   * 值由 `home.enabledRows()` 定好（**行自己声明** → 按该行当前的 `type` 参数推 → `mixed`，
   * 取值顺序的理由写在 `home.resolveCollectionType()` 上）。
   * ⚠️ 该字段曾经**刻意不给**（当时担心客户端不认），实测真机每个库都给 ⇒ 给了更贴近真机。
   * 若哪个客户端反而异常，**第一个该试的就是把这一行去掉**。 */
  if (r.collectionType) item.CollectionType = r.collectionType;

  /* `ChildCount`：真机 12/12 都有（样本全=1，疑似每库挂一个虚拟子文件夹），客户端拿它
   * 判断空库/画角标。**真实条数优先**，两级取数，都不为它打上游：
   *   ① 行在 `rows` 里**申报的库总数**（`r.total`）—— 客户端还没点开这个库就有真数；
   *   ② 该行被取过内容后，面板内存里留着的插件申报总数（`peekRowTotal`）。
   * 两个都拿不到才回退**占位值 1**（取 1 不取 0：0 会被客户端当空库，4-2）。
   * 申报口径见首页插件指南的 `rows.total`；插件拿不准就不申报，别编（ADR-0008）。 */
  item.ChildCount = r.total > 0 ? r.total : home.peekRowTotal(r.pluginId, r.rowId) || 1;

  if (cover) {
    item.ImageTags = { Primary: tagAndRemember(id, 'Primary', 0, cover) };
    item.PrimaryImageAspectRatio = 1.7777777777777777;
  } else {
    item.ImageTags = {};
  }
  return item;
}

/**
 * GET /Users/{UserId}/Items/Resume —— 首页「继续观看」
 *
 * 数据来自 `playback` 表（客户端 `POST /Sessions/Playing*` 上报的结果）：
 * **有位置、还没看完**的条目，最近看的在前 —— 排序与真机一致（实测）。
 *
 * **必须校验账号**（与 `getStudios` 那种"回空"端点不同）：这里回的是**某个账号的观看记录**，
 * 不校验就是跨账号泄漏（ADR-0009：回真数据的端点必须校验）。没有记录时照样回空列表 + 200 ——
 * "这台服务器上还没看过任何东西"本来就是 Emby 的合法状态。
 *
 * **只验 token、不比对 `UserId`**（13-1 起对齐真机）：真机对「有效 token + 合法 Guid 但不存在的 UserId」
 * 照常回 200（全 0 guid 实测），`UserId` 只当参数。属读取类，适用「只验 token」的自动对齐例外；
 * 观看记录**按 token 解出的账号**取（`accountIdFor`：token 优先），传别人的 `UserId` 也只看到自己 token 账号的记录。
 */
async function getResume(requestedId, req, query) {
  const denied = authorize(req);
  if (denied) return denied;
  const accountId = accountIdFor(req, requestedId);
  if (!accountId) return { status: 200, body: { Items: [], TotalRecordCount: 0 }, log: '账号认不出 → 空' };
  const rows = db.listResume(accountId, limitOf(query, 20));
  return progressList(rows, accountId, '继续观看');
}

/**
 * GET /Studios —— 工作室（制片公司 / 发行方 / 电视台）清单
 *
 * **如实回空**。这不是"还没做"，是**做不出真数据**：
 *
 *   · 每条片的 `Studios[]` **本地本来就有** —— 详情页从上游的 `production_companies` 映射
 *     （见 `applyRich`），实测 `movie/603` 给 4 个（含 `Warner Bros. Pictures`）
 *   · 但这个端点要的是**全库去重后的清单**，而**服务端没有片库索引**：列表数据由首页插件
 *     在请求时现跑，本层从不存"库里有哪些片"
 *   · 硬凑只能去跑一遍启用的行来聚合 —— 那得到的是**行返回的那几页**里的工作室（榜单片 ≠ 片库），
 *     清单会随榜单波动。用户拿着一个会变的清单去筛选，得到的结果没法解释 —— 那是**编数据**，
 *     比空更糟
 *   · 何况它还有个配套的 `/Studios/{Name}/Items`（点某个工作室看它出了哪些片）同样无从回答，
 *     所以只给清单本身也没多大意义
 *
 * ⇒ 回一个空 `QueryResult`：筛选列表是空的，但**不骗人**（与 `getResume` 同一取向）。
 * 另外：详情里的 `Studios[]` **只给 `Name` 不给 `Id`**，也是同一个道理 ——
 * 给了 Id 客户端就会去点，而这里没有那条路。
 */
function getStudios() {
  return {
    status: 200,
    body: { Items: [], TotalRecordCount: 0 },
    log: '没有片库可枚举（见 service.getStudios）→ 空（如实）',
  };
}

/**
 * 客户端在按**外部 id** 找条目吗？把 `AnyProviderIdEquals` 解成一张**候选表**。
 *
 * 这个参数是**逗号分隔的多值**，语义是"任一条对上就算"（Emby 的 OR）——
 * 实测 Rex/0.5.0 打的就是 `tmdb.282326,imdb.tt32500958`；同名参数重复出现也收（`query.getAll`）。
 * ⚠️ 多值里**只要有一条认得出**，这条查询就算成立；认不出的那些**跳过并记下原因**，
 * 不等于整条查询作废（以前只认单值，多值一律判"没这条查询"→ 回空，链路就断在那里）。
 *
 * **前缀按注册表认域，不写死某个域**：客户端手里那串前缀（Emby 惯例是提供者名）交给
 * `metaBridge.domainOfRef()` 找已注册的元数据域；**认不出就跳过**（不猜、不回退到别的域）。
 * 编号**不要求是数字** —— 数字（`550`）与 slug（`dldss-559`）都可能，面板只透传
 * （见 core/providers.js）。形状与条目 Id 里的编号段同一套：只允许 `[A-Za-z0-9._-]`。
 *
 * 回 `{ refs, skipped }`：`refs` 保序去重、至多 `PROVIDER_REF_MAX` 条（上限是挡"客户端拿一长串
 * 外部 id 刷成一长串上游请求"）；`skipped` 是每条没认出来的原文与原因，供日志点名。
 *
 * **判据只此一处**：`getItems` 的搜索分支用它认 `AnyProviderIdEquals`，
 * 别各写一份正则（多值/形状规则漂移会让检索链路静默失效）。
 */
const PROVIDER_REF_RE = /^([A-Za-z][A-Za-z0-9]*)\.([A-Za-z0-9][A-Za-z0-9._-]*)$/;
const PROVIDER_REF_MAX = 8;
function searchProviderRefs(query) {
  if (!query || typeof query.get !== 'function') return { refs: [], skipped: [] };
  const vals = typeof query.getAll === 'function' ? query.getAll('AnyProviderIdEquals') : [query.get('AnyProviderIdEquals') || ''];
  const refs = [];
  const skipped = [];
  for (const raw of vals) {
    for (const one of String(raw || '').split(',')) {
      const s = one.trim();
      if (!s) continue;
      const m = PROVIDER_REF_RE.exec(s);
      if (!m) {
        skipped.push({ ref: s, why: '形状不是「{前缀}.{编号}」' });
        continue;
      }
      const domain = metaBridge.domainOfRef(m[1]);
      if (!domain) {
        skipped.push({ ref: s, why: `前缀 ${m[1]} 不是已注册域` });
        continue;
      }
      if (refs.length >= PROVIDER_REF_MAX) {
        skipped.push({ ref: s, why: `超出候选上限 ${PROVIDER_REF_MAX}` });
        continue;
      }
      if (!refs.some((r) => r.domain === domain && r.entryId === m[2])) refs.push({ domain, entryId: m[2] });
    }
  }
  return { refs, skipped };
}

/**
 * 客户端在**按名字搜条目**吗？`SearchTerm=斗破苍穹` → 回那个词，否则回 `''`。
 *
 * **为什么要有这条**（依据是日志）：SenPlayer 6.1.8 的搜索框打的是
 * `GET /Users/{id}/Items?...&IncludeItemTypes=Movie,Series,Video,Person&Recursive=true&SearchTerm=斗破苍穹`
 * —— 早期落到「没有可识别的查询参数 → 空」，于是搜索永远是空的（日志里连打 4 次 `Items=0`）。
 *
 * ⚠️ 真机（`emby.example.com`，实测）同一条 query 回 **7 条**（剧 + 电影混排），
 * 列表项只有 11 个字段（`Id/Name/Type/ImageTags/UserData/…`）—— 说明它就是"给搜索框列卡片"，
 * 不是详情。本实现的形状更全（超集不会出错，见指南「四」）。
 *
 * **判据只此一处**：`getItems` 的搜索分支用它认 `SearchTerm`。
 */
function searchTermOf(query) {
  const val = (k) => (query && typeof query.get === 'function' ? query.get(k) || '' : '');
  return String(val('SearchTerm')).trim();
}

/** 搜索每类型默认取多少条（`Limit` 缺省时）与硬上限（防客户端要 999 条把上游打爆） */
const SEARCH_DEFAULT_LIMIT = 20;
const SEARCH_MAX_LIMIT = 40;

/** 上游搜索**一页**的条数（实测各域都是 20）—— 把客户端窗口换算成"要取几页"用 */
const SEARCH_UPSTREAM_PAGE = 20;
/** 一次搜索**最多**连取几页上游 —— 防呆，别让大 `Limit` 把上游打穿 */
const SEARCH_MAX_UPSTREAM_PAGES = 3;

/**
 * `IncludeItemTypes` → 要搜哪几种：`Series`→tv、`Movie`→movie；**两个都没给 = 都搜**。
 * （`Video` / `Person` 不认：分集搜索要按剧集层级走，人物不是本层的条目 —— 忽略，不假搜。）
 */
function searchTypesOf(include) {
  const s = String(include || '');
  const tv = /series/i.test(s);
  const movie = /\bmovie/i.test(s);
  if (!tv && !movie) return ['tv', 'movie'];
  return [tv ? 'tv' : null, movie ? 'movie' : null].filter(Boolean);
}

/**
 * **搜索结果行** → 一条 `BaseItemDto`（走 `leanItemDto`，与相似推荐同款）。
 *
 * 行里是**元数据插件归一化过的字段**（`entryId` / `title` / `year` / `posterPath`…）——
 * 面板不认上游的字段形状（那是插件的事，见 docs/adr/0029 的已定 5）。
 *
 * ⚠️ **不为搜索结果再打 `lookup()`**（那会是"每类型 N 次上游"的线性账）：
 * 搜索行里已经给了名字 / 简介 / 海报 / 横图 / 年份 / 评分，`baseItem()` 需要的那几项都够；
 * 缺的（演职、分级、外部链接的 IMDb 号…）本来就是**详情页**才要的东西 ——
 * 客户端点进某一条时会打详情，那时才 `lookup({rich:true})`（同首页模块给的列表项一个路子）。
 * 真机的搜索项也只有 11 个字段，说明客户端对"搜索卡片"没有更多期待。
 */
function searchRowDto(row, type) {
  return leanItemDto({
    type,
    /* 行里带的是**它属于哪个域**（`meta-bridge.js` 的 `search()` 逐域遍历时打上的）——
     * 条目 Id 与 `ProviderIds` 的键都按它取（见 `leanItemDto`）。 */
    domain: row.domain,
    entryId: row.entryId,
    parentId: defaultLibraryId(),
    title: row.title || '',
    year: row.year || '',
    overview: row.overview,
    communityRating: row.communityRating,
    posterPath: row.posterPath,
    backdropPath: row.backdropPath,
    originalTitle: row.originalTitle,
  });
}

/**
 * 客户端有没有在问「**轮播推荐位**」？—— 认得出回 `'random'`，认不出回 `''`。
 *
 * **为什么需要这个**：轮播推荐位**不带库 Id**（实测 Rex 首页第一发，比 `Views` 还早），
 * 早期一律回空、首页没素材。这条路由到**插件声明了 `feed: 'random'` 的那一行**
 * （内容仍然由模块决定）；没有插件声明 → 回空（不挑一行顶上，见 [ADR-0054]）。
 *
 * ⚠️ 另一族「**裸列表查询**」不归这里 —— 早期一度被塞进同一支（ADR-0054），
 * 予初Emby 真机实测证明那是错的：真机对这条回的是**顶层库列表**而非条目。
 * 现归 `libraryQueryOf`（回库列表，见 [ADR-0055]）。
 *
 * **别抢别支**：指名了库（含**不是本面板的** `ParentId`）、`Filters` / `SearchTerm` /
 * `AnyProviderIdEquals`（含认不出的那串）/ `Ids`（按条目 id 点名要，不是"要一批条目"）/
 * 计数探针（`typeCountProbeOf`）/ 裸列表查询（`libraryQueryOf`）
 * —— 这些都各自有支路，本函数一律让开；让开之后各自照旧处理。
 *
 * ⚠️ 语义：`IsFavoriteOrLiked` 那条 query 的原意是"用户收藏或喜欢的、随机"。本层**没有收藏数据**，
 * 所以只能按「随机推荐」理解 —— 给的是随机热门，**不是**用户的收藏（文档中不要写成收藏）。
 */
function feedOfQuery(query) {
  const val = (k) => (query && typeof query.get === 'function' ? query.get(k) || '' : '');
  if (val('ParentId')) return ''; // 指名了库（含不是本面板的）→ 走正常路
  if (val('Filters')) return ''; // 收藏 / 已播放有自己的一支
  if (searchTermOf(query)) return ''; // 按名字搜有自己的一支
  if (val('AnyProviderIdEquals')) return ''; // 按外部 id 定位（含认不出的）有自己的一支
  if (val('Ids')) return ''; // 按条目 id 点名要 → 不是"要一批条目"，维持回空
  if (typeCountProbeOf(query)) return ''; // 按类型计数探针有自己的一支
  if (libraryQueryOf(query)) return ''; // 裸列表查询有自己的一支（回库列表）
  return 'random'; // 走到这里 = 轮播推荐位
}

/**
 * 认「无 `ParentId` 的**裸列表查询**」：客户端没指名任何库、也没指名任何条目 / 搜索 / 筛选，
 * 只是"要一批东西"（只带 `ExcludeItemTypes` / `StartIndex` / `Limit` / `Fields` 这类通用参数）。
 *
 * **真机口径的由来**：予初Emby（4.9.5.0）实测这条查询回的是**顶层库列表** —— 26 个
 * `CollectionFolder`，与 `GET /Users/{id}/Views` 一字不差（同样的 Id / Name / Type）。
 * 即 Emby 对「无 `ParentId` 且**不递归**」的 `Items` 查询，默认回根节点的直接子级 = 那些库；
 * 想要条目，客户端得带 `Recursive=true`（轮播推荐位那条就带）。爆米花（Filmly）首页入口
 * 走的就是这条 ⇒ 面板照真机回库列表（`getViews()`），**不复用 `feed: 'random'`**（那会回条目）。
 *
 * 判据取**最窄**那一档，只命中真机样本这一族、不动别的支路：无 `ParentId`、无 `SortBy`、
 * 非 `Recursive=true`，且无 `Filters` / `SearchTerm` / `AnyProviderIdEquals` / `Ids`、
 * 不是计数探针。带 `SortBy`（轮播）或 `Recursive=true` 的都让开、维持原路。
 */
function libraryQueryOf(query) {
  const val = (k) => (query && typeof query.get === 'function' ? query.get(k) || '' : '');
  if (val('ParentId')) return false;
  if (val('SortBy')) return false;
  if (/^true$/i.test(val('Recursive').trim())) return false;
  if (val('Filters')) return false;
  if (searchTermOf(query)) return false;
  if (val('AnyProviderIdEquals')) return false;
  if (val('Ids')) return false;
  if (typeCountProbeOf(query)) return false;
  return true;
}

/** 复制一份 query 并塞进 `ParentId`（不改原件：日志要打客户端**原样**发的参数） */
function withParentId(query, parentId) {
  const q = new URLSearchParams(query);
  q.set('ParentId', parentId);
  return q;
}

/**
 * GET /Shows/NextUp —— 「接下来看」
 *
 * **端点保留、对外恒空**（ADR-0060）：本函数不再算「该看哪一集」，一律回
 * `200 {Items:[], TotalRecordCount:0}`，只为**藏掉**客户端首页那一行「接下来看」——
 * 它与「继续观看」（`Items/Resume`）在常规顺序观看下指向同一集，两行重复。
 *
 * 保留端点（而非删路由）是为了：老客户端（SenPlayer / CapyPlayer 会主动请求这条）不因
 * 404 报错；且**没有开关**（不引入配置项），需要恢复时直接改这里。
 *
 * 「不删除」的取值口径：下面的 `nextEpisodeItem` / `episodeExists` / `firstEpisodeItem`
 * 实现**原样留着**（暂不调用），恢复时把本函数的空返回换回原逻辑即可。
 *
 * 鉴权口径不变：无 token → 401 纯文本 `Access token is invalid or expired.`；
 * 有效 token + 错配 / 不存在的 `UserId` 也回 200（见 ADR-0048）。
 */
async function getNextUp(requestedId, req, query) {
  const denied = authorize(req);
  if (denied) return denied;
  return {
    status: 200,
    body: { Items: [], TotalRecordCount: 0 },
    log: '接下来看：按 ADR-0060 不外发 → 空',
  };
}

/**
 * 一部剧的"接下来看"：算出该看哪一集，再交给 `progressItem` 组装
 * （这样带出来的是**那一集自己**的位置与已看状态，而不是"最近那条"的）。
 *
 * **当前未被调用**（`getNextUp` 按 ADR-0060 恒回空）；实现原样保留，供恢复用。
 */
async function nextEpisodeItem(row, accountId) {
  const p = metaBridge.parseItemId(row.item_id);
  if (!p || p.season === null || p.episode === null) return null;
  const domain = p.domain;

  let season = p.season;
  let episode = p.episode;
  if (row.played) {
    /* 已看完 → 往后找**真实存在、且没被隐藏**的那一集：同一季里往后退；
     * 本季到头就试下一季第 1 集（只试一次，与原来的口径一致）；
     * **被隐藏的集跳过** —— 客户端"从继续观看里移除"的就是它在列表里点的那一条，
     * 移除之后该让位给下一集（真机实测：隐藏会让那条从「Resume」消失）。
     * 上限 50 次：源与上游对不上时别在这里空转，找不到就如实跳过这部剧（ADR-0008）。 */
    let cur = { season, episode: p.episode + 1 };
    let fellBack = false;
    let found = null;
    for (let i = 0; i < 50 && !found; i += 1) {
      if (!(await episodeExists(domain, p.entryId, cur.season, cur.episode))) {
        if (fellBack) break; // 下一季第 1 集也不存在 → 放弃
        fellBack = true;
        cur = { season: p.season + 1, episode: 1 };
        continue;
      }
      const id = metaBridge.itemId(domain, 'tv', p.entryId, cur.season, cur.episode);
      if (Number((db.getPlayback(accountId, id) || {}).hidden) === 1) cur = { season: cur.season, episode: cur.episode + 1 };
      else found = cur;
    }
    if (!found) return null;
    season = found.season;
    episode = found.episode;
  }

  const nextId = metaBridge.itemId(domain, 'tv', p.entryId, season, episode);
  const next = db.getPlayback(accountId, nextId);
  if (next) return progressItem(next, accountId);
  /* 下一集还没看过 → 库里没有它的行。造一条**只用于组装、不写库**的临时行，
   * 其余字段沿用最近那条（`progressItem` 只用到 `item_id` 与坐标）。 */
  return progressItem(
    Object.assign({}, row, { item_id: nextId, position_ticks: 0, played: 0, season, episode }),
    accountId
  );
}

/**
 * 上游的季数据里有没有这一集（「接下来看」只回真实存在的下一集）。
 * **当前未被调用**（ADR-0060）；实现原样保留，供恢复用。
 */
async function episodeExists(domain, entryId, season, episode) {
  const look = await metaBridge.lookupSeason({ entryId, season, domain });
  if (!look.ok) return false;
  return (look.item.episodes || []).some((e) => Number(e.episodeNumber) === Number(episode));
}

/**
 * 一部剧的**第一集**（库里没有这部剧的进度时由 `getNextUp` 补一条）。
 *
 * 季号、集号都取最小的那一个，且要**上游真实存在** —— 季按升序找，第一季里没有集
 * 就试下一季，全都没有就回 null，不编（ADR-0008）。特别篇（S0）不参与，与 `getSeasons` 同口径。
 * 组装仍走 `progressItem`：没看过的一集位置 0、未看，客户端点它就是从头发起。
 *
 * **当前未被调用**（ADR-0060）；实现原样保留，供恢复用。
 */
async function firstEpisodeItem(seriesId, accountId) {
  const p = metaBridge.parseItemId(seriesId);
  if (!p || p.type !== 'tv' || p.season !== null) return null;

  const show = await metaBridge.lookup({ type: 'tv', entryId: p.entryId, withSeasons: true, domain: p.domain });
  if (!show.ok) return null;
  const seasons = (show.item.seasons || [])
    .filter((s) => Number.isFinite(s.seasonNumber) && s.seasonNumber > 0)
    .map((s) => s.seasonNumber)
    .sort((a, b) => a - b);

  for (const n of seasons) {
    const season = await metaBridge.lookupSeason({ entryId: p.entryId, season: n, domain: p.domain });
    if (!season.ok) continue;
    const first = (season.item.episodes || [])
      .filter((e) => Number.isFinite(e.episodeNumber))
      .map((e) => e.episodeNumber)
      .sort((a, b) => a - b)[0];
    if (first === undefined) continue;
    const id = metaBridge.itemId(p.domain, 'tv', p.entryId, n, first);
    const row = db.getPlayback(accountId, id);
    if (row) return progressItem(row, accountId); // 有隐藏过的旧行也照它的位置回
    return progressItem({ item_id: id, series_id: seriesId, position_ticks: 0, played: 0, hidden: 0 }, accountId);
  }
  return null;
}

/**
 * `ItemCounts` 的 14 个字段（Emby 官方 schema，全是 int32）—— 一个都不能少：
 * 客户端常常直接读 `counts.MovieCount`，字段缺失拿到的是 `undefined`，而这个形状本身没有
 * "未知"这种取值，所以只能是数字。
 */
const ITEM_COUNT_FIELDS = [
  'MovieCount',
  'SeriesCount',
  'EpisodeCount',
  'GameCount',
  'ArtistCount',
  'ProgramCount',
  'GameSystemCount',
  'TrailerCount',
  'SongCount',
  'AlbumCount',
  'MusicVideoCount',
  'BoxSetCount',
  'BookCount',
  'ItemCount',
];

/**
 * GET /Items/Counts —— 全库各类条目的数量
 *
 * **只填 `MovieCount` / `SeriesCount` / `EpisodeCount`，其余字段留 0。**
 *
 *   - 电影 / 剧集 / 集数：取**首页插件申报的库规模**（`home.libraryTotals()`，按库类型归并）。
 *     这是插件自己报的**整个库的规模**（与 `run` 的 `total` 同口径，见 ADR-0051/0052），
 *     不是"这一页/这一榜有多少条"。`EpisodeCount` 来自剧库行申报的 `episodes`（见 ADR-0053）。
 *   - 其余字段：面板没有片库索引，**数不出来**，如实留 0。`ItemCounts` 的形状里没有"未知"
 *     这种取值（14 个字段都是数字），只能填 0 —— **0 的意思是"数不出来"，不是"库是空的"**。
 *   - 连这几类都拿不到（插件没申报该类型的规模）时，那个字段也是 0，同样含义。
 *
 * 参数（`ParentId` 等）全忽略 —— 这个端点回的是实例级的总数，不分范围。
 * **AccessToken 由路由层校验**（16-1 起对齐真机：真机无 token / 无效 token → 401；有效 token +
 * 任意 UserId → 200）。计数是内容数据、与用户无关，故**只验 token、不比对 UserId**。
 */
function getItemCounts() {
  const body = {};
  for (const k of ITEM_COUNT_FIELDS) body[k] = 0;
  const totals = home.libraryTotals();
  if (totals.movies !== null) body.MovieCount = totals.movies;
  if (totals.tvshows !== null) body.SeriesCount = totals.tvshows;
  if (totals.episodes !== null) body.EpisodeCount = totals.episodes;
  const got = [];
  if (totals.movies !== null) got.push(`电影 ${totals.movies}`);
  if (totals.tvshows !== null) got.push(`剧集 ${totals.tvshows}`);
  if (totals.episodes !== null) got.push(`集数 ${totals.episodes}`);
  return {
    status: 200,
    body,
    log: got.length
      ? `首页插件申报的库规模 → ${got.join(' / ')}；其余字段 0（数不出来）`
      : '首页插件没申报库规模 → 全 0（数不出来，不是库空）',
  };
}

/**
 * 认「按类型计数」探针：`IncludeItemTypes` 归一后是**单一** `Movie` 或 `Series`，且**没有**
 * `ParentId` / `AnyProviderIdEquals`（`Filters` / `SearchTerm` 在 `getItems` 里已先返回，到不了这）。
 * 命中回 `libraryTotals()` 的键（`movies` / `tvshows`，与 `Items/Counts` 同一口径）；其余回 `null`。
 *
 * 只认**单类型** —— `Movie,Series` 这类多值不猜（真机怎么合并没有样本）。
 */
function typeCountProbeOf(query) {
  const get = (k) => (query && typeof query.get === 'function' ? query.get(k) || '' : '');
  if (get('ParentId') || get('AnyProviderIdEquals')) return null;
  const want = get('IncludeItemTypes').trim();
  if (/^movie$/i.test(want)) return 'movies';
  if (/^series$/i.test(want)) return 'tvshows';
  return null;
}

/**
 * 条目列表的**唯一分派**：认这条 query 归哪一支 —— 「哪条 query 归哪一支」的判定只此一处，
 * `getItems` 照它给的支路干活（次序与判据都收在这里，收敛不改正负）。
 *
 * 次序即优先级（与既有行为一字不差）：
 *   ① `Filters=IsFavorite` → `favorite`（读 `favorite` 表）
 *   ② `Filters=IsPlayed`   → `played`（读 `playback` 表）
 *   ③ `SearchTerm`         → `search`（按名字搜）
 *   ④ `AnyProviderIdEquals` 有可识别候选 → `provider`（按外部 id 定位一条）
 *   ⑤ 裸列表查询（`libraryQueryOf`）→ `views`（回顶层库列表，[ADR-0055]）
 *   ⑥ `feedOfQuery` 认出的轮播推荐位 → `feed`（交给插件声明的那一行）
 *   ⑦ 其余 → `delegate`（交给首页模块；取不到时再用 `probe` / `skipped` 兜底）
 *
 * 回的是**支路描述**（分支名 + 该支路要用的入参），无副作用、不打日志 —— 「归哪一支」与
 * 「怎么干」分开，后者仍住在 `getItems`。
 */
function itemsQueryBranch(query) {
  const val = (k) => (query && typeof query.get === 'function' ? query.get(k) || '' : '');
  const filters = val('Filters');
  if (/IsFavorite/i.test(filters)) return { branch: 'favorite', filters };
  if (/IsPlayed/i.test(filters)) return { branch: 'played' };
  if (searchTermOf(query)) return { branch: 'search' };
  const providerRefs = searchProviderRefs(query);
  if (providerRefs.refs.length) return { branch: 'provider', refs: providerRefs.refs, skipped: providerRefs.skipped };
  if (libraryQueryOf(query)) return { branch: 'views' };
  const feed = feedOfQuery(query);
  if (feed) return { branch: 'feed', feed };
  return { branch: 'delegate', probe: typeCountProbeOf(query), skipped: providerRefs.skipped };
}

/**
 * GET /Users/{UserId}/Items —— 条目列表
 *
 * **列表数据由首页模块决定，emby 层只做端点映射与 DTO 转换**（见
 * docs/emby-home-plugin.md）。分支如下：
 *   - `SearchTerm=<词>` → **按名字搜**（元数据插件搜索；SenPlayer 的搜索框走这条）
 *   - `AnyProviderIdEquals={域}.{编号}` → **按外部 id 搜一条**（回一条带本面板 Id 的条目，客户端接着进详情）。
 *     该参数可**逗号分隔多值**，语义是"任一条对上就算"（见 `searchProviderRefs`）：按序逐个试，先命中先返回
 *   - `ParentId=<mbphome_…>`（本面板发给客户端的媒体库 Id，见 getViews）→ `home.listByQuery` 跑对应插件行
 *   - 无 `ParentId` 且 `SortBy` 含 `IsFavoriteOrLiked` 的**轮播推荐位** → 路由到插件声明了
 *     `feed` 的行（判据见 `feedOfQuery`），回行内**条目**（见 [ADR-0054]）
 *   - 无 `ParentId` 的**裸列表查询**（只带 `ExcludeItemTypes` / `StartIndex` / `Limit` / `Fields`，
 *     无 `SortBy` / `Recursive`）→ 回**顶层库列表**（即 `Views` 那份），对齐真机（判据见
 *     `libraryQueryOf`，见 [ADR-0055]）
 *   - `Filters=IsPlayed` → 读 `playback` 表（**已看的条目，真数据**）；`Filters=IsFavorite` → 读 `favorite` 表
 *     （**收藏的条目，真数据；快照重建，0 上游请求**，见 ADR-0058）
 *   - 无 `ParentId` 的「按类型计数」探针（`IncludeItemTypes` 归一后是单一 `Movie` / `Series`）→
 *     取插件申报的库规模回 `TotalRecordCount`
 *   - 其余查询（含认不出的 `AnyProviderIdEquals`、`Ids=…`）→ **如实回空**
 *
 * **分页是协议的事，但 emby 层不做切片**：客户端给的 `StartIndex` / `Limit` **原样透传给模块**
 * （进 `ctx.startIndex` / `ctx.limit`），取哪一页由**插件**决定；模块回来的 `total` 直接当
 * `TotalRecordCount`。`SortBy` / `Recursive` / `IncludeItemTypes` 忽略 —— 插件返回的顺序就是它想要的顺序。
 *
 * 插件行取数失败 → **照实回失败码**（与上游同一取向：不编占位数据、不回空的假成功）。
 *
 * 上面的分支次序与判据收在 `itemsQueryBranch`（**唯一分派处**）—— 本函数只按它给的支路干活。
 */
async function getItems(req, requestedId, query) {
  const val = (key) => (query && typeof query.get === 'function' ? query.get(key) || '' : '');
  const empty = (log) => ({ status: 200, body: { Items: [], TotalRecordCount: 0 }, log });

  /* **归哪一支只此一处**（见 `itemsQueryBranch`）：这里只按它给的支路把活干完。 */
  const branch = itemsQueryBranch(query);

  /* 用户级筛选：`IsPlayed` 读 `playback` 表；`IsFavorite` 读 `favorite` 表 —— 都是**真数据**。 */
  if (branch.branch === 'favorite') {
    /* 账号从 **token** 认（权威），UserId 只是兜底 —— 与 IsPlayed 同口径，本端点不校验 UserId */
    const accountId = accountIdFor(req, requestedId);
    if (!accountId) return empty('Filters=IsFavorite（账号认不出 → 空）');
    /* 收藏是**写时快照**：读侧只查库 + 纯 CPU 重建 DTO，**0 上游请求**（见 ADR-0058） */
    const want = val('IncludeItemTypes');
    const rows = db.listFavorites(accountId, limitOf(query, 50));
    const items = [];
    let skipped = 0;
    for (const r of rows) {
      let snap = null;
      try {
        snap = JSON.parse(r.payload);
      } catch {
        snap = null; // 快照坏了（不该发生）→ 跳过并计数，不静默吞
      }
      const it = favoriteDto(snap);
      if (!it) {
        skipped += 1;
        continue;
      }
      if (want && !new RegExp(it.Type, 'i').test(want)) continue;
      items.push(it);
    }
    return {
      status: 200,
      body: { Items: items, TotalRecordCount: items.length },
      log:
        `Filters=IsFavorite：库里 ${rows.length} 条 → 列出 ${items.length} 条（快照重建，0 上游请求）` +
        (skipped ? `（${skipped} 条快照不可用，未列出）` : '') +
        briefIds(items),
    };
  }
  if (branch.branch === 'played') {
    /* 账号从 **token** 认（权威），UserId 只是兜底 —— 5-2 起本端点不校验 UserId（对齐真机） */
    const accountId = accountIdFor(req, requestedId);
    if (!accountId) return empty('Filters=IsPlayed（账号认不出 → 空）');
    const want = val('IncludeItemTypes');
    const rows = db.listPlayed(accountId, limitOf(query, 50)).filter((r) => {
      if (!want) return true;
      const p = metaBridge.parseItemId(r.item_id);
      if (!p) return false;
      return p.type === 'movie' ? /movie/i.test(want) : /episode|series/i.test(want);
    });
    return progressList(rows, accountId, 'Filters=IsPlayed');
  }

  /* ---- 按名字搜：`SearchTerm=…`（见 `searchTermOf` 那段）----
   * SenPlayer 的搜索框打的就是这条；早期落到"没有可识别的查询参数 → 空"。 */
  if (branch.branch === 'search') return getSearchItems(query);

  /* ---- 搜索/定位：`AnyProviderIdEquals={域}.{编号}` —— 按**外部 id** 找那一条 ----
   *
   * 链路：客户端手里只有一个上游编号（外部链接 / 书签 / 它自己记着的），**拼不出本面板的 Id**，
   * 于是来问一句"这条在本面板的 Id 是多少"；这里回**一条带 Id 的条目**（`{域}_{编号}_{movie|tv}`），
   * 它拿到就接着打详情 → 详情那条同样是"按域坐标反查"，两条路同源。前缀认哪个域由
   * `searchProviderRefs`（走注册表）定，**不写死某个域**。
   *
   * ⚠️ 该分支曾以「列表数据由首页模块决定」为由**删掉过**，后来又**恢复**：
   *   · 模块管的是**首页渲染**（给客户端什么样的行列、每个条目的 Id），
   *     **详情 / 搜索 / 播放本来就归 emby 层** —— 这是既定的分层；
   *   · 而且**详情端点在删它之后一直还在做同一件事**（`richItemDto()` 按坐标反查），
   *     删检索这条只会让两条路不自洽；
   *   · 当时删它的依据是"实测客户端 0 次使用"—— **已被 Rex/0.1.0 推翻**
   *     （它连打两条单值的 `AnyProviderIdEquals={域}.{编号}`，回空之后就拿不到 Id、链路断在那里）。
   *   结论同 `Items/Latest`：某条查询"没人要"只对**当时那批客户端**成立。
   *
   * 类型从 `IncludeItemTypes` 推（`Series`→tv / `Movie`→movie；都没给 → tv，照旧例）；
   * 取不到 → **照实回失败码**（`metaFailure`，不编占位条目）。
   */
  /* 候选来自分类器（`refs` 只在该走 `provider` 支时非空；`skipped` 供兜底日志点名） */
  const refQuery = { refs: branch.refs || [], skipped: branch.skipped || [] };
  if (branch.branch === 'provider') {
    const include = val('IncludeItemTypes');
    const type = /series/i.test(include) ? 'tv' : /movie/i.test(include) ? 'movie' : 'tv';
    /* **OR 语义：按候选顺序逐个试，先命中先返回**。跳过项（前缀没注册、形状不对）点名写进日志，
     * 免得又出现"打了三条、不知道哪条被忽略了"的排查成本。 */
    const skippedNote = refQuery.skipped.length
      ? `；跳过 ${refQuery.skipped.map((s) => `${s.ref}（${s.why}）`).join('、')}`
      : '';
    const candidates = refQuery.refs.map((r) => `${r.domain}.${r.entryId}`).join(',');
    let last = null;
    for (const ref of refQuery.refs) {
      const look = await metaBridge.lookup({ type, entryId: ref.entryId, domain: ref.domain });
      if (!look.ok) {
        last = { error: look.error, what: `${ref.domain}/${type}/${ref.entryId}` };
        continue;
      }
      const item = leanItemDto(Object.assign({}, look.item, { type, parentId: defaultLibraryId() }));
      return {
        status: 200,
        body: { Items: [item], TotalRecordCount: 1 },
        log: `AnyProviderIdEquals=${candidates} → ${type}「${item.Name}」id=${item.Id}（搜索结果，可进详情${skippedNote}）`,
      };
    }
    /* 候选都试完了、一条都没取到 → 如实回失败码（与单候选时同一口径，不回假的空成功） */
    return metaFailure(last.error, last.what);
  }

  /* 无 `ParentId` 的**裸列表查询**（Filmly / 网易爆米花首页首发）→ 照真机回**顶层库列表**：
   * 予初Emby 实测这条与 `GET /Users/{id}/Views` 一字不差（26 个 `CollectionFolder`），
   * 真机对「无 `ParentId` 且不递归」的 `Items` 默认回根的直接子级 = 那些库（见 `libraryQueryOf`、[ADR-0055]）。 */
  if (branch.branch === 'views') return getViews();

  /* 'feed' / 'delegate' 都走「交给首页模块」这一条路：客户端"不要库 Id、只要推荐"的
   * **轮播推荐位**（见 `feedOfQuery`）路由到插件声明了对应 `feed` 的那一行；没有插件声明
   * （`rowByFeed` 回 null）时与 delegate 同路，照常交给模块、取不到再兜底。 */
  const feedRow = branch.branch === 'feed' ? home.rowByFeed(branch.feed) : null;
  const effQuery = feedRow ? withParentId(query, home.viewId(feedRow.pluginId, feedRow.rowId)) : query;
  if (feedRow) {
    console.log(`  ↪ emby「${branch.feed}」行（无 ParentId 的轮播推荐位）→ ${feedRow.pluginId}/${feedRow.rowId}（由插件声明 feed 决定，非写死）`);
  }
  const effVid = feedRow ? home.parseViewId(effQuery.get('ParentId')) : home.parseViewId(val('ParentId'));

  /* token 已在路由层**一律**验过（5-1 对齐真机：无 token 一律 401，不分支路）；
   * **不比对 UserId**（5-2 对齐真机：真机对 Items 只验 token，合法但不存在的 UserId 也照回 200）。 */

  /* 列表数据交给首页模块：它只认自己发出去的库 Id（`mbphome_…`），其余回 null = 不归它管。
   * **分页也一起透传**（`StartIndex`/`Limit` 进 `ctx`）—— emby 层**不切片**：
   * 取哪一页是模块的决定，这里只把结果翻译成 Emby 形状。 */
  let got = null;
  try {
    got = await home.listByQuery(effQuery);
  } catch (e) {
    /* 日志里报**解码后的**「插件/行」，别报 `mbphome_ZXhh…` 那串 —— 排查时没人愿意手解 base64 */
    return homeFailure(e, effVid ? `${effVid.pluginId}/${effVid.rowId}` : val('ParentId'));
  }
  if (!got) {
    /* 无 `ParentId` 的「按类型数个数」探针 —— Rex 等客户端首页拿它读「总统计」：
     *   Items?Recursive=true&IncludeItemTypes=Movie|Series&Limit=1&SortBy=SortName&SortOrder=Ascending
     * 真机实测就是回该类型的库总数（itsmygo：Movie 255 / Series 189；nyamedia：714 / 1635），
     * 客户端只读 `TotalRecordCount`（`Limit=1` 是探针的痕迹，顺手要的那 1 条它不看）。
     * 面板没有按类型的条目索引，但**插件已按库类型申报了规模**（`Items/Counts` 用的同一份
     * `libraryTotals()`）—— 直接拿来用：不编数、不加契约。`Items` 照旧回空（不给样本条目）。 */
    const probe = branch.probe || null;
    if (probe && home.libraryTotals()[probe] !== null) {
      const total = home.libraryTotals()[probe];
      return {
        status: 200,
        body: { Items: [], TotalRecordCount: total },
        log: `IncludeItemTypes=${probe === 'movies' ? 'Movie' : 'Series'}（无 ParentId，按类型计数探针）→ 总数 ${total}（取首页插件申报的库规模，同 Items/Counts）`,
      };
    }
    const provider = val('AnyProviderIdEquals');
    if (!provider) return empty('没有可识别的查询参数 → 空');
    /* 走到这里 = 这一串外部 id **一条候选都没认出来**（有候选的话上面那支早就返回了）。
     * 逐条点名是哪一条、为什么 —— 以前只笼统说「只认「{已注册域}.{编号}」」，排查时还得自己猜。 */
    const why = refQuery.skipped.length
      ? refQuery.skipped.map((s) => `${s.ref}（${s.why}）`).join('、')
      : '只认「{已注册域}.{编号}」';
    return empty(`AnyProviderIdEquals=${provider} → 空（${why}；列表本身由首页模块决定）`);
  }

  return {
    status: 200,
    /* 每个条目的 `ParentId` = **它自己那个库**（这里是准确值，不是 defaultLibraryId 的兜底） */
    body: { Items: (got.items || []).map((it) => homeItemDto(it, home.viewId(got.pluginId, got.rowId))), TotalRecordCount: got.total },
    log:
      `${got.pluginId}/${got.rowId} 库内容 → 本页 ${(got.items || []).length} 条 / 共 ${got.total}` +
      `（StartIndex=${val('StartIndex') || 0} Limit=${val('Limit') || '不限'}，模块透传不切片）` +
      (got.cached ? ' 缓存' : ''),
  };
}

/** `Items/Latest` 不带 `Limit` 时的条数 —— 真机实测就是 20 */
const LATEST_DEFAULT_LIMIT = 20;

/**
 * `Items?SearchTerm=…` —— **按名字搜**（依据见 `searchTermOf`）。
 *
 * 数据来源：元数据插件的「搜索」动作（**归 emby 层** —— 与详情同类：
 * 它是"按坐标/名字去上游反查"，不是"这台服务器上有什么"，所以不走首页模块）。
 *
 * 三条口径，都不猜：
 *   ① **不为结果再打 `lookup()`**：搜索行里的字段够画卡片，详情才需要 rich（见 `searchRowDto`）。
 *      代价是**每类型 1 次上游**（`Limit` 由上游自己的分页决定），不是"结果数 × 1 次"。
 *   ② **按客户端窗口取上游页**（每类型 1 页起、至多 `SEARCH_MAX_UPSTREAM_PAGES` 页）：上游一页
 *      只有 20 条，只取第 1 页就**填不满 `Limit`**（客户端常要 30/40）；而 Emby 客户端见到
 *      `Items.Count < Limit` 就把这页当成最后一页、**再也不翻页**（SenPlayer 6.2.1 实测如此）。
 *      `StartIndex`/`Limit` 在这**一堆结果里切片**，`TotalRecordCount` 如实 = 本地手里的条数
 *      （**不是"上游里有多少条"** —— 那个数本层不知道，不能编）。见 `docs/plugin-contract.md` 的 contract-home.md「分页」。
 *   ③ **跨类型怎么排 = 按名次轮流**（tv#1, movie#1, tv#2, movie#2…）：上游的 tv / movie 是两份
 *      **独立的相关度排序**，谁也不能替谁排序 —— 轮流合并让两份次序都原样保留，不引入跨类型的人造指标。
 *      ⚠️ 曾经按行的 `popularity` 降序合并，**实测是错的**：搜「斗破苍穹」时它把一个叫 `111` 的剧
 *      （上游相关度很低、但 popularity 数字不小）顶到了第 7 位，把真正相关的电影挤下去。
 *
 * 取不到 → **照实回失败码**（与详情/相似同一取向，不编占位条目）：
 * 一个类型失败、另一个有结果时，回有结果的那部分并在日志里写明（部分失败 ≠ 整条失败）。
 */
async function getSearchItems(query) {
  const val = (k) => (query && typeof query.get === 'function' ? query.get(k) || '' : '');
  const term = searchTermOf(query);

  const types = searchTypesOf(val('IncludeItemTypes'));
  const limit = Math.min(Math.max(1, Number(val('Limit')) || SEARCH_DEFAULT_LIMIT), SEARCH_MAX_LIMIT);
  const startIndex = Math.max(0, Number(val('StartIndex')) || 0);
  /* 要取几页上游才够填客户端窗口（见注释 ②）：上游一页 `SEARCH_UPSTREAM_PAGE` 条，
   * `StartIndex + Limit` 越大要的页越多；封顶 `SEARCH_MAX_UPSTREAM_PAGES` 页 */
  const upstreamPages = Math.min(
    Math.max(1, Math.ceil((startIndex + limit) / SEARCH_UPSTREAM_PAGE)),
    SEARCH_MAX_UPSTREAM_PAGES
  );

  /* 按名字去**元数据插件**搜（`metaBridge.search` 是转发层：哪个域、走哪个插件的「搜索」动作都在那里；
   * 名字搜索的缓存也在插件自己那边）。
   * **逐页取到"够填窗口"或"上游给空"为止** —— 只取第 1 页会因 `Items.Count < Limit` 让客户端
   * 误判成末页（见注释 ②），所以每页取 `SEARCH_UPSTREAM_PAGE` 条、不足即停。 */
  const settled = await Promise.allSettled(
    types.map(async (t) => {
      const all = [];
      for (let page = 1; page <= upstreamPages; page++) {
        // eslint-disable-next-line no-await-in-loop
        const rows = (await metaBridge.search(t, term, page)) || [];
        for (const r of rows) all.push(r);
        if (rows.length < SEARCH_UPSTREAM_PAGE) break;
      }
      return all;
    })
  );
  const failures = [];
  const buckets = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      buckets.push(((r.value || []).map((row) => ({ row, type: types[i] }))));
    } else {
      failures.push({ type: types[i], error: r.reason });
    }
  });

  /* 全失败 → 照实回失败码（一个字都不编） */
  if (failures.length === types.length) return metaFailure(failures[0].error, `search/${types.join('+')}`);

  /* 客户端有没有把搜索限制在某个库？（真机会按媒体库过滤）
   * 本层**做不到**：库是插件行**请求时现跑**的，没有"成员索引"可查 ⇒ 一律全局搜，
   * 但**在日志里写明**，免得以后有人以为搜出来的结果被库限制过。 */
  const scopedTo = home.parseViewId(val('ParentId')) ? '（带了库 ParentId，但库没有成员索引 → 全局搜）' : '';

  /* 按名次轮流合并（见本函数注释 ③）：每份列表保持上游给的相关度次序 */
  const rows = [];
  for (let rank = 0; ; rank++) {
    let added = false;
    for (const b of buckets) {
      if (rank < b.length) {
        rows.push(b[rank]);
        added = true;
      }
    }
    if (!added) break;
  }
  const page = rows.slice(startIndex, startIndex + limit);
  const warn = failures.length ? `；${failures.map((f) => f.type + ' 失败(' + (f.error && f.error.code) + ')').join('、')}` : '';

  return {
    status: 200,
    body: { Items: page.map((x) => searchRowDto(x.row, x.type)), TotalRecordCount: rows.length },
    log:
      `搜索「${term}」→ ${rows.length} 条（${types.join('/')}，各取上游至多 ${upstreamPages} 页）` +
      `本页 ${page.length} 条（StartIndex=${startIndex} Limit=${limit}）${warn}${scopedTo}`,
  };
}

/**
 * GET /Users/{UserId}/Items/Latest —— 「最新条目」（客户端首页那几排横向行）
 *
 * **为什么要有这条**：VidHub 3.0.6 的**整个首页**都靠它 —— 拿到 `Views` 之后
 * 逐个库打 `Items/Latest?ParentId=<库Id>`（实测 10 个库 = 10 次）。早期这条会被
 * `Users/:userId/Items/:itemId` 当成"一个 Id 叫 Latest 的条目"吞掉 → 501 → VidHub 首页空白。
 * （`Items/Resume` 曾因同样的路由顺序被吞掉，所以路由必须注册在详情那条**之前**。）
 *
 * 协议的三个要点**按真机实测**定，不猜：
 *   ① **回的是裸数组**，不是 `QueryResult`（真机响应直接以 `[` 开头）；
 *   ② **默认 20 条**（不带 `Limit` 时）；
 *   ③ `StartIndex` 有效（`Limit=2&StartIndex=3` 真的跳过了前 3 条）。
 *
 * **内容是模块决定的**：emby 层**不排序、不筛"入库时间"** ——
 * 真机那边"最新"= 文件入库时间，本层根本没有这个量（没有片库、没有文件）。
 * 插件这一行返回的顺序**就是它认为的"最新"**。所以这里只做三件事：
 * 透传 `ParentId`/`StartIndex`/`Limit` → 翻成 Emby 条目形状 → 把数组原样回出去。
 *
 * `ParentId` 不是本面板的库（含不带 `ParentId`）→ **回空数组**（如实）：
 * 真机那条会跨所有库给结果，它靠的是自己的片库索引；这里没有索引，
 * 要凑就得把每一行都跑一遍（10 次上游），那是拿代价换一个答不准的答案。
 */
async function getLatest(query) {
  const val = (k) => (query && typeof query.get === 'function' ? query.get(k) || '' : '');
  const vid = home.parseViewId(val('ParentId'));

  /* token 已在路由层**一律**验过、**不比对 UserId**（6-1/6-2 对齐真机，与 `getItems` 同口径）。 */

  if (!vid) return { status: 200, body: [], log: 'ParentId 不属于本面板的库 → 空数组（如实）' };

  /* 把协议的默认值**落实成实际参数**再交给模块：`Limit` 缺省补 20（真机默认），
   * `StartIndex` 缺失当 0。复制一份 query 而不是改原件 —— 日志要打客户端**原样**发的参数。 */
  const startIndex = Math.max(0, Number(val('StartIndex')) || 0);
  const limit = Math.max(1, Number(val('Limit')) || LATEST_DEFAULT_LIMIT);
  const effective = new URLSearchParams(query);
  effective.set('StartIndex', String(startIndex));
  effective.set('Limit', String(limit));

  let got = null;
  try {
    got = await home.listByQuery(effective);
  } catch (e) {
    return homeFailure(e, `${vid.pluginId}/${vid.rowId}`);
  }
  if (!got) return { status: 200, body: [], log: '没有可识别的查询参数 → 空数组' };

  const items = (got.items || []).map((it) => homeItemDto(it, home.viewId(got.pluginId, got.rowId)));
  return {
    status: 200,
    /* 裸数组 —— 这条端点的协议形状就是这样，别套 `{Items,…}`（真机实测以 `[` 开头） */
    body: items,
    log:
      `${got.pluginId}/${got.rowId} 最新 → ${items.length} 条` +
      `（StartIndex=${startIndex} Limit=${limit}，顺序由模块决定）` +
      (got.cached ? ' 缓存' : ''),
  };
}

/**
 * 首页插件条目（HomeItem）→ Emby `BaseItemDto`。
 *
 * - **Id 原样带过去**：插件规范**约定**它就是 `{域}_{编号}_{tv|movie}` —— 客户端点这一条时会去打
 *   `/Users/{id}/Items/{这个Id}`，那条走 **上游反查 + 聚合资源**（见指南「五」）。
 *   插件自己编的 Id 照样显示，只是点进去没有资源（模块自己的事，这边不兜底）。
 * - **图片**：插件的 `poster` / `backdrop` 是**完整 URL**，直接编成签名 tag 交给客户端
 *   （见 `imageTag`）。插件没给就不给 `ImageTags`（不承诺）。
 * - `IsFolder`：剧是容器（能进季集）→ true；电影不是 → false。
 *   `baseItem()` 默认给 true，电影必须显式改掉，否则客户端可能当目录去浏览而不是打开详情。
 */
function homeItemDto(it, parentId) {
  const item = baseItem({
    id: it.id,
    /* **父级 = 这个条目所在的那个媒体库**（列表项走的是"它自己那个库"，准确）——
     * 见 defaultLibraryId 上面那段说明：真实 Emby 每条 item 都有 ParentId，
     * 客户端靠它把条目录到某个媒体库下。 */
    parentId,
    name: it.title,
    type: it.type === 'movie' ? 'Movie' : 'Series',
    year: it.year,
    overview: it.overview,
    communityRating: it.rating,
    providerIds: it.providerIds,
    posterUrl: it.poster,
    backdropUrl: it.backdrop,
  });
  item.IsFolder = it.type === 'tv';
  if (it.originalTitle !== undefined) item.OriginalTitle = it.originalTitle;
  if (it.genres !== undefined) item.Genres = it.genres;

  /* 外部链接：真机**列表项**就有（IMDb / 条目站点 / Trakt）。本地手里只有插件给的
   * `providerIds` 与这个条目的 Id，所以**只给能从 Id 推出来的那条** —— 由**插件自己申报**
   * （`register.links`，见 `metaBridge.entryLinks`）：**IMDb 不编**（不知道 tt 号就是不知道）；
   * **Trakt 不给** —— 那个格式已失效（见 `applyRich`）。 */
  const ref = metaBridge.parseItemId(it.id);
  if (ref) {
    const ext = metaBridge.entryLinks(ref.domain, { type: ref.type, entryId: ref.entryId });
    if (ext.length) item.ExternalUrls = ext.map((l) => ({ Name: l.name, Url: l.url }));
  }
  return item;
}

/**
 * 「这个条目属于哪个媒体库」—— **只能给一个兜底值**。
 *
 * 真实 Emby 里每条 item 都有 `ParentId`（它所在的媒体库），客户端会靠它把条目录到某个媒体库下。
 * 这里没有精确答案：**同一部片可以同时出现在多个库里**（`trending` 和 `top_rated` 都有），
 * 而详情请求 `Items/{id}` 里**不带库上下文**（实测 SenPlayer 连 query 都不带）。
 *
 * 所以取第一个**启用**的行当作它的库 —— 至少是一个客户端认识的、有效的库 Id。
 * 列表项不走这里：它们有**准确**的库（`getItems` 直接用它自己那个库 Id）。
 *
 * ⚠️ 这是 best-effort，不是"事实"。客户端若要精确的归属，得由请求带上库上下文。
 */
function defaultLibraryId() {
  try {
    const rows = home.enabledRows();
    const r = rows && rows[0];
    return r ? home.viewId(r.pluginId, r.rowId) : '';
  } catch {
    return '';
  }
}

/** 首页模块取数失败 → 照实回失败（与 metaFailure 同一取向；状态码归类共用 metaBridge.httpStatusOf） */
function homeFailure(error, what) {
  const status = metaBridge.httpStatusOf(error);
  return {
    status,
    body: { error: error.message, code: error.code, home: what },
    log: `首页模块「${what}」取数失败（${error.code}）→ HTTP ${status}`,
  };
}

/** 元数据取数失败 → 照实回失败（状态码与上游一致；网络层由 metaBridge.httpStatusOf 归类） */
function metaFailure(error, what) {
  const status = metaBridge.httpStatusOf(error);
  return {
    status,
    body: { error: error.message, code: error.code, meta: what },
    log: `元数据 ${what} 取不到（${error.code}）→ HTTP ${status}`,
  };
}

/**
 * GET /Shows/{Id}/Seasons —— 剧的季列表（Rex-Standard 实测端点：`Id` 在路径、`UserId` 在 query）
 *
 * 只认剧的 Id（`{域}_{编号}_tv`），季条目 Id 为 `{域}_{编号}_tv_s{n}`（与 itemId/parseItemId 互逆）。
 * 季数据来自同一次详情请求（响应里本来就有 seasons[]），不额外多打一次。
 *
 * 特别篇（`season_number === 0`）**照真机返回** —— 注意上游的季 `name` 是本地化文案
 * （zh-CN 下特别篇叫「特别篇」），所以判定只看 season_number，绝不能匹配名字。见指南「十」#7-1。
 *
 * `UserId` 只当兜底（见指南「十」#7-2）：真机在「有效 token + 合法但不存在的 UserId」下仍回 200，
 * 故不做账号校验，观看看进度由 `applyUserData` 按 token 解出的账号补。
 *
 * 上游取不到 → 照实回失败（与 Items 同一取向，不编占位季）。
 */
async function getSeasons(showId) {
  const parsed = metaBridge.parseItemId(showId);
  if (!parsed || parsed.shape !== 'show') {
    return { status: 404, body: { error: '没有这个剧' }, log: `Id 不是剧 → 404：${showId}` };
  }
  const entryId = parsed.entryId;
  const domain = parsed.domain;
  const showKey = metaBridge.itemId(domain, 'tv', entryId);

  const look = await metaBridge.lookup({ type: 'tv', entryId, withSeasons: true, domain });
  if (!look.ok) return metaFailure(look.error, `tv/${entryId}`);

  const show = look.item;
  const items = (show.seasons || [])
    .filter((s) => Number.isFinite(s.seasonNumber))
    .map((s) => {
      const item = baseItem({
        id: metaBridge.itemId(domain, 'tv', entryId, s.seasonNumber),
        name: s.name || `第 ${s.seasonNumber} 季`,
        type: 'Season',
        year: s.year,
        premiereDate: s.premiereDate,
        overview: s.overview,
        communityRating: s.rating,
        providerIds: { [metaBridge.providerIdKey(domain)]: String(entryId) },
        posterUrl: metaBridge.imageUrlOf(domain, 'w500', s.posterPath || show.posterPath), // 季海报缺失时退回剧海报，免得客户端出白块
      });
      item.Genres = []; // 上游的季没有 genres，空是如实，不套剧的
      item.ChildCount = s.episodeCount;
      item.IndexNumber = s.seasonNumber;
      item.SeriesId = showKey;
      item.SeriesName = show.title || '';
      return item;
    });

  /* 上游的 `seasonCount` 只数常规季（不含特别篇），对账时也只看常规季，免得把特别篇算成多出来的 */
  const regular = items.filter((i) => i.IndexNumber > 0).length;
  const gap = regular !== show.seasonCount ? ` 上游报 ${show.seasonCount} 季` : '';
  return {
    status: 200,
    body: { Items: items, TotalRecordCount: items.length },
    log: `id=${showId} → ${items.length} 季${show.title ? `（上游「${show.title}」）` : ''}${gap}`,
  };
}

/**
 * GET /Shows/{Id}/Episodes —— 某一季的分集列表（Rex-Standard 实测端点）
 *
 * 入参形态（实测）：路径 `Id` 是剧 Id（`{域}_{编号}_tv`），`UserId` 与 `SeasonId` 都在 query，
 * 另有 `EnableTotalRecordCount` / 一长串 `Fields`（忽略 —— 只回手里有的）。
 * `UserId` **不参与鉴权**（8-2 起对齐真机：有效 token + 不存在/不匹配的 UserId 也回 200）——
 * 只在 `applyUserData` 里当**进度兜底**。
 *
 * 季必须能唯一确定：`SeasonId` 取自上一步 Seasons 发出去的季 Id（`{域}_{编号}_tv_s{n}`），
 * 且条目编号要与路径里的剧一致。定不下来就**回空 + 日志写明原因** —— 与 Items 同类处理：
 * 先把客户端的真实调用逼出来，不为没见过的形态现编数据。
 *
 * 分集 Id = `{域}_{编号}_tv_s{n}_e{m}`（与 itemId/parseItemId 互逆）。
 * 分集数据必须走 season 接口（剧接口只有 seasons[] 汇总，没有 episodes[]），见 metaBridge.lookupSeason。
 * 剧名（`SeriesName`）**额外 lookup 一次**取（命中插件缓存、不额外打上游）—— 见指南「十」#8-3。
 */
async function getEpisodes(showId, seasonId) {
  const show = metaBridge.parseItemId(showId);
  /* ⚠️ **路径里给「季 Id」也算数**（真机实测容错）：
   * 官方文档写的是 `Shows/{Id}/Episodes` 里 Id = **剧**，但真机（`emby.example.com`）实测
   * `Shows/{季Id}/Episodes?SeasonId={季Id}` **同样回 200**（212 条，与剧 Id 那条一模一样）——
   * 而 Lumenic/1.0.0 打的就是这种（面板日志里 3 次 `Id 不是剧 → 404：{域}_{编号}_tv_s5`）。
   * 季 Id 里本来就带着剧号与季号，信息不缺，没有理由拒。 */
  if (!show || (show.shape !== 'show' && show.shape !== 'season')) {
    return { status: 404, body: { error: '没有这个剧' }, log: `Id 不是剧 → 404：${showId}` };
  }
  const pathSeason = show.season; // 路径给的是季 → 剧号与季号都从它来

  const empty = (log) => ({ status: 200, body: { Items: [], TotalRecordCount: 0 }, log });
  const season = metaBridge.parseItemId(seasonId);

  let n = null;
  let seasonNote = '';
  if (pathSeason !== null) {
    n = pathSeason;
    /* 路径与 query 都给了季、且两边不一致时**以路径为准**（它就在请求路径上，更具体）——
     * 不一致这件事本身值得记一笔：说明客户端与本层的 Id 认知可能已经漂了。 */
    if (season && season.season !== null && season.entryId === show.entryId && season.season !== pathSeason) {
      seasonNote = `（路径季 S${pathSeason} 与 SeasonId 的 S${season.season} 不一致，以路径为准）`;
    }
  } else {
    if (!season || season.season === null) {
      return empty(seasonId ? `SeasonId 认不出 → 空：${seasonId}` : '没有 SeasonId → 空');
    }
    if (season.entryId !== show.entryId) return empty(`SeasonId 不是这个剧的季 → 空：${seasonId}`);
    n = season.season;
  }
  const look = await metaBridge.lookupSeason({ entryId: show.entryId, season: n, domain: show.domain });
  if (!look.ok) return metaFailure(look.error, `tv/${show.entryId} S${n}`);

  const showKey = metaBridge.itemId(show.domain, 'tv', show.entryId);
  const seasonKey = metaBridge.itemId(show.domain, 'tv', show.entryId, n);
  const seasonName = look.item.name || `第 ${n} 季`;

  /* 剧名（`SeriesName`）：真机每条集都带（见指南「十」#8-3），故照 `progressItem` 的做法再 `lookup` 一次取剧名 ——
   * 走的是元数据插件自己的缓存，实际不额外打上游。
   * ⚠️ 查不到**不影响主结构**：只少一个可选字段，分集照常返回（回退原则，见指南「四」）。 */
  const showLook = await metaBridge.lookup({ type: 'tv', entryId: show.entryId, domain: show.domain });
  const seriesName = showLook.ok ? showLook.item.title || '' : '';

  const items = (look.item.episodes || [])
    .filter((e) => Number.isFinite(e.episodeNumber))
    .map((e) => {
      const item = baseItem({
        id: metaBridge.itemId(show.domain, 'tv', show.entryId, n, e.episodeNumber),
        name: e.name || `第 ${e.episodeNumber} 集`,
        type: 'Episode',
        year: e.year,
        premiereDate: e.premiereDate,
        overview: e.overview,
        communityRating: e.rating,
        providerIds: { [metaBridge.providerIdKey(show.domain)]: String(show.entryId) },
        posterUrl: metaBridge.imageUrlOf(show.domain, 'w300', e.stillPath), // 集的 Primary 图是剧照（still_path），不是海报
      });
      item.IsFolder = false; // 集不是容器（baseItem 默认 true，这里必须改掉）
      item.IndexNumber = e.episodeNumber;
      item.ParentIndexNumber = n;
      item.SeriesId = showKey;
      item.SeasonId = seasonKey;
      item.SeasonName = seasonName;
      item.SeriesName = seriesName;
      if (e.runtimeMinutes) item.RunTimeTicks = e.runtimeMinutes * 600000000; // 1 分钟 = 6×10⁸ ticks
      if (e.stillPath) item.PrimaryImageAspectRatio = 1.7777778; // 剧照是 16:9；baseItem 给的是海报比例，这里改回来
      return item;
    });

  return {
    status: 200,
    body: { Items: items, TotalRecordCount: items.length },
    log:
      `id=${showId} ${seasonKey} → ${items.length} 集（${seasonName}）` +
      (pathSeason !== null ? '（路径给的是季 Id —— 真机也接受这种打法）' : '') +
      seasonNote,
  };
}

/**
 * 上游的 `status` → Emby 的剧状态。**Emby 只认 `Continuing` / `Ended` 两个值**，
 * 别的写法客户端会当成未知（等于白给）。电影没有这个概念 → 回空、不挂这个字段。
 */
function statusOf(s) {
  const v = String(s || '');
  if (/Returning Series|In Production|Planned|Pilot/i.test(v)) return 'Continuing';
  if (/Ended|Canceled|Cancelled/i.test(v)) return 'Ended';
  return '';
}

/**
 * 把 `lookup({rich:true})` 那一批铺到详情 DTO 上 —— **详情页"丰富度"就在这里**。
 *
 * 全部来自**同一次**上游请求的 append 结果（不额外打上游）。每项都是「有才给、没有就不挂」：
 * 编不出真值的东西一律留空，宁可页面上少一块，也不给假数据。
 *
 * 刻意**没做**的几项（都写了理由，免得以后反复琢磨）：
 *   · `OriginalLanguage`：上游给 2 位码（`en`）、Emby 要 3 位码（`eng`），映射表容易错，而客户端基本不显示。
 *   · `CriticRating`（媒体评分）：上游没有这个数据（它的 vote 是用户评分）。
 *   · 演员头像：要再开一个「人物图片」端点（`Items/{personId}/Images/Primary`），人物不是本层的条目 —— 先不碰。
 *   · `ScreenshotImageTags`：上游没有"截图"这个独立类别，它那些就是背景图，给了等于重复。
 *   · 合集（Boxset）：Emby 里是另一类条目，要单独建，不是塞个字段就行。
 */
function applyRich(item, got, domain) {
  if (got.overview) item.Overview = got.overview; // rich 的简介更长，覆盖列表用的短版
  if (got.certification) item.OfficialRating = got.certification; // PG-13 / TV-MA 那个徽章
  if (got.runtimeMinutes > 0) item.RunTimeTicks = got.runtimeMinutes * 600000000; // 1 分钟 = 6e8 ticks
  if (got.tagline) item.Taglines = [got.tagline];
  /* 制片公司：**必须带 `Id`**（真机是 `NameLongIdPair`，Id 是**数字**）。
   * 实测：SenPlayer 曾打不开本层的详情，而换成真机响应（Studios 带 Id）就正常 ——
   * 客户端模型里缺这个键会让**整个响应解码失败**。 */
  if (got.productionCompanies && got.productionCompanies.length) {
    /* 按 Id 去重：上游的 `production_companies` 会**重复**（实测同一部片里同一个公司出现两次），
     * 真机的 `Studios[]` 不会重复。 */
    const seenStudio = new Set();
    item.Studios = got.productionCompanies
      .map((c) => ({ Id: Number(c.id) || 0, Name: c.name }))
      .filter((c) => (seenStudio.has(c.Id) ? false : seenStudio.add(c.Id)));
  }
  if (got.productionCountries && got.productionCountries.length) item.ProductionLocations = got.productionCountries;
  if (got.keywords && got.keywords.length) item.Tags = got.keywords;
  /* 类型带 id：客户端点"动作"能跳该类型列表。⚠️ 那个端点还没实现（会 501）——
   * 这正是"先给承诺、看客户端要什么"的用法（`ImageTags` 早期就是这样把图片端点逼出来的）。
   * Id 用**数字**（真机 `{"Id":65,"Name":"剧情"}` 就是数字；早期给的是字符串，类型对不上解码器）。 */
  if (got.genreItems && got.genreItems.length) item.GenreItems = got.genreItems.map((g) => ({ Id: Number(g.id) || 0, Name: g.name }));

  /* 演职人员：演员给 `Role`（角色名），导演/编剧翻成 Emby 的 `Type`。
   *
   * `Id` **必须给**：曾经刻意不给（"人物不是本层的条目，给了 Id 客户端就会去点、
   * 去要人物图片"），但真机**每条都带 Id**，缺它会让客户端的解码器**整条响应失败** ——
   * 代价远大于收益。这条是**无条件的**：SenPlayer 只认"键在不在"，缺一条就整条详情报
   * 「网络错误 / 当前媒体库不存在该项目」（Rex 容错所以看不出问题）—— 所以**插件没给
   * `personId` 时也要补一个稳定派生 id**，不能把 `Id` 键整个省掉。
   *   有插件给的人物 id（域给的编号就是它自己的人物号）就用它；没有（有些域的导演常没给）
   *   就用 `p-<md5(域|名字)>` 派生，前缀 `p-` 与纯数字 id 不会撞，且同一人物稳定不变。
   *
   * **顺带把人物头像也做通**：有 `profilePath` 的就给
   * `PrimaryImageTag`，走的还是**已有的图片端点** —— `tagAndRemember` 会把
   * 「人物id|Primary|0 → 图床地址」记进索引，客户端带不带 tag 都取得到（见 routes.js 的图片端点）。
   * 没有头像的（`profilePath` 为空）就**不给** `PrimaryImageTag`，客户端因此不会去要（不承诺）。 */
  const people = [];
  const pushPerson = (p, extra) => {
    const one = Object.assign({ Name: p.name }, extra);
    one.Id = p.personId
      ? String(p.personId)
      : 'p-' + crypto.createHash('md5').update(String(domain || '') + '|' + String(p.name || '')).digest('hex').slice(0, 16);
    const avatar = p.profilePath ? tagAndRemember(one.Id, 'Primary', 0, metaBridge.imageUrlOf(domain, 'w185', p.profilePath)) : '';
    if (avatar) one.PrimaryImageTag = avatar;
    people.push(one);
  };
  for (const p of got.cast || []) pushPerson(p, { Role: p.role, Type: 'Actor' });
  for (const p of got.crew || []) pushPerson(p, { Type: p.job === 'Director' ? 'Director' : 'Writer' });
  if (people.length) item.People = people;

  const st = statusOf(got.status);
  if (st) item.Status = st;

  /* 外部链接：**名字与顺序照真机**（实测：电影 IMDb → 条目站点 → [Trakt]、剧 IMDb → 条目站点
   * → TheTVDB → [Trakt]）。客户端有可能会按名字认这几个链接，所以名字不自创。
   * 每一条的来源：IMDb/TheTVDB ← 插件给的 `externalIds`；条目站点那一条 ← 插件在 `register.links`
   * 里申报的模板（`{type}` / `{id}` 由面板替换）—— 面板不认识任何具体站点。
   *
   * ⚠️ **Trakt 刻意不给**（实测后去掉）：真机给的是 `https://trakt.tv/search/<站点>/{id}`
   * 形状的深链，而 **Trakt 已经下架了这条深链** —— 影、剧、IMDb 三种形状实测**全部 404**
   * （`404: Nothingness. The void.`），同站有效路由（`/shows/breaking-bad`）却正常 200
   * ⇒ 是路由被删，不是被墙/UA。Trakt 的条目页要用**它自己的 id/slug**，本地手上只有上游编号，
   * **造不出能用的直链**——那就**不给**：发一条必 404 的死链比不发更糟（同"不知道就空字段"的口径）。
   * 哪天 Trakt 又支持了、或者能拿到它的 id，再加回来。 */
  const urls = [];
  const isMovie = got.type === 'movie';
  if (got.externalIds && got.externalIds.imdb) {
    urls.push({ Name: 'IMDb', Url: `https://www.imdb.com/title/${got.externalIds.imdb}` });
  }
  /* 条目站点那条由**插件自己申报**：面板不认识任何具体站点，而条目编号是**提供者自己的**
   * （数字或 slug 都可能），拿它去拼别家的链接会是一条必 404 的假链 */
  for (const l of metaBridge.entryLinks(domain, { type: got.type, entryId: got.entryId })) {
    urls.push({ Name: l.name, Url: l.url });
  }
  if (!isMovie && got.externalIds && got.externalIds.tvdb) {
    urls.push({ Name: 'TheTVDB', Url: `https://thetvdb.com/?tab=series&id=${got.externalIds.tvdb}` });
  }
  if (got.homepage) urls.push({ Name: '官网', Url: got.homepage });
  if (urls.length) item.ExternalUrls = urls;

  if (got.trailers && got.trailers.length) {
    item.RemoteTrailers = got.trailers.map((t) => ({ Name: t.name, Url: t.url }));
    item.TrailerCount = got.trailers.length;
  }
}

/**
 * 一条「列表项形状」的 BaseItemDto（**轻量**：元数据 + 图片，不带 rich）。
 *
 * 三处用它，形状必须一致（客户端都靠 `Id` 点进详情）：
 *   · `Items/{id}/Similar` 的相似推荐条目；
 *   · `Items?AnyProviderIdEquals={域}.{编号}` 搜到的那一条（见 `getItems` 的搜索分支）；
 *   · 首页模块给的列表项走 `homeItemDto()`（同样形状，只是数据来自插件）。
 */
function leanItemDto(r) {
  /* 域决定三样：条目 Id 的前缀、`ProviderIds` 的键、图片基地址。
   * 调用方都该显式给域（搜索行、相似推荐、播放项都带 `domain`）；真没给时再现算一个兜底域
   * （见 `metaBridge.defaultDomain` —— 按实例配置/已启用插件现算，不是写死某个域）。 */
  const domain = r.domain || metaBridge.defaultDomain();
  const entryId = r.entryId;
  const item = baseItem({
    id: metaBridge.itemId(domain, r.type, entryId),
    /* 搜索命中的那一条没有库上下文 → 由调用方给兜底库（`defaultLibraryId()`）；相似推荐不给 */
    parentId: r.parentId,
    name: r.title,
    type: r.type === 'movie' ? 'Movie' : 'Series',
    year: r.year,
    overview: r.overview,
    communityRating: r.communityRating,
    providerIds: { [metaBridge.providerIdKey(domain)]: String(entryId) },
    posterUrl: metaBridge.imageUrlOf(domain, 'w500', r.posterPath),
    backdropUrl: metaBridge.imageUrlOf(domain, 'w780', r.backdropPath),
  });
  item.IsFolder = r.type === 'tv';
  /* 有就带上（相似推荐那份没有这几个键 → 不填，输出与以前一致） */
  if (r.originalTitle !== undefined) item.OriginalTitle = r.originalTitle;
  if (r.genres !== undefined) item.Genres = r.genres;
  if (r.seasonCount !== undefined) item.ChildCount = r.seasonCount;
  return item;
}

/**
 * 按条目坐标组装一条「剧 / 影」的 BaseItemDto —— **详情（`Items/{Id}`）用**。
 *
 * 为什么单独放一份：客户端点进某一条时打的是 `/Users/{Id}/Items/{ItemId}`，那条**必须**能按
 * 坐标把元数据反查回来（否则点进去就是 404）。这就是「点击条目 → 反查显示资源」里的"反查"那一环。
 *
 * ⚠️ 它比 `leanItemDto()` **重**（`rich: true`，一次带回分级/时长/演职/图集/相似）—— **只在详情用**；
 * 搜索/相似那些「列表项」用 `leanItemDto()`，别拿这个去凑数。
 *
 * 入参是面板中立坐标（域 + 该域的条目编号 + 类型）；翻译成 Emby 字段（`Id` / `Type` / `ProviderIds`…）
 * 全在这一层做。
 */
async function richItemDto(type, entryId, domain = metaBridge.defaultDomain()) {
  const look = await metaBridge.lookup({ type, entryId, rich: true, domain });
  if (!look.ok) return { ok: false, error: look.error };

  const got = look.item;
  const item = baseItem({
    id: metaBridge.itemId(domain, type, entryId),
    /* 详情/相似没有库上下文 → 用兜底库（见 defaultLibraryId）。列表项另有准确值。 */
    parentId: defaultLibraryId(),
    name: got.title,
    type: type === 'movie' ? 'Movie' : 'Series',
    year: got.year,
    premiereDate: got.premiereDate,
    overview: got.overview,
    communityRating: got.communityRating,
    providerIds: { [metaBridge.providerIdKey(domain)]: String(entryId) },
    posterUrl: metaBridge.imageUrlOf(domain, 'w500', got.posterPath),
    backdropUrl: metaBridge.imageUrlOf(domain, 'w780', got.backdropPath),
    backdropUrls: (got.backdropPaths || []).map((p) => metaBridge.imageUrlOf(domain, 'w780', p)),
    logoUrl: metaBridge.imageUrlOf(domain, 'w500', got.logoPath),
  });
  item.OriginalTitle = got.originalTitle;
  item.Genres = got.genres;
  item.ChildCount = got.seasonCount;
  /* 剧是容器（能进季集）→ true；**电影不是** → false。`baseItem()` 默认给 true，
   * 电影必须显式改掉，否则客户端可能当目录去浏览而不是打开详情。 */
  item.IsFolder = type === 'tv';
  applyRich(item, got, domain);
  /* 交给调用方的"搜源用名字"：主标题没中文时已在 lookup 里回退成中文别名（见 emby/meta-bridge.js） */
  return { ok: true, item, searchTitle: got.searchTitle || got.title };
}

/**
 * GET /Items/{ItemId}/Similar —— 「相似 / 更多类似」。
 *
 * **归 emby 层**（和 `Shows/{Id}/Seasons`、`Items/{id}` 同类）：它是**按条目的上游坐标去上游
 * 反查回来的关联内容**，不是"这台服务器上有什么" —— 所以不走首页模块。
 * 数据就来自详情那次 lookup 的 `recommendations`（**同一次上游请求**，不额外打）。
 *
 * **AccessToken 由路由层校验、且只验 token、不比对 `UserId`**（17-1 起对齐真机，见「十」#17）：
 * 端点是**取上游的关联内容**（内容数据、与具体用户无关），真机实测不校验 `UserId`（错配 / 不存在 / 不带 → 均 200）。
 * 进度仍由路由层 `applyUserData(out, userId, req)` 按 **token 解出的账号**补（`accountIdFor` token 优先）。
 *
 * 响应形状 = `QueryResult<BaseItemDto>`（`{Items, TotalRecordCount}`），经真机实测复核（形状一致 ✓）。
 */
async function getSimilar(itemId, limit) {
  const p = metaBridge.parseItemId(itemId);
  if (!p) return { status: 404, body: { error: '没有这个条目' }, log: `Id 认不出 → 404：${itemId}` };

  const look = await metaBridge.lookup({ type: p.type, entryId: p.entryId, rich: true, domain: p.domain });
  if (!look.ok) return metaFailure(look.error, `${p.type}/${p.entryId}`);

  /* 相似推荐是**同一个域**里的条目 → 把域带进每一行（推荐项自己没有域字段）。 */
  const all = (look.item.recommendations || []).map((r) => leanItemDto(Object.assign({}, r, { domain: p.domain })));
  const n = Number(limit) > 0 ? Number(limit) : all.length;
  const items = all.slice(0, n);
  return {
    status: 200,
    body: { Items: items, TotalRecordCount: items.length },
    log: `${p.type}/${p.entryId} → ${items.length} 条相似${n !== all.length ? `（Limit=${n}，上游给了 ${all.length}）` : ''}`,
  };
}


/**
 * GET /Users/{UserId}/Items/{ItemId} —— 按 Id 取单条详情
 *
 * 两个数据来源，各司其职：
 *   ① 元数据（名字 / 简介 / 图片 / 集号…）—— **上游反查**。客户端认的是本面板发出去的 Id，
 *      所以必须回**同一个对象**（形状与列表里那条一致）。
 *   ② 源绑定 —— 用上游的**影视名**，交给聚合层（`agg/api.js` 的 `detail()`，**进程内直调**）搜一遍，
 *      挑同名条目，命中结果落到日志与 `ProviderIds.MediaBridge` / `MediaBridgeSource`。
 *
 * 实现上尽量不重复组装逻辑：季/集**复用列表实现**（`getSeasons` / `getEpisodes`）再挑出那一条；
 * 剧/影走 `richItemDto()`（rich 版反查）—— 它是详情专用，别和列表项那套混。
 * 聚合只做补充：连不上 / 没配 → 元数据照常返回（日志写明原因），详情页不至于打不开。
 * 粒度说明：站源只有「剧」级条目（`vod_id` 是剧），**集的定位要等聚合层给 detail 契约**。
 */
async function getItem(itemId) {
  const p = metaBridge.parseItemId(itemId);
  if (!p) return { status: 404, body: { error: '没有这个条目' }, log: `Id 认不出 → 404：${itemId}` };

  /* ---- ① 元数据：按层级复用列表实现，再挑出这一条 ---- */
  let found = null;
  let name = '';
  let year = '';

  /* 按 `shape` 分派：季 / 集复用列表实现再挑出那一条；剧 / 影直接按域坐标反查（rich 版）。
   * 「哪种 id 归哪一支」只此一处（见 meta-bridge 的 parseItemId 回的 `shape`）。 */
  if (p.shape === 'season' || p.shape === 'episode') {
    const showKey = metaBridge.itemId(p.domain, 'tv', p.entryId);
    if (p.shape === 'episode') {
      const out = await getEpisodes(showKey, metaBridge.itemId(p.domain, 'tv', p.entryId, p.season));
      if (out.status !== 200) return out;
      found = (out.body.Items || []).find((i) => i.Id === itemId);
    } else {
      const out = await getSeasons(showKey);
      if (out.status !== 200) return out;
      found = (out.body.Items || []).find((i) => i.Id === itemId);
    }
    /* 集/季两条列表都不含剧名，而搜索关键词要的就是剧名 → 这里必须问一次剧。
     * ⚠️ 搜源用的是 `searchTitle`（主标题没中文时回退中文别名），**不是** `title`：
     * 客户端看到的仍是被上游标成主标题的那个名字，但拿它去源里搜会一条都对不上
     * （见 emby/meta-bridge.js 的 searchTitleOf）。 */
    const show = await metaBridge.lookup({ type: 'tv', entryId: p.entryId, domain: p.domain });
    if (!show.ok) return metaFailure(show.error, `tv/${p.entryId}`);
    name = show.item.searchTitle || show.item.title;
    year = show.item.year;
  } else {
    /* 剧 / 影：**直接按域坐标反查**（rich 版）——
     * 走到这里时客户端给的是本面板发出去的 Id（`{域}_{编号}_{movie|tv}`），坐标已在手里，不必再借列表绕一圈。
     * 这一环就是「客户端点条目 → 元数据反查显示资源」里的"反查"（见指南「五」）。
     * ⚠️ 与检索那条的关系：`Items?AnyProviderIdEquals={域}.{编号}` 是**反向**的一步
     * （客户端只有上游编号 → 问本面板要 Id），最终都会走到这里。 */
    const look = await richItemDto(p.type, p.entryId, p.domain);
    if (!look.ok) return metaFailure(look.error, `${p.type}/${p.entryId}`);
    found = look.item;
    /* 同上面那条：搜源用 `searchTitle`（可能回退成中文别名），显示名仍旧是 `found.Name` */
    name = look.searchTitle || found.Name;
    year = found.ProductionYear ? String(found.ProductionYear) : '';
  }

  if (!found) return { status: 404, body: { error: '没有这个条目' }, log: `列表里没有 ${itemId} → 404` };

  /* ---- 不可播类型（剧 / 季）：上游元数据照给，**源那一趟不跑** ----
   * Emby 里「剧」「季」是**容器**（真机就是 `IsFolder:true / CanPlay:false`），版本清单
   * （MediaSources）的语义是"这里有 N 个能直接播的文件"，给了客户端会以为整部剧是一个文件、
   * 给出播放入口 —— 而源里每条线路对应的是一集一个文件，点了必然播不出来。
   * 所以按设计**不给版本列表**（下面的 `if (!isPlayable(...)) continue` 就是这条规矩）。
   *
   * 从前是"先把源整趟跑完（4~7 秒）、算出线路与定位，**然后**才判类型、再全丢掉"——
   * 现在把判断提到问聚合层**之前**：结果一模一样（`sources` 为空时下面那些条目级字段
   * 本来也不会被填），只是不再白跑那一趟。实测剧集详情 5~6 秒 → 几十毫秒。 */
  if (!isPlayable(found.Type)) {
    return {
      status: 200,
      body: found,
      log: `id=${itemId}「${name}」→ 非可播类型「${found.Type}」，按设计不给版本列表（没查源站）`,
    };
  }

  /* ---- ② 线路 + 源绑定：把影视名交给聚合层，一次拿回线路与可播目标 ---- */
  /* 电影没有季集号：取法用 `pick: 'items'` —— 聚合层把**每条线路的全部播放项**都列成目标
   * （同一部片的多个压制版本各自成一个版本），见 `wantLocator()` 与 docs/adr/0022。
   * 名字 + 年份 + 季集就是全部输入：聚合层用它们**打分**挑片（`agg/match.js`）。
   * ⚠️ **不再把上游坐标传下去**（早期给"别名回退"用）：判据换成了本地打分，
   * 阈值与"最多留几条"来自**这个域用的那套模板**（`agg/templates.js`）——
   * emby 这条链与 web 的聚合搜索**共用同一套**：`aggregateDetail` 内部那发搜索
   * 也把模板参数原样带下去了（否则会退回内置的 0.85 / 8）。 */
  const hit = await agg.detail(Object.assign({ name, year, domain: p.domain }, wantLocator(p)));
  if (!hit.ok) {
    return {
      status: 200,
      body: found,
      log: `id=${itemId}「${name}」→ 聚合取数失败（${hit.error.code}：${hit.error.message}）→ 只回元数据`,
    };
  }

  const d = hit;
  /* 命中的站**全部**用（已去掉 picked 挑选）—— 聚合层已对每个命中的站取过
   * detail，这里逐站展开：各站有自己的线路清单，也有自己「这一集」的定位。
   * 顺序即聚合层的站点顺序（`agg.order` 的优先级）；第一个站同时当"代表"填 `ProviderIds` 与老字段。 */
  const entries = (d.sites || []).filter((e) => e && e.detail);
  if (!entries.length) {
    const firstErr = (d.sites || []).find((e) => e && e.error);
    return {
      status: 200,
      body: found,
      /* 走到这里 = **没有任何站拿到详情**。三种情况要分开说（按打分口径）：
       *   ① 搜索没命中（打分把它判成"不是这部片"/分数不够）—— `stats.match` 里的各桶计数；
       *   ② 命中了但站源 `/detail` 拿不到线路（源里那一条本身是空壳）；
       *   ③ 站点失败（超时 / 连不上）。
       * 只有真有站**失败**时才带上错误，免得日志把"没有"说成"出错"
       * （实测曾被那句 `：HTTP 404` 误导过一轮）。 */
      log:
        `id=${itemId}「${name}」→ 源里没拿到详情（搜了 ${(d.stats && d.stats.searched) || 0} 站，` +
        `${d.stats && d.stats.match ? `打分：扫 ${d.stats.match.scanned} 条命中 ${d.stats.match.matched}` : '没命中'}` +
        `${firstErr && firstErr.error ? `；站点失败：${firstErr.error}` : ''}）→ 只回元数据`,
    };
  }

  /* 线路过滤**已在聚合层落地**（`agg/service.js` 的 `applyLineFilter`：产出前就把规则不匹配的
   * 线路从 `detail.lines` 里去掉了）—— 所以本层不再自己滤，只把那笔账读出来写进日志/诊断字段。
   * 这样 emby 与出口插件（FW/Rex）拿到的是同一份结果，规则也只有一个实现（见 ADR-0025 / 0043）。 */
  const lfStat = ((d.stats || {}).lineFilter) || null;
  /* ---- 字幕轨：**为一个播放目标问一次**（字幕与线路无关，契约 §七）—— 回来的轨挂到该目标的
   * 每个版本上（电影多压制版本共用同一份轨，见 buildMediaSource）。字幕插件是**软依赖**：
   * 没装 / 没在跑 / `tracks` 失败都只记一行日志、不出字幕轨，**绝不破坏详情本身**
   * （扇出与失败语义见 `subtitle-bridge.js`）。坐标是这个播放目标（片名 + 年份 + 季集），
   * 与线路无关，所以在这里问一次即可。 */
  const subtitles = await subtitleBridge.tracks({
    name,
    originalName: found.OriginalTitle || '',
    year: year || '',
    season: p.season,
    episode: p.episode,
  });
  const bindings = [];
  const siteDigest = [];
  /* 线路 = 版本：**每个站的线路都列出来**。版本行标题位（含"多源时前置源名""同片别名""电影多版本
   * 短标签"）已由**聚合层拼好**写在各目标的 `versionLabel` 上（见 `buildMediaSource` / ADR-0063），
   * 本层不再自己拼。**只有「集」与「电影」可播** —— 剧/季是容器，给了会让客户端以为能播。 */
  const sources = [];
  let firstFileName = ''; // 第一条版本**定位到的那个文件**的名字（条目级 `FileName` 用，见下）
  let totalLines = 0; // 到手的线路总数 —— **已过线路过滤**（过滤前多少条看 `lfStat.before`）
  let noTarget = 0; // 因"没定位到这一集"而不进版本列表的线路数（见下面那处 continue）
  let noRef = 0; // 插件没给 `ref` 的播放项数（正常不会发生：没它这一项点了必然播不了）
  for (const entry of entries) {
    const siteKey = entry.key;
    /* 一个站可能收下**多条条目**：代表（`entry.detail`）+ 同片别名变体（`entry.variants[]`，
     * 见 agg 的 `pickByName`）—— 每条条目各自展开自己的线路。老响应没有 `variants`，
     * 这里就是单条，行为与从前完全一样。 */
    const items = [{ detail: entry.detail, variant: false, label: '' }].concat(entry.variants || []);
    const detailDigests = [];
    for (const item of items) {
      const det = item.detail;
      if (!det) continue;
      const lines = det.lines || [];
      totalLines += lines.length;

      bindings.push(`${entry.source}/${siteKey}|${det.vodId}`);
      const dg = {
        VodId: det.vodId,
        VodName: det.name,
        Variant: !!item.variant,
        Label: item.label || '',
        Lines: lines.map((l) => ({ Flag: l.flag, EpisodeCount: l.episodeCount })),
        Target: det.target
          ? { Flag: det.target.flag, Name: det.target.name, EpisodeId: det.target.id, MatchedBy: det.target.matchedBy }
          : null,
      };
      if (det.targetNote) dg.TargetNote = det.targetNote;
      detailDigests.push(dg);

      /* **兜底**：不可播类型（剧/季）不进版本列表。正常走不到这里 ——
       * 函数开头那个「拿到上游元数据后先判类型」的早返回已经把剧/季挡在聚合层之前了
       * （见 `getItem` 里那段说明）；留着是给以后新增类型时的保险。 */
      if (!isPlayable(found.Type)) continue;
      /* 可播目标：**电影 = 该线路下的每个播放项**（多条压制版本各自成一个版本）；
       * **剧集 = 定位到的这一集**。判据见 `wantLocator`（电影的 `pick: 'items'`）与
       * agg 的 `fetchDetail` items 分支。 */
      const movie = found.Type === 'Movie';
      for (const line of lines) {
        /* ⚠️ **线路过滤不在这里**：`lines` 已经是聚合层滤过的那份（见上面 `lfStat`）——
         * 本层只判"有没有可播目标"，即下面那处 `continue`。 */
        /* **没有可播目标的线路不进版本列表**：列出来的版本，客户端点了就得能播 ——
         * `resolveStream` 是按「线路 + 这一项」回查的，一条没有目标的线路，点了必然 404。
         * 实测（剧集）：`斗破苍穹 S5E171` 的详情是「4 线路，1 条目定位到」，
         * 也就是 4 个版本里只有 1 个真能播；客户端挑了 huban 那条（集名是
         * `[743.2MB]180x.mp4【D斗P苍q 2026/ximg】`，解析不出集号 → 没定位到）→ 拉流 404。
         * 面板**不猜**集号，所以这种线路宁可不出现在列表里（如实"少给"），也不给一条死路。
         * ⚠️ `totalLines` 不动 —— 它数的是**到手**的线路数（已过线路过滤），不因为这一条没定位到就减一。 */
        const targets = movie ? line.items || [] : line.target ? [line.target] : [];
        if (!targets.length) {
          noTarget += 1;
          continue;
        }
        targets.forEach((t) => {
          /* 播放项必须带 `ref` —— 播放时面板把它原样交回插件换地址，没有它这一项点了必然播不了，
           * 所以**不进版本列表**（与上面"没有可播目标的线路不进版本列表"同一口径：宁可少给）。
           * 正常情况下插件每项都会给 ref，走到这里说明插件没照契约做，如实数出来记进诊断。 */
          if (!t.ref) {
            noRef += 1;
            return;
          }
          /* 第一条版本**那个文件**的名字 = 条目级 `FileName` 的真来源
           * （真机给的就是文件名 `10间敢死队.2026….mkv`；版本名是"站点 · 线路"，不是文件名）。 */
          if (!firstFileName && t.name) firstFileName = String(t.name);
          sources.push(
            buildMediaSource({
              itemId,
              line,
              runtimeTicks: found.RunTimeTicks,
              item: t,
              subtitles,
            })
          );
        });
      }
    }
    /* 诊断字段：老字段（单站那几个）取**第一条**（代表条目，兼容既有面板读取），
     * 新增 `Details` 放该站收下的**全部条目**（含变体）。 */
    const head = detailDigests[0] || {};
    const digest = {
      Source: entry.source,
      SourceName: entry.sourceName || '',
      Site: siteKey,
      SiteName: entry.name || '',
      Api: entry.api || '',
      VodId: head.VodId,
      VodName: head.VodName,
      VodPic: (entry.detail || {}).pic,
      VodRemarks: (entry.detail || {}).remarks,
      Lines: head.Lines || [],
      Target: head.Target || null,
      Details: detailDigests,
    };
    if (head.TargetNote) digest.TargetNote = head.TargetNote;
    siteDigest.push(digest);
  }

  /* 源绑定：**每个命中的站都记**（`<源id>/<站点>|<vodId>`，`;` 分隔）—— 客户端不解析它，面板/日志核对用 */
  found.ProviderIds = Object.assign({}, found.ProviderIds, { MediaBridge: bindings.join(';') });
  /* MediaBridgeSource 是非标准字段（Emby 客户端会忽略）：老字段（单站那几个）取**第一个站**以兼容既有文档
   * 与面板读取，新增 `Sites` 放**全部命中站**的明细。 */
  found.MediaBridgeSource = Object.assign({}, siteDigest[0], { Sites: siteDigest });
  /* 有过滤规则时，把「源里多少条 / 留下多少条」一并记进诊断字段（客户端会忽略，面板核对用）。
   * **只有可播类型（集/电影）才算得通**：剧/季根本不会展开版本列表（上面 `if (!isPlayable(...)) continue`），
   * 那种 0 条是设计，不是规则滤的 —— 别把误导写进诊断字段。 */
  if (lfStat && lfStat.raw && isPlayable(found.Type)) {
    found.MediaBridgeSource.LineFilter = {
      Pattern: lfStat.raw,
      /* `Total` = **过滤前**源里多少条（聚合层给的那笔账）；`Kept` = 本层最终列了几个版本 */
      Total: lfStat.before,
      Kept: sources.length,
      Invalid: lfStat.invalid,
    };
  }
  /* 版本标题全局去重：flag 单段化后可能有同名版本（同站不同包、每集大小恰好相同），
   * 撞名才补分辨率/编码/版本序号；只补撞名组，不撞不添（见 ensureUniqueSourceNames）。 */
  ensureUniqueSourceNames(sources);
  if (sources.length) found.MediaSources = sources;

  /* ---- 条目级：把**所选线路**的事实提到条目上（真机就是这么给的）----
   * 真机的条目级也有 `Container`/`MediaStreams`/`Path`/`Size`/`Bitrate`/`FileName`，
   * 而早期只在 `MediaSources[]` 里给 —— SenPlayer 的 `Fields` 里**点名要 `Container` 和
   * `MediaStreams`**，且本层完全忽略 `Fields`，所以它要的字段一个都拿不到。
   * 取第一条版本（= 列表里排第一的那条线路），与真机"单文件条目"的形状一致。 */
  {
    const first = sources[0];
    if (first) {
      if (first.Container) found.Container = first.Container;
      if (first.Size) found.Size = first.Size;
      if (first.Bitrate) found.Bitrate = first.Bitrate;
      if (first.MediaStreams && first.MediaStreams.length) {
        found.MediaStreams = first.MediaStreams;
        /* 条目级 `Width`/`Height`：真机电影条目顶层就给（`3840`/`2160`）。数据来源是片源插件
         * 申报的 `width`/`height`（插件契约已声明该字段，面板解析进视频流后提到条目级）；
         * **插件没给就没有这俩字段** —— 面板不从集名正则反推，避免与真机"扫过文件"的语义混淆。 */
        const vid = first.MediaStreams.find((s) => s.Type === 'Video' && s.Width && s.Height);
        if (vid) {
          found.Width = vid.Width;
          found.Height = vid.Height;
        }
      }
      if (first.Path) found.Path = first.Path;
      /* `FileName` 用**源给的真文件名**（`target.name`，如 `10间敢死队.2026.2160p….mkv`）——
       * 真机给的就是文件名。早期从版本 `Path` 末段取，而那是"站点标签 · 文件名"的副标题，
       * **不是纯文件名**。 */
      if (firstFileName) found.FileName = firstFileName;
    }
  }

  const specs = sources.filter((m) => m.Container || m.MediaStreams.length).length;
  /* 定位到的**条目**数（一个站可能有代表 + 若干变体，各自算一条） */
  const located = siteDigest.reduce((n, d) => n + (d.Details || []).filter((x) => x.Target).length, 0);
  const variantCount = siteDigest.reduce((n, d) => n + (d.Details || []).filter((x) => x.Variant).length, 0);
  /* 日志里写清「源里 N 条 → 过滤后 M 条 → 列出 K 条」；**少给要一眼看得出来**，而且要分清是
   * **哪个原因**少给的（口径：如实为空、不回退成全部 —— 否则规则写错根本发现不了）：
   *   · 非可播类型（剧/季）**不展开版本列表**，那种 0 条是设计（曾被这句误导过一轮）；
   *   · 线路过滤（正则没匹配上）—— **滤在聚合层**，这里只把它那笔账念出来（过滤前多少条）；
   *   · 没定位到这一集（集名里没有集号，面板不猜 → 那条线路不列）。 */
  /* 电影的一个"版本" = 线路 × 播放项，剧集 = 一条线路 —— 日志里分开说，免得把版本数读成线路数 */
  const isMovie = found.Type === 'Movie';
  const versionNote = isMovie ? `${sources.length} 个版本（${totalLines} 条线路 × 播放项）` : `${sources.length} 线路`;
  const noTargetNote = noTarget
    ? `（另有 ${noTarget} 条线路${isMovie ? '没有播放项' : `没定位到 ${locatorLabel(found.Type, p)}`}，不进版本列表）`
    : '';
  const noRefNote = noRef ? `（另有 ${noRef} 个播放项没有 ref，不进版本列表 —— 插件没照契约给）` : '';
  const filterNote =
    !isPlayable(found.Type)
      ? ` 非可播类型「${found.Type}」，按设计不给版本列表（源里 ${totalLines} 条线路）` /* 兜底：早返回之后正常走不到 */
      : (lfStat && lfStat.raw
          ? ` 线路过滤(/${lfStat.raw}/)${lfStat.invalid ? '规则非法，已忽略' : ''}（聚合层已滤）：` +
            `源里 ${lfStat.before} 条 → 到手 ${totalLines} 条` +
            (lfStat.before > 0 && totalLines === 0 ? '（规则把线路全滤掉了）' : '')
          : noTarget
            ? ` 源里 ${totalLines} 条 → 列出 ${sources.length} 条`
            : '') + noTargetNote + noRefNote;
  return {
    status: 200,
    body: found,
    log:
      `id=${itemId}「${name}」→ ${entries.length} 站命中（${entries.map((e) => `${e.source}/${e.key}`).join(' ')}）` +
      ` ${versionNote}，${located} 条目${isMovie ? '有播放项' : `定位到 ${locatorLabel(found.Type, p)}`}` +
      `${variantCount ? `，同片变体 ${variantCount} 条` : ''}` +
      `${specs ? ` 带规格=${specs}` : ''}${filterNote} ${hit.elapsedMs}ms`,
  };
}

/**
 * 聚合层给的动态范围是**中立值**（`DOVI` / `HDR10+` / `HDR10` / `HDR` / `HLG`，见 agg 的
 * `parseEpisodeMeta`），而 Emby 客户端认的是 **Emby 的词表**：真实 Emby 服务端返回的是 `DolbyVision`
 * （对照样例见 docs「多版本对照」），`DOVI` 是 Jellyfin 的叫法。翻译只做这一处，认不出的原样给。
 */
const VIDEO_RANGE_EMBY = { DOVI: 'DolbyVision', 'HDR10+': 'HDR', HDR10: 'HDR', HDR: 'HDR', HLG: 'HLG' };
function embyVideoRange(v) {
  const s = String(v || '');
  return VIDEO_RANGE_EMBY[s] || s;
}

/**
 * `ExtendedVideoType` —— Emby 用它区分 HDR 的细类（`VideoRange` 只有 HDR 一档，说不出 HDR10/HLG）。
 * 只映射**源明确写了的**那几种；写 `HDR` 但没说哪一种的不给（可能是 HLG，说了就成猜了）。
 */
const EXTENDED_VIDEO_TYPE = { DOVI: 'DolbyVision', 'HDR10+': 'HDR10Plus', HDR10: 'HDR10', HLG: 'HLG' };
function extendedVideoType(v) {
  return EXTENDED_VIDEO_TYPE[String(v || '')] || '';
}

/**
 * 动态范围 → 色彩三元组。**这是规范定的，不是猜**：Dolby Vision / HDR10 / HDR10+ 一律 BT.2020 容器
 * + PQ（`smpte2084`）；HLG 是 BT.2020 + `arib-std-b67`。只写 `HDR` 的**不给**（传输函数定不下来），
 * SDR / 未知也不给 —— 缺字段比给错字段好。
 */
function colorOf(v) {
  const s = String(v || '');
  if (s === 'DOVI' || s === 'HDR10' || s === 'HDR10+') {
    return { ColorSpace: 'bt2020nc', ColorPrimaries: 'bt2020', ColorTransfer: 'smpte2084' };
  }
  if (s === 'HLG') return { ColorSpace: 'bt2020nc', ColorPrimaries: 'bt2020', ColorTransfer: 'arib-std-b67' };
  return null;
}

/**
 * 真实 Emby 的 `MediaStream` 上那一批**恒定型**字段 —— 流上那些**确知的事实**：
 * 本层的流是内嵌的（不是外挂字幕/外挂音轨）、不是字幕流、不单独外发。
 *
 * 早期一个都没给（视频流只有 6~8 个键），而真机有 35 个。实测已定性：
 * **SenPlayer 拿到那套薄字段就判定条目不可用**（拿到真实聚合数据、有线路、照样打不开），
 * 换成真机形状立刻正常 —— 所以这些**不是可有可无的装饰**。
 *
 * 这里只放**对本层的流一定成立**的常量；**不知道的不编**（语言、PixelFormat、Level、
 * RefFrames、SampleRate 这些本层不掌握，就不填 —— 宁缺毋滥）。
 *
 * ⚠️ **不填"猜的"**（口径：**不知道就空字段**）。真机有、但**本层不知道**的
 * 这些一律**不给**：`Protocol`（真机是 `File` 因为文件在本地，这里是从 http 拉的）、
 * `TimeBase`（真机来自**文件解析**）、`IsAnamorphic` / `IsInterlaced` / `IsHearingImpaired`
 * （要探测文件才知道）、`ExtendedVideoType/SubType/SubTypeDescription`（要知道 HDR 细类，
 * 源没标就不知道）。照抄真机会让响应"看起来更真"，但那是**编**。
 */
const STREAM_BASE = {
  AttachmentSize: 0,
  IsExternal: false,
  IsForced: false,
  IsTextSubtitleStream: false,
  SupportsExternalStream: false,
};

/* 字幕：插件申报的 `format`（契约认 `srt` / `ass` / `ssa` / `vtt`）→ Emby `Codec` 名。
 * Emby 用 `subrip` 指 SRT、`webvtt` 指 VTT（ass/ssa 同名）。 */
const SUBTITLE_CODEC = { srt: 'subrip', ass: 'ass', ssa: 'ssa', vtt: 'webvtt' };

/* 回字幕字节时的 `Content-Type`：**优先取插件给的 `contentType`**，没给才按 `format` 落这一份。
 * 与 Emby 约定一致（SRT 是 `application/x-subrip`、SSA/ASS 是 `text/x-ssa`、VTT 是 `text/vtt`）。 */
const SUBTITLE_CONTENT_TYPE = {
  srt: 'application/x-subrip',
  ass: 'text/x-ssa',
  ssa: 'text/x-ssa',
  vtt: 'text/vtt',
};

/** 宽高比化简成 `240:101` 这种（真机就是这么给的，不是原始的 3840×1616） */
function aspectRatioOf(w, h) {
  const a = Math.round(Number(w) || 0);
  const b = Math.round(Number(h) || 0);
  if (!a || !b) return '';
  const gcd = (x, y) => (y ? gcd(y, x % y) : x);
  const g = gcd(a, b);
  return `${a / g}:${b / g}`;
}

/**
 * 一条线路 → 一个 Emby `MediaSource`（**版本**）。
 *
 * 多站之后每条线路都带**站点**：
 *   - `Id` = `mbp:` + base64url(`<site>:<flag>|<vod>`)（**该站自己的** vodId）—— 客户端播直连时
 *     只回传它，所以站点与 vod 都必须编在里面，且**必须编码**（线路名里的 `#` 被 URL 当锚点吃掉，
 *     见 `mbpSourceId`）；
 *   - `Name` 与视频流 `DisplayTitle` = **`站点标签 · 线路`**（站点完整 `name`，如 `木偶|4K · 夸克原画`）
 *     —— 版本行的标题位就取 `DisplayTitle`
 *     （Rex 实测：缺了它客户端拿 `VideoRange` 拼 "Dolby Vision"，多条版本会一模一样），
 *     多站之后不带站点同样会撞名，所以站点必须在标题里；
 *   - `Path` 末段放 **`站点来源标签 · 集名`**，客户端版本行的**副标题**取它（见 `streamPath`）。
 *
 * 字段形状照**真机 Emby 4.9.5**（见 `_mock-real-detail.json` 的对照）：
 * MediaSource 级补了 `ItemId`/`Chapters`/`Formats`/`RequiredHttpHeaders`/`SupportsProbing`/
 * `IsInfiniteStream`/`ReadAtNativeFramerate`/`HasMixedProtocols`/`AddApiKeyToDirectStreamUrl`/
 * `Requires*`，流级补了上面 `STREAM_BASE` 那一批 + `AspectRatio`/`VideoRange`/色彩三元组。
 * `Path` 给**相对路径**（`/Items/…`，见 `streamPath`）—— 客户端把它拼在自己的 base 之后（base 含 `/emby`）。
 *
 * 规格全部来自源在集名里的标注（`line.target.*`）：**有才给、缺就空着** —— 给假的比不给更坑。
 */
/**
 * **直连播放地址**（`MediaSources[].DirectStreamUrl`）—— 真机**只在 PlaybackInfo 里给**，详情里没有
 * （拿真机同一集 `S05E211` 逐字段对过：详情 27 个字段、PlaybackInfo 28 个，差的就是它）。
 *
 * 形状：`/videos/{id}/stream.{容器}?MediaSourceId=…&Static=true&api_key=…`。三点刻意：
 *   · **带容器后缀**（`hls` 映射成 `m3u8`，见函数体）：曾为对齐真机（予初Emby 4.9.5.0 的
 *     `DirectStreamUrl` 就是裸 `stream`）去掉过后缀（ADR-0070），实测**打断了一批靠 URL 后缀
 *     判类型的客户端**（ExoPlayer 系只认 `.m3u8`，裸 `stream` 被当普通文件嗅探 → 播放错误）——
 *     恢复后缀，取舍见 ADR-0071。裸 `stream` 本层照样认：路由正则 `stream(\.[a-z0-9]+)?`
 *     两种都收。
 *   · 给**相对路径**（`/videos/...`，与真机一致）—— 客户端把这里给的地址**当相对路径直接拼在
 *     自己的 base 之后**（base 已含 `/emby`，见 server.js 注释）：给绝对 URL 会被再拼一次成
 *     双重地址（`…/emby` + `http://…/api/emby/…`）→ 404。相对路径去掉 `/api/emby` 与 `/emby`
 *     前缀后，base 是 `/emby` 还是 `/api/emby` 都能命中（`/emby/videos/…` / `/api/emby/videos/…`
 *     → normalize → `/api/emby/videos/…`）。
 *   · 带上**客户端自己的 token** —— 本层的流端点要校验 AccessToken，不带就是 401（那比不给更糟）。
 *     ⚠️ 用 query 里的 `api_key`，**不能写 `X-Emby-Token`**：后者本层只认请求头，
 *     写进 query 等于没带（拿这个 URL 直接去播就是 401 —— 客户端自己会带头所以看不出来，
 *     但把 URL 交给外部播放器/投屏时就会踩到）。`api_key` 这个 query 形式真机也认。
 */
function directStreamUrl({ itemId, token, src, container }) {
  /* 后缀不照抄 Container：`hls` 是 Emby DTO 的容器枚举值，不是播放器认得的扩展名 ——
   * ExoPlayer 系按后缀推断类型只认 `.m3u8`（真机的 HLS 拉流地址也是 `*.m3u8`）；
   * 其余容器（mkv/mp4/…）容器名本身就是扩展名，原样拼。 */
  const ext = container === 'hls' ? 'm3u8' : container;
  const file = `stream${ext ? '.' + ext : ''}`;
  return (
    `/videos/${encodeURIComponent(itemId)}/${file}` +
    `?MediaSourceId=${encodeURIComponent(src)}&Static=true` +
    (token ? `&api_key=${encodeURIComponent(token)}` : '')
  );
}

/**
 * 字幕流的内容地址（`MediaStreams[].DeliveryUrl`）—— **Emby 标准的字幕取用形状**
 * （`/Videos/{ItemId}/{MediaSourceId}/Subtitles/{Index}/Stream.{Format}`，见 emby-realdevice #23）。
 *
 * 给**相对路径**（不带 `/api/emby` 前缀、不带主机），与 `directStreamUrl` / `streamPath` 同一口径：
 * 客户端把它拼在自己的 base（已含 `/emby`）之后。`Videos` 字面段在本层路由**大小写不敏感**，
 * 所以官方大写与早期小写都能命中（见 routes.js）。
 */
function subtitleUrl(itemId, src, index, format) {
  return (
    `/Videos/${encodeURIComponent(itemId)}/${encodeURIComponent(src)}` +
    `/Subtitles/${index}/Stream.${format}`
  );
}

/**
 * 版本标题**全局不撞名**。flag 单段化后，同站不同包靠播放项自己的结构化规格区分
 * （每集 [大小] 前缀通常已经不同）；若仍有完全同名的版本，按「分辨率 → 编码 → 第 N 版本」
 * 从该版本视频流的字段补一段，只补撞名的组，不撞不添噪。
 * 同步改视频流的 DisplayTitle：它就是版本列表里那一行的标题位，与 ms.Name 同源。
 */
function ensureUniqueSourceNames(msList) {
  const groups = new Map();
  msList.forEach((ms, i) => {
    if (!groups.has(ms.Name)) groups.set(ms.Name, []);
    groups.get(ms.Name).push(i);
  });
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    idxs.forEach((idx, k) => {
      const ms = msList[idx];
      const v = (ms.MediaStreams || []).find((s) => s.Type === 'Video') || null;
      const bits = [];
      if (v && v.Height) bits.push(v.Height >= 2000 ? '4K' : `${v.Height}p`);
      if (v && v.Codec) bits.push(String(v.Codec).toUpperCase());
      bits.push(`第 ${k + 1} 版本`);
      const next = `${ms.Name} · ${bits.join(' · ')}`;
      ms.Name = next;
      if (v) v.DisplayTitle = next;
    });
  }
}

function buildMediaSource({ itemId, line, runtimeTicks, headers = {}, item, subtitles = [] }) {
  /* 这个版本要播的那一项：电影 = 该线路下的某个播放项；剧集 = **定位到的这一集**。
   * 两者都带集名里源标的规格（容器/分辨率/编码/体积），也带**插件给它编的 `ref`**。 */
  const t = item || line.target || {};
  /* 版本标题位（`[体积] 站点标签 · 线路flag [· 变体标注] [· 项标注]`）由**聚合层拼好**，
   * 写在这项的 `versionLabel` 上（`agg/service.js` 的 `fillVersionLabels`）—— 规则只实现一次，
   * emby 层与出口插件（FW/Rex）读的是同一个字段（见 ADR-0063）。
   * 本层**不再自己拼**、也不留旧的拼接兜底：能进版本列表的目标都过了聚合层那一趟，字段必然有值。 */
  const title = t.versionLabel || '';
  /* Path 末段 = 版本行的**副标题**（客户端取「解码后最后一个 `/` 之后」，见 streamPath）。
   * 优先用 agg 拼好的 `standardName`（`标题.年份.季集.规格.容器`），没有就退到原始文件名。 */
  const fileName = t.standardName || t.name || `${line.flag}.mkv`;
  /* ⚠️ `Id` / `Path` **不在这里算**：版本 Id 的载荷要承载"流序号 → 字幕 ref"的映射（`s` 字段，
   * 见 mbpSourceId），得等字幕流建好、拿到各自 `Index` 才算；而每条字幕流的 `DeliveryUrl`
   * 又依赖版本 Id。所以整段次序是：先建 streams（视频/音频/字幕）→ 算 Id → 回填 `Path` / `DeliveryUrl`。 */
  const ms = {
    Name: title,
    Protocol: 'Http',
    Type: 'Default',
    IsRemote: true,
    Container: t.container || '',
    SupportsDirectPlay: true,
    SupportsDirectStream: true,
    SupportsTranscoding: false,
    /* 真机是 `true`（它的库扫过文件、能探测）；本层**不探测**远程流（只用 agg/detail 的数据），
     * 所以如实给 `false`，而不是照抄真机的 true。 */
    SupportsProbing: false,
    IsInfiniteStream: false,
    ReadAtNativeFramerate: false,
    HasMixedProtocols: false,
    AddApiKeyToDirectStreamUrl: false,
    RequiresOpening: false,
    RequiresClosing: false,
    RequiresLooping: false,
    Chapters: [],
    Formats: [],
    /* 该线路**自己**需要的请求头（多由源内嵌在 proxy URL 里，这里是空对象）——
     * 真机有这一项，且它正是"面板代为拉流"要用的东西，如实给。 */
    RequiredHttpHeaders: Object.assign({}, headers),
    ItemId: itemId,
    MediaStreams: [],
  };
  /* 体积是源标的近似值；时长来自上游（`RunTimeTicks`），两个都有才能算码率 */
  if (t.sizeBytes) ms.Size = t.sizeBytes;
  if (runtimeTicks) ms.RunTimeTicks = runtimeTicks;
  const avgBitrate = t.sizeBytes && runtimeTicks ? Math.round((t.sizeBytes * 8) / (runtimeTicks / 1e7)) : 0;
  if (avgBitrate) ms.Bitrate = avgBitrate;
  if (t.bitRate) ms.Bitrate = t.bitRate;

  const streams = [];
  /* `VideoRange` / 色彩三元组 / `ExtendedVideoType` **只在源标了 HDR 时才填** ——
   * 源没标时本层**并不知道**它是 SDR 还是没写，一律假设成 SDR 就是编（口径：
   * 不知道就空字段）。真机给 bt709 是因为它**扫过文件**，这里没有文件。 */
  const videoRange = embyVideoRange(t.videoRange);
  const extended = extendedVideoType(t.videoRange);
  const color = colorOf(t.videoRange);
  /* 视频流**无条件建** —— 它承载版本标题位（`DisplayTitle`）。源没标任何规格时（集名写成
   * `ZY.S01E01.mkv` 这种）也得有它：否则客户端那一行没有名字，多条版本又变成"看不出是哪条"
   * （实测：24 条里有 4 条标题位是空的）。规格字段照旧「有才填、缺就空」。 */
  {
    const v = Object.assign({}, STREAM_BASE, {
      Type: 'Video',
      IsDefault: true,
      Index: 0,
      DisplayTitle: title,
    });
    if (videoRange) v.VideoRange = videoRange;
    if (extended) v.ExtendedVideoType = extended;
    if (color) Object.assign(v, color);
    if (t.width && t.height) {
      v.Width = t.width;
      v.Height = t.height;
      const ar = aspectRatioOf(t.width, t.height);
      if (ar) v.AspectRatio = ar;
    }
    if (t.videoCodec) v.Codec = t.videoCodec;
    if (t.videoProfile) v.Profile = t.videoProfile;
    if (t.bitDepth) v.BitDepth = t.bitDepth;
    if (t.frameRate) {
      v.AverageFrameRate = t.frameRate;
      v.RealFrameRate = t.frameRate;
    }
    if (avgBitrate) v.BitRate = avgBitrate;
    streams.push(v);
  }
  if (t.audioCodec) {
    const a = Object.assign({}, STREAM_BASE, {
      Type: 'Audio',
      Codec: t.audioCodec,
      IsDefault: true,
      Index: streams.length,
      /* 编解码 + 声道 + Atmos 拼成一句（`EAC3 5.1 Atmos`）—— 与真实 Emby 的
       * `English EAC3 5.1 (默认)` 同款式，只是本层没有语言信息，不编。 */
      DisplayTitle: [String(t.audioCodec).toUpperCase(), t.channelLayout, t.atmos ? 'Atmos' : '']
        .filter(Boolean)
        .join(' '),
    });
    if (t.channels) a.Channels = t.channels;
    if (t.channelLayout) a.ChannelLayout = t.channelLayout;
    streams.push(a);
    ms.DefaultAudioStreamIndex = a.Index;
  }
  /* 字幕流：挂在视频/音频之后（`Index` 顺延）。**字幕与线路无关**（契约 §七）—— 面板为一个播放
   * 目标问一次 `tracks`，把同一份轨挂到该目标的**每个版本**上（电影多压制版本共用）。
   * 每条轨记下自己的 `Index` / `ref` / `format`：`Index` 与 `ref` 编进版本 Id 的 `s` 映射，
   * `format` 用于回填 `DeliveryUrl` 的 `Stream.{Format}` 段。 */
  const subTracks = [];
  for (const s of subtitles) {
    const idx = streams.length;
    const st = Object.assign({}, STREAM_BASE, {
      Type: 'Subtitle',
      Index: idx,
      Codec: SUBTITLE_CODEC[s.format] || s.format,
      /* `lang` 原样写进 `Language`（契约 §七：BCP-47 风格，面板不解释） */
      Language: s.lang,
      DisplayTitle: s.label || s.lang,
      /* 外挂字幕不是默认轨/强制轨。`IsDefault` 必须给：严格反序列化的客户端（Yamby）
       * 把它声明成必填，缺了整条 PlaybackInfo 直接抛 SerializationException */
      IsDefault: false,
      IsForced: false,
      IsExternal: true,
      IsTextSubtitleStream: true,
      SupportsExternalStream: true,
      DeliveryMethod: 'External',
    });
    streams.push(st);
    subTracks.push({ index: idx, ref: s.ref, format: s.format, stream: st });
  }
  ms.MediaStreams = streams;
  /* 版本 Id：把"流序号 → 字幕 ref"的映射一起编进载荷（`s` 字段）—— 客户端点开某条字幕轨时
   * 只回传版本 Id 与该轨的 `Index`，面板据此把 `ref` 交给字幕插件 `fetch`（见 getSubtitle）。 */
  const subMap = {};
  subTracks.forEach((x) => {
    subMap[String(x.index)] = x.ref;
  });
  const src = mbpSourceId(t.ref, line.playVia, subMap);
  ms.Id = src;
  ms.Path = streamPath(itemId, src, fileName);
  /* 回填每条字幕流的 `DeliveryUrl`（指向字幕内容端点，相对路径）—— 依赖上面算出的版本 Id。 */
  subTracks.forEach((x) => {
    x.stream.DeliveryUrl = subtitleUrl(itemId, src, x.index, x.format);
  });
  return ms;
}

/**
 * MediaSource 的 Id：把**源插件编的那个 `ref`** 包一层。
 *
 * 形状：`mbp:` + **base64url**(deflateRaw(JSON `{r: ref}`))。
 *
 * **为什么必须编码**（实测）：客户端把 Id 拼进 query 时，中文它会编码
 * （日志里是 `%E5%A4%B8%E5%85%8B…`），但 **`#` 它不编码** —— 而线路名里就有 `#`（如 `夸克原画#01`），
 * 于是 `#` 之后的内容被当成 URL 锚点，**根本发不到服务端**：服务端收到一个不带线路的 Id → 400，
 * 客户端反复重试（实测 e1/e2 各 34 次）。base64url 字符集只有 `[A-Za-z0-9_-]`，
 * 客户端编不编码都是同一串，对该问题**免疫**。
 *
 * **为什么还要压一道**（实测）：SenPlayer 把整条请求 URL 截在 4095 字符，留给 `MediaSourceId` 的
 * 只有 4048 —— 而 `ref` 本身就是插件编的一串 base64（里面还嵌着一层站点的 playToken），
 * 不压直接编出来最长实测 5098 字符：客户端发出去的是半截串，服务端按形状校验回 400
 * 「src 认不出」，同一个视频换个客户端却能播（Rex 无此上限）。deflate 对这种"base64 套 base64"
 * 的重复文本收益明显：同一批 19 个版本最长的 5098 → 3391 字符，压完都在 4048 以内。
 *
 * **面板不解释 `ref` 的内容**（契约第八节）：里面是什么、怎么换成一个地址，都是源插件的事。
 * 这一层只做三件事：压小、编码成客户端安全的一串、播放时原样交回插件。
 */
function mbpSourceId(ref, playVia, subs) {
  const o = { r: String(ref || '') };
  /* 线路级的 `playVia` **跟着 `ref` 一起编进 Id** —— 它决定起播时面板怎么落地址（见 `finishStream`）：
   * `proxy` 的线路客户端带不了鉴权头，得由面板代持中继。缺省 `client` 不写（省长度、也免得老口径漂移）。
   * 面板不解释 `ref`，但 `playVia` 是**面板自己要用的落法声明**（契约第五节），所以这里必须承载它 ——
   * 否则 Emby 这条路上只剩 302 一条死路（与出口插件读 `detail` 的 `line.playVia` 同一份真相）。 */
  const v = String(playVia || 'client');
  if (v !== 'client') o.v = v;
  /* `s` = "字幕流序号 → 字幕 ref"的映射（键是 `MediaStreams[].Index` 的字符串形式）。客户端点开
   * 某条字幕轨时只回传版本 Id 与该轨 `Index`，面板据 `s[Index]` 取 `ref` 交给字幕插件 `fetch`。
   * **无字幕时不写 `s`**（载荷与旧版完全一致，不白占长度）。 */
  const sMap = subs && typeof subs === 'object' ? subs : null;
  if (sMap && Object.keys(sMap).length) o.s = sMap;
  const payload = JSON.stringify(o);
  return 'mbp:' + zlib.deflateRawSync(Buffer.from(payload, 'utf8')).toString('base64url');
}

/* 拉流方式：**一律 302**（`play.mode` 与「面板代理」那条路一并删掉）。
 *
 * 为什么删代理：面板在路由器上（2G 内存、U 盘），把每条流的字节都接一遍是最贵的那种"省事"——
 * 而 302 把流量留在源与客户端之间，面板只回一个 Location。代价是**客户端得连得到源地址**，
 * 而"把地址变成客户端够得着的那一个"现在是**源插件**在做：
 * 面板不再知道实例端口，也没法再做那一步 —— 它只把客户端主机名交给插件。
 *
 * 老配置里残留的 `play.mode` 不再读、也不再校验（`PLAY_MODE_VALUES` 已删）——
 * 盘上留着那个键不影响任何事。
 */

/**
 * 拆版本 Id —— 认出来就是 `{ref}`，认不出回 `null`（上层据此报 400，不猜）。
 *
 * 形状只有一种：`mbp:<base64url(deflateRaw(JSON {r, v?, s?}))>`（见 `mbpSourceId`）。
 * ⚠️ **旧形状不再认**（多源之前那种 `<源>:<站点>:<线路>|<vod>`，以及只编码不压缩的那一版）：
 * 按 ADR-0034 不留双读分支 —— 客户端手里缓存的旧 Id 会被如实回一句"重新进一次播放页"
 * （客户端进播放页必先问 PlaybackInfo，所以它自会拿到新的）；这正是那条"不为未发布的东西留兼容"的口径。
 */
function parseMbpSourceId(src) {
  const s = String(src || '');
  if (!s.startsWith('mbp:')) return null;
  const plain = inflateText(s.slice('mbp:'.length));
  if (!plain || !plain.startsWith('{')) return null;
  try {
    const o = JSON.parse(plain);
    const ref = String(o.r || '');
    if (!ref) return null;
    /* `v` 是线路级的落法声明（见 `mbpSourceId`）：缺席 = 老 Id / 缺省 `client`。
     * 原样带出去交给 `finishStream` 判档，这里不解释、不校验取值（`planStream` 只认 `proxy`）。 */
    /* `s` = "字幕流序号 → 字幕 ref"的映射（见 `mbpSourceId`）：缺席 = 无字幕 / 老 Id。
     * 原样带出去，`getSubtitle` 按客户端的 `Index` 取值。 */
    const subs = o.s && typeof o.s === 'object' && !Array.isArray(o.s) ? o.s : {};
    return { ref, playVia: String(o.v || 'client'), subs };
  } catch {
    return null;
  }
}

/**
 * base64url → deflate 解压 → utf8。两道都自己兜住，只把"确定是可打印文本"的结果交出去 —— **不猜**：
 *   - `Buffer` 对非法 base64 字符是**静默忽略**的（会解出乱码而不抛）；
 *   - `inflateRawSync` 碰上不是 deflate 的数据（老的只编码不压缩那一版、客户端截断的半截串）会抛。
 * 任一不成立就回空串，让上层的形状校验去拒。`maxOutputLength` 是必需的：这一段是**客户端递进来的**，
 * 不设上限的话一个小串能原地炸出很大一块内存；合法载荷（实测约 3.8KB 明文）离 64KB 还远。
 */
function inflateText(s) {
  try {
    const buf = Buffer.from(String(s || ''), 'base64url');
    const out = zlib.inflateRawSync(buf, { maxOutputLength: 64 * 1024 }).toString('utf8');
    return /^[^\u0000-\u001f]+$/.test(out) ? out : '';
  } catch {
    return '';
  }
}

/**
 * 流端点的 Path：**只拼稳定坐标，不带任何时效 token**。
 *
 *   /Items/{ItemId}/Stream/{token}/{文件名}
 *
 * 给**相对路径**（不带 `/api/emby` 前缀，也不带主机）—— 客户端把它当相对路径拼在自己的 base 之后
 * （base 已含 `/emby`），去掉前缀后 base 是 `/emby` 还是 `/api/emby` 都能命中（同 `directStreamUrl`）。
 *
 *   - `{token}` = base64url(版本 Id)（**整条 Id 原样编进来**：Id 自身已是 `mbp:` + base64url，
 *     这里再编一层只为让路径段不含 `/`；两层都解得出，token 长一点无所谓）
 *     **必须是"解码后也不含 `/`"的编码**：客户端会把 Path 解码后取「最后一个 `/` 之后」当版本行的
 *     副标题 —— 明文 vod 里的 `…/vod/detail/id/8471.html` 就是这么把副标题变成 `8471.html` 的
 *     （六条线路全一样）。base64url 里没有 `/`，一劳永逸。
 *   - `{文件名}` = 该线路**定位到的那一集**的集名，源给的原始文件名（例：
 *     `[1.8GB]Lanterns.2026.S01E01.2160p.MAX.WEB-DL.H.265.DV.HDR.DDP5.1.Atmos.mkv【L 绿灯军团】`）
 *     —— 副标题显示的就是它。定位不到的线路退回「线路名.mkv」，总比 `8471.html` 有信息。
 *   - 季集号不放进来 —— Stream 路径里的 `ItemId` 解开就有。
 *
 * ⚠️ 客户端播放**并不读这个 Path**（实测它走 `/videos/{Id}/stream.{ext}`），这里纯粹是
 * "给读它的客户端 + 版本行副标题"用。
 */
function streamPath(itemId, src, fileName) {
  const token = Buffer.from(String(src), 'utf8').toString('base64url');
  const name = String(fileName || '').trim() || 'video.mkv';
  return `/Items/${encodeURIComponent(itemId)}/Stream/${token}/${encodeURIComponent(name)}`;
}

/** 拆 Path 段里的 token（base64url → 版本 Id）—— 认不出回空串，上层据此报 400 */
function decodeSourceToken(token) {
  try {
    const s = Buffer.from(String(token || ''), 'base64url').toString('utf8');
    return s.startsWith('mbp:') ? s : '';
  } catch {
    return '';
  }
}

/**
 * POST /Items/{ItemId}/PlaybackInfo —— 播放信息（客户端点播放前必来）
 *
 * 客户端从这里拿「有哪些版本」，再按各自的 `Path` 去拉流。所以这里**只给版本清单与稳定 Path**，
 * 真实播放地址一律留到 Stream 端点现取（会过期，放这里就会失效）。
 * 实现上直接复用 getItem（元数据 + 线路 + MediaSources 都在那儿），不重复一遍。
 */
/**
 * 「可播类型」：**集**（Episode）与**电影**（Movie）。剧/季是容器 —— 给了客户端会以为能播。
 *
 * **电影 / 剧集两套取法**（见 docs/adr/0022）：
 *   · 电影 —— `pick: 'items'`：每条线路的**每个播放项**各成一个版本（多个压制版本全都列出来），
 *     版本 Id 里带 `i`（第几项）；
 *   · 集   —— 按季集号定位**这一集**，版本 Id 里不带 `i`（缺省 0）。
 * 两套取法共用同一条播放链路（`Id` → `Path` → `PlaybackInfo` → 拉流），差别只在"取到哪一项"。
 */
const PLAYABLE_TYPES = new Set(['Episode', 'Movie']);
function isPlayable(type) {
  return PLAYABLE_TYPES.has(type);
}

/** Id 层面判断可播：集 = tv 带季集；电影 = movie 且不带季集（形状由 metaBridge.parseItemId 保证） */
function isPlayableId(p) {
  if (!p) return false;
  return p.type === 'movie' ? p.season === null && p.episode === null : p.season !== null && p.episode !== null;
}

/**
 * 交给聚合层的**取法坐标**（电影/剧集两套取法，见 docs/adr/0022）：
 *   · 电影 → `{ pick: 'items' }`：每条线路的**每个播放项**各算一个可播目标（多条压制版本各自成版本）；
 *   · 集   → 照实传季集号：按集名里的集号定位**这一集**。
 */
function wantLocator(p) {
  return p.type === 'movie' ? { pick: 'items' } : { season: p.season, episode: p.episode };
}

/** 日志里"定位到哪"：集写季集号；电影写「按播放项」；其余如实写类型。 */
function locatorLabel(type, p) {
  if (type === 'Episode') return `S${p.season}E${p.episode}`;
  if (type === 'Movie') return '电影（按播放项）';
  return `（非可播类型：${type}）`;
}

async function getPlaybackInfo(itemId, token = '') {
  const p = metaBridge.parseItemId(itemId);
  if (!isPlayableId(p)) {
    return { status: 404, body: { error: '只有「集」和「电影」有播放信息' }, log: `Id 不是集/电影 → 404：${itemId}` };
  }

  const item = await getItem(itemId);
  if (item.status !== 200) return item;

  const sources = (item.body.MediaSources || []).map((m) =>
    Object.assign({}, m, {
      /* RequiredHttpHeaders 留空：源要求的请求头由**本层**在 Stream 端点里带上，客户端只管拉 */
      RequiredHttpHeaders: {},
      /* 直连播放地址：**只在这里给**（真机详情里没有它 —— 见 `directStreamUrl` 的注释） */
      DirectStreamUrl: directStreamUrl({ itemId, token, src: m.Id, container: m.Container }),
    })
  );
  return {
    status: 200,
    body: { MediaSources: sources, PlaySessionId: crypto.randomBytes(16).toString('hex') },
    log:
      `id=${itemId} → ${sources.length} 个版本（Path 指向 Stream 端点）` +
      /* **0 个版本时把 getItem 的原因一并打出来** —— 否则日志只剩「0 个版本」，无从判断是聚合没命中、
       * 站源没详情、还是取数失败（排查时曾被这个问题卡住，只能另开脚本去打聚合）。 */
      (sources.length ? '' : `  ← ${item.log}`),
  };
}

/**
 * 取字幕内容：`GET /api/emby/Videos/{ItemId}/{MediaSourceId}/Subtitles/{Index}/Stream.{Format}`
 * （Emby 标准的字幕取用形状，见 emby-realdevice #23）。
 *
 * 客户端点开版本里某条字幕轨时打这条：`{MediaSourceId}` 就是版本 Id，`{Index}` 是那轨的
 * `MediaStreams[].Index`。面板从版本 Id 载荷里取出 `s[Index]`（字幕 `ref`），**按第一段路由**
 * 到字幕插件、调它的 `fetch({ ref })` 取回内容。面板**不解释 `ref`**（契约第八节），也不缓存
 * 字幕内容 —— 缓存归插件自己管（契约 §七），这里每次都现取。
 *
 * 失败语义（照实回，见 #23-1）：`{Index}` 在版本里认不出 → 404；版本 Id 认不出 → 400；
 * Id 非集/电影 → 404；插件取内容失败 → 照实回失败码（`metaBridge.httpStatusOf`）。
 * `format` 只用于"插件没给 `contentType`"时的兜底映射（形状已在路由层校验过）。
 */
async function getSubtitle(itemId, src, index, format) {
  const p = metaBridge.parseItemId(itemId);
  if (!isPlayableId(p)) {
    return { status: 404, body: { error: '只有「集」和「电影」有字幕' }, log: `Id 不是集/电影 → 404：${itemId}` };
  }

  const parsed = parseMbpSourceId(src);
  if (!parsed) {
    /* 与拉流同口径：认不出多半是旧版客户端缓存下来的版本 Id —— 让它重进一次播放页。 */
    return {
      status: 400,
      body: {
        error: '这个版本 Id 认不出（可能是改版前缓存下来的）—— 请重新进一次播放页获取版本列表',
        src: String(src || ''),
      },
      log: `字幕 src 认不出 → 400：${String(src || '').slice(0, 60)}`,
    };
  }

  const ref = parsed.subs[String(index)];
  if (!ref) {
    return {
      status: 404,
      body: { error: '这个版本里没有这个字幕轨' },
      log: `字幕 ${index} 不在版本里 → 404（版本内字幕轨：${Object.keys(parsed.subs).join(',') || '无'}）`,
    };
  }

  let out;
  try {
    /* 回调插件 `fetch`：出参 `{ body, contentType? }`（契约 §七）。超时用桥的默认值。 */
    out = await subtitleBridge.fetch(ref);
  } catch (e) {
    const err = e || {};
    return {
      status: metaBridge.httpStatusOf(err),
      body: { error: err.message || '取字幕失败', code: err.code },
      log: `字幕 ${index}（${format}）取内容失败（${err.code || '?'}：${err.message || ''}）`,
    };
  }
  const body = out && out.body;
  if (body === undefined || body === null) {
    return { status: 502, body: { error: '字幕插件没给出内容' }, log: `字幕 ${index}（${format}）→ 502：插件没给 body` };
  }
  /* `Content-Type`：**优先取插件给的 `contentType`**，没给才按 `Format` 落一份（都补 charset）。 */
  const contentType = (out && out.contentType) || SUBTITLE_CONTENT_TYPE[format] || 'text/plain';
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  return {
    status: 200,
    buffer: buf,
    contentType: `${contentType}; charset=utf-8`,
    log: `字幕 ${index}（${format}）→ 200 ${buf.length}B`,
  };
}

/**
 * 拉流：把版本 Id 里那个 `ref` 交给源插件换成地址。
 *
 * 两个渠道共用（路由见 routes.js，落响应共用 serveStream）：
 *   ① `/api/emby/Items/{ItemId}/Stream/{token}/{文件名}` —— 本面板写在 `MediaSource.Path` 里那条；
 *   ② `/api/emby/videos/{ItemId}/stream.{Container}?MediaSourceId=…` —— **客户端真正走的**那条：
 *      它只回传版本 Id，不读 Path。
 *
 * **面板不解释 `ref`**（契约第八节）：里面是什么、去哪儿取、地址怎么变有效，都是源插件的事。
 * 这里只做三件事：拆出 `ref` → 连**客户端访问用的主机名**一起交给插件 → 拿回地址 302。
 * 现取、不缓存（地址会过期；缓存在插件自己那边，它自己管有效期）。
 *
 * `req` = 本跳的请求：面板从它的 `Host` 头得到 `clientHost`（客户端访问用的主机名；本地部署的实例
 * 回的是回环地址，插件要拿它拼成"客户端够得着的那台机器"）；另取一份 `origin`（协议 + Host）
 * 给 `proxy` 档的清单改写用 —— 改出来的子地址必须是**绝对**的，且要落在客户端正在打的那个端口上
 * （见 `finishStream`）。
 *
 * **鉴权只在路由层的 `authorize` 做**（只验 token，见 #12-1）：这里不再比对 `UserId` ——
 * 拉流 / 下载是取字节的读取类端点，真机同样忽略 query 里的 `UserId`。
 */
async function resolveStream(itemId, src, req) {
  const clientHost = (req && req.headers && req.headers.host) || '';
  /* 清单改写用的绝对来源（协议 + Host）—— `proxy` 档的子地址必须落在这个上面 */
  const origin = req ? streamKernel.originOf(req) : '';

  const p = metaBridge.parseItemId(itemId);
  if (!isPlayableId(p)) {
    return { status: 404, body: { error: '只有「集」和「电影」能播' }, log: `Id 不是集/电影 → 404：${itemId}` };
  }

  const parsed = parseMbpSourceId(src);
  if (!parsed) {
    /* 认不出多半是**旧版客户端缓存下来的**版本 Id（这一版换了 Id 的载荷，按 ADR-0034 不留双读）。
     * 客户端进播放页必先问 PlaybackInfo，所以如实让它重取一次就好。 */
    return {
      status: 400,
      body: {
        error: '这个版本 Id 认不出（可能是改版前缓存下来的）—— 请重新进一次播放页获取版本列表',
        src: String(src || ''),
      },
      log: `src 认不出 → 400：${String(src || '').slice(0, 60)}`,
    };
  }

  /* 域来自条目 Id 的前缀 —— 它决定用哪套模板（播放只借它那一档超时）。 */
  const pr = await agg.play({ domain: p.domain, ref: parsed.ref, clientHost });
  if (!pr.ok) {
    const e = pr.error || {};
    return {
      status: e.status || 502,
      body: { error: e.message || '取播放地址失败', code: e.code },
      log: `${locatorLabel(p.type === 'movie' ? 'Movie' : 'Episode', p)} 解析地址失败（${e.code}：${e.message || ''}）`,
    };
  }
  /* 拉流地址上可以带 `?threads=&chunkKB=` 覆盖搬运参数（见 stream.js 的 urlRelayParams）：
   * 非清单档由 `relayBytes` 自己再读一遍；**清单档**得在这一跳就定下来（跟着 sid 存），
   * 所以这里要先读出来带下去。 */
  return await finishStream({ p, pr, playVia: parsed.playVia, origin, over: streamKernel.urlRelayParams(req) });
}

/**
 * 拉流的**共同尾段**：拿到地址之后怎么落。请求头提醒与日志口径只此一处。
 *
 * ⚠️ 地址**不再由面板改写**：回环地址换成"客户端够得着的那台机器"这一步随 `ref` 转交
 * 搬进了源插件 —— 面板已经不知道实例端口，插件给回来的就是最终地址。
 *
 * 落法由**内核**判（`../agg/stream.js` 的 `planStream`，四档），`playVia` 从版本 Id 载荷里取
 * （编进 Id 时读的是 `detail.lines[].playVia`，见 `mbpSourceId`）：
 *   · `client` 非清单 → **302**（字节全在源与客户端之间跑）；
 *   · `client` 清单   → **200 清单中继**（相对补绝对，ADR-0040）；
 *   · `proxy` 非清单  → **面板代持请求头中继**（字节经面板，Range 透传，ADR-0042）；
 *   · `proxy` 清单    → **200 清单中继**，且每个地址改写成落在**本端口** `/api/emby/stream` 上的签名子地址。
 *
 * ⚠️ Emby 客户端带不了请求头，所以 `proxy` 线路只能由面板代持 —— 这正是 ADR-0042 当初记下
 * "Emby 层暂不接这一档"的那件事，现在补上了（见后继 ADR）。
 */
async function finishStream({ p, pr, playVia, origin, over }) {
  const play = pr.play || {};
  const url = (play.urls || [])[0] || '';
  const headers = play.header || {};
  if (!url) {
    return { status: 502, body: { error: '源没给出播放地址' }, log: 'urls 为空' };
  }
  if ((play.nonHttp || []).includes(url)) {
    return {
      status: 501,
      body: { error: '这条线路给的不是可直连地址（push:// 之类），暂不支持', url },
      log: `非直连地址（${url.slice(0, 12)}…）`,
    };
  }
  /* 措辞按 **Emby 的类型**走：`p.type` 是上游的 `tv`/`movie`，直接喂 locatorLabel 会得到
   * 「非可播类型：tv」这种误导日志（早期一直这么打）。 */
  const label = locatorLabel(p.type === 'movie' ? 'Movie' : 'Episode', p);
  /* 该线路要求请求头（头是源自己内嵌在 proxy URL 里的例外，那种 header 是空的）。
   * 各档"带得了带不了"不是一回事，所以分开说，别让它变成"点了播放没反应"的无头案。 */
  const reqHeaders = Object.keys(headers || {});
  const headerNote302 = reqHeaders.length ? ` ⚠️ 该线路要求请求头 ${reqHeaders.join('/')}，302 后客户端带不了` : '';
  /* 三档的提醒口径各不相同，别互相借用 —— `client` 档的清单这一格最容易说岔：
   * 面板只带头发了"取清单"那一跳，**分片仍是客户端直连**，它照样带不了头。 */
  const headerNoteRelay = reqHeaders.length
    ? ` ⚠️ 该线路要求请求头 ${reqHeaders.join('/')}，由面板代持中继`
    : '';
  const headerNotePlaylist = reqHeaders.length
    ? ` ⚠️ 该线路要求请求头 ${reqHeaders.join('/')}，分片仍由客户端直连、带不了头`
    : '';
  const mode = streamKernel.planStream({ url, playVia });

  if (mode === 'redirect') {
    return { status: 200, log: `${label} parse=${play.parse} → 302` + headerNote302, stream: { url, headers, parse: play.parse } };
  }

  /* `proxy` 的非清单地址：**直接开搬**（别先去"取清单" —— 那会把一个分片当清单读满 256KB 再判错）。
   * 落响应归路由层（`serveStream` 的第三形态），这里只把取流所需的选择交出去。
   * 搬运参数：拉流 URL 上的 > 源插件在 `play` 里带的 > 面板设置 > 默认（见 `relayParams`）。 */
  if (mode === 'relay') {
    return {
      status: 200,
      log: `${label} parse=${play.parse} → 200 面板中继（字节经面板，分块并发搬运）` + headerNoteRelay,
      relay: Object.assign({ url, headers, label }, streamKernel.mergeRelayOverrides(over, play)),
    };
  }

  /* 剩下两档都要取回清单：`client` 档补绝对即可；`proxy` 档每个地址还要改写成面板子地址。
   * 取不回来：`client` 档如实退回 302（与改前一致，至少不变差）；`proxy` 档退回 302 等于把
   * "要头的地址"丢给带不了头的客户端 —— 必然播不了的死路，不如如实报错（同 agg 层口径）。 */
  const got = await streamKernel.fetchPlaylist(url, headers);
  if (got.error) {
    if (mode === 'playlist') {
      return {
        status: 200,
        log: `${label} parse=${play.parse} → 302（清单中继失败：${got.error}）` + headerNote302,
        stream: { url, headers, parse: play.parse },
      };
    }
    return {
      status: 502,
      body: { error: `中继取清单失败：${got.error}` },
      log: `${label} 中继取清单失败：${got.error}`,
    };
  }

  if (mode === 'playlist') {
    const fixed = streamKernel.absolutizePlaylist(got.text, got.url);
    return {
      status: 200,
      log: `${label} parse=${play.parse} → 200 清单中继（${fixed.count} 个地址补成绝对，${fixed.text.length} 字节）` + headerNotePlaylist,
      playlist: { text: fixed.text, contentType: streamKernel.PLAYLIST_MIME },
    };
  }

  /* `proxy` 的清单：每个地址改成面板**签名子地址**，落在客户端正在打的这个端口上的 `/api/emby/stream`
   * （Emby 实例端口只收 `/api/emby/` 前缀，绝不能指到 `/api/agg/stream`）。客户端照清单取分片时
   * 由面板带头发给上游 —— 不给分片带头，清单拿回来也播不了。
   * 搬运参数跟着 `sid` 存下来（见 stream.js 的 `relayPlaylist`），分片那几十发共用这一份。 */
  const fixed = streamKernel.relayPlaylist(got.text, got.url, {
    origin,
    headers,
    path: '/api/emby/stream',
    over: streamKernel.mergeRelayOverrides(over, play),
  });
  return {
    status: 200,
    log: `${label} parse=${play.parse} → 200 清单中继（${fixed.count} 个地址改成面板子地址）` + headerNoteRelay,
    playlist: { text: fixed.text, contentType: streamKernel.PLAYLIST_MIME },
  };
}

/** 条目公共字段拼装（BaseItemDto 最小公共集）；类型特有字段由调用方续写 */
/** 32 位 hex 的**稳定**哈希 —— `Etag` / `DisplayPreferencesId` / `PresentationUniqueKey` 用。
 * 必须稳定：客户端拿它们当缓存键，每次请求都变会让它反复失效。 */
function stableHash(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex');
}

function baseItem(f) {
  const item = {
    Id: f.id,
    ServerId: serverId(),
    Name: f.name || '',
    Type: f.type,
    MediaType: 'Video',
    IsFolder: true,
    ProductionYear: Number(f.year) || 0,
    CommunityRating: Number(f.communityRating) || 0,
    ProviderIds: f.providerIds || {},
    UserData: emptyUserData(),
    /* ⚠️ **数组字段一律先铺成 `[]`，不整个省略**（下面对应有值的会覆盖）。
     * 实测定性：SenPlayer 曾打不开本层的详情，而换成真机形状就正常 —— 真机把标准字段都给全了。
     * 客户端的解码器若把某个数组声明成**非可选**，键缺失会让**整个响应解码失败**，
     * 表现成「网络错误 / 不存在该项目」；给空数组就不会。**标量同理**（见下面的 DateCreated）。 */
    Genres: [],
    GenreItems: [],
    People: [],
    Studios: [],
    ProductionLocations: [],
    Taglines: [],
    RemoteTrailers: [],
    Tags: [],
    BackdropImageTags: [],
    ImageTags: {},
    MediaStreams: [],
  };
  if (f.parentId) item.ParentId = f.parentId;
  /* `PremiereDate` 是 **DateTime** 字段：拿不到就**不给这个键**（口径同函数末尾的 `DateCreated`）。
   * ⚠️ **绝不能写空串**：Dart/Flutter 客户端会对它做 `DateTime.parse(value)`，`parse('')`
   * 直接抛 `FormatException`，**整条响应解码失败**（实测就是本层被客户端报这个错的根因）。
   * 真机同场景**根本不含这个键**（Fields 门控之外，拿不到就省略），不是给空串 —— 对齐之。
   * `Overview` 同理：拿不到就不给，避免客户端把空串当有效简介展示。 */
  if (f.premiereDate) item.PremiereDate = f.premiereDate;
  if (f.overview) item.Overview = f.overview;
  /* ---- 真机 Emby 每个条目都带的「结构性字段」（按真机响应逐项补齐）----
   * 起因：SenPlayer 拿到那套薄字段就判定条目不可用（有线路也打不开），换真机形状立刻正常。
   * 所以**这些不是可有可无的装饰**。
   * 只放**能如实推导**的：布尔量是本地的事实（无章节/无锁定/不可删）；唯一键由条目 Id 派生
   * （它本就是 key，没有真假，且**必须稳定** —— 每次请求都变会让客户端缓存反复失效）；
   * 与**所选线路**相关的（Container / Size / Bitrate / MediaStreams / Path / FileName）
   * 在 getItem 拿到线路之后再补，这里给不了。
   * ⚠️ 真机有、但**本层不知道**的一律**不填**（口径：**不知道就空字段**），
   * 例如 `DateCreated`/`DateModified` 在拿不到发行日期时就是空的（见函数末尾）。 */
  item.SortName = item.Name;
  item.ForcedSortName = item.Name;
  item.PartCount = 1;
  item.Chapters = [];
  item.TagItems = [];
  item.LockData = false;
  item.LockedFields = [];
  item.CanDelete = false;
  /* 与握手 policy（`EnableContentDownloading`）和 `Items/{ItemId}/Download` 端点同一口径，
   * 跟随实例级「下载」开关（默认开）—— 三处必须一致，否则客户端"说支持又不给下"。
   * `CanDelete` 保持 false（删除确实没有）。 */
  item.CanDownload = allowDownload();
  item.LocalTrailerCount = 0;
  /* 真机**电影**条目两处（列表 + 详情）都带它 = 0；本层确实没有预告片/花絮这类附加内容，
   * 所以 0 是真话。（真机的**剧集**条目不给这个字段，给了也无害 —— 真机自己都不保证有。） */
  item.SpecialFeatureCount = 0;
  item.DisplayPreferencesId = stableHash('dp|' + f.id);
  item.PresentationUniqueKey = `p-mbp-${item.Type}-${stableHash(f.id)}`;
  if (f.originalTitle !== undefined) item.OriginalTitle = f.originalTitle;
  if (f.genres !== undefined) item.Genres = f.genres;
  if (f.childCount !== undefined) item.ChildCount = f.childCount;
  /* 图片：给 tag 就等于承诺「图片端点取得到」—— 端点已实现（见 routes.js 的 Images），所以现在照给。
   * tag 自带 URL，所以多给几张（logo / 多张背景）不需要改端点。
   * **一律走 `tagAndRemember`**：发 tag 的同时把「Id|类型|索引 → 图片位置」记进本地索引 ——
   * URL 本来就在手边，这一步是零成本的；记下来之后客户端**不带 tag** 来要图时才有答案（见 routes.js）。 */
  if (f.posterUrl) {
    const primaryTag = tagAndRemember(f.id, 'Primary', 0, f.posterUrl);
    item.ImageTags = { Primary: primaryTag };
    /* ⚠️ 协议里 Primary 的 tag 有**两个**存放位置：`ImageTags.Primary` 和便捷字段 `PrimaryImageTag`。
     * 只填前者的话，**读便捷字段的客户端会认为"这张图没有 tag"**，于是裸请求 `Images/Primary`（不带 tag）。
     * 而 Backdrop 只有 `BackdropImageTags` 一处 —— 这正好解释了实测里那个怪现象：
     * 同一个客户端 **Backdrop 带 tag、Primary 不带 tag（实测 200 次裸请求全 404）**。
     * 两个都填，客户端才拿得到 tag、走解密快路径。`PrimaryImageItemId` 同理：图就在本条目上。 */
    item.PrimaryImageTag = primaryTag;
    item.PrimaryImageItemId = f.id;
    item.PrimaryImageAspectRatio = 0.6666667;
  }
  if (f.logoUrl) item.ImageTags = Object.assign({}, item.ImageTags, { Logo: tagAndRemember(f.id, 'Logo', 0, f.logoUrl) });
  const backs = (f.backdropUrls && f.backdropUrls.length ? f.backdropUrls : f.backdropUrl ? [f.backdropUrl] : [])
    .map((u, i) => tagAndRemember(f.id, 'Backdrop', i, u))
    .filter(Boolean);
  if (backs.length) item.BackdropImageTags = backs;

  /* `DateCreated` / `DateModified` 用 **上游的发行日期**。
   * ⚠️ 语义：真机的这两个字段是**文件**的创建/修改时间，本层没有文件 —— 用"上映日期"近似。
   * 好处是客户端的「最近添加」会按**上映时间**排（比"首次见到"更有用）。
   * 拿不到发行日期（插件给的行只有 `year`、没有整日期）就**不给这两个字段** ——
   * 口径是"不知道就空字段"，宁缺勿编。
   * 实测佐证：**列表项一直没有这两个字段，而列表一直渲染正常** —— 所以缺它不会让客户端崩。 */
  const premiere = String(f.premiereDate || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(premiere)) {
    item.DateCreated = `${premiere}T00:00:00.0000000Z`;
    item.DateModified = item.DateCreated;
  }

  /* `Etag` 是**内容哈希**（客户端拿它判断"这条变没变"，所以必须**随内容变** ——
   * 内容变了 Etag 不变，客户端会一直吃旧缓存）。哈希里带上会被展示的元数据与图片 tag。 */
  item.Etag = stableHash(
    [f.id, item.Name, item.Overview, item.PremiereDate, item.RunTimeTicks, item.OfficialRating, item.PrimaryImageTag, (item.BackdropImageTags || []).join(',')].join('|')
  );
  return item;
}

/**
 * Emby 的 `UserItemDataDto`：本层没有观看记录，只回空进度。
 *
 * **字段与真机逐一对齐**：真机**条目**是
 * `{IsFavorite, PlayCount, PlaybackPositionTicks, Played}` —— 没有 `Key`
 * （早期多给了一个，已删掉：真机既然不给，客户端就不可能依赖它）。
 */
function emptyUserData() {
  return { IsFavorite: false, PlayCount: 0, PlaybackPositionTicks: 0, Played: false };
}

/**
 * 真机**库条目**的 `UserData` 比普通条目少一个 `PlayCount`（实测 25/25 都是三个字段）——
 * 所以库不该复用 `emptyUserData()`，否则形状与真机不同。
 */
function emptyViewUserData() {
  return { PlaybackPositionTicks: 0, IsFavorite: false, Played: false };
}

/**
 * Emby 的"从未修改/未知"零值 —— 真机库条目的 `DateModified` 25/25 全是它，照给（不是编的）。
 * **库的 `DateCreated` 也用它**：本层没有任何真实时间可用（库里没有"创建"这个动作，
 * 上游也没有对应实体），口径是"给个一看就知道是占位的值"，而它同时是合法时间
 * （`0000-00-00` 那种非法日期会让客户端的 DateTime 解析整条失败）。
 */
const ZERO_STAMP = '0001-01-01T00:00:00.0000000Z';

/* ------------------------------------------------------------------ 图片 */

/**
 * 图片 tag = `cpimg.<base64url(图片URL)>.<签名>`。
 *
 * **为什么把 URL 编进 tag**：客户端取图时**只回传 `Id` + `tag`，不回传 URL**；而条目 Id 是
 * `{域}_{编号}_{tv|movie}`，单靠它还原不出"插件给的那张图"（插件给的是完整 URL）。编进去就零额外调用，
 * 而且**详情**（上游图床 URL）与**列表**（插件给的 URL）统一成同一种形状，端点不必分类讨论。
 *
 * **为什么要签名**：图片端点**必须豁免 token**（实测图片请求的凭证携带不统一，同批 8 条里 3 条啥都不带），
 * 那它就是一个"面板代为取任意 URL"的接口 —— 不签名等于把面板变成局域网/Tailscale 上的**开放代理（SSRF）**。
 * 签名绑 `Id|URL`：tag 既不能挪到别的条目上用，也造不出新的 URL。
 * 密钥 `imageKey` **每个实例各一个**，首次用到时随机生成、落在实例清单（见 instance.identityOf，
 * 老版本写在 `data/settings/emby.json`），**不随任何 DTO 外发**。
 */
function imageKey() {
  return instance.identityOf().imageKey;
}

function imageSig(itemId, url) {
  return crypto.createHmac('sha256', imageKey()).update(`${itemId}|${url}`).digest('base64url').slice(0, 22);
}

function imageTag(itemId, url) {
  const u = String(url || '');
  if (!u) return '';
  return `cpimg.${Buffer.from(u, 'utf8').toString('base64url')}.${imageSig(itemId, u)}`;
}

/* ------------------------------------------- 图片索引（客户端不带 tag 时的答案） */

/**
 * 记一条「条目 Id|类型|索引 → 图片位置」，并把 tag 发出去。
 *
 * **这是出 tag 的唯一出口** —— 记账与发 tag 绑在一起，两者不可能漂移。
 *
 * 为什么必须有这张表（实测）：客户端（Lumenic）**从不回传 Primary 的 tag**，
 * 而 Emby 协议里 `Tag` 本就只是可选参数，所以裸请求是合规的。它启动时甚至**先**用自己
 * 缓存的条目 Id 要图、**后**才拉列表（时序：登录 → 4ms 后要图 → 213ms 后才拿到列表）。
 * ⇒ 只要图片位置只存在于 tag 里，这个客户端就永远取不到封面。
 *
 * **存的就是插件给的那个 URL**（完整地址，原样存原样取）：基地址是插件自己的设置，
 * 面板不替任何域记"基地址 + 相对路径"这套拼法 —— 代价是插件换了图床基地址之后，
 * 库里那批老地址要等 TTL 过期（或清一次图片索引）才自愈。
 */
function tagAndRemember(itemId, type, index, url) {
  const u = String(url || '');
  if (!u) return '';
  const key = `${itemId}|${String(type).toLowerCase()}|${Number(index) || 0}`;
  try {
    const cc = cache.cfg();
    cache.putImage(key, u, cc.imageTtlMs, cc.imageMaxBytes);
  } catch {
    /* 索引写失败不该影响出 tag —— 客户端带 tag 时照样能取到图 */
  }
  return imageTag(itemId, u);
}

/**
 * 图片索引查询：条目 Id + 类型 + 索引 → 完整图片 URL（查不到回 null）。
 * 值就是写进去时那个完整 URL，原样返回。
 */
function imageUrlFromIndex(itemId, type, index) {
  const key = `${itemId}|${String(type).toLowerCase()}|${Number(index) || 0}`;
  try {
    return cache.getImage(key) || null;
  } catch {
    return null;
  }
}

/** `imageTag()` 的逆：验签 + 只收 http(s) —— 认不出 / 验不过一律 null（不猜、不放行） */
function parseImageTag(itemId, tag) {
  const s = String(tag || '');
  if (!s.startsWith('cpimg.')) return null;
  const parts = s.split('.');
  if (parts.length !== 3) return null;

  let url;
  try {
    url = Buffer.from(parts[1], 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!/^https?:\/\//i.test(url)) return null;

  const want = imageSig(itemId, url);
  const got = parts[2];
  if (want.length !== got.length) return null;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got)) ? url : null;
}

/* ------------------------------------------------ 用户头像（品牌图标） */

/**
 * GET /Users/{UserId}/Images/{type} —— 用户头像（**豁免 AccessToken**，与条目图片同理：
 * 实测有客户端取图不带任何凭证）。
 *
 * **改用部署者提供的品牌图标**：所有用户共用 `assets/default-avatar.png`
 * （606×606、透明底），字节直接回 200。tag 见 `brandAvatar()` / `userAvatarTag()` —— 与
 * UserDto.PrimaryImageTag、SessionInfo.UserPrimaryImageTag 三处同源，换文件即全链失效。
 * 文件缺失/读失败 → **404**（不崩服务，客户端各级对无头像都有兜底）。
 *
 * 注：`type` 被**忽略** —— 真机请求头的形状是 `.../Images/Primary?...`，其余 type 真机也回主图，
 * 统一回同一张即可。
 */
function userImage(requestedId, type) {
  const av = brandAvatar();
  if (!av.png) {
    return {
      status: 404,
      body: { error: '头像文件缺失' },
      log: `用户头像 ${requestedId}/Images/${type} → 404（assets/default-avatar.png 读不到）`,
    };
  }
  return {
    status: 200,
    buffer: av.png,
    contentType: 'image/png',
    log: `用户头像 ${requestedId}/Images/${type} → 200 品牌图标（${av.png.length}B, tag=${av.tag.slice(0, 8)}…）`,
  };
}

module.exports = {
  EMBY_VERSION,
  serverId,
  allowDownload,
  userId,
  buildUser,
  publicInfo,
  systemInfo,
  hostOf,
  authenticate,
  tokenFrom,
  authorize,
  assertUser,
  getUser,
  userImage,
  getViews,
  getResume,
  recordPlayback,
  setHiddenFromResume,
  setPlayed,
  setFavorite,
  getStudios,
  getNextUp,
  getItemCounts,
  applyUserData,
  getItems,
  getLatest,
  getSeasons,
  getEpisodes,
  getItem,
  getSimilar,
  getPlaybackInfo,
  getSubtitle,
  resolveStream,
  mbpSourceId,
  parseMbpSourceId,
  streamPath,
  decodeSourceToken,
  baseItem,
  imageTag,
  parseImageTag,
  tagAndRemember,
  imageUrlFromIndex,
  parseClientHeader,
};
