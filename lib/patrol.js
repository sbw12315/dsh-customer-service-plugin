/**
 * 巡逻引擎：一键把账号下**所有亚马逊店铺**的买家消息收件箱过一遍，生成草稿。
 *
 * 设计要点（每一条都对应一个真实会踩的坑）：
 *
 *   1. **串行**跑店铺，不并发。紫鸟是本地浏览器内核，同时开多个店铺会互相抢焦点/端口，
 *      「点错店铺」这种事故排查起来极贵。慢一点无所谓，巡逻是后台任务。
 *   2. **一家店失败不影响其它店**。超时、未登录、页面改版都只记在这家店的结果里，
 *      走到下一家继续。巡航的价值在于「不漏店」，不在于「一次全成功」。
 *   3. **永远只生成草稿**。引擎里没有任何发送路径；写进亚马逊回复框是人工点单条
 *      草稿才触发的动作（走 /drafts/:id/fill），而且填完就停。
 *   4. **状态在内存里、进展可轮询**。一个 run 对象暴露 phase / progress / 每店明细，
 *      控制台每 3 秒拉一次就能画出进度条，不需要长连接。
 *
 * @module dsh-customer-service-plugin/lib/patrol
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { buildDraft, summarizeThread } from './reply.js';
import { caseIdFromUrl, parseDueText } from './platforms/amazon.js';

/** 巡逻的默认参数（settings.patrol 可以覆盖）。 */
export const PATROL_DEFAULTS = Object.freeze({
  /** 最多扫几家店；0 = 全部。 */
  maxStores: 0,
  /** 每家店最多生成几条草稿。 */
  maxPerStore: 3,
  /** 紫鸟浏览器是否无头。 */
  headless: false,
  /** 跑完是否关掉店铺浏览器。 */
  closeAfter: false,
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
  const storeIds = Array.isArray(input.storeIds)
    ? input.storeIds.map((id) => String(id).trim()).filter(Boolean).slice(0, 200)
    : [];
  return {
    maxStores: num(input.maxStores, defaults.maxStores, 0, 500),
    maxPerStore: num(input.maxPerStore, defaults.maxPerStore, 1, 50),
    headless: input.headless === undefined ? defaults.headless : Boolean(input.headless),
    closeAfter: input.closeAfter === undefined ? defaults.closeAfter : Boolean(input.closeAfter),
    storeIds,
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
    progress: {
      storesTotal: 0,
      storesDone: 0,
      storesFailed: 0,
      conversationsSeen: 0,
      draftsCreated: 0,
      draftsUpdated: 0,
      ticketsLinked: 0,
      errors: 0,
    },
    stores: [],
    log: [],
    error: null,
  };
}

/**
 * 建一个巡逻服务。
 * @param {{adapter: object, drafts: object, queue: object, audit?: object, settings: object, logger?: object, clock?: () => Date, stateFile?: string}} options - 依赖。
 * @returns {object} 服务。
 */
export function createPatrolService(options) {
  const adapter = options.adapter;
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
        stores: run.stores.map((store) => ({
          storeId: store.storeId,
          storeName: store.storeName,
          platformName: store.platformName,
          status: store.status,
          conversations: store.conversations,
          drafts: store.drafts,
          error: store.error,
          durationMs: store.durationMs,
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
   * 跑一家店。
   * @param {object} run - run 状态。
   * @param {object} store - 店铺。
   * @returns {Promise<void>} 完成。
   */
  async function patrolStore(run, store) {
    const started = Date.now();
    const result = {
      storeId: store.storeId,
      storeName: store.storeName,
      platformName: store.platformName,
      status: 'running',
      phase: 'opening',
      conversations: 0,
      drafts: 0,
      error: null,
      errorKind: null,
      durationMs: 0,
      items: [],
    };
    run.stores.push(result);
    run.phase = 'opening';
    log(run, 'info', `打开店铺 ${store.storeName}`, { storeId: store.storeId });

    try {
      await adapter.openStore(store);
      result.phase = 'navigating';
      run.phase = 'navigating';
      await adapter.visitInbox(store);
      const ready = await adapter.waitForInbox(store);
      if (!ready) {
        throw Object.assign(new Error('收件箱没有加载出来（通常是该店铺未登录）'), { kind: 'page' });
      }

      result.phase = 'reading';
      run.phase = 'reading';
      const list = await adapter.extractList(store);
      const items = Array.isArray(list.items) ? list.items : [];
      result.conversations = items.length;
      run.progress.conversationsSeen += items.length;
      log(run, 'info', `${store.storeName}：需要回复 ${items.length} 条`, { storeId: store.storeId });

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
          error: null,
        };
        try {
          await adapter.openConversation(store, target.index);
          const thread = await adapter.extractThread(store);
          const inbound = String(thread.lastInbound?.body ?? '');
          const due = parseDueText(target.due ?? thread.due ?? '');
          const built = buildDraft({
            buyer: target.buyer || thread.buyer || '',
            subject: target.subject || thread.topic || '',
            orderId: target.orderId || '',
            inbound,
            storeName: store.storeName,
            country: target.country ?? '',
          });

          const caseId = caseIdFromUrl(thread.url) || caseIdFromUrl(list.url);
          const saved = drafts.upsert({
            platform: adapter.id,
            storeId: store.storeId,
            storeName: store.storeName,
            caseId,
            buyer: target.buyer || thread.buyer || '',
            country: target.country ?? '',
            subject: target.subject || thread.topic || '',
            dueText: target.due ?? thread.due ?? '',
            dueMinutes: due && Number.isFinite(due.minutes) ? due.minutes : null,
            orderId: built.orderId,
            intent: built.intent,
            intentLabel: built.intentLabel,
            intentSource: built.intentSource,
            language: built.language,
            needsHuman: built.needsHuman,
            notes: built.notes,
            body: built.body,
            runId: run.id,
            source: { url: thread.url, inboxUrl: adapter.inboxUrl },
          });

          entry.intent = built.intent;
          entry.intentLabel = built.intentLabel;
          entry.draftId = saved.item.id;
          entry.needsHuman = built.needsHuman;
          result.drafts += 1;
          if (saved.created) run.progress.draftsCreated += 1;
          else run.progress.draftsUpdated += 1;

          // 同步进工单队列：草稿库管内容，队列管流转，两边互指。
          try {
            const ticket = queue.create({
              channel: adapter.id,
              kind: 'message',
              subject: (target.subject || thread.topic || '亚马逊买家消息').slice(0, 200),
              from: target.buyer || thread.buyer || '',
              snippet: summarizeThread(thread),
              source: {
                storeId: store.storeId,
                url: thread.url,
                messageId: caseId,
                threadId: caseId,
              },
              idempotencyKey: saved.item.dedupeKey,
              note: `巡逻 ${run.id} 生成草稿 ${saved.item.id}`,
            });
            const ticketChanges = {
              draftId: saved.item.id,
              // 每次巡逻都刷新摘要：首轮有可能因为会话还没渲染完而读到空内容。
              snippet: summarizeThread(thread),
            };
            if (!ticket.deduped) ticketChanges.status = 'drafted';
            queue.patch(ticket.item.id, ticketChanges);
            drafts.patch(saved.item.id, { ticketId: ticket.item.id });
            entry.ticketId = ticket.item.id;
            run.progress.ticketsLinked += 1;
          } catch (cause) {
            // 工单只是流转载体：它失败不该让已经生成好的草稿丢掉。
            log(run, 'error', `${store.storeName} / ${entry.buyer}：入队失败 ${cause.message}`, { storeId: store.storeId });
          }

          result.items.push(entry);
        } catch (cause) {
          entry.error = cause instanceof Error ? cause.message : String(cause);
          result.items.push(entry);
          run.progress.errors += 1;
          log(run, 'error', `${store.storeName} / ${entry.buyer || '未知买家'}：${entry.error}`, { storeId: store.storeId });
        }
      }

      result.status = 'ok';
      result.phase = 'done';
    } catch (cause) {
      result.status = 'failed';
      result.error = cause instanceof Error ? cause.message : String(cause);
      result.errorKind = cause?.kind ?? 'error';
      run.progress.errors += 1;
      run.progress.storesFailed += 1;
      log(run, 'error', `${store.storeName}：${result.error}`, { storeId: store.storeId });
    } finally {
      result.durationMs = Date.now() - started;
      result.phase = result.status === 'failed' ? 'failed' : 'done';
      run.progress.storesDone += 1;
      if (run.options.closeAfter) {
        await adapter.closeStore(store);
      }
      if (audit) {
        audit.append({
          kind: 'patrol',
          name: store.storeName,
          ok: result.status === 'ok',
          durationMs: result.durationMs,
          errorKind: result.errorKind,
          detail: {
            runId: run.id,
            storeId: store.storeId,
            conversations: result.conversations,
            drafts: result.drafts,
          },
        });
      }
    }
  }

  /**
   * 执行一次巡逻（内部）。
   * @param {object} run - run 状态。
   * @returns {Promise<void>} 完成。
   */
  async function execute(run) {
    try {
      if (!adapter) throw new PatrolError('没有可用的平台适配器', 500);
      run.phase = 'listing';
      log(run, 'info', '拉取店铺列表');
      const all = await adapter.listStores();
      let stores = all;
      if (run.options.storeIds.length > 0) {
        const wanted = new Set(run.options.storeIds);
        stores = stores.filter((store) => wanted.has(store.storeId) || wanted.has(store.storeName));
      }
      if (run.options.maxStores > 0) stores = stores.slice(0, run.options.maxStores);
      run.progress.storesTotal = stores.length;
      log(run, 'info', `共 ${stores.length} 家店铺待巡逻`);

      if (stores.length === 0) {
        run.status = 'done';
        run.phase = 'done';
        run.finishedAt = new Date().toISOString();
        persist(run);
        return;
      }

      for (const store of stores) {
        if (run.cancelRequested) break;
        await patrolStore(run, store);
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
            stores: run.progress.storesTotal,
            drafts: run.progress.draftsCreated,
            errors: run.progress.errors,
            maxPerStore: run.options.maxPerStore,
          },
        });
      }
      logger.info(
        `巡逻 ${run.id} 结束：${run.status}，${run.progress.storesDone}/${run.progress.storesTotal} 家店，新草稿 ${run.progress.draftsCreated} 条`,
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
      log(active, 'info', '收到停止请求，跑完当前这家店就收工');
      return { stopped: true, id: active.id };
    },
    /** 当前/最近一次的快照。 */
    snapshot,
    /** 只读的 run 列表（目前只有一次）。 */
    get active() {
      return active;
    },
  };
}
