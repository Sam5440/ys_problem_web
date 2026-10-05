#!/usr/bin/env node
/**
 * Assemble the `deploy` branch — the fixed publish branch Vercel builds —
 * and force-push it as a SINGLE ORPHAN commit:
 *
 *   deploy tree = HEAD tree (code from main) + data/daily.json
 *                 + data/leaderboard.json + data/statements + public/ci-logs
 *
 * deploy is a pure projection of (main code, data/problems, latest data/misc-*,
 * generated daily.json): it keeps no history, never conflicts, and any
 * clobbering push is self-healed by the next hourly run. An unchanged tree
 * skips the push so Vercel does not rebuild identical snapshots.
 */
import { buildTree, commitTree, branchTip, pushCommit } from './lib/git-plumbing.mjs';
import { DEPLOY_BRANCH, DEPLOY_PATHS } from './lib/data-branches.mjs';

const runId = process.env.GITHUB_RUN_ID ? ` (run ${process.env.GITHUB_RUN_ID})` : '';

async function main() {
  const tree = await buildTree({ base: 'HEAD', paths: DEPLOY_PATHS });
  const { sha, tree: remoteTreeOid } = await branchTip(DEPLOY_BRANCH);
  if (remoteTreeOid && tree === remoteTreeOid) {
    console.log(`deploy: tree unchanged (${tree.slice(0, 12)}) — skipping push`);
    return;
  }
  const commit = await commitTree(tree, [], `deploy: site snapshot${runId}`);
  await pushCommit(commit, DEPLOY_BRANCH, { force: true });
  console.log(`deploy: force-pushed orphan ${commit.slice(0, 12)} (tree ${tree.slice(0, 12)})${sha ? `, replaced ${sha.slice(0, 12)}` : ''}`);
}

main().catch((e) => {
  console.error('publish-deploy failed:', e.message);
  process.exit(1);
});
