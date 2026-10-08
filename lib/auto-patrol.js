/**
 * 定时巡检（自动巡逻）。
 *
 * 模型是**一张巡检时刻表**：可以配若干次巡检，每次一个具体时间（HH:MM，按 settings.timezone）。
 * 到点就跑一次**完整巡逻**：扫描 → 逐店读会话 → 生成草稿 → 填入回复框 —— 与人工点
 * 「重新扫描」是同一套代码，只是发起者换成了心跳。
 *
 * 刻意划清的一条线：**这里不判定「DSH 是否空闲」**。插件跑在宿主进程里，看不到你别的
 * 会话有没有在用 DSH —— 拿一个不可靠的信号去决定「要不要自动开浏览器」，比不做更危险。
 * 所以口径只有「到没到这个点」，界面上也这么写。
 *
 * 四条硬约束：
 *   1. **一天一个时刻只跑一次**：跑过的时刻记账，重启也不会重复补跑。
 *   2. **永不并发**：上一次巡逻还在跑就跳过这一次，不排队、不打断、不叠加。
 *   3. **永不关浏览器**：closeAfter 强制 false —— 草稿正躺在回复框里等人核对。
 *   4. **默认关闭**：无人值守会自己打开店铺浏览器，这件事必须由人显式打开。
 *
 * 为什么不用宿主的 timer 服务：这里只需要「每分钟看一眼」的心跳，setInterval 足够，
 * 也不依赖宿主 API 的形状；卸载时由 ctx.on('dispose') 清掉。
 *
 * @module dsh-customer-service-plugin/lib/auto-patrol
 */

import fs from 'node:fs';
import path from 'node:path';

/** 心跳间隔：每分钟看一眼（时刻表的粒度就是分钟）。 */
export const TICK_MS = 60_000;

/**
 * 到点后的宽限分钟数。
 *
 * 心跳是每分钟一次，但它可能被别的事情拖慢（事件循环卡住、机器休眠、DSH 刚好在
 * 09:00:40 重启）—— 只认「正好这一分钟」会静默漏掉整次巡检。所以给 5 分钟宽限：
 * 09:00 的巡检在 09:05 之前发现都算数，而且同一时刻只会跑一次。
 */
export const SLOT_GRACE_MINUTES = 5;

/** 时刻表的出厂默认值。 */
export const AUTO_PATROL_DEFAULTS = Object.freeze({
  enabled: false,
  times: ['09:00', '14:00', '20:00'],
});

/** 一次巡检都没跑成的原因 → 给人看的一句话。 */
const SKIP_TEXT = Object.freeze({
  disabled: '未启用',
  'no-times': '还没添加巡检时刻',
  'not-due': '还没到巡检时间',
  busy: '上一次巡逻还在跑',
});

/**
 * 把 `HH:MM` 解析成「当天第几分钟」。
 * @param {unknown} value - 形如 `09:00`；`9:00` 也认。
 * @returns {number|null} 分钟数；非法返回 null。
 */
export function parseClock(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/**
 * 把分钟数格式化回 `HH:MM`（自动取模 1440）。
 * @param {number} minutes - 分钟数。
 * @returns {string} 形如 `09:00`。
 */
export function formatClock(minutes) {
  const wrapped = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/**
 * 把任意输入收敛成一张巡检时刻表：去掉非法项、去重、按时间升序。
 * @param {unknown} value - 数组，或空格/逗号分隔的字符串。
 * @returns {string[]} 形如 `['09:00', '14:00']`；最多 48 次。
 */
export function normalizeTimes(value) {
  const parts = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,;]+/)
      : [];
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const minutes = parseClock(part);
    if (minutes === null) continue;
    const text = formatClock(minutes);
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  out.sort((a, b) => parseClock(a) - parseClock(b));
  return out.slice(0, 48);
}

/**
 * 某个时刻在指定时区是「哪一天的第几分钟」。
 *
 * 时刻表必须按用户配置的时区判，不能按宿主进程的本地时区 —— 插件要装在别人的机器上，
 * 而那台机器的 TZ 不一定是业务时区。时区名非法时退回宿主本地时区，绝不让它抛。
 * @param {Date} date - 时刻。
 * @param {string} timeZone - IANA 时区名。
 * @returns {{dateKey: string, minutes: number}} 日期键（YYYY-MM-DD）与当天第几分钟。
 */
export function zonedParts(date, timeZone) {
  const options = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', { ...options, timeZone }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-CA', options).formatToParts(date);
  }
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00';
  return {
    dateKey: `${get('year')}-${get('month')}-${get('day')}`,
    minutes: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

/**
 * 某个时刻在指定时区是「当天第几分钟」。
 * @param {Date} date - 时刻。
 * @param {string} timeZone - IANA 时区名。
 * @returns {number} 当天第几分钟（0..1439）。
 */
export function zonedMinutes(date, timeZone) {
  return zonedParts(date, timeZone).minutes;
}

/**
 * 建一个定时巡检调度器。
 * @param {{settings: object, patrol: object, logger?: object, clock?: () => Date, audit?: object, stateFile?: string, tickMs?: number, graceMinutes?: number}} options - 依赖。
 *   `settings` / `patrol` 都是**活引用**：改完设置立即生效，不需要重建调度器。
 * @returns {object} 调度器。
 */
export function createAutoPatrol(options) {
  const settings = options.settings;
  const patrol = options.patrol;
  const logger = options.logger ?? { warn: () => {}, info: () => {} };
  const clock = options.clock ?? (() => new Date());
  const audit = options.audit ?? null;
  const stateFile = options.stateFile ? path.resolve(options.stateFile) : null;
  const tickMs = Number.isFinite(options.tickMs) && options.tickMs > 0 ? options.tickMs : TICK_MS;
  const graceMinutes = Number.isFinite(options.graceMinutes) ? options.graceMinutes : SLOT_GRACE_MINUTES;

  let timer = null;
  const state = { fired: {}, lastStartedAt: null, lastRunId: null };

  /** 读上次的记账：重启后不能把今天已经跑过的时刻又跑一遍。 */
  function loadState() {
    if (!stateFile) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      state.fired = parsed?.fired && typeof parsed.fired === 'object' ? { ...parsed.fired } : {};
      state.lastStartedAt = typeof parsed?.lastStartedAt === 'string' ? parsed.lastStartedAt : null;
      state.lastRunId = typeof parsed?.lastRunId === 'string' ? parsed.lastRunId : null;
    } catch {
      /* 没有或坏了都当第一次跑 */
    }
  }

  /** 落盘。失败只告警：它只是防重复用的，不是真相源。 */
  function saveState() {
    if (!stateFile) return;
    try {
      fs.mkdirSync(path.dirname(stateFile), { recursive: true });
      const tmp = `${stateFile}.${process.pid}.tmp`;
      fs.writeFileSync(
        tmp,
        `${JSON.stringify({ ...state, updatedAt: clock().toISOString() }, null, 2)}\n`,
        'utf8',
      );
      fs.renameSync(tmp, stateFile);
    } catch (cause) {
      logger.warn(`定时巡检状态落盘失败：${cause instanceof Error ? cause.message : cause}`);
    }
  }

  /** 只留今天与昨天的记账，别让文件无限长。 */
  function pruneFired(todayKey) {
    const cutoff = new Date(Date.parse(`${todayKey}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    for (const key of Object.keys(state.fired)) {
      if (key.slice(0, 10) < cutoff) delete state.fired[key];
    }
  }

  /** 当前配置。**每次都从 settings 现读**，所以改完设置不用重启。 */
  function config() {
    const raw = settings.autoPatrol && typeof settings.autoPatrol === 'object' ? settings.autoPatrol : {};
    return {
      enabled: raw.enabled === true,
      times: normalizeTimes(raw.times),
    };
  }

  /**
   * 现在该跑哪个时刻？不该跑返回 null。
   * @param {Date} now - 当前时刻。
   * @param {object} cfg - 配置。
   * @returns {{slot: string, key: string, lateMinutes: number}|null} 该跑的时刻。
   */
  function dueSlot(now, cfg) {
    const { dateKey, minutes } = zonedParts(now, settings.timezone);
    for (const slot of cfg.times) {
      const slotMinutes = parseClock(slot);
      if (slotMinutes === null) continue;
      const late = minutes - slotMinutes;
      if (late < 0 || late > graceMinutes) continue;
      const key = `${dateKey} ${slot}`;
      if (state.fired[key]) continue;
      return { slot, key, lateMinutes: late };
    }
    return null;
  }

  /**
   * 这一拍该不该跑；不该跑就给出原因。
   * @param {Date} [now] - 当前时刻（测试注入）。
   * @returns {{run: boolean, reason: string|null, slot: string|null, cfg: object}} 判定。
   */
  function decide(now = clock()) {
    const cfg = config();
    if (!cfg.enabled) return { run: false, reason: 'disabled', slot: null, cfg };
    if (cfg.times.length === 0) return { run: false, reason: 'no-times', slot: null, cfg };
    const due = dueSlot(now, cfg);
    if (!due) return { run: false, reason: 'not-due', slot: null, cfg };
    if (patrol.snapshot().running) return { run: false, reason: 'busy', slot: due.slot, cfg };
    return { run: true, reason: null, slot: due.slot, cfg };
  }

  /** 心跳：判定 → 到点就跑。 */
  function tick() {
    const now = clock();
    const cfg = config();
    if (!cfg.enabled || cfg.times.length === 0) return;

    let due;
    try {
      due = dueSlot(now, cfg);
    } catch (cause) {
      logger.warn(`定时巡检判定失败：${cause instanceof Error ? cause.message : cause}`);
      return;
    }
    if (!due) return;

    // **先记账再启动**：这一次巡检到此为止，无论跑不跑得成。
    // 错过就是错过 —— 不补跑、不堆积，也免得启动失败变成每分钟重试的热循环。
    state.fired[due.key] = now.toISOString();
    pruneFired(zonedParts(now, settings.timezone).dateKey);
    saveState();

    if (patrol.snapshot().running) {
      const runningId = patrol.snapshot().run?.id ?? null;
      logger.info(`定时巡检 ${due.slot}：上一次（${runningId ?? '未知'}）还在跑，跳过这一次`);
      audit?.append({
        kind: 'patrol',
        name: 'auto-skip',
        ok: true,
        detail: { slot: due.slot, reason: 'busy', runningId },
      });
      return;
    }

    try {
      // 只覆盖这两项，其余（渠道 / 每店条数 / 最多几家）沿用巡逻设置 ——
      // 自动跑不该有另一套悄悄生效的参数。
      const run = patrol.start({ closeAfter: false, autoFillAmazon: true });
      state.lastStartedAt = now.toISOString();
      state.lastRunId = run.id;
      saveState();
      logger.info(`定时巡检 ${due.slot} 已启动 ${run.id}${due.lateMinutes > 0 ? `（晚了 ${due.lateMinutes} 分钟）` : ''}`);
      audit?.append({
        kind: 'patrol',
        name: 'auto-start',
        ok: true,
        detail: { runId: run.id, slot: due.slot, lateMinutes: due.lateMinutes },
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.warn(`定时巡检启动失败：${message}`);
      audit?.append({
        kind: 'patrol',
        name: 'auto-start',
        ok: false,
        errorKind: cause?.kind ?? 'error',
        detail: { slot: due.slot, message },
      });
    }
  }

  /**
   * 下一次巡检：今天还没跑过的、离现在最近的那一次；今天的都跑完了就是明天的第一次。
   * @param {Date} now - 当前时刻。
   * @param {object} cfg - 配置。
   * @returns {{slot: string, at: Date}|null} 下一次。
   */
  function nextSlot(now, cfg) {
    if (cfg.times.length === 0) return null;
    const { dateKey, minutes } = zonedParts(now, settings.timezone);
    let best = null;
    for (const slot of cfg.times) {
      const slotMinutes = parseClock(slot);
      if (slotMinutes === null) continue;
      let delta = (slotMinutes - minutes + 1440) % 1440;
      if (delta === 0 && state.fired[`${dateKey} ${slot}`]) delta = 1440;
      if (!best || delta < best.delta) best = { slot, delta };
    }
    if (!best) return null;
    return { slot: best.slot, at: new Date(now.getTime() + best.delta * 60_000) };
  }

  /** 给界面的状态快照。 */
  function snapshot() {
    const now = clock();
    const cfg = config();
    const decision = decide(now);
    const { dateKey } = zonedParts(now, settings.timezone);
    const run = patrol.snapshot().run;
    const isAutoRun = Boolean(run && state.lastRunId && run.id === state.lastRunId);
    const next = nextSlot(now, cfg);
    return {
      enabled: cfg.enabled,
      // 心跳装没装上：关不关是策略，装不装是能力 —— 排查时这两件事得分得清。
      heartbeat: timer !== null,
      times: cfg.times,
      firedToday: cfg.times.filter((slot) => Boolean(state.fired[`${dateKey} ${slot}`])),
      now: now.toISOString(),
      today: dateKey,
      blockedBy: decision.reason,
      blockedText: decision.reason ? SKIP_TEXT[decision.reason] ?? decision.reason : null,
      wouldRun: decision.run,
      dueSlot: decision.slot,
      nextSlot: next ? next.slot : null,
      nextAt: next ? next.at.toISOString() : null,
      lastStartedAt: state.lastStartedAt,
      lastRunId: state.lastRunId,
      lastAutoRun:
        isAutoRun && run
          ? {
              id: run.id,
              status: run.status,
              phase: run.phase,
              startedAt: run.startedAt,
              finishedAt: run.finishedAt,
              draftsCreated: run.progress?.draftsCreated ?? 0,
            }
          : null,
    };
  }

  loadState();

  return {
    /** 装上心跳。重复调用无副作用。 */
    start() {
      if (timer) return;
      timer = setInterval(tick, tickMs);
      timer.unref?.();
      logger.info(`定时巡检心跳已启动（每 ${Math.round(tickMs / 1000)} 秒判定一次）`);
      // 挂载时先判一次：DSH 正好在巡检时刻附近重启时，不用白等一分钟。
      tick();
    },
    /** 摘掉心跳。 */
    stop() {
      if (!timer) return;
      clearInterval(timer);
      timer = null;
    },
    tick,
    decide,
    nextSlot,
    snapshot,
    config,
    get running() {
      return timer !== null;
    },
  };
}
