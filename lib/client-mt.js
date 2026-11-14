'use client';

/**
 * Browser-side machine-translation engines.
 *
 * 彩云 (caiyun) allows cross-origin browser calls (it echoes any Origin), so
 * it is fetched directly from the visitor's browser. DeepL / 有道 / 讯飞
 * reject browser CORS requests outright (the OJBetter userscript only gets
 * away with it because GM_xmlhttpRequest bypasses CORS), so those three go
 * through the same-origin relay in app/api/mt/[channel]/route.js — a
 * stateless forwarder that adds the Origin/Referer/UA headers browsers are
 * not allowed to set. All scheduling, pacing and caching live in
 * lib/zh-store.js on the client.
 */
import { protectMath, restoreMath } from './mt-protect';

const TIMEOUT_MS = 25000;

const CAIYUN_TOKEN = 'token:qgemv4jr1y38jyq6vhvi'; // public web-frontend token

const randomId = () =>
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

/* caiyun responses are rot13-encoded base64, one entry per source line */
const CAIYUN_DIC = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'].reduce(
  (d, c, i) => ((d[c] = 'NOPQRSTUVWXYZABCDEFGHIJKLMnopqrstuvwxyzabcdefghijklm'[i]), d),
  {},
);

const b64ToText = (b64) =>
  new TextDecoder().decode(
    Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
  );

async function translateCaiyun(raw) {
  const browser_id = randomId();
  const jwtRes = await fetch('https://api.interpreter.caiyunai.com/v1/user/jwt/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-authorization': CAIYUN_TOKEN },
    body: JSON.stringify({ browser_id }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!jwtRes.ok) throw new Error(`caiyun jwt HTTP ${jwtRes.status}`);
  const { jwt } = await jwtRes.json();
  if (!jwt) throw new Error('caiyun no jwt');

  const res = await fetch('https://api.interpreter.caiyunai.com/v1/translator', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'x-authorization': CAIYUN_TOKEN,
      't-authorization': jwt,
    },
    body: JSON.stringify({
      source: raw.split('\n'),
      browser_id,
      trans_type: 'auto2zh',
      request_id: 'web_fanyi',
      media: 'text',
      os_type: 'web',
      dict: true,
      cached: true,
      replaced: true,
      style: 'formal',
      model: '',
      detect: true,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`caiyun HTTP ${res.status}`);
  const { target } = await res.json();
  const out = (target || [])
    .map((line) => b64ToText([...line].map((c) => CAIYUN_DIC[c] || c).join('')))
    .join('\n');
  if (!out.trim()) throw new Error('caiyun empty');
  return out;
}

async function translateViaRelay(channel, raw) {
  const res = await fetch(`/api/mt/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: raw }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.text) throw new Error(data?.error || `中继 HTTP ${res.status}`);
  return data.text;
}

/**
 * Translate one paragraph to Chinese. caiyun runs fully in the browser with
 * the shared placeholder protection; the other channels delegate to the
 * same-origin relay, which applies protection + restoration server-side.
 */
export async function mtTranslate(channel, raw) {
  if (channel === 'caiyun') {
    const { masked, stash } = protectMath(raw);
    const restored = restoreMath(await translateCaiyun(masked), stash);
    if (!restored) throw new Error('caiyun 占位符丢失');
    return restored;
  }
  return translateViaRelay(channel, raw);
}
