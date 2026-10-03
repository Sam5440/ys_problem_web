import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import ProblemCard from './ProblemCard';
import LanguageSidebar from './language-sidebar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { formatDateCN } from '@/lib/render';

export default function DayView({ day, latest }) {
  return (
    <div>
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
      <div className="grid gap-6 pb-4">
        {day.problems.map((p) => (
          <ProblemCard key={p.code} problem={p} />
        ))}
      </div>
    </div>
  );
}
