/**
 * 草稿生成：把一段买家消息判成意图，套进对应的话术模板，填上变量。
 *
 * 刻意**不接 LLM**：
 *   - 巡逻要一次跑几十家店，模板化是唯一能保证「同样的问题给同样的答复」的做法；
 *   - 插件的硬约束是「草稿先行、人工放行」，模型生成的措辞反而增加人工复核成本；
 *   - 宿主不一定提供 llm 服务，接了会让巡逻在部分 DSH 组合里直接不可用。
 * 所以这里是纯函数：输入会话，输出草稿文本 + 判定依据，**零 I/O、零依赖**，可以单独断言。
 *
 * @module dsh-customer-service-plugin/lib/reply
 */

/** 支持的意图。顺序即匹配优先级。 */
export const INTENTS = ['replacement', 'refund', 'shipping', 'return', 'cancel', 'invoice', 'acknowledge', 'inquiry'];

/** 意图的中文标签（UI 直接用）。 */
export const INTENT_LABEL = Object.freeze({
  replacement: '换货 / 补件',
  refund: '退款',
  shipping: '未收到 / 物流',
  return: '退货',
  cancel: '取消订单',
  invoice: '发票 / 收据',
  acknowledge: '致谢收尾',
  inquiry: '一般咨询',
});

/**
 * 每个意图的判定规则。**顺序敏感**：先判换货再判退款 ——
 * 「damaged item, want a replacement or refund」应该落到换货，因为更具体。
 */
const RULES = Object.freeze([
  {
    intent: 'replacement',
    patterns: [
      /replacement/i,
      /replace/i,
      // 真实会话里的原话：\b(broke)\b 比 broken 更常见（"the hardware broke out of the side"），
      // 早先只写 broken 会把它判成「一般咨询」，生成一封「请提供更多信息」的空话。
      // 刻意不收裸的 \bdamage\b："no damage at all, I still want a refund" 会被误判成换货。
      /broken|\bbroke\b|\bbreak\b|shatter|crack|damaged|defective|faulty|missing part|wrong item/i,
      /do(?:es)?n[o']?t work|not working|stopped working|no longer works|won[o']?t work/i,
      // 「要一块配件」也是补件诉求，只是没用 replacement 这个词。
      /need (?:a |the |an )?(?:part|piece|board|panel|rail|screw|knob|drawer|hardware|glass|mirror|leg|legs|cushion|cover)/i,
      /补件|换货|破损|损坏|坏了|不能用/,
    ],
  },
  {
    intent: 'refund',
    patterns: [/refund/i, /money back|reimburse/i, /退款|退钱/],
  },
  {
    intent: 'shipping',
    patterns: [
      /did ?n[o']?t arrive|not arrived|never arrived|has ?n[o']?t arrived/i,
      /where is my|still waiting|not received|undelivered|lost package|late/i,
      // 中文口语里「（还）没有收到」「还没到货」比「未收到」常见得多：只写书面词会漏判。
      /未收到|没收到|没有收到|还没收到|还没有收到|没到货|还没有到|未到货|丢件|物流/,
    ],
  },
  {
    intent: 'return',
    patterns: [/return/i, /send .* back/i, /退货/],
  },
  {
    intent: 'cancel',
    patterns: [/cancel/i, /取消/],
  },
  {
    intent: 'invoice',
    patterns: [/invoice|receipt/i, /factura|facture|rechnung|fattura|faktura/i, /发票|收据/],
  },
  {
    // 买家只回了一句致谢时，最不该做的就是再问一堆问题。判定见 looksLikeAcknowledgment。
    intent: 'acknowledge',
    predicate: looksLikeAcknowledgment,
  },
]);

/** 致谢判定里可以忽略的填充词（问候、客套、语气词、代词）。 */
const ACK_FILLER = new Set([
  'hi', 'hello', 'hey', 'dear', 'good', 'morning', 'afternoon',
  'thank', 'thanks', 'thankyou', 'thx', 'ty', 'tysm',
  'u', 'you', 'your', 'so', 'much', 'very', 'a', 'lot', 'again', 'kindly', 'guys',
  'for', 'everything', 'all', 'help', 'and', 'the', 'is', 'are', 'to', 'of', 'my', 'on', 'in',
  'ok', 'okay', 'k', 'great', 'perfect', 'awesome', 'excellent', 'amazing',
  'got', 'it', 'understood', 'sounds', 'sound', 'will', 'do',
  'yes', 'yeah', 'yep', 'no', 'nope', 'please', 'right', 'thats', 'that', 'this',
  'i', 'we', 'was', 'were', 'be', 'can', 'could', 'appreciate',
]);

/**
 * 判断买家是不是「只回了一句致谢」。
 *
 * 不能用一条宽松的正则：`/thank you/` 会把
 * "no thank you i would jus like the refund please." 也判成致谢 —— 那正是买家**拒绝**换货
 * 的那句话。所以这里做成「先要求出现致谢词，再把填充词剥掉，看还剩不剩实质内容」。
 * @param {string} text - 买家消息。
 * @returns {boolean} 是否纯致谢。
 */
export function looksLikeAcknowledgment(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return false;
  if (!/\b(?:thank you|thanks|thx|thank u|tysm|ty|perfect|great|awesome|excellent|got it|understood|sounds good|will do)\b/i.test(raw)) {
    return false;
  }
  const tokens = raw.toLowerCase().replace(/[^a-z' ]+/g, ' ').split(/\s+/).filter(Boolean);
  return tokens.every((token) => ACK_FILLER.has(token));
}

/** 亚马逊订单号：3-7-7。 */
const ORDER_RE = /\b(\d{3}-\d{7}-\d{7})\b/;

/** 美国州缩写，用来佐证「这段文本里确实是一个收货地址」。 */
const US_STATES =
  'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';

/**
 * 判断文本里是否含中日韩文字。
 *
 * 刻意用码点比较而不是正则里的 \\u 转义：这段代码要能原样穿过各种转写/打包环节，
 * 少一层转义就少一类「换台机器就坏」的隐患。
 * @param {string} text - 文本。
 * @returns {boolean} 是否含 CJK。
 */
export function hasCjk(text) {
  for (const ch of String(text ?? '')) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x4e00 && code <= 0x9fff) return true;
  }
  return false;
}

/** 对一段文本跑一遍规则。 */
function matchRules(text) {
  const haystack = String(text ?? '');
  const hits = [];
  for (const rule of RULES) {
    let matched = null;
    for (const pattern of rule.patterns ?? []) {
      const found = pattern.exec(haystack);
      if (found) {
        matched = found[0];
        break;
      }
    }
    // 少数规则用谓词更清楚（例如「纯致谢」要先剥填充词再看还剩什么），
    // 写成正则只会变成一坨无法维护的前后视断言。
    if (matched === null && typeof rule.predicate === 'function' && rule.predicate(haystack)) {
      matched = 'predicate';
    }
    if (matched !== null) hits.push({ intent: rule.intent, matched });
  }
  return hits;
}

/**
 * 判定意图。
 *
 * **买家最后一条消息优先，系统主题只当兜底。** 这是踩出来的教训：亚马逊给会话起的
 * 主题是系统标签（`Damaged or defective item: Request a replacement item`），它描述的是
 * **最初**的诉求。真实会话里买家后来改口是很常见的 —— 有会话里卖家提了换货、买家
 * 明确回了两次「no thank you, i would just like the refund」，若按主题判就会生成一封
 * 「我们很乐意给你补件」的草稿，跟买家刚说过的话正好相反。
 *
 * @param {string} primary - 主判据，通常是买家最后一条消息。
 * @param {string} [fallback] - 兜底判据，通常是会话主题；主判据判不出意图时才用。
 * @returns {{intent: string, matched: string|null, ambiguous: boolean, source: 'message'|'subject'|'none'}} 判定结果。
 */
export function classifyIntent(primary, fallback = '') {
  const primaryHits = matchRules(primary);
  if (primaryHits.length > 0) {
    return {
      intent: primaryHits[0].intent,
      matched: primaryHits[0].matched,
      ambiguous: primaryHits.length > 1,
      source: 'message',
    };
  }
  const fallbackHits = matchRules(fallback);
  if (fallbackHits.length > 0) {
    return {
      intent: fallbackHits[0].intent,
      matched: fallbackHits[0].matched,
      ambiguous: fallbackHits.length > 1,
      source: 'subject',
    };
  }
  return { intent: 'inquiry', matched: null, ambiguous: false, source: 'none' };
}

/**
 * 取第一个亚马逊订单号。
 * @param {string} text - 文本。
 * @returns {string} 订单号，取不到返回空串。
 */
export function extractOrderId(text) {
  const match = ORDER_RE.exec(String(text ?? ''));
  return match ? match[1] : '';
}

/**
 * 从买家消息里抠出收货地址。
 *
 * 只认「门牌号 + 街道类型词 + 州缩写 + 邮编」这类硬证据，不做语义猜测 ——
 * 判错的代价是草稿里凭空写上一个不存在的地址。
 *
 * 买家经常在一条消息里同时给出「旧地址」和「新地址」（本轮真实会话就是这样），
 * 所以这里返回**数组**，草稿里把候选地址全列出来让买家确认，而不是替买家猜一个。
 * @param {string} text - 买家消息。
 * @returns {{hasAddress: boolean, count: number, zip: string, items: Array<{street: string, city: string, state: string, zip: string, line: string, lines: string[]}>, lines: string[]}} 结果。
 */
export function extractAddress(text) {
  const raw = String(text ?? '');
  // 两段式匹配：先用不区分大小写的规则找到「门牌号 + 街道 + 街道类型词」，
  // 再从它后面按**区分大小写**的规则接「城市, 州 邮编」。
  // 合成一个正则会在 "Huntsville" 里匹配出 "il" 当成伊利诺伊州 —— 真实踩过这个坑。
  const streetRe = new RegExp(
    "(\\d+\\s+[A-Za-z0-9.'\\- ]{2,40}?\\s+" +
      '(?:street|st|road|rd|avenue|ave|court|ct|lane|ln|drive|dr|way|blvd|boulevard|circle|cir|place|pl))\\b',
    'gi',
  );
  const tailRe = new RegExp("^[.,]?\\s+([A-Za-z][A-Za-z.'\\- ]{0,28}?),?\\s+(" + US_STATES + ')\\b\\s*(\\d{5}(?:-\\d{4})?)?');
  const items = [];
  let match = streetRe.exec(raw);
  while (match !== null) {
    const street = String(match[1] ?? '').trim();
    const tail = tailRe.exec(raw.slice(streetRe.lastIndex));
    if (street && tail) {
      const city = String(tail[1] ?? '').trim().replace(/[,\s]+$/, '');
      const state = String(tail[2] ?? '').toUpperCase();
      const zip = String(tail[3] ?? '').trim();
      const cityLine = [city, state].filter(Boolean).join(', ') + (zip ? ' ' + zip : '');
      items.push({
        street,
        city,
        state,
        zip,
        line: street + ', ' + cityLine,
        lines: [street, cityLine],
      });
    }
    if (items.length >= 4) break;
    match = streetRe.exec(raw);
  }
  // 兜底：有邮编但没匹配出完整街道时，只报「有地址」，不硬凑内容。
  const zipOnly = /\b(\d{5})(?:-\d{4})?\b/.exec(raw);
  const hasAddress = items.length > 0 || Boolean(zipOnly && new RegExp('\\b(?:' + US_STATES + ')\\b').test(raw));
  return {
    hasAddress,
    count: items.length,
    zip: items.length ? items[0].zip : zipOnly ? zipOnly[1] : '',
    items,
    lines: items.flatMap((item) => item.lines),
  };
}

/**
 * 语言探测用的停用词表（只做「不是英语」的提示，不做翻译）。
 *
 * 用**词命中计数**而不是单条正则：真实买家消息里不会恰好出现 "Lieferung" 这种特征名词，
 * 但一定会出现 ich / nicht / und 这类高频虚词。实测一条德语消息
 * "Ich habe versucht mehrere mal es geht nicht ich weiß nicht warum" 用特征名词一条都命不中，
 * 于是一直被当成英语，草稿备注里也就没有语言提醒。要求至少命中 2 个**不同**的词，
 * 避免把英文误判成德语（"die" 这类英德同形词刻意不收）。
 */
const LANGUAGE_HINTS = Object.freeze([
  {
    code: 'de',
    label: '德语',
    words: ['ich', 'nicht', 'und', 'ist', 'das', 'bitte', 'danke', 'habe', 'kann', 'warum', 'geht', 'mehrere', 'bestellung', 'lieferung', 'kaputt', 'rücksendung', 'beschädigt', 'sie', 'wir', 'noch'],
  },
  {
    code: 'es',
    label: '西班牙语',
    words: ['pedido', 'gracias', 'no', 'pero', 'para', 'está', 'esta', 'muy', 'reembolso', 'devolución', 'roto', 'consulta', 'puedes', 'necesito', 'tengo', 'factura'],
  },
  {
    code: 'fr',
    label: '法语',
    words: ['commande', 'merci', 'pas', 'pour', 'avec', 'remboursement', 'retour', 'cassé', 'besoin', 'vous', 'nous', 'facture'],
  },
  {
    code: 'it',
    label: '意大利语',
    words: ['ordine', 'grazie', 'non', 'per', 'sono', 'rimborso', 'reso', 'rotto', 'fattura', 'vorrei', 'anche'],
  },
]);

/** 预编译停用词正则：每条消息都要跑一遍，别在热路径上现构造 RegExp。 */
const LANGUAGE_MATCHERS = LANGUAGE_HINTS.map((hint) => ({
  code: hint.code,
  label: hint.label,
  words: hint.words.map((word) => ({ word, re: new RegExp(`(?:^|[^a-zà-ÿ])${word}(?:[^a-zà-ÿ]|$)`, 'i') })),
}));

/**
 * 推断买家语言（只用于提示，不改变模板语言）。
 * @param {string} text - 买家消息。
 * @returns {{code: string, label: string}} 语言。
 */
export function detectLanguage(text) {
  const raw = String(text ?? '');
  let best = null;
  for (const matcher of LANGUAGE_MATCHERS) {
    const hits = matcher.words.filter((entry) => entry.re.test(raw)).length;
    if (hits >= 2 && (!best || hits > best.hits)) best = { code: matcher.code, label: matcher.label, hits };
  }
  if (best) return { code: best.code, label: best.label };
  if (hasCjk(raw)) return { code: 'zh', label: '中文' };
  return { code: 'en', label: '英语' };
}

/**
 * 从紫鸟店铺名里推品牌名。
 *
 * 店铺名形如 `Amazon-Cozynome-管理员`、`Amazon-FUSOU-客服`；去掉平台前缀与角色后缀，
 * 剩下的就是品牌。推不出来时退化成空串，模板会自动省略署名里的品牌。
 * @param {string} storeName - 店铺名。
 * @returns {string} 品牌名。
 */
const PLATFORM_TOKENS = /^(amazon|亚马逊|amzn|com)$/i;
const REGION_TOKENS =
  /^(us|usa|uk|gb|de|fr|es|it|jp|ca|au|mx|nl|se|pl|be|eu|com|美国|加拿大|墨西哥|英国|德国|法国|西班牙|意大利|日本|欧洲|澳洲|澳大利亚|北美|全球)$/i;
const ROLE_TOKENS = /^(管理员|运营|客服|主管|admin|operator|manager|service|support|cs)$/i;

export function brandFromStoreName(storeName) {
  const raw = String(storeName ?? '').trim();
  if (!raw) return '';
  const parts = raw
    .split(/[-_/|]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !PLATFORM_TOKENS.test(part))
    .filter((part) => !REGION_TOKENS.test(part))
    .filter((part) => !ROLE_TOKENS.test(part));
  return parts[0] ?? '';
}

/** 首字母大写。 */
function titleCase(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  return text[0].toUpperCase() + text.slice(1);
}

/**
 * 生成一份草稿。
 * @param {{buyer?: string, subject?: string, orderId?: string, inbound?: string, storeName?: string, country?: string}} input - 会话信息。
 *   `inbound` 是**买家最后一条消息**，是判意图的主判据；`subject` 是亚马逊系统主题，只当兜底。
 * @returns {{intent: string, intentLabel: string, intentSource: string, language: object, orderId: string, address: object, body: string, notes: string[], needsHuman: boolean, summary: string}} 草稿。
 *   `intentSource` 是 `message` / `subject` / `none`，告诉复核的人这封草稿是依据什么判的意图。
 */
export function buildDraft(input = {}) {
  const buyerRaw = String(input.buyer ?? '').trim();
  const buyer = titleCase(buyerRaw);
  const inbound = String(input.inbound ?? '');
  const subject = String(input.subject ?? '');
  const orderId = String(input.orderId ?? '').trim() || extractOrderId(subject + ' ' + inbound);
  const brand = brandFromStoreName(input.storeName);
  const signature = brand ? brand + ' Customer Service' : 'Customer Service';

  const classification = classifyIntent(inbound, subject);
  const address = extractAddress(inbound);
  const language = detectLanguage(inbound);

  const greeting = buyer ? 'Hello ' + buyer + ',' : 'Hello,';
  const orderClause = orderId ? ' (order ' + orderId + ')' : '';
  const notes = [];

  // 一条消息里给了多个地址时，把候选全列出来让买家点一个 —— 替买家猜地址是事故。
  const multipleAddresses = address.count > 1;
  const addressBlock = address.hasAddress
    ? [
        multipleAddresses
          ? 'You mentioned more than one address in your message:'
          : 'The address we have from your message is:',
        '',
        ...address.items.map((item) => item.lines.join('\n')),
        '',
        multipleAddresses
          ? 'Please confirm which of these the replacement should be sent to, or send us the corrected address.'
          : 'Please confirm this is correct, or send us the corrected address.',
      ].join('\n')
    : '';

  const opening = {
    replacement: 'Thank you for reaching out, and we are very sorry about the trouble with your order' + orderClause + '.',
    refund: 'Thank you for your message about your order' + orderClause + '. We are sorry for the inconvenience this has caused.',
    shipping: 'Thank you for letting us know that your order' + orderClause + ' has not arrived yet, and we are sorry for the wait.',
    return: 'Thank you for your message about your return' + orderClause + '.',
    cancel: 'Thank you for your message about cancelling your order' + orderClause + '.',
    invoice: 'Thank you for your message about your order' + orderClause + '.',
    acknowledge: 'Thank you for your kind message - we are glad we could help.',
    inquiry: 'Thank you for contacting us about your order' + orderClause + '.',
  };

  const middle = {
    replacement: [
      address.hasAddress
        ? multipleAddresses
          ? 'We are happy to send you a replacement at no cost to you, and we have noted the address details from your message.'
          : 'We are happy to send you a replacement at no cost to you, and we have noted the shipping address from your message.'
        : 'We are happy to send you a replacement at no cost to you.',
      addressBlock,
      'To make sure the replacement reaches you, please also let us know the best phone number for the carrier. Once we have your confirmation, we will arrange the shipment and share the tracking details with you as soon as they are available.',
    ],
    refund: [
      'We have looked into this for you. A refund has been processed, and it normally returns to your original payment method within 3 to 5 business days. If it has not appeared after that, please reply here and we will follow up with our payments team straight away.',
    ],
    shipping: [
      'The parcel was handed to the carrier and is on its way. We have asked the carrier to check the delivery status and will update you as soon as we hear back. If the parcel is confirmed lost, we will arrange a replacement or a full refund for you right away, whichever you prefer.',
      'In the meantime, could you please confirm that the shipping address on the order is correct and complete? That is often what holds a delivery up.',
    ],
    return: [
      'We have your return request. You can send the item back using the return label available in your Amazon account under Your Orders - the label and the return instructions are shown there. Once the returned item reaches our warehouse, the refund is issued automatically, usually within 3 to 5 business days.',
      'If anything about the return label is unclear, just reply here and we will sort it out for you.',
    ],
    cancel: [
      'We have passed your request to our fulfilment team. If the order has not shipped yet, the cancellation will go through and the charge is released back to your original payment method. If it has already shipped, you are welcome to refuse the delivery or return it once it arrives, and we will refund you in full.',
      'We will confirm the outcome here as soon as we hear back.',
    ],
    invoice: [
      'You can download the invoice or receipt for any order from your Amazon account: open Your Orders, select this order, and choose the invoice option in the order summary.',
      'If you need a different document - for example an invoice showing your company name and tax number - just reply here with the details you need it to show, and we will prepare it for you.',
    ],
    acknowledge: [
      'If anything else comes up with your order, just reply here and we will take care of it.',
    ],
    inquiry: [
      'We would be glad to help. So that we can look into this properly, could you please share a little more detail about the issue - for example a photo of the item as it arrived, and confirmation of the shipping address on the order?',
      'As soon as we have that, we will come back to you with a concrete solution.',
    ],
  };

  const closing = {
    replacement: 'Thank you for your patience and understanding.',
    refund: 'Thank you for your patience.',
    shipping: 'Thank you for your patience.',
    invoice: 'Thank you for your patience.',
    inquiry: 'Thank you for your patience.',
  };

  const blocks = [greeting, opening[classification.intent], ...middle[classification.intent]];
  if (closing[classification.intent]) blocks.push(closing[classification.intent]);
  blocks.push('Best regards,', signature);
  const body = blocks
    .filter((line) => String(line ?? '').trim() !== '')
    .join('\n\n')
    .trim();

  if (classification.ambiguous) {
    notes.push('意图可能有歧义（同时命中 ' + classification.matched + '），请人工确认模板选得对不对');
  }
  if (language.code !== 'en') {
    notes.push('买家语言可能是' + language.label + '，草稿是英文；如需按买家语言回复请人工调整');
  }
  // 致谢收尾这类寒暄不涉及具体订单，缺订单号不是问题，别制造无意义的「需人工」。
  if (!orderId && classification.intent !== 'acknowledge') {
    notes.push('没能从会话里解出订单号，发送前请补上');
  }
  if (classification.intent === 'refund') {
    // 模板是断言式的（「退款已处理」）。模板不知道后台到底有没有真的退过，
    // 所以只要走退款模板就必须提示人工核一遍 —— 这是最容易发出去就出事的一句话。
    notes.push('模板里写了「已处理退款」，发送前请确认这笔退款是否真的已经操作或承诺过');
  }

  const summary = [buyerRaw || '买家', INTENT_LABEL[classification.intent] ?? classification.intent, orderId || '无订单号', subject.slice(0, 60)]
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

/**
 * 把会话的多条消息压成一句摘要（进工单的 snippet）。
 * @param {{messages?: Array<{dir: string, body: string}>}} thread - 会话。
 * @param {number} [maxLength] - 上限。
 * @returns {string} 摘要。
 */
export function summarizeThread(thread, maxLength = 300) {
  const messages = Array.isArray(thread?.messages) ? thread.messages : [];
  const inbound = messages.filter((m) => m.dir === 'in');
  const last = inbound.length ? inbound[inbound.length - 1] : messages[messages.length - 1];
  const text = String(last?.body ?? '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? text.slice(0, maxLength) + '...' : text;
}
