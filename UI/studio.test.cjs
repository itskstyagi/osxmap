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

test('workspace round trips retain data, source, ordering, opacity, filters and temporal fields', () => {
  const original = project();
  original.layers[0].visible = false;
  original.layers[0].opacity = .37;
  original.layers[0].locked = true;
  original.layers[0].filters.category = false;
  original.layers[0].filters.min = 0;
  original.region = [170, 1, -170, 5];
  original.camera = { center: [175, 3], zoom: 9, bearing: 15, pitch: 40 };
  const restored = studio.validateWorkspace(JSON.parse(JSON.stringify(original)));
  assert.equal(restored.layers[0].visible, false);
  assert.equal(restored.layers[0].opacity, .37);
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
  assert.deepEqual(instance.workspace.datasets[layer.datasetId].features.map((feature) => feature.properties.value), [0, 20, 40, 80]);
  const restored = studio.validateWorkspace(JSON.parse(JSON.stringify(instance.workspace)));
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
