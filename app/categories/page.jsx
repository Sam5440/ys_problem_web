import { ExternalLink } from 'lucide-react';
import { getCategories } from '@/lib/data';
import { ratingColor } from '@/lib/render';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const metadata = { title: '题目分类 · 小羊肖恩的每日两题' };

const SHOW_PER_CATEGORY = 30;

export default function CategoriesPage() {
  const categories = getCategories();
  const total = categories.reduce((s, c) => s + c.count, 0);
  return (
    <>
      <section className="py-10">
        <h1 className="text-3xl font-bold tracking-tight">题目分类</h1>
        <p className="mt-2 text-muted-foreground">
          上游仓库按使用的算法/技巧将 {total} 道题归入 {categories.length} 个方法，展开查看。
        </p>
      </section>
      <Card className="mb-10 gap-0 py-0">
        <CardHeader className="border-b py-4">
          <CardTitle className="text-sm font-medium text-muted-foreground">算法 / 技巧</CardTitle>
        </CardHeader>
        <CardContent className="px-6 pb-2">
          <Accordion type="multiple" className="w-full">
            {categories.map((cat) => (
              <AccordionItem key={cat.name} value={cat.name}>
                <AccordionTrigger className="hover:no-underline">
                  <span className="flex items-center gap-3">
                    <span className="text-[15px] font-semibold capitalize">{cat.name.replace(/_/g, ' ')}</span>
                    <Badge variant="secondary" className="font-mono">
                      {cat.count}
                    </Badge>
                  </span>
                </AccordionTrigger>
                <AccordionContent>
                  <ul className="divide-y divide-border">
                    {cat.problems.slice(0, SHOW_PER_CATEGORY).map((p) => (
                      <li key={`${p.code}-${p.url}`} className="flex items-baseline gap-3 py-2">
                        <a
                          className="flex shrink-0 items-center gap-2 font-mono text-xs text-primary hover:underline"
                          href={p.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          <span
                            className="size-1.5 rounded-full"
                            style={{ background: ratingColor(p.difficulty) }}
                          />
                          {p.code}
                        </a>
                        <span className="truncate text-sm text-muted-foreground">{p.hint}</span>
                      </li>
                    ))}
                  </ul>
                  {cat.count > SHOW_PER_CATEGORY && (
                    <p className="pb-2 pt-3 text-xs text-muted-foreground">
                      还有 {cat.count - SHOW_PER_CATEGORY} 道 ·{' '}
                      <a
                        className="inline-flex items-center gap-1 font-medium text-foreground underline-offset-4 hover:underline"
                        href={cat.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        在 GitHub 查看全部
                        <ExternalLink className="size-3" />
                      </a>
                    </p>
                  )}
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </CardContent>
      </Card>
    </>
  );
}
