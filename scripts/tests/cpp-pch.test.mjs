#!/usr/bin/env node
/**
 * bridge.js PCH（预编译头）与编译进度/计时集成测试（Node 侧，真实 clang22
 * wasm 运行时，不经浏览器）。
 *
 * 验证 2026-10 编译提速改造的核心不变式：
 *  1. 源码含 #include <bits/stdc++.h> 时注入 -include-pch，编译结果与不注入
 *     完全一致（stdout / exitCode），且命中缓存后明显快于无 PCH 基线；
 *  2. PCH 按 -std 分缓存，c++17 / c++20 各自独立且都能用；
 *  3. timings（compileMs/linkMs/moduleMs/runMs/pch）齐全，pch.builtNow 只在
 *     首次为真；
 *  4. runCases 逐例 notify 'case' 事件（index/total/result），stage 含
 *     「链接中」「运行样例 i/n」；
 *  5. syntaxCheck / codeComplete 吃 PCH（-fsyntax-only/-code-completion-at
 *     补 -O2 保持与 PCH 构建选项一致），诊断与补全结果不受影响；
 *  6. 非 bits 源码不使用 PCH（pch 为 null）照常编译；
 *  7. PCH 构建失败自动降级：普通编译仍成功（本次会话不再重试）。
 *
 * 前置：public/compiler/ 已产出（npm run data:pull:runtime）。
 * 用法：node scripts/tests/cpp-pch.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'public', 'compiler');

function readBuffer(name) {
  return fs.readFileSync(path.join(BIN, name)).buffer;
}
const compileStreaming = async (name) => WebAssembly.compile(readBuffer(name));

/** 载入 vendored shared.js（API 类）与 bridge.js（self.CPBridge 编排层）。
 *  shared.js 的 IIFE 顶层只 return API（与 cpp-worker.js 相同的补丁手法取出 MemFS）。 */
const sharedSrc = fs.readFileSync(path.join(ROOT, 'public/compiler-js/shared.js'), 'utf8');
const patched = sharedSrc.replace(/return API;\s*\}\)\(\);\s*$/, 'return { API, MemFS };\n})();');
assert.notEqual(patched, sharedSrc, 'shared.js 结构变化：return API 补丁正则失配');
const { API, MemFS } = new Function(`${patched}\n;return API;`)();
const bridgeSrc = fs.readFileSync(path.join(ROOT, 'public/compiler-js/bridge.js'), 'utf8');
const selfShim = {};
new Function('self', bridgeSrc)(selfShim);
const CPBridge = selfShim.CPBridge;

let seq = 0;

/** 建一个 bridge bundle：收集 hostWrite 日志与 notify 事件。 */
function makeBundle() {
  const events = [];
  let logText = '';
  const bundle = CPBridge.createClangApi({
    APIClass: API,
    MemFS,
    readBuffer,
    compileStreaming,
    hostWrite: (s) => { logText += s; },
    notify: (msg) => events.push(msg),
    config: CPBridge.CLANG22_CONFIG,
  });
  bundle.logText = () => logText.replace(/\x1b\[[0-9;]*m/g, '');
  return { bundle, events };
}

const BITS_SRC = `#include <bits/stdc++.h>
using namespace std;
int main(){ int a,b; cin>>a>>b; cout<<"sum="<<(a+b)<<endl; return 0; }
`;

const PLAIN_SRC = `#include <cstdio>
int main(){ printf("plain\\n"); return 0; }
`;

test('PCH：编译结果一致 + 命中缓存后提速 + timings/pch 齐全', async () => {
  const { bundle, events } = makeBundle();
  await bundle.api.ready;

  // 首次：触发 PCH 构建
  const r1 = await CPBridge.compileLinkRunResult(bundle, {
    input: `p${++seq}.cc`, contents: BITS_SRC, obj: `p${seq}.o`, wasm: `p${seq}.wasm`,
    std: 'c++20', stdin: '2 3\n',
  });
  assert.equal(r1.exitCode, 0);
  assert.equal(r1.stdout, 'sum=5\n');
  assert.ok(r1.timings, 'timings 存在');
  assert.ok(r1.timings.compileMs > 0);
  assert.ok(r1.timings.linkMs >= 0);
  assert.ok(r1.timings.moduleMs >= 0);
  assert.ok(r1.timings.runMs >= 0);
  assert.ok(r1.timings.pch, '首次使用 PCH');
  assert.equal(r1.timings.pch.std, 'c++20');
  assert.equal(r1.timings.pch.builtNow, true, '首次为 builtNow');
  assert.ok(events.some((e) => e.type === 'stage' && e.stage === '链接中'));

  // 第二次：PCH 命中缓存，编译应显著快于无 PCH 基线
  const r2 = await CPBridge.compileLinkRunResult(bundle, {
    input: `p${++seq}.cc`, contents: BITS_SRC, obj: `p${seq}.o`, wasm: `p${seq}.wasm`,
    std: 'c++20', stdin: '10 20\n',
  });
  assert.equal(r2.stdout, 'sum=30\n');
  assert.equal(r2.timings.pch.builtNow, false, '第二次命中缓存');
  const withPch = r2.timings.compileMs;

  // 基线：同 bundle 直接裸编译（绕过 PCH 路径）计時
  const t0 = Date.now();
  await bundle.api.compile({
    input: `b${++seq}.cc`, contents: BITS_SRC, obj: `b${seq}.o`,
    extraArgs: ['-std=c++20'],
  });
  const withoutPch = Date.now() - t0;

  console.log(`  PCH 编译 ${withPch}ms vs 无 PCH ${withoutPch}ms`);
  // PCH 后应明显快于基线（留 1.4 倍裕量防慢机抖动）
  assert.ok(
    withPch < withoutPch / 1.4,
    `PCH 应提速：${withPch}ms vs 基线 ${withoutPch}ms`,
  );
});

test('PCH 按 -std 分缓存：c++17 独立构建且可用', async () => {
  const { bundle } = makeBundle();
  await bundle.api.ready;
  const r17 = await CPBridge.compileLinkRunResult(bundle, {
    input: `q${++seq}.cc`, contents: BITS_SRC, obj: `q${seq}.o`, wasm: `q${seq}.wasm`,
    std: 'c++17', stdin: '4 5\n',
  });
  assert.equal(r17.stdout, 'sum=9\n');
  assert.equal(r17.timings.pch.std, 'c++17');
  assert.equal(r17.timings.pch.builtNow, true);
  // c++20 走自己的 PCH（不同 -std 各一份）
  const r20 = await CPBridge.compileLinkRunResult(bundle, {
    input: `q${++seq}.cc`, contents: BITS_SRC, obj: `q${seq}.o`, wasm: `q${seq}.wasm`,
    std: 'c++20', stdin: '1 1\n',
  });
  assert.equal(r20.stdout, 'sum=2\n');
  assert.equal(r20.timings.pch.std, 'c++20');
  assert.equal(r20.timings.pch.builtNow, true);
});

test('runCases：逐例 case 事件 + 样例 stage 进度 + timings', async () => {
  const { bundle, events } = makeBundle();
  await bundle.api.ready;
  const stdins = ['1 2\n', '100 200\n'];
  const { results, timings } = await CPBridge.runCases(bundle, {
    input: `r${++seq}.cc`, contents: BITS_SRC, obj: `r${seq}.o`, wasm: `r${seq}.wasm`,
    std: 'c++20', stdins,
  });
  assert.deepEqual(results.map((r) => r.stdout), ['sum=3\n', 'sum=300\n']);
  assert.ok(timings.pch);
  assert.ok(timings.runMs >= 0);

  const caseEvents = events.filter((e) => e.type === 'case');
  assert.equal(caseEvents.length, stdins.length, '每例一个 case 事件');
  assert.deepEqual(caseEvents.map((e) => e.index), [0, 1]);
  assert.equal(caseEvents[0].total, stdins.length);
  assert.equal(caseEvents[0].result.stdout, 'sum=3\n');
  for (let i = 0; i < stdins.length; i++) {
    assert.ok(
      events.some((e) => e.type === 'stage' && e.stage === `运行样例 ${i + 1}/${stdins.length}`),
      `stage 运行样例 ${i + 1}/${stdins.length}`,
    );
  }
});

test('syntaxCheck / codeComplete 吃 PCH：诊断与补全不受影响', async () => {
  const { bundle } = makeBundle();
  await bundle.api.ready;

  // 正确代码：无诊断（先构建 c++20 PCH）
  const input = `s${++seq}.cc`;
  bundle.api.memfs.addFile(input, BITS_SRC);
  const ok = await CPBridge.syntaxCheck(bundle, { input, contents: BITS_SRC, std: 'c++20' });
  assert.equal(ok.diagnostics.length, 0);

  // 错误代码：诊断照常产出（行号列号正确）
  const bad = `s${++seq}.cc`;
  const badSrc = '#include <bits/stdc++.h>\nint main(){ return s; }\n';
  bundle.api.memfs.addFile(bad, badSrc);
  const badRes = await CPBridge.syntaxCheck(bundle, { input: bad, contents: badSrc, std: 'c++20' });
  assert.ok(badRes.diagnostics.length >= 1);
  assert.equal(badRes.diagnostics[0].line, 2);

  // 补全：string 成员 append 可补出
  const cc = `s${++seq}.cc`;
  const ccSrc = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){ string s; s.app\n';
  bundle.api.memfs.addFile(cc, ccSrc);
  const completions = await CPBridge.codeComplete(bundle, { input: cc, contents: ccSrc, line: 3, col: 27, std: 'c++20' });
  assert.ok(
    completions.some((c) => c.name === 'append'),
    'append 在补全列表',
  );
});

test('非 bits 源码不使用 PCH，照常编译运行', async () => {
  const { bundle } = makeBundle();
  await bundle.api.ready;
  const r = await CPBridge.compileLinkRunResult(bundle, {
    input: `n${++seq}.cc`, contents: PLAIN_SRC, obj: `n${seq}.o`, wasm: `n${seq}.wasm`,
    std: 'c++20', stdin: '',
  });
  assert.equal(r.stdout, 'plain\n');
  assert.equal(r.timings.pch, null, '无 PCH');
});

test('PCH 构建失败自动降级：普通编译仍成功', async () => {
  const { bundle } = makeBundle();
  await bundle.api.ready;
  // 劫持 api.run：拦截 -emit-pch 调用抛错，其余放行
  const origRun = bundle.api.run.bind(bundle.api);
  let pchAttempts = 0;
  bundle.api.run = async (...args) => {
    if (args.includes('-emit-pch')) {
      pchAttempts++;
      throw new Error('simulated pch failure');
    }
    return origRun(...args);
  };
  const r = await CPBridge.compileLinkRunResult(bundle, {
    input: `f${++seq}.cc`, contents: BITS_SRC, obj: `f${seq}.o`, wasm: `f${seq}.wasm`,
    std: 'c++20', stdin: '7 8\n',
  });
  assert.equal(r.stdout, 'sum=15\n', '降级后编译运行成功');
  assert.equal(r.timings.pch, null, 'PCH 标记为不可用');
  // 失败缓存：第二次不再重试构建
  const r2 = await CPBridge.compileLinkRunResult(bundle, {
    input: `f${++seq}.cc`, contents: BITS_SRC, obj: `f${seq}.o`, wasm: `f${seq}.wasm`,
    std: 'c++20', stdin: '1 1\n',
  });
  assert.equal(r2.stdout, 'sum=2\n');
  assert.equal(pchAttempts, 1, '失败后本会话不再重试 PCH 构建');
});
