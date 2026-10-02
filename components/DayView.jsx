import Link from 'next/link';
import ProblemCard from './ProblemCard';
import { formatDateCN } from '@/lib/render';

export default function DayView({ day, latest }) {
  return (
    <div className="day-view">
      <div className="day-head">
        <div className="day-head-left">
          <span className="date-chip">{formatDateCN(day.date)}</span>
          {latest && <span className="latest-chip">Latest</span>}
          <span className="day-count">{day.problems.length} 道题</span>
        </div>
        {!latest && (
          <Link href="/" className="text-link">
            返回最新一期 →
          </Link>
        )}
      </div>
      <div className="problem-list">
        {day.problems.map((p) => (
          <ProblemCard key={p.code} problem={p} />
        ))}
      </div>
    </div>
  );
}
