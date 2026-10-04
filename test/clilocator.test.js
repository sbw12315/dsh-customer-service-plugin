import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSearchPath,
  candidateNames,
  dedupe,
  isRunnable,
  locateCli,
  nvmBinDirs,
  probeDirs,
} from '../lib/clilocator.js';

/** 只认一个文件的假 fs。 */
function fsWithRunnable(target) {
  return {
    statSync: (file) => {
      if (file === target) return { isFile: () => true };
      throw new Error('ENOENT');
    },
    accessSync: () => {},
    readdirSync: () => {
      throw new Error('ENOENT');
    },
  };
}

test('candidateNames 在 Windows 上补 .cmd/.exe/.bat', () => {
  assert.deepEqual(candidateNames('ziniao-cli', 'darwin'), ['ziniao-cli']);
  assert.deepEqual(candidateNames('ziniao-cli', 'win32'), [
    'ziniao-cli.cmd',
    'ziniao-cli.exe',
    'ziniao-cli.bat',
    'ziniao-cli',
  ]);
});

test('nvmBinDirs 按版本号倒序，新版本优先', () => {
  const dirs = nvmBinDirs('/home/u', {
    fsApi: { readdirSync: () => ['v9.11.2', 'v24.12.0', 'v20.11.1'] },
  });
  assert.deepEqual(
    dirs.map((dir) => /node\/(v[^/]+)\/bin$/.exec(dir)?.[1]),
    ['v24.12.0', 'v20.11.1', 'v9.11.2'],
  );
  assert.ok(dirs[0].startsWith('/home/u/.nvm/versions/node/'));
});

test('nvmBinDirs 在没有 nvm 时安静地返回空数组', () => {
  assert.deepEqual(nvmBinDirs('/home/u', { fsApi: { readdirSync: () => { throw new Error('ENOENT'); } } }), []);
});

test('probeDirs 去重并包含标准安装位置', () => {
  const dirs = probeDirs({ env: { PATH: '/usr/bin:/opt/homebrew/bin' }, home: '/home/u', platform: 'linux' });
  assert.ok(dirs.includes('/opt/homebrew/bin'));
  assert.ok(dirs.includes('/usr/local/bin'));
  assert.ok(dirs.includes('/usr/bin'));
  assert.ok(dirs.includes('/home/u/.local/bin'));
  assert.equal(new Set(dirs).size, dirs.length);
});

test('buildSearchPath 让额外目录排在最前，且保留原 PATH', () => {
  const value = buildSearchPath({
    extraDirs: ['/custom/bin'],
    env: { PATH: '/usr/bin' },
    home: '/home/u',
    platform: 'linux',
  });
  const parts = value.split(':');
  assert.equal(parts[0], '/custom/bin');
  assert.ok(parts.includes('/usr/bin'));
});

test('dedupe 保序去重', () => {
  assert.deepEqual(dedupe(['/a', '/b', '/a', '', '/b']), ['/a', '/b']);
});

test('isRunnable 要求存在且可执行', () => {
  assert.equal(isRunnable('/x', { fsApi: fsWithRunnable('/x'), platform: 'linux' }), true);
  assert.equal(isRunnable('/y', { fsApi: fsWithRunnable('/x'), platform: 'linux' }), false);
  assert.equal(
    isRunnable('/x', { fsApi: { statSync: () => ({ isFile: () => true }), accessSync: () => { throw new Error('EACCES'); } }, platform: 'linux' }),
    false,
  );
});

test('locateCli：settings 手动指定的路径优先级最高', async () => {
  const result = await locateCli(
    { get: () => undefined },
    'ziniao',
    { cliPaths: { ziniao: '/custom/ziniao-cli' } },
    { env: { ZINIAO_CLI_PATH: '/env/ziniao-cli' }, fsApi: fsWithRunnable('/custom/ziniao-cli'), platform: 'linux' },
  );
  assert.equal(result.via, 'settings');
  assert.equal(result.path, '/custom/ziniao-cli');
  assert.equal(result.found, true);
  assert.equal(result.label, '紫鸟CLI');
});

test('locateCli：环境变量次之', async () => {
  const result = await locateCli(
    { get: () => undefined },
    'lark',
    { cliPaths: {} },
    { env: { LARK_CLI_PATH: '/env/lark-cli' }, fsApi: fsWithRunnable('/env/lark-cli'), platform: 'linux' },
  );
  assert.equal(result.via, 'env');
  assert.equal(result.path, '/env/lark-cli');
});

test('locateCli：没有覆盖时退回常见目录探测', async () => {
  const target = '/opt/homebrew/bin/ziniao-cli';
  const result = await locateCli(
    { get: () => undefined },
    'ziniao',
    { cliPaths: {} },
    { env: { PATH: '/nowhere' }, home: '/home/u', fsApi: fsWithRunnable(target), platform: 'linux' },
  );
  assert.equal(result.via, 'probe');
  assert.equal(result.path, target);
  assert.ok(result.candidates.includes(target));
});

test('locateCli：优先用宿主的 resolveExecutable', async () => {
  let asked = null;
  const ctx = {
    get: (key) =>
      key === 'subprocess'
        ? {
            resolveExecutable: async (command, env) => {
              asked = { command, env };
              return '/resolved/by/path/lark-cli';
            },
          }
        : undefined,
  };
  const result = await locateCli(ctx, 'lark', { cliPaths: {} }, { env: { PATH: '/usr/bin' }, platform: 'linux' });
  assert.equal(result.via, 'PATH');
  assert.equal(result.path, '/resolved/by/path/lark-cli');
  assert.equal(asked.command, 'lark-cli');
  assert.ok(String(asked.env.PATH).includes('/usr/bin'));
});

test('locateCli：把附加参数挂在结果上，并且只认非空字符串', async () => {
  const result = await locateCli(
    { get: () => undefined },
    'lark',
    { cliPaths: { lark: '/custom/lark-cli' }, cliArgs: { lark: ['--profile', 'example-lark-profile', '', null] } },
    { env: {}, fsApi: fsWithRunnable('/custom/lark-cli'), platform: 'linux' },
  );
  assert.deepEqual(result.args, ['--profile', 'example-lark-profile']);
});

test('locateCli：没有附加参数时返回空数组', async () => {
  const result = await locateCli(
    { get: () => undefined },
    'ziniao',
    { cliPaths: { ziniao: '/custom/ziniao-cli' } },
    { env: {}, fsApi: fsWithRunnable('/custom/ziniao-cli'), platform: 'linux' },
  );
  assert.deepEqual(result.args, []);
});

test('locateCli：都找不到时给出安装命令，而不是抛异常', async () => {
  const result = await locateCli(
    { get: () => undefined },
    'ziniao',
    { cliPaths: {} },
    { env: { PATH: '/nowhere' }, home: '/home/u', fsApi: fsWithRunnable('/nope'), platform: 'linux' },
  );
  assert.equal(result.found, false);
  assert.equal(result.via, 'missing');
  assert.equal(result.path, null);
  assert.match(result.install, /@ziniao-open\/cli/);
});

test('locateCli 对未知 CLI 名报错', async () => {
  await assert.rejects(() => locateCli({ get: () => undefined }, 'nope', {}), /unknown cli/);
});
