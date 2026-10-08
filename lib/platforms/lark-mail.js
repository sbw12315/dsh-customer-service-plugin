/**
 * 飞书邮箱适配器：巡逻**公共邮箱里未回复的邮件**，为每封生成一封回复草稿。
 *
 * 为什么需要它：亚马逊那条线看的是店铺站内信，而平台通知、供应商、物流、货代的往来
 * 全在公共邮箱里 —— 那才是「漏回一封就出事」的地方。
 *
 * 数据来源（全部 `--as bot`，用租户身份，不需要用户授权）：
 *   mail user_mailboxes accessible_mailboxes  → 逐个确认配置里的邮箱可见，并取到它的类型
 *   mail user_mailbox.threads list            → 收件箱会话 ID
 *   mail +thread --thread-id X --html=false   → 会话全部邮件
 *   mail +reply --message-id X --body ...     → 建回复草稿（默认就是草稿，不加 --confirm-send）
 *
 * 为什么邮箱要显式配置：bot 用的是租户 token，邮箱接口不接受 `me`
 * （实测报 `tenant access token not support me`），「列出全部可访问邮箱」只对 user 身份成立。
 * 所以地址写在 settings.mailboxes 里，逐个过 accessible_mailboxes 确认可见性 ——
 * 既拿到邮箱类型，也让「地址配错」在扫描阶段就明确报错，而不是等巡逻时才失败。
 *
 * **硬约束：这个文件里没有任何发送动作。** `+reply` 不带 `--confirm-send` 时只写草稿，
 * 发送必须由人在飞书里点。
 *
 * @module dsh-customer-service-plugin/lib/platforms/lark-mail
 */

/** 渠道标识（也是草稿的 platform 字段）。 */
export const PLATFORM_ID = 'lark-mail';
/** 渠道展示名。 */
export const PLATFORM_LABEL = '飞书邮箱';

/** 飞书邮箱类型 → 展示名。 */
const MAILBOX_TYPE_LABEL = {
  USER_PRIMARY: '个人主邮箱',
  USER_ALIAS: '个人别名',
  PUBLIC_MAILBOX: '公共邮箱',
  PUBLIC_MAILBOX_ALIAS: '公共邮箱别名',
  MAIL_GROUP: '邮件组',
};

/** 未回复判定：会话里最后一封是「收到的」（我方发的发出件/草稿都算已处理）。 */
const INBOUND_STATE = 'received';

/**
 * 明确不是「有人在等回复」的发件地址。
 *
 * 这类地址回过去没人看，只会污染草稿库 —— 实跑时公共邮箱里一半以上都是这种。
 * 可被 settings.patrol.mailSkipSenders 覆盖/追加。
 */
export const DEFAULT_SKIP_SENDERS = [
  /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|auto[-_.]?reply|auto[-_.]?confirm|automated|notification[s]?|mailer[-_.]?daemon|bounce[s]?|postmaster)@/i,
];

/**
 * 群发/系统通知的特征：正文里带退订或通知偏好入口。
 *
 * 这是「系统在通知你」和「有人在等你回信」之间最干净的分界 —— 真实客户来信不会带
 * 「停止接收…通知邮件」。实跑里的「收入款项 $299.93 USD」就是靠这条挡掉的。
 */
export const BULK_HINT =
  /unsubscribe|取消订阅|退订|停止接收[^。\n]{0,14}通知|通知邮件设置|email preferences|notification settings|manage (?:your )?subscriptions?/i;

/** 平台转发联系表单的标志。先命中它才去抠字段，避免把客户正文里的 "Name:" 当成字段。 */
const CONTACT_FORM_MARKER = /contact form|Country Code:|ContactForm-/i;

/**
 * 联系表单里的字段。
 *
 * **不能按行首锚定。** 飞书的 body_plain_text 会把整封压成一行：
 *   "… contact form. Country Code: US Id: … Name: Memo Navarrete Email: a@b.com Phone: Body: 缺一根横档"
 * 用 ^(Name|Email|Body): 一条都匹配不上 —— 实跑时草稿因此一直以平台名为收件人。
 * 改成「字段名出现在任意位置」，靠后续字段名或结尾收口。
 */
const CONTACT_FORM_FIELDS = {
  name: /\bName:\s*(.*?)(?=\s+(?:Email|Phone|Body|Country Code|Id):|$)/i,
  email: /\bEmail:\s*([^\s]+@[^\s]+)/i,
  body: /\bBody:\s*([\s\S]*)$/i,
};

/**
 * 从平台转发的联系表单里抠出真正的来信人。
 *
 * 公共邮箱收到的「New customer message」其实是平台代发的：发件人是平台的系统地址，
 * 而真正的客户姓名/邮箱/正文都在正文里。不回信还好，一旦以「平台」为收件人生成草稿，
 * 称呼和收件人都错。所以这里把客户本人认出来，并记一条提示让人核对收件人。
 * @param {string} body - 正文。
 * @returns {{name: string, email: string, body: string}|null} 联系表单信息。
 */
export function parseContactForm(body) {
  const text = String(body ?? '');
  if (!CONTACT_FORM_MARKER.test(text)) return null;
  const email = CONTACT_FORM_FIELDS.email.exec(text)?.[1]?.trim() ?? '';
  const name = CONTACT_FORM_FIELDS.name.exec(text)?.[1]?.trim() ?? '';
  const inner = CONTACT_FORM_FIELDS.body.exec(text)?.[1]?.trim() ?? '';
  if (!email && !inner) return null;
  return { name, email, body: inner.slice(0, 2000) };
}

/**
 * 建一个飞书邮箱适配器。
 * @param {{lark: object, settings?: object, logger?: object}} options - 配置。
 * @returns {object} 适配器。
 */
export function createLarkMailAdapter(options) {
  const lark = options.lark;
  // info 也要有默认值：适配器会用它报「跳过了几封自动通知」，缺了会在直接调用时炸掉。
  const logger = options.logger ?? { warn: () => {}, info: () => {} };
  // 只捕获 settings 对象本身，字段每次调用现读 —— 设置页保存后无需重启。
  const settings = options.settings ?? {};
  /** 跳过哪些发件人：默认那几条 + 用户在设置里追加的（字符串当正则用）。 */
  const skipSenders = [
    ...DEFAULT_SKIP_SENDERS,
    ...((settings.patrol?.mailSkipSenders ?? []).map((item) => {
      try {
        return new RegExp(String(item), 'i');
      } catch {
        return null;
      }
    })),
  ].filter(Boolean);

  const READ_TIMEOUT_MS = 60_000;

  /** 把 CLI 的认证类失败翻译成一句能照着做的话。 */
  function explain(cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (/need_user_authorization|token_missing|authentication/i.test(message)) {
      const error = new Error(
        `飞书邮箱授权失败（当前走 bot 身份）：${message.replace(/\s+/g, ' ').slice(0, 200)}`,
      );
      error.kind = 'auth';
      error.hint =
        '用 bot 身份手动复现：lark-cli --profile <profile> --as bot mail user_mailboxes '
        + 'accessible_mailboxes --params \'{"user_mailbox_id":"<邮箱地址>"}\'；'
        + '仍报错说明机器人没有邮箱权限，或该邮箱不属于这个租户';
      return error;
    }
    return cause;
  }

  /** 调一次 lark-cli，失败时抛出可读错误。 */
  async function call(args, what, timeoutMs = READ_TIMEOUT_MS) {
    try {
      return await lark.callOrThrow(args, { what, timeoutMs });
    } catch (cause) {
      throw explain(cause);
    }
  }

  /**
   * 按 settings.mailboxes 逐个确认可访问的邮箱。
   *
   * bot 身份不能用 `me` 枚举（租户 token 不支持），所以邮箱列表是显式配置的；
   * 这里仍过一次 accessible_mailboxes，是为了拿到邮箱类型、并让「配错了地址」
   * 在扫描阶段就报出来，而不是等到巡逻时才失败。
   * @returns {Promise<Array<object>>} 邮箱列表。
   */
  async function listSources() {
    const configured = Array.isArray(settings.mailboxes) ? settings.mailboxes : [];
    if (configured.length === 0) {
      throw new Error(
        '还没有配置巡逻邮箱：打开「设置 → 巡逻邮箱」，填上要巡逻的飞书邮箱地址'
          + '（bot 身份无法自动枚举邮箱，必须显式指定）',
      );
    }
    const sources = [];
    for (const address of configured) {
      const data = await call(
        ['mail', 'user_mailboxes', 'accessible_mailboxes', '--as', 'bot', '--params', JSON.stringify({ user_mailbox_id: address }), '--format', 'json'],
        `确认邮箱 ${address}`,
      );
      const list = Array.isArray(data?.accessible_mailboxes) ? data.accessible_mailboxes : [];
      const hit = list.find(
        (entry) => String(entry.email_address ?? '').trim().toLowerCase() === String(address).toLowerCase(),
      );
      if (!hit) {
        logger.warn(`邮箱 ${address} 对当前飞书身份不可见，已跳过`);
        continue;
      }
      sources.push({
        // 复用巡逻引擎的 store* 字段名：对邮箱来说「店铺」就是邮箱地址。
        storeId: address,
        storeName: address,
        platformName: MAILBOX_TYPE_LABEL[hit.email_type] ?? String(hit.email_type ?? '邮箱'),
        // 列表是人工显式配置的，配了就是要巡逻 —— 不再按「公共邮箱」筛选，
        // 否则把自己主邮箱写进来的人会看到「配了却一个都不扫」。
        isShared: true,
        // 判断「这封是不是我方发的」时，配置里的所有地址都算我方。
        selfAddresses: [...configured],
      });
    }
    if (sources.length === 0) {
      throw new Error(`配置的 ${configured.length} 个邮箱都对当前飞书身份不可见，请检查地址或机器人权限`);
    }
    return sources;
  }

  /** 取收件箱会话 ID（先只拿 id，内容后面按需读）。 */
  async function listInboxThreadIds(source, pageSize) {
    const data = await call(
      [
        'mail', 'user_mailbox.threads', 'list', '--as', 'bot',
        '--params', JSON.stringify({ user_mailbox_id: source.storeId, page_size: Math.min(20, Math.max(1, pageSize)), folder_id: 'INBOX' }),
        '--format', 'json',
      ],
      `列出 ${source.storeName} 的收件箱会话`,
    );
    const items = Array.isArray(data?.items) ? data.items : [];
    return items.map((item) => String(item.id ?? '')).filter(Boolean);
  }

  /** 读一个会话的全部邮件。 */
  async function fetchThread(source, threadId) {
    const data = await call(
      ['mail', '+thread', '--as', 'bot', '--mailbox', source.storeId, '--thread-id', threadId, '--html=false', '--format', 'json'],
      `读取会话 ${threadId}`,
    );
    return Array.isArray(data?.messages) ? data.messages : [];
  }

  /** 这封邮件是不是我方发出的（用户名下任一邮箱地址都算我方）。 */
  function isOurs(message, source) {
    const address = String(message?.head_from?.mail_address ?? '').trim().toLowerCase();
    if (!address) return false;
    const mine = new Set([
      String(source.storeId).toLowerCase(),
      ...(source.selfAddresses ?? []).map((entry) => String(entry).toLowerCase()),
    ]);
    return mine.has(address);
  }

  /**
   * 把一个飞书会话规范成巡逻引擎认识的形状。
   * @param {Array<object>} messages - 会话里的邮件（时间升序）。
   * @param {object} source - 邮箱。
   * @returns {object|null} 规范化会话；没有来信则返回 null。
   */
  function normalizeThread(messages, source) {
    if (!Array.isArray(messages) || messages.length === 0) return null;
    const normalized = messages.map((message) => {
      const mine = isOurs(message, source);
      return {
        dir: mine ? 'out' : 'in',
        date: String(message.date_formatted ?? ''),
        body: String(message.body_plain_text ?? message.body_preview ?? '').trim(),
        messageId: String(message.message_id ?? ''),
        state: String(message.message_state_text ?? ''),
        from: message.head_from ?? null,
      };
    });
    const inbound = normalized.filter((entry) => entry.dir === 'in');
    if (inbound.length === 0) return null;

    const last = normalized[normalized.length - 1];
    const lastInbound = inbound[inbound.length - 1];
    const first = messages[0];
    const security = messages.map((message) => message.security_level).find(Boolean) ?? null;

    const senderAddress = String(lastInbound.from?.mail_address ?? '').trim();
    const senderName = String(lastInbound.from?.name ?? '').trim();

    // 平台代发的联系表单：真正的客户在正文里。
    //
    // **必须先解析它，再决定跳不跳。** 平台的通知地址（no-reply@shopify.com）同时也用来
    // 代发「联系表单」——那是真客户留言，只是借了同一个信封。先按发件地址一刀切，
    // 会把等着回复的客户一起丢掉。
    const form = parseContactForm(lastInbound.body);

    // 有人在等回复吗？两条判据：发件地址本身就是 no-reply 之类；或正文带退订入口
    // （系统群发）。都不是「回信没意义」，而是「这封不是来信」。
    const skipReason = form
      ? null
      : skipSenders.some((pattern) => pattern.test(senderAddress))
        ? `发件地址是自动通知（${senderAddress}）`
        : BULK_HINT.test(lastInbound.body)
          ? '正文带退订/通知偏好入口，属于系统群发'
          : null;
    const warnings = [];
    let buyer = senderName || senderAddress;
    let buyerAddress = senderAddress;
    if (form) {
      if (form.name) buyer = form.name;
      buyerAddress = form.email || senderAddress;
      warnings.push(
        form.email
          ? `这封是平台代发的联系表单，来信人 ${form.name || '(未署名)'} <${form.email}>；回信前请确认收件人是不是客户本人`
          : '这封是平台代发的联系表单，回信前请确认收件人是不是客户本人',
      );
    }

    return {
      threadId: String(first?.thread_id ?? ''),
      url: '',
      buyer,
      buyerAddress,
      senderAddress,
      senderName,
      subject: String(first?.subject ?? ''),
      messages: normalized,
      // 平台转发时，正文里的客户留言才是要回应的内容。
      lastInbound: { dir: 'in', date: lastInbound.date, body: form?.body || lastInbound.body },
      lastMessageId: lastInbound.messageId,
      messageCount: normalized.length,
      // 未回复 = 会话最后一条是来信。我方已回（或已存在草稿）就不再打扰。
      needsReply: last.dir === 'in' && last.state !== 'draft',
      skipReason,
      warnings,
      security: security
        ? { is_risk: Boolean(security.is_risk), risk_banner_reason: security.risk_banner_reason ?? null, is_header_from_external: Boolean(security.is_header_from_external) }
        : null,
    };
  }

  return {
    id: PLATFORM_ID,
    label: PLATFORM_LABEL,
    kind: 'mailbox',
    listSources,

    /**
     * 这个渠道是否启用。
     *
     * 默认**关闭**：邮箱要先手动接好飞书CLI（路径 + 附加参数 profile），再手动打开开关。
     * 关闭时巡逻引擎直接跳过它、扫描接口只回报「未启用」，都不当成失败。
     * @returns {boolean} 是否启用。
     */
    enabled() {
      return settings.mailEnabled === true;
    },

    /** 队列渠道与草稿模板族：飞书邮件复用既有的 mail 渠道。 */
    queueChannel: 'mail',
    draftKind: 'mail',

    /** 会话标识就是 thread_id。 */
    conversationId: (thread) => String(thread?.threadId ?? ''),

    /** 邮箱是纯 API，没有「打开浏览器」这一步。 */
    async prepare() {},

    /**
     * 列出未回复的会话。
     *
     * 顺序刻意是「先拿会话 ID，再逐个读」：会话列表接口不返回发件人，无法只凭它判断
     * 是否已回复；反过来先读全文又会把已回复的也读一遍。所以按需读，并给巡检数量设上限。
     * @param {object} source - 邮箱。
     * @param {{max?: number}} [opts] - 最多产出多少条。
     * @returns {Promise<{items: object[]}>} 结果。
     */
    async listConversations(source, opts = {}) {
      const max = Number.isFinite(opts.max) && opts.max > 0 ? opts.max : 3;
      const threadIds = await listInboxThreadIds(source, Math.min(20, max * 4));
      const items = [];
      const skipped = [];
      for (const threadId of threadIds) {
        if (items.length >= max) break;
        let messages;
        try {
          messages = await fetchThread(source, threadId);
        } catch (cause) {
          logger.warn(`读取会话失败（跳过）：${cause instanceof Error ? cause.message : cause}`);
          continue;
        }
        const thread = normalizeThread(messages, source);
        if (!thread || !thread.needsReply) continue;
        if (thread.skipReason) {
          // 不是「读失败」，是「这封不是来信」：单独计数，界面上要能看见跳过了多少。
          skipped.push({ subject: thread.subject, reason: thread.skipReason });
          continue;
        }
        items.push({
          index: items.length,
          buyer: thread.buyer,
          subject: thread.subject,
          orderId: /\b(\d{3}-\d{7}-\d{7})\b/.exec(thread.subject)?.[1] ?? '',
          dueText: '',
          caseId: thread.threadId,
          messageId: thread.lastMessageId,
          // 会话已经在手上，readConversation 直接返回它，不再重复拉一次。
          thread,
        });
      }
      if (skipped.length > 0) {
        logger.info(`[${PLATFORM_LABEL}] ${source.storeName}：跳过 ${skipped.length} 封自动通知/系统群发`);
      }
      return { items, skipped };
    },

    /** 会话在 listConversations 时已经读完了。 */
    async readConversation(source, item) {
      if (!item.thread) throw new Error('会话内容缺失：listConversations 没有带上 thread');
      return item.thread;
    },

    /** 邮箱没有「关闭」动作。 */
    async closeSource() {},

    /** 没有稳定的深链可给，返回 null 让界面隐藏这个入口。 */
    conversationUrl() {
      return null;
    },

    /**
     * 把草稿写进飞书的草稿箱 —— **只建草稿，不发送**。
     *
     * `+reply` 不带 `--confirm-send` 时本身就是「保存为草稿」，插件的硬约束因此天然满足。
     * @param {object} source - 邮箱。
     * @param {{item: object, body: string}} input - 目标邮件与正文。
     * @returns {Promise<{draftId: string|null, messageId: string|null}>} 结果。
     */
    async createExternalDraft(source, input) {
      const body = String(input?.body ?? '');
      if (!body.trim()) throw new Error('草稿内容为空，拒绝写入飞书草稿箱');
      const messageId = String(input?.item?.messageId ?? '');
      if (!messageId) throw new Error('这条草稿缺少原始 message_id，无法在飞书里建回复草稿');
      const data = await call(
        ['mail', '+reply', '--as', 'bot', '--mailbox', source.storeId, '--message-id', messageId, '--body', body],
        '创建飞书回复草稿',
      );
      return {
        draftId: String(data?.draft_id ?? data?.data?.draft_id ?? '') || null,
        messageId: String(data?.message_id ?? data?.data?.message_id ?? '') || null,
      };
    },
  };
}
