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
import { groupByPlatform, unpatrolledPlatforms } from './platform-summary.js';

const STATUS_LABEL = { draft: '草稿', approved: '已批准', filled: '已填入回复框', discarded: '已丢弃' };
const STATUS_TONE = { draft: 'idle', approved: 'ok', filled: 'warn', discarded: 'idle' };
const STORE_TONE = { ok: 'ok', failed: 'error', running: 'warn' };
const POLL_MS = 3000;

/**
 * 登录态的展示口径：文案 + 颜色。
 *
 * 颜色直接沿用页面既有的 badge 约定（ok 绿 / warn 黄 / error 红 / idle 灰），**不新起一套**——
 * 多加一种状态色，读的人就得先学一遍配色，而这里的状态本来就落在既有语义里。
 *
 * 其中两个键服务端不会返回，是前端自己合成的：
 *   NONE —— 还没探测过（接口没给这家店的登录态，或宿主半还是旧版本）。画灰点并明说
 *           「未探测」，**不猜成已登录也不猜成未登录**：猜错的代价是运营以为可以巡逻，
 *           实际点下去只会撞一次失败。
 *   STALE —— 人自己点过之后页面上的状态就旧了，该再探一次。
 */
const LOGIN_STATE = {
  logged_in: { label: '已登录', tone: 'ok' },
  login_required: { label: '等待登录…', tone: 'warn' },
  timeout: { label: '等待超时', tone: 'warn' },
  failed: { label: '登录失败', tone: 'error' },
  STALE: { label: '状态待复核', tone: 'warn' },
  NONE: { label: '未探测登录态', tone: 'idle' },
};

/** 服务端正常会返回的登录态；之外的（含前端合成的 STALE）一律按 NONE 画。 */
const LOGIN_STATES = ['logged_in', 'login_required', 'timeout', 'failed'];

/** 上面那两个前端合成态的取值 —— 写成常量，免得每处都敲一遍字符串。 */
const LOGIN_UNSET = 'NONE';
const LOGIN_STALE = 'STALE';

/** 还没登录（含等超时、打不开、还没探测）—— 巡逻入口要据此提示「得先登录」。 */
const LOGIN_NOT_READY = ['login_required', 'timeout', 'failed', LOGIN_UNSET, LOGIN_STALE];

/** 这两态都表示「人在动手 / 还没成」：显示成等待，按钮给「我已完成」。 */
const LOGIN_WAITING = ['login_required', LOGIN_STALE];

/** 已登录的两种画法：有活干 / 这家店现在没有待处理会话。 */
const LOGIN_READY = ['logged_in', 'logged_in_idle'];

/** 巡逻轮询与登录轮询是两件事，各有各的表，别复用一个 cookie。 */
const LOGIN_POLL_MS = 3000;

/** 「登录」按钮的三种职责，文案与动作都由它决定 —— 状态判断只有一处。 */
const LOGIN_ACTION = {
  open: { text: '登录', title: '打开该店的登录页并停下，等你自己完成登录（插件不代填）' },
  recheck: { text: '我已完成', title: '按你的确认去探测一次；这一步只读，点错也不会改坏什么' },
  retry: { text: '重试登录', title: '上次没等到登录完成：重新打开登录页再等一次' },
};
/**
 * 平台的收起状态。
 *
 * 存 localStorage 而不是只放内存：店铺列表有好几块（亚马逊 / TikTok / 邮箱），运营常常
 * 只想盯其中一块 —— 只放内存的话，页面刷新一次（或外壳的自动刷新重建节点）就得重新收一遍。
 * 读写都包 try/catch：隐私模式、配额满、localStorage 整个不可用时不能因此让页面挂掉。
 */
const COLLAPSE_KEY = 'cs.patrol.collapsed';

/** @returns {Set<string>} 已收起的渠道 id。 */
function readCollapsed() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

/** @param {Set<string>} set - 已收起的渠道 id。 */
function writeCollapsed(set) {
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));
  } catch {
    /* 存不下就算了：收起状态丢了不影响任何功能。 */
  }
}

/** 单个平台块是否收起。 */
function isCollapsed(channelId) {
  return state.collapsed.has(channelId);
}

/** 收起/展开一个平台块，并立刻重画。 */
function toggleCollapsed(channelId) {
  if (state.collapsed.has(channelId)) state.collapsed.delete(channelId);
  else state.collapsed.add(channelId);
  writeCollapsed(state.collapsed);
  renderSources();
}

const state = {
  meta: null,
  patrol: null,
  drafts: null,
  // platform 留空 = 全部渠道；storeId 留空 = 全部店铺/邮箱。
  filters: { status: 'all', platform: '', intent: '', storeId: '', needsHuman: false, q: '' },
  options: { maxStores: 0, maxPerStore: 50, closeAfter: false },
  selectedStores: null,
  // 定时巡检（每个平台一份）：页面上的「本地草稿」，从 /patrol 的 autoPatrol 初始化一次，
  // 点保存才回写。刻意不在每次自动刷新时覆盖 —— 外壳每 60 秒刷一次，覆盖会把没保存的编辑冲掉。
  // 以渠道 id 分槽：{ [channelId]: { enabled, times, storeIds } }。
  autoDrafts: null,
  /** 「只巡检这几家店」那个可折叠选择器的展开状态（渠道 id → 是否展开）。 */
  autoOpenStores: {},
  scanning: false,
  /** 正在切换启用状态的那个渠道 id —— 请求在途时开关要禁用，不然人会连点。 */
  channelBusy: null,
  timer: null,
  drawer: null,
  /** 已收起的平台块（渠道 id）。见 readCollapsed / toggleCollapsed。 */
  collapsed: readCollapsed(),
  // ── 登录（前端这一份状态） ────────────────────────────────────────────
  // 与 state.patrol.loginStates（服务端快照）刻意分开存。巡逻每 3 秒整份换掉服务端快照，
  // 把「等待中」「刚点过」这些纯界面标记挂在快照上，一个刷新周期就被抹平，
  // 按钮会在「我已完成 / 登录」之间来回跳。
  /** storeId → true：页面上的状态已经旧了，按钮该变成「我已完成」。 */
  loginPending: {},
  /** 上一次向上层报过的登录态：只有真的变了才 toast，免得每 3 秒复述一遍「等待登录…」。 */
  loginReported: {},
  /** 正在忙的那一家（`渠道id::店铺id`）—— 请求在途时按钮要禁用，不然人会连点开出一串窗口。 */
  loginBusy: null,
  /** 登录轮询的表，与巡逻那张（state.timer）分开：两者的生命周期不一样。 */
  loginTimer: null,
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
  // 登录态与登录态汇总顺带记一份：/patrol 是首屏与自动刷新都走的那条路，登录态跟着它回来，
  // 刷新页面之后状态点就不会退回「未探测」。更**权威**的那一份在 GET /patrol/login
  // （不吃店铺扫描的 60 秒缓存），点「我已完成」与轮询都用那条。
  const states = state.patrol?.loginStates ?? {};
  for (const [storeId, entry] of Object.entries(states)) {
    if (entry?.state) state.loginReported[storeId] = entry.state;
  }
  // 定时巡检那几块画在各自平台块里面（见 renderSources），所以这里不再单独渲染。
  renderSources();
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
      checkbox('跑完关闭店铺', 'closeAfter', '影响亚马逊与 TikTok Shop：会把已填入但还没发送的回复一起关掉'),
    ]),
    node('div', { class: 'field-row patrol-options' }, [
      checkbox('同时把邮件草稿写进飞书草稿箱', 'writeMailDrafts', '仍然只存草稿、不发送；相当于替你在飞书里点一遍「存草稿」'),
      checkbox('未登录时自动登录', 'autoLogin', '只对支持自动登录的渠道生效（沃尔玛）：账号密码由紫鸟填好、2 步验证码由紫鸟验证码服务填入，插件只点「登录 / 继续」，不代填任何凭据'),
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
  if (!auto || !auto.channels) return '定时巡检：状态未知（后端可能还是旧版本，重启 DSH 后可见）';
  // 一行里只说「哪些平台开着、下次几点」——每个平台自己的细节写在它自己那块面板里，
  // 三个平台的时刻表全堆在大按钮下面就没人看了。
  const plans = Object.values(auto.channels);
  const on = plans.filter((plan) => plan.enabled && plan.channelEnabled && plan.times.length > 0);
  const pending = plans.filter((plan) => plan.enabled && plan.channelEnabled && plan.times.length === 0);
  if (on.length === 0 && pending.length === 0) {
    return '定时巡检：全部平台已关闭 —— 只在你手动点按钮时才会跑';
  }
  if (on.length === 0) {
    return `定时巡检：${pending.map((plan) => plan.label).join('、')} 已启用，但还没添加巡检时刻 —— 现在不会自动跑`;
  }
  const head = on
    .map((plan) => `${plan.label} 每天 ${plan.times.length} 次（${plan.times.join(' / ')}）`)
    .join('；');
  if (pending.length > 0) {
    // 开着却没时刻的平台也要露一句，否则「我明明打开了」会变成一次静默的空等。
    head += `；${pending.map((plan) => plan.label).join('、')} 已启用但没有时刻`;
  }
  const next = auto.nextAt
    ? ` · 下次 ${auto.nextSlot}（${auto.nextChannelLabel ?? ''} ${dateTime(auto.nextAt)}）`
    : '';
  return `定时巡检：${on.length} 个平台已启用 —— ${head}${next}`;
}

/**
 * 每个平台的计划在页面上是「本地草稿」：第一次拿到服务端快照时初始化，改完点保存才回写。
 *
 * 为什么不能每次刷新都覆盖：外壳会定期重画这一页，覆盖会把还没保存的编辑冲掉；
 * 而「服务端快照」和「正在编辑的东西」本来就是两回事。以渠道 id 分槽存。
 * @param {object|null} auto - /api/patrol 里的 autoPatrol 快照。
 * @returns {void}
 */
function ensureAutoDrafts(auto) {
  if (state.autoDrafts === null) state.autoDrafts = {};
  for (const plan of Object.values(auto?.channels ?? {})) {
    if (state.autoDrafts[plan.id]) continue;
    state.autoDrafts[plan.id] = {
      enabled: plan.enabled === true,
      times: Array.isArray(plan.times) ? [...plan.times] : [],
      storeIds: Array.isArray(plan.storeIds) ? [...plan.storeIds] : [],
    };
  }
}

/** 新加一行时挑一个还没被占用的时间，别让两行都默认同一个点。 */
function nextFreeTime(times) {
  const candidates = ['06:00', '09:00', '12:00', '14:00', '18:00', '20:00', '22:00'];
  return candidates.find((time) => !times.includes(time)) ?? '12:00';
}

/**
 * 单个平台底下的那行详细状态。
 * @param {object|null} plan - /api/patrol 里这个平台的定时巡检快照。
 * @returns {string} 一句话。
 */
function autoStatusText(plan) {
  if (!plan) return '状态未知：后端可能还是旧版本，重启 DSH 后可见。';
  const parts = [];
  // 「渠道本身没启用」要单独说：那时候开关是开的、时刻也在，但一步都不会跑，
  // 不写出来就会变成「明明到点了怎么没动」。
  if (!plan.channelEnabled) parts.push('该渠道未启用：先在「设置」里打开，到点也不会跑');
  parts.push(plan.enabled ? '已启用' : '未启用');
  if (plan.enabled && plan.channelEnabled) {
    parts.push(`今天 ${plan.times.length} 个时刻，已跑 ${plan.firedToday?.length ?? 0} 次`);
    if (plan.runningNow) parts.push(`现在正在跑（${plan.dueSlot ?? ''}）`);
    else if (plan.wouldRun) parts.push(`现在就会跑（${plan.dueSlot}）`);
    else parts.push(`当前不跑：${plan.blockedText}`);
    if (plan.nextAt) parts.push(`下次 ${plan.nextSlot}（${dateTime(plan.nextAt)}）`);
  }
  parts.push(plan.storeIds?.length ? `只巡检指定的 ${plan.storeIds.length} 个目标` : '巡检全部目标');
  const last = plan.lastAutoRun;
  if (last) parts.push(`上次 ${dateTime(last.startedAt)} ${last.status}（新草稿 ${num(last.draftsCreated)}）`);
  return parts.join(' · ');
}

/**
 * 保存**某一个平台**的计划。
 *
 * 只提交这一个平台的那一份：设置是整份落盘的，把别的平台也一起提交等于
 * 把人家此刻正在编辑、还没保存的内容顺手写进去。
 * @param {object} channel - 渠道（含 id / label）。
 * @returns {Promise<void>} 完成。
 */
async function saveAutoPlan(channel) {
  const draft = state.autoDrafts?.[channel.id];
  if (!draft) return;
  try {
    const saved = await post('/settings', {
      autoPatrol: {
        channels: {
          [channel.id]: {
            enabled: draft.enabled === true,
            times: draft.times.filter(Boolean),
            storeIds: [...draft.storeIds],
          },
        },
      },
    });
    // 后端会去重 / 排序 / 丢掉非法项，以它返回的为准，免得界面和落盘的列表对不上。
    const plan = saved?.settings?.autoPatrol?.channels?.[channel.id];
    if (plan) {
      state.autoDrafts[channel.id] = {
        enabled: plan.enabled === true,
        times: [...plan.times],
        storeIds: [...plan.storeIds],
      };
    }
    toast(`${channel.label}的定时巡检已保存`);
    await refreshPatrol();
  } catch (cause) {
    toast(`保存失败：${cause.message}`, 'error');
  }
}

/**
 * 「这个平台定时巡检只跑哪几家」的选择器。
 *
 * 口径与手动巡逻的勾选框一致：**一个都不勾 = 全部**（空数组 = 不限定）。
 * 这一点必须在界面上写出来，否则「我明明都取消了」会变成一次全量巡逻。
 * @param {object} channel - 渠道。
 * @param {object} draft - 这个平台的本地草稿。
 * @param {Array} items - 扫描到的目标。
 * @returns {HTMLElement} 元素。
 */
function autoStorePicker(channel, draft, items) {
  const chosen = new Set(draft.storeIds);
  const details = node('details', {
    class: 'auto-stores',
    open: state.autoOpenStores[channel.id] === true,
  });
  // 展开状态放内存：外壳会重画这一块，不记的话正看着它就自己收起来了。
  details.addEventListener('toggle', () => {
    state.autoOpenStores[channel.id] = details.open;
  });
  const summary = node('summary');
  const paint = () => {
    summary.textContent = draft.storeIds.length === 0
      ? `巡检店铺：全部 ${items.length} 个目标`
      : `巡检店铺：指定的 ${draft.storeIds.length} 个（共 ${items.length} 个）`;
  };
  paint();
  details.appendChild(summary);
  details.appendChild(
    node('div', { class: 'field-hint', text: '一个都不勾 = 全部都要（与手动巡逻的勾选口径一致）。' }),
  );

  if (items.length === 0) {
    details.appendChild(
      node('div', { class: 'muted', text: '还没扫到这个渠道的目标：先点一次「仅刷新列表」。' }),
    );
  } else {
    details.appendChild(
      node('div', { class: 'auto-store-grid' }, items.map((source) =>
        node('label', { class: 'field field-check' }, [
          node('input', {
            type: 'checkbox',
            checked: chosen.has(source.storeId),
            onchange: (event) => {
              const index = draft.storeIds.indexOf(source.storeId);
              if (event.target.checked && index < 0) draft.storeIds.push(source.storeId);
              if (!event.target.checked && index >= 0) draft.storeIds.splice(index, 1);
              paint();
            },
          }),
          node('span', { class: 'field-label', text: source.storeName || source.storeId }),
        ]),
      )),
    );
  }

  // 已经保存、但这次没扫到的目标（比如扫描失败）：只报个数，保存时**原样带上** ——
  // 不能因为「这次没看见」就把人之前勾好的店铺悄悄删掉。
  const known = new Set(items.map((source) => source.storeId));
  const missing = draft.storeIds.filter((id) => !known.has(id));
  if (missing.length > 0) {
    details.appendChild(
      node('div', { class: 'muted', text: `另有 ${missing.length} 个已保存但这次没扫到，会原样保留。` }),
    );
  }
  return details;
}

/**
 * 一个平台块底下的「定时巡检」：开关 + 时刻表 + 巡检店铺 + 保存 + 状态。
 *
 * 放在渠道块**里面**是刻意的：时刻表和店铺都是这个平台自己的东西，
 * 摆在同一块里才不会出现「上面设亚马逊、下面设沃尔玛」看串行。
 * @param {object} channel - 渠道（含 id / label / enabled）。
 * @param {object|null} auto - /api/patrol 里的 autoPatrol 快照。
 * @returns {HTMLElement|null} 元素；这个平台还没有草稿时返回 null。
 */
function autoPlanSection(channel, auto) {
  const plan = auto?.channels?.[channel.id] ?? null;
  const draft = state.autoDrafts?.[channel.id];
  if (!draft) return null;
  const items = state.patrol?.sources?.[channel.id]?.items ?? [];
  const section = node('div', { class: 'auto-plan' });

  section.appendChild(
    node('div', { class: 'auto-plan-head' }, [
      node('span', { class: 'auto-plan-title', text: '定时巡检' }),
      plan?.enabled && plan.channelEnabled ? badge('已启用', 'ok') : badge('未启用', 'idle'),
      // 还没给这个平台单独保存过：此刻跑的是旧版那张全局时刻表。必须标出来，
      // 否则会变成「我明明没给 TikTok 设过，它怎么自己在跑」。
      plan && plan.configured === false ? badge('沿用全局默认', 'warn') : null,
      plan && plan.channelEnabled === false ? badge('该渠道未启用', 'warn') : null,
    ]),
  );

  section.appendChild(
    node('label', { class: 'field field-check' }, [
      node('input', {
        type: 'checkbox',
        checked: draft.enabled,
        onchange: (event) => {
          draft.enabled = event.target.checked;
        },
      }),
      node('span', { class: 'field-label', text: `启用${channel.label}的定时巡检` }),
      node('span', {
        class: 'field-hint',
        text: '默认关闭。打开后到点会自己跑一遍完整巡逻（扫描 → 生成草稿 → 填入回复框，仍然不发送）'
          + '—— 无人值守会自己打开店铺浏览器，所以必须由你显式打开。改完记得点保存。',
      }),
    ]),
  );

  section.appendChild(
    node('div', {
      class: 'muted',
      text: `巡检时刻（每天各跑一次，共 ${draft.times.length} 次；上一轮没跑完就跳过，不会并发）`,
    }),
  );

  const rows = node('div', { class: 'auto-times' });
  if (draft.times.length === 0) {
    rows.appendChild(node('div', { class: 'muted', text: '还没添加巡检时刻 —— 现在不会自动跑。' }));
  }
  draft.times.forEach((time, index) => {
    rows.appendChild(
      node('div', { class: 'auto-time-row' }, [
        input(time, '', (value) => {
          draft.times[index] = value;
        }, { type: 'time' }),
        button('删除', () => {
          draft.times.splice(index, 1);
          renderSources();
        }),
      ]),
    );
  });
  section.appendChild(rows);

  section.appendChild(autoStorePicker(channel, draft, items));

  section.appendChild(
    node('div', { class: 'actions auto-plan-actions' }, [
      button('+ 添加一次巡检', () => {
        draft.times.push(nextFreeTime(draft.times));
        draft.times.sort();
        renderSources();
      }),
      button(`保存${channel.label}的计划`, () => saveAutoPlan(channel), 'primary'),
    ]),
  );

  section.appendChild(node('div', { class: 'muted auto-status', text: autoStatusText(plan) }));
  return section;
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
            text: '依次打开每家店铺（Amazon / TikTok Shop / 沃尔玛）与飞书邮箱，读取待回复会话并生成草稿，'
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
  // 「另有 N 个平台不会被巡逻」—— N 是**平台数**，不是店铺数。
  //
  // 口径为什么是平台：紫鸟账号下的店铺跨 20+ 个平台（实测 72 家店 / 24 个平台），
  // 按店铺报会得到「另有 64 个目标不会被巡逻」，数字很大却看不出是什么；而且每个渠道
  // 各报一遍（亚马逊报 64、TikTok 报 66），同一个事实重复两遍。按平台报才回答了
  // 运营真正会问的那句：「还剩哪些平台没接」。
  //
  // 聚合值优先用服务端给的（skippedPlatforms / skippedByPlatform）；宿主半还是旧版时
  // 就地按 platformName 兜底算一次，保证界面不会因为后端没跟上就少一个数字。
  const skippedByPlatform = Array.isArray(scan.skippedByPlatform)
    ? scan.skippedByPlatform
    : groupByPlatform(scan.skipped);
  const skippedPlatforms = Number.isFinite(scan.skippedPlatforms)
    ? scan.skippedPlatforms
    : skippedByPlatform.length;

  if (skippedPlatforms > 0) {
    const stores = skippedByPlatform.reduce((sum, entry) => sum + entry.stores, 0);
    blocks.push(
      node('details', { class: 'logbox' }, [
        node('summary', {
          text: `本渠道不巡逻的另有 ${skippedPlatforms} 个平台（${stores} 家店）`,
        }),
        node('ul', { class: 'skip-list' }, skippedByPlatform.map((entry) =>
          node('li', { text: `${entry.platformName} · ${entry.stores} 家` }),
        )),
        node('div', {
          class: 'muted',
          // 措辞刻意是「本渠道不巡逻」而不是「不会被巡逻」：这里面有些平台是被**别的**
          // 渠道巡逻着的（例如 TikTok 渠道存在时，亚马逊这一块的 skipped 里就有 TikTok）。
          // 写成「不会被巡逻」会与最上面那条全局摘要互相矛盾。
          text: '上面列的是「平台 · 家数」，不是逐店清单。想知道「完全没人巡逻的平台」，看最上面那条摘要。',
        }),
      ]),
    );
  }

  // 已停用的店铺单独一栏。理由：紫鸟 `store list` 没有状态字段，停用只能从店名看出来，
  // 而「店自己停了」与「这个平台还没接」要人做的事完全不同 —— 混在一起会让人以为沃尔玛没接好。
  const retired = Array.isArray(scan.retired) ? scan.retired : [];
  if (retired.length) {
    blocks.push(
      node('details', { class: 'logbox' }, [
        node('summary', { text: `已停用的店铺 ${retired.length} 家（不巡逻）` }),
        node('ul', { class: 'skip-list' }, retired.map((entry) =>
          node('li', { text: (entry.storeName || entry.storeId) + ' · ' + (entry.platformName || '') }),
        )),
        node('div', {
          class: 'muted',
          text: '判定依据是店铺名里的「停用 / 废弃 / disabled」字样（紫鸟的店铺列表不带状态字段）。'
            + '这些店不参与巡逻：打开它们只会得到登录页或错误页。要恢复巡逻，把店名里的停用字样去掉即可。',
        }),
      ]),
    );
  }
  return blocks.length ? node('div', { class: 'scan-note' }, blocks) : null;
}


/* ── 登录：开登录页 → 等人 → 探测态 ───────────────────────────────────── */

/**
 * 一家店在当前该显示成什么登录态。
 *
 * 服务端**从不**返回 STALE：那是「人刚点过、页面上的状态已经不新鲜了」这个纯界面事实。
 * 没有这一层的话，点完「我已完成」界面会立刻弹回点之前那个旧状态，看起来像没反应。
 * @param {string} storeId - 店铺 id。
 * @returns {{state: string, label: string, tone: string, hint: string, error: string|null}} 展示用的一条。
 */
function loginView(storeId) {
  const entry = getLoginStates()[storeId] ?? null;
  const fromServer = entry && LOGIN_STATES.includes(entry.state) ? entry.state : LOGIN_UNSET;
  let key = state.loginPending[storeId] === true ? LOGIN_STALE : fromServer;
  // 「已登录但这家店现在没有任何待处理会话」是实测真实存在的正常态（店2 Tiktok-FUSOU-客服KX：
  // 登录成功、收件箱 0 条会话）。它跟「已登录、有活干」在运营眼里是两回事 —— 两个都要说出来，
  // 否则「已登录却没草稿」会被误读成漏扫。这个信号来自巡逻的登录预检，不是登录接口。
  if (key === 'logged_in' && idleLoggedIn(storeId)) key = 'logged_in_idle';
  const meta = key === 'logged_in_idle' ? { label: '已登录·无待处理', tone: 'idle' } : LOGIN_STATE[key];
  return {
    state: key,
    label: meta.label,
    tone: meta.tone,
    hint: entry?.hint ?? '',
    error: entry?.error ?? null,
  };
}

/**
 * 这家店是不是「已登录，但连一个待处理会话都没有」。
 *
 * ⚠️ 判据刻意是**登录预检本身**（`run.sources[*].auth`），不是 `status !== 'skipped'`：
 * 未登录的店巡逻时报的是 `status: 'skipped'`，可它不是**唯一的**跳过原因 —— 同一批店还会
 * 因为「没勾选」「超出最多扫几个目标」被跳过。拿 skipped 当登录判据，后两种会一起被画成
 * 「未登录」，而它们其实跟登录毫无关系。
 *
 * 登录预检的结论由服务端在结果里显式给出（`auth: { state, url }`，见 lib/patrol.js 的
 * `result.auth = login ? {...} : null`，**所有路径**上都会赋值，含 skipped 那条）。宿主半还是
 * 旧版本、没有这个字段时这里返回 false —— 宁可少显示一个更细的标签，也不编一个出来。
 * @param {string} storeId - 店铺 id。
 * @returns {boolean} 是否为「已登录·无待处理」。
 */
function idleLoggedIn(storeId) {
  const runs = state.patrol?.run?.sources ?? [];
  // 判据是登录预检的结论本身（auth.state），不是 status：
  //   auth.state === 'logged_in'  → 这家店确实是登录态；
  //   status !== 'skipped'        → 它这次**真的被跑过**（不是「没勾选」「超 maxStores」被跳过）。
  // 两个都成立才叫「已登录、但这家店现在没有待处理会话」。
  return runs.some((entry) => entry.storeId === storeId
    && entry.auth?.state === 'logged_in'
    && entry.status !== 'skipped');
}

/** 登录态快照：GET /patrol 与 GET /patrol/login 两处都会给，取已有的那一份。 */
function getLoginStates() {
  return state.patrol?.loginStates ?? {};
}

/** 这个渠道有没有「登录」这回事 —— 由接口的枚举决定，前端不写死平台 id。 */
function isLoginChannel(channelId) {
  return (state.patrol?.loginChannels ?? []).includes(channelId);
}

/** 一个渠道里有几家店还没登录（含等待中与等超时 —— 那两种都还得人再动一次手）。 */
function pendingLoginCount(channelId) {
  return (state.patrol?.sources?.[channelId]?.items ?? [])
    .filter((source) => LOGIN_NOT_READY.includes(loginView(source.storeId).state)).length;
}

/**
 * 单独拉一次登录态：**权威的那一次**，不能用 GET /patrol 的镜像代替。
 *
 * ⚠️ 这不是洁癖：/patrol 那份快照来自**店铺扫描**，而扫描带 60 秒缓存；店铺刚删掉时扫描会
 * 直接报错、整份快照是空的，界面于是把「已登录」画回「未探测」。专门读登录态的这个接口不吃
 * 那份缓存。两份数据各有各的用途：一份快、一份准，这里要的是准。
 * @returns {Promise<object>} `{states, channels, waiting}`。
 */
async function fetchLoginStates() {
  const data = await get('/patrol/login');
  state.patrol = { ...(state.patrol ?? {}), loginStates: data?.states ?? {} };
  return data ?? {};
}

/**
 * 探测一次某店的登录态，并清掉「待复核」标记。
 *
 * 探测本身**不改动状态**（GET 是只读的），所以「我已完成」点它永远安全：最坏的结果是界面
 * 弹回那个仍然真实的旧状态，而不是把什么弄坏。按钮的职责是**证实**，不是**宣称**已登录。
 * @param {string} storeId - 店铺 id。
 * @returns {Promise<object>} 探测到的那一条（带 url）。
 */
async function probeLogin(storeId) {
  await fetchLoginStates();
  delete state.loginPending[storeId];
  return { ...loginView(storeId), url: getLoginStates()[storeId]?.url ?? '' };
}

/** 把探测结果说成一句 toast：说清现在是什么、下一步该谁动手。 */
function announceLogin(who, view) {
  if (view.state === 'logged_in') {
    toast(`「${who}」已登录`);
    return;
  }
  if (view.state === 'logged_in_idle') {
    toast(`「${who}」已登录，但这会儿没有待处理会话`);
    return;
  }
  if (view.state === 'login_required') {
    toast(`「${who}」还没登录：登录页已摆好，请在紫鸟窗口里完成登录（插件不代填）`, 'error');
    return;
  }
  if (view.state === 'timeout') {
    toast(`「${who}」等待超时，请重试：再点一次「登录」把登录页重新打开`, 'error');
    return;
  }
  if (view.state === 'failed') {
    toast(`「${who}」登录失败：${view.error ?? '打不开店铺'}${view.hint ? ` —— ${view.hint}` : ''}`, 'error');
    return;
  }
  if (view.state === LOGIN_STALE) {
    toast(`「${who}」的状态还没刷新，稍等几秒或再点一次「我已完成」`);
    return;
  }
  toast(`「${who}」当前还看不到登录态：${view.hint || '接口没返回这家店的状态'}`);
}

/**
 * 轮询登录态：**只在真的有店在等登录时**才跑。
 *
 * 与巡逻轮询是两个表（见 state.loginTimer）：巡逻可能跑二十分钟，登录只等五分钟，合成一个表
 * 之后「谁把谁清掉的」根本说不清。
 * 状态**只有真的变了**才 toast：每 3 秒复述一遍「等待登录…」是纯噪音，还会把别的提示冲掉。
 */
function startLoginPolling() {
  if (state.loginTimer) return;
  state.loginTimer = setInterval(async () => {
    if (!document.getElementById('patrol-sources')) {
      clearInterval(state.loginTimer);
      state.loginTimer = null;
      return;
    }
    if (document.visibilityState !== 'visible') return;
    let data = null;
    try {
      data = await fetchLoginStates();
    } catch {
      return; // 单次失败不打断轮询
    }
    const states = data?.states ?? {};
    // 店名要在**所有渠道**里找：写死 tiktok 会让沃尔玛那家店在提示里退化成 storeId。
    const nameOf = (storeId) => {
      for (const channel of Object.values(state.patrol?.sources ?? {})) {
        const hit = (channel?.items ?? []).find((item) => item.storeId === storeId);
        if (hit?.storeName) return hit.storeName;
      }
      return storeId;
    };
    for (const [storeId, entry] of Object.entries(states)) {
      const before = state.loginReported[storeId];
      const after = entry.state;
      if (after === before) continue;
      state.loginReported[storeId] = after;
      // 第一次只是记下当前值，不弹提示：页面刚打开时每店弹一次「已登录」是纯噪音。
      if (before === undefined) continue;
      if (after === 'logged_in') toast(`「${nameOf(storeId)}」已登录`);
      else if (after === 'timeout') toast(`「${nameOf(storeId)}」等待超时，请重试`, 'error');
      else if (after === 'failed') toast(`「${nameOf(storeId)}」登录失败：${entry.error ?? '原因未知'}`, 'error');
    }
    // 服务端已经给出结论的店，前端那个「待复核」标记就该撤掉 —— 它是用来遮住旧状态的。
    for (const storeId of Object.keys(state.loginPending)) {
      if (LOGIN_STATES.includes(states[storeId]?.state)) delete state.loginPending[storeId];
    }
    renderSources();
    // 没有一家还在等了就停表：继续空转只是白打请求。
    // 判据**不写死平台**：以前这里问的是「有没有 tiktok 渠道」，加了沃尔玛之后
    // 那个条件在只有沃尔玛在等登录时会永远为假 —— 表就再也停不下来了。
    const stillWaiting = (data?.waiting ?? []).length > 0;
    const loginChannelCount = (state.patrol?.loginChannels ?? []).length;
    if (!stillWaiting && loginChannelCount > 0) {
      clearInterval(state.loginTimer);
      state.loginTimer = null;
    }
  }, LOGIN_POLL_MS);
}

/**
 * 点某家店的「登录」：把登录页开好、然后停下来等人。
 *
 * 这是**唯一**一处会去开店铺窗口的登录入口，单个与批量都走它 —— 两处各写一份，「等人」
 * 「别重复开窗」这些规则迟早会分叉。
 * @param {string} channelId - 渠道 id。
 * @param {object} source - 店铺（来自巡逻列表）。
 * @returns {Promise<void>} 完成。
 */
async function openStoreLogin(channelId, source) {
  const storeId = source.storeId;
  const who = source.storeName || storeId;
  // 立刻置成「待复核」：这个请求要开一次浏览器、要等紫鸟起来，那几秒钟里按钮必须变成
  // 「我已完成」并进入忙碌 —— 否则人会以为没点上，接着连点，开出一串窗口。
  state.loginPending[storeId] = true;
  state.loginBusy = `${channelId}::${storeId}`;
  renderSources();
  try {
    const result = await post('/patrol/login', { channel: channelId, storeId });
    await fetchLoginStates();
    // ⚠️ 必须先撤掉「待复核」再判状态：只要它还挂着，loginView() 一律返回 STALE，
    // 下面那些「服务端说 login_required」的分支就永远进不去 —— 表现是点了登录之后
    // 弹一句「状态还没刷新」，而其实服务端已经把状态写回来了。
    delete state.loginPending[storeId];
    const view = loginView(storeId);
    if (view.state === 'logged_in' || view.state === 'logged_in_idle') {
      // 已登录时服务端**不开窗口**（实测确认过），所以这句话要说得准确：别让人去找一个不存在的窗口。
      delete state.loginPending[storeId];
      state.loginReported[storeId] = 'logged_in';
      toast(`「${who}」已经是登录状态，没有打开新窗口`);
    } else if (view.state === 'login_required') {
      // 有的渠道会把登录页顺手摆到人想要的那一屏（TEMU 会切到「手机号登录」tab）：服务端把
      // 结果放在 phoneLoginTab 里。切成了就要说出来 —— 否则这一步是「静默发生」的，人根本
      // 不知道它做过，下次换台机器又会以为功能坏了。
      const tab = result?.phoneLoginTab;
      const tabNote = tab?.ok
        ? `登录页已经切到「${tab.active || '手机号登录'}」。`
        : tab && tab.reason !== 'not-applicable'
          ? '登录页默认停在「扫码登录」，没能自动切到「手机号登录」，请在窗口里手动点一下那个 tab。'
          : '';
      toast(
        `已打开「${who}」的登录页：${tabNote}请在弹出的紫鸟窗口里完成登录（可能会遇到滑块或验证码）。`
        + '插件不会代填账号、密码或验证码 —— 那一步只能你自己来；登完回来点「我已完成」。',
      );
      startLoginPolling();
    } else {
      announceLogin(who, { ...view, error: result?.error ?? view.error, hint: result?.hint ?? view.hint });
    }
  } catch (cause) {
    delete state.loginPending[storeId];
    toast(`「${who}」打开登录页失败：${cause.message}`, 'error');
  } finally {
    state.loginBusy = null;
    renderSources();
  }
}

/** 点「我已完成」：人工确认之后**立即探测一次**，不盲信（探测是只读的，点错也没关系）。 */
async function confirmLoginDone(channelId, source) {
  const storeId = source.storeId;
  const who = source.storeName || storeId;
  state.loginBusy = `${channelId}::${storeId}`;
  renderSources();
  toast(`正在探测「${who}」的登录态…`);
  try {
    const view = await probeLogin(storeId);
    if (LOGIN_STATES.includes(view.state)) state.loginReported[storeId] = view.state;
    announceLogin(who, view);
    startLoginPolling(); // 还没登完就继续跟；下一轮发现没人等了它自己会停
  } catch (cause) {
    toast(`探测失败：${cause.message}`, 'error');
  } finally {
    state.loginBusy = null;
    renderSources();
  }
}

/** 按当前状态挑一个动作，并就地渲染成按钮。 */
function loginButtonOf(channelId, source) {
  const view = loginView(source.storeId);
  const busy = state.loginBusy === `${channelId}::${source.storeId}`;
  const waiting = LOGIN_WAITING.includes(view.state);
  const action = waiting
    ? LOGIN_ACTION.recheck
    : view.state === 'timeout' || view.state === 'failed'
      ? LOGIN_ACTION.retry
      : LOGIN_ACTION.open;
  return node('button', {
    type: 'button',
    class: `btn btn-xs${busy ? ' is-busy' : ''}`,
    text: busy ? '处理中…' : action.text,
    title: action.title,
    disabled: busy,
    // 按钮在自己的 <label> 外面，所以点它不会连带切换勾选 —— 见 storeChip() 的注释。
    onclick: () => (waiting
      ? confirmLoginDone(channelId, source)
      : openStoreLogin(channelId, source)).catch((cause) => toast(cause.message, 'error')),
  });
}

/**
 * 批量登录：逐个把没登录的店开出来。
 *
 * **串行**是硬要求，不是省事：紫鸟开的是本机浏览器窗口，并发开一堆会互相抢焦点，人根本
 * 不知道该在哪个窗口里过验证码。所以这里就是一条 for + await 的队列，一次只把一家摆好。
 * 摆好之后不等它登录成功（那要人动手，可能要几分钟），而是接着开下一家 —— 等待由后台的
 * waitForLogin 继续，状态由轮询盯着。
 * @param {object} channel - 渠道。
 * @param {object[]} list - 该渠道的店铺列表。
 * @returns {Promise<void>} 完成。
 */
async function loginAllPending(channel, list) {
  const needs = (source) => LOGIN_NOT_READY.includes(loginView(source.storeId).state);
  const targets = list.filter(needs);
  if (targets.length === 0) {
    toast(`「${channel.label}」没有需要登录的店`);
    return;
  }
  toast(`开始逐个打开 ${targets.length} 家店的登录页：一次只开一家，请在紫鸟窗口里完成验证后回来；插件不代填`);
  let opened = 0;
  for (const source of targets) {
    // 开之前再判一次：人可能刚在别的窗口顺手登好了，那就别白开一个窗口。
    if (!needs(source)) continue;
    // eslint-disable-next-line no-await-in-loop -- 串行就是这段代码的目的，不能改成并发
    await openStoreLogin(channel.id, source);
    opened += 1;
  }
  toast(`已依次打开 ${opened} 家店的登录页；请在窗口里完成登录（插件不代填），登完点「我已完成」`);
}
/**
 * 一个店铺行（含 TikTok 的登录状态点与登录按钮）。
 *
 * ⚠️ 外层刻意是 <div> 而不是 <label>：`<label>` 会把内部**任何**点击都转发给它关联的复选框，
 * 于是点「登录」会顺带把这家店取消勾选 —— 表现出来就是「点一下登录，它自己从巡逻名单里掉了」，
 * 而人会以为是自己手滑。复选框与店名包进内层那个 <label>（那部分仍然整块可点），
 * 按钮留在 <label> 外面，这样点勾选、点登录各是各的，互不影响。
 * @param {object} channel - 渠道。
 * @param {object} source - 店铺。
 * @param {{box: HTMLElement, isNew: boolean, result: object|undefined}} parts - 已经造好的部件。
 * @returns {HTMLElement} 节点。
 */
function storeChip(channel, source, parts) {
  const canLogin = isLoginChannel(channel.id);
  const view = canLogin ? loginView(source.storeId) : null;
  return node('div', { class: 'store-chip' }, [
    node('label', { class: 'store-chip-pick' }, [
      parts.box,
      node('span', { class: 'store-chip-name', text: source.storeName || source.storeId }),
      parts.isNew ? badge('新', 'ok') : null,
      node('span', { class: 'muted', text: source.platformName }),
      parts.result ? badge(`${parts.result.drafts} 草稿`, STORE_TONE[parts.result.status] ?? 'idle') : null,
    ]),
    // 状态点用现成的 badge() 与 ok/warn/error/idle 约定，不另起一套样式。
    canLogin ? badge(view.label, view.tone) : null,
    // hint / error 不塞进按钮的 title：title 悬停才看得到，而「为什么失败」得能直接读到。
    canLogin && view.error ? node('span', { class: 'muted store-chip-note', text: view.error }) : null,
    canLogin && !view.error && view.hint ? node('span', { class: 'muted store-chip-note', text: view.hint }) : null,
    canLogin ? loginButtonOf(channel.id, source) : null,
  ]);
}

/**
 * 渠道级启用 / 停用（v0.13.0）。
 *
 * 写进 `settings.channelEnabled[渠道 id]`，服务端**立即生效**（不用重启也不刷新页面）：
 * 停掉之后巡逻与「重新扫描」都会跳过它，扫描接口也会回报「未启用」并说明是哪一种原因。
 * 与「飞书邮箱渠道」那个老开关是同一份真值 —— 两条入口写的是同一处。
 * @param {object} channel - 渠道（来自 /patrol 的 channels）。
 * @param {boolean} enabled - 目标状态。
 * @returns {Promise<void>} 完成。
 */
async function toggleChannel(channel, enabled) {
  if (state.channelBusy) return;
  state.channelBusy = channel.id;
  renderSources();
  try {
    await post('/settings', { channelEnabled: { [channel.id]: enabled } });
    toast(
      enabled
        ? `已启用「${channel.label}」：巡逻与「重新扫描」都会跑它`
        : `已停用「${channel.label}」：巡逻与「重新扫描」都会跳过它`,
    );
    await refreshPatrol();
  } catch (cause) {
    toast(`切换「${channel.label}」失败：${cause.message}`, 'error');
  } finally {
    state.channelBusy = null;
    renderSources();
  }
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

  // 定时巡检（每个平台一份）：先把本地草稿备好，再往每个平台块里画。
  // 判据是**有没有 channels**：旧后端的 autoPatrol 还是 { enabled, times }，字段名都在、
  // 光看形状认不出来；拿不到 channels 时宁可在每块底下写一句「状态未知」，
  // 也不要画一排空面板（顶部的能力位提示会一并告诉人重启 DSH）。
  const auto = state.patrol?.autoPatrol?.channels ? state.patrol.autoPatrol : null;
  if (auto) ensureAutoDrafts(auto);

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

  // 全局摘要：**没有被任何已启用渠道巡逻**的平台。放在最上面说一次，
  // 而不是在每个渠道块里各说一遍 —— 那个数在各块里是一样的，重复三遍只会让人以为是三个数。
  const rest = unpatrolledPlatforms(channels, scans);
  const patrolled = (channels ?? []).filter((channel) => channel.enabled !== false).map((channel) => channel.label);
  if (rest.platformCount > 0) {
    container.appendChild(
      node('div', { class: 'sources-summary' }, [
        node('div', { class: 'muted' }, [
          node('span', { text: patrolled.length > 0 ? `当前巡逻：${patrolled.join('、')}。` : '当前没有启用任何渠道。' }),
          node('strong', { text: ` 另有 ${rest.platformCount} 个平台（${rest.storeCount} 家店）不会被巡逻` }),
        ]),
        node('details', { class: 'logbox' }, [
          node('summary', { text: `看是哪 ${rest.platformCount} 个平台` }),
          node('ul', { class: 'skip-list' }, rest.platforms.map((entry) =>
            node('li', { text: `${entry.platformName} · ${entry.stores} 家` }),
          )),
          node('div', {
            class: 'muted',
            text: '这些平台还没有接入巡逻。要在某个平台上也巡逻，需要先为它写一个适配器（见 README「阶段状态」）。',
          }),
        ]),
      ]),
    );
  }

  for (const channel of channels) {
    const scan = scans[channel.id] ?? { items: [] };
    const list = scan.items ?? [];
    const off = channel.enabled === false;
    // 渠道**自己**那枚开关的状态（不含 CLI 总开关）：与 off 分开，因为两者会不一致 ——
    // 紫鸟CLI 被禁用时 5 个店铺渠道都 off，但它们的渠道开关其实都还开着。
    // 老宿主半没有这个字段（undefined）：按「开着」画，别把能用的渠道画成停用。
    // switchOn 是**渠道自己那枚开关**（settings.channelEnabled）；enabled 还额外要求 CLI 开着。
    // 后者叫 enabled、前者叫 switchOn，是因为 /health 里 autoPatrol 那套已经有个同名的
    // channelEnabled 表示别的东西（渠道可不可用），不要混。
    const switchOn = channel.switchOn !== false;
    // 旧宿主半没有这个字段：那时开关画出来也是**点了没反应**（POST 过来的 channelEnabled
    // 会被旧后端忽略），所以干脆不画。顶部的能力位会告诉人「请重启 DSH」。
    const canSwitch = typeof channel.switchOn === 'boolean';
    const busy = Boolean(state.patrol?.running);
    const block = node('div', { class: 'source-block' });
    const collapsed = isCollapsed(channel.id);
    // 有登录概念的渠道（现在是 TikTok）：每店多一个状态点和一个「登录」。
    const canLogin = isLoginChannel(channel.id);
    const needLogin = canLogin ? pendingLoginCount(channel.id) : 0;
    // 这个渠道**一家可用的店都没有**（全没登录）：巡逻跑下去只会得到一片「已跳过」。
    // 注意是「全都不能跑」才这么说，只要还有一家能跑就不该拦着人。
    const allNeedLogin = canLogin && list.length > 0 && needLogin === list.length;

    block.appendChild(
      node('div', { class: 'sub-head' }, [
        node('div', { class: 'sub-head-title' }, [
          // 每个平台块可以单独收起：几块列表加起来几十家店时，收起不想看的那几块
          // 才能一眼看到自己要管的那块。收起状态存 localStorage，刷新后仍在。
          node('button', {
            type: 'button',
            class: 'btn btn-ghost collapse-toggle',
            text: collapsed ? '▸' : '▾',
            title: collapsed ? `展开「${channel.label}」` : `收起「${channel.label}」`,
            'aria-expanded': collapsed ? 'false' : 'true',
            onclick: () => toggleCollapsed(channel.id),
          }),
          node('h3', {
            // 两种「没在跑」分开写：渠道被停用 / CLI 总开关关着，要人做的事不一样。
            text: off
              ? `${channel.label}（${switchOn ? '未启用' : '已停用'}）`
              : `${channel.label}（${list.length}）${channel.autoLogin ? ' · 自动登录' : ''}`,
          }),
          // 汇总只在这个渠道真有登录问题时才占位：全登好了就不必反复声明「0 家未登录」。
          needLogin > 0 ? badge(`${needLogin} 家未登录`, 'warn') : null,
          // 收起时把「里面有什么」留在标题上：不然只剩一个光标题，看不出该不该展开。
          collapsed
            ? node('span', { class: 'muted', text: list.length > 0 ? '已收起' : '' })
            : null,
        ]),
        node('div', { class: 'sub-actions' }, [
          // 每个渠道一枚启用 / 停用开关。写进 settings.channelEnabled，**立即生效**；
          // 停掉之后这一块的按钮全变灰，扫描接口也会回报「未启用」并说明原因。
          canSwitch
            ? node(
                'label',
                {
                  class: 'toggle',
                  title: switchOn
                    ? '这个渠道正在巡逻。关掉后巡逻与「重新扫描」都会跳过它（设置会立即保存）'
                    : '这个渠道已停用：打开后巡逻才会跑它（设置会立即保存）',
                },
                [
                  node('input', {
                    type: 'checkbox',
                    checked: switchOn,
                    disabled: busy || state.scanning || state.channelBusy === channel.id,
                    onchange: (event) => toggleChannel(channel, event.target.checked),
                  }),
                  node('span', { text: switchOn ? '已启用' : '已停用' }),
                ],
              )
            : null,
          node('span', { class: 'muted', text: scan.checkedAt ? `上次扫描 ${dateTime(scan.checkedAt)}` : '尚未扫描' }),
          // 批量入口。**串行**是硬要求：紫鸟开的是本机浏览器窗口，并发开会互相抢焦点。
          canLogin && list.length > 0
            ? node('button', {
                type: 'button',
                class: 'btn',
                text: '登录全部未登录的店',
                title: '逐个打开未登录店铺的登录页（一次一家，会互相抢焦点，所以不并发）；'
                  + '每开一家就停下来等你完成验证 —— 插件不代填账号、密码或验证码',
                disabled: busy || off || needLogin === 0,
                onclick: () => loginAllPending(channel, list).catch((cause) => toast(cause.message, 'error')),
              })
            : null,
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
              : allNeedLogin
                ? '这家/这些店还没登录：巡逻只会跳过它们。先点「登录」把浏览器开到登录页，完成登录再巡逻'
                : '扫描 → 生成草稿 → 直接写进紫鸟浏览器的回复框；跑完不关闭浏览器，留给人工核对',
            // 全部目标都还没登录时**不禁用**，只是说清楚会怎样：巡逻本身仍然有信息量
            // （它会逐店回报「未登录，已跳过」），禁用反而让人以为功能坏了。
            disabled: busy || state.scanning || off,
            onclick: () => runChannelPatrol(channel).catch((cause) => toast(cause.message, 'error')),
          }),
        ]),
      ]),
    );

    // 以下都进 body：收起时整块不挂上（不是视觉隐藏 —— 收起就别再生成几十个节点）。
    const body = [];
    const note = sourceScanNote(scan, channel);
    if (note) body.push(note);

    // 「得先登录」这件事要在**巡逻入口旁边**说清楚，不能只挂在每店的按钮 title 上：
    // 没登录时点巡逻，结果是一片「已跳过」，看起来像插件坏了。
    if (canLogin && needLogin > 0) {
      body.push(
        node('div', { class: 'banner banner-warn' }, [
          node('strong', { text: `${needLogin} 家店还没登录：` }),
          node('span', {
            text: '巡逻会跳过它们（结果里记「未登录，已跳过」，不算失败）。请点对应行的「登录」把浏览器开到登录页，'
              + '在紫鸟窗口里自己完成验证（可能是滑块也可能是邮箱验证码）—— 插件不代填，登完点「我已完成」。',
          }),
        ]),
      );
    }

    if (list.length === 0) {
      body.push(
        node('div', {
          class: 'muted',
          // 未启用不是错误，也不是「没有目标」：把原因和怎么打开直接写在这一行。
          text:
            channel.enabled === false
              ? scan.hint ?? `该渠道未启用：先在「设置」里接好 CLI，再手动打开。`
              : scan.error
                ? '看不到列表（原因见上）。'
                // 有登录概念的渠道：空列表最常见的两个原因就是没登录、选择器没校准。
                // 判据 = 服务端枚举 ∪ 自动登录渠道：后者界面上不画登录按钮，但「没登录」仍是空列表的头号原因。
                : isLoginChannel(channel.id) || channel.autoLogin === true
                  ? `没有扫到可巡逻的${channel.label}店铺。这种店常见的两种情况：①店铺还没在紫鸟里登录（打开卖家平台会跳到登录页），`
                    + '②已登录但客服页面的选择器还没校准过。两种都会让扫描读不到消息 —— 请点该店的「登录」把登录页打开，'
                    + '自己完成验证（插件不代填），再确认客服页面能正常打开。'
                  : `没有扫描到可巡逻的${channel.kind === 'mailbox' ? '邮箱' : '店铺'}。`,
        }),
      );
    } else {
      const run = state.patrol?.run;
      body.push(
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
          return storeChip(channel, source, { box, isNew, result });
        })),
      );
    }
    // 定时巡检画在**这个平台块里面**：时刻表与巡检店铺都是这个平台自己的，
    // 放进同一块才不会「上面设亚马逊、下面设沃尔玛」看串行。
    body.push(
      auto
        ? autoPlanSection(channel, auto)
        : node('div', { class: 'muted', text: '定时巡检：状态未知（后端可能还是旧版本，重启 DSH 后可见）。' }),
    );

    if (!collapsed && body.length > 0) block.appendChild(node('div', { class: 'source-body' }, body));
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

/**
 * 抽屉底部「送到哪儿」那一块：按平台分派。
 *
 * 三种平台三条独立分支。刻意**不写 else 兜底** —— 兜底会把认不出的平台画成亚马逊，
 * 让用户对着一个必然失败的按钮使劲。认不出就什么都不画，并在下面明说原因。
 * @param {object} item - 草稿。
 * @returns {HTMLElement|null} 区块节点；平台未知时为 null。
 */
function deliverySection(item) {
  switch (item.platform) {
    case 'lark-mail':
      return node('div', { class: 'drawer-section' }, [
        node('h3', { text: '送到飞书（只存草稿，不会发送）' }),
        node('div', {
          class: 'muted',
          text: '在公共邮箱里把这封回信存成草稿，你打开飞书就能看到、改完再自己点发送。',
        }),
        node('div', { class: 'actions' }, [
          button('创建飞书回复草稿', () => createMailDraft(item).catch((cause) => toast(cause.message, 'error')), 'primary'),
        ]),
      ]);

    case 'amazon':
      return node('div', { class: 'drawer-section' }, [
        node('h3', { text: '送到亚马逊（不会发送）' }),
        node('div', { class: 'muted', text: '把上面这份文本填进该店铺的亚马逊回复框，填完就停。发送必须由你在亚马逊页面亲自点。' }),
        node('div', { class: 'actions' }, [
          button('填入亚马逊回复框', () => fillDraft(item).catch((cause) => toast(cause.message, 'error')), 'primary'),
          // 深链由服务端拼好（caseUrl）：页面里不写任何绝对地址。
          item.caseUrl
            ? node('a', { class: 'btn', href: item.caseUrl, target: '_blank', rel: 'noreferrer', text: '打开原会话' })
            : null,
        ]),
      ]);

    case 'tiktok':
      return node('div', { class: 'drawer-section' }, [
        node('h3', { text: '填进 TikTok 商家中心回复框（不会发送）' }),
        node('div', {
          class: 'muted',
          text: '把上面这份文本填进该店铺 TikTok 商家中心的买家消息回复框，填完就停 —— 本页不会替你发送，'
            + '发送必须由你在商家中心页面上亲自点。',
        }),
        node('div', { class: 'actions' }, [
          // 按钮**照常渲染**，即使店铺还没登录：点下去服务端会抛 kind='auth' 并带上可照做的 hint，
          // toast 出来比事先把按钮藏起来更有信息量 —— 既说清了「请先登录该店铺」，也让人知道有这个功能。
          // 刻意不引入「这个渠道能不能填」的布尔位：真到了某渠道不能填的那天，正确做法是让适配器
          // 不导出 fillComposer / fillOpenConversation，前端按 typeof 判断 —— 方法在不在比布尔位更难说谎。
          button('填入 TikTok 回复框', () => fillDraft(item).catch((cause) => toast(cause.message, 'error')), 'primary'),
          item.caseUrl
            ? node('a', { class: 'btn', href: item.caseUrl, target: '_blank', rel: 'noreferrer', text: '打开原会话' })
            : null,
        ]),
      ]);

    case 'walmart':
      return node('div', { class: 'drawer-section' }, [
        node('h3', { text: '填进沃尔玛 Seller Center 回复框（不会发送）' }),
        node('div', {
          class: 'muted',
          text: '把上面这份文本填进该店铺沃尔玛 Seller Center 的 Customer 会话回复框，填完就停。'
            + '沃尔玛没有会话级深链，填进去的是**当前打开**的那条会话 —— 填入前请确认列表里点开的正是这位买家。'
            + '发送必须由你在沃尔玛页面上亲自点「发送回复」。',
        }),
        node('div', { class: 'actions' }, [
          button('填入沃尔玛回复框', () => fillDraft(item).catch((cause) => toast(cause.message, 'error')), 'primary'),
          item.caseUrl
            ? node('a', { class: 'btn', href: item.caseUrl, target: '_blank', rel: 'noreferrer', text: '打开原会话' })
            : null,
        ]),
      ]);

    case 'shein':
      // SHEIN 没有接入「填入」：回复框选择器还没在真实会话上校准过（见 lib/platforms/shein.js）。
      // 所以这里只给两件事：复制正文 + 打开客服回复页（chat工作台），人工粘贴。
      return node('div', { class: 'drawer-section' }, [
        node('h3', { text: '复制到 SHEIN chat工作台（不会发送）' }),
        node('div', {
          class: 'muted',
          text: '把上面这份文本复制到 SHEIN 商家中心的「客服 → chat工作台」回复框里，粘贴后自己核对再发送。'
            + 'SHEIN 这条线**还没有接入自动填入**（回复框选择器未在有会话的登录态上校准过），'
            + '也没有会话级深链 —— 「打开客服回复页」只会把你送到工作台，请自己点开对应的会话。',
        }),
        node('div', { class: 'actions' }, [
          button('复制正文', () => copy(item.body ?? ''), 'primary'),
          item.caseUrl
            ? node('a', { class: 'btn', href: item.caseUrl, target: '_blank', rel: 'noreferrer', text: '打开客服回复页' })
            : null,
        ]),
      ]);

    case 'temu':
      // TEMU 没有接入「填入」：收件箱那一段（客服中心 → 消费者咨询）还没校准过
      // （见 lib/platforms/temu.js 文件头）。所以这里只给一件事：复制正文，人工粘贴。
      // 服务端给的 caseUrl 恒为空串（两套后台不共用地址），所以没有「打开原会话」入口。
      return node('div', { class: 'drawer-section' }, [
        node('h3', { text: '复制到 TEMU 卖家中心（不会发送）' }),
        node('div', {
          class: 'muted',
          text: '把上面这份文本复制到 TEMU 卖家中心的「客服中心 → 消费者咨询」回复框里，粘贴后自己核对再发送。'
            + 'TEMU 这条线**还没有接入自动填入**（会话行与回复框选择器未在有会话的登录态上校准过），'
            + '也没有已校准的会话级深链，所以这里不提供「打开原会话」按钮。'
            + '另外提醒：跨境店走 seller.kuajingmaihuo.com，美区/欧区店走 seller.temu.com，是两套后台，别开错。',
        }),
        node('div', { class: 'actions' }, [
          button('复制正文', () => copy(item.body ?? ''), 'primary'),
        ]),
      ]);

    default:
      return node('div', { class: 'drawer-section' }, [
        node('h3', { text: '送到原始渠道' }),
        node('div', {
          class: 'muted',
          text: `这个草稿来自「${channelLabel(item.platform)}」，本页还不知道怎么把它送回去（服务端没给这个平台的填入入口）。`
            + '你可以先「复制正文」，再到原页面手动粘贴 —— 本页不会替你发送。',
        }),
        node('div', { class: 'actions' }, [
          button('复制正文', () => copy(item.body ?? ''), 'primary'),
          item.caseUrl
            ? node('a', { class: 'btn', href: item.caseUrl, target: '_blank', rel: 'noreferrer', text: '打开原会话' })
            : null,
        ]),
      ]);
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
      // 按平台分派，**不设兜底分支**：以前这里是「不是飞书就当成亚马逊」，结果 TikTok 草稿
      // 被画成「送到亚马逊」，按钮还会去打亚马逊的填入接口 —— 点下去注定失败或填错地方。
      // 现在认不出的平台宁可什么都不画，也不冒充别的渠道。
      deliverySection(item),
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
  // 「定时巡检」不再是一个独立面板：它已经按平台拆开，画在各自渠道块底下
  // （见 renderSources 里的 autoPlanSection）—— 时刻与店铺本来就是每个平台自己的。
  container.appendChild(node('section', { class: 'panel' }, [
    node('div', { class: 'panel-head' }, [node('h2', { text: '草稿库' })]),
    node('div', { id: 'patrol-drafts' }),
  ]));

  state.drawer = null;
  // 登录相关的界面标记**每次进页面都重新开始**：它们描述的是「这次会话里人做过什么」，
  // 跟着上一次的残留会让状态点在「我已完成 / 登录」之间莫名其妙地跳。
  // 真正的登录态不在这里 —— 它由 refresh() 拉的 GET /patrol.loginStates 恢复，
  // 所以刷新页面之后状态点不会退回「未探测」，而是一直显示上次探测到的那个结论。
  state.loginPending = {};
  state.loginReported = {};
  state.loginBusy = null;
  clearInterval(state.loginTimer);
  state.loginTimer = null;
  await refresh();
  if (state.patrol?.running) startPolling();
  // 页面刷新后如果还有店在等服务端那轮 waitForLogin，就接着盯：状态是内存里的，
  // 但接口一直是权威；不接着盯的话，人得手动点一次「我已完成」才知道登好了没有。
  // 判据是「有没有店还停在 login_required」，不是服务端那个 waiting 数组：
  // waiting 只在**本进程**还在跑 waitForLogin 时才有值，DSH 重启后它一定为空，
  // 而界面上那家店仍然是「等待登录…」，照样该接着盯。
  const pending = (state.patrol?.loginChannels ?? [])
    .flatMap((channelId) => state.patrol?.sources?.[channelId]?.items ?? [])
    .filter((source) => loginView(source.storeId).state === 'login_required');
  if (pending.length > 0) startLoginPolling();
  ctx?.registerRefresh?.(() => refresh());
}
