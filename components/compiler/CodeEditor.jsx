'use client';

/**
 * Monaco 编辑器封装：C++/Python 高亮、诊断标记、静态 + clang 动态补全。
 *
 * Monaco 经 next/dynamic 按需加载（仅编译器面板打开时拉取 ~几百 KB chunk）。
 * editor.worker 走 webpack 的 new Worker(new URL(...)) 打包。诊断标记由父组件
 * 通过 ref 调 setDiagnostics() 注入（clang -fsyntax-only / py ast.parse）。
 *
 * C++ 动态补全只在显式触发（Ctrl+Space，TriggerKind=Invoke）时跑 clang
 * -code-completion-at（秒级延迟）；随手打字只出静态词表，避免每次击键编译。
 */

import { useEffect, useRef } from 'react';

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

const PY_KEYWORDS = [
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'None', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'True', 'False', 'try', 'while',
  'with', 'yield', 'match', 'case',
];
const PY_BUILTINS = [
  'print', 'input', 'int', 'float', 'str', 'bool', 'list', 'dict', 'set', 'tuple', 'len', 'range',
  'sum', 'min', 'max', 'abs', 'sorted', 'reversed', 'enumerate', 'zip', 'map', 'filter', 'any',
  'all', 'divmod', 'round', 'open', 'isinstance', 'hash', 'id', 'ord', 'chr', 'bin', 'hex', 'oct',
  'pow', 'bytes', 'frozenset', 'slice', 'format', 'getattr', 'setattr', 'hasattr', '__name__',
];
const PY_MODULES = [
  'sys', 'math', 'collections', 'itertools', 'functools', 'heapq', 'bisect', 'array', 're',
  'string', 'random', 'os', 'json', 'fractions', 'decimal', 'datetime', 'statistics', 'operator',
];

const CPP_KEYWORDS = [
  'alignas', 'alignof', 'and', 'asm', 'auto', 'bool', 'break', 'case', 'catch', 'char', 'class',
  'const', 'consteval', 'constexpr', 'constinit', 'const_cast', 'continue', 'co_await', 'co_return',
  'co_yield', 'decltype', 'default', 'delete', 'do', 'double', 'dynamic_cast', 'else', 'enum',
  'explicit', 'export', 'extern', 'false', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int',
  'long', 'mutable', 'namespace', 'new', 'noexcept', 'not', 'nullptr', 'operator', 'or', 'private',
  'protected', 'public', 'register', 'reinterpret_cast', 'requires', 'return', 'short', 'signed',
  'sizeof', 'static', 'static_assert', 'static_cast', 'struct', 'switch', 'template', 'this',
  'thread_local', 'throw', 'true', 'try', 'typedef', 'typeid', 'typename', 'union', 'unsigned',
  'using', 'virtual', 'void', 'volatile', 'wchar_t', 'while',
];
const CPP_STD = [
  'std::cout', 'std::cin', 'std::endl', 'std::string', 'std::vector', 'std::pair', 'std::map',
  'std::set', 'std::unordered_map', 'std::unordered_set', 'std::sort', 'std::max', 'std::min',
  'std::abs', 'std::swap', 'std::reverse', 'std::accumulate', 'std::queue', 'std::stack',
  'std::priority_queue', 'std::deque', 'std::array', 'std::tuple', 'std::make_pair', 'std::make_tuple',
  'std::getline', 'std::unique_ptr', 'std::function', 'std::size_t', 'std::gcd', 'std::lcm',
];

const CPP_SNIPPETS = [
  { label: 'main', detail: '代码骨架（万能头 + 快速 IO）', body: ['#include <bits/stdc++.h>', 'using namespace std;', '', 'int main() {', '    ios::sync_with_stdio(false);', '    cin.tie(nullptr);', '    ${1}', '    return 0;', '}'].join('\n') },
  { label: 'for0', detail: 'for (int i = 0; i < n; i++)', body: 'for (int ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n    ${3}\n}' },
  { label: 'forll', detail: 'for (ll i = 0; i < n; i++)', body: 'for (ll ${1:i} = 0; ${1:i} < ${2:n}; ${1:i}++) {\n    ${3}\n}' },
];
const PY_SNIPPETS = [
  { label: 'main', detail: '代码骨架', body: ['def main():', '    ${1}', '', '', 'if __name__ == "__main__":', '    main()'].join('\n') },
  { label: 'forr', detail: 'for i in range(n)', body: 'for ${1:i} in range(${2:n}):\n    ${3}' },
];

let providersRegistered = false;

function registerProviders(monaco, getCppContext) {
  if (providersRegistered || !monaco) return;
  providersRegistered = true;

  const staticItems = (mon, items, kind) =>
    items.map((label) => ({ label, kind: kind ?? mon.languages.CompletionItemKind.Keyword, insertText: label }));

  monaco.languages.registerCompletionItemProvider('python', {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const docTokens = new Set();
      for (const m of model.findMatches('[A-Za-z_][A-Za-z0-9_]*', true, true, false, null, false)) {
        docTokens.add(m.matches[0]);
      }
      const suggestions = [
        ...staticItems(monaco, PY_KEYWORDS, monaco.languages.CompletionItemKind.Keyword),
        ...staticItems(monaco, PY_BUILTINS, monaco.languages.CompletionItemKind.Function),
        ...staticItems(monaco, PY_MODULES, monaco.languages.CompletionItemKind.Module),
        ...[...docTokens]
          .filter((t) => t.length > 2 && !PY_KEYWORDS.includes(t))
          .map((t) => ({ label: t, kind: monaco.languages.CompletionItemKind.Text, insertText: t })),
        ...PY_SNIPPETS.map((s) => ({
          label: s.label,
          detail: s.detail,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: s.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        })),
      ];
      return { suggestions };
    },
  });

  monaco.languages.registerCompletionItemProvider('cpp', {
    triggerCharacters: [':', '>', '.', '<', '"', '#'],
    async provideCompletionItems(model, position, context) {
      const word = model.getWordUntilPosition(position);
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      const suggestions = [
        ...staticItems(monaco, CPP_KEYWORDS, monaco.languages.CompletionItemKind.Keyword),
        ...staticItems(monaco, CPP_STD, monaco.languages.CompletionItemKind.Class),
        ...CPP_SNIPPETS.map((s) => ({
          label: s.label,
          detail: s.detail,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: s.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        })),
      ];
      // 显式触发（Ctrl+Space）时叠加 clang -code-completion-at 真补全
      const ctx = getCppContext?.();
      if (ctx && context.triggerKind === monaco.languages.CompletionTriggerKind.Invoke) {
        try {
          ctx.onStatus?.('clang 补全中…');
          const items = await ctx.complete({
            source: model.getValue(),
            line: position.lineNumber,
            col: position.column,
          });
          for (const item of items) {
            const priority = /^(cout|cin|endl|size|push_back|begin|end|first|second)$/.test(item.name) ? '0' : '1';
            suggestions.unshift({
              label: item.name,
              detail: item.pattern,
              kind: monaco.languages.CompletionItemKind.Method,
              insertText: item.name,
              sortText: priority + item.name,
            });
          }
        } catch {
          // clang 补全失败静默回退静态表
        } finally {
          ctx.onStatus?.(null);
        }
      }
      return { suggestions };
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
      // 状态栏提示 clang 补全快捷键
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
