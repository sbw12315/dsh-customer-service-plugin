import assert from 'node:assert/strict';
import test from 'node:test';
import { BULK_HINT, DEFAULT_SKIP_SENDERS, parseContactForm } from '../lib/platforms/lark-mail.js';
import { createLarkMailAdapter } from '../lib/platforms/lark-mail.js';

/** 造一个按参数分派的 lark-cli 替身（返回解过信封的 data）。 */
function fakeLark(handlers = {}) {
  const calls = [];
  return {
    calls,
    async callOrThrow(args) {
      calls.push(args);
      const handler = handlers[args[1]];
      if (!handler) throw new Error(`未预期的调用：${args.join(' ')}`);
      const result = handler(args);
      return result && typeof result === 'object' && 'ok' in result ? result.data : result;
    },
  };
}

/** 造一封邮件。 */
const mail = (over = {}) => ({
  message_id: 'm1',
  thread_id: 't1',
  subject: 'Subject',
  head_from: { mail_address: 'someone@example.com', name: 'Someone' },
  date_formatted: '2026-10-07 10:00',
  message_state_text: 'received',
  body_plain_text: 'Hello',
  ...over,
});

const adapterWith = (threads) =>
  createLarkMailAdapter({
    lark: fakeLark({
      user_mailbox: () => ({ ok: true, data: { items: Object.keys(threads).map((id) => ({ id })) } }),
      'user_mailbox.threads': () => ({ ok: true, data: { items: Object.keys(threads).map((id) => ({ id })) } }),
      '+thread': (args) => ({ ok: true, data: { thread_id: args[args.indexOf('--thread-id') + 1], messages: threads[args[args.indexOf('--thread-id') + 1]] ?? [] } }),
    }),
  });

const SOURCE = { storeId: 'support@fusou.vip', storeName: 'support@fusou.vip', selfAddresses: ['support@fusou.vip'] };

test('真实抓到的三类邮件：客户来信留、平台转发表单留、系统通知跳', async () => {
  // ① 系统通知：正文带「停止接收…通知邮件」退订入口 —— 实跑里就是这封被生成成了草稿。
  const payout = mail({
    message_id: 'p1',
    thread_id: 'payout',
    subject: '2026年10月7日 的收入款项 ($299.93 USD)',
    head_from: { mail_address: 'no-reply@shopify.com', name: 'Yanosaku (Shopify)' },
    body_plain_text: '2026年10月7日 $299.93 USD 将在 1–2 个工作日内存入您的银行账户。… 151 O\'Connor Street, Ottawa ON. 停止接收收入款项通知邮件',
  });

  // ② 平台转发的联系表单：真客户在正文里。
  const contactForm = mail({
    message_id: 'c1',
    thread_id: 'contact',
    subject: 'New customer message on October 6, 2026 at 9:12 pm',
    head_from: { mail_address: 'no-reply@shopify.com', name: 'Yanosaku (Shopify)' },
    body_plain_text:
      "You received a new message from your online store's contact form. Country Code: US\nName: Memo Navarrete\nEmail: gnav616@gmail.com\nPhone:\nBody: We are missing a rail for the vanity",
  });

  // ③ 真实客户直接来信。
  const direct = mail({
    message_id: 'd1',
    thread_id: 'direct',
    subject: 'Missing parts of vanity',
    head_from: { mail_address: 'nadia@example.com', name: 'Nadia Luzia' },
    body_plain_text: 'What is the original purchasing platform? Could you provide me with a number or email?',
  });

  const adapter = adapterWith({ payout: [payout], contact: [contactForm], direct: [direct] });
  const { items, skipped } = await adapter.listConversations(SOURCE, { max: 10 });

  assert.deepEqual(items.map((item) => item.caseId), ['contact', 'direct'], '系统通知被跳过');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /系统群发|自动通知/);

  // 平台转发表单：认得出真正的客户，并且带上「确认收件人」的提醒。
  const form = items.find((item) => item.caseId === 'contact');
  assert.equal(form.buyer, 'Memo Navarrete');
  assert.equal(form.thread.buyerAddress, 'gnav616@gmail.com');
  assert.equal(form.thread.senderAddress, 'no-reply@shopify.com', '通知发件人仍然留档');
  assert.match(form.thread.warnings[0], /联系表单/);
  assert.match(form.thread.lastInbound.body, /missing a rail/, '草稿要基于客户留言，而不是通知抬头');

  // 真实客户来信：不跳、不改写。
  const plain = items.find((item) => item.caseId === 'direct');
  assert.equal(plain.buyer, 'Nadia Luzia');
  assert.equal(plain.thread.warnings.length, 0);
});

test('no-reply 类地址直接跳过，不管正文写了什么', async () => {
  const adapter = adapterWith({
    t1: [mail({ head_from: { mail_address: 'do-not-reply@somewhere.com', name: 'System' }, body_plain_text: 'Please reply to this email.' })],
  });
  const { items, skipped } = await adapter.listConversations(SOURCE, { max: 5 });
  assert.deepEqual(items, []);
  assert.match(skipped[0].reason, /自动通知/);
});

test('parseContactForm：单行正文也能抠出客户（飞书把整封压成了一行）', () => {
  // 这是实跑抓到的原文形状：所有字段挤在同一行，行首锚定的正则一条都匹配不上。
  const real =
    "You received a new message from your online store's contact form. Country Code: US " +
    'Id: ContactForm-abc Name: Memo Navarrete Email: gnav616@gmail.com Phone: Body: We are missing a rail';
  assert.deepEqual(parseContactForm(real), {
    name: 'Memo Navarrete',
    email: 'gnav616@gmail.com',
    body: 'We are missing a rail',
  });

  // 多行形状同样要认。
  assert.deepEqual(parseContactForm('contact form\nName: Alice\nEmail: alice@x.com\nBody: my order is late'), {
    name: 'Alice',
    email: 'alice@x.com',
    body: 'my order is late',
  });

  // 必须先命中联系表单标志：普通来信里出现 "Name:" 不能被当成字段。
  assert.equal(parseContactForm('Hi team, Name: Bob — my order is late'), null);
  assert.equal(parseContactForm('Hi, just a normal email'), null);
  assert.equal(parseContactForm(''), null);
});

test('跳过规则可被配置追加，且非法正则不会让适配器起不来', () => {
  const adapter = createLarkMailAdapter({
    settings: { patrol: { mailSkipSenders: ['@spam\.example$', '([invalid'] } },
    lark: fakeLark({
      'user_mailbox.threads': () => ({ ok: true, data: { items: [{ id: 't1' }] } }),
      '+thread': () => ({ ok: true, data: { messages: [mail({ head_from: { mail_address: 'a@spam.example', name: 'A' } })] } }),
    }),
  });
  return adapter.listConversations(SOURCE, { max: 5 }).then(({ items, skipped }) => {
    assert.deepEqual(items, []);
    assert.match(skipped[0].reason, /自动通知/);
  });
});

test('BULK_HINT 认得中英文退订入口，但不会误伤普通来信', () => {
  assert.equal(BULK_HINT.test('停止接收收入款项通知邮件'), true);
  assert.equal(BULK_HINT.test('Click here to unsubscribe'), true);
  assert.equal(BULK_HINT.test('管理订阅'), false, '「管理订阅」是「通知邮件设置」的近义说法，不在此列');
  assert.equal(BULK_HINT.test('We are missing a rail for the vanity'), false);
  assert.equal(DEFAULT_SKIP_SENDERS.some((re) => re.test('no-reply@shopify.com')), true);
  assert.equal(DEFAULT_SKIP_SENDERS.some((re) => re.test('nadia@example.com')), false);
});
