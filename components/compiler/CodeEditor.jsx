'use client';

/**
 * Monaco 编辑器封装：C++/Python 高亮、诊断标记、补全 / 签名提示 / 悬停文档。
 *
 * Monaco 经 next/dynamic 按需加载（仅编译器面板打开时拉取 ~几百 KB chunk）。
 * editor.worker 走 webpack 的 new Worker(new URL(...)) 打包。诊断标记由父组件
 * 通过 ref 调 setDiagnostics() 注入（clang -fsyntax-only / py ast.parse）。
 *
 * 补全分层（参考 VS Code 的体验）：
 *  - 打字即弹静态表（裸名 + 签名 + 文档，0ms，覆盖竞赛常用符号）
 *  - `.`/`->`/`::` 成员访问与 `#include <` 头文件：静态表即时出；成员场景同时
 *    异步跑 clang -code-completion-at 补精确项（秒级，过期结果按序号丢弃）
 *  - Ctrl+Space：手动触发的 clang 全量补全（keydown 打标，与打字母的自动
 *    Invoke 区分开——Monaco 两种场景的 triggerKind 相同，必须自己区分，
 *    否则每次击键都会触发一次全量编译）
 *  - `(`/`,` 触发 signature help（参数高亮），悬停显示原型文档
 *
 * 补全数据与纯函数在 lib/compiler/completions.js（node/浏览器同源，可单测）。
 */

import { useEffect, useRef } from 'react';
import {
  CPP_FUNCTIONS, CPP_TYPES, CPP_OBJECTS, CPP_MEMBERS, CPP_HEADERS, CPP_KEYWORDS, CPP_SNIPPETS,
  PY_FUNCTIONS, PY_MEMBER_TABLES, PY_TYPE_MEMBERS, PY_KEYWORDS, PY_SNIPPETS,
  toSuggestion, keywordSuggestion, lookupSignature, splitSignatureParams,
  includeContext, cppAccessKind, pyPrefixPath,
} from '../../lib/compiler/completions.js';

let monacoPromise = null;

function loadMonaco() {
  if (!monacoPromise) {
    self.MonacoEnvironment = {
      getWorker() {
        // 相对 node_modules 的路径：webpack 会把 worker 连同依赖打成独立 chunk
        // （monaco 0.57 的 exports 把子路径全部映射进 esm/vs，裸包名进 new URL
        //  解析不到，必须写相对文件路径）。
        return new Worker(
          new URL('../../node_modules/monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
          { type: 'module' },
        );
      },
    };
    monacoPromise = import('monaco-editor').then((monaco) => {
      monaco.editor.defineTheme('ys-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': '#1d1d22',
          'editorGutter.background': '#1d1d22',
          'editor.lineHighlightBackground': '#ffffff0d',
          'editorLineNumber.foreground': '#6b6b74',
          'editor.selectionBackground': '#3b3b4d',
        },
      });
      return monaco;
    });
  }
  return monacoPromise;
}

/** 文档内已有标识符作低优先级补全（ excludes 关键词）。 */
function docTokenSuggestions(mon, model, exclude) {
  const seen = new Set();
  const out = [];
  // captureMatches 必须 true：false 时 FindMatch.matches 是 null（取 [0] 即抛）
  for (const m of model.findMatches('[A-Za-z_][A-Za-z0-9_]*', true, true, false, null, true)) {
    const t = m.matches[0];
    if (t.length > 2 && !exclude.has(t) && !seen.has(t)) {
      seen.add(t);
      out.push({ label: t, kind: mon.languages.CompletionItemKind.Text, insertText: t, sortText: `3${t}` });
    }
  }
  return out;
}

/** 由签名文本组 Monaco SignatureInformation（参数 label 必须是 label 的子串）。 */
function toSignatureInfo(hit, lang) {
  const { namePart, params, endPart } = splitSignatureParams(hit.match.signature);
  const label = endPart
    ? namePart + params.map((p) => p.label).join(', ') + endPart
    : hit.match.signature;
  return {
    label,
    parameters: params.map((p) => ({ label: p.label })),
    documentation: hit.match.doc ? { value: hit.match.doc } : undefined,
    _lang: lang,
  };
}

/** clang 补全项（{name, pattern}）以最高优先级并入建议列表。 */
function mergeClangItems(suggestions, items, kind, range) {
  for (const item of items) {
    suggestions.unshift({
      label: item.name,
      detail: item.pattern ?? '',
      documentation: item.pattern ? { value: '```cpp\n' + item.pattern + '\n```' } : undefined,
      kind,
      range,
      insertText: item.name,
      sortText: `0${item.name}`,
    });
  }
}

let providersRegistered = false;
// clang 补全竞态序号：慢请求返回时序号已变则丢弃（Monaco 不会替我们取消）
let clangCompleteSeq = 0;
// 最近一次 clang 成员补全缓存：key 是触发时的「光标前全文」。后台跑完后
// 不刷新已开的 widget（Monaco 0.57 无可靠公开机制，hide+triggerSuggest 互踩），
// 由后续成员上下文里的击键按前缀命中缓存同步合并
let clangCache = { key: null, items: null };

function registerProviders(monaco, getCppContext) {
  if (providersRegistered || !monaco) return;
  providersRegistered = true;
  const K = monaco.languages.CompletionItemKind;
  const Invoke = monaco.languages.CompletionTriggerKind.Invoke;
  const TriggerCharacter = monaco.languages.CompletionTriggerKind.TriggerCharacter;

  const wordRange = (model, position) => {
    const word = model.getWordUntilPosition(position);
    return {
      startLineNumber: position.lineNumber,
      endLineNumber: position.lineNumber,
      startColumn: word.startColumn,
      endColumn: word.endColumn,
    };
  };
  const lineBefore = (model, position) =>
    model.getLineContent(position.lineNumber).slice(0, position.column - 1);

  /* ---------------- C++ ---------------- */

  monaco.languages.registerCompletionItemProvider('cpp', {
    triggerCharacters: ['.', '>', ':', '<', '"'],
    async provideCompletionItems(model, position, context) {
      const range = wordRange(model, position);
      const lineText = model.getLineContent(position.lineNumber);
      const suggestions = [];
      const inc = includeContext(lineText);
      const word = model.getWordUntilPosition(position);

      // #include 头文件补全：刚敲 < / "（word 为空）插入时自动补闭合符，
      // 继续打字过滤时不带闭合（用户自己收尾）
      if (inc) {
        const autoClose = !word.word && Boolean(context.triggerCharacter);
        const close = inc === '<' ? '>' : '"';
        return {
          suggestions: CPP_HEADERS.map((h) => ({
            label: h,
            kind: K.Module,
            detail: '头文件',
            range,
            insertText: autoClose ? h + close : h,
            sortText: `0${h}`,
          })),
        };
      }
      // `<<` / 比较号等非 include 场景的 < 不弹窗
      if (context.triggerCharacter === '<' || context.triggerCharacter === '"') {
        return { suggestions: [] };
      }

      // 成员访问分三态：`.`/`->` 出通用成员表；`::`（std:: 等）出全量 std
      // 符号——不带 using namespace std 的写法在作用域里也要能补 sort
      const access = cppAccessKind(lineText, position.column);
      if (access === 'scope') {
        for (const f of CPP_FUNCTIONS) suggestions.push(toSuggestion(monaco, f, K.Function, { sortBoost: '1', range }));
        for (const t of CPP_TYPES) suggestions.push(toSuggestion(monaco, t, K.Class, { sortBoost: '1', range }));
        for (const o of CPP_OBJECTS) suggestions.push(toSuggestion(monaco, o, K.Variable, { sortBoost: '1', range }));
        for (const m of CPP_MEMBERS) suggestions.push(toSuggestion(monaco, m, K.Method, { sortBoost: '2', range }));
      } else if (access) {
        for (const m of CPP_MEMBERS) suggestions.push(toSuggestion(monaco, m, K.Method, { sortBoost: '2', range }));
      } else {
        for (const k of CPP_KEYWORDS) suggestions.push(keywordSuggestion(monaco, k, range));
        for (const f of CPP_FUNCTIONS) suggestions.push(toSuggestion(monaco, f, K.Function, { sortBoost: '1', range }));
        for (const t of CPP_TYPES) suggestions.push(toSuggestion(monaco, t, K.Class, { sortBoost: '1', range }));
        for (const o of CPP_OBJECTS) suggestions.push(toSuggestion(monaco, o, K.Variable, { sortBoost: '1', range }));
        suggestions.push(...docTokenSuggestions(monaco, model, new Set(CPP_KEYWORDS)));
        for (const s of CPP_SNIPPETS) {
          suggestions.push({
            label: s.label,
            detail: s.detail,
            kind: K.Snippet,
            range,
            insertText: s.body,
            insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
            sortText: `4${s.label}`,
          });
        }
      }

      // clang -code-completion-at 分层（单次 provider 调用无法两段返回，
      // 静态表不能被秒级编译拖住）：
      //  - Ctrl+Space 手动触发：await clang（用户明确要求，等待合理）
      //  - 成员访问：静态表立即返回；触发字符（`.`/`->`/`::`）那一下后台跑
      //    clang，完成后只写缓存（刷新已开 widget 不可行，见上）。后续成员
      //    上下文里的击键按前缀命中缓存合并，不再逐键发起编译
      //  - 打字母的自动 Invoke 不跑 clang（每次击键全量编译代价秒级）
      //  注意打字母与手动触发的 triggerKind 相同（实测都是 Invoke），手动
      //  靠 keydown 打标区分
      const ctx = getCppContext?.();
      if (ctx) {
        const manual = ctx.consumeManualInvoke?.();
        const before = model.getValueInRange({
          startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column,
        });
        const hitCache = clangCache.items && before.startsWith(clangCache.key);
        if (manual) {
          const seq = ++clangCompleteSeq;
          try {
            ctx.onStatus?.('clang 补全中…');
            const items = await ctx.complete({ source: model.getValue(), line: position.lineNumber, col: position.column });
            if (seq !== clangCompleteSeq) return { suggestions };
            clangCache = { key: before, items };
            mergeClangItems(suggestions, items, K.Method, range);
          } catch {
            // clang 补全失败静默回退静态表
          } finally {
            ctx.onStatus?.(null);
          }
        } else if (access && hitCache) {
          mergeClangItems(suggestions, clangCache.items, K.Method, range);
        } else if (access && context.triggerKind === TriggerCharacter) {
          // 后台跑：不阻塞本次返回；期间有新输入/新请求（seq 变化）则丢弃
          const seq = ++clangCompleteSeq;
          const source = model.getValue();
          const { lineNumber, column } = position;
          ctx.complete({ source, line: lineNumber, col: column })
            .then((items) => {
              if (seq !== clangCompleteSeq) return;
              clangCache = { key: before, items };
            })
            .catch(() => {})
            .finally(() => ctx.onStatus?.(null));
          ctx.onStatus?.('clang 成员补全中…');
        }
      }
      return { suggestions };
    },
  });

  monaco.languages.registerSignatureHelpProvider('cpp', {
    signatureHelpTriggerCharacters: ['(', ','],
    provideSignatureHelp(model, position) {
      const text = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      const hit = lookupSignature(text, [CPP_FUNCTIONS], [CPP_MEMBERS]);
      if (!hit) return null;
      const info = toSignatureInfo(hit, 'cpp');
      return {
        value: {
          signatures: [info],
          activeSignature: 0,
          activeParameter: Math.min(hit.activeParameter, Math.max(0, info.parameters.length - 1)),
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerHoverProvider('cpp', {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const item = [...CPP_FUNCTIONS, ...CPP_TYPES, ...CPP_OBJECTS, ...CPP_MEMBERS].find((x) => x.label === word.word);
      if (!item) return null;
      const md = (item.signature ? '```cpp\n' + item.signature + '\n```\n' : '') + (item.doc ?? '');
      return { contents: [{ value: md }] };
    },
  });

  /* ---------------- Python ---------------- */

  monaco.languages.registerCompletionItemProvider('python', {
    triggerCharacters: ['.'],
    provideCompletionItems(model, position) {
      const range = wordRange(model, position);
      const lineText = model.getLineContent(position.lineNumber);
      const path = pyPrefixPath(lineText, range.startColumn);
      const prev = lineText[range.startColumn - 2];

      // 模块成员：heapq.|sys.|...
      if (path && PY_MEMBER_TABLES[path]) {
        return { suggestions: PY_MEMBER_TABLES[path].map((m) => toSuggestion(monaco, m, K.Method, { sortBoost: '0', lang: 'python', range })) };
      }
      // 变量成员：str/list/dict/set 方法并集兜底（精确类型推断需要 Jedi，静态并集够竞赛用）
      if (prev === '.') {
        return { suggestions: PY_TYPE_MEMBERS.map((m) => toSuggestion(monaco, m, K.Method, { sortBoost: '1', lang: 'python', range })) };
      }

      const keywords = new Set(PY_KEYWORDS);
      const suggestions = [
        ...PY_KEYWORDS.map((k) => keywordSuggestion(monaco, k, range)),
        ...PY_FUNCTIONS.map((f) => toSuggestion(monaco, f, K.Function, { sortBoost: '1', lang: 'python', range })),
        ...docTokenSuggestions(monaco, model, keywords),
        ...PY_SNIPPETS.map((s) => ({
          label: s.label,
          detail: s.detail,
          kind: K.Snippet,
          range,
          insertText: s.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          sortText: `4${s.label}`,
        })),
      ];
      return { suggestions };
    },
  });

  monaco.languages.registerSignatureHelpProvider('python', {
    signatureHelpTriggerCharacters: ['(', ','],
    provideSignatureHelp(model, position) {
      const text = model.getValueInRange({ startLineNumber: 1, startColumn: 1, endLineNumber: position.lineNumber, endColumn: position.column });
      const hit = lookupSignature(text, [PY_FUNCTIONS], [...Object.values(PY_MEMBER_TABLES), PY_TYPE_MEMBERS]);
      if (!hit) return null;
      const info = toSignatureInfo(hit, 'python');
      return {
        value: {
          signatures: [info],
          activeSignature: 0,
          activeParameter: Math.min(hit.activeParameter, Math.max(0, info.parameters.length - 1)),
        },
        dispose() {},
      };
    },
  });

  monaco.languages.registerHoverProvider('python', {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const lineText = model.getLineContent(position.lineNumber);
      const path = pyPrefixPath(lineText, word.startColumn);
      let item = null;
      if (path && PY_MEMBER_TABLES[path]) {
        item = PY_MEMBER_TABLES[path].find((x) => x.label === word.word);
      } else {
        item = PY_FUNCTIONS.find((x) => x.label === word.word);
        if (!item) item = PY_TYPE_MEMBERS.find((x) => x.label === word.word);
      }
      if (!item) return null;
      const md = (item.signature ? '```python\n' + item.signature + '\n```\n' : '') + (item.doc ?? '');
      return { contents: [{ value: md }] };
    },
  });
}

/**
 * @param {object} props
 * @param {string} props.language 'cpp' | 'python'
 * @param {string} props.value
 * @param {(v: string) => void} props.onChange
 * @param {Array<{line:number,col:number,endLine?:number,endCol?:number,severity:string,message:string}>} props.diagnostics
 * @param {() => object|null} props.getCppContext clang 补全上下文（可选）
 */
export default function CodeEditor({ language, value, onChange, diagnostics = [], getCppContext, onStatus }) {
  const hostRef = useRef(null);
  const editorRef = useRef(null);
  const monacoRef = useRef(null);
  // 手动 clang 补全标记：Ctrl/Cmd+Space 的 keydown 置位，provider 的 Invoke 消费。
  // Monaco 里「打字母自动弹补全」与「手动触发」的 triggerKind 相同（都是 Invoke），
  // 不区分的话每次击键都会跑一次秒级全量编译。
  const manualInvokeRef = useRef(false);
  const stateRef = useRef({ language, onChange, getCppContext, onStatus });
  stateRef.current = { language, onChange, getCppContext, onStatus };

  useEffect(() => {
    let disposed = false;
    let editor = null;
    loadMonaco().then((monaco) => {
      if (disposed || !hostRef.current) return;
      registerProviders(monaco, () => {
        const s = stateRef.current;
        return s.language === 'cpp'
          ? {
              complete: (p) => s.getCppContext?.().complete(p),
              onStatus: (t) => s.onStatus?.(t),
              consumeManualInvoke: () => {
                const v = manualInvokeRef.current;
                manualInvokeRef.current = false;
                return v;
              },
            }
          : null;
      });
      editor = monaco.editor.create(hostRef.current, {
        value,
        language: language === 'python' ? 'python' : 'cpp',
        theme: 'ys-dark',
        automaticLayout: true,
        fontSize: 13,
        lineHeight: 20,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 4,
        insertSpaces: true,
        // Monaco 0.57 默认 quickSuggestions=offWhenInlineCompletions（实测不弹），
        // 必须 显式开启字母自动补全
        quickSuggestions: { other: 'on', comments: false, strings: false },
        renderLineHighlight: 'line',
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        padding: { top: 10, bottom: 10 },
        fixedOverflowWidgets: true,
      });
      editorRef.current = editor;
      monacoRef.current = monaco;
      // 自动化/测试钩子：E2E 用它做免焦点的代码注入（Monaco 点击聚焦在
      // headless 下不稳定，曾导致 Ctrl+A 选中整页、运行了旧代码）
      if (typeof window !== 'undefined') window.__ysMonaco = { editor, monaco };
      editor.onDidChangeModelContent(() => {
        stateRef.current.onChange?.(editor.getValue());
      });
      // Ctrl/Cmd+Space → 手动触发 clang 补全：keydown 打标 + triggerSuggest。
      // 普通打字的自动补全不消费该标记，只出静态表
      editor.onKeyDown((e) => {
        if (e.keyCode === monaco.KeyCode.Space && (e.ctrlKey || e.metaKey)) {
          manualInvokeRef.current = true;
        }
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, () => {
        editor.trigger('keyboard', 'editor.action.triggerSuggest', null);
      });
    });
    return () => {
      disposed = true;
      editor?.dispose();
      editorRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 语言切换：换 model（保留 undo 栈分离）
  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = monaco.editor.createModel(value, language === 'python' ? 'python' : 'cpp');
    editor.setModel(model);
    const disp = model.onDidChangeContent(() => stateRef.current.onChange?.(model.getValue()));
    return () => {
      disp.dispose();
      model.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language]);

  // 诊断标记
  useEffect(() => {
    const monaco = monacoRef.current;
    const editor = editorRef.current;
    if (!monaco || !editor) return;
    const model = editor.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      'compiler',
      diagnostics.map((d) => ({
        startLineNumber: d.line,
        startColumn: Math.max(1, (d.col ?? 0) + 1),
        endLineNumber: d.endLine ?? d.line,
        endColumn: Math.max(2, (d.endCol ?? (d.col ?? 0) + 1) + 1),
        message: d.message,
        severity:
          d.severity === 'error'
            ? monaco.MarkerSeverity.Error
            : d.severity === 'warning'
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
        source: d.severity === 'syntax' ? 'python' : 'clang',
      })),
    );
  }, [diagnostics]);

  // 外部值同步（重置为模板等）
  useEffect(() => {
    const editor = editorRef.current;
    if (editor && editor.getValue() !== value) editor.setValue(value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return <div ref={hostRef} className="compiler-editor-host h-full w-full" aria-label="代码编辑器" />;
}
