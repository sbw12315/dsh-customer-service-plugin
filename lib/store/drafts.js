/**
 * 草稿库：单文档 + 原子写 + rev 乐观锁，和队列保持同一套模式。
 *
 * 为什么草稿要单独存一份而不是直接写进队列：队列是**工单状态机**（new → drafted →
 * approved → sending → sent），而草稿是**内容**。巡逻一次会产出几十条草稿，人工要逐条
 * 读、改、复制；把它压在工单的字段里，列表页就没法按「哪家店、什么意图、有没有
 * 需要人工确认的提示」来筛。所以：草稿库管内容，队列管流转，两边用 ticketId / draftId 互指。
 *
 * 硬约束：这里的任何操作都**不会**把草稿发出去。状态里的 `sent` 只可能由人工在
 * 亚马逊页面上点完之后回填，插件自己从不写这个值。
 *
 * @module dsh-customer-service-plugin/lib/store/drafts
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 允许的草稿状态。 */
export const DRAFT_STATUSES = ['draft', 'approved', 'filled', 'discarded'];

/** 草稿条数上限（超过只告警，不拒绝写入）。 */
const ITEM_WARN_THRESHOLD = 5000;

/** 带 HTTP 状态的领域错误。 */
export class DraftError extends Error {
  /**
   * @param {string} message - 原因。
   * @param {number} [status] - HTTP 状态码。
   */
  constructor(message, status = 400) {
    super(message);
    this.name = 'DraftError';
    this.status = status;
  }
}

/**
 * 建一个草稿库。
 * @param {{dir: string, logger?: object, clock?: () => Date, persistText?: boolean}} options - 配置。
 * @returns {object} 草稿库。
 */
export function createDraftStore(options) {
  const dir = path.resolve(options.dir);
  const file = path.join(dir, 'drafts.json');
  const logger = options.logger ?? { warn: () => {} };
  const clock = options.clock ?? (() => new Date());
  const persistText = options.persistText !== false;

  let doc = null;
  let loadedMtimeMs = -1;

  const emptyDoc = () => ({ version: 1, rev: 0, items: [] });

  /** 读盘。 */
  function load() {
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch {
      stat = null;
    }
    if (!stat) {
      if (!doc) doc = emptyDoc();
      loadedMtimeMs = -1;
      return doc;
    }
    if (doc && stat.mtimeMs === loadedMtimeMs) return doc;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      doc = {
        version: Number.isFinite(parsed?.version) ? parsed.version : 1,
        rev: Number.isFinite(parsed?.rev) ? parsed.rev : 0,
        items: Array.isArray(parsed?.items) ? parsed.items : [],
      };
    } catch (cause) {
      logger.warn(`草稿库损坏，退化为空：${cause instanceof Error ? cause.message : cause}`);
      doc = emptyDoc();
    }
    loadedMtimeMs = stat.mtimeMs;
    return doc;
  }

  /** 原子落盘。 */
  function save() {
    const current = doc ?? load();
    const next = { version: 1, rev: current.rev + 1, items: current.items };
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    doc = next;
    try {
      loadedMtimeMs = fs.statSync(file).mtimeMs;
    } catch {
      loadedMtimeMs = -1;
    }
    if (next.items.length > ITEM_WARN_THRESHOLD) {
      logger.warn(`草稿已有 ${next.items.length} 条，建议清理已处理的`);
    }
    return next;
  }

  /** 生成 id。 */
  function nextId() {
    return `d_${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  }

  /**
   * 给一条草稿写一份纯文本副本，方便直接打开看/复制。
   * @param {object} item - 草稿。
   * @returns {string|null} 文件路径。
   */
  function writeText(item) {
    if (!persistText) return null;
    try {
      const target = path.join(dir, `${item.id}.txt`);
      const header = [
        `# ${item.storeName || item.storeId} / ${item.buyer || '买家'}`,
        `# 意图: ${item.intentLabel || item.intent}   订单: ${item.orderId || '-'}   到期: ${item.dueText || '-'}`,
        `# 主题: ${item.subject || '-'}`,
        `# 状态: ${item.status}（本文件只是副本，改这里不会同步回草稿库）`,
        '',
      ].join('\n');
      fs.writeFileSync(target, `${header}${item.body}\n`, 'utf8');
      return target;
    } catch (cause) {
      logger.warn(`写草稿副本失败：${cause instanceof Error ? cause.message : cause}`);
      return null;
    }
  }

  /**
   * 计算去重键。
   *
   * 同一家店、同一个 caseId 只应该有一条草稿：巡逻可能一天跑好几次，
   * 重复生成几十份一模一样的草稿会让人工复核直接瘫痪。
   * @param {object} input - 草稿输入。
   * @returns {string} 去重键。
   */
  function dedupeKeyOf(input) {
    if (typeof input.dedupeKey === 'string' && input.dedupeKey.trim()) return input.dedupeKey.trim();
    const caseId = String(input.caseId ?? '').trim();
    // **只用 caseId，不带 storeId。** 同一个亚马逊账号在紫鸟里经常登记成好几条店铺
    // （管理员 / 客服 / 运营各一条），它们看到的是同一批会话。带上 storeId 的话，
    // 一次巡逻就会为同一个会话生成 N 份一模一样的草稿 —— 真机上就是这么跑出来的。
    if (caseId) return `${input.platform ?? 'amazon'}:case:${caseId}`;
    return `${input.platform ?? 'amazon'}:${input.storeId ?? ''}:${input.orderId ?? ''}:${input.buyer ?? ''}:${input.subject ?? ''}`;
  }

  const text = (value, max = 0) => {
    const out = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
    return max > 0 && out.length > max ? out.slice(0, max) : out;
  };

  /**
   * 新建或更新一条草稿（按去重键）。
   * @param {object} input - 草稿字段。
   * @returns {{item: object, created: boolean, textPath: string|null}} 结果。
   */
  function upsert(input = {}) {
    const current = load();
    const dedupeKey = dedupeKeyOf(input);
    const caseId = text(input.caseId).trim();
    // 同时按去重键**和** caseId 找：后者能把「早期去重键里带了 storeId」留下的
    // 历史重复一起认出来，做到自愈，而不是每跑一次再多一条。
    const candidates = current.items.filter(
      (item) => item.dedupeKey === dedupeKey || (caseId !== '' && item.caseId === caseId),
    );
    const existing = candidates[0];
    if (candidates.length > 1) {
      const doomed = new Set(candidates.slice(1).map((item) => item.id));
      current.items = current.items.filter((item) => !doomed.has(item.id));
      logger.warn(`草稿库里有 ${doomed.size} 条与 caseId ${caseId} 重复，已合并为一条`);
    }
    const now = clock().toISOString();
    const body = text(input.body);
    if (!body.trim()) throw new DraftError('草稿正文不能为空');

    if (existing) {
      existing.dedupeKey = dedupeKey;
      existing.updatedAt = now;

      // **人工动过的草稿，巡逻不再覆盖正文。**
      // 「草稿先行、人工审阅」的核心就是别把人改的东西冲掉：改过正文、批过、填进过回复框
      // 的草稿，再扫一次只会刷新到期时间这类会变的元数据，正文原样保留。
      const humanTouched =
        existing.status !== 'draft' ||
        existing.timeline.some((entry) => entry.action === 'edited' || entry.action === 'note' || entry.action === 'status');

      if (humanTouched) {
        existing.dueText = text(input.dueText, 80) || existing.dueText;
        existing.dueMinutes = Number.isFinite(input.dueMinutes) ? input.dueMinutes : existing.dueMinutes;
        existing.lastSeenAt = now;
        existing.timeline.push({
          at: now,
          action: 'regenerated',
          detail: '巡逻重新生成了草稿，但正文/状态已被人动过，保留人工版本（未覆盖）',
        });
        save();
        return { item: existing, created: false, preserved: true, textPath: writeText(existing) };
      }

      existing.body = body;
      existing.notes = Array.isArray(input.notes) ? input.notes.slice(0, 10) : existing.notes;
      existing.intent = text(input.intent) || existing.intent;
      existing.intentLabel = text(input.intentLabel) || existing.intentLabel;
      existing.intentSource = text(input.intentSource) || existing.intentSource;
      existing.orderId = text(input.orderId) || existing.orderId;
      existing.needsHuman = Boolean(input.needsHuman);
      existing.lastSeenAt = now;
      existing.timeline.push({ at: now, action: 'regenerated', detail: '巡逻重新生成了草稿' });
      save();
      return { item: existing, created: false, preserved: false, textPath: writeText(existing) };
    }

    const item = {
      id: nextId(),
      dedupeKey,
      createdAt: now,
      updatedAt: now,
      platform: text(input.platform) || 'amazon',
      storeId: text(input.storeId),
      storeName: text(input.storeName),
      caseId: text(input.caseId),
      buyer: text(input.buyer),
      // 邮箱渠道时 buyer 是显示名；真正要发到的地址单独存一份，排查「草稿投给谁」全靠它。
      buyerAddress: text(input.buyerAddress),
      country: text(input.country),
      subject: text(input.subject, 300),
      dueText: text(input.dueText, 80),
      dueMinutes: Number.isFinite(input.dueMinutes) ? input.dueMinutes : null,
      orderId: text(input.orderId, 40),
      product: text(input.product, 200),
      intent: text(input.intent) || 'inquiry',
      intentLabel: text(input.intentLabel) || '',
      intentSource: text(input.intentSource) || 'none',
      language: input.language && typeof input.language === 'object' ? input.language : { code: 'en', label: '英语' },
      needsHuman: Boolean(input.needsHuman),
      notes: Array.isArray(input.notes) ? input.notes.slice(0, 10) : [],
      body,
      status: 'draft',
      sent: false,
      ticketId: text(input.ticketId) || null,
      source: {
        url: text(input.source?.url),
        inboxUrl: text(input.source?.inboxUrl),
      },
      runId: text(input.runId) || null,
      timeline: [{ at: now, action: 'created', detail: input.runId ? `巡逻 ${input.runId} 生成` : '手工生成' }],
    };
    current.items.push(item);
    save();
    return { item, created: true, textPath: writeText(item) };
  }

  /**
   * 修改一条草稿（正文 / 状态 / 备注）。
   * @param {string} id - 草稿 id。
   * @param {{body?: string, status?: string, note?: string, ticketId?: string}} changes - 变更。
   * @param {{expectedRev?: number}} [opts] - 乐观锁。
   * @returns {object} 更新后的草稿。
   */
  function patch(id, changes = {}, opts = {}) {
    const current = load();
    if (Number.isFinite(opts.expectedRev) && opts.expectedRev !== current.rev) {
      throw new DraftError(
        `草稿库已被其它操作修改（当前 rev ${current.rev}，你基于 rev ${opts.expectedRev}），请刷新后重试`,
        409,
      );
    }
    const item = current.items.find((entry) => entry.id === id);
    if (!item) throw new DraftError(`草稿不存在：${id}`, 404);
    const now = clock().toISOString();
    let touched = false;

    if (changes.body !== undefined) {
      const body = text(changes.body);
      if (!body.trim()) throw new DraftError('草稿正文不能为空');
      if (body !== item.body) {
        item.body = body;
        item.timeline.push({ at: now, action: 'edited', detail: '人工修改了正文' });
        touched = true;
      }
    }
    if (changes.status !== undefined && changes.status !== item.status) {
      if (!DRAFT_STATUSES.includes(changes.status)) {
        throw new DraftError(`status 必须是 ${DRAFT_STATUSES.join(' / ')}，收到 ${JSON.stringify(changes.status)}`);
      }
      const previous = item.status;
      item.status = changes.status;
      item.timeline.push({ at: now, action: 'status', detail: `${previous} → ${changes.status}` });
      touched = true;
    }
    if (changes.ticketId !== undefined) {
      item.ticketId = text(changes.ticketId) || null;
      touched = true;
    }
    if (changes.note !== undefined && String(changes.note).trim()) {
      item.timeline.push({ at: now, action: 'note', detail: String(changes.note).trim().slice(0, 500) });
      touched = true;
    }
    if (!touched) return item;
    item.updatedAt = now;
    save();
    writeText(item);
    return item;
  }

  /**
   * 列出草稿。
   * @param {{storeId?: string, status?: string, intent?: string, platform?: string, needsHuman?: boolean|string, q?: string, limit?: number, offset?: number}} [filters] - 筛选。
   * @returns {{total: number, items: object[], counts: object}} 结果。
   */
  function list(filters = {}) {
    const all = load().items;
    const keyword = typeof filters.q === 'string' && filters.q.trim() ? filters.q.trim().toLowerCase() : null;
    const matched = all.filter((item) => {
      if (filters.storeId && item.storeId !== filters.storeId) return false;
      if (filters.status && filters.status !== 'all' && item.status !== filters.status) return false;
      if (filters.intent && item.intent !== filters.intent) return false;
      if (filters.platform && item.platform !== filters.platform) return false;
      if (filters.needsHuman === true || filters.needsHuman === 'true') {
        if (!item.needsHuman) return false;
      }
      if (keyword) {
        const haystack = `${item.buyer} ${item.subject} ${item.orderId} ${item.storeName} ${item.body}`.toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });
    const limit = Number.isFinite(filters.limit) && filters.limit > 0 ? Math.floor(filters.limit) : 100;
    const offset = Number.isFinite(filters.offset) && filters.offset > 0 ? Math.floor(filters.offset) : 0;
    const sorted = [...matched].sort((a, b) => {
      // 先按「快到期」排：dueMinutes 小的排前面，没有到期信息的排最后。
      const dueA = Number.isFinite(a.dueMinutes) ? a.dueMinutes : Number.POSITIVE_INFINITY;
      const dueB = Number.isFinite(b.dueMinutes) ? b.dueMinutes : Number.POSITIVE_INFINITY;
      if (dueA !== dueB) return dueA - dueB;
      return String(b.createdAt).localeCompare(String(a.createdAt));
    });
    return {
      total: matched.length,
      items: sorted.slice(offset, offset + limit),
      counts: counts(),
      // 可筛选的店铺/邮箱清单：**基于全部草稿算**，不受当前筛选影响。
      // 否则一按店铺筛完，下拉里的选项就只剩那一个，等于没法换。
      facets: { stores: storeFacets(all) },
    };
  }

  /**
   * 去重的店铺/邮箱清单（给筛选下拉用）。
   * @param {object[]} items - 全部草稿。
   * @returns {Array<{platform: string, storeId: string, storeName: string, total: number}>} 清单。
   */
  function storeFacets(items) {
    const map = new Map();
    for (const item of items) {
      const storeId = item.storeId || '';
      if (!storeId) continue;
      const key = `${item.platform}::${storeId}`;
      const found = map.get(key);
      if (found) found.total += 1;
      else {
        map.set(key, {
          platform: item.platform,
          storeId,
          storeName: item.storeName || storeId,
          total: 1,
        });
      }
    }
    return [...map.values()].sort((a, b) =>
      a.platform === b.platform ? a.storeName.localeCompare(b.storeName) : a.platform.localeCompare(b.platform),
    );
  }

  /** 各类计数。 */
  function counts() {
    const items = load().items;
    const byStatus = Object.fromEntries(DRAFT_STATUSES.map((status) => [status, 0]));
    const byIntent = {};
    const byStore = {};
    for (const item of items) {
      if (byStatus[item.status] !== undefined) byStatus[item.status] += 1;
      byIntent[item.intent] = (byIntent[item.intent] ?? 0) + 1;
      const key = item.storeName || item.storeId || '未知店铺';
      byStore[key] = (byStore[key] ?? 0) + 1;
    }
    return {
      byStatus,
      byIntent,
      byStore,
      needsHuman: items.filter((item) => item.needsHuman).length,
      total: items.length,
    };
  }

  /**
   * 取单条。
   * @param {string} id - 草稿 id。
   * @returns {object|undefined} 草稿。
   */
  function get(id) {
    return load().items.find((item) => item.id === id);
  }

  /**
   * 真删一条草稿，连同它的纯文本副本。
   *
   * 与 `patch(id, {status:'discarded'})` 的区别：那个只是**标记丢弃**，记录和正文都还在，
   * 随时能翻回来；这个是从库里**抹掉**，撤销不了。所以「丢弃」是默认动作，「删除」留给
   * 明确不要了的情况 —— 界面上那一下必须点确认。
   * @param {string} id - 草稿 id。
   * @returns {object|null} 被删掉的那条；不存在时返回 null（交给路由报 404）。
   */
  function remove(id) {
    const current = load();
    const index = current.items.findIndex((item) => item.id === id);
    if (index < 0) return null;
    const [removed] = current.items.splice(index, 1);
    save();
    // 副本不是真相源：删不掉只告警，不让整个删除失败。
    if (persistText) {
      try {
        fs.rmSync(path.join(dir, `${id}.txt`), { force: true });
      } catch (cause) {
        logger.warn(`删草稿副本失败：${cause instanceof Error ? cause.message : cause}`);
      }
    }
    return removed;
  }

  return {
    dir,
    file,
    load,
    list,
    counts,
    get,
    upsert,
    patch,
    remove,
    writeText,
    /** 测试与热切换用。 */
    invalidate() {
      doc = null;
      loadedMtimeMs = -1;
    },
    get rev() {
      return load().rev;
    },
  };
}
