/**
 * 客服插件 —— Host 半。
 *
 * 设计约束（也是它能在任何 DSH 实例上装的原因）：
 *   - 不 import 任何 `@deepseek-ai/*` 包：工具定义用普通对象（`ctx.tools.register`
 *     只要求 `{name, description, parameters, output:{schema,render}}`），
 *     服务用 `ctx.provide`，配置走自己的 settings.json 而不是 YAML 的 `config:`。
 *   - 只硬依赖 `webServer`（控制台需要它）。`subprocess` / `llm` / `tools` / `timer`
 *     全部软获取，缺了就降级显示，不影响插件激活。
 *   - 默认路径全部由 $DSH_HOME / $DSH_PROFILE 推导，不含任何本机绝对路径。
 *
 * @module dsh-customer-service-plugin
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import { createAutoPatrol } from './auto-patrol.js';
import { CLI_DEFS, buildSearchPath, locateCli } from './clilocator.js';
import { createRequestHandler, createToken, normalizePrefix } from './http.js';
import { createLogger } from './log.js';
import { detectProfile } from './paths.js';
import { createLarkClient } from './lark.js';
import { conversationUrl, createAmazonAdapter, isAmazonStore } from './platforms/amazon.js';
import { createLarkMailAdapter } from './platforms/lark-mail.js';
// SHEIN：已启用巡逻；会话行 / 正文两段选择器仍未校准，角标 > 0 时会明确报错而不是静默漏。
import {
  conversationUrl as sheinConversationUrl,
  createSheinAdapter,
  isSheinStore,
} from './platforms/shein.js';
import { conversationUrl as tiktokConversationUrl, createTikTokAdapter, isTikTokStore } from './platforms/tiktok.js';
// TEMU：已启用巡逻；收件箱（客服中心 → 消费者咨询）尚未校准，巡逻到已登录的店时会明确报错。
import { conversationUrl as temuConversationUrl, createTemuAdapter, isTemuStore } from './platforms/temu.js';
import {
  conversationUrl as walmartConversationUrl,
  createWalmartAdapter,
  isWalmartStore,
} from './platforms/walmart.js';
import {
  PATROL_DEFAULTS,
  PatrolError,
  createLoginService,
  createPatrolService,
  normalizePatrolOptions,
} from './patrol.js';
import { firstLine, runCli } from './proc.js';
import { INTENT_LABEL, INTENTS } from './reply.js';
import {
  MAIL_CHANNEL_ID,
  ensureDataDir,
  loadSettings,
  normalizeSettings,
  readJson,
  saveSettings,
} from './settings.js';
import { createStatsService, DIMENSIONS } from './stats.js';
import { createAuditStore } from './store/audit.js';
import { DRAFT_STATUSES, DraftError, createDraftStore } from './store/drafts.js';
import { QueueError, TRANSITIONS, createQueueStore } from './store/queue.js';
import { createZiniaoClient, isRetiredStore } from './ziniao.js';

/** 插件标识（同时是 Loader 行的 id 与客户端 bundle 的 id）。 */
export const name = 'customer-service';

/** 版本号的单一真相源是 package.json，避免两处各写一份然后漂移。 */
export const VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'dev';
  } catch {
    return 'dev';
  }
})();

/** 只硬依赖 Web 载体；其它能力软获取，保证在 headless/sdk 组合里安静地不激活。 */
export const inject = ['webServer'];

/** 探测结果缓存时长。 */
const DETECT_TTL_MS = 60_000;

/**
 * 建（或重建）整套数据层与服务：审计、队列、草稿、统计、紫鸟客户端、亚马逊适配器、巡逻。
 *
 * 独立成函数是因为**数据目录可以热切换** —— 换目录后所有存储都必须指向新位置，
 * 否则会出现「设置页显示新目录、工单其实还写在老目录」这种最难查的错。
 * 巡逻链路上的对象也要一起重建：它们各自持有一份 settings / dataDir 的引用，
 * 只换一部分会出现「草稿写新目录、巡逻还开老店的页面」。
 * @param {object} runtime - 运行时状态（需要 ctx / dataDir / settings）。
 * @param {object} logger - 日志器。
 * @returns {{audit: object, queue: object, drafts: object, stats: object, ziniao: object, adapter: object, patrol: object}} 服务集合。
 */
function createStores(runtime, logger) {
  const audit = createAuditStore({
    dir: runtime.dataDir,
    timezone: runtime.settings.timezone,
    retentionDays: runtime.settings.retention.auditDays,
    logger,
  });
  const queue = createQueueStore({
    file: path.join(runtime.dataDir, 'queue.json'),
    logger,
  });
  const drafts = createDraftStore({
    dir: path.join(runtime.dataDir, 'drafts'),
    logger,
  });
  const stats = createStatsService({
    queue,
    audit,
    getSettings: () => runtime.settings,
  });

  // 紫鸟客户端的 PATH 里必须带上 CLI 自己所在的目录：#! 脚本要找 node。
  const ziniao = createZiniaoClient({
    ctx: runtime.ctx,
    settings: runtime.settings,
    cwd: runtime.dataDir,
    env: (located) => cliEnv(located?.path ? [path.dirname(located.path)] : []),
    logger,
    // 每次紫鸟调用都留痕，统计页的「运行组」直接复用。
    onResult: (outcome) => {
      audit.append({
        kind: 'cli',
        name: 'ziniao',
        ok: outcome.ok,
        code: outcome.code,
        durationMs: outcome.durationMs,
        errorKind: outcome.error?.kind ?? null,
        detail: { args: outcome.args.slice(0, 6), via: 'patrol' },
      });
    },
  });
  // 飞书客户端：与紫鸟共用同一份调用封装，只是 key 不同。
  const lark = createLarkClient({
    ctx: runtime.ctx,
    settings: runtime.settings,
    cwd: runtime.dataDir,
    env: (located) => cliEnv(located?.path ? [path.dirname(located.path)] : []),
    logger,
    onResult: (outcome) => {
      audit.append({
        kind: 'cli',
        name: 'lark',
        ok: outcome.ok,
        code: outcome.code,
        durationMs: outcome.durationMs,
        errorKind: outcome.error?.kind ?? null,
        detail: { args: outcome.args.slice(0, 6), via: 'patrol' },
      });
    },
  });

  // 渠道注册表：巡逻引擎只认适配器，不认识任何平台。
  const amazon = createAmazonAdapter({ ziniao, settings: runtime.settings, logger });
  const tiktok = createTikTokAdapter({ ziniao, settings: runtime.settings, logger });
  const walmart = createWalmartAdapter({ ziniao, settings: runtime.settings, logger });
  // SHEIN 已启用（会话行 / 正文两段选择器仍未校准，见 lib/platforms/shein.js 文件头）。
  const shein = createSheinAdapter({ ziniao, settings: runtime.settings, logger });
  // TEMU 已启用：登录这一段（两套后台 + 未登录判据）已实测校准，收件箱那一段还没有
  // （2026-10-12 实测 9 家 TEMU 店全部未登录，见 lib/platforms/temu.js 文件头）。
  const temu = createTemuAdapter({ ziniao, settings: runtime.settings, logger });
  const larkMail = createLarkMailAdapter({ lark, settings: runtime.settings, logger });
  const adapters = {
    [amazon.id]: amazon,
    [tiktok.id]: tiktok,
    [walmart.id]: walmart,
    // 停用的渠道**照常注册**：巡逻会跳过它，但界面要能看到「有这么一个渠道、为什么没启用」。
    [shein.id]: shein,
    [temu.id]: temu,
    [larkMail.id]: larkMail,
  };

  // 登录态：**纯内存**，刻意不落盘（见 createLoginService 的注释）。巡逻与登录路由
  // 共用同一份，这样「刚刚点了登录、正在等人登完」的店，巡逻一眼就能跳过它。
  const loginState = createLoginService({ adapters, logger });

  const patrol = createPatrolService({
    adapters,
    drafts,
    queue,
    audit,
    settings: runtime.settings,
    logger,
    loginState,
    stateFile: path.join(runtime.dataDir, 'run', 'patrol-last.json'),
  });

  // 定时巡检：只给 patrol.start() 装一个「每分钟看一眼」的心跳，不碰巡逻逻辑本身。
  // 每个平台一张自己的时刻表与店铺清单（见 lib/auto-patrol.js）。
  const autoPatrol = createAutoPatrol({
    settings: runtime.settings,
    patrol,
    // 平台清单**现读**而不是捕获：渠道的启用状态随设置变，捕获一次会让
    // 「刚在设置里打开的邮箱渠道」永远不参与巡检。
    channels: () => channelList(runtime),
    audit,
    logger,
    stateFile: path.join(runtime.dataDir, 'run', 'auto-patrol.json'),
  });

  // adapter 保留为「亚马逊适配器」的别名（历史叫法，路由里已改走 adapters[platform]）。
  return { audit, queue, drafts, stats, ziniao, lark, adapters, adapter: amazon, patrol, autoPatrol, loginState };
}

/** 调 CLI 时固定注入的环境变量：关掉各种提示，保证输出可解析。 */
function cliEnv(extraDirs) {
  return {
    PATH: buildSearchPath({ extraDirs }),
    NO_COLOR: '1',
    TERM: 'dumb',
    PAGER: 'cat',
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    ZINIAO_CLI_NO_UPDATE_CHECK: '1',
  };
}

/**
 * 插件入口。
 * @param {object} ctx - Cordis 上下文。
 * @returns {void}
 */
export function apply(ctx) {
  const logger = createLogger(name);
  const selfPath = fileURLToPath(import.meta.url);
  const here = path.dirname(selfPath);
  const assetsDir = path.join(here, '..', 'assets');
  const seedDir = path.join(assetsDir, 'playbooks');
  const profile = detectProfile({ pluginPath: selfPath });

  const runtime = {
    ctx,
    logger,
    profile,
    assetsDir,
    seedDir,
    prefix: normalizePrefix(process.env.DSH_CS_PREFIX),
    token: createToken(),
    startedAt: Date.now(),
    detection: null,
    boot: null,
    ...loadSettings({ profile: profile.name }),
  };

  try {
    runtime.boot = ensureDataDir(runtime.dataDir, seedDir);
  } catch (cause) {
    runtime.boot = { error: cause instanceof Error ? cause.message : String(cause) };
    logger.warn('数据目录初始化失败：', runtime.boot.error);
  }
  if (runtime.firstRun) {
    try {
      saveSettings(runtime.file, runtime.settings);
    } catch (cause) {
      logger.warn('写入初始 settings.json 失败：', cause instanceof Error ? cause.message : cause);
    }
  }

  Object.assign(runtime, createStores(runtime, logger));
  // 测试钩子：整套服务挂在 ctx 上，测试才能换掉某个适配器方法（例如把「等登录」换成
  // 挂起版本 —— 生产里它要等 5 分钟）。这是只读的引用，生产代码不读它。
  //
  // ⚠️ 必须容错，而且必须在这里就容错：**真实的 Cordis ctx 是 Proxy**，给一个没有
  // 用 ctx.provide 声明过的属性赋值会**直接抛**
  //   Error: cannot set property "pluginRuntime" without provide
  // 而 apply() 是插件的激活函数 —— 这一行抛出去，整个插件就挂不上了：
  // 控制台路由不会注册，界面表现为「/cs 404、页面全白」，且**只有一行 warning**，
  // 极难定位。这个钩子只有测试用得上，生产里赋不上完全正常，绝不能因此让激活失败。
  try {
    if (ctx && typeof ctx === 'object') ctx.pluginRuntime = runtime;
  } catch {
    /* 真实 ctx 不允许设置未声明的属性：这是测试专用钩子，跳过即可。 */
  }
  try {
    runtime.audit.prune();
  } catch (cause) {
    logger.warn('审计清理失败：', cause instanceof Error ? cause.message : cause);
  }

  const handler = createRequestHandler({
    prefix: runtime.prefix,
    assetsDir,
    token: runtime.token,
    version: VERSION,
    logger,
    api: (method, rest, info) => route(runtime, method, rest, info),
  });

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: runtime.prefix,
        handler,
      }),
    'customer-service: console route',
  );

  // 定时巡检的心跳。跑不跑由**每个平台**自己的计划决定（都没有单独设置时沿用全局默认，
  // 而出厂默认是关闭）。心跳一律装上：装不装是能力，跑不跑是策略。
  runtime.autoPatrol?.start?.();

  logger.info(`控制台已挂载 ${runtime.prefix}/，数据目录 ${runtime.dataDir}`);
  ctx.on?.('dispose', () => {
    runtime.autoPatrol?.stop?.();
    logger.info('客服插件已卸载');
  });
}

/**
 * 把 `/queue/:id` 这类模板与实际路径匹配。
 * @param {string} pattern - 模板，例如 `/queue/:id`。
 * @param {string} routePath - 实际路径，例如 `/queue/q_abc`。
 * @returns {Record<string,string>|null} 参数对象；不匹配返回 null。
 */
export function matchPath(pattern, routePath) {
  const want = String(pattern).split('/').filter(Boolean);
  const got = String(routePath).split('/').filter(Boolean);
  if (want.length !== got.length) return null;
  const params = {};
  for (let i = 0; i < want.length; i += 1) {
    if (want[i].startsWith(':')) {
      let value = got[i];
      try {
        value = decodeURIComponent(value);
      } catch {
        return null;
      }
      if (!value) return null;
      params[want[i].slice(1)] = value;
      continue;
    }
    if (want[i] !== got[i]) return null;
  }
  return params;
}

/**
 * 在路由表里找一条匹配。
 * @param {string} method - HTTP 方法。
 * @param {string} routePath - 路径。
 * @param {Array<{method: string, path: string, handler: Function}>} [routes] - 路由表。
 * @returns {{route: object, params: Record<string,string>}|null} 命中结果。
 */
export function matchRoute(method, routePath, routes = ROUTES) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, routePath);
    if (params) return { route, params };
  }
  return null;
}

/**
 * 解析一个整数查询参数。
 * @param {unknown} value - 原始值。
 * @param {number} fallback - 默认值。
 * @param {number} [min] - 下限。
 * @param {number} [max] - 上限。
 * @returns {number} 结果。
 */
export function intOf(value, fallback, min = 0, max = 1000) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** 写操作之后：记审计 + 让统计缓存失效。 */
function afterWrite(runtime, event) {
  runtime.audit.append(event);
  runtime.stats.invalidate();
}

/** 设置接口的返回体（保持既有字段不变）。 */
function settingsPayload(runtime) {
  return {
    file: runtime.file,
    dataDir: runtime.dataDir,
    settings: runtime.settings,
  };
}

/** 维度与跃迁表：UI 的下拉与状态按钮都从这里取，避免前后端各写一份。 */
function metaPayload(runtime) {
  return {
    version: VERSION,
    prefix: runtime.prefix,
    dataDir: runtime.dataDir,
    timezone: runtime.settings.timezone,
    dimensions: DIMENSIONS,
    transitions: TRANSITIONS,
    // 宿主半能干哪些事。前端拿它判断「这份后端跟不跟得上」——比逐个探字段更直接，
    // 也让旧后端能被明确指出来，而不是让用户去点一个注定失败的按钮。
    //
    // 刻意**没有**为「fill 按 platform 分派」加能力位：TikTok 草稿只可能由认 tiktok 渠道的
    // 新后端造出来，旧后端根本走不到那条报错分支，加了也永远探不到，是死重量。
    // 渠道错配已经由 dimensions.channels 里的 tiktok 兜住了。
    //
    // 为「巡逻页登录」加一个能力位是另一回事：前端要**据此决定画不画「登录」按钮**。
    // 旧后端没有这个接口，画出来的按钮点下去只会得到一个 404 —— 那正是能力位要防的。
    // 能力名拼错会让按钮永远不出现，所以 test/routes.test.js 里有一条把它锁住。
    //
    // patrol.autoPerChannel：定时巡检从「一张全局时刻表」改成了「每个平台一份」，
    // /patrol.autoPatrol 的形状也从 { enabled, times } 变成了 { channels: {...} }。
    // 名字（渠道 id）与形状都没变，前端**没法从旧响应里看出这是旧后端** —— 它只会
    // 在每个平台块底下画出一片空白。所以这里显式加一个能力位，让顶部直接提示重启 DSH。
    //
    // patrol.channelSwitch：巡逻页每个平台块那一枚「启用 / 停用」开关（v0.13.0）。它靠
    // /patrol 的 channels[*].switchOn 画，而这个字段**旧后端压根没有** —— 旧后端下
    // 开关要么画不出来、要么点了没反应（POST /settings 会忽略 channelEnabled）。所以显式
    // 报一个能力位，让顶部直接提示重启 DSH。
    capabilities: ['drafts.delete', 'patrol.login', 'patrol.autoPerChannel', 'patrol.channelSwitch'],
    drafts: {
      statuses: DRAFT_STATUSES,
      intents: INTENTS,
      intentLabels: INTENT_LABEL,
    },
    patrol: {
      defaults: { ...PATROL_DEFAULTS, ...(runtime.settings.patrol ?? {}) },
    },
  };
}

/**
 * 把「不会被这个渠道巡逻的目标」按**平台**聚合。
 *
 * 为什么按平台而不是按店铺报：紫鸟账号下的店铺是跨 20+ 个平台的（实测 72 家店），
 * 按店铺报会得到一句「另有 66 个目标不会被巡逻」—— 数字很大但看不出**是什么**，
 * 而且每个渠道都会报一遍（亚马逊报 64、TikTok 报 66），同一个事实被重复了两遍。
 * 按平台聚合后，运营一眼看到的是「还有哪些平台没接」，这才是他真正能决策的东西。
 * @param {Array<object>} skipped - 被跳过的目标（带 platformName）。
 * @returns {Array<{platformName: string, stores: number}>} 按店铺数倒序的平台清单。
 */
export function groupSkippedByPlatform(skipped) {
  const map = new Map();
  for (const store of Array.isArray(skipped) ? skipped : []) {
    const name = String(store?.platformName ?? '').trim() || '未知平台';
    map.set(name, (map.get(name) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([platformName, stores]) => ({ platformName, stores }))
    .sort((a, b) => b.stores - a.stores || a.platformName.localeCompare(b.platformName));
}

/** 跳过目标的统计：给界面一句话用的「N 个平台 / M 家店」。 */
export function summarizeSkipped(skipped) {
  const byPlatform = groupSkippedByPlatform(skipped);
  return { byPlatform, platforms: byPlatform.length, stores: Array.isArray(skipped) ? skipped.length : 0 };
}

/** 店铺列表缓存时长：`store list` 要一两秒，控制台刷新很频繁，没必要每次都打。 */
const STORE_TTL_MS = 60_000;

/**
 * 每个「店铺渠道」认哪些店铺。
 *
 * 紫鸟的 store list 是全账号共享的一份清单（实机 72 家店、跨 20+ 个平台），
 * 每个渠道只巡逻自己那一部分，并把其余的放进 skipped 解释原因。
 * 这张表就是「哪个渠道认哪家店」的唯一真相源 —— 加渠道时在这里加一行，
 * 不要在扫描逻辑里写死某个平台的判定函数。
 */
const STORE_MATCHERS = Object.freeze({
  amazon: isAmazonStore,
  tiktok: isTikTokStore,
  walmart: isWalmartStore,
  // SHEIN 也认店，但渠道本身是停用的（enabled() 恒 false）：这一行只保证「SHEIN 店属于 SHEIN
  // 渠道」这条判定有唯一真相源，将来接巡逻时不用再改扫描逻辑。
  shein: isSheinStore,
  // TEMU 有两个 platformName（Temu-中国卖家中心 / Temu-美国-本土），判定函数在适配器里，
  // 这里只做「哪个渠道认哪家店」的登记。
  temu: isTemuStore,
});

/**
 * 扫描一个渠道下的巡逻目标（带缓存）。
 *
 * 「可用目标」= 这个渠道认出来的全部对象。亚马逊渠道会把非亚马逊店铺放进 `skipped`
 * 并带上原因 —— 运营在紫鸟里新增了一个店铺之后，最想知道的正是「它到底被看见没有、
 * 为什么没进列表」。
 *
 * 三个刻意的行为：
 *   1. **扫描失败时保留上一次的结果**，只把 error 附上。偶发的未登录/未授权不该让整个
 *      列表变空 —— 那会让人分不清「真的没有目标」和「这次没读到」。
 *   2. `added` / `removed` 只在两次扫描之间算差异，且**首次扫描不报差异**（没有基准）。
 *   3. 未授权这类「要先做一步才行」的失败，把 hint 一起带出来，界面直接可照做。
 * @param {object} runtime - 运行时。
 * @param {string} channelId - 渠道 id。
 * @param {{force?: boolean}} [opts] - 是否跳过缓存强刷。
 * @returns {Promise<object>} 扫描结果。
 */
async function scanChannel(runtime, channelId, opts = {}) {
  const cache = runtime.sourceCache ?? (runtime.sourceCache = {});
  const cached = cache[channelId];
  if (!opts.force && cached && Date.now() - cached.at < STORE_TTL_MS) {
    return { ...cached.value, cached: true };
  }
  const previous = cached?.value ?? null;
  const adapter = runtime.adapters?.[channelId];

  // 渠道被关掉不是错误：给界面一个明确的「未启用」态，而且**不进缓存** ——
  // 用户在设置里一打开开关，巡逻页下次刷新就得看见变化。
  if (adapter && typeof adapter.enabled === 'function' && !adapter.enabled()) {
    return {
      checkedAt: new Date().toISOString(),
      total: 0,
      items: [],
      skipped: [],
      skippedByPlatform: [],
      skippedPlatforms: 0,
      skippedStores: 0,
      retired: [],
      retiredStores: 0,
      added: [],
      removed: [],
      error: null,
      disabled: true,
      // 为什么不启用由适配器说：邮箱是「渠道开关没开」，亚马逊可能是「紫鸟CLI 被禁用」。
      hint:
        typeof adapter.disabledHint === 'function'
          ? adapter.disabledHint()
          : adapter.disabledHint ?? '该渠道已在设置里关闭。',
      cached: false,
    };
  }

  let value;
  if (!adapter) {
    value = {
      checkedAt: new Date().toISOString(),
      total: 0,
      items: [],
      skipped: [],
      skippedByPlatform: [],
      skippedPlatforms: 0,
      skippedStores: 0,
      retired: [],
      retiredStores: 0,
      added: [],
      removed: [],
      error: { kind: 'config', message: `未知渠道：${channelId}`, hint: null, fixCommand: null },
    };
  } else {
    try {
      // 店铺类渠道用「全量 + 过滤」，这样能解释别的平台为什么不在列表里；
      // 其余渠道（如邮箱）直接给该渠道的目标。
      //
      // 过滤函数**按渠道自己声明**，不能写死 isAmazonStore —— 那样每加一个店铺渠道，
      // 新渠道的目标都会被亚马逊的判定清空，表现为「扫描结果永远是 0 个目标」。
      const all = typeof adapter.listAllStores === 'function' ? await adapter.listAllStores() : await adapter.listSources();
      const matcher = STORE_MATCHERS[channelId] ?? null;
      // 已停用的店铺（店名带「停用/废弃/disabled」，判定见 ziniao.js）**单列一栏**：
      // 既不算巡逻目标（打开它只会拿到登录页或错误页），也不能混进「该平台暂未接入」——
      // 那会让运营以为这个平台没接好，而实际上是店自己停了。
      const retiredAll = all.filter((store) => isRetiredStore(store));
      const active = all.filter((store) => !isRetiredStore(store));
      const items = matcher ? active.filter(matcher) : active;
      // 只列**本渠道的**停用店：沃尔玛的停用店不该出现在亚马逊那一栏里刷屏。
      const retired = matcher ? retiredAll.filter(matcher) : retiredAll;
      const skipped = matcher
        ? active
            .filter((store) => !matcher(store))
            .map((store) => ({ ...store, reason: `当前只巡逻${adapter.label}店铺，该平台暂未接入` }))
        : [];
      const previousIds = new Set((previous?.items ?? []).map((store) => store.storeId));
      const currentIds = new Set(items.map((store) => store.storeId));
      const skip = summarizeSkipped(skipped);
      value = {
        checkedAt: new Date().toISOString(),
        total: all.length,
        items,
        skipped,
        // 界面那句「另有 N 个平台（M 家店）不会被巡逻」用的就是这两个数：
        // N = 没接入的平台数（**不是**店铺数），M = 这些平台下的店铺数。
        skippedByPlatform: skip.byPlatform,
        skippedPlatforms: skip.platforms,
        skippedStores: skip.stores,
        // 停用店：数量 + 明细都带上。界面据此单独显示一栏，并与「未接入平台」分开计数。
        retired: retired.map((store) => ({
          ...store,
          retired: true,
          reason: '店铺名带「停用」：不打开浏览器、不参与巡逻',
        })),
        retiredStores: retired.length,
        added: previous ? items.filter((store) => !previousIds.has(store.storeId)) : [],
        removed: previous ? (previous.items ?? []).filter((store) => !currentIds.has(store.storeId)) : [],
        error: null,
      };
    } catch (cause) {
      value = {
        checkedAt: new Date().toISOString(),
        total: previous?.total ?? 0,
        items: previous?.items ?? [],
        skipped: previous?.skipped ?? [],
        // 保留上一次的聚合口径：扫描失败时列表没清空，那个「N 个平台」也不该突然变成 0。
        skippedByPlatform: previous?.skippedByPlatform ?? [],
        skippedPlatforms: previous?.skippedPlatforms ?? 0,
        skippedStores: previous?.skippedStores ?? 0,
        retired: previous?.retired ?? [],
        retiredStores: previous?.retiredStores ?? 0,
        added: [],
        removed: [],
        error: {
          kind: cause?.kind ?? 'error',
          message: cause instanceof Error ? cause.message : String(cause),
          hint: cause?.hint ?? null,
          fixCommand: cause?.fixCommand ?? null,
        },
      };
    }
  }
  cache[channelId] = { at: Date.now(), value };
  return { ...value, cached: false };
}

/**
 * 扫描全部（或指定）渠道。
 * @param {object} runtime - 运行时。
 * @param {{force?: boolean, channels?: string[]}} [opts] - 选项。
 * @returns {Promise<Record<string, object>>} 渠道 id → 扫描结果。
 */
async function scanChannels(runtime, opts = {}) {
  const ids = opts.channels?.length ? opts.channels : Object.keys(runtime.adapters ?? {});
  const out = {};
  for (const id of ids) {
    out[id] = await scanChannel(runtime, id, { force: opts.force === true });
  }
  return out;
}

/** 渠道清单（给界面画标题用）。 */
function channelList(runtime) {
  return Object.values(runtime.adapters ?? {}).map((adapter) => ({
    id: adapter.id,
    label: adapter.label,
    kind: adapter.kind ?? 'store',
    // 关掉的渠道仍然列出来（否则用户不知道有这个入口），由界面渲染成「未启用」。
    enabled: typeof adapter.enabled === 'function' ? adapter.enabled() : true,
    // **渠道自己那枚开关**（settings.channelEnabled 里那一条；不含紫鸟CLI / 飞书CLI 的总开关）。
    // 巡逻页每一行画的就是它。
    //
    // 字段名刻意叫 switchOn 而不是 channelEnabled：/health 的 autoPatrol.channels[*].channelEnabled
    // 已经是另一个意思（那个渠道**现在可不可用**，= 渠道开关 ∧ CLI 开关）。两个 payload 里同名字段
    // 含义不同是最容易写出 bug 的那种坑，所以这里换个名字。
    //
    // 与 enabled 分开报，是因为两者会不一致：CLI 总开关关掉时 enabled=false 而这里仍是 true，
    // 界面要能说「不是这个渠道被停了，是 CLI 被禁用了」，而不是把开关画成关着让人白点。
    // 老适配器没声明 channelEnabled 时退回 enabled()：至少不会把「开着」画成「关着」。
    switchOn:
      typeof adapter.channelEnabled === 'function'
        ? adapter.channelEnabled()
        : typeof adapter.enabled === 'function'
          ? adapter.enabled()
          : true,
    // 这个渠道能不能自己登录（目前只有沃尔玛）：界面据此说明「未登录会自动登录，不用手动点」。
    autoLogin: adapter.supportsAutoLogin === true && typeof adapter.autoLogin === 'function',
  }));
}

/**
 * 最近一次巡逻的摘要 —— 界面靠它判断「哪批草稿是这次新生成的」。
 *
 * 内存里没有 run（比如刚重启过 DSH）时从 run/patrol-last.json 兜底：草稿上的 runId
 * 是永久留着的，重启一次就把高亮丢掉最可惜 —— 「这批是刚跑出来的」恰恰是重启之后
 * 最想知道的事。
 * @param {object} runtime - 运行时状态。
 * @returns {{id: string, status: string|null, finishedAt: string|null, draftsCreated: number}|null} 摘要。
 */
function lastRunSummary(runtime) {
  const active = runtime.patrol.snapshot().run;
  if (active?.id) {
    return {
      id: active.id,
      status: active.status ?? null,
      finishedAt: active.finishedAt ?? null,
      draftsCreated: active.progress?.draftsCreated ?? 0,
    };
  }
  const saved = readJson(path.join(runtime.dataDir, 'run', 'patrol-last.json'), null);
  if (!saved || typeof saved.id !== 'string' || !saved.id) return null;
  return {
    id: saved.id,
    status: typeof saved.status === 'string' ? saved.status : null,
    finishedAt: typeof saved.finishedAt === 'string' ? saved.finishedAt : null,
    draftsCreated: Number.isFinite(saved.progress?.draftsCreated) ? saved.progress.draftsCreated : 0,
  };
}

/* ── 登录：把浏览器开到登录页摆好，然后**停下来等人** ────────────────────────
 * 插件不代替人登录：真实登录的挑战两次实测都不一样（滑块 / 邮箱验证码），验证码又发到
 * 人手上。所以这里能做的只有三件事：开页面、报状态、在人登完之后把状态更新掉。
 *
 * **自动登录的渠道不在这条链路上**（目前只有沃尔玛）：它会自己点「登录 / 继续」把店登进去
 * （见适配器的 autoLogin），所以界面上**不暴露登录状态** —— 和亚马逊那块一个样子。
 * 理由很直接：把「2 家未登录」和一个「登录」按钮摆在人面前，人会以为要自己动手；
 * 而实际上巡逻会自己处理完。真失败了也不靠那个红点，而是写在巡逻结果的 auth.autoLogin 里
 * （哪一步、点了几次、卡在哪），信息量大得多。
 *
 * 人工入口并没有关：POST /patrol/login 显式带 channel + storeId 仍然能开登录页等人，
 * 只是界面上不再为这类渠道画按钮。
 * ─────────────────────────────────────────────────────────────────────────── */

/**
 * 哪些渠道需要**人工**登录 —— 界面据此画状态点、「登录」按钮与「N 家未登录」角标。
 *
 * 由能力探测决定，不写死平台 id；并且把有自动登录能力的渠道排除在外（见上面的说明）。
 */
function loginChannels(runtime) {
  return Object.values(runtime.adapters ?? {})
    .filter((adapter) => typeof adapter.checkLogin === 'function' || typeof adapter.openLogin === 'function')
    .filter((adapter) => !(adapter.supportsAutoLogin === true && typeof adapter.autoLogin === 'function'))
    .map((adapter) => adapter.id);
}

/**
 * 解析一次登录请求要动哪家店。
 *
 * 三种失败分得很细，因为它们要人做的事完全不同：
 *   渠道不支持登录 → 400；店铺找不到 → 404；店在家但渠道对不上 → 400。
 * 含糊地一律 400 或一律 500，运营只能来问人。
 * @param {object} runtime - 运行时。
 * @param {unknown} body - 请求体。
 * @returns {Promise<{channelId: string, adapter: object, store: object}>} 解析结果。
 */
async function resolveLoginTarget(runtime, body) {
  const input = body && typeof body === 'object' ? body : {};
  const storeId = String(input.storeId ?? '').trim();
  if (!storeId) throw new PatrolError('缺少 storeId：要点哪家店的「登录」？', 400);

  const requested = String(input.channel ?? '').trim();
  const candidates = requested ? [requested] : loginChannels(runtime);
  if (candidates.length === 0) {
    throw new PatrolError('当前没有任何支持登录的渠道', 400);
  }

  let unsupported = null;
  for (const channelId of candidates) {
    const adapter = runtime.adapters?.[channelId];
    if (!adapter) {
      if (requested) throw new PatrolError(`未注册的渠道：${channelId}`, 400);
      continue;
    }
    if (typeof adapter.openLogin !== 'function') {
      unsupported = adapter;
      continue;
    }
    // 先走**已扫描**的店铺列表（带缓存）：界面上那份列表就是这么来的，两处必须是同一批店。
    const cached = await scanChannel(runtime, channelId, {});
    const hit = cached.items.find((entry) => String(entry.storeId) === storeId);
    if (hit) return { channelId, adapter, store: hit };
  }
  if (unsupported) {
    // 指名道姓说渠道不支持，比「找不到店铺」准确得多 —— 邮箱渠道根本没有登录这一步。
    throw new PatrolError(`「${unsupported.label ?? unsupported.id}」渠道没有「登录」这一步`, 400);
  }

  // 缓存里没有，**强制重扫一次再找**。
  //
  // 为什么不能直接报 404：店铺列表缓存 60 秒（见 STORE_TTL_MS）。「刚在紫鸟里加了店铺，
  // 回来就点登录」是个完全正常的动作，直接 404 会让人以为店铺不存在，而实际上它就在那儿 ——
  // 而且重试也没用，得刷新页面等缓存过期。点「登录」本来就是低频的写动作，多扫一次很值。
  for (const channelId of candidates) {
    const adapter = runtime.adapters?.[channelId];
    if (!adapter || typeof adapter.openLogin !== 'function') continue;
    const fresh = await scanChannel(runtime, channelId, { force: true });
    const store = fresh.items.find((entry) => String(entry.storeId) === storeId);
    if (store) return { channelId, adapter, store };
  }
  throw new PatrolError(`找不到店铺 ${storeId}：先在巡逻页点一次「重新扫描」`, 404);
}

/**
 * 点「登录」：已登录直接说已登录；否则把人摆到登录页，**在后台**等他自己登完。
 *
 * 「后台等」是硬要求：waitForLogin 默认等 5 分钟，挂在 HTTP 请求里浏览器早超时了。
 * 所以这里返回 login_required 后由前端轮询 GET /patrol/login 看状态变没变。
 * @param {object} runtime - 运行时。
 * @param {unknown} body - 请求体。
 * @returns {Promise<object>} 响应数据。
 */
async function loginOpenPayload(runtime, body) {
  const { channelId, store } = await resolveLoginTarget(runtime, body);
  const result = await runtime.loginState.open(channelId, store, {});
  // 审计只记「谁点了登录、现在什么状态」：不记任何页面内容、不记令牌。
  runtime.audit.append({
    kind: 'patrol',
    name: 'login',
    ok: result.state !== 'failed',
    errorKind: result.error ? 'login' : null,
    detail: {
      channel: channelId,
      storeId: store.storeId,
      state: result.state,
      waiting: result.waiting === true,
    },
  });
  return result;
}

/** 巡逻页要的全量状态。 */
async function patrolPayload(runtime, opts = {}) {
  const sources = await scanChannels(runtime, opts);
  const snap = runtime.patrol.snapshot();
  return {
    ...snap,
    lastRun: lastRunSummary(runtime),
    // 自动巡逻状态：巡逻页要能显示「闲时会不会突然自己跑起来」。
    autoPatrol: runtime.autoPatrol?.snapshot?.() ?? null,
    channels: channelList(runtime),
    sources,
    // 登录态一起带上：巡逻页首屏就能把「这家店没登录」显示出来，不用先点一次登录按钮
    // 才知道。前端也可以只靠 GET /patrol 把整页画完。
    loginStates: runtime.loginState.snapshot(),
    loginChannels: loginChannels(runtime),
    drafts: runtime.drafts.counts(),
    defaults: { ...PATROL_DEFAULTS, ...(runtime.settings.patrol ?? {}) },
  };
}

/**
 * 给草稿补上「打开原会话」的深链。
 *
 * 地址由服务端拼：前端资源是零构建的原生 ESM，页面里写死任何 http 绝对地址都会
 * 被 assets 测试拦下（控制台必须能在任意前缀下工作）；而且链接模板只该有一份，
 * 就放在平台适配器里。
 *
 * 按平台分派，认不出的平台返回 null（前端据此隐藏入口）—— 不能拿一个平台的链接模板
 * 去拼另一个平台的会话，那会打开一个不存在的页面。
 * @param {object} item - 草稿。
 * @returns {object} 补过链接的草稿。
 */
const CASE_URL_BUILDERS = Object.freeze({
  amazon: conversationUrl,
  tiktok: tiktokConversationUrl,
  // 沃尔玛目前恒返回空串（没有已校准的会话级深链），前端据此隐藏「打开原会话」。
  walmart: walmartConversationUrl,
  // SHEIN 没有会话级深链，但恒返回**客服回复页入口**（chat工作台），草稿抽屉可以据此跳回去选会话。
  shein: sheinConversationUrl,
  // TEMU 恒返回空串：两套后台（kuajingmaihuo / seller.temu.com）不可能共用一个地址，
  // 而「客服中心 → 消费者咨询」的 URL 还没校准 —— 前端据此隐藏「打开原会话」。
  temu: temuConversationUrl,
});

function decorateDraft(item) {
  const build = CASE_URL_BUILDERS[item.platform];
  return { ...item, caseUrl: build ? build(item.caseId) : null };
}

/** 从查询串解析草稿筛选。 */
function draftFilters(query) {
  return {
    storeId: query?.get('storeId') || undefined,
    status: query?.get('status') || undefined,
    intent: query?.get('intent') || undefined,
    platform: query?.get('platform') || undefined,
    needsHuman: query?.get('needsHuman') || undefined,
    q: query?.get('q') || undefined,
    limit: intOf(query?.get('limit'), 100, 1, 500),
    offset: intOf(query?.get('offset'), 0, 0, 100000),
  };
}

/**
 * 给工单附上「实际截止时间」。
 *
 * 默认 SLA 规则只有一处定义（settings.sla.defaultHours），UI 不应该自己再算一遍 ——
 * 所以服务端把算好的 `dueAt` 一起返回。
 * @param {object} runtime - 运行时状态。
 * @param {object} item - 工单。
 * @returns {object} 带 `dueAt` 的工单。
 */
function withDue(runtime, item) {
  const hours = Number.isFinite(runtime.settings.sla?.defaultHours) ? runtime.settings.sla.defaultHours : 24;
  const dueAt = item.slaDueAt
    ? item.slaDueAt
    : item.receivedAt
      ? new Date(new Date(item.receivedAt).getTime() + hours * 3600 * 1000).toISOString()
      : null;
  return { ...item, dueAt, dueSource: item.slaDueAt ? 'item' : 'default' };
}

/** 从查询串解析队列筛选条件。 */
function queueFilters(query) {
  return {
    status: query?.get('status') || undefined,
    channel: query?.get('channel') || undefined,
    kind: query?.get('kind') || undefined,
    assignee: query?.get('assignee') || undefined,
    q: query?.get('q') || undefined,
    limit: intOf(query?.get('limit'), 100, 1, 500),
    offset: intOf(query?.get('offset'), 0, 0, 100000),
  };
}

/** 审计事件分页。 */
function activityPayload(runtime, context) {
  const query = context.query;
  const limit = intOf(query?.get('limit'), 50, 1, 500);
  const offset = intOf(query?.get('offset'), 0, 0, 100000);
  const kind = query?.get('kind') || null;
  const read = runtime.audit.readRange({
    from: query?.get('from') || undefined,
    to: query?.get('to') || undefined,
    limit: limit + offset,
    kinds: kind ? [kind] : undefined,
  });
  return {
    items: read.items.slice(offset, offset + limit),
    hasMore: read.truncated,
    skippedLines: read.skippedLines,
    days: read.days.length,
  };
}

/**
 * 路由表。handler 返回 `{status?, data?}`；抛出的 QueueError 会带状态码透出。
 * `:param` 表示单段路径参数。
 */
export const ROUTES = [
  { method: 'GET', path: '/health', handler: async (runtime) => ({ data: await buildHealth(runtime) }) },
  { method: 'GET', path: '/meta', handler: async (runtime) => ({ data: metaPayload(runtime) }) },
  { method: 'GET', path: '/settings', handler: async (runtime) => ({ data: settingsPayload(runtime) }) },
  {
    method: 'POST',
    path: '/settings',
    handler: async (runtime, context) => ({ data: applySettings(runtime, context.body) }),
  },
  {
    method: 'POST',
    path: '/detect',
    handler: async (runtime) => {
      await detect(runtime, { force: true });
      return { data: await buildHealth(runtime) };
    },
  },
  {
    method: 'GET',
    path: '/stats',
    handler: async (runtime, context) => ({
      data: runtime.stats.compute({ days: intOf(context.query?.get('days'), 14, 1, 90) }),
    }),
  },
  { method: 'GET', path: '/activity', handler: async (runtime, context) => ({ data: activityPayload(runtime, context) }) },
  {
    method: 'GET',
    path: '/queue',
    handler: async (runtime, context) => {
      const list = runtime.queue.list(queueFilters(context.query));
      return { data: { ...list, items: list.items.map((item) => withDue(runtime, item)) } };
    },
  },
  {
    method: 'POST',
    path: '/queue',
    handler: async (runtime, context) => {
      const result = runtime.queue.create(context.body ?? {});
      if (!result.deduped) {
        afterWrite(runtime, {
          kind: 'ticket',
          name: result.item.id,
          ok: true,
          detail: { action: 'created', channel: result.item.channel, kind: result.item.kind },
        });
      }
      return { status: result.deduped ? 200 : 201, data: { ...result, rev: runtime.queue.rev } };
    },
  },
  {
    method: 'GET',
    path: '/queue/:id',
    handler: async (runtime, context) => {
      const item = runtime.queue.get(context.params.id);
      if (!item) throw new QueueError(`工单不存在：${context.params.id}`, 404);
      return { data: { item: withDue(runtime, item), rev: runtime.queue.rev } };
    },
  },
  {
    method: 'PATCH',
    path: '/queue/:id',
    handler: async (runtime, context) => {
      const body = context.body ?? {};
      const before = runtime.queue.get(context.params.id);
      const item = runtime.queue.patch(context.params.id, body, { expectedRev: body.expectedRev });
      afterWrite(runtime, {
        kind: 'ticket',
        name: item.id,
        ok: true,
        detail: {
          action: 'updated',
          status: body.status ?? undefined,
          from: before?.status,
          assignee: body.assignee ?? undefined,
          note: body.note ? true : undefined,
        },
      });
      return { data: { item, rev: runtime.queue.rev } };
    },
  },

  /* ── 巡逻（一键把全部亚马逊店铺的客服页面过一遍，生成草稿） ─────────────── */

  {
    method: 'GET',
    path: '/patrol',
    handler: async (runtime, context) => ({
      data: await patrolPayload(runtime, { force: context.query?.get('refresh') === '1' }),
    }),
  },
  {
    method: 'GET',
    path: '/patrol/stores',
    handler: async (runtime, context) => ({
      // 兼容旧入口：只返回亚马逊渠道的扫描结果。
      data: await scanChannel(runtime, 'amazon', { force: context.query?.get('refresh') === '1' }),
    }),
  },
  {
    // 手动扫描：在紫鸟里新增/删除了店铺之后，点一下这里就能让列表跟上。
    // 用 POST 而不是 GET，是因为它是一次明确的用户动作，要带控制台令牌。
    method: 'POST',
    path: '/patrol/scan',
    handler: async (runtime, context) => {
      const sources = await scanChannels(runtime, {
        force: true,
        channels: Array.isArray(context.body?.channels) ? context.body.channels : undefined,
      });
      // 按渠道汇总一条审计：只记数量，不记店名/邮箱地址以外的任何内容。
      const summary = Object.entries(sources).map(([id, result]) => ({
        channel: id,
        total: result.total,
        supported: result.items.length,
        skipped: result.skipped.length,
        added: result.added.length,
        removed: result.removed.length,
        ok: !result.error,
      }));
      runtime.audit.append({
        kind: 'patrol',
        name: 'scan',
        ok: summary.every((entry) => entry.ok),
        errorKind: Object.values(sources).find((result) => result.error)?.error?.kind ?? null,
        detail: { channels: summary },
      });
      return { data: sources };
    },
  },
  {
    method: 'POST',
    path: '/patrol',
    handler: async (runtime, context) => {
      const run = runtime.patrol.start(context.body ?? {});
      runtime.audit.append({
        kind: 'patrol',
        name: 'start',
        ok: true,
        detail: { runId: run.id, options: run.options },
      });
      runtime.logger.info(
        `巡逻已启动 ${run.id}：每店最多 ${run.options.maxPerStore} 条，最多 ${run.options.maxStores || '全部'} 家店`,
      );
      return { status: 202, data: runtime.patrol.snapshot() };
    },
  },
  {
    method: 'POST',
    path: '/patrol/stop',
    handler: async (runtime) => {
      const result = runtime.patrol.stop();
      runtime.audit.append({ kind: 'patrol', name: 'stop', ok: true, detail: result });
      return { data: result };
    },
  },

  /* ── 登录（把店铺开到登录页摆好，剩下的人来做） ─────────────────────────── */

  {
    // 前端每 3 秒拉一次这里，看有没有店铺变成 logged_in。刻意是读接口、不要令牌：
    // 轮询不该每次都过一次鉴权（写动作才需要）。
    method: 'GET',
    path: '/patrol/login',
    handler: async (runtime) => ({
      data: {
        states: runtime.loginState.snapshot(),
        // 有登录概念的渠道，前端据此决定哪一行画「登录」按钮。
        channels: loginChannels(runtime),
        // 这家店正在等人登完 —— 前端据此显示「等待登录中」而不是让人反复点。
        waiting: Object.keys(runtime.loginState.snapshot()).filter((id) =>
          runtime.loginState.isWaiting(id),
        ),
      },
    }),
  },
  {
    // 写动作：自动走 createRequestHandler 的 x-cs-token 校验（与 /patrol/scan 同一条路）。
    method: 'POST',
    path: '/patrol/login',
    handler: async (runtime, context) => ({ data: await loginOpenPayload(runtime, context.body) }),
  },

  /* ── 草稿库 ──────────────────────────────────────────────────────────── */

  {
    method: 'GET',
    path: '/drafts',
    handler: async (runtime, context) => {
      const list = runtime.drafts.list(draftFilters(context.query));
      return { data: { ...list, items: list.items.map(decorateDraft) } };
    },
  },
  {
    method: 'GET',
    path: '/drafts/:id',
    handler: async (runtime, context) => {
      const item = runtime.drafts.get(context.params.id);
      if (!item) throw new DraftError(`草稿不存在：${context.params.id}`, 404);
      return { data: { item: decorateDraft(item), rev: runtime.drafts.rev } };
    },
  },
  {
    method: 'PATCH',
    path: '/drafts/:id',
    handler: async (runtime, context) => {
      const body = context.body ?? {};
      const item = decorateDraft(runtime.drafts.patch(context.params.id, body, { expectedRev: body.expectedRev }));
      afterWrite(runtime, {
        kind: 'draft',
        name: item.id,
        ok: true,
        detail: {
          action: 'updated',
          status: body.status ?? undefined,
          edited: body.body !== undefined ? true : undefined,
        },
      });
      return { data: { item, rev: runtime.drafts.rev } };
    },
  },
  {
    /**
     * 真删一条草稿。
     *
     * 与 PATCH {status:'discarded'} 的区别是**这条记录就没了**，撤销不了 —— 所以界面上
     * 这一下必须点确认，审计里也单独记一条 deleted。
     */
    method: 'DELETE',
    path: '/drafts/:id',
    handler: async (runtime, context) => {
      const item = runtime.drafts.remove(context.params.id);
      if (!item) throw new DraftError(`草稿不存在：${context.params.id}`, 404);
      // 工单上的草稿指针一起清掉：指向一条已经不存在的草稿，比空着更容易误导。
      // 刻意**不动工单状态** —— 删草稿不等于把工单打回未处理，那是另一件事，由人决定。
      if (item.ticketId) {
        try {
          runtime.queue.patch(item.ticketId, { draftId: null });
        } catch (cause) {
          runtime.logger.warn(`清工单 ${item.ticketId} 的草稿指针失败：${cause.message}`);
        }
      }
      afterWrite(runtime, {
        kind: 'draft',
        name: item.id,
        ok: true,
        detail: {
          action: 'deleted',
          platform: item.platform,
          storeId: item.storeId,
          status: item.status,
          ticketId: item.ticketId ?? undefined,
        },
      });
      return {
        data: { deleted: true, id: item.id, ticketId: item.ticketId ?? null, rev: runtime.drafts.rev },
      };
    },
  },
  {
    /**
     * 人工点单条草稿才会走到这里：把文本填进**该草稿所属平台**的回复框，**不发送**。
     *
     * 按 platform 分派到对应适配器 —— 不能写死亚马逊：TikTok 草稿走同一个入口，
     * 但店铺要在 TikTok 渠道里找、回复框要用 TikTok 的选择器填。
     */
    method: 'POST',
    path: '/drafts/:id/fill',
    handler: async (runtime, context) => {
      const item = runtime.drafts.get(context.params.id);
      if (!item) throw new DraftError(`草稿不存在：${context.params.id}`, 404);
      const adapter = runtime.adapters?.[item.platform];
      // 邮箱渠道的草稿落在飞书草稿箱，没有「填回复框」这回事，单独指路。
      if (!adapter || typeof adapter.fillComposer !== 'function') {
        throw new DraftError(
          item.platform === 'lark-mail'
            ? '这条是邮件草稿，请用 /drafts/:id/mail-draft 写进飞书草稿箱'
            : `这条草稿来自「${item.platform}」，该渠道没有可填的回复框`,
          400,
        );
      }
      const stores = await scanChannel(runtime, item.platform, {});
      const store = stores.items.find((entry) => entry.storeId === item.storeId);
      if (!store) {
        throw new PatrolError(
          `找不到店铺 ${item.storeId}（${item.storeName}），请先在紫鸟里确认该店铺还在账号下`,
          404,
        );
      }
      const result = await adapter.fillComposer(store, item.body, { caseId: item.caseId });
      const updated = decorateDraft(runtime.drafts.patch(item.id, { status: 'filled' }));
      afterWrite(runtime, {
        kind: 'draft',
        name: item.id,
        ok: true,
        detail: { action: 'filled', platform: item.platform, storeId: item.storeId, length: item.body.length },
      });
      return { data: { filled: true, ...result, item: updated } };
    },
  },
  {
    /**
     * 人工点单条邮件草稿才会走到这里：在飞书里建一封**回复草稿**（不发送）。
     *
     * 与亚马逊那条的区别在于草稿落在哪里 —— 邮件草稿进的是飞书草稿箱，人打开飞书就能看到、
     * 改完再自己点发送。巡逻默认不写这一步（批量往别人邮箱里塞草稿需要人点头）。
     */
    method: 'POST',
    path: '/drafts/:id/mail-draft',
    handler: async (runtime, context) => {
      const item = runtime.drafts.get(context.params.id);
      if (!item) throw new DraftError(`草稿不存在：${context.params.id}`, 404);
      if (item.platform !== 'lark-mail') {
        throw new DraftError(`这条草稿来自「${item.platform}」，不是飞书邮件草稿`, 400);
      }
      const adapter = runtime.adapters['lark-mail'];
      const sources = await adapter.listSources();
      const source = sources.find((entry) => entry.storeId === item.storeId);
      if (!source) {
        throw new PatrolError(`找不到邮箱 ${item.storeId}，请确认它还在可访问邮箱列表里`, 404);
      }
      const result = await adapter.createExternalDraft(source, { item: { messageId: item.caseId }, body: item.body });
      const updated = decorateDraft(runtime.drafts.patch(item.id, { status: 'filled' }));
      afterWrite(runtime, {
        kind: 'draft',
        name: item.id,
        ok: true,
        detail: { action: 'mail-draft', mailbox: item.storeId, length: item.body.length },
      });
      return { data: { created: true, ...result, item: updated } };
    },
  },
];

/**
 * 接口路由。
 * @param {object} runtime - 运行时状态。
 * @param {string} method - HTTP 方法。
 * @param {string} routePath - 已剥掉前缀与 `/api` 的路径。
 * @param {{body?: unknown, query?: URLSearchParams}} info - 请求信息。
 * @returns {Promise<{status?: number, body?: unknown}|undefined>} 响应或 undefined（404）。
 */
async function route(runtime, method, routePath, info) {
  const matched = matchRoute(method, routePath);
  if (!matched) return undefined;
  const result = await matched.route.handler(runtime, {
    params: matched.params,
    query: info?.query,
    body: info?.body,
  });
  if (!result) return undefined;
  return { status: result.status ?? 200, body: { ok: true, data: result.data ?? null } };
}

/**
 * 组装健康检查数据。
 * @param {object} runtime - 运行时状态。
 * @returns {Promise<object>} 健康数据。
 */
async function buildHealth(runtime) {
  const detection = await detect(runtime, {});
  const has = (key) => Boolean(runtime.ctx.get?.(key));
  return {
    ok: true,
    plugin: { id: name, version: VERSION, prefix: runtime.prefix, assetsDir: runtime.assetsDir },
    profile: runtime.profile.name,
    // env = 宿主注入了 DSH_PROFILE；path = 从插件安装路径 <.../profiles/<name>/> 推出；
    // default = 两者都没有（桌面应用的 link 安装就是这种情况）。
    profileSource: runtime.profile.source,
    dataDir: runtime.dataDir,
    settingsFile: runtime.file,
    timezone: runtime.settings.timezone,
    locale: runtime.settings.locale,
    boot: runtime.boot,
    runtime: {
      node: process.version,
      // 宿主自己注入的 DSH 版本（例如 0.2.0-rc.2），插件版本见 plugin.version。
      dshVersion: process.env.DSH_CLIENT_VERSION ?? null,
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      uptimeSec: Math.round((Date.now() - runtime.startedAt) / 1000),
      services: {
        webServer: has('webServer'),
        subprocess: has('subprocess'),
        llm: has('llm'),
        tools: has('tools'),
        timer: has('timer'),
        storage: has('storage'),
      },
    },
    clis: detection.clis,
    checkedAt: detection.checkedAt,
    store: {
      queueFile: runtime.queue.file,
      queueTotal: runtime.queue.counts().total,
      queueRev: runtime.queue.rev,
      auditDir: runtime.audit.dir,
      auditDays: runtime.audit.listDays().length,
      draftsFile: runtime.drafts.file,
      draftsTotal: runtime.drafts.counts().total,
    },
    patrol: {
      running: runtime.patrol.snapshot().running,
      defaults: runtime.settings.patrol,
      channels: channelList(runtime).map((channel) => channel.id),
    },
    // 渠道校准状态：适配器自己声明 verified=false + calibrationNote 时在这里露出来
    // （沃尔玛目前就是：入口/行/回复框实测过，列表容器与消息元素还没校准）。
    // 这件事要能在体检页看到，而不是等巡逻失败才被发现。
    channelCalibration: Object.fromEntries(
      Object.values(runtime.adapters ?? {})
        .filter((adapter) => adapter.verified === false || adapter.calibrationNote)
        .map((adapter) => [
          adapter.id,
          { verified: adapter.verified !== false, note: adapter.calibrationNote ?? null },
        ]),
    ),
    autoPatrol: runtime.autoPatrol?.snapshot?.() ?? null,
  };
}

/**
 * 探测两个 CLI 及其版本（带缓存）。
 * @param {object} runtime - 运行时状态。
 * @param {{force?: boolean}} [options] - 是否强制刷新。
 * @returns {Promise<{clis: Record<string, object>, checkedAt: string}>} 探测结果。
 */
async function detect(runtime, options = {}) {
  const force = options.force === true;
  const cached = runtime.detection;
  if (!force && cached && Date.now() - cached.at < DETECT_TTL_MS) return cached.value;

  const clis = {};
  for (const key of Object.keys(CLI_DEFS)) {
    const enabled = runtime.settings.cliEnabled?.[key] !== false;
    const located = await locateCli(runtime.ctx, key, runtime.settings);
    const entry = { ...located, enabled, version: null, error: null, fixCommand: null };
    // 被禁用的 CLI 一律不调用（连 --version 都不跑）：这是用户的选择，不是故障，
    // 所以既不报错、也不算「未找到」—— 界面上只画成「已禁用」。
    if (!enabled) {
      clis[key] = entry;
      continue;
    }
    if (!located.found || !located.path) {
      entry.error = {
        kind: 'missing',
        type: null,
        subtype: null,
        message: `未找到 ${located.label}`,
        hint: `安装：${located.install}`,
        fixCommand: located.install,
        raw: null,
      };
      entry.fixCommand = located.install;
      clis[key] = entry;
      continue;
    }
    const result = await runCli(runtime.ctx, {
      name: key,
      cli: located.path,
      args: [...located.args, '--version'],
      cwd: runtime.dataDir,
      timeoutMs: 20_000,
      env: cliEnv([path.dirname(located.path)]),
      // 每次 CLI 调用都留痕：统计页的「运行组」就是靠这些事件算出来的。
      onResult: (outcome) => {
        runtime.audit.append({
          kind: 'cli',
          name: key,
          ok: outcome.ok,
          code: outcome.code,
          durationMs: outcome.durationMs,
          errorKind: outcome.error?.kind ?? null,
          detail: { args: ['--version'], via: located.via },
        });
      },
    });
    if (result.ok) {
      entry.version = firstLine(result.stdout) || firstLine(result.stderr) || 'unknown';
    } else {
      entry.error = result.error;
      entry.fixCommand = result.error?.fixCommand ?? null;
    }
    clis[key] = entry;
  }

  const allOk = Object.values(clis).every(
    (entry) => entry.enabled === false || (entry.found && !entry.error),
  );
  runtime.audit.append({
    kind: 'detect',
    name: 'detect',
    ok: allOk,
    detail: {
      clis: Object.fromEntries(
        Object.entries(clis).map(([key, value]) => [
          key,
          {
            enabled: value.enabled !== false,
            found: value.found,
            ok: !value.error,
            // 只留版本号，不留 CLI 的整行输出 —— 审计里只放元数据。
            version: /(\d+\.\d+(?:\.\d+)?)/.exec(value.version ?? '')?.[1] ?? null,
          },
        ]),
      ),
    },
  });
  runtime.stats?.invalidate();

  const value = { clis, checkedAt: new Date().toISOString() };
  runtime.detection = { at: Date.now(), value };
  return value;
}

/**
 * 把 source 递归并入 target，**保持嵌套对象与数组的同一性**。
 *
 * 为什么要这么绕：CLI 客户端在构造时捕获 settings 对象，两个适配器还捕获了
 * `settings.patrol` 这类子对象。直接 `runtime.settings = merged` 会让这些引用
 * 永远停在旧值上，改动只有重启才生效。就地深合并后，捕获的引用依然指向同一批对象。
 * @param {object} target - 目标对象（就地修改）。
 * @param {object} source - 来源对象。
 * @returns {void}
 */
function mergeInPlace(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    const current = target[key];
    if (Array.isArray(value)) {
      if (Array.isArray(current)) {
        current.length = 0;
        current.push(...value);
      } else {
        target[key] = [...value];
      }
      continue;
    }
    if (value && typeof value === 'object' && current && typeof current === 'object' && !Array.isArray(current)) {
      mergeInPlace(current, value);
      continue;
    }
    target[key] = value;
  }
}

/**
 * 合并定时巡检设置。
 *
 * 结构是「全局默认计划（enabled / times）+ 每个平台一份（channels[渠道 id]）」。
 * 前两个字段按普通部分提交合并；channels 必须**逐个平台**并 ——
 * 对象展开只会整块替换，保存亚马逊那一份就会把 TikTok 的抹掉。
 * 某个平台传 null = 删掉它自己那份（退回全局默认）。
 * @param {object} current - 现有的 autoPatrol。
 * @param {unknown} patch - 客户端提交的补丁。
 * @returns {{enabled: unknown, times: unknown, channels: object}} 合并结果。
 */
function mergeAutoPlans(current, patch) {
  const base = current && typeof current === 'object' ? current : {};
  const next = patch && typeof patch === 'object' ? patch : {};
  const channels = {
    ...(base.channels && typeof base.channels === 'object' ? base.channels : {}),
  };
  const patchChannels =
    next.channels && typeof next.channels === 'object' ? next.channels : {};
  for (const [id, plan] of Object.entries(patchChannels)) {
    if (plan === null) {
      delete channels[id];
      continue;
    }
    if (!plan || typeof plan !== 'object') continue;
    channels[id] = { ...(channels[id] ?? {}), ...plan };
  }
  return {
    enabled: next.enabled === undefined ? base.enabled : next.enabled,
    times: next.times === undefined ? base.times : next.times,
    channels,
  };
}

/**
 * 把内存里那份「平台 → 计划」对齐到刚落盘的版本。
 *
 * mergeInPlace 只做「加 / 改」，**不会删** —— 而删掉一份计划（`{ channels: { x: null } }`）
 * 是接口支持的：文件里已经没有了，内存里那份却还在，调度器读的正是内存，
 * 于是「删掉了却还在跑」。所以这里按名字补一次删除。
 * @param {object} current - 内存里的 autoPatrol（就地修改）。
 * @param {object} next - 刚落盘的 autoPatrol。
 * @returns {void}
 */
function syncAutoChannels(current, next) {
  const target = current && typeof current === 'object' ? current.channels : null;
  if (!target || typeof target !== 'object') return;
  const keep = new Set(Object.keys((next && next.channels) || {}));
  for (const key of Object.keys(target)) {
    if (!keep.has(key)) delete target[key];
  }
}

/**
 * 保存设置，并在数据目录变化时热切换。
 * @param {object} runtime - 运行时状态。
 * @param {unknown} body - 客户端提交的设置补丁。
 * @returns {object} 保存后的结果。
 */
/**
 * 合并渠道级开关：已有状态 + 本次补丁，再把老字段 mailEnabled 翻译进来。
 *
 * 抽出来是因为「整块替换 vs 逐个并」这件事踩过一次（autoPatrol.channels 当初就是整块替换，
 * 保存亚马逊那一份会把 TikTok 的抹掉）。渠道开关是同一类结构，必须逐个并。
 * @param {object} current - 当前设置（含已规范化的 channelEnabled）。
 * @param {object} patch - 客户端提交的补丁。
 * @returns {Record<string, boolean>} 合并后的渠道开关表。
 */
export function mergedChannelEnabled(current, patch) {
  const incoming = patch?.channelEnabled && typeof patch.channelEnabled === 'object' && !Array.isArray(patch.channelEnabled)
    ? patch.channelEnabled
    : {};
  const merged = {
    ...(current?.channelEnabled && typeof current.channelEnabled === 'object' ? current.channelEnabled : {}),
    ...incoming,
  };
  // 老字段：飞书邮箱渠道的开关以前只有 mailEnabled 这一个入口（设置页那个复选框）。
  // 显式提交了它就按它算，否则保持 channelEnabled 里的值。
  if (patch?.mailEnabled !== undefined) merged[MAIL_CHANNEL_ID] = Boolean(patch.mailEnabled);
  return merged;
}

function applySettings(runtime, body) {
  const patch = body && typeof body === 'object' ? body : {};
  const merged = normalizeSettings({
    ...runtime.settings,
    ...patch,
    cliPaths: {
      ...runtime.settings.cliPaths,
      ...(patch.cliPaths && typeof patch.cliPaths === 'object' ? patch.cliPaths : {}),
    },
    cliArgs: {
      ...runtime.settings.cliArgs,
      ...(patch.cliArgs && typeof patch.cliArgs === 'object' ? patch.cliArgs : {}),
    },
    // 同理：只切一个 CLI 的开关时，不能把另一个的状态抹掉。
    cliEnabled: {
      ...runtime.settings.cliEnabled,
      ...(patch.cliEnabled && typeof patch.cliEnabled === 'object' ? patch.cliEnabled : {}),
    },
    // 渠道级开关（巡逻页每一行那枚开关）也是**按渠道 id 的第二层映射**：对象展开会整块替换，
    // 只切一个渠道不能把别的渠道的状态抹掉，所以逐个渠道并。
    //
    // 老的 mailEnabled 仍然认：旧前端（或旧标签页）提交的还是它 —— 不翻译的话，
    // 因为 channelEnabled['lark-mail'] 这时多半已经有值，那个复选框会「点了没反应」。
    channelEnabled: mergedChannelEnabled(runtime.settings, patch),
    // patrol 也是「部分提交」：界面上只改一个开关时，不能把其它巡逻参数抹掉。
    patrol: {
      ...runtime.settings.patrol,
      ...(patch.patrol && typeof patch.patrol === 'object' ? patch.patrol : {}),
    },
    // 定时巡检同理：只改一个字段时，别把开关和时刻表一起抹掉；
    // 而 channels 是**按平台 id 的第二层映射**，对象展开只会整块替换 ——
    // 保存亚马逊那一份会把 TikTok 的抹掉，所以必须逐个平台并。
    autoPatrol: mergeAutoPlans(runtime.settings.autoPatrol, patch.autoPatrol),
  });

  saveSettings(runtime.file, merged);
  const previousDataDir = runtime.dataDir;
  // 就地合并而不是整体替换 `runtime.settings = merged`：CLI 客户端和两个适配器在构造时
  // 就捕获了这个对象（或其子对象），整体替换会让它们一直读旧值 —— 表现为
  //「设置页保存成功、运行中的实例却还用旧 profile」，只能靠重启救。
  mergeInPlace(runtime.settings, merged);
  syncAutoChannels(runtime.settings.autoPatrol, merged.autoPatrol);
  // 定位结果里带着 cliArgs/cliPaths，设置变了必须让它失效，否则仍然用旧参数调 CLI。
  runtime.ziniao?.invalidate?.();
  runtime.lark?.invalidate?.();
  // 扫描结果里带着「这个渠道有没有开」「有哪些邮箱/店铺」，设置一变就得重扫。
  runtime.sourceCache = {};
  runtime.dataDir = merged.dataDir ? path.resolve(merged.dataDir) : path.dirname(runtime.file);
  runtime.detection = null;

  let moved = false;
  if (runtime.dataDir !== previousDataDir) {
    runtime.boot = ensureDataDir(runtime.dataDir, runtime.seedDir);
    // 数据目录换了，三个存储必须一起换 —— 否则会出现「设置页显示新目录、
    // 工单其实还写在老目录」这种最难排查的错。心跳也要一起换：它握着旧的 patrol
    // 与旧的状态文件，不换就会出现「往老目录写防抖状态」。
    runtime.autoPatrol?.stop?.();
    Object.assign(runtime, createStores(runtime, runtime.logger));
    runtime.autoPatrol?.start?.();
    moved = true;
  } else {
    runtime.audit.configure({
      timezone: merged.timezone,
      retentionDays: merged.retention.auditDays,
    });
  }
  // 设置改完立刻判一次：刚打开开关、或刚把时间窗调到现在，不用干等下一分钟的心跳。
  runtime.autoPatrol?.tick?.();

  runtime.audit.append({
    kind: 'settings',
    name: 'settings',
    ok: true,
    detail: {
      changed: Object.keys(patch),
      dataDirChanged: moved,
      timezone: merged.timezone,
      slaHours: merged.sla.defaultHours,
      auditDays: merged.retention.auditDays,
    },
  });
  runtime.stats.invalidate();
  runtime.logger.info(`设置已保存（dataDir=${runtime.dataDir}${moved ? '，已热切换' : ''}）`);
  return {
    file: runtime.file,
    dataDir: runtime.dataDir,
    settings: runtime.settings,
    dataDirChanged: moved,
  };
}
