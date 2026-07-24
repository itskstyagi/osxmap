import { API_BASE_URL, apiPath } from './config.js';

const TILE_ZOOM = 14;
const ACCENT = '#315efb';
const PREVIEW_LAYER = 'local-buildings-preview';
const FOCUS_SOURCE = 'local-city-focus';
const GEOGRAPHY_SOURCE = 'local-geography';
const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };

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

function sourceName(value) {
  const source = String(value || '');
  return source === 'openstreetmap' ? 'OpenStreetMap' : source === 'openbuildingmap' ? 'OpenBuildingMap' : source === 'overture' ? 'Overture Maps' : readable(source);
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
    paint: { 'fill-extrusion-color': '#e0e0da', 'fill-extrusion-height': ['get', 'height'], 'fill-extrusion-base': ['get', 'minHeight'], 'fill-extrusion-opacity': 0.94, 'fill-extrusion-vertical-gradient': false },
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
  map.addLayer({ id: 'geo-route-casing', type: 'line', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route'], paint: { 'line-color': '#ffffff', 'line-width': 7, 'line-opacity': 0.9 } });
  map.addLayer({ id: 'geo-route', type: 'line', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'route'], paint: { 'line-color': ACCENT, 'line-width': 4, 'line-opacity': 1 } });
  map.addLayer({ id: 'geo-pin', type: 'circle', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'pin'], paint: { 'circle-radius': 7, 'circle-color': ACCENT, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 } });
  map.addLayer({ id: 'geo-pin-label', type: 'symbol', source: GEOGRAPHY_SOURCE, filter: ['==', ['get', 'overlay'], 'pin'], layout: { 'text-field': ['get', 'label'], 'text-size': 9, 'text-font': ['Open Sans Bold', 'Arial Unicode MS Bold'], 'text-allow-overlap': true, 'text-ignore-placement': true }, paint: { 'text-color': '#ffffff' } });
  applyMonochrome(map, theme);
}

class CityExplorer {
  constructor() {
    this.elements = Object.fromEntries(['search-input', 'search-form', 'search-loader', 'suggestions', 'region-label', 'status-dot', 'stream-card', 'stream-title', 'stream-count', 'stream-progress', 'stream-buildings', 'stream-source', 'intro-card', 'place-form', 'place-input', 'place-results', 'use-location', 'pin-mode', 'show-area', 'clear-additions', 'route-form', 'route-origin', 'route-destination', 'pin-list', 'geo-status'].map((id) => [id, document.getElementById(id)]));
    this.theme = localStorage.getItem('theme') || 'dark';
    this.country = { country: '', countryCode: '', method: 'detecting' };
    this.selected = null;
    this.stream = { loaded: 0, total: 0, buildings: 0, active: false, preview: false, source: '', degraded: false };
    this.features = new Map();
    this.tileFeatures = new Map();
    this.loaded = new Set();
    this.failed = new Set();
    this.total = 0;
    this.buildings = 0;
    this.source = '';
    this.generation = 0;
    this.previewVisible = true;
    this.suggestionController = null;
    this.suggestionTimer = null;
    this.placeSearchController = null;
    this.pinMode = false;
    this.geo = { pins: [], areas: [], route: null, state: {}, context: { lat: null, lon: null, source: 'unknown', accuracy: null } };
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
    el['place-form'].addEventListener('submit', (event) => this.searchPlaces(event));
    el['use-location'].addEventListener('click', () => this.useBrowserLocation());
    el['pin-mode'].addEventListener('click', () => this.togglePinMode());
    el['show-area'].addEventListener('click', () => this.createPinArea());
    el['clear-additions'].addEventListener('click', () => this.clearAdditions());
    el['route-form'].addEventListener('submit', (event) => this.findRoute(event));
    document.querySelectorAll('[data-map-action]').forEach((button) => button.addEventListener('click', () => this.operate(button.dataset.mapAction)));
    document.addEventListener('keydown', (event) => this.handleShortcut(event));
    this.worker.onmessage = ({ data }) => this.handleWorkerMessage(data);
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
    this.map.on('movestart', () => { if (this.selected && this.map.getZoom() >= 13) this.setPreviewVisible(true); });
    this.map.on('moveend', () => { if (this.selected && this.map.getZoom() >= 13) this.worker.postMessage({ type: 'append', tiles: visibleTiles(this.map) }); });
    this.map.on('dblclick', (event) => {
      if (!this.selected) return;
      event.preventDefault();
      this.operate('reset');
    });
    this.map.on('click', (event) => {
      if (this.pinMode) this.addMapPin(event.lngLat.lng, event.lngLat.lat);
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
    const fallback = async () => {
      try { this.country = await jsonRequest('/api/country'); } catch { this.country = { country: '', countryCode: localeCountry(), method: 'locale' }; }
      this.geo.context = { ...this.geo.context, source: this.country.method || 'locale', countryCode: this.country.countryCode || '' };
      this.renderRegion();
    };
    if (!navigator.geolocation) return fallback();
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try {
        this.country = await jsonRequest(`/api/country?lat=${coords.latitude}&lon=${coords.longitude}`);
        this.geo.context = { lat: coords.latitude, lon: coords.longitude, accuracy: coords.accuracy, source: 'browser', countryCode: this.country.countryCode || '' };
      } catch { await fallback(); }
      this.renderRegion();
    }, fallback, { timeout: 5000, maximumAge: 86400000 });
  }

  renderRegion() {
    this.elements['region-label'].textContent = `Search region: ${this.country.country || this.country.countryCode || 'worldwide'}`;
    this.elements['status-dot'].classList.remove('pulse');
  }

  async initializeLocation() {
    if (this.initializeLocationFromUrl()) return;
    try {
      const detected = await ipLocation();
      if (this.selected || this.elements['search-input'].value.trim()) return;
      this.country = detected.country;
      this.geo.context = { lat: detected.location.lat, lon: detected.location.lon, accuracy: null, source: 'ip', countryCode: detected.country.countryCode || '' };
      this.renderRegion();
      this.chooseLocation(detected.location);
    } catch {
      this.detectCountry();
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
    this.setStream({ loaded: 0, total: 9, buildings: 0, active: true, preview: true, source: '', degraded: false });
    this.resetMapForLocation();
  }

  resetMapForLocation() {
    const location = this.selected;
    this.features.clear(); this.tileFeatures.clear(); this.loaded.clear(); this.failed.clear();
    this.buildings = 0; this.source = ''; this.total = 9; this.previewVisible = true; this.generation += 1;
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
      this.total = data.total;
      if (data.added > 0) this.setPreviewVisible(true);
      this.setStream({ ...this.stream, total: data.total, active: true, preview: this.previewVisible });
      return;
    }
    if (data.type !== 'tile' && data.type !== 'tileError') return;
    this.loaded.add(data.key);
      if (data.type === 'tile') {
        this.failed.delete(data.key);
        if (data.source !== 'none') this.source = data.source;
        this.tileFeatures.delete(data.key);
        this.tileFeatures.set(data.key, data.features);
        this.features.clear(); this.buildings = 0;
      for (const [tileKey, tileFeatures] of this.tileFeatures) for (const feature of tileFeatures) {
        const properties = feature.properties || {};
        const key = properties.sourceId ? `${properties.source}:${properties.sourceId}:${properties.kind}` : `${tileKey}:${this.features.size}`;
        if (!this.features.has(key) && properties.kind === 'building') this.buildings += 1;
        this.features.set(key, feature);
      }
      this.map.getSource('local-city')?.setData({ type: 'FeatureCollection', features: [...this.features.values()] });
    } else this.failed.add(data.key);
    if (this.loaded.size >= this.total && this.buildings > 0 && this.failed.size === 0) this.setPreviewVisible(false);
    this.setStream({ loaded: this.loaded.size, total: this.total, buildings: this.buildings, source: this.source, active: true, preview: this.previewVisible, degraded: this.failed.size > 0 });
  }

  setPreviewVisible(visible) {
    this.previewVisible = visible;
    if (this.map.getLayer(PREVIEW_LAYER)) this.map.setLayoutProperty(PREVIEW_LAYER, 'visibility', visible ? 'visible' : 'none');
  }

  setStream(stream) {
    this.stream = stream;
    const el = this.elements;
    el['stream-card'].classList.toggle('is-hidden', !stream.active);
    el['stream-card'].classList.toggle('is-loading', stream.active && stream.loaded < stream.total);
    if (!stream.active) return;
    el['stream-title'].textContent = stream.degraded ? 'OSM PREVIEW' : stream.loaded < stream.total ? 'ENRICHING CITY' : stream.preview ? 'OSM PREVIEW' : 'CITY READY';
    el['stream-count'].textContent = `${stream.loaded}/${stream.total}`;
    el['stream-progress'].style.width = `${Math.min(100, (stream.loaded / Math.max(stream.total, 1)) * 100)}%`;
    el['stream-buildings'].textContent = stream.preview && stream.buildings === 0 ? 'procedural buildings' : `${stream.buildings.toLocaleString()} buildings`;
    el['stream-source'].textContent = stream.preview ? 'OSM / transient heights' : stream.source || 'cache / open data';
    el['intro-card'].classList.toggle('is-hidden', Boolean(this.selected));
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

  geographyFeatures() {
    const features = this.geo.pins.map((pin) => ({
      type: 'Feature', geometry: { type: 'Point', coordinates: [pin.lon, pin.lat] },
      properties: { overlay: 'pin', id: pin.id, label: pin.label, name: pin.name },
    }));
    for (const area of this.geo.areas) features.push({
      type: 'Feature', geometry: area.geometry,
      properties: { overlay: 'area', id: area.id, label: area.label, areaSquareMeters: area.summary?.areaSquareMeters || 0 },
    });
    if (this.geo.route?.geometry) features.push({
      type: 'Feature', geometry: this.geo.route.geometry,
      properties: { overlay: 'route', id: this.geo.route.id, temporary: Boolean(this.geo.route.temporary) },
    });
    return { type: 'FeatureCollection', features };
  }

  renderGeography() {
    this.map?.getSource(GEOGRAPHY_SOURCE)?.setData(this.geographyFeatures());
  }

  setGeoStatus(message, error = false) {
    this.elements['geo-status'].textContent = message;
    this.elements['geo-status'].classList.toggle('is-error', error);
  }

  renderWorkspace() {
    const pins = this.geo.pins;
    const list = this.elements['pin-list'];
    list.replaceChildren();
    for (const pin of pins) {
      const row = document.createElement('div');
      const label = document.createElement('strong');
      label.textContent = pin.label;
      const name = document.createElement('span');
      name.textContent = pin.name;
      const origin = document.createElement('button');
      origin.type = 'button';
      origin.textContent = 'FROM';
      origin.addEventListener('click', () => this.setRouteEndpoint('origin', pin.id));
      const destination = document.createElement('button');
      destination.type = 'button';
      destination.textContent = 'TO';
      destination.addEventListener('click', () => this.setRouteEndpoint('destination', pin.id));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'X';
      remove.setAttribute('aria-label', `Remove ${pin.name}`);
      remove.addEventListener('click', () => this.removePin(pin.id));
      row.append(label, name, origin, destination, remove);
      list.append(row);
    }
    const originValue = this.geo.state.originPinId || this.elements['route-origin'].value;
    const destinationValue = this.geo.state.destinationPinId || this.elements['route-destination'].value;
    for (const [element, selected] of [[this.elements['route-origin'], originValue], [this.elements['route-destination'], destinationValue]]) {
      element.replaceChildren();
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = pins.length ? 'Choose pin' : 'Add pins first';
      element.append(placeholder);
      for (const pin of pins) {
        const option = document.createElement('option');
        option.value = pin.id;
        option.textContent = `${pin.label} / ${pin.name}`;
        option.selected = pin.id === selected;
        element.append(option);
      }
      element.disabled = pins.length < 2;
    }
  }

  async loadWorkspace() {
    try {
      const workspace = await jsonRequest('/api/workspace');
      this.geo.pins = Array.isArray(workspace.pins) ? workspace.pins : [];
      this.geo.areas = Array.isArray(workspace.areas) ? workspace.areas : [];
      this.geo.state = workspace.state && typeof workspace.state === 'object' ? workspace.state : {};
      if (this.geo.state.routeId) {
        try { this.geo.route = (await jsonRequest(`/api/routes/${encodeURIComponent(this.geo.state.routeId)}`)).route || null; } catch { this.geo.state.routeId = ''; }
      }
      this.renderWorkspace();
      this.renderGeography();
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

  async searchPlaces(event) {
    event.preventDefault();
    const query = this.elements['place-input'].value.trim();
    if (query.length < 2) {
      this.setGeoStatus('Enter at least two characters to find a place.', true);
      return;
    }
    this.placeSearchController?.abort();
    this.placeSearchController = new AbortController();
    const params = new URLSearchParams({ q: query });
    const context = this.placeContext();
    if (this.country.countryCode) params.set('countryCode', this.country.countryCode);
    if (context) {
      params.set('lat', String(context.lat));
      params.set('lon', String(context.lon));
    }
    this.setGeoStatus('Searching OSM places...');
    try {
      const response = await jsonRequest(`/api/places?${params}`, this.placeSearchController.signal);
      this.placeResults = Array.isArray(response.results) ? response.results : [];
      this.renderPlaceResults();
      this.setGeoStatus(this.placeResults.length ? `${this.placeResults.length} place${this.placeResults.length === 1 ? '' : 's'} found${response.stored ? ' from local storage' : ''}.` : 'No place found in the current geographic context.', !this.placeResults.length);
    } catch (error) {
      if (error.name !== 'AbortError') this.setGeoStatus(error.message, true);
    }
  }

  renderPlaceResults() {
    const container = this.elements['place-results'];
    container.replaceChildren();
    for (const place of this.placeResults || []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.role = 'option';
      const provider = document.createElement('b');
      provider.textContent = place.provider === 'openstreetmap' ? 'OSM' : 'SERP';
      const copy = document.createElement('span');
      const name = document.createElement('strong');
      name.textContent = place.name;
      const address = document.createElement('small');
      address.textContent = place.address || `${place.lat.toFixed(5)}, ${place.lon.toFixed(5)}`;
      copy.append(name, address);
      const marker = document.createElement('span');
      marker.className = 'location-swatch';
      button.append(marker, copy, provider);
      button.addEventListener('click', () => this.selectPlace(place));
      container.append(button);
    }
    container.classList.toggle('is-hidden', !container.childElementCount);
  }

  async selectPlace(place) {
    try {
      await this.addPin({ name: place.name, lat: place.lat, lon: place.lon, placeId: place.id, source: 'place' });
      this.geo.context = { lat: place.lat, lon: place.lon, source: 'selected', countryCode: place.countryCode || this.country.countryCode || '' };
      if (place.countryCode) this.country = { ...this.country, countryCode: place.countryCode, method: 'selected' };
      this.renderRegion();
      this.elements['place-results'].classList.add('is-hidden');
      this.map.flyTo({ center: [place.lon, place.lat], zoom: Math.max(15, this.map.getZoom()), duration: 900, essential: true });
      this.setGeoStatus(`Pinned ${place.name}.`);
    } catch (error) {
      this.setGeoStatus(error.message, true);
    }
  }

  togglePinMode() {
    this.pinMode = !this.pinMode;
    this.elements['pin-mode'].classList.toggle('is-active', this.pinMode);
    this.map.getCanvas().style.cursor = this.pinMode ? 'crosshair' : '';
    this.setGeoStatus(this.pinMode ? 'Click the map to add a pin.' : 'Map pin mode turned off.');
  }

  async addMapPin(lon, lat) {
    this.pinMode = false;
    this.elements['pin-mode'].classList.remove('is-active');
    this.map.getCanvas().style.cursor = '';
    try {
      await this.addPin({ name: `Map pin ${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon, source: 'map-click' });
      this.setGeoStatus('Map pin added.');
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
      this.geo.route = null;
      if (this.geo.state.originPinId === pinId) this.geo.state.originPinId = '';
      if (this.geo.state.destinationPinId === pinId) this.geo.state.destinationPinId = '';
      this.geo.state.routeId = '';
      await this.persistWorkspaceState();
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
        this.setGeoStatus(`Using browser location${coords.accuracy ? ` (about ${Math.round(coords.accuracy)} m accuracy)` : ''}.`);
      } catch (error) {
        this.setGeoStatus(error.message, true);
      }
    }, () => this.setGeoStatus('Browser location permission was not granted.', true), { enableHighAccuracy: false, timeout: 8000, maximumAge: 300000 });
  }

  async createPinArea() {
    if (this.geo.pins.length < 3) {
      this.setGeoStatus('Add at least three pins before measuring an area.', true);
      return;
    }
    const ring = this.geo.pins.map((pin) => [pin.lon, pin.lat]);
    ring.push([...ring[0]]);
    if (selfIntersectsRing(ring)) {
      this.setGeoStatus('These pins cross when joined in creation order. Reorder them by removing and adding them around the boundary.', true);
      return;
    }
    const areaSquareMeters = polygonAreaSquareMeters(ring);
    try {
      const response = await postJson('/api/areas', { label: `Area / ${this.geo.pins.map((pin) => pin.label).join(', ')}`, geometry: { type: 'Polygon', coordinates: [ring] }, summary: { areaSquareMeters, pinIds: this.geo.pins.map((pin) => pin.id) } });
      this.geo.areas.push(response.area);
      this.renderGeography();
      const label = areaSquareMeters >= 1_000_000 ? `${(areaSquareMeters / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 2 })} sq km` : `${Math.round(areaSquareMeters).toLocaleString()} sq m`;
      this.setGeoStatus(`Area shown: ${label}.`);
    } catch (error) {
      this.setGeoStatus(error.message, true);
    }
  }

  setRouteEndpoint(kind, pinId) {
    if (kind === 'origin') this.geo.state.originPinId = pinId;
    if (kind === 'destination') this.geo.state.destinationPinId = pinId;
    this.renderWorkspace();
    this.persistWorkspaceState();
  }

  async persistWorkspaceState() {
    const state = { originPinId: this.geo.state.originPinId || '', destinationPinId: this.geo.state.destinationPinId || '', routeId: this.geo.state.routeId || '' };
    try {
      this.geo.state = await postJson('/api/workspace/state', { state });
    } catch {
      // The map remains usable if the local workspace state cannot be saved.
    }
  }

  async findRoute(event) {
    event.preventDefault();
    const originId = this.elements['route-origin'].value;
    const destinationId = this.elements['route-destination'].value;
    const origin = this.geo.pins.find((pin) => pin.id === originId);
    const destination = this.geo.pins.find((pin) => pin.id === destinationId);
    if (!origin || !destination || origin.id === destination.id) {
      this.setGeoStatus('Choose two different pins for a driving route.', true);
      return;
    }
    this.geo.state = { ...this.geo.state, originPinId: origin.id, destinationPinId: destination.id };
    this.setGeoStatus('Finding an OSM driving route...');
    try {
      const response = await postJson('/api/routes', { profile: 'driving', waypoints: [[origin.lon, origin.lat], [destination.lon, destination.lat]] });
      this.geo.route = response.route;
      this.geo.state.routeId = response.route.id;
      await this.persistWorkspaceState();
      this.renderWorkspace();
      this.renderGeography();
      const { summary } = response.route;
      const note = summary.approximateGeometry ? ' External fallback distance shown with an endpoint connector.' : '';
      this.setGeoStatus(`${formatDistance(summary.distanceMeters)} / ${formatDuration(summary.durationSeconds)}${response.route.stored ? ' from local storage.' : '.'}${note}`);
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
      this.geo.route = null;
      this.geo.state = {};
      this.renderWorkspace();
      this.renderGeography();
      this.setGeoStatus('Pins, areas, and the displayed route were cleared. Stored place and OSM route records remain available.');
    } catch (error) {
      this.setGeoStatus(error.message, true);
    }
  }

  handleShortcut(event) {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
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
