import CopyBox from './CopyBox';
import { renderRich, ratingColor } from '@/lib/render';

function Chips({ problem }) {
  const s = problem.statement;
  const color = ratingColor(problem.difficulty);
  const isGym = /^gym/i.test(problem.code);
  return (
    <div className="chips">
      <span className="chip diff-chip" style={{ '--diff-color': color }}>
        {String(problem.difficulty).replace('*', '')}
      </span>
      {isGym && <span className="chip">GYM</span>}
      {s?.timeLimit && <span className="chip">⏱ {s.timeLimit}</span>}
      {s?.memoryLimit && <span className="chip">💾 {s.memoryLimit}</span>}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <section className="stmt-section">
      <h3 className="stmt-heading">{title}</h3>
      {children}
    </section>
  );
}

function Paragraphs({ list }) {
  return (
    <div className="stmt-body">
      {list.map((p, i) => (
        <p key={i} dangerouslySetInnerHTML={{ __html: renderRich(p) }} />
      ))}
    </div>
  );
}

function Statement({ problem }) {
  const s = problem.statement;
  return (
    <>
      <Section title="题目描述">
        <Paragraphs list={s.sections.legend} />
      </Section>
      <div className="stmt-cols">
        {s.sections.input?.length > 0 && (
          <Section title="输入格式">
            <Paragraphs list={s.sections.input} />
          </Section>
        )}
        {s.sections.output?.length > 0 && (
          <Section title="输出格式">
            <Paragraphs list={s.sections.output} />
          </Section>
        )}
      </div>
      {s.sections.note?.length > 0 && (
        <Section title="备注">
          <Paragraphs list={s.sections.note} />
        </Section>
      )}
      {s.examples?.length > 0 && (
        <Section title="样例">
          <div className="examples">
            {s.examples.map((ex, i) => (
              <div className="example-pair" key={i}>
                <span className="example-no">样例 {i + 1}</span>
                <div className="example-boxes">
                  <CopyBox label="Input" text={ex.input} />
                  <CopyBox label="Output" text={ex.output} />
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  );
}

function Hint({ hint }) {
  if (!hint) return null;
  return (
    <details className="fold hint-fold">
      <summary>💡 提示（Hint）</summary>
      <div className="fold-body" dangerouslySetInnerHTML={{ __html: renderRich(hint) }} />
    </details>
  );
}

function Solution({ problem }) {
  const md = problem.solution?.markdown;
  const url = problem.solution?.url;
  if (!md && !url) return null;
  return (
    <details className="fold solution-fold">
      <summary>📝 题解（Editorial）</summary>
      <div className="fold-body editorial" dangerouslySetInnerHTML={{ __html: renderRich(md) }} />
      {url && !md && (
        <p className="fold-body">
          <a href={url} target="_blank" rel="noreferrer" className="text-link">
            在 GitHub 上查看题解 ↗
          </a>
        </p>
      )}
    </details>
  );
}

export default function ProblemCard({ problem }) {
  const s = problem.statement;
  const title = s?.title ? s.title.replace(/^[A-Z][.)]\s*/, '') : problem.code;
  return (
    <article className="problem-card" id={problem.code}>
      <header className="problem-head">
        <div className="problem-id" aria-hidden="true">
          {s?.letter || '?'}
        </div>
        <div className="problem-title-wrap">
          <h2 className="problem-title">{title}</h2>
          <div className="problem-meta">
            <span className="problem-code">{problem.code}</span>
            {s?.contest && <span className="dot">·</span>}
            {s?.contest && <span>{s.contest}</span>}
          </div>
          <Chips problem={problem} />
        </div>
        <a className="cf-btn" href={problem.url} target="_blank" rel="noreferrer">
          Codeforces ↗
        </a>
      </header>

      {s ? (
        <Statement problem={problem} />
      ) : (
        <p className="stmt-body no-stmt">
          暂无完整题面（Codeforces 反爬限制），点击右上角按钮前往原题查看。
        </p>
      )}

      <Hint hint={problem.hint} />
      <Solution problem={problem} />
    </article>
  );
}
