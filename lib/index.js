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
import { CLI_DEFS, buildSearchPath, locateCli } from './clilocator.js';
import { createRequestHandler, createToken, normalizePrefix } from './http.js';
import { createLogger } from './log.js';
import { detectProfile } from './paths.js';
import { conversationUrl, createAmazonAdapter } from './platforms/amazon.js';
import { PATROL_DEFAULTS, PatrolError, createPatrolService, normalizePatrolOptions } from './patrol.js';
import { firstLine, runCli } from './proc.js';
import { INTENT_LABEL, INTENTS } from './reply.js';
import { ensureDataDir, loadSettings, normalizeSettings, saveSettings } from './settings.js';
import { createStatsService, DIMENSIONS } from './stats.js';
import { createAuditStore } from './store/audit.js';
import { DRAFT_STATUSES, DraftError, createDraftStore } from './store/drafts.js';
import { QueueError, TRANSITIONS, createQueueStore } from './store/queue.js';
import { createZiniaoClient } from './ziniao.js';

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
  const adapter = createAmazonAdapter({ ziniao, settings: runtime.settings, logger });
  const patrol = createPatrolService({
    adapter,
    drafts,
    queue,
    audit,
    settings: runtime.settings,
    logger,
    stateFile: path.join(runtime.dataDir, 'run', 'patrol-last.json'),
  });

  return { audit, queue, drafts, stats, ziniao, adapter, patrol };
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

  logger.info(`控制台已挂载 ${runtime.prefix}/，数据目录 ${runtime.dataDir}`);
  ctx.on?.('dispose', () => logger.info('客服插件已卸载'));
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

/** 店铺列表缓存时长：`store list` 要一两秒，控制台刷新很频繁，没必要每次都打。 */
const STORE_TTL_MS = 60_000;

/**
 * 列账号下的亚马逊店铺（带缓存）。
 * @param {object} runtime - 运行时。
 * @param {{force?: boolean}} [opts] - 是否强刷。
 * @returns {Promise<{items: object[], error: object|null, checkedAt: string}>} 结果。
 */
async function listAmazonStores(runtime, opts = {}) {
  const cached = runtime.storeCache;
  if (!opts.force && cached && Date.now() - cached.at < STORE_TTL_MS) return cached.value;
  let value;
  try {
    const items = await runtime.adapter.listStores();
    value = { items, error: null, checkedAt: new Date().toISOString() };
  } catch (cause) {
    value = {
      items: [],
      error: {
        kind: cause?.kind ?? 'error',
        message: cause instanceof Error ? cause.message : String(cause),
        hint: cause?.hint ?? null,
        fixCommand: cause?.fixCommand ?? null,
      },
      checkedAt: new Date().toISOString(),
    };
  }
  runtime.storeCache = { at: Date.now(), value };
  return value;
}

/** 巡逻页要的全量状态。 */
async function patrolPayload(runtime, opts = {}) {
  const stores = await listAmazonStores(runtime, opts);
  const snap = runtime.patrol.snapshot();
  return {
    ...snap,
    stores,
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
 * @param {object} item - 草稿。
 * @returns {object} 补过链接的草稿。
 */
function decorateDraft(item) {
  return { ...item, caseUrl: item.platform === 'amazon' ? conversationUrl(item.caseId) : null };
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
      data: await listAmazonStores(runtime, { force: context.query?.get('refresh') === '1' }),
    }),
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
    // 人工点单条草稿才会走到这里：把文本填进亚马逊回复框，**不发送**。
    method: 'POST',
    path: '/drafts/:id/fill',
    handler: async (runtime, context) => {
      const item = runtime.drafts.get(context.params.id);
      if (!item) throw new DraftError(`草稿不存在：${context.params.id}`, 404);
      const stores = await listAmazonStores(runtime, {});
      const store = stores.items.find((entry) => entry.storeId === item.storeId);
      if (!store) {
        throw new PatrolError(`找不到店铺 ${item.storeId}（${item.storeName}），请先在紫鸟里确认该店铺还在账号下`, 404);
      }
      const result = await runtime.adapter.fillComposer(store, item.body, { caseId: item.caseId });
      const updated = decorateDraft(runtime.drafts.patch(item.id, { status: 'filled' }));
      afterWrite(runtime, {
        kind: 'draft',
        name: item.id,
        ok: true,
        detail: { action: 'filled', storeId: item.storeId, length: item.body.length },
      });
      return { data: { filled: true, ...result, item: updated } };
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
      adapter: runtime.adapter?.id ?? null,
    },
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
    const located = await locateCli(runtime.ctx, key, runtime.settings);
    const entry = { ...located, version: null, error: null, fixCommand: null };
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

  const allOk = Object.values(clis).every((entry) => entry.found && !entry.error);
  runtime.audit.append({
    kind: 'detect',
    name: 'detect',
    ok: allOk,
    detail: {
      clis: Object.fromEntries(
        Object.entries(clis).map(([key, value]) => [
          key,
          {
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
 * 保存设置，并在数据目录变化时热切换。
 * @param {object} runtime - 运行时状态。
 * @param {unknown} body - 客户端提交的设置补丁。
 * @returns {object} 保存后的结果。
 */
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
    // patrol 也是「部分提交」：界面上只改一个开关时，不能把其它巡逻参数抹掉。
    patrol: {
      ...runtime.settings.patrol,
      ...(patch.patrol && typeof patch.patrol === 'object' ? patch.patrol : {}),
    },
  });

  saveSettings(runtime.file, merged);
  const previousDataDir = runtime.dataDir;
  runtime.settings = merged;
  runtime.dataDir = merged.dataDir ? path.resolve(merged.dataDir) : path.dirname(runtime.file);
  runtime.detection = null;

  let moved = false;
  if (runtime.dataDir !== previousDataDir) {
    runtime.boot = ensureDataDir(runtime.dataDir, runtime.seedDir);
    // 数据目录换了，三个存储必须一起换 —— 否则会出现「设置页显示新目录、
    // 工单其实还写在老目录」这种最难排查的错。
    Object.assign(runtime, createStores(runtime, runtime.logger));
    moved = true;
  } else {
    runtime.audit.configure({
      timezone: merged.timezone,
      retentionDays: merged.retention.auditDays,
    });
  }
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
