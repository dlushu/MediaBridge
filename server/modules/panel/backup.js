'use strict';
/**
 * 面板数据备份 / 还原：打成一个 zip 包，包含**数据卷里的全部数据**、不含缓存。
 *
 * 打包范围（相对 `DATA_DIR`）：
 *   · `settings/`        面板与各模块的设置
 *   · `templates/`       聚合模板
 *   · `plugins/`         插件仓库：清单 + 各插件的包本体 + 各插件自己的 `data/`
 *   · `emby/`            客户端账号库（含 scrypt 密码哈希）、实例清单、播放进度
 *   · 其余顶层文件（如遗留的 `settings.json`）
 *
 * 排除：
 *   · `app/`            应用代码 —— 可从 Release 重新取得（见 docs/adr/0019），换机器时不必背着走
 *   · `cache/`、`emby/cache.db`、各插件的 `data/cache/` —— 缓存，随时可删掉重建
 *   · 以 `.` 开头的临时目录（`.staging-*` / `.kept-*` / `.data-*` 等安装中间态）
 *
 * ⚠️ 备份**包含敏感内容**（插件数据里可能有网盘 cookie/token，账号库里是密码哈希）——
 *    备份文件本身就是要妥善保管的私密文件，界面会明确提示。
 *
 * 还原是**整项替换**：把 zip 里的顶层项逐个覆盖回数据卷（先删后改名）。账号库与插件数据
 * 是运行中进程正打开着的，替换后要**重启面板**才会读到新数据（见 routes.js 的返回提示）。
 */
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../../core/paths');
const zip = require('../../core/zip');
const pkg = require('../../../package.json');

/** MANIFEST 放在 zip 根：还原时靠它确认"这确实是本面板的数据备份" */
const MANIFEST = 'manifest.json';

/** 顶层排除：应用代码与面板自己的共享缓存目录 */
const TOP_SKIP = new Set(['app', 'cache']);

/** 缓存路径 —— 可随时删掉重建，不进备份 */
function isCache(rel) {
  /* ⚠️ `-wal` / `-shm` 是 sqlite 的旁文件，**跟着 `cache.db` 一起排除**：`cache.db` 都排除了，
   * 旁文件留着没有意义（它们是那份缓存的写前日志与共享内存），白占体积
   * （实测这一份就有 4MB），而且运行中被拷走也不保证一致。 */
  if (rel.startsWith('emby/cache.db')) return true;
  /* 插件自己的缓存固定放在它的 `data/cache` 下（见各插件 lib/cache.js 的约定）。
   * 多类型拍平后布局是 plugins/<id>/data/cache（见 docs/adr/0046）。 */
  return /^plugins\/[^/]+\/data\/cache(\/|$)/.test(rel);
}

/** 排除规则：给 `zip.dirEntries` 用（返回真值则跳过，目录被跳过时整棵子树都不进） */
function skipEntry(rel, isDir) {
  const segs = rel.split('/');
  if (TOP_SKIP.has(segs[0])) return true;
  if (isDir && segs[segs.length - 1].startsWith('.')) return true; // 安装中间态、还原暂存目录
  return isCache(rel);
}

/**
 * 采集数据卷 → zip 字节。
 * 返回 `{ buffer, files, size, contentBytes, exportedAt }`。
 *
 * ⚠️ **`size` 与 `contentBytes` 是两回事，别拿错**：
 *   · `size`         = **包的实际字节数**（`buffer.length`）—— 界面显示"多大"用它，与下载到的文件一致；
 *   · `contentBytes` = 内容**未压缩**字节和 —— 只作记录（zip 会压缩，实测 64.7MB 的内容打包成 19.6MB，
 *     差三倍多；早期把它当包大小显示出去，界面上就对不上）。
 * `files` 不含 manifest 本身。
 */
function exportAll() {
  const entries = zip.dirEntries(DATA_DIR, { skip: skipEntry });
  const contentBytes = entries.reduce((n, e) => n + e.data.length, 0);
  const exportedAt = new Date().toISOString();
  const manifest = {
    service: 'mbp-panel',
    kind: 'panel-data-backup',
    version: String(pkg.version || ''),
    exportedAt,
    files: entries.length,
    contentBytes,
  };
  entries.push({ name: MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2)) });
  const buffer = zip.buildZip(entries);
  return { buffer, files: manifest.files, size: buffer.length, contentBytes, exportedAt };
}

/**
 * 用一份备份 zip 覆盖数据卷。
 *
 * 步骤：解到暂存目录 → 校验 manifest → 把暂存目录下的顶层项逐个替换回 `DATA_DIR`。
 * **先删后改名**：运行中的进程持有的是被 unlink 的旧 inode，不会把刚放回去的新文件写坏；
 * 重启后读到新数据。
 *
 * `app/` 不在备份里，因此原样保留；面板自己的缓存 `cache/`（独立顶层目录）也原样保留，
 * `emby/cache.db` 因为整个 `emby/` 会被替换，另行挪出来再放回。插件自己的缓存住在插件数据目录里，
 * 会随 `plugins/` 一起被替换掉（缓存可重建，这与"备份不含缓存"是同一口径）。
 */
function restore(buffer) {
  const items = zip.readZip(buffer);
  const manifestItem = items.find((it) => it.name === MANIFEST);
  if (!manifestItem) throw new Error('这个 zip 里没有 manifest.json，不是面板的数据备份');
  let meta = null;
  try {
    meta = JSON.parse(manifestItem.data.toString('utf8'));
  } catch {
    meta = null;
  }
  if (!meta || meta.service !== 'mbp-panel') throw new Error('这个 zip 不是面板的数据备份（manifest 对不上）');

  const staging = path.join(DATA_DIR, `.restore-${process.pid}-${Date.now()}`);
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  /* 备份里不含缓存，但整个 `emby/` 会被替换 —— 先把面板自己的图片索引缓存 `emby/cache.db`
   * 挪到一边，替换完再放回去，还原前后这份可再生但从头再取要花时间的缓存不丢。 */
  const keepDir = path.join(DATA_DIR, `.restore-keep-${process.pid}-${Date.now()}`);
  fs.mkdirSync(keepDir, { recursive: true });
  const keepBack = [];
  const embyCache = path.join(DATA_DIR, 'emby', 'cache.db');
  if (fs.existsSync(embyCache)) {
    const held = path.join(keepDir, 'emby-cache.db');
    fs.renameSync(embyCache, held);
    keepBack.push({ from: held, to: embyCache });
  }

  const restored = [];
  try {
    for (const it of items) {
      if (it.name === MANIFEST) continue;
      const dest = path.join(staging, it.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, it.data, { mode: it.mode || 0o600 });
    }
    for (const name of fs.readdirSync(staging)) {
      if (TOP_SKIP.has(name)) continue; // 兜一道：绝不覆盖应用代码
      const to = path.join(DATA_DIR, name);
      fs.rmSync(to, { recursive: true, force: true });
      fs.renameSync(path.join(staging, name), to);
      restored.push(name);
    }
  } finally {
    /* 放回保留下来的缓存（父目录可能刚被替换掉，先补齐）——失败也不该让缓存文件留在保命目录里 */
    for (const k of keepBack) {
      if (fs.existsSync(k.from)) {
        fs.mkdirSync(path.dirname(k.to), { recursive: true });
        fs.renameSync(k.from, k.to);
      }
    }
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(keepDir, { recursive: true, force: true });
  }

  return {
    ok: true,
    restored,
    files: items.length - 1,
    version: String(meta.version || ''),
    exportedAt: String(meta.exportedAt || ''),
    note: restored.length
      ? '数据已按备份覆盖。账号库与插件数据要重启面板（容器重启）后才生效。'
      : '备份里没有可还原的数据',
  };
}

module.exports = { exportAll, restore };