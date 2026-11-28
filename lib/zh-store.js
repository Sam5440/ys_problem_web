'use client';

/**
 * Client-side translation store: the visitor's browser requests every
 * (paragraph, channel) pair that neither the repo archive nor the local
 * cache covers yet, persists results in IndexedDB, and notifies subscribers
 * so the UI upgrades live.
 *
 * Dispatch is round-robin per statement — paragraph 1 → channel 1, paragraph
 * 2 → channel 2, … — followed by more passes until every channel has covered
 * every paragraph. Each channel runs single-concurrency with a global 3s
 * spacing between request starts, mimicking a person translating a page on
 * that service. A channel that fails several requests in a row is treated as
 * down for the session; its remaining tasks are failed and the display falls
 * back to the surviving channels by priority.
 */
import { useEffect, useReducer } from 'react';
import { mtTranslate } from './client-mt';

export const CHANNELS = ['deepl', 'youdao', 'caiyun', 'iflyrec'];
const GAP_MS = 3000;
const MAX_CONSECUTIVE_FAILS = 6;

/* ---------------- per-key records + subscriptions ---------------- */

const records = new Map(); // key -> { zh: {channel: text}, status: {channel: 'queued'|'loading'|'failed'} }
const listeners = new Map(); // key -> Set<fn>

const recOf = (key) => {
  let r = records.get(key);
  if (!r) {
    r = { zh: {}, status: {} };
    records.set(key, r);
  }
  return r;
};

const notify = (key) => listeners.get(key)?.forEach((fn) => fn());

export function subscribeZh(key, fn) {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(fn);
  return () => set.delete(fn);
}

/** Live translation record for one paragraph; re-renders on every change. */
export function useZhSegment(key) {
  const [, force] = useReducer((x) => x + 1, 0);
  useEffect(() => subscribeZh(key, force), [key]);
  return recOf(key);
}

/* ---------------- IndexedDB persistence (memory-only fallback) ---------------- */

const DB_NAME = 'ys-problem-zh';
const STORE = 'segments';
let dbPromise;

function idb() {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  dbPromise ||= new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function idbLoadStatement(code) {
  return idb().then(
    (db) =>
      new Promise((resolve) => {
        if (!db) return resolve({});
        const out = {};
        const range = IDBKeyRange.bound(`${code}|`, `${code}|\uffff`);
        const cur = db.transaction(STORE, 'readonly').objectStore(STORE).openCursor(range);
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c) return resolve(out);
          out[c.key] = c.value || {};
          c.continue();
        };
        cur.onerror = () => resolve(out);
      }),
  );
}

function idbSave(key, channel, text) {
  idb().then((db) => {
    if (!db) return;
    const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
    const get = store.get(key);
    get.onsuccess = () => {
      const v = get.result || {};
      v[channel] = text;
      store.put(v, key);
    };
  });
}

/** Wipe every locally cached translation (settings dialog button). */
export async function clearZhCache() {
  records.clear();
  const db = await idb();
  if (!db) return;
  await new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = resolve;
    tx.onabort = resolve;
  });
}

/* ---------------- per-channel schedulers ---------------- */

const chan = Object.fromEntries(
  CHANNELS.map((c) => [
    c,
    { q: [], inFlightKeys: new Set(), active: false, lastStart: 0, fails: 0, dead: false },
  ]),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** All translatable paragraphs of a statement, in display order. */
function statementSegments(statement) {
  const segs = [];
  const push = (secKey, i, p) => {
    if (typeof p === 'string' && p.trim()) segs.push({ secKey: `${secKey}|${i}`, text: p });
  };
  if (statement.title) push('title', 0, statement.title);
  for (const [secKey, list] of Object.entries(statement.sections || {})) {
    (list || []).forEach((p, i) => push(secKey, i, p));
  }
  return segs;
}

/** Map segKey -> Set<channels> for pairs the repo archive already covers. */
// channel ids that may appear in an archived entry — the non-channel
// `aiModel` metadata key must not be treated as one
const ARCHIVE_CHANNEL_IDS = ['deepl', 'youdao', 'caiyun', 'iflyrec', 'ai'];

function archivedChannels(statement) {
  const out = new Map();
  const add = (secKey, v) => {
    if (!v || typeof v !== 'object') return;
    const set = new Set(
      Object.keys(v).filter(
        (ch) => ARCHIVE_CHANNEL_IDS.includes(ch) && typeof v[ch] === 'string' && v[ch].trim(),
      ),
    );
    if (set.size) out.set(secKey, set);
  };
  add('title|0', statement.titleZh);
  for (const [secKey, list] of Object.entries(statement.sectionsZh || {})) {
    (list || []).forEach((v, i) => add(`${secKey}|${i}`, v));
  }
  return out;
}

/**
 * Ensure every channel ends up with every segment of `statement`: pairs
 * covered by the repo archive or the local cache are skipped, the rest are
 * queued round-robin (paragraph i's first pass goes to channel i % 4) and
 * drained with per-channel 3s pacing. Safe to call again at any time —
 * duplicates are dropped.
 */
export function hydrateStatement(code, statement) {
  if (!code || !statement) return;
  const segs = statementSegments(statement).map((s, pos) => ({
    ...s,
    key: `${code}|${s.secKey}`,
    pos,
  }));
  const archived = archivedChannels(statement);
  idbLoadStatement(code).then((saved) => {
    for (const [key, v] of Object.entries(saved)) {
      const rec = recOf(key);
      for (const [ch, text] of Object.entries(v)) {
        if (CHANNELS.includes(ch) && typeof text === 'string' && text && !rec.zh[ch]) {
          rec.zh[ch] = text;
        }
      }
    }
    enqueue(segs, archived);
  });
}

function enqueue(segs, archived) {
  const touched = new Set();
  for (const channel of CHANNELS) {
    const st = chan[channel];
    if (st.dead) continue;
    const pending = segs.filter(({ key }) => {
      if (archived.get(key)?.has(channel)) return false;
      if (recOf(key).zh[channel]) return false;
      if (st.inFlightKeys.has(key)) return false;
      return true;
    });
    if (!pending.length) continue;
    const chIdx = CHANNELS.indexOf(channel);
    const n = CHANNELS.length;
    const pass = (pos) => (((pos - chIdx) % n) + n) % n;
    pending.sort((a, b) => pass(a.pos) - pass(b.pos) || a.pos - b.pos);
    for (const t of pending) {
      st.q.push(t);
      st.inFlightKeys.add(t.key);
      recOf(t.key).status[channel] = 'queued';
      touched.add(t.key);
    }
    pump(channel);
  }
  for (const key of touched) notify(key);
}

async function pump(channel) {
  const st = chan[channel];
  if (st.active) return;
  st.active = true;
  try {
    while (st.q.length) {
      const task = st.q.shift();
      const rec = recOf(task.key);
      if (rec.zh[channel]) {
        st.inFlightKeys.delete(task.key);
        continue;
      }
      const wait = st.lastStart + GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      st.lastStart = Date.now();
      rec.status[channel] = 'loading';
      notify(task.key);
      try {
        const text = await mtTranslate(channel, task.text);
        rec.zh[channel] = text;
        rec.status[channel] = 'done';
        st.fails = 0;
        idbSave(task.key, channel, text);
      } catch {
        if (!task.retried) {
          // one clean retry per task; transient blips shouldn't lose a channel
          task.retried = true;
          rec.status[channel] = 'queued';
          st.q.unshift(task);
          notify(task.key);
          continue;
        }
        rec.status[channel] = 'failed';
        st.fails += 1;
        if (st.fails >= MAX_CONSECUTIVE_FAILS) {
          // channel is down for this session — give up on its remaining queue
          st.dead = true;
          for (const t of st.q) {
            recOf(t.key).status[channel] = 'failed';
            st.inFlightKeys.delete(t.key);
            notify(t.key);
          }
          st.q.length = 0;
        }
      }
      st.inFlightKeys.delete(task.key);
      notify(task.key);
    }
  } finally {
    st.active = false;
  }
}
