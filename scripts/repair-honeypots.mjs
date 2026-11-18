#!/usr/bin/env node
/**
 * Strip anti-AI honeypots from archived statements — problem setters embed
 * invisible TeX via MathJax v2 \style ({\style{opacity:0;font-size:0px}{…}},
 * \style{color:white;font-size:1px}{…}, bare opacity:0). Codeforces renders
 * them invisible; KaTeX spills the raw TeX onto the page. stripHiddenTex()
 * (lib/render.js, same pass the renderer and the fixed extractor use) removes
 * the whole group so the archive carries only what a human sees on CF.
 *
 * English sections and every translation channel are cleaned in place —
 * no re-fetch, unlike repair-zsmj: the strip is exactly what a fresh parse
 * would produce for these segments. The MathJax preview span additionally
 * leaks the honeypot sentence as plain text beside the token; those payload
 * sentences (harvested from the still-polluted data/daily.json copy) are
 * removed from English segments too, and a segment that ends up empty is
 * dropped from sections AND the index-aligned sectionsZh list together.
 * Translation channels that end up empty become undefined (entry kept).
 *
 * Usage:
 *   node scripts/repair-honeypots.mjs [--dry] [--only c1,c2]
 * Idempotent: files without \style are skipped.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { stripHiddenTex } from '../lib/render.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STATEMENTS_DIR = path.join(ROOT, 'data', 'statements');
const DAILY_PATH = path.join(ROOT, 'data', 'daily.json');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i === -1 ? dflt : argv[i + 1];
};
const ONLY = opt('--only', null);

// Honeypot \text payloads harvested from the still-polluted daily.json copy:
// the MathJax preview span leaks them as plain text beside the token, and the
// token may already be gone (earlier repair pass), so match the sentence
// itself. English sections only — the aligned translation entry is dropped
// together with its emptied segment.
let PAYLOADS = [];

async function loadPayloads() {
  let daily;
  try {
    daily = JSON.parse(await readFile(DAILY_PATH, 'utf8'));
  } catch {
    return;
  }
  const found = new Set();
  const visit = (o) => {
    if (typeof o === 'string') {
      if (o.includes('\\style')) {
        for (const m of o.matchAll(/\\text\{([^{}]+)\}/g)) {
          if (m[1].length > 12) found.add(m[1]);
        }
      }
    } else if (Array.isArray(o)) o.forEach(visit);
    else if (o && typeof o === 'object') Object.values(o).forEach(visit);
  };
  visit(daily);
  PAYLOADS = [...found];
}

/** Clean one English string; returns null when unchanged. */
const clean = (s) => {
  let out = stripHiddenTex(s);
  for (const p of PAYLOADS) if (out.includes(p)) out = out.split(p).join(' ');
  if (out === s) return null;
  const trimmed = out.replace(/\s+$/, '');
  return trimmed || '';
};

/** Translation channels: token strip only, payloads are English-only. */
const cleanZh = (s) => {
  const stripped = stripHiddenTex(s);
  if (stripped === s) return null;
  const trimmed = stripped.replace(/\s+$/, '');
  return trimmed || '';
};

function cleanStatement(st) {
  let segs = 0; // strings cleaned in place
  let channels = 0; // translation channels emptied → undefined
  let dropped = 0; // segments emptied → removed from both EN & ZH lists

  const cleanZhEntry = (entry) => {
    if (entry === undefined || entry === null || typeof entry !== 'object') return entry;
    for (const [ch, v] of Object.entries(entry)) {
      if (typeof v !== 'string') continue;
      const c = cleanZh(v);
      if (c === null) continue;
      segs++;
      if (c === '') {
        delete entry[ch];
        channels++;
      } else {
        entry[ch] = c;
      }
    }
    return entry;
  };

  const cleanList = (list) => {
    if (!Array.isArray(list)) return list;
    const out = [];
    for (const item of list) {
      if (typeof item !== 'string') {
        out.push(item);
        continue;
      }
      const c = clean(item);
      if (c === null) {
        out.push(item);
      } else {
        segs++;
        if (c === '') {
          dropped++;
        } else {
          out.push(c);
        }
      }
    }
    return out;
  };

  for (const field of ['title']) {
    if (typeof st[field] === 'string') {
      const c = clean(st[field]);
      if (c) st[field] = c;
      else if (c === '') st[field] = '';
    }
  }
  for (const [key, list] of Object.entries(st.sections || {})) {
    const next = cleanList(list);
    if (st.sectionsZh?.[key]) {
      const zh = st.sectionsZh[key];
      // 逐索引对齐:ZH 数组与原 EN 列表同位;被清空的 EN 段连同其 ZH 条目一起移除
      const nextZh = [];
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (typeof item === 'string' && clean(item) === '') continue;
        nextZh.push(cleanZhEntry(zh[i]));
      }
      st.sectionsZh[key] = nextZh;
    }
    st.sections[key] = next;
  }
  if (typeof st.titleZh === 'string') {
    const c = clean(st.titleZh);
    if (c) st.titleZh = c;
  } else if (st.titleZh && typeof st.titleZh === 'object') {
    cleanZhEntry(st.titleZh);
  }
  return { segs, channels, dropped };
}

async function main() {
  await loadPayloads();
  if (PAYLOADS.length) console.log(`Payload sentences from daily.json: ${PAYLOADS.length}`);
  const files = (await readdir(STATEMENTS_DIR)).filter((f) => f.endsWith('.json'));
  const targets = [];
  for (const f of files) {
    if (ONLY && !ONLY.split(',').includes(f.replace(/\.json$/, ''))) continue;
    const raw = await readFile(path.join(STATEMENTS_DIR, f), 'utf8');
    if (!raw.includes('\\style') && !PAYLOADS.some((p) => raw.includes(p))) continue;
    targets.push({ f, raw });
  }
  console.log(
    `Statements with honeypot markers: ${targets.length}${ONLY ? ` (only: ${ONLY})` : ''}${DRY ? ' [dry run]' : ''}`,
  );
  if (!targets.length) return;

  let cleaned = 0;
  for (const { f, raw } of targets) {
    let st;
    try {
      st = JSON.parse(raw);
    } catch {
      console.log(`  ✗ ${f} — JSON 解析失败,跳过`);
      continue;
    }
    const { segs, channels, dropped } = cleanStatement(st);
    const code = st.code || f.replace(/\.json$/, '');
    if (!segs && !channels && !dropped) {
      console.log(`  · ${code} — \\style 存在但非蜜罐,未改动`);
      continue;
    }
    cleaned++;
    const parts = [`${segs} 段清理`];
    if (dropped) parts.push(`${dropped} 段清空后移除`);
    if (channels) parts.push(`${channels} 个译文渠道清空`);
    console.log(`  ✓ ${code} — ${parts.join(', ')}`);
    if (!DRY) {
      await writeFile(path.join(STATEMENTS_DIR, f), JSON.stringify(st, null, 2) + '\n');
    }
  }
  console.log(`\nDone: ${cleaned} file(s) changed.${DRY ? ' (dry run — nothing written)' : ''}`);
}

main().catch((e) => {
  console.error('repair-honeypots failed:', e);
  process.exit(1);
});
