/**
 * 更新日志结构不变式（lib/changelog.js 是设置弹窗「更新日志」区块的单一事实来源）。
 * 每条断言都对应 AGENTS.md「更新日志」条的维护规范——新条目加顶部、版本递增、
 * 结构完整；结构性错误在这里报，而不是等设置弹窗渲染出来才发现。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CHANGELOG, APP_VERSION } from "../../lib/changelog.js";

const verTuple = (v) => v.split(".").map(Number);

test("最新条目即当前站点版本（APP_VERSION 与顶部条目永远一致）", () => {
  assert.ok(CHANGELOG.length >= 2, "CHANGELOG 至少要有历史条目可展示");
  assert.equal(APP_VERSION, CHANGELOG[0].version);
});

test("版本号沿列表严格递减且无重复（新条目必须加在顶部）", () => {
  const seen = new Set();
  for (let i = 0; i < CHANGELOG.length; i++) {
    const v = verTuple(CHANGELOG[i].version);
    assert.ok(v.length === 2 && v.every(Number.isInteger), `版本号须为 major.minor：${CHANGELOG[i].version}`);
    assert.ok(!seen.has(CHANGELOG[i].version), `版本重复：${CHANGELOG[i].version}`);
    seen.add(CHANGELOG[i].version);
    if (i > 0) {
      const prev = verTuple(CHANGELOG[i - 1].version);
      const cmp = prev[0] - v[0] || prev[1] - v[1];
      assert.ok(cmp > 0, `条目 ${i - 1}（${CHANGELOG[i - 1].version}）必须新于条目 ${i}（${CHANGELOG[i].version}）`);
    }
  }
});

test("每条结构完整：version/date/title/changes 且日期合法", () => {
  for (const { version, date, title, changes } of CHANGELOG) {
    assert.match(version, /^\d+\.\d+$/, `version 格式：${version}`);
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `date 格式：${version} ${date}`);
    assert.ok(!Number.isNaN(Date.parse(date)), `date 须为真实日期：${version} ${date}`);
    assert.equal(typeof title, "string");
    assert.ok(title.trim().length > 0, `${version} 缺 title`);
    assert.ok(Array.isArray(changes) && changes.length > 0, `${version} 缺 changes`);
    for (const c of changes) {
      assert.equal(typeof c, "string");
      assert.ok(c.trim().length > 0, `${version} 有空要点`);
    }
  }
});

test("日期沿列表不递增（新→旧）", () => {
  for (let i = 1; i < CHANGELOG.length; i++) {
    const prev = Date.parse(CHANGELOG[i - 1].date);
    const cur = Date.parse(CHANGELOG[i].date);
    assert.ok(prev >= cur, `${CHANGELOG[i - 1].version}（${CHANGELOG[i - 1].date}）不得早于 ${CHANGELOG[i].version}（${CHANGELOG[i].date}）`);
  }
});
