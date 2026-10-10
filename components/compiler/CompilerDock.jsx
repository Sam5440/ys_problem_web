'use client';

/**
 * 编译器独立工作区面板（首页/日页共用，全高右列）。
 *
 * - 语言：C++（clang 22 wasm，同源 /compiler 自托管运行时）与 Python
 *   （Pyodide，jsDelivr CDN + Cache API 离线缓存）；运行时在设置里下载。
 * - 模式：样例测试（题目 examples 逐例对拍，C++ 编译一次多例复用）/
 *   交互运行（SharedArrayBuffer 阻塞喂入，需跨域隔离）/ 编译检查
 *   （C++ -fsyntax-only；Python ast.parse；编辑停顿 2s 自动跑）。
 * - 布局：本组件只负责面板本体，经 portal 渲染进 layout 顶层的
 *   #compiler-dock-root（.compiler-track）。打开（body.compiler-open）时整站
 *   缩窄为左列、面板 sticky 全高独占右列——文档流分栏，没有 fixed 覆盖层；
 *   宽度 --compiler-w、开关动画都在 globals.css（中途中断可平滑反向）。
 *   面板宽度（左缘竖向手柄）与编辑器/结果区高度（编辑器下横向手柄）可拖拽，
 *   双击手柄复位；偏好存 ysc-cp-settings-v1 的 panelWidth / consoleH（null =
 *   跟随 CSS 默认），宽度内联写到 <html> 的 --compiler-w，globals.css 的
 *   flex-basis min() 兜底保证左列不小于 280px。
 *   <900px 加载时不自动展开（并排空间太小），用户点名才开。
 *   收起后状态（草稿/控制台/结果）保留。
 * - 入口：右缘舌片（收起态）、顶部「编译器」按钮（经 ysc-compiler-toggle
 *   事件）、Ctrl/⌘+J；关闭：面板 ×、Esc（焦点在面板内时不抢编辑器的 Esc）、
 *   Ctrl/⌘+J。
 */

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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

/* 拖拽边界：面板宽度最小 360px、最多吃到只剩 280px 左列（与 globals.css 的
   flex-basis min() 兜底一致）；结果区高度下限对齐 min-h-[9rem]，上限给编辑器
   留足 240px 顶部+最小编辑空间 */
const MIN_PANEL_W = 360;
const MIN_CONSOLE_H = 144;

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
  const [panelW, setPanelW] = useState(null); // 面板宽度（px），null = CSS clamp 默认
  const [consoleH, setConsoleH] = useState(null); // 结果区高度（px），null = flex 默认比例
  const [dragging, setDragging] = useState(null); // 'w' | 'h' | null（手柄视觉态）

  const cppRef = useRef(null);
  const pyRef = useRef(null);
  const feedRef = useRef(null);
  const consoleRef = useRef(null);
  const panelRef = useRef(null); // aside 本体：宽度拖拽的起始测量 + 结果区上限
  const resultsRef = useRef(null); // 结果区：高度拖拽的起始测量
  const pyOutRef = useRef(''); // 交互/样例期间收集的 Python stdout
  const runTokenRef = useRef(0); // 使乱序完成的旧运行失效
  const checkTimerRef = useRef(null);
  const [portalRoot, setPortalRoot] = useState(null); // layout 顶层的 #compiler-dock-root

  const problem = problems?.[probIdx] ?? null;

  /* ---------- 初始化 ---------- */
  useEffect(() => {
    setPortalRoot(document.getElementById('compiler-dock-root'));
    const s = loadCpSettings();
    setCp(s);
    setLang(s.defaultLang);
    setMode(s.defaultMode);
    setPanelW(Number.isFinite(s.panelWidth) ? s.panelWidth : null);
    setConsoleH(Number.isFinite(s.consoleH) ? s.consoleH : null);
    // <900px 没有并排阅读空间：加载时不自动展开，用户手动点开才开；
    // ≥900px 尊重上次的展开偏好。不回写保存值，偏好保持原样
    setOpen(window.innerWidth >= 900 ? s.panelOpen : false);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    document.body.classList.toggle('compiler-open', open);
    return () => document.body.classList.remove('compiler-open');
  }, [open, mounted]);

  /* 拖拽过的宽度内联到 <html>（压过 :root 的 clamp 默认；null 时摘掉恢复默认） */
  useEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;
    if (panelW) root.style.setProperty('--compiler-w', `${Math.round(panelW)}px`);
    else root.style.removeProperty('--compiler-w');
    return () => root.style.removeProperty('--compiler-w');
  }, [panelW, mounted]);

  /* 视口变小后收过的结果区高度可能放不下，跟随窗口收缩（只改当前值不回写偏好） */
  useEffect(() => {
    if (!mounted) return;
    const clampH = (h) => Math.min(Math.max(h, MIN_CONSOLE_H), Math.max(MIN_CONSOLE_H, (panelRef.current?.clientHeight ?? window.innerHeight) - 240));
    const onResize = () => setConsoleH((h) => (h ? clampH(h) : h));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [mounted]);

  useEffect(() => {
    if (mounted) saveCpSettings({ panelOpen: open });
  }, [open, mounted]);

  /* 顶部「编译器」按钮（SiteHeader）经该事件开合面板 */
  useEffect(() => {
    if (!mounted) return;
    const onExternalToggle = () => setOpen((v) => !v);
    window.addEventListener('ysc-compiler-toggle', onExternalToggle);
    return () => window.removeEventListener('ysc-compiler-toggle', onExternalToggle);
  }, [mounted]);

  /* Ctrl/⌘+J 全局开关；Esc 收起（焦点在面板内时不抢，留给编辑器/补全） */
  useEffect(() => {
    if (!mounted) return;
    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (e.key === 'Escape' && !e.defaultPrevented && !document.getElementById('compiler-panel')?.contains(document.activeElement)) {
        setOpen((v) => (v ? false : v));
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [mounted]);

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

  /* ---------- 分栏拖拽 ----------
     宽度：拖面板左缘竖向手柄，改 <html> 的 --compiler-w（px）；结果区高度：
     拖编辑器下的横向手柄。都用 pointer 事件 + 文档级监听，拖拽期间给 body
     挂 compiler-resizing 禁用开合过渡与选中文本，松手才落盘偏好。
     双击手柄=恢复默认；聚焦后方向键微调（Shift=大步）。 */
  const maxPanelW = () => Math.max(MIN_PANEL_W, window.innerWidth - 280);
  const clampW = (w) => Math.min(Math.max(Math.round(w), MIN_PANEL_W), maxPanelW());
  const maxConsoleH = () => Math.max(MIN_CONSOLE_H, (panelRef.current?.clientHeight ?? window.innerHeight) - 240);
  const clampH = (h) => Math.min(Math.max(Math.round(h), MIN_CONSOLE_H), maxConsoleH());

  const beginWidthDrag = (e) => {
    if (e.button !== 0 || !open) return;
    e.preventDefault();
    const startX = e.clientX;
    // 起始值量现渲染宽度：panelW 为 null（跟随 CSS 默认）时也是对的
    const startW = panelRef.current?.getBoundingClientRect().width ?? 480;
    let latest = startW;
    setDragging('w');
    document.body.classList.add('compiler-resizing');
    const onMove = (ev) => {
      latest = clampW(startW + (startX - ev.clientX)); // 面板在右，左拖=加宽
      setPanelW(latest);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('compiler-resizing');
      setDragging(null);
      if (latest !== startW) saveCpSettings({ panelWidth: latest });
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  };

  const beginConsoleDrag = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = resultsRef.current?.getBoundingClientRect().height ?? 200;
    let latest = startH;
    setDragging('h');
    document.body.classList.add('compiler-resizing');
    const onMove = (ev) => {
      latest = clampH(startH + (startY - ev.clientY)); // 上拖=结果区加高
      setConsoleH(latest);
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      document.body.classList.remove('compiler-resizing');
      setDragging(null);
      if (latest !== startH) saveCpSettings({ consoleH: latest });
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  };

  const nudgeWidth = (d) => {
    const base = panelW ?? panelRef.current?.getBoundingClientRect().width ?? 480;
    const w = clampW(base + d);
    setPanelW(w);
    saveCpSettings({ panelWidth: w });
  };

  const nudgeConsoleH = (d) => {
    const base = consoleH ?? resultsRef.current?.getBoundingClientRect().height ?? 200;
    const h = clampH(base + d);
    setConsoleH(h);
    saveCpSettings({ consoleH: h });
  };

  const resetWidth = () => {
    setPanelW(null);
    saveCpSettings({ panelWidth: null });
  };

  const resetConsoleH = () => {
    setConsoleH(null);
    saveCpSettings({ consoleH: null });
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

  if (!mounted || !cp || !portalRoot) return null;

  const langAvailable = lang === 'cpp' ? available.cpp : available.python;
  const busy = runState !== 'idle';
  const passCount = cases.filter((c) => c.verdict === 'AC').length;

  return createPortal(
    <>
      {/* 右缘展开舌片：收起态入口；展开后由 globals.css 淡出（pointer-events:none） */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={open ? '收起编译器' : '展开编译器'}
        aria-controls="compiler-panel"
        aria-expanded={open}
        title="展开编译器（与题目并排各占一侧）"
        className="compiler-edge-tab"
      >
        <Terminal className="size-3.5" />
        <span className="edge-label">编译器</span>
        <ChevronRight className="size-3.5 rotate-180" />
      </button>

      <aside
        id="compiler-panel"
        ref={panelRef}
        className="compiler-box relative flex flex-col"
        aria-label="编译器面板"
        aria-hidden={!open}
        inert={!open}
      >
        {/* 左缘分栏拖拽手柄：改面板宽度（--compiler-w），双击恢复默认 */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整编译器面板宽度"
          title="拖动调整宽度，双击恢复默认"
          tabIndex={0}
          data-dragging={dragging === 'w' || undefined}
          onPointerDown={beginWidthDrag}
          onDoubleClick={resetWidth}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault();
              nudgeWidth(e.shiftKey ? -64 : -16);
            } else if (e.key === 'ArrowRight') {
              e.preventDefault();
              nudgeWidth(e.shiftKey ? 64 : 16);
            }
          }}
          className="compiler-resize-w"
        />

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
          <Button variant="ghost" size="icon" className="size-7" onClick={() => setOpen(false)} aria-label="收起编译器" title="收起编译器（Esc）">
            <X className="size-4" />
          </Button>
        </div>

        {/* 编辑器 */}
        <div className="relative min-h-[140px] flex-1">
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

        {/* 上下分栏拖拽手柄：改下方运行/检查区高度，双击恢复默认 */}
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整编辑器与运行区的高度"
          title="拖动调整高度，双击恢复默认"
          tabIndex={0}
          data-dragging={dragging === 'h' || undefined}
          onPointerDown={beginConsoleDrag}
          onDoubleClick={resetConsoleH}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              nudgeConsoleH(e.shiftKey ? -64 : -16);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              nudgeConsoleH(e.shiftKey ? 64 : 16);
            }
          }}
          className="compiler-resize-h"
        />

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

        {/* 结果区：拖过高度则锁定 px（编辑器 flex-1 吃剩余），否则维持 flex 比例 */}
        <div
          ref={resultsRef}
          className={`flex min-h-[9rem] flex-col overflow-hidden px-3 pb-3 pt-2 ${consoleH ? '' : 'flex-1 basis-1/3'}`}
          style={consoleH ? { flex: '0 0 auto', height: Math.round(consoleH) } : undefined}
        >
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
    </>,
    portalRoot,
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
