import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ROUTES, apply, intOf, matchPath, matchRoute } from '../lib/index.js';

/** 造一个只实现插件用到的那部分能力的 ctx。 */
function fakeContext() {
  const routes = [];
  const spawns = [];
  /**
   * 测试可以现场改这里，模拟真实运营动作：
   *   `fake.storeRows`     —— 紫鸟账号下的店铺（中途 push/splice 就等于「新增/删除了店铺」）
   *   `fake.failStoreList` —— 让 `store list` 失败，验证扫描失败时的降级
   */
  const fake = { storeRows: [], failStoreList: false };

  const subprocess = {
    resolveExecutable: async (command) => `/fake/bin/${command}`,
    spawn(spec) {
      spawns.push(spec);
      const isZiniao = String(spec.argv[0]).includes('ziniao');
      const isStoreList = isZiniao && spec.argv.includes('store') && spec.argv.includes('list');
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
  return {
    routes,
    spawns,
    fake,
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
      await run({ base, dataDir, ctx, token, call });
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
    assert.deepEqual(payload.data.dimensions.channels, ['mail', 'tiktok', 'walmart', 'amazon']);
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
});

