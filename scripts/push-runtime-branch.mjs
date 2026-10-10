#!/usr/bin/env node
/**
 * Push the browser compiler runtime (public/compiler/) to the permanent
 * `data/runtime` branch as a single orphan snapshot — the same projection
 * model as `deploy`: no history, force-push, unchanged tree skips the push.
 *
 * Runtime binaries are big (~150 MB) and gitignored on main (main stays
 * lean); publish-deploy layers this branch's content into the deploy tree so
 * the site serves them same-origin at /compiler/<file>. That origin hosting
 * is REQUIRED: the upstream GitHub release assets carry no CORS headers, so
 * the browser can only fetch them same-origin.
 *
 * Usage:
 *   npm run runtime:build   # rebuild public/compiler from wasi-sdk (local)
 *   npm run runtime:push    # this script
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { buildTree, commitTree, branchTip, pushCommit } from './lib/git-plumbing.mjs';
import { RUNTIME_BRANCH, RUNTIME_PATHS, NO_PREVIEW_FILES } from './lib/data-branches.mjs';

const EXPECTED = ['clang22', 'clang22-noeh', 'lld22', 'lld22-noeh', 'sysroot22.tar', 'memfs'];

async function main() {
  const dir = RUNTIME_PATHS[0];
  if (!existsSync(dir)) {
    throw new Error(`${dir}/ 缺失 — 先跑 npm run runtime:build 重建运行时`);
  }
  const files = readdirSync(dir).filter((f) => statSync(`${dir}/${f}`).isFile());
  const missing = EXPECTED.filter((f) => !files.includes(f));
  if (missing.length) {
    throw new Error(`${dir} 缺少产物: ${missing.join(', ')} — 重跑 npm run runtime:build`);
  }

  const tree = await buildTree({ base: null, paths: RUNTIME_PATHS, extraFiles: NO_PREVIEW_FILES });
  const { sha, tree: remoteTreeOid } = await branchTip(RUNTIME_BRANCH);
  if (remoteTreeOid && tree === remoteTreeOid) {
    console.log(`runtime: tree unchanged (${tree.slice(0, 12)}) — skipping push`);
    return;
  }
  const commit = await commitTree(tree, [], `runtime: browser compiler runtime snapshot (${files.length} files)`);
  await pushCommit(commit, RUNTIME_BRANCH, { force: true });
  console.log(`runtime: force-pushed orphan ${commit.slice(0, 12)} (tree ${tree.slice(0, 12)}) to ${RUNTIME_BRANCH}${sha ? `, replaced ${sha.slice(0, 12)}` : ''}`);
}

main().catch((e) => {
  console.error('push-runtime-branch failed:', e.message);
  process.exit(1);
});
