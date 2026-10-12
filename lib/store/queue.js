/**
 * 工单队列：单文档 + 原子写。
 *
 * 为什么不是 append-only JSONL：队列读多写多，每次读都要把事件重放成当前状态，
 * 重放逻辑本身就是 bug 温床。这里用「单文档 + 原子写 + rev 乐观锁」——
 * 与计划数据（plan.json）保持同一套模式；历史追溯交给活动审计。
 *
 * 状态机是硬约束：只允许白名单内的跃迁，`new → sent` 这类必须被拒。
 *
 * @module dsh-customer-service-plugin/lib/store/queue
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 允许的渠道（顺序即界面筛选项顺序）。 */
export const CHANNELS = ['mail', 'tiktok', 'walmart', 'shein', 'temu', 'amazon'];
/** 允许的工单类型。 */
export const KINDS = ['message', 'review', 'afterSales', 'orderInquiry'];
/** 允许的状态。 */
export const STATUSES = [
  'new',
  'drafted',
  'approved',
  'sending',
  'sent',
  'failed',
  'needs_human',
  'archived',
];

/**
 * 状态跃迁白名单。`new → sent` 刻意不存在：必须先过草稿与人工放行。
 */
export const TRANSITIONS = Object.freeze({
  new: ['drafted', 'needs_human', 'archived'],
  drafted: ['approved', 'needs_human', 'archived'],
  approved: ['sending', 'needs_human', 'archived'],
  sending: ['sent', 'failed'],
  failed: ['drafted', 'needs_human', 'archived'],
  sent: ['archived'],
  needs_human: ['drafted', 'archived'],
  archived: [],
});

/** 单文档条数上限，超过只告警不拒绝（属于运营问题，不该让写入失败）。 */
const ITEM_WARN_THRESHOLD = 5000;

/** 带 HTTP 状态的领域错误，路由层直接映射。 */
export class QueueError extends Error {
  /**
   * @param {string} message - 可读原因。
   * @param {number} status - 建议的 HTTP 状态码。
   * @param {object} [extra] - 附加字段（例如允许的下一状态）。
   */
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.name = 'QueueError';
    this.status = status;
    Object.assign(this, extra);
  }
}

/**
 * 建一个工单队列存储。
 * @param {{file: string, logger?: object, clock?: () => Date}} options - 配置。
 * @returns {object} 队列存储。
 */
export function createQueueStore(options) {
  const file = path.resolve(options.file);
  const logger = options.logger ?? { warn: () => {} };
  const clock = options.clock ?? (() => new Date());

  /** 内存中的文档；`null` 表示还没读过。 */
  let doc = null;
  /** 上次读取时的 mtime，用来发现外部改动。 */
  let loadedMtimeMs = -1;

  /** 空文档。 */
  const emptyDoc = () => ({ version: 1, rev: 0, items: [] });

  /**
   * 读盘（带 mtime 判断，外部手改也能被发现）。
   * @returns {{version: number, rev: number, items: object[]}} 文档。
   */
  function load() {
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
    if (!stat) {
      // 文件还不存在：**只有当内存里也没有文档时**才建新的空文档。
      // 早期版本无条件覆盖，会把「刚 push 进去、还没落盘」的条目丢掉。
      if (!doc) doc = emptyDoc();
      loadedMtimeMs = -1;
      return doc;
    }
    if (doc && stat.mtimeMs === loadedMtimeMs) return doc;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      doc = {
        version: Number.isFinite(parsed?.version) ? parsed.version : 1,
        rev: Number.isFinite(parsed?.rev) ? parsed.rev : 0,
        items,
      };
    } catch (cause) {
      logger.warn(`队列文件损坏，退化为空队列：${cause instanceof Error ? cause.message : cause}`);
      doc = emptyDoc();
    }
    loadedMtimeMs = stat.mtimeMs;
    return doc;
  }

  /** 原子落盘并推进 rev。 */
  function save() {
    // 用当前内存文档而不是重新 load()：load() 在外部改动时会换掉对象，
    // 那样调用方刚做的修改就白做了。
    const current = doc ?? load();
    const next = { version: 1, rev: current.rev + 1, items: current.items };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    doc = next;
    try {
      loadedMtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      loadedMtimeMs = -1;
    }
    if (next.items.length > ITEM_WARN_THRESHOLD) {
      logger.warn(`队列已有 ${next.items.length} 条，建议归档已完成工单`);
    }
    return next;
  }

  /** 生成 id。 */
  function nextId() {
    return `q_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  }

  /**
   * 校验一个枚举字段。
   * @param {string} field - 字段名。
   * @param {unknown} value - 值。
   * @param {string[]} allowed - 允许值。
   * @returns {string} 校验后的值。
   */
  function assertEnum(field, value, allowed) {
    if (!allowed.includes(value)) {
      throw new QueueError(`${field} 必须是 ${allowed.join(' / ')}，收到 ${JSON.stringify(value)}`);
    }
    return value;
  }

  /**
   * 追加一条 timeline。
   *
   * 状态跃迁会把 `from`/`to` 也结构化记下来 —— 只靠 `detail` 文本判断「进入了哪个状态」
   * 会误判（`drafted → approved` 的文本里同样含 `drafted`），统计口径必须用结构化字段。
   * @param {object} item - 工单。
   * @param {string} action - `created|status|assign|note`。
   * @param {string|null} detail - 可读描述。
   * @param {string} [by] - 操作者。
   * @param {string|null} [at] - 时间戳。
   * @param {object} [extra] - 附加结构化字段。
   * @returns {void}
   */
  function pushTimeline(item, action, detail, by = 'operator', at = null, extra = undefined) {
    item.timeline.push({
      at: at ?? clock().toISOString(),
      by,
      action,
      detail: detail === undefined ? null : detail,
      ...(extra ?? {}),
    });
  }

  /**
   * 列出工单。
   * @param {{status?: string, channel?: string, kind?: string, assignee?: string, q?: string, limit?: number, offset?: number}} [filters] - 筛选。
   * @returns {{total: number, items: object[], counts: object}} 结果。
   */
  function list(filters = {}) {
    const all = load().items;
    const keyword = typeof filters.q === 'string' && filters.q.trim() ? filters.q.trim().toLowerCase() : null;
    const matched = all.filter((item) => {
      if (filters.status && filters.status !== 'all' && item.status !== filters.status) return false;
      if (filters.channel && item.channel !== filters.channel) return false;
      if (filters.kind && item.kind !== filters.kind) return false;
      if (filters.assignee) {
        const key = filters.assignee === '__none__' ? null : filters.assignee;
        if ((item.assignee ?? null) !== key) return false;
      }
      if (keyword) {
        const haystack = `${item.subject ?? ''} ${item.from ?? ''} ${item.snippet ?? ''}`.toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
    const limit = Number.isFinite(filters.limit) && filters.limit > 0 ? Math.floor(filters.limit) : 100;
    const offset = Number.isFinite(filters.offset) && filters.offset > 0 ? Math.floor(filters.offset) : 0;
    const sorted = [...matched].sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)));
    return {
      total: matched.length,
      items: sorted.slice(offset, offset + limit),
      counts: counts(),
    };
  }

  /**
   * 各类计数（供筛选栏与统计页使用）。
   * @returns {{byStatus: object, byChannel: object, byKind: object, byAssignee: Array<{name: string, count: number}>, total: number}} 计数。
   */
  function counts() {
    const items = load().items;
    const byStatus = Object.fromEntries(STATUSES.map((status) => [status, 0]));
    const byChannel = Object.fromEntries(CHANNELS.map((channel) => [channel, 0]));
    const byKind = Object.fromEntries(KINDS.map((kind) => [kind, 0]));
    const assignees = new Map();
    for (const item of items) {
      if (byStatus[item.status] !== undefined) byStatus[item.status] += 1;
      if (byChannel[item.channel] !== undefined) byChannel[item.channel] += 1;
      if (byKind[item.kind] !== undefined) byKind[item.kind] += 1;
      const name = item.assignee ?? '未分派';
      assignees.set(name, (assignees.get(name) ?? 0) + 1);
    }
    const byAssignee = [...assignees.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    return { byStatus, byChannel, byKind, byAssignee, total: items.length };
  }

  /**
   * 取单条。
   * @param {string} id - 工单 id。
   * @returns {object|undefined} 工单。
   */
  function get(id) {
    return load().items.find((item) => item.id === id);
  }

  /**
   * 新建工单。
   * @param {object} input - 字段。
   * @returns {{item: object, deduped: boolean}} 结果。
   */
  function create(input = {}) {
    const current = load();
    const idempotencyKey = typeof input.idempotencyKey === 'string' ? input.idempotencyKey.trim() : '';
    if (idempotencyKey) {
      const existing = current.items.find((item) => item.idempotencyKey === idempotencyKey);
      if (existing) return { item: existing, deduped: true };
    }

    const channel = assertEnum('channel', input.channel ?? 'mail', CHANNELS);
    const kind = assertEnum('kind', input.kind ?? 'message', KINDS);
    const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
    if (!subject) throw new QueueError('subject 不能为空');
    const assignee =
      typeof input.assignee === 'string' && input.assignee.trim() ? input.assignee.trim() : null;
    const now = clock().toISOString();
    const item = {
      id: nextId(),
      channel,
      kind,
      status: 'new',
      subject,
      from: typeof input.from === 'string' ? input.from.trim() : '',
      snippet: typeof input.snippet === 'string' ? input.snippet.slice(0, 500) : '',
      assignee,
      source: {
        messageId: input.source?.messageId ?? '',
        threadId: input.source?.threadId ?? '',
        storeId: input.source?.storeId ?? '',
        url: input.source?.url ?? '',
      },
      receivedAt: typeof input.receivedAt === 'string' && input.receivedAt ? input.receivedAt : now,
      slaDueAt: typeof input.slaDueAt === 'string' && input.slaDueAt ? input.slaDueAt : null,
      firstResponseAt: null,
      sentAt: null,
      draftId: null,
      larkDraftId: null,
      idempotencyKey,
      attempts: 0,
      lastError: null,
      timeline: [],
    };
    pushTimeline(item, 'created', typeof input.note === 'string' ? input.note : null);
    current.items.push(item);
    save();
    return { item, deduped: false };
  }

  /**
   * 修改工单。
   * @param {string} id - 工单 id。
   * @param {object} changes - `{status?, assignee?, note?, slaDueAt?}`。
   * @param {{expectedRev?: number, now?: string}} [opts] - 乐观锁与时间注入。
   * @returns {object} 更新后的工单。
   */
  function patch(id, changes = {}, opts = {}) {
    const current = load();
    if (Number.isFinite(opts.expectedRev) && opts.expectedRev !== current.rev) {
      throw new QueueError(
        `队列已被其它操作修改（当前 rev ${current.rev}，你基于 rev ${opts.expectedRev}），请刷新后重试`,
        409,
        { currentRev: current.rev },
      );
    }
    const item = current.items.find((entry) => entry.id === id);
    if (!item) throw new QueueError(`工单不存在：${id}`, 404);
    const at = opts.now ?? clock().toISOString();
    let touched = false;

    if (changes.status !== undefined && changes.status !== item.status) {
      const next = assertEnum('status', changes.status, STATUSES);
      const allowed = TRANSITIONS[item.status] ?? [];
      if (!allowed.includes(next)) {
        throw new QueueError(
          `不允许从「${item.status}」直接变成「${next}」`,
          400,
          { from: item.status, to: next, allowed },
        );
      }
      const previous = item.status;
      item.status = next;
      pushTimeline(item, 'status', `${previous} → ${next}`, 'operator', at, { from: previous, to: next });
      if (next === 'sent') {
        item.sentAt = at;
        if (!item.firstResponseAt) item.firstResponseAt = at;
      }
      if (!item.firstResponseAt && next !== 'archived' && next !== 'needs_human') {
        item.firstResponseAt = at;
      }
      touched = true;
    }

    if (changes.assignee !== undefined) {
      const next =
        typeof changes.assignee === 'string' && changes.assignee.trim()
          ? changes.assignee.trim()
          : null;
      if (next !== item.assignee) {
        pushTimeline(item, 'assign', `${item.assignee ?? '未分派'} → ${next ?? '未分派'}`, 'operator', at);
        item.assignee = next;
        touched = true;
      }
    }

    if (changes.slaDueAt !== undefined) {
      const next = typeof changes.slaDueAt === 'string' && changes.slaDueAt ? changes.slaDueAt : null;
      if (next !== item.slaDueAt) {
        item.slaDueAt = next;
        touched = true;
      }
    }

    if (changes.note !== undefined && String(changes.note).trim()) {
      pushTimeline(item, 'note', String(changes.note).trim().slice(0, 1000), 'operator', at);
      touched = true;
    }

    // 摘要与草稿指针刻意**不**写 timeline：巡逻每跑一次都会刷新它们，
    // 写进处理记录只会把真正的人工操作淹掉。
    if (changes.snippet !== undefined) {
      const next = typeof changes.snippet === 'string' ? changes.snippet.slice(0, 500) : '';
      if (next && next !== item.snippet) {
        item.snippet = next;
        touched = true;
      }
    }

    if (changes.draftId !== undefined) {
      const next =
        typeof changes.draftId === 'string' && changes.draftId.trim() ? changes.draftId.trim() : null;
      if (next !== item.draftId) {
        item.draftId = next;
        touched = true;
      }
    }

    if (!touched) return item;
    save();
    return item;
  }

  return {
    file,
    load,
    list,
    counts,
    get,
    create,
    patch,
    /** 测试与热切换用：丢掉内存缓存。 */
    invalidate() {
      doc = null;
      loadedMtimeMs = -1;
    },
    get rev() {
      return load().rev;
    },
  };
}
