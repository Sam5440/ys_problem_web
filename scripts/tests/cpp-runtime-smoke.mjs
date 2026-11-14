#!/usr/bin/env node
/**
 * C++ 浏览器运行时 Node 冒烟测试（不经浏览器，直接驱动 shared.js 栈）。
 *
 * 前置：public/compiler/ 已由 scripts/build-cpp-runtime.mjs 产出。
 * 用法：node scripts/tests/cpp-runtime-smoke.mjs [--clang clang22|clang22-noeh]
 *
 * 验证链路：memfs 启动 → sysroot 解包 → clang 编译（含 bits/stdc++.h 万能头、
 * 真身 iostream 的 cin >> string / getline）→ lld 链接 → WASI 运行 + stdin 喂入
 * → stdout 校验；另验证编译错误能产出诊断。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'public', 'compiler');

const args = process.argv.slice(2);
const clangBin = args.includes('--noeh') ? 'clang22-noeh' : 'clang22';
const lldBin = args.includes('--noeh') ? 'lld22-noeh' : 'lld22';

function readBuffer(name) {
  return fs.readFileSync(path.join(BIN, name)).buffer;
}
const compileStreaming = async (name) => WebAssembly.compile(readBuffer(name));

let logText = '';
const hostWrite = (s) => {
  logText += s;
};

const sharedSrc = fs.readFileSync(path.join(ROOT, 'public', 'compiler-js', 'shared.js'), 'utf8');
const { API } = new Function(`${sharedSrc}\n;return { API };`)();

const api = new API({
  readBuffer,
  compileStreaming,
  hostWrite,
  showTiming: true,
  clang: clangBin,
  lld: lldBin,
  sysroot: 'sysroot22.tar',
  memfs: 'memfs',
  clangResourceInclude: '/lib/clang/22/include',
  clangExtraArgs: [
    '-internal-isystem', '/include/wasm32-wasip1/noeh/c++/v1',
    '-internal-isystem', '/include/wasm32-wasip1',
  ],
  lldFlags: ['--export-dynamic'],
  lldLibdir: 'lib/wasm32-wasip1',
  lldLibs: ['-lc', '-lc++', '-lc++abi', '-lclang_rt.builtins'],
});

const ANSI = /\x1b\[[0-9;]*m/g;

function logSlice(from) {
  return logText.slice(from).replace(ANSI, '');
}

let failed = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ` ${extra}`}`);
  if (!cond) failed++;
}

async function compileLinkRun(source, stdin, { input = 'main.cc' } = {}) {
  logText = '';
  const start = 0;
  let compileFailed = false;
  try {
    await api.compile({ input, contents: source, obj: `${input}.o` });
  } catch (exn) {
    if (typeof exn.code !== 'number') throw exn;
    // clang 非零退出（诊断已写日志）——对齐浏览器侧 CompileError 语义
    return { stdout: '', exitCode: exn.code, trap: null, compileFailed: true, log: logSlice(start) };
  }
  await api.link(`${input}.o`, `${input}.wasm`);
  api.memfs.setStdinStr(stdin ?? '');
  const mod = await WebAssembly.compile(api.memfs.getFileContents(`${input}.wasm`));
  let exitCode = 0;
  let trap = null;
  try {
    await api.run(mod, `${input}.wasm`);
  } catch (exn) {
    if (typeof exn.code === 'number') exitCode = exn.code;
    else trap = exn.message ?? String(exn);
  }
  // 程序 stdout = 切片去掉命令回显行、计时行与错误尾块
  let stdout = logSlice(start);
  stdout = stdout.replace(/^> [^\n]*\.wasm\n/, '');
  stdout = stdout.replace(/\n?\([^()\n]*s\/[^()\n]*s\)\n?$/, '');
  stdout = stdout.replace(/\n?Error: process exited with code \d+\.\n?$/, '');
  if (trap !== null) stdout = stdout.replace(/\n?Error: [^\n]*(\n\s+at [^\n]*)*\n?$/, '');
  return { stdout, exitCode, trap, log: logSlice(start) };
}

async function main() {
  console.log(`== 等待 api.ready（解包 sysroot）==`);
  const t0 = Date.now();
  await api.ready;
  console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 1. 万能头 + 容器 + 算法 + cin/cout/printf/getline
  const r1 = await compileLinkRun(
    `#include <bits/stdc++.h>
using namespace std;
int main() {
    int n; cin >> n;
    vector<int> v(n);
    for (auto &x : v) cin >> x;
    sort(v.begin(), v.end());
    string name; cin >> name;
    string dummy; getline(cin, dummy); // 吃掉行尾
    string line; getline(cin, line);
    map<string,int> cnt; cnt[line]++;
    long long sum = accumulate(v.begin(), v.end(), 0LL);
    cout << "sum=" << sum << " name=" << name << " line=" << line << " cnt=" << cnt[line] << endl;
    printf("printf ok %d %.1f\\n", 42, 1.5);
    return 0;
}
`,
    '5\n3 1 4 1 5\ntom\nhello world\n',
    { input: 't1.cc' },
  );
  check('bits/stdc++.h 编译链接运行', r1.exitCode === 0 && !r1.trap, JSON.stringify({ exitCode: r1.exitCode, trap: r1.trap, log: r1.log.slice(-600) }));
  check('排序求和输出正确', r1.stdout.includes('sum=14 name=tom line=hello world cnt=1'), JSON.stringify(r1.stdout));
  check('printf 输出正确', r1.stdout.includes('printf ok 42 1.5'), JSON.stringify(r1.stdout));

  // 2. 编译错误 → 诊断
  const r2 = await compileLinkRun('int main() { return oops; }', '', { input: 't2.cc' });
  check('编译错误被诊断捕获', /error:/i.test(r2.log), r2.log.slice(-300));

  // 3. 语法检查（-fsyntax-only）通过 bits 头
  {
    const start = logText.length;
    const t = Date.now();
    try {
      await api.run(await api.getModule(api.clangFilename), 'clang', '-cc1', '-fsyntax-only',
        ...api.clangCommonArgs, '-std=c++20', '-x', 'c++', 't1.cc');
      check('递归语法检查已缓存源通过', true);
    } catch {
      check('递归语法检查已缓存源通过', false, logSlice(start).slice(-400));
    }
    console.log(`   syntax-only 耗时 ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }

  console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
  process.exit(failed ? 1 : 0);
}

main().catch((exn) => {
  console.error('冒烟测试异常:', exn);
  console.error(logText.slice(-2000));
  process.exit(2);
});
