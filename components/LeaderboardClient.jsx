'use client';

import { useEffect, useRef, useState } from 'react';
import { CalendarCheck2, Flame, Trophy, Users } from 'lucide-react';
import { buildLeaderboardRows } from '@/lib/leaderboard';
import { parseRecordsJs, recordsSignature, UPSTREAM_RECORDS_URL } from '@/lib/records';
import LeaderboardView from '@/components/LeaderboardView';
import { Card, CardContent } from '@/components/ui/card';

function StatCard({ icon: Icon, label, value, hint }) {
  return (
    <Card className="gap-0 py-4">
      <CardContent className="flex items-center gap-3 px-4">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-xs text-muted-foreground">{label}</p>
          <p className="truncate text-lg font-semibold tabular-nums">{value}</p>
          <p className="truncate text-[11px] text-muted-foreground">{hint}</p>
        </div>
      </CardContent>
    </Card>
  );
}

// Live refresh straight from upstream gh-pages (29KB, anonymous, CORS-open):
// our CI-synced snapshot is only as fresh as the last surviving hourly run,
// so the browser re-pulls the source of truth on every visit instead.
const CACHE_KEY = 'lb-upstream-v1';
const CACHE_TTL_MS = 10 * 60 * 1000;

function readUpstreamCache() {
  try {
    const hit = JSON.parse(sessionStorage.getItem(CACHE_KEY));
    if (hit && Date.now() - hit.savedAt < CACHE_TTL_MS && hit.data) return hit;
  } catch {}
  return null;
}

function fetchUpstreamRecords() {
  const cached = readUpstreamCache();
  if (cached) return Promise.resolve(cached);
  return fetch(UPSTREAM_RECORDS_URL, { signal: AbortSignal.timeout(15000) })
    .then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    })
    .then((text) => {
      const hit = { savedAt: Date.now(), data: parseRecordsJs(text) };
      try {
        sessionStorage.setItem(CACHE_KEY, JSON.stringify(hit));
      } catch {}
      return hit;
    });
}

/** Data arrives from /leaderboard.json (generated at build time) instead of
    being serialized into the prerendered page — the RSC payload used to carry
    every player's full day series (~15MB per deployment). After the snapshot
    renders, the upstream records.js is fetched live; the snapshot only backs
    the page when the visitor's network can't reach it. */
export default function LeaderboardClient() {
  const [data, setData] = useState(undefined); // undefined = loading, null = no data
  const [live, setLive] = useState(null); // null = pending/failed, {savedAt} = live-synced
  const sigRef = useRef(null);

  useEffect(() => {
    let alive = true;
    fetch('/leaderboard.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j) {
          sigRef.current = recordsSignature(j);
          setData(buildLeaderboardRows(j));
        }
      })
      .catch(() => {
        if (alive) setData(null);
      });
    // The live refresh runs even while the snapshot is still loading —
    // whichever finishes first paints, the other one just updates state.
    fetchUpstreamRecords()
      .then((hit) => {
        if (!alive) return;
        const sig = recordsSignature(hit.data);
        if (sig !== sigRef.current) {
          sigRef.current = sig;
          setData(buildLeaderboardRows(hit.data));
        }
        setLive({ savedAt: hit.savedAt });
      })
      .catch(() => {}); // snapshot stays; the 统计截至 dates tell the story
    return () => {
      alive = false;
    };
  }, []);

  if (data === undefined) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-[70px] animate-pulse rounded-xl border border-border/60 bg-muted/30" />
        ))}
      </div>
    );
  }

  if (!data) {
    return (
      <section className="py-16 text-center">
        <h2 className="text-2xl font-bold tracking-tight">排行榜暂无数据</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          未能加载源仓库的社区提交记录，可前往
          <a
            href="https://github.com/Yawn-Sean/Daily_CF_Problems/tree/gh-pages"
            target="_blank"
            rel="noreferrer"
            className="mx-1 font-medium text-foreground underline underline-offset-4"
          >
            上游 gh-pages
          </a>
          查看原始榜单。
        </p>
      </section>
    );
  }

  const { rows, currentDate } = data;
  const perfect = rows.filter((r) => r.latestScore === 2).length;
  const record = rows.reduce((best, r) => (r.maxStreak > best.maxStreak ? r : best), rows[0]);
  const totalSolves = rows.reduce((sum, r) => sum + r.totalSolves, 0);

  return (
    <>
      {live && (
        <p className="mb-4 flex items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-block size-1.5 animate-pulse rounded-full bg-emerald-500" />
          已实时同步上游 gh-pages（访客浏览器直拉，
          {new Date(live.savedAt).toLocaleTimeString('zh-CN', { hour12: false })}）
        </p>
      )}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard icon={Users} label="上榜玩家" value={rows.length} hint={`统计截至 ${currentDate}`} />
        <StatCard icon={Trophy} label="最长连击纪录" value={`${record.maxStreak} 天`} hint={`保持者 ${record.user}`} />
        <StatCard icon={Flame} label="最近一日满贯" value={`${perfect} 人`} hint="当日两题全对" />
        <StatCard icon={CalendarCheck2} label="累计解题" value={totalSolves} hint="全体玩家总和" />
      </section>
      <section className="mt-6 pb-14">
        <LeaderboardView data={data} />
      </section>
    </>
  );
}
