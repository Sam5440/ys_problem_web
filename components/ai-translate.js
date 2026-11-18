'use client';

/**
 * Browser-side on-demand translation via any OpenAI-compatible chat
 * completions endpoint configured by the user (settings dialog). The API key
 * never leaves the browser except to the endpoint the user chose.
 *
 * Uses the same placeholder protection as the server pipeline: math
 * ($$$…$$$), inline code, images and bare URLs are masked before the request
 * and spliced back after, with slot-count verification.
 */
import { useEffect, useState } from 'react';
import { protectMath, restoreMath } from '@/lib/mt-protect';

export const AI_MODELS = ['deepseek-v4-flash', 'glm-5.3-flash'];

export function normalizeBaseUrl(u) {
  const s = String(u || '').trim().replace(/\/+$/, '');
  if (!s) return '';
  return /\/v\d+$/.test(s) ? s : `${s}/v1`;
}

export async function aiTranslate(text, cfg) {
  const { masked, stash } = protectMath(text);
  const res = await fetch(`${normalizeBaseUrl(cfg.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content:
            '你是专业的算法竞赛题面翻译器。把用户文本翻译成简体中文：术语遵循算法竞赛惯例（如 greedy=贪心、dp=DP）；' +
            '$$$...$$$ 数学公式、`行内代码`、![](图片链接) 和裸 URL 一律原样保留不翻译；只输出译文，不要任何解释。',
        },
        { role: 'user', content: masked },
      ],
    }),
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      msg = (await res.json())?.error?.message || msg;
    } catch {}
    throw new Error(msg);
  }
  const data = await res.json();
  const out = data?.choices?.[0]?.message?.content?.trim();
  if (!out) throw new Error('空响应');
  const restored = restoreMath(out, stash);
  if (!restored) throw new Error('公式占位符丢失');
  return restored;
}

/* -------- shared cache + small FIFO queue (concurrency 2) -------- */

const cache = new Map(); // key -> { text } | { error }
const inflight = new Map(); // key -> Promise<string>
const jobQueue = [];
let running = 0;
const CONCURRENCY = 2;

function pump() {
  while (running < CONCURRENCY && jobQueue.length) {
    running++;
    jobQueue
      .shift()()
      .finally(() => {
        running--;
        pump();
      });
  }
}

function ensureJob(key, text, cfg) {
  const hit = cache.get(key);
  if (hit) return hit.text ? Promise.resolve(hit.text) : Promise.reject(new Error(hit.error));
  if (inflight.has(key)) return inflight.get(key);
  const p = new Promise((resolve, reject) => {
    jobQueue.push(() => aiTranslate(text, cfg).then(resolve, reject));
  })
    .then((t) => {
      cache.set(key, { text: t });
      return t;
    })
    .catch((e) => {
      cache.set(key, { error: e.message });
      throw e;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  pump();
  return p;
}

/**
 * Translate `text` with the user's AI endpoint once (and only once per
 * key); multiple subscribers share the same in-flight request.
 * Returns { status: 'idle'|'loading'|'done'|'error', text?, error? }.
 */
export function useAiSegment(text, cfg, enabled) {
  const key = enabled && cfg?.baseUrl && cfg?.apiKey ? `${cfg.baseUrl}|${cfg.model}|${text}` : null;
  const [state, setState] = useState(() =>
    key && cache.has(key) ? (cache.get(key).text ? { status: 'done', text: cache.get(key).text } : { status: 'error', error: cache.get(key).error }) : { status: 'idle' },
  );

  useEffect(() => {
    if (!key) {
      setState({ status: 'idle' });
      return;
    }
    const hit = cache.get(key);
    if (hit) {
      setState(hit.text ? { status: 'done', text: hit.text } : { status: 'error', error: hit.error });
      return;
    }
    let alive = true;
    setState({ status: 'loading' });
    ensureJob(key, text, cfg)
      .then((t) => alive && setState({ status: 'done', text: t }))
      .catch((e) => alive && setState({ status: 'error', error: e.message }));
    return () => {
      alive = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  return state;
}
