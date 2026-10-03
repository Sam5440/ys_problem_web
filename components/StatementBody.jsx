'use client';

import { useEffect, useRef, useState } from 'react';
import CopyBox from './CopyBox';
import { useAiSegment } from './ai-translate';
import { useSettings, channelLabel, DEFAULT_PRIORITY } from './settings';
import { hydrateStatement, useZhSegment } from '@/lib/zh-store';
import { renderRich } from '@/lib/render';

function SectionHeading({ children }) {
  return (
    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{children}</h3>
  );
}

function UntranslatedMark({ note }) {
  return (
    <span className="mt-1 inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-500">
      <span aria-hidden>⚠</span> {note || '本段暂无翻译'}
    </span>
  );
}

/** Provenance tag for segments that resolved below top priority. */
const badgeHtml = (label) =>
  `<span class="mr-1.5 inline-block rounded border border-border bg-muted px-1 py-px align-middle text-[10px] leading-4 text-muted-foreground">${label}</span>`;

function ZhWithBadge({ html, badge, className }) {
  // marked wraps plain paragraphs in <p>…</p>; inject the badge inside that
  // first <p> so it stays inline — wrapping in our own <p> would nest
  // invalidly and the HTML parser would silently drop the badge.
  const bh = badge ? badgeHtml(badge) : '';
  const withBadge = bh
    ? html.startsWith('<p>')
      ? html.replace('<p>', `<p>${bh}`)
      : bh + html
    : html;
  return <div className={className} dangerouslySetInnerHTML={{ __html: withBadge }} />;
}

function SpinnerNote({ children }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground/70">
      <span className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
      {children}
    </span>
  );
}

/** Fires once the wrapped element scrolls near the viewport. */
function useNearViewport() {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          io.disconnect();
        }
      },
      { rootMargin: '300px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, visible];
}

function AiZhLine({ en, ai, note }) {
  const [ref, visible] = useNearViewport();
  const state = useAiSegment(en, ai, visible && !!(ai?.baseUrl && ai?.apiKey));
  return (
    <div ref={ref}>
      {state.status === 'loading' && <SpinnerNote>AI 翻译中…</SpinnerNote>}
      {state.status === 'error' && <UntranslatedMark note={`AI 翻译失败（${state.error}）`} />}
      {state.status === 'done' && <p dangerouslySetInnerHTML={{ __html: renderRich(state.text) }} />}
      {state.status === 'idle' && <UntranslatedMark note={note ? `${note}（AI）` : '请在设置中配置 AI 接口'} />}
    </div>
  );
}

/** Repo archive + this machine's fetched results; the archive wins ties
    (it went through the image-loss post-processing when it was built). */
function mergedChannels(seg, rec) {
  const merged = {};
  if (rec) {
    for (const [ch, t] of Object.entries(rec.zh)) {
      if (typeof t === 'string' && t.trim()) merged[ch] = t;
    }
  }
  if (seg && typeof seg === 'object') {
    for (const [ch, t] of Object.entries(seg)) {
      if (typeof t === 'string' && t.trim()) merged[ch] = t;
    }
  }
  return merged;
}

/**
 * 对照 mode's Chinese line: walk the user's priority list for the first
 * channel with a translation — the repo archive or one this browser fetched.
 * While the client pipeline (lib/zh-store.js) is still filling the gaps a
 * spinner shows; only when every channel failed does the mark appear. The
 * line upgrades live when a higher-priority channel lands.
 */
function ChainZhLine({ segKey, seg, priority, note }) {
  const rec = useZhSegment(segKey);
  // legacy v1 string: the statement's only translation
  if (typeof seg === 'string') {
    return <p dangerouslySetInnerHTML={{ __html: renderRich(seg) }} />;
  }
  const prio = priority?.length ? priority : DEFAULT_PRIORITY;
  // archived AI translations (CI backfill) sit below every MT channel
  const full = [...prio, 'ai'];
  const merged = mergedChannels(seg, rec);
  const hitIdx = full.findIndex((ch) => typeof merged[ch] === 'string' && merged[ch].trim());
  if (hitIdx >= 0) {
    return (
      <ZhWithBadge html={renderRich(merged[full[hitIdx]])} badge={hitIdx > 0 ? channelLabel(full[hitIdx]) : undefined} />
    );
  }
  // spinner logic only watches the client pipeline's channels — `ai` here is
  // archive-only and has no client task to wait for
  const waiting = prio.some((ch) => rec.status[ch] !== 'failed');
  return (
    <div>
      {waiting ? (
        <SpinnerNote>翻译中…</SpinnerNote>
      ) : (
        <UntranslatedMark note={note ? `${note}（暂无译文）` : undefined} />
      )}
    </div>
  );
}

/** One paragraph's Chinese line for an explicitly picked channel. */
function ZhLine({ segKey, seg, channel, note }) {
  const rec = useZhSegment(segKey);
  // legacy v1 string: the statement's only translation — show it for any channel
  if (typeof seg === 'string') {
    return <p dangerouslySetInnerHTML={{ __html: renderRich(seg) }} />;
  }
  const archived =
    typeof seg?.[channel] === 'string' && seg[channel].trim() ? seg[channel] : null;
  const local = typeof rec.zh[channel] === 'string' && rec.zh[channel].trim() ? rec.zh[channel] : null;
  const zh = archived || local;
  if (zh) {
    return <p dangerouslySetInnerHTML={{ __html: renderRich(zh) }} />;
  }
  if (rec.status[channel] === 'failed') {
    return <UntranslatedMark note={note ? `${note}（${channelLabel(channel)}）` : undefined} />;
  }
  return <SpinnerNote>翻译中…</SpinnerNote>;
}

function Paragraphs({ list, zhList, mode, channel, ai, chain, segPrefix }) {
  const items = list.map((p, i) => {
    if (typeof p !== 'string') {
      return <pre key={i} className="code-block" dangerouslySetInnerHTML={{ __html: renderRich(p.pre) }} />;
    }
    if (mode === 'en') {
      return <p key={i} dangerouslySetInnerHTML={{ __html: renderRich(p) }} />;
    }
    const segKey = `${segPrefix}|${i}`;
    const zh = zhList?.[i];
    const zhLine = chain ? (
      <ChainZhLine segKey={segKey} seg={zh} priority={chain.priority} />
    ) : channel === 'ai' ? (
      <AiZhLine en={p} ai={ai} />
    ) : (
      <ZhLine segKey={segKey} seg={zh} channel={channel} />
    );
    if (mode === 'both') {
      return (
        <div key={i}>
          <p dangerouslySetInnerHTML={{ __html: renderRich(p) }} />
          <div className="stmt-zh mt-1 border-l-2 border-primary/40 pl-3 text-[13px] text-muted-foreground">
            {zhLine}
          </div>
        </div>
      );
    }
    return <div key={i}>{zhLine}</div>;
  });
  return <div className="stmt-body">{items}</div>;
}

function Section({ label, list, zhList, mode, channel, ai, chain, segPrefix }) {
  if (!list?.length) return null;
  return (
    <div>
      <SectionHeading>{label}</SectionHeading>
      <Paragraphs list={list} zhList={zhList} mode={mode} channel={channel} ai={ai} chain={chain} segPrefix={segPrefix} />
    </div>
  );
}

/**
 * Full statement body (sections + examples), language-aware.
 *
 * `statement.sectionsZh[key][i]` is the repo-side archive: a per-channel map
 * ({ deepl: …, youdao: … }) or a legacy plain string. Anything the archive
 * does not cover is translated on this machine by lib/zh-store.js — all four
 * channels, every paragraph, round-robin dispatched, 3s-paced per channel,
 * results persisted in IndexedDB — and the lines below upgrade live as
 * results land. The "ai" channel stays on-demand via the user's own
 * OpenAI-compatible endpoint.
 */
export default function StatementBody({ statement, code }) {
  const { lang, settings } = useSettings();
  const s = statement;
  const mode = lang.mode;
  const channel = lang.channel;
  const ai = channel === 'ai' ? settings.ai : null;
  const chain = mode === 'both' ? { priority: settings.zhPriority } : null;

  // Kick off (or resume) the client-side fill for every paragraph/channel
  // pair this statement needs — archived pairs are skipped inside.
  useEffect(() => {
    if (mode !== 'en') hydrateStatement(code, s);
  }, [code, s, mode]);

  const segKeyOf = (secKey, i = 0) => `${code}|${secKey}|${i}`;

  let titleLine = null;
  if (mode !== 'en') {
    titleLine = channel === 'ai' ? (
      <AiZhLine en={s.title} ai={ai} note="标题" />
    ) : chain ? (
      <ChainZhLine segKey={segKeyOf('title')} seg={s.titleZh || null} priority={chain.priority} note="标题" />
    ) : (
      <ZhLine segKey={segKeyOf('title')} seg={s.titleZh || null} channel={channel} note="标题" />
    );
  }

  return (
    <>
      {titleLine && <div className="text-base font-medium tracking-tight text-foreground/90">{titleLine}</div>}
      <Section label="题目描述" list={s.sections.legend} zhList={s.sectionsZh?.legend} mode={mode} channel={channel} ai={ai} chain={chain} segPrefix={`${code}|legend`} />
      {(s.sections.input?.length > 0 || s.sections.output?.length > 0) && (
        <div className="grid gap-6 md:grid-cols-2">
          <Section label="输入格式" list={s.sections.input} zhList={s.sectionsZh?.input} mode={mode} channel={channel} ai={ai} chain={chain} segPrefix={`${code}|input`} />
          <Section label="输出格式" list={s.sections.output} zhList={s.sectionsZh?.output} mode={mode} channel={channel} ai={ai} chain={chain} segPrefix={`${code}|output`} />
        </div>
      )}
      <Section label="备注" list={s.sections.note} zhList={s.sectionsZh?.note} mode={mode} channel={channel} ai={ai} chain={chain} segPrefix={`${code}|note`} />
      {s.examples?.length > 0 && (
        <div>
          <SectionHeading>样例</SectionHeading>
          <div className="space-y-4">
            {s.examples.map((ex, i) => (
              <div key={i}>
                <p className="mb-1.5 text-xs text-muted-foreground">样例 {i + 1}</p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <CopyBox label="Input" text={ex.input} />
                  <CopyBox label="Output" text={ex.output} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
