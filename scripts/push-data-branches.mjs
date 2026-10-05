#!/usr/bin/env node
/**
 * Commit worktree data onto the data branches and push. Composable flags:
 *
 *   --problems   snapshot data/statements -> data/problems (permanent history)
 *   --misc       snapshot misc paths -> data/misc-<UTC today>. A brand-new day
 *                chains onto the latest surviving misc branch, so history
 *                stays contiguous across the day rollover.
 *   --prune      delete data/misc-* branches older than RETENTION_DAYS
 *
 * Snapshot semantics differ by branch:
 *   - problems is an ADD-ONLY domain, so its snapshot is built as a UNION:
 *     the remote tip's files are overlaid into the worktree first, guaranteeing
 *     a concurrent push is never silently dropped. (Remote wins on shared
 *     files — acceptable, CI runs are serialized by the workflow concurrency
 *     group, so a shared-file race means a rare manual push.)
 *   - misc is a pure SNAPSHOT: files pruned from the worktree (60-day log
 *     retention) must drop out of the branch tip, so nothing is overlaid.
 *     Push races fall through to the reject → overlay → retry path.
 *
 * Every data-only tree carries a vercel.json disabling Vercel deployments for
 * data/* (minimatch) — without it each data push would deploy ~10-30MB of raw
 * JSON as a junk preview site.
 */
import { git, buildTree, commitTree, remoteTree, pushCommit, isNonFastForward } from './lib/git-plumbing.mjs';
import {
  PROBLEMS_BRANCH,
  PROBLEMS_PATHS,
  MISC_PATHS,
  RETENTION_DAYS,
  miscBranchName,
  utcToday,
  listRemoteBranches,
  latestMiscBranch,
  selectExpiredMiscBranches,
} from './lib/data-branches.mjs';

const argv = new Set(process.argv.slice(2));
const runId = process.env.GITHUB_RUN_ID ? ` (run ${process.env.GITHUB_RUN_ID})` : '';

const NO_PREVIEW = {
  'vercel.json': `${JSON.stringify({ git: { deploymentEnabled: { 'data/*': false } } }, null, 2)}\n`,
};

/** Overlay a branch's tracked paths (within `paths`) onto the worktree. */
async function overlayBranchFiles(branch, paths) {
  await git(['fetch', '--depth=1', 'origin', branch]);
  const usable = (await git(['ls-tree', '--name-only', 'FETCH_HEAD', '--', ...paths], { check: false })).stdout
    .split('\n')
    .filter(Boolean);
  if (usable.length) {
    await git(['restore', '--source', 'FETCH_HEAD', '--worktree', '--', ...usable]);
    console.log(`${branch}: overlaid ${usable.join(', ')} from remote tip`);
  }
}

/**
 * Snapshot `paths` onto `branch`.
 * union=true  → overlay remote tip first (add-only domains, e.g. statements)
 * parentBranch → tip to chain onto when `branch` itself does not exist yet
 */
async function pushSnapshot(branch, paths, message, { union = false, parentBranch = null } = {}) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const own = await remoteTree(branch);
    if (own.sha && union) await overlayBranchFiles(branch, paths);
    const parentSha =
      own.sha || (parentBranch && parentBranch !== branch ? (await remoteTree(parentBranch)).sha : null);
    const tree = await buildTree({ paths, extraFiles: NO_PREVIEW });
    if (own.sha && tree === own.tree) {
      console.log(`${branch}: unchanged (tree ${tree.slice(0, 12)}) — nothing to push`);
      return { pushed: false };
    }
    const commit = await commitTree(tree, parentSha ? [parentSha] : [], message);
    try {
      await pushCommit(commit, branch);
      console.log(`${branch}: pushed ${commit.slice(0, 12)}${own.sha ? '' : ' (new branch)'}`);
      return { pushed: true };
    } catch (e) {
      if (!isNonFastForward(e) || attempt === 3) throw e;
      // The branch moved between our ls-remote and the push: overlay their
      // files onto our worktree and retry.
      console.log(`${branch}: remote moved, overlaying remote files and retrying (${attempt}/3)`);
      await overlayBranchFiles(branch, paths);
    }
  }
}

async function pruneMiscBranches() {
  const branches = await listRemoteBranches();
  const expired = selectExpiredMiscBranches([...branches.keys()], utcToday(), RETENTION_DAYS);
  if (!expired.length) {
    console.log(`prune: no data/misc-* branch older than ${RETENTION_DAYS} days`);
    return;
  }
  const refs = expired.map((e) => e.ref);
  await git(['push', 'origin', '--delete', ...refs]);
  console.log(`prune: deleted ${refs.length} expired misc branch(es): ${refs.join(', ')}`);
}

async function main() {
  if (argv.has('--problems')) {
    await pushSnapshot(PROBLEMS_BRANCH, PROBLEMS_PATHS, `data: statements snapshot${runId}`, { union: true });
  }
  if (argv.has('--misc')) {
    const today = miscBranchName(utcToday());
    await pushSnapshot(today, MISC_PATHS, `data: misc snapshot${runId}`, {
      parentBranch: latestMiscBranch([...(await listRemoteBranches()).keys()]),
    });
  }
  if (argv.has('--prune')) {
    await pruneMiscBranches();
  }
}

main().catch((e) => {
  console.error('push-data-branches failed:', e.message);
  process.exit(1);
});
