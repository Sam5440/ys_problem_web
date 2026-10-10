import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Build-time exports for /leaderboard and /archive (they render client-side
// by fetching these files) plus the footer date consumed by DataFreshness.
// Keeping timestamps and bulk data OUT of the prerendered pages is what lets
// Vercel dedupe unchanged files across deployments instead of re-storing all
// ~850 pages on every build.

const daily = JSON.parse(readFileSync(new URL('../data/daily.json', import.meta.url), 'utf8'));

writeFileSync(
  new URL('../public/build-info.json', import.meta.url),
  JSON.stringify({ generatedAt: daily.generatedAt ?? null }, null, 2),
);

const slimArchive = {
  generatedAt: daily.generatedAt ?? null,
  cutoff: daily.generatedAt?.slice(0, 10) ?? null,
  days: (daily.days ?? []).map((day) => ({
    date: day.date,
    problems: (day.problems ?? []).map((p) => ({
      code: p.code,
      difficulty: p.difficulty,
      title: p.statement?.title ?? null,
      url: p.url,
    })),
  })),
};
writeFileSync(new URL('../public/archive.json', import.meta.url), JSON.stringify(slimArchive));

const lbPath = new URL('../data/leaderboard.json', import.meta.url);
if (existsSync(lbPath)) {
  writeFileSync(new URL('../public/leaderboard.json', import.meta.url), readFileSync(lbPath));
}
