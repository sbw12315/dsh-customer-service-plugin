import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply, inject, name, VERSION } from '../lib/index.js';

/**
 * 造一个只实现插件用到的那部分能力的 Cordis ctx。
 * @param {{subprocess?: boolean}} [options] - 是否提供 subprocess 服务。
 * @returns {object} ctx 与录制到的调用。
 */
function fakeContext(options = {}) {
  const routes = [];
  const effects = [];
  const spawns = [];
  const withSubprocess = options.subprocess !== false;

  const subprocess = withSubprocess
    ? {
        resolveExecutable: async (command) => `/fake/bin/${command}`,
        spawn(spec) {
          spawns.push(spec);
          const text = String(spec.argv[0]).includes('ziniao')
            ? 'ziniao-cli version 1.1.3\n'
            : 'lark-cli version 1.0.71\n';
          return {
            done: Promise.resolve({ exitCode: 0, signal: null }),
            collected: {
              stdout: { readFrom: () => ({ text, nextOffset: 0, lossy: false }) },
              stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
            },
          };
        },
      }
    : undefined;

  return {
    routes,
    effects,
    spawns,
    effect(fn, label) {
      effects.push(label);
      return fn();
    },
    on() {},
    get: (key) => (key === 'subprocess' ? subprocess : undefined),
    webServer: {
      register(route) {
        routes.push(route);
        return () => {};
      },
    },
  };
}

/** 起服务并跑一段断言，然后关掉。 */
async function withPlugin(run, pluginOptions = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-plugin-'));
  process.env.DSH_CS_DIR = dataDir;
  if (pluginOptions.settings) {
    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      `${JSON.stringify(pluginOptions.settings, null, 2)}\n`,
      'utf8',
    );
  }
  try {
    const ctx = fakeContext(pluginOptions);
    apply(ctx);
    assert.equal(ctx.routes.length, 1, '应该只注册一条路由');
    const route = ctx.routes[0];
    const server = http.createServer(route.handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      await run({ base: `http://127.0.0.1:${port}`, route, dataDir, ctx });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    delete process.env.DSH_CS_DIR;
  }
}

test('插件导出契约：name / inject / apply / VERSION', () => {
  assert.equal(name, 'customer-service');
  assert.deepEqual(inject, ['webServer']);
  assert.equal(typeof apply, 'function');
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test('挂载一条 /cs 前缀路由，并把出厂剧本种进数据目录', async () => {
  await withPlugin(async ({ route, dataDir }) => {
    assert.equal(route.kind, 'prefix');
    assert.equal(route.path, '/cs');
    const seeded = fs.readdirSync(path.join(dataDir, 'playbooks')).sort();
    assert.deepEqual(seeded, ['amazon.message.json', 'tiktok.message.json', 'walmart.message.json']);
    for (const sub of ['drafts', 'run']) {
      assert.ok(fs.existsSync(path.join(dataDir, sub)), `缺少 ${sub}`);
    }
  });
});

test('GET /cs/api/health 返回结构化的体检数据', async () => {
  await withPlugin(async ({ base, dataDir, ctx }) => {
    const res = await fetch(`${base}/cs/api/health`);
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.data.plugin.id, 'customer-service');
    assert.equal(payload.data.plugin.version, VERSION);
    assert.equal(payload.data.dataDir, dataDir);
    assert.equal(payload.data.settingsFile, path.join(dataDir, 'settings.json'));
    assert.deepEqual(Object.keys(payload.data.clis).sort(), ['lark', 'ziniao']);
    assert.ok(['env', 'path', 'default'].includes(payload.data.profileSource));
    assert.equal(typeof payload.data.profile, 'string');
    assert.ok(payload.data.profile.length > 0);
    assert.ok(payload.data.runtime.dshVersion === null || typeof payload.data.runtime.dshVersion === 'string');

    for (const [key, info] of Object.entries(payload.data.clis)) {
      assert.equal(info.key, key);
      assert.equal(info.found, true);
      assert.equal(info.via, 'PATH');
      assert.match(info.path, new RegExp(`/${info.bin}$`));
      assert.match(info.version, /version \d+\.\d+\.\d+/);
      assert.equal(info.error, null);
    }

    // 关键回归：子进程的 argv[0] 必须是 CLI 可执行文件本身。
    // 早期版本传的是 argv: ['--version']，真实运行时就是 `spawn --version ENOENT`。
    assert.equal(ctx.spawns.length, 2);
    for (const spec of ctx.spawns) {
      assert.notEqual(spec.argv[0], '--version', 'argv[0] 不能是参数');
      assert.match(spec.argv[0], /\/fake\/bin\/(ziniao-cli|lark-cli)$/);
      assert.equal(spec.argv[1], '--version');
      assert.equal(spec.stdio.stdin, 'ignore');
      assert.ok(spec.env.PATH, '必须给子进程带上 PATH，ziniao-cli 的 #!/usr/bin/env node 依赖它');
    }
  });
});

test('CLI 附加参数会前置到每一次调用之前（GEMEE 身份就靠它）', async () => {
  await withPlugin(
    async ({ ctx, base }) => {
      // 探测是在体检请求里触发的，所以先请求再断言。
      const payload = await (await fetch(`${base}/cs/api/health`)).json();
      assert.equal(ctx.spawns.length, 2, '两个 CLI 各探测一次');
      const byBin = Object.fromEntries(
        ctx.spawns.map((spec) => [spec.argv[0].includes('ziniao') ? 'ziniao' : 'lark', spec.argv]),
      );
      // 没配附加参数的 CLI 保持原样。
      assert.deepEqual(byBin.ziniao, ['/fake/bin/ziniao-cli', '--version']);
      // 配了的 CLI：附加参数在 --version 之前 —— 实测 `lark-cli --profile X --version`
      // 合法，而 `lark-cli --version --profile X` 会失败。
      assert.deepEqual(byBin.lark, [
        '/fake/bin/lark-cli',
        '--profile',
        'example-lark-profile',
        '--version',
      ]);

      // 界面上也要能看到生效的附加参数。
      assert.deepEqual(payload.data.clis.lark.args, ['--profile', 'example-lark-profile']);
      assert.deepEqual(payload.data.clis.ziniao.args, []);
    },
    { settings: { cliArgs: { lark: '--profile example-lark-profile' } } },
  );
});

test('宿主没有 subprocess 时，体检仍能返回并如实标注缺失', async () => {
  await withPlugin(
    async ({ base }) => {
      const payload = await (await fetch(`${base}/cs/api/health`)).json();
      assert.equal(payload.ok, true);
      assert.equal(payload.data.runtime.services.subprocess, false);
      // 即使本机装了 CLI，没有 subprocess 也只能降级报告，不能抛异常。
      for (const info of Object.values(payload.data.clis)) {
        if (info.found) assert.equal(info.error.kind, 'unavailable');
        else assert.equal(info.error.kind, 'missing');
      }
    },
    { subprocess: false },
  );
});

test('GET /cs/api/settings 回读设置；POST 保存后令牌校验生效', async () => {
  await withPlugin(async ({ base }) => {
    const token = (await (await fetch(`${base}/cs/`)).text()).match(/name="cs-token" content="([0-9a-f]+)"/)?.[1];
    assert.ok(token, '入口页里应该有控制台令牌');

    const read = await (await fetch(`${base}/cs/api/settings`)).json();
    assert.equal(read.data.settings.cliPaths.lark, null);

    const denied = await fetch(`${base}/cs/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cliPaths: { lark: '/tmp/lark-cli' } }),
    });
    assert.equal(denied.status, 403);

    const saved = await (
      await fetch(`${base}/cs/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cs-token': token },
        body: JSON.stringify({ cliPaths: { lark: '/tmp/lark-cli' } }),
      })
    ).json();
    assert.equal(saved.data.settings.cliPaths.lark, '/tmp/lark-cli');

    const again = await (await fetch(`${base}/cs/api/settings`)).json();
    assert.equal(again.data.settings.cliPaths.lark, '/tmp/lark-cli');
    const onDisk = JSON.parse(fs.readFileSync(read.data.file, 'utf8'));
    assert.equal(onDisk.cliPaths.lark, '/tmp/lark-cli');
  });
});

test('改动数据目录后热切换并新建目录骨架', async () => {
  await withPlugin(async ({ base, dataDir }) => {
    const token = (await (await fetch(`${base}/cs/`)).text()).match(/name="cs-token" content="([0-9a-f]+)"/)?.[1];
    const next = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-plugin-next-'));
    const saved = await (
      await fetch(`${base}/cs/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cs-token': token },
        body: JSON.stringify({ dataDir: next }),
      })
    ).json();
    assert.equal(saved.data.dataDirChanged, true);
    assert.equal(saved.data.dataDir, next);
    assert.ok(fs.existsSync(path.join(next, 'playbooks', 'tiktok.message.json')));

    const health = await (await fetch(`${base}/cs/api/health`)).json();
    assert.equal(health.data.dataDir, next);
    fs.rmSync(next, { recursive: true, force: true });
  });
});

test('保存设置后运行中的 CLI 客户端立刻用新参数（不再需要重启）', async () => {
  await withPlugin(
    async ({ base, ctx }) => {
      const token = (await (await fetch(`${base}/cs/`)).text()).match(/name="cs-token" content="([0-9a-f]+)"/)?.[1];
      assert.ok(token, '入口页里应该有控制台令牌');
      const scan = () =>
        fetch(`${base}/cs/api/patrol/scan`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-cs-token': token },
          body: JSON.stringify({ channels: ['lark-mail'] }),
        });
      const lastMailArgs = () =>
        ctx.spawns.filter((spec) => spec.argv.includes('accessible_mailboxes')).pop()?.argv ?? [];

      // 先扫一次：让 lark 客户端把定位结果（里面带着 cliArgs）缓存下来。
      await scan();
      const before = lastMailArgs();
      assert.ok(before.includes('old-profile'), `首次应当用旧 profile：${before.join(' ')}`);
      assert.ok(before.some((arg) => arg.includes('old@example.com')), '首次应当用旧邮箱');

      const saved = await fetch(`${base}/cs/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cs-token': token },
        body: JSON.stringify({ cliArgs: { lark: '--profile new-profile' }, mailboxes: 'new@example.com' }),
      });
      assert.equal(saved.status, 200);

      // 再扫一次：这次必须用新参数。旧实现整体替换 runtime.settings，
      // 客户端捕获的还是旧对象、且定位缓存从不清，所以只能靠重启才生效。
      await scan();
      const after = lastMailArgs();
      assert.ok(after.includes('new-profile'), `改完设置应当立即用新 profile：${after.join(' ')}`);
      assert.ok(after.some((arg) => arg.includes('new@example.com')), '应当用新配置的邮箱');
      assert.ok(!after.includes('old-profile'), '不该再用旧 profile');
      assert.ok(!after.some((arg) => arg.includes('old@example.com')), '不该再用旧邮箱');
    },
    { settings: { cliArgs: { lark: '--profile old-profile' }, mailboxes: 'old@example.com' } },
  );
});
