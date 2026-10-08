'use strict';
/**
 * 面板的名字 —— **后端只有这一处**（前端那份与它成对：`public/core/branding.js`）。
 *
 * 命名约束：名字**不绑"猫源"**（后续不一定只适配猫源）。据此：
 *   · `name`      = **正式短名**：Emby 客户端「服务器列表」里显示的服务器名、包名、请求 UA 用它
 *                   （客户端那个位置要短，所以不带"面板"两个字）；
 *   · `panelName` = **界面称呼**：网页标题、顶栏、登录页、启动日志 —— 对外介绍用的就是它。
 *   · **界面内不摆图标** —— 顶栏与日志只有文字（浏览器标签页图标另有 `public/logo.png`，不在此列）。
 *
 * ⚠️ **改名时改这几处**（不要满仓库找字符串）：
 *   ① `server/core/branding.js`（这份） ② `public/core/branding.js`（前端那份）
 *   ③ `package.json` 的 `name`（npm 包名不能动态） ④ `public/index.html` 里那份**首屏兜底文本**
 *      （JS 启动后会用 branding.js 覆盖它，只是白屏一瞬兜底）
 * 其余位置（启动日志、UA、Emby 默认服务器名、登录页、顶栏、网页标题）**都是读这两份 branding**。
 *
 * 另注：**"猫源"这个词没有被清掉** —— 它是**类别**不是品牌：加源的地方、页面名「猫源地址」、
 * 下载校验的报错都还写着它（否则用户无从知道该添加什么源地址）。
 * 品牌位（产品叫什么）与类别位（该填什么源）是两件事。
 *
 * ⚠️ **这是"部署/数据标识"，跟着品牌改**（与数据目录、卷绑在一起，不是产品名；
 * 改它等于换部署身份，会波及已有部署与客户端）：
 *   · 登录 cookie 名 `mbp_panel`（改一次，所有客户端都要重新登录一次）
 *   · 前端 `localStorage` 的键前缀 `mbp-`（如 `mbp-theme`、`mbp-login-pw`）
 * 前端 `localStorage` 的键已经是 `mbp-` 前缀，代码里改这几处即可。
 *
 * 备份文件名**不在这份名单里**：它是 `slug` + 时间戳（`media-bridge-panel-backup-YYYYMMDD-HHmm.zip`），
 * 跟着品牌走 —— 它只是个下载文件名，换掉不影响已有备份包的还原。
 */
const BRAND = {
  name: '媒体桥',
  /** Emby 客户端「服务器列表」里显示的默认名（带 Emby 后缀：客户端里一眼看出这是个 Emby 服务） */
  embyServerName: '媒体桥 Emby',
  panelName: '媒体桥面板',
  /** npm 包名 / 目录名用的短标识 */
  slug: 'media-bridge-panel',
  /** 下载猫源时对外自称的 UA（源站那边只看得到这个） */
  ua: 'MediaBridgePanel/1.0',
};

module.exports = BRAND;
