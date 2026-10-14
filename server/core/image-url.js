'use strict';
/**
 * 封面地址：**形态判据的唯一出处**（见 ADR-0079）。
 *
 * 面板经手两种"看起来都像路径"的图片地址，归属完全不同 —— 判错一次就是整库封面刷 501
 * （实测踩过，反例见 ADR-0079）：
 *
 *   · `relay`    —— **面板自己的图片中继**（`IMG_RELAY_PREFIX`）。插件用它表达"这张图请面板代取"
 *                  （图床要 Referer 时）。出图那一跳补签名 + 补本跳 origin，客户端回来取。
 *   · `relative` —— **图床自己**的相对路径（TMDB 的 `poster_path` 就长这样，如 `/abc.jpg`）。
 *                  它必须与该域声明的 `imageBase` 拼成完整地址，**绝不能被当成面板自己的地址**。
 *
 * 判据只有一条：**是不是那个前缀**。任何"以 `/` 开头就当中继"的宽判据都是错的 ——
 * 那会把图床的相对路径补成本机实例地址，产出客户端取不到的死地址。
 *
 * 前缀常量从这一处导出：agg 的中继实现（`agg/stream.js`）、emby 的写入/出图两跳、首页行归一化
 * 全部 import 它。**别在别处再写字面量** —— 上一版就是因为这个字面量散在多处、其中一处被放宽成
 * `^/`，才让"图床"和"中继"互相干扰。
 */
const IMG_RELAY_PREFIX = '/api/emby/img/';

/**
 * 判一个图片地址属于哪种形态。
 *
 * @param {string} v 插件给的 / 面板存下来的地址
 * @returns {'absolute'|'relay'|'relative'|'none'}
 *   · `absolute` 完整 http(s) 地址 —— 客户端直连，面板只做 302；
 *   · `relay`    面板图片中继的前缀形态 —— 面板代取；
 *   · `relative` 其余非空值（图床相对路径；协议相对的 `//host/x` 也算在这一档，按相对处理）；
 *   · `none`     空值 / 只有空白。
 */
function imageKindOf(v) {
  const s = String(v || '').trim();
  if (!s) return 'none';
  if (/^https?:\/\//i.test(s)) return 'absolute';
  return s.startsWith(IMG_RELAY_PREFIX) ? 'relay' : 'relative';
}

/** 便捷判据：是不是面板自己的图片中继地址（等价于 `imageKindOf(v) === 'relay'`） */
function isImageRelay(v) {
  return imageKindOf(v) === 'relay';
}

module.exports = { IMG_RELAY_PREFIX, imageKindOf, isImageRelay };
