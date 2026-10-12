/**
 * TEMU 卖家中心（紫鸟 platformName 实机写作 `Temu-中国卖家中心` 与 `Temu-美国-本土`）
 * —— 买家会话适配器。
 *
 * 渠道状态：**已启用**，但只接了「店判定 + 后台判定 + 登录判据 + 后台入口」四段；
 * **买家会话收件箱那一段尚未校准**（见下）。没校准的部分不猜、也不静默吞掉：
 * 真的进了后台时，listConversations 会直接抛错说清楚「先校准再跑」，绝不返回空列表。
 *
 * ## 2026-10-12 实测的现场（紫鸟CLI，9 家 TEMU 店全量）
 *
 * TEMU 在紫鸟里是**两个平台名**，对应**两套完全不同的后台**，混用会把店铺开到错的地方：
 *
 * | platformName        | 店数                     | 后台                        | 未登录时实测落到 |
 * |---------------------|--------------------------|-----------------------------|------------------|
 * | `Temu-中国卖家中心`  | 5 家（另有 2 家店名带「停用」） | seller.kuajingmaihuo.com    | `/login?redirectUrl=...`（标题「卖家中心」） |
 * | `Temu-美国-本土`     | 1 家（另有 1 家店名带「停用」） | seller.temu.com             | `/no-auth.html` 或 `/login.html` |
 *
 * ⚠️ 中国大陆主体的跨境卖家后台**不是** seller.temu.com，而是
 * **`seller.kuajingmaihuo.com/main/`**。实测把 `Temu-CN-客服` [27409837973085] 开到
 * seller.temu.com 会落到 `no-auth.html` —— 那不是「没登录」，是**开错了平台**；
 * seller.temu.com 只服务美区/欧区卖家（对照 `Temu-美国-本土`，它落在
 * `/login.html`，标题是 Temu Seller Center）。所以后台按 platformName 分派，
 * 不按店名猜。
 *
 * 未登录判据（两套后台各一条，都是实测）：
 *   1. kuajingmaihuo：地址命中 `/login`（实测 `https://seller.kuajingmaihuo.com/login?redirectUrl=...`，
 *      页面上的登录 tab 是「扫码登录 / 手机号登录 / 邮箱登录」）；
 *   2. seller.temu.com：地址命中 `/no-auth.html` 或 `/login.html`。
 *
 * 已实测/已证的入口：
 *   - 跨境卖家中心首页 `https://seller.kuajingmaihuo.com/main/`（未登录 302 到 /login）；
 *   - 消息中心 `https://seller.kuajingmaihuo.com/message` —— 出处是**官方前端路由表**
 *     （`bgb-sc-container` 的 main bundle：`messageCenter:"/message"`、
 *     `knock:"/message/knock"`）。注意它是**平台消息中心**，**不是**买家会话工作台，
 *     所以只当常量记录，不当收件箱用；
 *   - 美区/欧区 Seller Central `https://seller.temu.com/`。
 *
 * ## 本适配器接了什么、没接什么
 *
 * 已校准（有实测证据）：
 *   1. 店判定：platformName 含 temu（两个平台名都认）+ 店名 `Temu-*` / `TEMU-*`；
 *   2. 后台判定：美国 / 美区 / 本土 → seller.temu.com，其余（中国卖家中心、跨境）→ kuajingmaihuo；
 *   3. 登录判据：上面那两条 URL 判据；
 *   4. 后台入口：两个后台的首页地址。
 *
 * 未校准（**一个选择器都不写，也不猜**）：
 *   1. 买家会话工作台。Temu 官方课程里叫「Temu 卖家中心 → 客服中心 → 消费者咨询」
 *      （半托管自接待模式；超过 24 小时不响应会触发平台介入），另有「客服中心 → 售前/售后工单」。
 *      **路径未知**：2026-10-12 实测时 9 家 TEMU 店**全部未登录**，登不进去就没有一条真实会话
 *      可看，路径与 DOM 都无从确认；
 *   2. 会话行 / 会话正文 / 回复框：同理。
 *
 * 所以：
 *   - listConversations **恒定抛错**并带上要补的东西，绝不返回空列表 —— 返回空列表会让运营
 *     以为收件箱是空的，那是最坏的一种失败（与 shein.js 同一口径）；
 *   - readConversation 同样恒抛；
 *   - **不导出** fillComposer / fillOpenConversation：没有校准过的输入框选择器，
 *     草稿抽屉只给「复制正文」，人工粘贴。
 *
 * ## 接入最后一段要做什么（登录一家店 + 跑一次校准脚本）
 *
 *   1. 在紫鸟里打开一家 TEMU 店（跨境店走 seller.kuajingmaihuo.com，美区店走
 *      seller.temu.com），**人工完成登录**（扫码 / 手机号 / 邮箱验证码，插件不代劳）；
 *   2. 跑 `node scripts/smoke-temu.mjs --store=<storeId>`：它打印登录态、后台地址，
 *      以及「客服中心 / 消费者咨询」候选入口的 DOM 命中表；
 *   3. 把实测到的会话行 / 正文选择器填进 ROW_SELECTORS / THREAD_SELECTORS，把
 *      CONVERSATION_WORKBENCH_URL 填上，把 verified 改成 true，并在 calibrationNote
 *      里写清校准现场（店铺 + 会话 ID）。
 *
 * 与其它渠道同一个底线：巡逻链路上不存在发送动作。
 *
 * @module dsh-customer-service-plugin/lib/platforms/temu
 */

import { isRetiredStore, normalizeStoreList, unwrapExec } from '../ziniao.js';
import { isChannelEnabled } from '../settings.js';

/** 平台标识（同时是 queue.channel 与草稿的 platform 字段）。 */
export const PLATFORM_ID = 'temu';
/** 平台展示名。 */
export const PLATFORM_LABEL = 'TEMU';

/** 中国大陆主体的跨境卖家中心（全托管 / 半托管）。 */
export const KUAJING_ORIGIN = 'https://seller.kuajingmaihuo.com';
/** 美区 / 欧区 Seller Central。 */
export const SELLER_CENTRAL_ORIGIN = 'https://seller.temu.com';

/** 跨境卖家中心首页（未登录会 302 到 /login）。 */
export const KUAJING_HOME_URL = KUAJING_ORIGIN + '/main/';
/** 美区 / 欧区 Seller Central 首页。 */
export const SELLER_CENTRAL_HOME_URL = SELLER_CENTRAL_ORIGIN + '/';

/**
 * 跨境后台的**消息中心**。
 *
 * 出处是官方前端路由表（bgb-sc-container 的 main bundle：messageCenter:"/message"），
 * **实测未登录进不去**，所以只作为常量记录。⚠️ 它是平台消息中心，
 * **不是**买家会话工作台 —— 不要拿它当收件箱读（见文件头「未校准」）。
 */
export const KUAJING_MESSAGE_CENTER_URL = KUAJING_ORIGIN + '/message';

/** 两套后台的 id。 */
export const BACKEND_KUAJING = 'kuajingmaihuo';
export const BACKEND_SELLER_CENTRAL = 'seller-central';

/** 后台 id → 站点主机名。 */
export const BACKEND_HOSTS = Object.freeze({
  [BACKEND_KUAJING]: 'seller.kuajingmaihuo.com',
  [BACKEND_SELLER_CENTRAL]: 'seller.temu.com',
});

/** 后台 id → 首页地址。 */
export const BACKEND_HOME_URLS = Object.freeze({
  [BACKEND_KUAJING]: KUAJING_HOME_URL,
  [BACKEND_SELLER_CENTRAL]: SELLER_CENTRAL_HOME_URL,
});

/** 跨境后台的未登录判据（实测 `/login?redirectUrl=...`）。 */
export const KUAJING_LOGIN_URL_RE = /^https?:\/\/seller\.kuajingmaihuo\.com\/login(?:[/?#]|$)/i;
/** 美区后台的未登录判据一：实测 `https://seller.temu.com/no-auth.html`。 */
export const SELLER_CENTRAL_NO_AUTH_URL_RE = /\/no-auth\.html/i;
/** 美区后台的未登录判据二：实测 `https://seller.temu.com/login.html?redirectUrl=...`。 */
export const SELLER_CENTRAL_LOGIN_URL_RE = /\/login\.html/i;

/** 登录态取值（与 tiktok.js / walmart.js / shein.js 同一套语义）。 */
export const LOGIN_STATES = Object.freeze({
  LOGGED_IN: 'logged_in',
  LOGIN_REQUIRED: 'login_required',
  FAILED: 'failed',
});

/**
 * 买家会话工作台地址：**尚未校准**。
 *
 * 刻意留空而不是塞一个看着像的地址：Temu 官方课程只说「客服中心 → 消费者咨询」这条
 * 菜单路径，没给 URL；而两套后台的 URL 不可能共用一个。猜一个的结果是「把人送到
 * 不存在的页面」和「这个功能就是坏的」长得一模一样。
 */
export const CONVERSATION_WORKBENCH_URL = '';

/**
 * 会话行选择器：**尚未校准**（没有见过一条真实会话行）。
 *
 * 与 shein.js 同一个理由：Temu 的类名是构建哈希，随版本变；猜一个只会让
 * 「行选择器失效」和「真的没有会话」长得一模一样。
 */
export const ROW_SELECTORS = Object.freeze([]);
/** 会话正文选择器：同样尚未校准。 */
export const THREAD_SELECTORS = Object.freeze([]);

/**
 * 把登录页切到「手机号登录」tab 的页面脚本（2026-10-12 在 Temu-CN-客服 登录页实测通过）。
 *
 * 返回 { ok, clicked, active, tabs }；ok=true 表示**回读**到「手机号登录」是选中态，
 * 不是「点过了」。找不到 tab 时返回 { ok:false, reason:'no-tab', tried, tabs }。
 * 除了 `el.click()`（仓库踩过的坑：紫鸟CLI 的 page click 点不动，见 README）之外，
 * 脚本不写任何内容、不提交任何表单。
 */
export const PHONE_TAB_SCRIPT = `(() => {
  // 登录页默认停在「扫码登录」tab（实测：useState(sessionType === Normal ? Scan : Account)），
  // 而运营日常走的是手机号那一栏。这里把 tab 切到「手机号登录」——**只切 tab**，
  // 不往输入框里写任何东西、不点提交按钮，与「登录按钮只把页面摆好」的约定不冲突。
  const WANTED = ['手机号登录', '手机号', 'phone', 'mobile'];
  // 不用正则：脚本本身是**模板字符串**，里面写 \\s 会被先解义掉（shein.js 的 LIST_SCRIPT 踩过）。
  // 用字符码过滤空白（32 及以下，外加全角空格 12288），把换行之类全部绕开。
  const squash = (value) => String(value || '').split('')
    .filter((ch) => ch.charCodeAt(0) > 32 && ch.charCodeAt(0) !== 12288)
    .join('')
    .toLowerCase();
  const wanted = WANTED.map(squash);
  const readTabs = () => Array.from(document.querySelectorAll('[class*="tabItem"]'))
    .map((el) => ({ text: (el.innerText || '').trim(), checked: String(el.className || '').indexOf('Checked') >= 0 }))
    .filter((tab) => tab.text && tab.text.length <= 12);
  const nodes = Array.from(document.querySelectorAll('div,span,button,a,li'));
  const hits = nodes.filter((el) => {
    const text = squash(el.innerText);
    return text.length > 0 && text.length <= 12 && wanted.indexOf(text) >= 0;
  });
  // 先认精确的「手机号登录」；没有才退到「手机号 / phone / mobile」这些更宽的写法。
  const exact = hits.filter((el) => squash(el.innerText) === squash(WANTED[0]));
  const pool = exact.length ? exact : hits;
  // 取最内层：命中的祖先（整块登录卡片）innerText 里也含这几个字，点它没有用。
  const target = pool.filter((el) => !pool.some((other) => other !== el && el.contains(other)))[0] || null;
  if (!target) return JSON.stringify({ ok: false, reason: 'no-tab', tried: WANTED, tabs: readTabs() });
  target.click();
  // 等 React 重渲染完再读一次「哪个 tab 是选中态」——点了不等于切成功。
  return new Promise((resolve) => setTimeout(() => {
    const tabs = readTabs();
    const active = tabs.filter((tab) => tab.checked)[0] || null;
    resolve(JSON.stringify({
      ok: Boolean(active) && wanted.indexOf(squash(active.text)) >= 0,
      clicked: (target.innerText || '').trim(),
      active: active ? active.text : '',
      tabs: tabs,
    }));
  }, 300));
})()`;

/**
 * 判断一个紫鸟店铺是不是 TEMU 店。
 *
 * 两个平台名（`Temu-中国卖家中心` / `Temu-美国-本土`）与店名（`Temu-CN-客服`、
 * `TEMU-COZYNOME-管理员`、`Temu-US-管理员`）两处都认：只认 platformName 会漏掉运营
 * 把平台名写歪的店，只认店名会漏掉店名不带 Temu 而平台名是 Temu 的店。
 * @param {{platformName?: string, storeName?: string}} store - 店铺。
 * @returns {boolean} 是否 TEMU 店。
 */
export function isTemuStore(store) {
  const platform = String(store?.platformName ?? '');
  const name = String(store?.storeName ?? '');
  return /temu|拼多多/i.test(platform) || /^temu\b/i.test(name) || /^temu[-_]/i.test(name);
}

/**
 * 这家 TEMU 店该走哪套后台。
 *
 * 判据是 platformName（+ 店名里的 US 段兜底），**不是**店名里有没有中文：
 * 实测 `Temu-美国-本土` 走 seller.temu.com，`Temu-中国卖家中心` 走
 * seller.kuajingmaihuo.com。分错了会把人送到 no-auth.html —— 那是开错平台，不是没登录。
 * @param {{platformName?: string, storeName?: string}} store - 店铺。
 * @returns {string} BACKEND_KUAJING 或 BACKEND_SELLER_CENTRAL。
 */
export function backendOf(store) {
  const platform = String(store?.platformName ?? '');
  const name = String(store?.storeName ?? '');
  const overseas = /美国|美区|美站|本土|local|overseas/i.test(platform) || /^temu[-_ ]?us\b/i.test(name);
  return overseas ? BACKEND_SELLER_CENTRAL : BACKEND_KUAJING;
}

/**
 * 这家店该打开的首页。
 * @param {{platformName?: string, storeName?: string}} store - 店铺。
 * @returns {string} 首页地址。
 */
export function homeUrlFor(store) {
  return BACKEND_HOME_URLS[backendOf(store)];
}

/**
 * 从地址判出它在哪套 TEMU 后台；不在任何一套时返回 null。
 *
 * 用于把「窗口停在 about:blank / 别的网站」与「停在本渠道后台」分开 ——
 * 这两件事要人做的事完全不同（一个是「点登录把页面开起来」，一个是「已就绪」）。
 * @param {unknown} url - 页面地址。
 * @returns {string|null} 后台 id 或 null。
 */
export function backendOfUrl(url) {
  const value = String(url ?? '');
  if (!value) return null;
  for (const [backend, host] of Object.entries(BACKEND_HOSTS)) {
    if (value.indexOf('//' + host) >= 0 || value.indexOf('.' + host) >= 0) return backend;
  }
  return null;
}

/**
 * 这个地址是不是「没进后台」。
 *
 * 两套后台的判据都认（**不按店铺分**）：地址本身就能说明问题，而 checkLogin 在店铺还没
 * 开过窗口时也可能被调用。
 * @param {unknown} url - 页面地址。
 * @returns {boolean} 是否停在登录/未授权页。
 */
export function isSigninUrl(url) {
  const value = String(url ?? '');
  if (!value) return false;
  if (KUAJING_LOGIN_URL_RE.test(value)) return true;
  return SELLER_CENTRAL_NO_AUTH_URL_RE.test(value) || SELLER_CENTRAL_LOGIN_URL_RE.test(value);
}

/** 未登录时给的可照做提示（两套后台共用一句）。 */
const SIGNIN_HINT =
  '在紫鸟里打开该店铺并完成 TEMU 卖家中心登录（扫码 / 手机号 / 邮箱验证码，插件不代劳），然后重新巡逻';

/** 买家会话收件箱尚未校准时抛的固定原因串（测试与校准脚本都认它）。 */
export const INBOX_NOT_CALIBRATED_REASON = 'inbox-not-calibrated';

/**
 * 建一个 TEMU 适配器。
 * @param {{ziniao: object, settings?: object, logger?: object}} options - 紫鸟CLI 客户端与设置。
 * @returns {object} 适配器。
 */
export function createTemuAdapter({ ziniao, settings = {}, logger } = {}) {
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
   * 列出账号下所有 TEMU 店（实测 9 家，7 家在用 + 2 家店名带「停用」）。
   * @returns {Promise<Array<object>>} 店铺列表。
   */
  async function listStores() {
    // 与其它渠道同一口径：停用店不巡逻（判定见 ziniao.js 的 isRetiredStore）。
    return (await listAllStores()).filter((store) => isTemuStore(store) && !isRetiredStore(store));
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
   * 导航到这家店自己的后台首页。
   * @param {object} store - 店铺。
   * @returns {Promise<void>} 完成。
   */
  async function visitHome(store) {
    await ziniao.callOrThrow(
      [
        'page',
        'visit',
        '--store-id',
        store.storeId,
        '--url',
        homeUrlFor(store),
        '--wait-until',
        'domcontentloaded',
        '--timeout',
        String(NAV_TIMEOUT_MS),
      ],
      { what: '打开 TEMU 卖家后台', timeoutMs: NAV_TIMEOUT_MS + 30_000 },
    );
  }

  /**
   * 确认真的进了后台，而不是被弹回登录页。
   * @param {object} store - 店铺。
   * @returns {Promise<void>} 未登录时抛带 kind=auth 的错误。
   */
  async function assertSignedIn(store) {
    const url = await currentUrl(store);
    if (!isSigninUrl(url)) return;
    throw Object.assign(
      new Error('店铺未登录：TEMU 卖家中心把页面跳到了登录页，请先在紫鸟浏览器里登录该店铺后重跑'),
      { kind: 'auth', hint: SIGNIN_HINT },
    );
  }

  /**
   * 探测登录态 —— **不产生副作用**：不导航、不开店铺窗口。
   *
   * 判据只有「当前页面地址」，而且是**三段**判断（比 shein.js 多一段）：
   *   1. 读不到地址 → failed（窗口没开 / 这一跳失败，不是「没登录」）；
   *   2. 停在登录页 → login_required；
   *   3. 停在**别的地方**（about:blank、别的网站、另一套 TEMU 后台）→ failed。
   * 第 3 段是刻意加的：把 about:blank 当成「已登录」会让巡逻带着一个空窗口去读收件箱，
   * 报出来的错会指向收件箱而不是「页面根本没开」——那是更难查的一种失败。
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
    if (isSigninUrl(url)) {
      const backend = backendOf(store);
      return {
        state: LOGIN_STATES.LOGIN_REQUIRED,
        url,
        loggedIn: false,
        hint:
          backend === BACKEND_KUAJING
            ? '页面停在 TEMU 卖家中心登录页，等人完成登录（扫码 / 手机号 / 邮箱验证码，插件不代劳）'
            : '页面停在 TEMU Seller Central 登录页，等人完成登录（插件不代劳）',
      };
    }
    const expected = backendOf(store);
    const actual = backendOfUrl(url);
    if (actual !== expected) {
      const wrongPlatform = actual !== null && actual !== expected;
      return {
        state: LOGIN_STATES.FAILED,
        url,
        loggedIn: false,
        hint: wrongPlatform
          ? '店铺窗口停在 ' + BACKEND_HOSTS[actual] + '，但这家店按 platformName 该走 ' + BACKEND_HOSTS[expected]
            + '（TEMU 两套后台不能混用：开错平台会得到 no-auth.html，那不是「未登录」）'
          : '店铺窗口当前停在 ' + url + '，还不是 TEMU 卖家后台：先点「登录」把页面开到 '
            + BACKEND_HOSTS[expected] + '，脚本不会替你把窗口导航过去',
      };
    }
    return {
      state: LOGIN_STATES.LOGGED_IN,
      url,
      loggedIn: true,
      hint: '店铺已在登录态（' + BACKEND_HOSTS[expected] + '），可以继续巡逻',
    };
  }

  /**
   * 把登录页切到「手机号登录」tab。
   *
   * **为什么要有这一步**：跨境卖家中心的登录页默认停在「扫码登录」（实测 2026-10-12：
   * React 里是 useState(sessionType === Normal ? Scan : Account)，扫码在前），而客服日常用的是
   * 手机号 + 密码 / 验证码。点一次「登录」还要人手点一下 tab，属于白费一步。
   *
   * **只切 tab**：不填任何内容、不点「登录」、不碰验证码、不碰滑块 —— 与「插件不代替人登录」
   * 的约定不冲突（这条约定禁的是代填凭据和完成登录，不是把页面摆到人想要的那一屏）。
   * 用 page exec 里的 el.click()：紫鸟CLI 的 page click 实测点不动（见 README「两个踩过的坑」）。
   * @param {object} store - 店铺。
   * @returns {Promise<{ok: boolean, reason?: string, active?: string, tabs?: object[]}>} 结果。
   */
  async function selectPhoneLoginTab(store) {
    const backend = backendOf(store);
    if (backend !== BACKEND_KUAJING) {
      // 美区 / 欧区 Seller Central 的登录页没有这两个 tab（实测页面只有 Sign in / Sign up），
      // 切不了也不硬点 —— 硬点最可能点到「Sign up」，把人带到注册页去。
      return { ok: false, reason: 'not-applicable', backend };
    }
    const result = await ziniao.call(
      ['page', 'exec', '--store-id', store.storeId, '--script', PHONE_TAB_SCRIPT],
      { timeoutMs: 30_000 },
    );
    if (!result.ok) {
      return { ok: false, reason: 'exec-failed', backend, error: result.error?.message ?? '' };
    }
    const payload = unwrapExec(result.data);
    const data = payload && typeof payload === 'object' ? payload : null;
    if (!data) return { ok: false, reason: 'no-payload', backend };
    return { ...data, backend };
  }

  /**
   * 登录页摆好之后，把「切 tab 的结果」翻译成一句人话。
   * @param {string} base - 适配器原本的 hint。
   * @param {object|null} tab - selectPhoneLoginTab 的结果。
   * @returns {string} 给人看的 hint。
   */
  function loginHintWithTab(base, tab) {
    if (tab?.ok) {
      return (
        '登录页已打开，并已切到「' +
        (tab.active || '手机号登录') +
        '」：在紫鸟窗口里填手机号 + 密码 / 验证码完成登录（插件不代填、不点登录）'
      );
    }
    if (tab?.reason === 'not-applicable') {
      return '登录页已打开：在紫鸟窗口里完成登录（插件不代填、不点登录）';
    }
    return (
      '登录页已打开（默认停在「扫码登录」）：没能自动切到「手机号登录」（' +
      (tab?.reason ?? 'unknown') +
      '），请在窗口里手动点一下那个 tab'
    );
  }

  /**
   * 打开后台并**停下来等人** —— 这是「登录」按钮的全部职责。
   *
   * 打开店铺窗口 → 导航到这家店自己的后台首页：已登录就落在后台，未登录会被弹到登录页；
   * 停在登录页时再多做一步：把 tab 切到「手机号登录」（见 selectPhoneLoginTab）。
   * 除此之外不点任何按钮、不填任何东西。
   * @param {object} store - 店铺。
   * @returns {Promise<{state: string, url: string, hint: string, phoneLoginTab: object|null}>} 结果。
   */
  async function openLogin(store) {
    try {
      await openStore(store);
    } catch (cause) {
      return {
        state: LOGIN_STATES.FAILED,
        url: '',
        title: '',
        phoneLoginTab: null,
        hint:
          '打不开店铺「' +
          (store?.storeName ?? store?.storeId ?? '?') +
          '」：紫鸟那边这一步就失败了，先修这个再谈登录',
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    try {
      await visitHome(store);
    } catch (cause) {
      const probe = await checkLogin(store).catch(() => null);
      if (probe && probe.state === LOGIN_STATES.LOGGED_IN) {
        return { ...probe, title: '', phoneLoginTab: null };
      }
      return {
        state: LOGIN_STATES.FAILED,
        url: probe?.url ?? '',
        title: '',
        phoneLoginTab: null,
        hint: '导航到 TEMU 卖家后台失败：店铺窗口可能没起来，或网络不通（不是「未登录」）',
        error: cause instanceof Error ? cause.message : String(cause),
      };
    }
    const probe = await checkLogin(store);
    if (probe.state === LOGIN_STATES.LOGGED_IN) {
      return { ...probe, title: '', phoneLoginTab: null, hint: '店铺已在登录态，页面停在 TEMU 卖家后台' };
    }
    if (probe.state !== LOGIN_STATES.LOGIN_REQUIRED) {
      // failed：页面可能压根没打开，或停在别的网站 —— 这时去点 tab 只会点到别的东西上。
      return { ...probe, title: '', phoneLoginTab: null };
    }
    const phoneLoginTab = await selectPhoneLoginTab(store);
    return { ...probe, title: '', phoneLoginTab, hint: loginHintWithTab(probe.hint, phoneLoginTab) };
  }

  return {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'store',
    /**
     * 收件箱入口：**刻意留空**。
     *
     * 两套后台（seller.kuajingmaihuo.com / seller.temu.com）不可能共用一个地址，而
     * 「客服中心 → 消费者咨询」的真实 URL 还没校准。与 walmart 的「没有会话级深链就
     * 不给链接」同一取舍：宁可没有，也不把人送到一个不存在的页面。
     */
    inboxUrl: '',

    /**
     * 未校准 —— 让 /health 的 channelCalibration 如实露出来，不冒充「已接入」。
     * 会话行 / 会话正文 / 回复框三段没校准之前，这个字段一直是 false。
     */
    verified: false,
    calibrationNote:
      'TEMU 渠道已启用，但**只校准了登录这一段**（2026-10-12 实测 9 家店，全程用紫鸟CLI）：' +
      'platformName 两个写法（Temu-中国卖家中心 / Temu-美国-本土）→ 两套后台，' +
      '未登录判据（kuajingmaihuo 命中 /login；seller.temu.com 命中 /no-auth.html 或 /login.html），' +
      '以及两套后台的首页入口。**尚未覆盖**：买家会话工作台（Temu 课程里的「客服中心 → 消费者咨询」）、' +
      '会话行选择器、会话正文选择器、回复框（fillComposer 根本没导出）。' +
      '当天 9 家 TEMU 店**全部未登录**，一条真实会话都进不去，按本项目规矩不猜选择器；' +
      'listConversations 会直接抛错要求先校准，不会静默返回 0 条。',

    /**
     * 渠道启用：跟着紫鸟CLI 的开关走（与 amazon/tiktok/walmart/shein 同一口径）。
     * 要单独关掉 TEMU，用设置的 patrol.channels 把渠道 id 限定成别的那几个。
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
        return '这个渠道被停用了：把巡逻页里「TEMU」那一行的开关打开后才会巡逻 TEMU 店铺。';
      }
      return '紫鸟CLI 已在「设置」里禁用：重新启用后才会巡逻 TEMU 店铺。';
    },

    /* ── 巡逻面：引擎只认这几个方法 ── */
    listSources: listStores,
    queueChannel: 'temu',
    draftKind: 'temu',

    /**
     * 打开店铺并进到它自己的后台；没进到就抛错，引擎会记成这家店失败。
     * @param {object} store - 店铺。
     * @returns {Promise<void>} 完成。
     */
    async prepare(store) {
      await openStore(store);
      await visitHome(store);
      await assertSignedIn(store);
    },

    /**
     * 列出**待回复**会话。
     *
     * 收件箱还没校准（没见过一条真实会话），所以这里**恒抛**，绝不返回空列表：
     * 「返回 []」会让运营以为收件箱是空的，而真实情况是「我们根本还没接上」。
     * @param {object} store - 店铺。
     * @returns {Promise<never>} 恒定抛「未校准」。
     */
    async listConversations(store) {
      const backend = backendOf(store);
      throw Object.assign(
        new Error(
          'TEMU 买家会话收件箱还没校准：本适配器只校准到「登录 + 后台入口」，' +
            '「客服中心 → 消费者咨询」的真实地址与会话行选择器都还没在有会话的登录态上实测过。' +
            '这家店 [storeId ' + (store?.storeId ?? '?') + '] 走 ' + BACKEND_HOSTS[backend] + '。' +
            '请先按 lib/platforms/temu.js 文件头的清单登录一家 TEMU 店，再跑 ' +
            'node scripts/smoke-temu.mjs --store=' + (store?.storeId ?? '<storeId>') + ' 完成校准，' +
            '然后重新巡逻。**读不到不等于是 0 条**，所以这里直接报错。',
        ),
        { kind: 'page', reason: INBOX_NOT_CALIBRATED_REASON, backend },
      );
    },

    /**
     * 读完整会话 —— 收件箱校准之前不会被调用（见 listConversations 的守卫）。
     * @returns {Promise<never>} 恒定抛「未校准」。
     */
    async readConversation() {
      throw Object.assign(
        new Error('TEMU 会话正文选择器尚未校准：先补 THREAD_SELECTORS 与 CONVERSATION_WORKBENCH_URL 并更新 calibrationNote'),
        { kind: 'page', reason: INBOX_NOT_CALIBRATED_REASON },
      );
    },

    /** 会话标识：会话行校准后从行数据里取；现在恒为空（没有行）。 */
    conversationId: () => '',

    checkLogin,
    openLogin,
    selectPhoneLoginTab,
    homeUrlFor,
    backendOf,
    listAllStores,
    listStores,
    openStore,
    closeStore,
    visitHome,
  };
}

/**
 * 会话级深链：**没有**。
 *
 * TEMU 两套后台不共用地址，而「客服中心 → 消费者咨询」的 URL 还没校准 —— 与其给一个
 * 看着像对的错链接，不如不给（前端据此隐藏「打开原会话」入口，只留「复制正文」）。
 * 与 walmart.js 的取舍一致。
 * @returns {string} 恒定空串。
 */
export function conversationUrl() {
  return '';
}
