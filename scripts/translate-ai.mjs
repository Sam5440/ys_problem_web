/**
 * AI translation of the newest statements via any OpenAI-compatible chat
 * completions endpoint (GitHub Secrets: AI_BASE_URL / AI_API_KEY, optional
 * AI_MODEL, default deepseek-v4-flash).
 *
 * Newest-first walk over data/daily.json; for every statement segment that
 * has no `ai` entry yet, requests a translation and merges it into the
 * statement file's sectionsZh / titleZh as the `ai` channel — the site's
 * 对照 chain picks it up as a last resort after the four MT channels.
 * Idempotent: covered segments are skipped, so repeated runs only translate
 * what is new. AI_TRANSLATE_LIMIT caps the per-run segment budget.
 *
 * DeepSeek 上下文硬盘缓存纪律（docs: api-docs.deepseek.com/guides/kv_cache）：
 * 缓存全自动、按前缀完整匹配——只有请求开头一段与此前「落盘成单元」的前缀
 * 完全一致的部分才按缓存价计费。因此 SYSTEM_PROMPT 必须是所有请求共享的
 * 同一段字节级不变的开头消息，每次只有尾部 user 消息变化；warmCache() 在
 * 批量开始前发一条纯 system 探针请求，让「用户输入结束」的请求边界正好落在
 * 系统提示词末尾，把它立即落盘成缓存单元（先建缓存），之后每个分段请求的
 * 这段前缀都命中缓存价。请求保持串行，且 system 之前不得插入任何变化内容，
 * 否则前缀匹配即断。AI_WARM_CACHE=0 可跳过预热。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { protectMath, restoreMath } from '../lib/mt-protect.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const DATA_FILE = path.join(ROOT, 'data', 'daily.json');
const STATEMENTS_DIR = path.join(ROOT, 'data', 'statements');

const BASE_URL = (process.env.AI_BASE_URL || '').trim().replace(/\/+$/, '');
const API_KEY = (process.env.AI_API_KEY || '').trim();
const MODEL = process.env.AI_MODEL || 'deepseek-v4-flash';
const LIMIT = Number(process.env.AI_TRANSLATE_LIMIT || 60);
const WARM_CACHE = process.env.AI_WARM_CACHE !== '0';
const MAX_CONSECUTIVE_FAILS = 5;
const TIMEOUT_MS = 120000;
const WARM_TIMEOUT_MS = 30000;
const DELAY_MS = 300;

const endpoint = () =>
  `${/\/v\d+$/.test(BASE_URL) ? BASE_URL : `${BASE_URL}/v1`}/chat/completions`;

// 所有请求共享的唯一可缓存前缀。protectMath 会把公式/行内代码/图片/链接
// 打码成零填充的 [M07] 式占位符，模型实际看到的是 [Mxx] 而非 $$$…$$$（旧
// 提示词的写法已过时），所以关键规则是「占位符逐字符保留」。术语表同时把
// 公共前缀垫到一个缓存单元以上的体量——过短的前缀不会被落盘、永不命中。
const SYSTEM_PROMPT =
  '你是专业的算法竞赛题面翻译器，把用户文本翻译成简体中文。' +
  '术语遵循算法竞赛惯例：greedy=贪心、dp=DP、binary search=二分、graph=图、' +
  'tree=树、string=字符串、math=数学、constructive=构造、interactive=交互、' +
  'bitmask=状压、flow=网络流、matching=匹配。' +
  '[M00]、[M01]…[M99] 这类占位符代表被保护的原文片段（公式/行内代码/图片/链接），' +
  '必须逐字符原样保留，不得翻译、改写、增删；总数保持不变，位置可随译文语序调整。' +
  '示例——输入：Please print the answer modulo [M00]. 输出：请输出答案对 [M00] 取模的结果。' +
  '人名与专有名词可保留原文。只输出译文，不要任何解释。';

async function chat(messages, { maxTokens, timeoutMs = TIMEOUT_MS } = {}) {
  const res = await fetch(endpoint(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.1,
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
      messages,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`);
  return res.json();
}

// Cached prompt tokens: DeepSeek exposes prompt_cache_hit_tokens, OpenAI-
// compatible endpoints prompt_tokens_details.cached_tokens. A subset of
// `in` billed at the cheaper cache-hit rate — tracked separately so the
// /logs token chart can split billed vs cached input.
const readCached = (u) =>
  Number(u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0);

async function aiTranslate(raw) {
  const { masked, stash } = protectMath(raw);
  const data = await chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: masked },
  ]);
  const out = data?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('empty response');
  const u = data.usage || {};
  const cached = readCached(u);
  const usage = {
    in: Number(u.prompt_tokens ?? 0),
    out: Number(u.completion_tokens ?? 0),
    ...(cached > 0 ? { cached } : {}),
  };
  const restored = restoreMath(out, stash);
  if (!restored) throw new Error('placeholder mangled');
  return { text: restored, usage };
}

/**
 * 先建缓存：在批量开始前把 SYSTEM_PROMPT 落盘成缓存单元。纯 system 探针的
 * 「用户输入结束」边界正好落在提示词末尾，落盘单元与后续每个请求的开头完全
 * 一致，首个分段即可命中；若端点拒绝纯 system 消息，退回带一个词 user 尾巴
 * 的探测（靠公共前缀检测落盘 system 部分）。尽力而为：探针失败不阻塞批量，
 * 翻译照常进行，只是这段前缀按未命中价计费。
 */
async function warmCache() {
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
      const data = await chat(probes[i].messages, { maxTokens: 1, timeoutMs: WARM_TIMEOUT_MS });
      const u = data.usage || {};
      const stat = {
        ok: true,
        mode: probes[i].mode,
        in: Number(u.prompt_tokens ?? 0),
        out: Number(u.completion_tokens ?? 0),
        cached: readCached(u),
      };
      console.log(
        `  cache warm-up (${stat.mode}) ok: in=${stat.in} out=${stat.out} cached=${stat.cached} — SYSTEM_PROMPT 前缀已请求落盘`,
      );
      return stat;
    } catch (e) {
      if (i === probes.length - 1) {
        console.warn(`  cache warm-up failed (${e.message}) — 继续翻译，缓存改靠公共前缀检测落盘。`);
        return { ok: false, mode: null, in: 0, out: 0, cached: 0 };
      }
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** { fileObj, segs: [{key, i, text}] } for one statement, `key` = 'title' | section. */
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

async function main() {
  if (!BASE_URL || !API_KEY) {
    console.error('AI_BASE_URL / AI_API_KEY not set — skipping AI translation.');
    process.exit(1);
  }

  const daily = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  const days = [...(daily.days || [])].sort((a, b) => (a.date < b.date ? 1 : -1));

  // Newest statement files first; dedupe codes across days.
  const seen = new Set();
  let budget = LIMIT;
  let done = 0;
  let fails = 0;
  let aborted = false;

  // Token accounting: per-segment usage goes both to the per-line log (human
  // + save-ci-log parser) and into a final machine-readable TOKEN-USAGE line.
  // Warm-up tokens are metered separately (warmup field) so per-segment
  // charts stay clean.
  const usage = { model: MODEL, ok: 0, fail: 0, in: 0, out: 0, cached: 0, segments: [] };
  let warmup = null;
  const fmt = (n) => n.toLocaleString('en-US');

  for (const day of days) {
    if (aborted || budget <= 0) break;
    for (const problem of day.problems || []) {
      if (aborted || budget <= 0) break;
      const code = problem.code?.toLowerCase();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      const file = path.join(STATEMENTS_DIR, `${code}.json`);
      let st;
      try {
        st = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        continue; // no statement file yet
      }
      const segs = missingSegments(st);
      if (!segs.length) continue;
      const pcode = st.code || code;
      console.log(`${pcode}: ${segs.length} segment(s) to translate`);
      st.sectionsZh ||= {};
      for (const seg of segs) {
        if (budget <= 0) break;
        budget -= 1;
        // Warm once, right before the first real request: the probe's request
        // boundary persists SYSTEM_PROMPT as a cache unit, so this and every
        // later segment request bills the prefix at the cache-hit rate.
        if (WARM_CACHE && !warmup) warmup = await warmCache();
        let text = null;
        let u = null;
        try {
          ({ text, usage: u } = await aiTranslate(seg.text));
          fails = 0;
        } catch (e) {
          fails += 1;
          usage.fail += 1;
          console.warn(`  ✗ ${seg.key}[${seg.i}] — ${e.message}`);
          if (fails >= MAX_CONSECUTIVE_FAILS) {
            console.error(`  ${fails} consecutive failures — endpoint looks down, aborting.`);
            aborted = true;
            break;
          }
          await sleep(2000);
        }
        if (text) {
          usage.ok += 1;
          usage.in += u.in;
          usage.out += u.out;
          usage.cached += u.cached || 0;
          usage.segments.push({ code: pcode, seg: `${seg.key}[${seg.i}]`, in: u.in, out: u.out, cached: u.cached || 0 });
          if (seg.key === 'title') {
            st.titleZh = typeof st.titleZh === 'object' && st.titleZh !== null ? st.titleZh : {};
            st.titleZh.ai = text;
          } else {
            st.sectionsZh[seg.key] ||= [];
            const entry =
              st.sectionsZh[seg.key][seg.i] &&
              typeof st.sectionsZh[seg.key][seg.i] === 'object'
                ? st.sectionsZh[seg.key][seg.i]
                : {};
            entry.ai = text;
            st.sectionsZh[seg.key][seg.i] = entry;
          }
          done += 1;
          console.log(
            `  ✓ ${seg.key}[${seg.i}]: ${text.slice(0, 48)}… [tokens in=${u.in} out=${u.out} cached=${u.cached || 0}]`,
          );
        }
        await sleep(DELAY_MS);
      }
      if (done || segs.length) await writeFile(file, JSON.stringify(st, null, 2) + '\n');
    }
  }

  const total = usage.in + usage.out;
  const warmStat = warmup || { ok: false, mode: null, in: 0, out: 0, cached: 0 };
  const cacheRate = usage.in ? Math.round((usage.cached / usage.in) * 100) : 0;
  console.log(`Done: ${done} segment(s) translated${budget <= 0 ? ` (hit limit ${LIMIT})` : ''}.`);
  console.log('── AI Token 用量（本次运行）──');
  console.log(`  模型 ${MODEL} · 请求成功 ${usage.ok} / 失败 ${usage.fail}`);
  console.log(`  输入 ${fmt(usage.in)} + 输出 ${fmt(usage.out)} = 合计 ${fmt(total)} tokens`);
  console.log(`  其中缓存命中 ${fmt(usage.cached)} tokens（命中率 ${cacheRate}%，命中部分按缓存价计费）`);
  console.log(
    `  缓存预热：${warmStat.ok ? `${warmStat.mode} 探针成功（预热 in=${warmStat.in} cached=${warmStat.cached}）` : '未生效（跳过或失败），命中率依赖服务端公共前缀检测'}`,
  );
  // Machine-readable line for scripts/save-ci-log.mjs to parse into the log summary.
  console.log(`TOKEN-USAGE ${JSON.stringify({ ...usage, totalTokens: total, warmup: warmStat })}`);
  if (aborted && done === 0) process.exit(1);
}

main();
