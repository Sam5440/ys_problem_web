import { CalendarCheck2, Flame, Trophy, Users } from 'lucide-react';
import { buildLeaderboardRows } from '@/lib/leaderboard';
import LeaderboardView from '@/components/LeaderboardView';
import { Card, CardContent } from '@/components/ui/card';

export const metadata = { title: '排行榜 · YS Problem Web' };

function StatCard({ icon: Icon, label, value, hint }) {
  return (
    <Card className="gap-0 py-4">
      <CardContent className="flex items-center gap-3 px-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="truncate text-lg font-semibold tabular-nums">{value}</p>
          <p className="truncate text-[11px] text-muted-foreground">{hint}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function LeaderboardPage() {
  const data = buildLeaderboardRows();

  if (!data) {
    return (
      <section className="py-16 text-center">
        <h1 className="text-2xl font-bold tracking-tight">排行榜暂无数据</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          未能加载源仓库的社区提交记录，可前往
          <a
            href="https://github.com/Yawn-Sean/Daily_CF_Problems/tree/gh-pages"
            target="_blank"
            rel="noreferrer"
            className="mx-1 font-medium text-foreground underline underline-offset-4"
          >
            上游 gh-pages
          </a>
          查看原始榜单。
        </p>
      </section>
    );
  }

  const { rows, currentDate } = data;
  const perfect = rows.filter((r) => r.latestScore === 2).length;
  const record = rows.reduce((best, r) => (r.maxStreak > best.maxStreak ? r : best), rows[0]);
  const totalSolves = rows.reduce((sum, r) => sum + r.totalSolves, 0);

  return (
    <>
      <section className="py-10">
        <h1 className="text-3xl font-bold tracking-tight">排行榜</h1>
        <p className="mt-2 max-w-3xl text-muted-foreground">
          源仓库社区的每日两题打卡榜：每人每天最多计 2 题，连击按连续提交天数累计。
          数据同步自上游 gh-pages 的 records 统计，本站每日随题库自动刷新。
        </p>
      </section>
      <section className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Users} label="上榜玩家" value={rows.length} hint={`统计截至 ${currentDate}`} />
        <StatCard icon={Trophy} label="最长连击纪录" value={`${record.maxStreak} 天`} hint={`保持者 ${record.user}`} />
        <StatCard icon={Flame} label="最近一日满贯" value={`${perfect} 人`} hint="当日两题全对" />
        <StatCard icon={CalendarCheck2} label="累计解题" value={totalSolves} hint="全体玩家总和" />
      </section>
      <section className="pb-14">
        <LeaderboardView data={data} />
      </section>
    </>
  );
}
