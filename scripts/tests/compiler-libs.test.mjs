import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeCase, normalizeOutput, truncate } from '../../lib/compiler/diff.js';
import {
  loadCpSettings,
  saveCpSettings,
  loadDraft,
  saveDraft,
  clearDraft,
  draftKey,
  CP_DEFAULTS,
} from '../../lib/compiler/cp-settings.js';

function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test('normalizeOutput: 去 \\r、行尾空白、文末空行', () => {
  assert.deepEqual(normalizeOutput('a \r\n b\r\n\r\n\n'), ['a', ' b']);
  assert.deepEqual(normalizeOutput(''), []);
  assert.deepEqual(normalizeOutput('x\n'), ['x']);
});

test('judgeCase: AC 与 WA（含首个差异行定位）', () => {
  assert.equal(judgeCase('1 2\n3', '1 2\n3 \n\n').verdict, 'AC');
  const wa = judgeCase('1\n2\n3', '1\n5\n3');
  assert.equal(wa.verdict, 'WA');
  assert.equal(wa.diff.line, 2);
  assert.equal(wa.diff.expected, '2');
  assert.equal(wa.diff.actual, '5');
  const short = judgeCase('a\nb', 'a');
  assert.equal(short.verdict, 'WA');
  assert.equal(short.diff.actual, '<无输出>');
});

test('truncate: 超长截断', () => {
  assert.equal(truncate('ab', 10), 'ab');
  assert.match(truncate('x'.repeat(50), 10), /截断/);
});

test('cp-settings: 默认值 + 保存合并 + 模板持久化', () => {
  const store = memStorage();
  assert.equal(loadCpSettings(store).defaultLang, 'cpp');
  assert.equal(loadCpSettings(store).cppStd, 'c++20');
  const next = saveCpSettings({ defaultLang: 'python', templates: { cpp: 'X' } }, store);
  assert.equal(next.defaultLang, 'python');
  assert.equal(next.templates.cpp, 'X');
  // 未覆盖的 python 模板保留默认
  assert.equal(next.templates.python, CP_DEFAULTS.templates.python);
  assert.equal(loadCpSettings(store).templates.cpp, 'X');
  // 坏 JSON 不炸
  store.setItem('ysc-cp-settings-v1', '{bad json');
  assert.equal(loadCpSettings(store).defaultLang, 'cpp');
});

test('cp-settings: 草稿读写与清除', () => {
  const store = memStorage();
  assert.equal(loadDraft('CF1000A', 'cpp', store), null);
  saveDraft('CF1000A', 'cpp', 'int main(){}', store);
  assert.equal(loadDraft('CF1000A', 'cpp', store), 'int main(){}');
  assert.equal(draftKey('CF1000A', 'cpp'), 'ysc-cp-draft-CF1000A-cpp');
  clearDraft('CF1000A', 'cpp', store);
  assert.equal(loadDraft('CF1000A', 'cpp', store), null);
});
