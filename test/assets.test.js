import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createRequestHandler } from '../lib/http.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', 'assets');

/** 起一个只服务静态资源的处理器（api 直接 404）。 */
async function withAssets(run) {
  const server = http.createServer(
    createRequestHandler({
      prefix: '/cs',
      assetsDir: ASSETS,
      token: 'tok',
      version: 'test',
      api: async () => undefined,
    }),
  );
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('入口页引用模块化入口，且不再引用旧的 app.js', async () => {
  await withAssets(async (base) => {
    const html = await (await fetch(`${base}/cs/`)).text();
    assert.match(html, /<script type="module" src="\.\/js\/main\.js"><\/script>/);
    assert.equal(html.includes('./app.js'), false, '旧单文件脚本应已删除引用');
    assert.match(html, /id="mainnav"/, '需要一级导航容器');
    assert.match(html, /id="subnav"/, '需要二级页签容器');
    assert.match(html, /id="content"/, '需要页面容器');
  });
});

test('js/ 下的每个模块都能取到，且 MIME 正确（ESM 必须是 JS 类型）', async () => {
  const files = fs.readdirSync(path.join(ASSETS, 'js')).filter((name) => name.endsWith('.js'));
  assert.ok(files.length >= 6, `应该有拆分后的若干模块，实际 ${files.length} 个`);
  await withAssets(async (base) => {
    for (const name of files) {
      const res = await fetch(`${base}/cs/js/${name}`);
      assert.equal(res.status, 200, `${name} 取不到`);
      assert.match(res.headers.get('content-type'), /text\/javascript/, `${name} 的 MIME 不对`);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const text = await res.text();
      assert.ok(text.length > 0, `${name} 是空的`);
    }
  });
});

test('模块之间只用相对路径互相引用，保证挂任意前缀都能解析', async () => {
  const dir = path.join(ASSETS, 'js');
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.js'))) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const specifiers = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(
        specifier.startsWith('./') || specifier.startsWith('../'),
        `${name} 引用了绝对或裸模块 ${specifier}，会因为前缀不同而 404`,
      );
      const target = path.resolve(dir, specifier);
      assert.ok(fs.existsSync(target), `${name} 引用的 ${specifier} 不存在`);
    }
  }
});

test('页面模块都导出 render，外壳按这个契约调用', async () => {
  const dir = path.join(ASSETS, 'js');
  for (const name of ['page-patrol.js', 'page-stats.js', 'page-queue.js', 'page-settings.js']) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    assert.match(text, /export async function render\(/, `${name} 必须导出 render`);
  }
});

test('外壳按「能力」探测宿主半是否跟得上，而不是比对版本号字符串', () => {
  const text = fs.readFileSync(path.join(ASSETS, 'js', 'main.js'), 'utf8');
  // 版本号是宿主半注入的：旧后端会把自己那个旧版本号注入进来，两边一比就是「相等」，
  // 所以必须探能力（新前端要的接口在不在、渠道里有没有 amazon）。
  assert.match(text, /HOST_CONTRACT/, '需要有明确的接口契约声明');
  assert.match(text, /channels:\s*\[\s*'amazon'\s*\]/, '契约里要包含 amazon 渠道');
  assert.match(text, /metaKeys:\s*\[[^\]]*'drafts'[^\]]*'patrol'/, '契约里要包含 drafts / patrol');
  assert.match(text, /healthClis:\s*\[\s*'ziniao'\s*,\s*'lark'\s*\]/, '契约里要包含两个 CLI 的启用开关');
  assert.match(text, /capabilities:\s*\[\s*'drafts\.delete'\s*\]/, '契约里要包含删除草稿的能力位');
  // 退化回「只要 /meta 不 404 就算同步」是错的：旧宿主半的 /meta 是存在的。
  assert.equal(
    /await get\('\/meta'\);\s*\n\s*hostMismatch = false;/.test(text),
    false,
    '不能再只看 /meta 是否 404',
  );
});

test('控制台页面里不出现任何绝对地址（必须走相对路径 + <base>）', async () => {
  const dir = path.join(ASSETS, 'js');
  for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.js'))) {
    const text = fs
      .readFileSync(path.join(dir, name), 'utf8')
      .replace(/\/\*\*[\s\S]*?\*\//g, '') // 去掉注释
      .replace(/https?:\/\/www\.w3\.org[^'"]*/g, ''); // SVG 命名空间是常量，不是要请求的地址
    assert.equal(/['"`]\/cs\//.test(text), false, `${name} 里写死了 /cs/ 前缀`);
    assert.equal(/https?:\/\//.test(text), false, `${name} 里有外部地址`);
  }
});
