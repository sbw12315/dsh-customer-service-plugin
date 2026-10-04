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
 * @param {{slots?: object|undefined, dom?: object|undefined}} [options] - 沙箱开关。
 * @returns {{entry: object, registrations: object[], ctx: object, components: object[]}} 结果。
 */
function loadBundle(options = {}) {
  const entry = { captured: null };
  const registrations = [];
  const components = [];
  const slots =
    options.slots === undefined
      ? {
          inject: (name, callback) => callback(),
          register: (opts, component) => {
            registrations.push(opts);
            components.push(component);
            return () => {};
          },
        }
      : options.slots;

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

  const ctx = {
    get: (key) => (key === 'slots' ? slots : undefined),
    effect: (fn) => fn(),
  };
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
  assert.deepEqual(exports.inject, []);
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

test('拿不到 slots 时静默跳过，绝不抛异常', () => {
  const { exports, ctx } = loadBundle({ slots: undefined });
  ctx.get = () => undefined;
  assert.doesNotThrow(() => exports.apply(ctx));
});

test('slots 缺 inject/register 时同样安全降级', () => {
  const { exports, ctx } = loadBundle({ slots: {} });
  assert.doesNotThrow(() => exports.apply(ctx));
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
  assert.deepEqual(rendered.children, ['客服']);
});

test('侧栏图标是一段可点开的文本节点', () => {
  const { exports, ctx, registrations, components } = loadBundle();
  exports.apply(ctx);
  const element = renderSlot(registrations, components, 'sidebar.panellist');
  assert.equal(element.type, 'span');
  assert.equal(element.props.title, '客服');
  assert.deepEqual(element.children, ['客服']);
});
