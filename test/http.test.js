import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRequestHandler, createToken, isInside, mimeOf, normalizePrefix, safeEqual } from '../lib/http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', 'assets');
const TOKEN = 'unit-test-token';

/** 起一个真实 http server 跑一遍处理器。 */
async function withServer(api, run) {
  const server = http.createServer(
    createRequestHandler({ prefix: '/cs', assetsDir: ASSETS, token: TOKEN, api, version: '9.9.9' }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('normalizePrefix 补齐开头斜杠并去掉结尾斜杠', () => {
  assert.equal(normalizePrefix(undefined), '/cs');
  assert.equal(normalizePrefix('cs'), '/cs');
  assert.equal(normalizePrefix('/cs/'), '/cs');
  assert.equal(normalizePrefix(' /kefu  '), '/kefu');
});

test('mimeOf 给出正确类型', () => {
  assert.equal(mimeOf('/a/b.html'), 'text/html; charset=utf-8');
  assert.equal(mimeOf('/a/b.js'), 'text/javascript; charset=utf-8');
  assert.equal(mimeOf('/a/b.unknown'), 'application/octet-stream');
});

test('isInside 拦住目录穿越', () => {
  assert.equal(isInside('/root/assets', '/root/assets/app.js'), true);
  assert.equal(isInside('/root/assets', '/root/assets'), true);
  assert.equal(isInside('/root/assets', '/root/secret.txt'), false);
  assert.equal(isInside('/root/assets', '/root/assets-evil/x'), false);
});

test('safeEqual 与 createToken', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(undefined, 'abc'), false);
  assert.match(createToken(), /^[0-9a-f]{48}$/);
  assert.notEqual(createToken(), createToken());
});

test('GET /cs/ 返回入口页，并注入 token / version / 前缀', async () => {
  await withServer(async () => ({ body: { ok: true } }), async (base) => {
    const res = await fetch(`${base}/cs/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.ok(html.includes(TOKEN), 'token 没注入');
    assert.ok(html.includes('9.9.9'), 'version 没注入');
    assert.ok(html.includes('<base href="/cs/"'), 'prefix 没注入');
    assert.ok(!html.includes('__CS_TOKEN__'));
  });
});

test('静态资源带正确 MIME，且不带缓存', async () => {
  await withServer(async () => ({ body: null }), async (base) => {
    const res = await fetch(`${base}/cs/app.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/css/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
  });
});

test('目录穿越尝试被拒，且不泄漏 assets 之外的文件', async () => {
  await withServer(async () => ({ body: null }), async (base) => {
    const res = await fetch(`${base}/cs/%2e%2e%2fpackage.json`);
    assert.ok(res.status === 403 || res.status === 404, `期望 403/404，实际 ${res.status}`);
    const text = await res.text();
    assert.ok(!text.includes('"dsh"'), '泄漏了包外的文件内容');
  });
});

test('前缀之外的一律 404', async () => {
  await withServer(async () => ({ body: { ok: true } }), async (base) => {
    const res = await fetch(`${base}/other`);
    assert.equal(res.status, 404);
  });
});

test('GET /cs/api/health 走 api 处理器', async () => {
  await withServer(async (method, route) => ({ body: { ok: true, data: { method, route } } }), async (base) => {
    const res = await fetch(`${base}/cs/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true, data: { method: 'GET', route: '/health' } });
  });
});

test('写操作缺少令牌时 403，且不会调用 api', async () => {
  let called = 0;
  await withServer(
    async () => {
      called += 1;
      return { body: { ok: true } };
    },
    async (base) => {
      const res = await fetch(`${base}/cs/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 403);
      assert.equal(called, 0);
    },
  );
});

test('写操作带令牌时透传请求体', async () => {
  await withServer(
    async (method, route, info) => ({ body: { ok: true, data: { method, route, received: info.body } } }),
    async (base) => {
      const res = await fetch(`${base}/cs/api/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cs-token': TOKEN },
        body: JSON.stringify({ dataDir: '/tmp/x' }),
      });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.deepEqual(payload.data.received, { dataDir: '/tmp/x' });
    },
  );
});

test('坏 JSON 请求体返回 400', async () => {
  await withServer(async () => ({ body: { ok: true } }), async (base) => {
    const res = await fetch(`${base}/cs/api/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cs-token': TOKEN },
      body: '{oops',
    });
    assert.equal(res.status, 400);
  });
});

test('未注册的接口 404', async () => {
  await withServer(async () => undefined, async (base) => {
    const res = await fetch(`${base}/cs/api/nope`);
    assert.equal(res.status, 404);
  });
});

test('api 抛异常时返回 500 且带错误信息', async () => {
  await withServer(
    async () => {
      throw new Error('boom');
    },
    async (base) => {
      const res = await fetch(`${base}/cs/api/health`);
      assert.equal(res.status, 500);
      assert.match((await res.json()).error.message, /boom/);
    },
  );
});

test('无扩展名的未知路径回落到入口页（方便后续前端路由）', async () => {
  await withServer(async () => ({ body: null }), async (base) => {
    const res = await fetch(`${base}/cs/some/deep/route`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    await res.text();
  });
});
