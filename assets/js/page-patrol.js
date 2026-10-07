/**
 * 工作台 · 巡逻页：一键把全部亚马逊店铺的客服页面过一遍并生成草稿。
 *
 * 这一页就是「一键点按模式」的落点：
 *   1. 顶部一个大按钮 —— 巡逻全部 Amazon 店铺 → 生成草稿；
 *   2. 跑的过程中每 3 秒拉一次 /api/patrol，画进度与每店结果；
 *   3. 下面是草稿库，按店铺/意图/状态筛，点开看正文、复制、或**手动**填进回复框。
 *
 * 页面上没有任何「发送」按钮 —— 这是插件的硬约束，不是遗漏。
 */

import { get, patch, post, toQuery } from './api.js';
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
  filters: { status: 'all', intent: '', storeId: '', needsHuman: false, q: '' },
  options: { maxStores: 0, maxPerStore: 3, headless: false, closeAfter: false },
  selectedStores: null,
  timer: null,
  drawer: null,
};

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
  renderStores();
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
  await Promise.all([refreshPatrol(), refreshDrafts()]);
}

/* ── 一键巡逻 ─────────────────────────────────────────────────────────── */

/** 当前选中的店铺 id（没勾任何一家 = 全部）。 */
function selectedStoreIds() {
  const boxes = Array.from(document.querySelectorAll('input[name="patrol-store"]:checked'));
  const all = Array.from(document.querySelectorAll('input[name="patrol-store"]'));
  if (all.length > 0 && boxes.length === all.length) return [];
  return boxes.map((box) => box.value);
}

/** 启动巡逻。 */
async function startPatrol() {
  const body = {
    ...state.options,
    storeIds: selectedStoreIds(),
  };
  try {
    await post('/patrol', body);
    toast('巡逻已启动，正在依次打开店铺…');
    await refreshPatrol();
    startPolling();
  } catch (cause) {
    toast(`启动失败：${cause.message}`, 'error');
  }
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

  return node('div', { class: 'field-row patrol-options' }, [
    numberField('最多扫几家店', 'maxStores', 0, 500, '0 = 全部'),
    numberField('每店最多几条草稿', 'maxPerStore', 1, 50, ''),
    checkbox('无头模式', 'headless', '不弹窗，但出问题时看不到页面'),
    checkbox('跑完关闭店铺', 'closeAfter', ''),
  ]);
}

/** 大按钮区。 */
function renderOneClick() {
  const container = document.getElementById('patrol-action');
  if (!container) return;
  clear(container);
  const running = Boolean(state.patrol?.running);
  const run = state.patrol?.run;
  const total = state.patrol?.stores?.items?.length ?? 0;

  container.appendChild(
    node('div', { class: 'patrol-hero' }, [
      node('div', { class: 'patrol-hero-main' }, [
        node('button', {
          type: 'button',
          class: `btn btn-primary btn-xl${running ? ' is-busy' : ''}`,
          text: running ? '巡逻进行中…' : `一键巡逻：全部 Amazon 店铺（${num(total)} 家）`,
          disabled: running,
          onclick: () => startPatrol().catch((cause) => toast(cause.message, 'error')),
        }),
        node('div', { class: 'patrol-hero-hint muted' }, [
          node('span', {
            text: '依次打开每家亚马逊店铺的「买家与卖家消息服务 · 需要回复」，读取会话并生成英文草稿。全程只读页面 + 只写草稿，不会发送任何消息。',
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
  container.appendChild(optionRow());

  const error = state.patrol?.stores?.error;
  if (error) {
    container.appendChild(
      node('div', { class: 'banner banner-error' }, [
        node('strong', { text: '取店铺列表失败：' }),
        node('span', { text: error.message }),
        error.hint ? node('span', { class: 'muted', text: ` ${error.hint}` }) : null,
      ]),
    );
  }
}

/* ── 店铺列表 ─────────────────────────────────────────────────────────── */

function renderStores() {
  const container = document.getElementById('patrol-stores');
  if (!container) return;
  clear(container);
  const stores = state.patrol?.stores?.items ?? [];
  if (stores.length === 0) {
    container.appendChild(node('div', { class: 'muted', text: '没有找到亚马逊店铺。检查紫鸟账号下是否有 platformName 含「亚马逊」的店铺。' }));
    return;
  }
  if (state.selectedStores === null) {
    state.selectedStores = new Set(stores.map((store) => store.storeId));
  }
  container.appendChild(
    node('div', { class: 'store-grid' }, stores.map((store) => {
      const box = node('input', {
        type: 'checkbox',
        name: 'patrol-store',
        value: store.storeId,
        checked: state.selectedStores.has(store.storeId),
        onchange: (event) => {
          if (event.target.checked) state.selectedStores.add(store.storeId);
          else state.selectedStores.delete(store.storeId);
        },
      });
      const run = state.patrol?.run;
      const result = run?.stores?.find((entry) => entry.storeId === store.storeId);
      return node('label', { class: 'store-chip' }, [
        box,
        node('span', { class: 'store-chip-name', text: store.storeName || store.storeId }),
        node('span', { class: 'muted', text: store.platformName }),
        result ? badge(`${result.drafts} 草稿`, STORE_TONE[result.status] ?? 'idle') : null,
      ]);
    })),
  );
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
  const pct = progress.storesTotal > 0 ? Math.round((progress.storesDone / progress.storesTotal) * 100) : 0;

  container.appendChild(
    node('div', { class: 'kpi-row' }, [
      kpi('状态', run.status === 'running' ? '进行中' : run.status, run.status === 'running' ? 'warn' : run.status === 'done' ? 'ok' : 'idle'),
      kpi('当前阶段', run.phase ?? DASH),
      kpi('店铺', `${progress.storesDone ?? 0}/${progress.storesTotal ?? 0}`),
      kpi('需要回复', num(progress.conversationsSeen ?? 0)),
      kpi('新草稿', num(progress.draftsCreated ?? 0)),
      kpi('已入队', num(progress.ticketsLinked ?? 0)),
      kpi('错误', num(progress.errors ?? 0), progress.errors > 0 ? 'error' : 'idle'),
    ]),
  );

  container.appendChild(
    node('div', { class: 'patrol-bar' }, [node('div', { class: 'patrol-bar-fill', style: `width:${pct}%` })]),
  );

  if (run.stores?.length) {
    const rows = run.stores.map((store) =>
      node('tr', {}, [
        node('td', { text: store.storeName || store.storeId }),
        node('td', {}, [badge(store.status, STORE_TONE[store.status] ?? 'idle')]),
        node('td', { text: String(store.conversations ?? 0) }),
        node('td', { text: String(store.drafts ?? 0) }),
        node('td', { class: 'muted', text: store.durationMs ? `${Math.round(store.durationMs / 1000)}s` : DASH }),
        node('td', { class: store.error ? 'cell-overdue' : 'muted', text: store.error ?? DASH }),
      ]),
    );
    container.appendChild(
      node('table', { class: 'table' }, [
        node('thead', {}, [
          node('tr', {}, [
            node('th', { text: '店铺' }),
            node('th', { text: '结果' }),
            node('th', { text: '会话' }),
            node('th', { text: '草稿' }),
            node('th', { text: '耗时' }),
            node('th', { text: '错误' }),
          ]),
        ]),
        node('tbody', {}, rows),
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

function draftFilters() {
  const intents = state.meta?.drafts?.intents ?? [];
  const statuses = state.meta?.drafts?.statuses ?? [];
  const stores = state.patrol?.stores?.items ?? [];
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
      [{ value: '', label: '全部店铺' }, ...stores.map((store) => ({ value: store.storeId, label: store.storeName }))],
      state.filters.storeId,
      set('storeId'),
    ),
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

  const rows = items.map((item) =>
    node('tr', { class: item.needsHuman ? 'row-alert' : '', onclick: () => openDrawer(item.id) }, [
      node('td', {}, [badge(STATUS_LABEL[item.status] ?? item.status, STATUS_TONE[item.status] ?? 'idle')]),
      node('td', { text: item.storeName || item.storeId }),
      node('td', { text: item.buyer || DASH }),
      node('td', { text: item.intentLabel || intentLabel(item.intent) }),
      node('td', { class: 'cell-subject', text: item.subject || DASH }),
      node('td', { text: item.orderId || DASH }),
      node('td', { class: 'muted', text: item.dueText || DASH }),
      node('td', { class: item.needsHuman ? 'cell-overdue' : 'muted', text: item.needsHuman ? '需确认' : '' }),
    ]),
  );

  container.appendChild(
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
          node('th', { text: '' }),
        ]),
      ]),
      node('tbody', {}, rows),
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
      ]),
      node('div', { class: 'drawer-section' }, [
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
    node('div', { class: 'panel-sub' }, [node('h3', { text: '账号下的亚马逊店铺' }), node('div', { id: 'patrol-stores' })]),
    node('div', { class: 'panel-sub' }, [node('h3', { text: '巡逻进度' }), node('div', { id: 'patrol-progress' })]),
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
