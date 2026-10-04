/**
 * 定位外部 CLI（ziniao-cli / lark-cli）。
 *
 * 为什么需要它：宿主给子进程的是「被清洗过的 PATH」，裸命令名不一定解析得到；
 * 而且同一个包要装在别人的机器上，不能写死本机路径。所以按四级优先级查找，
 * 并把最终路径回显到控制台，允许用户手动覆盖。
 *
 * @module dsh-customer-service-plugin/lib/clilocator
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execDir } from './paths.js';

/** 需要定位的 CLI 定义。 */
export const CLI_DEFS = Object.freeze({
  ziniao: {
    key: 'ziniao',
    bin: 'ziniao-cli',
    envVar: 'ZINIAO_CLI_PATH',
    label: '紫鸟CLI',
    install: 'npm install -g @ziniao-open/cli',
  },
  lark: {
    key: 'lark',
    bin: 'lark-cli',
    envVar: 'LARK_CLI_PATH',
    label: '飞书CLI',
    install: 'npm install -g @larksuite/cli',
  },
});

/**
 * 解析某个 CLI 时允许使用的其它命令名（Windows 需要 .cmd/.exe）。
 * @param {string} bin - 裸命令名。
 * @param {string} [platform] - process.platform。
 * @returns {string[]} 候选文件名。
 */
export function candidateNames(bin, platform = process.platform) {
  if (platform !== 'win32') return [bin];
  return [`${bin}.cmd`, `${bin}.exe`, `${bin}.bat`, bin];
}

/**
 * 按版本号倒序列出 nvm 安装的 node bin 目录（新版本优先）。
 * @param {string} home - 用户主目录。
 * @param {{fsApi?: typeof fs}} [deps] - 注入点。
 * @returns {string[]} bin 目录绝对路径。
 */
export function nvmBinDirs(home, deps = {}) {
  const fsApi = deps.fsApi ?? fs;
  const root = path.join(home, '.nvm', 'versions', 'node');
  let entries;
  try {
    entries = fsApi.readdirSync(root);
  } catch {
    return [];
  }
  const rank = (name) => {
    const digits = String(name).replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10));
    return digits.map((n) => (Number.isFinite(n) ? n : 0));
  };
  const compare = (a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < Math.max(ra.length, rb.length); i += 1) {
      const diff = (rb[i] ?? 0) - (ra[i] ?? 0);
      if (diff !== 0) return diff;
    }
    return String(b).localeCompare(String(a));
  };
  return [...entries].sort(compare).map((name) => path.join(root, name, 'bin'));
}

/**
 * 常见安装位置 + PATH 条目，作为探测目录。
 * @param {{env?: NodeJS.ProcessEnv, home?: string, platform?: string}} [options] - 输入。
 * @returns {string[]} 去重后的目录列表。
 */
export function probeDirs(options = {}) {
  const env = options.env ?? process.env;
  const home = options.home ?? os.homedir();
  const platform = options.platform ?? process.platform;
  const dirs = [];
  if (execDir()) dirs.push(execDir());
  if (platform === 'win32') {
    if (env.APPDATA) dirs.push(path.join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) {
      dirs.push(path.join(env.LOCALAPPDATA, 'pnpm'));
      dirs.push(path.join(env.LOCALAPPDATA, 'Programs', 'nodejs'));
    }
    if (env.ProgramFiles) dirs.push(path.join(env.ProgramFiles, 'nodejs'));
  } else {
    dirs.push(path.join(home, '.local', 'bin'));
    dirs.push(path.join(home, 'Library', 'pnpm'));
    dirs.push(path.join(home, '.npm-global', 'bin'));
    dirs.push('/opt/homebrew/bin');
    dirs.push('/usr/local/bin');
    dirs.push('/usr/bin');
    dirs.push('/bin');
    dirs.push(...nvmBinDirs(home));
  }
  const fromPath = String(env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  dirs.push(...fromPath);
  return dedupe(dirs);
}

/**
 * 去重并规范化目录列表。
 * @param {string[]} values - 输入。
 * @returns {string[]} 结果。
 */
export function dedupe(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (!value) continue;
    const key = process.platform === 'win32' ? value.toLowerCase() : value;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

/**
 * 拼出给子进程用的 PATH：宿主 node 目录在最前，其次被发现的 CLI 目录，最后原有 PATH。
 * @param {{extraDirs?: string[], env?: NodeJS.ProcessEnv, home?: string, platform?: string}} [options] - 输入。
 * @returns {string} PATH 值。
 */
export function buildSearchPath(options = {}) {
  const env = options.env ?? process.env;
  const base = String(env.PATH ?? env.Path ?? '')
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
  return dedupe([...(options.extraDirs ?? []), ...probeDirs(options), ...base]).join(path.delimiter);
}

/**
 * 判断路径是否是可执行文件。
 * @param {string} file - 候选路径。
 * @param {{fsApi?: typeof fs, platform?: string}} [deps] - 注入点。
 * @returns {boolean} 是否可用。
 */
export function isRunnable(file, deps = {}) {
  const fsApi = deps.fsApi ?? fs;
  const platform = deps.platform ?? process.platform;
  try {
    if (!fsApi.statSync(file).isFile()) return false;
  } catch {
    return false;
  }
  if (platform === 'win32') return true;
  try {
    fsApi.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 定位一个 CLI。四级优先级：settings 覆盖 → 环境变量 → 宿主 resolveExecutable → 常见目录探测。
 * @param {object} ctx - Cordis 上下文。
 * @param {string} key - `ziniao` 或 `lark`。
 * @param {{cliPaths?: Record<string, string|null>}} settings - 设置。
 * @param {{env?: NodeJS.ProcessEnv, home?: string, platform?: string, fsApi?: typeof fs}} [deps] - 注入点。
 * @returns {Promise<{key: string, label: string, bin: string, path: string|null, via: string, found: boolean, candidates: string[], install: string}>} 结果。
 */
export async function locateCli(ctx, key, settings, deps = {}) {
  const def = CLI_DEFS[key];
  if (!def) throw new Error(`unknown cli: ${String(key)}`);
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  // 附加参数必须前置：实测 `lark-cli --profile X --version` 合法，而
  // `lark-cli --version --profile X` 会失败；所有子命令都接受前置的全局 flag。
  const args = Array.isArray(settings?.cliArgs?.[key])
    ? settings.cliArgs[key].filter((item) => typeof item === 'string' && item.length > 0)
    : [];
  const base = {
    key: def.key,
    label: def.label,
    bin: def.bin,
    install: def.install,
    path: null,
    via: 'missing',
    found: false,
    candidates: [],
    args,
  };

  const override = settings?.cliPaths?.[key];
  if (typeof override === 'string' && override.trim()) {
    const resolved = path.resolve(override.trim());
    return { ...base, path: resolved, via: 'settings', found: isRunnable(resolved, deps) };
  }

  const fromEnv = typeof env[def.envVar] === 'string' ? env[def.envVar].trim() : '';
  if (fromEnv) {
    const resolved = path.resolve(fromEnv);
    return { ...base, path: resolved, via: 'env', found: isRunnable(resolved, deps) };
  }

  const candidates = [];
  for (const dir of dedupe([execDir(), ...probeDirs(deps)])) {
    for (const name of candidateNames(def.bin, platform)) {
      candidates.push(path.join(dir, name));
    }
  }

  const subprocess = ctx?.get?.('subprocess');
  if (subprocess?.resolveExecutable) {
    try {
      const resolved = await subprocess.resolveExecutable(def.bin, { PATH: buildSearchPath(deps) });
      if (resolved) return { ...base, path: resolved, via: 'PATH', found: true, candidates };
    } catch {
      // 解析失败继续走目录探测。
    }
  }

  for (const candidate of candidates) {
    if (isRunnable(candidate, deps)) {
      return { ...base, path: candidate, via: 'probe', found: true, candidates };
    }
  }

  return { ...base, candidates };
}
