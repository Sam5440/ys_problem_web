/* 移动端编译器 E2E：覆盖切换 / 上下分屏 / 站内编程键盘。
   前置：npm run build && npx next start -p 3100（BASE_URL 可覆盖端口）。
   跑法：node scripts/tests/e2e-compiler-mobile.mjs
   断言 22 项（布局几何 + 键盘真实 tap 输入/双击合并/退格/Tab/撤销/空格 +
   系统键盘抑制 + 设置项 + 桌面回归），并输出 7 张视口截图到
   $TMPDIR/ys-mobile-shots/ 供人工评审。手机态 viewport 390x844（hasTouch）。 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3100";
const OUT = join(tmpdir(), "ys-mobile-shots");
mkdirSync(OUT, { recursive: true });

const shot = (page, name, full = true) =>
  page.screenshot({ path: `${OUT}/${name}.png`, fullPage: full });

const ctx = await chromium
  .launch()
  .then((b) =>
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

// 系统键盘抑制:inputarea inputmode=none
const inputmode = await page.evaluate(() =>
  document
    .querySelector("#compiler-panel textarea.ime-text-area")
    ?.getAttribute("inputmode"),
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
