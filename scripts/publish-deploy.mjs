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
import { existsSync, readdirSync } from 'node:fs';
import { buildTree, commitTree, branchTip, pushCommit } from './lib/git-plumbing.mjs';
import { DEPLOY_BRANCH, DEPLOY_PATHS } from './lib/data-branches.mjs';

const runId = process.env.GITHUB_RUN_ID ? ` (run ${process.env.GITHUB_RUN_ID})` : '';

async function main() {
  // Guards: a deploy missing daily.json breaks the Vercel build outright, and
  // one missing statements silently empties /logs/ai-demo — both mean a
  // restore step was skipped or the problems branch is empty. Refuse rather
  // than publish a degraded snapshot (an incident on 2026-10-05 shipped a
  // statements-less deploy exactly this way).
  if (!existsSync('data/daily.json')) {
    throw new Error('data/daily.json missing — run `node scripts/restore-data.mjs --daily` first');
  }
  if (!existsSync('data/statements') || readdirSync('data/statements').length === 0) {
    throw new Error('data/statements missing or empty — run `node scripts/restore-data.mjs --statements` first');
  }
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
