/**
 * Shared Codeforces statement fetching + parsing.
 *
 * parseStatementHtml: turns a codeforces problem page (raw or DOM-serialized
 * HTML) into the statement schema used by data/statements/*.json.
 *
 * fetchStatementViaBrowser: drives a real Chromium (Playwright) through the
 * Cloudflare challenge — a plain HTTP client gets 403 "Just a moment...",
 * a real JS engine clears it automatically.
 */
export function decodeEntities(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'", apos: "'" };
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&(amp|lt|gt|quot|nbsp|#39|apos);/g, (_, e) => map[e]);
}

function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|li|h\d)>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  ).trim();
}

// Section content -> ordered blocks: plain paragraphs + <pre> blocks preserved.
function htmlToBlocks(html) {
  const out = [];
  const re = /<pre[^>]*>([\s\S]*?)<\/pre>|<p>([\s\S]*?)<\/p>|<li[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) {
      const text = decodeEntities(m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\n+$/, '');
      if (text.trim()) out.push({ pre: text });
    } else {
      const text = stripTags(m[2] ?? m[3]);
      if (text) out.push(text);
    }
  }
  if (!out.length) {
    const one = stripTags(html);
    if (one) out.push(one);
  }
  return out;
}

function blocksToParagraphs(blocks) {
  // Keep {pre} blocks; collapse plain strings into paragraphs
  return blocks;
}

function parseSamples(html) {
  return [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)]
    .map((m) =>
      decodeEntities(
        m[1]
          .replace(/<br\s*\/?>/gi, '\n')
          .replace(/<\/(?:div|p)>/gi, '\n')
          .replace(/<[^>]+>/g, ''),
      ).replace(/\s+$/, ''),
    )
    .filter((s) => s.length);
}

export function parseStatementHtml(pageHtml) {
  const start = pageHtml.indexOf('<div class="problem-statement"');
  if (start === -1) return null;
  let html = pageHtml.slice(start);
  const end = html.search(/<div id="footer"|<script/);
  if (end > 0) html = html.slice(0, end);

  const titleMatch = html.match(/<div class="title">\s*([A-Z][.)][^<]*)</);
  // DOM form: <div class="time-limit"><div class="property-title">time limit per test</div>3 seconds</div>
  // Legacy form: <div class="property-title">time limit per test: 3 seconds</div>
  const timeMatch =
    html.match(/time limit per test<\/div>\s*([^<]+)/i) || html.match(/time limit per test:?\s*([^<]+)</i);
  const memMatch =
    html.match(/memory limit per test<\/div>\s*([^<]+)/i) || html.match(/memory limit per test:?\s*([^<]+)</i);

  const sectionHtml = (cls) => {
    const m = html.match(new RegExp(`<div class="${cls}">([\\s\\S]*?)(?=<div class="(?:input-specification|output-specification|note|sample-tests)|<script|$)`));
    return m ? m[1] : '';
  };

  // Legend = everything between the header div and the input specification.
  const legendHtml = html.match(/<\/div>\s*([\s\S]*?)<div class="input-specification">/);
  const noteMatch = html.match(/<div class="note">([\s\S]*?)(?=<div class="(?:sample-tests|note)|<script|$)/);

  const samples = parseSamples(html);
  const examples = [];
  for (let i = 0; i + 1 < samples.length; i += 2) examples.push({ input: samples[i], output: samples[i + 1] });

  const statement = {
    title: titleMatch ? decodeEntities(titleMatch[1].trim()) : null,
    timeLimit: timeMatch ? decodeEntities(timeMatch[1].trim()) : null,
    memoryLimit: memMatch ? decodeEntities(memMatch[1].trim()) : null,
    sections: {
      legend: legendHtml ? blocksToParagraphs(htmlToBlocks(legendHtml[1])) : [],
      input: htmlToBlocks(sectionHtml('input-specification')),
      output: htmlToBlocks(sectionHtml('output-specification')),
      ...(noteMatch ? { note: htmlToBlocks(noteMatch[1]) } : {}),
    },
    examples,
  };
  if (!statement.title || !statement.sections.legend.length) return null;
  return statement;
}

const STEALTH_ARGS = ['--disable-blink-features=AutomationControlled', '--no-sandbox'];
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch statements for a list of {code, url} using one shared browser.
 *
 * Two-phase strategy against Cloudflare:
 *   1. try headless bundled Chromium (works in CI, no display needed);
 *   2. if even the first page is stuck on the challenge, relaunch as
 *      headful real Chrome (channel: "chrome") — behaves like manual browsing.
 *
 * Returns a Map(code -> statement|null). Never throws per-item.
 */
export async function fetchStatementViaBrowser(items, { delayMs = 5000, onResult } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.warn('playwright not installed, skipping browser statement fetch');
    return new Map();
  }
  if (!items.length) return new Map();

  async function openSession(kind) {
    const launchOptions =
      kind === 'chrome-headful'
        ? { channel: 'chrome', headless: false, args: ['--disable-blink-features=AutomationControlled'] }
        : { headless: true, args: STEALTH_ARGS };
    const browser = await chromium.launch(launchOptions);
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: 'en-US', userAgent: UA });
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    const page = await ctx.newPage();
    return { browser, page };
  }

  async function grab(page, url) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch {
      return null;
    }
    for (let t = 0; t < 25; t++) {
      if ((await page.locator('div.problem-statement').count()) > 0) {
        try {
          return parseStatementHtml(await page.content());
        } catch {
          return null;
        }
      }
      const title = await page.title();
      if (!/just a moment|checking your browser|security verification/i.test(title) && t > 4) return null;
      await sleep(2000);
    }
    return null;
  }

  const results = new Map();
  const kinds = ['headless', 'chrome-headful'];
  let kindIdx = 0;
  let { browser, page } = await openSession(kinds[kindIdx]);

  // Adaptive recovery: after CONSECUTIVE_FAILS blocked pages in a row, close the
  // browser, cool down (Cloudflare score decays), and switch browser mode.
  const CONSECUTIVE_FAILS = 3;
  const COOLDOWN_MS = 90000;
  let consecutiveFails = 0;

  for (let i = 0; i < items.length; i++) {
    const { code, url } = items[i];
    let statement = await grab(page, url);
    if (!statement) {
      await sleep(10000);
      statement = await grab(page, url); // one polite retry after a pause
    }

    if (statement) consecutiveFails = 0;
    else if (++consecutiveFails >= CONSECUTIVE_FAILS && i < items.length - 1) {
      console.log(
        `  ${consecutiveFails} consecutive failures — cooling down ${COOLDOWN_MS / 1000}s and switching browser mode…`,
      );
      await browser.close().catch(() => {});
      await sleep(COOLDOWN_MS);
      kindIdx = (kindIdx + 1) % kinds.length;
      ({ browser, page } = await openSession(kinds[kindIdx]));
      consecutiveFails = 0;
      // retry this item immediately in the new session
      statement = await grab(page, url);
      if (statement) consecutiveFails = 0;
    }

    results.set(code, statement);
    if (onResult) await onResult(code, statement, i + 1, items.length);
    if (i < items.length - 1) await sleep(delayMs + Math.random() * 2000);
    if (i > 0 && i % 25 === 0) await sleep(15000); // cool-down every 25 pages
  }

  await browser.close().catch(() => {});
  return results;
}
