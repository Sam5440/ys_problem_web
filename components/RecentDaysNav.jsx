import Link from 'next/link';
import { CalendarDays } from 'lucide-react';
import { ratingColor } from '@/lib/render';

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

function dayLabel(date) {
  const [, m, d] = String(date).split('-').map(Number);
  const weekday = WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return { md: `${m}/${d}`, weekday };
}

/** 最近 7 天的快速入口：每天的日期整卡可点，两道题各自直达题面锚点。
    纯服务端组件——数据在构建期取自 daily.json，零客户端 JS。 */
export default function RecentDaysNav({ days }) {
  const recent = days.slice(0, 7);
  if (recent.length < 2) return null;
  return (
    <section className="mb-10">
      <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
        <CalendarDays className="size-4" />
        最近 7 天
      </h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {recent.map((day) => {
          const { md, weekday } = dayLabel(day.date);
          return (
            <div
              key={day.date}
              className="rounded-lg border bg-card px-3 py-2.5 transition-colors hover:border-primary/40"
            >
              <Link
                href={`/day/${day.date}`}
                className="flex items-baseline justify-between text-sm font-semibold tabular-nums hover:text-primary"
              >
                {md}
                <span className="text-[11px] font-normal text-muted-foreground">
                  周{weekday}
                </span>
              </Link>
              <div className="mt-1.5 flex flex-col gap-1">
                {day.problems.map((p) => (
                  <Link
                    key={p.code}
                    href={`/day/${day.date}#${p.code}`}
                    className="flex items-center justify-between gap-1.5 font-mono text-xs text-muted-foreground hover:text-foreground hover:underline"
                    title={`${p.code} · ${p.difficulty || ''}`}
                  >
                    <span className="min-w-0 truncate">
                      <span className="mr-1.5 inline-block size-1.5 rounded-full align-middle" style={{ background: ratingColor(p.difficulty) }} />
                      {p.code}
                    </span>
                    {p.difficulty ? (
                      <span
                        className="shrink-0 font-semibold tabular-nums"
                        style={{ color: ratingColor(p.difficulty) }}
                      >
                        {String(p.difficulty).replace('*', '')}
                      </span>
                    ) : null}
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
