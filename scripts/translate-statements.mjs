#!/usr/bin/env node
/**
 * Backfill Chinese translations into data/statements/*.json.
 *
 * Orchestration: one single-threaded worker per platform (deepl / youdao /
 * caiyun / iflyrec …), all platforms running concurrently off a shared
 * segment queue. A segment that fails is re-queued and retried at most
 * TRANSLATE_RETRIES times (default 3), TRANSLATE_RETRY_DELAY ms (default
 * 10s) between attempts — possibly picked up by a different platform.
 * Segments that exhaust their retries are stored as `null` (the UI shows an
 * explicit "未翻译" marker for them), and the next run backfills those nulls.
 *
 * Translations stay index-aligned with the English sections:
 * sectionsZh[key][i] mirrors sections[key][i]; {pre} code blocks are copied
 * through untranslated. Idempotent: fully-translated files are skipped, so
 * wiring this into CI only ever processes newly fetched statements.
 *
 * Usage:
 *   node scripts/translate-statements.mjs [--limit N] [--force] [--code CODE]
 * Env: see scripts/lib/translate.mjs; TRANSLATE_LIMIT (default 0 = all missing)
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SERVICE_LIST, paceFor, translateWithPlatform } from './lib/translate.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATEMENTS_DIR = path.join(ROOT, 'data', 'statements');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const FORCE = argv.includes('--force');
const CODE = opt('--code', null);
const LIMIT = Number(opt('--limit', process.env.TRANSLATE_LIMIT || 0)) || Infinity;
const MAX_RETRIES = Number(process.env.TRANSLATE_RETRIES || 3);
const RETRY_DELAY = Number(process.env.TRANSLATE_RETRY_DELAY || 10000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* statement files that need work: no sectionsZh yet, or null placeholders
   from an earlier run left some segments untranslated */
async function collectTargets() {
  let files = (await readdir(STATEMENTS_DIR)).filter((f) => f.endsWith('.json')).sort();
  if (CODE) files = files.filter((f) => f.replace(/\.json$/, '') === CODE.toLowerCase());

  const targets = [];
  for (const f of files) {
    const json = JSON.parse(await readFile(path.join(STATEMENTS_DIR, f), 'utf8'));
    const needs = FORCE || !json.sectionsZh;
    if (!needs && json.sectionsZh) {
      for (const list of Object.values(json.sectionsZh)) {
        if (Array.isArray(list) && list.some((x) => x === null)) {
          json._backfillNulls = true;
          targets.push(json);
          break;
        }
      }
      continue;
    }
    if (needs) targets.push(json);
  }
  return targets.slice(0, LIMIT === Infinity ? undefined : LIMIT);
}

/**
 * Fill in translations for statement files missing them.
 * Returns the number of files written.
 */
export async function translateMissingStatements({ limit = LIMIT, force = FORCE } = {}) {
  const platforms = SERVICE_LIST();
  if (!platforms.length) {
    console.warn('No translation platform configured (TRANSLATE_SERVICES empty) — skipping.');
    return 0;
  }

  let targets = await collectTargets();
  if (limit !== Infinity) targets = targets.slice(0, limit);
  if (!targets.length) return 0;
  console.log(
    `Translating ${targets.length} statement file(s) on ${platforms.length} platform(s) in parallel ` +
      `[${platforms.join(', ')}] (per segment: ≤${MAX_RETRIES} retries, ${RETRY_DELAY / 1000}s apart)...`,
  );

  // Flatten every untranslated paragraph into one shared queue.
  const tasks = [];
  const fileState = new Map(); // json -> { file, zh: {key: []}, engines: Set, tasks: [], logged: false }
  const queue = [];
  for (const json of targets) {
    const st = { file: `${json.code.toLowerCase()}.json`, json, zh: {}, engines: new Set(), tasks: [], logged: false };
    fileState.set(json, st);
    const pushTask = (key, idx, text) => {
      const task = { st, key, idx, text, attempts: 0, nextRetryAt: 0, done: false, failed: false, claimed: false, result: null };
      st.tasks.push(task);
      queue.push(task);
    };
    if (json.title && (force || !json.titleZh)) pushTask('__title__', 0, json.title);
    for (const [key, list] of Object.entries(json.sections || {})) {
      st.zh[key] = json.sectionsZh?.[key] && !force ? [...json.sectionsZh[key]] : [];
      list.forEach((item, i) => {
        if (typeof item !== 'string') {
          st.zh[key][i] = item; // {pre} code blocks stay as-is
        } else if (force || st.zh[key][i] == null) {
          pushTask(key, i, item); // untranslated (missing or previously-null)
        }
      });
    }
  }

  const settleTask = (task) => {
    const st = task.st;
    if (st.logged) return;
    if (st.tasks.every((t) => t.done || t.failed)) {
      st.logged = true;
      const ok = st.tasks.filter((t) => t.done).length;
      const bad = st.tasks.filter((t) => t.failed).length;
      console.log(`  ✓ ${st.json.code}: ${ok} 段 via [${[...st.engines].join(', ')}]` + (bad ? `, ${bad} 段失败(标注为未翻译)` : ''));
    }
  };

  // One single-threaded worker per platform; platforms run concurrently.
  const worker = async (platform) => {
    while (true) {
      const now = Date.now();
      const task = queue.find((t) => !t.done && !t.failed && !t.claimed && t.nextRetryAt <= now);
      if (!task) {
        const pending = queue.filter((t) => !t.done && !t.failed);
        if (!pending.length) return;
        await sleep(Math.min(2000, Math.max(500, Math.min(...pending.map((t) => t.nextRetryAt)) - now)));
        continue;
      }
      task.claimed = true;
      try {
        await paceFor(platform);
        task.result = await translateWithPlatform(task.text, platform);
        task.done = true;
        task.st.engines.add(platform);
        if (task.key === '__title__') task.st.zh.__title__ = [task.result];
        else task.st.zh[task.key][task.idx] = task.result;
      } catch (e) {
        task.attempts++;
        if (task.attempts > MAX_RETRIES) {
          task.failed = true;
          if (process.env.TRANSLATE_DEBUG) {
            console.warn(`    ! ${platform} gave up on ${task.st.json.code}/${task.key}[${task.idx}]: ${e.message}`);
          }
        } else {
          task.nextRetryAt = Date.now() + RETRY_DELAY;
        }
      } finally {
        task.claimed = false;
        if (task.done || task.failed) settleTask(task);
      }
    }
  };

  await Promise.all(platforms.map(worker));

  // Write back; files where nothing succeeded are left untouched (a later
  // run retries them). null segments are kept — the UI marks them 未翻译.
  let written = 0;
  for (const st of fileState.values()) {
    if (!st.engines.size) {
      console.warn(`  ${st.json.code}: every segment failed — file left untranslated`);
      continue;
    }
    if ('__title__' in st.zh) st.json.titleZh = st.zh.__title__;
    delete st.zh.__title__;
    st.json.sectionsZh = st.zh;
    st.json.translatedAt = new Date().toISOString();
    st.json.translatedBy = [...st.engines];
    await writeFile(path.join(STATEMENTS_DIR, st.file), JSON.stringify(st.json, null, 2) + '\n');
    delete st.json._backfillNulls;
    written++;
  }

  const failedSegs = queue.filter((t) => t.failed).length;
  if (failedSegs) {
    console.warn(`  ${failedSegs} segment(s) exhausted ${MAX_RETRIES} retries — stored as null and marked 未翻译 on the site.`);
  }
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  translateMissingStatements().then(
    (n) => console.log(`Translated ${n} file(s).`),
    (e) => {
      console.error('translate-statements failed:', e);
      process.exit(1);
    },
  );
}
