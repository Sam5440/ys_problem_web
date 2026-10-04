'use client';

/**
 * CI 日志 dashboard. The server page reads public/ci-logs/*.json (written by
 * the workflow's save step after every run) and passes them in as props — no
 * API at runtime. Expanding a run lazily fetches its static raw log from
 * /ci-logs/<file> (Vercel CDN), parses the `##[group]Run` step markers and
 * their timestamps into a pipeline flow diagram, and keeps the raw text in a
 * terminal panel.
 *
 * All charts are hand-rolled SVG (no chart lib) to match the site's
 * hand-written shadcn components. Time anchor for windows/axes is the newest
 * run (not Date.now()) so SSR and hydration render the same tree.
 */

import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowUpRight,
  Bot,
  Bookmark,
  CheckCircle2,
  ChevronDown,
  CircleCheck,
  Clock,
  Coins,
  Copy,
  Database,
  Download,
  FileText,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  ListChecks,
  Package,
  Radar,
  RefreshCw,
  Repeat,
  ScrollText,
  Terminal,
  Timer,
  Wrench,
  XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import AiTranslateDetail from '@/components/ai-translate-detail';

const DAY = 86_400_000;
const DEFAULT_DAYS = 7;
const RETENTION_DAYS = 60;

/* ---------------------------------- helpers --------------------------------- */

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayLabel = (key) => {
  const [, m, d] = key.split('-');
  return `${Number(m)}/${Number(d)}`;
};

function fmtDur(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 1) return '<1 秒';
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m} 分 ${rs} 秒` : `${m} 分钟`;
  const h = Math.floor(m / 60);
  return `${h} 时 ${m % 60} 分`;
}

/** compact token count: < 1万 keeps separators, ≥ 1万 shows 万 */
const fmtTok = (n) => (n == null ? '—' : n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 1 : 2)}万` : n.toLocaleString('en-US'));
const fmtTokFull = (n) => (n == null ? '—' : n.toLocaleString('en-US'));

/** integer y-axis: 0..n for small values, otherwise a nice round step */
function niceScale(yMax) {
  if (yMax <= 6) return { max: yMax, ticks: Array.from({ length: yMax + 1 }, (_, i) => i) };
  const rawStep = yMax / 3;
  const mag = 10 ** Math.floor(Math.log10(rawStep));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rawStep) || 10 * mag;
  const max = Math.ceil(yMax / step) * step;
  return { max, ticks: Array.from({ length: max / step + 1 }, (_, i) => i * step) };
}

/* tailwind-ish palette for SVG fills/strokes */
const TONE = {
  emerald: { solid: '#10b981', light: '#34d399', text: 'text-emerald-500', soft: 'bg-emerald-500/10', border: 'border-emerald-500/40' },
  sky: { solid: '#0ea5e9', light: '#38bdf8', text: 'text-sky-500', soft: 'bg-sky-500/10', border: 'border-sky-500/40' },
  violet: { solid: '#8b5cf6', light: '#a78bfa', text: 'text-violet-500', soft: 'bg-violet-500/10', border: 'border-violet-500/40' },
  amber: { solid: '#f59e0b', light: '#fbbf24', text: 'text-amber-500', soft: 'bg-amber-500/10', border: 'border-amber-500/40' },
  red: { solid: '#ef4444', light: '#f87171', text: 'text-red-400', soft: 'bg-red-500/10', border: 'border-red-500/40' },
  zinc: { solid: '#71717a', light: '#a1a1aa', text: 'text-zinc-400', soft: 'bg-zinc-500/10', border: 'border-zinc-500/40' },
};

const EVENT_LABEL = { schedule: '定时', workflow_dispatch: '手动', push: '推送' };

/* ------------------------------ log step parser ----------------------------- */

function stepMeta(name, updateCount) {
  if (/^actions\/checkout/.test(name)) return ['Checkout 仓库', GitBranch, 'sky'];
  if (/git ls-remote/.test(name)) return ['检查上游更新', Radar, 'amber'];
  if (/^npm ci/.test(name)) return ['安装依赖', Package, 'sky'];
  if (/playwright install/.test(name)) return ['安装 Playwright Chromium', Globe, 'sky'];
  if (/update-data\.mjs/.test(name)) {
    const labels = ['同步上游数据', '挂载修复后的题面', '挂载进 daily 数据'];
    return [labels[Math.min(updateCount, 2)], Database, 'emerald'];
  }
  if (/fetch-statements/.test(name)) return ['抓取最新题面', Download, 'sky'];
  if (/repair-zsmj/.test(name)) return ['修复 ZSMJ 污染', Wrench, 'amber'];
  if (/translate-ai/.test(name)) return ['AI 翻译回填', Bot, 'violet'];
  if (/^if \[ -n "/.test(name)) return ['记录上游 SHA', Bookmark, 'emerald'];
  if (/git config user\.name/.test(name)) return ['提交并推送数据', GitCommitHorizontal, 'emerald'];
  if (/dispatches/.test(name)) return ['自链下一轮修复', Repeat, 'amber'];
  return [name.replace(/\$\{.*?\}/g, '…').slice(0, 44), Terminal, 'zinc'];
}

/** Parse a GH Actions job log into pipeline steps with per-step durations. */
function parseSteps(logText) {
  const lines = logText.split('\n');
  const steps = [];
  let cur = null;
  let lastTs = null;
  let updateCount = 0;
  const close = (ts) => {
    if (!cur) return;
    steps.push({ ...cur, end: ts, dur: ts && cur.start ? Math.max(0, ts - cur.start) : null });
    cur = null;
  };
  for (const line of lines) {
    const m = line.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\s(.*)$/);
    const ts = m ? Date.parse(m[1]) : null;
    if (ts) lastTs = ts;
    const rest = m ? m[2] : line;
    if (/^##\[group\]Run /.test(rest)) {
      close(ts);
      const raw = rest.replace(/^##\[group\]Run /, '');
      if (/update-data\.mjs/.test(raw)) updateCount++;
      const [label, Icon, tone] = stepMeta(raw, updateCount - 1);
      cur = { raw, label, Icon, tone, start: ts, error: false };
    } else if (cur) {
      if (/^##\[error\]/.test(rest)) cur.error = true;
      if (/^Cleaning up orphan processes/.test(rest)) close(ts);
    }
  }
  close(lastTs);
  const timed = steps.filter((s) => s.start && s.end);
  const total = timed.length ? timed[timed.length - 1].end - timed[0].start : null;
  return {
    steps,
    total,
    truncated: logText.startsWith('（日志过长'),
    skipped: steps.length > 0 && /git ls-remote/.test(steps[steps.length - 1].raw),
    errorCount: steps.filter((s) => s.error).length,
  };
}

/* ------------------------------ tiny svg pieces ------------------------------ */

function Sparkline({ data = [], tone = 'emerald' }) {
  const id = useId();
  const t = TONE[tone];
  const w = 120;
  const h = 32;
  if (!data.length || data.every((v) => v === 0)) {
    return (
      <svg viewBox={`0 0 ${w} ${h}`} className="h-8 w-[120px]" aria-hidden>
        <line x1="0" y1={h - 6} x2={w} y2={h - 6} stroke={t.solid} strokeOpacity="0.25" strokeWidth="2" strokeLinecap="round" strokeDasharray="2 4" />
      </svg>
    );
  }
  const max = Math.max(...data, 1);
  const px = (i) => (data.length === 1 ? w / 2 : (i / (data.length - 1)) * (w - 4) + 2);
  const py = (v) => h - 4 - (v / max) * (h - 10);
  const pts = data.map((v, i) => `${px(i)},${py(v)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-8 w-[120px]" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={t.light} stopOpacity="0.35" />
          <stop offset="100%" stopColor={t.light} stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`2,${h - 2} ${pts} ${w - 2},${h - 2}`} fill={`url(#${id})`} />
      <polyline points={pts} fill="none" stroke={t.solid} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {data.map((v, i) => (
        <circle key={i} cx={px(i)} cy={py(v)} r="2.5" fill={t.solid} />
      ))}
    </svg>
  );
}

function StatCard({ icon: Icon, label, value, sub, tone = 'emerald', spark }) {
  const t = TONE[tone];
  return (
    <Card className="relative overflow-hidden">
      <div className={`pointer-events-none absolute -right-8 -top-10 h-28 w-28 rounded-full ${t.soft} blur-2xl`} />
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <span className={`rounded-lg border p-1.5 ${t.border} ${t.soft}`}>
            <Icon className={`h-3.5 w-3.5 ${t.text}`} />
          </span>
        </div>
        <div className="mt-1 flex items-end justify-between gap-2">
          <div className="min-w-0">
            <p className="text-2xl font-bold tabular-nums tracking-tight">{value}</p>
            {sub && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{sub}</p>}
          </div>
          {spark && <Sparkline data={spark} tone={tone} />}
        </div>
      </CardContent>
    </Card>
  );
}

function Donut({ success, fail }) {
  const id = useId();
  const total = success + fail;
  const pct = total ? Math.round((success / total) * 100) : 100;
  const r = 46;
  const c = 2 * Math.PI * r;
  const failLen = total ? (fail / total) * c : 0;
  return (
    <div className="flex items-center gap-4">
      <svg viewBox="0 0 120 120" className="h-32 w-32 -rotate-90">
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor={TONE.emerald.light} />
            <stop offset="100%" stopColor={TONE.emerald.solid} />
          </linearGradient>
        </defs>
        <circle cx="60" cy="60" r={r} fill="none" stroke="currentColor" className="text-border" strokeWidth="11" />
        {total > 0 && (
          <circle
            cx="60" cy="60" r={r} fill="none" stroke={`url(#${id})`} strokeWidth="11" strokeLinecap="round"
            strokeDasharray={`${c - failLen} ${c}`}
          />
        )}
        {fail > 0 && (
          <circle cx="60" cy="60" r={r} fill="none" stroke={TONE.red.solid} strokeWidth="11" strokeLinecap="round"
            strokeDasharray={`${failLen} ${c}`} strokeDashoffset={-(c - failLen)}
          />
        )}
      </svg>
      <div className="min-w-0 space-y-1.5">
        <p className="text-3xl font-bold tabular-nums leading-none">{pct}<span className="text-base text-muted-foreground">%</span></p>
        <p className="text-[11px] text-muted-foreground">成功率</p>
        <p className="flex items-center gap-1.5 text-[11px]">
          <span className="inline-block h-2 w-2 rounded-full bg-emerald-500" />成功 {success}
        </p>
        <p className="flex items-center gap-1.5 text-[11px]">
          <span className="inline-block h-2 w-2 rounded-full bg-red-500" />失败 {fail}
        </p>
      </div>
    </div>
  );
}

/* tooltip shell shared by charts: absolutely positioned by % of the chart box */
function ChartTip({ tip }) {
  if (!tip) return null;
  return (
    <div
      className="pointer-events-none absolute z-20 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-[11px] shadow-xl"
      style={{ left: tip.left, top: tip.top }}
    >
      {tip.node}
    </div>
  );
}

/* ------------------------------- activity bars ------------------------------- */

function ActivityChart({ runs, anchorMs, onPickDay }) {
  const id = useId();
  const [tip, setTip] = useState(null);
  const days = useMemo(() => {
    const byDay = new Map();
    for (const r of runs) {
      const k = isoDay(Date.parse(r.startedAt));
      const e = byDay.get(k) || { ok: 0, bad: 0 };
      if (r.failure) e.bad++;
      else e.ok++;
      byDay.set(k, e);
    }
    return Array.from({ length: RETENTION_DAYS }, (_, i) => {
      const key = isoDay(anchorMs - (RETENTION_DAYS - 1 - i) * DAY);
      return { key, ...{ ok: 0, bad: 0 }, ...(byDay.get(key) || {}) };
    });
  }, [runs, anchorMs]);

  const W = 860;
  const H = 200;
  const padL = 30;
  const padR = 8;
  const padT = 14;
  const padB = 26;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const slot = iw / days.length;
  const { max: yMax, ticks } = niceScale(Math.max(1, ...days.map((d) => d.ok + d.bad)));
  const y = (v) => padT + ih - (v / yMax) * ih;
  const barW = Math.min(10, slot * 0.62);

  return (
    <div className="relative" onMouseLeave={() => setTip(null)}>
      <ChartTip tip={tip} />
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <defs>
          <linearGradient id={`${id}-ok`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={TONE.emerald.light} />
            <stop offset="100%" stopColor={TONE.emerald.solid} />
          </linearGradient>
          <linearGradient id={`${id}-bad`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={TONE.red.light} />
            <stop offset="100%" stopColor={TONE.red.solid} />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="currentColor" className="text-border" strokeOpacity={t === 0 ? 0.9 : 0.45} strokeDasharray={t === 0 ? '' : '3 4'} />
            <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" className="fill-muted-foreground text-[9px] tabular-nums">{t}</text>
          </g>
        ))}
        {days.map((d, i) => {
          const cx = padL + slot * i + slot / 2;
          const tot = d.ok + d.bad;
          const oy = y(d.ok);
          const by = y(tot);
          return (
            <g key={d.key}>
              {tot > 0 && (
                <>
                  <rect x={cx - barW / 2} y={oy} width={barW} height={Math.max(2, padT + ih - oy)} rx={Math.min(3, barW / 2)} fill={`url(#${id}-ok)`} />
                  {d.bad > 0 && (
                    <rect x={cx - barW / 2} y={by} width={barW} height={Math.max(2, oy - by)} rx={Math.min(3, barW / 2)} fill={`url(#${id}-bad)`} />
                  )}
                </>
              )}
              {i % 10 === 0 && (
                <text x={cx} y={H - 8} textAnchor="middle" className="fill-muted-foreground text-[9px]">{dayLabel(d.key)}</text>
              )}
              {/* full-height hover hit area */}
              <rect
                x={padL + slot * i} y={padT} width={slot} height={ih}
                fill="transparent"
                onMouseEnter={() =>
                  setTip({
                    left: `${((padL + slot * i + slot / 2) / W) * 100}%`,
                    top: `${(Math.min(y(tot), padT + ih / 2) / H) * 100}%`,
                    node: (
                      <>
                        <p className="font-medium">{d.key}</p>
                        <p className="mt-0.5 text-muted-foreground">
                          {tot ? `成功 ${d.ok}${d.bad ? ` · 失败 ${d.bad}` : ''}` : '无运行'}
                          {tot ? ' · 点击定位' : ''}
                        </p>
                      </>
                    ),
                  })
                }
                onClick={() => tot > 0 && onPickDay(d.key)}
                className={tot > 0 ? 'cursor-pointer' : ''}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/* ------------------------------ per-run output ------------------------------- */

function RunOutputChart({ runsChrono, onPickRun }) {
  const id = useId();
  const [tip, setTip] = useState(null);
  const data = useMemo(
    () =>
      runsChrono.slice(-40).map((r) => ({
        runId: r.runId,
        startedAt: r.startedAt,
        failure: r.failure,
        fetched: r.summary?.fetched?.length || 0,
        ai: r.summary?.aiDone || 0,
        tokens: r.summary?.tokenUsage?.totalTokens || 0,
      })),
    [runsChrono],
  );

  const W = 860;
  const H = 210;
  const padL = 30;
  const padR = 8;
  const padT = 14;
  const padB = 34;
  const iw = W - padL - padR;
  const ih = H - padT - padB;
  const slot = iw / Math.max(1, data.length);
  const { max: yMax, ticks } = niceScale(Math.max(1, ...data.map((d) => Math.max(d.fetched, d.ai))));
  const y = (v) => padT + ih - (v / yMax) * ih;
  const barW = Math.min(14, slot * 0.3);
  const labelEvery = Math.max(1, Math.ceil(data.length / 10));

  return (
    <div className="relative" onMouseLeave={() => setTip(null)}>
      <ChartTip tip={tip} />
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        <defs>
          <linearGradient id={`${id}-f`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={TONE.sky.light} />
            <stop offset="100%" stopColor={TONE.sky.solid} />
          </linearGradient>
          <linearGradient id={`${id}-a`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={TONE.violet.light} />
            <stop offset="100%" stopColor={TONE.violet.solid} />
          </linearGradient>
        </defs>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="currentColor" className="text-border" strokeOpacity={t === 0 ? 0.9 : 0.45} strokeDasharray={t === 0 ? '' : '3 4'} />
            <text x={padL - 6} y={y(t) + 3.5} textAnchor="end" className="fill-muted-foreground text-[9px] tabular-nums">{t}</text>
          </g>
        ))}
        {data.map((d, i) => {
          const cx = padL + slot * i + slot / 2;
          const f1 = d.fetched;
          const f2 = d.ai;
          return (
            <g key={d.runId}>
              {f1 > 0 && <rect x={cx - barW - 1} y={y(f1)} width={barW} height={Math.max(2, padT + ih - y(f1))} rx={Math.min(3, barW / 2)} fill={`url(#${id}-f)`} />}
              {f2 > 0 && <rect x={cx + 1} y={y(f2)} width={barW} height={Math.max(2, padT + ih - y(f2))} rx={Math.min(3, barW / 2)} fill={`url(#${id}-a)`} />}
              {f1 === 0 && f2 === 0 && <circle cx={cx} cy={padT + ih - 1} r="2" className="fill-muted-foreground/40" />}
              {i % labelEvery === 0 && (
                <text x={cx} y={H - 16} textAnchor="middle" className="fill-muted-foreground text-[9px]">{dayLabel(isoDay(Date.parse(d.startedAt)))}</text>
              )}
              <rect
                x={padL + slot * i} y={padT} width={slot} height={ih} fill="transparent" className="cursor-pointer"
                onMouseEnter={() =>
                  setTip({
                    left: `${(cx / W) * 100}%`,
                    top: `${(Math.min(y(Math.max(f1, f2)), padT + ih / 2) / H) * 100}%`,
                    node: (
                      <>
                        <p className="font-medium">
                          run {d.runId} · {new Date(d.startedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          {d.failure ? ' · 失败' : ''}
                        </p>
                        <p className="mt-0.5 text-muted-foreground">
                          抓取/修复 {d.fetched} 题 · AI 翻译 {d.ai} 段{d.tokens > 0 ? ` · ${fmtTokFull(d.tokens)} tokens` : ''} · 点击查看
                        </p>
                      </>
                    ),
                  })
                }
                onClick={() => onPickRun(d.runId)}
              />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex items-center gap-4 pl-8 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-sky-500" />抓取 / 修复题面</span>
        <span className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-sm bg-violet-500" />AI 翻译段数</span>
      </div>
    </div>
  );
}

/* ------------------------------- flow diagram -------------------------------- */

function FlowDiagram({ log, logState, run }) {
  const parsed = useMemo(() => (logState === 'ready' ? parseSteps(log) : null), [log, logState]);

  if (logState === 'loading') {
    return (
      <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
        <RefreshCw className="h-3.5 w-3.5 animate-spin" /> 正在加载运行日志，解析流水线…
      </div>
    );
  }
  if (logState === 'error') {
    return (
      <div className="flex flex-wrap items-center gap-2 py-4 text-xs text-amber-500">
        <XCircle className="h-3.5 w-3.5" /> 日志加载失败，无法绘制流水线。
        <a href={run.url} target="_blank" rel="noreferrer" className="text-primary hover:underline">在 GitHub 上查看 ↗</a>
      </div>
    );
  }
  if (!parsed || !parsed.steps.length) return null;

  const { steps, total, truncated, skipped, errorCount } = parsed;
  const maxDur = Math.max(...steps.map((s) => s.dur || 0), 1);

  return (
    <div className="rounded-xl border bg-gradient-to-b from-background to-muted/30 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <ListChecks className="h-3.5 w-3.5 text-primary" /> 流水线时序
        </p>
        {total != null && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Timer className="h-3 w-3" /> 总耗时 {fmtDur(total)}
          </span>
        )}
        <span className="text-[11px] text-muted-foreground">{steps.length} 个步骤</span>
        {errorCount > 0 && <span className="rounded border border-red-500/40 bg-red-500/10 px-1 py-px text-[10px] text-red-400">{errorCount} 步出错</span>}
        {skipped && <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px text-[10px] text-amber-500">上游无更新 · 快速空跑</span>}
        {truncated && <span className="text-[10px] text-amber-500">日志开头超长被截断，最早步骤可能缺失</span>}
      </div>

      <ol className="relative ml-3 space-y-0 border-l border-dashed border-border/70 pl-0">
        {steps.map((s, i) => {
          const t = TONE[s.error ? 'red' : s.tone] || TONE.zinc;
          const Icon = s.error ? XCircle : s.Icon;
          const pct = s.dur ? Math.max(3, (s.dur / maxDur) * 100) : 0;
          return (
            <li key={i} className="relative py-2.5 pl-7 pr-1">
              {/* node on the rail */}
              <span className={`absolute -left-[7px] top-4 flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-background ${s.error ? 'bg-red-500' : 'bg-zinc-500'} ring-2 ${s.error ? 'ring-red-500/30' : 'ring-zinc-500/20'}`}>
                {i === 0 && !s.error && <span className="h-1 w-1 rounded-full bg-white/90" />}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-lg border p-1 ${t.border} ${t.soft}`}>
                  <Icon className={`h-3 w-3 ${t.text}`} />
                </span>
                <span className={`text-xs font-medium ${s.error ? 'text-red-400' : ''}`}>{s.label}</span>
                <span className="rounded border border-border bg-muted/60 px-1 py-px font-mono text-[9px] text-muted-foreground">#{i + 1}</span>
                <span className="ml-auto flex items-center gap-1 font-mono text-[10px] tabular-nums text-muted-foreground">
                  <Clock className="h-2.5 w-2.5" />{fmtDur(s.dur)}
                </span>
              </div>
              <p className="mt-1 truncate pl-0.5 font-mono text-[10px] text-muted-foreground/70" title={s.raw}>{s.raw}</p>
              {s.dur != null && (
                <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted/70">
                  <div
                    className={`h-full rounded-full ${s.error ? 'bg-red-500' : ''}`}
                    style={
                      s.error
                        ? { width: `${pct}%` }
                        : { width: `${pct}%`, background: `linear-gradient(90deg, ${TONE[s.tone]?.light || '#a1a1aa'}, ${TONE[s.tone]?.solid || '#71717a'})` }
                    }
                  />
                </div>
              )}
            </li>
          );
        })}
        {/* terminal node */}
        <li className="relative py-2 pl-7">
          <span className="absolute -left-[7px] top-[13px] flex h-3.5 w-3.5 items-center justify-center rounded-full border-2 border-background bg-emerald-500 ring-2 ring-emerald-500/30" />
          <span className="flex items-center gap-2 text-xs font-medium text-emerald-500">
            <CircleCheck className="h-3.5 w-3.5" />
            运行结束{total != null ? ` · 全程 ${fmtDur(total)}` : ''}
          </span>
        </li>
      </ol>
    </div>
  );
}

/* ------------------------------- log terminal -------------------------------- */

function LogTerminal({ filename, text }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-inner">
      <div className="flex items-center gap-2 border-b border-zinc-800/80 bg-zinc-900/70 px-3 py-2">
        <span className="flex gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-amber-400/80" />
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80" />
        </span>
        <span className="truncate font-mono text-[10px] text-zinc-400">{filename}</span>
        <button
          type="button" onClick={copy}
          className="ml-auto flex items-center gap-1 rounded-md border border-zinc-700 px-1.5 py-0.5 text-[10px] text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-200"
        >
          {copied ? <CheckCircle2 className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
          {copied ? '已复制' : '复制'}
        </button>
      </div>
      <pre className="max-h-[30rem] overflow-auto p-3 font-mono text-[10px] leading-relaxed text-zinc-300">
        {text.split('\n').map((l, i) => {
          let cls = '';
          if (/##\[error\]/.test(l)) cls = 'text-red-400';
          else if (/##\[warning\]|✗/.test(l)) cls = 'text-amber-400';
          else if (/##\[group\]Run |Complete job name/.test(l)) cls = 'text-sky-400 font-medium';
          else if (/✓|Done:|push success|Reapplying/.test(l)) cls = 'text-emerald-400/90';
          return <span key={i} className={`block ${cls}`}>{l || ' '}</span>;
        })}
      </pre>
    </div>
  );
}

/* ---------------------------------- run card --------------------------------- */

function DetailSection({ title, icon: Icon, count, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-xl border bg-muted/20">
      <button
        type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{title}</span>
        {count != null && <span className="rounded-full bg-muted px-1.5 py-px text-[10px] tabular-nums text-muted-foreground">{count}</span>}
        <ChevronDown className={`ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <div className="border-t px-3 py-2.5">{children}</div>}
    </div>
  );
}

function FetchedList({ fetched = [], failed = [] }) {
  const [all, setAll] = useState(false);
  const items = fetched.map((f) => ({
    code: f.code,
    segs: (f.title || '').match(/^(\d+)\s*段/)?.[1] || null,
    title: f.title || '',
  }));
  const shown = all ? items : items.slice(0, 24);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5">
        {shown.map((it) => (
          <span
            key={it.code} title={it.title}
            className="inline-flex items-center gap-1 rounded-md border border-sky-500/30 bg-sky-500/10 px-1.5 py-0.5 text-[10px]"
          >
            <span className="font-mono font-medium text-sky-500">{it.code}</span>
            {it.segs && <span className="text-muted-foreground">{it.segs} 段</span>}
          </span>
        ))}
        {failed.map((c) => (
          <span key={c} className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-500">
            <span className="font-mono">{c}</span>未抓到
          </span>
        ))}
        {!items.length && !failed.length && <p className="text-[11px] text-muted-foreground">本次没有抓取任务。</p>}
      </div>
      {items.length > 24 && (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-muted-foreground" onClick={() => setAll(!all)}>
          {all ? '收起' : `展开全部 ${items.length} 项`}
        </Button>
      )}
    </div>
  );
}

function AiLines({ lines = [] }) {
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, 6);
  return (
    <div className="space-y-1">
      <ul className="space-y-0.5">
        {shown.map((l, i) => (
          <li key={i} className="truncate font-mono text-[10px] text-muted-foreground" title={l}>{l}</li>
        ))}
      </ul>
      {lines.length > 6 && (
        <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] text-muted-foreground" onClick={() => setAll(!all)}>
          {all ? '收起' : `展开全部 ${lines.length} 行`}
        </Button>
      )}
    </div>
  );
}

/** per-segment token usage: one row per AI translation call in this run */
function TokenSegmentTable({ segments = [] }) {
  const [all, setAll] = useState(false);
  const shown = all ? segments : segments.slice(0, 12);
  return (
    <div className="mb-3 overflow-hidden rounded-lg border">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="bg-muted/50 text-left text-[10px] text-muted-foreground">
            <th className="px-2 py-1 font-medium">题目</th>
            <th className="px-2 py-1 font-medium">段落</th>
            <th className="px-2 py-1 text-right font-medium">输入</th>
            <th className="px-2 py-1 text-right font-medium">输出</th>
            <th className="px-2 py-1 text-right font-medium">合计</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((t, i) => (
            <tr key={`${t.code}-${t.seg}-${i}`} className="border-t border-border/40">
              <td className="px-2 py-1 font-mono text-violet-500">{t.code}</td>
              <td className="px-2 py-1 font-mono text-muted-foreground">{t.seg}</td>
              <td className="px-2 py-1 text-right tabular-nums">{fmtTokFull(t.in)}</td>
              <td className="px-2 py-1 text-right tabular-nums">{fmtTokFull(t.out)}</td>
              <td className="px-2 py-1 text-right font-medium tabular-nums">{fmtTokFull(t.in + t.out)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {segments.length > 12 && (
        <Button variant="ghost" size="sm" className="h-6 w-full px-2 text-[11px] text-muted-foreground" onClick={() => setAll(!all)}>
          {all ? '收起' : `展开全部 ${segments.length} 条翻译记录`}
        </Button>
      )}
    </div>
  );
}

function RunCard({ run, expanded, onToggle, now }) {
  const [log, setLog] = useState(null);
  const [logState, setLogState] = useState('idle');
  const [showRaw, setShowRaw] = useState(false);
  const startedRef = useRef(false); // guard: don't re-fetch on logState transitions
  // per-run translation record (<runId>.ai.json), fetched lazily on expand
  const [aiData, setAiData] = useState(null);
  const [aiState, setAiState] = useState('idle'); // idle: no record file | loading | ready | missing
  const aiStartedRef = useRef(false);
  const s = run.summary || {};
  const filename = (run.logFile || '').split('/').pop();

  useEffect(() => {
    // deps intentionally exclude logState — a transition to 'loading' must not
    // re-run this effect (its cleanup would strand the in-flight fetch)
    if (!expanded || startedRef.current) return;
    startedRef.current = true;
    setLogState('loading');
    fetch(run.logFile)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((text) => {
        setLog(text);
        setLogState('ready');
      })
      .catch((e) => {
        setLog(String(e));
        setLogState('error');
      });
  }, [expanded, run.logFile]);

  useEffect(() => {
    if (!expanded || !run.aiFile || aiStartedRef.current) return;
    aiStartedRef.current = true;
    setAiState('loading');
    fetch(run.aiFile)
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((data) => {
        setAiData(data);
        setAiState('ready');
      })
      .catch(() => setAiState('missing'));
  }, [expanded, run.aiFile]);

  const fetchedN = s.fetched?.length || 0;
  const failedN = s.fetchFailed?.length || 0;
  const aiN = s.aiDone || s.aiByProblem?.length || 0;
  const durMs = run.savedAt && run.startedAt ? Date.parse(run.savedAt) - Date.parse(run.startedAt) : null;

  return (
    <Card className="scroll-mt-24 overflow-hidden" id={`run-${run.runId}`}>
      <button type="button" onClick={onToggle} aria-expanded={expanded} className="flex w-full items-start gap-3 p-4 text-left">
        <span className={`mt-0.5 rounded-lg border p-1.5 ${run.failure ? 'border-red-500/40 bg-red-500/10' : 'border-emerald-500/40 bg-emerald-500/10'}`}>
          {run.failure ? <XCircle className="h-4 w-4 text-red-400" /> : <CheckCircle2 className="h-4 w-4 text-emerald-500" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-sm font-semibold">{EVENT_LABEL[run.event] || run.event}运行</span>
            <span className="rounded border border-border bg-muted px-1 py-px font-mono text-[10px] text-muted-foreground">run {run.runId}</span>
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] text-muted-foreground">
            <span>{new Date(run.startedAt).toLocaleString('zh-CN')}</span>
            {now && <span>· {fmtDur(Math.max(0, now - Date.parse(run.startedAt)))}前</span>}
            {durMs != null && <span className="flex items-center gap-1"><Timer className="h-3 w-3" />全程 {fmtDur(durMs)}</span>}
          </span>
          <span className="mt-2 flex flex-wrap gap-1.5">
            {run.failure && <span className="rounded-md border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] text-red-400">运行失败</span>}
            {fetchedN > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-500">
                <Download className="h-3 w-3" />抓取/修复 {fetchedN} 题
              </span>
            )}
            {aiN > 0 && (
              <span className="inline-flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[10px] text-violet-500">
                <Bot className="h-3 w-3" />AI 翻译 {s.aiDone || 0} 段
                {s.tokenUsage?.totalTokens > 0 && <span className="tabular-nums">· {fmtTok(s.tokenUsage.totalTokens)} tokens</span>}
              </span>
            )}
            {failedN > 0 && <span className="rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-500">{failedN} 题未抓到</span>}
            {s.addedFiles?.length > 0 && <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">入库 {s.addedFiles.length} 文件</span>}
            {!run.failure && !fetchedN && !aiN && <span className="rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">无数据变更</span>}
          </span>
        </span>
        <ChevronDown className={`mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${expanded ? 'rotate-180' : ''}`} />
      </button>

      {expanded && (
        <CardContent className="space-y-3 border-t pt-4">
          <FlowDiagram log={log} logState={logState} run={run} />

          {(fetchedN > 0 || failedN > 0) && (
            <DetailSection title="抓取 / 修复题面" icon={Download} count={fetchedN + failedN}>
              <FetchedList fetched={s.fetched} failed={s.fetchFailed} />
            </DetailSection>
          )}

          {aiN > 0 && (
            <DetailSection title="AI 翻译明细" icon={Bot} count={s.aiDone || null} defaultOpen={false}>
              {aiState === 'loading' && (
                <div className="flex items-center gap-2 py-6 text-xs text-muted-foreground">
                  <RefreshCw className="h-3.5 w-3.5 animate-spin" /> 正在加载本次运行的翻译记录…
                </div>
              )}
              {aiState === 'ready' && aiData && (
                <AiTranslateDetail
                  embedded
                  runs={[
                    {
                      runId: run.runId,
                      event: run.event,
                      startedAt: run.startedAt,
                      url: run.url,
                      aiDone: s.aiDone || 0,
                      failures: s.aiLines?.filter((l) => l.startsWith('✗')).length || 0,
                      tokenUsage: aiData.tokenUsage,
                      tokensBySeg: aiData.tokensBySeg,
                      problems: aiData.problems,
                    },
                  ]}
                />
              )}
              {(aiState === 'idle' || aiState === 'missing') && (
                <>
                  <p className="mb-3 text-[11px] text-muted-foreground">
                    {run.aiFile ? '翻译记录加载失败，显示日志摘要。' : '该运行早于逐段翻译记录（.ai.json），仅显示日志摘要。'}
                  </p>
                  {s.tokenUsage && (
                    <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-2 text-[11px]">
                      <span className="flex items-center gap-1 font-medium text-amber-500"><Coins className="h-3 w-3" />Token 用量</span>
                      {s.tokenUsage.model && <span className="font-mono text-muted-foreground">{s.tokenUsage.model}</span>}
                      <span className="text-muted-foreground">请求成功 {s.tokenUsage.ok ?? 0} / 失败 {s.tokenUsage.fail ?? 0}</span>
                      <span className="tabular-nums">输入 <b className="font-semibold">{fmtTokFull(s.tokenUsage.in)}</b></span>
                      <span className="tabular-nums">输出 <b className="font-semibold">{fmtTokFull(s.tokenUsage.out)}</b></span>
                      <span className="tabular-nums">合计 <b className="font-semibold text-amber-500">{fmtTokFull(s.tokenUsage.totalTokens)}</b></span>
                    </div>
                  )}
                  {s.aiByProblem?.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-1.5">
                      {s.aiByProblem.map((c) => (
                        <span key={c} className="rounded-md border border-violet-500/30 bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] text-violet-500">{c}</span>
                      ))}
                    </div>
                  )}
                  {s.tokenSegments?.length > 0 && <TokenSegmentTable segments={s.tokenSegments} />}
                  {s.aiLines?.length > 0 && <AiLines lines={s.aiLines} />}
                </>
              )}
            </DetailSection>
          )}

          {s.addedFiles?.length > 0 && (
            <DetailSection title="本次入库文件" icon={FileText} count={s.addedFiles.length} defaultOpen={false}>
              <p className="break-all font-mono text-[11px] leading-relaxed text-foreground/80">{s.addedFiles.join('、 ')}</p>
            </DetailSection>
          )}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {logState === 'ready' && (
              <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs" onClick={() => setShowRaw(!showRaw)}>
                <ScrollText className="h-3.5 w-3.5" />{showRaw ? '隐藏原始日志' : '查看原始日志'}
              </Button>
            )}
            <a
              href={run.url} target="_blank" rel="noreferrer"
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2.5 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
            >
              在 GitHub 上查看 <ArrowUpRight className="h-3 w-3" />
            </a>
          </div>
          {showRaw && logState === 'ready' && <LogTerminal filename={filename} text={log} />}
        </CardContent>
      )}
    </Card>
  );
}

/* ---------------------------------- dashboard -------------------------------- */

export default function LogsView({ runs = [] }) {
  const [window7, setWindow7] = useState(true);
  const [expandedId, setExpandedId] = useState(null);
  const [now, setNow] = useState(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  const anchorMs = useMemo(
    () => (runs.length ? Date.parse(runs[0].startedAt) : Date.parse('2026-01-01T00:00:00Z')),
    [runs],
  );
  const cutoff = anchorMs - (window7 ? DEFAULT_DAYS : RETENTION_DAYS) * DAY;
  const visible = useMemo(() => runs.filter((r) => Date.parse(r.startedAt) >= cutoff), [runs, cutoff]);
  const chrono = useMemo(() => [...visible].reverse(), [visible]);

  const stats = useMemo(() => {
    const fail = visible.filter((r) => r.failure).length;
    const fetched = visible.reduce((a, r) => a + (r.summary?.fetched?.length || 0), 0);
    const ai = visible.reduce((a, r) => a + (r.summary?.aiDone || 0), 0);
    const tokIn = visible.reduce((a, r) => a + (r.summary?.tokenUsage?.in || 0), 0);
    const tokOut = visible.reduce((a, r) => a + (r.summary?.tokenUsage?.out || 0), 0);
    const durs = visible.map((r) => (r.savedAt && r.startedAt ? Date.parse(r.savedAt) - Date.parse(r.startedAt) : null)).filter(Boolean);
    const avgDur = durs.length ? durs.reduce((a, b) => a + b, 0) / durs.length : null;
    const perRunFetched = chrono.map((r) => r.summary?.fetched?.length || 0);
    const perRunAi = chrono.map((r) => r.summary?.aiDone || 0);
    const perRunTokens = chrono.map((r) => r.summary?.tokenUsage?.totalTokens || 0);
    return { fail, ok: visible.length - fail, fetched, ai, tokIn, tokOut, avgDur, perRunFetched, perRunAi, perRunTokens };
  }, [visible, chrono]);

  // 近几日 Token 汇总:按天分组,天内列出每次运行的用量,附每日小计
  const tokenDays = useMemo(() => {
    const byDay = new Map();
    for (const r of visible) {
      const tu = r.summary?.tokenUsage;
      if (!tu) continue;
      const key = isoDay(Date.parse(r.startedAt));
      const e = byDay.get(key) || { runs: [], segs: 0, in: 0, out: 0, total: 0 };
      e.runs.push(r);
      e.segs += r.summary?.aiDone || 0;
      e.in += tu.in || 0;
      e.out += tu.out || 0;
      e.total += tu.totalTokens || 0;
      byDay.set(key, e);
    }
    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([key, e]) => ({ key, ...e, maxRun: Math.max(...e.runs.map((r) => r.summary?.tokenUsage?.totalTokens || 0)) }));
  }, [visible]);

  const pick = (id) => {
    setExpandedId((prev) => (prev === id ? prev : id));
    requestAnimationFrame(() => {
      document.getElementById(`run-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };
  const pickDay = (dayKey) => {
    const r = visible.find((x) => isoDay(Date.parse(x.startedAt)) === dayKey);
    if (r) pick(r.runId);
  };

  return (
    <div className="space-y-6">
      {/* window switch */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          仓库内滚动保留 {RETENTION_DAYS} 天 · 共载入 {runs.length} 次运行记录
        </p>
        <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
          {[
            ['近 7 天', true],
            ['全部记录', false],
          ].map(([label, val]) => (
            <button
              key={label} type="button" onClick={() => setWindow7(val)}
              className={`rounded-md px-2.5 py-1 text-xs transition ${window7 === val ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* stat cards */}
      {visible.length > 0 && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
          <StatCard icon={Activity} label="运行次数" value={visible.length} sub={`成功 ${stats.ok} · 失败 ${stats.fail}`} tone="emerald" />
          <StatCard icon={Download} label="抓取 / 修复题面" value={stats.fetched} sub="近窗口累计" tone="sky" spark={stats.perRunFetched} />
          <StatCard icon={Bot} label="AI 翻译段数" value={stats.ai} sub="近窗口累计" tone="violet" spark={stats.perRunAi} />
          <StatCard
            icon={Coins}
            label="Token 消耗"
            value={fmtTok(stats.tokIn + stats.tokOut)}
            sub={`输入 ${fmtTokFull(stats.tokIn)} · 输出 ${fmtTokFull(stats.tokOut)}`}
            tone="amber"
          />
          <StatCard icon={Timer} label="平均全程耗时" value={stats.avgDur ? fmtDur(stats.avgDur) : '—'} sub="启动 → 日志落盘" tone="emerald" />
        </div>
      )}

      {/* charts */}
      {visible.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-3">
          <Card className="lg:col-span-2">
            <CardContent className="p-4">
              <p className="text-xs font-semibold">运行活动 · 近 {RETENTION_DAYS} 天</p>
              <p className="mb-2 text-[11px] text-muted-foreground">每日运行次数（绿=成功，红=失败），点击柱子可定位到对应运行</p>
              <ActivityChart runs={visible} anchorMs={anchorMs} onPickDay={pickDay} />
            </CardContent>
          </Card>
          <Card>
            <CardContent className="flex h-full flex-col justify-between gap-3 p-4">
              <div>
                <p className="text-xs font-semibold">成功率</p>
                <p className="text-[11px] text-muted-foreground">近窗口内 {visible.length} 次运行</p>
              </div>
              <div className="flex justify-center py-1">
                <Donut success={stats.ok} fail={stats.fail} />
              </div>
              {stats.avgDur != null && (
                <p className="text-center text-[11px] text-muted-foreground">平均全程 {fmtDur(stats.avgDur)}</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {visible.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-semibold">单次运行产出对比</p>
            <p className="mb-2 text-[11px] text-muted-foreground">每次运行的抓取/修复题数与 AI 翻译段数，点击柱子展开对应运行</p>
            <RunOutputChart runsChrono={chrono} onPickRun={pick} />
          </CardContent>
        </Card>
      )}

      {/* token usage: per-day aggregation with per-run breakdown */}
      {tokenDays.length > 0 && (
        <Card>
          <CardContent className="p-4">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <p className="text-xs font-semibold">Token 用量 · 近几日汇总</p>
              <p className="text-[11px] text-muted-foreground">
                按天汇总每次运行的 AI 翻译消耗，窗口内合计 输入 {fmtTokFull(stats.tokIn)} + 输出 {fmtTokFull(stats.tokOut)} = {fmtTokFull(stats.tokIn + stats.tokOut)} tokens
              </p>
            </div>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full min-w-[640px] border-separate border-spacing-0 text-xs">
                <thead>
                  <tr className="text-left text-[11px] text-muted-foreground">
                    <th className="border-b px-2 py-1.5 font-medium">日期</th>
                    <th className="border-b px-2 py-1.5 font-medium">运行</th>
                    <th className="border-b px-2 py-1.5 text-right font-medium">翻译段数</th>
                    <th className="border-b px-2 py-1.5 text-right font-medium">输入 tokens</th>
                    <th className="border-b px-2 py-1.5 text-right font-medium">输出 tokens</th>
                    <th className="w-[30%] border-b px-2 py-1.5 text-right font-medium">合计 tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {tokenDays.map((d) => {
                    const maxDay = Math.max(...tokenDays.map((x) => x.total), 1);
                    return (
                      <Fragment key={d.key}>
                        <tr className="bg-muted/40 font-medium">
                          <td className="border-b border-border/60 px-2 py-1.5 tabular-nums">{dayLabel(d.key)}</td>
                          <td className="border-b border-border/60 px-2 py-1.5 text-muted-foreground">{d.runs.length} 次运行</td>
                          <td className="border-b border-border/60 px-2 py-1.5 text-right tabular-nums">{d.segs}</td>
                          <td className="border-b border-border/60 px-2 py-1.5 text-right tabular-nums">{fmtTokFull(d.in)}</td>
                          <td className="border-b border-border/60 px-2 py-1.5 text-right tabular-nums">{fmtTokFull(d.out)}</td>
                          <td className="border-b border-border/60 px-2 py-1.5 text-right">
                            <span className="inline-flex items-center justify-end gap-2">
                              <span className="hidden h-1.5 w-24 overflow-hidden rounded-full bg-border/60 sm:block">
                                <span className="block h-full rounded-full bg-amber-500/80" style={{ width: `${Math.max(4, (d.total / maxDay) * 100)}%` }} />
                              </span>
                              <span className="tabular-nums font-semibold">{fmtTokFull(d.total)}</span>
                            </span>
                          </td>
                        </tr>
                        {d.runs.map((r) => {
                          const tu = r.summary?.tokenUsage;
                          return (
                            <tr key={r.runId} className="cursor-pointer text-muted-foreground transition hover:text-foreground" onClick={() => pick(r.runId)}>
                              <td className="border-b border-border/30 px-2 py-1" />
                              <td className="border-b border-border/30 px-2 py-1">
                                <span className="font-mono text-[10px]">run {r.runId}</span>
                                <span className="ml-1.5 text-[10px]">{EVENT_LABEL[r.event] || r.event}{r.failure ? ' · 失败' : ''}{tu.model ? ` · ${tu.model}` : ''}</span>
                              </td>
                              <td className="border-b border-border/30 px-2 py-1 text-right tabular-nums">{r.summary?.aiDone || 0}</td>
                              <td className="border-b border-border/30 px-2 py-1 text-right tabular-nums">{fmtTokFull(tu.in)}</td>
                              <td className="border-b border-border/30 px-2 py-1 text-right tabular-nums">{fmtTokFull(tu.out)}</td>
                              <td className="border-b border-border/30 px-2 py-1 text-right tabular-nums">{fmtTokFull(tu.totalTokens)}</td>
                            </tr>
                          );
                        })}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-[10px] text-muted-foreground">点击任一运行行可跳转到对应的运行卡片。仅统计已记录 Token 的运行（旧日志无此数据）。</p>
          </CardContent>
        </Card>
      )}

      {/* timeline list */}
      <div>
        <div className="mb-3 flex items-center gap-2">
          <h2 className="text-sm font-semibold">运行历史</h2>
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] tabular-nums text-muted-foreground">{visible.length}</span>
        </div>
        {visible.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
              <span className="rounded-full border border-border bg-muted p-3">
                <ScrollText className="h-5 w-5 text-muted-foreground" />
              </span>
              <p className="text-sm font-medium">暂无日志</p>
              <p className="max-w-sm text-xs text-muted-foreground">
                每次完整运行（上游有更新或手动触发）结束后会自动把完整日志提交到仓库并显示在这里。
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="relative space-y-4 pl-7">
            <span className="pointer-events-none absolute bottom-4 left-[9px] top-4 w-px bg-gradient-to-b from-emerald-500/50 via-border to-transparent" />
            {visible.map((r) => (
              <div key={r.runId} className="relative">
                <span
                  className={`absolute -left-7 top-5 h-[19px] w-[19px] rounded-full border-[5px] border-background ${r.failure ? 'bg-red-500 shadow-[0_0_0_3px_rgba(239,68,68,0.2)]' : 'bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.2)]'}`}
                />
                <RunCard run={r} expanded={expandedId === r.runId} onToggle={() => setExpandedId(expandedId === r.runId ? null : r.runId)} now={now} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
