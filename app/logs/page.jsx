import fs from 'node:fs';
import path from 'node:path';
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
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { ...j, logFile: `/ci-logs/${f.replace(/\.json$/, '.log')}` };
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
    <main className="mx-auto w-full max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-bold tracking-tight">CI 日志</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        每次数据同步 workflow 结束后自动把完整日志存进仓库（滚动保留 60 天）。点击任一次运行查看拉取、翻译明细与完整日志。
      </p>
      <LogsView runs={runs} />
    </main>
  );
}
