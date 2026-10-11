/* 移动端编译器 E2E：覆盖切换 / 上下分屏 / 站内编程键盘。
   前置：npm run build && npx next start -p 3100（BASE_URL 可覆盖端口）。
   跑法：node scripts/tests/e2e-compiler-mobile.mjs
   断言 30 项（布局几何 + 键盘真实 tap 输入/双击合并/退格/Tab/撤销/空格 +
   自动补全弹窗/点选插入 + 系统键盘抑制与右上角手动开关 + 设置项 + 桌面回归），
   并输出 7 张视口截图到 $TMPDIR/ys-mobile-shots/ 供人工评审。
   手机态 viewport 390x844（hasTouch）。 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3100";
const OUT = join(tmpdir(), "ys-mobile-shots");
mkdirSync(OUT, { recursive: true });

const shot = (page, name, full = true) =>
  page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });

const ctx = await chromium.launch().then((b) =>
  b.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
  }),
);
const page = await ctx.newPage();
page.on(
  "console",
  (m) => m.type() === "error" && console.log("[console.error]", m.text()),
);
page.on("pageerror", (e) => console.log("[pageerror]", e.message));

const FAILS = [];
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) FAILS.push(name);
};

// ---- 场景 1:覆盖模式(默认) + 编程键盘开启 ----
await page.addInitScript(() => {
  localStorage.setItem(
    "ysc-cp-settings-v1",
    JSON.stringify({ mobileKeyboard: true, panelOpen: true }),
  );
});
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
// 移动端加载不自动展开:点右缘舌片打开面板
await page.locator(".compiler-edge-tab").tap();
await page.waitForTimeout(1000);

// 面板是否全屏覆盖(覆盖模式:track fixed inset-0)
const trackBox = await page.locator("#compiler-dock-root").boundingBox();
check(
  "覆盖模式面板全屏",
  trackBox && trackBox.width > 380 && trackBox.height > 840,
  JSON.stringify(trackBox),
);

// 键盘可见
const kb = page.locator(".cp-kb");
await kb.waitFor({ state: "visible", timeout: 8000 }).catch(() => {});
check("编程键盘显示", await kb.isVisible().catch(() => false));

// 系统键盘抑制:编程键盘接管时 Monaco 必须已切回 textarea 输入路径
// （editContext:false，焦点元素才是真 textarea、inputmode=none 才被系统遵守）
await page
  .waitForSelector("#compiler-panel textarea.inputarea", { timeout: 8000 })
  .catch(() => {});
const inputmode = await page.evaluate(() =>
  document
    .querySelector("#compiler-panel textarea.inputarea")
    ?.getAttribute("inputmode"),
);
const effEC = await page.evaluate(() =>
  window.__ysMonaco?.editor.getOption(
    window.__ysMonaco.monaco.editor.EditorOption.effectiveEditContext,
  ),
);
check(
  "键盘接管时切回 textarea 输入路径(editContext=false)",
  effEC === false,
  `effectiveEditContext=${effEC}`,
);
check(
  "Monaco inputmode=none(抑制系统键盘)",
  inputmode === "none",
  `inputmode=${inputmode}`,
);

await page.waitForTimeout(600);
await shot(page, "m1-cover-keyboard", false);

// ---- 键盘交互:点编辑器聚焦 → 打字母 / 双击 < 合并 / 退格 ----
await page.locator("#compiler-panel .compiler-editor-host").click();
await page.waitForTimeout(300);

const type = async (label) => {
  await page.locator(".cp-kb-key", { hasText: label }).first().tap();
  await page.waitForTimeout(60);
};

// 打 "if" → 主页字母
await type("i");
await type("f");
let v = await page.evaluate(() => window.__ysMonaco.editor.getValue());
check("键盘输入字母", v.includes("if"), JSON.stringify(v.slice(0, 40)));

// 双击 < 合并为 <<
const lt = page.locator(".cp-kb-key", { hasText: "<" }).first();
await lt.tap();
await page.waitForTimeout(80);
await lt.tap();
await page.waitForTimeout(80);
v = await page.evaluate(() => window.__ysMonaco.editor.getValue());
check(
  "双击 < 自动合并 <<",
  v.includes("<<"),
  JSON.stringify(v.split("\n").find((l) => l.includes("<")) ?? ""),
);

// 退格一次:<< → <
await page.locator(".cp-kb-key svg:has(path)").first(); // noop
const bksp = page.locator('.cp-kb-key[title="退格（长按连删）"]');
await bksp.tap();
await page.waitForTimeout(80);
v = await page.evaluate(() => window.__ysMonaco.editor.getValue());
check(
  "退格删除",
  !v.includes("<<") && v.includes("<"),
  JSON.stringify(v.split("\n").find((l) => l.includes("<")) ?? ""),
);

// Tab 缩进
await page.keyboard.press("Home");
await type("Tab");
v = await page.evaluate(() => window.__ysMonaco.editor.getValue());
check(
  "Tab 插入缩进(4空格)",
  / {4}if/.test(v),
  JSON.stringify(v.split("\n").find((l) => l.includes("if")) ?? ""),
);

// 符号页往返 + 输出 <<
await page.locator(".cp-kb-key", { hasText: "#+=" }).tap();
await page.waitForTimeout(60);
await type("{");
await page.locator(".cp-kb-key", { hasText: "ABC" }).tap();
await page.waitForTimeout(60);
v = await page.evaluate(() => window.__ysMonaco.editor.getValue());
check("符号页输入 {", v.includes("{"), "");

// 撤销
const beforeUndo = await page.evaluate(() =>
  window.__ysMonaco.editor.getValue(),
);
await page.locator('.cp-kb-key[title="撤销"]').tap();
await page.waitForTimeout(80);
v = await page.evaluate(() => window.__ysMonaco.editor.getValue());
check("撤销", v !== beforeUndo, JSON.stringify(v.split("\n").slice(-2)));

await shot(page, "m2-keyboard-typed", false);

// 空格键（undo 后光标位置不定，用光标列 +1 断言）
const colBefore = await page.evaluate(
  () => window.__ysMonaco.editor.getPosition().column,
);
await page.locator('.cp-kb-key[title="空格"]').tap();
await page.waitForTimeout(80);
const colAfter = await page.evaluate(
  () => window.__ysMonaco.editor.getPosition().column,
);
check("空格键插入", colAfter === colBefore + 1, `${colBefore} -> ${colAfter}`);

// ---- 自动补全（键盘触发的 type 走 source='keyboard' 才会弹）----
// 固定编辑器内容与光标，避免 undo 后位置不定落在字符串/注释里（那里不弹）
await page.evaluate(() => {
  const { editor } = window.__ysMonaco;
  editor.setValue("int main() {\n  \n}");
  editor.setPosition({ lineNumber: 2, column: 3 });
});
for (const ch of ["p", "r", "i"]) await type(ch);
await page.waitForTimeout(600);
const suggest = page.locator(
  "#compiler-panel .compiler-editor-host .suggest-widget.visible",
);
const suggestVisible = await suggest.isVisible().catch(() => false);
check("键盘输入触发补全弹窗", suggestVisible, "");
const printfRow = suggest.locator('.monaco-list-row:has-text("printf")');
const hasPrintf = suggestVisible && (await printfRow.count()) > 0;
check("补全列表含 printf", hasPrintf, "");
if (hasPrintf) {
  await printfRow.first().tap();
  await page.waitForTimeout(300);
}
v = await page.evaluate(() => window.__ysMonaco.editor.getValue());
check("点选补全项插入代码", v.includes("printf"), JSON.stringify(v));
await shot(page, "m2b-suggest", false);

// 收起键盘(结果区回来)
await page.locator('.cp-kb-key[title="收起键盘"]').tap();
await page.waitForTimeout(300);
check("收起键盘", !(await kb.isVisible().catch(() => false)));
check(
  "结果区恢复",
  await page
    .locator("#compiler-panel [data-results]")
    .isVisible()
    .catch(() => false),
);

// 「键盘」恢复按钮 → 键盘回归(Monaco EditContext 焦点不变化,显式按钮是主路径)
await page.locator('button[aria-label="显示编程键盘"]').tap();
await page.waitForTimeout(300);
check("恢复按钮唤回键盘", await kb.isVisible().catch(() => false));

// ---- 右上角「系统键盘」手动开关：开 = 解除抑制并聚焦（弹系统输入法），关 = 收回 ----
const sysKbKey = page.locator('.cp-kb-key[title="系统键盘（输入法）"]');
await sysKbKey.tap();
await page.waitForTimeout(400);
const sysKbOn = await page.evaluate(() => ({
  effEC: window.__ysMonaco.editor.getOption(
    window.__ysMonaco.monaco.editor.EditorOption.effectiveEditContext,
  ),
  inputmode: document
    .querySelector(
      "#compiler-panel textarea.inputarea, #compiler-panel textarea.ime-text-area",
    )
    ?.getAttribute("inputmode"),
  focused: window.__ysMonaco.editor.hasTextFocus(),
}));
check(
  "系统键盘开关:解除抑制并聚焦编辑器",
  sysKbOn.effEC === true && sysKbOn.inputmode == null && sysKbOn.focused,
  JSON.stringify(sysKbOn),
);
await sysKbKey.tap();
await page.waitForTimeout(400);
const sysKbOff = await page.evaluate(() => ({
  effEC: window.__ysMonaco.editor.getOption(
    window.__ysMonaco.monaco.editor.EditorOption.effectiveEditContext,
  ),
  inputmode: document
    .querySelector("#compiler-panel textarea.inputarea")
    ?.getAttribute("inputmode"),
}));
check(
  "系统键盘开关:重新抑制",
  sysKbOff.effEC === false && sysKbOff.inputmode === "none",
  JSON.stringify(sysKbOff),
);

// ---- 关闭面板:回题目(覆盖切换) ----
await page.locator('#compiler-panel button[aria-label="收起编译器"]').tap();
await page.waitForTimeout(900);
const trackAfterClose = await page.locator("#compiler-dock-root").boundingBox();
const panelHidden = await page
  .locator("#compiler-panel")
  .isHidden()
  .catch(() => true);
check(
  "关闭面板回题目(面板移出屏幕)",
  trackAfterClose && trackAfterClose.x >= 385,
  JSON.stringify(trackAfterClose),
);
await shot(page, "m3-cover-closed", false);

// 舌片重新打开
await page.locator(".compiler-edge-tab").tap();
await page.waitForTimeout(900);
check("舌片重新打开", await page.locator("#compiler-panel").isVisible());

// ---- 场景 2:分屏模式 ----
const page2 = await ctx.newPage();
await page2.addInitScript(() => {
  localStorage.setItem(
    "ysc-cp-settings-v1",
    JSON.stringify({
      mobileKeyboard: true,
      mobileLayout: "split",
      panelOpen: true,
    }),
  );
});
await page2.goto(BASE, { waitUntil: "networkidle" });
await page2.waitForTimeout(1200);
await page2.locator(".compiler-edge-tab").tap();
await page2.waitForTimeout(1000);
const trackBox2 = await page2.locator("#compiler-dock-root").boundingBox();
check(
  "分屏模式面板在底部(≈50dvh)",
  trackBox2 && Math.abs(trackBox2.height - 422) < 40 && trackBox2.y > 400,
  JSON.stringify(trackBox2),
);
// 题目区可见(上半屏有站点内容)
const shellBox = await page2.locator(".site-shell").boundingBox();
check(
  "题目区在上半屏",
  shellBox && shellBox.height > 300,
  JSON.stringify(shellBox && { h: shellBox.height }),
);
await shot(page2, "m4-split", false);

// 分屏 + 键盘(键盘显示时结果区让位)
await page2.locator("#compiler-panel .compiler-editor-host").click();
await page2.waitForTimeout(400);
await shot(page2, "m5-split-keyboard", false);

// ---- 设置弹窗 ----
const page3 = await ctx.newPage();
await page3.addInitScript(() => {
  localStorage.setItem(
    "ysc-cp-settings-v1",
    JSON.stringify({ mobileKeyboard: false }),
  );
});
await page3.goto(BASE, { waitUntil: "networkidle" });
await page3.waitForTimeout(800);
await page3.locator('button[aria-label="翻译设置"]').tap();
await page3.waitForTimeout(500);
const settingsItem = page3.locator("text=编程键盘").first();
await settingsItem.scrollIntoViewIfNeeded().catch(() => {});
await page3.waitForTimeout(300);
check(
  "设置含「编程键盘」项",
  await settingsItem.isVisible().catch(() => false),
);
check(
  "设置含「编译器布局」项",
  await page3
    .locator("text=编译器布局")
    .first()
    .isVisible()
    .catch(() => false),
);
check(
  "设置含「Ctrl/⌘S 行为」项",
  await page3
    .locator("text=Ctrl/⌘S 行为")
    .first()
    .isVisible()
    .catch(() => false),
);
await shot(page3, "m6-settings", false);

// ---- 桌面回归:1440x900 并排不变 ----
const dctx = await chromium
  .launch()
  .then((b) => b.newContext({ viewport: { width: 1440, height: 900 } }));
const dpage = await dctx.newPage();
await dpage.goto(BASE, { waitUntil: "networkidle" });
await dpage.waitForTimeout(1500);
const dTrack = await dpage.locator("#compiler-dock-root").boundingBox();
check(
  "桌面并排分栏(右侧列展开)",
  dTrack && dTrack.width > 380 && dTrack.x > 700 && dTrack.height <= 905,
  JSON.stringify(dTrack),
);
check(
  "桌面无键盘",
  !(await dpage
    .locator(".cp-kb")
    .isVisible()
    .catch(() => false)),
);
await dpage.screenshot({ path: `${OUT}/d1-desktop.png` });

await ctx.close();
await dctx.close();
console.log(
  FAILS.length ? `\n${FAILS.length} FAILED: ${FAILS.join(", ")}` : "\nALL PASS",
);
process.exit(FAILS.length ? 1 : 0);
