/**
 * 纯格式化函数：不碰 DOM、不依赖任何库，所以可以直接在 Node 里跑单测。
 * 约定：**没有数据一律显示「—」**，绝不显示 0 或 NaN 冒充真实值。
 */

/** 数值占位符。 */
export const DASH = '—';

/**
 * 整数。
 * @param {unknown} value - 数值。
 * @returns {string} 结果。
 */
export function num(value) {
  if (value === null || value === undefined || value === '') return DASH;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DASH;
  return parsed.toLocaleString('zh-CN');
}

/**
 * 百分比（输入是 0..1 的比率）。
 * @param {unknown} value - 比率。
 * @param {number} [digits] - 小数位。
 * @returns {string} 结果。
 */
export function pct(value, digits = 0) {
  if (value === null || value === undefined) return DASH;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DASH;
  return `${(parsed * 100).toFixed(digits)}%`;
}

/**
 * 毫秒 → 可读时长。
 * @param {unknown} value - 毫秒。
 * @returns {string} 结果。
 */
export function ms(value) {
  if (value === null || value === undefined) return DASH;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return DASH;
  if (parsed < 1000) return `${Math.round(parsed)} ms`;
  if (parsed < 60_000) return `${(parsed / 1000).toFixed(parsed < 10_000 ? 1 : 0)} 秒`;
  if (parsed < 3_600_000) return `${Math.round(parsed / 60_000)} 分钟`;
  if (parsed < 86_400_000) {
    const hours = Math.floor(parsed / 3_600_000);
    const minutes = Math.round((parsed % 3_600_000) / 60_000);
    return minutes > 0 ? `${hours} 小时 ${minutes} 分` : `${hours} 小时`;
  }
  const days = Math.floor(parsed / 86_400_000);
  const hours = Math.round((parsed % 86_400_000) / 3_600_000);
  return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
}

/**
 * ISO 时间 → 相对时间。
 * @param {unknown} iso - ISO 字符串。
 * @param {Date} [now] - 参考时间（测试注入）。
 * @returns {string} 结果。
 */
export function relative(iso, now = new Date()) {
  if (!iso) return DASH;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return DASH;
  const delta = now.getTime() - then;
  if (delta < 0) return '刚刚';
  if (delta < 60_000) return '刚刚';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  if (delta < 30 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`;
  return dateTime(iso);
}

/**
 * ISO 时间 → `MM-DD HH:mm`。
 * @param {unknown} iso - ISO 字符串。
 * @returns {string} 结果。
 */
export function dateTime(iso) {
  if (!iso) return DASH;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return DASH;
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * `YYYY-MM-DD` → `MM-DD`（图表的横轴标签）。
 * @param {unknown} day - 日键。
 * @returns {string} 结果。
 */
export function shortDay(day) {
  if (typeof day !== 'string' || day.length < 10) return String(day ?? DASH);
  return day.slice(5);
}

/**
 * SLA 剩余/超时。
 * @param {unknown} dueIso - 截止时间。
 * @param {Date} [now] - 参考时间。
 * @returns {{text: string, overdue: boolean, unknown: boolean}} 结果。
 */
export function slaCountdown(dueIso, now = new Date()) {
  if (!dueIso) return { text: DASH, overdue: false, unknown: true };
  const due = new Date(dueIso).getTime();
  if (!Number.isFinite(due)) return { text: DASH, overdue: false, unknown: true };
  const delta = due - now.getTime();
  if (delta < 0) return { text: `超时 ${ms(-delta)}`, overdue: true, unknown: false };
  return { text: `剩 ${ms(delta)}`, overdue: false, unknown: false };
}

/** 把比率转成 CSS 宽度百分比。 */
export function barWidth(value, max) {
  const v = Number(value);
  const m = Number(max);
  if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0) return '0%';
  return `${Math.min(100, Math.round((v / m) * 1000) / 10)}%`;
}
