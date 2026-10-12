/**
 * 巡逻引擎：一键把**多个渠道**的待回复消息过一遍，逐条生成草稿。
 *
 * 当前接了四个渠道（都由适配器提供，引擎自己不认识任何平台）：
 *   - `amazon`    依次打开每家亚马逊店铺，读「需要回复」的买家消息；
 *   - `tiktok`    依次打开每家 TikTok Shop 店铺，读客服会话管理页的会话；
 *   - `walmart`   依次打开每家沃尔玛店铺，读 Customer 收件箱的会话；
 *   - `lark-mail` 逐个公共邮箱，读收件箱里**未回复**的邮件。
 *
 * 设计要点（每一条都对应一个真实会踩的坑）：
 *
 *   1. **串行**跑（渠道之间、目标之间都串行）。紫鸟是本地浏览器内核，并发开店铺会互抢
 *      焦点/端口；邮箱没这个问题，但串行让进度与限流都可预测。
 *   2. **一个目标失败不影响其它目标**。超时、未登录、未授权都只记在这个目标的结果里，
 *      走到下一个继续。巡航的价值在于「不漏」，不在于「一次全成功」。
 *   3. **永远只生成草稿**。引擎里没有任何发送路径；写进外部系统（飞书草稿箱）是适配器
 *      提供的可选动作，且永远是「存草稿」语义。
 *   4. **状态在内存里、进展可轮询**。run 暴露 phase / progress / 逐目标明细。
 *
 * @module dsh-customer-service-plugin/lib/patrol
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildDraft, summarizeThread } from './reply.js';
import { buildMailDraft } from './reply-mail.js';
import { buildSheinDraft } from './reply-shein.js';
import { buildTemuDraft } from './reply-temu.js';
import { buildTikTokDraft } from './reply-tiktok.js';
import { buildWalmartDraft } from './reply-walmart.js';

/** 巡逻的默认参数（settings.patrol 可以覆盖）。 */
export const PATROL_DEFAULTS = Object.freeze({
  /** 最多扫几个目标（店铺 / 邮箱）；0 = 全部。 */
  maxStores: 0,
  /** 每个目标最多生成几条草稿。默认就是上限 50：要的是「尽量别漏」，人为截断交给勾选。 */
  maxPerStore: 50,
  /** 跑完是否关掉店铺浏览器（注意：会把已填入但还没发送的回复一起关掉）。 */
  closeAfter: false,
  /** 要巡逻的渠道 id；空数组 = 全部已注册渠道。 */
  channels: [],
  /** 是否顺带把邮件草稿写进飞书草稿箱（仍然只存草稿，不发送）。 */
  writeMailDrafts: false,
  /**
   * 是否在巡逻时把草稿**自动填入**已经打开的亚马逊回复框。
   *
   * **默认开启，且不再是设置项**：草稿的归宿就是紫鸟浏览器里那个可见的回复框，
   * 人核对后自己点发送。仍然只填不发送；代价是跑一遍 8 家店会在浏览器里留下
   * 十几到几十个未发送的输入框（每换一家店，上一家的编辑器还开着）。
   * 保留这个键只是给接口/测试留一个显式关闭的口子（POST /patrol 传 false）。
   */
  autoFillAmazon: true,
  /**
   * 未登录时是否**自动登录**（只对有这个能力的渠道生效，目前只有沃尔玛）。
   *
   * **默认开启**：沃尔玛登录页上，紫鸟自己已经把账号密码填好、2 步验证的动态码也由
   * 紫鸟验证码服务自动填入，人在这里要做的只剩「点一下登录 / 继续」—— 插件代劳的正是
   * 这一下，因此**不接触任何凭据**。适配器没有 supportsAutoLogin 的渠道（TikTok）
   * 仍然照旧：预检到未登录就跳过，等人手动登录。
   */
  autoLogin: true,
});

/**
 * 草稿模板族：适配器用 draftKind 指定，引擎据此选生成器。
 *
 * v0.14.0 全渠道口径：**不向买家索要订单号**（会话里已经有这一单）；损坏 / 补件一律
 * 「直接要照片 + 承诺免费补发配件（不是整包）」。这是模板族里唯一一处主动承诺 ——
 * refund / return / invoice 仍然只承接、不断言。
 */
const DRAFT_BUILDERS = Object.freeze({
  amazon: buildDraft,
  mail: buildMailDraft,
  // TikTok Shop 单独一个模板族：亚马逊那套的订单号正则与退货/发票入口文案
  // 都指向 Amazon 账户，直接复用会让运营照着一个不存在的路径去操作。
  tiktok: buildTikTokDraft,
  // Walmart 同理：订单号是 15 位（实机 200015455387691），退货/订单入口在 Walmart 账户里。
  // 而且这条线的退货/退款模板按「只承接、不断言」写 —— 面单与退款都不是客服一个人能定的。
  walmart: buildWalmartDraft,
  // SHEIN：订单号形态尚未校准，所以**一个订单号正则都不写**（只有会话行给了才用），
  // 退款/退货/发票同样只承接不断言。见 lib/reply-shein.js 文件头。
  shein: buildSheinDraft,
  // TEMU：同一口径（不写订单号正则、退款/退货/发票只承接不断言），另加一条 TEMU 特有的
  // 内部提醒：半托管「消费者咨询」要求 24 小时内响应，超时可能触发平台介入。
  temu: buildTemuDraft,
});

/** 带 HTTP 状态的领域错误。 */
export class PatrolError extends Error {
  /**
   * @param {string} message - 原因。
   * @param {number} [status] - HTTP 状态码。
   */
  constructor(message, status = 400) {
    super(message);
    this.name = 'PatrolError';
    this.status = status;
  }
}

/** 收敛巡逻参数。 */
export function normalizePatrolOptions(input = {}, defaults = PATROL_DEFAULTS) {
  const num = (value, fallback, min, max) => {
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  };
  const list = (value, limit) =>
    Array.isArray(value) ? value.map((item) => String(item).trim()).filter(Boolean).slice(0, limit) : [];
  /**
   * 「渠道 → 目标清单」的映射。
   *
   * 键是渠道 id，值是那一个渠道的目标 id 列表。**空数组是有意义的**：它表示
   * 「这个渠道不限定，全部都跑」。所以不能把空表压成「没有这一项」——
   * 那会让「只勾了亚马逊两家店」顺手把沃尔玛也砍成同一批 id。
   */
  const byChannel = (value, limit) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const out = {};
    let count = 0;
    for (const [key, ids] of Object.entries(value)) {
      const id = String(key).trim();
      if (!id || count >= 20) continue;
      out[id] = list(ids, limit);
      count += 1;
    }
    return out;
  };
  return {
    maxStores: num(input.maxStores, defaults.maxStores, 0, 500),
    maxPerStore: num(input.maxPerStore, defaults.maxPerStore, 1, 50),
    closeAfter: input.closeAfter === undefined ? defaults.closeAfter : Boolean(input.closeAfter),
    writeMailDrafts:
      input.writeMailDrafts === undefined ? Boolean(defaults.writeMailDrafts) : Boolean(input.writeMailDrafts),
    autoFillAmazon:
      input.autoFillAmazon === undefined ? Boolean(defaults.autoFillAmazon) : Boolean(input.autoFillAmazon),
    autoLogin: input.autoLogin === undefined ? Boolean(defaults.autoLogin) : Boolean(input.autoLogin),
    channels: list(input.channels ?? defaults.channels, 10),
    // 兼容旧前端字段名 storeIds。
    sourceIds: list(input.sourceIds ?? input.storeIds, 200),
    // 每个渠道各带一份自己的目标清单（定时巡检按平台各选店铺时用）。
    sourceIdsByChannel: byChannel(input.sourceIdsByChannel ?? defaults.sourceIdsByChannel, 200),
  };
}

/** 新建一个 run 状态对象。 */
function createRunState(options) {
  return {
    id: `p_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`,
    status: 'running',
    phase: 'listing',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    options,
    cancelRequested: false,
    channelErrors: {},
    progress: {
      channelsTotal: 0,
      sourcesTotal: 0,
      sourcesDone: 0,
      sourcesFailed: 0,
      conversationsSeen: 0,
      draftsCreated: 0,
      draftsUpdated: 0,
      // 人工动过的草稿：巡逻重新生成了，但按规则不覆盖正文。
      draftsPreserved: 0,
      // 巡逻时自动填入浏览器回复框的条数（只填不发送）。
      autoFilled: 0,
      // 因为**未登录**被跳过的目标数。与 sourcesFailed 分开：没登录不是失败，
      // 也不该混进「失败」里让人以为链路坏了。
      sourcesSkippedAuth: 0,
      // 巡逻过程中**自动登录成功**的目标数（只点登录按钮，不代填账号密码）。
      sourcesAutoLoggedIn: 0,
      ticketsLinked: 0,
      externalDrafts: 0,
      errors: 0,
    },
    sources: [],
    log: [],
    error: null,
  };
}

/**
 * 建一个**内存**登录态服务：每店一条，外加正在等人的那一次。
 *
 * 为什么刻意不落盘：登录态本来就会过期（cookie 被平台清掉、人在别处登出）。把它当配置
 * 存下来，就会出现「文件里写着已登录、店铺窗口其实停在登录页」—— 界面照常显示绿灯，
 * 人却要盯着一次失败的巡逻才知道。这里宁可重启后重新探测一次。
 *
 * 与巡逻的关系是**单向**的：巡逻只读登录态（把「正在等人登录」的店跳过），登录服务
 * 完全不碰巡逻。反过来（登录去改 run）会让两个服务互相持有，谁也不好测。
 * @param {{adapters?: Record<string, object>, logger?: object, now?: () => number}} [options] - 依赖。
 * @returns {object} 登录服务。
 */
export function createLoginService(options = {}) {
  const adapters = options.adapters ?? {};
  const logger = options.logger ?? { warn: () => {}, info: () => {} };
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  /** 内存登录态：storeId → { state, since, url, error, hint }。**永不落盘**。 */
  const states = {};
  /** 正在等人的那一次：storeId → { channel, promise, since }。 */
  const waiting = {};

  /** 覆盖一条登录态（登录态的**唯一**写入口，保证 since 与字段形状只有一份）。 */
  function record(storeId, patch) {
    const previous = states[storeId] ?? null;
    const entry = {
      state: String(patch.state ?? previous?.state ?? 'unknown'),
      // since 只在状态**真的变了**的时候更新：前台每 3 秒拉一次，每次都刷新时间戳的话
      // 「这家店等了多久」就永远是 0，等于没有这个字段。
      since: previous && previous.state === patch.state ? previous.since : new Date(now()).toISOString(),
      url: String(patch.url ?? ''),
      error: patch.error ? String(patch.error) : null,
      hint: String(patch.hint ?? ''),
      storeId,
      channel: patch.channel ?? previous?.channel ?? null,
      storeName: patch.storeName ?? previous?.storeName ?? null,
      checkedAt: new Date(now()).toISOString(),
    };
    states[storeId] = entry;
    return entry;
  }

  function clear(storeId) {
    delete states[storeId];
  }

  function get(storeId) {
    return states[storeId] ?? null;
  }

  /** 给前端轮询的全量快照。返回副本：调用方改不动内部状态。 */
  function snapshot() {
    return Object.fromEntries(Object.entries(states).map(([id, entry]) => [id, { ...entry }]));
  }

  /** 这家店现在是不是「正在等人登录」。 */
  function isWaiting(storeId) {
    return Boolean(waiting[storeId]);
  }

  /**
   * 后台等人在浏览器里把登录做完。
   *
   * **刻意不 await**：HTTP 路由要立刻返回 login_required，前端拿着这个状态去显示
   * 「请你本人完成登录」。等在请求里等于把连接挂 5 分钟，浏览器早超时了。
   * 而且同一家店同时只留一个等待：连点两次「登录」不该有两份轮询在打同一个页面。
   * @param {string} channelId - 渠道 id。
   * @param {object} store - 店铺。
   * @param {{timeoutMs?: number, intervalMs?: number}} [opts] - 透传给适配器。
   * @returns {Promise<object>} 等人结束后的那一条登录态（调用方可以不接）。
   */
  function watch(channelId, store, opts = {}) {
    const storeId = String(store?.storeId ?? '');
    const existing = waiting[storeId];
    if (existing) return existing.promise;
    const adapter = adapters[channelId];
    if (!adapter || typeof adapter.waitForLogin !== 'function') {
      return Promise.resolve(
        record(storeId, {
          state: 'failed',
          url: '',
          hint: '这个渠道没有登录这回事，不用等',
          error: '该渠道不支持登录',
          channel: channelId,
          storeName: store?.storeName ?? null,
        }),
      );
    }
    const promise = Promise.resolve()
      .then(() => adapter.waitForLogin(store, opts))
      .then((result) => {
        const state = String(result?.state ?? '');
        return record(storeId, {
          // 'timeout' 原样保留但**不算失败**：人只是还没登完，页面还摆在那儿，再点一次就行。
          state,
          url: result?.url ?? '',
          hint: result?.hint ?? '',
          error: null,
          channel: channelId,
          storeName: store?.storeName ?? null,
        });
      })
      .catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        logger.warn('等登录失败（' + storeId + '）：' + message);
        return record(storeId, {
          state: 'failed',
          url: '',
          hint: '等待登录的过程中出错了，请重新点一次「登录」',
          error: message,
          channel: channelId,
          storeName: store?.storeName ?? null,
        });
      })
      .finally(() => {
        delete waiting[storeId];
      });
    waiting[storeId] = { channel: channelId, promise, since: new Date(now()).toISOString() };
    return promise;
  }

  /**
   * 点「登录」：先把店铺开到登录页摆好，再决定要不要在后台等人。
   * @param {string} channelId - 渠道 id。
   * @param {object} store - 店铺。
   * @param {{timeoutMs?: number, intervalMs?: number}} [opts] - 透传给适配器。
   * @returns {Promise<object>} 一次「登录」动作的结果。
   */
  async function open(channelId, store, opts = {}) {
    const storeId = String(store?.storeId ?? '');
    const adapter = adapters[channelId];
    if (!adapter) throw new PatrolError('未注册的渠道：' + channelId, 400);
    if (typeof adapter.openLogin !== 'function') {
      throw new PatrolError('「' + (adapter.label ?? channelId) + '」渠道没有登录这一步，不需要登录', 400);
    }
    const opened = await adapter.openLogin(store);
    const state = String(opened?.state ?? '');
    record(storeId, {
      state,
      url: opened?.url ?? '',
      hint: opened?.hint ?? '',
      error: opened?.error ?? null,
      channel: channelId,
      storeName: store?.storeName ?? null,
    });
    // 只有「确实停在登录页」才需要等人。failed 时页面可能压根没打开，等 5 分钟是白等；
    // logged_in 时人已经登好了，没什么可等。
    const waitingNow = state === 'login_required';
    if (waitingNow) watch(channelId, store, opts);
    return {
      storeId,
      storeName: store?.storeName ?? null,
      channel: channelId,
      state,
      url: opened?.url ?? '',
      title: opened?.title ?? '',
      hint: opened?.hint ?? '',
      error: opened?.error ?? null,
      // 可选：适配器把登录页摆好之后顺手做的「切 tab」结果（目前只有 TEMU 会用）。
      // 适配器不返回时就是 null —— 前端据此决定要不要说「已切到手机号登录」。
      phoneLoginTab: opened?.phoneLoginTab ?? null,
      waiting: waitingNow,
    };
  }

  return {
    open,
    watch,
    get,
    has: (storeId) => Object.prototype.hasOwnProperty.call(states, storeId),
    clear,
    snapshot,
    isWaiting,
    /** 只读视图（排障用）。 */
    get states() {
      return states;
    },
  };
}

/**
 * 建一个巡逻服务。
 *
 * `loginState` 是**可选**依赖：没给的时候引擎自己建一个空的登录服务。这样单独建巡逻
 * 服务（测试、脚本）的调用方不用为了跑一次巡逻去凑一个对象出来 —— 同时「正在等登录」
 * 的店仍然会被跳过，沿用同一套判定。
 * @param {{adapters: Record<string, object>, drafts: object, queue: object, audit?: object, settings: object, logger?: object, clock?: () => Date, stateFile?: string, loginState?: object}} options - 依赖。
 * @returns {object} 服务。
 */
export function createPatrolService(options) {
  const adapters = options.adapters ?? {};
  const drafts = options.drafts;
  const queue = options.queue;
  const audit = options.audit ?? null;
  const logger = options.logger ?? { warn: () => {}, info: () => {} };
  const clock = options.clock ?? (() => new Date());
  const stateFile = options.stateFile ? path.resolve(options.stateFile) : null;
  // 登录态由宿主注入；单独建巡逻服务时给一个空的，行为仍然成立（没人登录过 = 不拦）。
  const loginState = options.loginState ?? createLoginService({ adapters, logger });

  /** 当前（或最近一次）run。 */
  let active = null;

  /** 记一条日志（内存里保留最近 200 条）。 */
  function log(run, level, message, extra = {}) {
    const entry = { at: new Date().toISOString(), level, message, ...extra };
    run.log.push(entry);
    if (run.log.length > 200) run.log.splice(0, run.log.length - 200);
    if (level === 'error') logger.warn(`[patrol ${run.id}] ${message}`);
  }

  /** 落盘最近一次 run 的摘要（不含草稿正文）。 */
  function persist(run) {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const summary = {
        id: run.id,
        status: run.status,
        phase: run.phase,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        options: run.options,
        progress: run.progress,
        sources: run.sources.map((source) => ({
          channel: source.channel,
          storeId: source.storeId,
          storeName: source.storeName,
          platformName: source.platformName,
          status: source.status,
          conversations: source.conversations,
          drafts: source.drafts,
          error: source.error,
          durationMs: source.durationMs,
          // 跳过/说明也要落盘：重启之后回查「那天为什么没扫这家店」，
          // 只剩一个 status:'skipped' 是查不出所以然的。
          ...(source.reason ? { reason: source.reason } : {}),
          ...(source.note ? { note: source.note } : {}),
        })),
        error: run.error,
      };
      const tmp = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
      fs.renameSync(tmp, stateFile);
    } catch (cause) {
      logger.warn(`巡逻状态落盘失败：${cause instanceof Error ? cause.message : cause}`);
    }
  }

  /** 取一份可安全序列化的快照。 */
  function snapshot() {
    if (!active) return { running: false, run: null };
    return { running: active.status === 'running', run: active };
  }

  /* ── 巡逻前登录预检 ─────────────────────────────────────────────────────
   * 「这个渠道有没有登录这回事」由能力探测决定（有没有 checkLogin 方法），**不写死
   * 平台 id**。飞书邮箱渠道是纯 API，压根没有登录概念；在这里按平台名分支，早晚会在
   * 加渠道时漏掉一个，而漏掉的表现是「整条巡逻炸掉」——用户完全看不懂。
   *
   * 三条不许含糊的规则：
   *   1. 只把明确读到登录页（login_required 且没读失败）判成「未登录」。地址读不出来
   *      （failed）时**放行**：那是店铺窗口没打开 / CLI 这一跳失败，让巡逻照常去跑，
   *      由它自己把真实原因报出来（通常是「消息中心没加载出来」）。凭一次读不到地址
   *      就把整家店静默跳过，会变成最难查的那种「什么都没发生」。
   *   2. 探测本身抛错绝不能连累巡逻：读不到就当没预检过，继续跑。
   *   3. 跳过要说出来源：结果里带 status:'skipped' + reason，并单独计数。
   * ─────────────────────────────────────────────────────────────────────────── */

  /** 未登录时给运营看的那句话。界面上的「登录」按钮就在旁边，文案要能直接对上。 */
  const AUTH_SKIP_REASON = '未登录，请先点「登录」';

  /** 该渠道是否有「登录」这回事。没有 checkLogin 的渠道一律跳过预检。 */
  function hasLoginConcept(adapter) {
    return typeof adapter?.checkLogin === 'function';
  }

  /**
   * 巡逻前问一句「这家店登录了吗」。
   * @param {object} adapter - 渠道适配器。
   * @param {object} source - 目标。
   * @returns {Promise<{state: string, url: string, hint: string, error: string|null}|null>} 登录态；渠道没有登录概念或探测抛错时返回 null（= 不拦）。
   */
  async function probeLogin(adapter, source) {
    if (!hasLoginConcept(adapter)) return null;
    try {
      const probe = await adapter.checkLogin(source);
      if (!probe || typeof probe !== 'object') return null;
      return {
        state: String(probe.state ?? ''),
        url: String(probe.url ?? ''),
        hint: String(probe.hint ?? ''),
        loggedIn: probe.loggedIn === true,
        error: null,
      };
    } catch (cause) {
      // 探测失败 ≠ 未登录：不拦，让巡逻自己去跑并把真实原因写进结果里。
      return null;
    }
  }

  /**
   * 巡逻一个目标（一家店铺 / 一个邮箱）。
   * @param {object} run - run 状态。
   * @param {object} adapter - 渠道适配器。
   * @param {object} source - 目标。
   * @returns {Promise<void>} 完成。
   */
  async function patrolSource(run, adapter, source) {
    const started = Date.now();
    const result = {
      channel: adapter.id,
      channelLabel: adapter.label,
      storeId: source.storeId,
      storeName: source.storeName,
      platformName: source.platformName,
      status: 'running',
      phase: 'opening',
      conversations: 0,
      drafts: 0,
      error: null,
      errorKind: null,
      durationMs: 0,
      items: [],
    };
    run.sources.push(result);
    run.phase = 'opening';
    log(run, 'info', `[${adapter.label}] 开始巡逻 ${source.storeName}`, { storeId: source.storeId });

    try {
      // ── 登录预检（只有认「登录」这回事的渠道才做） ──
      // 「正在等人登录」是**已知**的未登录，不用再去探测一次（探测要打一次页面）。
      const waiting = hasLoginConcept(adapter) && loginState.isWaiting?.(source.storeId) === true;
      const login = waiting ? { state: 'login_required', url: '', hint: '' } : await probeLogin(adapter, source);
      result.auth = login ? { state: login.state, url: login.url } : null;
      // ── 未登录：先看这个渠道能不能自己登录（沃尔玛可以，TikTok 不行） ──
      // 能力探测，不写平台 id：适配器导出 supportsAutoLogin + autoLogin 才算数。
      const canAutoLogin =
        Boolean(login) &&
        login.state === 'login_required' &&
        run.options.autoLogin !== false &&
        adapter.supportsAutoLogin === true &&
        typeof adapter.autoLogin === 'function';
      if (canAutoLogin) {
        result.auth.autoLogin = { attempted: true, ok: false, attempts: 0, hint: '' };
        try {
          // 自动登录只点「登录 / 继续」两下，背后是紫鸟已填好的账号密码与验证码服务。
          const auto = await adapter.autoLogin(source, { url: login.url });
          result.auth.autoLogin = {
            attempted: true,
            ok: auto?.ok === true,
            attempts: Number(auto?.attempts ?? 0),
            url: auto?.url ?? '',
            hint: auto?.hint ?? '',
          };
          if (auto?.ok) {
            // 只有**再探一次地址**确认真的进了卖家中心，才算自动登录成功 ——
            // 点了按钮不等于登录成功，这一点在结果里不许含糊。
            const again = await probeLogin(adapter, source);
            if (again?.loggedIn) {
              login.state = again.state;
              run.progress.sourcesAutoLoggedIn += 1;
              log(run, 'info', `[${adapter.label}] ${source.storeName}：自动登录成功（只点「登录 / 继续」，未代填账号密码）`, {
                storeId: source.storeId,
              });
            } else {
              result.auth.autoLogin.ok = false;
              result.auth.autoLogin.hint = '点了登录按钮，但地址仍停在登录页';
            }
          }
        } catch (cause) {
          // 自动登录本身出错绝不能连累巡逻：降级成「未登录跳过」，把原因带出来。
          result.auth.autoLogin = {
            attempted: true,
            ok: false,
            attempts: 0,
            hint: cause instanceof Error ? cause.message : String(cause),
          };
          log(run, 'info', `[${adapter.label}] ${source.storeName}：自动登录未成功（${result.auth.autoLogin.hint}）`, {
            storeId: source.storeId,
          });
        }
      }
      if (login && login.state === 'login_required') {
        // 未登录（或自动登录没成）：跳过这家店。**不是失败** —— 没有登录就什么也读不到，
        // 硬跑只会留下一条含糊的「收件箱没加载出来」，让人以为是链路坏了。
        result.status = 'skipped';
        result.reason = AUTH_SKIP_REASON;
        result.errorKind = 'auth';
        const autoHint = result.auth?.autoLogin?.hint ?? '';
        result.note = autoHint || login.hint || AUTH_SKIP_REASON;
        run.progress.sourcesSkippedAuth += 1;
        log(run, 'info', `[${adapter.label}] ${source.storeName}：${AUTH_SKIP_REASON}${autoHint ? '（自动登录未成功）' : ''}`, {
          storeId: source.storeId,
        });
        return;
      }

      await adapter.prepare(source);

      result.phase = 'reading';
      run.phase = 'reading';
      const list = await adapter.listConversations(source, { max: run.options.maxPerStore });
      const items = Array.isArray(list.items) ? list.items : [];
      result.conversations = items.length;
      // 被跳过的（自动通知 / 系统群发）单独计数：不静默丢掉，界面上要看得到。
      result.skipped = Array.isArray(list.skipped) ? list.skipped.length : 0;
      result.skipSamples = (list.skipped ?? []).slice(0, 5);
      run.progress.conversationsSeen += items.length;
      log(run, 'info', `[${adapter.label}] ${source.storeName}：待回复 ${items.length} 条`, {
        storeId: source.storeId,
      });

      const targets = items.slice(0, run.options.maxPerStore);
      result.phase = 'drafting';
      run.phase = 'drafting';

      for (const target of targets) {
        if (run.cancelRequested) break;
        const entry = {
          buyer: target.buyer ?? '',
          subject: target.subject ?? '',
          orderId: target.orderId ?? '',
          dueText: target.due ?? '',
          intent: null,
          intentLabel: null,
          draftId: null,
          ticketId: null,
          needsHuman: false,
          externalDraftId: null,
          autoFilled: false,
          error: null,
        };
        try {
          const thread = await adapter.readConversation(source, target);
          const builder = DRAFT_BUILDERS[adapter.draftKind] ?? buildDraft;
          const built = builder({
            // 两个模板族共用一组入参，各自忽略用不上的字段。
            buyer: target.buyer || thread.buyer || '',
            subject: target.subject || thread.subject || '',
            orderId: target.orderId || '',
            inbound: String(thread.lastInbound?.body ?? ''),
            storeName: source.storeName,
            country: target.country ?? '',
            fromName: thread.buyer || target.buyer || '',
            fromAddress: thread.buyerAddress || '',
            mailboxName: source.storeName,
            security: thread.security ?? null,
            warnings: thread.warnings ?? [],
          });

          const caseId = String(adapter.conversationId?.(thread) ?? '') || String(target.caseId ?? '');
          const saved = drafts.upsert({
            platform: adapter.id,
            storeId: source.storeId,
            storeName: source.storeName,
            caseId,
            buyer: target.buyer || thread.buyer || '',
            buyerAddress: thread.buyerAddress || '',
            country: target.country ?? '',
            subject: target.subject || thread.subject || '',
            dueText: target.due ?? thread.due ?? '',
            dueMinutes: Number.isFinite(target.dueMinutes) ? target.dueMinutes : null,
            orderId: built.orderId,
            intent: built.intent,
            intentLabel: built.intentLabel,
            intentSource: built.intentSource,
            language: built.language,
            needsHuman: built.needsHuman,
            notes: built.notes,
            body: built.body,
            runId: run.id,
            source: { url: thread.url ?? '', inboxUrl: adapter.inboxUrl ?? '' },
          });

          entry.intent = built.intent;
          entry.intentLabel = built.intentLabel;
          entry.draftId = saved.item.id;
          entry.needsHuman = built.needsHuman;
          result.drafts += 1;
          if (saved.created) run.progress.draftsCreated += 1;
          else if (saved.preserved) run.progress.draftsPreserved += 1;
          else run.progress.draftsUpdated += 1;

          // 可选：把草稿同时写进飞书草稿箱（仍然是「存草稿」，不是发送）。
          if (run.options.writeMailDrafts && typeof adapter.createExternalDraft === 'function') {
            try {
              const external = await adapter.createExternalDraft(source, { item: target, thread, body: built.body });
              entry.externalDraftId = external?.draftId ?? null;
              if (entry.externalDraftId) {
                drafts.patch(saved.item.id, { note: `已写入飞书草稿箱（draft_id ${entry.externalDraftId}）` });
                run.progress.externalDrafts += 1;
              }
            } catch (cause) {
              log(run, 'error', `[${adapter.label}] 写飞书草稿失败：${cause.message}`, { storeId: source.storeId });
            }
          }

          // 同步进工单队列：草稿库管内容，队列管流转，两边互指。
          try {
            const ticket = queue.create({
              channel: adapter.queueChannel ?? adapter.id,
              kind: 'message',
              subject: (target.subject || thread.subject || '待回复消息').slice(0, 200),
              from: target.buyer || thread.buyer || '',
              snippet: summarizeThread(thread),
              source: { storeId: source.storeId, url: thread.url ?? '', messageId: caseId, threadId: caseId },
              idempotencyKey: saved.item.dedupeKey,
              note: `巡逻 ${run.id} 生成草稿 ${saved.item.id}`,
            });
            const ticketChanges = { draftId: saved.item.id, snippet: summarizeThread(thread) };
            if (!ticket.deduped) ticketChanges.status = 'drafted';
            queue.patch(ticket.item.id, ticketChanges);
            drafts.patch(saved.item.id, { ticketId: ticket.item.id });
            entry.ticketId = ticket.item.id;
            run.progress.ticketsLinked += 1;
          } catch (cause) {
            log(run, 'error', `[${adapter.label}] ${source.storeName} / ${entry.buyer}：入队失败 ${cause.message}`, {
              storeId: source.storeId,
            });
          }

          // 把刚生成的草稿直接填进**已经打开**的亚马逊回复框（只填不发送）—— 默认行为。
          // 放在最后做：即使填失败，草稿也已经落库，不会白跑一趟。
          if (run.options.autoFillAmazon && typeof adapter.fillOpenConversation === 'function') {
            try {
              // 填**草稿库里的最终正文**，而不是刚生成的这份：人工改过的草稿正文受保护，
              // 若这里用 built.body，就会出现「库里是新版、浏览器里填的是旧版」。
              await adapter.fillOpenConversation(source, saved.item.body);
              entry.autoFilled = true;
              // 标成 filled 会同时让这条草稿进入「人工动过」的保护名单 —— 正文正躺在
              // 真实浏览器的输入框里，下次巡逻再去覆盖它只会让两边对不上。
              drafts.patch(saved.item.id, { status: 'filled', note: '巡逻时自动填入回复框（未发送）' });
              run.progress.autoFilled += 1;
            } catch (cause) {
              log(run, 'error', `[${adapter.label}] 自动填入回复框失败：${cause.message}`, {
                storeId: source.storeId,
              });
            }
          }

          result.items.push(entry);
        } catch (cause) {
          entry.error = cause instanceof Error ? cause.message : String(cause);
          result.items.push(entry);
          run.progress.errors += 1;
          log(run, 'error', `[${adapter.label}] ${entry.buyer || '未知对象'}：${entry.error}`, {
            storeId: source.storeId,
          });
        }
      }

      result.status = 'ok';
      result.phase = 'done';
      // 「已登录但没有待处理会话」要能分辨。
      //
      // 实测（2026-10-10）店2 Tiktok-FUSOU-客服KX 登录完全成功，收件箱却是 0 条 ——
      // 只有 16 条已关闭的历史。这种情况下 run 里如果只有一个光秃秃的 conversations:0，
      // 看起来和「漏扫了 / 链路坏了」一模一样，运营会去反复重跑、甚至去修一个没坏的东西。
      // 所以这里补一句可读说明，把「没登录」「扫不到」和「真的没有待处理」分开。
      if (items.length === 0) {
        result.note = result.skipped > 0
          ? `已登录，收件箱里 ${result.skipped} 条都是自动通知/系统群发，没有需要回复的会话`
          : '已登录，暂无待处理会话';
      }
    } catch (cause) {
      result.status = 'failed';
      result.error = cause instanceof Error ? cause.message : String(cause);
      result.errorKind = cause?.kind ?? 'error';
      if (cause?.hint) result.errorHint = cause.hint;
      run.progress.errors += 1;
      run.progress.sourcesFailed += 1;
      log(run, 'error', `[${adapter.label}] ${source.storeName}：${result.error}`, { storeId: source.storeId });
    } finally {
      result.durationMs = Date.now() - started;
      // 被跳过的目标是「办完了」，不是「失败了」—— 进度条得往前走，否则界面永远停在
      // 一半，看起来像卡死。
      result.phase = result.status === 'failed' ? 'failed' : 'done';
      run.progress.sourcesDone += 1;
      // 没登录的店连窗口都没打开过，关它只会在紫鸟里报一次无意义的失败。
      if (
        result.status !== 'skipped' &&
        run.options.closeAfter &&
        typeof adapter.closeSource === 'function'
      ) {
        await adapter.closeSource(source);
      }
      if (audit) {
        audit.append({
          kind: 'patrol',
          name: source.storeName,
          ok: result.status === 'ok' || result.status === 'skipped',
          durationMs: result.durationMs,
          errorKind: result.errorKind,
          detail: {
            runId: run.id,
            channel: adapter.id,
            storeId: source.storeId,
            conversations: result.conversations,
            drafts: result.drafts,
            // 跳过原因也进审计：事后回查「那天为什么没扫这家店」要有据可依。
            ...(result.status === 'skipped' ? { status: 'skipped', reason: result.reason } : {}),
          },
        });
      }
    }
  }

  /**
   * 解析这次要跑哪些渠道。
   *
   * 关掉的渠道直接跳过 —— 这不是失败，是「没开」。飞书邮箱默认关闭，必须先手动接好
   * 飞书CLI 再在设置里打开；没打开时不该在巡逻结果里留下一条 error。
   * @param {object} run - run 状态。
   * @returns {Array<object>} 要跑的适配器。
   */
  function resolveChannels(run) {
    const wanted = run.options.channels;
    const ids = wanted.length > 0 ? wanted : Object.keys(adapters);
    return ids
      .map((id) => adapters[id])
      .filter(Boolean)
      .filter((adapter) => (typeof adapter.enabled === 'function' ? adapter.enabled() : true));
  }

  /**
   * 执行一次巡逻（内部）。
   * @param {object} run - run 状态。
   * @returns {Promise<void>} 完成。
   */
  async function execute(run) {
    try {
      const channels = resolveChannels(run);
      run.progress.channelsTotal = channels.length;
      if (channels.length === 0) {
        // 逐个说清「谁没启用、为什么」：停用的渠道不止一个（飞书邮箱默认关闭，
        // SHEIN 是登记了但巡逻面没接入），只报其中一个会把人指到错的方向去。
        const registered = Object.values(adapters);
        const reasons =
          registered.length === 0
            ? '一个渠道都没注册'
            : registered
                .map(
                  (adapter) =>
                    `${adapter.label}：${
                      typeof adapter.disabledHint === 'function'
                        ? adapter.disabledHint()
                        : adapter.disabledHint ?? '未启用'
                    }`,
                )
                .join('；');
        throw new PatrolError(`没有已启用的渠道：${reasons}`, 500);
      }
      log(run, 'info', `本次巡逻渠道：${channels.map((adapter) => adapter.label).join('、')}`);

      for (const adapter of channels) {
        if (run.cancelRequested) break;
        run.phase = 'listing';
        log(run, 'info', `[${adapter.label}] 拉取目标列表`);
        let sources;
        try {
          sources = await adapter.listSources();
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          run.progress.errors += 1;
          run.channelErrors[adapter.id] = { message, hint: cause?.hint ?? null, kind: cause?.kind ?? 'error' };
          log(run, 'error', `[${adapter.label}] 取列表失败：${message}`);
          continue;
        }
        // 目标清单分两级：**这个渠道自己那份优先**，没有才退回全局那份。
        // 「这个渠道有自己那份」是按 hasOwnProperty 判的，因为**空数组也是有含义的**
        // （= 这个渠道全部都要）—— 用 length 判会让「亚马逊只巡两家」把沃尔玛也砍掉。
        const byChannel = run.options.sourceIdsByChannel ?? {};
        const scoped = Object.prototype.hasOwnProperty.call(byChannel, adapter.id)
          ? byChannel[adapter.id]
          : run.options.sourceIds;
        if (scoped.length > 0) {
          // 大小写不敏感：邮箱地址实际是小写（support@fusou.vip），而人写的是 support@Fosou.VIP。
          const wanted = new Set(scoped.map((id) => id.toLowerCase()));
          sources = sources.filter(
            (source) =>
              wanted.has(String(source.storeId).toLowerCase()) ||
              wanted.has(String(source.storeName).toLowerCase()),
          );
        }
        if (run.options.maxStores > 0) sources = sources.slice(0, run.options.maxStores);
        run.progress.sourcesTotal += sources.length;
        log(run, 'info', `[${adapter.label}] ${sources.length} 个目标待巡逻`);

        for (const source of sources) {
          if (run.cancelRequested) break;
          await patrolSource(run, adapter, source);
        }
      }

      run.status = run.cancelRequested ? 'cancelled' : 'done';
      run.phase = run.status;
    } catch (cause) {
      run.status = 'failed';
      run.phase = 'failed';
      run.error = cause instanceof Error ? cause.message : String(cause);
      log(run, 'error', `巡逻中断：${run.error}`);
    } finally {
      run.finishedAt = new Date().toISOString();
      persist(run);
      if (audit) {
        audit.append({
          kind: 'patrol',
          name: 'run',
          ok: run.status === 'done',
          detail: {
            runId: run.id,
            status: run.status,
            channels: run.progress.channelsTotal,
            sources: run.progress.sourcesTotal,
            // 键名与 progress 字段一致：同一个数在两处叫两个名字，回查时对不上。
            sourcesSkippedAuth: run.progress.sourcesSkippedAuth,
            sourcesAutoLoggedIn: run.progress.sourcesAutoLoggedIn,
            drafts: run.progress.draftsCreated,
            errors: run.progress.errors,
            maxPerStore: run.options.maxPerStore,
          },
        });
      }
      logger.info(
        `巡逻 ${run.id} 结束：${run.status}，${run.progress.sourcesDone}/${run.progress.sourcesTotal} 个目标` +
          `（自动登录 ${run.progress.sourcesAutoLoggedIn} 个，未登录跳过 ${run.progress.sourcesSkippedAuth} 个），新草稿 ${run.progress.draftsCreated} 条`,
      );
    }
  }

  return {
    /**
     * 启动一次巡逻（立即返回，后台继续跑）。
     * @param {object} [input] - 参数。
     * @returns {object} run 快照。
     */
    start(input = {}) {
      if (active && active.status === 'running') {
        throw new PatrolError(`已经有一次巡逻在跑（${active.id}），等它结束或先停止`, 409);
      }
      const defaults = { ...PATROL_DEFAULTS, ...(options.settings?.patrol ?? {}) };
      const run = createRunState(normalizePatrolOptions(input, defaults));
      active = run;
      // 刻意不 await：HTTP 路由要立刻返回 run id，前端靠轮询看进展。
      Promise.resolve()
        .then(() => execute(run))
        .catch((cause) => {
          run.status = 'failed';
          run.error = cause instanceof Error ? cause.message : String(cause);
          logger.warn(`巡逻异常：${run.error}`);
        });
      return run;
    },
    /**
     * 请求停止当前巡逻。
     * @returns {{stopped: boolean, id: string|null}} 结果。
     */
    stop() {
      if (!active || active.status !== 'running') return { stopped: false, id: active?.id ?? null };
      active.cancelRequested = true;
      log(active, 'info', '收到停止请求，跑完当前这个目标就收工');
      return { stopped: true, id: active.id };
    },
    /** 当前/最近一次的快照。 */
    snapshot,
    /** 只读的 run 对象。 */
    get active() {
      return active;
    },
  };
}
