import './globals.css';
import 'katex/dist/katex.min.css';
import SiteHeader from '@/components/SiteHeader';
import { SettingsProvider } from '@/components/settings';
import KatexRuntime from '@/components/KatexRuntime';
import HighlightRuntime from '@/components/HighlightRuntime';
import DataFreshness from '@/components/DataFreshness';
import GithubMark from '@/components/github-mark';

export const metadata = {
  title: 'Yawn-Sean 的每日两题',
  description:
    '将 Yawn-Sean/Daily_CF_Problems 的每日 Codeforces 两题转换为直观的网页展示：完整题面、提示、题解与分类一览。',
};

export default function RootLayout({ children }) {
  return (
    <html lang="zh-CN" className="dark">
      <body>
        <KatexRuntime />
        <HighlightRuntime />
        <SettingsProvider>
          <div className="compiler-workspace">
            <div className="site-shell">
              <SiteHeader />
              <main className="mx-auto w-full max-w-6xl flex-1 px-4">{children}</main>
              <footer className="border-t">
                <div className="mx-auto w-full max-w-6xl space-y-2.5 px-4 py-6 text-xs text-muted-foreground">
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px]">
                    <a
                      href="https://github.com/Sam5440/ys_problem_web"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      <GithubMark className="size-3.5 shrink-0" />
                      本站仓库：Sam5440/ys_problem_web
                    </a>
                    <a
                      href="https://github.com/Yawn-Sean/Daily_CF_Problems"
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1.5 font-medium text-foreground underline-offset-4 hover:underline"
                    >
                      <GithubMark className="size-3.5 shrink-0" />
                      题目来源：Yawn-Sean/Daily_CF_Problems
                    </a>
                  </div>
                  <p>每日 Codeforces 两题，题面抓取自 Codeforces，仅作学习交流之用。</p>
                  <p><DataFreshness />每日 0 点 / 4 点自动刷新 · 由 Vercel 驱动</p>
                </div>
              </footer>
            </div>
            {/* 编译器独立工作区右列：CompilerDock 通过 portal 挂进来
                （见 components/compiler/CompilerDock.jsx）。
                没有编译器的页面保持 0 宽，不影响排版。 */}
            <div className="compiler-track" id="compiler-dock-root" />
          </div>
        </SettingsProvider>
      </body>
    </html>
  );
}
