import { API_BASE_URL, apiPath } from './config.js';

const TILE_ZOOM = 14;
const ACCENT = '#315efb';
const PREVIEW_LAYER = 'local-buildings-preview';
const FOCUS_SOURCE = 'local-city-focus';
const GEOGRAPHY_SOURCE = 'local-geography';
const SEARCH_RESULTS_SOURCE = 'local-search-results';
const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };
const MAX_ROUTE_STOPS = 50;

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readable(value) {
  return String(value || '')
    .replace(/[_:/-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function meters(value) {
  const amount = numeric(value);
  return amount !== null && amount > 0 ? `${amount.toLocaleString(undefined, { maximumFractionDigits: 1 })} m` : '';
}

function levelRange(value) {
  const values = Array.isArray(value) ? value : [];
  const [low, high] = values.map(numeric);
  if (low === null || high === null) return '';
  return low === high ? `${low} level${low === 1 ? '' : 's'}` : `${low}-${high} levels`;
}

function heightMethod(properties) {
  const source = String(properties.heightSource || '');
  if (source === 'height') return 'Measured height';
  if (source === 'levels') return 'Calculated from source floors';
  if (source.startsWith('osm-reference-')) return `Matched to OpenStreetMap ${readable(source.slice('osm-reference-'.length))}`;
  if (source === 'hbet-range-neighbor') return 'Estimated from local buildings within the supplied floor range';
  if (source === 'hbet-range-midpoint') return 'Estimated from the supplied floor range';
  if (source === 'inferred' || Number(properties.inferred) === 1) return 'Estimated from building and neighborhood data';
  return source ? readable(source) : '';
}

function heightConfidence(properties) {
  const value = String(properties.heightConfidence || '');
  return value ? `${readable(value)} confidence` : '';
}

function sourceName(value) {
  const source = String(value || '');
  return source === 'openstreetmap' ? 'OpenStreetMap' : source === 'openbuildingmap' ? 'OpenBuildingMap' : source === 'overture' ? 'Overture Maps' : readable(source);
}

function sourceMixLabel(sources, staleTiles, failedTiles) {
  const labels = Object.entries(sources)
    .sort(([first], [second]) => first.localeCompare(second))
    .map(([source, count]) => `${sourceName(source)} ${count} tile${count === 1 ? '' : 's'}`);
  if (staleTiles) labels.push(`${staleTiles} stale`);
  if (failedTiles) labels.push(`${failedTiles} failed`);
  return labels.join(' / ') || 'No detailed tile data';
}

function lonLatToTile(lon, lat, zoom = TILE_ZOOM) {
  const scale = 2 ** zoom;
  const x = Math.floor(((lon + 180) / 360) * scale);
  const radians = (Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2) * scale);
  return { x, y, z: zoom };
}

function spiralTiles(lon, lat, radius = 1) {
  const center = lonLatToTile(lon, lat);
  const tiles = [center];
  for (let ring = 1; ring <= radius; ring += 1) {
    let x = center.x - ring;
    let y = center.y - ring;
    for (; x < center.x + ring; x += 1) tiles.push({ x, y, z: TILE_ZOOM });
    for (; y < center.y + ring; y += 1) tiles.push({ x, y, z: TILE_ZOOM });
    for (; x > center.x - ring; x -= 1) tiles.push({ x, y, z: TILE_ZOOM });
    for (; y > center.y - ring; y -= 1) tiles.push({ x, y, z: TILE_ZOOM });
  }
  return tiles;
}

function visibleTiles(map) {
  const bounds = map.getBounds();
  const northwest = lonLatToTile(bounds.getWest(), bounds.getNorth());
  const southeast = lonLatToTile(bounds.getEast(), bounds.getSouth());
  const center = lonLatToTile(map.getCenter().lng, map.getCenter().lat);
  const tiles = [];
  for (let x = northwest.x; x <= southeast.x; x += 1) for (let y = northwest.y; y <= southeast.y; y += 1) tiles.push({ x, y, z: TILE_ZOOM });
  return tiles.sort((a, b) => Math.hypot(a.x - center.x, a.y - center.y) - Math.hypot(b.x - center.x, b.y - center.y));
}

function localeCountry() {
  const parts = navigator.language?.split('-') || [];
  return parts.length > 1 ? parts.at(-1).toUpperCase() : '';
}

async function jsonRequest(path, options = {}) {
  const request = options instanceof AbortSignal ? { signal: options } : options;
  const response = await fetch(apiPath(path), request);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function postJson(path, body, signal) {
  return jsonRequest(path, { method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function deleteRequest(path) {
  return jsonRequest(path, { method: 'DELETE' });
}

function formatDistance(metersValue) {
  const value = Number(metersValue);
  if (!Number.isFinite(value)) return '';
  return value >= 1000 ? `${(value / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} km` : `${Math.round(value).toLocaleString()} m`;
}

function formatDuration(secondsValue) {
  const seconds = Number(secondsValue);
  if (!Number.isFinite(seconds)) return '';
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

function formatArea(areaSquareMeters) {
  const value = Number(areaSquareMeters);
  if (!Number.isFinite(value) || value <= 0) return 'Area unavailable';
  return value >= 1_000_000 ? `${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} sq km` : `${Math.round(value).toLocaleString()} sq m`;
}

function geometryPositions(geometry) {
  if (geometry?.type === 'Polygon') return geometry.coordinates.flat();
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates.flat(2);
  return [];
}

function partialLineString(geometry, progress) {
  const coordinates = geometry?.type === 'LineString' && Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  if (coordinates.length < 2) return null;
  const clamped = Math.max(0, Math.min(1, progress));
  if (clamped === 0) return null;
  if (clamped === 1) return geometry;
  const lengths = [];
  let total = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const [lonA, latA] = coordinates[index - 1];
    const [lonB, latB] = coordinates[index];
    const length = Math.hypot((lonB - lonA) * Math.cos(((latA + latB) * Math.PI) / 360), latB - latA);
    lengths.push(length);
    total += length;
  }
  if (!total) return { type: 'LineString', coordinates: [coordinates[0], coordinates[1]] };
  const target = total * clamped;
  const result = [coordinates[0]];
  let travelled = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    const length = lengths[index - 1];
    if (travelled + length <= target) {
      result.push(coordinates[index]);
      travelled += length;
      continue;
    }
    const ratio = length ? (target - travelled) / length : 0;
    const [lonA, latA] = coordinates[index - 1];
    const [lonB, latB] = coordinates[index];
    result.push([lonA + (lonB - lonA) * ratio, latA + (latB - latA) * ratio]);
    break;
  }
  return result.length > 1 ? { type: 'LineString', coordinates: result } : { type: 'LineString', coordinates: [coordinates[0], coordinates[1]] };
}

function polygonAreaSquareMeters(coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 4) return 0;
  let total = 0;
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const [lonA, latA] = coordinates[index];
    const [lonB, latB] = coordinates[index + 1];
    const deltaLon = ((((lonB - lonA) + 540) % 360) - 180) * Math.PI / 180;
    total += deltaLon * (2 + Math.sin(latA * Math.PI / 180) + Math.sin(latB * Math.PI / 180));
  }
  return Math.abs(total) * 6_371_008.8 ** 2 / 2;
}

function orientation(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function segmentsIntersect(a, b, c, d) {
  const first = orientation(a, b, c);
  const second = orientation(a, b, d);
  const third = orientation(c, d, a);
  const fourth = orientation(c, d, b);
  return first * second < 0 && third * fourth < 0;
}

function selfIntersectsRing(ring) {
  for (let first = 0; first < ring.length - 1; first += 1) {
    for (let second = first + 1; second < ring.length - 1; second += 1) {
      if (Math.abs(first - second) <= 1 || (first === 0 && second === ring.length - 2)) continue;
      if (segmentsIntersect(ring[first], ring[first + 1], ring[second], ring[second + 1])) return true;
    }
  }
  return false;
}

async function publicJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function ipLocation() {
  const { ip } = await publicJson('https://api.ipify.org?format=json');
  if (typeof ip !== 'string' || !ip) throw new Error('IP address unavailable');
  const response = await publicJson(`https://ip-api.services.brahmai.in/geo/${encodeURIComponent(ip)}`);
  const data = response?.data;
  const lat = Number(data?.lat);
  const lon = Number(data?.lon);
  if (data?.status !== 'success' || !data?.city || !Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error('IP location unavailable');
  const country = String(data.country || '');
  const countryCode = String(data.countryCode || '').toUpperCase();
  return {
    country: { country, countryCode, method: 'ip' },
    location: { id: 'ip-location', name: [data.city, country].filter(Boolean).join(', '), shortName: data.city, country, countryCode, lat, lon, bbox: [lon, lat, lon, lat] },
  };
}

function applyMonochrome(map, theme) {
  const dark = theme === 'dark';
  const colors = dark
    ? { background: '#111113', land: '#18181b', park: '#202123', water: '#0b0c0e', line: '#3b3b40', text: '#c9c9c6', halo: '#111113' }
    : { background: '#ecece8', land: '#e5e5e1', park: '#dcdcd7', water: '#f4f4f0', line: '#b6b6b1', text: '#3a3a3c', halo: '#f1f1ed' };
  for (const layer of map.getStyle().layers || []) {
    if (layer.id.startsWith('local-') || layer.id.startsWith('geo-')) continue;
    const id = layer.id.toLowerCase();
    try {
      if (id.includes('building')) map.setLayoutProperty(layer.id, 'visibility', 'none');
      if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', colors.background);
      if (layer.type === 'fill') {
        const color = id.includes('water') ? colors.water : /park|wood|grass|landcover/.test(id) ? colors.park : colors.land;
        map.setPaintProperty(layer.id, 'fill-color', color);
        map.setPaintProperty(layer.id, 'fill-outline-color', color);
      }
      if (layer.type === 'line') map.setPaintProperty(layer.id, 'line-color', colors.line);
      if (layer.type === 'symbol') {
        map.setPaintProperty(layer.id, 'text-color', colors.text);
        map.setPaintProperty(layer.id, 'text-halo-color', colors.halo);
      }
      if (layer.type === 'circle') map.setPaintProperty(layer.id, 'circle-color', colors.text);
    } catch {
      // External styles may not expose every paint property.
    }
  }
  for (const [id, color] of [['local-water', colors.water], ['local-park', colors.park], ['local-road', colors.line]]) {
    if (map.getLayer(id)) map.setPaintProperty(id, id === 'local-road' ? 'line-color' : 'fill-color', color);
  }
  const buildingColor = dark ? '#e0e0da' : '#38383c';
  for (const id of [PREVIEW_LAYER, 'local-buildings', 'local-buildings-inferred']) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'fill-extrusion-color', buildingColor);
  }
  try {
    map.setFog({
      color: dark ? '#111113' : '#ecece8',
      'high-color': dark ? '#1c1c20' : '#dfdfda',
      'horizon-blend': 0.14,
      range: [0.8, 8],
    });
  } catch {
    // Fog availability depends on the remote base style and projection.
  }
}

function addLocalLayers(map, theme) {
  map.addSource('local-city', { type: 'geojson', data: EMPTY_COLLECTION, generateId: true, tolerance: 0.7, buffer: 32, maxzoom: 18 });
  map.addSource(FOCUS_SOURCE, { type: 'geojson', data: EMPTY_COLLECTION });
  map.addSource(GEOGRAPHY_SOURCE, { type: 'geojson', data: EMPTY_COLLECTION });
  map.addSource(SEARCH_RESULTS_SOURCE, { type: 'geojson', data: EMPTY_COLLECTION });
  const firstSymbol = map.getStyle().layers?.find((layer) => layer.type === 'symbol')?.id;
  map.addLayer({ id: 'local-park', type: 'fill', source: 'local-city', filter: ['==', ['get', 'kind'], 'park'], paint: { 'fill-color': '#dcdcd7', 'fill-opacity': 0.7 } });
  if (map.getSource('openmaptiles')) map.addLayer({
    id: PREVIEW_LAYER, type: 'fill-extrusion', source: 'openmaptiles', 'source-layer': 'building', minzoom: 13,
    filter: ['!=', ['get', 'hide_3d'], true],
    paint: { 'fill-extrusion-color': '#e0e0da', 'fill-extrusion-height': ['case', ['>', ['to-number', ['get', 'render_height'], 0], 1], ['to-number', ['get', 'render_height'], 9], 9], 'fill-extrusion-base': ['to-number', ['get', 'render_min_height'], 0], 'fill-extrusion-opacity': 0.94, 'fill-extrusion-vertical-gradient': false },
  }, firstSymbol);
  map.addLayer({ id: 'local-water', type: 'fill', source: 'local-city', filter: ['==', ['get', 'kind'], 'water'], paint: { 'fill-color': '#f4f4f0', 'fill-opacity': 0.92 } }, firstSymbol);
  map.addLayer({ id: 'local-road', type: 'line', source: 'local-city', filter: ['==', ['get', 'kind'], 'road'], minzoom: 13, paint: { 'line-color': '#a7a7a3', 'line-width': ['interpolate', ['linear'], ['zoom'], 13, 0.4, 17, 2.2], 'line-opacity': 0.72 } }, firstSymbol);
  for (const [id, inferred] of [['local-buildings', 0], ['local-buildings-inferred', 1]]) map.addLayer({
    id, type: 'fill-extrusion', source: 'local-city', filter: ['all', ['==', ['get', 'kind'], 'building'], ['==', ['get', 'inferred'], inferred]], minzoom: 13,
    paint: { 'fill-extrusion-color': '#e0e0da', 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': ['get', 'minHeight'], 'fill-extrusion-opacity': inferred ? 0.62 : 0.94, 'fill-extrusion-vertical-gradient': false },
  }, firstSymbol);
  map.addLayer({ id: 'local-selection', type: 'line', source: 'local-city', filter: ['==', ['get', 'sourceId'], '__none__'], paint: { 'line-color': ACCENT, 'line-width': 3, 'line-opacity': 1 } });
  map.addLayer({ id: 'local-hover', type: 'line', source: 'local-city', filter: ['==', ['get', 'sourceId'], '__none__'], paint: { 'line-color': '#ffffff', 'line-width': 1.5, 'line-opacity': 0.88 } });
  map.addLayer({
    id: 'local-poi-marker', type: 'circle', source: 'local-city', minzoom: 14, filter: ['==', ['get', 'kind'], 'poi'],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 14, 5, 17, 7],
      'circle-color': ['match', ['get', 'poiCategory'], 'health', '#df4e55', 'fuel', '#e6953f', 'education', '#315efb', 'lodging', '#805ad5', 'culture', '#bf5b9f', 'shopping', '#20a071', 'safety', '#d65a39', 'transit', '#1687a7', '#60606a'],
      'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.92,
    },
  });
  map.addLayer({
    id: 'local-poi-code', type: 'symbol', source: 'local-city', minzoom: 14, filter: ['==', ['get', 'kind'], 'poi'],
    layout: { 'text-field': ['match', ['get', 'poiCategory'], 'health', '+', 'fuel', 'F', 'education', 'S', 'lodging', 'H', 'culture', 'M', 'shopping', '$', 'safety', '!', 'transit', 'T', ''], 'text-size': 8, 'text-allow-overlap': true, 'text-ignore-placement': true },
    paint: { 'text-color': '#ffffff' },
  });
  map.addLayer({
    id: 'local-city-focus-halo', type: 'circle', source: FOCUS_SOURCE,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 22, 16, 42], 'circle-color': ACCENT, 'circle-opacity': 0.08, 'circle-blur': 0.25 },
  });
  map.addLayer({
    id: 'local-city-focus-ring', type: 'circle', source: FOCUS_SOURCE,
    paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 12, 11, 16, 21], 'circle-color': ACCENT, 'circle-opacity': 0.06, 'circle-stroke-color': ACCENT, 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.92 },
  });
  map.addLayer({
    id: 'local-city-focus-core', type: 'circle', source: FOCUS_SOURCE,
    paint: { 'circle-radius': 3.5, 'circle-color': ACCENT, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5, 'circle-stroke-opacity': 0.9 },
  });
  map.addLayer({ id: 'geo-area-fill', type: 'fill', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'area'], paint: { 'fill-color': ACCENT, 'fill-opacity': 0.14 } });
  map.addLayer({ id: 'geo-area-outline', type: 'line', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'area'], paint: { 'line-color': ACCENT, 'line-width': 2, 'line-opacity': 0.95 } });
  map.addLayer({ id: 'geo-route-search-casing', type: 'line', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route-search'], paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': ['coalesce', ['get', 'opacity'], 0.72] } });
  map.addLayer({ id: 'geo-route-search', type: 'line', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route-search'], paint: { 'line-color': '#7080a2', 'line-width': 2.5, 'line-opacity': ['coalesce', ['get', 'opacity'], 0.72], 'line-dasharray': [1.5, 1.5] } });
  map.addLayer({ id: 'geo-route-casing', type: 'line', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route'], paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 } });
  map.addLayer({ id: 'geo-route', type: 'line', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route'], paint: { 'line-color': ACCENT, 'line-width': 4, 'line-opacity': 1 } });
  map.addLayer({ id: 'geo-pin', type: 'circle', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'pin'], paint: { 'circle-radius': 7, 'circle-color': ACCENT, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'geo-pin-label', type: 'symbol', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'pin'], layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#ffffff' } });
  map.addLayer({ id: 'geo-route-stop-halo', type: 'circle', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route-stop'], paint: { 'circle-radius': 13, 'circle-color': ACCENT, 'circle-opacity': 0.18 } });
  map.addLayer({ id: 'geo-route-stop', type: 'circle', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route-stop'], paint: { 'circle-radius': 9, 'circle-color': ACCENT, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'geo-route-stop-label', type: 'symbol', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route-stop'], layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#ffffff' } });
  map.addLayer({ id: 'local-search-result-halo', type: 'circle', source: SEARCH_RESULTS_SOURCE, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 8, 15, 15], 'circle-color': '#e6953f', 'circle-opacity': 0.18 } });
  map.addLayer({ id: 'local-search-result', type: 'circle', source: SEARCH_RESULTS_SOURCE, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 4, 15, 6.5], 'circle-color': '#e6953f', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.25, 'circle-opacity': 0.95 } });
  map.addLayer({ id: 'local-search-result-label', type: 'symbol', source: SEARCH_RESULTS_SOURCE, minzoom: 13, layout: { 'text-field': ['get', 'name'], 'text-size': 10, 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'], 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-max-width': 14 }, paint: { 'text-color': '#374151', 'text-halo-color': '#ffffff', 'text-halo-width': 1.25 } });
  applyMonochrome(map, theme);
}

class CityExplorer {
  constructor() {
    this.elements = Object.fromEntries(['search-input', 'search-form', 'search-loader', 'suggestions', 'region-label', 'status-dot', 'stream-card', 'stream-title', 'stream-count', 'stream-progress', 'stream-buildings', 'stream-source', 'intro-card', 'use-location', 'use-approximate-location', 'pin-mode', 'show-area', 'clear-additions', 'route-form', 'route-stops', 'route-stop-count', 'route-plan-hint', 'add-route-stop', 'trace-route', 'pin-list', 'area-list', 'geo-status', 'toggle-geo-tools', 'geo-content'].map((id) => [id, document.getElementById(id)]));
    this.theme = localStorage.getItem('theme') || 'dark';
    this.country = { country: '', countryCode: '', method: 'detecting' };
    this.selected = null;
    this.stream = { loaded: 0, total: 0, buildings: 0, inferred: 0, active: false, preview: false, source: '', degraded: false };
    this.features = new Map();
    this.tileFeatures = new Map();
    this.tileMetadata = new Map();
    this.loaded = new Set();
    this.failed = new Set();
    this.total = 0;
    this.buildings = 0;
    this.generation = 0;
    this.previewVisible = true;
    this.suggestionController = null;
    this.suggestionTimer = null;
    this.routeStopControllers = new Map();
    this.routeStopTimers = new Map();
    this.searchResults = [];
    this.pinMode = false;
    this.geoToolsOpen = false;
    this.geo = { pins: [], areas: [], routeStops: [{ query: '', place: null, suggestions: [] }, { query: '', place: null, suggestions: [] }], route: null, routeAnimation: null, state: {}, context: { lat: null, lon: null, source: 'unknown', accuracy: null } };
    this.activeRouteStopIndex = 0;
    this.routeAnimationFrame = null;
    this.routeAnimationVersion = 0;
    this.worker = new Worker(new URL('./tile-worker.js', import.meta.url), { type: 'module' });
    this.setTheme(this.theme);
    this.bindUi();
    this.createMap();
    this.initializeLocation();
    this.loadWorkspace();
  }

  bindUi() {
    const el = this.elements;
    el['search-form'].addEventListener('submit', (event) => this.submitSearch(event));
    el['search-input'].addEventListener('input', () => this.queueSuggestions());
    el['search-input'].addEventListener('focus', () => { if (this.selected?.name !== el['search-input'].value) this.selected = null; });
    el['toggle-geo-tools'].addEventListener('click', () => this.setGeoToolsOpen(!this.geoToolsOpen));
    el['use-location'].addEventListener('click', () => this.useBrowserLocation());
    el['use-approximate-location'].addEventListener('click', () => this.useApproximateLocation());
    el['pin-mode'].addEventListener('click', () => this.togglePinMode());
    el['show-area'].addEventListener('click', () => this.createPinArea());
    el['clear-additions'].addEventListener('click', () => this.clearAdditions());
    el['route-form'].addEventListener('submit', (event) => {
      if (event.submitter?.id === 'trace-route') this.findRoute(event);
      else {
        event.preventDefault();
        this.searchRouteStop(this.activeRouteStopIndex);
      }
    });
    el['add-route-stop'].addEventListener('click', () => this.addRouteStop());
    document.querySelectorAll('[data-map-action]').forEach((button) => button.addEventListener('click', () => this.operate(button.dataset.mapAction)));
    document.addEventListener('keydown', (event) => this.handleShortcut(event));
    this.worker.onmessage = ({ data }) => this.handleWorkerMessage(data);
    this.setGeoToolsOpen(false);
  }

  setGeoToolsOpen(open) {
    this.geoToolsOpen = open;
    const panel = this.elements['geo-content'].closest('.geo-panel');
    const toggle = this.elements['toggle-geo-tools'];
    panel.classList.toggle('is-collapsed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.querySelector('b').textContent = open ? 'CLOSE' : 'OPEN';
  }

  createMap() {
    this.map = new window.maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/positron', center: [8, 31], zoom: 2.8, pitch: 0, bearing: 0, maxPitch: 78, attributionControl: false, antialias: true });
    this.map.addControl(new window.maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    this.map.on('style.load', () => {
      addLocalLayers(this.map, this.theme);
      if (this.map.getLayer(PREVIEW_LAYER)) this.map.setLayoutProperty(PREVIEW_LAYER, 'visibility', this.previewVisible ? 'visible' : 'none');
      this.map.getSource('local-city')?.setData({ type: 'FeatureCollection', features: [...this.features.values()] });
      this.map.getSource(FOCUS_SOURCE)?.setData(this.selected ? this.focusFeature(this.selected) : EMPTY_COLLECTION);
      this.renderGeography();
      this.renderSearchResults();
      if (this.map.getLayer(PREVIEW_LAYER) && !this.previewBuildingEventsBound) {
        this.map.on('click', PREVIEW_LAYER, (event) => this.showBuilding(event));
        this.map.on('mousemove', PREVIEW_LAYER, (event) => this.hoverBuilding(event));
        this.map.on('mouseenter', PREVIEW_LAYER, () => { this.map.getCanvas().style.cursor = 'pointer'; });
        this.map.on('mouseleave', PREVIEW_LAYER, () => this.clearBuildingHover());
        this.previewBuildingEventsBound = true;
      }
    });
    const buildings = ['local-buildings', 'local-buildings-inferred'];
    this.map.on('click', buildings, (event) => this.showBuilding(event));
    this.map.on('mousemove', buildings, (event) => this.hoverBuilding(event));
    this.map.on('mouseenter', buildings, () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', buildings, () => this.clearBuildingHover());
    this.map.on('click', 'local-poi-marker', (event) => this.showPoi(event));
    this.map.on('mouseenter', 'local-poi-marker', () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', 'local-poi-marker', () => { this.map.getCanvas().style.cursor = ''; });
    this.map.on('click', 'local-search-result', (event) => this.selectSearchResult(event));
    this.map.on('mouseenter', 'local-search-result', () => { this.map.getCanvas().style.cursor = 'pointer'; });
    this.map.on('mouseleave', 'local-search-result', () => { this.map.getCanvas().style.cursor = ''; });
    this.map.on('movestart', () => { if (this.selected && this.map.getZoom() >= 13) this.setPreviewVisible(true); });
    this.map.on('moveend', () => {
      if (this.selected && this.map.getZoom() >= 13) this.worker.postMessage({ type: 'append', tiles: visibleTiles(this.map) });
    });
    this.map.on('dblclick', (event) => {
      if (!this.selected) return;
      event.preventDefault();
      this.operate('reset');
    });
    this.map.on('click', (event) => {
      if (!this.pinMode) return;
      const interactiveLayers = [PREVIEW_LAYER, 'local-buildings', 'local-buildings-inferred', 'local-poi-marker', 'local-search-result', 'geo-pin', 'geo-route-stop', 'geo-area-fill', 'geo-route', 'geo-route-search']
        .filter((layer) => this.map.getLayer(layer));
      if (interactiveLayers.length && this.map.queryRenderedFeatures(event.point, { layers: interactiveLayers }).length) return;
      this.addMapPin(event.lngLat.lng, event.lngLat.lat);
    });
    requestAnimationFrame(() => this.map.resize());
  }

  setTheme(theme) {
    this.theme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = this.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', this.theme === 'dark' ? '#111113' : '#ecece8');
    localStorage.setItem('theme', this.theme);
    if (this.map?.isStyleLoaded()) applyMonochrome(this.map, this.theme);
  }

  async detectCountry() {
    this.country = { country: '', countryCode: localeCountry(), method: 'locale' };
    this.geo.context = { ...this.geo.context, source: 'locale', countryCode: this.country.countryCode || '' };
    this.renderRegion();
  }

  renderRegion() {
    this.elements['region-label'].textContent = `Search region: ${this.country.country || this.country.countryCode || 'worldwide'} / location optional`;
    this.elements['status-dot'].classList.remove('pulse');
  }

  async initializeLocation() {
    if (this.initializeLocationFromUrl()) return;
    this.detectCountry();
  }

  async useApproximateLocation() {
    this.setGeoStatus('Finding an approximate location through the configured IP providers...');
    try {
      const detected = await ipLocation();
      this.country = detected.country;
      this.geo.context = { lat: detected.location.lat, lon: detected.location.lon, accuracy: null, source: 'ip', countryCode: detected.country.countryCode || '' };
      this.renderRegion();
      this.chooseLocation(detected.location);
      this.chooseRouteStop(this.activeRouteStopIndex, { id: 'approximate-location', name: `Approximate location / ${detected.location.name}`, lat: detected.location.lat, lon: detected.location.lon, countryCode: detected.country.countryCode || '' });
      this.setGeoStatus('Added an approximate IP-based location to the route plan.');
    } catch (error) {
      this.setGeoStatus(error.message || 'Approximate location is unavailable.', true);
    }
  }

  initializeLocationFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const city = params.get('city')?.trim();
    const country = params.get('country')?.trim() || params.get('counrty')?.trim();
    if (!city) return false;
    const query = country ? `${city}, ${country}` : city;
    this.elements['search-input'].value = query;
    this.resolveSearch(query, country ? '' : this.country.countryCode);
    return true;
  }

  queueSuggestions() {
    clearTimeout(this.suggestionTimer);
    this.suggestionController?.abort();
    const query = this.elements['search-input'].value.trim();
    if (query.length < 2 || this.selected?.name === query) return this.renderSuggestions([]);
    this.suggestionTimer = setTimeout(async () => {
      this.suggestionController = new AbortController();
      this.setLoading(true);
      try {
        const params = new URLSearchParams({ q: query });
        if (this.country.countryCode) params.set('countryCode', this.country.countryCode);
        const result = await jsonRequest(`/api/suggest?${params}`, this.suggestionController.signal);
        this.renderSuggestions(result.results || []);
      } catch (error) {
        if (error.name !== 'AbortError') this.renderSuggestions([]);
      } finally {
        if (!this.suggestionController.signal.aborted) this.setLoading(false);
      }
    }, 350);
  }

  renderSuggestions(items) {
    const container = this.elements.suggestions;
    container.replaceChildren();
    for (const item of items) {
      const button = document.createElement('button');
      button.type = 'button';
      button.role = 'option';
      button.innerHTML = `<span class="location-swatch" aria-hidden="true"></span><span><strong></strong><small></small></span><b></b>`;
      button.querySelector('strong').textContent = item.shortName || item.name;
      button.querySelector('small').textContent = item.name.replace(`${item.shortName},`, '').trim();
      button.querySelector('b').textContent = item.countryCode;
      button.addEventListener('click', () => this.chooseLocation(item));
      container.append(button);
    }
    container.classList.toggle('is-hidden', !items.length);
    this.elements['search-input'].setAttribute('aria-expanded', String(Boolean(items.length)));
  }

  async submitSearch(event) {
    event.preventDefault();
    const query = this.elements['search-input'].value.trim();
    if (!query) return this.elements['search-input'].focus();
    return this.resolveSearch(query, this.country.countryCode);
  }

  async resolveSearch(query, countryCode = '') {
    this.renderSuggestions([]);
    this.setLoading(true);
    try {
      const params = new URLSearchParams({ q: query });
      if (countryCode) params.set('countryCode', countryCode);
      const response = await jsonRequest(`/api/geocode?${params}`);
      this.chooseLocation(response.result);
    } catch {
      // Leave the submitted location in the search field so it can be corrected or retried.
    } finally {
      this.setLoading(false);
    }
  }

  chooseLocation(location) {
    this.selected = location;
    if (location.countryCode) this.country = { country: location.country || '', countryCode: location.countryCode, method: 'selected' };
    this.geo.context = { ...this.geo.context, lat: location.lat, lon: location.lon, source: 'selected', countryCode: location.countryCode || this.country.countryCode || '' };
    this.elements['search-input'].value = location.name;
    this.renderSuggestions([]);
    this.setStream({ loaded: 0, total: 9, buildings: 0, inferred: 0, active: true, preview: true, source: '', degraded: false });
    this.resetMapForLocation();
  }

  resetMapForLocation() {
    const location = this.selected;
    this.features.clear(); this.tileFeatures.clear(); this.tileMetadata.clear(); this.loaded.clear(); this.failed.clear();
    this.buildings = 0; this.inferred = 0; this.total = 9; this.previewVisible = true; this.generation += 1;
    this.map.getSource('local-city')?.setData(EMPTY_COLLECTION);
    if (this.map.getLayer(PREVIEW_LAYER)) this.map.setLayoutProperty(PREVIEW_LAYER, 'visibility', 'visible');
    if (this.map.getLayer('local-selection')) this.map.setFilter('local-selection', ['==', ['get', 'sourceId'], '__none__']);
    this.map.getSource(FOCUS_SOURCE)?.setData(this.focusFeature(location));
    this.map.flyTo({ center: [location.lon, location.lat], zoom: 15.5, pitch: 60, bearing: -20, duration: 1800, essential: true });
    this.worker.postMessage({ type: 'reset', apiBaseUrl: API_BASE_URL, context: { region: location.id, lat: location.lat, lon: location.lon }, tiles: spiralTiles(location.lon, location.lat, 1) });
  }

  focusFeature(location) {
    return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [location.lon, location.lat] }, properties: {} }] };
  }

  handleWorkerMessage(data) {
    if (data.generation !== this.generation) return;
    if (data.type === 'queued') {
      this.total = Math.max(this.total, data.total);
      if (data.added > 0) this.setPreviewVisible(true);
      this.setStream({ ...this.stream, total: this.total, active: true, preview: this.previewVisible });
      return;
    }
    if (data.type !== 'tile' && data.type !== 'tileError') return;
    this.loaded.add(data.key);
    if (data.type === 'tile') {
      this.failed.delete(data.key);
      this.tileMetadata.set(data.key, { source: data.source, stale: Boolean(data.stale), stats: data.stats || {} });
      this.tileFeatures.delete(data.key);
      this.tileFeatures.set(data.key, data.features);
      this.features.clear(); this.buildings = 0;
      let inferred = 0;
      for (const [tileKey, tileFeatures] of this.tileFeatures) for (const feature of tileFeatures) {
        const properties = feature.properties || {};
        const key = properties.sourceId ? `${properties.source}:${properties.sourceId}:${properties.kind}` : `${tileKey}:${this.features.size}`;
        if (!this.features.has(key) && properties.kind === 'building') {
          this.buildings += 1;
          if (Number(properties.inferred) === 1) inferred += 1;
        }
        this.features.set(key, feature);
      }
      this.map.getSource('local-city')?.setData({ type: 'FeatureCollection', features: [...this.features.values()] });
      this.inferred = inferred;
    } else {
      this.failed.add(data.key);
      this.tileMetadata.delete(data.key);
    }
    const sources = {};
    let staleTiles = 0;
    for (const metadata of this.tileMetadata.values()) {
      if (metadata.source && metadata.source !== 'none') sources[metadata.source] = (sources[metadata.source] || 0) + 1;
      if (metadata.stale) staleTiles += 1;
    }
    if (this.loaded.size >= this.total && this.buildings > 0 && this.failed.size === 0) this.setPreviewVisible(false);
    this.setStream({ loaded: this.loaded.size, total: this.total, buildings: this.buildings, inferred: this.inferred || 0, source: sourceMixLabel(sources, staleTiles, this.failed.size), active: true, preview: this.previewVisible, degraded: this.failed.size > 0 });
  }

  setPreviewVisible(visible) {
    this.previewVisible = visible;
    if (this.map.getLayer(PREVIEW_LAYER)) this.map.setLayoutProperty(PREVIEW_LAYER, 'visibility', visible ? 'visible' : 'none');
  }

  setStream(stream) {
    this.stream = stream;
    const el = this.elements;
    this.updateIntroCard();
    el['stream-card'].classList.toggle('is-hidden', !stream.active);
    el['stream-card'].classList.toggle('is-loading', stream.active && stream.loaded < stream.total);
    if (!stream.active) return;
    el['stream-title'].textContent = stream.degraded ? 'CITY PARTIAL' : stream.loaded < stream.total ? 'ENRICHING CITY' : stream.preview ? 'BASEMAP PREVIEW' : 'CITY READY';
    el['stream-count'].textContent = `${stream.loaded}/${stream.total}`;
    el['stream-progress'].style.width = `${Math.min(100, (stream.loaded / Math.max(stream.total, 1)) * 100)}%`;
    el['stream-buildings'].textContent = stream.preview && stream.buildings === 0 ? 'basemap preview' : `${stream.buildings.toLocaleString()} buildings${stream.inferred ? ` / ${stream.inferred.toLocaleString()} inferred` : ''}`;
    el['stream-source'].textContent = stream.source || 'No detailed tile data';
  }

  updateIntroCard() {
    const hasRouteStop = this.routePlan().some((stop) => Boolean(stop.place));
    this.elements['intro-card'].classList.toggle('is-hidden', Boolean(this.selected) || hasRouteStop);
  }

  setLoading(loading) { this.elements['search-loader'].classList.toggle('is-hidden', !loading); }

  hoverBuilding(event) {
    const feature = event.features?.[0];
    const sourceId = feature?.properties?.sourceId;
    if (sourceId) this.map.setFilter('local-hover', ['==', ['get', 'sourceId'], sourceId]);
    else this.map.setFilter('local-hover', ['==', ['get', 'sourceId'], '__none__']);
  }

  clearBuildingHover() {
    this.map.getCanvas().style.cursor = '';
    this.map.setFilter('local-hover', ['==', ['get', 'sourceId'], '__none__']);
  }

  showBuilding(event) {
    const feature = event.features?.[0];
    if (!feature) return;
    const properties = feature.properties || {};
    const sourceId = properties.sourceId;
    this.map.setFilter('local-selection', ['==', ['get', 'sourceId'], sourceId || '__none__']);
    this.buildingPopup?.remove();
    const content = document.createElement('div');
    content.className = 'building-popup';
    const title = document.createElement('strong');
    const buildingType = String(properties.buildingType || properties.class || 'Building');
    title.textContent = properties.name || (buildingType === 'yes' || buildingType === 'unknown' ? 'Building' : readable(buildingType));
    const type = document.createElement('span');
    type.className = 'popup-type';
    type.textContent = readable(buildingType);
    const details = document.createElement('dl');
    details.className = 'building-details';
    const addDetail = (label, value) => {
      if (!value) return;
      const row = document.createElement('div');
      const term = document.createElement('dt');
      term.textContent = label;
      const definition = document.createElement('dd');
      definition.textContent = value;
      row.append(term, definition);
      details.append(row);
    };
    const height = meters(properties.height ?? properties.render_height);
    const baseHeight = meters(properties.minHeight ?? properties.render_min_height);
    addDetail('Height', height);
    addDetail('Base height', baseHeight);
    addDetail('Floors', numeric(properties.levels)?.toLocaleString());
    addDetail('Estimated floors', levelRange(properties.estimatedLevelRange));
    addDetail('Height method', heightMethod(properties));
    addDetail('Height confidence', heightConfidence(properties));
    addDetail('Height adjustment', Number(properties.heightAdjustedToBase) === 1 ? 'Raised above source base height' : '');
    addDetail('Community', properties.community);
    addDetail('Data source', sourceName(properties.source) || (properties.render_height ? 'OpenStreetMap preview' : 'Open data'));
    addDetail('Record ID', sourceId || properties.osm_id || properties.id);
    addDetail('Map coordinate', `${event.lngLat.lat.toFixed(6)}, ${event.lngLat.lng.toFixed(6)}`);
    const source = document.createElement('span');
    source.className = 'popup-meta';
    source.textContent = 'AVAILABLE BUILDING DATA';
    content.append(title, type, details, source);
    const popup = new window.maplibregl.Popup({ closeButton: true, className: 'mono-popup', offset: 12, maxWidth: '320px' }).setLngLat(event.lngLat).setDOMContent(content).addTo(this.map);
    popup.on('close', () => { if (this.buildingPopup === popup) this.buildingPopup = null; });
    this.buildingPopup = popup;
  }

  showPoi(event) {
    const feature = event.features?.[0];
    if (!feature) return;
    const content = document.createElement('div');
    const category = String(feature.properties.poiCategory || 'place');
    const name = document.createElement('strong');
    name.textContent = feature.properties.name || `${category} place`;
    const type = document.createElement('span');
    type.className = 'popup-type';
    type.textContent = category.replace(/\b\w/g, (letter) => letter.toUpperCase());
    const source = document.createElement('span');
    source.className = 'popup-meta';
    source.textContent = 'OPENSTREETMAP / LOCAL PLACE';
    content.append(name, type, source);
    new window.maplibregl.Popup({ closeButton: false, className: 'mono-popup', offset: 12 }).setLngLat(event.lngLat).setDOMContent(content).addTo(this.map);
  }

  searchResultFeatures() {
    return {
      type: 'FeatureCollection',
      features: this.searchResults.map((place) => ({
        type: 'Feature', geometry: { type: 'Point', coordinates: [place.lon, place.lat] },
        properties: { id: place.id, provider: place.provider, name: place.name, address: place.address || '', countryCode: place.countryCode || '' },
      })),
    };
  }

  renderSearchResults() {
    this.map?.getSource(SEARCH_RESULTS_SOURCE)?.setData(this.searchResultFeatures());
  }

  selectSearchResult(event) {
    const feature = event.features?.[0];
    const coordinates = feature?.geometry?.coordinates;
    if (!feature || !Array.isArray(coordinates) || coordinates.length < 2) return;
    this.chooseRouteStop(this.activeRouteStopIndex, {
      id: feature.properties.id, provider: feature.properties.provider, name: feature.properties.name,
      address: feature.properties.address, countryCode: feature.properties.countryCode,
      lon: Number(coordinates[0]), lat: Number(coordinates[1]),
    });
  }

  routeStopLabel(index) {
    return index < 26 ? String.fromCharCode(65 + index) : String(index + 1);
  }

  routePlan() {
    while (this.geo.routeStops.length < 2) this.geo.routeStops.push({ query: '', place: null, suggestions: [] });
    return this.geo.routeStops;
  }

  geographyFeatures() {
    const features = this.geo.pins.map((pin) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [pin.lon, pin.lat] },
      properties: { overlay: 'pin', id: pin.id, label: pin.label, name: pin.name },
    }));
    for (const [index, stop] of this.routePlan().entries()) {
      if (!stop.place) continue;
      features.push({
        type: 'Feature', geometry: { type: 'Point', coordinates: [stop.place.lon, stop.place.lat] },
        properties: { overlay: 'route-stop', id: `${stop.place.id || 'stop'}-${index}`, label: this.routeStopLabel(index), name: stop.place.name },
      });
    }
    for (const area of this.geo.areas) if (!area.summary?.invalid) features.push({
      type: 'Feature', geometry: area.geometry,
      properties: { overlay: 'area', id: area.id, label: area.label, areaSquareMeters: area.summary?.areaSquareMeters || 0 },
    });
    const animation = this.geo.routeAnimation;
    if (animation && animation.phase !== 'final') {
      const coordinates = animation.edges.slice(0, animation.visible);
      if (coordinates.length) features.push({
        type: 'Feature', geometry: { type: 'MultiLineString', coordinates },
        properties: { overlay: 'route-search', id: `${this.geo.route.id}-search`, opacity: animation.opacity },
      });
    }
    if (this.geo.route?.geometry && (!animation || animation.phase === 'final')) {
      const geometry = animation ? partialLineString(this.geo.route.geometry, animation.progress) : this.geo.route.geometry;
      if (geometry) features.push({
        type: 'Feature', geometry,
        properties: { overlay: 'route', id: this.geo.route.id, temporary: Boolean(this.geo.route.temporary) },
      });
    }
    return { type: 'FeatureCollection', features };
  }

  renderGeography() {
    this.map?.getSource(GEOGRAPHY_SOURCE)?.setData(this.geographyFeatures());
  }

  routeSearchEdges(route) {
    const edges = route.summary?.search?.exploredEdges;
    if (!Array.isArray(edges)) return [];
    return edges.filter((edge) => Array.isArray(edge) && edge.length === 2
      && edge.every((point) => Array.isArray(point) && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]))));
  }

  stopRouteAnimation(render = true) {
    this.routeAnimationVersion += 1;
    if (this.routeAnimationFrame !== null) window.cancelAnimationFrame(this.routeAnimationFrame);
    this.routeAnimationFrame = null;
    this.geo.routeAnimation = null;
    if (render) this.renderGeography();
  }

  animateRoute(route) {
    this.stopRouteAnimation(false);
    const edges = this.routeSearchEdges(route);
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      this.renderGeography();
      return;
    }
    if (!edges.length) {
      this.renderGeography();
      return;
    }
    const animation = { phase: 'tracing', edges, visible: 0, progress: 0, opacity: 0.8, renderedAt: 0 };
    const tracingDuration = Math.min(8000, Math.max(1800, edges.length / 2.5));
    const version = this.routeAnimationVersion;
    let phaseStartedAt = 0;
    this.geo.routeAnimation = animation;
    const frame = (now) => {
      if (version !== this.routeAnimationVersion) return;
      if (!phaseStartedAt) phaseStartedAt = now;
      const elapsed = now - phaseStartedAt;
      if (animation.phase === 'tracing') {
        animation.progress = Math.min(1, elapsed / 1100);
        animation.visible = Math.min(edges.length, Math.ceil(edges.length * elapsed / tracingDuration));
        if (animation.visible === edges.length) {
          animation.phase = 'clearing';
          phaseStartedAt = now;
        }
      } else if (animation.phase === 'clearing') {
        animation.opacity = Math.max(0, 0.8 * (1 - elapsed / 260));
        if (animation.opacity === 0) {
          animation.phase = 'final';
          animation.progress = 0;
          phaseStartedAt = now;
        }
      } else {
        animation.progress = Math.min(1, elapsed / 750);
        if (animation.progress === 1) {
          this.geo.routeAnimation = null;
          this.routeAnimationFrame = null;
          this.renderGeography();
          const { summary } = route;
          const stopCount = Array.isArray(route.waypoints) ? route.waypoints.length : 0;
          this.setGeoStatus(`Shortest OSM road path settled after tracing ${edges.length.toLocaleString()} road segments: ${formatDistance(summary.distanceMeters)} / ${formatDuration(summary.durationSeconds)}${summary.approximateDuration ? ' estimated' : ''}${stopCount ? ` across ${stopCount} stops` : ''}${route.stored ? ' from local storage.' : '.'}`);
          return;
        }
      }
      if (animation.phase !== 'tracing' || animation.visible === edges.length || now - animation.renderedAt >= 40) {
        animation.renderedAt = now;
        this.renderGeography();
      }
      this.routeAnimationFrame = window.requestAnimationFrame(frame);
    };
    this.renderGeography();
    this.routeAnimationFrame = window.requestAnimationFrame(frame);
  }

  setGeoStatus(message, error = false) {
    this.elements['geo-status'].textContent = message;
    this.elements['geo-status'].classList.toggle('is-error', error);
  }

  renderWorkspace() {
    this.renderRoutePlan();
    const pins = this.geo.pins;
    const list = this.elements['pin-list'];
    list.replaceChildren();
    for (const pin of pins) {
      const row = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = pin.label;
      const name = document.createElement('span');
      name.textContent = pin.name;
      const add = document.createElement('button');
      add.type = 'button';
      add.textContent = 'ADD';
      add.setAttribute('aria-label', `Add ${pin.name} to the route plan`);
      add.addEventListener('click', () => this.chooseRouteStop(this.activeRouteStopIndex, { id: pin.id, name: pin.name, lat: pin.lat, lon: pin.lon, countryCode: '' }));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'X';
      remove.setAttribute('aria-label', `Remove ${pin.name}`);
      remove.addEventListener('click', () => this.removePin(pin.id));
      row.append(label, name, add, remove);
      list.append(row);
    }
    const areaList = this.elements['area-list'];
    areaList.replaceChildren();
    for (const area of this.geo.areas) {
      const row = document.createElement('div');
      const kind = document.createElement('strong');
      kind.textContent = 'AREA';
      const name = document.createElement('span');
      name.textContent = area.label;
      const summary = document.createElement('small');
      summary.textContent = area.summary?.invalid ? 'Needs recompute' : formatArea(area.summary?.areaSquareMeters);
      const focus = document.createElement('button');
      focus.type = 'button';
      focus.textContent = 'VIEW';
      focus.addEventListener('click', () => this.focusArea(area));
      const recompute = document.createElement('button');
      recompute.type = 'button';
      recompute.textContent = 'REBUILD';
      recompute.addEventListener('click', () => this.recomputeArea(area));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'X';
      remove.setAttribute('aria-label', `Remove ${area.label}`);
      remove.addEventListener('click', () => this.removeArea(area.id));
      row.append(kind, name, summary, focus, recompute, remove);
      areaList.append(row);
    }
  }

  renderRoutePlan() {
    const plan = this.routePlan();
    const container = this.elements['route-stops'];
    container.replaceChildren();
    for (const [index, stop] of plan.entries()) {
      const row = document.createElement('div');
      row.className = 'route-stop';
      row.dataset.routeStop = String(index);
      const marker = document.createElement('span');
      marker.className = 'route-stop-index';
      marker.textContent = this.routeStopLabel(index);
      const field = document.createElement('div');
      field.className = 'route-stop-field';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = stop.query;
      input.placeholder = index === 0 ? 'Starting point' : index === plan.length - 1 ? 'Destination' : 'Stop';
      input.autocomplete = 'off';
      input.setAttribute('aria-label', `Route stop ${this.routeStopLabel(index)}`);
      input.addEventListener('focus', () => { this.activeRouteStopIndex = index; });
      input.addEventListener('input', () => this.setRouteStopQuery(index, input.value));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.searchRouteStop(index);
        }
        if (event.key === 'Escape') {
          stop.suggestions = [];
          this.renderRouteStopSuggestions(index);
        }
      });
      const suggestions = document.createElement('div');
      suggestions.className = 'route-stop-suggestions is-hidden';
      suggestions.setAttribute('role', 'listbox');
      field.append(input, suggestions);
      const up = document.createElement('button');
      up.type = 'button';
      up.textContent = '^';
      up.disabled = index === 0;
      up.setAttribute('aria-label', `Move stop ${this.routeStopLabel(index)} earlier`);
      up.addEventListener('click', () => this.moveRouteStop(index, -1));
      const down = document.createElement('button');
      down.type = 'button';
      down.textContent = 'v';
      down.disabled = index === plan.length - 1;
      down.setAttribute('aria-label', `Move stop ${this.routeStopLabel(index)} later`);
      down.addEventListener('click', () => this.moveRouteStop(index, 1));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'X';
      remove.setAttribute('aria-label', `Remove stop ${this.routeStopLabel(index)}`);
      remove.addEventListener('click', () => this.removeRouteStop(index));
      row.append(marker, field, up, down, remove);
      container.append(row);
      this.renderRouteStopSuggestions(index);
    }
    const selectedCount = plan.filter((stop) => stop.place).length;
    const complete = selectedCount === plan.length && selectedCount >= 2;
    this.elements['route-stop-count'].textContent = `${selectedCount} STOP${selectedCount === 1 ? '' : 'S'}`;
    this.elements['trace-route'].disabled = !complete;
    this.elements['route-plan-hint'].textContent = !complete
      ? 'Type to reuse previously searched places. Press Enter to search Serp and show every match on the map.'
      : `${selectedCount} stops in order. Use ^ and v to rearrange the plan.`;
  }

  async loadWorkspace() {
    try {
      await deleteRequest('/api/workspace');
      this.geo.pins = [];
      this.geo.areas = [];
      this.geo.routeStops = [{ query: '', place: null, suggestions: [] }, { query: '', place: null, suggestions: [] }];
      this.geo.route = null;
      this.geo.state = {};
      this.searchResults = [];
      this.renderWorkspace();
      this.renderGeography();
      this.renderSearchResults();
    } catch (error) {
      this.setGeoStatus(error.message, true);
    }
  }

  placeContext() {
    const context = this.geo.context;
    if (numeric(context.lat) !== null && numeric(context.lon) !== null) return { lat: Number(context.lat), lon: Number(context.lon) };
    if (this.selected) return { lat: this.selected.lat, lon: this.selected.lon };
    return null;
  }

  setRouteStopQuery(index, query) {
    const stop = this.routePlan()[index];
    if (!stop) return;
    stop.query = query;
    stop.place = null;
    stop.suggestions = [];
    this.stopRouteAnimation(false);
    this.geo.route = null;
    this.renderGeography();
    this.queueRouteStopSuggestions(index, query);
  }

  queueRouteStopSuggestions(index, query) {
    clearTimeout(this.routeStopTimers.get(index));
    this.routeStopControllers.get(index)?.abort();
    if (query.trim().length < 2) return this.renderRouteStopSuggestions(index);
    this.routeStopTimers.set(index, setTimeout(async () => {
      const controller = new AbortController();
      this.routeStopControllers.set(index, controller);
      try {
        const response = await jsonRequest(`/api/places/suggest?${new URLSearchParams({ q: query.trim() })}`, controller.signal);
        const stop = this.routePlan()[index];
        if (!stop || stop.query !== query) return;
        stop.suggestions = Array.isArray(response.results) ? response.results : [];
        this.renderRouteStopSuggestions(index);
      } catch (error) {
        if (error.name !== 'AbortError') this.setGeoStatus(error.message, true);
      }
    }, 180));
  }

  renderRouteStopSuggestions(index) {
    const stop = this.routePlan()[index];
    const container = this.elements['route-stops'].querySelector(`[data-route-stop="${index}"] .route-stop-suggestions`);
    if (!stop || !container) return;
    container.replaceChildren();
    for (const place of stop.suggestions || []) {
      const button = document.createElement('button');
      button.type = 'button';
      const name = document.createElement('strong');
      name.textContent = place.name;
      const address = document.createElement('small');
      address.textContent = place.address || `${Number(place.lat).toFixed(5)}, ${Number(place.lon).toFixed(5)}`;
      button.append(name, address);
      button.addEventListener('click', () => this.chooseRouteStop(index, place));
      container.append(button);
    }
    container.classList.toggle('is-hidden', !container.childElementCount);
  }

  async searchRouteStop(index) {
    const stop = this.routePlan()[index];
    const query = stop?.query.trim() || '';
    if (query.length < 2) {
      this.setGeoStatus('Enter at least two characters before searching Serp.', true);
      return;
    }
    clearTimeout(this.routeStopTimers.get(index));
    this.routeStopControllers.get(index)?.abort();
    const controller = new AbortController();
    this.routeStopControllers.set(index, controller);
    const params = new URLSearchParams({ q: query, provider: 'serp' });
    const context = this.placeContext();
    if (this.country.countryCode) params.set('countryCode', this.country.countryCode);
    if (context) {
      params.set('lat', String(context.lat));
      params.set('lon', String(context.lon));
    }
    this.setGeoStatus('Searching Serp for matching places...');
    try {
      const response = await jsonRequest(`/api/places?${params}`, controller.signal);
      if (this.routePlan()[index] !== stop || stop.query !== query) return;
      this.searchResults = Array.isArray(response.results) ? response.results : [];
      this.renderSearchResults();
      stop.suggestions = this.searchResults;
      this.renderRouteStopSuggestions(index);
      this.setGeoStatus(this.searchResults.length
        ? `Serp returned ${this.searchResults.length} place${this.searchResults.length === 1 ? '' : 's'}; every result is marked on the map.`
        : 'Serp returned no places for that search.', !this.searchResults.length);
    } catch (error) {
      if (error.name !== 'AbortError') this.setGeoStatus(error.message, true);
    }
  }

  chooseRouteStop(index, place) {
    const plan = this.routePlan();
    const targetIndex = plan[index] ? index : plan.findIndex((candidate) => !candidate.place);
    const stop = plan[targetIndex];
    if (!stop || !place) return;
    stop.query = place.name;
    stop.place = place;
    stop.suggestions = [];
    this.stopRouteAnimation(false);
    this.geo.route = null;
    this.geo.context = { lat: place.lat, lon: place.lon, source: 'selected', countryCode: place.countryCode || this.country.countryCode || '' };
    if (place.countryCode) this.country = { ...this.country, countryCode: place.countryCode, method: 'selected' };
    this.renderRegion();
    this.renderWorkspace();
    this.renderGeography();
    this.updateIntroCard();
    this.map.flyTo({ center: [place.lon, place.lat], zoom: Math.max(14, this.map.getZoom()), duration: 600, essential: true });
    this.setGeoStatus(`Added ${place.name} to stop ${this.routeStopLabel(targetIndex)}.`);
  }

  togglePinMode() {
    this.setPinMode(!this.pinMode);
    this.setGeoStatus(this.pinMode ? 'Click an empty map location to add a pin. Press Escape to cancel.' : 'Map pin mode turned off.');
  }

  setPinMode(enabled) {
    this.pinMode = enabled;
    const button = this.elements['pin-mode'];
    button.classList.toggle('is-active', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    button.textContent = enabled ? 'CANCEL PIN MODE' : 'PIN STOP ON MAP';
    this.map.getCanvas().style.cursor = enabled ? 'crosshair' : '';
  }

  async addMapPin(lon, lat) {
    if (!window.confirm(`Add a pin at ${lat.toFixed(5)}, ${lon.toFixed(5)}?`)) {
      this.setGeoStatus('Map pin cancelled.');
      return;
    }
    this.setPinMode(false);
    try {
      const pin = await this.addPin({ name: `Map pin ${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon, source: 'map-click' });
      this.chooseRouteStop(this.activeRouteStopIndex, { id: pin.id, name: pin.name, lat: pin.lat, lon: pin.lon, countryCode: '' });
    } catch (error) {
      this.setGeoStatus(error.message, true);
    }
  }

  async addPin(pin) {
    const response = await postJson('/api/pins', pin);
    this.geo.pins.push(response.pin);
    this.renderWorkspace();
    this.renderGeography();
    return response.pin;
  }

  async removePin(pinId) {
    try {
      await deleteRequest(`/api/pins/${encodeURIComponent(pinId)}`);
      this.geo.pins = this.geo.pins.filter((pin) => pin.id !== pinId);
      this.stopRouteAnimation(false);
      this.geo.route = null;
      this.geo.areas = this.geo.areas.map((area) => area.summary?.pinIds?.includes(pinId)
        ? { ...area, summary: { ...area.summary, invalid: true, invalidReason: 'A referenced pin was removed.' } }
        : area);
      this.renderWorkspace();
      this.renderGeography();
      this.setGeoStatus('Pin removed.');
    } catch (error) {
      this.setGeoStatus(error.message, true);
    }
  }

  async useBrowserLocation() {
    if (!navigator.geolocation) {
      this.setGeoStatus('Browser location is not available.', true);
      return;
    }
    this.setGeoStatus('Requesting browser location...');
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try {
        const context = await jsonRequest(`/api/context?lat=${coords.latitude}&lon=${coords.longitude}`);
        this.country = context.country || this.country;
        this.geo.context = { lat: coords.latitude, lon: coords.longitude, accuracy: coords.accuracy, source: 'browser', countryCode: this.country.countryCode || '' };
        this.renderRegion();
        this.map.flyTo({ center: [coords.longitude, coords.latitude], zoom: Math.max(14, this.map.getZoom()), duration: 800, essential: true });
        this.chooseRouteStop(this.activeRouteStopIndex, { id: `browser:${coords.latitude.toFixed(6)},${coords.longitude.toFixed(6)}`, name: 'My location', lat: coords.latitude, lon: coords.longitude, countryCode: this.country.countryCode || '' });
        this.setGeoStatus(`Added your location to the route plan${coords.accuracy ? ` (about ${Math.round(coords.accuracy)} m accuracy)` : ''}.`);
      } catch (error) {
        this.setGeoStatus(error.message, true);
      }
    }, () => this.setGeoStatus('Browser location permission was not granted.', true), { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
  }

  async createPinArea() {
    const payload = this.pinAreaPayload();
    if (!payload) return;
    try {
      const response = await postJson('/api/areas', payload);
      this.geo.areas.push(response.area);
      this.renderWorkspace();
      this.renderGeography();
      this.setGeoStatus(`Area shown: ${formatArea(payload.summary.areaSquareMeters)}.`);
    } catch (error) {
      this.setGeoStatus(error.message, true);
    }
  }

  pinAreaPayload(label) {
    if (this.geo.pins.length < 3) {
      this.setGeoStatus('Add at least three pins before measuring an area.', true);
      return null;
    }
    const ring = this.geo.pins.map((pin) => [pin.lon, pin.lat]);
    ring.push([...ring[0]]);
    if (selfIntersectsRing(ring)) {
      this.setGeoStatus('These pins cross when joined in creation order. Reorder them by removing and adding them around the boundary.', true);
      return null;
    }
    const areaSquareMeters = polygonAreaSquareMeters(ring);
    return {
      label: label || `Area / ${this.geo.pins.map((pin) => pin.label).join(', ')}`,
      geometry: { type: 'Polygon', coordinates: [ring] },
      summary: { areaSquareMeters, pinIds: this.geo.pins.map((pin) => pin.id) },
    };
  }

  async recomputeArea(area) {
    const payload = this.pinAreaPayload(area.label);
    if (!payload) return;
    try {
      const response = await postJson(`/api/areas/${encodeURIComponent(area.id)}`, payload);
      this.geo.areas = this.geo.areas.map((item) => item.id === area.id ? response.area : item);
      this.renderWorkspace();
      this.renderGeography();
      this.setGeoStatus(`Area rebuilt: ${formatArea(payload.summary.areaSquareMeters)}.`);
    } catch (error) {
      this.setGeoStatus(error.message, true);
    }
  }

  focusArea(area) {
    const coordinates = geometryPositions(area.geometry).filter((position) => Array.isArray(position) && position.length >= 2);
    if (!coordinates.length) return;
    const bounds = coordinates.reduce((result, point) => result.extend(point), new window.maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
    this.map.fitBounds(bounds, { padding: 90, maxZoom: 16, duration: 600, essential: true });
  }

  async removeArea(areaId) {
    try {
      await deleteRequest(`/api/areas/${encodeURIComponent(areaId)}`);
      this.geo.areas = this.geo.areas.filter((area) => area.id !== areaId);
      this.renderWorkspace();
      this.renderGeography();
      this.setGeoStatus('Area removed.');
    } catch (error) {
      this.setGeoStatus(error.message, true);
    }
  }

  addRouteStop() {
    const plan = this.routePlan();
    if (plan.length >= MAX_ROUTE_STOPS) {
      this.setGeoStatus(`A route plan can contain up to ${MAX_ROUTE_STOPS} stops.`, true);
      return;
    }
    plan.push({ query: '', place: null, suggestions: [] });
    this.stopRouteAnimation(false);
    this.geo.route = null;
    this.renderWorkspace();
    this.renderGeography();
    this.elements['route-stops'].querySelector(`[data-route-stop="${plan.length - 1}"] input`)?.focus();
  }

  moveRouteStop(index, direction) {
    const plan = this.routePlan();
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= plan.length) return;
    [plan[index], plan[nextIndex]] = [plan[nextIndex], plan[index]];
    this.stopRouteAnimation(false);
    this.geo.route = null;
    this.renderWorkspace();
    this.renderGeography();
  }

  removeRouteStop(index) {
    const plan = this.routePlan();
    if (plan.length <= 2) plan[index] = { query: '', place: null, suggestions: [] };
    else plan.splice(index, 1);
    this.stopRouteAnimation(false);
    this.geo.route = null;
    this.renderWorkspace();
    this.renderGeography();
  }

  async findRoute(event) {
    event.preventDefault();
    const plan = this.routePlan();
    const stops = plan.map((stop) => stop.place);
    if (stops.length < 2 || stops.some((pin) => !pin)) {
      this.setGeoStatus('Choose a place for every route stop.', true);
      return;
    }
    if (new Set(stops.map((pin) => `${Number(pin.lon).toFixed(7)},${Number(pin.lat).toFixed(7)}`)).size < 2) {
      this.setGeoStatus('Choose at least two different places for a driving route.', true);
      return;
    }
    this.setGeoStatus(`Requesting a ${stops.length}-stop OSM road-network plan...`);
    try {
      const response = await postJson('/api/routes', { profile: 'driving', waypoints: stops.map((pin) => [pin.lon, pin.lat]) });
      this.geo.route = response.route;
      this.renderWorkspace();
      const { summary } = response.route;
      const note = summary.approximateGeometry ? ' External fallback distance shown with an endpoint connector.' : '';
      const searchedEdges = this.routeSearchEdges(response.route).length;
      this.setGeoStatus(summary.approximateGeometry
        ? `${formatDistance(summary.distanceMeters)} / ${formatDuration(summary.durationSeconds)} for this ${stops.length}-stop plan.${note}`
        : searchedEdges
          ? `Replaying Dijkstra across ${searchedEdges.toLocaleString()} explored OSM road segments for this ${stops.length}-stop plan...`
          : `${formatDistance(summary.distanceMeters)} / ${formatDuration(summary.durationSeconds)} from the OSRM fallback for this ${stops.length}-stop plan.`);
      if (searchedEdges) this.animateRoute(response.route);
      else this.renderGeography();
      const coordinates = response.route.geometry?.coordinates || [];
      if (coordinates.length > 1) {
        const bounds = coordinates.reduce((result, point) => result.extend(point), new window.maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
        this.map.fitBounds(bounds, { padding: 90, maxZoom: 16, duration: 800, essential: true });
      }
    } catch (error) {
      this.setGeoStatus(error.message, true);
    }
  }

  async clearAdditions() {
    try {
      await deleteRequest('/api/workspace');
      this.geo.pins = [];
      this.geo.areas = [];
      this.stopRouteAnimation(false);
      this.geo.route = null;
      this.geo.routeStops = [{ query: '', place: null, suggestions: [] }, { query: '', place: null, suggestions: [] }];
      this.geo.state = {};
      this.searchResults = [];
      this.renderWorkspace();
      this.renderGeography();
      this.renderSearchResults();
      this.updateIntroCard();
      this.setGeoStatus('Pins, areas, the route plan, and current search markers were cleared.');
    } catch (error) {
      this.setGeoStatus(error.message, true);
    }
  }

  handleShortcut(event) {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape' && this.pinMode) {
      event.preventDefault();
      this.setPinMode(false);
      this.setGeoStatus('Map pin mode turned off.');
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      this.elements['search-input'].focus();
      return;
    }
    if (event.key.toLowerCase() === 'r') {
      event.preventDefault();
      this.operate('reset');
    }
    if (event.key === '3') {
      event.preventDefault();
      this.operate('pitch');
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      this.operate('in');
    }
    if (event.key === '-') {
      event.preventDefault();
      this.operate('out');
    }
  }

  operate(action) {
    if (!this.map) return;
    if (action === 'in') this.map.zoomIn({ duration: 250 });
    if (action === 'out') this.map.zoomOut({ duration: 250 });
    if (action === 'pitch') this.map.easeTo({ pitch: this.map.getPitch() > 30 ? 0 : 60, duration: 500 });
    if (action === 'reset' && this.selected) this.map.flyTo({ center: [this.selected.lon, this.selected.lat], zoom: 15.5, pitch: 60, bearing: -20 });
  }
}

window.addEventListener('DOMContentLoaded', () => new CityExplorer());
