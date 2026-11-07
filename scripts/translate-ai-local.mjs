#!/usr/bin/env node
/**
 * 本地批量 AI 翻译回填 —— scripts/translate-ai.mjs 的多平台高并发本地版。
 *
 * 与 CI 版的差异：
 * - 多平台并行：data/translate-platforms.json 配置多个 OpenAI 兼容平台
 *   （baseUrl/key/model/label/enabled），每个平台独立并发、独立限流闸门、
 *   独立统计，共享同一条任务队列——任一平台被限流/配额耗尽时其余平台照常
 *   推进。无配置文件时回退 .env.local 单平台（向后兼容）；
 * - 走遍全部 data/statements/*.json（daily.json 最新优先，未收录文件字典序兜底），
 *   不设 60 段预算，把存量未翻译内容一次清空；
 * - 批量请求：一个请求携带多段（默认 ≤6 段 / ≤3000 字符，超长段独占请求），
 *   用【第k段】编号标记切分回包、逐段占位校验，请求数降为 1/4~1/6；
 * - 自适应并发（AIMD，每平台独立）：连续成功缓慢上调、429 减半，自动逼近限流阈值；
 * - 韧性（每平台独立）：429/5xx/网络错误指数退避重试；配额/限流耗尽进入
 *   侦察兵闸门（首个撞限的任务持有闸门、周期性重试自己的真实请求，成功即
 *   开闸且结果直接交付）；批量回包结构失败自动降批；仅该平台的连续大量失败
 *   才把该平台下线，其余平台继续；断点续传——已含 ai 译文的段自动跳过；
 * - 实时进度：逐段日志（带平台名）+ 周期状态行 + data/translate-ai-local.progress.json。
 *
 * 缓存纪律：SYSTEM_PROMPT 全平台字节级一致（基础提示词 + 术语对照表垫厚到
 * ~1700 token——实测类 OpenAI 网关前缀缓存有 ~1024 token 门槛，短前缀永不命中）；
 * 批前每平台发纯 system 探针落盘缓存单元（AI_WARM_CACHE=0 跳过）。
 *
 * CLI：--stats 只统计；--limit N 限量；--file CODE 只翻指定题面（试跑用）；
 *   --batch N 每请求最多段数（默认 6）；--max-concurrency N（每平台上限，默认 40）；
 *   --start-concurrency N（默认 12）。
 */
import { readFile, writeFile, rename, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { protectMath, restoreMath } from '../lib/mt-protect.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA_FILE = path.join(ROOT, 'data', 'daily.json');
const STATEMENTS_DIR = path.join(ROOT, 'data', 'statements');
const PROGRESS_FILE = path.join(ROOT, 'data', 'translate-ai-local.progress.json');
const PLATFORMS_FILE = path.join(ROOT, 'data', 'translate-platforms.json');

// ---------- 平台配置 ----------
function loadEnvFile(p) {
  try {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {}
}
loadEnvFile(path.join(ROOT, '.env.local'));

async function loadPlatforms() {
  try {
    const j = JSON.parse(await readFile(PLATFORMS_FILE, 'utf8'));
    const list = (j.platforms || []).filter((p) => p && p.baseUrl && p.key && p.model);
    if (list.length) return list;
    console.error('translate-platforms.json 存在但没有有效平台（缺 baseUrl/key/model）');
  } catch {} // 无配置文件 → 回退 .env.local 单平台
  const base = (process.env.AI_BASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.AI_API_KEY || '').trim();
  if (!base || !key) return [];
  return [{ name: 'default', baseUrl: base, key, model: process.env.AI_MODEL || 'glm-5.3', label: (process.env.AI_MODEL_LABEL || '').trim(), enabled: true }];
}

// ---------- CLI ----------
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : null;
};
const STATS_ONLY = argv.includes('--stats');
const LIMIT = Number(argOf('--limit') || Infinity);
const ONLY_FILE = (argOf('--file') || '').toLowerCase().replace(/\.json$/, '');
const MAX_CONC = Math.max(1, Number(argOf('--max-concurrency') || 40));
const START_CONC = Math.min(MAX_CONC, Math.max(1, Number(argOf('--start-concurrency') || 12)));
const MAX_BATCH_SEGS = Math.max(1, Number(argOf('--batch') || 6));
const BATCH_CHAR_BUDGET = 3000;
const SOLO_CHARS = 2200;
const WARM_CACHE = process.env.AI_WARM_CACHE !== '0';

const MAX_ATTEMPTS = 8;
const TIMEOUT_MS = 120000;
const CONSEC_FAIL_ABORT = 40; // 单平台连续 40 任务失败才下线该平台
const SCALE_DOWN_COOLDOWN = 5000;
const QUOTA_PAUSE_MS = 75 * 1000; // 滴漏桶稳态试探间隔
const QUOTA_FIRST_WAIT_MS = 60 * 1000; // 首探等待
const QUOTA_PROBES = 96; // 60s + 95×75s ≈ 最长连续等待 2 小时（试探全是真实请求，零浪费）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => n.toLocaleString('en-US');
const hhmmss = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const foldFullwidthDigits = (s) => s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0));
const readCached = (u) =>
  Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);

// 与各平台共享的提示词：基础提示词字节不变 + 术语对照表垫厚（过 ~1024 token
// 前缀缓存门槛，且长尾术语译法全文统一）。所有平台所有请求共用这段前缀。
const SYSTEM_PROMPT_BASE =
  '你是专业的算法竞赛题面翻译器，把用户文本翻译成简体中文。' +
  '术语遵循算法竞赛惯例：greedy=贪心、dp=DP、binary search=二分、graph=图、' +
  'tree=树、string=字符串、math=数学、constructive=构造、interactive=交互、' +
  'bitmask=状压、flow=网络流、matching=匹配。' +
  '[M00]、[M01]…[M99] 这类占位符代表被保护的原文片段（公式/行内代码/图片/链接），' +
  '必须逐字符原样保留，不得翻译、改写、增删；总数保持不变，位置可随译文语序调整。' +
  '示例——输入：Please print the answer modulo [M00]. 输出：请输出答案对 [M00] 取模的结果。' +
  '人名与专有名词可保留原文。只输出译文，不要任何解释。';
const GLOSSARY_PAIRS = [
  'bubble sort=冒泡排序', 'selection sort=选择排序', 'insertion sort=插入排序', 'merge sort=归并排序',
  'quick sort=快速排序', 'heap sort=堆排序', 'counting sort=计数排序', 'radix sort=基数排序', 'bucket sort=桶排序',
  'array=数组', 'stack=栈', 'queue=队列', 'deque=双端队列', 'linked list=链表', 'hash table=哈希表',
  'hash set=哈希集合', 'heap=堆', 'priority queue=优先队列', 'segment tree=线段树', 'Fenwick tree=树状数组',
  'binary indexed tree=树状数组', 'sparse table=稀疏表', 'suffix array=后缀数组', 'suffix automaton=后缀自动机',
  'suffix tree=后缀树', 'trie=字典树', 'balanced binary search tree=平衡二叉搜索树', 'treap=树堆',
  'splay tree=伸展树', 'skip list=跳表', 'union-find=并查集', 'disjoint set union=并查集',
  'monotonic stack=单调栈', 'monotonic queue=单调队列', 'bitset=位集',
  'vertex=顶点', 'edge=边', 'node=节点', 'directed graph=有向图', 'undirected graph=无向图',
  'weighted graph=带权图', 'DAG=有向无环图', 'topological sort=拓扑排序', 'shortest path=最短路径',
  'Dijkstra algorithm=Dijkstra 算法', 'Bellman-Ford=Bellman-Ford', 'Floyd-Warshall=Floyd-Warshall',
  'minimum spanning tree=最小生成树', 'Prim algorithm=Prim 算法', 'Kruskal algorithm=Kruskal 算法',
  'connectivity=连通性', 'strongly connected component=强连通分量', 'bridge=桥', 'articulation point=割点',
  'Euler tour=欧拉环游', 'Hamiltonian path=哈密顿路径', 'bipartite graph=二分图', 'matching=匹配',
  'Hungarian algorithm=匈牙利算法', 'maximum flow=最大流', 'minimum cut=最小割', 'Dinic algorithm=Dinic 算法',
  'cost flow=费用流', 'lowest common ancestor=最近公共祖先', 'tree diameter=树的直径', 'tree centroid=树的重心',
  'heavy-light decomposition=重链剖分', 'virtual tree=虚树', 'in-degree=入度', 'out-degree=出度',
  'subtree=子树', 'leaf=叶子', 'root=根', 'path=路径', 'cycle=环', 'self-loop=自环', 'multi-edge=重边',
  'knapsack problem=背包问题', 'longest common subsequence=最长公共子序列', 'longest increasing subsequence=最长上升子序列',
  'interval dp=区间 DP', 'digit dp=数位 DP', 'tree dp=树形 DP', 'probability dp=概率 DP',
  'state compression=状态压缩', 'rolling array=滚动数组', 'memoization=记忆化搜索',
  'substring=子串', 'prefix=前缀', 'suffix=后缀', 'palindrome=回文', 'Manacher algorithm=Manacher 算法',
  'KMP algorithm=KMP 算法', 'Z-function=Z 函数', 'Aho-Corasick=AC 自动机', 'string hashing=字符串哈希',
  'rolling hash=滚动哈希', 'minimal representation=最小表示法', 'lexicographically=字典序上',
  'greatest common divisor=最大公约数', 'least common multiple=最小公倍数', 'modular arithmetic=模运算',
  'modular inverse=模逆元', 'fast power=快速幂', 'matrix multiplication=矩阵乘法', 'determinant=行列式',
  'prime number=素数', 'composite number=合数', 'sieve of eratosthenes=埃拉托斯特尼筛法',
  'Euler function=欧拉函数', 'Möbius function=莫比乌斯函数', 'Chinese remainder theorem=中国剩余定理',
  'primitive root=原根', 'discrete logarithm=离散对数', 'combinatorics=组合数学', 'binomial coefficient=二项式系数',
  'Catalan number=卡特兰数', 'Stirling number=斯特林数', 'inclusion-exclusion principle=容斥原理',
  'Gaussian elimination=高斯消元', 'FFT=FFT', 'NTT=NTT', 'convolution=卷积', 'xor convolution=异或卷积',
  'convex hull=凸包', 'rotating calipers=旋转卡壳', 'half-plane intersection=半平面交', 'closest pair=最近点对',
  'scan line=扫描线', 'computational geometry=计算几何', 'cross product=叉积', 'dot product=点积',
  'greedy algorithm=贪心算法', 'binary search the answer=二分答案', 'ternary search=三分搜索',
  'divide and conquer=分治', 'centroid decomposition=点分治', 'square root decomposition=分块',
  "Mo's algorithm=莫队算法", 'randomized algorithm=随机化算法', 'simulation=模拟', 'brute force=暴力枚举',
  'pruning=剪枝', 'offline algorithm=离线算法', 'coordinate compression=坐标压缩', 'discretization=离散化',
  'two pointers=双指针', 'sliding window=滑动窗口', 'prefix sum=前缀和', 'difference array=差分数组',
  'expected value=期望', 'variance=方差', 'game theory=博弈论', 'Sprague-Grundy=SG 函数', 'parity=奇偶性',
  'permutation=排列', 'combination=组合', 'sequence=序列', 'subsequence=子序列', 'subarray=子数组',
  'integer=整数', 'positive integer=正整数', 'non-negative integer=非负整数', 'even number=偶数',
  'odd number=奇数', 'divisor=约数', 'multiple=倍数', 'remainder=余数', 'quotient=商', 'absolute value=绝对值',
  'bitwise AND=按位与', 'bitwise OR=按位或', 'bitwise XOR=按位异或', 'left shift=左移', 'right shift=右移',
  'binary representation=二进制表示', 'binary string=01 串', 'digit sum=数位和', 'most significant bit=最高位',
  'least significant bit=最低位', 'popcount=二进制中 1 的个数', 'overflow=溢出', 'precision=精度',
  'time limit=时间限制', 'memory limit=内存限制', 'test case=测试用例', 'sample input=输入样例',
  'sample output=输出样例', 'constraint=约束条件', 'guaranteed=保证', 'note that=注意',
  'non-decreasing=非递减', 'non-increasing=非递增', 'strictly increasing=严格递增', 'strictly decreasing=严格递减',
  'distinct=互不相同', 'optimal=最优的', 'minimum possible=可能的最小值', 'maximum possible=可能的最大值',
  'query=查询', 'update operation=更新操作', 'range update=区间更新', 'point update=单点更新',
  'range query=区间查询', 'swap=交换', 'reverse=翻转', 'rotate=旋转', 'insert=插入', 'delete=删除',
  'append=追加', 'concatenate=拼接', 'merge=合并', 'split=拆分', 'count=计数', 'output=输出', 'input=输入',
];
const GLOSSARY = GLOSSARY_PAIRS.join('；');
const SYSTEM_PROMPT =
  SYSTEM_PROMPT_BASE +
  '\n术语对照表（翻译时必须遵守，同一术语全文统一译法）：\n' +
  GLOSSARY +
  '。其余未列出的术语按算法竞赛社区惯例翻译。';

/** { fileObj, segs: [{key, i, text}] }（与 CI 版同逻辑） */
function missingSegments(st) {
  const segs = [];
  if (typeof st.title === 'string' && st.title.trim()) {
    const zh = st.titleZh;
    const hasAi =
      typeof zh === 'object' && zh !== null && typeof zh.ai === 'string' && zh.ai.trim();
    if (!hasAi && typeof zh !== 'string') segs.push({ key: 'title', i: 0, text: st.title });
  }
  for (const [key, list] of Object.entries(st.sections || {})) {
    (list || []).forEach((p, i) => {
      if (typeof p !== 'string' || !p.trim()) return;
      const entry = st.sectionsZh?.[key]?.[i];
      if (typeof entry === 'string') return; // legacy complete translation
      if (entry && typeof entry === 'object' && typeof entry.ai === 'string' && entry.ai.trim()) return;
      segs.push({ key, i, text: p });
    });
  }
  return segs;
}

// ---------- 任务清单：daily.json 最新优先 + statements 目录兜底 ----------
async function buildTasks() {
  const daily = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  const days = [...(daily.days || [])].sort((a, b) => (a.date < b.date ? 1 : -1));
  const seen = new Set();
  const order = [];
  for (const day of days) {
    for (const problem of day.problems || []) {
      const code = problem.code?.toLowerCase();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      order.push(code);
    }
  }
  for (const f of (await readdir(STATEMENTS_DIR)).sort()) {
    if (!f.endsWith('.json')) continue;
    const code = f.slice(0, -5).toLowerCase();
    if (!seen.has(code)) order.push(code);
  }

  const tasks = [];
  for (const code of order) {
    if (ONLY_FILE && code !== ONLY_FILE) continue;
    const file = path.join(STATEMENTS_DIR, `${code}.json`);
    let st;
    try {
      st = JSON.parse(await readFile(file, 'utf8'));
    } catch {
      continue; // 无题面文件
    }
    for (const seg of missingSegments(st)) {
      tasks.push({ code: st.code || code, file, key: seg.key, i: seg.i, text: seg.text });
    }
  }
  return { tasks, filesScanned: order.length };
}

// ---------- 每平台客户端 ----------
function httpError(status, body, res) {
  const err = new Error(`HTTP ${status}: ${body.slice(0, 150)}`);
  err.status = status;
  const ra = Number(res?.headers?.get('retry-after'));
  if (Number.isFinite(ra) && ra > 0) err.retryAfterMs = ra * 1000;
  return err;
}

function makePlatform(cfg) {
  const base = cfg.baseUrl.replace(/\/+$/, '');
  return {
    name: cfg.name || new URL(base).host,
    baseUrl: base,
    key: cfg.key,
    model: cfg.model,
    label: (cfg.label || '').trim() || cfg.model,
    endpoint: `${/\/v\d+$/.test(base) ? base : `${base}/v1`}/chat/completions`,
    batchMax: MAX_BATCH_SEGS,
    conc: START_CONC,
    peakConc: START_CONC,
    usage: { ok: 0, fail: 0, in: 0, out: 0, cached: 0 },
    okTimes: [], // 成功时间戳环形缓冲（供「最近10分钟成功次数」滑动窗口统计）
    lastOkAt: null,
    hits429: 0,
    retries: 0,
    batchOk: 0,
    batchStruct: 0,
    quotaPauses: 0,
    quotaDead: false,
    dead: false,
    deadReason: null,
    consecutiveFails: 0,
    warmup: null,
    inFlight: 0,
    last429At: 0,
    // 配额闸门（侦察兵模式）状态
    quotaResumer: null,
    quotaGate: Promise.resolve(),
    quotaGivenUp: false,
  };
}

async function requestChat(plat, messages, { maxTokens, timeoutMs = TIMEOUT_MS, allowEmpty = false } = {}) {
  const res = await fetch(plat.endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${plat.key}` },
    body: JSON.stringify({
      model: plat.model,
      temperature: 0.1,
      reasoning: false, // 支持的平台借此关推理提速；不支持的忽略之
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      messages,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw httpError(res.status, await res.text(), res);
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content?.trim() ?? null;
  if (!out && !allowEmpty) {
    const err = new Error('empty response');
    err.status = 502;
    throw err;
  }
  const u = data.usage || {};
  return {
    out,
    usage: {
      in: Number(u.prompt_tokens ?? 0),
      out: Number(u.completion_tokens ?? 0),
      cached: readCached(u),
    },
  };
}

/** 单段翻译（与 CI 版行为一致）。 */
async function translateOnce(plat, text) {
  const { masked, stash } = protectMath(text);
  const { out, usage } = await requestChat(plat, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: masked },
  ]);
  const restored = restoreMath(out, stash);
  if (!restored) {
    const err = new Error('placeholder mangled');
    err.status = 422;
    throw err;
  }
  return { text: restored, usage };
}

const structural = (msg) => {
  const err = new Error(msg);
  err.status = 422;
  err.structural = true;
  return err;
};

/** 批量翻译：N 段编号【第k段】打包一个请求，回包按标记切分、逐段占位校验。 */
async function translateBatch(plat, texts) {
  const prot = texts.map((t) => protectMath(t));
  const lines = [
    `请把下面 ${texts.length} 段文本逐段翻译成简体中文。`,
    `每段以单独一行【第k段】标记开头（k = 1…${texts.length}）；输出必须包含全部 ${texts.length} 个标记【第1段】…【第${texts.length}段】，每个标记后跟该段译文，顺序与输入一致，不得合并、省略或增删段落。`,
    '[M00]、[M01]… 这类占位符必须逐字符原样保留，不得翻译、改写、增删。只输出带标记的译文，不要任何解释。',
    '',
  ];
  prot.forEach((p, k) => {
    lines.push(`【第${k + 1}段】`);
    lines.push(p.masked);
  });
  const { out, usage } = await requestChat(plat, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: lines.join('\n') },
  ]);

  const re = /【\s*第\s*([0-9０-９]+)\s*段\s*】/g;
  const marks = [];
  let m;
  while ((m = re.exec(out))) marks.push({ k: Number(foldFullwidthDigits(m[1])), start: m.index + m[0].length, markStart: m.index });
  if (marks.length !== texts.length) throw structural(`回包标记数 ${marks.length} ≠ ${texts.length}`);
  const parts = new Array(texts.length).fill(null);
  for (let j = 0; j < marks.length; j++) {
    const { k, start, markStart } = marks[j];
    if (k < 1 || k > texts.length || parts[k - 1] !== null) throw structural(`回包标记序号异常（第 ${j + 1} 个标记 k=${k}）`);
    const end = j + 1 < marks.length ? marks[j + 1].markStart : out.length;
    const raw = out.slice(start, end).trim();
    const restored = raw ? restoreMath(raw, prot[k - 1].stash) : null;
    parts[k - 1] = restored ? { text: restored } : null;
  }
  return { parts, usage };
}

/** 先建缓存（预热）：纯 system 探针把 SYSTEM_PROMPT 落盘成缓存单元。 */
async function warmCache(plat) {
  const probes = [
    { mode: 'system-only', messages: [{ role: 'system', content: SYSTEM_PROMPT }] },
    {
      mode: 'system+user',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: '开始。' },
      ],
    },
  ];
  for (let i = 0; i < probes.length; i++) {
    try {
      const { usage: u } = await requestChat(plat, probes[i].messages, { maxTokens: 1, timeoutMs: 30000, allowEmpty: true });
      plat.warmup = { ok: true, mode: probes[i].mode, in: u.in, cached: u.cached };
      console.log(`  [${plat.name}] 缓存预热（${probes[i].mode}）ok: in=${u.in} cached=${u.cached}`);
      return;
    } catch (e) {
      if (i === probes.length - 1) {
        plat.warmup = { ok: false, mode: null, in: 0, cached: 0 };
        console.warn(`  [${plat.name}] 缓存预热失败（${e.message}）——缓存改靠端点自动前缀检测落盘。`);
      }
    }
  }
}

// ---------- 主流程 ----------
async function main() {
  const platformCfgs = (await loadPlatforms()).filter((p) => p.enabled !== false);
  if (!platformCfgs.length) {
    console.error('没有启用的翻译平台（translate-platforms.json 或 .env.local）——退出。');
    process.exit(1);
  }
  const platforms = platformCfgs.map(makePlatform);

  const { tasks, filesScanned } = await buildTasks();
  const total = Math.min(tasks.length, isFinite(LIMIT) ? LIMIT : tasks.length);
  const workload = tasks.slice(0, total);

  console.log('════════ 本地 AI 翻译回填（多平台） ════════');
  console.log(`扫描 ${filesScanned} 个题面文件 · 待翻译 ${workload.length} 段 · 每请求最多 ${MAX_BATCH_SEGS} 段 · 并发 ${START_CONC}→${MAX_CONC}/平台（自适应）`);
  for (const p of platforms) console.log(`  ▸ 平台 ${p.name} · ${p.model} · ${p.endpoint}`);
  if (!workload.length) {
    console.log('没有需要翻译的内容，全部已是 ai 渠道覆盖。');
    return;
  }
  if (STATS_ONLY) {
    console.log(`--stats：共 ${workload.length} 段。未执行翻译。`);
    return;
  }

  // 全局聚合统计（done/ok/fail 由平台统计汇总）
  const agg = { startedAt: Date.now(), done: 0, ok: 0, fail: 0 };
  const successSegs = [];
  const pushSuccess = (n) => { for (let k = 0; k < n; k++) successSegs.push(Date.now()); };
  const recentRate = () => {
    const cutoff = Date.now() - 120000;
    while (successSegs.length && successSegs[0] < cutoff) successSegs.shift();
    return successSegs.length / 120;
  };
  const recomputeAgg = () => {
    agg.done = agg.ok = agg.fail = 0;
    for (const p of platforms) { agg.done += p.usage.ok + p.usage.fail; agg.ok += p.usage.ok; agg.fail += p.usage.fail; }
  };

  // 题面对象缓存：文件首任务载入、末任务落盘后释放
  const stCache = new Map();
  const refCount = new Map();
  const saveChains = new Map();
  const scheduleSave = (file) => {
    const prev = saveChains.get(file) || Promise.resolve();
    const next = prev.then(async () => {
      const st = stCache.get(file);
      if (!st) return;
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(st, null, 2) + '\n');
      await rename(tmp, file);
    });
    saveChains.set(file, next);
  };
  const releaseFile = async (file) => {
    if (refCount.get(file) > 0) return;
    try { await saveChains.get(file); } catch {}
    stCache.delete(file);
    saveChains.delete(file);
  };
  for (const t of workload) refCount.set(t.file, (refCount.get(t.file) || 0) + 1);

  const applyTranslation = (t, text) => {
    let st = stCache.get(t.file);
    if (!st) {
      st = JSON.parse(readFileSync(t.file, 'utf8'));
      stCache.set(t.file, st);
    }
    st.sectionsZh ||= {};
    if (t.key === 'title') {
      st.titleZh = typeof st.titleZh === 'object' && st.titleZh !== null ? st.titleZh : {};
      st.titleZh.ai = text;
      st.titleZh.aiModel = platLabelOf(t);
    } else {
      st.sectionsZh[t.key] ||= [];
      const entry =
        st.sectionsZh[t.key][t.i] && typeof st.sectionsZh[t.key][t.i] === 'object'
          ? st.sectionsZh[t.key][t.i]
          : {};
      entry.ai = text;
      entry.aiModel = platLabelOf(t);
      st.sectionsZh[t.key][t.i] = entry;
    }
  };
  // 译文归属平台：任务对象在领取时打上平台标记
  const platLabelOf = (t) => (t.plat ? t.plat.label : '');

  // AIMD（每平台）
  const on429 = (p) => {
    p.hits429 += 1;
    const now = Date.now();
    if (now - p.last429At >= SCALE_DOWN_COOLDOWN && p.conc > 2) {
      p.conc = Math.max(2, Math.floor(p.conc / 2));
      p.last429At = now;
    }
  };
  const onSuccess = (p) => {
    p.consecutiveFails = 0;
    if (p.usage.ok % 8 === 0 && p.conc < MAX_CONC) {
      p.conc += 1;
      p.peakConc = Math.max(p.peakConc, p.conc);
    }
  };
  const killPlatform = (p, reason) => {
    if (p.dead) return;
    p.dead = true;
    p.deadReason = reason;
    console.error(`⚠ [${p.name}] 平台下线：${reason}`);
  };

  const statusLine = (tag) => {
    recomputeAgg();
    const elapsed = Date.now() - agg.startedAt;
    const rate = recentRate();
    const remaining = total - agg.done;
    const eta = rate > 0.01 && remaining > 0 ? hhmmss((remaining / rate) * 1000) : '—';
    console.log(
      `${tag} ${hhmmss(elapsed)} ▸ ${fmt(agg.done)}/${fmt(total)} (${total ? ((agg.done / total) * 100).toFixed(1) : '0.0'}%) ✓${fmt(agg.ok)} ✗${agg.fail} ▸ 近2分钟 ${rate.toFixed(2)} 段/s → ETA ${eta} ▸ tokens in=${fmt(platforms.reduce((s, p) => s + p.usage.in, 0))} out=${fmt(platforms.reduce((s, p) => s + p.usage.out, 0))} cached=${fmt(platforms.reduce((s, p) => s + p.usage.cached, 0))}`,
    );
    for (const p of platforms) {
      const state = p.dead ? `已下线（${p.deadReason}）` : p.quotaResumer ? '⛔配额等待' : '运行中';
      console.log(
        `   ${p.dead ? '✝' : '▸'} [${p.name}] ${p.model} · 并发 ${p.conc}（峰值 ${p.peakConc}）批${p.batchOk}↓${p.batchStruct} · ✓${fmt(p.usage.ok)} ✗${p.usage.fail} · 429×${p.hits429} · ${state}`,
      );
    }
  };
  const writeProgress = () => {
    recomputeAgg();
    const payload = {
      pid: process.pid,
      total,
      done: agg.done,
      ok: agg.ok,
      fail: agg.fail,
      startedAt: new Date(agg.startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
      recentRatePerSec: Number(recentRate().toFixed(3)),
      finishedAt: platforms.every((p) => p.dead) || agg.done >= total ? new Date().toISOString() : null,
      platforms: platforms.map((p) => {
        // 滑动窗口：先剪掉 10 分钟外的时间戳再计数，顺带控制内存
        const cutoff = Date.now() - 600000;
        p.okTimes = p.okTimes.filter((t) => t > cutoff);
        return {
          name: p.name, model: p.model, label: p.label,
          conc: p.conc, peakConc: p.peakConc, batchOk: p.batchOk, batchStruct: p.batchStruct,
          ok: p.usage.ok, fail: p.usage.fail, in: p.usage.in, out: p.usage.out, cached: p.usage.cached,
          ok10m: p.okTimes.length, lastOkAt: p.lastOkAt ? new Date(p.lastOkAt).toISOString() : null,
          hits429: p.hits429, retries: p.retries, quotaPauses: p.quotaPauses,
          quotaWaiting: !!p.quotaResumer, quotaDead: p.quotaDead, dead: p.dead, deadReason: p.deadReason,
        };
      }),
    };
    writeFile(PROGRESS_FILE, JSON.stringify(payload, null, 2) + '\n').catch(() => {});
  };
  const statusTimer = setInterval(() => { statusLine('⏱'); writeProgress(); }, 30000);

  // 重试壳（每平台独立闸门与计数）
  const isQuotaErr = (e) => /quota|rate.?limit/i.test(e?.message ?? '');
  async function enterQuotaPause(p, scoutFn) {
    if (p.quotaResumer) {
      await p.quotaGate; // 跟随者：等侦察兵开闸
      return null;
    }
    let release;
    p.quotaGate = new Promise((r) => (release = r));
    p.quotaResumer = release;
    p.quotaPauses += 1;
    try {
      for (let i = 1; i <= QUOTA_PROBES && !p.dead; i++) {
        // 滴漏式回血的桶要小口高频试探：试探本身就是真实翻译请求，成功即交付，
        // 间隔越短接住的回血容量越多（429 拒绝不计费）。
        const wait = i === 1 ? QUOTA_FIRST_WAIT_MS : QUOTA_PAUSE_MS;
        console.warn(`⛔ [${p.name}] 配额/限流耗尽——该平台暂停发请求，约 ${Math.round(wait / 6000) / 10} 分钟后由侦察兵重试真实请求（第 ${i}/${QUOTA_PROBES} 次）…`);
        await sleep(wait);
        if (p.dead) return null;
        try {
          const value = await scoutFn();
          p.conc = Math.min(p.conc, 2); // 恢复后低并发起步，AIMD 回升
          console.log(`✅ [${p.name}] 配额已恢复（侦察兵真实请求成功），继续翻译（并发回落到 2，自适应回升）。`);
          return { value };
        } catch (e2) {
          if (!isQuotaErr(e2)) {
            console.log(`✅ [${p.name}] 端点已恢复（非配额错误），继续翻译。`);
            return { err: e2 };
          }
          console.warn(`⛔ [${p.name}] 仍配额耗尽（已累计等待约 ${((QUOTA_FIRST_WAIT_MS + (i - 1) * QUOTA_PAUSE_MS) / 60000).toFixed(1)} 分钟）`);
        }
      }
      p.quotaDead = !p.dead;
      if (p.quotaDead) console.error(`⛔ [${p.name}] 配额连续约 2 小时未恢复——该平台快速失败直至下线；其余平台不受影响。`);
      p.quotaGivenUp = p.quotaDead;
      return null;
    } finally {
      const r = p.quotaResumer;
      p.quotaResumer = null;
      if (r) r();
    }
  }

  async function withRetry(p, fn) {
    for (let attempt = 0; ;) {
      if (p.dead) {
        const e = new Error('platform dead');
        e.aborted = true;
        throw e;
      }
      try {
        return await fn();
      } catch (e) {
        if (e.aborted || e.structural || e.status === 401 || e.status === 403) throw e;
        if (isQuotaErr(e)) {
          if (p.quotaGivenUp) throw e;
          const r = await enterQuotaPause(p, fn);
          if (r) {
            if (r.err) throw r.err;
            return r.value; // 侦察兵成功的那次真实翻译直接采用
          }
          await sleep(Math.random() * 4000); // 开闸放行后错峰
          continue;
        }
        if (attempt >= MAX_ATTEMPTS) throw e;
        attempt += 1;
        if (e.status === 429) on429(p);
        p.retries += 1;
        const delay = e.retryAfterMs ?? Math.min(30000, 1200 * 2 ** attempt);
        await sleep(delay + Math.random() * 800);
      }
    }
  }

  async function runSingle(p, t) {
    const t0 = Date.now();
    t.plat = p;
    try {
      const { text, usage: u } = await withRetry(p, () => translateOnce(p, t.text));
      applyTranslation(t, text);
      scheduleSave(t.file);
      p.usage.ok += 1;
      p.okTimes.push(Date.now());
      p.lastOkAt = Date.now();
      p.usage.in += u.in;
      p.usage.out += u.out;
      p.usage.cached += u.cached || 0;
      recomputeAgg();
      onSuccess(p);
      pushSuccess(1);
      console.log(
        `✓ [${p.name}] [${fmt(agg.done)}/${fmt(total)}] ${t.code} · ${t.key}[${t.i}] · ${((Date.now() - t0) / 1000).toFixed(1)}s · ${text.slice(0, 44)}… [in=${u.in} out=${u.out} cached=${u.cached || 0}]`,
      );
    } catch (e) {
      if (p.dead) return;
      if (e.status === 401 || e.status === 403) { killPlatform(p, `认证失败（HTTP ${e.status}）——key 无效`); return; }
      p.usage.fail += 1;
      p.consecutiveFails += 1;
      recomputeAgg();
      console.warn(`✗ [${p.name}] ${t.code} · ${t.key}[${t.i}] — ${e.message}（已重试 ${MAX_ATTEMPTS} 次，跳过）`);
      if (p.consecutiveFails >= CONSEC_FAIL_ABORT) killPlatform(p, `连续 ${p.consecutiveFails} 个任务失败——端点持续不可用`);
    }
  }

  async function runChunk(p, chunk) {
    let queue = chunk;
    const fallback = [];
    while (queue.length > 1 && p.batchMax > 1 && !p.dead) {
      const head = queue.slice(0, Math.min(p.batchMax, queue.length));
      const t0 = Date.now();
      let r;
      try {
        r = await withRetry(p, () => translateBatch(p, head.map((t) => t.text)));
      } catch (e) {
        if (p.dead || e.aborted) return;
        if (e.status === 401 || e.status === 403) { killPlatform(p, `认证失败（HTTP ${e.status}）——key 无效`); return; }
        if (e.structural) {
          p.batchMax = Math.max(1, Math.floor(p.batchMax / 2));
          p.batchStruct += 1;
          console.warn(`⚠ [${p.name}] 批量结构失败：${e.message} —— 批量上限降为 ${p.batchMax}，本批转逐段`);
        } else {
          console.warn(`⚠ [${p.name}] 批量请求失败：${e.message} —— 本批转逐段`);
        }
        break;
      }
      head.forEach((t, k) => {
        const part = r.parts[k];
        if (!part) { fallback.push(t); return; }
        t.plat = p;
        applyTranslation(t, part.text);
        scheduleSave(t.file);
        p.usage.ok += 1;
        p.okTimes.push(Date.now());
        p.lastOkAt = Date.now();
        recomputeAgg();
        console.log(`✓ [${p.name}] [${fmt(agg.done)}/${fmt(total)}] ${t.code} · ${t.key}[${t.i}] · 批${head.length} · ${part.text.slice(0, 44)}…`);
      });
      p.usage.in += r.usage.in;
      p.usage.out += r.usage.out;
      p.usage.cached += r.usage.cached;
      p.batchOk += 1;
      onSuccess(p);
      pushSuccess(head.length - fallback.length);
      console.log(`⧗ [${p.name}] 批 ${head.length} 段 · ${((Date.now() - t0) / 1000).toFixed(1)}s · in=${fmt(r.usage.in)} out=${fmt(r.usage.out)} cached=${fmt(r.usage.cached)}${fallback.length ? ` · ${fallback.length} 段校验失败转逐段` : ''}`);
      queue = queue.slice(head.length);
    }
    for (const t of [...fallback, ...queue]) {
      if (p.dead) return;
      await runSingle(p, t);
    }
  }

  // 组批：相邻段合并（同文件天然相邻），超长段独占
  const buildChunks = (ts) => {
    const chunks = [];
    let cur = [];
    let chars = 0;
    const flush = () => { if (cur.length) { chunks.push(cur); cur = []; chars = 0; } };
    for (const t of ts) {
      const solo = t.text.length > SOLO_CHARS;
      if (cur.length && (solo || cur.length >= MAX_BATCH_SEGS || chars + t.text.length > BATCH_CHAR_BUDGET)) flush();
      cur.push(t);
      chars += t.text.length;
      if (solo) flush();
    }
    flush();
    return chunks;
  };

  const chunks = buildChunks(workload);
  let cursor = 0; // 全平台共享任务游标（单线程领取，天然无竞争）
  let settledAll;
  const settled = new Promise((r) => (settledAll = r));
  const activeCount = () => platforms.filter((p) => p.inFlight > 0).length;
  const anyAlive = () => platforms.some((p) => !p.dead);

  function pumpPlatform(p) {
    while (!p.dead && p.inFlight < p.conc && cursor < chunks.length) {
      const chunk = chunks[cursor++];
      p.inFlight += 1;
      runChunk(p, chunk)
        .catch((e) => console.error(`[${p.name}] 任务异常（不应到达）: ${e?.message}`))
        .finally(async () => {
          p.inFlight -= 1;
          for (const file of new Set(chunk.map((t) => t.file))) {
            refCount.set(file, refCount.get(file) - chunk.filter((t) => t.file === file).length);
            await releaseFile(file);
          }
          pumpPlatform(p);
          if (activeCount() === 0 && (cursor >= chunks.length || !anyAlive())) {
            clearInterval(statusTimer);
            settledAll();
          }
        });
    }
    if (p.inFlight === 0 && (!anyAlive() || (cursor >= chunks.length && activeCount() === 0))) {
      clearInterval(statusTimer);
      settledAll();
    }
  }

  // 批前每平台预热缓存（尽力而为，失败不阻塞）
  for (const p of platforms) {
    if (WARM_CACHE) {
      console.log(`[${p.name}] 预热系统提示词缓存（system-only 探针）…`);
      await warmCache(p);
    }
  }

  for (const p of platforms) pumpPlatform(p);
  await settled;
  await Promise.allSettled([...saveChains.values()]);
  writeProgress();

  console.log('════════ 运行结束 ════════');
  for (const p of platforms) {
    if (p.dead) console.error(`⚠ [${p.name}] ${p.deadReason}`);
  }
  statusLine('■');
  const tin = platforms.reduce((s, p) => s + p.usage.in, 0);
  const tout = platforms.reduce((s, p) => s + p.usage.out, 0);
  const tcached = platforms.reduce((s, p) => s + p.usage.cached, 0);
  const cacheRate = tin ? Math.round((tcached / tin) * 100) : 0;
  console.log(`完成 ${agg.ok} 段，失败 ${agg.fail} 段，耗时 ${hhmmss(Date.now() - agg.startedAt)}。`);
  console.log('── AI Token 用量（本次运行，按平台）──');
  for (const p of platforms) {
    console.log(`  [${p.name}] ${p.model} · 成功 ${fmt(p.usage.ok)} / 失败 ${p.usage.fail} · 输入 ${fmt(p.usage.in)} 输出 ${fmt(p.usage.out)} 缓存命中 ${fmt(p.usage.cached)} · 配额暂停 ${p.quotaPauses} 次`);
  }
  console.log(`  合计 输入 ${fmt(tin)} + 输出 ${fmt(tout)} = ${fmt(tin + tout)} tokens（缓存命中率 ${cacheRate}%）`);
  const perPlatform = platforms.map((p) => ({
    name: p.name, model: p.model, label: p.label,
    ok: p.usage.ok, fail: p.usage.fail, in: p.usage.in, out: p.usage.out, cached: p.usage.cached,
    warmup: p.warmup,
  }));
  console.log(`TOKEN-USAGE ${JSON.stringify({ model: platforms.map((p) => p.name).join('+'), ok: agg.ok, fail: agg.fail, in: tin, out: tout, cached: tcached, totalTokens: tin + tout, platforms: perPlatform })}`);
  if (platforms.every((p) => p.dead)) process.exitCode = platforms.every((p) => p.quotaDead || p.deadReason?.includes('配额')) ? 2 : 1;
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
