'use client';

/**
 * CI 日志 list. The server page reads public/ci-logs/*.json (written by the
 * workflow's save step after every run) and passes them in as props — the
 * list needs no API at runtime. Expanding a run lazily fetches its static
 * raw log from /ci-logs/<file> (served by Vercel's CDN) and renders it.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const DAY = 86_400_000;
const DEFAULT_DAYS = 7;
const RETENTION_DAYS = 60;

const relTime = (iso) => {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.round(diff / 60000);
  if (m < 1) return '刚刚';
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.round(h / 24);
  return d <= 30 ? `${d} 天前` : new Date(iso).toLocaleDateString('zh-CN');
};

const EVENT_LABEL = { schedule: '定时', workflow_dispatch: '手动', push: '推送' };

function Chip({ tone = 'muted', children }) {
  const cls =
    tone === 'accent'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
      : tone === 'bad'
        ? 'border-red-500/40 bg-red-500/10 text-red-400'
        : 'border-border bg-muted text-muted-foreground';
  return <span className={`rounded border px-1 py-px text-[10px] ${cls}`}>{children}</span>;
}

function RunCard({ run, expanded, onToggle }) {
  const [log, setLog] = useState(null); // raw text
  const [logState, setLogState] = useState('idle'); // idle|loading|ready|error
  const s = run.summary || {};
  const failure = run.failure;

  const chips = [];
  if (failure) chips.push(['bad', '运行失败']);
  if (s.fetched?.length) chips.push(['accent', `拉取题面 ${s.fetched.length}`]);
  if (s.aiDone || s.aiByProblem?.length) chips.push(['accent', `AI 翻译 ${s.aiDone || 0} 段`]);
  if (s.addedFiles?.length) chips.push(['accent', `入库 ${s.addedFiles.length} 文件`]);
  if (!failure && !chips.length) chips.push(['muted', '无数据变更']);

  const toggleLog = async () => {
    if (logState === 'ready') {
      setLogState('idle');
      return;
    }
    if (logState === 'loading') return;
    setLogState('loading');
    try {
      const res = await fetch(run.logFile);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setLog(await res.text());
      setLogState('ready');
    } catch (e) {
      setLog(`（日志加载失败：${e.message}）`);
      setLogState('error');
    }
  };

  return (
    <Card className="scroll-mt-20" id={`run-${run.runId}`}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex w-full items-start gap-3 p-4 text-left">
        <span className={`mt-0.5 font-mono ${failure ? 'text-red-400' : 'text-emerald-500'}`}>{failure ? '✗' : '✓'}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{run.jobName || 'Update daily problems data'}</span>
            {EVENT_LABEL[run.event] && (
              <span className="rounded border px-1 py-px text-[10px] text-muted-foreground">{EVENT_LABEL[run.event] || run.event}</span>
            )}
            <span className="font-mono text-[10px] text-muted-foreground">run {run.runId}</span>
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {new Date(run.startedAt).toLocaleString('zh-CN')} · {relTime(run.startedAt)}
          </span>
          <span className="mt-1.5 flex flex-wrap gap-1">
            {chips.map(([tone, label]) => (
              <Chip key={label} tone={tone}>
                {label}
              </Chip>
            ))}
          </span>
        </span>
      </button>

      {expanded && (
        <CardContent className="space-y-4 border-t pt-4">
          {(s.fetched?.length || s.fetchFailed?.length) > 0 && (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">抓取题面</p>
              <ul className="mt-0.5 space-y-0.5">
                {(s.fetched || []).map((f) => (
                  <li key={f.code} className="text-[11px] text-foreground/80">
                    <span className="font-mono">{f.code}</span> — {f.title}
                  </li>
                ))}
                {(s.fetchFailed || []).map((c) => (
                  <li key={c} className="text-[11px] text-amber-500">
                    <span className="font-mono">{c}</span> — 未抓到题面
                  </li>
                ))}
              </ul>
            </div>
          )}

          {(s.aiByProblem?.length || s.aiDone) > 0 && (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                AI 翻译（deepseek-v4-flash）
              </p>
              {s.aiByProblem?.length > 0 && (
                <p className="mt-0.5 font-mono text-[11px] text-foreground/80">{s.aiByProblem.join('、 ')}</p>
              )}
              {s.aiLines?.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {s.aiLines.map((l, i) => (
                    <li key={i} className="truncate font-mono text-[11px] text-muted-foreground" title={l}>
                      {l}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {s.addedFiles?.length > 0 && (
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">本次入库文件</p>
              <p className="mt-0.5 font-mono text-[11px] text-foreground/80">{s.addedFiles.join('、 ')}</p>
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button variant="outline" size="sm" className="h-7 px-2.5 text-xs" onClick={toggleLog}>
              {logState === 'loading' ? '加载中…' : logState === 'ready' ? '收起完整日志' : '查看完整日志'}
            </Button>
            <a href={run.url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
              在 GitHub 上查看此次运行 ↗
            </a>
          </div>
          {(logState === 'ready' || logState === 'error') && (
            <pre className="max-h-[32rem] overflow-auto rounded-lg border bg-background p-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
              {log}
            </pre>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export default function LogsView({ runs = [] }) {
  const [expandedAll, setExpandedAll] = useState(false); // false = trim to DEFAULT_DAYS
  const [expandedId, setExpandedId] = useState(null);

  const cutoff7 = Date.now() - DEFAULT_DAYS * DAY;
  const cutoff60 = Date.now() - RETENTION_DAYS * DAY;
  const within60 = runs.filter((r) => Date.parse(r.startedAt) >= cutoff60);
  const visible = expandedAll ? within60 : within60.filter((r) => Date.parse(r.startedAt) >= cutoff7);
  // older-than-window runs already loaded, or more may exist within retention
  const hasMore = !expandedAll && within60.some((r) => Date.parse(r.startedAt) < cutoff7);

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        共 {visible.length} 次运行{!expandedAll && `（默认展示最近 ${DEFAULT_DAYS} 天）`} · 仓库内滚动保留 {RETENTION_DAYS} 天
      </p>
      {visible.map((r) => (
        <RunCard key={r.runId} run={r} expanded={expandedId === r.runId} onToggle={() => setExpandedId(expandedId === r.runId ? null : r.runId)} />
      ))}
      {visible.length === 0 && (
        <p className="text-sm text-muted-foreground">
          暂无日志。每次完整运行（上游有更新或手动触发）结束后会自动保存日志到这里。
        </p>
      )}
      {hasMore && (
        <Button variant="outline" size="sm" onClick={() => setExpandedAll(true)}>
          更多（查看更早的运行）
        </Button>
      )}
    </div>
  );
}
