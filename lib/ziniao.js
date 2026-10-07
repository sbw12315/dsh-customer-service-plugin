/**
 * 紫鸟CLI 调用封装。
 *
 * 只做三件事，其余全部交给上层：
 *   1. 定位 + 缓存可执行文件（复用 clilocator，尊重 settings.cliPaths / 环境变量）；
 *   2. 统一前置附加参数（`cliArgs.ziniao`，例如换 profile）；
 *   3. 把 ziniao-cli 的 `{ok, data}` 信封解成 `{ok, data, raw}`，失败沿用 proc 的分类结果。
 *
 * 刻意不在这里做重试 —— 页面操作有副作用，盲目重试会把「点一次」变成「点两次」。
 * 需要重试的地方由调用方明确表达（例如等元素出现）。
 *
 * @module dsh-customer-service-plugin/lib/ziniao
 */

import { locateCli } from './clilocator.js';
import { runCli } from './proc.js';

/**
 * 取 ziniao-cli 信封里的 `data`。
 *
 * 三种真实形态都要兼容：
 *   - `{"ok":true,"data":{...}}`  → data
 *   - `page exec` 的两层包装 `{ok:true,data:{data:{result}}}` → 内层 data（由调用方再取 .result）
 *   - 纯文本输出（`--format table` 之类）→ null
 * @param {object|null} json - runCli 解出的 JSON。
 * @returns {any} data 字段或 null。
 */
export function unwrap(json) {
  if (!json || typeof json !== 'object') return null;
  if (json.ok === false) return null;
  return Object.prototype.hasOwnProperty.call(json, 'data') ? json.data : json;
}

/**
 * `page exec` 的返回值：脚本 return 的东西。
 *
 * CDP 对非字符串返回值会给一个 JSON 可序列化的对象，对字符串返回值也可能包一层；
 * 这里统一「是字符串就尝试当 JSON 解，解不出来就原样返回」。
 * @param {any} envelope - `unwrap(json)` 的结果。
 * @returns {any} 脚本返回值。
 */
export function unwrapExec(envelope) {
  if (!envelope || typeof envelope !== 'object') return null;
  const inner = Object.prototype.hasOwnProperty.call(envelope, 'data') ? envelope.data : envelope;
  const value = inner && typeof inner === 'object' && 'result' in inner ? inner.result : inner;
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (!text || (text[0] !== '{' && text[0] !== '[')) return value;
  try {
    return JSON.parse(text);
  } catch {
    return value;
  }
}

/**
 * 建一个紫鸟CLI 客户端。
 * @param {{ctx: object, settings: object, cwd: string, env?: Record<string,string>|Function, logger?: object, onResult?: Function, locate?: Function, run?: Function}} options - 配置。
 *   `locate` / `run` 是测试注入点；`env` 可以是对象，也可以是 `(located) => env` —— 后者是因为
 *   子进程 PATH 必须把 CLI 自己所在目录算进去，而那个目录要定位之后才知道。
 * @returns {object} 客户端。
 */
export function createZiniaoClient(options) {
  const ctx = options.ctx;
  const cwd = options.cwd;
  const envOption = options.env ?? {};
  const logger = options.logger ?? { warn: () => {} };
  const onResult = options.onResult;
  const locateImpl = options.locate ?? locateCli;
  const runImpl = options.run ?? runCli;

  /** 定位结果缓存：一次巡逻里会调几十次 CLI，每次都 resolveExecutable 太浪费。 */
  let located = null;
  /** 最近一次定位失败的原因，供上层原样展示。 */
  let lastError = null;

  /**
   * 定位可执行文件（带缓存）。
   * @param {{force?: boolean}} [opts] - 是否强制重新定位。
   * @returns {Promise<object>} 定位结果。
   */
  async function locate(opts = {}) {
    if (located && !opts.force) return located;
    const result = await locateImpl(ctx, 'ziniao', options.settings);
    located = result;
    lastError = result.found
      ? null
      : {
          kind: 'missing',
          type: null,
          subtype: null,
          message: `未找到${result.label}`,
          hint: `安装：${result.install}`,
          fixCommand: result.install,
          raw: null,
        };
    return result;
  }

  /**
   * 调一次紫鸟CLI。
   * @param {string[]} args - 子命令与参数（不含可执行文件与全局附加参数）。
   * @param {{timeoutMs?: number}} [opts] - 超时。
   * @returns {Promise<{ok: boolean, code: number|null, data: any, raw: any, stdout: string, stderr: string, error: object|null, durationMs: number}>} 结果。
   */
  async function call(args, opts = {}) {
    const found = await locate();
    if (!found.found || !found.path) {
      if (onResult) {
        try {
          onResult({ name: 'ziniao', args, ok: false, code: null, durationMs: 0, error: lastError, data: null });
        } catch {
          /* 审计回调失败不影响调用 */
        }
      }
      return { ok: false, code: null, data: null, raw: null, stdout: '', stderr: '', error: lastError, durationMs: 0 };
    }
    const result = await runImpl(ctx, {
      name: 'ziniao',
      cli: found.path,
      args: [...found.args, ...args],
      cwd,
      timeoutMs: opts.timeoutMs ?? 60_000,
      env: typeof envOption === 'function' ? envOption(found) : envOption,
      onResult: (outcome) => {
        if (typeof onResult !== 'function') return;
        try {
          onResult({
            name: 'ziniao',
            args,
            ok: outcome.ok,
            code: outcome.code,
            durationMs: outcome.durationMs,
            error: outcome.error,
            data: unwrap(outcome.json),
          });
        } catch {
          /* 审计回调失败不影响调用 */
        }
      },
    });
    return {
      ok: result.ok,
      code: result.code,
      data: unwrap(result.json),
      raw: result.json,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error,
      durationMs: result.durationMs,
    };
  }

  return {
    locate,
    call,
    /**
     * 调一次并直接返回解出来的 `data`，失败抛错。
     * @param {string[]} args - 参数。
     * @param {{timeoutMs?: number, what?: string}} [opts] - 选项。
     * @returns {Promise<any>} data。
     */
    async callOrThrow(args, opts = {}) {
      const result = await call(args, opts);
      if (!result.ok) {
        const message = result.error?.message ?? `紫鸟CLI 执行失败：${args.join(' ')}`;
        const error = new Error(`${opts.what ?? args.join(' ')} 失败：${message}`);
        error.kind = result.error?.kind ?? 'error';
        error.hint = result.error?.hint ?? null;
        error.fixCommand = result.error?.fixCommand ?? null;
        throw error;
      }
      return result.data;
    },
    /** 丢掉定位缓存（改了设置之后调用）。 */
    invalidate() {
      located = null;
      lastError = null;
    },
    get located() {
      return located;
    },
    get error() {
      return lastError;
    },
  };
}

/**
 * 把紫鸟CLI 的 `store list` 结果收敛成数组。
 *
 * 上游在不同版本里给过 `items` / `list` / `stores` 三种键，这里全部兼容 ——
 * 巡逻是「一个店都不能漏」的场景，键名猜错会静默少扫店铺。
 * @param {any} data - `store list` 的 data。
 * @returns {Array<{storeId: string, storeName: string, platformName: string, ip: string}>} 店铺列表。
 */
export function normalizeStoreList(data) {
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(data?.items)
      ? data.items
      : Array.isArray(data?.list)
        ? data.list
        : Array.isArray(data?.stores)
          ? data.stores
          : [];
  const out = [];
  const seen = new Set();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const storeId = String(entry.storeId ?? entry.store_id ?? entry.id ?? '').trim();
    if (!storeId || seen.has(storeId)) continue;
    seen.add(storeId);
    out.push({
      storeId,
      storeName: String(entry.storeName ?? entry.store_name ?? entry.name ?? '').trim(),
      platformName: String(entry.platformName ?? entry.platform_name ?? entry.platform ?? '').trim(),
      ip: String(entry.ip ?? '').trim(),
    });
  }
  return out;
}
