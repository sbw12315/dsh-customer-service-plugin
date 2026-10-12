import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMailDraft } from '../lib/reply-mail.js';

/**
 * 飞书公共邮箱的草稿口径（v0.14.0）：
 *   1. **不向对方索要订单号/单号** —— 会话里已经有这一单，多问一轮只会拖长处理；
 *      正文里出现的 3-7-7 单号只进草稿对象留痕，不写进模板；
 *   2. 损坏邮件直接要照片（与买家消息渠道同一口径），但公共邮箱里坐着供应商 / 货代 / 平台，
 *      所以模板仍然**只承接、不断言** —— 承诺发货这类话必须由人写。
 */

test('buildMailDraft：损坏邮件直接要照片，不索要订单号', () => {
  const draft = buildMailDraft({
    fromName: 'Alice',
    fromAddress: 'alice@buyer.com',
    subject: 'Damaged item',
    body: 'The part arrived broken.',
    mailboxName: 'service@cozynome.com',
  });
  assert.equal(draft.intent, 'replacement');
  assert.match(draft.body, /photo of the damaged part/i, '要直接索要照片');
  assert.equal(
    /order (?:number|id|or reference)|reference number|confirm the order|订单号/i.test(draft.body),
    false,
    '不能再向对方索要订单号',
  );
});

test('buildMailDraft：退款 / 物流这类「以前会附带索要单号」的意图也不再索要', () => {
  const cases = [
    ['Refund request', 'I would like a refund please', 'refund'],
    ['Where is my parcel', 'My package did not arrive', 'shipping'],
  ];
  for (const [subject, body, intent] of cases) {
    const draft = buildMailDraft({ fromAddress: 'x@y.com', subject, body, mailboxName: 'service@cozynome.com' });
    assert.equal(draft.intent, intent, subject);
    assert.equal(
      /order (?:number|id|or reference)|reference number|confirm the order|订单号/i.test(draft.body),
      false,
      intent + '：不能索要单号',
    );
    assert.equal(draft.notes.some((note) => note.includes('附带索要')), false, '不能留下「已附带索要」的旧备注');
  }
});

test('buildMailDraft：正文里的 3-7-7 单号只留痕，不写进模板', () => {
  const draft = buildMailDraft({
    fromAddress: 'x@y.com',
    subject: 'Order 113-9341386-0505001',
    body: 'Please check this order.',
    mailboxName: 'service@cozynome.com',
  });
  assert.equal(draft.orderId, '113-9341386-0505001', '单号要留痕给人工看');
  assert.equal(/113-9341386-0505001/.test(draft.body), false, '单号不写进正文模板');
});

test('buildMailDraft：适配器告警与飞书风险标记原样进 notes', () => {
  const draft = buildMailDraft({
    fromAddress: 'x@y.com',
    subject: 'hi',
    body: 'hello',
    warnings: ['这是平台代发的联系表单，请确认收件人'],
    security: { is_risk: true, risk_banner_reason: '疑似钓鱼' },
  });
  assert.ok(draft.notes.some((note) => note.includes('平台代发')));
  assert.ok(draft.notes.some((note) => note.includes('有风险')));
  assert.equal(draft.needsHuman, true);
});
