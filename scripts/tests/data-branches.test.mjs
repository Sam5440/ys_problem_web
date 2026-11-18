import test from 'node:test';
import assert from 'node:assert/strict';
import {
  miscBranchName,
  parseMiscBranch,
  daysBetween,
  selectExpiredMiscBranches,
  latestMiscBranch,
  RETENTION_DAYS,
} from '../lib/data-branches.mjs';

test('misc branch name round-trips with the date parser', () => {
  assert.equal(miscBranchName('2026-10-05'), 'data/misc-2026-10-05');
  assert.equal(parseMiscBranch('refs/heads/data/misc-2026-10-05'), '2026-10-05');
  assert.equal(parseMiscBranch('data/misc-2026-10-05'), '2026-10-05');
  assert.equal(parseMiscBranch('data/misc-2026-10-05-extra'), null);
  assert.equal(parseMiscBranch('data/misc-20261005'), null);
  assert.equal(parseMiscBranch('data/problems'), null);
  assert.equal(parseMiscBranch('main'), null);
  assert.equal(parseMiscBranch('deploy'), null);
});

test('daysBetween is calendar-day based (UTC)', () => {
  assert.equal(daysBetween('2026-10-01', '2026-10-05'), 4);
  assert.equal(daysBetween('2026-09-30', '2026-10-01'), 1);
  assert.equal(daysBetween('2026-10-05', '2026-10-05'), 0);
});

test('selectExpiredMiscBranches keeps the retention window boundary, drops older', () => {
  const today = '2026-10-05';
  const refs = [
    'refs/heads/data/misc-2026-10-05',
    'refs/heads/data/misc-2026-08-06', // exactly 60 days old — KEEP
    'refs/heads/data/misc-2026-08-05', // 61 days old — drop
    'refs/heads/data/misc-2026-01-01', // ancient — drop
    'refs/heads/main', // not misc — ignore
    'refs/heads/data/problems', // not misc — ignore
  ];
  const expired = selectExpiredMiscBranches(refs, today, RETENTION_DAYS).map((e) => e.ref);
  assert.deepEqual(expired, ['data/misc-2026-01-01', 'data/misc-2026-08-05']);
});

test('selectExpiredMiscBranches returns nothing for an empty repository', () => {
  assert.deepEqual(selectExpiredMiscBranches([], '2026-10-05'), []);
});

test('latestMiscBranch picks the maximum date', () => {
  assert.equal(
    latestMiscBranch(['data/misc-2026-10-01', 'data/misc-2026-10-05', 'data/misc-2026-09-30', 'main', 'deploy']),
    'data/misc-2026-10-05',
  );
  assert.equal(latestMiscBranch(['main', 'data/problems']), null);
  assert.equal(latestMiscBranch([]), null);
});
