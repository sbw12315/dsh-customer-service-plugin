import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultDataDir, detectProfile, dshHome, profileFromPath, profileName, resolveDataDir } from '../lib/paths.js';

const HOME = os.homedir();

test('dshHome 优先使用 DSH_HOME，并把它解析成绝对路径', () => {
  assert.equal(dshHome({ DSH_HOME: '/tmp/dsh-home' }), path.resolve('/tmp/dsh-home'));
  assert.equal(dshHome({ DSH_HOME: '   ' }), path.join(HOME, '.dsh'));
  assert.equal(dshHome({}), path.join(HOME, '.dsh'));
});

test('profileName 缺省为 default', () => {
  assert.equal(profileName({ DSH_PROFILE: 'desktop' }), 'desktop');
  assert.equal(profileName({ DSH_PROFILE: '' }), 'default');
  assert.equal(profileName({}), 'default');
});

test('profileFromPath 能从插件安装路径里认出 profile', () => {
  assert.equal(profileFromPath('file:///Users/u/.dsh/profiles/cs-web/node_modules/p/lib/index.js'), 'cs-web');
  assert.equal(profileFromPath('/Users/u/.dsh/profiles/desktop/node_modules/p/lib/index.js'), 'desktop');
  assert.equal(profileFromPath('C:\\Users\\u\\.dsh\\profiles\\tui\\node_modules\\p\\lib\\index.js'), 'tui');
  assert.equal(profileFromPath('/Users/u/code/my-plugin/packages/p/lib/index.js'), null);
  assert.equal(profileFromPath(''), null);
  assert.equal(profileFromPath(undefined), null);
});

test('detectProfile 优先级：环境变量 > 安装路径 > default', () => {
  assert.deepEqual(detectProfile({ env: { DSH_PROFILE: 'desktop' }, pluginPath: '/x/profiles/other/y' }), {
    name: 'desktop',
    source: 'env',
  });
  assert.deepEqual(detectProfile({ env: {}, pluginPath: '/x/profiles/cs-web/node_modules/y' }), {
    name: 'cs-web',
    source: 'path',
  });
  // 用 link: 安装时插件路径在工作区里，两条线索都没有，只能退回 default。
  assert.deepEqual(detectProfile({ env: {}, pluginPath: '/Users/u/code/my-plugin/packages/p/lib/index.js' }), {
    name: 'default',
    source: 'default',
  });
});

test('defaultDataDir 按 profile 隔离，且不含任何写死的本机路径', () => {
  const dir = defaultDataDir({ DSH_HOME: '/tmp/dsh-home', DSH_PROFILE: 'web' });
  assert.equal(dir, path.join(path.resolve('/tmp/dsh-home'), 'customer-service', 'web'));
  // 显式 profile 覆盖环境变量推导。
  assert.equal(
    defaultDataDir({ DSH_HOME: '/tmp/dsh-home', DSH_PROFILE: 'desktop' }, 'cs-web'),
    path.join(path.resolve('/tmp/dsh-home'), 'customer-service', 'cs-web'),
  );
});

test('resolveDataDir 优先级：settings > 环境变量 > 默认', () => {
  const env = { DSH_HOME: '/tmp/dsh-home', DSH_PROFILE: 'p1', DSH_CS_DIR: '/tmp/env-dir' };
  assert.equal(resolveDataDir({ settingsDataDir: '/tmp/settings-dir', env }), path.resolve('/tmp/settings-dir'));
  assert.equal(resolveDataDir({ settingsDataDir: '  ', env }), path.resolve('/tmp/env-dir'));
  assert.equal(
    resolveDataDir({ env: { DSH_HOME: '/tmp/dsh-home', DSH_PROFILE: 'p1' } }),
    path.join(path.resolve('/tmp/dsh-home'), 'customer-service', 'p1'),
  );
  assert.equal(
    resolveDataDir({ env: { DSH_HOME: '/tmp/dsh-home', DSH_PROFILE: 'p1' }, profile: 'cs-web' }),
    path.join(path.resolve('/tmp/dsh-home'), 'customer-service', 'cs-web'),
  );
});

test('resolveDataDir 相对路径会被解析成绝对路径', () => {
  const resolved = resolveDataDir({ settingsDataDir: 'data/x', env: {} });
  assert.ok(path.isAbsolute(resolved));
});
