'use client';

import { useEffect, useState } from 'react';
import { CalendarCheck2, Flame, Trophy, Users } from 'lucide-react';
import { buildLeaderboardRows } from '@/lib/leaderboard';
import LeaderboardView from '@/components/LeaderboardView';
import { Card, CardContent } from '@/components/ui/card';

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

/** Data arrives from /leaderboard.json (generated at build time) instead of
    being serialized into the prerendered page — the RSC payload used to carry
    every player's full day series (~15MB per deployment). */
export default function LeaderboardClient() {
  const [data, setData] = useState(undefined); // undefined = loading, null = no data

  useEffect(() => {
    let alive = true;
    fetch('/leaderboard.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive) setData(buildLeaderboardRows(j));
      })
      .catch(() => {
        if (alive) setData(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (data === undefined) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[70px] animate-pulse rounded-xl border border-border/60 bg-muted/30" />
        ))}
      </div>
    );
  }

  if (!data) {
    return (
      <section className="py-16 text-center">
        <h2 className="text-2xl font-bold tracking-tight">排行榜暂无数据</h2>
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
