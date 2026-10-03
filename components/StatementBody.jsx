'use client';

import { useEffect, useRef, useState } from 'react';
import CopyBox from './CopyBox';
import { useAiSegment } from './ai-translate';
import { useSettings, channelLabel } from './settings';
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

/** One paragraph's Chinese line for the selected channel. */
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
  // translate on demand: only when the segment scrolls near the viewport
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
  const state = useAiSegment(en, ai, visible && !!(ai?.baseUrl && ai?.apiKey));
  return (
    <div ref={ref}>
      {state.status === 'loading' && (
        <span className="inline-flex items-center gap-1.5 text-[12px] text-muted-foreground/70">
          <span className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          AI 翻译中…
        </span>
      )}
      {state.status === 'error' && <UntranslatedMark note={`AI 翻译失败（${state.error}）`} />}
      {state.status === 'done' && <p dangerouslySetInnerHTML={{ __html: renderRich(state.text) }} />}
      {state.status === 'idle' && <UntranslatedMark note={note ? `${note}（AI）` : '请在设置中配置 AI 接口'} />}
    </div>
  );
}

function Paragraphs({ list, zhList, mode, channel, ai }) {
  const items = list.map((p, i) => {
    if (typeof p !== 'string') {
      return <pre key={i} className="code-block" dangerouslySetInnerHTML={{ __html: renderRich(p.pre) }} />;
    }
    if (mode === 'en') {
      return <p key={i} dangerouslySetInnerHTML={{ __html: renderRich(p) }} />;
    }
    const zh = zhList?.[i];
    const zhLine = (
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

function Section({ label, list, zhList, mode, channel, ai }) {
  if (!list?.length) return null;
  return (
    <div>
      <SectionHeading>{label}</SectionHeading>
      <Paragraphs list={list} zhList={zhList} mode={mode} channel={channel} ai={ai} />
    </div>
  );
}

/**
 * Full statement body (sections + examples), language-aware.
 * `statement.sectionsZh[key][i]` is index-aligned with `sections[key][i]`:
 * a per-channel map ({ deepl: …, youdao: … }), a legacy plain string, or
 * null when every pipeline channel failed. The "ai" channel translates on
 * demand in the browser via the user's own OpenAI-compatible endpoint.
 */
export default function StatementBody({ statement }) {
  const { lang, settings } = useSettings();
  const s = statement;
  const mode = lang.mode;
  const channel = lang.channel;
  const zh = mode === 'en' ? null : s.sectionsZh;
  const ai = channel === 'ai' ? settings.ai : null;
  const zhOf = (t) => (typeof t === 'string' ? t : t?.[channel]);

  let titleLine = null;
  if (mode !== 'en') {
    const stored = zhOf(s.titleZh);
    titleLine =
      channel === 'ai' ? (
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
      <Section label="题目描述" list={s.sections.legend} zhList={zh?.legend} mode={mode} channel={channel} ai={ai} />
      {(s.sections.input?.length > 0 || s.sections.output?.length > 0) && (
        <div className="grid gap-6 md:grid-cols-2">
          <Section label="输入格式" list={s.sections.input} zhList={zh?.input} mode={mode} channel={channel} ai={ai} />
          <Section label="输出格式" list={s.sections.output} zhList={zh?.output} mode={mode} channel={channel} ai={ai} />
        </div>
      )}
      <Section label="备注" list={s.sections.note} zhList={zh?.note} mode={mode} channel={channel} ai={ai} />
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
