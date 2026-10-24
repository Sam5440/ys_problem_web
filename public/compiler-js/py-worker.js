/*
 * py-worker —— Pyodide（CPython WebAssembly）运行服务（classic worker）。
 *
 * Pyodide 文件经 jsDelivr 分发（CORS 开放）。加载路径先查 Cache API（设置页
 * 「下载编译器」写入），未命中走网络（loadPyodide 内部的 fetch 全部被本脚本
 * 的 fetch 包装拦截，离线时命中缓存）。入口脚本 pyodide.js 不能 importScripts
 * 直拉跨域（COEP credentialless 会拦 no-cors 请求），改为 CORS fetch + 全局
 * eval，其内部的相对资源加载仍走原始 indexURL、由拦截层接管。
 *
 * 协议（postMessage）：
 *   → { id, type:'run',  code, stdin, interactive, sab, version }
 *   → { id, type:'lint', code, version }
 *   ← { type:'stage', stage } / { type:'ready', pythonVersion }
 *   ← { id, type:'out'|'err', text } / { id, type:'need-input' }
 *   ← { id, ok:true, run:{success, error?, elapsedMs} }
 *   ← { id, ok:true, lint:{diagnostics} }
 *   ← { id, ok:false, error:{kind, message} }
 *
 * 共享内存布局与 cpp-worker 一致（SAB 需跨域隔离）：
 *   stdin SAB：Int32[0]=state(1 等输入/2 有数据/3 EOF)，Int32[1]=长度，byte 8 起数据
 *   中断由主线程对 interrupt SAB 置 1 → KeyboardInterrupt（worker 在 load 时
 *   创建并把视图交给主线程，见 ready 消息）。
 */
'use strict';

const CACHE_NAME = 'compiler-runtime-v1';

const origFetch = self.fetch.bind(self);
self.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input && input.url;
  if (url && url.includes('/pyodide/')) {
    try {
      if (typeof caches !== 'undefined') {
        const cache = await caches.open(CACHE_NAME);
        const hit = await cache.match(url);
        if (hit) return hit;
      }
    } catch {}
  }
  return origFetch(input, init);
};

let pyodide = null;
let loadedVersionId = null;
let loadPromise = null;
let queue = Promise.resolve();

async function loadPyodideRuntime(version) {
  if (pyodide && loadedVersionId === version.id) return pyodide;
  if (loadPromise && loadedVersionId === version.id) return loadPromise;
  loadedVersionId = version.id;
  loadPromise = (async () => {
    const base = version.indexURL;
    postMessage({ type: 'stage', stage: `加载 ${version.label}` });
    const resp = await self.fetch(base + 'pyodide.js');
    if (!resp.ok) throw new Error(`加载 pyodide.js 失败：HTTP ${resp.status}`);
    const src = await resp.text();
    (0, eval)(src); // 间接 eval → worker 全局 loadPyodide（pyodide.js 为 UMD）
    const py = await self.loadPyodide({ indexURL: base });
    let interruptI32 = null;
    try {
      interruptI32 = new Int32Array(new SharedArrayBuffer(4));
      py.setInterruptBuffer(interruptI32);
    } catch {}
    postMessage({
      type: 'ready',
      pythonVersion: py.runPython('import sys; sys.version'),
      interruptSab: interruptI32 ? interruptI32.buffer : null,
    });
    return py;
  })();
  try {
    pyodide = await loadPromise;
    return pyodide;
  } catch (exn) {
    loadPromise = null;
    loadedVersionId = null;
    throw exn;
  }
}

/** 固定 stdin：首调全量返回，之后 EOF（等价 judge 的预喂语义）。 */
function fixedStdinProvider(text) {
  let rest = String(text ?? '');
  return () => (rest ? (r => { rest = ''; return r; })(rest) : undefined);
}

/** 交互 stdin：SAB 阻塞读一行（主线程收到 need-input 后喂入）。 */
function interactiveStdinProvider(sab, onNeedInput) {
  const i32 = new Int32Array(sab);
  const u8 = new Uint8Array(sab);
  let eof = false;
  return () => {
    if (eof) return undefined;
    Atomics.store(i32, 0, 1);
    onNeedInput();
    for (;;) {
      Atomics.wait(i32, 0, 1);
      const st = Atomics.load(i32, 0);
      if (st === 2) {
        const len = Math.max(0, Atomics.load(i32, 1));
        const bytes = u8.slice(8, 8 + len);
        Atomics.store(i32, 0, 0);
        if (!bytes.length) { eof = true; return undefined; }
        return new TextDecoder().decode(bytes).replace(/\n$/, '');
      }
      if (st === 3) {
        Atomics.store(i32, 0, 0);
        eof = true;
        return undefined;
      }
    }
  };
}

/** 剥掉 Pyodide 内部栈帧，只留用户代码帧与最终错误。 */
function cleanTraceback(message) {
  const drop = /\/lib\/python\d[\d.]*\/|_pyodide\/|pyodide\.asm|importlib._bootstrap/;
  return String(message ?? '')
    .split('\n')
    .filter((l) => !drop.test(l))
    .join('\n')
    .trim();
}

function resetInterpreter(py) {
  try {
    py.runPython(
      "for _k in [k for k in globals().copy() if k != '__builtins__' and not k.startswith('__')]:\n    del globals()[_k]\n",
    );
  } catch {}
}

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

self.onmessage = (ev) => {
  const data = ev.data;
  const version = data.version ?? { id: 'default', indexURL: data.indexURL, label: 'Pyodide' };
  queue = queue.then(async () => {
    const { id } = data;
    try {
      const py = await loadPyodideRuntime(version);
      if (data.type === 'run') {
        resetInterpreter(py);
        const interactiveMode = !!(data.interactive && data.sab);
        const onNeedInput = () => postMessage({ id, type: 'need-input' });
        const stdinProvider = interactiveMode
          ? interactiveStdinProvider(data.sab, onNeedInput)
          : fixedStdinProvider(data.stdin);
        if (!interactiveMode) {
          // pyodide 非 raw stdin 回调是记录式语义：无界 read() 只消费一次回调、
          // 单次返回最多被消费 8192 字符，>8KB 输入会被静默截断。固定输入直接
          // 注入真实字节流，让 sys.stdin.buffer.read() / 行迭代 / input() 原生可用。
          // JSON 双重编码保证任意字符（引号/换行/unicode）安全落进 Python 字面量。
          py.runPython(
            'import sys, json, io\n' +
            `sys.stdin = io.TextIOWrapper(io.BytesIO(json.loads(${JSON.stringify(JSON.stringify(String(data.stdin ?? '')))}).encode('utf-8')), encoding='utf-8')\n`,
          );
        } else {
          // 交互路径同根问题：单条记录 >8192 字符同样被截断。注入真实字节流——
          // RawIOBase.readinto 逐记录从 SAB 拉（记录是行且不含换行符，这里补回
          // 换行让 TextIOWrapper 行语义成立；EOF 记录不补），上层 TextIOWrapper
          // 使 input()/行迭代/buffer.read() 对任意行长原生可用。
          py.globals.set('_ys_read_record', () => {
            const rec = stdinProvider();
            return rec === undefined || rec === '' ? '' : `${rec}\n`;
          });
          py.runPython(
            'import sys, io\n' +
            'class _YSInteractiveRaw(io.RawIOBase):\n' +
            '    def __init__(self):\n' +
            '        self._buf = b""\n' +
            '    def readable(self):\n' +
            '        return True\n' +
            '    def readinto(self, b):\n' +
            // 关键：缓冲非空时绝不拉新记录。readline 以 8192 字节分块要数据，
            // >8KB 的行要跨多次 readinto 拼完；若在缓冲还有剩余时就拉下一条
            // 记录，会把还没输入的下一行也阻塞等掉（死锁）。
            '        if not self._buf:\n' +
            '            rec = _ys_read_record()\n' +
            '            if not rec:\n' +
            '                return 0\n' +
            '            self._buf = rec.encode("utf-8")\n' +
            '        data, self._buf = self._buf[:len(b)], self._buf[len(b):]\n' +
            '        b[:len(data)] = data\n' +
            '        return len(data)\n' +
            'sys.stdin = io.TextIOWrapper(_YSInteractiveRaw(), encoding="utf-8")\n',
          );
        }
        py.setStdin({
          stdin: () => {
            const v = stdinProvider();
            return v === null ? undefined : v;
          },
          isatty: interactiveMode,
        });
        // pyodide 的 batched 回调在换行/flush 时触发但文本不含换行符，
        // 必须补回 '\n'，否则多行输出粘连（判题与展示都会错）。
        const sink = (kind) => {
          let size = 0;
          return (s) => {
            if (size > 2 * 1024 * 1024) return; // 输出洪泛防线
            size += s.length;
            postMessage({ id, type: kind, text: `${s}\n` });
          };
        };
        py.setStdout({ batched: sink('out') });
        py.setStderr({ batched: sink('err') });
        const t0 = Date.now();
        let success = true;
        let error = null;
        try {
          await py.runPythonAsync(data.code);
        } catch (exn) {
          success = false;
          error = cleanTraceback(exn.message ?? String(exn));
        }
        postMessage({ id, ok: true, run: { success, error, elapsedMs: Date.now() - t0 } });
      } else if (data.type === 'lint') {
        if (!py.globals.has('_ys_lint')) py.runPython(LINT_SETUP);
        const diagnostics = JSON.parse(py.runPython(`_ys_lint(${JSON.stringify(data.code)})`));
        postMessage({ id, ok: true, lint: { diagnostics } });
      } else {
        postMessage({ id, ok: false, error: { kind: 'internal', message: `未知请求类型 ${data.type}` } });
      }
    } catch (exn) {
      postMessage({
        id,
        ok: false,
        error: { kind: 'load', message: exn?.message ?? String(exn) },
      });
    }
  });
};
