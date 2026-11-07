'use client';

import { Fragment, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ChevronDown, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';
import Heatmap from '@/components/Heatmap';

const COLUMNS = [
  { key: 'currentStreak', label: '当前连击', align: 'text-right' },
  { key: 'maxStreak', label: '最长连击', align: 'text-right' },
  { key: 'totalDays', label: '活跃天数', align: 'text-right' },
  { key: 'totalSolves', label: '解题总数', align: 'text-right' },
  { key: 'latestScore', label: '最近一日', align: 'text-center' },
];

const MEDALS = ['🥇', '🥈', '🥉'];

function LatestScore({ score }) {
  const tone =
    score === 2
      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
      : score === 1
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
        : 'text-muted-foreground';
  return (
    <Badge variant="outline" className={cn('px-2 py-0', tone)}>
      {score} 题
    </Badge>
  );
}

export default function LeaderboardView({ data }) {
  const { rows, currentDate, skippedDates } = data;
  const [sortKey, setSortKey] = useState('currentStreak');
  const [sortDir, setSortDir] = useState('desc');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(() => new Set());
  const [heatWindow, setHeatWindow] = useState('year');

  const ranks = useMemo(() => {
    const order = new Map();
    [...rows]
      .sort(
        (a, b) =>
          b.currentStreak - a.currentStreak ||
          b.maxStreak - a.maxStreak ||
          b.totalDays - a.totalDays ||
          b.totalSolves - a.totalSolves ||
          a.user.localeCompare(b.user),
      )
      .forEach((row, i) => order.set(row.user, i + 1));
    return order;
  }, [rows]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => r.user.toLowerCase().includes(q)) : rows;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      if (sortKey === 'user') return dir * a.user.localeCompare(b.user);
      return dir * (a[sortKey] - b[sortKey]) || a.user.localeCompare(b.user);
    });
  }, [rows, sortKey, sortDir, query]);

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortKey(key);
      setSortDir(key === 'user' ? 'asc' : 'desc');
    }
  }

  function toggleExpand(user) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(user)) next.delete(user);
      else next.add(user);
      return next;
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <label className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索玩家 ID…"
            className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <p className="text-xs text-muted-foreground sm:ml-auto">
          共 {rows.length} 名玩家 · 统计截至 {currentDate} · 点击行查看打卡热力图
        </p>
      </div>

      <Card className="gap-0 py-0">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="pl-6">排名</TableHead>
              <TableHead>
                <button
                  type="button"
                  onClick={() => toggleSort('user')}
                  className={cn('inline-flex items-center gap-1 hover:text-foreground', sortKey === 'user' && 'text-foreground')}
                >
                  玩家
                  {sortKey === 'user' && (sortDir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                </button>
              </TableHead>
              {COLUMNS.map((col) => (
                <TableHead key={col.key} className={col.align}>
                  <button
                    type="button"
                    onClick={() => toggleSort(col.key)}
                    className={cn(
                      'inline-flex items-center gap-1 hover:text-foreground',
                      sortKey === col.key && 'text-foreground',
                    )}
                  >
                    {col.label}
                    {sortKey === col.key &&
                      (sortDir === 'asc' ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
                  </button>
                </TableHead>
              ))}
              <TableHead className="w-10 pr-6" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.length === 0 && (
              <TableRow>
                <TableCell colSpan={COLUMNS.length + 3} className="py-10 text-center text-muted-foreground">
                  没有匹配「{query}」的玩家
                </TableCell>
              </TableRow>
            )}
            {visible.map((row) => {
              const rank = ranks.get(row.user);
              const open = expanded.has(row.user);
              return (
                <Fragment key={row.user}>
                  <TableRow
                    onClick={() => toggleExpand(row.user)}
                    className={cn('cursor-pointer', rank <= 3 && 'bg-muted/30')}
                  >
                    <TableCell className="pl-6 text-sm tabular-nums text-muted-foreground">
                      {rank <= 3 ? <span className="text-base">{MEDALS[rank - 1]}</span> : rank}
                    </TableCell>
                    <TableCell className="font-mono text-[13px] font-medium">{row.user}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      <span className={cn('inline-flex items-center gap-1 font-medium', row.currentStreak > 0 && 'text-orange-400')}>
                        {row.currentStreak > 0 && '🔥'}
                        {row.currentStreak}
                      </span>
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{row.maxStreak}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{row.totalDays}</TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">{row.totalSolves}</TableCell>
                    <TableCell className="text-center">
                      <LatestScore score={row.latestScore} />
                    </TableCell>
                    <TableCell className="pr-6 text-right">
                      <ChevronDown className={cn('ml-auto size-4 text-muted-foreground transition-transform', open && 'rotate-180')} />
                    </TableCell>
                  </TableRow>
                  {open && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={COLUMNS.length + 3} className="bg-muted/20 px-6 py-4">
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="text-sm font-medium">
                              {row.user} 的打卡记录
                              <span className="ml-2 text-xs font-normal text-muted-foreground">
                                当前连击 {row.currentStreak} 天 · 最长 {row.maxStreak} 天 · 累计 {row.totalSolves} 题
                              </span>
                            </p>
                            <div className="ml-auto flex items-center gap-1 rounded-md border p-0.5">
                              {[
                                ['year', '近一年'],
                                ['all', '全部'],
                              ].map(([value, label]) => (
                                <button
                                  key={value}
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setHeatWindow(value);
                                  }}
                                  className={cn(
                                    'rounded px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground',
                                    heatWindow === value && 'bg-muted text-foreground',
                                  )}
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          </div>
                          <Heatmap
                            series={row.series}
                            currentDate={currentDate}
                            skipped={skippedDates}
                            window={heatWindow}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </Card>
    </div>
  );
}
