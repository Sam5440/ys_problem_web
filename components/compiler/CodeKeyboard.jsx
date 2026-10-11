"use client";

/**
 * 移动端站内编程键盘（替代系统软键盘，设置「编程键盘」开启后随编译器面板显示）。
 *
 * 设计目标：刷题场景少翻页、少击键。布局**按语言感知 + 符号频率**设计
 * （lib/compiler/kb-layouts.js，频率统计来源见该文件头注释）：字母页数字行
 * + QWERTY 骨架不变，行尾/底行的符号槽随语言切换（C++ 常驻 ; , . ( ) < > "，
 * Python 常驻 : _ , ( ) [ ] .）；符号页按各自语料的频率排序，第三行整行是
 * 组合符一击键（<< == += 等，一键插完双字符）。
 *
 * 交互细节：
 * - 所有按键 pointerdown 即触发并 preventDefault（不抢编辑器焦点），插入走
 *   editor.trigger('keyboard', 'type') 完整输入管线——自动括号配对、自动缩进、
 *   自动补全都生效。source 必须是 'keyboard'：Monaco 的 suggest 触发链
 *   （onDidType 触发字符检查、quickSuggestions 的光标变更钩子）都只认
 *   source==='keyboard'，用别的字符串补全永远不会弹（2026-10 真机修复）。
 * - 退格与方向键支持长按连发（350ms 延迟后 45ms 步进；连发期间不振动，
 *   触感只在按下瞬间发一次——45ms 一次的 vibrate 调用本身就会卡）。
 * - 可合并字符（< > : = + - & | * /）快速连击两下（<300ms）自动合并为
 *   << >> :: == 等双写：第二击用 executeEdits 把光标前一个刚插入的同字符
 *   替换成双写。想打两个独立字符时中间隔 >300ms 或移动过光标即可。
 * - Shift 单击单发、双击锁定；Shift + 数字行 = !@#$%^&*()。
 * - 触觉反馈 navigator.vibrate（Android 网页可用；iOS 静默忽略）。
 * - 「系统键盘」键手动唤起系统输入法（输中文注释等场景）：开 = 解除
 *   inputmode 抑制并聚焦编辑器（CompilerDock 负责），关 = 夺回焦点收回。
 *
 * 性能：键位 def 全部是模块级常量 + KbKey memo + 稳定回调，正常击键路径
 * 不触发任何 React 重渲染；按下视觉交给 CSS :active。
 *
 * 输入不经过任何 <input>：本键盘显示期间 CodeEditor 把 Monaco 切回 textarea
 * 输入路径并设 inputmode="none" 抑制系统软键盘，二者互斥。
 */

import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  ChevronsLeft,
  ChevronsRight,
  Undo2,
  Keyboard,
  ChevronDown,
  Delete,
  ArrowBigUp,
  CornerDownLeft,
} from "lucide-react";
import { kbLayout } from "../../lib/compiler/kb-layouts.js";

/* 可双击合并的字符 → 双写（<< >> :: == ++ -- && || ** //） */
const MERGEABLE = new Set(["<", ">", ":", "=", "+", "-", "&", "|", "*", "/"]);
const NUM_SHIFT = {
  1: "!",
  2: "@",
  3: "#",
  4: "$",
  5: "%",
  6: "^",
  7: "&",
  8: "*",
  9: "(",
  0: ")",
};

/* 动作键的图标在渲染时按 action 注入（布局常量放在 lib/ 不引组件库，
   保持 node --test 可直接 import kb-layouts） */
const ACTION_ICONS = {
  shift: ArrowBigUp,
  backspace: Delete,
  enter: CornerDownLeft,
};

/* 键位定义全部模块级常量：def 引用稳定是 KbKey memo 生效的前提 */
const TOOLS = [
  { label: "Tab", action: "tab", title: "缩进" },
  { icon: ArrowLeft, action: "left", title: "光标左移", hold: true },
  { icon: ArrowUp, action: "up", title: "光标上移", hold: true },
  { icon: ArrowDown, action: "down", title: "光标下移", hold: true },
  { icon: ArrowRight, action: "right", title: "光标右移", hold: true },
  { icon: ChevronsLeft, action: "home", title: "行首" },
  { icon: ChevronsRight, action: "end", title: "行尾" },
  { icon: Undo2, action: "undo", title: "撤销" },
  { icon: Keyboard, action: "syskb", title: "系统键盘（输入法）" },
  { icon: ChevronDown, action: "hide", title: "收起键盘" },
];

const CURSOR_CMD = {
  left: "cursorLeft",
  right: "cursorRight",
  up: "cursorUp",
  down: "cursorDown",
  home: "cursorHome",
  end: "cursorEnd",
};

function vibrate() {
  try {
    navigator.vibrate?.(8);
  } catch {}
}

export default function CodeKeyboard({
  editorApi,
  onHide,
  onToggleSysKb,
  sysKb,
  compact,
  lang = "cpp",
}) {
  const [page, setPage] = useState("abc");
  const [shift, setShift] = useState(0); // 0 关 1 单发 2 锁定
  const lastMergeRef = useRef(null); // { ch, at } 双击合并窗口
  const lastShiftTapRef = useRef(0);
  const holdRef = useRef(null);
  const stateRef = useRef({ page, shift });
  stateRef.current = { page, shift };
  // 回调 prop 经 ref 间接引用，保证下面的 useCallback 依赖稳定（KbKey memo 生效）
  const propsRef = useRef({ onHide, onToggleSysKb });
  propsRef.current = { onHide, onToggleSysKb };
  const layout = kbLayout(lang); // 模块级常量，语言不变时引用稳定
  const rows = page === "sym" ? layout.sym : layout.abc;
  const bottom = layout.bottom[page];

  useEffect(() => () => stopHold(holdRef), []);

  const tapShift = useCallback(() => {
    const now = Date.now();
    if (now - lastShiftTapRef.current < 300) {
      setShift(2); // 双击锁定
      lastShiftTapRef.current = 0;
    } else {
      setShift((s) => (s === 2 ? 0 : s === 1 ? 0 : 1));
      lastShiftTapRef.current = now;
    }
  }, []);

  /** 光标前一字符恰好是刚插入的 ch 时替换为双写（== / << / :: …） */
  const mergeDouble = useCallback(
    (ch) => {
      const { editor, monaco } = editorApi?.current ?? {};
      if (!editor || !monaco) return;
      const pos = editor.getPosition();
      const model = editor.getModel();
      if (
        !pos ||
        !model ||
        pos.column === 1 ||
        model.getValueInRange({
          startLineNumber: pos.lineNumber,
          startColumn: pos.column - 1,
          endLineNumber: pos.lineNumber,
          endColumn: pos.column,
        }) !== ch
      ) {
        editor.trigger("keyboard", "type", { text: ch });
        return;
      }
      editor.executeEdits("cp-kb", [
        {
          range: new monaco.Range(
            pos.lineNumber,
            pos.column - 1,
            pos.lineNumber,
            pos.column,
          ),
          text: ch + ch,
        },
      ]);
    },
    [editorApi],
  );

  const insertChar = useCallback(
    (raw) => {
      const { editor } = editorApi?.current ?? {};
      if (!editor) return;
      const { page: pg, shift: sh } = stateRef.current;
      let ch = raw;
      if (pg === "abc" && sh) {
        if (NUM_SHIFT[raw]) ch = NUM_SHIFT[raw];
        else if (/^[a-z]$/.test(raw)) ch = raw.toUpperCase();
      }
      // 已有焦点就不再 focus：重复 focus() 在真机上可观地拖慢每次击键
      if (!editor.hasTextFocus?.()) editor.focus();
      const now = Date.now();
      const last = lastMergeRef.current;
      if (MERGEABLE.has(ch) && last?.ch === ch && now - last.at < 300) {
        lastMergeRef.current = null;
        mergeDouble(ch);
        return;
      }
      lastMergeRef.current = MERGEABLE.has(ch) ? { ch, at: now } : null;
      if (sh === 1 && /^[A-Z(]$/.test(ch)) setShift(0); // 单发 Shift 用掉即回弹
      // source 必须是 'keyboard'，否则 Monaco 的自动补全触发链完全不认（见文件头）
      editor.trigger("keyboard", "type", { text: ch });
    },
    [editorApi, mergeDouble],
  );

  const runAction = useCallback(
    (action) => {
      const { editor } = editorApi?.current ?? {};
      if (!editor) return;
      if (!editor.hasTextFocus?.()) editor.focus();
      if (action === "hide") return propsRef.current.onHide?.();
      if (action === "enter")
        return editor.trigger("keyboard", "type", { text: "\n" });
      if (action === "tab") {
        // type('\t') 会插进字面制表符（不按 insertSpaces 展开），自己算 tab stop：
        // 空格数补齐到 tabSize 的倍数；有选区时走块缩进（indentLines）
        const sel = editor.getSelection?.();
        if (sel && !sel.isEmpty())
          return editor.getAction?.("editor.action.indentLines")?.run();
        const tabSize = editor.getModel()?.getOptions?.().tabSize ?? 4;
        const col = editor.getPosition()?.column ?? 1;
        return editor.trigger("keyboard", "type", {
          text: " ".repeat(tabSize - ((col - 1) % tabSize)),
        });
      }
      if (action === "backspace")
        return editor.trigger("keyboard", "deleteLeft");
      if (action === "undo") return editor.trigger("keyboard", "undo");
      if (CURSOR_CMD[action])
        return editor.trigger("keyboard", CURSOR_CMD[action]);
    },
    [editorApi],
  );

  /* 按下即触发 + 振动一次；hold 键接长按连发（350ms 缓冲后 45ms 步进，不再振动）。
     触发动作经稳定引用包裹，配合模块级 def 让 KbKey 的 memo 真正生效 */
  const handleDown = useCallback(
    (def) => {
      if (def.page) {
        setPage(def.page);
        setShift(0);
        vibrate();
        return;
      }
      if (def.action === "shift") {
        vibrate();
        return tapShift();
      }
      if (def.action === "syskb") {
        vibrate();
        return propsRef.current.onToggleSysKb?.();
      }
      const fire = def.ch
        ? () => insertChar(def.ch)
        : () => runAction(def.action);
      fire();
      vibrate();
      if (def.hold) {
        stopHold(holdRef);
        holdRef.current = setTimeout(() => {
          holdRef.current = setInterval(fire, 45);
        }, 350);
      }
    },
    [insertChar, runAction, tapShift],
  );
  const handleUp = useCallback(() => stopHold(holdRef), []);

  const shiftOn = shift !== 0 && page === "abc";

  return (
    <div
      className="cp-kb"
      data-compact={compact || undefined}
      role="group"
      aria-label="编程键盘"
    >
      <div className="cp-kb-row">
        {TOOLS.map((t) => (
          <KbKey
            key={t.action}
            def={t}
            tone="tool"
            onDown={handleDown}
            onUp={handleUp}
            active={t.action === "syskb" ? sysKb : false}
          />
        ))}
      </div>
      {rows.map((row, ri) => (
        <div className="cp-kb-row" key={ri}>
          {row.map((def, ci) => {
            // 键帽：Shift 态显示上档字符（数字 → 符号，字母 → 大写）
            const cap =
              shiftOn && page === "abc"
                ? (NUM_SHIFT[def.ch] ??
                  (/^[a-z]$/.test(def.ch) ? def.ch.toUpperCase() : def.ch))
                : def.ch;
            return (
              <KbKey
                key={ci}
                def={def}
                label={cap}
                onDown={handleDown}
                onUp={handleUp}
                active={def.action === "shift" ? shiftOn : false}
              />
            );
          })}
        </div>
      ))}
      <div className="cp-kb-row">
        {bottom.map((def, i) => (
          <KbKey
            key={i}
            def={def}
            label={def.label}
            onDown={handleDown}
            onUp={handleUp}
            active={false}
          />
        ))}
      </div>
    </div>
  );
}

const KbKey = memo(function KbKey({ def, label, tone, onDown, onUp, active }) {
  const Icon = def.icon ?? (def.action ? ACTION_ICONS[def.action] : null);
  return (
    <button
      type="button"
      className={`cp-kb-key ${tone ? `cp-kb-key-${tone}` : ""}`}
      style={def.span ? { gridColumn: `span ${def.span}` } : undefined}
      data-active={active || undefined}
      title={def.title}
      aria-label={def.title ?? def.ch}
      onPointerDown={(e) => {
        e.preventDefault();
        onDown(def);
      }}
      onPointerUp={onUp}
      onPointerLeave={onUp}
      onPointerCancel={onUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      {Icon ? <Icon /> : (label ?? def.label ?? def.ch)}
    </button>
  );
});

function stopHold(ref) {
  clearTimeout(ref.current);
  clearInterval(ref.current);
  ref.current = null;
}
