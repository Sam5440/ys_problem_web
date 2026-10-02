'use client';

import CopyBox from './CopyBox';
import { useStatementLang } from './statement-lang';
import { renderRich } from '@/lib/render';

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

function Paragraphs({ list, zhList, lang }) {
  const items = list.map((p, i) => {
    if (typeof p !== 'string') {
      return <pre key={i} className="code-block" dangerouslySetInnerHTML={{ __html: renderRich(p.pre) }} />;
    }
    const zh = zhList?.[i];
    const hasZh = typeof zh === 'string' && zh.trim();
    if (lang === 'zh') {
      if (!hasZh) {
        return (
          <div key={i}>
            <p dangerouslySetInnerHTML={{ __html: renderRich(p) }} />
            <UntranslatedMark />
          </div>
        );
      }
      return <p key={i} dangerouslySetInnerHTML={{ __html: renderRich(zh) }} />;
    }
    if (lang === 'both') {
      return (
        <div key={i}>
          <p dangerouslySetInnerHTML={{ __html: renderRich(p) }} />
          {hasZh ? (
            <p
              className="stmt-zh border-l-2 border-primary/40 pl-3 text-[13px] text-muted-foreground"
              dangerouslySetInnerHTML={{ __html: renderRich(zh) }}
            />
          ) : (
            <UntranslatedMark />
          )}
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
 * `statement.sectionsZh` is index-aligned with `sections`; segments without a
 * translation (null / {pre} code blocks) always fall back to the original.
 */
export default function StatementBody({ statement }) {
  const { lang } = useStatementLang();
  const s = statement;
  const zh = lang === 'en' ? null : s.sectionsZh;
  return (
    <>
      {lang !== 'en' && s.titleZh && (
        <p className="text-base font-medium tracking-tight text-foreground/90">{s.titleZh}</p>
      )}
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
