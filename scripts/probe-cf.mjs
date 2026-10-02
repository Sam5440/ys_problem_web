// Probe: can a real Chromium pass the Cloudflare challenge on codeforces.com?
import { chromium } from 'playwright';

const url = process.argv[2] || 'https://codeforces.com/gym/106732/problem/C';
const mode = process.argv[3] || 'headless'; // headless | chrome | headful

const launchOptions = {
  headless: mode !== 'headful',
  args: ['--disable-blink-features=AutomationControlled', '--no-sandbox'],
};
if (mode === 'chrome') launchOptions.channel = 'chrome';

const browser = await chromium.launch(launchOptions);
const ctx = await browser.newContext({
  viewport: { width: 1366, height: 900 },
  locale: 'en-US',
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
});
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const page = await ctx.newPage();
const t0 = Date.now();
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });

let verdict = 'unknown';
for (let i = 0; i < 20; i++) {
  const title = await page.title();
  const hasStmt = await page.locator('div.problem-statement').count();
  if (hasStmt > 0) {
    verdict = 'PASS';
    break;
  }
  if (/just a moment|checking your browser|attention required/i.test(title)) {
    await page.waitForTimeout(1500);
    continue;
  }
  // page loaded but no statement (maybe 403 page or login-required page)
  const bodyHead = await page.evaluate(() => document.body?.innerText?.slice(0, 200) || '');
  if (/403|forbidden|denied/i.test(bodyHead)) verdict = 'BLOCKED';
  else if (hasStmt === 0 && i > 10) verdict = 'LOADED_NO_STATEMENT';
  await page.waitForTimeout(1500);
}

const title = await page.title();
const html = verdict === 'PASS' ? await page.content() : '';
console.log(JSON.stringify({ verdict, title, ms: Date.now() - t0, htmlLength: html.length }));
if (verdict === 'PASS') {
  const { writeFile } = await import('node:fs/promises');
  await writeFile('/tmp/pw_probe.html', html);
}
await browser.close();
