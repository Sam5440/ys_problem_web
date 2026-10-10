#!/usr/bin/env node
/**
 * Python（Pyodide）竞赛场景严格矩阵（Node 侧，与浏览器同一 CPython WASM 构建）。
 *
 * 忠实镜像 public/compiler-js/py-worker.js 的运行语义：fixedStdinProvider
 * （首调全量、之后 EOF）、setStdout/setStderr batched 回调、runPythonAsync
 * 异常 → success=false + traceback 消息；lint 复用同一 LINT_SETUP 源码。
 *
 * 前置：网络可达 jsDelivr（首次下载 ~13MB 缓存到 /tmp/ys-pyodide314/）。
 * 用法：node scripts/tests/py-cp-matrix.mjs [--filter 关键词]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { judgeCase, normalizeOutput } from '../../lib/compiler/diff.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CACHE = path.join(os.tmpdir(), 'ys-pyodide314');
const INDEX_URL = 'https://cdn.jsdelivr.net/pyodide/v314.0.7/full/';
const FILES = ['pyodide.js', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

const filterArg = process.argv.includes('--filter')
  ? process.argv[process.argv.indexOf('--filter') + 1]
  : null;

async function ensureCache() {
  fs.mkdirSync(CACHE, { recursive: true });
  for (const name of FILES) {
    const dest = path.join(CACHE, name);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) continue;
    process.stdout.write(`下载 ${name}…\n`);
    const res = await fetch(INDEX_URL + name);
    if (!res.ok) throw new Error(`下载失败 ${name}: HTTP ${res.status}`);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
}

async function loadPy() {
  await ensureCache();
  const mod = await import(pathToFileURL(path.join(CACHE, 'pyodide.js')).href);
  // pyodide.js 是 CJS IIFE：named export 探测不到，从 default / globalThis 取
  const loadPyodide = mod.default?.loadPyodide ?? mod.loadPyodide ?? globalThis.loadPyodide;
  return loadPyodide({ indexURL: `${CACHE}/` });
}

// ---- 与 py-worker 相同的运行语义 ----

const fixedStdinProvider = (text) => {
  let done = false;
  return () => {
    if (done) return null;
    done = true;
    return text ?? '';
  };
};

async function runPy(py, code, stdin) {
  // 与（修复后的）py-worker 同语义：固定输入注入真实 BytesIO 字节流，
  // 绕开 pyodide 记录式 stdin 的 8192 字符截断；setStdin 仅作兜底。
  py.runPython(
    'import sys, json, io\n' +
    `sys.stdin = io.TextIOWrapper(io.BytesIO(json.loads(${JSON.stringify(JSON.stringify(String(stdin ?? '')))}).encode('utf-8')), encoding='utf-8')\n`,
  );
  py.setStdin({ stdin: () => undefined });
  const outs = [];
  const errs = [];
  let outSize = 0;
  // pyodide batched 文本不含换行符，补回（与修复后的 py-worker sink 一致）
  py.setStdout({ batched: (s) => { if (outSize <= 2 * 1024 * 1024) { outSize += s.length; outs.push(`${s}\n`); } } });
  py.setStderr({ batched: (s) => errs.push(`${s}\n`) });
  const t0 = Date.now();
  let success = true;
  let error = null;
  try {
    await py.runPythonAsync(code);
  } catch (exn) {
    success = false;
    error = exn.message ?? String(exn);
  }
  return { success, error, stdout: outs.join(''), stderr: errs.join(''), ms: Date.now() - t0 };
}

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name}${extra ? `\n      ${String(extra).slice(0, 700)}` : ''}`);
  }
}

async function caseRun(py, c) {
  if (c.lint) {
    const diag = await lintCheck(py, c.code);
    check(c.name, JSON.stringify(diag) === JSON.stringify(c.want), JSON.stringify(diag));
    return;
  }
  const r = await runPy(py, c.code, c.stdin);
  if (c.wantError) {
    check(c.name, !r.success && c.wantError.test(r.error ?? ''),
      JSON.stringify({ success: r.success, error: r.error?.slice(-300) }));
    return;
  }
  const outOk = c.stdoutExact !== undefined
    ? judgeCase(c.stdoutExact, r.stdout).verdict === 'AC'
    : (c.includes ?? []).every((s) => normalizeOutput(r.stdout).join('\n').includes(s));
  check(c.name, r.success && outOk && (c.msUnder === undefined || r.ms <= c.msUnder),
    JSON.stringify({ got: { stdout: r.stdout, error: r.error?.slice(-400), ms: r.ms } }));
}

// 与 py-worker LINT_SETUP 同源
const LINT_SETUP = `
import ast, json

def _ys_lint(code):
    try:
        ast.parse(code)
        return json.dumps([])
    except SyntaxError as e:
        return json.dumps([{
            "line": e.lineno or 1,
            "col": (e.offset or 1) - 1,
            "endLine": getattr(e, "end_lineno", None) or (e.lineno or 1),
            "endCol": getattr(e, "end_offset", None) or (e.offset or 1),
            "message": e.msg or "语法错误",
        }])
`;

async function lintCheck(py, code) {
  if (!py.globals.has('_ys_lint')) py.runPython(LINT_SETUP);
  return JSON.parse(py.runPython(`_ys_lint(${JSON.stringify(code)})`));
}

// ---- 用例矩阵 ----

const cases = [
  {
    name: 'IO: sys.stdin.read 解析求和',
    code: `import sys\ndata = sys.stdin.read().split()\nn = int(data[0])\nprint(sum(int(x) for x in data[1:n+1]))\n`,
    stdin: '3\n10 20 12\n',
    stdoutExact: '42',
  },
  {
    name: 'IO: input() 单行与多行',
    code: `a = int(input())\nb, c = map(int, input().split())\nprint(a + b + c)\n`,
    stdin: '1\n2 3\n',
    stdoutExact: '6',
  },
  {
    name: 'IO: buffer 快读 1e5 个数求和（<5s，shim 后无截断）',
    code: `import sys\ndata = sys.stdin.buffer.read().split()\nn = int(data[0])\nprint(sum(map(int, data[1:n+1])))\n`,
    stdin: `${100000}\n` + Array.from({ length: 100000 }, (_, i) => (i % 977) - 400).join(' ') + '\n',
    stdoutExact: String(Array.from({ length: 100000 }, (_, i) => (i % 977) - 400).reduce((a, b) => a + b, 0)),
    msUnder: 5000,
  },
  {
    name: 'IO: 行迭代（for line in sys.stdin）不劈 token',
    code: `import sys\nc = 0\ns = 0\nfor line in sys.stdin:\n    for tok in line.split():\n        c += 1\n        s += int(tok)\nprint(c, s)\n`,
    stdin: Array.from({ length: 20000 }, (_, i) => String(i % 997)).join(' ') + '\n',
    stdoutExact: `20000 ${Array.from({ length: 20000 }, (_, i) => i % 997).reduce((a, b) => a + b, 0)}`,
  },
  {
    name: 'IO: input() 多行 + emoji 输入（代理对安全）',
    code: `a = input()\nb = input()\nprint(a, b, len(a))\n`,
    stdin: '🎉🚀 hello\nworld\n',
    stdoutExact: '🎉🚀 hello world 8',
  },
  {
    name: 'IO: CRLF 容忍（split/strip）',
    code: `import sys\nprint(sum(int(x) for x in sys.stdin.read().split()))\n`,
    stdin: '1 2\r\n3\r\n',
    stdoutExact: '6',
  },
  {
    name: 'IO: EOF 安全（空输入）',
    code: `import sys\ntokens = sys.stdin.read().split()\nprint(len(tokens))\n`,
    stdin: '',
    stdoutExact: '0',
  },
  {
    name: 'IO: 行内多值 + 负数 + 前导零',
    code: `a, b, c = input().split()\nprint(int(a) + int(b), c.lstrip('0') or '0')\n`,
    stdin: '-5 007 000123\n',
    stdoutExact: '2 123',
  },
  {
    name: 'COLL: Counter 计数 + most_common',
    code: `from collections import Counter\nwords = 'apple banana apple cherry banana apple'.split()\nc = Counter(words)\nprint(c.most_common(1)[0][0], c['apple'], len(c))\n`,
    stdoutExact: 'apple 3 3',
  },
  {
    name: 'COLL: defaultdict 分组',
    code: `from collections import defaultdict\ng = defaultdict(list)\nfor k, v in [('a', 1), ('b', 2), ('a', 3)]:\n    g[k].append(v)\nprint(g['a'], sorted(g), g['missing'])\n`,
    stdoutExact: "[1, 3] ['a', 'b'] []",
  },
  {
    name: 'COLL: deque 两端 BFS 序列',
    code: `from collections import deque\nd = deque([2])\nd.append(3); d.appendleft(1)\na = d.popleft(); b = d.pop()\nprint(a, list(d), b)\n`,
    stdoutExact: '1 [2] 3',
  },
  {
    name: 'COLL: heapq 小顶堆 + heapify',
    code: `import heapq\na = [5, 1, 3]\nheapq.heapify(a)\nheapq.heappush(a, 0)\nprint([heapq.heappop(a) for _ in range(len(a))])\n`,
    stdoutExact: '[0, 1, 3, 5]',
  },
  {
    name: 'COLL: bisect 二分插入',
    code: `import bisect\na = [1, 3, 3, 5]\ni = bisect.bisect_left(a, 3)\nbisect.insort(a, 4)\nprint(i, a)\n`,
    stdoutExact: '1 [1, 3, 3, 4, 5]',
  },
  {
    name: 'IT: itertools permutations/accumulate/groupby/product',
    code: `from itertools import permutations, accumulate, groupby, product\nprint(len(list(permutations([1, 2, 3]))))\nprint(list(accumulate([1, 2, 3, 4])))\nprint([(k, len(list(g))) for k, g in groupby('aaabb')])\nprint(len(list(product([0, 1], repeat=3))))\n`,
    stdoutExact: '6\n[1, 3, 6, 10]\n[(\'a\', 3), (\'b\', 2)]\n8',
  },
  {
    name: 'IT: lru_cache 记忆化 fib',
    code: `from functools import lru_cache\n@lru_cache(maxsize=None)\ndef fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\nprint(fib(90))\n`,
    stdoutExact: '2880067194370816120',
  },
  {
    name: 'SORT: key 多字段稳定排序',
    code: `a = [('b', 2), ('a', 2), ('c', 1)]\nprint(sorted(a, key=lambda x: x[1]))\nprint(sorted(a, key=lambda x: (-x[1], x[0])))\n`,
    stdoutExact: "[('c', 1), ('b', 2), ('a', 2)]\n[('a', 2), ('b', 2), ('c', 1)]",
  },
  {
    name: 'SORT: 类 __lt__ 与 dataclass(order=True)',
    code: `from dataclasses import dataclass\nclass P:\n    def __init__(self, x, y):\n        self.x, self.y = x, y\n    def __lt__(self, o):\n        return (self.x, self.y) < (o.x, o.y)\n@dataclass(order=True)\nclass Q:\n    score: int\n    name: str\nprint(sorted([P(2, 1), P(1, 9), P(2, 0)], key=lambda p: (p.x, p.y))[0].y)\nprint(sorted([Q(90, 'b'), Q(95, 'a'), Q(90, 'c')], reverse=True)[1].name)\n`,
    stdoutExact: '9\nc',
  },
  {
    name: 'LANG: 推导式与生成器',
    code: `m = {x: x * x for x in range(4)}\ns = {x % 3 for x in range(10)}\ng = sum(x * 2 for x in range(5) if x % 2 == 0)\nprint(m[3], sorted(s), g)\n`,
    stdoutExact: '9 [0, 1, 2] 12',
  },
  {
    name: 'LANG: f-string 与 format 规范',
    code: `x = 1234567.891\nprint(f"{x:,.2f}" , f"{42:>6}", f"{7:04d}", "{:.1%}".format(0.256))\n`,
    stdoutExact: '1,234,567.89     42 0007 25.6%',
  },
  {
    name: 'LANG: 大整数任意精度',
    code: `a = 2 ** 100\nb = a * a\nc, d = divmod(b, 10 ** 50)\nprint(len(str(b)), str(c)[-5:], d)\n`,
    stdoutExact: (() => {
      const b = 2n ** 200n;
      const c = b / 10n ** 50n;
      const d = b % 10n ** 50n;
      return `${b.toString().length} ${c.toString().slice(-5)} ${d.toString()}`;
    })(),
  },
  {
    name: 'LANG: match 语句（3.10+）',
    code: `def f(p):\n    match p:\n        case (0, 0):\n            return 'origin'\n        case (0, y):\n            return f'y{y}'\n        case (x, 0):\n            return f'x{x}'\n        case _:\n            return 'other'\nprint(f((0, 0)), f((0, 5)), f((3, 0)), f((1, 2)))\n`,
    stdoutExact: 'origin y5 x3 other',
  },
  {
    name: 'LANG: 海象运算符 + 装饰器闭包',
    code: `vals = [3, 1, 4, 1, 5]\ntotal = 0\nif (m := max(vals)) > 4:\n    total = m\ndef deco(fn):\n    def wrap(*a):\n        return fn(*a) + 1\n    return wrap\n@deco\ndef add(a, b):\n    return a + b\nprint(total, add(1, 2))\n`,
    stdoutExact: '5 4',
  },
  {
    name: 'LANG: 深递归 25000 层（setrecursionlimit）',
    code: `import sys\nsys.setrecursionlimit(30000)\ndef f(n):\n    return 0 if n <= 0 else 1 + f(n - 1)\nprint(f(25000))\n`,
    stdoutExact: '25000',
    msUnder: 10000,
  },
  {
    name: 'LANG: 异常可用（try/except 对照 C++）',
    code: `out = []\nfor s in ['1', 'x', '3']:\n    try:\n        out.append(int(s) * 2)\n    except ValueError:\n        out.append(-1)\ntry:\n    1 // 0\nexcept ZeroDivisionError:\n    out.append('ZDE')\nprint(*out)\n`,
    stdoutExact: '2 -1 6 ZDE',
  },
  {
    name: 'LANG: 语法错误 lint 诊断（与 py-worker 同源）',
    lint: true,
    code: 'def broken(:\n    pass\n',
    want: [{ line: 1, col: 11, endLine: 1, endCol: 13, message: 'invalid syntax' }],
  },
  {
    name: 'LANG: 正常代码 lint 无诊断',
    lint: true,
    code: 'print(1)\n',
    want: [],
  },
  {
    name: 'MATH: math 库 gcd/isqrt/comb/factorial',
    code: `import math\nprint(math.gcd(12, 18), math.isqrt(17), math.comb(5, 2), math.factorial(10))\n`,
    stdoutExact: '6 4 10 3628800',
  },
  {
    name: 'STR: 字符串方法全家桶',
    code: `s = ' Hello,World '\nparts = s.strip().split(',')\nprint(parts[0], parts[1].lower(), '-'.join(['a', 'b']), 'ab'.startswith('a'), len(s), s[::-1].strip()[-1])\n`,
    stdoutExact: 'Hello world a-b True 13 H',
  },
  {
    name: 'MISC: enumerate/zip/all/any/min/max',
    code: `a = [1, 2, 3]\nb = [4, 5, 6]\nprint([(i, v) for i, v in enumerate(a)][2], list(zip(a, b))[0], all(a), any(0 for _ in a), min(a), max(b))\n`,
    stdoutExact: '(2, 3) (1, 4) True False 1 6',
  },
  {
    name: 'MISC: 运行时错误 → success=false + traceback（ZeroDivisionError）',
    code: `print('before')\nx = 1 // 0\n`,
    wantError: /ZeroDivisionError/,
  },
  {
    name: 'MISC: NameError 报错路径',
    code: `print(undefined_var)\n`,
    wantError: /NameError/,
  },
  {
    name: 'MISC: sys.exit(3) 行为（观察并钉死）',
    code: `import sys\nprint('bye')\nsys.exit(3)\n`,
    wantError: /SystemExit|SystemExit: 3/,
  },
];

// ---- 交互 stdin shim 语义锁 ----
// py-worker.js 的 SAB 交互路径注入 io.RawIOBase 字节流，readline 以 8192 字节
// 分块要数据：>8KB 的行必须跨多次 readinto 拼完，且**缓冲非空时绝不拉下一条
// 记录**（否则会阻塞在还没输入的下一行上，浏览器实测死锁）。此处内联同一份
// 类源码语义做回归锁，改 py-worker 的 shim 时必须同步这里。

const INTERACTIVE_SHIM_SETUP = (readRecordName = '_ys_read_record') =>
  'import sys, io\n' +
  'class _YSInteractiveRaw(io.RawIOBase):\n' +
  '    def __init__(self):\n' +
  '        self._buf = b""\n' +
  '    def readable(self):\n' +
  '        return True\n' +
  '    def readinto(self, b):\n' +
  '        if not self._buf:\n' +
  `            rec = ${readRecordName}()\n` +
  '            if not rec:\n' +
  '                return 0\n' +
  '            self._buf = rec.encode("utf-8")\n' +
  '        data, self._buf = self._buf[:len(b)], self._buf[len(b):]\n' +
  '        b[:len(data)] = data\n' +
  '        return len(data)\n' +
  'sys.stdin = io.TextIOWrapper(_YSInteractiveRaw(), encoding="utf-8")\n';

/** 用给定记录队列驱动交互 shim，跑一段代码，返回 stdout。 */
async function runInteractiveShim(py, records, code) {
  const queue = [...records];
  // 与 py-worker 的 JS 包装一致：记录是行、不含换行符，补回换行；EOF 不补
  py.globals.set('_ys_read_record', () => {
    const rec = queue.length ? queue.shift() : '';
    return rec === '' ? '' : `${rec}\n`;
  });
  py.runPython(INTERACTIVE_SHIM_SETUP());
  const outs = [];
  py.setStdout({ batched: (s) => outs.push(`${s}\n`) });
  let success = true;
  let error = null;
  try {
    await py.runPythonAsync(code);
  } catch (exn) {
    success = false;
    error = exn.message ?? String(exn);
  }
  return { success, error, stdout: outs.join('') };
}

async function interactiveShimCases(py) {
  console.log('\n---- 交互 stdin shim 语义（与 py-worker 同源）----');

  // 核心回归：>8KB 行在 8192 分块读下完整拼回（旧实现的贪婪拉取在此死锁）
  {
    const big = 'x'.repeat(10001);
    const r = await runInteractiveShim(py, [big, 'hello', ''],
      'a = input()\nprint(len(a), a[-1])\n');
    check('shim: >8KB 行经 readline 分块完整拼回', r.success && r.stdout.trim() === `10001 x`,
      JSON.stringify({ got: r.stdout.trim().slice(0, 120), err: r.error?.slice(-200) }));
  }
  {
    const r = await runInteractiveShim(py, ['first', 'second', ''],
      'a = input()\nb = input()\nprint(a, b, sep="|")\n');
    check('shim: 连续两次 input 行纪律正确', r.success && r.stdout.trim() === 'first|second',
      JSON.stringify({ got: r.stdout.trim(), err: r.error?.slice(-200) }));
  }
  {
    const r = await runInteractiveShim(py, ['line1', 'line2', ''],
      'import sys\ndata = sys.stdin.buffer.read()\nprint(len(data.splitlines()))\n');
    check('shim: 无界 read 到 EOF 汇总全部行', r.success && r.stdout.trim() === '2',
      JSON.stringify({ got: r.stdout.trim(), err: r.error?.slice(-200) }));
  }
  {
    // 手工模拟浏览器实测的 8192 分块 readline：逐块 raw.readinto 找换行
    const big = 'y'.repeat(20000);
    const r = await runInteractiveShim(py, [big, 'tail', ''],
      `raw = sys.stdin.buffer\nchunks = []\nwhile True:\n    b = bytearray(8192)\n    n = raw.readinto(b)\n    if n == 0:\n        break\n    chunks.append(bytes(b[:n]))\n    if b"\\n" in b[:n]:\n        break\nline = b"".join(chunks)\nprint(len(line), line[-2])\n`);
    check('shim: 8192 分块手读在行尾正确截停（不吞下一行）', r.success && r.stdout.trim() === '20001 121',
      JSON.stringify({ got: r.stdout.trim().slice(0, 80), err: r.error?.slice(-200) }));
  }
}

async function main() {
  const py = await loadPy();
  console.log(`Pyodide 就绪: ${py.runPython('import sys; sys.version')}\n`);
  for (const c of cases) {
    if (filterArg && !c.name.includes(filterArg)) continue;
    await caseRun(py, c);
  }
  if (!filterArg || '交互 stdin shim'.includes(filterArg) || filterArg === 'shim') {
    await interactiveShimCases(py);
  }
  console.log(`\n==== Python 矩阵汇总: ${passed} 通过, ${failed} 失败 ====`);
  process.exit(failed ? 1 : 0);
}

main().catch((exn) => {
  console.error('Python 矩阵异常:', exn);
  process.exit(2);
});

// sys.exit 用例中 pyodide 内部可能抛异步未处理 rejection——记日志即可，别让进程死掉
process.on('unhandledRejection', (exn) => console.error('[unhandledRejection]', exn?.message ?? exn));
process.on('uncaughtException', (exn) => console.error('[uncaughtException]', exn?.message ?? exn));
