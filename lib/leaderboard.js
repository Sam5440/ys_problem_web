import leaderboard from '@/data/leaderboard.json';

// The run-length rows in records.js cover exactly the days upstream actually ran
// (skipped_dates are absent), counted backwards from currentDate — rebuild the
// per-day series the same way records.py wrote it. Series comes out oldest-first.
function decodeSeries(runs, currentDate, skippedSet) {
  const totalDays = runs.reduce((sum, [, days]) => sum + days, 0);
  const series = [];
  const cursor = new Date(`${currentDate}T00:00:00Z`);
  let runIdx = runs.length - 1;
  let runLeft = runs[runIdx]?.[1] ?? 0;
  // Hard cap guards against a malformed file looping forever.
  for (let step = 0; step < totalDays * 4 + 800 && series.length < totalDays; step++) {
    const date = cursor.toISOString().slice(0, 10);
    if (!skippedSet.has(date)) {
      series.push({ date, score: runs[runIdx][0] });
      if (--runLeft === 0 && runIdx > 0) {
        runIdx--;
        runLeft = runs[runIdx][1];
      }
    }
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return series.reverse();
}

export function getLeaderboardData() {
  if (!leaderboard?.users?.length) return null;
  return leaderboard;
}

// One row per player, in the upstream's default ranking: current streak, then
// max streak, total active days, total solves, finally the id.
export function buildLeaderboardRows() {
  const data = getLeaderboardData();
  if (!data) return null;
  const skippedSet = new Set(data.skippedDates ?? []);
  const rows = data.users.map(({ user, runs }) => {
    const series = decodeSeries(runs, data.currentDate, skippedSet);
    let currentStreak = 0;
    let maxStreak = 0;
    let streak = 0;
    let totalDays = 0;
    let totalSolves = 0;
    for (const { score } of series) {
      if (score > 0) {
        streak += 1;
        maxStreak = Math.max(maxStreak, streak);
        totalDays += 1;
        totalSolves += score;
      } else {
        streak = 0;
      }
    }
    currentStreak = streak;
    const latestScore = series.at(-1)?.score ?? 0;
    return { user, currentStreak, maxStreak, totalDays, totalSolves, latestScore, series };
  });
  rows.sort(
    (a, b) =>
      b.currentStreak - a.currentStreak ||
      b.maxStreak - a.maxStreak ||
      b.totalDays - a.totalDays ||
      b.totalSolves - a.totalSolves ||
      a.user.localeCompare(b.user),
  );
  return { ...data, rows };
}
