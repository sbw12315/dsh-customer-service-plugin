/**
 * 亚马逊（Amazon）买家消息适配器。
 *
 * 把「打开店铺 → 进买家消息收件箱 → 取需要回复的会话 → 读会话正文 → 填草稿」这一串
 * 页面动作，收敛成一组方法，巡逻引擎只调这些方法，不认识任何 CSS 选择器。
 *
 * 选择器全部来自 Amazon Seller Central 现网 DOM（新 NGS 消息中心，2026-10 实测）：
 *   .case-list-items .case-list-item           会话行（<a>，带 data-ph-capture-attribute-order-id）
 *     .case-list-item-header .buyer-name       买家名
 *     .case-list-item-header .formatted-date   日期
 *     .case-list-item-header kat-flag[country] 国家
 *     .case-list-item-body .subject            主题
 *     .case-list-item-footer .badge-text       到期文案
 *   .case-message-view .message-component      会话里的每条消息
 *     .message-body-text                       正文
 *     .case-message-view-message-date          时间
 *   kat-button[id=select-original-experience-button]  「填写留言」（自由回复入口）
 *   textarea.fake-kat-textarea                        回复输入框
 *
 * **硬约束：这个文件里不存在任何「发送」动作。** 巡逻只写草稿，落点是插件自己的
 * 草稿库；把人写好的文本填进回复框是**人工点单条**才触发的可选动作，且填完就停，
 * 绝不点发送按钮。
 *
 * @module dsh-customer-service-plugin/lib/platforms/amazon
 */

import { normalizeStoreList, unwrapExec } from '../ziniao.js';

/** 平台标识（同时是 queue.channel 与草稿的 platform 字段）。 */
export const PLATFORM_ID = 'amazon';
/** 平台展示名。 */
export const PLATFORM_LABEL = '亚马逊';

/** 买家与卖家消息服务的基址。 */
export const INBOX_BASE = 'https://sellercentral.amazon.com/messaging/inbox-v3';
/** 买家与卖家消息服务收件箱；fi=responseNeeded 直接把「需要回复」筛选打开。 */
export const INBOX_URL = `${INBOX_BASE}?fi=responseNeeded`;

/**
 * 直接打开某个会话的深链。
 *
 * 比「重新进收件箱再按第 N 行点进去」稳得多：会话在列表里的位置会随新消息变化，
 * 而下标是巡逻当时那一刻的快照。草稿里存了 caseId（来自 URL 的 cc 参数），
 * 之后任何时候都能用这个链接把原会话重新打开。
 * @param {string} caseId - 会话 id。
 * @returns {string} 链接。
 */
export function conversationUrl(caseId) {
  const id = String(caseId ?? '').trim();
  if (!id) return INBOX_URL;
  return `${INBOX_BASE}?cc=${encodeURIComponent(id)}&fi=responseNeeded`;
}

/** 亚马逊登录页地址特征；命中说明这个店铺在紫鸟里是未登录状态。 */
export const SIGNIN_URL_RE = /\/ap\/signin|\/gp\/signin|\/signin|signin\.html/i;
/** 会话列表容器。 */
export const LIST_SELECTOR = '.case-list-items';
/** 会话视图容器。 */
export const THREAD_SELECTOR = '.case-message-view';
/** 会话里的单条消息；`.case-message-view` 先出现、消息后渲染，等这个才是真的读到内容。 */
export const THREAD_MESSAGES_SELECTOR = '.case-message-view-messages .message-component';
/** 「填写留言」按钮。 */
export const COMPOSER_OPEN_SELECTOR = 'kat-button[id="select-original-experience-button"]';
/** 回复输入框。 */
export const COMPOSER_INPUT_SELECTOR = 'textarea.fake-kat-textarea';

/**
 * 判断一个紫鸟店铺是不是亚马逊店。
 *
 * 紫鸟的 platformName 形如 `亚马逊-美国` / `亚马逊-欧洲`；跨语言部署时也可能直接是
 * `Amazon-*`，所以两种写法都认。
 * @param {{platformName?: string}} store - 店铺。
 * @returns {boolean} 是否亚马逊店。
 */
export function isAmazonStore(store) {
  const name = String(store?.platformName ?? '');
  return /亚马逊|amazon/i.test(name);
}

/** 取会话列表的页面脚本。 */
export const LIST_SCRIPT = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const nodes = Array.from(document.querySelectorAll('.case-list-items .case-list-item'));
  const items = nodes.map((el, index) => {
    const pick = (sel) => { const n = el.querySelector(sel); return n ? clean(n.innerText) : ''; };
    const flag = el.querySelector('.case-list-item-header kat-flag');
    const badge = el.querySelector('.case-status-badge');
    return {
      index,
      buyer: pick('.buyer-name') || pick('.case-list-item-header'),
      date: pick('.formatted-date'),
      country: flag ? (flag.getAttribute('country') || '') : '',
      subject: pick('.subject') || pick('.case-list-item-body'),
      due: pick('.badge-text') || pick('.case-list-item-footer'),
      orderId: el.getAttribute('data-ph-capture-attribute-order-id') || '',
      badge: badge ? clean(badge.className) : '',
      active: /(^|\\s)active(\\s|$)/.test(el.className),
      raw: clean(el.innerText),
    };
  });
  return JSON.stringify({ url: location.href, count: items.length, items });
})()`;

/** 取会话正文的页面脚本。 */
export const THREAD_SCRIPT = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const view = document.querySelector('.case-message-view');
  if (!view) return JSON.stringify({ ok: false, reason: 'no-view' });
  const header = view.querySelector('.case-message-view-header');
  const pickIn = (root, sel) => { const n = root && root.querySelector(sel); return n ? clean(n.innerText) : ''; };
  const messages = Array.from(view.querySelectorAll('.case-message-view-messages .message-component')).map((el) => {
    const bodyEl = el.querySelector('.message-body-text') || el.querySelector('.message-body');
    return {
      dir: /received-message-component/.test(el.className) ? 'in' : 'out',
      date: pickIn(el, '.case-message-view-message-date'),
      body: clean(bodyEl ? bodyEl.innerText : ''),
    };
  });
  const inbound = messages.filter((m) => m.dir === 'in');
  return JSON.stringify({
    ok: true,
    url: location.href,
    buyer: pickIn(header, '.buyer-name'),
    country: pickIn(header, '.buyer-lop-country'),
    topic: pickIn(header, '.case-topic'),
    due: pickIn(header, '.case-status-badge'),
    messages,
    lastInbound: inbound.length ? inbound[inbound.length - 1] : null,
    messageCount: messages.length,
  });
})()`;

/**
 * 把 CLI 返回的脚本结果规范成对象。
 * @param {any} value - `unwrapExec` 的结果。
 * @returns {any|null} 对象或 null。
 */
export function asObject(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 解析「到期时间：12 分钟」这类文案，换成分钟数。
 *
 * 三种真实形态：`到期时间：12 分钟` / `到期时间：5 小时` / 英文 `Due in 2 hours`；
 * 还见过带上限文案（`已超期 3 小时`）。解析不出来返回 null —— 巡逻据此排序时
 * 把未知的排到最后，而不是当成「无期限」。
 * @param {string} text - 文案。
 * @returns {{minutes: number, overdue: boolean}|null} 结果。
 */
export function parseDueText(text) {
  const raw = String(text ?? '');
  if (!raw.trim()) return null;
  const overdue = /超期|逾期|overdue|expired/i.test(raw);
  const minutes = /(\d+)\s*分钟|(\d+)\s*min/i.exec(raw);
  if (minutes) {
    const value = Number.parseInt(minutes[1] ?? minutes[2], 10);
    return Number.isFinite(value) ? { minutes: overdue ? -value : value, overdue } : null;
  }
  const hours = /(\d+)\s*(?:小时|hour)/i.exec(raw);
  if (hours) {
    const value = Number.parseInt(hours[1], 10);
    return Number.isFinite(value) ? { minutes: (overdue ? -1 : 1) * value * 60, overdue } : null;
  }
  const days = /(\d+)\s*(?:天|day)/i.exec(raw);
  if (days) {
    const value = Number.parseInt(days[1], 10);
    return Number.isFinite(value) ? { minutes: (overdue ? -1 : 1) * value * 1440, overdue } : null;
  }
  return { minutes: null, overdue };
}

/**
 * 从会话 URL 里取 caseId（`?cc=<uuid>`）。
 * @param {string} url - 地址。
 * @returns {string} caseId，取不到返回空串。
 */
export function caseIdFromUrl(url) {
  const match = /[?&]cc=([^&]+)/.exec(String(url ?? ''));
  if (!match) return '';
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * 建一个亚马逊适配器。
 * @param {{ziniao: object, settings?: object, logger?: object}} options - 配置。
 * @returns {object} 适配器。
 */
export function createAmazonAdapter(options) {
  const ziniao = options.ziniao;
  const settings = options.settings ?? {};
  const logger = options.logger ?? { warn: () => {} };
  const patrol = settings.patrol ?? {};

  /** 简单等待。 */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 页面动作的统一超时。打开店铺可能触发内核下载，单独给更长的时间。 */
  const OPEN_TIMEOUT_MS = 240_000;
  const NAV_TIMEOUT_MS = 90_000;
  const PAGE_TIMEOUT_MS = 60_000;

  /**
   * 列出账号下**全部**店铺，不按平台过滤。
   *
   * 巡逻本身只用亚马逊店，但「扫描可用店铺」这个动作必须看到全量：运营在紫鸟里新加了
   * 一个非亚马逊店时，界面要能解释「它为什么没出现在可巡逻列表里」，而不是让人以为漏扫了。
   * @returns {Promise<Array<object>>} 店铺列表。
   */
  async function listAllStores() {
    const data = await ziniao.callOrThrow(['store', 'list'], { what: '取店铺列表', timeoutMs: PAGE_TIMEOUT_MS });
    return normalizeStoreList(data);
  }

  /**
   * 列出账号下所有亚马逊店铺。
   * @returns {Promise<Array<object>>} 店铺列表。
   */
  async function listStores() {
    return (await listAllStores()).filter(isAmazonStore);
  }

  /**
   * 打开店铺浏览器（已开则复用）。
   * @param {object} store - 店铺。
   * @returns {Promise<object>} 打开结果。
   */
  async function openStore(store) {
    const args = ['store', 'open', '--id', store.storeId];
    if (patrol.headless) args.push('--headless');
    return ziniao.callOrThrow(args, { what: `打开店铺 ${store.storeName}`, timeoutMs: OPEN_TIMEOUT_MS });
  }

  /**
   * 关闭店铺浏览器。
   * @param {object} store - 店铺。
   * @returns {Promise<object|null>} 结果；失败只告警。
   */
  async function closeStore(store) {
    try {
      return await ziniao.callOrThrow(['store', 'close', '--id', store.storeId], {
        what: `关闭店铺 ${store.storeName}`,
        timeoutMs: 30_000,
      });
    } catch (cause) {
      logger.warn(`关闭店铺失败（忽略）：${cause instanceof Error ? cause.message : cause}`);
      return null;
    }
  }

  /**
   * 导航到买家消息收件箱。
   * @param {object} store - 店铺。
   * @returns {Promise<void>} 完成。
   */
  async function visitInbox(store) {
    await ziniao.callOrThrow(
      ['page', 'visit', '--store-id', store.storeId, '--url', INBOX_URL, '--wait-until', 'networkidle', '--timeout', String(NAV_TIMEOUT_MS)],
      { what: '导航到买家消息', timeoutMs: NAV_TIMEOUT_MS + 30_000 },
    );
    await assertSignedIn(store);
  }

  /**
   * 确认真的进了卖家平台，而不是被弹回登录页。
   *
   * 未登录时亚马逊会把收件箱 302 到 `/ap/signin`，页面上当然也长不出 `.case-list-items`。
   * 不特判的话，巡逻只会报一句「收件箱没有加载出来」，运营得挨个店铺去猜是改版了还是没登录。
   * @param {object} store - 店铺。
   * @returns {Promise<void>} 未登录时抛带 kind=auth 的错误。
   */
  async function assertSignedIn(store) {
    const result = await ziniao.call(
      ['page', 'exec', '--store-id', store.storeId, '--script', 'location.href'],
      { timeoutMs: PAGE_TIMEOUT_MS },
    );
    if (!result.ok) return; // 读不到地址不算证据，交给后面的等待逻辑判断
    const url = String(unwrapExec(result.data) ?? '');
    if (!SIGNIN_URL_RE.test(url)) return;
    const error = new Error('店铺未登录：亚马逊把页面跳到了登录页，请先在紫鸟浏览器里登录该店铺后重跑');
    error.kind = 'auth';
    error.hint = '在紫鸟里打开该店铺并完成登录，然后重新巡逻';
    throw error;
  }

  /**
   * 等会话列表出现（收件箱是异步渲染的，直接取值会拿到空骨架）。
   * @param {object} store - 店铺。
   * @returns {Promise<boolean>} 是否等到。
   */
  async function waitForInbox(store) {
    const result = await ziniao.call(
      ['page', 'wait-element', '--store-id', store.storeId, '--selector', LIST_SELECTOR, '--timeout', '30000'],
      { timeoutMs: 45_000 },
    );
    return result.ok;
  }

  /**
   * 取会话列表。
   * @param {object} store - 店铺。
   * @returns {Promise<{url: string, items: object[]}>} 列表。
   */
  async function extractList(store) {
    const result = await ziniao.callOrThrow(
      ['page', 'exec', '--store-id', store.storeId, '--script', LIST_SCRIPT],
      { what: '读取会话列表', timeoutMs: PAGE_TIMEOUT_MS },
    );
    const payload = asObject(unwrapExec(result));
    if (!payload || !Array.isArray(payload.items)) {
      throw new Error('会话列表解析失败：页面脚本没有返回预期结构');
    }
    return { url: String(payload.url ?? ''), items: payload.items };
  }

  /**
   * 打开第 index 条会话。
   * @param {object} store - 店铺。
   * @param {number} index - 0 基下标。
   * @returns {Promise<void>} 完成。
   */
  async function openConversation(store, index) {
    const selector = `${LIST_SELECTOR} .case-list-item:nth-child(${index + 1})`;
    await ziniao.callOrThrow(
      ['page', 'click', '--store-id', store.storeId, '--selector', selector],
      { what: `打开第 ${index + 1} 条会话`, timeoutMs: PAGE_TIMEOUT_MS },
    );
    await ziniao.call(
      ['page', 'wait-element', '--store-id', store.storeId, '--selector', THREAD_SELECTOR, '--timeout', '15000'],
      { timeoutMs: 25_000 },
    );
    // 关键：`.case-message-view` 是乐观渲染出来的空壳，消息体在之后才到。
    // 早先只等外层容器就取值，拿到的是「没有消息」的会话 —— 于是买家诉求全丢，
    // 意图只能从系统主题猜，生成出跟买家刚说的话相反的草稿。这里必须等到真有消息。
    await ziniao.call(
      ['page', 'wait-element', '--store-id', store.storeId, '--selector', THREAD_MESSAGES_SELECTOR, '--timeout', '20000'],
      { timeoutMs: 30_000 },
    );
  }

  /**
   * 取当前打开的会话正文。
   * @param {object} store - 店铺。
   * @returns {Promise<object>} 会话。
   */
  async function extractThread(store, opts = {}) {
    const attempts = Number.isFinite(opts.attempts) ? Math.max(1, opts.attempts) : 3;
    let payload = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const result = await ziniao.callOrThrow(
        ['page', 'exec', '--store-id', store.storeId, '--script', THREAD_SCRIPT],
        { what: '读取会话正文', timeoutMs: PAGE_TIMEOUT_MS },
      );
      payload = asObject(unwrapExec(result));
      if (!payload || payload.ok !== true) {
        throw new Error('会话正文解析失败：页面没有打开会话视图');
      }
      // 读到了会话但一条消息都没有，多半是还在渲染 —— 等一下重读，别把空会话当结论。
      if (Array.isArray(payload.messages) && payload.messages.length > 0) return payload;
      if (attempt < attempts - 1) await sleep(1200);
    }
    return payload;
  }

  /**
   * 把草稿文本填进亚马逊回复框 —— **只填不发送**。
   *
   * 这是人工点单条草稿才走的路：巡逻本身从不调用它。填完就返回，页面上留着一份
   * 未发送的文本，人工核对后自己点发送。
   *
   * 传入 caseId 时会用深链直接开原会话；没有 caseId 时退化成打开收件箱，
   * 由人工自己点进对应会话（这种情况下不填，直接报错，避免填错会话）。
   * @param {object} store - 店铺。
   * @param {string} text - 草稿文本。
   * @param {{caseId?: string}} [opts] - 选项。
   * @returns {Promise<{filled: boolean, length: number, url: string}>} 结果。
   */
  async function fillComposer(store, text, opts = {}) {
    const body = String(text ?? '');
    if (!body.trim()) throw new Error('草稿内容为空，拒绝填入回复框');
    const caseId = String(opts.caseId ?? '').trim();
    if (!caseId) {
      throw new Error('这条草稿没有会话 id（caseId），无法定位到原会话；请在亚马逊页面上手动粘贴');
    }
    await openStore(store);
    const url = conversationUrl(caseId);
    await ziniao.callOrThrow(
      ['page', 'visit', '--store-id', store.storeId, '--url', url, '--wait-until', 'networkidle', '--timeout', String(NAV_TIMEOUT_MS)],
      { what: '打开原会话', timeoutMs: NAV_TIMEOUT_MS + 30_000 },
    );
    await ziniao.call(
      ['page', 'wait-element', '--store-id', store.storeId, '--selector', THREAD_SELECTOR, '--timeout', '20000'],
      { timeoutMs: 30_000 },
    );
    // 先点「填写留言」把自由回复编辑器打开；它已经是打开状态时点击是无害的。
    await ziniao.callOrThrow(
      ['page', 'click', '--store-id', store.storeId, '--selector', COMPOSER_OPEN_SELECTOR],
      { what: '打开回复编辑器', timeoutMs: PAGE_TIMEOUT_MS },
    );
    await ziniao.call(
      ['page', 'wait-element', '--store-id', store.storeId, '--selector', COMPOSER_INPUT_SELECTOR, '--timeout', '15000'],
      { timeoutMs: 25_000 },
    );
    await ziniao.callOrThrow(
      ['page', 'input', '--store-id', store.storeId, '--selector', COMPOSER_INPUT_SELECTOR, '--text', body, '--clear'],
      { what: '填入草稿', timeoutMs: PAGE_TIMEOUT_MS },
    );
    return { filled: true, length: body.length, url };
  }

  return {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'store',
    inboxUrl: INBOX_URL,
    conversationUrl,

    /* ── 巡逻面：巡逻引擎只认这几个方法，不认识上面那些 Amazon 专有动作 ── */

    /** 巡逻目标 = 店铺（对邮箱适配器来说就是邮箱地址）。 */
    listSources: listStores,

    /** 队列渠道与草稿模板族：让引擎不用认识任何平台。 */
    queueChannel: 'amazon',
    draftKind: 'amazon',

    /** 会话标识 = URL 里的 cc（点开会话后才有）。 */
    conversationId: (thread) => caseIdFromUrl(thread?.url ?? ''),

    /** 打开店铺并进到收件箱；没进到就抛错，引擎会记成这家店失败。 */
    async prepare(store) {
      await openStore(store);
      await visitInbox(store);
      const ready = await waitForInbox(store);
      if (!ready) {
        throw Object.assign(new Error('收件箱没有加载出来（通常是该店铺未登录）'), { kind: 'page' });
      }
    },

    /**
     * 列出需要回复的会话（读取便宜，一次调用）。
     * 顺手把「到期时间」文案解析成分钟数 —— 引擎要用它排序，不该由引擎认识这套文案。
     */
    async listConversations(store) {
      const list = await extractList(store);
      return {
        ...list,
        items: list.items.map((item) => ({ ...item, dueMinutes: parseDueText(item.due)?.minutes ?? null })),
      };
    },

    /** 打开并读完整段会话。 */
    async readConversation(store, item) {
      await openConversation(store, item.index);
      return extractThread(store);
    },

    closeSource: closeStore,
    listAllStores,
    listStores,
    openStore,
    closeStore,
    visitInbox,
    waitForInbox,
    extractList,
    openConversation,
    extractThread,
    fillComposer,
  };
}
