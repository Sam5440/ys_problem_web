import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packTar, ustarEntryBlock, buildBitsStdcxx, listTopLevelCppHeaders, listCHeaders, planSysrootEntries } from '../../scripts/lib/sysroot-pack.mjs';

/** 与 shared.js 同规则的极简 GNU-tar 解析（仅用于校验自家产物）。 */
function* readEntries(buf) {
  let off = 0;
  while (off + 512 <= buf.length) {
    const name = buf.toString('binary', off, off + 100).replace(/\0.*$/, '');
    const size = parseInt(buf.toString('binary', off + 124, off + 136).replace(/\0.*$/, ''), 8);
    const type = buf.toString('binary', off + 156, off + 157);
    const magic = buf.toString('binary', off + 257, off + 265);
    if (magic !== 'ustar  \0' && magic !== 'ustar  ') break;
    if (!name && type !== '0') break;
    if (!name) {
      off += 512;
      continue;
    }
    if (type === '5') {
      yield { name, type, size: 0, data: null };
      off += 512;
    } else {
      const data = buf.subarray(off + 512, off + 512 + size);
      yield { name, type, size, data };
      off += 512 + size;
      off = (off + 511) & ~511;
    }
  }
}

test('ustarEntryBlock: 目录 typeflag=5、文件=0、GNU magic、校验和可解析', () => {
  const dirBlock = ustarEntryBlock({ path: 'include/wasm32-wasip1', dir: true });
  assert.equal(dirBlock.toString('binary', 156, 157), '5');
  assert.equal(dirBlock.toString('binary', 257, 265), 'ustar  \0');
  const fileBlock = ustarEntryBlock({ path: 'a/b.txt', data: new Uint8Array([1, 2, 3]) });
  assert.equal(fileBlock.toString('binary', 156, 157), '0');
  assert.equal(parseInt(fileBlock.toString('binary', 124, 136).replace(/\0.*$/, ''), 8), 3);
});

test('packTar: 父目录先于文件、可被浏览器同款规则解析、512 对齐', () => {
  const entries = [
    { path: 'include', dir: true },
    { path: 'include/x.h', data: new Uint8Array(700).fill(65) },
    { path: 'lib', dir: true },
    { path: 'lib/libc.a', data: new Uint8Array(10) },
  ];
  const buf = packTar(entries);
  assert.equal(buf.length % 512, 0);
  const parsed = [...readEntries(buf)];
  assert.deepEqual(
    parsed.map((e) => [e.name, e.type]),
    [
      ['include', '5'],
      ['include/x.h', '0'],
      ['lib', '5'],
      ['lib/libc.a', '0'],
    ],
  );
  assert.equal(parsed[1].data.length, 700);
  assert.equal(parsed[1].data[0], 65);
});

test('buildBitsStdcxx: blocklist 生效、产出合法 include 列表', () => {
  const content = buildBitsStdcxx(['algorithm', 'vector', 'execution'], ['cstdio', 'csetjmp'], ['execution', 'csetjmp']);
  assert.match(content, /#include <algorithm>/);
  assert.match(content, /#include <cstdio>/);
  assert.doesNotMatch(content, /#include <execution>/);
  assert.doesNotMatch(content, /#include <csetjmp>/);
  assert.match(content, /bits\/stdc\+\+\.h/);
});

test('listTopLevelCppHeaders/listCHeaders: 排除 __ 内部头与带扩展名文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cppv1-'));
  for (const f of ['algorithm', 'vector', '__tuple', 'string.h', 'cstdio.h', 'ciso646', 'stdexcept.txt']) {
    fs.writeFileSync(path.join(dir, f), '');
  }
  assert.deepEqual(listTopLevelCppHeaders(dir), ['algorithm', 'ciso646', 'vector']);
  assert.deepEqual(listCHeaders(dir), ['cstdio.h']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('planSysrootEntries: 每个文件的祖先目录都先出现、entry 预算生效', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sysroot-'));
  const mk = (p) => {
    fs.mkdirSync(path.join(root, p), { recursive: true });
  };
  const wf = (p, s = 'x') => {
    fs.writeFileSync(path.join(root, p), s);
  };
  mk('include/wasm32-wasip1');
  wf('include/wasm32-wasip1/stdio.h');
  mk('include/wasm32-wasip1/noeh/c++/v1');
  wf('include/wasm32-wasip1/noeh/c++/v1/iostream', 'iostream-real');
  mk('include/wasm32-wasip1/noeh/c++/v1/bits');
  mk('lib/clang/22/include');
  wf('lib/clang/22/include/stddef.h');
  mk('lib/wasm32-wasip1/noeh');
  wf('lib/wasm32-wasip1/crt1.o', 'crt');
  wf('lib/wasm32-wasip1/libc.a', 'c');
  wf('lib/wasm32-wasip1/libm.a', 'm');
  wf('lib/wasm32-wasip1/noeh/libc++.a', 'cpp');
  wf('lib/wasm32-wasip1/noeh/libc++abi.a', 'abi');
  wf('builtins.a', 'rt');

  const entries = planSysrootEntries({
    sysrootDir: root,
    clangIncludeDir: path.join(root, 'lib/clang/22/include'),
    clangrtFile: path.join(root, 'builtins.a'),
    bitsHeader: '#include <algorithm>\n',
  });
  const names = entries.map((e) => e.path);
  const idx = (n) => names.indexOf(n);
  assert.ok(idx('include') < idx('include/wasm32-wasip1/stdio.h'));
  assert.ok(idx('include/wasm32-wasip1/noeh/c++/v1') < idx('include/wasm32-wasip1/noeh/c++/v1/iostream'));
  assert.ok(names.includes('include/wasm32-wasip1/noeh/c++/v1/bits/stdc++.h'));
  assert.ok(names.includes('lib/wasm32-wasip1/libclang_rt.builtins.a'));
  // 目录 entry 必须存在（memfs 需要父目录节点）
  assert.ok(entries.find((e) => e.path === 'include/wasm32-wasip1/noeh/c++/v1/bits' && e.dir));
  assert.throws(
    () =>
      planSysrootEntries({
        sysrootDir: root,
        clangIncludeDir: path.join(root, 'lib/clang/22/include'),
        clangrtFile: path.join(root, 'builtins.a'),
        bitsHeader: 'x',
        maxEntries: 3,
      }),
    /超过 memfs 预算/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});
