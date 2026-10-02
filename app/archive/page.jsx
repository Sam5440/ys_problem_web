import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { getAllDays } from '@/lib/data';
import { formatDateCN, ratingColor } from '@/lib/render';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

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
      <section className="py-10">
        <h1 className="text-3xl font-bold tracking-tight">历史归档</h1>
        <p className="mt-2 text-muted-foreground">
          共收录 {days.length} 天的每日两题，点击日期查看当日题目、提示与题解。
        </p>
      </section>
      {[...months.entries()].map(([month, list]) => (
        <section className="mb-8" key={month}>
          <Card className="gap-0 py-0">
            <CardHeader className="border-b py-4">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {month.replace('-', ' 年 ')} 月
              </CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-6">日期</TableHead>
                    <TableHead>题目</TableHead>
                    <TableHead className="w-10 pr-6" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((day) => (
                    <TableRow key={day.date}>
                      <TableCell className="pl-6 font-medium">
                        <Link href={`/day/${day.date}`} className="hover:underline">
                          {formatDateCN(day.date)}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-x-5 gap-y-1">
                          {day.problems.map((p) => (
                            <Link
                              key={p.code}
                              href={`/day/${day.date}`}
                              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
                            >
                              <span
                                className="size-2 shrink-0 rounded-full"
                                style={{ background: ratingColor(p.difficulty) }}
                              />
                              <span>
                                {p.statement?.title
                                  ? p.statement.title.replace(/^[A-Z][.)]\s*/, '')
                                  : p.code}
                              </span>
                              <Badge variant="outline" className="px-1.5 py-0 font-mono text-[11px]">
                                {String(p.difficulty).replace('*', '')}
                              </Badge>
                            </Link>
                          ))}
                        </div>
                      </TableCell>
                      <TableCell className="pr-6 text-right">
                        <Link
                          href={`/day/${day.date}`}
                          aria-label={`查看 ${day.date}`}
                          className="inline-flex text-muted-foreground hover:text-foreground"
                        >
                          <ArrowRight className="size-4" />
                        </Link>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </section>
      ))}
    </>
  );
}
