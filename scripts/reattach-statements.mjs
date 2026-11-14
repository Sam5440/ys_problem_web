#!/usr/bin/env node
/**
 * Re-mount data/statements/*.json into the statement copies embedded in
 * data/daily.json, without touching anything upstream.
 *
 * The site renders the statement objects embedded in daily.json — edits made
 * locally to statements/*.json (fetch backfill, translation merges) are
 * invisible until re-attached. CI does this on every run (update-data.mjs);
 * this script is the local equivalent:
 *
 *   node scripts/reattach-statements.mjs
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_FILE = path.join(ROOT, 'data', 'daily.json');
const STATEMENTS_DIR = path.join(ROOT, 'data', 'statements');

const daily = JSON.parse(await readFile(DATA_FILE, 'utf8'));
const curated = new Map();
for (const f of await readdir(STATEMENTS_DIR)) {
  if (!f.endsWith('.json')) continue;
  const j = JSON.parse(await readFile(path.join(STATEMENTS_DIR, f), 'utf8'));
  curated.set(j.code.toLowerCase(), j);
}

let n = 0;
for (const day of daily.days) {
  for (const p of day.problems) {
    const c = curated.get(p.code.toLowerCase());
    if (c) {
      p.statement = c;
      n++;
    }
  }
}
await writeFile(DATA_FILE, JSON.stringify(daily, null, 2) + '\n');
console.log(`Re-attached ${n} statement(s) into ${path.relative(ROOT, DATA_FILE)}`);
