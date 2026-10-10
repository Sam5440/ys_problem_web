'use client';

/**
 * 设置弹窗里的「编译器」区块：运行时下载管理（Cache API）、默认模板编辑、
 * 语言/标准/超时等偏好，以及「观望中」的更新版运行时占位。
 */

import { useEffect, useState } from 'react';
import {
  CPP_FILES,
  CPP_VERSION,
  PLACEHOLDERS,
  PYODIDE_VERSIONS,
} from '@/lib/compiler/runtimes';
import {
  downloadAll,
  hasRuntime,
  recordDownload,
  removeRuntime,
  runtimeStats,
} from '@/lib/compiler/runtime-cache';
import {
  loadCpSettings,
  saveCpSettings,
  DEFAULT_CPP_TEMPLATE,
  DEFAULT_PY_TEMPLATE,
} from '@/lib/compiler/cp-settings';

const inputCls =
  'w-full rounded-md border bg-background px-2.5 py-1.5 text-sm outline-none placeholder:text-muted-foreground/60 focus:border-primary/60';

function fmtMB(n) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function CompilerSettingsSection() {
  const [cp, setCp] = useState(null);
  const [pyVersionId, setPyVersionId] = useState(null); // 设置里选中的 Pyodide 版本
  const [cpp, setCpp] = useState({ state: 'checking', progress: null, error: null });
  const [py, setPy] = useState({ state: 'checking', progress: null, error: null });
  const [stats, setStats] = useState({});
  const [isolated, setIsolated] = useState(true);

  useEffect(() => {
    const s = loadCpSettings();
    setCp(s);
    setPyVersionId(s.pythonVersion);
    setIsolated(self.crossOriginIsolated === true);
    refresh();
  }, []);

  const pyVersion = PYODIDE_VERSIONS.find((v) => v.id === pyVersionId) ?? PYODIDE_VERSIONS[0];

  const pyUrls = pyVersion.files.map((f) => `${pyVersion.indexURL}${f}`);
  const cppUrls = CPP_FILES.map((f) => `/compiler/${f.name}`);

  async function refresh() {
    try {
      const [cppOk, pyOk] = await Promise.all([hasRuntime(cppUrls), hasRuntime(pyUrls)]);
      setCpp((s) => ({ ...s, state: cppOk ? 'ready' : 'idle', progress: null, error: null }));
      setPy((s) => ({ ...s, state: pyOk ? 'ready' : 'idle', progress: null, error: null }));
      setStats(runtimeStats());
    } catch {
      setCpp((s) => ({ ...s, state: 'idle' }));
      setPy((s) => ({ ...s, state: 'idle' }));
    }
  }

  async function downloadCpp() {
    setCpp({ state: 'downloading', progress: null, error: null });
    try {
      const sizes = await downloadAll(
        CPP_FILES.map((f) => ({ name: f.name, url: `/compiler/${f.name}` })),
        {
          onProgress: (item, p) => {
            setCpp((s) => ({
              ...s,
              progress: { name: item.name, got: p.got, total: p.total || item.size || 0 },
            }));
          },
        },
      );
      recordDownload(cppUrls, sizes, 'cpp');
      setCpp({ state: 'ready', progress: null, error: null });
      window.dispatchEvent(new Event('ysc-runtime-changed'));
    } catch (exn) {
      setCpp({ state: 'error', progress: null, error: exn.message });
    }
  }

  async function downloadPy() {
    setPy({ state: 'downloading', progress: null, error: null });
    try {
      const items = pyVersion.files.map((f) => ({ name: f, url: `${pyVersion.indexURL}${f}` }));
      const sizes = await downloadAll(items, {
        onProgress: (item, p) => {
          setPy((s) => ({ ...s, progress: { name: item.name, got: p.got, total: p.total } }));
        },
      });
      recordDownload(pyUrls, sizes, `python:${pyVersion.id}`);
      // 记住用户下载的版本为默认版本
      saveCpSettings({ pythonVersion: pyVersion.id });
      setCp((s) => ({ ...s, pythonVersion: pyVersion.id }));
      setPy({ state: 'ready', progress: null, error: null });
      window.dispatchEvent(new Event('ysc-runtime-changed'));
    } catch (exn) {
      setPy({ state: 'error', progress: null, error: exn.message });
    }
  }

  async function removeCpp() {
    await removeRuntime(cppUrls);
    refresh();
    window.dispatchEvent(new Event('ysc-runtime-changed'));
  }

  async function removePy() {
    await removeRuntime(pyUrls);
    refresh();
    window.dispatchEvent(new Event('ysc-runtime-changed'));
  }

  if (!cp) return null;

  const patch = (p) => setCp((s) => {
    const next = { ...s, ...p };
    saveCpSettings(p);
    return next;
  });

  const patchTemplate = (lang, text) => patch({ templates: { ...cp.templates, [lang]: text } });

  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      <p className="text-xs font-medium text-muted-foreground">
        浏览器编译器 · 运行时下载到本机（Cache API，离线可用）。题目右侧的编译器面板需要先在这里下载对应语言的运行时。
      </p>

      <RuntimeCard
        title="C++ · Clang/LLVM 22.1.8（wasi-sdk 33）"
        note={`支持 C++17/20/23 与万能头 bits/stdc++.h；运行时由本站同源自托管，共 ${fmtMB(CPP_FILES.reduce((a, f) => a + (f.size || 0), 0))}。`}
        state={cpp}
        total={CPP_FILES.reduce((a, f) => a + (f.size || 0), 0)}
        onDownload={downloadCpp}
        onRemove={removeCpp}
        progressText={cpp.progress ? `${cpp.progress.name} ${fmtMB(cpp.progress.got)}${cpp.progress.total ? ` / ${fmtMB(cpp.progress.total)}` : ''}` : '准备中…'}
      />

      <RuntimeCard
        title={`Python · ${pyVersion.label}`}
        note={`官方 CPython WebAssembly 构建，共约 12–15 MB。`}
        state={py}
        onDownload={downloadPy}
        onRemove={removePy}
        progressText={py.progress ? `${py.progress.name} ${fmtMB(py.progress.got)}${py.progress.total ? ` / ${fmtMB(py.progress.total)}` : ''}` : '准备中…'}
        extra={
          <label className="block space-y-1">
            <span className="text-xs font-medium text-muted-foreground">Pyodide 版本</span>
            <select
              className={inputCls}
              value={pyVersionId}
              onChange={(e) => {
                setPyVersionId(e.target.value);
                saveCpSettings({ pythonVersion: e.target.value });
                setCp((s) => ({ ...s, pythonVersion: e.target.value }));
                refresh();
              }}
            >
              {PYODIDE_VERSIONS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </label>
        }
      />

      {!isolated && (
        <p className="text-[11px] leading-relaxed text-amber-500">
          当前页面未开启跨域隔离，「交互运行」模式的交互输入将不可用（固定输入/样例对拍不受影响）。
        </p>
      )}

      {/* 偏好 */}
      <div className="grid grid-cols-2 gap-2">
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">默认语言</span>
          <select className={inputCls} value={cp.defaultLang} onChange={(e) => patch({ defaultLang: e.target.value })}>
            <option value="cpp">C++</option>
            <option value="python">Python</option>
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">C++ 标准</span>
          <select className={inputCls} value={cp.cppStd} onChange={(e) => patch({ cppStd: e.target.value })}>
            {CPP_VERSION.stds.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">单次运行超时（秒）</span>
          <input
            className={inputCls}
            type="number"
            min="1"
            max="120"
            value={cp.timeoutSec}
            onChange={(e) => patch({ timeoutSec: Math.max(1, Number(e.target.value) || 10) })}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs font-medium text-muted-foreground">面板默认模式</span>
          <select className={inputCls} value={cp.defaultMode} onChange={(e) => patch({ defaultMode: e.target.value })}>
            <option value="samples">样例测试</option>
            <option value="interactive">交互运行</option>
          </select>
        </label>
      </div>

      {/* 模板 */}
      <details className="rounded-md border px-2.5 py-2">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">默认代码模板（新建/重置时使用）</summary>
        <div className="mt-2 space-y-2">
          <TemplateEditor label="C++ 模板" value={cp.templates.cpp} onChange={(t) => patchTemplate('cpp', t)} onReset={() => patchTemplate('cpp', DEFAULT_CPP_TEMPLATE)} rows={10} />
          <TemplateEditor label="Python 模板" value={cp.templates.python} onChange={(t) => patchTemplate('python', t)} onReset={() => patchTemplate('python', DEFAULT_PY_TEMPLATE)} rows={8} />
        </div>
      </details>

      {/* 观望中的更新版运行时 */}
      {PLACEHOLDERS.length > 0 && (
        <details className="rounded-md border border-dashed px-2.5 py-2">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">观望中的更新版运行时（暂不可用）</summary>
          <ul className="mt-2 space-y-1.5">
            {PLACEHOLDERS.map((p) => (
              <li key={p.id} className="text-[11px] leading-relaxed text-muted-foreground">
                <span className="font-medium text-foreground/80">{p.label}</span> — {p.note}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function RuntimeCard({ title, note, state, total, onDownload, onRemove, progressText, extra }) {
  const pct = state.progress?.total ? Math.round((state.progress.got / state.progress.total) * 100) : null;
  return (
    <div className="space-y-1.5 rounded-md border p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{title}</span>
        {state.state === 'ready' && <span className="text-[11px] text-emerald-500">已下载</span>}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{note}</p>
      {extra}
      {state.state === 'downloading' && (
        <div className="space-y-1">
          <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
            <div className="h-full bg-primary transition-all" style={{ width: `${pct ?? 5}%` }} />
          </div>
          <p className="text-[11px] text-muted-foreground">{progressText}{pct != null ? `（${pct}%）` : ''}</p>
        </div>
      )}
      {state.error && <p className="text-[11px] text-red-400">✗ {state.error}</p>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onDownload}
          disabled={state.state === 'downloading' || state.state === 'checking'}
          className="rounded-md border bg-background px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
        >
          {state.state === 'downloading' ? '下载中…' : state.state === 'ready' ? '重新下载' : '下载'}
        </button>
        {state.state === 'ready' && (
          <button
            type="button"
            onClick={onRemove}
            className="rounded-md border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            删除
          </button>
        )}
      </div>
    </div>
  );
}

function TemplateEditor({ label, value, onChange, onReset, rows }) {
  return (
    <label className="block space-y-1">
      <span className="flex items-center justify-between text-xs font-medium text-muted-foreground">
        {label}
        <button type="button" onClick={onReset} className="text-[11px] text-primary underline-offset-2 hover:underline">
          恢复默认
        </button>
      </span>
      <textarea
        className={`${inputCls} font-mono text-xs leading-relaxed`}
        rows={rows}
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
