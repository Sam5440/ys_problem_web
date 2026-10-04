import LogsView from '@/components/logs-view';

export const metadata = {
  title: 'CI 日志 · YS Problem Web',
  description: '每日数据同步 workflow 的全部运行记录：拉取了哪些题目、翻译了哪些段落、完整 CI 日志。',
};

export default function LogsPage() {
  return (
    <main className="mx-auto w-full max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-bold tracking-tight">CI 日志</h1>
      <p className="mt-1 mb-6 text-sm text-muted-foreground">
        数据同步 workflow（每日抓题 + AI 翻译）的全部运行记录。点击任一次运行查看任务步骤与完整日志。
      </p>
      <LogsView />
    </main>
  );
}
