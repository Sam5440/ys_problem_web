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
 * ($$$...$$$ inline, $$$$$$...$$$$$$ display, $$...$$ display, $...$ inline)
 * into HTML with KaTeX. Code fences / inline code are protected from math
 * extraction.
 */
export function renderRich(md) {
  if (!md) return '';
  const stash = [];
  const keep = (type, content) => {
    stash.push({ type, content });
    return `%%ZS${type}${stash.length - 1}%%`;
  };
  let text = String(md).replace(/```[^\n]*\n[\s\S]*?```|`[^`\n]+`/g, (m) => keep('code', m));
  text = stripHiddenTex(text);
  text = normalizeDollarRuns(text);
  text = dedupeMathPreview(text);
  text = text.replace(/\$\$\$\$\$\$([\s\S]+?)\$\$\$\$\$\$/g, (_, t) => keep('md', t));
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

// --- Hidden-text strips -----------------------------------------------------
// Some problem setters embed invisible anti-AI honeypots in statements via
// MathJax v2's \style (e.g. {\style{opacity:0;font-size:0px}{\tiny{\text{…}}}},
// also seen as \style{color:white;font-size:1px}). Codeforces renders them
// invisible; KaTeX has no \style and spills the raw TeX plus the hidden text
// onto the page as visible garbage. Strip the whole group — the enclosing
// braces and adjacent $$$ fences go with it — so the page shows what a human
// sees on Codeforces: nothing.
const HIDDEN_STYLE =
  /opacity\s*:\s*0(?![.\d])|font-size\s*:\s*0(?:px|em|pt)?(?![.\d])|color\s*:\s*(?:white|#fff(?:fff)?)\b[\s\S]{0,60}?font-size\s*:\s*1(?:px|pt)\b|font-size\s*:\s*1(?:px|pt)\b[\s\S]{0,60}?color\s*:\s*(?:white|#fff(?:fff)?)\b/;

function findMatchingBrace(s, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export function stripHiddenTex(text) {
  let s = String(text);
  if (!s.includes('\\style')) return s;
  let i = s.indexOf('\\style');
  let stripped = false;
  while (i !== -1) {
    const brace = /^\s*\{/.exec(s.slice(i + 6));
    if (!brace) {
      i = s.indexOf('\\style', i + 6);
      continue;
    }
    const styleOpen = i + 6 + brace[0].length - 1;
    const styleClose = findMatchingBrace(s, styleOpen);
    if (styleClose === -1) break; // unbalanced — leave the rest untouched
    if (!HIDDEN_STYLE.test(s.slice(styleOpen + 1, styleClose))) {
      i = s.indexOf('\\style', styleClose); // visible \style — keep it
      continue;
    }
    // hidden: drop the style group plus its content group
    let start = i;
    let stop = styleClose + 1;
    const content = /^\s*\{/.exec(s.slice(stop));
    if (content) {
      const contentClose = findMatchingBrace(s, stop + content[0].length - 1);
      if (contentClose !== -1) stop = contentClose + 1;
    }
    // enclosing group: {\style{…}{…}}
    if (start > 0 && s[start - 1] === '{' && s[stop] === '}' && findMatchingBrace(s, start - 1) === stop) {
      start--;
      stop++;
    }
    // $$$ fences wrapping ONLY this group, whitespace tolerated ("$$$ {\style…} $$$")
    let k = start;
    while (k > 0 && /[ \t]/.test(s[k - 1])) k--;
    if (k >= 3 && s.slice(k - 3, k) === '$$$') {
      let m = stop;
      while (m < s.length && /[ \t]/.test(s[m])) m++;
      if (s.slice(m, m + 3) === '$$$') {
        start = k - 3;
        stop = m + 3;
      }
    }
    // adjacent $$$ fences
    if (s.slice(start - 3, start) === '$$$') start -= 3;
    if (s.slice(stop, stop + 3) === '$$$') stop += 3;
    s = s.slice(0, start) + s.slice(stop);
    stripped = true;
    i = s.indexOf('\\style', start);
  }
  return s;
}

// --- Glued inline math ------------------------------------------------------
// Translations often drop the space between adjacent inline formulas, fusing
// their fences into a 6-dollar run: $$$n, m$$$$$$(1 \le n)$$$ — the 3-dollar
// pairing then slides off and swallows the rest of the paragraph into one
// formula. True display math ($$$$$$…$$$$$$) keeps its 6-dollar runs, but its
// fences always face whitespace/text on ONE side only; a glued run is pinned
// by non-space characters on BOTH sides. Split those back into two fences.
export function normalizeDollarRuns(text) {
  let s = String(text);
  if (!s.includes('$$$$$$')) return s;
  let out = '';
  let rest = s;
  for (;;) {
    const i = rest.indexOf('$$$$$$');
    if (i === -1) return out + rest;
    const prev = i > 0 ? rest[i - 1] : '';
    const next = rest[i + 6] || '';
    const glued = (prev && !/\s/.test(prev) && next && !/\s/.test(next));
    out += rest.slice(0, i) + (glued ? '$$$ $$$' : rest.slice(i, i + 6));
    rest = rest.slice(i + 6);
  }
}

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
