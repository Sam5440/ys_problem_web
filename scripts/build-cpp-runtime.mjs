#!/usr/bin/env node
/**
 * 重建浏览器端 C++ 运行时到 public/compiler/（gitignored，属数据分支投影）。
 *
 * 产出（与 cppstudio-io/wasm-clang-runtime v0.1.0 二进制同名同源，另加重建件）：
 *   clang22 / clang22-noeh / lld22 / lld22-noeh  — 上游 release 原件（需 --upstream-dir）
 *   sysroot22.tar                                — 本地从 wasi-sdk 33 重建：
 *                                                  真身 <iostream>（上游是教学桩）
 *                                                  + 合成 bits/stdc++.h
 *   memfs                                        — 从上游 memfs.c 源码用 wasi-sdk 编译
 *                                                  （8192 节点；上游 release 未附此件）
 *   manifest.json                                — 构建指纹
 *
 * 用法（本机维护任务，CI 不跑）：
 *   node scripts/build-cpp-runtime.mjs \
 *     --upstream-dir /tmp/clang22-dl \
 *     --wasi-sdk /tmp/wasi33/sdk/wasi-sdk-33.0-arm64-macos \
 *     --sysroot /tmp/wasi33/sysroot-ext/wasi-sysroot-33.0+m \
 *     --clangrt /tmp/wasi33/sdk/libclang_rt-33.0+m/wasm32-unknown-wasip1/libclang_rt.builtins.a \
 *     --memfs-src scripts/assets/memfs.c --stb-src scripts/assets/stb_sprintf.h
 *
 * 重建后发布：node scripts/push-runtime-branch.mjs（推 data/runtime 分支）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildManifest, buildBitsStdcxx, listCHeaders, listTopLevelCppHeaders, packTar, planSysrootEntries } from './lib/sysroot-pack.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(ROOT, '..', 'public', 'compiler');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (m) args[m[1]] = m[2] ?? argv[++i];
  }
  return args;
}

// 个别头在 wasi freestanding 下不可用或无意义，排除出万能头（保留独立可包含）。
const BITS_BLOCKLIST = new Set([
  'csetjmp', // setjmp.h：wasm 需 EH/sjlj 提案，freestanding 下直接 #error
  'csignal', // 信号：需 -D_WASI_EMULATED_SIGNAL + 链接 wasi-emulated-signal（sysroot 未含）
  'execution', // C++26 执行器，libc++ 尚不完整
  'hazard_pointer', // experimental
  'stdfloat', // 需要额外的浮点类型支持
]);

function main() {
  const args = parseArgs(process.argv);
  const upstream = args['upstream-dir'];
  const wasiSdk = args['wasi-sdk'];
  const sysrootDir = args.sysroot;
  const clangrt = args.clangrt;
  const memfsSrc = args['memfs-src'] ?? path.join(ROOT, 'assets', 'memfs.c');
  const stbSrc = args['stb-src'] ?? path.join(ROOT, 'assets', 'stb_sprintf.h');

  for (const [k, v] of Object.entries({ upstream, wasiSdk, sysrootDir, clangrt })) {
    if (!v || !fs.existsSync(v)) {
      console.error(`缺少 --${k}（不存在: ${v ?? '<未传>'}）；用法见脚本头部注释`);
      process.exit(1);
    }
  }

  fs.mkdirSync(OUT, { recursive: true });

  // 1) 上游 clang/lld 二进制原件直拷
  for (const f of ['clang22', 'clang22-noeh', 'lld22', 'lld22-noeh']) {
    fs.copyFileSync(path.join(upstream, f), path.join(OUT, f));
    console.log(`copied ${f}`);
  }

  // 2) 重建 sysroot22.tar（真 iostream + bits/stdc++.h）
  const cppV1 = path.join(sysrootDir, 'include', 'wasm32-wasip1', 'noeh', 'c++', 'v1');
  const bitsHeader = buildBitsStdcxx(
    listTopLevelCppHeaders(cppV1),
    listCHeaders(cppV1),
    [...BITS_BLOCKLIST],
  );
  const entries = planSysrootEntries({
    sysrootDir,
    clangIncludeDir: path.join(wasiSdk, 'lib', 'clang', '22', 'include'),
    clangrtFile: clangrt,
    bitsHeader,
  });
  const tarBuf = packTar(entries);
  fs.writeFileSync(path.join(OUT, 'sysroot22.tar'), tarBuf);
  console.log(`packed sysroot22.tar: ${(tarBuf.length / 1e6).toFixed(1)} MB, ${entries.length} entries`);
  console.log(`bits/stdc++.h: ${bitsHeader.split('\n').length} 行（已注入 tar）`);

  // 3) 从源码编译 memfs（8192 节点版，上游 release 未附二进制）
  const clang = path.join(wasiSdk, 'bin', 'clang');
  const wasmLd = path.join(wasiSdk, 'bin', 'wasm-ld');
  const tmp = fs.mkdtempSync(path.join(OUT, '.build-'));
  try {
    execFileSync(clang, ['--target=wasm32-wasip1', '-O2', '-Wall', '-Wno-unused-parameter', '-c', '-o', path.join(tmp, 'memfs.o'), memfsSrc], { stdio: 'inherit' });
    execFileSync(clang, ['--target=wasm32-wasip1', '-DSTB_SPRINTF_IMPLEMENTATION', '-x', 'c', '-O2', '-c', '-o', path.join(tmp, 'stb.o'), stbSrc], { stdio: 'inherit' });
    const memfsOut = path.join(OUT, 'memfs');
    execFileSync(wasmLd, [
      `-L${path.join(sysrootDir, 'lib', 'wasm32-wasip1')}`,
      '--no-entry', '--export-dynamic', '--allow-undefined', '--initial-memory=4194304',
      '-o', memfsOut, path.join(tmp, 'memfs.o'), path.join(tmp, 'stb.o'), '-lc',
    ], { stdio: 'inherit' });
    console.log('built memfs');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // 4) manifest
  const files = fs.readdirSync(OUT).filter((f) => fs.statSync(path.join(OUT, f)).isFile()).map((f) => ({
    name: f,
    size: fs.statSync(path.join(OUT, f)).size,
  }));
  const clangVer = execFileSync(clang, ['--version']).toString().split('\n')[0];
  fs.writeFileSync(
    path.join(OUT, 'manifest.json'),
    JSON.stringify(buildManifest({ clangVersion: clangVer, wasiSdkVersion: '33.0', files }), null, 2) + '\n',
  );
  console.log('done →', OUT);
}

main();
