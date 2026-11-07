'use client';

/**
 * 「AI 翻译明细」segment-pair view (demo → to be embedded in the /logs
 * expanded run card after approval). For every statement segment: numbered
 * header, English source and translation side by side with a flow arrow,
 * channel switcher (ai first), per-call token usage when the run's CI log
 * summary provides it (summary.tokenSegments from save-ci-log), and copy
 * buttons. Data is built server-side from data/statements/*.json.
 */

import { useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  CheckCircle2,
  Coins,
  Copy,
  Hourglass,
  Languages,
  Timer,
} from 'lucide-react';
import { renderRich } from '@/lib/render';
import { aiModelOf } from '@/lib/ai-model';

const CH_ORDER = ['ai', 'deepl', 'caiyun', 'iflyrec', 'youdao', 'legacy'];
const CH_META = {
  ai: { label: 'AI (CI翻译)', text: 'text-violet-500', chip: 'border-violet-500/40 bg-violet-500/10 text-violet-500', dot: 'bg-violet-500' },
  deepl: { label: 'DeepL', text: 'text-sky-500', chip: 'border-sky-500/40 bg-sky-500/10 text-sky-500', dot: 'bg-sky-500' },
  caiyun: { label: '彩云', text: 'text-teal-500', chip: 'border-teal-500/40 bg-teal-500/10 text-teal-500', dot: 'bg-teal-500' },
  iflyrec: { label: '讯飞', text: 'text-amber-500', chip: 'border-amber-500/40 bg-amber-500/10 text-amber-500', dot: 'bg-amber-500' },
  youdao: { label: '有道', text: 'text-rose-500', chip: 'border-rose-500/40 bg-rose-500/10 text-rose-500', dot: 'bg-rose-500' },
  legacy: { label: '旧版整译', text: 'text-zinc-400', chip: 'border-zinc-500/40 bg-zinc-500/10 text-zinc-400', dot: 'bg-zinc-500' },
};
const KEY_LABEL = {
  title: '标题',
  legend: '题目描述',
  input: '输入格式',
  output: '输出格式',
  note: '说明',
  interaction: '交互',
  scoring: '计分',
  hint: '提示',
};
const EVENT_LABEL = { schedule: '定时', workflow_dispatch: '手动', push: '推送', demo: '演示' };

const bestChannel = (zh) => CH_ORDER.find((ch) => typeof zh?.[ch] === 'string' && zh[ch].trim()) || null;
const segId = (p, i) => `${p}:${i}`;
const segTokenKey = (code, seg) => `${(code || '').toLowerCase()}:${seg.key}[${seg.i}]`;
const fmtInt = (n) => Number(n || 0).toLocaleString('en-US');

function CopyBtn({ text, title = '复制' }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch { /* clipboard unavailable */ }
      }}
      className="rounded-md border border-border/70 bg-background/60 p-1 text-muted-foreground/60 transition hover:bg-muted hover:text-foreground"
    >
      {done ? <Check className="h-3 w-3 text-emerald-500" /> : <Copy className="h-3 w-3" />}
    </button>
  );
}

function TokenChip({ tokens }) {
  const cached = tokens.cached || 0;
  return (
    <span
      title={`本次调用消耗：输入 ${fmtInt(tokens.in)}${cached > 0 ? `（缓存命中 ${fmtInt(cached)}）` : ''} + 输出 ${fmtInt(tokens.out)} tokens`}
      className="inline-flex items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-1.5 py-px font-mono text-[10px] tabular-nums text-amber-500"
    >
      <Coins className="h-2.5 w-2.5" />
      {fmtInt(tokens.in)}+{fmtInt(tokens.out)}={fmtInt((tokens.in || 0) + (tokens.out || 0))} tok
      {cached > 0 && <span className="text-emerald-500/90">·缓存 {fmtInt(cached)}</span>}
    </span>
  );
}

function CoverBar({ covered, total }) {
  const pct = total ? Math.round((covered / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-gradient-to-r from-violet-400 to-violet-600 transition-all" style={{ width: `${Math.max(4, pct)}%` }} />
      </div>
      <span className="text-[10px] tabular-nums text-muted-foreground">{pct}%</span>
    </div>
  );
}

function SegmentCard({ seg, idx, code, channel, onChannel, showEn, tokens }) {
  const zhKey = typeof seg.zh[channel] === 'string' && seg.zh[channel].trim() ? channel : null;
  const active = zhKey ? CH_META[zhKey] : null;
  const meta = KEY_LABEL[seg.key] || seg.key;

  return (
    <li className="group overflow-hidden rounded-xl border bg-background transition-colors hover:border-violet-500/30">
      {/* numbered header */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 px-3 py-1.5">
        <span className="flex h-4.5 w-4.5 min-w-[18px] items-center justify-center rounded bg-violet-500/15 px-1 font-mono text-[9px] font-bold leading-none text-violet-400">
          {idx + 1}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{seg.key}[{seg.i}]</span>
        <span className="text-[11px] font-medium text-foreground/80">{meta}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {tokens && <TokenChip tokens={tokens} />}
          <CopyBtn text={zhKey ? seg.zh[zhKey] : seg.en} title={zhKey ? '复制译文' : '复制原文'} />
        </span>
      </div>

      {/* source → translation pair */}
      <div className={`grid gap-px bg-border/40 ${showEn ? 'md:grid-cols-[1fr_auto_1fr]' : ''}`}>
        {showEn && (
          <div className="bg-muted/10 p-3">
            <p className="mb-1.5 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/60">
              <Languages className="h-3 w-3" /> 原文 · English
              <span className="ml-auto font-normal normal-case tracking-normal tabular-nums">{seg.en.length} 字符</span>
            </p>
            <div className="stmt-body text-[13px] leading-relaxed text-muted-foreground/90" dangerouslySetInnerHTML={{ __html: renderRich(seg.en) }} />
          </div>
        )}
        {showEn && (
          <>
            {/* desktop arrow between panes */}
            <div className="hidden items-center justify-center bg-muted/10 px-1.5 md:flex">
              <span className="flex h-6 w-6 items-center justify-center rounded-full border border-violet-500/40 bg-background shadow-sm transition group-hover:border-violet-500/70 group-hover:shadow-[0_0_8px_rgba(139,92,246,0.25)]">
                <ArrowRight className="h-3 w-3 text-violet-400" />
              </span>
            </div>
            {/* mobile arrow */}
            <div className="flex items-center justify-center bg-muted/10 py-1 md:hidden">
              <ArrowDown className="h-3.5 w-3.5 text-violet-400" />
            </div>
          </>
        )}
        <div className={`p-3 ${active?.dot === 'bg-violet-500' ? 'bg-violet-500/[0.045]' : 'bg-background'}`}>
          <p className="mb-1.5 flex items-center gap-1.5 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/60">
            {active ? (
              <>
                <CheckCircle2 className={`h-3 w-3 ${active.text}`} />
                <span className={active.text}>
                  译文 · {active.label}
                  {zhKey === 'ai' && `（${aiModelOf(seg.zh.aiModel)}）`}
                </span>
              </>
            ) : (
              <>
                <Hourglass className="h-3 w-3" /> 译文 · 待回补
              </>
            )}
            {zhKey && (
              <span className="ml-auto flex items-center gap-1 font-normal normal-case tracking-normal tabular-nums text-muted-foreground/50">
                {seg.zh[zhKey].length} 字符
              </span>
            )}
          </p>
          {active ? (
            <div className="stmt-body text-[13px] leading-relaxed text-foreground" dangerouslySetInnerHTML={{ __html: renderRich(seg.zh[zhKey]) }} />
          ) : (
            <p className="flex items-center gap-2 rounded-lg border border-dashed border-violet-500/30 bg-violet-500/5 px-2.5 py-2 text-[11px] text-violet-400/80">
              <Hourglass className="h-3 w-3 shrink-0" />
              该段还没有译文，已进入 CI 翻译队列，后续运行自动补齐。
            </p>
          )}
        </div>
      </div>

      {/* channel switcher footer */}
      <div className="flex flex-wrap items-center gap-1.5 border-t bg-muted/10 px-3 py-1.5">
        <span className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground/50">对照渠道</span>
        {CH_ORDER.filter((ch) => seg.zh[ch] != null || ch === 'ai').map((ch) => {
          const has = typeof seg.zh[ch] === 'string' && seg.zh[ch].trim();
          const on = ch === channel;
          const m = CH_META[ch];
          return (
            <button
              key={ch}
              type="button"
              disabled={!has}
              title={has ? `切换为 ${m.label} 译文` : `${m.label} 译文待回补`}
              onClick={() => onChannel(ch)}
              className={`rounded-md border px-1.5 py-px text-[10px] transition ${
                on && has
                  ? `${m.chip} font-medium`
                  : has
                    ? 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                    : 'cursor-not-allowed border-dashed border-border/60 text-muted-foreground/40'
              }`}
            >
              {m.label}
            </button>
          );
        })}
      </div>
    </li>
  );
}

export default function AiTranslateDetail({ runs = [], embedded = false }) {
  const [runIdx, setRunIdx] = useState(0);
  const [problemIdx, setProblemIdx] = useState(0);
  const [filter, setFilter] = useState('all'); // all | ai | todo
  const [segChannel, setSegChannel] = useState({}); // `${problemIdx}:${segIdx}` -> channel
  const [showEn, setShowEn] = useState(true);

  const run = runs[Math.min(runIdx, runs.length - 1)] || { problems: [] };
  const problems = run.problems || [];
  const problem = problems[Math.min(problemIdx, problems.length - 1)] || { segs: [] };

  const segChannelFor = (i, seg) => {
    const k = segId(problemIdx, i);
    if (segChannel[k]) return segChannel[k];
    return bestChannel(seg.zh) || 'ai';
  };
  const setCh = (i, ch) => setSegChannel((m) => ({ ...m, [segId(problemIdx, i)]: ch }));

  const segs = problem.segs || [];
  const filtered = segs
    .map((seg, i) => ({ seg, i }))
    .filter(({ seg }) =>
      filter === 'ai' ? !!seg.zh.ai : filter === 'todo' ? !seg.zh.ai : true,
    );
  const aiCount = segs.filter((s) => s.zh.ai).length;

  return (
    <div className="space-y-4">
      {/* run switcher (standalone mode) + meta */}
      <div className="rounded-xl border bg-muted/20 p-3">
        {!embedded && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center gap-1 text-xs font-semibold">
              <Bot className="h-3.5 w-3.5 text-violet-500" /> 数据来源运行
            </span>
            <div className="flex flex-wrap gap-1.5">
              {runs.map((r, i) => (
                <button
                  key={r.runId || i}
                  type="button"
                  onClick={() => {
                    setRunIdx(i);
                    setProblemIdx(0);
                    setSegChannel({});
                  }}
                  className={`rounded-lg border px-2 py-1 font-mono text-[11px] transition ${
                    i === runIdx
                      ? 'border-violet-500/50 bg-violet-500/10 text-violet-400'
                      : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                  }`}
                >
                  run {r.runId || '—'}
                  <span className="ml-1 rounded bg-muted px-1 text-[9px] text-muted-foreground">{r.aiDone} 段</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <p className={`flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground ${embedded ? '' : 'mt-2'}`}>
          {!embedded && <span>{EVENT_LABEL[run.event] || run.event}</span>}
          {!embedded && run.startedAt && (
            <span className="flex items-center gap-1">
              <Timer className="h-3 w-3" />
              {new Date(run.startedAt).toLocaleString('zh-CN')}
            </span>
          )}
          <span className="rounded border border-violet-500/40 bg-violet-500/10 px-1 py-px text-violet-500">AI 译 {run.aiDone} 段</span>
          {run.tokenUsage?.modelLabel && (
            <span
              className="rounded border border-violet-500/40 bg-violet-500/10 px-1 py-px tabular-nums text-violet-500"
              title="本次运行 AI 翻译使用的模型"
            >
              {run.tokenUsage.modelLabel}
            </span>
          )}
          {run.failures > 0 && (
            <span className="rounded border border-red-500/40 bg-red-500/10 px-1 py-px text-red-400">{run.failures} 段失败</span>
          )}
          {run.tokenUsage && (
            <span
              className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1 py-px tabular-nums text-amber-500"
              title={`输入 ${fmtInt(run.tokenUsage.in)}${run.tokenUsage.cached > 0 ? `（缓存命中 ${fmtInt(run.tokenUsage.cached)}）` : ''} + 输出 ${fmtInt(run.tokenUsage.out)}`}
            >
              <Coins className="h-2.5 w-2.5" />
              Token 合计 {fmtInt(run.tokenUsage.totalTokens)}
              {run.tokenUsage.cached > 0 && <span className="text-emerald-500/90">·缓存 {fmtInt(run.tokenUsage.cached)}</span>}
            </span>
          )}
          {run.url && run.url.startsWith('http') && (
            <a href={run.url} target="_blank" rel="noreferrer" className={`flex items-center gap-0.5 hover:text-foreground ${embedded ? '' : 'ml-auto'}`}>
              GitHub 运行记录 <ArrowUpRight className="h-3 w-3" />
            </a>
          )}
        </p>
      </div>

      {/* problem tabs */}
      {problems.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {problems.map((p, i) => (
            <button
              key={p.code}
              type="button"
              onClick={() => setProblemIdx(i)}
              className={`inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-[11px] transition ${
                i === problemIdx
                  ? 'border-violet-500/50 bg-violet-500/10 text-violet-400'
                  : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              <span className="font-mono font-medium">{p.code}</span>
              <span className="rounded bg-muted px-1 text-[9px] tabular-nums">
                {p.aiCount}/{p.segs.length}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* problem panel */}
      <div className="overflow-hidden rounded-xl border">
        <div className="border-b bg-gradient-to-r from-violet-500/10 via-violet-500/5 to-transparent px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-lg border border-violet-500/40 bg-violet-500/10 px-2 py-0.5 font-mono text-xs font-semibold text-violet-400">
              {problem.code}
            </span>
            {problem.title && <span className="font-mono text-xs text-muted-foreground/80">{problem.title}</span>}
            <span className="ml-auto flex items-center gap-2">
              <span className="text-[10px] text-muted-foreground">AI 覆盖 {aiCount}/{segs.length} 段</span>
              <CoverBar covered={aiCount} total={segs.length} />
            </span>
          </div>
          {/* translated problem title */}
          {(() => {
            const t = segs.find((s) => s.key === 'title');
            const ch = t ? bestChannel(t.zh) : null;
            if (t && ch) {
              return (
                <p className="mt-1.5 flex items-start gap-1.5 text-sm font-medium text-foreground/90">
                  <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-violet-500" />
                  {String(t.zh[ch]).slice(0, 120)}
                </p>
              );
            }
            return null;
          })()}
        </div>

        {/* filter row */}
        <div className="flex flex-wrap items-center gap-2 border-b bg-muted/10 px-4 py-2 text-[11px]">
          <span className="text-muted-foreground">筛选</span>
          {[
            ['all', `全部 ${segs.length}`],
            ['ai', `AI 已译 ${aiCount}`],
            ['todo', `待回补 ${segs.length - aiCount}`],
          ].map(([k, label]) => (
            <button
              key={k}
              type="button"
              onClick={() => setFilter(k)}
              className={`rounded-full border px-2 py-0.5 transition ${
                filter === k
                  ? 'border-violet-500/50 bg-violet-500/10 text-violet-400'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
              }`}
            >
              {label}
            </button>
          ))}
          <button
            type="button"
            onClick={() => setShowEn(!showEn)}
            className={`ml-auto rounded-full border px-2 py-0.5 transition ${
              showEn ? 'border-border text-muted-foreground hover:bg-muted' : 'border-violet-500/50 bg-violet-500/10 text-violet-400'
            }`}
          >
            {showEn ? '隐藏原文' : '显示原文'}
          </button>
        </div>

        {/* segments */}
        <ul className="space-y-2.5 bg-muted/10 p-3">
          {filtered.map(({ seg, i }) => (
            <SegmentCard
              key={`${seg.key}-${seg.i}`}
              seg={seg}
              idx={i}
              code={problem.code}
              showEn={showEn}
              tokens={run.tokensBySeg?.[segTokenKey(problem.code, seg)]}
              channel={segChannelFor(i, seg)}
              onChannel={(ch) => setCh(i, ch)}
            />
          ))}
          {filtered.length === 0 && (
            <li className="py-10 text-center text-xs text-muted-foreground">此筛选下没有段落。</li>
          )}
        </ul>
      </div>
    </div>
  );
}
