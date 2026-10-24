'use client';

import { useEffect, useState } from 'react';

/**
 * Footer「数据更新于 <date>」— client-rendered on purpose: baking the date
 * into every prerendered page defeats Vercel's cross-deployment file
 * deduplication (all ~850 pages would change bytes on every build and the
 * whole deployment gets re-stored ~210MB). The date comes from
 * public/build-info.json generated at build time.
 */
export default function DataFreshness() {
  const [date, setDate] = useState('');
  useEffect(() => {
    let alive = true;
    fetch('/build-info.json')
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (alive && j?.generatedAt) setDate(String(j.generatedAt).slice(0, 10));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (!date) return null;
  return <>数据更新于 {date} · </>;
}
