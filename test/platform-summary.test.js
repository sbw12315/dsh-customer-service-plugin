import assert from 'node:assert/strict';
import test from 'node:test';
import {
  channelsWithoutStores,
  groupByPlatform,
  unpatrolledPlatforms,
} from '../assets/js/platform-summary.js';

/** 造一份像真实 /patrol 的 channels + sources。 */
function fixture() {
  const channels = [
    { id: 'amazon', label: '亚马逊', enabled: true },
    { id: 'tiktok', label: 'TikTok Shop', enabled: true },
    { id: 'lark-mail', label: '飞书邮箱', enabled: false },
  ];
  const scans = {
    amazon: {
      items: [{ storeId: 'a1', platformName: '亚马逊-美国' }],
      skipped: [
        { storeId: 't1', platformName: 'TikTok Shop-全球跨境(自运营)(新)' },
        { storeId: 's1', platformName: 'SHEIN-全球' },
        { storeId: 's2', platformName: 'SHEIN-全球' },
      ],
    },
    tiktok: {
      items: [{ storeId: 't1', platformName: 'TikTok Shop-全球跨境(自运营)(新)' }],
      skipped: [
        { storeId: 'a1', platformName: '亚马逊-美国' },
        { storeId: 's1', platformName: 'SHEIN-全球' },
        { storeId: 's2', platformName: 'SHEIN-全球' },
      ],
    },
    'lark-mail': { items: [], skipped: [] },
  };
  return { channels, scans };
}

test('groupByPlatform：按平台聚合，同平台多店只算一行', () => {
  const grouped = groupByPlatform([
    { platformName: 'SHEIN-全球' }, { platformName: 'SHEIN-全球' }, { platformName: 'Temu-中国卖家中心' },
  ]);
  assert.deepEqual(grouped, [
    { platformName: 'SHEIN-全球', stores: 2 },
    { platformName: 'Temu-中国卖家中心', stores: 1 },
  ]);
  assert.deepEqual(groupByPlatform([]), []);
  assert.deepEqual(groupByPlatform(null), []);
  assert.deepEqual(groupByPlatform([{}]), [{ platformName: '未知平台', stores: 1 }]);
});

test('unpatrolledPlatforms：只算「没被任何启用渠道巡逻」的平台', () => {
  const { channels, scans } = fixture();
  const rest = unpatrolledPlatforms(channels, scans);
  // 被巡逻的平台：亚马逊-美国（amazon 渠道）+ TikTok（tiktok 渠道）
  assert.deepEqual(rest.covered, ['TikTok Shop-全球跨境(自运营)(新)', '亚马逊-美国']);
  // SHEIN 谁都不巡逻 → 只剩它；TikTok 虽然出现在 amazon 的 skipped 里，但不算「没人巡逻」
  assert.deepEqual(rest.platforms, [{ platformName: 'SHEIN-全球', stores: 2 }]);
  assert.equal(rest.platformCount, 1);
  assert.equal(rest.storeCount, 2);
});

test('unpatrolledPlatforms：关掉的渠道不算「在巡逻」，它的平台要算进来', () => {
  const { channels, scans } = fixture();
  // 把 amazon 关掉：那亚马逊的平台就变成没人巡逻了。
  const off = channels.map((c) => (c.id === 'amazon' ? { ...c, enabled: false } : c));
  const rest = unpatrolledPlatforms(off, scans);
  assert.deepEqual(rest.covered, ['TikTok Shop-全球跨境(自运营)(新)']);
  assert.ok(rest.platforms.some((p) => p.platformName === '亚马逊-美国'), '关掉的渠道不该算作已覆盖');
  assert.equal(rest.platformCount, 2, '亚马逊 + SHEIN');
});

test('unpatrolledPlatforms：同一家店在多个渠道的 skipped 里出现，只数一次', () => {
  const channels = [{ id: 'a', label: 'A', enabled: true }];
  const scans = {
    a: {
      items: [],
      // 同一家店在两个渠道里各出现一次 —— 不去重会把店数算成渠道数的倍数。
      skipped: [{ storeId: 'x', platformName: 'SHEIN-全球' }],
    },
    b: { items: [], skipped: [{ storeId: 'x', platformName: 'SHEIN-全球' }] },
  };
  const rest = unpatrolledPlatforms([...channels, { id: 'b', label: 'B', enabled: true }], scans);
  assert.equal(rest.storeCount, 1, '同一家店只数一次');
  assert.equal(rest.platformCount, 1);
});

test('unpatrolledPlatforms：空输入安全（没扫过时界面上就是空）', () => {
  assert.deepEqual(unpatrolledPlatforms([], {}), { platforms: [], platformCount: 0, storeCount: 0, covered: [] });
  assert.deepEqual(unpatrolledPlatforms(undefined, undefined).platformCount, 0);
});

test('真实账号口径：亚马逊 skipped 里的平台数 > 真正没人巡逻的平台数', () => {
  // 实测那台账号的缩影：亚马逊渠道的 skipped 里**包含 TikTok 的平台**，
  // 所以「本渠道不巡逻的平台数」（2）比「完全没人巡逻的平台数」（1）大。
  const { channels, scans } = fixture();
  const perChannel = groupByPlatform(scans.amazon.skipped).length;
  const global = unpatrolledPlatforms(channels, scans).platformCount;
  assert.equal(perChannel, 2, 'amazon 的 skipped 涉及 TikTok + SHEIN');
  assert.equal(global, 1, '真正没人巡逻的只有 SHEIN');
  assert.notEqual(perChannel, global, '两个口径必须不同 —— 混用就是这次要修的那个错');
});

/* ── 按紫鸟扫描结果收起「本账号没有店铺」的渠道 ─────────────────────────────── */

/**
 * 造一个「有亚马逊 / TikTok 店，没有沃尔玛 / SHEIN / TEMU 店」的账号。
 * total 是**全账号**店铺数（每个渠道拿到的都是同一份），items 才是本渠道的目标。
 */
function accountFixture() {
  const channels = [
    { id: 'amazon', label: '亚马逊', kind: 'store', enabled: true },
    { id: 'tiktok', label: 'TikTok Shop', kind: 'store', enabled: true },
    { id: 'walmart', label: '沃尔玛', kind: 'store', enabled: true },
    { id: 'shein', label: 'SHEIN', kind: 'store', enabled: true },
    { id: 'temu', label: 'TEMU', kind: 'store', enabled: true },
    { id: 'lark-mail', label: '飞书邮箱', kind: 'mailbox', enabled: true },
  ];
  const scans = {
    amazon: { total: 5, items: [{ storeId: 'a1' }, { storeId: 'a2' }, { storeId: 'a3' }], retired: [] },
    tiktok: { total: 5, items: [{ storeId: 't1' }, { storeId: 't2' }], retired: [] },
    walmart: { total: 5, items: [], retired: [] },
    shein: { total: 5, items: [], retired: [] },
    temu: { total: 5, items: [], retired: [] },
    'lark-mail': { total: 0, items: [{ storeId: 'me@x.com' }], retired: [] },
  };
  return { channels, scans };
}

test('channelsWithoutStores：这个账号没有 TEMU / SHEIN / 沃尔玛店，就收起这三块', () => {
  const { channels, scans } = accountFixture();
  assert.deepEqual(channelsWithoutStores(channels, scans).map((entry) => entry.id), ['walmart', 'shein', 'temu']);
});

test('channelsWithoutStores：有店的渠道与邮箱渠道都不收起', () => {
  const { channels, scans } = accountFixture();
  const hidden = channelsWithoutStores(channels, scans).map((entry) => entry.id);
  assert.equal(hidden.includes('amazon'), false, '有 3 家亚马逊店');
  assert.equal(hidden.includes('tiktok'), false, '有 2 家 TikTok 店');
  assert.equal(hidden.includes('lark-mail'), false, '邮箱没有「店铺」概念，能不能用由邮箱配置决定');
});

test('channelsWithoutStores：扫描失败 / 渠道未启用时不猜，一律不收起', () => {
  const { channels, scans } = accountFixture();
  // 扫描失败：items 空是「没读到」，不是「没有店」——猜错的代价是把能用的渠道藏起来。
  const failed = { ...scans, temu: { total: 5, items: [], retired: [], error: { message: '未登录' } } };
  assert.deepEqual(channelsWithoutStores(channels, failed).map((entry) => entry.id), ['walmart', 'shein']);

  // 渠道被停用：那一块里挂着渠道自己的启停开关，收起就再也打不开。
  const disabled = channels.map((channel) => (channel.id === 'walmart' ? { ...channel, enabled: false } : channel));
  assert.deepEqual(channelsWithoutStores(disabled, scans).map((entry) => entry.id), ['shein', 'temu']);
});

test('channelsWithoutStores：全账号一家店都没扫到就什么都不收起（否则整页会空掉）', () => {
  const { channels } = accountFixture();
  const empty = {};
  for (const channel of channels) empty[channel.id] = { total: 0, items: [], retired: [] };
  assert.deepEqual(channelsWithoutStores(channels, empty), []);
});

test('channelsWithoutStores：0 家可用是因为店都停用了 —— 留着那一栏解释给人看', () => {
  const { channels, scans } = accountFixture();
  const withRetired = { ...scans, temu: { total: 5, items: [], retired: [{ storeId: 't9' }] } };
  assert.equal(channelsWithoutStores(channels, withRetired).some((entry) => entry.id === 'temu'), false);
});

test('channelsWithoutStores：没扫过的渠道不收起，空输入安全', () => {
  const channels = [{ id: 'temu', label: 'TEMU', kind: 'store', enabled: true }];
  assert.deepEqual(channelsWithoutStores(channels, {}), []);
  assert.deepEqual(channelsWithoutStores(channels, { temu: { total: 5, items: [{ storeId: 'x' }] } }), []);
  assert.deepEqual(channelsWithoutStores(null, null), []);
  assert.deepEqual(channelsWithoutStores(undefined, undefined), []);
});
