import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DRAFT_STATUSES, DraftError, createDraftStore } from '../lib/store/drafts.js';

const silent = { warn: () => {} };

/** 建一个带可控时钟的草稿库。 */
function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-drafts-'));
  let now = new Date('2026-10-06T02:00:00.000Z');
  const store = createDraftStore({ dir, logger: silent, clock: () => now });
  return {
    store,
    dir,
    tick(ms = 1000) {
      now = new Date(now.getTime() + ms);
    },
  };
}

/** 一条最简草稿输入。 */
const sample = (over = {}) => ({
  platform: 'amazon',
  storeId: '27630232762680',
  storeName: 'Amazon-Cozynome-管理员',
  caseId: 'case-1',
  buyer: 'cain',
  subject: 'Damaged or defective item',
  orderId: '113-9341386-0505001',
  intent: 'replacement',
  intentLabel: '换货 / 补件',
  body: 'Hello Cain,\n\nWe will send a replacement.',
  ...over,
});

test('upsert：新建后落盘，并额外写一份纯文本副本', () => {
  const { store, dir } = makeStore();
  const result = store.upsert(sample());
  assert.equal(result.created, true);
  assert.equal(store.counts().total, 1);
  assert.equal(store.rev, 1);

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'drafts.json'), 'utf8'));
  assert.equal(onDisk.items.length, 1);
  assert.equal(onDisk.rev, 1);

  const textFile = path.join(dir, `${result.item.id}.txt`);
  assert.ok(fs.existsSync(textFile), '应该写一份可读副本');
  assert.match(fs.readFileSync(textFile, 'utf8'), /We will send a replacement/);
});

test('upsert：同一个 caseId 只保留一条，重复巡逻是「更新」不是「新增」', () => {
  const { store } = makeStore();
  const first = store.upsert(sample());
  const second = store.upsert(sample({ body: 'Hello Cain,\n\nUpdated draft.' }));
  assert.equal(second.created, false);
  assert.equal(second.item.id, first.item.id);
  assert.equal(store.counts().total, 1);
  assert.match(store.get(first.item.id).body, /Updated draft/);
  assert.equal(store.get(first.item.id).timeline.at(-1).action, 'regenerated');
});

test('upsert：同一个 caseId 出现在多个店铺（同一账号的管理员/客服条目）时只留一条', () => {
  const { store } = makeStore();
  // 紫鸟里同一个亚马逊账号常常登记成多条店铺，它们看到的是同一批会话。
  const first = store.upsert(sample({ storeId: 'store-admin', storeName: 'Amazon-FUSOU-管理员' }));
  const second = store.upsert(sample({ storeId: 'store-cs', storeName: 'Amazon-FUSOU-客服' }));
  assert.equal(second.created, false, '跨店铺的同 caseId 应该是更新，不是新增');
  assert.equal(second.item.id, first.item.id);
  assert.equal(store.counts().total, 1);
  assert.equal(store.get(first.item.id).dedupeKey, 'amazon:case:case-1');
});

test('upsert：历史上因去重键带 storeId 而留下的重复会被自动合并', () => {
  const { store, dir } = makeStore();
  store.upsert(sample({ storeId: 'a' }));
  // 手工塞一条「老格式」的重复记录，模拟早期版本留下的数据。
  const doc = JSON.parse(fs.readFileSync(path.join(dir, 'drafts.json'), 'utf8'));
  doc.items.push({
    id: 'd_legacy',
    dedupeKey: 'amazon:b:case-1',
    caseId: 'case-1',
    storeId: 'b',
    body: 'legacy',
    status: 'draft',
    timeline: [],
  });
  fs.writeFileSync(path.join(dir, 'drafts.json'), JSON.stringify(doc), 'utf8');
  store.invalidate();

  const result = store.upsert(sample({ storeId: 'b' }));
  assert.equal(result.item.id, doc.items[0].id, '保留最早那条');
  assert.equal(store.counts().total, 1, '重复被合并掉');
});

test('upsert：没有 caseId 时退化成 店铺+订单号+买家+主题 的去重键', () => {
  const { store } = makeStore();
  store.upsert(sample({ caseId: '' }));
  store.upsert(sample({ caseId: '', subject: '另一个主题' }));
  assert.equal(store.counts().total, 2);
});

test('upsert：空正文被拒绝', () => {
  const { store } = makeStore();
  assert.throws(() => store.upsert(sample({ body: '   ' })), DraftError);
});

test('list：按店铺/意图/状态/需人工/关键字筛选，并按到期紧急度排序', () => {
  const { store } = makeStore();
  store.upsert(sample({ caseId: 'a', dueMinutes: 300, buyer: 'jen' }));
  store.upsert(sample({ caseId: 'b', dueMinutes: 12, buyer: 'cain', needsHuman: true }));
  store.upsert(sample({ caseId: 'c', storeId: 'other', storeName: 'Amazon-FUSOU-管理员', intent: 'refund', dueMinutes: null, buyer: 'sharon' }));

  assert.equal(store.list({}).total, 3);
  assert.equal(store.list({ storeId: '27630232762680' }).total, 2);
  assert.equal(store.list({ intent: 'refund' }).total, 1);
  assert.equal(store.list({ needsHuman: true }).total, 1);
  assert.equal(store.list({ q: 'sharon' }).total, 1);

  // 最紧急的排最前，没有到期信息的排最后。
  assert.deepEqual(store.list({}).items.map((item) => item.buyer), ['cain', 'jen', 'sharon']);
});

test('facets：给出可筛选的店铺/邮箱清单，且**不受当前筛选影响**', () => {
  const { store } = makeStore();
  store.upsert(sample({ caseId: 'a', storeId: 'st1', storeName: 'Amazon-Cozynome-管理员' }));
  store.upsert(sample({ caseId: 'b', storeId: 'st1', storeName: 'Amazon-Cozynome-管理员' }));
  store.upsert(sample({ caseId: 'c', platform: 'lark-mail', storeId: 'support@fusou.vip', storeName: 'support@fusou.vip' }));

  const all = store.list({});
  assert.deepEqual(
    all.facets.stores.map((facet) => `${facet.platform}/${facet.storeId}:${facet.total}`),
    ['amazon/st1:2', 'lark-mail/support@fusou.vip:1'],
  );

  // 关键：按店铺筛完之后，下拉里的选项不能跟着缩水，否则等于换不了店铺。
  const filtered = store.list({ storeId: 'st1' });
  assert.equal(filtered.total, 2);
  assert.equal(filtered.facets.stores.length, 2, '筛选后选项仍是全集');
  assert.equal(filtered.facets.stores.find((facet) => facet.storeId === 'support@fusou.vip').total, 1);
});

test('counts：给出状态、意图、店铺分布与需人工数', () => {
  const { store } = makeStore();
  store.upsert(sample({ caseId: 'a' }));
  store.upsert(sample({ caseId: 'b', needsHuman: true }));
  const counts = store.counts();
  assert.equal(counts.total, 2);
  assert.equal(counts.byStatus.draft, 2);
  assert.equal(counts.byIntent.replacement, 2);
  assert.equal(counts.byStore['Amazon-Cozynome-管理员'], 2);
  assert.equal(counts.needsHuman, 1);
});

test('upsert：人工改过/批过/填过的草稿，巡逻重新生成时不覆盖正文', () => {
  const { store } = makeStore();
  const first = store.upsert(sample({ body: '机器生成的初稿' }));

  // 人改过正文
  store.patch(first.item.id, { body: '人手改过的正文' });
  const rerun = store.upsert(sample({ body: '巡逻又生成了一版' }));
  assert.equal(rerun.created, false);
  assert.equal(rerun.preserved, true);
  assert.equal(store.get(first.item.id).body, '人手改过的正文', '不能把人工修改冲掉');
  assert.match(store.get(first.item.id).timeline.at(-1).detail, /保留人工版本/);

  // 只是被巡逻重新生成过（没人动过）的，仍然允许刷新正文
  const second = store.upsert(sample({ caseId: 'case-2', body: 'v1' }));
  store.upsert(sample({ caseId: 'case-2', body: 'v2' }));
  assert.equal(store.get(second.item.id).body, 'v2');
});

test('upsert：标记为已批准/已填入的草稿同样受保护', () => {
  const { store } = makeStore();
  const { item } = store.upsert(sample({ body: '初稿' }));
  store.patch(item.id, { status: 'approved' });
  const rerun = store.upsert(sample({ body: '新一版' }));
  assert.equal(rerun.preserved, true);
  assert.equal(store.get(item.id).body, '初稿');
  assert.equal(store.get(item.id).status, 'approved');
});

test('patch：改正文/状态，状态白名单外直接报错', () => {
  const { store, tick } = makeStore();
  const { item } = store.upsert(sample());
  tick();
  const edited = store.patch(item.id, { body: 'Hello Cain,\n\nRewritten.' });
  assert.match(edited.body, /Rewritten/);
  assert.equal(edited.timeline.at(-1).action, 'edited');

  const approved = store.patch(item.id, { status: 'approved' });
  assert.equal(approved.status, 'approved');
  assert.ok(DRAFT_STATUSES.includes('approved'));

  assert.throws(() => store.patch(item.id, { status: 'sent' }), DraftError);
  assert.throws(() => store.patch(item.id, { body: '  ' }), DraftError);
  assert.throws(() => store.patch('nope', { body: 'x' }), DraftError);
});

test('patch：乐观锁冲突返回带 currentRev 的 409 类错误', () => {
  const { store } = makeStore();
  const { item } = store.upsert(sample());
  store.patch(item.id, { status: 'approved' });
  let error = null;
  try {
    store.patch(item.id, { status: 'discarded' }, { expectedRev: 0 });
  } catch (cause) {
    error = cause;
  }
  assert.ok(error instanceof DraftError);
  assert.equal(error.status, 409);
});

test('草稿库损坏时退化为空库，而不是让插件起不来', () => {
  const { store, dir } = makeStore();
  store.upsert(sample());
  fs.writeFileSync(path.join(dir, 'drafts.json'), '{不是 JSON', 'utf8');
  store.invalidate();
  assert.equal(store.counts().total, 0);
  assert.doesNotThrow(() => store.upsert(sample({ caseId: 'x' })));
});

test('rev 每次写入递增', () => {
  const { store } = makeStore();
  assert.equal(store.rev, 0);
  store.upsert(sample());
  assert.equal(store.rev, 1);
  store.upsert(sample({ caseId: 'y' }));
  assert.equal(store.rev, 2);
});
