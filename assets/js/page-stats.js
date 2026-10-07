/**
 * 工作台 · 统计页。
 *
 * 只负责渲染：**所有口径都由服务端算好**（见 lib/stats.js），这一层不做任何业务计算，
 * 只把数字摆好、把没有数据的情况讲清楚。
 */

import { get, toQuery } from './api.js';
import { badge, button, card, clear, emptyState, kv, node, panel, select, svgNode, toast } from './dom.js';
import { DASH, barWidth, ms, num, pct, shortDay } from './format.js';

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

const WINDOWS = [
  { value: '7', label: '近 7 天' },
  { value: '14', label: '近 14 天' },
  { value: '30', label: '近 30 天' },
];

const state = { days: 14, data: null };

/** 一个 KPI 数字块。 */
function kpi(label, value, sub, kind = '') {
  return node('div', { class: `kpi${kind ? ` kpi-${kind}` : ''}` }, [
    node('div', { class: 'kpi-label', text: label }),
    node('div', { class: 'kpi-value', text: value }),
    sub ? node('div', { class: 'kpi-sub', text: sub }) : null,
  ]);
}

/**
 * 分布条列表。
 * @param {Array<{name: string, count: number}>} rows - 数据。
 * @param {{emptyText?: string}} [options] - 选项。
 * @returns {HTMLElement} 节点。
 */
function distribution(rows, options = {}) {
  const visible = rows.filter((row) => row.count > 0);
  if (visible.length === 0) {
    return node('div', { class: 'muted', text: options.emptyText ?? '暂无数据' });
  }
  const max = Math.max(...visible.map((row) => row.count));
  return node(
    'div',
    { class: 'dist' },
    visible.map((row) =>
      node('div', { class: 'dist-row' }, [
        node('span', { class: 'dist-name', text: row.name }),
        node('div', { class: 'dist-bar' }, [node('div', { class: 'dist-fill', style: `width:${barWidth(row.count, max)}` })]),
        node('span', { class: 'dist-count', text: num(row.count) }),
      ]),
    ),
  );
}

/**
 * 每天的分组柱状图（纯 SVG，无依赖）。
 * @param {Array<object>} series - 服务端给的天序列。
 * @param {Array<{key: string, label: string, class: string}>} defs - 每个指标一根柱子。
 * @returns {HTMLElement} 节点。
 */
function trendChart(series, defs) {
  if (!Array.isArray(series) || series.length === 0) {
    return node('div', { class: 'muted', text: '暂无数据' });
  }
  const W = Math.max(260, series.length * 28);
  const H = 130;
  const pad = { l: 6, r: 6, t: 10, b: 20 };
  const innerH = H - pad.t - pad.b;
  const max = Math.max(1, ...series.flatMap((row) => defs.map((def) => Number(row[def.key]) || 0)));
  const groupW = (W - pad.l - pad.r) / series.length;
  const barW = Math.max(3, Math.min(12, (groupW - 8) / defs.length));

  const children = [];
  // 基线
  children.push(svgNode('line', { x1: pad.l, y1: H - pad.b, x2: W - pad.r, y2: H - pad.b, class: 'chart-axis' }));
  series.forEach((row, index) => {
    const groupX = pad.l + index * groupW + (groupW - barW * defs.length) / 2;
    defs.forEach((def, defIndex) => {
      const value = Number(row[def.key]) || 0;
      const height = value === 0 ? 0 : Math.max(2, (value / max) * innerH);
      children.push(
        svgNode('rect', {
          x: groupX + defIndex * barW,
          y: H - pad.b - height,
          width: Math.max(2, barW - 2),
          height,
          class: `chart-bar ${def.class}`,
        }),
      );
      if (value > 0) {
        children.push(
          svgNode('text', {
            x: groupX + defIndex * barW + (barW - 2) / 2,
            y: H - pad.b - height - 3,
            class: 'chart-value',
            text: String(value),
          }),
        );
      }
    });
    // 横轴标签：只在稀疏位置显示，避免挤在一起
    if (series.length <= 10 || index % Math.ceil(series.length / 8) === 0 || index === series.length - 1) {
      children.push(
        svgNode('text', {
          x: pad.l + index * groupW + groupW / 2,
          y: H - pad.b + 13,
          class: 'chart-label',
          text: shortDay(row.day),
        }),
      );
    }
  });

  return node('div', { class: 'chart' }, [
    svgNode('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'xMidYMid meet', class: 'chart-svg' }, children),
    node(
      'div',
      { class: 'chart-legend' },
      defs.map((def) =>
        node('span', { class: 'legend-item' }, [
          node('i', { class: `legend-swatch ${def.class}` }),
          node('span', { text: def.label }),
        ]),
      ),
    ),
  ]);
}

/** 业务统计组。 */
function businessSection(business) {
  if (!business.hasData) {
    return panel('客服业务', null, [
      emptyState(
        '还没有工单',
        '手动登记一条，或者等飞书邮件同步落地后自动进来。统计会立刻跟着有数。',
        [button('去队列新建工单', () => { location.hash = '#/work/queue'; }, 'primary')],
      ),
    ]);
  }
  const kpis = node('div', { class: 'kpi-row' }, [
    kpi('待处理', num(business.byStatus.new + business.byStatus.drafted + business.byStatus.approved), '未发送的活跃工单'),
    kpi('今日新增', num(business.today.created)),
    kpi('今日已发送', num(business.today.sent)),
    kpi('待审草稿', num(business.byStatus.drafted)),
    kpi('需人工', num(business.byStatus.needs_human), '', business.byStatus.needs_human > 0 ? 'warn' : ''),
    kpi('SLA 超时', num(business.sla.overdue), '', business.sla.overdue > 0 ? 'error' : ''),
  ]);

  const channelRows = Object.entries(business.byChannel).map(([key, count]) => ({
    name: CHANNEL_LABEL[key] ?? key,
    count,
  }));
  const kindRows = Object.entries(business.byKind).map(([key, count]) => ({ name: KIND_LABEL[key] ?? key, count }));
  const statusRows = Object.entries(business.byStatus).map(([key, count]) => ({
    name: STATUS_LABEL[key] ?? key,
    count,
  }));

  return panel('客服业务', null, [
    kpis,
    node('div', { class: 'split' }, [
      node('div', {}, [node('h3', { text: '按渠道' }), distribution(channelRows)]),
      node('div', {}, [node('h3', { text: '按类型' }), distribution(kindRows)]),
    ]),
    node('div', { class: 'split' }, [
      node('div', {}, [node('h3', { text: '按状态' }), distribution(statusRows)]),
      node('div', {}, [
        node('h3', { text: '按负责人' }),
        distribution(business.byAssignee.map((entry) => ({ name: entry.name, count: entry.count })), {
          emptyText: '还没有分派',
        }),
      ]),
    ]),
    node('div', { class: 'split' }, [
      node('div', {}, [
        node('h3', { text: 'SLA' }),
        kv([
          ['默认时长', `${business.sla.defaultHours} 小时`],
          ['超时未处理', num(business.sla.overdue)],
          ['按时率', pct(business.sla.onTimeRate)],
          ['首次响应中位数', ms(business.sla.medianFirstResponseMs)],
        ]),
      ]),
      node('div', {}, [
        node('h3', { text: '趋势（新增 vs 已发送）' }),
        trendChart(business.series, [
          { key: 'created', label: '新增', class: 'bar-created' },
          { key: 'sent', label: '已发送', class: 'bar-sent' },
        ]),
      ]),
    ]),
  ]);
}

/** 运行统计组。 */
function runtimeSection(runtime) {
  const cli = runtime.cli;
  const kpis = node('div', { class: 'kpi-row' }, [
    kpi('CLI 调用', num(cli.total)),
    kpi('成功率', pct(cli.successRate), `${num(cli.ok)} 成功 / ${num(cli.fail)} 失败`, cli.fail > 0 ? 'warn' : ''),
    kpi('P50 耗时', ms(cli.latency.p50)),
    kpi('P95 耗时', ms(cli.latency.p95)),
    kpi('体检次数', num(runtime.detect.runs), runtime.detect.lastAt ? `最近 ${runtime.detect.lastOk ? '通过' : '失败'}` : '还没跑过'),
    kpi('连续失败', num(runtime.detect.consecutiveFail), '', runtime.detect.consecutiveFail > 0 ? 'error' : ''),
  ]);

  const cliTable = node('table', { class: 'table' }, [
    node('thead', {}, [
      node('tr', {}, [
        node('th', { text: 'CLI' }),
        node('th', { text: '调用' }),
        node('th', { text: '成功' }),
        node('th', { text: '失败' }),
        node('th', { text: '成功率' }),
        node('th', { text: 'P50' }),
        node('th', { text: 'P95' }),
        node('th', { text: '最近' }),
      ]),
    ]),
    node(
      'tbody',
      {},
      cli.byName.length === 0
        ? [node('tr', {}, [node('td', { colspan: '8', class: 'muted', text: '还没有调用记录' })])]
        : cli.byName.map((entry) =>
            node('tr', {}, [
              node('td', { text: entry.name }),
              node('td', { text: num(entry.total) }),
              node('td', { text: num(entry.ok) }),
              node('td', { text: num(entry.fail) }),
              node('td', { text: pct(entry.successRate) }),
              node('td', { text: ms(entry.p50) }),
              node('td', { text: ms(entry.p95) }),
              node('td', { class: 'muted', text: entry.lastAt ? entry.lastAt.slice(11, 19) : DASH }),
            ]),
          ),
    ),
  ]);

  return panel('插件运行', null, [
    kpis,
    node('div', { class: 'split' }, [
      node('div', {}, [node('h3', { text: '按 CLI' }), cliTable]),
      node('div', {}, [
        node('h3', { text: '错误类型' }),
        distribution(cli.byErrorKind.map((entry) => ({ name: entry.kind, count: entry.count })), {
          emptyText: '没有失败记录',
        }),
        node('h3', { text: '趋势（调用 vs 失败）' }),
        trendChart(runtime.series, [
          { key: 'cli', label: '调用', class: 'bar-cli' },
          { key: 'cliFail', label: '失败', class: 'bar-fail' },
        ]),
      ]),
    ]),
    runtime.audit?.skippedLines > 0
      ? node('div', { class: 'muted', text: `审计里有 ${runtime.audit.skippedLines} 行无法解析，已跳过` })
      : null,
  ]);
}

/** 画整页。 */
function renderBody() {
  const container = document.getElementById('page-body');
  if (!container || !state.data) return;
  clear(container);
  const { business, runtime, window: win } = state.data;
  container.appendChild(
    node('div', { class: 'muted' }, [
      node('span', {
        text: `统计窗口 ${win.from} ~ ${win.to}（${win.timezone}） · 生成于 ${new Date(state.data.generatedAt).toLocaleTimeString('zh-CN')}`,
      }),
    ]),
  );
  container.appendChild(businessSection(business));
  container.appendChild(runtimeSection(runtime));
}

/** 拉数据。 */
async function refresh() {
  state.data = await get('/stats', toQuery({ days: state.days }));
  renderBody();
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
      select(WINDOWS, String(state.days), (value) => {
        state.days = Number(value);
        refresh().catch((cause) => toast(`统计加载失败：${cause.message}`, 'error'));
      }),
      button('刷新', () => refresh().catch((cause) => toast(`统计加载失败：${cause.message}`, 'error'))),
    ]),
  );
  container.appendChild(node('div', { class: 'page-body', id: 'page-body' }));
  await refresh();
  ctx?.registerRefresh?.(() => refresh());
}
