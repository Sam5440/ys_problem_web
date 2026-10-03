/**
 * AI translation of the newest statements via any OpenAI-compatible chat
 * completions endpoint (GitHub Secrets: AI_BASE_URL / AI_API_KEY, optional
 * AI_MODEL, default deepseek-v4-flash).
 *
 * Newest-first walk over data/daily.json; for every statement segment that
 * has no `ai` entry yet, requests a translation and merges it into the
 * statement file's sectionsZh / titleZh as the `ai` channel — the site's
 * 对照 chain picks it up as a last resort after the four MT channels.
 * Idempotent: covered segments are skipped, so repeated runs only translate
 * what is new. AI_TRANSLATE_LIMIT caps the per-run segment budget.
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { protectMath, restoreMath } from '../lib/mt-protect.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA_FILE = path.join(ROOT, 'data', 'daily.json');
const STATEMENTS_DIR = path.join(ROOT, 'data', 'statements');

const BASE_URL = (process.env.AI_BASE_URL || '').trim().replace(/\/+$/, '');
const API_KEY = (process.env.AI_API_KEY || '').trim();
const MODEL = process.env.AI_MODEL || 'deepseek-v4-flash';
const LIMIT = Number(process.env.AI_TRANSLATE_LIMIT || 60);
const MAX_CONSECUTIVE_FAILS = 5;
const TIMEOUT_MS = 120000;
const DELAY_MS = 300;

const endpoint = () =>
  `${/\/v\d+$/.test(BASE_URL) ? BASE_URL : `${BASE_URL}/v1`}/chat/completions`;

async function aiTranslate(raw) {
  const { masked, stash } = protectMath(raw);
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content:
            '你是专业的算法竞赛题面翻译器。把用户文本翻译成简体中文：术语遵循算法竞赛惯例（如 greedy=贪心、dp=DP）；' +
            '$$$...$$$ 数学公式、`行内代码`、![](图片链接) 和裸 URL 一律原样保留不翻译；只输出译文，不要任何解释。',
        },
        { role: 'user', content: masked },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('empty response');
  const restored = restoreMath(out, stash);
  if (!restored) throw new Error('placeholder mangled');
  return restored;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** { fileObj, segs: [{key, i, text}] } for one statement, `key` = 'title' | section. */
function missingSegments(st) {
  const segs = [];
  if (typeof st.title === 'string' && st.title.trim()) {
    const zh = st.titleZh;
    const hasAi =
      typeof zh === 'object' && zh !== null && typeof zh.ai === 'string' && zh.ai.trim();
    if (!hasAi && typeof zh !== 'string') segs.push({ key: 'title', i: 0, text: st.title });
  }
  for (const [key, list] of Object.entries(st.sections || {})) {
    (list || []).forEach((p, i) => {
      if (typeof p !== 'string' || !p.trim()) return;
      const entry = st.sectionsZh?.[key]?.[i];
      if (typeof entry === 'string') return; // legacy complete translation
      if (entry && typeof entry === 'object' && typeof entry.ai === 'string' && entry.ai.trim()) return;
      segs.push({ key, i, text: p });
    });
  }
  return segs;
}

async function main() {
  if (!BASE_URL || !API_KEY) {
    console.error('AI_BASE_URL / AI_API_KEY not set — skipping AI translation.');
    process.exit(1);
  }

  const daily = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  const days = [...(daily.days || [])].sort((a, b) => (a.date < b.date ? 1 : -1));

  // Newest statement files first; dedupe codes across days.
  const seen = new Set();
  let budget = LIMIT;
  let done = 0;
  let fails = 0;
  let aborted = false;

  for (const day of days) {
    if (aborted || budget <= 0) break;
    for (const problem of day.problems || []) {
      if (aborted || budget <= 0) break;
      const code = problem.code?.toLowerCase();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      const file = path.join(STATEMENTS_DIR, `${code}.json`);
      let st;
      try {
        st = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        continue; // no statement file yet
      }
      const segs = missingSegments(st);
      if (!segs.length) continue;
      console.log(`${st.code || code}: ${segs.length} segment(s) to translate`);
      st.sectionsZh ||= {};
      for (const seg of segs) {
        if (budget <= 0) break;
        budget -= 1;
        let text = null;
        try {
          text = await aiTranslate(seg.text);
          fails = 0;
        } catch (e) {
          fails += 1;
          console.warn(`  ✗ ${seg.key}[${seg.i}] — ${e.message}`);
          if (fails >= MAX_CONSECUTIVE_FAILS) {
            console.error(`  ${fails} consecutive failures — endpoint looks down, aborting.`);
            aborted = true;
            break;
          }
          await sleep(2000);
        }
        if (text) {
          if (seg.key === 'title') {
            st.titleZh = typeof st.titleZh === 'object' && st.titleZh !== null ? st.titleZh : {};
            st.titleZh.ai = text;
          } else {
            st.sectionsZh[seg.key] ||= [];
            const entry =
              st.sectionsZh[seg.key][seg.i] &&
              typeof st.sectionsZh[seg.key][seg.i] === 'object'
                ? st.sectionsZh[seg.key][seg.i]
                : {};
            entry.ai = text;
            st.sectionsZh[seg.key][seg.i] = entry;
          }
          done += 1;
          console.log(`  ✓ ${seg.key}[${seg.i}]: ${text.slice(0, 48)}…`);
        }
        await sleep(DELAY_MS);
      }
      if (done || segs.length) await writeFile(file, JSON.stringify(st, null, 2) + '\n');
    }
  }

  console.log(`Done: ${done} segment(s) translated${budget <= 0 ? ` (hit limit ${LIMIT})` : ''}.`);
  if (aborted && done === 0) process.exit(1);
}

main();
