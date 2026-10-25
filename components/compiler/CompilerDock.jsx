"use client";

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
 *   移动端（MOBILE_QUERY 断点：手机竖屏 / 矮屏横屏）不并排：默认「覆盖切换」
 *   （面板 fixed 全屏从右滑入，× 关闭回题目来回切换），设置可改「上下分屏」
 *   （题目在上、编译器 fixed 底部，顶缘手柄拖 --split-h，偏好 mobileSplitH）。
 *   编程键盘（设置 mobileKeyboard 开启）显示在面板底部替代系统软键盘：
 *   Monaco inputarea inputmode=none 抑制系统键盘，键盘可临时收起（点编辑器恢复），
 *   键盘显示时结果区让位、编辑器最小高度压低。
 *   <900px 加载时不自动展开（并排空间太小），用户点名才开。
 *   收起后状态（草稿/控制台/结果）保留。
 * - 入口：右缘舌片（收起态）、顶部「编译器」按钮（经 ysc-compiler-toggle
 *   事件）、Ctrl/⌘+J；关闭：面板 ×、Esc（焦点在面板内时不抢编辑器的 Esc）、
 *   Ctrl/⌘+J。
 */

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ChevronRight,
  Keyboard,
  Play,
  RotateCcw,
  Square,
  Terminal,
  WrapText,
  X,
} from "lucide-react";
import { judgeCase, truncate } from "@/lib/compiler/diff";
import {
  loadCpSettings,
  saveCpSettings,
  loadDraft,
  saveDraft,
  clearDraft,
} from "@/lib/compiler/cp-settings";
import {
  clearSampleCases,
  defaultCasesFrom,
  loadSampleCases,
  saveSampleCases,
} from "@/lib/compiler/samples";
import {
  CPP_FILES,
  CPP_VERSION,
  PYODIDE_VERSIONS,
  pythonVersion,
} from "@/lib/compiler/runtimes";
import { hasRuntime } from "@/lib/compiler/runtime-cache";
import { CppClient } from "@/lib/compiler/cpp-client";
import { PyClient, isCrossOriginIsolated } from "@/lib/compiler/py-client";
import { useSettings } from "@/components/settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const CodeEditor = dynamic(() => import("./CodeEditor"), {
  ssr: false,
  loading: () => (
    <div className="grid h-full place-items-center text-xs text-muted-foreground">
      编辑器加载中…
    </div>
  ),
});

const CodeKeyboard = dynamic(() => import("./CodeKeyboard"), { ssr: false });

/* 移动端判定：手机竖屏（≤767px）或矮屏横屏（手机横握）。
   命中时编译器不再是并排分栏，而是覆盖切换（默认）或上下分屏（设置可选） */
const MOBILE_QUERY =
  "(max-width: 767.98px), (max-width: 920px) and (max-height: 500px)";

const LANGS = [
  { id: "cpp", label: "C++" },
  { id: "python", label: "Python" },
];
const MODES = [
  { id: "samples", label: "样例测试" },
  { id: "interactive", label: "交互运行" },
  { id: "check", label: "编译检查" },
];

const CONSOLE_CAP = 200 * 1024;

/* 拖拽边界：面板宽度最小 360px、最多吃到只剩 280px 左列（与 globals.css 的
   flex-basis min() 兜底一致）；结果区高度下限对齐 min-h-[9rem]，上限给编辑器
   留足 240px 顶部+最小编辑空间 */
const MIN_PANEL_W = 360;
const MIN_CONSOLE_H = 144;

export default function CompilerDock({ problems, day }) {
  const { openSettings } = useSettings();
  const [mounted, setMounted] = useState(false);
  const [cp, setCp] = useState(null); // 编译器偏好
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState("cpp");
  const [probIdx, setProbIdx] = useState(0);
  const [mode, setMode] = useState("samples");
  const [code, setCode] = useState("");
  const [runState, setRunState] = useState("idle"); // idle | running | waiting-input
  const [stage, setStage] = useState("");
  const [consoleText, setConsoleText] = useState("");
  const [cases, setCases] = useState([]); // [{index, verdict, actual, expected, diff, elapsedMs, note}]
  const [diags, setDiags] = useState([]);
  const [checkState, setCheckState] = useState(""); // 语法检查状态文案
  const [available, setAvailable] = useState({ cpp: false, python: false });
  const [inputLine, setInputLine] = useState("");
  const [completionStatus, setCompletionStatus] = useState(null);
  const [panelW, setPanelW] = useState(null); // 面板宽度（px），null = CSS clamp 默认
  const [consoleH, setConsoleH] = useState(null); // 结果区高度（px），null = flex 默认比例
  const [dragging, setDragging] = useState(null); // 'w' | 'h' | 's' | null（手柄视觉态）
  const [isMobile, setIsMobile] = useState(false); // 移动端断点（覆盖切换 / 上下分屏）
  const [kbHidden, setKbHidden] = useState(false); // 编程键盘临时收起（点编辑器恢复）
  const [sysKb, setSysKb] = useState(false); // 系统键盘手动开启（键盘右上角开关，输入法场景）
  const [toast, setToast] = useState(null); // Ctrl+S 保存提示浮窗文案（null=隐藏）
  const [splitH, setSplitH] = useState(null); // 分屏模式编译器高度（px），null = 50dvh
  // 样例管理：null = 未自定义（用题目默认样例），数组 = 用户编辑后的完整样例表
  const [sampleCases, setSampleCases] = useState(null);
  const [samplesOpen, setSamplesOpen] = useState(false); // 样例管理手风琴展开态
  const [dlInfo, setDlInfo] = useState(null); // 运行时下载进度 {name, got, total}

  const cppRef = useRef(null);
  const pyRef = useRef(null);
  const feedRef = useRef(null);
  const consoleRef = useRef(null);
  const panelRef = useRef(null); // aside 本体：宽度拖拽的起始测量 + 结果区上限
  const resultsRef = useRef(null); // 结果区：高度拖拽的起始测量
  const editorApiRef = useRef(null); // { editor, monaco }，CodeKeyboard 经它输入
  const pyOutRef = useRef(""); // 交互/样例期间收集的 Python stdout
  const runTokenRef = useRef(0); // 使乱序完成的旧运行失效
  const checkTimerRef = useRef(null);
  const toastTimerRef = useRef(null); // Ctrl+S 提示浮窗自动消失
  const codeRef = useRef(""); // 编辑器最新内容（Ctrl+S 下载/落盘用，不进 effect 依赖）
  const [portalRoot, setPortalRoot] = useState(null); // layout 顶层的 #compiler-dock-root

  const problem = problems?.[probIdx] ?? null;
  // 编程键盘可见：移动端 + 设置开启 + 面板展开 + 未被临时收起（点编辑器恢复）。
  // 需在早退 return 之前算好：系统键盘开关联动 effect 的依赖要用它
  const kbVisible = isMobile && !!cp?.mobileKeyboard && open && !kbHidden;

  /* ---------- 初始化 ---------- */
  useEffect(() => {
    setPortalRoot(document.getElementById("compiler-dock-root"));
    const s = loadCpSettings();
    setCp(s);
    setLang(s.defaultLang);
    setMode(s.defaultMode);
    setPanelW(Number.isFinite(s.panelWidth) ? s.panelWidth : null);
    setConsoleH(Number.isFinite(s.consoleH) ? s.consoleH : null);
    setSplitH(Number.isFinite(s.mobileSplitH) ? s.mobileSplitH : null);
    // <900px 没有并排阅读空间：加载时不自动展开，用户手动点开才开；
    // ≥900px 尊重上次的展开偏好。不回写保存值，偏好保持原样
    setOpen(window.innerWidth >= 900 ? s.panelOpen : false);
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!mounted) return;
    document.body.classList.toggle("compiler-open", open);
    return () => document.body.classList.remove("compiler-open");
  }, [open, mounted]);

  /* 移动端断点（matchMedia）：手机竖屏 / 矮屏横屏。覆盖切换与上下分屏都只在
     该断点生效，桌面端始终是文档流并排分栏 */
  useEffect(() => {
    const mq = window.matchMedia(MOBILE_QUERY);
    const upd = () => setIsMobile(mq.matches);
    upd();
    mq.addEventListener("change", upd);
    return () => mq.removeEventListener("change", upd);
  }, []);

  /* 移动端布局模式挂到 body：覆盖切换 / 上下分屏（设置 mobileLayout 可选）。
     关闭态也挂类——面板藏在屏幕外（translateX/Y 100% + pointer-events:none），
     开合才有滑入滑出过渡；退出移动断点（旋转到大屏）自动摘掉回并排分栏 */
  useEffect(() => {
    if (!mounted) return;
    const mode = !isMobile
      ? null
      : cp?.mobileLayout === "split"
        ? "split"
        : "cover";
    document.body.classList.toggle("compiler-cover-mode", mode === "cover");
    document.body.classList.toggle("compiler-split-mode", mode === "split");
    return () =>
      document.body.classList.remove(
        "compiler-cover-mode",
        "compiler-split-mode",
      );
  }, [isMobile, cp?.mobileLayout, mounted]);

  /* 分屏高度内联到 <html>（null = CSS 默认 50dvh） */
  useEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;
    if (splitH) root.style.setProperty("--split-h", `${Math.round(splitH)}px`);
    else root.style.removeProperty("--split-h");
    return () => root.style.removeProperty("--split-h");
  }, [splitH, mounted]);

  /* 编程键盘收起/面板关闭/设置关闭时，系统键盘手动开关一并复位；
     键盘（重新）展开时若编辑器还带着系统键盘焦点（点编辑器唤回键盘的场景），
     把焦点夺回来让系统键盘收回 */
  useEffect(() => {
    if (!kbVisible) {
      setSysKb(false);
      return;
    }
    const host = editorApiRef.current?.editor?.getDomNode?.();
    const active = document.activeElement;
    if (host && active && host.contains(active)) active.blur?.();
  }, [kbVisible]);

  /* 系统键盘手动开关（编程键盘右上角）：开启时聚焦编辑器弹出系统键盘
     （CodeEditor 的 effect 先一步解除 inputmode 抑制——子组件 effect 先于父组件
     执行），关闭时把焦点从编辑器夺回，系统键盘随之收回 */
  useEffect(() => {
    const editor = editorApiRef.current?.editor;
    const host = editor?.getDomNode?.();
    const active = document.activeElement;
    if (sysKb) {
      editor?.focus?.();
    } else if (host && active && host.contains(active)) {
      active.blur?.();
    }
  }, [sysKb]);

  const toggleSysKb = useCallback(() => setSysKb((v) => !v), []);
  const hideKb = useCallback(() => {
    // 收起键盘时把焦点移出编辑器（Monaco 无公开 blur；系统键盘跟着收回，
    // 之后点编辑器会触发 onDidFocusEditorText 自动唤回键盘）
    const host = editorApiRef.current?.editor?.getDomNode?.();
    const active = document.activeElement;
    if (host && active && host.contains(active)) active.blur?.();
    setKbHidden(true);
  }, []);

  /* 面板每次展开都把临时收起的编程键盘带回（准备写码） */
  useEffect(() => {
    if (open) setKbHidden(false);
  }, [open]);

  /* 设置弹窗改动编译器偏好后刷新本组件（mobileLayout / mobileKeyboard 即时生效） */
  useEffect(() => {
    if (!mounted) return;
    const reload = () => {
      const s = loadCpSettings();
      setCp(s);
      setSplitH(Number.isFinite(s.mobileSplitH) ? s.mobileSplitH : null);
    };
    window.addEventListener("ysc-cp-settings-changed", reload);
    return () => window.removeEventListener("ysc-cp-settings-changed", reload);
  }, [mounted]);

  /* 拖拽过的宽度内联到 <html>（压过 :root 的 clamp 默认；null 时摘掉恢复默认） */
  useEffect(() => {
    if (!mounted) return;
    const root = document.documentElement;
    if (panelW)
      root.style.setProperty("--compiler-w", `${Math.round(panelW)}px`);
    else root.style.removeProperty("--compiler-w");
    return () => root.style.removeProperty("--compiler-w");
  }, [panelW, mounted]);

  /* 视口变小后收过的结果区高度可能放不下，跟随窗口收缩（只改当前值不回写偏好） */
  useEffect(() => {
    if (!mounted) return;
    const clampH = (h) =>
      Math.min(
        Math.max(h, MIN_CONSOLE_H),
        Math.max(
          MIN_CONSOLE_H,
          (panelRef.current?.clientHeight ?? window.innerHeight) - 240,
        ),
      );
    const onResize = () => setConsoleH((h) => (h ? clampH(h) : h));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [mounted]);

  useEffect(() => {
    if (mounted) saveCpSettings({ panelOpen: open });
  }, [open, mounted]);

  /* 顶部「编译器」按钮（SiteHeader）经该事件开合面板 */
  useEffect(() => {
    if (!mounted) return;
    const onExternalToggle = () => setOpen((v) => !v);
    window.addEventListener("ysc-compiler-toggle", onExternalToggle);
    return () =>
      window.removeEventListener("ysc-compiler-toggle", onExternalToggle);
  }, [mounted]);

  /* Ctrl/⌘+J 全局开关；Esc 收起（焦点在面板内时不抢，留给编辑器/补全） */
  useEffect(() => {
    if (!mounted) return;
    const onKeyDown = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (
        e.key === "Escape" &&
        !e.defaultPrevented &&
        !document
          .getElementById("compiler-panel")
          ?.contains(document.activeElement)
      ) {
        setOpen((v) => (v ? false : v));
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mounted]);

  const refreshAvailability = useCallback(async () => {
    try {
      const [cppOk, pyOk] = await Promise.all([
        hasRuntime(CPP_FILES.map((f) => `/compiler/${f.name}`)),
        Promise.all(
          PYODIDE_VERSIONS.map((v) =>
            hasRuntime(v.files.map((f) => `${v.indexURL}${f}`)),
          ),
        ).then((r) => r.some(Boolean)),
      ]);
      setAvailable({ cpp: cppOk, python: pyOk });
    } catch {}
  }, []);

  useEffect(() => {
    if (!mounted) return;
    refreshAvailability();
    const onChange = () => refreshAvailability();
    window.addEventListener("ysc-runtime-changed", onChange);
    return () => window.removeEventListener("ysc-runtime-changed", onChange);
  }, [mounted, refreshAvailability]);

  /* ---------- 草稿与模板 ---------- */
  const effectiveCode = useCallback(
    (l = lang, i = probIdx) => {
      const key = problems[i]?.code;
      return loadDraft(key, l) ?? cp?.templates?.[l] ?? "";
    },
    [problems, lang, probIdx, cp],
  );

  useEffect(() => {
    if (mounted && cp) setCode(effectiveCode());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, cp && true, probIdx, lang]);

  useEffect(() => {
    if (!mounted || !cp) return;
    const t = setTimeout(
      () => saveDraft(problems[probIdx]?.code, lang, code),
      500,
    );
    return () => clearTimeout(t);
  }, [code, mounted, cp, probIdx, lang, problems]);

  /* ---------- 自定义样例（按题存储，null = 用题目默认） ---------- */
  // 切题时载入该题的自定义样例记录，并清掉上一题的对拍结果展示
  useEffect(() => {
    if (!mounted) return;
    setSampleCases(loadSampleCases(problems?.[probIdx]?.code));
    setCases([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, probIdx, problems]);

  // 编辑落盘（去抖）；sampleCases 为 null（未自定义）时不写
  useEffect(() => {
    if (!mounted || !sampleCases) return;
    const t = setTimeout(
      () => saveSampleCases(problems?.[probIdx]?.code, sampleCases),
      400,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sampleCases, mounted]);

  const resetToTemplate = () => {
    const tpl = cp?.templates?.[lang] ?? "";
    clearDraft(problems[probIdx]?.code, lang);
    setCode(tpl);
  };

  /* ---------- 样例编辑：首次编辑先把默认样例拷贝进可编辑列表 ---------- */
  const defaultSamples = defaultCasesFrom(problem?.examples);
  // 实际参与对拍的样例：自定义表优先，否则题目默认
  const effectiveSamples = sampleCases ?? defaultSamples;
  const samplesCustomized = sampleCases != null;

  const editSamples = (fn) => {
    setSampleCases((prev) => {
      const base = prev ?? defaultSamples;
      return fn(base.map((c) => ({ ...c })));
    });
  };
  const updateSample = (i, field, value) =>
    editSamples((list) => {
      if (list[i]) list[i] = { ...list[i], [field]: value };
      return list;
    });
  const addSample = () =>
    editSamples((list) => [...list, { input: "", output: "" }]);
  const removeSample = (i) => editSamples((list) => list.filter((_, j) => j !== i));
  const resetSamples = () => {
    clearSampleCases(problem?.code);
    setSampleCases(null);
  };

  /* ---------- Ctrl/⌘S 接管（设置 ctrlS）----------
     'save'（默认）：立即落盘草稿（平时 500ms 去抖）+ 提示浮窗；'download'：
     把当前代码下载成文件（文件名 = 题目日期_题号_HHMMSS.扩展名）；'off'：
     不监听，浏览器默认保存网页。仅面板展开时接管；document 捕获阶段监听
     在 Monaco keybinding 与浏览器默认行为之前拦下（preventDefault +
     stopPropagation）。 */
  codeRef.current = code;
  const flashToast = useCallback((text) => {
    setToast(text);
    clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 2200);
  }, []);

  const downloadCodeFile = useCallback(() => {
    const safeCode = (problems[probIdx]?.code ?? "problem").replace(
      /[^\w.-]+/g,
      "_",
    );
    const time = new Date().toTimeString().slice(0, 8).replace(/:/g, "");
    const name = `${day ?? "undated"}_${safeCode}_${time}.${
      lang === "python" ? "py" : "cpp"
    }`;
    const url = URL.createObjectURL(
      new Blob([codeRef.current], { type: "text/plain;charset=utf-8" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, [problems, probIdx, lang, day]);

  useEffect(() => {
    if (!mounted || !open || !cp || cp.ctrlS === "off") return;
    const onKey = (e) => {
      if (e.altKey || !(e.ctrlKey || e.metaKey)) return;
      if ((e.key ?? "").toLowerCase() !== "s") return;
      e.preventDefault();
      e.stopPropagation();
      if (cp.ctrlS === "download") {
        downloadCodeFile();
      } else {
        saveDraft(problems[probIdx]?.code, lang, codeRef.current);
        flashToast("代码已保存（本机草稿）");
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [
    mounted,
    open,
    cp,
    lang,
    probIdx,
    problems,
    downloadCodeFile,
    flashToast,
  ]);

  useEffect(() => () => clearTimeout(toastTimerRef.current), []);

  /* ---------- 格式化（CodeEditor 注册的 Monaco provider，主线程纯函数） ----------
     走 editor.action.formatDocument：一次编辑 = 一步 undo；无变化时 provider
     返回空编辑不留 undo 垃圾。Shift+Alt+F 在编辑器聚焦时也直接可用。 */
  const doFormat = useCallback(() => {
    const editor = editorApiRef.current?.editor;
    if (!editor) return;
    const before = editor.getValue();
    editor
      .getAction("editor.action.formatDocument")
      ?.run()
      .then(() => {
        flashToast(editor.getValue() === before ? "代码已是整洁状态" : "代码已格式化");
      })
      .catch(() => flashToast("格式化失败"));
  }, [flashToast]);

  /* ---------- 分栏拖拽 ----------
     宽度：拖面板左缘竖向手柄，改 <html> 的 --compiler-w（px）；结果区高度：
     拖编辑器下的横向手柄。都用 pointer 事件 + 文档级监听，拖拽期间给 body
     挂 compiler-resizing 禁用开合过渡与选中文本，松手才落盘偏好。
     双击手柄=恢复默认；聚焦后方向键微调（Shift=大步）。 */
  const maxPanelW = () => Math.max(MIN_PANEL_W, window.innerWidth - 280);
  const clampW = (w) =>
    Math.min(Math.max(Math.round(w), MIN_PANEL_W), maxPanelW());
  const maxConsoleH = () =>
    Math.max(
      MIN_CONSOLE_H,
      (panelRef.current?.clientHeight ?? window.innerHeight) - 240,
    );
  const clampH = (h) =>
    Math.min(Math.max(Math.round(h), MIN_CONSOLE_H), maxConsoleH());

  const beginWidthDrag = (e) => {
    if (e.button !== 0 || !open) return;
    e.preventDefault();
    const startX = e.clientX;
    // 起始值量现渲染宽度：panelW 为 null（跟随 CSS 默认）时也是对的
    const startW = panelRef.current?.getBoundingClientRect().width ?? 480;
    let latest = startW;
    setDragging("w");
    document.body.classList.add("compiler-resizing");
    const onMove = (ev) => {
      latest = clampW(startW + (startX - ev.clientX)); // 面板在右，左拖=加宽
      setPanelW(latest);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("compiler-resizing");
      setDragging(null);
      if (latest !== startW) saveCpSettings({ panelWidth: latest });
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };

  const beginConsoleDrag = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH = resultsRef.current?.getBoundingClientRect().height ?? 200;
    let latest = startH;
    setDragging("h");
    document.body.classList.add("compiler-resizing");
    const onMove = (ev) => {
      latest = clampH(startH + (startY - ev.clientY)); // 上拖=结果区加高
      setConsoleH(latest);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("compiler-resizing");
      setDragging(null);
      if (latest !== startH) saveCpSettings({ consoleH: latest });
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };

  /* ---------- 分屏模式拖拽（移动端上下分屏）：拖面板顶缘改 --split-h ---------- */
  const clampSplitH = (h) =>
    Math.min(Math.max(Math.round(h), 240), window.innerHeight - 220);
  const beginSplitDrag = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startY = e.clientY;
    const startH =
      panelRef.current?.getBoundingClientRect().height ??
      window.innerHeight * 0.5;
    let latest = startH;
    setDragging("s");
    document.body.classList.add("compiler-resizing");
    const onMove = (ev) => {
      latest = clampSplitH(startH + (startY - ev.clientY)); // 上拖=编译器加高
      setSplitH(latest);
    };
    const onUp = () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
      document.body.classList.remove("compiler-resizing");
      setDragging(null);
      if (latest !== startH) saveCpSettings({ mobileSplitH: latest });
    };
    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
  };
  const resetSplitH = () => {
    setSplitH(null);
    saveCpSettings({ mobileSplitH: null });
  };

  const nudgeWidth = (d) => {
    const base =
      panelW ?? panelRef.current?.getBoundingClientRect().width ?? 480;
    const w = clampW(base + d);
    setPanelW(w);
    saveCpSettings({ panelWidth: w });
  };

  const nudgeConsoleH = (d) => {
    const base =
      consoleH ?? resultsRef.current?.getBoundingClientRect().height ?? 200;
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
  // worker 初始化与 PCH 预热期产生的日志/下载进度没有请求 id，
  // 挂到客户端实例的全局兜底回调上（cpp-client 按无 id 消息路由到这里）
  const fmtDl = useCallback((dl) => {
    if (!dl?.name) return "";
    const got = (dl.got ?? 0) / 1048576;
    if (dl.total > 0) {
      return `下载 ${dl.name} ${Math.floor(((dl.got ?? 0) / dl.total) * 100)}%（${got.toFixed(1)}/${(dl.total / 1048576).toFixed(1)} MB）`;
    }
    return `下载 ${dl.name} ${got.toFixed(1)} MB`;
  }, []);

  const getCpp = () => {
    if (!cppRef.current) {
      const c = new CppClient();
      c.onLog = (t) => appendConsole(t);
      c.onProgress = (dl) => setDlInfo(dl);
      cppRef.current = c;
    }
    return cppRef.current;
  };
  const getPy = () => (pyRef.current ??= new PyClient());

  useEffect(
    () => () => {
      cppRef.current?.dispose();
      pyRef.current?.dispose();
    },
    [],
  );

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
    if (runState !== "idle") return;
    if (
      (lang === "cpp" && !available.cpp) ||
      (lang === "python" && !available.python)
    )
      return;
    clearTimeout(checkTimerRef.current);
    checkTimerRef.current = setTimeout(async () => {
      setCheckState("检查中…");
      try {
        if (lang === "cpp") {
          const { diagnostics } = await getCpp().check({
            source: code,
            std: cp.cppStd,
          });
          setDiags(diagnostics);
          setCheckState(
            diagnostics.some((d) => d.severity === "error")
              ? `发现 ${diagnostics.filter((d) => d.severity === "error").length} 个错误`
              : "语法检查通过",
          );
        } else {
          const { diagnostics } = await getPy().lint({
            code,
            versionId: cp.pythonVersion,
          });
          setDiags(diagnostics);
          setCheckState(
            diagnostics.length
              ? `发现 ${diagnostics.length} 个语法错误`
              : "语法检查通过",
          );
        }
      } catch (exn) {
        setCheckState(`检查失败：${exn.message}`);
      }
    }, 2000);
    return () => clearTimeout(checkTimerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    code,
    lang,
    mounted,
    cp && true,
    open,
    runState,
    available.cpp,
    available.python,
  ]);

  /* ---------- 运行 ---------- */
  const timeoutMs = (cp?.timeoutSec ?? 10) * 1000;

  // C++ 单例结果 → 展示卡片。展开顺序：...j 必须在 verdict 之前，
  // 否则 j.verdict 会把 trap/退出码推出的 RE 覆盖回去
  const mapCppResult = (sample, r) => {
    const j = judgeCase(sample?.output, r.stdout);
    const re = r.trap || r.exitCode !== 0;
    return {
      ...j,
      verdict: re ? "RE" : j.verdict,
      elapsedMs: r.elapsedMs,
      note: r.trap
        ? `运行时错误：${truncate(r.trap, 200)}`
        : r.exitCode !== 0
          ? `退出码 ${r.exitCode}`
          : null,
    };
  };

  const fmtSec = (ms) => `${(ms / 1000).toFixed(2)}s`;

  const runSamples = async () => {
    if (!problem) return;
    const token = ++runTokenRef.current;
    const samples = effectiveSamples;
    setRunState("running");
    setCases([]);
    setConsoleText("");
    setDiags([]);
    pyOutRef.current = "";
    if (!samples.length) {
      appendConsole(
        "该题没有样例数据：可展开「样例管理」添加自定义样例，或用「交互运行」自己喂输入。\n",
      );
      setRunState("idle");
      return;
    }
    appendConsole(
      `── 对拍 ${samples.length} 个样例（${lang === "cpp" ? `C++ · ${cp.cppStd}` : `Python · ${pythonVersion(cp.pythonVersion).label}`}）──\n`,
    );
    try {
      if (lang === "cpp") {
        const client = getCpp();
        const caseOf = (i, r) => ({ index: i, ...mapCppResult(samples[i], r) });
        const res = await client.runCases({
          source: code,
          std: cp.cppStd,
          stdins: samples.map((e) => e.input),
          timeoutMs: 30000 + samples.length * timeoutMs,
          onLog: appendConsole,
          onStage: (s) => {
            setStage(s);
            setDlInfo(null);
          },
          onProgress: (dl) => setDlInfo(dl),
          onCase: ({ index, total, result }) => {
            if (token !== runTokenRef.current) return;
            const c = caseOf(index, result);
            setCases((prev) => [...prev, c]);
            appendConsole(`样例 ${index + 1}/${total}: ${c.verdict}（${c.elapsedMs}ms）\n`);
          },
        });
        if (token !== runTokenRef.current) return;
        setCases(res.results.map((r, i) => caseOf(i, r)));
        const t = res.timings;
        if (t) {
          const lines = ["\n── 编译耗时明细 ──"];
          if (t.pch) {
            lines.push(
              `预编译头（bits/stdc++.h · ${t.pch.std}）: ${t.pch.builtNow ? `本次构建 ${fmtSec(t.pch.buildMs)}（一次性，之后秒级）` : "命中缓存"}`,
            );
          }
          lines.push(
            `clang 编译 ${fmtSec(t.compileMs)} · 链接 ${fmtSec(t.linkMs)} · wasm 实例化 ${fmtSec(t.moduleMs)} · 运行 ${res.results.length} 例 ${fmtSec(t.runMs)}`,
          );
          appendConsole(`${lines.join("\n")}\n`);
        }
        appendConsole(`\n编译一次，运行 ${res.results.length} 个样例完成。\n`);
      } else {
        const client = getPy();
        for (let i = 0; i < samples.length; i++) {
          if (token !== runTokenRef.current) return;
          setStage(`样例 ${i + 1}/${samples.length}`);
          appendConsole(`\n—— 样例 ${i + 1} ——\n`);
          pyOutRef.current = "";
          let res;
          try {
            res = await client.run({
              code,
              stdin: samples[i].input,
              versionId: cp.pythonVersion,
              timeoutMs,
              onOutput: (kind, text) => {
                if (kind === "out") pyOutRef.current += text;
                appendConsole(text);
              },
              onNeedInput: (feed) => {
                // 样例模式不该要输入；喂 EOF 防挂起
                feed?.("");
              },
            });
          } catch (exn) {
            if (token !== runTokenRef.current) return;
            setCases((prev) => [
              ...prev,
              {
                index: i,
                verdict: "TE",
                expected: "",
                actual: "",
                diff: null,
                note: exn.message,
              },
            ]);
            appendConsole(`样例 ${i + 1}/${samples.length}: TE\n`);
            continue;
          }
          if (token !== runTokenRef.current) return;
          const j = judgeCase(samples[i].output, pyOutRef.current);
          // 展开顺序同 C++ 路径：...j 在前，verdict 覆盖才生效
          const c = res.success
            ? { index: i, ...j, elapsedMs: res.elapsedMs }
            : {
                index: i,
                ...j,
                verdict: "RE",
                note: truncate(res.error, 600),
              };
          setCases((prev) => [...prev, c]);
          appendConsole(
            `样例 ${i + 1}/${samples.length}: ${c.verdict}${c.elapsedMs != null ? `（${c.elapsedMs}ms）` : ""}\n`,
          );
        }
      }
    } catch (exn) {
      if (token !== runTokenRef.current) return;
      appendConsole(`\n✗ ${exn.message}\n`);
      if (exn.error?.diagnostics) setDiags(exn.error.diagnostics);
    } finally {
      if (token === runTokenRef.current) {
        setRunState("idle");
        setStage("");
        setDlInfo(null);
      }
    }
  };

  const runInteractive = async () => {
    const token = ++runTokenRef.current;
    setRunState("running");
    setCases([]);
    setDiags([]);
    setConsoleText("");
    pyOutRef.current = "";
    appendConsole(
      `—— 交互运行（${lang === "cpp" ? "C++ · Clang 22" : `Python · ${pythonVersion(cp.pythonVersion).label}`}）——\n`,
    );
    const needInput = (feed) => {
      feedRef.current = feed;
      setRunState("waiting-input");
    };
    const onOutput = (kind, text) => {
      if (kind === "out") pyOutRef.current += text;
      appendConsole(text);
    };
    try {
      if (lang === "cpp") {
        if (!isCrossOriginIsolated()) {
          appendConsole(
            "\n⚠ 当前环境不支持交互输入（需要跨域隔离），程序将以空输入运行。固定输入请用「样例测试」模式。\n",
          );
        }
        const res = await getCpp().run({
          source: code,
          std: cp.cppStd,
          stdin: "",
          interactive: true,
          timeoutMs,
          onLog: appendConsole,
          onStage: (s) => {
            setStage(s);
            setDlInfo(null);
          },
          onProgress: (dl) => setDlInfo(dl),
          onNeedInput: needInput,
        });
        if (token !== runTokenRef.current) return;
        appendConsole(
          `\n程序结束（退出码 ${res.exitCode}${res.trap ? `，${truncate(res.trap, 160)}` : ""}，${(res.elapsedMs / 1000).toFixed(2)}s）\n`,
        );
      } else {
        const res = await getPy().run({
          code,
          stdin: "",
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
        setRunState("idle");
        setStage("");
        setDlInfo(null);
      }
    }
  };

  const runCheck = async () => {
    setRunState("running");
    setStage("检查中");
    setCheckState("检查中…");
    try {
      if (lang === "cpp") {
        const { diagnostics, all } = await getCpp().check({
          source: code,
          std: cp.cppStd,
          onLog: appendConsole,
        });
        setDiags(diagnostics);
        setConsoleText(
          all
            .filter((d) => d.severity === "error")
            .map((d) => `${d.file}:${d.line}:${d.col}: ${d.message}`)
            .join("\n") || "编译检查通过，没有发现错误。",
        );
        setCheckState(
          diagnostics.some((d) => d.severity === "error")
            ? `发现 ${diagnostics.filter((d) => d.severity === "error").length} 个错误`
            : "编译检查通过",
        );
      } else {
        const { diagnostics } = await getPy().lint({
          code,
          versionId: cp.pythonVersion,
        });
        setDiags(diagnostics);
        setConsoleText(
          diagnostics.map((d) => `第 ${d.line} 行: ${d.message}`).join("\n") ||
            "语法检查通过。",
        );
        setCheckState(
          diagnostics.length
            ? `发现 ${diagnostics.length} 个语法错误`
            : "语法检查通过",
        );
      }
    } catch (exn) {
      appendConsole(`✗ ${exn.message}\n`);
      setCheckState(`检查失败：${exn.message}`);
    } finally {
      setRunState("idle");
      setStage("");
    }
  };

  const doRun = () => {
    if (runState !== "idle") return;
    if (lang === "cpp" && !available.cpp) return openSettings();
    if (lang === "python" && !available.python) return openSettings();
    if (mode === "samples") runSamples();
    else if (mode === "interactive") runInteractive();
    else runCheck();
  };

  const stopRun = () => {
    runTokenRef.current++;
    (lang === "cpp" ? cppRef : pyRef).current?.stop();
    feedRef.current = null;
    setRunState("idle");
    setStage("");
    appendConsole("\n（已手动终止）\n");
  };

  const sendInput = () => {
    const line = inputLine;
    setInputLine("");
    appendConsole(`≫ ${line}\n`);
    feedRef.current?.(lang === "cpp" ? `${line}\n` : line);
    setRunState("running");
  };

  const sendEof = () => {
    setInputLine("");
    appendConsole("≪ EOF\n");
    feedRef.current?.("");
    setRunState("running");
  };

  if (!mounted || !cp || !portalRoot) return null;

  const langAvailable = lang === "cpp" ? available.cpp : available.python;
  const busy = runState !== "idle";
  const passCount = cases.filter((c) => c.verdict === "AC").length;
  // 移动端布局：'cover' 全屏覆盖来回切换 | 'split' 上下分屏 | null 桌面并排
  const mobileMode =
    isMobile && open ? (cp.mobileLayout === "split" ? "split" : "cover") : null;

  return (
    <>
      {/* 右缘展开舌片：收起态入口；展开后由 globals.css 淡出（pointer-events:none）。
          必须挂在 body 而不是 #compiler-dock-root 里：移动端关闭态的 track 带
          transform（translateX(100%) 藏到屏幕外），fixed 定位的子元素会被它当成
          包含块一起带出屏幕，收起态入口就消失了 */}
      {createPortal(
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={open ? "收起编译器" : "展开编译器"}
          aria-controls="compiler-panel"
          aria-expanded={open}
          title="展开编译器（与题目并排各占一侧）"
          className="compiler-edge-tab"
        >
          <Terminal className="size-3.5" />
          <span className="edge-label">编译器</span>
          <ChevronRight className="size-3.5 rotate-180" />
        </button>,
        document.body,
      )}

      {createPortal(
        <aside
          id="compiler-panel"
          ref={panelRef}
          className="compiler-box relative flex flex-col"
          aria-label="编译器面板"
          aria-hidden={!open}
          inert={!open}
        >
          {/* Ctrl+S 保存提示浮窗：面板顶部居中胶囊，常挂 DOM 走透明度过渡 */}
          <div
            className={`compiler-toast ${toast ? "compiler-toast-on" : ""}`}
            role="status"
            aria-live="polite"
          >
            {toast}
          </div>

          {/* 分屏模式顶缘手柄：拖动改编译器高度（--split-h），双击恢复 50dvh */}
          {mobileMode === "split" && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="拖动调整编译器分屏高度"
              title="拖动调整分屏高度，双击恢复默认"
              tabIndex={0}
              data-dragging={dragging === "s" || undefined}
              onPointerDown={beginSplitDrag}
              onDoubleClick={resetSplitH}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSplitH(
                    clampSplitH(
                      (splitH ??
                        panelRef.current?.getBoundingClientRect().height ??
                        window.innerHeight * 0.5) + (e.shiftKey ? -64 : -16),
                    ),
                  );
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSplitH(
                    clampSplitH(
                      (splitH ??
                        panelRef.current?.getBoundingClientRect().height ??
                        window.innerHeight * 0.5) + (e.shiftKey ? 64 : 16),
                    ),
                  );
                }
              }}
              className="compiler-resize-split"
            />
          )}

          {/* 左缘分栏拖拽手柄：改面板宽度（--compiler-w），双击恢复默认 */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="拖动调整编译器面板宽度"
            title="拖动调整宽度，双击恢复默认"
            tabIndex={0}
            data-dragging={dragging === "w" || undefined}
            onPointerDown={beginWidthDrag}
            onDoubleClick={resetWidth}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft") {
                e.preventDefault();
                nudgeWidth(e.shiftKey ? -64 : -16);
              } else if (e.key === "ArrowRight") {
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
                  className={`rounded px-2 py-0.5 text-xs transition-colors ${lang === l.id ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              onClick={() => setOpen(false)}
              aria-label="收起编译器"
              title="收起编译器（Esc）"
            >
              <X className="size-4" />
            </Button>
          </div>

          {/* 编辑器（编程键盘显示时压低最小高度给键盘让位） */}
          <div
            className={`relative flex-1 ${kbVisible ? "min-h-[84px]" : "min-h-[140px]"}`}
          >
            <CodeEditor
              language={lang}
              value={code}
              onChange={setCode}
              diagnostics={diags}
              theme={cp.editorTheme}
              getCppContext={() => ({
                complete: ({ source, line, col }) =>
                  getCpp().complete({ source, line, col, std: cp.cppStd }),
              })}
              onStatus={setCompletionStatus}
              onReady={(editor, monaco) => {
                editorApiRef.current = { editor, monaco };
              }}
              onFocused={() => setKbHidden(false)}
              suppressSoftKeyboard={kbVisible && !sysKb}
            />
          </div>

          {/* 上下分栏拖拽手柄：改下方运行/检查区高度，双击恢复默认（键盘显示时隐藏让位） */}
          {!kbVisible && (
            <div
              role="separator"
              aria-orientation="horizontal"
              aria-label="拖动调整编辑器与运行区的高度"
              title="拖动调整高度，双击恢复默认"
              tabIndex={0}
              data-dragging={dragging === "h" || undefined}
              onPointerDown={beginConsoleDrag}
              onDoubleClick={resetConsoleH}
              onKeyDown={(e) => {
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  nudgeConsoleH(e.shiftKey ? -64 : -16);
                } else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  nudgeConsoleH(e.shiftKey ? 64 : 16);
                }
              }}
              className="compiler-resize-h"
            />
          )}

          {/* 模式页签 + 操作行 */}
          <div className="flex items-center gap-2 border-t px-3 pt-2">
            <div className="flex rounded-md border p-0.5">
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => setMode(m.id)}
                  disabled={busy}
                  className={`rounded px-2 py-0.5 text-xs transition-colors disabled:opacity-50 ${mode === m.id ? "bg-secondary text-secondary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={resetToTemplate}
              aria-label="重置为模板"
              className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              title="重置为设置里的默认模板"
            >
              <RotateCcw className="size-3" />
              <span className="hidden md:inline">重置为模板</span>
            </button>
            <button
              type="button"
              onClick={doFormat}
              aria-label="格式化代码"
              className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              title="格式化代码（缩进与空格规范化，Shift+Alt+F 同效）"
            >
              <WrapText className="size-3" />
              <span className="hidden md:inline">格式化</span>
            </button>
            {/* 编程键盘被临时收起时的恢复入口：Monaco 0.57 用 EditContext 管
                焦点，收起后编辑器内部焦点状态不变，「再点编辑器」不触发聚焦
                事件，必须给一个显式按钮 */}
            {isMobile && !!cp.mobileKeyboard && kbHidden && (
              <button
                type="button"
                onClick={() => setKbHidden(false)}
                aria-label="显示编程键盘"
                title="显示编程键盘"
                className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                <Keyboard className="size-3" />
                键盘
              </button>
            )}
            <span className="ml-auto truncate text-[11px] text-muted-foreground">
              {completionStatus ??
                (dlInfo
                  ? fmtDl(dlInfo)
                  : checkState || stage || "")}
            </span>
            {busy ? (
              <Button
                variant="destructive"
                size="sm"
                className="h-7 gap-1 px-2.5"
                onClick={stopRun}
              >
                <Square className="size-3" />
                停止
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-7 gap-1 px-2.5"
                onClick={doRun}
                aria-label={mode === "check" ? "检查程序" : "运行程序"}
                title={
                  langAvailable ? "" : "尚未下载该语言运行时，点击前往设置"
                }
              >
                <Play className="size-3" />
                {mode === "check" ? "检查" : "运行"}
              </Button>
            )}
          </div>

          {/* 结果区：拖过高度则锁定 px（编辑器 flex-1 吃剩余），否则维持 flex 比例；编程键盘显示时整体让位 */}
          <div
            ref={resultsRef}
            data-results=""
            className={`flex min-h-[9rem] flex-col overflow-hidden px-3 pb-3 pt-2 ${consoleH ? "" : "flex-1 basis-1/3"} ${kbVisible ? "hidden" : ""}`}
            style={
              consoleH
                ? { flex: "0 0 auto", height: Math.round(consoleH) }
                : undefined
            }
          >
            {mode === "samples" && (
              <div className="flex min-h-0 flex-1 flex-col gap-2">
                {/* 样例管理：编辑默认样例 / 添加自定义样例（按题存本机）。
                    用按钮 + 条件面板而非 <details>：E2E 以 aside details 定位
                    对拍结果卡，多一个 details 会抢 .first() */}
                <div className="shrink-0 rounded-md border text-xs">
                  <button
                    type="button"
                    onClick={() => setSamplesOpen((v) => !v)}
                    aria-expanded={samplesOpen}
                    aria-controls="compiler-samples-panel"
                    className="flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left"
                  >
                    <span>{samplesOpen ? "▾" : "▸"} 样例管理</span>
                    <span className="text-muted-foreground">
                      （{effectiveSamples.length} 例）
                    </span>
                    {samplesCustomized && (
                      <Badge
                        variant="outline"
                        className="border-transparent bg-amber-600 px-1.5 text-[10px] text-white"
                      >
                        已自定义
                      </Badge>
                    )}
                    <span className="ml-auto truncate text-[10px] text-muted-foreground">
                      编辑输入 / 期望输出，运行即按此对拍
                    </span>
                  </button>
                  {samplesOpen && (
                    <div
                      id="compiler-samples-panel"
                      className="max-h-56 space-y-2 overflow-y-auto border-t px-2.5 py-2"
                    >
                      {(sampleCases ?? defaultSamples).map((c, i) => (
                        <div key={i} className="space-y-1 rounded border p-1.5">
                          <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                            <span>
                              样例 {i + 1}
                              {i >= defaultSamples.length && " · 自定义"}
                            </span>
                            <button
                              type="button"
                              onClick={() => removeSample(i)}
                              className="transition-colors hover:text-red-400"
                              aria-label={`删除样例 ${i + 1}`}
                            >
                              删除
                            </button>
                          </div>
                          <div className="grid grid-cols-2 gap-1.5">
                            <textarea
                              value={c.input}
                              onChange={(e) =>
                                updateSample(i, "input", e.target.value)
                              }
                              placeholder="输入"
                              aria-label={`样例 ${i + 1} 输入`}
                              spellCheck={false}
                              className="min-h-14 w-full resize-y rounded border bg-background p-1.5 font-mono text-[11px] outline-none focus:border-primary/60"
                            />
                            <textarea
                              value={c.output}
                              onChange={(e) =>
                                updateSample(i, "output", e.target.value)
                              }
                              placeholder="期望输出（可留空表示要求无输出）"
                              aria-label={`样例 ${i + 1} 期望输出`}
                              spellCheck={false}
                              className="min-h-14 w-full resize-y rounded border bg-background p-1.5 font-mono text-[11px] outline-none focus:border-primary/60"
                            />
                          </div>
                        </div>
                      ))}
                      <div className="flex items-center gap-3 pt-0.5">
                        <button
                          type="button"
                          onClick={addSample}
                          className="rounded border px-2 py-0.5 transition-colors hover:bg-secondary"
                        >
                          ＋ 添加样例
                        </button>
                        {samplesCustomized && (
                          <button
                            type="button"
                            onClick={resetSamples}
                            className="text-muted-foreground transition-colors hover:text-foreground"
                          >
                            恢复默认样例
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* 对拍结果 */}
                <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
                  {cases.length > 0 && (
                    <p className="text-xs text-muted-foreground">
                      通过 {passCount}/{cases.length}
                      {cases.length > 0 && (
                        <span className="ml-2">
                          耗时{" "}
                          {cases.reduce((a, c) => a + (c.elapsedMs ?? 0), 0)} ms
                        </span>
                      )}
                    </p>
                  )}
                  {cases.length === 0 && !busy && (
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      点击「运行」按样例逐例对拍（
                      {lang === "cpp"
                        ? "编译一次，多样例复用"
                        : "每例重置解释器"}
                      ）。样例可在上方「样例管理」里编辑或添加，需要自己喂输入调试请切「交互运行」。
                    </p>
                  )}
                  {cases.map((c) => (
                    <details
                      key={c.index}
                      className="rounded-md border text-xs"
                      open={c.verdict !== "AC"}
                    >
                      <summary className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5">
                        <Badge
                          variant="outline"
                          className={`border-transparent px-1.5 font-mono text-[10px] text-white ${
                            c.verdict === "AC"
                              ? "bg-emerald-600"
                              : c.verdict === "WA"
                                ? "bg-red-500"
                                : "bg-amber-600"
                          }`}
                        >
                          {c.verdict}
                        </Badge>
                        <span>样例 {c.index + 1}</span>
                        {c.index >= defaultSamples.length &&
                          samplesCustomized && (
                            <span className="text-[10px] text-muted-foreground">
                              自定义
                            </span>
                          )}
                        {c.elapsedMs != null && (
                          <span className="text-muted-foreground">
                            {c.elapsedMs}ms
                          </span>
                        )}
                        {c.diff && (
                          <span className="truncate text-muted-foreground">
                            第 {c.diff.line} 行不符：期望「
                            {truncate(c.diff.expected, 40)}」实际「
                            {truncate(c.diff.actual, 40)}」
                          </span>
                        )}
                      </summary>
                      <div className="space-y-1.5 border-t px-2.5 py-2 font-mono">
                        {c.note && <p className="text-amber-500">{c.note}</p>}
                        <SampleIO
                          label="输入"
                          text={effectiveSamples[c.index]?.input}
                        />
                        <SampleIO label="期望输出" text={c.expected} />
                        <SampleIO
                          label="实际输出"
                          text={c.actual}
                          bad={c.verdict !== "AC"}
                        />
                      </div>
                    </details>
                  ))}
                  {effectiveSamples.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      该题暂无样例数据，可在上方「样例管理」添加自定义样例。
                    </p>
                  )}
                </div>

                {/* 编译 / 运行日志（含耗时明细与逐例进度） */}
                <pre
                  ref={consoleRef}
                  aria-label="编译日志"
                  className="h-20 shrink-0 overflow-auto rounded-md border bg-background p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap"
                >
                  {consoleText ||
                    "点击「运行」后此处显示编译命令、逐例进度与耗时明细。\n"}
                </pre>
              </div>
            )}

            {(mode === "interactive" || mode === "check") && (
              <div className="flex min-h-0 flex-1 flex-col gap-2">
                <pre
                  ref={mode === "interactive" ? consoleRef : undefined}
                  aria-label="编译日志"
                  className="min-h-0 flex-1 overflow-auto rounded-md border bg-background p-2.5 font-mono text-xs leading-relaxed whitespace-pre-wrap"
                >
                  {consoleText ||
                    (mode === "interactive"
                      ? "点击「运行」启动程序；程序请求输入时会在下方出现输入框。\nstdin 为空时等价 EOF。\n"
                      : "点击「检查」运行完整编译检查（含万能头展开），结果同时标进编辑器。\n")}
                </pre>
                {mode === "interactive" && (
                  <div className="flex items-center gap-1.5">
                    <input
                      value={inputLine}
                      onChange={(e) => setInputLine(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && runState === "waiting-input")
                          sendInput();
                      }}
                      disabled={runState !== "waiting-input"}
                      placeholder={
                        runState === "waiting-input"
                          ? "程序正在等待输入…"
                          : runState === "running"
                            ? "程序运行中（输入缓冲仅交互模式）"
                            : "运行后此处可向程序喂输入"
                      }
                      className="min-w-0 flex-1 rounded-md border bg-background px-2.5 py-1.5 font-mono text-xs outline-none focus:border-primary/60 disabled:opacity-50"
                    />
                    <Button
                      size="sm"
                      variant="secondary"
                      className="h-7 px-2.5 text-xs"
                      disabled={runState !== "waiting-input"}
                      onClick={sendInput}
                    >
                      发送
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2 text-xs text-muted-foreground"
                      disabled={runState !== "waiting-input"}
                      onClick={sendEof}
                    >
                      EOF
                    </Button>
                  </div>
                )}
              </div>
            )}

            {!langAvailable && (
              <p className="mt-2 rounded-md border border-dashed px-2.5 py-1.5 text-[11px] leading-relaxed text-muted-foreground">
                {lang === "cpp" ? CPP_VERSION.label : "Pyodide"} 运行时未下载。{" "}
                <button
                  type="button"
                  onClick={openSettings}
                  className="text-primary underline-offset-2 hover:underline"
                >
                  打开设置下载
                </button>
                （C++ 运行时由本站同源自托管，约 150MB，下载后离线可用）
              </p>
            )}
          </div>

          {/* 移动端编程键盘：站内自绘，替代系统软键盘（设置「编程键盘」开启时显示；
            分屏模式用紧凑键高） */}
          {kbVisible && (
            <CodeKeyboard
              editorApi={editorApiRef}
              lang={lang}
              compact={mobileMode === "split"}
              sysKb={sysKb}
              onToggleSysKb={toggleSysKb}
              onHide={hideKb}
            />
          )}
        </aside>,
        portalRoot,
      )}
    </>
  );
}

function SampleIO({ label, text, bad }) {
  if (text == null) return null;
  return (
    <div>
      <p
        className={`mb-0.5 font-sans text-[10px] uppercase tracking-wide ${bad ? "text-red-400" : "text-muted-foreground"}`}
      >
        {label}
      </p>
      <pre className="max-h-32 overflow-auto rounded border bg-background p-1.5 whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  );
}
