/**
 * sysroot 打包纯函数（node 专用，供 build-cpp-runtime.mjs 与单元测试共享）。
 *
 * 重建 cppstudio wasm-clang-runtime 的 sysroot22.tar，两处关键差异：
 *   1. 保留真身 <iostream>（上游为教学场景打了桩，cin >> string / getline
 *      都不可用，刷题场景必须真身）；
 *   2. 注入合成的 bits/stdc++.h（libc++ 不带这个 GCC 惯用万能头）。
 *
 * tar 写 GNU ustar 格式（magic "ustar  \\0"），与浏览器侧 shared.js 的
 * JS Tar 解析器兼容：只产 '0'（文件）与 '5'（目录）两类 entry，路径 <100 字节。
 */

import fs from 'node:fs';
import path from 'node:path';

const USTAR_BLOCK = 512;

/** extension-less 顶级 C++ 头（libc++ v1 目录下的 <algorithm> 这类），排除 __ 内部头。 */
export function listTopLevelCppHeaders(cppV1Dir) {
  return fs
    .readdirSync(cppV1Dir, { withFileTypes: true })
    .filter((d) => d.isFile() && !d.name.startsWith('__') && !d.name.includes('.'))
    .map((d) => d.name)
    .sort();
}

/** libc++ 下可用的 <c*> 系列 C 头（cstddef 等）。 */
export function listCHeaders(cppV1Dir) {
  return fs
    .readdirSync(cppV1Dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.startsWith('c') && d.name.endsWith('.h') && d.name !== 'assert.h')
    .map((d) => d.name)
    .sort();
}

/**
 * 生成 bits/stdc++.h 内容。
 * @param {string[]} cppHeaders extension-less C++ 头名（如 ['algorithm','vector']）
 * @param {string[]} cHeaders    C 头名（如 ['cstdio','cstdint']）
 * @param {string[]} blocklist   排除的头（个别头在 freestanding/wasi 下不可用）
 */
export function buildBitsStdcxx(cppHeaders, cHeaders, blocklist = []) {
  const skip = new Set(blocklist);
  const cpp = cppHeaders.filter((h) => !skip.has(h));
  const c = cHeaders.filter((h) => !skip.has(h));
  const lines = [
    '// bits/stdc++.h — 万能头（本站合成；libc++ 本不提供此 GCC 惯用头）',
    '// 覆盖 libc++ 全部标准 C++ 头与 <c*> C 头。libstdc++ 专属扩展',
    '// （pb_ds / __gnu_cxx / <ext/...>）不受支持。',
    '#ifndef _GLIBCXX_INCLUDE_ALL',
    '#define _GLIBCXX_INCLUDE_ALL',
    '',
  ];
  for (const h of c) lines.push(`#include <${h}>`);
  lines.push('');
  for (const h of cpp) lines.push(`#include <${h}>`);
  lines.push('', '#endif');
  return lines.join('\n') + '\n';
}

/** --- GNU ustar 写入（仅 '0' 文件与 '5' 目录） --- */

function octal(value, len) {
  const s = value.toString(8);
  if (s.length > len) throw new Error(`octal overflow: ${value}`);
  return s.padStart(len, '0');
}

function writeStringField(block, offset, str, len) {
  const bytes = Buffer.from(str, 'utf8');
  if (bytes.length > len) throw new Error(`tar 字段超长（${bytes.length} > ${len}）: ${str}`);
  block.write(bytes.toString('binary'), offset, len, 'binary');
}

/** @param {{path:string, data?:Uint8Array, dir?:boolean}} entry */
export function ustarEntryBlock(entry) {
  if (Buffer.byteLength(entry.path, 'utf8') >= 100) {
    throw new Error(`路径超过 ustar 100 字节限制: ${entry.path}`);
  }
  const block = Buffer.alloc(USTAR_BLOCK, 0);
  writeStringField(block, 0, entry.path, 100);
  block.write(octal(entry.dir ? 0o755 : 0o644, 7), 100, 7, 'binary');
  block.write(octal(0, 7), 108, 7, 'binary'); // uid
  block.write(octal(0, 7), 116, 7, 'binary'); // gid
  const size = entry.dir ? 0 : entry.data.length;
  block.write(octal(size, 11), 124, 11, 'binary');
  block.write(octal(Math.floor(Date.now() / 1000), 11), 136, 11, 'binary'); // mtime
  block.write('        ', 148, 8, 'binary'); // checksum 占位（空格）
  block.write(entry.dir ? '5' : '0', 156, 1, 'binary'); // typeflag：目录/普通文件
  writeStringField(block, 257, 'ustar  ', 8); // GNU magic（浏览器解析器只认这个）
  // checksum：头 500 字节按无符号字节求和
  let sum = 0;
  for (let i = 0; i < 500; i++) sum += block[i];
  block.write(octal(sum, 6) + '\0 ', 148, 8, 'binary');
  return block;
}

/** 把 entry 列表打包成完整 tar 字节（目录 entry 无数据块；文件按 512 对齐补零）。 */
export function packTar(entries) {
  const chunks = [];
  for (const entry of entries) {
    chunks.push(ustarEntryBlock(entry));
    if (!entry.dir) {
      const { data } = entry;
      chunks.push(data);
      const pad = (USTAR_BLOCK - (data.length % USTAR_BLOCK)) % USTAR_BLOCK;
      if (pad) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  chunks.push(Buffer.alloc(USTAR_BLOCK * 2, 0)); // 结束两个零块
  return Buffer.concat(chunks);
}

/**
 * 规划 sysroot tar 的全部 entry（文件/目录，顺序保证父目录先于子文件）。
 * @param {object} opts
 * @param {string} opts.sysrootDir     wasi-sysroot 根（含 include/ lib/）
 * @param {string} opts.clangIncludeDir wasi-sdk lib/clang/22/include
 * @param {string} opts.clangrtFile    libclang_rt.builtins.a 路径
 * @param {string} opts.bitsHeader     bits/stdc++.h 文本内容
 * @param {number} opts.maxEntries     memfs 节点预算（默认 8000，memfs 上限 8192）
 */
export function planSysrootEntries({ sysrootDir, clangIncludeDir, clangrtFile, bitsHeader, maxEntries = 8000 }) {
  const entries = [];
  const dirs = new Set();

  const addDir = (p) => {
    const parts = p.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!dirs.has(dir)) {
        dirs.add(dir);
        entries.push({ path: dir, dir: true });
      }
    }
  };
  const addFile = (p, data) => {
    addDir(path.posix.dirname(p));
    entries.push({ path: p, data });
  };
  const addTree = (srcBase, arcPrefix, { skipTopDirs = [] } = {}) => {
    let n = 0;
    const walk = (rel) => {
      const abs = path.join(srcBase, rel);
      for (const d of fs.readdirSync(abs, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (rel === '' && skipTopDirs.includes(d.name)) continue;
        const relChild = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) walk(relChild);
        else addFile(`${arcPrefix}/${relChild}`, new Uint8Array(fs.readFileSync(path.join(abs, d.name))));
        n++;
      }
    };
    walk('');
    return n;
  };

  // C 头：include/wasm32-wasip1/**（顶层排除 eh/noeh multilib 目录）
  const cBase = path.join(sysrootDir, 'include', 'wasm32-wasip1');
  addTree(cBase, 'include/wasm32-wasip1', { skipTopDirs: ['eh', 'noeh'] });

  // libc++ noeh 头（真身，含真实 <iostream>）
  const cppBase = path.join(sysrootDir, 'include', 'wasm32-wasip1', 'noeh', 'c++', 'v1');
  addTree(cppBase, 'include/wasm32-wasip1/noeh/c++/v1');

  // 合成万能头（放在 c++ 搜索路径下，#include <bits/stdc++.h> 命中）
  addFile('include/wasm32-wasip1/noeh/c++/v1/bits/stdc++.h', new Uint8Array(Buffer.from(bitsHeader, 'utf8')));

  // clang 内建头
  addTree(clangIncludeDir, 'lib/clang/22/include');

  // 链接库
  const libBase = path.join(sysrootDir, 'lib', 'wasm32-wasip1');
  for (const f of ['crt1.o', 'libc.a', 'libm.a']) {
    addFile(`lib/wasm32-wasip1/${f}`, new Uint8Array(fs.readFileSync(path.join(libBase, f))));
  }
  for (const f of ['libc++.a', 'libc++abi.a']) {
    addFile(`lib/wasm32-wasip1/${f}`, new Uint8Array(fs.readFileSync(path.join(libBase, 'noeh', f))));
  }
  addFile('lib/wasm32-wasip1/libclang_rt.builtins.a', new Uint8Array(fs.readFileSync(clangrtFile)));

  if (entries.length > maxEntries) {
    throw new Error(`sysroot entry 数 ${entries.length} 超过 memfs 预算 ${maxEntries}`);
  }
  return entries;
}

/**
 * 生成 public/compiler/manifest.json 的内容（构建产物指纹，浏览器侧展示/校验用）。
 */
export function buildManifest({ clangVersion, wasiSdkVersion, files }) {
  return {
    generator: 'scripts/build-cpp-runtime.mjs',
    clangVersion,
    wasiSdkVersion,
    builtAt: new Date().toISOString(),
    files,
  };
}
