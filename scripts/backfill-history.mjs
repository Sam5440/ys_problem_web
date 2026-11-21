#!/usr/bin/env node
/**
 * Backfill the FULL history of Yawn-Sean/Daily_CF_Problems (newest day first,
 * down to the repo's first commit) into local data:
 *
 *   1. data/archive.json  — every day before the cutoff: parsed problems.md rows
 *      (code/url/difficulty/hint) + solution markdown. Merged by date, so days
 *      already archived are skipped.
 *   2. data/statements/<code>.json — full statement for every problem that has
 *      no file on disk yet, fetched via a real browser (Cloudflare pass-through).
 *      Written one file per problem immediately — killing the run loses nothing,
 *      rerunning resumes where it stopped.
 *
 * Days already present in data/daily.json are archived too (self-contained
 * record of the past) but their statements are already on disk, so no fetching.
 *
 * Usage:
 *   node scripts/backfill-history.mjs [--cutoff 2026-09-30] [--clone /tmp/daily-cf-upstream]
 *                                     [--batch 40] [--delay 2500] [--archive-only]
 * Env: CF_START_MODE / CF_FRESH_SESSION / CF_COOLDOWN_MS (see lib/cf-statement.mjs).
 */
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchStatementViaBrowser } from './lib/cf-statement.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT, 'data');
const STATEMENTS_DIR = path.join(DATA_DIR, 'statements');
const ARCHIVE_FILE = path.join(DATA_DIR, 'archive.json');
const UPSTREAM = 'Yawn-Sean/Daily_CF_Problems';

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const CUTOFF = opt('--cutoff', '2026-09-30'); // days with date < CUTOFF are backfilled
const CLONE = opt('--clone', process.env.UPSTREAM_CLONE || '/tmp/daily-cf-upstream');
const BATCH = Number(opt('--batch', 40));
const DELAY = Number(opt('--delay', 2500));
const ARCHIVE_ONLY = argv.includes('--archive-only');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- markdown table parsing (same rules as update-data.mjs) ------- */

function decodeEntities(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', nbsp: ' ', '#39': "'", apos: "'" };
  return s
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

function parseRow(line) {
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  if (cells.length < 3) return null;
  const difficulty = cells[0];
  const link = cells[1].match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (!link) return null;
  if (!/^[\d*]+$/.test(difficulty.replace(/\s/g, ''))) return null;
  const sol = (cells[3] || '').match(/\[([^\]]*)\]\(([^)]+)\)/);
  return {
    code: link[1],
    url: link[2],
    difficulty,
    hint: stripTags(cells[2]),
    solutionUrl: sol ? sol[2] : null,
  };
}

function parseTable(md) {
  return md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .slice(2)
    .map(parseRow)
    .filter(Boolean);
}

// GYM106732C -> "106732c"; upstream solution files are named cf{contest}{letter}.md
function problemKey(code) {
  const m = String(code).toUpperCase().match(/(\d+)([A-Z][0-9]?)$/);
  return m ? `${m[1]}${m[2]}`.toLowerCase() : String(code).toLowerCase();
}

/* ---------------- clone walk ---------------- */

async function discoverDays() {
  const yearsDir = path.join(CLONE, 'daily_problems');
  const days = [];
  for (const y of await readdir(yearsDir)) {
    if (!/^\d{4}$/.test(y)) continue;
    const yd = path.join(yearsDir, y);
    if (!(await stat(yd)).isDirectory()) continue;
    for (const mo of await readdir(yd)) {
      if (!/^\d{2}$/.test(mo)) continue;
      const md2 = path.join(yd, mo);
      if (!(await stat(md2)).isDirectory()) continue;
      for (const dd of await readdir(md2)) {
        if (!/^\d{4}$/.test(dd) || dd.slice(0, 2) !== mo) continue;
        const dayDir = path.join(md2, dd);
        if (!(await stat(dayDir)).isDirectory()) continue;
        if (!Number.isInteger(Number(dd))) continue;
        const date = `${y}-${mo}-${dd.slice(2)}`;
        if (await readFile(path.join(dayDir, 'problems.md'), 'utf8').then(() => true, () => false)) {
          const solDir = path.join(dayDir, 'solution');
          let solutions = [];
          try {
            solutions = (await readdir(solDir)).filter((f) => f.endsWith('.md')).map((f) => path.join(solDir, f));
          } catch {}
          days.push({ date, dayDir, solutions });
        }
      }
    }
  }
  days.sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first — 倒序
  return days.filter((d) => d.date < CUTOFF);
}

function buildDayEntry(day, md) {
  const problems = [];
  for (const row of parseTable(md)) {
    const problem = { ...row };
    const key = problemKey(row.code);
    const solFiles = day.solutions.filter((f) => path.basename(f).replace(/\.md$/i, '').toLowerCase().includes(key));
    if (solFiles.length) {
      // embed the markdown: the clone is disposable, the archive must be self-contained
      try {
        problem.solution = { file: path.basename(solFiles[0]), markdown: readFileSync(solFiles[0], 'utf8') };
      } catch {}
    }
    problems.push(problem);
  }
  return { date: day.date, problems };
}

/* ---------------- archive ---------------- */

async function loadArchive() {
  try {
    return JSON.parse(await readFile(ARCHIVE_FILE, 'utf8'));
  } catch {
    return { generatedAt: null, sourceRepo: UPSTREAM, cutoff: CUTOFF, days: [] };
  }
}

/* ---------------- statements ---------------- */

async function existingStatementCodes() {
  const set = new Set();
  try {
    for (const f of await readdir(STATEMENTS_DIR)) if (f.endsWith('.json')) set.add(f.replace(/\.json$/, ''));
  } catch {}
  return set;
}

/* ---------------- main ---------------- */

async function main() {
  console.log(`Backfilling history before ${CUTOFF} from clone at ${CLONE} (newest first)...`);
  const days = await discoverDays();
  if (!days.length) {
    console.log('No days found — check --clone path.');
    return;
  }
  console.log(`Found ${days.length} day(s), ${days[0].date} -> ${days[days.length - 1].date}.`);

  // ---- phase 1: archive every day (merged by date; existing days skipped) ----
  const archive = await loadArchive();
  archive.cutoff = CUTOFF;
  const knownDates = new Set(archive.days.map((d) => d.date));
  let addedDays = 0;
  for (const day of days) {
    // keep newest-first order of `days`; merge into archive sorted newest-first too
    if (knownDates.has(day.date)) continue;
    let md;
    try {
      md = await readFile(path.join(day.dayDir, 'problems.md'), 'utf8');
    } catch (e) {
      console.warn(`  ${day.date}: problems.md unreadable (${e.message})`);
      continue;
    }
    const entry = buildDayEntry(day, md);
    archive.days.push(entry);
    knownDates.add(day.date);
    addedDays++;
  }
  archive.days.sort((a, b) => (a.date < b.date ? 1 : -1));
  archive.generatedAt = new Date().toISOString();
  await writeFile(ARCHIVE_FILE, JSON.stringify(archive, null, 2) + '\n');
  console.log(`Archive: +${addedDays} new day(s), ${archive.days.length} day(s) total -> ${ARCHIVE_FILE}`);

  if (ARCHIVE_ONLY) return;

  // ---- phase 2: statements, newest missing first ----
  const have = await existingStatementCodes();
  const targets = [];
  const seen = new Set();
  for (const day of archive.days) {
    // archive.days is newest-first; keep the newest occurrence of a repeated code
    for (const p of day.problems) {
      const key = p.code.toLowerCase();
      if (seen.has(key) || have.has(key)) continue;
      seen.add(key);
      targets.push({ code: p.code, url: p.url, difficulty: p.difficulty, date: day.date });
    }
  }
  console.log(`Statements on disk: ${have.size}; to fetch: ${targets.length}.`);
  if (!targets.length) {
    console.log('All statements present — nothing to fetch.');
    return;
  }

  const { mkdir } = await import('node:fs/promises');
  await mkdir(STATEMENTS_DIR, { recursive: true });

  let ok = 0;
  const failed = [];
  const startedAt = Date.now();
  for (let start = 0; start < targets.length; start += BATCH) {
    const batch = targets.slice(start, start + BATCH);
    console.log(`===== statements ${start + 1}-${start + batch.length}/${targets.length} (${new Date().toLocaleTimeString()}) =====`);
    const results = await fetchStatementViaBrowser(batch, {
      delayMs: DELAY,
      onResult: async (code, statement) => {
        const meta = batch.find((t) => t.code === code);
        if (!statement) {
          failed.push(code);
          console.log(`  ✗ ${code} (${meta.date}) — fetch/parse failed`);
          return;
        }
        ok++;
        const file = {
          code,
          letter: statement.title?.match(/^([A-Z][0-9]?)[.)]/)?.[1] || null,
          title: statement.title,
          contest: null,
          url: meta.url,
          difficulty: meta.difficulty || null,
          timeLimit: statement.timeLimit,
          memoryLimit: statement.memoryLimit,
          sections: statement.sections,
          examples: statement.examples,
        };
        await writeFile(path.join(STATEMENTS_DIR, `${code.toLowerCase()}.json`), JSON.stringify(file, null, 2) + '\n');
        console.log(`  ✓ ${code} (${meta.date}) — ${statement.title}`);
      },
    });
    // nothing: onResult already persisted each file
    const left = targets.length - start - batch.length;
    if (left > 0) {
      console.log(`  batch done (${ok} ok so far, ${failed.length} failed) — pausing 60s before next batch...`);
      await sleep(60000);
    }
  }

  const mins = Math.round((Date.now() - startedAt) / 60000);
  console.log(`\nDone in ${mins} min: ${ok} statements saved, ${failed.length} failed.`);
  if (failed.length) {
    console.log('Failed codes (rerun this script to retry):\n  ' + failed.join(', '));
    await writeFile(path.join(DATA_DIR, '.history-backfill-failed.json'), JSON.stringify(failed, null, 2) + '\n');
  }
}

main().catch((e) => {
  console.error('backfill-history failed:', e);
  process.exit(1);
});
