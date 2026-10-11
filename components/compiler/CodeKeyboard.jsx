"use client";

/**
 * 移动端站内编程键盘（替代系统软键盘，设置「编程键盘」开启后随编译器面板显示）。
 *
 * 设计目标：刷题场景少翻页。数字行 + 高频符号（; ( ) < > , .）常驻字母页，
 * 其余符号在 #+= 页一击可达；顶部工具行提供 Tab / 方向键 / 行首行尾 / 撤销重做。
 *
 * 交互细节：
 * - 所有按键 pointerdown 即触发并 preventDefault（编辑器焦点不丢，Monaco 光标
 *   保持在原位；触发插入走 editor.trigger('type') 完整输入管线——自动括号配对、
 *   自动缩进、补全触发全都生效）。
 * - 退格与方向键支持长按连发（350ms 延迟后 45ms 步进）。
 * - 可合并字符（< > : = + - & | * /）快速连击两下（<300ms）自动合并为 << >> ::
 *   == 等双写：第二击用 executeEdits 把光标前一个刚插入的同字符替换成双写。
 *   想打两个独立字符时中间隔 >300ms 或移动过光标即可，不会误合并。
 * - Shift 单击单发、双击锁定；Shift + 数字行 = !@#$%^&*()。
 * - 触觉反馈 navigator.vibrate（Android 网页可用；iOS 静默忽略）。
 *
 * 输入不经过任何 <input>：开启本键盘时 CodeEditor 会给 Monaco 的 inputarea 设
 * inputmode="none" 抑制系统软键盘，二者互斥。
 */

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowUp,
  ArrowDown,
  ArrowRight,
  ChevronsLeft,
  ChevronsRight,
  Undo2,
  Redo2,
  ChevronDown,
  Delete,
  ArrowBigUp,
  CornerDownLeft,
} from "lucide-react";

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

const ROWS = {
  abc: [
    ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
    ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
    ["a", "s", "d", "f", "g", "h", "j", "k", "l", ";"],
    ["SHIFT", "z", "x", "c", "v", "b", "n", "m", ",", "BKSP"],
  ],
  sym: [
    ["+", "-", "*", "/", "%", "=", "!", "&", "|", "_"],
    ["{", "}", "[", "]", '"', "'", "\\", "^", "~", "@"],
    [":", "#", "$", "`", "?", "(", ")", "<", ">", ","],
  ],
};

/* 底行（空格 + 回车所在行）：sym 页里 ; . 重复出现，减少页面往返 */
const BOTTOM = {
  abc: [
    { page: "sym", label: "#+=", title: "符号页" },
    { ch: "(" },
    { ch: ")" },
    { ch: "<" },
    { ch: ">" },
    { ch: "." },
    { space: 3 },
    { action: "enter", icon: CornerDownLeft, title: "回车", wide: 1 },
  ],
  sym: [
    { page: "abc", label: "ABC", title: "字母页" },
    { ch: ";" },
    { ch: "." },
    { space: 4 },
    { action: "backspace", icon: Delete, title: "退格", hold: true, wide: 1 },
    { action: "enter", icon: CornerDownLeft, title: "回车", wide: 1 },
  ],
};

const TOOLS = [
  { label: "Tab", action: "tab", title: "缩进" },
  { icon: ArrowLeft, action: "left", title: "光标左移", hold: true },
  { icon: ArrowUp, action: "up", title: "光标上移", hold: true },
  { icon: ArrowDown, action: "down", title: "光标下移", hold: true },
  { icon: ArrowRight, action: "right", title: "光标右移", hold: true },
  { icon: ChevronsLeft, action: "home", title: "行首" },
  { icon: ChevronsRight, action: "end", title: "行尾" },
  { icon: Undo2, action: "undo", title: "撤销" },
  { icon: Redo2, action: "redo", title: "重做" },
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

export default function CodeKeyboard({ editorApi, onHide, compact }) {
  const [page, setPage] = useState("abc");
  const [shift, setShift] = useState(0); // 0 关 1 单发 2 锁定
  const lastMergeRef = useRef(null); // { ch, at } 双击合并窗口
  const lastShiftTapRef = useRef(0);
  const holdRef = useRef(null);
  const stateRef = useRef({ page, shift });
  stateRef.current = { page, shift };

  useEffect(() => () => stopHold(holdRef), []);

  const tapShift = () => {
    const now = Date.now();
    if (now - lastShiftTapRef.current < 300) {
      setShift(2); // 双击锁定
      lastShiftTapRef.current = 0;
    } else {
      setShift((s) => (s === 2 ? 0 : s === 1 ? 0 : 1));
      lastShiftTapRef.current = now;
    }
    vibrate();
  };

  /** 光标前一字符恰好是刚插入的 ch 时替换为双写（== / << / :: …） */
  const mergeDouble = (ch) => {
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
      editor.trigger("cp-kb", "type", { text: ch });
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
  };

  const insertChar = (raw) => {
    const { editor } = editorApi?.current ?? {};
    if (!editor) return;
    const { page: pg, shift: sh } = stateRef.current;
    let ch = raw;
    if (pg === "abc" && sh) {
      if (NUM_SHIFT[raw]) ch = NUM_SHIFT[raw];
      else if (/^[a-z]$/.test(raw)) ch = raw.toUpperCase();
    }
    editor.focus();
    vibrate();
    const now = Date.now();
    const last = lastMergeRef.current;
    if (MERGEABLE.has(ch) && last?.ch === ch && now - last.at < 300) {
      lastMergeRef.current = null;
      mergeDouble(ch);
      return;
    }
    lastMergeRef.current = MERGEABLE.has(ch) ? { ch, at: now } : null;
    if (sh === 1 && /^[A-Z(]$/.test(ch)) setShift(0); // 单发 Shift 用掉即回弹
    editor.trigger("cp-kb", "type", { text: ch });
  };

  const runAction = (action) => {
    const { editor } = editorApi?.current ?? {};
    if (!editor) return;
    editor.focus();
    vibrate();
    if (action === "hide") return onHide?.();
    if (action === "enter")
      return editor.trigger("cp-kb", "type", { text: "\n" });
    if (action === "tab") {
      // type('\t') 会插进字面制表符（不按 insertSpaces 展开），自己算 tab stop：
      // 空格数补齐到 tabSize 的倍数；有选区时走块缩进（indentLines）
      const sel = editor.getSelection?.();
      if (sel && !sel.isEmpty())
        return editor.getAction?.("editor.action.indentLines")?.run();
      const tabSize = editor.getModel()?.getOptions?.().tabSize ?? 4;
      const col = editor.getPosition()?.column ?? 1;
      return editor.trigger("cp-kb", "type", {
        text: " ".repeat(tabSize - ((col - 1) % tabSize)),
      });
    }
    if (action === "backspace") return editor.trigger("cp-kb", "deleteLeft");
    if (action === "undo") return editor.trigger("cp-kb", "undo");
    if (action === "redo") return editor.trigger("cp-kb", "redo");
    if (CURSOR_CMD[action]) return editor.trigger("cp-kb", CURSOR_CMD[action]);
  };

  /* 按下即触发；hold 键接长按连发（间隔先 350ms 缓冲再 45ms 步进） */
  const onKeyDown = (def) => (e) => {
    e.preventDefault();
    if (def.page) {
      setPage(def.page);
      setShift(0);
      vibrate();
      return;
    }
    if (def.action === "shift") return tapShift();
    const fire = def.ch
      ? () => insertChar(def.ch)
      : () => runAction(def.action);
    fire();
    if (def.hold) {
      stopHold(holdRef);
      holdRef.current = setTimeout(() => {
        holdRef.current = setInterval(fire, 45);
      }, 350);
    }
  };
  const onKeyUp = () => stopHold(holdRef);

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
            onDown={onKeyDown(t)}
            onUp={onKeyUp}
            active={false}
            title={t.title}
          />
        ))}
      </div>
      {ROWS[page].map((row, ri) => (
        <div className="cp-kb-row" key={ri}>
          {row.map((raw, ci) => {
            if (raw === "SHIFT") {
              return (
                <KbKey
                  key="shift"
                  def={{ action: "shift", icon: ArrowBigUp }}
                  tone="tool"
                  onDown={onKeyDown({ action: "shift" })}
                  onUp={onKeyUp}
                  active={shiftOn}
                  title="大写（双击锁定）"
                />
              );
            }
            if (raw === "BKSP") {
              return (
                <KbKey
                  key="bksp"
                  def={{ action: "backspace", icon: Delete }}
                  tone="tool"
                  onDown={onKeyDown({ action: "backspace", hold: true })}
                  onUp={onKeyUp}
                  active={false}
                  title="退格（长按连删）"
                />
              );
            }
            // 键帽：Shift 态显示上档字符（数字 → 符号，字母 → 大写）
            const cap =
              shiftOn && page === "abc"
                ? (NUM_SHIFT[raw] ??
                  (/^[a-z]$/.test(raw) ? raw.toUpperCase() : raw))
                : raw;
            return (
              <KbKey
                key={ci}
                def={{ ch: raw }}
                label={cap}
                onDown={onKeyDown({ ch: raw })}
                onUp={onKeyUp}
                active={false}
              />
            );
          })}
        </div>
      ))}
      <div className="cp-kb-row">
        {BOTTOM[page].map((def, i) => {
          if (def.space)
            return (
              <KbKey
                key={i}
                def={{ ch: " " }}
                onDown={onKeyDown({ ch: " " })}
                onUp={onKeyUp}
                active={false}
                title="空格"
                style={{ gridColumn: `span ${def.space}` }}
              />
            );
          return (
            <KbKey
              key={i}
              def={def}
              label={def.label}
              onDown={onKeyDown(def)}
              onUp={onKeyUp}
              active={false}
              title={def.title}
            />
          );
        })}
      </div>
    </div>
  );
}

function KbKey({ def, label, icon, tone, onDown, onUp, active, title, style }) {
  const Icon = def.icon ?? icon;
  return (
    <button
      type="button"
      className={`cp-kb-key ${tone ? `cp-kb-key-${tone}` : ""}`}
      style={style}
      data-active={active || undefined}
      title={title}
      aria-label={title}
      onPointerDown={onDown}
      onPointerUp={onUp}
      onPointerLeave={onUp}
      onPointerCancel={onUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      {Icon ? <Icon /> : (label ?? def.label ?? def.ch)}
    </button>
  );
}

function stopHold(ref) {
  clearTimeout(ref.current);
  clearInterval(ref.current);
  ref.current = null;
}
