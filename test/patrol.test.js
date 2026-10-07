import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { PatrolError, createPatrolService, normalizePatrolOptions } from '../lib/patrol.js';
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
function makeService(adapter, settings = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-patrol-'));
  const drafts = createDraftStore({ dir: path.join(dir, 'drafts'), logger: silent });
  const queue = createQueueStore({ file: path.join(dir, 'queue.json'), logger: silent });
  const service = createPatrolService({
    adapters: { [adapter.id]: adapter },
    drafts,
    queue,
    settings,
    logger: silent,
    stateFile: path.join(dir, 'run', 'patrol-last.json'),
  });
  return { service, drafts, queue, dir };
}

test('normalizePatrolOptions：收敛数值、渠道与目标 id', () => {
  const defaults = { maxStores: 0, maxPerStore: 3, headless: false, closeAfter: false, channels: [], writeMailDrafts: false };
  assert.deepEqual(normalizePatrolOptions({ maxPerStore: 999, sourceIds: ['a', '', ' b '] }, defaults), {
    maxStores: 0,
    maxPerStore: 50,
    headless: false,
    closeAfter: false,
    channels: [],
    writeMailDrafts: false,
    sourceIds: ['a', 'b'],
  });
  // 旧前端字段名 storeIds 仍然认。
  assert.deepEqual(normalizePatrolOptions({ storeIds: ['x'] }, defaults).sourceIds, ['x']);
  assert.deepEqual(normalizePatrolOptions({ channels: ['amazon', 'lark-mail'] }, defaults).channels, ['amazon', 'lark-mail']);
  assert.equal(normalizePatrolOptions({ maxStores: -5 }, defaults).maxStores, 0);
  assert.equal(normalizePatrolOptions({}, defaults).maxPerStore, 3);
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
  const { service } = makeService(adapter, { patrol: { maxPerStore: 1, headless: true, maxStores: 0, closeAfter: true } });
  service.start({});
  await waitFor(() => service.snapshot().run.status !== 'running');
  const run = service.snapshot().run;
  assert.equal(run.options.maxPerStore, 1);
  assert.equal(run.options.headless, true);
  assert.equal(run.options.closeAfter, true);
  assert.equal(adapter.calls.filter((call) => call[0] === 'closeStore').length, 2);
});
