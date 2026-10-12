#!/usr/bin/env node
/**
 * 不依赖 DSH 的「一键巡逻」实跑脚本。
 *
 * 用途：在没有 DSH（或不想重启 DSH）的情况下，用插件**自己的**运行链路真的跑一遍
 * 「列出全部亚马逊店铺 → 逐店打开买家消息 → 读会话 → 生成草稿 → 写入草稿库 + 工单队列」。
 * 与装了插件之后在控制台点「一键巡逻」跑的是同一套代码，只是把宿主服务换成了本地实现。
 *
 * 它**永远不会发送任何消息**：链路上不存在发送动作（见 test/amazon.test.js 的断言）。
 *
 * 用法：
 *   node scripts/smoke-patrol.mjs --list                  # 只列可巡逻的亚马逊店铺
 *   node scripts/smoke-patrol.mjs --list-all              # 全量店铺（含非亚马逊，解释为什么不被巡逻）
 *   node scripts/smoke-patrol.mjs                         # 按 settings.patrol 跑全部店铺
 *   node scripts/smoke-patrol.mjs --max-per-store=2 --max-stores=3
 *   node scripts/smoke-patrol.mjs --stores=27630232762680,27899883383180
 *   node scripts/smoke-patrol.mjs --close-after
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { buildSearchPath, locateCli } from '../lib/clilocator.js';
import { createPatrolService } from '../lib/patrol.js';
import { createAmazonAdapter, isAmazonStore } from '../lib/platforms/amazon.js';
import { runCli } from '../lib/proc.js';
import { loadSettings } from '../lib/settings.js';
import { createDraftStore } from '../lib/store/drafts.js';
import { createQueueStore } from '../lib/store/queue.js';
import { createZiniaoClient } from '../lib/ziniao.js';

/** 用 node:child_process 顶替宿主的 subprocess 服务。 */
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
  const out = { stores: [] };
  for (const arg of argv) {
    const match = /^--([a-zA-Z-]+)(?:=(.*))?$/.exec(arg);
    if (!match) continue;
    const key = match[1].replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    const value = match[2];
    if (value === undefined) out[key] = true;
    else if (key === 'stores') out.stores = value.split(',').map((id) => id.trim()).filter(Boolean);
    else out[key] = value;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const subprocess = nodeSubprocess();
const ctx = { get: (key) => (key === 'subprocess' ? subprocess : undefined) };
const { settings, dataDir, file } = loadSettings();
fs.mkdirSync(dataDir, { recursive: true });

const located = await locateCli(ctx, 'ziniao', settings);
if (!located.found) {
  console.error(`✗ 没找到紫鸟CLI：${located.install}`);
  process.exitCode = 1;
  process.exit();
}

/** 归一化后的巡逻参数（命令行 > settings.patrol > 默认）。 */
const patrolSettings = {
  ...settings,
  patrol: {
    ...settings.patrol,
    ...(args.maxPerStore !== undefined ? { maxPerStore: Number(args.maxPerStore) } : {}),
    ...(args.maxStores !== undefined ? { maxStores: Number(args.maxStores) } : {}),
    ...(args.closeAfter !== undefined ? { closeAfter: Boolean(args.closeAfter) } : {}),
  },
};

const ziniao = createZiniaoClient({
  ctx,
  settings: patrolSettings,
  cwd: dataDir,
  env: (found) => ({
    PATH: buildSearchPath({ extraDirs: found?.path ? [path.dirname(found.path)] : [] }),
    NO_COLOR: '1',
    TERM: 'dumb',
    ZINIAO_CLI_NO_UPDATE_CHECK: '1',
  }),
});
const adapter = createAmazonAdapter({ ziniao, settings: patrolSettings });

console.log(`紫鸟CLI : ${located.path}（${located.via}）`);
console.log(`设置    : ${file}`);
console.log(`数据目录: ${dataDir}`);

if (args.list || args.listAll) {
  // 与巡逻页的「扫描可用店铺」走同一套逻辑：全量 → 过滤出能巡逻的（含停用店排除）。
  const all = await adapter.listAllStores();
  const stores = await adapter.listStores();
  console.log(`\n账号下共 ${all.length} 家店铺，其中可巡逻的亚马逊店 ${stores.length} 家：`);
  for (const store of stores) console.log(`  · ${store.storeName}  [${store.storeId}]  ${store.platformName}`);
  const retired = all.filter((store) => store.retired === true);
  if (retired.length) {
    console.log(`\n已停用的店铺 ${retired.length} 家（不巡逻，店名带「停用/disabled」）：`);
    for (const store of retired) console.log(`  · ${store.storeName}  [${store.storeId}]  ${store.platformName}`);
  }
  if (args.listAll) {
    const skipped = all.filter((store) => !isAmazonStore(store) && !store.retired);
    console.log(`\n非亚马逊店铺 ${skipped.length} 家（当前不巡逻）：`);
    for (const store of skipped) console.log(`  · ${store.storeName}  [${store.storeId}]  ${store.platformName}`);
  }
  process.exit(0);
}

const drafts = createDraftStore({ dir: path.join(dataDir, 'drafts'), logger: { warn: (...a) => console.warn('  ! ', ...a) } });
const queue = createQueueStore({ file: path.join(dataDir, 'queue.json'), logger: { warn: (...a) => console.warn('  ! ', ...a) } });

const before = drafts.counts().total;
const service = createPatrolService({
  adapter,
  drafts,
  queue,
  settings: patrolSettings,
  logger: { info: () => {}, warn: (...a) => console.warn('  ! ', ...a) },
  stateFile: path.join(dataDir, 'run', 'patrol-last.json'),
});

const run = service.start({ storeIds: args.stores, maxPerStore: patrolSettings.patrol.maxPerStore });
console.log(`\n巡逻 ${run.id} 开始（每店最多 ${run.options.maxPerStore} 条）…\n`);

/** 打印增量进度。 */
let lastLine = '';
const timer = setInterval(() => {
  const snap = service.snapshot();
  if (!snap.run) return;
  const p = snap.run.progress;
  const line = `${snap.run.phase}  ${p.storesDone}/${p.storesTotal} 家店  会话 ${p.conversationsSeen}  新草稿 ${p.draftsCreated}  错误 ${p.errors}`;
  if (line !== lastLine) {
    lastLine = line;
    console.log(`  · ${line}`);
  }
}, 2000);

await new Promise((resolve) => {
  const check = setInterval(() => {
    if (service.snapshot().run?.status === 'running') return;
    clearInterval(check);
    resolve();
  }, 500);
});
clearInterval(timer);

const final = service.snapshot().run;
console.log(`\n巡逻 ${final.status}（${Math.round((Date.parse(final.finishedAt) - Date.parse(final.startedAt)) / 1000)}s）`);
for (const store of final.stores) {
  const mark = store.status === 'ok' ? '✓' : '✗';
  console.log(`  ${mark} ${store.storeName}：会话 ${store.conversations}，草稿 ${store.drafts}${store.error ? `  ← ${store.error}` : ''}`);
}
console.log(`\n草稿库：${before} → ${drafts.counts().total} 条（本次新增 ${final.progress.draftsCreated}）`);
const created = final.stores.flatMap((store) => store.items).filter((item) => item.draftId);
for (const item of created.slice(0, 20)) {
  console.log(`  · [${item.intentLabel ?? item.intent}] ${item.buyer}  ${item.orderId || '无订单号'}  ${item.draftId}${item.needsHuman ? '  ⚠需人工确认' : ''}`);
}
console.log(`\n草稿正文文件在 ${path.join(dataDir, 'drafts')}/<id>.txt；任何一条都没有被发送。`);
process.exit(final.status === 'done' ? 0 : 2);
