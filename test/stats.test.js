import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStatsService, median, percentile, ratio, windowDays } from '../lib/stats.js';
import { createAuditStore } from '../lib/store/audit.js';
import { createQueueStore } from '../lib/store/queue.js';

const silent = { warn: () => {} };
const TZ = 'Asia/Shanghai';
/** 固定「现在」：2026-10-04 20:00 北京时间。 */
const NOW = new Date('2026-10-04T12:00:00.000Z');

/**
 * 搭一套带夹具的数据层。
 * @param {{slaHours?: number, now?: Date}} [options] - 配置。
 * @returns {object} 队列、审计、统计与设置。
 */
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-stats-'));
  const settings = {
    timezone: TZ,
    sla: { defaultHours: options.slaHours ?? 24 },
    retention: { auditDays: 30 },
  };
  const audit = createAuditStore({ dir, timezone: TZ, logger: silent });
  const queue = createQueueStore({ file: path.join(dir, 'queue.json'), logger: silent });
  const stats = createStatsService({
    queue,
    audit,
    getSettings: () => settings,
    clock: () => options.now ?? NOW,
    ttlMs: 60_000,
  });
  return { dir, settings, audit, queue, stats };
}

/**
 * 把一条工单推到指定状态。
 * @param {object} queue - 队列。
 * @param {string} id - 工单 id。
 * @param {Array<[string, string]>} steps - `[状态, 时间]` 列表。
 * @returns {object} 最终工单。
 */
function advance(queue, id, steps) {
  let item = queue.get(id);
  for (const [status, at] of steps) item = queue.patch(id, { status }, { now: at });
  return item;
}

test('percentile / median / ratio 的边界：空输入与零分母都返回 null', () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([10], 0.95), 10);
  assert.equal(percentile([10, 20, 30], 0.5), 20);
  assert.equal(percentile([10, 20, 30], 0.95), 30);
  assert.equal(median([]), null);
  assert.equal(median([1, 3]), 2);
  assert.equal(median([1, 2, 100]), 2);
  assert.equal(ratio(0, 0), null, '零分母必须是 null 而不是 0（UI 显示「—」）');
  assert.equal(ratio(1, 3), 0.333);
  assert.equal(ratio(3, 3), 1);
});

test('windowDays 给出连续的本地日，且跨时区正确', () => {
  const win = windowDays({ days: 3, timezone: TZ, now: NOW });
  assert.deepEqual(win.days, ['2026-10-02', '2026-10-03', '2026-10-04']);
  assert.equal(win.from, '2026-10-02');
  assert.equal(win.to, '2026-10-04');
  // 同一时刻在 UTC 下是 10-04 20:00，不跨日；在纽约是 10-04 08:00。
  assert.equal(windowDays({ days: 1, timezone: 'UTC', now: NOW }).to, '2026-10-04');
  // 北京时间 2026-10-05 01:30 时，UTC 仍是 10-04。
  const late = new Date('2026-10-04T17:30:00.000Z');
  assert.equal(windowDays({ days: 1, timezone: TZ, now: late }).to, '2026-10-05');
  assert.equal(windowDays({ days: 1, timezone: 'UTC', now: late }).to, '2026-10-04');
});

test('没有任何数据时：业务组 hasData=false、所有计数为 0、运行组也是 0', () => {
  const { stats } = fixture();
  const value = stats.compute({ days: 14 });
  assert.equal(value.business.hasData, false);
  assert.equal(value.business.total, 0);
  assert.equal(value.business.byStatus.new, 0);
  assert.equal(value.business.sla.onTimeRate, null, '零分母 → null');
  assert.equal(value.business.sla.medianFirstResponseMs, null);
  assert.equal(value.runtime.cli.total, 0);
  assert.equal(value.runtime.cli.successRate, null);
  assert.equal(value.runtime.detect.lastOk, null);
  assert.equal(value.runtime.series.length, 14);
  assert.equal(value.window.today, '2026-10-04');
  assert.equal(value.window.timezone, TZ);
});

test('业务口径：今日、按渠道类型负责人分布、SLA 超时与按时率、首次响应中位数', () => {
  const { queue, stats } = fixture();

  // t1：今天收到、1 小时后回复并发送 → 按时
  const t1 = queue.create({
    subject: '物流查询',
    channel: 'mail',
    kind: 'message',
    receivedAt: '2026-10-04T02:00:00.000Z',
    assignee: '张三',
  }).item;
  advance(queue, t1.id, [
    ['drafted', '2026-10-04T03:00:00.000Z'],
    ['approved', '2026-10-04T03:00:00.000Z'],
    ['sending', '2026-10-04T03:00:00.000Z'],
    ['sent', '2026-10-04T03:00:00.000Z'],
  ]);

  // t2：昨天收到、仍未处理 → 超时
  queue.create({
    subject: '差评回复',
    channel: 'tiktok',
    kind: 'review',
    receivedAt: '2026-10-03T02:00:00.000Z',
    assignee: '李四',
  });

  // t3：10-01 收到、10-03 才处理 → 迟到（首次响应 2 天）
  const t3 = queue.create({
    subject: '退款申请',
    channel: 'walmart',
    kind: 'afterSales',
    receivedAt: '2026-10-01T00:00:00.000Z',
  }).item;
  advance(queue, t3.id, [
    ['drafted', '2026-10-03T00:00:00.000Z'],
    ['approved', '2026-10-03T00:00:00.000Z'],
    ['sending', '2026-10-03T00:00:00.000Z'],
    ['sent', '2026-10-03T00:00:00.000Z'],
  ]);

  const { business } = stats.compute({ days: 14 });
  assert.equal(business.hasData, true);
  assert.equal(business.total, 3);
  assert.equal(business.byChannel.mail, 1);
  assert.equal(business.byChannel.tiktok, 1);
  assert.equal(business.byChannel.walmart, 1);
  assert.equal(business.byKind.afterSales, 1);
  assert.equal(business.byStatus.sent, 2);
  assert.equal(business.byStatus.new, 1);
  assert.deepEqual(
    business.byAssignee.map((entry) => entry.name).sort(),
    ['张三', '李四', '未分派'].sort(),
  );

  assert.deepEqual(business.today, { created: 1, sent: 1, drafted: 1, needsHuman: 0 });

  assert.equal(business.sla.overdue, 1, '只有 t2 超时');
  assert.equal(business.sla.onTimeRate, 0.5, '2 条已发送里 1 条按时');
  assert.equal(business.sla.medianFirstResponseMs, 88_200_000, '1 小时与 2 天的中位数');
  assert.equal(business.sla.defaultHours, 24);

  const series = Object.fromEntries(business.series.map((entry) => [entry.day, entry]));
  assert.equal(series['2026-10-01'].created, 1);
  assert.equal(series['2026-10-03'].created, 1);
  assert.equal(series['2026-10-03'].sent, 1);
  assert.equal(series['2026-10-04'].created, 1);
  assert.equal(series['2026-10-04'].sent, 1);
});

test('SLA 用工单自带的 slaDueAt 覆盖默认时长', () => {
  const { queue, stats } = fixture();
  queue.create({
    subject: '急单',
    receivedAt: '2026-10-04T02:00:00.000Z',
    slaDueAt: '2026-10-05T02:00:00.000Z',
  });
  const { business } = stats.compute({ days: 7 });
  assert.equal(business.sla.overdue, 0, '虽然默认 24h 会判超时，但自带截止时间未到');
});

test('运行口径：CLI 次数/成功率/耗时分布/错误类型/体检历史', () => {
  const { audit, stats } = fixture();
  const at = (time) => `2026-10-04T${time}.000Z`;
  audit.append({ at: at('01:00:00'), kind: 'cli', name: 'lark', ok: true, durationMs: 300 });
  audit.append({ at: at('01:01:00'), kind: 'cli', name: 'lark', ok: true, durationMs: 100 });
  audit.append({ at: at('01:02:00'), kind: 'cli', name: 'lark', ok: false, errorKind: 'auth', durationMs: 400 });
  audit.append({ at: at('01:03:00'), kind: 'cli', name: 'ziniao', ok: true, durationMs: 200 });
  audit.append({ at: '2026-10-03T01:00:00.000Z', kind: 'detect', name: 'detect', ok: true });
  audit.append({ at: at('01:04:00'), kind: 'detect', name: 'detect', ok: false, errorKind: 'auth' });

  const { runtime } = stats.compute({ days: 14 });
  assert.equal(runtime.cli.total, 4);
  assert.equal(runtime.cli.ok, 3);
  assert.equal(runtime.cli.fail, 1);
  assert.equal(runtime.cli.successRate, 0.75);
  assert.equal(runtime.cli.latency.p50, 200);
  assert.equal(runtime.cli.latency.p95, 400);

  const lark = runtime.cli.byName.find((entry) => entry.name === 'lark');
  assert.equal(lark.total, 3);
  assert.equal(lark.fail, 1);
  assert.equal(lark.successRate, 0.667);
  assert.equal(lark.p50, 300);
  assert.deepEqual(runtime.cli.byErrorKind, [{ kind: 'auth', count: 1 }]);

  assert.equal(runtime.detect.runs, 2);
  assert.equal(runtime.detect.lastOk, false);
  assert.equal(runtime.detect.consecutiveFail, 1, '最后一条是失败，连续失败 1 次');

  const series = Object.fromEntries(runtime.series.map((entry) => [entry.day, entry]));
  assert.equal(series['2026-10-04'].cli, 4);
  assert.equal(series['2026-10-04'].cliFail, 1);
  assert.equal(series['2026-10-03'].cli, 0);
});

test('窗口外的审计事件不计入', () => {
  const { audit, stats } = fixture();
  audit.append({ at: '2026-08-01T00:00:00.000Z', kind: 'cli', name: 'lark', ok: true, durationMs: 10 });
  audit.append({ at: '2026-10-04T00:00:00.000Z', kind: 'cli', name: 'lark', ok: true, durationMs: 10 });
  assert.equal(stats.compute({ days: 7 }).runtime.cli.total, 1);
});

test('统计有 60 秒缓存，写操作后 invalidate 会立刻重算', () => {
  const { queue, stats } = fixture();
  const first = stats.compute({ days: 7 });
  assert.equal(stats.compute({ days: 7 }), first, '同一窗口命中缓存返回同一个对象');

  queue.create({ subject: '新增一条' });
  assert.equal(stats.compute({ days: 7 }), first, '没有 invalidate 时仍是旧对象');

  stats.invalidate();
  const after = stats.compute({ days: 7 });
  assert.notEqual(after, first);
  assert.equal(after.business.total, 1);

  assert.notEqual(stats.compute({ days: 30 }), after, '不同窗口是不同缓存键');
});

test('天数参数非法时退回 14 天', () => {
  const { stats } = fixture();
  assert.equal(stats.compute({ days: 0 }).window.days, 14);
  assert.equal(stats.compute({ days: -5 }).window.days, 14);
  assert.equal(stats.compute({}).window.days, 14);
});
