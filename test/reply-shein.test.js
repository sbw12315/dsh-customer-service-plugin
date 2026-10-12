import assert from 'node:assert/strict';
import test from 'node:test';
import { INTENT_LABEL, INTENTS, classifyIntent } from '../lib/reply.js';
import {
  INTENTS as SHEIN_INTENTS,
  brandFromSheinStoreName,
  buildSheinDraft,
  resolveSheinOrderId,
} from '../lib/reply-shein.js';

const STORE = 'Shein-SevenVanity-US-客服';

/** 断言一段草稿里没有任何「平台路径 / 已完成动作」的断言。 */
function assertNoPlatformClaims(body) {
  assert.equal(/amazon|亚马逊/i.test(body), false, '不能出现亚马逊字样：客服会照着别人的路径去操作');
  assert.equal(/your orders|order page|account under/i.test(body), false, '不能承诺具体平台路径');
  assert.equal(
    /already (?:been )?(?:processed|refunded|shipped|sent)|has been (?:processed|refunded)|within \d+ business days/i.test(body),
    false,
    '不能断言动作已完成或给出固定时效',
  );
}

test('意图体系与主模板族共用一套（否则统计页会按渠道裂成两套口径）', () => {
  assert.deepEqual(SHEIN_INTENTS, INTENTS);
  assert.equal(INTENT_LABEL.refund, '退款');
  assert.equal(classifyIntent('I want a refund please').intent, 'refund');
});

test('品牌：剔掉 SHEIN 平台词，署名不能变成平台官方', () => {
  assert.equal(brandFromSheinStoreName(STORE), 'SevenVanity');
  assert.equal(brandFromSheinStoreName('Shein-FUSOU-UK-客服'), 'FUSOU');
  // 推不出就不署名 —— 写 'Shein Customer Service' 会被买家当成平台官方客服。
  assert.equal(brandFromSheinStoreName('SHEIN-英国-自运营'), '');
  const draft = buildSheinDraft({ buyer: 'Ann', storeName: STORE, inbound: 'Where is my order?' });
  assert.match(draft.body, /SevenVanity Customer Service/);
  assert.equal(/Shein Customer Service/i.test(draft.body), false);
});

test('订单号一律不认：只有调用方明确给了才用（SHEIN 订单号形态未校准）', () => {
  // 会话里出现各种数字串（疑似会话 ID、15 位串），都不能被当成订单号。
  const inbound = 'My order SUR8PVPHLIG7I8028 shows 123456789012345 and I need help';
  assert.equal(resolveSheinOrderId({}), '');
  assert.equal(resolveSheinOrderId({ orderId: '  ' }), '');
  const draft = buildSheinDraft({ buyer: 'Ann', storeName: STORE, inbound });
  assert.equal(draft.orderId, '', '不猜订单号：认错单号不可逆');
  assert.equal(draft.body.indexOf('SUR8PVPHLIG7I8028'), -1, '会话 ID 不能出现在正文里');
  assert.ok(
    draft.notes.some((note) => note.indexOf('SHEIN 订单号形态尚未校准') >= 0),
    '要提示人工补订单号',
  );

  // 适配器真读到了订单号时照样能用。
  const withId = buildSheinDraft({ buyer: 'Ann', storeName: STORE, inbound: 'Where is my order?', orderId: 'GSH123456789' });
  assert.equal(withId.orderId, 'GSH123456789');
  assert.match(withId.body, /\(order GSH123456789\)/);
});

test('模板口径：退款 / 退货 / 发票只承接、不断言，并强制挂人工核实', () => {
  const cases = [
    ['I want a refund for this order', 'refund', /人工核实/],
    ['I want to return this item', 'return', /人工核实/],
    ['Please send me the invoice for my order', 'invoice', /人工核对/],
  ];
  for (const [inbound, intent, notePattern] of cases) {
    const draft = buildSheinDraft({ buyer: 'Ann', storeName: STORE, inbound });
    assert.equal(draft.intent, intent, inbound + ' 应判成 ' + intent);
    assertNoPlatformClaims(draft.body);
    assert.equal(draft.needsHuman, true, '这条线必须人工过一遍');
    assert.ok(
      draft.notes.some((note) => notePattern.test(note)),
      intent + ' 的草稿要带人工核实提示',
    );
  }
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
    const draft = buildSheinDraft({ buyer: 'Ann', storeName: STORE, inbound });
    assert.equal(draft.intent, intent, inbound + ' 应判成 ' + intent);
    assertNoPlatformClaims(draft.body);
    assert.match(draft.body, /Hello Ann,/);
    assert.match(draft.body, /Best regards,/);
    assert.equal(typeof draft.summary, 'string');
  }
});

test('非英语买家与「按主题判意图」都要留下提示，不假装看得懂', () => {
  const french = buildSheinDraft({
    buyer: 'Ann',
    storeName: STORE,
    inbound: 'Bonjour, je voudrais un remboursement pour ma commande',
  });
  assert.ok(
    french.notes.some((note) => note.indexOf('买家语言可能是') >= 0),
    '非英语要提示人工按买家语言调整',
  );

  const bySubject = buildSheinDraft({ buyer: 'Ann', storeName: STORE, subject: 'Return & Refund/Wrong item', inbound: 'Hello' });
  assert.ok(
    bySubject.notes.some((note) => note.indexOf('按会话主题判的') >= 0),
    '正文没有诉求时要说明意图来自主题',
  );
});

test('地址：多地址时列出来让买家确认，不替买家猜', () => {
  const draft = buildSheinDraft({
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

test('buildSheinDraft：损坏一律直接要照片，并承诺免费补发配件（不是整包）', () => {
  const draft = buildSheinDraft({
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

test('buildSheinDraft：一般咨询不再向买家索要订单号', () => {
  const draft = buildSheinDraft({ buyer: 'Ann', storeName: STORE, inbound: 'Hello, I have a question' });
  assert.equal(draft.intent, 'inquiry');
  assert.equal(
    /order (?:number|id)|reference number|订单号/i.test(draft.body),
    false,
    '不再向买家索要订单号',
  );
});
