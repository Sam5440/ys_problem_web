import Link from 'next/link';
import { getAllDays } from '@/lib/data';
import { formatDateCN, ratingColor } from '@/lib/render';

export const metadata = { title: '历史归档 · YS Problem Web' };

export default function ArchivePage() {
  const days = getAllDays();
  const months = new Map();
  for (const day of days) {
    const month = day.date.slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(day);
  }
  return (
    <>
      <section className="page-head">
        <h1 className="page-title">历史归档</h1>
        <p className="page-sub">共收录 {days.length} 天的每日两题，点击日期查看当日题目、提示与题解。</p>
      </section>
      {[...months.entries()].map(([month, list]) => (
        <section className="month-group" key={month}>
          <h2 className="month-title">{month.replace('-', ' 年 ')} 月</h2>
          <div className="archive-list">
            {list.map((day) => (
              <Link href={`/day/${day.date}`} className="archive-row" key={day.date}>
                <span className="archive-date">{formatDateCN(day.date)}</span>
                <span className="archive-problems">
                  {day.problems.map((p) => (
                    <span className="archive-problem" key={p.code}>
                      <span
                        className="diff-dot"
                        style={{ background: ratingColor(p.difficulty) }}
                        aria-hidden="true"
                      />
                      {p.statement?.title ? p.statement.title.replace(/^[A-Z][.)]\s*/, '') : p.code}
                      <em className="archive-diff">{String(p.difficulty).replace('*', '')}</em>
                    </span>
                  ))}
                </span>
                <span className="archive-arrow" aria-hidden="true">
                  →
                </span>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
