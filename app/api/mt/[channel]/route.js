import { translateWithPlatform } from '@/scripts/lib/translate.mjs';

/**
 * Same-origin relay for the MT channels that reject browser CORS requests
 * (deepl / youdao / iflyrec — caiyun is fetched browser-direct). Stateless:
 * one paragraph in, one translation out, with the placeholder
 * protect/restore cycle from the shared pipeline. Pacing and queueing are
 * the browser's job (lib/zh-store.js), so no rate-limit state lives here.
 */

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

const CHANNELS = new Set(['deepl', 'youdao', 'iflyrec']);
const MAX_TEXT = 4000;

export async function POST(req, { params }) {
  const { channel } = await params;
  if (!CHANNELS.has(channel)) {
    return Response.json({ error: 'unknown channel' }, { status: 404 });
  }

  // Same-origin only: browsers attach Origin to every POST fetch, so a
  // matching host proves the call came from this site (works for production,
  // preview deployments and localhost alike).
  let originHost = '';
  try {
    originHost = new URL(req.headers.get('origin') || '').host;
  } catch {}
  if (!originHost || originHost !== req.headers.get('host')) {
    return Response.json({ error: 'cross-origin relay is not allowed' }, { status: 403 });
  }

  let text = '';
  try {
    text = String((await req.json())?.text || '');
  } catch {}
  if (!text.trim()) {
    return Response.json({ error: 'empty text' }, { status: 400 });
  }
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

  try {
    const out = await translateWithPlatform(text, channel);
    return Response.json({ text: out });
  } catch (e) {
    return Response.json({ error: String(e?.message || e) }, { status: 502 });
  }
}
