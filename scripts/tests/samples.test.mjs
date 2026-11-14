/**
 * lib/compiler/samples.js 单测：自定义样例存储（localStorage 注入式）。
 *
 * 钉的不变式：
 * 1. null = 未自定义（回退题目默认样例），存储损坏时安全降级为 null；
 * 2. 整表落盘 / 读取往返一致，非字符串字段规范化、非法条目丢弃；
 * 3. 按题隔离：不同 problemCode 互不干扰；clear 恢复默认语义。
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  sampleKey,
  defaultCasesFrom,
  normalizeSampleCases,
  loadSampleCases,
  saveSampleCases,
  clearSampleCases,
} from "../../lib/compiler/samples.js";

function memStore(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    dump: () => Object.fromEntries(m),
  };
}

test("defaultCasesFrom：题目样例规范化为字符串字段", () => {
  assert.deepEqual(defaultCasesFrom([{ input: "1 2", output: "3" }]), [
    { input: "1 2", output: "3" },
  ]);
  assert.deepEqual(defaultCasesFrom(null), []);
  assert.deepEqual(defaultCasesFrom([]), []);
  // 缺字段 / 非 null 对象安全兜底
  assert.deepEqual(defaultCasesFrom([{}]), [{ input: "", output: "" }]);
  assert.deepEqual(defaultCasesFrom([{ input: 42, output: null }]), [
    { input: "42", output: "" },
  ]);
});

test("save → load 往返一致；未存返回 null", () => {
  const store = memStore();
  assert.equal(loadSampleCases("1900A", store), null);
  const cases = [
    { input: "1 2\n", output: "3\n" },
    { input: "", output: "" },
  ];
  saveSampleCases("1900A", cases, store);
  assert.deepEqual(loadSampleCases("1900A", store), cases);
});

test("normalizeSampleCases：非法输入丢弃 / null", () => {
  assert.equal(normalizeSampleCases(null), null);
  assert.equal(normalizeSampleCases("nope"), null);
  // 非法条目过滤，合法条目保留
  assert.deepEqual(
    normalizeSampleCases([
      { input: "a", output: "b" },
      42,
      null,
      { input: "c" },
    ]),
    [
      { input: "a", output: "b" },
      { input: "c", output: "" },
    ],
  );
});

test("存储损坏（非法 JSON）安全降级为 null", () => {
  const store = memStore({ [sampleKey("1900B")]: "{not json" });
  assert.equal(loadSampleCases("1900B", store), null);
  // 存了非数组 JSON 同样降级
  const store2 = memStore({ [sampleKey("1900B")]: '"hello"' });
  assert.equal(loadSampleCases("1900B", store2), null);
});

test("clearSampleCases：清除后回到 null（未自定义）", () => {
  const store = memStore();
  saveSampleCases("1900C", [{ input: "x", output: "y" }], store);
  assert.notEqual(loadSampleCases("1900C", store), null);
  clearSampleCases("1900C", store);
  assert.equal(loadSampleCases("1900C", store), null);
});

test("按题隔离：不同 problemCode 互不干扰", () => {
  const store = memStore();
  saveSampleCases("1900A", [{ input: "a", output: "1" }], store);
  saveSampleCases("1900B", [{ input: "b", output: "2" }], store);
  assert.deepEqual(loadSampleCases("1900A", store), [{ input: "a", output: "1" }]);
  assert.deepEqual(loadSampleCases("1900B", store), [{ input: "b", output: "2" }]);
  clearSampleCases("1900A", store);
  assert.notEqual(loadSampleCases("1900B", store), null);
});

test("无 storage（node 环境）安全降级不抛错", () => {
  assert.equal(loadSampleCases("1900A", null), null);
  assert.doesNotThrow(() => saveSampleCases("1900A", [], null));
  assert.doesNotThrow(() => clearSampleCases("1900A", null));
});

test("saveSampleCases 落盘内容经 normalize（非法条目不进存储）", () => {
  const store = memStore();
  saveSampleCases("1900D", [{ input: "ok", output: "ok" }, "bad"], store);
  assert.deepEqual(loadSampleCases("1900D", store), [
    { input: "ok", output: "ok" },
  ]);
});
