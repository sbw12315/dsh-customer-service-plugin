/**
 * 设置页：体检 + CLI 路径与附加参数 + 数据目录 + SLA/审计保留 + 原始数据。
 * 后续的「规则与模板 / 排班 / 生成计划」会作为同一页内的二级页签加进来。
 */

import { get, post } from './api.js';
import { badge, button, card, clear, commandRow, kv, node, panel, toast } from './dom.js';
import { DASH, num } from './format.js';

const VIA_LABEL = {
  settings: '手动指定',
  env: '环境变量',
  PATH: 'PATH 解析',
  probe: '常见安装目录',
  missing: '未找到',
};

const SERVICE_LABEL = {
  webServer: 'Web 载体',
  subprocess: '子进程',
  llm: '模型',
  tools: '工具注册表',
  timer: '定时器',
  storage: '存储',
};

/** 页面状态（只在内存里，重新加载页面即重置）。 */
const state = { health: null, settings: null };

/** 渲染一个 CLI 的卡片。 */
function cliCard(info) {
  const ok = Boolean(info.found) && !info.error;
  const kind = ok ? 'ok' : info.found ? 'warn' : 'error';
  const label = ok ? '可用' : info.found ? '异常' : '未找到';
  const body = [
    kv([
      ['路径', info.path ?? DASH],
      ['来源', VIA_LABEL[info.via] ?? info.via],
      ['附加参数', info.args && info.args.length > 0 ? info.args.join(' ') : null],
      ['版本', info.version ?? DASH],
    ]),
  ];
  if (info.error) {
    body.push(node('div', { class: 'muted', text: info.error.message }));
    if (info.error.hint) body.push(node('div', { class: 'muted', text: info.error.hint }));
  }
  if (info.fixCommand) body.push(commandRow(info.fixCommand));
  return card(`${info.label}（${info.bin}）`, badge(label, kind), body);
}

/** 渲染宿主能力卡片。 */
function servicesCard(health) {
  const services = health.runtime?.services ?? {};
  const missing = Object.entries(services)
    .filter(([, present]) => !present)
    .map(([name]) => SERVICE_LABEL[name] ?? name);
  const body = [
    node(
      'div',
      { class: 'chips' },
      Object.entries(services).map(([name, present]) =>
        badge(`${SERVICE_LABEL[name] ?? name}${present ? '' : ' 缺失'}`, present ? 'ok' : 'warn'),
      ),
    ),
    kv([
      ['Node', health.runtime?.node],
      ['DSH', health.runtime?.dshVersion],
      ['平台', `${health.runtime?.platform} / ${health.runtime?.arch}`],
      ['PID', health.runtime?.pid],
      ['已运行', health.runtime ? `${health.runtime.uptimeSec}s` : null],
    ]),
  ];
  if (missing.length > 0) {
    body.push(
      node('div', {
        class: 'muted',
        text: `缺少：${missing.join('、')}。依赖它们的阶段（草稿生成、店铺自动化）会自动降级。`,
      }),
    );
  }
  return card(
    '宿主能力',
    badge(missing.length === 0 ? '齐备' : `${missing.length} 项缺失`, missing.length === 0 ? 'ok' : 'warn'),
    body,
  );
}

/** 渲染数据目录卡片。 */
function dataCard(health) {
  const store = health.store ?? {};
  const body = [
    kv([
      ['profile', health.profileSource === 'default' ? `${health.profile}（宿主未暴露 profile 名）` : health.profile],
      ['数据目录', health.dataDir],
      ['设置文件', health.settingsFile],
      ['队列文件', store.queueFile],
      ['工单数', `${num(store.queueTotal)} 条（rev ${num(store.queueRev)}）`],
      ['审计目录', store.auditDir],
      ['审计分片', `${num(store.auditDays)} 天`],
      ['时区', health.timezone],
    ]),
  ];
  if (health.boot?.error) {
    body.push(node('div', { class: 'muted', text: `初始化警告：${health.boot.error}` }));
  }
  const seeded = health.boot?.playbooks ?? [];
  if (seeded.length > 0) {
    body.push(node('div', { class: 'muted', text: `已补种 ${seeded.length} 个出厂剧本模板` }));
  }
  return card('数据与存储', badge('就绪', health.boot?.error ? 'warn' : 'ok'), body);
}

/** 顶部告警条。 */
function problemsOf(health) {
  const problems = [];
  for (const key of ['ziniao', 'lark']) {
    const info = health.clis[key];
    if (!info.found) problems.push(`${info.label} 未找到`);
    else if (info.error) problems.push(`${info.label} 异常：${info.error.message}`);
  }
  if (health.runtime?.services?.subprocess === false) problems.push('宿主缺少子进程能力');
  return problems;
}

/**
 * 飞书CLI 的当前状态（接没接上）。
 *
 * 「先手动接好飞书CLI，再手动开启邮箱渠道」里的第一步就靠这一行确认：
 * 找到路径 + 能跑出版本号才算接上，附加参数（profile）也会一并回显。
 * @returns {object} DOM 节点。
 */
function larkStatusNode() {
  const info = state.health?.clis?.lark;
  if (!info) return node('span', { class: 'muted', text: '未知（先体检一次）' });
  const args = (info.args ?? []).join(' ');
  if (!info.found) {
    return node('span', { class: 'muted', text: `未找到 lark-cli —— 先安装：${info.install ?? 'npm install -g @larksuite/cli'}` });
  }
  if (info.error) {
    return node('span', { class: 'muted', text: `已找到但不可用：${info.error.message}` });
  }
  return node('span', {
    class: 'muted',
    text: `${info.path ?? 'lark-cli'}${args ? `（附加参数 ${args}）` : ''} · ${info.version ?? '版本未知'}`,
  });
}

/** 表单区域。 */
function settingsForm() {
  const s = state.settings.settings;
  const field = (label, inputNode, hint) =>
    node('label', { class: 'field' }, [
      node('span', { class: 'field-label', text: label }),
      inputNode,
      hint ? node('span', { class: 'field-hint', text: hint }) : null,
    ]);
  const textInput = (id, value, placeholder) =>
    node('input', { type: 'text', id, value: value ?? '', placeholder: placeholder ?? '', spellcheck: 'false' });

  const stateLabel = node('span', { class: 'save-state', id: 'save-state' });

  return panel(
    'CLI 路径与附加参数',
    [
      button('保存设置', () => save(stateLabel), 'primary'),
      stateLabel,
    ],
    [
      node('p', {
        class: 'hint',
        text: '自动探测只在 PATH 与常见安装目录里找。路径留空表示回到自动探测；附加参数会前置到该 CLI 的每一次调用之前（例如 --profile example-lark-profile）。',
      }),
      node('div', { class: 'field-row' }, [
        field('紫鸟CLI 路径（ziniao-cli）', textInput('cli-ziniao', s.cliPaths.ziniao, '/opt/homebrew/bin/ziniao-cli')),
        field('紫鸟CLI 附加参数（一般留空）', textInput('cli-args-ziniao', (s.cliArgs.ziniao ?? []).join(' '), '例如 --profile xxx')),
      ]),
      node('div', { class: 'field-row' }, [
        field('飞书CLI 路径（lark-cli）', textInput('cli-lark', s.cliPaths.lark, '/opt/homebrew/bin/lark-cli')),
        field('飞书CLI 附加参数（身份 / profile）', textInput('cli-args-lark', (s.cliArgs.lark ?? []).join(' '), '例如 --profile 你的profile名')),
      ]),
      node('div', { class: 'field-row' }, [
        field(
          '巡逻邮箱（飞书）',
          textInput('mailboxes', (s.mailboxes ?? []).join(' '), 'support@fusou.vip'),
          '空格或逗号分隔。邮件走 bot 身份，而 bot 无法自动枚举邮箱，所以必须在这里显式填写；留空 = 不巡逻任何邮箱',
        ),
      ]),
      node('div', { class: 'field-row' }, [
        field(
          '启用飞书邮箱渠道',
          node('span', { class: 'field-inline' }, [
            node('input', {
              type: 'checkbox',
              id: 'mail-enabled',
              checked: s.mailEnabled === true,
            }),
            node('span', { class: 'field-inline-note', text: s.mailEnabled === true ? '已启用' : '默认关闭' }),
          ]),
          '邮箱是「别人的地盘」，所以默认关着。要打开请先按下面那行确认飞书CLI 已接好，再勾上这里并保存。',
        ),
        field('飞书CLI 当前状态', larkStatusNode(), null),
      ]),
      node('div', { class: 'field-row' }, [
        field('数据目录', textInput('data-dir', s.dataDir, '留空使用默认目录'), '计划、队列、草稿、审计都放这里'),
        field(
          'SLA 默认时长（小时）',
          textInput('sla-hours', String(s.sla?.defaultHours ?? 24), '24'),
          '工单没写截止时间时，按「收到时间 + 这个小时数」判超时',
        ),
      ]),
      node('div', { class: 'field-row' }, [
        field(
          '审计保留天数',
          textInput('audit-days', String(s.retention?.auditDays ?? 30), '30'),
          '超过这个天数的活动审计分片会被自动清理',
        ),
      ]),
    ],
  );
}

/** 保存设置。 */
async function save(stateLabel) {
  stateLabel.textContent = '保存中…';
  const valueOf = (id) => document.getElementById(id)?.value ?? '';
  try {
    const saved = await post('/settings', {
      cliPaths: { ziniao: valueOf('cli-ziniao').trim(), lark: valueOf('cli-lark').trim() },
      cliArgs: { ziniao: valueOf('cli-args-ziniao'), lark: valueOf('cli-args-lark') },
      mailboxes: valueOf('mailboxes'),
      mailEnabled: document.getElementById('mail-enabled')?.checked === true,
      dataDir: valueOf('data-dir').trim(),
      sla: { defaultHours: valueOf('sla-hours') },
      retention: { auditDays: valueOf('audit-days') },
    });
    stateLabel.textContent = saved.dataDirChanged ? '已保存，数据目录已热切换' : '已保存';
    toast('设置已保存');
    await refresh();
  } catch (cause) {
    stateLabel.textContent = '';
    toast(`保存失败：${cause.message}`, 'error');
  }
}

/** 重新体检。 */
async function redetect() {
  try {
    state.health = await post('/detect');
    renderBody();
    toast('检测完成');
  } catch (cause) {
    toast(`检测失败：${cause.message}`, 'error');
  }
}

/** 拉取设置与体检数据。 */
async function refresh() {
  const [health, settings] = await Promise.all([get('/health'), get('/settings')]);
  state.health = health;
  state.settings = settings;
  renderBody();
}

/** 把当前状态画进容器。 */
function renderBody() {
  const container = document.getElementById('page-body');
  if (!container || !state.health) return;
  const health = state.health;
  clear(container);

  const problems = problemsOf(health);
  if (problems.length > 0) {
    container.appendChild(
      node('div', { class: 'banner' }, [node('span', { text: `需要处理：${problems.join('；')}` })]),
    );
  }

  container.appendChild(
    node('div', { class: 'grid' }, [
      cliCard(health.clis.ziniao),
      cliCard(health.clis.lark),
      servicesCard(health),
      dataCard(health),
    ]),
  );

  container.appendChild(settingsForm());

  container.appendChild(
    panel('原始数据', null, [
      node('details', {}, [
        node('summary', { text: '展开 /cs/api/health 返回' }),
        node('pre', { text: JSON.stringify(health, null, 2) }),
      ]),
    ]),
  );
}

/**
 * 页面入口。
 * @param {HTMLElement} container - 页面容器（内容会渲染进 `#page-body`）。
 * @param {{onRefresh: Function}} ctx - 外壳上下文。
 * @returns {Promise<void>} 完成。
 */
export async function render(container, ctx) {
  clear(container);
  container.appendChild(
    node('div', { class: 'page-actions' }, [
      button('重新检测', redetect),
      button('刷新', () => refresh().catch((cause) => toast(cause.message, 'error'))),
    ]),
  );
  container.appendChild(node('div', { class: 'page-body', id: 'page-body' }));
  await refresh();
  ctx?.registerRefresh?.(() => refresh());
}
