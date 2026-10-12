import assert from 'node:assert/strict';
import test from 'node:test';
import { INTENTS, brandFromStoreName as brandFromStoreName_AMAZON_TRAP, classifyIntent } from '../lib/reply.js';
import {
  brandFromTikTokStoreName,
  buildTikTokDraft,
  extractTikTokOrderId,
} from '../lib/reply-tiktok.js';

/** 正文里禁止出现的亚马逊口径词与联系方式。 */
const FORBIDDEN_IN_BODY = [
  [/amazon/i, '不得出现 Amazon 字样（买家在 TikTok Shop，指到亚马逊是事故）'],
  [/your orders/i, '不得出现亚马逊账户页的叫法 Your Orders'],
  [/amazon account/i, '不得出现 Amazon account'],
  [/@/, '站内信不允许邮箱'],
  [/https?:\/\//i, '站内信不允许链接'],
];

/**
 * 每个意图一条真实感的买家消息。
 * 这套样本同时用来钉住「意图维度必须与亚马逊线一致」——
 * 键集合与 lib/reply.js 的 INTENTS 比对，多一个少一个都会挂。
 */
const SAMPLES = {
  replacement: 'The item arrived damaged, I need a replacement',
  refund: 'I would like a refund please',
  shipping: 'My package did not arrive, where is my order?',
  return: 'I want to return this item',
  cancel: 'Please cancel my order',
  invoice: 'Can you send me an invoice for my order?',
  acknowledge: 'Thank you so much!!',
  inquiry: 'Hello, I have a question',
};

test('意图体系与亚马逊线完全一致（同一套 INTENTS，不能裂成两套维度）', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...INTENTS].sort());
});

test('buildTikTokDraft：八个意图各判一例，且都被判对', () => {
  for (const intent of INTENTS) {
    const draft = buildTikTokDraft({
      buyer: 'sam',
      subject: '',
      inbound: SAMPLES[intent],
      storeName: 'Tiktok-FUSOU-客服主号',
    });
    assert.equal(draft.intent, intent, SAMPLES[intent]);
    assert.equal(draft.intentLabel, INTENT_LABEL_BY_HAND[intent], intent);
    assert.ok(draft.body.length > 80, intent);
    assert.match(draft.body, /Best regards,\n\nFUSOU Customer Service$/, intent);
  }
});

/** 意图中文标签的快照：与 lib/reply.js 的 INTENT_LABEL 对齐（改了这里就该同步改那边）。 */
const INTENT_LABEL_BY_HAND = Object.freeze({
  replacement: '换货 / 补件',
  refund: '退款',
  shipping: '未收到 / 物流',
  return: '退货',
  cancel: '取消订单',
  invoice: '发票 / 收据',
  acknowledge: '致谢收尾',
  inquiry: '一般咨询',
});

test('classifyIntent 复用自 lib/reply.js，判定结果与亚马逊线逐例相同', () => {
  // 同一句话在两个模块里必须判出同一个意图：这条断言就是「维度不分裂」的保险丝。
  for (const intent of INTENTS) {
    assert.equal(classifyIntent(SAMPLES[intent]).intent, intent, SAMPLES[intent]);
  }
  // 中文同样能判（买家会用中文发消息）。
  assert.equal(classifyIntent('东西破损了，需要补件').intent, 'replacement');
  assert.equal(classifyIntent('还没有收到货').intent, 'shipping');
});

test('buildTikTokDraft：买家最后一条消息优先于会话主题，并透传 intentSource', () => {
  // TikTok 的主题是系统标签，描述的是**最初**的诉求；买家后来改口很常见。
  const draft = buildTikTokDraft({
    buyer: 'jen',
    subject: 'Damaged or defective item: replacement request',
    inbound: 'no thank you i would just like the refund please.',
    storeName: 'Tiktok-FUSOU-客服主号',
  });
  assert.equal(draft.intent, 'refund');
  assert.equal(draft.intentSource, 'message');
  assert.equal(/replacement/i.test(draft.body), false, '买家改口要退款后，草稿不能再提补件');

  // 正文没诉求时才回落到主题，并明确告诉复核的人「这是按主题判的」。
  const fallback = buildTikTokDraft({
    buyer: 'jen',
    subject: 'Damaged or defective item: replacement request',
    inbound: 'here is my new address',
    storeName: 'Tiktok-FUSOU-客服主号',
  });
  assert.equal(fallback.intent, 'replacement');
  assert.equal(fallback.intentSource, 'subject');
  assert.ok(fallback.notes.some((note) => note.includes('主题')), '按主题判意图必须提示人工复读');

  // 两边都判不出来。
  const none = buildTikTokDraft({ buyer: 'x', subject: '', inbound: 'hello there' });
  assert.equal(none.intentSource, 'none');
});

// ---------------------------------------------------------------------------
// 订单号：宁可认不出，也不认错
// ---------------------------------------------------------------------------

test('extractTikTokOrderId：认「带分组分隔符」的高置信形态', () => {
  // TikTok 商家中心按 4 位一组展示订单号，导出表格里也常见连字符写法。
  assert.equal(extractTikTokOrderId('order id: 5771 2345 6789 0123'), '5771 2345 6789 0123');
  assert.equal(extractTikTokOrderId('Order 5771-2345-6789-0123-456'), '5771-2345-6789-0123');
});

test('extractTikTokOrderId：认「带 order 标签的 16-20 位纯数字长串」', () => {
  assert.equal(extractTikTokOrderId('Order number: 5771234567890123456'), '5771234567890123456');
  assert.equal(extractTikTokOrderId('Your order 5771234567890123456 has shipped'), '5771234567890123456');
  assert.equal(extractTikTokOrderId('订单号：5771234567890123456'), '5771234567890123456');
  assert.equal(extractTikTokOrderId('订单编号 577123456789012345'), '577123456789012345');
});

test('extractTikTokOrderId：**不认**裸的长数字串 —— 没有上下文时它和金额/时间戳无法区分', () => {
  // 16 位纯数字既可能是订单号，也确实是分位金额、时间戳。没有 order 标签就一律不认：
  // 认错的代价是把错误订单号发给买家，认不出的代价只是人工补一次。
  assert.equal(extractTikTokOrderId('The item costs 1234567890123456 dollars'), '');
  assert.equal(extractTikTokOrderId('1234567890123456'), '');
  assert.equal(extractTikTokOrderId('20260110163000'), '');
});

test('extractTikTokOrderId：**不认**亚马逊 3-7-7（那是任务之外的平台口径）', () => {
  assert.equal(extractTikTokOrderId('Order number: 113-9341386-0505001'), '');
  assert.equal(extractTikTokOrderId('order 114-6929370-0877848'), '');
});

test('extractTikTokOrderId：**不认**金额、日期、追踪号、SKU', () => {
  assert.equal(extractTikTokOrderId('Total paid $1,234.56 on 2026-01-10'), '');
  assert.equal(extractTikTokOrderId('Tracking number 1Z999AA10123456784'), '');
  assert.equal(extractTikTokOrderId('sku B0CXXRX9BR'), '');
  assert.equal(extractTikTokOrderId('Quantity: 2, price 19.99'), '');
  assert.equal(extractTikTokOrderId(''), '');
  assert.equal(extractTikTokOrderId(null), '');
});

test('extractTikTokOrderId：位数不在区间内的数字串不认', () => {
  assert.equal(extractTikTokOrderId('Order number: 123456789012345'), '', '15 位太短');
  assert.equal(extractTikTokOrderId('Order number: 123456789012345678901'), '', '21 位太长');
});

test('buildTikTokDraft：认不出订单号时返回空串，且 notes 提示补单号', () => {
  const draft = buildTikTokDraft({
    buyer: 'jen',
    subject: 'Question about my order',
    inbound: 'Can you help me with the item I bought?',
    storeName: 'Tiktok-FUSOU-客服主号',
  });
  assert.equal(draft.orderId, '');
  assert.equal(draft.needsHuman, true);
  assert.ok(draft.notes.some((note) => note.includes('订单号')));
  assert.equal(/order \d/.test(draft.body), false, '没订单号就不该在正文里编一个出来');
});

test('buildTikTokDraft：调用方给的订单号优先，且不会被正文里的长数字覆盖', () => {
  const draft = buildTikTokDraft({
    buyer: 'jen',
    subject: 'Damaged item',
    orderId: '5771234567890123456',
    inbound: 'It arrived broken. Order number: 5779999999999999999',
    storeName: 'Tiktok-FUSOU-客服主号',
  });
  assert.equal(draft.orderId, '5771234567890123456');
  assert.match(draft.body, /5771234567890123456/);
  assert.equal(/5779999999999999999/.test(draft.body), false, '不能把正文里另一个单号写进草稿');
});

// ---------------------------------------------------------------------------
// 硬约束：正文口径
// ---------------------------------------------------------------------------

test('buildTikTokDraft：每个意图的正文都不含 amazon / Your Orders / 邮箱 / 链接', () => {
  for (const intent of INTENTS) {
    const draft = buildTikTokDraft({
      buyer: 'sam',
      subject: 'Order help',
      orderId: '5771234567890123456',
      inbound: SAMPLES[intent],
      storeName: 'Tiktok-FUSOU-客服主号',
    });
    for (const [pattern, why] of FORBIDDEN_IN_BODY) {
      assert.equal(pattern.test(draft.body), false, intent + '：' + why);
    }
  }
});

test('buildTikTokDraft：退货与发票模板指向 TikTok Shop 的订单入口，而不是亚马逊的', () => {
  const ret = buildTikTokDraft({
    buyer: 'sam',
    subject: '',
    inbound: SAMPLES.return,
    storeName: 'Tiktok-FUSOU-客服主号',
  });
  assert.match(ret.body, /TikTok Shop/);
  assert.match(ret.body, /return/i);

  const inv = buildTikTokDraft({
    buyer: 'sam',
    subject: '',
    inbound: SAMPLES.invoice,
    storeName: 'Tiktok-FUSOU-客服主号',
  });
  assert.match(inv.body, /TikTok Shop/);
  assert.equal(/your orders/i.test(inv.body), false);
});

// ---------------------------------------------------------------------------
// 品牌署名：绕开 lib/reply.js 里 PLATFORM_TOKENS 不含 tiktok 的坑
// ---------------------------------------------------------------------------

test("brandFromTikTokStoreName：'Tiktok-FUSOU-客服主号' 推出 FUSOU，而不是 'Tiktok'", () => {
  // lib/reply.js 的 PLATFORM_TOKENS = /^(amazon|亚马逊|amzn|com)$/i 不含 tiktok，
  // 直接调 brandFromStoreName 会得到 'Tiktok'，署名变成 'Tiktok Customer Service' —— 一个不存在的品牌。
  assert.equal(brandFromStoreName_AMAZON_TRAP('Tiktok-FUSOU-客服主号'), 'Tiktok');
  assert.equal(brandFromTikTokStoreName('Tiktok-FUSOU-客服主号'), 'FUSOU');
  assert.equal(brandFromTikTokStoreName('TikTok-FUSOU-客服'), 'FUSOU');
  assert.equal(brandFromTikTokStoreName('Tiktok-FUSOU-客服'), 'FUSOU');
  assert.equal(brandFromTikTokStoreName('TikTok-Shop-FUSOU-运营'), 'FUSOU');
  assert.equal(brandFromTikTokStoreName('tiktok-FUSOU-admin'), 'FUSOU');
});

test('brandFromTikTokStoreName：推不出品牌时退化成空串，署名不写错品牌', () => {
  assert.equal(brandFromTikTokStoreName('TikTok-Shop-运营'), '');
  assert.equal(brandFromTikTokStoreName('TikTok-客服'), '');
  assert.equal(brandFromTikTokStoreName(''), '');
  assert.equal(brandFromTikTokStoreName(null), '');

  const draft = buildTikTokDraft({ buyer: 'x', subject: '', inbound: SAMPLES.inquiry, storeName: 'TikTok-Shop-运营' });
  assert.match(draft.body, /Best regards,\n\nCustomer Service$/);
  assert.equal(/Tiktok Customer Service/i.test(draft.body), false);
});

test('buildTikTokDraft：品牌从店铺名推出并进署名', () => {
  const draft = buildTikTokDraft({
    buyer: 'cain',
    subject: '',
    inbound: SAMPLES.replacement,
    storeName: 'Tiktok-FUSOU-客服主号',
  });
  assert.match(draft.body, /FUSOU Customer Service$/);
  assert.equal(/Tiktok Customer Service/i.test(draft.body), false);
});

test('buildTikTokDraft：称呼首字母大写，买家名缺失时退回 Hello,', () => {
  const named = buildTikTokDraft({ buyer: 'jen', subject: '', inbound: SAMPLES.inquiry });
  assert.match(named.body, /^Hello Jen,/);
  const anon = buildTikTokDraft({ subject: '', inbound: SAMPLES.inquiry });
  assert.match(anon.body, /^Hello,/);
});

// ---------------------------------------------------------------------------
// notes / needsHuman 规则
// ---------------------------------------------------------------------------

test('buildTikTokDraft：非英语买家在备注里提示语言', () => {
  const draft = buildTikTokDraft({
    buyer: 'Midia',
    subject: 'Frage zur Bestellung',
    inbound: 'Meine Bestellung ist kaputt',
    storeName: 'Tiktok-FUSOU-客服主号',
  });
  assert.equal(draft.language.code, 'de');
  assert.ok(draft.notes.some((note) => note.includes('德语')));
  assert.equal(draft.needsHuman, true);
});

test('buildTikTokDraft：意图有歧义时标 needsHuman 并提示', () => {
  const draft = buildTikTokDraft({
    buyer: 'x',
    subject: 'damaged',
    inbound: 'It is broken, I want a refund',
    storeName: 'Tiktok-FUSOU-客服主号',
  });
  assert.equal(draft.intent, 'replacement', '更具体的换货优先');
  assert.equal(draft.needsHuman, true);
  assert.ok(draft.notes.some((note) => note.includes('歧义')));
});

test('buildTikTokDraft：退款模板固定提示人工核实退款是否真的操作过', () => {
  const draft = buildTikTokDraft({
    buyer: 'x',
    subject: 'Refund',
    inbound: 'Where is my refund? It has been 10 days.',
    storeName: 'Tiktok-FUSOU-客服主号',
  });
  assert.equal(draft.intent, 'refund');
  assert.ok(draft.notes.some((note) => note.includes('退款')));
  assert.equal(draft.needsHuman, true);
});

test('buildTikTokDraft：识别出的订单号会提示与订单页核对一次', () => {
  const draft = buildTikTokDraft({
    buyer: 'x',
    subject: '',
    inbound: 'My order is late. Order number: 5771234567890123456',
    storeName: 'Tiktok-FUSOU-客服主号',
  });
  assert.ok(draft.notes.some((note) => note.includes('核对')));
});

test('buildTikTokDraft：纯致谢不反问、不标 needsHuman', () => {
  const draft = buildTikTokDraft({
    buyer: 'Erica',
    subject: 'Inquiry from TikTok Shop customer Erica',
    inbound: 'Thank you, so much!!',
    storeName: 'Tiktok-FUSOU-客服主号',
  });
  assert.equal(draft.intent, 'acknowledge');
  assert.equal(/share a little more detail/.test(draft.body), false, '不能反问买家');
  assert.equal(/invoice|refund|replacement/i.test(draft.body), false, '不能提不相关的事');
  assert.equal(draft.needsHuman, false, '寒暄不涉及订单，缺订单号不该标需人工');
  assert.equal(draft.orderId, '');
});

test('buildTikTokDraft：summary 带上买家/意图/订单号，便于队列页展示', () => {
  const draft = buildTikTokDraft({
    buyer: 'jen',
    subject: 'Damaged item',
    orderId: '5771234567890123456',
    inbound: SAMPLES.replacement,
    storeName: 'Tiktok-FUSOU-客服主号',
  });
  assert.match(draft.summary, /jen/);
  assert.match(draft.summary, /换货/);
  assert.match(draft.summary, /5771234567890123456/);
});

test('buildTikTokDraft：多地址时列出候选让买家确认，而不是替买家猜', () => {
  const draft = buildTikTokDraft({
    buyer: 'cain',
    subject: '',
    inbound:
      "It broke at 3 Cribbins court Huntsville AL 35808 but we moved, our new address is 6 Crandall Court Fort Rucker, AL 36362",
    storeName: 'Tiktok-FUSOU-客服主号',
  });
  assert.equal(draft.address.count, 2);
  assert.match(draft.body, /more than one address/i);
  assert.match(draft.body, /6 Crandall Court/);
});

test('buildTikTokDraft：零参数调用不抛异常', () => {
  const draft = buildTikTokDraft();
  assert.equal(draft.intent, 'inquiry');
  assert.ok(draft.body.length > 0);
});

/* ── 话术口径（v0.14.0）：损坏直接要照片 + 免费补发配件（不是整包），且不索要订单号 ─── */

test('buildTikTokDraft：损坏一律直接要照片，并承诺免费补发配件（不是整包）', () => {
  const draft = buildTikTokDraft({
    buyer: 'Jen',
    subject: 'Damaged item',
    inbound: 'The leg arrived broken. I need a replacement part.',
    storeName: 'Tiktok-FUSOU-客服主号',
  });
  assert.equal(draft.intent, 'replacement');
  assert.match(draft.body, /photo/i, '要直接索要照片');
  assert.match(draft.body, /free of charge/i, '要承诺免费补发');
  assert.match(draft.body, /part only, not the whole set/i, '补的是配件，不是整包');
});

test('buildTikTokDraft：任何意图都不向买家索要订单号', () => {
  for (const intent of INTENTS) {
    const draft = buildTikTokDraft({
      buyer: 'sam',
      subject: '',
      inbound: SAMPLES[intent],
      storeName: 'Tiktok-FUSOU-客服主号',
    });
    assert.equal(
      /order (?:number|id)|reference number|订单号/i.test(draft.body),
      false,
      intent + '：正文里不能向买家索要订单号',
    );
  }
});
