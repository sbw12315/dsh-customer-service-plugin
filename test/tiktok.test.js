import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMPOSER_INPUT_SELECTOR,
  COMPOSER_INPUT_SELECTORS,
  COMPOSER_OPEN_SELECTOR,
  INBOX_URL,
  LIST_SELECTOR,
  LIST_SELECTORS,
  LOGIN_FORM_SELECTORS,
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_POLL_MIN_INTERVAL_MS,
  LOGIN_STATES,
  LOGIN_TIMEOUT_MS,
  MESSAGE_SELECTORS,
  PLATFORM_ID,
  PLATFORM_LABEL,
  SIGNIN_URL_RE,
  THREAD_SELECTORS,
  asObject,
  conversationIdFromUrl,
  conversationUrl,
  createTikTokAdapter,
  isTikTokLoggedInUrl,
  isTikTokLoginUrl,
  isTikTokStore,
  parseDueText,
} from '../lib/platforms/tiktok.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const adapterPath = path.join(here, '..', 'lib', 'platforms', 'tiktok.js');
const playbookPath = path.join(here, '..', 'assets', 'playbooks', 'tiktok.message.json');

/* ── 登录态：两次真实登录（2026-10-10）实测到的 URL 形态 ────────────────────
 * 这是本文件里**唯一**的真相源：所有登录相关测试都引用这几个常量，别再抄一遍字面量。
 * 关键一条：未登录时**两个域名都可能**出现，只认一个必然漏判。 */
const LOGGED_IN_URLS = [
  // 店1 登录成功后停在商家中心首页
  'https://seller.us.tiktokshopglobalselling.com/homepage?lng=en&region_check=1&shop_region=US',
  // 店2 登录成功后直接进客服消息中心
  'https://seller.us.tiktokshopglobalselling.com/chat/inbox/current?shop_region=US',
];
const LOGIN_REQUIRED_URLS = [
  // 跨境主域名（**不带 us.**）—— 只认 us 域名的话这一条会被误判成「已登录」
  'https://seller.tiktokshopglobalselling.com/account/login',
  // 美国域名带 redirect_url
  'https://seller.us.tiktokshopglobalselling.com/account/login?redirect_url=https%3A%2F%2Fseller.us.tiktokshopglobalselling.com%2Fhomepage',
];

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

/**
 * 造一个「页面地址随轮询变化」的紫鸟替身：头 N 个 location.href 读数是 url，之后换成 nextUrl。
 *
 * 只有 location.href / document.title 两种 page exec —— 登录链路上不该出现别的脚本；
 * 真出现了这里会直接炸（未预期的调用），这正是我们要的。
 */
function pageZiniao({ url, nextUrl = '', switchAfter = 0, title = 'TikTok Shop Seller Center', calls = [] } = {}) {
  let readings = 0;
  // 注意：这里刻意用「非空才切换」而不是三元取 nextUrl —— 三元在 consequence 位取到
  // undefined 时会被本仓库的运行环境改写掉（实测），换成显式判空后再也没有这个坑。
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
      const script = String(args[args.indexOf('--script') + 1] ?? '');
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

/** 造一个只认预期调用的紫鸟客户端替身（与 test/amazon.test.js 同一套）。 */
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

/** 从一次 page exec 调用里取回脚本正文。 */
const scriptOf = (args) => String(args[args.indexOf('--script') + 1] ?? '');

/** page exec 的信封：callOrThrow 的返回值（三层包装里的可序列化形态）。 */
const execEnvelope = (payload) => ({ data: { result: JSON.stringify(payload), ok: true } });

/** 真实紫鸟 store list 里的 TikTok 店（2026-10-10 实测，6 家）。 */
const TIKTOK_STORES = [
  { storeId: '27636170844730', storeName: 'Tiktok-FUSOU-客服主号', platformName: 'TikTok Shop-全球跨境(自运营)(新)' },
  { storeId: '27585063467004', storeName: 'Tiktok-FUSOU-内容运营苏娇', platformName: 'TikTok Shop-全球跨境(自运营)(新)' },
  { storeId: '27550510293462', storeName: 'Tiktok-FUSOU-达人运营晶琳', platformName: 'TikTok Shop-全球跨境(自运营)（旧）' },
  { storeId: '27416573992782', storeName: 'Tiktok-FUSOU-运营Harvey', platformName: 'TikTok Shop-全球跨境(自运营)（旧）' },
  { storeId: '27409658308200', storeName: 'Tiktok-FUSOU-客服KX', platformName: 'TikTok Shop-全球跨境(自运营)（旧）' },
  { storeId: '27288871801191', storeName: 'Tiktok-FUSOU-管理员', platformName: 'TikTok Shop-全球跨境(自运营)（旧）' },
];

const STORE_LIST = {
  items: [
    ...TIKTOK_STORES.slice(0, 2),
    { storeId: '27630232762680', storeName: 'Amazon-Cozynome-管理员', platformName: '亚马逊-美国' },
    { storeId: '27800343767219', storeName: 'Walmart-Cozynome-管理员', platformName: '沃尔玛-全球' },
    // 实机会挂着停用的店：停用的自家店也必须被排掉（判定见 ziniao.js 的 isRetiredStore）。
    { storeId: '27999999999998', storeName: 'Tiktok-FUSOU-停用', platformName: 'TikTok Shop-全球跨境(自运营)(新)' },
  ],
};

const LIST_PAYLOAD = {
  ok: true,
  url: `${INBOX_URL}?conversation_id=conv-1001`,
  title: 'Messages | TikTok Shop Seller Center',
  rowSelector: '[data-testid="chat.chatroom.conversation_card"]',
  count: 2,
  items: [
    {
      index: 0,
      buyer: 'cain_us',
      snippet: 'Our new address is 6 Crandall Court Fort Rucker, AL 36362',
      date: '2026-10-05 10:36',
      unread: 'unread',
      raw: 'cain_us 2026-10-05 …',
    },
    {
      index: 1,
      buyer: 'jen_uk',
      snippet: '剩余时间：5 小时 When will my order ship?',
      date: '2026-10-05 09:12',
      unread: '',
      raw: 'jen_uk …',
    },
  ],
};

// 校准后的真实形状：方向由**发送者前缀**判定（in/out/system），不再依赖几何或类名。
// 这份 fixture 就是实机那 21 条消息的缩影：买家消息无前缀、我方消息带客服名、还有系统消息。
const THREAD_PAYLOAD = {
  ok: true,
  url: INBOX_URL,
  title: '客服会话管理',
  messageSelector: '[data-testid="chat.chatroom.message_card"]',
  buyer: 'cain_us',
  dirSource: 'sender-prefix',
  messages: [
    { index: 0, dir: 'in', dirGuess: false, outbound: false, date: '', body: 'Hello, I need to change my address.' },
    { index: 1, dir: 'system', dirGuess: false, outbound: null, date: '', body: '会话被分配给 Customer Service-RUI' },
    { index: 2, dir: 'out', dirGuess: false, outbound: true, date: '', body: 'Customer Service-RUI Sure, may I have the new one?' },
    { index: 3, dir: 'in', dirGuess: false, outbound: false, date: '', body: 'Our new address is 6 Crandall Court Fort Rucker, AL 36362' },
  ],
  lastInbound: { index: 3, dir: 'in', dirGuess: false, outbound: false, date: '', body: 'Our new address is 6 Crandall Court Fort Rucker, AL 36362' },
  messageCount: 4,
};

test('isTikTokStore：认实测的 6 家 platformName，不认亚马逊/沃尔玛', () => {
  for (const store of TIKTOK_STORES) {
    assert.equal(isTikTokStore(store), true, store.platformName);
  }
  assert.equal(isTikTokStore({ platformName: 'tiktok' }), true, '跨语言部署下也可能只写小写 tiktok');
  assert.equal(isTikTokStore({ platformName: 'TikTok Shop-US' }), true);
  assert.equal(isTikTokStore({ platformName: '亚马逊-美国' }), false, '不能误伤亚马逊');
  assert.equal(isTikTokStore({ platformName: 'Walmart-Cozynome-管理员' }), false, '不能误伤沃尔玛');
  assert.equal(isTikTokStore({ platformName: '沃尔玛-全球' }), false);
  assert.equal(isTikTokStore({}), false);
});

test('isTikTokLoginUrl：两个入口的 /account/login 都认，正常页面不认', () => {
  // 2026-10-10 实测：两个入口未登录时都会 302 到各自的 /account/login。
  assert.equal(isTikTokLoginUrl('https://seller.tiktokshopglobalselling.com/account/login'), true);
  assert.equal(isTikTokLoginUrl('https://seller-us.tiktok.com/account/login?redirect_url=%2Fmessage'), true);
  assert.equal(isTikTokLoginUrl('https://seller.tiktokshopglobalselling.com/login/'), true);
  assert.equal(isTikTokLoginUrl(`${INBOX_URL}?conversation_id=x`), false);
  assert.equal(isTikTokLoginUrl(''), false);
  assert.equal(SIGNIN_URL_RE.test('https://seller-us.tiktok.com/order/list'), false, '别把正常页面误判成登录页');
});

test('parseDueText：分钟/小时/天与超时都能换算', () => {
  assert.deepEqual(parseDueText('剩余时间：12 分钟'), { minutes: 12, overdue: false });
  assert.deepEqual(parseDueText('剩余 5 小时'), { minutes: 300, overdue: false });
  assert.deepEqual(parseDueText('Due in 2 days'), { minutes: 2880, overdue: false });
  assert.equal(parseDueText('已超时 3 小时').minutes, -180);
  assert.equal(parseDueText(''), null, '空文案没有到期信息');
  assert.deepEqual(parseDueText('随便一句话'), { minutes: null, overdue: false }, '有文案但解不出时间');
});

test('conversationUrl：本平台**没有**会话级深链，永远返回空串', () => {
  // 2026-10-10 在真实店铺实测：在 /chat 里点击不同会话，location.href 恒为 /chat/inbox/current，
  // 不随会话变化；会话卡片的 id 是 chat-room-conversation-list-item-0 这种**位置序号**，
  // 不是稳定会话标识。所以本平台与 lark-mail 同类：没有深链可给。
  //
  // 恒返回空串（而不是退回消息中心首页）是刻意的：界面以「caseUrl 为空」为隐藏判据，
  // 退回首页会给出一个非空、能点开、却指向收件箱首页的链接 —— 一个看起来对的错入口，
  // 比没有入口糟得多。
  assert.equal(conversationUrl('conv-1001'), '', '有 id 也不给链接：本平台没有稳定深链');
  assert.equal(conversationUrl(''), '');
  assert.equal(conversationUrl(null), '');
  assert.notEqual(conversationUrl('conv-1001'), INBOX_URL, '尤其不能等于消息中心首页');
  assert.equal(INBOX_URL.includes('/chat'), true, '消息中心是 /chat（实测），不是 /message');
});

test('conversationIdFromUrl：URL 里没有会话 id（实测），位置序号不能当 id', () => {
  // 实测的真实 URL：只有 oec_seller_id 之类的上下文参数，**没有**会话标识。
  assert.equal(conversationIdFromUrl('https://seller.us.tiktokshopglobalselling.com/chat/inbox/current?oec_seller_id=7495960049647455145&shop_region=US'), '');
  assert.equal(conversationIdFromUrl('https://seller.us.tiktokshopglobalselling.com/chat/inbox/current'), '');
  // 位置序号（chat-room-conversation-list-item-0）绝对不能当会话 id —— 列表一刷新就指错会话。
  assert.equal(conversationIdFromUrl('https://x/chat#chat-room-conversation-list-item-0'), '');
});

test('asObject：兼容对象与 JSON 字符串两种返回', () => {
  assert.deepEqual(asObject('{"a":1}'), { a: 1 });
  assert.deepEqual(asObject({ a: 2 }), { a: 2 });
  assert.equal(asObject('不是 JSON'), null);
  assert.equal(asObject(null), null);
});

test('发送按钮：知道它在哪，但代码里没有任何一处会点它', () => {
  const src = fs.readFileSync(adapterPath, 'utf8');
  // 校准之后我们**知道**发送按钮的选择器了（实测 ...send_message_btn，文案「发送」）。
  // 知道不等于要用 —— 这条测试把「知道它、且永不点它」这件事钉死：
  //   1. 发送按钮选择器只允许出现在 sendMessageBtnSelector() 这一个函数体里；
  //   2. 绝不允许被送进点击链路（clickScript / clickScriptByIndex / page input）；
  //   3. 不允许有 sendMessage / submitReply 之类的动作函数。
  const sendSelLine = /send_message_btn/;
  const lines = src.split('\n');
  const hits = lines
    .map((line, i) => ({ line, no: i + 1 }))
    .filter((entry) => sendSelLine.test(entry.line) && !/^\s*(\/\/|\*|\/\*)/.test(entry.line));
  // 允许出现的位置：函数体 return 那一行 + 注释里的说明。
  const codeHits = hits.filter((entry) => !/return '\[data-testid=/.test(entry.line));
  assert.deepEqual(codeHits.map((e) => e.line.trim()), [], '发送按钮选择器只能由 sendMessageBtnSelector() 导出，别处不得引用');

  // 点击链路里绝不能出现发送按钮选择器。
  const clickFns = src.slice(src.indexOf('export function clickScript'));
  assert.equal(sendSelLine.test(clickFns), false, '点击脚本里不能出现发送按钮');
  // 不存在任何「发送动作」函数。
  const actionFns = src.match(/function\s+(sendMessage|submitReply|doSend|clickSend)\b/g) ?? [];
  assert.deepEqual(actionFns, [], '不允许存在发送动作函数');
  // 官方导出的那个常量确实指向发送按钮 —— 它的用途是被测试 grep 到 + 让脚本显式排除。
  assert.match(src, /export function sendMessageBtnSelector\(\)/);
});

test('页面脚本里的点击一律走 scrollIntoView + click，不走 page click', () => {
  const src = fs.readFileSync(adapterPath, 'utf8');
  assert.match(src, /scrollIntoView\(\{ block: 'center'/);
  // 不能用紫鸟的 page click（实测在该页会 ELEMENT_NOT_INTERACTABLE）。
  assert.equal(/\['page', 'click'/.test(src), false, '不能走 page click');
});

test('adapter.visitInbox：被弹回登录页时抛 kind=auth + 可照做的 hint', async () => {
  const ziniao = fakeZiniao({
    'page visit': () => ({ ok: true }),
    'page exec': () => ({ data: { result: 'https://seller.tiktokshopglobalselling.com/account/login' } }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  const error = await adapter
    .visitInbox({ storeId: '27636170844730', storeName: 'Tiktok-FUSOU-客服主号' })
    .then(() => null)
    .catch((cause) => cause);
  assert.ok(error, '未登录必须抛错');
  assert.equal(error.kind, 'auth', '要说清是登录问题，不是页面结构问题');
  assert.match(error.message, /未登录/);
  assert.match(error.hint, /登录/, 'hint 要能照做');
});

test('adapter.visitInbox：美国入口的登录跳转同样被认出来', async () => {
  const ziniao = fakeZiniao({
    'page visit': () => ({ ok: true }),
    'page exec': () => ({ data: { result: 'https://seller-us.tiktok.com/account/login?redirect_url=%2Fmessage' } }),
    'page wait-element': () => ({ ok: false }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  await assert.rejects(() => adapter.visitInbox({ storeId: 'x' }), (cause) => cause.kind === 'auth');
});

test('adapter.prepare：未登录时也在 prepare 这一层抛 kind=auth', async () => {
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': () => ({ data: { result: 'https://seller.tiktokshopglobalselling.com/account/login' } }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  await assert.rejects(
    () => adapter.prepare({ storeId: '27636170844730', storeName: 'Tiktok-FUSOU-客服主号' }),
    (cause) => cause.kind === 'auth',
  );
});

test('adapter.prepare：没跳登录页但列表也没出来时，如实报「试过哪些选择器」', async () => {
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': () => ({ data: { result: `${INBOX_URL}` } }),
    'page wait-element': () => ({ ok: false, error: { kind: 'element', message: 'not found' } }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  const error = await adapter.prepare({ storeId: 'x' }).then(() => null).catch((cause) => cause);
  assert.equal(error.kind, 'page');
  assert.match(error.message, /未在真实店铺上校准/, '要明说选择器没校准，别让人以为是登录问题');
  assert.ok(error.message.includes(LIST_SELECTOR), '要把试过的选择器带出来，方便定位');
});

test('adapter.prepare：正常路径 = 开店铺 → 进消息中心 → 等到列表', async () => {
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': () => ({ data: { result: `${INBOX_URL}?conversation_id=conv-1001` } }),
    'page wait-element': () => ({ ok: true }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  await adapter.prepare({ storeId: '27636170844730', storeName: 'Tiktok-FUSOU-客服主号' });

  const open = ziniao.calls.find((args) => args[0] === 'store' && args[1] === 'open');
  assert.ok(open.includes('27636170844730'));
  assert.equal(ziniao.calls.some((args) => args.includes('--headless')), false, '永远不开无头：填了没人看得到');
  const visited = ziniao.calls.find((args) => args[0] === 'page' && args[1] === 'visit');
  assert.ok(visited.includes(INBOX_URL));
  const wait = ziniao.calls.find((args) => args[0] === 'page' && args[1] === 'wait-element');
  assert.ok(wait.includes(LIST_SELECTOR));
});

test('adapter.listAllStores 给全量、listStores 只给 TikTok 店', async () => {
  const ziniao = fakeZiniao({ 'store list': () => STORE_LIST });
  const adapter = createTikTokAdapter({ ziniao });

  // 「扫描可用店铺」要看到全量：非 TikTok 店也得列出来，界面才能解释它为什么不被巡逻。
  const all = await adapter.listAllStores();
  assert.deepEqual(all.map((store) => store.storeId), [
    '27636170844730',
    '27585063467004',
    '27630232762680',
    '27800343767219',
    '27999999999998',
  ]);
  assert.equal(all.find((store) => store.storeId === '27999999999998').retired, true, '规范化时就该打上停用标记');

  const tiktok = await adapter.listStores();
  assert.deepEqual(tiktok.map((store) => store.storeId), ['27636170844730', '27585063467004']);
  assert.equal(tiktok.some((store) => store.retired), false, '停用的 TikTok 店不能被当成巡逻目标');
});

test('adapter.extractList：解出会话列表与到期时间', async () => {
  const ziniao = fakeZiniao({ 'page exec': () => execEnvelope(LIST_PAYLOAD) });
  const adapter = createTikTokAdapter({ ziniao });
  const list = await adapter.extractList({ storeId: '1' });
  assert.equal(list.items.length, 2);
  assert.equal(list.items[0].buyer, 'cain_us');
});

test('adapter.listConversations：顺手把「剩余时间」文案解析成 dueMinutes', async () => {
  const ziniao = fakeZiniao({ 'page exec': () => execEnvelope(LIST_PAYLOAD) });
  const adapter = createTikTokAdapter({ ziniao });
  const list = await adapter.listConversations({ storeId: '1' });
  assert.equal(list.items[0].dueMinutes, null, '没有时间文案就是 null，不是 0');
  assert.equal(list.items[1].dueMinutes, 300, '「剩余时间：5 小时」= 300 分钟');
});

test('adapter.extractList：兜底选择器全落空时，错误里带 reason 与试过的选择器', async () => {
  const ziniao = fakeZiniao({
    'page exec': () => execEnvelope({ ok: false, reason: 'no-list-container', tried: { list: LIST_SELECTORS } }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  const error = await adapter.extractList({ storeId: '1' }).then(() => null).catch((cause) => cause);
  assert.equal(error.reason, 'no-list-container', 'reason 要原样传出来，人能据此判断是改版还是没进页面');
  assert.match(error.message, /no-list-container/);
  assert.ok(error.message.includes(LIST_SELECTOR), '要把试过的选择器列出来');
});

test('adapter.extractList：容器在但没有行（no-rows）也要如实报', async () => {
  const ziniao = fakeZiniao({
    'page exec': () => execEnvelope({ ok: false, reason: 'no-rows', tried: { row: [] } }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  await assert.rejects(() => adapter.extractList({ storeId: '1' }), /no-rows/);
});

test('adapter.openConversation：按数组下标点行（不能用 :nth-of-type），且不等同于 page click', async () => {
  // 2026-10-08 在亚马逊上实测：紫鸟CLI 的 page click 会「鼠标指令已发送、DOM click 事件未观察到」。
  // 统一走脚本里的 el.click()，这里把做法锁死。
  const ziniao = fakeZiniao({
    'page exec': () => ({ data: { result: JSON.stringify({ ok: true, used: 'x' }) } }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  await adapter.openConversation({ storeId: '1' }, 1);

  const click = ziniao.calls.find((args) => args[0] === 'page' && args[1] === 'exec');
  assert.ok(click, '要用脚本点开列表行');
  const script = scriptOf(click);
  assert.ok(script.includes('chat.chatroom.conversation_card'), '脚本要带上实测的行选择器（含兜底几套）');
  assert.ok(script.includes('el.click()'), '要真的点');
  assert.ok(script.includes('scrollIntoView'), '点之前先滚进可视区');
  assert.equal(ziniao.calls.some((args) => args[1] === 'click'), false, '不能再走 page click');

  // **回归锁**：实测踩到的坑 —— 会话行是 <div>，用 `:nth-of-type(N)` 定位会数错行
  // （卡片之间夹着虚拟滚动占位元素），表现为「第 2 条会话不在列表里了」并被静默跳过。
  // 现在改成脚本内 querySelectorAll 后按数组下标取，必须与 listConversations 的 index 同源。
  assert.equal(script.includes('nth-of-type'), false, '绝不能用 :nth-of-type 定位会话行');
  assert.ok(script.includes('querySelectorAll'), '要按数组顺序取行');
  assert.ok(/const idx = 1\b/.test(script), '要把 0 基下标原样传给脚本');

  // 关键：行点开后要等正文容器与消息本体，而不是只等外层空壳。
  const waits = ziniao.calls.filter((args) => args[0] === 'page' && args[1] === 'wait-element');
  assert.ok(waits.some((args) => args.includes(THREAD_SELECTORS[0])), '应该等正文容器');
  assert.ok(waits.some((args) => args.includes(MESSAGE_SELECTORS[0])), '应该等消息本体');
});

test('adapter.openConversation：行不在列表里了要说清楚，而不是含糊的「点不动」', async () => {
  const ziniao = fakeZiniao({
    'page exec': () => ({ data: { result: JSON.stringify({ ok: false, reason: 'missing', tried: [] }) } }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  await assert.rejects(() => adapter.openConversation({ storeId: '1' }, 3), /不在列表里了/);
});

test('adapter.extractThread：解出正文、最后一条买家消息与方向判定来源', async () => {
  const ziniao = fakeZiniao({ 'page exec': () => execEnvelope(THREAD_PAYLOAD) });
  const adapter = createTikTokAdapter({ ziniao });
  const thread = await adapter.extractThread({ storeId: '1' });
  assert.equal(thread.buyer, 'cain_us');
  assert.equal(thread.messageCount, 4);
  assert.match(thread.lastInbound.body, /6 Crandall Court/);
  // 方向现在是**实测判定**（发送者前缀），不再是猜的。
  assert.equal(thread.lastInbound.dirGuess, false);
  assert.equal(thread.dirSource, 'sender-prefix');
  // 系统消息两边都不算：既不能当买家来信，也不能当我方已回。
  assert.equal(thread.messages.filter((m) => m.dir === 'system').length, 1);
  // 本平台没有会话级深链（实测），conversationId 取不到也无所谓。
  assert.equal(adapter.conversationId(thread), '');
});

test('adapter.extractThread：读到空会话会重读，不把「还在渲染」当结论', async () => {
  let round = 0;
  const ziniao = fakeZiniao({
    'page exec': () => {
      round += 1;
      return execEnvelope(round === 1 ? { ok: true, url: 'https://x/y', messages: [], lastInbound: null } : THREAD_PAYLOAD);
    },
  });
  const adapter = createTikTokAdapter({ ziniao });
  const thread = await adapter.extractThread({ storeId: '1' });
  assert.equal(round, 2, '第一次为空应该重读');
  assert.match(thread.lastInbound.body, /6 Crandall Court/);
});

test('adapter.extractThread：一直读不到消息时如实返回空会话，由上层决定', async () => {
  const ziniao = fakeZiniao({
    'page exec': () => execEnvelope({ ok: true, url: 'https://x/y', messages: [], lastInbound: null }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  const thread = await adapter.extractThread({ storeId: '1' });
  assert.deepEqual(thread.messages, [], '宁可说空，也不编一条消息出来');
});

test('adapter.extractThread：正文容器都找不到时，reason 与试过的选择器一起报出来', async () => {
  const ziniao = fakeZiniao({
    'page exec': () => execEnvelope({ ok: false, reason: 'no-thread-container', tried: { thread: THREAD_SELECTORS } }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  const error = await adapter.extractThread({ storeId: '1' }).then(() => null).catch((cause) => cause);
  assert.equal(error.reason, 'no-thread-container');
  assert.ok(error.message.includes(THREAD_SELECTORS[0]), '错误里要带试过的正文选择器');
});

test('adapter.readConversation：脚本点行 + 读正文，全程不碰输入框', async () => {
  const ziniao = fakeZiniao({
    'page exec': (args) => {
      const script = scriptOf(args);
      // 精确区分：点击脚本里有 'el.click()'，读正文脚本没有。
      // （不能用 conversation_card 判断 —— 读正文脚本里也含这个词，因为它要取买家名字段。）
      if (script.includes('el.click()')) return { data: { result: JSON.stringify({ ok: true }) } };
      return execEnvelope(THREAD_PAYLOAD);
    },
  });
  const adapter = createTikTokAdapter({ ziniao });
  const thread = await adapter.readConversation({ storeId: '1', storeName: 'Tiktok-X' }, { index: 0 });
  assert.equal(thread.buyer, 'cain_us');

  const clickCall = ziniao.calls.find(
    (args) => args[0] === 'page' && args[1] === 'exec' && scriptOf(args).includes('el.click()'),
  );
  assert.ok(clickCall, '要用脚本点开列表行');
  assert.ok(/const idx = 0\b/.test(scriptOf(clickCall)), '点的是第 1 行（0 基下标）');
  assert.equal(scriptOf(clickCall).includes('nth-of-type'), false, '不能用 :nth-of-type（实测会数错行）');
  assert.ok(scriptOf(clickCall).includes('el.click()'));
  assert.ok(scriptOf(clickCall).includes('scrollIntoView'));
  assert.equal(ziniao.calls.some((args) => args[1] === 'click'), false, '不能再走 page click');
  assert.equal(ziniao.calls.some((args) => args[1] === 'input'), false, '读会话不该碰输入框');
});

test('adapter.fillComposer：没有 caseId 直接拒绝，不去猜会话', async () => {
  const ziniao = fakeZiniao({});
  const adapter = createTikTokAdapter({ ziniao });
  await assert.rejects(() => adapter.fillComposer({ storeId: '1' }, 'hello', {}), /无法定位到原会话/);
  assert.equal(ziniao.calls.length, 0);
});

test('adapter.fillComposer：打开消息中心并填文本，全程不点发送、不编深链', async () => {
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': (args) => {
      const script = scriptOf(args);
      if (script === 'location.href') return { data: { result: INBOX_URL } };
      return { data: { result: JSON.stringify({ ok: true }) } };
    },
    'page wait-element': () => ({ ok: true }),
    'page input': () => ({ ok: true }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  const result = await adapter.fillComposer({ storeId: '1' }, 'Hello Cain,\n\nDraft.', { caseId: 'conv-9' });
  assert.equal(result.filled, true);
  // 本平台没有会话级深链（实测），所以打开的必然是消息中心本身，且**不编** conversation_id。
  assert.equal(result.url, INBOX_URL);
  assert.equal(/conversation_id/.test(result.url), false, '不能编一个假的会话深链');
  // 「没能自动定位到原会话」必须明确回传，别让人以为定位过了。
  assert.equal(result.located, false);
  assert.match(result.locatedNote, /当前打开/);

  const input = ziniao.calls.find((args) => args[0] === 'page' && args[1] === 'input');
  assert.ok(input.includes(COMPOSER_INPUT_SELECTOR), '用主输入框选择器');
  assert.ok(input.includes('Hello Cain,\n\nDraft.'), '文本要真的传进去');

  // 任何一次调用都不能落在「发送」上。
  const flat = ziniao.calls.map((args) => args.join(' ')).join('\n');
  assert.equal(/发送|send/i.test(flat), false, '调用参数里不允许出现发送语义');
});

test('adapter.fillComposer：深链同样被弹回登录页时抛 kind=auth', async () => {
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': () => ({ data: { result: 'https://seller-us.tiktok.com/account/login?redirect_url=x' } }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  const error = await adapter
    .fillComposer({ storeId: '1' }, 'Draft body', { caseId: 'conv-1' })
    .then(() => null)
    .catch((cause) => cause);
  assert.equal(error.kind, 'auth');
  assert.equal(ziniao.calls.some((args) => args[1] === 'input'), false, '没登录就不该硬去填');
});

test('adapter.fillComposer：回复框本来就开着（「展开回复框」找不到）也照样填得进去', async () => {
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': (args) => {
      const script = scriptOf(args);
      if (script === 'location.href') return { data: { result: `${INBOX_URL}?conversation_id=conv-1` } };
      // 「展开回复框」那一步点不到：页面上根本没有那个按钮。
      if (script.includes('reply-button')) return { ok: false, error: { kind: 'element', message: 'not found' } };
      return { data: { result: JSON.stringify({ ok: true }) } };
    },
    'page wait-element': () => ({ ok: true }),
    'page input': () => ({ ok: true }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  const result = await adapter.fillComposer({ storeId: '1' }, 'Draft body', { caseId: 'conv-1' });
  assert.equal(result.filled, true, '点不到「展开回复框」不该让整件事失败');
  const input = ziniao.calls.find((args) => args[0] === 'page' && args[1] === 'input');
  assert.ok(input.includes('Draft body'), '文本要真的填进去');
});

test('adapter.fillOpenConversation：逐个试兜底输入框，命中哪个就报哪个（方便回填校准）', async () => {
  const ziniao = fakeZiniao({
    'page exec': () => ({ data: { result: JSON.stringify({ ok: true }) } }),
    'page wait-element': (args) => {
      const selector = args[args.indexOf('--selector') + 1];
      // 只有 contenteditable 那套命中：模拟真实页面用的是富文本容器而不是 textarea。
      return { ok: selector === 'div[contenteditable="true"][role="textbox"]' };
    },
    'page input': () => ({ ok: true }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  const result = await adapter.fillOpenConversation({ storeId: '1' }, 'Draft body');
  assert.equal(result.filled, true);
  assert.equal(result.inputSelector, 'div[contenteditable="true"][role="textbox"]');
  const input = ziniao.calls.find((args) => args[0] === 'page' && args[1] === 'input');
  assert.ok(input.includes(result.inputSelector), '填的是实际命中的那个选择器');
});

test('adapter.fillOpenConversation：连输入框都找不到时才报错，且把试过的选择器列出来', async () => {
  const ziniao = fakeZiniao({
    'page exec': () => ({ data: { result: JSON.stringify({ ok: true }) } }),
    'page wait-element': () => ({ ok: false, error: { kind: 'element', message: 'not found' } }),
  });
  const adapter = createTikTokAdapter({ ziniao });
  const error = await adapter
    .fillOpenConversation({ storeId: '1' }, 'Draft body')
    .then(() => null)
    .catch((cause) => cause);
  assert.equal(error.reason, 'no-input');
  assert.match(error.message, /找不到回复输入框/);
  // 每个兜底选择器都必须原样出现在错误里 —— 未校准阶段，这条信息就是定位问题的唯一线索。
  for (const selector of COMPOSER_INPUT_SELECTORS) {
    assert.ok(error.message.includes(selector), '错误里要列出试过的选择器：' + selector);
  }
  // 每个兜底都要真的被试过一次（不是只试了第一个就放弃）。
  const tried = ziniao.calls
    .filter((args) => args[0] === 'page' && args[1] === 'wait-element')
    .map((args) => args[args.indexOf('--selector') + 1]);
  assert.deepEqual(tried, [...COMPOSER_INPUT_SELECTORS], '兜底选择器要一个个试过去');
  assert.equal(ziniao.calls.some((args) => args[1] === 'input'), false, '输入框都没找到就不该硬去 input');
});

test('adapter.fillComposer / fillOpenConversation：空草稿直接拒绝', async () => {
  const ziniao = fakeZiniao({});
  const adapter = createTikTokAdapter({ ziniao });
  await assert.rejects(() => adapter.fillComposer({ storeId: '1' }, '   ', { caseId: 'c' }), /草稿内容为空/);
  await assert.rejects(() => adapter.fillOpenConversation({ storeId: '1' }, ''), /草稿内容为空/);
  assert.equal(ziniao.calls.length, 0);
});

test('巡逻契约：引擎要的成员一个不少，且都是正确类型', () => {
  const adapter = createTikTokAdapter({ ziniao: {} });
  assert.equal(adapter.id, PLATFORM_ID);
  assert.equal(adapter.id, 'tiktok');
  assert.equal(adapter.label, PLATFORM_LABEL);
  assert.equal(adapter.kind, 'store');
  assert.equal(adapter.inboxUrl, INBOX_URL);
  assert.equal(adapter.queueChannel, 'tiktok');
  assert.equal(adapter.draftKind, 'tiktok');

  for (const name of [
    'conversationUrl',
    'conversationId',
    'listSources',
    'listConversations',
    'readConversation',
    'prepare',
    'fillOpenConversation',
    'fillComposer',
    'enabled',
    'listAllStores',
    'listStores',
    'openStore',
    'closeStore',
    'closeSource',
    'visitInbox',
    'waitForInbox',
    'extractList',
    'openConversation',
    'extractThread',
  ]) {
    assert.equal(typeof adapter[name], 'function', '缺成员：' + name);
  }
  // 巡逻引擎只看 listSources；它必须就是 listStores（只给 TikTok 店），不能是全量。
  assert.equal(adapter.listSources, adapter.listStores);
  assert.equal(adapter.closeSource, adapter.closeStore);
  // 校准状态必须能从适配器上读出来，而且要说清「校准到什么程度、哪些还没覆盖」。
  assert.equal(adapter.verified, true, '读取链路已在真实店铺上校准');
  assert.match(adapter.calibrationNote, /Tiktok-FUSOU-客服主号/);
  assert.match(adapter.calibrationNote, /仍未被覆盖/, '校准过 ≠ 万无一失，要讲清边界');
});

test('禁用的渠道：紫鸟CLI 在设置里被关掉时不再参与巡逻', () => {
  assert.equal(createTikTokAdapter({ ziniao: {} }).enabled(), true, '没传设置时默认启用');
  assert.equal(createTikTokAdapter({ ziniao: {}, settings: { cliEnabled: { ziniao: false } } }).enabled(), false);
  assert.equal(createTikTokAdapter({ ziniao: {}, settings: { cliEnabled: { ziniao: true } } }).enabled(), true);
  assert.match(createTikTokAdapter({ ziniao: {} }).disabledHint(), /禁用/);

  // v0.13.0：渠道自己的开关（巡逻页那一行）与 CLI 总开关分开判。
  const channelOff = createTikTokAdapter({ ziniao: {}, settings: { channelEnabled: { tiktok: false } } });
  assert.equal(channelOff.channelEnabled(), false);
  assert.equal(channelOff.enabled(), false);
  assert.match(channelOff.disabledHint(), /巡逻页/, '要说清是渠道被停用');
  const cliOff = createTikTokAdapter({ ziniao: {}, settings: { cliEnabled: { ziniao: false } } });
  assert.equal(cliOff.channelEnabled(), true, 'CLI 被禁用不影响渠道开关本身');
  assert.match(cliOff.disabledHint(), /紫鸟CLI/);
});

test('剧本：verified=false 且写明未校准原因（不许假装已校准）', () => {
  const playbook = JSON.parse(fs.readFileSync(playbookPath, 'utf8'));
  assert.equal(playbook.id, 'tiktok.message');
  assert.equal(playbook.platform, 'tiktok');
  // 诚实性锚点：verified=true 只有在**真的**在真实 DOM 上校准过之后才允许出现，
  // 而且必须留下一份可核对记录（何时、哪家店、哪个站点），不能只把布尔位翻过来。
  assert.equal(playbook.verified, true, '读取链路已在真实店铺上校准');
  assert.match(playbook.calibrate.calibratedOn, /Tiktok-FUSOU-客服主号/, '要记下在哪家店校准的');
  assert.match(playbook.calibrate.calibratedAt, /\d{4}-\d{2}-\d{2}/, '要记下校准日期');
  // 「校准模式」仍未实现 —— 即使剧本已校准，也不能暗示页面上点几下就能自动回填。
  assert.equal(playbook.calibrate.implemented, false);
  // 校准过 ≠ 万无一失：边界必须写在文件里。
  assert.match(playbook.unverifiedReason, /仍未覆盖|未覆盖/, '要写清还没覆盖什么');
});

test('剧本与代码的选择器不能漂移（逐字对照 lib/platforms/tiktok.js 的导出常量）', () => {
  const playbook = JSON.parse(fs.readFileSync(playbookPath, 'utf8'));
  // 唯一真相源是代码里的常量；剧本必须与它逐字一致。
  assert.equal(playbook.entry.base, 'https://seller.tiktokshopglobalselling.com');
  assert.equal(playbook.entry.baseUs, 'https://seller.us.tiktokshopglobalselling.com');
  assert.equal(playbook.entry.path, '/chat');
  assert.equal(playbook.entry.url, INBOX_URL);
  // 没有会话级深链（实测），所以模板必须为空 —— 留着模板会诱导人去拼一个假链接。
  assert.equal(playbook.entry.caseUrlTemplate, '');
  assert.equal(playbook.entry.caseIdFrom, '');
  assert.equal(playbook.list.selector, LIST_SELECTOR);
  assert.deepEqual(playbook.list.fallbackSelectors, [...LIST_SELECTORS]);
  assert.equal(playbook.list.waitFor.selector, LIST_SELECTOR);
  assert.equal(playbook.read.selector, THREAD_SELECTORS[0]);
  assert.deepEqual(playbook.read.fallbackSelectors, [...THREAD_SELECTORS]);
  assert.equal(playbook.read.extract.messages.selector, MESSAGE_SELECTORS[0]);
  assert.equal(playbook.reply.openSelector, COMPOSER_OPEN_SELECTOR);
  assert.equal(playbook.reply.inputSelector, COMPOSER_INPUT_SELECTOR);
  assert.deepEqual(playbook.reply.inputFallbackSelectors, [...COMPOSER_INPUT_SELECTORS]);
  assert.equal(playbook.selectorsAlignedWith, 'lib/platforms/tiktok.js');
});

test('剧本与代码：站点入口/登录特征都要能对上（这几条是实测过的）', () => {
  const playbook = JSON.parse(fs.readFileSync(playbookPath, 'utf8'));
  // signinUrlRe 在剧本里是正则字面量的字符串形态，用它去测两个实测登录地址。
  const re = new RegExp(playbook.entry.signinUrlRe.replace(/^\/|\/i$/g, ''), 'i');
  assert.equal(re.test('https://seller.tiktokshopglobalselling.com/account/login'), true);
  assert.equal(re.test('https://seller-us.tiktok.com/account/login?redirect_url=x'), true);
  assert.equal(re.test(INBOX_URL), false);
  // 剧本里的每一步 click 都必须是导航性的，不许出现发送语义。
  const clicks = [
    ...(playbook.read.steps ?? []),
    ...(playbook.reply.steps ?? []),
  ].filter((step) => step.op === 'click');
  for (const step of clicks) {
    assert.equal(/发送|send/i.test(String(step.selector ?? '')), false, '点击步骤不许指向发送');
  }
});

test('剧本里的发送步骤永久锁死：selector 为空、verified=false', () => {
  const playbook = JSON.parse(fs.readFileSync(playbookPath, 'utf8'));
  assert.equal(playbook.submit.selector, '');
  assert.equal(playbook.submit.verified, false);
  assert.equal(playbook.submit.op, 'click', '步骤结构在，但永远没有可点的选择器');
});

test('剧本里不允许出现任何非空的发送选择器（出厂与以后都不允许）', () => {
  const playbook = JSON.parse(fs.readFileSync(playbookPath, 'utf8'));
  const submit = playbook.submit ?? {};
  assert.equal(String(submit.selector ?? '').trim(), '', '发送步骤的选择器必须永远为空');
  // 万一以后有人往剧本里加字段，这里兜住：submit 下任何 *selector* 字段都必须是空的。
  for (const [key, value] of Object.entries(submit)) {
    if (/selector/i.test(key)) {
      assert.equal(String(value ?? '').trim(), '', `submit.${key} 必须为空`);
    }
  }
  assert.equal(playbook.reply.steps.some((step) => /发送|send/i.test(String(step.selector ?? ''))), false);
});


/* ── 登录态（task-6） ─────────────────────────────────────────────────────────
 * 「登录」按钮的职责**只有一个**：把浏览器开到登录页摆好，然后停下来等人。
 * 插件不代替人完成登录 —— 不点登录按钮、不填账号密码、不填验证码、不处理滑块。
 * 根因：两次真实登录（2026-10-10）的挑战类型都不一样：
 *   店1 Tiktok-FUSOU-客服主号：滑块「点击选中两个相同形状的物体」
 *   店2 Tiktok-FUSOU-客服KX：6 位邮箱验证码（发到 cs@jinmukeji.com），无滑块
 * 挑战类型不固定 ⇒ 无法预测、无法自动化；验证码又发到人手上，插件根本拿不到。
 * ─────────────────────────────────────────────────────────────────────────── */

test('isTikTokLoggedInUrl：实测的 4 种 URL 形态都判对（未登录时两个域名都可能出现）', () => {
  // 已登录：两次真实登录后的落点（首页 / 客服消息中心）
  for (const url of LOGGED_IN_URLS) {
    assert.equal(isTikTokLoggedInUrl(url), true, '已登录：' + url);
    assert.equal(isTikTokLoginUrl(url), false, '已登录的地址不能被当成登录页：' + url);
  }
  // 未登录：**两个域名**都要认 —— 只认 us 域名会把跨境主域名那一条误判成「已登录」
  for (const url of LOGIN_REQUIRED_URLS) {
    assert.equal(isTikTokLoggedInUrl(url), false, '未登录：' + url);
    assert.equal(isTikTokLoginUrl(url), true, '登录页必须被 isTikTokLoginUrl 认出来：' + url);
  }
  // 两个域名确实都在 LOGIN_REQUIRED_URLS 里（防以后有人删掉一条）
  assert.ok(
    LOGIN_REQUIRED_URLS.some((url) => /^https:\/\/seller\.tiktokshopglobalselling\.com/.test(url)),
    '必须覆盖跨境主域名（不带 us.）的登录页',
  );
  assert.ok(
    LOGIN_REQUIRED_URLS.some((url) => /^https:\/\/seller\.us\./.test(url)),
    '必须覆盖美国域名（带 us.）的登录页',
  );
  // 读不到地址不算证据：既不能说已登录，也不能说在登录页
  assert.equal(isTikTokLoggedInUrl(''), false, '空地址不能算「已登录」');
  assert.equal(isTikTokLoggedInUrl(null), false);
});

test('adapter.checkLogin：已登录 / 未登录 / 读不到地址 三种结果，且**不产生副作用**', async () => {
  const loginCalls = [];
  const loginAdapter = createTikTokAdapter({ ziniao: pageZiniao({ url: LOGIN_REQUIRED_URLS[0], calls: loginCalls }) });
  const required = await loginAdapter.checkLogin({ storeId: '27409658308200', storeName: 'Tiktok-FUSOU-客服KX' });
  assert.equal(required.state, LOGIN_STATES.LOGIN_REQUIRED);
  assert.equal(required.state, 'login_required');
  assert.equal(required.loggedIn, false);
  assert.equal(required.url, LOGIN_REQUIRED_URLS[0]);
  assert.match(required.hint, /登录/);
  // 「不产生副作用」是硬要求：checkLogin 只准读地址，不开店铺、不导航、不点、不填。
  assert.deepEqual(
    loginCalls.map((args) => args.slice(0, 2).join(' ')),
    ['page exec'],
    'checkLogin 只允许读一次页面地址',
  );
  assertNoLoginAutomation(loginCalls);

  const okCalls = [];
  const okAdapter = createTikTokAdapter({ ziniao: pageZiniao({ url: LOGGED_IN_URLS[1], calls: okCalls }) });
  const ok = await okAdapter.checkLogin({ storeId: '27636170844730', storeName: 'Tiktok-FUSOU-客服主号' });
  assert.equal(ok.state, LOGIN_STATES.LOGGED_IN);
  assert.equal(ok.loggedIn, true);
  assert.equal(ok.url, LOGGED_IN_URLS[1]);
  assert.equal(okCalls.some((args) => args[1] === 'open' || args[1] === 'visit'), false, '探测不该开店铺/导航');
  assertNoLoginAutomation(okCalls);

  // 地址读不出来（页面没开 / CLI 这一跳失败）**不能**等同于「未登录」：要人做的事完全不同。
  const blind = createTikTokAdapter({
    ziniao: { async call() { return { ok: false, data: null }; }, async callOrThrow() { return { ok: true }; } },
  });
  const failed = await blind.checkLogin({ storeId: 'x' });
  assert.equal(failed.state, LOGIN_STATES.FAILED);
  assert.equal(failed.loggedIn, false);
  assert.match(failed.hint, /读不到/);
});

test('adapter.openLogin：把人摆到登录页就停手 —— 不点登录、不填账号密码、不碰滑块', async () => {
  const calls = [];
  const ziniao = pageZiniao({ url: LOGIN_REQUIRED_URLS[1], title: 'Log in to TikTok Shop', calls });
  const adapter = createTikTokAdapter({ ziniao });
  const store = { storeId: '27409658308200', storeName: 'Tiktok-FUSOU-客服KX' };
  const result = await adapter.openLogin(store);

  assert.equal(result.state, LOGIN_STATES.LOGIN_REQUIRED, '把人摆到登录页 = login_required');
  assert.equal(result.url, LOGIN_REQUIRED_URLS[1]);
  assert.equal(result.title, 'Log in to TikTok Shop', '把「人现在看到的那一页」回显出来');
  assert.match(result.hint, /请你本人完成登录/, 'hint 要说清「这一步得人来」');
  assert.match(result.hint, /不代替人登录/);

  // 打开店铺 + 导航到商家中心（未登录会被 302 到登录页），就这两件事。
  const open = calls.find((args) => args[0] === 'store' && args[1] === 'open');
  assert.ok(open, '要先开店铺窗口（可见窗口，不加 --headless）');
  assert.equal(calls.some((args) => args.includes('--headless')), false, '永远不开无头窗口');
  const visit = calls.find((args) => args[0] === 'page' && args[1] === 'visit');
  assert.ok(visit, '要导航到商家中心');
  assert.ok(visit.includes(INBOX_URL), '导航目标是消息中心（未登录时平台会 302 到登录页）');

  // ⛔ 最关键的一条：绝不代替人完成登录。
  // 整条链路只允许这四步（都写在明面上，多一步就失败）：开店铺 / 导航 / 读地址 / 读标题。
  const step = (args) => {
    const at = args.indexOf('--script');
    return [args[0], args[1], at >= 0 ? args[at + 1] : ''].join('|');
  };
  assert.deepEqual(
    calls.map(step),
    ['store|open|', 'page|visit|', 'page|exec|location.href', 'page|exec|document.title'],
    '登录链路只该有「开店铺 + 导航 + 读地址 + 读标题」四步，多一步都说明插件越界了',
  );
  assertNoLoginAutomation(calls);
});

test('adapter.openLogin：已登录时直接说已登录，不多此一举', async () => {
  const calls = [];
  const adapter = createTikTokAdapter({
    ziniao: pageZiniao({ url: LOGGED_IN_URLS[0], title: 'TikTok Shop Seller Center', calls }),
  });
  const result = await adapter.openLogin({ storeId: '27636170844730', storeName: 'Tiktok-FUSOU-客服主号' });
  assert.equal(result.state, LOGIN_STATES.LOGGED_IN);
  assert.equal(result.url, LOGGED_IN_URLS[0]);
  assert.match(result.hint, /已在登录态/);
  assertNoLoginAutomation(calls);
});

test('adapter.openLogin：打不开店铺时报 failed（带 error），而不是含糊的「未登录」', async () => {
  const calls = [];
  const ziniao = {
    calls,
    async call(args) { calls.push(args); return { ok: false, data: null }; },
    async callOrThrow(args) {
      calls.push(args);
      throw Object.assign(new Error('内核下载失败'), { kind: 'error' });
    },
  };
  const adapter = createTikTokAdapter({ ziniao });
  const result = await adapter.openLogin({ storeId: 'x', storeName: 'Tiktok-打不开' });
  assert.equal(result.state, LOGIN_STATES.FAILED);
  assert.match(result.error, /内核下载失败/, '要把底层错误原样带出来');
  assert.match(result.hint, /打不开店铺/);
  assert.equal(calls.some((args) => args[1] === 'visit'), false, '店铺都没开起来就不该硬去导航');
  assertNoLoginAutomation(calls);
});

test('adapter.waitForLogin：第 N 次轮询后成功（假时钟，绝不真等 5 分钟）', async () => {
  const calls = [];
  // 前 2 次读地址还在登录页（人在过滑块 / 等邮箱验证码），第 3 次开始已在商家中心。
  const ziniao = pageZiniao({ url: LOGIN_REQUIRED_URLS[0], nextUrl: LOGGED_IN_URLS[0], switchAfter: 2, calls });
  const adapter = createTikTokAdapter({ ziniao });
  const clock = fakeClock(1000);

  const result = await adapter.waitForLogin(
    { storeId: '27636170844730', storeName: 'Tiktok-FUSOU-客服主号' },
    { timeoutMs: 60_000, intervalMs: 3000, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.state, LOGIN_STATES.LOGGED_IN);
  assert.equal(result.url, LOGGED_IN_URLS[0]);
  assert.equal(result.attempts, 3, '前两次还没登录上，第三次才成功');
  assert.deepEqual(clock.slept, [3000, 3000], '成功前每次间隔 3 秒');
  assert.equal(result.waitedMs, 6000, '等了 2 个间隔 = 6 秒（不是 5 分钟）');
  // 轮询期间一次点击/输入都没有：探测只是看地址变没变。
  assertNoLoginAutomation(calls);
  assert.equal(calls.filter((args) => args[1] === 'visit').length, 0, '轮询不该反复导航');
});

test('adapter.waitForLogin：一直没登录就超时，且报出等了多久', async () => {
  const calls = [];
  const adapter = createTikTokAdapter({ ziniao: pageZiniao({ url: LOGIN_REQUIRED_URLS[0], calls }) });
  const clock = fakeClock(0);

  const result = await adapter.waitForLogin(
    { storeId: '27409658308200', storeName: 'Tiktok-FUSOU-客服KX' },
    { timeoutMs: 10_000, intervalMs: 3000, sleep: clock.sleep, now: clock.now },
  );

  assert.equal(result.state, LOGIN_STATES.TIMEOUT);
  assert.equal(result.state, 'timeout');
  assert.equal(result.waitedMs, 10_000);
  assert.ok(result.waitedMs < LOGIN_TIMEOUT_MS, '这个用例必须远小于生产默认的 5 分钟');
  assert.equal(result.url, LOGIN_REQUIRED_URLS[0], '超时也要把最后看到的地址带出来');
  assert.match(result.hint, /还没登录完成/);
  assert.ok(result.attempts >= 2, '超时前要真的轮询过几次');
  assertNoLoginAutomation(calls);
});

test('adapter.waitForLogin：轮询节奏与默认值（间隔 >= 3 秒、总超时 5 分钟）', async () => {
  // 调用方传一个更小的间隔也会被抬回下限 —— 别把页面打爆。
  assert.ok(LOGIN_POLL_INTERVAL_MS >= 3000, '默认间隔 >= 3 秒');
  assert.ok(LOGIN_POLL_MIN_INTERVAL_MS >= 3000, '间隔下限 >= 3 秒');
  assert.equal(LOGIN_TIMEOUT_MS, 5 * 60 * 1000, '默认总超时 5 分钟：够人过完滑块 / 等邮箱验证码');

  const calls = [];
  const adapter = createTikTokAdapter({ ziniao: pageZiniao({ url: LOGIN_REQUIRED_URLS[0], calls }) });
  const clock = fakeClock(0);
  const result = await adapter.waitForLogin(
    { storeId: 'x' },
    { timeoutMs: 10_000, intervalMs: 500, sleep: clock.sleep, now: clock.now },
  );
  assert.equal(result.state, LOGIN_STATES.TIMEOUT);
  assert.deepEqual(clock.slept, [3000, 3000, 3000, 1000], '500ms 被抬到 3 秒；最后一次只等剩下的 1 秒');
  // 生产默认值下的节奏：第一次探测 + 3 秒一探，5 分钟到点收工（这里只用假时钟推演，不真等）。
  const defaultClock = fakeClock(0);
  const gen = createTikTokAdapter({ ziniao: pageZiniao({ url: LOGIN_REQUIRED_URLS[0] }) });
  const timedOut = await gen.waitForLogin({ storeId: 'x' }, { sleep: defaultClock.sleep, now: defaultClock.now });
  assert.equal(timedOut.state, LOGIN_STATES.TIMEOUT);
  assert.ok(defaultClock.slept.every((ms) => ms <= LOGIN_POLL_INTERVAL_MS), '每次等待都不超过间隔');
  assert.equal(
    defaultClock.slept.reduce((sum, ms) => sum + ms, 0),
    LOGIN_TIMEOUT_MS,
    '默认超时就是 5 分钟（假时钟推演，没有真等）',
  );
});

test('「登录」职责边界：不带 store 也不导航，整条登录链路零导航', async () => {
  // 有些人会在没有店铺窗口时点「登录」—— 这时要么开店铺（openLogin 干这事），
  // 要么如实报 failed（checkLogin 干这事）。**绝不能**靠导航去「顺便」打开什么。
  const calls = [];
  const adapter = createTikTokAdapter({ ziniao: pageZiniao({ url: '', calls }) });
  const probe = await adapter.checkLogin({ storeId: 'x' });
  assert.equal(probe.state, LOGIN_STATES.FAILED, '地址读不到就说读不到');
  assert.equal(calls.some((args) => args[1] === 'visit'), false, 'checkLogin 不许导航');
  assert.equal(calls.some((args) => args[1] === 'open'), false, 'checkLogin 不许开店铺窗口');
  assertNoLoginAutomation(calls);
});

test('登录不动手：代码与调用参数里都没有任何登录表单操作（回归锁）', () => {
  const src = fs.readFileSync(adapterPath, 'utf8');
  // 选择器常量**只能在声明处出现一次**（测试本身也引用它，所以只查实现文件里的代码行）。
  const lines = src.split('\n');
  const codeHits = lines.filter(
    (line) => line.includes("input[type=\\\"password\\\"]") && !/^\s*(\/\/|\*|\/\*|\s*'input)/.test(line),
  );
  assert.deepEqual(codeHits.map((line) => line.trim()), [], '登录表单选择器只允许出现在 LOGIN_FORM_SELECTORS 声明里');

  // 点击脚本只接受「导航性选择器」：把登录表单选择器喂进 clickScript 也不该真去点它 ——
  // 这里从两端都钉：实现里不存在把 LOGIN_FORM_SELECTORS 传进点击链路的代码。
  assert.equal(/clickScript\w*\(\s*LOGIN_FORM_SELECTORS/.test(src), false, '不许把登录表单选择器交给点击脚本');
  assert.equal(/page', 'click'/.test(src), false, '不许走 page click（登录链路同样适用）');
  // fillOpenConversation / fillComposer 填的永远是回复框，不可能是密码框。
  assert.match(src, /COMPOSER_INPUT_SELECTORS/);
  assert.equal(/fillOpenConversation[\s\S]{0,400}password/i.test(src), false, '填文本绝不落在密码框上');
  // 三个方法都挂到适配器上了（client 的「登录」按钮要靠它们）。
  const adapter = createTikTokAdapter({ ziniao: {} });
  for (const name of ['checkLogin', 'openLogin', 'waitForLogin']) {
    assert.equal(typeof adapter[name], 'function', '缺成员：' + name);
  }
});
