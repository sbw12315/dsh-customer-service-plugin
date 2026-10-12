import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CHAT_RECORDS_URL,
  CHAT_WORKSPACE_URL,
  LIST_SCRIPT,
  LOGIN_STATES,
  PLATFORM_ID,
  PLATFORM_LABEL,
  ROW_SELECTORS,
  SELLER_HUB_ORIGIN,
  SELLER_TICKETS_URL,
  SIGNIN_URL_RE,
  THREAD_SELECTORS,
  WORK_ORDERS_URL,
  conversationUrl,
  createSheinAdapter,
  isSheinStore,
} from '../lib/platforms/shein.js';

/** 2026-10-10 实测的登录页地址（未登录访问 sellerhub 落到这里）。 */
const SHEIN_LOGIN_URL =
  'https://sellerhub.shein.com/#/login/GMPSSO/aHR0cHM6Ly9zZWxsZXJodWIuc2hlaW4uY29tLw==';
/** 登录提交后的 OTP 二次验证地址。 */
const SHEIN_AUTH_URL =
  'https://sellerhub.shein.com/#/auth/GMPSSO/aHR0cHM6Ly9zZWxsZXJodWIuc2hlaW4uY29tLw==';

/** 紫鸟 store list 里的真实 SHEIN 店（2026-10-10 实测，平台名就是 SHEIN-全球）。 */
const SHEIN_STORES = [
  { storeId: '27618263276365', storeName: 'Shein-SevenVanity-US-客服', platformName: 'SHEIN-全球' },
  { storeId: '27394308548757', storeName: 'Shein-SevenVanity-US-管理员', platformName: 'SHEIN-全球' },
  // 店名不带 Shein 的形态也必须认出来 —— 这家是实机存在的。
  { storeId: '27823580048471', storeName: 'SHEIN-英国-自运营', platformName: 'SHEIN-全球' },
];

/** 合成一家「停用」SHEIN 店：实机暂无，但停用判定对所有渠道一致，必须排掉。 */
const RETIRED_SHEIN_STORE = {
  storeId: 'shein-old',
  storeName: 'Shein-Yanosaku-CA-已停用',
  platformName: 'SHEIN-全球',
};

const OTHER_STORES = [
  { storeId: 'amz1', storeName: 'Amazon-Cozynome-管理员', platformName: '亚马逊-美国' },
  { storeId: 'tt1', storeName: 'Tiktok-FUSOU-客服主号', platformName: 'TikTok Shop-全球跨境(自运营)(新)' },
];

const STORE_LIST = { items: [...SHEIN_STORES, RETIRED_SHEIN_STORE, ...OTHER_STORES] };

/** 工作台空态的角标读数（2026-10-10 实测：接待会话数 0 / 排队中 0）。 */
const EMPTY_COUNTS = {
  ok: true,
  url: CHAT_WORKSPACE_URL,
  tabs: [
    { label: '会话中', count: 0 },
    { label: '历史会话', count: null },
  ],
  active: 0,
  queued: 0,
  history: null,
  pending: 0,
  emptyText: true,
};

/** 只认预期调用的紫鸟客户端替身（与 amazon/tiktok/walmart 那套一致）。 */
function fakeZiniao(handlers = {}) {
  const calls = [];
  const invoke = (args) => {
    calls.push(args);
    const handler = handlers[args[0] + ' ' + args[1]];
    if (!handler) throw new Error('未预期的调用：' + args.join(' '));
    return handler(args);
  };
  return {
    calls,
    async callOrThrow(args) {
      return invoke(args);
    },
    async call(args) {
      try {
        const out = invoke(args);
        // 处理函数可以直接返回 {ok:false} 模拟失败；真实客户端的 call() 从不抛错，只回 ok:false。
        return out && typeof out === 'object' && 'ok' in out ? out : { ok: true, data: out };
      } catch (cause) {
        return { ok: false, data: null, error: { kind: 'error', message: cause.message } };
      }
    },
  };
}

/** page exec 的信封：把页面脚本的返回值包成真实客户端那一层。 */
const execEnvelope = (value) => ({
  data: { result: typeof value === 'string' ? value : JSON.stringify(value) },
});

/** 造一个「已登录、工作台空态」的适配器。 */
function signedInAdapter(counts = EMPTY_COUNTS) {
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page wait-element': () => ({ ok: true }),
    'page exec': (args) => {
      const script = args[args.indexOf('--script') + 1];
      if (script === 'location.href') return execEnvelope(CHAT_WORKSPACE_URL);
      return execEnvelope(counts);
    },
  });
  return { ziniao, adapter: createSheinAdapter({ ziniao }) };
}

test('isSheinStore：平台名 SHEIN-全球 与店名 Shein-* / 希音 两处都认', () => {
  for (const store of SHEIN_STORES) {
    assert.equal(isSheinStore(store), true, store.storeName + ' 应认成 SHEIN 店');
  }
  assert.equal(isSheinStore({ storeName: '未知店', platformName: '希音-美国' }), true, '中文平台名也要认');
  assert.equal(isSheinStore({ storeName: 'shein-us-01', platformName: '' }), true, '店名小写 shein 也要认');
  for (const store of OTHER_STORES) {
    assert.equal(isSheinStore(store), false, store.storeName + ' 不该被认成 SHEIN 店');
  }
  assert.equal(isSheinStore({}), false, '空对象不能抛错');
  assert.equal(isSheinStore(undefined), false, 'undefined 不能抛错');
});

test('入口常量：客服回复页 = 顶部菜单「客服 → chat工作台」，且都在 sellerhub 下', () => {
  assert.equal(SELLER_HUB_ORIGIN, 'https://sellerhub.shein.com');
  assert.equal(CHAT_WORKSPACE_URL, 'https://sellerhub.shein.com/#/csd-chat-us/chat/workspace?noLayout=1');
  assert.equal(SELLER_TICKETS_URL, 'https://sellerhub.shein.com/#/csd-us/seller-mode/seller-tickets/home-page');
  assert.equal(CHAT_RECORDS_URL, 'https://sellerhub.shein.com/#/csd-chat-us/chat/record/list');
  assert.equal(WORK_ORDERS_URL, 'https://sellerhub.shein.com/#/csd-document-us/work-order/list');
  const urls = [CHAT_WORKSPACE_URL, SELLER_TICKETS_URL, CHAT_RECORDS_URL, WORK_ORDERS_URL];
  assert.equal(
    urls.some((url) => url.indexOf('seller.shein.com') >= 0),
    false,
    'seller.shein.com 是个死域名（ERR_CONNECTION_CLOSED），不能写进入口',
  );
  assert.equal(conversationUrl('whatever'), CHAT_WORKSPACE_URL, '没有会话级深链：退回客服回复页入口');
});

test('LIST_SCRIPT 必须本身是一段能跑的 JS（模板字符串踩过的坑，落成回归锁）', () => {
  // 踩过的真实故障：脚本是模板字符串，里面写 '\n' 会被模板字符串**先解义成真换行**，
  // 于是下发给紫鸟的脚本变成一段语法错误的代码，报的却是 zclaw INVALID_ARGS —— 极难定位。
  assert.doesNotThrow(() => new Function('return ' + LIST_SCRIPT), '页面脚本必须能被解析');
  assert.match(LIST_SCRIPT, /sessions_top_option_gO0Sc/, '角标选择器要写进脚本');
  assert.match(LIST_SCRIPT, /no-tabs/, '读不到 tab 时要能区分「读不到」与「0 条」');
});

test('SIGNIN_URL_RE：命中实测的登录 / OTP 地址，不命中已登录的工作台与首页', () => {
  assert.match(SHEIN_LOGIN_URL, SIGNIN_URL_RE);
  assert.match(SHEIN_AUTH_URL, SIGNIN_URL_RE);
  assert.equal(SIGNIN_URL_RE.test(CHAT_WORKSPACE_URL), false, '工作台地址不能被当成未登录');
  assert.equal(SIGNIN_URL_RE.test(SELLER_HUB_ORIGIN + '/#/home'), false, '首页同样不算未登录');
});

test('适配器身份与启用：id/label/kind 对得上，默认参与巡逻', () => {
  const { adapter } = signedInAdapter();
  assert.equal(adapter.id, PLATFORM_ID);
  assert.equal(adapter.id, 'shein');
  assert.equal(adapter.label, PLATFORM_LABEL);
  assert.equal(adapter.label, 'SHEIN');
  assert.equal(adapter.kind, 'store');
  assert.equal(adapter.inboxUrl, CHAT_WORKSPACE_URL, '收件箱入口就是 chat工作台');
  assert.equal(adapter.queueChannel, 'shein', '工单队列渠道');
  assert.equal(adapter.draftKind, 'shein', '草稿模板族');
  assert.equal(adapter.enabled(), true, '默认启用（跟着紫鸟CLI 开关走）');
  // 紫鸟CLI 被禁用时这个渠道也不参与巡逻（与 amazon/tiktok/walmart 同一口径）。
  const off = createSheinAdapter({
    ziniao: fakeZiniao({}),
    settings: { cliEnabled: { ziniao: false } },
  });
  assert.equal(off.enabled(), false);
  assert.match(off.disabledHint(), /紫鸟CLI/);

  // v0.13.0：渠道自己还有一枚开关（巡逻页那一行），与 CLI 总开关分开判。
  const channelOff = createSheinAdapter({
    ziniao: fakeZiniao({}),
    settings: { channelEnabled: { shein: false } },
  });
  assert.equal(channelOff.channelEnabled(), false);
  assert.equal(channelOff.enabled(), false);
  assert.match(channelOff.disabledHint(), /巡逻页/, '要说清是渠道被停用');
  assert.equal(off.channelEnabled(), true, 'CLI 被禁用不影响渠道开关本身');
});

test('checkLogin：只看地址，不导航、不点、不填', async () => {
  const signedIn = signedInAdapter();
  const ok = await signedIn.adapter.checkLogin(SHEIN_STORES[0]);
  assert.equal(ok.state, LOGIN_STATES.LOGGED_IN);
  assert.equal(ok.loggedIn, true);
  assert.deepEqual(
    signedIn.ziniao.calls.map((args) => args[0] + ' ' + args[1]),
    ['page exec'],
    '登录探测只读一次地址，没有副作用',
  );

  const out = createSheinAdapter({
    ziniao: fakeZiniao({ 'page exec': () => execEnvelope(SHEIN_LOGIN_URL) }),
  });
  const required = await out.checkLogin(SHEIN_STORES[0]);
  assert.equal(required.state, LOGIN_STATES.LOGIN_REQUIRED);
  assert.equal(required.loggedIn, false);
  assert.match(required.hint, /登录/);

  const broken = createSheinAdapter({ ziniao: fakeZiniao({ 'page exec': () => ({ ok: false }) }) });
  const failed = await broken.checkLogin(SHEIN_STORES[0]);
  assert.equal(failed.state, LOGIN_STATES.FAILED, '读不到地址既不是已登录也不是未登录');
});

test('prepare：未登录抛 kind=auth；已登录则开店铺 + 导航 + 等工作台骨架', async () => {
  const out = createSheinAdapter({
    ziniao: fakeZiniao({
      'store open': () => ({ ok: true }),
      'page visit': () => ({ ok: true }),
      'page exec': () => execEnvelope(SHEIN_LOGIN_URL),
    }),
  });
  const error = await out.prepare(SHEIN_STORES[0]).then(() => null).catch((cause) => cause);
  assert.ok(error, '未登录必须抛错');
  assert.equal(error.kind, 'auth', '要说清是登录问题，不是页面结构问题');
  assert.match(error.message, /未登录/);
  assert.match(error.hint, /登录/);

  const { adapter, ziniao } = signedInAdapter();
  await adapter.prepare(SHEIN_STORES[0]);
  const flat = ziniao.calls.map((args) => args.join(' '));
  assert.ok(
    flat.some((line) => line.indexOf('store open --id 27618263276365') === 0),
    '先开店铺窗口',
  );
  assert.ok(
    flat.some((line) => line.indexOf('page visit') === 0 && line.indexOf(CHAT_WORKSPACE_URL) > 0),
    '再导航到 chat工作台',
  );
  assert.equal(flat.some((line) => line.indexOf('--headless') > 0), false, '永远不开无头窗口');
});

test('listConversations：空态读角标 → 0 条；**角标 > 0 直接抛错**，绝不返回空列表', async () => {
  const empty = signedInAdapter();
  const result = await empty.adapter.listConversations(SHEIN_STORES[0]);
  assert.deepEqual(result.items, []);
  assert.equal(result.url, CHAT_WORKSPACE_URL);
  assert.equal(result.counts.pending, 0, '空态读数要带出来，便于巡逻日志核对');

  // 关键回归锁：真有会话而会话行选择器还没校准时，返回空列表 = 静默漏单，最坏的一种失败。
  const busy = signedInAdapter({ ...EMPTY_COUNTS, active: 3, queued: 1, pending: 4 });
  const error = await busy.adapter
    .listConversations(SHEIN_STORES[0])
    .then(() => null)
    .catch((cause) => cause);
  assert.ok(error, '有会话却读不出行时，必须报错');
  assert.equal(error.reason, 'rows-not-calibrated');
  assert.match(error.message, /4 条会话/);
  assert.match(error.message, /校准/);
  assert.deepEqual(ROW_SELECTORS, [], '会话行选择器还没校准：宁可为空，也不塞猜的类名');
  assert.deepEqual(THREAD_SELECTORS, [], '会话正文选择器同理');
});

test('listConversations：工作台没加载出来（no-tabs）也要报错，不能当成 0 条', async () => {
  const broken = createSheinAdapter({
    ziniao: fakeZiniao({
      'page exec': () => execEnvelope({ ok: false, reason: 'no-tabs', url: CHAT_WORKSPACE_URL }),
    }),
  });
  const error = await broken
    .listConversations(SHEIN_STORES[0])
    .then(() => null)
    .catch((cause) => cause);
  assert.ok(error);
  assert.equal(error.reason, 'no-tabs');
  assert.match(error.message, /读不到不等于是 0 条/);
});

test('readConversation：未校准，恒定抛错（会话行校准之前不会走到这里）', async () => {
  const { adapter } = signedInAdapter();
  const error = await adapter.readConversation().then(() => null).catch((cause) => cause);
  assert.ok(error);
  assert.equal(error.reason, 'thread-not-calibrated');
  assert.match(error.message, /尚未校准/);
  assert.equal(adapter.conversationId(), '', '没有会话行就没有会话标识');
});

test('不导出回复框能力 —— 没有校准过的输入框选择器，就不代填', () => {
  const { adapter } = signedInAdapter();
  for (const method of ['fillComposer', 'fillOpenConversation']) {
    assert.equal(typeof adapter[method], 'undefined', '没有校准就不该导出 ' + method);
  }
  assert.equal(adapter.supportsAutoLogin, undefined, 'SHEIN 没有自动登录');
});

test('listSources：只列 SHEIN 店，并排掉店名带「停用」的店', async () => {
  const ziniao = fakeZiniao({ 'store list': () => STORE_LIST });
  const adapter = createSheinAdapter({ ziniao });
  const stores = await adapter.listSources();
  assert.deepEqual(
    stores.map((store) => store.storeId),
    SHEIN_STORES.map((store) => store.storeId),
  );

  const all = await adapter.listAllStores();
  assert.equal(all.length, STORE_LIST.items.length, 'listAllStores 给扫描接口的是全量');
  assert.ok(all.some((store) => store.storeId === RETIRED_SHEIN_STORE.storeId));
});

test('校准位：verified=false + calibrationNote 写清「哪家店、验到哪一步、还没覆盖什么」', () => {
  const { adapter } = signedInAdapter();
  assert.equal(adapter.verified, false, '会话行与正文没校准完，不能自称已接入');
  assert.match(adapter.calibrationNote, /27618263276365/, '要说清是在哪家店上验证的');
  assert.match(adapter.calibrationNote, /尚未覆盖/, '没覆盖的部分也要写出来');
  assert.match(adapter.calibrationNote, /角标/, '已校准的部分要有依据');
});

test('登录链路只做「开店铺 + 导航 + 读地址」：不点、不填、不碰验证码', async () => {
  const ziniao = fakeZiniao({
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': () => execEnvelope(SHEIN_LOGIN_URL),
  });
  const adapter = createSheinAdapter({ ziniao });
  await adapter.openLogin(SHEIN_STORES[0]);
  const flat = ziniao.calls.map((args) => args.join(' ')).join('\n');
  assert.equal(/\bclick\b/.test(flat), false, '登录链路里不许出现 click');
  assert.equal(/\binput\b/.test(flat), false, '登录链路里不许出现 input');
  assert.equal(/--text|--clear/.test(flat), false, '不许往任何输入框写东西');
  assert.equal(/password|otp|captcha|验证码|滑块/i.test(flat), false, '参数里不许出现凭据/验证码语义');
});
