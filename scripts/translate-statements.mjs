#!/usr/bin/env node
/**
 * Backfill Chinese translations into data/statements/*.json — every platform,
 * every segment.
 *
 * Data model (v2): sectionsZh[key][i] is either
 *   - { deepl: "…", youdao: "…", … }  — per-platform translations (any subset)
 *   - null                            — every platform exhausted its retries
 * and titleZh follows the same shape. The UI picks a channel per segment
 * (default DeepL) from the map.
 *
 * Orchestration: one single-threaded worker per platform, platforms running
 * concurrently; each worker translates ALL segments for its own platform,
 * pulling from a shared queue. A failed request is re-queued and retried at
 * most TRANSLATE_RETRIES times (default 3), TRANSLATE_RETRY_DELAY ms (default
 * 10s) apart. Segments where every platform fail are stored null (the UI
 * shows a 未翻译 marker); any missing per-platform entry is backfilled by the
 * next run.
 *
 * Legacy (v1) files — sectionsZh values being plain strings — are migrated in
 * place: when `translatedBy` names exactly one platform, the existing strings
 * are seeded as that platform's results, so only the other platforms get
 * fetched for those segments.
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

/**
 * Load a statement file and normalize its translations to v2 (per-platform
 * maps). Returns { json, zh, titleZh, legacySeeded } where zh mirrors sections
 * as { key: [ mapOrNull, … ] }.
 */
function normalizeTranslations(json, platforms) {
  const zh = {};
  let titleZh = null;
  let legacySeeded = null;

  // v1 migration: strings + a single-platform translatedBy attribute every
  // segment to that platform; multi-platform v1 files can't be attributed,
  // so their segments start empty and are refetched on all platforms.
  const single = json.sectionsZh && !FORCE && json.translatedBy?.length === 1 && platforms.includes(json.translatedBy[0])
    ? json.translatedBy[0]
    : null;
  legacySeeded = single;

  const fromV1 = (v) => {
    if (v === null || v === undefined) return null;
    if (typeof v === 'string') return single ? { [single]: v } : {};
    return { ...v };
  };
  if (json.sectionsZh && !FORCE) {
    for (const [key, list] of Object.entries(json.sectionsZh)) {
      zh[key] = Array.isArray(list) ? list.map(fromV1) : [];
    }
    titleZh = fromV1(json.titleZh);
  }

  return { zh, titleZh, legacySeeded };
}

/** True when a v2 segment map still misses any enabled platform. */
const segmentComplete = (seg, platforms) =>
  !!seg && platforms.every((p) => typeof seg[p] === 'string' && seg[p].trim());

/**
 * Fill in translations for statement files missing any (platform, segment)
 * pair. Returns the number of files written.
 */
export async function translateMissingStatements({ limit = LIMIT, force = FORCE } = {}) {
  const platforms = SERVICE_LIST();
  if (!platforms.length) {
    console.warn('No translation platform configured (TRANSLATE_SERVICES empty) — skipping.');
    return 0;
  }

  let files = (await readdir(STATEMENTS_DIR)).filter((f) => f.endsWith('.json')).sort();
  if (CODE) files = files.filter((f) => f.replace(/\.json$/, '') === CODE.toLowerCase());

  const queue = [];
  const fileState = new Map();
  for (const f of files) {
    const json = JSON.parse(await readFile(path.join(STATEMENTS_DIR, f), 'utf8'));
    const { zh, titleZh } = normalizeTranslations(json, platforms);
    const st = { file: f, json, zh, titleZh, engines: new Set(), tasks: [], logged: false };
    const pushTask = (key, idx, text, platform) => {
      const task = { st, key, idx, text, platform, attempts: 0, nextRetryAt: 0, done: false, failed: false, claimed: false };
      st.tasks.push(task);
      queue.push(task);
    };

    let missing = 0;
    if (json.title && (force || !segmentComplete(titleZh, platforms))) {
      for (const p of platforms) {
        if (force || !titleZh?.[p]) {
          pushTask('__title__', 0, json.title, p);
          missing++;
        }
      }
    }
    for (const [key, list] of Object.entries(json.sections || {})) {
      zh[key] = zh[key] || [];
      list.forEach((item, i) => {
        if (typeof item !== 'string') {
          zh[key][i] = item; // {pre} code blocks stay as-is
          return;
        }
        zh[key][i] = zh[key][i] || {};
        for (const p of platforms) {
          if (force || !zh[key][i][p]) {
            pushTask(key, i, item, p);
            missing++;
          }
        }
      });
    }
    if (missing) {
      fileState.set(json, st);
      if (fileState.size >= limit) break;
    }
  }

  if (!fileState.size) return 0;
  console.log(
    `Translating ${fileState.size} statement file(s) on ${platforms.length} platform(s) in parallel ` +
      `[${platforms.join(', ')}] — ${queue.length} (segment, platform) pairs ` +
      `(per pair: ≤${MAX_RETRIES} retries, ${RETRY_DELAY / 1000}s apart)...`,
  );

  const settleFile = (st) => {
    if (st.logged || !st.tasks.every((t) => t.done || t.failed)) return;
    st.logged = true;
    const ok = st.tasks.filter((t) => t.done).length;
    const bad = st.tasks.filter((t) => t.failed).length;
    const per = Object.fromEntries(platforms.map((p) => [p, st.tasks.filter((t) => t.platform === p && t.done).length]));
    console.log(
      `  ✓ ${st.json.code}: ${ok}/${st.tasks.length} 段·平台 ` +
        `[${platforms.map((p) => `${p}:${per[p]}`).join(' ')}]` +
        (bad ? `，${bad} 个失败(标注为未翻译)` : ''),
    );
  };

  // One single-threaded worker per platform; it only ever processes tasks for
  // its own platform, so within a platform requests stay strictly sequential.
  const worker = async (platform) => {
    while (true) {
      const now = Date.now();
      const task = queue.find((t) => t.platform === platform && !t.done && !t.failed && !t.claimed && t.nextRetryAt <= now);
      if (!task) {
        const pending = queue.filter((t) => t.platform === platform && !t.done && !t.failed);
        if (!pending.length) return;
        await sleep(Math.min(2000, Math.max(500, Math.min(...pending.map((t) => t.nextRetryAt)) - now)));
        continue;
      }
      task.claimed = true;
      try {
        await paceFor(platform);
        const result = await translateWithPlatform(task.text, platform);
        task.done = true;
        task.st.engines.add(platform);
        if (task.key === '__title__') task.st.titleZh = { ...task.st.titleZh, [platform]: result };
        else task.st.zh[task.key][task.idx] = { ...task.st.zh[task.key][task.idx], [platform]: result };
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
        if (task.done || task.failed) settleFile(task.st);
      }
    }
  };

  await Promise.all(platforms.map(worker));

  // Write back v2. Files where nothing succeeded stay untouched (a later run
  // retries them). A segment map that every platform failed is stored null.
  let written = 0;
  for (const st of fileState.values()) {
    if (!st.engines.size) {
      console.warn(`  ${st.json.code}: nothing translated — file left unchanged`);
      continue;
    }
    const nulls = [];
    for (const [key, list] of Object.entries(st.zh)) {
      st.zh[key] = list.map((seg) => {
        if (seg === null || typeof seg !== 'object') return seg ?? null;
        return Object.keys(seg).length ? seg : null;
      });
      nulls.push(...st.zh[key].filter((seg) => seg === null));
    }
    st.json.titleZh = st.titleZh && Object.keys(st.titleZh).length ? st.titleZh : null;
    st.json.sectionsZh = st.zh;
    st.json.translatedAt = new Date().toISOString();
    st.json.translatedBy = platforms.filter((p) => st.engines.has(p));
    await writeFile(path.join(STATEMENTS_DIR, st.file), JSON.stringify(st.json, null, 2) + '\n');
    written++;
  }

  const failedPairs = queue.filter((t) => t.failed).length;
  if (failedPairs) {
    console.warn(`  ${failedPairs} (segment, platform) pair(s) exhausted ${MAX_RETRIES} retries.`);
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
