/**
 * 控制台接口封装：统一带 CSRF 令牌、统一解信封、统一把错误变成可 catch 的 Error。
 *
 * 相对地址写成 `api/...`，配合 index.html 里的 <base>，所以插件挂在任何前缀下都不用改。
 */

/** 控制台令牌（由服务端注入到 meta）。 */
export const TOKEN = document.querySelector('meta[name="cs-token"]')?.content ?? '';

/**
 * 解一个响应。
 * @param {Response} res - fetch 响应。
 * @returns {Promise<any>} `data` 字段。
 */
async function unwrap(res) {
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  if (!res.ok || payload?.ok === false) {
    const error = new Error(payload?.error?.message ?? `HTTP ${res.status}`);
    error.status = res.status;
    error.details = payload?.error ?? {};
    throw error;
  }
  return payload?.data;
}

/**
 * 发起一次接口调用。
 * @param {string} method - HTTP 方法。
 * @param {string} path - 形如 `/queue`。
 * @param {object} [options] - `{body, query}`。
 * @returns {Promise<any>} `data`。
 */
export async function call(method, path, options = {}) {
  const search = options.query ? `?${options.query.toString()}` : '';
  const headers = { 'x-cs-token': TOKEN };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`api${path}${search}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return unwrap(res);
}

/** GET。 */
export const get = (path, query) => call('GET', path, { query });
/** POST。 */
export const post = (path, body) => call('POST', path, { body: body ?? {} });
/** PATCH。 */
export const patch = (path, body) => call('PATCH', path, { body: body ?? {} });
/** DELETE。 */
export const del = (path) => call('DELETE', path, {});

/**
 * 把筛选对象变成查询串。
 * @param {Record<string, unknown>} filters - 筛选条件（空值自动跳过）。
 * @returns {URLSearchParams} 查询串。
 */
export function toQuery(filters) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters ?? {})) {
    if (value === null || value === undefined || value === '' || value === 'all') continue;
    query.set(key, String(value));
  }
  return query;
}
