'use client';

import { useEffect } from 'react';

/**
 * Syntax highlighting for every `pre.code-block > code` on the page — same
 * progressive pattern as KatexRuntime: the server prerenders plain escaped
 * text (SSR/CSR identical), this runtime swaps in highlighted HTML after
 * mount and keeps watching via MutationObserver so lazily-mounted blocks
 * (accordion editorial, translation re-renders, /logs pages) are covered too.
 *
 * highlight.js (common languages ~35) is dynamically imported on first sight
 * of a code block: pages without one never load the chunk. Idempotent via
 * data-hl; failures leave the raw text in place.
 */

let installed = false;
let hljsPromise = null;
// CJS interop: the hljs instance rides on the module's .default
const getHljs = () =>
  (hljsPromise ??= import('highlight.js/lib/common').then((m) => m.default ?? m));

async function convertIn(root) {
  const blocks = root.querySelectorAll?.('pre.code-block:not([data-hl]) > code');
  if (!blocks || !blocks.length) return;
  const hljs = await getHljs();
  for (const code of blocks) {
    const pre = code.parentElement;
    pre.dataset.hl = '1';
    const raw = code.textContent || '';
    let html = null;
    try {
      const lang = (pre.dataset.lang || '').toLowerCase();
      html =
        lang && hljs.getLanguage(lang)
          ? hljs.highlight(raw, { language: lang }).value
          : hljs.highlightAuto(raw).value;
    } catch {
      html = null; // keep the raw text
    }
    if (html !== null) {
      code.innerHTML = html;
      code.classList.add('hljs');
    }
  }
}

function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  let queued = false;
  const sweep = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      convertIn(document.body).catch(() => {});
    });
  };
  new MutationObserver(sweep).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: false,
    attributes: false,
  });
}

export default function HighlightRuntime() {
  useEffect(() => {
    install();
    // first sweep in case nothing inserted after mount (fully prerendered page)
    queueMicrotask(() => convertIn(document.body).catch(() => {}));
  }, []);
  return null;
}
