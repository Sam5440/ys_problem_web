import { Clock, ExternalLink, FileText, Lightbulb, MemoryStick } from 'lucide-react';
import Link from 'next/link';
import CopyBox from './CopyBox';
import StatementBody from './StatementBody';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { renderRich, ratingColor } from '@/lib/render';

function Chips({ problem }) {
  const s = problem.statement;
  const color = ratingColor(problem.difficulty);
  const isGym = /^gym/i.test(problem.code);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Badge
        variant="outline"
        className="border-transparent font-mono font-semibold text-white"
        style={{ background: color }}
      >
        {String(problem.difficulty).replace('*', '')}
      </Badge>
      {isGym && <Badge variant="secondary">GYM</Badge>}
      {s?.timeLimit && (
        <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
          <Clock className="size-3" />
          {s.timeLimit}
        </Badge>
      )}
      {s?.memoryLimit && (
        <Badge variant="outline" className="gap-1 font-normal text-muted-foreground">
          <MemoryStick className="size-3" />
          {s.memoryLimit}
        </Badge>
      )}
    </div>
  );
}

export default function ProblemCard({ problem }) {
  const s = problem.statement;
  const title = s?.title ? s.title.replace(/^[A-Z][.)]\s*/, '') : problem.code;
  return (
    <Card className="gap-4 scroll-mt-20" id={problem.code}>
      <CardHeader>
        <div className="flex flex-wrap items-start gap-4">
          <div className="grid size-11 shrink-0 place-items-center rounded-lg bg-primary text-xl font-bold text-primary-foreground">
            {s?.letter || '?'}
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-xl tracking-tight">{title}</CardTitle>
            <CardDescription className="mt-1 flex flex-wrap items-center gap-2 font-mono text-xs">
              <span>{problem.code}</span>
              {s?.contest && (
                <>
                  <span className="text-border">|</span>
                  <span className="font-sans">{s.contest}</span>
                </>
              )}
            </CardDescription>
            <div className="mt-3">
              <Chips problem={problem} />
            </div>
          </div>
          <Button asChild size="sm" className="ml-auto shrink-0">
            <a href={problem.url} target="_blank" rel="noreferrer">
              Codeforces
              <ExternalLink className="size-3.5" />
            </a>
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-5">
        {s ? (
          <StatementBody statement={s} />
        ) : (
          <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
            暂无完整题面（Codeforces 反爬限制），点击右上角按钮前往原题查看。
          </div>
        )}

        {(problem.hint || problem.solution?.markdown || problem.solution?.url) && (
          <Accordion type="multiple" className="rounded-lg border px-4">
            {problem.hint && (
              <AccordionItem value="hint">
                <AccordionTrigger className="text-sm text-muted-foreground hover:no-underline hover:text-foreground">
                  <span className="flex items-center gap-2">
                    <Lightbulb className="size-4" />
                    提示（Hint）
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <div className="md-body" dangerouslySetInnerHTML={{ __html: renderRich(problem.hint) }} />
                </AccordionContent>
              </AccordionItem>
            )}
            {(problem.solution?.markdown || problem.solution?.url) && (
              <AccordionItem value="solution">
                <AccordionTrigger className="text-sm text-muted-foreground hover:no-underline hover:text-foreground">
                  <span className="flex items-center gap-2">
                    <FileText className="size-4" />
                    题解（Editorial）
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  {problem.solution?.markdown ? (
                    <div className="md-body" dangerouslySetInnerHTML={{ __html: renderRich(problem.solution.markdown) }} />
                  ) : (
                    <Link href={problem.solution.url} target="_blank" className="text-primary hover:underline">
                      在 GitHub 上查看题解 ↗
                    </Link>
                  )}
                </AccordionContent>
              </AccordionItem>
            )}
          </Accordion>
        )}
      </CardContent>
    </Card>
  );
}
