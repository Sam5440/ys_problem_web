/**
 * 编译器偏好与草稿存储（localStorage）。纯模块：window 缺失时安全降级，
 * 供 node --test 直接单测（传入注入的 storage）。
 *
 * 键位规划（与现有 stmt-* 翻译设置互不干扰）：
 *   ysc-cp-settings-v1            偏好 + 模板
 *   ysc-cp-draft-<problemCode>-<lang>   每题每语言草稿
 */

export const CP_SETTINGS_KEY = 'ysc-cp-settings-v1';

export const DEFAULT_CPP_TEMPLATE = `#include <bits/stdc++.h>
using namespace std;

using ll = long long;

int main() {
    ios::sync_with_stdio(false);
    cin.tie(nullptr);

    return 0;
}
`;

export const DEFAULT_PY_TEMPLATE = `import sys

def main():
    pass

if __name__ == "__main__":
    main()
`;

export const CP_DEFAULTS = Object.freeze({
  defaultLang: 'cpp', // 'cpp' | 'python'
  cppStd: 'c++20', // 'c++17' | 'c++20' | 'c++23'
  pythonVersion: '314.0.7',
  timeoutSec: 10,
  panelOpen: true,
  defaultMode: 'samples', // 'samples' | 'interactive'
  // 面板宽度 / 结果区高度（px），null = 跟随 CSS 默认（clamp / 三等分），
  // 由面板上的拖拽手柄写入，双击手柄复位为 null
  panelWidth: null,
  consoleH: null,
  templates: { cpp: DEFAULT_CPP_TEMPLATE, python: DEFAULT_PY_TEMPLATE },
});

function storage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadCpSettings(store = storage()) {
  try {
    const raw = store?.getItem(CP_SETTINGS_KEY);
    if (!raw) return { ...CP_DEFAULTS, templates: { ...CP_DEFAULTS.templates } };
    const v = JSON.parse(raw);
    return {
      ...CP_DEFAULTS,
      ...v,
      templates: { ...CP_DEFAULTS.templates, ...(v.templates || {}) },
    };
  } catch {
    return { ...CP_DEFAULTS, templates: { ...CP_DEFAULTS.templates } };
  }
}

export function saveCpSettings(patch, store = storage()) {
  const prev = loadCpSettings(store);
  const next = {
    ...prev,
    ...patch,
    templates: { ...prev.templates, ...(patch.templates || {}) },
  };
  try {
    store?.setItem(CP_SETTINGS_KEY, JSON.stringify(next));
  } catch {}
  return next;
}

export function draftKey(problemCode, lang) {
  return `ysc-cp-draft-${problemCode}-${lang}`;
}

export function loadDraft(problemCode, lang, store = storage()) {
  try {
    return store?.getItem(draftKey(problemCode, lang));
  } catch {
    return null;
  }
}

export function saveDraft(problemCode, lang, code, store = storage()) {
  try {
    store?.setItem(draftKey(problemCode, lang), code);
  } catch {}
}

export function clearDraft(problemCode, lang, store = storage()) {
  try {
    store?.removeItem(draftKey(problemCode, lang));
  } catch {}
}
