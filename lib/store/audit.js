/**
 * 活动审计：按天分片的追加式 JSONL。
 *
 * 为什么是追加式按天分片而不是单文档：审计是**时间序列**，读的时候永远带窗口
 * （近 N 天），写的时候只追加不修改。按天分片让「读窗口」变成只读几个文件，
 * 清理也只要删文件。
 *
 * 硬约束：**绝不写入邮件正文、主题、收件人、任何 token**。detail 会被限长截断，
 * 并由测试显式断言不含敏感字段。
 *
 * @module dsh-customer-service-plugin/lib/store/audit
 */

import fs from 'node:fs';
import path from 'node:path';

/** 单行上限（字节）。超过就截断 detail。 */
const DEFAULT_MAX_LINE_BYTES = 8 * 1024;
/** detail 序列化后上限（字节）。 */
const DEFAULT_MAX_DETAIL_BYTES = 2 * 1024;
/** 时间戳格式化器的缓存：构造 Intl.DateTimeFormat 很贵。 */
const formatterCache = new Map();

/**
 * 取某个时区的时间戳格式化器。
 * @param {string} timeZone - IANA 时区名。
 * @returns {Intl.DateTimeFormat} 格式化器。
 */
function dayFormatter(timeZone) {
  const key = timeZone || 'UTC';
  let cached = formatterCache.get(key);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-US', {
      timeZone: key,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    formatterCache.set(key, cached);
  }
  return cached;
}

/**
 * 把时间换算成指定时区的「本地日」键 `YYYY-MM-DD`。
 *
 * 用 formatToParts 自己拼，不依赖 locale 输出格式（例如 en-CA 的 `YYYY-MM-DD`
 * 只是巧合，换 Node 版本可能变）。这样夏令时也由 Intl 负责。
 * @param {string|number|Date} value - 时间戳。
 * @param {string} timeZone - IANA 时区名。
 * @returns {string} `YYYY-MM-DD`。
 */
export function dayKey(value, timeZone = 'UTC') {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`无效时间：${String(value)}`);
  const parts = dayFormatter(timeZone).formatToParts(date);
  const pick = (type) => parts.find((part) => part.type === type)?.value ?? '';
  return `${pick('year')}-${pick('month')}-${pick('day')}`;
}

/**
 * 把任意值压成限长的、可安全落盘的 JSON。
 * @param {unknown} value - 原始值。
 * @param {number} maxBytes - 上限字节数。
 * @returns {unknown} 截断后的值。
 */
export function clampDetail(value, maxBytes = DEFAULT_MAX_DETAIL_BYTES) {
  if (value === undefined || value === null) return null;
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return { truncated: true, reason: 'unserializable' };
  }
  if (text === undefined) return null;
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return value;
  return { truncated: true, preview: text.slice(0, Math.max(0, maxBytes - 64)) };
}

/**
 * 建一个审计存储。
 * @param {{dir: string, timezone?: string, retentionDays?: number, logger?: object}} options - 配置。
 * @returns {object} 审计存储。
 */
export function createAuditStore(options) {
  const baseDir = path.resolve(options.dir);
  const auditDir = path.join(baseDir, 'audit');
  const logger = options.logger ?? { warn: () => {} };
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxDetailBytes = options.maxDetailBytes ?? DEFAULT_MAX_DETAIL_BYTES;

  /** 当前时区：设置变了要跟着变。 */
  let timezone = options.timezone || 'UTC';
  /** 保留天数。 */
  let retentionDays = Number.isFinite(options.retentionDays) ? options.retentionDays : 30;

  const fileFor = (day) => path.join(auditDir, `${day}.jsonl`);

  const ensureDir = () => {
    fs.mkdirSync(auditDir, { recursive: true });
  };

  /**
   * 追加一条事件。
   * @param {object} event - 事件（见模块注释）。`at` 缺省为当前时间。
   * @returns {object|null} 实际落盘的事件，失败返回 null（审计失败绝不拖垮调用方）。
   */
  function append(event) {
    try {
      ensureDir();
      const input = event && typeof event === 'object' ? event : {};
      const at = typeof input.at === 'string' && input.at ? input.at : new Date().toISOString();
      const day = dayKey(at, timezone);
      const record = {
        at,
        day,
        tz: timezone,
        kind: typeof input.kind === 'string' ? input.kind : 'unknown',
        name: typeof input.name === 'string' ? input.name : null,
        ok: input.ok === false ? false : input.ok === true ? true : null,
        code: Number.isFinite(input.code) ? input.code : null,
        durationMs: Number.isFinite(input.durationMs) ? Math.round(input.durationMs) : null,
        errorKind: typeof input.errorKind === 'string' ? input.errorKind : null,
        detail: clampDetail(input.detail, maxDetailBytes),
      };
      let line = `${JSON.stringify(record)}\n`;
      if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
        record.detail = { truncated: true, reason: 'line-too-long' };
        line = `${JSON.stringify(record)}\n`;
      }
      fs.appendFileSync(fileFor(day), line, 'utf8');
      return record;
    } catch (cause) {
      logger.warn(`审计写入失败：${cause instanceof Error ? cause.message : cause}`);
      return null;
    }
  }

  /**
   * 列出已有分片日（升序）。
   * @returns {string[]} `YYYY-MM-DD` 列表。
   */
  function listDays() {
    try {
      return fs
        .readdirSync(auditDir)
        .filter((entry) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry))
        .map((entry) => entry.slice(0, 10))
        .sort();
    } catch {
      return [];
    }
  }

  /**
   * 读取窗口内的事件。
   *
   * 返回**最新在前**（倒序）：读日分片是从最后一天往前读的，这样「最近 N 条」
   * 不需要扫全部历史，也正好符合活动列表的展示顺序。
   * @param {{from?: string, to?: string, limit?: number, kinds?: string[]}} [range] - 条件。
   * @returns {{items: object[], days: string[], skippedLines: number, truncated: boolean}} 结果。
   */
  function readRange(range = {}) {
    const limit = Number.isFinite(range.limit) && range.limit > 0 ? Math.floor(range.limit) : 200;
    const kinds = Array.isArray(range.kinds) && range.kinds.length > 0 ? new Set(range.kinds) : null;
    const wanted = listDays().filter((day) => {
      if (range.from && day < range.from) return false;
      if (range.to && day > range.to) return false;
      return true;
    });

    const items = [];
    let skippedLines = 0;
    let truncated = false;

    for (let i = wanted.length - 1; i >= 0; i -= 1) {
      let text;
      try {
        text = fs.readFileSync(fileFor(wanted[i]), 'utf8');
      } catch {
        continue;
      }
      const lines = text.split('\n');
      for (let j = lines.length - 1; j >= 0; j -= 1) {
        const line = lines[j];
        if (!line) continue;
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          skippedLines += 1;
          continue;
        }
        if (kinds && !kinds.has(parsed.kind)) continue;
        items.push(parsed);
        if (items.length >= limit) {
          truncated = true;
          break;
        }
      }
      if (items.length >= limit) break;
    }

    return { items, days: wanted, skippedLines, truncated };
  }

  /**
   * 删除超过保留期的分片。
   * @param {{now?: Date}} [opts] - 参考时间。
   * @returns {{removed: string[]}} 被删掉的分片。
   */
  function prune(opts = {}) {
    const now = opts.now instanceof Date ? opts.now : new Date();
    const removed = [];
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return { removed };
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 3600 * 1000);
    const cutoffKey = dayKey(cutoff, timezone);
    for (const day of listDays()) {
      if (day < cutoffKey) {
        try {
          fs.unlinkSync(fileFor(day));
          removed.push(day);
        } catch {
          /* 删不掉就下次再试 */
        }
      }
    }
    if (removed.length > 0) logger.warn(`审计已清理 ${removed.length} 个过期分片`);
    return { removed };
  }

  return {
    dir: auditDir,
    append,
    listDays,
    readRange,
    prune,
    dayKey: (value) => dayKey(value, timezone),
    get timezone() {
      return timezone;
    },
    get retentionDays() {
      return retentionDays;
    },
    /**
     * 设置热更新（改时区/保留天数后调用）。
     * @param {{timezone?: string, retentionDays?: number}} next - 新配置。
     * @returns {void}
     */
    configure(next = {}) {
      if (typeof next.timezone === 'string' && next.timezone) timezone = next.timezone;
      if (Number.isFinite(next.retentionDays)) retentionDays = next.retentionDays;
    },
  };
}
