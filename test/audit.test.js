import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clampDetail, createAuditStore, dayKey } from '../lib/store/audit.js';

/** 建一个一次性数据目录。 */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-audit-'));
}

/** 建一个静默 logger。 */
const silent = { warn: () => {}, info: () => {}, error: () => {} };

test('dayKey 按指定时区算本地日，跨零点要换日', () => {
  const at = '2026-10-04T17:30:00.000Z';
  assert.equal(dayKey(at, 'UTC'), '2026-10-04');
  assert.equal(dayKey(at, 'Asia/Shanghai'), '2026-10-05');
  assert.equal(dayKey(at, 'America/New_York'), '2026-10-04');
});

test('dayKey 对无效时间抛错，避免把 NaN 写进文件名', () => {
  assert.throws(() => dayKey('not-a-date', 'UTC'), /无效时间/);
});

test('clampDetail 超过上限就截断并标记', () => {
  assert.equal(clampDetail(null), null);
  assert.deepEqual(clampDetail({ a: 1 }, 100), { a: 1 });
  const big = { text: 'x'.repeat(500) };
  const clamped = clampDetail(big, 100);
  assert.equal(clamped.truncated, true);
  assert.ok(clamped.preview.length <= 100);
});

test('append 落到对应时区的日分片，并返回落盘记录', () => {
  const dir = tempDir();
  const audit = createAuditStore({ dir, timezone: 'Asia/Shanghai', logger: silent });
  const record = audit.append({
    at: '2026-10-04T17:30:00.000Z',
    kind: 'cli',
    name: 'lark',
    ok: true,
    code: 0,
    durationMs: 123.7,
    detail: { args: ['--version'] },
  });
  assert.equal(record.day, '2026-10-05');
  assert.equal(record.durationMs, 124);
  assert.deepEqual(audit.listDays(), ['2026-10-05']);
  const lines = fs.readFileSync(path.join(dir, 'audit', '2026-10-05.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).name, 'lark');
});

test('append 对坏输入不抛异常（审计失败绝不能拖垮调用方）', () => {
  const dir = tempDir();
  const audit = createAuditStore({ dir, timezone: 'UTC', logger: silent });
  assert.doesNotThrow(() => audit.append(undefined));
  assert.doesNotThrow(() => audit.append({ kind: 'x', detail: { fn: () => {} } }));
  assert.equal(audit.listDays().length, 1);
});

test('readRange 返回最新在前，并按窗口与条数过滤', () => {
  const dir = tempDir();
  const audit = createAuditStore({ dir, timezone: 'UTC', logger: silent });
  for (const day of ['2026-10-01', '2026-10-02', '2026-10-03']) {
    for (let i = 0; i < 3; i += 1) {
      audit.append({ at: `${day}T00:00:0${i}.000Z`, kind: 'cli', name: `d${day}-${i}`, ok: true });
    }
  }
  const all = audit.readRange({ limit: 100 });
  assert.equal(all.items.length, 9);
  assert.equal(all.items[0].name, 'd2026-10-03-2', '最新在前');
  assert.equal(all.items[8].name, 'd2026-10-01-0');

  const limited = audit.readRange({ limit: 2 });
  assert.equal(limited.items.length, 2);
  assert.equal(limited.truncated, true);
  assert.deepEqual(limited.items.map((e) => e.name), ['d2026-10-03-2', 'd2026-10-03-1']);

  const windowed = audit.readRange({ from: '2026-10-02', to: '2026-10-02', limit: 100 });
  assert.equal(windowed.items.length, 3);
  assert.deepEqual(windowed.days, ['2026-10-02']);

  const kinds = audit.readRange({ limit: 100, kinds: ['nope'] });
  assert.equal(kinds.items.length, 0);
});

test('readRange 跳过坏行并计数，不影响好行', () => {
  const dir = tempDir();
  const audit = createAuditStore({ dir, timezone: 'UTC', logger: silent });
  audit.append({ at: '2026-10-04T00:00:00.000Z', kind: 'cli', name: 'good', ok: true });
  fs.appendFileSync(path.join(dir, 'audit', '2026-10-04.jsonl'), '{ not json\n', 'utf8');
  audit.append({ at: '2026-10-04T00:00:01.000Z', kind: 'cli', name: 'good2', ok: true });

  const read = audit.readRange({ limit: 100 });
  assert.equal(read.items.length, 2);
  assert.equal(read.skippedLines, 1);
});

test('readRange 在没有目录时安静地返回空', () => {
  const audit = createAuditStore({ dir: path.join(tempDir(), 'nope'), timezone: 'UTC', logger: silent });
  const read = audit.readRange({ limit: 10 });
  assert.deepEqual(read.items, []);
  assert.deepEqual(read.days, []);
});

test('prune 删掉超过保留期的分片，保留期内的不动', () => {
  const dir = tempDir();
  const audit = createAuditStore({ dir, timezone: 'UTC', retentionDays: 3, logger: silent });
  for (const day of ['2026-09-25', '2026-09-30', '2026-10-02', '2026-10-04']) {
    audit.append({ at: `${day}T00:00:00.000Z`, kind: 'cli', ok: true });
  }
  const { removed } = audit.prune({ now: new Date('2026-10-04T12:00:00.000Z') });
  assert.deepEqual(removed, ['2026-09-25', '2026-09-30']);
  assert.deepEqual(audit.listDays(), ['2026-10-02', '2026-10-04']);
});

test('configure 改时区后，新事件落到新的日分片', () => {
  const dir = tempDir();
  const audit = createAuditStore({ dir, timezone: 'UTC', logger: silent });
  const at = '2026-10-04T17:30:00.000Z';
  assert.equal(audit.append({ at, kind: 'cli', ok: true }).day, '2026-10-04');
  audit.configure({ timezone: 'Asia/Shanghai', retentionDays: 10 });
  assert.equal(audit.append({ at, kind: 'cli', ok: true }).day, '2026-10-05');
  assert.equal(audit.retentionDays, 10);
});

test('超长事件被压到单行上限之内', () => {
  const dir = tempDir();
  const audit = createAuditStore({ dir, timezone: 'UTC', maxLineBytes: 512, logger: silent });
  audit.append({ kind: 'cli', name: 'huge', detail: { blob: 'y'.repeat(5000) } });
  const raw = fs.readFileSync(path.join(dir, 'audit', `${audit.dayKey(new Date())}.jsonl`), 'utf8');
  assert.ok(Buffer.byteLength(raw, 'utf8') < 512, `实际 ${Buffer.byteLength(raw, 'utf8')} 字节`);
  const parsed = JSON.parse(raw.trim());
  assert.equal(parsed.detail.truncated, true);
});
