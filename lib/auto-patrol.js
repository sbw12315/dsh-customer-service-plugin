/**
 * 定时巡检（自动巡逻）—— **每个平台一张自己的时刻表**。
 *
 * 模型：平台 → 一张计划（开关 + 若干时刻 + 只跑哪几家店）。
 *   亚马逊  09:00 / 14:00 / 20:00，只跑「客服主号」那两家
 *   TikTok  10:00
 *   沃尔玛  关闭
 * 到点就为**这个平台**跑一次完整巡逻：扫描 → 逐店读会话 → 生成草稿 → 填入回复框 ——
 * 与人工点「重新扫描」是同一套代码，只是发起者换成了心跳。
 *
 * 为什么是「每平台一份」而不是一张全局时刻表：三个平台的班次根本不同（亚马逊 US 店盯得最紧、
 * 沃尔玛只有两家店、邮箱一天看一次就够）。一张全局表要么让所有平台陪跑，要么逼人去关整个功能。
 * 同理，**巡检店铺也是每平台各选**：亚马逊只巡客服主号、把不归客服管的店排除掉，
 * 不该顺手把别的平台也限定成同一批 id。
 *
 * 刻意划清的一条线：**这里不判定「DSH 是否空闲」**。插件跑在宿主进程里，看不到你别的
 * 会话有没有在用 DSH —— 拿一个不可靠的信号去决定「要不要自动开浏览器」，比不做更危险。
 * 所以口径只有「到没到这个点」，界面上也这么写。
 *
 * 五条硬约束：
 *   1. **一个平台的一个时刻，一天只跑一次**：跑过的时刻按「日期+时刻+平台」记账，重启也不会重复补跑。
 *   2. **永不并发**：上一次巡逻还在跑，这一拍到点的就跳过（不排队、不打断、不叠加）。
 *   3. **同一拍可以合并**：两个平台都到点时合成**一次** run（渠道清单 + 各自的店铺清单），
 *      因为它们本来也只能串行跑，合成一次还省得第二个平台被「忙」白白挤掉。
 *   4. **永不关浏览器**：closeAfter 强制 false —— 草稿正躺在回复框里等人核对。
 *   5. **默认关闭**：无人值守会自己打开店铺浏览器，这件事必须由人显式打开。
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

/** 每个平台的出厂时刻。只是界面上的初始值：不点保存不会落盘，也不会自己跑起来。 */
export const DEFAULT_TIMES = Object.freeze(['09:00', '14:00', '20:00']);

/**
 * 出厂设置：**全局默认计划**（关闭、三档时刻）+ 一张平台计划都没有。
 *
 * 全局默认计划是从旧版（一张全局时刻表）原样继承下来的：没有单独设置过的平台沿用它。
 * 这么做是为了升级时不悄悄改变行为 —— 老 settings.json 里那个 enabled / times
 * 升级后仍然对每个平台生效，谁要单独改，去自己那块面板上保存一次即可。
 */
export const AUTO_PATROL_DEFAULTS = Object.freeze({
  enabled: false,
  times: DEFAULT_TIMES,
  channels: Object.freeze({}),
});

/** 一次巡检没跑成的原因 → 给人看的一句话。 */
const SKIP_TEXT = Object.freeze({
  disabled: '未启用',
  'no-times': '还没添加巡检时刻',
  'not-due': '还没到巡检时间',
  busy: '上一次巡逻还在跑',
  'channel-disabled': '该渠道未启用',
});

/** 每张计划最多存多少个时刻 / 多少个店铺 id，别让手写的 settings.json 把文件撑爆。 */
const MAX_TIMES = 48;
const MAX_STORE_IDS = 200;
const MAX_CHANNELS = 30;

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
  return out.slice(0, MAX_TIMES);
}

/**
 * 把「这个平台只巡检哪几家店」收敛成 id 数组。
 *
 * **空数组是有意义的**：它表示「不限定，这个渠道全部目标都要」——
 * 和界面上勾选框的口径一致（全勾或不勾都按全都要处理）。
 * @param {unknown} value - 数组，或空格/逗号/分号分隔的字符串。
 * @returns {string[]} 店铺 / 邮箱 id；最多 200 个。
 */
export function normalizeStoreIds(value) {
  const parts = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/[\s,;]+/)
      : [];
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    const id = String(part ?? '').trim();
    if (!id) continue;
    // 大小写不敏感去重：紫鸟的店铺 id 是数字，邮箱地址则实测写错过大小写。
    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out.slice(0, MAX_STORE_IDS);
}

/**
 * 把任意输入收敛成「平台 → 计划」的映射。
 * @param {unknown} value - `{ [channelId]: { enabled, times, storeIds } }`。
 * @returns {Record<string, {enabled: boolean, times: string[], storeIds: string[]}>} 计划表。
 */
export function normalizeChannelPlans(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = {};
  let count = 0;
  for (const [key, raw] of Object.entries(source)) {
    const id = String(key).trim();
    if (!id || count >= MAX_CHANNELS) continue;
    const plan = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    out[id] = {
      enabled: plan.enabled === true,
      // 时刻缺省 = 空表（= 一次都不跑），而不是悄悄塞回出厂三档：
      // 「这个平台有自己的一份计划」这句话本身就意味着它不再继承全局默认。
      times: normalizeTimes(plan.times),
      storeIds: normalizeStoreIds(plan.storeIds),
    };
    count += 1;
  }
  return out;
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
 * @param {{settings: object, patrol: object, channels?: Function, logger?: object, clock?: () => Date, audit?: object, stateFile?: string, tickMs?: number, graceMinutes?: number}} options - 依赖。
 *   `settings` / `patrol` 都是**活引用**：改完设置立即生效，不需要重建调度器。
 *   `channels` 每次判定时现调，返回 `[{id, label, enabled}]`（关掉的渠道也要在，界面要显示它）。
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
  const listChannels = typeof options.channels === 'function' ? options.channels : null;

  let timer = null;
  const state = { fired: {}, lastStartedAt: null, lastRunId: null, lastChannels: [] };

  /** 读上次的记账：重启后不能把今天已经跑过的时刻又跑一遍。 */
  function loadState() {
    if (!stateFile) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      state.fired = parsed?.fired && typeof parsed.fired === 'object' ? { ...parsed.fired } : {};
      state.lastStartedAt = typeof parsed?.lastStartedAt === 'string' ? parsed.lastStartedAt : null;
      state.lastRunId = typeof parsed?.lastRunId === 'string' ? parsed.lastRunId : null;
      state.lastChannels = Array.isArray(parsed?.lastChannels)
        ? parsed.lastChannels.map((id) => String(id))
        : [];
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

  /** 当前的原始设置（自动巡检那一块）。 */
  function rawConfig() {
    return settings.autoPatrol && typeof settings.autoPatrol === 'object' ? settings.autoPatrol : {};
  }

  /**
   * 平台清单。**每次判定现读**：渠道的启用状态会随设置变，
   * 捕获一次会让「刚在设置里打开的邮箱渠道」永远不参与巡检。
   * @returns {Array<{id: string, label: string, enabled: boolean}>} 渠道。
   */
  function channelEntries() {
    const raw = rawConfig();
    let listed = null;
    if (listChannels) {
      try {
        const value = listChannels();
        if (Array.isArray(value) && value.length > 0) listed = value;
      } catch (cause) {
        logger.warn(`定时巡检取渠道清单失败：${cause instanceof Error ? cause.message : cause}`);
      }
    }
    // 没有渠道访问器（或它这会儿给不出东西）时退回「设置里出现过哪些平台」，
    // 这样纯设置驱动的调用方（测试、旧宿主）也能跑，不至于整个功能静默失效。
    const source = listed ?? Object.keys(raw.channels && typeof raw.channels === 'object' ? raw.channels : {});
    const seen = new Set();
    const out = [];
    for (const entry of source) {
      const id = String(typeof entry === 'string' ? entry : entry?.id ?? '').trim();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push({
        id,
        label: String((typeof entry === 'string' ? null : entry?.label) ?? id),
        enabled: typeof entry === 'string' ? true : entry?.enabled !== false,
      });
    }
    return out;
  }

  /**
   * 当前每个平台的**生效**计划：有自己那份就用自己那份，没有就沿用全局默认计划。
   *
   * 每次都从 settings 现读，所以改完设置不用重启 —— 界面上「保存」之后下一拍就是新的。
   * @returns {Record<string, object>} 平台 id → 计划（含 configured / channelEnabled）。
   */
  function config() {
    const raw = rawConfig();
    const own = raw.channels && typeof raw.channels === 'object' ? raw.channels : {};
    const global = {
      enabled: raw.enabled === true,
      times: normalizeTimes(raw.times),
      // 全局默认计划不限定店铺：旧版那一张表里本来就没有「跑哪几家店」这个概念。
      storeIds: [],
    };
    const plans = {};
    for (const entry of channelEntries()) {
      const mine = own[entry.id];
      const plan = mine
        ? {
            enabled: mine.enabled === true,
            times: normalizeTimes(mine.times),
            storeIds: normalizeStoreIds(mine.storeIds),
          }
        : global;
      plans[entry.id] = {
        id: entry.id,
        label: entry.label,
        // 适配器本身关着（比如飞书邮箱渠道没启用）：这张计划不变，但跑不了。
        channelEnabled: entry.enabled,
        configured: Boolean(mine),
        enabled: plan.enabled,
        times: plan.times,
        storeIds: plan.storeIds,
      };
    }
    return plans;
  }

  /** 记账键：日期 + 时刻 + 平台。三个平台的同一时刻各记各的。 */
  function firedKey(dateKey, slot, channelId) {
    return `${dateKey} ${slot}#${channelId}`;
  }

  /**
   * 这个时刻是不是今天已经跑过了。
   *
   * 也认旧版（v0.10 及以前）只有 `日期 时刻`、没有平台后缀的键：升级当天不该把
   * 已经跑过的 09:00 再跑一遍 —— 那次跑的是全部渠道，本来就覆盖了每个平台。
   */
  function isFired(dateKey, slot, channelId) {
    if (state.fired[firedKey(dateKey, slot, channelId)]) return true;
    return Boolean(state.fired[`${dateKey} ${slot}`]);
  }

  /**
   * 这个平台现在该跑哪个时刻？不该跑返回 null。
   * @param {Date} now - 当前时刻。
   * @param {object} plan - 一份计划。
   * @returns {{slot: string, key: string, lateMinutes: number}|null} 该跑的时刻。
   */
  function dueSlot(now, plan) {
    const { dateKey, minutes } = zonedParts(now, settings.timezone);
    for (const slot of plan.times) {
      const slotMinutes = parseClock(slot);
      if (slotMinutes === null) continue;
      const late = minutes - slotMinutes;
      if (late < 0 || late > graceMinutes) continue;
      if (isFired(dateKey, slot, plan.id)) continue;
      return { slot, key: firedKey(dateKey, slot, plan.id), lateMinutes: late };
    }
    return null;
  }

  /**
   * 这一拍该不该跑；不该跑就给出原因（**按平台**判）。
   * @param {Date} now - 当前时刻。
   * @param {object} plan - 一份计划。
   * @param {boolean} [running] - 当前是否有巡逻在跑。
   * @returns {{run: boolean, reason: string|null, slot: string|null}} 判定。
   */
  function decideFor(now, plan, running = patrol.snapshot().running) {
    if (!plan.channelEnabled) return { run: false, reason: 'channel-disabled', slot: null };
    if (!plan.enabled) return { run: false, reason: 'disabled', slot: null };
    if (plan.times.length === 0) return { run: false, reason: 'no-times', slot: null };
    const due = dueSlot(now, plan);
    if (!due) return { run: false, reason: 'not-due', slot: null };
    if (running) return { run: false, reason: 'busy', slot: due.slot };
    return { run: true, reason: null, slot: due.slot };
  }

  /**
   * 全部平台合起来看：这一拍有没有该跑的。
   * @param {Date} [now] - 当前时刻（测试注入）。
   * @returns {{run: boolean, reason: string|null, slot: string|null, channels: string[], plans: Array<object>}} 判定。
   */
  function decide(now = clock()) {
    const plans = Object.values(config());
    const running = patrol.snapshot().running;
    const results = plans.map((plan) => ({ id: plan.id, ...decideFor(now, plan, running) }));
    const due = results.filter((entry) => entry.run);
    if (due.length > 0) {
      return { run: true, reason: null, slot: due[0].slot, channels: due.map((entry) => entry.id), plans: results };
    }
    // 汇总原因按「信息量」排：先说「差点就要跑但被占着」，最后才是「整个功能没开」。
    const pick =
      results.find((entry) => entry.reason === 'busy') ??
      results.find((entry) => entry.reason === 'no-times') ??
      results.find((entry) => entry.reason === 'not-due') ??
      results.find((entry) => entry.reason === 'channel-disabled') ??
      results.find((entry) => entry.reason === 'disabled') ??
      null;
    return { run: false, reason: pick?.reason ?? 'disabled', slot: null, channels: [], plans: results };
  }

  /** 心跳：判定 → 到点就跑（同一拍到点的平台合并成一次）。 */
  function tick() {
    const now = clock();
    const plans = Object.values(config());

    let due;
    try {
      due = [];
      for (const plan of plans) {
        if (!plan.channelEnabled || !plan.enabled || plan.times.length === 0) continue;
        const slot = dueSlot(now, plan);
        if (slot) due.push({ plan, ...slot });
      }
    } catch (cause) {
      logger.warn(`定时巡检判定失败：${cause instanceof Error ? cause.message : cause}`);
      return;
    }
    if (due.length === 0) return;

    // **先记账再启动**：这一次巡检到此为止，无论跑不跑得成。
    // 错过就是错过 —— 不补跑、不堆积，也免得启动失败变成每分钟重试的热循环。
    for (const item of due) state.fired[item.key] = now.toISOString();
    pruneFired(zonedParts(now, settings.timezone).dateKey);
    saveState();

    const slots = Object.fromEntries(due.map((item) => [item.plan.id, item.slot]));
    const channels = due.map((item) => item.plan.id);
    const maxLate = Math.max(...due.map((item) => item.lateMinutes));
    if (patrol.snapshot().running) {
      const runningId = patrol.snapshot().run?.id ?? null;
      for (const item of due) {
        logger.info(`定时巡检 ${item.plan.label} ${item.slot}：上一次（${runningId ?? '未知'}）还在跑，跳过这一次`);
        audit?.append({
          kind: 'patrol',
          name: 'auto-skip',
          ok: true,
          detail: { channel: item.plan.id, slot: item.slot, reason: 'busy', runningId },
        });
      }
      return;
    }

    try {
      // 只覆盖这几项，其余（每店条数 / 最多几家）沿用巡逻设置 ——
      // 自动跑不该有另一套悄悄生效的参数。
      //
      // sourceIdsByChannel：每个平台各带一份自己的店铺清单。**空数组是有意义的**
      // （= 这个平台全部目标），所以不能压成一个全局 storeIds ——
      // 那会让「亚马逊只巡 2 家」顺手把「沃尔玛全部」也砍成同一批 id。
      const run = patrol.start({
        channels,
        sourceIdsByChannel: Object.fromEntries(due.map((item) => [item.plan.id, item.plan.storeIds])),
        closeAfter: false,
        autoFillAmazon: true,
      });
      state.lastStartedAt = now.toISOString();
      state.lastRunId = run.id;
      state.lastChannels = channels;
      saveState();
      logger.info(
        `定时巡检已启动 ${run.id}：${channels.join('、')}${maxLate > 0 ? `（晚了 ${maxLate} 分钟）` : ''}`,
      );
      audit?.append({
        kind: 'patrol',
        name: 'auto-start',
        ok: true,
        detail: { runId: run.id, channels, slots, lateMinutes: maxLate },
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.warn(`定时巡检启动失败：${message}`);
      audit?.append({
        kind: 'patrol',
        name: 'auto-start',
        ok: false,
        errorKind: cause?.kind ?? 'error',
        detail: { channels, slots, message },
      });
    }
  }

  /**
   * 某个平台下一次巡检：今天还没跑过的、离现在最近的那一次；今天的都跑完了就是明天的第一次。
   * @param {Date} now - 当前时刻。
   * @param {object} plan - 一份计划（需要 id 与 times）。
   * @returns {{slot: string, at: Date}|null} 下一次。
   */
  function nextSlot(now, plan) {
    if (!plan || !Array.isArray(plan.times) || plan.times.length === 0) return null;
    const { dateKey, minutes } = zonedParts(now, settings.timezone);
    let best = null;
    for (const slot of plan.times) {
      const slotMinutes = parseClock(slot);
      if (slotMinutes === null) continue;
      let delta = (slotMinutes - minutes + 1440) % 1440;
      if (delta === 0 && isFired(dateKey, slot, plan.id)) delta = 1440;
      if (!best || delta < best.delta) best = { slot, delta };
    }
    if (!best) return null;
    return { slot: best.slot, at: new Date(now.getTime() + best.delta * 60_000) };
  }

  /** 给界面的状态快照：**按平台**各给一份，界面把每个平台那块画在自己的平台上。 */
  function snapshot() {
    const now = clock();
    const plans = config();
    const { dateKey } = zonedParts(now, settings.timezone);
    const live = patrol.snapshot();
    const running = Boolean(live.running);
    const run = live.run;
    const isAutoRun = Boolean(run && state.lastRunId && run.id === state.lastRunId);
    const channels = {};
    let enabledCount = 0;
    let nextBest = null;
    for (const plan of Object.values(plans)) {
      const decision = decideFor(now, plan, running);
      const mine = isAutoRun && state.lastChannels.includes(plan.id);
      // 「会跑」= 开关开着 **且** 渠道启用 **且** 有时刻表：差一样都一步都不会动。
      // 「下次几点」只对会跑的平台有意义 —— 否则那个最早的时刻会落在某个关着的平台上，
      // 大按钮下面就会写着「下次 09:00」，而那个平台根本没开。
      const armed = plan.enabled && plan.channelEnabled && plan.times.length > 0;
      const next = armed ? nextSlot(now, plan) : null;
      if (armed) enabledCount += 1;
      if (next && (!nextBest || next.at < nextBest.at)) nextBest = { ...next, id: plan.id, label: plan.label };
      channels[plan.id] = {
        id: plan.id,
        label: plan.label,
        channelEnabled: plan.channelEnabled,
        // false = 还没给这个平台单独设置过，现在沿用的是全局默认计划（界面要标出来，
        // 否则人会以为「我明明没设过，它怎么自己在跑」）。
        configured: plan.configured,
        enabled: plan.enabled,
        times: plan.times,
        storeIds: plan.storeIds,
        firedToday: plan.times.filter((slot) => isFired(dateKey, slot, plan.id)),
        blockedBy: decision.reason,
        blockedText: decision.reason ? SKIP_TEXT[decision.reason] ?? decision.reason : null,
        wouldRun: decision.run,
        dueSlot: decision.slot,
        nextSlot: next ? next.slot : null,
        nextAt: next ? next.at.toISOString() : null,
        // 这个平台是不是**正被**这次自动巡逻跑着（人工点的那次不算）。
        runningNow: running && mine,
        lastAutoRun: mine && run
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
    return {
      // 心跳装没装上：关不关是策略，装不装是能力 —— 排查时这两件事得分得清。
      heartbeat: timer !== null,
      now: now.toISOString(),
      today: dateKey,
      enabledCount,
      channels,
      // 全部平台里最早的那一次：大按钮下面那行状态用它。
      nextSlot: nextBest ? nextBest.slot : null,
      nextAt: nextBest ? nextBest.at.toISOString() : null,
      nextChannel: nextBest ? nextBest.id : null,
      nextChannelLabel: nextBest ? nextBest.label : null,
      lastStartedAt: state.lastStartedAt,
      lastRunId: state.lastRunId,
      lastChannels: [...state.lastChannels],
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
