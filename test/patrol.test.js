import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  PATROL_DEFAULTS,
  PatrolError,
  createLoginService,
  createPatrolService,
  normalizePatrolOptions,
} from '../lib/patrol.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';
import { createDraftStore } from '../lib/store/drafts.js';
import { createQueueStore } from '../lib/store/queue.js';

const silent = { warn: () => {}, info: () => {} };

/** 轮询等待条件成立；超时直接失败，避免测试挂死。 */
async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('等待超时');
}

/** 造会话数据。 */
function conversation(buyer, orderId, inbound) {
  return { buyer, orderId, subject: `Inquiry from ${buyer}`, due: '到期时间：30 分钟', inbound };
}

/**
 * 造一个假适配器。
 * @param {{stores?: object[], conversations?: Record<string, object[]>, failStores?: string[], inboxReady?: boolean}} [opts]
 */
function fakeAdapter(opts = {}) {
  const stores = opts.stores ?? [
    { storeId: 's1', storeName: 'Amazon-Cozynome-管理员', platformName: '亚马逊-美国' },
    { storeId: 's2', storeName: 'Amazon-FUSOU-客服', platformName: '亚马逊-欧洲' },
  ];
  const byStore = opts.conversations ?? {
    s1: [conversation('cain', '113-9341386-0505001', 'The glass is broken, please send a replacement for order 113-9341386-0505001'),
         conversation('jen', '114-6929370-0800000', 'My package did not arrive yet')],
    s2: [conversation('sharon', '114-2844807-7527457', 'I want a refund please')],
  };
  const calls = [];
  let current = null;
  return {
    id: 'amazon',
    label: '亚马逊',
    kind: 'store',
    inboxUrl: 'https://example.test/inbox',
    queueChannel: 'amazon',
    draftKind: 'amazon',
    conversationId: (thread) => /[?&]cc=([^&]+)/.exec(thread?.url ?? '')?.[1] ?? '',
    calls,

    /* ── 巡逻面（引擎只认这几个） ── */
    async listSources() {
      calls.push(['listStores']);
      return stores;
    },
    async prepare(store) {
      await this.openStore(store);
      await this.visitInbox(store);
      if (!(await this.waitForInbox(store))) {
        throw Object.assign(new Error('收件箱没有加载出来（通常是该店铺未登录）'), { kind: 'page' });
      }
    },
    async listConversations(store) {
      const list = await this.extractList(store);
      return {
        ...list,
        items: list.items.map((item) => ({ ...item, dueMinutes: 30 })),
      };
    },
    async readConversation(store, item) {
      await this.openConversation(store, item.index);
      return this.extractThread(store);
    },
    async closeSource(store) {
      await this.closeStore(store);
    },

    async listStores() {
      calls.push(['listStores']);
      return stores;
    },
    async openStore(store) {
      calls.push(['openStore', store.storeId]);
      if ((opts.failStores ?? []).includes(store.storeId)) throw new Error(`打不开店铺 ${store.storeId}`);
    },
    async closeStore(store) {
      calls.push(['closeStore', store.storeId]);
    },
    async visitInbox(store) {
      calls.push(['visitInbox', store.storeId]);
    },
    async waitForInbox() {
      return opts.inboxReady !== false;
    },
    async extractList(store) {
      return {
        url: `https://example.test/inbox?store=${store.storeId}`,
        items: (byStore[store.storeId] ?? []).map((item, index) => ({ index, ...item })),
      };
    },
    async openConversation(store, index) {
      calls.push(['openConversation', store.storeId, index]);
      current = { store, index };
    },
    async extractThread() {
      const item = (byStore[current.store.storeId] ?? [])[current.index];
      return {
        ok: true,
        url: `https://example.test/inbox?cc=case-${current.store.storeId}-${current.index}&fi=x`,
        buyer: item.buyer,
        topic: item.subject,
        due: item.due,
        messages: [{ dir: 'in', date: '2026-10-05', body: item.inbound }],
        lastInbound: { dir: 'in', date: '2026-10-05', body: item.inbound },
        messageCount: 1,
      };
    },
    async fillComposer() {
      calls.push(['fillComposer']);
      throw new Error('巡逻不该调用 fillComposer');
    },
  };
}

/** 建一套巡逻依赖。 */
function makeService(adapter, settings = {}, extraAdapters = {}, loginState = undefined) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-patrol-'));
  const drafts = createDraftStore({ dir: path.join(dir, 'drafts'), logger: silent });
  const queue = createQueueStore({ file: path.join(dir, 'queue.json'), logger: silent });
  const service = createPatrolService({
    adapters: { [adapter.id]: adapter, ...extraAdapters },
    drafts,
    queue,
    settings,
    logger: silent,
    stateFile: path.join(dir, 'run', 'patrol-last.json'),
    // 可选注入：不给的时候引擎自己建一个空的登录服务，行为仍然成立。
    ...(loginState ? { loginState } : {}),
  });
  return { service, drafts, queue, dir };
}

test('normalizePatrolOptions：收敛数值、渠道与目标 id', () => {
  const defaults = { maxStores: 0, maxPerStore: 3, closeAfter: false, channels: [], writeMailDrafts: false, autoLogin: false };
  assert.deepEqual(normalizePatrolOptions({ maxPerStore: 999, sourceIds: ['a', '', ' b '] }, defaults), {
    maxStores: 0,
    maxPerStore: 50,
    closeAfter: false,
    channels: [],
    writeMailDrafts: false,
    autoFillAmazon: false,
    autoLogin: false,
    sourceIds: ['a', 'b'],
    sourceIdsByChannel: {},
  });
  // 旧前端字段名 storeIds 仍然认。
  assert.deepEqual(normalizePatrolOptions({ storeIds: ['x'] }, defaults).sourceIds, ['x']);
  assert.deepEqual(normalizePatrolOptions({ channels: ['amazon', 'lark-mail'] }, defaults).channels, ['amazon', 'lark-mail']);
  assert.equal(normalizePatrolOptions({ maxStores: -5 }, defaults).maxStores, 0);
  assert.equal(normalizePatrolOptions({}, defaults).maxPerStore, 3);
});

test('normalizePatrolOptions：sourceIdsByChannel 逐渠道收敛，空数组保留', () => {
  const opts = normalizePatrolOptions({
    sourceIdsByChannel: { amazon: [' a ', '', 'b'], tiktok: [], '': ['x'], walmart: 'not-a-list' },
  });
  assert.deepEqual(opts.sourceIdsByChannel, {
    amazon: ['a', 'b'],
    tiktok: [],
    walmart: [],
  }, '空键丢掉；空数组留着（= 这个渠道全部目标）；非数组当空');
  assert.deepEqual(normalizePatrolOptions({ sourceIdsByChannel: ['a'] }).sourceIdsByChannel, {}, '数组不是映射');
  assert.deepEqual(normalizePatrolOptions({}).sourceIdsByChannel, {});
});

test('默认值：每个目标最多 50 条草稿，也就是上限本身', () => {
  assert.equal(PATROL_DEFAULTS.maxPerStore, 50);
  assert.equal(DEFAULT_SETTINGS.patrol.maxPerStore, 50);
  assert.equal(normalizePatrolOptions({}).maxPerStore, 50);
  // 未登录时自动登录默认开启（只有声明了 supportsAutoLogin 的渠道会真的用到）。
  assert.equal(PATROL_DEFAULTS.autoLogin, true);
  assert.equal(normalizePatrolOptions({}).autoLogin, true);
  assert.equal(normalizePatrolOptions({ autoLogin: false }).autoLogin, false);
  // 上限同样是 50：给个更大的数会被收敛回来，不会写出界。
  assert.equal(normalizePatrolOptions({ maxPerStore: 9999 }).maxPerStore, 50);
  assert.equal(normalizePatrolOptions({ maxPerStore: 0 }).maxPerStore, 1, '下限仍是 1');
});

test('无头模式已移除，草稿默认直接填入回复框', () => {
  // 无头：settings 与巡逻参数里都不该再有这个键。
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS.patrol, 'headless'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(PATROL_DEFAULTS, 'headless'), false);
  assert.equal(normalizePatrolOptions({}).headless, undefined);

  // 填入回复框：默认开启，且不再由 settings 控制。
  assert.equal(PATROL_DEFAULTS.autoFillAmazon, true);
  assert.equal(normalizePatrolOptions({}).autoFillAmazon, true);
  assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS.patrol, 'autoFillAmazon'), false);
  // 仍然允许显式关掉（排障/测试用）。
  assert.equal(normalizePatrolOptions({ autoFillAmazon: false }).autoFillAmazon, false);
});

test('巡逻全流程：两家店都过一遍，按会话生成草稿并入队', async () => {
  const adapter = fakeAdapter();
  const { service, drafts, queue } = makeService(adapter);

  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;

  assert.equal(run.status, 'done');
  assert.equal(run.progress.sourcesTotal, 2);
  assert.equal(run.progress.sourcesDone, 2);
  assert.equal(run.progress.sourcesFailed, 0);
  // 默认每店 3 条，s1 有 2 条、s2 有 1 条。
  assert.equal(run.progress.draftsCreated, 3);
  assert.equal(drafts.counts().total, 3);

  const all = drafts.list({}).items;
  assert.deepEqual(all.map((item) => item.buyer).sort(), ['cain', 'jen', 'sharon']);

  const cain = all.find((item) => item.buyer === 'cain');
  assert.equal(cain.intent, 'replacement');
  assert.equal(cain.orderId, '113-9341386-0505001');
  assert.match(cain.body, /replacement/i);
  assert.equal(cain.caseId, 'case-s1-0');
  assert.ok(cain.ticketId, '草稿应该带上工单 id');

  // 工单落到亚马逊渠道，并且停在 drafted —— 没有发送通路。
  const ticket = queue.get(cain.ticketId);
  assert.equal(ticket.channel, 'amazon');
  assert.equal(ticket.kind, 'message');
  assert.equal(ticket.status, 'drafted');
  assert.equal(ticket.draftId, cain.id, '工单要指回草稿');
  assert.match(ticket.snippet, /replacement for order/, '工单摘要应取自买家最后一条');
  assert.equal(queue.list({ channel: 'amazon' }).total, 3);
});

test('巡逻不会调用任何填表/发送动作', async () => {
  const adapter = fakeAdapter();
  const { service } = makeService(adapter);
  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  assert.equal(adapter.calls.some((call) => call[0] === 'fillComposer'), false);
  const flat = JSON.stringify(adapter.calls);
  assert.equal(/send|发送/i.test(flat), false);
});

test('maxPerStore 限制每家店生成的草稿数', async () => {
  const adapter = fakeAdapter();
  const { service, drafts } = makeService(adapter);
  service.start({ maxPerStore: 1 });
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;
  assert.equal(run.progress.draftsCreated, 2);
  assert.equal(drafts.counts().total, 2);
  assert.deepEqual(drafts.list({}).items.map((item) => item.buyer).sort(), ['cain', 'sharon']);
});

test('sourceIdsByChannel：每个渠道各按自己的清单过滤，空数组不被全局清单接管', async () => {
  const adapter = fakeAdapter();
  const { service, drafts } = makeService(adapter);
  // 亚马逊这一档只勾了 s2：清单里有它的名字，就不再受全局 sourceIds 影响。
  service.start({ sourceIdsByChannel: { amazon: ['s2'] } });
  await waitFor(() => service.snapshot().run.status !== 'running');
  assert.equal(service.snapshot().run.progress.sourcesTotal, 1);
  assert.deepEqual(service.snapshot().run.sources.map((entry) => entry.storeId), ['s2']);
  assert.deepEqual(drafts.list({}).items.map((item) => item.buyer), ['sharon']);

  // **空数组也是「有清单」**：它表示「这个渠道全部都要」。用 length 判的话，
  // 全局那份 sourceIds 就会把「沃尔玛全部」砍成亚马逊勾的那两家。
  const second = fakeAdapter();
  const { service: service2, drafts: drafts2 } = makeService(second);
  service2.start({ sourceIds: ['s1'], sourceIdsByChannel: { amazon: [] } });
  await waitFor(() => service2.snapshot().run.status !== 'running');
  assert.equal(service2.snapshot().run.progress.sourcesTotal, 2);
  assert.deepEqual(drafts2.list({}).items.map((item) => item.buyer).sort(), ['cain', 'jen', 'sharon']);
});

test('一家店失败不影响其它店：失败的记下来，后面的继续跑', async () => {
  const adapter = fakeAdapter({ failStores: ['s1'] });
  const { service, drafts } = makeService(adapter);
  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;

  assert.equal(run.status, 'done');
  assert.equal(run.progress.sourcesFailed, 1);
  assert.equal(run.progress.draftsCreated, 1);
  const failed = run.sources.find((store) => store.storeId === 's1');
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /打不开店铺 s1/);
  assert.equal(drafts.list({}).items[0].buyer, 'sharon');
});

test('收件箱没加载出来（未登录）算这家店失败，而不是静默成功', async () => {
  const adapter = fakeAdapter({ inboxReady: false });
  const { service } = makeService(adapter);
  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;
  assert.equal(run.progress.sourcesFailed, 2);
  assert.match(run.sources[0].error, /未登录/);
});

test('重复巡逻不产生重复草稿：第二次是更新', async () => {
  const adapter = fakeAdapter();
  const { service, drafts } = makeService(adapter);

  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const firstRun = service.snapshot().run;
  assert.equal(firstRun.progress.draftsCreated, 3);

  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const secondRun = service.snapshot().run;
  assert.equal(secondRun.progress.draftsCreated, 0);
  assert.equal(secondRun.progress.draftsUpdated, 3);
  assert.equal(drafts.counts().total, 3, '总数不变');
});

test('只巡逻选中的店铺', async () => {
  const adapter = fakeAdapter();
  const { service, drafts } = makeService(adapter);
  service.start({ storeIds: ['s2'] });
  await waitFor(() => service.snapshot().run.status !== 'running');
  assert.equal(service.snapshot().run.progress.sourcesTotal, 1);
  assert.deepEqual(drafts.list({}).items.map((item) => item.buyer), ['sharon']);
});

test('没有店铺时立刻正常结束，不算失败', async () => {
  const adapter = fakeAdapter({ stores: [] });
  const { service } = makeService(adapter);
  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;
  assert.equal(run.status, 'done');
  assert.equal(run.progress.sourcesTotal, 0);
});

test('人工改过的草稿：巡逻重新生成时不覆盖正文，单独计数', async () => {
  const adapter = fakeAdapter();
  const { service, drafts } = makeService(adapter);

  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const first = drafts.list({}).items.find((item) => item.buyer === 'cain');
  drafts.patch(first.id, { body: '人手改过的正文' });

  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;
  // 只有被人工改过的那一条受保护；另两条没人动过，照常刷新。
  assert.equal(run.progress.draftsPreserved, 1);
  assert.equal(run.progress.draftsUpdated, 2);
  assert.equal(drafts.get(first.id).body, '人手改过的正文');
});

test('autoFillAmazon：只填不发送，并把草稿标成已填入', async () => {
  const adapter = fakeAdapter();
  adapter.fillOpenConversation = async (store, text) => {
    adapter.calls.push(['fillOpenConversation', store.storeId, text.slice(0, 20)]);
    return { filled: true, length: text.length };
  };
  const { service, drafts } = makeService(adapter);

  // 明确关掉时不填。
  service.start({ autoFillAmazon: false });
  await waitFor(() => service.snapshot().run.status !== 'running');
  assert.equal(adapter.calls.filter((call) => call[0] === 'fillOpenConversation').length, 0);
  assert.equal(service.snapshot().run.progress.autoFilled, 0);
  assert.equal(drafts.list({}).items.every((item) => item.status === 'draft'), true, '关掉时不该改动状态');

  // 打开后每条都填。
  service.start({ autoFillAmazon: true });
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;
  assert.equal(run.progress.autoFilled, 3);
  const filled = adapter.calls.filter((call) => call[0] === 'fillOpenConversation');
  assert.equal(filled.length, 3);
  // 只填草稿正文，链路里没有任何发送动作。
  assert.equal(/send|发送/i.test(JSON.stringify(adapter.calls)), false);
  assert.equal(drafts.list({ status: 'filled' }).total, 3, '填过的草稿状态应为 filled');
});

test('autoFillAmazon：填入的是库里的正文，不是刚生成的这一份', async () => {
  const adapter = fakeAdapter();
  const filledTexts = [];
  adapter.fillOpenConversation = async (store, text) => {
    filledTexts.push(text);
    return { filled: true, length: text.length };
  };
  const { service, drafts } = makeService(adapter);

  service.start({ autoFillAmazon: true });
  await waitFor(() => service.snapshot().run.status !== 'running');

  // 人工改一条，再跑一次：库里保留了人工版，浏览器里也必须填人工版。
  const cain = drafts.list({}).items.find((item) => item.buyer === 'cain');
  drafts.patch(cain.id, { body: '人手改过的正文' });
  filledTexts.length = 0;

  service.start({ autoFillAmazon: true });
  await waitFor(() => service.snapshot().run.status !== 'running');
  assert.ok(filledTexts.includes('人手改过的正文'), '填入的应是库里保留的人工版本');
});

test('同时只能跑一次巡逻', async () => {
  const adapter = fakeAdapter();
  const { service } = makeService(adapter);
  service.start({});
  assert.throws(() => service.start({}), PatrolError);
  await waitFor(() => service.snapshot().run.status !== 'running');
});

test('stop：在不该跑的时候调用是安全的', () => {
  const adapter = fakeAdapter();
  const { service } = makeService(adapter);
  assert.deepEqual(service.stop(), { stopped: false, id: null });
});

test('巡逻状态落盘到 run/patrol-last.json，且不含草稿正文', async () => {
  const adapter = fakeAdapter();
  const { service, dir } = makeService(adapter);
  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const file = path.join(dir, 'run', 'patrol-last.json');
  assert.ok(fs.existsSync(file));
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.status, 'done');
  assert.equal(saved.sources.length, 2);
  assert.equal(/Hello/.test(JSON.stringify(saved)), false, '摘要里不能出现草稿正文');
});

test('巡逻参数来自 settings.patrol，并被单次请求覆盖', async () => {
  const adapter = fakeAdapter();
  const { service } = makeService(adapter, { patrol: { maxPerStore: 1, maxStores: 0, closeAfter: true } });
  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;
  assert.equal(run.options.maxPerStore, 1);
  assert.equal(run.options.closeAfter, true);
  assert.equal(adapter.calls.filter((call) => call[0] === 'closeStore').length, 2);
});

test('单渠道重新扫描：只碰指定渠道，且 closeAfter=false 时一个浏览器都不关', async () => {
  const adapter = fakeAdapter();
  const other = { ...fakeAdapter(), id: 'lark-mail', label: '飞书邮箱' };
  const { service } = makeService(adapter, {}, { 'lark-mail': other });
  // 巡逻页每个渠道右边的「重新扫描」就是这么发的：限定渠道 + 强制 closeAfter=false。
  service.start({ channels: ['amazon'], closeAfter: false });
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;
  assert.deepEqual(run.options.channels, ['amazon']);
  assert.equal(run.options.closeAfter, false);
  assert.ok(adapter.calls.length > 0, '指定渠道要真的跑起来');
  assert.equal(other.calls.length, 0, '没指定的渠道一次都不该碰');
  assert.equal(
    adapter.calls.filter((call) => call[0] === 'closeStore').length,
    0,
    'closeAfter=false 时不能关浏览器：草稿还在回复框里等着人工核对',
  );
});

/* ── 巡逻前的登录预检（task-7） ───────────────────────────────────────────────
 * 一次巡逻不该因为某家店没登录就全废，也不该跑到一半报一句含糊的「收件箱没加载出来」。
 * 三条不许含糊的规则：
 *   1. 只把明确读到登录页判成「未登录」；地址读不出来（failed）时放行，让巡逻自己报真因。
 *   2. 预检抛错绝不能连累巡逻。
 *   3. 跳过要写 status/reason 并单独计数（sourcesSkippedAuth），**不是** sourcesFailed。
 * ─────────────────────────────────────────────────────────────────────────── */

/** 在假适配器上加一个可控的登录面。 */
function withLogin(adapter, map, opts = {}) {
  adapter.calls = adapter.calls ?? [];
  adapter.loginCalls = [];
  adapter.checkLogin = async (store) => {
    adapter.loginCalls.push(['checkLogin', store.storeId]);
    if (opts.throwOnCheck) throw new Error('探测炸了');
    const entry = map[store.storeId] ?? { state: 'logged_in', url: 'https://seller.example/chat/inbox' };
    return { ...entry, loggedIn: entry.state === 'logged_in', hint: entry.hint ?? '' };
  };
  adapter.openLogin = async (store) => {
    adapter.calls.push(['openLogin', store.storeId]);
    const entry = map[store.storeId] ?? { state: 'logged_in' };
    return { ...entry, title: 'T' };
  };
  adapter.waitForLogin = async () => ({ state: 'logged_in', waitedMs: 0, url: '', attempts: 1, hint: '' });
  return adapter;
}

test('登录预检：未登录的店被跳过（不是失败），已登录的照跑', async () => {
  const adapter = withLogin(fakeAdapter(), {
    s1: { state: 'login_required', url: 'https://seller.tiktokshopglobalselling.com/account/login', hint: '请登录' },
  });
  const { service } = makeService(adapter);

  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;

  const skipped = run.sources.find((source) => source.storeId === 's1');
  assert.equal(skipped.status, 'skipped', '未登录是「跳过」，不是「失败」');
  assert.equal(skipped.reason, '未登录，请先点「登录」');
  assert.equal(skipped.auth.state, 'login_required');
  assert.equal(skipped.drafts, 0);
  assert.equal(skipped.note, '请登录', '适配器给的 hint 要带上，界面直接可照做');

  // 跳过 ≠ 失败：失败计数保持 0，否则界面上会出现一条不存在的「故障」。
  assert.equal(run.progress.sourcesSkippedAuth, 1);
  assert.equal(run.progress.sourcesFailed, 0);
  assert.equal(run.progress.errors, 0);
  assert.equal(run.progress.sourcesDone, 2, '跳过也算办完了，进度条要往前走');
  assert.equal(run.progress.sourcesTotal, 2);

  // 已登录那家照常跑完，草稿也照常出。
  const ok = run.sources.find((source) => source.storeId === 's2');
  assert.equal(ok.status, 'ok');
  assert.equal(ok.drafts, 1);
  assert.equal(run.progress.draftsCreated, 1);

  // 跳过的店连店铺窗口都不该开：没登录时开它什么也读不到，只会白等一次超时。
  assert.equal(adapter.calls.some((call) => call[0] === 'openStore' && call[1] === 's1'), false);
  assert.equal(adapter.calls.some((call) => call[0] === 'visitInbox' && call[1] === 's1'), false);
  assert.deepEqual(adapter.loginCalls, [['checkLogin', 's1'], ['checkLogin', 's2']], '每家店先问一句是否登录');
});

test('登录预检：地址读不出来（failed）时放行，让巡逻自己报真因', async () => {
  // 「读不到地址」= 店铺窗口没打开 / CLI 这一跳失败，和「没登录」要人做的事完全不同。
  // 凭一次读不到就把整家店静默跳过，会变成最难查的那种「什么都没发生」。
  const adapter = withLogin(fakeAdapter(), {
    s1: { state: 'failed', url: '', hint: '读不到页面地址' },
  });
  const { service } = makeService(adapter);

  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;

  assert.equal(run.progress.sourcesSkippedAuth, 0, '不许凭「读不到地址」跳过');
  const s1 = run.sources.find((source) => source.storeId === 's1');
  assert.equal(s1.status, 'ok', '放行之后照常跑（假适配器里收件箱是好的）');
  assert.equal(s1.auth.state, 'failed', '但要把探测结果如实记下来');
});

test('登录预检：探测本身抛错绝不影响巡逻', async () => {
  const adapter = withLogin(fakeAdapter(), {}, { throwOnCheck: true });
  const { service, drafts } = makeService(adapter);

  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;

  assert.equal(run.status, 'done');
  assert.equal(run.progress.sourcesFailed, 0, '探测失败不是巡逻失败');
  assert.equal(run.progress.sourcesSkippedAuth, 0);
  assert.equal(run.progress.draftsCreated, 3, '巡逻照常跑完');
  assert.equal(run.sources.every((source) => source.status === 'ok'), true);
  assert.equal(run.sources.every((source) => source.auth === null), true, '探测失败 = 没预检过');
  assert.equal(drafts.counts().total, 3);
});

test('登录预检只对有登录概念的渠道做：没有 checkLogin 的渠道完全不受影响', async () => {
  // 飞书邮箱渠道是纯 API，没有「登录」这回事。用平台名分支早晚会漏，所以走能力探测。
  const mail = { ...fakeAdapter(), id: 'lark-mail', label: '飞书邮箱', draftKind: 'mail' };
  assert.equal(typeof mail.checkLogin, 'undefined', '这个假适配器刻意没有 checkLogin');

  const { service } = makeService(mail);
  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;

  assert.equal(run.status, 'done');
  assert.equal(run.progress.sourcesSkippedAuth, 0, '没有登录概念的渠道不该有任何跳过');
  assert.equal(run.progress.sourcesFailed, 0, '也绝不能因为「没有 checkLogin」报错');
  assert.equal(run.sources.every((source) => source.status === 'ok'), true);
});

test('已登录但收件箱 0 条 ≠ 失败/漏扫：状态 ok、带一句可读说明', async () => {
  // 实测（2026-10-10）店2 Tiktok-FUSOU-客服KX 登录完全成功，收件箱却只有 16 条已关闭历史，
  // 待处理 0 条。光秃秃一个 conversations:0 看起来和「漏扫了」一模一样。
  const adapter = withLogin(fakeAdapter(), {}, {});
  const { service } = makeService(adapter);
  service.start({ sourceIds: ['s1'] });
  await waitFor(() => service.snapshot().run.status !== 'running');

  // 先把 s1 的会话清空，模拟「登录成功、没有待处理」。假适配器的会话表是闭包里的，
  // 所以这里换一个 listConversations 返回空列表。
  adapter.listConversations = async () => ({ url: 'https://example.test/inbox', items: [], skipped: [] });
  service.start({ sourceIds: ['s1'] });
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;
  const only = run.sources[0];

  assert.equal(only.status, 'ok', '收件箱空不是失败');
  assert.equal(only.conversations, 0);
  assert.equal(only.drafts, 0);
  assert.equal(only.note, '已登录，暂无待处理会话', '要有一句可读说明，别让人以为是漏扫');
  assert.equal(run.progress.sourcesFailed, 0);
  assert.equal(run.progress.sourcesSkippedAuth, 0);
  assert.equal(run.progress.conversationsSeen, 0);
});

test('收件箱里的会话全是自动通知时，说明要区分「跳过了多少」和「真的没有」', async () => {
  const adapter = withLogin(fakeAdapter(), {}, {});
  const { service } = makeService(adapter);
  adapter.listConversations = async () => ({
    url: 'https://example.test/inbox',
    items: [],
    skipped: [{ subject: 'a' }, { subject: 'b' }],
  });
  service.start({ sourceIds: ['s1'] });
  await waitFor(() => service.snapshot().run.status !== 'running');
  const only = service.snapshot().run.sources[0];

  assert.equal(only.status, 'ok');
  assert.equal(only.skipped, 2);
  assert.match(only.note, /自动通知/);
});

test('closeAfter：被跳过的店不关（它连窗口都没开过）', async () => {
  const adapter = withLogin(fakeAdapter(), {
    s1: { state: 'login_required', url: 'https://seller.example/login' },
  });
  const { service } = makeService(adapter);
  service.start({ closeAfter: true });
  await waitFor(() => service.snapshot().run.status !== 'running');

  const closed = adapter.calls.filter((call) => call[0] === 'closeStore').map((call) => call[1]);
  assert.deepEqual(closed, ['s2'], '只关真正开过的店');
});

test('巡逻结果与落盘摘要里都能看到「未登录被跳过」这件事', async () => {
  const adapter = withLogin(fakeAdapter(), {
    s1: { state: 'login_required', url: 'https://seller.example/login' },
  });
  const { service, dir } = makeService(adapter);
  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');

  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'run', 'patrol-last.json'), 'utf8'));
  const s1 = saved.sources.find((source) => source.storeId === 's1');
  assert.equal(s1.status, 'skipped', '重启后回查历史也要看得出「那天没扫这家店」');
  assert.equal(s1.reason, '未登录，请先点「登录」');
  assert.equal(saved.progress.sourcesSkippedAuth, 1);
});

test('正在等登录的店，巡逻直接跳过（不重复探测一次页面）', async () => {
  // 人刚点了「登录」，浏览器正摆在登录页上。这时候启动巡逻既不该去碰那家店，
  // 也不该再探测一次（探测要打一次页面，纯属浪费）。
  const adapter = withLogin(fakeAdapter(), {});
  const loginState = createLoginService({ adapters: { amazon: adapter } });
  loginState.watch('amazon', { storeId: 's1', storeName: 'x' });
  const { service } = makeService(adapter, {}, {}, loginState);

  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;

  const s1 = run.sources.find((source) => source.storeId === 's1');
  assert.equal(s1.status, 'skipped');
  assert.equal(s1.reason, '未登录，请先点「登录」');
  assert.equal(run.progress.sourcesSkippedAuth, 1);
  assert.deepEqual(adapter.loginCalls, [['checkLogin', 's2']], '正在等登录的店不再探测一次');
});

test('createLoginService：内存登录态、同一状态不刷 since、超时不等于失败', async () => {
  let clock = 1000;
  const service = createLoginService({ adapters: {}, now: () => clock });
  assert.deepEqual(service.snapshot(), {});

  service.open; // 存在性
  assert.equal(service.get('s1'), null);
  assert.equal(service.isWaiting('s1'), false);

  // 直接驱动内部记账：走 watch 需要适配器，这里用一个最小的假适配器。
  const adapter = {
    id: 'amazon',
    label: '亚马逊',
    async waitForLogin() {
      return { state: 'timeout', waitedMs: 60_000, url: 'https://seller.example/login', attempts: 3, hint: '还没登完' };
    },
  };
  const svc = createLoginService({ adapters: { amazon: adapter }, now: () => clock });
  clock += 500;
  const settled = await svc.watch('amazon', { storeId: 's1', storeName: 'Amazon-X' });
  assert.equal(settled.state, 'timeout', '超时原样保留');
  assert.equal(settled.storeId, 's1');
  assert.equal(settled.error, null, '超时不是失败：页面还摆在那儿，再点一次就行');
  assert.equal(svc.isWaiting('s1'), false, '等人结束后就不再是「等待中」');
  const since = settled.since;

  clock += 10_000;
  svc.watch('amazon', { storeId: 's1', storeName: 'Amazon-X' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(svc.get('s1').state, 'timeout');
  assert.equal(svc.get('s1').since, since, '同一状态重复记录时 since 不该被刷新');
  assert.equal(svc.snapshot().s1.state, 'timeout', '快照给的是副本');
});

test('createLoginService：渠道没有登录这回事时说清楚，而不是抛错', async () => {
  const svc = createLoginService({ adapters: { 'lark-mail': { id: 'lark-mail', label: '飞书邮箱' } } });
  const entry = await svc.watch('lark-mail', { storeId: 'm@x.com' });
  assert.equal(entry.state, 'failed');
  assert.match(entry.hint, /不用等/);
  // open 是**写动作**，渠道不支持时要给一个能看懂的 400，而不是 500。
  await assert.rejects(() => svc.open('lark-mail', { storeId: 'm@x.com' }), /没有登录这一步/);
  await assert.rejects(() => svc.open('nowhere', { storeId: 'm@x.com' }), /未注册的渠道/);
});

/* ── 自动登录（沃尔玛）：未登录时插件自己点「登录 / 继续」 ─────────────────────
 * 只有导出 supportsAutoLogin + autoLogin 的适配器才会被调用；TikTok 那种没有这个能力的
 * 渠道行为完全不变（照旧跳过、等人手动登录）。
 * ─────────────────────────────────────────────────────────────────────────── */

/** 给假适配器加自动登录能力；autoLogin 的行为由 opts 决定（可注入结果 / 抛错 / 记录调用）。 */
function withAutoLogin(adapter, opts = {}) {
  adapter.autoLoginCalls = [];
  adapter.supportsAutoLogin = true;
  adapter.autoLogin = async (store, callOpts) => {
    adapter.autoLoginCalls.push([store.storeId, callOpts?.url ?? '']);
    if (opts.throws) throw new Error('自动登录炸了');
    if (opts.onCall) return opts.onCall(store, adapter);
    return opts.result ?? { ok: true, attempts: 1, url: 'https://seller.walmart.com/seller-communication/Customer', steps: [], hint: '自动登录成功' };
  };
  return adapter;
}

test('自动登录：支持该能力的渠道未登录时先自动登录，成功后照常巡逻', async () => {
  const states = { s1: { state: 'login_required', url: 'https://login.example/sso', hint: '请登录' } };
  const adapter = withLogin(fakeAdapter(), states);
  withAutoLogin(adapter, {
    // 自动登录成功后，下一次探测要能读到已登录 —— 引擎正是靠**再探一次地址**确认的。
    onCall: (store) => {
      states[store.storeId] = { state: 'logged_in', url: 'https://seller.walmart.com/seller-communication/Customer' };
      return { ok: true, attempts: 1, url: states[store.storeId].url, steps: [], hint: '自动登录成功' };
    },
  });
  const { service } = makeService(adapter);

  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;

  const s1 = run.sources.find((source) => source.storeId === 's1');
  assert.equal(s1.status, 'ok', '自动登录成功后要照常巡逻，而不是跳过');
  assert.equal(s1.drafts, 2, '会话照常生成草稿');
  assert.equal(s1.auth.autoLogin.attempted, true);
  assert.equal(s1.auth.autoLogin.ok, true);
  assert.equal(run.progress.sourcesAutoLoggedIn, 1);
  assert.equal(run.progress.sourcesSkippedAuth, 0, '自动登录成功就不该再有「未登录跳过」');
  assert.equal(run.progress.sourcesFailed, 0, '自动登录是流程的一部分，不是故障');
  assert.deepEqual(adapter.autoLoginCalls.map((call) => call[0]), ['s1'], '只对未登录的那家店自动登录');
});

test('自动登录失败：仍然跳过，note 带上自动登录的原因（不是含糊的「未登录」）', async () => {
  const adapter = withLogin(fakeAdapter(), {
    s1: { state: 'login_required', url: 'https://login.example/sso', hint: '' },
  });
  withAutoLogin(adapter, {
    result: { ok: false, attempts: 12, url: 'https://login.example/sso', steps: [], hint: '自动登录停在 2 步验证：动态验证码没有被自动填入' },
  });
  const { service } = makeService(adapter);

  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;
  const s1 = run.sources.find((source) => source.storeId === 's1');

  assert.equal(s1.status, 'skipped');
  assert.equal(s1.errorKind, 'auth');
  assert.equal(run.progress.sourcesSkippedAuth, 1);
  assert.equal(run.progress.sourcesAutoLoggedIn, 0);
  assert.match(s1.note, /2 步验证/, '要把自动登录卡在哪一步说出来');
  assert.equal(s1.auth.autoLogin.attempted, true);
  assert.equal(s1.auth.autoLogin.ok, false);
  assert.equal(run.progress.sourcesFailed, 0, '自动登录没成也不算失败');
});

test('自动登录：点了按钮但地址仍停在登录页 —— 不许把「点了」当「登录了」', async () => {
  const adapter = withLogin(fakeAdapter(), {
    s1: { state: 'login_required', url: 'https://login.example/sso', hint: '' },
  });
  // autoLogin 自己说成功了，但重新探测仍然是 login_required。
  withAutoLogin(adapter, { result: { ok: true, attempts: 1, url: 'https://seller.example/x', steps: [], hint: '成功' } });
  const { service } = makeService(adapter);

  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;
  const s1 = run.sources.find((source) => source.storeId === 's1');

  assert.equal(s1.status, 'skipped', '地址还没离开登录页就不算成功');
  assert.equal(s1.auth.autoLogin.ok, false);
  assert.match(s1.auth.autoLogin.hint, /仍停在登录页/);
  assert.equal(run.progress.sourcesAutoLoggedIn, 0);
});

test('自动登录：POST /patrol 传 autoLogin=false 时一次都不调用', async () => {
  const adapter = withLogin(fakeAdapter(), { s1: { state: 'login_required', url: 'https://login.example/sso' } });
  withAutoLogin(adapter);
  const { service } = makeService(adapter);

  service.start({ autoLogin: false });
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;

  assert.deepEqual(adapter.autoLoginCalls, [], '关掉之后一次都不许调用');
  assert.equal(run.sources.find((source) => source.storeId === 's1').status, 'skipped');
  assert.equal(run.progress.sourcesSkippedAuth, 1);
  assert.equal(run.options.autoLogin, false);
});

test('自动登录：没有这个能力的渠道（TikTok 那种）完全不受影响', async () => {
  const adapter = withLogin(fakeAdapter(), { s1: { state: 'login_required', url: 'https://login.example/sso' } });
  adapter.autoLogin = async () => {
    throw new Error('没有 supportsAutoLogin 就不该被调用');
  };
  const { service } = makeService(adapter);

  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;
  assert.equal(run.sources.find((source) => source.storeId === 's1').status, 'skipped');
  assert.equal(run.progress.sourcesAutoLoggedIn, 0);
  assert.equal(run.progress.sourcesSkippedAuth, 1);
});

test('自动登录抛错：降级成「未登录跳过」，绝不让巡逻整条炸掉', async () => {
  const adapter = withLogin(fakeAdapter(), { s1: { state: 'login_required', url: 'https://login.example/sso' } });
  withAutoLogin(adapter, { throws: true });
  const { service } = makeService(adapter);

  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;
  const s1 = run.sources.find((source) => source.storeId === 's1');

  assert.equal(run.status, 'done', '巡逻要正常收尾');
  assert.equal(s1.status, 'skipped');
  assert.match(s1.note, /自动登录炸了/);
  assert.equal(run.progress.sourcesFailed, 0);
  // 另一家店照常跑完，不受影响。
  assert.equal(run.sources.find((source) => source.storeId === 's2').status, 'ok');
});
