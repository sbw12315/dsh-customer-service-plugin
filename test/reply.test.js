import assert from 'node:assert/strict';
import test from 'node:test';
import {
  INTENTS,
  brandFromStoreName,
  buildDraft,
  classifyIntent,
  detectLanguage,
  extractAddress,
  extractOrderId,
  hasCjk,
  summarizeThread,
} from '../lib/reply.js';

test('classifyIntent：按优先级判意图，换货优先于退款', () => {
  assert.equal(classifyIntent('The item arrived damaged, I want a replacement').intent, 'replacement');
  assert.equal(classifyIntent('I would like a refund please').intent, 'refund');
  assert.equal(classifyIntent('My package did not arrive, where is my order?').intent, 'shipping');
  assert.equal(classifyIntent('I want to return this item').intent, 'return');
  assert.equal(classifyIntent('Please cancel order 111-2222222-3333333').intent, 'cancel');
  assert.equal(classifyIntent('Hello, I have a question').intent, 'inquiry');
});

test('classifyIntent：同时命中多个时标歧义，但仍取更具体的那个', () => {
  const r = classifyIntent('The mirror is broken, can I get a replacement or a refund?');
  assert.equal(r.intent, 'replacement');
  assert.equal(r.ambiguous, true);
});

test('classifyIntent：买家最后一条消息优先于系统主题（真实会话踩过的坑）', () => {
  // 亚马逊给这个会话起的主题是 "…Request a replacement item"，
  // 但买家在卖家提了换货之后回了两次 "no thank you i would jus like the refund please"。
  const subject = 'Damaged or defective item: Request a replacement item(Order: 114-6929370-08…)';
  const last = 'no thank you i would jus like the refund please.';
  const result = classifyIntent(last, subject);
  assert.equal(result.intent, 'refund');
  assert.equal(result.source, 'message');

  // 买家最后一条里没有诉求时，才回落到主题。
  const fallback = classifyIntent('here is my new address: 6 Crandall Court Fort Rucker, AL 36362', subject);
  assert.equal(fallback.intent, 'replacement');
  assert.equal(fallback.source, 'subject');

  // 两边都判不出来。
  assert.equal(classifyIntent('hello', '').source, 'none');
});

test('buildDraft：买家改口要退款时，草稿不能再写「给你补件」', () => {
  const draft = buildDraft({
    buyer: 'jen',
    subject: 'Damaged or defective item: Request a replacement item(Order: 114-6929370-08…)',
    orderId: '114-6929370-0877848',
    inbound: 'no thank you i would jus like the refund please.',
    storeName: 'Amazon-Cozynome-管理员',
  });
  assert.equal(draft.intent, 'refund');
  assert.equal(draft.intentSource, 'message');
  assert.equal(/replacement/i.test(draft.body), false, '不能再提补件');
  assert.match(draft.body, /refund/i);
  // 退款模板是断言句，必须提示人工核实。
  assert.equal(draft.needsHuman, true);
});

test('classifyIntent：中文也能判', () => {
  assert.equal(classifyIntent('东西破损了，需要补件').intent, 'replacement');
  assert.equal(classifyIntent('还没有收到货').intent, 'shipping');
});

test('extractOrderId：只认 3-7-7 形式的亚马逊订单号', () => {
  assert.equal(extractOrderId('Order number: 113-9341386-0505001'), '113-9341386-0505001');
  assert.equal(extractOrderId('order 123-4567890-1234567'), '123-4567890-1234567');
  assert.equal(extractOrderId('sku B0CXXRX9BR'), '');
  assert.equal(extractOrderId(''), '');
});

test('extractAddress：一条消息里两个地址都要抠出来，且不能把 Huntsville 里的 il 当成州', () => {
  const text =
    "Our precious address is Cain Baker 3 Cribbins court Huntsville AL 35808 that's where it was delivered " +
    'and where it was when it broke. Last week we moved our new address is 6 Crandall Court Fort Rucker, AL 36362';
  const address = extractAddress(text);
  assert.equal(address.hasAddress, true);
  assert.equal(address.count, 2);
  assert.deepEqual(address.items[0], {
    street: '3 Cribbins court',
    city: 'Huntsville',
    state: 'AL',
    zip: '35808',
    line: '3 Cribbins court, Huntsville, AL 35808',
    lines: ['3 Cribbins court', 'Huntsville, AL 35808'],
  });
  assert.equal(address.items[1].zip, '36362');
  assert.equal(address.items[1].state, 'AL');
});

test('extractAddress：普通咨询文本不会被误判成地址', () => {
  const address = extractAddress('It arrived cracked and I threw the glass away for safety. I just need replacement glass.');
  assert.equal(address.hasAddress, false);
  assert.equal(address.count, 0);
});

test('detectLanguage：识别常见买家语言，纯英文退回 en', () => {
  assert.equal(detectLanguage('Meine Bestellung ist kaputt, bitte helfen').code, 'de');
  assert.equal(detectLanguage('Mi pedido no ha llegado, gracias').code, 'es');
  assert.equal(detectLanguage('你好，我的订单有问题').code, 'zh');
  assert.equal(detectLanguage('Where is my package?').code, 'en');
});

test('brandFromStoreName：从店铺名推品牌，推不出就空串', () => {
  assert.equal(brandFromStoreName('Amazon-Cozynome-管理员'), 'Cozynome');
  assert.equal(brandFromStoreName('Amazon-FUSOU-客服'), 'FUSOU');
  assert.equal(brandFromStoreName('亚马逊-美国'), '');
  assert.equal(brandFromStoreName(''), '');
});

test('buildDraft：换货草稿含订单号、地址确认与品牌署名，且不出现邮箱/链接', () => {
  const draft = buildDraft({
    buyer: 'cain',
    subject: 'Damaged or defective item: Request a replacement item(Order: 113-9341386-05…)',
    orderId: '113-9341386-0505001',
    inbound:
      "Our precious address is Cain Baker 3 Cribbins court Huntsville AL 35808 that's where it was delivered " +
      'and where it was when it broke. Last week we moved our new address is 6 Crandall Court Fort Rucker, AL 36362',
    storeName: 'Amazon-Cozynome-管理员',
  });
  assert.equal(draft.intent, 'replacement');
  // 这一条真实会话里买家自己写了 "where it was when it broke"，所以意图来自买家的话
  // 而不是系统主题；「只剩主题可依据」那条路径在 classifyIntent 的用例里单独断言。
  assert.equal(draft.intentSource, 'message');
  assert.equal(draft.orderId, '113-9341386-0505001');
  assert.match(draft.body, /^Hello Cain,/);
  assert.match(draft.body, /113-9341386-0505001/);
  assert.match(draft.body, /6 Crandall Court/);
  assert.match(draft.body, /Cozynome Customer Service$/);
  assert.equal(draft.needsHuman, false);
  // 亚马逊站内信会把邮箱和链接拦掉，模板里绝不能出现。
  assert.equal(/@|https?:\/\//.test(draft.body), false);
});

test('buildDraft：没解出订单号时给人工提示', () => {
  const draft = buildDraft({ buyer: 'jen', subject: 'Question about my order', inbound: 'Can you help me?' });
  assert.equal(draft.orderId, '');
  assert.equal(draft.needsHuman, true);
  assert.ok(draft.notes.some((note) => note.includes('订单号')));
});

test('buildDraft：非英语买家会在备注里提示语言', () => {
  const draft = buildDraft({ buyer: 'Midia', subject: 'Frage zur Bestellung', inbound: 'Meine Bestellung ist kaputt' });
  assert.equal(draft.language.code, 'de');
  assert.ok(draft.notes.some((note) => note.includes('德语')));
});

test('buildDraft：意图有歧义时标 needsHuman', () => {
  const draft = buildDraft({ buyer: 'x', subject: 'damaged', inbound: 'It is broken, I want a refund' });
  assert.equal(draft.needsHuman, true);
  assert.ok(draft.notes.some((note) => note.includes('歧义')));
});

test('buildDraft：退款模板会提醒确认退款是否真的操作过', () => {
  const draft = buildDraft({ buyer: 'x', subject: 'Refund', inbound: 'Where is my refund? It has been 10 days.' });
  assert.equal(draft.intent, 'refund');
  assert.ok(draft.notes.some((note) => note.includes('退款')));
});

test('每个意图都有模板，正文非空且都以署名结尾', () => {
  const samples = {
    replacement: 'the item is broken, need a replacement',
    refund: 'I want a refund',
    shipping: 'my package did not arrive',
    return: 'I want to return it',
    cancel: 'please cancel my order',
    invoice: 'Can you send me an invoice for my order?',
    acknowledge: 'Thank you so much!!',
    inquiry: 'hello, a question',
  };
  // 模板数量必须与 INTENTS 一一对应：加了意图却忘了写模板，会在这里挂掉。
  assert.deepEqual(Object.keys(samples).sort(), [...INTENTS].sort());
  for (const intent of INTENTS) {
    const draft = buildDraft({ buyer: 'sam', subject: '', inbound: samples[intent], storeName: 'Amazon-Test-管理员' });
    assert.equal(draft.intent, intent, intent);
    assert.ok(draft.body.length > 80, intent);
    assert.match(draft.body, /Best regards,\n\nTest Customer Service$/);
  }
});

test('classifyIntent：真实会话里出现过的写法都要判对', () => {
  const cases = [
    ['no thank you i would jus like the refund please.', 'refund'],
    ["There is nothing showing the damage, the lights just don't work anymore", 'replacement'],
    ['The hardware broke out of the side of the vanity and the vanity cannot be used', 'replacement'],
    ['We need board #21. The board that holds the knob. Front drawer. See images', 'replacement'],
    ['¿Puedes proporcionar una factura para mi pedido n.º 405-4038959-1945137?', 'invoice'],
    ['Thank you, so much!!', 'acknowledge'],
  ];
  for (const [text, expected] of cases) {
    assert.equal(classifyIntent(text).intent, expected, text);
  }
});

test('classifyIntent：致谢判定不能把「拒绝」当成感谢', () => {
  assert.equal(classifyIntent('Thank you, so much!!').intent, 'acknowledge');
  assert.equal(classifyIntent('thanks!').intent, 'acknowledge');
  assert.equal(classifyIntent('Perfect, thank you').intent, 'acknowledge');

  // 这句话里有 "thank you"，但它是买家在**拒绝**换货。
  const refusing = classifyIntent('no thank you i would jus like the refund please.');
  assert.equal(refusing.intent, 'refund');
  assert.equal(refusing.ambiguous, false, '不该同时命中致谢');

  assert.equal(classifyIntent('Thank you, but the item is broken').intent, 'replacement');
  assert.equal(classifyIntent('Thanks! I got it working now').intent, 'inquiry');
});

test('detectLanguage：按停用词命中数判定，虚构词特征也能认出来', () => {
  // 这条真实德语消息里没有任何「Lieferung / Bestellung」这类特征名词，
  // 早先靠特征名词表一条都命不中，被误当成英语。
  assert.equal(detectLanguage('Ich habe versucht mehrere mal es geht nicht ich weiß nicht warum').code, 'de');
  assert.equal(detectLanguage('¿Puedes proporcionar una factura para mi pedido?').code, 'es');
  assert.equal(detectLanguage('My package did not arrive, where is my order?').code, 'en');
});

test('buildDraft：买家只回一句致谢时，不该再问一堆问题', () => {
  const draft = buildDraft({ buyer: 'Erica', subject: 'Inquiry from Amazon customer Erica', inbound: 'Thank you, so much!!' });
  assert.equal(draft.intent, 'acknowledge');
  assert.equal(/share a little more detail/.test(draft.body), false, '不能反问买家');
  assert.equal(/invoice|refund|replacement/i.test(draft.body), false, '不能提不相关的事');
  assert.match(draft.body, /^Hello Erica,/);
  // 寒暄不涉及订单，缺订单号不该被标成「需人工」。
  assert.equal(draft.needsHuman, false);
});

test('summarizeThread：取买家最后一条，超长截断', () => {
  const thread = {
    messages: [
      { dir: 'in', body: 'first question' },
      { dir: 'out', body: 'our answer' },
      { dir: 'in', body: 'second question' },
    ],
  };
  assert.equal(summarizeThread(thread), 'second question');
  assert.equal(summarizeThread({ messages: [] }), '');
  const long = summarizeThread({ messages: [{ dir: 'in', body: 'x'.repeat(400) }] }, 50);
  assert.equal(long.length, 53);
});

test('hasCjk：按码点判断，不依赖正则转义', () => {
  assert.equal(hasCjk('订单'), true);
  assert.equal(hasCjk('order'), false);
  assert.equal(hasCjk(''), false);
});

/* ── 话术口径（v0.14.0）：损坏直接要照片 + 免费补发配件（不是整包），且不索要订单号 ─── */

test('buildDraft：损坏一律直接要照片，并承诺免费补发配件（不是整包）', () => {
  const draft = buildDraft({
    buyer: 'Jen',
    subject: 'Damaged or defective item',
    inbound: 'The leg arrived broken. I need a replacement part.',
    storeName: 'Amazon-Cozynome-管理员',
  });
  assert.equal(draft.intent, 'replacement');
  assert.match(draft.body, /photo/i, '要直接索要照片');
  assert.match(draft.body, /free of charge/i, '要承诺免费补发');
  assert.match(draft.body, /part only, not the whole set/i, '补的是配件，不是整包');
});

test('buildDraft：任何意图都不向买家索要订单号', () => {
  const samples = {
    replacement: 'the item is broken, need a replacement',
    refund: 'I want a refund',
    shipping: 'my package did not arrive',
    return: 'I want to return it',
    cancel: 'please cancel my order',
    invoice: 'Can you send me an invoice for my order?',
    acknowledge: 'Thank you so much!!',
    inquiry: 'hello, a question',
  };
  for (const intent of INTENTS) {
    const draft = buildDraft({ buyer: 'sam', subject: '', inbound: samples[intent], storeName: 'Amazon-Test-管理员' });
    assert.equal(
      /order (?:number|id)|reference number|订单号/i.test(draft.body),
      false,
      intent + '：正文里不能向买家索要订单号',
    );
  }
});
