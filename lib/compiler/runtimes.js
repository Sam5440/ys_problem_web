/**
 * 浏览器端编译器运行时清单（node 与浏览器通用，禁止 import 浏览器 API）。
 *
 * - Python：Pyodide（CPython 官方 WebAssembly 构建）。默认选最新的 314 线
 *   （Python 3.14.2），保留 0.29 线（Python 3.13）作为可切换版本。
 *   文件经 jsDelivr 分发（CORS 开放，主线程/Worker 内 fetch 均可用）。
 * - C++：cppstudio-io/wasm-clang-runtime v0.1.0 的 LLVM 22.1.8（wasi-sdk 33）
 *   浏览器构建，含完整 libc++（noeh）头文件与链接库。二进制经本仓库
 *   `data/runtime` 数据分支自托管到 deploy 的 `/compiler/`（同源，无 CORS 限制），
 *   由 scripts/build-cpp-runtime.mjs 从上游 release + wasi-sdk 33 重建
 *   （真身 iostream 而非教学桩 + 合成 bits/stdc++.h + 8192 节点 memfs）。
 *
 * 占位条目（PLACEHOLDERS）：用户要求「找不到更新的 WASM 实现就把位置留空」，
 * 这里登记已考察过、暂不可用的候选，设置页展示为「观望中」而不是悄悄消失。
 */

export const PYODIDE_VERSIONS = [
  {
    id: '314.0.7',
    label: 'Python 3.14.2 · Pyodide 314.0.7',
    indexURL: 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/',
    files: ['pyodide.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'],
  },
  {
    id: '0.29.3',
    label: 'Python 3.13 · Pyodide 0.29.3',
    indexURL: 'https://cdn.jsdelivr.net/pyodide/v0.29.3/full/',
    files: ['pyodide.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'],
  },
];

// C++ 运行时文件（同源自托管 /compiler/<name>；名字与上游 release 一致，
// 便于将来加 CDN 镜像源）。size 为上游 release 的精确字节数（memfs 除外）。
export const CPP_FILES = [
  { name: 'clang22', size: 36037953 },
  { name: 'clang22-noeh', size: 36100574 },
  { name: 'lld22', size: 19142147 },
  { name: 'lld22-noeh', size: 19183252 },
  { name: 'sysroot22.tar', size: 39876608 },
  { name: 'memfs', size: null },
];

export const CPP_VERSION = {
  id: 'clang-22.1.8',
  label: 'C++ · Clang/LLVM 22.1.8（wasi-sdk 33）',
  stds: ['c++17', 'c++20', 'c++23'],
};

/** 每个文件可尝试的来源列表（按序回退）。clang 系列仅同源（部署时由 data/runtime 分支注入）。 */
export function fileSources(lang, name) {
  if (lang === 'python') {
    return null; // python 的来源由所选 Pyodide 版本的 indexURL 决定
  }
  return [`/compiler/${name}`];
}

/** 已考察但暂不可用的更新版运行时（设置页「观望中」占位）。 */
export const PLACEHOLDERS = [
  {
    id: 'cpp-clang-23',
    lang: 'cpp',
    label: 'Clang 23（dzmauchy/clang-wasm，2026-10 更新）',
    note: '该发行版面向 wasm32-unknown-unknown freestanding，无 libc/libc++ 与 main 入口，不适合刷题；待其提供完整 sysroot 后接入。',
  },
  {
    id: 'cpp-cheerpx',
    lang: 'cpp',
    label: 'CheerpX（x86 模拟跑真 g++）',
    note: '完整 Linux g++，但需数百 MB 镜像且授权限制，暂不接入。',
  },
];

export function pythonVersion(id) {
  return PYODIDE_VERSIONS.find((v) => v.id === id) ?? PYODIDE_VERSIONS[0];
}

export function pyFileURL(version, name) {
  return `${version.indexURL}${name}`;
}
