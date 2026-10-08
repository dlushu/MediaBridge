'use strict';
/**
 * 面板层（宿主层，不参与数据链）
 *
 *   自己：面板监听参数、模块启用、配置备份/还原、服务自述
 *   对外：/api/panel/*、/api/modules*、/api/meta
 */
const routes = require('./routes');
const update = require('./update');
const logbus = require('../../core/logbus');
const cachedb = require('../../core/cachedb');
const auth = require('../../core/auth');

module.exports = {
  id: 'panel',
  label: '面板设置',
  apiPrefix: ['/api/panel', '/api/modules', '/api/meta', '/api/logs', '/api/auth'],
  upstream: null,

  settings: {
    defaults: () => ({
      host: '0.0.0.0',
      port: 8088,
      /* 面板「日志」页的内存缓冲条数（见 core/logbus.js）。**纯内存、不落盘**，
       * 所以这个数直接决定内存占用上限（500 条 ≈ 最多 0.5MB）。 */
      logMax: 500,
      /* 站点测速的**开关与间隔**（实现见 agg/site-test.js）。
       * 为什么归面板层：测速是"这台机器与这条网络"的体检，与内容偏好无关 ——
       * 它既不跟模板走（模板是内容偏好），也不该跟"这次测了哪些站"混在一起。
       * ⚠️ 测速的**结果**（站点统计）也是面板级共享的一份，不跟模板走，见 docs/adr/0033。 */
      speedTestAuto: true,
      speedTestHours: 6,
      /* 登录态有效期（分钟）：**默认 15、上限 30 天（43200）**，语义是**滑动过期** ——
       * 从"最后一次使用"起算，一直在用就顺延，空闲满这一时长才失效（见 core/auth.js 的 guard）。
       * 归面板层：它是"这道门开多久"的取舍，不是哪一栏的偏好；读写只有 core/auth.js 一处。 */
      sessionMinutes: 15,
      modules: { source: true, agg: true, emby: true, panel: true },
      /* ⚠️ 元数据设置**不在面板层**（原来在）——它随元数据插件走：token / 基地址 / 语言 /
       * 它自己的缓存都在**插件自己的数据目录**里，UI 是插件自己的设置页。
       * 面板只从插件的「注册」动作里拿**图片基地址**（替客户端取图要拼串，见 emby/meta.js）。 */
      /* 本地缓存策略（原在 emby 层）—— 面板这边还剩两个库：
       *   core 的 `data/cache/lines.db`（line_cache = **线路结果缓存**，见 agg/cache.js）
       *   emby 的 `data/emby/cache.db`（image_index 图片索引）
       * 而「用量显示 / 清空缓存 / 设置改小后立刻淘汰」都要一把抓 —— 所以设置放在
       * 宿主层，UI 在「面板设置 → 缓存设置」。默认值与读法只此一处：`core/cachedb.js` 的 cfg()。
       *   imageTtlDays 图片索引的存活期 —— URL 几乎不变，但换图床基地址后靠它自愈
       *   imageMaxMB   图片索引上限（无头路径，一条约几十字节，5MB 已经远超实际用量）
       *   linesTtlDays / linesNeverExpire / linesMaxMB
       *                 **线路结果**缓存活多久、最多占多少字节 —— **按天、默认 1 天**
       *                （口径见 docs/adr/0032：面板侧只挡"点一次播放连问三遍"，按天的热度
       *                由插件自己的缓存承担）。0 = 不缓存；勾了「长期有效」就不看天数；
       *                `linesMaxMB` 是总字节上限（0 = 不限）。
       *                上限默认 32MB：一条结果含全站的线路与选集（每个选集 ID 是 600~720 字符的
       *                token），实测几十~几百 KB 一条。
       * **上限一律按字节不按条数**：lean 1.9KB vs rich 119KB 差 60 倍，按条数算不准。 */
      cache: Object.assign({}, cachedb.DEFAULTS),
      /* 字节中继的搬运方式（实现见 agg/stream.js 的 relayBytes）。
       * ⚠️ 网盘 CDN **按 Range 的形态限速**：开放式 `bytes=0-` 实测 ~0.1MB/s，有界 Range ~3.5MB/s ——
       * 所以中继默认**切块 + 多路并发**（默认值：16 路 / 512KB）。
       * `enabled: false` 退回"单连接、Range 原样透传"（排查与对比用）。
       * 源插件也可以在 `play` 返回里带 `threads` / `chunkKB` 覆盖这一组（那一路优先）。 */
      streamRelay: { enabled: true, threads: 16, chunkKB: 512, forwardEnabled: false, forwardUrl: '', forwardSecret: '' },
    }),
    fields: [
      { key: 'port', label: '面板端口', type: 'number', min: 1, max: 65535 },
      { key: 'host', label: '监听地址', type: 'text', placeholder: '0.0.0.0（局域网可访问）或 127.0.0.1' },
      { key: 'logMax', label: '日志缓冲条数', type: 'number', min: 50, max: 5000, hint: '「日志」页只留最近这么多条（纯内存，不落盘；长期留档看 docker logs）' },
      { key: 'sessionMinutes', label: '登录态有效期（分钟）', type: 'number', min: 1, max: 43200, hint: '默认 15 分钟、最大 43200（30 天）。按"最后一次操作"起算，一直在用就顺延，空闲满这一时长才需要重新登录' },
      { key: 'cache.imageTtlDays', label: '图片索引天数', type: 'text', placeholder: '90' },
      { key: 'cache.imageMaxMB', label: '图片索引上限 MB', type: 'text', placeholder: '5' },
      { key: 'cache.linesTtlDays', label: '线路结果天数', type: 'text', placeholder: '1（0 = 不缓存）' },
      { key: 'cache.linesMaxMB', label: '线路结果上限 MB', type: 'text', placeholder: '32（0 = 不限）' },
      { key: 'cache.linesNeverExpire', label: '线路结果长期有效', type: 'boolean', hint: '勾上就不按天数过期（只要你不动设置，源里有什么就一直用那份）' },
      { key: 'streamRelay.enabled', label: '中继分块并发', type: 'boolean', hint: '勾上：按块切、多路并发发有界 Range（默认）。关掉退回单连接原样透传，用于对比排查。配了外部字节代理时同样生效：关掉就不给代理传并发参数（代理单连接透传）' },
      { key: 'streamRelay.threads', label: '中继并发路数', type: 'number', min: 1, max: 32, hint: '同时在飞的有界 Range 请求数（默认 16）。配了外部字节代理时随 302 传给代理，同样生效' },
      { key: 'streamRelay.chunkKB', label: '中继分块 KB', type: 'number', min: 64, max: 8192, hint: '每块大小（默认 512KB）。配了外部字节代理时随 302 传给代理，同样生效' },
      { key: 'streamRelay.forwardEnabled', label: '外转到外部字节代理', type: 'boolean', hint: '打开：要鉴权头的线路不再由面板搬字节，302 到下方填的代理，上游地址/请求头/并发参数全部随 URL 带过去，由它取流。关掉 = 面板自己中继（即使填了 URL 也不生效）' },
      { key: 'streamRelay.forwardUrl', label: '外部字节代理 URL', type: 'text', placeholder: 'https://xxx.workers.dev', hint: '代理端用 Cloudflare Worker 部署，代码与一键部署见 https://github.com/dlushu/media-bridge-relay' },
      { key: 'streamRelay.forwardSecret', label: '外部代理签名密钥', type: 'text', placeholder: '与 Worker 侧 SECRET 一致（可选）', hint: '可选：两边填同一个值，302 链接带 HMAC 签名，代理验签防白嫖；不填不带签名' },
    ],
    validate: (o) => {
      if (!(Number(o.port) >= 1 && Number(o.port) <= 65535)) return 'port 取值 1~65535';
      /* 登录态有效期：分钟，1 ~ 43200（30 天）。越界拒绝 —— 让"改动没生效"当场可见，
       * 而不是悄悄退回默认（core/auth.js 那边遇到坏值才退默认）。 */
      if (!(Number(o.sessionMinutes) >= 1 && Number(o.sessionMinutes) <= 43200)) {
        return `sessionMinutes 取值 1~43200（分钟，即 1 分钟~30 天；当前：${o.sessionMinutes}）`;
      }
      /* 缓存数值必须是「非负数字」（原为 emby 的设置校验，已迁到此处）。
       * ⚠️ 两个 0 的语义**不一样**（见 core/cachedb.js 的 cfg）：
       *   天数 0 = 不缓存（写完即过期）；上限 0 = **不限**（不淘汰）。二者不可当作同一语义处理。 */
      const c = (o && o.cache) || {};
      for (const key of ['imageTtlDays', 'imageMaxMB', 'linesTtlDays', 'linesMaxMB']) {
        const v = c[key];
        if (v === undefined || v === null || v === '') continue;
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0) return `cache.${key} 必须是不小于 0 的数字（当前：${v}）`;
      }
      /* 中继搬运参数只在"填了"时校验（空 = 用默认），且必须落在实现能接受的范围内
       * （上限见 agg/stream.js 的 RELAY_MAX_THREADS / RELAY_MAX_CHUNK_KB） */
      const sr = (o && o.streamRelay) || {};
      for (const [key, lo, hi] of [['threads', 1, 32], ['chunkKB', 64, 8192]]) {
        const v = sr[key];
        if (v === undefined || v === null || v === '') continue;
        const n = Number(v);
        if (!Number.isFinite(n) || n < lo || n > hi) {
          return `streamRelay.${key} 取值 ${lo}~${hi}（当前：${v}）`;
        }
      }
      /* 外部字节代理只收 http(s)：这是面板 302 要跳过去的外部地址 */
      const fu = String(sr.forwardUrl || '').trim();
      if (fu && !/^https?:\/\//i.test(fu)) return `streamRelay.forwardUrl 必须是 http(s) 地址（当前：${fu}）`;
      if (sr.forwardEnabled && !fu) return '开了「外转到外部字节代理」但没填外部字节代理 URL';
      return null;
    },
  },

  /**
   * 设置改动后立刻落实（由面板的通用设置端点调用，见 panel/routes.js）。
   *
   * 两件事各管各的：
   *   ① `logMax` 改了马上生效（`resize` 会清空现有缓冲，`seq` 不动）—— 但这一页不止它一个设置，
   *      别的键改了不该顺手把日志清掉，所以要比一下；
   *   ② **缓存上限调小后立刻淘汰**（面板这边那两份缓存的 `sweepAll()`）——
   *      否则面板上会显示「已用 60MB / 上限 10MB」，看着像坏了，实际要等下次写入才收拾。
   */
  onSettingsChange(next) {
    const old = Number(logbus.stats().max);
    const v = Number(next && next.logMax);
    if (Number.isFinite(v) && v > 0 && v !== old) logbus.resize(v);
    /* 会话有效期改了要让 core/auth.js 那份内存缓存失效（它只在启动 / 失效后读一次设置） */
    auth.invalidateTtl();
    try {
      cachedb.sweepAll();
    } catch {
      /* 清理失败不该让"保存设置"这件事失败 */
    }
  },

  /** 启动成功后清掉"当前版本之外"的版本目录（每次启动都跑，见 update.js 的 pruneOnBoot） */
  pruneOnBoot: (opts) => update.pruneOnBoot(opts),

  /** 退出前调一次：非托管运行方式下的「面板重启」，在这里把新进程拉起来（见 update.js 的 relaunchIfPending） */
  relaunchIfPending: () => update.relaunchIfPending(),

  routes,
};
