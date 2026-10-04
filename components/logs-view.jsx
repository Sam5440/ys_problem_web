'use client';

/**
 * CI 日志 page: every run of the repo's "Update daily problems data"
 * workflow. The list shows the essentials — result, time, duration, and a
 * parsed summary of what the run pulled / translated (from the pushed
 * commit's file list, public for every historical run); clicking a run
 * reveals its jobs/steps, the changed files, and the full raw log when a
 * GH_TOKEN is configured server-side (GitHub's log download API is
 * token-only even for public repos — otherwise we link out).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

const DAY = 86_400_000;
const DEFAULT_DAYS = 7;

/* ---------------- helpers ---------------- */

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

const durText = (run) => {
  const end = run.updatedAt && run.status === 'completed' ? Date.parse(run.updatedAt) : null;
  const start = Date.parse(run.runStartedAt || run.createdAt);
  if (!end || !start) return null;
  const s = Math.max(0, Math.round((end - start) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${s % 60}s` : `${s}s`;
};

const EVENT_LABEL = { schedule: '定时', workflow_dispatch: '手动', push: '推送' };

const conclusionIcon = (c, status) => {
  if (status !== 'completed') return '⏳';
  if (c === 'success') return '✓';
  if (c === 'failure') return '✗';
  return '–';
};

const conclusionTone = (c, status) =>
  status !== 'completed'
    ? 'text-amber-500'
    : c === 'success'
      ? 'text-emerald-500'
      : c === 'failure'
        ? 'text-red-400'
        : 'text-muted-foreground';

/** Pull the interesting raw-log lines (AI translation results etc.). */
function summarizeLog(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const re = /✓ (title|legend|input|output|note)\[|✗ |Done: \d+ segment/;
  const out = [];
  for (const l of lines) {
    if (re.test(l)) {
      out.push(l.replace(/^.*?Z\s*/, '').replace(/\^\[\d+m/g, '').trim());
      if (out.length >= 20) break;
    }
  }
  return out;
}

/** Compact change summary from the run's pushed commit. */
function commitSummary(commit) {
  if (!commit) return null;
  const files = commit.files || [];
  const added = files.filter((f) => f.status === 'added' && f.file.startsWith('data/statements/'));
  const modified = files.filter((f) => f.status === 'modified' && f.file.startsWith('data/statements/'));
  const daily = files.some((f) => f.file === 'data/daily.json');
  const board = files.some((f) => f.file === 'data/leaderboard.json');
  const chips = [];
  if (added.length) chips.push(`拉取题面 ${added.length}`);
  if (modified.length) chips.push(`翻译/数据更新 ${modified.length} 题面`);
  if (daily) chips.push('数据同步');
  if (board) chips.push('榜单更新');
  if (!chips.length) chips.push('无数据变更');
  return { chips, added, modified };
}

/* ---------------- run card ---------------- */

function RunCard({ run, detail, detailError, expanded, onToggle }) {
  const [openLog, setOpenLog] = useState(null);
  const dur = durText(run);
  const summary = commitSummary(detail?.commit);
  const skipped =
    detail?.jobs?.some((j) => j.steps?.some((s) => s.conclusion === 'skipped' && /sync/i.test(s.name))) &&
    !summary?.chips.some((c) => c !== '无数据变更');
  const isRunSkip =
    detail?.jobs?.length &&
    detail.jobs[0].steps?.filter((s) => s.conclusion === 'skipped').length >= 6;

  return (
    <Card className="scroll-mt-20" id={`run-${run.id}`}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex w-full items-start gap-3 p-4 text-left"
      >
        <span className={`mt-0.5 font-mono ${conclusionTone(run.conclusion, run.status)}`}>
          {conclusionIcon(run.conclusion, run.status)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{run.displayTitle || run.name}</span>
            {EVENT_LABEL[run.event] && (
              <span className="rounded border px-1 py-px text-[10px] text-muted-foreground">
                {EVENT_LABEL[run.event] || run.event}
              </span>
            )}
            {run.headSha && <span className="font-mono text-[10px] text-muted-foreground">{run.headSha}</span>}
          </span>
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {new Date(run.runStartedAt || run.createdAt).toLocaleString('zh-CN')} · {relTime(run.runStartedAt || run.createdAt)}
            {dur && ` · 耗时 ${dur}`}
            {run.status !== 'completed' && ' · 运行中…'}
          </span>
          {(summary || skipped || detailError) && (
            <span className="mt-1.5 flex flex-wrap gap-1">
              {isRunSkip && <Chip tone="muted">上游未更新，空跑跳过</Chip>}
              {summary?.chips.map((c) => (
                <Chip key={c} tone={c === '无数据变更' ? 'muted' : 'accent'}>
                  {c}
                </Chip>
              ))}
              {detailError && <Chip tone="muted">概要加载失败</Chip>}
              {!detail && !detailError && <Chip tone="muted">概要加载中…</Chip>}
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <CardContent className="space-y-4 border-t pt-4">
          {!detail && !detailError && <p className="text-xs text-muted-foreground">加载运行详情…</p>}
          {detailError && <p className="text-xs text-red-400">详情加载失败：{detailError}</p>}

          {detail && (
            <>
              {summary && (summary.added.length || summary.modified.length) > 0 && (
                <div className="space-y-2">
                  {summary.added.length > 0 && (
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">新拉取的题面</p>
                      <p className="mt-0.5 font-mono text-[11px] text-foreground/80">
                        {summary.added.map((f) => f.file.replace('data/statements/', '').replace('.json', '')).join('、 ')}
                      </p>
                    </div>
                  )}
                  {summary.modified.length > 0 && (
                    <div>
                      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                        更新的题面（翻译 / 数据）
                      </p>
                      <p className="mt-0.5 font-mono text-[11px] text-foreground/80">
                        {summary.modified
                          .map((f) => `${f.file.replace('data/statements/', '').replace('.json', '')}(+${f.additions}/-${f.deletions})`)
                          .join('、 ')}
                      </p>
                    </div>
                  )}
                </div>
              )}

              <div className="space-y-2">
                {detail.jobs.map((job) => {
                  const log = detail.logs?.find((l) => l.jobId === job.id);
                  const aiLines = log ? summarizeLog(log.text) : [];
                  return (
                    <div key={job.id} className="rounded-lg border">
                      <div className="flex items-center gap-2 px-3 py-2">
                        <span className={`font-mono ${conclusionTone(job.conclusion, job.status)}`}>
                          {conclusionIcon(job.conclusion, job.status)}
                        </span>
                        <span className="text-xs font-medium">{job.name}</span>
                        <div className="ml-auto flex items-center gap-2">
                          {log && (
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 px-2 text-[11px]"
                              onClick={() => setOpenLog(openLog === job.id ? null : job.id)}
                            >
                              {openLog === job.id ? '收起日志' : '查看完整日志'}
                            </Button>
                          )}
                          <a
                            href={`https://github.com/Sam5440/ys_problem_web/actions/runs/${run.id}/job/${job.id}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-[11px] text-primary hover:underline"
                          >
                            GitHub ↗
                          </a>
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 border-t px-3 py-2">
                        {job.steps.map((s) => (
                          <span key={s.number} className="text-[11px] text-muted-foreground">
                            <span className={conclusionTone(s.conclusion, s.status)}>{conclusionIcon(s.conclusion, s.status)}</span>{' '}
                            {s.name}
                          </span>
                        ))}
                      </div>
                      {aiLines.length > 0 && (
                        <div className="border-t px-3 py-2">
                          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            AI 翻译结果（节选）
                          </p>
                          <ul className="mt-0.5 space-y-0.5">
                            {aiLines.map((l, i) => (
                              <li key={i} className="truncate font-mono text-[11px] text-foreground/80" title={l}>
                                {l}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {openLog === job.id && (
                        <pre className="max-h-[28rem] overflow-auto border-t bg-background p-3 font-mono text-[10px] leading-relaxed text-muted-foreground">
                          {log?.text || '（日志暂不可用）'}
                        </pre>
                      )}
                    </div>
                  );
                })}
              </div>

              {!detail.logsAvailable && (
                <p className="text-[11px] leading-relaxed text-muted-foreground/70">
                  内嵌完整日志需要在服务端配置 GH_TOKEN（GitHub 日志下载接口即使公开仓库也需要认证）；上方 GitHub ↗
                  可在浏览器直接查看本页日志。
                </p>
              )}
              <a href={run.htmlUrl} target="_blank" rel="noreferrer" className="inline-block text-xs text-primary hover:underline">
                在 GitHub 上查看此次运行 ↗
              </a>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function Chip({ tone, children }) {
  const cls =
    tone === 'accent'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
      : 'border-border bg-muted text-muted-foreground';
  return <span className={`rounded border px-1 py-px text-[10px] ${cls}`}>{children}</span>;
}

/* ---------------- page ---------------- */

export default function LogsView() {
  const [runs, setRuns] = useState(null); // null = loading
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [expandedAll, setExpandedAll] = useState(false); // false = trim to DEFAULT_DAYS
  const [exhausted, setExhausted] = useState(false); // no more pages upstream
  const [expandedId, setExpandedId] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [details, setDetails] = useState({}); // runId -> { data } | { error }
  const detailsRef = useRef({}); // source of truth for the hydration workers
  const inFlight = useRef(new Set());

  const load = useCallback(async (p, expand) => {
    setLoadingMore(true);
    try {
      const res = await fetch(`/api/ci/runs?page=${p}`);
      const d = await res.json();
      if (d.error) throw new Error(d.error);
      if (!d.runs?.length) setExhausted(true);
      setRuns((prev) => {
        const merged = [...(prev || []), ...(d.runs || [])];
        return merged.filter((r, i, arr) => arr.findIndex((x) => x.id === r.id) === i);
      });
      setExpandedAll(expand);
      setPage(p);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoadingMore(false);
    }
  }, []);

  const hydrate = useCallback((visible) => {
    const need = visible.filter((r) => !detailsRef.current[r.id] && !inFlight.current.has(r.id));
    if (!need.length) return;
    let i = 0;
    const worker = async () => {
      while (i < need.length) {
        const next = need[i++];
        inFlight.current.add(next.id);
        try {
          const q = new URLSearchParams({
            since: next.runStartedAt || next.createdAt,
            until: next.updatedAt || new Date().toISOString(),
          });
          const res = await fetch(`/api/ci/runs/${next.id}?${q}`);
          const d = await res.json();
          detailsRef.current[next.id] = d.error ? { error: d.error } : { data: d };
        } catch (e) {
          detailsRef.current[next.id] = { error: e.message };
        } finally {
          inFlight.current.delete(next.id);
        }
        setDetails({ ...detailsRef.current });
      }
    };
    Promise.all([worker(), worker(), worker()]);
  }, []);

  useEffect(() => {
    load(1, false);
  }, [load]);

  // background-hydrate each visible run's summary (jobs + commit diff), 3 at a time
  useEffect(() => {
    if (!runs) return;
    const cutoff = Date.now() - DEFAULT_DAYS * DAY;
    hydrate(expandedAll ? runs : runs.filter((r) => Date.parse(r.createdAt) >= cutoff));
  }, [runs, expandedAll, hydrate]);

  if (error && !runs) {
    return <p className="text-sm text-red-400">CI 运行列表加载失败：{error}</p>;
  }
  if (!runs) {
    return <p className="text-sm text-muted-foreground">正在加载 CI 运行记录…</p>;
  }

  const cutoff = Date.now() - DEFAULT_DAYS * DAY;
  const visible = expandedAll ? runs : runs.filter((r) => Date.parse(r.createdAt) >= cutoff);
  const hasMore = !exhausted && (!expandedAll || runs.length >= 50 * page);

  const loadMore = () => {
    // while the 7-day window is on: if we already hold runs older than the
    // window, just reveal them; otherwise (rare) the window exceeds a page —
    // fetch the next page with the window lifted
    if (!expandedAll && runs.some((r) => Date.parse(r.createdAt) < cutoff)) {
      setExpandedAll(true);
      return;
    }
    load(page + 1, true);
  };

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        共 {visible.length} 次运行{!expandedAll && '（默认展示最近 7 天）'} · 数据来自 GitHub Actions，列表缓存约 3 分钟
      </p>
      {visible.map((r) => {
        const d = details[r.id] || {};
        return (
          <RunCard
            key={r.id}
            run={r}
            detail={d.data}
            detailError={d.error}
            expanded={expandedId === r.id}
            onToggle={() => setExpandedId(expandedId === r.id ? null : r.id)}
          />
        );
      })}
      {visible.length === 0 && <p className="text-sm text-muted-foreground">最近 7 天没有运行记录。</p>}
      {hasMore && (
        <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? '加载中…' : '更多（查看更早的运行）'}
        </Button>
      )}
    </div>
  );
}
