#!/usr/bin/env node
/**
 * C++ 竞赛场景严格矩阵（Node 侧，不经浏览器，直接驱动 shared.js 栈）。
 *
 * 覆盖：I/O 与格式化（cin/cout/scanf/printf/getline/stringstream/快读/CRLF/EOF）、
 * STL 全家桶（vector/map/set/priority_queue/deque/stack/queue/pair/tuple/array/
 * bitset/string/list）、常用算法（sort/lower_bound/next_permutation/nth_element/
 * accumulate/unique/gcd/快速幂/筛法）、现代语言特性（lambda/结构化绑定/if constexpr/
 * 变参折叠/C++20 concepts+ranges+<=>/C++23 deducing this+if consteval）、类与内存
 * （虚函数/unique_ptr/模板特化）、数学与边界（__int128、long long/unsigned 边界、
 * 深递归/栈溢出、mt19937）、运行时行为谱系（assert/abort/exit/除零 UB）、编译与
 * 链接错误谱系（缺分号/未声明/只读/缺头/register/异常禁用/undefined symbol）。
 *
 * 每例：编译 →（期望错误则断诊断）→ 链接 →（期望链接错则断日志）→ 运行 →
 * stdout 精确比对 / exitCode / trap。末尾用 clang22-noeh/lld22-noeh 抽查
 * 降级路径（老浏览器回退二进制）。前置：public/compiler/ 已产出。
 *
 * 用法：node scripts/tests/cpp-cp-matrix.mjs [--filter 关键词]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judgeCase, normalizeOutput } from '../../lib/compiler/diff.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(ROOT, 'public', 'compiler');

const filterArg = process.argv.includes('--filter')
  ? process.argv[process.argv.indexOf('--filter') + 1]
  : null;

function readBuffer(name) {
  return fs.readFileSync(path.join(BIN, name)).buffer;
}
const compileStreaming = async (name) => WebAssembly.compile(readBuffer(name));

const ANSI = /\x1b\[[0-9;]*m/g;

function makeAPI(clangBin, lldBin) {
  let logText = '';
  const sharedSrc = fs.readFileSync(path.join(ROOT, 'public/compiler-js/shared.js'), 'utf8');
  const { API } = new Function(`${sharedSrc}\n;return { API };`)();
  const api = new API({
    readBuffer,
    compileStreaming,
    hostWrite: (s) => { logText += s; },
    showTiming: false,
    clang: clangBin, lld: lldBin, sysroot: 'sysroot22.tar', memfs: 'memfs',
    clangResourceInclude: '/lib/clang/22/include',
    clangExtraArgs: [
      '-internal-isystem', '/include/wasm32-wasip1/noeh/c++/v1',
      '-internal-isystem', '/include/wasm32-wasip1',
    ],
    lldFlags: ['--export-dynamic'],
    lldLibdir: 'lib/wasm32-wasip1',
    lldLibs: ['-lc', '-lc++', '-lc++abi', '-lclang_rt.builtins'],
  });
  return { api, log: () => logText, reset: () => { logText = ''; } };
}

/** 与 bridge.js cleanStdout 同语义：剥命令回显、计时行、错误尾块；
 *  trap 时从第一个行首 "Error: " 截掉 JS 侧堆栈。 */
function cleanStdout(slice, { trap = null } = {}) {
  let stdout = slice
    .replace(/^> [^\n]*\.wasm\n/, '')
    .replace(/\n?\([^()\n]*s\/[^()\n]*s\)\n?$/, '')
    .replace(/\n?Error: process exited with code \d+\.\n?$/, '');
    if (trap !== null) {
      const match = stdout.match(/\n?Error: /);
      if (match) stdout = stdout.slice(0, match.index);
    }
  return stdout;
}

let seq = 0;
async function compileLinkRun(stack, source, stdin, { std = null } = {}) {
  const input = `c${++seq}.cc`;
  stack.reset();
  try {
    await stack.api.compile({ input, contents: source, obj: `${input}.o`, extraArgs: std ? [`-std=${std}`] : [] });
  } catch (exn) {
    if (typeof exn.code !== 'number') throw exn;
    return { kind: 'compile-error', log: stack.log().replace(ANSI, '') };
  }
  try {
    await stack.api.link(`${input}.o`, `${input}.wasm`);
  } catch {
    return { kind: 'link-error', log: stack.log().replace(ANSI, '') };
  }
  stack.api.memfs.setStdinStr(stdin ?? '');
  const mod = await WebAssembly.compile(stack.api.memfs.getFileContents(`${input}.wasm`));
  let exitCode = 0;
  let trap = null;
  const t0 = Date.now();
  const start = stack.log().length; // 与 bridge.compileLinkRunResult 一致：切片从 run 前打点
  try {
    await stack.api.run(mod, `${input}.wasm`);
  } catch (exn) {
    if (typeof exn.code === 'number') exitCode = exn.code;
    else trap = exn.message ?? String(exn);
  }
  const ms = Date.now() - t0;
  const stdout = cleanStdout(stack.log().slice(start).replace(ANSI, ''), { trap }).trim();
  return { kind: 'ran', stdout, exitCode, trap, ms };
}

// ---- 断言驱动 ----

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${extra ? `\n      ${String(extra).slice(0, 900)}` : ''}`);
  }
}

async function caseRun(stack, c) {
  const r = await compileLinkRun(stack, c.src, c.stdin, { std: c.std });
  if (c.compileError) {
    check(c.name, r.kind === 'compile-error' && c.compileError.test(r.log),
      JSON.stringify({ kind: r.kind, logTail: r.log?.slice(-300) }));
    return;
  }
  if (c.linkError) {
    check(c.name, r.kind === 'link-error' && c.linkError.test(r.log),
      JSON.stringify({ kind: r.kind, logTail: r.log?.slice(-300) }));
    return;
  }
  // 精确比对走产品判题 judgeCase（行尾空白/文末空行/\r 归一），与线上对拍同语义
  const outOk = c.stdoutExact !== undefined
    ? judgeCase(c.stdoutExact, r.stdout).verdict === 'AC'
    : (c.includes ?? []).every((s) => normalizeOutput(r.stdout).join('\n').includes(s));
  const conds = [
    r.kind === 'ran',
    outOk,
    c.exitCode === undefined ? true : r.exitCode === c.exitCode,
    c.trapPresent ? r.trap != null : r.trap == null,
    c.trapMatch ? c.trapMatch.test(r.trap ?? '') : true,
    c.msUnder === undefined ? true : r.ms <= c.msUnder,
  ];
  check(c.name, conds.every(Boolean),
    JSON.stringify({ got: { stdout: r.stdout, exitCode: r.exitCode, trap: r.trap, ms: r.ms } }));
}

// ---- 参照值（BigInt 预计算）----

const MOD = 998244353n;
const A128 = 123456789123456789n;
const B128 = 987654321987654321n;
function biToDec(x) {
  let s = '';
  let v = x;
  do {
    s = String(v % 10n) + s;
    v /= 10n;
  } while (v > 0n);
  return s;
}
const P128 = A128 * B128; // __int128 全积参照
const MULMOD = ((A128 % MOD) * (B128 % MOD)) % MOD;
const MODPOW = (() => {
  let base = 3n % MOD, e = 100n, r = 1n;
  while (e > 0n) {
    if (e & 1n) r = (r * base) % MOD;
    base = (base * base) % MOD;
    e >>= 1n;
  }
  return r;
})();
// 全局数组 + 堆数组求和参照
const G1 = Array.from({ length: 1_000_000 }, (_, i) => i % 7).reduce((a, b) => a + b, 0);
const G2 = Array.from({ length: 500_000 }, (_, i) => i % 3).reduce((a, b) => a + b, 0);
// 2e5 快读求和参照
const BIG_N = 200_000;
const BIG_STDIN = `${BIG_N}\n` + Array.from({ length: BIG_N }, (_, i) => (i % 1000) - 500).join(' ');
const BIG_SUM = Array.from({ length: BIG_N }, (_, i) => (i % 1000) - 500).reduce((a, b) => a + b, 0);

// ---- 用例矩阵 ----

const cases = [
  // ===== A. I/O 与格式 =====
  {
    name: 'IO: cin>> 多整数求和',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ int n; cin >> n; long long s = 0; for (int i = 0; i < n; i++){ int x; cin >> x; s += x; } cout << s << endl; }\n`,
    stdin: '3\n10 20 12\n',
    stdoutExact: '42',
  },
  {
    name: 'IO: scanf/printf 混合类型 %d %lld %llu %u %s %c',
    src: `#include <cstdio>\nint main(){ int a; long long b; unsigned long long c; unsigned d; char s[16]; char ch;\n    scanf("%d %lld %llu %u %s %c", &a, &b, &c, &d, s, &ch);\n    printf("%d %lld %llu %u %s %c\\n", a, b, c, d, s, ch); }\n`,
    stdin: '5 70000000000 18446744073709551615 7 hello x\n',
    stdoutExact: '5 70000000000 18446744073709551615 7 hello x',
  },
  {
    name: 'IO: printf 宽度/补零/左对齐/进制',
    src: `#include <cstdio>\nint main(){ printf("[%5d][%-5d|][%05d][%x][%X][%o]\\n", 42, 42, 42, 42, 42, 42); }\n`,
    stdoutExact: '[   42][42   |][00042][2a][2A][52]',
  },
  {
    name: 'IO: printf 浮点 %.2f %8.3f %e %g',
    src: `#include <cstdio>\nint main(){ printf("%.2f %8.3f %e %g\\n", 3.14159, 2.71828, 12345.6789, 0.0001); }\n`,
    stdoutExact: '3.14    2.718 1.234568e+04 0.0001',
  },
  {
    name: 'IO: iomanip fixed/setprecision/setw/setfill/hex/boolalpha',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ cout << fixed << setprecision(3) << (2.0/3.0) << " " << setw(6) << 42 << " " << setfill('0') << setw(4) << 7 << " " << hex << 255 << " " << boolalpha << true << endl; }\n`,
    stdoutExact: '0.667     42 0007 ff true',
  },
  {
    name: 'IO: getline 带空格整行',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ int n; cin >> n; cin.ignore(); string line; getline(cin, line); cout << "[" << line << "] len=" << line.size() << endl; }\n`,
    stdin: '2\nhello world line\n',
    stdoutExact: '[hello world line] len=16',
  },
  {
    name: 'IO: EOF 安全循环（空输入得 0）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ long long s = 0, cnt = 0, x; while (cin >> x){ s += x; cnt++; } cout << cnt << " " << s << endl; }\n`,
    stdin: '',
    stdoutExact: '0 0',
  },
  {
    name: 'IO: EOF 安全循环（尾随空白输入）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ long long s = 0, cnt = 0, x; while (cin >> x){ s += x; cnt++; } cout << cnt << " " << s << endl; }\n`,
    stdin: '1 2 3  \n 4\n\n',
    stdoutExact: '4 10',
  },
  {
    name: 'IO: stringstream 逗号拆分',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ string line; getline(cin, line); replace(line.begin(), line.end(), ',', ' '); stringstream ss(line); int x; vector<int> v; while (ss >> x) v.push_back(x); for (size_t i = 0; i < v.size(); i++) cout << v[i] << (i + 1 < v.size() ? "|" : ""); cout << endl; }\n`,
    stdin: '1,22,333\n',
    stdoutExact: '1|22|333',
  },
  {
    name: 'IO: CRLF 输入容忍（\\r 视为空白）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ int a, b, c; cin >> a >> b >> c; cout << a + b + c << endl; }\n`,
    stdin: '1 2\r\n3\r\n',
    stdoutExact: '6',
  },
  {
    name: 'IO: 快读 2e5 个数求和（性能 <5s）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ ios::sync_with_stdio(false); cin.tie(nullptr); int n; cin >> n; long long s = 0; for (int i = 0; i < n; i++){ int x; cin >> x; s += x; } cout << s << endl; }\n`,
    stdin: BIG_STDIN,
    stdoutExact: String(BIG_SUM),
    msUnder: 5000,
  },
  {
    name: 'IO: 无符号回绕与 long long 边界',
    src: `#include <cstdio>\n#include <climits>\nint main(){ unsigned u = 0; u -= 1; printf("%u %llu %lld %lld\\n", u, ULLONG_MAX, LLONG_MIN, LLONG_MAX); }\n`,
    stdoutExact: '4294967295 18446744073709551615 -9223372036854775808 9223372036854775807',
  },
  {
    name: 'IO: iostream 与 printf 混用顺序（默认同步）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ cout << "a" << endl; printf("b\\n"); cout << "c" << endl; }\n`,
    stdoutExact: 'a\nb\nc',
  },

  // ===== B. STL 容器 =====
  {
    name: 'STL: vector 排序/翻转 + 二维网格',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ vector<int> v{3,1,4,1,5}; sort(v.begin(), v.end()); reverse(v.begin(), v.end());\n    vector<vector<int>> g{{1,2},{3,4}}; int s = 0; for (auto &row : g) for (int x : row) s += x;\n    for (int x : v) cout << x; cout << " " << s << endl; }\n`,
    stdoutExact: '54311 10',
  },
  {
    name: 'STL: map 有序迭代 + operator[] 默认值',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ map<string,int> m; m["b"] = 2; m["a"] = 1; m["c"] += 5; int unused = m["zz"];\n    for (auto &p : m) cout << p.first << "=" << p.second << " "; cout << "| size=" << m.size() << endl; }\n`,
    stdoutExact: 'a=1 b=2 c=5 zz=0 | size=4',
  },
  {
    name: 'STL: unordered_map 计数（排序输出保证确定）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ unordered_map<string,int> m; for (string w : {"x","y","x","z","y","x"}) m[w]++;\n    vector<pair<string,int>> v(m.begin(), m.end()); sort(v.begin(), v.end());\n    for (auto &p : v) cout << p.first << ":" << p.second << " "; cout << endl; }\n`,
    stdoutExact: 'x:3 y:2 z:1 ',
  },
  {
    name: 'STL: set 去重有序 + multiset lower_bound',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ set<int> s{3,1,4,1,5,9,2,6,5}; for (int x : s) cout << x; cout << endl;\n    multiset<int> ms{1,2,2,2,3}; cout << *ms.lower_bound(2) << " " << *ms.upper_bound(2) << " " << ms.count(2) << endl; }\n`,
    stdoutExact: '1234569\n2 3 3',
  },
  {
    name: 'STL: priority_queue 大顶/小顶堆',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ priority_queue<int> mx; priority_queue<int, vector<int>, greater<int>> mn;\n    for (int x : {3,1,4,1,5}) { mx.push(x); mn.push(x); }\n    while (!mx.empty()){ cout << mx.top(); mx.pop(); } cout << " ";\n    while (!mn.empty()){ cout << mn.top(); mn.pop(); } cout << endl; }\n`,
    stdoutExact: '54311 11345',
  },
  {
    name: 'STL: deque 两端操作',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ deque<int> d; d.push_back(2); d.push_front(1); d.push_back(3); d.pop_front(); d.push_front(0);\n    for (int x : d) cout << x; cout << " " << d.front() << d.back() << endl; }\n`,
    stdoutExact: '023 03',
  },
  {
    name: 'STL: stack + queue',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ stack<int> st; queue<int> q; for (int x : {1,2,3}) { st.push(x); q.push(x); }\n    while (!st.empty()){ cout << st.top(); st.pop(); } cout << " "; while (!q.empty()){ cout << q.front(); q.pop(); } cout << endl; }\n`,
    stdoutExact: '321 123',
  },
  {
    name: 'STL: pair 排序 + tuple',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ vector<pair<int,int>> v{{2,9},{1,8},{2,3}}; sort(v.begin(), v.end());\n    for (auto &p : v) cout << p.first << p.second << " "; cout << endl;\n    tuple<int,string,double> t{7, "g", 0.5}; cout << get<0>(t) << get<1>(t) << fixed << setprecision(1) << get<2>(t) << endl; }\n`,
    stdoutExact: '18 23 29\n7g0.5',
  },
  {
    name: 'STL: array + bitset',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ array<int,3> a{5,6,7}; sort(a.begin(), a.end()); cout << get<1>(a) << a.size() << endl;\n    bitset<16> b(42); cout << b << " " << b.count() << " " << b.test(3) << " " << (b >> 2).to_ulong() << endl; }\n`,
    stdoutExact: '63\n0000000000101010 3 1 10',
  },
  {
    name: 'STL: string 全家桶',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ string s = "hello world";\n    cout << s.substr(6) << " " << s.find("o") << " " << s.rfind("o") << " " << (s.compare(0,5,"hello") == 0) << "\\n";\n    s.replace(0, 5, "HELLO"); cout << s << "\\n";\n    cout << to_string(42) << "!" << stoi("123") << " " << stoll("9223372036854775806") + 1 << "\\n";\n    string t = "ab"; t += "cd"; t.push_back('e'); cout << t << " " << t.size() << endl; }\n`,
    stdoutExact: 'world 4 7 1\nHELLO world\n42!123 9223372036854775807\nabcde 5',
  },
  {
    name: 'STL: list 插入/排序/删除',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ list<int> l{3,1}; l.push_back(2); l.push_front(9); l.sort(); l.remove(1);\n    for (int x : l) cout << x; cout << " " << l.size() << endl; }\n`,
    stdoutExact: '239 3',
  },

  // ===== C. 算法 =====
  {
    name: 'ALGO: 自定义比较器（绝对值+平手规则）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ vector<pair<int,char>> v{{-3,'a'},{1,'b'},{2,'c'},{-2,'d'}};\n    sort(v.begin(), v.end(), [](auto &x, auto &y){ int ax = abs(x.first), ay = abs(y.first);\n        return ax != ay ? ax < ay : x.first < y.first; });\n    for (auto &p : v) cout << p.first << p.second << " "; cout << endl; }\n`,
    stdoutExact: '1b -2d 2c -3a ',
  },
  {
    name: 'ALGO: lower/upper_bound + count',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ vector<int> v{1,2,2,2,3}; cout << (lower_bound(v.begin(), v.end(), 2) - v.begin()) << " "\n        << (upper_bound(v.begin(), v.end(), 2) - v.begin()) << " " << count(v.begin(), v.end(), 2) << endl; }\n`,
    stdoutExact: '1 4 3',
  },
  {
    name: 'ALGO: next_permutation 全排列',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ string s = "abc"; int cnt = 0; do { cout << s << "\\n"; cnt++; } while (next_permutation(s.begin(), s.end())); cout << cnt << endl; }\n`,
    stdoutExact: 'abc\nacb\nbac\nbca\ncab\ncba\n6',
  },
  {
    name: 'ALGO: nth_element 第 k 小',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ vector<int> v{7,1,5,3,9,2}; auto w = v; nth_element(v.begin(), v.begin()+2, v.end());\n    sort(w.begin(), w.end()); cout << v[2] << " "; for (int x : w) cout << x; cout << endl; }\n`,
    stdoutExact: '3 123579',
  },
  {
    name: 'ALGO: min/max/minmax/clamp',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ auto mm = minmax({3,1,4,1,5}); cout << min(3,1) << max(3,1) << mm.first << mm.second\n        << " " << clamp(5,1,3) << clamp(-7,1,3) << clamp(2,1,3) << endl; }\n`,
    std: 'c++17',
    stdoutExact: '1315 312',
  },
  {
    name: 'ALGO: iota/partial_sum/accumulate/inner_product',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ vector<int> v(5); iota(v.begin(), v.end(), 1); for (int x : v) cout << x; cout << " ";\n    vector<int> ps(5); partial_sum(v.begin(), v.end(), ps.begin()); for (int x : ps) cout << x; cout << " "\n        << accumulate(v.begin(), v.end(), 0) << " " << inner_product(v.begin(), v.end(), vector<int>{1,2,3,4,5}.begin(), 0) << endl; }\n`,
    stdoutExact: '12345 1361015 15 55',
  },
  {
    name: 'ALGO: unique+erase 去重惯用法 + count_if',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ vector<int> v{1,1,2,2,3}; v.erase(unique(v.begin(), v.end()), v.end());\n    for (int x : v) cout << x; cout << " " << count_if(v.begin(), v.end(), [](int x){ return x % 2; }) << endl; }\n`,
    stdoutExact: '123 2',
  },
  {
    name: 'ALGO: 位运算内建 + C++20 <bit>',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ cout << __builtin_popcount(11u) << " " << __builtin_popcountll(1LL << 40) << " "\n        << __builtin_clz(8u) << " " << __builtin_ctz(12u) << "\\n";\n    cout << popcount(11u) << " " << has_single_bit(8u) << " " << bit_width(20u) << " " << bit_ceil(5u) << endl; }\n`,
    std: 'c++20',
    stdoutExact: '3 1 28 2\n3 1 5 8',
  },
  {
    name: 'ALGO: gcd/lcm + 快速幂 + 素数筛',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nusing ll = long long;\nll mpow(ll b, ll e, ll m){ ll r = 1; b %= m; while (e){ if (e & 1) r = r * b % m; b = b * b % m; e >>= 1; } return r; }\nint main(){ cout << gcd(12, 18) << " " << lcm(4, 6) << " " << gcd(0, 5) << " " << mpow(2, 10, 1000000007) << "\\n";\n    vector<bool> is(30, true); is[0] = is[1] = false; int cnt = 0;\n    for (int i = 2; i < 30; i++) if (is[i]) { cnt++; for (int j = i * i; j < 30; j += i) is[j] = false; }\n    cout << cnt << endl; }\n`,
    std: 'c++17',
    stdoutExact: '6 12 5 1024\n10',
  },
  {
    name: 'ALGO: 模幂参照（BigInt 对照）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nusing ll = long long;\nint main(){ ll b = 3, e = 100, m = 998244353, r = 1; b %= m; while (e){ if (e & 1) r = r * b % m; b = b * b % m; e >>= 1; } cout << r << endl; }\n`,
    stdoutExact: MODPOW.toString(),
  },
  {
    name: 'ALGO: remove_if/erase + transform + for_each',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ vector<int> v{1,2,3,4,5,6}; v.erase(remove_if(v.begin(), v.end(), [](int x){ return x % 2 == 0; }), v.end());\n    for (int x : v) cout << x; cout << " ";\n    transform(v.begin(), v.end(), v.begin(), [](int x){ return x * x; }); for (int x : v) cout << x; cout << " ";\n    int sum = 0; for_each(v.begin(), v.end(), [&](int x){ sum += x; }); cout << sum << endl; }\n`,
    stdoutExact: '135 1925 35',
  },

  // ===== D. 现代语言特性 =====
  {
    name: 'LANG: lambda 捕获/mutable + std::function 递归',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ int base = 10; auto add = [base](int x) mutable { base += 1; return base + x; };\n    cout << add(1) << " " << add(1) << endl;\n    function<long long(int)> fact = [&](int n) -> long long { return n <= 1 ? 1 : n * fact(n - 1); };\n    cout << fact(10) << endl; }\n`,
    stdoutExact: '12 13\n3628800',
  },
  {
    name: 'LANG: 结构化绑定（map/pair/array）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ map<string,int> m{{"a",1},{"b",2}}; for (auto const& [k, v] : m) cout << k << v << " ";\n    pair<int,string> p{7, "x"}; auto [n, s] = p; cout << n << s << " ";\n    array<int,3> a{4,5,6}; auto [x, y, z] = a; cout << x + y + z << endl; }\n`,
    std: 'c++17',
    stdoutExact: 'a1 b2 7x 15',
  },
  {
    name: 'LANG: if constexpr 类型分派',
    src: `#include <bits/stdc++.h>\nusing namespace std;\ntemplate <class T> string f(const T& v){\n    if constexpr (is_integral_v<T>) return "int:" + to_string(v * 2);\n    else return "str:" + v;\n}\nint main(){ cout << f(21) << " " << f(string("hi")) << endl; }\n`,
    std: 'c++17',
    stdoutExact: 'int:42 str:hi',
  },
  {
    name: 'LANG: 变参模板 + 折叠表达式',
    src: `#include <bits/stdc++.h>\nusing namespace std;\ntemplate <class... Ts> auto sumAll(Ts... xs){ return (xs + ...); }\ntemplate <class... Ts> int countAll(Ts...){ return sizeof...(Ts); }\nint main(){ cout << sumAll(1, 2, 3, 4) << " " << countAll(1, 2, "x", 4.0) << endl; }\n`,
    std: 'c++17',
    stdoutExact: '10 4',
  },
  {
    name: 'LANG: SFINAE/enable_if 分派',
    src: `#include <bits/stdc++.h>\nusing namespace std;\ntemplate <class T, enable_if_t<is_integral_v<T>, int> = 0> const char* kind(T){ return "int"; }\ntemplate <class T, enable_if_t<is_floating_point_v<T>, int> = 0> const char* kind(T){ return "float"; }\nint main(){ cout << kind(1) << " " << kind(1.5) << endl; }\n`,
    std: 'c++17',
    stdoutExact: 'int float',
  },
  {
    name: 'LANG: C++20 concepts（std17 拒绝）',
    src: `#include <concepts>\n#include <cstdio>\ntemplate <std::integral T>\nT sq(T x){ return x * x; }\nint main(){ printf("%d\\n", (int)sq(7)); }\n`,
    std: 'c++17',
    compileError: /error:/i,
  },
  {
    name: 'LANG: C++20 concepts（std20 通过）',
    src: `#include <concepts>\n#include <cstdio>\ntemplate <std::integral T>\nT sq(T x){ return x * x; }\nint main(){ printf("%d\\n", (int)sq(7)); }\n`,
    std: 'c++20',
    stdoutExact: '49',
  },
  {
    name: 'LANG: C++20 ranges 管道（filter/transform）',
    src: `#include <ranges>\n#include <cstdio>\nint main(){ using namespace std::views;\n    for (int x : iota(1, 7) | filter([](int i){ return i % 2 == 0; }) | transform([](int i){ return i * 10; }))\n        printf("%d ", x);\n    printf("\\n"); }\n`,
    std: 'c++20',
    stdoutExact: '20 40 60 ',
  },
  {
    name: 'LANG: C++20 三路比较 <=> 默认排序',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nstruct P { int a; string b; auto operator<=>(const P&) const = default; };\nint main(){ vector<P> v{{2, "y"}, {1, "z"}, {1, "a"}}; sort(v.begin(), v.end());\n    for (auto &p : v) cout << p.a << p.b << " "; cout << endl; }\n`,
    std: 'c++20',
    stdoutExact: '1a 1z 2y ',
  },
  {
    name: 'LANG: C++23 deducing this + 多维下标',
    src: `#include <cstdio>\nstruct M { int operator[](this const M&, int i, int j){ return i * 10 + j; } };\nint main(){ M m; printf("%d\\n", m[2,3]); }\n`,
    std: 'c++23',
    stdoutExact: '23',
  },
  {
    name: 'LANG: C++23 if consteval',
    src: `#include <cstdio>\nconstexpr int f(){ if consteval { return 1; } else { return 0; } }\nint main(){ constexpr int c = f(); printf("%d %d\\n", c, f()); }\n`,
    std: 'c++23',
    stdoutExact: '1 0',
  },
  { name: 'LANG: -std=c++17 宏值', src: `#include <cstdio>\nint main(){ printf("%ld\\n", (long)__cplusplus); }\n`, std: 'c++17', stdoutExact: '201703' },
  { name: 'LANG: -std=c++20 宏值', src: `#include <cstdio>\nint main(){ printf("%ld\\n", (long)__cplusplus); }\n`, std: 'c++20', stdoutExact: '202002' },
  { name: 'LANG: -std=c++23 宏值', src: `#include <cstdio>\nint main(){ printf("%ld\\n", (long)__cplusplus); }\n`, std: 'c++23', stdoutExact: '202302' },
  { name: 'LANG: 不传 -std 时默认 gnu++17（文档化）', src: `#include <cstdio>\nint main(){ printf("%ld\\n", (long)__cplusplus); }\n`, stdoutExact: '201703' },

  // ===== E. 类、模板与内存 =====
  {
    name: 'CLASS: 自定义类型 operator< 排序/入堆',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nstruct Stu { string name; int score; bool operator<(const Stu& o) const { return score != o.score ? score > o.score : name < o.name; } };\nint main(){ vector<Stu> v{{"bob", 90}, {"alice", 95}, {"carl", 90}}; sort(v.begin(), v.end());\n    for (auto &s : v) cout << s.name << s.score << " "; cout << endl; }\n`,
    stdoutExact: 'alice95 bob90 carl90 ',
  },
  {
    name: 'CLASS: 函数模板 + 全特化',
    src: `#include <bits/stdc++.h>\nusing namespace std;\ntemplate <class T> T pick(T){ return T{}; }\ntemplate <> bool pick<bool>(bool b){ return b; }\ntemplate <class T> struct Box { T v; };\nint main(){ cout << pick(0) << pick(0.0) << pick(true) << " " << Box<int>{5}.v << endl; }\n`,
    stdoutExact: '001 5',
  },
  {
    name: 'CLASS: 继承 + 虚函数 + 析构顺序',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nstruct B { virtual string f() { return "B"; } virtual ~B(){ cout << "~B"; } };\nstruct D : B { string f() override { return "D"; } ~D() override { cout << "~D"; } };\nint main(){ unique_ptr<B> p = make_unique<D>(); cout << p->f() << " "; p.reset(); cout << endl; }\n`,
    stdoutExact: 'D ~D~B',
  },
  {
    name: 'CLASS: unique_ptr 所有权转移',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ auto p = make_unique<int>(5); auto q = move(p); cout << *q << " " << (p == nullptr) << " " << (q != nullptr) << endl; }\n`,
    stdoutExact: '5 1 1',
  },
  {
    name: 'CLASS: std::bind + shared/weak',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nusing namespace placeholders;\nint main(){ auto add = [](int a, int b){ return a + b; }; auto inc = bind(add, _1, 1);\n    shared_ptr<int> sp = make_shared<int>(7); weak_ptr<int> wp = sp;\n    cout << inc(41) << " " << *wp.lock() << " " << sp.use_count() << endl; }\n`,
    stdoutExact: '42 7 2',
  },
  {
    name: 'CLASS: 深拷贝语义（vector 嵌套复制）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ vector<vector<int>> g{{1,2},{3,4}}; auto h = g; h[0][0] = 99;\n    cout << g[0][0] << h[0][0] << " " << (g != h) << endl; }\n`,
    stdoutExact: '199 1',
  },

  // ===== F. 数学与边界 =====
  {
    name: 'MATH: cmath 基本函数',
    src: `#include <cstdio>\n#include <cmath>\nint main(){ printf("%.0f %.0f %.0f %.0f %.0f %.6f %.0f %.1f\\n",\n        round(2.5), round(-2.5), floor(-1.5), ceil(-1.5), fmod(7.0, 3.0), sqrt(2.0), pow(2.0, 10.0), fabs(-0.5)); }\n`,
    stdoutExact: '3 -3 -2 -1 1 1.414214 1024 0.5',
  },
  {
    name: 'MATH: __int128 大数乘积（BigInt 参照十进制展开）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nusing i128 = __int128;\nstring dec(i128 x){ if (x == 0) return "0"; string s; bool neg = x < 0; if (neg) x = -x;\n    while (x > 0){ s += char('0' + (int)(x % 10)); x /= 10; } if (neg) s += '-'; reverse(s.begin(), s.end()); return s; }\nint main(){ i128 a = 123456789123456789ULL; i128 b = 987654321987654321ULL; cout << dec(a * b) << endl; }\n`,
    stdoutExact: biToDec(P128),
  },
  {
    name: 'MATH: __int128 乘法取模（BigInt 参照）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nusing ll = long long;\nll mulmod(ll a, ll b, ll m){ return (ll)((__int128)a * b % m); }\nint main(){ cout << mulmod(123456789123456789LL % 998244353, 987654321987654321LL % 998244353, 998244353) << endl; }\n`,
    stdoutExact: MULMOD.toString(),
  },
  {
    name: 'MATH: mt19937 同种子两次实例一致且边界正确',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ mt19937 a(42), b(42); bool same = true;\n    for (int i = 0; i < 1000; i++){ if (a() != b()) same = false; }\n    cout << same << " " << (a() == b()) << " " << (a.min() == 0u) << " " << (a.max() == 4294967295u) << endl; }\n`,
    stdoutExact: '1 1 1 1',
  },
  {
    name: 'MATH: 全局大数组（1e6 BSS）+ 堆数组',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nstatic int g[1000000];\nint main(){ long long s1 = 0; for (int i = 0; i < 1000000; i++){ g[i] = i % 7; } for (int i = 0; i < 1000000; i++) s1 += g[i];\n    int *h = new int[500000]; long long s2 = 0; for (int i = 0; i < 500000; i++){ h[i] = i % 3; } for (int i = 0; i < 500000; i++) s2 += h[i];\n    delete[] h; cout << s1 << " " << s2 << endl; }\n`,
    stdoutExact: `${G1} ${G2}`,
    msUnder: 5000,
  },
  {
    name: 'MATH: 深递归 1e5 层（返回值依赖，1MB 栈内）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nlong long f(long long n){ return n <= 0 ? 0 : 1 + f(n - 1); }\nint main(){ cout << f(100000) << endl; }\n`,
    stdoutExact: '100000',
  },
  {
    name: 'MATH: 栈溢出可诊断（volatile 垫帧真递归 → trap）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nlong long f(long long n){ volatile char pad[1024]; pad[0] = (char)n; if (n <= 0) return 0; return 1 + f(n - 1); }\nint main(){ cout << f(100000) << endl; }\n`,
    trapPresent: true,
    trapMatch: /stack/i,
    msUnder: 15000,
  },
  {
    name: 'MATH: 浮点比较边界（epsilon 与 NaN/Inf 判定）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ double a = 0.1 + 0.2; cout << (a == 0.3) << " " << (fabs(a - 0.3) < 1e-9) << " "\n        << isnan(sqrt(-1.0)) << " " << isinf(1.0 / 0.0) << endl; }\n`,
    stdoutExact: '0 1 1 1',
  },

  // ===== G. 运行时行为谱系 =====
  {
    name: 'RT: exit(3) 退出码透传',
    src: `#include <cstdio>\n#include <cstdlib>\nint main(){ fputs("bye\\n", stdout); exit(3); }\n`,
    stdoutExact: 'bye',
    exitCode: 3,
  },
  {
    name: 'RT: assert 失败 → 消息保留 + trap',
    src: `#include <cassert>\nint main(){ assert(1 == 2); }\n`,
    includes: ['Assertion failed: 1 == 2'],
    trapPresent: true,
  },
  {
    name: 'RT: assert 通过 → 无 trap',
    src: `#include <cassert>\nint main(){ assert(1 == 1); return 0; }\n`,
    stdoutExact: '',
  },
  {
    name: 'RT: abort() → trap（llvm.trap），stdout 保留',
    src: `#include <cstdio>\n#include <cstdlib>\nint main(){ fputs("x\\n", stdout); abort(); }\n`,
    includes: ['x'],
    trapPresent: true,
  },
  {
    name: 'RT: 整数除零按 WASM 规范 trap（运行期除数）',
    src: `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ int a, b; cin >> a >> b; cout << (a / b) << endl; }\n`,
    stdin: '1 0\n',
    trapPresent: true,
    trapMatch: /divide by zero/i,
    msUnder: 3000,
  },
  {
    name: 'RT: 异常被编译期禁用（try 拒绝）',
    src: `#include <cstdio>\nint main(){ try { printf("x"); } catch (...) {} }\n`,
    compileError: /exceptions disabled/,
  },
  {
    name: 'RT: 异常被编译期禁用（throw 拒绝）',
    src: `#include <stdexcept>\nint main(){ throw std::runtime_error("x"); }\n`,
    compileError: /exceptions disabled/,
  },
  {
    name: 'RT: 大输出（10 万行）完整不截断',
    src: `#include <cstdio>\nint main(){ for (int i = 0; i < 100000; i++) printf("line-%d\\n", i); }\n`,
    msUnder: 10000,
    includes: ['line-0', 'line-99999'],
  },

  // ===== H. 编译/链接错误谱系 =====
  {
    name: 'ERR: 缺分号',
    src: `int main(){ int x = 1 return x; }\n`,
    compileError: /expected ';'/,
  },
  {
    name: 'ERR: 未声明标识符',
    src: `int main(){ return oops; }\n`,
    compileError: /use of undeclared identifier/,
  },
  {
    name: 'ERR: const 赋值（只读）',
    src: `int main(){ const int c = 1; c = 2; }\n`,
    compileError: /cannot assign|read-only/,
  },
  {
    name: 'ERR: 缺失头文件',
    src: `#include <nosuchheader.h>\nint main(){}\n`,
    compileError: /file not found/,
  },
  {
    name: 'ERR: register 关键字（C++17 移除）',
    src: `int main(){ register int x = 1; return x; }\n`,
    std: 'c++17',
    compileError: /error:/i,
  },
  {
    name: 'ERR: 模板错误诊断',
    src: `#include <vector>\ntemplate <class T> struct W { typename T::type x; };\nint main(){ W<int> w; }\n`,
    compileError: /error:/i,
  },
  {
    name: 'ERR: 链接错误（声明未定义）',
    src: `int f(int);\nint main(){ return f(1); }\n`,
    linkError: /undefined symbol/,
  },
  {
    name: 'ERR: 多错误一次报全',
    src: `int main(){ return a + b + c; }\n`,
    compileError: /use of undeclared identifier/,
  },
];

// noeh 降级二进制抽查的代表场景
const NOEH_FILTER = ['IO: cin>> 多整数求和', 'printf 宽度', 'vector 排序/翻转', 'concepts（std20 通过）', 'assert 失败'];

async function main() {
  const stack = makeAPI('clang22', 'lld22');
  console.log('== 等待 api.ready（解包 sysroot）==');
  const t0 = Date.now();
  await stack.api.ready;
  console.log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

  for (const c of cases) {
    if (filterArg && !c.name.includes(filterArg)) continue;
    await caseRun(stack, c);
  }

  if (!filterArg) {
    console.log('\n== noeh 降级二进制抽查 ==');
    const stack2 = makeAPI('clang22-noeh', 'lld22-noeh');
    await stack2.api.ready;
    for (const key of NOEH_FILTER) {
      const c = cases.find((x) => x.name.includes(key));
      await caseRun(stack2, { ...c, name: `[noeh] ${c.name}` });
    }
  }

  console.log(`\n==== C++ 矩阵汇总: ${passed} 通过, ${failed} 失败 ====`);
  process.exit(failed ? 1 : 0);
}

process.on('unhandledRejection', (exn) => {
  console.error('矩阵异常:', exn);
  process.exit(2);
});

main().catch((exn) => {
  console.error('矩阵异常:', exn);
  process.exit(2);
});
