import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { apply, groupSkippedByPlatform, inject, name, summarizeSkipped, VERSION } from '../lib/index.js';

/**
 * 造一个**行为像真实 Cordis** 的 ctx：未 provide 的属性**赋值即抛**。
 *
 * 为什么需要它：真实的 Cordis ctx 是 Proxy，给一个没声明过的属性赋值会直接抛
 *   Error: cannot set property "xxx" without provide
 * 而 apply() 是插件的**激活函数** —— 在那里抛出去，整个插件就挂不上（控制台路由不注册、
 * 界面全白，宿主只留一行 warning）。这个坑真实发生过：一个测试专用钩子
 * `ctx.pluginRuntime = runtime` 在全部单测里都是绿的（假的 ctx 是普通对象，赋值不报错），
 * 一到真实宿主就让插件激活失败。
 *
 * 所以这份替身刻意**比真实宿主更严格**：任何未声明的属性赋值都会抛，
 * 让「只有真实 ctx 才会炸」的写法在单测阶段就暴露出来。
 * @param {{subprocess?: boolean}} [options] - 是否提供 subprocess 服务。
 * @returns {object} ctx 与录制到的调用。
 */
function strictContext(options = {}) {
  const inner = fakeContext(options);
  return new Proxy(inner, {
    set(target, prop, value) {
      if (!(prop in target)) {
        throw new Error(`cannot set property "${String(prop)}" without provide`);
      }
      target[prop] = value;
      return true;
    },
  });
}

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

test('激活时不能给真实 Cordis ctx 写未声明的属性（否则整个插件挂不上）', async () => {
  // 回归测试：真实宿主里 apply() 抛过一次
  //   Error: cannot set property "pluginRuntime" without provide
  // 后果是插件完全不激活：/cs 路由不注册、控制台页面全白，宿主只打一行 warning。
  // 那个写法在普通假 ctx 上是绿的（普通对象赋值不报错），所以必须有这一条严格替身来兜住。
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-strict-'));
  process.env.DSH_CS_DIR = dataDir;
  try {
    const ctx = strictContext();
    // 不抛 = 通过；抛了就是又有人在 apply() 里给 ctx 写属性了。
    apply(ctx);
    assert.equal(ctx.routes.length, 1, '严格 ctx 下也必须成功注册控制台路由');
    assert.equal(ctx.routes[0].path, '/cs');
    // 路由必须真的能用，不只是「注册了」。
    const server = http.createServer(ctx.routes[0].handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/cs/api/meta`);
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.data.version, VERSION);
      assert.ok(payload.data.dimensions.channels.includes('tiktok'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    delete process.env.DSH_CS_DIR;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('被跳过的目标按平台聚合：报的是平台数，不是店铺数', () => {
  // 「另有 N 个平台不会被巡逻」里的 N 必须是**平台数**。实测账号 72 家店 / 24 个平台，
  // 按店铺报会得到「64 个目标」——数字很大但看不出是什么，而且每个渠道各报一遍。
  const skipped = [
    { storeId: 'a', platformName: 'SHEIN-全球' },
    { storeId: 'b', platformName: 'SHEIN-全球' },
    { storeId: 'c', platformName: 'SHEIN-全球' },
    { storeId: 'd', platformName: 'Temu-中国卖家中心' },
    { storeId: 'e', platformName: '沃尔玛-全球' },
  ];
  const grouped = groupSkippedByPlatform(skipped);
  assert.equal(grouped.length, 3, '3 家 SHEIN 只算 1 个平台');
  assert.deepEqual(grouped[0], { platformName: 'SHEIN-全球', stores: 3 }, '按店铺数倒序');

  const summary = summarizeSkipped(skipped);
  assert.equal(summary.platforms, 3, '平台数');
  assert.equal(summary.stores, 5, '店铺数');
  assert.notEqual(summary.platforms, summary.stores, '两个口径不能混');

  // 缺 platformName 的不能丢，也不能变成 "undefined" 这种能看出来的脏字符串。
  assert.deepEqual(groupSkippedByPlatform([{ storeId: 'x' }]), [{ platformName: '未知平台', stores: 1 }]);
  // 空输入 / 非数组都要安全（界面上没扫过时就是空）。
  assert.deepEqual(groupSkippedByPlatform([]), []);
  assert.deepEqual(groupSkippedByPlatform(null), []);
  assert.deepEqual(summarizeSkipped(undefined), { byPlatform: [], platforms: 0, stores: 0 });
});

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
    {
      // 飞书邮箱默认关闭：这条测的是「设置改完立刻生效」，所以先把渠道打开。
      settings: { cliArgs: { lark: '--profile old-profile' }, mailboxes: 'old@example.com', mailEnabled: true },
    },
  );
});

test('飞书邮箱渠道默认关闭：扫描只回报未启用，且一次 CLI 都不调', async () => {
  await withPlugin(
    async ({ base, ctx }) => {
      const token = (await (await fetch(`${base}/cs/`)).text()).match(/name="cs-token" content="([0-9a-f]+)"/)?.[1];
      const scan = await (
        await fetch(`${base}/cs/api/patrol/scan`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-cs-token': token },
          body: JSON.stringify({ channels: ['lark-mail'] }),
        })
      ).json();

      const mail = scan.data['lark-mail'];
      assert.equal(mail.disabled, true, '默认应当回报未启用');
      assert.equal(mail.error, null, '未启用不是错误');
      assert.match(mail.hint, /设置/);
      assert.deepEqual(mail.items, []);

      // 渠道列表也要带上开关状态，界面才知道该画成「未启用」。
      const patrol = await (await fetch(`${base}/cs/api/patrol`)).json();
      const channel = patrol.data.channels.find((entry) => entry.id === 'lark-mail');
      assert.equal(channel.enabled, false);
      assert.equal(patrol.data.channels.find((entry) => entry.id === 'amazon').enabled, true, '亚马逊渠道不受影响');

      // 关着的渠道不该产生任何 CLI 调用。
      const mailCalls = ctx.spawns.filter((spec) => spec.argv.includes('accessible_mailboxes'));
      assert.deepEqual(mailCalls, []);
    },
    { settings: { mailboxes: 'support@example.com' } },
  );
});
