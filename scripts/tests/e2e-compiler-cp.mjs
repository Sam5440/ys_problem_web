#!/usr/bin/env node
/**
 * 浏览器编译器端到端测试 —— 算法竞赛场景专项（真实 worker 链路）。
 *
 * 与 e2e-compiler.mjs（基础功能 22 项）互补，本套件覆盖竞赛向场景与
 * 严格矩阵发现的产品 bug 的浏览器回归：
 *  - C++ 标准切换真实生效（c++17 拒绝 concepts / c++20 通过）——回归「运行
 *    未传 -std」bug
 *  - 样例判题：RE（除零 trap / 栈溢出）、链接失败、trap 输出不混 JS 堆栈、
 *    行尾空白与文末空行容忍
 *  - 交互：多轮查询的 flush 时序（先出 Q0 再等输入）、C++ 中文输出、
 *    Python 超长行输入（10k 字符）、Python 异常展示
 *  - Python 多行输出不粘连——回归 pyodide batched 吞换行 bug
 *  - 模板重置、Pyodide 0.29.3 版本切换（真实 jsDelivr 下载）
 *
 * 前置：`npm run build && npx next start -p 3100`（public/compiler/ 本地存在）。
 * 用法：node scripts/tests/e2e-compiler-cp.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = process.env.BASE_URL || 'http://localhost:3100';
const SHOT_DIR = '/tmp/ys-e2e-cp';
fs.mkdirSync(SHOT_DIR, { recursive: true });

const daily = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/daily.json'), 'utf8'));
const problems = daily.days[0].problems;
const p0 = problems[0];
const exCount = p0.statement?.examples?.length ?? 0;

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
  await page.waitForSelector(
    'button[aria-label="展开编译器"], aside[aria-label="编译器面板"]',
    { timeout: 20000 },
  );
}

async function seedSettings(page, patch) {
  await page.evaluate((p) => {
    const key = 'ysc-cp-settings-v1';
    let prev = {};
    try { prev = JSON.parse(localStorage.getItem(key) ?? '{}'); } catch {}
    localStorage.setItem(key, JSON.stringify({
      timeoutSec: 20,
      defaultMode: 'samples',
      ...prev,
      ...p,
      templates: { ...(prev.templates || {}), ...(p.templates || {}) },
    }));
  }, patch);
}

async function setDraft(page, code, lang = 'cpp', problemCode = p0.code) {
  await page.evaluate(([k, l, v]) => localStorage.setItem(`ysc-cp-draft-${k}-${l}`, v), [problemCode, lang, code]);
}

async function openPanel(page) {
  const hidden = await page.locator('aside[aria-label="编译器面板"]').getAttribute('aria-hidden');
  if (hidden === 'true') {
    await page.locator('button[aria-label="展开编译器"]').click();
  }
  await page.locator('aside[aria-label="编译器面板"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForFunction(() => document.querySelector('aside[aria-label="编译器面板"]')?.getAttribute('aria-hidden') === 'false', null, { timeout: 5000 });
}

async function typeCode(page, text) {
  await page.evaluate((t) => {
    const hook = window.__ysMonaco;
    const model = hook.editor.getModel();
    model.setValue(t);
    hook.editor.setPosition(model.getFullModelRange().getEndPosition());
    hook.editor.focus();
  }, text);
  await sleep(300);
}

async function selectMode(page, label) {
  await page.locator('aside button', { hasText: label }).first().click();
}

async function clickRun(page) {
  await page.locator('aside button[aria-label="运行程序"], aside button[aria-label="检查程序"]').first().click();
}

const asideText = (page) => page.locator('aside[aria-label="编译器面板"]').innerText();
const consoleText = (page) => page.locator('aside pre').first().textContent();

/** 经设置面板下载当前所选版本的 Pyodide（跨源运行时必须先进 Cache API 才能运行）。 */
async function downloadPyodide(page) {
  await page.locator('button[aria-label="翻译设置"], button[title="翻译设置"]').first().click();
  await page.waitForSelector('text=浏览器编译器', { timeout: 10000 });
  await page.locator('div.rounded-md.border', { hasText: 'Python ·' }).last().locator('button', { hasText: '下载' }).first().click();
  await page
    .locator('div.rounded-md.border', { hasText: 'Python ·' })
    .last()
    .getByText('已下载')
    .waitFor({ timeout: 300000 });
  await page.locator('button[aria-label="关闭"]').last().click();
  await sleep(300);
  await openPanel(page);
}

/** 等样例运行出结论（通过 N/M 徽章或 ✗ 错误行）。 */
async function waitSamplesDone(page, timeout = 240000) {
  await page.waitForFunction(
    () => /通过 \d+\/\d+|✗/.test(document.querySelector('aside[aria-label="编译器面板"]')?.innerText ?? ''),
    null,
    { timeout },
  );
}

async function main() {
  const browser = await chromium.launch({ args: ['--enable-unsafe-shared-array-buffer-gc'] });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));
  const shot = (name) => page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: false });

  const CONCEPTS_SRC = `#include <concepts>\n#include <iostream>\ntemplate <std::integral T>\nT sq(T x){ return x * x; }\nint main(){\n    // if constexpr + concepts 是 C++20 特性：c++17 拒绝编译、c++20 通过\n    if constexpr (std::integral<int>) {\n        std::cout << R"CPP(${(p0.statement?.examples?.[0]?.output ?? '').replace(/\r/g, '')})CPP";\n    }\n}\n`;
  const EXPECTED0 = (p0.statement?.examples?.[0]?.output ?? '').trim();

  /* ====== 轮 A：c++17 设置 → concepts 必须编译失败（运行也用所选标准） ======
   * 断言走「交互运行」：samples 模式不渲染 console pre，编译失败的 ✗ 只在
   * 交互/检查模式的控制台可见（首跑曾因此误判超时）。 */
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await waitForDock(page);
  await seedSettings(page, { cppStd: 'c++17' });
  await setDraft(page, CONCEPTS_SRC);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDock(page);
  await openPanel(page);
  await page.waitForSelector('aside .monaco-editor', { timeout: 60000 });
  await selectMode(page, '交互运行');
  await sleep(1500);
  console.log('  … 轮 A：clang 冷启动 + c++17 编译 concepts');
  await clickRun(page);
  // 等最终态（✗ 由 catch 落进 console，clang 日志里的 error: 是中间态不能作准）
  await page.waitForFunction(
    () => /✗|编译失败/.test(document.querySelector('aside pre')?.textContent ?? ''),
    null,
    { timeout: 240000 },
  );
  {
    const pre = await consoleText(page);
    check('c++17 下 concepts 代码运行编译失败（-std 真实生效）', /✗|编译失败/.test(pre), pre.slice(-400));
  }
  await shot('cp-01-concepts-std17-fail');

  /* ====== 轮 B：c++20 → 同代码 AC + 样例谱系 ====== */
  await seedSettings(page, { cppStd: 'c++20' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDock(page);
  await openPanel(page);
  await page.waitForSelector('aside .monaco-editor', { timeout: 60000 });
  await sleep(1500);

  console.log('  … 轮 B：clang 冷启动 + c++20 对拍');
  await clickRun(page);
  await waitSamplesDone(page);
  {
    const t = await asideText(page);
    check('c++20 下同一代码样例全 AC（-std 修复回归）', t.includes(`通过 ${exCount}/${exCount}`), t.slice(0, 300));
  }
  await shot('cp-02-concepts-std20-ac');

  // 行尾空白 + 文末空行容忍
  const exp1 = (p0.statement?.examples?.[0]?.output ?? '').replace(/\r/g, '');
  const padded = exp1.split('\n').map((l) => l + '   ').join('\n') + '\n\n\n';
  await typeCode(page, `#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    string s;\n    getline(cin, s);\n    cout << R"CPP(${padded})CPP";\n    return 0;\n}\n`);
  await clickRun(page);
  await waitSamplesDone(page);
  {
    const first = await page.locator('aside details').first().innerText();
    check('行尾空白与文末空行判为 AC（OJ 归一化语义）', first.includes('AC'), first.slice(0, 300));
  }
  await shot('cp-03-trailing-space-ac');

  // 除零 → RE 且实际输出无 JS 堆栈（trap 清理回归）
  // volatile load 作除数：优化器无法假设其值为 0，除法不可折叠 → 运行期必 trap
  // （volatile*0 乘法与 asm "+r" 屏障都会被 clang 折叠掉，Node 矩阵已验证此写法）
  await typeCode(page, `#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    int x = 7;\n    if (!(cin >> x)) x = 7;\n    volatile int vz = 0;\n    int zero = vz;\n    cout << (x / zero) << endl;\n    return 0;\n}\n`);
  await clickRun(page);
  await waitSamplesDone(page);
  {
    const t = await asideText(page);
    const hasRE = /\bRE\b/.test(t);
    const clean = !/RuntimeError|at wasm|at App\.run/.test(t);
    check('除零 trap 判 RE', hasRE, t.slice(0, 300));
    check('trap 后实际输出不混入 JS 堆栈（cleanStdout 回归）', clean, t.slice(0, 500));
  }
  await shot('cp-04-divzero-re');

  // 栈溢出 → RE 且有限时间返回
  await typeCode(page, `#include <bits/stdc++.h>\nusing namespace std;\nlong long f(long long n){ volatile char pad[1024]; pad[0] = (char)n; return n <= 0 ? 0 : 1 + f(n - 1); }\nint main(){ cout << f(100000) << endl; }\n`);
  await clickRun(page);
  const t0overflow = Date.now();
  await waitSamplesDone(page, 120000);
  {
    const t = await asideText(page);
    check('栈溢出判 RE（有限时间）', /\bRE\b/.test(t) && Date.now() - t0overflow < 100000, t.slice(0, 300));
  }
  await shot('cp-05-stack-overflow-re');

  // 链接错误 → ✗ 链接失败（不崩 worker）。走交互模式：samples 模式不渲染
  // console pre，✗ 不可见（首跑曾在此误等 120s 超时）
  await selectMode(page, '交互运行');
  await sleep(400);
  await typeCode(page, `int f(int);\nint main(){ return f(1); }\n`);
  await clickRun(page);
  await page.waitForFunction(
    () => /链接失败|undefined symbol/.test(document.querySelector('aside pre')?.textContent ?? ''),
    null,
    { timeout: 120000 },
  );
  check('链接错误以 ✗ 链接失败 呈现', true);
  await shot('cp-06-link-error');
  // worker 存活：随后正常程序仍可跑完判题（对样例输出判 WA 也算链路健康）
  await selectMode(page, '样例测试');
  await sleep(400);
  await typeCode(page, `#include <bits/stdc++.h>\nusing namespace std;\nint main(){ string s; getline(cin, s); cout << "alive"; }\n`);
  await clickRun(page);
  await waitSamplesDone(page);
  {
    const t = await asideText(page);
    check('链接失败后 worker 存活并继续判题', /通过 \d+\/\d+/.test(t), t.slice(0, 200));
  }

  /* ====== 轮 C/D：交互场景 + 模板（同页装载） ====== */
  await selectMode(page, '交互运行');

  // 多轮查询 flush 时序：Q0 出现在输入框激活之后（endl 先冲刷再阻塞读）
  await typeCode(page, `#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    int n;\n    cin >> n;\n    for (int i = 0; i < n; i++){\n        cout << "Q" << i << endl;\n        int r;\n        cin >> r;\n    }\n    cout << "OK" << n << endl;\n    return 0;\n}\n`);
  await clickRun(page);
  const inputBox = page.locator('aside input[placeholder*="等待输入"]');
  await inputBox.waitFor({ state: 'visible', timeout: 180000 });
  await inputBox.fill('2');
  await page.keyboard.press('Enter');
  await inputBox.waitFor({ state: 'visible', timeout: 30000 });
  {
    const pre = await consoleText(page);
    check('交互 flush 时序：输入框激活前 Q0 已冲刷可见', pre.includes('Q0'), pre.slice(-300));
  }
  await inputBox.fill('1');
  await page.keyboard.press('Enter');
  await inputBox.waitFor({ state: 'visible', timeout: 30000 });
  {
    const pre = await consoleText(page);
    check('第二轮查询 Q1 可见', pre.includes('Q1'), pre.slice(-300));
  }
  await inputBox.fill('1');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (document.querySelector('aside pre')?.textContent ?? '').includes('OK2'), null, { timeout: 30000 });
  check('多轮交互收敛 OK2', true);
  await shot('cp-07-interactive-multi-round');

  // C++ 中文输出
  await typeCode(page, `#include <bits/stdc++.h>\nint main(){ std::cout << "你好，竞赛世界" << std::endl; }\n`);
  await clickRun(page);
  await page.waitForFunction(() => (document.querySelector('aside pre')?.textContent ?? '').includes('你好，竞赛世界'), null, { timeout: 120000 });
  check('C++ UTF-8 中文输出原样', true);
  await shot('cp-08-cpp-unicode');

  /* ====== 编辑器补全 / 签名提示 / 头文件补全（真实键盘触发 quickSuggestions） ======
   * 程序化编辑（executeEdits/setValue）不触发 suggest，preset 走 evaluate、
   * 触发片段走真实键盘。签名提示的 DOM 类名是 parameter-hints-widget。 */
  const typeFresh = async (preset, typed) => {
    await page.evaluate((t) => {
      const { editor } = window.__ysMonaco;
      const model = editor.getModel();
      editor.executeEdits('e2e', [{ range: model.getFullModelRange(), text: t }]);
      editor.setPosition(model.getFullModelRange().getEndPosition());
      editor.focus();
    }, preset);
    await page.keyboard.type(typed, { delay: 30 });
    await sleep(700);
  };
  const suggestRows = async () => page.evaluate(() => {
    const w = document.querySelector('.monaco-editor .suggest-widget');
    if (!w || !w.classList.contains('visible')) return [];
    return [...w.querySelectorAll('.monaco-list-row')].map((e) => e.textContent).slice(0, 15);
  });
  const dismiss = () => page.keyboard.press('Escape').then(() => sleep(200));

  const CPP_PRELUDE = '#include <bits/stdc++.h>\nusing namespace std;\nint main(){\n    ';
  await typeFresh(CPP_PRELUDE, 'co');
  {
    const rows = await suggestRows();
    check('打字即补全：co 弹出 cout（裸名静态表）', rows.some((r) => r.includes('cout')), JSON.stringify(rows.slice(0, 6)));
    await dismiss();
  }
  await typeFresh('#include <bits/stdc++.h>\nusing namespace std;\n', 'sort(');
  {
    const sig = await page.evaluate(() => {
      const w = document.querySelector('.monaco-editor .parameter-hints-widget');
      return w && w.getClientRects().length ? w.textContent : '';
    });
    check('sort( 弹出签名提示（原型 + 说明）', /void sort\(RandomIt first, RandomIt last/.test(sig), sig.slice(0, 80));
    await dismiss();
  }
  await typeFresh('', '#include <');
  {
    const rows = await suggestRows();
    check('#include < 弹出头文件补全', rows.some((r) => r.includes('bits/stdc++.h')), JSON.stringify(rows.slice(0, 5)));
    await dismiss();
  }
  await typeFresh('#include <bits/stdc++.h>\nusing namespace std;\nvector<int> v;\n', 'v.');
  {
    const rows = await suggestRows();
    check('成员补全：v. 弹出成员表', rows.length > 0 && rows.some((r) => r.includes('begin')), JSON.stringify(rows.slice(0, 6)));
  }
  // 续打部分词仍是成员上下文（isCppMemberAccess 剥部分词），过滤出 push_back——
  // 曾因只看紧邻字符在 v.p 处退回普通表导致成员候选消失
  await page.keyboard.type('pu', { delay: 30 });
  await sleep(600);
  {
    const rows = await suggestRows();
    check('成员过滤：v.pu 过滤出 push_back', rows.some((r) => r.includes('push_back')), JSON.stringify(rows.slice(0, 6)));
    await dismiss();
  }
  await shot('cp-08b-completion');

  // Python 超长行输入（SAB 行读，10k 字符）。首次用 Python：先经设置面板
  // 真实下载 Pyodide（jsDelivr），跨源运行时未缓存时 py-client 拒绝运行
  console.log('  … 真实下载 Pyodide 314（jsDelivr，约 12-15MB）');
  await downloadPyodide(page);
  check('Pyodide 314 运行时真实下载完成（Cache API）', true);
  await page.locator('aside button', { hasText: 'Python' }).first().click();
  await sleep(500);
  const bigLine = 'x'.repeat(10001);
  await typeCode(page, 'data = input()\nprint(len(data), data[-1])\n');
  await clickRun(page);
  try {
    await inputBox.waitFor({ state: 'visible', timeout: 240000 });
  } catch (exn) {
    console.error('  [debug] 输入框未出现，控制台尾部：', (await consoleText(page)).slice(-600));
    throw exn;
  }
  await inputBox.fill(bigLine);
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (document.querySelector('aside pre')?.textContent ?? '').includes('10001 x'), null, { timeout: 60000 });
  check('Python 交互超长行（10001 字符）完整读取', true);
  await shot('cp-09-python-big-line');

  // Python 异常展示
  await typeCode(page, 'print("before")\nx = 1 // 0\n');
  await clickRun(page);
  await page.waitForFunction(() => /ZeroDivisionError/.test(document.querySelector('aside pre')?.textContent ?? ''), null, { timeout: 120000 });
  check('Python 运行时异常 traceback 呈现', true);
  await shot('cp-10-python-exception');

  // Python 多行输出不粘连（batched 换行修复回归）
  await typeCode(page, 'print("A")\nprint("B")\nprint("C")\n');
  await clickRun(page);
  await page.waitForFunction(() => /A\nB\nC/.test(document.querySelector('aside pre')?.textContent ?? ''), null, { timeout: 120000 });
  check('Python 多行输出逐行呈现（换行修复回归）', true);
  await shot('cp-11-python-multiline');

  // Python emoji 输出
  await typeCode(page, 'print("结果 🎉 ok")\n');
  await clickRun(page);
  await page.waitForFunction(() => (document.querySelector('aside pre')?.textContent ?? '').includes('🎉'), null, { timeout: 120000 });
  check('Python emoji 输出原样', true);

  // 模板重置（当前语言为 Python）
  await page.evaluate(() => {
    const key = 'ysc-cp-settings-v1';
    const v = JSON.parse(localStorage.getItem(key) ?? '{}');
    v.templates = { ...(v.templates || {}), python: 'answer = int(input())\nprint(answer * 2)\n' };
    localStorage.setItem(key, JSON.stringify(v));
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDock(page);
  await openPanel(page);
  await page.waitForSelector('aside .monaco-editor', { timeout: 60000 });
  await page.locator('aside button', { hasText: 'Python' }).first().click();
  await sleep(500);
  await page.locator('aside button', { hasText: '重置为模板' }).first().click();
  await sleep(400);
  {
    const editorCode = await page.evaluate(() => window.__ysMonaco?.editor?.getModel()?.getValue() ?? '');
    check('重置为模板注入设置中的模板', editorCode.includes('answer * 2'), editorCode.slice(0, 120));
  }

  /* ====== 轮 E：Pyodide 0.29.3 版本切换（真实下载） ====== */
  await seedSettings(page, { pythonVersion: '0.29.3' });
  await setDraft(page, 'import sys\nprint("py29-ok", sys.version_info[0], sys.version_info[1])\n', 'python');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForDock(page);
  await openPanel(page);
  await page.waitForSelector('aside .monaco-editor', { timeout: 60000 });
  await page.locator('aside button', { hasText: 'Python' }).first().click();
  await sleep(500);
  await selectMode(page, '交互运行');
  console.log('  … 轮 E：真实下载 Pyodide 0.29.3（jsDelivr ~13MB）');
  await downloadPyodide(page); // seedSettings 已把版本切到 0.29.3，卡片对应新版本需重新下载
  check('Pyodide 0.29.3 运行时真实下载完成', true);
  await selectMode(page, '交互运行');
  await typeCode(page, 'import sys\nprint("py29-ok", sys.version_info[0], sys.version_info[1])\n');
  await clickRun(page);
  await page.waitForFunction(() => (document.querySelector('aside pre')?.textContent ?? '').includes('py29-ok 3 13'), null, { timeout: 300000 });
  check('Pyodide 0.29.3 切换后可运行（Python 3.13）', true);
  await shot('cp-12-pyodide-0293');

  /* ====== 全局：页面错误过滤 ====== */
  const realErrors = pageErrors.filter((e) => !/ResizeObserver|AbortError|等级域|React error #418/i.test(e));
  check('无未过滤的页面错误', realErrors.length === 0, JSON.stringify(realErrors.slice(0, 3)));

  await browser.close();
  console.log(`\n==== E2E 竞赛场景汇总: ${passed} 通过, ${failed} 失败 ====`);
  if (failures.length) console.log('失败项：', failures.join(' | '));
  process.exit(failed ? 1 : 0);
}

main().catch((exn) => {
  console.error('E2E 异常退出:', exn);
  process.exit(2);
});
