# ADR-0072：缓存库 WAL 起不来时降级 DELETE journal，开库全程原子化

## 状态

已采纳。

## 背景

GitHub issue #3：CentOS 7 + Docker 的用户建实例后报「读取实例失败：disk I/O error」，
缓存设置页报「读取用量失败：no such table: line_cache」，删数据重建无数遍仍复现。

排查结论（两条错，一条链）：

1. `cachedb.open()` 把 `new DatabaseSync(filePath)` **直接赋给模块级 `db`**，然后才跑
   `PRAGMA journal_mode = WAL` 和建表。老内核 overlayfs（/ NFS / SMB）上 WAL 拿不到共享内存，
   pragma 抛 `disk I/O error` —— 这是用户看到的第一条错。
2. 但 `db` 已非空，下次 `if (db) return db` 直接返回这个**半初始化句柄**，表永远没建，
   之后所有访问报 `no such table: line_cache` —— 第二条错，且完全误导排查方向。

## 决定

`core/cachedb.js` 的 `open()`：

1. **原子化**：全程用局部句柄，pragma + 建表**全部成功**后才赋给 `db`；失败则 `close()`
   并原样抛错，不留脏状态。
2. **WAL 降级**：`journal_mode = WAL` 抛错时，打一条 `✘` 级日志（说明原因与"换本地盘"指引），
   退回 `journal_mode = DELETE` 继续跑。连 DELETE 都起不来（卷只读/损坏/盘满）才抛错。

## 备选方案

- **保持"WAL 失败即抛"**：缓存全炸，且错误冒到无关端点（实例列表、用量页）。否决 ——
  缓存是可丢数据（见本文件头「⚠️ 这里存的一律是可丢弃数据」），不该为它会话级功能不可用。
- **一律改用 DELETE journal**：最省心，但丢掉高写入场景（线路结果 + 图片索引并发读写）
  的 WAL 收益；正常环境占绝大多数，不该为少数坏环境全体降级。否决。

## 后果

- WAL 起不来的环境（老内核 / 网络盘）：面板照常可用，缓存读写并发收益丢失（这些小库
  写入量本就很低，无感）。启动日志里有一条 `✘` 级红字指引。
- 卷本身坏掉的情况（盘满 / NFS 断连）：写库仍会在操作点报错，但报的是**真实原因**，
  不再是误导性的 `no such table`。
- 配套：`logbus.js` 按行首符号归级（`✘`→error、`⚠️`→warn），面板「日志」页的
  「仅错误」过滤与标红样式（CSS 早已备好）自此对 `console.log('  ✘ …')` 的调用点生效。
