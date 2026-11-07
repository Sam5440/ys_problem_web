/**
 * Python（Pyodide）主线程客户端：worker 生命周期、加载进度、交互 stdin
 * 喂入、中断（KeyboardInterrupt → 升级 terminate）与 ast 语法检查。
 */

import { pythonVersion } from './runtimes';

const WORKER_URL = '/compiler-js/py-worker.js';
const SAB_DATA_CAP = 256 * 1024;

export function isCrossOriginIsolated() {
  return typeof SharedArrayBuffer !== 'undefined' && self.crossOriginIsolated === true;
}

export class PyClient {
  constructor() {
    this.worker = null;
    this.pending = new Map();
    this.reqSeq = 0;
    this.onLog = null;
    this.interruptSab = null;
    this.pythonVersion = null;
    this.loadedVersionId = null;
    this._readyResolvers = null;
  }

  ensureWorker() {
    if (this.worker) return;
    // Pyodide 314（Python 3.14 线）拒绝 classic worker（"Classic web workers
    // are not supported"），必须 module worker；本脚本无 importScripts，两种
    // 作用域都能跑。
    this.worker = new Worker(WORKER_URL, { type: 'module' });
    this.worker.onmessage = (ev) => this._dispatch(ev.data);
    this.worker.onerror = (exn) => {
      this._failAll({ kind: 'internal', message: `Python worker 崩溃：${exn.message ?? exn}` });
    };
  }

  _dispatch(msg) {
    if (msg.type === 'ready') {
      this.pythonVersion = msg.pythonVersion;
      this.interruptSab = msg.interruptSab;
      this.loadedVersionId = this._loadingVersionId;
      return;
    }
    if (msg.type === 'stage') {
      this.onStage?.(msg.stage);
      return;
    }
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    if (msg.type === 'out' || msg.type === 'err') {
      entry.onOutput?.(msg.type, msg.text);
    } else if (msg.type === 'need-input') {
      entry.needInputPending = true;
      entry.onNeedInput?.();
    } else {
      this.pending.delete(msg.id);
      entry.settled = true;
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

  _post(msg, handlers = {}) {
    const id = ++this.reqSeq;
    const entry = { settled: false, needInputPending: false, ...handlers };
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
   * 运行 Python 代码。返回 {success, error, elapsedMs}。
   * 超时先发 KeyboardInterrupt（可拦截的中断），2s 仍不退才 terminate。
   */
  async run({ code, stdin = '', interactive = false, versionId, timeoutMs = 10000, onOutput, onStage, onNeedInput }) {
    this.ensureWorker();
    const version = pythonVersion(versionId);
    const sab = interactive && isCrossOriginIsolated() ? new SharedArrayBuffer(8 + SAB_DATA_CAP) : null;
    const feed = sab ? this._makeFeed(sab) : null;
    this._loadingVersionId = version.id;
    this.onStage = onStage;

    const req = this._post(
      { type: 'run', code, stdin, interactive: !!sab, sab, version },
      {
        onOutput,
        onNeedInput: () => onNeedInput?.(feed),
      },
    );

    let remaining = timeoutMs;
    let last = Date.now();
    let interruptSent = false;
    let timedOut = false;
    let rejectRun = () => {};
    const timeoutP = new Promise((_, rej) => { rejectRun = rej; });
    const timer = setInterval(() => {
      if (!req.entry.needInputPending) remaining -= Date.now() - last;
      last = Date.now();
      if (remaining <= 0 && !interruptSent) {
        interruptSent = true;
        timedOut = true;
        onStage?.('中断中…');
        this.interrupt();
        // 宽限 2s：KeyboardInterrupt 没能退出（C 扩展死循环等）就 terminate
        setTimeout(() => {
          if (this.pending.has(req.id)) {
            rejectRun(new Error(`中断无效，已强制终止（超时 ${Math.round(timeoutMs / 1000)}s）`));
          }
        }, 2000);
      } else if (remaining <= -2000) {
        rejectRun(new Error('运行超时，已强制终止'));
      }
    }, 250);

    try {
      const msg = await Promise.race([req, timeoutP]);
      return msg.run; // {success, error?, elapsedMs}
    } catch (exn) {
      if (timedOut) {
        this.stop();
        this._loadingVersionId = null;
      }
      throw exn;
    } finally {
      clearInterval(timer);
    }
  }

  /** 语法检查（ast.parse），返回诊断数组。 */
  async lint({ code, versionId }) {
    this.ensureWorker();
    const version = pythonVersion(versionId);
    this._loadingVersionId = version.id;
    const msg = await this._post({ type: 'lint', code, version });
    return msg.lint;
  }

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

  /** 发 KeyboardInterrupt（需要跨域隔离；否则只能 stop）。 */
  interrupt() {
    if (this.interruptSab) {
      new Int32Array(this.interruptSab)[0] = 1;
      return true;
    }
    return false;
  }

  stop() {
    if (this.worker) {
      const worker = this.worker;
      this.worker = null;
      worker.terminate();
      this._failAll({ kind: 'internal', message: '已终止当前运行' });
    }
  }

  dispose() {
    this.stop();
  }
}
