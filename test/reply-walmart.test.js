import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTENTS as INTENTS_AMAZON,
  INTENT_LABEL as INTENT_LABEL_AMAZON,
  brandFromStoreName as brandFromStoreName_AMAZON,
  classifyIntent as classifyIntent_AMAZON,
} from '../lib/reply.js';
import {
  INTENTS,
  INTENT_LABEL,
  brandFromWalmartStoreName,
  buildWalmartDraft,
  extractWalmartOrderId,
} from '../lib/reply-walmart.js';

/** 正文里禁止出现的其它平台口径词与联系方式（沃尔玛站内信里出现这些是事故）。 */
const FORBIDDEN_IN_BODY = [
  [/amazon/i, '不得出现 Amazon 字样（买家在沃尔玛，指到亚马逊是事故）'],
  [/your orders/i, '不得出现亚马逊账户页的叫法 Your Orders'],
  [/amazon account/i, '不得出现 Amazon account'],
  [/tiktok/i, '不得出现 TikTok 字样'],
  [/@/, '站内信不允许邮箱'],
  [/https?:\/\//i, '站内信不允许链接'],
];

/**
 * 每个意图一条真实感的买家消息。
 * 这套样本同时用来钉住「意图维度必须与其它渠道一致」——
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
  // 不只是值相等：必须是**同一个引用**，否则统计页会按渠道裂成两套互不相认的意图。
  assert.equal(INTENTS, INTENTS_AMAZON);
  assert.equal(INTENT_LABEL, INTENT_LABEL_AMAZON);
  // classifyIntent 返回的是判定对象（intent / matched / source / ambiguous），不是裸字符串。
  assert.equal(classifyIntent_AMAZON('I want a refund').intent, 'refund');
});

test('buildWalmartDraft：八个意图各判一例，且都被判对', () => {
  for (const intent of INTENTS) {
    const draft = buildWalmartDraft({ buyer: 'Jen', inbound: SAMPLES[intent], storeName: 'Walmart-Cozynome-管理员' });
    assert.equal(draft.intent, intent, SAMPLES[intent]);
    // inquiry 是「没有任何规则命中时的兜底」，来源如实标 none —— 这是它和其它七个意图的区别。
    assert.equal(draft.intentSource, intent === 'inquiry' ? 'none' : 'message', SAMPLES[intent]);
    assert.ok(draft.body.startsWith('Hello Jen,'), '称呼要带上买家名');
    assert.match(draft.body, /Best regards,/);
    assert.match(draft.body, /Cozynome Customer Service/, '署名用店铺名推出来的品牌');
  }
});

test('buildWalmartDraft：买家最后一条消息优先于会话主题，并透传 intentSource', () => {
  // 主题说的是「退货」，买家最后一句改口要退款 —— 按主题判就会生成一封跟买家刚说的话相反的草稿。
  const draft = buildWalmartDraft({
    buyer: 'Salena',
    subject: 'Initiate a return',
    inbound: 'I no longer want to return it, I want a full refund',
    storeName: 'Walmart-Cozynome-管理员',
  });
  assert.equal(draft.intent, 'refund');
  assert.equal(draft.intentSource, 'message');
  const bySubject = buildWalmartDraft({
    buyer: 'Salena',
    subject: 'Initiate a return',
    inbound: '',
    storeName: 'Walmart-Cozynome-管理员',
  });
  assert.equal(bySubject.intent, 'return');
  assert.equal(bySubject.intentSource, 'subject', '正文没线索时退回主题，并如实标出来源');
});

/* ── 订单号：认高置信形态，宁可认不出也不认错 ─────────────────────────────── */

test('extractWalmartOrderId：认实机的 15 位、20 开头形态（三例都对）', () => {
  assert.equal(extractWalmartOrderId('Initiate a return, 200015455387691'), '200015455387691');
  assert.equal(extractWalmartOrderId('please contact the customer 200015267917133'), '200015267917133');
  assert.equal(extractWalmartOrderId('Where is my order, 200015136249041'), '200015136249041');
});

test('extractWalmartOrderId：认 13 位、20 开头的老订单形态', () => {
  assert.equal(extractWalmartOrderId('Order 2000135994612 has shipped'), '2000135994612');
});

test('extractWalmartOrderId：15 位裸数字必须自带 order 标签（采购订单号就是这一种）', () => {
  // 实机 9/30 的采购订单号：129126392363631 —— 不以 20 开头，只能靠上下文标签认定。
  assert.equal(extractWalmartOrderId('Purchase Order #129126392363631 was created'), '129126392363631');
  // 同一个数字，没有标签时一律不认：它和金额/追踪号/时间戳长得一模一样。
  assert.equal(extractWalmartOrderId('the number is 129126392363631'), '');
});

test('extractWalmartOrderId：**不认**亚马逊 3-7-7 与 TikTok 的 16 位串', () => {
  assert.equal(extractWalmartOrderId('order 113-9341386-0505001'), '', '亚马逊形态不属于本平台');
  assert.equal(extractWalmartOrderId('order 5771234567890123 shipped'), '', 'TikTok 16 位不属于本平台');
});

test('extractWalmartOrderId：**不认**金额、日期时间戳、追踪号、SKU', () => {
  assert.equal(extractWalmartOrderId('total $1,234.56 paid'), '');
  assert.equal(extractWalmartOrderId('20261010163000 UTC'), '');
  assert.equal(extractWalmartOrderId('tracking 1Z999AA10123456784'), '');
  assert.equal(extractWalmartOrderId('SKU B0CXXRX9BR'), '');
  assert.equal(extractWalmartOrderId(''), '');
  assert.equal(extractWalmartOrderId('   '), '');
});

test('buildWalmartDraft：认不出订单号时返回空串，且 notes 提示补单号', () => {
  const draft = buildWalmartDraft({ buyer: 'Jen', inbound: 'I want a refund', storeName: 'Walmart-Cozynome-管理员' });
  assert.equal(draft.orderId, '');
  assert.ok(draft.notes.some((note) => note.includes('订单号')), '缺订单号要提示');
  assert.equal(draft.needsHuman, true);
});

test('buildWalmartDraft：调用方给的订单号优先，不会被正文里的长数字覆盖', () => {
  const draft = buildWalmartDraft({
    buyer: 'Jen',
    inbound: 'my order 200015455387691',
    orderId: '200015999999999',
    storeName: 'Walmart-Cozynome-管理员',
  });
  assert.equal(draft.orderId, '200015999999999');
  assert.match(draft.body, /order 200015999999999/);
  assert.equal(/200015455387691/.test(draft.body), false, '不能把两个单号混在一封草稿里');
});

/* ── 模板口径：不许出现别的平台路径，也不许承诺没核实过的处理 ─────────────── */

test('buildWalmartDraft：每个意图的正文都不含 amazon / tiktok / Your Orders / 邮箱 / 链接', () => {
  for (const intent of INTENTS) {
    const draft = buildWalmartDraft({ buyer: 'Jen', inbound: SAMPLES[intent], storeName: 'Walmart-Cozynome-管理员' });
    for (const [pattern, why] of FORBIDDEN_IN_BODY) {
      assert.equal(pattern.test(draft.body), false, intent + '：' + why);
    }
  }
});

test('buildWalmartDraft：退货模板指向 Walmart 账户里的订单记录，而不是亚马逊的 Your Orders', () => {
  const draft = buildWalmartDraft({
    buyer: 'Angelo',
    inbound: 'I need to return this item',
    orderId: '200015136249041',
    storeName: 'Walmart-Cozynome-管理员',
  });
  assert.match(draft.body, /Walmart account/, '要指到 Walmart 账户的订单历史');
  assert.equal(/Your Orders/i.test(draft.body), false);
  assert.equal(/Amazon/i.test(draft.body), false);
});

test('buildWalmartDraft：退款/退货模板**只承接、不断言** —— 不许写「已办理 / X 个工作日到账 / 面单已给」', () => {
  const refund = buildWalmartDraft({ buyer: 'Jen', inbound: 'I would like a refund', storeName: 'Walmart-Cozynome-管理员' });
  // 这两类话是最容易「发出去就出事」的断言：退款有没有真的办、多久到账，模板并不知道。
  assert.equal(/has been (issued|processed|refunded)|3 to 5 business days|will be refunded within/i.test(refund.body), false, '退款不接受未经核实的时间/状态断言');
  assert.match(refund.body, /checking|confirm/, '要明确说「正在核实、会在这个会话里给结论」');

  const ret = buildWalmartDraft({ buyer: 'Jen', inbound: 'I want to return this item', storeName: 'Walmart-Cozynome-管理员' });
  assert.equal(/here is your (return )?label|we have (sent|attached|issued) (you )?a (return )?label/i.test(ret.body), false, '不许承诺面单已经给了');
  assert.match(ret.body, /checking|come back to you/, '要承接住并说明会回话');
});

test('buildWalmartDraft：退款与退货都必须提示人工核实（沃尔玛这条线的硬口径）', () => {
  const refund = buildWalmartDraft({ buyer: 'Jen', inbound: 'I would like a refund', storeName: 'Walmart-Cozynome-管理员' });
  assert.ok(refund.notes.some((note) => note.includes('退款必须人工核实')), '退款必须挂人工审核提示');
  const ret = buildWalmartDraft({ buyer: 'Jen', inbound: 'I want to return this item', storeName: 'Walmart-Cozynome-管理员' });
  assert.ok(ret.notes.some((note) => note.includes('退货/面单必须人工核实')), '退货必须挂人工审核提示');
  // 9/30 实机就是因为退货面单反复答非所问升级成纠纷，这条提示要带上「别只重复问同一个问题」。
  assert.ok(ret.notes.some((note) => note.includes('不要只重复问买家同一个问题')));
});

/* ── 品牌与署名 ───────────────────────────────────────────────────────────── */

test('brandFromWalmartStoreName：剔除平台词，不把 Walmart 当品牌', () => {
  assert.equal(brandFromWalmartStoreName('Walmart-Cozynome-管理员'), 'Cozynome');
  assert.equal(brandFromWalmartStoreName('Walmart-Yanosaku二店-管理员'), 'Yanosaku二店');
  // 公共实现（亚马逊口径）会把 Walmart 当品牌 —— 这正是本模块要修的那个坑。
  assert.equal(brandFromStoreName_AMAZON('Walmart-Cozynome-管理员'), 'Walmart');
  assert.equal(brandFromWalmartStoreName(''), '');
});

test('buildWalmartDraft：推不出品牌时署名退化成 Customer Service，不写错品牌', () => {
  const draft = buildWalmartDraft({ buyer: 'Jen', inbound: 'I have a question', storeName: 'Walmart-管理员' });
  assert.match(draft.body, /Customer Service$/);
  assert.equal(/Walmart Customer Service/.test(draft.body), false, '署名里不能出现平台名');
});

test('buildWalmartDraft：称呼首字母大写，买家名缺失时退回 Hello,', () => {
  const withName = buildWalmartDraft({ buyer: 'jen', inbound: 'hello', storeName: 'Walmart-Cozynome-管理员' });
  assert.ok(withName.body.startsWith('Hello Jen,'));
  const noName = buildWalmartDraft({ inbound: 'hello', storeName: 'Walmart-Cozynome-管理员' });
  assert.ok(noName.body.startsWith('Hello,'));
  assert.equal(noName.summary.startsWith('买家'), true);
});

/* ── notes 与摘要 ─────────────────────────────────────────────────────────── */

test('buildWalmartDraft：非英语买家在备注里提示语言', () => {
  const draft = buildWalmartDraft({
    buyer: 'Ana',
    // 判语言靠虚词命中数，样本要给够（这条实测能判出 es）。
    inbound: 'Hola, mi pedido no ha llegado y necesito una solución por favor',
    storeName: 'Walmart-Cozynome-管理员',
  });
  assert.notEqual(draft.language.code, 'en');
  assert.ok(draft.notes.some((note) => note.includes('草稿是英文')));
  assert.equal(draft.needsHuman, true);
});

test('buildWalmartDraft：意图有歧义时标 needsHuman 并提示', () => {
  const draft = buildWalmartDraft({
    buyer: 'Jen',
    inbound: 'The item is damaged, I want a replacement or a refund',
    storeName: 'Walmart-Cozynome-管理员',
  });
  // "replacement or refund" 要落到更具体的 replacement（与其它渠道一致），同时标出歧义。
  assert.equal(draft.intent, 'replacement');
  assert.ok(draft.notes.some((note) => note.includes('歧义')));
  assert.equal(draft.needsHuman, true);
});

test('buildWalmartDraft：识别出的订单号会提示与沃尔玛订单页核对一次', () => {
  const draft = buildWalmartDraft({
    buyer: 'Jen',
    inbound: 'I want a refund for order 200015455387691',
    storeName: 'Walmart-Cozynome-管理员',
  });
  assert.equal(draft.orderId, '200015455387691');
  assert.ok(draft.notes.some((note) => note.includes('与沃尔玛订单页核对')));
});

test('buildWalmartDraft：纯致谢不反问、不为「缺订单号」制造无意义的人工项', () => {
  const draft = buildWalmartDraft({ buyer: 'Jen', inbound: 'Thank you so much!!', storeName: 'Walmart-Cozynome-管理员' });
  assert.equal(draft.intent, 'acknowledge');
  assert.equal(draft.orderId, '');
  assert.equal(draft.notes.some((note) => note.includes('没能从会话里解出订单号')), false);
  assert.equal(draft.needsHuman, false);
});

test('buildWalmartDraft：summary 带上买家/意图/订单号，便于队列页展示', () => {
  const draft = buildWalmartDraft({
    buyer: 'Salena Fuller',
    subject: 'Initiate a return, 200015455387691',
    inbound: 'Yes. Please send a label so I can return one please',
    storeName: 'Walmart-Cozynome-管理员',
  });
  assert.match(draft.summary, /Salena Fuller/);
  assert.match(draft.summary, /200015455387691/);
  assert.ok(INTENTS.includes(draft.intent));
});

test('buildWalmartDraft：多地址时列出候选让买家确认，而不是替买家猜', () => {
  const draft = buildWalmartDraft({
    buyer: 'Jen',
    inbound:
      'Please ship it to 100 Main St, Springfield, IL 62704. My old address was 200 Oak Ave, Dayton, OH 45402.',
    storeName: 'Walmart-Cozynome-管理员',
  });
  assert.ok(draft.address.count > 1, '两个地址都要抠出来');
  assert.match(draft.body, /more than one address/);
  assert.match(draft.body, /Please confirm which of these/);
});

test('buildWalmartDraft：零参数调用不抛异常', () => {
  const draft = buildWalmartDraft();
  assert.equal(typeof draft.body, 'string');
  assert.ok(Array.isArray(draft.notes));
  assert.ok(INTENTS.includes(draft.intent));
});

/* ── 话术口径（v0.14.0）：损坏直接要照片 + 免费补发配件（不是整包），且不索要订单号 ─── */

test('buildWalmartDraft：损坏一律直接要照片，并承诺免费补发配件（不是整包）', () => {
  const draft = buildWalmartDraft({
    buyer: 'Jen',
    subject: 'Damaged item',
    inbound: 'The leg arrived broken. I need a replacement part.',
    storeName: 'Walmart-Cozynome-管理员',
  });
  assert.equal(draft.intent, 'replacement');
  assert.match(draft.body, /photo/i, '要直接索要照片');
  assert.match(draft.body, /free of charge/i, '要承诺免费补发');
  assert.match(draft.body, /part only, not the whole set/i, '补的是配件，不是整包');
});

test('buildWalmartDraft：任何意图都不向买家索要订单号', () => {
  for (const intent of INTENTS) {
    const draft = buildWalmartDraft({
      buyer: 'sam',
      subject: '',
      inbound: SAMPLES[intent],
      storeName: 'Walmart-Cozynome-管理员',
    });
    assert.equal(
      /order (?:number|id)|reference number|订单号/i.test(draft.body),
      false,
      intent + '：正文里不能向买家索要订单号',
    );
  }
});
