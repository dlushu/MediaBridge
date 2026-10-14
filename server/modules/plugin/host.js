'use strict';
/**
 * 插件宿主：**每个插件包一个常驻子进程**，面板通过**管道**（child IPC）与它通话。
 *
 * 多类型（见 docs/adr/0046）：一个包（一个 id、一个目录、一个进程）可同时具备多个平级
 * 类型。`start/stop/call(type,id,…)` 的签名不变，`type` 是**角色参数**：按 id 定位进程，
 * 调动作时把 `role` 一起发给插件，由它在分组 actions 里分发。
 *
 * 四件事：
 *   ① 起停：`spawn` 一个常驻进程（入口是 `runner.js`），stdout/stderr 转进面板日志；
 *   ② 通话：`call(type, id, action, args)` —— 发 `{ id, role, action, args }` 等回执；
 *   ③ 看护：进程自己退出只**如实记账**，**不自动重启**；
 *   ④ 观测：状态（在不在跑、pid、最近一次错误），`states()` 按 types 展开成多行。
 */
const path = require('path');
const { spawn } = require('child_process');
const store = require('./store');
const contract = require('./contract');
const hostApi = require('./host-api');

/** 每次调用插件的默认超时（毫秒）。插件慢不等于坏，所以超时只影响**这一次**调用 */
const DEFAULT_CALL_TIMEOUT_MS = 20000;
/** 启动后多久还没报 ready 就当起不来（进程会留着，但状态标成"没就绪"） */
const READY_TIMEOUT_MS = 15000;
/** SIGKILL 之后还愿意等多久（等不到就放弃等待，不无限挂着调用方） */
const KILL_GRACE_MS = 2000;

/** 插件 id → 运行态（一个包只有一个进程） */
const running = new Map();

const logTag = (id) => `[plugin:${id}]`;

function log(line) {
  console.log('  ' + line);
}

/**
 * 起一个插件进程。已经在跑的**不重复起**（返回现有那份状态）。
 * `type` 只用来定位包（必须是它声明的角色之一）；真正的进程键是 id。
 */
function start(type, id) {
  const entry = store.get(type, id);
  if (!entry) return { ok: false, error: `没有这个插件：${type}/${id}` };
  const pkgId = entry.id;

  const cur = running.get(pkgId);
  if (cur && cur.proc && cur.proc.exitCode === null) return { ok: true, state: stateOf(entry.types[0], pkgId) };

  const dir = store.dirOf(pkgId);
  let manifest;
  try {
    manifest = contract.readManifest(dir);
  } catch (e) {
    const st = Object.assign(cur || {}, {
      id: pkgId,
      types: entry.types,
      status: 'broken',
      lastError: (e && e.message) || String(e),
    });
    running.set(pkgId, st);
    log(`✘ 插件起不来 ${logTag(pkgId)}：${st.lastError}`);
    return { ok: false, error: st.lastError };
  }

  const proc = spawn(process.execPath, [path.join(__dirname, 'runner.js'), dir, manifest.main], {
    cwd: dir,
    env: Object.assign({}, process.env, {
      MBP_PLUGIN_ID: pkgId,
      /* 多类型：整组类型都告诉插件；旧的单值变量留一个过渡（= 第一个类型）。 */
      MBP_PLUGIN_TYPES: entry.types.join(','),
      MBP_PLUGIN_TYPE: entry.types[0],
    }),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  const st = {
    id: pkgId,
    types: entry.types.slice(),
    domain: entry.domain || '',
    proc,
    pid: proc.pid,
    status: 'starting', // starting / running / stopped / broken
    actions: [],
    startedAt: Date.now(),
    lastError: '',
    inflight: new Map(),
    seq: 0,
    /** 主动停的标记：用来区分"宿主叫它停"与"它自己崩了" */
    stopping: false,
  };
  running.set(pkgId, st);

  /* 插件的输出**逐行转发进面板日志**（带前缀），排查时一眼看出是谁打的 */
  const pipe = (stream, level) => {
    let buf = '';
    stream.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        const t = l.trimEnd();
        if (t) console.log(`  ${level === 'err' ? '✘' : '·'} ${logTag(pkgId)} ${t}`);
      }
    });
  };
  pipe(proc.stdout, 'out');
  pipe(proc.stderr, 'err');

  const readyTimer = setTimeout(() => {
    if (st.status === 'starting') {
      st.lastError = `启动后 ${READY_TIMEOUT_MS / 1000} 秒没有报 ready（入口可能卡住了）`;
      log(`⚠️ 插件没就绪 ${logTag(pkgId)}：${st.lastError}`);
    }
  }, READY_TIMEOUT_MS);

  proc.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') {
      clearTimeout(readyTimer);
      st.status = 'running';
      st.actions = Array.isArray(msg.actions) ? msg.actions : [];
      st.lastError = '';
      log(`✔ 插件已就绪 ${logTag(pkgId)}：动作 ${st.actions.join(' / ') || '(无)'}`);
      return;
    }
    if (msg.type === 'fatal') {
      clearTimeout(readyTimer);
      st.status = 'broken';
      st.lastError = String(msg.error || '入口报 fatal');
      log(`✘ 插件报告 fatal ${logTag(pkgId)}：${st.lastError}`);
      return;
    }
    /* 插件 → 宿主 的反向调用（output 插件读首页 / 聚合能力用，见 host-api.js）。 */
    if (msg.type === 'hostCall') {
      hostApi
        .dispatch(msg)
        .then((result) => {
          try {
            st.proc.send(Object.assign({ type: 'hostCallReply', id: msg.id }, result));
          } catch {
            /* 管道已断 */
          }
        });
      return;
    }
    if (msg.id && st.inflight.has(msg.id)) {
      const one = st.inflight.get(msg.id);
      st.inflight.delete(msg.id);
      clearTimeout(one.timer);
      one.resolve(msg);
    }
  });

  proc.on('exit', (code, signal) => {
    clearTimeout(readyTimer);
    /* 把没答完的调用全部如实拒掉（不给假的成功） */
    for (const [, one] of st.inflight) {
      clearTimeout(one.timer);
      one.resolve({ ok: false, error: { code: 'PLUGIN_EXITED', message: `插件进程退出（code=${code} sig=${signal}）` } });
    }
    st.inflight.clear();
    st.proc = null;
    st.pid = null;
    st.status = 'stopped';
    if (!st.stopping) {
      /* 崩了就是崩了：**不自动重启** */
      st.lastError = `进程退出（code=${code} sig=${signal}）`;
      log(`✘ 插件进程退出 ${logTag(pkgId)}：${st.lastError}`);
    }
  });

  log(`↻ 插件启动中 ${logTag(pkgId)}（v${entry.version}，pid ${proc.pid}）`);
  return { ok: true, state: stateOf(entry.types[0], pkgId) };
}

/**
 * 停一个插件（主动停）。**返回 Promise，等进程真的退出**才 resolve（理由同旧版：
 * restart 不等干净就 start 会撞上"旧进程还在"）。
 */
function stop(type, id, { timeoutMs = 5000 } = {}) {
  const entry = store.get(type, id);
  const pkgId = entry ? entry.id : id;
  const st = running.get(pkgId);
  if (!st || !st.proc) {
    if (st) {
      st.status = 'stopped';
      st.stopping = true;
    }
    return Promise.resolve({ ok: true, already: true });
  }
  st.stopping = true;
  const proc = st.proc;
  log(`· 插件停止中 ${logTag(pkgId)}`);
  return new Promise((resolve) => {
    let done = false;
    const finish = (killed) => {
      if (done) return;
      done = true;
      clearTimeout(killTimer);
      clearTimeout(giveUpTimer);
      resolve({ ok: true, killed });
    };
    proc.once('exit', () => finish(false));
    try {
      proc.kill('SIGTERM');
    } catch {
      finish(false); // 已经没了就算了
    }
    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* 同上 */
      }
    }, timeoutMs);
    const giveUpTimer = setTimeout(() => finish(true), timeoutMs + KILL_GRACE_MS);
    killTimer.unref?.();
    giveUpTimer.unref?.();
  });
}

/** 停掉所有插件（面板退出时调；**不依赖插件配合**）。按包去重。 */
function stopAll() {
  const seen = new Set();
  const out = [];
  for (const [pkgId, st] of running) {
    if (seen.has(pkgId)) continue;
    seen.add(pkgId);
    if (st.proc) {
      const role = Array.isArray(st.types) ? st.types[0] : '';
      out.push({ type: role, id: pkgId });
      stop(role, pkgId, { timeoutMs: 3000 });
    }
  }
  return out;
}

/** 重启：**等旧进程真的退出**再起新的 */
async function restart(type, id) {
  await stop(type, id);
  await new Promise((r) => setTimeout(r, 200)); // 让端口/管道彻底松开一点再起
  return start(type, id);
}

/** 开机把所有**启用中**的插件拉起来（一个包只起一次） */
function bootAll() {
  const out = [];
  for (const entry of store.list()) {
    if (!entry.enabled) continue;
    const role = entry.types[0];
    out.push({ type: role, id: entry.id, ...start(role, entry.id) });
  }
  return out;
}

/**
 * 向插件发起一次动作调用。`type` 是**角色**：随消息带给插件（`role` 字段），
 * 多类型包据此在分组 actions 里找处理器；单类型包的扁平 actions 也照常收。
 * 返回 `{ ok, value }` 或 `{ ok:false, error:{code,message} }`；**从不抛**。
 */
function call(type, id, action, args, { timeoutMs = DEFAULT_CALL_TIMEOUT_MS } = {}) {
  const entry = store.get(type, id);
  const pkgId = entry ? entry.id : id;
  const st = running.get(pkgId);
  if (!st || !st.proc) {
    return Promise.resolve({ ok: false, error: { code: 'NOT_RUNNING', message: `插件没在运行：${type}/${id}` } });
  }
  if (st.status !== 'running') {
    return Promise.resolve({ ok: false, error: { code: 'NOT_READY', message: `插件还没就绪：${type}/${id}（当前 ${st.status}）` } });
  }
  const myId = ++st.seq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      st.inflight.delete(myId);
      resolve({ ok: false, error: { code: 'TIMEOUT', message: `插件动作超时（${timeoutMs}ms）：${type}/${action}` } });
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_CALL_TIMEOUT_MS));
    timer.unref?.();
    st.inflight.set(myId, { resolve, timer, action });
    try {
      st.proc.send({ id: myId, role: type, action, args: args || {} });
    } catch (e) {
      clearTimeout(timer);
      st.inflight.delete(myId);
      resolve({ ok: false, error: { code: 'IPC_DOWN', message: '与插件的管道断了：' + ((e && e.message) || e) } });
    }
  });
}

/**
 * 一个"角色行"的对外状态。同一个包的不同角色行共享进程字段（pid / status / actions…），
 * 只在 `type` 上不同 —— 现有消费层（source-bridge / meta / home）`filter(x=>x.type===…)`
 * 不用改（见 docs/adr/0046）。
 */
function stateOf(type, id) {
  const entry = store.get(type, id);
  const pkgId = entry ? entry.id : id;
  const st = running.get(pkgId);
  return {
    type,
    types: entry ? entry.types.slice() : [],
    id: pkgId,
    name: (entry && entry.name) || pkgId,
    version: (entry && entry.version) || '',
    domain: (entry && entry.domain) || '',
    binds: entry && Array.isArray(entry.binds) ? entry.binds.slice() : [],
    enabled: !!(entry && entry.enabled),
    origin: (entry && entry.origin) || '',
    status: st ? st.status : 'stopped',
    pid: (st && st.pid) || null,
    actions: (st && st.actions) || [],
    uptimeMs: st && st.startedAt && st.status === 'running' ? Date.now() - st.startedAt : 0,
    lastError: (st && st.lastError) || '',
    /* broken 状态（readManifest 失败那种）只挂了部分字段，可能没有 inflight：
     * 一个坏插件不该让 host.states() 整个崩掉（隔离的意义）。 */
    inflight: st && st.inflight ? st.inflight.size : 0,
  };
}

/** 全部插件的状态：每个包按它的 types 展开成多行（消费层零改） */
function states() {
  const out = [];
  for (const x of store.list()) {
    for (const t of x.types || []) out.push(stateOf(t, x.id));
  }
  return out;
}

module.exports = {
  DEFAULT_CALL_TIMEOUT_MS,
  start,
  stop,
  stopAll,
  restart,
  bootAll,
  call,
  stateOf,
  states,
};
