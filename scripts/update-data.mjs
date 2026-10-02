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

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_FILE = path.join(ROOT, 'data', 'daily.json');
const STATEMENTS_DIR = path.join(ROOT, 'data', 'statements');
const UPSTREAM = 'Yawn-Sean/Daily_CF_Problems';
const BRANCH = 'main';
const MAX_DAYS = Number(process.env.MAX_DAYS || 60);
const FETCH_STATEMENTS = process.env.CF_STATEMENTS !== '0';
const RAW_BASE = `https://raw.githubusercontent.com/${UPSTREAM}/${BRANCH}`;
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

async function raw(filePath) {
  const res = await fetch(`${RAW_BASE}/${filePath}`);
  if (!res.ok) throw new Error(`raw ${filePath}: HTTP ${res.status}`);
  return res.text();
}

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
        Accept: 'text/html',
      },
    });
  } finally {
    clearTimeout(t);
  }
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

function htmlToParagraphs(html) {
  const paras = [...String(html).matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => stripTags(m[1])).filter(Boolean);
  if (paras.length) return paras;
  const one = stripTags(html);
  return one ? [one] : [];
}

function parseStatementHtml(pageHtml) {
  const start = pageHtml.indexOf('<div class="problem-statement">');
  if (start === -1) return null;
  let html = pageHtml.slice(start);
  const end = html.indexOf('<div id="footer"');
  if (end > 0) html = html.slice(0, end);
  const titleMatch = html.match(/<div class="title">\s*([A-Z][.)][^<]*)</);
  const timeMatch = html.match(/time limit per test:?\s*([^<]+)</i);
  const memMatch = html.match(/memory limit per test:?\s*([^<]+)</i);
  const section = (cls) => {
    const m = html.match(new RegExp(`<div class="${cls}">([\\s\\S]*?)</div>\\s*(?=<div class="|<script|$)`));
    return m ? m[1] : '';
  };
  const legendHtml = html.match(/<\/div>\s*([\s\S]*?)<div class="input-specification">/);
  const samples = [...html.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((m) =>
    decodeEntities(
      m[1]
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/div>/gi, '\n')
        .replace(/<[^>]+>/g, ''),
    ).replace(/\n+$/, ''),
  );
  const examples = [];
  for (let i = 0; i + 1 < samples.length; i += 2) examples.push({ input: samples[i], output: samples[i + 1] });
  const noteHtml = html.match(/<div class="note">([\s\S]*?)<\/div>\s*(?=<div class="|<script|$)/);
  const statement = {
    title: titleMatch ? decodeEntities(titleMatch[1].trim()) : null,
    timeLimit: timeMatch ? timeMatch[1].trim() : null,
    memoryLimit: memMatch ? memMatch[1].trim() : null,
    sections: {
      legend: legendHtml ? htmlToParagraphs(legendHtml[1]) : [],
      input: htmlToParagraphs(section('input-specification')),
      output: htmlToParagraphs(section('output-specification')),
      ...(noteHtml ? { note: htmlToParagraphs(noteHtml[1]) } : {}),
    },
    examples,
  };
  if (!statement.sections.legend.length || !statement.title) return null;
  return statement;
}

async function fetchStatement(url) {
  try {
    const res = await fetchWithTimeout(url, 8000);
    if (!res.ok) return null;
    const parsed = parseStatementHtml(await res.text());
    if (parsed) return parsed;
  } catch {}
  return null;
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
  const prevSolutions = new Map();
  for (const d of previous.days || []) {
    for (const p of d.problems || []) {
      if (p.solution?.markdown) prevSolutions.set(`${d.date}:${p.code.toLowerCase()}`, p.solution.markdown);
    }
  }

  const days = [];
  for (let i = 0; i < kept.length; i++) {
    const day = kept[i];
    let rows;
    try {
      rows = parseTable(await raw(day.problemsMd), false);
    } catch (e) {
      console.warn(`  skip ${day.date}: ${e.message}`);
      continue;
    }
    const problems = [];
    for (const row of rows) {
      const problem = { ...row, statement: null };
      problem.statement = curated.get(row.code.toLowerCase()) || null;

      if (FETCH_STATEMENTS && !problem.statement && i < 3) {
        problem.statement = await fetchStatement(row.url);
        if (problem.statement) console.log(`  fetched statement for ${row.code} from Codeforces`);
        await sleep(1500);
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
