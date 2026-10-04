/**
 * 数据目录解析。要求：默认值必须与本机无关，任何 DSH 实例上都不能写死路径。
 *
 * 优先级：
 *   1. settings.json 里的 dataDir（由控制台界面点击设置）
 *   2. 环境变量 DSH_CS_DIR
 *   3. <DSH_HOME|~/.dsh>/customer-service/<DSH_PROFILE|default>
 *
 * @module dsh-customer-service-plugin/lib/paths
 */

import os from 'node:os';
import path from 'node:path';

/**
 * 解析 DSH 主目录。
 * @param {NodeJS.ProcessEnv} [env] - 环境变量来源。
 * @returns {string} 绝对路径。
 */
export function dshHome(env = process.env) {
  const explicit = typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : '';
  return explicit ? path.resolve(explicit) : path.join(os.homedir(), '.dsh');
}

/**
 * 解析当前 profile 名（只看环境变量）。
 *
 * 注意：宿主进程**不一定**注入 `DSH_PROFILE`。实测桌面应用就没有注入，
 * 而用 CLI 起的实例会原样继承调用者的环境。所以单靠它并不可靠 —— 见 detectProfile。
 * @param {NodeJS.ProcessEnv} [env] - 环境变量来源。
 * @returns {string} profile 名，缺省 `default`。
 */
export function profileName(env = process.env) {
  const explicit = typeof env.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : '';
  return explicit || 'default';
}

/**
 * 从一段路径里提取 profile 名：`.../profiles/<name>/...`。
 *
 * `file:` 安装时插件被放在 `~/.dsh/profiles/<name>/node_modules/...`，于是
 * 插件自己的位置就是最可靠的 profile 线索 —— 比环境变量可靠。
 * @param {unknown} value - 任意路径（通常来自 import.meta.url）。
 * @returns {string|null} profile 名或 null。
 */
export function profileFromPath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const match = /[\\/]profiles[\\/]([^\\/]+)[\\/]/.exec(value);
  return match ? match[1] : null;
}

/**
 * 判定当前 profile：环境变量 → 插件自身安装路径 → default。
 * @param {{env?: NodeJS.ProcessEnv, pluginPath?: unknown}} [options] - 输入。
 * @returns {{name: string, source: 'env'|'path'|'default'}} 结果。
 */
export function detectProfile(options = {}) {
  const env = options.env ?? process.env;
  const explicit = typeof env.DSH_PROFILE === 'string' ? env.DSH_PROFILE.trim() : '';
  if (explicit) return { name: explicit, source: 'env' };
  const fromPath = profileFromPath(options.pluginPath);
  if (fromPath) return { name: fromPath, source: 'path' };
  return { name: 'default', source: 'default' };
}

/**
 * 默认数据目录：按 profile 隔离，避免多个 DSH 实例互相踩。
 * @param {NodeJS.ProcessEnv} [env] - 环境变量来源。
 * @param {string} [name] - 显式 profile 名。
 * @returns {string} 绝对路径。
 */
export function defaultDataDir(env = process.env, name) {
  return path.join(dshHome(env), 'customer-service', name ?? profileName(env));
}

/**
 * 按优先级解析数据目录。
 * @param {{settingsDataDir?: unknown, env?: NodeJS.ProcessEnv, profile?: string}} [options] - 输入。
 * @returns {string} 绝对路径。
 */
export function resolveDataDir(options = {}) {
  const env = options.env ?? process.env;
  const settingsDataDir =
    typeof options.settingsDataDir === 'string' ? options.settingsDataDir.trim() : '';
  if (settingsDataDir) return path.resolve(settingsDataDir);
  const envDir = typeof env.DSH_CS_DIR === 'string' ? env.DSH_CS_DIR.trim() : '';
  if (envDir) return path.resolve(envDir);
  return defaultDataDir(env, options.profile);
}

/**
 * 当前进程可执行文件所在目录 —— 需要它把 `node` 放进子进程 PATH。
 * @returns {string} 目录绝对路径。
 */
export function execDir() {
  try {
    return path.dirname(process.execPath);
  } catch {
    return '';
  }
}
