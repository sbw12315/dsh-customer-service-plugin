import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AUTO_LOGIN_LABELS,
  COMPOSER_INPUT_SELECTOR,
  COMPOSER_INPUT_SELECTORS,
  COMPOSER_OPEN_SELECTORS,
  INBOX_PATH,
  INBOX_URL,
  LIST_SELECTORS,
  LIST_SCRIPT,
  LOGIN_FORM_SELECTORS,
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_POLL_MIN_INTERVAL_MS,
  LOGIN_STATES,
  LOGIN_TIMEOUT_MS,
  MESSAGE_CONTAINER_SELECTORS,
  MESSAGE_SELECTORS,
  PLATFORM_ID,
  PLATFORM_LABEL,
  ROW_SELECTORS,
  SEND_BUTTON_LABEL_RE,
  SEND_BUTTON_TEXT,
  SIGNIN_URL_RE,
  TEMPLATE_PICKER_TEXT,
  THREAD_SELECTORS,
  THREAD_SCRIPT,
  asObject,
  autoLoginStepScript,
  clickScript,
  clickScriptByIndex,
  conversationIdFromUrl,
  conversationUrl,
  createWalmartAdapter,
  isWalmartLoginUrl,
  isWalmartStore,
  parseDueText,
} from '../lib/platforms/walmart.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const adapterPath = path.join(here, '..', 'lib', 'platforms', 'walmart.js');
const playbookPath = path.join(here, '..', 'assets', 'playbooks', 'walmart.message.json');

/* ── 未登录判据：2026-10-10 本轮**实测**，两家沃尔玛店访问入口 302 到同一个 SSO 地址 ──
 * 这是本文件里登录相关的唯一真相源，别再抄字面量。 */
const WALMART_LOGIN_URL =
  'https://login.account.wal-mart.com/authorize?responseType=code&state=DGUA4XVFQK&scope=openId' +
  '&nonce=ZYHXBDAXPX&clientType=seller' +
  '&redirectUri=https://seller.walmart.com/aurora/v1/auroraScCoreService/rest/login/sso/hook' +
  '&clientId=66620dfd-1f3f-479b-8b9c-e11f36c5438b';

/** 真实紫鸟 store list 里的两家沃尔玛店（2026-10-10 实测）。 */
const WALMART_STORES = [
  { storeId: '27800343767219', storeName: 'Walmart-Cozynome-管理员', platformName: '沃尔玛-全球' },
  { storeId: '27470279549745', storeName: 'Walmart-Yanosaku二店-管理员', platformName: '沃尔玛-全球' },
];

/** 实机就挂着「已停用」的沃尔玛店：必须被排掉，否则巡逻会白开一次浏览器去撞登录页。 */
const RETIRED_WALMART_STORE = { storeId: '27151809366886', storeName: 'Walmart-Yanosaku-已停用', platformName: '沃尔玛-全球' };

const STORE_LIST = {
  items: [
    ...WALMART_STORES,
    RETIRED_WALMART_STORE,
    { storeId: 'tt1', storeName: 'Tiktok-FUSOU-客服主号', platformName: 'TikTok Shop-全球跨境(自运营)(新)' },
    { storeId: 'amz1', storeName: 'Amazon-Cozynome-管理员', platformName: '亚马逊-美国' },
  ],
};

/** 9/30 实机收件箱的缩影：4 条会话，行是 .message.p-16。 */
const LIST_PAYLOAD = {
  ok: true,
  url: INBOX_URL,
  title: 'Inbox | Walmart Seller Center',
  rowSelector: '.message.p-16',
  containerSelector: '.message-list',
  count: 4,
  items: [
    {
      index: 0,
      buyer: 'Salena Fuller',
      subject: 'Initiate a return, 200015455387691',
      snippet: 'Yes. Please send a label so I can return one please',
      date: '今天',
      due: '剩余时间：5 小时',
      orderId: '200015455387691',
      unread: true,
      href: '',
      raw: 'Salena Fuller Initiate a return, 200015455387691 今天',
    },
    {
      index: 1,
      buyer: 'Ayon Ghosh',
      subject: 'Please contact the customer - Damaged/Missing Parts/Not Received',
      snippet: 'kindly proceed with manual freight pickup',
      date: '今天',
      due: '',
      orderId: '200015267917133',
      unread: true,
      href: '',
      raw: 'Ayon Ghosh Please contact the customer - Damaged/Missing Parts/Not Received 今天',
    },
  ],
};

/**
 * 会话正文的缩影。
 * 注意方向：9/30 只确认了「买卖双方消息 + 时间戳 + 投递状态」，没有校准方向选择器，
 * 所以适配器用的是多重证据 —— 这份 fixture 里两条分别来自 align 与 delivery-status。
 */
const THREAD_PAYLOAD = {
  ok: true,
  url: INBOX_URL,
  title: 'Inbox | Walmart Seller Center',
  messageSelector: MESSAGE_SELECTORS[0],
  buyer: 'Natalyn Wright',
  subject: 'Message from Walmart.com Customer: Ask a question, 200015297529278',
  orderId: '200015297529278',
  dirSource: 'delivery-status',
  messages: [
    { index: 0, dir: 'in', dirGuess: true, dirSource: 'fallback', sender: 'Natalyn Wright', date: '10/10/2026 09:18 AM', body: 'I paid extra to have them build it.' },
    { index: 1, dir: 'out', dirGuess: false, dirSource: 'delivery-status-text', sender: 'Yanosaku Furniture', date: '10/10/2026 01:38 PM', body: 'Hello, once the product arrives, you can contact them to schedule an installation appointment.' },
  ],
  lastInbound: {
    index: 0,
    dir: 'in',
    dirGuess: true,
    dirSource: 'fallback',
    sender: 'Natalyn Wright',
    date: '10/10/2026 09:18 AM',
    body: 'I paid extra to have them build it.',
  },
  messageCount: 2,
};

/** 造一个只认预期调用的紫鸟客户端替身（与 amazon/tiktok 那套一致）。 */
function fakeZiniao(handlers = {}) {
  const calls = [];
  return {
    calls,
    async callOrThrow(args, opts) {
      calls.push(args);
      const key = args[0] + ' ' + args[1];
      const handler = handlers[key];
      if (!handler) throw new Error('未预期的调用：' + args.join(' '));
      return handler(args, opts);
    },
    async call(args) {
      calls.push(args);
      const key = args[0] + ' ' + args[1];
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

/** 从一次 page exec 调用里取回脚本正文。 */
const scriptOf = (args) => String(args[args.indexOf('--script') + 1] ?? '');
/** page exec 的信封：callOrThrow 的返回值（三层包装里的可序列化形态）。 */
const execEnvelope = (payload) => ({ data: { result: JSON.stringify(payload), ok: true } });

/** 三种脚本的判据（按脚本里独有的字样区分，避免靠顺序猜）。 */
const isListScript = (script) => script.includes('rowSelector: rowsFound.sel');
const isThreadScript = (script) => script.includes('messageSelector: found.sel');
const isClickScript = (script) => script.includes('scrollIntoView');

/**
 * 造一个「页面地址随轮询变化」的紫鸟替身：头 N 个 location.href 读数是 url，之后换成 nextUrl。
 * 只有 location.href / document.title 两种 page exec —— 登录链路上不该出现别的脚本。
 */
function pageZiniao(options = {}) {
  const url = options.url ?? '';
  const nextUrl = options.nextUrl ?? '';
  const switchAfter = options.switchAfter ?? 0;
  const title = options.title ?? 'Walmart Seller Center';
  const calls = [];
  let readings = 0;
  return {
    calls,
    async callOrThrow(args) {
      calls.push(args);
      if (args[0] === 'page' && args[1] === 'visit') return { ok: true };
      if (args[0] === 'store' && args[1] === 'open') return { ok: true };
      throw new Error('未预期的调用：' + args.join(' '));
    },
    async call(args) {
      calls.push(args);
      const script = scriptOf(args);
      if (!(args[0] === 'page' && args[1] === 'exec')) return { ok: true, data: null };
      if (script === 'document.title') return { ok: true, data: { result: title } };
      if (script === 'location.href') {
        readings += 1;
        const switched = switchAfter > 0 && readings > switchAfter && Boolean(nextUrl);
        return { ok: true, data: { result: switched ? nextUrl : url } };
      }
      throw new Error('登录链路上不该跑这个脚本：' + script);
    },
  };
}

/** 假时钟：sleep 只是记账（要断言「等了多少 / 间隔多大」），now 只有 sleep 会推进。 */
function fakeClock(start = 0) {
  let current = start;
  const slept = [];
  return {
    slept,
    now: () => current,
    sleep: async (ms) => {
      slept.push(ms);
      current += ms;
    },
  };
}

/** 断言这次调用序列里没有任何一次点击/输入，且没有任何参数落在登录表单相关选择器上。 */
function assertNoLoginAutomation(calls) {
  const clicks = calls.filter((args) => args.includes('click'));
  assert.deepEqual(clicks, [], '登录链路里不允许出现点击');
  const inputs = calls.filter((args) => args.includes('input'));
  assert.deepEqual(inputs, [], '登录链路里不允许出现输入');
  const flat = calls.map((args) => args.join(' ')).join('\n');
  for (const selector of LOGIN_FORM_SELECTORS) {
    assert.equal(flat.includes(selector), false, '不许碰登录表单选择器：' + selector);
  }
  assert.equal(/密码|验证码|滑块|captcha|password|otp/i.test(flat), false, '调用参数里不许出现账号/验证码/滑块语义');
}

/* ── 平台判定与常量 ─────────────────────────────────────────────────────────── */

test('isWalmartStore：认「沃尔玛-XX」与 Walmart-* 店铺名，不认亚马逊/TikTok', () => {
  for (const store of WALMART_STORES) assert.equal(isWalmartStore(store), true, store.storeName);
  assert.equal(isWalmartStore({ platformName: '沃尔玛-全球' }), true);
  // 运营手工建的店里，platformName 可能被写成别的，但店铺名带 Walmart —— 这种情况也要认。
  assert.equal(isWalmartStore({ storeName: 'Walmart-Cozynome-管理员' }), true);
  assert.equal(isWalmartStore({ platformName: '亚马逊-美国', storeName: 'Amazon-Cozynome-管理员' }), false);
  assert.equal(isWalmartStore({ platformName: 'TikTok Shop-全球跨境(自运营)(新)' }), false);
  assert.equal(isWalmartStore({}), false);
});

test('isWalmartLoginUrl：实测的 SSO 跳转认出来，Customer 页不认', () => {
  assert.equal(isWalmartLoginUrl(WALMART_LOGIN_URL), true);
  assert.equal(isWalmartLoginUrl('https://seller.walmart.com/aurora/v1/login/sso/hook'), true);
  assert.equal(isWalmartLoginUrl(INBOX_URL), false);
  assert.equal(isWalmartLoginUrl('https://seller.walmart.com/homepage'), false);
  assert.equal(isWalmartLoginUrl(''), false);
  assert.equal(SIGNIN_URL_RE.test(WALMART_LOGIN_URL), true);
});

test('parseDueText：分钟/小时/天与超时都能换算', () => {
  assert.deepEqual(parseDueText('剩余时间：5 小时'), { minutes: 300, overdue: false });
  assert.deepEqual(parseDueText('到期时间：12 分钟'), { minutes: 12, overdue: false });
  assert.deepEqual(parseDueText('已超期 3 小时'), { minutes: -180, overdue: true });
  assert.deepEqual(parseDueText('Due in 2 days'), { minutes: 2880, overdue: false });
  assert.deepEqual(parseDueText(''), null);
  assert.equal(parseDueText('48 小时内回复').minutes, 2880);
});

test('conversationUrl：本平台**没有**已校准的会话级深链，永远返回空串', () => {
  // 空串（而不是退回收件箱首页）是刻意的：一个能点开、看着像对的错链接比没有链接糟得多。
  assert.equal(conversationUrl(''), '');
  assert.equal(conversationUrl('anything'), '');
  assert.equal(conversationUrl('200015455387691'), '');
});

test('conversationIdFromUrl：认几种常见参数名，取不到就空串（不猜）', () => {
  assert.equal(conversationIdFromUrl(INBOX_URL + '?conversation_id=conv-1'), 'conv-1');
  assert.equal(conversationIdFromUrl(INBOX_URL + '?conversationId=conv-2'), 'conv-2');
  assert.equal(conversationIdFromUrl(INBOX_URL + '&message_id=msg-3'), 'msg-3');
  assert.equal(conversationIdFromUrl(INBOX_URL), '', '实测地址里没有会话 id');
  assert.equal(conversationIdFromUrl(''), '');
});

test('asObject：兼容对象与 JSON 字符串两种返回', () => {
  assert.deepEqual(asObject('{"ok":true}'), { ok: true });
  assert.deepEqual(asObject({ ok: true }), { ok: true });
  assert.equal(asObject('not json'), null);
  assert.equal(asObject(null), null);
});

/* ── 安全：本平台里不存在任何发送动作 ───────────────────────────────────────── */

test('发送按钮：知道它的文案，但代码里没有任何一处会点它或往它旁边填', () => {
  const src = fs.readFileSync(adapterPath, 'utf8');
  // 9/30 只取到文案（「发送回复」），**没有** CSS 选择器 —— 本文件刻意不编一个。
  assert.equal(SEND_BUTTON_TEXT, '发送回复');
  assert.equal(SEND_BUTTON_LABEL_RE.test('发送回复'), true);
  assert.equal(SEND_BUTTON_LABEL_RE.test('Send Reply'), true);

  // 文案只允许出现在常量/注释里，绝不允许被拿去拼选择器或送进点击链路。
  const codeLines = src
    .split('\n')
    .map((line, i) => ({ line, no: i + 1 }))
    .filter((entry) => entry.line.includes('发送回复') && !/^\s*(\/\/|\*|\/\*)/.test(entry.line))
    .map((entry) => entry.line.trim());
  assert.deepEqual(
    codeLines,
    [
      "export const SEND_BUTTON_TEXT = '发送回复';",
      'export const SEND_BUTTON_LABEL_RE = /发送回复|send\\s*reply/i;',
    ],
    '发送按钮文案只允许出现在这两个常量声明里',
  );

  // 不存在任何「发送动作」函数。
  const actionFns = src.match(/function\s+(sendMessage|submitReply|doSend|clickSend)\b/g) ?? [];
  assert.deepEqual(actionFns, [], '不允许存在发送动作函数');

  // 「选择消息模板」也只是记录，不是我们要去点的东西。
  assert.equal(TEMPLATE_PICKER_TEXT, '选择消息模板');
  const templateFn = src.match(/function\s+(pickTemplate|selectTemplate|useTemplate)\b/g) ?? [];
  assert.deepEqual(templateFn, [], '不允许存在点模板的函数');
});

test('页面脚本里的点击一律走 scrollIntoView + click，不走 page click', () => {
  const src = fs.readFileSync(adapterPath, 'utf8');
  assert.match(src, /scrollIntoView\(\{ block: "center"/);
  // 只查**代码行**：注释里本来就要写明「不走 page click / 永远不加 --headless」这两条约定。
  const codeSrc = src
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  // 不能用紫鸟的 page click（实测在真实店铺上会 ELEMENT_NOT_INTERACTABLE）。
  assert.equal(codeSrc.includes("['page', 'click'"), false, '不能走 page click');
  // 也永远不开无头窗口。
  assert.equal(codeSrc.includes('--headless'), false, '永远不开无头：填了没人看得到');
});

/* ── 登录：把页面摆好，人来做 ───────────────────────────────────────────────── */

test('adapter.visitInbox：被弹回登录页时抛 kind=auth + 可照做的 hint', async () => {
  const ziniao = fakeZiniao({
    'page visit': () => ({ ok: true }),
    'page exec': () => ({ data: { result: WALMART_LOGIN_URL } }),
  });
  const adapter = createWalmartAdapter({ ziniao });
  const error = await adapter
    .visitInbox({ storeId: WALMART_STORES[0].storeId, storeName: WALMART_STORES[0].storeName })
    .then(() => null)
    .catch((cause) => cause);
  assert.ok(error, '未登录必须抛错');
  assert.equal(error.kind, 'auth', '要说清是登录问题，不是页面结构问题');
  assert.match(error.message, /未登录/);
  assert.match(error.hint, /登录/, 'hint 要能照做');
});

test('adapter.prepare：未登录时也在 prepare 这一层抛 kind=auth', async () => {
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': () => ({ data: { result: WALMART_LOGIN_URL } }),
  });
  const adapter = createWalmartAdapter({ ziniao });
  await assert.rejects(
    () => adapter.prepare(WALMART_STORES[0]),
    (cause) => cause.kind === 'auth',
  );
});

test('adapter.prepare：没跳登录页但收件箱也没出来时，如实报「试过哪些选择器」', async () => {
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': () => ({ data: { result: INBOX_URL } }),
    'page wait-element': () => ({ ok: false, error: { kind: 'element', message: 'not found' } }),
  });
  const adapter = createWalmartAdapter({ ziniao });
  const error = await adapter.prepare(WALMART_STORES[0]).then(() => null).catch((cause) => cause);
  assert.equal(error.kind, 'page');
  assert.match(error.message, /未校准|已改版/, '要明说选择器没校准，别让人以为是登录问题');
  assert.ok(error.message.includes(ROW_SELECTORS[0]), '要把试过的行选择器带出来，方便定位');
  assert.ok(error.message.includes(INBOX_PATH), '也要说清是哪个入口');
});

test('adapter.prepare：正常路径 = 开店铺 → 进 Customer 收件箱 → 等到行', async () => {
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': () => ({ data: { result: INBOX_URL } }),
    'page wait-element': () => ({ ok: true }),
  });
  const adapter = createWalmartAdapter({ ziniao });
  await adapter.prepare(WALMART_STORES[0]);

  const open = ziniao.calls.find((args) => args[0] === 'store' && args[1] === 'open');
  assert.ok(open.includes(WALMART_STORES[0].storeId));
  const visited = ziniao.calls.find((args) => args[0] === 'page' && args[1] === 'visit');
  assert.ok(visited.includes(INBOX_URL), '入口必须是实测的 Customer 收件箱');
  const wait = ziniao.calls.find((args) => args[0] === 'page' && args[1] === 'wait-element');
  assert.ok(wait.includes(ROW_SELECTORS[0]), '等的是实测过的行（.message.p-16），不是猜出来的容器');
});

test('adapter.checkLogin：已登录 / 未登录 / 读不到地址 三种结果，且**不产生副作用**', async () => {
  const store = WALMART_STORES[0];
  const cases = [
    { url: 'https://seller.walmart.com/homepage', state: LOGIN_STATES.LOGGED_IN, loggedIn: true },
    { url: WALMART_LOGIN_URL, state: LOGIN_STATES.LOGIN_REQUIRED, loggedIn: false },
    { url: '', state: LOGIN_STATES.FAILED, loggedIn: false },
  ];
  for (const item of cases) {
    const ziniao = fakeZiniao({ 'page exec': () => ({ data: { result: item.url } }) });
    const adapter = createWalmartAdapter({ ziniao });
    const probe = await adapter.checkLogin(store);
    assert.equal(probe.state, item.state, item.url);
    assert.equal(probe.loggedIn, item.loggedIn);
    assert.ok(probe.hint, '每个状态都要有一句人话');
    // 探测只有一次 page exec（读地址）：不开店铺、不导航、不点、不填。
    assert.deepEqual(
      ziniao.calls.map((args) => args[0] + ' ' + args[1]),
      ['page exec'],
      'checkLogin 只允许读一次地址',
    );
    assert.equal(scriptOf(ziniao.calls[0]), 'location.href');
  }
});

test('adapter.openLogin：把人摆到登录页就停手 —— 不点登录、不填账号密码、不碰滑块', async () => {
  const ziniao = pageZiniao({ url: WALMART_LOGIN_URL });
  const adapter = createWalmartAdapter({ ziniao });
  const result = await adapter.openLogin(WALMART_STORES[0]);
  assert.equal(result.state, LOGIN_STATES.LOGIN_REQUIRED);
  assert.match(result.hint, /请你本人完成登录/);
  assertNoLoginAutomation(ziniao.calls);
  assert.equal(ziniao.calls.some((args) => args.includes('--headless')), false, '登录页必须在可见窗口里');
});

test('adapter.openLogin：已登录时直接说已登录，不多此一举', async () => {
  const ziniao = pageZiniao({ url: 'https://seller.walmart.com/homepage', title: 'Home | Walmart Seller Center' });
  const adapter = createWalmartAdapter({ ziniao });
  const result = await adapter.openLogin(WALMART_STORES[0]);
  assert.equal(result.state, LOGIN_STATES.LOGGED_IN);
  assert.equal(result.title, 'Home | Walmart Seller Center');
  assertNoLoginAutomation(ziniao.calls);
});

test('adapter.openLogin：打不开店铺时报 failed（带 error），而不是含糊的「未登录」', async () => {
  const ziniao = {
    calls: [],
    async callOrThrow(args) {
      this.calls.push(args);
      throw new Error('内核下载失败');
    },
    async call() {
      return { ok: false, data: null };
    },
  };
  const adapter = createWalmartAdapter({ ziniao });
  const result = await adapter.openLogin(WALMART_STORES[0]);
  assert.equal(result.state, LOGIN_STATES.FAILED);
  assert.match(result.error, /内核下载失败/);
  assert.match(result.hint, /先修这个再谈登录/);
});

test('adapter.waitForLogin：第 N 次轮询后成功（假时钟，绝不真等 5 分钟）', async () => {
  const clock = fakeClock();
  // 前 2 次读到登录页，第 3 次读到卖家中心。
  const readings = [WALMART_LOGIN_URL, WALMART_LOGIN_URL, 'https://seller.walmart.com/homepage'];
  let index = 0;
  const ziniao = fakeZiniao({
    'page exec': () => {
      const url = readings[Math.min(index, readings.length - 1)];
      index += 1;
      return { data: { result: url } };
    },
  });
  const adapter = createWalmartAdapter({ ziniao });
  const result = await adapter.waitForLogin(WALMART_STORES[0], { sleep: clock.sleep, now: clock.now });
  assert.equal(result.state, LOGIN_STATES.LOGGED_IN);
  assert.equal(result.attempts, 3);
  assert.equal(clock.slept.length, 2, '成功那一次不再睡');
  assert.deepEqual(clock.slept, [LOGIN_POLL_INTERVAL_MS, LOGIN_POLL_INTERVAL_MS]);
});

test('adapter.waitForLogin：一直没登录就超时，且报出等了多久', async () => {
  const clock = fakeClock();
  const ziniao = fakeZiniao({ 'page exec': () => ({ data: { result: WALMART_LOGIN_URL } }) });
  const adapter = createWalmartAdapter({ ziniao });
  const result = await adapter.waitForLogin(WALMART_STORES[0], {
    sleep: clock.sleep,
    now: clock.now,
    timeoutMs: 9000,
  });
  assert.equal(result.state, LOGIN_STATES.TIMEOUT);
  assert.equal(result.waitedMs, 9000);
  assert.match(result.hint, /再完成一次登录/);
});

test('adapter.waitForLogin：轮询节奏与默认值（间隔 >= 3 秒、总超时 5 分钟）', async () => {
  assert.equal(LOGIN_POLL_INTERVAL_MS, 3000);
  assert.equal(LOGIN_POLL_MIN_INTERVAL_MS, 3000);
  assert.equal(LOGIN_TIMEOUT_MS, 300000);
  const clock = fakeClock();
  const ziniao = fakeZiniao({ 'page exec': () => ({ data: { result: WALMART_LOGIN_URL } }) });
  const adapter = createWalmartAdapter({ ziniao });
  const result = await adapter.waitForLogin(WALMART_STORES[0], {
    sleep: clock.sleep,
    now: clock.now,
    intervalMs: 10, // 低于下限，必须被抬回 3 秒
    timeoutMs: 9000,
  });
  assert.equal(result.state, LOGIN_STATES.TIMEOUT);
  assert.deepEqual(clock.slept, [3000, 3000, 3000], '间隔下限 3 秒，最后只睡剩下的时间');
});

test('登录链路：代码与调用参数里都没有任何登录表单操作（回归锁）', () => {
  const src = fs.readFileSync(adapterPath, 'utf8');
  // LOGIN_FORM_SELECTORS 只允许出现在它的常量声明块里 —— 别处引用即视为「准备代填登录」。
  const lines = src.split('\n');
  const declStart = lines.findIndex((line) => line.includes('export const LOGIN_FORM_SELECTORS'));
  assert.ok(declStart > 0, '登录表单选择器必须有且只有一个声明块');
  const declEnd = lines.findIndex((line, i) => i > declStart && line.trim() === ']);');
  assert.ok(declEnd > declStart, '声明块要能收口');
  const refs = lines
    .map((line, i) => ({ line: line.trim(), no: i }))
    .filter((entry) => /input\[type="password"\]|input\[name="email"\]|autocomplete="one-time-code"/.test(entry.line));
  assert.ok(refs.length >= 3, '声明块里本来就列了几条登录表单选择器');
  for (const ref of refs) {
    assert.ok(
      ref.no >= declStart && ref.no <= declEnd,
      '登录表单选择器只允许出现在声明块内，别处引用即视为「准备代填登录」：' + ref.line,
    );
  }
  // 不存在任何代填登录的函数。
  const fns = src.match(/function\s+(fillLogin|typePassword|solveCaptcha|submitLogin|loginAs)\b/g) ?? [];
  assert.deepEqual(fns, [], '不允许存在代填登录的函数');
});

/* ── 巡逻面：引擎只认这几个方法 ─────────────────────────────────────────────── */

test('adapter.listAllStores 给全量、listStores 只给沃尔玛店', async () => {
  const ziniao = fakeZiniao({ 'store list': () => STORE_LIST });
  const adapter = createWalmartAdapter({ ziniao });

  // 「扫描可用店铺」要看到全量：非沃尔玛店也得列出来，界面才能解释它为什么不被巡逻。
  const all = await adapter.listAllStores();
  assert.deepEqual(all.map((store) => store.storeId), [
    '27800343767219',
    '27470279549745',
    '27151809366886',
    'tt1',
    'amz1',
  ]);
  assert.equal(all.find((store) => store.storeId === '27151809366886').retired, true, '规范化时就该打上停用标记');

  const walmart = await adapter.listStores();
  assert.deepEqual(walmart.map((store) => store.storeId), ['27800343767219', '27470279549745']);
  assert.equal(walmart.some((store) => /amazon|tiktok/i.test(store.storeName)), false, '不能混进别的平台');
  assert.equal(walmart.some((store) => /停用/.test(store.storeName)), false, '挂着「已停用」的店不巡逻（实机 Walmart-Yanosaku-已停用）');
});

test('adapter.extractList：解出会话列表、行选择器与容器回显', async () => {
  const ziniao = fakeZiniao({
    'page exec': (args) => {
      const script = scriptOf(args);
      assert.equal(isListScript(script), true, '这里应该跑列表脚本');
      return execEnvelope(LIST_PAYLOAD);
    },
  });
  const adapter = createWalmartAdapter({ ziniao });
  const list = await adapter.extractList(WALMART_STORES[0]);
  assert.equal(list.url, INBOX_URL);
  assert.equal(list.rowSelector, '.message.p-16', '实测的行选择器要能被回显');
  assert.equal(list.containerSelector, '.message-list');
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0].buyer, 'Salena Fuller');
  assert.equal(list.items[0].orderId, '200015455387691');
});

test('adapter.listConversations：顺手把「剩余时间」文案解析成 dueMinutes', async () => {
  const ziniao = fakeZiniao({
    'page exec': () => execEnvelope(LIST_PAYLOAD),
  });
  const adapter = createWalmartAdapter({ ziniao });
  const list = await adapter.listConversations(WALMART_STORES[0]);
  assert.equal(list.items[0].dueMinutes, 300, '「剩余时间：5 小时」= 300 分钟');
  assert.equal(list.items[1].dueMinutes, null, '没有时限文案就是 null，不是 0');
});

test('adapter.extractList：兜底选择器全落空时，错误里带 reason 与试过的选择器', async () => {
  const ziniao = fakeZiniao({
    'page exec': () => execEnvelope({ ok: false, reason: 'no-rows', tried: { row: ROW_SELECTORS } }),
  });
  const adapter = createWalmartAdapter({ ziniao });
  const error = await adapter.extractList(WALMART_STORES[0]).then(() => null).catch((cause) => cause);
  assert.ok(error, '读不到列表必须抛错，不能静默返回空');
  assert.equal(error.kind, 'page');
  assert.equal(error.reason, 'no-rows');
  assert.ok(error.message.includes(ROW_SELECTORS[0]), '要把试过的行选择器带出来，方便校准');
  assert.match(error.message, /未登录|改版/);
});

test('adapter.openConversation：按数组下标点行（不能用 :nth-of-type），且不等同于 page click', async () => {
  const ziniao = fakeZiniao({
    'page exec': (args) => {
      const script = scriptOf(args);
      assert.equal(isClickScript(script), true);
      assert.ok(script.includes('document.querySelectorAll(sel)'), '要在脚本内 querySelectorAll 后按下标取');
      assert.ok(script.includes('const idx = 2;'), '下标要与列表解析出的 index 同源');
      return execEnvelope({ ok: true, used: '.message.p-16', count: 4, index: 2 });
    },
    'page wait-element': () => ({ ok: true }),
  });
  const adapter = createWalmartAdapter({ ziniao });
  await adapter.openConversation(WALMART_STORES[0], 2);

  const flat = ziniao.calls.map((args) => args.join(' ')).join('\n');
  assert.equal(/nth-of-type/.test(flat), false, '不许用 nth-of-type 定位会话行');
  assert.equal(ziniao.calls.some((args) => args[0] === 'page' && args[1] === 'click'), false, '不走 page click');
  const wait = ziniao.calls.find((args) => args[0] === 'page' && args[1] === 'wait-element');
  assert.ok(wait.includes(MESSAGE_SELECTORS[0]), '点开之后等的是消息元素');
});

test('adapter.openConversation：行不在列表里了要说清楚，而不是含糊的「点不动」', async () => {
  const ziniao = fakeZiniao({
    'page exec': () => execEnvelope({ ok: false, reason: 'index-out-of-range', count: 1, index: 5 }),
  });
  const adapter = createWalmartAdapter({ ziniao });
  const error = await adapter.openConversation(WALMART_STORES[0], 5).then(() => null).catch((cause) => cause);
  assert.match(error.message, /第 6 条会话不在列表里了/);
  assert.match(error.message, /可能已刷新|已失效/);
});

test('adapter.extractThread：解出正文、最后一条买家消息与方向判定来源', async () => {
  const ziniao = fakeZiniao({ 'page exec': () => execEnvelope(THREAD_PAYLOAD) });
  const adapter = createWalmartAdapter({ ziniao });
  const thread = await adapter.extractThread(WALMART_STORES[0]);
  assert.equal(thread.messages.length, 2);
  assert.equal(thread.lastInbound.body, 'I paid extra to have them build it.');
  assert.equal(thread.dirSource, 'delivery-status');
  assert.equal(thread.messages[0].dir, 'in');
  assert.equal(thread.messages[1].dir, 'out');
});

test('adapter.extractThread：读到空会话会重读，不把「还在渲染」当结论', async () => {
  let calls = 0;
  const ziniao = fakeZiniao({
    'page exec': () => {
      calls += 1;
      return calls === 1 ? execEnvelope({ ...THREAD_PAYLOAD, messages: [], messageCount: 0 }) : execEnvelope(THREAD_PAYLOAD);
    },
  });
  const adapter = createWalmartAdapter({ ziniao });
  const thread = await adapter.extractThread(WALMART_STORES[0]);
  assert.equal(calls, 2, '空会话要重读一次');
  assert.equal(thread.messages.length, 2);
});

test('adapter.extractThread：一直没有消息时，reason 与试过的选择器一起报出来', async () => {
  const ziniao = fakeZiniao({
    'page exec': () => execEnvelope({ ok: false, reason: 'no-messages', tried: { message: MESSAGE_SELECTORS } }),
  });
  const adapter = createWalmartAdapter({ ziniao });
  const error = await adapter.extractThread(WALMART_STORES[0]).then(() => null).catch((cause) => cause);
  assert.equal(error.kind, 'page');
  assert.equal(error.reason, 'no-messages');
  assert.ok(error.message.includes(MESSAGE_SELECTORS[0]), '要把试过的消息选择器带出来');
});

test('adapter.readConversation：脚本点行 + 读正文，全程不碰输入框', async () => {
  const ziniao = fakeZiniao({
    'page exec': (args) => {
      const script = scriptOf(args);
      if (isClickScript(script)) return execEnvelope({ ok: true, used: '.message.p-16' });
      if (isThreadScript(script)) return execEnvelope(THREAD_PAYLOAD);
      throw new Error('未预期的脚本：' + script.slice(0, 40));
    },
    'page wait-element': () => ({ ok: true }),
  });
  const adapter = createWalmartAdapter({ ziniao });
  const thread = await adapter.readConversation(WALMART_STORES[0], { index: 0 });
  assert.equal(thread.messageCount, 2);
  // 巡逻链路里不允许出现输入动作（填入是人工点单条草稿才走的路）。
  assert.equal(ziniao.calls.some((args) => args[1] === 'input'), false, '巡逻不能填表');
});

/* ── 填入回复框：只填不发送 ─────────────────────────────────────────────────── */

test('adapter.fillComposer：打开收件箱并填文本，全程不点发送、不编深链', async () => {
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': (args) => {
      const script = scriptOf(args);
      if (script === 'location.href') return { data: { result: INBOX_URL } };
      if (isClickScript(script)) return execEnvelope({ ok: false, reason: 'missing' });
      throw new Error('未预期的脚本');
    },
    'page wait-element': () => ({ ok: true }),
    'page input': () => ({ ok: true }),
  });
  const adapter = createWalmartAdapter({ ziniao });
  const result = await adapter.fillComposer(WALMART_STORES[0], 'Hello Salena, ...');

  assert.equal(result.filled, true);
  assert.equal(result.length, 17);
  // 没有会话级深链：必须如实说「没能自动定位」，不能让人以为定位过了。
  assert.equal(result.located, false);
  assert.match(result.locatedNote, /当前打开/);
  assert.equal(result.url, INBOX_URL, '退回的就是收件箱入口，不是编出来的链接');

  const visited = ziniao.calls.find((args) => args[0] === 'page' && args[1] === 'visit');
  assert.ok(visited.includes(INBOX_URL));
  const input = ziniao.calls.find((args) => args[1] === 'input');
  assert.ok(input.includes('Hello Salena, ...'));
  assert.equal(input.includes('--clear'), true, '填入前要清空，避免叠在上一条草稿后面');
  // 整个链路里除了 page input，不允许出现任何点击。
  const otherClicks = ziniao.calls.filter((args) => args[0] === 'page' && args[1] === 'click');
  assert.deepEqual(otherClicks, []);
});

test('adapter.fillComposer：被弹回登录页时抛 kind=auth（导航同样可能被弹回）', async () => {
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': () => ({ data: { result: WALMART_LOGIN_URL } }),
  });
  const adapter = createWalmartAdapter({ ziniao });
  await assert.rejects(
    () => adapter.fillComposer(WALMART_STORES[0], 'hello'),
    (cause) => cause.kind === 'auth',
  );
});

test('adapter.fillOpenConversation：逐个试兜底输入框，命中哪个就报哪个（方便回填校准）', async () => {
  const ziniao = fakeZiniao({
    'page exec': () => execEnvelope({ ok: false, reason: 'missing' }),
    'page wait-element': (args) => {
      const selector = args[args.indexOf('--selector') + 1];
      // 第一位（实测的 placeholder）没命中，第二位（中文「回复」）命中 —— 校验兜底顺序真的在走。
      return selector === COMPOSER_INPUT_SELECTORS[0] ? { ok: false } : { ok: true };
    },
    'page input': () => ({ ok: true }),
  });
  const adapter = createWalmartAdapter({ ziniao });
  const result = await adapter.fillOpenConversation(WALMART_STORES[0], 'draft body');
  assert.equal(result.filled, true);
  assert.equal(result.inputSelector, COMPOSER_INPUT_SELECTORS[1], '要报出实际命中的那个选择器');
  const input = ziniao.calls.find((args) => args[1] === 'input');
  assert.ok(input.includes(COMPOSER_INPUT_SELECTORS[1]));
});

test('adapter.fillOpenConversation：连输入框都找不到时才报错，且把试过的选择器列出来', async () => {
  const ziniao = fakeZiniao({
    'page exec': () => ({ ok: true }),
    'page wait-element': () => ({ ok: false }),
  });
  const adapter = createWalmartAdapter({ ziniao });
  const error = await adapter.fillOpenConversation(WALMART_STORES[0], 'draft body')
    .then(() => null)
    .catch((cause) => cause);
  assert.equal(error.kind, 'page');
  for (const selector of COMPOSER_INPUT_SELECTORS) {
    assert.ok(error.message.includes(selector), '试过的选择器都要列出来：' + selector);
  }
});

test('adapter.fillComposer / fillOpenConversation：空草稿直接拒绝', async () => {
  const ziniao = fakeZiniao({});
  const adapter = createWalmartAdapter({ ziniao });
  await assert.rejects(() => adapter.fillComposer(WALMART_STORES[0], '   '), /草稿内容为空/);
  await assert.rejects(() => adapter.fillOpenConversation(WALMART_STORES[0], ''), /草稿内容为空/);
  assert.deepEqual(ziniao.calls, [], '空草稿连店铺都不该打开');
});

/* ── 巡逻契约、开关与校准位 ─────────────────────────────────────────────────── */

test('巡逻契约：引擎要的成员一个不少，且都是正确类型', () => {
  const adapter = createWalmartAdapter({ ziniao: fakeZiniao({}) });
  assert.equal(adapter.id, PLATFORM_ID);
  assert.equal(adapter.label, PLATFORM_LABEL);
  assert.equal(adapter.kind, 'store');
  assert.equal(adapter.inboxUrl, INBOX_URL);
  assert.equal(adapter.queueChannel, 'walmart');
  assert.equal(adapter.draftKind, 'walmart');
  for (const method of ['listSources', 'prepare', 'listConversations', 'readConversation', 'fillOpenConversation', 'fillComposer', 'checkLogin', 'openLogin', 'waitForLogin', 'autoLogin', 'closeSource']) {
    assert.equal(typeof adapter[method], 'function', method + ' 必须是函数');
  }
  assert.equal(adapter.conversationUrl, conversationUrl);
  assert.equal(adapter.conversationId({ url: INBOX_URL }), '');
  assert.equal(adapter.hasConversationUrl, false, '没有深链，界面据此隐藏「打开原会话」');
  assert.equal(adapter.supportsAutoLogin, true, '巡逻预检到未登录时会调 autoLogin（只点按钮，不代填凭据）');
});

test('禁用的渠道：紫鸟CLI 在设置里被关掉时不再参与巡逻', () => {
  const z = fakeZiniao({});
  assert.equal(createWalmartAdapter({ ziniao: z, settings: { cliEnabled: { ziniao: false } } }).enabled(), false);
  assert.equal(createWalmartAdapter({ ziniao: z, settings: { cliEnabled: { ziniao: true } } }).enabled(), true);
  assert.equal(createWalmartAdapter({ ziniao: z }).enabled(), true, '没配置时默认开启');
  const adapter = createWalmartAdapter({ ziniao: z, settings: { cliEnabled: { ziniao: false } } });
  assert.match(adapter.disabledHint(), /紫鸟CLI/, '禁用时要有一句能照做的说明');

  // v0.13.0：渠道自己的开关（巡逻页那一行）与 CLI 总开关分开判。
  const channelOff = createWalmartAdapter({ ziniao: z, settings: { channelEnabled: { walmart: false } } });
  assert.equal(channelOff.channelEnabled(), false);
  assert.equal(channelOff.enabled(), false);
  assert.match(channelOff.disabledHint(), /巡逻页/, '要说清是渠道被停用');
  assert.equal(adapter.channelEnabled(), true, 'CLI 被禁用不影响渠道开关本身');
});

test('校准位：verified=true + calibrationNote，且写清校准现场与尚未覆盖的部分', () => {
  const adapter = createWalmartAdapter({ ziniao: fakeZiniao({}) });
  assert.equal(adapter.verified, true, '2026-10-10 已在真实的登录态 DOM 上校准');
  assert.match(adapter.calibrationNote, /已校准/);
  assert.match(adapter.calibrationNote, /27470279549745/, '要说清是哪家店校准的');
  assert.match(adapter.calibrationNote, /深链/, '没覆盖的部分（没有会话级深链）也要写出来');
});

test('回归锁：消息选择器里不许有裸 .message，回复框候选里不许有裸 textarea', () => {
  // 这两条都是 2026-10-10 实机校准撞出来的真事故级假命中：
  //   裸 .message = 25 条**列表行**（会被当成会话正文，草稿全建在错误内容上）；
  //   裸 textarea = 沃尔玛 Marty AI 助手的输入框（客服草稿会被打进 AI 对话框）。
  assert.equal(MESSAGE_SELECTORS.includes('.message'), false, '裸 .message 是列表行的类名');
  assert.equal(MESSAGE_SELECTORS.some((s) => s.trim() === '.message'), false);
  assert.equal(COMPOSER_INPUT_SELECTORS.includes('textarea'), false, '裸 textarea 会命中 AI 助手输入框');
  assert.equal(COMPOSER_INPUT_SELECTORS.some((s) => s.includes('placeholder')), false, '回复框根本没有 placeholder 属性');
});

/* ── 剧本：与代码逐字对齐、发送步骤永久锁死 ─────────────────────────────────── */

test('剧本：verified=true，校准现场与尚未覆盖的两栏都要写清楚', () => {
  const playbook = JSON.parse(fs.readFileSync(playbookPath, 'utf8'));
  assert.equal(playbook.id, 'walmart.message');
  assert.equal(playbook.platform, PLATFORM_ID);
  assert.equal(playbook.verified, true, '2026-10-10 已在真实店铺的登录态下校准');
  assert.equal(playbook.calibration.state, 'verified');
  assert.ok(playbook.calibration.verifiedStore.includes('27470279549745'), '要写清是哪家店校准的');
  assert.ok(playbook.calibration.verified.length >= 6, '实测过的部分要列出来');
  assert.ok(playbook.calibration.pending.length >= 3, '尚未覆盖的部分也要列出来');
  assert.ok(playbook.calibration.howTo.length >= 3, '要给一条能照着做的重校准路径');
  assert.ok(playbook.calibration.verified.some((line) => line.includes('.message.p-16')), '实测的行选择器要写进去');
});

test('剧本与代码的选择器不能漂移（逐字对照 lib/platforms/walmart.js 的导出常量）', () => {
  const playbook = JSON.parse(fs.readFileSync(playbookPath, 'utf8'));
  assert.equal(playbook.entry.url, INBOX_URL);
  assert.equal(playbook.list.waitFor.selector, ROW_SELECTORS[0], '等的是实测过的行');
  assert.equal(playbook.list.items.selector, ROW_SELECTORS[0]);
  assert.deepEqual(playbook.list.items.rowSelectors, ROW_SELECTORS);
  assert.deepEqual(playbook.list.containerSelectors, LIST_SELECTORS);
  assert.equal(playbook.read.selector, THREAD_SELECTORS[0]);
  assert.deepEqual(playbook.read.threadSelectors, THREAD_SELECTORS);
  assert.deepEqual(playbook.read.messageContainerSelectors, MESSAGE_CONTAINER_SELECTORS);
  assert.deepEqual(playbook.read.messageSelectors, MESSAGE_SELECTORS);
  assert.equal(playbook.reply.inputSelector, COMPOSER_INPUT_SELECTOR);
  assert.deepEqual(playbook.reply.inputSelectors, COMPOSER_INPUT_SELECTORS);
  assert.equal(playbook.reply.openSelector, '', '实测回复框常驻展开：没有「展开回复框」这一步');
  assert.deepEqual(COMPOSER_OPEN_SELECTORS, []);
  assert.equal(playbook.entry.caseUrlTemplate, conversationUrl('x'), '没有深链：剧本里也必须为空');
  assert.equal(playbook.selectorsAlignedWith, 'lib/platforms/walmart.js');
  assert.equal(playbook.selectorsAligned, true, '剧本与代码必须逐字对齐（含已校准的选择器）');
});

test('剧本里的发送步骤永久锁死：selector 为空、verified=false、never=true', () => {
  const playbook = JSON.parse(fs.readFileSync(playbookPath, 'utf8'));
  assert.equal(playbook.submit.selector, '');
  assert.equal(playbook.submit.verified, false);
  assert.equal(playbook.submit.never, true);
  assert.equal(playbook.submit.label, SEND_BUTTON_TEXT, '发送按钮的文案是实测的，记下来但永远不点');
  // 剧本里任何地方都不允许出现非空的发送选择器。
  const flat = JSON.stringify(playbook);
  assert.equal(/发送回复\s*"/.test(flat.replace(/"label":\s*"发送回复"/, '')), false, '别处不许再出现发送按钮选择器');
});

test('剧本与代码：站点入口、登录特征、模板下拉这三条实测事实都要能对上', () => {
  const playbook = JSON.parse(fs.readFileSync(playbookPath, 'utf8'));
  assert.equal(playbook.entry.url, INBOX_URL);
  assert.equal(playbook.entry.signedInTitle, 'Inbox | Walmart Seller Center');
  // 登录特征：实测的 SSO 域名与代码里的正则必须互相认。
  assert.equal(SIGNIN_URL_RE.test(WALMART_LOGIN_URL), true);
  assert.equal(playbook.entry.loginUrlPattern.includes('login.account.wal-mart.com'), true);
  assert.equal(playbook.submit.label, TEMPLATE_PICKER_TEXT.length ? SEND_BUTTON_TEXT : '');
  assert.ok(playbook.calibration.verified.some((line) => line.includes(TEMPLATE_PICKER_TEXT)), '模板下拉也是实测到的');
});

/* ── 页面脚本本身：能跑、且失败时如实报（脚本是拼出来的，最容易在这里出转义错） ── */

/** 造一个极简元素替身：页面脚本只用到 innerText / className / getAttribute / querySelector(All)。 */
function fakeEl(text, cls = '', attrs = {}) {
  return {
    innerText: text,
    className: cls,
    tagName: 'DIV',
    getAttribute: (key) => (key in attrs ? attrs[key] : null),
    querySelector: () => null,
    querySelectorAll: () => [],
    scrollIntoView: () => {},
    click: () => {},
  };
}

/** 在一个只有假 DOM 的沙箱里执行页面脚本，返回它 JSON.parse 之后的结果。 */
function runPageScript(script, document) {
  const location = { href: INBOX_URL };
  const window = { getComputedStyle: () => ({ marginLeft: '0px', alignSelf: 'auto', textAlign: 'left' }) };
  return JSON.parse(new Function('document', 'location', 'window', 'return ' + script)(document, location, window));
}

test('LIST_SCRIPT：真实 DOM 结构下能抠出买家、日期与订单号', () => {
  const rows = [
    fakeEl('Salena Fuller\nInitiate a return, 200015455387691\n今天', 'message p-16'),
    fakeEl('Ayon Ghosh\nPlease contact the customer - Damaged/Missing Parts/Not Received\n今天', 'message p-16'),
  ];
  const document = {
    title: 'Inbox | Walmart Seller Center',
    body: { innerText: 'x' },
    querySelector: () => null,
    querySelectorAll: (selector) => (selector === '.message.p-16' ? rows : []),
  };
  const payload = runPageScript(LIST_SCRIPT, document);
  assert.equal(payload.ok, true);
  assert.equal(payload.count, 2);
  assert.equal(payload.rowSelector, '.message.p-16', '脚本要报出实际命中的行选择器');
  assert.equal(payload.items[0].buyer, 'Salena Fuller', '未校准时按「首行是买家」解析');
  assert.equal(payload.items[0].orderId, '200015455387691', '行文本里的 15 位订单号要抠出来');
  assert.equal(payload.items[0].date, '今天');
  assert.equal(payload.items[0].subject, 'Initiate a return, 200015455387691');
});

test('LIST_SCRIPT / THREAD_SCRIPT：页面上什么都没有时如实返回 reason 与试过的选择器', () => {
  const empty = { title: 'x', body: { innerText: '' }, querySelector: () => null, querySelectorAll: () => [] };
  const list = runPageScript(LIST_SCRIPT, empty);
  assert.equal(list.ok, false);
  assert.equal(list.reason, 'no-rows');
  assert.deepEqual(list.tried.row, ROW_SELECTORS, '失败时要把试过的行选择器原样带出来');

  const thread = runPageScript(THREAD_SCRIPT, empty);
  assert.equal(thread.ok, false);
  assert.equal(thread.reason, 'no-thread-pane', '连会话栏都没有：如实说是「栏没找到」，而不是「没有消息」');
  assert.deepEqual(thread.tried.thread, THREAD_SELECTORS);
});

test('THREAD_SCRIPT：按实测结构解出买卖双方、方向（投递状态）、时间与订单号', () => {
  // 这份 fixture 就是 2026-10-10 实机那两条消息的缩影（结构逐字照搬）：
  //   买家消息的 meta 行只有「发送者 + 时间」；我方消息多一个投递状态节点「Delivered」。
  const node = (opts = {}) => ({
    innerText: opts.text ?? '',
    className: opts.cls ?? '',
    tagName: 'DIV',
    firstElementChild: opts.first ?? null,
    lastElementChild: opts.last ?? null,
    getAttribute: () => null,
    querySelector: (sel) => (opts.select && sel in opts.select ? opts.select[sel] : null),
    querySelectorAll: (sel) => (opts.selectAll && opts.selectAll[sel]) || [],
    scrollIntoView: () => {},
    click: () => {},
  });
  const time = (text) => node({ text, cls: 'text-12 text-gray-100' });

  const buyerTime = time('10/10/2026 09:18 AM');
  const buyerMeta = node({
    text: 'Natalyn Wright 10/10/2026 09:18 AM',
    cls: 'mb-8 flex justify-between items-center',
    select: { span: node({ text: 'Natalyn Wright' }), 'div.flex.items-center.gap-16': node({ last: buyerTime }) },
  });
  const buyerBody = node({ text: 'I paid extra to have them build it.', cls: 'whitespace-pre-wrap' });
  const buyerMsg = node({
    text: 'Natalyn Wright 10/10/2026 09:18 AM I paid extra to have them build it.',
    cls: 'my-16',
    first: buyerMeta,
    select: { 'div.mb-8': buyerMeta, 'div.whitespace-pre-wrap': buyerBody },
  });

  const sellerTime = time('10/10/2026 01:38 PM');
  const sellerMeta = node({
    text: 'Yanosaku Furniture Delivered 10/10/2026 01:38 PM',
    cls: 'mb-8 flex justify-between items-center',
    select: {
      span: node({ text: 'Yanosaku Furniture' }),
      'div.flex.items-center.gap-16': node({ last: sellerTime }),
      'div.flex.gap-8.items-center': node({ text: 'Delivered' }),
    },
  });
  const sellerBody = node({ text: 'Hello, once the product arrives...', cls: 'whitespace-pre-wrap' });
  const sellerMsg = node({
    text: 'Yanosaku Furniture Delivered 10/10/2026 01:38 PM Hello...',
    cls: 'my-16',
    first: sellerMeta,
    select: { 'div.mb-8': sellerMeta, 'div.whitespace-pre-wrap': sellerBody },
  });

  const header = node({ text: '订单号: 200015297529278 Message from Walmart.com Customer: Ask a question, 200015297529278', cls: 'p-24 pb-0' });
  const pane = node({
    cls: 'relative h-full flex flex-col justify-between w-full',
    select: {
      'div.overflow-auto.flex-1.p-24.py-0': node({ cls: 'overflow-auto flex-1 p-24 py-0' }),
      'div.p-24.pb-0': header,
    },
    selectAll: { [MESSAGE_SELECTORS[0]]: [buyerMsg, sellerMsg] },
  });
  const document = {
    title: 'Inbox | Walmart Seller Center',
    body: { innerText: 'x' },
    querySelector: (sel) => (sel === THREAD_SELECTORS[0] ? pane : null),
    querySelectorAll: () => [],
  };

  const payload = runPageScript(THREAD_SCRIPT, document);
  assert.equal(payload.ok, true);
  assert.equal(payload.messageSelector, MESSAGE_SELECTORS[0]);
  assert.equal(payload.buyer, 'Natalyn Wright', '买家 = 第一条来信的发送者');
  assert.equal(payload.orderId, '200015297529278', '订单号从会话头部解出来');
  assert.match(payload.subject, /Ask a question/);
  assert.equal(payload.messageCount, 2);

  const [inMsg, outMsg] = payload.messages;
  assert.equal(inMsg.dir, 'in', '没有投递状态 = 买家发的');
  assert.equal(inMsg.dirGuess, true, '「不是我方」是推断，要如实标出来');
  assert.equal(inMsg.dirSource, 'fallback');
  assert.equal(inMsg.sender, 'Natalyn Wright');
  assert.equal(inMsg.date, '10/10/2026 09:18 AM');
  assert.match(inMsg.body, /paid extra/);

  assert.equal(outMsg.dir, 'out', '带投递状态 = 我方发的');
  assert.equal(outMsg.dirGuess, false);
  assert.equal(outMsg.dirSource, 'delivery-status-text');
  assert.equal(outMsg.date, '10/10/2026 01:38 PM', '时间取右侧容器最后一个子元素，不能把「Delivered」当时间');
  assert.equal(payload.lastInbound.body, inMsg.body);
});

test('clickScript / clickScriptByIndex：没有元素时返回 missing / no-rows，不抛异常', () => {
  const empty = { title: 'x', body: { innerText: '' }, querySelector: () => null, querySelectorAll: () => [] };
  assert.equal(runPageScript(clickScript(ROW_SELECTORS), empty).reason, 'missing');
  assert.equal(runPageScript(clickScriptByIndex(ROW_SELECTORS, 3), empty).reason, 'no-rows');
});

/* ── 自动登录：只点「登录 / 继续」，绝不代填账号密码、不碰验证码 ─────────────── */

/** 自动登录场景用的紫鸟替身：按顺序返回地址读数与脚本 payload。 */
function autoLoginZiniao(opts = {}) {
  const calls = [];
  const urls = opts.urls ?? [];
  const payloads = opts.payloads ?? [];
  let urlIndex = 0;
  let stepIndex = 0;
  const isStepScript = (script) => script.includes('no-target-button');
  return {
    calls,
    async callOrThrow(args) {
      calls.push(args);
      if (args[0] === 'store' && args[1] === 'open') return { ok: true };
      throw new Error('未预期的调用：' + args.join(' '));
    },
    async call(args) {
      calls.push(args);
      if (args[0] === 'page' && args[1] === 'exec') {
        const script = scriptOf(args);
        if (script === 'location.href') {
          const url = urls[Math.min(urlIndex, urls.length - 1)] ?? '';
          urlIndex += 1;
          return { ok: true, data: { result: url } };
        }
        if (isStepScript(script)) {
          const payload = payloads[Math.min(stepIndex, payloads.length - 1)] ?? { ok: false, reason: 'no-target-button' };
          stepIndex += 1;
          return { ok: true, data: { data: { result: JSON.stringify(payload) } } };
        }
      }
      return { ok: true, data: null };
    },
  };
}

const noSleep = async () => {};

test('自动登录：已经在登录态时什么都不做（不点、不开店铺）', async () => {
  const ziniao = autoLoginZiniao({});
  const adapter = createWalmartAdapter({ ziniao });
  const result = await adapter.autoLogin(WALMART_STORES[0], { url: INBOX_URL, sleep: noSleep });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 0);
  assert.deepEqual(ziniao.calls, [], '已经在卖家中心：一次调用都不该发');
});

test('自动登录：登录表单 → 点「登录」→ 地址离开登录页就算成功', async () => {
  const ziniao = autoLoginZiniao({
    urls: [INBOX_URL],
    payloads: [{ ok: true, kind: 'form', clicked: '登录', codeFilled: false }],
  });
  const adapter = createWalmartAdapter({ ziniao });
  const result = await adapter.autoLogin(WALMART_STORES[0], { url: WALMART_LOGIN_URL, sleep: noSleep });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 1);
  assert.equal(result.steps[0].kind, 'form');
  assert.equal(result.steps[0].clicked, '登录');
  // 只允许 page exec（脚本内点击），不允许 page input / page click。
  const kinds = ziniao.calls.map((args) => args[0] + ' ' + args[1]);
  assert.deepEqual([...new Set(kinds)].sort(), ['page exec', 'store open'], '自动登录链路只允许 page exec');
});

test('自动登录：2 步验证页在验证码为空时只等待，填好后点「继续」', async () => {
  const ziniao = autoLoginZiniao({
    urls: [WALMART_LOGIN_URL, INBOX_URL],
    payloads: [
      { ok: false, kind: 'twofa', reason: 'code-empty', codeFilled: false },
      { ok: true, kind: 'twofa', clicked: '继续', codeFilled: true },
    ],
  });
  const adapter = createWalmartAdapter({ ziniao });
  const result = await adapter.autoLogin(WALMART_STORES[0], { url: WALMART_LOGIN_URL, sleep: noSleep });

  assert.equal(result.ok, true);
  assert.equal(result.attempts, 2, '空码那次只等待、不点击，所以要多一轮');
  assert.equal(result.steps[0].reason, 'code-empty');
  assert.equal(result.steps[1].clicked, '继续');
});

test('自动登录：一直停在登录页就如实失败，并把「卡在哪一步」说清楚', async () => {
  const ziniao = autoLoginZiniao({
    urls: [WALMART_LOGIN_URL],
    payloads: [{ ok: false, kind: 'twofa', reason: 'code-empty', codeFilled: false }],
  });
  const adapter = createWalmartAdapter({ ziniao });
  const result = await adapter.autoLogin(WALMART_STORES[0], { url: WALMART_LOGIN_URL, sleep: noSleep, attempts: 3 });

  assert.equal(result.ok, false);
  assert.equal(result.attempts, 3);
  assert.match(result.hint, /2 步验证/, '要说清是动态验证码没被自动填入');
  assert.match(result.hint, /人工/, '要给出下一步：人工来一次');
});

test('自动登录的安全边界：脚本只点按钮，代码里没有 page input / page click', () => {
  const src = fs.readFileSync(adapterPath, 'utf8');
  const script = autoLoginStepScript();

  // 1) 脚本里唯一的动作是 click，且**不给任何输入框赋值**（不代填账号密码/验证码）。
  assert.match(script, /target\.click\(\)/);
  assert.equal(/\.value\s*=/.test(script), false, '不许给任何输入框赋值');
  assert.equal(/dispatchEvent|execCommand|setRangeText|insertText/.test(script), false, '不许绕过输入框事件');
  // 2) 允许点击的按钮文案是白名单，且只认精确匹配。
  assert.deepEqual(AUTO_LOGIN_LABELS.form, ['登录', 'Sign in', 'Log in']);
  assert.deepEqual(AUTO_LOGIN_LABELS.twofa, ['继续', 'Continue', 'Verify']);
  assert.match(script, /wants\.includes\(clean\(/);

  // 3) 自动登录函数体里不许出现 page input / page click（只允许 page exec 跑上面那个脚本）。
  const start = src.indexOf('async function autoLogin(');
  const end = src.indexOf('\n  return {', start);
  const fn = src.slice(start, end);
  assert.ok(start > 0 && end > start, '要能定位到 autoLogin 函数体');
  assert.equal(fn.includes("'input'"), false, '自动登录不许调 page input');
  assert.equal(fn.includes("'click'"), false, '自动登录不许调 page click');
  assert.match(fn, /autoLoginStepScript\(\)/);
});

test('autoLoginStepScript：按钮文案在点击前读取（点完 React 重渲染也不会变成空串）', () => {
  const makeBtn = (text) => {
    const btn = {
      innerText: text,
      value: '',
      getBoundingClientRect: () => ({ width: 100, height: 32 }),
      click() {
        // 模拟 React：点完把按钮重新渲染成空文本
        btn.innerText = '';
      },
    };
    return btn;
  };
  const login = makeBtn('登录');
  const document = {
    title: 'x',
    body: { innerText: '欢迎！电子邮件或用户 ID 密码 忘记密码？ 登录 没有账户？注册' },
    querySelectorAll: (selector) => (selector.includes('button') ? [login] : []),
  };
  const location = { href: 'https://login.account.wal-mart.com/authorize' };
  const window = {};
  const payload = JSON.parse(
    new Function('document', 'location', 'window', 'return ' + autoLoginStepScript())(document, location, window),
  );
  assert.equal(payload.ok, true);
  assert.equal(payload.kind, 'form');
  assert.equal(payload.clicked, '登录', '要报出点击前的文案，而不是点完的空串');
});

test('autoLoginStepScript：2 步验证页验证码为空时只报 code-empty，不点「继续」', () => {
  let clicked = false;
  const cont = {
    innerText: '继续',
    value: '',
    getBoundingClientRect: () => ({ width: 100, height: 32 }),
    click() {
      clicked = true;
    },
  };
  const codeInput = { name: 'code', id: 'otp', type: 'text', value: '', getAttribute: () => null, autocomplete: 'one-time-code' };
  const document = {
    title: 'x',
    body: { innerText: '2 步验证 请输入动态验证应用程序中的验证码 验证码 继续' },
    querySelectorAll: (selector) => (selector === 'input' ? [codeInput] : [cont]),
  };
  const payload = JSON.parse(
    new Function('document', 'location', 'window', 'return ' + autoLoginStepScript())(
      document,
      { href: 'https://login.account.wal-mart.com/authorize' },
      {},
    ),
  );
  assert.equal(payload.ok, false);
  assert.equal(payload.reason, 'code-empty');
  assert.equal(payload.kind, 'twofa');
  assert.equal(clicked, false, '验证码还空着就点「继续」等于提交空码，绝对不许');
});
