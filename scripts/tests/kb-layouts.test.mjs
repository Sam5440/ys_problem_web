/**
 * lib/compiler/kb-layouts.js + themes.js 完整性单测：
 * 布局每行恰好 10 键、高频符号可达、双击合并字符在位、主题数据合法。
 * 布局本身是频率统计的产物（见 kb-layouts.js 文件头），这里只钉结构不变式，
 * 防止后续手改布局时悄悄弄出行宽不齐或关键符号丢失。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { KB_LAYOUTS, kbLayout } from "../../lib/compiler/kb-layouts.js";
import { EDITOR_THEMES, editorThemeDef } from "../../lib/compiler/themes.js";

function allKeys(layout) {
  return [
    ...layout.abc.flat(),
    ...layout.sym.flat(),
    ...layout.bottom.abc,
    ...layout.bottom.sym,
  ];
}

test("布局结构与必备键", () => {
  for (const [lang, layout] of Object.entries(KB_LAYOUTS)) {
    const rows = [
      ...layout.abc,
      ...layout.sym,
      layout.bottom.abc,
      layout.bottom.sym,
    ];
    for (const row of rows)
      assert.equal(
        row.reduce((a, k) => a + (k.span ?? 1), 0),
        10,
        `${lang} 有一行不是 10 键宽`,
      );
    const keys = allKeys(layout);
    const chars = keys.filter((k) => k.ch && k.ch.length === 1).map((k) => k.ch);
    // 字母全 + 数字全（QWERTY 骨架不变）
    for (const c of "abcdefghijklmnopqrstuvwxyz0123456789")
      assert.ok(chars.includes(c), `${lang} 缺字母/数字 ${c}`);
    // 每语言的高频符号必在位（频率依据见 kb-layouts.js 头注释；
    // Python 的 ; 在 129 万字符语料里仅出现 4 次——按频率原则不上键盘）
    const must = {
      cpp: ";,.<>()\"{}[]=+-*/%_#&|!?:\\",
      python: ":,._()[]{}'=+-*/%!<>\\#&|^~?\"",
    };
    for (const c of must[lang])
      assert.ok(chars.includes(c), `${lang} 缺必备符号 ${c}`);
    // 组合符一击键：两语言符号页第三行整行
    const row3 = layout.sym[2].map((k) => k.ch);
    assert.ok(row3.includes("==") && row3.includes("<=") && row3.includes("!="), lang);
    if (lang === "cpp") assert.ok(row3.includes("<<") && row3.includes("::"), lang);
    if (lang === "python") assert.ok(row3.includes("**") && row3.includes("//"), lang);
    // 页面切换键与工具键标题（E2E 依赖这些文案）
    assert.equal(layout.bottom.abc[0].label, "#+=");
    assert.equal(layout.bottom.sym[0].label, "ABC");
  }
});

test("双击合并字符都在键盘上（< > : = + - & | * /）", () => {
  const MERGEABLE = new Set(["<", ">", ":", "=", "+", "-", "&", "|", "*", "/"]);
  for (const [lang, layout] of Object.entries(KB_LAYOUTS)) {
    const chars = new Set(
      allKeys(layout).filter((k) => k.ch?.length === 1).map((k) => k.ch),
    );
    for (const c of MERGEABLE)
      assert.ok(chars.has(c), `${lang} 缺可双击合并字符 ${c}`);
  }
});

test("kbLayout 回退与主题清单", () => {
  assert.equal(kbLayout("python").label, "Python");
  assert.equal(kbLayout("cpp").label, "C++");
  assert.equal(kbLayout("unknown-lang").label, "C++"); // 未知语言回退 C++

  assert.ok(EDITOR_THEMES.length >= 8);
  const ids = new Set();
  for (const t of EDITOR_THEMES) {
    assert.ok(t.id && t.label && ["vs", "vs-dark"].includes(t.base));
    assert.ok(!ids.has(t.id), `主题 id 重复 ${t.id}`);
    ids.add(t.id);
    assert.ok(t.rules.length > 0, `${t.id} 没有 token 规则`);
    assert.ok(t.colors["editor.background"], `${t.id} 缺背景色`);
    for (const r of t.rules)
      assert.match(r.foreground ?? "", /^[0-9a-f]{6,8}$/i, `${t.id} 规则色不合法`);
  }
  assert.equal(editorThemeDef("one-dark").label, "One Dark");
  assert.equal(editorThemeDef("no-such-theme").id, "ys-dark"); // 回退默认
});
