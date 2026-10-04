import fs from 'node:fs';
import path from 'node:path';
import AiTranslateDetail from '@/components/ai-translate-detail';

export const metadata = {
  title: 'AI 翻译明细 · Demo · YS Problem Web',
  description: 'Demo：逐段原文↔译文对照视图（本地演示，未发布）。',
};

function loadRuns() {
  const dir = path.join(process.cwd(), 'public', 'ci-logs');
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** Build {key,i,en,zh:{channel:text}} pairs for one statement file. */
function loadProblemDetail(code) {
  const file = path.join(process.cwd(), 'data', 'statements', `${code.toLowerCase()}.json`);
  let st;
  try {
    st = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const segs = [];
  if (typeof st.title === 'string' && st.title.trim()) {
    const zh =
      typeof st.titleZh === 'string' ? { legacy: st.titleZh } : st.titleZh && typeof st.titleZh === 'object' ? { ...st.titleZh } : {};
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
  return { code: st.code || code.toUpperCase(), title: st.title || '', segs };
}

const FALLBACK_CODES = ['GYM106235A', 'GYM106235B'];

export default function AiDemoPage() {
  const runs = loadRuns();
  const demoRuns = [];
  for (const run of runs) {
    const s = run.summary || {};
    if (!s.aiByProblem?.length) continue;
    const problems = s.aiByProblem.map(loadProblemDetail).filter(Boolean);
    if (!problems.length) continue;
    // per-segment token usage from the CI log summary, keyed `code:seg[i]`
    const tokensBySeg = {};
    for (const t of s.tokenSegments || []) {
      if (t?.code && t.seg) tokensBySeg[`${t.code.toLowerCase()}:${t.seg}`] = { in: t.in, out: t.out };
    }
    demoRuns.push({
      runId: run.runId,
      event: run.event,
      startedAt: run.startedAt,
      url: run.url,
      aiDone: s.aiDone || 0,
      failures: s.aiLines?.filter((l) => l.startsWith('✗')).length || 0,
      tokenUsage: s.tokenUsage || null,
      tokensBySeg,
      problems: problems.map((p) => ({
        ...p,
        aiCount: p.segs.filter((x) => x.zh.ai).length,
      })),
    });
  }
  if (!demoRuns.length) {
    const problems = FALLBACK_CODES.map(loadProblemDetail).filter(Boolean);
    demoRuns.push({
      runId: 0,
      event: 'demo',
      startedAt: new Date().toISOString(),
      url: '/logs',
      aiDone: 0,
      failures: 0,
      tokenUsage: null,
      tokensBySeg: {},
      problems: problems.map((p) => ({
        ...p,
        aiCount: p.segs.filter((x) => x.zh.ai).length,
      })),
    });
  }
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <div className="mb-6">
        <a href="/logs" className="text-xs text-muted-foreground hover:text-foreground">
          ← 返回 CI 日志
        </a>
        <h1 className="mt-2 flex items-center gap-2 text-2xl font-bold tracking-tight">
          AI 翻译明细
          <span className="rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-500">
            Demo · 本地演示
          </span>
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          逐段展示「哪一段原文 → 翻成了哪一段译文」，可切换五个翻译渠道对照质量。数据取自仓库内题面 JSON；正式版将在展开某次运行时显示对应明细。
        </p>
      </div>
      <AiTranslateDetail runs={demoRuns} />
    </main>
  );
}
