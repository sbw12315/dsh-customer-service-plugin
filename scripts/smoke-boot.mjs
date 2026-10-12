#!/usr/bin/env node
/**
 * 冒烟测试：在**真实的 Cordis 宿主**里把插件跑起来，验证它真的能激活。
 *
 * 为什么需要它（这不是假想的需求，是一次真实事故）：
 * 单测里的 ctx 是普通对象，给任何属性赋值都不会报错；而**真实的 Cordis ctx 是 Proxy**，
 * 给没声明过的属性赋值会直接抛 `cannot set property "x" without provide`。
 * 于是 `apply()` 里一行 `ctx.pluginRuntime = runtime`（测试钩子）在 365 个单测里全绿，
 * 到真实宿主却让**整个插件激活失败**：控制台路由不注册、界面一片白，宿主只留一行 warning。
 *
 * 单测能覆盖「已知的写法」，但覆盖不了「宿主到底怎么加载你」。这个脚本补的就是后者：
 * 起一个**一次性的最小 profile**（base + web-app + 本插件），在真宿主里启动，然后请求
 * /cs/api/meta。能返回 200 才算过。
 *
 * 用法：
 *   node scripts/smoke-boot.mjs
 *
 * 退出码：0 = 激活成功；1 = 没激活或接口不对。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, 'package.json'), 'utf8'));

const DSH_HOME = process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
const PROFILE = 'cs-boot-check';
const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
const PORT = Number(process.env.CS_SMOKE_PORT ?? 3099);

/** 找 dsh CLI：先看应用包，再看 PATH。 */
function findCli() {
  const candidates = [
    '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh',
    path.join(DSH_HOME, '..', 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh'),
  ];
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  return 'dsh';
}

/** 等接口可用。 */
async function waitForMeta(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return await res.json();
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return null;
}

/** 清理：删掉一次性 profile。 */
function cleanup() {
  try {
    fs.rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

const cli = findCli();
console.log(`冒烟测试：在真实 Cordis 宿主里激活 ${pkg.name}@${pkg.version}`);
console.log(`  一次性 profile: ${profileDir}`);

// 建最小 profile：只放 base + web-app + 本插件。
fs.rmSync(profileDir, { recursive: true, force: true });
fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true });
fs.writeFileSync(
  path.join(profileDir, 'package.json'),
  `${JSON.stringify(
    {
      name: `dsh-profile-${PROFILE}`,
      private: true,
      dependencies: { [pkg.name]: `link:${pluginDir}` },
      dsh: {
        profile: {
          bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', pkg.name],
        },
      },
    },
    null,
    2,
  )}\n`,
  'utf8',
);
fs.symlinkSync(pluginDir, path.join(profileDir, 'node_modules', pkg.name), 'dir');

const logFile = path.join(os.tmpdir(), `cs-smoke-boot-${Date.now()}.log`);
const out = fs.openSync(logFile, 'w');
// 必须显式给端口：不给的话 profile 会用默认的 3080，而脚本去轮询 3099 会误判成「没激活」。
const child = spawn(cli, ['--profile', PROFILE, '--no-open', '--port', String(PORT)], {
  cwd: os.tmpdir(),
  stdio: ['ignore', out, out],
  env: {
    ...process.env,
    DSH_DESKTOP_NODE_EXECUTABLE:
      process.env.DSH_DESKTOP_NODE_EXECUTABLE
      ?? '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness',
    // 别碰真实数据目录：这次启动只为了验证「能不能激活」。
    DSH_CS_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'cs-smoke-data-')),
  },
});

let ok = false;
let detail = '';
try {
  const meta = await waitForMeta(`http://127.0.0.1:${PORT}/cs/api/meta`, 40_000);
  if (!meta) {
    detail = '等 40 秒仍未起来：插件很可能没激活（看下面的启动日志）';
  } else if (meta?.data?.version !== pkg.version) {
    detail = `起来了但版本对不上：拿到 ${meta?.data?.version}，期望 ${pkg.version}`;
  } else {
    ok = true;
    detail = `version=${meta.data.version} channels=${JSON.stringify(meta.data.dimensions.channels)}`;
  }
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 1200));
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已经退出了 */
  }
  fs.closeSync(out);
  cleanup();
}

const log = fs.readFileSync(logFile, 'utf8');
if (ok) {
  console.log(`✓ 插件在真实宿主里激活成功  ${detail}`);
  process.exit(0);
}
console.error(`✗ 插件没有正常激活：${detail}`);
console.error('--- 启动日志 ---');
console.error(log.trim() || '(空)');
console.error('--- 日志文件: ' + logFile + ' ---');
process.exit(1);
