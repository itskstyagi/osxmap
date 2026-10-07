const assert = require('node:assert/strict');
const test = require('node:test');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

let actions;
test.before(async () => { actions = await import(pathToFileURL(join(__dirname, 'map-actions.js')).href); });
const clone = (value) => JSON.parse(JSON.stringify(value));
const feature = (geometry, properties = {}) => ({ type: 'Feature', geometry, properties });
const point = (lon, lat, properties) => feature({ type: 'Point', coordinates: [lon, lat] }, properties);
const collection = (...features) => ({ type: 'FeatureCollection', features });
const polygon = () => feature({ type: 'Polygon', coordinates: [[[77.31, 28.51], [77.35, 28.50], [77.43, 28.55], [77.39, 28.61], [77.33, 28.58], [77.31, 28.51]]] }, { name: 'Test city boundary', category: 'city' });
const layer = (id = 'city', data = collection(polygon())) => ({ id, name: id, data, style: { color: 'red' }, source: { name: 'Offline geometry fixture', url: 'https://example.org/geometry', attribution: 'Fixture contributors', license: 'Test only', caveat: 'Test geometry, not the actual Noida boundary.' } });
const add = (id, data) => ({ action: 'add_layer', layer: layer(id, data) });

function storage() {
  const values = new Map();
  return { values, getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: (key) => values.delete(key) };
}

function fixture({ saved = storage() } = {}) {
  const sources = new Map(), layers = new Map([['background', { id: 'background', type: 'background' }], ['geo-route', { id: 'geo-route', type: 'line', paint: { 'line-color': '#ffffff' } }]]), changes = [];
  let camera = { center: [0, 0], zoom: 8, pitch: 0, bearing: 0 };
  const map = {
    loaded: true, fail: null,
    isStyleLoaded: () => map.loaded,
    getLayer: (id) => layers.get(id), getSource: (id) => sources.get(id), getStyle: () => ({ layers: [...layers.values()], sources: Object.fromEntries([...sources].map(([id, source]) => [id, { type: source.type, data: source.data }])) }),
    addSource(id, source) {
      map.check('addSource'); assert(!sources.has(id), id);
      sources.set(id, { ...source, setData(data) { map.check('setData'); changes.push(['setData', id]); this.data = data; } });
    },
    removeSource(id) { map.check('removeSource'); assert(![...layers.values()].some((layer) => layer.source === id)); sources.delete(id); },
    addLayer(spec) { map.check('addLayer'); assert(!layers.has(spec.id), spec.id); assert(sources.has(spec.source)); layers.set(spec.id, clone(spec)); },
    removeLayer(id) { map.check('removeLayer'); layers.delete(id); },
    moveLayer(id, before) { map.check('moveLayer'); const item = layers.get(id); layers.delete(id); if (!before) layers.set(id, item); else { const entries = [...layers]; layers.clear(); for (const [key, value] of entries) { if (key === before) layers.set(id, item); layers.set(key, value); } } },
    setPaintProperty(id, key, value) { map.check('setPaintProperty'); const paint = layers.get(id).paint; if (value === null) delete paint[key]; else paint[key] = clone(value); },
    setLayoutProperty(id, key, value) { map.check('setLayoutProperty'); (layers.get(id).layout ||= {})[key] = clone(value); },
    getCenter: () => ({ lng: camera.center[0], lat: camera.center[1] }), getZoom: () => camera.zoom, getPitch: () => camera.pitch, getBearing: () => camera.bearing,
    jumpTo(options) { map.check('jumpTo'); camera = { ...camera, ...options }; },
    fitBounds(bounds, options) { map.check('fitBounds'); changes.push(['fitBounds', bounds, options]); camera.center = [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2]; },
    check(operation) { if (map.fail === operation) { map.fail = null; throw new Error(`Injected ${operation} failure`); } },
  };
  let registry;
  const app = {
    map, mapMode: 'satellite', terrainEnabled: false, terrainExaggeration: 1.25, layerPreferences: { roads: true, labels: true }, history: [],
    markManualChange() { if (this.undoing) return true; if (this.agentRunId && !this.applyingMapActions) this.agentLocalConflict = true; return false; },
    captureMapAction() { return { overlays: registry.captureSnapshot(), camera: clone(camera) }; },
    recordMapAction(label, before) { this.history.push({ label, before }); },
    setMapMode(mode) { this.mapMode = mode; map.check('setMapMode'); },
    setTerrainView(enabled, duration, exaggeration) { this.terrainEnabled = enabled; this.terrainExaggeration = exaggeration ?? this.terrainExaggeration; map.check('setTerrainView'); },
    toggleMapLayer(preference, enabled) { this.layerPreferences[preference] = enabled; map.check('toggleMapLayer'); },
  };
  registry = new actions.MeridianMapActions(app, { storage: saved });
  return { registry, api: registry.publicAPI(), app, map, sources, layers, changes, saved };
}

test('a real polygon receives red fill and a red outline with one source and consistent geometry families', () => {
  const { registry, layers, sources } = fixture();
  const spec = layer();
  assert.equal(registry.execute({ action: 'add_layer', layer: spec }).applied, true);
  const ids = actions.overlayIds('city');
  assert.equal(sources.size, 1);
  assert.equal(layers.get(ids.fill).paint['fill-color'], '#ff0000');
  assert.equal(layers.get(ids.outline).paint['line-color'], '#ff0000');
  assert.equal(layers.get(ids.fill).paint['fill-opacity'], .18);
  assert.equal(layers.get(ids.outline).paint['line-width'], 3);
  assert.deepEqual(sources.get(ids.source).data.features[0].geometry, spec.data.features[0].geometry);
  assert.equal(spec.data.features[0].geometry.coordinates[0].length, 6, 'The source is not a fabricated bbox rectangle');
  assert.equal(Object.values(ids).slice(1).every((id) => layers.get(id).source === ids.source), true);
  spec.data.features[0].geometry.coordinates[0][0][0] = 0;
  assert.equal(registry.exportGeoJSON('city').features[0].geometry.coordinates[0][0][0], 77.31);
  assert.equal(registry.getLayers()[0].source.license, 'Test only');
});

test('mixed polygons, roads and points use separate geometry filters and literal safe labels', () => {
  const { registry, sources, layers } = fixture();
  const raw = '<img src=x onerror=alert(1)> {name}';
  const data = collection(polygon(), feature({ type: 'MultiLineString', coordinates: [[[77.33, 28.55], [77.39, 28.56]], [[77.34, 28.60], [77.36, 28.62]]] }, { name: raw }), feature({ type: 'MultiPoint', coordinates: [[77.35, 28.56], [77.36, 28.57]] }, { label: raw }));
  assert.equal(registry.execute(add('mixed', data)).applied, true);
  const ids = actions.overlayIds('mixed');
  assert.equal(layers.get(ids.line).paint['line-color'], '#ff0000');
  assert.equal(layers.get(ids.point).paint['circle-color'], '#ff0000');
  assert.deepEqual(layers.get(ids.line).filter, ['==', ['geometry-type'], 'LineString']);
  assert.deepEqual(layers.get(ids.point).filter, ['==', ['geometry-type'], 'Point']);
  assert.equal(sources.get(ids.source).data.features[1].properties.__meridianLabel, raw);
  assert.deepEqual(layers.get(ids.label).layout['text-field'], ['get', '__meridianLabel']);
  assert.deepEqual(registry.getLayers()[0].geometryTypes, ['MultiLineString', 'MultiPoint', 'Polygon']);
});

test('source-split named roads keep original geometry and properties but avoid repeated literal labels', () => {
  const { registry, api, sources, layers } = fixture();
  const data = collection(...Array.from({ length: 3 }, (_, i) => feature({ type: 'LineString', coordinates: [[77.3 + i * .01, 28.5], [77.4 + i * .01, 28.6]] }, { name: 'Noida-Greater Noida Expressway' })));
  registry.execute(add('roads', data));
  const ids = actions.overlayIds('roads'), rendered = sources.get(ids.source).data;
  assert.equal(rendered.features.filter((feature) => feature.properties.__meridianLabel).length, 1);
  assert.equal(layers.get(ids.label).layout['symbol-placement'], 'line');
  assert.deepEqual(api.exportGeoJSON('roads').features, data.features);
  assert.equal(api.updateLayer('roads', { data: collection(point(77.35, 28.55, { name: 'Station' })) }).applied, true);
  assert.equal(layers.get(ids.label).layout['symbol-placement'], 'point');
});

test('all style fields are bounded scalars, restyle is retained, dash reset works and no source is recreated', () => {
  const { registry, api, sources, layers, changes } = fixture();
  registry.execute(add('roads', collection(feature({ type: 'LineString', coordinates: [[77, 28], [77.1, 28.1]] }))));
  const ids = actions.overlayIds('roads'), source = sources.get(ids.source);
  const style = { color: '#00F', fillColor: 'cyan', opacity: 0, fillOpacity: 1, lineWidth: 24, pointRadius: 40, strokeColor: 'white', strokeWidth: 10, dashArray: [2, 2], labels: false, labelColor: 'yellow', labelSize: 32 };
  assert.equal(api.styleLayer('roads', style).applied, true);
  assert.equal(sources.get(ids.source), source);
  assert.equal(changes.filter(([kind]) => kind === 'setData').length, 0);
  assert.equal(layers.get(ids.line).paint['line-color'], '#0000ff');
  assert.equal(layers.get(ids.fill).paint['fill-color'], '#00ffff');
  assert.equal(layers.get(ids.label).layout.visibility, 'none');
  assert.equal(api.styleLayer('roads', { color: 'blue', dashArray: [] }).applied, true);
  assert.equal(layers.get(ids.line).paint['line-dasharray'], undefined);
  assert.equal(layers.get(ids.fill).paint['fill-color'], '#0000ff');
  assert.deepEqual(api.getLayers()[0].style.dashArray, []);
});

test('unknown actions, keys, expressions, unsafe records, URLs and invalid style values reject without success', () => {
  const { registry, layers, sources } = fixture();
  registry.execute(add('city'));
  const before = clone(registry.captureSnapshot()), rendered = clone([...layers]), source = sources.get(actions.overlayIds('city').source);
  const invalid = [
    { action: 'eval', code: 'alert(1)' }, { action: 'style_layer', layerId: 'city', style: { color: 'rgba(255,0,0,1)' } },
    { action: 'style_layer', layerId: 'city', style: { color: ['case', true, 'red', 'blue'] } }, { action: 'style_layer', layerId: 'city', style: { color: '' } },
    { action: 'style_layer', layerId: 'city', style: { color: '#ff0000ff' } }, { action: 'style_layer', layerId: 'city', style: { fillOpacity: NaN } },
    { action: 'style_layer', layerId: 'city', style: { lineWidth: 25 } }, { action: 'style_layer', layerId: 'city', style: { pointRadius: 0 } },
    { action: 'style_layer', layerId: 'city', style: { opacity: '1' } }, { action: 'style_layer', layerId: 'city', style: { labels: 'true' } },
    { action: 'style_layer', layerId: 'city', style: { dashArray: [0, 0] } }, { action: 'style_layer', layerId: 'city', style: { lineColor: 'red' } },
    { action: 'style_layer', layerId: 'city', style: {} }, { action: 'add_layer', layer: { ...layer('null-style'), style: null } },
    { action: 'remove_layer', layerId: 'geo-route' }, { action: 'set_visibility', layerId: 'city', visible: 1 },
    { action: 'remove_layer', layerId: 'city', force: true }, { action: 'filter_layer', layerId: 'city', field: 'name', operator: 'expression', value: 'anything' },
    { action: 'add_layer', layer: { ...layer('remote'), data: 'https://example.org/data.geojson' } },
    { action: 'add_layer', layer: { ...layer('remote'), source: { url: 'javascript:alert(1)' } } },
    { action: 'add_layer', layer: { ...layer('remote'), source: { url: 'https://user:secret@example.org/data' } } },
    { action: 'add_layer', layer: { ...layer('remote'), source: { url: 'http://127.0.0.1/secret' } } },
    JSON.parse('{"action":"clear_overlays","__proto__":{}}'), { action: { toString() { throw new Error('must not execute'); } } },
  ];
  let calls = 0;
  const getter = { action: 'clear_overlays' };
  Object.defineProperty(getter, 'secret', { enumerable: true, get() { calls++; return true; } });
  invalid.push(getter);
  for (const action of invalid) assert.equal(registry.execute(action).applied, false);
  assert.equal(calls, 0);
  assert.deepEqual(clone(registry.captureSnapshot()), before);
  assert.deepEqual(clone([...layers]), rendered);
  assert.equal(sources.get(actions.overlayIds('city').source), source);
});

test('entire batches validate before any upsert, style, visibility, order, filter or remove is applied', () => {
  const { registry, layers, sources } = fixture();
  registry.execute([add('a'), add('b')]);
  const before = clone(registry.captureSnapshot()), render = clone([...layers]);
  const mutations = [
    add('c'), { action: 'style_layer', layerId: 'a', style: { color: 'blue' } }, { action: 'set_visibility', layerId: 'b', visible: false },
    { action: 'move_layer', layerId: 'b', beforeLayerId: 'a' }, { action: 'filter_layer', layerId: 'a', field: 'category', operator: 'eq', value: 'missing' },
    { action: 'remove_layer', layerId: 'a' }, { action: 'clear_overlays' },
  ];
  for (const mutation of mutations) {
    assert.equal(registry.execute([mutation, { action: 'unsupported' }]).applied, false);
    assert.deepEqual(clone(registry.captureSnapshot()), before);
    assert.deepEqual(clone([...layers]), render);
    assert.equal(sources.size, 2);
  }
  assert.equal(registry.execute([]).applied, false);
  assert.equal(registry.execute(new Array(2)).applied, false);
});

test('renderer failures roll back partially added families and restore original data, style, order and view', () => {
  for (const failure of ['addSource', 'addLayer', 'setData', 'setPaintProperty', 'setLayoutProperty', 'moveLayer', 'removeLayer', 'removeSource', 'jumpTo']) {
    const { registry, map, sources, layers } = fixture();
    registry.execute([add('a'), add('b')]);
    const before = clone(registry.captureSnapshot()), render = clone([...layers]), camera = [map.getCenter().lng, map.getCenter().lat];
    map.fail = failure;
    const batch = failure === 'setData' ? [add('a', collection(point(1, 1)))] : failure.startsWith('remove') ? [{ action: 'remove_layer', layerId: 'a' }] : [add('c'), { action: 'style_layer', layerId: 'a', style: { color: 'blue' } }, { action: 'set_visibility', layerId: 'b', visible: false }, { action: 'set_view', center: [10, 10] }];
    const result = registry.execute(batch);
    assert.equal(result.applied, false, failure);
    assert.match(result.reason, /rolled back/, failure);
    assert.deepEqual(clone(registry.captureSnapshot()), before, failure);
    assert.deepEqual(clone([...layers]), render, failure);
    assert.equal(sources.size, 2, failure);
    assert.deepEqual([map.getCenter().lng, map.getCenter().lat], camera, failure);
  }
});

test('visibility, filter, order, removal and clear preserve unrelated basemap sources and layers', () => {
  const { registry, api, sources, layers } = fixture();
  const data = collection(point(77.34, 28.53, { value: 1, category: 'A' }), point(77.35, 28.54, { value: 2, category: 'B' }), point(77.36, 28.55, { value: 3, category: 'A' }));
  registry.execute([add('first', data), add('second')]);
  const ids = actions.overlayIds('first'), source = sources.get(ids.source);
  assert.equal(api.setLayerVisibility('first', false).applied, true);
  Object.values(ids).slice(1).forEach((id) => assert.equal(layers.get(id).layout.visibility, 'none'));
  assert.equal(api.filterLayer('first', 'value', 'gte', 2).applied, true);
  assert.equal(source.data.features.length, 2);
  assert.equal(registry.getLayers()[0].featureCount, 3);
  assert.equal(api.filterLayer('first', 'category', 'eq', 'A').applied, true);
  assert.equal(source.data.features.length, 2, 'A new declarative filter replaces the previous rule');
  assert.equal(api.filterLayer('first', null).applied, true);
  assert.equal(source.data.features.length, 3);
  assert.equal(api.setLayerVisibility('first', true).applied, true);
  assert.equal(sources.get(ids.source), source);
  assert.equal(api.moveLayer('first').applied, true);
  assert.deepEqual(registry.getLayers().map((layer) => layer.id), ['second', 'first']);
  assert.equal([...layers.keys()].at(-1), ids.label);
  assert.equal(api.removeLayer('second').applied, true);
  assert.equal(api.clearLayers().applied, true);
  assert.equal(sources.size, 0);
  assert.deepEqual([...layers.keys()], ['background', 'geo-route']);
});

test('filters treat false, null, zero and missing values explicitly without eval, coercion or expressions', () => {
  const { registry, api, sources } = fixture();
  const data = collection(point(0, 0, { field: false }), point(1, 1, { field: null }), point(2, 2, { field: 0 }), point(3, 3, { field: '0' }), point(4, 4, {}));
  registry.execute(add('values', data));
  const source = sources.get(actions.overlayIds('values').source);
  for (const value of [false, null, 0, '0']) { assert.equal(api.filterLayer('values', 'field', 'eq', value).applied, true); assert.equal(source.data.features.length, 1); }
  assert.equal(api.filterLayer('values', 'field', 'neq', null).applied, true);
  assert.equal(source.data.features.length, 3, 'Missing properties are excluded, not treated as null');
  assert.equal(api.filterLayer('values', 'field', 'gt', 0).applied, true);
  assert.equal(source.data.features.length, 0);
  assert.equal(api.fitLayer('values').applied, false);
  assert.equal(api.filterLayer('values', 'field', 'gt', '0').applied, false);
  assert.equal(api.filterLayer('values', 'field', 'eq', { expression: true }).applied, false);
  assert.equal(api.filterLayer('values', 'absent', 'eq', 0).applied, false);
});

test('style reload rehydrates sources and color without depending on Explore or Studio being enabled', () => {
  const { registry, api, sources, layers, app } = fixture();
  registry.execute([add('city'), add('points', collection(point(77.38, 28.56)))]);
  api.styleLayer('city', { color: 'blue' }); api.setLayerVisibility('points', false);
  const old = sources.get(actions.overlayIds('city').source);
  sources.clear(); layers.clear(); layers.set('geo-route', { id: 'geo-route', type: 'line', paint: {} });
  app.productMode = 'explore'; app.studio = { enabled: false };
  registry.render();
  assert.notEqual(sources.get(actions.overlayIds('city').source), old);
  assert.equal(layers.get(actions.overlayIds('city').fill).paint['fill-color'], '#0000ff');
  assert.equal(layers.get(actions.overlayIds('points').point).layout.visibility, 'none');
  registry.render();
  assert.equal(sources.size, 2);
  assert.equal(layers.size, 11);
});

test('snapshots share frozen datasets but portable restore validates every layer and filter atomically', () => {
  const { registry, api } = fixture();
  registry.execute([add('a'), add('b', collection(point(1, 2, { field: false })))]);
  api.filterLayer('b', 'field', 'eq', false);
  const snapshot = registry.captureSnapshot();
  api.styleLayer('a', { color: 'blue' });
  const next = registry.captureSnapshot();
  assert.equal(snapshot.layers[0].data, next.layers[0].data);
  assert(Object.isFrozen(snapshot.layers[0].data.features[0].geometry.coordinates[0]));
  assert.equal(registry.restoreSnapshot(snapshot).applied, true);
  assert.equal(api.getLayers()[0].style.color, '#ff0000');
  const portable = clone(snapshot);
  api.clearLayers();
  assert.equal(registry.restoreSnapshot(portable).applied, true);
  assert.equal(api.getLayers()[1].filter.value, false);
  portable.layers[1].style.color = 'var(--red)';
  assert.equal(registry.restoreSnapshot(portable).applied, false);
  assert.equal(api.getLayers().length, 2);
  const many = fixture();
  many.registry.execute(Array.from({ length: 32 }, (_, i) => add(`p-${i}`, collection(point(i, 0, { value: i })))));
  many.registry.execute(Array.from({ length: 32 }, (_, i) => ({ action: 'filter_layer', layerId: `p-${i}`, field: 'value', operator: 'eq', value: i })));
  const roundtrip = clone(many.registry.captureSnapshot());
  many.api.clearLayers();
  assert.equal(many.registry.restoreSnapshot(roundtrip).applied, true);
  assert.equal(many.api.getLayers().length, 32);
});

test('safe local persistence survives reload, excludes provisional agent edits and reports storage failures', () => {
  const first = fixture();
  first.registry.execute(add('saved'));
  first.api.styleLayer('saved', { color: 'blue' });
  const second = fixture({ saved: first.saved });
  second.registry.render();
  assert.equal(second.api.getLayers()[0].style.color, '#0000ff');
  first.app.agentRunId = 'active';
  first.registry.execute(add('provisional'), { fromAgent: true });
  assert.equal(fixture({ saved: first.saved }).api.getLayers().length, 1);
  first.app.agentRunId = ''; first.registry.save();
  assert.equal(fixture({ saved: first.saved }).api.getLayers().length, 2);
  const broken = fixture({ saved: { getItem: () => null, setItem() { throw new Error('Blocked quota'); }, removeItem() {} } });
  assert.equal(broken.registry.execute(add('visible')).applied, true);
  assert.match(broken.registry.persistenceMessage, /visible.*not be restored.*Blocked quota/);
  assert.equal(broken.api.getLayers().length, 1);
  const malformed = storage(); malformed.setItem('meridian.map-actions.v1', '{"version":1,"layers":[{}]}');
  const restored = fixture({ saved: malformed });
  assert.equal(restored.api.getLayers().length, 0);
  assert.match(restored.registry.persistenceMessage, /not loaded/);
});

test('default drawing IDs never overwrite restored or imported user geometry after a module reload', async () => {
  const saved = storage();
  const first = fixture({ saved });
  assert.equal(first.api.drawLine([[77.3, 28.5], [77.4, 28.6]], { id: 'drawing-1' }).applied, true);
  const reloaded = await import(`${pathToFileURL(join(__dirname, 'map-actions.js')).href}?drawing-reload=1`);
  const fresh = fixture({ saved });
  const registry = new reloaded.MeridianMapActions(fresh.app, { storage: saved });
  const api = registry.publicAPI();
  assert.equal(api.drawLine([[5, 5], [6, 6]]).applied, true);
  assert.deepEqual(api.getLayers().map((layer) => layer.id), ['drawing-1', 'drawing-2']);
  assert.deepEqual(api.exportGeoJSON('drawing-1').features[0].geometry.coordinates, [[77.3, 28.5], [77.4, 28.6]]);
  assert.equal(api.plotPoints([[7, 7]]).applied, true);
  assert.equal(api.getLayers()[2].id, 'drawing-3');
});

test('the combined workspace storage budget clears stale overlay persistence rather than saving oversized data', () => {
  const { registry, api, saved } = fixture();
  registry.execute(add('small'));
  assert(saved.getItem('meridian.map-actions.v1'));
  saved.setItem('meridian.studio.v1', 'x'.repeat(actions.MAP_ACTION_LIMITS.combinedStorageBytes / 2));
  assert.equal(api.styleLayer('small', { color: 'blue' }).applied, true);
  assert.equal(saved.getItem('meridian.map-actions.v1'), null);
  assert.match(registry.persistenceMessage, /8 MiB combined/);
  assert.equal(api.getLayers()[0].style.color, '#0000ff');
});

test('inventories are bounded metadata only and exports are independent GeoJSON with retained source metadata', () => {
  const { registry, api } = fixture();
  const data = collection(...Array.from({ length: 10000 }, (_, i) => point(77 + i / 100000, 28, { value: i, category: 'A' })));
  registry.execute(add('ten-thousand', data));
  const inventory = registry.context();
  assert.equal(inventory.version, 1);
  assert.deepEqual(inventory.capabilities, actions.MAP_ACTION_NAMES);
  assert.equal(inventory.layers[0].featureCount, 10000);
  assert.deepEqual(inventory.layers[0].numericFields, ['value']);
  assert.equal(JSON.stringify(inventory).includes('coordinates'), false);
  assert.equal(JSON.stringify(inventory).includes('"data"'), false);
  assert(JSON.stringify(inventory).length < 2000);
  const output = api.exportGeoJSON('ten-thousand');
  output.features[0].properties.value = -1;
  assert.equal(api.exportGeoJSON('ten-thousand').features[0].properties.value, 0);
  assert.equal(output.source.url, 'https://example.org/geometry');
});

test('worst-case inventories preserve every overlay ID and exact bounds inside the bounded context budget', () => {
  const { registry, api } = fixture();
  const field = 'f'.repeat(128), data = collection(point(77.12345678901234, 28.12345678901234, { [field]: 'v'.repeat(160) }));
  const style = { color: 'red', opacity: .1234567890123456, fillOpacity: .2345678901234567, lineWidth: 23.12345678901234, strokeWidth: 9.123456789012345, pointRadius: 39.12345678901234, labelSize: 31.12345678901234, dashArray: [1.123456789012345, 2.123456789012345, 3.123456789012345, 4.123456789012345] };
  const source = { name: 'n'.repeat(160), url: `https://example.org/${'x'.repeat(1800)}`, attribution: 'a'.repeat(500), license: 'l'.repeat(300), caveat: 'c'.repeat(1000) };
  const batch = Array.from({ length: 32 }, (_, i) => ({ action: 'add_layer', layer: { id: `long-${i}-${'i'.repeat(52)}`, name: 'N'.repeat(120), data, style, source } }));
  assert.equal(registry.execute(batch).applied, true);
  assert.equal(registry.execute(api.getLayers().map(({ id }) => ({ action: 'filter_layer', layerId: id, field, operator: 'eq', value: 'v'.repeat(160) }))).applied, true);
  const context = registry.context();
  assert.equal(context.layers.length, 32);
  assert.equal(context.layers[0].id, batch[0].layer.id);
  assert.deepEqual(context.layers[0].bounds, api.getLayers()[0].bounds);
  assert(Math.abs(context.layers[0].bounds[0] - 77.12345678901234) < 1e-10);
  assert(JSON.stringify(context).length <= 24000, JSON.stringify(context).length);
});

test('32-layer, feature and position limits reject oversized requests instead of sampling geometry', () => {
  const { registry, api } = fixture();
  registry.execute(Array.from({ length: 32 }, (_, i) => add(`p-${i}`, collection(point(i, 0)))));
  assert.equal(registry.execute(add('overflow')).applied, false);
  assert.equal(api.getLayers().length, 32);
  const points = collection(...Array.from({ length: 10001 }, () => point(0, 0)));
  assert.equal(registry.execute(add('p-0', points)).applied, false);
  const long = collection(feature({ type: 'LineString', coordinates: Array.from({ length: 100001 }, (_, i) => [i / 10000, 0]) }));
  assert.equal(registry.execute(add('p-0', long)).applied, false);
  const oversized = collection(point(0, 0, { huge: 'x'.repeat(4 * 1024 * 1024) }));
  assert.equal(registry.execute(add('p-0', oversized)).applied, false);
  assert.equal(api.getLayers()[0].featureCount, 1);
});

test('geometry normalization rejects broken boundaries, invalid positions and attempts to fetch data', () => {
  const { registry } = fixture();
  for (const geometry of [
    { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1]]] },
    { type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 1], [1, 0], [0, 0]]] },
    { type: 'LineString', coordinates: [[0, 0], [999, 0]] }, { type: 'Point', coordinates: [0, Infinity] },
    { type: 'GeometryCollection', geometries: [] },
  ]) assert.equal(registry.execute(add('broken', collection(feature(geometry)))).applied, false);
  assert.equal(registry.getLayers().length, 0);
});

test('the public singleton facade exposes every requested method and uses the same validated dispatcher', () => {
  const { api, app, layers, sources } = fixture();
  for (const method of ['execute', 'addLayer', 'updateLayer', 'styleLayer', 'setLayerVisibility', 'removeLayer', 'clearLayers', 'moveLayer', 'filterLayer', 'fitLayer', 'setView', 'setBasemap', 'setTerrain', 'setDisplay', 'plotPoints', 'drawLine', 'drawPolygon', 'drawCircle', 'drawRectangle', 'addLabel', 'getLayers', 'getCapabilities', 'exportGeoJSON']) assert.equal(typeof api[method], 'function', method);
  assert.equal(api.addLayer(layer('base')).applied, true);
  assert.equal(api.updateLayer('base', { name: 'Renamed', style: { color: 'blue' } }).applied, true);
  assert.equal(api.getLayers()[0].style.color, '#0000ff');
  assert.equal(api.updateLayer('base', { id: 'hijack' }).applied, false);
  assert.equal(api.plotPoints([[77.35, 28.55], { coordinates: [77.36, 28.56], properties: { name: 'Station' } }], { id: 'points', style: { color: 'red' } }).applied, true);
  assert.equal(api.drawLine([[77.35, 28.55], [77.37, 28.57]], { id: 'line' }).applied, true);
  assert.equal(api.drawPolygon(polygon().geometry.coordinates, { id: 'polygon' }).applied, true);
  assert.equal(api.drawRectangle([170, -1, -170, 1], { id: 'rectangle' }).applied, true);
  assert.equal(api.exportGeoJSON('rectangle').features[0].geometry.type, 'MultiPolygon');
  assert.equal(api.addLabel('<script>literal</script>', [77.37, 28.55], { id: 'label' }).applied, true);
  assert.equal(sources.get(actions.overlayIds('label').source).data.features[0].properties.__meridianLabel, '<script>literal</script>');
  assert.equal(api.setBasemap('streets').applied, true); assert.equal(app.mapMode, 'route');
  assert.equal(api.setTerrain(true, 2).applied, true); assert.equal(app.terrainExaggeration, 2);
  assert.equal(api.setDisplay('roads', false).applied, true); assert.equal(app.layerPreferences.roads, false);
  assert.equal(api.setBasemap('https://remote/style.json').applied, false);
  assert.equal(api.setTerrain(true, Infinity).applied, false);
  assert.equal(api.setDisplay('customLayer', true).applied, false);
  assert.equal(api.setView({ center: [77.36, 28.56], zoom: 12, pitch: 30, bearing: 50 }).applied, true);
  assert.equal(api.setView({ center: [0, 0], rawExpression: [] }).applied, false);
  assert.equal(api.setView({ center: [0, 0], bounds: [1, 1, 2, 2] }).applied, false);
  assert(layers.has('geo-route'));
  assert(app.history.length > 0);
});

test('geodesic circles use explicit radius meters and split the dateline rather than fabricating a bbox', () => {
  const { api } = fixture();
  assert.equal(api.drawCircle([77.36, 28.56], 1000, { id: 'circle' }).applied, true);
  const ring = api.exportGeoJSON('circle').features[0].geometry.coordinates[0];
  assert.equal(ring.length, 65);
  const radians = (degrees) => degrees * Math.PI / 180;
  const distance = ([lon, lat]) => 6371008.8 * 2 * Math.asin(Math.sqrt(Math.sin(radians(lat - 28.56) / 2) ** 2 + Math.cos(radians(lat)) * Math.cos(radians(28.56)) * Math.sin(radians(lon - 77.36) / 2) ** 2));
  for (const point of ring) assert(Math.abs(distance(point) - 1000) < .0001);
  assert.equal(api.drawCircle([179.999, 0], 1000, { id: 'wrapped' }).applied, true);
  const wrapped = api.exportGeoJSON('wrapped').features[0].geometry;
  assert.equal(wrapped.type, 'MultiPolygon');
  assert.equal(wrapped.coordinates.length, 2);
  assert.equal(api.drawCircle([0, 85], 1000000).applied, false);
  assert.equal(api.drawCircle([0, 0], '1000').applied, false);
});

test('manual edits block later agent actions and undo-in-flight does not allow user overwrites', () => {
  const { registry, api, app } = fixture();
  registry.execute(add('city'));
  app.agentRunId = 'active';
  api.styleLayer('city', { color: 'blue' });
  assert.equal(app.agentLocalConflict, true);
  assert.equal(registry.execute({ action: 'style_layer', layerId: 'city', style: { color: 'red' } }, { fromAgent: true }).applied, false);
  assert.equal(api.getLayers()[0].style.color, '#0000ff');
  app.agentRunId = ''; app.undoing = true;
  assert.equal(api.removeLayer('city').applied, false);
  assert.equal(api.getLayers().length, 1);
});
