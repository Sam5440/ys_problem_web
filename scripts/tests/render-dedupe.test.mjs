import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dedupeMathPreview, renderRich } from '../../lib/render.js';

const T = (tex) => '$$$' + tex + '$$$';

test('trims a leaked MathJax preview copy before the math token', () => {
  assert.equal(dedupeMathPreview(`a row of n${T('n')} lanterns`), `a row of ${T('n')} lanterns`);
  assert.equal(dedupeMathPreview(`from 1${T('1')} to n${T('n')},`), `from ${T('1')} to ${T('n')},`);
});

test('maps TeX to the plain form CF rendered before it', () => {
  assert.equal(dedupeMathPreview(`(1≤t≤104${T('1 \\le t \\le 10^4')})`), `(${T('1 \\le t \\le 10^4')})`);
  assert.equal(dedupeMathPreview(`modulo 109+7${T('10^9 + 7')}.`), `modulo ${T('10^9 + 7')}.`);
  assert.equal(dedupeMathPreview(`all ai${T('a_i')} and bi${T('b_i')}`), `all ${T('a_i')} and ${T('b_i')}`);
  assert.equal(dedupeMathPreview(`and n−1${T('n-1')} edges`), `and ${T('n-1')} edges`);
  assert.equal(dedupeMathPreview(`are {4,6,12}${T('\\{4, 6, 12\\}')}, so`), `are ${T('\\{4, 6, 12\\}')}, so`);
  assert.equal(dedupeMathPreview(`[1,2] →${T('\\to')} [1]`), `[1,2] ${T('\\to')} [1]`);
});

test('keeps math glued to a word — could be a real prefix like "min"', () => {
  assert.equal(dedupeMathPreview(`the word min${T('n')} stays`), `the word min${T('n')} stays`);
  assert.equal(dedupeMathPreview(`MEX${T('x')} stays`), `MEX${T('x')} stays`);
  assert.equal(dedupeMathPreview(`value 2^n${T('n')} stays`), `value 2^n${T('n')} stays`);
});

test('leaves non-matching prefixes and odd tokens alone', () => {
  assert.equal(dedupeMathPreview(`text ${T('n')} stays`), `text ${T('n')} stays`);
  assert.equal(dedupeMathPreview(`set a_i${T('i')} stays`), `set a_i${T('i')} stays`);
  assert.equal(dedupeMathPreview(`1${T(' 到 ')} 2 stays`), `1${T(' 到 ')} 2 stays`);
  assert.equal(dedupeMathPreview('lone $$$ stays'), 'lone $$$ stays');
  assert.equal(dedupeMathPreview('no math here'), 'no math here');
});

test('renderRich dedupes statements but never touches code fences', () => {
  const html = renderRich(`Enegue has a row of n${T('n')} lanterns`);
  assert.equal(html.match(/zs-math/g)?.length, 1, 'one math token per variable, not two');
  const fenced = renderRich('before n' + T('n') + ' after\n\n```cpp\nint n' + T('n') + ' = 1;\n```\n');
  assert.ok(fenced.includes('int n' + T('n')), 'code fence content untouched');
});
