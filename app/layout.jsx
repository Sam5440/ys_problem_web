import './globals.css';
import 'katex/dist/katex.min.css';
import SiteHeader from '@/components/SiteHeader';
import Link from 'next/link';
import { getMeta } from '@/lib/data';

export const metadata = {
  title: 'YS Problem Web · 每日 Codeforces 两题',
  description:
    '将 Yawn-Sean/Daily_CF_Problems 的每日 Codeforces 两题转换为直观的网页展示：完整题面、提示、题解与分类一览。',
};

export default function RootLayout({ children }) {
  const meta = getMeta();
  return (
    <html lang="zh-CN">
      <body>
        <SiteHeader />
        <main className="shell main">{children}</main>
        <footer className="site-footer">
          <div className="shell footer-inner">
            <p>
              数据来自开源项目{' '}
              <a href="https://github.com/Yawn-Sean/Daily_CF_Problems" target="_blank" rel="noreferrer">
                Yawn-Sean/Daily_CF_Problems
              </a>
              ，题面抓取自 Codeforces，仅作学习交流之用。
            </p>
            <p className="footer-meta">
              数据更新于 {meta.generatedAt.slice(0, 10)} · 由{' '}
              <Link href="https://vercel.com" prefetch={false}>
                Vercel
              </Link>{' '}
              驱动
            </p>
          </div>
        </footer>
      </body>
    </html>
  );
}
