'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SettingsGearButton } from './settings';
import GithubMark from './github-mark';

const NAV = [
  { href: '/', label: '今日两题' },
  { href: '/archive', label: '历史归档' },
  { href: '/categories', label: '题目分类' },
  { href: '/leaderboard', label: '排行榜' },
  { href: '/logs', label: '日志' },
];

export default function SiteHeader() {
  const pathname = usePathname();
  // 编译器只在首页/日页存在（DayView 挂载 CompilerDock）；开合状态经
  // body.compiler-open 同步（CompilerDock 是唯一写方，这里只读）。
  const dockAvailable = pathname === '/' || pathname.startsWith('/day');
  const [dockOpen, setDockOpen] = useState(false);

  useEffect(() => {
    if (!dockAvailable) return;
    const sync = () => setDockOpen(document.body.classList.contains('compiler-open'));
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, [dockAvailable]);

  const toggleCompiler = () => {
    window.dispatchEvent(new CustomEvent('ysc-compiler-toggle'));
  };

  return (
    <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur">
      <div className="header-inner mx-auto flex h-14 w-full max-w-6xl items-center gap-6 px-4">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-sm">🐑</span>
          <span className="text-[15px] font-semibold tracking-tight">
            Yawn-Sean <span className="text-muted-foreground">的每日两题</span>
          </span>
        </Link>
        <nav className="header-nav ml-2 hidden items-center gap-1 sm:flex">
          {NAV.map((item) => {
            const active = item.href === '/' ? pathname === '/' : pathname.startsWith(item.href);
            return (
              <Button key={item.href} asChild variant="ghost" size="sm">
                <Link
                  href={item.href}
                  className={active ? 'text-foreground' : 'text-muted-foreground'}
                >
                  {item.label}
                </Link>
              </Button>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {dockAvailable && (
            <Button
              size="sm"
              className="compiler-launch"
              onClick={toggleCompiler}
              aria-expanded={dockOpen}
              aria-controls="compiler-panel"
              title={dockOpen ? '收起编译器工作区（Ctrl/⌘+J）' : '打开编译器工作区（Ctrl/⌘+J）'}
            >
              <Terminal className="size-3.5" />
              编译器
              <kbd>⌘ J</kbd>
            </Button>
          )}
          <SettingsGearButton />
          <Button asChild size="sm">
            <a href="https://github.com/Yawn-Sean/Daily_CF_Problems" target="_blank" rel="noreferrer" title="题目来源仓库：Yawn-Sean/Daily_CF_Problems">
              <GithubMark className="size-3.5" />
              题目来源
            </a>
          </Button>
        </div>
      </div>
    </header>
  );
}
