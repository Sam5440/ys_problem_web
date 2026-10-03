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

// <img> tags are stripped like every other tag, so turn them into markdown
// image syntax first — the site renders statements through `marked`, which
// passes those through as real <img> elements.
function imgToMarkdown(imgTag) {
  const src = imgTag.match(/\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
  let url = (src ? src[1] ?? src[2] ?? src[3] : '') || '';
  url = decodeEntities(url.trim());
  if (!url) return '';
  if (url.startsWith('//')) url = 'https:' + url;
  else if (url.startsWith('/')) url = 'https://codeforces.com' + url;
  else if (!/^https?:/i.test(url)) url = 'https://codeforces.com/' + url.replace(/^\.?\//, '');
  const safe = url.replace(/\s/g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `![](${safe})`;
}

const preserveImages = (html) => String(html).replace(/<img\b[^>]*>/gi, imgToMarkdown);

// Section content -> ordered blocks: plain paragraphs + <pre> blocks preserved.
function htmlToBlocks(html) {
  const out = [];
  const re =
    /<pre[^>]*>([\s\S]*?)<\/pre>|<p>([\s\S]*?)<\/p>|<li[^>]*>([\s\S]*?)<\/li>|<img\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    if (m[1] !== undefined) {
      const text = decodeEntities(m[1].replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\n+$/, '');
      if (text.trim()) out.push({ pre: text });
    } else if (/^<img/i.test(m[0])) {
      // standalone <img> (not wrapped in <p>/<li>)
      const md = imgToMarkdown(m[0]);
      if (md) out.push(md);
    } else {
      const text = stripTags(preserveImages(m[2] ?? m[3]));
      if (text) out.push(text);
    }
  }
  if (!out.length) {
    const one = stripTags(preserveImages(html));
    if (one) out.push(one);
  }
  return out;
}

function blocksToParagraphs(blocks) {
  // Keep {pre} blocks; collapse plain strings into paragraphs
  return blocks;
}

// Index just past the </span> that closes the <span …> opening at openIdx.
function findSpanClose(s, openIdx) {
  const re = /<span\b|<\/span>/g;
  re.lastIndex = openIdx;
  let depth = 0;
  for (let m; (m = re.exec(s)); ) {
    if (m[0] === '<span') depth++;
    else if (--depth === 0) return m.index + m[0].length;
  }
  return -1;
}

// MathJax sometimes finishes before we snapshot the DOM: the $$$…$$$ text is
// gone, replaced by rendered frame spans plus <script type="math/tex"> holders.
// Restore the original TeX delimiters and drop the rendered frames, so parsing
// works no matter which side of the transformation we captured.
function unmathjax(html) {
  const stash = [];
  // The ([^>]*) tail matters: real pages carry extra attributes after the type
  // (e.g. <script type="math/tex" id="MathJax-Element-1">) — without it the
  // script survives, the later <script truncation cuts the statement in half.
  html = html.replace(/<script type="math\/tex([^"]*)"[^>]*>([\s\S]*?)<\/script>/gi, (_, mode, tex) => {
    stash.push(/display/i.test(mode) ? '$$' + tex + '$$' : '$$$' + tex + '$$$');
    return `%%ZSMJ${stash.length - 1}%%`;
  });
  if (!stash.length) return html;
  let out = '';
  let idx = 0;
  for (;;) {
    const pos = html.indexOf('<span class="MathJax"', idx);
    if (pos === -1) break;
    const close = findSpanClose(html, pos);
    const block = html.slice(pos, close === -1 ? html.length : close);
    const m = block.match(/%%ZSMJ(\d+)%%/);
    out += html.slice(idx, pos) + (m ? stash[Number(m[1])] : '');
    idx = close === -1 ? html.length : close;
  }
  return out + html.slice(idx);
}

// Index just past the </div> that closes the <div …> opening at openIdx.
function findDivClose(s, openIdx) {
  const re = /<div\b|<\/div>/g;
  re.lastIndex = openIdx;
  let depth = 0;
  for (let m; (m = re.exec(s)); ) {
    if (m[0] === '<div') depth++;
    else if (--depth === 0) return m.index + m[0].length;
  }
  return s.length;
}

// Legacy gym layout: after the header, bare divs hold the legend and sections
// labelled <div class="section-title">Input</div> etc., with sample-tests and
// note at the end. Returns {legend, input, output, note} html chunks, or null
// when no section markers exist. Non-input/output sections (e.g. Interaction)
// are folded into the legend behind a bold heading so nothing is dropped.
function parseLegacySections(html) {
  const markRe = /<div class="section-title">([^<]*)<\/div>/g;
  const marks = [...html.matchAll(markRe)];
  if (!marks.length) return null;

  const sampleIdx = html.indexOf('<div class="sample-tests"');
  const noteIdx = html.indexOf('<div class="note"');

  const headerIdx = html.indexOf('<div class="header"');
  const legendStart = headerIdx === -1 ? 0 : findDivClose(html, headerIdx);
  const firstMarkIdx = marks.length ? marks[0].index : html.length;
  const legendEnd = Math.min(
    firstMarkIdx > legendStart ? firstMarkIdx : html.length,
    sampleIdx === -1 ? html.length : sampleIdx,
    noteIdx === -1 ? html.length : noteIdx,
  );
  const legend = html.slice(legendStart, legendEnd);

  const sectionEnd = (idx) => {
    let end = html.length;
    for (const m of marks) if (m.index > idx) end = Math.min(end, m.index);
    if (sampleIdx > idx) end = Math.min(end, sampleIdx);
    if (noteIdx > idx) end = Math.min(end, noteIdx);
    return end;
  };

  let input = '';
  let output = '';
  const extras = [];
  for (const m of marks) {
    if (m.index < legendEnd) continue;
    if (sampleIdx !== -1 && m.index > sampleIdx) continue; // "Example" inside sample-tests
    const content = html.slice(m.index + m[0].length, sectionEnd(m.index));
    const t = m[1].trim().toLowerCase();
    if (t === 'input' && !input) input = content;
    else if (t === 'output' && !output) output = content;
    else if (t !== 'example' && t !== 'examples') extras.push({ title: m[1].trim(), content });
  }

  const note = noteIdx === -1 ? '' : html.slice(noteIdx + '<div class="note">'.length);

  const stripMarks = (h) => h.replace(/<div class="section-title">[^<]*<\/div>/g, '');
  const escTitle = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const extrasHtml = extras.map((e) => `<p><strong>${escTitle(e.title)}</strong></p>${e.content}`).join('');
  return {
    legend: stripMarks(legend) + extrasHtml,
    input: stripMarks(input),
    output: stripMarks(output),
    note: stripMarks(note),
  };
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
  html = unmathjax(html);
  const end = html.search(/<div id="footer"|<script/);
  if (end > 0) html = html.slice(0, end);

  // Letter may carry a digit suffix (F2. / F2) — "F2. Yet Another…". Joke
  // problems sometimes skip the letter entirely ("1121. Another Round"), so
  // accept any title text; the header's title div is the first one in document
  // order, ahead of the sample blocks' Input/Output title divs.
  const titleMatch = html.match(/<div class="title">\s*([^<]+?)\s*</);
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
  const legendHtmlMatch = (h) => h.match(/<\/div>\s*([\s\S]*?)<div class="input-specification">/)?.[1];
  const noteHtmlMatch = (h) =>
    h.match(/<div class="note">([\s\S]*?)(?=<div class="(?:sample-tests|note)|<script|$)/)?.[1];

  const samples = parseSamples(html);
  const examples = [];
  for (let i = 0; i + 1 < samples.length; i += 2) examples.push({ input: samples[i], output: samples[i + 1] });

  // Standard pages mark sections with input-specification/output-specification
  // divs. Older gym mirrors use bare divs with <div class="section-title">Input</div>
  // markers — fall back to that layout when the standard classes are absent.
  let legendHtml = legendHtmlMatch(html);
  let inputHtml = sectionHtml('input-specification');
  let outputHtml = sectionHtml('output-specification');
  let noteHtml = noteHtmlMatch(html);

  if (legendHtml === undefined) {
    const legacy = parseLegacySections(html);
    if (legacy) {
      legendHtml = legacy.legend;
      inputHtml = legacy.input;
      outputHtml = legacy.output;
      noteHtml = legacy.note;
    }
  }

  const statement = {
    title: titleMatch ? decodeEntities(titleMatch[1].trim()) : null,
    timeLimit: timeMatch ? decodeEntities(timeMatch[1].trim()) : null,
    memoryLimit: memMatch ? decodeEntities(memMatch[1].trim()) : null,
    sections: {
      legend: legendHtml ? blocksToParagraphs(htmlToBlocks(legendHtml)) : [],
      input: htmlToBlocks(inputHtml),
      output: htmlToBlocks(outputHtml),
      ...(noteHtml ? { note: htmlToBlocks(noteHtml) } : {}),
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

  async function grab(page, url, { waitSecs = 24 } = {}) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch {
      return null;
    }
    for (let t = 0; t < Math.max(1, Math.round(waitSecs / 2)); t++) {
      if ((await page.locator('div.problem-statement').count()) > 0) {
        try {
          return parseStatementHtml(await page.content());
        } catch {
          return null;
        }
      }
      const title = await page.title();
      if (!/just a moment|checking your browser|security verification/i.test(title) && t > 3) return null;
      await sleep(2000);
    }
    return null;
  }

  const results = new Map();
  const kinds = ['headless', 'chrome-headful'];
  // CF_START_MODE=chrome-headful pins headful real Chrome (best pass rate on a
  // flagged residential IP); default alternates headless <-> headful on failures.
  const pinned = process.env.CF_START_MODE === 'chrome-headful';
  // CF_FRESH_SESSION=1 opens a new browser per item — empirically Cloudflare
  // flags a session after its first request or two, so fresh sessions pass most.
  const freshSession = process.env.CF_FRESH_SESSION === '1';
  let kindIdx = pinned ? 1 : 0;

  // Launching chrome-headful requires the real Chrome binary + a display (real
  // or Xvfb). If unavailable, degrade to the other kind instead of crashing.
  const openSessionSafe = async (kind) => {
    try {
      return await openSession(kind);
    } catch (e) {
      console.warn(`  could not open ${kind} session: ${String(e?.message || e).slice(0, 140)}`);
      return null;
    }
  };
  const otherKind = (kind) => kinds[(kinds.indexOf(kind) + 1) % kinds.length];

  let session = await openSessionSafe(kinds[kindIdx]);
  if (!session) {
    kindIdx = kinds.indexOf(otherKind(kinds[kindIdx]));
    session = await openSessionSafe(kinds[kindIdx]);
  }
  if (!session) {
    console.warn('no usable browser session; skipping statement fetching');
    return results;
  }

  // Adaptive recovery: Cloudflare flags sustained traffic from one IP; the score
  // decays after a few quiet minutes. On consecutive failures, close everything,
  // wait out the flag, then retry the item in a brand-new session.
  const closeSession = async () => session && session.browser.close().catch(() => {});
  const CONSECUTIVE_FAILS = 2;
  const COOLDOWN_MS = Number(process.env.CF_COOLDOWN_MS || 240000);
  let consecutiveFails = 0;

  for (let i = 0; i < items.length; i++) {
    const { code, url } = items[i];
    if (freshSession && i > 0) {
      await closeSession();
      session = await openSessionSafe(kinds[kindIdx]);
      await sleep(1500);
    }
    let statement = await grab(session.page, url);

    if (statement) {
      consecutiveFails = 0;
    } else if (++consecutiveFails >= CONSECUTIVE_FAILS) {
      console.log(
        `  ${consecutiveFails} consecutive failures — cooling down ${COOLDOWN_MS / 1000}s${pinned ? '' : ' and switching browser mode'}…`,
      );
      await closeSession();
      await sleep(COOLDOWN_MS);
      if (!pinned) kindIdx = kinds.indexOf(otherKind(kinds[kindIdx]));
      session = await openSessionSafe(kinds[kindIdx]);
      if (!session) session = await openSessionSafe(kinds[kindIdx]);
      if (!session) {
        console.warn('no usable browser session left; aborting statement fetching');
        return results;
      }
      consecutiveFails = 0;
      statement = await grab(session.page, url); // retry this item in the fresh session
    }

    results.set(code, statement);
    if (onResult) await onResult(code, statement, i + 1, items.length);
    if (i < items.length - 1) await sleep(delayMs + Math.random() * 2000);
    if (i > 0 && i % 25 === 0) await sleep(15000); // cool-down every 25 pages
  }

  await closeSession();
  return results;
}
