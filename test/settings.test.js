import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DEFAULT_SETTINGS,
  ensureDataDir,
  loadSettings,
  normalizeSettings,
  parseArgs,
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
