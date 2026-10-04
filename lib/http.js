/**
 * 控制台的 HTTP 载体：静态资源 + JSON 接口。
 *
 * 用普通 node:http 的 `(req, res)` 签名，直接挂到宿主的 webServer 前缀路由上。
 * 之所以用「插件自己的网页」而不是重写一套 React 面板：可点击、可表格、可表单，
 * 零构建、零框架版本耦合，而且同一个页面既能被内嵌 iframe 用，也能单独开标签兜底。
 *
 * @module dsh-customer-service-plugin/lib/http
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 扩展名 → MIME。 */
export const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
});

/** 请求体上限。 */
const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 计算 MIME。
 * @param {string} file - 文件路径。
 * @returns {string} MIME。
 */
export function mimeOf(file) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * 判断 target 是否落在 root 之内（防目录穿越）。
 * @param {string} root - 根目录（绝对）。
 * @param {string} target - 目标路径（绝对）。
 * @returns {boolean} 是否安全。
 */
export function isInside(root, target) {
  const base = path.resolve(root);
  const resolved = path.resolve(target);
  return resolved === base || resolved.startsWith(base + path.sep);
}

/**
 * 常数时间比较，避免 token 比较被计时侧信道。
 * @param {string} a - 左值。
 * @param {string} b - 右值。
 * @returns {boolean} 是否相等。
 */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  try {
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

/**
 * 生成一次性控制台 token。
 * @returns {string} 十六进制 token。
 */
export function createToken() {
  return crypto.randomBytes(24).toString('hex');
}

/**
 * 发送 JSON。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {unknown} body - 响应体。
 * @param {Record<string,string>} [headers] - 附加响应头。
 * @returns {void}
 */
export function sendJson(res, status, body, headers = {}) {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

/**
 * 发送纯文本。
 * @param {import('node:http').ServerResponse} res - 响应。
 * @param {number} status - 状态码。
 * @param {string} text - 文本。
 * @returns {void}
 */
export function sendText(res, status, text) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(text);
}

/**
 * 读取请求体，带大小上限。
 * @param {import('node:http').IncomingMessage} req - 请求。
 * @returns {Promise<Buffer>} 请求体。
 */
export function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`请求体超过 ${MAX_BODY_BYTES} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 建一个请求处理器。
 * @param {{prefix: string, assetsDir: string, token: string, api: Function, logger?: object}} options - 配置。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} 处理器。
 */
export function createRequestHandler(options) {
  const prefix = normalizePrefix(options.prefix);
  const assetsDir = path.resolve(options.assetsDir);
  const { token, api } = options;
  const logger = options.logger ?? { warn: () => {}, error: () => {} };

  const serveStatic = async (req, res, rest) => {
    let relative = rest === '' || rest === '/' ? '/index.html' : rest;
    if (!path.extname(relative)) relative = '/index.html';
    let decoded;
    try {
      decoded = decodeURIComponent(relative);
    } catch {
      sendText(res, 400, 'bad path');
      return;
    }
    if (decoded.includes('\0')) {
      sendText(res, 400, 'bad path');
      return;
    }
    const target = path.resolve(assetsDir, `.${decoded}`);
    if (!isInside(assetsDir, target)) {
      sendText(res, 403, 'forbidden');
      return;
    }
    let data;
    try {
      data = await fsp.readFile(target);
    } catch {
      sendText(res, 404, 'not found');
      return;
    }
    const mime = mimeOf(target);
    const isHead = req.method === 'HEAD';
    const isEntry = path.basename(target) === 'index.html';
    if (isEntry) {
      const injected = data
        .toString('utf8')
        .replaceAll('__CS_TOKEN__', token)
        .replaceAll('__CS_VERSION__', String(options.version ?? 'dev'))
        .replaceAll('__CS_PREFIX__', prefix);
      const bytes = Buffer.from(injected, 'utf8');
      res.writeHead(200, {
        'content-type': mime,
        'content-length': bytes.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      res.end(isHead ? undefined : bytes);
      return;
    }
    res.writeHead(200, {
      'content-type': mime,
      'content-length': data.length,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(isHead ? undefined : data);
  };

  const serveApi = async (req, res, rest, url) => {
    const method = String(req.method ?? 'GET').toUpperCase();
    const mutating = method !== 'GET' && method !== 'HEAD';
    if (mutating && !safeEqual(req.headers['x-cs-token'], token)) {
      sendJson(res, 403, { ok: false, error: { message: '控制台令牌校验失败，请刷新页面' } });
      return;
    }
    let body = null;
    if (mutating) {
      try {
        const raw = await readBody(req);
        body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : null;
      } catch (cause) {
        sendJson(res, 400, {
          ok: false,
          error: { message: cause instanceof Error ? cause.message : String(cause) },
        });
        return;
      }
    }
    try {
      const result = await api(method, rest, { query: url.searchParams, body, req });
      if (!result) {
        sendJson(res, 404, { ok: false, error: { message: `未知接口 ${method} ${rest}` } });
        return;
      }
      sendJson(res, result.status ?? 200, result.body ?? null, result.headers ?? {});
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      logger.warn(`api ${method} ${rest} failed: ${message}`);
      // 领域错误可以带上可操作的附加信息（例如「允许的下一状态」），供 UI 直接使用。
      const details = {};
      for (const key of ['allowed', 'from', 'to', 'currentRev']) {
        if (cause && typeof cause === 'object' && cause[key] !== undefined) details[key] = cause[key];
      }
      sendJson(res, cause?.status ?? 500, { ok: false, error: { message, ...details } });
    }
  };

  return async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendText(res, 400, 'bad url');
      return;
    }
    const pathname = url.pathname;
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
      sendText(res, 404, 'not found');
      return;
    }
    const rest = pathname.slice(prefix.length);
    if (rest === '/api' || rest.startsWith('/api/')) {
      await serveApi(req, res, rest.slice('/api'.length) || '/', url);
      return;
    }
    await serveStatic(req, res, rest);
  };
}

/**
 * 规范化路由前缀。
 * @param {unknown} value - 原始前缀。
 * @returns {string} 以 `/` 开头、不以 `/` 结尾的前缀。
 */
export function normalizePrefix(value) {
  const raw = typeof value === 'string' && value.trim() ? value.trim() : '/cs';
  const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
  return withSlash.length > 1 && withSlash.endsWith('/') ? withSlash.slice(0, -1) : withSlash;
}

/**
 * 判断资源根是否存在（用于启动自检）。
 * @param {string} dir - 目录。
 * @returns {boolean} 是否存在。
 */
export function assetsExist(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
