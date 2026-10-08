# ADR-0039 版本 Id：编码前先 deflate

- 状态：已采纳
- 相关：[0030](0030-play-address-handoff.md)（`ref` 由插件编、面板不解释） ·
  [0034](0034-fresh-install-no-migration.md)（不留双读分支） ·
  [0022](0022-movie-all-play-items.md)（版本 Id 载荷形状的来历，其形状描述随本条目作废） ·
  [service.js](../../server/modules/emby/service.js)（`catpawSourceId` / `parseCatpawSourceId` / `inflateText`）

> 改名注记：本条落码时的 `catpawSourceId` / `parseCatpawSourceId` 与前缀 `catpaw:`，已随「品牌净化」改名为
> `mbpSourceId` / `parseMbpSourceId` 与前缀 `mbp:`。压缩这一决策本身不变，仅标识改名（契约变更记录见
> [docs/emby-compat.md](../emby-compat.md)）。

## 背景

同一个视频，Rex 能播、SenPlayer 播不了。面板日志给到的原始请求是解开这条的口子：

- SenPlayer/6.2.2 的 `GET /videos/{ItemId}/stream.mp4?MediaSourceId=catpaw:…` 整条 URL **恰好 4095 字符**，
  其 `MediaSourceId` 的值 **4048 字符**，后面再没有任何 query 参数；
- 那 4048 字符 **base64 解出来的 JSON 是断的**（`Unterminated string`），长度除以 4 余 1；
- 面板据此 400「src 认不出」（`resolveStream`），客户端反复重试；换成 Rex 同一个条目 302。

**结论**：4095 是 SenPlayer 对 URL 的硬截断（Rex 没有），而面板发出去的版本 Id 最长实测 **5098 字符** ——
客户端无论如何都传不全，重进播放页也没用。

版本 Id 之所以这么长：载荷是 `JSON.stringify({r: ref})`，而 `ref` 是**插件编的一串 base64**
（里面还嵌着站点自己的 playToken）。把一段 base64 再 base64 一次，长度先翻 4/3，
被编码的那层又已经把原始结构撑大了。

## 决定

**`catpawSourceId()` 在 base64url 之前先 `zlib.deflateRawSync`，`parseCatpawSourceId()` 对应 `inflateRawSync`。**

- 形状：`catpaw:` + base64url(deflateRaw(JSON `{r: ref}`))，**只此一种** ——
  按 [0034](0034-fresh-install-no-migration.md) 不留双读分支，旧 Id 一律解析失败 → 400"重新进一次播放页"。
- 解压侧设 `maxOutputLength`（64KB）：这一段是**客户端递进来的**，不设上限等于把解压炸弹的开关交出去；
  合法载荷（实测约 3.8KB 明文）离上限很远。
- 用 Node 内置的 `zlib`，不引第三方依赖。

## 理由

- **实测收益够用**：对同一批 19 个版本，旧 Id 最长 5098 → 新 Id 最长 **3395** 字符，
  全部落进 4048 以内（余量 653 字符）。这类"base64 套 base64"的文本里有大量重复片段
  （playToken 里成片的 `QUFBQU…`），deflate 吃得很动。
- **同步、无依赖、开销可忽略**：`deflateRawSync` 在 3.8KB 上是微秒级，且只在拼版本列表 / 解 Id 时各跑一次。
- 与分层不冲突：这一层本来就只做"编码成客户端安全的一串、播放时原样交回插件"，
  现在多了"压小"——**依然不解释 `ref` 的内容**（[0030](0030-play-address-handoff.md)）。

## 备选方案

- **去掉外面那层重复编码**（直接把插件 ref 塞进 URL）：`ref` 里可能有 `/`、`#`，而客户端拼 query 时
  **不编码 `#`** —— 那正是当初要整体编码的原因（线路名 `夸克原画#01` 会把后半段变成锚点丢掉）。不能回头。
- **改插件协议、把 `ref` 本身缩短**（换短 id + 插件侧存映射）：能压得更多，但要动插件契约与插件侧状态，
  且面板不解释 `ref` 本就是为了不掺和插件的编法。本条目不做。
- **换 brotli**：实测（同一份真实载荷的明文 3818 字符）deflate = 2538 字节、brotli q5 = 2567（0.9ms）、
  q9 = 2540（4.2ms）、q11 = 2530（2.7ms）—— **体积差距在 8 字节以内、q11 反而更慢**。不值得。
- **只加诊断日志、不改形状**：客户端该传不全还是传不全，等于不修。
- **改成短 id + 服务端映射表**：Id 会变短，但引入一份有状态映射（写入、过期、并发、清理），
  而 [0006](0006-redirect-for-playback.md) 那套"面板不扛流量、Path 只放稳定坐标"的口径下，
  Id 本就该是自解释的。不做。

## 后果

- **改动前发出去的 Id 全部作废**：客户端手里缓存的那一批会先吃一个 400，进播放页重取即可
  （客户端点播放前必问 `PlaybackInfo`）。口径同 [0034](0034-fresh-install-no-migration.md)。
- Id 不再肉眼可读（base64 下面是一层压缩流）。排查时**不要**去 base64 解一下当 JSON 看，
  先 inflate 再解 —— 文档与日志里的示例值同样按新形状写。
- 余量 653 字符不是无穷多：**上游 playToken 若继续变长，仍可能再次顶到 4048**。
  再犯时的下一步不是换压缩算法（deflate 已接近这条路的极限），而是上面那条"改插件协议缩短 `ref`"。