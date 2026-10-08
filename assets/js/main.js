/**
 * 控制台外壳：两级导航 + hash 路由 + 自动刷新。
 *
 * 为什么用 hash 路由而不是真实路径：静态资源层已经有「无扩展名回落到入口页」的规则，
 * 但真实路径会牵动服务端的 SPA 回落与 `<base>`；hash 路由零改动、刷新不丢位置、
 * 直连 `#/work/queue` 也能定位。
 */

import { get } from './api.js';
import { byId, clear, node, toast } from './dom.js';

/** 路由表。`group` 决定一级导航归属，`label` 是二级页签名。 */
const ROUTES = [
  { hash: '#/work/patrol', group: 'work', label: '巡逻', load: () => import('./page-patrol.js') },
  { hash: '#/work/queue', group: 'work', label: '队列', load: () => import('./page-queue.js') },
  { hash: '#/work/stats', group: 'work', label: '统计', load: () => import('./page-stats.js') },
  { hash: '#/settings', group: 'settings', label: '设置', load: () => import('./page-settings.js') },
];

const GROUPS = [
  { id: 'work', label: '工作台' },
  { id: 'settings', label: '设置' },
];

const DEFAULT_HASH = '#/work/stats';
const AUTO_REFRESH_MS = 60_000;

/** 当前页面注册的刷新函数（自动刷新与顶栏刷新都用它）。 */
let currentRefresh = null;
/** 自动刷新计时器。 */
let autoTimer = null;

/** 解析当前 hash 到路由。 */
function currentRoute() {
  const hash = location.hash || DEFAULT_HASH;
  return ROUTES.find((route) => route.hash === hash) ?? ROUTES[0];
}

/** 画一级导航。 */
function renderMainNav(active) {
  const nav = byId('mainnav');
  clear(nav);
  const activeGroup = ROUTES.find((route) => route.hash === active.hash)?.group;
  for (const group of GROUPS) {
    const first = ROUTES.find((route) => route.group === group.id);
    nav.appendChild(
      node('a', {
        class: `mainnav-item${group.id === activeGroup ? ' is-active' : ''}`,
        href: first.hash,
        text: group.label,
      }),
    );
  }
}

/** 画二级页签（只有工作台有）。 */
function renderSubNav(active) {
  const nav = byId('subnav');
  const sameGroup = ROUTES.filter((route) => route.group === active.group);
  clear(nav);
  if (sameGroup.length <= 1) {
    nav.hidden = true;
    return;
  }
  nav.hidden = false;
  for (const route of sameGroup) {
    nav.appendChild(
      node('a', {
        class: `tab${route.hash === active.hash ? ' is-active' : ''}`,
        href: route.hash,
        text: route.label,
      }),
    );
  }
}

/**
 * 这份前端资源要求宿主半提供的接口契约。
 *
 * 刻意**不比对版本号字符串**：页面顶栏的版本号是宿主半注入的（`__CS_VERSION__` 来自
 * 被缓存的模块），旧后端会把它自己那个旧版本号注入进来，两边一比就是「相等」，
 * 反而检测不出错配。要探的是**能力**：新前端要的接口在不在、渠道枚举里有没有 amazon。
 */
const HOST_CONTRACT = {
  channels: ['amazon'],
  metaKeys: ['drafts', 'patrol'],
  // 设置页的「禁用 / 启用 CLI」开关要靠 /health 里的 clis[*].enabled 才画得对：
  // 旧后端没有这个字段，按钮会照常出现、点下去却静默无效 —— 那比不显示更糟。
  healthClis: ['ziniao', 'lark'],
  // 能力位：新前端要用、旧后端还没有的功能。缺了就在顶部提示重启，别让人点空按钮。
  capabilities: ['drafts.delete'],
};

/** 错配时把「缺了什么」记下来，贴在提示里，避免使用者只看到一句 404。 */
let hostMismatchMissing = [];

/**
 * 启动时确认宿主半的能力是否跟得上这份前端资源，只置标记，由每次渲染后统一贴提示。
 *
 * 前端资源是**每次请求现读**的，而后端模块被 Node 按路径缓存 —— 改了插件之后
 * 「页面已经是新版、接口还是旧版」是常态而不是异常。不主动探测的话，使用者看到的
 * 只会是「未知接口 GET /patrol」这种没法处理的报错，也解释不了「渠道里怎么没有 Amazon」。
 * @returns {Promise<void>} 完成。
 */
async function checkHostVersion() {
  let meta = null;
  try {
    meta = await get('/meta');
  } catch (cause) {
    hostMismatch = cause?.status === 404;
    hostMismatchMissing = hostMismatch ? ['GET /api/meta'] : [];
    return;
  }
  const missing = [];
  const channels = meta?.dimensions?.channels ?? [];
  for (const channel of HOST_CONTRACT.channels) {
    if (!channels.includes(channel)) missing.push(`渠道 ${channel}`);
  }
  for (const key of HOST_CONTRACT.metaKeys) {
    if (!(meta && key in meta)) missing.push(`/api/meta 的 ${key}`);
  }
  const capabilities = meta?.capabilities ?? [];
  for (const capability of HOST_CONTRACT.capabilities) {
    if (!capabilities.includes(capability)) missing.push(`能力 ${capability}`);
  }
  if (missing.length === 0) {
    try {
      const health = await get('/health');
      for (const key of HOST_CONTRACT.healthClis) {
        if (typeof health?.clis?.[key]?.enabled !== 'boolean') {
          missing.push(`/api/health 的 clis.${key}.enabled`);
        }
      }
    } catch {
      // 体检接口偶发失败不该弹出「请重启 DSH」：那是另一个问题，设置页自己会报错。
    }
  }
  hostMismatchMissing = missing;
  hostMismatch = missing.length > 0;
}

/** 设置自动刷新开关。 */
function setAutoRefresh(enabled) {
  clearInterval(autoTimer);
  autoTimer = null;
  if (!enabled) return;
  autoTimer = setInterval(() => {
    // 页面不可见时不刷新：省掉后台无意义的请求。
    if (document.visibilityState !== 'visible') return;
    if (typeof currentRefresh === 'function') {
      Promise.resolve(currentRefresh()).catch(() => {});
    }
  }, AUTO_REFRESH_MS);
}

/** 手动刷新当前页。 */
async function refreshNow() {
  if (typeof currentRefresh !== 'function') return;
  try {
    await currentRefresh();
    toast('已刷新');
  } catch (cause) {
    toast(`刷新失败：${cause?.message ?? cause}`, 'error');
  }
}

/** 宿主半与前端不匹配时为 true，每次渲染后都要把提示贴回去。 */
let hostMismatch = false;

/** 把版本错配的提示贴到页面顶部。 */
function prependMismatchBanner(container) {
  if (!hostMismatch) return;
  container.prepend(
    node('div', { class: 'banner banner-error' }, [
      node('strong', { text: '这页的界面是新的，但插件的后端还是旧版本，所以接口对不上。' }),
      node('span', {
        text: ` 缺少：${hostMismatchMissing.join('、')}。页面资源是每次请求现读的，所以已经更新；后端模块被 Node 按文件路径缓存在内存里，必须重启 DSH 才会重新加载。`,
      }),
      node('div', { class: 'muted', text: '请完全退出 DeepSeek Harness 再重新打开（只刷新页面没用）。命令行确认：node scripts/check-plugin.mjs' }),
    ]),
  );
}

/** 渲染当前路由。 */
async function navigate() {
  const route = currentRoute();
  if (!location.hash) location.hash = route.hash;
  renderMainNav(route);
  renderSubNav(route);

  const container = byId('content');
  clear(container);
  currentRefresh = null;
  container.appendChild(node('div', { class: 'loading', text: '加载中…' }));

  try {
    const module = await route.load();
    clear(container);
    await module.render(container, {
      registerRefresh(fn) {
        currentRefresh = fn;
      },
    });
  } catch (cause) {
    clear(container);
    container.appendChild(
      node('div', { class: 'banner banner-error' }, [
        node('span', {
          text: hostMismatch
            ? `页面加载失败：${cause?.message ?? cause}（根因见上方提示）`
            : `页面加载失败：${cause?.message ?? cause}`,
        }),
      ]),
    );
  }
  prependMismatchBanner(container);
}

byId('refresh').addEventListener('click', refreshNow);
byId('auto').addEventListener('change', (event) => setAutoRefresh(event.target.checked));
window.addEventListener('hashchange', () => {
  navigate().catch((cause) => toast(String(cause), 'error'));
});

setAutoRefresh(byId('auto').checked);
checkHostVersion().finally(() => {
  navigate().catch((cause) => toast(String(cause), 'error'));
});
