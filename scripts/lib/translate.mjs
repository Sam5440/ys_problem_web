/**
 * Zero-credential translation engines, ported line-by-line from the OJBetter
 * userscript (https://github.com/beijixiaohu/OJBetter, GPL-3.0) — GM_xmlhttpRequest
 * swapped for standard fetch. All endpoints are the services' own web-frontends,
 * no API keys required.
 *
 * Verified working 2026-10 from mainland China without a proxy:
 *   deepl   — www2.deepl.com JSON-RPC (best quality, rate-limits aggressively)
 *   youdao  — dict.youdao.com webfanyi (double sign + AES-CBC response)
 *   caiyun  — api.interpreter.caiyunai.com (public frontend token, ROT13+Base64 response)
 *   iflyrec — www.iflyrec.com (fastest, zh only, 2000 chars)
 *   google  — translate.google.com/m (blocked from mainland networks, off by default)
 *
 * Dead as of 2026-10, do not resurrect: Edge free endpoint (auth returns 404),
 * api.deeplx.org (returns a promo link instead of a translation).
 *
 * Env: TRANSLATE_SERVICES     comma list, default "deepl,youdao,caiyun,iflyrec"
 *      TRANSLATE_DELAY        min ms between two requests within one platform, default 2000
 *      TRANSLATE_RETRIES      per-segment retries after the first try, default 3
 *      TRANSLATE_RETRY_DELAY  ms between retries, default 10000
 *      TRANSLATE_DEBUG        1 = log per-request failure reasons
 */
import crypto from 'node:crypto';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const TIMEOUT_MS = 25000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, init) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

/* ---------------- math / inline-code protection ----------------
 * MT engines destroy Codeforces math ($$$...$$$) — placeholder it out
 * before translating and splice it back afterwards. */

function protectMath(text) {
  const stash = [];
  // Zero-padded ids: bare "[M0]" gets interpreted (iflyrec translates it as
  // the money-supply term 流通中现金); "[M07]" survives every engine tested.
  // Image markdown (parser emits ![…](espresso.codeforces.com/…)) and bare
  // URLs are stashed too — MT engines mangle or drop them.
  const masked = String(text).replace(
    /\$\$\$[\s\S]+?\$\$\$|\$\$[\s\S]+?\$\$|\$[^$\n]+?\$|`[^`\n]+`|!\[[^\]]*\]\([^)]+\)|https?:\/\/\S+/g,
    (m) => `[M${String(stash.push(m) - 1).padStart(2, '0')}]`,
  );
  return { masked, stash };
}

function restoreMath(translated, stash) {
  if (!stash.length) return translated;
  // Engines may answer with fullwidth brackets/letters/digits — fold them back
  // before matching, and count slots: any lost/mangled placeholder fails the round.
  const fold = (s) =>
    s.replace(/[Ａ-Ｚａ-ｚ０-９【】［（]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    ).replace(/（/g, '(');
  const normalized = fold(translated);
  const found = normalized.match(/\[\s*M\s*\d+\s*\]/gi);
  if (!found || found.length !== stash.length) return null;
  return normalized.replace(/\[\s*M\s*(\d+)\s*\]/gi, (_, n) => {
    const i = Number(n);
    return i < stash.length ? stash[i] : '';
  });
}

/* ---------------- engines (translate to Chinese) ---------------- */

async function translateDeepl(raw) {
  const id = (Math.floor(Math.random() * 99999) + 100000) * 1000;
  const ts0 = Date.now();
  const iCount = raw.split('i').length - 1;
  const timestamp = iCount !== 0 ? ts0 - (ts0 % (iCount + 1)) + iCount + 1 : ts0;
  let body = JSON.stringify({
    jsonrpc: '2.0',
    method: 'LMT_handle_texts',
    id,
    params: {
      splitting: 'newlines',
      lang: { source_lang_user_selected: 'auto', target_lang: 'ZH' },
      texts: [{ text: raw, requestAlternatives: 3 }],
      timestamp,
    },
  });
  body =
    (id + 5) % 29 === 0 || (id + 3) % 13 === 0
      ? body.replace('"method":"', '"method" : "')
      : body.replace('"method":"', '"method": "');

  const res = await fetchWithTimeout('https://www2.deepl.com/jsonrpc', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Host: 'www2.deepl.com',
      Origin: 'https://www.deepl.com',
      Referer: 'https://www.deepl.com/',
      'User-Agent': UA,
    },
    body,
  });
  const text = await res.text();
  if (text.includes('"message":"Too many requests"')) throw new Error('deepl 429');
  if (res.status !== 200) throw new Error(`deepl HTTP ${res.status}`);
  const out = JSON.parse(text)?.result?.texts?.[0]?.text;
  if (!out) throw new Error('deepl empty');
  return out;
}

async function translateIflyrec(raw) {
  const res = await fetchWithTimeout(
    'https://www.iflyrec.com/TranslationService/v1/textTranslation',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://www.iflyrec.com',
        Referer: 'https://www.iflyrec.com/',
        'User-Agent': UA,
      },
      body: JSON.stringify({ from: '2', to: '1', contents: [{ text: raw, frontBlankLine: 0 }] }),
    },
  );
  if (res.status !== 200) throw new Error(`iflyrec HTTP ${res.status}`);
  const data = await res.json();
  const out = data?.biz?.[0]?.translateResult;
  if (!out) throw new Error('iflyrec empty');
  return out;
}

const md5hex = (s) => crypto.createHash('md5').update(s).digest('hex');
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

async function translateYoudao(raw) {
  const cookie =
    `OUTFOX_SEARCH_USER_ID_NCOO=${randInt(1e8, 1e9 - 1)}.${randInt(1e8, 1e9 - 1)}; ` +
    `OUTFOX_SEARCH_USER_ID=${randInt(1e8, 1e9 - 1)}@${randInt(1, 255)}.${randInt(1, 255)}.${randInt(1, 255)}.${randInt(1, 255)}`;
  const time = Date.now();
  const getsign = (t) =>
    md5hex(`client=fanyideskweb&mysticTime=${time}&product=webfanyi&key=${t}`);
  const common = {
    client: 'fanyideskweb', product: 'webfanyi', appVersion: '1.0.0',
    vendor: 'web', pointParam: 'client,mysticTime,product', mysticTime: time,
    keyfrom: 'fanyi.web', mid: '1', screen: '1', model: '1',
    network: 'wifi', abtest: '0', yduuid: 'abcdefg',
  };

  const keyRes = await fetchWithTimeout(
    `https://dict.youdao.com/webtranslate/key?${new URLSearchParams({
      keyid: 'webfanyi-key-getter',
      sign: getsign('asdjnjfenknafdfsdfsd'),
      ...common,
    })}`,
    {
      headers: {
        Accept: 'application/json, text/plain, */*',
        Origin: 'https://fanyi.youdao.com',
        Referer: 'https://fanyi.youdao.com/',
        'User-Agent': UA,
      },
    },
  );
  if (keyRes.status !== 200) throw new Error(`youdao key HTTP ${keyRes.status}`);
  const { data: kd } = await keyRes.json();
  if (!kd?.secretKey) throw new Error('youdao no key');

  const res = await fetchWithTimeout('https://dict.youdao.com/webtranslate', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: 'https://fanyi.youdao.com/',
      Cookie: cookie,
      'User-Agent': UA,
    },
    body: new URLSearchParams({
      i: raw, from: 'auto', to: 'zh-CHS',
      useTerm: 'false', domain: '0', dictResult: 'true', keyid: 'webfanyi',
      sign: getsign(kd.secretKey),
      ...common,
    }).toString(),
  });
  if (res.status !== 200) throw new Error(`youdao HTTP ${res.status}`);
  const cipher = await res.text();
  const decipher = crypto.createDecipheriv(
    'aes-128-cbc',
    Buffer.from(md5hex(kd.aesKey).substring(0, 32), 'hex'),
    Buffer.from(md5hex(kd.aesIv).substring(0, 32), 'hex'),
  );
  let plain = Buffer.concat([
    decipher.update(Buffer.from(cipher.replace(/-/g, '+').replace(/_/g, '/'), 'base64')),
    decipher.final(),
  ]).toString('utf8');
  const decoded = JSON.parse(plain.substring(0, plain.lastIndexOf('}') + 1));
  const out = decoded.translateResult.flat().map((seg) => seg.tgt).join('');
  if (!out) throw new Error('youdao empty');
  return out;
}

const CAIYUN_TOKEN = 'token:qgemv4jr1y38jyq6vhvi'; // public web-frontend token

async function translateCaiyun(raw) {
  const dic = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'].reduce(
    (d, c, i) => ((d[c] = 'NOPQRSTUVWXYZABCDEFGHIJKLMnopqrstuvwxyzabcdefghijklm'[i]), d),
    {},
  );
  const browser_id = md5hex(Math.random().toString());

  const jwtRes = await fetchWithTimeout(
    'https://api.interpreter.caiyunai.com/v1/user/jwt/generate',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-authorization': CAIYUN_TOKEN,
        origin: 'https://fanyi.caiyunapp.com',
        'User-Agent': UA,
      },
      body: JSON.stringify({ browser_id }),
    },
  );
  if (jwtRes.status !== 200) throw new Error(`caiyun jwt HTTP ${jwtRes.status}`);
  const { jwt } = await jwtRes.json();

  const res = await fetchWithTimeout('https://api.interpreter.caiyunai.com/v1/translator', {
    method: 'POST',
    headers: {
      'content-type': 'application/json;charset=UTF-8',
      'x-authorization': CAIYUN_TOKEN,
      't-authorization': jwt,
      'User-Agent': UA,
    },
    body: JSON.stringify({
      source: raw.split('\n'),
      browser_id,
      trans_type: 'auto2zh',
      request_id: 'web_fanyi',
      media: 'text',
      os_type: 'web',
      dict: true, cached: true, replaced: true,
      style: 'formal', model: '', detect: true,
    }),
  });
  if (res.status !== 200) throw new Error(`caiyun HTTP ${res.status}`);
  const { target } = await res.json();
  const out = target.map((line) =>
    Buffer.from([...line].map((c) => dic[c] || c).join(''), 'base64').toString('utf8'),
  ).join('\n');
  if (!out.trim()) throw new Error('caiyun empty');
  return out;
}

async function translateGoogle(raw) {
  const res = await fetchWithTimeout(
    `https://translate.google.com/m?tl=zh-CN&q=${encodeURIComponent(raw)}`,
    { headers: { 'User-Agent': UA } },
  );
  if (res.status !== 200) throw new Error(`google HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/class="result-container"[^>]*>([\s\S]*?)<\/div>/);
  if (!m) throw new Error('google no result');
  return m[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

/* ---------------- multi-platform orchestration helpers ----------------
 * The caller (translate-statements.mjs) runs one single-threaded worker per
 * platform, all platforms concurrently, pulling from a shared segment queue
 * with per-segment retries. This module only provides the pieces: the
 * platform list, per-platform pacing, and single-platform translation. */

export const ENGINES = {
  deepl: translateDeepl,
  youdao: translateYoudao,
  caiyun: translateCaiyun,
  iflyrec: translateIflyrec,
  google: translateGoogle, // mainland-blocked, enable only with overseas egress
};

export const SERVICE_LIST = () =>
  (process.env.TRANSLATE_SERVICES || 'deepl,youdao,caiyun,iflyrec')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => ENGINES[s]);

// Within one platform requests go strictly sequentially, spaced TRANSLATE_DELAY
// ms apart — same rhythm as a person translating a long page on that service.
const DELAY = () => Number(process.env.TRANSLATE_DELAY || 2000);
const lastRequestAt = new Map();

export async function paceFor(platform) {
  const wait = (lastRequestAt.get(platform) || 0) + DELAY() - Date.now();
  if (wait > 0) await sleep(wait);
  lastRequestAt.set(platform, Date.now());
}

/**
 * Translate one paragraph to Chinese via a single platform, with math/inline
 * code masked out and placeholder survival verified. Throws on any failure;
 * returns the finished text.
 */
export async function translateWithPlatform(raw, platform) {
  const { masked, stash } = protectMath(raw);
  const out = await ENGINES[platform](masked);
  const restored = restoreMath(out, stash);
  if (!restored) throw new Error(`${platform} mangled placeholders`);
  return restored;
}
