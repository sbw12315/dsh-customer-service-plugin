import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROUTES, apply, intOf, matchPath, matchRoute } from '../lib/index.js';
import { formatClock, zonedMinutes } from '../lib/auto-patrol.js';
import { LOGIN_STATES, LOGIN_FORM_SELECTORS, createTikTokAdapter } from '../lib/platforms/tiktok.js';

/** 造一个只实现插件用到的那部分能力的 ctx。 */
function fakeContext() {
  const routes = [];
  const spawns = [];
  /**
   * 测试可以现场改这里，模拟真实运营动作：
   *   `fake.storeRows`     —— 紫鸟账号下的店铺（中途 push/splice 就等于「新增/删除了店铺」）
   *   `fake.failStoreList` —— 让 `store list` 失败，验证扫描失败时的降级
   *   `fake.storeUrl`      —— 各店当前页面地址（TikTok 的登录判据就是「页面停在哪」）
   *   `fake.storeTitle`    —— 各店当前页面标题
   */
  const fake = { storeRows: [], failStoreList: false, storeUrl: {}, storeTitle: {}, formAttempts: [], waits: [] };

  /** 真实实测过的两种 URL：停在登录页 = 未登录；停在商家中心 = 已登录。 */
  const LOGIN_URL = 'https://seller.tiktokshopglobalselling.com/account/login';
  const HOME_URL = 'https://seller.us.tiktokshopglobalselling.com/chat/inbox/current?shop_region=US';

  const subprocess = {
    resolveExecutable: async (command) => `/fake/bin/${command}`,
    spawn(spec) {
      spawns.push(spec);
      const isZiniao = String(spec.argv[0]).includes('ziniao');
      const isStoreList = isZiniao && spec.argv.includes('store') && spec.argv.includes('list');
      const isPageExec = isZiniao && spec.argv.includes('page') && spec.argv.includes('exec');
      let text = isZiniao ? 'ziniao-cli version 1.1.3\n' : 'lark-cli version 1.0.71\n';
      let errText = '';
      let exitCode = 0;
      if (isStoreList) {
        if (fake.failStoreList) {
          exitCode = 1;
          text = '';
          errText = 'Error: 紫鸟客户端未登录\n';
        } else {
          text = JSON.stringify({ ok: true, data: { items: fake.storeRows } });
        }
      } else if (isPageExec) {
        // checkLogin 只读 location.href（不点、不填）；openLogin 还会读 document.title。
        const script = spec.argv[spec.argv.indexOf('--script') + 1] ?? '';
        const storeId = spec.argv[spec.argv.indexOf('--store-id') + 1] ?? '';
        if (script === 'location.href') {
          text = JSON.stringify({ ok: true, data: { result: fake.storeUrl[storeId] ?? HOME_URL } });
        } else if (script === 'document.title') {
          text = JSON.stringify({ ok: true, data: { result: fake.storeTitle[storeId] ?? 'TikTok Shop Seller Center' } });
        } else {
          // 登录表单的任何一次点击/输入都会被记下来 —— 有一条测试专门断言它是空的。
          fake.formAttempts.push(spec.argv.join(' '));
          text = JSON.stringify({ ok: true, data: { result: null } });
        }
      }
      return {
        done: Promise.resolve({ exitCode, signal: null }),
        collected: {
          stdout: { readFrom: () => ({ text, nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: errText, nextOffset: 0, lossy: false }) },
        },
      };
    },
  };
  /**
   * 把「等登录」卡在挂起状态 —— 生产里它默认等 5 分钟，测试不能真等。
   * 每次调用推一条记录：settled=false 表示 HTTP 响应回来时它**还挂着**，
   * 这正是「后台等人、不阻塞请求」最直接的证据。
   */
  const waits = [];
  const patchLoginHolds = (pluginRuntime) => {
    for (const adapter of Object.values(pluginRuntime?.adapters ?? {})) {
      if (typeof adapter.waitForLogin !== 'function') continue;
      adapter.waitForLogin = (store, opts = {}) =>
        new Promise((resolve) => {
          const entry = { storeId: store?.storeId ?? '', opts, settled: false, resolve };
          waits.push(entry);
          const settle = (value) => {
            entry.settled = true;
            resolve(value);
          };
          entry.resolve = settle;
        });
    }
  };

  return {
    routes,
    spawns,
    fake,
    waits,
    patchLoginHolds,
    effect: (fn) => fn(),
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

/** 起插件并跑一段断言。 */
async function withPlugin(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-routes-'));
  process.env.DSH_CS_DIR = dataDir;
  try {
    const ctx = fakeContext();
    apply(ctx);
    // 插件把整套服务挂在 ctx 上（apply 的返回值是 void）；测试从这里拿到 runtime，
    // 好把「等登录」换成挂起版本 —— 生产里它要等 5 分钟。
    const pluginRuntime = ctx.pluginRuntime;
    if (pluginRuntime) ctx.patchLoginHolds(pluginRuntime);
    const server = http.createServer(ctx.routes[0].handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    const html = await (await fetch(`${base}/cs/`)).text();
    const token = /name="cs-token" content="([0-9a-f]+)"/.exec(html)?.[1];
    assert.ok(token, '入口页应带控制台令牌');

    /** 便捷请求。 */
    const call = async (method, apiPath, body, { withToken = true } = {}) => {
      const headers = {};
      if (withToken) headers['x-cs-token'] = token;
      if (body !== undefined) headers['content-type'] = 'application/json';
      const res = await fetch(`${base}/cs/api${apiPath}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const payload = await res.json().catch(() => null);
      return { status: res.status, payload };
    };

    try {
      await run({ base, dataDir, ctx, token, call, waits: ctx.waits });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    delete process.env.DSH_CS_DIR;
  }
}

test('matchPath 处理单段参数、长度不符与百分号编码', () => {
  assert.deepEqual(matchPath('/queue/:id', '/queue/q_1'), { id: 'q_1' });
  assert.deepEqual(matchPath('/queue/:id', '/queue/q%5F1'), { id: 'q_1' });
  assert.equal(matchPath('/queue/:id', '/queue'), null);
  assert.equal(matchPath('/queue/:id', '/queue/a/b'), null);
  assert.equal(matchPath('/queue/:id', '/other/a'), null);
  assert.equal(matchPath('/queue/:id', '/queue/%E0%A4%A'), null, '坏编码不匹配');
  assert.deepEqual(matchPath('/health', '/health'), {});
});

test('matchRoute 区分方法与路径，未命中返回 null', () => {
  const routes = [
    { method: 'GET', path: '/health', handler: () => {} },
    { method: 'PATCH', path: '/queue/:id', handler: () => {} },
  ];
  assert.equal(matchRoute('GET', '/health', routes).route.path, '/health');
  assert.equal(matchRoute('POST', '/health', routes), null);
  assert.deepEqual(matchRoute('PATCH', '/queue/q1', routes).params, { id: 'q1' });
  assert.equal(matchRoute('GET', '/queue/q1', routes), null);
  assert.equal(matchRoute('GET', '/nope', routes), null);
});

test('intOf 夹在范围内并对非法值退回默认', () => {
  assert.equal(intOf('7', 14, 1, 90), 7);
  assert.equal(intOf('0', 14, 1, 90), 1);
  assert.equal(intOf('999', 14, 1, 90), 90);
  assert.equal(intOf(undefined, 14, 1, 90), 14);
  assert.equal(intOf('abc', 14, 1, 90), 14);
});

test('GET /api/meta 暴露维度与跃迁表，避免前后端各写一份', async () => {
  await withPlugin(async ({ call }) => {
    const { status, payload } = await call('GET', '/meta');
    assert.equal(status, 200);
    // 加了渠道就要改这里 —— 这个数组是队列页筛选项的真相源。
    assert.deepEqual(payload.data.dimensions.channels, ['mail', 'tiktok', 'walmart', 'shein', 'temu', 'amazon']);
    assert.ok(payload.data.dimensions.statuses.includes('needs_human'));
    assert.deepEqual(payload.data.transitions.new, ['drafted', 'needs_human', 'archived']);
    assert.equal(payload.data.transitions.new.includes('sent'), false);
  });
});

test('队列接口：新建 → 去重 → 查询 → 改状态 → 乐观锁', async () => {
  await withPlugin(async ({ call }) => {
    const empty = await call('GET', '/queue');
    assert.equal(empty.payload.data.total, 0);

    const created = await call('POST', '/queue', {
      subject: '订单 123 没发货',
      channel: 'tiktok',
      kind: 'message',
      idempotencyKey: 'k1',
    });
    assert.equal(created.status, 201);
    const id = created.payload.data.item.id;
    assert.equal(created.payload.data.item.status, 'new');
    assert.equal(typeof created.payload.data.rev, 'number');

    const again = await call('POST', '/queue', { subject: '重复', idempotencyKey: 'k1' });
    assert.equal(again.status, 200);
    assert.equal(again.payload.data.deduped, true);
    assert.equal(again.payload.data.item.id, id);

    const one = await call('GET', `/queue/${id}`);
    assert.equal(one.payload.data.item.subject, '订单 123 没发货');

    const missing = await call('GET', '/queue/q_nope');
    assert.equal(missing.status, 404);
    assert.match(missing.payload.error.message, /工单不存在/);

    const bad = await call('PATCH', `/queue/${id}`, { status: 'sent' });
    assert.equal(bad.status, 400);
    assert.match(bad.payload.error.message, /不允许从/);
    assert.deepEqual(bad.payload.error.allowed, ['drafted', 'needs_human', 'archived'], '错误里要带允许的下一状态');

    const ok = await call('PATCH', `/queue/${id}`, { status: 'drafted', assignee: '张三' });
    assert.equal(ok.status, 200);
    assert.equal(ok.payload.data.item.status, 'drafted');
    assert.equal(ok.payload.data.item.assignee, '张三');

    const staleRev = created.payload.data.rev;
    const conflict = await call('PATCH', `/queue/${id}`, { note: '旧版本提交', expectedRev: staleRev });
    assert.equal(conflict.status, 409);
    assert.match(conflict.payload.error.message, /已被其它操作修改/);
    assert.equal(typeof conflict.payload.error.currentRev, 'number');

    const filtered = await call('GET', '/queue?channel=tiktok&status=drafted');
    assert.equal(filtered.payload.data.total, 1);
    assert.equal(filtered.payload.data.counts.byStatus.drafted, 1);
  });
});

test('写操作缺令牌一律 403，读操作不需要令牌', async () => {
  await withPlugin(async ({ call }) => {
    const denied = await call('POST', '/queue', { subject: 'x' }, { withToken: false });
    assert.equal(denied.status, 403);
    const deniedPatch = await call('PATCH', '/queue/q_1', { note: 'x' }, { withToken: false });
    assert.equal(deniedPatch.status, 403);
    assert.equal((await call('GET', '/queue', undefined, { withToken: false })).status, 200);
  });
});

test('统计接口：空数据有引导标记，建工单后立刻反映', async () => {
  await withPlugin(async ({ call }) => {
    const before = await call('GET', '/stats?days=7');
    assert.equal(before.status, 200);
    assert.equal(before.payload.data.window.days, 7);
    assert.equal(before.payload.data.business.hasData, false);

    await call('POST', '/queue', { subject: '第一条', channel: 'mail' });
    const after = await call('GET', '/stats?days=7');
    assert.equal(after.payload.data.business.hasData, true);
    assert.equal(after.payload.data.business.total, 1);
    assert.equal(after.payload.data.business.today.created, 1);
    assert.equal(after.payload.data.runtime.series.length, 7);
  });
});

test('活动接口返回审计事件，且**不含任何密钥或命令输出**', async () => {
  await withPlugin(async ({ call, dataDir, token }) => {
    await call('GET', '/health'); // 触发一次体检，产生 cli 与 detect 事件
    await call('POST', '/queue', { subject: '有敏感标题的工单', channel: 'mail' });

    const { status, payload } = await call('GET', '/activity?limit=50');
    assert.equal(status, 200);
    const kinds = payload.data.items.map((entry) => entry.kind);
    assert.ok(kinds.includes('cli'), '应记录 CLI 调用');
    assert.ok(kinds.includes('detect'), '应记录体检');
    assert.ok(kinds.includes('ticket'), '应记录工单创建');

    // 事件里只能有元数据：不能出现令牌、不能出现 CLI 的原始输出、不能出现工单主题。
    const raw = fs
      .readdirSync(path.join(dataDir, 'audit'))
      .map((name) => fs.readFileSync(path.join(dataDir, 'audit', name), 'utf8'))
      .join('');
    assert.ok(raw.length > 0, '审计文件应该写下了东西');
    assert.equal(raw.includes(token), false, '审计里绝不能出现控制台令牌');
    assert.equal(raw.includes('ziniao-cli version'), false, '审计里不能带 CLI 的整行输出');
    assert.equal(raw.includes('lark-cli version'), false, '审计里不能带 CLI 的整行输出');
    assert.equal(raw.includes('有敏感标题的工单'), false, '审计里不能带工单正文');
    assert.ok(raw.includes('1.1.3'), '但版本号这种元数据应该保留');
  });
});

test('改数据目录后，队列与审计一起切到新目录', async () => {
  await withPlugin(async ({ call, dataDir }) => {
    await call('POST', '/queue', { subject: '旧目录的工单' });
    const next = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-routes-next-'));
    const saved = await call('POST', '/settings', { dataDir: next });
    assert.equal(saved.payload.data.dataDirChanged, true);
    assert.equal(saved.payload.data.dataDir, next);

    const list = await call('GET', '/queue');
    assert.equal(list.payload.data.total, 0, '新目录是空队列');
    assert.ok(fs.existsSync(path.join(next, 'playbooks', 'tiktok.message.json')), '新目录应补种剧本');
    assert.ok(fs.existsSync(path.join(dataDir, 'queue.json')), '旧目录文件保留，便于回查');
    fs.rmSync(next, { recursive: true, force: true });
  });
});

test('巡逻接口：状态可读、能启动、能停止，且草稿库为空时返回空列表', async () => {
  await withPlugin(async ({ call }) => {
    const before = await call('GET', '/patrol');
    assert.equal(before.status, 200);
    assert.equal(before.payload.data.running, false);
    assert.equal(before.payload.data.run, null);
    assert.equal(before.payload.data.lastRun, null, '一次都没跑过时没有「最近一次巡逻」');
    assert.ok(Array.isArray(before.payload.data.sources.amazon.items));
    assert.ok(Array.isArray(before.payload.data.channels), '要带上渠道清单');
    assert.ok(before.payload.data.defaults.maxPerStore >= 1);

    const drafts = await call('GET', '/drafts');
    assert.equal(drafts.status, 200);
    assert.deepEqual(drafts.payload.data.items, []);
    assert.equal(drafts.payload.data.total, 0);

    // 假 subprocess 只会回一行版本号，所以「店铺列表」是空的 —— 巡逻会立刻正常收工。
    const started = await call('POST', '/patrol', { maxPerStore: 2 });
    assert.equal(started.status, 202);
    assert.equal(started.payload.data.run.options.maxPerStore, 2);

    const stopped = await call('POST', '/patrol/stop', {});
    assert.equal(stopped.status, 200);
    assert.equal(typeof stopped.payload.data.stopped, 'boolean');

    // 「最近一次巡逻」必须报出来：前端靠它判断哪批草稿是刚生成的（要标色）。
    const after = await call('GET', '/patrol');
    assert.ok(after.payload.data.run, '跑过一次之后快照里就留着这次 run');
    assert.equal(after.payload.data.lastRun?.id, after.payload.data.run.id);
    assert.equal(after.payload.data.lastRun.draftsCreated, 0);
  });
});

test('重启后仍能认出「最近一次巡逻」：内存里没有 run 时从 patrol-last.json 兜底', async () => {
  await withPlugin(async ({ call, dataDir }) => {
    const runDir = path.join(dataDir, 'run');
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'patrol-last.json'),
      JSON.stringify({
        id: 'p_restart1',
        status: 'done',
        finishedAt: '2026-10-08T07:00:00.000Z',
        progress: { draftsCreated: 7 },
      }),
      'utf8',
    );
    const res = await call('GET', '/patrol');
    assert.equal(res.payload.data.run, null, '内存里确实没有 run');
    assert.deepEqual(res.payload.data.lastRun, {
      id: 'p_restart1',
      status: 'done',
      finishedAt: '2026-10-08T07:00:00.000Z',
      draftsCreated: 7,
    });
  });
});

test('在设置里禁用紫鸟CLI：一次都不调用它，亚马逊渠道回报未启用', async () => {
  await withPlugin(async ({ call, ctx }) => {
    const saved = await call('POST', '/settings', { cliEnabled: { ziniao: false } });
    assert.equal(saved.status, 200);
    assert.equal(saved.payload.data.settings.cliEnabled.ziniao, false, '开关要落进设置');
    assert.equal(saved.payload.data.settings.cliEnabled.lark, true, '另一个 CLI 不能被一起抹掉');

    const health = await call('GET', '/health');
    assert.equal(health.payload.data.clis.ziniao.enabled, false);
    assert.equal(health.payload.data.clis.ziniao.error, null, '禁用不是故障');
    assert.equal(health.payload.data.clis.lark.enabled, true);

    // 禁用的 CLI 一次都不该被调用。
    const before = ctx.spawns.length;
    const scan = await call('POST', '/patrol/scan', { channels: ['amazon'] });
    assert.equal(scan.payload.data.amazon.disabled, true);
    assert.equal(scan.payload.data.amazon.error, null, '未启用不是错误');
    assert.match(scan.payload.data.amazon.hint, /禁用/);
    assert.equal(ctx.spawns.length, before, '禁用的渠道不该触发任何子进程');

    const patrol = await call('GET', '/patrol');
    assert.equal(patrol.payload.data.channels.find((entry) => entry.id === 'amazon').enabled, false);

    // 重新启用后必须恢复。
    await call('POST', '/settings', { cliEnabled: { ziniao: true } });
    const back = await call('GET', '/health');
    assert.equal(back.payload.data.clis.ziniao.enabled, true);
  });
});

test('渠道级开关：停用只影响它自己、立即生效，且与 CLI 总开关分开报', async () => {
  await withPlugin(async ({ call, ctx }) => {
    ctx.fake.storeRows.push(
      { storeId: 'a1', storeName: 'Amazon-A', platformName: '亚马逊-美国' },
      { storeId: 't1', storeName: 'Tiktok-A', platformName: 'TikTok Shop-全球跨境(自运营)(新)' },
    );

    // ① 停用亚马逊：只提交一个键，别的渠道一个都不能被带走（第二层映射整块替换是踩过的坑）。
    const saved = await call('POST', '/settings', { channelEnabled: { amazon: false } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.payload.data.settings.channelEnabled, { amazon: false });
    assert.equal(saved.payload.data.settings.cliEnabled.ziniao, true, '渠道开关不是 CLI 开关');

    // ② 渠道表要**分开报**两个字段：enabled 是「现在跑不跑」，switchOn 是「这枚开关本身」。
    //    只有分开，界面才能在 CLI 被禁用时提示「去开 CLI」，而不是把开关画成关着让人白点。
    const patrol = await call('GET', '/patrol');
    const amazon = patrol.payload.data.channels.find((entry) => entry.id === 'amazon');
    assert.equal(amazon.enabled, false);
    assert.equal(amazon.switchOn, false);
    const tiktok = patrol.payload.data.channels.find((entry) => entry.id === 'tiktok');
    assert.equal(tiktok.enabled, true, '别的渠道不受影响');
    assert.equal(tiktok.switchOn, true);

    // ③ 扫描：回报「未启用」并说清是**渠道被停用**（不是 CLI 被禁用），且不触发任何子进程。
    const before = ctx.spawns.length;
    const scan = await call('POST', '/patrol/scan', { channels: ['amazon'] });
    assert.equal(scan.payload.data.amazon.disabled, true);
    assert.equal(scan.payload.data.amazon.error, null, '未启用不是错误');
    assert.match(scan.payload.data.amazon.hint, /巡逻页/);
    assert.equal(ctx.spawns.length, before, '停用的渠道不该触发任何子进程');

    // ④ 巡逻：点名带上它也跑不起来；一个渠道都没启用时要**明确报错**，而不是假装跑过。
    await call('POST', '/patrol', { channels: ['amazon'] });
    let run = null;
    for (let i = 0; i < 60; i += 1) {
      const state = await call('GET', '/patrol');
      run = state.payload.data.run;
      if (run && run.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(run, '要能拿到这次 run');
    assert.equal(run.status, 'failed');
    assert.match(run.error, /没有已启用的渠道/);

    // ⑤ 重新打开：立即恢复（不用重启），且别的渠道的开关一直没被动过。
    await call('POST', '/settings', { channelEnabled: { amazon: true } });
    const back = await call('GET', '/patrol');
    assert.equal(back.payload.data.channels.find((entry) => entry.id === 'amazon').enabled, true);
    assert.equal(back.payload.data.channels.find((entry) => entry.id === 'amazon').switchOn, true);
    // 底层的表要**稀疏**：只有亚马逊被显式写过，其余渠道一个键都不该进文件。
    // （飞书邮箱默认就是关的，但它不该因此被写进 channelEnabled —— 那是适配器的默认值。）
    const stored = await call('GET', '/settings');
    assert.deepEqual(stored.payload.data.settings.channelEnabled, { amazon: true });
  });
});

test('老的 mailEnabled 入口仍然有效，并且与巡逻页那枚开关写的是同一处真值', async () => {
  await withPlugin(async ({ call }) => {
    // 旧前端（或一个没刷新的标签页）提交的还是 mailEnabled —— 不能点了没反应。
    const saved = await call('POST', '/settings', { mailEnabled: true });
    assert.equal(saved.payload.data.settings.mailEnabled, true, '派生镜像要跟着变');
    assert.equal(saved.payload.data.settings.channelEnabled['lark-mail'], true, '真值在 channelEnabled 里');

    const patrol = await call('GET', '/patrol');
    const mail = patrol.payload.data.channels.find((entry) => entry.id === 'lark-mail');
    assert.equal(mail.switchOn, true, '巡逻页那一行的开关也要跟着亮');
    assert.equal(mail.enabled, true);

    // 反过来：巡逻页那枚开关写 channelEnabled，设置页读到的 mailEnabled 也要跟着变。
    await call('POST', '/settings', { channelEnabled: { 'lark-mail': false } });
    const settings = await call('GET', '/settings');
    assert.equal(settings.payload.data.settings.mailEnabled, false, '两个入口必须指向同一处真值');
  });
});

test('草稿接口：写操作要令牌，改不存在的草稿返回 404', async () => {
  await withPlugin(async ({ call }) => {
    const forbidden = await call('PATCH', '/drafts/d_x', { body: 'hi' }, { withToken: false });
    assert.equal(forbidden.status, 403);

    const missing = await call('PATCH', '/drafts/d_x', { body: 'hi' });
    assert.equal(missing.status, 404);

    const missingFill = await call('POST', '/drafts/d_x/fill', {});
    assert.equal(missingFill.status, 404);
  });
});

test('「另有 N 个平台」的 N 是平台数，不是店铺数', async () => {
  // 这条用例刻意让「平台数 ≠ 店铺数」，否则两个口径混用也测不出来：
  // 同一平台下放 3 家非亚马逊店 → 平台数必须是 1，店铺数必须是 3。
  await withPlugin(async ({ call, ctx }) => {
    ctx.fake.storeRows.push(
      { storeId: 'amz', storeName: 'Amazon-X', platformName: '亚马逊-美国' },
      { storeId: 's1', storeName: 'SHEIN-1', platformName: 'SHEIN-全球' },
      { storeId: 's2', storeName: 'SHEIN-2', platformName: 'SHEIN-全球' },
      { storeId: 's3', storeName: 'SHEIN-3', platformName: 'SHEIN-全球' },
      { storeId: 't1', storeName: 'TEMU-1', platformName: 'Temu-中国卖家中心' },
    );
    const { payload } = await call('POST', '/patrol/scan', {});
    const amz = payload.data.amazon;

    assert.equal(amz.skippedStores, 4, '被跳过的店铺数：3 家 SHEIN + 1 家 Temu');
    assert.equal(amz.skippedPlatforms, 2, '被跳过的平台数：SHEIN 与 Temu（3 家 SHEIN 只算 1 个平台）');
    assert.deepEqual(
      amz.skippedByPlatform,
      [
        { platformName: 'SHEIN-全球', stores: 3 },
        { platformName: 'Temu-中国卖家中心', stores: 1 },
      ],
      '按店铺数倒序，且每家平台的店数要对',
    );

    // TikTok 渠道看的是同一份全量列表：除 TikTok 外的平台都算「不会被 TikTok 巡逻」，
    // 所以这里是亚马逊 + SHEIN + Temu = 3 个平台、5 家店。
    const tt = payload.data.tiktok;
    assert.equal(tt.skippedPlatforms, 3, '亚马逊 + SHEIN + Temu');
    assert.equal(tt.skippedStores, 5, '5 家店（没有 TikTok 店）');
    assert.ok(tt.skippedByPlatform.some((entry) => entry.platformName === '亚马逊-美国'));
  });
});

test('扫描可用店铺：认得出新增的亚马逊店，并把非亚马逊店列进 skipped', async () => {
  await withPlugin(async ({ call, ctx }) => {
    ctx.fake.storeRows.push(
      { storeId: 'a', storeName: 'Amazon-Cozynome-管理员', platformName: '亚马逊-美国' },
      { storeId: 'b', storeName: 'Walmart-Cozynome-管理员', platformName: '沃尔玛-全球' },
    );

    const first = await call('POST', '/patrol/scan', {});
    assert.equal(first.status, 200);
    // 返回的是「渠道 id → 扫描结果」，亚马逊渠道之外还有飞书邮箱渠道。
    const one = first.payload.data.amazon;
    assert.equal(one.total, 2, 'total 是全量店铺数');
    assert.deepEqual(one.items.map((store) => store.storeId), ['a'], 'items 只放能巡逻的亚马逊店');
    assert.deepEqual(one.skipped.map((store) => store.storeId), ['b']);
    assert.match(one.skipped[0].reason, /亚马逊/);
    // 界面那句「另有 N 个平台（M 家店）不会被巡逻」：N 是平台数、M 是店铺数。
    // 这条断言把两个口径钉死 —— 混用会得到「另有 1 个平台」，而实际是 1 个平台 1 家店，
    // 数字看着对但语义完全不同（改成两家店时就会露馅，见下）。
    assert.equal(one.skippedPlatforms, 1, 'N 是平台数');
    assert.equal(one.skippedStores, 1, 'M 是店铺数');
    assert.deepEqual(one.skippedByPlatform, [{ platformName: '沃尔玛-全球', stores: 1 }]);
    assert.deepEqual(one.added, [], '首次扫描没有基准，不该报「新增」');
    assert.deepEqual(one.removed, []);
    assert.equal(one.error, null);
    assert.ok(first.payload.data['lark-mail'], '飞书邮箱渠道也要在结果里（未授权时带 error）');

    // 运营在紫鸟里新增了一家亚马逊店
    ctx.fake.storeRows.push({ storeId: 'c', storeName: 'Amazon-FUSOU-客服', platformName: '亚马逊-美国' });
    const second = await call('POST', '/patrol/scan', {});
    assert.deepEqual(second.payload.data.amazon.added.map((store) => store.storeId), ['c']);
    assert.equal(second.payload.data.amazon.items.length, 2);

    // 又移除了一家
    ctx.fake.storeRows.splice(0, 1);
    const third = await call('POST', '/patrol/scan', {});
    assert.deepEqual(third.payload.data.amazon.removed.map((store) => store.storeId), ['a']);
    assert.deepEqual(third.payload.data.amazon.items.map((store) => store.storeId), ['c']);
  });
});

test('扫描：TikTok 渠道按自己的判定取店，不被亚马逊的过滤清空', async () => {
  // 这是集成期真实踩到的坑：scanChannel 原先把 isAmazonStore 写死在过滤里，
  // 于是每加一个店铺渠道，新渠道的 items 都会被亚马逊的判定过滤成 0 个目标 ——
  // 表现是「TikTok 渠道明明有 6 家店，界面却永远是 0」，而且不报错。
  await withPlugin(async ({ call, ctx }) => {
    ctx.fake.storeRows.push(
      { storeId: 'tt1', storeName: 'Tiktok-FUSOU-客服主号', platformName: 'TikTok Shop-全球跨境(自运营)(新)' },
      { storeId: 'tt2', storeName: 'Tiktok-FUSOU-客服KX', platformName: 'TikTok Shop-全球跨境(自运营)（旧）' },
      { storeId: 'amz1', storeName: 'Amazon-Cozynome-管理员', platformName: '亚马逊-美国' },
      { storeId: 'wm1', storeName: 'Walmart-Cozynome-管理员', platformName: '沃尔玛-全球' },
      // 实机里就有这两家挂着「停用」的店：它们既不该进 items，也不该混进 skipped（那会说成「平台未接入」）。
      { storeId: 'wm-old', storeName: 'Walmart-Yanosaku-已停用', platformName: '沃尔玛-全球' },
      { storeId: 'amz-old', storeName: 'Amazon-FUSOU-停用', platformName: '亚马逊-美国' },
    );

    const { payload } = await call('POST', '/patrol/scan', {});
    const tiktok = payload.data.tiktok;
    const amazon = payload.data.amazon;
    const walmart = payload.data.walmart;

    assert.deepEqual(tiktok.items.map((s) => s.storeId), ['tt1', 'tt2'], 'TikTok 渠道要拿到两家 TikTok 店');
    assert.deepEqual(amazon.items.map((s) => s.storeId), ['amz1'], '亚马逊渠道不受影响');
    // 沃尔玛渠道按自己的判定取店：platformName 是「沃尔玛-全球」，店铺名是 Walmart-*。
    assert.deepEqual(walmart.items.map((s) => s.storeId), ['wm1'], '沃尔玛渠道要拿到沃尔玛店');
    assert.equal(tiktok.total, 6, 'total 仍是全量店铺数（含停用店）');
    assert.equal(walmart.total, 6, 'total 对每个渠道都是同一份全量清单');

    // 停用店单列一栏：只列**本渠道的**，且既不在 items 里、也不在 skipped 里。
    assert.deepEqual(tiktok.retired, [], 'TikTok 渠道没有停用店');
    assert.deepEqual(amazon.retired.map((s) => s.storeId), ['amz-old']);
    assert.deepEqual(walmart.retired.map((s) => s.storeId), ['wm-old']);
    assert.equal(walmart.retiredStores, 1);
    assert.match(walmart.retired[0].reason, /停用/, 'reason 要说清是「店停用了」，不是「平台没接」');
    for (const scan of [tiktok, amazon, walmart]) {
      assert.equal(scan.items.some((s) => /停用/.test(s.storeName)), false, '停用店不能出现在巡逻目标里');
      assert.equal(scan.skipped.some((s) => /停用/.test(s.storeName)), false, '停用店不能混进「平台未接入」');
    }

    // 三个渠道的 skipped 正好互补：谁都不该把对方的店算成「未接入」。
    assert.deepEqual(tiktok.skipped.map((s) => s.storeId).sort(), ['amz1', 'wm1']);
    assert.deepEqual(amazon.skipped.map((s) => s.storeId).sort(), ['tt1', 'tt2', 'wm1']);
    assert.deepEqual(walmart.skipped.map((s) => s.storeId).sort(), ['amz1', 'tt1', 'tt2']);
    assert.match(tiktok.skipped[0].reason, /TikTok Shop/, 'reason 要说清是哪个渠道的店');
    assert.match(walmart.skipped[0].reason, /沃尔玛/, 'reason 要说清是哪个渠道的店');
    assert.equal(tiktok.items.some((s) => /amazon|walmart/i.test(s.platformName)), false, 'TikTok 渠道不能混进别的平台');
    assert.equal(walmart.items.some((s) => /amazon|tiktok/i.test(s.platformName)), false, '沃尔玛渠道不能混进别的平台');
  });
});

test('/health 的渠道校准位：已校准的渠道也要写清「尚未覆盖什么」', async () => {
  await withPlugin(async ({ call }) => {
    const health = await call('GET', '/health');
    const calibration = health.payload.data.channelCalibration;
    assert.ok(calibration.walmart, '沃尔玛要出现在校准位里（有 calibrationNote）');
    assert.equal(calibration.walmart.verified, true, '2026-10-10 已在真实的登录态 DOM 上校准');
    assert.match(calibration.walmart.note, /已校准/, '要说清校准现场');
    assert.match(calibration.walmart.note, /深链|尚未/, '没覆盖的部分也要写出来');
    assert.equal(calibration.tiktok.verified, true, 'TikTok 同样已校准');
    assert.equal(calibration.amazon, undefined, '亚马逊没有 calibrationNote，不该出现在校准位里');
  });
});

test('渠道清单里注册了 TikTok，且草稿深链按平台分派（TikTok 给空串、亚马逊照旧）', async () => {
  await withPlugin(async ({ call, dataDir }) => {
    const patrol = await call('GET', '/patrol');
    const ids = patrol.payload.data.channels.map((c) => c.id);
    assert.ok(ids.includes('tiktok'), 'TikTok 渠道要注册进渠道表');
    assert.ok(ids.includes('walmart'), '沃尔玛渠道也要注册进渠道表');
    const tiktok = patrol.payload.data.channels.find((c) => c.id === 'tiktok');
    assert.equal(tiktok.label, 'TikTok Shop');
    assert.equal(tiktok.kind, 'store');
    assert.equal(tiktok.enabled, true);
    const walmart = patrol.payload.data.channels.find((c) => c.id === 'walmart');
    assert.equal(walmart.label, '沃尔玛');
    assert.equal(walmart.kind, 'store');
    assert.equal(walmart.enabled, true);

    // 深链由服务端按平台拼：TikTok 草稿原先恒为 null，抽屉里的「打开原会话」永远不出现。
    const draftsDir = path.join(dataDir, 'drafts');
    fs.mkdirSync(draftsDir, { recursive: true });
    fs.writeFileSync(
      path.join(draftsDir, 'drafts.json'),
      JSON.stringify({
        version: 1,
        rev: 1,
        items: [
          { id: 'd_tt', platform: 'tiktok', storeId: 'tt1', storeName: 'Tiktok-X', caseId: 'conv-1', buyer: 'a', status: 'draft', body: 'x', timeline: [] },
          { id: 'd_amz', platform: 'amazon', storeId: 'amz1', storeName: 'Amazon-X', caseId: 'cc-1', buyer: 'b', status: 'draft', body: 'y', timeline: [] },
          { id: 'd_mail', platform: 'lark-mail', storeId: 'm@x.com', storeName: 'm@x.com', caseId: 'th-1', buyer: 'c', status: 'draft', body: 'z', timeline: [] },
          { id: 'd_wm', platform: 'walmart', storeId: 'wm1', storeName: 'Walmart-Cozynome-管理员', caseId: '', buyer: 'd', status: 'draft', body: 'w', timeline: [] },
        ],
      }),
      'utf8',
    );

    // TikTok 走自己的 CASE_URL_BUILDERS 分支，但**实测该平台没有会话级深链**
    // （点不同会话 URL 恒为 /chat/inbox/current），所以结果必须是 falsy —— 界面据此隐藏入口。
    // 关键是它不能落进 amazon 的模板（那会打开一个亚马逊链接）。
    const tt = await call('GET', '/drafts/d_tt');
    assert.equal(tt.payload.data.item.caseUrl, '', 'TikTok 没有稳定深链：给空串而不是编一个');
    assert.equal(/amazon/.test(String(tt.payload.data.item.caseUrl)), false, '不能落进亚马逊模板');

    const amz = await call('GET', '/drafts/d_amz');
    assert.match(amz.payload.data.item.caseUrl, /sellercentral\.amazon\.com/, '亚马逊仍走自己的模板');

    const mail = await call('GET', '/drafts/d_mail');
    assert.equal(mail.payload.data.item.caseUrl, null, '邮箱没有稳定深链，保持 null');

    // 沃尔玛同样没有已校准的会话级深链：给空串，且绝不能落进亚马逊/ TikTok 的模板。
    const wm = await call('GET', '/drafts/d_wm');
    assert.equal(wm.payload.data.item.caseUrl, '', '沃尔玛没有稳定深链：给空串而不是编一个');
    assert.equal(/amazon|tiktok/.test(String(wm.payload.data.item.caseUrl)), false, '不能落进别的平台模板');
  });
});

test('填回复框按平台分派：邮件草稿被明确指路，而不是含糊的失败', async () => {
  await withPlugin(async ({ call, dataDir }) => {
    const draftsDir = path.join(dataDir, 'drafts');
    fs.mkdirSync(draftsDir, { recursive: true });
    fs.writeFileSync(
      path.join(draftsDir, 'drafts.json'),
      JSON.stringify({
        version: 1,
        rev: 1,
        items: [
          { id: 'd_mail', platform: 'lark-mail', storeId: 'm@x.com', storeName: 'm@x.com', caseId: 'th-1', buyer: 'c', status: 'draft', body: 'z', timeline: [] },
          { id: 'd_ghost', platform: 'somewhere', storeId: 's1', storeName: 'S', caseId: 'k', buyer: 'd', status: 'draft', body: 'w', timeline: [] },
        ],
      }),
      'utf8',
    );

    // 邮箱草稿落到飞书草稿箱，不该被当成「没有亚马逊回复框可填」。
    const mail = await call('POST', '/drafts/d_mail/fill', {});
    assert.equal(mail.status, 400);
    assert.match(mail.payload.error.message, /mail-draft/, '要点名正确的那条路');

    // 认不出的平台既不能冒充亚马逊，也不能静默成功。
    const ghost = await call('POST', '/drafts/d_ghost/fill', {});
    assert.equal(ghost.status, 400);
    assert.match(ghost.payload.error.message, /没有可填的回复框/);
    assert.equal(/亚马逊/.test(ghost.payload.error.message), false, '不能把别的平台说成亚马逊');
  });
});

test('扫描可以只扫指定渠道', async () => {
  await withPlugin(async ({ call }) => {
    const { payload } = await call('POST', '/patrol/scan', { channels: ['amazon'] });
    assert.deepEqual(Object.keys(payload.data), ['amazon']);
  });
});

test('扫描失败时保留上一次的店铺列表，只把错误附上', async () => {
  await withPlugin(async ({ call, ctx }) => {
    ctx.fake.storeRows.push({ storeId: 'a', storeName: 'Amazon-Cozynome-管理员', platformName: '亚马逊-美国' });
    await call('POST', '/patrol/scan', {});

    ctx.fake.failStoreList = true;
    const failed = await call('POST', '/patrol/scan', {});
    assert.equal(failed.status, 200);
    assert.ok(failed.payload.data.amazon.error, '应该带上错误');
    assert.equal(failed.payload.data.amazon.items.length, 1, '扫描失败不该把已知店铺清空');
    assert.deepEqual(failed.payload.data.amazon.added, [], '失败时不报差异');
  });
});

test('扫描要带控制台令牌；GET /api/patrol/stores 走同一套结果', async () => {
  await withPlugin(async ({ call, ctx }) => {
    const forbidden = await call('POST', '/patrol/scan', {}, { withToken: false });
    assert.equal(forbidden.status, 403, '扫描是写动作，必须校验令牌');

    ctx.fake.storeRows.push({ storeId: 'a', storeName: 'Amazon-A', platformName: '亚马逊-美国' });
    const { status, payload } = await call('GET', '/patrol/stores?refresh=1');
    assert.equal(status, 200);
    assert.equal(payload.data.total, 1);
    assert.ok(Array.isArray(payload.data.skipped));
  });
});

test('巡逻只写草稿：接口表里不存在任何「发送」路由', () => {
  const paths = ROUTES.map((route) => `${route.method} ${route.path}`);
  assert.equal(paths.some((entry) => /send|发送/i.test(entry)), false);
  assert.ok(paths.includes('POST /patrol'), '一键巡逻入口');
  assert.ok(paths.includes('POST /drafts/:id/fill'), '人工触发的「填入回复框」入口');
  assert.ok(paths.includes('DELETE /drafts/:id'), '删除草稿入口');
});
test('定时巡检：每个平台一份计划，默认关闭、心跳已装上、改完状态立刻反映', async () => {
  await withPlugin(async ({ call }) => {
    const before = await call('GET', '/health');
    const auto0 = before.payload.data.autoPatrol;
    assert.equal(auto0.heartbeat, true, '心跳要装上（跑不跑是另一回事）');
    assert.equal(auto0.enabledCount, 0, '默认一个平台都没开');
    const amazon0 = auto0.channels.amazon;
    assert.equal(amazon0.enabled, false, '默认必须是关闭');
    assert.equal(amazon0.configured, false, '还没单独设置过：沿用全局默认计划');
    assert.equal(amazon0.blockedBy, 'disabled');
    assert.deepEqual(amazon0.times, ['09:00', '14:00', '20:00'], '出厂三档');
    assert.ok(auto0.channels.tiktok, '每个注册的渠道都要有一份状态，界面才好画在自己那块下面');

    // 挑一个**离现在足够远**的时刻，免得测试把真巡逻启起来（宽限期才 5 分钟）。
    const nowMinutes = zonedMinutes(new Date(), 'Asia/Shanghai');
    const slot = formatClock(nowMinutes + 120);
    const saved = await call('POST', '/settings', {
      autoPatrol: { channels: { amazon: { enabled: true, times: [slot], storeIds: ['s1'] } } },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.payload.data.settings.autoPatrol.channels.amazon.enabled, true);

    const after = await call('GET', '/patrol');
    const auto = after.payload.data.autoPatrol;
    const amazon = auto.channels.amazon;
    assert.equal(amazon.enabled, true);
    assert.equal(amazon.configured, true, '保存过就是它自己的一份计划了');
    assert.deepEqual(amazon.times, [slot]);
    assert.deepEqual(amazon.storeIds, ['s1'], '巡检店铺要按平台各自存下来');
    assert.equal(amazon.blockedBy, 'not-due', '还没到这个点');
    assert.equal(amazon.wouldRun, false);
    assert.equal(amazon.nextSlot, slot);
    assert.ok(amazon.nextAt, '要给出下次巡检的绝对时间');
    assert.deepEqual(amazon.firedToday, []);
    assert.equal(auto.enabledCount, 1);
    assert.equal(auto.nextChannel, 'amazon', '大按钮下面那行要能说清下次是哪个平台');
    // 别的平台不受影响：没被设置过，仍然沿用全局默认（关闭）。
    assert.equal(auto.channels.tiktok.enabled, false, '保存一个平台不能顺手打开别的平台');
    assert.deepEqual(auto.channels.tiktok.times, ['09:00', '14:00', '20:00']);

    // 只提交开关时，**同一个平台**的时刻表与店铺清单都不能被抹掉（部分合并）。
    await call('POST', '/settings', { autoPatrol: { channels: { amazon: { enabled: false } } } });
    const off = await call('GET', '/patrol');
    assert.equal(off.payload.data.autoPatrol.channels.amazon.blockedBy, 'disabled');
    assert.deepEqual(off.payload.data.autoPatrol.channels.amazon.times, [slot], '时刻表不能被抹掉');
    assert.deepEqual(off.payload.data.autoPatrol.channels.amazon.storeIds, ['s1'], '店铺清单也不能被抹掉');

    // 传空数组是有意义的：一次都不巡检 → 原因变成「还没添加巡检时刻」。
    await call('POST', '/settings', { autoPatrol: { channels: { amazon: { enabled: true, times: [] } } } });
    const empty = await call('GET', '/patrol');
    assert.deepEqual(empty.payload.data.autoPatrol.channels.amazon.times, []);
    assert.equal(empty.payload.data.autoPatrol.channels.amazon.blockedBy, 'no-times');
    assert.equal(empty.payload.data.autoPatrol.channels.amazon.nextAt, null);
    assert.equal(empty.payload.data.autoPatrol.enabledCount, 0, '开着却没时刻，不算「会跑的平台」');

    // 再存一个平台：**不能把前一个平台那份抹掉** —— channels 是第二层映射，
    // 用对象展开合并的话这里会变成「只剩 TikTok」。
    await call('POST', '/settings', { autoPatrol: { channels: { tiktok: { enabled: true, times: [slot] } } } });
    const both = await call('GET', '/patrol');
    assert.equal(both.payload.data.autoPatrol.channels.tiktok.enabled, true);
    assert.equal(both.payload.data.autoPatrol.channels.amazon.configured, true, '亚马逊那份必须还在');
    assert.deepEqual(both.payload.data.autoPatrol.channels.amazon.times, [], '还是它自己那张空时刻表');
    assert.equal(both.payload.data.autoPatrol.enabledCount, 1);
  });
});

test('定时巡检：传 null 能删掉某个平台的计划，内存里也要跟着退回全局默认', async () => {
  await withPlugin(async ({ call }) => {
    await call('POST', '/settings', {
      autoPatrol: { channels: { amazon: { enabled: true, times: ['08:00'], storeIds: ['s1'] } } },
    });
    const before = (await call('GET', '/patrol')).payload.data.autoPatrol;
    assert.equal(before.channels.amazon.configured, true);
    assert.deepEqual(before.channels.amazon.storeIds, ['s1']);

    const saved = await call('POST', '/settings', { autoPatrol: { channels: { amazon: null } } });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.payload.data.settings.autoPatrol.channels, {}, '文件里已经没有这一份了');

    // 调度器读的是**内存里**那份设置。mergeInPlace 只加不删，少了这一步就会
    //「文件里删了、内存里还在跑」—— 所以这条专门盯住它。
    const after = (await call('GET', '/patrol')).payload.data.autoPatrol;
    assert.equal(after.channels.amazon.configured, false, '退回全局默认');
    assert.equal(after.channels.amazon.enabled, false);
    assert.deepEqual(after.channels.amazon.times, ['09:00', '14:00', '20:00'], '全局默认那三档');
  });
});

test('删除草稿：真删（不是标记丢弃），并清掉工单上的草稿指针', async () => {
  await withPlugin(async ({ call, dataDir }) => {
    const draftsDir = path.join(dataDir, 'drafts');
    fs.mkdirSync(draftsDir, { recursive: true });
    fs.writeFileSync(
      path.join(draftsDir, 'drafts.json'),
      JSON.stringify({
        version: 1,
        rev: 3,
        items: [
          {
            id: 'd_gone',
            platform: 'amazon',
            storeId: 's1',
            storeName: 'Amazon-X',
            buyer: 'ann',
            status: 'draft',
            body: 'hi',
            // 草稿库与工单队列互指：删除时要顺着这个指针把工单上的引用清掉。
            ticketId: 'q_1',
            timeline: [],
          },
        ],
      }),
      'utf8',
    );
    fs.writeFileSync(path.join(draftsDir, 'd_gone.txt'), '正文副本', 'utf8');
    fs.writeFileSync(
      path.join(dataDir, 'queue.json'),
      JSON.stringify({
        version: 1,
        rev: 1,
        items: [
          {
            id: 'q_1',
            channel: 'amazon',
            kind: 'message',
            status: 'drafted',
            subject: 's',
            receivedAt: '2026-10-08T00:00:00.000Z',
            draftId: 'd_gone',
            timeline: [],
          },
        ],
      }),
      'utf8',
    );
    assert.equal((await call('GET', '/drafts')).payload.data.total, 1, '先确认测试数据进去了');

    const noToken = await call('DELETE', '/drafts/d_gone', undefined, { withToken: false });
    assert.equal(noToken.status, 403, '删除是写操作，要令牌');

    const missing = await call('DELETE', '/drafts/d_nope');
    assert.equal(missing.status, 404);

    const gone = await call('DELETE', '/drafts/d_gone');
    assert.equal(gone.status, 200);
    assert.equal(gone.payload.data.deleted, true);
    assert.equal(gone.payload.data.ticketId, 'q_1', '要把关联的工单 id 回给界面');

    assert.equal((await call('GET', '/drafts')).payload.data.total, 0, '要从库里真的没了');
    assert.equal(fs.existsSync(path.join(draftsDir, 'd_gone.txt')), false, '正文副本也要清掉');

    const ticket = await call('GET', '/queue/q_1');
    assert.equal(ticket.payload.data.item.draftId, null, '工单上的草稿指针要清掉');
    assert.equal(ticket.payload.data.item.status, 'drafted', '删草稿不改工单状态，那是另一件事');
  });
});

/* ── 登录路由（task-7） ───────────────────────────────────────────────────────
 * 「登录」按钮的职责**只有一个**：把浏览器开到登录页摆好，然后停下来等人。
 * 插件不代替人完成登录 —— 不点登录按钮、不填账号密码、不填验证码、不处理滑块。
 * 真实登录的挑战两次实测都不一样（店1 滑块选形状 / 店2 邮箱验证码），验证码又发到人手上。
 * 端点：GET /patrol/login（读，供前端每 3 秒轮询）、POST /patrol/login（写，要令牌）。
 * ─────────────────────────────────────────────────────────────────────────── */

const TT_STORE = {
  storeId: 'tt2',
  storeName: 'Tiktok-FUSOU-客服KX',
  platformName: 'TikTok Shop-全球跨境(自运营)（旧）',
};
const TT_LOGIN_URL = 'https://seller.tiktokshopglobalselling.com/account/login';
const TT_HOME_URL = 'https://seller.us.tiktokshopglobalselling.com/chat/inbox/current?shop_region=US';

/** 断言这一批子进程调用里没有任何一次点击/输入，也没有任何参数落在登录表单相关选择器上。 */
function assertNoLoginAutomation(ctx) {
  assert.deepEqual(ctx.fake.formAttempts, [], '登录链路里不允许出现点击/输入');
  const flat = ctx.spawns.map((spec) => spec.argv.join(' ')).join('\n');
  assert.equal(/\bclick\b/.test(flat), false, '不许出现 click');
  assert.equal(/\binput\b/.test(flat), false, '不许出现 input');
  for (const selector of LOGIN_FORM_SELECTORS) {
    assert.equal(flat.includes(selector), false, '不许碰登录表单选择器：' + selector);
  }
  assert.equal(/密码|验证码|滑块|captcha|password|otp/i.test(flat), false, '参数里不许出现账号/验证码/滑块语义');
}

test('GET /patrol 与 /meta：登录态与「支持登录」的能力位都报出来（前端据此画按钮）', async () => {
  await withPlugin(async ({ call, ctx }) => {
    // 能力位是**契约**：前端靠它决定画不画「登录」按钮。拼错一个字母，按钮就永远不出现，
    // 而且不会有任何报错 —— 所以这条要锁死，不能只写在注释里。
    const meta = await call('GET', '/meta');
    assert.ok(meta.payload.data.capabilities.includes('patrol.login'), '能力位必须叫 patrol.login');
    // 同上：定时巡检改成「每个平台一份」之后，前端要靠这个能力位认出旧后端。
    assert.ok(
      meta.payload.data.capabilities.includes('patrol.autoPerChannel'),
      '能力位必须叫 patrol.autoPerChannel',
    );
    // 渠道级开关（巡逻页那一行）也要有独立的能力位：旧后端的 /patrol 里没有
    // channels[*].channelEnabled，开关画出来也点不动。
    assert.ok(
      meta.payload.data.capabilities.includes('patrol.channelSwitch'),
      '能力位必须叫 patrol.channelSwitch',
    );

    const before = await call('GET', '/patrol');
    assert.ok(before.payload.data.loginStates, '巡逻页首屏就要能拿到登录态');
    // 只有**需要人工**登录的渠道才在这里：沃尔玛有自动登录，界面上不暴露登录状态（和亚马逊那块一个样子）。
    assert.deepEqual(
      before.payload.data.loginChannels,
      ['tiktok', 'shein', 'temu'],
      'TikTok / SHEIN / TEMU 都要人工登录（三家都没有自动登录能力）',
    );

    ctx.fake.storeRows.push(TT_STORE);
    ctx.fake.storeUrl.tt2 = TT_HOME_URL;
    // 上面那次 GET /patrol 已经把「空店铺列表」缓存下来了。登录接口必须能自己从这个
    // 缓存里走出来（见下面那条专门的回归测试），不需要调用方先手动重扫。
    await call('POST', '/patrol/login', { channel: 'tiktok', storeId: 'tt2' });

    const after = await call('GET', '/patrol');
    assert.equal(after.payload.data.loginStates.tt2.state, 'logged_in', '点过登录之后巡逻页也要看得到');
  });
});

test('POST /patrol/login：店铺列表还在缓存里时也要找得到新店（不能让人撞 404 然后干等 60 秒）', async () => {
  // 真实场景：刚在紫鸟里加了店铺，回来就点「登录」。此时缓存里那份空列表还没过期。
  // 直接 404 会让人以为店铺不存在 —— 实际上它就在那儿，而且重试也没用，得等缓存过期。
  await withPlugin(async ({ call, ctx }) => {
    const blank = await call('GET', '/patrol'); // 把「一家店都没有」缓下来
    assert.deepEqual(blank.payload.data.sources.tiktok.items, []);

    ctx.fake.storeRows.push(TT_STORE);
    ctx.fake.storeUrl.tt2 = TT_HOME_URL;

    const res = await call('POST', '/patrol/login', { channel: 'tiktok', storeId: 'tt2' });
    assert.equal(res.status, 200, '缓存过期与否不该影响能不能点登录');
    assert.equal(res.payload.data.state, 'logged_in');
  });
});

test('POST /patrol/login：缺令牌 403（写动作自动走 x-cs-token），读取登录态不要令牌', async () => {
  await withPlugin(async ({ call, ctx }) => {
    ctx.fake.storeRows.push(TT_STORE);
    const forbidden = await call('POST', '/patrol/login', { channel: 'tiktok', storeId: 'tt2' }, { withToken: false });
    assert.equal(forbidden.status, 403, '点「登录」是写动作，必须校验令牌');
    const read = await call('GET', '/patrol/login', undefined, { withToken: false });
    assert.equal(read.status, 200, '轮询用的读接口不该每次过鉴权');
  });
});

test('POST /patrol/login：未知店铺 404、缺 storeId 400、邮箱渠道没有登录这一步 400', async () => {
  await withPlugin(async ({ call, ctx }) => {
    ctx.fake.storeRows.push(TT_STORE);

    const missing = await call('POST', '/patrol/login', { channel: 'tiktok', storeId: 'tt-nope' });
    assert.equal(missing.status, 404);
    assert.match(missing.payload.error.message, /找不到店铺/);

    const noId = await call('POST', '/patrol/login', { channel: 'tiktok' });
    assert.equal(noId.status, 400);
    assert.match(noId.payload.error.message, /storeId/);

    // 飞书邮箱渠道根本没有「登录」这回事：要指名道姓地说清楚，而不是含糊的「找不到店铺」。
    const mail = await call('POST', '/patrol/login', { channel: 'lark-mail', storeId: 'cs@fusou.vip' });
    assert.equal(mail.status, 400);
    assert.match(mail.payload.error.message, /没有「登录」这一步/);

    const ghost = await call('POST', '/patrol/login', { channel: 'nowhere', storeId: 'x' });
    assert.equal(ghost.status, 400);
    assert.match(ghost.payload.error.message, /未注册的渠道/);
  });
});

test('POST /patrol/login：已登录的店直接回 logged_in，不开新等待', async () => {
  await withPlugin(async ({ call, ctx }) => {
    ctx.fake.storeRows.push(TT_STORE);
    ctx.fake.storeUrl.tt2 = TT_HOME_URL;

    const res = await call('POST', '/patrol/login', { channel: 'tiktok', storeId: 'tt2' });
    assert.equal(res.status, 200);
    assert.equal(res.payload.data.storeId, 'tt2');
    assert.equal(res.payload.data.state, 'logged_in');
    assert.equal(res.payload.data.waiting, false, '已经登录了没什么可等的');
    assert.match(res.payload.data.hint, /登录态/);

    const states = await call('GET', '/patrol/login');
    assert.equal(states.payload.data.states.tt2.state, 'logged_in');
    assert.equal(states.payload.data.states.tt2.url, TT_HOME_URL);
    assert.ok(states.payload.data.states.tt2.since, '要带「从什么时候起是这个状态」');
    assert.deepEqual(states.payload.data.channels, ['tiktok', 'shein', 'temu'], '自动登录的渠道不画登录按钮');
    assert.deepEqual(states.payload.data.waiting, [], '没有在等谁');
    assertNoLoginAutomation(ctx);
  });
});

test('POST /patrol/login：未登录 → login_required 且立刻返回（后台等人，不阻塞 HTTP）', async () => {
  await withPlugin(async ({ call, ctx, waits }) => {
    ctx.fake.storeRows.push(TT_STORE);
    ctx.fake.storeUrl.tt2 = TT_LOGIN_URL;

    const res = await call('POST', '/patrol/login', { channel: 'tiktok', storeId: 'tt2' });
    assert.equal(res.status, 200);
    assert.equal(res.payload.data.state, 'login_required');
    assert.equal(res.payload.data.waiting, true, '要在后台开始等人');
    assert.match(res.payload.data.hint, /请你本人完成登录/);
    assert.equal(res.payload.data.url, TT_LOGIN_URL);
    assert.equal(res.payload.data.title, 'TikTok Shop Seller Center', '把人现在看到的那一页回显出来');

    // 「后台」是可验证的：HTTP 已经返回了，而 waitForLogin 还挂在那儿。
    assert.equal(waits.length, 1, '应该正好有一次等待在跑');
    assert.equal(waits[0].settled, false, '响应回来时它必须还没结束 —— 否则就是阻塞了 HTTP');

    // 连点两次「登录」不该有两份轮询在打同一个页面。
    await call('POST', '/patrol/login', { channel: 'tiktok', storeId: 'tt2' });
    assert.equal(waits.length, 1, '同一家店同时只留一个等待');

    const states = await call('GET', '/patrol/login');
    assert.equal(states.payload.data.states.tt2.state, 'login_required');
    assert.deepEqual(states.payload.data.waiting, ['tt2'], '前端据此显示「等待登录中」而不是让人反复点');

    assertNoLoginAutomation(ctx);
    // 收拾干净：让挂着的等待落地，免得测试进程留着一个永不 resolve 的 promise。
    waits[0].resolve({
      state: LOGIN_STATES.TIMEOUT,
      waitedMs: 0,
      url: TT_LOGIN_URL,
      attempts: 0,
      hint: '没等到',
    });
  });
});

test('登录态只在内存里：状态没变时 since 不刷新，且翻遍数据目录找不到 logged_in', async () => {
  await withPlugin(async ({ call, ctx }) => {
    ctx.fake.storeRows.push(TT_STORE);
    ctx.fake.storeUrl.tt2 = TT_HOME_URL;

    await call('POST', '/patrol/login', { channel: 'tiktok', storeId: 'tt2' });
    const first = (await call('GET', '/patrol/login')).payload.data.states.tt2;

    // 再点一次：状态没变 ⇒ since 不该被刷新。前端每 3 秒拉一次，每次都刷就等于没有这个字段。
    await call('POST', '/patrol/login', { channel: 'tiktok', storeId: 'tt2' });
    const second = (await call('GET', '/patrol/login')).payload.data.states.tt2;
    assert.equal(second.since, first.since, '状态没变时 since 保持不变');
    assert.equal(second.state, 'logged_in');

    // 登录态**不落盘**：翻遍数据目录（审计除外）都不该出现「已登录」这种会被当成永久事实的记录。
    const dir = (await call('GET', '/health')).payload.data.dataDir;
    const files = [];
    const walk = (target) => {
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        const full = path.join(target, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'audit') walk(full);
        } else {
          files.push(full);
        }
      }
    };
    walk(dir);
    const raw = files.map((file) => fs.readFileSync(file, 'utf8')).join('');
    assert.equal(raw.includes('logged_in'), false, '登录态绝不能落盘成「永久登录」');
  });
});

test('登录链路只做「开店铺 + 导航 + 读地址 + 读标题」，一步都不越界', async () => {
  await withPlugin(async ({ call, ctx }) => {
    ctx.fake.storeRows.push(TT_STORE);
    ctx.fake.storeUrl.tt2 = TT_LOGIN_URL;

    await call('POST', '/patrol/login', { channel: 'tiktok', storeId: 'tt2' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    // 假紫鸟在收到「非 location.href / document.title」的 page exec 时会记一笔 formAttempts；
    // 更硬的一条是：整条链路的参数里压根不该出现登录表单的语义。
    assertNoLoginAutomation(ctx);
    const storeOpens = ctx.spawns.filter((spec) => spec.argv.includes('store') && spec.argv.includes('open'));
    assert.ok(storeOpens.length >= 1, '要先开店铺窗口（可见窗口）');
    assert.equal(ctx.spawns.some((spec) => spec.argv.includes('--headless')), false, '永远不开无头窗口');
    for (const spec of storeOpens) {
      // 开店铺会带 --store-id，但绝不能带任何要填进表单的文本。
      assert.equal(spec.argv.includes('--text'), false, '登录链路上不许出现填入文本');
      assert.equal(spec.argv.includes('--clear'), false, '登录链路上不许出现清空输入框');
    }
  });
});

test('SHEIN 渠道：已启用 —— 认自己的店、参与巡逻，且校准位如实说「部分未校准」', async () => {
  await withPlugin(async ({ call, ctx }) => {
    ctx.fake.storeRows.push(
      { storeId: 'shein1', storeName: 'Shein-SevenVanity-US-客服', platformName: 'SHEIN-全球' },
      { storeId: 'amz1', storeName: 'Amazon-Cozynome-管理员', platformName: '亚马逊-美国' },
    );

    // ① 渠道表：已启用、要人工登录、有自己的店。
    const patrol = await call('GET', '/patrol');
    const shein = patrol.payload.data.channels.find((entry) => entry.id === 'shein');
    assert.ok(shein, 'SHEIN 要注册进渠道表');
    assert.equal(shein.label, 'SHEIN');
    assert.equal(shein.kind, 'store');
    assert.equal(shein.enabled, true, 'SHEIN 渠道已启用，参与巡逻');
    assert.equal(shein.autoLogin, false, 'SHEIN 没有自动登录：登录要在紫鸟里人工做一次');

    // ② 扫描：SHEIN 店归 SHEIN 渠道；亚马逊渠道里仍明确解释「这是别的平台」。
    const scan = await call('POST', '/patrol/scan', {});
    assert.deepEqual(scan.payload.data.shein.items.map((store) => store.storeId), ['shein1']);
    assert.deepEqual(scan.payload.data.amazon.items.map((store) => store.storeId), ['amz1']);
    assert.deepEqual(scan.payload.data.amazon.skipped.map((store) => store.storeId), ['shein1']);
    assert.match(scan.payload.data.amazon.skipped[0].reason, /亚马逊/);

    // ③ 校准位如实：渠道启用了，但会话行 / 会话正文 / 回复框还没在有会话的登录态上校准。
    const health = await call('GET', '/health');
    const calibration = health.payload.data.channelCalibration.shein;
    assert.ok(calibration, 'SHEIN 要出现在校准位里');
    assert.equal(calibration.verified, false, '没校准完就不能自称已接入');
    assert.match(calibration.note, /尚未覆盖/);
    assert.match(calibration.note, /27618263276365/, '要说清是在哪家店上验证到哪一步');

    // ④ 真跑一次：SHEIN 渠道会**真的去开店铺**（不再被跳过）。假紫鸟读不出工作台角标，
    //    所以这家店最终会记成失败 —— 这里要的只是「它确实被巡逻了」这个事实。
    const before = ctx.spawns.length;
    await call('POST', '/patrol', { channels: ['shein'] });
    for (let i = 0; i < 20; i += 1) {
      if (ctx.spawns.slice(before).some((spec) => spec.argv.includes('store') && spec.argv.includes('open'))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const opened = ctx.spawns
      .slice(before)
      .some((spec) => spec.argv.includes('store') && spec.argv.includes('open'));
    assert.equal(opened, true, '已启用的渠道要真的去开店铺');
  });
});

test('TEMU 渠道：已启用 —— 两个 platformName 都认，校准位如实说「只校准到登录」', async () => {
  await withPlugin(async ({ call, ctx }) => {
    ctx.fake.storeRows.push(
      { storeId: 'temu1', storeName: 'Temu-CN-客服', platformName: 'Temu-中国卖家中心' },
      { storeId: 'temu2', storeName: 'Temu-US-管理员', platformName: 'Temu-美国-本土' },
      { storeId: 'amz1', storeName: 'Amazon-Cozynome-管理员', platformName: '亚马逊-美国' },
    );

    // ① 渠道表：已启用、要人工登录。
    const patrol = await call('GET', '/patrol');
    const temu = patrol.payload.data.channels.find((entry) => entry.id === 'temu');
    assert.ok(temu, 'TEMU 要注册进渠道表');
    assert.equal(temu.label, 'TEMU');
    assert.equal(temu.kind, 'store');
    assert.equal(temu.enabled, true, 'TEMU 渠道已启用，参与巡逻');
    assert.equal(temu.autoLogin, false, 'TEMU 没有自动登录：登录要在紫鸟里人工做一次');

    // ② 扫描：两个平台名（中国卖家中心 / 美国-本土）都归 TEMU 渠道；
    //    亚马逊渠道里仍明确解释「这是别的平台」。
    const scan = await call('POST', '/patrol/scan', {});
    assert.deepEqual(scan.payload.data.temu.items.map((store) => store.storeId), ['temu1', 'temu2']);
    assert.deepEqual(scan.payload.data.amazon.items.map((store) => store.storeId), ['amz1']);
    assert.deepEqual(scan.payload.data.amazon.skipped.map((store) => store.storeId), ['temu1', 'temu2']);
    assert.match(scan.payload.data.amazon.skipped[0].reason, /亚马逊/);

    // ③ 校准位如实：登录这一段校准了（两套后台 + 未登录判据），
    //    收件箱（客服中心 → 消费者咨询）还没校准 —— 不能自称已接入。
    const health = await call('GET', '/health');
    const calibration = health.payload.data.channelCalibration.temu;
    assert.ok(calibration, 'TEMU 要出现在校准位里');
    assert.equal(calibration.verified, false, '没校准完就不能自称已接入');
    assert.match(calibration.note, /尚未覆盖/);
    assert.match(calibration.note, /卖家中心/, '要说清「两套后台」这件事');

    // ④ 真跑一次：TEMU 渠道会**真的去开店铺**。假紫鸟的页面地址不是 TEMU 后台，
    //    所以这家店最终会记成失败 —— 这里要的只是「它确实被巡逻了」这个事实。
    const before = ctx.spawns.length;
    await call('POST', '/patrol', { channels: ['temu'] });
    for (let i = 0; i < 20; i += 1) {
      if (ctx.spawns.slice(before).some((spec) => spec.argv.includes('store') && spec.argv.includes('open'))) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const opened = ctx.spawns
      .slice(before)
      .some((spec) => spec.argv.includes('store') && spec.argv.includes('open'));
    assert.equal(opened, true, '已启用的渠道要真的去开店铺');
  });
});
