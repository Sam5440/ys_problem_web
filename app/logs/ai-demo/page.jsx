import fs from 'node:fs';
import path from 'node:path';
import AiTranslateDetail from '@/components/ai-translate-detail';
import { buildTokensBySeg, loadStatementPairs } from '@/lib/ai-record.mjs';

export const metadata = {
  title: 'AI 翻译明细 · Demo · Yawn-Sean 的每日两题',
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
    .filter((f) => f.endsWith('.json') && !f.endsWith('.ai.json'))
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

const FALLBACK_CODES = ['GYM106235A', 'GYM106235B'];

export default function AiDemoPage() {
  const runs = loadRuns();
  const demoRuns = [];
  for (const run of runs) {
    const s = run.summary || {};
    if (!s.aiByProblem?.length) continue;
    const problems = s.aiByProblem.map((c) => loadStatementPairs(process.cwd(), c)).filter(Boolean);
    if (!problems.length) continue;
    demoRuns.push({
      runId: run.runId,
      event: run.event,
      startedAt: run.startedAt,
      url: run.url,
      aiDone: s.aiDone || 0,
      failures: s.aiLines?.filter((l) => l.startsWith('✗')).length || 0,
      tokenUsage: s.tokenUsage || null,
      tokensBySeg: buildTokensBySeg(s.tokenSegments),
      problems: problems.map((p) => ({
        ...p,
        aiCount: p.segs.filter((x) => x.zh.ai).length,
      })),
    });
  }
  if (!demoRuns.length) {
    const problems = FALLBACK_CODES.map((c) => loadStatementPairs(process.cwd(), c)).filter(Boolean);
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
