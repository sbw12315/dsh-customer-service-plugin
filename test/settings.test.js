import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_SETTINGS,
  MAIL_CHANNEL_ID,
  ensureDataDir,
  isChannelEnabled,
  loadSettings,
  normalizeSettings,
  parseArgs,
  parseChannelEnabled,
  parseMailboxes,
  readJson,
  saveSettings,
  settingsDir,
  writeJsonAtomic,
} from '../lib/settings.js';

/** 建一个一次性临时目录。 */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cs-settings-'));
}

test('normalizeSettings 收敛非法输入并补默认值', () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.deepEqual(normalizeSettings({ cliPaths: 'nope' }).cliPaths, { ziniao: null, lark: null });
  assert.deepEqual(normalizeSettings({ cliArgs: 'nope' }).cliArgs, { ziniao: [], lark: [] });
  const cleaned = normalizeSettings({
    dataDir: '  /tmp/x  ',
    cliPaths: { ziniao: ' /opt/z ', lark: '' },
    timezone: '',
  });
  assert.equal(cleaned.dataDir, '/tmp/x');
  assert.equal(cleaned.cliPaths.ziniao, '/opt/z');
  assert.equal(cleaned.cliPaths.lark, null);
  assert.equal(cleaned.timezone, DEFAULT_SETTINGS.timezone);
});

test('parseArgs 同时接受数组与界面手输的字符串', () => {
  assert.deepEqual(parseArgs(['--profile', 'x']), ['--profile', 'x']);
  assert.deepEqual(parseArgs('  --profile   example-lark-profile  '), [
    '--profile',
    'example-lark-profile',
  ]);
  // 带空格的片段用引号包裹
  assert.deepEqual(parseArgs('--title "hello world" -v'), ['--title', 'hello world', '-v']);
  assert.deepEqual(parseArgs(''), []);
  assert.deepEqual(parseArgs(null), []);
  assert.deepEqual(parseArgs(['', '  ', '--a']), ['--a']);
});

test('parseMailboxes 接受数组与界面手输的字符串，按小写去重并丢掉非地址片段', () => {
  assert.deepEqual(parseMailboxes(['support@fusou.vip']), ['support@fusou.vip']);
  assert.deepEqual(parseMailboxes('support@fusou.vip, cs@jinmukeji.com'), [
    'support@fusou.vip',
    'cs@jinmukeji.com',
  ]);
  // 大小写不同的同一个地址只留一条，保留先出现的写法
  assert.deepEqual(parseMailboxes(['Support@fusou.vip', 'support@fusou.VIP']), ['Support@fusou.vip']);
  // 没有 @ 的片段（手输时常见）直接丢掉，不当成邮箱
  assert.deepEqual(parseMailboxes('support@fusou.vip 随便写的 123'), ['support@fusou.vip']);
  assert.deepEqual(parseMailboxes(''), []);
  assert.deepEqual(parseMailboxes(null), []);
});

test('飞书邮箱渠道默认关闭，只有显式打开才启用', () => {
  assert.equal(DEFAULT_SETTINGS.mailEnabled, false);
  assert.equal(normalizeSettings({}).mailEnabled, false, '没写这个字段 = 关闭');
  assert.equal(normalizeSettings({ mailboxes: 'support@fusou.vip' }).mailEnabled, false, '配了邮箱也仍然是关的');
  assert.equal(normalizeSettings({ mailEnabled: true }).mailEnabled, true);
  assert.equal(normalizeSettings({ mailEnabled: false }).mailEnabled, false);
});

test('渠道级开关：稀疏表 + 逐渠道默认值，mailEnabled 只是它的派生镜像', () => {
  // 出厂不写任何渠道：默认值由适配器声明（店铺类开、飞书邮箱关），
  // 写进文件就会把「没设过」和「显式设成默认」抹平，将来改默认值也对老用户失效。
  assert.deepEqual(DEFAULT_SETTINGS.channelEnabled, {});
  assert.deepEqual(normalizeSettings({}).channelEnabled, {}, '没设过就是空表，不是一张全 true 的表');

  const normalized = normalizeSettings({ channelEnabled: { amazon: false, tiktok: true } });
  assert.deepEqual(normalized.channelEnabled, { amazon: false, tiktok: true });

  // mailEnabled 是**派生值**：读出来给老前端用，真值在 channelEnabled 里。
  assert.equal(normalizeSettings({ channelEnabled: { 'lark-mail': true } }).mailEnabled, true);
  assert.equal(normalizeSettings({ channelEnabled: { 'lark-mail': false } }).mailEnabled, false);
  // 两条来源同时出现时，channelEnabled 赢（新的那一个入口说了算）。
  assert.equal(
    normalizeSettings({ mailEnabled: true, channelEnabled: { 'lark-mail': false } }).mailEnabled,
    false,
  );
  // 老设置文件只有 mailEnabled：照样认。
  assert.equal(normalizeSettings({ mailEnabled: true }).mailEnabled, true);
});

test('parseChannelEnabled：丢掉非法键、非布尔值按真值收敛，坏输入不抛', () => {
  assert.deepEqual(parseChannelEnabled(null), {});
  assert.deepEqual(parseChannelEnabled('nope'), {});
  assert.deepEqual(parseChannelEnabled(['amazon']), {}, '数组形状不对，整块丢掉');
  assert.deepEqual(parseChannelEnabled({ '  amazon  ': false, '': true, '  ': true }), { amazon: false });
  // 只有显式 false 才算关（与 isChannelEnabled 的判据同一套规则），其余一律算开。
  assert.deepEqual(parseChannelEnabled({ amazon: 0, tiktok: 'yes' }), { amazon: true, tiktok: true });
  assert.deepEqual(parseChannelEnabled({ amazon: false, tiktok: null }), { amazon: false, tiktok: true });
});

test('isChannelEnabled：渠道开关的唯一判据（新键 > 老 mailEnabled > 出厂默认）', () => {
  // 没设过：走调用方给的默认值（店铺类 true、邮箱 false）。
  assert.equal(isChannelEnabled({ channelEnabled: {} }, 'amazon'), true);
  assert.equal(isChannelEnabled({}, 'lark-mail', false), false);
  // 显式设过：无论是哪个渠道，以它为准。
  assert.equal(isChannelEnabled({ channelEnabled: { amazon: false } }, 'amazon'), false);
  assert.equal(isChannelEnabled({ channelEnabled: { amazon: true } }, 'amazon'), true);
  // 老设置文件里邮箱渠道的开关叫 mailEnabled。
  assert.equal(isChannelEnabled({ mailEnabled: true }, MAIL_CHANNEL_ID, false), true);
  assert.equal(isChannelEnabled({ mailEnabled: false }, MAIL_CHANNEL_ID, false), false);
  // 新键赢过老键 —— 否则巡逻页那枚开关会出现「点了没反应」。
  assert.equal(
    isChannelEnabled({ mailEnabled: true, channelEnabled: { [MAIL_CHANNEL_ID]: false } }, MAIL_CHANNEL_ID, false),
    false,
  );
  // 老键只对邮箱渠道有效，不会顺手把别的渠道也关掉。
  assert.equal(isChannelEnabled({ mailEnabled: false }, 'amazon'), true);
  assert.equal(isChannelEnabled(undefined, 'amazon'), true, 'settings 为空也不能抛');
});

test('normalizeSettings 收敛 patrol 邮箱列表，默认不巡逻任何邮箱', () => {
  assert.deepEqual(DEFAULT_SETTINGS.mailboxes, []);
  assert.deepEqual(normalizeSettings({}).mailboxes, []);
  assert.deepEqual(normalizeSettings({ mailboxes: 'support@fusou.vip cs@jinmukeji.com' }).mailboxes, [
    'support@fusou.vip',
    'cs@jinmukeji.com',
  ]);
});

test('normalizeSettings 把 cliArgs 的字符串写法收敛成数组', () => {
  const normalized = normalizeSettings({
    cliArgs: { lark: '--profile example-lark-profile', ziniao: ['--x'] },
  });
  assert.deepEqual(normalized.cliArgs.lark, ['--profile', 'example-lark-profile']);
  assert.deepEqual(normalized.cliArgs.ziniao, ['--x']);
});

test('normalizeSettings：CLI 开关默认都启用，也能逐个关掉', () => {
  assert.deepEqual(DEFAULT_SETTINGS.cliEnabled, { ziniao: true, lark: true });
  assert.deepEqual(normalizeSettings({}).cliEnabled, { ziniao: true, lark: true });
  // 只提交一个键时，另一个必须保持默认，不能被一起抹掉。
  assert.deepEqual(normalizeSettings({ cliEnabled: { lark: false } }).cliEnabled, {
    ziniao: true,
    lark: false,
  });
  // 非布尔值按真值收敛；整个字段不是对象时退回默认。
  assert.deepEqual(normalizeSettings({ cliEnabled: { ziniao: 0 } }).cliEnabled, {
    ziniao: false,
    lark: true,
  });
  assert.deepEqual(normalizeSettings({ cliEnabled: 'nope' }).cliEnabled, { ziniao: true, lark: true });
});

test('normalizeSettings：定时巡检 = 全局默认计划 + 每个平台一份自己的计划', () => {
  // 出厂：全局默认（关闭、三档），没有任何平台单独设置过。
  assert.deepEqual(normalizeSettings({}).autoPatrol, {
    enabled: false,
    times: ['09:00', '14:00', '20:00'],
    channels: {},
  });
  // 旧版（v0.10 及以前）的写法原样继承成全局默认计划：升级不改变行为。
  const legacy = normalizeSettings({ autoPatrol: { enabled: true, times: ['08:30'] } });
  assert.equal(legacy.autoPatrol.enabled, true);
  assert.deepEqual(legacy.autoPatrol.times, ['08:30']);
  assert.deepEqual(legacy.autoPatrol.channels, {}, '旧版没有平台这一层');

  const normalized = normalizeSettings({
    autoPatrol: {
      enabled: true,
      times: '08:00 08:00 09:00',
      channels: {
        amazon: { enabled: true, times: ['20:00', '09:00'], storeIds: 's1, s2' },
        tiktok: { times: ['10:00'] },
        '   ': { enabled: true },
      },
    },
  });
  assert.deepEqual(normalized.autoPatrol.times, ['08:00', '09:00'], '全局默认计划照样去重排序');
  assert.deepEqual(Object.keys(normalized.autoPatrol.channels), ['amazon', 'tiktok'], '空键丢掉');
  assert.deepEqual(normalized.autoPatrol.channels.amazon, {
    enabled: true,
    times: ['09:00', '20:00'],
    storeIds: ['s1', 's2'],
  });
  // 有自己的计划就不再继承全局：没写的字段按「关闭 / 空」处理，而不是悄悄用全局那份。
  assert.deepEqual(normalized.autoPatrol.channels.tiktok, {
    enabled: false,
    times: ['10:00'],
    storeIds: [],
  });
  // 坏输入不许抛：整块退化成空计划表。
  assert.deepEqual(normalizeSettings({ autoPatrol: { channels: 'nope' } }).autoPatrol.channels, {});
  assert.deepEqual(normalizeSettings({ autoPatrol: ['amazon'] }).autoPatrol.channels, {});
});

test('settingsDir 优先 DSH_CS_DIR，其次显式 profile，最后环境变量推导', () => {
  assert.equal(settingsDir({ DSH_CS_DIR: '/tmp/cs', DSH_HOME: '/tmp/home' }), path.resolve('/tmp/cs'));
  assert.equal(
    settingsDir({ DSH_HOME: '/tmp/home', DSH_PROFILE: 'p' }),
    path.join(path.resolve('/tmp/home'), 'customer-service', 'p'),
  );
  assert.equal(
    settingsDir({ DSH_HOME: '/tmp/home', DSH_PROFILE: 'desktop' }, 'cs-web'),
    path.join(path.resolve('/tmp/home'), 'customer-service', 'cs-web'),
  );
});

test('loadSettings 接受显式 profile，用来隔离多个 DSH 实例的数据目录', () => {
  const home = tempDir();
  const env = { DSH_HOME: home, DSH_PROFILE: 'desktop' };
  const a = loadSettings({ env, profile: 'cs-web' });
  const b = loadSettings({ env, profile: 'desktop' });
  assert.notEqual(a.file, b.file);
  assert.ok(a.file.includes(path.join('customer-service', 'cs-web')));
  assert.ok(b.file.includes(path.join('customer-service', 'desktop')));
});

test('writeJsonAtomic 原子写入并保留完整内容', () => {
  const dir = tempDir();
  const file = path.join(dir, 'a.json');
  writeJsonAtomic(file, { b: 1, a: [1, 2] });
  assert.deepEqual(readJson(file, null), { b: 1, a: [1, 2] });
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), []);
});

test('readJson 遇到坏文件退化成 fallback 而不抛异常', () => {
  const dir = tempDir();
  const file = path.join(dir, 'broken.json');
  fs.writeFileSync(file, '{not json', 'utf8');
  assert.equal(readJson(file, 'fallback'), 'fallback');
  assert.equal(readJson(path.join(dir, 'missing.json'), null), null);
});

test('loadSettings：首次运行给出默认设置，保存后能读回来', () => {
  const dir = tempDir();
  const first = loadSettings({ env: {}, dir });
  assert.equal(first.firstRun, true);
  assert.equal(first.dataDir, path.resolve(dir));
  assert.equal(first.file, path.join(dir, 'settings.json'));

  saveSettings(first.file, { ...first.settings, timezone: 'UTC', cliPaths: { ziniao: '/bin/z', lark: null } });
  const second = loadSettings({ env: {}, dir });
  assert.equal(second.firstRun, false);
  assert.equal(second.settings.timezone, 'UTC');
  assert.equal(second.settings.cliPaths.ziniao, '/bin/z');
});

test('loadSettings：dataDir 字段把大数据目录指到别处，而设置文件位置不动', () => {
  const dir = tempDir();
  const other = tempDir();
  const first = loadSettings({ env: {}, dir });
  saveSettings(first.file, { ...first.settings, dataDir: other });
  const second = loadSettings({ env: {}, dir });
  assert.equal(second.file, path.join(dir, 'settings.json'));
  assert.equal(second.dataDir, path.resolve(other));
});

test('ensureDataDir 建好子目录并只补种缺失的出厂剧本', () => {
  const dataDir = tempDir();
  const seedDir = tempDir();
  fs.writeFileSync(path.join(seedDir, 'tiktok.message.json'), '{"id":"tiktok.message"}', 'utf8');
  fs.writeFileSync(path.join(seedDir, 'ignore.txt'), 'x', 'utf8');

  const first = ensureDataDir(dataDir, seedDir);
  assert.deepEqual(first.playbooks.map((p) => path.basename(p)), ['tiktok.message.json']);
  for (const sub of ['drafts', 'playbooks', 'run']) {
    assert.ok(fs.existsSync(path.join(dataDir, sub)), `缺少 ${sub}`);
  }

  // 用户改过的剧本不能被覆盖。
  const target = path.join(dataDir, 'playbooks', 'tiktok.message.json');
  fs.writeFileSync(target, '{"id":"tiktok.message","verified":true}', 'utf8');
  const second = ensureDataDir(dataDir, seedDir);
  assert.deepEqual(second.playbooks, []);
  assert.match(fs.readFileSync(target, 'utf8'), /"verified":true/);
});
