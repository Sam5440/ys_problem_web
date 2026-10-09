'use client';

/**
 * 编译器停靠面板（题目右侧，可收起）。
 *
 * - 语言：C++（clang 22 wasm，同源 /compiler 自托管运行时）与 Python
 *   （Pyodide，jsDelivr CDN + Cache API 离线缓存）；运行时在设置里下载。
 * - 模式：样例测试（题目 examples 逐例对拍，C++ 编译一次多例复用）/
 *   交互运行（SharedArrayBuffer 阻塞喂入，需跨域隔离）/ 编译检查
 *   （C++ -fsyntax-only；Python ast.parse；编辑停顿 2s 自动跑）。
 * - 布局：≥1024px 且展开时是**文档流内的并列排版块**（DayView 的
 *   .compiler-host 两列网格右列，sticky 跟随滚动，与题目同层互不遮挡；
 *   宽度走 --compiler-w：xl 42rem、1024–1279 收窄 34rem，左列题目自适应
 *   吃剩余宽度）；更窄的屏幕为 fixed 覆盖式抽屉（globals.css 按断点切换
 *   形态）。收起后状态（草稿/控制台/结果）保留。
 */

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Play, RotateCcw, Square, Terminal, X } from 'lucide-react';
import { judgeCase, truncate } from '@/lib/compiler/diff';
import {
  loadCpSettings,
  saveCpSettings,
  loadDraft,
  saveDraft,
  clearDraft,
} from '@/lib/compiler/cp-settings';
import { CPP_FILES, CPP_VERSION, PYODIDE_VERSIONS, pythonVersion } from '@/lib/compiler/runtimes';
import { hasRuntime } from '@/lib/compiler/runtime-cache';
import { CppClient } from '@/lib/compiler/cpp-client';
import { PyClient, isCrossOriginIsolated } from '@/lib/compiler/py-client';
import { useSettings } from '@/components/settings';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const CodeEditor = dynamic(() => import('./CodeEditor'), {
  ssr: false,
  loading: () => <div className="grid h-full place-items-center text-xs text-muted-foreground">编辑器加载中…</div>,
});

const LANGS = [
  { id: 'cpp', label: 'C++' },
  { id: 'python', label: 'Python' },
];
const MODES = [
  { id: 'samples', label: '样例测试' },
  { id: 'interactive', label: '交互运行' },
  { id: 'check', label: '编译检查' },
];

const CONSOLE_CAP = 200 * 1024;

export default function CompilerDock({ problems }) {
  const { openSettings } = useSettings();
  const [mounted, setMounted] = useState(false);
  const [cp, setCp] = useState(null); // 编译器偏好
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState('cpp');
  const [probIdx, setProbIdx] = useState(0);
  const [mode, setMode] = useState('samples');
  const [code, setCode] = useState('');
  const [runState, setRunState] = useState('idle'); // idle | running | waiting-input
  const [stage, setStage] = useState('');
  const [consoleText, setConsoleText] = useState('');
  const [cases, setCases] = useState([]); // [{index, verdict, actual, expected, diff, elapsedMs, note}]
  const [diags, setDiags] = useState([]);
  const [checkState, setCheckState] = useState(''); // 语法检查状态文案
  const [available, setAvailable] = useState({ cpp: false, python: false });
  const [inputLine, setInputLine] = useState('');
  const [completionStatus, setCompletionStatus] = useState(null);

  const cppRef = useRef(null);
  const pyRef = useRef(null);
  const feedRef = useRef(null);
  const consoleRef = useRef(null);
  const pyOutRef = useRef(''); // 交互/样例期间收集的 Python stdout
  const runTokenRef = useRef(0); // 使乱序完成的旧运行失效
  const checkTimerRef = useRef(null);

  const problem = problems?.[probIdx] ?? null;

  /* ---------- 初始化 ---------- */
  useEffect(() => {
    const s = loadCpSettings();
    setCp(s);
    setLang(s.defaultLang);
    setMode(s.defaultMode);
    setOpen(s.panelOpen);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    document.body.classList.toggle('compiler-open', open);
    return () => document.body.classList.remove('compiler-open');
  }, [open, mounted]);

  useEffect(() => {
    if (mounted) saveCpSettings({ panelOpen: open });
  }, [open, mounted]);

  const refreshAvailability = useCallback(async () => {
    try {
      const [cppOk, pyOk] = await Promise.all([
        hasRuntime(CPP_FILES.map((f) => `/compiler/${f.name}`)),
        Promise.all(PYODIDE_VERSIONS.map((v) => hasRuntime(v.files.map((f) => `${v.indexURL}${f}`)))).then((r) => r.some(Boolean)),
      ]);
      setAvailable({ cpp: cppOk, python: pyOk });
    } catch {}
  }, []);

  useEffect(() => {
    if (!mounted) return;
    refreshAvailability();
    const onChange = () => refreshAvailability();
    window.addEventListener('ysc-runtime-changed', onChange);
    return () => window.removeEventListener('ysc-runtime-changed', onChange);
  }, [mounted, refreshAvailability]);

  /* ---------- 草稿与模板 ---------- */
  const effectiveCode = useCallback(
    (l = lang, i = probIdx) => {
      const key = problems[i]?.code;
      return loadDraft(key, l) ?? cp?.templates?.[l] ?? '';
    },
    [problems, lang, probIdx, cp],
  );

  useEffect(() => {
    if (mounted && cp) setCode(effectiveCode());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, cp && true, probIdx, lang]);

  useEffect(() => {
    if (!mounted || !cp) return;
    const t = setTimeout(() => saveDraft(problems[probIdx]?.code, lang, code), 500);
    return () => clearTimeout(t);
  }, [code, mounted, cp, probIdx, lang, problems]);

  const resetToTemplate = () => {
    const tpl = cp?.templates?.[lang] ?? '';
    clearDraft(problems[probIdx]?.code, lang);
    setCode(tpl);
  };

  /* ---------- 客户端 ---------- */
  const getCpp = () => (cppRef.current ??= new CppClient());
  const getPy = () => (pyRef.current ??= new PyClient());

  useEffect(() => () => {
    cppRef.current?.dispose();
    pyRef.current?.dispose();
  }, []);

  const appendConsole = useCallback((text) => {
    setConsoleText((prev) => {
      const next = (prev + text).slice(-CONSOLE_CAP);
      return next;
    });
  }, []);

  useEffect(() => {
    const el = consoleRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [consoleText]);

  /* ---------- 语法检查（停顿 2s 自动跑） ---------- */
  useEffect(() => {
    if (!mounted || !cp || !open) return;
    if (runState !== 'idle') return;
    if ((lang === 'cpp' && !available.cpp) || (lang === 'python' && !available.python)) return;
    clearTimeout(checkTimerRef.current);
    checkTimerRef.current = setTimeout(async () => {
      setCheckState('检查中…');
      try {
        if (lang === 'cpp') {
          const { diagnostics } = await getCpp().check({ source: code, std: cp.cppStd });
          setDiags(diagnostics);
          setCheckState(diagnostics.some((d) => d.severity === 'error') ? `发现 ${diagnostics.filter((d) => d.severity === 'error').length} 个错误` : '语法检查通过');
        } else {
          const { diagnostics } = await getPy().lint({ code, versionId: cp.pythonVersion });
          setDiags(diagnostics);
          setCheckState(diagnostics.length ? `发现 ${diagnostics.length} 个语法错误` : '语法检查通过');
        }
      } catch (exn) {
        setCheckState(`检查失败：${exn.message}`);
      }
    }, 2000);
    return () => clearTimeout(checkTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, lang, mounted, cp && true, open, runState, available.cpp, available.python]);

  /* ---------- 运行 ---------- */
  const timeoutMs = (cp?.timeoutSec ?? 10) * 1000;

  const runSamples = async () => {
    if (!problem) return;
    const token = ++runTokenRef.current;
    setRunState('running');
    setCases([]);
    setConsoleText('');
    setDiags([]);
    pyOutRef.current = '';
    const examples = problem.examples?.length ? problem.examples : [];
    if (!examples.length) {
      appendConsole('该题没有样例数据，请改用「交互运行」模式。\n');
      setRunState('idle');
      return;
    }
    try {
      if (lang === 'cpp') {
        const client = getCpp();
        const res = await client.runCases({
          source: code,
          std: cp.cppStd,
          stdins: examples.map((e) => e.input),
          timeoutMs: 30000 + examples.length * timeoutMs,
          onLog: appendConsole,
          onStage: setStage,
        });
        if (token !== runTokenRef.current) return;
        setCases(
          res.results.map((r, i) => {
            const j = judgeCase(examples[i].output, r.stdout);
            const re = r.trap || r.exitCode !== 0;
            // 注意展开顺序：...j 必须在 verdict 之前，否则 j.verdict 会把 RE 覆盖回去
            return {
              index: i,
              ...j,
              verdict: re ? 'RE' : j.verdict,
              elapsedMs: r.elapsedMs,
              note: r.trap ? `运行时错误：${truncate(r.trap, 200)}` : r.exitCode !== 0 ? `退出码 ${r.exitCode}` : null,
            };
          }),
        );
        appendConsole(`\n编译一次，运行 ${res.results.length} 个样例完成。\n`);
      } else {
        const client = getPy();
        for (let i = 0; i < examples.length; i++) {
          if (token !== runTokenRef.current) return;
          setStage(`样例 ${i + 1}/${examples.length}`);
          appendConsole(`\n—— 样例 ${i + 1} ——\n`);
          pyOutRef.current = '';
          let res;
          try {
            res = await client.run({
              code,
              stdin: examples[i].input,
              versionId: cp.pythonVersion,
              timeoutMs,
              onOutput: (kind, text) => {
                if (kind === 'out') pyOutRef.current += text;
                appendConsole(text);
              },
              onNeedInput: (feed) => {
                // 样例模式不该要输入；喂 EOF 防挂起
                feed?.('');
              },
            });
          } catch (exn) {
            if (token !== runTokenRef.current) return;
            setCases((prev) => [...prev, { index: i, verdict: 'TE', expected: '', actual: '', diff: null, note: exn.message }]);
            continue;
          }
          if (token !== runTokenRef.current) return;
          const j = judgeCase(examples[i].output, pyOutRef.current);
          // 展开顺序同 C++ 路径：...j 在前，verdict 覆盖才生效
          setCases((prev) => [
            ...prev,
            res.success
              ? { index: i, ...j, elapsedMs: res.elapsedMs }
              : { index: i, ...j, verdict: 'RE', note: truncate(res.error, 600) },
          ]);
        }
      }
    } catch (exn) {
      if (token !== runTokenRef.current) return;
      appendConsole(`\n✗ ${exn.message}\n`);
      if (exn.error?.diagnostics) setDiags(exn.error.diagnostics);
    } finally {
      if (token === runTokenRef.current) {
        setRunState('idle');
        setStage('');
      }
    }
  };

  const runInteractive = async () => {
    const token = ++runTokenRef.current;
    setRunState('running');
    setCases([]);
    setDiags([]);
    setConsoleText('');
    pyOutRef.current = '';
    appendConsole(`—— 交互运行（${lang === 'cpp' ? 'C++ · Clang 22' : `Python · ${pythonVersion(cp.pythonVersion).label}`}）——\n`);
    const needInput = (feed) => {
      feedRef.current = feed;
      setRunState('waiting-input');
    };
    const onOutput = (kind, text) => {
      if (kind === 'out') pyOutRef.current += text;
      appendConsole(text);
    };
    try {
      if (lang === 'cpp') {
        if (!isCrossOriginIsolated()) {
          appendConsole('\n⚠ 当前环境不支持交互输入（需要跨域隔离），程序将以空输入运行。固定输入请用「样例测试」模式。\n');
        }
        const res = await getCpp().run({
          source: code,
          std: cp.cppStd,
          stdin: '',
          interactive: true,
          timeoutMs,
          onLog: appendConsole,
          onStage: setStage,
          onNeedInput: needInput,
        });
        if (token !== runTokenRef.current) return;
        appendConsole(`\n程序结束（退出码 ${res.exitCode}${res.trap ? `，${truncate(res.trap, 160)}` : ''}，${(res.elapsedMs / 1000).toFixed(2)}s）\n`);
      } else {
        const res = await getPy().run({
          code,
          stdin: '',
          interactive: true,
          versionId: cp.pythonVersion,
          timeoutMs,
          onOutput,
          onStage: setStage,
          onNeedInput: needInput,
        });
        if (token !== runTokenRef.current) return;
        appendConsole(
          res.success
            ? `\n程序结束（${(res.elapsedMs / 1000).toFixed(2)}s）\n`
            : `\n${res.error}\n`,
        );
      }
    } catch (exn) {
      if (token !== runTokenRef.current) return;
      appendConsole(`\n✗ ${exn.message}\n`);
      if (exn.error?.diagnostics) setDiags(exn.error.diagnostics);
    } finally {
      feedRef.current = null;
      if (token === runTokenRef.current) {
        setRunState('idle');
        setStage('');
      }
    }
  };

  const runCheck = async () => {
    setRunState('running');
    setStage('检查中');
    setCheckState('检查中…');
    try {
      if (lang === 'cpp') {
        const { diagnostics, all } = await getCpp().check({ source: code, std: cp.cppStd, onLog: appendConsole });
        setDiags(diagnostics);
        setConsoleText(all.filter((d) => d.severity === 'error').map((d) => `${d.file}:${d.line}:${d.col}: ${d.message}`).join('\n') || '编译检查通过，没有发现错误。');
        setCheckState(diagnostics.some((d) => d.severity === 'error') ? `发现 ${diagnostics.filter((d) => d.severity === 'error').length} 个错误` : '编译检查通过');
      } else {
        const { diagnostics } = await getPy().lint({ code, versionId: cp.pythonVersion });
        setDiags(diagnostics);
        setConsoleText(diagnostics.map((d) => `第 ${d.line} 行: ${d.message}`).join('\n') || '语法检查通过。');
        setCheckState(diagnostics.length ? `发现 ${diagnostics.length} 个语法错误` : '语法检查通过');
      }
    } catch (exn) {
      appendConsole(`✗ ${exn.message}\n`);
      setCheckState(`检查失败：${exn.message}`);
    } finally {
      setRunState('idle');
      setStage('');
    }
  };

  const doRun = () => {
    if (runState !== 'idle') return;
    if (lang === 'cpp' && !available.cpp) return openSettings();
    if (lang === 'python' && !available.python) return openSettings();
    if (mode === 'samples') runSamples();
    else if (mode === 'interactive') runInteractive();
    else runCheck();
  };

  const stopRun = () => {
    runTokenRef.current++;
    (lang === 'cpp' ? cppRef : pyRef).current?.stop();
    feedRef.current = null;
    setRunState('idle');
    setStage('');
    appendConsole('\n（已手动终止）\n');
  };

  const sendInput = () => {
    const line = inputLine;
    setInputLine('');
    appendConsole(`≫ ${line}\n`);
    feedRef.current?.(lang === 'cpp' ? `${line}\n` : line);
    setRunState('running');
  };

  const sendEof = () => {
    setInputLine('');
    appendConsole('≪ EOF\n');
    feedRef.current?.('');
    setRunState('running');
  };

  if (!mounted || !cp) return null;

  const langAvailable = lang === 'cpp' ? available.cpp : available.python;
  const busy = runState !== 'idle';
  const passCount = cases.filter((c) => c.verdict === 'AC').length;

  return (
    <>
      {/* 右缘开合按钮（右侧边栏入口）：收起态全宽可见，展开态 ≥xl 保留为收起舌片 */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={open ? '收起编译器' : '展开编译器'}
        title={open ? '收起编译器' : '展开编译器（与题目并排，手机上浮于题目上方）'}
        className={`fixed right-0 top-[55%] z-50 flex items-center gap-1 rounded-l-md border border-r-0 bg-card px-1 py-2.5 text-xs text-muted-foreground shadow-sm transition-colors hover:text-foreground ${open ? 'hidden xl:flex' : 'flex'}`}
      >
        <span className="flex flex-col items-center gap-1 [writing-mode:vertical-rl] tracking-widest">
          <Terminal className="size-3.5" />
          编译器
        </span>
        <ChevronRight className={`size-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <aside
        className={`compiler-box flex flex-col ${open ? 'compiler-panel-open' : ''}`}
        aria-label="编译器面板"
        aria-hidden={!open}
      >
        {/* 头部：题目 + 语言 */}
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Terminal className="size-4 shrink-0 text-muted-foreground" />
          <select
            value={probIdx}
            onChange={(e) => setProbIdx(Number(e.target.value))}
            className="min-w-0 flex-1 truncate rounded-md border bg-background px-2 py-1 text-xs"
            aria-label="选择题目"
          >
            {(problems ?? []).map((p, i) => (
              <option key={p.code} value={i}>
                {p.code} · {p.title}
              </option>
            ))}
          </select>
          <div className="flex rounded-md border p-0.5">
            {LANGS.map((l) => (
              <button
                key={l.id}
                type="button"
                onClick={() => setLang(l.id)}
                className={`rounded px-2 py-0.5 text-xs transition-colors ${lang === l.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {l.label}
              </button>
            ))}
          </div>
          <Button variant="ghost" size="icon" className="size-7" onClick={() => setOpen(false)} aria-label="收起编译器">
            <X className="size-4" />
          </Button>
        </div>

        {/* 编辑器 */}
        <div className="relative min-h-0 flex-1">
          <CodeEditor
            language={lang}
            value={code}
            onChange={setCode}
            diagnostics={diags}
            getCppContext={() => ({
              complete: ({ source, line, col }) => getCpp().complete({ source, line, col, std: cp.cppStd }),
            })}
            onStatus={setCompletionStatus}
          />
        </div>

        {/* 模式页签 + 操作行 */}
        <div className="flex items-center gap-2 border-t px-3 pt-2">
          <div className="flex rounded-md border p-0.5">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                disabled={busy}
                className={`rounded px-2 py-0.5 text-xs transition-colors disabled:opacity-50 ${mode === m.id ? 'bg-secondary text-secondary-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={resetToTemplate}
            className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
            title="重置为设置里的默认模板"
          >
            <RotateCcw className="size-3" />
            重置为模板
          </button>
          <span className="ml-auto truncate text-[11px] text-muted-foreground">
            {completionStatus ?? (checkState || stage || '')}
          </span>
          {busy ? (
            <Button variant="destructive" size="sm" className="h-7 gap-1 px-2.5" onClick={stopRun}>
              <Square className="size-3" />
              停止
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-7 gap-1 px-2.5"
              onClick={doRun}
              aria-label={mode === 'check' ? '检查程序' : '运行程序'}
              title={langAvailable ? '' : '尚未下载该语言运行时，点击前往设置'}
            >
              <Play className="size-3" />
              {mode === 'check' ? '检查' : '运行'}
            </Button>
          )}
        </div>

        {/* 结果区 */}
        <div className="flex min-h-[9rem] flex-1 basis-1/3 flex-col overflow-hidden px-3 pb-3 pt-2">
          {mode === 'samples' && (
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
              {cases.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  通过 {passCount}/{cases.length}
                  {cases.length > 0 && <span className="ml-2">耗时 {cases.reduce((a, c) => a + (c.elapsedMs ?? 0), 0)}ms</span>}
                </p>
              )}
              {cases.length === 0 && !busy && (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  点击「运行」按题目样例逐例对拍（{lang === 'cpp' ? '编译一次，多样例复用' : '每例重置解释器'}）。
                  需要自己喂输入调试请切「交互运行」。
                </p>
              )}
              {cases.map((c) => (
                <details key={c.index} className="rounded-md border text-xs" open={c.verdict !== 'AC'}>
                  <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5">
                    <Badge
                      variant="outline"
                      className={`border-transparent px-1.5 font-mono text-[10px] text-white ${
                        c.verdict === 'AC' ? 'bg-emerald-600' : c.verdict === 'WA' ? 'bg-red-500' : 'bg-amber-600'
                      }`}
                    >
                      {c.verdict}
                    </Badge>
                    <span>样例 {c.index + 1}</span>
                    {c.elapsedMs != null && <span className="text-muted-foreground">{c.elapsedMs}ms</span>}
                    {c.diff && (
                      <span className="truncate text-muted-foreground">
                        第 {c.diff.line} 行不符：期望「{truncate(c.diff.expected, 40)}」实际「{truncate(c.diff.actual, 40)}」
                      </span>
                    )}
                  </summary>
                  <div className="space-y-1.5 border-t px-2.5 py-2 font-mono">
                    {c.note && <p className="text-amber-500">{c.note}</p>}
                    <SampleIO label="输入" text={problem?.examples?.[c.index]?.input} />
                    <SampleIO label="期望输出" text={c.expected} />
                    <SampleIO label="实际输出" text={c.actual} bad={c.verdict !== 'AC'} />
                  </div>
                </details>
              ))}
              {problem?.examples?.length === 0 && <p className="text-xs text-muted-foreground">该题暂无样例数据。</p>}
            </div>
          )}

          {(mode === 'interactive' || mode === 'check') && (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <pre
                ref={mode === 'interactive' ? consoleRef : undefined}
                className="min-h-0 flex-1 overflow-auto rounded-md border bg-background p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap"
              >
                {consoleText || (mode === 'interactive' ? '点击「运行」启动程序；程序请求输入时会在下方出现输入框。\nstdin 为空时等价 EOF。\n' : '点击「检查」运行完整编译检查（含万能头展开），结果同时标进编辑器。\n')}
              </pre>
              {mode === 'interactive' && (
                <div className="flex items-center gap-1.5">
                  <input
                    value={inputLine}
                    onChange={(e) => setInputLine(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && runState === 'waiting-input') sendInput();
                    }}
                    disabled={runState !== 'waiting-input'}
                    placeholder={runState === 'waiting-input' ? '程序正在等待输入…' : runState === 'running' ? '程序运行中（输入缓冲仅交互模式）' : '运行后此处可向程序喂输入'}
                    className="min-w-0 flex-1 rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:border-primary/60 disabled:opacity-50"
                  />
                  <Button size="sm" variant="secondary" className="h-7 px-2.5 text-xs" disabled={runState !== 'waiting-input'} onClick={sendInput}>
                    发送
                  </Button>
                  <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground" disabled={runState !== 'waiting-input'} onClick={sendEof}>
                    EOF
                  </Button>
                </div>
              )}
            </div>
          )}

          {!langAvailable && (
            <p className="mt-2 rounded-md border border-dashed px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
              {lang === 'cpp' ? CPP_VERSION.label : 'Pyodide'} 运行时未下载。{' '}
              <button type="button" onClick={openSettings} className="text-primary underline-offset-2 hover:underline">
                打开设置下载
              </button>
              （C++ 运行时由本站同源自托管，约 150MB，下载后离线可用）
            </p>
          )}
        </div>
      </aside>
    </>
  );
}

function SampleIO({ label, text, bad }) {
  if (text == null) return null;
  return (
    <div>
      <p className={`mb-0.5 font-sans text-[10px] uppercase tracking-wide ${bad ? 'text-red-400' : 'text-muted-foreground'}`}>{label}</p>
      <pre className="max-h-32 overflow-auto rounded border bg-background p-1.5 whitespace-pre-wrap">{text}</pre>
    </div>
  );
}
