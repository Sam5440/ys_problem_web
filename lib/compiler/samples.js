/**
 * 样例测试的自定义样例存储（localStorage，纯模块：window 缺失时安全降级，
 * 供 node --test 注入 storage 单测）。
 *
 * 键位：ysc-cp-samples-<problemCode> → JSON [{input, output}]
 * 无记录（null）= 未自定义，运行用题目默认样例；一旦编辑/新增/删除即把
 * 当前完整样例列表（含未改动的默认样例）落盘，与草稿键位互不干扰。
 */

function storage() {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function sampleKey(problemCode) {
  return `ysc-cp-samples-${problemCode}`;
}

/** 从题目默认样例初始化可编辑列表（字段规范化为字符串）。 */
export function defaultCasesFrom(examples) {
  return (examples ?? []).map((e) => ({
    input: String(e?.input ?? ""),
    output: String(e?.output ?? ""),
  }));
}

/** 校验/规范化存储的样例列表：非法条目丢弃，返回 null 表示不可用。 */
export function normalizeSampleCases(cases) {
  if (!Array.isArray(cases)) return null;
  const list = cases
    .map((c) =>
      c && typeof c === "object"
        ? { input: String(c.input ?? ""), output: String(c.output ?? "") }
        : null,
    )
    .filter(Boolean);
  return list;
}

/** 读取某题的自定义样例；未自定义/损坏返回 null（调用方回退题目默认）。 */
export function loadSampleCases(problemCode, store = storage()) {
  try {
    const raw = store?.getItem(sampleKey(problemCode));
    if (!raw) return null;
    return normalizeSampleCases(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 保存自定义样例列表（整表落盘）。 */
export function saveSampleCases(problemCode, cases, store = storage()) {
  try {
    store?.setItem(
      sampleKey(problemCode),
      JSON.stringify(normalizeSampleCases(cases) ?? []),
    );
  } catch {}
}

/** 恢复题目默认样例（清除自定义记录）。 */
export function clearSampleCases(problemCode, store = storage()) {
  try {
    store?.removeItem(sampleKey(problemCode));
  } catch {}
}
