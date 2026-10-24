/*
 * cpp-worker —— Web Worker 内的 clang 编译/运行服务（classic worker）。
 *
 * 由主线程 new Worker('/compiler-js/cpp-worker.js') 创建。资源经 Cache API
 * （设置页「下载编译器」写入）优先，回退同源 /compiler/<name>（CI 把
 * data/runtime 分支注入 deploy 的产物）。上游 GitHub release 无 CORS 头，
 * 同源自托管是唯一可靠的浏览器获取路径。
 *
 * 协议（postMessage）：
 *   → { id, type:'run',    source, std, stdin, interactive, sab }
 *   → { id, type:'check',  source, std }
 *   → { id, type:'complete', source, std, line, col }
 *   ← { type:'ready', exnref }                        初始化完成握手
 *   ← { type:'log', text }                            clang/系统日志流
 *   ← { id, type:'stage', stage }                     阶段进度
 *   ← { id, type:'progress', dl:{name, got, total} }  资源下载进度
 *   ← { id, type:'need-input' }                       交互模式等待输入
 *   ← { id, ok:true, run:{stdout, exitCode, trap, elapsedMs, truncated} }
 *   ← { id, ok:true, check:{diagnostics, all} }
 *   ← { id, ok:true, completions:[{name, pattern}] }
 *   ← { id, ok:false, error:{kind, message, diagnostics?, rawLog?} }
 *
 * 交互 stdin：主线程创建 SharedArrayBuffer 随 run 请求传入（需跨域隔离）。
 * 布局：Int32[0]=state(0空闲/1等输入/2有数据/3EOF)，Int32[1]=字节长，
 * byte 8 起为数据区。worker 在 fd_read 阻塞 Atomics.wait，主线程喂入后 notify。
 */
'use strict';

const SELF_URL = self.location.href;
const CACHE_NAME = 'compiler-runtime-v1';

importScripts(new URL('./bridge.js', SELF_URL)); // 挂载 self.CPBridge

let bridge = null;
let initPromise = null;
let reqCounter = 0;
let queue = Promise.resolve();
/** 当前处理中的请求 id —— 交互读的 need-input 从 bridge 深处异步冒出，
 *  必须补上 id 才能被 cpp-client 的 pending 表路由（请求串行，安全）。 */
let currentId = null;

async function readBuffer(name, onProgress) {
  // 1) Cache API 命中（设置页下载管理器写入的运行时）
  try {
    if (typeof caches !== 'undefined') {
      const cache = await caches.open(CACHE_NAME);
      const hit = await cache.match(`/compiler/${name}`);
      if (hit) return await hit.arrayBuffer();
    }
  } catch {}

  // 2) 同源 /compiler/<name>（deploy 注入产物 / 本地 dev public 目录）。
  //    弱网重试 2 次（共 3 次，退避 300ms/900ms）。
  const preferGz = typeof DecompressionStream === 'function' && typeof TransformStream === 'function';
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 300 * 3 ** (attempt - 1)));
    const useGz = preferGz && attempt === 0; // 首试 .gz（精确进度 + 更小传输），404 回退裸文件
    try {
      const response = await fetch(`/compiler/${name}${useGz ? '.gz' : ''}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body?.getReader) return await response.arrayBuffer();
      const total = Number(response.headers.get('content-length')) || 0;
      let stream = response.body;
      if (useGz) {
        let reported = 0;
        stream = stream.pipeThrough(new TransformStream({
          transform(chunk, ctrl) {
            reported += chunk.byteLength;
            onProgress?.(name, reported, total);
            ctrl.enqueue(chunk);
          },
        })).pipeThrough(new DecompressionStream('gzip'));
      }
      const reader = stream.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.byteLength;
        if (!useGz) onProgress?.(name, got, total);
      }
      const buf = new Uint8Array(got);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.byteLength; }
      return buf.buffer;
    } catch (exn) {
      lastErr = exn;
    }
  }
  throw Object.assign(
    new Error(`加载 ${name} 失败（已重试 2 次）：${lastErr?.message ?? '网络错误'}。` +
      '请到 设置 → 编译器 下载运行时，或确认站点已部署编译器运行时（public/compiler）。'),
    { name: 'WasmLoadError' },
  );
}

const compileStreaming = async (name) => WebAssembly.compile(await readBuffer(name, (n, got, total) => {
  postMessage({ type: 'progress', dl: { name: n, got, total } });
}));

/** exnref 探测（34 字节 try_table 模块）：不支持则换 noeh 二进制。 */
const EXNREF_PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, 0x01, 0x04, 0x01, 0x60,
  0x00, 0x00, 0x03, 0x02, 0x01, 0x00, 0x0a, 0x0e, 0x01, 0x0c, 0x00, 0x02,
  0x40, 0x1f, 0x40, 0x01, 0x02, 0x00, 0x01, 0x0b, 0x0b, 0x0b,
]);

async function supportsExnref() {
  try {
    await WebAssembly.compile(EXNREF_PROBE);
    return true;
  } catch {
    return false;
  }
}

async function init() {
  const sharedSrc = await (await fetch(new URL('./shared.js', SELF_URL))).text();
  // shared.js 的 MemFS 类在 IIFE 闭包内部不外露（顶层只导出 API）；借用其
  // 返回语句把类一起带出来 —— stdin 交互补丁必须打在原型上、且先于
  // new API()（emscripten 导入表在构造时 bind 固化）。vendored 副本固定
  // 以 `return API; })();` 收尾，上游改版时这里的断言会立刻暴露。
  const patched = sharedSrc.replace(/return API;\s*\}\)\(\);\s*$/, 'return { API, MemFS };\n})();');
  // IIFE 被 patch 成返回 {API, MemFS} 后整体赋给顶层 const API——外层取回
  // 这个对子即可；顶层作用域没有裸的 MemFS 标识符可引用。
  const exposed = new Function(`${patched}\n;return API;`)();
  const { API, MemFS } = exposed;
  if (typeof MemFS !== 'function' || typeof API !== 'function') {
    throw new Error('shared.js 结构变化：无法取出 MemFS/API 类');
  }

  const exnref = await supportsExnref();
  const config = exnref
    ? self.CPBridge.CLANG22_CONFIG
    : { ...self.CPBridge.CLANG22_CONFIG, clang: 'clang22-noeh', lld: 'lld22-noeh' };
  if (!exnref) postMessage({ type: 'log', text: '当前浏览器内核较旧，已自动切换兼容版编译器（noeh）。\n' });

  bridge = self.CPBridge.createClangApi({
    APIClass: API,
    MemFS,
    readBuffer: (name) => readBuffer(name, (n, got, total) => postMessage({ type: 'progress', dl: { name: n, got, total } })),
    compileStreaming,
    hostWrite: (s) => postMessage({ id: currentId, type: 'log', text: String(s).replace(/\x1b\[[0-9;]*m/g, '') }),
    notify: (msg) => postMessage({ id: currentId, ...msg }),
    config,
  });
  await bridge.api.ready; // memfs 启动 + sysroot 解包
  postMessage({ type: 'ready', exnref });
}

function getBundle() {
  if (!initPromise) {
    initPromise = init().catch((exn) => {
      initPromise = null;
      throw exn;
    });
  }
  return initPromise;
}

/** 唯一文件名：memfs.addFile 不保证覆盖同名节点。 */
const nextInput = (prefix) => `${prefix}${++reqCounter}.cc`;

function wrapError(exn) {
  if (exn && exn.name === 'CompileError') {
    return { kind: 'compile', message: exn.message, diagnostics: exn.diagnostics, rawLog: exn.rawLog };
  }
  if (exn && exn.name === 'LinkError') {
    return { kind: 'link', message: exn.message, rawLog: exn.rawLog };
  }
  return { kind: 'internal', message: exn?.message ?? String(exn) };
}

self.onmessage = (ev) => {
  const data = ev.data;
  queue = queue.then(async () => {
    const { id } = data;
    currentId = id;
    try {
      await getBundle();
      const { api } = bridge;
      if (data.type === 'run') {
        postMessage({ id, type: 'stage', stage: '编译中' });
        const input = nextInput('m');
        api.memfs.addFile(input, data.source);
        const run = await self.CPBridge.compileLinkRunResult(bridge, {
          input,
          contents: data.source,
          obj: `${input}.o`,
          wasm: `${input}.wasm`,
          std: data.std ?? null,
          stdin: data.stdin ?? '',
          interactive: !!data.interactive,
          sab: data.sab ?? null,
        });
        postMessage({ id, ok: true, run });
      } else if (data.type === 'run-cases') {
        // 样例对拍：编译一次，逐例重跑（每例独立 stdin）
        postMessage({ id, type: 'stage', stage: '编译中' });
        const input = nextInput('s');
        api.memfs.addFile(input, data.source);
        const { results, truncated } = await self.CPBridge.runCases(bridge, {
          input,
          contents: data.source,
          obj: `${input}.o`,
          wasm: `${input}.wasm`,
          std: data.std ?? null,
          stdins: data.stdins ?? [],
        });
        postMessage({ id, ok: true, runCases: { results, truncated } });
      } else if (data.type === 'check') {
        postMessage({ id, type: 'stage', stage: '语法检查中' });
        const input = nextInput('c');
        api.memfs.addFile(input, data.source);
        const check = await self.CPBridge.syntaxCheck(bridge, { input, std: data.std });
        postMessage({ id, ok: true, check });
      } else if (data.type === 'complete') {
        const input = nextInput('k');
        api.memfs.addFile(input, data.source);
        const completions = await self.CPBridge.codeComplete(bridge, {
          input, line: data.line, col: data.col, std: data.std,
        });
        postMessage({ id, ok: true, completions });
      } else {
        postMessage({ id, ok: false, error: { kind: 'internal', message: `未知请求类型 ${data.type}` } });
      }
    } catch (exn) {
      postMessage({ id, ok: false, error: wrapError(exn) });
    }
  });
};

getBundle().catch((exn) => {
  postMessage({ type: 'log', text: `编译服务初始化失败：${exn?.message ?? exn}\n` });
  postMessage({ type: 'init-error', message: exn?.message ?? String(exn) });
});
