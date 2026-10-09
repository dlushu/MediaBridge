'use strict';
/**
 * 站点测速任务（**服务端异步执行**）—— 站点表里那一列「延迟」的来源。
 *
 * 定时器 + **单飞** + 设置变更重排 + 开机延后跑第一轮（后三样与源插件里那份"自动更新"同构）。
 * 它干的事是"逐站打一发搜索"，一轮几十秒到十几分钟。
 *
 * 四条口径：
 *   · **打搜索**（转给源插件的「站点测速」动作），关键词从常见影视名里**随机取**，
 *     非 200 就**换一个词再测一发**（两发都非 200 才算真失败）—— 判据与实测见
 *     `agg/api.js` 的 `probeSearch` 与 `site-stats.js` 顶部；
 *   · **全部站点**（启用实例下的所有站点）—— 只测"已勾选"的话，没勾的站永远没有数据，
 *     而这一列本来就是用来决定"要不要勾它"的；
 *   · **并发 3**：源是路由器上那一个 Node 进程，并发拉高会排队、把每个站都拖过超时；
 *   · **单站固定 15 秒超时**（`api.SPEED_TEST_TIMEOUT_MS`），**不读**模板里的超时项
 *     （测速只打搜索，与业务那两档超时无关）。
 *
 * 什么时候跑：
 *   ① 每 `speedTestHours` 小时（默认 6）自动一轮 —— **跑完才排下一次**，不会因为一轮慢而堆起来；
 *      开机那一轮是"2 分钟后**且源已起来**"（见 `scheduleBoot`）；
 *   ② 手动（面板按钮 → `POST /api/agg/site-test/start`；可带 `keys` 只测当前筛选出来的站）。
 *
 * ⚠️ 原先还有第三条"**某个源起来/重启之后**只测那个源的站点" —— 这一版**去掉了**：
 * 源实例现在活在源插件里，面板收不到"它起来了"这件事（插件不反向通知面板）。
 * 开机那一轮会覆盖到自启的实例（源还在起就往后顺延，见 `scheduleBoot`）；
 * 要立刻看到数字就点单站那个「测速」按钮。
 *
 * 结果**直接覆盖上一次**（单槽，不留历史），所以界面上没有"第几次测速"这种东西 ——
 * 要看的永远是"这一轮测出来多少"。
 */
const settings = require('../../core/settings');
const api = require('./api');

/** 并发 —— 按 3：源是路由器上那一个 Node 进程，并发拉高会排队、把每个站都拖过超时 */
const CONCURRENCY = 3;
/** 默认：**开**、每 6 小时（`speedTestAuto === false` 才算关；HOURS 取值 1~168） */
const DEFAULTS = { enabled: true, hours: 6 };
/** 开机后先等 2 分钟再跑第一轮（与插件里那份自动更新同一口径：等面板自己先稳下来） */
const BOOT_DELAY_MS = 2 * 60 * 1000;
/** 开机那一轮：到点发现源还在起，就隔这么久再看一眼 */
const BOOT_RETRY_MS = 30 * 1000;
/** 开机那一轮等源的上限：等到这里还在起就照跑（如实测、如实记，不再等） */
const BOOT_WAIT_MAX_MS = 10 * 60 * 1000;

let timer = null;
let booted = false;
let running = false;
let stopRequested = false;

const st = {
  reason: '',
  startedAt: 0,
  finishedAt: 0,
  total: 0,
  done: 0,
  ok: 0,
  empty: 0,
  bad: 0,
  stopped: false,
  lastRunAt: 0,
  lastElapsedMs: 0,
  lastBad: 0,
  nextRunAt: 0,
};

/**
 * 当前配置（带兜底：设置文件里没有/写坏了也不会把定时器搞成 NaN）。
 *
 * ⚠️ 读的是**面板设置**（原在 `agg.json`）：测速是"这台机器与这条网络"的体检，
 * 与内容偏好无关 —— 不该跟模板走，也不该跟聚合参数混在一起（见 docs/adr/0033）。
 */
function cfg() {
  const s = settings.read('panel') || {};
  const hours = Math.min(168, Math.max(1, Number(s.speedTestHours) || DEFAULTS.hours));
  return { enabled: s.speedTestAuto !== false, hours };
}

/**
 * 上一次排期用的配置 —— 判断"这次保存要不要重排"。
 *
 * 为什么需要：`onSettingsChange` 是**整份 agg 设置**的钩子，勾选站点、改线路过滤、改打分…
 * 都会走到 `apply()`。若每次都重排，**每点一次站点勾选就把自动测速往后推 6 小时**，
 * 频繁改设置的实例会永远等不到自动那一轮（实测：重启后面板日志里连刷了五行"重新计时"）。
 * 所以只有"测速这两项"真的变了才重排。
 */
let armed = { enabled: false, hours: 0 };

/** 按新的小时数排期，并记下"排的是哪个配置" */
function armTimer(hours) {
  armed = { enabled: true, hours };
  schedule(hours * 3600 * 1000);
}

/** 给前端看的快照（进度 + 上次/下次） */
function state() {
  const { enabled, hours } = cfg();
  return {
    enabled,
    hours,
    concurrency: CONCURRENCY,
    timeoutMs: api.SPEED_TEST_TIMEOUT_MS,
    probeWords: api.PROBE_WORDS.length,
    bootDelayMs: BOOT_DELAY_MS,
    running,
    stopping: !!stopRequested,
    reason: st.reason || '',
    startedAt: st.startedAt || null,
    finishedAt: st.finishedAt || null,
    total: st.total,
    done: st.done,
    /* ⚠️ 这三个**不能**叫 `ok` / `empty` / `bad` 的裸名：`start()` 的返回值里 `ok` 是
     * "这次调用成功了吗"，同名字段会被这里的计数盖掉（实测踩过）。 */
    okCount: st.ok,
    emptyCount: st.empty,
    badCount: st.bad,
    stopped: !!st.stopped,
    lastRunAt: st.lastRunAt || null,
    lastElapsedMs: st.lastElapsedMs,
    lastBad: st.lastBad,
    nextRunAt: st.nextRunAt || null,
  };
}

/**
 * 跑一轮。**单飞由 `start()` 保证**（`running` 在函数体第一行就置位，调用后立刻生效）。
 * `keys`（`{source,key}[]`）= 只测这些站。
 */
async function run({ reason = 'manual', keys } = {}) {
  running = true;
  stopRequested = false;
  st.reason = reason;
  st.startedAt = Date.now();
  st.finishedAt = 0;
  st.total = 0;
  st.done = 0;
  st.ok = 0;
  st.empty = 0;
  st.bad = 0;
  st.stopped = false;

  const keySet = Array.isArray(keys) && keys.length ? new Set(keys.map((k) => `${k && k.source}\u0001${k && k.key}`)) : null;
  let list = [];
  try {
    const { sites } = await api.loadSites();
    list = (sites || []).filter((s) => {
      if (keySet && !keySet.has(`${s.source}\u0001${s.key}`)) return false;
      return true;
    });
  } catch (e) {
    console.log('  ✘ agg 测速：拿站点清单失败（' + ((e && e.message) || e) + '）—— 这一轮跳过');
  }
  st.total = list.length;
  if (list.length) {
    console.log(
      `  · agg 测速：开始（${reason}）—— ${list.length} 个站 · ${CONCURRENCY} 并发 · 单站 ${api.SPEED_TEST_TIMEOUT_MS / 1000}s 超时`
    );
  }

  const t0 = Date.now();
  const fails = [];
  let cursor = 0;
  await Promise.all(
    new Array(Math.min(CONCURRENCY, list.length || 1)).fill(0).map(async () => {
      for (;;) {
        if (stopRequested) return;
        const i = cursor++;
        if (i >= list.length) return;
        const s = list[i];
        let out = null;
        try {
          // eslint-disable-next-line no-await-in-loop
          out = await api.probeSearch({ source: s.source, key: s.key, api: s.api });
        } catch {
          out = null;
        }
        st.done += 1;
        const one = (out && out.search) || null;
        if (!one || out.ok === false) {
          st.bad += 1;
          fails.push(`${s.name || s.key}（${(one && one.error) || '测速请求失败'}）`);
        } else if (!one.ok) {
          st.bad += 1;
          fails.push(`${s.name || s.key}（${one.error || '失败'}${one.tries > 1 ? '，换词后仍失败' : ''}）`);
        } else if (one.count === 0) {
          st.empty += 1;
        } else {
          st.ok += 1;
        }
      }
    })
  );

  const elapsed = Date.now() - t0;
  st.stopped = stopRequested;
  st.finishedAt = Date.now();
  st.lastRunAt = st.finishedAt;
  st.lastElapsedMs = elapsed;
  st.lastBad = st.bad;
  running = false;
  stopRequested = false;

  if (st.total || reason === 'manual') {
    console.log(
      `  ${st.bad ? '⚠' : '✔'} agg 测速${st.stopped ? '（被停止）' : ''}：${st.done}/${st.total} 个站 · ` +
        `${(elapsed / 1000).toFixed(1)}s · 成功 ${st.ok + st.empty}${st.empty ? `（其中 ${st.empty} 个无结果）` : ''}` +
        (st.bad ? ` · 失败 ${st.bad}：${fails.slice(0, 5).join('、')}${fails.length > 5 ? ' …' : ''}` : '')
    );
  }

  /* 跑完才排下一次；期间自动测速被关掉的话就不排（apply() 通常已经 clearTimer，这里兜一下） */
  const now = cfg();
  if (now.enabled) armTimer(now.hours);
  else clearTimer();
}

/** 开一轮（已经在跑就回 `busy` —— 路由层照此回 409） */
function start({ reason = 'manual', keys } = {}) {
  if (running) return { ok: false, busy: true, error: '上一次测速还没跑完' };
  run({ reason, keys }).catch((e) => console.log('  ✘ agg 测速失败（已拦截）：' + ((e && e.message) || e)));
  return Object.assign({ ok: true }, state());
}

/** 请求停止当前这一轮（worker 下一轮就退出；已经测完的那些结果照常保留） */
function stop() {
  if (!running) return Object.assign({ ok: true, running: false }, state());
  stopRequested = true;
  return Object.assign({ ok: true, stopping: true }, state());
}

function clearTimer() {
  if (timer) clearTimeout(timer);
  timer = null;
  st.nextRunAt = 0;
}

/** 排下一次（先清旧的：改设置/跑完一轮之后都从现在重新计时） */
function schedule(delayMs) {
  clearTimer();
  if (!cfg().enabled) return;
  st.nextRunAt = Date.now() + delayMs;
  timer = setTimeout(() => {
    timer = null;
    const r = start({ reason: 'timer' });
    /* ⚠️ 撞上正在跑的一轮（例如手动点的那一轮）时**必须重排** ——
     * 否则自动测速这条线就断了（没有任何地方会再把它排回来）。隔一分钟再试。 */
    if (r.busy) {
      console.log('  · agg 测速：到点了但上一轮还在跑 —— 一分钟后重试');
      schedule(60 * 1000);
    }
  }, delayMs);
  /* 别让一个定时器把进程吊着不退出（面板本来常驻，这只是"退出时别等它"） */
  if (timer.unref) timer.unref();
}

/**
 * 还有源在起吗 —— 开机那一轮的闸门（判据与理由见 `scheduleBoot` 的注记）。
 *
 * 只看站点清单里 `sources[].status`：插件进程自己没加载完、或它托管的源实例还在起，
 * 那一行都是 `starting`。**永久起不来的实例是 `error` / `stopped`**，不算"还在起"。
 */
async function sourcesStarting() {
  try {
    const { sources } = await api.loadSites();
    return (sources || []).some((s) => s.status === 'starting');
  } catch {
    /* 问不出来就当它不在起：到点照跑，如实测、如实记（不因为一次问不动就把这一轮丢了） */
    return false;
  }
}

/**
 * 开机那一轮的排期：到点先看源起没起，还在起就隔 `BOOT_RETRY_MS` 再看，直到 `deadline`。
 *
 * **为什么不能"到 2 分钟就测"**：插件进程报 `ready` 只代表它的入口加载完了 —— 它托管的
 * 源实例（下包 / 起进程 / 端口 bind）要几十秒到几分钟，而且是**一个个串着起**的。
 * 实例没起来时站点清单里根本没有它的站点（`sites` 只报拉得到站点表的实例），
 * 那一轮测出来的不是"站况"而是"起没起来"，还会把好站记成失败（`shouldSkip` 据此跳过它，
 * 一路跳到下一轮）。面板看不到实例本身，只能透过站点清单那一行的 `status` 看它还在不在起。
 *
 * 到 `deadline` 还在起就**照跑**：等下去也未必等得到（比如实例就是起不来），
 * 如实测、如实记比无限期推迟有用。
 */
function scheduleBoot(delayMs, deadline, { announce = true } = {}) {
  clearTimer();
  if (!cfg().enabled) return;
  st.nextRunAt = Date.now() + delayMs;
  timer = setTimeout(async () => {
    timer = null;
    if (Date.now() < deadline && (await sourcesStarting())) {
      if (announce) {
        console.log(
          `  · agg 测速：源还在起，开机这一轮先等 —— 每 ${BOOT_RETRY_MS / 1000}s 看一眼，` +
            `最多等到开机后 ${Math.round(BOOT_WAIT_MAX_MS / 60000)} 分钟`
        );
      }
      scheduleBoot(BOOT_RETRY_MS, deadline, { announce: false });
      return;
    }
    const r = start({ reason: 'timer' });
    /* 撞上正在跑的一轮（例如手动点的那一轮）时**必须重排** —— 理由同 `schedule()` */
    if (r.busy) {
      console.log('  · agg 测速：到点了但上一轮还在跑 —— 一分钟后重试');
      schedule(60 * 1000);
    }
  }, delayMs);
  /* 别让一个定时器把进程吊着不退出（理由同 `schedule()`） */
  if (timer.unref) timer.unref();
}

/** 设置变了就按新配置重排（「保存」→ core 调 onSettingsChange） */
function apply() {
  const { enabled, hours } = cfg();
  if (!enabled) {
    if (!armed.enabled) return; // 本来就是关的：不刷日志，也不动计时器
    clearTimer();
    armed = { enabled: false, hours: 0 };
    if (booted) console.log('  · agg 测速：已关闭（下次不再自动测）');
    return;
  }
  /* 测速这两项没变（多半只是勾了个站点）→ 不动计时器：否则每点一次勾选就把下一次推迟 6 小时 */
  if (armed.enabled && armed.hours === hours) return;
  armTimer(hours);
  if (booted) console.log(`  ↻ agg 测速：已开启，每 ${hours} 小时自动测一轮（从现在重新计时）`);
}

/** 开机调用一次（server.js 在面板起来后调），默认就是开的 */
function boot() {
  booted = true;
  const { enabled, hours } = cfg();
  if (!enabled) {
    armed = { enabled: false, hours: 0 };
    console.log('  · agg 测速：已关闭（可在「聚合设置 → 聚合参数」打开）');
    return;
  }
  console.log(
    `  ↻ agg 测速：每 ${hours} 小时自动测一轮（${Math.round(BOOT_DELAY_MS / 60000)} 分钟后先跑一次，` +
      `源没起来就往后顺延；全部站点 · ${CONCURRENCY} 并发 · 单站 ${api.SPEED_TEST_TIMEOUT_MS / 1000}s 超时 · 随机片名）`
  );
  /* 开机这一轮是"2 分钟后（且源已起来）"，不是"6 小时后" —— 只把"排的是哪个配置"记下来，下一轮起才按小时排 */
  armed = { enabled: true, hours };
  scheduleBoot(BOOT_DELAY_MS, Date.now() + BOOT_WAIT_MAX_MS);
}

/**
 * 某个站点测速的入口已经被移到"单站按钮"那条路（`api.probeSearch`）——
 * 这一版**去掉了"源起来了就测一轮"**，理由见文件顶部那条注记。
 */

module.exports = { DEFAULTS, CONCURRENCY, BOOT_DELAY_MS, cfg, state, start, stop, apply, boot };
