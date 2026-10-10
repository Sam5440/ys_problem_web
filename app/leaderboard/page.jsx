import LeaderboardClient from '@/components/LeaderboardClient';

export const metadata = { title: '排行榜 · Yawn-Sean 的每日两题' };

export default function LeaderboardPage() {
  return (
    <>
      <section className="py-10">
        <h1 className="text-3xl font-bold tracking-tight">排行榜</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          源仓库社区的每日两题打卡榜：每人每天最多计 2 题，连击按连续提交天数累计。
          打开页面时由浏览器直连上游 gh-pages 的 records 统计实时同步（10 分钟缓存），
          本站 CI 的构建快照仅在直连失败时兜底展示。
        </p>
      </section>
      <LeaderboardClient />
    </>
  );
}
