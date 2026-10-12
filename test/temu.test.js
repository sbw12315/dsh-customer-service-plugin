import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BACKEND_HOSTS,
  BACKEND_KUAJING,
  BACKEND_SELLER_CENTRAL,
  INBOX_NOT_CALIBRATED_REASON,
  KUAJING_HOME_URL,
  KUAJING_MESSAGE_CENTER_URL,
  KUAJING_ORIGIN,
  LOGIN_STATES,
  PHONE_TAB_SCRIPT,
  PLATFORM_ID,
  PLATFORM_LABEL,
  ROW_SELECTORS,
  SELLER_CENTRAL_HOME_URL,
  SELLER_CENTRAL_ORIGIN,
  THREAD_SELECTORS,
  backendOf,
  backendOfUrl,
  conversationUrl,
  createTemuAdapter,
  homeUrlFor,
  isSigninUrl,
  isTemuStore,
} from '../lib/platforms/temu.js';

/** 2026-10-12 实测：未登录访问跨境卖家中心，302 到这里。 */
const KUAJING_LOGIN_URL =
  'https://seller.kuajingmaihuo.com/login?redirectUrl=https%3A%2F%2Fseller.kuajingmaihuo.com%2Fmain%2F';
/** 2026-10-12 实测：美区卖家中心未登录的两种落点。 */
const SELLER_CENTRAL_NO_AUTH_URL = 'https://seller.temu.com/no-auth.html';
const SELLER_CENTRAL_LOGIN_URL = 'https://seller.temu.com/login.html?redirectUrl=https%3A%2F%2Fseller.temu.com%2F';

/** 紫鸟 store list 里的真实 TEMU 店（2026-10-12 实测，9 家里取 3 家代表）。 */
const TEMU_STORES = [
  { storeId: '27409837973085', storeName: 'Temu-CN-客服', platformName: 'Temu-中国卖家中心' },
  { storeId: '27872189766982', storeName: 'TEMU-COZYNOME-管理员', platformName: 'Temu-中国卖家中心' },
  { storeId: '27497129937229', storeName: 'Temu-US-管理员', platformName: 'Temu-美国-本土' },
];

/** 合成一家「停用」TEMU 店：实机确实有两家，停用判定对所有渠道一致，必须排掉。 */
const RETIRED_TEMU_STORE = {
  storeId: 'temu-old',
  storeName: 'Temu-JDDX停用-管理员',
  platformName: 'Temu-中国卖家中心',
};

const OTHER_STORES = [
  { storeId: 'shein1', storeName: 'Shein-SevenVanity-US-客服', platformName: 'SHEIN-全球' },
  { storeId: 'amz1', storeName: 'Amazon-Cozynome-管理员', platformName: '亚马逊-美国' },
];

const STORE_LIST = { items: [...TEMU_STORES, RETIRED_TEMU_STORE, ...OTHER_STORES] };

/** 手机号 tab 切成功时的实测返回（2026-10-12，Temu-CN-客服 登录页）。 */
const PHONE_TAB_OK = {
  ok: true,
  clicked: '手机号登录',
  active: '手机号登录',
  tabs: [
    { text: '扫码登录', checked: false },
    { text: '手机号登录', checked: true },
    { text: '邮箱登录', checked: false },
  ],
};

/** 只认预期调用的紫鸟客户端替身（与 amazon/tiktok/walmart/shein 那套一致）。 */
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

/** 取某次调用里的 --script。 */
const scriptOf = (args) => args[args.indexOf('--script') + 1];

/** 造一个「已登录、停在自家后台」的适配器。 */
function signedInAdapter(store = TEMU_STORES[0], url = KUAJING_HOME_URL) {
  const ziniao = fakeZiniao({
    'store list': () => STORE_LIST,
    'store open': () => ({ ok: true }),
    'page visit': () => ({ ok: true }),
    'page exec': (args) => {
      const script = scriptOf(args);
      if (script === 'location.href') return execEnvelope(url);
      if (script === PHONE_TAB_SCRIPT) return execEnvelope(PHONE_TAB_OK);
      throw new Error('未预期的 page exec：' + script.slice(0, 40));
    },
  });
  return { ziniao, adapter: createTemuAdapter({ ziniao }), store };
}

test('isTemuStore：两个 platformName 与 Temu-* / TEMU-* 店名都认', () => {
  for (const store of TEMU_STORES) {
    assert.equal(isTemuStore(store), true, store.storeName + ' 应认成 TEMU 店');
  }
  assert.equal(isTemuStore({ storeName: '未知店', platformName: 'TEMU-欧洲' }), true, 'platformName 大写也要认');
  assert.equal(isTemuStore({ storeName: 'temu-us-01', platformName: '' }), true, '店名小写 temu 也要认');
  assert.equal(isTemuStore({ storeName: '未知店', platformName: '拼多多-跨境' }), true, '中文平台名也要认');
  for (const store of OTHER_STORES) {
    assert.equal(isTemuStore(store), false, store.storeName + ' 不该被认成 TEMU 店');
  }
  // 边界：Temuco 这种「以 temu 开头但更长的单词」不能被误判（\b 的作用）。
  assert.equal(isTemuStore({ storeName: 'Temuco-Shop', platformName: '自定义平台' }), false);
  assert.equal(isTemuStore({}), false, '空对象不能抛错');
  assert.equal(isTemuStore(undefined), false, 'undefined 不能抛错');
});

test('backendOf / homeUrlFor：中国卖家中心走 kuajingmaihuo，美国-本土走 seller.temu.com', () => {
  for (const store of TEMU_STORES.slice(0, 2)) {
    assert.equal(backendOf(store), BACKEND_KUAJING, store.storeName + ' 走跨境后台');
    assert.equal(homeUrlFor(store), KUAJING_HOME_URL);
  }
  assert.equal(backendOf(TEMU_STORES[2]), BACKEND_SELLER_CENTRAL, 'Temu-美国-本土 走美区后台');
  assert.equal(homeUrlFor(TEMU_STORES[2]), SELLER_CENTRAL_HOME_URL);
  // 店名兜底：platformName 没写清楚时，Temu-US-* 也要判成美区。
  assert.equal(backendOf({ storeName: 'Temu-US-管理员', platformName: 'Temu' }), BACKEND_SELLER_CENTRAL);
  assert.equal(backendOf({}), BACKEND_KUAJING, '判不出来时不抛错，默认走跨境后台');
  assert.equal(backendOfUrl(KUAJING_HOME_URL), BACKEND_KUAJING);
  assert.equal(backendOfUrl(SELLER_CENTRAL_ORIGIN + '/main/'), BACKEND_SELLER_CENTRAL);
  assert.equal(backendOfUrl('about:blank'), null, '不在任何一套后台');
  assert.equal(backendOfUrl(''), null);
});

test('入口常量：两套后台各一个首页；消息中心只作常量记录，不当收件箱用', () => {
  assert.equal(KUAJING_ORIGIN, 'https://seller.kuajingmaihuo.com');
  assert.equal(KUAJING_HOME_URL, 'https://seller.kuajingmaihuo.com/main/');
  assert.equal(SELLER_CENTRAL_ORIGIN, 'https://seller.temu.com');
  assert.equal(KUAJING_MESSAGE_CENTER_URL, 'https://seller.kuajingmaihuo.com/message');
  assert.equal(BACKEND_HOSTS[BACKEND_KUAJING], 'seller.kuajingmaihuo.com');
  assert.equal(BACKEND_HOSTS[BACKEND_SELLER_CENTRAL], 'seller.temu.com');
  // 会话级深链：两套后台不共用地址，宁可没有也不给错链接（与 walmart 同一取舍）。
  assert.equal(conversationUrl(), '', '没有已校准的会话深链就该返回空串，前端据此隐藏入口');
  // 未校准的三段：选择器数组必须是空的 —— 有值就说明有人「猜」了。
  assert.deepEqual([...ROW_SELECTORS], []);
  assert.deepEqual([...THREAD_SELECTORS], []);
});

test('isSigninUrl：命中实测的三种未登录地址，不命中两套后台的首页', () => {
  assert.equal(isSigninUrl(KUAJING_LOGIN_URL), true);
  assert.equal(isSigninUrl(SELLER_CENTRAL_NO_AUTH_URL), true);
  assert.equal(isSigninUrl(SELLER_CENTRAL_LOGIN_URL), true);
  assert.equal(isSigninUrl(KUAJING_HOME_URL), false, '跨境后台首页不算未登录');
  assert.equal(isSigninUrl(SELLER_CENTRAL_ORIGIN + '/main/order-manage'), false, '美区后台内页不算未登录');
  assert.equal(isSigninUrl(''), false);
  assert.equal(isSigninUrl(undefined), false);
});

test('PHONE_TAB_SCRIPT 必须本身是一段能跑的 JS（模板字符串踩过的坑，落成回归锁）', () => {
  // 踩过的真实故障：脚本是模板字符串，里面写换行转义会被模板字符串**先解义成真换行**，
  // 于是下发给紫鸟的脚本变成一段语法错误的代码（shein.js 的 LIST_SCRIPT 踩过同款）。
  assert.doesNotThrow(() => new Function('return ' + PHONE_TAB_SCRIPT), '页面脚本必须能被解析');
  // 注意：脚本里**可以**有真换行（那只是空白）；坑在于脚本内的字符串转义会被外层模板字符串
  // 先解义掉，于是送进浏览器的代码里出现「字符串里的真换行」—— 那种脚本解析不过。
  // 所以上面那句 new Function 才是真正的回归锁，不要改成「不许有换行」。
  assert.ok(PHONE_TAB_SCRIPT.includes('手机号登录'), '要认得「手机号登录」这个 tab');
  assert.ok(PHONE_TAB_SCRIPT.includes('charCodeAt'), '空白过滤必须绕开模板字符串的转义坑（用字符码而不是正则）');
  // 只切 tab：脚本里不许出现「发送 / 提交 / 登录按钮」这类动作。
  assert.equal(/send|submit|password|验证码/.test(PHONE_TAB_SCRIPT), false, '脚本只许点 tab，不许提交任何东西');
});

test('适配器身份与启用：id/label/kind 对得上，默认参与巡逻，校准位如实为 false', () => {
  const { adapter } = signedInAdapter();
  assert.equal(adapter.id, PLATFORM_ID);
  assert.equal(adapter.id, 'temu');
  assert.equal(adapter.label, PLATFORM_LABEL);
  assert.equal(adapter.label, 'TEMU');
  assert.equal(adapter.kind, 'store');
  assert.equal(adapter.inboxUrl, '', '收件箱入口未校准：宁可留空也不给错地址');
  assert.equal(adapter.queueChannel, 'temu', '工单队列渠道');
  assert.equal(adapter.draftKind, 'temu', '草稿模板族');
  assert.equal(adapter.enabled(), true, '默认启用（跟着紫鸟CLI 开关走）');
  assert.equal(adapter.verified, false, '没校准完就不能自称已接入');
  assert.match(adapter.calibrationNote, /尚未覆盖/, '要说清楚没覆盖的是什么');
  assert.match(adapter.calibrationNote, /27409837973085|Temu-中国卖家中心/, '要说清是在哪家店上验证到哪一步');

  const off = createTemuAdapter({
    ziniao: fakeZiniao({}),
    settings: { cliEnabled: { ziniao: false } },
  });
  assert.equal(off.enabled(), false);
  assert.match(off.disabledHint(), /紫鸟CLI/);

  // v0.13.0：渠道自己还有一枚开关（巡逻页那一行），与紫鸟CLI 总开关分开判。
  const channelOff = createTemuAdapter({
    ziniao: fakeZiniao({}),
    settings: { channelEnabled: { temu: false } },
  });
  assert.equal(channelOff.channelEnabled(), false);
  assert.equal(channelOff.enabled(), false);
  assert.match(channelOff.disabledHint(), /巡逻页/, '要说清是渠道被停用');
  assert.equal(off.channelEnabled(), true, 'CLI 被禁用不影响渠道开关本身');
});

test('listStores：只留 TEMU 店，且排掉店名带「停用」的', async () => {
  const { adapter } = signedInAdapter();
  const stores = await adapter.listStores();
  assert.deepEqual(
    stores.map((store) => store.storeId),
    TEMU_STORES.map((store) => store.storeId),
  );
  const all = await adapter.listAllStores();
  assert.equal(all.length, STORE_LIST.items.length, 'listAllStores 要给全量，扫描接口靠它解释别的平台');
});

test('checkLogin：只看地址；读不到 / 停在别处都不算「已登录」', async () => {
  const signed = signedInAdapter();
  const ok = await signed.adapter.checkLogin(signed.store);
  assert.equal(ok.state, LOGIN_STATES.LOGGED_IN);
  assert.equal(ok.loggedIn, true);
  assert.deepEqual(
    signed.ziniao.calls.map((args) => args[0] + ' ' + args[1]),
    ['page exec'],
    '登录探测只读一次地址，没有副作用',
  );

  // 跨境店停在跨境登录页。
  const required = createTemuAdapter({ ziniao: fakeZiniao({ 'page exec': () => execEnvelope(KUAJING_LOGIN_URL) }) });
  const kuajing = await required.checkLogin(TEMU_STORES[0]);
  assert.equal(kuajing.state, LOGIN_STATES.LOGIN_REQUIRED);
  assert.equal(kuajing.loggedIn, false);
  assert.match(kuajing.hint, /登录/);

  // 美区店停在 no-auth.html：同样是未登录，但提示词按后台分开。
  const overseas = createTemuAdapter({
    ziniao: fakeZiniao({ 'page exec': () => execEnvelope(SELLER_CENTRAL_NO_AUTH_URL) }),
  });
  const us = await overseas.checkLogin(TEMU_STORES[2]);
  assert.equal(us.state, LOGIN_STATES.LOGIN_REQUIRED);
  assert.match(us.hint, /Seller Central/);

  const broken = createTemuAdapter({ ziniao: fakeZiniao({ 'page exec': () => ({ ok: false }) }) });
  const failed = await broken.checkLogin(TEMU_STORES[0]);
  assert.equal(failed.state, LOGIN_STATES.FAILED, '读不到地址既不是已登录也不是未登录');

  // about:blank 是最容易被误判成「已登录」的一种：窗口开着，但页面根本没开。
  const blank = createTemuAdapter({ ziniao: fakeZiniao({ 'page exec': () => execEnvelope('about:blank') }) });
  const idle = await blank.checkLogin(TEMU_STORES[0]);
  assert.equal(idle.state, LOGIN_STATES.FAILED, 'about:blank 不能算已登录');
  assert.match(idle.hint, /还不是 TEMU 卖家后台/);

  // 开错平台：跨境店被开到了美区后台 —— 提示要指名道姓说清是开错平台。
  const wrong = createTemuAdapter({
    ziniao: fakeZiniao({ 'page exec': () => execEnvelope(SELLER_CENTRAL_NO_AUTH_URL.replace('/no-auth.html', '/main/')) }),
  });
  const mismatched = await wrong.checkLogin(TEMU_STORES[0]);
  assert.equal(mismatched.state, LOGIN_STATES.FAILED);
  assert.match(mismatched.hint, /开错平台/);
});

test('prepare：未登录抛 kind=auth；已登录则开店铺 + 导航到**这家店自己的**后台', async () => {
  const out = createTemuAdapter({
    ziniao: fakeZiniao({
      'store open': () => ({ ok: true }),
      'page visit': (args) => ({ ok: true, args }),
      'page exec': () => execEnvelope(KUAJING_LOGIN_URL),
    }),
  });
  await assert.rejects(
    () => out.prepare(TEMU_STORES[0]),
    (cause) => cause.kind === 'auth' && /登录/.test(cause.message),
  );

  const signed = signedInAdapter();
  await signed.adapter.prepare(signed.store);
  const kinds = signed.ziniao.calls.map((args) => args[0] + ' ' + args[1]);
  assert.deepEqual(kinds, ['store open', 'page visit', 'page exec'], '开店铺 → 导航 → 读地址确认登录');

  // 美区店必须导航到 seller.temu.com，不能导航到跨境后台。
  const us = signedInAdapter(TEMU_STORES[2], SELLER_CENTRAL_HOME_URL);
  await us.adapter.prepare(us.store);
  const visit = us.ziniao.calls.find((args) => args[0] === 'page' && args[1] === 'visit');
  assert.equal(visit[visit.indexOf('--url') + 1], SELLER_CENTRAL_HOME_URL);
});

test('selectPhoneLoginTab：跨境店切「手机号登录」；美区店没有这个 tab，一个脚本都不发', async () => {
  const { adapter, ziniao } = signedInAdapter();
  const tab = await adapter.selectPhoneLoginTab(TEMU_STORES[0]);
  assert.equal(tab.ok, true);
  assert.equal(tab.active, '手机号登录');
  assert.equal(tab.backend, BACKEND_KUAJING);
  const execs = ziniao.calls.filter((args) => args[1] === 'exec');
  assert.equal(execs.length, 1);
  assert.equal(scriptOf(execs[0]), PHONE_TAB_SCRIPT);

  // 美区后台的登录页只有 Sign in / Sign up（2026-10-12 实测），硬点最可能点到注册页。
  const us = signedInAdapter(TEMU_STORES[2], SELLER_CENTRAL_LOGIN_URL);
  const skipped = await us.adapter.selectPhoneLoginTab(us.store);
  assert.equal(skipped.ok, false);
  assert.equal(skipped.reason, 'not-applicable');
  assert.equal(us.ziniao.calls.length, 0, '不适用的后台不该发任何页面脚本');

  // 脚本失败要能区分「没切到」与「压根没发出去」。
  const broken = createTemuAdapter({ ziniao: fakeZiniao({ 'page exec': () => ({ ok: false, error: { message: 'bridge down' } }) }) });
  const failed = await broken.selectPhoneLoginTab(TEMU_STORES[0]);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'exec-failed');
});

test('openLogin：未登录时把登录页摆好并切到手机号登录；全程没有任何填入动作', async () => {
  const { adapter, ziniao, store } = signedInAdapter(TEMU_STORES[0], KUAJING_LOGIN_URL);
  const opened = await adapter.openLogin(store);
  assert.equal(opened.state, LOGIN_STATES.LOGIN_REQUIRED);
  assert.equal(opened.phoneLoginTab.ok, true, '切 tab 的结果要带出来，前端才知道该不该说这句话');
  assert.match(opened.hint, /手机号登录/, 'hint 要说清已经切过 tab');
  assert.match(opened.hint, /不代填/, '同时要说清插件不代填');

  // 硬约束：整条链路上没有一次输入/点击登录按钮。
  const flat = ziniao.calls.map((args) => args.join(' ')).join(String.fromCharCode(10));
  assert.equal(ziniao.calls.some((args) => args.includes('--text')), false, '不许往页面里填任何文本');
  assert.equal(ziniao.calls.some((args) => args.includes('input')), false, '不许调 CLI 的 input');
  assert.equal(/密码|验证码|captcha|password|otp/i.test(flat), false, '参数里不许出现凭据语义');

  // 已经登录的店：不该再去点 tab（页面压根不在登录页）。
  const signed = signedInAdapter();
  const already = await signed.adapter.openLogin(signed.store);
  assert.equal(already.state, LOGIN_STATES.LOGGED_IN);
  assert.equal(already.phoneLoginTab, null);
  assert.equal(
    signed.ziniao.calls.some((args) => args[0] === 'page' && args[1] === 'exec' && scriptOf(args) === PHONE_TAB_SCRIPT),
    false,
    '已登录时不该发切 tab 的脚本',
  );
});

test('listConversations / readConversation：未校准就抛错，绝不返回空列表', async () => {
  const { adapter, store } = signedInAdapter();
  await assert.rejects(
    () => adapter.listConversations(store),
    (cause) =>
      cause.kind === 'page' &&
      cause.reason === INBOX_NOT_CALIBRATED_REASON &&
      /消费者咨询/.test(cause.message) &&
      /smoke-temu/.test(cause.message),
  );
  await assert.rejects(
    () => adapter.readConversation(),
    (cause) => cause.kind === 'page' && cause.reason === INBOX_NOT_CALIBRATED_REASON,
  );
  assert.equal(adapter.conversationId(), '');
});
