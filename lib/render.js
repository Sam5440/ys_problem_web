import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Math is NOT rendered here: both server (SSR) and client emit the same
 * inert token, so hydration sees identical HTML. A page-level watcher
 * (components/KatexRuntime.jsx) converts tokens to real KaTeX after mount,
 * which keeps every prerendered page small — the expanded KaTeX span tree
 * used to live in 3 copies per page (html body, inline flight, .rsc).
 */
function mathToken(tex, displayMode) {
  const fence = displayMode ? '$$' : '$';
  return `<code class="zs-math" data-display="${displayMode ? 1 : 0}">${escapeHtml(
    fence + tex + fence,
  )}</code>`;
}

function renderCodeBlock(block) {
  const fence = block.match(/^```([^\n]*)\n([\s\S]*?)```\s*$/);
  if (fence) {
    const lang = fence[1].trim().replace(/\s*\[\]\s*$/, '');
    return `<pre class="code-block"${lang ? ` data-lang="${escapeHtml(lang)}"` : ''}><code>${escapeHtml(
      fence[2].replace(/\n$/, ''),
    )}</code></pre>`;
  }
  return `<code class="inline-code">${escapeHtml(block.slice(1, -1))}</code>`;
}

/**
 * Render markdown (or plain paragraphs) containing Codeforces-style math
 * ($$$...$$$ inline, $$...$$ display, $...$ inline) into HTML with KaTeX.
 * Code fences / inline code are protected from math extraction.
 */
export function renderRich(md) {
  if (!md) return '';
  const stash = [];
  const keep = (type, content) => {
    stash.push({ type, content });
    return `%%ZS${type}${stash.length - 1}%%`;
  };
  let text = String(md).replace(/```[^\n]*\n[\s\S]*?```|`[^`\n]+`/g, (m) => keep('code', m));
  text = text.replace(/\$\$\$([\s\S]+?)\$\$\$/g, (_, t) => keep('mi', t));
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, t) => keep('md', t));
  text = text.replace(/\$([^$\n]+?)\$/g, (_, t) => keep('mi', t));
  let html = marked.parse(text);
  html = html.replace(/%%ZScode(\d+)%%/g, (_, i) => renderCodeBlock(stash[i].content));
  html = html.replace(/%%ZSmi(\d+)%%/g, (_, i) => mathToken(stash[i].content, false));
  html = html.replace(/%%ZSmd(\d+)%%/g, (_, i) => mathToken(stash[i].content, true));
  return html;
}

const RATING_COLORS = [
  [1200, '#9aa3b5'],
  [1400, '#43d17e'],
  [1600, '#2fd6c3'],
  [1900, '#5b8dff'],
  [2100, '#b06bff'],
  [2400, '#ff9d45'],
  [Infinity, '#ff5b6e'],
];

export function ratingColor(difficulty) {
  const n = parseInt(String(difficulty).replace(/\D/g, ''), 10);
  if (!n) return '#9aa3b5';
  for (const [max, color] of RATING_COLORS) if (n < max) return color;
  return '#9aa3b5';
}

export function formatDateCN(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  if (!y || !m || !d) return date;
  return `${y}年${m}月${d}日`;
}
