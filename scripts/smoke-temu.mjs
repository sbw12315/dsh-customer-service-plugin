#!/usr/bin/env node
/**
 * 不依赖 DSH 的 **TEMU 校准/侦察**脚本。
 *
 * 用途：TEMU 这条链路目前只校准到「登录 + 两套后台的入口」——**买家会话工作台
 * （Temu 课程里的「客服中心 → 消费者咨询」）还没校准**（2026-10-12 实测 9 家 TEMU 店全部
 * 未登录，一条真实会话都进不去，所以按项目规矩不猜选择器）。登录完成之后跑这个脚本，它会告诉你：
 *
 *   1. 账号下有哪些 TEMU 店、各自走哪套后台（卖家中心 / 美区 Seller Central）；
 *   2. 当前登录态（只读地址，不代登）；
 *   3. 登录页的 tab 结构 —— 以及把 tab 切到「手机号登录」的结果（--open）；
 *   4. 登录之后：页面上的菜单 / 链接里，哪些是「客服 / 消费者咨询 / 工单」的入口；
 *      `--url=` 可以直接导航到候选地址再看一次，直到找到真正的工作台。
 *
 * **它永远不会发送任何消息**：链路上不存在发送动作。
 * **它永远不会代替人登录**：未登录时只把窗口摆好（可选切 tab），然后退出。
 *
 * 用法：
 *   node scripts/smoke-temu.mjs --list
 *   node scripts/smoke-temu.mjs --store=27409837973085
 *   node scripts/smoke-temu.mjs --store=27409837973085 --open
 *   node scripts/smoke-temu.mjs --store=27409837973085 --url=https://seller.kuajingmaihuo.com/message
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildSearchPath, locateCli } from '../lib/clilocator.js';
import {
  BACKEND_HOSTS,
  KUAJING_MESSAGE_CENTER_URL,
  backendOf,
  createTemuAdapter,
  homeUrlFor,
  isTemuStore,
} from '../lib/platforms/temu.js';
import { runCli } from '../lib/proc.js';
import { loadSettings } from '../lib/settings.js';
import { createZiniaoClient, isRetiredStore } from '../lib/ziniao.js';

/** 与 smoke-patrol.mjs / smoke-walmart.mjs 同一套：用 node:child_process 顶替宿主的 subprocess 服务。 */
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

const HINT_RE = /客服|消费者|咨询|工单|会话|接待|消息|service|support|consult|message|chat|ticket/i;

/** 页面骨架 + 客服入口候选的侦察脚本。 */
function dumpScript() {
  return [
    '(() => {',
    '  const squash = (value) => String(value || "").split("").filter((ch) => ch.charCodeAt(0) > 32).join("").toLowerCase();',
    '  const seen = {};',
    '  const links = Array.from(document.querySelectorAll("a[href]")).map((el) => ({',
    '    text: (el.innerText || "").trim().slice(0, 40),',
    '    href: el.href || "",',
    '  })).filter((row) => {',
    '    if (!row.text && !row.href) return false;',
    '    const key = row.href + "|" + row.text;',
    '    if (seen[key]) return false;',
    '    seen[key] = 1;',
    '    return true;',
    '  }).slice(0, 80);',
    '  const menus = Array.from(document.querySelectorAll("[class*=menu] div, [class*=nav] div, [role=menuitem], li"))',
    '    .map((el) => (el.innerText || "").trim())',
    '    .filter((text) => text && text.length <= 24 && text.indexOf(String.fromCharCode(10)) < 0)',
    '    .slice(0, 80);',
    '  return JSON.stringify({',
    '    url: location.href,',
    '    title: document.title,',
    '    bodyLen: ((document.body && document.body.innerText) || "").length,',
    '    links: links,',
    '    menus: Array.from(new Set(menus)),',
    '    textareas: Array.from(document.querySelectorAll("textarea")).map((el) => ({',
    '      placeholder: el.getAttribute("placeholder") || "",',
    '      cls: String(el.className || ""),',
    '      w: Math.round(el.getBoundingClientRect().width),',
    '      h: Math.round(el.getBoundingClientRect().height),',
    '    })),',
    '  });',
    '})()',
  ].join(String.fromCharCode(10));
}

/** 从紫鸟 page exec 的信封里取 JSON（真实客户端的结构是 data.data.result）。 */
async function readPage(ziniao, storeId, script) {
  const result = await ziniao.call(['page', 'exec', '--store-id', storeId, '--script', script]);
  const text = result?.data?.data?.result ?? result?.data?.result ?? null;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch (cause) {
    return null;
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

const adapter = createTemuAdapter({ ziniao, settings });
const all = await adapter.listAllStores();
const stores = await adapter.listStores();
const retired = all.filter((store) => isTemuStore(store) && isRetiredStore(store));
console.log(
  '\n账号下共 ' + all.length + ' 家店铺，其中 TEMU ' + stores.length + ' 家（另有 ' + retired.length + ' 家店名带「停用」，不参与巡逻）：',
);
for (const store of stores) {
  console.log('  · ' + store.storeName + '  [' + store.storeId + ']  ' + store.platformName + '  →  ' + homeUrlFor(store));
}
for (const store of retired) console.log('  · [已停用·不巡逻] ' + store.storeName + '  [' + store.storeId + ']');

if (args.list) process.exit(0);
if (!stores.length) {
  console.error('\n✗ 账号下没有 TEMU 店铺。判定：platformName 含 temu，或店名以 Temu- / TEMU- 开头');
  process.exit(1);
}

const store = args.store
  ? stores.find((entry) => entry.storeId === args.store) ?? all.find((entry) => entry.storeId === args.store)
  : stores[0];
if (!store) {
  console.error('\n✗ 没找到店铺 ' + args.store + '（用 --list 看可用的 storeId）');
  process.exit(1);
}
const backend = backendOf(store);
console.log('\n目标店铺：' + store.storeName + '  [' + store.storeId + ']  后台 ' + BACKEND_HOSTS[backend]);

// ── ① 登录态（只读地址，不导航、不点、不填） ──
const login = await adapter.checkLogin(store);
console.log('\n登录态：' + login.state);
console.log('  地址：' + (login.url || '(读不到)'));
console.log('  说明：' + login.hint);

// ── ② --open：把店铺开出来并切到「手机号登录」（与控制台点「登录」同一套代码） ──
if (args.open) {
  console.log('\n── 打开登录页（只切 tab，不填任何内容、不点登录）──');
  const opened = await adapter.openLogin(store);
  console.log('  结果：' + opened.state);
  console.log('  地址：' + (opened.url || '(读不到)'));
  console.log('  说明：' + opened.hint);
  if (opened.phoneLoginTab) {
    console.log('  切 tab：' + JSON.stringify(opened.phoneLoginTab));
  }
}

if (login.state === 'login_required' && !args.url) {
  console.log('\n⚠️ 店铺未登录，无法继续校准。请**你本人**在紫鸟窗口里完成登录：');
  console.log('   ' + homeUrlFor(store));
  console.log('   登录完成后再跑一次本脚本（插件不代替人登录，也不碰验证码）。');
  process.exit(0);
}
if (login.state === 'failed' && !args.open) {
  console.error('\n✗ 读不到后台地址：先用 --open 把店铺窗口打开再重试');
  process.exit(1);
}

// ── ③ 导航（可选）＋ 页面骨架：菜单 / 链接里哪些是客服入口 ──
const targetUrl = typeof args.url === 'string' ? args.url : homeUrlFor(store);
if (args.url) {
  console.log('\n── 导航到 ' + targetUrl + ' ──');
  await ziniao.callOrThrow(
    ['page', 'visit', '--store-id', store.storeId, '--url', targetUrl, '--wait-until', 'domcontentloaded', '--timeout', '60000'],
    { what: '导航到候选地址', timeoutMs: 90000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 3000));
}

const dump = await readPage(ziniao, store.storeId, dumpScript());
if (!dump) {
  console.error('\n✗ 页面骨架没读出来（紫鸟返回了非预期结构）');
  process.exit(1);
}
console.log('\n页面：' + dump.title + '  (' + dump.url + ')');
console.log('正文长度：' + dump.bodyLen);
console.log('\n菜单（前 40 条）：');
for (const item of dump.menus.slice(0, 40)) {
  console.log('  ' + (HINT_RE.test(item) ? '★' : '·') + ' ' + item);
}
console.log('\n链接（★ = 名字/地址像客服入口）：');
for (const link of dump.links) {
  const hit = HINT_RE.test(link.text) || HINT_RE.test(link.href);
  console.log('  ' + (hit ? '★' : '·') + ' ' + link.text + '  ->  ' + link.href);
}
if (dump.textareas.length) {
  console.log('\n页面上的 textarea（回复框候选）：');
  for (const area of dump.textareas) {
    console.log('    ' + area.w + 'x' + area.h + '  placeholder=' + JSON.stringify(area.placeholder) + '  class=' + JSON.stringify(area.cls));
  }
}

console.log('\n未校准的候选入口（供 --url= 试）：');
console.log('  · ' + KUAJING_MESSAGE_CENTER_URL + '（官方路由表里的「消息中心」，**不是**买家会话工作台）');
console.log('  · 「客服中心 → 消费者咨询」的真实地址还要靠上面的 ★ 链接找出来');
console.log('\n✓ 侦察结束（没有填任何文本，也没有发送任何消息）');