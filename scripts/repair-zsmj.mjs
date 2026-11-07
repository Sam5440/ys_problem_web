#!/usr/bin/env node
/**
 * Repair statements polluted by raw %%ZSMJ<n>%% tokens — our parser's math
 * stash leaked whenever the page used MathJax v3 (<mjx-container> layout),
 * which the old unmathjax() restore loop never matched.
 *
 * Re-fetches each affected page with the fixed parser and merges: parser
 * fields (title/time/memory/sections/examples) are replaced, non-parser
 * fields (code/letter/contest/url/difficulty) and existing translations are
 * kept. Any segment whose English text changed has its stale translations
 * dropped (the browser-side MT pipeline and the CI AI backfill refill them).
 *
 * Usage:
 *   node scripts/repair-zsmj.mjs [--limit N] [--delay MS] [--only c1,c2]
 * Resumable: files without ZSMJ tokens are skipped.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { fetchStatementViaBrowser } from './lib/cf-statement.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATEMENTS_DIR = path.join(ROOT, 'data', 'statements');
const ZSMJ = /%%ZSMJ\d+%%/;

const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const LIMIT = Number(opt('--limit', Infinity));
const DELAY = Number(opt('--delay', 6000));
const ONLY = opt('--only', null); // comma-separated codes, lowercase

const segKey = (p) => JSON.stringify(p);

/** Prune translations for segments whose English source changed. */
function mergeStatement(oldSt, fresh) {
  const out = { ...oldSt };
  out.title = fresh.title;
  out.timeLimit = fresh.timeLimit;
  out.memoryLimit = fresh.memoryLimit;
  out.sections = fresh.sections;
  out.examples = fresh.examples;

  // title: keep the old translation only when the title text is unchanged
  if (oldSt.title !== fresh.title) {
    if (oldSt.titleZh !== undefined) out.titleZh = {};
  }

  const oldZh = oldSt.sectionsZh || {};
  const zh = {};
  let changed = 0;
  let kept = 0;
  for (const [key, list] of Object.entries(fresh.sections)) {
    const oldList = oldSt.sections?.[key] || [];
    const oldKeyList = oldZh[key];
    zh[key] = (list || []).map((seg, i) => {
      if (segKey(seg) === segKey(oldList[i])) {
        const entry = oldKeyList?.[i];
        if (entry !== undefined) {
          kept++;
          return entry;
        }
        return undefined;
      }
      changed++;
      return undefined; // stale translation for a changed (repaired) segment
    });
  }
  // keep translations for sections the fresh parse might not have (rare);
  // only when the section itself is gone do we drop them
  for (const key of Object.keys(oldZh)) {
    if (!(key in zh) && oldSt.sections?.[key]) {
      // section disappeared from the fresh parse — keep old section+zh as-is
      out.sections[key] = oldSt.sections[key];
      zh[key] = oldZh[key];
    }
  }
  out.sectionsZh = zh;
  return { statement: out, changed, kept };
}

async function main() {
  const files = (await readdir(STATEMENTS_DIR)).filter((f) => f.endsWith('.json'));
  const targets = [];
  for (const f of files) {
    const raw = await readFile(path.join(STATEMENTS_DIR, f), 'utf8');
    if (!ZSMJ.test(raw)) continue;
    if (ONLY && !ONLY.split(',').includes(f.replace(/\.json$/, ''))) continue;
    try {
      const st = JSON.parse(raw);
      if (st.url) targets.push({ code: st.code || f.replace(/\.json$/, ''), url: st.url, file: f, old: st });
    } catch {}
    if (targets.length >= LIMIT) break;
  }
  console.log(`Statements to repair: ${targets.length}${ONLY ? ` (only: ${ONLY})` : ''}`);
  if (!targets.length) return;

  let repaired = 0;
  let segsCleared = 0;
  let segsKept = 0;
  const failed = [];

  await fetchStatementViaBrowser(targets, {
    delayMs: DELAY,
    onResult: async (code, statement, i, total) => {
      const t = targets.find((x) => x.code === code);
      if (!statement) {
        failed.push(code);
        console.log(`  [${i}/${total}] ✗ ${code} — fetch/parse failed (file left unchanged)`);
        return;
      }
      const { statement: merged, changed, kept } = mergeStatement(t.old, statement);
      segsCleared += changed;
      segsKept += kept;
      await writeFile(path.join(STATEMENTS_DIR, t.file), JSON.stringify(merged, null, 2) + '\n');
      repaired++;
      console.log(
        `  [${i}/${total}] ✓ ${code} — ${changed} 段重译(${kept} 段保留译文)`,
      );
    },
  });

  console.log(
    `\nDone: ${repaired} repaired, ${failed.length} failed; translations: ${segsCleared} cleared, ${segsKept} kept.`,
  );
  if (failed.length) console.log('Failed codes (rerun to retry):\n  ' + failed.join(', '));
}

main().catch((e) => {
  console.error('repair-zsmj failed:', e);
  process.exit(1);
});
