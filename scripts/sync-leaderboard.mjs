#!/usr/bin/env node
/**
 * Leaderboard-only sync for CI: fetch upstream records.js (gh-pages) and
 * rewrite data/leaderboard.json only when its parsed content actually changed.
 *
 * The workflow runs this when the upstream gh-pages SHA moved but main did not
 * (the records workflow publishes there independently of daily_problems) —
 * a path where the full update-data.mjs pipeline (Playwright, statement
 * fetches, translations) must NOT run. Deliberately dependency-free: it
 * executes before `npm ci` in that path.
 *
 * Exits non-zero on failure so the workflow skips recording the SHA marker,
 * leaving the next run to retry.
 */
import { syncLeaderboardFile } from './lib/leaderboard.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LEADERBOARD_FILE = path.join(ROOT, 'data', 'leaderboard.json');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';

try {
  console.log('Syncing leaderboard (records.js from gh-pages)...');
  const { changed, players, currentDate } = await syncLeaderboardFile(LEADERBOARD_FILE, { token: TOKEN });
  console.log(changed ? `leaderboard updated: ${players} players through ${currentDate}` : 'leaderboard content unchanged');
} catch (e) {
  console.error(`leaderboard sync failed: ${e.message}`);
  process.exit(1);
}
