import assert from 'node:assert/strict';
import test from 'node:test';
import { INTENT_LABEL, INTENTS, classifyIntent } from '../lib/reply.js';
import {
  INTENTS as TEMU_INTENTS,
  brandFromTemuStoreName,
  buildTemuDraft,
  resolveTemuOrderId,
} from '../lib/reply-temu.js';

const STORE = 'TEMU-COZYNOME-管理员';

/** 断言一段草稿里没有任何「别的平台的路径 / 已完成动作」的断言。 */
function assertNoPlatformClaims(body) {
  // 这条线最贵的错法：客服照着**亚马逊/SHEIN** 的路径去操作（Your Orders 之类）。
  assert.equal(/amazon|亚马逊|shein|walmart|沃尔玛/i.test(body), false, '不能出现别的平台的字样');
  assert.equal(/your orders|order page|account under|chat工作台/i.test(body), false, '不能承诺具体平台路径');
  assert.equal(
    /already (?:been )?(?:processed|refunded|shipped|sent)|has been (?:processed|refunded)|within \d+ business days/i.test(body),
    false,
    '不能断言动作已完成或给出固定时效',
  );
}

test('意图体系与主模板族共用一套（否则统计页会按渠道裂成两套口径）', () => {
  assert.deepEqual(TEMU_INTENTS, INTENTS);
  assert.equal(INTENT_LABEL.refund, '退款');
  assert.equal(classifyIntent('I want a refund please').intent, 'refund');
});

test('品牌：剔掉 TEMU 平台词与站点代号，署名不能变成平台官方', () => {
  assert.equal(brandFromTemuStoreName(STORE), 'COZYNOME');
  assert.equal(brandFromTemuStoreName('TEMU-COZYNOME-运营'), 'COZYNOME');
  // 推不出就不署名 —— 写成 'TEMU Customer Service' 会被买家当成平台官方客服，
  // 写成 'HK Customer Service' 更莫名其妙（HK 只是站点代号，不是品牌）。
  assert.equal(brandFromTemuStoreName('Temu-HK-客服'), '');
  assert.equal(brandFromTemuStoreName('Temu-CN-客服'), '');
  assert.equal(brandFromTemuStoreName('Temu-US-管理员'), '');
  assert.equal(brandFromTemuStoreName('Temu-JDDX停用-管理员'), 'JDDX');

  const draft = buildTemuDraft({ buyer: 'Ann', storeName: STORE, inbound: 'Where is my order?' });
  assert.match(draft.body, /COZYNOME Customer Service/);
  assert.equal(/TEMU Customer Service/i.test(draft.body), false);

  const regionOnly = buildTemuDraft({ buyer: 'Ann', storeName: 'Temu-HK-客服', inbound: 'Where is my order?' });
  assert.match(regionOnly.body, /Best regards,\s*Customer Service/);
  assert.equal(/HK Customer Service/.test(regionOnly.body), false);
});

test('订单号一律不认：只有调用方明确给了才用（TEMU 订单号形态未校准）', () => {
  // 会话里出现各种数字串，都不能被当成订单号 —— 认错单号不可逆，认不出只是人工补 5 秒。
  const inbound = 'My order PO-12345678901234567 shows 1234567890123 and I need help';
  assert.equal(resolveTemuOrderId({}), '');
  assert.equal(resolveTemuOrderId({ orderId: '  ' }), '');
  const draft = buildTemuDraft({ buyer: 'Ann', storeName: STORE, inbound });
  assert.equal(draft.orderId, '', '不猜订单号');
  assert.equal(draft.body.indexOf('PO-12345678901234567'), -1, '疑似单号不能出现在正文里');
  assert.ok(
    draft.notes.some((note) => note.indexOf('TEMU 订单号形态尚未校准') >= 0),
    '要提示人工补订单号',
  );

  // 适配器真读到了订单号时照样能用。
  const withId = buildTemuDraft({ buyer: 'Ann', storeName: STORE, inbound: 'Where is my order?', orderId: 'PO-999' });
  assert.equal(withId.orderId, 'PO-999');
  assert.match(withId.body, /\(order PO-999\)/);
});

test('模板口径：退款 / 退货 / 发票只承接、不断言，并强制挂人工核实', () => {
  const cases = [
    ['I want a refund for this order', 'refund', /人工核实/],
    ['I want to return this item', 'return', /人工核实/],
    ['Please send me the invoice for my order', 'invoice', /人工核对/],
  ];
  for (const [inbound, intent, notePattern] of cases) {
    const draft = buildTemuDraft({ buyer: 'Ann', storeName: STORE, inbound });
    assert.equal(draft.intent, intent, inbound + ' 应判成 ' + intent);
    assertNoPlatformClaims(draft.body);
    assert.equal(draft.needsHuman, true, '这条线必须人工过一遍');
    assert.ok(draft.notes.some((note) => notePattern.test(note)), intent + ' 的草稿要带人工核实提示');
  }
  // 退款这一条要把「为什么客服定不了」写清楚：半托管要走售前/售后工单。
  const refund = buildTemuDraft({ buyer: 'Ann', storeName: STORE, inbound: 'I want a refund' });
  assert.ok(
    refund.notes.some((note) => note.indexOf('售前/售后工单') >= 0),
    '退款草稿要说明它取决于平台工单结论',
  );
});

test('TEMU 特有的时限提醒：非「已解决」类意图都要带 24 小时一条', () => {
  const refund = buildTemuDraft({ buyer: 'Ann', storeName: STORE, inbound: 'I want a refund' });
  assert.ok(
    refund.notes.some((note) => note.indexOf('24 小时') >= 0),
    '半托管「消费者咨询」有 24 小时时限，运营必须看得到',
  );
  // 道谢类不需要时限提醒（没有待办）。
  const thanks = buildTemuDraft({ buyer: 'Ann', storeName: STORE, inbound: 'Thank you so much' });
  assert.equal(thanks.intent, 'acknowledge');
  assert.equal(
    thanks.notes.some((note) => note.indexOf('24 小时') >= 0),
    false,
    '道谢类不该挂时限提醒',
  );
});

test('全部意图都不出现平台路径 / 已完成动作的断言', () => {
  const samples = {
    replacement: 'The leg arrived broken, I need a replacement part',
    refund: 'I want my money back',
    shipping: 'My parcel has not arrived yet',
    return: 'I would like to return this',
    cancel: 'Please cancel my order',
    invoice: 'Can you send me a receipt?',
    acknowledge: 'Thank you so much',
    inquiry: 'I have a question about this product',
  };
  for (const [intent, inbound] of Object.entries(samples)) {
    const draft = buildTemuDraft({ buyer: 'Ann', storeName: STORE, inbound });
    assert.equal(draft.intent, intent, inbound + ' 应判成 ' + intent);
    assertNoPlatformClaims(draft.body);
    assert.match(draft.body, /Hello Ann,/);
    assert.match(draft.body, /Best regards,/);
    assert.equal(typeof draft.summary, 'string');
  }
});

test('非英语买家与「按主题判意图」都要留下提示，不假装看得懂', () => {
  const french = buildTemuDraft({
    buyer: 'Ann',
    storeName: STORE,
    inbound: 'Bonjour, je voudrais un remboursement pour ma commande',
  });
  assert.ok(
    french.notes.some((note) => note.indexOf('买家语言可能是') >= 0),
    '非英语要提示人工按买家语言调整',
  );

  const bySubject = buildTemuDraft({ buyer: 'Ann', storeName: STORE, subject: 'Return & Refund/Wrong item', inbound: 'Hello' });
  assert.ok(
    bySubject.notes.some((note) => note.indexOf('按会话主题判的') >= 0),
    '正文没有诉求时要说明意图来自主题',
  );
});

test('地址：多地址时列出来让买家确认，不替买家猜', () => {
  const draft = buildTemuDraft({
    buyer: 'Ann',
    storeName: STORE,
    inbound:
      'Please send the replacement to 12 Main St, Springfield, IL 62704 or 48 Oak Ave, Springfield, IL 62704',
  });
  assert.ok(draft.address.count >= 2, '要认出两个候选地址');
  assert.match(draft.body, /more than one address/i);
  assert.match(draft.body, /confirm which of these/i);
});

/* ── 话术口径（v0.14.0）：损坏直接要照片 + 免费补发配件（不是整包），且不索要订单号 ─── */

test('buildTemuDraft：损坏一律直接要照片，并承诺免费补发配件（不是整包）', () => {
  const draft = buildTemuDraft({
    buyer: 'Ann',
    storeName: STORE,
    subject: 'Damaged item',
    inbound: 'The leg arrived broken. I need a replacement part.',
  });
  assert.equal(draft.intent, 'replacement');
  assert.match(draft.body, /photo/i, '要直接索要照片');
  assert.match(draft.body, /free of charge/i, '要承诺免费补发');
  assert.match(draft.body, /part only, not the whole set/i, '补的是配件，不是整包');
  assertNoPlatformClaims(draft.body);
});

test('buildTemuDraft：一般咨询不再向买家索要订单号', () => {
  const draft = buildTemuDraft({ buyer: 'Ann', storeName: STORE, inbound: 'Hello, I have a question' });
  assert.equal(draft.intent, 'inquiry');
  assert.equal(
    /order (?:number|id)|reference number|订单号/i.test(draft.body),
    false,
    '不再向买家索要订单号',
  );
});
