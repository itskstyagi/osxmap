const assert = require('node:assert/strict');
const test = require('node:test');
const { pathToFileURL } = require('node:url');
const { join } = require('node:path');

let studio;
let data;
test.before(async () => {
  studio = await import(pathToFileURL(join(__dirname, 'studio.js')).href);
  data = await import(pathToFileURL(join(__dirname, 'studio-data.js')).href);
});

function collection() {
  return { type: 'FeatureCollection', features: [
    [-3, 50, 0, true, '2026-01-01'], [-2, 50, 20, false, '2026-01-01'],
    [-3, 51, 40, true, '2026-02-01'], [-2, 51, 80, false, '2026-02-01'],
  ].map(([lon, lat, value, category, observedAt]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { value, category, observedAt } })) };
}

function project() {
  const workspace = studio.createWorkspace('Test project');
  const layer = data.makeLayer(collection(), { id: 'observations', name: 'Observations', field: 'value', units: 'test units', source: { name: 'Test fixture', caveat: 'Synthetic test observations.' }, filters: { categoryField: 'category' }, timeField: 'observedAt' });
  workspace.datasets.observations = layer.data;
  delete layer.data;
  workspace.layers = [{ ...layer, datasetId: 'observations' }];
  workspace.selectedLayerId = layer.id;
  return workspace;
}

function controller(workspace = project()) {
  const controller = Object.create(studio.MeridianStudio.prototype);
  Object.assign(controller, {
    workspace, projects: [workspace], cache: new Map(), enabled: false,
    app: { map: { getBounds: () => ({ getWest: () => -4, getSouth: () => 49, getEast: () => -1, getNorth: () => 52 }) }, updateActionChip() {}, setTerrainView() {}, mapActions: [] },
    render() {}, save() {}, renderSettings() {}, setPane() {}, closeInspector() {},
    status(message, error) { this.statusMessage = message; this.statusError = error; },
  });
  return controller;
}

function mapRenderer(instance) {
  const layers = [], sources = {}, events = [];
  const map = instance.app.map;
  Object.assign(map, {
    getStyle: () => ({ layers, sources }), isStyleLoaded: () => true,
    getLayer: (id) => layers.find((layer) => layer.id === id), getSource: (id) => sources[id],
    addSource(id, source) { events.push(['addSource', id]); sources[id] = { ...source, setData(data) { this.data = data; events.push(['setData', id]); } }; },
    removeSource(id) { assert(!layers.some((layer) => layer.source === id)); events.push(['removeSource', id]); delete sources[id]; },
    addLayer(layer, before) { events.push(['addLayer', layer.id]); layers.splice(before ? layers.findIndex((item) => item.id === before) : layers.length, 0, { ...layer, paint: { ...layer.paint }, layout: { ...layer.layout } }); },
    removeLayer(id) { events.push(['removeLayer', id]); layers.splice(layers.findIndex((layer) => layer.id === id), 1); },
    setPaintProperty(id, key, value) { map.getLayer(id).paint[key] = value; },
    setLayoutProperty(id, key, value) { map.getLayer(id).layout[key] = value; },
    moveLayer(id, before) { const [layer] = layers.splice(layers.findIndex((item) => item.id === id), 1); layers.splice(before ? layers.findIndex((item) => item.id === before) : layers.length, 0, layer); },
  });
  instance.enabled = true;
  instance.renderRegion = () => {};
  instance.renderLegend = () => {};
  instance.render = () => instance.renderMap();
  return { map, events };
}

function legendNodes(instance, t) {
  const previous = global.document;
  const node = (tagName) => ({
    tagName, children: [], style: {}, attributes: {}, value: '',
    get textContent() { return [this.value, ...this.children.map((child) => child.textContent)].filter(Boolean).join(' '); },
    set textContent(value) { this.value = value; this.children = []; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.value = ''; this.children = children; },
    setAttribute(key, value) { this.attributes[key] = value; },
  });
  global.document = { createElement: node };
  t.after(() => { global.document = previous; });
  instance.enabled = true;
  instance.el = { 'studio-legend': node('div') };
  return { root: instance.el['studio-legend'], descendants: (root) => [root, ...root.children.flatMap(function visit(child) { return [child, ...child.children.flatMap(visit)]; })] };
}

test('workspace round trips retain data, source, ordering, opacity, filters and temporal fields', () => {
  const original = project();
  original.layers[0].visible = false;
  original.layers[0].opacity = .37;
  original.layers[0].color = 'RED';
  original.layers[0].lineWidth = 4;
  original.layers[0].pointRadius = 12;
  original.layers[0].locked = true;
  original.layers[0].filters.category = false;
  original.layers[0].filters.min = 0;
  original.region = [170, 1, -170, 5];
  original.camera = { center: [175, 3], zoom: 9, bearing: 15, pitch: 40 };
  const restored = studio.validateWorkspace(JSON.parse(JSON.stringify(original)));
  assert.equal(restored.layers[0].visible, false);
  assert.equal(restored.layers[0].opacity, .37);
  assert.equal(restored.layers[0].color, '#ff0000');
  assert.equal(restored.layers[0].lineWidth, 4);
  assert.equal(restored.layers[0].pointRadius, 12);
  assert.equal(restored.layers[0].locked, true);
  assert.equal(restored.layers[0].filters.category, false);
  assert.equal(restored.layers[0].filters.min, 0);
  assert.equal(restored.layers[0].timeField, 'observedAt');
  assert.match(restored.layers[0].source.caveat, /Synthetic/);
  assert.deepEqual(restored.region, original.region);
  assert.deepEqual(restored.camera, original.camera);
  assert.deepEqual(restored.datasets.observations, original.datasets.observations);
});

test('workspace imports reject missing data, oversized stacks and duplicate layer identities', () => {
  const missing = project();
  delete missing.datasets.observations;
  assert.throws(() => studio.validateWorkspace(missing), /missing data/);
  const duplicate = project();
  duplicate.layers.push({ ...duplicate.layers[0] });
  assert.throws(() => studio.validateWorkspace(duplicate), /invalid identifier/);
  const oversized = project();
  oversized.layers = Array.from({ length: 31 }, () => oversized.layers[0]);
  assert.throws(() => studio.validateWorkspace(oversized), /valid Meridian workspace/);
  const unsafe = project();
  unsafe.datasets = JSON.parse('{"__proto__":{"type":"FeatureCollection","features":[]}}');
  assert.throws(() => studio.validateWorkspace(unsafe), /Invalid dataset identifier/);
  for (const id of [true, 7]) {
    const invalid = project();
    invalid.layers[0].id = id;
    assert.throws(() => studio.validateWorkspace(invalid), /invalid identifier/);
  }
});

test('workspace changes retain reversible structural snapshots without duplicating datasets', () => {
  const instance = controller();
  instance.mutate('Rename layer', () => { instance.workspace.layers[0].name = 'Renamed'; });
  assert.equal(instance.workspace.history.length, 1);
  assert.equal(instance.workspace.history[0].before.datasets, undefined);
  assert.equal(instance.workspace.history[0].before.layers[0].data, undefined);
  instance.undo();
  assert.equal(instance.workspace.layers[0].name, 'Observations');
  assert.equal(instance.workspace.future.length, 1);
  instance.redo();
  assert.equal(instance.workspace.layers[0].name, 'Renamed');
  const restored = studio.validateWorkspace(JSON.parse(JSON.stringify(instance.workspace)));
  assert.equal(restored.history.length, 1);
  const reloaded = controller(restored);
  reloaded.undo();
  assert.equal(reloaded.workspace.layers[0].name, 'Observations');
});

test('failed mutations restore prior valid state and do not create history', () => {
  const instance = controller();
  const changed = instance.mutate('Invalid change', () => { instance.workspace.name = 'Broken'; throw new Error('Rejected'); });
  assert.equal(changed, false);
  assert.equal(instance.workspace.name, 'Test project');
  assert.equal(instance.workspace.history.length, 0);
  assert.equal(instance.statusMessage, 'Rejected');
});

test('running agents cannot be overwritten by manual Studio mutations', () => {
  const instance = controller();
  instance.app.agentRunId = 'active-run';
  assert.equal(instance.mutate('Edit', () => { instance.workspace.name = 'Changed'; }), false);
  assert.equal(instance.workspace.name, 'Test project');
  assert.equal(instance.mutate('Agent edit', () => { instance.workspace.name = 'Agent output'; }, { record: false }), true);
  assert.equal(instance.workspace.name, 'Agent output');
  assert.equal(instance.workspace.history.length, 0);
});

test('history stays bounded to twenty changes', () => {
  const instance = controller();
  for (let index = 0; index < 25; index++) instance.mutate(`Change ${index}`, () => { instance.workspace.name = `Project ${index}`; });
  assert.equal(instance.workspace.history.length, 20);
  assert.equal(instance.workspace.history[0].label, 'Change 5');
});

test('scenario layers reuse immutable input data but have independent settings', () => {
  const instance = controller();
  const original = instance.workspace.layers[0];
  instance.applyOperation({ action: 'duplicate', layerId: original.id });
  assert.equal(instance.workspace.layers.length, 2);
  const scenario = instance.workspace.layers[0];
  assert.notEqual(scenario.id, original.id);
  assert.equal(scenario.datasetId, original.datasetId);
  scenario.filters.min = 25;
  assert.equal(original.filters.min, null);
  assert.equal(Object.keys(instance.workspace.datasets).length, 1);
  instance.undo();
  assert.equal(instance.workspace.layers.length, 1);
});

test('high-value output uses an observed percentile and preserves provenance', () => {
  const instance = controller();
  instance.applyOperation({ action: 'hotspots', layerId: 'observations' });
  const generated = instance.workspace.layers[0];
  assert.equal(generated.filters.min, 40);
  assert.match(generated.source.caveat, /90th-percentile.*not a statistically significant/);
  assert.equal(instance.workspace.analyses.length, 1);
  assert.equal(instance.workspace.insights[0].layerId, generated.id);
  const features = data.filterCollection(instance.hydrated(generated), instance.contextFor(generated));
  assert.equal(features.features.length, 2);
});

test('agent operations reject unavailable data, fields, locked layers and mismatched workspace scope', () => {
  const instance = controller();
  assert.throws(() => instance.applyOperation({ action: 'visualize', layerId: 'missing' }), /real dataset/);
  assert.throws(() => instance.applyOperation({ action: 'visualize', layerId: 'observations', field: 'population' }), /not present/);
  assert.throws(() => instance.applyOperation({ action: 'filter', layerId: 'observations', workspaceId: 'wrong' }), /different workspace/);
  assert.throws(() => instance.applyOperation({ action: 'filter', layerId: 'observations', scope: { type: 'layer', layerId: 'another' } }), /outside/);
  instance.workspace.layers[0].locked = true;
  assert.throws(() => instance.applyOperation({ action: 'visualize', layerId: 'observations', visualization: 'heatmap' }), /locked/);
  assert.equal(instance.workspace.history.length, 0);
});

test('remote Studio operations join the outer map transaction instead of creating conflicting undo entries', () => {
  const instance = controller();
  instance.app.agentRunId = 'active';
  instance.applyOperation({ action: 'visualize', layerId: 'observations', visualization: 'heatmap' }, { fromAgent: true });
  assert.equal(instance.workspace.layers[0].visualization, 'heatmap');
  assert.equal(instance.workspace.history.length, 0);
});

test('workspace scope does not accidentally retain an unrelated selected-region filter', () => {
  const instance = controller();
  instance.workspace.region = [10, 10, 11, 11];
  instance.applyOperation({ action: 'visualize', layerId: 'observations', visualization: 'heatmap', scope: { type: 'workspace' } });
  assert.equal(instance.contextFor(instance.selectedLayer()).region, null);
  assert.equal(instance.renderedLayer(instance.selectedLayer()).inputCount, 4);
});

test('viewport-scoped generated settings retain the exact geographic extent', () => {
  const instance = controller();
  const bounds = [-3.2, 49.9, -2.8, 51.1];
  instance.applyOperation({ action: 'filter', layerId: 'observations', scope: { type: 'viewport', bounds } });
  assert.deepEqual(instance.selectedLayer().scopeBounds, bounds);
  assert.equal(instance.renderedLayer(instance.selectedLayer()).inputCount, 2);
});

test('timeline filters only its active temporal layer, not unrelated static data', () => {
  const instance = controller();
  instance.workspace.time = '2026-01-01T00:00:00.000Z';
  const other = { ...instance.selectedLayer(), id: 'static', timeField: '' };
  assert.equal(instance.contextFor(other).time, null);
  assert.equal(instance.contextFor(instance.selectedLayer()).time, instance.workspace.time);
  assert.equal(data.filterCollection(instance.hydrated(instance.selectedLayer()), instance.contextFor(instance.selectedLayer())).features.length, 2);
});

test('empty display output retains the correct MapLibre layer family', () => {
  const layer = { id: 'empty', visible: true, opacity: .5, palette: 'olive', visualization: 'contours' };
  const contour = studio.styleLayers(layer, { data: { type: 'FeatureCollection', features: [] }, geometryType: 'LineString' });
  assert.equal(contour[0].type, 'line');
  const surface = studio.styleLayers({ ...layer, visualization: 'surface' }, { data: { type: 'FeatureCollection', features: [] }, geometryType: 'Polygon' });
  assert.equal(surface[0].type, 'fill-extrusion');
});

test('heatmap MapLibre styling uses explicit intensity weights instead of generic palette weights', () => {
  const instance = controller();
  instance.selectedLayer().visualization = 'heatmap';
  const spec = studio.styleLayers(instance.selectedLayer(), instance.renderedLayer(instance.selectedLayer()))[0];
  assert.deepEqual(spec.paint['heatmap-weight'], ['coalesce', ['get', '__heatWeight'], 0]);
});

test('map color stops encode the full palette used in its legend', () => {
  const instance = controller();
  const layer = instance.selectedLayer();
  const spec = studio.styleLayers(layer, instance.renderedLayer(layer))[0];
  for (const color of data.PALETTES.olive.colors) assert(spec.paint['circle-color'].includes(color));
});

test('uniform red styling preserves polygon, line, point and heatmap families and actual data', () => {
  const polygon = { type: 'FeatureCollection', features: [0, 20].map((value, index) => ({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[[index, 0], [index + .5, 0], [index + .5, .5], [index, .5], [index, 0]]] }, properties: { value } })) };
  const lines = { type: 'FeatureCollection', features: [0, 20].map((value, index) => ({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[index, 0], [index + .5, .5]] }, properties: { value } })) };
  for (const [visualization, input, expected] of [['choropleth', polygon, ['fill', 'line']], ['extrusion', polygon, ['fill-extrusion', 'line']], ['flow', lines, ['line', 'symbol']], ['points', collection(), ['circle']], ['heatmap', collection(), ['heatmap']]]) {
    const instance = controller();
    const layer = instance.selectedLayer();
    instance.workspace.datasets[layer.datasetId] = data.normalizeCollection(input);
    layer.visualization = visualization;
    layer.timeField = '';
    layer.ignoreRegion = true;
    const before = instance.renderedLayer(layer);
    const originalData = JSON.stringify(instance.workspace.datasets);
    instance.applyOperation({ action: 'style', layerId: layer.id, color: 'red', opacity: .4, lineWidth: 5, pointRadius: 11 });
    const rendered = instance.renderedLayer(layer);
    const specs = studio.styleLayers(layer, rendered);
    assert.deepEqual(specs.map((spec) => spec.type), expected, visualization);
    assert.deepEqual(rendered.data, before.data, visualization);
    assert.deepEqual(rendered.metrics, before.metrics, visualization);
    assert.deepEqual(rendered.legend.colors, ['#ff0000']);
    assert.equal(JSON.stringify(instance.workspace.datasets), originalData);
    for (const spec of specs) {
      for (const [key, value] of Object.entries(spec.paint)) if (key.endsWith('-opacity')) assert.equal(value, .4);
      for (const key of ['fill-color', 'fill-outline-color', 'fill-extrusion-color', 'line-color', 'text-color', 'circle-color']) if (Object.hasOwn(spec.paint, key)) assert.equal(spec.paint[key], '#ff0000');
      if (spec.type === 'line') assert.equal(spec.paint['line-width'], 5);
      if (spec.type === 'circle') { assert.equal(spec.paint['circle-radius'], 11); assert.equal(spec.paint['circle-stroke-width'], 5); }
      if (spec.type === 'heatmap') {
        assert.deepEqual(spec.paint['heatmap-color'], ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(255,0,0,0)', 1, '#ff0000']);
        assert.deepEqual(spec.paint['heatmap-weight'], ['coalesce', ['get', '__heatWeight'], 0]);
        assert.equal(spec.paint['heatmap-intensity'], 1);
        assert.equal(spec.paint['heatmap-radius'], 11);
        assert.deepEqual(rendered.data.features.map((feature) => feature.properties.__heatWeight), [0, .25, .5, 1]);
      }
    }
  }
});

test('style-only changes preserve scope, filters, source, selected layer and original population observations', () => {
  const instance = controller();
  const layer = instance.selectedLayer();
  layer.visualization = 'heatmap';
  layer.filters.min = 0;
  layer.filters.category = true;
  layer.scopeBounds = [-3.2, 49.9, -2.8, 51.1];
  instance.workspace.region = [10, 10, 11, 11];
  instance.workspace.time = '2026-01-01T00:00:00.000Z';
  const before = instance.snapshot();
  const baseline = instance.renderedLayer(layer);
  const originalData = instance.workspace.datasets.observations;
  instance.applyOperation({ action: 'style', workspaceId: instance.workspace.id, layerId: layer.id, color: '#f00', opacity: 0, scope: { type: 'workspace' } }, { fromAgent: true });
  assert.deepEqual(layer.filters, before.layers[0].filters);
  assert.deepEqual(layer.scopeBounds, before.layers[0].scopeBounds);
  assert.equal(layer.ignoreRegion, before.layers[0].ignoreRegion);
  assert.deepEqual(layer.source, before.layers[0].source);
  assert.equal(instance.workspace.selectedLayerId, before.selectedLayerId);
  assert.equal(instance.workspace.time, before.time);
  assert.deepEqual(instance.workspace.region, before.region);
  assert.equal(instance.workspace.datasets.observations, originalData);
  assert.deepEqual(originalData.features.map((feature) => feature.properties.value), [0, 20, 40, 80]);
  const rendered = instance.renderedLayer(layer);
  assert.deepEqual(rendered.data, baseline.data);
  assert.deepEqual(rendered.data.features.map((feature) => feature.properties.__heatWeight), [0]);
  assert.equal(rendered.legend.min, 0);
  assert.equal(rendered.legend.max, 0);
  assert.equal(instance.workspace.history.length, 0);
});

test('styling, hiding and removing remain valid when current data filters match nothing', () => {
  const instance = controller();
  instance.selectedLayer().filters.min = 1000;
  assert.equal(instance.renderedLayer(instance.selectedLayer()).inputCount, 0);
  instance.applyOperation({ action: 'style', layerId: 'observations', color: 'red' });
  instance.applyOperation({ action: 'visibility', layerId: 'observations', visible: false });
  instance.applyOperation({ action: 'visibility', layerId: 'observations', visible: true });
  assert.equal(instance.renderedLayer(instance.selectedLayer()).inputCount, 0);
  instance.applyOperation({ action: 'remove', layerId: 'observations' });
  assert.equal(instance.workspace.layers.length, 0);
  assert.equal(instance.workspace.selectedLayerId, '');
});

test('invalid styles and action parameters are rejected atomically before touching layer state', () => {
  const instance = controller();
  const baseline = instance.snapshot();
  const rendered = instance.renderedLayer(instance.selectedLayer());
  for (const patch of [{ opacity: true }, { opacity: NaN }, { lineWidth: Infinity }, { pointRadius: '8' }, { color: 'var(--red)' }]) {
    assert.throws(() => studio.styleLayers({ ...instance.selectedLayer(), ...patch }, rendered), /Color|Opacity|Line width|Point radius/);
  }
  const invalid = [
    { action: 'style' }, { action: 'style', color: true }, { action: 'style', color: null }, { action: 'style', color: 'url(javascript:alert(1))' },
    { action: 'style', color: '#ff000080' }, { action: 'style', color: 'red;opacity:0' }, { action: 'style', color: 'red', opacity: NaN },
    { action: 'style', color: 'red', opacity: true }, { action: 'style', color: 'red', opacity: -1 }, { action: 'style', opacity: 1.1 },
    { action: 'style', lineWidth: 0 }, { action: 'style', lineWidth: 25 }, { action: 'style', pointRadius: 41 }, { action: 'style', pointRadius: '10' },
    { action: 'style', color: 'red', field: 'value' }, { action: 'style', color: 'red', palette: 'ocean' }, { action: 'style', color: 'red', filters: {} },
    { action: 'visibility' }, { action: 'visibility', visible: 0 }, { action: 'visibility', visible: 'false' }, { action: 'visibility', visible: true, color: 'red' },
    { action: 'move' }, { action: 'move', beforeLayerId: 'missing' }, { action: 'move', beforeLayerId: true }, { action: 'remove', visible: false },
    { action: 'style', color: 'red', workspaceId: '' }, { action: 'style', color: 'red', workspaceId: 'another' },
    { action: 'style', color: 'red', scope: { type: 'unknown' } }, { action: 'style', color: 'red', scope: null },
    { action: 'style', color: 'red', scope: { type: 'viewport', bounds: [-4, 49, -1, NaN] } },
    { action: 'style', color: 'red', scope: { type: 'workspace', unexpected: true } },
    { action: 'style', color: 'red', scope: { type: 'workspace', layerId: 'missing' } },
    { action: 'style', color: 'red', scope: { type: 'workspace', bounds: [0, 0, 0, 0] } },
    { action: 'visualize', visualization: 'heatmap', color: 'red' },
  ];
  for (const operation of invalid) {
    assert.throws(() => instance.applyOperation({ layerId: 'observations', ...operation }), Error, JSON.stringify(operation));
    assert.deepEqual(instance.snapshot(), baseline);
    assert.equal(instance.workspace.history.length, 0);
  }
  const getter = { action: 'style', layerId: 'observations', get color() { assert.fail('Accessors must not execute'); } };
  assert.throws(() => instance.applyOperation(getter), /accessor/);
  const scopeGetter = { action: 'style', layerId: 'observations', color: 'red', scope: { get type() { assert.fail('Scope accessors must not execute'); } } };
  assert.throws(() => instance.applyOperation(scopeGetter), /valid Studio scope/);
  const unsafe = JSON.parse('{"action":"style","layerId":"observations","color":"red","__proto__":{"polluted":true}}');
  assert.throws(() => instance.applyOperation(unsafe), /unsafe/);
  assert.equal({}.polluted, undefined);
  assert.deepEqual(instance.snapshot(), baseline);
});

test('agent layer mutations require exact workspace, current target and selected-layer scope', () => {
  const instance = controller();
  instance.workspace.layers.push({ ...instance.selectedLayer(), id: 'other', name: 'Other' });
  const baseline = instance.snapshot();
  for (const operation of [
    { action: 'style', layerId: 'missing', color: 'red' },
    { action: 'style', layerId: 'observations', color: 'red' },
    { action: 'style', layerId: 'observations', color: 'red', workspaceId: instance.workspace.id },
    { action: 'style', layerId: 'other', color: 'red', scope: { type: 'layer', layerId: 'other' } },
    { action: 'visibility', layerId: 'other', visible: false, scope: { type: 'layer', layerId: 'observations' } },
    { action: 'move', layerId: 'observations', beforeLayerId: 'missing', scope: { type: 'workspace' } },
  ]) assert.throws(() => instance.applyOperation(operation, { fromAgent: true }), /real dataset|exact workspace|outside|before-layer/);
  assert.deepEqual(instance.snapshot(), baseline);
  instance.applyOperation({ action: 'style', workspaceId: instance.workspace.id, layerId: 'observations', color: 'red', scope: { type: 'layer', layerId: 'observations' } }, { fromAgent: true });
  assert.equal(instance.selectedLayer().color, '#ff0000');
  instance.applyOperation({ action: 'visibility', workspaceId: instance.workspace.id, layerId: 'other', visible: false, scope: { type: 'workspace' } }, { fromAgent: true });
  assert.equal(instance.workspace.layers[1].visible, false);
  assert.equal(instance.workspace.selectedLayerId, 'observations');
  assert.equal(instance.workspace.history.length, 0);
});

test('style defaults and resets survive undo, redo, duplicate, snapshots and workspace reload', () => {
  const instance = controller();
  instance.applyOperation({ action: 'style', layerId: 'observations', color: 'RED', opacity: .37, lineWidth: 4, pointRadius: 12 });
  instance.applyOperation({ action: 'duplicate', layerId: 'observations' });
  const duplicate = instance.selectedLayer();
  assert.equal(duplicate.datasetId, 'observations');
  assert.equal(duplicate.color, '#ff0000');
  assert.equal(duplicate.lineWidth, 4);
  assert.equal(duplicate.pointRadius, 12);
  instance.applyOperation({ action: 'style', layerId: duplicate.id, color: 'blue' });
  assert.equal(instance.workspace.layers[1].color, '#ff0000');
  const restored = controller(studio.validateWorkspace(JSON.parse(JSON.stringify(instance.workspace))));
  assert.equal(restored.selectedLayer().color, '#0000ff');
  assert.equal(restored.selectedLayer().lineWidth, 4);
  assert.equal(restored.selectedLayer().pointRadius, 12);
  assert.equal(restored.workspace.history.length, 3);
  restored.undo();
  assert.equal(restored.selectedLayer().color, '#ff0000');
  restored.redo();
  assert.equal(restored.selectedLayer().color, '#0000ff');
  restored.applyOperation({ action: 'style', layerId: duplicate.id, color: '' });
  assert.deepEqual(restored.renderedLayer(restored.selectedLayer()).legend.colors, data.PALETTES.olive.colors);
  assert.equal(restored.workspace.layers[1].color, '#ff0000');
  restored.undo();
  assert.equal(restored.selectedLayer().color, '#0000ff');
  restored.undo(); restored.undo(); restored.undo();
  assert.equal(restored.workspace.layers.length, 1);
  assert.equal(restored.selectedLayer().color, '');
  assert.equal(restored.selectedLayer().lineWidth, undefined);
  assert.equal(restored.selectedLayer().pointRadius, undefined);
});

test('workspace imports strictly validate styles and keep pre-style backups compatible', () => {
  const old = project();
  delete old.layers[0].color;
  delete old.layers[0].opacity;
  const restored = studio.validateWorkspace(JSON.parse(JSON.stringify(old)));
  assert.equal(restored.layers[0].color, '');
  assert.equal(restored.layers[0].opacity, .75);
  for (const patch of [{ color: 'url(x)' }, { color: false }, { opacity: true }, { opacity: 2 }, { lineWidth: null }, { lineWidth: 25 }, { pointRadius: 0 }, { pointRadius: NaN }]) {
    const invalid = project();
    Object.assign(invalid.layers[0], patch);
    assert.throws(() => studio.validateWorkspace(invalid), /Color|Opacity|Line width|Point radius/);
  }
});

test('visibility, removal and reordering are reversible structural changes without source mutation', () => {
  const instance = controller();
  const original = instance.selectedLayer();
  instance.workspace.layers.push({ ...original, id: 'middle', name: 'Middle' }, { ...original, id: 'bottom', name: 'Bottom' });
  const dataset = instance.workspace.datasets.observations;
  instance.applyOperation({ action: 'visibility', layerId: 'observations', visible: false });
  assert.equal(original.visible, false);
  instance.applyOperation({ action: 'visibility', layerId: 'observations', visible: true });
  instance.applyOperation({ action: 'move', layerId: 'bottom', beforeLayerId: 'observations' });
  assert.deepEqual(instance.workspace.layers.map((layer) => layer.id), ['bottom', 'observations', 'middle']);
  instance.applyOperation({ action: 'move', layerId: 'bottom', beforeLayerId: null });
  assert.deepEqual(instance.workspace.layers.map((layer) => layer.id), ['observations', 'middle', 'bottom']);
  instance.applyOperation({ action: 'move', layerId: 'observations', beforeLayerId: 'bottom' });
  assert.deepEqual(instance.workspace.layers.map((layer) => layer.id), ['middle', 'observations', 'bottom']);
  instance.applyOperation({ action: 'move', layerId: 'observations', beforeLayerId: 'observations' });
  assert.deepEqual(instance.workspace.layers.map((layer) => layer.id), ['middle', 'observations', 'bottom']);
  instance.applyOperation({ action: 'remove', layerId: 'bottom' });
  assert.equal(instance.workspace.selectedLayerId, 'observations');
  instance.workspace.time = '2026-01-01T00:00:00.000Z';
  instance.applyOperation({ action: 'remove', layerId: 'observations' });
  assert.equal(instance.workspace.selectedLayerId, 'middle');
  assert.equal(instance.workspace.time, null);
  assert.equal(instance.workspace.datasets.observations, dataset);
  instance.undo();
  assert.equal(instance.workspace.selectedLayerId, 'observations');
  assert.equal(instance.workspace.time, '2026-01-01T00:00:00.000Z');
  assert.deepEqual(instance.workspace.layers.map((layer) => layer.id), ['middle', 'observations']);
  instance.redo();
  assert.deepEqual(instance.workspace.layers.map((layer) => layer.id), ['middle']);
  const reloaded = studio.validateWorkspace(JSON.parse(JSON.stringify(instance.workspace)));
  assert.deepEqual(reloaded.layers.map((layer) => layer.id), ['middle']);
  assert.equal(reloaded.layers[0].datasetId, 'observations');
  assert.deepEqual(reloaded.datasets.observations, dataset);
});

test('new layer mutations respect locks and busy guards while joining the outer map operation', () => {
  const operations = [{ action: 'style', color: 'red' }, { action: 'visibility', visible: false }, { action: 'move', beforeLayerId: null }, { action: 'remove' }];
  for (const operation of operations) {
    const instance = controller();
    instance.selectedLayer().locked = true;
    assert.throws(() => instance.applyOperation({ ...operation, layerId: 'observations' }), /locked/);
    instance.selectedLayer().locked = false;
    instance.app.agentRunId = 'active';
    assert.throws(() => instance.applyOperation({ ...operation, layerId: 'observations' }), /could not be applied/);
    assert.equal(instance.workspace.history.length, 0);
    instance.app.undoing = true;
    assert.throws(() => instance.applyOperation({ ...operation, layerId: 'observations' }, { outerMapOperation: true }), /could not be applied/);
    instance.app.undoing = false;
    const before = instance.snapshot();
    instance.applyOperation({ ...operation, layerId: 'observations' }, { outerMapOperation: true });
    assert.equal(instance.workspace.history.length, 0);
    instance.restoreSnapshot(before, { restoreCamera: false });
    assert.deepEqual(instance.snapshot(), before);
    assert.equal(instance.selectedLayer().visible, true);
    assert.equal(instance.selectedLayer().color, '');
  }
});

test('every new agent action shares the parent transaction and can restore its pre-run snapshot', () => {
  for (const operation of [{ action: 'style', color: 'red' }, { action: 'visibility', visible: false }, { action: 'move', beforeLayerId: 'observations' }, { action: 'remove' }]) {
    const instance = controller();
    instance.workspace.layers.push({ ...instance.selectedLayer(), id: 'other', name: 'Other' });
    instance.app.agentRunId = 'active';
    const before = instance.snapshot();
    const layerId = operation.action === 'move' ? 'other' : 'observations';
    instance.applyOperation({ ...operation, workspaceId: instance.workspace.id, layerId, scope: { type: 'workspace' } }, { fromAgent: true });
    assert.equal(instance.workspace.history.length, 0);
    instance.restoreSnapshot(before, { restoreCamera: false });
    assert.deepEqual(instance.snapshot(), before);
    assert.equal(instance.workspace.datasets.observations.features[0].properties.value, 0);
  }
});

test('manual style updates validate values and retain active-operation and layer-lock guards', () => {
  const instance = controller();
  instance.updateLayer({ color: 'RED', pointRadius: 8 }, 'Set style');
  assert.equal(instance.selectedLayer().color, '#ff0000');
  assert.equal(instance.selectedLayer().pointRadius, 8);
  const baseline = instance.snapshot();
  instance.updateLayer({ opacity: true }, 'Invalid opacity');
  assert.deepEqual(instance.snapshot(), baseline);
  instance.app.agentRunId = 'active';
  instance.updateLayer({ color: 'blue' }, 'Busy style');
  assert.deepEqual(instance.snapshot(), baseline);
  instance.app.agentRunId = '';
  instance.selectedLayer().locked = true;
  instance.updateLayer({ color: 'blue' }, 'Locked style');
  assert.equal(instance.selectedLayer().color, '#ff0000');
  assert.equal(instance.workspace.history.length, 1);
});

test('hide/show and size changes reuse computed geometry and existing MapLibre sources', () => {
  const instance = controller();
  const layer = instance.selectedLayer();
  layer.visualization = 'heatmap';
  const { map, events } = mapRenderer(instance);
  instance.renderMap();
  const source = map.getSource('studio-data-observations');
  const rendered = instance.renderedLayer(layer);
  events.length = 0;
  instance.applyOperation({ action: 'visibility', layerId: layer.id, visible: false });
  assert.equal(instance.renderedLayer(layer), rendered);
  assert.equal(map.getSource('studio-data-observations'), source);
  assert.equal(map.getLayer('studio-observations-heat').layout.visibility, 'none');
  instance.applyOperation({ action: 'visibility', layerId: layer.id, visible: true });
  assert.equal(instance.renderedLayer(layer), rendered);
  assert.equal(map.getSource('studio-data-observations'), source);
  assert.equal(map.getLayer('studio-observations-heat').layout.visibility, 'visible');
  instance.applyOperation({ action: 'style', layerId: layer.id, opacity: .2, pointRadius: 15 });
  assert.equal(instance.renderedLayer(layer), rendered);
  assert.equal(map.getLayer('studio-observations-heat').paint['heatmap-radius'], 15);
  assert.equal(map.getLayer('studio-observations-heat').paint['heatmap-opacity'], .2);
  assert.deepEqual(events, []);
  assert.deepEqual(source.data.features.map((feature) => feature.properties.__heatWeight), [0, .25, .5, 1]);
  instance.applyOperation({ action: 'remove', layerId: layer.id });
  assert.deepEqual(events, [['removeLayer', 'studio-observations-heat'], ['removeSource', 'studio-data-observations']]);
  assert.equal(map.getSource('studio-data-observations'), undefined);
  assert.equal(instance.mapData.size, 0);
});

test('logical Studio order moves whole rendered families and rehydrates persisted styles after a style reload', () => {
  const instance = controller();
  const polygon = data.makeLayer({ type: 'Polygon', coordinates: [[[-3, 50], [-2, 50], [-2, 51], [-3, 51], [-3, 50]]] }, { id: 'polygon', color: 'red', opacity: .3, lineWidth: 7 });
  instance.workspace.datasets.polygon = polygon.data;
  delete polygon.data;
  polygon.datasetId = 'polygon';
  instance.workspace.layers.push(polygon);
  const { map, events } = mapRenderer(instance);
  instance.renderMap();
  assert.deepEqual(map.getStyle().layers.map((layer) => layer.id), ['studio-polygon-fill', 'studio-polygon-outline', 'studio-observations-point']);
  instance.applyOperation({ action: 'move', layerId: 'polygon', beforeLayerId: 'observations' });
  assert.deepEqual(map.getStyle().layers.map((layer) => layer.id), ['studio-observations-point', 'studio-polygon-fill', 'studio-polygon-outline']);
  assert.equal(map.getLayer('studio-polygon-outline').paint['line-width'], 7);
  assert.equal(map.getLayer('studio-polygon-fill').paint['fill-color'], '#ff0000');
  instance.workspace = studio.validateWorkspace(JSON.parse(JSON.stringify(instance.workspace)));
  instance.cache.clear();
  map.getStyle().layers.length = 0;
  for (const sourceId of Object.keys(map.getStyle().sources)) delete map.getStyle().sources[sourceId];
  events.length = 0;
  instance.renderMap();
  assert.deepEqual(map.getStyle().layers.map((layer) => layer.id), ['studio-observations-point', 'studio-polygon-fill', 'studio-polygon-outline']);
  assert.equal(map.getLayer('studio-polygon-fill').paint['fill-opacity'], .3);
  assert.equal(map.getLayer('studio-polygon-outline').paint['line-color'], '#ff0000');
  assert(events.some(([event, id]) => event === 'addSource' && id === 'studio-data-polygon'));
  instance.applyOperation({ action: 'remove', layerId: 'polygon' });
  assert.equal(map.getLayer('studio-polygon-fill'), undefined);
  assert.equal(map.getLayer('studio-polygon-outline'), undefined);
  assert.equal(map.getSource('studio-data-polygon'), undefined);
});

test('workspace duplication deep-clones style settings without retaining the original project history', () => {
  const instance = controller();
  instance.applyOperation({ action: 'style', layerId: 'observations', color: 'red', lineWidth: 3, pointRadius: 8 });
  instance.captureCamera = () => {};
  instance.switchWorkspace = (id) => { instance.workspace = instance.projects.find((project) => project.id === id); };
  instance.el = { 'studio-workspace-name': { focus() {}, select() {} } };
  const original = instance.workspace;
  instance.newProject(true);
  assert.notEqual(instance.workspace.id, original.id);
  assert.equal(instance.selectedLayer().color, '#ff0000');
  assert.equal(instance.selectedLayer().lineWidth, 3);
  assert.equal(instance.selectedLayer().pointRadius, 8);
  assert.equal(instance.workspace.history.length, 0);
  instance.selectedLayer().color = '#0000ff';
  instance.selectedLayer().filters.min = 10;
  assert.equal(original.layers[0].color, '#ff0000');
  assert.equal(original.layers[0].filters.min, null);
  assert.deepEqual(instance.workspace.datasets, original.datasets);
  assert.notEqual(instance.workspace.datasets.observations, original.datasets.observations);
});

test('outer removal retains source data for cancellation and the parent map undo snapshot across saves', (t) => {
  const previous = global.localStorage;
  const saved = new Map();
  global.localStorage = { setItem(key, value) { saved.set(key, value); } };
  t.after(() => { global.localStorage = previous; });
  const instance = controller();
  instance.el = { 'studio-save-status': { textContent: '', classList: { remove() {}, add() {} } } };
  const before = instance.snapshot();
  instance.app.agentSnapshot = { studio: before };
  instance.applyOperation({ action: 'remove', layerId: 'observations', workspaceId: instance.workspace.id, scope: { type: 'workspace' } }, { fromAgent: true });
  assert.equal(instance.workspace.history.length, 0);
  instance.flushSave();
  assert(instance.workspace.datasets.observations);
  instance.restoreSnapshot(before, { restoreCamera: false });
  assert.deepEqual(instance.renderedLayer(instance.selectedLayer()).data.features.map((feature) => feature.properties.value), [0, 20, 40, 80]);
  instance.app.agentSnapshot = null;
  instance.app.mapActions.push({ before: { studio: before } });
  instance.applyOperation({ action: 'remove', layerId: 'observations' }, { outerMapOperation: true });
  instance.flushSave();
  assert(instance.workspace.datasets.observations);
  const backup = JSON.parse(saved.get('meridian.studio.v1'));
  assert(backup.workspaces[0].datasets.observations);
  instance.restoreSnapshot(before, { restoreCamera: false });
  assert.equal(instance.renderedLayer(instance.selectedLayer()).inputCount, 4);
});

test('uniform tactical styling and palette reset keep typed categories and legend swatches consistent', () => {
  const instance = controller();
  const layer = instance.selectedLayer();
  layer.visualization = 'tactical';
  const palette = instance.renderedLayer(layer);
  instance.applyOperation({ action: 'style', layerId: layer.id, color: 'red' });
  const uniform = instance.renderedLayer(layer);
  assert.deepEqual(uniform.legend.colors, ['#ff0000']);
  assert.deepEqual(uniform.legend.categorical.map((category) => category.color), ['#ff0000', '#ff0000']);
  assert.deepEqual(uniform.legend.categorical.map((category) => category.value), ['false', 'true']);
  assert.deepEqual(uniform.data, palette.data);
  assert.equal(studio.styleLayers(layer, uniform)[0].paint['circle-color'], '#ff0000');
  instance.applyOperation({ action: 'style', layerId: layer.id, color: '' });
  assert.deepEqual(instance.renderedLayer(layer).legend, palette.legend);
});

test('single-color legends show actual swatches and intensity, retaining exact source ranges and zero caveats', (t) => {
  const instance = controller();
  const { root, descendants } = legendNodes(instance, t);
  const layer = instance.selectedLayer();
  instance.applyOperation({ action: 'style', layerId: layer.id, color: 'red' });
  instance.renderLegend();
  let ramp = descendants(root).find((node) => node.className === 'studio-legend-ramp');
  assert.equal(ramp.style.background, '#ff0000');
  assert.match(root.textContent, /Uniform color #ff0000; color does not encode value differences/);
  assert.equal(descendants(root).find((node) => node.className === 'studio-legend-range').textContent, '0 40 80');
  layer.visualization = 'heatmap';
  instance.renderLegend();
  ramp = descendants(root).find((node) => node.className === 'studio-legend-ramp');
  assert.equal(ramp.style.background, 'linear-gradient(90deg, #ff000000, #ff0000)');
  assert.match(root.textContent, /Single color #ff0000; increasing opacity shows relative intensity/);
  assert.match(root.textContent, /range describes source values/);
  assert.equal(descendants(root).find((node) => node.className === 'studio-legend-range').textContent, '0 40 80');
  for (const feature of instance.workspace.datasets.observations.features) feature.properties.value = 0;
  instance.cache.clear();
  instance.renderLegend();
  assert.match(root.textContent, /All displayed source values are zero; no heat intensity/);
  assert.equal(descendants(root).find((node) => node.className === 'studio-legend-range').textContent, '0 0 0');
  assert.doesNotMatch(root.textContent, /palette midpoint/);
  instance.applyOperation({ action: 'style', layerId: layer.id, color: '' });
  instance.renderLegend();
  ramp = descendants(root).find((node) => node.className === 'studio-legend-ramp');
  assert.equal(ramp.style.background, `linear-gradient(90deg, ${data.PALETTES.olive.colors.join(', ')})`);
  assert.doesNotMatch(root.textContent, /Single color #ff0000|Uniform color #ff0000/);
});

test('all visible layer legends use actual uniform colors and hidden layers disappear from the legend', (t) => {
  const instance = controller();
  const { root, descendants } = legendNodes(instance, t);
  const selected = instance.selectedLayer();
  selected.visualization = 'tactical';
  const heat = { ...selected, id: 'heat', name: 'Heat', visualization: 'heatmap', color: '#0000ff' };
  const other = { ...selected, id: 'other', name: 'Other', visualization: 'points', color: '#ffff00' };
  instance.workspace.layers.push(heat, other);
  instance.applyOperation({ action: 'style', layerId: selected.id, color: 'red' });
  instance.renderLegend();
  assert.deepEqual(descendants(root).filter((node) => node.tagName === 'i').map((node) => node.style.background), ['#ff0000', '#ff0000']);
  assert.match(root.textContent, /Categories share this color/);
  assert.deepEqual(descendants(root).filter((node) => node.className === 'studio-legend-ramp').map((node) => node.style.background), ['linear-gradient(90deg, #0000ff00, #0000ff)', '#ffff00']);
  instance.applyOperation({ action: 'visibility', layerId: selected.id, visible: false });
  instance.renderLegend();
  assert.equal(root.children[0].textContent, 'Heat');
  assert.doesNotMatch(root.textContent, /Observations|#ff0000/);
  instance.applyOperation({ action: 'visibility', layerId: heat.id, visible: false });
  instance.applyOperation({ action: 'visibility', layerId: other.id, visible: false });
  instance.renderLegend();
  assert.equal(root.hidden, true);
  assert.equal(root.children.length, 0);
});

test('tactical categorical colors remain stable while filtering and retain boolean categories', () => {
  const instance = controller();
  const layer = instance.selectedLayer();
  layer.visualization = 'tactical';
  const all = instance.renderedLayer(layer);
  assert.equal(all.legend.categorical.length, 2);
  const original = all.legend.categorical.find((category) => category.value === 'false').color;
  layer.filters.category = false;
  const filtered = instance.renderedLayer(layer);
  assert.equal(filtered.data.features.length, 2);
  assert.equal(filtered.legend.categorical.find((category) => category.value === 'false').color, original);
  assert.equal(filtered.data.features[0].properties.__category, 'false');
});

test('agent context wraps MapLibre longitudes and prioritizes selected data in its bounded catalog', () => {
  const instance = controller();
  instance.app.map.getBounds = () => ({ getWest: () => 170, getSouth: () => -5, getEast: () => 190, getNorth: () => 5 });
  instance.workspace.layers = Array.from({ length: 30 }, (_, index) => ({ ...instance.workspace.layers[0], id: `layer-${index}`, name: `Layer ${index}` }));
  instance.workspace.selectedLayerId = 'layer-29';
  const context = instance.agentContext();
  assert.deepEqual(context.scope.bounds, [170, -5, -170, 5]);
  assert.equal(context.studio.layers[0].id, 'layer-29');
  assert(context.studio.layers.length <= 20);
  assert(JSON.stringify(context).length < 18000);
  assert.match(context.studio.layers[0].source.caveat, /Synthetic/);
});

test('agent context exposes persisted style, visibility and locks without copying data', () => {
  const instance = controller();
  instance.applyOperation({ action: 'style', layerId: 'observations', color: 'red', opacity: .2, lineWidth: 6, pointRadius: 13 });
  instance.selectedLayer().visible = false;
  instance.selectedLayer().locked = true;
  const layer = instance.agentContext().studio.layers[0];
  assert.equal(layer.color, '#ff0000');
  assert.equal(layer.opacity, .2);
  assert.equal(layer.lineWidth, 6);
  assert.equal(layer.pointRadius, 13);
  assert.equal(layer.visible, false);
  assert.equal(layer.locked, true);
  assert.equal(layer.palette, 'olive');
  assert.equal(layer.data, undefined);
  assert.equal(layer.features, undefined);
});

test('Studio blocks pending-undo edits, redo and project creation', () => {
  const instance = controller();
  instance.mutate('Rename', () => { instance.workspace.name = 'Changed'; });
  instance.undo();
  instance.app.undoing = true;
  instance.redo();
  instance.newProject();
  assert.equal(instance.workspace.name, 'Test project');
  assert.equal(instance.projects.length, 1);
  assert.equal(instance.mutate('Late edit', () => { instance.workspace.name = 'Late'; }), false);
  assert.equal(instance.workspace.name, 'Test project');
});

test('completed outer operations can discard stale redo without changing current layers', () => {
  const instance = controller();
  instance.renderHistory = () => {};
  instance.mutate('Rename', () => { instance.workspace.name = 'Changed'; });
  instance.undo();
  assert.equal(instance.workspace.future.length, 1);
  instance.mutate('Agent output', () => { instance.workspace.name = 'Agent project'; }, { record: false });
  instance.discardRedo();
  instance.redo();
  assert.equal(instance.workspace.name, 'Agent project');
  assert.equal(instance.workspace.future.length, 0);
});

test('compare operations apply their validated scope, filters and visualization after capturing the reference', () => {
  const instance = controller();
  let reference;
  instance.startCompare = () => { reference = { ...instance.selectedLayer() }; return true; };
  const bounds = [-3.2, 49.9, -2.8, 51.1];
  instance.applyOperation({ action: 'compare', layerId: 'observations', visualization: 'heatmap', field: 'value', min: 10, scope: { type: 'selection', bounds } });
  assert.equal(reference.visualization, 'points');
  assert.equal(instance.selectedLayer().visualization, 'heatmap');
  assert.equal(instance.selectedLayer().filters.min, 10);
  assert.deepEqual(instance.selectedLayer().scopeBounds, bounds);
  assert.equal(instance.renderedLayer(instance.selectedLayer()).inputCount, 1);
});

test('agent category operations retain boolean values through filtering and project reload', () => {
  const instance = controller();
  instance.applyOperation({ action: 'filter', layerId: 'observations', categoryField: 'category', category: false });
  assert.equal(instance.selectedLayer().filters.category, false);
  assert.equal(instance.renderedLayer(instance.selectedLayer()).inputCount, 2);
  const restored = studio.validateWorkspace(JSON.parse(JSON.stringify(instance.workspace)));
  assert.equal(restored.layers[0].filters.category, false);
  assert.throws(() => instance.applyOperation({ action: 'filter', layerId: 'observations', categoryField: 'category', category: {} }), /JSON scalar/);
});

test('multi-dataset workspace backups larger than a single-file limit remain importable', async () => {
  const instance = controller();
  const document = { meridianStudio: 1, workspace: project() };
  const note = 'x'.repeat(4500000);
  for (const key of ['large-a', 'large-b']) document.workspace.datasets[key] = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-3, 50] }, properties: { note } }] };
  const text = JSON.stringify(document);
  const file = { size: Buffer.byteLength(text), text: async () => text };
  assert(file.size > 8 * 1024 * 1024);
  await assert.rejects(() => instance.readJsonFile(file), /8 MB/);
  const read = await instance.readJsonFile(file, 32 * 1024 * 1024);
  assert.equal(studio.validateWorkspace(read.workspace).datasets['large-b'].features[0].properties.note.length, note.length);
});

test('aggregate workspace limits reject oversized mutations without retaining orphaned datasets', () => {
  const instance = controller();
  const note = 'x'.repeat(7 * 1024 * 1024);
  const changed = instance.mutate('Oversized project', () => {
    for (let index = 0; index < 5; index++) instance.workspace.datasets[`large-${index}`] = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-3, 50] }, properties: { note } }] };
  });
  assert.equal(changed, false);
  assert.match(instance.statusMessage, /32 MB/);
  assert.deepEqual(Object.keys(instance.workspace.datasets), ['observations']);
  assert.equal(instance.workspace.history.length, 0);
});

test('sourced population datasets retain actual values and complete provenance through reload', () => {
  const instance = controller();
  instance.setTab = () => {};
  instance.focusLayer = () => {};
  const sourceData = collection();
  for (const feature of sourceData.features) feature.properties.observedAt = '2011-01-01';
  const update = { name: 'Sourced observations', data: sourceData, field: 'value', units: 'people per settlement', visualization: 'heatmap', source: { name: 'Census 2011', url: 'https://example.org/census', attribution: 'Data office', retrievedAt: '2026-01-01', publishedDate: '2012', referenceYear: '2011', license: 'CC BY 4.0', resolution: 'settlement', caveat: 'Partial settlement coverage, not a continuous grid.' }, scope: { type: 'workspace' } };
  const layer = instance.applySourcedDataset(update);
  assert.equal(instance.workspace.layers.length, 2);
  assert.equal(instance.workspace.history.length, 0);
  assert.equal(layer.palette, 'thermal');
  assert.deepEqual(instance.workspace.datasets[layer.datasetId].features.map((feature) => feature.properties.value), [0, 20, 40, 80]);
  const original = instance.renderedLayer(layer);
  instance.applyOperation({ action: 'style', workspaceId: instance.workspace.id, layerId: layer.id, color: 'red', scope: { type: 'workspace' } }, { fromAgent: true });
  assert.deepEqual(instance.renderedLayer(layer).data, original.data);
  assert.deepEqual(instance.renderedLayer(layer).data.features.map((feature) => feature.properties.__heatWeight), [0, .25, .5, 1]);
  assert.deepEqual(instance.renderedLayer(layer).legend.colors, ['#ff0000']);
  assert.equal(instance.workspace.history.length, 0);
  const restored = studio.validateWorkspace(JSON.parse(JSON.stringify(instance.workspace)));
  assert.equal(restored.layers[0].color, '#ff0000');
  assert.equal(restored.layers[0].source.url, update.source.url);
  assert.equal(restored.layers[0].source.attribution, 'Data office');
  assert.equal(restored.layers[0].source.referenceYear, '2011');
  assert.equal(restored.layers[0].source.license, 'CC BY 4.0');
});

test('sourced dataset import respects frozen extent instead of widening an empty scope', () => {
  const instance = controller();
  const before = instance.workspace.layers.length;
  const data = collection();
  for (const feature of data.features) delete feature.properties.observedAt;
  assert.throws(() => instance.applySourcedDataset({ data, field: 'value', visualization: 'heatmap', scope: { type: 'selection', bounds: [10, 10, 11, 11] } }), /No source observations/);
  assert.equal(instance.workspace.layers.length, before);
  assert.throws(() => instance.applySourcedDataset({ data: collection(), field: 'value', visualization: 'heatmap', workspaceId: 'wrong', scope: { type: 'workspace' } }), /different workspace/);
});

test('sourced heatmaps refuse regional totals, MultiPoint duplicate values and missing scoped numerics', () => {
  const instance = controller();
  const update = { field: 'population', visualization: 'heatmap', scope: { type: 'selection', bounds: [0, 0, 1, 1] } };
  for (const geometry of [{ type: 'Polygon', coordinates: [[[-1, -1], [10, -1], [10, 2], [-1, 2], [-1, -1]]] }, { type: 'MultiPoint', coordinates: [[.5, .5], [10, 10]] }]) {
    assert.throws(() => instance.applySourcedDataset({ ...update, data: { type: 'FeatureCollection', features: [{ type: 'Feature', geometry, properties: { population: 120000 } }] } }), /original Point/);
  }
  const missing = { type: 'FeatureCollection', features: [[.5, .5, null], [5, 5, 42]].map(([lon, lat, population]) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { population } })) };
  assert.throws(() => instance.applySourcedDataset({ ...update, data: missing }), /No valid source values/);
  assert.equal(instance.workspace.layers.length, 1);
});

test('sourced population cannot silently combine observation years', () => {
  const instance = controller();
  assert.throws(() => instance.applySourcedDataset({ data: collection(), field: 'value', visualization: 'heatmap', scope: { type: 'workspace' } }), /multiple observation times/);
  assert.equal(instance.workspace.layers.length, 1);
});

test('sourced heatmap fitting uses its frozen scope, not the wider remote dataset or current viewport', (t) => {
  const previous = global.window;
  global.window = { innerWidth: 1440, innerHeight: 1000, matchMedia: () => ({ matches: true }) };
  t.after(() => { global.window = previous; });
  const instance = controller();
  instance.setTab = () => {};
  const fits = [];
  instance.app.map.fitBounds = (bounds) => fits.push(bounds);
  const input = collection();
  for (const feature of input.features) delete feature.properties.observedAt;
  input.features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [77.4, 28.6] }, properties: { value: 100 } });
  const scope = { type: 'selection', bounds: [-3.2, 49.8, -2.8, 51.2] };
  const layer = instance.applySourcedDataset({ name: 'Frozen study', data: input, field: 'value', units: 'people per grid cell', visualization: 'heatmap', scope, source: { name: 'Raster fixture', method: 'raster-window', referenceYear: 2020 } });
  instance.workspace.region = [70, 20, 80, 30];
  instance.focusLayer(layer);
  assert.deepEqual(fits.at(-1), [[-3.2, 49.8], [-2.8, 51.2]]);
  assert.equal(instance.renderedLayer(layer).inputCount, 2);
  assert.match(instance.statusMessage, /2 extracted raster cells.*reference year 2020/);
  assert.equal(instance.workspace.datasets[layer.datasetId].features.length, 5);
  layer.scopeBounds = [170, -5, -175, 5];
  instance.focusLayer(layer);
  assert.deepEqual(fits.at(-1), [[170, -5], [185, 5]]);
  layer.ignoreRegion = true;
  layer.scopeBounds = null;
  layer.filters.min = 100;
  instance.focusLayer(layer);
  for (const [lon, lat] of fits.at(-1)) {
    assert(Math.abs(lon - 77.4) < 1e-10, 'Without a frozen scope, fit matching extracted values only');
    assert.equal(lat, 28.6);
  }
});

test('raster legend and insights expose real reference metadata and trustworthy zero-value framing', (t) => {
  const previous = global.document;
  const node = (tagName) => ({
    tagName, children: [], style: {}, attributes: {}, value: '',
    get textContent() { return [this.value, ...this.children.map((child) => child.textContent)].filter(Boolean).join(' '); },
    set textContent(value) { this.value = value; this.children = []; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.value = ''; this.children = children; },
    setAttribute(key, value) { this.attributes[key] = value; },
  });
  global.document = { createElement: node };
  t.after(() => { global.document = previous; });
  const instance = controller();
  instance.enabled = true;
  instance.el = Object.fromEntries(['studio-legend', 'studio-insights', 'studio-provenance'].map((key) => [key, node('div')]));
  const layer = instance.selectedLayer();
  layer.visualization = 'heatmap';
  layer.source = { name: 'WorldPop test fixture', url: 'https://example.org/grid.tif', referenceYear: '2020', resolution: '30 arc seconds (~1 km)', license: 'CC BY 4.0', method: 'raster-window', publishedDate: '2021-04-01', retrievedAt: '2026-10-07', caveat: 'Historical modeled population, not a current census. Extracted cells are not an administrative total.' };
  instance.renderLegend();
  instance.renderInsights();
  const legend = instance.el['studio-legend'].textContent;
  assert.match(legend, /Reference year: 2020.*Resolution: 30 arc seconds/);
  assert.match(legend, /Historical modeled population, not a current census/);
  assert.match(legend, /source values, not population density/);
  const provenance = instance.el['studio-provenance'].textContent;
  for (const detail of ['Reference year 2020', 'Resolution 30 arc seconds', 'Method raster-window', 'License CC BY 4.0', 'Published: 2021-04-01', 'Retrieved: 2026-10-07']) assert(provenance.includes(detail), detail);
  const restored = studio.validateWorkspace(JSON.parse(JSON.stringify(instance.workspace)));
  for (const key of ['referenceYear', 'resolution', 'method', 'license', 'publishedDate', 'retrievedAt']) assert.equal(restored.layers[0].source[key], layer.source[key]);
  layer.source = { name: 'Metadata omitted' };
  instance.renderInsights();
  instance.renderLegend();
  assert.doesNotMatch(instance.el['studio-provenance'].textContent, /Reference year|Resolution|License|raster-window/);
  assert.doesNotMatch(instance.el['studio-legend'].textContent, /Reference year|Resolution|Historical modeled/);
  for (const feature of instance.workspace.datasets[layer.datasetId].features) feature.properties.value = 0;
  instance.cache.clear();
  instance.renderLegend();
  assert.match(instance.el['studio-legend'].textContent, /All displayed source values are zero; no heat intensity/);
  instance.workspace.datasets[layer.datasetId].features[0].properties.value = -1;
  instance.cache.clear();
  instance.renderLegend();
  assert.doesNotMatch(instance.el['studio-legend'].textContent, /All displayed source values are zero/);
});
