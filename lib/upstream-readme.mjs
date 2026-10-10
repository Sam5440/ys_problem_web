// Parse the "## Today's Problem" table from the upstream repo README
// (Yawn-Sean/Daily_CF_Problems). The browser fetches the whole README in one
// anonymous GitHub API call and this parser extracts the published day and
// problem codes, so the homepage can say "upstream is ahead" even while our
// data pipeline hasn't synced the statements yet.

export const UPSTREAM_REPO = 'Yawn-Sean/Daily_CF_Problems';

/**
 * @param {string} md full README markdown
 * @returns {{date: string|null, problems: Array<{code: string, url: string, difficulty: string|null}>}|null}
 *          null when the section or table is missing/malformed — callers must
 *          treat that as "no upstream info" and stay silent, never as empty day
 */
export function parseTodayFromReadme(md) {
  if (typeof md !== 'string') return null;
  const heading = md.match(/##\s*Today['’]s Problem/i);
  if (!heading) return null;
  const section = md.slice(heading.index);
  const rows = section.split('\n').filter(
    (line) =>
      /^\s*\|/.test(line) &&
      !/^\s*\|[\s:|-]+\|?\s*$/.test(line) && // column separator row
      !/^\s*\|?\s*Difficulty/.test(line), // header row
  );
  const problems = [];
  let date = null;
  for (const row of rows) {
    // Editorial links carry the upstream date path: daily_problems/YYYY/M/MMDD/
    // MMDD is a zero-padded 2-digit day, the month comes from its own segment.
    for (const m of row.matchAll(
      /\[[^\]]*\]\([^)]*daily_problems\/(\d{4})\/(\d{1,2})\/(\d+)[^)]*\)/g,
    )) {
      date = `${m[1]}-${String(m[2]).padStart(2, '0')}-${m[3].slice(-2)}`;
    }
    const prob = [
      ...row.matchAll(/\[([A-Za-z]*\d[A-Za-z0-9]*)\]\((https:\/\/codeforces\.com\/[^)\s]+)\)/g),
    ][0];
    if (!prob) continue;
    const diff = row.match(/\|\s*\*(\d{3,4})\s*\|/);
    problems.push({
      code: prob[1].toUpperCase(),
      url: prob[2],
      difficulty: diff ? `*${diff[1]}` : null,
    });
  }
  if (problems.length === 0) return null;
  return { date, problems };
}
