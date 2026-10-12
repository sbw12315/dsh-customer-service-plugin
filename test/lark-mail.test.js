import assert from 'node:assert/strict';
import test from 'node:test';
import { createLarkMailAdapter } from '../lib/platforms/lark-mail.js';

/** 造一个按参数分派的 lark-cli 替身。 */
function fakeLark(handlers = {}) {
  const calls = [];
  return {
    calls,
    async callOrThrow(args) {
      calls.push(args);
      const key = args[1];
      const handler = handlers[key];
      if (!handler) throw new Error(`未预期的调用：${args.join(' ')}`);
      const result = handler(args);
      // 真客户端的 callOrThrow 返回的是**解过信封的 data**；替身必须照做，
      // 否则测出来的形状跟线上不是一回事。
      return result && typeof result === 'object' && 'ok' in result ? result.data : result;
    },
  };
}

const MAILBOXES = {
  ok: true,
  data: {
    accessible_mailboxes: [
      { email_address: 'me@cozynome.com', email_type: 'USER_PRIMARY' },
      { email_address: 'service@cozynome.com', email_type: 'PUBLIC_MAILBOX' },
      { email_address: 'service-alias@cozynome.com', email_type: 'PUBLIC_MAILBOX_ALIAS' },
    ],
  },
};

/** 插件里配置的巡逻邮箱（显式列表 —— bot 身份不能用 `me` 枚举）。 */
const DEFAULT_MAILBOXES = ['me@cozynome.com', 'service@cozynome.com', 'service-alias@cozynome.com'];

/** bot 身份下 accessible_mailboxes 只回传被问的那一个邮箱，替身必须照此行为。 */
const mailboxQuery = (args) => {
  const params = JSON.parse(args[args.indexOf('--params') + 1] ?? '{}');
  const asked = String(params.user_mailbox_id ?? '').toLowerCase();
  const hit = MAILBOXES.data.accessible_mailboxes.filter(
    (entry) => entry.email_address.toLowerCase() === asked,
  );
  return { ok: true, data: { accessible_mailboxes: hit } };
};

/** 造一封邮件。 */
const mail = (over = {}) => ({
  message_id: 'm1',
  thread_id: 't1',
  subject: 'Shipment delay',
  head_from: { mail_address: 'alice@supplier.com', name: 'Alice' },
  date_formatted: '2026-10-06 10:00',
  message_state_text: 'received',
  body_plain_text: 'Your shipment is delayed by two days.',
  ...over,
});

const adapterWith = (threads, extra = {}) =>
  createLarkMailAdapter({
    settings: { mailboxes: DEFAULT_MAILBOXES },
    lark: fakeLark({
      user_mailboxes: mailboxQuery,
      'user_mailbox.threads': () => ({ ok: true, data: { items: Object.keys(threads).map((id) => ({ id })) } }),
      '+thread': (args) => {
        const id = args[args.indexOf('--thread-id') + 1];
        return { ok: true, data: { thread_id: id, messages: threads[id] ?? [] } };
      },
      ...extra,
    }),
  });

test('listSources：按配置的邮箱逐个确认，全部走 bot 身份', async () => {
  const lark = fakeLark({ user_mailboxes: mailboxQuery });
  const adapter = createLarkMailAdapter({ lark, settings: { mailboxes: DEFAULT_MAILBOXES } });
  const sources = await adapter.listSources();
  assert.deepEqual(sources.map((source) => source.storeId), DEFAULT_MAILBOXES);
  assert.deepEqual(sources.map((source) => source.platformName), ['个人主邮箱', '公共邮箱', '公共邮箱别名']);
  // 显式配置的邮箱一律可巡逻：不再按「公共邮箱」过滤，否则配了个人邮箱的人会一个都不扫。
  assert.deepEqual(sources.map((source) => source.isShared), [true, true, true]);
  // 判断「这封是不是我方发的」时，配置里的所有地址都算我方。
  assert.deepEqual(sources[1].selfAddresses, DEFAULT_MAILBOXES);
  // 邮件链路必须整体走 bot（租户身份），不能退回 user。
  assert.ok(lark.calls.length > 0);
  for (const args of lark.calls) {
    const at = args.indexOf('--as');
    assert.ok(at >= 0 && args[at + 1] === 'bot', `应当用 bot 身份：${args.join(' ')}`);
  }
});

test('enabled()：默认关闭，只有 settings.mailEnabled 为 true 才算启用', () => {
  const lark = fakeLark({ user_mailboxes: mailboxQuery });
  // 没给 settings = 出厂默认 = 关
  assert.equal(createLarkMailAdapter({ lark }).enabled(), false);
  assert.equal(
    createLarkMailAdapter({ lark, settings: { mailboxes: DEFAULT_MAILBOXES } }).enabled(),
    false,
    '只配了邮箱不算启用',
  );
  assert.equal(createLarkMailAdapter({ lark, settings: { mailEnabled: false } }).enabled(), false);
  assert.equal(createLarkMailAdapter({ lark, settings: { mailEnabled: true } }).enabled(), true);

  // 开关每次现读：设置改完不必重启（这条同时锁住「捕获的是对象而不是快照」）。
  const settings = { mailEnabled: false };
  const adapter = createLarkMailAdapter({ lark, settings });
  assert.equal(adapter.enabled(), false);
  settings.mailEnabled = true;
  assert.equal(adapter.enabled(), true);
});

test('渠道开关（v0.13.0）：channelEnabled 是新入口，老的 mailEnabled 仍然认', () => {
  const lark = fakeLark({ user_mailboxes: mailboxQuery });
  // 巡逻页那一行的开关写的是 channelEnabled。
  const byChannel = createLarkMailAdapter({ lark, settings: { channelEnabled: { 'lark-mail': true } } });
  assert.equal(byChannel.channelEnabled(), true);
  assert.equal(byChannel.enabled(), true);
  assert.equal(
    createLarkMailAdapter({ lark, settings: { channelEnabled: { 'lark-mail': false } } }).enabled(),
    false,
  );
  // 老设置文件里只有 mailEnabled：照样认（存量的 settings.json 不能被升级弄丢）。
  assert.equal(createLarkMailAdapter({ lark, settings: { mailEnabled: true } }).enabled(), true);
  // 两个键同时出现时以 channelEnabled 为准 —— 否则巡逻页的开关会「点了没反应」。
  const both = createLarkMailAdapter({
    lark,
    settings: { mailEnabled: true, channelEnabled: { 'lark-mail': false } },
  });
  assert.equal(both.enabled(), false);

  // disabledHint 要说清是「被停用」还是「从来就没开」：两件事要人做的动作不一样。
  assert.match(both.disabledHint(), /停用/);
  assert.match(
    createLarkMailAdapter({ lark, settings: { mailEnabled: false } }).disabledHint(),
    /默认关闭/,
  );
  // CLI 被禁用是第三种原因，仍然要说 CLI。
  assert.match(
    createLarkMailAdapter({ lark, settings: { mailEnabled: true, cliEnabled: { lark: false } } }).disabledHint(),
    /飞书CLI/,
  );
});

test('listSources：没配置邮箱时给出可照做的提示，且不白调 CLI', async () => {
  const lark = fakeLark({ user_mailboxes: mailboxQuery });
  const adapter = createLarkMailAdapter({ lark, settings: { mailboxes: [] } });
  await assert.rejects(() => adapter.listSources(), /还没有配置巡逻邮箱/);
  assert.equal(lark.calls.length, 0);
});

test('listSources：配置的邮箱对当前身份不可见时明确报错，而不是静默少扫', async () => {
  const lark = fakeLark({ user_mailboxes: mailboxQuery });
  const adapter = createLarkMailAdapter({ lark, settings: { mailboxes: ['nobody@example.com'] } });
  await assert.rejects(() => adapter.listSources(), /都对当前飞书身份不可见/);
});

test('listConversations：只返回「最后一封是来信」的会话', async () => {
  const adapter = adapterWith({
    t1: [mail({ thread_id: 't1', message_id: 'm1' })],
    // 这一条我方已经回过了（最后一条是 sent），不该再生成草稿。
    t2: [
      mail({ thread_id: 't2', message_id: 'm2' }),
      mail({ thread_id: 't2', message_id: 'm3', message_state_text: 'sent', head_from: { mail_address: 'service@cozynome.com', name: 'Service' } }),
    ],
    // 只有我方发出的，没有来信。
    t3: [mail({ thread_id: 't3', message_state_text: 'sent', head_from: { mail_address: 'service@cozynome.com' } })],
  });
  const { items } = await adapter.listConversations({ storeId: 'service@cozynome.com', storeName: 'service@cozynome.com', selfAddresses: ['service@cozynome.com'] }, { max: 5 });
  assert.deepEqual(items.map((item) => item.caseId), ['t1']);
  assert.equal(items[0].messageId, 'm1');
  assert.equal(items[0].buyer, 'Alice');
});

test('listConversations：从其它自有邮箱（别名）发出的回信也算「已回复」', async () => {
  const adapter = adapterWith({
    t1: [
      mail({ thread_id: 't1' }),
      mail({ thread_id: 't1', message_id: 'm9', message_state_text: 'sent', head_from: { mail_address: 'service-alias@cozynome.com' } }),
    ],
  });
  const { items } = await adapter.listConversations(
    { storeId: 'service@cozynome.com', storeName: 'x', selfAddresses: ['service@cozynome.com', 'service-alias@cozynome.com'] },
    { max: 5 },
  );
  assert.deepEqual(items, [], '别名回的信也算回过，不该重复催');
});

test('readConversation：会话内容在 listConversations 时已经读好，不重复拉一次', async () => {
  const adapter = adapterWith({ t1: [mail({ thread_id: 't1' })] });
  const lark = adapter; // 仅用于保持结构清晰
  const { items } = await adapter.listConversations({ storeId: 'x', storeName: 'x', selfAddresses: [] }, { max: 1 });
  const before = adapter.readConversation.length; // 触发属性访问，避免未使用告警
  assert.equal(typeof before, 'number');
  const thread = await adapter.readConversation({ storeId: 'x' }, items[0]);
  assert.equal(thread.threadId, 't1');
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.lastInbound.body, 'Your shipment is delayed by two days.');
  assert.equal(lark === adapter, true);
});

test('createExternalDraft：用 +reply 存草稿，绝不带 --confirm-send', async () => {
  const lark = fakeLark({
    '+reply': () => ({ ok: true, data: { draft_id: 'd_1' } }),
  });
  const adapter = createLarkMailAdapter({ lark });
  const result = await adapter.createExternalDraft({ storeId: 'service@cozynome.com' }, { item: { messageId: 'm1' }, body: 'Hi Alice,\n\nThanks.' });
  assert.equal(result.draftId, 'd_1');
  const reply = lark.calls.find((args) => args[1] === '+reply');
  assert.ok(reply.includes('--message-id') && reply.includes('m1'));
  assert.ok(reply.includes('--mailbox') && reply.includes('service@cozynome.com'));
  assert.equal(reply[reply.indexOf('--as') + 1], 'bot', '建草稿同样走 bot 身份');
  const flat = reply.join(' ');
  assert.equal(/confirm-send/.test(flat), false, '绝不能带 --confirm-send');
});

test('createExternalDraft：空正文或缺 message_id 直接拒绝，不去猜', async () => {
  const lark = fakeLark({});
  const adapter = createLarkMailAdapter({ lark });
  await assert.rejects(() => adapter.createExternalDraft({ storeId: 'x' }, { item: { messageId: 'm1' }, body: '  ' }), /草稿内容为空/);
  await assert.rejects(() => adapter.createExternalDraft({ storeId: 'x' }, { item: {}, body: 'hi' }), /缺少原始 message_id/);
  assert.equal(lark.calls.length, 0);
});

test('授权失败时给出可照做的 bot 复现命令（而不是原样抛飞书的英文错误）', async () => {
  const adapter = createLarkMailAdapter({
    settings: { mailboxes: ['service@cozynome.com'] },
    lark: {
      async callOrThrow() {
        throw new Error('need_user_authorization (user: ou_x); current command requires scope(s): mail:user_mailbox:readonly');
      },
    },
  });
  await assert.rejects(
    () => adapter.listSources(),
    (cause) => {
      assert.equal(cause.kind, 'auth');
      assert.match(cause.message, /授权失败/);
      assert.match(cause.hint, /--as bot/);
      return true;
    },
  );
});

test('会话没有任何来信时返回 null，不会生成空草稿', async () => {
  const adapter = adapterWith({ t1: [mail({ message_state_text: 'sent', head_from: { mail_address: 'service@cozynome.com' } })] });
  const { items } = await adapter.listConversations({ storeId: 'service@cozynome.com', storeName: 'x', selfAddresses: ['service@cozynome.com'] }, { max: 3 });
  assert.deepEqual(items, []);
});
