import { AGENT_SOCKET_URL, API_BASE_URL, apiPath } from './config.js';

const TILE_ZOOM = 14;
const ACCENT = '#c4d798';
const PREVIEW_LAYER = 'local-buildings-preview';
const TERRAIN_SOURCE = 'local-terrain-dem';
const TERRAIN_TILE_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
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

function applyMonochrome(map, theme, mode = 'route') {
  const dark = theme === 'dark' || mode !== 'terrain';
  const satellite = mode === 'satellite';
  const terrain = mode === 'terrain';
  const colors = dark
    ? { background: '#111113', land: '#18181b', park: '#202123', water: '#0b0c0e', line: '#3b3b40', text: '#c9c9c6', halo: '#111113' }
    : { background: '#e8e5dc', land: '#e8e5dc', park: '#deded1', water: '#d2d6d2', line: '#a39f93', text: '#57574e', halo: '#e8e5dc' };
  for (const layer of map.getStyle().layers || []) {
    if (layer.id.startsWith('local-') || layer.id.startsWith('geo-')) continue;
    const id = layer.id.toLowerCase();
    try {
      map.setLayoutProperty(layer.id, 'visibility', satellite && ['background', 'fill', 'fill-extrusion'].includes(layer.type) ? 'none' : 'visible');
      if (id.includes('building')) map.setLayoutProperty(layer.id, 'visibility', mode === 'route' ? 'visible' : 'none');
      if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', colors.background);
      if (layer.type === 'fill') {
        const color = id.includes('water') ? colors.water : /park|wood|grass|landcover/.test(id) ? colors.park : colors.land;
        map.setPaintProperty(layer.id, 'fill-color', color);
        map.setPaintProperty(layer.id, 'fill-outline-color', color);
      }
      if (layer.type === 'line') {
        map.setPaintProperty(layer.id, 'line-color', satellite ? '#d3d5c6' : colors.line);
        map.setPaintProperty(layer.id, 'line-opacity', satellite ? 0.18 : terrain ? 0.45 : 0.85);
      }
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
  const buildingColor = satellite ? '#b9bdae' : dark ? '#343638' : '#b4b2a8';
  for (const id of [PREVIEW_LAYER, 'local-buildings', 'local-buildings-inferred']) {
    if (map.getLayer(id)) map.setPaintProperty(id, 'fill-extrusion-color', buildingColor);
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
  }
  for (const id of ['local-selection', 'local-hover']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', satellite ? 'none' : 'visible');
  }
  for (const id of ['local-water', 'local-park', 'local-road']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', satellite ? 'none' : 'visible');
  }
  if (map.getLayer('local-satellite')) map.setLayoutProperty('local-satellite', 'visibility', satellite ? 'visible' : 'none');
  for (const id of ['local-hillshade', 'local-contours', 'local-contour-labels']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', terrain ? 'visible' : 'none');
  }
  if (map.getLayer('local-hillshade')) {
    map.setPaintProperty('local-hillshade', 'hillshade-shadow-color', dark ? '#000000' : '#5b574f');
    map.setPaintProperty('local-hillshade', 'hillshade-highlight-color', dark ? '#72776f' : '#fffdf3');
    map.setPaintProperty('local-hillshade', 'hillshade-accent-color', dark ? '#242722' : '#a8a393');
  }
  if (map.getLayer('local-contours')) map.setPaintProperty('local-contours', 'line-color', dark ? '#969b8e' : '#827c6d');
  if (map.getLayer('local-contour-labels')) {
    map.setPaintProperty('local-contour-labels', 'text-color', dark ? '#a8ac9f' : '#716b5d');
    map.setPaintProperty('local-contour-labels', 'text-halo-color', colors.background);
  }
  const routeColor = terrain && !dark ? '#343830' : '#ffffff';
  for (const [id, property, color] of [
    ['geo-route', 'line-color', routeColor], ['geo-route-casing', 'line-color', dark ? '#101310' : '#faf9f2'],
    ['geo-route-search', 'line-color', '#9ba88a'], ['geo-route-search-casing', 'line-color', dark ? '#333a30' : '#f8f7ef'],
    ['geo-pin-label', 'text-color', '#1a2117'], ['geo-route-stop-label', 'text-color', '#1a2117'],
    ['local-search-result-label', 'text-color', colors.text], ['local-search-result-label', 'text-halo-color', colors.halo],
  ]) if (map.getLayer(id)) map.setPaintProperty(id, property, color);
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
  map.addLayer({ id: 'geo-route-casing', type: 'line', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#101310', 'line-width': 9, 'line-opacity': 0.6 } });
  map.addLayer({ id: 'geo-route', type: 'line', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route'], layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': 5, 'line-opacity': 1 } });
  map.addLayer({ id: 'geo-pin', type: 'circle', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'pin'], paint: { 'circle-radius': 7, 'circle-color': ACCENT, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'geo-pin-label', type: 'symbol', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'pin'], layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#ffffff' } });
  map.addLayer({ id: 'geo-route-stop-halo', type: 'circle', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route-stop'], paint: { 'circle-radius': 13, 'circle-color': ACCENT, 'circle-opacity': 0.18 } });
  map.addLayer({ id: 'geo-route-stop', type: 'circle', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route-stop'], paint: { 'circle-radius': 9, 'circle-color': ACCENT, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'geo-route-stop-label', type: 'symbol', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route-stop'], layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#ffffff' } });
  map.addLayer({ id: 'local-search-result-halo', type: 'circle', source: SEARCH_RESULTS_SOURCE, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 8, 15, 15], 'circle-color': '#e6953f', 'circle-opacity': 0.18 } });
  map.addLayer({ id: 'local-search-result', type: 'circle', source: SEARCH_RESULTS_SOURCE, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 4, 15, 6.5], 'circle-color': '#e6953f', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.25, 'circle-opacity': 0.95 } });
  map.addLayer({ id: 'local-search-result-label', type: 'symbol', source: SEARCH_RESULTS_SOURCE, minzoom: 13, layout: { 'text-field': ['get', 'name'], 'text-size': 10, 'text-font': ['Open Sans Regular', 'Arial Unicode MS Regular'], 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-max-width': 14 }, paint: { 'text-color': '#374151', 'text-halo-color': '#ffffff', 'text-halo-width': 1.25 } });
}

class CityExplorer {
  constructor() {
    this.elements = Object.fromEntries(['search-input', 'search-form', 'search-loader', 'suggestions', 'region-label', 'status-dot', 'stream-card', 'stream-title', 'stream-count', 'stream-progress', 'stream-buildings', 'stream-source', 'use-location', 'use-approximate-location', 'pin-mode', 'show-area', 'clear-additions', 'route-form', 'route-stops', 'route-stop-count', 'route-plan-hint', 'add-route-stop', 'trace-route', 'pin-list', 'area-list', 'geo-status', 'toggle-geo-tools', 'geo-content', 'toggle-manual-controls', 'manual-controls-content', 'agent-composer', 'agent-input', 'agent-submit', 'agent-cancel', 'agent-question', 'agent-question-text', 'agent-question-choices', 'agent-connection', 'agent-request', 'agent-tool'].map((id) => [id, document.getElementById(id)]));
    this.theme = localStorage.getItem('theme') || 'dark';
    this.mapMode = ['satellite', 'route', 'terrain'].includes(localStorage.getItem('mapMode')) ? localStorage.getItem('mapMode') : 'satellite';
    this.workspaceView = 'explore';
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
    this.terrainEnabled = this.mapMode === 'satellite';
    this.suggestionController = null;
    this.suggestionTimer = null;
    this.routeStopControllers = new Map();
    this.routeStopTimers = new Map();
    this.searchResults = [];
    this.pinMode = false;
    this.geoToolsOpen = false;
    this.manualControlsOpen = false;
    this.geo = { pins: [], areas: [], routeStops: [{ query: '', place: null, suggestions: [] }, { query: '', place: null, suggestions: [] }], route: null, routeAnimation: null, state: {}, context: { lat: null, lon: null, source: 'unknown', accuracy: null } };
    this.activeRouteStopIndex = 0;
    this.routeAnimationFrame = null;
    this.routeAnimationVersion = 0;
    this.agentSessionId = crypto.randomUUID();
    this.agentSocket = null;
    this.agentSocketReady = false;
    this.agentReconnectTimer = null;
    this.agentReconnectAttempts = 0;
    this.agentSubmitting = false;
    this.agentCancelRequested = false;
    this.agentRunId = '';
    this.agentQuestionOpen = false;
    this.agentRequestSerial = 0;
    this.agentPostSerial = 0;
    this.agentActivity = { connection: 'CONNECTING', request: 'Waiting for connection', tool: 'No active tool' };
    this.worker = new Worker(new URL('./tile-worker.js', import.meta.url), { type: 'module' });
    this.setTheme(this.theme);
    this.bindUi();
    this.createMap();
    this.bootstrap();
    this.connectAgentSocket();
    this.updateDashboard();
    this.clockTimer = window.setInterval(() => this.updateClock(), 30_000);
  }

  bindUi() {
    const el = this.elements;
    el['search-form'].addEventListener('submit', (event) => this.submitSearch(event));
    el['search-input'].addEventListener('input', () => this.queueSuggestions());
    el['search-input'].addEventListener('focus', () => { if (this.selected?.name !== el['search-input'].value) this.selected = null; });
    el['toggle-geo-tools'].addEventListener('click', () => this.setGeoToolsOpen(!this.geoToolsOpen));
    el['toggle-manual-controls'].addEventListener('click', () => this.setManualControlsOpen(!this.manualControlsOpen));
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
    el['agent-composer'].addEventListener('submit', (event) => this.submitAgentRequest(event));
    el['agent-cancel'].addEventListener('click', () => this.cancelAgentRequest());
    document.querySelectorAll('[data-map-action]').forEach((button) => button.addEventListener('click', () => this.operate(button.dataset.mapAction)));
    document.addEventListener('keydown', (event) => this.handleShortcut(event));
    this.worker.onmessage = ({ data }) => this.handleWorkerMessage(data);
    const desktop = window.matchMedia('(min-width: 901px)').matches;
    this.setGeoToolsOpen(false);
    this.setManualControlsOpen(desktop);
    el['manual-controls-content'].append(el['stream-card']);
    const sidebar = el['manual-controls-content'].closest('.manual-sidebar');
    sidebar.prepend(document.querySelector('.floating-toolbar'));
    el['manual-controls-content'].prepend(document.querySelector('.map-mode-panel'), document.querySelector('.map-controls'));
    el['manual-controls-content'].append(document.getElementById('map-notice'), document.querySelector('.workspace-metrics'), document.querySelector('.route-summary'), document.getElementById('agent-hud'), el['agent-question']);
    sidebar.append(el['agent-composer']);
    document.querySelectorAll('button[data-map-mode]').forEach((button) => button.addEventListener('click', () => this.setMapMode(button.dataset.mapMode)));
    document.querySelectorAll('button[data-workspace-view]').forEach((button) => button.addEventListener('click', () => this.setWorkspaceView(button.dataset.workspaceView)));
    document.getElementById('theme-toggle')?.addEventListener('click', () => this.setTheme(this.theme === 'dark' ? 'light' : 'dark'));
    document.getElementById('focus-route')?.addEventListener('click', () => this.focusRoute());
    document.getElementById('fullscreen-toggle')?.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch { this.setGeoStatus('Fullscreen is not available in this browser.', true); }
    });
    document.addEventListener('fullscreenchange', () => {
      document.getElementById('fullscreen-toggle')?.setAttribute('aria-pressed', String(Boolean(document.fullscreenElement)));
      this.map?.resize();
    });
    this.renderAgentActivity();
    window.addEventListener('beforeunload', () => {
      window.clearTimeout(this.agentReconnectTimer);
      window.clearInterval(this.clockTimer);
      this.agentSocket?.close();
    });
  }

  setManualControlsOpen(open) {
    this.manualControlsOpen = open;
    const sidebar = this.elements['manual-controls-content'].closest('.manual-sidebar');
    const toggle = this.elements['toggle-manual-controls'];
    sidebar.classList.toggle('is-open', open);
    sidebar.classList.toggle('is-collapsed', !open);
    document.documentElement.dataset.sidebar = open ? 'open' : 'closed';
    toggle.setAttribute('aria-expanded', String(open));
    toggle.querySelector('b').textContent = open ? 'CLOSE' : 'OPEN';
  }

  setGeoToolsOpen(open) {
    this.geoToolsOpen = open;
    const panel = this.elements['geo-content'].closest('.geo-panel');
    const toggle = this.elements['toggle-geo-tools'];
    panel.classList.toggle('is-collapsed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.querySelector('b').textContent = open ? 'CLOSE' : 'OPEN';
  }

  setAgentActivity(activity) {
    this.agentActivity = { ...this.agentActivity, ...activity };
    this.renderAgentActivity();
  }

  renderAgentActivity() {
    const el = this.elements;
    el['agent-connection'].textContent = this.agentActivity.connection;
    el['agent-request'].textContent = this.agentActivity.request;
    el['agent-tool'].textContent = this.agentActivity.tool;
    const active = this.agentSubmitting || Boolean(this.agentRunId);
    const activityPanel = document.getElementById('agent-hud');
    if (active && activityPanel) activityPanel.open = true;
    el['agent-submit'].disabled = !this.agentSocketReady || active;
    el['agent-submit'].textContent = active ? 'WORKING' : 'SEND';
    el['agent-cancel'].classList.toggle('is-hidden', !active);
    el['agent-input'].disabled = active;
  }

  connectAgentSocket() {
    if (this.agentSocket?.readyState === window.WebSocket?.OPEN || this.agentSocket?.readyState === window.WebSocket?.CONNECTING) return;
    window.clearTimeout(this.agentReconnectTimer);
    if (!window.WebSocket) {
      this.setAgentActivity({ connection: 'UNAVAILABLE', request: 'WebSocket is not supported' });
      return;
    }
    this.agentSocketReady = false;
    this.setAgentActivity({ connection: 'CONNECTING', request: this.agentRunId ? 'Connection lost; reconnecting' : 'Waiting for connection' });
    const socket = new window.WebSocket(AGENT_SOCKET_URL);
    this.agentSocket = socket;
    socket.addEventListener('open', () => {
      if (this.agentSocket !== socket) return;
      socket.send(JSON.stringify({ v: 1, type: 'session.open', sessionId: this.agentSessionId }));
      this.setAgentActivity({ connection: 'OPENING' });
    });
    socket.addEventListener('message', (event) => this.handleAgentSocketMessage(socket, event));
    socket.addEventListener('error', () => {
      if (this.agentSocket === socket) this.setAgentActivity({ connection: 'RETRYING' });
    });
    socket.addEventListener('close', () => {
      if (this.agentSocket !== socket) return;
      this.agentSocketReady = false;
      this.agentSocket = null;
      this.renderAgentActivity();
      const delay = Math.min(10000, 500 * 2 ** this.agentReconnectAttempts);
      this.agentReconnectAttempts += 1;
      this.agentReconnectTimer = window.setTimeout(() => this.connectAgentSocket(), delay);
    });
  }

  handleAgentSocketMessage(socket, event) {
    if (this.agentSocket !== socket || typeof event.data !== 'string') return;
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'session.ready' && message.sessionId === this.agentSessionId) {
      this.agentSocketReady = true;
      this.agentReconnectAttempts = 0;
      this.setAgentActivity({ connection: 'READY', request: this.agentRunId ? 'Request in progress' : 'Ready for a map request' });
      return;
    }
    if (message.type === 'error') {
      this.setAgentActivity({ request: String(message.error || 'Socket request failed').slice(0, 160) });
      return;
    }
    if (typeof message.type === 'string' && message.type.startsWith('agent.')) this.handleAgentEvent(message);
  }

  agentEventIsCurrent(runId) {
    return Boolean(runId) && (this.agentSubmitting || !this.agentRunId || this.agentRunId === runId);
  }

  handleAgentEvent(event) {
    const runId = typeof event.runId === 'string' ? event.runId : '';
    if (!this.agentEventIsCurrent(runId)) return;
    if (!this.agentRunId) this.agentRunId = runId;
    if (event.type === 'agent.started') {
      this.agentSubmitting = false;
      this.setAgentActivity({ request: 'Agent request started', tool: 'Preparing map tools' });
      return;
    }
    if (event.type === 'agent.status') {
      this.agentSubmitting = false;
      const label = String(event.label || 'Updating the map').slice(0, 160);
      this.setAgentActivity({ request: 'Request in progress', tool: label });
      return;
    }
    if (event.type === 'agent.map') {
      this.applyAgentMapUpdate(event.update);
      this.setAgentActivity({ request: 'Map updated', tool: 'Map changes applied' });
      return;
    }
    if (event.type === 'agent.question') {
      this.agentSubmitting = false;
      this.agentRunId = '';
      this.agentCancelRequested = false;
      this.agentPostSerial = 0;
      this.showAgentQuestion(event.question, event.choices);
      this.setAgentActivity({ request: 'Waiting for your choice', tool: 'Clarification requested' });
      return;
    }
    if (event.type === 'agent.completed') {
      this.finishAgentRun();
      this.setAgentActivity({ request: String(event.message || 'Map request completed').slice(0, 160), tool: 'Completed' });
      return;
    }
    if (event.type === 'agent.failed') {
      this.finishAgentRun();
      this.setAgentActivity({ request: String(event.error || 'Map request failed').slice(0, 160), tool: 'Failed' });
      return;
    }
    if (event.type === 'agent.cancelled') {
      this.finishAgentRun();
      this.setAgentActivity({ request: 'Request cancelled', tool: 'Cancelled' });
    }
  }

  finishAgentRun() {
    this.agentSubmitting = false;
    this.agentCancelRequested = false;
    this.agentRunId = '';
    this.agentPostSerial = 0;
    this.renderAgentActivity();
  }

  async submitAgentRequest(event) {
    event.preventDefault();
    const message = this.elements['agent-input'].value.trim();
    if (!message) return this.elements['agent-input'].focus();
    await this.startAgentRequest(message);
  }

  async startAgentRequest(message) {
    if (this.agentSubmitting || this.agentRunId) return;
    if (!this.agentSocketReady) {
      this.setAgentActivity({ request: 'Waiting for the agent connection' });
      this.connectAgentSocket();
      return;
    }
    this.agentQuestionOpen = false;
    this.elements['agent-question'].classList.add('is-hidden');
    this.agentSubmitting = true;
    this.agentCancelRequested = false;
    const requestSerial = ++this.agentRequestSerial;
    this.agentPostSerial = requestSerial;
    this.setAgentActivity({ request: 'Sending request', tool: 'Waiting for agent' });
    try {
      const response = await postJson('/api/agent/runs', {
        sessionId: this.agentSessionId,
        message: message.slice(0, 2000),
        mapContext: this.agentMapContext(),
      });
      if (!response.accepted || typeof response.runId !== 'string') throw new Error('The agent request was not accepted.');
      if (this.agentPostSerial !== requestSerial) return;
      this.agentSubmitting = false;
      this.agentRunId = this.agentRunId || response.runId;
      this.elements['agent-input'].value = '';
      this.setAgentActivity({ request: 'Request in progress' });
      if (this.agentCancelRequested) this.sendAgentCancel();
    } catch (error) {
      if (this.agentPostSerial !== requestSerial) return;
      this.finishAgentRun();
      this.setAgentActivity({ request: String(error.message || 'Could not start the map agent.').slice(0, 160), tool: 'Request failed' });
    }
  }

  cancelAgentRequest() {
    if (this.agentQuestionOpen) {
      this.agentQuestionOpen = false;
      this.elements['agent-question'].classList.add('is-hidden');
      this.setAgentActivity({ request: 'Clarification dismissed', tool: 'No active tool' });
      return;
    }
    if (!this.agentSubmitting && !this.agentRunId) return;
    this.agentCancelRequested = true;
    this.setAgentActivity({ request: 'Cancelling request', tool: 'Waiting for cancellation' });
    this.sendAgentCancel();
  }

  sendAgentCancel() {
    if (!this.agentRunId || !this.agentSocketReady || this.agentSocket?.readyState !== window.WebSocket.OPEN) return;
    this.agentSocket.send(JSON.stringify({ v: 1, type: 'agent.cancel', runId: this.agentRunId }));
  }

  showAgentQuestion(question, choices) {
    const safeQuestion = String(question || '').trim().slice(0, 300);
    const safeChoices = Array.isArray(choices) ? [...new Set(choices.map((choice) => String(choice || '').trim()).filter(Boolean))].slice(0, 4) : [];
    if (!safeQuestion || safeChoices.length < 2) return;
    this.agentQuestionOpen = true;
    this.elements['agent-question-text'].textContent = safeQuestion;
    const container = this.elements['agent-question-choices'];
    container.replaceChildren();
    for (const choice of safeChoices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = choice;
      button.addEventListener('click', () => this.startAgentRequest(choice));
      container.append(button);
    }
    this.elements['agent-question'].classList.remove('is-hidden');
  }

  agentMapContext() {
    const point = (value) => {
      const lon = numeric(value?.lon);
      const lat = numeric(value?.lat);
      return lon === null || lat === null ? null : { id: String(value?.id || '').slice(0, 180), name: String(value?.name || '').slice(0, 160), countryCode: String(value?.countryCode || '').slice(0, 2), lon: Number(lon.toFixed(6)), lat: Number(lat.toFixed(6)) };
    };
    const view = this.map;
    const center = view?.getCenter?.();
    const bounds = view?.getBounds?.();
    const areaBounds = (area) => {
      const positions = geometryPositions(area.geometry).filter((position) => Array.isArray(position) && numeric(position[0]) !== null && numeric(position[1]) !== null).slice(0, 200);
      if (!positions.length) return null;
      const lons = positions.map((position) => Number(position[0]));
      const lats = positions.map((position) => Number(position[1]));
      return [Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)].map((value) => Number(value.toFixed(6)));
    };
    const selectedCity = point(this.selected);
    const selectedBbox = Array.isArray(this.selected?.bbox) && this.selected.bbox.length === 4 && this.selected.bbox.every((value) => numeric(value) !== null)
      ? this.selected.bbox.map((value) => Number(Number(value).toFixed(6)))
      : undefined;
    return {
      selectedCity: selectedCity ? { ...selectedCity, shortName: String(this.selected.shortName || this.selected.name || '').slice(0, 160), country: String(this.selected.country || '').slice(0, 120), bbox: selectedBbox } : null,
      center: center ? [Number(center.lng.toFixed(6)), Number(center.lat.toFixed(6))] : undefined,
      bounds: bounds ? [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map((value) => Number(value.toFixed(6))) : undefined,
      zoom: view ? Number(view.getZoom().toFixed(2)) : undefined,
      countryCode: String(this.country.countryCode || '').slice(0, 2),
      routeStops: this.routePlan().filter((stop) => stop.place).slice(0, 12).map((stop) => point(stop.place)).filter(Boolean),
      pins: this.geo.pins.slice(0, 20).map((pin) => point(pin)).filter(Boolean),
      areas: this.geo.areas.slice(0, 8).map((area) => ({ id: String(area.id || '').slice(0, 80), label: String(area.label || '').slice(0, 160), areaSquareMeters: numeric(area.summary?.areaSquareMeters), bounds: areaBounds(area) })).filter((area) => area.bounds),
    };
  }

  agentLocation(value) {
    const lon = numeric(value?.lon);
    const lat = numeric(value?.lat);
    const name = String(value?.name || value?.shortName || '').trim().slice(0, 160);
    if (lon === null || lat === null || lon < -180 || lon > 180 || lat < -90 || lat > 90 || !name) return null;
    const bbox = Array.isArray(value?.bbox) && value.bbox.length === 4 && value.bbox.every((item) => numeric(item) !== null)
      ? value.bbox.map(Number)
      : [lon, lat, lon, lat];
    return {
      id: String(value.id || `agent:${lon.toFixed(6)},${lat.toFixed(6)}`).slice(0, 180), name,
      shortName: String(value.shortName || name).slice(0, 160), address: String(value.address || '').slice(0, 240),
      country: String(value.country || '').slice(0, 120), countryCode: String(value.countryCode || '').slice(0, 2).toUpperCase(),
      provider: String(value.provider || '').slice(0, 80), lon, lat, bbox,
    };
  }

  agentRoute(value) {
    if (!value || typeof value !== 'object' || value.geometry?.type !== 'LineString' || !Array.isArray(value.geometry.coordinates)) return null;
    const coordinates = value.geometry.coordinates.slice(0, 20_000).map((point) => {
      const lon = numeric(point?.[0]);
      const lat = numeric(point?.[1]);
      return lon === null || lat === null || lon < -180 || lon > 180 || lat < -90 || lat > 90 ? null : [lon, lat];
    }).filter(Boolean);
    if (coordinates.length < 2) return null;
    const waypoints = Array.isArray(value.waypoints) ? value.waypoints.slice(0, MAX_ROUTE_STOPS).map((point) => {
      const lon = numeric(point?.[0]);
      const lat = numeric(point?.[1]);
      return lon === null || lat === null || lon < -180 || lon > 180 || lat < -90 || lat > 90 ? null : [lon, lat];
    }).filter(Boolean) : [];
    return {
      id: String(value.id || 'agent-route').slice(0, 160), provider: String(value.provider || '').slice(0, 80),
      profile: String(value.profile || 'driving').slice(0, 40), waypoints,
      geometry: { type: 'LineString', coordinates }, summary: value.summary && typeof value.summary === 'object' ? value.summary : {},
    };
  }

  agentArea(value) {
    const geometry = value?.geometry;
    if (!geometry || !['Polygon', 'MultiPolygon'].includes(geometry.type) || !Array.isArray(geometry.coordinates)) return null;
    const sanitizeRing = (ring) => {
      if (!Array.isArray(ring)) return null;
      const points = ring.slice(0, 500).map((point) => {
        const lon = numeric(point?.[0]);
        const lat = numeric(point?.[1]);
        return lon === null || lat === null || lon < -180 || lon > 180 || lat < -90 || lat > 90 ? null : [lon, lat];
      }).filter(Boolean);
      return points.length >= 4 ? points : null;
    };
    let coordinates;
    if (geometry.type === 'Polygon') {
      coordinates = geometry.coordinates?.slice(0, 32).map(sanitizeRing).filter(Boolean);
    } else {
      coordinates = geometry.coordinates?.slice(0, 16).map((polygon) => polygon?.slice(0, 32).map(sanitizeRing).filter(Boolean)).filter((polygon) => polygon?.length);
    }
    if (!coordinates?.length) return null;
    return {
      id: String(value.id || '').slice(0, 100), label: String(value.label || 'Measured area').slice(0, 160),
      geometry: { type: geometry.type, coordinates }, summary: value.summary && typeof value.summary === 'object' ? value.summary : {},
    };
  }

  applyWorkspaceSnapshot(workspace) {
    if (!workspace || typeof workspace !== 'object') return;
    this.geo.pins = (Array.isArray(workspace.pins) ? workspace.pins : []).slice(0, 100).map((pin) => {
      const location = this.agentLocation(pin);
      return location ? { ...location, label: String(pin.label || '').slice(0, 32) || 'PIN', source: String(pin.source || '').slice(0, 40), placeId: String(pin.placeId || '').slice(0, 180) } : null;
    }).filter(Boolean);
    this.geo.areas = (Array.isArray(workspace.areas) ? workspace.areas : []).slice(0, 32).map((area) => this.agentArea(area)).filter(Boolean);
    this.geo.state = workspace.state && typeof workspace.state === 'object' ? workspace.state : {};
  }

  clearCityData() {
    this.selected = null;
    this.features.clear();
    this.tileFeatures.clear();
    this.tileMetadata.clear();
    this.loaded.clear();
    this.failed.clear();
    this.buildings = 0;
    this.inferred = 0;
    this.total = 0;
    this.generation += 1;
    this.worker.postMessage({ type: 'reset', apiBaseUrl: API_BASE_URL, context: { region: '', lat: 0, lon: 0 }, tiles: [] });
    this.map?.getSource('local-city')?.setData(EMPTY_COLLECTION);
    this.map?.getSource(FOCUS_SOURCE)?.setData(EMPTY_COLLECTION);
    this.map?.getSource(SEARCH_RESULTS_SOURCE)?.setData(EMPTY_COLLECTION);
    this.setStream({ loaded: 0, total: 0, buildings: 0, inferred: 0, active: false, preview: false, source: '', degraded: false });
  }

  clearWorkspaceLocal(clearCity = false) {
    this.geo.pins = [];
    this.geo.areas = [];
    this.stopRouteAnimation(false);
    this.geo.route = null;
    this.geo.routeStops = [{ query: '', place: null, suggestions: [] }, { query: '', place: null, suggestions: [] }];
    this.geo.state = {};
    this.searchResults = [];
    if (clearCity) {
      this.geo.context = { lat: null, lon: null, source: 'unknown', accuracy: null };
      this.clearCityData();
      this.elements['search-input'].value = '';
    }
    this.renderWorkspace();
    this.renderGeography();
    this.renderSearchResults();
    this.updateIntroCard();
  }

  applyAgentView(view) {
    if (!view || typeof view !== 'object' || !this.map) return;
    if (Array.isArray(view.bounds) && view.bounds.length === 4 && view.bounds.every((value) => numeric(value) !== null)) {
      const [west, south, east, north] = view.bounds.map(Number);
      if (west >= -180 && east <= 180 && south >= -90 && north <= 90 && west < east && south < north) {
        this.map.fitBounds([[west, south], [east, north]], { padding: 90, maxZoom: 16, duration: 800, essential: true });
        return;
      }
    }
    if (Array.isArray(view.center) && view.center.length >= 2 && numeric(view.center[0]) !== null && numeric(view.center[1]) !== null) {
      const zoom = numeric(view.zoom);
      this.map.flyTo({ center: [Number(view.center[0]), Number(view.center[1])], zoom: zoom === null ? Math.max(12, this.map.getZoom()) : Math.max(1, Math.min(20, zoom)), duration: 700, essential: true });
    }
  }

  applyAgentMapUpdate(update) {
    if (!update || typeof update !== 'object') return;
    if (update.clear === true) {
      this.clearWorkspaceLocal(false);
      this.setGeoStatus('The map agent cleared the workspace.');
      return;
    }
    const selected = this.agentLocation(update.selectedCity);
    if (selected) this.chooseLocation(selected);
    if (Array.isArray(update.places)) {
      this.searchResults = update.places.slice(0, 20).map((place) => this.agentLocation(place)).filter(Boolean);
    }
    if (Array.isArray(update.routeStops)) {
      this.geo.routeStops = update.routeStops.slice(0, MAX_ROUTE_STOPS).map((place) => this.agentLocation(place)).filter(Boolean).map((place) => ({ query: place.name, place, suggestions: [] }));
    }
    if (Object.prototype.hasOwnProperty.call(update, 'route')) this.geo.route = this.agentRoute(update.route);
    if (update.workspace) this.applyWorkspaceSnapshot(update.workspace);
    this.routePlan();
    this.renderWorkspace();
    this.renderGeography();
    this.renderSearchResults();
    this.updateIntroCard();
    this.applyAgentView(update.view);
  }

  createMap() {
    if (window.mlcontour) {
      this.contourDem = new window.mlcontour.DemSource({ url: TERRAIN_TILE_URL, encoding: 'terrarium', maxzoom: 13, worker: true });
      this.contourDem.setupMaplibre(window.maplibregl);
    }
    this.map = new window.maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/positron', center: [-122.48, 37.82], zoom: 11, pitch: this.terrainEnabled ? 45 : 0, bearing: -12, maxPitch: 78, attributionControl: false, antialias: true });
    this.map.addControl(new window.maplibregl.AttributionControl({ compact: true }), 'bottom-right');
    this.map.addControl(new window.maplibregl.ScaleControl({ maxWidth: 100, unit: 'metric' }), 'bottom-left');
    this.map.on('style.load', () => {
      this.addTerrainSource();
      this.applyTerrain();
      this.addCartographyLayers();
      addLocalLayers(this.map, this.theme);
      this.applyMapMode();
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
      this.updateDashboard();
      if (this.selected && this.map.getZoom() >= 13) this.worker.postMessage({ type: 'append', tiles: visibleTiles(this.map) });
    });
    this.map.on('error', (event) => {
      const source = event.sourceId || event.error?.sourceId;
      if (source === 'local-imagery') {
        this.imageryUnavailable = true;
        if (this.mapMode === 'satellite') this.setMapMode('route');
        this.showMapNotice('Satellite imagery is unavailable. Showing the street map.');
      } else if (source === 'local-contour-source' || source === TERRAIN_SOURCE) {
        this.showMapNotice('Some elevation data is unavailable. Map navigation remains active.');
      }
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

  addCartographyLayers() {
    const layers = this.map.getStyle().layers || [];
    const firstLayer = layers.find((layer) => layer.type !== 'background')?.id;
    const lastFill = layers.reduce((index, layer, current) => layer.type === 'fill' ? current : index, -1);
    const firstLine = layers.slice(lastFill + 1).find((layer) => layer.type === 'line' || layer.type === 'symbol')?.id;
    this.map.addSource('local-imagery', {
      type: 'raster', tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'], tileSize: 256, maxzoom: 19,
      attribution: 'Imagery &copy; <a href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9">Esri, Vantor, Earthstar Geographics, GIS User Community</a>',
    });
    this.map.addLayer({ id: 'local-satellite', type: 'raster', source: 'local-imagery', layout: { visibility: this.mapMode === 'satellite' ? 'visible' : 'none' }, paint: { 'raster-saturation': -0.65, 'raster-brightness-max': 0.72, 'raster-contrast': 0.12, 'raster-fade-duration': 300 } }, firstLayer);
    this.map.addLayer({ id: 'local-hillshade', type: 'hillshade', source: TERRAIN_SOURCE, layout: { visibility: 'none' }, paint: { 'hillshade-exaggeration': 0.7, 'hillshade-illumination-direction': 315 } }, firstLine);
    if (!this.contourDem) return;
    this.map.addSource('local-contour-source', {
      type: 'vector', maxzoom: 15,
      tiles: [this.contourDem.contourProtocolUrl({ thresholds: { 8: [200, 1000], 10: [100, 500], 12: [50, 250], 14: [20, 100], 15: [10, 50] }, multiplier: 1, contourLayer: 'contours', elevationKey: 'ele', levelKey: 'level' })],
    });
    this.map.addLayer({ id: 'local-contours', type: 'line', source: 'local-contour-source', 'source-layer': 'contours', layout: { visibility: 'none' }, paint: { 'line-color': '#827c6d', 'line-opacity': 0.55, 'line-width': ['match', ['get', 'level'], 1, 1, 0.45] } }, firstLine);
    this.map.addLayer({ id: 'local-contour-labels', type: 'symbol', source: 'local-contour-source', 'source-layer': 'contours', filter: ['>', ['get', 'level'], 0], layout: { visibility: 'none', 'symbol-placement': 'line', 'text-field': ['concat', ['to-string', ['get', 'ele']], ' m'], 'text-font': ['Open Sans Regular'], 'text-size': 9, 'symbol-spacing': 350 }, paint: { 'text-color': '#716b5d', 'text-halo-color': '#e8e5dc', 'text-halo-width': 1 } });
  }

  showMapNotice(message) {
    const notice = document.getElementById('map-notice');
    if (!notice) return;
    notice.textContent = message;
    notice.classList.remove('is-hidden');
  }

  applyMapMode() {
    document.documentElement.dataset.mapMode = this.mapMode;
    document.querySelectorAll('button[data-map-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.mapMode === this.mapMode)));
    if (this.map?.isStyleLoaded() || this.map?.getLayer('geo-route')) {
      applyMonochrome(this.map, this.theme, this.mapMode);
      if (this.map.getLayer(PREVIEW_LAYER)) this.map.setLayoutProperty(PREVIEW_LAYER, 'visibility', 'none');
    }
    this.updateDashboard();
  }

  setMapMode(mode) {
    if (!['satellite', 'route', 'terrain'].includes(mode)) return;
    if (mode === 'satellite' && this.imageryUnavailable) {
      this.showMapNotice('Satellite service is unavailable. Choose another view or reload to retry.');
      return;
    }
    this.mapMode = mode;
    localStorage.setItem('mapMode', mode);
    document.getElementById('map-notice')?.classList.add('is-hidden');
    this.applyMapMode();
    this.setTerrainView(mode === 'satellite');
    if (mode === 'terrain' && !this.contourDem) this.showMapNotice('Contour library unavailable. Showing shaded terrain only.');
  }

  setWorkspaceView(view) {
    this.workspaceView = view;
    document.querySelectorAll('button[data-workspace-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.workspaceView === view)));
    this.setManualControlsOpen(true);
    this.setGeoToolsOpen(view !== 'explore');
    const utility = document.querySelector('.utility-tools');
    if (utility) utility.open = view === 'workspace';
    if (view === 'routes') this.setMapMode('route');
    if (view === 'explore') this.elements['search-input'].focus();
    this.updateDashboard();
  }

  updateClock() {
    const clock = document.getElementById('dashboard-clock');
    if (clock) clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  updateDashboard() {
    const set = (id, value) => { const element = document.getElementById(id); if (element) element.textContent = value; };
    const summary = this.geo.route?.summary;
    document.documentElement.dataset.workspaceView = this.workspaceView;
    document.documentElement.dataset.hasRoute = String(Boolean(this.geo.route));
    set('metric-pins', this.geo.pins.length);
    set('metric-areas', this.geo.areas.filter((area) => !area.summary?.invalid).length);
    set('metric-buildings', this.buildings.toLocaleString());
    set('metric-distance', summary ? formatDistance(summary.distanceMeters) || '--' : '--');
    const distance = document.getElementById('metric-distance');
    if (distance && summary) {
      const parts = distance.textContent.split(' ');
      if (parts.length === 2) {
        const unit = document.createElement('span');
        unit.className = 'metric-unit';
        unit.textContent = ` ${parts[1]}`;
        distance.replaceChildren(document.createTextNode(parts[0]), unit);
      }
    }
    set('metric-duration', summary ? formatDuration(summary.durationSeconds) || '--' : '--');
    set('metric-stops', this.geo.routeStops.filter((stop) => stop.place).length);
    set('metric-provider', this.geo.route ? sourceName(this.geo.route.provider) || 'Road network' : 'No active route');
    set('view-location', this.selected?.name || 'Find a place. Make it yours.');
    set('view-title', this.workspaceView === 'routes' ? 'Route Planner' : this.workspaceView === 'workspace' ? 'Your Workspace' : this.mapMode === 'terrain' ? 'Terrain Explorer' : 'City Explorer');
    set('view-mode-label', this.mapMode === 'satellite' ? 'Satellite / Live map' : this.mapMode === 'route' ? 'Monochrome / Route map' : 'Topographic / Contours in meters');
    const center = this.map?.getCenter();
    if (center) set('map-coordinates', `${Math.abs(center.lat).toFixed(4)} ${center.lat < 0 ? 'S' : 'N'} / ${Math.abs(center.lng).toFixed(4)} ${center.lng < 0 ? 'W' : 'E'}`);
    const focus = document.getElementById('focus-route');
    if (focus) focus.disabled = !this.geo.route?.geometry;
    this.updateClock();
  }

  focusRoute() {
    const coordinates = this.geo.route?.geometry?.coordinates || [];
    if (coordinates.length < 2) return;
    const bounds = coordinates.reduce((result, point) => result.extend(point), new window.maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
    const desktop = window.innerWidth > 900;
    this.map.fitBounds(bounds, { padding: desktop ? 60 : { top: 40, right: 30, bottom: 260, left: 30 }, pitch: 0, maxZoom: 16, duration: 800 });
  }

  addTerrainSource() {
    if (!this.map.getSource(TERRAIN_SOURCE)) {
      this.map.addSource(TERRAIN_SOURCE, {
        type: 'raster-dem',
        tiles: [this.contourDem?.sharedDemProtocolUrl || TERRAIN_TILE_URL],
        tileSize: 256,
        maxzoom: this.contourDem ? 13 : 15,
        encoding: 'terrarium',
        attribution: '<a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md">Terrain tiles</a> by Mapzen',
      });
    }
  }

  applyTerrain() {
    if (!this.map?.getSource(TERRAIN_SOURCE)) return;
    const active = this.terrainEnabled && Boolean(this.map?.getSource(TERRAIN_SOURCE));
    try {
      this.map?.setTerrain(active ? { source: TERRAIN_SOURCE, exaggeration: 1.25 } : null);
    } catch {
      // Keep map navigation available when elevation tiles cannot be initialized.
      this.terrainEnabled = false;
    }
    const button = document.querySelector('[data-map-action="pitch"]');
    button?.setAttribute('aria-pressed', String(this.terrainEnabled));
    button?.setAttribute('aria-label', this.terrainEnabled ? 'Disable 3D terrain view' : 'Enable 3D terrain view');
  }

  setTerrainView(enabled, duration = 500) {
    this.terrainEnabled = enabled;
    this.applyTerrain();
    this.map.easeTo({ pitch: this.terrainEnabled ? 60 : 0, duration, essential: true });
  }

  setTheme(theme) {
    this.theme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = this.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', this.theme === 'dark' ? '#111113' : '#ecece8');
    localStorage.setItem('theme', this.theme);
    const toggle = document.getElementById('theme-toggle');
    toggle?.setAttribute('aria-label', `Switch to ${this.theme === 'dark' ? 'light' : 'dark'} mode`);
    toggle?.setAttribute('aria-pressed', String(this.theme === 'light'));
    if (this.map) this.applyMapMode();
  }

  async bootstrap() {
    // Restore additions without allowing an old city to override the user's current map anchor.
    await this.loadWorkspace(false);
    await this.initializeLocation();
  }

  async detectCountry() {
    this.country = { country: '', countryCode: localeCountry(), method: 'locale' };
    this.geo.context = { ...this.geo.context, source: 'locale', countryCode: this.country.countryCode || '' };
    this.renderRegion();
  }

  renderRegion() {
    this.elements['region-label'].textContent = `Search region: ${this.country.country || this.country.countryCode || 'worldwide'} / Geo-IP map anchor`;
    this.elements['status-dot'].classList.remove('pulse');
  }

  async initializeLocation() {
    if (this.initializeLocationFromUrl()) return;
    this.setGeoStatus('Opening your approximate Geo-IP location...');
    try {
      const detected = await ipLocation();
      this.applyIpLocation(detected, { immediate: true });
      this.setGeoStatus(`Opened your approximate Geo-IP location: ${detected.location.name}.`);
    } catch {
      this.detectCountry();
      this.setGeoStatus('Geo-IP location is unavailable. Search for a place to set the map anchor.', true);
    }
  }

  async useApproximateLocation() {
    this.setGeoStatus('Finding an approximate location through the configured IP providers...');
    try {
      const detected = await ipLocation();
      this.applyIpLocation(detected);
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

  applyIpLocation(detected, { immediate = false } = {}) {
    this.country = { ...detected.country, method: 'geoip' };
    this.chooseLocation(detected.location, { source: 'geoip', immediate });
  }

  chooseLocation(location, { source = 'selected', immediate = false } = {}) {
    this.selected = location;
    if (location.countryCode) this.country = { country: location.country || '', countryCode: location.countryCode, method: source };
    this.geo.context = { ...this.geo.context, lat: location.lat, lon: location.lon, source, countryCode: location.countryCode || this.country.countryCode || '' };
    this.elements['search-input'].value = location.name;
    this.renderSuggestions([]);
    this.renderRegion();
    this.setStream({ loaded: 0, total: 9, buildings: 0, inferred: 0, active: true, preview: true, source: '', degraded: false });
    this.resetMapForLocation({ immediate });
    this.updateDashboard();
  }

  resetMapForLocation({ immediate = false } = {}) {
    const location = this.selected;
    this.features.clear(); this.tileFeatures.clear(); this.tileMetadata.clear(); this.loaded.clear(); this.failed.clear();
    this.buildings = 0; this.inferred = 0; this.total = 9; this.previewVisible = true; this.generation += 1;
    this.map.getSource('local-city')?.setData(EMPTY_COLLECTION);
    if (this.map.getLayer(PREVIEW_LAYER)) this.map.setLayoutProperty(PREVIEW_LAYER, 'visibility', 'none');
    if (this.map.getLayer('local-selection')) this.map.setFilter('local-selection', ['==', ['get', 'sourceId'], '__none__']);
    this.map.getSource(FOCUS_SOURCE)?.setData(this.focusFeature(location));
    this.terrainEnabled = this.mapMode === 'satellite';
    this.applyTerrain();
    const camera = { center: [location.lon, location.lat], zoom: this.mapMode === 'terrain' ? 12 : 14, pitch: this.terrainEnabled ? 45 : 0, bearing: this.mapMode === 'route' ? 0 : -12 };
    if (immediate) this.map.jumpTo(camera);
    else this.map.flyTo({ ...camera, duration: 1800, essential: true });
    this.worker.postMessage({ type: 'reset', apiBaseUrl: API_BASE_URL, context: { region: location.id, lat: location.lat, lon: location.lon }, tiles: spiralTiles(location.lon, location.lat, 1) });
  }

  focusFeature(location) {
    return { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [location.lon, location.lat] }, properties: {} }] };
  }

  handleWorkerMessage(data) {
    if (data.generation !== this.generation) return;
    if (data.type === 'queued') {
      if (data.total === 0) return;
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
    if (this.map.getLayer(PREVIEW_LAYER)) this.map.setLayoutProperty(PREVIEW_LAYER, 'visibility', 'none');
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
    this.updateDashboard();
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
    this.updateDashboard();
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
        ? 'Type to reuse previously searched places. Press Enter to search OpenStreetMap first and show every match on the map.'
      : `${selectedCount} stops in order. Use ^ and v to rearrange the plan.`;
  }

  async loadWorkspace(restoreLocation = true) {
    try {
      const workspace = await jsonRequest('/api/workspace');
      this.applyWorkspaceSnapshot(workspace);
      const selected = this.agentLocation(this.geo.state?.context?.selectedCity);
      if (selected && restoreLocation) this.chooseLocation(selected);
      const routeId = typeof this.geo.state?.routeId === 'string' ? this.geo.state.routeId : '';
      if (routeId) {
        try {
          const response = await jsonRequest(`/api/routes/${encodeURIComponent(routeId)}`);
          this.geo.route = this.agentRoute(response.route);
          if (this.geo.route) {
            const pinsById = new Map(this.geo.pins.map((pin) => [pin.id, pin]));
            const savedStops = Array.isArray(this.geo.state.routePinIds) ? this.geo.state.routePinIds.map((id) => pinsById.get(id)).filter(Boolean) : [];
            const routeStops = savedStops.length >= 2 ? savedStops : this.geo.route.waypoints.map(([lon, lat], index) => ({ id: `route-stop-${index}`, name: `Route stop ${this.routeStopLabel(index)}`, lon, lat }));
            this.geo.routeStops = routeStops.map((place) => ({ query: place.name, place, suggestions: [] }));
          }
        } catch (error) {
          this.geo.route = null;
          this.setGeoStatus(`Saved route could not be restored: ${error.message}`, true);
        }
      }
      this.renderWorkspace();
      this.renderGeography();
      this.renderSearchResults();
      this.updateIntroCard();
      if (this.geo.pins.length || this.geo.areas.length || this.geo.route || (selected && restoreLocation)) this.setGeoStatus('Restored the saved workspace.');
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
    const complete = this.routePlan().every((item) => item.place);
    this.elements['trace-route'].disabled = !complete;
    this.elements['route-stop-count'].textContent = `${this.routePlan().filter((item) => item.place).length} STOPS`;
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
      this.setGeoStatus('Enter at least two characters before searching for places.', true);
      return;
    }
    clearTimeout(this.routeStopTimers.get(index));
    this.routeStopControllers.get(index)?.abort();
    const controller = new AbortController();
    this.routeStopControllers.set(index, controller);
    const params = new URLSearchParams({ q: query });
    const context = this.placeContext();
    if (this.country.countryCode) params.set('countryCode', this.country.countryCode);
    if (context) {
      params.set('lat', String(context.lat));
      params.set('lon', String(context.lon));
    }
    this.setGeoStatus('Searching local and OpenStreetMap places...');
    try {
      const response = await jsonRequest(`/api/places?${params}`, controller.signal);
      if (this.routePlan()[index] !== stop || stop.query !== query) return;
      this.searchResults = Array.isArray(response.results) ? response.results : [];
      this.renderSearchResults();
      stop.suggestions = this.searchResults;
      this.renderRouteStopSuggestions(index);
      const source = response.source === 'serpapi' ? 'Serp fallback' : 'OpenStreetMap';
      const fallback = response.fallbackReason ? ` after ${response.fallbackReason.replaceAll('-', ' ')}` : '';
      this.setGeoStatus(this.searchResults.length
        ? `${source} returned ${this.searchResults.length} place${this.searchResults.length === 1 ? '' : 's'}${fallback}; every result is marked on the map.`
        : `${source} returned no places for that search.`, !this.searchResults.length);
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
      this.focusRoute();
    } catch (error) {
      this.setGeoStatus(error.message, true);
    }
  }

  async clearAdditions() {
    try {
      await deleteRequest('/api/workspace');
      this.clearWorkspaceLocal(false);
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
      this.setManualControlsOpen(true);
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
    if (action === 'pitch') this.setTerrainView(!this.terrainEnabled);
    if (action === 'reset' && this.selected) {
      this.map.flyTo({ center: [this.selected.lon, this.selected.lat], zoom: this.mapMode === 'terrain' ? 12 : 14, pitch: this.terrainEnabled ? 45 : 0, bearing: this.mapMode === 'route' ? 0 : -12 });
    }
  }
}

window.addEventListener('DOMContentLoaded', () => new CityExplorer());
