#!/usr/bin/env node
/**
 * 补全数据层单测：表结构完整性、签名提示的括号/参数定位、签名参数切分、
 * include 行判定、成员访问判定、Python 前缀路径。
 * 覆盖回归：C++ 静态表裸名化（std:: 前缀导致输入 co 无补全的根因）。
 */
import assert from 'node:assert/strict';
import {
  CPP_FUNCTIONS, CPP_TYPES, CPP_OBJECTS, CPP_MEMBERS, CPP_HEADERS, CPP_KEYWORDS, CPP_SNIPPETS,
  PY_FUNCTIONS, PY_MEMBER_TABLES, PY_TYPE_MEMBERS, PY_KEYWORDS, PY_SNIPPETS,
  signatureLookup, lookupSignature, splitSignatureParams, includeContext,
  cppAccessKind, isCppMemberAccess, pyPrefixPath,
  toSuggestion, keywordSuggestion,
} from '../../lib/compiler/completions.js';

let passed = 0;
let failed = 0;
function check(name, cond, extra = '') {
  if (cond) {
    passed++;
    console.log(`PASS  ${name}`);
  } else {
    failed++;
    console.log(`FAIL  ${name} ${extra}`);
  }
}

/* ---- 表结构完整性 ---- */

for (const [name, table, needSig] of [
  ['CPP_FUNCTIONS', CPP_FUNCTIONS, true],
  ['CPP_TYPES', CPP_TYPES, false],
  ['CPP_OBJECTS', CPP_OBJECTS, false],
  ['CPP_MEMBERS', CPP_MEMBERS, true],
  ['PY_FUNCTIONS', PY_FUNCTIONS, true],
  ['PY_TYPE_MEMBERS', PY_TYPE_MEMBERS, true],
]) {
  check(`${name} 每项有唯一 label`, new Set(table.map((x) => x.label)).size === table.length);
  check(`${name} 每项 label 为合法标识符`, table.every((x) => /^[A-Za-z_][\w]*$|^__\w+$/.test(x.label) || x.label.includes('.')));
  if (needSig) check(`${name} 每项有非空 signature`, table.every((x) => typeof x.signature === 'string' && x.signature.length > 0));
  if (needSig) check(`${name} 每项有 doc`, table.every((x) => typeof x.doc === 'string' && x.doc.length > 0));
}

check('CPP_SNIPPETS/PY_SNIPPETS 模板体含 $ 占位', [...CPP_SNIPPETS, ...PY_SNIPPETS].every((s) => s.body.includes('${')));
check('PY_MEMBER_TABLES 键都以点结尾', Object.keys(PY_MEMBER_TABLES).every((k) => k.endsWith('.')));
check('CPP_HEADERS 无空串且无尖括号', CPP_HEADERS.every((h) => h.length > 0 && !h.includes('<') && !h.includes('>')));
check('C++ 关键词表含 while/int（Monaco 高亮不依赖，仅补全）', CPP_KEYWORDS.includes('while') && CPP_KEYWORDS.includes('int'));
check('PY 关键词表含 def/while', PY_KEYWORDS.includes('def') && PY_KEYWORDS.includes('while'));

// 回归根因：C++ 表必须含裸名 cout/cin/sort（竞赛 using namespace std 形态）
check('C++ 表含裸名 cout/cin/sort（co 前缀可命中）',
  CPP_OBJECTS.some((x) => x.label === 'cout') &&
  CPP_OBJECTS.some((x) => x.label === 'cin') &&
  CPP_FUNCTIONS.some((x) => x.label === 'sort'));

// 关键函数覆盖（2026-10 扩表）：竞赛高频自由函数 / 成员 / 类型 / manipulator
check('CPP_FUNCTIONS 含 memset/freopen/iota/nth_element/set_union',
  ['memset', 'freopen', 'iota', 'nth_element', 'set_union'].every((l) => CPP_FUNCTIONS.some((x) => x.label === l)));
check('CPP_FUNCTIONS 含 iomanip 三件套（setprecision/setw/setfill）',
  ['setprecision', 'setw', 'setfill'].every((l) => CPP_FUNCTIONS.some((x) => x.label === l)));
check('CPP_FUNCTIONS 含位运算内建（popcount/ctz/clz）',
  ['__builtin_popcount', '__builtin_ctzll', '__builtin_clz'].every((l) => CPP_FUNCTIONS.some((x) => x.label === l)));
check('CPP_MEMBERS 含 contains/emplace/lower_bound/ignore/flush',
  ['contains', 'emplace', 'lower_bound', 'ignore', 'flush'].every((l) => CPP_MEMBERS.some((x) => x.label === l)));
check('CPP_TYPES 含 greater/__int128', CPP_TYPES.some((x) => x.label === 'greater') && CPP_TYPES.some((x) => x.label === '__int128'));
check('CPP_OBJECTS 含 fixed/stdin', CPP_OBJECTS.some((x) => x.label === 'fixed') && CPP_OBJECTS.some((x) => x.label === 'stdin'));
check('CPP_HEADERS 含 iomanip', CPP_HEADERS.includes('iomanip'));

/* ---- signatureLookup ---- */

{
  const T = [
    { label: 'sort', signature: 'void sort(RandomIt first, RandomIt last, Compare comp = {})' },
    { label: 'push_back', signature: 'void push_back(const T& value)' },
    { label: 'print', signature: "print(*objects, sep=' ', end='\\n')" },
  ];
  let hit = signatureLookup('vector<int> v; sort(', [T]);
  check('刚开括号：命中 sort，activeParameter=0', hit?.match.label === 'sort' && hit.activeParameter === 0);

  hit = signatureLookup('sort(a, ', [T]);
  check('一层逗号后：activeParameter=1', hit?.match.label === 'sort' && hit.activeParameter === 1);

  hit = signatureLookup('sort(v.begin(), v.end(), ', [T]);
  check('嵌套括号内逗号不计：activeParameter=2', hit?.match.label === 'sort' && hit.activeParameter === 2);

  hit = signatureLookup('v.push_back(', [T]);
  check('成员调用取尾段命中 push_back', hit?.match.label === 'push_back');

  hit = signatureLookup("print('a, b', ", [T]);
  check('字符串内逗号不计：activeParameter=1', hit?.match.label === 'print' && hit.activeParameter === 1);

  hit = signatureLookup('foo(bar), sort(x', [T]);
  check('多个括号取最近未闭合', hit?.match.label === 'sort' && hit.activeParameter === 0);

  hit = signatureLookup('int x = 1;', [T]);
  check('无未闭合括号返回 null', hit === null);

  hit = signatureLookup('unknown_fn(', [T]);
  check('表外函数返回 null', hit === null);

  hit = signatureLookup('v.push_back(', [T]);
  check('成员调用 isMember=true', hit?.isMember === true);

  hit = signatureLookup('sort(a, ', [T]);
  check('裸调用 isMember=false', hit?.isMember === false);

  hit = signatureLookup('std::sort(', [T]);
  check('命名空间调用 isMember=true', hit?.isMember === true);
}

/* ---- lookupSignature 成员/裸名消歧 ---- */

{
  // 同名异义：count 在自由函数表与成员表都存在，语义不同
  const FREE = [{ label: 'count', signature: 'ptrdiff_t count(InputIt first, InputIt last, const T& value)' }];
  const MEMBER = [{ label: 'count', signature: 'size_type count(const Key& key) const' }];

  let hit = lookupSignature('    v.count(', [FREE], [MEMBER]);
  check('v.count( 命中成员表签名', hit?.match.signature.startsWith('size_type count(const Key'), JSON.stringify(hit?.match));

  hit = lookupSignature('    count(', [FREE], [MEMBER]);
  check('裸 count( 命中自由函数表签名', hit?.match.signature.startsWith('ptrdiff_t count('), JSON.stringify(hit?.match));

  hit = lookupSignature('    v.sort(', [[{ label: 'sort', signature: 'void sort(RandomIt first, RandomIt last)' }]], [[{ label: 'sort', signature: 'void sortmember()' }]]);
  check('成员调用优先成员表（同 label 双表语义消歧）', hit?.match.signature === 'void sortmember()', JSON.stringify(hit?.match));

  hit = lookupSignature('    v.map(', [[{ label: 'map', signature: 'OutputIt map(InputIt first, InputIt last, Fun f)' }]], []);
  check('成员表未命中回落自由函数表', hit?.match.label === 'map');

  const PY_MEMBER = Object.values(PY_MEMBER_TABLES);
  hit = lookupSignature('heapq.heappush(', [PY_FUNCTIONS], [...PY_MEMBER, PY_TYPE_MEMBERS]);
  check('heapq.heappush( 命中模块成员签名', hit?.match.label === 'heappush');

  hit = lookupSignature('print(', [PY_FUNCTIONS], [...PY_MEMBER, PY_TYPE_MEMBERS]);
  check('裸 print( 命中内置函数签名', hit?.match.label === 'print');

  hit = lookupSignature('    a.sort(', [PY_FUNCTIONS], [...PY_MEMBER, PY_TYPE_MEMBERS]);
  check('list.sort( 命中类型成员签名（key/reverse）', hit?.match.signature.includes('key=None'), JSON.stringify(hit?.match));
}

/* ---- splitSignatureParams ---- */

{
  const { namePart, params } = splitSignatureParams('void sort(RandomIt first, RandomIt last, Compare comp = {})');
  check('sort 切出 3 个参数', params.length === 3, JSON.stringify(params));
  check('参数 label 是签名子串', params.every((p) => 'void sort(RandomIt first, RandomIt last, Compare comp = {})'.includes(p.label)));

  const r2 = splitSignatureParams("print(*objects, sep=' ', end='\\n')");
  check("print 引号内逗号不切：3 参数", r2.params.length === 3, JSON.stringify(r2.params));

  const r3 = splitSignatureParams('void f(std::pair<int, int> a, int b)');
  check('模板尖括号内逗号不切', r3.params.length === 2, JSON.stringify(r3.params));
  check('无括号签名（对象项）切出 0 参数', splitSignatureParams('std::ostream cout').params.length === 0);
}

/* ---- includeContext ---- */

check('#include < 开头 → <', includeContext('#include <') === '<');
check('#include <io → <', includeContext('#include <io') === '<');
check('#include <iostream>（已闭合）→ null', includeContext('#include <iostream>') === null);
check('#include "loc → "', includeContext('#include "loc') === '"');
check('普通代码行 → null', includeContext('    cout << x < y;') === null);
check('无 include 的 < 表达式 → null', includeContext('a < b') === null);

/* ---- isCppMemberAccess ---- */

check('a. → true', isCppMemberAccess('    v.', 7) === true);
check('a-> → true', isCppMemberAccess('    it->', 9) === true);
check('a:: → true', isCppMemberAccess('    std::', 10) === true);
check('部分词 v.pu → true（剥部分词，成员上下文逐键保持）', isCppMemberAccess('    v.pu', 9) === true);
check('长部分词 v.push_bac → true', isCppMemberAccess('    v.push_bac', 15) === true);
check('链式 a.b.c → true', isCppMemberAccess('    a.b.c', 10) === true);
check('数字尾标识符 x1. → true', isCppMemberAccess('    x1.', 8) === true);
check('全局作用域 :: → true', isCppMemberAccess('    ::', 7) === true);
check('普通词中 → false', isCppMemberAccess('    cout', 8) === false);
check('箭头部分词 it->pu → true', isCppMemberAccess('    it->pu', 10) === true);
check('比较 > → false', isCppMemberAccess('    if (a >', 12) === false);
check('case 标签冒号 → false', isCppMemberAccess('    case 1:', 12) === false);
check('label 冒号 → false', isCppMemberAccess('public:', 8) === false);
check('浮点字面量 1.5 → false', isCppMemberAccess('    1.5', 8) === false);
check('移出成员后 v.size() → false', isCppMemberAccess('    v.size();', 13) === false);
check('流输出 cout << x → false', isCppMemberAccess('    cout << x', 14) === false);

/* ---- cppAccessKind 三态（isCppMemberAccess 的细化） ---- */

check('v. → dot', cppAccessKind('    v.', 7) === 'dot');
check('it-> → arrow', cppAccessKind('    it->', 9) === 'arrow');
check('std:: → scope', cppAccessKind('    std::', 10) === 'scope');
check('std::so → scope（剥部分词逐键保持）', cppAccessKind('    std::so', 13) === 'scope');
check('全局 :: → scope', cppAccessKind('    ::', 7) === 'scope');
check('链式 a.b. → dot', cppAccessKind('    a.b.', 9) === 'dot');
check('嵌套 ns::Inner:: → scope', cppAccessKind('    ns::Inner::', 16) === 'scope');
check('case 1: → null', cppAccessKind('    case 1:', 12) === null);
check('label 冒号 → null', cppAccessKind('public:', 8) === null);
check('三元单冒号 a ? b : → null', cppAccessKind('    x = a ? b :', 16) === null);
check('比较 > → null', cppAccessKind('    if (a >', 12) === null);
check('isCppMemberAccess 与三态一致（dot/arrow/scope 均 true）',
  [cppAccessKind('    v.', 7), cppAccessKind('    it->', 9), cppAccessKind('    std::', 10)].every((k) => k !== null)
  && isCppMemberAccess('    cout << x', 14) === false);

/* ---- pyPrefixPath ---- */

check('heapq. 前缀识别', pyPrefixPath('import heapq\nheapq.', 20) === 'heapq.');
check('math. 前缀识别', pyPrefixPath('    math.sqrt', 10) === 'math.');
check('普通词无前缀', pyPrefixPath('    sprint', 10) === '');
check('未注册模块也识别出路径（交由通用成员兜底）', pyPrefixPath("    x = 'a.", 12) === 'a.');

/* ---- toSuggestion / keywordSuggestion 形状 ---- */

{
  const mon = {
    languages: {
      CompletionItemKind: { Keyword: 12, Function: 1, Class: 7, Variable: 6, Method: 0 },
      CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
    },
  };
  const fn = CPP_FUNCTIONS.find((f) => f.label === 'sort');
  const s = toSuggestion(mon, fn, 1, { sortBoost: '1', range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 3 } });
  check('函数项：insertText 是 snippet、带 InsertAsSnippet 规则', s.insertText === 'sort(${1:first}, ${2:last})' && s.insertTextRules === 4);
  check('函数项：sortText 前缀提升 + range 透传', s.sortText === '1sort' && s.range?.startColumn === 1);
  check('函数项：documentation 是 markdown（含 cpp fence + doc）', typeof s.documentation?.value === 'string' && s.documentation.value.includes('```cpp') && s.documentation.value.includes('排序'));

  const kw = keywordSuggestion(mon, 'while', null);
  check('关键词项：kind Keyword、无 snippet 规则', kw.kind === 12 && kw.insertTextRules === undefined);

  const py = toSuggestion(mon, PY_FUNCTIONS[0], 1, { lang: 'python' });
  check('Python 项：文档 fence 为 python', py.documentation.value.includes('```python'));
}

console.log(`\n==== 补全数据层单测: ${passed} 通过, ${failed} 失败 ====`);
process.exit(failed ? 1 : 0);
