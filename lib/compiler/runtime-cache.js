/**
 * 浏览器端运行时缓存层（Cache API）。
 *
 * 设置页「下载编译器」把运行时文件抓进 Cache API（compiler-runtime-v1），
 * 之后 worker / py-worker 一律缓存优先（离线可用、二次加载零网络）。
 * pyodide 文件键为完整 CDN URL；clang 系列键为同源路径 /compiler/<name>。
 * 存储时以显式 Content-Type 重建 Response（instantiateStreaming 需要
 * application/wasm；缓存命中路径不看网络响应头）。
 */

const CACHE_NAME = 'compiler-runtime-v1';
const META_KEY = 'ysc-runtime-meta-v1';

async function openCache() {
  if (typeof caches === 'undefined') throw new Error('当前环境不支持 Cache API');
  return caches.open(CACHE_NAME);
}

function readMeta() {
  try {
    return JSON.parse(window.localStorage.getItem(META_KEY)) || {};
  } catch {
    return {};
  }
}

function writeMeta(meta) {
  try {
    window.localStorage.setItem(META_KEY, JSON.stringify(meta));
  } catch {}
}

/** 下载单个文件（流式进度），写入缓存。 */
export async function downloadFile(url, { onProgress, signal } = {}) {
  const cache = await openCache();
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`下载 ${url} 失败：HTTP ${response.status}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const type = response.headers.get('content-type') || 'application/octet-stream';

  let buffer;
  if (response.body?.getReader && onProgress) {
    const reader = response.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.byteLength;
      onProgress({ url, got, total: total || got });
    }
    buffer = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) {
      buffer.set(c, off);
      off += c.byteLength;
    }
  } else {
    buffer = new Uint8Array(await response.arrayBuffer());
    onProgress?.({ url, got: buffer.length, total: buffer.length });
  }

  await cache.put(url, new Response(buffer, { headers: { 'Content-Type': type } }));
  return buffer.length;
}

/** 同源可达性探测结果缓存（进程内一次）。 */
const originProbe = new Map();

async function originReachable(url) {
  if (originProbe.has(url)) return originProbe.get(url);
  try {
    const r = await fetch(url, { method: 'HEAD' });
    originProbe.set(url, r.ok);
    return r.ok;
  } catch {
    originProbe.set(url, false);
    return false;
  }
}

/**
 * 运行时是否可用：全部文件已进 Cache API；或为同源相对路径且源站可达
 * （CI 把 data/runtime 注入 deploy 后 /compiler/* 直接可取，worker 会走
 * 网络回退，无需先经设置页下载）。跨源 CDN 文件（Pyodide）必须已缓存。
 */
export async function hasRuntime(urls) {
  try {
    const cache = await openCache();
    for (const url of urls) {
      const hit = await cache.match(url);
      if (hit) continue;
      if (url.startsWith('/')) {
        if (!(await originReachable(url))) return false;
      } else {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export async function removeRuntime(urls) {
  const cache = await openCache();
  await Promise.all(urls.map((u) => cache.delete(u)));
  const meta = readMeta();
  for (const url of urls) delete meta.files?.[url];
  writeMeta(meta);
}

/** 已缓存字节数（按 meta 记账；未记录的逐个探测太慢）。 */
export function runtimeStats() {
  return readMeta();
}

export function recordDownload(urls, sizes, label) {
  const meta = readMeta();
  meta.files = meta.files || {};
  urls.forEach((u, i) => {
    meta.files[u] = sizes[i] ?? 0;
  });
  meta[label] = { downloadedAt: new Date().toISOString(), total: sizes.reduce((a, b) => a + (b || 0), 0) };
  writeMeta(meta);
}

/** 主线程流式下载一组文件（顺序），汇总进度 + 汇报每个文件完成。 */
export async function downloadAll(items, { onFileStart, onProgress, onFileDone, signal } = {}) {
  const sizes = [];
  for (const item of items) {
    onFileStart?.(item);
    const size = await downloadFile(item.url, {
      signal,
      onProgress: (p) => onProgress?.(item, p),
    });
    sizes.push(size);
    onFileDone?.(item, size);
  }
  return sizes;
}

export const RUNTIME_CACHE_NAME = CACHE_NAME;
