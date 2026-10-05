#!/usr/bin/env node
/**
 * Restore data files from the data branches into the current worktree.
 * main carries code only; this is how CI bootstraps a data-bearing checkout
 * and how local dev gets a buildable tree (`npm run data:pull`).
 *
 * Sources:
 *   data/statements        <- data/problems      (permanent)
 *   misc files + ci-logs   <- latest data/misc-* (rolling)
 *   data/daily.json        <- deploy             (latest published snapshot)
 *
 * Flags (composable; default = all three):
 *   --misc        markers, leaderboard, ci-logs
 *   --statements  data/statements
 *   --daily       data/daily.json
 *
 * Missing branches are skipped with a notice (first run / fresh fixture).
 * `git restore --source` touches the worktree only — the index stays clean,
 * so nothing ever shows up staged for an accidental commit.
 */
import { git } from './lib/git-plumbing.mjs';
import {
  PROBLEMS_BRANCH,
  DEPLOY_BRANCH,
  listRemoteBranches,
  latestMiscBranch,
  MISC_PATHS,
} from './lib/data-branches.mjs';

const argv = new Set(process.argv.slice(2));
const want = (f) => argv.has(f);
const anyFlag = [...argv].some((a) => a.startsWith('--'));
const wantMisc = want('--misc') || !anyFlag;
const wantStatements = want('--statements') || !anyFlag;
const wantDaily = want('--daily') || !anyFlag;

/** List the tracked top-level/sub paths present in a fetched tree so we only
    restore what that branch actually carries. */
async function treeHas(ref, candidates) {
  const { stdout } = await git(['ls-tree', '--name-only', ref, '--', ...candidates], { check: false });
  const present = new Set(stdout.split('\n').filter(Boolean));
  return candidates.filter((p) => present.has(p));
}

async function restoreFrom(branch, paths, label) {
  await git(['fetch', '--depth=1', 'origin', branch]);
  const fetchHead = (await git(['rev-parse', 'FETCH_HEAD'])).stdout;
  const usable = await treeHas(fetchHead, paths);
  if (!usable.length) {
    console.log(`${label}: branch carries none of ${paths.join(', ')} — nothing restored`);
    return;
  }
  await git(['restore', '--source', fetchHead, '--worktree', '--', ...usable]);
  console.log(`${label}: restored ${usable.join(', ')} from ${branch}`);
}

async function main() {
  const branches = await listRemoteBranches();

  if (wantMisc) {
    const misc = latestMiscBranch([...branches.keys()]);
    if (misc) {
      await restoreFrom(misc, MISC_PATHS, 'misc');
    } else {
      console.log('misc: no data/misc-* branch exists yet — starting cold (markers absent → full sync)');
    }
  }

  if (wantStatements) {
    if (branches.has(PROBLEMS_BRANCH)) {
      await restoreFrom(PROBLEMS_BRANCH, ['data/statements'], 'statements');
    } else {
      console.log(`statements: ${PROBLEMS_BRANCH} does not exist yet — starting cold`);
    }
  }

  if (wantDaily) {
    if (branches.has(DEPLOY_BRANCH)) {
      await restoreFrom(DEPLOY_BRANCH, ['data/daily.json'], 'daily');
    } else {
      console.log(`daily: ${DEPLOY_BRANCH} does not exist yet — update-data will build from scratch`);
    }
  }
}

main().catch((e) => {
  console.error('restore-data failed:', e.message);
  process.exit(1);
});
