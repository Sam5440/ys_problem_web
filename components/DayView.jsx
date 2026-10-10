import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import ProblemCard from './ProblemCard';
import LanguageSidebar from './language-sidebar';
import CompilerDock from './compiler/CompilerDock';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { formatDateCN } from '@/lib/render';

/** 编译器面板只需要题号/标题/样例，序列化成轻量 props（题面本体不进客户端）。 */
function compilerProblems(day) {
  return day.problems.map((p) => ({
    code: p.code,
    title: p.statement?.title ? p.statement.title.replace(/^[A-Z][.)]\s*/, '') : p.code,
    letter: p.statement?.letter ?? null,
    examples: (p.statement?.examples ?? []).map((e) => ({ input: e.input ?? '', output: e.output ?? '' })),
    timeLimit: p.statement?.timeLimit ?? null,
    memoryLimit: p.statement?.memoryLimit ?? null,
    url: p.url,
  }));
}

export default function DayView({ day, latest }) {
  return (
    <>
      {/* 编译器面板本体经 portal 渲染进 layout 顶层的 #compiler-dock-root
          （整站让位分栏，见 globals.css「编译器独立工作区」），这里不占位。 */}
      <CompilerDock problems={compilerProblems(day)} />
      <LanguageSidebar />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold tracking-tight">{formatDateCN(day.date)}</h2>
        {latest && <Badge>Latest</Badge>}
        <span className="text-sm text-muted-foreground">{day.problems.length} 道题</span>
        {!latest && (
          <Button asChild variant="ghost" size="sm" className="ml-auto">
            <Link href="/">
              <ArrowLeft className="size-3.5" />
              返回最新一期
            </Link>
          </Button>
        )}
      </div>
      <Separator className="mb-6" />
      {/* grid-cols-1 pins the track to minmax(0,1fr): without it the implicit
          auto track grows to the min-content width of a long unbreakable line
          (code block in the editorial) and drags the whole page wider. */}
      <div className="grid grid-cols-1 gap-6 pb-4">
        {day.problems.map((p) => (
          <ProblemCard key={p.code} problem={p} />
        ))}
      </div>
    </>
  );
}
