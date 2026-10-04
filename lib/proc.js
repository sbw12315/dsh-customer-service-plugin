/**
 * 外部 CLI 的统一调用层：子进程、超时、输出解析、失败分类。
 *
 * 解析层必须同时容忍两种真实情况：
 *   1. lark-cli 的 stderr 不是纯 JSON —— 前面会有 `[lark-cli] [WARN] ...`、`tip: ...`；
 *   2. ziniao-cli 的早期失败（未配置、参数校验、未知命令）走的是纯文本 `Error: ...`，
 *      根本不进它的 JSON 信封。
 * 所以统一策略是：优先取 stdout 的 JSON，再从 stderr 里取「最后一个平衡的 JSON 对象」，
 * 都拿不到就退回文本首行。
 *
 * @module dsh-customer-service-plugin/lib/proc
 */

import fs from 'node:fs';

/** 默认单流输出上限（字节）。 */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
/** 默认 spill 上限。 */
const DEFAULT_SPILL_BYTES = 8 * 1024 * 1024;
/** 默认结束宽限期。 */
const DEFAULT_GRACE_MS = 5000;

/**
 * 从 `start` 处的 `{`/`[` 找到与之配对的结束位置（正确处理字符串与转义）。
 * @param {string} text - 源文本。
 * @param {number} start - 起始下标。
 * @returns {number} 结束下标，找不到返回 -1。
 */
function matchEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 扫描文本里所有平衡的 JSON 对象/数组。
 * @param {string} text - 源文本。
 * @returns {Array<{value: unknown, start: number, end: number}>} 命中列表。
 */
export function scanJsonValues(text) {
  const out = [];
  if (typeof text !== 'string' || text.length === 0) return out;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch !== '{' && ch !== '[') {
      i += 1;
      continue;
    }
    const end = matchEnd(text, i);
    if (end < 0) break;
    try {
      out.push({ value: JSON.parse(text.slice(i, end + 1)), start: i, end });
    } catch {
      // 不是合法 JSON，继续往后扫。
    }
    i = end + 1;
  }
  return out;
}

/**
 * 取文本里最后一个对象形式的 JSON。
 * @param {string} text - 源文本。
 * @returns {any|null} 结果或 null。
 */
export function lastJsonObject(text) {
  const values = scanJsonValues(text).filter(
    (entry) => entry.value !== null && typeof entry.value === 'object' && !Array.isArray(entry.value),
  );
  return values.length > 0 ? values[values.length - 1].value : null;
}

/**
 * 取第一个非空行。
 * @param {string} text - 源文本。
 * @returns {string} 结果。
 */
export function firstLine(text) {
  if (typeof text !== 'string') return '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/**
 * 把失败结果归成可展示的类型，并给出可复制的修复命令。
 * @param {{name: string, code: number|null, stdout: string, stderr: string, timedOut?: boolean}} input - 结果。
 * @returns {{kind: string, type: string|null, subtype: string|null, message: string, hint: string|null, fixCommand: string|null, raw: any|null}} 分类结果。
 */
export function classifyFailure(input) {
  const { name, code } = input;
  const env = lastJsonObject(input.stderr) ?? lastJsonObject(input.stdout);
  const error = env && env.ok === false && env.error ? env.error : null;
  const type = typeof error?.type === 'string' ? error.type : null;
  const subtype = typeof error?.subtype === 'string' ? error.subtype : null;
  let message = typeof error?.message === 'string' ? error.message : '';
  let hint = typeof error?.hint === 'string' ? error.hint : null;
  if (!message) message = firstLine(input.stderr) || firstLine(input.stdout);
  if (!message) message = typeof code === 'number' ? `退出码 ${code}` : '命令执行失败';

  let kind = 'error';
  if (input.timedOut) kind = 'timeout';
  else if (code === 10 || type === 'confirmation') kind = 'confirmation';
  else if (code === 3 || type === 'authentication') kind = 'auth';
  else if (code === 2 || type === 'validation') kind = 'validation';
  else if (type === 'network') kind = 'network';
  else if (type === 'gateway' || type === 'business') kind = 'error';

  // ziniao-cli 的早期失败是纯文本，需要单独识别。
  if (kind === 'error' && name === 'ziniao' && /未找到配置文件|config init/.test(message)) {
    kind = 'auth';
    hint = hint ?? '需要先完成紫鸟CLI 配置';
  }
  // 紫鸟客户端登录态失效也是纯文本，且措辞固定（vendor skill 的硬约束）。
  if (kind === 'error' && name === 'ziniao' && /not logged in|未登录|notlogin/i.test(message)) {
    kind = 'auth';
    hint = hint ?? '紫鸟客户端登录态失效';
  }

  let fixCommand = null;
  if (kind === 'auth') {
    fixCommand =
      name === 'lark'
        ? 'lark-cli auth login --domain mail'
        : /zclaw|登录|logged in/i.test(message)
          ? 'ziniao-cli zclaw login'
          : 'ziniao-cli config init';
  } else if (kind === 'network') {
    fixCommand = name === 'ziniao' ? 'ziniao-cli doctor' : 'lark-cli doctor';
  } else if (kind === 'timeout') {
    fixCommand = null;
  }

  return { kind, type, subtype, message, hint, fixCommand, raw: env };
}

/**
 * 为「子进程起不来」给出**具体**的排查方向。
 *
 * 实测教训：`ziniao-cli` 是 `#!/usr/bin/env node` 的脚本，飞书的是 `/bin/sh` 脚本。
 * 路径本身找到了、权限也对，唯一缺的是 PATH 里没有 `node` —— 但旧提示只说
 * 「请检查 CLI 路径与可执行权限」，会把人带到错误的方向。
 * @param {string} message - 原始错误信息。
 * @param {string[]} argv - 实际使用的 argv。
 * @returns {string} 可操作的提示。
 */
export function spawnHint(message, argv = []) {
  const target = argv[0] ?? '(未指定)';
  if (/ENOENT/i.test(message)) {
    return [
      `找不到可执行文件「${target}」。`,
      '可能原因：① 路径写错或 CLI 未安装；② 它是 #!/usr/bin/env node 脚本，但子进程 PATH 里没有 node；',
      '③ 文件没有可执行权限。可在控制台「手动指定 CLI 路径」里换成 CLIs 的真实绝对路径后重试。',
    ].join('');
  }
  if (/EACCES|EPERM/i.test(message)) {
    return `没有执行「${target}」的权限：给它加可执行位（chmod +x）后重试。`;
  }
  return `子进程未能启动（${target}）。请检查 CLI 路径、可执行权限与解释器是否在 PATH 中。`;
}

/**
 * 调用一个外部 CLI。
 *
 * 契约刻意用 `{ cli, args }` 而不是 `argv`：子进程的 `argv[0]` 是**可执行文件**，
 * 早期版本直接传 `argv: ['--version']` 就变成了 `spawn --version ENOENT`。
 * 把可执行文件与参数分开，从根上避免这一类错误。
 *
 * @param {object} ctx - Cordis 上下文。
 * @param {{name: string, cli: string, args?: string[], cwd: string, timeoutMs?: number, env?: Record<string, string>, maxBytes?: number, onResult?: (result: object) => void}} options - 调用参数。
 *   `onResult` 在**每一条返回路径**上都会被调用（含参数错误/环境缺失），调用方用它写活动审计；
 *   回调自身抛错会被吞掉，绝不影响调用结果。
 * @returns {Promise<object>} 统一结果对象。
 */
export async function runCli(ctx, options) {
  const { name, cli, cwd, env: extraEnv = {} } = options;
  const args = options.args ?? [];
  const timeoutMs = options.timeoutMs ?? 60000;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const started = Date.now();
  const argv = typeof cli === 'string' && cli.trim() ? [cli, ...args] : [...args];
  /** 统一出口：保证每条返回路径都被记录，且回调抛错不影响结果。 */
  const finish = (result) => {
    if (typeof options.onResult === 'function') {
      try {
        options.onResult(result);
      } catch {
        /* 记录失败不能影响调用结果 */
      }
    }
    return result;
  };
  const base = {
    name,
    argv,
    args,
    code: null,
    signal: null,
    timedOut: false,
    durationMs: 0,
    stdout: '',
    stderr: '',
    json: null,
    error: null,
    ok: false,
    unavailable: false,
  };

  if (typeof cli !== 'string' || cli.trim() === '') {
    return finish({
      ...base,
      durationMs: Date.now() - started,
      error: {
        kind: 'config',
        type: null,
        subtype: null,
        message: `未指定 ${name} 的可执行文件路径`,
        hint: '在控制台的「手动指定 CLI 路径」里填写绝对路径',
        fixCommand: null,
        raw: null,
      },
    });
  }

  // 子进程对不存在的 cwd 只报一个 ENOENT，排查起来极其费劲，这里提前变成可读错误。
  if (typeof cwd !== 'string' || cwd.trim() === '' || !fs.existsSync(cwd)) {
    return finish({
      ...base,
      durationMs: Date.now() - started,
      error: {
        kind: 'config',
        type: null,
        subtype: null,
        message: `工作目录不存在：${cwd ?? '(未指定)'}`,
        hint: '在控制台「概览与体检」里检查数据目录，或让它重新创建',
        fixCommand: null,
        raw: null,
      },
    });
  }

  const subprocess = ctx?.get?.('subprocess');
  if (!subprocess?.spawn) {
    return finish({
      ...base,
      unavailable: true,
      durationMs: Date.now() - started,
      error: {
        kind: 'unavailable',
        type: null,
        subtype: null,
        message: '宿主未提供 subprocess 服务，无法调用外部 CLI',
        hint: '该 DSH 组合缺少 @deepseek-ai/dsh-subprocess-local',
        fixCommand: null,
        raw: null,
      },
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const handle = subprocess.spawn({
      argv,
      cwd,
      graceMs: DEFAULT_GRACE_MS,
      signal: controller.signal,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes, spill: { maxBytes: DEFAULT_SPILL_BYTES } },
        stderr: { maxBytes, spill: { maxBytes: DEFAULT_SPILL_BYTES } },
      },
      env: { ...extraEnv },
    });
    const outcome = await handle.done;
    const stdout = handle.collected?.stdout?.readFrom(0)?.text ?? '';
    const stderr = handle.collected?.stderr?.readFrom(0)?.text ?? '';
    const code = typeof outcome?.exitCode === 'number' ? outcome.exitCode : null;
    const timedOut = controller.signal.aborted === true && code !== 0;
    const json = lastJsonObject(stdout);
    const ok = code === 0;
    return finish({
      ...base,
      code,
      signal: outcome?.signal ?? null,
      timedOut,
      durationMs: Date.now() - started,
      stdout,
      stderr,
      json,
      ok,
      error: ok ? null : classifyFailure({ name, code, stdout, stderr, timedOut }),
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return finish({
      ...base,
      durationMs: Date.now() - started,
      error: {
        kind: controller.signal.aborted ? 'timeout' : 'spawn',
        type: null,
        subtype: null,
        message,
        hint: spawnHint(message, argv),
        fixCommand: null,
        raw: null,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}
