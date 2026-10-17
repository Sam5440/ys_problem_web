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
    // lowercase: highlight.js language ids are lowercase ('Python' → 'python')
    const lang = fence[1].trim().replace(/\s*\[\]\s*$/, '').toLowerCase();
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
  text = dedupeMathPreview(text);
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

// --- MathJax preview dedupe --------------------------------------------------
// Codeforces' MathJax v2 keeps the original math as plain text in a preview
// span while typesetting; the statement extractor used to leave that copy next
// to the restored TeX, so ~800 archived statements (and their AI translations)
// carry "n$$$n$$$" — every variable renders doubled. Trim the plain copy when
// it directly abuts the $$$…$$$ token and matches the TeX rendered to plain
// text; anything that doesn't match cleanly is left untouched.
const TEX_CHAR = {
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', times: '×',
  cdot: '·', pm: '±', mp: '∓', div: '÷', to: '→', rightarrow: '→',
  leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', infty: '∞',
  in: '∈', notin: '∉', subseteq: '⊆', supseteq: '⊇', cup: '∪', cap: '∩',
  oplus: '⊕', otimes: '⊗', ldots: '…', dots: '…', vdots: '⋮',
  lfloor: '⌊', rfloor: '⌋', lceil: '⌈', rceil: '⌉', langle: '⟨', rangle: '⟩',
  prime: '′', circ: '∘', star: '⋆', ast: '∗',
  '%': '%', '&': '&', '#': '#', _: '_', '{': '{', '}': '}',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
  varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ',
  tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ',
  omega: 'ω', Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ',
  Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
};
// HTML-math glyphs that differ from their TeX source spelling.
const FOLD_CHAR = { '−': '-', '–': '-', '—': '-', '⋅': '·', '∙': '·', '⋯': '…', '∗': '*' };

function texToPlain(tex) {
  let s = tex
    .replace(/\\left|\\right|\\big[lr]?|\\Big[lr]?|\\displaystyle|\\limits|\\[!,;:]/g, '')
    .replace(/\\(?:text|textrm|mathrm|mathbf|mathit|mathcal|mathbb|operatorname)\{([^{}]*)\}/g, '$1')
    .replace(/\\pmod\{([^{}]*)\}/g, '(mod $1)')
    .replace(/\\[dt]?frac\{([^{}]*)\}\{([^{}]*)\}/g, '$1$2')
    .replace(/\\sqrt\{([^{}]*)\}/g, '√$1');
  for (let i = 0; i < 2; i++) {
    s = s.replace(/[_^]\{([^{}]*)\}/g, '$1').replace(/[_^](\w)/g, '$1');
  }
  s = s
    .replace(/\\\\/g, '')
    .replace(/\\([a-zA-Z]+)|\\(.)/g, (_, cmd, ch) => (cmd ? TEX_CHAR[cmd] ?? '' : ch === '{' ? '\x01' : ch === '}' ? '\x02' : ch))
    .replace(/[{}]/g, '')
    .replace(/\x01/g, '{')
    .replace(/\x02/g, '}');
  return s;
}

const squash = (s) =>
  String(s)
    .replace(/\s+/g, '')
    .replace(/[−–—⋅∙⋯∗]/g, (c) => FOLD_CHAR[c] ?? c);

// Trim `plain` off the end of `prefix` when the prefix ends with a
// whitespace-insensitive match and the match doesn't glue into a word
// ("min" before $$$n$$$ must survive; "subset S" before $$$S$$$ is the leak).
function trimPlainCopy(prefix, plain) {
  const target = squash(plain);
  if (!target) return prefix;
  let k = prefix.length - 1;
  let t = target.length - 1;
  while (t >= 0 && k >= 0) {
    const c = prefix[k];
    if (/\s/.test(c)) {
      k--;
      continue;
    }
    if (squash(c) !== target[t]) return prefix;
    k--;
    t--;
  }
  if (t >= 0 || (k >= 0 && /[A-Za-z0-9^_]/.test(prefix[k]))) return prefix;
  return prefix.slice(0, k + 1);
}

export function dedupeMathPreview(text) {
  const src = String(text);
  if (!src.includes('$$$')) return src;
  let out = '';
  let rest = src;
  for (;;) {
    const i = rest.indexOf('$$$');
    if (i === -1) return out + rest;
    const j = rest.indexOf('$$$', i + 3);
    if (j === -1) return out + rest;
    out += trimPlainCopy(rest.slice(0, i), texToPlain(rest.slice(i + 3, j)));
    out += rest.slice(i, j + 3);
    rest = rest.slice(j + 3);
  }
}


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
