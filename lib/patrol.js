/**
 * 巡逻引擎：一键把**多个渠道**的待回复消息过一遍，逐条生成草稿。
 *
 * 当前接了两个渠道（都由适配器提供，引擎自己不认识任何平台）：
 *   - `amazon`    依次打开每家亚马逊店铺，读「需要回复」的买家消息；
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

/** 巡逻的默认参数（settings.patrol 可以覆盖）。 */
export const PATROL_DEFAULTS = Object.freeze({
  /** 最多扫几个目标（店铺 / 邮箱）；0 = 全部。 */
  maxStores: 0,
  /** 每个目标最多生成几条草稿。 */
  maxPerStore: 3,
  /** 紫鸟浏览器是否无头（只对亚马逊渠道有意义）。 */
  headless: false,
  /** 跑完是否关掉店铺浏览器。 */
  closeAfter: false,
  /** 要巡逻的渠道 id；空数组 = 全部已注册渠道。 */
  channels: [],
  /** 是否顺带把邮件草稿写进飞书草稿箱（仍然只存草稿，不发送）。 */
  writeMailDrafts: false,
  /**
   * 是否在巡逻时把草稿**自动填入**已经打开的亚马逊回复框。
   *
   * 仍然只填不发送；但要知道代价：跑一遍 8 家店会在浏览器里留下十几到几十个
   * 未发送的输入框（每换一家店，上一家的编辑器还开着）。
   */
  autoFillAmazon: true,
});

/** 草稿模板族：适配器用 draftKind 指定，引擎据此选生成器。 */
const DRAFT_BUILDERS = Object.freeze({
  amazon: buildDraft,
  mail: buildMailDraft,
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
  return {
    maxStores: num(input.maxStores, defaults.maxStores, 0, 500),
    maxPerStore: num(input.maxPerStore, defaults.maxPerStore, 1, 50),
    headless: input.headless === undefined ? defaults.headless : Boolean(input.headless),
    closeAfter: input.closeAfter === undefined ? defaults.closeAfter : Boolean(input.closeAfter),
    writeMailDrafts:
      input.writeMailDrafts === undefined ? Boolean(defaults.writeMailDrafts) : Boolean(input.writeMailDrafts),
    autoFillAmazon:
      input.autoFillAmazon === undefined ? Boolean(defaults.autoFillAmazon) : Boolean(input.autoFillAmazon),
    channels: list(input.channels ?? defaults.channels, 10),
    // 兼容旧前端字段名 storeIds。
    sourceIds: list(input.sourceIds ?? input.storeIds, 200),
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
 * 建一个巡逻服务。
 * @param {{adapters: Record<string, object>, drafts: object, queue: object, audit?: object, settings: object, logger?: object, clock?: () => Date, stateFile?: string}} options - 依赖。
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

          // 可选：把刚生成的草稿直接填进**已经打开**的亚马逊回复框（只填不发送）。
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
      result.phase = result.status === 'failed' ? 'failed' : 'done';
      run.progress.sourcesDone += 1;
      if (run.options.closeAfter && typeof adapter.closeSource === 'function') {
        await adapter.closeSource(source);
      }
      if (audit) {
        audit.append({
          kind: 'patrol',
          name: source.storeName,
          ok: result.status === 'ok',
          durationMs: result.durationMs,
          errorKind: result.errorKind,
          detail: {
            runId: run.id,
            channel: adapter.id,
            storeId: source.storeId,
            conversations: result.conversations,
            drafts: result.drafts,
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
        throw new PatrolError(
          '没有已启用的渠道：飞书邮箱默认关闭，需要先在「设置」里接好飞书CLI 再手动打开',
          500,
        );
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
        if (run.options.sourceIds.length > 0) {
          // 大小写不敏感：邮箱地址实际是小写（support@fusou.vip），而人写的是 support@Fosou.VIP。
          const wanted = new Set(run.options.sourceIds.map((id) => id.toLowerCase()));
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
            drafts: run.progress.draftsCreated,
            errors: run.progress.errors,
            maxPerStore: run.options.maxPerStore,
          },
        });
      }
      logger.info(
        `巡逻 ${run.id} 结束：${run.status}，${run.progress.sourcesDone}/${run.progress.sourcesTotal} 个目标，新草稿 ${run.progress.draftsCreated} 条`,
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
