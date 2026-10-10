/**
 * 工作台 · 巡逻页：一键把全部亚马逊店铺的客服页面过一遍并生成草稿。
 *
 * 这一页就是「一键点按模式」的落点：
 *   1. 顶部一个大按钮 —— 巡逻全部 Amazon 店铺 → 生成草稿，并默认直接填进浏览器回复框；
 *   2. 跑的过程中每 3 秒拉一次 /api/patrol，画进度与每店结果；
 *   3. 下面是草稿库，按店铺/意图/状态筛，点开看正文、复制、或再手动填一次回复框。
 *   4. 每个渠道右边还有「重新扫描」—— 只巡逻这一个渠道。它跑完**不关闭浏览器**：
 *      草稿正躺在回复框里，就是要留在那儿给工作人员核对。
 *
 * 页面上没有任何「发送」按钮 —— 这是插件的硬约束，不是遗漏。
 */

import { del, get, patch, post, toQuery } from './api.js';
import { badge, button, clear, copy, input, node, panel, select, toast } from './dom.js';
import { DASH, dateTime, num } from './format.js';

const STATUS_LABEL = { draft: '草稿', approved: '已批准', filled: '已填入回复框', discarded: '已丢弃' };
const STATUS_TONE = { draft: 'idle', approved: 'ok', filled: 'warn', discarded: 'idle' };
const STORE_TONE = { ok: 'ok', failed: 'error', running: 'warn' };

const POLL_MS = 3000;

const state = {
  meta: null,
  patrol: null,
  drafts: null,
  // platform 留空 = 全部渠道；storeId 留空 = 全部店铺/邮箱。
  filters: { status: 'all', platform: '', intent: '', storeId: '', needsHuman: false, q: '' },
  options: { maxStores: 0, maxPerStore: 50, closeAfter: false },
  selectedStores: null,
  // 定时巡检：页面上的「本地草稿」，从 /patrol 的 autoPatrol 初始化一次，点保存才回写。
  // 刻意不在每次自动刷新时覆盖 —— 外壳每 60 秒刷一次，覆盖会把没保存的编辑冲掉。
  autoTimes: null,
  autoEnabled: false,
  scanning: false,
  timer: null,
  drawer: null,
};

/* ── 「本次巡逻新增」的标记色 ─────────────────────────────────────────── */

/**
 * 一次巡逻新出的草稿用**同一种**颜色标出来，下一次巡逻换一种 —— 既能把新老草稿一眼
 * 分开，连着跑两次也能靠颜色认出哪批是哪批。
 *
 * 颜色只由 run id 决定（不是随机，也不是「现在排第几个」），所以刷新多少次、换不换
 * 筛选条件，同一批草稿的颜色都不会跳。
 */
const NEW_RUN_COLORS = 6;

/** run id → 稳定的调色板下标。 */
function newRunColor(runId) {
  const text = String(runId ?? '');
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 1000003;
  }
  return hash % NEW_RUN_COLORS;
}

/**
 * 最近一次巡逻 —— 判断「哪批草稿是这次新生成的」全靠它。
 *
 * 服务端内存里没有 run（刚重启过 DSH）时会从 run/patrol-last.json 兜底，
 * 所以高亮不会因为一次重启就消失。
 * @returns {{id: string, color: number, created: number, finishedAt: string|null}|null} 信息。
 */
function lastRunInfo() {
  const run = state.patrol?.lastRun;
  if (!run || !run.id) return null;
  return {
    id: run.id,
    color: newRunColor(run.id),
    created: Number.isFinite(run.draftsCreated) ? run.draftsCreated : 0,
    finishedAt: typeof run.finishedAt === 'string' && run.finishedAt ? run.finishedAt : null,
  };
}

/** 图例：说明彩色行是什么意思。 */
function newRunLegend(recent) {
  const when = recent.finishedAt ? `（${dateTime(recent.finishedAt)}）` : '';
  return node('div', { class: `legend-new legend-new-${recent.color}` }, [
    node('i', {}),
    node('span', { text: `最近一次巡逻新增 ${num(recent.created)} 条${when}，就是这一行颜色` }),
  ]);
}

/** 意图标签：优先用服务端给的，保证前后端只有一处定义。 */
function intentLabel(key) {
  return state.meta?.drafts?.intentLabels?.[key] ?? key ?? DASH;
}

/** 取元数据。 */
async function loadMeta() {
  if (state.meta) return state.meta;
  state.meta = await get('/meta');
  state.options = { ...state.options, ...(state.meta.patrol?.defaults ?? {}) };
  return state.meta;
}

/** 拉巡逻状态。 */
async function refreshPatrol() {
  state.patrol = await get('/patrol');
  renderSources();
  renderAutoPatrol();
  renderProgress();
  renderOneClick();
}

/** 拉草稿。 */
async function refreshDrafts() {
  state.drafts = await get('/drafts', toQuery({ ...state.filters, limit: 200 }));
  renderDrafts();
}

/** 整体刷新。 */
async function refresh() {
  await loadMeta();
  // 先巡逻再草稿：草稿筛选的下拉要用到渠道表（渠道名）与扫描结果。
  // 之前两个并发跑，草稿先渲染时渠道还没到，下拉就是空的。
  await refreshPatrol();
  await refreshDrafts();
}

/* ── 一键巡逻 ─────────────────────────────────────────────────────────── */

/** 当前选中的店铺 id（没勾任何一家 = 全部）。 */
function selectedStoreIds() {
  const boxes = Array.from(document.querySelectorAll('input[name="patrol-source"]:checked'));
  const all = Array.from(document.querySelectorAll('input[name="patrol-source"]'));
  if (all.length > 0 && boxes.length === all.length) return [];
  return boxes.map((box) => box.value);
}

/**
 * 某个渠道下当前勾选的店铺 id（全勾 = 空数组 = 全部）。
 *
 * 为什么要按渠道算：sourceIds 是**全局**筛选，拿别的渠道的勾选去筛这个渠道，结果会是
 * 0 个目标 —— 比如只勾了亚马逊的店，再点飞书邮箱的「重新扫描」，邮箱一个都不会跑。
 * @param {string} channelId - 渠道 id。
 * @returns {string[]} 店铺 id；空数组表示这个渠道全部都要。
 */
function selectedStoreIdsOf(channelId) {
  const ids = (state.patrol?.sources?.[channelId]?.items ?? []).map((source) => source.storeId);
  const chosen = ids.filter((id) => state.selectedStores?.has(id));
  return chosen.length === ids.length ? [] : chosen;
}

/** 启动一次巡逻（参数由调用方拼好）。 */
async function startPatrolWith(body, message) {
  try {
    await post('/patrol', body);
    toast(message);
    await refreshPatrol();
    startPolling();
  } catch (cause) {
    toast(`启动失败：${cause.message}`, 'error');
  }
}

/** 一键巡逻：全部渠道、按勾选的目标。 */
async function startPatrol() {
  await startPatrolWith({ ...state.options, storeIds: selectedStoreIds() }, '巡逻已启动，正在依次打开店铺…');
}

/**
 * 只巡逻一个渠道：扫描 → 逐店读取 → 生成草稿 → 写进紫鸟浏览器的回复框。
 *
 * 与「一键巡逻」的区别只有范围。**closeAfter 强制为 false**，不看界面上那个勾选：
 * 草稿正躺在浏览器输入框里等着人工核对，跑完把窗口关掉等于白填一场 ——
 * 「写入后不关浏览器、留在那里给工作人员检查」正是这个按钮存在的意义。
 * @param {object} channel - 渠道（含 id / label / enabled）。
 * @returns {Promise<void>} 完成。
 */
async function runChannelPatrol(channel) {
  await startPatrolWith(
    {
      ...state.options,
      channels: [channel.id],
      storeIds: selectedStoreIdsOf(channel.id),
      closeAfter: false,
    },
    `已开始巡逻${channel.label}：跑完浏览器会留在原处，等你核对`,
  );
}

/** 停止巡逻。 */
async function stopPatrol() {
  try {
    await post('/patrol/stop', {});
    toast('已请求停止，跑完当前这家店就收工');
    await refreshPatrol();
  } catch (cause) {
    toast(`停止失败：${cause.message}`, 'error');
  }
}

/** 正在跑时每 3 秒刷新一次；页面切走（节点没了）自动停表。 */
function startPolling() {
  clearInterval(state.timer);
  state.timer = setInterval(async () => {
    if (!document.getElementById('patrol-progress')) {
      clearInterval(state.timer);
      state.timer = null;
      return;
    }
    if (document.visibilityState !== 'visible') return;
    try {
      await refreshPatrol();
      if (!state.patrol?.running) {
        clearInterval(state.timer);
        state.timer = null;
        await refreshDrafts();
      }
    } catch {
      /* 单次失败不打断轮询 */
    }
  }, POLL_MS);
}

/** 选项控件行。 */
function optionRow() {
  const numberField = (label, key, min, max, hint) => {
    const el = input(String(state.options[key] ?? ''), '', (value) => {
      const parsed = Number.parseInt(value, 10);
      state.options[key] = Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : state.options[key];
    }, { type: 'number' });
    el.min = String(min);
    el.max = String(max);
    return node('label', { class: 'field' }, [
      node('span', { class: 'field-label', text: label }),
      el,
      hint ? node('span', { class: 'field-hint', text: hint }) : null,
    ]);
  };
  const checkbox = (label, key, hint) =>
    node('label', { class: 'field field-check' }, [
      node('input', {
        type: 'checkbox',
        checked: Boolean(state.options[key]),
        onchange: (event) => {
          state.options[key] = event.target.checked;
        },
      }),
      node('span', { class: 'field-label', text: label }),
      hint ? node('span', { class: 'field-hint', text: hint }) : null,
    ]);

  return node('div', {}, [
    node('div', { class: 'field-row patrol-options' }, [
      numberField('最多扫几个目标', 'maxStores', 0, 500, '0 = 全部'),
      numberField('每个目标最多几条草稿', 'maxPerStore', 1, 50, '上限 50，也是默认值'),
      checkbox('跑完关闭店铺', 'closeAfter', '只影响亚马逊：会把已填入但还没发送的回复一起关掉'),
    ]),
    node('div', { class: 'field-row patrol-options' }, [
      checkbox('同时把邮件草稿写进飞书草稿箱', 'writeMailDrafts', '仍然只存草稿、不发送；相当于替你在飞书里点一遍「存草稿」'),
    ]),
    node('div', { class: 'field-row patrol-options' }, [
      node('span', {
        class: 'field-hint',
        text: '草稿生成后默认直接填进紫鸟浏览器里那条会话的回复框（只填不发送）：'
          + '浏览器始终可见，核对无误后你自己点发送。',
      }),
    ]),
  ]);
}

/**
 * 定时巡检的一句话状态（写在一键巡逻的大按钮下面）。
 *
 * 关闭时也要明说 —— 用到这一页时最该先确认的，就是「待会儿它会不会自己把浏览器打开」。
 * @param {object|null} auto - /api/patrol 里的 autoPatrol 快照。
 * @returns {string} 一句话。
 */
function autoPatrolLine(auto) {
  if (!auto) return '定时巡检：状态未知（后端可能还是旧版本，重启 DSH 后可见）';
  if (!auto.enabled) return '定时巡检：已关闭 —— 只在你手动点按钮时才会跑';
  if (!auto.times || auto.times.length === 0) {
    return '定时巡检：已启用，但还没添加巡检时刻 —— 现在不会自动跑';
  }
  const head = `定时巡检：每天 ${auto.times.length} 次（${auto.times.join(' / ')}）`;
  const now = auto.wouldRun ? `现在正在跑 ${auto.dueSlot} 这一次` : `当前不跑（${auto.blockedText}）`;
  const next = auto.nextAt ? `，下次 ${auto.nextSlot}（${dateTime(auto.nextAt)}）` : '';
  return `${head} · ${now}${next}`;
}

/** 时刻表在页面上是「本地草稿」：初始化一次，改完点保存才回写。 */
function ensureAutoTimes(auto) {
  if (state.autoTimes !== null) return;
  state.autoTimes = Array.isArray(auto?.times) ? [...auto.times] : [];
  state.autoEnabled = auto?.enabled === true;
}

/** 新加一行时挑一个还没被占用的时间，别让两行都默认同一个点。 */
function nextFreeTime(times) {
  const candidates = ['06:00', '09:00', '12:00', '14:00', '18:00', '20:00', '22:00'];
  return candidates.find((time) => !times.includes(time)) ?? '12:00';
}

/** 面板底部那行详细状态。 */
function autoStatusText(auto) {
  const parts = [auto.enabled ? '已启用' : '未启用'];
  if (auto.enabled) {
    parts.push(`今天 ${auto.times.length} 次，已跑 ${auto.firedToday?.length ?? 0} 次`);
    if (auto.nextAt) parts.push(`下次 ${auto.nextSlot}（${dateTime(auto.nextAt)}）`);
    parts.push(auto.wouldRun ? `现在就会跑（${auto.dueSlot}）` : `当前不跑：${auto.blockedText}`);
  }
  const last = auto.lastAutoRun;
  if (last) parts.push(`上次 ${dateTime(last.startedAt)} ${last.status}（新草稿 ${num(last.draftsCreated)}）`);
  else if (auto.lastStartedAt) parts.push(`上次启动 ${dateTime(auto.lastStartedAt)}`);
  return parts.join(' · ');
}

/** 保存巡检时刻表。 */
async function saveAutoPatrol() {
  try {
    const saved = await post('/settings', {
      autoPatrol: { enabled: state.autoEnabled, times: state.autoTimes.filter(Boolean) },
    });
    // 后端会去重 / 排序 / 丢掉非法项，以它返回的为准，免得界面和落盘的列表对不上。
    const times = saved?.settings?.autoPatrol?.times;
    if (Array.isArray(times)) state.autoTimes = [...times];
    toast('定时巡检已保存');
    await refreshPatrol();
  } catch (cause) {
    toast(`保存失败：${cause.message}`, 'error');
  }
}

/** 渲染「定时巡检」面板：开关 + 可增删的时刻表 + 状态。 */
function renderAutoPatrol() {
  const container = document.getElementById('patrol-auto');
  if (!container) return;
  clear(container);
  const auto = state.patrol?.autoPatrol;
  if (!auto) {
    container.appendChild(
      node('div', { class: 'muted', text: '状态未知：后端可能还是旧版本，重启 DSH 后可见。' }),
    );
    return;
  }
  ensureAutoTimes(auto);

  container.appendChild(
    node('div', { class: 'field-row patrol-options' }, [
      node('label', { class: 'field field-check' }, [
        node('input', {
          type: 'checkbox',
          checked: state.autoEnabled,
          onchange: (event) => {
            state.autoEnabled = event.target.checked;
          },
        }),
        node('span', { class: 'field-label', text: '启用定时巡检' }),
        node('span', {
          class: 'field-hint',
          text: '默认关闭。打开后到点会自己跑一遍完整巡逻（扫描 → 生成草稿 → 填入回复框，'
            + '仍然不发送）—— 无人值守会自己打开店铺浏览器，所以必须由你显式打开。改完记得点保存。',
        }),
      ]),
    ]),
  );

  container.appendChild(
    node('div', {
      class: 'muted',
      text: `巡检时刻（每天各跑一次，共 ${state.autoTimes.length} 次；上一轮没跑完就跳过，不会并发）`,
    }),
  );

  const rows = node('div', { class: 'auto-times' });
  if (state.autoTimes.length === 0) {
    rows.appendChild(node('div', { class: 'muted', text: '还没添加巡检时刻 —— 现在不会自动跑。' }));
  }
  state.autoTimes.forEach((time, index) => {
    rows.appendChild(
      node('div', { class: 'auto-time-row' }, [
        input(time, '', (value) => {
          state.autoTimes[index] = value;
        }, { type: 'time' }),
        button('删除', () => {
          state.autoTimes.splice(index, 1);
          renderAutoPatrol();
        }),
      ]),
    );
  });
  container.appendChild(rows);

  container.appendChild(
    node('div', { class: 'actions' }, [
      button('+ 添加一次巡检', () => {
        state.autoTimes.push(nextFreeTime(state.autoTimes));
        state.autoTimes.sort();
        renderAutoPatrol();
      }),
      button('保存巡检时刻表', () => saveAutoPatrol(), 'primary'),
    ]),
  );

  container.appendChild(node('div', { class: 'muted auto-status', text: autoStatusText(auto) }));
}

/** 大按钮区。 */
function renderOneClick() {
  const container = document.getElementById('patrol-action');
  if (!container) return;
  clear(container);
  const running = Boolean(state.patrol?.running);
  const run = state.patrol?.run;
  const scans = state.patrol?.sources ?? {};
  const total = Object.values(scans).reduce((sum, scan) => sum + (scan.items?.length ?? 0), 0);
  const breakdown = (state.patrol?.channels ?? [])
    .map((channel) => `${channel.label} ${scans[channel.id]?.items?.length ?? 0}`)
    .join(' · ');

  container.appendChild(
    node('div', { class: 'patrol-hero' }, [
      node('div', { class: 'patrol-hero-main' }, [
        node('button', {
          type: 'button',
          class: `btn btn-primary btn-xl${running ? ' is-busy' : ''}`,
          text: running ? '巡逻进行中…' : `一键巡逻：全部渠道（${num(total)} 个目标）`,
          disabled: running,
          onclick: () => startPatrol().catch((cause) => toast(cause.message, 'error')),
        }),
        node('div', { class: 'patrol-hero-hint muted' }, [
          node('span', {
            text: '依次打开每家亚马逊店铺的「买家与卖家消息服务 · 需要回复」，读取会话并生成英文草稿，'
              + '并默认直接填进紫鸟浏览器里那条会话的回复框。全程只读页面 + 只填不发送 —— 核对后你自己点发送。',
          }),
        ]),
      ]),
      running ? button('停止', () => stopPatrol().catch(() => {})) : null,
      run && !running
        ? node('div', { class: 'muted patrol-last' }, [
            node('span', { text: `上次巡逻：${dateTime(run.startedAt)} · ${run.status}` }),
          ])
        : null,
    ]),
  );
  // 自动巡逻会不会突然自己跑起来，是这一页最该先知道的事 —— 直接写在按钮下面。
  container.appendChild(
    node('div', { class: 'muted auto-patrol-line' }, [
      node('span', { text: autoPatrolLine(state.patrol?.autoPatrol) }),
    ]),
  );
  container.appendChild(optionRow());

  // 逐个渠道报扫描失败：渠道少，报清楚比汇总成一句有用。
  for (const channel of state.patrol?.channels ?? []) {
    const error = state.patrol?.sources?.[channel.id]?.error;
    if (!error) continue;
    container.appendChild(
      node('div', { class: 'banner banner-error' }, [
        node('strong', { text: `${channel.label} 读取失败：` }),
        node('span', { text: error.message }),
        error.hint ? node('div', { class: 'muted', text: error.hint }) : null,
      ]),
    );
  }
}

/* ── 店铺列表 ─────────────────────────────────────────────────────────── */

/**
 * 手动扫描可用店铺。
 *
 * 为什么需要它：店铺列表带 60 秒缓存（`store list` 要一两秒），而且**在紫鸟里新增店铺
 * 不会通知 DSH** —— 不主动扫的话，新店要等缓存过期甚至等下次重启才会出现。这是一个
 * 明确的用户动作，所以走 POST（带令牌）并强制跳过缓存。
 */
async function runScan(channelId) {
  state.scanning = true;
  renderSources();
  try {
    const result = await post('/patrol/scan', channelId ? { channels: [channelId] } : {});
    state.patrol = {
      ...(state.patrol ?? {}),
      sources: { ...(state.patrol?.sources ?? {}), ...result },
    };
    // 勾选集合跟着刷新：消失的去掉，新发现的默认勾上（扫出来多半就是为了巡逻它们）。
    const known = new Set();
    for (const scan of Object.values(state.patrol.sources)) {
      for (const source of scan.items ?? []) known.add(source.storeId);
    }
    const next = new Set([...(state.selectedStores ?? [])].filter((id) => known.has(id)));
    for (const scan of Object.values(result)) {
      for (const source of scan.added ?? []) next.add(source.storeId);
    }
    state.selectedStores = next;

    const bits = Object.entries(result).map(([id, scan]) => {
      const label = state.patrol.channels?.find((channel) => channel.id === id)?.label ?? id;
      let text = `${label} ${scan.items.length} 个目标`;
      if (scan.error) text += `（读取失败）`;
      else if (scan.added?.length) text += `，新增 ${scan.added.map((entry) => entry.storeName).join('、')}`;
      return text;
    });
    toast(bits.join('；'));
  } catch (cause) {
    toast(`扫描失败：${cause.message}`, 'error');
  } finally {
    state.scanning = false;
    renderSources();
    renderOneClick();
  }
}

/** 单个渠道的扫描提示：失败原因 / 新增移除 / 被跳过的目标。 */
function sourceScanNote(scan, channel) {
  if (scan.error) {
    return node('div', { class: 'banner banner-error' }, [
      node('strong', { text: `${channel.label} 读取失败：` }),
      node('span', { text: scan.error.message }),
      scan.error.hint ? node('div', { class: 'muted', text: scan.error.hint }) : null,
      node('div', { class: 'muted', text: '下面显示的是上一次成功扫描的结果，不是空列表。' }),
    ]);
  }
  const blocks = [];
  const parts = [];
  if (scan.added?.length) parts.push(`新增 ${scan.added.map((entry) => entry.storeName).join('、')}`);
  if (scan.removed?.length) parts.push(`已移除 ${scan.removed.map((entry) => entry.storeName).join('、')}`);
  if (!scan.checkedAt) {
    blocks.push(node('div', { class: 'muted', text: '还没扫描过。点「重新扫描」跑一遍（会生成草稿并写进浏览器），或点「仅刷新列表」只看目标。' }));
  } else if (parts.length) {
    blocks.push(node('div', { class: 'scan-diff', text: parts.join('；') }));
  }
  if (scan.skipped?.length) {
    blocks.push(
      node('details', { class: 'logbox' }, [
        node('summary', { text: `另有 ${scan.skipped.length} 个目标不会被巡逻` }),
        node('ul', { class: 'skip-list' }, scan.skipped.map((entry) =>
          node('li', { text: `${entry.storeName || entry.storeId} · ${entry.platformName} · ${entry.reason}` }),
        )),
      ]),
    );
  }
  return blocks.length ? node('div', { class: 'scan-note' }, blocks) : null;
}

/** 渲染每个渠道一块：标题 + 重新扫描 + 提示 + 目标勾选。 */
function renderSources() {
  const container = document.getElementById('patrol-sources');
  if (!container) return;
  clear(container);

  const channels = state.patrol?.channels ?? [];
  const scans = state.patrol?.sources ?? {};
  if (channels.length === 0) {
    container.appendChild(node('div', { class: 'muted', text: '没有已注册的巡逻渠道。' }));
    return;
  }

  // 第一次拿到列表时定下默认勾选。飞书邮箱只默认勾公共邮箱 ——
  // 顺手把个人收件箱也巡逻了，多半不是想要的；没启用的渠道更是整块跳过。
  if (state.selectedStores === null) {
    const defaults = new Set();
    for (const channel of channels) {
      if (channel.enabled === false) continue;
      for (const source of scans[channel.id]?.items ?? []) {
        if (channel.id === 'lark-mail' && source.isShared === false) continue;
        defaults.add(source.storeId);
      }
    }
    state.selectedStores = defaults;
  }

  for (const channel of channels) {
    const scan = scans[channel.id] ?? { items: [] };
    const list = scan.items ?? [];
    const off = channel.enabled === false;
    const busy = Boolean(state.patrol?.running);
    const block = node('div', { class: 'source-block' });

    block.appendChild(
      node('div', { class: 'sub-head' }, [
        node('h3', {
          text: off ? `${channel.label}（未启用）` : `${channel.label}（${list.length}）`,
        }),
        node('div', { class: 'sub-actions' }, [
          node('span', { class: 'muted', text: scan.checkedAt ? `上次扫描 ${dateTime(scan.checkedAt)}` : '尚未扫描' }),
          // 便宜的那个：紫鸟里新增/删了店铺时用它，只拉列表、不开浏览器、不生成草稿。
          node('button', {
            type: 'button',
            class: `btn btn-ghost${state.scanning ? ' is-busy' : ''}`,
            text: state.scanning ? '刷新中…' : '仅刷新列表',
            title: '只重新拉一次目标列表（不生成草稿、不打开浏览器）',
            disabled: state.scanning,
            onclick: () => runScan(channel.id).catch((cause) => toast(cause.message, 'error')),
          }),
          // 真干活的那个：扫描 + 生成草稿 + 直接写进浏览器回复框，跑完不关浏览器。
          node('button', {
            type: 'button',
            class: `btn btn-primary${busy ? ' is-busy' : ''}`,
            text: busy ? '巡逻进行中…' : '重新扫描',
            title: off
              ? '该渠道未启用：先在「设置」里打开'
              : '扫描 → 生成草稿 → 直接写进紫鸟浏览器的回复框；跑完不关闭浏览器，留给人工核对',
            disabled: busy || state.scanning || off,
            onclick: () => runChannelPatrol(channel).catch((cause) => toast(cause.message, 'error')),
          }),
        ]),
      ]),
    );

    const note = sourceScanNote(scan, channel);
    if (note) block.appendChild(note);

    if (list.length === 0) {
      block.appendChild(
        node('div', {
          class: 'muted',
          // 未启用不是错误，也不是「没有目标」：把原因和怎么打开直接写在这一行。
          text:
            channel.enabled === false
              ? scan.hint ?? `该渠道未启用：先在「设置」里接好 CLI，再手动打开。`
              : scan.error
                ? '看不到列表（原因见上）。'
                : `没有扫描到可巡逻的${channel.kind === 'mailbox' ? '邮箱' : '店铺'}。`,
        }),
      );
    } else {
      const run = state.patrol?.run;
      block.appendChild(
        node('div', { class: 'store-grid' }, list.map((source) => {
          const box = node('input', {
            type: 'checkbox',
            name: 'patrol-source',
            value: source.storeId,
            checked: state.selectedStores.has(source.storeId),
            onchange: (event) => {
              if (event.target.checked) state.selectedStores.add(source.storeId);
              else state.selectedStores.delete(source.storeId);
            },
          });
          const result = run?.sources?.find(
            (entry) => entry.storeId === source.storeId && entry.channel === channel.id,
          );
          const isNew = (scan.added ?? []).some((entry) => entry.storeId === source.storeId);
          return node('label', { class: 'store-chip' }, [
            box,
            node('span', { class: 'store-chip-name', text: source.storeName || source.storeId }),
            isNew ? badge('新', 'ok') : null,
            node('span', { class: 'muted', text: source.platformName }),
            result ? badge(`${result.drafts} 草稿`, STORE_TONE[result.status] ?? 'idle') : null,
          ]);
        })),
      );
    }
    container.appendChild(block);
  }
}

/* ── 进度 ─────────────────────────────────────────────────────────────── */

function renderProgress() {
  const container = document.getElementById('patrol-progress');
  if (!container) return;
  clear(container);
  const run = state.patrol?.run;
  if (!run) {
    container.appendChild(node('div', { class: 'muted', text: '还没有跑过巡逻。点上面的按钮开始。' }));
    return;
  }
  const progress = run.progress ?? {};
  const pct = progress.sourcesTotal > 0 ? Math.round((progress.sourcesDone / progress.sourcesTotal) * 100) : 0;

  container.appendChild(
    node('div', { class: 'kpi-row' }, [
      kpi('状态', run.status === 'running' ? '进行中' : run.status, run.status === 'running' ? 'warn' : run.status === 'done' ? 'ok' : 'idle'),
      kpi('当前阶段', run.phase ?? DASH),
      kpi('渠道', String(progress.channelsTotal ?? 0)),
      kpi('目标', `${progress.sourcesDone ?? 0}/${progress.sourcesTotal ?? 0}`),
      kpi('待回复', num(progress.conversationsSeen ?? 0)),
      kpi('新草稿', num(progress.draftsCreated ?? 0)),
      kpi('飞书草稿', num(progress.externalDrafts ?? 0)),
      kpi('已入队', num(progress.ticketsLinked ?? 0)),
      kpi('错误', num(progress.errors ?? 0), progress.errors > 0 ? 'error' : 'idle'),
    ]),
  );

  container.appendChild(
    node('div', { class: 'patrol-bar' }, [node('div', { class: 'patrol-bar-fill', style: `width:${pct}%` })]),
  );

  if (run.sources?.length) {
    const rows = run.sources.map((store) =>
      node('tr', {}, [
        node('td', { class: 'muted', text: store.channelLabel ?? store.channel ?? DASH }),
        node('td', { text: store.storeName || store.storeId }),
        node('td', {}, [badge(store.status, STORE_TONE[store.status] ?? 'idle')]),
        node('td', { text: String(store.conversations ?? 0) }),
        node('td', { text: String(store.drafts ?? 0) }),
        // 跳过的自动通知/系统群发：不静默丢掉，运营要能看出「不是漏扫」。
        node('td', {}, store.skipped
          ? [node('span', { class: 'muted', text: String(store.skipped), title: (store.skipSamples ?? []).map((s) => `${s.subject}：${s.reason}`).join('\n') })]
          : [node('span', { class: 'muted', text: DASH })]),
        node('td', { class: 'muted', text: store.durationMs ? `${Math.round(store.durationMs / 1000)}s` : DASH }),
        node('td', { class: store.error ? 'cell-overdue' : 'muted', text: store.error ?? DASH }),
      ]),
    );
    container.appendChild(
      node('div', { class: 'table-wrap' }, [
        node('table', { class: 'table' }, [
          node('thead', {}, [
            node('tr', {}, [
              node('th', { text: '渠道' }),
              node('th', { text: '目标' }),
              node('th', { text: '结果' }),
              node('th', { text: '待回复' }),
              node('th', { text: '草稿' }),
              node('th', { text: '已跳过' }),
              node('th', { text: '耗时' }),
              node('th', { text: '错误' }),
            ]),
          ]),
          node('tbody', {}, rows),
        ]),
      ]),
    );
  }

  const log = (run.log ?? []).slice(-30).reverse();
  if (log.length) {
    container.appendChild(
      node('details', { class: 'logbox' }, [
        node('summary', { text: `运行日志（${run.log.length} 条）` }),
        node('ol', { class: 'timeline' }, log.map((entry) =>
          node('li', {}, [
            node('span', { class: 'timeline-time', text: dateTime(entry.at) }),
            node('span', { class: `timeline-action ${entry.level === 'error' ? 'cell-overdue' : ''}`, text: entry.level }),
            node('span', { class: 'timeline-detail', text: entry.message }),
          ]),
        )),
      ]),
    );
  }
}

/** 一个 KPI 小卡。tone 用既有的 kpi-warn / kpi-error 约定，不另起一套。 */
function kpi(label, value, tone = 'idle') {
  const toneClass = tone === 'warn' || tone === 'error' ? ` kpi-${tone}` : '';
  return node('div', { class: `kpi${toneClass}` }, [
    node('span', { class: 'kpi-label', text: label }),
    node('span', { class: 'kpi-value', text: String(value) }),
  ]);
}

/* ── 草稿 ─────────────────────────────────────────────────────────────── */

/** 渠道展示名：优先用巡逻页已注册的渠道表。 */
function channelLabel(channelId) {
  return (state.patrol?.channels ?? []).find((channel) => channel.id === channelId)?.label ?? channelId;
}

/**
 * 按渠道分组的店铺/邮箱下拉。
 *
 * 选项来自草稿接口的 `facets`（基于**全部**草稿算），而不是当前这一页 —— 否则一按店铺
 * 筛完，下拉里就只剩那一个，等于换不了。
 * @param {string} value - 当前选中值。
 * @param {Function} onchange - 变更回调。
 * @returns {HTMLElement} select 元素。
 */
function draftFacets() {
  const facets = state.drafts?.facets?.stores;
  if (Array.isArray(facets)) return facets;
  // 宿主半还是旧版时没有 facets：退化到从当前这页推。缺点是筛完选项会跟着变少，
  // 但那也比「下拉里什么都没有」强 —— 重启 DSH 后自动用回服务端的完整清单。
  const map = new Map();
  for (const item of state.drafts?.items ?? []) {
    if (!item.storeId) continue;
    const key = `${item.platform}::${item.storeId}`;
    const found = map.get(key);
    if (found) found.total += 1;
    else map.set(key, { platform: item.platform, storeId: item.storeId, storeName: item.storeName || item.storeId, total: 1 });
  }
  return [...map.values()].sort((a, b) => a.storeName.localeCompare(b.storeName));
}

function storeSelect(value, onchange) {
  const facets = draftFacets();
  const el = node('select', { onchange: (event) => onchange(event.target.value) });
  el.appendChild(node('option', { value: '', text: '全部店铺 / 邮箱' }));
  const groups = new Map();
  for (const facet of facets) {
    if (!groups.has(facet.platform)) groups.set(facet.platform, []);
    groups.get(facet.platform).push(facet);
  }
  for (const [platform, list] of groups) {
    const group = node('optgroup', { label: `${channelLabel(platform)}（${list.length}）` });
    for (const facet of list) {
      group.appendChild(
        node('option', {
          value: facet.storeId,
          text: `${facet.storeName}（${facet.total}）`,
          selected: facet.storeId === value,
        }),
      );
    }
    el.appendChild(group);
  }
  el.value = value ?? '';
  return el;
}

function draftFilters() {
  const intents = state.meta?.drafts?.intents ?? [];
  const statuses = state.meta?.drafts?.statuses ?? [];
  // 渠道选项同样来自 facets（只看「确实有草稿的渠道」），避免选了空渠道一片空白。
  const platforms = [...new Set(draftFacets().map((facet) => facet.platform))];
  const set = (key) => (value) => {
    state.filters[key] = value;
    refreshDrafts().catch((cause) => toast(cause.message, 'error'));
  };
  const search = input(state.filters.q, '搜索买家 / 主题 / 订单号 / 正文', null);
  search.id = 'draft-q';
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    state.filters.q = search.value.trim();
    refreshDrafts().catch((cause) => toast(cause.message, 'error'));
  });

  return node('div', { class: 'filters' }, [
    select(
      [{ value: 'all', label: '全部状态' }, ...statuses.map((value) => ({ value, label: STATUS_LABEL[value] ?? value }))],
      state.filters.status,
      set('status'),
    ),
    select(
      [{ value: '', label: '全部意图' }, ...intents.map((value) => ({ value, label: intentLabel(value) }))],
      state.filters.intent,
      set('intent'),
    ),
    select(
      [{ value: '', label: '全部渠道' }, ...platforms.map((id) => ({ value: id, label: channelLabel(id) }))],
      state.filters.platform,
      set('platform'),
    ),
    storeSelect(state.filters.storeId, set('storeId')),
    node('label', { class: 'toggle' }, [
      node('input', {
        type: 'checkbox',
        checked: state.filters.needsHuman,
        onchange: (event) => {
          state.filters.needsHuman = event.target.checked;
          refreshDrafts().catch((cause) => toast(cause.message, 'error'));
        },
      }),
      node('span', { text: '只看需人工确认' }),
    ]),
    search,
    button('搜索', () => {
      state.filters.q = document.getElementById('draft-q').value.trim();
      refreshDrafts().catch((cause) => toast(cause.message, 'error'));
    }),
    node('span', { class: 'muted', text: `共 ${num(state.drafts?.total ?? 0)} 条` }),
  ]);
}

function renderDrafts() {
  const container = document.getElementById('patrol-drafts');
  if (!container) return;
  clear(container);

  // 只有真的新增了才显示图例：空跑一遍不该冒出一个「新增 0 条」的色块。
  const recent = lastRunInfo();
  if (recent && recent.created > 0) container.appendChild(newRunLegend(recent));

  container.appendChild(draftFilters());

  const items = state.drafts?.items ?? [];
  if (items.length === 0) {
    container.appendChild(
      node('div', { class: 'empty' }, [
        node('div', { class: 'empty-title', text: '还没有草稿' }),
        node('div', { class: 'empty-detail', text: '点上面的「一键巡逻」跑一遍，草稿会自己出现在这里。' }),
      ]),
    );
    return;
  }

  const rows = items.map((item) => {
    // 「新生成」= 这条草稿的 runId 就是最近一次巡逻。人工建的、以及更早那些批次的都不算。
    const isNew = Boolean(recent && item.runId && item.runId === recent.id);
    const classes = [item.needsHuman ? 'row-alert' : '', isNew ? `row-new row-new-${recent.color}` : '']
      .filter(Boolean)
      .join(' ');
    return node('tr', { class: classes, onclick: () => openDrawer(item.id) }, [
      node('td', {}, [
        badge(STATUS_LABEL[item.status] ?? item.status, STATUS_TONE[item.status] ?? 'idle'),
        isNew ? node('span', { class: `badge badge-new badge-new-${recent.color}`, text: '本次新增' }) : null,
      ]),
      node('td', { text: item.storeName || item.storeId }),
      node('td', { text: item.buyer || DASH }),
      node('td', { text: item.intentLabel || intentLabel(item.intent) }),
      node('td', { class: 'cell-subject', text: item.subject || DASH, title: item.subject || DASH }),
      node('td', { text: item.orderId || DASH }),
      node('td', { class: 'muted', text: item.dueText || DASH }),
      node('td', { class: item.needsHuman ? 'cell-overdue' : 'muted', text: item.needsHuman ? '需确认' : '' }),
      node('td', {}, [
        node('button', {
          type: 'button',
          class: 'btn btn-xs btn-warn',
          text: '删除',
          title: '从草稿库里删掉这条（撤销不了）；只是不想再看到它请用详情里的「丢弃」',
          // 整行点了会开详情，这里必须拦一下，否则点删除顺带把抽屉也打开了。
          onclick: (event) => {
            event.stopPropagation();
            deleteDraft(item);
          },
        }),
      ]),
    ]);
  });

  container.appendChild(
    node('div', { class: 'table-wrap' }, [
      node('table', { class: 'table table-clickable' }, [
        node('thead', {}, [
          node('tr', {}, [
            node('th', { text: '状态' }),
            node('th', { text: '店铺' }),
            node('th', { text: '买家' }),
            node('th', { text: '意图' }),
            node('th', { text: '主题' }),
            node('th', { text: '订单号' }),
            node('th', { text: '到期' }),
            node('th', { text: '需确认' }),
            node('th', { text: '操作' }),
          ]),
        ]),
        node('tbody', {}, rows),
      ]),
    ]),
  );
}

/** 打开草稿详情。 */
function openDrawer(id) {
  get(`/drafts/${encodeURIComponent(id)}`)
    .then((data) => {
      state.drawer = data.item;
      renderDrawer();
    })
    .catch((cause) => toast(`读取失败：${cause.message}`, 'error'));
}

function closeDrawer() {
  state.drawer = null;
  renderDrawer();
}

async function saveDraft(id, changes, message) {
  try {
    const data = await patch(`/drafts/${encodeURIComponent(id)}`, changes);
    state.drawer = data.item;
    toast(message ?? '已保存');
    await refreshDrafts();
    renderDrawer();
  } catch (cause) {
    toast(cause.message, 'error');
  }
}

/**
 * 真删一条草稿。
 *
 * 与「丢弃」的区别必须说清楚：丢弃只是改状态、记录和正文都还在，随时能翻回来；
 * 删除是从库里抹掉，撤销不了。所以这里一定弹确认，并把区别写进确认框 ——
 * 点错的人还有机会改主意去点「丢弃」。
 * @param {object} item - 草稿。
 * @returns {Promise<void>} 完成。
 */
async function deleteDraft(item) {
  const who = (item.storeName || item.storeId) + ' / ' + (item.buyer || '买家');
  const ok = window.confirm(
    '删除这条草稿？\n\n' +
      who + '\n' +
      (item.subject || '') + '\n\n' +
      '这会把它从草稿库里抹掉（连正文副本一起），撤销不了。\n' +
      '如果只是不想再看到它、但以后还要翻回来查，请改用「丢弃」。',
  );
  if (!ok) return;
  try {
    await del('/drafts/' + encodeURIComponent(item.id));
    toast('草稿已删除');
    if (state.drawer?.id === item.id) state.drawer = null;
    await refreshDrafts();
    renderDrawer();
  } catch (cause) {
    toast('删除失败：' + cause.message, 'error');
  }
}

/** 把草稿填进亚马逊回复框（不发送）。 */
async function fillDraft(item) {
  const ok = window.confirm(
    '把这条草稿填进亚马逊的回复框？\n\n' +
      '紫鸟会打开该店铺并定位到原会话，把文本填进输入框，然后停下 —— 不会点发送。\n' +
      '发送必须由你在亚马逊页面上亲自确认。',
  );
  if (!ok) return;
  toast('正在打开店铺并填入回复框…');
  try {
    await post(`/drafts/${encodeURIComponent(item.id)}/fill`, {});
    toast('已填入回复框（未发送），请在亚马逊页面核对');
    await refreshDrafts();
    renderDrawer();
  } catch (cause) {
    toast(`填入失败：${cause.message}`, 'error');
  }
}

/** 在飞书里建一封回复草稿（只存草稿，不发送）。 */
async function createMailDraft(item) {
  const ok = window.confirm(
    '在飞书里为这封邮件建一条回复草稿？\n\n' +
      '草稿会存进该公共邮箱的草稿箱，你打开飞书就能看到、改完再自己点发送。\n' +
      '这里不会发送任何邮件。',
  );
  if (!ok) return;
  toast('正在飞书里创建草稿…');
  try {
    await post(`/drafts/${encodeURIComponent(item.id)}/mail-draft`, {});
    toast('飞书草稿已创建（未发送），请到飞书草稿箱核对');
    await refreshDrafts();
    renderDrawer();
  } catch (cause) {
    toast(`创建失败：${cause.message}`, 'error');
  }
}

function renderDrawer() {
  const existing = document.getElementById('drawer');
  if (existing) existing.remove();
  const item = state.drawer;
  if (!item) return;

  const bodyBox = node('textarea', { class: 'draft-body', spellcheck: 'false' });
  bodyBox.value = item.body;

  const drawer = node('aside', { class: 'drawer drawer-wide', id: 'drawer' }, [
    node('div', { class: 'drawer-head' }, [
      node('span', { class: 'drawer-title', text: `${item.storeName || item.storeId} / ${item.buyer || '买家'}` }),
      button('关闭', closeDrawer),
    ]),
    node('div', { class: 'drawer-body' }, [
      node('dl', { class: 'kv' }, [
        node('dt', { text: '状态' }),
        node('dd', {}, [badge(STATUS_LABEL[item.status] ?? item.status, STATUS_TONE[item.status] ?? 'idle')]),
        node('dt', { text: '意图' }),
        node('dd', {}, [
          node('span', { text: item.intentLabel || intentLabel(item.intent) }),
          item.intentSource === 'subject'
            ? node('span', { class: 'muted', text: '（按系统主题判定，建议再读一遍会话）' })
            : null,
        ]),
        node('dt', { text: '订单号' }),
        node('dd', { text: item.orderId || DASH }),
        node('dt', { text: '主题' }),
        node('dd', { text: item.subject || DASH }),
        node('dt', { text: '到期' }),
        node('dd', { text: item.dueText || DASH }),
        node('dt', { text: '买家语言' }),
        node('dd', { text: item.language?.label ?? DASH }),
        node('dt', { text: '生成时间' }),
        node('dd', { text: dateTime(item.createdAt) }),
      ]),
      item.notes?.length
        ? node('div', { class: 'banner banner-warn' }, item.notes.map((note) => node('div', { text: `· ${note}` })))
        : null,
      node('div', { class: 'drawer-section' }, [node('h3', { text: '草稿正文（可直接改）' }), bodyBox]),
      node('div', { class: 'actions' }, [
        button('保存修改', () => saveDraft(item.id, { body: bodyBox.value }, '草稿已保存')),
        button('复制正文', () => copy(bodyBox.value)),
        button('标记已批准', () => saveDraft(item.id, { status: 'approved' }, '已批准')),
        button('丢弃', () => saveDraft(item.id, { status: 'discarded' }, '已丢弃')),
        button('删除草稿', () => deleteDraft(item), 'warn'),
      ]),
      item.platform === 'lark-mail'
        ? node('div', { class: 'drawer-section' }, [
            node('h3', { text: '送到飞书（只存草稿，不会发送）' }),
            node('div', {
              class: 'muted',
              text: '在公共邮箱里把这封回信存成草稿，你打开飞书就能看到、改完再自己点发送。',
            }),
            node('div', { class: 'actions' }, [
              button('创建飞书回复草稿', () => createMailDraft(item).catch((cause) => toast(cause.message, 'error')), 'primary'),
            ]),
          ])
        : node('div', { class: 'drawer-section' }, [
            node('h3', { text: '送到亚马逊（不会发送）' }),
            node('div', { class: 'muted', text: '把上面这份文本填进该店铺的亚马逊回复框，填完就停。发送必须由你在亚马逊页面亲自点。' }),
            node('div', { class: 'actions' }, [
              button('填入亚马逊回复框', () => fillDraft(item).catch((cause) => toast(cause.message, 'error')), 'primary'),
              // 深链由服务端拼好（caseUrl）：页面里不写任何绝对地址。
              item.caseUrl
                ? node('a', { class: 'btn', href: item.caseUrl, target: '_blank', rel: 'noreferrer', text: '打开原会话' })
                : null,
            ]),
          ]),
      node('div', { class: 'drawer-section' }, [
        node('h3', { text: '处理记录' }),
        node('ol', { class: 'timeline' }, (item.timeline ?? []).map((entry) =>
          node('li', {}, [
            node('span', { class: 'timeline-time', text: dateTime(entry.at) }),
            node('span', { class: 'timeline-action', text: entry.action }),
            node('span', { class: 'timeline-detail', text: entry.detail ?? '' }),
          ]),
        )),
      ]),
    ]),
  ]);
  document.body.appendChild(drawer);
}

/* ── 页面入口 ─────────────────────────────────────────────────────────── */

/**
 * 渲染巡逻页。
 * @param {HTMLElement} container - 容器。
 * @param {{registerRefresh: Function}} ctx - 外壳上下文。
 * @returns {Promise<void>} 完成。
 */
export async function render(container, ctx) {
  clear(container);
  container.appendChild(
    node('div', { class: 'page-actions' }, [
      button('刷新', () => refresh().catch((cause) => toast(`加载失败：${cause.message}`, 'error'))),
      node('span', { class: 'muted', text: '巡逻只生成草稿，不发送。' }),
    ]),
  );
  container.appendChild(node('section', { class: 'panel' }, [
    node('div', { class: 'panel-head' }, [node('h2', { text: '一键巡逻' })]),
    node('div', { id: 'patrol-action' }),
    node('div', { class: 'panel-sub' }, [node('div', { id: 'patrol-sources' })]),
    node('div', { class: 'panel-sub' }, [node('h3', { text: '巡逻进度' }), node('div', { id: 'patrol-progress' })]),
  ]));
  container.appendChild(node('section', { class: 'panel' }, [
    node('div', { class: 'panel-head' }, [node('h2', { text: '定时巡检' })]),
    node('div', { id: 'patrol-auto' }),
  ]));
  container.appendChild(node('section', { class: 'panel' }, [
    node('div', { class: 'panel-head' }, [node('h2', { text: '草稿库' })]),
    node('div', { id: 'patrol-drafts' }),
  ]));

  state.drawer = null;
  await refresh();
  if (state.patrol?.running) startPolling();
  ctx?.registerRefresh?.(() => refresh());
}
