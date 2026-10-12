#!/usr/bin/env node
/**
 * 不依赖 DSH 的**沃尔玛校准/侦察**脚本。
 *
 * 用途：沃尔玛这条链路目前是「部分校准」—— 入口、会话行、回复框都实测过，但列表容器、会话
 * 正文的消息元素、回复框的兜底顺序还没在**登录后的真实 DOM** 上校准过（2026-10-10 两家沃尔玛店
 * 都停在 login.account.wal-mart.com）。登录完成后跑这个脚本，它会告诉你：
 *
 *   1. 当前登录态（只读地址，不代登）；
 *   2. 每个候选选择器**在真实页面上命中几个元素** —— 命中的那个就该被提到候选数组第一位；
 *   3. 适配器能不能真的把会话列表 / 会话正文 / 回复框解出来（与巡逻用的是同一套代码）。
 *
 * **它永远不会发送任何消息**：链路上不存在发送动作。点会话行只是为了打开会话（读）。
 * **它永远不会代替人登录**：未登录时只打印登录页地址，然后退出。
 *
 * 用法：
 *   node scripts/smoke-walmart.mjs --list                 # 只列账号下的沃尔玛店铺
 *   node scripts/smoke-walmart.mjs --store=27800343767219 # 侦察这家店（默认第一家沃尔玛店）
 *   node scripts/smoke-walmart.mjs --store=... --probe-only   # 只打选择器命中表，不动适配器
 *   node scripts/smoke-walmart.mjs --store=... --max=2        # 最多读 2 条会话
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildSearchPath, locateCli } from '../lib/clilocator.js';
import {
  COMPOSER_INPUT_SELECTORS,
  INBOX_URL,
  LIST_SELECTORS,
  MESSAGE_SELECTORS,
  ROW_SELECTORS,
  THREAD_SELECTORS,
  createWalmartAdapter,
  isWalmartStore,
} from '../lib/platforms/walmart.js';
import { runCli } from '../lib/proc.js';
import { loadSettings } from '../lib/settings.js';
import { createZiniaoClient, isRetiredStore } from '../lib/ziniao.js';

/** 用 node:child_process 顶替宿主的 subprocess 服务（与 smoke-patrol.mjs 同一套）。 */
function nodeSubprocess() {
  return {
    resolveExecutable: async () => undefined,
    spawn(spec) {
      const child = spawn(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const out = [];
      const err = [];
      child.stdout.on('data', (chunk) => out.push(chunk));
      child.stderr.on('data', (chunk) => err.push(chunk));
      let spawnError = null;
      child.on('error', (cause) => {
        spawnError = cause;
      });
      return {
        done: new Promise((resolve) => {
          child.on('error', () => resolve({ exitCode: null, signal: null, spawnError }));
          child.on('close', (code, signal) => {
            setTimeout(() => resolve({ exitCode: code, signal, spawnError }), 20);
          });
        }),
        collected: {
          stdout: { readFrom: () => ({ text: Buffer.concat(out).toString('utf8'), nextOffset: 0, lossy: false }) },
          stderr: { readFrom: () => ({ text: Buffer.concat(err).toString('utf8'), nextOffset: 0, lossy: false }) },
        },
      };
    },
  };
}

/** 解析 --key=value 形式的参数。 */
function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const match = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const key = match[1].replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    out[key] = match[2] === undefined ? true : match[2];
  }
  return out;
}

/**
 * 生成「候选选择器命中表」页面脚本。
 *
 * 这是校准阶段最值钱的一条输出：候选数组是按猜测顺序排的，只有真实页面的命中数能告诉你
 * 该把哪一个提到第一位。命中 0 的候选也照打 —— 「试过且没中」与「没试过」必须能区分。
 * @returns {string} 页面脚本。
 */
function probeScript() {
  const groups = {
    list: LIST_SELECTORS,
    row: ROW_SELECTORS,
    thread: THREAD_SELECTORS,
    message: MESSAGE_SELECTORS,
    composer: COMPOSER_INPUT_SELECTORS,
  };
  return [
    '(() => {',
    '  const groups = ' + JSON.stringify(groups) + ';',
    '  const probes = {};',
    '  for (const [group, sels] of Object.entries(groups)) {',
    '    probes[group] = sels.map((sel) => {',
    '      let count = -1;',
    '      try { count = document.querySelectorAll(sel).length; } catch (e) { count = -1; }',
    '      return { sel, count };',
    '    });',
    '  }',
    '  return JSON.stringify({',
    '    url: location.href,',
    '    title: document.title,',
    '    bodyLen: (document.body.innerText || "").length,',
    '    textareas: Array.from(document.querySelectorAll("textarea")).map((el) => ({',
    '      placeholder: el.getAttribute("placeholder") || "",',
    '      cls: el.className || "",',
    '      w: Math.round(el.getBoundingClientRect().width),',
    '      h: Math.round(el.getBoundingClientRect().height),',
    '    })),',
    '    probes,',
    '  });',
    '})()',
  ].join('\n');
}

/** 打一张分组命中表。 */
function printProbes(probes) {
  for (const [group, rows] of Object.entries(probes ?? {})) {
    console.log('\n  [' + group + ']');
    for (const row of rows) {
      const mark = row.count > 0 ? '✓' : '·';
      console.log('    ' + mark + ' ' + String(row.count).padStart(4) + '  ' + row.sel);
    }
  }
}

const args = parseArgs(process.argv.slice(2));
const subprocess = nodeSubprocess();
const ctx = { get: (key) => (key === 'subprocess' ? subprocess : undefined) };
const { settings, dataDir } = loadSettings();
fs.mkdirSync(dataDir, { recursive: true });

const located = await locateCli(ctx, 'ziniao', settings);
if (!located.found) {
  console.error('✗ 没找到紫鸟CLI：' + located.install);
  process.exit(1);
}
console.log('紫鸟CLI : ' + located.path);
console.log('设置    : ' + path.join(dataDir, 'settings.json'));

const ziniao = createZiniaoClient({
  ctx,
  settings,
  cwd: dataDir,
  env: (found) => ({
    PATH: buildSearchPath({ extraDirs: found?.path ? [path.dirname(found.path)] : [] }),
    NO_COLOR: '1',
    TERM: 'dumb',
    ZINIAO_CLI_NO_UPDATE_CHECK: '1',
  }),
  logger: { warn: (...a) => console.warn('  ! ', ...a) },
  run: (c, spec) => runCli(c, spec),
});

const adapter = createWalmartAdapter({ ziniao, settings });

const all = await adapter.listAllStores();
// 用适配器的 listStores：它已经排掉了停用店（判定见 lib/ziniao.js 的 isRetiredStore）。
const stores = await adapter.listStores();
const retired = all.filter((store) => isWalmartStore(store) && isRetiredStore(store));
console.log('\n账号下共 ' + all.length + ' 家店铺，其中沃尔玛 ' + stores.length + ' 家（另有 ' + retired.length + ' 家已停用，不参与巡逻）：');
for (const store of stores) console.log('  · ' + store.storeName + '  [' + store.storeId + ']  ' + store.platformName);
for (const store of retired) console.log('  · [已停用·不巡逻] ' + store.storeName + '  [' + store.storeId + ']');

if (args.list) process.exit(0);
if (!stores.length) {
  console.error('\n✗ 账号下没有沃尔玛店铺，先确认紫鸟里店铺的平台名（当前判定：platformName 含「沃尔玛」或店铺名以 Walmart 开头）');
  process.exit(1);
}

const store = args.store
  ? stores.find((entry) => entry.storeId === args.store) ?? all.find((entry) => entry.storeId === args.store)
  : stores[0];
if (!store) {
  console.error('\n✗ 没找到店铺 ' + args.store + '（用 --list 看可用的 storeId）');
  process.exit(1);
}

console.log('\n目标店铺：' + store.storeName + '  [' + store.storeId + ']');

// ── ① 先看登录态（只读地址，不导航、不点、不填） ──
const login = await adapter.checkLogin(store);
console.log('\n登录态：' + login.state);
console.log('  地址：' + (login.url || '(读不到)'));
console.log('  说明：' + login.hint);
if (args.autoLogin) {
  // 任何登录态下都可以跑：autoLogin 自己在「已经登录」时会立刻返回（这正是它的快路径）。
  // 真跑一遍适配器的自动登录：只点「登录 / 继续」，不代填账号密码、不碰验证码。
  console.log('\n── 自动登录（只点登录/继续，不代填凭据）──');
  const auto = await adapter.autoLogin(store, { attempts: 8, timeoutMs: 60000 });
  console.log('结果：' + (auto.ok ? '成功 ✓' : '未成功 ✗') + '  尝试 ' + auto.attempts + ' 次');
  console.log('地址：' + (auto.url || '(读不到)'));
  for (const step of auto.steps) {
    console.log('  · 第 ' + step.attempt + ' 次：kind=' + (step.kind || '-') + ' clicked=' + JSON.stringify(step.clicked) + (step.reason ? ' reason=' + step.reason : ''));
  }
  console.log('说明：' + auto.hint);
  const after = await adapter.checkLogin(store);
  console.log('复探登录态：' + after.state);
  if (after.state !== 'logged_in') process.exit(0);
}

if (login.state === 'login_required') {
  console.log('\n⚠️ 店铺未登录，无法校准。请**你本人**在紫鸟窗口里完成登录：');
  console.log('   ' + INBOX_URL);
  console.log('   登录完成后再跑一次本脚本（插件不代替人登录，也不碰验证码）。');
  process.exit(0);
}
if (login.state !== 'logged_in') {
  console.error('\n✗ 读不到页面地址，先确认店铺窗口能打开再重试');
  process.exit(1);
}

// ── ② 进收件箱 + 候选选择器命中表 ──
await adapter.openStore(store);
await adapter.visitInbox(store);
const ready = await adapter.waitForInbox(store);
console.log('\n收件箱行（' + ROW_SELECTORS[0] + '）' + (ready ? '已加载 ✓' : '没等到 ✗'));

const probeResult = await ziniao.call([
  'page',
  'exec',
  '--store-id',
  store.storeId,
  '--script',
  probeScript(),
]);
const probeText = probeResult?.data?.data?.result ?? probeResult?.data?.result ?? null;
let probePayload = null;
if (typeof probeText === 'string') {
  try {
    probePayload = JSON.parse(probeText);
  } catch (cause) {
    probePayload = null;
  }
}
if (probePayload) {
  console.log('\n页面：' + probePayload.title + '  (' + probePayload.url + ')');
  console.log('正文长度：' + probePayload.bodyLen);
  console.log('\n候选选择器命中数（✓ = 命中，命中 1 个以上的应该提到候选数组第一位）：');
  printProbes(probePayload.probes);
  if (Array.isArray(probePayload.textareas) && probePayload.textareas.length) {
    console.log('\n页面上的 textarea（回复框的实测特征是 placeholder「在此处输入回复」+ 580x128）：');
    for (const area of probePayload.textareas) {
      console.log('    ' + area.w + 'x' + area.h + '  placeholder=' + JSON.stringify(area.placeholder) + '  class=' + JSON.stringify(area.cls));
    }
  } else {
    console.log('\n页面上没有 textarea —— 打开某条会话后才会出现回复框（见下一步）。');
  }
} else {
  console.log('\n（命中表没取到：紫鸟返回了非预期结构，先看上面的原始输出）');
}

if (args.probeOnly) process.exit(0);

// ── ③ 让适配器真的跑一遍：列表 → 第一条会话 → 回复框（不填、不发） ──
console.log('\n── 适配器实跑（读列表 → 读会话 → 找回复框；全程不填不发）──');
try {
  const list = await adapter.listConversations(store);
  console.log('会话列表：' + list.items.length + ' 条，行选择器 = ' + JSON.stringify(list.rowSelector) + '，容器 = ' + JSON.stringify(list.containerSelector));
  for (const item of list.items.slice(0, 5)) {
    console.log('  · #' + item.index + ' ' + item.buyer + ' | ' + String(item.subject).slice(0, 60) + ' | 单号 ' + (item.orderId || '-'));
  }
  const max = Number.isFinite(Number(args.max)) ? Number(args.max) : 1;
  for (const item of list.items.slice(0, Math.max(0, max))) {
    const thread = await adapter.readConversation(store, item);
    console.log('\n会话 #' + item.index + '：消息 ' + thread.messageCount + ' 条，消息选择器 = ' + JSON.stringify(thread.messageSelector));
    for (const message of (thread.messages ?? []).slice(0, 6)) {
      console.log('  [' + message.dir + (message.dirGuess ? '?' : '') + '/' + message.dirSource + '] ' + String(message.body).slice(0, 90));
    }
    console.log('  最后一条买家消息：' + (thread.lastInbound ? JSON.stringify(String(thread.lastInbound.body).slice(0, 90)) : '(没判出来)'));
  }

  // 回复框只**探**不填：逐个候选 wait-element，报出第一个命中的。
  let composer = '';
  for (const selector of COMPOSER_INPUT_SELECTORS) {
    const hit = await ziniao.call([
      'page',
      'wait-element',
      '--store-id',
      store.storeId,
      '--selector',
      selector,
      '--timeout',
      '3000',
    ]);
    if (hit?.ok) {
      composer = selector;
      break;
    }
  }
  console.log('\n回复框：' + (composer ? '命中 ' + JSON.stringify(composer) + '（应提到 COMPOSER_INPUT_SELECTORS 第一位）' : '所有候选都没命中 ✗ —— 打开会话后回复框可能还没渲染，或页面已改版'));

  // ── ④ 打开一条会话之后再打一次命中表 ──
  // 会话正文栏与回复框**只有打开会话后才存在于 DOM 里**：第一次探针是在空收件箱上跑的，
  // 线程/消息/回复框三组全是 0 —— 那不是「选择器失效」，是「还没打开会话」。
  console.log('\n── 开了一条会话之后的命中表（线程 / 消息 / 回复框的真实证据）──');
  const afterResult = await ziniao.call(['page', 'exec', '--store-id', store.storeId, '--script', probeScript()]);
  const afterText = afterResult?.data?.data?.result ?? afterResult?.data?.result ?? null;
  if (typeof afterText === 'string') {
    try {
      const after = JSON.parse(afterText);
      printProbes({ thread: after.probes.thread, message: after.probes.message, composer: after.probes.composer });
    } catch (cause) {
      console.log('  （重探没取到：紫鸟返回了非预期结构）');
    }
  }
} catch (cause) {
  console.error('\n✗ 适配器实跑失败：' + (cause instanceof Error ? cause.message : cause));
  console.error('   把上面的失败原因与命中表一起记下来 —— 这就是校准要修的地方。');
  process.exitCode = 2;
}

console.log('\n✓ 侦察结束（没有填任何文本，也没有发送任何消息）');
