/**
 * 极小日志器。插件在任意 DSH 实例里都可能被加载，所以不依赖任何宿主日志服务，
 * 只用 console；DEBUG 由环境变量 DSH_CS_DEBUG 打开。
 *
 * @module dsh-customer-service-plugin/lib/log
 */

const DEBUG = (() => {
  const value = process.env.DSH_CS_DEBUG;
  return value === '1' || value === 'true' || value === 'yes';
})();

/**
 * 建立带前缀的日志器。
 * @param {string} tag - 前缀，通常是 `customer-service`。
 * @returns {{info: Function, warn: Function, error: Function, debug: Function}} 日志器。
 */
export function createLogger(tag) {
  const prefix = `[${tag}]`;
  const emit = (sink, args) => {
    try {
      sink(prefix, ...args);
    } catch {
      // 日志永远不允许拖垮插件。
    }
  };
  return {
    info: (...args) => emit(console.log, args),
    warn: (...args) => emit(console.warn, args),
    error: (...args) => emit(console.error, args),
    debug: (...args) => {
      if (DEBUG) emit(console.log, ['debug', ...args]);
    },
  };
}
