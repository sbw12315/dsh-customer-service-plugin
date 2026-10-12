/**
 * 沃尔玛买家消息的草稿生成：把买家的站内消息判成意图，套进 **Walmart 口径**的话术模板。
 *
 * 【为什么不复用 lib/reply.js 的模板】
 * lib/reply.js 是**亚马逊口径**的，它的模板里写死了亚马逊特有路径：
 *   - 退货模板："the return label available in your Amazon account under Your Orders"
 *   - 发票模板："open Your Orders, select this order, and choose the invoice option"
 *   - 订单号   ：ORDER_RE = /\b(\d{3}-\d{7}-\d{7})\b/ —— 亚马逊 3-7-7
 * 沃尔玛的订单号是 15 位（实机 200015455387691 / 200015267917133 / 200015136249041），
 * 退货/订单入口也在 Walmart 账户里。直接复用会让客服照着**亚马逊的路径**去操作 ——
 * 那是真实事故，不是措辞问题。所以另起一族模板（与 reply-tiktok.js 同一个理由）。
 *
 * 【比亚马逊线更保守的一条口径】
 * 沃尔玛这条线里**退货/退款从来不是客服一个人能定的**：面单、承运商、退货仓、金额与到账
 * 都要人工核实（见 9/30 实机：买家连问三次退货面单，卖家三次答非所问）。所以这里的
 * refund / return 模板**只承接、不断言**：确认诉求、说明「正在核实」、承诺回到这个会话里给结论，
 * 绝不写「已为你办理」「X 个工作日到账」。亚马逊/TikTok 的模板敢写，是因为那是自家店铺的售后；
 * 沃尔玛这条线上先按最保守的写，人工核实完再改也不迟。
 *
 * 【复用什么】只 import 平台无关的部分（意图体系、意图判定、语言探测、地址抠取、摘要），
 * **不复制**。尤其是 INTENTS / classifyIntent：意图维度必须与其它渠道完全一致，否则统计页
 * 和队列页会按渠道裂成两套互不相认的意图，报表对不上。
 *
 * 【纯函数】零 I/O、零依赖、零 LLM，与 lib/reply.js 同风格，可单独断言。
 *
 * @module dsh-customer-service-plugin/lib/reply-walmart
 */

import {
  INTENT_LABEL,
  INTENTS,
  brandFromStoreName,
  classifyIntent,
  detectLanguage,
  extractAddress,
  hasCjk,
  summarizeThread,
} from './reply.js';

// 复用来的符号在本模块的对外契约里也要能用，故原样再导出（免得调用方为了一个符号 import 两个模块）。
export { INTENTS, INTENT_LABEL, classifyIntent, detectLanguage, hasCjk, summarizeThread };

/**
 * 在 lib/reply.js 的 brandFromStoreName 之上，修掉沃尔玛店铺名推出**错品牌**的问题。
 *
 * lib/reply.js 用 PLATFORM_TOKENS = /^(amazon|亚马逊|amzn|com)$/i 过滤平台词，**不含 walmart**。
 * 于是 brandFromStoreName('Walmart-Cozynome-管理员') 会把 'Walmart' 当成品牌，署名变成
 * 'Walmart Customer Service' —— 一个买家一眼就看出不对的署名（信是沃尔玛站内信里的卖家发的，
 * 不是沃尔玛官方发的，写 'Walmart' 会被当成平台口径）。
 *
 * 不修 lib/reply.js 本身：那是亚马逊线的文件，改了会动到既有测试。
 * 所以这里在**调用前**把店铺名里的沃尔玛平台词剔掉，再交给它处理。
 */
const WALMART_PLATFORM_TOKENS = new Set(['walmart', 'wal-mart', '沃尔玛', 'wm', 'walmart.com']);

/**
 * 剔除店铺名里沃尔玛平台词、并丢掉因此产生的空段。
 *
 * 逐段过滤而不是整串 replace：'Walmart-Cozynome-管理员' 剔掉 'Walmart' 后剩 'Cozynome'；
 * 而 'Walmart-Yanosaku二店-管理员' 剔掉后是 'Yanosaku二店'（地区/角色词由 brandFromStoreName 继续处理）。
 * @param {string} storeName - 紫鸟店铺名，形如 'Walmart-Cozynome-管理员'。
 * @returns {string} 剔掉平台词后的店铺名（仍交给 brandFromStoreName 做角色/地区过滤）。
 */
function stripWalmartPlatformTokens(storeName) {
  const raw = String(storeName ?? '').trim();
  if (!raw) return '';
  return raw
    .split(/[-_\s|/]+/)
    .filter((part) => part && !WALMART_PLATFORM_TOKENS.has(part.toLowerCase()))
    .join('-');
}

/**
 * 从沃尔玛店铺名推品牌（做掉平台词再交给公共实现）。
 * @param {string} storeName - 紫鸟店铺名。
 * @returns {string} 品牌名；推不出返回空串。
 */
export function brandFromWalmartStoreName(storeName) {
  return brandFromStoreName(stripWalmartPlatformTokens(storeName));
}

/**
 * 沃尔玛买家订单号的**最强形态**：15 位、20 开头。
 *
 * 实机三例全部落在这个形状里：200015455387691 / 200015267917133 / 200015136249041。
 */
const WALMART_ORDER_RE = /\b(20\d{13})\b/g;

/** 沃尔玛较早的订单号形态：13 位、20 开头（保住老订单不被漏掉）。 */
const WALMART_SHORT_ORDER_RE = /\b(20\d{11})\b/g;

/** 15 位裸数字串：**必须**左邻订单号标签才算数（沃尔玛的采购订单号形如 129126392363631）。 */
const WALMART_BARE_ORDER_RE = /\b(\d{15})\b/g;

/** 候选数字左侧出现这些标签时，才算「这是订单号」的**强**证据。 */
const CONTEXT_STRONG_RE =
  /(?:order\s*(?:id|number|no\.?|#)?|purchase\s*order|po\s*#?|订单号|订单编号|单号|采购订单)\s*[:：#]?\s*$/i;

/**
 * 只认高置信的沃尔玛订单号；**宁可认不出，也不认错**。
 *
 * 与 reply-tiktok.js 同一个取舍（那边写得更细）：认错的代价是**拼出一个错误订单号发给买家**，
 * 不可逆；认不出只是让草稿里少一个单号，人工 5 秒补上。
 *
 * 认的形态（按置信度排序）：
 *   1. 15 位、20 开头（实机三例）；
 *   2. 13 位、20 开头（沃尔玛较早形态）；
 *   3. 15 位裸数字，**且**紧邻左侧带 order / 订单号 这类标签（采购订单号就是这一种）。
 *
 * 明确**不认**的（test/reply-walmart.test.js 里有固定用例逐条钉住）：
 *   - 亚马逊 3-7-7（'113-9341386-0505001'）：分组形态不匹配；
 *   - TikTok 16-20 位裸串（'5771234567890123'）：位数不在 13/15，且没有 order 标签时一律不认；
 *   - 金额（'$1,234.56'）、日期时间戳（'20261010163000' 是 14 位）、追踪号、SKU。
 * @param {string} text - 要扫描的文本（通常是「主题 + 买家最后一条消息」）。
 * @returns {string} 订单号；取不到返回空串。
 */
export function extractWalmartOrderId(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';

  // 一、15 位、20 开头：实机形态，置信最高。
  WALMART_ORDER_RE.lastIndex = 0;
  const strong = WALMART_ORDER_RE.exec(raw);
  if (strong) return strong[1];

  // 二、13 位、20 开头：老订单形态。
  WALMART_SHORT_ORDER_RE.lastIndex = 0;
  const short = WALMART_SHORT_ORDER_RE.exec(raw);
  if (short) return short[1];

  // 三、15 位裸数字：必须自带 order 标签，否则与金额/时间戳/追踪号无法区分。
  WALMART_BARE_ORDER_RE.lastIndex = 0;
  let bare = WALMART_BARE_ORDER_RE.exec(raw);
  while (bare !== null) {
    if (CONTEXT_STRONG_RE.test(raw.slice(0, bare.index))) return bare[1];
    bare = WALMART_BARE_ORDER_RE.exec(raw);
  }

  return '';
}

/** 需要订单号才谈得下去的意图（与其它渠道保持一致的口径）。 */
const ORDER_SENSITIVE = new Set(['replacement', 'refund', 'shipping', 'return', 'cancel', 'invoice']);

/** 各意图的**开场白**（Walmart 口径的礼貌承接）。订单号由 buildWalmartDraft 拼在后面。 */
const OPENING = {
  replacement: 'Thank you for reaching out to us about your Walmart order',
  refund: 'Thank you for your message about your Walmart order',
  shipping: 'Thank you for letting us know your Walmart order has not arrived yet',
  return: 'Thank you for your message about returning your Walmart order',
  cancel: 'Thank you for your message about cancelling your Walmart order',
  invoice: 'Thank you for your message about your Walmart order',
  acknowledge: 'Thank you for your kind message - we are glad we could help',
  inquiry: 'Thank you for contacting us about your Walmart order',
};

/**
 * 各意图的**主体**。这里是与亚马逊模板差异最大的地方：
 * 退货入口指向 **Walmart 账户里的订单记录**，绝不写 'Amazon account' 或 'Your Orders'
 * （'Your Orders' 是亚马逊买家账户页的叫法，沃尔玛的对应入口在 Walmart 账户的订单历史里，
 * 两者不可互换 —— 指错买家就找不到按钮）。
 *
 * refund / return 一律只承接、不断言：见文件头的说明。
 */
const MIDDLE = {
  replacement: [
    'We are sorry about the trouble with your item. We can send you the damaged part free of charge as a replacement - this covers the part only, not the whole set.',
    'So that we send the right part, please reply here with a photo of the damaged part as it arrived.',
    'As soon as we have the photo, we will arrange the free replacement part and share the tracking details with you here. You do not need to return the item or pay anything, and please keep the item and its packaging until the part arrives.',
  ],
  refund: [
    'We have noted your refund request and we are checking the order details on our side.',
    'For Walmart orders a refund is normally returned to the original payment method. We will confirm here once it has been handled, so that you have the exact amount and timing in writing.',
  ],
  shipping: [
    'We have asked the carrier to look into the delivery of this parcel and will update you here as soon as we hear back.',
    'In the meantime, could you please confirm from the order details in your Walmart account that the delivery address on the order is complete and correct? An incomplete address is often what holds a delivery up.',
  ],
  return: [
    'We have your return request. The return options that apply to a Walmart order are shown in your Walmart account under your order history.',
    'We are also checking what we can do from our side, and we will come back to you here with the next step and the return instructions for this order.',
    'Please keep the item and its packaging as it arrived until we confirm the return details with you.',
  ],
  cancel: [
    'We have passed your request to our fulfilment team. If the order has not shipped yet, the cancellation goes through and the amount is released back to your original payment method.',
    'If it has already shipped, you are welcome to refuse the delivery or return it once it arrives, and we will help you from there.',
    'We will confirm the outcome here as soon as we hear back.',
  ],
  invoice: [
    'The order details for your Walmart order show what was paid, and you can save or print that page as your proof of purchase.',
    'If you need a separate invoice - for example one showing a company name and a tax number - just reply here with the details you need it to show, and we will prepare it for you.',
  ],
  acknowledge: [
    'If anything else comes up with your order, just reply here and we will take care of it.',
  ],
  inquiry: [
    'We would be glad to help. So that we can look into this properly, could you please share a little more detail about the issue - for example a photo of the item as it arrived?',
    'As soon as we have that, we will come back to you with a concrete next step.',
  ],
};

/** 各意图的收尾语（缺席即不写收尾）。 */
const CLOSING = {
  replacement: 'Thank you for your patience and understanding.',
  refund: 'Thank you for your patience.',
  shipping: 'Thank you for your patience.',
  return: 'Thank you for your patience.',
  invoice: 'Thank you for your patience.',
  inquiry: 'Thank you for your patience.',
};

/** 首字母大写，与 lib/reply.js 的处理保持一致（'jen' -> 'Jen'）。 */
function titleCase(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * 生成一份沃尔玛买家消息的回复草稿。
 *
 * @param {{buyer?: string, subject?: string, orderId?: string, inbound?: string, storeName?: string, country?: string}} input - 会话信息。
 *   inbound 是**买家最后一条消息**，是判意图的主判据；subject 是沃尔玛会话的系统主题，只当兜底。
 *   orderId 调用方已拿到真实订单号时直接传进来；没传才去提取。
 * @returns {{intent: string, intentLabel: string, intentSource: string, language: object, orderId: string, address: object, body: string, notes: string[], needsHuman: boolean, summary: string}} 草稿。
 */
export function buildWalmartDraft(input = {}) {
  const buyerRaw = String(input.buyer ?? '').trim();
  const buyer = titleCase(buyerRaw);
  const inbound = String(input.inbound ?? '');
  const subject = String(input.subject ?? '');

  // 调用方给的订单号优先；没有才去提取。提取是「认不出就给空串」，绝不猜。
  const orderId = String(input.orderId ?? '').trim() || extractWalmartOrderId(subject + ' ' + inbound);
  const brand = brandFromWalmartStoreName(input.storeName);
  const signature = brand ? brand + ' Customer Service' : 'Customer Service';

  const classification = classifyIntent(inbound, subject);
  const address = extractAddress(inbound);
  const language = detectLanguage(inbound);

  const greeting = buyer ? 'Hello ' + buyer + ',' : 'Hello,';
  const orderClause = orderId ? ' (order ' + orderId + ')' : '';
  const notes = [];

  const opening = (OPENING[classification.intent] ?? OPENING.inquiry) + orderClause + '.';

  // 一条消息里给了多个地址时，把候选全列出来让买家点一个 —— 替买家猜地址是事故。
  const multipleAddresses = address.count > 1;
  const addressBlock = address.hasAddress
    ? [
        multipleAddresses
          ? 'You mentioned more than one address in your message:'
          : 'The address we have from your message is:',
        '',
        ...address.items.map((item) => item.lines.join(String.fromCharCode(10))),
        '',
        multipleAddresses
          ? 'Please confirm which of these the replacement should be sent to, or send us the corrected address.'
          : 'Please confirm this is correct, or send us the corrected address.',
      ].join(String.fromCharCode(10))
    : '';

  const middle = MIDDLE[classification.intent] ?? MIDDLE.inquiry;

  const blocks = [greeting, opening, ...middle];
  if (addressBlock) blocks.push(addressBlock);
  if (CLOSING[classification.intent]) blocks.push(CLOSING[classification.intent]);
  blocks.push('Best regards,', signature);

  const body = blocks
    .filter((line) => String(line ?? '').trim() !== '')
    .join(String.fromCharCode(10, 10))
    .trim();

  // ---- notes：与其它渠道对齐的四类提示 + 沃尔玛特有的两类 ----
  if (classification.ambiguous) {
    notes.push('意图可能有歧义（同时命中 ' + classification.matched + '），请人工确认模板选得对不对');
  }
  if (classification.source === 'subject') {
    notes.push('正文里没有明确诉求，意图是按会话主题判的，发送前请再读一遍买家的话');
  }
  if (language.code !== 'en') {
    notes.push('买家语言可能是' + language.label + '，草稿是英文；如需按买家语言回复请人工调整');
  }
  // 致谢收尾这类寒暄不涉及具体订单，缺订单号不是问题，别制造无意义的「需人工」。
  if (!orderId && classification.intent !== 'acknowledge') {
    notes.push('没能从会话里解出订单号，发送前请补上');
  }
  // 订单号是「宁可不认」的：只有该意图确实要拿订单号办事时，才提示人工再核一眼。
  if (orderId && ORDER_SENSITIVE.has(classification.intent)) {
    notes.push('订单号是按格式识别出来的，发送前请与沃尔玛订单页核对一次，避免回复到别的订单上');
  }
  if (classification.intent === 'refund') {
    // 这封草稿说的是「正在核实、处理完在这个会话里确认」—— 它不承诺结果，但也绝不能
    // 变成「已经退了」。发送前必须有人去看后台这一单到底走到哪一步。
    notes.push('退款必须人工核实后再发：先确认这一单的实际状态（是否已受理/已退回/由沃尔玛侧处理），模板只承接不断言');
  }
  if (classification.intent === 'return') {
    // 9/30 实机就是因为退货面单反复答非所问才升级成纠纷，这条提示留在这条链路上最值钱。
    notes.push('退货/面单必须人工核实后再发：确认适用政策、承运商与退货仓，不要只重复问买家同一个问题');
  }
  if (classification.intent === 'invoice') {
    notes.push('模板里写了「订单详情页可作购买凭证」，发送前请确认沃尔玛当前版本的订单页确实能导出/打印');
  }

  const summary = [
    buyerRaw || '买家',
    INTENT_LABEL[classification.intent] ?? classification.intent,
    orderId || '无订单号',
    subject.slice(0, 60),
  ]
    .filter(Boolean)
    .join(' · ');

  return {
    intent: classification.intent,
    intentLabel: INTENT_LABEL[classification.intent] ?? classification.intent,
    intentSource: classification.source,
    language,
    orderId,
    address,
    body,
    notes,
    needsHuman: notes.length > 0,
    summary,
  };
}

/** 默认导出，方便 DRAFT_BUILDERS 里写成 walmart: buildWalmartDraft。 */
export default buildWalmartDraft;
