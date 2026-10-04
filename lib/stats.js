/**
 * 统计口径：**全部在服务端算好**，UI 只负责渲染。
 *
 * 这样做有三个好处：口径只有一处（不会前端一套、后续 AI 工具一套）；
 * 前端不需要理解业务；测试可以在 Node 里把口径钉死。
 *
 * 两组指标：
 *   - business：来自工单队列（渠道/类型/负责人分布、今日、SLA、趋势）
 *   - runtime ：来自活动审计（CLI 调用成功率与耗时、体检历史、趋势）
 *
 * @module dsh-customer-service-plugin/lib/stats
 */

import { dayKey } from './store/audit.js';
import { CHANNELS, KINDS, STATUSES } from './store/queue.js';

/** 默认缓存时长。 */
const DEFAULT_TTL_MS = 60_000;
/** 单次统计最多读多少条审计事件。 */
const AUDIT_READ_LIMIT = 50_000;
/** 终态：不再计入「超时未处理」。 */
const TERMINAL = new Set(['sent', 'archived']);

/**
 * 取分位数（输入必须是升序数组）。
 * @param {number[]} sorted - 升序数值。
 * @param {number} ratio - 0..1。
 * @returns {number|null} 分位数，空数组返回 null。
 */
export function percentile(sorted, ratio) {
  if (!Array.isArray(sorted) || sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index];
}

/**
 * 取中位数。
 * @param {number[]} values - 数值。
 * @returns {number|null} 中位数，空数组返回 null。
 */
export function median(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * 算一个比率，分母为 0 时返回 null（**不是 0** —— UI 要显示「—」而不是 0%）。
 * @param {number} numerator - 分子。
 * @param {number} denominator - 分母。
 * @returns {number|null} 比率。
 */
export function ratio(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

/**
 * 生成窗口内连续的本地下日列表（升序）。
 * @param {{days: number, timezone: string, now?: Date}} options - 输入。
 * @returns {{from: string, to: string, days: string[]}} 窗口。
 */
export function windowDays(options) {
  const days = Number.isFinite(options.days) && options.days > 0 ? Math.floor(options.days) : 14;
  const now = options.now instanceof Date ? options.now : new Date();
  const keys = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    const key = dayKey(new Date(now.getTime() - i * 24 * 3600 * 1000), options.timezone);
    if (!keys.includes(key)) keys.push(key);
  }
  keys.sort();
  return { from: keys[0], to: keys[keys.length - 1], days: keys };
}

/** 建一个空的按天桶。 */
function emptySeries(days, fields) {
  const buckets = new Map(days.map((day) => [day, { day, ...Object.fromEntries(fields.map((f) => [f, 0])) }]));
  return { buckets, list: () => days.map((day) => buckets.get(day)) };
}

/**
 * 建统计服务。
 * @param {{queue: object, audit: object, getSettings: () => object, clock?: () => Date, ttlMs?: number}} options - 依赖。
 * @returns {object} 统计服务。
 */
export function createStatsService(options) {
  const { queue, audit, getSettings } = options;
  const clock = options.clock ?? (() => new Date());
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  /** 缓存：key 是 days，value 是 {at, value}。 */
  const cache = new Map();

  /** 清缓存（工单或审计写入后调用）。 */
  function invalidate() {
    cache.clear();
  }

  /**
   * 计算两组指标。
   * @param {{days?: number}} [request] - 请求。
   * @returns {object} 见模块注释的结构。
   */
  function compute(request = {}) {
    const settings = getSettings() ?? {};
    const timezone = settings.timezone || 'Asia/Shanghai';
    const days = Number.isFinite(request.days) && request.days > 0 ? Math.floor(request.days) : 14;
    const key = `${days}|${timezone}|${settings.sla?.defaultHours ?? 24}|${settings.retention?.auditDays ?? 30}`;
    const hit = cache.get(key);
    const now = clock();
    if (hit && now.getTime() - hit.at < ttlMs) return hit.value;

    const win = windowDays({ days, timezone, now });
    const today = dayKey(now, timezone);
    const counts = queue.counts();
    const items = queue.load().items;
    const defaultSlaHours = Number.isFinite(settings.sla?.defaultHours) ? settings.sla.defaultHours : 24;

    /* ── 业务指标 ─────────────────────────────────────────────────────── */
    const series = emptySeries(win.days, ['created', 'sent']);
    const todayBuckets = { created: 0, sent: 0, drafted: 0, needsHuman: 0 };
    const firstResponseGaps = [];
    let sentOnTime = 0;
    let sentTotal = 0;
    let overdue = 0;

    const dueAtOf = (item) => {
      if (item.slaDueAt) return new Date(item.slaDueAt).getTime();
      if (!item.receivedAt) return null;
      return new Date(item.receivedAt).getTime() + defaultSlaHours * 3600 * 1000;
    };

    for (const item of items) {
      const receivedDay = item.receivedAt ? dayKey(item.receivedAt, timezone) : null;
      if (receivedDay && series.buckets.has(receivedDay)) series.buckets.get(receivedDay).created += 1;
      if (receivedDay === today) todayBuckets.created += 1;

      if (item.sentAt) {
        const sentDay = dayKey(item.sentAt, timezone);
        if (series.buckets.has(sentDay)) series.buckets.get(sentDay).sent += 1;
        if (sentDay === today) todayBuckets.sent += 1;
        sentTotal += 1;
        const due = dueAtOf(item);
        if (due !== null && new Date(item.sentAt).getTime() <= due) sentOnTime += 1;
      } else {
        const due = dueAtOf(item);
        if (!TERMINAL.has(item.status) && due !== null && due < now.getTime()) overdue += 1;
      }

      for (const entry of item.timeline ?? []) {
        if (entry.action !== 'status') continue;
        const entryDay = entry.at ? dayKey(entry.at, timezone) : null;
        if (entryDay !== today) continue;
        // 用结构化的 `to`，不要用详情文本 —— `drafted → approved` 的文本里同样含 `drafted`。
        if (entry.to === 'drafted') todayBuckets.drafted += 1;
        if (entry.to === 'needs_human') todayBuckets.needsHuman += 1;
      }

      if (item.firstResponseAt && item.receivedAt) {
        const gap = new Date(item.firstResponseAt).getTime() - new Date(item.receivedAt).getTime();
        if (Number.isFinite(gap) && gap >= 0) firstResponseGaps.push(gap);
      }
    }

    const business = {
      hasData: counts.total > 0,
      total: counts.total,
      byStatus: counts.byStatus,
      byChannel: counts.byChannel,
      byKind: counts.byKind,
      byAssignee: counts.byAssignee,
      today: todayBuckets,
      sla: {
        defaultHours: defaultSlaHours,
        overdue,
        onTimeRate: ratio(sentOnTime, sentTotal),
        medianFirstResponseMs: median(firstResponseGaps),
      },
      series: series.list(),
    };

    /* ── 运行指标 ─────────────────────────────────────────────────────── */
    const auditRead = audit.readRange({ from: win.from, to: win.to, limit: AUDIT_READ_LIMIT });
    const runtimeSeries = emptySeries(win.days, ['cli', 'cliFail', 'tickets', 'sent']);
    const cliByName = new Map();
    const cliErrorKinds = new Map();
    const durations = [];
    const cli = { total: 0, ok: 0, fail: 0 };

    for (const event of auditRead.items) {
      const eventDay = event.day ?? (event.at ? dayKey(event.at, timezone) : null);
      const bucket = eventDay && runtimeSeries.buckets.get(eventDay);
      if (event.kind === 'cli') {
        cli.total += 1;
        const entry = cliByName.get(event.name ?? 'unknown') ?? {
          name: event.name ?? 'unknown',
          total: 0,
          ok: 0,
          fail: 0,
          durations: [],
          lastAt: null,
        };
        entry.total += 1;
        entry.lastAt = event.at ?? entry.lastAt;
        if (event.ok === false) {
          cli.fail += 1;
          entry.fail += 1;
          const errorKind = event.errorKind ?? 'unknown';
          cliErrorKinds.set(errorKind, (cliErrorKinds.get(errorKind) ?? 0) + 1);
        } else {
          cli.ok += 1;
          entry.ok += 1;
        }
        if (Number.isFinite(event.durationMs)) {
          entry.durations.push(event.durationMs);
          durations.push(event.durationMs);
        }
        cliByName.set(entry.name, entry);
        if (bucket) {
          bucket.cli += 1;
          if (event.ok === false) bucket.cliFail += 1;
        }
      } else if (event.kind === 'ticket' && bucket) {
        bucket.tickets += 1;
      } else if (event.kind === 'send' && bucket) {
        bucket.sent += 1;
      }
    }

    const sortedDurations = durations.sort((a, b) => a - b);
    // 显式按时间升序排一次，不依赖 auditStore.readRange 的返回顺序（它是最新在前）。
    const detectRuns = auditRead.items
      .filter((event) => event.kind === 'detect')
      .sort((a, b) => String(a.at ?? '').localeCompare(String(b.at ?? '')));
    let consecutiveFail = 0;
    for (let i = detectRuns.length - 1; i >= 0; i -= 1) {
      if (detectRuns[i].ok === false) consecutiveFail += 1;
      else break;
    }
    const lastDetect = detectRuns.length > 0 ? detectRuns[detectRuns.length - 1] : null;

    const runtime = {
      cli: {
        total: cli.total,
        ok: cli.ok,
        fail: cli.fail,
        successRate: ratio(cli.ok, cli.total),
        latency: {
          p50: percentile(sortedDurations, 0.5),
          p95: percentile(sortedDurations, 0.95),
        },
        byName: [...cliByName.values()]
          .map((entry) => {
            const sorted = [...entry.durations].sort((a, b) => a - b);
            return {
              name: entry.name,
              total: entry.total,
              ok: entry.ok,
              fail: entry.fail,
              successRate: ratio(entry.ok, entry.total),
              p50: percentile(sorted, 0.5),
              p95: percentile(sorted, 0.95),
              lastAt: entry.lastAt,
            };
          })
          .sort((a, b) => b.total - a.total),
        byErrorKind: [...cliErrorKinds.entries()]
          .map(([kind, count]) => ({ kind, count }))
          .sort((a, b) => b.count - a.count),
      },
      detect: {
        runs: detectRuns.length,
        lastAt: lastDetect?.at ?? null,
        lastOk: lastDetect ? lastDetect.ok !== false : null,
        consecutiveFail,
      },
      audit: {
        days: auditRead.days.length,
        skippedLines: auditRead.skippedLines,
        truncated: auditRead.truncated,
      },
      series: runtimeSeries.list(),
    };

    const value = {
      window: { days, from: win.from, to: win.to, timezone, today },
      business,
      runtime,
      generatedAt: now.toISOString(),
    };
    cache.set(key, { at: now.getTime(), value });
    return value;
  }

  return { compute, invalidate, windowDays: (o) => windowDays({ timezone: getSettings()?.timezone ?? 'Asia/Shanghai', ...o }) };
}

/** 供 UI/测试引用的枚举（小写键，直接作为 API 字段名）。 */
export const DIMENSIONS = Object.freeze({
  statuses: STATUSES,
  channels: CHANNELS,
  kinds: KINDS,
});
