#!/usr/bin/env node
/**
 * Build-time data bootstrap + public exports. Used by vercel.json's
 * buildCommand (and `npm run build`) so that:
 *
 *   - the deploy branch (production) already carries data → straight to the
 *     exports, zero network;
 *   - data-less checkouts (main, feature branches, fresh clones) self-heal by
 *     downloading the deploy branch's data snapshot from GitHub codeload, so
 *     preview builds and local builds work without a full upstream sync.
 *
 * codeload instead of `git fetch`: Vercel build checkouts cannot reliably
 * fetch other refs from origin (their clone's remote/credentials are scoped),
 * while codeload tarballs are anonymous HTTP for public repos. Private forks
 * must set DATA_REPO + provide their own fetch path.
 *
 * Exports (scripts/write-public-data.mjs) are generated in every case: the
 * slim /archive.json + /leaderboard.json + build-info.json consumed by the
 * client-side pages.
 */
import { createWriteStream, existsSync } from 'node:fs';
import { rename, rm, mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { git } from './lib/git-plumbing.mjs';

/** Sam5440/ys_problem_web from origin URL, with sensible fallbacks. */
async function repoSlug() {
  if (process.env.DATA_REPO) return process.env.DATA_REPO;
  const url = (await git(['remote', 'get-url', 'origin'], { check: false })).stdout;
  const m = url.match(/github\.com[/:]([^/]+)\/([^/.#]+)/i);
  if (m) return `${m[1]}/${m[2]}`;
  return 'Sam5440/ys_problem_web';
}

async function downloadDataSnapshot() {
  const slug = await repoSlug();
  const url = `https://codeload.github.com/${slug}/tar.gz/refs/heads/deploy`;
  console.log(`prepare-build: data/daily.json missing — downloading deploy snapshot from ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`codeload HTTP ${res.status}`);
  const tgz = path.join(await mkdtemp(path.join(tmpdir(), 'ysp-data-')), 'deploy.tar.gz');
  await pipeline(res.body, createWriteStream(tgz));
  // extract inside the repo (same filesystem → rename never hits EXDEV); the
  // tarball root is `<repo>-<ref>/` — member patterns can't be used portably
  // with --strip-components, so extract fully and move the two data dirs over
  const workdir = path.resolve('.prepare-build-data');
  await rm(workdir, { recursive: true, force: true });
  await mkdir(workdir, { recursive: true });
  await new Promise((resolve, reject) => {
    execFile('tar', ['-xzf', tgz, '-C', workdir], { cwd: process.cwd() }, (err, _so, se) => {
      if (err) reject(new Error(`tar extract failed: ${String(se).slice(-200)}`));
      else resolve();
    });
  });
  const { readdir } = await import('node:fs/promises');
  const root = path.join(workdir, (await readdir(workdir))[0]);
  try {
    await rename(path.join(root, 'data'), 'data');
    await rename(path.join(root, 'public', 'ci-logs'), path.join('public', 'ci-logs'));
  } catch (e) {
    throw new Error(`moving snapshot data into place failed: ${e.message}`);
  }
  await rm(workdir, { recursive: true, force: true });
  await rm(path.dirname(tgz), { recursive: true, force: true });
  if (!existsSync('data/daily.json')) throw new Error('snapshot extracted but data/daily.json still missing');
  console.log('prepare-build: data + public/ci-logs restored from deploy snapshot');
}

async function main() {
  if (!existsSync('data/daily.json')) {
    try {
      await downloadDataSnapshot();
    } catch (e) {
      throw new Error(
        `prepare-build: no local data and deploy snapshot download failed (${e.message}). ` +
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
