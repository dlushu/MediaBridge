'use strict';
/**
 * Emby 模块 · 「实例」页 —— **多实例的增 / 删 / 改**。
 *
 * 一个实例 = 一个**自己的端口** + 一套**自己的身份与数据**（账号 / 会话 / 播放进度各一个库）
 * + **选定的一个首页插件**（那个插件的全部行 = 这个实例客户端上的媒体库）
 * + **一套限定的搜索域**（客户端搜索走哪些元数据域；缺席 = 全部）。
 * 客户端「添加服务器」时填的就是这一行上的连接地址（见后端 `routes.js` 的 `/api/emby/instances`）。
 *
 * 启用开关做成**行内的开关**（点一下就换，走 PATCH）：它只影响"听不听这个端口"，
 * 数据都还在，改错了再点回来就行。首页插件（= 这个实例的媒体库）、改名 / 改端口 / 搜索域
 * 则走弹窗 —— 那几样要不要联动、改错了客户端会不会连不上，值得开窗多看一眼。
 *
 * ⚠️ 端口不是随便填的：面板本体端口被后端 `instance.validate` 挡掉；留空则由后端从 8090 起
 * 挑一个空闲的（占用了就 +1）。被占用的端口**不会**让面板起不来 —— 只是这一行的状态变成红点 + 原因。
 */
import { el, modal, toast, confirmModal } from '../../core/dom.js';
import { api } from '../../core/api.js';
import { S } from '../../core/state.js';
import { renderPage } from '../../core/shell.js';

export async function renderEmbyInstances(v) {
  let err = '';
  try {
    await loadInstances();
  } catch (e) {
    err = e.message;
  }
  /* 首页插件清单只喂那个下拉，取不到不算错（下拉里只有"未选择"），但要说清楚为什么空 */
  let pluginErr = '';
  try {
    await loadHomePlugins();
  } catch (e) {
    pluginErr = e.message;
  }
  /* 元数据域清单只喂那个多选，取不到同样不算错（多选里只有"全部"的默认口径） */
  let domainErr = '';
  try {
    await loadMetaDomains();
  } catch (e) {
    domainErr = e.message;
  }

  if (err) {
    v.append(el('div', { class: 'hint warn', text: '读取实例失败：' + err + '（面板的 Emby 层没起来？看「面板设置 → 日志」）' }));
    return;
  }

  v.append(introCard(), listCard(pluginErr, domainErr));
}

async function loadInstances(force = false) {
  if (!force && S.emby.instances) return S.emby.instances;
  const r = await api('/api/emby/instances');
  S.emby.instances = r.instances || [];
  S.emby.maxInstances = r.max || 0;
  return S.emby.instances;
}

async function loadHomePlugins(force = false) {
  if (!force && S.emby.homePlugins) return S.emby.homePlugins;
  const r = await api('/api/emby/home-plugins');
  S.emby.homePlugins = r.plugins || [];
  return S.emby.homePlugins;
}

async function loadMetaDomains(force = false) {
  if (!force && S.emby.metaDomains) return S.emby.metaDomains;
  const r = await api('/api/emby/meta-domains');
  S.emby.metaDomains = r.domains || [];
  return S.emby.metaDomains;
}

/** 改完实例之后：清单与账号都得重拉（账号是按实例分的），再整页重画 */
async function afterChange(msg) {
  S.emby.instances = null;
  S.emby.accounts = null;
  S.emby.accountsFor = '';
  toast(msg);
  renderPage();
}

/* ------------------------------------------------------------------ 说明卡 */

function introCard() {
  return el(
    'div',
    { class: 'card' },
    el('h3', { text: 'Emby 实例' }),
    el('p', {
      class: 'note',
      text: '多个实例等于多个 Emby 服务器。',
    })
  );
}

/* ------------------------------------------------------------------ 实例列表 */

function listCard(pluginErr, domainErr) {
  const list = S.emby.instances || [];
  const max = S.emby.maxInstances || 0;
  const card = el(
    'div',
    { class: 'card' },
    el('h3', { text: `实例${max ? `（${list.length} / ${max}）` : ''}` }),
    el(
      'div',
      { class: 'actions' },
      el('button', {
        class: 'btn primary',
        text: '＋ 新增实例',
        onclick: () => openEditor(null),
      }),
      el('button', {
        class: 'btn',
        title: '重新读一份实例清单与运行状态',
        text: '刷新',
        onclick: async () => {
          try {
            await loadInstances(true);
            await loadHomePlugins(true);
            await loadMetaDomains(true);
            renderPage();
          } catch (e) {
            toast('刷新失败：' + e.message, true);
          }
        },
      })
    )
  );

  if (pluginErr) card.append(el('div', { class: 'hint warn', text: '读不到首页插件清单：' + pluginErr + '（下拉里只剩「空库」）' }));
  if (domainErr) card.append(el('div', { class: 'hint warn', text: '读不到元数据域清单：' + domainErr + '（搜索域多选里只剩已保存的那些）' }));

  if (!list.length) {
    card.append(el('div', { class: 'muted', text: '还没有实例。' }));
    return card;
  }
  for (const inst of list) card.append(instanceRow(inst));
  return card;
}

function instanceRow(inst) {
  /* 一行说清这台实例：启用开关 · 名称 · 端口 · 「默认」 · 地址与操作（靠右）。
   * 开关摆最前面 —— 它就是这个实例在不在的状态（原来那颗绿点说的是同一件事，已去掉）。
   * 首页插件是 `width:100%` 的下拉，搁进这行会把地址与按钮顶到下一行（1440px 实测折三行），
   * 所以它留在编辑弹窗里 —— 那一项本来也不常改。 */
  const head = el(
    'div',
    { class: 'file-row' },
    enableSwitch(inst),
    el('span', { class: 'name', title: inst.id, text: inst.name }),
    el('span', { class: 'badge mono', title: '这个实例自己的端口（客户端填它）', text: ':' + inst.port }),
    inst.isDefault ? el('span', { class: 'badge', title: '默认实例：老数据（原 emby.db）挂在它身上，不能删', text: '默认' }) : null,
    el('span', { class: 'spacer' }),
    el('code', { class: 'mono', text: inst.url })
  );

  /* 第二行：这一实例的规模 + 状态说明（错误 / 停用都写在这里，红字那句用 err-note） */
  const stats = `${inst.accountCount} 个账号 · ${inst.sessionCount} 个在线会话 · ${inst.viewCount} 个媒体库 · 搜索域：${domainsBrief(inst)}`;
  let tail;
  if (inst.error) {
    tail = el('div', { class: 'err-note', text: `没在监听：${inst.error}（换个端口，或停掉占用它的程序，再「编辑」保存一次）` });
  } else if (!inst.enabled) {
    tail = el('div', { class: 'note', text: `${stats} · 已停用，客户端连不上` });
  } else {
    tail = el('div', { class: 'note', text: stats });
  }

  /* 按钮组是整块的最后一件东西、靠右（与插件列表同一个口径，见 style.css 的 `.file-acts`）。
   * 「复制」去掉了：地址就在行上，长按选中即可。 */
  const acts = el(
    'div',
    { class: 'row file-acts' },
    el('button', { class: 'btn mini', text: '编辑', onclick: () => openEditor(inst) }),
    inst.isDefault
      ? null
      : el('button', {
          class: 'btn mini danger',
          text: '删除',
          onclick: () => removeInstance(inst),
        })
  );

  return el('div', { class: 'plugin-row' }, head, tail, acts);
}

/** 行上的启用开关：停用 = 不在这个端口上监听（数据都还在），点一下即 PATCH */
function enableSwitch(inst) {
  const cb = el('input', { type: 'checkbox', class: 'switch' });
  cb.checked = !!inst.enabled;
  cb.addEventListener('change', async () => {
    cb.disabled = true;
    try {
      await api('/api/emby/instances/' + encodeURIComponent(inst.id), { method: 'PATCH', body: { enabled: cb.checked } });
      await afterChange(cb.checked ? `已启用：${inst.name}` : `已停用：${inst.name}（客户端连不上，数据还在）`);
    } catch (e) {
      toast('切换失败：' + e.message, true);
      cb.disabled = false;
      cb.checked = !!inst.enabled;
    }
  });
  return el('label', { class: 'chk', title: '启用后才会在这个端口上监听；停用只是不监听，数据还在' }, cb, '启用');
}

/* ------------------------------------------------------------------ 增 / 改 / 删 */

/** 行上那句「搜索域」摘要：`null`/缺席 = 全部；空数组 = 无 */
function domainsBrief(inst) {
  const d = inst.metaDomains;
  if (!Array.isArray(d)) return '全部';
  if (!d.length) return '无（客户端搜不到内容）';
  return d.join('、');
}

/**
 * 搜索域多选组：每个元数据域一个勾选框。**新增 → 全选**；编辑 → 按 `inst.metaDomains`
 * （`null`/缺席 = 全部 → 全选）。
 * 已保存但当前清单里没有的域（插件被卸了）也补一项并勾上 —— 否则提交时会被静默丢掉。
 * 回 `{ row, hasItems, checked }`：`hasItems` 为假时调用方别写 `metaDomains`（保持"缺席=全部"）。
 */
function metaDomainPicker(inst) {
  const saved = inst && Array.isArray(inst.metaDomains) ? inst.metaDomains.slice() : null; // null = 全部
  const items = (S.emby.metaDomains || []).map((d) => ({ domain: d.domain, label: d.label, enabled: d.enabled, missing: false }));
  if (saved) for (const d of saved) if (!items.some((x) => x.domain === d)) items.push({ domain: d, label: d, enabled: false, missing: true });

  const row = el('div', { class: 'row' });
  const boxes = [];
  for (const it of items) {
    const cb = el('input', { type: 'checkbox', title: it.domain });
    cb.checked = saved ? saved.includes(it.domain) : true;
    cb.dataset.domain = it.domain;
    boxes.push(cb);
    const note = it.missing ? '（插件不在了）' : it.enabled ? '' : ' · 未启用';
    row.append(el('label', { class: 'chk' }, cb, `${it.label}${note}`));
  }
  if (!items.length) row.append(el('span', { class: 'muted', text: '还没有装元数据插件（「插件」页可以装一个）' }));

  return { row, hasItems: items.length > 0, checked: () => boxes.filter((b) => b.checked).map((b) => b.dataset.domain) };
}

/** 新增（inst = null）与编辑共用一张窗：几样都是 `instance.patch` 认的字段 */
function openEditor(inst) {
  const isNew = !inst;
  const name = el('input', { type: 'text', spellcheck: 'false', maxlength: '40', placeholder: '实例名称', value: isNew ? '' : inst.name });
  const port = el('input', {
    type: 'number',
    min: '1',
    max: '65535',
    placeholder: '留空 = 自动挑',
    value: isNew ? '' : String(inst.port),
  });
  /* 首页插件 = 这个实例客户端上的媒体库（所选插件的全部行）；「空库」= 一行都不给。
   * 清单里没有当前值（插件被卸了 / 清单没取到）也要把它列出来，否则下拉会静默跳到第一项。 */
  const sel = el('select', { title: '客户端上的媒体库 = 所选插件的全部行；空库 = 一行都不给' });
  const opts = [{ id: '', name: '空库' }, ...(S.emby.homePlugins || [])];
  const cur = (isNew ? '' : inst.homePlugin) || '';
  if (cur && !opts.some((p) => p.id === cur)) opts.push({ id: cur, name: cur, missing: true });
  for (const p of opts) {
    const note = p.missing ? '（插件不在了）' : p.id ? `${p.enabled ? '' : ' · 未启用'}${p.rowCount === undefined ? '' : p.rowCount + ' 行'}` : '';
    const o = el('option', { value: p.id, text: p.id ? `${p.name}（${p.id}）${note}` : p.name });
    if (p.id === cur) o.selected = true;
    sel.append(o);
  }
  const picker = metaDomainPicker(inst);
  /* 下载开关：默认开（字段缺席 = 开）。关掉后握手 policy、条目 `CanDownload` 与下载端点一起拒绝 */
  const dl = el('input', { type: 'checkbox' });
  dl.checked = isNew ? true : inst.allowDownload !== false;
  /* 隐藏未播集：默认开（字段缺席 = 开）。关掉 = 列出元数据里的全部集（抢先版/泄露版可看） */
  const ua = el('input', { type: 'checkbox' });
  ua.checked = isNew ? true : inst.hideUnairedEpisodes !== false;
  const tip = el('div', { class: 'note' });

  modal({
    title: isNew ? '新增 Emby 实例' : `编辑「${inst.name}」`,
    body: [
      el('div', { class: 'field' }, el('label', { text: '实例名（客户端「服务器名」）' }), name),
      el('div', { class: 'field' }, el('label', { text: '端口' }), port),
      el('div', { class: 'field' }, el('label', { text: '首页' }), sel),
      el('div', { class: 'field' }, el('label', { text: '搜索域' }), picker.row),
      el('div', { class: 'field' }, el('label', { text: '下载' }), el('label', { class: 'chk', title: '允许客户端下载条目；关闭后握手与下载端点一起拒绝' }, dl, '允许下载')),
      el('div', { class: 'field' }, el('label', { text: '未播集' }), el('label', { class: 'chk', title: '分集列表不列未播出的集（未来首播日期 / 末尾无日期占位，与真机一致）；关掉列出全部（抢先版可看）' }, ua, '隐藏未播集')),
      tip,
    ],
    actions: [
      { label: '取消' },
      {
        label: isNew ? '创建' : '保存',
        primary: true,
        onclick: async () => {
          const body = {
            name: name.value.trim(),
            homePlugin: sel.value,
            allowDownload: dl.checked,
            hideUnairedEpisodes: ua.checked,
          };
          /* 搜索域：有可选项时才写（一个域都没装时保持"缺席=全部"）；全不勾 = `[]`（一个都不搜） */
          if (picker.hasItems) body.metaDomains = picker.checked();
          if (!body.name) {
            tip.textContent = '实例名不能空';
            return false;
          }
          /* 端口只在填了的时候才传：留空 = 交给后端自动挑（新增），或不改（编辑） */
          if (String(port.value).trim()) body.port = Number(port.value);
          try {
            const r = isNew
              ? await api('/api/emby/instances', { method: 'POST', body })
              : await api('/api/emby/instances/' + encodeURIComponent(inst.id), { method: 'PATCH', body });
            await afterChange(isNew ? `已新增实例：${r.instance.name}（端口 ${r.instance.port}）` : `已保存：${r.instance.name}`);
          } catch (e) {
            /* 端口不合法 / 已被别的实例占用 / 名字太长 —— 后端的话原样显示，窗口留着不丢输入 */
            tip.textContent = (isNew ? '创建失败：' : '保存失败：') + e.message;
            return false;
          }
        },
      },
    ],
  });
}

async function removeInstance(inst) {
  const go = await confirmModal({
    title: '删除实例',
    text: `删除「${inst.name}」（:${inst.port}）？${inst.accountCount} 个账号与全部观看进度一并删掉，找不回来。`,
    okLabel: '删除',
    primary: false,
  });
  if (!go) return;
  try {
    await api('/api/emby/instances/' + encodeURIComponent(inst.id), { method: 'DELETE' });
    await afterChange('已删除实例：' + inst.name);
  } catch (e) {
    toast('删除失败：' + e.message, true);
  }
}

