import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AUTO_PATROL_DEFAULTS,
  DEFAULT_TIMES,
  SLOT_GRACE_MINUTES,
  createAutoPatrol,
  formatClock,
  normalizeChannelPlans,
  normalizeStoreIds,
  normalizeTimes,
  parseClock,
  zonedParts,
} from '../lib/auto-patrol.js';

/** 造一个只记录 start 的巡逻服务替身。 */
function fakePatrol() {
  const started = [];
  let running = false;
  let active = null;
  return {
    started,
    setRunning(value) {
      running = value;
    },
    start(input) {
      if (running) throw new Error('已经有一次巡逻在跑');
      started.push(input);
      active = {
        id: 'p_' + (started.length + 1),
        status: 'running',
        startedAt: '2026-10-08T01:00:00.000Z',
        finishedAt: null,
        progress: { draftsCreated: 0 },
      };
      return active;
    },
    snapshot() {
      return { running, run: active };
    },
  };
}

/** 三个平台，够验证「各设各的」；沃尔玛那个渠道关着，用来验证「渠道没启用就不跑」。 */
const CHANNELS = [
  { id: 'amazon', label: '亚马逊', enabled: true },
  { id: 'tiktok', label: 'TikTok Shop', enabled: true },
  { id: 'walmart', label: '沃尔玛', enabled: true },
];

/**
 * 建一个调度器。
 * 上海是 UTC+8：注释里的「当地时刻」都换算成了 UTC —— 09:00 当地 = 01:00Z。
 */
function makeScheduler({ autoPatrol = {}, patrol = fakePatrol(), at = '2026-10-08T01:00:20.000Z', stateFile, channels } = {}) {
  const settings = {
    timezone: 'Asia/Shanghai',
    autoPatrol: { enabled: true, times: ['09:00', '14:00', '20:00'], ...autoPatrol },
  };
  let now = new Date(at);
  const audit = [];
  const warns = [];
  const scheduler = createAutoPatrol({
    settings,
    patrol,
    channels: channels ?? (() => CHANNELS),
    logger: { warn: (...args) => warns.push(args.join(' ')), info: () => {} },
    clock: () => now,
    audit: { append: (entry) => audit.push(entry) },
    stateFile,
  });
  return {
    scheduler,
    patrol,
    settings,
    audit,
    warns,
    at(time) {
      now = new Date(time);
    },
  };
}

test('parseClock / formatClock：认 9:00 也认 09:00，非法返回 null', () => {
  assert.equal(parseClock('09:00'), 540);
  assert.equal(parseClock('9:05'), 545);
  assert.equal(parseClock('00:00'), 0);
  assert.equal(parseClock('23:59'), 1439);
  assert.equal(parseClock('24:00'), null);
  assert.equal(parseClock('09:60'), null);
  assert.equal(parseClock('abc'), null);
  assert.equal(parseClock(undefined), null);
  assert.equal(formatClock(540), '09:00');
  assert.equal(formatClock(545), '09:05');
  assert.equal(formatClock(1440), '00:00', '取模回零点');
});

test('normalizeTimes：去重、按时间升序、丢掉非法项，最多 48 次', () => {
  assert.deepEqual(normalizeTimes(['20:00', '9:00', '09:00', 'abc', '25:00']), ['09:00', '20:00']);
  assert.deepEqual(normalizeTimes('08:00, 12:30 09:00'), ['08:00', '09:00', '12:30']);
  assert.deepEqual(normalizeTimes([]), [], '空数组就是「一次都不巡检」，不该被塞回默认值');
  assert.deepEqual(normalizeTimes(null), []);
  assert.equal(normalizeTimes(Array.from({ length: 60 }, (_, i) => formatClock(i * 10))).length, 48);
});

test('normalizeStoreIds：去空、大小写不敏感去重、认字符串写法，最多 200 个', () => {
  assert.deepEqual(normalizeStoreIds([' a ', '', 'A', 'b']), ['a', 'b']);
  assert.deepEqual(normalizeStoreIds('s1, s2;s3'), ['s1', 's2', 's3']);
  assert.deepEqual(normalizeStoreIds([]), [], '空数组 = 不限定（全部），这是有含义的，不是非法值');
  assert.deepEqual(normalizeStoreIds(null), []);
  assert.equal(normalizeStoreIds(Array.from({ length: 300 }, (_, i) => `s${i}`)).length, 200);
});

test('normalizeChannelPlans：按平台收敛开关/时刻/店铺，坏键丢掉', () => {
  const plans = normalizeChannelPlans({
    amazon: { enabled: true, times: ['20:00', '09:00'], storeIds: ['s1', 's1'] },
    tiktok: { enabled: 'yes', times: '10:00' },
    '': { enabled: true },
    7: { enabled: true, times: ['08:00'] },
  });
  assert.deepEqual(Object.keys(plans).sort(), ['7', 'amazon', 'tiktok'], '空键丢掉，其余原样收下');
  assert.deepEqual(plans.amazon, { enabled: true, times: ['09:00', '20:00'], storeIds: ['s1'] });
  assert.deepEqual(plans.tiktok, { enabled: false, times: ['10:00'], storeIds: [] }, '只有 true 才算开');
  assert.deepEqual(plans['7'], { enabled: true, times: ['08:00'], storeIds: [] });
  assert.deepEqual(normalizeChannelPlans(null), {});
  assert.deepEqual(normalizeChannelPlans(['amazon']), {}, '数组不是计划表，直接当空');
});

test('zonedParts：按配置时区算日期与分钟，而不是按宿主本地时区', () => {
  const at = new Date('2026-10-08T01:00:20.000Z');
  assert.deepEqual(zonedParts(at, 'Asia/Shanghai'), { dateKey: '2026-10-08', minutes: 9 * 60 });
  assert.deepEqual(zonedParts(at, 'UTC'), { dateKey: '2026-10-08', minutes: 1 * 60 });
  assert.equal(typeof zonedParts(at, 'Not/AZone').minutes, 'number', '时区名非法也不许抛');
});

test('tick：全局默认计划对每个平台生效，同一拍合并成一次巡逻', () => {
  const s = makeScheduler({ at: '2026-10-08T01:00:20.000Z' }); // 当地 09:00:20
  s.scheduler.tick();
  assert.equal(s.patrol.started.length, 1, '三个平台同一时刻只该起一次巡逻');
  assert.deepEqual(s.patrol.started[0], {
    channels: ['amazon', 'tiktok', 'walmart'],
    sourceIdsByChannel: { amazon: [], tiktok: [], walmart: [] },
    closeAfter: false,
    autoFillAmazon: true,
  });
  // 每店条数 / 最多几家故意不传：沿用巡逻设置，自动跑不该另有一套悄悄生效的参数。
  assert.equal('maxPerStore' in s.patrol.started[0], false);
  assert.equal('sourceIds' in s.patrol.started[0], false, '不能压成一个全局 storeIds');
  assert.equal(s.audit.length, 1);
  assert.equal(s.audit[0].name, 'auto-start');
  assert.deepEqual(s.audit[0].detail.channels, ['amazon', 'tiktok', 'walmart']);
  assert.deepEqual(s.audit[0].detail.slots, { amazon: '09:00', tiktok: '09:00', walmart: '09:00' });
});

test('tick：每个平台各设各的时刻与店铺，各跑各的', () => {
  const s = makeScheduler({
    at: '2026-10-08T01:00:10.000Z', // 当地 09:00
    autoPatrol: {
      enabled: false, // 全局默认关着
      channels: {
        amazon: { enabled: true, times: ['09:00'], storeIds: ['s1', 's2'] },
        tiktok: { enabled: true, times: ['10:00'] },
      },
    },
  });
  s.scheduler.tick();
  assert.equal(s.patrol.started.length, 1);
  assert.deepEqual(s.patrol.started[0].channels, ['amazon'], '只有亚马逊这一档');
  assert.deepEqual(
    s.patrol.started[0].sourceIdsByChannel,
    { amazon: ['s1', 's2'] },
    '只带这个平台自己的店铺清单',
  );

  s.at('2026-10-08T02:00:10.000Z'); // 当地 10:00
  s.scheduler.tick();
  assert.equal(s.patrol.started.length, 2);
  assert.deepEqual(s.patrol.started[1].channels, ['tiktok']);
  // 空数组 = 这个平台全部目标：**必须有这一项**，不能省成 undefined（那会被全局清单接管）。
  assert.deepEqual(s.patrol.started[1].sourceIdsByChannel, { tiktok: [] });

  // 沃尔玛没设过自己的计划，全局默认又是关的 → 一次都不会跑。
  const walmart = s.scheduler.snapshot().channels.walmart;
  assert.equal(walmart.enabled, false);
  assert.equal(walmart.configured, false, '没单独设过：界面要能标出「沿用全局默认」');
});

test('tick：渠道本身没启用的平台，时刻到了也不跑', () => {
  const s = makeScheduler({
    at: '2026-10-08T01:00:10.000Z',
    autoPatrol: { enabled: true, channels: { amazon: { enabled: true, times: ['09:00'] } } },
    channels: () => [
      { id: 'amazon', label: '亚马逊', enabled: true },
      { id: 'lark-mail', label: '飞书邮箱', enabled: false },
    ],
  });
  s.scheduler.tick();
  assert.equal(s.patrol.started.length, 1);
  const mail = s.scheduler.snapshot().channels['lark-mail'];
  assert.equal(mail.channelEnabled, false);
  assert.equal(mail.blockedBy, 'channel-disabled');
  assert.equal(mail.wouldRun, false);
});

test('tick：同一个平台同一个时刻当天只跑一次，连看半小时也不会重复', () => {
  const s = makeScheduler({
    at: '2026-10-08T01:00:20.000Z',
    autoPatrol: { enabled: false, channels: { amazon: { enabled: true, times: ['09:00'] } } },
  });
  const base = Date.parse('2026-10-08T01:00:20.000Z');
  for (let minute = 0; minute < 30; minute += 1) {
    s.at(new Date(base + minute * 60_000).toISOString());
    s.scheduler.tick();
  }
  assert.equal(s.patrol.started.length, 1, '09:00 只该跑一次');
  assert.deepEqual(s.scheduler.snapshot().channels.amazon.firedToday, ['09:00']);
});

test('tick：一天里的多个时刻各跑一次，隔天照旧', () => {
  const s = makeScheduler({
    at: '2026-10-08T01:00:10.000Z',
    autoPatrol: { enabled: false, channels: { amazon: { enabled: true, times: ['09:00', '14:00', '20:00'] } } },
  });
  s.scheduler.tick();
  s.at('2026-10-08T06:00:10.000Z'); // 14:00
  s.scheduler.tick();
  s.at('2026-10-08T12:00:10.000Z'); // 20:00
  s.scheduler.tick();
  assert.equal(s.patrol.started.length, 3);
  assert.deepEqual(s.scheduler.snapshot().channels.amazon.firedToday, ['09:00', '14:00', '20:00']);
  s.at('2026-10-09T01:00:10.000Z'); // 第二天 09:00
  s.scheduler.tick();
  assert.equal(s.patrol.started.length, 4);
});

test('tick：宽限期内补跑，超过宽限就算错过', () => {
  assert.equal(SLOT_GRACE_MINUTES, 5);
  const late = makeScheduler({ at: '2026-10-08T01:03:00.000Z' }); // 当地 09:03，晚了 3 分钟
  late.scheduler.tick();
  assert.equal(late.patrol.started.length, 1, '宽限期内发现也要跑');
  assert.equal(late.audit[0].detail.lateMinutes, 3);

  const missed = makeScheduler({ at: '2026-10-08T01:06:00.000Z' }); // 当地 09:06，晚了 6 分钟
  missed.scheduler.tick();
  assert.equal(missed.patrol.started.length, 0, '超过宽限就跳过这一次');
  assert.equal(missed.scheduler.decide().reason, 'not-due');
});

test('tick：撞上正在跑的巡逻就跳过这一次，而且这一天不再补跑', () => {
  const s = makeScheduler({
    at: '2026-10-08T01:00:10.000Z',
    autoPatrol: { enabled: false, channels: { amazon: { enabled: true, times: ['09:00', '14:00'] } } },
  });
  s.patrol.setRunning(true);
  s.scheduler.tick();
  assert.equal(s.patrol.started.length, 0, '不能并发');
  assert.equal(s.audit[0].name, 'auto-skip');
  assert.equal(s.audit[0].detail.reason, 'busy');
  assert.equal(s.audit[0].detail.channel, 'amazon');
  assert.deepEqual(s.scheduler.snapshot().channels.amazon.firedToday, ['09:00'], '这一次算用掉了，不补跑');

  s.patrol.setRunning(false);
  s.scheduler.tick();
  assert.equal(s.patrol.started.length, 0, '同一时刻不会因为空下来了就再跑');
  s.at('2026-10-08T06:00:10.000Z'); // 14:00
  s.scheduler.tick();
  assert.equal(s.patrol.started.length, 1, '下一个时刻照常');
});

test('tick：两个平台同一拍都到点，合并成一次；一个平台被跳过不影响另一个', () => {
  const s = makeScheduler({
    at: '2026-10-08T01:00:10.000Z',
    autoPatrol: {
      enabled: false,
      channels: {
        amazon: { enabled: true, times: ['09:00'], storeIds: ['a1'] },
        tiktok: { enabled: true, times: ['09:00'], storeIds: ['t1'] },
      },
    },
  });
  s.scheduler.tick();
  assert.equal(s.patrol.started.length, 1, '本来也只能串行跑，合成一次，别让第二个平台被「忙」挤掉');
  assert.deepEqual(s.patrol.started[0].channels, ['amazon', 'tiktok']);
  assert.deepEqual(s.patrol.started[0].sourceIdsByChannel, { amazon: ['a1'], tiktok: ['t1'] });
});

test('decide：按平台给原因，汇总时说「最值得先知道」的那条', () => {
  const s = makeScheduler({
    at: '2026-10-08T03:00:00.000Z', // 当地 11:00，不在任何时刻表上
    autoPatrol: {
      enabled: false,
      channels: {
        amazon: { enabled: true, times: ['09:00'] },
        tiktok: { enabled: true, times: [] },
      },
    },
  });
  assert.equal(s.scheduler.decide().reason, 'no-times', '有平台开着却没时刻，比「没到点」更该先说');

  s.settings.autoPatrol.channels.tiktok.times = ['11:00'];
  assert.equal(s.scheduler.decide().run, true);
  assert.deepEqual(s.scheduler.decide().channels, ['tiktok']);
  assert.equal(s.scheduler.snapshot().channels.tiktok.dueSlot, '11:00');

  s.settings.autoPatrol.channels.amazon.enabled = false;
  s.settings.autoPatrol.channels.tiktok.enabled = false;
  assert.equal(s.scheduler.decide().reason, 'disabled', '全都关了就是「整个功能没开」');
});

test('nextSlot：每个平台各算各的下一次', () => {
  const s = makeScheduler({
    at: '2026-10-08T03:00:00.000Z', // 当地 11:00
    autoPatrol: {
      enabled: false,
      channels: {
        amazon: { enabled: true, times: ['09:00', '14:00'] },
        tiktok: { enabled: true, times: ['20:00'] },
      },
    },
  });
  const plans = s.scheduler.config();
  const amazon = s.scheduler.nextSlot(new Date('2026-10-08T03:00:00.000Z'), plans.amazon);
  assert.equal(amazon.slot, '14:00');
  assert.equal(amazon.at.toISOString(), '2026-10-08T06:00:00.000Z');
  const tiktok = s.scheduler.nextSlot(new Date('2026-10-08T03:00:00.000Z'), plans.tiktok);
  assert.equal(tiktok.slot, '20:00');
  // 快照里给的是**全部平台里最早的那一次**。
  const snap = s.scheduler.snapshot();
  assert.equal(snap.nextSlot, '14:00');
  assert.equal(snap.nextChannel, 'amazon');
  assert.equal(snap.nextChannelLabel, '亚马逊');

  // 时刻表里只有 20:00，而现在是 20:30（宽限已过）→ 下一次是明天 20:00
  const later = makeScheduler({
    at: '2026-10-08T12:30:00.000Z',
    autoPatrol: { enabled: false, channels: { amazon: { enabled: true, times: ['20:00'] } } },
  });
  const after = later.scheduler.snapshot().channels.amazon;
  assert.equal(after.nextSlot, '20:00');
  assert.equal(after.nextAt, '2026-10-09T12:00:00.000Z');
});

test('状态落盘：换个实例（相当于重启 DSH）当天已跑过的时刻不会重跑', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-auto-'));
  const stateFile = path.join(dir, 'run', 'auto-patrol.json');
  const autoPatrol = {
    enabled: false,
    channels: { amazon: { enabled: true, times: ['09:00'] }, tiktok: { enabled: true, times: ['09:00'] } },
  };
  const first = makeScheduler({ at: '2026-10-08T01:00:10.000Z', stateFile, autoPatrol });
  first.scheduler.tick();
  assert.equal(fs.existsSync(stateFile), true, '要落盘');
  assert.equal(first.patrol.started.length, 1);

  const second = makeScheduler({ at: '2026-10-08T01:01:10.000Z', stateFile, autoPatrol });
  assert.deepEqual(second.scheduler.snapshot().channels.amazon.firedToday, ['09:00']);
  second.scheduler.tick();
  assert.equal(second.patrol.started.length, 0, '重启后不该重跑同一个时刻');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('状态落盘：也认旧版「没有平台后缀」的记账键（升级当天不重复跑）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-auto-legacy-'));
  const stateFile = path.join(dir, 'auto-patrol.json');
  // 旧版（v0.10 及以前）那张全局时刻表留下的记账，长这样。
  fs.writeFileSync(stateFile, JSON.stringify({ fired: { '2026-10-08 09:00': 'x' } }), 'utf8');
  const s = makeScheduler({ at: '2026-10-08T01:00:10.000Z', stateFile });
  s.scheduler.tick();
  assert.equal(s.patrol.started.length, 0, '那一天 09:00 已经跑过了（跑的是全部渠道）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('启动失败要留审计，而且不会变成每分钟重试的热循环', () => {
  const s = makeScheduler({ at: '2026-10-08T01:00:10.000Z' });
  s.patrol.start = () => {
    throw Object.assign(new Error('已经有一次巡逻在跑'), { kind: 'busy' });
  };
  s.scheduler.tick();
  s.scheduler.tick();
  assert.equal(s.audit.filter((entry) => entry.ok === false).length, 1, '失败只记一条');
  assert.equal(s.audit[0].detail.channels.length, 3, '审计里要说清是哪几个平台');
  assert.match(s.warns.join('\n'), /定时巡检启动失败/);
});

test('设置是活引用：改完不用重启，下一拍立刻按新时刻表判', () => {
  const s = makeScheduler({
    at: '2026-10-08T03:00:00.000Z', // 当地 11:00
    autoPatrol: { enabled: false, channels: { amazon: { enabled: true, times: ['09:00'] } } },
  });
  assert.equal(s.scheduler.decide().reason, 'not-due');
  s.settings.autoPatrol.channels.amazon.times = ['11:00'];
  assert.equal(s.scheduler.decide().run, true, '把 11:00 加进时刻表，同一刻就该跑');
  assert.equal(s.scheduler.snapshot().channels.amazon.dueSlot, '11:00');
});

test('start / stop：装上心跳、能摘掉，默认配置是关闭', () => {
  assert.equal(AUTO_PATROL_DEFAULTS.enabled, false, '默认必须关闭：无人值守会自己开浏览器');
  assert.deepEqual([...AUTO_PATROL_DEFAULTS.times], ['09:00', '14:00', '20:00']);
  assert.deepEqual([...DEFAULT_TIMES], ['09:00', '14:00', '20:00']);
  assert.deepEqual(AUTO_PATROL_DEFAULTS.channels, {}, '出厂时没有任何平台有自己的计划');
  const s = makeScheduler({ at: '2026-10-08T03:00:00.000Z' }); // 不在任何时刻的宽限内
  assert.equal(s.scheduler.running, false);
  s.scheduler.start();
  assert.equal(s.scheduler.running, true);
  assert.equal(s.scheduler.snapshot().heartbeat, true);
  s.scheduler.stop();
  assert.equal(s.scheduler.running, false);
  s.scheduler.stop(); // 重复摘掉不该报错
});
