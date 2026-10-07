import { AGENT_SOCKET_URL, API_BASE_URL, apiPath } from './config.js';
import { MeridianStudio } from './studio.js';

const TILE_ZOOM = 14;
const ACCENT = '#d0dac5';
const PREVIEW_LAYER = 'local-buildings-preview';
const TERRAIN_SOURCE = 'local-terrain-dem';
const TERRAIN_TILE_URL = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png';
const IMAGERY_TILE_URL = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const REGIONAL_IMAGERY = {
  date: '2026-09-30', bounds: [-122.8, 37.6, -122.15, 38.05],
  tiles: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/HLS_S30_Nadir_BRDF_Adjusted_Reflectance/default/2026-09-30/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png',
};
const FOCUS_SOURCE = 'local-city-focus';
const GEOGRAPHY_SOURCE = 'local-geography';
const SEARCH_RESULTS_SOURCE = 'local-search-results';
const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };
const MAX_ROUTE_STOPS = 50;
const originalFillOpacity = new WeakMap();

function preference(key, fallback = '') {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function savePreference(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { return false; }
}

function motionDuration(duration) {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 0 : duration;
}

function coordinateQuery(query) {
  const decimal = query.match(/^\s*([+-]?\d{1,3}(?:\.\d+)?)\s*[,;]\s*([+-]?\d{1,3}(?:\.\d+)?)\s*$/);
  const directional = query.match(/^\s*(\d{1,2}(?:\.\d+)?)\s*\u00b0?\s*([NS])\s*[,;\s]+(\d{1,3}(?:\.\d+)?)\s*\u00b0?\s*([EW])\s*$/i);
  const geo = query.match(/^geo:([+-]?\d{1,3}(?:\.\d+)?),([+-]?\d{1,3}(?:\.\d+)?)(?:\?z=\d+(?:\.\d+)?)?$/i);
  const match = decimal || directional || geo;
  if (!match) return null;
  const lat = Number(match[1]) * (directional && match[2].toUpperCase() === 'S' ? -1 : 1);
  const lon = Number(directional ? match[3] : match[2]) * (directional && match[4].toUpperCase() === 'W' ? -1 : 1);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return { error: 'Use latitude from -90 to 90 and longitude from -180 to 180.' };
  const name = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  return { id: `coordinate:${lat},${lon}`, name, shortName: name, lat, lon, bbox: [lon, lat, lon, lat], provider: 'coordinates' };
}

function mapInstruction(query) {
  return /^(?:find|show|hide|what|where|which|how|tell|take|plan|create|draw|go|zoom|clear|save|pin|add|remove|turn|enable|disable|switch|search|route|navigate|locate|analy[sz]e|summari[sz]e|compare|filter|visuali[sz]e|undo|redo|duplicate|open)\b/i.test(query) ||
    /\S\s+to\s+\S|\b(?:near|nearby|around|above|below)\b|\?$|\b(?:on|off)\s*$/i.test(query);
}

function numeric(value) {
  if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function readable(value) {
  return String(value || '')
    .replace(/[_:/-]+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderAgentReply(container, message) {
  container.replaceChildren();
  const inline = (parent, text) => {
    const tokens = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^\s)]+\))/g;
    let start = 0;
    const append = (tag, value) => {
      const node = document.createElement(tag);
      node.textContent = value;
      parent.append(node);
      return node;
    };
    for (const match of text.matchAll(tokens)) {
      if (match.index > start) append('span', text.slice(start, match.index));
      const token = match[0];
      if (token.startsWith('`')) append('code', token.slice(1, -1));
      else if (token.startsWith('**')) append('strong', token.slice(2, -2));
      else if (token.startsWith('*')) append('em', token.slice(1, -1));
      else {
        const link = token.match(/^\[([^\]]+)\]\((.+)\)$/);
        let url;
        try { url = new URL(link[2]); } catch { /* Invalid links stay plain text. */ }
        const node = append(url && ['https:', 'http:'].includes(url.protocol) ? 'a' : 'span', link[1]);
        if (node.tagName.toLowerCase() === 'a') {
          node.setAttribute('href', url.href);
          node.setAttribute('target', '_blank');
          node.setAttribute('rel', 'noopener noreferrer');
        }
      }
      start = match.index + token.length;
    }
    if (start < text.length) append('span', text.slice(start));
  };
  let paragraph;
  let list;
  let code;
  for (const line of String(message).replace(/\r\n?/g, '\n').split('\n')) {
    if (line.trim().startsWith('```')) {
      paragraph = list = null;
      if (code) code = null;
      else {
        const pre = document.createElement('pre');
        code = document.createElement('code');
        pre.append(code);
        container.append(pre);
      }
      continue;
    }
    if (code) { code.textContent += `${line}\n`; continue; }
    if (!line.trim()) { paragraph = list = null; continue; }
    const item = line.match(/^\s*(?:([-*])|\d+[.)])\s+(.+)$/);
    if (item) {
      paragraph = null;
      const tag = item[1] ? 'ul' : 'ol';
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = document.createElement(tag);
        container.append(list);
      }
      const node = document.createElement('li');
      inline(node, item[2]);
      list.append(node);
    } else {
      list = null;
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      if (heading) {
        paragraph = null;
        const node = document.createElement('h3');
        inline(node, heading[1]);
        container.append(node);
      } else {
        if (!paragraph) { paragraph = document.createElement('p'); container.append(paragraph); }
        else paragraph.append(document.createElement('br'));
        inline(paragraph, line);
      }
    }
  }
  container.hidden = false;
  container.scrollTop = 0;
}

function meters(value) {
  const amount = numeric(value);
  return amount !== null && amount > 0 ? `${amount.toLocaleString(undefined, { maximumFractionDigits: 1 })} m` : '';
}

function levelRange(value) {
  // MapLibre serializes array-valued GeoJSON properties in rendered features.
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return ''; }
  }
  const values = Array.isArray(value) ? value : [];
  if (values.length !== 2 || values.some((entry) => entry === null || !['number', 'string'].includes(typeof entry) || String(entry).trim() === '')) return '';
  const [low, high] = values.map(numeric);
  if (low === null || high === null || low <= 0 || high < low) return '';
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
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)} d ${Math.floor(minutes % 1440 / 60)} h`;
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
    ? { background: '#141918', land: '#1d2320', park: '#283129', water: '#111e24', line: '#475048', text: '#d1d5c9', halo: '#141918' }
    : { background: '#e8e5dc', land: '#e8e5dc', park: '#deded1', water: '#d2d6d2', line: '#a39f93', text: '#57574e', halo: '#e8e5dc' };
  if (!originalFillOpacity.has(map)) originalFillOpacity.set(map, new Map());
  const fillOpacity = originalFillOpacity.get(map);
  for (const layer of map.getStyle().layers || []) {
    if (/^(?:local-|geo-|studio-)/.test(layer.id)) continue;
    const id = layer.id.toLowerCase();
    try {
      map.setLayoutProperty(layer.id, 'visibility', satellite && layer.type === 'fill-extrusion' ? 'none' : 'visible');
      if (id.includes('building')) map.setLayoutProperty(layer.id, 'visibility', satellite ? 'none' : 'visible');
      if (layer.type === 'background') map.setPaintProperty(layer.id, 'background-color', colors.background);
      if (layer.type === 'fill') {
        if (!fillOpacity.has(layer.id)) fillOpacity.set(layer.id, layer.paint?.['fill-opacity'] ?? 1);
        const color = id.includes('water') ? colors.water : /park|wood|grass|landcover/.test(id) ? colors.park : colors.land;
        map.setPaintProperty(layer.id, 'fill-opacity-transition', { duration: motionDuration(360) });
        map.setPaintProperty(layer.id, 'fill-opacity', satellite ? 0 : fillOpacity.get(layer.id));
        map.setPaintProperty(layer.id, 'fill-color', color);
        map.setPaintProperty(layer.id, 'fill-outline-color', color);
      }
      if (layer.type === 'line') {
        map.setPaintProperty(layer.id, 'line-color', satellite ? '#d3d5c6' : colors.line);
        const opacity = satellite ? 0.12 : terrain ? 0.45 : 0.85;
        map.setPaintProperty(layer.id, 'line-opacity-transition', { duration: motionDuration(240) });
        map.setPaintProperty(layer.id, 'line-opacity', /minor|service|path|track|residential/.test(id)
          ? ['interpolate', ['linear'], ['zoom'], 9, 0, 12, opacity * .35, 15, opacity] : opacity);
      }
      if (layer.type === 'symbol') {
        map.setPaintProperty(layer.id, 'text-color', satellite ? '#d6d9cd' : colors.text);
        map.setPaintProperty(layer.id, 'text-halo-color', satellite ? '#151d1b' : colors.halo);
        const opacity = satellite ? 0.8 : 1;
        const minor = /poi|housenumber|address|road.*label|transportation.*name/.test(id);
        map.setPaintProperty(layer.id, 'text-opacity-transition', { duration: motionDuration(160) });
        map.setPaintProperty(layer.id, 'text-opacity', minor ? ['interpolate', ['linear'], ['zoom'], 11, 0, 13, opacity * .45, 15, opacity] : opacity);
        if (minor) map.setPaintProperty(layer.id, 'icon-opacity', ['interpolate', ['linear'], ['zoom'], 11, 0, 14, opacity]);
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
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', satellite ? 'none' : 'visible');
  }
  for (const id of ['local-selection', 'local-hover']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', satellite ? 'none' : 'visible');
  }
  for (const id of ['local-water', 'local-park', 'local-road']) {
    if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', satellite ? 'none' : 'visible');
  }
  if (map.getLayer('local-satellite')) {
    map.setLayoutProperty('local-satellite', 'visibility', 'visible');
    map.setPaintProperty('local-satellite', 'raster-opacity-transition', { duration: motionDuration(400) });
    map.setPaintProperty('local-satellite', 'raster-opacity', satellite ? 1 : 0);
  }
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
    ['geo-route-search', 'line-color', ACCENT], ['geo-route-search-casing', 'line-color', dark ? '#333a30' : '#f8f7ef'],
    ['geo-pin-label', 'text-color', '#1a2117'], ['geo-route-stop-label', 'text-color', '#1a2117'],
    ['local-search-result-label', 'text-color', colors.text], ['local-search-result-label', 'text-halo-color', colors.halo],
  ]) if (map.getLayer(id)) map.setPaintProperty(id, property, color);
  map.setSky?.({
    'sky-color': dark ? '#1c1c20' : '#dfdfda',
    'horizon-color': dark ? '#111113' : '#ecece8',
    'fog-color': colors.background,
    'sky-horizon-blend': 0.5,
    'horizon-fog-blend': 0.5,
    'fog-ground-blend': 0.1,
  });
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
    layout: { 'text-field': ['match', ['get', 'poiCategory'], 'health', '+', 'fuel', 'F', 'education', 'S', 'lodging', 'H', 'culture', 'M', 'shopping', '$', 'safety', '!', 'transit', 'T', ''], 'text-font': ['Noto Sans Regular'], 'text-size': 8, 'text-allow-overlap': true, 'text-ignore-placement': true },
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
  map.addLayer({ id: 'geo-pin-label', type: 'symbol', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'pin'], layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#ffffff' } });
  map.addLayer({ id: 'geo-route-stop-halo', type: 'circle', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route-stop'], paint: { 'circle-radius': 13, 'circle-color': ACCENT, 'circle-opacity': 0.18 } });
  map.addLayer({ id: 'geo-route-stop', type: 'circle', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route-stop'], paint: { 'circle-radius': 9, 'circle-color': ACCENT, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'geo-route-stop-label', type: 'symbol', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route-stop'], layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-font': ['Noto Sans Bold'], 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#ffffff' } });
  map.addLayer({ id: 'local-search-result-halo', type: 'circle', source: SEARCH_RESULTS_SOURCE, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 8, 15, 15], 'circle-color': '#e6953f', 'circle-opacity': 0.18 } });
  map.addLayer({ id: 'local-search-result', type: 'circle', source: SEARCH_RESULTS_SOURCE, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 7, 4, 15, 6.5], 'circle-color': '#e6953f', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.25, 'circle-opacity': 0.95 } });
  map.addLayer({ id: 'local-search-result-label', type: 'symbol', source: SEARCH_RESULTS_SOURCE, minzoom: 13, layout: { 'text-field': ['get', 'name'], 'text-size': 10, 'text-font': ['Noto Sans Regular'], 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-max-width': 14 }, paint: { 'text-color': '#374151', 'text-halo-color': '#ffffff', 'text-halo-width': 1.25 } });
}

class CityExplorer {
  constructor() {
    this.elements = Object.fromEntries([...document.querySelectorAll('[id]')].map((element) => [element.id, element]));
    this.theme = preference('theme', 'dark');
    this.mapMode = ['satellite', 'route', 'terrain'].includes(preference('mapMode')) ? preference('mapMode') : 'satellite';
    this.productMode = 'explore';
    this.workspaceView = 'explore';
    this.viewMode = false;
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
    this.terrainEnabled = false;
    this.layerPreferences = { labels: true, buildings: true, roads: true, places: true, boundaries: true, contours: true, hillshade: true };
    this.contourStrength = 0.55;
    this.regionalImageryEnabled = preference('regionalImagery') !== 'off';
    this.regionalImageryActive = false;
    this.commandMode = false;
    this.searchFocused = false;
    this.suggestionController = null;
    this.suggestionTimer = null;
    this.suggestionIndex = -1;
    this.searchController = null;
    this.routeSubmitting = false;
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
    this.agentTerminalRunIds = new Set();
    this.agentResultSummary = '';
    this.agentLastMessage = '';
    this.agentPanelDismissed = false;
    this.mapActions = [];
    this.agentSnapshot = null;
    this.agentActivity = { connection: 'CONNECTING', request: 'Waiting for connection', tool: 'No active tool' };
    this.worker = new Worker(new URL('./tile-worker.js', import.meta.url), { type: 'module' });
    this.setTheme(this.theme);
    this.bindUi();
    this.createMap();
    this.studio = new MeridianStudio(this);
    this.bootstrap();
    this.connectAgentSocket();
    this.updateDashboard();
    this.clockTimer = window.setInterval(() => this.updateClock(), 30_000);
  }

  bindUi() {
    const el = this.elements;
    el['search-form'].addEventListener('submit', (event) => this.submitSearch(event));
    el['search-input'].addEventListener('input', () => this.queueSuggestions());
    el['search-input'].addEventListener('keydown', (event) => this.handleSearchKey(event));
    el['search-input'].addEventListener('focus', () => { this.searchFocused = true; this.updateSearchDiscovery(); });
    document.querySelector('.floating-search').addEventListener('focusout', (event) => {
      if (event.relatedTarget && document.querySelector('.floating-search').contains(event.relatedTarget)) return;
      this.searchFocused = false;
      this.updateSearchDiscovery();
    });
    el['search-command-toggle'].addEventListener('click', () => {
      this.setCommandMode(!this.commandMode);
      el['search-input'].focus();
    });
    document.querySelectorAll('[data-search-example]').forEach((button) => button.addEventListener('click', () => {
      el['search-input'].value = button.dataset.searchExample;
      this.commandMode = false;
      this.queueSuggestions();
      el['search-input'].focus();
    }));
    el['toggle-geo-tools'].addEventListener('click', () => this.setGeoToolsOpen(!this.geoToolsOpen));
    el['toggle-manual-controls'].addEventListener('click', () => this.setManualControlsOpen(!this.manualControlsOpen));
    el['use-location'].addEventListener('click', () => this.useBrowserLocation());
    el['use-approximate-location'].addEventListener('click', () => this.useApproximateLocation());
    el['pin-mode'].addEventListener('click', () => this.togglePinMode());
    el['workspace-pin-mode'].addEventListener('click', () => this.togglePinMode());
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
    el['agent-cancel'].addEventListener('click', () => this.cancelAgentRequest());
    el['agent-task-stop']?.addEventListener('click', () => this.cancelAgentRequest());
    el['action-history-undo']?.addEventListener('click', () => this.undoMapAction());
    el['copy-coordinates']?.addEventListener('click', () => this.copyCoordinates());
    el['agent-dismiss-result'].addEventListener('click', () => this.dismissAgentResult());
    document.getElementById('agent-dismiss-question').addEventListener('click', () => this.cancelAgentRequest());
    document.getElementById('replay-route').addEventListener('click', () => {
      if (this.geo.routeAnimation) this.stopRouteAnimation();
      else if (this.geo.route) this.animateRoute(this.geo.route);
    });
    document.getElementById('clear-workspace-dialog').addEventListener('close', (event) => {
      if (event.target.returnValue === 'clear') this.clearAdditions(true);
    });
    document.querySelectorAll('[data-map-action]').forEach((button) => button.addEventListener('click', () => this.operate(button.dataset.mapAction)));
    document.addEventListener('keydown', (event) => this.handleShortcut(event));
    this.worker.onmessage = ({ data }) => this.handleWorkerMessage(data);
    this.setGeoToolsOpen(false);
    this.setManualControlsOpen(false);
    const information = document.getElementById('info-drawer-content');
    document.getElementById('toggle-info-drawer').addEventListener('click', () => this.setInfoDrawerOpen(information.hidden));
    document.getElementById('clear-map-cache').addEventListener('click', () => {
      navigator.serviceWorker?.controller?.postMessage({ type: 'clear-map-cache' });
    });
    navigator.serviceWorker?.addEventListener('message', (event) => {
      if (event.data?.type === 'map-cache-stats') document.getElementById('cache-status').textContent = `${event.data.entries} resources / ${(event.data.bytes / 1048576).toFixed(1)} MB`;
    });
    document.getElementById('cache-status').textContent = navigator.serviceWorker?.controller ? 'Cache ready / 96 MB limit' : 'Local cache unavailable; browser caching remains active';
    navigator.serviceWorker?.controller?.postMessage({ type: 'map-cache-stats' });
    document.querySelectorAll('button[data-map-mode]').forEach((button) => button.addEventListener('click', () => {
      this.setMapMode(button.dataset.mapMode);
      if (this.workspaceView === 'explore') this.setManualControlsOpen(button.dataset.mapMode === 'terrain');
      this.refreshMapMetadata();
    }));
    document.querySelectorAll('button[data-workspace-view]').forEach((button) => button.addEventListener('click', () => this.setWorkspaceView(button.dataset.workspaceView)));
    document.querySelectorAll('button[data-product-mode]').forEach((button) => button.addEventListener('click', () => this.setProductMode(button.dataset.productMode)));
    document.querySelectorAll('[data-open-routes]').forEach((button) => button.addEventListener('click', () => this.setWorkspaceView('routes')));
    document.querySelectorAll('[data-layer-toggle]').forEach((button) => button.addEventListener('click', () => this.toggleMapLayer(button.dataset.layerToggle)));
    el['contour-strength'].addEventListener('input', () => {
      this.contourStrength = Number(el['contour-strength'].value) / 100;
      if (this.contourFrame) return;
      this.contourFrame = window.requestAnimationFrame(() => {
        this.contourFrame = null;
        this.applyLayerPreferences();
        this.saveExploreState();
      });
    });
    el['regional-overview-toggle'].addEventListener('click', () => {
      this.regionalImageryEnabled = !this.regionalImageryEnabled;
      if (this.regionalImageryEnabled && this.regionalImageryUnavailable) {
        this.regionalImageryUnavailable = false;
        this.map.getSource('local-regional-imagery')?.setTiles([REGIONAL_IMAGERY.tiles]);
      }
      savePreference('regionalImagery', this.regionalImageryEnabled ? 'on' : 'off');
      this.updateSatelliteImagery();
      this.refreshMapMetadata();
    });
    document.getElementById('theme-toggle')?.addEventListener('click', () => this.setTheme(this.theme === 'dark' ? 'light' : 'dark'));
    document.getElementById('view-mode-toggle').addEventListener('click', () => this.setViewMode(!this.viewMode));
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
    this.updateSearchIntent();
    this.introTimer = setTimeout(() => this.dismissIntro(), 2800);
    document.addEventListener('pointerdown', (event) => {
      this.dismissIntro();
      if (!(event.target instanceof Element) || event.target.closest('.floating-search')) return;
      this.searchFocused = false;
      this.renderSuggestions([]);
      this.updateSearchDiscovery();
    });
    document.addEventListener('keydown', () => this.dismissIntro(), { once: true });
    const viewport = window.matchMedia('(max-width: 700px)');
    viewport.addEventListener('change', () => {
      if (this.workspaceView === 'explore') this.setManualControlsOpen(false);
      this.updateDashboard();
    });
    this.renderRoutePlan();
    window.addEventListener('beforeunload', () => {
      window.clearTimeout(this.agentReconnectTimer);
      window.clearInterval(this.clockTimer);
      clearTimeout(this.introTimer);
      clearTimeout(this.geoStatusTimer);
      this.elevationController?.abort();
      this.imageryMetadataController?.abort();
      this.terrainPointController?.abort();
      this.studio?.destroy();
      this.saveExploreState();
      window.cancelAnimationFrame(this.contourFrame);
      clearTimeout(this.mapMetadataTimer);
      this.attributionObserver?.disconnect();
      this.agentSocket?.close();
    });
  }

  setViewMode(enabled) {
    this.viewMode = enabled;
    document.documentElement.dataset.viewMode = String(enabled);
    const toggle = document.getElementById('view-mode-toggle');
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.setAttribute('aria-label', enabled ? 'Exit view mode' : 'Enter view mode');
    toggle.setAttribute('title', enabled ? 'Exit view mode (Esc)' : 'View mode: hide panels');
    toggle.focus({ preventScroll: true });
  }

  setManualControlsOpen(open) {
    this.manualControlsOpen = open;
    const sidebar = this.elements['manual-controls-content'].closest('.manual-sidebar');
    const toggle = this.elements['toggle-manual-controls'];
    sidebar.classList.toggle('is-open', open);
    sidebar.classList.toggle('is-collapsed', !open);
    document.documentElement.dataset.sidebar = open ? 'open' : 'closed';
    toggle.setAttribute('aria-expanded', String(open));
    this.elements['manual-controls-content'].hidden = !open;
    if (open && this.productMode === 'studio') this.studio?.setPane('left');
  }

  setInfoDrawerOpen(open) {
    const content = document.getElementById('info-drawer-content');
    const toggle = document.getElementById('toggle-info-drawer');
    content.hidden = !open;
    document.querySelector('.info-drawer').classList.toggle('is-open', open);
    document.documentElement.dataset.mapDetails = String(open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} map details`);
    if (open && window.innerWidth <= 900) this.setManualControlsOpen(false);
    if (open && window.innerWidth <= 1100) this.studio?.closePanels();
    if (open) navigator.serviceWorker?.controller?.postMessage({ type: 'map-cache-stats' });
    if (open) {
      this.updateDashboard();
      this.refreshMapMetadata();
    }
  }

  setGeoToolsOpen(open) {
    this.geoToolsOpen = open;
    const panel = this.elements['geo-content'].closest('.geo-panel');
    const toggle = this.elements['toggle-geo-tools'];
    panel.classList.toggle('is-collapsed', !open);
    this.elements['geo-content'].hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.querySelector('b').textContent = open ? 'CLOSE' : 'OPEN';
  }

  captureMapAction() {
    const center = this.map?.getCenter?.();
    return JSON.parse(JSON.stringify({
      camera: center ? { center: [center.lng, center.lat], zoom: this.map.getZoom?.(), bearing: this.map.getBearing?.(), pitch: this.map.getPitch?.() } : null,
      selected: this.selected, mapMode: this.mapMode, theme: this.theme, terrainEnabled: this.terrainEnabled,
      layerPreferences: this.layerPreferences, contourStrength: this.contourStrength,
      geo: { ...this.geo, routeAnimation: null, routeStops: this.routePlan().map((stop) => ({ ...stop, suggestions: [] })) },
      searchResults: this.searchResults, studio: this.studio?.snapshot(), comparing: Boolean(this.studio?.compareMap),
    }));
  }

  recordMapAction(label, before, options = {}) {
    if (!before) return;
    if (before.studio?.id === this.studio?.workspace.id) this.studio?.discardRedo();
    this.mapActions ||= [];
    this.mapActions.push({ label: String(label).slice(0, 120), before, guard: this.mapActionGuard(), cameraRevision: this.cameraInteractionRevision || 0, time: Date.now(), ...options });
    if (this.mapActions.length > 20) this.mapActions.shift();
    this.updateActionChip();
  }

  mapActionGuard() {
    const studio = this.studio?.snapshot();
    if (studio) { delete studio.camera; delete studio.updatedAt; delete studio.selectedLayerId; delete studio.scope; }
    return JSON.stringify({
      selected: this.selected, pins: this.geo.pins, areas: this.geo.areas, route: this.geo.route,
      stops: this.routePlan().map((stop) => ({ query: stop.query, place: stop.place })), searchResults: this.searchResults,
      mapMode: this.mapMode, terrainEnabled: this.terrainEnabled, preferences: this.layerPreferences, studio,
    });
  }

  updateActionChip() {
    const action = this.mapActions?.at(-1);
    const studioAction = this.studio?.lastAction();
    const latest = studioAction && (!action || studioAction.time > action.time) ? studioAction : action;
    const chip = this.elements['action-history-chip'];
    if (!chip) return;
    chip.hidden = !latest;
    this.elements['action-history-label'].textContent = latest?.label || '';
    this.elements['action-history-undo'].disabled = Boolean(this.agentSubmitting || this.agentRunId || this.undoing);
    this.studio?.setAgentBusy(Boolean(this.agentSubmitting || this.agentRunId || this.undoing));
  }

  async undoMapAction() {
    if (this.agentSubmitting || this.agentRunId || this.undoing) return;
    const action = this.mapActions?.at(-1);
    const studioAction = this.studio?.lastAction();
    if (studioAction && (!action || studioAction.time > action.time)) return this.studio.undo();
    if (!action) return this.setGeoStatus('There is no map action to undo.');
    if (action.guard && action.guard !== this.mapActionGuard()) return this.setGeoStatus('This action cannot overwrite more recent manual map changes. Undo those changes first or keep the current state.', true);
    this.undoing = true;
    this.updateActionChip();
    try {
      if (action.serverUndo) {
        const result = await postJson('/api/agent/undo', { sessionId: this.agentSessionId, runId: action.runId });
        if (!result.undone) throw new Error('The service could not undo this action.');
        if (action.guard && action.guard !== this.mapActionGuard()) {
          this.mapActions.pop();
          this.setGeoStatus('The server operation was undone. Newer local map changes were kept instead of being overwritten.', true);
          return;
        }
      }
      const currentCamera = this.captureMapAction().camera;
      const moved = (this.cameraInteractionRevision || 0) !== (action.cameraRevision || 0);
      this.restoreMapAction(moved ? { ...action.before, camera: currentCamera } : action.before);
      this.mapActions.pop();
      this.setGeoStatus(`Undid: ${action.label}`);
    } catch (error) {
      this.setGeoStatus(`Undo was not applied: ${error.message}`, true);
    } finally {
      this.undoing = false;
      this.updateActionChip();
    }
  }

  restoreMapAction(snapshot) {
    this.restoringAction = true;
    try {
      this.stopRouteAnimation(false);
      this.geo = JSON.parse(JSON.stringify(snapshot.geo));
      this.searchResults = snapshot.searchResults || [];
      this.selected = snapshot.selected;
      this.layerPreferences = { ...snapshot.layerPreferences };
      this.contourStrength = snapshot.contourStrength ?? .55;
      this.mapMode = snapshot.mapMode;
      this.terrainEnabled = snapshot.terrainEnabled;
      if (this.map) {
        if (this.selected && this.features) this.resetMapForLocation({ immediate: true });
        else if (this.features) this.clearCityData();
        this.applyTerrain();
        this.applyMapMode();
        if (snapshot.camera) this.map.jumpTo(snapshot.camera);
      }
      if (snapshot.studio) this.studio?.restoreSnapshot(snapshot.studio, { restoreCamera: false });
      if (!snapshot.comparing) this.studio?.stopCompare();
      this.renderWorkspace();
      this.renderGeography();
      this.renderSearchResults();
      this.updateDashboard();
    } finally {
      this.restoringAction = false;
      this.saveExploreState();
    }
  }

  settleAgentAction(event) {
    const before = this.agentSnapshot;
    this.agentSnapshot = null;
    if (!before || !this.agentDidMutate) return;
    if (this.agentLocalConflict) {
      if (event.rolledBack === true && event.workspace) {
        this.applyWorkspaceSnapshot(event.workspace);
        this.renderWorkspace();
        this.renderGeography();
      }
      this.setGeoStatus('Manual changes occurred during the operation. They were not overwritten; automatic map undo is unavailable for this run.', true);
      this.agentDidMutate = false;
      return;
    }
    if (event.rolledBack === true && !this.agentLocalConflict) {
      const camera = this.agentUserCamera ? this.captureMapAction().camera : before.camera;
      this.restoreMapAction({ ...before, camera });
    }
    else if (event.type === 'agent.completed' || event.type === 'agent.question') {
      this.recordMapAction(this.agentLastMessage || 'Meridian map operation', before, { runId: event.runId, serverUndo: event.reversible === true });
    } else if (event.rolledBack === false || this.agentLocalConflict) {
      this.setGeoStatus('The workspace changed during this operation. Existing changes were kept rather than overwritten.', true);
    }
    this.agentDidMutate = false;
  }

  markManualChange() {
    if (this.undoing && !this.restoringAction) {
      this.setGeoStatus('Wait for the pending undo before changing map data.', true);
      return true;
    }
    if ((this.agentSubmitting || this.agentRunId) && !this.applyingAgentMap) this.agentLocalConflict = true;
    return false;
  }

  saveExploreState() {
    if (!this.workspaceReady || this.productMode === 'studio' || !this.map?.getCenter) return;
    const center = this.map.getCenter();
    const saved = savePreference('meridian.explore.v1', JSON.stringify({
      camera: { center: [center.lng, center.lat], zoom: this.map.getZoom(), pitch: this.map.getPitch(), bearing: this.map.getBearing() },
      selected: this.selected, mapMode: this.mapMode, terrainEnabled: this.terrainEnabled,
      layerPreferences: this.layerPreferences, contourStrength: this.contourStrength,
      routeStops: this.routePlan().map((stop) => ({ query: stop.query, place: stop.place, suggestions: [] })),
    }));
    if (!saved && !this.exploreStorageUnavailable) {
      this.exploreStorageUnavailable = true;
      this.setGeoStatus('Browser storage is unavailable. This map view will not be restored after reload.', true);
    }
  }

  persistWorkspaceState() {
    if (!this.workspaceReady || this.agentSubmitting || this.agentRunId || this.restoringAction) return;
    const state = { routeId: this.geo.route?.id || '', routePinIds: [], context: { selectedCity: this.selected } };
    const key = JSON.stringify(state);
    if (key === this.workspaceSaveKey) return;
    this.workspaceSaveKey = key;
    this.workspaceSave = (this.workspaceSave || Promise.resolve()).then(async () => {
      try { await postJson('/api/workspace/state', { state }); }
      catch {
        if (this.workspaceSaveKey === key) this.workspaceSaveKey = '';
        this.setGeoStatus('Map service could not save the active route. Your current map remains usable; Studio exports are available locally.', true);
      }
    });
  }

  async copyCoordinates() {
    const coordinate = this.inspectedCoordinate || this.map?.getCenter?.();
    if (!coordinate) return;
    const text = `${coordinate.lat.toFixed(5)}, ${(coordinate.lng ?? coordinate.lon).toFixed(5)}`;
    try {
      await navigator.clipboard.writeText(text);
      this.setGeoStatus('Coordinates copied as latitude, longitude.');
    } catch {
      this.setGeoStatus(`Clipboard unavailable. Coordinates: ${text}`, true);
    }
  }

  dismissIntro() {
    clearTimeout(this.introTimer);
    document.getElementById('view-heading').classList.add('is-dismissed');
    document.documentElement.dataset.uiQuiet = 'true';
  }

  setCommandMode(enabled) {
    this.commandMode = enabled;
    this.suggestionController?.abort();
    clearTimeout(this.suggestionTimer);
    this.renderSuggestions([]);
    this.updateSearchIntent();
    this.updateSearchDiscovery();
  }

  updateSearchIntent() {
    const input = this.elements['search-input'];
    const instruction = this.commandMode || (!coordinateQuery(input.value.trim()) && mapInstruction(input.value.trim()));
    const toggle = this.elements['search-command-toggle'];
    toggle.setAttribute('aria-pressed', String(this.commandMode));
    toggle.setAttribute('aria-label', this.commandMode ? 'Search for a place instead of asking Meridian' : 'Ask Meridian instead of searching for a place');
    input.setAttribute('placeholder', this.commandMode ? 'Ask Meridian to find places or plan a route...' : 'Search places, coordinates, or ask Meridian...');
    const submit = this.elements['search-submit'];
    submit.setAttribute('aria-label', instruction ? 'Ask Meridian' : 'Search map');
    submit.setAttribute('title', instruction ? 'Ask Meridian' : 'Search map');
    document.querySelector('.floating-search').classList.toggle('is-command', instruction);
  }

  updateSearchDiscovery() {
    this.elements['search-discovery'].hidden = !this.searchFocused || Boolean(this.elements['search-input'].value.trim()) || this.agentSubmitting || Boolean(this.agentRunId) || this.agentQuestionOpen;
    document.documentElement.dataset.searchActive = String(this.searchFocused || this.agentSubmitting || Boolean(this.agentRunId) || this.agentQuestionOpen);
  }

  dismissAgentResult() {
    this.agentPanelDismissed = true;
    this.elements['agent-panel'].hidden = true;
    this.elements['search-input'].focus({ preventScroll: true });
  }

  showCommandResult(summary, detail = '') {
    this.agentPanelDismissed = false;
    this.agentResultSummary = summary;
    this.elements['agent-result-summary'].textContent = summary;
    this.elements['agent-result-summary'].hidden = !summary;
    this.elements['agent-panel'].hidden = false;
    this.elements['agent-feedback'].textContent = '';
    this.elements['agent-result-details'].hidden = !detail;
    this.elements['agent-result-details'].open = false;
    if (detail) renderAgentReply(this.elements['agent-response'], detail);
    else this.elements['agent-response'].hidden = true;
    this.agentActivity.tool = 'No active tool';
    this.agentActivity.request = 'Map updated';
    this.searchFocused = false;
    this.updateSearchDiscovery();
  }

  applyLocalInstruction(query) {
    const normalized = query.toLowerCase().trim().replace(/[.!]$/, '');
    if (normalized === 'open studio' || normalized === 'switch to studio') {
      this.setProductMode('studio');
      this.showCommandResult('Studio workspace opened', 'The camera and existing map tools are preserved. Import a dataset or capture loaded map data to begin.');
      return true;
    }
    if (normalized === 'undo') { this.undoMapAction(); return true; }
    if (normalized === 'redo' && this.productMode === 'studio') { this.studio?.redo(); return true; }
    if (/\b(?:slope|aspect|viewshed|elevation profile|elevation gain|roads above|roads below)\b/.test(normalized)) {
      this.showCommandResult('Terrain analysis is not available yet', 'Meridian can show relief, contours, and sampled point elevations. Slope, aspect, elevation profiles, and elevation-filtered roads require terrain analysis that this map service does not currently provide.');
      return true;
    }
    if (/\b(?:hiking|off-road|scenic)\b.*\broute\b|\broute\b.*\b(?:hiking|off-road|scenic)\b/.test(normalized)) {
      this.showCommandResult('Driving routes are currently supported', 'The route service uses the OpenStreetMap road network. Hiking, scenic, and off-road routing are not available; Meridian will not substitute a driving plan or invent journey estimates.');
      return true;
    }
    const mode = normalized.match(/^(?:show|switch to|open)(?: the)? (satellite|streets?|terrain)(?: (?:map|view|mode))?$/);
    if (mode) {
      const before = this.captureMapAction();
      this.setWorkspaceView('explore');
      this.setMapMode(mode[1].startsWith('street') ? 'route' : mode[1]);
      if (mode[1] === 'terrain') this.setManualControlsOpen(true);
      this.refreshMapMetadata();
      this.showCommandResult(mode[1] === 'terrain' ? 'Topographic view / contours in meters' : mode[1] === 'satellite' ? 'Satellite imagery / plan view' : 'Streets / road network');
      this.recordMapAction(query, before);
      return true;
    }
    const layer = normalized.match(/^(show|hide|enable|disable)(?: the)? (labels|buildings|roads|places|boundaries|contours|hillshade)$/) || normalized.match(/^(labels|buildings|roads|places|boundaries|contours|hillshade) (on|off)$/);
    if (layer) {
      const before = this.captureMapAction();
      const name = layer[1] === 'show' || layer[1] === 'hide' || layer[1] === 'enable' || layer[1] === 'disable' ? layer[2] : layer[1];
      const enabled = ['show', 'enable', 'on'].includes(layer[1]) || layer[2] === 'on';
      if (['contours', 'hillshade'].includes(name) && this.mapMode !== 'terrain') {
        this.setWorkspaceView('explore');
        this.setMapMode('terrain');
      }
      this.toggleMapLayer(name, enabled);
      this.showCommandResult(`${readable(name)} ${enabled ? 'on' : 'off'}`);
      this.recordMapAction(query, before);
      return true;
    }
    if (/^(?:show|enable|turn on) 3d$|^3d on$/.test(normalized) || /^(?:hide|disable|turn off) 3d$|^3d off$/.test(normalized)) {
      const before = this.captureMapAction();
      const enabled = /^(?:show|enable|turn on)|on$/.test(normalized);
      this.setTerrainView(enabled);
      this.showCommandResult(enabled ? '3D relief enabled' : 'Plan view / 3D relief off');
      this.recordMapAction(query, before);
      return true;
    }
    return false;
  }

  toggleMapLayer(name, enabled = !this.layerPreferences?.[name]) {
    if (this.markManualChange()) return;
    this.layerPreferences = { labels: true, buildings: true, roads: true, places: true, boundaries: true, contours: true, hillshade: true, ...this.layerPreferences };
    if (!Object.hasOwn(this.layerPreferences, name)) return;
    this.layerPreferences[name] = enabled;
    for (const layer of this.map?.getStyle?.()?.layers || []) {
      if (!this.layerMatchesPreference(layer, name)) continue;
      const id = layer.id.toLowerCase();
      const inMode = /local-contour|local-hillshade/.test(id) ? this.mapMode === 'terrain'
        : this.mapMode !== 'satellite' || (!['fill', 'fill-extrusion'].includes(layer.type) && name !== 'buildings');
      this.map.setLayoutProperty(layer.id, 'visibility', enabled && inMode ? 'visible' : 'none');
    }
    this.applyMapMode();
    this.saveExploreState();
  }

  layerMatchesPreference(layer, name) {
    const id = layer.id.toLowerCase();
    if (/^(?:geo-|studio-|local-search-result|local-city-focus)/.test(id)) return false;
    return name === 'labels' ? layer.type === 'symbol'
      : name === 'buildings' ? /building|local-selection|local-hover/.test(id)
      : name === 'roads' ? /road|highway|bridge|tunnel|transportation/.test(id)
      : name === 'places' ? /poi/.test(id)
      : name === 'boundaries' ? /boundary|border/.test(id)
      : name === 'contours' ? /local-contour/.test(id)
      : name === 'hillshade' && id === 'local-hillshade';
  }

  applyLayerPreferences() {
    const preferences = this.layerPreferences;
    if (!preferences || !this.map?.getStyle?.()) return;
    document.querySelectorAll('[data-layer-toggle]').forEach((button) => {
      button.setAttribute('aria-pressed', String(preferences[button.dataset.layerToggle]));
      button.disabled = button.dataset.layerToggle === 'buildings' && this.mapMode === 'satellite';
      button.setAttribute('title', button.disabled ? 'Buildings are visible in Streets and Terrain' : '');
    });
    for (const layer of this.map.getStyle()?.layers || []) {
      if (Object.entries(preferences).some(([name, enabled]) => !enabled && this.layerMatchesPreference(layer, name))) this.map.setLayoutProperty(layer.id, 'visibility', 'none');
    }
    if (this.map.getLayer('local-contours')) {
      this.map.setPaintProperty('local-contours', 'line-opacity-transition', { duration: motionDuration(200) });
      this.map.setPaintProperty('local-contours', 'line-opacity', this.contourStrength ?? 0.55);
    }
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
    if (el['agent-task-chip']) el['agent-task-chip'].hidden = !active;
    if (el['agent-task-label']) el['agent-task-label'].textContent = this.agentActivity.tool === 'No active tool' ? this.agentActivity.request : this.agentActivity.tool;
    const activityPanel = document.getElementById('agent-hud');
    if (active && activityPanel) activityPanel.open = true;
    const feedback = document.getElementById('agent-feedback');
    feedback.textContent = this.agentActivity.tool === 'Failed' || this.agentActivity.tool === 'Request failed'
      ? this.agentActivity.request
      : active && this.agentActivity.tool !== 'No active tool' ? this.agentActivity.tool : this.agentActivity.request;
    feedback.classList.toggle('is-error', this.agentActivity.tool === 'Failed' || this.agentActivity.tool === 'Request failed');
    el['search-submit'].disabled = active;
    el['agent-cancel'].classList.toggle('is-hidden', !active);
    el['search-input'].disabled = active;
    const failed = this.agentActivity.tool === 'Failed' || this.agentActivity.tool === 'Request failed';
    el['agent-panel'].hidden = !(active || this.agentQuestionOpen || (!this.agentPanelDismissed && (failed || this.agentResultSummary)));
    document.querySelector('.floating-search').setAttribute('aria-busy', String(active));
    this.setLoading(Boolean(this.searchLoading));
    this.updateSearchDiscovery();
    this.studio?.setAgentBusy(active);
  }

  connectAgentSocket() {
    if (this.agentSocket?.readyState === window.WebSocket?.OPEN || this.agentSocket?.readyState === window.WebSocket?.CONNECTING) return;
    window.clearTimeout(this.agentReconnectTimer);
    if (!window.WebSocket) {
      this.setAgentActivity({ connection: 'UNAVAILABLE', request: 'WebSocket is not supported' });
      return;
    }
    this.agentSocketReady = false;
    const failed = this.agentActivity.tool === 'Failed' || this.agentActivity.tool === 'Request failed';
    this.setAgentActivity({ connection: 'CONNECTING', request: failed ? this.agentActivity.request : this.agentRunId ? 'Connection lost; reconnecting' : 'Waiting for connection' });
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
      if (this.agentRunId || this.agentSubmitting) {
        this.agentPostSerial = 0;
        this.finishAgentRun();
        this.setAgentActivity({ connection: 'RETRYING', request: 'Connection interrupted. Map changes already applied are kept; retry your instruction after reconnecting.', tool: 'Request failed' });
      }
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
      const failed = this.agentActivity.tool === 'Failed' || this.agentActivity.tool === 'Request failed';
      this.setAgentActivity({ connection: 'READY', request: failed ? this.agentActivity.request : this.agentRunId ? 'Request in progress' : 'Search a place or give the map an instruction.' });
      return;
    }
    if (message.type === 'error') {
      this.setAgentActivity({ request: String(message.error || 'Socket request failed').slice(0, 160) });
      return;
    }
    if (typeof message.type === 'string' && message.type.startsWith('agent.')) this.handleAgentEvent(message);
  }

  agentEventIsCurrent(runId) {
    return Boolean(runId) && !this.agentTerminalRunIds?.has(runId) && (this.agentRunId === runId || (this.agentSubmitting && !this.agentRunId));
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
      this.agentDidMutate = true;
      this.applyingAgentMap = true;
      try { this.applyAgentMapUpdate(event.update); }
      finally { this.applyingAgentMap = false; }
      this.setAgentActivity({ request: 'Map updated', tool: 'Map changes applied' });
      return;
    }
    if (event.type === 'agent.question') {
      this.settleAgentAction(event);
      this.finishAgentRun();
      this.showAgentQuestion(event.question, event.choices);
      this.setAgentActivity({ request: 'Waiting for your choice', tool: 'Clarification requested' });
      return;
    }
    if (event.type === 'agent.limitation') {
      this.settleAgentAction(event);
      this.finishAgentRun();
      this.agentResultSummary = '';
      this.showCommandResult('A sourced geographic dataset is required', event.message || 'This request needs data or tools that are not available in the current workspace.');
      this.setAgentActivity({ request: 'Capability limitation explained', tool: 'No map substituted' });
      return;
    }
    if (event.type === 'agent.completed') {
      this.settleAgentAction(event);
      this.finishAgentRun();
      const message = event.message || 'Your map is ready.';
      const summary = this.agentResultSummary || String(message).replace(/[#*_`]/g, '').split('\n').find((line) => line.trim())?.slice(0, 180) || 'Map updated';
      this.showCommandResult(summary, message);
      this.setAgentActivity({ request: 'Map request completed', tool: 'Completed' });
      return;
    }
    if (event.type === 'agent.failed') {
      this.settleAgentAction(event);
      this.finishAgentRun();
      this.setAgentActivity({ request: String(event.error || 'Map request failed').slice(0, 160), tool: 'Failed' });
      return;
    }
    if (event.type === 'agent.cancelled') {
      this.settleAgentAction(event);
      this.finishAgentRun();
      this.setAgentActivity({ request: 'Request cancelled', tool: 'Cancelled' });
    }
  }

  finishAgentRun() {
    if (this.agentRunId) {
      this.agentTerminalRunIds ||= new Set();
      this.agentTerminalRunIds.add(this.agentRunId);
      if (this.agentTerminalRunIds.size > 40) this.agentTerminalRunIds.delete(this.agentTerminalRunIds.values().next().value);
    }
    this.agentSubmitting = false;
    this.agentCancelRequested = false;
    this.agentRunId = '';
    this.agentPostSerial = 0;
    this.renderAgentActivity();
    this.updateActionChip();
  }

  async submitAgentRequest(event) {
    event.preventDefault();
    const message = this.elements['search-input'].value.trim();
    if (!message) return this.elements['search-input'].focus();
    await this.startAgentRequest(message);
  }

  async startAgentRequest(message) {
    if (this.undoing) return this.setSearchStatus('Wait for the pending undo before starting another map operation.', true);
    if (this.agentSubmitting || this.agentRunId) return;
    if (!this.agentSocketReady) {
      this.agentPanelDismissed = false;
      this.setSearchStatus('Meridian instructions need the local map service. Place and coordinate search still work; retry the instruction once connected.', true);
      this.setAgentActivity({ request: 'Waiting for the Meridian connection' });
      this.connectAgentSocket();
      return;
    }
    this.agentQuestionOpen = false;
    this.elements['agent-question'].classList.add('is-hidden');
    this.agentSubmitting = true;
    this.agentSnapshot = this.captureMapAction();
    this.agentDidMutate = false;
    this.agentLocalConflict = false;
    this.agentUserCamera = false;
    this.agentLastMessage = message;
    this.agentResultSummary = '';
    this.agentPanelDismissed = false;
    this.elements['agent-result-summary'].hidden = true;
    this.elements['agent-result-details'].hidden = true;
    this.searchFocused = false;
    this.updateSearchDiscovery();
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
      this.elements['search-input'].value = '';
      this.commandMode = false;
      this.updateSearchIntent();
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
      this.elements['search-input'].focus();
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
    this.agentPanelDismissed = false;
    this.elements['agent-panel'].hidden = false;
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
    this.searchFocused = false;
    this.updateSearchDiscovery();
    document.getElementById('agent-question').focus({ preventScroll: true });
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
      ...(this.productMode === 'studio' ? this.studio?.agentContext() : {}),
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
    const points = value.geometry.coordinates;
    const bounded = points.length > 20_000 ? Array.from({ length: 20_000 }, (_, index) => points[Math.round(index * (points.length - 1) / 19_999)]) : points;
    const coordinates = bounded.map((point) => {
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
      stored: value.stored === true, sourceVersion: String(value.sourceVersion || '').slice(0, 120), createdAt: numeric(value.createdAt),
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
        this.map.fitBounds([[west, south], [east, north]], { padding: 90, maxZoom: 16, duration: motionDuration(450) });
        return;
      }
    }
    if (Array.isArray(view.center) && view.center.length >= 2 && numeric(view.center[0]) !== null && numeric(view.center[1]) !== null) {
      const zoom = numeric(view.zoom);
      this.map.flyTo({ center: [Number(view.center[0]), Number(view.center[1])], zoom: zoom === null ? Math.max(12, this.map.getZoom()) : Math.max(1, Math.min(20, zoom)), duration: motionDuration(450) });
    }
  }

  applyAgentMapUpdate(update) {
    if (!update || typeof update !== 'object') return;
    if (update.studio) {
      try {
        this.studio?.applyOperation(update.studio, { fromAgent: true });
        this.agentResultSummary = 'Studio updated from the loaded dataset';
      } catch (error) {
        this.agentResultSummary = `Studio operation was not applied: ${error.message}`;
        this.setGeoStatus(this.agentResultSummary, true);
      }
      return;
    }
    if (update.clear === true) {
      this.clearWorkspaceLocal(false);
      this.setGeoStatus('The map agent cleared the workspace.');
      this.agentResultSummary = 'Workspace cleared / saved route records kept';
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
    if (Object.prototype.hasOwnProperty.call(update, 'route')) {
      this.stopRouteAnimation(false);
      this.geo.route = this.agentRoute(update.route);
      if (this.geo.route) this.setWorkspaceView('routes');
    }
    if (update.workspace) this.applyWorkspaceSnapshot(update.workspace);
    this.routePlan();
    this.renderWorkspace();
    this.renderGeography();
    this.renderSearchResults();
    if (this.productMode === 'studio') this.studio?.captureAgentArtifacts(update);
    this.updateIntroCard();
    this.applyAgentView(update.view);
    const route = this.geo.route;
    this.agentResultSummary = route
      ? `${formatDistance(route.summary.distanceMeters) || 'Distance unavailable'} / ${formatDuration(route.summary.durationSeconds) || 'Time unavailable'} / driving`
      : this.searchResults.length
        ? `${this.searchResults.length} place${this.searchResults.length === 1 ? '' : 's'} on the map`
        : selected ? `Exploring ${selected.shortName || selected.name}` : 'Map updated';
  }

  createMap() {
    if (window.mlcontour) {
      this.contourDem = new window.mlcontour.DemSource({ url: TERRAIN_TILE_URL, encoding: 'terrarium', maxzoom: 13, worker: true, cacheSize: 200 });
      this.contourDem.setupMaplibre(window.maplibregl);
    }
    this.map = new window.maplibregl.Map({ container: 'map', style: 'https://tiles.openfreemap.org/styles/positron', center: [-122.48, 37.82], zoom: 11, pitch: this.terrainEnabled ? 45 : 0, bearing: -12, maxPitch: 78, attributionControl: false, canvasContextAttributes: { antialias: true }, maxTileCacheSize: 512, maxTileCacheZoomLevels: 5 });
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
      this.studio?.renderMap();
      this.refreshMapMetadata();
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
    this.map.on('movestart', (event) => {
      document.documentElement.dataset.mapMoving = 'true';
      if (event.originalEvent) this.locationRevision = (this.locationRevision || 0) + 1;
      if (event.originalEvent) this.cameraInteractionRevision = (this.cameraInteractionRevision || 0) + 1;
      if (event.originalEvent && (this.agentSubmitting || this.agentRunId)) this.agentUserCamera = true;
      if (event.originalEvent) this.dismissIntro();
      this.elevationController?.abort();
      this.imageryMetadataController?.abort();
      clearTimeout(this.mapMetadataTimer);
      this.mapMetadataState = null;
      this.mapMetadataSequence = (this.mapMetadataSequence || 0) + 1;
      if (this.selected && this.map.getZoom() >= 13) this.setPreviewVisible(true);
    });
    this.map.on('moveend', () => {
      document.documentElement.dataset.mapMoving = 'false';
      this.updateSatelliteImagery();
      this.updateDashboard();
      this.refreshMapMetadata();
      this.saveExploreState();
      if (this.selected && this.map.getZoom() >= 13) this.worker.postMessage({ type: 'append', tiles: visibleTiles(this.map) });
    });
    this.map.on('move', () => {
      if (this.regionalImageryActive) this.updateSatelliteImagery();
    });
    this.map.on('error', (event) => {
      const source = event.sourceId || event.error?.sourceId;
      if (source === 'local-regional-imagery') {
        this.regionalImageryUnavailable = true;
        this.updateSatelliteImagery();
        this.showMapNotice('Regional satellite scene is unavailable. Showing the aerial composite instead.');
      } else if (source === 'local-imagery') {
        this.imageryUnavailable = true;
        if (this.mapMode === 'satellite') this.showMapNotice('Some satellite tiles could not load. Select Satellite again to retry, or choose the street map.');
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
      if (this.studio?.handleMapClick(event)) return;
      if (this.viewMode || (!this.pinMode && (this.mapMode !== 'terrain' || this.workspaceView !== 'explore'))) return;
      const interactiveLayers = [PREVIEW_LAYER, 'local-buildings', 'local-buildings-inferred', 'local-poi-marker', 'local-search-result', 'geo-pin', 'geo-route-stop', 'geo-area-fill']
        .filter((layer) => this.map.getLayer(layer));
      if (interactiveLayers.length && this.map.queryRenderedFeatures(event.point, { layers: interactiveLayers }).length) return;
      if (this.pinMode) this.addMapPin(event.lngLat.lng, event.lngLat.lat);
      else this.inspectTerrainPoint(event);
    });
    const attribution = this.map.getContainer().querySelector('.maplibregl-ctrl-bottom-right');
    this.attributionObserver = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--attribution-height', `${Math.ceil(attribution.getBoundingClientRect().height)}px`);
      document.documentElement.style.setProperty('--route-summary-height', `${Math.ceil(document.querySelector('.route-summary').getBoundingClientRect().height)}px`);
    });
    this.attributionObserver.observe(attribution);
    this.attributionObserver.observe(document.querySelector('.route-summary'));
    requestAnimationFrame(() => this.map.resize());
  }

  addCartographyLayers() {
    const layers = this.map.getStyle().layers || [];
    const firstLayer = layers.find((layer) => layer.type !== 'background')?.id;
    const lastFill = layers.reduce((index, layer, current) => layer.type === 'fill' ? current : index, -1);
    const firstLine = layers.slice(lastFill + 1).find((layer) => layer.type === 'line' || layer.type === 'symbol')?.id;
    this.map.addSource('local-imagery', {
      type: 'raster', tiles: [IMAGERY_TILE_URL], tileSize: 256, maxzoom: 19,
      attribution: 'Imagery &copy; <a href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9">Esri, Vantor, Earthstar Geographics, GIS User Community</a>',
    });
    this.map.addLayer({ id: 'local-satellite', type: 'raster', source: 'local-imagery', paint: { 'raster-opacity': this.mapMode === 'satellite' ? 1 : 0, 'raster-opacity-transition': { duration: motionDuration(400) }, 'raster-saturation': 0, 'raster-brightness-max': 1, 'raster-contrast': 0, 'raster-resampling': 'linear', 'raster-fade-duration': motionDuration(300) } }, firstLayer);
    this.map.addSource('local-regional-imagery', {
      type: 'raster', tiles: [REGIONAL_IMAGERY.tiles], tileSize: 256, maxzoom: 12, bounds: REGIONAL_IMAGERY.bounds,
      attribution: '<a href="https://www.earthdata.nasa.gov/centers/gibs" target="_blank" rel="noopener">NASA GIBS / HLS</a>; Contains modified Copernicus Sentinel data (2026)',
    });
    this.map.addLayer({ id: 'local-regional-satellite', type: 'raster', source: 'local-regional-imagery', layout: { visibility: 'none' }, paint: { 'raster-saturation': 0, 'raster-brightness-max': 1, 'raster-contrast': 0, 'raster-resampling': 'linear', 'raster-fade-duration': motionDuration(300) } }, firstLayer);
    this.map.addLayer({ id: 'local-hillshade', type: 'hillshade', source: TERRAIN_SOURCE, layout: { visibility: 'none' }, paint: { 'hillshade-exaggeration': 0.7, 'hillshade-illumination-direction': 315 } }, firstLine);
    if (!this.contourDem) return;
    this.map.addSource('local-contour-source', {
      type: 'vector', maxzoom: 15,
      tiles: [this.contourDem.contourProtocolUrl({ thresholds: { 8: [200, 1000], 10: [100, 500], 12: [50, 250], 14: [20, 100], 15: [10, 50] }, multiplier: 1, contourLayer: 'contours', elevationKey: 'ele', levelKey: 'level' })],
    });
    this.map.addLayer({ id: 'local-contours', type: 'line', source: 'local-contour-source', 'source-layer': 'contours', layout: { visibility: 'none' }, paint: { 'line-color': '#827c6d', 'line-opacity': 0.55, 'line-width': ['match', ['get', 'level'], 1, 1, 0.45] } }, firstLine);
    this.map.addLayer({ id: 'local-contour-labels', type: 'symbol', source: 'local-contour-source', 'source-layer': 'contours', filter: ['>', ['get', 'level'], 0], layout: { visibility: 'none', 'symbol-placement': 'line', 'text-field': ['concat', ['to-string', ['get', 'ele']], ' m'], 'text-font': ['Noto Sans Regular'], 'text-size': 9, 'symbol-spacing': 350 }, paint: { 'text-color': '#716b5d', 'text-halo-color': '#e8e5dc', 'text-halo-width': 1 } });
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
      this.setPreviewVisible(this.previewVisible);
    }
    this.updateSatelliteImagery();
    this.updateDashboard();
    this.applyLayerPreferences();
    this.refreshMapMetadata();
    this.studio?.onMapAppearanceChange();
  }

  updateSatelliteImagery() {
    if (!this.map?.getLayer?.('local-regional-satellite')) return;
    const bounds = this.map.getBounds();
    const [west, south, east, north] = REGIONAL_IMAGERY.bounds;
    const eligible = this.mapMode === 'satellite' && this.map.getZoom() >= 10.5 && this.map.getZoom() <= 12 && this.map.getPitch() === 0 &&
      bounds.getWest() >= west && bounds.getEast() <= east && bounds.getSouth() >= south && bounds.getNorth() <= north;
    const active = eligible && this.regionalImageryEnabled && !this.regionalImageryUnavailable;
    if (active !== this.regionalImageryActive) {
      this.elevationController?.abort();
      this.imageryMetadataController?.abort();
      clearTimeout(this.mapMetadataTimer);
      this.mapMetadataState = null;
      this.mapMetadataSequence = (this.mapMetadataSequence || 0) + 1;
    }
    this.regionalImageryActive = active;
    this.map.setLayoutProperty('local-regional-satellite', 'visibility', active ? 'visible' : 'none');
    this.elements['regional-imagery-control'].hidden = !eligible;
    this.elements['regional-overview-toggle'].setAttribute('aria-pressed', String(this.regionalImageryEnabled));
    this.elements['regional-imagery-note'].textContent = this.regionalImageryUnavailable
      ? 'Regional scene unavailable. Aerial composite is active; toggle to retry.'
      : `Bay Area / Sentinel-2 / ${REGIONAL_IMAGERY.date} / 30 m. Clouds and small gaps remain; aerial imagery shows through gaps. Close-up views use the aerial composite.`;
    if (this.mapMode === 'satellite') this.elements['context-mode'].textContent = active ? 'Regional satellite / Sentinel-2 scene' : 'Satellite / Aerial composite';
    if (active !== this.lastImageryMetadataSource) {
      this.elements['context-imagery'].textContent = active ? 'NASA GIBS / HLS Sentinel-2 / 30 m' : 'Esri World Imagery';
      this.elements['context-imagery-date'].textContent = active ? `${REGIONAL_IMAGERY.date} / regional scene` : 'Varies by source';
      this.lastImageryMetadataSource = active;
    }
  }

  setMapMode(mode) {
    if (!['satellite', 'route', 'terrain'].includes(mode)) return;
    if (this.markManualChange()) return;
    if (mode === 'satellite' && this.imageryUnavailable) {
      this.imageryUnavailable = false;
      this.map?.getSource('local-imagery')?.setTiles([IMAGERY_TILE_URL]);
    }
    if (mode === 'satellite' && this.regionalImageryUnavailable) {
      this.regionalImageryUnavailable = false;
      this.map?.getSource('local-regional-imagery')?.setTiles([REGIONAL_IMAGERY.tiles]);
    }
    this.mapMode = mode;
    savePreference('mapMode', mode);
    document.getElementById('map-notice')?.classList.add('is-hidden');
    this.applyMapMode();
    if (mode === 'terrain' && !this.contourDem) this.showMapNotice('Contour library unavailable. Showing shaded terrain only.');
    this.terrainPointPopup?.remove();
    this.saveExploreState();
  }

  setProductMode(mode) {
    if (!['explore', 'studio'].includes(mode) || mode === this.productMode) return;
    this.locationRevision = (this.locationRevision || 0) + 1;
    if (this.productMode === 'explore') this.saveExploreState();
    this.productMode = mode;
    document.documentElement.dataset.productMode = mode;
    document.querySelectorAll('button[data-product-mode]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.productMode === mode)));
    this.setWorkspaceView('explore');
    this.studio?.activate(mode === 'studio');
    this.updateActionChip();
  }

  setWorkspaceView(view) {
    if (!['explore', 'routes', 'workspace'].includes(view)) return;
    this.workspaceView = view;
    if (!this.elements['geo-status'].classList.contains('is-error')) this.setGeoStatus('');
    this.searchFocused = false;
    this.updateSearchDiscovery();
    this.terrainPointPopup?.remove();
    if (this.pinMode) this.setPinMode(false);
    document.querySelectorAll('button[data-workspace-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.workspaceView === view)));
    this.setInfoDrawerOpen(false);
    this.setManualControlsOpen(view !== 'explore');
    this.setGeoToolsOpen(view !== 'explore');
    const utility = document.querySelector('.utility-tools');
    if (utility) utility.open = view === 'workspace';
    if (view === 'routes') this.setMapMode('route');
    document.getElementById('controls-label').textContent = view === 'routes' ? 'Plan a route' : view === 'workspace' ? 'Your workspace' : 'Map controls';
    document.documentElement.dataset.workspaceView = view;
    document.documentElement.dataset.studioLegacy = String(this.productMode === 'studio' && view !== 'explore');
    if (this.productMode === 'studio') this.studio?.setPane('left');
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
    document.documentElement.dataset.hasWorkspace = String(Boolean(this.geo.pins.length || this.geo.areas.length));
    const center = this.map?.getCenter();
    const anchored = center && this.selected && Math.abs(center.lat - this.selected.lat) < .005 && Math.abs(((center.lng - this.selected.lon + 540) % 360) - 180) < .005;
    set('context-place', anchored ? this.selected.shortName || this.selected.name : center ? 'Map center' : 'San Francisco Bay Area');
    set('context-mode', this.mapMode === 'satellite' ? this.regionalImageryActive ? 'Regional satellite / Sentinel-2 scene' : 'Satellite / Aerial composite' : this.mapMode === 'route' ? 'Street map' : 'Topographic / Elevation contours');
    set('context-zoom', this.map ? `${this.map.getZoom().toFixed(1)} / ${this.terrainEnabled ? '3D terrain' : 'Plan view'}` : '--');
    set('context-guidance', this.regionalImageryActive
      ? `Sentinel-2 scene from ${REGIONAL_IMAGERY.date} at 30 m. Clouds and small gaps remain; elevations are sampled, not survey measurements.`
      : 'Aerial imagery is a composite, not a live or single-date capture. Elevations are sampled from a DEM, not survey measurements.');
    set('metric-pins', this.geo.pins.length);
    set('metric-areas', this.geo.areas.filter((area) => !area.summary?.invalid).length);
    set('metric-buildings', (this.buildings || 0).toLocaleString());
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
    set('route-disclaimer', summary?.approximateGeometry
      ? 'Approximate endpoint connector, not a road-following route. Driving distance and time are estimates.'
      : summary?.approximateDuration
        ? 'Driving plan. Time is estimated from distance, not live traffic.'
        : 'Driving plan. Not traffic-aware navigation.');
    const replay = document.getElementById('replay-route');
    replay.hidden = !this.geo.route || !this.routeSearchEdges(this.geo.route).length;
    replay.textContent = this.geo.routeAnimation ? 'Stop replay' : 'Replay calculation';
    set('view-location', this.selected?.name || 'San Francisco Bay Area');
    set('view-title', this.workspaceView === 'routes' ? 'Route Planner' : this.workspaceView === 'workspace' ? 'Saved Places' : this.productMode === 'studio' ? this.studio?.workspace.name || 'Studio workspace' : this.mapMode === 'terrain' ? 'Terrain Explorer' : 'City Explorer');
    set('view-mode-label', this.mapMode === 'satellite' ? 'Satellite imagery' : this.mapMode === 'route' ? 'Monochrome / Streets' : 'Topographic / Contours in meters');
    if (center) set('map-coordinates', `${Math.abs(center.lat).toFixed(4)} ${center.lat < 0 ? 'S' : 'N'} / ${Math.abs(center.lng).toFixed(4)} ${center.lng < 0 ? 'W' : 'E'}`);
    const inspected = this.inspectedCoordinate || center;
    if (inspected) {
      const lon = inspected.lng ?? inspected.lon;
      set('context-coordinates', `${Math.abs(inspected.lat).toFixed(5)}\u00b0 ${inspected.lat < 0 ? 'S' : 'N'}\n${Math.abs(lon).toFixed(5)}\u00b0 ${lon < 0 ? 'W' : 'E'}${this.inspectedCoordinate ? '\nSelected point' : ''}`);
    }
    const terrainControls = document.getElementById('terrain-controls');
    terrainControls.hidden = this.mapMode !== 'terrain' || this.workspaceView !== 'explore';
    if (this.map?.unproject && this.map?.getCanvas) {
      const canvas = this.map.getCanvas();
      const left = this.map.unproject([0, canvas.clientHeight / 2]);
      const right = this.map.unproject([100, canvas.clientHeight / 2]);
      const radians = Math.PI / 180;
      const a = Math.sin((right.lat - left.lat) * radians / 2) ** 2 + Math.cos(left.lat * radians) * Math.cos(right.lat * radians) * Math.sin((right.lng - left.lng) * radians / 2) ** 2;
      const distance = 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
      if (distance > 0 && Number.isFinite(distance)) {
        const power = 10 ** Math.floor(Math.log10(distance));
        const scale = [1, 2, 5, 10].filter((value) => value * power <= distance).at(-1) * power;
        set('context-scale', formatDistance(scale));
        document.getElementById('context-scale-line').style.width = `${Math.round(100 * scale / distance)}px`;
      }
    }
    this.applyLayerPreferences();
    const focus = document.getElementById('focus-route');
    if (focus) focus.disabled = !this.geo.route?.geometry;
    this.updateClock();
  }

  focusRoute() {
    const coordinates = this.geo.route?.geometry?.coordinates || [];
    if (coordinates.length < 2) return;
    const bounds = coordinates.reduce((result, point) => result.extend(point), new window.maplibregl.LngLatBounds(coordinates[0], coordinates[0]));
    const desktop = window.innerWidth > 700;
    const sidebarRight = document.querySelector('.manual-sidebar').getBoundingClientRect().right;
    const top = desktop ? (window.innerWidth <= 1280 ? 160 : 96) : 180;
    this.map.fitBounds(bounds, { padding: desktop ? { top, left: sidebarRight + 24, right: this.productMode === 'studio' ? 350 : 40, bottom: 260 } : { top, right: 24, bottom: Math.min(280, window.innerHeight * .35), left: 24 }, pitch: 0, maxZoom: 16, duration: motionDuration(450) });
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

  setTerrainView(enabled, duration = 420) {
    if (this.markManualChange()) return;
    this.terrainEnabled = enabled;
    this.applyTerrain();
    this.studio?.onMapAppearanceChange();
    this.map.easeTo({ pitch: this.terrainEnabled ? 60 : 0, duration: motionDuration(duration) });
    this.saveExploreState();
  }

  setTheme(theme) {
    this.theme = theme === 'light' ? 'light' : 'dark';
    document.documentElement.dataset.theme = this.theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', this.theme === 'dark' ? '#181b1a' : '#ecece8');
    savePreference('theme', this.theme);
    const toggle = document.getElementById('theme-toggle');
    toggle?.setAttribute('aria-label', `Switch to ${this.theme === 'dark' ? 'light' : 'dark'} mode`);
    toggle?.setAttribute('aria-pressed', String(this.theme === 'light'));
    if (this.map) this.applyMapMode();
  }

  async bootstrap() {
    const revision = this.locationRevision || 0;
    await this.loadWorkspace(false);
    if (this.productMode !== 'explore' || (this.locationRevision || 0) !== revision) {
      this.workspaceReady = true;
      return;
    }
    let saved;
    try { saved = JSON.parse(preference('meridian.explore.v1', 'null')); } catch { /* Invalid saved state is ignored. */ }
    const camera = saved?.camera;
    const validCamera = Array.isArray(camera?.center) && camera.center.length === 2 && camera.center.every(Number.isFinite) &&
      Math.abs(camera.center[0]) <= 180 && Math.abs(camera.center[1]) <= 85.05113 && Number.isFinite(camera.zoom) && camera.zoom >= 0 && camera.zoom <= 22;
    if (this.initializeLocationFromUrl()) {
      // Explicit shared locations take priority over a saved camera.
    } else if (validCamera) {
      const selected = this.agentLocation(saved.selected);
      if (selected) this.chooseLocation(selected, { immediate: true });
      if (['satellite', 'route', 'terrain'].includes(saved.mapMode)) this.mapMode = saved.mapMode;
      for (const name of Object.keys(this.layerPreferences)) if (typeof saved.layerPreferences?.[name] === 'boolean') this.layerPreferences[name] = saved.layerPreferences[name];
      this.contourStrength = Number.isFinite(saved.contourStrength) ? Math.max(.1, Math.min(1, saved.contourStrength)) : .55;
      this.elements['contour-strength'].value = String(Math.round(this.contourStrength * 100));
      this.terrainEnabled = saved.terrainEnabled === true;
      if (Array.isArray(saved.routeStops)) this.geo.routeStops = saved.routeStops.slice(0, MAX_ROUTE_STOPS).map((stop) => ({ query: String(stop.query || '').slice(0, 160), place: this.agentLocation(stop.place), suggestions: [] }));
      this.map.jumpTo({ center: camera.center, zoom: camera.zoom, bearing: Number.isFinite(camera.bearing) ? camera.bearing : 0, pitch: Number.isFinite(camera.pitch) ? Math.max(0, Math.min(78, camera.pitch)) : 0 });
      this.applyTerrain();
      this.applyMapMode();
      this.renderWorkspace();
      this.renderGeography();
    } else await this.initializeLocation();
    this.workspaceReady = true;
    this.saveExploreState();
  }

  async detectCountry() {
    this.country = { country: '', countryCode: localeCountry(), method: 'locale' };
    this.geo.context = { ...this.geo.context, source: 'locale', countryCode: this.country.countryCode || '' };
    this.renderRegion();
  }

  renderRegion() {
    const method = this.country.method === 'geoip' ? 'approximate IP location' : this.country.method === 'locale' ? 'browser language' : 'selected location';
    this.elements['region-label'].textContent = `Search region: ${this.country.country || this.country.countryCode || 'worldwide'} / ${method}`;
    this.elements['status-dot'].classList.remove('pulse');
  }

  async initializeLocation() {
    if (this.initializeLocationFromUrl()) return;
    const revision = this.locationRevision || 0;
    this.setGeoStatus('Opening your approximate Geo-IP location...');
    try {
      const detected = await ipLocation();
      if (this.productMode !== 'explore' || (this.locationRevision || 0) !== revision) return;
      this.applyIpLocation(detected, { immediate: true });
      this.setGeoStatus('');
    } catch {
      if (this.productMode !== 'explore' || (this.locationRevision || 0) !== revision) return;
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
    this.searchController?.abort();
    this.setLoading(false);
    this.setSearchStatus('');
    this.renderSuggestions([]);
    const query = this.elements['search-input'].value.trim();
    this.updateSearchIntent();
    this.updateSearchDiscovery();
    if (this.commandMode || coordinateQuery(query) || mapInstruction(query)) return;
    if (query.length < 2 || this.selected?.name === query) return this.renderSuggestions([]);
    this.suggestionTimer = setTimeout(async () => {
      const controller = new AbortController();
      this.suggestionController = controller;
      this.setLoading(true);
      try {
        const params = new URLSearchParams({ q: query });
        if (this.country.countryCode) params.set('countryCode', this.country.countryCode);
        const result = await jsonRequest(`/api/suggest?${params}`, controller.signal);
        if (controller.signal.aborted || this.elements['search-input'].value.trim() !== query) return;
        this.renderSuggestions(result.results || []);
        if (!result.results?.length) this.setSearchStatus('No suggestions. Include a country, or press Enter to search.');
      } catch (error) {
        if (!controller.signal.aborted && this.elements['search-input'].value.trim() === query) {
          this.renderSuggestions([]);
          this.setSearchStatus('Suggestions unavailable. Press Enter to try a full search.', true);
        }
      } finally {
        if (this.suggestionController === controller && !controller.signal.aborted) this.setLoading(false);
      }
    }, 350);
  }

  renderSuggestions(items) {
    const container = this.elements.suggestions;
    container.replaceChildren();
    this.suggestionIndex = -1;
    this.elements['search-input'].removeAttribute('aria-activedescendant');
    for (const [index, item] of items.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.role = 'option';
      button.id = `city-suggestion-${index}`;
      button.setAttribute('aria-selected', 'false');
      button.tabIndex = -1;
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
    this.dismissIntro();
    this.searchFocused = false;
    this.updateSearchDiscovery();
    const coordinate = coordinateQuery(query);
    if (coordinate) {
      if (coordinate.error) {
        this.setSearchStatus(coordinate.error, true);
        return;
      }
      this.chooseLocation(coordinate);
      this.searchResults = [coordinate];
      this.renderSearchResults();
      this.setGeoStatus(`Centered on ${coordinate.name}. Coordinates use latitude, longitude.`);
      return;
    }
    if (this.commandMode || mapInstruction(query)) {
      clearTimeout(this.suggestionTimer);
      this.suggestionController?.abort();
      this.searchController?.abort();
      this.renderSuggestions([]);
      this.setSearchStatus('');
      this.setLoading(false);
      if (this.studio?.handleInstruction(query)) return;
      if (this.applyLocalInstruction(query)) return;
      return this.startAgentRequest(query);
    }
    return this.resolveSearch(query, this.country.countryCode);
  }

  async resolveSearch(query, countryCode = '') {
    clearTimeout(this.suggestionTimer);
    this.suggestionController?.abort();
    this.searchController?.abort();
    const controller = new AbortController();
    this.searchController = controller;
    this.renderSuggestions([]);
    this.setSearchStatus('Searching...');
    this.setLoading(true);
    try {
      const params = new URLSearchParams({ q: query });
      if (countryCode) params.set('countryCode', countryCode);
      const response = await jsonRequest(`/api/geocode?${params}`, controller.signal);
      if (controller.signal.aborted) return;
      if (!response.result) throw new Error('No matching place. Try adding a city or country.');
      this.chooseLocation(response.result);
    } catch (error) {
      if (!controller.signal.aborted) this.setSearchStatus(`${error.message || 'Search unavailable.'} Edit your search or press Enter to retry.`, true);
    } finally {
      if (this.searchController === controller && !controller.signal.aborted) this.setLoading(false);
    }
  }

  handleSearchKey(event) {
    const options = [...this.elements.suggestions.querySelectorAll('[role="option"]')];
    if (event.key === 'Escape') {
      clearTimeout(this.suggestionTimer);
      this.suggestionController?.abort();
      this.searchController?.abort();
      this.searchFocused = false;
      this.setLoading(false);
      this.renderSuggestions([]);
      this.updateSearchDiscovery();
      if (this.agentQuestionOpen || this.agentRunId || this.agentSubmitting) this.cancelAgentRequest();
      else if (!this.elements['agent-panel'].hidden) this.dismissAgentResult();
      return;
    }
    if (!options.length) return;
    if (event.key === 'Enter' && this.suggestionIndex >= 0) {
      event.preventDefault();
      options[this.suggestionIndex]?.click();
      return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    this.suggestionIndex = this.suggestionIndex < 0
      ? event.key === 'ArrowDown' ? 0 : options.length - 1
      : (this.suggestionIndex + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options.forEach((option, index) => option.setAttribute('aria-selected', String(index === this.suggestionIndex)));
    const active = options[this.suggestionIndex];
    this.elements['search-input'].setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  }

  setSearchStatus(message, error = false) {
    const status = document.getElementById('search-status');
    status.textContent = message;
    status.classList.toggle('is-hidden', !message);
    status.classList.toggle('is-error', error);
  }

  applyIpLocation(detected, { immediate = false } = {}) {
    this.country = { ...detected.country, method: 'geoip' };
    this.chooseLocation(detected.location, { source: 'geoip', immediate });
  }

  chooseLocation(location, { source = 'selected', immediate = false } = {}) {
    if (this.markManualChange()) return;
    this.locationRevision = (this.locationRevision || 0) + 1;
    this.searchController?.abort();
    this.suggestionController?.abort();
    clearTimeout(this.suggestionTimer);
    this.setLoading(false);
    this.setSearchStatus('');
    this.selected = location;
    if (location.countryCode) this.country = { country: location.country || '', countryCode: location.countryCode, method: source };
    this.geo.context = { ...this.geo.context, lat: location.lat, lon: location.lon, source, countryCode: location.countryCode || this.country.countryCode || '' };
    this.elements['search-input'].value = source === 'geoip' ? '' : location.name;
    this.commandMode = false;
    this.searchFocused = false;
    this.updateSearchIntent();
    this.updateSearchDiscovery();
    this.renderSuggestions([]);
    this.renderRegion();
    this.setStream({ loaded: 0, total: 9, buildings: 0, inferred: 0, active: true, preview: true, source: '', degraded: false });
    this.resetMapForLocation({ immediate, overview: source === 'geoip' });
    this.updateDashboard();
    this.saveExploreState();
    this.persistWorkspaceState();
  }

  resetMapForLocation({ immediate = false, overview = false } = {}) {
    const location = this.selected;
    this.features.clear(); this.tileFeatures.clear(); this.tileMetadata.clear(); this.loaded.clear(); this.failed.clear();
    this.buildings = 0; this.inferred = 0; this.total = 9; this.previewVisible = true; this.generation += 1;
    this.map.getSource('local-city')?.setData(EMPTY_COLLECTION);
    this.setPreviewVisible(true);
    if (this.map.getLayer('local-selection')) this.map.setFilter('local-selection', ['==', ['get', 'sourceId'], '__none__']);
    this.map.getSource(FOCUS_SOURCE)?.setData(this.focusFeature(location));
    this.applyTerrain();
    const camera = { center: [location.lon, location.lat], zoom: overview ? 11 : this.mapMode === 'terrain' ? 12 : 14, pitch: this.terrainEnabled ? 45 : 0, bearing: overview || this.mapMode === 'route' ? 0 : -12 };
    if (immediate) this.map.jumpTo(camera);
    else this.map.flyTo({ ...camera, duration: motionDuration(600) });
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
    if (this.map.getLayer(PREVIEW_LAYER)) this.map.setLayoutProperty(PREVIEW_LAYER, 'visibility', visible && this.mapMode !== 'satellite' ? 'visible' : 'none');
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

  refreshMapMetadata() {
    const snapshot = this.mapMetadataSnapshot();
    const previous = this.mapMetadataState;
    if (!snapshot?.elevationVisible) {
      clearTimeout(this.mapMetadataTimer);
      this.elevationController?.abort();
      this.imageryMetadataController?.abort();
      this.mapMetadataState = null;
      this.mapMetadataSequence = (this.mapMetadataSequence || 0) + 1;
      return;
    }
    const cooldown = previous?.failed ? 5000 : 30000;
    if (previous?.key === snapshot.key && previous.map === snapshot.map && previous.dem === snapshot.dem &&
      (previous.pending || Date.now() - previous.finishedAt < cooldown)) return;

    clearTimeout(this.mapMetadataTimer);
    this.elevationController?.abort();
    this.imageryMetadataController?.abort();
    const sequence = this.mapMetadataSequence = (this.mapMetadataSequence || 0) + 1;
    const state = { key: snapshot.key, map: snapshot.map, dem: snapshot.dem, pending: true };
    this.mapMetadataState = state;
    const delay = Math.max(250, 1000 - (Date.now() - (this.mapMetadataStartedAt || 0)));
    this.mapMetadataTimer = setTimeout(() => {
      this.mapMetadataTimer = null;
      if (!this.isMapMetadataCurrent(snapshot, sequence)) {
        if (this.mapMetadataState === state) this.mapMetadataState = null;
        return;
      }
      this.mapMetadataStartedAt = Date.now();
      const requests = [this.refreshElevationMetadata(snapshot, sequence)];
      if (snapshot.detailsOpen) requests.push(this.refreshImageryMetadata(snapshot, sequence));
      Promise.allSettled(requests).then((results) => {
        if (this.mapMetadataState !== state) return;
        if (!this.isMapMetadataCurrent(snapshot, sequence)) {
          this.mapMetadataState = null;
          return;
        }
        state.pending = false;
        state.finishedAt = Date.now();
        state.failed = results.some((result) => result.status === 'rejected' || result.value === false);
      });
    }, delay);
  }

  async sampleElevationPoints(points, zoom, controller = new AbortController()) {
    const locations = Array.isArray(points) ? points.slice(0, 10) : [];
    const elevations = locations.map(() => null);
    const dem = this.contourDem;
    if (!Number.isFinite(zoom) || typeof dem?.getDemTile !== 'function' || controller.signal.aborted) return elevations;
    const z = Math.max(0, Math.min(13, Math.round(zoom)));
    const groups = new Map();
    locations.forEach((location, index) => {
      const point = this.metadataTilePoint(location, z);
      if (!point) return;
      const key = `${z}/${point.x}/${point.y}`;
      if (!groups.has(key)) groups.set(key, { x: point.x, y: point.y, points: [] });
      groups.get(key).points.push({ ...point, index });
    });
    const requests = [...groups.values()].map(async (group) => {
      try {
        const tile = await dem.getDemTile(z, group.x, group.y, controller);
        if (controller.signal.aborted || !Number.isInteger(tile?.width) || !Number.isInteger(tile?.height) ||
          tile.width < 1 || tile.height < 1 || !tile.data || tile.data.length < tile.width * tile.height) return;
        for (const point of group.points) {
          // DEM values lie on pixel centers, not the tile's outer edges.
          const x = Math.max(0, Math.min(tile.width - 1, Math.round(point.u * tile.width - 0.5)));
          const y = Math.max(0, Math.min(tile.height - 1, Math.round(point.v * tile.height - 0.5)));
          const value = tile.data[y * tile.width + x];
          if (Number.isFinite(value) && value >= -12000 && value <= 9000) elevations[point.index] = value;
        }
      } catch {
        // Missing DEM coverage must not be reported as sea level.
      }
    });
    let cancel;
    const cancelled = new Promise((resolve) => {
      cancel = () => resolve();
      controller.signal.addEventListener('abort', cancel, { once: true });
      if (controller.signal.aborted) cancel();
    });
    try {
      // A shared cached DEM request may remain active for other map consumers.
      await Promise.race([Promise.all(requests), cancelled]);
    } finally {
      controller.signal.removeEventListener('abort', cancel);
    }
    return controller.signal.aborted ? locations.map(() => null) : elevations;
  }

  async refreshElevationMetadata(snapshot = this.mapMetadataSnapshot(), sequence = this.mapMetadataSequence) {
    if (!snapshot?.elevationVisible || !this.isMapMetadataCurrent(snapshot, sequence)) return false;
    this.elevationController?.abort();
    const controller = new AbortController();
    this.elevationController = controller;
    const current = () => !controller.signal.aborted && this.isMapMetadataCurrent(snapshot, sequence);
    const set = (id, value, title) => {
      const element = document.getElementById(id);
      if (element) { element.textContent = value; element.title = title || ''; }
    };
    const format = (value) => Number.isFinite(value) ? `~${(Math.round(value) || 0).toLocaleString()} m` : 'Unavailable';
    const contourZoom = Math.max(0, Math.min(15, Math.floor(snapshot.zoom)));
    const intervals = contourZoom >= 15 ? [10, 50] : contourZoom >= 14 ? [20, 100] : contourZoom >= 12 ? [50, 250] : contourZoom >= 10 ? [100, 500] : contourZoom >= 8 ? [200, 1000] : null;
    const contourLabel = intervals
      ? `Nominal contours: ${intervals[0]} m / ${intervals[1]} m major${snapshot.pitch > 0 ? '; pitch may mix intervals' : ''}.`
      : 'Contours start at nominal zoom 8.';
    const provenance = `Mapzen Terrain Tiles via AWS, composite DEM / sampled DEM z${snapshot.demZoom}. Unexaggerated meters; native resolution varies. Acquisition date and vertical accuracy are not supplied.`;
    const render = (values = []) => {
      const viewport = values.slice(1).filter(Number.isFinite);
      set('context-center-elevation', format(values[0]), provenance);
      set('terrain-center-elevation', format(values[0]), provenance);
      set('terrain-range-low', format(viewport.length ? Math.min(...viewport) : null), 'Lowest valid viewport sample, not the minimum terrain elevation.');
      set('terrain-range-high', format(viewport.length ? Math.max(...viewport) : null), 'Highest valid viewport sample, not the maximum terrain elevation.');
      set('terrain-interval', `Sampled viewport range (${viewport.length}/9 points), not exact extrema. ${contourLabel}`, provenance);
      return Number.isFinite(values[0]) || viewport.length > 0;
    };
    set('context-elevation', 'Mapzen / Terrain Tiles via AWS (composite DEM)', provenance);
    set('context-center-elevation', 'Sampling...', provenance);
    set('terrain-center-elevation', 'Sampling...', provenance);
    set('terrain-range-low', '--', 'Sampled viewport range, not exact extrema.');
    set('terrain-range-high', '--', 'Sampled viewport range, not exact extrema.');
    set('terrain-interval', `Sampling viewport range. ${contourLabel}`, provenance);
    const timeout = setTimeout(() => {
      if (current()) render();
      controller.abort();
    }, 12000);
    try {
      const points = [snapshot.center];
      for (const y of [0.1, 0.5, 0.9]) for (const x of [0.1, 0.5, 0.9]) {
        try { points.push(snapshot.map.unproject([snapshot.width * x, snapshot.height * y])); }
        catch { points.push(null); }
      }
      const elevations = await this.sampleElevationPoints(points, snapshot.demZoom, controller);
      return current() ? render(elevations) : false;
    } catch {
      if (current()) render();
      return false;
    } finally {
      clearTimeout(timeout);
      if (this.elevationController === controller) this.elevationController = null;
    }
  }

  async refreshImageryMetadata(snapshot = this.mapMetadataSnapshot(), sequence = this.mapMetadataSequence) {
    if (!snapshot?.detailsOpen || !this.isMapMetadataCurrent(snapshot, sequence)) return false;
    this.imageryMetadataController?.abort();
    if (snapshot.mapMode !== 'satellite') {
      this.elements['context-imagery'].textContent = 'Not shown / OpenFreeMap topographic base';
      this.elements['context-imagery-date'].textContent = 'Not applicable';
      return true;
    }
    if (snapshot.regionalImagery) {
      this.elements['context-imagery'].textContent = 'NASA GIBS / HLS Sentinel-2 / 30 m';
      this.elements['context-imagery-date'].textContent = `${REGIONAL_IMAGERY.date} / regional scene`;
      this.elements['context-imagery'].title = 'Adjacent HLS S30 tiles from the same Sentinel-2C pass. Reflectance imagery at 30 m; clouds and small coverage gaps remain. Aerial imagery shows through transparent pixels. Not live imagery or a global cloudless mosaic.';
      return true;
    }
    const controller = new AbortController();
    this.imageryMetadataController = controller;
    const current = () => !controller.signal.aborted && this.isMapMetadataCurrent(snapshot, sequence);
    const footprint = `Center footprint / nominal imagery LOD ${snapshot.imageryLod}`;
    const set = (id, value, title) => {
      const element = document.getElementById(id);
      if (element) { element.textContent = value; element.title = title || ''; }
    };
    const sourceMetric = (value) => value !== null && value !== undefined && String(value).trim() && Number.isFinite(Number(value)) && Number(value) > 0
      ? `${Number(value).toLocaleString(undefined, { maximumFractionDigits: 3 })} m` : 'Not supplied';
    const sourceDate = (citation) => {
      const raw = String(citation?.SRC_DATE ?? '');
      const match = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
      if (match) {
        const label = `${match[1]}-${match[2]}-${match[3]}`;
        const date = new Date(`${label}T00:00:00Z`);
        if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === label) return label;
      }
      const alternate = citation?.SRC_DATE2;
      if (alternate !== null && alternate !== undefined && String(alternate).trim() && Number.isFinite(Number(alternate))) {
        const date = new Date(Number(alternate));
        if (Number.isFinite(date.getTime())) return date.toISOString().slice(0, 10);
      }
      return 'Not supplied';
    };
    const render = (entry) => {
      const citation = entry?.citation;
      const name = String(citation?.NICE_NAME || citation?.NICE_DESC || 'Source name not supplied').trim().slice(0, 100);
      const description = String(citation?.NICE_DESC || '').trim().slice(0, 100);
      const resolution = sourceMetric(citation?.SRC_RES);
      const accuracy = sourceMetric(citation?.SRC_ACC);
      const release = String(citation?.ReleaseName || 'Not supplied').trim().slice(0, 100);
      const detail = `${footprint}. Satellite/aerial composite, not live or a viewport-wide acquisition date. ${description}\nSource resolution: ${resolution}; reported source accuracy: ${accuracy}. Service release: ${release}.${entry?.overlaps > 1 ? ` Highest DrawOrder citation shown among ${entry.overlaps} overlapping footprints.` : ''} Pitch/terrain can select mixed imagery LODs.`;
      set('context-imagery', `Esri World Imagery / ${citation ? `${name}${resolution !== 'Not supplied' ? ` / ${resolution} source resolution` : ''}` : 'Citation unavailable'} / ${footprint}${snapshot.pitch > 0 ? ' (view may mix LODs)' : ''}`, detail);
      set('context-imagery-date', `${entry ? sourceDate(citation) : 'Unavailable'} / center footprint only`, detail);
      return Boolean(citation);
    };
    set('context-imagery', `Esri World Imagery / Loading citation / ${footprint}`, 'Center footprint only; nominal LOD, not viewport-wide coverage.');
    set('context-imagery-date', 'Loading citation...', 'Acquisition dates apply only to the queried center footprint.');
    const timeout = setTimeout(() => {
      if (current()) render(null);
      controller.abort();
    }, 12000);
    try {
      const tile = this.metadataTilePoint(snapshot.center, snapshot.imageryLod);
      // Keep the actual query point in the key: citation seams can cross one tile.
      const key = `${snapshot.imageryLod}/${tile.x}/${tile.y}/${snapshot.center.lon},${snapshot.center.lat}`;
      const cache = this.imageryMetadataCache || (this.imageryMetadataCache = new Map());
      let entry = cache.get(key);
      if (entry && Date.now() - entry.at >= (entry.citation ? 300000 : 30000)) { cache.delete(key); entry = null; }
      if (!entry) {
        const params = new URLSearchParams({
          f: 'json', geometry: JSON.stringify({ x: snapshot.center.lon, y: snapshot.center.lat, spatialReference: { wkid: 4326 } }),
          geometryType: 'esriGeometryPoint', inSR: '4326', spatialRel: 'esriSpatialRelIntersects',
          where: `MinMapLevel<=${snapshot.imageryLod} AND MaxMapLevel>=${snapshot.imageryLod}`,
          outFields: 'SRC_DATE,SRC_DATE2,SRC_RES,SRC_ACC,NICE_NAME,NICE_DESC,ReleaseName,DrawOrder',
          returnGeometry: 'false', orderByFields: 'DrawOrder DESC', resultRecordCount: '20',
        });
        const response = await fetch(`https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/4/query?${params}`, { signal: controller.signal, credentials: 'omit' });
        if (!response.ok) throw new Error('Imagery citation unavailable.');
        const payload = await response.json();
        if (payload.error || !Array.isArray(payload.features)) throw new Error('Imagery citation unavailable.');
        const priority = (record) => record.DrawOrder !== null && record.DrawOrder !== undefined && Number.isFinite(Number(record.DrawOrder)) ? Number(record.DrawOrder) : -Infinity;
        const records = payload.features.slice(0, 20).map((feature) => feature.attributes).filter((record) => record && typeof record === 'object')
          .sort((first, second) => priority(second) - priority(first));
        if (!current()) return false;
        entry = { at: Date.now(), citation: records[0] || null, overlaps: records.length };
      }
      if (!current()) return false;
      cache.delete(key);
      cache.set(key, entry);
      while (cache.size > 20) cache.delete(cache.keys().next().value);
      return render(entry);
    } catch {
      if (current()) render(null);
      return false;
    } finally {
      clearTimeout(timeout);
      if (this.imageryMetadataController === controller) this.imageryMetadataController = null;
    }
  }

  async inspectTerrainPoint(event) {
    const map = this.map;
    if (!map || this.viewMode || this.workspaceView !== 'explore' || this.mapMode !== 'terrain' || !window.maplibregl?.Popup) return;
    const zoom = Math.max(0, Math.min(13, Math.round(map.getZoom() + 1)));
    const point = this.metadataTilePoint(event?.lngLat, zoom);
    if (!point) return;
    this.terrainPointController?.abort();
    this.terrainPointPopup?.remove();
    const sequence = this.terrainPointSequence = (this.terrainPointSequence || 0) + 1;
    const controller = new AbortController();
    const dem = this.contourDem;
    this.terrainPointController = controller;
    const location = { id: `terrain:${point.lat.toFixed(6)},${point.lon.toFixed(6)}`, name: `Terrain point ${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}`, lat: point.lat, lon: point.lon, provider: 'coordinates', countryCode: '' };
    const content = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = 'Terrain point';
    const elevation = document.createElement('span');
    elevation.className = 'popup-type';
    elevation.textContent = 'Sampling elevation...';
    const coordinates = document.createElement('span');
    coordinates.className = 'popup-meta';
    coordinates.textContent = `${point.lat.toFixed(5)}, ${point.lon.toFixed(5)} (latitude, longitude)`;
    const source = document.createElement('span');
    source.className = 'popup-meta';
    source.textContent = `Mapzen / Terrain Tiles via AWS, composite DEM / z${zoom}. Approximate unexaggerated meters; native resolution varies.`;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'popup-action';
    action.textContent = 'Use as route start';
    content.append(title, elevation, coordinates, source, action);
    const popup = new window.maplibregl.Popup({ closeButton: true, className: 'mono-popup', offset: 12, maxWidth: '300px' })
      .setLngLat([point.lon, point.lat]).setDOMContent(content).addTo(map);
    this.terrainPointPopup = popup;
    this.inspectedCoordinate = { lon: point.lon, lat: point.lat };
    this.terrainPointMarker?.remove();
    if (window.maplibregl.Marker) {
      const marker = document.createElement('span');
      marker.className = 'inspection-marker';
      marker.setAttribute('aria-hidden', 'true');
      this.terrainPointMarker = new window.maplibregl.Marker({ element: marker }).setLngLat([point.lon, point.lat]).addTo(map);
    }
    this.updateDashboard();
    document.documentElement.dataset.terrainPoint = 'true';
    const active = () => this.terrainPointSequence === sequence && this.terrainPointPopup === popup &&
      this.map === map && !this.viewMode && this.workspaceView === 'explore' && this.mapMode === 'terrain';
    const current = () => active() && !controller.signal.aborted && this.contourDem === dem;
    popup.on('close', () => {
      if (this.terrainPointPopup !== popup) return;
      this.terrainPointPopup = null;
      this.terrainPointSequence = (this.terrainPointSequence || 0) + 1;
      controller.abort();
      if (this.terrainPointController === controller) this.terrainPointController = null;
      document.documentElement.dataset.terrainPoint = 'false';
      this.terrainPointMarker?.remove();
      this.terrainPointMarker = null;
      this.inspectedCoordinate = null;
      this.updateDashboard();
    });
    action.addEventListener('click', () => {
      if (!active()) return;
      popup.remove();
      this.setWorkspaceView('routes');
      this.chooseRouteStop(0, location);
    });
    const timeout = setTimeout(() => {
      if (current()) elevation.textContent = 'Elevation unavailable';
      controller.abort();
    }, 12000);
    try {
      const [value] = await this.sampleElevationPoints([location], zoom, controller);
      if (current()) elevation.textContent = Number.isFinite(value)
        ? `Approximately ${(Math.round(value) || 0).toLocaleString()} m (unexaggerated sample)` : 'Elevation unavailable';
    } catch {
      if (current()) elevation.textContent = 'Elevation unavailable';
    } finally {
      clearTimeout(timeout);
      if (this.terrainPointController === controller) this.terrainPointController = null;
    }
  }

  metadataTilePoint(location, zoom) {
    const longitude = location?.lng ?? location?.lon ?? location?.[0];
    const latitude = location?.lat ?? location?.[1];
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude) || !Number.isInteger(zoom) || zoom < 0 || zoom > 19) return null;
    const wrapped = longitude % 360;
    const lon = wrapped >= 180 ? wrapped - 360 : wrapped < -180 ? wrapped + 360 : wrapped;
    const lat = Math.max(-85.0511287798066, Math.min(85.0511287798066, latitude));
    const scale = 2 ** zoom;
    const worldX = Math.max(0, Math.min(scale * (1 - Number.EPSILON), (lon + 180) / 360 * scale));
    const radians = lat * Math.PI / 180;
    const worldY = Math.max(0, Math.min(scale, (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2 * scale));
    const x = ((Math.floor(worldX) % scale) + scale) % scale;
    const y = Math.max(0, Math.min(scale - 1, Math.floor(worldY)));
    return { lon, lat, x, y, u: worldX - Math.floor(worldX), v: Math.max(0, Math.min(1, worldY - y)) };
  }

  mapMetadataSnapshot() {
    if (!this.map) return null;
    try {
      const map = this.map;
      const center = this.metadataTilePoint(map.getCenter(), 0);
      const canvas = map.getCanvas();
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const zoom = map.getZoom();
      const pitch = map.getPitch();
      const bearing = map.getBearing();
      const padding = map.getPadding?.() || {};
      const terrain = map.getTerrain?.();
      if (!center || !Number.isFinite(zoom) || !Number.isFinite(pitch) || !Number.isFinite(bearing) ||
        !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
      const detailsOpen = document.getElementById('info-drawer-content')?.hidden === false;
      const imageryLod = Math.max(0, Math.min(19, Math.round(zoom + 1)));
      return {
        map, dem: this.contourDem, center: { lon: center.lon, lat: center.lat }, width, height, zoom, pitch, bearing, detailsOpen, imageryLod,
        regionalImagery: this.regionalImageryActive === true,
        mapMode: this.mapMode,
        demZoom: Math.min(13, imageryLod), elevationVisible: detailsOpen || (this.workspaceView === 'explore' && this.mapMode === 'terrain'),
        key: [center.lon, center.lat, width, height, zoom, pitch, bearing, padding.top, padding.right, padding.bottom, padding.left,
          terrain?.source, terrain?.exaggeration, detailsOpen, this.workspaceView, this.mapMode, this.regionalImageryActive].join('|'),
      };
    } catch { return null; }
  }

  isMapMetadataCurrent(snapshot, sequence) {
    return Boolean(snapshot && this.mapMetadataSequence === sequence && this.map === snapshot.map && this.contourDem === snapshot.dem &&
      !snapshot.map.isMoving?.() && this.mapMetadataSnapshot()?.key === snapshot.key);
  }

  setLoading(loading) {
    this.searchLoading = loading;
    this.elements['search-loader'].classList.toggle('is-hidden', !(loading || this.agentSubmitting || this.agentRunId));
  }

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
    if (this.viewMode || this.studio?.tool) return;
    const feature = event.features?.[0];
    if (!feature) return;
    const properties = feature.properties || {};
    const sourceId = properties.sourceId;
    this.map.setFilter('local-selection', ['==', ['get', 'sourceId'], sourceId || '__none__']);
    this.buildingPopup?.remove();
    const content = document.createElement('div');
    content.className = 'building-popup';
    const title = document.createElement('strong');
    title.className = 'building-title';
    const buildingType = String(properties.buildingType || properties.class || 'Building');
    title.textContent = properties.name || (buildingType === 'yes' || buildingType === 'unknown' ? 'Building' : readable(buildingType));
    const type = document.createElement('span');
    type.className = 'building-subtitle';
    const dataSource = sourceName(properties.source) || (properties.render_height ? 'OpenStreetMap preview' : 'Open data');
    type.textContent = properties.name && !['yes', 'unknown', 'building'].includes(buildingType.toLowerCase()) ? `${readable(buildingType)} / ${dataSource}` : dataSource;
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
    const metric = document.createElement('div');
    metric.className = 'building-height';
    const value = document.createElement('strong');
    value.textContent = height || '--';
    const label = document.createElement('span');
    label.textContent = !height ? 'Height unavailable' : Number(properties.inferred) === 1 || String(properties.heightSource || '').startsWith('hbet-') ? 'Estimated height' : 'Height';
    metric.append(value, label);
    addDetail('Base height', baseHeight);
    const floors = numeric(properties.levels);
    addDetail('Floors', floors > 0 ? floors.toLocaleString() : '');
    addDetail('Estimated floors', levelRange(properties.estimatedLevelRange));
    addDetail('Height method', heightMethod(properties));
    addDetail('Height confidence', heightConfidence(properties));
    addDetail('Height adjustment', Number(properties.heightAdjustedToBase) === 1 ? 'Raised above source base height' : '');
    addDetail('Community', properties.community);
    addDetail('Record ID', sourceId || properties.osm_id || properties.id);
    addDetail('Map coordinate', `${event.lngLat.lat.toFixed(6)}, ${event.lngLat.lng.toFixed(6)}`);
    const more = document.createElement('details');
    more.className = 'building-more';
    const summary = document.createElement('summary');
    summary.textContent = 'Building details';
    more.append(summary, details);
    content.append(title, type, metric, more);
    const popup = new window.maplibregl.Popup({ closeButton: true, className: 'building-card', offset: 18, maxWidth: '320px' }).setLngLat(event.lngLat).setDOMContent(content).addTo(this.map);
    popup.on('close', () => { if (this.buildingPopup === popup) this.buildingPopup = null; });
    this.buildingPopup = popup;
  }

  showPoi(event) {
    if (this.viewMode || this.studio?.tool) return;
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
    if (this.studio?.tool) return;
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
    this.elements['geo-status'].classList.toggle('is-hidden', !message);
    clearTimeout(this.geoStatusTimer);
    if (message && !error) this.geoStatusTimer = setTimeout(() => this.elements['geo-status'].classList.add('is-hidden'), 6500);
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
    this.saveExploreState();
    this.persistWorkspaceState();
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
      marker.textContent = index === 0 ? 'From' : index === plan.length - 1 ? 'To' : `Waypoint ${index}`;
      const field = document.createElement('div');
      field.className = 'route-stop-field';
      const input = document.createElement('input');
      input.type = 'text';
      input.value = stop.query;
      input.placeholder = index === 0 ? 'Starting point' : index === plan.length - 1 ? 'Destination' : 'Stop';
      input.autocomplete = 'off';
      input.setAttribute('aria-label', index === 0 ? 'Route starting point' : index === plan.length - 1 ? 'Route destination' : `Route waypoint ${index}`);
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
      up.dataset.routeAction = 'up';
      up.textContent = '^';
      up.disabled = index === 0;
      up.setAttribute('aria-label', `Move stop ${this.routeStopLabel(index)} earlier`);
      up.addEventListener('click', () => this.moveRouteStop(index, -1));
      const down = document.createElement('button');
      down.type = 'button';
      down.dataset.routeAction = 'down';
      down.textContent = 'v';
      down.disabled = index === plan.length - 1;
      down.setAttribute('aria-label', `Move stop ${this.routeStopLabel(index)} later`);
      down.addEventListener('click', () => this.moveRouteStop(index, 1));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'X';
      remove.setAttribute('aria-label', `Remove stop ${this.routeStopLabel(index)}`);
      remove.dataset.routeAction = 'remove';
      remove.addEventListener('click', () => this.removeRouteStop(index));
      row.append(marker, field, up, down, remove);
      container.append(row);
      this.renderRouteStopSuggestions(index);
    }
    const selectedCount = plan.filter((stop) => stop.place).length;
    const complete = selectedCount === plan.length && selectedCount >= 2;
    this.elements['route-stop-count'].textContent = `${selectedCount} STOP${selectedCount === 1 ? '' : 'S'}`;
    this.elements['trace-route'].disabled = !complete || this.routeSubmitting;
    this.elements['trace-route'].textContent = this.routeSubmitting ? 'Calculating...' : 'Plan route';
    this.elements['route-plan-hint'].textContent = !complete
        ? 'Press Enter to find a place, then choose a match. Driving routes only.'
      : `${selectedCount} stops in order. Distance and time are road-network estimates.`;
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
    const center = this.map?.getCenter?.();
    if (center) return { lat: center.lat, lon: center.lng };
    return null;
  }

  setRouteStopQuery(index, query) {
    if (this.markManualChange()) return;
    const stop = this.routePlan()[index];
    if (!stop) return;
    stop.query = query;
    stop.place = null;
    stop.suggestions = [];
    this.stopRouteAnimation(false);
    this.geo.route = null;
    this.renderGeography();
    const complete = this.routePlan().every((item) => item.place);
    this.elements['trace-route'].disabled = !complete || this.routeSubmitting;
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
    const coordinate = coordinateQuery(query);
    if (coordinate) {
      if (coordinate.error) this.setGeoStatus(coordinate.error, true);
      else this.chooseRouteStop(index, coordinate);
      return;
    }
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
    if (this.markManualChange()) return;
    if (this.workspaceView !== 'routes') this.setWorkspaceView('routes');
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
    this.map.flyTo({ center: [place.lon, place.lat], zoom: Math.max(14, this.map.getZoom()), duration: motionDuration(450) });
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
    button.textContent = enabled ? 'Cancel map pick' : 'Pick on map';
    const workspaceButton = this.elements['workspace-pin-mode'];
    workspaceButton.setAttribute('aria-pressed', String(enabled));
    workspaceButton.classList.toggle('is-active', enabled);
    workspaceButton.textContent = enabled ? 'Cancel map pick' : 'Save a map point';
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
      if (this.workspaceView === 'routes') this.chooseRouteStop(this.activeRouteStopIndex, { id: pin.id, name: pin.name, lat: pin.lat, lon: pin.lon, countryCode: '' });
    } catch (error) {
      this.setGeoStatus(error.message, true);
    }
  }

  async addPin(pin) {
    if (this.markManualChange()) throw new Error('A workspace undo is still in progress.');
    const response = await postJson('/api/pins', pin);
    this.geo.pins.push(response.pin);
    this.renderWorkspace();
    this.renderGeography();
    return response.pin;
  }

  async removePin(pinId) {
    if (this.markManualChange()) return;
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
      this.geo.context = { lat: coords.latitude, lon: coords.longitude, accuracy: coords.accuracy, source: 'browser', countryCode: this.country.countryCode || '' };
      this.map.flyTo({ center: [coords.longitude, coords.latitude], zoom: Math.max(14, this.map.getZoom()), duration: motionDuration(450) });
      this.locationMarker?.remove();
      if (window.maplibregl?.Marker) {
        const marker = document.createElement('span');
        marker.className = 'inspection-marker';
        marker.setAttribute('aria-hidden', 'true');
        this.locationMarker = new window.maplibregl.Marker({ element: marker }).setLngLat([coords.longitude, coords.latitude]).addTo(this.map);
      }
      try {
        const context = await jsonRequest(`/api/context?lat=${coords.latitude}&lon=${coords.longitude}`);
        this.country = context.country || this.country;
        this.geo.context = { lat: coords.latitude, lon: coords.longitude, accuracy: coords.accuracy, source: 'browser', countryCode: this.country.countryCode || '' };
        this.renderRegion();
        if (this.workspaceView === 'routes') this.chooseRouteStop(this.activeRouteStopIndex, { id: `browser:${coords.latitude.toFixed(6)},${coords.longitude.toFixed(6)}`, name: 'My location', lat: coords.latitude, lon: coords.longitude, countryCode: this.country.countryCode || '' });
        this.setGeoStatus(`${this.workspaceView === 'routes' ? 'Added your location to the route plan' : 'Centered on your location'}${coords.accuracy ? ` (about ${Math.round(coords.accuracy)} m accuracy)` : ''}.`);
      } catch (error) {
        this.setGeoStatus('Centered on your location. Place details are unavailable; map navigation remains active.', true);
      }
    }, (error) => this.setGeoStatus(error.code === 1 ? 'Location permission was not granted. Allow it in browser settings or search for a place instead.' : 'Your location could not be determined. Try again or search for a place.', true), { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
  }

  async createPinArea() {
    if (this.markManualChange()) return;
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
    if (this.markManualChange()) return;
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
    this.map.fitBounds(bounds, { padding: 90, maxZoom: 16, duration: motionDuration(450) });
  }

  async removeArea(areaId) {
    if (this.markManualChange()) return;
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
    if (this.markManualChange()) return;
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
    if (this.markManualChange()) return;
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
    if (this.markManualChange()) return;
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
    if (this.markManualChange()) return;
    if (this.routeSubmitting) return;
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
    this.routeSubmitting = true;
    this.elements['trace-route'].disabled = true;
    this.elements['trace-route'].textContent = 'Calculating...';
    try {
      const response = await postJson('/api/routes', { profile: 'driving', waypoints: stops.map((pin) => [pin.lon, pin.lat]) });
      if (this.routePlan().length !== stops.length || this.routePlan().some((stop, index) => stop.place !== stops[index])) {
        this.setGeoStatus('The stops changed while calculating. Trace the updated plan to get a new route.');
        return;
      }
      this.stopRouteAnimation(false);
      this.geo.route = response.route;
      this.setWorkspaceView('routes');
      this.renderWorkspace();
      const { summary } = response.route;
      const note = summary.approximateGeometry ? ' External fallback distance shown with an endpoint connector.' : '';
      this.setGeoStatus(summary.approximateGeometry
        ? `${formatDistance(summary.distanceMeters)} / ${formatDuration(summary.durationSeconds)} for this ${stops.length}-stop plan.${note}`
        : `${formatDistance(summary.distanceMeters)} / ${formatDuration(summary.durationSeconds)} estimated driving time across ${stops.length} stops.`);
      this.renderGeography();
      this.focusRoute();
    } catch (error) {
      this.setGeoStatus(error.message, true);
    } finally {
      this.routeSubmitting = false;
      const complete = this.routePlan().length >= 2 && this.routePlan().every((stop) => stop.place);
      this.elements['trace-route'].disabled = !complete;
      this.elements['trace-route'].textContent = 'Plan route';
    }
  }

  async clearAdditions(confirmed = false) {
    if (this.markManualChange()) return;
    if (!confirmed) {
      const dialog = document.getElementById('clear-workspace-dialog');
      dialog.returnValue = '';
      dialog.showModal();
      return;
    }
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
    if (target instanceof Element && target.closest('dialog[open]')) return;
    if (event.key === 'Escape' && this.viewMode) {
      event.preventDefault();
      this.setViewMode(false);
      return;
    }
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.tagName?.toLowerCase() === 'select' || target?.isContentEditable) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey && this.productMode === 'studio') this.studio?.redo();
      else this.undoMapAction();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape' && this.agentQuestionOpen) {
      event.preventDefault();
      this.cancelAgentRequest();
      return;
    }
    if (event.key === 'Escape' && this.pinMode) {
      event.preventDefault();
      this.setPinMode(false);
      this.setGeoStatus('Map pin mode turned off.');
      return;
    }
    if (event.key === 'Escape') {
      if (this.studio?.handleEscape()) { event.preventDefault(); return; }
      if (this.terrainPointPopup) this.terrainPointPopup.remove();
      else if (document.getElementById('info-drawer-content').hidden === false) this.setInfoDrawerOpen(false);
      else if (this.agentRunId || this.agentSubmitting) this.cancelAgentRequest();
      else if (!this.elements['agent-panel'].hidden) this.dismissAgentResult();
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      if (this.viewMode) this.setViewMode(false);
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
    if (['in', 'out', 'reset'].includes(action)) this.cameraInteractionRevision = (this.cameraInteractionRevision || 0) + 1;
    if (action === 'in') this.map.zoomIn({ duration: motionDuration(250) });
    if (action === 'out') this.map.zoomOut({ duration: motionDuration(250) });
    if (action === 'pitch') this.setTerrainView(!this.terrainEnabled);
    if (action === 'reset') this.map.easeTo({ bearing: 0, duration: motionDuration(280) });
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  if (!window.maplibregl?.Map) {
    const notice = document.getElementById('map-notice');
    notice.textContent = 'The map library could not load. Check your connection and reload Meridian.';
    notice.classList.remove('is-hidden');
    return;
  }
  if ('serviceWorker' in navigator) {
    try {
      await Promise.race([
        navigator.serviceWorker.register('./map-cache-worker.js').then(async () => {
          await navigator.serviceWorker.ready;
          if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
        }),
        new Promise((resolve) => window.setTimeout(resolve, 1200)),
      ]);
    } catch { /* Cache is optional, including on non-secure origins. */ }
  }
  new CityExplorer();
});
