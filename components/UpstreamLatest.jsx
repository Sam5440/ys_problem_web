'use client';

import { useEffect, useState } from 'react';
import { ExternalLink, Sparkles } from 'lucide-react';
import { parseTodayFromReadme, UPSTREAM_REPO } from '@/lib/upstream-readme.mjs';

// Anonymous GitHub API allows 60 req/h per IP — cache the parse in
// sessionStorage so revisits within the TTL cost zero requests.
const CACHE_KEY = 'upstream-today-v1';
const CACHE_TTL_MS = 10 * 60 * 1000;

function readCache() {
  try {
    const j = JSON.parse(sessionStorage.getItem(CACHE_KEY));
    if (j && Date.now() - j.t < CACHE_TTL_MS) return j.data;
  } catch {}
  return null;
}

function writeCache(data) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ t: Date.now(), data }));
  } catch {}
}

function formatDay(date) {
  const [, m, d] = date.split('-');
  return `${Number(m)}月${Number(d)}日`;
}

/**
 * Homepage banner: checks the upstream repo's README "Today's Problem" section
 * in the visitor's browser and, when our build-time snapshot is behind,
 * shows the latest problem codes with Codeforces links — statements may not
 * have synced yet, but the codes are always what upstream published last.
 * Renders nothing while up to date, on fetch failure or rate-limit (silent).
 */
export default function UpstreamLatest({ localDate, localCodes }) {
  const [info, setInfo] = useState(null);
  const codesKey = localCodes.join(',');

  useEffect(() => {
    let alive = true;
    const apply = (parsed) => {
      if (!alive || !parsed) return;
      const ahead =
        (parsed.date && localDate && parsed.date > localDate) ||
        (parsed.date && parsed.date === localDate &&
          parsed.problems.some((p) => !localCodes.includes(p.code.toLowerCase())));
      if (ahead) setInfo(parsed);
    };
    const cached = readCache();
    if (cached) {
      apply(cached);
      return () => {
        alive = false;
      };
    }
    fetch(`https://api.github.com/repos/${UPSTREAM_REPO}/readme`, {
      headers: { Accept: 'application/vnd.github.raw' },
    })
      .then((r) => (r.ok ? r.text() : null))
      .then((md) => {
        if (!md) return;
        const parsed = parseTodayFromReadme(md);
        if (parsed) {
          writeCache(parsed);
          apply(parsed);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localDate, codesKey]);

  if (!info) return null;
  return (
    <div className="mb-6 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
      <span className="inline-flex items-center gap-1.5 font-medium">
        <Sparkles className="size-4 text-amber-500" aria-hidden />
        上游已更新{info.date ? ` · ${formatDay(info.date)}` : ''}
      </span>
      {info.problems.map((p) => (
        <a
          key={p.code}
          href={p.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-0.5 font-mono text-xs transition-colors hover:border-amber-500/60"
        >
          {p.code}
          {p.difficulty ? <span className="text-muted-foreground">{p.difficulty}</span> : null}
          <ExternalLink className="size-3 text-muted-foreground" aria-hidden />
        </a>
      ))}
      <span className="text-muted-foreground">题面与翻译正在同步，稍后自动上线。</span>
    </div>
  );
}
