const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test, before } = require('node:test');

let engine;
before(async () => {
  const source = `${readFileSync(join(__dirname, 'studio-data.js'), 'utf8')}\n//# sourceURL=studio-data.js`;
  engine = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
});

const feature = (geometry, properties = {}, id) => ({ type: 'Feature', geometry, properties, ...(id === undefined ? {} : { id }) });
const point = (x, y, properties = {}, id) => feature({ type: 'Point', coordinates: [x, y] }, properties, id);
const line = (coordinates, properties = {}) => feature({ type: 'LineString', coordinates }, properties);
const polygon = (rings, properties = {}) => feature({ type: 'Polygon', coordinates: rings }, properties);
const collection = (...features) => ({ type: 'FeatureCollection', features });
const box = (w, s, e, n) => [[w, s], [e, s], [e, n], [w, n], [w, s]];
const fixture = () => collection(
  point(0, 0, { value: -10, category: 'A', observedAt: '2026-01-01' }),
  point(1, 0, { value: 0, category: 'B', observedAt: '2026-02-01' }),
  point(1, 1, { value: 20, category: 'A', observedAt: '2026-03-01' }),
  point(0, 1, { value: 10, category: 'B', observedAt: '2026-01-01' }),
  point(0.5, 0.5, { value: 5, category: 'C', observedAt: '2026-02-01' }),
);
const scalarRectangle = (west, south, east, north) => collection(
  point(west, south, { value: 10 }), point(east, south, { value: 20 }),
  point(west, north, { value: 40 }), point(east, north, { value: 80 }),
);
const approximately = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} differs from ${expected}`);

function assertRenderable(result) {
  assert.equal(result.data.type, 'FeatureCollection');
  assert.equal(result.metrics.count, result.data.features.length);
  assert.equal(result.metrics.validCount, result.data.features.length);
  assert.equal(result.legend.min, result.metrics.min);
  assert.equal(result.legend.max, result.metrics.max);
  assert.ok(Array.isArray(result.legend.colors));
  assert.equal(typeof result.legend.note, 'string');
  for (const { properties } of result.data.features) {
    assert.ok(Number.isFinite(properties.__value));
    assert.ok(properties.__weight >= 0 && properties.__weight <= 1);
    assert.ok(Number.isFinite(properties.__height) && properties.__height >= 0);
  }
  assert.doesNotThrow(() => engine.normalizeCollection(result.data));
}

test('catalogs expose exactly the requested palette and visualization identifiers', () => {
  assert.deepEqual(Object.keys(engine.PALETTES), ['monochrome', 'olive', 'thermal', 'ocean', 'violet']);
  for (const palette of Object.values(engine.PALETTES)) {
    assert.equal(typeof palette.label, 'string');
    assert.ok(palette.colors.length >= 3);
    palette.colors.forEach((color) => assert.match(color, /^#[0-9a-f]{6}$/i));
  }
  assert.deepEqual(Object.keys(engine.VISUALIZATIONS), ['points', 'density', 'heatmap', 'choropleth', 'contours', 'extrusion', 'flow', 'surface', 'tactical']);
  Object.values(engine.VISUALIZATIONS).forEach(({ label, description }) => assert.ok(label && description));
});

test('normalization clones collections, features, and each supported geometry', () => {
  const geometries = [
    { type: 'Point', coordinates: [12, 34, 0] },
    { type: 'MultiPoint', coordinates: [[12, 34], [13, 35]] },
    { type: 'LineString', coordinates: [[12, 34], [13, 35]] },
    { type: 'MultiLineString', coordinates: [[[12, 34], [13, 35]], [[14, 36], [15, 37]]] },
    { type: 'Polygon', coordinates: [box(12, 34, 13, 35)] },
    { type: 'MultiPolygon', coordinates: [[box(12, 34, 13, 35)], [box(14, 36, 15, 37)]] },
  ];
  geometries.forEach((geometry) => {
    const normalized = engine.normalizeCollection(geometry);
    assert.equal(normalized.features.length, 1);
    assert.deepEqual(normalized.features[0].geometry, geometry);
    assert.notEqual(normalized.features[0].geometry.coordinates, geometry.coordinates);
  });
  const input = { ...collection(feature(geometries[0], { zero: 0, flag: false, blank: '', missing: null, nested: { tags: ['one'] } }, 0)), source: { name: 'Supplied source', attribution: 'Supplied attribution' } };
  const copy = engine.normalizeCollection(input);
  assert.deepEqual(copy, input);
  copy.features[0].properties.nested.tags.push('two');
  copy.source.name = 'Changed';
  assert.deepEqual(input.features[0].properties.nested.tags, ['one']);
  assert.equal(input.source.name, 'Supplied source');
  assert.equal(engine.normalizeCollection(input.features[0]).features[0].id, 0);
});

test('normalization allows null properties and empty FeatureCollections, never null geometry', () => {
  assert.deepEqual(engine.normalizeCollection(collection()), collection());
  assert.deepEqual(engine.normalizeCollection(feature({ type: 'Point', coordinates: [0, 0] }, null)).features[0].properties, {});
  assert.throws(() => engine.normalizeCollection(feature(null)), /geometry.*plain object/i);
});

test('malformed GeoJSON and unsupported geometry produce descriptive failures', () => {
  for (const input of [null, 'not geojson', [], {}, { type: 'GeometryCollection', geometries: [] }, { type: 'FeatureCollection', features: [point(0, 0).geometry] }]) {
    assert.throws(() => engine.normalizeCollection(input), /GeoJSON|Feature|plain object|supported/i);
  }
  for (const geometry of [
    { type: 'Point', coordinates: [1] },
    { type: 'Point', coordinates: [1, '2'] },
    { type: 'Point', coordinates: [1, 2, 3, 4] },
    { type: 'Point', coordinates: [181, 0] },
    { type: 'Point', coordinates: [0, -91] },
    { type: 'Point', coordinates: [0, Infinity] },
    { type: 'Point', coordinates: [NaN, 0] },
    { type: 'LineString', coordinates: [[0, 0]] },
    { type: 'MultiLineString', coordinates: [] },
    { type: 'MultiPoint', coordinates: [[0, 0], [0, NaN]] },
    { type: 'MultiPolygon', coordinates: [] },
  ]) assert.throws(() => engine.normalizeCollection(geometry), /coordinates|array|finite|range/i);
  const sparse = [0, 0]; delete sparse[0];
  assert.throws(() => engine.normalizeCollection({ type: 'Point', coordinates: sparse }), /dense/i);
});

test('rings must be closed, non-degenerate, and non-self-intersecting', () => {
  for (const ring of [
    [[0, 0], [1, 0], [1, 1]],
    [[0, 0], [1, 0], [1, 1], [0, 1]],
    [[0, 0], [1, 0], [2, 0], [0, 0]],
    [[0, 0], [3, 2], [0, 3], [2, 0], [0, 0]],
  ]) assert.throws(() => engine.normalizeCollection(polygon([ring])), /ring|vertices|area|array/i);
  assert.doesNotThrow(() => engine.normalizeCollection(polygon([box(179, -1, -179, 1)])));
  assert.doesNotThrow(() => engine.normalizeCollection(polygon([box(-180, -80, 180, 80)])));
});

test('polygon holes cannot escape the exterior, cross other rings, or overlap each other', () => {
  assert.throws(() => engine.normalizeCollection(polygon([box(0, 0, 4, 4), box(5, 5, 6, 6)])), /hole outside/i);
  assert.throws(() => engine.normalizeCollection(polygon([box(0, 0, 4, 4), box(3, 3, 5, 5)])), /intersecting polygon rings/i);
  assert.throws(() => engine.normalizeCollection(polygon([box(0, 0, 4, 4), box(1, 1, 3, 3), box(2, 2, 2.5, 2.5)])), /overlapping or nested holes/i);
  assert.doesNotThrow(() => engine.normalizeCollection(polygon([box(0, 0, 4, 4), box(1, 1, 1.5, 1.5), box(2, 2, 2.5, 2.5)])));
});

test('detailed polygon exteriors and holes validate without changing supplied positions', () => {
  const ring = (radius) => {
    const positions = Array.from({ length: 2000 }, (_, i) => [radius * Math.cos(i * Math.PI / 1000), radius * Math.sin(i * Math.PI / 1000)]);
    return [...positions, positions[0]];
  };
  const data = polygon([ring(2), ring(1)]);
  assert.deepEqual(engine.normalizeCollection(data).features[0].geometry, data.geometry);
});

test('non-JSON, non-finite, circular, deeply nested and unsafe properties are rejected', () => {
  const cyclic = {}; cyclic.self = cyclic;
  let nested = 1;
  for (let i = 0; i < 10; i += 1) nested = { nested };
  for (const properties of [{ value: NaN }, { value: Infinity }, { value: undefined }, { value: 1n }, { value: () => 1 }, { value: new Date() }, cyclic, { nested }]) {
    assert.throws(() => engine.normalizeCollection(point(0, 0, properties)), /finite|JSON|circular|nested|plain object/i);
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const properties = JSON.parse(`{"${key}":{"polluted":true}}`);
    assert.throws(() => engine.normalizeCollection(point(0, 0, properties)), /unsafe/i);
  }
  assert.equal({}.polluted, undefined);
  const getter = { get value() { assert.fail('Accessors must not execute'); } };
  assert.throws(() => engine.normalizeCollection(point(0, 0, getter)), /accessor/i);
  assert.throws(() => engine.normalizeCollection(point(0, 0, Object.create({ hidden: 'not JSON' }))), /plain object/i);
});

test('feature and position limits are enforced at 10000 and 100000 respectively', () => {
  const input = collection(...Array.from({ length: 10000 }, () => point(0, 0)));
  assert.equal(engine.normalizeCollection(input).features.length, 10000);
  input.features.push(point(0, 0));
  assert.throws(() => engine.normalizeCollection(input), /10000 features/i);
  const geometry = { type: 'MultiPoint', coordinates: Array.from({ length: 100000 }, () => [0, 0]) };
  assert.equal(engine.normalizeCollection(geometry).features[0].geometry.coordinates.length, 100000);
  geometry.coordinates.push([0, 0]);
  assert.throws(() => engine.normalizeCollection(geometry), /100000 positions/i);
});

test('field discovery scans all features and conservatively distinguishes primitive data', () => {
  const data = collection(
    point(0, 0, { value: null, zero: 0, numericText: '0', flag: false, category: 'A', observedAt: '2024-02-29', year: 2024, empty: '', missing: null, mixed: '3', object: {} }),
    point(1, 1, { value: -2, zero: 1, numericText: ' 2.5e2 ', flag: true, category: 'B', observedAt: '2024-03-01T00:00:00Z', year: '2025', empty: ' ', mixed: 'unknown', object: { value: 1 } }),
  );
  const fields = engine.fieldsFor(data);
  assert.deepEqual(fields.numeric, ['numericText', 'value', 'year', 'zero']);
  assert.deepEqual(fields.categorical, ['category', 'flag', 'mixed']);
  assert.deepEqual(fields.temporal, ['observedAt', 'year']);
  assert.deepEqual(engine.fieldsFor(collection()), { numeric: [], categorical: [], temporal: [] });
});

test('invalid dates and numeric-looking junk never become numeric or temporal observations', () => {
  const data = collection(point(0, 0, { boolean: true, hex: '0x10', infinity: 'Infinity', suffix: '2m', badDay: '2024-02-30', badLeapDay: '2025-02-29', noZone: '2025-01-01T12:00:00', epoch: 1700000000, amount: 2024 }));
  assert.deepEqual(engine.fieldsFor(data).numeric, ['amount', 'epoch']);
  assert.deepEqual(engine.fieldsFor(data).temporal, []);
});

test('bounds include every geometry position and return null for no geography', () => {
  const data = collection(point(4, 5), line([[-3, 7], [8, -2]]), polygon([box(1, 1, 2, 2)]));
  assert.deepEqual(engine.boundsFor(data), [-3, -2, 8, 7]);
  assert.equal(engine.boundsFor(collection()), null);
  assert.deepEqual(engine.boundsFor(collection(point(0, 0))), [0, 0, 0, 0]);
});

test('dateline bounds use wrapped arcs but cover connected segments rather than just endpoints', () => {
  assert.deepEqual(engine.boundsFor(collection(point(179, -2), point(-179, 4))), [179, -2, -179, 4]);
  assert.deepEqual(engine.boundsFor(collection(line([[179, -2], [-179, 4]]))), [179, -2, -179, 4]);
  assert.deepEqual(engine.boundsFor(collection(line([[-170, 0], [0, 0], [170, 0]]))), [-170, 0, 170, 0]);
  assert.deepEqual(engine.boundsFor(collection(polygon([box(-180, -80, 180, 80)]))), [-180, -80, 180, 80]);
});

test('layer defaults preserve provenance, clone input, and select sensible geometry modes', () => {
  const input = { ...fixture(), source: { name: 'Supplied survey', caveat: 'Unverified accuracy.', attribution: 'Survey team' } };
  const first = engine.makeLayer(input), second = engine.makeLayer(input);
  assert.notEqual(first.id, second.id);
  assert.deepEqual(first.source, input.source);
  assert.equal(first.visualization, 'points');
  assert.equal(first.field, ''); assert.equal(first.units, ''); assert.equal(first.palette, 'olive');
  assert.equal(first.opacity, 0.75); assert.equal(first.visible, true); assert.equal(first.locked, false);
  assert.deepEqual(first.filters, { categoryField: '', category: '', min: null, max: null, viewport: false });
  assert.equal(first.timeField, ''); assert.notEqual(first.data, input);
  assert.equal(engine.makeLayer(polygon([box(0, 0, 1, 1)])).visualization, 'choropleth');
  assert.equal(engine.makeLayer(line([[0, 0], [1, 1]])).visualization, 'flow');
  assert.equal(engine.makeLayer(collection()).visualization, 'points');
  const configured = engine.makeLayer(input, { id: 'chosen', name: 'Chosen name', source: { name: 'Explicit origin', caveat: 'Explicit caveat' }, opacity: 0, visible: false, locked: true, field: 'value', units: 'm', palette: 'ocean', filters: { min: 0 }, timeField: 'observedAt' });
  assert.equal(configured.id, 'chosen'); assert.equal(configured.opacity, 0); assert.equal(configured.visible, false);
  assert.equal(configured.source.attribution, 'Survey team');
  assert.match(configured.source.caveat, /Unverified accuracy.*Explicit caveat/);
  assert.equal(configured.filters.max, null);
  assert.throws(() => engine.makeLayer(input, { visualization: 'imaginary' }), /Unsupported visualization/);
  assert.throws(() => engine.makeLayer(input, { palette: 'imaginary' }), /palette/);
  assert.throws(() => engine.makeLayer(input, { opacity: -1 }), /Opacity/);
});

test('numeric filters preserve zero and ignore missing values, exact categorical filters preserve types', () => {
  const layer = engine.makeLayer(collection(point(0, 0, { value: -1, category: 0 }), point(1, 1, { value: 0, category: false }), point(2, 2, { value: '2', category: '0' }), point(3, 3, { value: null, category: 0 }), point(4, 4, { value: false })), { field: 'value', filters: { min: 0, max: 2 } });
  assert.deepEqual(engine.filterCollection(layer).features.map((f) => f.properties.value), [0, '2']);
  layer.filters = { categoryField: 'category', category: 0 };
  assert.deepEqual(engine.filterCollection(layer).features.map((f) => f.properties.value), [-1, null]);
  layer.filters.category = false;
  assert.deepEqual(engine.filterCollection(layer).features.map((f) => f.properties.value), [0]);
  layer.filters.category = '0';
  assert.deepEqual(engine.filterCollection(layer).features.map((f) => f.properties.value), ['2']);
});

test('invalid numeric ranges fail rather than silently coercing missing data', () => {
  const layer = engine.makeLayer(fixture(), { field: 'value' });
  for (const filters of [{ min: true }, { min: '' }, { max: Infinity }, { min: 2, max: 1 }]) {
    assert.throws(() => engine.filterCollection({ ...layer, filters }), /filter|minimum/i);
  }
  assert.throws(() => engine.filterCollection({ ...layer, field: '', filters: { min: 0 } }), /numeric field/i);
  assert.throws(() => engine.filterCollection({ ...layer, field: 'missing', filters: { min: 0 } }), /no finite numeric values/i);
});

test('viewport is optional, rectangular region always applies, and filters do not mutate source', () => {
  const layer = engine.makeLayer(fixture());
  const snapshot = JSON.stringify(layer);
  assert.equal(engine.filterCollection(layer, { bounds: [-0.1, -0.1, 0.1, 0.1] }).features.length, 5);
  assert.equal(engine.filterCollection(layer, { region: [-0.1, -0.1, 0.1, 0.1] }).features.length, 1);
  assert.equal(engine.filterCollection(layer, { region: { bbox: [-0.1, -0.1, 0.1, 0.1] } }).features.length, 1);
  assert.equal(engine.filterCollection({ ...layer, filters: { viewport: true } }, { bounds: [-0.1, -0.1, 0.1, 0.1] }).features.length, 1);
  assert.equal(JSON.stringify(layer), snapshot);
  assert.throws(() => engine.filterCollection(layer, { region: [0, 0, 1] }), /bounding box/i);
  assert.throws(() => engine.filterCollection(layer, { region: [0, 2, 1, 1] }), /latitude bounds/i);
});

test('extent intersection keeps crossing lines and enclosing polygons with no vertices in the box', () => {
  const layer = engine.makeLayer(collection(
    line([[-3, 0], [3, 0]], { name: 'crosses' }),
    line([[-3, 3], [3, 3]], { name: 'outside' }),
    polygon([box(-4, -4, 4, 4)], { name: 'encloses' }),
    polygon([box(-4, -4, 4, 4), box(-2, -2, 2, 2)], { name: 'hole' }),
    polygon([box(-0.1, -0.1, 0.1, 0.1)], { name: 'inside' }),
  ));
  assert.deepEqual(engine.filterCollection(layer, { region: [-0.5, -0.5, 0.5, 0.5] }).features.map((f) => f.properties.name), ['crosses', 'encloses', 'inside']);
  assert.ok(engine.filterCollection(layer, { region: [1.9, -0.5, 2.1, 0.5] }).features.some((f) => f.properties.name === 'hole'));
});

test('extent tests do not substitute geometry bounding boxes for actual intersections', () => {
  const data = collection(line([[0, 0], [2, 2]], { name: 'diagonal' }), polygon([[[0, 0], [2, 0], [0, 2], [0, 0]]], { name: 'triangle' }));
  assert.equal(engine.filterCollection(engine.makeLayer(data), { region: [1.7, 0.7, 1.9, 0.9] }).features.length, 0);
});

test('viewport and region are intersected before checking geometry', () => {
  const layer = engine.makeLayer(line([[-10, 0], [10, 0]]), { filters: { viewport: true } });
  assert.equal(engine.filterCollection(layer, { bounds: [-5, -1, -4, 1], region: [4, -1, 5, 1] }).features.length, 0);
  assert.equal(engine.filterCollection(layer, { bounds: [-5, -1, 1, 1], region: [0, -1, 5, 1] }).features.length, 1);
  const seam = engine.makeLayer(collection(point(180, 0), point(-180, 0)), { filters: { viewport: true } });
  assert.equal(engine.filterCollection(seam, { bounds: [170, -1, 180, 1], region: [-180, -1, -170, 1] }).features.length, 2);
});

test('wrapped extents correctly test dateline points, lines, polygons, holes, and world copies', () => {
  const layer = engine.makeLayer(collection(
    point(179.5, 0, { name: 'east' }), point(-179.5, 0, { name: 'west' }), point(0, 0, { name: 'Greenwich' }),
    line([[178, 0], [-178, 0]], { name: 'crossing line' }),
    polygon([box(177, -3, -177, 3)], { name: 'crossing polygon' }),
    polygon([box(176, -4, -176, 4), box(178, -2, -178, 2)], { name: 'dateline hole' }),
  ));
  assert.deepEqual(engine.filterCollection(layer, { region: [179, -1, -179, 1] }).features.map((f) => f.properties.name), ['east', 'west', 'crossing line', 'crossing polygon']);
  assert.deepEqual(engine.filterCollection(layer, { region: [-1, -1, 1, 1] }).features.map((f) => f.properties.name), ['Greenwich']);
  assert.equal(engine.filterCollection(layer, { region: [179, -1, 181, 1] }).features.length, 4);
  assert.equal(engine.filterCollection(layer, { region: [-181, -1, -179, 1] }).features.length, 4);
  assert.equal(engine.filterCollection(layer, { region: [-540, -90, 540, 90] }).features.length, 6);
});

test('MultiPoint, MultiLineString and MultiPolygon are tested component by component', () => {
  const data = collection(
    feature({ type: 'MultiPoint', coordinates: [[20, 20], [0, 0]] }),
    feature({ type: 'MultiLineString', coordinates: [[[10, 10], [20, 20]], [[-1, 0], [1, 0]]] }),
    feature({ type: 'MultiPolygon', coordinates: [[box(10, 10, 20, 20)], [box(-1, -1, 1, 1)]] }),
  );
  assert.equal(engine.filterCollection(engine.makeLayer(data), { region: [-0.1, -0.1, 0.1, 0.1] }).features.length, 3);
});

test('time values are sorted unique normalized timestamps, without invented dates', () => {
  const layer = engine.makeLayer(collection(
    point(0, 0, { observedAt: '2026-02-01' }),
    point(0, 0, { observedAt: '2026-01-01T01:00:00+01:00' }),
    point(0, 0, { observedAt: '2026-01-01' }),
    point(0, 0, { observedAt: '2026-02-30' }),
    point(0, 0, { observedAt: null }), point(0, 0, {}),
  ), { timeField: 'observedAt' });
  assert.deepEqual(engine.temporalValues(layer), ['2026-01-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z']);
  assert.equal(engine.filterCollection(layer, { time: '2026-01-01' }).features.length, 2);
  assert.equal(engine.filterCollection(layer, { time: '2025-01-01' }).features.length, 0);
  assert.equal(engine.filterCollection(layer).features.length, 6);
  assert.throws(() => engine.filterCollection(layer, { time: '2026-02-30' }), /valid ISO/i);
  assert.throws(() => engine.filterCollection({ ...layer, timeField: '' }, { time: '2026-01-01' }), /date or year field/i);
  assert.deepEqual(engine.temporalValues({ ...layer, timeField: '' }), []);
});

test('year fields normalize numeric/string years exactly, but ordinary numbers are not dates', () => {
  const layer = engine.makeLayer(collection(point(0, 0, { surveyYear: 2025 }), point(0, 0, { surveyYear: '2024' }), point(0, 0, { surveyYear: 2025 }), point(0, 0, { surveyYear: null })), { timeField: 'surveyYear' });
  assert.deepEqual(engine.temporalValues(layer), ['2024', '2025']);
  assert.equal(engine.filterCollection(layer, { time: 2025 }).features.length, 2);
  assert.equal(engine.filterCollection(layer, { time: '2024' }).features.length, 1);
  assert.deepEqual(engine.temporalValues(engine.makeLayer(collection(point(0, 0, { amount: 2025 })), { timeField: 'amount' })), []);
});

test('metrics compute count, finite statistics and histogram from real numeric observations only', () => {
  const data = collection(...[-5, 0, '5', null, false, '', 'bad', 10].map((value) => point(0, 0, { value })));
  const result = engine.metricsFor(data, 'value');
  assert.equal(result.count, 8); assert.equal(result.validCount, 4);
  assert.equal(result.min, -5); assert.equal(result.median, 2.5); assert.equal(result.max, 10);
  assert.equal(result.mean, 2.5); assert.equal(result.sum, 10);
  assert.equal(result.histogram.reduce((sum, bin) => sum + bin.count, 0), 4);
  assert.equal(result.histogram[0].min, -5); assert.equal(result.histogram.at(-1).max, 10);
  assert.equal(engine.metricsFor(fixture(), 'value').median, 5);
});

test('missing numeric fields have null statistics, not fabricated zeros', () => {
  for (const result of [engine.metricsFor(collection(), 'value'), engine.metricsFor(fixture(), 'missing'), engine.metricsFor(fixture())]) {
    assert.equal(result.validCount, 0);
    for (const key of ['min', 'median', 'max', 'mean', 'sum']) assert.equal(result[key], null);
    assert.deepEqual(result.histogram, []);
  }
});

test('categorical metrics report typed frequencies without prototype-key hazards', () => {
  const data = collection(...['__proto__', '__proto__', 'constructor', false, false, 'false', null, ''].map((category) => point(0, 0, { category })));
  const metrics = engine.metricsFor(data, 'category');
  assert.equal(metrics.validCount, 0);
  assert.equal(metrics.categories.find((item) => item.value === '__proto__').count, 2);
  assert.equal(metrics.categories.find((item) => item.value === false).count, 2);
  assert.equal(metrics.categories.find((item) => item.value === 'false').count, 1);
});

test('constant and very large signed finite numeric values remain numerically safe', () => {
  const constant = engine.metricsFor(collection(point(0, 0, { value: 0 }), point(0, 0, { value: 0 })), 'value');
  assert.equal(constant.sum, 0); assert.equal(constant.mean, 0); assert.equal(constant.median, 0);
  assert.deepEqual(constant.histogram, [{ min: 0, max: 0, count: 2 }]);
  const signed = engine.metricsFor(collection(point(0, 0, { value: -1e308 }), point(0, 0, { value: 1e308 })), 'value');
  assert.equal(signed.mean, 0); assert.equal(signed.median, 0); assert.equal(signed.sum, 0);
  const overflow = engine.metricsFor(collection(point(0, 0, { value: 1e308 }), point(0, 0, { value: 1e308 })), 'value');
  assert.equal(overflow.mean, 1e308); assert.equal(overflow.sum, null);
});

for (const visualization of ['points', 'heatmap', 'tactical']) {
  test(`${visualization} uses observed scalar values, bounded weights, and a filter-aware legend`, () => {
    const layer = engine.makeLayer(fixture(), { visualization, field: 'value', units: 'index', filters: { min: 0 }, timeField: 'observedAt' });
    const snapshot = JSON.stringify(layer);
    const rendered = engine.renderCollection(layer);
    assertRenderable(rendered);
    assert.equal(rendered.geometryType, 'Point'); assert.equal(rendered.metrics.count, 4);
    assert.equal(rendered.legend.min, 0); assert.equal(rendered.legend.max, 20); assert.equal(rendered.legend.mid, 10);
    assert.equal(rendered.legend.title, 'value'); assert.equal(rendered.legend.unit, 'index');
    assert.deepEqual(rendered.data.features.map((f) => f.properties.__weight), [0, 1, 0.5, 0.25]);
    const temporal = engine.renderCollection(layer, { time: '2026-02-01' });
    assert.equal(temporal.legend.min, 0); assert.equal(temporal.legend.max, 5);
    assert.equal(JSON.stringify(layer), snapshot);
  });
}

test('missing values are omitted from scalar display and never turned into zero observations', () => {
  const rendered = engine.renderCollection(engine.makeLayer(collection(point(0, 0, { value: 0 }), point(1, 1, { value: null }), point(2, 2, { value: false }), point(3, 3, { value: '' })), { field: 'value' }));
  assertRenderable(rendered);
  assert.equal(rendered.inputCount, 4); assert.equal(rendered.sourceMetrics.validCount, 1);
  assert.equal(rendered.metrics.count, 1); assert.equal(rendered.legend.min, 0);
  assert.match(rendered.caveat, /3 features.*omitted.*not treated as zero/i);
});

test('point rendering uses caveated centroids and along-line midpoints, preserving actual MultiPoints', () => {
  const input = collection(polygon([box(0, 0, 2, 2)]), line([[0, 0], [4, 0]]), feature({ type: 'MultiPoint', coordinates: [[5, 5], [6, 6]] }));
  const rendered = engine.renderCollection(engine.makeLayer(input, { visualization: 'points' }));
  assertRenderable(rendered);
  assert.deepEqual(rendered.data.features.map((f) => f.geometry.coordinates), [[1, 1], [2, 0], [5, 5], [6, 6]]);
  assert.match(rendered.caveat, /centroids.*approximate/); assert.match(rendered.caveat, /along-line midpoints/);
  assert.equal(rendered.inputCount, 3); assert.equal(rendered.metrics.count, 4);
});

test('polygon representatives correctly weight holes and cross the antimeridian locally', () => {
  const first = engine.renderCollection(engine.makeLayer(polygon([box(0, 0, 4, 4), box(0.5, 0.5, 1.5, 1.5)]), { visualization: 'points' }));
  approximately(first.data.features[0].geometry.coordinates[0], 31 / 15);
  approximately(first.data.features[0].geometry.coordinates[1], 31 / 15);
  const dateline = engine.renderCollection(engine.makeLayer(polygon([box(179, -1, -179, 1)]), { visualization: 'points' }));
  assert.ok(Math.abs(dateline.data.features[0].geometry.coordinates[0]) === 180);
  assert.equal(dateline.data.features[0].geometry.coordinates[1], 0);
});

test('density aggregates actual feature counts, is bounded, and ignores selected scalar values explicitly', () => {
  const data = collection(point(0, 0, { value: -100 }), point(0, 0, { value: 0 }), point(1, 1, { value: 100 }), feature({ type: 'MultiPoint', coordinates: [[0, 0], [0, 0], [1, 1]] }, { value: 50 }));
  const rendered = engine.renderCollection(engine.makeLayer(data, { visualization: 'density', field: 'value' }));
  assertRenderable(rendered);
  assert.equal(rendered.geometryType, 'Polygon'); assert.ok(rendered.data.features.length <= 24 * 24);
  assert.deepEqual(rendered.data.features.map((f) => f.properties.count).sort(), [2, 3]);
  assert.equal(rendered.legend.unit, 'features/cell'); assert.match(rendered.caveat, /not area-normalized/);
  assert.match(rendered.caveat, /do not encode the selected/);
});

for (const visualization of ['choropleth', 'extrusion']) {
  test(`${visualization} retains real polygons and makes explicitly count-based grids for points`, () => {
    const data = collection(polygon([box(0, 0, 1, 1)], { value: 4 }), polygon([box(2, 2, 3, 3)], { value: 12 }));
    const rendered = engine.renderCollection(engine.makeLayer(data, { visualization, field: 'value', units: 'index' }));
    assertRenderable(rendered);
    assert.deepEqual(rendered.data.features.map((f) => f.geometry), data.features.map((f) => f.geometry));
    assert.equal(rendered.legend.min, 4); assert.equal(rendered.legend.max, 12);
    const grid = engine.renderCollection(engine.makeLayer(fixture(), { visualization, field: 'value', units: 'm' }));
    assertRenderable(grid); assert.equal(grid.legend.unit, 'features/cell');
    assert.equal(grid.metrics.sum, 5);
    if (visualization === 'extrusion') assert.match(grid.caveat, /normalized.*visual index/);
  });
}

test('only explicitly meter-valued polygon extrusions use supplied heights', () => {
  const data = collection(...[-10, 0, 2000].map((value, i) => polygon([box(i, 0, i + 0.5, 0.5)], { value })));
  const layer = engine.makeLayer(data, { visualization: 'extrusion', field: 'value', units: 'm' });
  const meters = engine.renderCollection(layer);
  assertRenderable(meters);
  assert.deepEqual(meters.data.features.map((f) => f.properties.__height), [0, 0, 2000]);
  assert.equal(meters.data.features[0].properties.__value, -10);
  assert.match(meters.caveat, /supplied meter field.*negative heights are clamped/);
  const index = engine.renderCollection({ ...layer, units: 'index' });
  assert.equal(index.data.features.at(-1).properties.__height, 1500);
  assert.match(index.caveat, /not measured elevation/);
});

test('flow retains only supplied real lines and never synthesizes connections from points', () => {
  const geometry = { type: 'MultiLineString', coordinates: [[[179, 0], [-179, 0]], [[1, 1], [2, 2]]] };
  const data = collection(point(0, 0, { value: 100 }), feature(geometry, { value: -5 }), line([[3, 3], [4, 4]], { value: 10 }));
  const rendered = engine.renderCollection(engine.makeLayer(data, { visualization: 'flow', field: 'value' }));
  assertRenderable(rendered); assert.equal(rendered.geometryType, 'LineString');
  assert.equal(rendered.metrics.count, 2); assert.deepEqual(rendered.data.features[0].geometry, geometry);
  assert.match(rendered.caveat, /no routes, movement, or direction are inferred/);
  assert.throws(() => engine.renderCollection(engine.makeLayer(fixture(), { visualization: 'flow' })), /Flow requires existing/);
});

for (const visualization of ['contours', 'surface']) {
  test(`${visualization} computes bounded approximate scalar geometry with an honest value legend`, () => {
    const layer = engine.makeLayer(fixture(), { visualization, field: 'value', units: 'index' });
    const snapshot = JSON.stringify(layer);
    const rendered = engine.renderCollection(layer);
    assertRenderable(rendered);
    assert.ok(rendered.data.features.length > 0);
    assert.ok(rendered.data.features.length <= (visualization === 'surface' ? 256 : 3584));
    assert.equal(rendered.geometryType, visualization === 'surface' ? 'Polygon' : 'LineString');
    assert.ok(rendered.legend.min >= -10 && rendered.legend.max <= 20);
    assert.ok(rendered.data.features.every((f) => f.properties.__estimated === true));
    assert.match(rendered.caveat, /inverse-distance interpolation.*convex hull.*Not measured contours or surveyed terrain/);
    assert.equal(JSON.stringify(layer), snapshot);
    const repeated = engine.renderCollection(layer);
    assert.deepEqual(rendered, repeated);
  });
}

const cityRectangles = [
  ['Delhi', 77.19, 28.60, 77.24, 28.66],
  ['Sydney', 151.20, -33.91, 151.25, -33.85],
  ['New York', -74.02, 40.70, -73.97, 40.76],
  ['Buenos Aires', -58.46, -34.64, -58.41, -34.58],
];

for (const [city, west, south, east, north] of cityRectangles) {
  for (const visualization of ['contours', 'surface']) {
    test(`${visualization} preserves the full nonconstant ${city} rectangle at geographic coordinates`, () => {
      const data = scalarRectangle(west, south, east, north);
      const rendered = engine.renderCollection(engine.makeLayer(data, { visualization, field: 'value' }));
      assertRenderable(rendered);
      assert.ok(rendered.data.features.length > 0, `${city} must contain interpolated geometry`);
      assert.ok(rendered.legend.min < rendered.legend.max);
      assert.doesNotMatch(rendered.caveat, /No display geometry remains/);
      if (visualization === 'surface') assert.equal(rendered.data.features.length, 256);
      else assert.deepEqual([...new Set(rendered.data.features.map((f) => f.properties.__value))].sort((a, b) => a - b), [18.75, 27.5, 36.25, 45, 53.75, 62.5, 71.25]);
      const [w, s, e, n] = engine.boundsFor(rendered.data);
      assert.ok(w >= west - 1e-9 && e <= east + 1e-9 && s >= south - 1e-9 && n <= north + 1e-9);
    });
  }
}

test('city density grids do not move west-edge samples into east-edge cells', () => {
  for (const [city, west, south, east, north] of cityRectangles) {
    const rendered = engine.renderCollection(engine.makeLayer(scalarRectangle(west, south, east, north), { visualization: 'density' }));
    assertRenderable(rendered);
    assert.equal(rendered.data.features.length, 4, `${city} must retain four separately occupied corner cells`);
    assert.deepEqual(rendered.data.features.map((f) => f.properties.count), [1, 1, 1, 1]);
    const [w, , e] = engine.boundsFor(rendered.data);
    approximately(w, west);
    approximately(e, east);
  }
});

for (const visualization of ['contours', 'surface']) {
  test(`${visualization} is equivalent under longitude shifts, including crossing the dateline`, () => {
    const data = scalarRectangle(0, 28.60, 0.05, 28.66);
    const reference = engine.renderCollection(engine.makeLayer(data, { visualization, field: 'value' }));
    const positions = (coordinates) => typeof coordinates[0] === 'number' ? [coordinates] : coordinates.flatMap(positions);
    for (const shift of [77.19, -74.02, 151.20, -179.99, 179.99]) {
      const moved = collection(...data.features.map((f) => {
        const longitude = f.geometry.coordinates[0] + shift;
        return point(longitude > 180 ? longitude - 360 : longitude, f.geometry.coordinates[1], { ...f.properties });
      }));
      const rendered = engine.renderCollection(engine.makeLayer(moved, { visualization, field: 'value' }));
      assertRenderable(rendered);
      assert.equal(rendered.data.features.length, reference.data.features.length, `Feature count changed after a ${shift}-degree longitude shift`);
      rendered.data.features.forEach((f, i) => {
        const original = reference.data.features[i];
        assert.equal(f.id, original.id);
        for (const property of ['__value', '__weight', '__height']) approximately(f.properties[property], original.properties[property], 1e-7);
        const shiftedPositions = positions(f.geometry.coordinates).map(([lon, lat]) => [lon + Math.round((shift + 0.025 - lon) / 360) * 360 - shift, lat]);
        shiftedPositions.forEach(([lon, lat]) => assert.ok(lon >= -1e-9 && lon <= 0.05 + 1e-9 && lat >= 28.60 - 1e-9 && lat <= 28.66 + 1e-9));
        if (f.geometry.type === original.geometry.type) {
          const referencePositions = positions(original.geometry.coordinates);
          assert.equal(shiftedPositions.length, referencePositions.length);
          shiftedPositions.forEach(([lon, lat], index) => {
            approximately(lon, referencePositions[index][0]); approximately(lat, referencePositions[index][1]);
          });
        }
      });
    }
  });
}

test('marching squares creates interpolated scalar level crossings, not fabricated parallel lines', () => {
  const rendered = engine.renderCollection(engine.makeLayer(fixture(), { visualization: 'contours', field: 'value' }));
  const levels = new Set(rendered.data.features.map((f) => f.properties.__value));
  assert.equal(levels.size, 7);
  const segments = rendered.data.features.flatMap((f) => f.geometry.type === 'LineString' ? [f.geometry.coordinates] : f.geometry.coordinates);
  assert.ok(segments.some(([a, b]) => a[0] !== b[0] && a[1] !== b[1]));
  assert.ok(segments.some(([a, b]) => !Number.isInteger(a[0] * 16) || !Number.isInteger(b[0] * 16)));
});

test('interpolation excludes area outside the sample convex hull and averages duplicate positions', () => {
  const data = collection(point(0, 0, { value: 0 }), point(0, 0, { value: 10 }), point(1, 0, { value: 5 }), point(0, 1, { value: 5 }));
  const surface = engine.renderCollection(engine.makeLayer(data, { visualization: 'surface', field: 'value' }));
  assertRenderable(surface);
  assert.ok(surface.data.features.length > 0 && surface.data.features.length < 256);
  surface.data.features.forEach((f) => {
    approximately(f.properties.__value, 5);
    f.geometry.coordinates[0].forEach(([x, y]) => assert.ok(x + y <= 1 + 1e-9));
  });
  assert.match(surface.caveat, /1 duplicate sample positions were averaged/);
});

test('surface heights remain visual indexes even if scalar values have meter units', () => {
  const surface = engine.renderCollection(engine.makeLayer(fixture(), { visualization: 'surface', field: 'value', units: 'm' }));
  assert.equal(surface.legend.unit, 'm');
  assert.equal(Math.max(...surface.data.features.map((f) => f.properties.__height)), 1500);
  assert.match(surface.caveat, /normalized.*visual index.*not measured elevation/);
});

test('constant fields remain safe across visualizations and do not invent contour variation', () => {
  const data = fixture(); data.features.forEach((f) => { f.properties.value = -3; });
  for (const visualization of ['points', 'heatmap', 'tactical', 'surface']) {
    const rendered = engine.renderCollection(engine.makeLayer(data, { visualization, field: 'value' }));
    assertRenderable(rendered);
    rendered.data.features.forEach((f) => { approximately(f.properties.__value, -3); assert.equal(f.properties.__weight, 0.5); assert.equal(f.properties.__height, 750); });
  }
  const contours = engine.renderCollection(engine.makeLayer(data, { visualization: 'contours', field: 'value' }));
  assertRenderable(contours); assert.equal(contours.data.features.length, 0);
  assert.equal(contours.legend.min, null); assert.match(contours.caveat, /Constant scalar field.*no isolines/);
});

test('all-signed and extreme finite fields receive finite normalized renderer values', () => {
  for (const values of [[-9, -5, -1], [-1e308, 0, 1e308]]) {
    const rendered = engine.renderCollection(engine.makeLayer(collection(...values.map((value, i) => point(i, i, { value }))), { field: 'value' }));
    assertRenderable(rendered);
    assert.equal(rendered.data.features[0].properties.__weight, 0);
    assert.equal(rendered.data.features.at(-1).properties.__weight, 1);
  }
});

test('interpolation rejects missing, categorical, insufficient, coincident, and collinear samples', () => {
  for (const visualization of ['contours', 'surface']) {
    assert.throws(() => engine.renderCollection(engine.makeLayer(fixture(), { visualization })), /numeric field/i);
    assert.throws(() => engine.renderCollection(engine.makeLayer(fixture(), { visualization, field: 'category' })), /no finite numeric/i);
    assert.throws(() => engine.renderCollection(engine.makeLayer(collection(point(0, 0, { value: 0 }), point(1, 1, { value: 1 })), { visualization, field: 'value' })), /three distinct, non-collinear/);
    assert.throws(() => engine.renderCollection(engine.makeLayer(collection(...[0, 1, 2].map((value) => point(value, value, { value }))), { visualization, field: 'value' })), /non-collinear/);
    assert.throws(() => engine.renderCollection(engine.makeLayer(collection(...[0, 1, 2].map((value) => point(0, 0, { value }))), { visualization, field: 'value' })), /non-collinear/);
    assert.throws(() => engine.renderCollection(engine.makeLayer(polygon([box(0, 0, 1, 1)], { value: 3 }), { visualization, field: 'value' })), /supplied point geometry/);
    assert.throws(() => engine.renderCollection(engine.makeLayer(collection(point(0, 0), polygon([box(0, 0, 1, 1)], { value: 3 })), { visualization, field: 'value' })), /points with finite numeric values/);
  }
});

test('unsupported visuals, unavailable fields and incompatible geometries fail explicitly', () => {
  const layer = engine.makeLayer(fixture());
  assert.throws(() => engine.renderCollection({ ...layer, visualization: 'viewshed' }), /Unsupported visualization/);
  assert.throws(() => engine.renderCollection({ ...layer, field: 'missing' }), /no finite numeric values/);
  assert.throws(() => engine.renderCollection({ ...layer, palette: 'missing' }), /Unknown palette/);
  assert.throws(() => engine.renderCollection({ ...layer, palette: '__proto__' }), /Unknown palette/);
  for (const visualization of ['choropleth', 'extrusion']) assert.throws(() => engine.renderCollection(engine.makeLayer(line([[0, 0], [1, 1]]), { visualization })), /requires polygons or point data/);
});

test('empty filters return honest empty output and null legends for every compatible mode', () => {
  for (const visualization of Object.keys(engine.VISUALIZATIONS)) {
    const data = visualization === 'flow' ? line([[0, 0], [1, 1]], { value: 0 }) : fixture();
    const layer = engine.makeLayer(data, { visualization, field: 'value', filters: { min: 1000 } });
    const rendered = engine.renderCollection(layer);
    assertRenderable(rendered);
    assert.equal(rendered.inputCount, 0); assert.equal(rendered.data.features.length, 0);
    assert.equal(rendered.legend.min, null); assert.equal(rendered.legend.mid, null); assert.equal(rendered.legend.max, null);
    assert.match(rendered.caveat, /No display geometry remains/);
  }
});

test('generated dateline grids and interpolated geometry stay local and validate as GeoJSON', () => {
  const data = collection(point(179, 0, { value: -2 }), point(-179, 0, { value: 0 }), point(-179, 1, { value: 4 }), point(179, 1, { value: 2 }));
  for (const visualization of ['density', 'choropleth', 'extrusion', 'contours', 'surface']) {
    const rendered = engine.renderCollection(engine.makeLayer(data, { visualization, field: 'value' }));
    assertRenderable(rendered);
    assert.ok(rendered.data.features.length > 0);
    const bounds = engine.boundsFor(rendered.data);
    assert.ok(bounds[0] > 178 && bounds[2] < -178, `${visualization} must remain near the dateline: ${bounds}`);
  }
});

test('density supports coincident points, polar bounds, and deterministic feature counts', () => {
  for (const [lon, lat] of [[0, 0], [180, 90], [-180, -90]]) {
    const layer = engine.makeLayer(collection(point(lon, lat), point(lon, lat)), { visualization: 'density' });
    const rendered = engine.renderCollection(layer);
    assertRenderable(rendered);
    assert.equal(rendered.data.features.length, 1); assert.equal(rendered.metrics.sum, 2);
  }
});

for (const template of ['infrastructure', 'logistics', 'risk', 'movement']) {
  test(`${template} examples are deterministic, varied over three dates, and explicitly synthetic`, () => {
    const first = engine.exampleCollection(template), second = engine.exampleCollection(template);
    assert.deepEqual(first, second);
    assert.equal(first.synthetic, true); assert.equal(first.metadata.synthetic, true);
    assert.equal(first.metadata.template, template);
    assert.match(first.source.caveat, /Illustrative example, not live data/);
    assert.match(first.source.caveat, /fictional examples.*not measured journeys or real fleet/);
    assert.ok(first.features.length >= 9);
    first.features.forEach((f) => { assert.equal(f.properties.synthetic, true); assert.ok(Number.isFinite(f.properties.value)); });
    assert.equal(new Set(first.features.map((f) => f.properties.category)).size, 3);
    assert.equal(engine.temporalValues(engine.makeLayer(first, { timeField: 'observedAt' })).length, 3);
    assert.equal(new Set(first.features.map((f) => f.geometry.type)).size, 1);
    assert.equal(first.features[0].geometry.type, template === 'risk' ? 'Polygon' : template === 'movement' ? 'LineString' : 'Point');
    const layer = engine.makeLayer(first, { source: { name: 'Caller label', caveat: 'Caller caveat' } });
    assert.match(layer.source.caveat, /synthetic/i);
    assertRenderable(engine.renderCollection(layer));
  });
}

test('examples default safely and honor arbitrary valid centers including poles and the dateline', () => {
  assert.deepEqual(engine.exampleCollection('unknown'), engine.exampleCollection('infrastructure'));
  for (const center of [[179.99, 0], [-179.99, 0], [0, 90], [0, -90]]) {
    for (const template of ['infrastructure', 'logistics', 'risk', 'movement']) assert.doesNotThrow(() => engine.normalizeCollection(engine.exampleCollection(template, center)));
  }
  for (const center of [[181, 0], [0, 91], [0, NaN], ['0', 0], []]) assert.throws(() => engine.exampleCollection('risk', center), /valid.*position/);
});
