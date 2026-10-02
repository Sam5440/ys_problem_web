import './globals.css';
import 'katex/dist/katex.min.css';
import SiteHeader from '@/components/SiteHeader';
import { getMeta } from '@/lib/data';

export const metadata = {
  title: 'YS Problem Web · 每日 Codeforces 两题',
  description:
    '将 Yawn-Sean/Daily_CF_Problems 的每日 Codeforces 两题转换为直观的网页展示：完整题面、提示、题解与分类一览。',
};

export default function RootLayout({ children }) {
  const meta = getMeta();
  return (
    <html lang="zh-CN" className="dark">
      <body className="flex min-h-screen flex-col">
        <SiteHeader />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4">{children}</main>
        <footer className="border-t">
          <div className="mx-auto w-full max-w-6xl space-y-1 px-4 py-6 text-xs text-muted-foreground">
            <p>
              数据来自开源项目{' '}
              <a
                href="https://github.com/Yawn-Sean/Daily_CF_Problems"
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline-offset-4 hover:underline"
              >
                Yawn-Sean/Daily_CF_Problems
              </a>
              ，题面抓取自 Codeforces，仅作学习交流之用。
            </p>
            <p>数据更新于 {meta.generatedAt.slice(0, 10)} · 每日 0 点 / 4 点自动刷新 · 由 Vercel 驱动</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
