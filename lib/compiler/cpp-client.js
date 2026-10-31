/**
 * C++ 编译器主线程客户端：管理 cpp-worker 生命周期、请求队列、交互 stdin
 * 的 SharedArrayBuffer 喂入与运行看门狗（交互等待输入期间暂停计时）。
 *
 * 超时/停止 = terminate worker（clang 实例丢弃，下次请求自动重建并重新
 * 加载运行时——wasm 模块无法从外部抢占，这是唯一可靠的终止手段）。
 */

const WORKER_URL = '/compiler-js/cpp-worker.js';
const SAB_DATA_CAP = 256 * 1024;
// 编译/链接/PCH 构建期的硬上限（不占用户的运行超时预算，防 clang 卡死无界）
const COMPILE_HARD_CAP_MS = 180000;

function crossIsolated() {
  return typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
}

export function isCrossOriginIsolated() {
  return crossIsolated();
}

export class CppClient {
  constructor() {
    this.worker = null;
    this.readyPromise = null;
    this.pending = new Map(); // id → entry
    this.reqSeq = 0;
    this.onLog = null; // 全局兜底：无请求 id 的日志（初始化/PCH 预热）
    this.onProgress = null; // 全局兜底：无请求 id 的下载进度（初始化期）
    this.exnref = null;
  }

  /** 确保 worker 存在并完成初始化（clang 加载 + sysroot 解包在首个请求时进行）。 */
  ensureWorker() {
    if (this.worker) return this.readyPromise;
    this.worker = new Worker(WORKER_URL);
    this.readyPromise = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });
    this.readyPromise.catch(() => {}); // 防未处理拒绝
    this.worker.onmessage = (ev) => this._dispatch(ev.data);
    this.worker.onerror = (exn) => {
      this._failAll({ kind: 'internal', message: `编译 worker 崩溃：${exn.message ?? exn}` });
    };
    return this.readyPromise;
  }

  _dispatch(msg) {
    if (msg.type === 'ready') {
      this.exnref = msg.exnref;
      this._readyResolve?.(msg);
      return;
    }
    if (msg.type === 'init-error') {
      this._readyReject?.(new Error(msg.message));
      return;
    }
    if (msg.type === 'log') {
      // 日志按请求路由（worker 侧附带 id）；无 id 的兜底给全局 onLog
      const entry = msg.id != null ? this.pending.get(msg.id) : null;
      (entry?.onLog ?? this.onLog)?.(msg.text);
      return;
    }
    // 初始化 / PCH 预热期的下载进度没有请求 id：兜底给全局 onProgress
    if (msg.type === 'progress' && msg.id == null) {
      this.onProgress?.(msg.dl);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    if (msg.type === 'stage' || msg.type === 'progress') {
      entry.onEvent?.(msg);
    } else if (msg.type === 'case') {
      entry.onCase?.(msg);
    } else if (msg.type === 'need-input') {
      entry.needInputPending = true;
      entry.onNeedInput?.();
    } else {
      this.pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg);
      else entry.reject(Object.assign(new Error(msg.error?.message ?? 'worker 错误'), { error: msg.error }));
    }
  }

  _failAll(error) {
    for (const [, entry] of this.pending) {
      entry.reject(Object.assign(new Error(error.message), { error }));
    }
    this.pending.clear();
  }

  _post(msg, { onEvent, onNeedInput, onLog, onCase } = {}) {
    const id = ++this.reqSeq;
    // runPhase：stage 进入「运行/运行样例」后为真——看门狗只对该阶段计时
    const entry = { onEvent, onNeedInput, onLog, onCase, needInputPending: false, runPhase: false };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    this.pending.set(id, entry);
    promise.entry = entry;
    promise.id = id;
    this.worker.postMessage({ id, ...msg });
    return promise;
  }

  /**
   * 编译 + 链接 + 运行。
   * 看门狗只对「程序运行」阶段计时（stage 含「运行」；编译/链接/PCH 构建
   * 不占用户的运行超时预算），编译期单独给硬上限防 clang 卡死。
   * @returns {Promise<{stdout, exitCode, trap, elapsedMs, truncated, timings}>}
   */
  async run({ source, std = 'c++20', stdin = '', interactive = false, timeoutMs = 10000, onLog, onStage, onProgress, onNeedInput }) {
    await this.ensureWorker();
    const sab = interactive && crossIsolated() ? new SharedArrayBuffer(8 + SAB_DATA_CAP) : null;
    const feed = sab ? this._makeFeed(sab) : null;

    const req = this._post(
      { type: 'run', source, std, stdin, interactive: !!sab, sab },
      {
        onLog,
        onEvent: (m) => {
          if (m.type === 'stage') {
            onStage?.(m.stage);
            // 「运行」= 程序执行阶段；「运行样例 i/n」也计（runCases）。
            // 「构建预编译头」不含「运行」，归编译期
            if (req.entry) req.entry.runPhase = m.stage.includes('运行');
          } else onProgress?.(m.dl);
        },
        onNeedInput: () => onNeedInput?.(feed),
      },
    );

    // 看门狗：等待用户输入时暂停计时（思考时间不算超时）
    let remaining = timeoutMs;
    let compileRemaining = COMPILE_HARD_CAP_MS;
    let last = Date.now();
    let timedOut = false;
    let timeoutMsg = '';
    let rejectRun = () => {};
    const timeoutP = new Promise((_, rej) => { rejectRun = rej; });
    const timer = setInterval(() => {
      const dt = Date.now() - last;
      last = Date.now();
      if (!req.entry.needInputPending) {
        if (req.entry.runPhase) remaining -= dt;
        else compileRemaining -= dt;
      }
      if (remaining <= 0) {
        timedOut = true;
        timeoutMsg = `运行超时（${Math.round(timeoutMs / 1000)}s），已强制终止`;
        rejectRun(new Error(timeoutMsg));
      } else if (compileRemaining <= 0) {
        timedOut = true;
        timeoutMsg = `编译超时（${Math.round(COMPILE_HARD_CAP_MS / 1000)}s 硬上限），已强制终止`;
        rejectRun(new Error(timeoutMsg));
      }
    }, 250);

    try {
      const msg = await Promise.race([req, timeoutP]);
      return msg.run; // {stdout, exitCode, trap, elapsedMs, truncated, timings}
    } catch (exn) {
      if (timedOut) {
        // 超时：丢弃 worker（wasm 无法抢占，terminate 是唯一可靠终止手段；
        // 普通编译/运行错误不终止，clang 实例继续复用）
        this.stop();
      }
      throw exn;
    } finally {
      clearInterval(timer);
    }
  }

  /** 返回喂入函数：写入一行给阻塞中的 worker（空串 = EOF）。 */
  _makeFeed(sab) {
    return (text) => {
      const i32 = new Int32Array(sab);
      const u8 = new Uint8Array(sab);
      const bytes = new TextEncoder().encode(String(text ?? ''));
      const capped = bytes.slice(0, SAB_DATA_CAP);
      u8.set(capped, 8);
      Atomics.store(i32, 1, capped.length);
      Atomics.store(i32, 0, capped.length ? 2 : 3);
      Atomics.notify(i32, 0);
    };
  }

  /** 样例对拍：编译一次，逐例运行。每例完成经 onCase 流式回调
   *  （{index, total, result}），最终返回 {results, truncated, timings}。
   *  看门狗语义同 run：只计「运行样例 i/n」阶段，编译/链接/PCH 期走硬上限。 */
  async runCases({ source, std = 'c++20', stdins = [], timeoutMs = 30000, onLog, onStage, onProgress, onCase }) {
    await this.ensureWorker();
    const req = this._post({ type: 'run-cases', source, std, stdins }, {
      onLog,
      onCase,
      onEvent: (m) => {
        if (m.type === 'stage') {
          onStage?.(m.stage);
          if (req.entry) req.entry.runPhase = m.stage.includes('运行');
        } else onProgress?.(m.dl);
      },
    });

    let remaining = timeoutMs;
    let compileRemaining = COMPILE_HARD_CAP_MS;
    let last = Date.now();
    let timedOut = false;
    let timeoutMsg = '';
    let rejectRun = () => {};
    const timeoutP = new Promise((_, rej) => { rejectRun = rej; });
    const timer = setInterval(() => {
      const dt = Date.now() - last;
      last = Date.now();
      if (req.entry.runPhase) remaining -= dt;
      else compileRemaining -= dt;
      if (remaining <= 0) {
        timedOut = true;
        timeoutMsg = `样例运行超时（${Math.round(timeoutMs / 1000)}s），已强制终止`;
        rejectRun(new Error(timeoutMsg));
      } else if (compileRemaining <= 0) {
        timedOut = true;
        timeoutMsg = `编译超时（${Math.round(COMPILE_HARD_CAP_MS / 1000)}s 硬上限），已强制终止`;
        rejectRun(new Error(timeoutMsg));
      }
    }, 250);

    try {
      const msg = await Promise.race([req, timeoutP]);
      return msg.runCases; // {results, truncated, timings}
    } catch (exn) {
      if (timedOut) this.stop();
      throw exn;
    } finally {
      clearInterval(timer);
    }
  }

  /** -fsyntax-only 诊断。 */
  async check({ source, std = 'c++20', onLog, onStage }) {
    await this.ensureWorker();
    const msg = await this._post({ type: 'check', source, std }, {
      onLog,
      onEvent: (m) => m.type === 'stage' && onStage?.(m.stage),
    });
    return msg.check;
  }

  /** clang 代码补全（较慢，Ctrl+Space 按需触发）。 */
  async complete({ source, std = 'c++20', line, col }) {
    await this.ensureWorker();
    const msg = await this._post({ type: 'complete', source, std, line, col });
    return msg.completions;
  }

  /** 强制终止（超时/停止按钮）。worker 丢弃，下次请求重建。 */
  stop() {
    if (this.worker) {
      const worker = this.worker;
      this.worker = null;
      this.readyPromise = null;
      worker.terminate();
      this._failAll({ kind: 'internal', message: '已终止当前运行' });
    }
  }

  dispose() {
    this.stop();
  }
}
