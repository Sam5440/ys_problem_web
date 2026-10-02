import Link from 'next/link';
import DayView from '@/components/DayView';
import { getLatestDay, getAllDays } from '@/lib/data';

export default function Home() {
  const day = getLatestDay();
  const days = getAllDays();
  if (!day) {
    return (
      <div className="empty">
        <h1>暂无数据</h1>
        <p>请运行 npm run update-data 同步数据。</p>
      </div>
    );
  }
  return (
    <>
      <section className="hero">
        <h1 className="hero-title">
          每日 <span className="grad">Codeforces</span> 两题
        </h1>
        <p className="hero-sub">
          完整题面 · 提示 · 题解，直接在网页上阅读。来自开源社区 Daily_CF_Problems 的每日练习，已收录{' '}
          {days.length} 天。
        </p>
        <div className="hero-actions">
          <Link href="/archive" className="ghost-btn">
            浏览历史归档
          </Link>
          <Link href="/categories" className="ghost-btn">
            按算法分类
          </Link>
        </div>
      </section>
      <DayView day={day} latest />
    </>
  );
}
