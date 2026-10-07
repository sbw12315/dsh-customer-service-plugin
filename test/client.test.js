import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SOURCE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');

/** 极简 React 桩：只够跑 createElement / useState / useEffect。 */
function reactStub() {
  return {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
  };
}

/**
 * 在沙箱里加载客户端 bundle，返回它注册的入口与捕获到的 ctx。
 *
 * `slotsMode` 刻意建模 DSH 客户端的**真实**上下文形状：
 *   - `property`（默认）：服务挂在 `ctx.slots` 上，靠 `inject: ['slots']` 声明 —— DSH 的写法；
 *   - `get`：只有 `ctx.get('slots')`，用来保证向后兼容没被破坏；
 *   - `none` / `broken`：拿不到服务 / 服务不完整，用于验证降级路径。
 *
 * 早先这里只提供 `ctx.get`，于是「用错访问方式」这个 bug 反而被测试固化了下来。
 * @param {{slotsMode?: 'property'|'get'|'none'|'broken', dom?: object|undefined}} [options] - 沙箱开关。
 * @returns {{entry: object, registrations: object[], ctx: object, components: object[]}} 结果。
 */
function loadBundle(options = {}) {
  const entry = { captured: null };
  const registrations = [];
  const components = [];
  const slotsMode = options.slotsMode ?? 'property';
  const slots =
    slotsMode === 'none'
      ? undefined
      : slotsMode === 'broken'
        ? {}
        : {
            inject: (name, callback) => callback(),
            register: (opts, component) => {
              registrations.push(opts);
              components.push(component);
              return () => {};
            },
          };

  const sandboxWindow = {
    __ModuleLoader__: {
      load: (value) => {
        entry.captured = value;
      },
    },
    matchMedia: options.matchMedia ?? (() => ({ matches: false })),
  };
  const require = (spec) => {
    if (spec === 'react') return reactStub();
    throw new Error(`unexpected require(${spec})`);
  };

  const factory = new Function('window', 'document', 'getComputedStyle', 'self', SOURCE);
  factory(sandboxWindow, options.dom, options.getComputedStyle, sandboxWindow);

  assert.ok(entry.captured, 'bundle 应该调用 window.__ModuleLoader__.load');
  const exports = entry.captured.factory(require);

  const ctx = { effect: (fn) => fn() };
  if (slotsMode === 'property') ctx.slots = slots;
  if (slotsMode === 'get') ctx.get = (key) => (key === 'slots' ? slots : undefined);
  return { entry: entry.captured, exports, ctx, registrations, components };
}

/**
 * 把函数组件递归展开成宿主元素（React 桩不做渲染，测试里自己展开）。
 * @param {any} element - createElement 的结果。
 * @returns {any} 展开后的宿主元素。
 */
function render(element) {
  let current = element;
  for (let depth = 0; depth < 16; depth += 1) {
    if (current === null || current === undefined) return current;
    if (typeof current === 'function') {
      current = current({});
      continue;
    }
    if (typeof current === 'object' && typeof current.type === 'function') {
      current = current.type(current.props ?? {});
      continue;
    }
    return current;
  }
  throw new Error('组件展开层数过深，可能存在渲染循环');
}

/** 取某个槽位注册的组件并渲染成宿主元素。 */
function renderSlot(registrations, components, slotName) {
  const index = registrations.findIndex((item) => item.name === slotName);
  assert.ok(index >= 0, `没有注册 ${slotName}`);
  return render(components[index]());
}

test('bundle 契约：id 必须等于包名，且导出 apply/inject', () => {
  const { entry, exports } = loadBundle();
  assert.equal(entry.id, 'dsh-customer-service-plugin');
  assert.equal(typeof entry.factory, 'function');
  assert.equal(typeof exports.apply, 'function');
  // 必须声明 slots：DSH 客户端上下文用 inject 决定把哪个服务挂到 ctx 上。
  assert.deepEqual(exports.inject, ['slots']);
  assert.equal(exports.__consolePath, '/cs/');
});

test('只 require("react")，不碰其它模块', () => {
  // require 在桩里只认 react；一旦 bundle 引入别的模块就会抛错。
  assert.doesNotThrow(() => loadBundle());
});

test('注册 A + B 四个入口：侧栏按钮、浮层、侧栏图标、主区面板', () => {
  const { exports, ctx, registrations } = loadBundle();
  exports.apply(ctx);
  assert.deepEqual(
    registrations.map((item) => item.name),
    ['sidebar.footer.action', 'shell.overlay', 'sidebar.panellist', 'main'],
  );
  assert.equal(registrations[0].id, 'customer-service');
  assert.equal(registrations[1].id, 'customer-service-overlay');
  assert.equal(registrations[2].id, 'customer-service');
  assert.equal(registrations[3].key, 'customer-service');
  // 列表槽位需要 order 决定先后；keyed 槽位（main）用 key 定位，不接受 order。
  for (const item of registrations.filter((entry) => entry.name !== 'main')) {
    assert.equal(typeof item.order, 'number');
  }
  assert.equal(registrations.filter((item) => item.name === 'main')[0].order, undefined);
});

test('DSH 的真实上下文形状（只有 ctx.slots 属性）也能挂上四个入口', () => {
  // 这是回归保护：真机上服务就是挂在 ctx.slots 上的，用 ctx.get('slots') 拿不到。
  const { exports, ctx, registrations } = loadBundle({ slotsMode: 'property' });
  assert.equal(typeof ctx.get, 'undefined', '本用例刻意不提供 ctx.get');
  exports.apply(ctx);
  assert.deepEqual(
    registrations.map((item) => item.name),
    ['sidebar.footer.action', 'shell.overlay', 'sidebar.panellist', 'main'],
  );
});

test('旧版只有 ctx.get("slots") 时仍然兼容', () => {
  const { exports, ctx, registrations } = loadBundle({ slotsMode: 'get' });
  exports.apply(ctx);
  assert.equal(registrations.length, 4);
});

test('拿不到 slots 时不抛异常，但必须留下痕迹（不再静默）', () => {
  const { exports, ctx } = loadBundle({ slotsMode: 'none' });
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    assert.doesNotThrow(() => exports.apply(ctx));
  } finally {
    console.error = originalError;
  }
  assert.equal(logged.length, 1, '静默失败正是这次「按钮不见了」查不出原因的原因');
  assert.match(logged[0], /slots/);
});

test('slots 缺 inject/register 时同样安全降级', () => {
  const { exports, ctx } = loadBundle({ slotsMode: 'broken' });
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.doesNotThrow(() => exports.apply(ctx));
  } finally {
    console.error = originalError;
  }
});

test('主区面板渲染成一个指向 /cs/ 的 iframe', () => {
  const { exports, ctx, registrations, components } = loadBundle();
  exports.apply(ctx);
  const element = renderSlot(registrations, components, 'main');
  assert.equal(element.type, 'iframe');
  assert.equal(element.props.title, '客服控制台');
  assert.equal(element.props.src, '/cs/');
});

test('能读到宿主背景色时，把明暗结论透传给 iframe', () => {
  const dark = loadBundle({
    dom: {},
    getComputedStyle: () => ({ getPropertyValue: () => '#17181b' }),
  });
  dark.exports.apply(dark.ctx);
  assert.equal(renderSlot(dark.registrations, dark.components, 'main').props.src, '/cs/?theme=dark');

  const light = loadBundle({
    dom: {},
    getComputedStyle: () => ({ getPropertyValue: () => '#ffffff' }),
  });
  light.exports.apply(light.ctx);
  assert.equal(renderSlot(light.registrations, light.components, 'main').props.src, '/cs/?theme=light');
});

test('宿主背景色认不出来时退回 prefers-color-scheme', () => {
  const light = loadBundle({
    dom: {},
    getComputedStyle: () => ({ getPropertyValue: () => 'rgb(23, 24, 27)' }),
    matchMedia: () => ({ matches: false }),
  });
  light.exports.apply(light.ctx);
  assert.equal(renderSlot(light.registrations, light.components, 'main').props.src, '/cs/?theme=light');

  const dark = loadBundle({
    dom: {},
    getComputedStyle: () => ({ getPropertyValue: () => '#17181b' }),
    matchMedia: () => ({ matches: true }),
  });
  dark.exports.apply(dark.ctx);
  assert.equal(renderSlot(dark.registrations, dark.components, 'main').props.src, '/cs/?theme=dark');
});

test('连 matchMedia 都没有时，still 退化成一个可用的绝对地址', () => {
  const { exports, ctx, registrations, components, entry } = loadBundle({ dom: {}, getComputedStyle: undefined });
  exports.apply(ctx);
  // getComputedStyle 缺失会让 hostTheme 抛错并被 catch，最终仍要能给出地址。
  const element = renderSlot(registrations, components, 'main');
  assert.equal(element.type, 'iframe');
  assert.match(String(element.props.src), /^\/cs\/?/);
  assert.equal(entry.id, 'dsh-customer-service-plugin');
});

test('浮层关闭时返回 null；底部按钮是可点击的「客服」', () => {
  const { exports, ctx, registrations, components } = loadBundle();
  exports.apply(ctx);
  assert.equal(renderSlot(registrations, components, 'shell.overlay'), null);

  const rendered = renderSlot(registrations, components, 'sidebar.footer.action');
  assert.equal(rendered.type, 'button');
  assert.equal(rendered.props.title, '客服控制台');
  assert.equal(rendered.props['aria-expanded'], 'false');
  // 图标在前、文案在后
  assert.equal(rendered.children[1], '客服');
  const buttonIcon = render(rendered.children[0]);
  assert.equal(buttonIcon.type, 'svg');
});

test('侧栏图标是内联矢量耳机，不依赖字体或 emoji', () => {
  const { exports, ctx, registrations, components } = loadBundle();
  exports.apply(ctx);
  const element = renderSlot(registrations, components, 'sidebar.panellist');
  assert.equal(element.type, 'span');
  assert.equal(element.props.title, '客服');

  const svg = render(element.children[0]);
  assert.equal(svg.type, 'svg');
  assert.equal(svg.props.viewBox, '0 0 24 24');
  assert.equal(svg.props.stroke, 'currentColor', '要跟宿主明/暗主题的文字色走');
  assert.equal(svg.props['aria-hidden'], 'true');
  assert.deepEqual(
    svg.children.map((child) => child.type),
    ['path', 'rect', 'rect', 'path'],
    '听筒带 + 两只耳罩 + 麦克风',
  );
  // 图标不能是位图 / 字体：整段源码里不该出现 emoji 或 base64 图。
  assert.equal(/[\u{1F300}-\u{1FAFF}]/u.test(SOURCE), false, '不要用 emoji 当图标');
  assert.equal(/data:image\//.test(SOURCE), false, '不要内嵌位图');
});
