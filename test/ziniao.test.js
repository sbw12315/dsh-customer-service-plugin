import assert from 'node:assert/strict';
import test from 'node:test';
import { RETIRED_STORE_RE, isRetiredStore, normalizeStoreList } from '../lib/ziniao.js';

/* ── 停用判定 ─────────────────────────────────────────────────────────────
 * 为什么按店名判：紫鸟 store list 每一条只有 storeId / storeName / platformName / ip
 * （2026-10-10 实测，没有状态字段）。实机里运营就是用店名标注停用的。 */

test('isRetiredStore：认实机那几家停用店', () => {
  const retired = [
    { storeId: '27151809366886', storeName: 'Walmart-Yanosaku-已停用', platformName: '沃尔玛-全球' },
    { storeId: '27696869981242', storeName: 'Cdiscount-停用', platformName: 'CD平台-全球' },
    { storeId: '27453122074819', storeName: '敦煌网-停用-管理员', platformName: '敦煌网-中国' },
    { storeId: '27296475718339', storeName: 'Temu-JDDX停用-管理员', platformName: 'Temu-中国卖家中心' },
  ];
  for (const store of retired) assert.equal(isRetiredStore(store), true, store.storeName);
});

test('isRetiredStore：也认英文写法，看店名与平台名两处', () => {
  assert.equal(isRetiredStore({ storeName: 'Amazon-FUSOU-disabled' }), true);
  assert.equal(isRetiredStore({ storeName: 'X-retired' }), true);
  assert.equal(isRetiredStore({ storeName: 'X', platformName: '沃尔玛-已停用' }), true);
  assert.equal(RETIRED_STORE_RE.test('作废'), true);
});

test('isRetiredStore：**不**把「还没启用 / 正在注册」当成停用', () => {
  // 这两种是「还没开始用」，与「已经停用」要人做的事完全不同：前者等着接入，后者不该再碰。
  assert.equal(isRetiredStore({ storeName: '注册中尚未启用-Allegro', platformName: 'allegro-欧洲' }), false);
  assert.equal(isRetiredStore({ storeName: 'Walmart-Cozynome-管理员' }), false);
  assert.equal(isRetiredStore({}), false);
  assert.equal(isRetiredStore(null), false);
});

/* ── 规范化：停用标记在这里算一次，所有消费者共用 ───────────────────────── */

test('normalizeStoreList：规范化时就把 retired 算好', () => {
  const list = normalizeStoreList({
    items: [
      { storeId: 'a', storeName: 'Walmart-Cozynome-管理员', platformName: '沃尔玛-全球', ip: '1.1.1.1' },
      { storeId: 'b', storeName: 'Walmart-Yanosaku-已停用', platformName: '沃尔玛-全球', ip: '1.1.1.1' },
    ],
  });
  assert.equal(list.length, 2);
  assert.equal(list[0].retired, false);
  assert.equal(list[1].retired, true);
  assert.deepEqual(Object.keys(list[0]).sort(), ['ip', 'platformName', 'retired', 'storeId', 'storeName']);
});

test('normalizeStoreList：兼容 items / list / stores 三种键，并按 storeId 去重', () => {
  const rows = [{ storeId: 'a', storeName: 'A' }, { storeId: 'a', storeName: 'A 重复' }];
  assert.equal(normalizeStoreList({ items: rows }).length, 1);
  assert.equal(normalizeStoreList({ list: rows }).length, 1);
  assert.equal(normalizeStoreList({ stores: rows }).length, 1);
  assert.equal(normalizeStoreList(rows).length, 1, '裸数组也要认');
  assert.deepEqual(normalizeStoreList(null), []);
  assert.deepEqual(normalizeStoreList({ items: [null, 'x', { storeName: '没有 id' }] }), [], '没有 storeId 的条目丢掉');
});

test('normalizeStoreList：兼容下划线字段名（上游不同版本）', () => {
  const list = normalizeStoreList({ items: [{ store_id: 'x1', store_name: 'X', platform_name: '沃尔玛-全球' }] });
  assert.equal(list[0].storeId, 'x1');
  assert.equal(list[0].storeName, 'X');
  assert.equal(list[0].platformName, '沃尔玛-全球');
  assert.equal(list[0].retired, false);
});
