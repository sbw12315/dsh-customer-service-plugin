/**
 * SHEIN 商家中心（紫鸟 platformName 实机写作 `SHEIN-全球`）—— 买家会话适配器。
 *
 * 渠道状态：**已启用**，但**只接了登录与收件箱读数**；会话行 / 会话正文 / 回复框三段
 * **尚未校准**（见下面的「本适配器接了什么、没接什么」）。没校准的部分不猜、也不静默吞掉：
 * 一旦工作台里真的有会话，listConversations 会直接抛错说清楚「先校准再跑」。
 *
 * ## 2026-10-10 实测的现场（Shein-SevenVanity-US-客服 [27618263276365]）
 *
 *   - 后台是 sellerhub.shein.com（SHEIN全球商家中心）。流传很广的 seller.shein.com
 *     已经连不上（ERR_CONNECTION_CLOSED），seller.sheincorp.cn 也已经 301 到招商页。
 *   - 客服回复页 = 顶部菜单「客服 → chat工作台」：
 *     #/csd-chat-us/chat/workspace?noLayout=1（菜单项 target="_blank"）。
 *   - 未登录会落到 #/login/GMPSSO/<base64(原地址)>，登录提交后跳 #/auth/GMPSSO/... 做 OTP。
 *   - 客服模块另外三个入口：客服首页（Ticket / 时效看板）、chat会话记录、我的工单。
 *   - **工作台当时是空态**：接待会话数 0 / 排队中 0 / 历史会话 0，账号 CustomerService12313 处于
 *     「下线」。会话记录页里能看到历史会话（如 SUR8PVPHLIG7I8028，2026-10-09），但那是
 *     **只读的历史列表**，不是待回复收件箱，也不提供会话正文 DOM。
 *
 * ## 本适配器接了什么、没接什么
 *
 * 已校准（有实测证据）：
 *   1. 店判定：platformName SHEIN-全球 与店名 Shein-* / 希音；
 *   2. 登录判据：地址落在 #/login|auth/GMPSSO = 未登录；
 *   3. 回复页入口：chat工作台地址；
 *   4. 工作台骨架与角标：div.content_wrapper_dk4Qt 在空态也在，
 *      「会话中 / 历史会话」两个 tab 的计数、以及「排队中」计数都能读到（空态读到 0）。
 *
 * 未校准（**没有写选择器，也不猜**）：
 *   1. 会话行：一条真实会话都没见到，行/头像/未读角标的类名无从确认；
 *   2. 会话正文：同理；
 *   3. 回复框：空态里那个 textarea[placeholder="请描述您的问题......"] **不能**确认就是
 *      会话回复框（也可能是「手动接入 / 离线留言」的输入区）—— 踩过的坑见 README 里
 *      「沃尔玛裸 textarea 会打进 AI 对话框」。
 *
 * 所以：
 *   - listConversations 读角标；**角标 > 0 就直接抛错**，绝不返回空列表 —— 这是
 *     「宁可报错，也不静默漏掉一条会话」的落点（对照 amazon.js 的失效表现要求）；
 *   - readConversation 有实现，但只会在会话行校准之后才有机会被调用，现在恒定抛「未校准」；
 *   - **不导出** fillComposer / fillOpenConversation：没有校准过的输入框选择器，
 *     前端抽屉会走「复制正文 + 打开客服回复页」那条路，人工粘贴，不代填。
 *
 * ## 接入最后一段要做什么（一条真实会话就够）
 *
 *   1. 让「客服 → chat工作台」出现至少一条会话（账号上线 + 真实买家来消息，或平台侧分配）；
 *   2. 用紫鸟CLI 读一次行 DOM，把行选择器填进 ROW_SELECTORS，把正文选择器填进 THREAD_SELECTORS；
 *   3. 把 verified 改成 true，并在 calibrationNote 里写清校准现场（店铺 + 会话 ID）。
 *
 * 与其它渠道同一个底线：巡逻链路上不存在发送动作。
 *
 * @module dsh-customer-service-plugin/lib/platforms/shein
 */

import { isRetiredStore, normalizeStoreList, unwrapExec } from '../ziniao.js';
import { isChannelEnabled } from '../settings.js';

/** 平台标识（同时是 queue.channel 与草稿的 platform 字段）。 */
export const PLATFORM_ID = 'shein';
/** 平台展示名。 */
export const PLATFORM_LABEL = 'SHEIN';

/**
 * 卖家后台基址 —— 「SHEIN全球商家中心」。
 *
 * 注意**不是** seller.shein.com：2026-10-10 实测该域名连不上（紫鸟店铺里报
 * ERR_CONNECTION_CLOSED），中文圈流传的 seller.sheincorp.cn 也已 301 到招商页。
 */
export const SELLER_HUB_ORIGIN = 'https://sellerhub.shein.com';

/**
 * 客服回复页 = 顶部菜单「客服」→「chat工作台」。
 *
 * 实测：菜单项是 <a target="_blank" href="#/csd-chat-us/chat/workspace?noLayout=1">，
 * 直接访问同一地址同样能进工作台（已用紫鸟CLI 的 page visit 复现）。
 */
export const CHAT_WORKSPACE_URL = SELLER_HUB_ORIGIN + '/#/csd-chat-us/chat/workspace?noLayout=1';

/** 客服首页（Ticket / 时效看板 / 离线留言指标）。 */
export const SELLER_TICKETS_URL = SELLER_HUB_ORIGIN + '/#/csd-us/seller-mode/seller-tickets/home-page';
/** chat 会话记录（只读历史列表，带 会话ID / 用户姓名 / 订单号 等列）。 */
export const CHAT_RECORDS_URL = SELLER_HUB_ORIGIN + '/#/csd-chat-us/chat/record/list';
/** 我的工单（高货值协商 / 客服 / 物流 / 订单 / 退货 五类）。 */
export const WORK_ORDERS_URL = SELLER_HUB_ORIGIN + '/#/csd-document-us/work-order/list';

/**
 * 未登录时的地址特征。
 *
 * 实测：未登录访问 sellerhub 落到 #/login/GMPSSO/<base64(原地址)>，
 * 提交账号密码后再跳 #/auth/GMPSSO/... 做手机 OTP。两个前缀都算「没进后台」。
 */
export const SIGNIN_URL_RE = /#\/(?:login|auth)\/GMPSSO/;

/** 登录态取值（与 tiktok.js / walmart.js 同一套语义）。 */
export const LOGIN_STATES = Object.freeze({
  LOGGED_IN: 'logged_in',
  LOGIN_REQUIRED: 'login_required',
  FAILED: 'failed',
});

/** 工作台骨架容器（**实测**：空态也在，是判断「工作台真的渲染出来了」的锚点）。 */
export const WORKSPACE_ROOT_SELECTOR = 'div.content_wrapper_dk4Qt';
/** 会话列表 tab 容器（会话中 / 历史会话）。 */
export const TAB_CONTAINER_SELECTOR = 'div.sessions_top_Zh9gf';
/** 单个 tab；文本形如 会话中 + 换行 + 0，历史会话 tab 没有计数。 */
export const TAB_SELECTOR = 'div.sessions_top_option_gO0Sc';
/** 队列容器：文本里含 排队中 + 数字。 */
export const QUEUE_SELECTOR = 'div.queue_fPzKq';

/**
 * 空态文案（**实测**）。
 *
 * 这两个字符串的用途是「让校准人一眼确认自己看到的是空态」，**不作为判空依据** ——
 * 判空依据是角标计数。文案随版本会变，计数不会。
 */
export const EMPTY_STATE_TEXTS = Object.freeze(['无会话中的用户哦', '无历史会话的用户哦']);

/**
 * 会话行选择器：**尚未校准**（没有见过一条真实会话行）。
 *
 * 刻意留空而不是塞几个看着像的类名：SHEIN 的类名是 CSR 哈希（形如 sessions_top_option_gO0Sc，
 * 随构建变），猜一个只会让「行选择器失效」和「真的没有会话」长得一模一样。
 * 校准后把实测到的选择器填进来，同时把 verified 改成 true。
 */
export const ROW_SELECTORS = Object.freeze([]);
/** 会话正文选择器：同样尚未校准。 */
export const THREAD_SELECTORS = Object.freeze([]);

/**
 * 读工作台角标的页面脚本：只读**计数**，不碰会话行。
 *
 * 返回 { ok, url, tabs, active, queued, pending, history }；tab 容器找不到时返回
 * { ok:false, reason:'no-tabs' } —— 让调用方**报错**，而不是把「读不到」当成「0 条」。
 */
export const LIST_SCRIPT = `(() => {
  // 注意：这里刻意用 String.fromCharCode(10) 而不是 '\\n' 字面量 —— 脚本本身是**模板字符串**，
  // 里面写 \\n 会被模板字符串先解义成真换行，脚本就成了一段语法错误的代码（实测踩过）。
  const NL = String.fromCharCode(10);
  const flat = (el) => ((el && el.innerText) || '').split(NL).map((s) => s.trim()).filter(Boolean);
  const num = (text) => {
    const digits = String(text || '').replace(/[^0-9]/g, '');
    return digits ? Number(digits) : null;
  };
  const tabNodes = Array.from(document.querySelectorAll('div.sessions_top_option_gO0Sc'));
  if (tabNodes.length === 0) return JSON.stringify({ ok: false, reason: 'no-tabs', url: location.href });
  const tabs = tabNodes.map((el) => {
    const parts = flat(el);
    return { label: parts[0] || '', count: parts.length > 1 ? num(parts[1]) : null };
  });
  const pick = (label) => {
    const hit = tabs.filter((t) => t.label.indexOf(label) >= 0)[0];
    return hit ? hit.count : null;
  };
  const queueLine = flat(document.querySelector('div.queue_fPzKq')).filter((s) => s.indexOf('排队中') === 0)[0] || '';
  const active = pick('会话中');
  const queued = queueLine ? num(queueLine) : null;
  const pending = (active === null ? 0 : active) + (queued === null ? 0 : queued);
  const body = document.body.innerText || '';
  return JSON.stringify({
    ok: true,
    url: location.href,
    tabs: tabs,
    active: active,
    queued: queued,
    history: pick('历史会话'),
    pending: pending,
    emptyText: body.indexOf('无会话中的用户哦') >= 0 || body.indexOf('无历史会话的用户哦') >= 0,
  });
})()`;

/**
 * 判断一个紫鸟店铺是不是 SHEIN 店。
 *
 * platformName 实机就是 SHEIN-全球；店名形如 Shein-SevenVanity-US-客服。两处都认：
 * 只认 platformName 会漏掉运营把平台名写歪的店，只认店名会漏掉店名不带 Shein 而平台名是
 * SHEIN 的店（这个账号里 SHEIN-英国-自运营 属于后者）。
 * @param {{platformName?: string, storeName?: string}} store - 店铺。
 * @returns {boolean} 是否 SHEIN 店。
 */
export function isSheinStore(store) {
  const platform = String(store?.platformName ?? '');
  const name = String(store?.storeName ?? '');
  return /shein|希音/i.test(platform) || /^shein\b/i.test(name) || /希音/i.test(name);
}

/** 未登录时给的可照做提示（登录链路共用一句）。 */
const SIGNIN_HINT =
  '在紫鸟里打开该店铺并完成 SHEIN 商家中心登录（账号密码 + 手机 OTP / 邮箱验证码，插件不代劳），然后重新巡逻';

/**
 * 建一个 SHEIN 适配器。
 * @param {{ziniao: object, settings?: object, logger?: object}} options - 紫鸟CLI 客户端与设置。
 * @returns {object} 适配器。
 */
export function createSheinAdapter({ ziniao, settings = {}, logger } = {}) {
  void logger;
  /** 打开店铺可能触发内核下载，单独给更长的时间。 */
  const OPEN_TIMEOUT_MS = 240_000;
  const NAV_TIMEOUT_MS = 90_000;
  const PAGE_TIMEOUT_MS = 60_000;

  /**
   * 列出账号下**全部**店铺，不按平台过滤。
   *
   * 扫描接口要用全量才能解释「别的平台的店为什么不在本渠道列表里」。
   * @returns {Promise<Array<object>>} 店铺列表。
   */
  async function listAllStores() {
    const data = await ziniao.callOrThrow(['store', 'list'], { what: '取店铺列表', timeoutMs: PAGE_TIMEOUT_MS });
    return normalizeStoreList(data);
  }

  /**
   * 列出账号下所有 SHEIN 店（实测 15 家，含管理员 / 运营 / 客服三种角色店）。
   * @returns {Promise<Array<object>>} 店铺列表。
   */
  async function listStores() {
    // 与其它渠道同一口径：停用店不巡逻（判定见 ziniao.js 的 isRetiredStore）。
    return (await listAllStores()).filter((store) => isSheinStore(store) && !isRetiredStore(store));
  }

  /**
   * 打开店铺浏览器（已开则复用）。
   * @param {object} store - 店铺。
   * @returns {Promise<object>} 打开结果。
   */
  async function openStore(store) {
    // 刻意不传 --headless：草稿要落到人眼前核对，无头窗口填了也没人看得到。
    return ziniao.callOrThrow(['store', 'open', '--id', store.storeId], {
      what: '打开店铺 ' + store.storeName,
      timeoutMs: OPEN_TIMEOUT_MS,
    });
  }

  /**
   * 关闭店铺浏览器（只告警，不影响巡逻结果）。
   * @param {object} store - 店铺。
   * @returns {Promise<object|null>} 结果。
   */
  async function closeStore(store) {
    const result = await ziniao.call(['store', 'close', '--id', store.storeId], { timeoutMs: PAGE_TIMEOUT_MS });
    return result.ok ? result.data : null;
  }

  /**
   * 读当前页面地址（**无副作用**：不导航、不开窗口）。
   * @param {object} store - 店铺。
   * @returns {Promise<string>} 地址；读不到返回空串。
   */
  async function currentUrl(store) {
    const result = await ziniao.call(
      ['page', 'exec', '--store-id', store.storeId, '--script', 'location.href'],
      { timeoutMs: 30_000 },
    );
    if (!result.ok) return '';
    const value = unwrapExec(result.data);
    return typeof value === 'string' ? value : '';
  }

  /**
   * 导航到 chat工作台。
   * @param {object} store - 店铺。
   * @returns {Promise<void>} 完成。
   */
  async function visitWorkspace(store) {
    await ziniao.callOrThrow(
      [
        'page',
        'visit',
        '--store-id',
        store.storeId,
        '--url',
        CHAT_WORKSPACE_URL,
        '--wait-until',
        'domcontentloaded',
        '--timeout',
        String(NAV_TIMEOUT_MS),
      ],
      { what: '打开 SHEIN chat工作台', timeoutMs: NAV_TIMEOUT_MS + 30_000 },
    );
  }

  /**
   * 等工作台骨架渲染出来（SPA 是异步挂载，直接取会拿到空壳）。
   * @param {object} store - 店铺。
   * @returns {Promise<boolean>} 是否等到。
   */
  async function waitForWorkspace(store) {
    const result = await ziniao.call(
      ['page', 'wait-element', '--store-id', store.storeId, '--selector', WORKSPACE_ROOT_SELECTOR, '--timeout', '20000'],
      { timeoutMs: 30_000 },
    );
    return result.ok;
  }

  /**
   * 确认真的进了工作台，而不是被弹回登录页。
   * @param {object} store - 店铺。
   * @returns {Promise<void>} 未登录时抛带 kind=auth 的错误。
   */
  async function assertSignedIn(store) {
    const url = await currentUrl(store);
    if (!SIGNIN_URL_RE.test(url)) return;
    throw Object.assign(
      new Error('店铺未登录：SHEIN 商家中心把页面跳到了登录页，请先在紫鸟浏览器里登录该店铺后重跑'),
      { kind: 'auth', hint: SIGNIN_HINT },
    );
  }

  /**
   * 探测登录态 —— **不产生副作用**：不导航、不开店铺窗口。
   *
   * 判据只有「当前页面地址」：停在 #/login|auth/GMPSSO 就是未登录；读不到地址报 failed ——
   * 「读不到」和「没登录」要人做的事完全不同。
   * @param {object} store - 店铺。
   * @returns {Promise<{state: string, url: string, loggedIn: boolean, hint: string}>} 登录态。
   */
  async function checkLogin(store) {
    const url = await currentUrl(store);
    if (!url) {
      return {
        state: LOGIN_STATES.FAILED,
        url: '',
        loggedIn: false,
        hint: '读不到页面地址：店铺窗口可能没打开，或紫鸟CLI 这一跳失败了（不是「未登录」）',
      };
    }
    if (SIGNIN_URL_RE.test(url)) {
      return {
        state: LOGIN_STATES.LOGIN_REQUIRED,
        url,
        loggedIn: false,
        hint: '页面停在 SHEIN 商家中心登录页，等人完成登录（账号密码 + 手机 OTP / 邮箱验证码，插件不代劳）',
      };
    }
    return {
      state: LOGIN_STATES.LOGGED_IN,
      url,
      loggedIn: true,
      hint: '店铺已在登录态，可以直接巡逻或打开 chat工作台',
    };
  }

  /**
   * 打开登录页并**停下来等人** —— 这是「登录」按钮的全部职责。
   *
   * 打开店铺窗口 → 导航到 chat工作台：已登录就落在那里，未登录会被弹到登录页。
   * 不点任何按钮、不填任何东西。
   * @param {object} store - 店铺。
   * @returns {Promise<{state: string, url: string, hint: string}>} 结果。
   */
  async function openLogin(store) {
    try {
      await openStore(store);
    } catch (cause) {
      return {
        state: LOGIN_STATES.FAILED,
        url: '',
        title: '',
        hint:
          '打不开店铺「' +
          (store?.storeName ?? store?.storeId ?? '?') +
          '」：紫鸟那边这一步就失败了，先修这个再谈登录',
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    try {
      await visitWorkspace(store);
    } catch (cause) {
      const probe = await checkLogin(store).catch(() => null);
      if (probe && probe.state === LOGIN_STATES.LOGGED_IN) return { ...probe, title: '' };
      return {
        state: LOGIN_STATES.FAILED,
        url: probe?.url ?? '',
        title: '',
        hint: '导航到 chat工作台失败：店铺窗口可能没起来，或网络不通（不是「未登录」）',
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    const probe = await checkLogin(store);
    if (probe.state === LOGIN_STATES.LOGGED_IN) {
      return { ...probe, title: '', hint: '店铺已在登录态，页面停在 chat工作台' };
    }
    return { ...probe, title: '' };
  }

  /**
   * 读工作台角标计数。
   * @param {object} store - 店铺。
   * @returns {Promise<object>} 计数结果。
   */
  async function readCounts(store) {
    const result = await ziniao.callOrThrow(
      ['page', 'exec', '--store-id', store.storeId, '--script', LIST_SCRIPT],
      { what: '读取 chat工作台角标', timeoutMs: PAGE_TIMEOUT_MS },
    );
    const payload = unwrapExec(result);
    const data = payload && typeof payload === 'object' ? payload : null;
    if (!data || data.ok !== true) {
      throw Object.assign(
        new Error(
          'chat工作台没有加载出来（' +
            (data?.reason ?? 'no-payload') +
            '）：可能是该店铺未登录、或 SHEIN 改版把角标结构换了。**读不到不等于是 0 条**，所以这里直接报错。',
        ),
        { kind: 'page', reason: data?.reason ?? 'no-payload' },
      );
    }
    return data;
  }

  return {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'store',
    /** 客服回复页；巡逻结果里的 inboxUrl 与草稿的 caseUrl 都用它。 */
    inboxUrl: CHAT_WORKSPACE_URL,

    /**
     * 未校准 —— 让 /health 的 channelCalibration 如实露出来，不冒充「已接入」。
     * 会话行 / 会话正文 / 回复框三段没校准之前，这个字段一直是 false。
     */
    verified: false,
    calibrationNote:
      'SHEIN 渠道已启用，但**部分未校准**：2026-10-10 在 Shein-SevenVanity-US-客服 [27618263276365] ' +
      '上校准了登录判据（#/login|auth/GMPSSO）、chat工作台入口、工作台骨架与角标读数（空态读到 0）。' +
      '**尚未覆盖**：会话行选择器、会话正文选择器、回复框（fillComposer 根本没导出）；' +
      '当天工作台是空态（接待会话数 0 / 排队中 0 / 历史会话 0，账号离线），一条会话都没有，' +
      '按本项目规矩不猜选择器。角标 > 0 时 listConversations 会直接抛错要求先校准，不会静默漏。',

    /**
     * 渠道启用：跟着紫鸟CLI 的开关走（与 amazon/tiktok/walmart 同一口径）。
     * 要单独关掉 SHEIN，用设置的 patrol.channels 把渠道 id 限定成别的那几个。
     * @returns {boolean} 是否参与巡逻。
     */
    /** 本渠道自己的开关（巡逻页那一行画的它）—— 不含紫鸟CLI 总开关。 */
    channelEnabled() {
      return isChannelEnabled(settings, PLATFORM_ID);
    },
    enabled() {
      // 渠道开关（巡逻页那一行）与紫鸟CLI 总开关都要开着。
      return isChannelEnabled(settings, PLATFORM_ID) && settings.cliEnabled?.ziniao !== false;
    },
    /** 未启用时给界面一句可照做的原因（渠道开关 / CLI 开关，两种文案不一样）。 */
    disabledHint() {
      if (!isChannelEnabled(settings, PLATFORM_ID)) {
        return '这个渠道被停用了：把巡逻页里「SHEIN」那一行的开关打开后才会巡逻 SHEIN 店铺。';
      }
      return '紫鸟CLI 已在「设置」里禁用：重新启用后才会巡逻 SHEIN 店铺。';
    },

    /* ── 巡逻面：引擎只认这几个方法 ── */
    listSources: listStores,
    queueChannel: 'shein',
    draftKind: 'shein',

    /**
     * 打开店铺并进到 chat工作台；没进到就抛错，引擎会记成这家店失败。
     * @param {object} store - 店铺。
     * @returns {Promise<void>} 完成。
     */
    async prepare(store) {
      await openStore(store);
      await visitWorkspace(store);
      await assertSignedIn(store);
      const ready = await waitForWorkspace(store);
      if (!ready) {
        throw Object.assign(new Error('chat工作台没有加载出来（通常是该店铺未登录，或 SHEIN 改版了）'), {
          kind: 'page',
        });
      }
    },

    /**
     * 列出**待回复**会话。
     *
     * 现在只能读角标：角标是 0 就返回空列表（这是今天唯一能给出的真话）；
     * 角标 > 0 说明真的有会话，而会话行选择器还没校准 —— 这时**抛错**，
     * 因为「返回空列表」会让运营以为收件箱是空的，那是最坏的一种失败。
     * @param {object} store - 店铺。
     * @returns {Promise<{url: string, items: object[], skipped: object[], counts: object}>} 结果。
     */
    async listConversations(store) {
      const counts = await readCounts(store);
      const pending = Number(counts.pending ?? 0);
      if (pending > 0) {
        throw Object.assign(
          new Error(
            'SHEIN chat工作台里现在有 ' +
              pending +
              ' 条会话（会话中 ' +
              (counts.active ?? '?') +
              ' / 排队中 ' +
              (counts.queued ?? '?') +
              '），但本适配器的**会话行选择器还没在有会话的登录态上校准过** —— 现在跑下去只能漏读。' +
              '请先按 lib/platforms/shein.js 文件头的清单校准会话行与正文选择器（一条真实会话就够），再重新巡逻。',
          ),
          { kind: 'page', reason: 'rows-not-calibrated', counts },
        );
      }
      return { url: String(counts.url ?? ''), items: [], skipped: [], counts };
    },

    /**
     * 读完整会话 —— 会话行校准之前不会被调用（见 listConversations 的守卫）。
     * @returns {Promise<never>} 恒定抛「未校准」。
     */
    async readConversation() {
      throw Object.assign(
        new Error('SHEIN 会话正文选择器尚未校准：先补 THREAD_SELECTORS 并更新 calibrationNote'),
        { kind: 'page', reason: 'thread-not-calibrated' },
      );
    },

    /** 会话标识：会话行校准后从行数据里取；现在恒为空（没有行）。 */
    conversationId: () => '',

    checkLogin,
    openLogin,
    listAllStores,
    listStores,
    openStore,
    closeStore,
    visitWorkspace,
    waitForWorkspace,
    readCounts,
  };
}

/**
 * 会话级深链：**没有**（chat工作台未实测到「从 URL 直接打开某条会话」的形态）。
 *
 * 与 walmart.js / tiktok.js 同款取舍：与其给一个看着像对的错链接，不如给**客服回复页入口**，
 * 让人自己点进去选会话。所以这里恒返回 chat工作台地址（草稿抽屉里的「打开原会话」会落在那儿）。
 * @returns {string} chat工作台地址。
 */
export function conversationUrl() {
  return CHAT_WORKSPACE_URL;
}
