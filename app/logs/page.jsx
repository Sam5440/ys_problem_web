import fs from 'node:fs';
import path from 'node:path';
import { Activity } from 'lucide-react';
import LogsView from '@/components/logs-view';

export const metadata = {
  title: 'CI 日志 · YS Problem Web',
  description: '数据同步 workflow 的运行日志：每次运行后自动落盘提交到仓库，滚动保留 60 天。',
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
    .filter((f) => f.endsWith('.json') && !f.endsWith('.ai.json')) // .ai.json = per-run translation records, fetched lazily on expand
    .map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const base = f.replace(/\.json$/, '');
        return {
          ...j,
          logFile: `/ci-logs/${base}.log`,
          ...(j.summary?.aiByProblem?.length ? { aiFile: `/ci-logs/${base}.ai.json` } : {}),
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export default function LogsPage() {
  const runs = loadRuns();
  return (
    <main className="mx-auto w-full max-w-6xl px-4 py-8">
      <div className="mb-6 flex items-start gap-3">
        <span className="mt-1 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-2">
          <Activity className="h-5 w-5 text-emerald-500" />
        </span>
        <div>
          <h1 className="text-2xl font-bold tracking-tight">CI 日志</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            每次数据同步 workflow 结束后自动把完整日志存进仓库（滚动保留 60 天）。展开任一次运行可查看流水线时序图、抓取 / 翻译明细与原始日志。
          </p>
        </div>
      </div>
      <LogsView runs={runs} />
    </main>
  );
}
