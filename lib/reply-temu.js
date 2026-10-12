/**
 * TEMU 买家消息的草稿生成：把买家的会话判成意图，套进 **TEMU 口径**的话术模板。
 *
 * 【为什么不复用 lib/reply.js 的模板】
 * lib/reply.js 是**亚马逊口径**的：退货模板写死 "the return label available in your Amazon
 * account under Your Orders"，发票模板写死 "open Your Orders, select the invoice option"，
 * 订单号正则 ORDER_RE 认的是亚马逊 3-7-7。把它套到 TEMU 会话上，客服会照着**亚马逊的路径**
 * 去操作 —— 那是真实事故，不是措辞问题（与 reply-tiktok.js / reply-walmart.js /
 * reply-shein.js 同一个理由）。TEMU 的买家端入口叫「订单详情 / 联系商家」，
 * 卖家端叫「客服中心 → 消费者咨询」，都不是 "Your Orders"。
 *
 * 【这一版和 SHEIN 线一样保守：订单号一律不认】
 * TEMU 订单号 / PO 号的**形态尚未校准**（2026-10-12 的实测只拿到店铺列表与登录页，
 * 一条真实会话都没进得去）。所以这里**不写订单号正则**：
 *   1. 只有调用方（适配器读会话行时）明确给出 orderId 才用它；
 *   2. 认不出就留空 + 一条「发送前请补上」的提示。
 * 宁可少一个单号让人工补 5 秒，也不认错 —— 认错就是把别的订单的号发给买家，不可逆。
 *
 * 【模板口径：只承接、不断言】
 * 退款、退货、发票、补偿在 TEMU 这条线上都不是客服一个人能定的：半托管店铺的退款/退货
 * 要走「客服中心 → 售前/售后工单」按平台给出的处理结果操作，金额、时效、退货仓都由平台
 * 与仓库侧决定。所以模板里**不写**「已为你办理」「X 个工作日到账」「面单在订单页」，
 * 只确认诉求、说明正在核实、承诺回到这个会话里给结论，并强制挂人工核实提示。
 * 补偿金额、时效、退货地址一律留空给人填。
 *
 * 【TEMU 特有的一条时限】半托管的「消费者咨询（自接待模式）」要求商家 **24 小时内**响应，
 * 超时可能触发平台介入（Temu 官方商家接待课程）。这条不写进给买家的正文（正文里承诺时限
 * 就是给自己挖坑），而是写成 notes 里的一条内部提醒。
 *
 * 【复用什么】只 import 平台无关的部分（意图体系、意图判定、语言探测、地址抠取、摘要），
 * **不复制**：意图维度必须与其它渠道完全一致，否则统计页与队列页会按渠道裂成两套口径。
 *
 * 【纯函数】零 I/O、零依赖、零 LLM，可单独断言。
 *
 * @module dsh-customer-service-plugin/lib/reply-temu
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

// 复用来的符号在本模块的对外契约里也要能用，故原样再导出。
export { INTENTS, INTENT_LABEL, classifyIntent, detectLanguage, hasCjk, summarizeThread };

/**
 * 从店铺名里要剔掉的词：TEMU 平台词 + 区域词 + 经营模式词。
 *
 * 三类都是实测出来的（紫鸟 store list 里的 9 家 TEMU 店全看过）：
 *   1. 平台词：lib/reply.js 的 PLATFORM_TOKENS 只认 amazon/亚马逊/amzn/com，**不含 temu/拼多多**。
 *      不剔的话 brandFromStoreName('TEMU-COZYNOME-管理员') 会把 'TEMU' 当品牌，署名变成
 *      'TEMU Customer Service' —— 买家会以为这是平台官方客服，而不是卖家。
 *   2. 区域词：店名形如 'Temu-US-管理员' / 'Temu-HK-客服' / 'Temu-CN-管理员'。剔掉平台词后
 *      剩下 'US' / 'HK' / 'CN'，而 reply.js 的 REGION_TOKENS **不含 hk / cn**，于是署名会变成
 *      'HK Customer Service' —— 那不是品牌，只是一个站点代号。
 *   3. 模式词：'自运营 / 全托管 / 半托管' 是经营模式，同样不是品牌（与 SHEIN 线同款）。
 */
const TEMU_STORE_NOISE_TOKENS = new Set([
  // 平台词
  'temu',
  'temu.com',
  'kuajingmaihuo',
  'temu-us',
  'pdd',
  '拼多多',
  // 站点 / 区域代号（含 reply.js 的 REGION_TOKENS 漏掉的 hk / cn / sg 等）
  'us',
  'usa',
  'uk',
  'gb',
  'de',
  'fr',
  'es',
  'it',
  'jp',
  'kr',
  'cn',
  'hk',
  'tw',
  'sg',
  'my',
  'th',
  'vn',
  'ph',
  'id',
  'au',
  'ca',
  'mx',
  'br',
  'eu',
  'nl',
  'se',
  'pl',
  'be',
  '美国',
  '加拿大',
  '墨西哥',
  '英国',
  '德国',
  '法国',
  '西班牙',
  '意大利',
  '日本',
  '韩国',
  '中国',
  '香港',
  '台湾',
  '新加坡',
  '马来西亚',
  '泰国',
  '越南',
  '菲律宾',
  '印尼',
  '澳大利亚',
  '澳洲',
  '欧洲',
  '北美',
  '全球',
  '本土',
  '跨境',
  '海外',
  '美区',
  '美站',
  '欧区',
  // 经营模式
  '自运营',
  '全托管',
  '半托管',
  '本土店',
  '跨境店',
  // 停用店（ziniao.js 的 isRetiredStore 会先把它们排除，这里再兜一层：店名里的
  // '停用' 不是品牌，落到署名里会变成 'JDDX停用 Customer Service'）。
  '停用',
  '废弃',
  'disabled',
  'pop',
  'seller',
]);

/** 粘在品牌后面的「停用」标记（实机：Temu-JDDX停用-管理员）。 */
const RETIRED_SUFFIXES = ['停用', '废弃', 'disabled'];

/**
 * 剔除店铺名里的 TEMU 平台词 / 区域词 / 模式词（逐段过滤，丢掉因此产生的空段）。
 *
 * 还多一步**后缀**处理：店名里的「停用」常常是粘在品牌后面的（实机 Temu-JDDX停用-管理员），
 * 只按分隔符切会把 'JDDX停用' 整段留下，署名就变成 'JDDX停用 Customer Service'。
 * @param {string} storeName - 紫鸟店铺名，形如 TEMU-COZYNOME-管理员。
 * @returns {string} 剔掉噪声词后的店铺名。
 */
function stripTemuPlatformTokens(storeName) {
  const raw = String(storeName ?? '').trim();
  if (!raw) return '';
  return raw
    .split(/[-_\s|/]+/)
    .map((part) => {
      let value = part;
      for (const suffix of RETIRED_SUFFIXES) {
        if (value.length > suffix.length && value.toLowerCase().endsWith(suffix)) {
          value = value.slice(0, -suffix.length);
        }
      }
      return value;
    })
    .filter((part) => part && !TEMU_STORE_NOISE_TOKENS.has(part.toLowerCase()))
    .join('-');
}

/**
 * 从 TEMU 店铺名推品牌（做掉平台词 / 区域词 / 模式词再交给公共实现）。
 *
 * 'TEMU-COZYNOME-管理员' → 'COZYNOME'；'Temu-HK-客服' → ''（推不出就不署名）；
 * 'Temu-US-管理员' → ''。推不出时署名只写 'Customer Service'，**不写 TEMU**。
 * @param {string} storeName - 紫鸟店铺名。
 * @returns {string} 品牌名；推不出返回空串。
 */
export function brandFromTemuStoreName(storeName) {
  return brandFromStoreName(stripTemuPlatformTokens(storeName));
}

/**
 * 订单号来源只有一处：**调用方给的**。
 *
 * 刻意不做文本提取 —— TEMU 的订单号（以及卖家侧的 PO 号）形态没有实测样本，任何正则都是猜。
 * 这条函数存在的意义是把「不猜」写成一个可断言的事实，而不是散落在注释里。
 * @param {{orderId?: string}} input - 会话信息。
 * @returns {string} 订单号；没有就是空串。
 */
export function resolveTemuOrderId(input = {}) {
  return String(input.orderId ?? '').trim();
}

/** 各意图的开场（后面会拼上 '(order XXX)' 或直接句号）。 */
const OPENING = {
  replacement: 'Thank you for reaching out, and we are very sorry about the trouble with your order',
  refund: 'Thank you for your message about your order',
  shipping: 'Thank you for letting us know that your order has not arrived yet, and we are sorry for the wait',
  return: 'Thank you for your message about your return',
  cancel: 'Thank you for your message about cancelling your order',
  invoice: 'Thank you for your message about your order',
  acknowledge: 'Thank you for your kind message - we are glad we could help',
  inquiry: 'Thank you for contacting us about your order',
};

/**
 * 各意图的正文。
 *
 * 五条硬口径（改动前先看 test/reply-temu.test.js 里那几条回归锁）：
 *   1. 不出现 Amazon / 亚马逊 / SHEIN / 沃尔玛 字样，也不出现 Your Orders / order page 这类
 *      别的平台的路径；
 *   2. 不出现 already processed / within X business days 这类断言；
 *   3. 金额、时效、退货地址一律不写死 —— 留给人按实际情况填；
 *   4. 不承诺任何平台侧动作（工单结论、退款到账、面单）—— 那些要走
 *      「客服中心 → 售前/售后工单」，不是客服在会话里能定的；
 *   5. 唯一的例外是「补发配件」：损坏一律直接要照片 + 承诺免费补发配件（**不是整包**）。
 */
const MIDDLE = {
  replacement: [
    'We are sorry about the trouble with your item. We can send you the damaged part free of charge as a replacement - this covers the part only, not the whole set.',
    'So that we send the right part, please reply here with a photo of the damaged part.',
    'As soon as we have the photo, we will arrange the free replacement part. You do not need to return the item or pay anything.',
  ],
  refund: [
    'We are checking what happened with this order now, including the actual status on our side.',
    'We will come back to you in this conversation with the outcome and the next step as soon as we have confirmed it.',
  ],
  shipping: [
    'We are checking the delivery status of this parcel with the carrier now, and we will come back to you in this conversation as soon as we have an answer.',
    'In the meantime, could you please confirm that the shipping address on the order is complete and correct? That is often what holds a delivery up.',
  ],
  return: [
    'We have your return request. We are confirming the return steps that apply to this order.',
    'We will send you the exact instructions in this conversation once they are confirmed. Please do not send the item back before we confirm the return address, so that the parcel does not go missing.',
  ],
  cancel: [
    'We have passed your request to our team. If the order has not left the warehouse yet, we will ask them to cancel it and confirm the outcome here.',
    'If it is already on its way, we will check which options are available for this order and come back to you in this conversation.',
  ],
  invoice: [
    'We can provide the document you need for this order. We are checking the available format and will send it to you in this conversation.',
    'If it needs to show specific details - for example a company name and tax number - please reply with those details.',
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

/** 首字母大写，与 lib/reply.js 的处理保持一致。 */
function titleCase(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * 生成一份 TEMU 买家消息的回复草稿。
 * @param {{buyer?: string, subject?: string, orderId?: string, inbound?: string, storeName?: string, country?: string}} input - 会话信息。
 *   inbound 是**买家最后一条消息**，是判意图的主判据；subject 是会话主题，只当兜底。
 *   orderId 只有适配器从会话行里真读到才传；不传就是没有，**不会去猜**。
 * @returns {{intent: string, intentLabel: string, intentSource: string, language: object, orderId: string, address: object, body: string, notes: string[], needsHuman: boolean, summary: string}} 草稿。
 */
export function buildTemuDraft(input = {}) {
  const buyerRaw = String(input.buyer ?? '').trim();
  const buyer = titleCase(buyerRaw);
  const inbound = String(input.inbound ?? '');
  const subject = String(input.subject ?? '');
  const orderId = resolveTemuOrderId(input);
  const brand = brandFromTemuStoreName(input.storeName);
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

  // ---- notes：与其它渠道对齐的几类 + TEMU 这条线特有的几条 ----
  if (classification.ambiguous) {
    notes.push('意图可能有歧义（同时命中 ' + classification.matched + '），请人工确认模板选得对不对');
  }
  if (classification.source === 'subject') {
    notes.push('正文里没有明确诉求，意图是按会话主题判的，发送前请再读一遍买家的话');
  }
  if (language.code !== 'en') {
    notes.push('买家语言可能是' + language.label + '，草稿是英文；如需按买家语言回复请人工调整');
  }
  if (!orderId && classification.intent !== 'acknowledge') {
    notes.push('草稿里没有订单号（TEMU 订单号形态尚未校准，不做正则提取）：发送前请从会话或订单里补上');
  }
  if (classification.intent === 'refund') {
    notes.push(
      '退款必须人工核实后再发：半托管店铺的退款要走「客服中心 → 售前/售后工单」按平台给出的处理结果操作，模板只承接、不断言',
    );
  }
  if (classification.intent === 'return') {
    notes.push('退货/面单必须人工核实后再发：确认适用政策、退货仓与承运商，确认前不要让买家寄回');
  }
  if (classification.intent === 'invoice') {
    notes.push('发票/凭证必须人工核对格式后再发：模板没有承诺任何具体获取路径');
  }
  if (classification.intent !== 'acknowledge') {
    // TEMU 特有的时限：官方商家接待课程写明「消费者咨询（自接待模式）需 24 小时内响应，超时可能触发平台介入」。
    notes.push('TEMU 半托管「客服中心 → 消费者咨询」要求 24 小时内响应（超时可能触发平台介入）：这条草稿请当天发出');
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

/** 默认导出，方便 DRAFT_BUILDERS 里写成 temu: buildTemuDraft。 */
export default buildTemuDraft;
