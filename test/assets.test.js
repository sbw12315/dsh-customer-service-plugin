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
  // 所以必须探能力（新前端要的接口在不在、渠道枚举里有没有 amazon 与 tiktok）。
  assert.match(text, /HOST_CONTRACT/, '需要有明确的接口契约声明');
  // 逐个渠道断言，而不是只断言「amazon 在最前」：否则以后有人把 tiktok 删了测试照样绿，
  // 「渠道对账」这条防线就废了 —— 每加一个渠道就在这里补一个断言。
  assert.match(
    text,
    /channels:\s*\[\s*'amazon'\s*,[^\]]*'tiktok'[^\]]*\]/,
    '契约里要包含 amazon 与 tiktok 两个渠道',
  );
  // 沃尔玛也注册进契约：旧后端不认它时，顶部要能提示重启，而不是让人以为「沃尔玛没了」。
  assert.match(
    text,
    /channels:\s*\[[^\]]*'walmart'[^\]]*\]/,
    '契约里要包含 walmart 渠道',
  );
  // TEMU 同理：旧后端不认它时，顶部要能提示重启，而不是让人以为「TEMU 那几家公司没了」。
  assert.match(
    text,
    /channels:\s*\[[^\]]*'temu'[^\]]*\]/,
    '契约里要包含 temu 渠道',
  );
  assert.match(text, /metaKeys:\s*\[[^\]]*'drafts'[^\]]*'patrol'/, '契约里要包含 drafts / patrol');
  assert.match(text, /healthClis:\s*\[\s*'ziniao'\s*,\s*'lark'\s*\]/, '契约里要包含两个 CLI 的启用开关');
  assert.match(text, /capabilities:\s*\[[^\]]*'drafts\.delete'[^\]]*\]/, '契约里要包含删除草稿的能力位');
  // 定时巡检改成「每个平台一份」之后，旧后端的 autoPatrol 形状不一样但字段名都在，
  // 前端认不出来 —— 只能靠这个能力位在顶部提示重启。
  assert.match(text, /capabilities:\s*\[[^\]]*'patrol\.autoPerChannel'[^\]]*\]/, '契约里要有每平台定时巡检的能力位');
  // 渠道级开关（巡逻页每个平台块那一枚）也是「旧后端不认就点了没反应」的那一类，
  // 必须放进契约：缺了就在顶部提示重启 DSH，而不是让人对着一个死开关点半天。
  assert.match(
    text,
    /capabilities:\s*\[[^\]]*'patrol\.channelSwitch'[^\]]*\]/,
    '契约里要有渠道级开关的能力位',
  );
  // 退化回「只要 /meta 不 404 就算同步」是错的：旧宿主半的 /meta 是存在的。
  assert.equal(
    /await get\('\/meta'\);\s*\n\s*hostMismatch = false;/.test(text),
    false,
    '不能再只看 /meta 是否 404',
  );
});

test('定时巡检已经下沉到每个平台块里，页面顶层不再有独立的「定时巡检」面板', () => {
  const text = fs.readFileSync(path.join(ASSETS, 'js', 'page-patrol.js'), 'utf8');
  // 顶层那个面板的容器 id 必须消失：留着它就说明面板又回到页面最上面去了。
  assert.equal(text.includes("id: 'patrol-auto'"), false, '独立的定时巡检容器应该已经移除');
  // 每个平台一份：按渠道画，并且必须挂在平台块里被调用（renderSources 里）。
  assert.match(text, /function autoPlanSection\(channel, auto\)/, '要有「按渠道画出一份计划」的函数');
  assert.match(text, /autoPlanSection\(channel, auto\)/, '它必须挂在平台块里被调用');
  // 保存时提交的必须是「渠道 id → 计划」这一层，只提交当前这个平台。
  assert.match(text, /autoPatrol:\s*\{\s*channels:\s*\{/, '保存要提交按渠道的计划');
  // 「这个平台只巡检哪几家」= 服务端读的 storeIds，界面上要能选。
  assert.match(text, /storeIds/, '要能选这个平台只巡检哪几家');
});

test('巡逻页每个平台块都画一枚启用/停用开关，且旧后端下不画死开关', () => {
  const text = fs.readFileSync(path.join(ASSETS, 'js', 'page-patrol.js'), 'utf8');
  // 开关本体：写进 settings.channelEnabled，走 POST /settings 立即生效。
  assert.match(text, /function toggleChannel\(channel, enabled\)/, '要有切渠道开关的动作');
  assert.match(text, /channelEnabled:\s*\{\s*\[channel\.id\]: enabled\s*\}/, '提交的是这一条渠道的键');
  assert.match(text, /class: 'toggle'[\s\S]{0,600}toggleChannel\(channel, event\.target\.checked\)/, '平台块里要画出开关');
  // 旧后端（没有 channels[*].channelEnabled）下**不画**：画了也是点了没反应。
  assert.match(text, /const canSwitch = typeof channel\.switchOn === 'boolean'/, '要按能力位决定画不画');
  // 每个渠道一行开关，不是全局一个 —— 关键词是「channel.id」，不是写死的某个平台。
  assert.equal(/channelEnabled:\s*\{\s*amazon:/.test(text), false, '不能写死某个平台');
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
