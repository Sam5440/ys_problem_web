#!/usr/bin/env node
/**
 * 浏览器编译器端到端测试（真实运行时，不经 mock）。
 *
 * 前置：`npm run build && npx next start -p 3100`（或 BASE_URL 指向现成服务；
 * 需要 /compiler/* 已部署——本地即 public/compiler/，Python 运行时走真实
 * jsDelivr 下载）。跑完全程约 3-6 分钟。
 *
 * 用法：node scripts/tests/e2e-compiler.mjs
 * 截图：/tmp/ys-e2e/*.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';
const SHOT_DIR = '/tmp/ys-e2e';
fs.mkdirSync(SHOT_DIR, { recursive: true });

const daily = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/daily.json'), 'utf8'));
const today = daily.days[0];
const problems = today.problems;

let passed = 0;
let failed = 0;
const failures = [];
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`FAIL  ${name} ${extra}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDock(page) {
  // 面板默认展开（panelOpen 默认 true）；等待舌片或面板任一出现
  await page.waitForSelector(
    'button[aria-label="展开编译器"], aside[aria-label="编译器面板"]',
    { timeout: 20000 },
  );
}

async function setDraft(page, code, lang, text) {
  await page.evaluate(([k, l, v]) => localStorage.setItem(`ysc-cp-draft-${k}-${l}`, v), [code, lang, text]);
}

async function reload(page) {
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDock(page);
}

async function openPanel(page) {
  // translate-x-full 的 aside 对 Playwright 仍是「可见」（有包围盒），
  // 必须用 aria-hidden 判断真实开合态
  const hidden = await page.locator('aside[aria-label="编译器面板"]').getAttribute('aria-hidden');
  if (hidden === 'true') {
    await page.locator('button[aria-label="展开编译器"]').click();
  }
  await page.locator('aside[aria-label="编译器面板"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('aside[aria-label="编译器面板"]')?.getAttribute('aria-hidden') === 'false', null, { timeout: 5000 });
}

/** 在 Monaco 里替换全部内容（优先走实例钩子 setValue —— headless 下点击聚焦
 *  不稳定，Ctrl+A 曾选中整页导致旧代码重跑；钩子缺失再退回键盘注入）。 */
async function typeCode(page, text) {
  const hooked = await page
    .evaluate((t) => {
      const hook = window.__ysMonaco;
      if (!hook?.editor || !hook.editor.getModel()) return false;
      const model = hook.editor.getModel();
      model.setValue(t);
      // 光标放回末尾：clang 补全按光标位置取行列，停在 (1,1) 会补出全局 Pattern
      hook.editor.setPosition(model.getFullModelRange().getEndPosition());
      hook.editor.focus();
      return true;
    }, text)
    .catch(() => false);
  if (!hooked) {
    const editorBox = page.locator('.compiler-editor-host .monaco-editor');
    await editorBox.click({ position: { x: 60, y: 30 } });
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.insertText(text);
  }
  await sleep(300);
}

async function selectMode(page, label) {
  await page.locator('aside button', { hasText: label }).first().click();
}

async function clickRun(page) {
  await page.locator('aside button[aria-label="运行程序"], aside button[aria-label="检查程序"]').first().click();
}

const draft = (code, lang) => `ysc-cp-draft-${code}-${lang}`;

async function main() {
  const browser = await chromium.launch({ args: ['--enable-unsafe-shared-array-buffer-gc'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  const shot = (name) => page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });

  /* ============ 0. 页面加载 + 面板展开 ============ */
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitForDock(page);
  check('首页出现编译器舌片', true);
  await page.evaluate(() => localStorage.setItem('ysc-cp-settings-v1', JSON.stringify({ timeoutSec: 5 })));
  await reload(page);

  const p0 = problems[0];
  const p1 = problems[1] ?? problems[0];

  await openPanel(page);
  await page.waitForSelector('aside .monaco-editor', { timeout: 60000 });
  check('面板展开且 Monaco 编辑器挂载', true);
  await page.evaluate(() => document.body.classList.contains('compiler-open'));
  const mainMargin = await page.evaluate(() => getComputedStyle(document.querySelector('main')).marginRight);
  check('xl 布局：主内容让位面板（42rem）', mainMargin === '672px', `marginRight=${mainMargin}`);
  await shot('01-panel-open');

  /* ============ 1. C++ 样例对拍：AC（打印样例1期望输出） ============ */
  const expected0 = (p0.statement?.examples?.[0]?.output ?? '').trim();
  await setDraft(page, p0.code, 'cpp', `#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    string s;\n    getline(cin, s); // 读掉首行\n    cout << R"CPP(${expected0})CPP";\n    return 0;\n}\n`);
  await reload(page);
  await openPanel(page);
  await page.waitForSelector('aside .monaco-editor', { timeout: 60000 });
  await sleep(1500);
  await clickRun(page);
  console.log('  … 等待 C++ 首次编译（加载 clang22 36MB + sysroot 解包）');
  // 等结果徽章出现（首次加载上限 4 分钟）
  try {
    await page.waitForSelector('aside details summary', { timeout: 240000 });
  } catch {
    const dump = await page.evaluate(() => document.querySelector('aside[aria-label="编译器面板"]')?.innerText ?? '(no aside)');
    console.log('  !! 样例结果超时，面板内容：\n' + dump.slice(0, 1200));
    throw new Error('样例结果超时');
  }
  const passLine = await page.locator('aside[aria-label="编译器面板"]').innerText().then((t) => /通过 (\d+)\/(\d+)/.exec(t));
  check('C++ 样例对拍出结果', !!passLine, JSON.stringify(passLine));
  check('样例 1 判定 AC（打印期望输出）', await page.locator('aside details').first().innerText().then((t) => t.includes('AC')), await page.locator('aside details').first().innerText());
  await shot('02-cpp-samples-ac');

  /* ============ 2. C++ WA + RE（错误答案 / 非零退出） ============ */
  await typeCode(page, `#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    int a, b;\n    cin >> a >> b;\n    cout << "nope" << endl;\n    return 3;\n}\n`);
  await clickRun(page);
  await sleep(4000);
  await page.waitForFunction(() => {
    const t = document.querySelector('aside[aria-label="编译器面板"]')?.innerText ?? '';
    return (t.match(/(AC|WA|RE)/g) ?? []).length >= (document.querySelectorAll('aside[aria-label="编译器面板"] details').length || 1) && !t.includes('编译中');
  }, null, { timeout: 120000 });
  const verdicts = await page.locator('aside[aria-label="编译器面板"]').innerText().then((t) => (t.match(/\b(WA|RE|AC)\b/g) ?? []));
  check('错误程序全部非 AC（WA/RE）', verdicts.length > 0 && verdicts.every((v) => v !== 'AC'), JSON.stringify(verdicts));
  await shot('03-cpp-samples-wa');

  /* ============ 3. C++ 交互输入（SAB 管道） ============ */
  await selectMode(page, '交互运行');
  await typeCode(page, `#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    int a, b;\n    cin >> a >> b;\n    cout << "sum=" << (a + b) << endl;\n    return 0;\n}\n`);
  await clickRun(page);
  const inputBox = page.locator('aside input[placeholder*="等待输入"]');
  await inputBox.waitFor({ state: 'visible', timeout: 120000 });
  check('C++ 程序请求输入（need-input → 输入框激活）', true);
  await inputBox.fill('3');
  await page.keyboard.press('Enter');
  await inputBox.waitFor({ state: 'visible', timeout: 30000 });
  await inputBox.fill('4');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (document.querySelector('aside pre')?.textContent ?? '').includes('sum=7'), null, { timeout: 30000 });
  check('交互输入 3+4 → sum=7', true);
  await shot('04-cpp-interactive');

  /* ============ 4. 编译错误 → 诊断标记 ============ */
  await selectMode(page, '编译检查');
  await typeCode(page, `#include <bits/stdc++.h>\nint main() {\n    return oops;\n}\n`);
  await clickRun(page); // 检查
  await page.waitForFunction(() => /发现 \d+ 个错误/.test(document.querySelector('aside[aria-label="编译器面板"]')?.innerText ?? ''), null, { timeout: 120000 });
  const markerCount = await page.evaluate(() => document.querySelectorAll('aside .monaco-editor .squiggly-error, aside .monaco-editor .view-zones, .monaco-editor .glyph-margin-widgets .cgmr').length);
  const asideText = await page.locator('aside[aria-label="编译器面板"]').innerText();
  check('编译错误被诊断捕获', /use of undeclared identifier|错误/.test(asideText), asideText.slice(-300));
  await shot('05-cpp-check-error');

  /* ============ 5. C++ clang 补全（Ctrl+Space） ============ */
  await selectMode(page, '交互运行');
  await typeCode(page, '#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    std::vec');
  // 光标移到 vec 后：Ctrl+Space 触发补全
  await page.keyboard.press('ControlOrMeta+ ');
  console.log('  … 等待 clang -code-completion-at');
  const suggestVisible = await page
    .waitForSelector('.monaco-editor .suggest-widget.visible', { timeout: 60000 })
    .then(() => true)
    .catch(() => false);
  // clang -cc1 补全要几秒，等 suggestions 真正渲染（widget 先显示 Loading...）
  const suggestText = await page
    .waitForFunction(
      () => {
        const el = document.querySelector('.monaco-editor .suggest-widget');
        const t = el?.innerText ?? '';
        return t.trim() && !/loading/i.test(t) ? t : '';
      },
      null,
      { timeout: 60000 },
    )
    .then((h) => h.jsonValue())
    .catch(() => '');
  check('clang 补全弹出（含 vector）', suggestVisible && /vector/i.test(suggestText), `visible=${suggestVisible} text=${suggestText.slice(0, 120)}`);
  await page.keyboard.press('Escape');
  await shot('06-cpp-completion');

  /* ============ 6. 停止按钮（死循环终止 + 复用恢复） ============ */
  await typeCode(page, '#include <bits/stdc++.h>\nint main(){ for(;;); }\n');
  await clickRun(page);
  await sleep(2000); // 等进入死循环（设置里超时 5s，必须赶在看门狗前手动停止）
  await page.locator('aside button', { hasText: '停止' }).first().click();
  await page.waitForFunction(() => (document.querySelector('aside[aria-label="编译器面板"]')?.innerText ?? '').includes('已手动终止'), null, { timeout: 15000 });
  check('停止按钮终止死循环', true);
  // 终止后再次运行应能恢复（worker 重建）
  await typeCode(page, '#include <bits/stdc++.h>\nint main(){ std::cout << "back-alive"; }\n');
  await clickRun(page);
  await page.waitForFunction(() => (document.querySelector('aside pre')?.textContent ?? '').includes('back-alive'), null, { timeout: 240000 });
  check('终止后 worker 自动重建并可再次运行', true);
  await shot('07-cpp-stop-recover');

  /* ============ 7. 收起/展开 + 状态保留 ============ */
  const consoleBefore = await page.locator('aside pre').first().textContent();
  // 用面板头部的 X（舌片按钮展开时被面板本体盖住，点击会被 <pre> 拦截）
  await page.locator('aside[aria-label="编译器面板"] button[aria-label="收起编译器"]').click();
  await sleep(400);
  const bodyShifted = await page.evaluate(() => document.body.classList.contains('compiler-open'));
  check('收起后主内容恢复', bodyShifted === false);
  await shot('08-panel-closed');
  await openPanel(page);
  const consoleAfter = await page.locator('aside pre').first().textContent();
  check('收起再展开后控制台状态保留', consoleBefore === consoleAfter && consoleAfter.includes('back-alive'));

  /* ============ 8. 设置页：真实下载 Pyodide（jsDelivr） ============ */
  await page.locator('button[aria-label="翻译设置"], button[title="翻译设置"]').first().click();
  await page.waitForSelector('text=浏览器编译器', { timeout: 10000 });
  await shot('09-settings-compiler');
  await page.locator('div.rounded-md.border', { hasText: 'Python ·' }).last().locator('button', { hasText: '下载' }).first().click();
  console.log('  … 真实下载 Pyodide（jsDelivr，约 12-15MB）');
  // 精确等 Python 卡片出现「已下载」徽章（C++ 卡片常驻「已下载」，全页匹配会假阳性）
  await page
    .locator('div.rounded-md.border', { hasText: 'Python ·' })
    .last()
    .getByText('已下载')
    .waitFor({ timeout: 300000 });
  check('Pyodide 运行时真实下载完成（Cache API）', true);
  await shot('10-pyodide-downloaded');
  // 关闭设置弹窗（「完成」在长滚动区底部，视口外；头部 ✕ 始终可达）
  await page.locator('button[aria-label="关闭"]').last().click();
  await sleep(300);

  /* ============ 9. Python：运行 + 固定 stdin + 交互 ============ */
  await openPanel(page); // 弹窗交互后面板可能处于收起态
  await page.locator('aside button', { hasText: 'Python' }).first().click();
  await sleep(500);
  await selectMode(page, '样例测试');
  await typeCode(page, 'import sys\n\ndata = sys.stdin.read()\nprint("got:", data.strip().splitlines()[0] if data.strip() else "empty")\nprint("py-ok")\n');
  await clickRun(page);
  console.log('  … 等待 Pyodide 加载 + 运行');
  // 断言锚定 details 里的「实际输出」（aside 全文会匹配到编辑器源码，曾假阳性）
  await page.waitForFunction(() => {
    const d = document.querySelector('aside[aria-label="编译器面板"] details');
    return d && /py-ok/.test(d.textContent);
  }, null, { timeout: 300000 });
  check('Python 运行出输出（py-ok）', true);
  const pyAside = await page.locator('aside[aria-label="编译器面板"] details').first().innerText();
  check('Python 固定 stdin 喂入生效（读到样例输入）', /got: 9 5/.test(pyAside) && !/got: empty/.test(pyAside), pyAside.slice(0, 300));
  await shot('11-python-run');

  // 交互：input() → feed
  await selectMode(page, '交互运行');
  await typeCode(page, 'name = input("who? ")\nprint("hi", name)\n');
  await clickRun(page);
  const pyInput = page.locator('aside input[placeholder*="等待输入"]');
  await pyInput.waitFor({ state: 'visible', timeout: 240000 });
  await pyInput.fill('sam');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (document.querySelector('aside pre')?.textContent ?? '').includes('hi sam'), null, { timeout: 60000 });
  check('Python 交互输入 → hi sam', true);
  await shot('12-python-interactive');

  /* ============ 10. Python 语法检查 + 中断 ============ */
  await selectMode(page, '编译检查');
  await typeCode(page, 'def oops(:\n    pass\n');
  await clickRun(page);
  await page.waitForFunction(() => /发现 \d+ 个语法错误|语法错误/.test(document.querySelector('aside[aria-label="编译器面板"]')?.innerText ?? ''), null, { timeout: 120000 });
  check('Python 语法错误被 lint 捕获', true);
  await shot('13-python-lint');

  await selectMode(page, '交互运行');
  await typeCode(page, 'while True:\n    pass\n');
  await clickRun(page);
  console.log('  … 等待 KeyboardInterrupt 中断（timeoutSec=5）');
  await page.waitForFunction(
    () => /(中断|超时|已手动终止|KeyboardInterrupt)/.test(document.querySelector('aside[aria-label="编译器面板"]')?.innerText ?? ''),
    null,
    { timeout: 60000 },
  );
  check('Python 死循环被中断/超时终止', true);
  await shot('14-python-interrupt');

  /* ============ 11. 草稿持久化 ============ */
  await selectMode(page, '样例测试');
  await typeCode(page, 'print("draft-check")\n');
  await sleep(900); // 等防抖写盘
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('aside .monaco-editor', { timeout: 60000 }).catch(async () => {
    await openPanel(page);
  });
  await openPanel(page);
  await page.waitForSelector('aside .monaco-editor', { timeout: 60000 });
  const draftBack = await page.evaluate((code) => localStorage.getItem(`ysc-cp-draft-${code}-python`), problems[0].code);
  check('草稿写入 localStorage 并随重载恢复', (draftBack ?? '').includes('draft-check'), String(draftBack).slice(0, 80));

  /* ============ 12. 页面错误 ============ */
  // React #418 为仓库已知历史遗留水合警告（AGENTS.md 高频坑 #7），非编译器回归
  const realErrors = pageErrors.filter((e) => !/ResizeObserver|AbortError|等级域|React error #418/i.test(e));
  check('无未捕获页面异常', realErrors.length === 0, JSON.stringify(realErrors.slice(0, 3)));

  await browser.close();
  console.log(`\n==== E2E 汇总: ${passed} 通过, ${failed} 失败 ====`);
  if (failures.length) {
    console.log('失败项:', failures.join(' | '));
    process.exit(1);
  }
}

main().catch((exn) => {
  console.error('E2E 异常退出:', exn);
  process.exit(2);
});
