/**
 * Per-run AI translation records: source↔translation pairs built from the
 * repo's statement files. Shared by:
 *   - scripts/save-ci-log.mjs — writes public/ci-logs/<date>-<runId>.ai.json
 *     after every full CI run (one translation record per CI run, pruned
 *     together with the log files by date prefix)
 *   - app/logs/ai-demo/page.jsx — live demo view built at build time
 *
 * Statement content is the CURRENT repo state at record time, not a
 * point-in-time snapshot; segments a run actually translated are exactly
 * current right after it (translations are append-only unless a statement
 * is re-fetched by the repair pipeline).
 */
import fs from 'node:fs';
import path from 'node:path';

/** { code, title, segs: [{key, i, en, zh: {channel: text, aiModel?}}] } | null
 *  (`aiModel` is segment metadata riding in the zh map, not a channel:
 *  the serving model's display name recorded by scripts/translate-ai.mjs) */
export function loadStatementPairs(baseDir, code) {
  const file = path.join(baseDir, 'data', 'statements', `${String(code).toLowerCase()}.json`);
  let st;
  try {
    st = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const segs = [];
  if (typeof st.title === 'string' && st.title.trim()) {
    const zh =
      typeof st.titleZh === 'string'
        ? { legacy: st.titleZh }
        : st.titleZh && typeof st.titleZh === 'object'
          ? { ...st.titleZh }
          : {};
    segs.push({ key: 'title', i: 0, en: st.title, zh });
  }
  for (const [key, list] of Object.entries(st.sections || {})) {
    (list || []).forEach((en, i) => {
      if (typeof en !== 'string' || !en.trim()) return;
      const e = st.sectionsZh?.[key]?.[i];
      segs.push({
        key,
        i,
        en,
        zh: e && typeof e === 'object' ? { ...e } : typeof e === 'string' ? { legacy: e } : {},
      });
    });
  }
  return { code: st.code || String(code).toUpperCase(), title: st.title || '', segs };
}

/** summary.tokenSegments -> { `code:seg[i]`: {in, out, cached} } keyed like segTokenKey() */
export function buildTokensBySeg(tokenSegments = []) {
  const map = {};
  for (const t of tokenSegments || []) {
    if (t?.code && t.seg) map[`${String(t.code).toLowerCase()}:${t.seg}`] = { in: t.in || 0, out: t.out || 0, cached: t.cached || 0 };
  }
  return map;
}

/**
 * Full translation record for one CI run: { runId, startedAt, generatedAt,
 * tokenUsage, tokensBySeg, problems: [{code, title, segs, aiCount}] }.
 * Returns null when the run translated nothing (or no statement files exist).
 */
export function buildAiRecord(baseDir, { runId, startedAt, summary }) {
  const codes = summary?.aiByProblem || [];
  if (!codes.length) return null;
  const problems = [];
  for (const c of codes) {
    const p = loadStatementPairs(baseDir, c);
    if (!p) continue;
    problems.push({ ...p, aiCount: p.segs.filter((s) => s.zh.ai).length });
  }
  if (!problems.length) return null;
  return {
    runId,
    startedAt: startedAt || null,
    generatedAt: new Date().toISOString(),
    tokenUsage: summary.tokenUsage || null,
    tokensBySeg: buildTokensBySeg(summary.tokenSegments),
    problems,
  };
}
