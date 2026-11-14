import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeSkippedDates, parseRecordsJs, recordsSignature } from '../../lib/records.js';
import * as syncLib from '../lib/leaderboard.mjs';

const FIXTURE = `let records = \`
current_date:2026-10-08
skipped_dates:y2026,m07,,13,,14,m08,,01
alice:2,3/1,2/0,1
bob:2,5/
1,2,3:0,4
\`;`;

test('parseRecordsJs decodes current_date, skipped_dates and run-length users', () => {
  const r = parseRecordsJs(FIXTURE);
  assert.equal(r.currentDate, '2026-10-08');
  assert.deepEqual(r.skippedDates, ['2026-07-13', '2026-07-14', '2026-08-01']);
  assert.equal(r.users.length, 3);
  assert.deepEqual(r.users[0], { user: 'alice', runs: [[2, 3], [1, 2], [0, 1]] });
  assert.deepEqual(r.users[1], { user: 'bob', runs: [[2, 5]] });
  // numeric usernames must survive the key:value split
  assert.deepEqual(r.users[2], { user: '1,2,3', runs: [[0, 4]] });
});

test('parseRecordsJs rejects a file without date or users', () => {
  assert.throws(() => parseRecordsJs('current_date:2026-10-08\nnothing:here'), /users/);
  assert.throws(() => parseRecordsJs('alice:1,2\n'), /current_date/);
});

test('decodeSkippedDates walks year/month tokens', () => {
  assert.deepEqual(decodeSkippedDates('y2024,m03,,01,,15,m04,,02'), [
    '2024-03-01',
    '2024-03-15',
    '2024-04-02',
  ]);
  assert.deepEqual(decodeSkippedDates(''), []);
});

test('recordsSignature ignores generatedAt-style extra fields', () => {
  const base = { currentDate: '2026-10-08', skippedDates: [], users: [{ user: 'a', runs: [[1, 1]] }] };
  assert.equal(recordsSignature(base), recordsSignature({ ...base, generatedAt: 'x' }));
  assert.notEqual(recordsSignature(base), recordsSignature({ ...base, currentDate: '2026-10-09' }));
});

test('sync lib re-exports the same browser-safe implementations', () => {
  assert.equal(syncLib.parseRecordsJs, parseRecordsJs);
  assert.equal(syncLib.decodeSkippedDates, decodeSkippedDates);
  assert.equal(syncLib.recordsSignature, recordsSignature);
});

test('parseRecordsJs handles the real upstream file shape end to end', () => {
  // Rebuild a records.js-shaped file from the local snapshot and exercise the
  // full parse to guard against format drift.
  const snapshot = JSON.parse(readFileSync('data/leaderboard.json', 'utf8'));
  const r = parseRecordsJs(
    `let records = \`\ncurrent_date:${snapshot.currentDate}\nskipped_dates:y2024,m01,,01\n` +
      snapshot.users.map((u) => `${u.user}:${u.runs.map((r) => r.join(',')).join('/')}`).join('\n') +
      '\n`;',
  );
  assert.equal(r.currentDate, snapshot.currentDate);
  assert.equal(r.users.length, snapshot.users.length);
});
