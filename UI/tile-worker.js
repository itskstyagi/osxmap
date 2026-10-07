let generation = 0;
let queue = [];
let processing = false;
let requestContext = null;
let apiBaseUrl = '';
let activeController = null;
const queued = new Set();
const retries = new Set();

function headerNumber(response, name) {
  const value = Number.parseInt(response.headers.get(name) || '', 10);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

self.onmessage = (event) => {
  const { type } = event.data;
  if (type === 'reset') {
    generation += 1;
    activeController?.abort();
    retries.forEach((timer) => clearTimeout(timer));
    retries.clear();
    queue = [];
    queued.clear();
    requestContext = event.data.context;
    apiBaseUrl = event.data.apiBaseUrl;
    enqueue(event.data.tiles, generation, false);
  }
  if (type === 'append' && requestContext) enqueue(event.data.tiles, generation, true);
};

function enqueue(tiles, currentGeneration, prioritize) {
  const incoming = [];
  for (const tile of tiles) {
    const key = `${tile.z}/${tile.x}/${tile.y}`;
    if (queued.has(key)) continue;
    queued.add(key);
    incoming.push({ ...tile, key, generation: currentGeneration, attempt: 0 });
  }
  queue = prioritize ? [...incoming, ...queue] : [...queue, ...incoming];
  self.postMessage({ type: 'queued', total: queued.size, added: incoming.length, generation: currentGeneration });
  processQueue();
}

async function processQueue() {
  if (processing) return;
  processing = true;
  while (queue.length) {
    const tile = queue.shift();
    if (tile.generation !== generation) continue;
    const params = new URLSearchParams({ region: requestContext.region, lat: String(requestContext.lat), lon: String(requestContext.lon) });
    try {
      const controller = new AbortController();
      activeController = controller;
      const response = await fetch(`${apiBaseUrl}/api/tiles/${tile.z}/${tile.x}/${tile.y}.geojson?${params}`, { signal: controller.signal });
      if (!response.ok && response.status !== 204) {
        const body = await response.json().catch(() => ({}));
        const requestError = new Error(body.error || `Tile request failed (${response.status})`);
        const retryAfter = Number.parseInt(response.headers.get('Retry-After') || '', 10);
        requestError.retryable = response.status === 429 || response.status >= 500;
        requestError.retryAfter = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0;
        throw requestError;
      }
      const payload = response.status === 204 ? { features: [] } : await response.json();
      if (tile.generation !== generation) continue;
      self.postMessage({
        type: 'tile',
        key: tile.key,
        features: Array.isArray(payload.features) ? payload.features : [],
        generation: tile.generation,
        cached: response.headers.get('X-Cache') === 'HIT',
        source: response.headers.get('X-Data-Source') || 'none',
        stale: response.headers.get('X-Data-Stale') === '1',
        stats: {
          featureCount: headerNumber(response, 'X-Feature-Count'),
          buildingCount: headerNumber(response, 'X-Building-Count'),
          poiCount: headerNumber(response, 'X-Place-Count'),
          inferredBuildingCount: headerNumber(response, 'X-Inferred-Building-Count'),
          modelSampleSize: headerNumber(response, 'X-Height-Model-Sample-Size'),
        },
      });
    } catch (error) {
      if (tile.generation === generation && error.name !== 'AbortError') {
        if ((error instanceof TypeError || error.retryable) && tile.attempt < 3) {
          const delay = error.retryAfter ? Math.min(error.retryAfter * 1000, 300000) : 600 * 2 ** tile.attempt;
          const timer = setTimeout(() => {
            retries.delete(timer);
            if (tile.generation !== generation) return;
            queue.unshift({ ...tile, attempt: tile.attempt + 1 });
            processQueue();
          }, delay);
          retries.add(timer);
        } else {
          queued.delete(tile.key);
          self.postMessage({ type: 'tileError', key: tile.key, message: error.message, generation: tile.generation });
        }
      }
    } finally {
      activeController = null;
    }
  }
  processing = false;
}
