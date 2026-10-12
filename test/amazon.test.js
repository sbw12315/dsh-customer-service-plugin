import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMPOSER_INPUT_SELECTOR,
  COMPOSER_OPEN_SELECTOR,
  INBOX_URL,
  LIST_SELECTOR,
  THREAD_MESSAGES_SELECTOR,
  THREAD_SELECTOR,
  asObject,
  caseIdFromUrl,
  conversationUrl,
  createAmazonAdapter,
  isAmazonStore,
  parseDueText,
} from '../lib/platforms/amazon.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const playbookPath = path.join(here, '..', 'assets', 'playbooks', 'amazon.message.json');

/** 造一个只认预期调用的紫鸟客户端替身。 */
function fakeZiniao(handlers = {}) {
  const calls = [];
  return {
    calls,
    async callOrThrow(args, opts) {
      calls.push(args);
      const key = `${args[0]} ${args[1]}`;
      const handler = handlers[key];
      if (!handler) throw new Error(`未预期的调用：${args.join(' ')}`);
      return handler(args, opts);
    },
    async call(args) {
      calls.push(args);
      const key = `${args[0]} ${args[1]}`;
      const handler = handlers[key];
      if (!handler) return { ok: true, data: null };
      try {
        const out = handler(args);
        // 处理函数可以直接返回 {ok:false} 来模拟失败（元素找不到之类），其余一律包装成成功 ——
        // 真实客户端里 call() 从不抛错，只回 {ok:false}，替身必须同形，否则测不出降级逻辑。
        return out && typeof out === 'object' && 'ok' in out ? out : { ok: true, data: out };
      } catch (cause) {
        return { ok: false, data: null, error: { kind: cause?.kind ?? 'error', message: cause.message } };
      }
    },
  };
}

/** 从一次 page exec 调用里取回脚本正文。选择器会被 JSON 转义，断言时用不含引号的片段。 */
const scriptOf = (args) => String(args[args.indexOf('--script') + 1] ?? '');

/** page exec 的信封：callOrThrow 的返回值。 */
const execEnvelope = (payload) => ({ data: { result: JSON.stringify(payload), ok: true } });

const STORE_LIST = {
  items: [
    { storeId: '27630232762680', storeName: 'Amazon-Cozynome-管理员', platformName: '亚马逊-美国' },
    { storeId: '27800343767219', storeName: 'Walmart-Cozynome-管理员', platformName: '沃尔玛-全球' },
    { storeId: '27999999999999', storeName: 'Amazon-FUSOU-客服', platformName: '亚马逊-欧洲' },
    { storeId: '27000000000001', storeName: 'Amazon-FUSOU-停用', platformName: '亚马逊-美国' },
  ],
};

const LIST_PAYLOAD = {
  url: 'https://sellercentral.amazon.com/messaging/inbox-v3?fi=responseNeeded',
  count: 2,
  items: [
    {
      index: 0,
      buyer: 'cain',
      date: '2026年10月5日',
      country: 'US',
      subject: 'Damaged or defective item: Request a replacement item(Order: 113-9341386-05…)',
      due: '到期时间：12 分钟',
      orderId: '113-9341386-0505001',
      badge: 'case-status-badge OPEN',
      active: true,
      raw: 'cain 2026年10月5日 …',
    },
    { index: 1, buyer: 'jen', date: '2026年10月5日', country: 'US', subject: 'Question', due: '到期时间：5 小时', orderId: '114-6929370-0800000', badge: 'case-status-badge OPEN', active: false, raw: 'jen …' },
  ],
};

const THREAD_PAYLOAD = {
  ok: true,
  url: 'https://sellercentral.amazon.com/messaging/inbox-v3?cc=5c7f02ce-e04a-41a5-8e90-b0e4380b1dc8&fi=responseNeeded',
  buyer: 'cain',
  country: '美国 | 英语',
  topic: '商品详情询问',
  due: '到期时间：12 分钟',
  messages: [
    { dir: 'in', date: '2026年10月5日 10:36', body: 'Our new address is 6 Crandall Court Fort Rucker, AL 36362' },
  ],
  lastInbound: { dir: 'in', date: '2026年10月5日 10:36', body: 'Our new address is 6 Crandall Court Fort Rucker, AL 36362' },
  messageCount: 1,
};

test('isAmazonStore：认「亚马逊-XX」与「Amazon-XX」，不认沃尔玛', () => {
  assert.equal(isAmazonStore({ platformName: '亚马逊-美国' }), true);
  assert.equal(isAmazonStore({ platformName: '亚马逊-欧洲' }), true);
  assert.equal(isAmazonStore({ platformName: 'Amazon-US' }), true);
  assert.equal(isAmazonStore({ platformName: '沃尔玛-全球' }), false);
  assert.equal(isAmazonStore({}), false);
});

test('parseDueText：分钟/小时/天与超期都能换算', () => {
  assert.deepEqual(parseDueText('到期时间：12 分钟'), { minutes: 12, overdue: false });
  assert.deepEqual(parseDueText('到期时间：5 小时'), { minutes: 300, overdue: false });
  assert.deepEqual(parseDueText('Due in 2 days'), { minutes: 2880, overdue: false });
  assert.equal(parseDueText('已超期 3 小时').minutes, -180);
  assert.equal(parseDueText(''), null, '空文案没有到期信息');
  assert.deepEqual(parseDueText('随便一句话'), { minutes: null, overdue: false }, '有文案但解不出时间');
});

test('caseIdFromUrl / conversationUrl：从 URL 取会话 id，并能拼回深链', () => {
  const url = 'https://sellercentral.amazon.com/messaging/inbox-v3?cc=5c7f02ce-e04a-41a5-8e90-b0e4380b1dc8&fi=responseNeeded';
  assert.equal(caseIdFromUrl(url), '5c7f02ce-e04a-41a5-8e90-b0e4380b1dc8');
  assert.equal(caseIdFromUrl('https://x/y'), '');
  assert.match(conversationUrl('abc'), /cc=abc&fi=responseNeeded$/);
  assert.equal(conversationUrl(''), INBOX_URL);
});

test('asObject：兼容对象与 JSON 字符串两种返回', () => {
  assert.deepEqual(asObject('{"a":1}'), { a: 1 });
  assert.deepEqual(asObject({ a: 2 }), { a: 2 });
  assert.equal(asObject('不是 JSON'), null);
  assert.equal(asObject(null), null);
});

test('adapter.visitInbox：被弹回登录页时报「未登录」，而不是含糊的「收不到元素」', async () => {
  const ziniao = fakeZiniao({
    'page visit': () => ({ ok: true }),
    'page exec': () => ({ data: { result: 'https://sellercentral.amazon.com/ap/signin?clientContext=x' } }),
  });
  const adapter = createAmazonAdapter({ ziniao });
  await assert.rejects(() => adapter.visitInbox({ storeId: '1', storeName: 'Amazon-Homiberry-管理员' }), /店铺未登录/);
});

test('adapter.listAllStores 给全量、listStores 只给亚马逊店', async () => {
  const ziniao = fakeZiniao({ 'store list': () => STORE_LIST });
  const adapter = createAmazonAdapter({ ziniao });

  // 「扫描可用店铺」要看到全量：非亚马逊店也得列出来，界面才能解释它为什么不被巡逻。
  const all = await adapter.listAllStores();
  assert.deepEqual(all.map((store) => store.storeId), ['27630232762680', '27800343767219', '27999999999999', '27000000000001']);

  const amazon = await adapter.listStores();
  assert.deepEqual(amazon.map((store) => store.storeId), ['27630232762680', '27999999999999']);
  assert.equal(amazon.some((store) => store.storeId === '27000000000001'), false, '名字带「停用」的亚马逊店不巡逻（打开只会撞登录/错误页）');
});

test('adapter.extractList：解出会话列表与到期时间', async () => {
  const ziniao = fakeZiniao({ 'page exec': () => execEnvelope(LIST_PAYLOAD) });
  const adapter = createAmazonAdapter({ ziniao });
  const list = await adapter.extractList({ storeId: '1' });
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0].buyer, 'cain');
  assert.equal(list.items[0].orderId, '113-9341386-0505001');
});

test('adapter.openConversation：用脚本点 nth-child 定位的行，并等到消息真的渲染出来', async () => {
  // 2026-10-08 现场：紫鸟CLI 的 page click 在这一页上会「鼠标指令已发送、DOM click 事件
  // 未观察到」，一律报 ELEMENT_NOT_INTERACTABLE（而元素本身完全正常）。换成脚本里的
  // el.click() 一次就打开，所以这里把做法锁死。
  const ziniao = fakeZiniao({
    'page exec': () => ({ data: { result: JSON.stringify({ ok: true }) } }),
  });
  const adapter = createAmazonAdapter({ ziniao });
  await adapter.openConversation({ storeId: '1' }, 1);

  const click = ziniao.calls.find(
    (args) => args[0] === 'page' && args[1] === 'exec' && scriptOf(args).includes('case-list-item'),
  );
  assert.ok(click, '要用脚本点开列表行');
  assert.ok(scriptOf(click).includes(`${LIST_SELECTOR} .case-list-item:nth-child(2)`));
  assert.ok(scriptOf(click).includes('el.click()'), '要真的点');
  assert.ok(scriptOf(click).includes('scrollIntoView'), '点之前先滚进可视区');
  assert.equal(ziniao.calls.some((args) => args[1] === 'click'), false, '不能再走 page click');

  // 关键：必须等消息体，而不是只等外层空壳 —— 否则会读到「没有消息」的会话，
  // 买家诉求全丢，意图只能从系统主题猜。
  const waits = ziniao.calls.filter((args) => args[0] === 'page' && args[1] === 'wait-element');
  assert.ok(waits.some((args) => args.includes(THREAD_MESSAGES_SELECTOR)), '应该等消息元素');
});

test('adapter.openConversation：行不在列表里了要说清楚，而不是含糊的「点不动」', async () => {
  const ziniao = fakeZiniao({
    'page exec': () => ({ data: { result: JSON.stringify({ ok: false, reason: 'missing' }) } }),
  });
  const adapter = createAmazonAdapter({ ziniao });
  await assert.rejects(() => adapter.openConversation({ storeId: '1' }, 3), /不在列表里了/);
});

test('adapter.extractThread：读到空会话会重读，不把「还在渲染」当结论', async () => {
  let round = 0;
  const ziniao = fakeZiniao({
    'page exec': () => {
      round += 1;
      return execEnvelope(round === 1 ? { ok: true, url: 'https://x/y', messages: [], lastInbound: null } : THREAD_PAYLOAD);
    },
  });
  const adapter = createAmazonAdapter({ ziniao });
  const thread = await adapter.extractThread({ storeId: '1' });
  assert.equal(round, 2, '第一次为空应该重读');
  assert.match(thread.lastInbound.body, /6 Crandall Court/);
});

test('adapter.extractThread：一直读不到消息时如实返回空会话，由上层决定', async () => {
  const ziniao = fakeZiniao({
    'page exec': () => execEnvelope({ ok: true, url: 'https://x/y', messages: [], lastInbound: null }),
  });
  const adapter = createAmazonAdapter({ ziniao });
  const thread = await adapter.extractThread({ storeId: '1' });
  assert.deepEqual(thread.messages, []);
});

test('adapter.extractThread：解出正文、最后一条买家消息与 caseId', async () => {
  const ziniao = fakeZiniao({ 'page exec': () => execEnvelope(THREAD_PAYLOAD) });
  const adapter = createAmazonAdapter({ ziniao });
  const thread = await adapter.extractThread({ storeId: '1' });
  assert.equal(thread.buyer, 'cain');
  assert.match(thread.lastInbound.body, /6 Crandall Court/);
  assert.equal(caseIdFromUrl(thread.url), '5c7f02ce-e04a-41a5-8e90-b0e4380b1dc8');
});

test('adapter.fillComposer：没有 caseId 直接拒绝，不去猜会话', async () => {
  const ziniao = fakeZiniao({});
  const adapter = createAmazonAdapter({ ziniao });
  await assert.rejects(() => adapter.fillComposer({ storeId: '1' }, 'hello', {}), /无法定位到原会话/);
  assert.equal(ziniao.calls.length, 0);
});

test('adapter.fillComposer：只用深链打开原会话并填文本，全程不点发送', async () => {
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': (args) => ({
      data: { result: JSON.stringify({ ok: scriptOf(args).includes('select-original-experience-button') }) },
    }),
    'page input': () => ({ ok: true }),
  });
  const adapter = createAmazonAdapter({ ziniao });
  const result = await adapter.fillComposer({ storeId: '1' }, 'Hello Cain,\n\nDraft.', { caseId: 'case-9' });
  assert.equal(result.filled, true);
  assert.match(result.url, /cc=case-9/);

  const opened = ziniao.calls.find(
    (args) => args[0] === 'page' && args[1] === 'exec' && scriptOf(args).includes('select-original-experience-button'),
  );
  assert.ok(opened, '要有一次「填写留言」的脚本点击');
  assert.ok(scriptOf(opened).includes('el.click()'), '点了才叫点击');
  assert.ok(scriptOf(opened).includes('scrollIntoView'), '点之前先滚进可视区');
  assert.equal(ziniao.calls.some((args) => args[1] === 'click'), false, '不再走那条不可靠的 page click');

  const input = ziniao.calls.find((args) => args[0] === 'page' && args[1] === 'input');
  assert.ok(input.includes(COMPOSER_INPUT_SELECTOR));
  assert.ok(input.includes('Hello Cain,\n\nDraft.'));

  // 任何一次调用都不能落在「发送」上。
  const flat = ziniao.calls.map((args) => args.join(' ')).join('\n');
  assert.equal(/发送|send/i.test(flat), false);
});

test('adapter.fillComposer：回复框本来就开着（「填写留言」找不到）也照样填得进去', async () => {
  // 2026-10-08 实测现场：页面上一个 kat-button 都没有，点「填写留言」这一步必然失败，
  // 但 textarea.fake-kat-textarea 是可见的、开着的。把这一步当成必须成功，草稿就永远填不进去。
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': (args) =>
      scriptOf(args).includes('select-original-experience-button')
        ? { ok: false, error: { kind: 'element', message: 'Element could not be located' } }
        : { data: { result: JSON.stringify({ ok: true }) } },
    'page input': () => ({ ok: true }),
  });
  const adapter = createAmazonAdapter({ ziniao });
  const result = await adapter.fillComposer({ storeId: '1' }, 'Draft body', { caseId: 'case-1' });
  assert.equal(result.filled, true, '点不到按钮不该让整件事失败');
  const input = ziniao.calls.find((args) => args[0] === 'page' && args[1] === 'input');
  assert.ok(input.includes('Draft body'), '文本要真的填进去');
});

test('adapter.fillComposer：连输入框都找不到时才报错，且原因说得清', async () => {
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': () => ({ data: { result: JSON.stringify({ ok: true }) } }),
    'page wait-element': () => ({ ok: false, error: { kind: 'element', message: 'Element could not be located' } }),
  });
  const adapter = createAmazonAdapter({ ziniao });
  await assert.rejects(
    () => adapter.fillComposer({ storeId: '1' }, 'Draft body', { caseId: 'case-1' }),
    /找不到回复输入框/,
  );
  assert.equal(
    ziniao.calls.some((args) => args[1] === 'input'),
    false,
    '输入框都没找到就不该硬去 input',
  );
});

test('adapter.readConversation：用脚本点开列表行，不再用那条会 ELEMENT_NOT_INTERACTABLE 的 page click', async () => {
  const ziniao = fakeZiniao({
    'page exec': (args) => {
      const script = scriptOf(args);
      // 含 case-list-item 的是「点开列表行」；其余 page exec 是读会话正文。
      if (script.includes('case-list-item')) return { data: { result: JSON.stringify({ ok: true }) } };
      return { data: { result: JSON.stringify(THREAD_PAYLOAD) } };
    },
  });
  const adapter = createAmazonAdapter({ ziniao });
  const thread = await adapter.readConversation({ storeId: '1', storeName: 'Amazon-X' }, { index: 0 });
  assert.equal(thread.buyer, 'cain');

  const clickCall = ziniao.calls.find(
    (args) => args[0] === 'page' && args[1] === 'exec' && scriptOf(args).includes('case-list-item'),
  );
  assert.ok(clickCall, '要用脚本点开列表行');
  const script = scriptOf(clickCall);
  assert.ok(script.includes('nth-child(1)'), '点的是第 1 行');
  assert.ok(script.includes('el.click()'), '要真的点');
  assert.ok(script.includes('scrollIntoView'), '点之前先滚进可视区');
  assert.equal(ziniao.calls.some((args) => args[1] === 'click'), false, '不能再走 page click');
  assert.equal(ziniao.calls.some((args) => args[1] === 'input'), false, '读会话不该碰输入框');
});

test('剧本与代码里的选择器不能漂移', () => {
  const playbook = JSON.parse(fs.readFileSync(playbookPath, 'utf8'));
  assert.equal(playbook.id, 'amazon.message');
  assert.equal(playbook.platform, 'amazon');
  assert.equal(playbook.verified, true, '读取链路已实测校准');
  assert.equal(playbook.entry.url, INBOX_URL);
  assert.equal(playbook.list.selector, LIST_SELECTOR);
  assert.equal(playbook.list.waitFor.selector, LIST_SELECTOR);
  assert.equal(playbook.read.selector, THREAD_SELECTOR);
  assert.equal(playbook.reply.openSelector, COMPOSER_OPEN_SELECTOR);
  assert.equal(playbook.reply.inputSelector, COMPOSER_INPUT_SELECTOR);
  assert.equal(playbook.list.items.orderIdAttr, 'data-ph-capture-attribute-order-id');
});

test('剧本里的发送步骤永久锁死：verified=false、never=true、selector 为空', () => {
  const playbook = JSON.parse(fs.readFileSync(playbookPath, 'utf8'));
  assert.equal(playbook.submit.verified, false);
  assert.equal(playbook.submit.never, true);
  assert.equal(playbook.submit.selector, '');
});

test('紫鸟CLI 在设置里被禁用时，亚马逊渠道不再参与巡逻', () => {
  assert.equal(createAmazonAdapter({ ziniao: {} }).enabled(), true, '没传设置时默认启用');
  assert.equal(
    createAmazonAdapter({ ziniao: {}, settings: { cliEnabled: { ziniao: false } } }).enabled(),
    false,
  );
  assert.equal(
    createAmazonAdapter({ ziniao: {}, settings: { cliEnabled: { ziniao: true } } }).enabled(),
    true,
  );
  assert.match(createAmazonAdapter({ ziniao: {} }).disabledHint(), /禁用/);

  // v0.13.0：渠道自己还有一枚开关（巡逻页那一行），它跟 CLI 总开关**分开判**。
  const channelOff = createAmazonAdapter({ ziniao: {}, settings: { channelEnabled: { amazon: false } } });
  assert.equal(channelOff.channelEnabled(), false, '渠道开关关掉了');
  assert.equal(channelOff.enabled(), false, '渠道关掉就不参与巡逻（CLI 开着也一样）');
  assert.match(channelOff.disabledHint(), /巡逻页/, '要指名道姓：是渠道被停用，不是 CLI 被禁用');
  const cliOff = createAmazonAdapter({ ziniao: {}, settings: { cliEnabled: { ziniao: false } } });
  assert.equal(cliOff.channelEnabled(), true, 'CLI 被禁用不影响「渠道开关开着」这个事实');
  assert.match(cliOff.disabledHint(), /紫鸟CLI/);
});
