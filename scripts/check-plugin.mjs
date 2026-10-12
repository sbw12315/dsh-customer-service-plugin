#!/usr/bin/env node
/**
 * 对**正在运行的** DSH 实例做一次控制台自检。
 *
 * 用途：改完宿主半代码后，判断「当前进程加载的到底是新模块还是旧模块」——
 * 因为 Node 的 ESM 模块按文件路径缓存，重启 DSH 之前它会一直用旧代码，
 * 而界面上是旧是新肉眼分辨不出来。
 *
 * 用法：
 *   node scripts/check-plugin.mjs                 # 默认 http://127.0.0.1:19387
 *   node scripts/check-plugin.mjs http://127.0.0.1:19488
 */

const base = (process.argv[2] ?? 'http://127.0.0.1:19387').replace(/\/+$/, '');

/** 打印一行带标记的检查结果。 */
function line(ok, label, detail) {
  const mark = ok === true ? '✓' : ok === false ? '✗' : '·';
  console.log(`  ${mark} ${label}${detail ? `  ${detail}` : ''}`);
}

let health;
try {
  const res = await fetch(`${base}/cs/api/health`, { signal: AbortSignal.timeout(8000) });
  const payload = await res.json();
  if (!res.ok || payload?.ok !== true) throw new Error(payload?.error?.message ?? `HTTP ${res.status}`);
  health = payload.data;
} catch (cause) {
  console.error(`✗ 取不到 ${base}/cs/api/health`);
  console.error(`  ${cause instanceof Error ? cause.message : String(cause)}`);
  console.error('  排查：控制台是否已挂载？DSH 是否在运行？端口对不对？');
  process.exit(1);
}

const isNew = Object.prototype.hasOwnProperty.call(health, 'profileSource');
const fromSettings = (key) => health.clis[key].via === 'settings';

console.log(`实例：${base}`);
console.log(`插件：${health.plugin.id} ${health.plugin.version}`);
console.log(`进程已运行：${health.runtime.uptimeSec}s`);
console.log('');

console.log('模块版本');
line(isNew, '宿主半是新代码', isNew ? '' : '→ 仍是修好之前加载的旧模块，需要重启 DSH');
line(
  fromSettings('ziniao') && fromSettings('lark'),
  '读到了 settings.json 里手动指定的路径',
  fromSettings('ziniao') && fromSettings('lark') ? '' : '→ 旧模块不会读 cliPaths',
);

console.log('');
console.log('CLI 状态');
for (const key of ['ziniao', 'lark']) {
  const info = health.clis[key];
  const args = info.args?.length ? ` ${info.args.join(' ')}` : '';
  line(Boolean(info.found), `${info.label} 已定位`, info.path ?? '未找到');
  line(
    Boolean(info.version),
    `${info.label} 可执行`,
    info.version ? `${info.version}${args}` : `[${info.error?.kind ?? '?'}] ${info.error?.message ?? ''}`,
  );
  if (info.error?.hint) console.log(`      ${info.error.hint}`);
  if (info.error?.fixCommand) console.log(`      修复：${info.error.fixCommand}`);
}

console.log('');
console.log('宿主能力');
const services = health.runtime.services ?? {};
const missing = Object.entries(services)
  .filter(([, present]) => !present)
  .map(([name]) => name);
line(missing.length === 0, '六项服务齐备', missing.length ? `缺少 ${missing.join(', ')}` : '');

/* ── 控制台与接口：判断跑的是不是「工作台 + 设置」这一版 ─────────────────── */
console.log('');
console.log('控制台与接口');
const probe = async (apiPath) => {
  try {
    const res = await fetch(`${base}${apiPath}`, { signal: AbortSignal.timeout(8000) });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (cause) {
    return { ok: false, status: 0, text: String(cause?.message ?? cause) };
  }
};

const page = await probe('/cs/');
line(page.ok && page.text.includes('js/main.js'), '入口页已切到模块化控制台', page.ok ? '' : `HTTP ${page.status}`);
line(page.ok && page.text.includes('mainnav'), '含一级导航容器');

const mainModule = await probe('/cs/js/main.js');
line(mainModule.ok, '前端模块可加载', mainModule.ok ? '' : `HTTP ${mainModule.status}`);

const meta = await probe('/cs/api/meta');
const stats = await probe('/cs/api/stats?days=7');
const queue = await probe('/cs/api/queue?limit=1');
const patrol = await probe('/cs/api/patrol');
const drafts = await probe('/cs/api/drafts?limit=1');
let metaOk = false;
let statsOk = false;
let queueOk = false;
let queueTotal = null;
let patrolOk = false;
let patrolStores = null;
let autoOk = false;
let draftsOk = false;
let draftsTotal = null;
try {
  const data = JSON.parse(meta.text).data;
  // 逐个渠道点名，而不是数字数：数数会在「加了渠道」那天直接变成假警报
  // （原来写的是 === 4，SHEIN 接进来之后就一直是 false，体检报告会说后端是旧模块）。
  const channels = data?.dimensions?.channels ?? [];
  metaOk =
    Array.isArray(channels) &&
    ['mail', 'amazon', 'tiktok', 'walmart', 'shein', 'temu'].every((id) => channels.includes(id)) &&
    Boolean(data?.drafts?.statuses) &&
    Boolean(data?.patrol?.defaults);
} catch {
  metaOk = false;
}
try {
  statsOk = typeof JSON.parse(stats.text).data?.business?.hasData === 'boolean';
} catch {
  statsOk = false;
}
try {
  const parsed = JSON.parse(queue.text);
  queueOk = Array.isArray(parsed.data?.items) && typeof parsed.data?.total === 'number';
  queueTotal = parsed.data?.total ?? null;
} catch {
  queueOk = false;
}
try {
  const parsed = JSON.parse(patrol.text);
  patrolOk =
    typeof parsed.data?.running === 'boolean' &&
    Array.isArray(parsed.data?.channels) &&
    Boolean(parsed.data?.sources?.amazon);
  patrolStores = parsed.data?.sources?.amazon?.items?.length ?? null;
  // 定时巡检是不是「每个平台一份」这一版：旧模块只有全局 enabled / times，
  // 界面会因此画不出每平台那份面板 —— 字段名都在，肉眼从响应里看不出来。
  autoOk = Boolean(parsed.data?.autoPatrol?.channels?.amazon);
} catch {
  patrolOk = false;
}
try {
  const parsed = JSON.parse(drafts.text);
  draftsOk = Array.isArray(parsed.data?.items) && typeof parsed.data?.total === 'number';
  draftsTotal = parsed.data?.total ?? null;
} catch {
  draftsOk = false;
}
line(metaOk, 'GET /api/meta 可用（含草稿与巡逻维度）', metaOk ? '' : '旧模块没有这些字段 → 需要重启 DSH');
line(statsOk, 'GET /api/stats 可用');
line(queueOk, 'GET /api/queue 可用', queueOk ? `现有 ${queueTotal} 条工单` : '');
line(patrolOk, 'GET /api/patrol 可用（一键巡逻）', patrolOk ? `识别到 ${patrolStores} 家亚马逊店铺` : '重启 DSH 后可用');
line(
  Boolean(meta.text) && Boolean(JSON.parse(meta.text).data?.patrol?.channels?.length),
  '巡逻渠道已注册',
  meta.text ? (JSON.parse(meta.text).data?.patrol?.channels ?? []).join('、') || '—' : '—',
);
line(draftsOk, 'GET /api/drafts 可用（草稿库）', draftsOk ? `现有 ${draftsTotal} 条草稿` : '重启 DSH 后可用');
line(
  autoOk,
  '定时巡检是「每个平台一份」这一版',
  autoOk ? '按平台各设时刻与店铺' : '旧模块只有全局 enabled / times → 需要重启 DSH',
);

console.log('');
const verdict =
  isNew &&
  fromSettings('ziniao') &&
  fromSettings('lark') &&
  Boolean(health.clis.ziniao.version) &&
  Boolean(health.clis.lark.version) &&
  page.ok &&
  mainModule.ok &&
  metaOk &&
  statsOk &&
  queueOk &&
  patrolOk &&
  autoOk &&
  draftsOk;
console.log(verdict ? '结论：一切正常。' : '结论：还有问题，见上面标 ✗ 的行。');
process.exitCode = verdict ? 0 : 2;
