#!/usr/bin/env node
/**
 * 不依赖 DSH 的 CLI 连通性自检。
 *
 * 用途：在没有 DSH（或不想重启 DSH）的情况下，用插件**自己的** locator 与 runner
 * 去真的调一次 ziniao-cli / lark-cli，验证「找得到 + 调得动 + 解析得对」这条链路。
 *
 * 做法：把 ctx.subprocess 换成基于 node:child_process 的最小实现 —— 与宿主
 * `@deepseek-ai/dsh-subprocess-local` 的语义一致（argv[0] 是可执行文件、env 覆盖、
 * collect 模式的 readFrom）。
 *
 * 用法：
 *   node scripts/smoke-cli.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLI_DEFS, buildSearchPath, locateCli } from '../lib/clilocator.js';
import { runCli } from '../lib/proc.js';
import { loadSettings } from '../lib/settings.js';

/** 用 node:child_process 顶替宿主的 subprocess 服务。 */
function nodeSubprocess() {
  return {
    // 刻意返回 undefined，强制走目录探测分支，顺便验证探测逻辑本身。
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
            // close 可能早于最后一次 data 回调，延一拍再读，避免漏读输出。
            setTimeout(() => resolve({ exitCode: code, signal, spawnError }), 20);
          });
        }),
        collected: {
          stdout: {
            readFrom: () => ({ text: Buffer.concat(out).toString('utf8'), nextOffset: 0, lossy: false }),
          },
          stderr: {
            readFrom: () => ({ text: Buffer.concat(err).toString('utf8'), nextOffset: 0, lossy: false }),
          },
        },
      };
    },
  };
}

/** 每个 CLI 跑哪些只读命令。 */
const PROBES = {
  ziniao: [['--version'], ['zclaw', 'tools']],
  lark: [['--version'], ['doctor', '--offline']],
};

const subprocess = nodeSubprocess();
const ctx = { get: (key) => (key === 'subprocess' ? subprocess : undefined) };
const { settings, dataDir } = loadSettings();
let failures = 0;

// 插件的宿主半会自己建好数据目录；独立跑这个脚本时得自己补上，
// 否则子进程会因为 cwd 不存在而报一个很难排查的 ENOENT。
fs.mkdirSync(dataDir, { recursive: true });

console.log(`数据目录: ${dataDir}`);
console.log(`PATH 注入: ${buildSearchPath({}).split(path.delimiter).slice(0, 4).join(' : ')} …\n`);

for (const key of Object.keys(CLI_DEFS)) {
  const def = CLI_DEFS[key];
  const located = await locateCli(ctx, key, settings);
  console.log(`=== ${def.label} (${def.bin}) ===`);
  console.log(`  找到: ${located.found ? '是' : '否'}    来源: ${located.via}`);
  console.log(`  路径: ${located.path ?? '—'}`);
  if (!located.found) {
    console.log(`  安装: ${located.install}`);
    failures += 1;
    console.log();
    continue;
  }

  const env = {
    PATH: buildSearchPath({ extraDirs: [path.dirname(located.path)] }),
    NO_COLOR: '1',
    TERM: 'dumb',
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    ZINIAO_CLI_NO_UPDATE_CHECK: '1',
  };

  for (const args of PROBES[key]) {
    const result = await runCli(ctx, {
      name: key,
      cli: located.path,
      args: [...located.args, ...args],
      cwd: dataDir,
      timeoutMs: 30_000,
      env,
    });
    const label = `${def.bin} ${[...located.args, ...args].join(' ')}`;
    if (result.ok) {
      const summary = (result.stdout.trim() || result.stderr.trim()).replace(/\s+/g, ' ').slice(0, 110) || '(无输出)';
      console.log(`  ✓ ${label}  →  ${summary}`);
    } else {
      // 认证类失败是环境问题（需要人做一次配置/登录），不算脚本本身失败。
      const kind = result.error?.kind ?? 'error';
      const soft = kind === 'auth';
      if (!soft) failures += 1;
      console.log(`  ${soft ? '○' : '✗'} ${label}  →  [${kind}] ${result.error?.message ?? '未知错误'}`);
      if (result.error?.fixCommand) console.log(`      修复: ${result.error.fixCommand}`);
    }
  }
  console.log();
}

if (failures > 0) {
  console.error(`自检未通过：${failures} 项硬失败（认证类不计）。`);
  process.exitCode = 1;
} else {
  console.log('自检通过：CLI 定位、调用与解析链路正常。');
}
