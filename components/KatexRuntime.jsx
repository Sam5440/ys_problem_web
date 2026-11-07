'use client';

import { useEffect } from 'react';
import katex from 'katex';

/**
 * Converts `<code class="zs-math">` tokens emitted by lib/render.js into
 * real KaTeX markup. Listens app-wide with a MutationObserver so tokens are
 * caught wherever they appear — initial prerender, settings/翻译 re-renders
 * (React swaps the dangerouslySetInnerHTML containers), and the /logs demo
 * pages. Idempotent: converted elements no longer match the selector, and
 * failed conversions are marked so they are never re-tried.
 */

let installed = false;

function convertIn(root) {
  const tokens = root.querySelectorAll?.('code.zs-math');
  if (!tokens || !tokens.length) return;
  let dirty = false;
  for (const token of tokens) {
    if (token.dataset.kx) continue;
    token.dataset.kx = '1';
    // token textContent includes the visual $…$ / $$…$$ fences; KaTeX wants bare tex
    const raw = token.textContent || '';
    let tex = raw;
    if (token.dataset.display === '1' && raw.startsWith('$$') && raw.endsWith('$$')) {
      tex = raw.slice(2, raw.length - 2);
    } else if (raw.startsWith('$') && raw.endsWith('$') && raw.length > 1) {
      tex = raw.slice(1, raw.length - 1);
    }
    let html;
    try {
      html = katex.renderToString(tex, {
        displayMode: token.dataset.display === '1',
        throwOnError: false,
        strict: false,
      });
    } catch {
      continue; // keep the raw tex visible
    }
    const holder = document.createElement('template');
    holder.innerHTML = html;
    token.replaceWith(holder.content);
    dirty = true;
  }
  return dirty;
}

function install() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  let queued = false;
  const sweep = () => {
    if (queued) return;
    queued = true;
    // next tick keeps React from interleaving its own commit with ours
    queueMicrotask(() => {
      queued = false;
      convertIn(document.body);
    });
  };
  new MutationObserver(sweep).observe(document.body, {
    childList: true,
    subtree: true,
    characterData: false,
    attributes: false,
  });
}

export default function KatexRuntime() {
  useEffect(() => {
    install();
    // first sweep in case nothing inserted after mount (fully prerendered page)
    queueMicrotask(() => convertIn(document.body));
  }, []);
  return null;
}
