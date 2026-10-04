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
      return h('span', { style: css.icon, title: '客服' }, '客服');
    }

    /** B-2：主区工作台。 */
    function MainPanel() {
      return h(ConsoleFrame, { main: true });
    }

    const inject = [];

    /**
     * 注册两个入口。`slots` 用软获取：拿不到就整体跳过，绝不让插件的激活失败。
     * @param {object} ctx - 浏览器端 Cordis 上下文。
     * @returns {void}
     */
    function apply(ctx) {
      const slots = ctx.get('slots');
      if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
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
