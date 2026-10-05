import Link from 'next/link';
import { ArrowRight, BookOpen, Layers } from 'lucide-react';
import DayView from '@/components/DayView';
import UpstreamLatest from '@/components/UpstreamLatest';
import { Button } from '@/components/ui/button';
import { getLatestDay, getAllDays } from '@/lib/data';

export default function Home() {
  const day = getLatestDay();
  const days = getAllDays();
  if (!day) {
    return (
      <div className="py-24 text-center">
        <h1 className="text-2xl font-semibold">暂无数据</h1>
        <p className="mt-2 text-sm text-muted-foreground">请运行 npm run update-data 同步数据。</p>
      </div>
    );
  }
  return (
    <>
      <section className="py-12 sm:py-16">
        <h1 className="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
          每日 Codeforces 两题，
          <br />
          <span className="text-muted-foreground">直接读题面。</span>
        </h1>
        <p className="mt-4 max-w-xl text-muted-foreground">
          完整题面 · 提示 · 题解，直接在网页上阅读。来自开源社区 Daily_CF_Problems
          的每日练习，已收录 {days.length} 天，每小时自动同步上游。
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Button asChild>
            <Link href="/archive">
              <Layers className="size-4" />
              浏览历史归档
            </Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/categories">
              <BookOpen className="size-4" />
              按算法分类
            </Link>
          </Button>
        </div>
      </section>
      <UpstreamLatest
        localDate={day.date}
        localCodes={day.problems.map((p) => p.code.toLowerCase())}
      />
      <DayView day={day} latest />
    </>
  );
}
