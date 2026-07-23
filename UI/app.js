import { API_BASE_URL, apiPath } from './config.js';

const TILE_ZOOM = 14;
const ACCENT = '#315efb';
const PREVIEW_LAYER = 'local-buildings-preview';
const FOCUS_SOURCE = 'local-city-focus';
const EMPTY_COLLECTION = { type: 'FeatureCollection', features: [] };

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

async function jsonRequest(path, signal) {
  const response = await fetch(apiPath(path), { signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
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
    if (layer.id.startsWith('local-')) continue;
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
  applyMonochrome(map, theme);
}

class CityExplorer {
  constructor() {
    this.elements = Object.fromEntries(['search-input', 'search-form', 'search-loader', 'suggestions', 'region-label', 'status-dot', 'stream-card', 'stream-title', 'stream-count', 'stream-progress', 'stream-buildings', 'stream-source', 'intro-card'].map((id) => [id, document.getElementById(id)]));
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
    this.worker = new Worker(new URL('./tile-worker.js', import.meta.url), { type: 'module' });
    this.setTheme(this.theme);
    this.bindUi();
    this.createMap();
    this.initializeLocation();
  }

  bindUi() {
    const el = this.elements;
    el['search-form'].addEventListener('submit', (event) => this.submitSearch(event));
    el['search-input'].addEventListener('input', () => this.queueSuggestions());
    el['search-input'].addEventListener('focus', () => { if (this.selected?.name !== el['search-input'].value) this.selected = null; });
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
      this.renderRegion();
    };
    if (!navigator.geolocation) return fallback();
    navigator.geolocation.getCurrentPosition(async ({ coords }) => {
      try { this.country = await jsonRequest(`/api/country?lat=${coords.latitude}&lon=${coords.longitude}`); } catch { await fallback(); }
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
    if (feature) this.map.setFilter('local-hover', ['==', ['get', 'sourceId'], feature.properties.sourceId]);
  }

  clearBuildingHover() {
    this.map.getCanvas().style.cursor = '';
    this.map.setFilter('local-hover', ['==', ['get', 'sourceId'], '__none__']);
  }

  showBuilding(event) {
    const feature = event.features?.[0];
    if (!feature) return;
    this.map.setFilter('local-selection', ['==', ['get', 'sourceId'], feature.properties.sourceId]);
    const content = document.createElement('div');
    const height = document.createElement('strong');
    height.textContent = `${Math.round(Number(feature.properties.height))} M`;
    const type = document.createElement('span');
    type.className = 'popup-type';
    type.textContent = String(feature.properties.buildingType || 'Building').replace(/\b\w/g, (letter) => letter.toUpperCase());
    const source = document.createElement('span');
    source.className = 'popup-meta';
    source.textContent = `${String(feature.properties.source || 'open data').toUpperCase()} / ${Number(feature.properties.inferred) === 1 ? 'ESTIMATED HEIGHT' : 'CONFIRMED HEIGHT'}`;
    content.append(height, type, source);
    new window.maplibregl.Popup({ closeButton: false, className: 'mono-popup', offset: 12 }).setLngLat(event.lngLat).setDOMContent(content).addTo(this.map);
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
