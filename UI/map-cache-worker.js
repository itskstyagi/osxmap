const CACHE_NAME = 'monument-map-v1';
const MAX_BYTES = 96 * 1024 * 1024;
const MAX_ENTRIES = 400;
const MAX_AGE = 7 * 24 * 60 * 60 * 1000;
const pending = new Map();
let writes = Promise.resolve();
let queuedWrites = 0;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

function cacheable(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  return url.hostname === 'tiles.openfreemap.org'
    || (url.hostname === 'elevation-tiles-prod.s3.amazonaws.com' && url.pathname.startsWith('/terrarium/'));
}

async function entries(cache) {
  const keys = await cache.keys();
  return Promise.all(keys.map(async (key) => {
    const response = await cache.match(key);
    return { key, time: Number(response?.headers.get('X-Monument-Cached-At') || 0), bytes: Number(response?.headers.get('X-Monument-Bytes') || 0) };
  }));
}

async function store(cache, request, response) {
  if (!response.ok || response.type === 'opaque' || /no-store/i.test(response.headers.get('Cache-Control') || '')) return;
  const reader = response.body?.getReader();
  if (!reader) return;
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8 * 1024 * 1024) { await reader.cancel(); return; }
    chunks.push(value);
  }
  const data = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.byteLength; }
  const headers = new Headers(response.headers);
  headers.set('X-Monument-Cached-At', String(Date.now()));
  headers.set('X-Monument-Bytes', String(data.byteLength));
  // Fetch exposes decoded bytes; do not preserve transfer encodings on a new response.
  headers.delete('Content-Encoding');
  headers.delete('Content-Length');
  await cache.delete(request);
  const items = (await entries(cache)).sort((a, b) => a.time - b.time);
  let bytes = items.reduce((sum, item) => sum + item.bytes, 0);
  let count = items.length;
  for (const item of items) {
    if (bytes + size <= MAX_BYTES && count + 1 <= MAX_ENTRIES && Date.now() - item.time < MAX_AGE) break;
    await cache.delete(item.key);
    bytes -= item.bytes;
    count -= 1;
  }
  try { await cache.put(request, new Response(data, { status: response.status, headers })); }
  catch (error) {
    if (error.name !== 'QuotaExceededError') throw error;
    // The origin shares storage with other applications; leave additional room.
    const remaining = (await entries(cache)).sort((a, b) => a.time - b.time);
    for (const item of remaining.slice(0, Math.max(1, Math.ceil(remaining.length / 4)))) await cache.delete(item.key);
    await cache.put(request, new Response(data, { status: response.status, headers }));
  }
}

self.addEventListener('fetch', (event) => {
  if (!cacheable(event.request)) return;
  event.respondWith((async () => {
    let cache;
    let cached;
    try {
      cache = await caches.open(CACHE_NAME);
      cached = await cache.match(event.request);
      if (cached && Date.now() - Number(cached.headers.get('X-Monument-Cached-At')) < MAX_AGE) return cached;
    } catch { /* Storage may be disabled; normal network loading still works. */ }
    const key = JSON.stringify([event.request.url, event.request.credentials, event.request.mode, [...event.request.headers]]);
    if (!pending.has(key)) {
      let stored = Promise.resolve();
      const request = fetch(event.request).then((response) => {
        if (cache && response.ok && queuedWrites < 12) {
          queuedWrites += 1;
          const copy = response.clone();
          writes = writes.then(() => store(cache, event.request, copy)).catch(() => {}).finally(() => { queuedWrites -= 1; });
          stored = writes;
          event.waitUntil(writes);
        }
        return response;
      });
      pending.set(key, request);
      event.waitUntil(request.then(() => stored).catch(() => {}).finally(() => pending.delete(key)));
    }
    try { return (await pending.get(key)).clone(); }
    catch (error) {
      if (cached) return cached;
      throw error;
    }
  })());
});

self.addEventListener('message', (event) => {
  if (!['map-cache-stats', 'clear-map-cache'].includes(event.data?.type)) return;
  event.waitUntil((async () => {
    try {
      await writes;
      if (event.data.type === 'clear-map-cache') await caches.delete(CACHE_NAME);
      const items = await entries(await caches.open(CACHE_NAME));
      event.source?.postMessage({ type: 'map-cache-stats', entries: items.length, bytes: items.reduce((sum, item) => sum + item.bytes, 0) });
    } catch {
      event.source?.postMessage({ type: 'map-cache-stats', entries: 0, bytes: 0 });
    }
  })());
});
