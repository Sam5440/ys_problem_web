/*
 * bridge.js —— 浏览器内 clang 编排层（classic script，挂 self.CPBridge）。
 *
 * 改编自 cppstudio-io/wasm-clang-runtime v0.1.0 的 src/compiler-bridge.js 与
 * src/error-parser.js（Apache-2.0），上游血统为 binji/wasm-clang
 * （Apache-2.0，WebAssembly Community Group participants）。本站改动：
 *   - 诊断解析内联（上游是独立 ESM 模块，worker 里走 importScripts）
 *   - host_read 重写为「预喂 stdin → 耗尽后 SAB 交互阻塞读」，支持刷题
 *     的交互式输入；同时修掉 Latin-1 单字节写入（stdin 走 UTF-8）
 *   - 新增 syntaxCheck（-fsyntax-only 实时诊断）与 codeComplete
 *     （-code-completion-at）两个编排入口
 *
 * 协议约定：worker 侧先 eval shared.js 取回 {API, MemFS}，把本文件挂到
 * self.CPBridge，再以 createClangApi({APIClass, MemFS, ...}) 创建实例。
 * 注意：MemFS 的 stdin 补丁必须打在原型上、且先于 new API() —— emscripten
 * 导入表在 MemFS 构造时即 bind 固化，事后改实例方法无效。
 */
(function () {
  'use strict';

  const ANSI_RE = /\x1b\[[0-9;]*m/g;
  const DIAG_RE = /^([^\s][^:]*):(\d+):(\d+): (fatal error|error|warning|note|remark): (.*)$/;

  /** clang 文本诊断 → 结构化数组（非诊断行忽略）。 */
  function parseClangDiagnostics(text) {
    const clean = String(text ?? '').replace(ANSI_RE, '');
    const diags = [];
    for (const rawLine of clean.split('\n')) {
      const m = DIAG_RE.exec(rawLine.trim());
      if (!m) continue;
      diags.push({
        file: m[1],
        line: Number(m[2]),
        col: Number(m[3]),
        severity: m[4] === 'fatal error' ? 'error' : m[4],
        message: m[5],
      });
    }
    return diags;
  }

  function hasErrors(diags) {
    return diags.some((d) => d.severity === 'error');
  }

  class CompileError extends Error {
    constructor(diagnostics, rawLog) {
      const first = diagnostics.find((d) => d.severity === 'error') ?? diagnostics[0];
      super(first ? `${first.line}:${first.col} ${first.message}` : '编译失败');
      this.name = 'CompileError';
      this.diagnostics = diagnostics;
      this.rawLog = rawLog;
    }
  }

  /** LLVM 22.1.8 / wasi-sdk 33 的 clang22/lld22/sysroot22 标准配置。 */
  const CLANG22_CONFIG = Object.freeze({
    clang: 'clang22',
    lld: 'lld22',
    sysroot: 'sysroot22.tar',
    memfs: 'memfs',
    clangResourceInclude: '/lib/clang/22/include',
    clangExtraArgs: Object.freeze([
      '-internal-isystem', '/include/wasm32-wasip1/noeh/c++/v1',
      '-internal-isystem', '/include/wasm32-wasip1',
    ]),
    lldFlags: Object.freeze(['--export-dynamic']),
    lldLibdir: 'lib/wasm32-wasip1',
    lldLibs: Object.freeze(['-lc', '-lc++', '-lc++abi', '-lclang_rt.builtins']),
  });

  const LOG_CAP = 8 * 1024 * 1024; // 单请求日志上限（超限截断，防线）
  const OUT_CAP = 2 * 1024 * 1024; // 转发给主线程的上限
  const SAB_MAGIC = 0x43505331; // 'CPS1'

  /**
   * 创建 clang API 实例 + 独立日志缓冲，并给 MemFS 打上「预喂 stdin + SAB
   * 交互读」补丁。
   *
   * @param {object} args
   * @param {Function} args.APIClass    shared.js 的 API 类
   * @param {Function} args.MemFS       shared.js 的 MemFS 类（原型补丁对象）
   * @param {(name: string) => Promise<ArrayBuffer>} args.readBuffer
   * @param {(name: string) => Promise<WebAssembly.Module>} args.compileStreaming
   * @param {(str: string) => void} args.hostWrite 日志输出（worker → 主线程）
   * @param {(msg: object) => void} [args.notify]  主动事件（need-input 等）
   * @param {object} [args.config]
   */
  function createClangApi({ APIClass, MemFS, readBuffer, compileStreaming, hostWrite, notify = () => {}, config = CLANG22_CONFIG }) {
    const log = { text: '', truncated: false };
    let forwarded = 0;
    // 交互读状态：由 worker 侧注入 SAB 视图；runTeardown 复位
    const interactive = { i32: null, u8: null, active: false, eof: false };
    let activeRequestCap = null;

    // ---- MemFS 原型补丁（必须在 new APIClass() 之前！见文件头说明） ----
    // 预喂 stdin 以 UTF-8 字节消费（原实现 Latin-1 单字节直写，中文输入乱码）
    MemFS.prototype.setStdinStr = function (str) {
      this._stdinBytes = new TextEncoder().encode(String(str ?? ''));
      this._stdinPos = 0;
      this._stdinRemainder = null;
    };
    MemFS.prototype.host_read = function (fd, iovs, iovs_len, nread) {
      this.hostMem_.check();
      let size = 0;
      for (let i = 0; i < iovs_len; ++i) {
        const buf = this.hostMem_.read32(iovs);
        iovs += 4;
        const len = this.hostMem_.read32(iovs);
        iovs += 4;
        if (len === 0) continue;
        let chunk = this._stdinRemainder;
        if (chunk && chunk.length) {
          // 上次读剩的尾巴先给
        } else if (interactive.active) {
          chunk = readInteractive(len);
        } else if (this._stdinBytes && this._stdinPos < this._stdinBytes.length) {
          chunk = this._stdinBytes.subarray(this._stdinPos, this._stdinPos + len);
          this._stdinPos += chunk.length;
        } else {
          chunk = null; // EOF
        }
        if (!chunk || chunk.length === 0) break;
        const take = Math.min(chunk.length, len);
        const rest = chunk.length > take ? chunk.subarray(take) : null;
        this._stdinRemainder = rest && rest.length ? rest : null;
        this.hostMem_.write(buf, chunk.subarray(0, take));
        size += take;
        if (take < len) break; // 短读：本次 iov 满/数据尽
      }
      this.hostMem_.write32(nread, size);
      return 0; // ESUCCESS
    };
    function readInteractive(maxLen) {
      if (interactive.eof) return null;
      if (!interactive.i32) return null;
      const i32 = interactive.i32;
      Atomics.store(i32, 0, 1); // WAIT
      notify({ type: 'need-input' });
      for (;;) {
        Atomics.wait(i32, 0, 1); // 阻塞至主线程喂入（data/eof）
        const st = Atomics.load(i32, 0);
        if (st === 2) {
          const len = Atomics.load(i32, 1);
          const bytes = interactive.u8.slice(8, 8 + Math.max(0, len));
          Atomics.store(i32, 0, 0);
          if (!bytes.length) return null; // 空喂给当 EOF，防死循环
          return bytes;
        }
        if (st === 3) {
          Atomics.store(i32, 0, 0);
          interactive.eof = true;
          return null;
        }
        // 其它状态：惊醒，继续等
      }
    }

    const api = new APIClass({
      readBuffer,
      compileStreaming,
      hostWrite: (s) => {
        if (!log.truncated) {
          log.text += s;
          if (log.text.length > LOG_CAP) {
            log.truncated = true;
            log.text += '\n[输出过大，已截断]\n';
          }
        }
        if (forwarded < OUT_CAP) {
          forwarded += s.length;
          hostWrite(s);
        }
      },
      showTiming: true,
      ...config,
    });

    /** 每次 run 前调用：绑定交互 SAB、输出上限并复位状态。 */
    function runSetup({ sab, stdoutCap }) {
      interactive.i32 = sab ? new Int32Array(sab) : null;
      interactive.u8 = sab ? new Uint8Array(sab) : null;
      interactive.active = !!sab;
      interactive.eof = false;
      api.memfs._stdinRemainder = null;
      activeRequestCap = { out: 0, cap: stdoutCap ?? OUT_CAP, hit: false };
      // 交互模式也在 EOF 后给程序一个干净的固定 stdin（空）
      api.memfs.setStdinStr('');
    }
    function runTeardown() {
      interactive.active = false;
      interactive.i32 = null;
      interactive.u8 = null;
    }

    return { api, log, runSetup, runTeardown, interactive, notify,
      outCapState: () => activeRequestCap };
  }

  // ---- 编排入口（worker 调用） ----

  const ANSI = ANSI_RE;

  function sliceFrom(log, start) {
    return log.text.slice(start).replace(ANSI, '');
  }

  /** 从日志切片提取程序 stdout：剥掉命令回显、计时行与运行时错误尾块。
   *  trap 时 JS 侧会在程序输出后追加 "Error: <trap>" 与 RuntimeError 堆栈，
   *  从第一个行首 "Error: " 起整块截掉（assert 等程序自身 stderr 输出在其
   *  之前，保留）；否则内部 JS 堆栈会被当程序输出展示进 UI。 */
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

  /** 编译 + 链接 + 运行。stdin 为预喂文本；interactive 时忽略 stdin 走 SAB。
   *  std 必须与语法检查同源传递——否则运行按 clang 默认标准编译，用户选
   *  c++20/23 时会出现「检查通过、运行报错」的分裂行为。 */
  async function compileLinkRunResult(bundle, { input, contents, obj, wasm, std = null, stdin = '', interactive = false, sab = null }) {
    const { api, log, runSetup, runTeardown } = bundle;
    runSetup({ sab: interactive ? sab : null });

    let start = log.text.length;
    try {
      await api.compile({ input, contents, obj, extraArgs: std ? [`-std=${std}`] : [] });
    } catch (exn) {
      const slice = sliceFrom(log, start);
      const diagnostics = parseClangDiagnostics(slice);
      if (hasErrors(diagnostics)) throw new CompileError(diagnostics, slice);
      throw exn;
    }

    start = log.text.length;
    try {
      await api.link(obj, wasm);
    } catch (exn) {
      throw Object.assign(new Error('链接失败'), { name: 'LinkError', rawLog: sliceFrom(log, start) });
    }

    api.memfs.setStdinStr(stdin);
    const mod = await WebAssembly.compile(api.memfs.getFileContents(wasm));

    start = log.text.length;
    const t0 = Date.now();
    let exitCode = 0;
    let trap = null;
    try {
      await api.run(mod, wasm);
    } catch (exn) {
      if (typeof exn.code === 'number') exitCode = exn.code;
      else trap = exn.message ?? String(exn);
    }
    const elapsedMs = Date.now() - t0;
    runTeardown();

    const stdout = cleanStdout(sliceFrom(log, start), { trap });
    return { stdout, exitCode, trap, elapsedMs, truncated: log.truncated };
  }

  /** 编译一次 + 多样例运行（同一 wasm 重复实例化，等价 judge 逐例重跑的
   *  干净进程语义；每例独立 stdin，互不残留）。 */
  async function runCases(bundle, { input, contents, obj, wasm, std = null, stdins = [] }) {
    const { api, log, runSetup, runTeardown } = bundle;
    runSetup({ sab: null });

    let start = log.text.length;
    try {
      await api.compile({ input, contents, obj, extraArgs: std ? [`-std=${std}`] : [] });
    } catch (exn) {
      const slice = sliceFrom(log, start);
      const diagnostics = parseClangDiagnostics(slice);
      if (hasErrors(diagnostics)) throw new CompileError(diagnostics, slice);
      throw exn;
    }
    try {
      await api.link(obj, wasm);
    } catch (exn) {
      throw Object.assign(new Error('链接失败'), { name: 'LinkError', rawLog: sliceFrom(log, start) });
    }

    const mod = await WebAssembly.compile(api.memfs.getFileContents(wasm));
    const results = [];
    for (const stdinText of stdins) {
      api.memfs.setStdinStr(stdinText);
      const mark = log.text.length;
      const t0 = Date.now();
      let exitCode = 0;
      let trap = null;
      try {
        await api.run(mod, wasm);
      } catch (exn) {
        if (typeof exn.code === 'number') exitCode = exn.code;
        else trap = exn.message ?? String(exn);
      }
      let stdout = cleanStdout(sliceFrom(log, mark), { trap });
      results.push({ stdout, exitCode, trap, elapsedMs: Date.now() - t0 });
    }
    runTeardown();
    return { results, truncated: log.truncated };
  }

  /** -fsyntax-only：返回主文件诊断（头文件内诊断不产生编辑器标记）。 */
  async function syntaxCheck(bundle, { input, std = 'c++20' }) {
    const { api, log } = bundle;
    const start = log.text.length;
    try {
      await api.run(await api.getModule(api.clangFilename), 'clang', '-cc1', '-fsyntax-only',
        ...api.clangCommonArgs, `-std=${std}`, '-x', 'c++', input);
    } catch (exn) {
      if (typeof exn.code !== 'number') throw exn;
    }
    const diags = parseClangDiagnostics(sliceFrom(log, start));
    return {
      diagnostics: diags.filter((d) => d.file === input || d.file === `/${input}`),
      all: diags,
    };
  }

  /** -code-completion-at：返回 [{name, pattern, kind}]。 */
  async function codeComplete(bundle, { input, line, col, std = 'c++20' }) {
    const { api, log } = bundle;
    const start = log.text.length;
    try {
      await api.run(await api.getModule(api.clangFilename), 'clang', '-cc1',
        ...api.clangCommonArgs, `-std=${std}`, '-code-completion-at', `${input}:${line}:${col}`,
        '-x', 'c++', input);
    } catch (exn) {
      if (typeof exn.code !== 'number') throw exn;
    }
    const slice = sliceFrom(log, start);
    const completions = [];
    for (const raw of slice.split('\n')) {
      const m = /^COMPLETION: (\S+) : ?(.*)$/.exec(raw.trim());
      if (m) completions.push({ name: m[1], pattern: m[2].trim() });
      if (completions.length >= 120) break;
    }
    return completions;
  }

  self.CPBridge = {
    CLANG22_CONFIG,
    parseClangDiagnostics,
    hasErrors,
    CompileError,
    createClangApi,
    compileLinkRunResult,
    runCases,
    syntaxCheck,
    codeComplete,
    SAB_MAGIC,
  };
})();
