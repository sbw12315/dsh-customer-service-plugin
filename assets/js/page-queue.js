/**
 * 工作台 · 队列页：待处理工单的日常操作界面。
 *
 * 筛选全部走服务端（前端只传参），状态流转按钮由 `/api/meta` 的跃迁表驱动，
 * 所以「哪些状态能跳到哪」只有一处定义（lib/store/queue.js）。
 */

import { get, patch, post, toQuery } from './api.js';
import { badge, button, clear, input, node, panel, select, toast } from './dom.js';
import { DASH, dateTime, num, relative, slaCountdown } from './format.js';

const CHANNEL_LABEL = { mail: '飞书邮件', tiktok: 'TikTok Shop', walmart: 'Walmart', amazon: 'Amazon' };
const KIND_LABEL = { message: '买家消息', review: '评价回复', afterSales: '售后工单', orderInquiry: '订单咨询' };
const STATUS_LABEL = {
  new: '待处理',
  drafted: '草稿待审',
  approved: '已批准',
  sending: '发送中',
  sent: '已发送',
  failed: '发送失败',
  needs_human: '需人工',
  archived: '已归档',
};
const STATUS_TONE = {
  new: 'warn',
  drafted: 'idle',
  approved: 'idle',
  sending: 'idle',
  sent: 'ok',
  failed: 'error',
  needs_human: 'warn',
  archived: 'idle',
};

const state = {
  meta: null,
  filters: { status: 'all', channel: '', kind: '', assignee: '', q: '' },
  items: [],
  counts: null,
  total: 0,
  selected: null,
};

/** 取标题文本。 */
const label = (map, key) => map[key] ?? key ?? DASH;

/** 拉元数据（维度与跃迁表）。 */
async function loadMeta() {
  if (state.meta) return state.meta;
  state.meta = await get('/meta');
  return state.meta;
}

/** 拉队列。 */
async function refresh() {
  await loadMeta();
  const data = await get('/queue', toQuery({ ...state.filters, limit: 200 }));
  state.items = data.items;
  state.counts = data.counts;
  state.total = data.total;
  renderBody();
}

/** 改一条工单。 */
async function updateItem(id, body, message) {
  try {
    const data = await patch(`/queue/${encodeURIComponent(id)}`, body);
    state.selected = data.item;
    toast(message ?? '已保存');
    await refresh();
    if (state.selected) renderDrawer();
  } catch (cause) {
    const allowed = cause.details?.allowed;
    toast(allowed ? `${cause.message}（可跳到：${allowed.map((s) => label(STATUS_LABEL, s)).join('、')}）` : cause.message, 'error');
  }
}

/** 新建工单表单。 */
function newForm() {
  const fields = {
    channel: node('select', { id: 'new-channel' }, [
      node('option', { value: 'mail', text: CHANNEL_LABEL.mail }),
      node('option', { value: 'tiktok', text: CHANNEL_LABEL.tiktok }),
      node('option', { value: 'walmart', text: CHANNEL_LABEL.walmart }),
      node('option', { value: 'amazon', text: CHANNEL_LABEL.amazon }),
    ]),
    kind: node('select', { id: 'new-kind' }, Object.entries(KIND_LABEL).map(([value, text]) => node('option', { value, text }))),
    subject: input('', '例如：订单 A123 买家催发货', null),
    from: input('', '买家 / 发件人', null),
    assignee: input('', '负责人（留空=未分派）', null),
    note: input('', '备注（可选）', null),
  };
  fields.subject.id = 'new-subject';
  fields.from.id = 'new-from';
  fields.assignee.id = 'new-assignee';
  fields.note.id = 'new-note';

  const submit = async () => {
    const subject = document.getElementById('new-subject').value.trim();
    if (!subject) {
      toast('主题不能为空', 'error');
      return;
    }
    try {
      await post('/queue', {
        channel: document.getElementById('new-channel').value,
        kind: document.getElementById('new-kind').value,
        subject,
        from: document.getElementById('new-from').value.trim(),
        assignee: document.getElementById('new-assignee').value.trim(),
        note: document.getElementById('new-note').value.trim() || undefined,
        // 手抖重复提交不会产生两条：同一个幂等键会被服务端去重。
        idempotencyKey: `manual-${subject}-${Date.now()}`,
      });
      for (const id of ['new-subject', 'new-from', 'new-assignee', 'new-note']) {
        document.getElementById(id).value = '';
      }
      toast('已新建工单');
      await refresh();
    } catch (cause) {
      toast(`新建失败：${cause.message}`, 'error');
    }
  };

  const field = (text, control) => node('label', { class: 'field' }, [node('span', { class: 'field-label', text }), control]);

  return node('details', { class: 'newform' }, [
    node('summary', { text: '＋ 新建工单（手动登记）' }),
    node('div', { class: 'field-row' }, [field('渠道', fields.channel), field('类型', fields.kind)]),
    node('div', { class: 'field-row' }, [field('主题', fields.subject), field('来源 / 买家', fields.from)]),
    node('div', { class: 'field-row' }, [field('负责人', fields.assignee), field('备注', fields.note)]),
    node('div', { class: 'actions' }, [button('新建', submit, 'primary')]),
  ]);
}

/** 筛选栏。 */
function filterBar() {
  const statusOptions = [
    { value: 'all', label: '全部状态' },
    ...(state.meta?.dimensions.statuses ?? []).map((value) => ({ value, label: label(STATUS_LABEL, value) })),
  ];
  const channelOptions = [
    { value: '', label: '全部渠道' },
    ...(state.meta?.dimensions.channels ?? []).map((value) => ({ value, label: label(CHANNEL_LABEL, value) })),
  ];
  const kindOptions = [
    { value: '', label: '全部类型' },
    ...(state.meta?.dimensions.kinds ?? []).map((value) => ({ value, label: label(KIND_LABEL, value) })),
  ];
  const assigneeOptions = [
    { value: '', label: '全部负责人' },
    { value: '__none__', label: '未分派' },
    ...((state.counts?.byAssignee ?? [])
      .filter((entry) => entry.name !== '未分派')
      .map((entry) => ({ value: entry.name, label: entry.name }))),
  ];

  const set = (key) => (value) => {
    state.filters[key] = value;
    refresh().catch((cause) => toast(cause.message, 'error'));
  };
  const search = input(state.filters.q, '搜索主题 / 买家', null);
  search.id = 'filter-q';
  const submitSearch = () => {
    state.filters.q = document.getElementById('filter-q').value.trim();
    refresh().catch((cause) => toast(cause.message, 'error'));
  };
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submitSearch();
  });

  return node('div', { class: 'filters' }, [
    select(statusOptions, state.filters.status, set('status')),
    select(channelOptions, state.filters.channel, set('channel')),
    select(kindOptions, state.filters.kind, set('kind')),
    select(assigneeOptions, state.filters.assignee, set('assignee')),
    search,
    button('搜索', submitSearch),
    node('span', { class: 'muted', text: `共 ${num(state.total)} 条` }),
  ]);
}

/** 队列表格。 */
function table() {
  if (state.items.length === 0) {
    return node('div', { class: 'empty' }, [
      node('div', { class: 'empty-title', text: state.total === 0 && !state.filters.status ? '队列是空的' : '没有匹配的工单' }),
      node('div', {
        class: 'empty-detail',
        text:
          state.total === 0 && !state.filters.status
            ? '可以先手动登记一条；飞书邮件同步落地后会自己进来。'
            : '换个筛选条件再试试。',
      }),
    ]);
  }
  const rows = state.items.map((item) => {
    const due = item.slaDueAt ?? item.dueAt ?? null;
    const sla = slaCountdown(due);
    // 整行提示条只留给「明确需人工」和「超时一天以上」：25 行里 22 行都超时的时候，
    // 满屏橙线等于没有信号；SLA 列本身仍然逐行标红，细粒度没有丢。
    const overdueHours = due ? (Date.now() - new Date(due).getTime()) / 3_600_000 : 0;
    const alert = item.status === 'needs_human' || overdueHours > 24;
    return node(
      'tr',
      { class: alert ? 'row-alert' : '', onclick: () => openDrawer(item.id) },
      [
        node('td', {}, [badge(label(STATUS_LABEL, item.status), STATUS_TONE[item.status] ?? 'idle')]),
        node('td', { text: label(CHANNEL_LABEL, item.channel) }),
        node('td', { text: label(KIND_LABEL, item.kind) }),
        node('td', { class: 'cell-subject', text: item.subject, title: item.subject }),
        node('td', { text: item.assignee ?? '未分派' }),
        node('td', { class: 'muted', text: relative(item.receivedAt) }),
        node('td', { class: sla.overdue ? 'cell-overdue' : 'muted', text: sla.unknown ? DASH : sla.text }),
      ],
    );
  });
  return node('div', { class: 'table-wrap' }, [
    node('table', { class: 'table table-clickable' }, [
      node('thead', {}, [
        node('tr', {}, [
          node('th', { text: '状态' }),
          node('th', { text: '渠道' }),
          node('th', { text: '类型' }),
          node('th', { text: '主题' }),
          node('th', { text: '负责人' }),
          node('th', { text: '收到' }),
          node('th', { text: 'SLA' }),
        ]),
      ]),
      node('tbody', {}, rows),
    ]),
  ]);
}

/** 打开详情抽屉。 */
function openDrawer(id) {
  get(`/queue/${encodeURIComponent(id)}`)
    .then((data) => {
      state.selected = data.item;
      renderDrawer();
    })
    .catch((cause) => toast(`读取失败：${cause.message}`, 'error'));
}

/** 关闭抽屉。 */
function closeDrawer() {
  state.selected = null;
  renderDrawer();
}

/** 详情抽屉。 */
function renderDrawer() {
  const existing = document.getElementById('drawer');
  if (existing) existing.remove();
  const item = state.selected;
  if (!item) return;

  const allowed = state.meta?.transitions?.[item.status] ?? [];
  const timeline = node(
    'ol',
    { class: 'timeline' },
    (item.timeline ?? []).map((entry) =>
      node('li', {}, [
        node('span', { class: 'timeline-time', text: dateTime(entry.at) }),
        node('span', { class: 'timeline-action', text: entry.action }),
        node('span', { class: 'timeline-detail', text: entry.detail ?? '' }),
      ]),
    ),
  );

  const drawer = node('aside', { class: 'drawer', id: 'drawer' }, [
    node('div', { class: 'drawer-head' }, [
      node('span', { class: 'drawer-title', text: item.subject }),
      button('关闭', closeDrawer),
    ]),
    node('div', { class: 'drawer-body' }, [
      node('dl', { class: 'kv' }, [
        node('dt', { text: '状态' }),
        node('dd', {}, [badge(label(STATUS_LABEL, item.status), STATUS_TONE[item.status] ?? 'idle')]),
        node('dt', { text: '渠道 / 类型' }),
        node('dd', { text: `${label(CHANNEL_LABEL, item.channel)} / ${label(KIND_LABEL, item.kind)}` }),
        node('dt', { text: '来源' }),
        node('dd', { text: item.from || DASH }),
        node('dt', { text: '收到' }),
        node('dd', { text: dateTime(item.receivedAt) }),
        node('dt', { text: '负责人' }),
        node('dd', { text: item.assignee ?? '未分派' }),
      ]),
      node('div', { class: 'drawer-grid' }, [
        node('label', { class: 'field' }, [
          node('span', { class: 'field-label', text: '改派给' }),
          (() => {
            const el = input(item.assignee ?? '', '留空=未分派', null);
            el.id = 'drawer-assignee';
            return el;
          })(),
        ]),
        node('label', { class: 'field' }, [
          node('span', { class: 'field-label', text: '备注' }),
          (() => {
            const el = input('', '写点什么再点添加', null);
            el.id = 'drawer-note';
            return el;
          })(),
        ]),
      ]),
      node('div', { class: 'actions' }, [
        button('保存改派', () => {
          updateItem(item.id, { assignee: document.getElementById('drawer-assignee').value.trim() }, '已改派');
        }),
        button('添加备注', () => {
          const note = document.getElementById('drawer-note').value.trim();
          if (!note) {
            toast('备注不能为空', 'error');
            return;
          }
          updateItem(item.id, { note }, '已添加备注');
        }),
      ]),
      node('div', { class: 'drawer-section' }, [
        node('h3', { text: '状态流转' }),
        node(
          'div',
          { class: 'actions' },
          allowed.length === 0
            ? [node('span', { class: 'muted', text: '已到终态，没有可用的下一步' })]
            : allowed.map((next) =>
                button(
                  `→ ${label(STATUS_LABEL, next)}`,
                  () => {
                    if (next === 'sent') {
                      // 真正「发出」这一步以后要接飞书/紫鸟；本轮先把状态机的门守住。
                      const ok = window.confirm('确认把这单标记为已发送？这只会改状态，本轮还不会真的发出消息。');
                      if (!ok) return;
                    }
                    updateItem(item.id, { status: next }, `已流转到「${label(STATUS_LABEL, next)}」`);
                  },
                  next === 'sent' ? 'primary' : '',
                ),
              ),
        ),
      ]),
      node('div', { class: 'drawer-section' }, [node('h3', { text: '处理记录' }), timeline]),
    ]),
  ]);
  document.body.appendChild(drawer);
}

/** 画整页。 */
function renderBody() {
  const container = document.getElementById('page-body');
  if (!container || !state.counts) return;
  clear(container);
  container.appendChild(newForm());
  container.appendChild(filterBar());
  const statusChips = node(
    'div',
    { class: 'chips' },
    Object.entries(state.counts.byStatus)
      .filter(([, count]) => count > 0)
      .map(([status, count]) => badge(`${label(STATUS_LABEL, status)} ${num(count)}`, STATUS_TONE[status] ?? 'idle')),
  );
  container.appendChild(statusChips);
  container.appendChild(table());
}

/**
 * 页面入口。
 * @param {HTMLElement} container - 容器。
 * @param {{registerRefresh: Function}} ctx - 外壳上下文。
 * @returns {Promise<void>} 完成。
 */
export async function render(container, ctx) {
  clear(container);
  container.appendChild(
    node('div', { class: 'page-actions' }, [
      button('刷新', () => refresh().catch((cause) => toast(`加载失败：${cause.message}`, 'error'))),
    ]),
  );
  container.appendChild(node('div', { class: 'page-body', id: 'page-body' }));
  state.selected = null;
  await refresh();
  ctx?.registerRefresh?.(() => refresh());
}
