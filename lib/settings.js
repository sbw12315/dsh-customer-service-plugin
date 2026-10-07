/**
 * 设置与数据目录的读写。
 *
 * 设置刻意不放在 cordis.patch.yml 的 `config:` 里：那样每台机器都要改 YAML，
 * 与「同一个包在任何 DSH 上都能装」冲突，也没法在界面上点击修改。
 *
 * @module dsh-customer-service-plugin/lib/settings
 */

import fs from 'node:fs';
import path from 'node:path';
import { defaultDataDir } from './paths.js';

/** 出厂默认设置。 */
export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  dataDir: null,
  cliPaths: { ziniao: null, lark: null },
  cliArgs: { ziniao: [], lark: [] },
  timezone: 'Asia/Shanghai',
  locale: 'zh-CN',
  sla: { defaultHours: 24 },
  retention: { auditDays: 30 },
  patrol: {
    maxStores: 0,
    maxPerStore: 3,
    headless: false,
    closeAfter: false,
  },
});

/** 数值字段的收敛范围。 */
const RANGES = Object.freeze({
  slaDefaultHours: [1, 720],
  auditDays: [1, 3650],
  patrolMaxStores: [0, 500],
  patrolMaxPerStore: [1, 50],
});

/**
 * 把数值收敛到范围内，非法值退回默认。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 默认值。
 * @param {[number, number]} range - 允许范围。
 * @returns {number} 收敛后的数值。
 */
export function clampNumber(value, fallback, range) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(range[1], Math.max(range[0], Math.round(parsed)));
}

/**
 * 把「附加参数」收敛成字符串数组。
 *
 * 同时接受两种写法：数组（程序写入）与空格分隔的字符串（界面里手输，
 * 例如 `--profile example-lark-profile`）。支持单/双引号包裹带空格的片段。
 * @param {unknown} value - 原始值。
 * @returns {string[]} 参数数组。
 */
export function parseArgs(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  const out = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match = pattern.exec(value);
  while (match !== null) {
    out.push(match[1] ?? match[2] ?? match[3]);
    match = pattern.exec(value);
  }
  return out.filter(Boolean);
}

/** 数据目录下需要存在的子目录。 */
const SUBDIRS = ['drafts', 'playbooks', 'run'];

/**
 * 读取 JSON 文件；任何异常都退化成 fallback，绝不抛。
 * @param {string} file - 文件路径。
 * @param {unknown} fallback - 失败时的返回值。
 * @returns {any} 解析结果或 fallback。
 */
export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * 原子写 JSON：先写同目录临时文件再 rename，避免半截文件。
 * @param {string} file - 目标文件。
 * @param {unknown} value - 要写入的值。
 * @returns {void}
 */
export function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * 把任意输入收敛成合法设置。
 * @param {unknown} raw - 读到的原始值。
 * @returns {typeof DEFAULT_SETTINGS} 规范化后的设置。
 */
export function normalizeSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const cliPaths = source.cliPaths && typeof source.cliPaths === 'object' ? source.cliPaths : {};
  const cliArgs = source.cliArgs && typeof source.cliArgs === 'object' ? source.cliArgs : {};
  const cleanCliPath = (value) =>
    typeof value === 'string' && value.trim() ? value.trim() : null;
  return {
    version: 1,
    dataDir: cleanCliPath(source.dataDir),
    cliPaths: {
      ziniao: cleanCliPath(cliPaths.ziniao),
      lark: cleanCliPath(cliPaths.lark),
    },
    cliArgs: {
      ziniao: parseArgs(cliArgs.ziniao),
      lark: parseArgs(cliArgs.lark),
    },
    timezone: cleanCliPath(source.timezone) ?? DEFAULT_SETTINGS.timezone,
    locale: cleanCliPath(source.locale) ?? DEFAULT_SETTINGS.locale,
    sla: {
      defaultHours: clampNumber(
        (source.sla && typeof source.sla === 'object' ? source.sla.defaultHours : undefined),
        DEFAULT_SETTINGS.sla.defaultHours,
        RANGES.slaDefaultHours,
      ),
    },
    retention: {
      auditDays: clampNumber(
        (source.retention && typeof source.retention === 'object' ? source.retention.auditDays : undefined),
        DEFAULT_SETTINGS.retention.auditDays,
        RANGES.auditDays,
      ),
    },
    patrol: {
      maxStores: clampNumber(
        (source.patrol && typeof source.patrol === 'object' ? source.patrol.maxStores : undefined),
        DEFAULT_SETTINGS.patrol.maxStores,
        RANGES.patrolMaxStores,
      ),
      maxPerStore: clampNumber(
        (source.patrol && typeof source.patrol === 'object' ? source.patrol.maxPerStore : undefined),
        DEFAULT_SETTINGS.patrol.maxPerStore,
        RANGES.patrolMaxPerStore,
      ),
      headless:
        source.patrol && typeof source.patrol === 'object' && source.patrol.headless !== undefined
          ? Boolean(source.patrol.headless)
          : DEFAULT_SETTINGS.patrol.headless,
      closeAfter:
        source.patrol && typeof source.patrol === 'object' && source.patrol.closeAfter !== undefined
          ? Boolean(source.patrol.closeAfter)
          : DEFAULT_SETTINGS.patrol.closeAfter,
    },
  };
}

/**
 * settings.json 的固定位置：DSH_CS_DIR 指到哪就放哪，否则放默认目录。
 *
 * 刻意做成「设置文件位置固定、dataDir 只决定大块运行数据放哪」：
 * 如果设置文件跟着 dataDir 跑，改一次数据目录就会留下两份互相矛盾的 settings.json。
 * @param {NodeJS.ProcessEnv} [env] - 环境变量来源。
 * @param {string} [name] - 显式 profile 名。
 * @returns {string} 目录绝对路径。
 */
export function settingsDir(env = process.env, name) {
  const explicit = typeof env.DSH_CS_DIR === 'string' ? env.DSH_CS_DIR.trim() : '';
  return explicit ? path.resolve(explicit) : defaultDataDir(env, name);
}

/**
 * 载入设置。
 * @param {{env?: NodeJS.ProcessEnv, dir?: string, profile?: string}} [options] - 输入。
 * @returns {{file: string, dataDir: string, settings: ReturnType<typeof normalizeSettings>, firstRun: boolean}} 结果。
 */
export function loadSettings(options = {}) {
  const env = options.env ?? process.env;
  const home = options.dir ? path.resolve(options.dir) : settingsDir(env, options.profile);
  const file = path.join(home, 'settings.json');
  const exists = fs.existsSync(file);
  const settings = normalizeSettings(readJson(file, null));
  const dataDir = settings.dataDir ? path.resolve(settings.dataDir) : home;
  return { file, dataDir, settings, firstRun: !exists };
}

/**
 * 保存设置（原子写）。
 * @param {string} file - settings.json 路径。
 * @param {unknown} settings - 设置对象。
 * @returns {ReturnType<typeof normalizeSettings>} 实际写入的规范化设置。
 */
export function saveSettings(file, settings) {
  const normalized = normalizeSettings(settings);
  writeJsonAtomic(file, normalized);
  return normalized;
}

/**
 * 建立数据目录骨架，并把出厂 playbook 模板补进去（已存在的不覆盖）。
 * @param {string} dir - 数据目录。
 * @param {string} [seedDir] - 出厂模板目录（包内 assets/playbooks）。
 * @returns {{created: string[], playbooks: string[]}} 创建与补种的清单。
 */
export function ensureDataDir(dir, seedDir) {
  const created = [];
  for (const sub of SUBDIRS) {
    const target = path.join(dir, sub);
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target, { recursive: true });
      created.push(target);
    }
  }
  const playbooks = [];
  if (seedDir && fs.existsSync(seedDir)) {
    const targetDir = path.join(dir, 'playbooks');
    for (const entry of fs.readdirSync(seedDir)) {
      if (!entry.endsWith('.json')) continue;
      const target = path.join(targetDir, entry);
      if (!fs.existsSync(target)) {
        fs.copyFileSync(path.join(seedDir, entry), target);
        playbooks.push(target);
      }
    }
  }
  return { created, playbooks };
}
