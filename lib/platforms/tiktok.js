/**
 * TikTok Shop 商家中心 —— 买家消息（客服消息中心）适配器。
 *
 * 把「打开 TikTok Shop 店铺 → 进客服消息中心 → 取需要回复的会话 → 读会话正文 → 填草稿」
 * 这一串页面动作，收敛成一组方法，巡逻引擎只调这些方法，不认识任何 CSS 选择器。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ✅ 选择器校准状态：**已在真实 DOM 上校准**（verified = true，2026-10-10）
 * ─────────────────────────────────────────────────────────────────────────────
 * 校准现场：紫鸟店铺 **Tiktok-FUSOU-客服主号**（FUSOU Furniture，shop_region=US）。
 * 真实入口是 IM 图标打开的斜杠 chat 页（"客服会话管理"），实机 61 条会话、单会话 21 条消息；
 * 列表 / 正文 / 回复框三条链路都用真实 data-testid 跑通，并实测生成了草稿、默认填入回复框。
 *
 * 踩到并记下来的四个真实事实（每一条都对应一次失败）：
 *   1. **消息中心是 /chat，不是 /message**。US 店域名是 seller.us.tiktokshopglobalselling.com
 *      （带 "us."），不是 seller-us.tiktok.com（那是落地页）。
 *   2. **会话行是 <div>，不能用 `:nth-of-type(N)` 定位** —— 它按同类型兄弟计数，
 *      而卡片之间夹着虚拟滚动占位元素，于是 nth-of-type(2) 根本不是第 2 行，
 *      表现为「第 2 条会话不在列表里了」并被静默跳过。改用按**数组下标**取（clickScriptByIndex）。
 *   3. **消息方向不能靠几何/类名判断** —— 实机 21 条消息的 x 坐标全是 488，类名差异也不稳定。
 *      唯一可靠的是**发送者前缀**：我方消息带客服名或店铺名，买家消息不带，
 *      还有一类系统消息（会话被分配 / 系统关闭聊天）两边都不算。
 *   4. **本平台没有会话级深链** —— 点不同会话 URL 恒为 /chat/inbox/current，
 *      卡片 id 是位置序号（chat-room-conversation-list-item-0）。所以 conversationUrl 永远返回空串。
 *
 * 仍然保留多套兜底选择器，并且：
 *   - 一套都没命中时，页面脚本返回 { ok: false, reason, tried: [...] }，错误里带上
 *     reason、tried 与页面 url/title —— 让人一眼看出「是没登录 / 改版了 / 还是结构变了」，
 *     而不是一句含糊的「消息中心没加载出来」。
 *
 * 尚未覆盖（校准过 ≠ 万无一失，见适配器上的 calibrationNote）：
 *   - 只在一家 US 店上校准，跨境主站 seller.tiktokshopglobalselling.com 的 /chat 未验证；
 *   - 「未回复 / 未读」筛选靠行文本判定，未接平台自身的筛选控件；
 *   - 发图/附件、快捷回复、转交等交互未涉及。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 硬约束：**这个文件里不存在任何「发送」动作。**
 * ─────────────────────────────────────────────────────────────────────────────
 * 草稿先落进插件自己的草稿库，再默认直接填进**可见的**紫鸟浏览器窗口里的回复框
 * （巡逻与人工点单条都会走这条路），填完就停，绝不点那个按钮。
 *
 * 与早期版本的一个差别：现在**知道**发送按钮在哪（button[data-testid="chat.chatroom.send_message_btn"]，
 * 文案「发送」），并把它作为常量 sendMessageBtnSelector() 导出 —— 但它的唯一用途是被测试
 * grep 到、以及让脚本可以**显式排除**它。本文件里没有任何一处会点它。
 *
 * **无头模式已移除**：store open 永远不加 --headless。窗口不可见时把文本填进回复框
 * 没有任何意义 —— 没人看得到，也没法核对。
 *
 * @module dsh-customer-service-plugin/lib/platforms/tiktok
 */

import { isRetiredStore, normalizeStoreList, unwrapExec } from '../ziniao.js';
import { isChannelEnabled } from '../settings.js';

/** 平台标识（同时是 queue.channel 与草稿的 platform 字段）。 */
export const PLATFORM_ID = 'tiktok';
/** 平台展示名。 */
export const PLATFORM_LABEL = 'TikTok Shop';

/* ── 站点入口（实测） ─────────────────────────────────────────────────────
 * 跨境卖家的 TikTok Shop 商家中心有两个入口，同一家店在不同账号体系下会落到不同域名：
 *   - seller.tiktokshopglobalselling.com  跨境主入口
 *   - seller-us.tiktokshopglobalselling.com  美国本地（US）入口
 * 两者未登录时都会 302 到各自的 /account/login，所以 isTikTokLoginUrl() 两个都认。
 *
 * ⚠️ 注意 US 店的真实域名是 **seller.us.tiktokshopglobalselling.com**（带 "us."），
 * 不是 seller-us.tiktok.com（后者是注册/落地页，会跳到别处）—— 2026-10-10 实机确认。
 */

/** 跨境主入口。 */
export const INBOX_BASE = 'https://seller.tiktokshopglobalselling.com';
/** 美国本地入口。 */
export const INBOX_BASE_US = 'https://seller.us.tiktokshopglobalselling.com';
/** 客服消息中心路径（**实测**：登录后 IM 入口打开的正是 /chat）。 */
export const INBOX_PATH = '/chat';
/** 客服消息中心地址。 */
export const INBOX_URL = INBOX_BASE_US + INBOX_PATH;

/** 商家中心首页（登录成功后实测落点之一）。 */
export const HOMEPAGE_URL = INBOX_BASE_US + '/homepage';

/* ── 登录态（2026-10-10 两次真实登录实测） ─────────────────────────────────
 * 两次登录的挑战类型**不一样**，所以插件不可能预测、更不可能代劳：
 *   - 店1 Tiktok-FUSOU-客服主号：滑块验证码「点击选中两个相同形状的物体」
 *   - 店2 Tiktok-FUSOU-客服KX：6 位**邮箱验证码**（发到 cs@jinmukeji.com），无滑块
 * 验证码发到人手上，插件根本拿不到；滑块与风控更是碰不得。
 *
 * 所以本模块的「登录」只有一件事：**把浏览器开到登录页摆好，然后停下来等人。**
 * 不点登录按钮、不填账号密码、不填验证码、不处理滑块 —— 见 LOGIN_FORM_SELECTORS 与
 * 「登录不代劳」那几条测试；fillOpenConversation / fillComposer 的输入同样与登录表单无关。
 * ─────────────────────────────────────────────────────────────────────── */

/** 登录态枚举 —— 就这四个，别再造新的。 */
export const LOGIN_STATES = Object.freeze({
  /** 已是登录态（页面在商家中心）。 */
  LOGGED_IN: 'logged_in',
  /** 已把页面停在登录页，等人。 */
  LOGIN_REQUIRED: 'login_required',
  /** 等人等到超时。 */
  TIMEOUT: 'timeout',
  /** 打不开店铺 / 异常（带 error）。 */
  FAILED: 'failed',
});

/** waitForLogin 的默认轮询间隔（毫秒）—— 别把页面打爆。 */
export const LOGIN_POLL_INTERVAL_MS = 3000;
/** waitForLogin 的最小轮询间隔（毫秒）：调用方传更小的值一律抬到这个下限。 */
export const LOGIN_POLL_MIN_INTERVAL_MS = 3000;
/** waitForLogin 的默认总超时（毫秒）—— 5 分钟，够人过完验证码。 */
export const LOGIN_TIMEOUT_MS = 300000;

/**
 * ⛔ **登录表单相关选择器 —— 本文件除了这一处声明，任何地方都不许用。**
 *
 * 这个常量唯一的作用是被测试 grep 到、并作为「我们知道登录表单长什么样，但永远不碰」的证据：
 * 插件不代替人完成登录，所以没有任何一次 click / input 允许落在这些选择器上
 * （测试里有一条断言把这件事钉死：调用参数里不能出现登录表单相关的 click/input）。
 */
export const LOGIN_FORM_SELECTORS = Object.freeze([
  'input[type="password"]',
  'input[name="password"]',
  'input[name="email"]',
  'input[type="email"]',
  'input[autocomplete="one-time-code"]',
  '[data-testid*="login"] button',
  'button[type="submit"]',
  '[class*="captcha"]',
  '[class*="slider"]',
]);

/**
 * 判断一个地址是不是「已经进了商家中心」。
 *
 * **实测判据是 URL**（两次真实登录都验证过）：
 *   已登录 → https://seller.us.tiktokshopglobalselling.com/homepage?lng=en&region_check=1&shop_region=US
 *            https://seller.us.tiktokshopglobalselling.com/chat/inbox/current?shop_region=US
 *   未登录 → 见 isTikTokLoginUrl()（**两个域名**都可能出现）
 * 刻意**不看 DOM**：未登录页与已登录页都可能还在渲染，拿 DOM 判断会把「还在加载」说成
 * 「没登录」——而这两句话对运营的含义完全不同（一个要等，一个要人去登录）。
 * @param {string} url - 地址。
 * @returns {boolean} 是否已登录。
 */
export function isTikTokLoggedInUrl(url) {
  const raw = String(url ?? '').trim();
  if (!raw) return false; // 读不到地址不算证据：空串既不是「已登录」也不是「登录页」
  if (isTikTokLoginUrl(raw)) return false; // 登录页优先，任何形态的 /account/login 一律算未登录
  return /tiktokshopglobalselling\.com|seller\.tiktok\.com/i.test(raw);
}

/**
 * 会话深链 —— **实测结论：TikTok Shop 没有会话级深链，永远返回空串。**
 *
 * 2026-10-10 在真实店铺（FUSOU Furniture，US 店）实测：在 /chat 里点击不同会话，
 * `location.href` **始终是** `/chat/inbox/current`，不随会话变化；会话卡片上的
 * id 是 `chat-room-conversation-list-item-0` 这种**位置序号**（第 0 行 / 第 1 行），
 * 不是稳定会话标识 —— 列表一刷新就指错会话。
 *
 * 所以这里与 lark-mail 同类：**没有稳定深链可给，返回空串**，由界面隐藏「打开原会话」。
 * 这比编一个「看起来对」的链接安全得多：退回消息中心首页会得到一个非空、能点开、
 * 却指向收件箱首页的入口 —— 一个错的入口比没有入口糟得多。
 *
 * 保留这个导出（而不是删掉）是为了让 CASE_URL_BUILDERS 的分派保持统一，
 * 也让「为什么没有深链」这件事在代码里有一处明确的答案。
 * @param {string} caseId - 会话 id（本平台用不上）。
 * @returns {string} 永远是空串。
 */
export function conversationUrl(caseId) {
  return '';
}

/* ── 选择器：**已在真实 DOM 上校准**（2026-10-10，Tiktok-FUSOU-客服主号 / US 店） ──
 * 校准现场：店铺 FUSOU Furniture（shop_region=US），客服会话管理页 61 条会话、21 条消息。
 * 真实选择器用的是 TikTok 的 **data-testid 语义命名**（命名空间 chat.chatroom.*），
 * 实测确认存在，所以把它放在每个兜底数组的第一位。
 *
 * 仍然保留兜底数组：data-testid 万一改名，后面几套宽泛形态还能撑一阵 ——
 * 但**第一位永远是实测命中的那一个**，别把它挤下去。
 */

/**
 * 登录页特征（**这一条是实测的**）。
 *
 * 两个入口未登录时都会 302 到 /account/login；个别场景会带 login/ 前缀或 /login 收尾，
 * 所以三种形态都认。刻意不写裸的 /login：万一正常页面里出现同名子串就误判了。
 */
export const SIGNIN_URL_RE = /\/account\/login|\/login\/|\/login(?:[?#]|$)/i;

/** 会话列表容器 —— **实测** via [data-testid="chat.chatroom.conversation_list"]。 */
export const LIST_SELECTORS = [
  '[data-testid="chat.chatroom.conversation_list"]',
  '[class*="conversation_list"]',
  '[class*="conversationList"]',
  'main ul[role="list"]',
];
/** 主选择器（= 兜底数组第一个）；单独导出是为了让剧本/外部断言有个稳定锚点。 */
export const LIST_SELECTOR = LIST_SELECTORS[0];

/** 会话列表里的单行 —— **实测**（实机 17 行）。 */
export const ROW_SELECTORS = [
  '[data-testid="chat.chatroom.conversation_card"]',
  '[class*="conversation_card"]',
  'li[role="listitem"]',
];

/**
 * 会话行里各字段 —— 买家名是**实测**的（chat.chatroom.conversation_card_username）；
 * 其余几项实机构成是「角标数字 + 买家名 + 状态词(未回复) + 摘要 + 客户类型」，没有各自
 * 独立的 testid，所以摘要/时间/未读一律退回整行文本解析（见下面的解析逻辑）。
 */
export const ROW_FIELD_SELECTORS = Object.freeze({
  buyer: ['[data-testid="chat.chatroom.conversation_card_username"]', '[class*="username"]', 'strong'],
  snippet: [],
  date: [],
  unread: [],
});

/** 未读/待回复标记的判定：列表行文本里出现「未回复 / 未读」就算待回复（实测文案）。 */
export const UNREAD_CLASS_RE = /未回复|未读|unread|badge|dot|pending/i;

/**
 * 会话正文容器 —— 实机没有独立容器节点（消息直接落在 chatd-scrollView-content 里），
 * 所以这里锚定**滚动视图**本身；取不到就退回整个消息区。
 */
export const THREAD_SELECTORS = [
  '[class*="chatd-scrollView-content"]',
  '[class*="scrollView-content"]',
  '[class*="message-detail"]',
  'main section',
];
/** 主选择器（= 兜底数组第一个）。 */
export const THREAD_SELECTOR = THREAD_SELECTORS[0];

/**
 * 会话里的单条消息 —— **实测** via [data-testid="chat.chatroom.message_card"]（实机 21 条）。
 *
 * ⚠️ 与 amazon.js 的差别：那边 `.case-message-view` 是「先出空壳、消息后到」。TikTok 这边
 * 同样要防这个，所以取更保守的判据：等不到消息时**重读**而不是直接下结论
 * （见 extractThread 的 attempts 逻辑），一直读不到就如实返回空 messages。
 */
export const MESSAGE_SELECTORS = [
  '[data-testid="chat.chatroom.message_card"]',
  '[class*="message_card"]',
  '[class*="message-bubble"]',
];

/** 会话正文里各字段 —— 实测消息卡里没有独立字段节点，正文取整卡文本（见 THREAD_SCRIPT）。 */
export const THREAD_FIELD_SELECTORS = Object.freeze({
  buyer: ['[data-testid="chat.chatroom.conversation_card_username"]', '[class*="username"]'],
  body: [],
  date: [],
});

/**
 * 买家发来的消息（用来判断方向）—— **实测：没有可靠的 DOM 方向属性**。
 *
 * 实机上消息卡的 x 坐标完全一致（全部 x=488），类名差异也不稳定（试过靠父级类名判定，
 * 把买家消息误判成我方的比例很高）。唯一可靠的判据是**发送者前缀**：
 *   - 我方消息文本里带客服名（"Customer Service-RUI"）或店铺名（"FUSOU Furniture"）
 *   - 买家消息不带发送者前缀
 *   - 还有一类是系统消息（"会话被分配…" / "系统关闭聊天"），既不是买家也不是我方
 * 所以方向改由 THREAD_SCRIPT 里的 sentinel regex 判定，这里刻意留空数组 ——
 * 留空=不猜，而不是塞一个看起来能用的错选择器。
 */
export const INBOUND_SELECTORS = [];

/**
 * 「展开回复框」入口 —— 实测**不需要**：/chat 页的回复框是常驻展开的
 * （实机 textarea 直接可见）。保留空数组，fillOpenConversation 会跳过这一步。
 */
export const COMPOSER_OPEN_SELECTORS = [];
/** 主「展开回复框」选择器（实测为空 = 不需要展开）。 */
export const COMPOSER_OPEN_SELECTOR = '';

/**
 * 回复输入框 —— **实测** via textarea[data-testid="chat.chatroom.trans_chat_input"]
 * （placeholder「输入"/"快速调用快捷回复」）。实机是 textarea，不是 contenteditable。
 */
export const COMPOSER_INPUT_SELECTORS = [
  'textarea[data-testid="chat.chatroom.trans_chat_input"]',
  'textarea[class*="chat_input"]',
  'textarea[placeholder]',
  'div[contenteditable="true"][role="textbox"]',
];
/** 主回复输入框选择器。 */
export const COMPOSER_INPUT_SELECTOR = COMPOSER_INPUT_SELECTORS[0];

/**
 * ⛔ **绝不点击的按钮**：发送按钮。
 *
 * 这个常量唯一的作用是被测试 grep 到、并作为「我们知道它在哪、但永远不碰」的证据。
 * 实机选择器：button[data-testid="chat.chatroom.send_message_btn"]（文案「发送」）。
 * sendMessageBtnSelector() 存在的意义是让脚本可以**显式排除**它。
 * @returns {string} 发送按钮选择器。
 */
export function sendMessageBtnSelector() {
  return '[data-testid="chat.chatroom.send_message_btn"]';
}

/* ── 页面脚本 ─────────────────────────────────────────────────────────────── */

/**
 * 页面脚本里共用的工具函数源码。
 *
 * 三个脚本（列表 / 正文 / 点击）都要用同一套「按顺序试兜底选择器」的逻辑，
 * 所以作为源码片段注入，而不是三份各写一遍 —— 三份必然漂移。
 */
const PAGE_HELPERS = [
  "const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();",
  'const first = (root, sels) => {',
  '  for (const sel of sels) { try { const n = root.querySelector(sel); if (n) return n; } catch (e) {} }',
  '  return null;',
  '};',
  'const text = (root, sels) => { const n = first(root, sels); return n ? clean(n.innerText) : \'\'; };',
  // 我方消息的发送者前缀（**实测**）：客服名 "Customer Service-RUI" 或店铺名 "FUSOU Furniture"。
  'const OURS_RE = /Customer Service-|FUSOU Furniture|客服[:：]/i;',
  // 系统消息（既不是买家也不是我方）：会话被分配 / 系统关闭聊天。
  'const SYSTEM_RE = /会话被分配|系统关闭|已关闭聊天/;',
  // 把发送者前缀从正文里剥掉。
  'const OURS_PREFIX_RE = /^(?:Customer Service-[^ ]+|[A-Za-z0-9\\u4e00-\\u9fff& ]{2,40}\\s+(?:Furniture|Shop|Store))\\s*/;',
  // 时间前缀，如 "2026-10-8 15:55" / "昨天 23:40"。
  'const TIME_PREFIX_RE = /^(?:\\d{4}-\\d{1,2}-\\d{1,2}\\s+)?(?:\\d{1,2}:\\d{2}|昨天|前天)\\s*(?:\\d{1,2}:\\d{2})?\\s*/;',
].join('\n');

/**
 * 取会话列表的页面脚本。
 *
 * 返回（无论成败都是 JSON 字符串）：
 *   成功 { ok:true, url, title, rowSelector, count, items:[...] }
 *   失败 { ok:false, reason:'no-list-container'|'no-rows', url, title, tried:{...} }
 * 失败时带上 tried（每个位置试过哪些选择器），这是「未校准」阶段最值钱的信息。
 * @returns {string} 页面脚本。
 */
export const LIST_SCRIPT = `(() => {
  ${PAGE_HELPERS}
  const base = { url: location.href, title: clean(document.title) };
  const listEl = first(document, ${JSON.stringify(LIST_SELECTORS)});
  if (!listEl) {
    return JSON.stringify({ ok: false, reason: 'no-list-container', ...base,
      tried: { list: ${JSON.stringify(LIST_SELECTORS)} } });
  }
  const rowSels = ${JSON.stringify(ROW_SELECTORS)};
  let rowSelector = '';
  let nodes = [];
  for (const sel of rowSels) {
    try {
      const found = Array.from(listEl.querySelectorAll(sel));
      if (found.length) { rowSelector = sel; nodes = found; break; }
    } catch (e) {}
  }
  if (!nodes.length) {
    return JSON.stringify({ ok: false, reason: 'no-rows', ...base, tried: { row: rowSels } });
  }
  const fields = ${JSON.stringify(ROW_FIELD_SELECTORS)};
  const items = nodes.map((el, index) => {
    const unreadEl = first(el, fields.unread);
    return {
      index,
      buyer: text(el, fields.buyer),
      snippet: text(el, fields.snippet),
      date: text(el, fields.date),
      unread: unreadEl ? clean(unreadEl.className) : '',
      raw: clean(el.innerText),
    };
  });
  return JSON.stringify({ ok: true, ...base, rowSelector, count: items.length, items });
})()`;

/**
 * 取会话正文的页面脚本。
 *
 * 「哪条是买家发的」在未校准阶段没法只靠选择器判断，所以用两重判据，按可靠性排序：
 *   1. 消息元素命中 INBOUND_SELECTORS（带 data-direction / inbound 类名）→ 直接算买家发的；
 *   2. 否则看对齐：卖家自己的气泡靠右（margin-left:auto / align-self:flex-end / text-align:right）。
 * 都没有证据时**不做方向断言**：dir 一律给 'in'、dirGuess=true，由上层自己判断 ——
 * 在没校准的链路上编一个「这条是买家说的」比留空更危险。最后一条卖家没回时会被
 * 上层按「待回复」处理，这也正是巡逻要找的对象。
 * @returns {string} 页面脚本。
 */
export const THREAD_SCRIPT = `(() => {
  ${PAGE_HELPERS}
  const base = { url: location.href, title: clean(document.title) };
  const view = first(document, ${JSON.stringify(THREAD_SELECTORS)});
  if (!view) {
    return JSON.stringify({ ok: false, reason: 'no-thread-container', ...base,
      tried: { thread: ${JSON.stringify(THREAD_SELECTORS)} } });
  }
  const msgSels = ${JSON.stringify(MESSAGE_SELECTORS)};
  let messageSelector = '';
  let nodes = [];
  for (const sel of msgSels) {
    try {
      const found = Array.from(view.querySelectorAll(sel));
      if (found.length) { messageSelector = sel; nodes = found; break; }
    } catch (e) {}
  }
  const fields = ${JSON.stringify(THREAD_FIELD_SELECTORS)};
  const messages = nodes.map((el, index) => {
    const raw = clean(el.innerText);
    // 方向判定（**实测**）：消息卡的 x 坐标与类名都区分不出来（实机 21 条消息 x 全为 488），
    // 唯一可靠的是**发送者前缀**：我方消息带客服名或店铺名，买家消息不带。
    const ours = OURS_RE.test(raw);
    const sys = SYSTEM_RE.test(raw);
    return {
      index,
      dir: sys ? 'system' : ours ? 'out' : 'in',
      outbound: sys ? null : ours,
      dirGuess: false,
      date: '',
      // 消息卡文本形如「<时间> <发送者名?> <正文>」，把发送者名与时间前缀剥掉再当正文。
      body: clean(raw.replace(OURS_PREFIX_RE, '').replace(TIME_PREFIX_RE, '')),
    };
  });
  // 只把**买家发的**当作来信；系统消息（会话被分配 / 系统关闭聊天）两边都不算。
  const inbound = messages.filter((m) => m.dir === 'in');
  return JSON.stringify({
    ok: true, ...base, messageSelector, messages,
    buyer: text(view, fields.buyer),
    lastInbound: inbound.length ? inbound[inbound.length - 1] : null,
    messageCount: messages.length,
    dirSource: 'sender-prefix',
  });
})()`;

/**
 * 「先滚进可视区，再脚本点击」的页面脚本。
 *
 * 为什么不用紫鸟CLI 的 page click：2026-10-08 在真实亚马逊店铺上实测（Cozynome 店 10 条会话），
 * 它会把鼠标指令发出去、却**观察不到 DOM click 事件**，于是每一条都报 ELEMENT_NOT_INTERACTABLE；
 * 而同一时刻用 elementFromPoint 检查，那一行就在点上、pointer-events 是 auto、可见不透明 ——
 * 元素本身完全没问题，是那条链路不可靠。换成脚本里的 el.click()，同一条会话一次就打开了。
 * TikTok 没有理由更可靠，统一沿用这条经验。
 *
 * scrollIntoView 也不是装饰：消息列表是可滚动的，行落在可视区外时鼠标坐标根本不在页面上。
 *
 * **重要**：这个脚本只负责「点」，调用方只允许把「打开会话 / 展开回复框」这类导航性选择器传进来。
 * 这里刻意不提供「按文本找按钮」之类的便利函数，就是为了让「点到那个按钮」在结构上不可能发生。
 * @param {string[]|string} selectors - 一套兜底选择器（数组按顺序试）。
 * @returns {string} 页面脚本，返回 JSON 字符串。
 */
export function clickScript(selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  return `(() => {
  const sels = ${JSON.stringify(list)};
  let el = null;
  let used = '';
  for (const sel of sels) { try { const n = document.querySelector(sel); if (n) { el = n; used = sel; break; } } catch (e) {} }
  if (!el) return JSON.stringify({ ok: false, reason: 'missing', tried: sels });
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  el.click();
  return JSON.stringify({ ok: true, used });
})()`;
}

/**
 * 按**数组下标**点击第 N 个匹配元素。
 *
 * 存在的理由是一个实测踩到的坑：会话行是 <div>，用 `选择器 + ':nth-of-type(N)'` 定位时，
 * `:nth-of-type` 按同类型兄弟计数，而卡片之间夹着虚拟滚动占位/分隔元素，
 * 于是 nth-of-type(2) 经常不是第 2 行 —— 表现为「第 2 条会话不在列表里了」并被静默跳过。
 * 这里改成脚本内 querySelectorAll 后按 index 取，与 listConversations 产出的 index 同源。
 *
 * 同样只接受「行 / 展开回复框」这类导航性选择器；发送按钮永远不在调用方传入的集合里。
 * @param {string[]|string} selectors - 一套兜底选择器（数组按顺序试）。
 * @param {number} index - 0 基下标。
 * @returns {string} 页面脚本，返回 JSON 字符串。
 */
export function clickScriptByIndex(selectors, index) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const at = Math.max(0, Number.isFinite(index) ? Math.trunc(index) : 0);
  return `(() => {
  const sels = ${JSON.stringify(list)};
  const idx = ${at};
  let nodes = [];
  let used = '';
  for (const sel of sels) {
    try { const found = Array.from(document.querySelectorAll(sel)); if (found.length) { nodes = found; used = sel; break; } } catch (e) {}
  }
  if (!nodes.length) return JSON.stringify({ ok: false, reason: 'no-rows', tried: sels });
  if (idx >= nodes.length) {
    return JSON.stringify({ ok: false, reason: 'index-out-of-range', used, count: nodes.length, index: idx });
  }
  const el = nodes[idx];
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  el.click();
  return JSON.stringify({ ok: true, used, count: nodes.length, index: idx });
})()`;
}

/**
 * 把 CLI 返回的脚本结果规范成对象。
 * @param {any} value - `unwrapExec` 的结果。
 * @returns {any|null} 对象或 null。
 */
export function asObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 判断一个地址是不是 TikTok 的登录页。
 * @param {string} url - 地址。
 * @returns {boolean} 是否登录页。
 */
export function isTikTokLoginUrl(url) {
  return SIGNIN_URL_RE.test(String(url ?? ''));
}

/**
 * 判断一个紫鸟店铺是不是 TikTok Shop 店。
 *
 * 紫鸟的 platformName 实测形如 `TikTok Shop-全球跨境(自运营)(新)` /
 * `TikTok Shop-全球跨境(自运营)（旧）`（括号还有全/半角之分，所以**不能**拿括号当锚点）。
 * 跨语言部署时也可能只写 `tiktok`，两种都认，大小写不敏感。
 * @param {{platformName?: string}} store - 店铺。
 * @returns {boolean} 是否 TikTok Shop 店。
 */
export function isTikTokStore(store) {
  const name = String(store?.platformName ?? '');
  return /tiktok/i.test(name);
}

/**
 * 把会话 id 从 URL 里取出来。
 *
 * **未校准**：真实参数名待登录后用 devtools 核对，这里同时认几种常见写法。
 * 全都认不出来时返回空串 —— 空串会让入队时缺 conversationId，比取错一个值安全。
 * @param {string} url - 地址。
 * @returns {string} 会话 id，取不到返回空串。
 */
export function conversationIdFromUrl(url) {
  const raw = String(url ?? '');
  const patterns = [
    /[?&]conversation_id=([^&#]+)/i,
    /[?&]conversationId=([^&#]+)/i,
    /[?&]session_id=([^&#]+)/i,
    /[?&]cid=([^&#]+)/i,
  ];
  for (const re of patterns) {
    const match = re.exec(raw);
    if (!match) continue;
    try {
      return decodeURIComponent(match[1]);
    } catch {
      return match[1];
    }
  }
  return '';
}

/**
 * 解析「剩余 12 分钟」这类文案，换成分钟数。
 *
 * 与 amazon.js 的 parseDueText 同义：TikTok 客服有 24 小时首响这类时限，列表上也常挂倒计时。
 * 三种真实形态：`剩余时间：12 分钟` / `剩余 5 小时` / 英文 `Due in 2 hours`；
 * 超期文案（`已超时 3 小时`）返回负数。解析不出来返回 {minutes:null} ——
 * 巡逻据此排序时把未知的排到最后，而不是当成「无期限」。
 * @param {string} text - 文案。
 * @returns {{minutes: number|null, overdue: boolean}|null} 结果。
 */
export function parseDueText(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;
  const overdue = /超期|超时|逾期|overdue|expired/i.test(raw);
  const minutes = /(\d+)\s*分钟|(\d+)\s*min/i.exec(raw);
  if (minutes) {
    const value = Number.parseInt(minutes[1] ?? minutes[2], 10);
    return Number.isFinite(value) ? { minutes: overdue ? -value : value, overdue } : null;
  }
  const hours = /(\d+)\s*(?:小时|hour)/i.exec(raw);
  if (hours) {
    const value = Number.parseInt(hours[1], 10);
    return Number.isFinite(value) ? { minutes: (overdue ? -1 : 1) * value * 60, overdue } : null;
  }
  const days = /(\d+)\s*(?:天|day)/i.exec(raw);
  if (days) {
    const value = Number.parseInt(days[1], 10);
    return Number.isFinite(value) ? { minutes: (overdue ? -1 : 1) * value * 1440, overdue } : null;
  }
  return { minutes: null, overdue };
}

/**
 * 建一个 TikTok Shop 适配器。
 * @param {{ziniao: object, settings?: object, logger?: object}} options - 配置（settings 只用来读 cliEnabled.ziniao 这一个开关）。
 * @returns {object} 适配器。
 */
export function createTikTokAdapter(options) {
  const ziniao = options.ziniao;
  // 只用来读「紫鸟CLI 有没有在设置里被禁用」；无头与自动填入都不是可配项。
  const settings = options.settings ?? {};
  const logger = options.logger ?? { warn: () => {} };

  /** 简单等待。 */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 页面动作的统一超时。打开店铺可能触发内核下载，单独给更长的时间。 */
  const OPEN_TIMEOUT_MS = 240_000;
  const NAV_TIMEOUT_MS = 90_000;
  const PAGE_TIMEOUT_MS = 60_000;

  /**
   * 列出账号下**全部**店铺，不按平台过滤。
   *
   * 巡逻本身只用 TikTok 店，但「扫描可用店铺」这个动作必须看到全量：运营在紫鸟里新加了
   * 一个非 TikTok 店时，界面要能解释「它为什么没出现在可巡逻列表里」，而不是让人以为漏扫了。
   * @returns {Promise<Array<object>>} 店铺列表。
   */
  async function listAllStores() {
    const data = await ziniao.callOrThrow(['store', 'list'], { what: '取店铺列表', timeoutMs: PAGE_TIMEOUT_MS });
    return normalizeStoreList(data);
  }

  /**
   * 列出账号下所有 TikTok Shop 店铺（实测 6 家）。
   * @returns {Promise<Array<object>>} 店铺列表。
   */
  async function listStores() {
    // 停用店不巡逻（判定见 ziniao.js 的 isRetiredStore）。
    return (await listAllStores()).filter((store) => isTikTokStore(store) && !isRetiredStore(store));
  }

  /**
   * 打开店铺浏览器（已开则复用）。
   * @param {object} store - 店铺。
   * @returns {Promise<object>} 打开结果。
   */
  async function openStore(store) {
    // 刻意不传 --headless：回复要直接填进这个可见窗口给人核对，无头窗口填了也没人看得到。
    return ziniao.callOrThrow(['store', 'open', '--id', store.storeId], {
      what: `打开店铺 ${store.storeName}`,
      timeoutMs: OPEN_TIMEOUT_MS,
    });
  }

  /**
   * 关闭店铺浏览器。
   * @param {object} store - 店铺。
   * @returns {Promise<object|null>} 结果；失败只告警。
   */
  async function closeStore(store) {
    try {
      return await ziniao.callOrThrow(['store', 'close', '--id', store.storeId], {
        what: `关闭店铺 ${store.storeName}`,
        timeoutMs: 30_000,
      });
    } catch (cause) {
      logger.warn(`关闭店铺失败（忽略）：${cause instanceof Error ? cause.message : cause}`);
      return null;
    }
  }

  /**
   * 读当前页面地址。
   * @param {object} store - 店铺。
   * @returns {Promise<string>} 地址；读不到返回空串。
   */
  async function currentUrl(store) {
    const result = await ziniao.call(
      ['page', 'exec', '--store-id', store.storeId, '--script', 'location.href'],
      { timeoutMs: PAGE_TIMEOUT_MS },
    );
    if (!result.ok) return ''; // 读不到地址不算证据，交给后面的等待逻辑判断
    return String(unwrapExec(result.data) ?? '');
  }

  /**
   * 读当前页面标题（只读，不点任何东西）。
   *
   * 只用来把「人现在看到的那个页面」回显给运营，**不参与登录判定** ——
   * 判定唯一依据是地址（见 isTikTokLoggedInUrl 的注释）。读不到就返回空串。
   * @param {object} store - 店铺。
   * @returns {Promise<string>} 标题；读不到返回空串。
   */
  async function currentTitle(store) {
    const result = await ziniao.call(
      ['page', 'exec', '--store-id', store.storeId, '--script', 'document.title'],
      { timeoutMs: PAGE_TIMEOUT_MS },
    );
    if (!result.ok) return '';
    return String(unwrapExec(result.data) ?? '').trim();
  }

  /**
   * 确认真的进了商家中心，而不是被弹回登录页。
   *
   * 未登录时 TikTok 会把页面 302 到 /account/login（实测：两个入口都这样），
   * 页面上当然也长不出会话列表。不特判的话，巡逻只会报一句「消息中心没有加载出来」，
   * 运营得挨个店铺去猜是改版了还是没登录 —— 而实测这 6 家店**全部**是没登录。
   * @param {object} store - 店铺。
   * @returns {Promise<void>} 未登录时抛带 kind=auth 的错误。
   */
  async function assertSignedIn(store) {
    const url = await currentUrl(store);
    if (!isTikTokLoginUrl(url)) return;
    throw Object.assign(
      new Error('店铺未登录：TikTok Shop 把页面跳到了 /account/login，请先在紫鸟浏览器里登录该店铺后重跑'),
      {
        kind: 'auth',
        hint: '在紫鸟里打开该店铺并完成登录（TikTok Shop 商家中心），然后重新巡逻',
      },
    );
  }

  /**
   * 导航到客服消息中心。
   *
   * 入口路径 /chat **已实测**（登录后 IM 图标打开的就是 /chat，见文件头校准说明）。
   * 先走美国入口；那边有列表就直接返回；没列表再回退到跨境主入口试一次 ——
   * 同一家店在不同账号体系下会落在不同域名。两次都命中登录页，就由 assertSignedIn 抛 kind=auth。
   * @param {object} store - 店铺。
   * @returns {Promise<void>} 完成。
   */
  async function visitInbox(store) {
    const visit = (url) =>
      ziniao.callOrThrow(
        ['page', 'visit', '--store-id', store.storeId, '--url', url, '--wait-until', 'networkidle', '--timeout', String(NAV_TIMEOUT_MS)],
        { what: '导航到客服消息中心', timeoutMs: NAV_TIMEOUT_MS + 30_000 },
      );
    await visit(INBOX_URL);
    // 第一步就做登录判定：命中登录页立刻抛 kind=auth，别让后面的等待白等 20 秒。
    await assertSignedIn(store);
    if (await waitForInbox(store)) return;
    // 主入口上既没跳登录页、也没长出列表：可能域名不对，换美国入口再试一次。
    await visit(INBOX_BASE_US + INBOX_PATH);
    await assertSignedIn(store);
  }

  /**
   * 等会话列表出现（列表是异步渲染的，直接取值会拿到空骨架）。
   * @param {object} store - 店铺。
   * @returns {Promise<boolean>} 是否等到。
   */
  async function waitForInbox(store) {
    const result = await ziniao.call(
      ['page', 'wait-element', '--store-id', store.storeId, '--selector', LIST_SELECTOR, '--timeout', '20000'],
      { timeoutMs: 30_000 },
    );
    return result.ok;
  }

  /**
   * 取会话列表。
   *
   * 脚本自己会按兜底选择器逐个试，并区分两种失败：容器没找到（no-list-container，
   * 多半是改版或没进到消息中心）与容器在但没有行（no-rows，多半是行选择器变了）。
   * 两种都把 reason 与 tried 一起抛出去 —— 未校准阶段这比一句「解析失败」有用得多。
   * @param {object} store - 店铺。
   * @returns {Promise<{url: string, items: object[]}>} 列表。
   */
  async function extractList(store) {
    const result = await ziniao.callOrThrow(
      ['page', 'exec', '--store-id', store.storeId, '--script', LIST_SCRIPT],
      { what: '读取会话列表', timeoutMs: PAGE_TIMEOUT_MS },
    );
    const payload = asObject(unwrapExec(result));
    if (!payload || payload.ok !== true) {
      throw Object.assign(
        new Error(
          '会话列表读不出来（' + (payload?.reason ?? 'no-payload') + '）：TikTok 商家中心可能改版了，' +
            '或这条链路的兜底选择器全落空。试过：' + LIST_SELECTORS.join(' , '),
        ),
        { kind: 'page', reason: payload?.reason ?? 'no-payload' },
      );
    }
    if (!Array.isArray(payload.items)) {
      throw Object.assign(new Error('会话列表解析失败：页面脚本没有返回预期结构'), { kind: 'page' });
    }
    return { url: String(payload.url ?? ''), items: payload.items };
  }

  /**
   * 打开第 index 条会话。
   * @param {object} store - 店铺。
   * @param {number} index - 0 基下标。
   * @returns {Promise<void>} 完成。
   */
  async function openConversation(store, index) {
    // **不能用 `:nth-of-type(N)`** —— 实测踩到的坑：会话行是 <div>，而 `:nth-of-type` 是按
    // **同类型兄弟**计数的，行与行之间还夹着分隔/虚拟滚动占位元素，于是 nth-of-type(2)
    // 往往不是第 2 行，表现为「第 2 条会话不在列表里了」并把这条静默跳过。
    // 改成把选择器数组交给页面脚本，脚本内 querySelectorAll 后按**数组下标**取，
    // 与 listConversations 给出的 index 严格同源。
    const result = await ziniao.callOrThrow(
      ['page', 'exec', '--store-id', store.storeId, '--script', clickScriptByIndex(ROW_SELECTORS, index)],
      { what: `打开第 ${index + 1} 条会话`, timeoutMs: PAGE_TIMEOUT_MS },
    );
    // 行已经不在了（列表刷新过）时明确说清楚，而不是让它变成一句含糊的「点不动」。
    const clicked = asObject(unwrapExec(result));
    if (!clicked || clicked.ok !== true) {
      throw Object.assign(
        new Error(`第 ${index + 1} 条会话不在列表里了（列表可能已刷新，或行选择器已失效），跳过这一条`),
        { kind: 'page' },
      );
    }
    await ziniao.call(
      ['page', 'wait-element', '--store-id', store.storeId, '--selector', THREAD_SELECTOR, '--timeout', '15000'],
      { timeoutMs: 25_000 },
    );
    await ziniao.call(
      ['page', 'wait-element', '--store-id', store.storeId, '--selector', MESSAGE_SELECTORS[0], '--timeout', '15000'],
      { timeoutMs: 25_000 },
    );
  }

  /**
   * 取当前打开的会话正文。
   *
   * 「读到空会话」不直接当结论：容器可能是乐观渲染出来的空壳，消息体随后才到。
   * 这里重读几次，还是空就如实返回空 messages（上层据此决定是否要人工介入），
   * 而不是编一条消息出来。
   * @param {object} store - 店铺。
   * @param {{attempts?: number}} [opts] - 重读次数（默认 3）。
   * @returns {Promise<object>} 会话。
   */
  async function extractThread(store, opts = {}) {
    const attempts = Number.isFinite(opts.attempts) ? Math.max(1, opts.attempts) : 3;
    let payload = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await ziniao.callOrThrow(
        ['page', 'exec', '--store-id', store.storeId, '--script', THREAD_SCRIPT],
        { what: '读取会话正文', timeoutMs: PAGE_TIMEOUT_MS },
      );
      payload = asObject(unwrapExec(result));
      if (!payload || payload.ok !== true) {
        throw Object.assign(
          new Error(
            '会话正文读不出来（' + (payload?.reason ?? 'no-payload') + '）：会话可能没打开，' +
              '或 TikTok 页面改版导致兜底选择器全落空。试过：' + THREAD_SELECTORS.join(' , '),
          ),
          { kind: 'page', reason: payload?.reason ?? 'no-payload' },
        );
      }
      if (Array.isArray(payload.messages) && payload.messages.length > 0) return payload;
      if (attempt < attempts - 1) await sleep(1200);
    }
    return payload;
  }

  /**
   * 把草稿文本填进 TikTok 回复框 —— **只填不发送**。
   *
   * 这是人工点单条草稿才走的路：巡逻本身从不调用它（巡逻走 fillOpenConversation）。
   * 填完就返回，页面上留着一份未发送的文本，人工核对后自己点。
   *
   * 传入 caseId 时会用深链直接开原会话；没有 caseId 时**拒绝执行**，不去猜是哪个会话 ——
   * 填错会话比填不进去更糟。
   * @param {object} store - 店铺。
   * @param {string} text - 草稿文本。
   * @param {{caseId?: string}} [opts] - 选项。
   * @returns {Promise<{filled: boolean, length: number, url: string}>} 结果。
   */
  async function fillComposer(store, text, opts = {}) {
    const body = String(text ?? '');
    if (!body.trim()) throw new Error('草稿内容为空，拒绝填入回复框');
    const caseId = String(opts.caseId ?? '').trim();
    if (!caseId) {
      throw new Error('这条草稿没有会话 id（conversationId），无法定位到原会话；请在 TikTok Shop 页面上手动粘贴');
    }
    await openStore(store);
    // 本平台**没有**会话级深链（实测：点不同会话 URL 恒为 /chat/inbox/current）。
    // 所以这里退回「打开消息中心」，由人工在列表里点进目标会话后再粘贴 —— 与 lark-mail 同类。
    // 绝不能拿一个拼出来的链接去 visit：那会让人以为已经定位到原会话了。
    const url = conversationUrl(caseId) || INBOX_URL;
    await ziniao.callOrThrow(
      ['page', 'visit', '--store-id', store.storeId, '--url', url, '--wait-until', 'networkidle', '--timeout', String(NAV_TIMEOUT_MS)],
      { what: '打开 TikTok Shop 消息中心', timeoutMs: NAV_TIMEOUT_MS + 30_000 },
    );
    await assertSignedIn(store); // 导航同样可能被弹回登录页
    const ready = await waitForInbox(store);
    if (!ready) {
      throw Object.assign(
        new Error('消息中心没有加载出来：可能是店铺未登录，或列表选择器已失效'),
        { kind: 'page' },
      );
    }
    // 没有深链就没法自动定位到「原会话」。这里**不猜**：照常把文本填进当前打开的输入框
    // （人就在浏览器前可以核对），但把「没能自动定位」这件事明确回传，别让人以为定位过了。
    const result = await fillOpenConversation(store, body);
    return {
      ...result,
      url,
      located: false,
      locatedNote:
        'TikTok Shop 没有会话级深链，文本填进的是**当前打开**的会话；'
        + '填入前请确认列表里点开的就是草稿对应的那位买家。',
    };
  }

  /**
   * 把文本填进**当前已经打开**的会话的回复框 —— 只填不发送。
   *
   * 与 `fillComposer` 的区别是不做导航：巡逻读会话时人已经在那条会话上了，
   * 再跳一次深链纯属浪费（还多一次页面重载，容易把刚读到的状态弄丢）。
   *
   * 「展开回复框」这一步点不到**不算错误**：新式 IM 里回复框常常是本来就展开的，
   * 那种页面上根本没有那个按钮。判据永远是「输入框在不在」，而不是「按钮点没点到」。
   * @param {object} store - 店铺。
   * @param {string} text - 草稿文本。
   * @returns {Promise<{filled: boolean, length: number, inputSelector: string}>} 结果。
   */
  async function fillOpenConversation(store, text) {
    const body = String(text ?? '');
    if (!body.trim()) throw new Error('草稿内容为空，拒绝填入回复框');
    // 有就点一下、没有就算了：这个调用的失败不参与判定。
    await ziniao.call(
      ['page', 'exec', '--store-id', store.storeId, '--script', clickScript(COMPOSER_OPEN_SELECTORS)],
      { timeoutMs: PAGE_TIMEOUT_MS },
    );

    // 真正的判据是「输入框在不在」——逐个试兜底选择器，把命中的那一个记下来（校准要用）。
    let inputSelector = '';
    for (const sel of COMPOSER_INPUT_SELECTORS) {
      const ready = await ziniao.call(
        ['page', 'wait-element', '--store-id', store.storeId, '--selector', sel, '--timeout', '8000'],
        { timeoutMs: 15_000 },
      );
      if (ready.ok) {
        inputSelector = sel;
        break;
      }
    }
    if (!inputSelector) {
      throw Object.assign(
        new Error(
          '找不到回复输入框（试过的兜底选择器：' +
            COMPOSER_INPUT_SELECTORS.join(' , ') +
            '）。TikTok 商家中心的输入控件可能是 contenteditable 容器，也可能改版了',
        ),
        { kind: 'page', reason: 'no-input' },
      );
    }

    await ziniao.callOrThrow(
      ['page', 'input', '--store-id', store.storeId, '--selector', inputSelector, '--text', body, '--clear'],
      { what: '填入草稿', timeoutMs: PAGE_TIMEOUT_MS },
    );
    return { filled: true, length: body.length, inputSelector };
  }

  /* ── 登录态：「把浏览器开到登录页摆好，然后停下来等人」 ─────────────────────
   * 这一段里**没有**任何一次 click / input 落在登录表单上，也永远不会有。
   * 挑战类型两次实测都不一样（滑块 / 邮箱验证码），插件既预测不了也拿不到验证码。
   * ─────────────────────────────────────────────────────────────────────── */

  /**
   * 探测登录态 —— **不产生副作用**：不导航、不开店铺窗口。
   *
   * 判据只有一条：**当前页面地址**。页面已经停在 /account/login → login_required；
   * 停在商家中心域名 → logged_in。地址读不出来时不猜：既不说已登录、也不说未登录，
   * 而是报 failed —— 「读不到」和「没登录」要人做的事完全不同。
   * @param {object} store - 店铺。
   * @returns {Promise<{state: string, url: string, loggedIn: boolean, hint: string}>} 登录态。
   */
  async function checkLogin(store) {
    const url = await currentUrl(store);
    if (isTikTokLoginUrl(url)) {
      return {
        state: LOGIN_STATES.LOGIN_REQUIRED,
        url,
        loggedIn: false,
        hint: '页面停在 TikTok Shop 登录页，等人完成登录（滑块 / 邮箱验证码，插件不代劳）',
      };
    }
    if (!url) {
      return {
        state: LOGIN_STATES.FAILED,
        url: '',
        loggedIn: false,
        hint: '读不到页面地址：店铺窗口可能没打开，或紫鸟CLI 这一跳失败了（不是「未登录」）',
      };
    }
    return {
      state: LOGIN_STATES.LOGGED_IN,
      url,
      loggedIn: true,
      hint: '店铺已在登录态，可以直接巡逻或打开消息中心',
    };
  }

  /**
   * 打开登录页并**停下来等人** —— 这是「登录」按钮的全部职责。
   *
   * 打开店铺窗口 → 导航到客服消息中心：已登录就落在那里，未登录会被 302 到登录页。
   * 两条路都不点任何按钮、不填任何东西：登录挑战（滑块 / 邮箱验证码）只有人能做，
   * 验证码又发到人手上，插件根本拿不到。
   * @param {object} store - 店铺。
   * @returns {Promise<{state: string, url: string, title: string, hint: string}>} 结果；打不开店铺时 state=failed（带 error）。
   */
  async function openLogin(store) {
    let opened = null;
    try {
      opened = await openStore(store);
    } catch (cause) {
      return {
        state: LOGIN_STATES.FAILED,
        url: '',
        title: '',
        hint: `打不开店铺「${store?.storeName ?? store?.storeId ?? '?'}」：紫鸟那边这一步就失败了，先修这个再谈登录`,
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    try {
      await ziniao.callOrThrow(
        ['page', 'visit', '--store-id', store.storeId, '--url', INBOX_URL, '--wait-until', 'networkidle', '--timeout', String(NAV_TIMEOUT_MS)],
        { what: '打开 TikTok Shop 商家中心', timeoutMs: NAV_TIMEOUT_MS + 30_000 },
      );
    } catch (cause) {
      // 导航失败也在读一次地址 —— 有时页面其实已经加载出来了，只是 wait-until 没满足。
      const probe = await checkLogin(store).catch(() => null);
      if (probe && probe.state === LOGIN_STATES.LOGGED_IN) {
        return { ...probe, title: await currentTitle(store) };
      }
      return {
        state: LOGIN_STATES.FAILED,
        url: probe?.url ?? '',
        title: '',
        hint: '导航到商家中心失败：店铺窗口可能没起来，或网络不通（不是「未登录」）',
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    // 页面已经摆好：这里只**看一眼地址**，不点、不填、不碰验证码。
    const probe = await checkLogin(store);
    const title = await currentTitle(store);
    if (probe.state === LOGIN_STATES.LOGGED_IN) {
      return { ...probe, title, hint: '店铺已在登录态，页面停在商家中心' };
    }
    if (probe.state === LOGIN_STATES.LOGIN_REQUIRED) {
      return {
        ...probe,
        title,
        hint:
          '页面已停在 TikTok Shop 登录页，**请你本人完成登录**（账号密码 + 滑块或邮箱验证码），' +
          '登录完成后用「等待登录」等你；插件不代替人登录。',
      };
    }
    return {
      ...probe,
      title,
      hint: '导航已发出，但读不到地址：店铺窗口可能没打开（不是「未登录」）',
      opened,
    };
  }

  /**
   * 轮询等人在浏览器里把登录做完。
   *
   * 每次轮询都调 checkLogin（**同一套判据**，不另写一份），间隔默认 3 秒（下限也是 3 秒，
   * 传更小的值会被抬回来 —— 别把页面打爆），总超时默认 5 分钟（够人过完滑块或等邮箱验证码）。
   * 探测本身只有一次 page exec，**不点任何东西**：人在那边操作，这边只是看地址变没变。
   * @param {object} store - 店铺。
   * @param {{timeoutMs?: number, intervalMs?: number, sleep?: Function, now?: Function}} [opts] - 选项；
   *   sleep / now 是测试注入点（假时钟），生产里用真实计时。
   * @returns {Promise<{state: string, waitedMs: number, url: string, attempts: number, hint: string}>} 结果。
   */
  async function waitForLogin(store, opts = {}) {
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(0, opts.timeoutMs) : LOGIN_TIMEOUT_MS;
    const requested = Number.isFinite(opts.intervalMs) ? opts.intervalMs : LOGIN_POLL_INTERVAL_MS;
    // 间隔下限写死在代码里（而不是只写在注释里）：3 秒以下一律抬回来。
    const intervalMs = Math.max(LOGIN_POLL_MIN_INTERVAL_MS, requested);
    const sleepImpl = typeof opts.sleep === 'function' ? opts.sleep : sleep;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const startedAt = now();
    let attempts = 0;

    for (;;) {
      attempts += 1;
      const probe = await checkLogin(store);
      if (probe.state === LOGIN_STATES.LOGGED_IN) {
        return {
          state: LOGIN_STATES.LOGGED_IN,
          waitedMs: Math.max(0, now() - startedAt),
          url: probe.url,
          attempts,
          hint: '登录完成，页面已进入 TikTok Shop 商家中心',
        };
      }
      const elapsed = now() - startedAt;
      if (elapsed >= timeoutMs) {
        return {
          state: LOGIN_STATES.TIMEOUT,
          waitedMs: Math.max(0, elapsed),
          url: probe.url,
          attempts,
          hint:
            `等了 ${Math.round(Math.max(0, elapsed) / 1000)} 秒还没登录完成。` +
            '页面仍停在登录页的话，请再完成一次登录（滑块 / 邮箱验证码都可能），然后重新点「等待登录」。',
        };
      }
      // 最后一次等待只等剩下的时间，别多睡。
      await sleepImpl(Math.min(intervalMs, Math.max(0, timeoutMs - elapsed)));
    }
  }

  return {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'store',
    inboxUrl: INBOX_URL,
    conversationUrl,

    /**
     * 读取链路是否已在真实 DOM 上校准过。**true**。
     *
     * 2026-10-10 在真实店铺 **Tiktok-FUSOU-客服主号**（FUSOU Furniture，US 店，
     * shop_region=US）上完成校准：客服会话管理页 61 条会话、单会话 21 条消息，
     * 列表/正文/输入框三条链路都用真实 data-testid 跑通，并实测生成了草稿、默认填入回复框。
     */
    verified: true,
    /** 校准到什么程度、哪些仍未被覆盖 —— 说清楚，别让调用方以为「校准过」= 万无一失。 */
    calibrationNote:
      '读取链路已于 2026-10-10 在真实店铺（Tiktok-FUSOU-客服主号 / FUSOU Furniture，US 店）校准：' +
      '会话列表 [data-testid="chat.chatroom.conversation_list"]、会话行 ...conversation_card（实机 17 行）、' +
      '买家名 ...conversation_card_username、消息 ...message_card（实机 21 条）、' +
      '回复框 textarea[data-testid="chat.chatroom.trans_chat_input"] 全部实测命中。' +
      '消息方向改用「发送者前缀」判定（实机消息 x 坐标全为 488、类名不可靠，几何与类名都区分不出来）。' +
      '仍未被覆盖：① 只在一家店（US 店）上校准，跨境主站 seller.tiktokshopglobalselling.com 的 /chat 未验证；' +
      '② 「未回复 / 未读」筛选目前靠行文本判定，未用平台自身的筛选控件；' +
      '③ 发图/附件、快捷回复、转交等交互未涉及。' +
      '选择器仍保留多套兜底，全部落空时返回 ok:false 并带上 reason 与 tried。',

    /**
     * 本平台**没有**会话级深链（实测点击不同会话 URL 不变）。
     * 保持这个方法返回空串，界面据此隐藏「打开原会话」—— 比给一个指向收件箱首页的
     * 「看起来对」的链接安全。见 conversationUrl 的注释。 */
    hasConversationUrl: false,

    /**
     * 这个渠道是否启用：**渠道开关**（巡逻页那一行）与**紫鸟CLI 总开关**都要开着。
     * 两个条件分开判，是为了让 disabledHint 能说清到底是哪一个关着。
     */
    /** 本渠道自己的开关（巡逻页那一行画的它）—— 不含紫鸟CLI 总开关。 */
    channelEnabled() {
      return isChannelEnabled(settings, PLATFORM_ID);
    },
    enabled() {
      return isChannelEnabled(settings, PLATFORM_ID) && settings.cliEnabled?.ziniao !== false;
    },
    /** 未启用时给界面一句可照做的原因（渠道开关 / CLI 开关，两种文案不一样）。 */
    disabledHint() {
      if (!isChannelEnabled(settings, PLATFORM_ID)) {
        return '这个渠道被停用了：把巡逻页里「TikTok Shop」那一行的开关打开后才会巡逻 TikTok Shop 店铺。';
      }
      return '紫鸟CLI 已在「设置」里禁用：重新启用后才会巡逻 TikTok Shop 店铺。';
    },

    /* ── 巡逻面：巡逻引擎只认这几个方法，不认识上面那些 TikTok 专有动作 ── */

    /** 巡逻目标 = 店铺（对邮箱适配器来说就是邮箱地址）。 */
    listSources: listStores,

    /** 队列渠道与草稿模板族：让引擎不用认识任何平台。 */
    queueChannel: 'tiktok',
    draftKind: 'tiktok',

    /** 会话标识 = 会话 URL 里的 id（点开会话后才有）。 */
    conversationId: (thread) => conversationIdFromUrl(thread?.url ?? ''),

    /** 打开店铺并进到消息中心；没进到就抛错，引擎会记成这家店失败。 */
    async prepare(store) {
      await openStore(store);
      await visitInbox(store);
      const ready = await waitForInbox(store);
      if (!ready) {
        // 走到这里说明没被跳登录页、但列表也没出来：如实说「未校准 + 试过哪些」，
        // 别让运营以为是登录问题（登录问题已经在 assertSignedIn 里单独报过了）。
        throw Object.assign(
          new Error(
            '客服消息中心没有加载出来：入口路径 ' + INBOX_PATH + ' 未在真实店铺上校准，或该店铺未登录。' +
              '试过的列表选择器：' + LIST_SELECTORS.join(' , '),
          ),
          { kind: 'page', reason: 'no-list' },
        );
      }
    },

    /**
     * 列出需要回复的会话（读取便宜，一次调用）。
     * 顺手把「剩余时间」文案解析成分钟数 —— 引擎要用它排序，不该由引擎认识这套文案。
     */
    async listConversations(store) {
      const list = await extractList(store);
      return {
        ...list,
        items: list.items.map((item) => ({
          ...item,
          dueMinutes: parseDueText(item.snippet || item.raw || '')?.minutes ?? null,
        })),
      };
    },

    /** 打开并读完整段会话。 */
    async readConversation(store, item) {
      await openConversation(store, item.index);
      return extractThread(store);
    },

    closeSource: closeStore,

    /** 巡逻时自动填入回复框用：会话此刻已经打开，不再导航。 */
    fillOpenConversation,
    listAllStores,
    listStores,
    openStore,
    closeStore,
    visitInbox,
    waitForInbox,
    checkLogin,
    openLogin,
    waitForLogin,
    extractList,
    openConversation,
    extractThread,
    fillComposer,
    assertSignedIn,
  };
}
