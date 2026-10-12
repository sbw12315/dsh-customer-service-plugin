/**
 * 巡逻页的「平台口径」统计 —— 纯函数，零依赖、不碰 DOM，可单独断言。
 *
 * 为什么值得单独一个模块：这里是**两个很容易混的口径**，混了以后界面上的数字看着对、
 * 语义却完全不同。抽出来才能把它们钉在用例里。
 *
 *   1. 单个渠道的 skipped = 「不是这个渠道的店」。它**包含被别的渠道巡逻着的店**：
 *      亚马逊渠道的 skipped 里有 TikTok 的店，但那些店是被 TikTok 渠道巡逻的。
 *   2. 全局「没被任何渠道巡逻的平台」= 全量平台 − 所有启用渠道 items 的平台并集。
 *      实测账号：亚马逊 skipped 涉及 23 个平台，但真正没人巡逻的是 21 个。
 *
 * 界面上一处用 1（每个渠道块内的明细），一处用 2（最上面那条全局摘要），
 * 两者措辞也必须不同：一个说「本渠道不巡逻」，一个说「不会被巡逻」。
 *
 * @module dsh-customer-service-plugin/assets/js/platform-summary
 */

/**
 * 就地按 platformName 聚合一组目标（用于服务端没给聚合结果时兜底）。
 * @param {Array<object>} entries - 带 platformName 的目标。
 * @returns {Array<{platformName: string, stores: number}>} 平台清单（店铺数倒序）。
 */
export function groupByPlatform(entries) {
  const map = new Map();
  for (const entry of entries ?? []) {
    const name = String(entry?.platformName ?? '').trim() || '未知平台';
    map.set(name, (map.get(name) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([platformName, stores]) => ({ platformName, stores }))
    .sort((a, b) => b.stores - a.stores || a.platformName.localeCompare(b.platformName));
}

/**
 * 全局口径：**没有任何已启用渠道会巡逻**的平台，以及这些平台下的店铺数。
 *
 * 同一家店会在多个渠道的 skipped 里各出现一次，所以按 storeId 去重 ——
 * 不去重会把店铺数算成渠道数的倍数。
 * @param {Array<object>} channels - 渠道清单（含 id / label / enabled）。
 * @param {Record<string, object>} scans - 渠道 id → 扫描结果（含 items / skipped）。
 * @returns {{platforms: Array<{platformName: string, stores: number}>, platformCount: number, storeCount: number, covered: string[]}} 结果。
 */
export function unpatrolledPlatforms(channels, scans) {
  const covered = new Set();
  for (const channel of channels ?? []) {
    if (channel.enabled === false) continue;
    for (const source of scans?.[channel.id]?.items ?? []) {
      if (source.platformName) covered.add(source.platformName);
    }
  }
  const byPlatform = new Map();
  const seenStores = new Set();
  for (const channel of channels ?? []) {
    const scan = scans?.[channel.id];
    if (!scan) continue;
    for (const source of [...(scan.items ?? []), ...(scan.skipped ?? [])]) {
      const name = String(source?.platformName ?? '').trim();
      const storeId = String(source?.storeId ?? '').trim();
      if (!name || !storeId || seenStores.has(storeId)) continue;
      seenStores.add(storeId);
      byPlatform.set(name, (byPlatform.get(name) ?? 0) + 1);
    }
  }
  const platforms = [...byPlatform.entries()]
    .filter(([name]) => !covered.has(name))
    .map(([platformName, stores]) => ({ platformName, stores }))
    .sort((a, b) => b.stores - a.stores || a.platformName.localeCompare(b.platformName));
  return {
    platforms,
    platformCount: platforms.length,
    storeCount: platforms.reduce((sum, entry) => sum + entry.stores, 0),
    covered: [...covered].sort(),
  };
}

/**
 * 本账号**一家店都没有**的渠道 —— 巡逻页据此把用不到的平台块收起来。
 *
 * 判据只用两个字段：
 *   - `scan.total`：**全账号**店铺数（适配器的 listAllStores 不过滤平台，各渠道拿到的是同一份）；
 *   - `scan.items`：本渠道认出来的可用目标数（已排除停用店）。
 * 刻意**不看 skipped** —— 那是「别人的店」，跟本渠道有没有店无关。
 * @param {Array<object>} channels - 渠道清单（含 id / label / kind / enabled）。
 * @param {Record<string, object>} scans - 渠道 id → 扫描结果。
 * @returns {Array<{id: string, label: string}>} 可以收起的渠道，顺序同 channels。
 */
export function channelsWithoutStores(channels, scans) {
  const hidden = [];
  for (const channel of channels ?? []) {
    const scan = scans?.[channel.id];
    if (!scan) continue;
    if ((channel.kind ?? 'store') !== 'store') continue;
    if (channel.enabled === false) continue;
    if (scan.error || scan.disabled) continue;
    if (!(Number(scan.total) > 0)) continue;
    if ((scan.items ?? []).length > 0) continue;
    if ((scan.retired ?? []).length > 0) continue;
    hidden.push({ id: channel.id, label: channel.label });
  }
  return hidden;
}
