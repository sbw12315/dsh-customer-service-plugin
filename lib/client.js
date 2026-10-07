/**
 * 客服插件 —— Client 半（浏览器端）。
 *
 * 这是宿主 `window.__ModuleLoader__` 的懒加载 CJS 工厂格式（和 DSH 自带客户端插件
 * 产出的 bundle 同形）。刻意只用 `require("react")`：React 是两版 DSH 都有的兜底模块，
 * 其余一律不引，最大化跨版本可安装性。
 *
 * 挂两个入口：
 *   A. `sidebar.footer.action` 一个「客服」按钮 + `shell.overlay` 浮层；
 *   B. `sidebar.panellist` 图标 + `main` 键为 customer-service 的主区工作台。
 * 两者都只是 `/cs/` 这个插件自建页面的壳；`slots` 拿不到就整体静默跳过，
 * 用户可以直连 /cs/ ，功能不受影响。
 *
 * @module dsh-customer-service-plugin/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-customer-service-plugin',
  factory: (require) => {
    const React = require('react');
    const module = { exports: {} };
    const exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const h = React.createElement;

    const ID = 'customer-service';
    const CONSOLE_PATH = '/cs/';
    const SLOT_FOOTER = 'sidebar.footer.action';
    const SLOT_OVERLAY = 'shell.overlay';
    const SLOT_PANEL = 'sidebar.panellist';
    const SLOT_MAIN = 'main';

    /**
     * 猜出宿主当前是明色还是暗色。
     *
     * iframe 有独立的 document，宿主页面的 CSS 变量不会继承进去，所以这里只把
     * 明/暗这个结论通过查询参数传给控制台页，由控制台页自己切换配色。
     * @returns {'light'|'dark'|null} 主题，判断不出来返回 null。
     */
    function hostTheme() {
      try {
        const raw = getComputedStyle(document.documentElement)
          .getPropertyValue('--dsw-alias-bg-base')
          .trim();
        const match = /^#([0-9a-f]{6})$/i.exec(raw);
        if (match) {
          const value = Number.parseInt(match[1], 16);
          const r = (value >> 16) & 0xff;
          const g = (value >> 8) & 0xff;
          const b = value & 0xff;
          return 0.299 * r + 0.587 * g + 0.114 * b < 140 ? 'dark' : 'light';
        }
        if (/^#([0-9a-f]{3})$/i.test(raw)) {
          const short = raw.slice(1);
          const expanded = Number.parseInt(
            short
              .split('')
              .map((c) => c + c)
              .join(''),
            16,
          );
          const r = (expanded >> 16) & 0xff;
          const g = (expanded >> 8) & 0xff;
          const b = expanded & 0xff;
          return 0.299 * r + 0.587 * g + 0.114 * b < 140 ? 'dark' : 'light';
        }
        if (window.matchMedia) {
          return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        }
        return null;
      } catch {
        return null;
      }
    }

    /** 控制台地址：带上主题提示。 */
    function consoleUrl() {
      const theme = hostTheme();
      return theme ? `${CONSOLE_PATH}?theme=${theme}` : CONSOLE_PATH;
    }

    /* ── 跨 slot 共享的开关状态 ─────────────────────────────────────────────
       按钮在 sidebar.footer.action、浮层在 shell.overlay，是两个不同 Slot，
       所以用一个最小的外部 store 让它们共享状态。 */
    const listeners = new Set();
    let isOpen = false;
    const toggleStore = {
      get: () => isOpen,
      set(next) {
        isOpen = next;
        for (const listener of [...listeners]) {
          try {
            listener();
          } catch {
            /* 单个订阅者出错不影响其它 */
          }
        }
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };

    /** 订阅开关状态。 */
    function useOpen() {
      const [, force] = React.useState(0);
      React.useEffect(
        () =>
          toggleStore.subscribe(() => {
            force((n) => n + 1);
          }),
        [],
      );
      return [toggleStore.get(), toggleStore.set];
    }

    /* ── 样式：全部走 DSH 主题变量，带兜底值，独立打开 /cs/ 也不会难看 ── */
    const css = {
      button: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        minHeight: 24,
        padding: '2px 8px',
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l1, #3a3a3a)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
        font: 'inherit',
        fontSize: 12,
        cursor: 'pointer',
      },
      icon: {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 12,
        lineHeight: '18px',
      },
      overlay: {
        position: 'fixed',
        right: 20,
        bottom: 64,
        width: 460,
        height: 620,
        maxWidth: 'calc(100vw - 40px)',
        maxHeight: 'calc(100vh - 96px)',
        display: 'flex',
        flexDirection: 'column',
        pointerEvents: 'auto',
        borderRadius: 12,
        overflow: 'hidden',
        border: '1px solid var(--dsw-alias-border-l1, #3a3a3a)',
        background: 'var(--dsw-alias-bg-layer-2, #212121)',
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.35)',
        zIndex: 1000,
      },
      bar: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
        padding: '8px 12px',
        borderBottom: '1px solid var(--dsw-alias-border-l1, #3a3a3a)',
        color: 'var(--dsw-alias-label-primary, #e6e6e6)',
        fontSize: 12,
      },
      barActions: { display: 'inline-flex', alignItems: 'center', gap: 8 },
      link: {
        color: 'var(--dsw-alias-label-secondary, #9a9a9a)',
        textDecoration: 'none',
        fontSize: 12,
      },
      close: {
        border: 0,
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary, #9a9a9a)',
        cursor: 'pointer',
        font: 'inherit',
        fontSize: 12,
      },
      frame: { flex: 1, width: '100%', border: 0, background: 'transparent' },
      main: { display: 'block', width: '100%', height: '100%', border: 0 },
    };

    /** 控制台 iframe：整个插件的界面都在 /cs/ 这个自建页面里。 */
    function ConsoleFrame(props) {
      return h('iframe', {
        src: consoleUrl(),
        title: '客服控制台',
        style: props && props.main ? css.main : css.frame,
      });
    }

    /**
     * 插件图标：一副客服耳机（听筒带 + 两只耳罩 + 麦克风）。
     *
     * 刻意内联成 SVG 而不是引外部文件：
     *   - Client 半只能是 `window.__ModuleLoader__` 的 CJS 工厂，多一个资源请求就多一处
     *     跨版本失败点；
     *   - 描边用 `currentColor`，明色/暗色主题下都跟着宿主文字颜色走，不用两套图；
     *   - 16~18px 的侧栏尺寸下，耳机是少数还认得出的客服符号。
     * 同一套路径也画进了 assets/icon.svg（favicon / 文档用）。
     * @param {{size?: number}} [props] - 边长，默认 16。
     * @returns {object} React 元素。
     */
    function HeadsetIcon(props) {
      const size = (props && props.size) || 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block', flex: 'none' },
        },
        h('path', { d: 'M4 10a8 8 0 0 1 16 0' }),
        h('rect', { x: 1.5, y: 10, width: 5, height: 7, rx: 2.5 }),
        h('rect', { x: 17.5, y: 10, width: 5, height: 7, rx: 2.5 }),
        h('path', { d: 'M20 17v1.5a3 3 0 0 1-3 3h-3.5' }),
      );
    }

    /** A-1：侧边栏底部的「客服」按钮。 */
    function FooterButton() {
      const [open, setOpen] = useOpen();
      return h(
        'button',
        {
          type: 'button',
          title: '客服控制台',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen(!open),
          style: css.button,
        },
        h(HeadsetIcon, { size: 14 }),
        '客服',
      );
    }

    /** A-2：浮层里的控制台面板。 */
    function OverlayPanel() {
      const [open, setOpen] = useOpen();
      if (!open) return null;
      return h(
        'div',
        { style: css.overlay, role: 'dialog', 'aria-label': '客服控制台' },
        h(
          'div',
          { style: css.bar },
          h('span', null, '客服控制台'),
          h(
            'span',
            { style: css.barActions },
            h('a', { href: consoleUrl(), target: '_blank', rel: 'noreferrer', style: css.link }, '新标签打开'),
            h('button', { type: 'button', onClick: () => setOpen(false), style: css.close }, '关闭'),
          ),
        ),
        h(ConsoleFrame, null),
      );
    }

    /** B-1：侧边栏图标（点击后由外壳切到同名 main 面板）。 */
    function PanelIcon() {
      return h('span', { style: css.icon, title: '客服' }, h(HeadsetIcon, { size: 18 }));
    }

    /** B-2：主区工作台。 */
    function MainPanel() {
      return h(ConsoleFrame, { main: true });
    }

    /**
     * 依赖 `slots` 服务（DSH 浏览器端的 slot registry）。
     *
     * **必须在这里声明。** 这正是侧边栏按钮不出现的根因：旧代码声明 `[]` 却用
     * `ctx.get('slots')` 去拿服务 —— 在浏览器端上下文里拿不到，而拿不到时又「静默
     * return」，于是按钮不出现、控制台不留任何痕迹。DSH 自身的客户端插件一律写成
     * `inject: ['slots']` + `ctx.slots.*`；而且 `ctx.slots.inject()` 自身会等待侧栏声明，
     * 无论本行先激活还是后激活都能挂上。
     */
    const inject = ['slots'];

    /**
     * 取 slots 服务：优先属性访问（DSH 约定），并兼容旧版的 `ctx.get('slots')`。
     * @param {object} ctx - 浏览器端 Cordis 上下文。
     * @returns {object|null} slots 服务或 null。
     */
    function slotsOf(ctx) {
      const usable = (value) =>
        Boolean(value) && typeof value.inject === 'function' && typeof value.register === 'function';
      if (usable(ctx && ctx.slots)) return ctx.slots;
      const viaGet = ctx && typeof ctx.get === 'function' ? ctx.get('slots') : null;
      return usable(viaGet) ? viaGet : null;
    }

    /**
     * 注册两个入口。拿不到 slots 时**不再静默**：至少留下一行错误 ——
     * 否则「按钮没出现」根本无从查起（控制台本身仍可直连）。
     * @param {object} ctx - 浏览器端 Cordis 上下文。
     * @returns {void}
     */
    function apply(ctx) {
      const slots = slotsOf(ctx);
      if (!slots) {
        console.error(
          `[customer-service] 拿不到 slots 服务，侧边栏入口未注册；控制台仍可直接访问 ${CONSOLE_PATH}`,
        );
        return;
      }
      ctx.effect(
        () => slots.inject(SLOT_FOOTER, () => slots.register({ name: SLOT_FOOTER, id: ID, order: 40, label: '客服' }, FooterButton)),
        'customer-service: sidebar footer action',
      );
      ctx.effect(
        () => slots.inject(SLOT_OVERLAY, () => slots.register({ name: SLOT_OVERLAY, id: `${ID}-overlay`, order: 40, label: '客服控制台' }, OverlayPanel)),
        'customer-service: frame overlay',
      );
      ctx.effect(
        () => slots.inject(SLOT_PANEL, () => slots.register({ name: SLOT_PANEL, id: ID, order: 60, label: '客服' }, PanelIcon)),
        'customer-service: sidebar panel icon',
      );
      ctx.effect(
        () => slots.inject(SLOT_MAIN, () => slots.register({ name: SLOT_MAIN, key: ID }, MainPanel)),
        'customer-service: main panel',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    exports.__consolePath = CONSOLE_PATH;
    return module.exports;
  },
});
