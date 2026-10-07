import { normalizeCollection, normalizeColor, fieldsFor, boundsFor } from './studio-data.js';

export const MAP_ACTIONS_VERSION = 1;
export const MAP_ACTION_NAMES = Object.freeze(['add_layer', 'style_layer', 'set_visibility', 'remove_layer', 'clear_overlays', 'move_layer', 'filter_layer', 'fit_layer', 'set_view', 'set_basemap', 'set_terrain', 'set_display']);
export const MAP_ACTION_LIMITS = Object.freeze({ layers: 32, features: 10000, positions: 100000, actions: 64, layerBytes: 4 * 1024 * 1024, storageBytes: 4 * 1024 * 1024, combinedStorageBytes: 8 * 1024 * 1024 });
export const DEFAULT_OVERLAY_STYLE = Object.freeze({ color: '#d0dac5', fillColor: '#d0dac5', opacity: .85, fillOpacity: .18, lineWidth: 3, pointRadius: 7, strokeColor: '#ffffff', strokeWidth: 1.5, dashArray: Object.freeze([]), labels: true, labelColor: '#ffffff', labelSize: 12 });

const NUMBERS = { opacity: [0, 1], fillOpacity: [0, 1], lineWidth: [0, 24], pointRadius: [1, 40], strokeWidth: [0, 10], labelSize: [8, 32] };
const DISPLAY = ['labels', 'buildings', 'roads', 'places', 'boundaries', 'contours', 'hillshade'];
const SOURCE_LENGTHS = { name: 160, url: 2048, attribution: 500, license: 300, caveat: 1000 };
const STORAGE_KEY = 'meridian.map-actions.v1';
const EMPTY = Object.freeze({ type: 'FeatureCollection', features: Object.freeze([]) });
const SCHEMAS = {
  add_layer: ['layer'], style_layer: ['layerId', 'style'], set_visibility: ['layerId', 'visible'], remove_layer: ['layerId'], clear_overlays: [],
  move_layer: ['layerId', 'beforeLayerId'], filter_layer: ['layerId', 'field', 'operator', 'value'], fit_layer: ['layerId'],
  set_view: ['center', 'zoom', 'pitch', 'bearing', 'bounds'], set_basemap: ['mode'], set_terrain: ['enabled', 'exaggeration'], set_display: ['preference', 'enabled'],
};
let nextDrawing = 0;

function record(value, path, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${path} must be a plain JSON object.`);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || ['__proto__', 'constructor', 'prototype'].includes(key) || descriptor.get || descriptor.set) throw new Error(`${path} contains an unsafe property.`);
    if (keys && !keys.includes(key)) throw new Error(`Unknown ${path} key "${key}".`);
  }
  return value;
}

function dense(value, path, minimum, maximum) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw new Error(`${path} requires ${minimum} to ${maximum} entries.`);
  for (let i = 0; i < value.length; i++) {
    const item = Object.getOwnPropertyDescriptor(value, i);
    if (!item || item.get || item.set) throw new Error(`${path} must be a dense JSON array.`);
  }
  return value;
}

function text(value, path, maximum, empty = false) {
  if (typeof value !== 'string' || value.length > maximum || !empty && !value.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw new Error(`${path} must be ${empty ? 'text' : 'non-empty text'} of at most ${maximum} characters.`);
  return value.trim();
}

function identifier(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,63}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('Layer IDs require 1 to 64 letters, digits, dots, underscores, colons or hyphens.');
  return value;
}

function finite(value, path, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${path} must be a finite number from ${minimum} to ${maximum}.`);
  return value;
}

function boolean(value, path) {
  if (typeof value !== 'boolean') throw new Error(`${path} must be a boolean.`);
  return value;
}

function color(value, path) {
  try {
    const normalized = normalizeColor(value);
    if (normalized) return normalized;
  } catch { /* Overlay colors cannot reset to an analytical palette. */ }
  throw new Error(`${path} requires #rgb, #rrggbb, or a basic CSS color name (for example red or blue).`);
}

export function validateOverlayStyle(input, base = DEFAULT_OVERLAY_STYLE) {
  record(input, 'style', Object.keys(DEFAULT_OVERLAY_STYLE));
  const style = { ...base };
  for (const [key, value] of Object.entries(input)) {
    if (Object.hasOwn(NUMBERS, key)) style[key] = finite(value, `style.${key}`, ...NUMBERS[key]);
    else if (['color', 'fillColor', 'strokeColor', 'labelColor'].includes(key)) style[key] = color(value, `style.${key}`);
    else if (key === 'labels') style[key] = boolean(value, 'style.labels');
    else if (key === 'dashArray') {
      dense(value, 'style.dashArray', 0, 4);
      if (value.length === 1 || value.some((number) => typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 24) || value.length && !value.some((number) => number > 0)) throw new Error('style.dashArray requires two to four finite dash lengths from 0 to 24, or [] to reset.');
      style.dashArray = Object.freeze([...value]);
    }
  }
  if (Object.hasOwn(input, 'color') && !Object.hasOwn(input, 'fillColor')) style.fillColor = style.color;
  return Object.freeze(style);
}

function sourceMetadata(input = {}) {
  record(input, 'source', Object.keys(SOURCE_LENGTHS));
  const source = { name: 'User-provided GeoJSON', caveat: 'Source and accuracy are user supplied, not independently verified.' };
  for (const [key, value] of Object.entries(input)) source[key] = text(value, `source.${key}`, SOURCE_LENGTHS[key], true);
  if (source.url) {
    let url;
    try { url = new URL(source.url); } catch { throw new Error('source.url must be a public HTTP(S) citation URL, not a data source to fetch.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || !url.hostname || /^(?:localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|\[|.*\.local$)/i.test(url.hostname) || /^172\.(?:1[6-9]|2\d|3[01])\./.test(url.hostname)) throw new Error('source.url must be a public HTTP(S) citation URL without credentials.');
    source.url = url.href;
  }
  return Object.freeze(source);
}

function center(value) {
  dense(value, 'center', 2, 2);
  return [finite(value[0], 'center longitude', -180, 180), finite(value[1], 'center latitude', -85.05113, 85.05113)];
}

function bounds(value) {
  dense(value, 'bounds', 4, 4);
  const result = value.map((number, i) => finite(number, `bounds[${i}]`, i % 2 ? -90 : -180, i % 2 ? 90 : 180));
  if (result[1] >= result[3] || result[0] === result[2] || result[0] - result[2] === 360) throw new Error('bounds must have a nonzero geographic extent in [west, south, east, north] order.');
  return result;
}

function view(input) {
  const result = {};
  if (Object.hasOwn(input, 'center')) result.center = center(input.center);
  if (Object.hasOwn(input, 'bounds')) result.bounds = bounds(input.bounds);
  if (result.center && result.bounds) throw new Error('set_view accepts center or bounds, not both.');
  for (const [key, range] of Object.entries({ zoom: [0, 22], pitch: [0, 78], bearing: [-360, 360] })) if (Object.hasOwn(input, key)) result[key] = finite(input[key], key, ...range);
  if (!Object.keys(result).length) throw new Error('set_view requires a center, bounds, zoom, pitch or bearing.');
  return result;
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function filter(input, data) {
  if (input.field === null) {
    if (Object.hasOwn(input, 'operator') || Object.hasOwn(input, 'value')) throw new Error('A cleared filter accepts field:null only.');
    return null;
  }
  const field = text(input.field, 'filter field', 128);
  if (['__proto__', 'constructor', 'prototype'].includes(field) || !data.features.some((feature) => Object.hasOwn(feature.properties, field))) throw new Error(`Filter field "${field}" does not exist in this layer.`);
  if (!['eq', 'neq', 'gt', 'gte', 'lt', 'lte'].includes(input.operator)) throw new Error('Filter operator must be eq, neq, gt, gte, lt or lte.');
  const value = input.value;
  if (!(value === null || typeof value === 'boolean' || typeof value === 'string' && value.length <= 160 || typeof value === 'number' && Number.isFinite(value))) throw new Error('Filter value must be a finite JSON scalar, with text limited to 160 characters.');
  if (!['eq', 'neq'].includes(input.operator) && (typeof value !== 'number' || !data.features.some((feature) => typeof feature.properties[field] === 'number'))) throw new Error('Ordered filters require a numeric value and a numeric field; no expressions or coercion are supported.');
  return Object.freeze({ field, operator: input.operator, value });
}

function matches(feature, rule) {
  if (!rule) return true;
  if (!Object.hasOwn(feature.properties, rule.field)) return false;
  const value = feature.properties[rule.field];
  if (rule.operator === 'eq') return value === rule.value;
  if (rule.operator === 'neq') return value !== rule.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  return rule.operator === 'gt' ? value > rule.value : rule.operator === 'gte' ? value >= rule.value : rule.operator === 'lt' ? value < rule.value : value <= rule.value;
}

export function overlayIds(id) {
  const prefix = `agent-overlay-${encodeURIComponent(identifier(id))}`;
  return { source: `${prefix}-source`, fill: `${prefix}-fill`, outline: `${prefix}-outline`, line: `${prefix}-line`, point: `${prefix}-point`, label: `${prefix}-label` };
}

export function overlayStyleLayers(layer) {
  const ids = overlayIds(layer.id), style = layer.style;
  const base = { source: ids.source, layout: { visibility: layer.visible ? 'visible' : 'none' } };
  const linePaint = { 'line-color': style.color, 'line-opacity': style.opacity, 'line-width': style.lineWidth, ...(style.dashArray.length ? { 'line-dasharray': [...style.dashArray] } : {}) };
  return [
    { ...base, id: ids.fill, type: 'fill', filter: ['==', ['geometry-type'], 'Polygon'], paint: { 'fill-color': style.fillColor, 'fill-opacity': style.fillOpacity } },
    { ...base, id: ids.outline, type: 'line', filter: ['==', ['geometry-type'], 'Polygon'], layout: { ...base.layout, 'line-join': 'round' }, paint: { ...linePaint } },
    { ...base, id: ids.line, type: 'line', filter: ['==', ['geometry-type'], 'LineString'], layout: { ...base.layout, 'line-cap': 'round', 'line-join': 'round' }, paint: { ...linePaint } },
    { ...base, id: ids.point, type: 'circle', filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-color': style.color, 'circle-opacity': style.opacity, 'circle-radius': style.pointRadius, 'circle-stroke-color': style.strokeColor, 'circle-stroke-width': style.strokeWidth, 'circle-stroke-opacity': style.opacity } },
    { ...base, id: ids.label, type: 'symbol', layout: { ...base.layout, visibility: layer.visible && style.labels ? 'visible' : 'none', 'text-field': ['get', '__meridianLabel'], 'text-font': ['Noto Sans Regular'], 'text-size': style.labelSize, 'text-offset': [0, 1.1], 'text-anchor': 'top', 'text-max-width': 18, 'symbol-placement': layer.data.features.every((feature) => ['LineString', 'MultiLineString'].includes(feature.geometry.type)) ? 'line' : 'point', 'symbol-spacing': 400 }, paint: { 'text-color': style.labelColor, 'text-opacity': style.opacity, 'text-halo-color': '#171b18', 'text-halo-width': 1.5 } },
  ];
}

export class MeridianMapActions {
  constructor(app, { storage } = {}) {
    this.app = app;
    this.layers = Object.freeze([]);
    this.rendered = new Map();
    this.snapshots = new WeakSet();
    this.dataSizes = new WeakMap();
    this.dataIds = new WeakMap();
    this.dataFields = new WeakMap();
    this.dataBounds = new WeakMap();
    this.dataTypes = new WeakMap();
    this.nextDataId = 0;
    this.revision = 0;
    try { this.storage = storage === undefined ? globalThis.localStorage : storage; } catch { this.storage = null; }
    this.load();
  }

  getCapabilities() { return [...MAP_ACTION_NAMES]; }

  guard() {
    return this.layers.map(({ data, ...layer }) => ({ ...layer, dataId: this.dataIds.get(data) }));
  }

  getLayers() {
    return this.layers.map((layer) => {
      if (!this.dataFields.has(layer.data)) this.dataFields.set(layer.data, fieldsFor(layer.data));
      if (!this.dataBounds.has(layer.data)) this.dataBounds.set(layer.data, boundsFor(layer.data));
      if (!this.dataTypes.has(layer.data)) this.dataTypes.set(layer.data, [...new Set(layer.data.features.map((feature) => feature.geometry.type))].sort());
      const available = this.dataFields.get(layer.data);
      const cached = this.rendered.get(layer.id);
      return {
        id: layer.id, name: layer.name, geometryTypes: [...this.dataTypes.get(layer.data)],
        featureCount: layer.data.features.length, bounds: [...this.dataBounds.get(layer.data)], visible: layer.visible, style: { ...layer.style, dashArray: [...layer.style.dashArray] },
        numericFields: available.numeric.filter((field) => field.length <= 128).slice(0, 16), categoricalFields: available.categorical.filter((field) => field.length <= 128).slice(0, 16),
        source: { ...layer.source }, filter: layer.filter ? { ...layer.filter } : null,
        matchingFeatureCount: cached?.data === layer.data && cached?.filter === layer.filter ? cached.result.features.length : layer.data.features.reduce((count, feature) => count + Number(matches(feature, layer.filter)), 0),
      };
    });
  }

  context() {
    const layers = this.getLayers();
    for (const layer of layers) {
      layer.name = layer.name.slice(0, 80);
      layer.numericFields = layer.numericFields.map((field) => field.slice(0, 64)).slice(0, 8);
      layer.categoricalFields = layer.categoricalFields.map((field) => field.slice(0, 64)).slice(0, 8);
      for (const key of Object.keys(layer.source)) layer.source[key] = layer.source[key].slice(0, key === 'url' ? 512 : 160);
    }
    const context = { version: MAP_ACTIONS_VERSION, layers, capabilities: this.getCapabilities() };
    if (JSON.stringify(context).length > 24000) for (const layer of layers) {
      delete layer.numericFields; delete layer.categoricalFields;
      layer.source = { name: layer.source.name.slice(0, 80), ...(layer.source.url ? { url: layer.source.url.slice(0, 240) } : {}) };
    }
    if (JSON.stringify(context).length > 24000) for (const layer of layers) {
      layer.name = layer.name.slice(0, 40);
      layer.source = { name: layer.source.name.slice(0, 32) };
      delete layer.filter; delete layer.matchingFeatureCount;
    }
    return context;
  }

  captureSnapshot() {
    const snapshot = Object.freeze({ version: MAP_ACTIONS_VERSION, layers: this.layers });
    this.snapshots.add(snapshot);
    return snapshot;
  }

  prepare(input) {
    const actions = Array.isArray(input) ? dense(input, 'actions', 1, MAP_ACTION_LIMITS.actions) : [input];
    const layers = [...this.layers], effects = [], touched = new Set();
    const find = (id) => {
      const index = layers.findIndex((layer) => layer.id === identifier(id));
      if (index < 0) throw new Error(`Overlay layer "${id}" does not exist. Use a layerId from the map inventory, not a basemap layer ID.`);
      return index;
    };
    for (const input of actions) {
      record(input, 'action');
      if (typeof input.action !== 'string' || !Object.hasOwn(SCHEMAS, input.action)) throw new Error(`Unknown map action${typeof input.action === 'string' ? ` "${input.action.slice(0, 80)}"` : ''}.`);
      record(input, input.action, ['action', ...SCHEMAS[input.action]]);
      const action = input.action;
      if (action === 'add_layer') {
        const spec = record(input.layer, 'layer', ['id', 'name', 'data', 'style', 'source', 'visible']);
        const id = identifier(spec.id), name = text(spec.name, 'layer.name', 120);
        const previous = layers.find((layer) => layer.id === id);
        record(spec.data, 'layer.data');
        if (spec.data.type !== 'FeatureCollection') throw new Error('layer.data must be an inline GeoJSON FeatureCollection; remote URLs are not supported.');
        const data = this.dataSizes.has(spec.data) ? spec.data : deepFreeze(normalizeCollection(spec.data));
        if (!data.features.length) throw new Error('An overlay requires at least one valid geographic feature.');
        if (!this.dataSizes.has(data)) {
          this.dataSizes.set(data, new TextEncoder().encode(JSON.stringify(data)).length);
          this.dataIds.set(data, ++this.nextDataId);
        }
        if (this.dataSizes.get(data) > MAP_ACTION_LIMITS.layerBytes) throw new Error('An overlay exceeds the 4 MiB GeoJSON data limit.');
        const style = validateOverlayStyle(spec.style === undefined ? {} : spec.style, previous?.style), source = spec.source === undefined ? previous?.source || sourceMetadata() : sourceMetadata(spec.source);
        const rule = previous?.filter ? filter(previous.filter, data) : null;
        const layer = Object.freeze({ id, name, data, style, source, visible: spec.visible === undefined ? previous?.visible ?? true : boolean(spec.visible, 'layer.visible'), filter: rule });
        if (previous) layers[layers.indexOf(previous)] = layer; else layers.push(layer);
        if (layers.length > MAP_ACTION_LIMITS.layers) throw new Error('The map can hold at most 32 overlay layers. Remove an unused overlay first.');
        touched.add(id);
      } else if (action === 'clear_overlays') {
        for (const layer of layers) touched.add(layer.id);
        layers.length = 0;
      } else if (['style_layer', 'set_visibility', 'remove_layer', 'move_layer', 'filter_layer', 'fit_layer'].includes(action)) {
        const index = find(input.layerId), layer = layers[index];
        touched.add(layer.id);
        if (action === 'style_layer') {
          record(input.style, 'style', Object.keys(DEFAULT_OVERLAY_STYLE));
          if (!Object.keys(input.style).length) throw new Error('style_layer requires at least one style setting.');
          layers[index] = Object.freeze({ ...layer, style: validateOverlayStyle(input.style, layer.style) });
        }
        else if (action === 'set_visibility') layers[index] = Object.freeze({ ...layer, visible: boolean(input.visible, 'visible') });
        else if (action === 'remove_layer') layers.splice(index, 1);
        else if (action === 'filter_layer') layers[index] = Object.freeze({ ...layer, filter: filter(input, layer.data) });
        else if (action === 'move_layer') {
          if (!Object.hasOwn(input, 'beforeLayerId')) throw new Error('move_layer requires beforeLayerId, or null to move to the top.');
          if (input.beforeLayerId !== null) find(input.beforeLayerId);
          if (input.beforeLayerId !== layer.id) {
            layers.splice(index, 1);
            layers.splice(input.beforeLayerId === null ? layers.length : layers.findIndex((item) => item.id === input.beforeLayerId), 0, layer);
          }
        } else {
          const extent = boundsFor({ type: 'FeatureCollection', features: layer.data.features.filter((feature) => matches(feature, layer.filter)) });
          if (!extent) throw new Error(`Layer "${layer.name}" has no matching features to fit.`);
          effects.push({ action: 'set_view', bounds: extent, fit: true });
        }
      } else if (action === 'set_view') effects.push({ action, ...view(input) });
      else if (action === 'set_basemap') {
        if (!['streets', 'satellite', 'terrain'].includes(input.mode)) throw new Error('Basemap mode must be streets, satellite or terrain.');
        if (typeof this.app.setMapMode !== 'function') throw new Error('Basemap control is unavailable.');
        effects.push({ action, mode: input.mode });
      } else if (action === 'set_terrain') {
        if (typeof this.app.setTerrainView !== 'function') throw new Error('Terrain control is unavailable.');
        effects.push({ action, enabled: boolean(input.enabled, 'enabled'), ...(Object.hasOwn(input, 'exaggeration') ? { exaggeration: finite(input.exaggeration, 'exaggeration', 0, 5) } : {}) });
      } else if (action === 'set_display') {
        if (!DISPLAY.includes(input.preference)) throw new Error(`Display preference must be one of: ${DISPLAY.join(', ')}.`);
        if (typeof this.app.toggleMapLayer !== 'function') throw new Error('Display controls are unavailable.');
        effects.push({ action, preference: input.preference, enabled: boolean(input.enabled, 'enabled') });
      }
    }
    return { layers: Object.freeze(layers), effects, touched: [...touched], actionCount: actions.length };
  }

  execute(input, { fromAgent = false, recordHistory = true } = {}) {
    if (fromAgent && this.app.agentLocalConflict) return { applied: false, reason: 'Manual map changes occurred during this request. Further agent actions were not applied.' };
    let plan;
    try { plan = this.prepare(input); } catch (error) { return { applied: false, reason: error.message }; }
    const map = this.app.map;
    if (!map || map.isStyleLoaded?.() === false && !map.getLayer('geo-route')) return { applied: false, reason: 'The map style is still loading. No actions were applied.' };
    const localConflict = this.app.agentLocalConflict;
    if (!fromAgent && this.app.markManualChange?.()) return { applied: false, reason: 'Wait for the pending map undo before changing layers.' };
    const before = this.layers, renderedBefore = new Map(this.rendered), revision = this.revision;
    const history = !fromAgent && recordHistory ? this.app.captureMapAction?.() : null;
    const camera = map.getCenter?.();
    const controls = { mapMode: this.app.mapMode, terrainEnabled: this.app.terrainEnabled, terrainExaggeration: this.app.terrainExaggeration, preferences: this.app.layerPreferences ? { ...this.app.layerPreferences } : null,
      camera: camera ? { center: [camera.lng, camera.lat], zoom: map.getZoom?.(), pitch: map.getPitch?.(), bearing: map.getBearing?.() } : null };
    const applying = this.app.applyingMapActions;
    this.app.applyingMapActions = true;
    try {
      this.layers = plan.layers;
      this.render();
      for (const effect of plan.effects) {
        if (effect.action === 'set_basemap') this.app.setMapMode(effect.mode === 'streets' ? 'route' : effect.mode);
        else if (effect.action === 'set_terrain') {
          if (this.app.setTerrainView(effect.enabled, 0, effect.exaggeration, true) === false) throw new Error('The terrain source is not available.');
        } else if (effect.action === 'set_display') this.app.toggleMapLayer(effect.preference, effect.enabled);
        else if (effect.bounds) {
          const [west, south, east, north] = effect.bounds;
          if (west === east && south === north) map.jumpTo({ center: [west, Math.max(-85.05113, Math.min(85.05113, south))], zoom: 14 });
          else map.fitBounds([[west, Math.max(-85.05113, south)], [east < west ? east + 360 : east, Math.min(85.05113, north)]], { padding: this.app.mapActionPadding?.() ?? 48, maxZoom: effect.zoom ?? 16, duration: 0, ...(effect.pitch === undefined ? {} : { pitch: effect.pitch }), ...(effect.bearing === undefined ? {} : { bearing: effect.bearing }) });
        } else {
          const { action, ...options } = effect;
          map.jumpTo(options);
        }
      }
      this.revision++;
    } catch (error) {
      this.layers = before; this.revision = revision;
      this.app.agentLocalConflict = localConflict;
      // Include partially created families in reconciliation before restoring the old state.
      for (const layer of plan.layers) if (!this.rendered.has(layer.id)) this.rendered.set(layer.id, { data: EMPTY, filter: null });
      try { this.render({ force: true }); this.rendered = renderedBefore; } catch { /* The retained state also rehydrates on the next style.load. */ }
      this.app.mapMode = controls.mapMode; this.app.terrainEnabled = controls.terrainEnabled; this.app.terrainExaggeration = controls.terrainExaggeration;
      if (controls.preferences) this.app.layerPreferences = controls.preferences;
      try { this.app.applyTerrain?.(); this.app.applyMapMode?.(); if (controls.camera) map.jumpTo(controls.camera); } catch { /* Keep the validated state even if a renderer is being destroyed. */ }
      return { applied: false, reason: `Map actions were rolled back: ${error.message}` };
    } finally { this.app.applyingMapActions = applying; }
    this.save();
    this.app.renderMapActionLegend?.();
    this.app.saveExploreState?.();
    if (history) this.app.recordMapAction?.(plan.touched.length ? `Update map overlays / ${plan.touched.length} layer${plan.touched.length === 1 ? '' : 's'}` : 'Update map view', history);
    return { applied: true, layerIds: plan.touched, actionCount: plan.actionCount, ...(this.persistenceMessage ? { warning: this.persistenceMessage } : {}) };
  }

  render({ force = false } = {}) {
    const map = this.app.map;
    if (!map || !force && map.isStyleLoaded?.() === false && !map.getLayer('geo-route')) return;
    const desired = new Set(this.layers.map((layer) => layer.id));
    for (const id of this.rendered.keys()) if (!desired.has(id)) {
      const ids = overlayIds(id);
      for (const layerId of Object.values(ids).slice(1).reverse()) if (map.getLayer(layerId)) map.removeLayer(layerId);
      if (map.getSource(ids.source)) map.removeSource(ids.source);
      this.rendered.delete(id);
    }
    for (const layer of this.layers) {
      const ids = overlayIds(layer.id), cached = this.rendered.get(layer.id);
      let rendered = cached?.result;
      if (!rendered || cached.data !== layer.data || cached.filter !== layer.filter) {
        const roadLabels = new Set();
        rendered = {
          type: 'FeatureCollection', features: layer.data.features.filter((feature) => matches(feature, layer.filter)).map((feature) => {
            const value = feature.properties.label ?? feature.properties.name ?? '';
            let label = typeof value === 'string' || typeof value === 'number' ? String(value).slice(0, 160) : '';
            if (label && ['LineString', 'MultiLineString'].includes(feature.geometry.type)) {
              // A source can split one named road into many ways; retain one literal road label.
              if (roadLabels.has(label)) label = ''; else roadLabels.add(label);
            }
            return { ...feature, properties: { ...feature.properties, __meridianLabel: label } };
          }),
        };
      }
      // Register before MapLibre calls, so even a partially failed family can be removed atomically.
      this.rendered.set(layer.id, { data: layer.data, filter: layer.filter, result: rendered, style: layer.style, visible: layer.visible });
      if (!map.getSource(ids.source)) map.addSource(ids.source, { type: 'geojson', data: rendered, tolerance: 0 });
      else if (rendered !== cached?.result) map.getSource(ids.source).setData(rendered);
      if (!map.getSource(ids.source)) throw new Error(`The renderer rejected source "${layer.name}".`);
      for (const spec of overlayStyleLayers(layer)) {
        const existing = map.getLayer(spec.id);
        if (!existing) map.addLayer(spec);
        else if (cached?.style !== layer.style || cached?.visible !== layer.visible || cached?.data !== layer.data || force) {
          for (const [key, value] of Object.entries(spec.paint)) map.setPaintProperty(spec.id, key, value);
          if (spec.type === 'line' && !layer.style.dashArray.length) map.setPaintProperty(spec.id, 'line-dasharray', null);
          for (const [key, value] of Object.entries(spec.layout)) map.setLayoutProperty(spec.id, key, value);
        }
        if (!map.getLayer(spec.id)) throw new Error(`The renderer rejected layer "${layer.name}".`);
        map.moveLayer(spec.id);
      }
    }
  }

  restoreSnapshot(snapshot, { persist = true, render = true, recordHistory = false } = {}) {
    let next;
    try {
      if (this.snapshots.has(snapshot)) next = snapshot.layers;
      else {
        record(snapshot, 'snapshot', ['version', 'layers']);
        if (snapshot.version !== MAP_ACTIONS_VERSION) throw new Error('Unsupported map-action snapshot version.');
        dense(snapshot.layers, 'snapshot.layers', 0, MAP_ACTION_LIMITS.layers);
        const seen = new Set(), actions = [{ action: 'clear_overlays' }];
        for (const saved of snapshot.layers) {
          record(saved, 'snapshot layer', ['id', 'name', 'data', 'style', 'source', 'visible', 'filter']);
          if (seen.has(saved.id)) throw new Error('Snapshot layer IDs must be unique.');
          seen.add(saved.id);
          const { filter: rule, ...layer } = saved;
          actions.push({ action: 'add_layer', layer });
          if (rule) { record(rule, 'filter', ['field', 'operator', 'value']); actions.push({ action: 'filter_layer', layerId: layer.id, ...rule }); }
        }
        // Snapshots can contain 32 filters in addition to the 32 adds and one clear.
        const cleared = this.layers;
        this.layers = Object.freeze([]);
        try { next = actions.length === 1 ? this.layers : this.prepare(actions.slice(1, 33)).layers; this.layers = next; next = actions.length > 33 ? this.prepare(actions.slice(33)).layers : next; }
        finally { this.layers = cleared; }
      }
    } catch (error) { return { applied: false, reason: error.message }; }
    const before = this.layers, history = recordHistory ? this.app.captureMapAction?.() : null;
    this.layers = next;
    try { if (render) this.render(); } catch (error) { this.layers = before; try { this.render({ force: true }); } catch { /* A style reload retries restoration. */ } return { applied: false, reason: `Snapshot was not restored: ${error.message}` }; }
    this.revision++;
    if (persist) this.save();
    this.app.renderMapActionLegend?.();
    if (history) this.app.recordMapAction?.('Restore map overlays', history);
    return { applied: true };
  }

  save() {
    if (this.app.agentSubmitting || this.app.agentRunId || this.app.applyingMapActions) return false;
    if (!this.storage) { this.persistenceMessage = 'Browser storage is unavailable. Export overlay GeoJSON to keep these layers after reload.'; return false; }
    try {
      if (this.layers.reduce((sum, layer) => sum + this.dataSizes.get(layer.data) * 2, 0) > MAP_ACTION_LIMITS.storageBytes) throw new Error('Overlay data exceeds the safe 4 MiB local-storage budget. Export GeoJSON to retain it.');
      const serialized = JSON.stringify({ version: MAP_ACTIONS_VERSION, layers: this.layers });
      const combined = serialized.length * 2 + ['meridian.studio.v1', 'meridian.explore.v1'].reduce((sum, key) => sum + (this.storage.getItem(key)?.length || 0) * 2, 0);
      if (serialized.length * 2 > MAP_ACTION_LIMITS.storageBytes || combined > MAP_ACTION_LIMITS.combinedStorageBytes) throw new Error('Overlays exceed the safe local-storage budget (4 MiB overlays / 8 MiB combined). Export GeoJSON to retain them.');
      this.storage.setItem(STORAGE_KEY, serialized);
      this.persistenceMessage = '';
      return true;
    } catch (error) {
      this.persistenceMessage = `Map layers remain visible but will not be restored after reload: ${error.message}`;
      try { this.storage.removeItem(STORAGE_KEY); } catch { /* Storage can be blocked entirely. */ }
      return false;
    }
  }

  load() {
    if (!this.storage) return;
    try {
      const saved = this.storage.getItem(STORAGE_KEY);
      if (!saved) return;
      if (saved.length * 2 > MAP_ACTION_LIMITS.storageBytes) throw new Error('Saved overlays exceed the safe storage limit.');
      if (saved.length * 2 + ['meridian.studio.v1', 'meridian.explore.v1'].reduce((sum, key) => sum + (this.storage.getItem(key)?.length || 0) * 2, 0) > MAP_ACTION_LIMITS.combinedStorageBytes) throw new Error('Saved overlays and workspace exceed the safe 8 MiB combined storage limit.');
      const result = this.restoreSnapshot(JSON.parse(saved), { persist: false, render: false });
      if (!result.applied) throw new Error(result.reason);
    } catch (error) { this.persistenceMessage = `Saved map layers were not loaded: ${error.message}`; }
  }

  exportGeoJSON(layerId) {
    const selected = layerId === undefined ? this.layers : this.layers.filter((layer) => layer.id === identifier(layerId));
    if (layerId !== undefined && !selected.length) throw new Error(`Overlay layer "${layerId}" does not exist.`);
    return JSON.parse(JSON.stringify(selected.length === 1 ? { ...selected[0].data, name: selected[0].name, source: selected[0].source }
      : { type: 'FeatureCollection', features: selected.flatMap((layer) => layer.data.features.map((feature) => ({ ...feature, properties: { ...feature.properties, meridianLayerId: layer.id } }))), mapLayers: selected.map(({ data, ...layer }) => layer) }));
  }

  publicAPI() {
    const execute = (actions) => this.execute(actions);
    const drawingId = () => {
      let id;
      do { id = `drawing-${++nextDrawing}`; } while (this.layers.some((layer) => layer.id === id));
      return id;
    };
    const drawing = (geometry, options = {}, name = 'Drawing') => {
      try {
        record(options, 'drawing options', ['id', 'name', 'style', 'source', 'visible', 'properties']);
        const { properties = {}, ...layer } = options;
        return execute({ action: 'add_layer', layer: { id: drawingId(), name, source: { name: 'Client drawing', caveat: 'User-supplied geometry, not an independently verified geographic boundary.' }, ...layer, data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties }] } } });
      } catch (error) { return { applied: false, reason: error.message }; }
    };
    return Object.freeze({
      version: MAP_ACTIONS_VERSION, execute,
      addLayer: (layer) => execute({ action: 'add_layer', layer }),
      updateLayer: (layerId, patch) => {
        try {
          identifier(layerId); record(patch, 'layer update', ['name', 'data', 'style', 'source', 'visible']);
          const layer = this.layers.find((layer) => layer.id === layerId);
          if (!layer) throw new Error(`Overlay layer "${layerId}" does not exist.`);
          const { filter, ...existing } = layer;
          return execute({ action: 'add_layer', layer: { ...existing, ...patch } });
        } catch (error) { return { applied: false, reason: error.message }; }
      },
      styleLayer: (layerId, style) => execute({ action: 'style_layer', layerId, style }),
      setLayerVisibility: (layerId, visible) => execute({ action: 'set_visibility', layerId, visible }),
      removeLayer: (layerId) => execute({ action: 'remove_layer', layerId }), clearLayers: () => execute({ action: 'clear_overlays' }),
      moveLayer: (layerId, beforeLayerId = null) => execute({ action: 'move_layer', layerId, beforeLayerId }),
      filterLayer: (layerId, field, operator, value) => execute(field === null ? { action: 'filter_layer', layerId, field } : { action: 'filter_layer', layerId, field, operator, value }),
      fitLayer: (layerId) => execute({ action: 'fit_layer', layerId }), setView: (options) => {
        try { record(options, 'view', SCHEMAS.set_view); return execute({ action: 'set_view', ...options }); } catch (error) { return { applied: false, reason: error.message }; }
      },
      setBasemap: (mode) => execute({ action: 'set_basemap', mode }), setTerrain: (enabled, exaggeration) => execute({ action: 'set_terrain', enabled, ...(exaggeration === undefined ? {} : { exaggeration }) }),
      setDisplay: (preference, enabled) => execute({ action: 'set_display', preference, enabled }),
      plotPoints: (positions, options = {}) => {
        try {
          dense(positions, 'points', 1, MAP_ACTION_LIMITS.features); record(options, 'point options', ['id', 'name', 'style', 'source', 'visible']);
          return execute({ action: 'add_layer', layer: { id: drawingId(), name: 'Points', ...options, data: { type: 'FeatureCollection', features: positions.map((point) => {
            if (Array.isArray(point)) return { type: 'Feature', geometry: { type: 'Point', coordinates: point }, properties: {} };
            record(point, 'point', ['coordinates', 'properties']);
            return { type: 'Feature', geometry: { type: 'Point', coordinates: point.coordinates }, properties: point.properties ?? {} };
          }) } } });
        } catch (error) { return { applied: false, reason: error.message }; }
      },
      drawLine: (coordinates, options) => drawing({ type: 'LineString', coordinates }, options, 'Line'),
      drawPolygon: (coordinates, options) => drawing({ type: 'Polygon', coordinates }, options, 'Polygon'),
      drawCircle: (point, radiusMeters, options) => {
        try {
          const location = center(point), radius = finite(radiusMeters, 'radiusMeters', 1, 1000000) / 6371008.8;
          if (Math.abs(location[1]) + radius * 180 / Math.PI >= 90) throw new Error('Circles enclosing a pole are not supported.');
          const latitude = location[1] * Math.PI / 180, longitude = location[0] * Math.PI / 180;
          const ring = Array.from({ length: 64 }, (_, index) => {
            const bearing = index / 64 * Math.PI * 2;
            const lat = Math.asin(Math.sin(latitude) * Math.cos(radius) + Math.cos(latitude) * Math.sin(radius) * Math.cos(bearing));
            const lon = longitude + Math.atan2(Math.sin(bearing) * Math.sin(radius) * Math.cos(latitude), Math.cos(radius) - Math.sin(latitude) * Math.sin(lat));
            return [lon * 180 / Math.PI, lat * 180 / Math.PI];
          });
          return drawing(splitCircle(ring), options, 'Geodesic circle');
        } catch (error) { return { applied: false, reason: error.message }; }
      },
      drawRectangle: (extent, options) => {
        try {
          const [west, south, east, north] = bounds(extent);
          const ring = (w, e) => [[w, south], [e, south], [e, north], [w, north], [w, south]];
          return drawing(east > west ? { type: 'Polygon', coordinates: [ring(west, east)] } : { type: 'MultiPolygon', coordinates: [[ring(west, 180)], [ring(-180, east)]] }, options, 'Rectangle');
        } catch (error) { return { applied: false, reason: error.message }; }
      },
      addLabel: (label, point, options = {}) => {
        try { text(label, 'label', 160); record(options, 'label options', ['id', 'name', 'style', 'source', 'visible', 'properties']); if (options.properties !== undefined) record(options.properties, 'label properties'); if (options.style !== undefined) record(options.style, 'label style'); return drawing({ type: 'Point', coordinates: point }, { ...options, properties: { ...options.properties, label }, style: { pointRadius: 2, ...options.style, labels: true } }, label); }
        catch (error) { return { applied: false, reason: error.message }; }
      },
      getLayers: () => this.getLayers(), getCapabilities: () => this.getCapabilities(), getLimits: () => ({ ...MAP_ACTION_LIMITS }),
      exportGeoJSON: (layerId) => this.exportGeoJSON(layerId), captureSnapshot: () => this.captureSnapshot(),
      restoreSnapshot: (snapshot) => this.app.markManualChange?.() ? { applied: false, reason: 'Wait for the pending undo.' } : this.restoreSnapshot(snapshot, { recordHistory: true }),
    });
  }
}

function splitCircle(ring) {
  const minimum = Math.min(...ring.map((point) => point[0])), maximum = Math.max(...ring.map((point) => point[0])), polygons = [];
  for (let band = Math.floor((minimum + 180) / 360); band <= Math.floor((maximum + 180) / 360); band++) {
    let clipped = ring;
    // Split explicit geodesic samples at the antimeridian; do not draw a world-spanning connector.
    for (const [edge, inside] of [[band * 360 - 180, (x, edge) => x >= edge], [band * 360 + 180, (x, edge) => x <= edge]]) {
      const result = [];
      for (let i = 0; i < clipped.length; i++) {
        const a = clipped[(i + clipped.length - 1) % clipped.length], b = clipped[i];
        if (inside(a[0], edge) !== inside(b[0], edge)) result.push([edge, a[1] + (b[1] - a[1]) * (edge - a[0]) / (b[0] - a[0])]);
        if (inside(b[0], edge)) result.push(b);
      }
      clipped = result;
    }
    if (clipped.length >= 3) {
      const points = clipped.map(([lon, lat]) => [Math.max(-180, Math.min(180, lon - band * 360)), lat]);
      polygons.push([[...points, [...points[0]]]]);
    }
  }
  return polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons };
}
