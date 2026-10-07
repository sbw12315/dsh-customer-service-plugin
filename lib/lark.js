/**
 * 飞书CLI 客户端。
 *
 * 就是一个 `createCliClient('lark', ...)` 的别名 —— 与紫鸟CLI 共用同一份调用封装。
 * 单独成文件是为了让「飞书这条链路」在 import 处一眼可见，而不是散在代码里靠字符串区分。
 *
 * @module dsh-customer-service-plugin/lib/lark
 */

import { createCliClient } from './ziniao.js';

/**
 * 建一个飞书CLI 客户端。
 * @param {object} options - 见 createCliClient（ctx / settings / cwd / env / logger / onResult）。
 * @returns {object} 客户端。
 */
export function createLarkClient(options) {
  return createCliClient('lark', options);
}
