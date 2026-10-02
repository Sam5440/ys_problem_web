#!/usr/bin/env node
/**
 * Sync data from Yawn-Sean/Daily_CF_Problems into data/daily.json.
 *
 * - Discovers daily problem folders (problems.md) and solution files via the
 *   GitHub git tree API (falls back to the contents API when the tree is truncated).
 * - Parses the markdown tables into structured problems (difficulty / link / hint).
 * - Attaches full problem statements: curated files in data/statements/*.json win;
 *   otherwise a best-effort fetch from Codeforces (may 403 from CI, that is fine).
 * - Parses categories/*.md into method -> problems listings.
 * - Merges with the existing data/daily.json and keeps the most recent MAX_DAYS days.
 *
 * Env: GITHUB_TOKEN / GH_TOKEN (optional, raises the API rate limit),
 *      MAX_DAYS (default 60), CF_STATEMENTS=0 to disable Codeforces fetching.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchStatementViaBrowser, parseStatementHtml } from './lib/cf-statement.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_FILE = path.join(ROOT, 'data', 'daily.json');
const LEADERBOARD_FILE = path.join(ROOT, 'data', 'leaderboard.json');
const STATEMENTS_DIR = path.join(ROOT, 'data', 'statements');
const UPSTREAM = 'Yawn-Sean/Daily_CF_Problems';
const BRANCH = 'main';
const LEADERBOARD_BRANCH = 'gh-pages'; // records.js (community leaderboard) is published there
const MAX_DAYS = Number(process.env.MAX_DAYS || 60);
const FETCH_STATEMENTS = process.env.CF_STATEMENTS !== '0';
const API_BASE = `https://api.github.com/repos/${UPSTREAM}`;
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(pathname) {
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'ys_problem_web' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const res = await fetch(`${API_BASE}${pathname}`, { headers });
  if (!res.ok) throw new Error(`GitHub API ${pathname}: HTTP ${res.status}`);
  return res.json();
}

async function raw(filePath, branch = BRANCH) {
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(`https://raw.githubusercontent.com/${UPSTREAM}/${branch}/${filePath}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      lastErr = e;
      if (attempt < 2) await sleep(2000);
    }
  }
  // Fallback: some networks (and this sandbox) can't reach raw.githubusercontent.com
  // but reach api.github.com — same file, base64-wrapped.
  try {
    const json = await api(`/contents/${filePath}?ref=${branch}`);
    if (json?.content) return Buffer.from(json.content, 'base64').toString('utf8');
  } catch (e) {
    lastErr = e;
  }
  throw new Error(`raw ${filePath}: ${lastErr.message}`);
}

/* ---------------- markdown table parsing ---------------- */

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

// Row like: | *1700 | [GYM106732C](https://...) | hint text | (| [Editorial](url) |)?
function parseRow(line, withSolution) {
  const cells = line.split('|').slice(1, -1).map((c) => c.trim());
  if (cells.length < 3) return null;
  const difficulty = cells[0];
  const link = cells[1].match(/^\[([^\]]+)\]\(([^)]+)\)$/);
  if (!link) return null;
  if (!/^[\d*]+$/.test(difficulty.replace(/\s/g, ''))) return null;
  const row = {
    code: link[1],
    url: link[2],
    difficulty,
    hint: stripTags(cells[2]),
  };
  if (withSolution) {
    const sol = (cells[3] || '').match(/\[([^\]]*)\]\(([^)]+)\)/);
    row.solutionUrl = sol ? sol[2] : null;
  }
  return row;
}

function parseTable(md, withSolution) {
  return md
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|'))
    .slice(2) // drop header + separator
    .map((l) => parseRow(l, withSolution))
    .filter(Boolean);
}

/* ---------------- daily problems discovery ---------------- */

function dateFromProblemsPath(p) {
  // daily_problems/2026/10/1002/problems.md
  const m = p.match(/^daily_problems\/(\d{4})\/(\d{2})\/(\d{4})\/problems\.md$/);
  if (!m) return null;
  const [, y, mo, mmdd] = m;
  if (mo !== mmdd.slice(0, 2)) return null;
  return `${y}-${mmdd.slice(0, 2)}-${mmdd.slice(2)}`;
}

async function discoverViaTree() {
  const tree = await api(`/git/trees/${BRANCH}?recursive=1`);
  if (tree.truncated) return null;
  const days = new Map(); // date -> { problemsMd, solutions: [] }
  for (const node of tree.tree) {
    if (node.type !== 'blob') continue;
    const date = dateFromProblemsPath(node.path);
    if (date) {
      if (!days.has(date)) days.set(date, { date, problemsMd: node.path, solutions: [] });
    } else {
      const m = node.path.match(/^daily_problems\/(\d{4}\/\d{2}\/\d{4})\/solution\/(.+\.md)$/);
      if (m) {
        const [y, , mmdd] = m[1].split('/');
        const d = `${y}-${mmdd.slice(0, 2)}-${mmdd.slice(2)}`;
        if (!days.has(d)) days.set(d, { date: d, problemsMd: `daily_problems/${m[1]}/problems.md`, solutions: [] });
        days.get(d).solutions.push(node.path);
      }
    }
  }
  return [...days.values()];
}

async function discoverViaContents() {
  const days = [];
  const years = (await api('/contents/daily_problems')).filter((e) => e.type === 'dir').map((e) => e.name);
  for (const year of years) {
    const months = (await api(`/contents/daily_problems/${year}`)).filter((e) => e.type === 'dir').map((e) => e.name);
    for (const month of months) {
      const dayDirs = (await api(`/contents/daily_problems/${year}/${month}`)).filter((e) => e.type === 'dir').map((e) => e.name);
      for (const mmdd of dayDirs) {
        const date = `${year}-${mmdd.slice(0, 2)}-${mmdd.slice(2)}`;
        const base = `daily_problems/${year}/${month}/${mmdd}`;
        let solutions = [];
        try {
          const sol = await api(`/contents/${base}/solution`);
          solutions = sol.filter((e) => e.type === 'file' && e.name.endsWith('.md')).map((e) => `${base}/solution/${e.name}`);
        } catch {}
        days.push({ date, problemsMd: `${base}/problems.md`, solutions });
      }
    }
  }
  return days;
}

/* ---------------- statements ---------------- */

async function loadCuratedStatements() {
  const out = new Map();
  try {
    for (const f of await readdir(STATEMENTS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const json = JSON.parse(await readFile(path.join(STATEMENTS_DIR, f), 'utf8'));
      out.set(json.code.toLowerCase(), json);
    }
  } catch {}
  return out;
}

async function writeStatementFile(meta, statement) {
  const file = {
    code: meta.code,
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
  await writeFile(path.join(STATEMENTS_DIR, `${meta.code.toLowerCase()}.json`), JSON.stringify(file, null, 2) + '\n');
}

// GYM106732C / CF566F -> "106732c" / "566f"; solution files are named cf{contest}{letter}.md
function problemKey(code) {
  const m = String(code).toUpperCase().match(/(\d+)([A-Z][0-9]?)$/);
  return m ? `${m[1]}${m[2]}`.toLowerCase() : String(code).toLowerCase();
}

/* ---------------- categories ---------------- */

async function buildCategories(treePaths) {
  const catFiles = treePaths.filter((p) => /^categories\/[^/]+\.md$/.test(p));
  const out = [];
  for (const f of catFiles) {
    try {
      const rows = parseTable(await raw(f), true);
      out.push({
        name: path.basename(f, '.md'),
        count: rows.length,
        url: `https://github.com/${UPSTREAM}/blob/${BRANCH}/${f}`,
        problems: rows,
      });
    } catch {}
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

/* ---------------- leaderboard (records.js from gh-pages) ---------------- */

// Decode the compact skipped_dates field, e.g. "y2024,m03,,01,,15,m04,,02"
// (year token, month token, then two-digit days; empty tokens separate groups).
function decodeSkippedDates(field) {
  const out = [];
  let y = 0;
  let m = 0;
  for (let s of field.split(',')) {
    s = s.trim();
    if (!s) continue;
    if (s[0] === 'y') y = parseInt(s.slice(1), 10);
    else if (s[0] === 'm') m = parseInt(s.slice(1), 10);
    else {
      for (let i = 0; i + 2 <= s.length; i += 2) {
        const d = parseInt(s.slice(i, i + 2), 10);
        if (y && m && d) out.push(`${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
      }
    }
  }
  return out;
}

// records.js is generated by the upstream .github/workflows/records.py:
//   current_date:<latest counted day>
//   <user>:<score>,<days>/<score>,<days>/...   (run-length encoded, oldest first;
//                                               score = min(2, problems solved that day))
function parseRecordsJs(text) {
  let currentDate = null;
  const skippedDates = [];
  const users = [];
  for (let line of text.split(/[\r\n]+/)) {
    line = line.trim();
    if (!line || line.startsWith('let records') || line === '`;') continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    if (key === 'current_date') {
      currentDate = value;
    } else if (key === 'skipped_dates') {
      skippedDates.push(...decodeSkippedDates(value));
    } else {
      const runs = value
        .split('/')
        .map((run) => run.split(',').map(Number))
        .filter((r) => r.length === 2 && r.every((n) => Number.isInteger(n) && n >= 0));
      if (key && runs.length) users.push({ user: key, runs });
    }
  }
  if (!currentDate || !users.length) throw new Error('records.js: missing current_date or users');
  return { currentDate, skippedDates, users };
}

async function syncLeaderboard() {
  console.log('Syncing leaderboard (records.js from gh-pages)...');
  const text = await raw('records.js', LEADERBOARD_BRANCH);
  const parsed = parseRecordsJs(text);
  const data = {
    generatedAt: new Date().toISOString(),
    sourceRepo: UPSTREAM,
    sourceBranch: LEADERBOARD_BRANCH,
    ...parsed,
  };
  await writeFile(LEADERBOARD_FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`  ✓ ${parsed.users.length} players, data through ${parsed.currentDate}`);
}

/* ---------------- main ---------------- */

async function main() {
  let previous = { days: [], categories: [] };
  try {
    previous = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  } catch {}

  console.log('Discovering daily problem folders...');
  let discovered = await discoverViaTree();
  if (!discovered) {
    console.log('Tree truncated, falling back to contents API...');
    discovered = await discoverViaContents();
  }
  discovered.sort((a, b) => (a.date < b.date ? 1 : -1));
  const kept = discovered.slice(0, MAX_DAYS);
  console.log(`Found ${discovered.length} days, syncing the most recent ${kept.length}.`);

  const curated = await loadCuratedStatements();
  const statementQueue = [];
  const prevSolutions = new Map();
  for (const d of previous.days || []) {
    for (const p of d.problems || []) {
      if (p.solution?.markdown) prevSolutions.set(`${d.date}:${p.code.toLowerCase()}`, p.solution.markdown);
    }
  }

  const prevDays = new Map((previous.days || []).map((d) => [d.date, d]));
  const days = [];
  for (let i = 0; i < kept.length; i++) {
    const day = kept[i];
    let rows;
    try {
      rows = parseTable(await raw(day.problemsMd), false);
    } catch (e) {
      // Transient upstream/network failure: keep whatever we had for this date
      // instead of silently dropping a (possibly latest) day from the site.
      const prevDay = prevDays.get(day.date);
      if (prevDay) {
        days.push(prevDay);
        console.warn(`  ${day.date}: fetch failed (${e.message}) — kept previous data`);
      } else {
        console.warn(`  skip ${day.date}: ${e.message}`);
      }
      continue;
    }
    const problems = [];
    for (const row of rows) {
      const problem = { ...row, statement: null };
      problem.statement = curated.get(row.code.toLowerCase()) || null;

      if (FETCH_STATEMENTS && !problem.statement && i < 3) {
        statementQueue.push(problem);
      }

      const key = problemKey(row.code);
      const solFiles = day.solutions.filter((f) => path.basename(f).replace(/\.md$/i, '').toLowerCase().includes(key));
      if (solFiles.length) {
        try {
          problem.solution = { file: path.basename(solFiles[0]), markdown: await raw(solFiles[0]) };
        } catch {}
      } else {
        const cached = prevSolutions.get(`${day.date}:${row.code.toLowerCase()}`);
        if (cached) problem.solution = { file: null, markdown: cached };
        else if (row.solutionUrl) problem.solution = { file: null, markdown: null, url: row.solutionUrl };
      }
      problems.push(problem);
    }
    days.push({ date: day.date, problems });
    process.stdout.write(`  ${day.date}: ${problems.length} problems\n`);
  }

  if (statementQueue.length) {
    console.log(`Fetching ${statementQueue.length} statement(s) via browser (Cloudflare pass-through)...`);
    const seen = new Set();
    const targets = statementQueue.filter((p) => (seen.has(p.code) ? false : (seen.add(p.code), true)));
    const results = await fetchStatementViaBrowser(targets, { delayMs: 3000 });
    for (const [code, statement] of results) {
      if (!statement) {
        console.warn(`  no statement for ${code} (page blocked or parse failed)`);
        continue;
      }
      const meta = targets.find((t) => t.code === code);
      await writeStatementFile(meta, statement);
      for (const day of days) {
        for (const p of day.problems) if (p.code === code) p.statement = statement;
      }
      console.log(`  ✓ ${code} — ${statement.title}`);
    }
  }

  // Non-fatal: backfill Chinese translations for statements still missing them
  // (idempotent — a no-op unless new statements were just fetched or shipped
  // untranslated). TRANSLATE=0 disables, TRANSLATE_LIMIT bounds files per run.
  if (process.env.TRANSLATE !== '0') {
    try {
      const { translateMissingStatements } = await import('./translate-statements.mjs');
      const translated = await translateMissingStatements({
        limit: Number(process.env.TRANSLATE_LIMIT || 0) || Infinity,
      });
      if (translated > 0) {
        const refreshed = await loadCuratedStatements();
        for (const day of days) {
          for (const p of day.problems) {
            if (p.statement) {
              const upd = refreshed.get(p.code.toLowerCase());
              if (upd) p.statement = upd;
            }
          }
        }
      }
    } catch (e) {
      console.warn(`Translation pass failed (${e.message}) — continuing without translations.`);
    }
  }

  console.log('Building categories...');
  const categories = await buildCategories(
    (await discoverCategoryPaths()),
  );

  const data = {
    generatedAt: new Date().toISOString(),
    sourceRepo: UPSTREAM,
    days,
    categories,
  };
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`Wrote ${DATA_FILE} (${days.length} days, ${categories.length} categories).`);

  // Non-fatal: a leaderboard hiccup must never break the problem-data snapshot.
  try {
    await syncLeaderboard();
  } catch (e) {
    console.warn(`Leaderboard sync failed (${e.message}) — keeping previous data/leaderboard.json.`);
  }
}

async function discoverCategoryPaths() {
  const listing = await api('/contents/categories');
  return listing.filter((e) => e.type === 'file' && e.name.endsWith('.md')).map((e) => `categories/${e.name}`);
}

main().catch((e) => {
  console.error('update-data failed:', e);
  // Keep the existing snapshot; never break the build/deploy on upstream hiccups.
  if (process.env.STRICT === '1') process.exit(1);
  console.log('Keeping the previous data/daily.json snapshot.');
});
