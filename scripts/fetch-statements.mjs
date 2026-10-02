#!/usr/bin/env node
/**
 * Backfill full problem statements via a real Chromium (passes Cloudflare).
 *
 * Finds every problem in data/daily.json without a statement, fetches it,
 * and stores it as data/statements/<code>.json (same schema as curated files,
 * so update-data.mjs keeps attaching them automatically).
 *
 * Usage:
 *   node scripts/fetch-statements.mjs [--limit N] [--force] [--delay MS]
 * Resumable: statements that already exist on disk are skipped unless --force.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchStatementViaBrowser } from './lib/cf-statement.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATEMENTS_DIR = path.join(ROOT, 'data', 'statements');
const DATA_FILE = path.join(ROOT, 'data', 'daily.json');

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const LIMIT = Number(opt('--limit', Infinity));
const DELAY = Number(opt('--delay', 2500));
const FORCE = argv.includes('--force');
const LIMITS_ONLY = argv.includes('--limits-only');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function existingStatementCodes() {
  const set = new Set();
  try {
    for (const f of await readdir(STATEMENTS_DIR)) if (f.endsWith('.json')) set.add(f.replace(/\.json$/, ''));
  } catch {}
  return set;
}

async function main() {
  const daily = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  const have = await existingStatementCodes();

  const missing = [];
  const needsLimits = [];
  for (const day of daily.days) {
    for (const p of day.problems) {
      if (p.statement) continue;
      if (FORCE || !have.has(p.code.toLowerCase())) {
        if (!missing.find((m) => m.code === p.code)) {
          missing.push({ code: p.code, url: p.url, difficulty: p.difficulty });
        }
      }
    }
  }
  if (LIMITS_ONLY) {
    // Existing statement files missing time/memory limits — refetch and patch only those.
    for (const code of have) {
      const file = JSON.parse(await readFile(path.join(STATEMENTS_DIR, `${code}.json`), 'utf8'));
      if (!file.timeLimit || !file.memoryLimit) {
        if (!missing.find((m) => m.code.toLowerCase() === code) && !needsLimits.find((m) => m.code === file.code)) {
          needsLimits.push({ code: file.code, url: file.url, difficulty: file.difficulty, patch: code });
        }
      }
    }
  }
  const targets = [...needsLimits, ...missing].slice(0, Number.isFinite(LIMIT) ? LIMIT : Infinity);
  console.log(
    `Statements on disk: ${have.size}; missing in archive: ${missing.length}; needs limits: ${needsLimits.length}; fetching: ${targets.length}`,
  );

  if (!targets.length) {
    console.log('Nothing to fetch.');
    return;
  }

  let ok = 0;
  const failed = [];
  await fetchStatementViaBrowser(targets, {
    delayMs: DELAY,
    onResult: async (code, statement, i, total) => {
      if (statement) {
        ok++;
        const meta = targets.find((t) => t.code === code);
        const dest = path.join(STATEMENTS_DIR, `${code.toLowerCase()}.json`);
        if (meta.patch) {
          // limits-only mode: keep the saved sections/examples, refresh the metadata
          const existing = JSON.parse(await readFile(dest, 'utf8'));
          existing.title = existing.title || statement.title;
          existing.timeLimit = statement.timeLimit;
          existing.memoryLimit = statement.memoryLimit;
          await writeFile(dest, JSON.stringify(existing, null, 2) + '\n');
          console.log(`  [${i}/${total}] ↻ ${code} — limits patched (${statement.timeLimit}/${statement.memoryLimit})`);
          return;
        }
        const file = {
          code,
          letter: statement.title?.match(/^([A-Z])[.)]/)?.[1] || code.replace(/^.*?([A-Z][0-9]?)$/, '$1'),
          title: statement.title,
          contest: null,
          url: meta.url,
          difficulty: meta.difficulty || null,
          timeLimit: statement.timeLimit,
          memoryLimit: statement.memoryLimit,
          sections: statement.sections,
          examples: statement.examples,
        };
        await writeFile(dest, JSON.stringify(file, null, 2) + '\n');
        console.log(`  [${i}/${total}] ✓ ${code} — ${statement.title} (${statement.examples.length} samples)`);
      } else {
        failed.push(code);
        console.log(`  [${i}/${total}] ✗ ${code} — fetch/parse failed`);
      }
    },
  });

  console.log(`\nDone: ${ok} saved, ${failed.length} failed.`);
  if (failed.length) console.log('Failed codes (rerun this script to retry):\n  ' + failed.join(', '));
  await sleep(100);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
