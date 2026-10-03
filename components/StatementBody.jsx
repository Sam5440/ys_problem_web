'use client';

import { useState } from 'react';
import CopyBox from './CopyBox';
import { useStatementLang } from './statement-lang';
import { renderRich } from '@/lib/render';

// All platforms that produce translations, in UI preference order —
// the first one with a translation for a segment is the default shown.
const CHANNELS = [
  ['deepl', 'DeepL'],
  ['youdao', '有道'],
  ['caiyun', '彩云'],
  ['iflyrec', '讯飞'],
  ['google', 'Google'],
];

function SectionHeading({ children }) {
  return (
    <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{children}</h3>
  );
}

function UntranslatedMark() {
  return (
    <span className="mt-1 inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-500">
      <span aria-hidden>⚠</span> 本段暂无翻译
    </span>
  );
}

const hasText = (seg) =>
  typeof seg === 'string' ? !!seg.trim() : !!seg && Object.keys(seg).length > 0;

const preferredChannel = (seg) => {
  for (const [ch] of CHANNELS) {
    if (typeof seg?.[ch] === 'string' && seg[ch].trim()) return ch;
  }
  return null;
};

function ChannelChips({ seg, active, onPick }) {
  const available = CHANNELS.filter(([ch]) => typeof seg?.[ch] === 'string' && seg[ch].trim());
  if (available.length < 1) return null;
  return (
    <div className="mb-1 flex flex-wrap items-center gap-1">
      {available.map(([ch, label]) => (
        <button
          key={ch}
          type="button"
          onClick={() => onPick(ch)}
          className={`rounded border px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
            ch === active
              ? 'border-primary/60 bg-primary/15 text-primary'
              : 'border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * One segment's Chinese translation. `seg` is the v2 per-platform map
 * ({ deepl: "…", youdao: "…" }), a legacy plain string, or empty when every
 * platform failed. DeepL is the default channel; chips switch per segment.
 */
function ZhBlock({ seg, className = '' }) {
  const [active, setActive] = useState(() => preferredChannel(seg));
  if (typeof seg === 'string') {
    return (
      <div className={className}>
        <p dangerouslySetInnerHTML={{ __html: renderRich(seg) }} />
      </div>
    );
  }
  const current = seg && active && typeof seg[active] === 'string' && seg[active].trim() ? active : preferredChannel(seg);
  if (!current) {
    return (
      <div className={className}>
        <UntranslatedMark />
      </div>
    );
  }
  return (
    <div className={className}>
      <ChannelChips seg={seg} active={current} onPick={setActive} />
      <p dangerouslySetInnerHTML={{ __html: renderRich(seg[current]) }} />
    </div>
  );
}

function Paragraphs({ list, zhList, lang }) {
  const items = list.map((p, i) => {
    if (typeof p !== 'string') {
      return <pre key={i} className="code-block" dangerouslySetInnerHTML={{ __html: renderRich(p.pre) }} />;
    }
    const zh = zhList?.[i];
    if (lang === 'zh') {
      if (!hasText(zh)) {
        return (
          <div key={i}>
            <p dangerouslySetInnerHTML={{ __html: renderRich(p) }} />
            <UntranslatedMark />
          </div>
        );
      }
      return <ZhBlock key={i} seg={zh} />;
    }
    if (lang === 'both') {
      return (
        <div key={i}>
          <p dangerouslySetInnerHTML={{ __html: renderRich(p) }} />
          <ZhBlock
            seg={zh}
            className="stmt-zh mt-1 border-l-2 border-primary/40 pl-3 text-[13px] text-muted-foreground"
          />
        </div>
      );
    }
    return <p key={i} dangerouslySetInnerHTML={{ __html: renderRich(p) }} />;
  });
  return <div className="stmt-body">{items}</div>;
}

function Section({ label, list, zhList, lang }) {
  if (!list?.length) return null;
  return (
    <div>
      <SectionHeading>{label}</SectionHeading>
      <Paragraphs list={list} zhList={zhList} lang={lang} />
    </div>
  );
}

/**
 * Full statement body (sections + examples), language-aware.
 * `statement.sectionsZh[key][i]` is index-aligned with `sections[key][i]`:
 * a per-platform map ({ deepl: … }), a legacy string, or null when every
 * platform failed; {pre} code blocks and missing segments fall back to the
 * original.
 */
export default function StatementBody({ statement }) {
  const { lang } = useStatementLang();
  const s = statement;
  const zh = lang === 'en' ? null : s.sectionsZh;

  let titleText = null;
  if (lang !== 'en') {
    const t = s.titleZh;
    titleText = typeof t === 'string' ? t : t?.[preferredChannel(t)] || null;
  }

  return (
    <>
      {titleText && <p className="text-base font-medium tracking-tight text-foreground/90">{titleText}</p>}
      <Section label="题目描述" list={s.sections.legend} zhList={zh?.legend} lang={lang} />
      {(s.sections.input?.length > 0 || s.sections.output?.length > 0) && (
        <div className="grid gap-6 md:grid-cols-2">
          <Section label="输入格式" list={s.sections.input} zhList={zh?.input} lang={lang} />
          <Section label="输出格式" list={s.sections.output} zhList={zh?.output} lang={lang} />
        </div>
      )}
      <Section label="备注" list={s.sections.note} zhList={zh?.note} lang={lang} />
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
