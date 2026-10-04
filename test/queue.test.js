import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { QueueError, createQueueStore } from '../lib/store/queue.js';

/** 建一个静默 logger。 */
const silent = { warn: () => {} };

/**
 * 建一个带可控时钟的队列。
 * @param {{startIso?: string}} [options] - 起始时间。
 * @returns {object} 队列存储。
 */
function makeQueue(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-queue-'));
  let now = new Date(options.startIso ?? '2026-10-04T02:00:00.000Z');
  const queue = createQueueStore({
    file: path.join(dir, 'queue.json'),
    logger: silent,
    clock: () => now,
  });
  return {
    queue,
    dir,
    tick(ms = 1000) {
      now = new Date(now.getTime() + ms);
    },
  };
}

test('create 补默认值并写进文件，rev 递增', () => {
  const { queue, dir } = makeQueue();
  assert.deepEqual(queue.load().items, []);
  const { item, deduped } = queue.create({ subject: '订单 123 没发货', from: 'buyer@x.com' });
  assert.equal(deduped, false);
  assert.equal(item.status, 'new');
  assert.equal(item.channel, 'mail', '渠道默认 mail');
  assert.equal(item.kind, 'message');
  assert.equal(item.assignee, null);
  assert.equal(item.attempts, 0);
  assert.equal(item.timeline.length, 1);
  assert.equal(item.timeline[0].action, 'created');
  assert.equal(queue.rev, 1);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'queue.json'), 'utf8'));
  assert.equal(onDisk.items.length, 1);
  assert.equal(onDisk.rev, 1);
});

test('create 校验渠道与类型，subject 不能为空', () => {
  const { queue } = makeQueue();
  assert.throws(() => queue.create({ subject: 'x', channel: 'amazon' }), QueueError);
  assert.throws(() => queue.create({ subject: 'x', kind: 'refund' }), QueueError);
  assert.throws(() => queue.create({ subject: '   ' }), /subject 不能为空/);
});

test('create 用 idempotencyKey 去重，重复提交返回既有条目', () => {
  const { queue } = makeQueue();
  const first = queue.create({ subject: 'a', idempotencyKey: 'k1' });
  const second = queue.create({ subject: 'b', idempotencyKey: 'k1' });
  assert.equal(second.deduped, true);
  assert.equal(second.item.id, first.item.id);
  assert.equal(second.item.subject, 'a');
  assert.equal(queue.counts().total, 1);
});

test('list 支持按状态/渠道/类型/负责人/关键字筛选并给出计数', () => {
  const { queue } = makeQueue();
  queue.create({ subject: '物流查询', channel: 'mail', kind: 'message' });
  queue.create({ subject: '差评回复', channel: 'tiktok', kind: 'review', assignee: '张三' });
  queue.create({ subject: '退款申请', channel: 'walmart', kind: 'afterSales', assignee: '李四' });

  assert.equal(queue.list().total, 3);
  assert.equal(queue.list({ channel: 'tiktok' }).total, 1);
  assert.equal(queue.list({ kind: 'afterSales' }).total, 1);
  assert.equal(queue.list({ assignee: '张三' }).total, 1);
  assert.equal(queue.list({ assignee: '__none__' }).total, 1, '未分派用 __none__ 筛');
  assert.equal(queue.list({ q: '物流' }).total, 1);

  const counts = queue.list().counts;
  assert.equal(counts.byStatus.new, 3);
  assert.equal(counts.byChannel.tiktok, 1);
  assert.equal(counts.byKind.review, 1);
  assert.deepEqual(counts.byAssignee[0], { name: '张三', count: 1 });
  assert.equal(counts.byAssignee.length, 3);

  const paged = queue.list({ limit: 2, offset: 1 });
  assert.equal(paged.items.length, 2);
  assert.equal(paged.total, 3);
});

test('patch 只允许白名单内的状态跃迁，并回传允许值', () => {
  const { queue } = makeQueue();
  const { item } = queue.create({ subject: 'x' });

  assert.throws(
    () => queue.patch(item.id, { status: 'sent' }),
    (error) => {
      assert.equal(error.status, 400);
      assert.deepEqual(error.allowed, ['drafted', 'needs_human', 'archived']);
      return true;
    },
    'new → sent 必须被拒',
  );

  queue.patch(item.id, { status: 'drafted' });
  queue.patch(item.id, { status: 'approved' });
  queue.patch(item.id, { status: 'sending' });
  const sent = queue.patch(item.id, { status: 'sent' });
  assert.equal(sent.status, 'sent');
  assert.ok(sent.sentAt, 'sent 会写 sentAt');
  assert.ok(sent.firstResponseAt, 'sent 会补 firstResponseAt');
  assert.throws(() => queue.patch(item.id, { status: 'new' }), /不允许从/);
});

test('patch 用 rev 做乐观锁，冲突时报 409', () => {
  const { queue } = makeQueue();
  const { item } = queue.create({ subject: 'x' });
  const staleRev = queue.rev;
  queue.patch(item.id, { note: '先改一次' });
  assert.throws(
    () => queue.patch(item.id, { note: '基于旧版本再改' }, { expectedRev: staleRev }),
    (error) => {
      assert.equal(error.status, 409);
      assert.equal(error.currentRev, queue.rev);
      return true;
    },
  );
  // 用最新 rev 就能成功。
  assert.doesNotThrow(() => queue.patch(item.id, { note: 'ok' }, { expectedRev: queue.rev }));
});

test('patch 记录 timeline：状态、改派、备注', () => {
  const { queue, tick } = makeQueue();
  const { item } = queue.create({ subject: 'x' });
  tick();
  queue.patch(item.id, { status: 'drafted' });
  tick();
  queue.patch(item.id, { assignee: '张三' });
  tick();
  queue.patch(item.id, { note: '已联系买家' });
  tick();
  queue.patch(item.id, { assignee: null });

  const actions = item.timeline.map((entry) => entry.action);
  assert.deepEqual(actions, ['created', 'status', 'assign', 'note', 'assign']);
  assert.equal(item.timeline[2].detail, '未分派 → 张三');
  assert.equal(item.timeline[4].detail, '张三 → 未分派');
  assert.equal(item.timeline.at(-1).by, 'operator');
});

test('patch 对不存在的工单报 404', () => {
  const { queue } = makeQueue();
  assert.throws(() => queue.patch('q_nope', { note: 'x' }), (error) => error.status === 404);
  assert.equal(queue.get('q_nope'), undefined);
});

test('patch 无实际变化时不写盘、不推进 rev', () => {
  const { queue } = makeQueue();
  const { item } = queue.create({ subject: 'x' });
  const rev = queue.rev;
  queue.patch(item.id, { assignee: null, note: '   ' });
  assert.equal(queue.rev, rev);
});

test('文件不存在时视为空队列；文件损坏时退化为空并告警', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-queue-'));
  const file = path.join(dir, 'queue.json');
  const warnings = [];
  const queue = createQueueStore({ file, logger: { warn: (message) => warnings.push(message) } });
  assert.deepEqual(queue.load().items, []);

  fs.writeFileSync(file, '{ broken', 'utf8');
  queue.invalidate();
  assert.deepEqual(queue.load().items, []);
  assert.match(warnings.at(-1), /队列文件损坏/);

  // 外部手改也能被读出来（mtime 变化后重新加载）。
  fs.writeFileSync(file, JSON.stringify({ version: 1, rev: 9, items: [] }), 'utf8');
  queue.invalidate();
  assert.equal(queue.rev, 9);
});
