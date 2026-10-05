#!/usr/bin/env node
/**
 * Build-time data bootstrap + public exports. Used by vercel.json's
 * buildCommand (and `npm run build`) so that:
 *
 *   - the deploy branch (production) already carries data → straight to the
 *     exports, zero network;
 *   - data-less checkouts (main, feature branches, fresh clones) self-heal by
 *     fetching the deploy branch's data snapshot, so preview builds and local
 *     builds work without a full upstream sync.
 *
 * Exports (scripts/write-public-data.mjs) are generated in every case: the
 * slim /archive.json + /leaderboard.json + build-info.json consumed by the
 * client-side pages.
 */
import { existsSync } from 'node:fs';
import { git } from './lib/git-plumbing.mjs';

async function main() {
  if (!existsSync('data/daily.json')) {
    console.log('prepare-build: data/daily.json missing — fetching snapshot from origin/deploy');
    try {
      await git(['fetch', '--depth=1', 'origin', 'deploy']);
      const usable = (await git(['ls-tree', '--name-only', 'FETCH_HEAD', '--', 'data', 'public/ci-logs'], { check: false })).stdout
        .split('\n')
        .filter(Boolean);
      if (!usable.includes('data')) throw new Error('origin/deploy carries no data/ directory');
      await git(['restore', '--source', 'FETCH_HEAD', '--worktree', '--', ...usable]);
      console.log(`prepare-build: restored ${usable.join(', ')}`);
    } catch (e) {
      throw new Error(
        `prepare-build: no local data and origin/deploy fetch failed (${e.message}). ` +
          'Run `npm run data:pull` (or the full `npm run update-data`) first.',
      );
    }
  }
  await import('./write-public-data.mjs');
}

main().catch((e) => {
  console.error('prepare-build failed:', e.message);
  process.exit(1);
});
