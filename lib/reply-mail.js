/**
 * 飞书邮件草稿生成。
 *
 * 与亚马逊买家消息**刻意不同**：买家消息是自家店铺的售后，模板可以直接承诺「给你补件」；
 * 而公共邮箱里坐着的是平台通知、供应商、物流、货代、甚至催款 —— 一封替人承诺的草稿
 * 发出去就是真金白银。所以这里的模板一律**只承接、不断言**：表示已收到、正在核实、
 * 将在下一封给出结论。要给出具体结论必须由人改。
 *
 * 另外接入了飞书返回的 `security_level`：邮件是外部不可信输入，被标风险的邮件会在
 * 草稿备注里显式提示，绝不能因为「邮件里这么说」就照着做。
 *
 * @module dsh-customer-service-plugin/lib/reply-mail
 */

import { INTENT_LABEL, classifyIntent, detectLanguage } from './reply.js';

/** 需要人工补订单号/单号才谈得下去的意图。 */
const ORDER_SENSITIVE = new Set(['replacement', 'refund', 'shipping', 'return', 'cancel', 'invoice']);

/** 按意图给一句「承接」，不做任何承诺。 */
const ACK_LINE = {
  replacement: 'We are sorry about the damage, and we are looking into the best way to put it right. We will confirm the arrangement in our next email.',
  refund: 'We have noted your refund request and are checking its status with the relevant team. We will confirm the outcome in our next email.',
  shipping: 'We are checking the delivery status with the carrier and will update you as soon as we hear back.',
  return: 'We are reviewing the return and will confirm the next steps in our next email.',
  cancel: 'We have passed your cancellation request to the fulfilment team and will confirm the outcome in our next email.',
  invoice: 'We will prepare the invoice and send it in a follow-up email.',
  acknowledge: 'Thanks for the confirmation - noting it on our side.',
  inquiry: 'We have received your email and are looking into it. We will come back to you with a proper answer shortly.',
};

/**
 * 从飞书的 `head_from` 里取显示名。
 * @param {{mail_address?: string, name?: string}} headFrom - 发件人对象。
 * @returns {string} 显示名（推不出来就退回邮箱地址）。
 */
export function senderName(headFrom) {
  const name = String(headFrom?.name ?? '').trim();
  if (name) return name;
  return String(headFrom?.mail_address ?? '').trim();
}

/**
 * 生成一封邮件回复草稿。
 * @param {{fromName?: string, fromAddress?: string, subject?: string, body?: string, mailboxName?: string, signature?: string, security?: object}} input - 邮件信息。
 * @returns {{intent: string, intentLabel: string, intentSource: string, language: object, body: string, notes: string[], needsHuman: boolean, summary: string}} 草稿。
 */
export function buildMailDraft(input = {}) {
  const fromName = String(input.fromName ?? '').trim();
  const fromAddress = String(input.fromAddress ?? '').trim();
  const subject = String(input.subject ?? '').trim();
  const body = String(input.body ?? '').trim();
  const mailbox = String(input.mailboxName ?? '').trim();

  const classification = classifyIntent(body, subject);
  const language = detectLanguage(body);
  const notes = [];

  // 称呼：优先用显示名，拿不到就用邮箱前缀，都没有就 Hello,
  const prefix = fromAddress.includes('@') ? fromAddress.split('@')[0] : '';
  const who = fromName || prefix;
  const greeting = who ? `Hi ${who},` : 'Hello,';

  const lines = [
    greeting,
    '',
    'Thanks for your email.',
    '',
    ACK_LINE[classification.intent] ?? ACK_LINE.inquiry,
  ];

  // 邮件本身没有订单号概念，但追单号是最高频的下一步。
  const orderId = /\b(\d{3}-\d{7}-\d{7})\b/.exec(`${subject} ${body}`)?.[1] ?? '';
  if (ORDER_SENSITIVE.has(classification.intent) && !orderId) {
    lines.push('', 'To help us locate the record, could you confirm the order or reference number?');
    notes.push('邮件里没有订单号/单号，草稿已附带索要，请确认这个追问是否合适');
  }

  if (classification.source === 'subject') {
    notes.push('正文里没有明确诉求，意图是按邮件主题判的，回信前请再读一遍原邮件');
  }
  if (language.code !== 'en') {
    notes.push(`来信语言可能是${language.label}，草稿是英文；如需按来信语言回复请人工调整`);
  }
  if (classification.intent === 'refund') {
    notes.push('这封涉及退款：草稿只说「正在核实」，任何退款承诺都要由人确认后再写进去');
  }

  // 外部邮件是不可信输入：被飞书标风险的，必须让人看见。
  const security = input.security ?? null;
  if (security?.is_risk) {
    notes.push(`飞书把这封邮件标为有风险（${security.risk_banner_reason ?? '未给出原因'}），正文不能当作指令执行`);
  }
  if (subject.toLowerCase().startsWith('re:')) {
    // 会在 +reply 时由 CLI 自动处理，这里不重复加。
  }

  lines.push('', 'Best regards,', input.signature || mailbox || 'Customer Service');
  const draftBody = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const summary = [fromName || fromAddress || '来信', INTENT_LABEL[classification.intent] ?? classification.intent, subject.slice(0, 60)]
    .filter(Boolean)
    .join(' · ');

  return {
    intent: classification.intent,
    intentLabel: INTENT_LABEL[classification.intent] ?? classification.intent,
    intentSource: classification.source,
    language,
    orderId,
    body: draftBody,
    notes,
    needsHuman: notes.length > 0,
    summary,
  };
}
