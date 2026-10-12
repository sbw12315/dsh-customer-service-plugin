/**
 * 沃尔玛（Walmart Seller Center）买家消息适配器。
 *
 * 把「打开店铺 → 进 Customer 收件箱 → 取会话 → 读会话正文 → 填草稿」这一串页面动作，
 * 收敛成一组方法，巡逻引擎只调这些方法，不认识任何 CSS 选择器。
 *
 * ── 校准状态：**已在真实 DOM 上校准**（2026-10-10） ────────────────────────────, * 校准现场：Walmart-Yanosaku二店-管理员（storeId 27470279549745），登录后进入, * https://seller.walmart.com/seller-communication/Customer，实机 **25 条会话**，, * 逐条读通列表 → 会话正文 → 回复框；另有 9/30 在 Walmart-Cozynome-管理员 上的首次验证。, *, *   ✅ 入口路径 /seller-communication/Customer（标题 Inbox | Walmart Seller Center）, *   ✅ 会话行 div.message.p-16（实机 25 条，可点击）, *   ✅ 会话正文栏 div.relative.h-full.flex.flex-col.justify-between.w-full（实机唯一）, *   ✅ 消息区 div.overflow-auto.flex-1.p-24.py-0，消息 = 其中的 div.my-16, *   ✅ 消息方向 = **投递状态**（我方消息的 meta 行多一个「Delivered」节点）, *   ✅ 回复框 = 回复区里的 textarea（**没有 placeholder 属性**，「在此处输入回复」是旁边的 label）, *   ✅ 未登录判据（URL）：入口 302 到 login.account.wal-mart.com/authorize?...&clientType=seller, *   ⛔ 会话级深链**实测不存在**：点开不同会话，地址恒为 /seller-communication/Customer?start=1, *, * 校准中撞出来的两个坑（都会造成真事故，各留了注释与测试）：, *   1. **裸 .message 是列表行的类名**（实机 25 个）。把它当「消息元素」的兜底，会把列表行当成, *      会话正文，生成一堆建立在错误内容上的草稿。所以消息选择器必须限定在消息区里。, *   2. **裸 textarea 会命中沃尔玛 Marty AI 助手的输入框**（页面上共 3 个 textarea：回复框、, *      插件用的 1x1 框、AI 助手框）。退回裸 textarea 就等于把客服草稿打进 AI 对话框。, *, * 尚未覆盖：列表容器本身是 CSR 哈希类名（脚本因此不强依赖容器，而是直接找行）；, * 系统通知类消息与买家消息目前都按「非我方」处理；附件、模板下拉、改单等交互未涉及。, * * ── 硬约束：本文件里不存在任何「发送」动作 ─────────────────────────────────────
 * 草稿先落进插件自己的草稿库，再填进**可见的**紫鸟浏览器窗口里的回复框，填完就停。
 * 发送按钮的文案在下面 SEND_BUTTON_TEXT 里，唯一的用途是被测试与侦察脚本用来证明
 * 「我们知道它在哪，但没有任何一次 click / input 落在它上面」。
 *
 * **无头模式已移除**：store open 永远不加 --headless —— 窗口不可见时把文本填进回复框
 * 没有任何意义，没人看得到，也没法核对。
 *
 * @module dsh-customer-service-plugin/lib/platforms/walmart
 */

import { isRetiredStore, normalizeStoreList, unwrapExec } from '../ziniao.js';
import { isChannelEnabled } from '../settings.js';

/** 平台标识（同时是 queue.channel 与草稿的 platform 字段）。 */
export const PLATFORM_ID = 'walmart';
/** 平台展示名。 */
export const PLATFORM_LABEL = '沃尔玛';

/** 卖家中心站点根。 */
export const SELLER_ORIGIN = 'https://seller.walmart.com';
/** Customer（顾客消息）收件箱路径 —— **实测**（2026-09-30）。 */
export const INBOX_PATH = '/seller-communication/Customer';
/** Customer 收件箱。 */
export const INBOX_URL = SELLER_ORIGIN + INBOX_PATH;
/** 卖家中心首页：登录入口的另一条路（未登录时同样会 302 到登录页）。 */
export const HOMEPAGE_URL = SELLER_ORIGIN + '/';
/** 登录后的页面标题（**实测 2026-09-30**）—— 只用于诊断回显，不参与登录判定。 */
export const INBOX_TITLE = 'Inbox | Walmart Seller Center';

/**
 * 登录页特征 —— **实测 2026-10-10**。
 *
 * 未登录时入口 302 到 login.account.wal-mart.com/authorize?...；同时认沃尔玛卖家中心
 * 自己域名下的 login / signin 路径，避免哪天改了跳转方式就判不出来。
 */
export const SIGNIN_URL_RE = /login\.account\.wal-mart\.com|seller\.walmart\.com\/[^?#]*\/(?:login|signin)/i;

/**
 * 判断一个地址是不是沃尔玛的登录页。
 * @param {string} url - 地址。
 * @returns {boolean} 是否登录页。
 */
export function isWalmartLoginUrl(url) {
  return SIGNIN_URL_RE.test(String(url ?? ''));
}

/**
 * 判断一个紫鸟店铺是不是沃尔玛店。
 *
 * 紫鸟的 platformName 实机是「沃尔玛-全球」；店铺名则形如 Walmart-Cozynome-管理员。
 * 所以 platformName 与 storeName 两处都认 —— 单看 platformName 会漏掉店铺名带 Walmart
 * 而平台名被写成别的形态的情况（运营手工建店时真实发生过）。
 * @param {{platformName?: string, storeName?: string}} store - 店铺。
 * @returns {boolean} 是否沃尔玛店。
 */
export function isWalmartStore(store) {
  const platform = String(store?.platformName ?? '');
  const name = String(store?.storeName ?? '');
  return /沃尔玛|walmart/i.test(platform) || /^walmart\b/i.test(name) || /沃尔玛/i.test(name);
}

/**
 * 会话级深链。
 *
 * **本平台没有已校准的会话级深链**：2026-09-30 的验证只记录了收件箱入口，没有记录
 * 「点开某条会话后地址栏是什么」。在拿到实测证据之前**恒返回空串** ——
 * 一个能点开、看着像对的错链接，比没有链接糟得多（与 tiktok.js 同款取舍）。
 * 保留这个导出是为了让 CASE_URL_BUILDERS 的分派保持统一。
 * @param {string} caseId - 会话 id（本平台用不上）。
 * @returns {string} 永远是空串。
 */
export function conversationUrl(caseId) {
  void caseId;
  return '';
}

/* ── 选择器：命中过的排第一位，其余是兜底候选 ───────────────────────────────
 * 校准现场：Walmart-Cozynome-管理员，2026-09-30，收件箱 4 条会话。
 * 未校准的位置用**宽泛但有边界**的候选（不写 div * 这种会匹配全页面的东西）——
 * 兜底候选的责任是「改版后还能撑一阵」，不是「蒙对就行」。
 */

/**
 * 会话列表容器候选。
 *
 * ⚠️ 这一层**没有可依赖的语义化容器**：2026-10-10 实机（Walmart-Yanosaku二店 #27470279549745，
 * 25 条会话）列表行的滚动父级是 div.overflow-auto.relative.Hiyc8 —— Hiyc8 是 CSS Modules 哈希，
 * 随构建变，不能写死。所以列表脚本**不强依赖容器**：先直接找行，找到就成；
 * 容器只作为 containerSelector 回显给校准用。
 */
export const LIST_SELECTORS = [
  '[class*="message-list"]',
  '[class*="messageList"]',
  '[data-testid*="message-list"]',
  '[class*="conversation-list"]',
  'main [role="list"]',
];

/**
 * 会话行 —— **实测**：div.message.p-16（2026-10-10 实机 25 条，可点击；9/30 那家店 4 条）。
 *
 * ⚠️ `.message` 这个类名在本平台**两处都用**：列表行是 `.message.p-16`。所以下面「消息元素」
 * 的兜底里**绝不能**放裸 `.message` —— 那会把 25 条列表行当成会话消息，生成一堆建立在
 * 错误正文上的草稿（2026-10-10 实机校准时就踩到了这个假命中）。
 */
export const ROW_SELECTORS = [
  '.message.p-16',
  '[class*="message-row"]',
  '[class*="messageRow"]',
  '[class*="message-item"]',
  '[role="row"]',
  '[role="listitem"]',
];

/**
 * 会话正文所在的那一栏 —— **实测**：div.relative.h-full.flex.flex-col.justify-between.w-full。
 *
 * 它是右侧会话栏的根，实机唯一命中 1 个；里面依次是 ① 头部（订单号 + 主题）
 * ② 可滚动的消息区 ③ 回复区。用的是 Tailwind 风格工具类（不是哈希），比 CSR 类名稳。
 */
export const THREAD_SELECTORS = [
  'div.relative.h-full.flex.flex-col.justify-between.w-full',
  '[class*="conversation-detail"]',
  'main section',
];

/**
 * 消息区容器 —— **实测**：div.overflow-auto.flex-1.p-24.py-0（实机唯一命中 1 个）。
 * 消息是它的直接子元素；里面还会夹一条 hr 分隔线（不算消息）。
 */
export const MESSAGE_CONTAINER_SELECTORS = [
  'div.overflow-auto.flex-1.p-24.py-0',
  '[class*="message-list"]',
];

/**
 * 会话里的单条消息 —— **实测**：消息区里带 .my-16 的直接子 div（实机 2 条；hr 不算）。
 *
 * 一条消息的内部结构（**两个方向完全一致**，只有 meta 行差一个投递状态节点）：
 *   div.my-16                                    一条消息
 *     div.mb-8.flex.justify-between.items-center   meta 行：发送者 + [投递状态] + 时间
 *     div > div.whitespace-pre-wrap                正文（pre-wrap，保留换行）
 *
 * ⛔ 不要退回裸 `.message`：那是**列表行**的类名（实机 25 个），会把列表当消息。
 */
export const MESSAGE_SELECTORS = [
  'div.overflow-auto.flex-1.p-24.py-0 > div.my-16',
  'div.overflow-auto.flex-1.p-24.py-0 > div',
];

/**
 * 方向判据：**靠投递状态，不靠几何、不靠类名**。
 *
 * 实机两条消息的 x 与宽度**完全一样**（x=737 / w=714，alignSelf 都是 auto），靠对齐判方向必然误判；
 * 类名两边也都是同一套哈希。唯一的结构差异是：**我方消息的 meta 行里多一个投递状态节点**
 * （实机文案「Delivered」），买家消息没有 —— 与 9/30 记录的「买卖双方消息 + 时间戳 + 投递状态」一致。
 *
 * 所以 INBOUND_SELECTORS 仍然留空（没有「买家消息」专用选择器），方向由 THREAD_SCRIPT 按
 * 「投递状态文案」+「meta 行多一个状态节点」双重证据判定；两者都没有时**不做断言**
 * （dir='in' + dirGuess=true），由上层自己判断。
 */
export const INBOUND_SELECTORS = [];

/** 投递状态文案（我方消息才有的标记）—— 方向判定的第一判据。 */
export const DELIVERY_STATUS_RE = /Delivered|已送达|已读|投递成功|送达/;

/**
 * 「展开回复框」入口 —— **实测不需要**：打开会话后回复区（选择消息模板 / 回复框 / 发送回复）
 * 就常驻在会话栏底部。保留空数组，fillOpenConversation 会跳过这一步（点不到不算错误）。
 */
export const COMPOSER_OPEN_SELECTORS = [];

/**
 * 回复输入框 —— **实测**：回复区里的那个 textarea。
 *
 * 两个坑（2026-10-10 实机踩到，都是真事故级的）：
 *   1. 回复框**没有 placeholder 属性**：页面上那句「在此处输入回复」是旁边的一个 <label>，
 *      所以 textarea[placeholder*="在此处输入回复"] 命中 0 —— 别再按 placeholder 找它；
 *   2. 页面上还有两个 textarea：一个 1x1 的浏览器插件框（#dxmCopyUrl），一个是沃尔玛
 *      Marty AI 助手的输入框（.chat-input-textarea，实机 0x0 隐藏）。
 *      **绝不能退回裸 'textarea'** —— 那会把客服草稿打进 AI 助手的对话框里。
 *      实机命中数：textarea 共 3 个，回复区里的只有 1 个。
 */
export const COMPOSER_INPUT_SELECTORS = [
  'div.relative.p-24.pt-8.flex.flex-col.gap-16 textarea',
  'div.relative.p-24.pt-8.flex.flex-col.gap-16 [contenteditable="true"]',
];
/** 主回复输入框选择器（= 候选数组第一位）。 */
export const COMPOSER_INPUT_SELECTOR = COMPOSER_INPUT_SELECTORS[0];

/**
 * ⛔ **绝不点击的按钮**：发送按钮。
 *
 * 9/30 实机看到的文案是「发送回复」，但当时**只取了文案、没有取 CSS 选择器**。
 * 所以这里只导出文案判据，**不编一个看起来能用的 CSS 选择器** —— 编出来的选择器没人用，
 * 却会让人误以为「发送按钮已经定位好了」。它存在的唯一目的，是被测试与侦察脚本用来
 * 证明本文件里没有任何一次 click / input 落在它上面。
 */
export const SEND_BUTTON_TEXT = '发送回复';
/** 发送按钮的文案判据（中英文两种站点的写法）。 */
export const SEND_BUTTON_LABEL_RE = /发送回复|send\s*reply/i;

/** 「选择消息模板」下拉（**实测存在**，本插件不使用 —— 记在这里是为了校准时能对上页面）。 */
export const TEMPLATE_PICKER_TEXT = '选择消息模板';

/* ── 登录态：「把浏览器开到登录页摆好，然后停下来等人」 ──────────────────────
 * 这一段里**没有**任何一次 click / input 落在登录表单上，也永远不会有。
 * 沃尔玛登录走 SSO（login.account.wal-mart.com），还可能带邮箱验证码 ——
 * 插件既预测不了也拿不到验证码，所以只负责把页面摆好。
 * ─────────────────────────────────────────────────────────────────────── */

/** 登录态枚举 —— 就这四个，别再造新的（与 tiktok.js 保持同一套）。 */
export const LOGIN_STATES = Object.freeze({
  /** 已是登录态（页面在卖家中心）。 */
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
/** waitForLogin 的最小轮询间隔（毫秒）：调用方传更小的一律抬到这个下限。 */
export const LOGIN_POLL_MIN_INTERVAL_MS = 3000;
/** waitForLogin 的默认总超时（毫秒）—— 5 分钟，够人过完 SSO 与验证码。 */
export const LOGIN_TIMEOUT_MS = 300000;

/* ── 自动登录：**只点按钮**，绝不代填账号密码、不碰验证码 ─────────────────────
 * 为什么要有它：沃尔玛登录页上，**紫鸟自己**已经把账号密码填好了（密码管理），2 步验证的
 * 动态码也由「紫鸟验证码服务」自动填入。也就是说人在这里要做的只剩「点一下登录 / 点一下继续」——
 * 而那恰好是插件可以代劳、且完全不接触凭据的那部分。
 *
 * 边界（写死在这里，并被测试逐条钉住）：
 *   1. 只点文案精确等于「登录 / Sign in / Log in」或「继续 / Continue / Verify」的按钮；
 *   2. **没有任何输入动作** —— 账号、密码、验证码一个都不填；
 *   3. 2 步验证页在**验证码为空时不点继续**（点了就是提交空码，白挨一次失败），
 *      只等紫鸟把码填进来；等不到就把结论如实报出去，交回人工。
 * ─────────────────────────────────────────────────────────────────────── */

/** 自动登录允许点击的按钮文案（按页面形态分两组）。 */
export const AUTO_LOGIN_LABELS = Object.freeze({
  form: ['登录', 'Sign in', 'Log in'],
  twofa: ['继续', 'Continue', 'Verify'],
});

/** 自动登录最多点几次（每次之间等 AUTO_LOGIN_TICK_MS）。 */
export const AUTO_LOGIN_ATTEMPTS = 12;
/** 自动登录每一步之间的等待（毫秒）—— 验证码只有几秒有效期，别等太久。 */
export const AUTO_LOGIN_TICK_MS = 1500;
/** 自动登录的总超时（毫秒）。 */
export const AUTO_LOGIN_TIMEOUT_MS = 60000;

/**
 * 自动登录的一步：判断当前是「登录表单」还是「2 步验证」，然后点对应的按钮。
 *
 * 返回 JSON：{ ok, kind, reason, clicked, codeFilled, buttons }。
 * reason=code-empty 表示「2 步验证页的验证码还空着」—— 调用方据此只等待、不点击。
 * @returns {string} 页面脚本。
 */
export function autoLoginStepScript() {
  return [
    '(() => {',
    "  const clean = (s) => String(s || '').replace(/\\s+/g, ' ').trim();",
    '  const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };',
    '  const labels = ' + JSON.stringify(AUTO_LOGIN_LABELS) + ';',
    '  const buttons = Array.from(document.querySelectorAll("button,[role=button],input[type=submit]")).filter(visible);',
    '  const text = clean(document.body.innerText);',
    '  const inputs = Array.from(document.querySelectorAll("input"));',
    '  const codeEl = inputs.find((el) => /one-time|otp|code|验证码|verification/i.test([el.name, el.id, el.autocomplete, el.getAttribute("aria-label"), el.getAttribute("placeholder")].join(" ")));',
    '  const twofa = /2\\s*步验证|两步验证|动态验证|two-?step|verification code/i.test(text) || Boolean(codeEl);',
    '  const kind = twofa ? "twofa" : "form";',
    '  const wants = kind === "twofa" ? labels.twofa : labels.form;',
    '  const target = buttons.find((el) => wants.includes(clean(el.innerText || el.value)));',
    '  const codeFilled = codeEl ? String(codeEl.value || "").length > 0 : false;',
    '  const info = { kind, codeFilled, buttons: buttons.map((b) => clean(b.innerText || b.value)).filter(Boolean).slice(0, 12) };',
    '  if (kind === "twofa" && !codeFilled) return JSON.stringify({ ok: false, reason: "code-empty", ...info });',
    '  if (!target) return JSON.stringify({ ok: false, reason: "no-target-button", ...info });',
    // 按钮文案要在点击**之前**读：点完 React 会重渲染，innerText 可能已经变空，
    // 那样审计日志里就只剩 clicked:"" —— 实机验证时正是这么踩到的。
    '  const label = clean(target.innerText || target.value);',
    '  target.click();',
    '  return JSON.stringify({ ok: true, clicked: label, ...info });',
    '})()',
  ].join('\n');
}

/**
 * ⛔ **登录表单相关选择器 —— 本文件除了这一处声明，任何地方都不许用。**
 *
 * 与 tiktok.js 同款：这个常量唯一的用途是被测试 grep 到，并作为「我们知道登录表单长什么样，
 * 但永远不碰」的证据。实机登录页文案：「电子邮件或用户 ID」「密码」「登录」。
 */
export const LOGIN_FORM_SELECTORS = Object.freeze([
  'input[type="password"]',
  'input[name="password"]',
  'input[name="email"]',
  'input[type="email"]',
  'input[autocomplete="one-time-code"]',
  'button[type="submit"]',
  '[class*="captcha"]',
  '[class*="slider"]',
]);

/* ── 页面脚本 ─────────────────────────────────────────────────────────────── */

/**
 * 页面脚本里共用的工具函数源码。
 *
 * 两个脚本（列表 / 正文）都要用同一套「按顺序试兜底选择器」的逻辑，所以作为源码片段注入，
 * 而不是两份各写一遍 —— 两份必然漂移。
 */
const PAGE_HELPERS = [
  "const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();",
  'const first = (root, sels) => {',
  '  for (const sel of sels) { try { const n = root.querySelector(sel); if (n) return n; } catch (e) {} }',
  '  return null;',
  '};',
  'const all = (root, sels) => {',
  '  for (const sel of sels) { try { const n = Array.from(root.querySelectorAll(sel)); if (n.length) return { sel, nodes: n }; } catch (e) {} }',
  '  return { sel: "", nodes: [] };',
  '};',
  'const lines = (s) => String(s || "").split(/\\n+/).map((x) => x.trim()).filter(Boolean);',
].join('\n');

/**
 * 取会话列表的页面脚本。
 *
 * 与 TikTok 那条的关键差别：**不强依赖容器**。9/30 只校准到行（.message.p-16），
 * 容器长什么样没有证据；要求「先找到容器再找行」会让一条没校准的位置决定整条链路的成败。
 * 所以这里先直接找行，找到就成；容器命中与否只作为 containerSelector 回显给校准用。
 *
 * 返回（无论成败都是 JSON 字符串）：
 *   成功 { ok:true, url, title, rowSelector, containerSelector, count, items:[...] }
 *   失败 { ok:false, reason:'no-rows', url, title, tried:{...} }
 * 失败时带上 tried —— 未校准阶段这是最值钱的信息。
 *
 * ⚠️ 这里用「数组 join」而不是模板字符串：脚本本身带大量反斜杠正则，模板字符串会让
 * 转义再多一层（要数两遍反斜杠）。数组写法的转义层数与最终脚本一致，实测更不容易写错。
 * @returns {string} 页面脚本。
 */
export const LIST_SCRIPT = [
  '(() => {',
  PAGE_HELPERS,
  '  const base = { url: location.href, title: clean(document.title) };',
  '  const rowSels = ' + JSON.stringify(ROW_SELECTORS) + ';',
  '  const listSels = ' + JSON.stringify(LIST_SELECTORS) + ';',
  '  const rowsFound = all(document, rowSels);',
  '  if (!rowsFound.nodes.length) {',
  '    return JSON.stringify({ ok: false, reason: "no-rows", ...base, tried: { row: rowSels, list: listSels } });',
  '  }',
  '  const container = first(document, listSels);',
  '  const containerSelector = container',
  '    ? (container.className ? "." + clean(container.className).split(" ").join(".") : container.tagName.toLowerCase())',
  '    : "";',
  // 列表行里抠订单号/日期：列表没有独立字段节点，只能退回文本解析（未校准，见文件头）。
  '  const ORDER15 = /\\b(20\\d{13})\\b/;',
  '  const ORDER13 = /\\b(20\\d{11})\\b/;',
  '  const DATE_RE = /(?:今天|昨天|前天|\\d{4}[/-]\\d{1,2}[/-]\\d{1,2}|\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|\\d{1,2}\\/\\d{1,2})/;',
  '  const pickDate = (parts) => { for (const p of parts) if (DATE_RE.test(p)) return p; return ""; };',
  '  const orderOf = (text) => { const a = ORDER15.exec(text); if (a) return a[1]; const b = ORDER13.exec(text); if (b) return b[1]; return ""; };',
  '  const items = rowsFound.nodes.map((el, index) => {',
  '    const raw = clean(el.innerText);',
  '    const parts = lines(el.innerText);',
  '    const link = el.querySelector("a[href]");',
  // 字段位置没有 DOM 证据，按「首行是买家 / 次行起是摘要」的保守解析给出，整行原文一起带上。
  '    return {',
  '      index,',
  '      buyer: parts.length ? parts[0] : "",',
  '      subject: parts.length > 1 ? parts[1] : "",',
  '      snippet: parts.slice(1).join(" "),',
  '      date: pickDate(parts),',
  '      due: "",',
  '      orderId: orderOf(raw),',
  '      unread: /未读|未回复|unread|new/i.test(clean(el.className) + " " + raw),',
  '      href: link ? link.getAttribute("href") || "" : "",',
  '      raw,',
  '    };',
  '  });',
  '  return JSON.stringify({ ok: true, ...base, rowSelector: rowsFound.sel, containerSelector, count: items.length, items });',
  '})()',
].join('\n');

/*
 * 取会话正文的页面脚本。**结构已在真实 DOM 上校准**（2026-10-10，实机 25 条会话）。
 *
 * 方向判定按可靠性排序，判据全部来自实机观察：
 *   1. INBOUND_SELECTORS（本平台为空：没有「买家消息」专用选择器）；
 *   2. 我方判据 = meta 行里带**投递状态**：文案命中（实机「Delivered」）或 meta 行多一个
 *      div.flex.gap-8.items-center 状态节点 —— 买家消息两者都没有；
 *   3. 两个证据都没有时**不做方向断言**：dir="in"、dirGuess=true，由上层自己判断。
 *
 * ⛔ 刻意**不看对齐/几何**：实机两条消息的 x 与宽度完全一样（x=737 / w=714，alignSelf 都是 auto），
 * 按对齐判方向必然把买家消息判成我方的。
 *
 * 同时把头部（订单号 + 主题）一起解出来当兜底：列表行里的主题可能被截断。
 * @returns {string} 页面脚本。
 */
export const THREAD_SCRIPT = [
  '(() => {',
  PAGE_HELPERS,
  '  const base = { url: location.href, title: clean(document.title) };',
  '  const threadSels = ' + JSON.stringify(THREAD_SELECTORS) + ';',
  '  const msgSels = ' + JSON.stringify(MESSAGE_SELECTORS) + ';',
  '  const pane = first(document, threadSels);',
  '  if (!pane) {',
  '    return JSON.stringify({ ok: false, reason: "no-thread-pane", ...base, tried: { thread: threadSels } });',
  '  }',
  '  const found = all(pane, msgSels);',
  '  if (!found.nodes.length) {',
  '    return JSON.stringify({ ok: false, reason: "no-messages", ...base, tried: { message: msgSels } });',
  '  }',
  '  const DELIVERY_RE = /Delivered|已送达|已读|投递成功|送达/;',
  '  const messages = found.nodes.map((el, index) => {',
  '    const meta = el.querySelector("div.mb-8") || el.firstElementChild;',
  '    const metaText = meta ? clean(meta.innerText) : "";',
  '    const senderEl = meta ? meta.querySelector("span") : null;',
  '    const bodyEl = el.querySelector("div.whitespace-pre-wrap") || el;',
  '    const byText = DELIVERY_RE.test(metaText);',
  '    const byNode = meta ? Boolean(meta.querySelector("div.flex.gap-8.items-center")) : false;',
  '    const out = byText || byNode;',
  '    const rightBox = meta ? meta.querySelector("div.flex.items-center.gap-16") : null;',
  '    const timeEl = rightBox ? rightBox.lastElementChild : null;',
  '    return {',
  '      index,',
  '      dir: out ? "out" : "in",',
  '      dirGuess: !byText && !byNode,',
  '      dirSource: byText ? "delivery-status-text" : byNode ? "delivery-status-node" : "fallback",',
  '      sender: senderEl ? clean(senderEl.innerText) : "",',
  '      date: timeEl ? clean(timeEl.innerText) : "",',
  '      body: String(bodyEl.innerText || "").trim(),',
  '    };',
  '  });',
  '  const inbound = messages.filter((m) => m.dir === "in");',
  '  const headerEl = first(pane, ["div.p-24.pb-0"]);',
  '  const headerText = headerEl ? clean(headerEl.innerText) : "";',
  '  const orderMatch = /订单号[:：]\\s*(\\d{6,})/.exec(headerText);',
  '  return JSON.stringify({',
  '    ok: true, ...base, messageSelector: found.sel, messages,',
  '    buyer: inbound.length ? inbound[0].sender : "",',
  '    subject: headerText.replace(/^订单号[:：]\\s*\\d+\\s*/, ""),',
  '    orderId: orderMatch ? orderMatch[1] : "",',
  '    lastInbound: inbound.length ? inbound[inbound.length - 1] : null,',
  '    messageCount: messages.length, dirSource: "delivery-status",',
  '  });',
  '})()',
].join('\n');

/**
 * 「先滚进可视区，再脚本点击」的页面脚本。
 *
 * 与 amazon.js / tiktok.js 同款经验：紫鸟CLI 的 page click 在真实店铺上「鼠标指令已发送、
 * DOM click 事件未观察到」，于是每一条都报 ELEMENT_NOT_INTERACTABLE；同一时刻
 * elementFromPoint 检查元素本身完全没问题。改用脚本里的 el.click() 一次就成。
 *
 * scrollIntoView 也不是装饰：会话列表是可滚动的，行落在可视区外时鼠标坐标根本不在页面上。
 *
 * **重要**：这个脚本只负责「点」，调用方只允许把「打开会话 / 展开回复框」这类导航性
 * 选择器传进来；发送按钮永远不在调用方传入的集合里 —— 它连 CSS 选择器都没有（见上）。
 * @param {string[]|string} selectors - 一套兜底选择器（数组按顺序试）。
 * @returns {string} 页面脚本，返回 JSON 字符串。
 */
export function clickScript(selectors) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  return [
    '(() => {',
    '  const sels = ' + JSON.stringify(list) + ';',
    '  let el = null;',
    '  let used = "";',
    '  for (const sel of sels) { try { const n = document.querySelector(sel); if (n) { el = n; used = sel; break; } } catch (e) {} }',
    '  if (!el) return JSON.stringify({ ok: false, reason: "missing", tried: sels });',
    '  el.scrollIntoView({ block: "center", inline: "nearest" });',
    '  el.click();',
    '  return JSON.stringify({ ok: true, used });',
    '})()',
  ].join('\n');
}

/**
 * 按**数组下标**点击第 N 个匹配元素。
 *
 * 不用「选择器 + :nth-of-type(N)」：nth-of-type 按**同类型兄弟**计数，而会话卡片之间
 * 常夹着分隔/虚拟滚动占位元素，于是 nth-of-type(2) 经常不是第 2 行 —— 表现为
 * 「第 2 条会话不在列表里了」并被静默跳过。这里改成脚本内 querySelectorAll 后按 index 取，
 * 与 listConversations 产出的 index 严格同源。
 * @param {string[]|string} selectors - 一套兜底选择器（数组按顺序试）。
 * @param {number} index - 0 基下标。
 * @returns {string} 页面脚本，返回 JSON 字符串。
 */
export function clickScriptByIndex(selectors, index) {
  const list = Array.isArray(selectors) ? selectors : [selectors];
  const at = Math.max(0, Number.isFinite(index) ? Math.trunc(index) : 0);
  return [
    '(() => {',
    '  const sels = ' + JSON.stringify(list) + ';',
    '  const idx = ' + at + ';',
    '  let nodes = [];',
    '  let used = "";',
    '  for (const sel of sels) {',
    '    try { const found = Array.from(document.querySelectorAll(sel)); if (found.length) { nodes = found; used = sel; break; } } catch (e) {}',
    '  }',
    '  if (!nodes.length) return JSON.stringify({ ok: false, reason: "no-rows", tried: sels });',
    '  if (idx >= nodes.length) return JSON.stringify({ ok: false, reason: "index-out-of-range", used, count: nodes.length, index: idx });',
    '  const el = nodes[idx];',
    '  el.scrollIntoView({ block: "center", inline: "nearest" });',
    '  el.click();',
    '  return JSON.stringify({ ok: true, used, count: nodes.length, index: idx });',
    '})()',
  ].join('\n');
}

/**
 * 把 CLI 返回的脚本结果规范成对象。
 * @param {any} value - unwrapExec 的结果。
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
 * 把会话 id 从 URL 里取出来。
 *
 * **未校准**：沃尔玛有没有会话级参数待登录后核对，这里同时认几种常见写法；
 * 全都认不出来时返回空串 —— 空串会让入队时缺 conversationId，比取错一个值安全。
 * @param {string} url - 地址。
 * @returns {string} 会话 id，取不到返回空串。
 */
export function conversationIdFromUrl(url) {
  const raw = String(url ?? '');
  const patterns = [
    /[?&]conversation_?id=([^&#]+)/i,
    /[?&]message_?id=([^&#]+)/i,
    /[?&]thread_?id=([^&#]+)/i,
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
 * 与 amazon.js / tiktok.js 的 parseDueText 同义：沃尔玛对顾客消息有首响时限
 * （官方介入的案件实机见到「48 小时内回复」），列表上也常挂倒计时。
 * 解析不出来返回 {minutes:null} —— 巡逻据此排序时把未知的排到最后，而不是当成「无期限」。
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
 * 建一个沃尔玛适配器。
 * @param {{ziniao: object, settings?: object, logger?: object}} options - 配置（settings 只用来读 cliEnabled.ziniao 这一个开关）。
 * @returns {object} 适配器。
 */
export function createWalmartAdapter(options) {
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
   * 巡逻本身只用沃尔玛店，但「扫描可用店铺」这个动作必须看到全量：运营在紫鸟里新加了
   * 一个别的平台店铺时，界面要能解释「它为什么没出现在可巡逻列表里」，而不是让人以为漏扫了。
   * @returns {Promise<Array<object>>} 店铺列表。
   */
  async function listAllStores() {
    const data = await ziniao.callOrThrow(['store', 'list'], { what: '取店铺列表', timeoutMs: PAGE_TIMEOUT_MS });
    return normalizeStoreList(data);
  }

  /**
   * 列出账号下所有沃尔玛店铺（实机 2 家：Walmart-Cozynome-管理员 / Walmart-Yanosaku二店-管理员）。
   * @returns {Promise<Array<object>>} 店铺列表。
   */
  async function listStores() {
    // 停用店不巡逻（实机 Walmart-Yanosaku-已停用 [27151809366886] 就是这种）。
    return (await listAllStores()).filter((store) => isWalmartStore(store) && !isRetiredStore(store));
  }

  /**
   * 打开店铺浏览器（已开则复用）。
   * @param {object} store - 店铺。
   * @returns {Promise<object>} 打开结果。
   */
  async function openStore(store) {
    // 刻意不传 --headless：回复要直接填进这个可见窗口给人核对，无头窗口填了也没人看得到。
    return ziniao.callOrThrow(['store', 'open', '--id', store.storeId], {
      what: '打开店铺 ' + store.storeName,
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
        what: '关闭店铺 ' + store.storeName,
        timeoutMs: 30_000,
      });
    } catch (cause) {
      logger.warn('关闭店铺失败（忽略）：' + (cause instanceof Error ? cause.message : cause));
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
    if (!result.ok) return ''; // 读不到地址不算证据，交给调用方判断
    return String(unwrapExec(result.data) ?? '');
  }

  /**
   * 读当前页面标题（只读，不点任何东西）。
   * 只用来把「人现在看到的那个页面」回显给运营，**不参与登录判定**（判定唯一依据是地址）。
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
   * 确认真的进了卖家中心，而不是被弹回登录页。
   *
   * 未登录时沃尔玛会把 Customer 收件箱 302 到 login.account.wal-mart.com（**实测 2026-10-10**，
   * 实机地址带 clientType=seller 与 redirectUri=https://seller.walmart.com/aurora/...）。
   * 不特判的话，巡逻只会报一句「收件箱没有加载出来」，运营得挨个店铺去猜是改版了还是没登录。
   * @param {object} store - 店铺。
   * @returns {Promise<void>} 未登录时抛带 kind=auth 的错误。
   */
  async function assertSignedIn(store) {
    const url = await currentUrl(store);
    if (!isWalmartLoginUrl(url)) return;
    throw Object.assign(
      new Error('店铺未登录：沃尔玛把页面跳到了登录页（login.account.wal-mart.com），请先在紫鸟浏览器里登录该店铺后重跑'),
      {
        kind: 'auth',
        hint: '在紫鸟里打开该店铺并完成登录（沃尔玛卖家中心 SSO），然后重新巡逻',
      },
    );
  }

  /**
   * 导航到 Customer 收件箱。
   *
   * 入口路径 /seller-communication/Customer **已实测**（2026-09-30，Walmart-Cozynome-管理员），
   * 打开后页面标题是 Inbox | Walmart Seller Center。
   * @param {object} store - 店铺。
   * @returns {Promise<void>} 完成。
   */
  async function visitInbox(store) {
    await ziniao.callOrThrow(
      ['page', 'visit', '--store-id', store.storeId, '--url', INBOX_URL, '--wait-until', 'networkidle', '--timeout', String(NAV_TIMEOUT_MS)],
      { what: '导航到沃尔玛 Customer 收件箱', timeoutMs: NAV_TIMEOUT_MS + 30_000 },
    );
    // 导航完立刻做登录判定：命中登录页马上抛 kind=auth，别让后面的等待白等。
    await assertSignedIn(store);
  }

  /**
   * 等会话列表出现（列表是异步渲染的，直接取值会拿到空骨架）。
   *
   * 容器没有实测证据，所以这里等的是**行**（实测过的 .message.p-16）——
   * 等一个已知存在的元素，比等一个猜出来的容器可靠。
   * @param {object} store - 店铺。
   * @returns {Promise<boolean>} 是否等到。
   */
  async function waitForInbox(store) {
    for (const sel of ROW_SELECTORS) {
      const result = await ziniao.call(
        ['page', 'wait-element', '--store-id', store.storeId, '--selector', sel, '--timeout', '8000'],
        { timeoutMs: 15_000 },
      );
      if (result.ok) return true;
    }
    return false;
  }

  /**
   * 取会话列表。
   *
   * 脚本自己会按兜底选择器逐个试，并区分两种失败：一条行都没找到（no-rows，多半是改版、
   * 没进到收件箱、或行选择器变了）。失败时把 reason 与 tried 一起抛出去 ——
   * 未校准阶段这比一句「解析失败」有用得多。
   * @param {object} store - 店铺。
   * @returns {Promise<{url: string, items: object[], rowSelector: string, containerSelector: string}>} 列表。
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
          '会话列表读不出来（' + (payload?.reason ?? 'no-payload') + '）：可能是店铺未登录，或沃尔玛 Customer 收件箱改版。' +
            '试过的行选择器：' + ROW_SELECTORS.join(' , '),
        ),
        { kind: 'page', reason: payload?.reason ?? 'no-payload' },
      );
    }
    if (!Array.isArray(payload.items)) {
      throw Object.assign(new Error('会话列表解析失败：页面脚本没有返回预期结构'), { kind: 'page' });
    }
    return {
      url: String(payload.url ?? ''),
      items: payload.items,
      rowSelector: String(payload.rowSelector ?? ''),
      containerSelector: String(payload.containerSelector ?? ''),
    };
  }

  /**
   * 打开第 index 条会话。
   *
   * 点击用脚本内的 el.click()（见 clickScript 的注释）；打开后用 wait-element 等正文容器，
   * 等不到**不算失败** —— 正文容器本来就没校准，真正的判据是 extractThread 能不能读到消息。
   * @param {object} store - 店铺。
   * @param {number} index - 0 基下标。
   * @returns {Promise<void>} 完成。
   */
  async function openConversation(store, index) {
    const result = await ziniao.callOrThrow(
      ['page', 'exec', '--store-id', store.storeId, '--script', clickScriptByIndex(ROW_SELECTORS, index)],
      { what: '打开第 ' + (index + 1) + ' 条会话', timeoutMs: PAGE_TIMEOUT_MS },
    );
    const clicked = asObject(unwrapExec(result));
    if (!clicked || clicked.ok !== true) {
      throw Object.assign(
        new Error('第 ' + (index + 1) + ' 条会话不在列表里了（列表可能已刷新，或行选择器已失效），跳过这一条'),
        { kind: 'page' },
      );
    }
    await ziniao.call(
      ['page', 'wait-element', '--store-id', store.storeId, '--selector', MESSAGE_SELECTORS[0], '--timeout', '10000'],
      { timeoutMs: 20_000 },
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
              '或沃尔玛页面改版导致兜底选择器全落空。试过的消息选择器：' + MESSAGE_SELECTORS.join(' , '),
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
   * 把草稿文本填进沃尔玛回复框 —— **只填不发送**。
   *
   * 这是人工点单条草稿才走的路：巡逻本身从不调用它（巡逻走 fillOpenConversation）。
   * 填完就返回，页面上留着一份未发送的文本，人工核对后自己点「发送回复」。
   *
   * 本平台没有已校准的会话级深链（conversationUrl 恒为空串），所以这里退回「打开收件箱」，
   * 由人工在列表里点进目标会话后再粘贴 —— **不猜**是哪个会话，并把「没能自动定位」
   * 明确回传（located:false），别让人以为定位过了。
   * @param {object} store - 店铺。
   * @param {string} text - 草稿文本。
   * @param {{caseId?: string}} [opts] - 选项。
   * @returns {Promise<{filled: boolean, length: number, url: string, located: boolean, locatedNote: string}>} 结果。
   */
  async function fillComposer(store, text, opts = {}) {
    const body = String(text ?? '');
    if (!body.trim()) throw new Error('草稿内容为空，拒绝填入回复框');
    const caseId = String(opts.caseId ?? '').trim();
    await openStore(store);
    const url = conversationUrl(caseId) || INBOX_URL;
    await ziniao.callOrThrow(
      ['page', 'visit', '--store-id', store.storeId, '--url', url, '--wait-until', 'networkidle', '--timeout', String(NAV_TIMEOUT_MS)],
      { what: '打开沃尔玛 Customer 收件箱', timeoutMs: NAV_TIMEOUT_MS + 30_000 },
    );
    await assertSignedIn(store); // 导航同样可能被弹回登录页
    const ready = await waitForInbox(store);
    if (!ready) {
      throw Object.assign(
        new Error('Customer 收件箱没有加载出来：可能是店铺未登录，或行选择器（' + ROW_SELECTORS.join(' , ') + '）已失效'),
        { kind: 'page' },
      );
    }
    const result = await fillOpenConversation(store, body);
    return {
      ...result,
      url,
      located: false,
      locatedNote:
        '沃尔玛这条链路还没有会话级深链，文本填进的是**当前打开**的会话；' +
        '填入前请确认列表里点开的就是草稿对应的那位买家。',
    };
  }

  /**
   * 把文本填进**当前已经打开**的会话的回复框 —— 只填不发送。
   *
   * 与 fillComposer 的区别是不做导航：巡逻读会话时人已经在那条会话上了，
   * 再跳一次收件箱纯属浪费（还多一次页面重载，容易把刚读到的状态弄丢）。
   *
   * 「展开回复框」这一步点不到**不算错误**：9/30 实测回复框是常驻展开的
   * （COMPOSER_OPEN_SELECTORS 为空数组）。判据永远是「输入框在不在」。
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
          '找不到回复输入框（试过的兜底选择器：' + COMPOSER_INPUT_SELECTORS.join(' , ') +
            '）。9/30 实测是 TEXTAREA + placeholder「在此处输入回复」，如果页面已改版请重新校准',
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

  /**
   * 探测登录态 —— **不产生副作用**：不导航、不开店铺窗口。
   *
   * 判据只有一条：**当前页面地址**。停在 login.account.wal-mart.com → login_required；
   * 停在卖家中心域名 → logged_in。地址读不出来时不猜：既不说已登录、也不说未登录，
   * 而是报 failed —— 「读不到」和「没登录」要人做的事完全不同。
   * @param {object} store - 店铺。
   * @returns {Promise<{state: string, url: string, loggedIn: boolean, hint: string}>} 登录态。
   */
  async function checkLogin(store) {
    const url = await currentUrl(store);
    if (isWalmartLoginUrl(url)) {
      return {
        state: LOGIN_STATES.LOGIN_REQUIRED,
        url,
        loggedIn: false,
        hint: '页面停在沃尔玛登录页（login.account.wal-mart.com），等人完成 SSO 登录（插件不代劳）',
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
      hint: '店铺已在登录态，可以直接巡逻或打开 Customer 收件箱',
    };
  }

  /**
   * 打开登录页并**停下来等人** —— 这是「登录」按钮的全部职责。
   *
   * 打开店铺窗口 → 导航到 Customer 收件箱：已登录就落在收件箱，未登录会被 302 到登录页。
   * 两条路都不点任何按钮、不填任何东西：沃尔玛登录走 SSO，还可能带邮箱验证码，
   * 插件既预测不了也拿不到。
   * @param {object} store - 店铺。
   * @returns {Promise<{state: string, url: string, title: string, hint: string}>} 结果；打不开店铺时 state=failed（带 error）。
   */
  async function openLogin(store) {
    try {
      await openStore(store);
    } catch (cause) {
      return {
        state: LOGIN_STATES.FAILED,
        url: '',
        title: '',
        hint: '打不开店铺「' + (store?.storeName ?? store?.storeId ?? '?') + '」：紫鸟那边这一步就失败了，先修这个再谈登录',
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    try {
      await ziniao.callOrThrow(
        ['page', 'visit', '--store-id', store.storeId, '--url', INBOX_URL, '--wait-until', 'networkidle', '--timeout', String(NAV_TIMEOUT_MS)],
        { what: '打开沃尔玛卖家中心', timeoutMs: NAV_TIMEOUT_MS + 30_000 },
      );
    } catch (cause) {
      // 导航失败也再读一次地址 —— 有时页面其实已经加载出来了，只是 wait-until 没满足。
      const probe = await checkLogin(store).catch(() => null);
      if (probe && probe.state === LOGIN_STATES.LOGGED_IN) {
        return { ...probe, title: await currentTitle(store) };
      }
      return {
        state: LOGIN_STATES.FAILED,
        url: probe?.url ?? '',
        title: '',
        hint: '导航到卖家中心失败：店铺窗口可能没起来，或网络不通（不是「未登录」）',
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    // 页面已经摆好：这里只**看一眼地址**，不点、不填、不碰验证码。
    const probe = await checkLogin(store);
    const title = await currentTitle(store);
    if (probe.state === LOGIN_STATES.LOGGED_IN) {
      return { ...probe, title, hint: '店铺已在登录态，页面停在卖家中心' };
    }
    if (probe.state === LOGIN_STATES.LOGIN_REQUIRED) {
      return {
        ...probe,
        title,
        hint:
          '页面已停在沃尔玛登录页，**请你本人完成登录**（账号密码 + SSO/邮箱验证码），' +
          '登录完成后用「等待登录」等你；插件不代替人登录。',
      };
    }
    return { ...probe, title, hint: probe.hint || '登录态未知，请检查店铺窗口' };
  }

  /**
   * 轮询等人在浏览器里把登录做完。
   *
   * 每次轮询都调 checkLogin（**同一套判据**，不另写一份），间隔默认 3 秒（下限也是 3 秒，
   * 传更小的会被抬回来 —— 别把页面打爆），总超时默认 5 分钟。探测本身只有一次 page exec，
   * **不点任何东西**：人在那边操作，这边只是看地址变没变。
   * @param {object} store - 店铺。
   * @param {{timeoutMs?: number, intervalMs?: number, sleep?: Function, now?: Function}} [opts] - 选项；sleep / now 是测试注入点。
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
          hint: '登录完成，页面已进入沃尔玛卖家中心',
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
            '等了 ' + Math.round(Math.max(0, elapsed) / 1000) + ' 秒还没登录完成。' +
            '页面仍停在登录页的话，请再完成一次登录（SSO / 邮箱验证码都可能），然后重新点「等待登录」。',
        };
      }
      // 最后一次等待只等剩下的时间，别多睡。
      await sleepImpl(Math.min(intervalMs, Math.max(0, timeoutMs - elapsed)));
    }
  }

  /**
   * 自动登录：**只点按钮**，绝不代填账号密码、不碰验证码（边界见文件头的自动登录段落）。
   *
   * 巡逻预检到「未登录」时会调它（见 lib/patrol.js）：进来先确认页面确实停在登录页，
   * 然后每 AUTO_LOGIN_TICK_MS 看一次页面 —— 是登录表单就点「登录」，是 2 步验证就等
   * 紫鸟把动态码填进来再点「继续」，点完看地址是否已离开登录页。
   *
   * 所有失败路径都**如实返回**（ok:false + hint），由巡逻决定要不要把这家店跳过去；
   * 这里永远不抛、也永远不把「点了按钮」说成「登录成功」——成功只认地址。
   * @param {object} store - 店铺。
   * @param {{attempts?: number, timeoutMs?: number, url?: string, sleep?: Function, now?: Function}} [opts] - 选项；sleep / now 是测试注入点。
   * @returns {Promise<{ok: boolean, attempts: number, url: string, steps: object[], hint: string}>} 结果。
   */
  async function autoLogin(store, opts = {}) {
    const attempts = Number.isFinite(opts.attempts) ? Math.max(1, opts.attempts) : AUTO_LOGIN_ATTEMPTS;
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(0, opts.timeoutMs) : AUTO_LOGIN_TIMEOUT_MS;
    const sleepImpl = typeof opts.sleep === 'function' ? opts.sleep : sleep;
    const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    const startedAt = now();
    const steps = [];

    let url = String(opts.url ?? '');
    if (!url) url = await currentUrl(store);
    if (url && !isWalmartLoginUrl(url)) {
      return { ok: true, attempts: 0, url, steps, hint: '当前不在登录页，无需自动登录' };
    }
    try {
      await openStore(store);
    } catch (cause) {
      logger.warn('自动登录前打开店铺失败（继续尝试）：' + (cause instanceof Error ? cause.message : cause));
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (now() - startedAt > timeoutMs) break;
      const result = await ziniao.call(
        ['page', 'exec', '--store-id', store.storeId, '--script', autoLoginStepScript()],
        { timeoutMs: PAGE_TIMEOUT_MS },
      );
      const payload = asObject(unwrapExec(result.data));
      steps.push({
        attempt: attempt + 1,
        kind: String(payload?.kind ?? ''),
        clicked: String(payload?.clicked ?? ''),
        reason: String(payload?.reason ?? (result.ok ? '' : 'exec-failed')),
      });
      // 点完（或页面还没渲染出按钮 / 验证码还空着）都等一拍再看地址。
      await sleepImpl(AUTO_LOGIN_TICK_MS);
      url = await currentUrl(store);
      if (url && !isWalmartLoginUrl(url)) {
        return { ok: true, attempts: attempt + 1, url, steps, hint: '自动登录成功：页面已进入沃尔玛卖家中心' };
      }
    }

    const last = steps[steps.length - 1] ?? {};
    return {
      ok: false,
      attempts: steps.length,
      url,
      steps,
      hint:
        last.reason === 'code-empty'
          ? '自动登录停在 2 步验证：动态验证码没有被自动填入（紫鸟「验证码服务」可能没为这家店配好），需要人工输入一次'
          : '自动登录没成功：账号密码可能没有被紫鸟填好。插件只点「登录 / 继续」，不代填账号密码、不碰验证码 —— 请在紫鸟窗口里人工确认一次',
    };
  }

  return {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'store',
    inboxUrl: INBOX_URL,
    conversationUrl,

    /**
     * 校准位：**已校准**（2026-10-10）。校准现场与尚未覆盖的部分都写在 calibrationNote 里，
     * 体检页的 channelCalibration 会原样显示 —— 免得「校准过」被读成「万无一失」。
     */
    verified: true,
    calibrationNote:
      '【已校准 2026-10-10 · Walmart-Yanosaku二店-管理员 #27470279549745】读取链路已在登录后的真实 DOM 上跑通：' +
      '实机 25 条会话、会话消息结构、方向判据（投递状态）、回复框全部取到。' +
      '尚未覆盖：列表容器是 CSR 哈希类名（脚本因此不强依赖容器）；会话级深链实测**不存在**' +
      '（点开不同会话地址恒为 /seller-communication/Customer?start=1）；附件、模板下拉、改单等交互未涉及。',

    /** 本平台**没有**已校准的会话级深链，界面据此隐藏「打开原会话」。 */
    hasConversationUrl: false,

    /**
     * 自动登录能力位：巡逻预检到「未登录」时会调用 autoLogin（见 lib/patrol.js）。
     * 这是本插件**唯一**会碰登录页的地方，边界是「只点登录/继续，不代填账号密码、不碰验证码」。
     */
    supportsAutoLogin: true,

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
        return '这个渠道被停用了：把巡逻页里「沃尔玛」那一行的开关打开后才会巡逻沃尔玛店铺。';
      }
      return '紫鸟CLI 已在「设置」里禁用：重新启用后才会巡逻沃尔玛店铺。';
    },

    /* ── 巡逻面：巡逻引擎只认这几个方法，不认识上面那些沃尔玛专有动作 ── */

    /** 巡逻目标 = 店铺。 */
    listSources: listStores,

    /** 队列渠道与草稿模板族：让引擎不用认识任何平台。 */
    queueChannel: 'walmart',
    draftKind: 'walmart',

    /** 会话标识 = 会话 URL 里的 id（点开会话后才有；本平台没有深链时为空串）。 */
    conversationId: (thread) => conversationIdFromUrl(thread?.url ?? ''),

    /** 打开店铺并进到 Customer 收件箱；没进到就抛错，引擎会记成这家店失败。 */
    async prepare(store) {
      await openStore(store);
      await visitInbox(store);
      const ready = await waitForInbox(store);
      if (!ready) {
        // 走到这里说明没被跳登录页、但列表也没出来：如实说「试过哪些选择器」，
        // 别让运营以为是登录问题（登录问题已经在 assertSignedIn 里单独报过了）。
        throw Object.assign(
          new Error(
            'Customer 收件箱没有加载出来：入口路径 ' + INBOX_PATH + ' 或行选择器未校准/已改版。' +
              '试过的行选择器：' + ROW_SELECTORS.join(' , '),
          ),
          { kind: 'page', reason: 'no-list' },
        );
      }
    },

    /**
     * 列出会话（读取便宜，一次调用）。
     * 顺手把「到期/剩余时间」文案解析成分钟数 —— 引擎要用它排序，不该由引擎认识这套文案。
     */
    async listConversations(store) {
      const list = await extractList(store);
      return {
        ...list,
        items: list.items.map((item) => ({
          ...item,
          dueMinutes: parseDueText(item.due || item.raw || '')?.minutes ?? null,
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
    autoLogin,
    waitForLogin,
    extractList,
    openConversation,
    extractThread,
    fillComposer,
    assertSignedIn,
  };
}
