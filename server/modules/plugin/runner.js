'use strict';
/**
 * 插件进程那一半（**由宿主 spawn，插件作者不用管这个文件**）。
 *
 * 用法：`node runner.js <插件目录> <入口文件>`
 *
 * 这个文件做三件事：切到插件目录、加载它的入口、把宿主的消息分发给它的动作。
 * 面板与插件之间的协议（管道，JSON 消息）：
 *
 *   宿主 → 插件   `{ id, role?, action, args }`（多类型包按 role 在分组 actions 里分发，见 adr/0046）
 *   插件 → 宿主   `{ id, ok: true, value }` / `{ id, ok: false, error: { code, message, cause? } }`
 *   插件 → 宿主   `{ type: 'ready', actions: [...] }`（加载完成后发一次）
 *   插件 → 宿主   `{ type: 'fatal', error }`（入口有问题，装不起来）
 *   插件 → 宿主   `{ type: 'hostCall', id, target, action, args }`（反向调用宿主能力）
 *   宿主 → 插件   `{ type: 'hostCallReply', id, ok, value? , error? }`
 *
 * **插件侧要做的**：`module.exports = { actions: { 动作名: async (args, ctx) => 返回值 } }`。
 * 名字与形状见 docs/plugin-contract.md —— 契约里没有的字段，面板不会提供。
 * `ctx.hostCall(target, action, args)` 可请宿主代调面板能力（白名单见 host-api.js）。
 *
 * ⚠️ 插件**自己**能读盘、能联网、能起进程（不沙箱，见 docs/adr/0028）；
 * 这个文件不替它做任何事，只负责把"面板问什么、它答什么"接起来。
 */
const path = require('path');

const dir = path.resolve(String(process.argv[2] || ''));
const main = String(process.argv[3] || 'index.js');

let seq = 0;
function send(msg) {
  try {
    if (process.send) process.send(msg);
  } catch {
    /* 管道断了：宿主已经不当这个进程活着了，什么都不用做 */
  }
}

function fatal(message) {
  send({ type: 'fatal', error: String(message) });
  console.error('[插件] 起不来：' + message);
  process.exit(1);
}

/* 切到插件目录：插件用相对路径读自己的文件（例如 ui/、模板）时才不会读错地方 */
try {
  process.chdir(dir);
} catch (e) {
  fatal('切到插件目录失败：' + ((e && e.message) || e));
}

let mod;
try {
  mod = require(path.join(dir, main));
} catch (e) {
  fatal('加载入口失败：' + ((e && e.stack) || e));
}

const actions = (mod && mod.actions) || null;
if (!actions || typeof actions !== 'object' || Array.isArray(actions)) {
  fatal('入口必须导出 `module.exports = { actions: { … } }`');
}
/**
 * 动作表有两种形状（见 docs/adr/0046）：
 *   · 单类型包：扁平 `{ 动作名: fn }`
 *   · 多类型包：按角色分组 `{ source: { 动作名: fn }, home: { … } }`
 * 同一个 actions 对象允许只有一层（全扁平）或全是分组；分组内必须都是函数。
 */
const roleActions = {};
const flatActions = {};
for (const [name, fn] of Object.entries(actions)) {
  if (fn && typeof fn === 'object' && !Array.isArray(fn)) {
    for (const [an, afn] of Object.entries(fn)) {
      if (typeof afn !== 'function') fatal(`分组动作 ${name}.${an} 不是函数`);
    }
    roleActions[name] = fn;
  } else if (typeof fn === 'function') {
    flatActions[name] = fn;
  } else {
    fatal(`动作 ${name} 既不是函数也不是角色分组`);
  }
}

/** 宿主消息带的 role → 处理器；没给 role / 没匹配到分组时回退到扁平表 */
function resolveFn(role, action) {
  if (role && roleActions[role] && typeof roleActions[role][action] === 'function') return roleActions[role][action];
  return flatActions[action] || null;
}

/** ready 时报给宿主的动作清单（分组的写成 `角色/动作`，管理页原样显示） */
const actionNames = [
  ...Object.keys(flatActions),
  ...Object.entries(roleActions).flatMap(([role, map]) => Object.keys(map).map((a) => `${role}/${a}`)),
];

/** 交给插件的上下文：只有它自己的身份、数据目录与日志口 */
const types = String(process.env.MBP_PLUGIN_TYPES || process.env.MBP_PLUGIN_TYPE || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const ctx = {
  types,
  type: types[0] || String(process.env.MBP_PLUGIN_TYPE || ''),
  id: String(process.env.MBP_PLUGIN_ID || ''),
  dataDir: path.join(dir, 'data'),
  /** 打日志：走 stdout → 宿主转发进面板日志（带 `[plugin:<id>]` 前缀） */
  log: (...args) => console.log(...args),
};

/* ------------------------------------------------- 插件 → 宿主 反向调用
 *
 * `ctx.hostCall(target, action, args)` —— 插件请宿主替它调面板主进程里的能力
 * （output 插件读首页行 / 聚合搜索 / 取播放地址用，见宿主侧 host-api.js 的白名单）。
 * 消息：插件 → 宿主 { type:'hostCall', id, target, action, args }
 * 回信：宿主 → 插件 { type:'hostCallReply', id, ok, value? , error? }
 * 与正向调用同口径：超时只让这一次失败，不杀进程。
 */
const HOSTCALL_TIMEOUT_MS = 30000;
const hostCalls = new Map();
let hostCallSeq = 0;

ctx.hostCall = (target, action, args) =>
  new Promise((resolve, reject) => {
    if (typeof process.send !== 'function') {
      reject(new Error('当前没有 IPC 通道，hostCall 不可用'));
      return;
    }
    const id = ++hostCallSeq;
    const timer = setTimeout(() => {
      hostCalls.delete(id);
      reject(new Error(`hostCall ${target}/${action} 超时（${HOSTCALL_TIMEOUT_MS}ms）`));
    }, HOSTCALL_TIMEOUT_MS);
    timer.unref?.();
    hostCalls.set(id, { resolve, reject, timer });
    try {
      process.send({ type: 'hostCall', id, target: String(target || ''), action: String(action || ''), args: args || {} });
    } catch (e) {
      clearTimeout(timer);
      hostCalls.delete(id);
      reject(new Error('hostCall 发送失败：' + ((e && e.message) || e)));
    }
  });

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object' || msg.type !== 'hostCallReply') return;
  const one = hostCalls.get(msg.id);
  if (!one) return;
  hostCalls.delete(msg.id);
  clearTimeout(one.timer);
  if (msg.ok) one.resolve(msg.value);
  else {
    const e = new Error((msg.error && msg.error.message) || '宿主返回了错误');
    e.code = (msg.error && msg.error.code) || 'HOST_ERROR';
    one.reject(e);
  }
});

process.on('message', async (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'ping') return send({ type: 'pong', at: Date.now() });
  /* hostCall 的**回执**由上面那个监听器认领 —— 绝不能落到这里：它带着 id 但没有
   * action，会被当成"宿主在调一个未实现的动作"回一封 NO_ACTION，而那封假回信的
   * id 恰好可能撞上宿主正等的正向调用 id（首调双向 id 都从 1 起），把真结果顶掉。 */
  if (msg.type === 'hostCallReply') return;
  if (!msg.id) return;
  const id = msg.id;
  /* role 路由（见 docs/adr/0046）：多类型包按消息带的角色进分组，单类型包走扁平表 */
  const fn = resolveFn(String(msg.role || ''), msg.action);
  if (typeof fn !== 'function') {
    return send({
      id,
      ok: false,
      error: {
        code: 'NO_ACTION',
        message: `这个插件没有实现动作「${msg.role ? msg.role + '/' : ''}${msg.action}」（它实现的是：${actionNames.join(' / ')}）`,
      },
    });
  }
  const t0 = Date.now();
  try {
    const value = await fn(msg.args || {}, ctx);
    seq += 1;
    send({ id, ok: true, value, ms: Date.now() - t0 });
  } catch (e) {
    /* 失败如实（总契约「十、失败与诊断」）：`code` 原样透传。`fetch()` 这类失败的真因不在
     * `e.message`（永远是 "fetch failed"），而在 `e.cause`（如 `ENOTFOUND` / `bad port`）——
     * 一并顶到 `code` 并整体带回，别把网络故障压成一句光秃秃的 "fetch failed"。 */
    const cause = e && e.cause;
    const err = {
      code: (e && e.code) || (cause && cause.code) || 'PLUGIN_ERROR',
      message: (e && e.message) || String(e),
    };
    if (cause && (cause.code || cause.message)) err.cause = { code: cause.code, message: cause.message };
    send({ id, ok: false, error: err, ms: Date.now() - t0 });
  }
});

/* 插件自己抛的异步错误：如实记一行，**不让进程退出**（退出会把没答完的请求全丢掉） */
process.on('unhandledRejection', (e) => console.error('[插件] 未处理的 Promise 拒绝：' + ((e && e.stack) || e)));

send({ type: 'ready', actions: actionNames });
