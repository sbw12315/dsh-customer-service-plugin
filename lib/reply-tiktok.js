/**
 * TikTok Shop 草稿生成：把买家的站内消息判成意图，套进 **TikTok 口径**的话术模板。
 *
 * 【为什么不复用 lib/reply.js 的模板】
 * lib/reply.js 是**亚马逊口径**的，它的模板里写死了亚马逊特有路径：
 *   - 退货模板："the return label available in your Amazon account under Your Orders"
 *   - 发票模板："open Your Orders, select this order, and choose the invoice option"
 *   - 订单号   ：ORDER_RE = /\b(\d{3}-\d{7}-\d{7})\b/ —— 亚马逊 3-7-7
 * TikTok Shop 的订单号不是这个形状，退货/发票入口也在 TikTok Shop 商家中心 / TikTok 订单页。
 * 直接复用会让客服照着**亚马逊的路径**去操作 —— 那是真实事故，不是措辞问题。所以另起一族模板。
 *
 * 【复用什么】只 import 平台无关的部分（意图体系、意图判定、语言探测、地址抠取、摘要），**不复制**。
 * 尤其是 INTENTS / classifyIntent：意图维度必须与亚马逊线完全一致，否则统计页和队列页
 * 会按渠道裂成两套互不相认的意图，报表对不上。
 *
 * 【纯函数】零 I/O、零依赖、零 LLM，与 lib/reply.js 同风格，可单独断言。
 *
 * @module dsh-customer-service-plugin/lib/reply-tiktok
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
 * 在 lib/reply.js 的 brandFromStoreName 之上，修掉 TikTok 店铺名推出**错品牌**的问题。
 *
 * lib/reply.js 用 PLATFORM_TOKENS = /^(amazon|亚马逊|amzn|com)$/i 过滤平台词，**不含 tiktok**。
 * 于是 brandFromStoreName('Tiktok-FUSOU-客服主号') 会把 'Tiktok' 当成品牌，署名变成
 * 'Tiktok Customer Service' —— 一个根本不存在的品牌，买家一眼就看出是群发模板。
 * 实测（本仓库当前 commit）：
 *   'Tiktok-FUSOU-客服主号'  -> 'Tiktok'   <- 错
 *   'TikTok-Shop-FUSOU-运营' -> 'TikTok'   <- 错
 *
 * 不修 lib/reply.js 本身：那是亚马逊线的文件，改了会动到 task 之外的既有测试。
 * 所以这里在**调用前**把店铺名里的 TikTok 平台词剔掉，再交给它处理。
 */
const TIKTOK_PLATFORM_TOKENS = new Set(['tiktok', 'tik', 'tok', 'tt', 'tiktop', '抖音', 'tk']);

/**
 * 剔除店铺名里 TikTok 平台词、并丢掉因此产生的空段。
 *
 * 逐段过滤而不是整串 replace：'TikTok-Shop-FUSOU-运营' 里的 'Shop' 是**平台侧**的词
 * （TikTok Shop 的 Shop），留着会被当品牌推成 'Shop'；而 'Shop' 若真的是品牌名，
 * 运营把店铺名写成 'TikTok-MyShop-客服' 即可 —— 少认一个品牌远比署名写错一个品牌便宜。
 * @param {string} storeName - 紫鸟店铺名，形如 'Tiktok-FUSOU-客服主号'。
 * @returns {string} 剔掉平台词后的店铺名（仍交给 brandFromStoreName 做角色/地区过滤）。
 */
function stripTikTokPlatformTokens(storeName) {
  const raw = String(storeName ?? '').trim();
  if (!raw) return '';
  return raw
    .split(/([-_/|])/)
    .filter((part, index) => {
      // 分隔符原样保留，只对词段做判断。
      if (index % 2 === 1) return true;
      const token = part.trim();
      if (!token) return false;
      if (TIKTOK_PLATFORM_TOKENS.has(token.toLowerCase())) return false;
      if (/^tiktok?shop$/i.test(token)) return false;
      // 只把**整段**等于 shop / shops 的当平台词；'MyShop' 这种含 shop 的品牌名不受影响。
      if (/^shops?$/i.test(token)) return false;
      return true;
    })
    .join('')
    .replace(/^[-_/|]+|[-_/|]+$/g, '')
    .trim();
}

/**
 * 从 TikTok Shop 店铺名推品牌名。
 *
 * 与 lib/reply.js 的 brandFromStoreName 同名同语义，区别只在于多过滤了一层 TikTok 平台词。
 * 推不出来时返回空串，模板会自动把署名退化成 'Customer Service'。
 * @param {string} storeName - 店铺名，形如 'Tiktok-FUSOU-客服主号'。
 * @returns {string} 品牌名，例如 'FUSOU'。
 */
export function brandFromTikTokStoreName(storeName) {
  return brandFromStoreName(stripTikTokPlatformTokens(storeName));
}

/**
 * TikTok Shop 订单号里的**分组形态**。
 *
 * TikTok 商家中心会把订单号按 4 位一组显示成 '5771 2345 6789 0123'（便于朗读），
 * 导出表格里也常见连字符写法。这些形态自带分组结构，且总位数落在 TikTok 订单号的区间内，
 * 与「16 位纯数字的金额 / 时间戳」在**形状上**就能区分开，属于高置信。
 */
const TIKTOK_GROUPED_ORDER_RE = /\b(\d{4}(?:[\s-]\d{4}){3,4})\b/g;

/** 裸的连续数字串候选。 */
const DIGIT_RUN_RE = /\d{6,}/g;

/** TikTok Shop 订单号的位数区间（实测常见 16-19 位，导出形态可见 20 位）。 */
const MIN_ORDER_DIGITS = 16;
const MAX_ORDER_DIGITS = 20;

/** 候选数字左侧出现这些标签时，才算「这是订单号」的**强**证据。 */
const CONTEXT_STRONG_RE = /(?:order\s*(?:id|number|no\.?|#)?|orderid|订单号|订单编号|单号)\s*[:：#]?\s*$/i;

/**
 * 只认高置信的 TikTok Shop 订单号；**宁可认不出，也不认错**。
 *
 * 纯数字长串极易误伤：金额（分位金额）、日期时间戳（20260110163000）、快递追踪号、SKU、
 * 批量导出的行号，全都长得一模一样。而认错的代价是**拼出一个错误订单号发给买家** ——
 * 买家回一句「这是我三个订单里哪一个」，运营才发现草稿里的单号根本不是这一单，信任已经掉了。
 * 所以这里的取舍是刻意不对称的：
 *   认不出 -> 返回 ''，并在 notes 里提示「发送前请补订单号」（人工 5 秒就能补，无损害）；
 *   认错了 -> 草稿带着错误单号出门（损害不可逆）。
 *
 * 认的形态（满足其一）：
 *   1. 带分组分隔符的 4-4-4-4(-4) 形态：'5771 2345 6789 0123'、'5771-2345-6789-0123-456'；
 *   2. 连续 16-20 位纯数字，**且**紧邻左侧带 order / 订单号 这类标签 —— 即自带上下文。
 *      裸的长数字串一律不认：没有上下文时，它和金额、时间戳无法区分。
 *
 * 明确**不认**的（test/reply-tiktok.test.js 里有固定用例逐条钉住）：
 *   - 亚马逊 3-7-7（'113-9341386-0505001'）：分组是 (3,7,7)，不匹配本平台规则；
 *   - 金额（'$1,234.56'、无标签的 '1234567890123456'）：16 位金额确实存在，无法与订单号区分；
 *   - 日期（'20260110'、'2026-01-10 16:30'）：位数不够，或被分组规则排掉；
 *   - 追踪号（'1Z999AA10123456784' 字母数字混杂；纯数字追踪号又没有 order 标签）；
 *   - SKU / 短码（'B0CXXRX9BR'）：非纯数字且位数不足。
 *
 * @param {string} text - 要扫描的文本（通常是「主题 + 买家最后一条消息」）。
 * @returns {string} 订单号（保留原始分隔符形态，便于人工逐位核对）；取不到返回空串。
 */
export function extractTikTokOrderId(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return '';

  // 一、带分组的形态：自带结构证据，置信最高，先取。
  TIKTOK_GROUPED_ORDER_RE.lastIndex = 0;
  let grouped = TIKTOK_GROUPED_ORDER_RE.exec(raw);
  while (grouped !== null) {
    const digits = grouped[1].replace(/\D/g, '');
    if (digits.length >= MIN_ORDER_DIGITS && digits.length <= MAX_ORDER_DIGITS) {
      return grouped[1].replace(/\s+/g, ' ').trim();
    }
    grouped = TIKTOK_GROUPED_ORDER_RE.exec(raw);
  }

  // 二、裸的纯数字长串：**必须**自带 order 标签才算数，否则一定是金额/时间戳/追踪号。
  DIGIT_RUN_RE.lastIndex = 0;
  let run = DIGIT_RUN_RE.exec(raw);
  while (run !== null) {
    const digits = run[0];
    if (digits.length >= MIN_ORDER_DIGITS && digits.length <= MAX_ORDER_DIGITS) {
      if (CONTEXT_STRONG_RE.test(raw.slice(0, run.index))) return digits;
    }
    run = DIGIT_RUN_RE.exec(raw);
  }

  return '';
}

/** 需要订单号才谈得下去的意图（与亚马逊线保持一致的口径）。 */
const ORDER_SENSITIVE = new Set(['replacement', 'refund', 'shipping', 'return', 'cancel', 'invoice']);

/**
 * 各意图的**开场白**（TikTok 口径的礼貌承接）。订单号由 buildTikTokDraft 拼在后面。
 */
const OPENING = {
  replacement: 'Thank you for reaching out to us about your TikTok Shop order',
  refund: 'Thank you for your message about your TikTok Shop order',
  shipping: 'Thank you for letting us know your TikTok Shop order has not arrived yet',
  return: 'Thank you for your message about returning your TikTok Shop order',
  cancel: 'Thank you for your message about cancelling your TikTok Shop order',
  invoice: 'Thank you for your message about your TikTok Shop order',
  acknowledge: 'Thank you for your kind message - we are glad we could help',
  inquiry: 'Thank you for contacting us about your TikTok Shop order',
};

/**
 * 各意图的**主体**。这里是与亚马逊模板差异最大的地方：
 * 退货/发票一律把入口指向 **TikTok Shop 的订单页**，
 * 绝不写 'Amazon account' 或 'Your Orders'（'Your Orders' 是亚马逊买家账户页的叫法，
 * TikTok Shop 的对应入口在 App / 网页的订单列表里，两者不可互换 —— 指错买家就找不到按钮）。
 */
const MIDDLE = {
  replacement: [
    'We are sorry about the trouble with your item. We can send you the damaged part free of charge as a replacement - this covers the part only, not the whole set.',
    'So that we send the right part, please reply here with a photo of the damaged part. If you have sent photos in the TikTok Shop order chat, just tell us and we will pick them up from there.',
    'As soon as we have the photo, we will arrange the free replacement part and share the tracking details with you here in this chat. You do not need to return the item or pay anything.',
  ],
  refund: [
    'We have looked into this for you. Refunds for TikTok Shop orders go back to your original payment method, and they normally appear within 3 to 5 business days after they are issued.',
    'If it has not appeared after that, please reply here and we will follow up on our side straight away.',
  ],
  shipping: [
    'We have asked the carrier to check the delivery status of the parcel and will update you here as soon as we hear back. If the parcel is confirmed lost, we will arrange a replacement or a full refund for you right away, whichever you prefer.',
    'In the meantime, could you please confirm from the order details in the TikTok Shop app that the delivery address on the order is correct and complete? An incomplete address is often what holds a delivery up.',
  ],
  return: [
    'We have your return request. You can start the return from the order in the TikTok Shop app or on the TikTok Shop website: open the order list, select this order, and follow the return option shown there - the return instructions and the return label are provided in that flow.',
    'Once the returned item reaches our warehouse, the refund is issued to your original payment method, usually within 3 to 5 business days.',
    'If anything about the return steps is unclear, just reply here and we will sort it out for you.',
  ],
  cancel: [
    'We have passed your request to our fulfilment team. If the order has not shipped yet, the cancellation will go through and the amount is released back to your original payment method.',
    'If it has already shipped, you are welcome to refuse the delivery or return it once it arrives, and we will refund you in full.',
    'We will confirm the outcome here as soon as we hear back.',
  ],
  invoice: [
    'For a TikTok Shop order, the order summary itself is your receipt: open the order list in the TikTok Shop app or on the TikTok Shop website and select this order - the order details page shows what was paid and can be saved or shared as your proof of purchase.',
    'If you need a separate document - for example an invoice showing your company name and tax number - just reply here with the details you need it to show, and we will prepare it and send it to you in this chat.',
  ],
  acknowledge: [
    'If anything else comes up with your order, just reply here and we will take care of it.',
  ],
  inquiry: [
    'We would be glad to help. So that we can look into this properly, could you please share a little more detail about the issue - for example a photo of the item as it arrived?',
    'As soon as we have that, we will come back to you with a concrete solution.',
  ],
};

/** 各意图的收尾语（缺席即不写收尾）。 */
const CLOSING = {
  replacement: 'Thank you for your patience and understanding.',
  refund: 'Thank you for your patience.',
  shipping: 'Thank you for your patience.',
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
 * 生成一份 TikTok Shop 买家消息的回复草稿。
 *
 * @param {{buyer?: string, subject?: string, orderId?: string, inbound?: string, storeName?: string, country?: string}} input - 会话信息。
 *   `inbound` 是**买家最后一条消息**，是判意图的主判据；`subject` 是 TikTok 会话的系统主题，只当兜底。
 *   `orderId` 调用方已拿到真实订单号时直接传进来；没传才去提取（提取只认高置信形态，认不出就是空串）。
 * @returns {{intent: string, intentLabel: string, intentSource: string, language: object, orderId: string, address: object, body: string, notes: string[], needsHuman: boolean, summary: string}} 草稿。
 *   `intentSource` 是 `message` / `subject` / `none`，告诉复核的人这封草稿是依据什么判的意图。
 */
export function buildTikTokDraft(input = {}) {
  const buyerRaw = String(input.buyer ?? '').trim();
  const buyer = titleCase(buyerRaw);
  const inbound = String(input.inbound ?? '');
  const subject = String(input.subject ?? '');

  // 调用方给的订单号优先；没有才去提取。提取是「认不出就给空串」，绝不猜。
  const orderId = String(input.orderId ?? '').trim() || extractTikTokOrderId(subject + ' ' + inbound);
  const brand = brandFromTikTokStoreName(input.storeName);
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

  // ---- notes：与亚马逊线对齐的四类提示 ----
  if (classification.ambiguous) {
    notes.push('意图可能有歧义（同时命中 ' + classification.matched + '），请人工确认模板选得对不对');
  }
  if (classification.source === 'subject') {
    // TikTok 的系统主题（例如 'Return request'）描述的是**最初**的诉求；买家后来改口很常见，
    // 只看主题会生成一封跟买家刚说过的话相反的草稿。
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
    notes.push('订单号是按格式识别出来的，发送前请与订单页核对一次，避免回复到别的订单上');
  }
  if (classification.intent === 'refund') {
    // 模板是断言式的（「退款会退回原支付方式」）。模板不知道后台到底有没有真的退过，
    // 所以只要走退款模板就必须提示人工核一遍 —— 这是最容易发出去就出事的一句话。
    notes.push('模板里写了退款到账口径，发送前请确认这笔退款是否真的已经操作或承诺过');
  }
  if (classification.intent === 'return' || classification.intent === 'invoice') {
    // 这两条模板都在给买家指路（退货入口 / 订单详情当收据）。TikTok Shop 的入口文案随版本改，
    // 复核时顺手确认一眼，避免把买家指到一个已经不存在的按钮上。
    notes.push('模板里指了 TikTok Shop 的订单入口，发送前请确认当前 App 里这个入口的位置与叫法');
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

/** 默认导出，方便 DRAFT_BUILDERS 里写成 `tiktok: buildTikTokDraft`。 */
export default buildTikTokDraft;
