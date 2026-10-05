/**
 * Branch layout of the data model (see README「仓库与分支模型」):
 *
 *   main                 code only — no data, no CI logs
 *   data/problems        statements + translations, PERMANENT history
 *   data/misc-YYYY-MM-DD leaderboard / CI logs / sync markers, one branch per
 *                        UTC day, ROLLING 60-day retention (pruned daily)
 *   deploy               code + full data snapshot, single orphan commit,
 *                        force-pushed — the branch Vercel builds
 */
import { git } from './git-plumbing.mjs';

export const PROBLEMS_BRANCH = 'data/problems';
export const MISC_PREFIX = 'data/misc-';
export const DEPLOY_BRANCH = 'deploy';
export const RETENTION_DAYS = 60;

/** Paths owned by each data branch (worktree-relative). */
export const PROBLEMS_PATHS = ['data/statements'];
export const MISC_PATHS = [
  'data/leaderboard.json',
  'data/.upstream-sha',
  'data/.leaderboard-sha',
  'data/.history-backfill-failed.json',
  'public/ci-logs',
];
/** Paths layered on top of the code tree to form the deploy snapshot. */
export const DEPLOY_PATHS = ['data/daily.json', 'data/leaderboard.json', 'data/statements', 'public/ci-logs'];

export const utcToday = (now = new Date()) => now.toISOString().slice(0, 10);

export const miscBranchName = (dateIso) => `${MISC_PREFIX}${dateIso}`;

/** 'data/misc-2026-10-05' -> '2026-10-05' (null when not a misc branch). */
export function parseMiscBranch(ref) {
  const m = ref.replace(/^refs\/heads\//, '').match(/^data\/misc-(\d{4}-\d{2}-\d{2})$/);
  return m ? m[1] : null;
}

export function daysBetween(fromIso, toIso) {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

/** Misc branches older than RETENTION_DAYS relative to `todayIso`. */
export function selectExpiredMiscBranches(refs, todayIso, retentionDays = RETENTION_DAYS) {
  return refs
    .map((r) => {
      const date = parseMiscBranch(r);
      return date ? { ref: r.replace(/^refs\/heads\//, ''), date, age: daysBetween(date, todayIso) } : null;
    })
    .filter((e) => e && e.age > retentionDays)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** All remote heads as Map<branchName, sha>. */
export async function listRemoteBranches() {
  const { stdout } = await git(['ls-remote', '--heads', 'origin'], { check: false });
  const out = new Map();
  for (const line of stdout.split('\n')) {
    const [sha, ref] = line.split('\t');
    if (sha && ref) out.set(ref.replace(/^refs\/heads\//, ''), sha);
  }
  return out;
}

/** Latest (max-date) misc branch name, or null when none exists yet. */
export function latestMiscBranch(branchNames) {
  let best = null;
  for (const name of branchNames) {
    const date = parseMiscBranch(name);
    if (date && (!best || date > best.date)) best = { name, date };
  }
  return best ? best.name : null;
}
