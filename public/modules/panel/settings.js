'use strict';
/**
 * 面板模块 · 「设置」页：面板自己那些**要动手改的参数**。
 *
 *   · 站点测速       **开关与间隔**（`panel.json` 的 `speedTest*`，实现见 agg/site-test.js）——
 *                    测速是"这台机器与这条网络"的体检，与内容偏好无关，所以不跟模板走（见 ADR-0033）；
 *                    测速的结果（站点统计）也是面板级共享的一份。「立即测速」在「聚合 · 模板」页。
 *   · 缓存设置       面板自己那两份缓存的用量与清空（`data/emby/cache.db` 图片索引 +
 *                    `data/cache/lines.db` 线路结果 + 按插件的聚合耗时），端点 `GET|DELETE /api/panel/cache`，
 *                    策略存 `panel.json` 的 `cache.*`（见 core/cachedb.js）。⚠️ 插件自己的缓存在各自插件设置页。
 *   · 播放中继设置   字节中继怎么搬（`panel.json` 的 `streamRelay.*`，实现见 agg/stream.js 的 relayBytes）——
 *                    上游按 Range 形态限速，所以默认切成有界小块、多路并发（见 ADR-0045）。
 *
 * 其余按性质分在别页（同模块的侧栏子项）：
 *   · 「备份与还原」 导出 / 还原整份数据（见本文件 renderPanelBackup）
 *   · 「安全」       改面板密码（见 renderPanelSecurity）
 *   · 「概览」       面板重启 + 退出登录（整机动作，见 overview.js）
 *   · 「关于」       版本与更新 + 关于（"看看而已"，见 renderPanelAbout）
 *
 * ⚠️ **元数据设置不在这里**了：token / 基地址 / 语言 / 它自己的缓存都归**元数据插件**
 * （插件 → 该插件 → 设置）。面板只从插件的「注册」动作里拿图片基地址。
 */
import { el, toast, fmtTime, codeBlock, modal, confirmModal } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { BRAND } from '../../core/branding.js';
import { changePassword } from '../../core/auth.js';

/* -------------------------------------------------------------- 版本与更新 */

/** 重启后的轮询节奏：间隔与总时限。重启时段内请求会被拒绝，属预期，不按错误处理。 */
const UPDATE_POLL_MS = 2000;
const UPDATE_POLL_LIMIT_MS = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一个字段：标签在上、控件在下 —— 收成一个不再拆分的整体（见 style.css 的 `.fld`）。
 *  **单位写进标签**（`测速间隔（小时）`）：框后跟一个孤零零的 `.unit` 在窄屏换行时会脱离自己的框。 */
const fld = (label, input) =>
  el('div', { class: 'fld' }, el('span', { class: 'lbl', text: label }), el('div', { class: 'ctl' }, input));

/**
 * 等面板重启完成：轮询 `/api/meta`，直到版本号与重启前不同。
 *
 * 返回新版本号；超过时限仍未取到则返回 null。请求失败一律继续等 —— 应用进程重启的那几秒
 * 连接会被拒绝，只有"能取到响应且版本已变"才算真的起来了。`/api/meta` 的 `version` 取自
 * 运行中的 `package.json`，因此它同时是"新版本是否真的在跑"的判据，而不是只看进程存活。
 */
async function waitRestart(prevVersion) {
  const deadline = Date.now() + UPDATE_POLL_LIMIT_MS;
  while (Date.now() < deadline) {
    await sleep(UPDATE_POLL_MS);
    let meta = null;
    try {
      meta = await api('/api/meta');
    } catch {
      continue; // 面板还没起来
    }
    const v = meta && meta.version;
    if (v && v !== prevVersion) return v;
  }
  return null;
}

/**
 * 版本与更新卡。面板自身按 Release 安装新版本、重启应用进程生效（见 docs/adr/0019）。
 *
 * 数据来自 `GET /api/panel/update`，安装走 `POST /api/panel/update`。非受管运行方式
 * （直接跑源码、或进程不是由容器的监督者拉起）如实拒绝自更新：那种情况下没有可写回的
 * 安装目录，也没有重启后拉起新版本的监督者。
 *
 * 打开页面即查一次（摘要要如实显示"最新版本"只能来自这次请求），之后由「检查更新」手动触发。
 *
 * 卡上只有两颗按钮：「检查更新」只刷新摘要；「更新到 x」**先弹更新弹窗**（说明 + 真正执行更新的
 * 按钮，见 showNotes），点框里那颗才开始安装。原本另有一颗「查看更新内容」与"查到新版本就自动弹窗"
 * 两条入口，与更新弹窗重复，已去掉 —— 看说明这件事只在"决定要更新"的那一下发生。
 */
function updateCard() {
  /* 三行摘要先占「未知」：请求整体失败时仍有可读的摘要，不留空白 */
  const cur = el('span', { class: 'v', text: '未知' });
  const latest = el('span', { class: 'v', text: '未知' });
  const mode = el('span', { class: 'v', text: '未知' });
  const check = el('button', { class: 'btn', text: '检查更新' });
  const install = el('button', { class: 'btn primary hidden' });
  const result = el('div', { class: 'hint' });
  const versions = el('div', { class: 'note' });
  let last = null; // 最近一次 GET /api/panel/update 的结果

  const showResult = (cls, lines) => {
    result.className = cls;
    result.replaceChildren(...lines.map((t) => el('div', { text: t })));
  };

  /**
   * 安装某个版本：下载并安装 → 等面板重启到新版本 → 刷新页面。
   * 进度显示在卡片里（弹窗在点下「更新」后即关闭，避免把几十行说明一直挡在屏幕上）。
   * 由更新弹窗里的那颗「更新到 x」按钮触发（见 showNotes）；这里只管把动作做完。
   */
  const doInstall = async (target) => {
    const prev = (last && last.current) || '';
    check.disabled = true;
    install.disabled = true;
    showResult('hint', [`正在安装 ${target}…`]);
    try {
      const r0 = await api('/api/panel/update', { method: 'POST', body: { version: target } });
      const ver = r0.installed || target;
      toast(`已安装 ${ver}，面板正在重启`);
      showResult('hint', [`已安装 ${ver}，面板正在重启，页面会在几秒后自动恢复。`]);
      const now = await waitRestart(prev);
      if (now) {
        toast(`已更新到 ${now}`);
        showResult('hint', [`已更新到 ${now}，正在刷新页面…`]);
        setTimeout(() => location.reload(), 1500); // 留出看提示的时间，再取新版本的前端资源
        return;
      }
      const timeoutMsg = `面板未在 ${UPDATE_POLL_LIMIT_MS / 1000} 秒内恢复，请查看容器日志。`;
      showResult('hint warn', [timeoutMsg]);
      toast(timeoutMsg, true);
    } catch (e) {
      showResult('hint warn', ['更新失败：' + e.message]);
      toast('更新失败：' + e.message, true);
    }
    check.disabled = false;
    install.disabled = false;
  };

  /**
   * 更新弹窗 —— **点「更新到 x」才会弹**，里面摆两样东西：
   *   ① 该版本的更新说明（Release 说明 = CHANGELOG 里那一节，动辄几十行，所以弹窗展示而不是摊在卡片里）；
   *   ② 真正执行更新的那颗「更新到 x」按钮，**先倒计时 3 秒**才允许点：更新不可逆，
   *      这段等待留给"看更新内容"，不给"没看就点确定"的机会。
   * 框里同时给 GitHub 上那个 Release 的链接；该版本没写说明时**如实说一句**，不留白。
   */
  const showNotes = (r) => {
    if (!r) return;
    const title = `更新内容 · ${r.latest || ''}${r.publishedAt ? ` · 发布 ${fmtTime(r.publishedAt)}` : ''}`;
    const body = [];
    if (r.notes) body.push(codeBlock({ label: 'Release 说明', code: r.notes }));
    else body.push(el('div', { class: 'note', text: `这个版本（${r.latest}）的 Release 没有写更新说明。` }));
    if (r.notesUrl) {
      body.push(
        el(
          'div',
          { class: 'note' },
          '来源：',
          el('a', { href: r.notesUrl, target: '_blank', rel: 'noreferrer', text: 'GitHub 上的这个 Release' }),
          '（说明摘在该 Release 页与 CHANGELOG 里）'
        )
      );
    }

    const target = r.latest || '';
    let timer = null;
    const m = modal({
      title,
      body,
      actions: [
        { label: '取消' },
        /* onclick 不 await：弹窗立刻关掉，安装进度改在卡片里显示（见 doInstall） */
        { label: `更新到 ${target}`, primary: true, onclick: () => { doInstall(target); } },
      ],
      onClose: () => clearInterval(timer),
    });
    const go = m.root.querySelector('.mbox-actions .btn.primary');
    if (!go) return;
    let left = 3;
    go.disabled = true; // 倒计时期间不可点
    go.textContent = `更新（${left}）`;
    timer = setInterval(() => {
      left -= 1;
      if (left > 0) {
        go.textContent = `更新（${left}）`;
        return;
      }
      clearInterval(timer);
      timer = null;
      go.disabled = false; // 倒计时结束，才允许点
      go.textContent = `更新到 ${target}`;
    }, 1000);
  };

  const paint = (r) => {
    last = r;
    cur.textContent = r.current || '未知';
    latest.textContent = r.latest || '未知';
    mode.textContent = r.managed ? '受管（由容器引导）' : '非受管';
    const inst = Array.isArray(r.installed) ? r.installed : [];
    /* 更新即完整替换（见 docs/adr/0021）：旧版本在新版本启动后被清掉，
     * 所以这里只列磁盘上现有的版本，不再提"上一版" —— 它没有回退的意义。 */
    versions.textContent =
      (inst.length ? `已安装：${inst.join(' / ')}` : '已安装：未知') +
      (inst.length > 1 ? '（旧版本会在启动后被清理）' : '');

    const hasNew = !!(r.hasUpdate && r.latest);
    install.classList.toggle('hidden', !hasNew);
    install.disabled = !r.managed; // 非受管时不给按，避免按下去才报错
    if (hasNew) install.textContent = `更新到 ${r.latest}`;

    const lines = [];
    let cls = 'hint';
    if (!r.managed) {
      cls = 'hint warn';
      lines.push('当前不是由容器引导的运行方式，面板不能自更新。');
    } else if (hasNew) {
      lines.push(`有新版本 ${r.latest}（当前 ${r.current}）。`);
    } else if (!r.error) {
      lines.push(`已是最新（${r.current || '未知'}）。`);
    }
    if (r.error) {
      /* 排障信息原样带出，不吞 */
      cls = 'hint warn';
      lines.push('检查更新失败：' + r.error);
    }
    showResult(cls, lines);
  };

  /**
   * 检查更新：**只刷新摘要**（当前 / 最新 / 运行方式），由人看到有新版本后自己去点「更新到 x」。
   * 不在这一步弹窗 —— 弹窗是"决定要更新"之后才看的东西（更新说明 + 确认按钮，见 showNotes）。
   */
  const load = async (loud) => {
    check.disabled = true;
    check.innerHTML = '<span class="spinner"></span> 检查中…';
    try {
      const r = await api('/api/panel/update');
      paint(r);
    } catch (e) {
      showResult('hint warn', ['检查更新失败：' + e.message]);
      if (loud) toast('检查更新失败：' + e.message, true);
    } finally {
      check.disabled = false;
      check.textContent = '检查更新';
    }
  };

  check.addEventListener('click', () => load(true));

  /* 点「更新到 x」弹更新弹窗：先看说明，框里那颗「更新到 x」才是真正执行更新的按钮（见 showNotes） */
  install.addEventListener('click', () => {
    if (!(last && last.latest)) return;
    showNotes(last);
  });

  const card = el(
    'div',
    { class: 'card' },
    el('h3', { text: '版本与更新' }),
    el('p', {
      class: 'note',
      text: '从 Release 安装新版本，装完应用进程重启（容器不停）。更新只手动触发，且是完整替换 —— 新版本起来后旧版本目录会被清掉。',
    }),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '当前版本' }), cur),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '最新版本' }), latest),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '运行方式' }), mode),
    el('div', { class: 'row' }, check, install),
    result,
    versions
  );
  load(false);
  return card;
}

/* ------------------------------------------------------------------------ 关于 */

/**
 * 「关于」卡：面板叫什么、什么版本、代码在哪儿。
 * 仓库地址**来自后端**（`/api/panel/info` 的 `repo`/`repoUrl`，唯一来源是 update.js 的 REPO，
 * `APP_REPO` 可覆盖）—— 前端不写死，换仓库/自建时不用改前端。
 */
function aboutCard() {
  const name = el('span', { class: 'v', text: BRAND.panelName });
  const ver = el('span', { class: 'v', text: '…' });
  const repo = el('span', { class: 'v', text: '…' });
  const card = el(
    'div',
    { class: 'card' },
    el('h3', { text: '关于' }),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '名称' }), name),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '版本' }), ver),
    el('div', { class: 'kv' }, el('span', { class: 'k', text: '代码仓库' }), repo)
  );

  api('/api/panel/info')
    .then((info) => {
      name.textContent = BRAND.panelName;
      ver.textContent = info.version || '-';
      repo.replaceChildren(
        info.repoUrl
          ? el('a', { href: info.repoUrl, target: '_blank', rel: 'noreferrer', text: info.repo || info.repoUrl })
          : el('span', { text: '（未设置）' })
      );
    })
    .catch((e) => {
      ver.textContent = '-';
      repo.textContent = '取仓库地址失败：' + e.message;
    });

  return card;
}

/**
 * 「公告」卡：把仓库里的 `notice.html` 内嵌在「关于」页 —— 交流群地址、贡献者名单这类内容
 * 与面板代码分开维护，改仓库里那个文件即生效（取回见 server/modules/panel/notice.js）。
 * **没内容时整张卡不出现**（`display:none` 一直挂着，拿到内容才显示）。
 *
 * 用 `iframe` + `srcdoc` 渲染，而不是 `innerHTML`：远程内容是别人维护的，这样能**隔离它的样式**
 * （内容里的 `<style>` 不会漏到面板），且 `sandbox` 不给 `allow-scripts`，脚本与内联事件属性都不执行。
 * 留 `allow-same-origin` 是为了量内容高度、把 frame 撑到刚好；`allow-popups*` 让内容里的链接能开新标签。
 */
function noticeCard() {
  const frame = el('iframe', {
    sandbox: 'allow-same-origin allow-popups allow-popups-to-escape-sandbox',
    style: 'display:block;width:100%;height:0;border:0;overflow:hidden',
  });
  const card = el('div', { class: 'card', style: 'display:none' }, el('h3', { text: '公告' }), frame);

  /* 自动撑高：srcdoc 文档与面板同源，加载后量一次内容高度。内容里有图片这类异步资源时首次量得偏小，
   * 所以再补量一次。完全量不到（例如浏览器不给同源）时退回一个够用的固定高度，别把内容压成一条线。 */
  const fit = () => {
    let h = 0;
    try {
      const doc = frame.contentDocument;
      if (doc) h = Math.max((doc.body && doc.body.scrollHeight) || 0, doc.documentElement.scrollHeight || 0);
    } catch {
      h = 0;
    }
    frame.style.height = (h > 0 ? h : 160) + 'px';
  };
  frame.addEventListener('load', () => {
    fit();
    setTimeout(fit, 300);
  });

  api('/api/panel/notice')
    .then((d) => {
      const html = String((d && d.html) || '').trim();
      if (!html) return; // 没内容：卡保持隐藏
      frame.srcdoc = html;
      card.style.display = '';
      setTimeout(fit, 300); // srcdoc 一设好就有 contentDocument，先量一次，load 后再量
    })
    .catch(() => {
      /* 取不到公告不算错误：静默保持隐藏，不弹提示 */
    });

  return card;
}

/* -------------------------------------------------------------- 备份与还原 */

function backupCard() {
  const out = el('div', { class: 'note' });
  const exportBtn = el('button', { class: 'btn primary', text: '导出备份' });
  const pickBtn = el('button', { class: 'btn', text: '选择文件还原' });
  const picked = el('span', { class: 'note' });
  /* 隐藏的 file input：点「选择文件还原」时打开系统选文件框 */
  const fileInput = el('input', { type: 'file', accept: '.zip,application/zip', class: 'hidden' });

  /* 下载文件名 = **品牌短标识 + 时间戳**（与项目名一致；前缀只从 BRAND 取，别写死 ——
     后端 `Content-Disposition` 里用的是同一份 branding 的 slug） */
  function fileName(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${BRAND.slug}-backup-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.zip`;
  }

  /* 导出的是 zip 字节，不走 api()（那条封装一律按 JSON 解析）—— 直接 fetch 取 blob 下载。
     摘要（多少文件 / 多大）由后端放在响应头里：压缩包本身不便在前端解开一遍来数。 */
  exportBtn.addEventListener('click', async () => {
    exportBtn.disabled = true;
    try {
      const res = await fetch('/api/panel/backup');
      if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try {
          const j = await res.json();
          if (j && j.error) msg = j.error;
        } catch {
          /* 响应体不是 JSON 时保留 HTTP 码作为提示 */
        }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const name = fileName(new Date());
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: name });
      document.body.append(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const files = Number(res.headers.get('X-Backup-Files')) || 0;
      const at = res.headers.get('X-Backup-Exported-At');
      /* 显示的大小用 **blob 的实际字节数** —— 就是落到磁盘上那个文件的大小，不会与它不一致
         （后端 `X-Backup-Size` 是同一个数；曾用"内容未压缩字节和"显示，比真实包大三倍多）。 */
      out.className = 'note';
      out.textContent = `已导出 ${name}（${files} 个文件 / ${fmtBytes(blob.size)}，不含缓存）${at ? ' · ' + fmtTime(at) : ''}`;
      toast('已导出 ' + name);
    } catch (e) {
      out.className = 'note err-note';
      out.textContent = '导出失败：' + e.message;
    } finally {
      exportBtn.disabled = false;
    }
  });

  pickBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = ''; // 允许重复选同一个文件
    if (!file) return;
    picked.textContent = '已选择：' + file.name;

    /* 覆盖现有数据、不可撤销 —— 先把后果说清楚再确认（用页内确认框，不用原生 confirm） */
    const yes = await confirmModal({
      title: '用备份覆盖当前数据？',
      text:
        `会用「${file.name}」整项覆盖当前数据（设置、模板、插件与插件数据、Emby 账号与播放进度），` +
        `缓存与应用代码不受影响。覆盖不可撤销，建议先「导出备份」存一份；之后需重启面板生效。`,
      okLabel: '覆盖还原',
    });
    if (!yes) return;

    pickBtn.disabled = true;
    out.className = 'note';
    out.textContent = '正在上传并还原…';
    try {
      /* 直接把 File 当请求体（原始二进制），不做 base64 —— 全量备份可能有几十 MB */
      const res = await fetch('/api/panel/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/zip' },
        body: file,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) throw new Error((data && data.error) || 'HTTP ' + res.status);
      const restored = (data && data.restored) || [];
      toast('已还原：' + (restored.join(' / ') || '备份里没有数据'));
      out.className = 'note';
      out.textContent = `已还原 ${restored.length} 项（${restored.join(' / ') || '为空'}）：${(data && data.note) || '到「概览」页点「面板重启」使其生效。'}`;
    } catch (e) {
      out.className = 'note err-note';
      out.textContent = '还原失败：' + e.message;
    } finally {
      pickBtn.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '数据备份与还原' }),
    el('p', {
      class: 'note',
      text: '备份打成一个 zip，含数据卷里的全部数据：设置、模板、插件与插件数据、Emby 账号与播放进度，不含缓存。',
    }),
    el('div', { class: 'note err-note', text: '备份含账号与密码，请妥善保管。' }),
    el('div', { class: 'toolbar' }, exportBtn, pickBtn, picked, fileInput),
    out
  );
}

/* ------------------------------------------------------------------ 缓存设置 */

/** 字节数 → 人话（用量显示用） */
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

/**
 * 缓存设置（从「Emby → 连接设置」搬来）。
 *
 * 为什么归面板：剩下的这两份缓存都归面板用 —— `data/emby/cache.db`（图片索引，面板替客户端取图）
 * 与 `data/cache/lines.db`（线路结果 + 按插件的聚合耗时）。用量显示、清空、上限一把抓才可能不出错，
 * 所以设置、按钮、端点在面板层（`GET|DELETE /api/panel/cache`）。
 * ⚠️ **插件自己的缓存在插件那边**：元数据、源插件的取数缓存与首页插件的行结果都落在插件自己的
 * 数据目录里，所以「清空面板缓存」**不碰**它们 —— 要连它们一起清用「清除全部缓存（含插件）」
 * （`DELETE /api/panel/cache/all` → `plugin/store.js` 的 `clearCaches`）。
 */
function cacheCard() {
  const c = (S.panel.settings || {}).cache || {};
  /* 这几个是**默认值**，改了就落盘；留空/非数字由后端兜底回默认。
   * 不给定宽档：`.fset` 那一格有多宽就铺多宽（与全站"框不设长度"一致）。 */
  const cnum = (key, dflt) => el('input', { type: 'text', value: String(c[key] === undefined || c[key] === null ? dflt : c[key]) });
  const cImgDays = cnum('imageTtlDays', 90);
  const cImgMB = cnum('imageMaxMB', 5);
  const cLineDays = cnum('linesTtlDays', 1);
  const cLineMB = cnum('linesMaxMB', 32);
  const cLineForever = el('input', { type: 'checkbox' });
  cLineForever.checked = !!c.linesNeverExpire;
  /* 勾了长期有效，天数那一格就没意义了 —— 只把输入框**灰掉**，标签与勾选都留在原位
   * （与「聚合 · 模板」页的「匹配到底」一个口径：勾选框旁边得看得出它在覆盖哪一项）。 */
  const syncForever = () => {
    cLineDays.disabled = cLineForever.checked;
  };
  cLineForever.addEventListener('change', syncForever);
  syncForever();
  const out = el('div', { class: 'hint', text: '正在读取用量…' });
  const aggLine = el('div', { class: 'note' });
  const save = el('button', { class: 'btn primary', text: '保存' });
  const clear = el('button', { class: 'btn', text: '清空面板缓存' });
  const clearAll = el('button', { class: 'btn', text: '清除全部缓存（含插件）' });

  /** 线路结果的有效期显示：勾了长期有效就说长期有效，填 0 就说不缓存 */
  const fmtLineTtl = (r) => {
    const d = r.lines || {};
    if (d.ttlForever) return '长期有效';
    const days = Number(d.ttlMs || 0) / 86400000;
    return days > 0 ? `${days} 天` : '不缓存';
  };

  /**
   * 按插件记的**最近一次聚合耗时**（ADR-0032 第 4 条，数据来自 `r.agg`）——
   * 一次聚合同时打几个插件，总耗时说不出是谁慢，所以按插件各记一笔。
   * 没记过就留空（如实，不编）。
   */
  const paintAgg = (r) => {
    const agg = r.agg || {};
    const ids = Object.keys(agg);
    aggLine.textContent = '';
    if (!ids.length) return;
    aggLine.append(
      '各插件最近一次聚合耗时：' +
        ids
          .map((id) => {
            const a = agg[id] || {};
            return `${id} 最慢一发 ${Math.round(Number(a.ms) || 0)}ms（${Number(a.sites) || 0} 站）`;
          })
          .join(' · ')
    );
  };

  const paint = (r) => {
    const d = r.lines || { rows: 0, bytes: 0, maxBytes: 0 };
    out.textContent = '';
    out.append(
      `图片索引 ${r.image.rows} 条 / ${fmtBytes(r.image.bytes)}（上限 ${fmtBytes(r.image.maxBytes)}）` +
        ` · 线路结果 ${d.rows} 条 / ${fmtBytes(d.bytes)}（上限 ${fmtBytes(d.maxBytes)}，当期有效期 ${fmtLineTtl(r)}）`
    );
    paintAgg(r);
  };
  const load = async () => {
    try {
      paint(await api('/api/panel/cache'));
    } catch (e) {
      out.textContent = '读取用量失败：' + e.message;
    }
  };
  load();

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const r = await api('/api/modules/panel/settings', {
        method: 'PUT',
        body: {
          settings: {
            cache: {
              imageTtlDays: Number(cImgDays.value),
              imageMaxMB: Number(cImgMB.value),
              /* 留空**不要**当成 0 —— 这个字段的 0 是"不缓存"，留空的意思是"用默认值"，
               * 所以留空发 undefined（JSON 会把它丢掉，后端按默认值算）。 */
              linesTtlDays: cLineDays.value.trim() === '' ? undefined : Number(cLineDays.value),
              /* 同上：留空 = 用默认值（32MB），填 0 才是"不限" */
              linesMaxMB: cLineMB.value.trim() === '' ? undefined : Number(cLineMB.value),
              linesNeverExpire: cLineForever.checked,
            },
          },
        },
      });
      S.panel.settings = r.settings;
      toast('缓存设置已保存');
      await load(); // 上限调小后这里能立刻看到淘汰结果（后端在设置变更时会扫一遍）
    } catch (e) {
      toast('保存失败：' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });

  clear.addEventListener('click', async () => {
    if (
      !confirm(
        '清空面板缓存？\n\n图片索引与线路结果都会重来（下一次点开会重新搜源）。\n插件自己的缓存在插件那边，这一下不动它们。'
      )
    ) {
      return;
    }
    clear.disabled = true;
    try {
      paint(await api('/api/panel/cache', { method: 'DELETE' }));
      toast('面板缓存已清空');
    } catch (e) {
      toast('清空失败：' + e.message, true);
    } finally {
      clear.disabled = false;
    }
  });

  /* 清到底那一下：面板那两份 + 各插件的落盘缓存（插件设置与登录态不在缓存里，不动）。 */
  clearAll.addEventListener('click', async () => {
    if (
      !confirm(
        '清除全部缓存？\n\n' +
          '· 面板：图片索引与线路结果（下一次点开会重新搜源）\n' +
          '· 插件：各插件的落盘缓存\n\n' +
          '插件的设置与登录态不在缓存里，不受影响。插件进程里那份内存缓存要等它自己过期，或重启面板。'
      )
    ) {
      return;
    }
    clearAll.disabled = true;
    try {
      const r = await api('/api/panel/cache/all', { method: 'DELETE' });
      paint(r);
      const n = (((r || {}).plugins || {}).plugins || []).length;
      toast(n ? `全部缓存已清除（含 ${n} 个插件的落盘缓存）` : '全部缓存已清除（插件这边没有可清的）');
    } catch (e) {
      toast('清除失败：' + e.message, true);
    } finally {
      clearAll.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '缓存设置' }),
    el('p', { class: 'note', text: '天数填 0 = 不缓存，上限填 0 = 不限。' }),
    el(
      'div',
      { class: 'fset' },
      fld('图片索引保留（天）', cImgDays),
      fld('图片索引上限（MB）', cImgMB),
      /* 勾选与它管的那个输入框**同一个字段**里：勾上就把天数灰掉（见 syncForever） */
      el(
        'div',
        { class: 'fld' },
        el('span', { class: 'lbl', text: '线路结果保留（天）' }),
        el(
          'div',
          { class: 'ctl' },
          cLineDays,
          el('label', { class: 'chk', title: '勾上就不按天数过期' }, cLineForever, '长期有效')
        )
      ),
      fld('线路结果上限（MB）', cLineMB)
    ),
    el('div', { class: 'row btn-row' }, save, clear, clearAll),
    out,
    aggLine,
    el('p', { class: 'note', text: '「清空面板缓存」只清面板这两份；「清除全部缓存」连插件自己的落盘缓存一起清。' })
  );
}

/** 设置要异步读一次；卡片都直接挂在 `.view` 下 —— 卡片间距才是同一条 */
export async function renderPanelSettings(v) {
  try {
    if (!S.panel.settings) S.panel.settings = (await api('/api/modules/panel/settings')).settings;
  } catch (e) {
    v.append(el('div', { class: 'card' }, el('h3', { text: '设置' }), el('div', { class: 'hint warn', text: '读取面板设置失败：' + e.message })));
    return;
  }
  /* ⚠️ 几张卡**不许再套一层 holder**：`.card + .card` 那条间距只认相邻的卡片，
   * 中间夹一层 div 的话，卡片间距就与别处不一样（用户实测"三个卡片距离不一样"）。 */
  v.append(speedTestCard(), cacheCard(), relayCard());
}

/* ------------------------------------------------------------------ 播放中继设置 */

/**
 * 播放中继设置（`streamRelay`，见 ADR-0045）。
 *
 * 只管"字节怎么搬"，不管选源与落法（那是聚合层的事）。默认值在后端
 * （`panel.json` 的 `streamRelay`），这里留空 = 用默认值。
 */
function relayCard() {
  const s = (S.panel.settings || {}).streamRelay || {};
  const dflt = (v, d) => String(v === undefined || v === null ? d : v);
  const cOn = el('input', { type: 'checkbox' });
  cOn.checked = s.enabled !== false;
  const cThreads = el('input', { type: 'text', value: dflt(s.threads, 16) });
  const cChunk = el('input', { type: 'text', value: dflt(s.chunkKB, 512) });
  const cFwdOn = el('input', { type: 'checkbox' });
  cFwdOn.checked = !!s.forwardEnabled;
  const cForward = el('input', { type: 'text', placeholder: 'https://xxx.workers.dev' });
  cForward.value = s.forwardUrl || '';
  const cFwdSecret = el('input', { type: 'text', placeholder: '与代理侧 SECRET 一致（可选）' });
  cFwdSecret.value = s.forwardSecret || '';
  const save = el('button', { class: 'btn primary', text: '保存' });

  /* 留空发 undefined（JSON 会丢掉），后端按默认值算；填了非数字也发 undefined，不让 NaN 落盘 */
  const num = (input) => {
    const t = input.value.trim();
    if (t === '') return undefined;
    const n = Number(t);
    return Number.isFinite(n) ? n : undefined;
  };

  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const r = await api('/api/modules/panel/settings', {
        method: 'PUT',
        body: {
          settings: {
            streamRelay: {
              enabled: cOn.checked,
              threads: num(cThreads),
              chunkKB: num(cChunk),
              forwardEnabled: cFwdOn.checked,
              forwardUrl: cForward.value.trim(),
              forwardSecret: cFwdSecret.value.trim(),
            },
          },
        },
      });
      S.panel.settings = r.settings;
      toast('中继设置已保存');
    } catch (e) {
      toast('保存失败：' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '播放中继设置' }),
    el('p', { class: 'note', text: '带鉴权头的线路，媒体字节由面板代取再转给播放器。留空 = 用默认值。' }),
    el(
      'div',
      { class: 'row' },
      el('label', { class: 'chk', title: '关掉就用单连接直搬（上游限速时更慢）' }, cOn, '分块并发')
    ),
    el('div', { class: 'fset' }, fld('并发路数', cThreads), fld('每块大小（KB）', cChunk)),
    el(
      'div',
      { class: 'row' },
      el('label', { class: 'chk', title: '关掉：即使填了 URL 也不外转，面板自己中继（URL 留着不丢）' }, cFwdOn, '外转到外部字节代理')
    ),
    el(
      'div',
      { class: 'fset' },
      fld('外部字节代理 URL', cForward),
      fld('外部代理签名密钥', cFwdSecret)
    ),
    el(
      'p',
      { class: 'note' },
      '打开外转：面板不搬字节，302 把上游地址、请求头与上面的并发参数全部交给代理取流。代理端是 Cloudflare Worker，代码与一键部署见 ',
      el('a', { href: 'https://github.com/dlushu/media-bridge-relay', target: '_blank', rel: 'noopener', text: 'media-bridge-relay' }),
      '。'
    ),
    el('div', { class: 'row btn-row' }, save)
  );
}

/* ------------------------------------------------------------------ 面板密码 */

function passwordCard() {
  /* 名字写在**字段标签**上（不再借 placeholder 当标签：两个字一填进去就没了） */
  const oldInput = el('input', { type: 'password', autocomplete: 'current-password' });
  const newInput = el('input', { type: 'password', autocomplete: 'new-password' });
  const againInput = el('input', { type: 'password', autocomplete: 'new-password' });
  const btn = el('button', { class: 'btn primary', text: '修改密码' });
  const warn = el('div', { class: 'note err-note hidden' });

  btn.addEventListener('click', async () => {
    warn.classList.add('hidden');
    const show = (m) => {
      warn.textContent = m;
      warn.classList.remove('hidden');
    };
    if (!oldInput.value || !newInput.value) return show('请填写当前密码与新密码');
    if (newInput.value !== againInput.value) return show('两次输入的新密码不一致');
    if (newInput.value.length < 6) return show('新密码至少 6 位');
    btn.disabled = true;
    try {
      await changePassword(oldInput.value, newInput.value);
      /* 改完旧登录就失效了 —— 明确回到登录页 */
      toast('密码已修改，请用新密码重新登录');
      setTimeout(() => location.reload(), 800);
    } catch (e) {
      show(e.message);
      btn.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '面板密码' }),
    el('p', { class: 'note', text: '登录面板的密码。改完要用新密码重新登录。' }),
    el('div', { class: 'fset' }, fld('当前密码', oldInput), fld('新密码（至少 6 位）', newInput), fld('再输一次', againInput)),
    el('div', { class: 'row btn-row' }, btn),
    warn
  );
}

/* -------------------------------------------------------------- 登录态有效期 */

/** 有效期默认值与上限（分钟），与后端 core/auth.js 的 DEFAULT_SESSION_MIN / MAX_SESSION_MIN 对齐 */
const SESSION_DEFAULT_MIN = 15;
const SESSION_MAX_MIN = 30 * 24 * 60;
/** 可选单位（分钟为基准）。显示时挑能整除当前分钟数的**最大**单位，读起来最短 */
const SESSION_UNITS = [
  { label: '分钟', factor: 1 },
  { label: '小时', factor: 60 },
  { label: '天', factor: 1440 },
];

/**
 * 「登录态有效期」卡：空闲多久需要重新登录。
 *
 * 值是**滑动过期**（空闲计时，见 core/auth.js 的 guard）—— 从"最后一次操作"起算，
 * 一直在用就自动顺延，所以这一项说的是**空闲上限**，不是"到点强制退出"。
 * 存 `panel` 设置的 `sessionMinutes`（分钟，1 ~ 43200），与「设置」页共用同一份懒加载缓存。
 */
function sessionCard() {
  const minutes = (() => {
    const v = Number((S.panel.settings || {}).sessionMinutes);
    return Number.isFinite(v) && v >= 1 && v <= SESSION_MAX_MIN ? Math.floor(v) : SESSION_DEFAULT_MIN;
  })();
  /* 挑显示单位：能整除当前分钟数的最大单位（15 → 15 分钟，1440 → 1 天） */
  const unit = SESSION_UNITS.slice().reverse().find((u) => minutes % u.factor === 0) || SESSION_UNITS[0];
  const numInput = el('input', { type: 'number', class: 'w-md', min: '1', value: String(Math.round(minutes / unit.factor)) });
  const unitSel = el('select', { class: 'w-sm' }, ...SESSION_UNITS.map((u) => el('option', { value: String(u.factor), text: u.label })));
  unitSel.value = String(unit.factor);
  const save = el('button', { class: 'btn primary', text: '保存' });

  save.addEventListener('click', async () => {
    const total = Math.round(Number(numInput.value) * Number(unitSel.value));
    if (!(Number.isFinite(total) && total >= 1 && total <= SESSION_MAX_MIN)) {
      return toast(`有效期填 1 分钟 ~ ${SESSION_MAX_MIN / 1440} 天之间`, true);
    }
    save.disabled = true;
    try {
      const r = await api('/api/modules/panel/settings', {
        method: 'PUT',
        body: { settings: { sessionMinutes: total } },
      });
      S.panel.settings = r.settings;
      toast('登录态有效期已保存');
    } catch (e) {
      toast('保存失败：' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '登录态有效期' }),
    el('p', {
      class: 'note',
      text: '从最后一次操作起算，一直在用就自动顺延 —— 空闲满这一时长才需要重新登录。默认 15 分钟，最大 30 天。',
    }),
    el(
      'div',
      { class: 'fset' },
      el(
        'div',
        { class: 'fld' },
        el('span', { class: 'lbl', text: '空闲有效期' }),
        el('div', { class: 'ctl' }, numInput, unitSel)
      )
    ),
    el('div', { class: 'row btn-row' }, save)
  );
}

/**
 * 「站点测速」卡：开关 + 间隔。
 *
 * 从「聚合参数」页挪来的：测速是"**这台机器与这条网络**"的体检，与内容偏好无关 ——
 * 所以它不跟模板走（模板装的是内容偏好），而测速的**结果**（站点统计）也是面板级共享的一份。
 * 「立即测速」按钮仍在「聚合 · 模板」页（那是"看结果 + 手点一轮"）。
 */
function speedTestCard() {
  const p = S.panel.settings || {};
  const on = el('input', { type: 'checkbox', checked: p.speedTestAuto !== false });
  const hours = el('input', {
    type: 'number',
    value: String(p.speedTestHours === undefined || p.speedTestHours === null ? 6 : p.speedTestHours),
    min: '1',
    max: '168',
  });
  const save = el('button', { class: 'btn primary', text: '保存' });
  save.addEventListener('click', async () => {
    const h = Number(hours.value);
    if (!(h >= 1 && h <= 168)) return toast('测速间隔填 1~168 小时', true);
    save.disabled = true;
    try {
      const r = await api('/api/modules/panel/settings', {
        method: 'PUT',
        body: { settings: { speedTestAuto: on.checked, speedTestHours: h } },
      });
      S.panel.settings = r.settings || Object.assign({}, p, { speedTestAuto: on.checked, speedTestHours: h });
      toast(on.checked ? `已保存（每 ${h} 小时自动测一轮）` : '已保存（自动测速已关）');
    } catch (e) {
      toast('保存失败：' + e.message, true);
    } finally {
      save.disabled = false;
    }
  });

  return el(
    'div',
    { class: 'card' },
    el('h3', { text: '站点测速' }),
    el('p', { class: 'note', text: '按间隔自动测一轮，结果在「聚合 · 模板」页那一列「延迟」看。' }),
    el('div', { class: 'row' }, el('label', { class: 'chk' }, on, '自动测速')),
    el('div', { class: 'fset' }, fld('测速间隔（小时）', hours)),
    el('div', { class: 'row btn-row' }, save)
  );
}

/**
 * 「备份与还原」页：只有那一张卡。
 *
 * 从「设置」页拆出来单开一页 —— 备份/还原是**低频但后果重**的操作（还原会整项覆盖数据卷），
 * 跟"改个数字就生效"的测速、缓存摆在一起，容易被顺手点。
 */
export function renderPanelBackup(v) {
  v.append(backupCard());
}

/**
 * 「安全」页：改面板密码 + 登录态有效期。
 *
 * 从「设置」页拆出来单开一页 —— 密码与登录态是**进这个面板的门**，与"面板怎么跑"的设置不是一类；
 * 退出登录挪去了「概览」页（那里是整机动作）。
 */
export async function renderPanelSecurity(v) {
  v.append(passwordCard());
  /* 有效期存在 panel 设置里（`sessionMinutes`），与「设置」页同一份懒加载缓存；读失败只影响这张卡 */
  try {
    if (!S.panel.settings) S.panel.settings = (await api('/api/modules/panel/settings')).settings;
    v.append(sessionCard());
  } catch (e) {
    v.append(
      el(
        'div',
        { class: 'card' },
        el('h3', { text: '登录态有效期' }),
        el('div', { class: 'hint warn', text: '读取面板设置失败：' + e.message })
      )
    );
  }
}

/**
 * 「关于」页：**版本与更新** + **关于** + **公告**三张卡。
 *
 * 从「设置」页挪过来的：「设置」页是"要动手改的东西"（缓存/测速），
 * 而这两张是"看看而已" —— 更新卡里那段说明还动辄几十行，摆在设置页会把要改的卡挤到很下面。
 * 公告卡是**远程内容**（仓库里的 `notice.html`，见 notice.js），没内容时它自己不显示。
 */
export function renderPanelAbout(v) {
  v.append(updateCard(), aboutCard(), noticeCard());
}
