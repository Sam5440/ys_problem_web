import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTodayFromReadme } from '../../lib/upstream-readme.mjs';

// Verbatim top of the upstream README as of 2026-10-06.
const REAL_README = `# Daily_CF_Problems

## Main Activities (Daily)

- Update 2 Codeforces problems with different difficulty everyday except Sunday in the file \`daily_problems/\${YYYY}/\${MM}/\${MMDD}/problems.md\` with hints.

## Today's Problem

| Difficulty | Problems | Hints | Solution |
| ---------- | -------- | ----- | -------- |
| *1800 | [GYM101047F](https://codeforces.com/gym/101047/problem/F) | If we fix the Rajasis to hit, what order should we choose? So pre-sort these. | [Editorial](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/main/daily_problems/2026/10/1006/solution/cf101047f.md) |
| *2000 | [GYM103627C](https://codeforces.com/gym/103627/problem/C) | We only need to find one answer. And if you start with one valid solution, you find a simpler one. | [Editorial](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/main/daily_problems/2026/10/1006/solution/cf103627c.md) |
`;

test('parses the real README Today table: codes, links, difficulty, date', () => {
  const parsed = parseTodayFromReadme(REAL_README);
  assert.equal(parsed.date, '2026-10-06');
  assert.deepEqual(
    parsed.problems.map((p) => [p.code, p.difficulty]),
    [
      ['GYM101047F', '*1800'],
      ['GYM103627C', '*2000'],
    ],
  );
  assert.equal(parsed.problems[0].url, 'https://codeforces.com/gym/101047/problem/F');
});

test('3-digit MMDD month dir (e.g. April 5 → /2026/4/405/) parses as 2026-04-05', () => {
  const md = `## Today's Problem

| Difficulty | Problems | Hints |
| ---------- | -------- | ----- |
| *1500 | [CF1234A](https://codeforces.com/problemset/problem/1234/A) | hint text. | [Editorial](https://github.com/Yawn-Sean/Daily_CF_Problems/blob/main/daily_problems/2026/4/405/solution/cf1234a.md) |
`;
  const parsed = parseTodayFromReadme(md);
  assert.equal(parsed.date, '2026-04-05');
  assert.equal(parsed.problems[0].code, 'CF1234A');
});

test('table without an editorial column still yields codes, with date=null', () => {
  const md = `## Today's Problem

| Difficulty | Problems | Hints |
| ---------- | -------- | ----- |
| *2100 | [1900C1](https://codeforces.com/problemset/problem/1900/C1) | hint. |
`;
  const parsed = parseTodayFromReadme(md);
  assert.equal(parsed.date, null);
  assert.equal(parsed.problems.length, 1);
  assert.equal(parsed.problems[0].code, '1900C1');
  assert.equal(parsed.problems[0].difficulty, '*2100');
});

test('returns null when the section or table is missing', () => {
  assert.equal(parseTodayFromReadme('# Daily_CF_Problems\n\nno today section'), null);
  assert.equal(parseTodayFromReadme("## Today's Problem\n\n(no table yet)"), null);
  assert.equal(parseTodayFromReadme(null), null);
  assert.equal(parseTodayFromReadme(42), null);
});
