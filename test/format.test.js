import assert from 'node:assert/strict';
import test from 'node:test';
import { DASH, barWidth, dateTime, ms, num, pct, relative, shortDay, slaCountdown } from '../assets/js/format.js';

test('num：空值显示「—」，真实 0 要显示 0', () => {
  assert.equal(num(null), DASH);
  assert.equal(num(undefined), DASH);
  assert.equal(num(''), DASH);
  assert.equal(num('abc'), DASH);
  assert.equal(num(0), '0');
  assert.equal(num(1234), '1,234');
});

test('pct：null 是「—」而不是 0%（零分母不能伪装成 0）', () => {
  assert.equal(pct(null), DASH);
  assert.equal(pct(0), '0%');
  assert.equal(pct(0.756), '76%');
  assert.equal(pct(0.756, 1), '75.6%');
  assert.equal(pct(1), '100%');
});

test('ms：按量级切换单位', () => {
  assert.equal(ms(null), DASH);
  assert.equal(ms(-1), DASH);
  assert.equal(ms(0), '0 ms');
  assert.equal(ms(450), '450 ms');
  assert.equal(ms(1500), '1.5 秒');
  assert.equal(ms(45000), '45 秒');
  assert.equal(ms(90_000), '2 分钟');
  assert.equal(ms(3_600_000), '1 小时');
  assert.equal(ms(5_400_000), '1 小时 30 分');
  assert.equal(ms(90_000_000), '1 天 1 小时');
});

test('relative：刚刚 / 分钟 / 小时 / 天', () => {
  const now = new Date('2026-10-04T12:00:00.000Z');
  assert.equal(relative(null, now), DASH);
  assert.equal(relative('2026-10-04T11:59:30.000Z', now), '刚刚');
  assert.equal(relative('2026-10-04T11:30:00.000Z', now), '30 分钟前');
  assert.equal(relative('2026-10-04T09:00:00.000Z', now), '3 小时前');
  assert.equal(relative('2026-10-01T12:00:00.000Z', now), '3 天前');
  // 超过 30 天退回绝对时间
  assert.match(relative('2026-08-01T12:00:00.000Z', now), /^08-01 /);
});

test('dateTime 与 shortDay 的格式化', () => {
  assert.equal(dateTime(null), DASH);
  assert.equal(dateTime('not-a-date'), DASH);
  assert.match(dateTime('2026-10-04T12:34:00.000Z'), /^\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(shortDay('2026-10-04'), '10-04');
  assert.equal(shortDay(null), DASH);
});

test('slaCountdown：超时与剩余，并标出是否未知', () => {
  const now = new Date('2026-10-04T12:00:00.000Z');
  const overdue = slaCountdown('2026-10-04T10:00:00.000Z', now);
  assert.equal(overdue.overdue, true);
  assert.equal(overdue.unknown, false);
  assert.match(overdue.text, /^超时 2 小时$/);

  const fine = slaCountdown('2026-10-04T14:00:00.000Z', now);
  assert.equal(fine.overdue, false);
  assert.match(fine.text, /^剩 2 小时$/);

  const unknown = slaCountdown(null, now);
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.text, DASH);
});

test('barWidth：夹在 0..100%，非法输入退化为 0%', () => {
  assert.equal(barWidth(0, 10), '0%');
  assert.equal(barWidth(5, 10), '50%');
  assert.equal(barWidth(20, 10), '100%');
  assert.equal(barWidth(1, 0), '0%');
  assert.equal(barWidth(null, 10), '0%');
  assert.equal(barWidth(1, null), '0%');
});
