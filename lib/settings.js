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
import { normalizeChannelPlans, normalizeTimes } from './auto-patrol.js';
import { defaultDataDir } from './paths.js';

/** 出厂默认设置。 */
export const DEFAULT_SETTINGS = Object.freeze({
  version: 1,
  dataDir: null,
  cliPaths: { ziniao: null, lark: null },
  cliArgs: { ziniao: [], lark: [] },
  // 逐个 CLI 的总开关，默认都启用。关掉之后插件**不再调用**它，依赖它的渠道也不参与
  // 巡逻 —— 这是「这台机器上没有 / 不想用这个 CLI」的表达方式，不是故障，所以不报错、
  // 不进顶部的「需要处理」告警。
  cliEnabled: { ziniao: true, lark: true },
  // 要巡逻的飞书邮箱地址（显式列表）。飞书的邮箱接口在 bot 身份下不接受 `me`，
  // 没法自动枚举，所以必须写在这里；空数组 = 不巡逻任何邮箱。
  mailboxes: [],
  // 飞书邮箱渠道总开关（**老名字**，v0.13.0 起由 channelEnabled 统一管，这里只作兼容别名）。
  // 邮箱是「别人的地盘」：先把飞书CLI 接好（路径 + 附加参数 profile），再手动打开这里。
  // 关闭时该渠道完全不参与巡逻，扫描只回报「未启用」，不当成错误。
  mailEnabled: false,
  // **渠道级开关**：巡逻页每个平台块右边那枚开关写的就是这里。
  //
  // 刻意是**稀疏表**：只存用户显式改过的渠道。没写进来的渠道走适配器自己声明的默认值
  //（店铺类渠道默认开、飞书邮箱默认关）—— 把默认值也写进文件的话，将来改默认值就对
  // 老用户失效了，而且「没设过」和「显式设成默认值」这两种状态会被抹平。
  //
  // 键名就是渠道 id（与 autoPatrol.channels 同一约定）：设置层**不认识**渠道表，
  // 认不出的键留着不生效也不会带坏别的渠道；渠道被删掉时它只是不再被读到。
  channelEnabled: {},
  timezone: 'Asia/Shanghai',
  locale: 'zh-CN',
  sla: { defaultHours: 24 },
  retention: { auditDays: 30 },
  patrol: {
    maxStores: 0,
    maxPerStore: 50,
    closeAfter: false,
    // 空数组 = 全部已注册渠道（亚马逊店铺 + 飞书公共邮箱）。
    channels: [],
    // 默认不往别人邮箱里写草稿：批量把草稿塞进公共邮箱是「写别人的地方」，要人点头。
    writeMailDrafts: false,
    // 刻意**没有** headless 与 autoFillAmazon 两个键：
    //   1. 紫鸟浏览器永远可见地打开 —— 回复要直接填进这个窗口给人核对，无头等于白填；
    //   2. 「把草稿填进回复框」是默认行为，不再是可关的开关（见 lib/patrol.js 的 PATROL_DEFAULTS）。
    // 老 settings.json 里残留的这两个键会被 normalizeSettings 直接丢弃。
  },
  // 定时巡检。**默认关闭**：它会自己打开店铺浏览器做完整巡逻，这件事必须由人显式打开。
  //
  // 结构是「全局默认计划 + 每个平台一份自己的计划」：
  //   enabled / times        —— 全局默认计划。从旧版（一张全局时刻表）原样继承，
  //                             没有单独设置过的平台沿用它，这样升级不会悄悄改变行为。
  //   channels[平台 id]      —— 这个平台自己的计划：开关 + 时刻表 + 只巡检哪几家店。
  //                             一旦存在，就完全取代全局默认（不再叠加）。
  // 每张时刻表都是 HH:MM（按 timezone 判），到点跑一次、一个平台一天一个时刻只跑一次。
  autoPatrol: {
    enabled: false,
    times: ['09:00', '14:00', '20:00'],
    channels: {},
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

/**
 * 把「巡逻邮箱」收敛成地址数组。
 *
 * 同时接受数组（程序写入）与空格/逗号/分号分隔的字符串（界面里手输）。
 * 只保留含 `@` 的片段；按小写去重（飞书把地址当大小写不敏感），但保留用户输入的原始写法。
 * @param {unknown} value - 原始值。
 * @returns {string[]} 邮箱地址数组。
 */
export function parseMailboxes(value) {
  const parts = Array.isArray(value)
    ? value.map((item) => String(item))
    : typeof value === 'string'
      ? value.split(/[\s,;]+/)
      : [];
  const out = [];
  const seen = new Set();
  for (const part of parts) {
    const address = part.trim();
    if (!address || !address.includes('@')) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out.slice(0, 50);
}

/** 飞书邮箱渠道的 id（适配器注册表里的键）。刻意写成常量：它是老字段 mailEnabled 的落点。 */
export const MAIL_CHANNEL_ID = 'lark-mail';

/**
 * 渠道级开关的收敛：键名去空白、丢掉空键、最多 32 个。
 *
 * 值的规则与运行时判据（isChannelEnabled 的 `!== false`）**同一套**：
 * 只有显式写成 false 才算「关」，其余一律算「开」—— 两处规则不一致的话，
 * 会出现「文件里写着关、运行时当成开」这种最难查的错。
 *
 * **刻意保持稀疏**：没写进来的键就不存在，由 isChannelEnabled 的 fallback 决定默认值。
 * @param {unknown} value - 原始值（形如 { amazon: false, 'lark-mail': true }）。
 * @returns {Record<string, boolean>} 渠道 id → 是否启用。
 */
export function parseChannelEnabled(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (count >= 32) break;
    const id = String(key).trim();
    if (!id || id.length > 64) continue;
    out[id] = raw !== false;
    count += 1;
  }
  return out;
}

/**
 * 这个渠道现在开着吗 —— **渠道开关的唯一判据**（适配器的 enabled() 都走这里）。
 *
 * 优先级：
 *   1. settings.channelEnabled[id]（巡逻页那枚开关写的）；
 *   2. 老设置文件里飞书邮箱渠道的 mailEnabled（v0.12.0 及以前只有它有渠道开关）；
 *   3. 调用方给的 fallback（渠道自己的出厂默认：店铺类开、邮箱关）。
 *
 * 为什么不让「适配器各自读 settings.channelEnabled[id]」：那样每个渠道都要写一遍
 * 「先看新键、再看老键、再看默认」，漏一个就是「开关点了没反应」这种最难查的故障。
 * @param {object} settings - 设置对象。
 * @param {string} id - 渠道 id。
 * @param {boolean} [fallback] - 没有任何显式设置时的默认值。
 * @returns {boolean} 是否启用。
 */
export function isChannelEnabled(settings, id, fallback = true) {
  const map = settings?.channelEnabled;
  if (map && typeof map === 'object' && Object.prototype.hasOwnProperty.call(map, id)) {
    return map[id] !== false;
  }
  if (id === MAIL_CHANNEL_ID && settings?.mailEnabled !== undefined) {
    return settings.mailEnabled === true;
  }
  return fallback !== false;
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
  const cliEnabled = source.cliEnabled && typeof source.cliEnabled === 'object' ? source.cliEnabled : {};
  const channelEnabled = parseChannelEnabled(source.channelEnabled);
  const autoPatrol = source.autoPatrol && typeof source.autoPatrol === 'object' ? source.autoPatrol : {};
  const boolOr = (value, fallback) => (value === undefined ? fallback : Boolean(value));
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
    cliEnabled: {
      ziniao: boolOr(cliEnabled.ziniao, DEFAULT_SETTINGS.cliEnabled.ziniao),
      lark: boolOr(cliEnabled.lark, DEFAULT_SETTINGS.cliEnabled.lark),
    },
    mailboxes: parseMailboxes(source.mailboxes),
    channelEnabled,
    // mailEnabled 是**派生值**（读出来给老前端/老测试用）：真值在 channelEnabled 里。
    // 两条来源的优先级：channelEnabled['lark-mail'] > 老的 mailEnabled > 出厂默认（关）。
    mailEnabled: isChannelEnabled(
      { channelEnabled, mailEnabled: source.mailEnabled },
      MAIL_CHANNEL_ID,
      DEFAULT_SETTINGS.mailEnabled,
    ),
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
    autoPatrol: {
      enabled: boolOr(autoPatrol.enabled, DEFAULT_SETTINGS.autoPatrol.enabled),
      // 去重 + 按时间升序 + 丢掉非法项；「给了空数组」是有意义的（= 一次都不巡检），
      // 所以只有键不存在时才退回默认时刻表。
      times:
        autoPatrol.times === undefined
          ? [...DEFAULT_SETTINGS.autoPatrol.times]
          : normalizeTimes(autoPatrol.times),
      // 每个平台自己的计划。**键名就是渠道 id**，所以这里不做白名单校验 ——
      // 渠道表由适配器决定，设置层不认识它；认不出的键由调度器忽略，删掉渠道时
      // 它的计划也只是不再生效，不会把别的东西带坏。
      channels: normalizeChannelPlans(autoPatrol.channels),
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
      closeAfter:
        source.patrol && typeof source.patrol === 'object' && source.patrol.closeAfter !== undefined
          ? Boolean(source.patrol.closeAfter)
          : DEFAULT_SETTINGS.patrol.closeAfter,
      channels:
        source.patrol && typeof source.patrol === 'object' && Array.isArray(source.patrol.channels)
          ? source.patrol.channels.map((id) => String(id).trim()).filter(Boolean).slice(0, 10)
          : [...DEFAULT_SETTINGS.patrol.channels],
      writeMailDrafts:
        source.patrol && typeof source.patrol === 'object' && source.patrol.writeMailDrafts !== undefined
          ? Boolean(source.patrol.writeMailDrafts)
          : DEFAULT_SETTINGS.patrol.writeMailDrafts,
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
