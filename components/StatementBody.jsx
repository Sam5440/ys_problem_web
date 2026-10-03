'use client';

import { useEffect, useRef, useState } from 'react';
import CopyBox from './CopyBox';
import { useAiSegment } from './ai-translate';
import { useSettings, channelLabel, DEFAULT_PRIORITY } from './settings';
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

/** Provenance tag for segments that resolved below top priority (or via AI). */
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

/** One paragraph's Chinese line for an explicitly picked channel. */
function ZhLine({ seg, en, channel, ai, note }) {
  // legacy v1 string: the statement's only translation — show it for any channel
  if (typeof seg === 'string') {
    return (
      <p
        className={note ? 'text-[13px] text-muted-foreground' : ''}
        dangerouslySetInnerHTML={{ __html: renderRich(seg) }}
      />
    );
  }
  if (channel === 'ai') {
    return <AiZhLine en={en} ai={ai} note={note} />;
  }
  const zh = typeof seg?.[channel] === 'string' && seg[channel].trim() ? seg[channel] : null;
  return zh ? (
    <p dangerouslySetInnerHTML={{ __html: renderRich(zh) }} />
  ) : (
    <UntranslatedMark note={note ? `${note}（${channelLabel(channel)}）` : undefined} />
  );
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

/**
 * 对照 mode's Chinese line: walk the user's priority list for the first
 * channel with an archived translation. Every gap above the hit is bridged
 * by the user's AI endpoint (on demand, cached); if the bridge fails, degrade
 * to the hit. No hit and a failed/absent bridge → untranslated mark.
 */
function ChainZhLine({ seg, en, priority, ai, aiFallback, note }) {
  const [ref, visible] = useNearViewport();
  const aiReady = !!(ai?.baseUrl && ai?.apiKey);
  const aiState = useAiSegment(en, ai, aiFallback && aiReady && visible);

  // legacy v1 string: the statement's only translation
  if (typeof seg === 'string') {
    return (
      <p
        className={note ? 'text-[13px] text-muted-foreground' : ''}
        dangerouslySetInnerHTML={{ __html: renderRich(seg) }}
      />
    );
  }

  const prio = priority?.length ? priority : DEFAULT_PRIORITY;
  const hitIdx = prio.findIndex((ch) => typeof seg?.[ch] === 'string' && seg[ch].trim());
  const hit = hitIdx >= 0 ? { channel: prio[hitIdx], zh: seg[prio[hitIdx]] } : null;
  // bridge only fills gaps: top-priority hit needs no AI request
  const bridging = aiFallback && aiReady && hitIdx !== 0;

  if (bridging && aiState.status === 'done') {
    return (
      <div ref={ref}>
        <ZhWithBadge html={renderRich(aiState.text)} badge="AI" />
      </div>
    );
  }
  if (hit) {
    const showBadge = hitIdx > 0;
    const waitingAi = bridging && (aiState.status === 'loading' || (aiState.status === 'idle' && visible));
    return (
      <div ref={ref}>
        <ZhWithBadge html={renderRich(hit.zh)} badge={showBadge ? channelLabel(hit.channel) : undefined} />
        {waitingAi && <SpinnerNote>AI 翻译中…</SpinnerNote>}
      </div>
    );
  }
  if (bridging) {
    if (aiState.status === 'loading' || aiState.status === 'idle') {
      return (
        <div ref={ref}>
          <SpinnerNote>AI 翻译中…</SpinnerNote>
        </div>
      );
    }
    // AI failed and nothing archived — report why
    return (
      <div ref={ref}>
        <UntranslatedMark note={note ? `${note}（AI：${aiState.error}）` : `AI 翻译失败（${aiState.error}）`} />
      </div>
    );
  }
  return (
    <div ref={ref}>
      <UntranslatedMark
        note={note ? `${note}（暂无存档翻译${aiReady ? '，可开启 AI 补缺' : ''}）` : undefined}
      />
    </div>
  );
}

function Paragraphs({ list, zhList, mode, channel, ai, chain }) {
  const items = list.map((p, i) => {
    if (typeof p !== 'string') {
      return <pre key={i} className="code-block" dangerouslySetInnerHTML={{ __html: renderRich(p.pre) }} />;
    }
    if (mode === 'en') {
      return <p key={i} dangerouslySetInnerHTML={{ __html: renderRich(p) }} />;
    }
    const zh = zhList?.[i];
    const zhLine = chain ? (
      <ChainZhLine seg={zh} en={p} {...chain} />
    ) : (
      <ZhLine seg={zh} en={p} channel={channel} ai={ai} />
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

function Section({ label, list, zhList, mode, channel, ai, chain }) {
  if (!list?.length) return null;
  return (
    <div>
      <SectionHeading>{label}</SectionHeading>
      <Paragraphs list={list} zhList={zhList} mode={mode} channel={channel} ai={ai} chain={chain} />
    </div>
  );
}

/**
 * Full statement body (sections + examples), language-aware.
 * `statement.sectionsZh[key][i]` is index-aligned with `sections[key][i]`:
 * a per-channel map ({ deepl: …, youdao: … }), a legacy plain string, or
 * null when every pipeline channel failed. The "ai" channel translates on
 * demand in the browser via the user's own OpenAI-compatible endpoint.
 *
 * 对照 ("both") mode resolves each segment through the user's priority list
 * (settings) instead of one fixed channel, bridging missing archives with AI.
 */
export default function StatementBody({ statement }) {
  const { lang, settings } = useSettings();
  const s = statement;
  const mode = lang.mode;
  const channel = lang.channel;
  const zh = mode === 'en' ? null : s.sectionsZh;
  const ai = channel === 'ai' ? settings.ai : null;
  const chain =
    mode === 'both'
      ? {
          priority: settings.zhPriority,
          ai: settings.ai,
          aiFallback: settings.aiFallback !== false,
        }
      : null;
  const zhOf = (t) => (typeof t === 'string' ? t : t?.[channel]);

  let titleLine = null;
  if (mode !== 'en') {
    const stored = zhOf(s.titleZh);
    titleLine = chain ? (
      <ChainZhLine seg={s.titleZh || null} en={s.title} note="标题" {...chain} />
    ) : channel === 'ai' ? (
      <ZhLine seg={{ [channel]: stored }} en={s.title} channel="ai" ai={ai} note="标题" />
    ) : stored ? (
      <ZhLine seg={{ [channel]: stored }} en={s.title} channel={channel} />
    ) : (
      <ZhLine seg={null} en={s.title} channel={channel} ai={ai} note="标题" />
    );
  }

  return (
    <>
      {titleLine && <div className="text-base font-medium tracking-tight text-foreground/90">{titleLine}</div>}
      <Section label="题目描述" list={s.sections.legend} zhList={zh?.legend} mode={mode} channel={channel} ai={ai} chain={chain} />
      {(s.sections.input?.length > 0 || s.sections.output?.length > 0) && (
        <div className="grid gap-6 md:grid-cols-2">
          <Section label="输入格式" list={s.sections.input} zhList={zh?.input} mode={mode} channel={channel} ai={ai} chain={chain} />
          <Section label="输出格式" list={s.sections.output} zhList={zh?.output} mode={mode} channel={channel} ai={ai} chain={chain} />
        </div>
      )}
      <Section label="备注" list={s.sections.note} zhList={zh?.note} mode={mode} channel={channel} ai={ai} chain={chain} />
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
