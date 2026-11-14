/**
 * Monaco 编辑器主题清单（node/浏览器同源，纯数据）。
 *
 * 每个主题 = Monaco defineTheme 的 { base, inherit, rules, colors } + 展示名。
 * token 规则覆盖 C++ 与 Python 共用的 tokenizer 分类（keyword / string / number /
 * comment / type / delimiter 等），同名 .cpp / .python 后缀的规则继承通用规则，
 * 所以只写通用 token 名即可同时作用于两种语言。
 *
 * 配色来源：各主题的官方社区配色（One Dark / Dracula / Monokai / GitHub /
 * Solarized），编辑器区以外的面板仍是站点配色——这里只管 Monaco 画布。
 */

/** 便捷构造：同一组 token 色同时给通用与 .cpp/.python 变体不需要——Monaco 的
    tokenizer 输出形如 "keyword.cpp"，通用规则 "keyword" 可匹配（token 前缀匹配）。 */
function theme(id, label, base, colors, tokens) {
  const rules = Object.entries(tokens).map(([token, setting]) => {
    const [foreground, fontStyle] = Array.isArray(setting) ? setting : [setting];
    return { token, foreground, ...(fontStyle ? { fontStyle } : {}) };
  });
  return { id, label, base, inherit: true, rules, colors };
}

export const EDITOR_THEMES = [
  theme(
    "ys-dark",
    "站点暗色（默认）",
    "vs-dark",
    {
      "editor.background": "#1d1d22",
      "editorGutter.background": "#1d1d22",
      "editor.lineHighlightBackground": "#ffffff0d",
      "editorLineNumber.foreground": "#6b6b74",
      "editorLineNumber.activeForeground": "#a5a5b5",
      "editor.selectionBackground": "#3b3b4d",
      "editorCursor.foreground": "#c8c8d4",
      "editorIndentGuide.background1": "#2e2e38",
      "editorIndentGuide.activeBackground1": "#4a4a5a",
    },
    {
      keyword: "c792ea",
      number: "f78c6c",
      string: "c3e88d",
      comment: "6b7394",
      type: "ffcb6b",
      identifier: "e6e4f2",
      delimiter: "89a4d4",
    },
  ),
  theme(
    "one-dark",
    "One Dark",
    "vs-dark",
    {
      "editor.background": "#282c34",
      "editorGutter.background": "#282c34",
      "editor.lineHighlightBackground": "#2c313c",
      "editorLineNumber.foreground": "#495162",
      "editorLineNumber.activeForeground": "#828997",
      "editor.selectionBackground": "#3e4451",
      "editorCursor.foreground": "#528bff",
      "editorIndentGuide.background1": "#3b4048",
      "editorIndentGuide.activeBackground1": "#5c6370",
      "editorWidget.background": "#21252b",
      "editorSuggestWidget.background": "#21252b",
      "editorHoverWidget.background": "#21252b",
    },
    {
      keyword: "c678dd",
      number: "d19a66",
      string: "98c379",
      comment: ["5c6370", "italic"],
      type: "e5c07b",
      identifier: "e06c75",
      "identifier.function": "61afef",
      delimiter: "abb2bf",
      operator: "56b6c2",
    },
  ),
  theme(
    "dracula",
    "Dracula",
    "vs-dark",
    {
      "editor.background": "#282a36",
      "editorGutter.background": "#282a36",
      "editor.lineHighlightBackground": "#313342",
      "editorLineNumber.foreground": "#6272a4",
      "editorLineNumber.activeForeground": "#f8f8f2",
      "editor.selectionBackground": "#44475a",
      "editorCursor.foreground": "#f8f8f0",
      "editorIndentGuide.background1": "#3b3d4c",
      "editorIndentGuide.activeBackground1": "#6272a4",
      "editorWidget.background": "#21222c",
      "editorSuggestWidget.background": "#21222c",
      "editorHoverWidget.background": "#21222c",
    },
    {
      keyword: "ff79c6",
      number: "bd93f9",
      string: "f1fa8c",
      comment: ["6272a4", "italic"],
      type: "8be9fd",
      identifier: "f8f8f2",
      "identifier.function": "50fa7b",
      delimiter: "f8f8f2",
      operator: "ff79c6",
    },
  ),
  theme(
    "monokai",
    "Monokai",
    "vs-dark",
    {
      "editor.background": "#272822",
      "editorGutter.background": "#272822",
      "editor.lineHighlightBackground": "#3e3d32",
      "editorLineNumber.foreground": "#90908a",
      "editorLineNumber.activeForeground": "#f8f8f2",
      "editor.selectionBackground": "#49483e",
      "editorCursor.foreground": "#f8f8f0",
      "editorIndentGuide.background1": "#3b3c35",
      "editorIndentGuide.activeBackground1": "#75715e",
      "editorWidget.background": "#1e1f1c",
      "editorSuggestWidget.background": "#1e1f1c",
      "editorHoverWidget.background": "#1e1f1c",
    },
    {
      keyword: "f92672",
      number: "ae81ff",
      string: "e6db74",
      comment: ["75715e", "italic"],
      type: "66d9ef",
      "type.identifier": "a6e22e",
      identifier: "f8f8f2",
      "identifier.function": "a6e22e",
      delimiter: "f8f8f2",
      operator: "f92672",
    },
  ),
  theme(
    "github-dark",
    "GitHub Dark",
    "vs-dark",
    {
      "editor.background": "#0d1117",
      "editorGutter.background": "#0d1117",
      "editor.lineHighlightBackground": "#161b22",
      "editorLineNumber.foreground": "#6e7681",
      "editorLineNumber.activeForeground": "#e6edf3",
      "editor.selectionBackground": "#265db5",
      "editorCursor.foreground": "#e6edf3",
      "editorIndentGuide.background1": "#21262d",
      "editorIndentGuide.activeBackground1": "#484f58",
      "editorWidget.background": "#161b22",
      "editorSuggestWidget.background": "#161b22",
      "editorHoverWidget.background": "#161b22",
    },
    {
      keyword: "ff7b72",
      number: "79c0ff",
      string: "a5d6ff",
      comment: ["8b949e", "italic"],
      type: "ffa657",
      identifier: "e6edf3",
      "identifier.function": "d2a8ff",
      delimiter: "e6edf3",
      operator: "ff7b72",
    },
  ),
  theme(
    "github-light",
    "GitHub Light",
    "vs",
    {
      "editor.background": "#ffffff",
      "editorGutter.background": "#ffffff",
      "editor.lineHighlightBackground": "#f6f8fa",
      "editorLineNumber.foreground": "#8c959f",
      "editorLineNumber.activeForeground": "#24292f",
      "editor.selectionBackground": "#0969da2e",
      "editorCursor.foreground": "#24292f",
      "editorIndentGuide.background1": "#eff2f3",
      "editorIndentGuide.activeBackground1": "#d0d7de",
      "editorWidget.background": "#f6f8fa",
      "editorSuggestWidget.background": "#f6f8fa",
      "editorHoverWidget.background": "#f6f8fa",
    },
    {
      keyword: "cf222e",
      number: "0550ae",
      string: "0a3069",
      comment: ["6e7781", "italic"],
      type: "953800",
      identifier: "24292f",
      "identifier.function": "8250df",
      delimiter: "24292f",
      operator: "0550ae",
    },
  ),
  theme(
    "solarized-light",
    "Solarized Light",
    "vs",
    {
      "editor.background": "#fdf6e3",
      "editorGutter.background": "#fdf6e3",
      "editor.lineHighlightBackground": "#eee8d5",
      "editorLineNumber.foreground": "#93a1a1",
      "editorLineNumber.activeForeground": "#586e75",
      "editor.selectionBackground": "#eee8d5",
      "editorCursor.foreground": "#657b83",
      "editorIndentGuide.background1": "#eee8d5",
      "editorIndentGuide.activeBackground1": "#93a1a1",
      "editorWidget.background": "#eee8d5",
      "editorSuggestWidget.background": "#eee8d5",
      "editorHoverWidget.background": "#eee8d5",
    },
    {
      keyword: "859900",
      number: "d33682",
      string: "2aa198",
      comment: ["93a1a1", "italic"],
      type: "b58900",
      identifier: "586e75",
      "identifier.function": "268bd2",
      delimiter: "586e75",
      operator: "859900",
    },
  ),
  theme(
    "vs-dark-plus",
    "VS Dark+（Visual Studio）",
    "vs-dark",
    {
      "editor.background": "#1e1e1e",
      "editorGutter.background": "#1e1e1e",
      "editor.lineHighlightBackground": "#2a2a2a",
      "editorLineNumber.foreground": "#6e7681",
      "editor.selectionBackground": "#264f78",
      "editorCursor.foreground": "#aeafad",
    },
    {
      keyword: "569cd6",
      number: "b5cea8",
      string: "ce9178",
      comment: "6a9955",
      type: "4ec9b0",
      identifier: "9cdcfe",
      delimiter: "d4d4d4",
    },
  ),
];

export const DEFAULT_EDITOR_THEME = "ys-dark";

export function editorThemeDef(id) {
  return (
    EDITOR_THEMES.find((t) => t.id === id) ??
    EDITOR_THEMES.find((t) => t.id === DEFAULT_EDITOR_THEME)
  );
}
