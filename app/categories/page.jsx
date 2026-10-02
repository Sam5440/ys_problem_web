import Link from 'next/link';
import { getCategories } from '@/lib/data';
import { ratingColor } from '@/lib/render';

export const metadata = { title: '题目分类 · YS Problem Web' };

const SHOW_PER_CATEGORY = 30;

export default function CategoriesPage() {
  const categories = getCategories();
  const total = categories.reduce((s, c) => s + c.count, 0);
  return (
    <>
      <section className="page-head">
        <h1 className="page-title">题目分类</h1>
        <p className="page-sub">
          上游仓库按使用的算法/技巧将 {total} 道题归入 {categories.length} 个方法，展开查看。
        </p>
      </section>
      <div className="cat-grid">
        {categories.map((cat) => (
          <details className="cat-card" key={cat.name}>
            <summary>
              <span className="cat-name">{cat.name.replace(/_/g, ' ')}</span>
              <span className="cat-count">{cat.count}</span>
            </summary>
            <ul className="cat-list">
              {cat.problems.slice(0, SHOW_PER_CATEGORY).map((p) => (
                <li key={`${p.code}-${p.url}`}>
                  <a className="cat-link" href={p.url} target="_blank" rel="noreferrer">
                    <span className="diff-dot" style={{ background: ratingColor(p.difficulty) }} />
                    <code>{p.code}</code>
                  </a>
                  <span className="cat-hint">{p.hint}</span>
                </li>
              ))}
            </ul>
            {cat.count > SHOW_PER_CATEGORY && (
              <p className="cat-more">
                还有 {cat.count - SHOW_PER_CATEGORY} 道 ·{' '}
                <a className="text-link" href={cat.url} target="_blank" rel="noreferrer">
                  在 GitHub 查看全部 ↗
                </a>
              </p>
            )}
          </details>
        ))}
      </div>
    </>
  );
}
