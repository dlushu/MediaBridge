# ADR-0044 Emby 层也接 `proxy` 档：`playVia` 编进版本 Id

- 状态：已采纳
- 相关：[0042](0042-auth-line-byte-relay.md)（本文补上它记下"暂不接"的那一格）、
  [0040](0040-hls-playlist-relay.md)（清单中继）、
  [0039](0039-compressed-source-id.md)（版本 Id 载荷形状）、
  [0006](0006-redirect-for-playback.md)（302 基线）

> 改名注记：本条落码时的 `catpawSourceId` / `parseCatpawSourceId` 与前缀 `catpaw:`，已随「品牌净化」改名为
> `mbpSourceId` / `parseMbpSourceId` 与前缀 `mbp:`。本条决策（`playVia` 编进版本 Id）不变，仅标识改名（契约变更记录见
> [docs/emby-compat.md](../emby-compat.md)）。

## 背景

[0042](0042-auth-line-byte-relay.md) 给 agg 流端点（`GET /api/agg/stream`，面给出口插件用的外部播放器）
加了"面板代持鉴权头中继"这一档，落法由契约里的 `playVia` 声明决定。同一条 ADR 里明确把 Emby 这一层
**排除在外**：Emby 客户端同样带不了请求头，理论上该接，但当时两件事没做 ——

1. Emby 的落法是"`service` 返回描述符、由路由层写响应"，接字节中继要**多一种响应形态**；
2. `playVia` 在**版本 Id 的载荷里没有承载** —— 版本 Id 只编了 `{r: ref}`，Emby 起播时手里没有这个声明。

后果就是 0042 背景里描述的那条死路在 Emby 这条路上**原样存在**：源插件标了 `proxy` 的线路
（实测 `nodejs_huban / 夸克 · 原画`），面板日志写 `⚠️ 该线路要求请求头 User-Agent/Referer/Cookie，
302 后客户端带不了`，客户端拿不到头、播不了。同一部片在出口插件（FW/Rex）里能播（宿主能把头交给播放器），
在 Emby 里不能 —— 同一个 `playVia` 声明，两处落法不一致。

## 决定

**Emby 层按同一份 `playVia` 声明落法，四档与 agg 流端点对齐。** 三处改动：

1. **`playVia` 跟着 `ref` 走，编进版本 Id 载荷**。`catpawSourceId(ref, playVia)` 产出
   `catpaw:` + base64url(deflateRaw(JSON `{r: ref, v: playVia}`))；`v` 缺席 = `client`（省长度，
   `client` 是缺省）。`buildMediaSource` 拼版本列表时读 `detail.lines[].playVia`；
   `parseCatpawSourceId` 解回 `{ref, playVia}`，起播时喂给 `planStream({url, playVia})`。
   **唯一真相仍是线路级的 `detail.lines[].playVia`** —— 不改成"读 `agg.play` 返回里的 `playVia`"：
   那会变成第二份真相，两处可能漂移。
2. **`finishStream` 按 `planStream` 四档分派**：`redirect`（302）、`playlist`（清单补绝对）、
   `relay`（返回 `{relay:{url,headers,label}}` 交给路由层）、`relay-playlist`（清单里每个地址
   改写成面板签名子地址）。
3. **Emby 多一条流端点 `/api/emby/stream?seg=&sid=`**，与 `/api/agg/stream?seg=` **同一份实现**
   （`agg/stream.js` 的 `servePart` / `relayBytes`），只验 HMAC 签名、不校验 Emby token。
   子地址用 `partLink(origin, url, sid, '/api/emby/stream')` 生成。

## 理由

- **不统一"谁执行"，只统一"声明 + 落法"。** 出口插件能交出头（FW/Rex 宿主）时自己直连 CDN 是更优路径，
  继续保留（见 fwrex 的 NOTES）；Emby 客户端带不了头，只能由面板代持。两者都**读同一份 `playVia`**、
  都按同一份 `planStream` 判档 —— 这就是"统一"的全部内容，不是让某一方去模仿另一方。
- **`playVia` 必须编进 Id，不能起播时现取。** Emby 拉流那一步（`resolveStream`）只收到一个版本 Id，
  回查 `agg.play` 得到的是**地址**不是**声明**；声明在 `detail` 阶段，那时版本列表正在拼，
  顺手编进 Id 是零成本的（同一处 `buildMediaSource`）。ADR-0039 已经把这串 Id 压过一道，
  多一个短字段不影响长度口径。
- **子地址必须落在 `/api/emby/` 下。** Emby 实例端口的监听**只收 `/api/emby/` 前缀**
  （见 `emby/listener.js`）：清单是客户端在实例端口上取回去的，里面改写出的分片地址也只会打回实例端口，
  指到 `/api/agg/stream` 必吃 404。所以 `partLink` 加一个 base-path 参数，两份实现、两条路径。
- **子地址照旧"只认签名、不校验 token"。** 与 agg 那条同一口径：它是**面板自己发出去的子地址**，
  唯一的凭证是 `signStreamPart` 的 HMAC（面板 `secret`）。分片请求由播放器底层发出，往往不带 `api_key`，
  要求 token 反而会把正常播放打断。签名之外仍要凭 `sid` 查内存里那份 `sid → 鉴权头` 表（与 agg 共用，见"后果"）。
- **判据只能是声明**（契约第五节）：不看 `header` 是否非空 —— 源顺手给的头可能只是信息性的。

## 备选

- **让 Emby 去调 `/api/agg/stream` 端点（端点级复用）**：否决。理由同 [0042](0042-auth-line-byte-relay.md)
  的备选 —— 那条路径认外部访问令牌、豁免 cookie，Emby 客户端手里只有 Emby token；且 Emby 本来就在
  同进程直调 agg（[0002](0002-in-process-emby-to-agg.md)），复用只能是**函数级**的。
- **起播时读 `agg.play` 返回里的 `playVia`**：否决。变成第二份真相，与 `detail` 的声明可能漂移。
  落法必须由**版本列表那一刻**的声明决定，因为客户端缓存的 Id 与当时的版本列表是绑定的。
- **给 Emby 也开一条 `/api/agg/stream` 的等价端点而不复用**：否决。照抄一遍就是两份实现，
  清单改写与验签两条路早晚漂移。共用 `agg/stream.js` 的内核，只传不同的 base-path。
- **`proxy` 线路仍 302、只在日志里提醒**：等于保留那条死路（0042 背景），不做。
- **改 fwrex 让它也用面板中继**：否决。见 [0042](0042-auth-line-byte-relay.md)：宿主能交出头时直连 CDN
  永远更优（省面板带宽），那是保留路径，不是要消灭的路径。

## 后果

- **ADR-0042 里"Emby 层暂不接这一档"那句作废**（其备选与决定内的表述已同步更新指向本文）。
  四档落法在 agg 与 Emby 两条路上一致。
- **版本 Id 多一个可选字段 `v`**：`client` 线路不带（与改前逐字节一致），`proxy` 线路带。
  **旧的 `{r}`-only Id 仍能解**（`v` 缺席视作 `client`）—— 不构成 ADR-0034 那种"不留双读"的形状变更，
  但**改版前缓存的 `proxy` 线路 Id 会按 `client` 落**（302、带不了头），需客户端重进播放页取新 Id
  （客户端点播放前必问 `PlaybackInfo`，自会拿到）。这与改前行为相同，无回退。
- **`proxy` 线路的媒体字节确实会经面板**（非清单档每一跳 / 清单档每一次分片请求）。这是刻意的取舍
  （播得动优先于省带宽），与 [0042](0042-auth-line-byte-relay.md) 的后果一节同款。
  **下载端点（`Items/{ItemId}/Download`）同样如此** —— 一条 `proxy` 线路的整文件下载会经面板。
- **面板多一处内存态**：与 agg 共用同一份 `sid → 鉴权头` 表（TTL 6 小时、上限 256 条）。
  面板重启即失效，客户端重取一次清单即可。
- **日志能看出走了哪一档**：`→ 200 面板中继（字节经面板，分块并发搬运）` /
  `→ 200 清单中继（N 个地址改成面板子地址）`；中继每跳另打一行搬运量与状态。
- **`/api/emby/stream` 是新的公开入口**（豁免面板 cookie 门禁，只认签名）。运维口径同
  [0042](0042-auth-line-byte-relay.md)：泄漏一条签名子地址 ≈ 泄漏那一份流。
