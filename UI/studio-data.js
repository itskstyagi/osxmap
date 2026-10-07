// Browser/Node data engine. No network, DOM, map instance, or package dependencies.
export const PALETTES = {
  monochrome: { label: 'Monochrome', colors: ['#d7dad6', '#858b85', '#252b28'] },
  olive: { label: 'Olive', colors: ['#e3e8c5', '#9caa69', '#52633d', '#233c30'] },
  thermal: { label: 'Thermal', colors: ['#ffe6a3', '#f7aa58', '#d45f44', '#702b46'] },
  ocean: { label: 'Ocean', colors: ['#d4efec', '#77c6c2', '#368ba5', '#234b78'] },
  violet: { label: 'Violet', colors: ['#e9dff2', '#b69acb', '#8167a6', '#493c74'] },
};

export const VISUALIZATIONS = {
  points: { label: 'Points', description: 'Supplied points or explicitly approximate representative positions.' },
  density: { label: 'Density', description: 'Feature counts in a bounded geographic square grid, not population density.' },
  heatmap: { label: 'Heatmap', description: 'Relative numeric weights at supplied or representative point positions.' },
  choropleth: { label: 'Choropleth', description: 'Values on supplied polygons, or feature-count cells for point data.' },
  contours: { label: 'Contours', description: 'Marching-squares isolines of an approximate inverse-distance scalar interpolation.' },
  extrusion: { label: 'Extrusion', description: 'Supplied polygons or count cells with explicitly labeled visual height.' },
  flow: { label: 'Flow', description: 'Existing line geometry only; no inferred routes or journeys.' },
  surface: { label: 'Surface', description: 'Interpolated scalar cells with normalized visual height, not surveyed terrain.' },
  tactical: { label: 'Tactical', description: 'Point symbols for supplied features; no inferred operational status.' },
};

const MAX_FEATURES = 10000;
const MAX_POSITIONS = 100000;
const EPSILON = 1e-10;
const TYPES = new Set(['Point', 'MultiPoint', 'LineString', 'MultiLineString', 'Polygon', 'MultiPolygon']);
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const SYNTHETIC_NOTE = 'Illustrative example, not live data. Locations, values, categories, and dates are synthetic.';
let nextId = 0;

function record(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    throw new Error(`${path} must be a plain object.`);
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (UNSAFE_KEYS.has(key)) throw new Error(`${path} contains unsafe property "${key}".`);
    if (descriptor.get || descriptor.set) throw new Error(`${path}.${key} must not be an accessor.`);
  }
  return value;
}

function array(value, path, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) throw new Error(`${path} requires an array with at least ${minimum} entries.`);
  for (let i = 0; i < value.length; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, i);
    if (!descriptor || descriptor.get || descriptor.set) throw new Error(`${path} must be a dense data array.`);
  }
  return value;
}

function cloneValue(value, path, state, depth = 0) {
  if (++state.values > 500000) throw new Error('Properties are oversized (maximum 500000 values).');
  if (depth > 8) throw new Error(`${path} is too deeply nested (maximum depth 8).`);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain finite numbers.`);
    return value;
  }
  if (typeof value === 'string') {
    state.characters += value.length;
    if (state.characters > 10000000) throw new Error('Property text is oversized (maximum 10000000 characters).');
    return value;
  }
  if (!value || typeof value !== 'object') throw new Error(`${path} contains a non-JSON value.`);
  if (state.seen.has(value)) throw new Error(`${path} contains a circular reference.`);
  state.seen.add(value);
  let copy;
  if (Array.isArray(value)) {
    copy = array(value, path).map((item, i) => cloneValue(item, `${path}[${i}]`, state, depth + 1));
  } else {
    copy = {};
    for (const [key, item] of Object.entries(record(value, path))) {
      copy[key] = cloneValue(item, `${path}.${key}`, state, depth + 1);
    }
  }
  state.seen.delete(value);
  return copy;
}

function wrapLongitude(value) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}

function longitudeNear(value, reference) {
  // Center the longitude band: roundoff just below a western bound must not add 360.
  return value + Math.round((reference - value) / 360) * 360;
}

function longitudeDelta(a, b) {
  const delta = b - a;
  // Explicit -180/+180 edges can describe a world-width polygon.
  if (Math.abs(delta) === 360) return delta;
  return delta > 180 ? delta - 360 : delta < -180 ? delta + 360 : delta;
}

function unwrapPath(path) {
  let longitude = path[0][0];
  return path.map((position, i) => {
    if (i) longitude += longitudeDelta(path[i - 1][0], position[0]);
    return [longitude, position[1]];
  });
}

function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function onSegment(point, a, b) {
  return Math.abs(cross(a, b, point)) <= EPSILON &&
    point[0] >= Math.min(a[0], b[0]) - EPSILON && point[0] <= Math.max(a[0], b[0]) + EPSILON &&
    point[1] >= Math.min(a[1], b[1]) - EPSILON && point[1] <= Math.max(a[1], b[1]) + EPSILON;
}

function segmentsIntersect(a, b, c, d) {
  const abC = cross(a, b, c), abD = cross(a, b, d), cdA = cross(c, d, a), cdB = cross(c, d, b);
  return ((abC > 0 && abD < 0 || abC < 0 && abD > 0) && (cdA > 0 && cdB < 0 || cdA < 0 && cdB > 0)) ||
    onSegment(c, a, b) || onSegment(d, a, b) || onSegment(a, c, d) || onSegment(b, c, d);
}

function ringArea(ring) {
  const origin = ring[0];
  let area = 0;
  for (let i = 1; i < ring.length - 1; i += 1) area += cross(origin, ring[i], ring[i + 1]);
  return area / 2;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j], b = ring[i];
    if (onSegment(point, a, b)) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) &&
        point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function validateRing(ring, path) {
  const first = ring[0], last = ring[ring.length - 1];
  if (first.length !== last.length || first.some((value, i) => value !== last[i])) throw new Error(`${path} must be a closed polygon ring.`);
  const unwrapped = unwrapPath(ring);
  if (Math.abs(unwrapped.at(-1)[0] - unwrapped[0][0]) > EPSILON) throw new Error(`${path} winds around the globe; split this polygon at the antimeridian.`);
  if (new Set(ring.slice(0, -1).map((p) => `${p[0]},${p[1]}`)).size < 3 || ringArea(unwrapped) === 0) {
    throw new Error(`${path} must enclose a nonzero area with at least three distinct vertices.`);
  }
}

function validateRingIntersections(rings, path) {
  const edges = rings.flatMap((ring, ringIndex) => ring.slice(1).map((b, i) => ({ a: ring[i], b, i, ringIndex, length: ring.length - 1 })));
  const spans = edges.reduce((sum, edge) => [sum[0] + Math.abs(edge.a[0] - edge.b[0]), sum[1] + Math.abs(edge.a[1] - edge.b[1])], [0, 0]);
  const axis = spans[0] < spans[1] ? 0 : 1;
  for (const edge of edges) { edge.start = Math.min(edge.a[axis], edge.b[axis]); edge.end = Math.max(edge.a[axis], edge.b[axis]); }
  const active = [];
  // Sweep all rings together, so a detailed exterior/hole pair is not tested all-pairs.
  for (const edge of edges.sort((a, b) => a.start - b.start)) {
    for (let j = active.length - 1; j >= 0; j -= 1) {
      const other = active[j];
      if (other.end < edge.start - EPSILON) { active.splice(j, 1); continue; }
      if (edge.ringIndex === other.ringIndex && (Math.abs(edge.i - other.i) === 1 || Math.abs(edge.i - other.i) === edge.length - 1)) continue;
      if (segmentsIntersect(edge.a, edge.b, other.a, other.b)) throw new Error(edge.ringIndex === other.ringIndex ? `${path} has a self-intersecting polygon ring.` : `${path} has intersecting polygon rings.`);
    }
    active.push(edge);
  }
}

function cloneGeometry(value, path, state) {
  record(value, path);
  if (!TYPES.has(value.type)) throw new Error(`${path} has unsupported geometry type "${value.type}".`);
  const position = (item, label) => {
    array(item, label, 2);
    if (++state.positions > MAX_POSITIONS) throw new Error(`GeoJSON exceeds ${MAX_POSITIONS} positions.`);
    if (item.length > 3 || !item.every((number) => typeof number === 'number' && Number.isFinite(number))) {
      throw new Error(`${label} must contain two or three finite coordinate numbers.`);
    }
    if (item[0] < -180 || item[0] > 180 || item[1] < -90 || item[1] > 90) throw new Error(`${label} longitude/latitude is out of range.`);
    return [...item];
  };
  const positions = (items, label, minimum) => array(items, label, minimum).map((p, i) => position(p, `${label}[${i}]`));
  const polygon = (items, label) => {
    const rings = array(items, label, 1).map((item, i) => {
      const ring = positions(item, `${label}[${i}]`, 4);
      validateRing(ring, `${label}[${i}]`);
      return ring;
    });
    const unwrapped = polygonRings(rings);
    validateRingIntersections(unwrapped, label);
    const boxes = unwrapped.map((ring) => ring.reduce((bbox, [x, y]) => [Math.min(bbox[0], x), Math.min(bbox[1], y), Math.max(bbox[2], x), Math.max(bbox[3], y)], [Infinity, Infinity, -Infinity, -Infinity]));
    for (let i = 1; i < unwrapped.length; i += 1) {
      const hole = unwrapped[i];
      if (!pointInRing(hole[0], unwrapped[0])) throw new Error(`${label}[${i}] is a hole outside its exterior polygon ring.`);
      for (let j = 1; j < i; j += 1) {
        if (boxes[i][0] > boxes[j][2] || boxes[i][2] < boxes[j][0] || boxes[i][1] > boxes[j][3] || boxes[i][3] < boxes[j][1]) continue;
        const other = unwrapped[j];
        if (pointInRing(hole[0], other) || pointInRing(other[0], hole)) throw new Error(`${label} has overlapping or nested holes.`);
      }
    }
    return rings;
  };
  const label = `${path}.coordinates`;
  let coordinates;
  switch (value.type) {
    case 'Point': coordinates = position(value.coordinates, label); break;
    case 'MultiPoint': coordinates = positions(value.coordinates, label, 1); break;
    case 'LineString': coordinates = positions(value.coordinates, label, 2); break;
    case 'MultiLineString': coordinates = array(value.coordinates, label, 1).map((line, i) => positions(line, `${label}[${i}]`, 2)); break;
    case 'Polygon': coordinates = polygon(value.coordinates, label); break;
    case 'MultiPolygon': coordinates = array(value.coordinates, label, 1).map((poly, i) => polygon(poly, `${label}[${i}]`)); break;
  }
  return { type: value.type, coordinates };
}

export function normalizeCollection(input) {
  record(input, 'GeoJSON');
  const state = { positions: 0, values: 0, characters: 0, seen: new WeakSet() };
  const foreign = (value, excluded) => Object.fromEntries(Object.entries(value)
    .filter(([key]) => !excluded.includes(key))
    .map(([key, item]) => [key, cloneValue(item, `GeoJSON.${key}`, state)]));
  const feature = (value, i) => {
    const path = `Feature ${i + 1}`;
    record(value, path);
    if (value.type !== 'Feature') throw new Error(`${path} must have type Feature.`);
    const properties = value.properties == null ? {} : cloneValue(record(value.properties, `${path}.properties`), `${path}.properties`, state);
    const copy = { ...foreign(value, ['type', 'geometry', 'properties', 'id', 'bbox']), type: 'Feature', geometry: cloneGeometry(value.geometry, `${path}.geometry`, state), properties };
    if (Object.hasOwn(value, 'id')) {
      if (!(typeof value.id === 'string' || typeof value.id === 'number' && Number.isFinite(value.id))) throw new Error(`${path}.id must be a string or finite number.`);
      copy.id = value.id;
    }
    return copy;
  };
  let features;
  if (input.type === 'FeatureCollection') {
    if (input.features?.length > MAX_FEATURES) throw new Error(`GeoJSON exceeds ${MAX_FEATURES} features.`);
    array(input.features, 'GeoJSON.features');
    features = input.features.map(feature);
  } else if (input.type === 'Feature') {
    features = [feature(input, 0)];
  } else if (TYPES.has(input.type)) {
    features = [{ type: 'Feature', geometry: cloneGeometry(input, 'Geometry', state), properties: {} }];
  } else {
    throw new Error('Expected a GeoJSON FeatureCollection, Feature, or supported Geometry.');
  }
  return { ...foreign(input, ['type', 'features', 'geometry', 'coordinates', 'properties', 'id', 'bbox']), type: 'FeatureCollection', features };
}

function featuresOf(collection) {
  if (collection?.type !== 'FeatureCollection' || !Array.isArray(collection.features)) throw new Error('Expected a normalized FeatureCollection.');
  return collection.features;
}

function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function missing(value) {
  return value == null || typeof value === 'string' && value.trim() === '';
}

function normalizedTime(value, field) {
  if (typeof value === 'string') value = value.trim();
  if (/(?:^|[_\s-])year(?:$|[_\s-])|year$/i.test(field) && /^\d{4}$/.test(String(value)) && Number(value) >= 1000) return String(value);
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2}))?$/i);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, , zone] = match;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (+month < 1 || +month > 12 || +day < 1 || +day > days[+month - 1] || +hour > 23 || +minute > 59 || +second > 59) return null;
  if (zone && zone.toUpperCase() !== 'Z' && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) return null;
  const timestamp = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function fieldsFor(collection) {
  const values = new Map();
  for (const feature of featuresOf(collection)) {
    for (const [key, value] of Object.entries(feature.properties || {})) {
      if (missing(value)) continue;
      if (!values.has(key)) values.set(key, []);
      values.get(key).push(value);
    }
  }
  const fields = { numeric: [], categorical: [], temporal: [] };
  for (const key of [...values.keys()].sort()) {
    const items = values.get(key);
    const isNumeric = items.every((value) => numeric(value) !== null);
    const isTemporal = items.every((value) => normalizedTime(value, key) !== null);
    if (isNumeric) fields.numeric.push(key);
    if (isTemporal) fields.temporal.push(key);
    if (!isNumeric && !isTemporal && items.some((value) => ['string', 'number', 'boolean'].includes(typeof value))) fields.categorical.push(key);
  }
  return fields;
}

function pathsFor(geometry) {
  switch (geometry.type) {
    case 'Point': return [[geometry.coordinates]];
    case 'MultiPoint': return geometry.coordinates.map((position) => [position]);
    case 'LineString': return [geometry.coordinates];
    case 'MultiLineString': case 'Polygon': return geometry.coordinates;
    case 'MultiPolygon': return geometry.coordinates.flat();
    default: throw new Error(`Unsupported geometry type "${geometry.type}".`);
  }
}

export function boundsFor(collection) {
  let south = Infinity, north = -Infinity;
  const intervals = [];
  const arc = (a, b) => {
    const end = a + longitudeDelta(a, b);
    const length = Math.abs(end - a);
    if (length >= 360) { intervals.push([0, 360]); return; }
    const start = wrapLongitude(Math.min(a, end)) + 180;
    if (start + length <= 360) intervals.push([start, start + length]);
    else intervals.push([start, 360], [0, start + length - 360]);
  };
  for (const feature of featuresOf(collection)) {
    for (const path of pathsFor(feature.geometry)) {
      for (let i = 0; i < path.length; i += 1) {
        south = Math.min(south, path[i][1]); north = Math.max(north, path[i][1]);
        arc(path[i][0], path[Math.max(0, i - 1)][0]);
      }
    }
  }
  if (!intervals.length) return null;
  intervals.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const interval of intervals) {
    const last = merged.at(-1);
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1]);
    else merged.push([...interval]);
  }
  let gap = -1, west = -180, east = 180;
  for (let i = 0; i < merged.length; i += 1) {
    const next = merged[(i + 1) % merged.length][0] + (i === merged.length - 1 ? 360 : 0);
    if (next - merged[i][1] > gap) {
      gap = next - merged[i][1];
      west = wrapLongitude(next - 180); east = wrapLongitude(merged[i][1] - 180);
    }
  }
  return gap <= EPSILON ? [-180, south, 180, north] : [west, south, east, north];
}

export function makeLayer(collection, options = {}) {
  const data = normalizeCollection(collection);
  const types = new Set(data.features.map((feature) => feature.geometry.type.replace('Multi', '')));
  const visualization = options.visualization ?? (types.size === 1 && types.has('Polygon') ? 'choropleth' : types.size === 1 && types.has('LineString') ? 'flow' : 'points');
  if (!Object.hasOwn(VISUALIZATIONS, visualization)) throw new Error(`Unsupported visualization "${visualization}".`);
  const palette = options.palette ?? 'olive';
  if (!Object.hasOwn(PALETTES, palette)) throw new Error(`Unknown palette "${palette}".`);
  const opacity = options.opacity ?? 0.75;
  if (typeof opacity !== 'number' || !Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('Opacity must be a number from 0 to 1.');
  const asSource = (source) => typeof source === 'string' ? { name: source } : source && typeof source === 'object' ? source : {};
  const inherited = asSource(data.source ?? data.metadata?.source);
  const provided = asSource(options.source);
  const synthetic = data.synthetic === true || data.metadata?.synthetic === true || data.features.some((feature) => feature.properties.synthetic === true);
  const caveats = [inherited.caveat, data.caveat, data.metadata?.caveat, provided.caveat, synthetic ? SYNTHETIC_NOTE : ''].filter((value) => typeof value === 'string' && value);
  const source = {
    name: String(provided.name || inherited.name || 'User-provided GeoJSON'),
    caveat: [...new Set(caveats)].join(' ') || 'Source and accuracy are user supplied, not independently verified.',
    attribution: String(provided.attribution ?? inherited.attribution ?? data.attribution ?? data.metadata?.attribution ?? ''),
  };
  for (const key of ['url', 'retrievedAt', 'publishedDate', 'referenceYear', 'license', 'resolution', 'method']) {
    const value = provided[key] ?? inherited[key];
    if (typeof value === 'string' || typeof value === 'number' && Number.isFinite(value)) source[key] = String(value).slice(0, key === 'url' ? 2048 : 300);
  }
  return {
    id: options.id || globalThis.crypto?.randomUUID?.() || `layer-${Date.now().toString(36)}-${++nextId}`,
    name: String(options.name || data.name || source.name), data, source, visualization,
    field: options.field ?? '', units: options.units ?? '', palette, opacity,
    visible: options.visible ?? true, locked: options.locked ?? false,
    filters: { categoryField: '', category: '', min: null, max: null, viewport: false, ...options.filters },
    timeField: options.timeField ?? '',
  };
}

function extentPieces(value, label) {
  const bbox = value?.bbox ?? value;
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((n) => typeof n === 'number' && Number.isFinite(n))) throw new Error(`${label} must be a [west, south, east, north] bounding box.`);
  const [w, s, e, n] = bbox;
  if (s < -90 || n > 90 || s > n) throw new Error(`${label} has invalid south/north latitude bounds.`);
  if (Math.abs(e - w) >= 360) return [[-180, s, 180, n]];
  const west = wrapLongitude(w), width = ((e - w) % 360 + 360) % 360;
  const east = west + width;
  return east <= 180 ? [[west, s, east, n]] : [[west, s, 180, n], [-180, s, east - 360, n]];
}

function segmentInBox(a, b, box) {
  let lower = 0, upper = 1;
  for (let axis = 0; axis < 2; axis += 1) {
    const delta = b[axis] - a[axis];
    if (delta === 0) { if (a[axis] < box[axis] - EPSILON || a[axis] > box[axis + 2] + EPSILON) return false; }
    else {
      const first = (box[axis] - a[axis]) / delta, second = (box[axis + 2] - a[axis]) / delta;
      lower = Math.max(lower, Math.min(first, second)); upper = Math.min(upper, Math.max(first, second));
      if (lower > upper + EPSILON) return false;
    }
  }
  return true;
}

function shiftedBoxes(box, longitude) {
  const shift = Math.round((longitude - (box[0] + box[2]) / 2) / 360) * 360;
  return [-360, 0, 360].map((offset) => [box[0] + shift + offset, box[1], box[2] + shift + offset, box[3]]);
}

function polygonRings(polygon) {
  const outer = unwrapPath(polygon[0]);
  return [outer, ...polygon.slice(1).map((ring) => {
    const points = unwrapPath(ring);
    const shift = Math.round((outer[0][0] - points[0][0]) / 360) * 360;
    return points.map(([x, y]) => [x + shift, y]);
  })];
}

function geometryInBox(geometry, box) {
  if (geometry.type === 'Polygon' || geometry.type === 'MultiPolygon') {
    const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
    return polygons.some((polygon) => {
      const rings = polygonRings(polygon);
      return shiftedBoxes(box, rings[0][0][0]).some((shifted) => {
        if (rings.some((ring) => ring.slice(1).some((b, i) => segmentInBox(ring[i], b, shifted)))) return true;
        const corners = [[shifted[0], shifted[1]], [shifted[0], shifted[3]], [shifted[2], shifted[1]], [shifted[2], shifted[3]]];
        return corners.some((point) => pointInRing(point, rings[0]) && !rings.slice(1).some((hole) => pointInRing(point, hole)));
      });
    });
  }
  return pathsFor(geometry).some((path) => path.some((position, i) => {
    const a = path[Math.max(0, i - 1)], b = [a[0] + longitudeDelta(a[0], position[0]), position[1]];
    return shiftedBoxes(box, (a[0] + b[0]) / 2).some((shifted) => segmentInBox(a, b, shifted));
  }));
}

export function filterCollection(layer, context = {}) {
  const features = featuresOf(layer.data), filters = layer.filters || {};
  const minimum = filters.min == null ? null : numeric(filters.min), maximum = filters.max == null ? null : numeric(filters.max);
  if (filters.min != null && minimum === null || filters.max != null && maximum === null) throw new Error('Numeric filter limits must be finite numbers.');
  if (minimum !== null && maximum !== null && minimum > maximum) throw new Error('Numeric filter minimum exceeds maximum.');
  if ((minimum !== null || maximum !== null) && !layer.field) throw new Error('Choose a numeric field before setting numeric filters.');
  if ((minimum !== null || maximum !== null) && !features.some((feature) => numeric(feature.properties?.[layer.field]) !== null)) throw new Error(`Field "${layer.field}" has no finite numeric values for filtering.`);
  let boxes = null;
  for (const [value, label] of [[filters.viewport ? context.bounds : null, 'Viewport'], [context.region, 'Region']]) {
    if (value == null) continue;
    const pieces = extentPieces(value, label);
    boxes = boxes === null ? pieces : boxes.flatMap((a) => pieces.flatMap((b) => [-360, 0, 360].map((shift) => [Math.max(a[0], b[0] + shift), Math.max(a[1], b[1]), Math.min(a[2], b[2] + shift), Math.min(a[3], b[3])])).filter(([w, s, e, n]) => w <= e && s <= n));
  }
  const timeActive = context.time != null && context.time !== '';
  const time = timeActive ? normalizedTime(context.time, layer.timeField || '') : null;
  if (timeActive && !layer.timeField) throw new Error('Choose an observed date or year field before filtering time.');
  if (timeActive && time === null) throw new Error('Time must be a valid ISO date/timestamp or a year for a year field.');
  return { ...layer.data, features: features.filter((feature) => {
    const properties = feature.properties || {};
    if (minimum !== null || maximum !== null) {
      const value = numeric(properties[layer.field]);
      if (value === null || minimum !== null && value < minimum || maximum !== null && value > maximum) return false;
    }
    if (filters.categoryField && filters.category !== '' && filters.category !== undefined && properties[filters.categoryField] !== filters.category) return false;
    if (timeActive && normalizedTime(properties[layer.timeField], layer.timeField) !== time) return false;
    return boxes === null || boxes.some((box) => geometryInBox(feature.geometry, box));
  }) };
}

export function temporalValues(layer) {
  if (!layer.timeField) return [];
  return [...new Set(featuresOf(layer.data).map((feature) => normalizedTime(feature.properties?.[layer.timeField], layer.timeField)).filter((value) => value !== null))].sort();
}

function fraction(value, minimum, maximum) {
  if (minimum === maximum) return 0.5;
  const scale = Math.max(Math.abs(minimum), Math.abs(maximum)) || 1;
  return Math.max(0, Math.min(1, (value / scale - minimum / scale) / (maximum / scale - minimum / scale)));
}

function between(minimum, maximum, ratio) {
  return minimum * (1 - ratio) + maximum * ratio;
}

export function metricsFor(collection, field = '') {
  const features = featuresOf(collection);
  const values = field ? features.map((feature) => numeric(feature.properties?.[field])).filter((value) => value !== null).sort((a, b) => a - b) : [];
  const result = { count: features.length, validCount: values.length, min: null, median: null, max: null, mean: null, sum: null, histogram: [] };
  if (field && values.length !== features.length) {
    const categories = new Map();
    for (const feature of features) {
      const value = feature.properties?.[field];
      if (missing(value) || !['string', 'number', 'boolean'].includes(typeof value)) continue;
      categories.set(value, (categories.get(value) || 0) + 1);
    }
    if (!values.length && categories.size) result.categories = [...categories].map(([value, count]) => ({ value, count })).sort((a, b) => String(a.value).localeCompare(String(b.value)));
  }
  if (!values.length) return result;
  result.min = values[0]; result.max = values.at(-1);
  result.median = values.length % 2 ? values[Math.floor(values.length / 2)] : between(values[values.length / 2 - 1], values[values.length / 2], 0.5);
  const scale = Math.max(Math.abs(result.min), Math.abs(result.max)) || 1;
  const scaledSum = values.reduce((sum, value) => sum + value / scale, 0);
  result.sum = Number.isFinite(scaledSum * scale) ? scaledSum * scale : null;
  result.mean = scaledSum / values.length * scale;
  const bins = result.min === result.max ? 1 : Math.min(10, Math.ceil(Math.sqrt(values.length)));
  result.histogram = Array.from({ length: bins }, (_, i) => ({ min: between(result.min, result.max, i / bins), max: between(result.min, result.max, (i + 1) / bins), count: 0 }));
  for (const value of values) result.histogram[Math.min(bins - 1, Math.floor(fraction(value, result.min, result.max) * bins))].count += 1;
  return result;
}

function polygonCentroid(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let total = 0, x = 0, y = 0;
  const anchor = polygons[0][0][0][0];
  for (const polygon of polygons) {
    for (const [i, ring] of polygonRings(polygon).entries()) {
      const origin = ring[0];
      let area = 0, cx = 0, cy = 0;
      for (let j = 1; j < ring.length - 1; j += 1) {
        const weight = cross(origin, ring[j], ring[j + 1]);
        area += weight;
        cx += (origin[0] + ring[j][0] + ring[j + 1][0]) / 3 * weight;
        cy += (origin[1] + ring[j][1] + ring[j + 1][1]) / 3 * weight;
      }
      const weight = Math.abs(area) * (i ? -1 : 1);
      const longitude = cx / area;
      x += (longitude + Math.round((anchor - longitude) / 360) * 360) * weight;
      y += cy / area * weight; total += weight;
    }
  }
  if (total <= 0) throw new Error('Polygon holes leave no positive area for a representative centroid.');
  return [wrapLongitude(x / total), y / total];
}

function lineMidpoint(geometry) {
  const segments = pathsFor(geometry).flatMap((path) => path.slice(1).map((b, i) => {
    const a = path[i], dx = longitudeDelta(a[0], b[0]), dy = b[1] - a[1];
    return { a, dx, dy, length: Math.hypot(dx * Math.cos((a[1] + b[1]) * Math.PI / 360), dy) };
  }));
  let remaining = segments.reduce((sum, segment) => sum + segment.length, 0) / 2;
  for (const segment of segments) {
    if (remaining <= segment.length) {
      const t = segment.length ? remaining / segment.length : 0;
      return [wrapLongitude(segment.a[0] + segment.dx * t), segment.a[1] + segment.dy * t];
    }
    remaining -= segment.length;
  }
  return [...pathsFor(geometry)[0][0]];
}

function representatives(features, notes) {
  const points = [];
  features.forEach((feature, sourceIndex) => {
    const geometry = feature.geometry;
    let positions;
    if (geometry.type === 'Point') positions = [geometry.coordinates];
    else if (geometry.type === 'MultiPoint') {
      positions = geometry.coordinates;
      notes.add('MultiPoint attributes repeat at each supplied position; density counts each feature once per occupied cell.');
    } else if (geometry.type.includes('Polygon')) {
      positions = [polygonCentroid(geometry)];
      notes.add('Planar polygon centroids are approximate representative positions and can lie outside concave polygons or in holes.');
    } else {
      positions = [lineMidpoint(geometry)];
      notes.add('Lines are represented by approximate along-line midpoints, not new observations.');
    }
    for (const [index, coordinates] of positions.entries()) points.push({ ...feature, id: `${feature.id ?? sourceIndex}:${index}`, geometry: { type: 'Point', coordinates: [...coordinates] }, properties: { ...feature.properties }, sourceIndex });
  });
  return points;
}

function rectangleGeometry(west, south, east, north) {
  const ring = (w, e) => [[w, south], [e, south], [e, north], [w, north], [w, south]];
  const w = wrapLongitude(west), e = w + east - west;
  return e <= 180 ? { type: 'Polygon', coordinates: [ring(w, e)] } : { type: 'MultiPolygon', coordinates: [[ring(w, 180)], [ring(-180, e - 360)]] };
}

function collectionOf(features) {
  return { type: 'FeatureCollection', features };
}

function densityGrid(points) {
  if (!points.length) return [];
  const [west, south, east, north] = boundsFor(collectionOf(points));
  const width = east < west ? east + 360 - west : east - west;
  const step = Math.max(width, north - south, 0.024) / 24;
  const originX = width ? west : west - step / 2;
  const originY = Math.min(90 - step, south === north ? south - step / 2 : south);
  const columns = Math.max(1, Math.min(24, Math.ceil(width / step - 1e-9))), rows = Math.max(1, Math.min(24, Math.ceil((north - originY) / step - 1e-9)));
  const centerX = originX + columns * step / 2;
  const cells = new Map();
  for (const point of points) {
    const [longitude, latitude] = point.geometry.coordinates;
    const x = longitudeNear(longitude, centerX) - originX;
    const column = Math.min(columns - 1, Math.max(0, Math.floor(x / step)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor((latitude - originY) / step)));
    const key = row * columns + column;
    if (!cells.has(key)) cells.set(key, { row, column, sources: new Set() });
    cells.get(key).sources.add(point.sourceIndex);
  }
  return [...cells].sort(([a], [b]) => a - b).map(([key, cell]) => ({
    type: 'Feature', id: `cell-${key}`, geometry: rectangleGeometry(originX + cell.column * step, Math.max(-90, originY + cell.row * step), originX + (cell.column + 1) * step, Math.min(90, originY + (cell.row + 1) * step)),
    properties: { count: cell.sources.size, __value: cell.sources.size },
  }));
}

function convexHull(points) {
  const sorted = points.toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (items) => {
    const hull = [];
    for (const point of items) {
      while (hull.length > 1 && cross(hull.at(-2), hull.at(-1), point) <= 0) hull.pop();
      hull.push(point);
    }
    return hull.slice(0, -1);
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

function scalarGrid(points, field) {
  const bounds = boundsFor(collectionOf(points));
  const west = bounds[0], east = bounds[2] < west ? bounds[2] + 360 : bounds[2];
  const centerX = (west + east) / 2;
  const samples = new Map();
  for (const point of points) {
    const [lon, lat] = point.geometry.coordinates;
    const x = longitudeNear(lon, centerX), value = numeric(point.properties[field]);
    const key = `${x},${lat}`;
    if (!samples.has(key)) samples.set(key, { x, y: lat, values: [] });
    samples.get(key).values.push(value);
  }
  const unique = [...samples.values()].map((sample) => {
    const scale = sample.values.reduce((maximum, value) => Math.max(maximum, Math.abs(value)), 0) || 1;
    return { x: sample.x, y: sample.y, value: sample.values.reduce((sum, value) => sum + value / scale, 0) / sample.values.length * scale };
  });
  const hull = convexHull(unique.map(({ x, y }) => [x, y]));
  if (unique.length < 3 || hull.length < 3 || ringArea([...hull, hull[0]]) === 0) throw new Error('Interpolation requires at least three distinct, non-collinear points with numeric values.');
  const scale = unique.reduce((maximum, sample) => Math.max(maximum, Math.abs(sample.value)), 0) || 1;
  const cosine = Math.cos((bounds[1] + bounds[3]) * Math.PI / 360);
  const size = 16;
  const nodes = [];
  for (let row = 0; row <= size; row += 1) {
    for (let column = 0; column <= size; column += 1) {
      const x = between(west, east, column / size), y = between(bounds[1], bounds[3], row / size);
      let value = null;
      if (pointInRing([x, y], hull)) {
        let numerator = 0, denominator = 0;
        for (const sample of unique) {
          const distance = ((x - sample.x) * cosine) ** 2 + (y - sample.y) ** 2;
          if (distance < 1e-24) { numerator = sample.value / scale; denominator = 1; break; }
          const weight = 1 / distance;
          numerator += sample.value / scale * weight; denominator += weight;
        }
        value = numerator / denominator * scale;
      }
      nodes.push({ position: [x, y], value });
    }
  }
  return { nodes, size, duplicateCount: points.length - unique.length };
}

function contourGeometry(a, b) {
  const first = [wrapLongitude(a[0]), a[1]], last = [wrapLongitude(b[0]), b[1]];
  if (Math.abs(last[0] - first[0]) <= 180) return { type: 'LineString', coordinates: [first, last] };
  const end = first[0] + longitudeDelta(first[0], last[0]);
  const seam = end > 180 ? 180 : -180;
  const latitude = between(first[1], last[1], (seam - first[0]) / (end - first[0]));
  const pieces = [[first, [seam, latitude]], [[-seam, latitude], last]].filter(([p, q]) => p[0] !== q[0] || p[1] !== q[1]);
  return pieces.length === 1 ? { type: 'LineString', coordinates: pieces[0] } : { type: 'MultiLineString', coordinates: pieces };
}

function interpolatedFeatures(points, field, visualization, notes) {
  const { nodes, size, duplicateCount } = scalarGrid(points, field);
  notes.add('Approximate inverse-distance interpolation (power 2, local longitude/latitude distances) on a 16 x 16 grid; cells outside the sample convex hull are omitted. Not measured contours or surveyed terrain.');
  if (duplicateCount) notes.add(`${duplicateCount} duplicate sample positions were averaged before interpolation.`);
  const values = nodes.map((node) => node.value).filter((value) => value !== null);
  const minimum = Math.min(...values), maximum = Math.max(...values);
  if (visualization === 'contours' && minimum === maximum) { notes.add(`Constant scalar field (${minimum}); no isolines exist.`); return []; }
  const levels = Array.from({ length: 7 }, (_, i) => between(minimum, maximum, (i + 1) / 8));
  const features = [];
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const i = row * (size + 1) + column;
      const corners = [nodes[i], nodes[i + 1], nodes[i + size + 2], nodes[i + size + 1]];
      if (corners.some((node) => node.value === null)) continue;
      if (visualization === 'surface') {
        const scale = Math.max(...corners.map((node) => Math.abs(node.value))) || 1;
        const value = corners.reduce((sum, node) => sum + node.value / scale, 0) / 4 * scale;
        features.push({ type: 'Feature', id: `surface-${row}-${column}`, geometry: rectangleGeometry(...corners[0].position, ...corners[2].position), properties: { [field]: value, __value: value, __estimated: true } });
        continue;
      }
      levels.forEach((level, levelIndex) => {
        const crossings = new Map();
        corners.forEach((a, edge) => {
          const b = corners[(edge + 1) % 4];
          if ((a.value >= level) === (b.value >= level)) return;
          const scale = Math.max(Math.abs(a.value), Math.abs(b.value), Math.abs(level)) || 1;
          const t = (level / scale - a.value / scale) / (b.value / scale - a.value / scale);
          crossings.set(edge, [between(a.position[0], b.position[0], t), between(a.position[1], b.position[1], t)]);
        });
        let pairs = crossings.size === 2 ? [[...crossings.keys()]] : [];
        if (crossings.size === 4) {
          // The asymptotic decider resolves ambiguous saddle cells deterministically.
          const scale = Math.max(...corners.map((node) => Math.abs(node.value)), Math.abs(level)) || 1;
          const shifted = corners.map((node) => node.value / scale - level / scale);
          pairs = shifted[0] * shifted[2] - shifted[1] * shifted[3] >= 0 ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
        }
        pairs.forEach(([first, last], part) => {
          const a = crossings.get(first), b = crossings.get(last);
          if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-14) return;
          features.push({ type: 'Feature', id: `contour-${levelIndex}-${row}-${column}-${part}`, geometry: contourGeometry(a, b), properties: { [field]: level, __value: level, __estimated: true } });
        });
      });
    }
  }
  return features;
}

export function renderCollection(layer, context = {}) {
  const visualization = layer.visualization || 'points';
  if (!Object.hasOwn(VISUALIZATIONS, visualization)) throw new Error(`Unsupported visualization "${visualization}".`);
  if (!Object.hasOwn(PALETTES, layer.palette || 'olive')) throw new Error(`Unknown palette "${layer.palette}".`);
  const palette = PALETTES[layer.palette || 'olive'];
  const original = featuresOf(layer.data), field = layer.field || '';
  if (field && !original.some((feature) => numeric(feature.properties?.[field]) !== null)) throw new Error(`Field "${field}" has no finite numeric values; choose a numeric field.`);
  const scalar = visualization === 'contours' || visualization === 'surface';
  if (scalar && !field) throw new Error(`${VISUALIZATIONS[visualization].label} requires a numeric field.`);
  const isPoint = (feature) => feature.geometry.type === 'Point' || feature.geometry.type === 'MultiPoint';
  const isPolygon = (feature) => feature.geometry.type.includes('Polygon');
  const isLine = (feature) => feature.geometry.type.includes('LineString');
  if (visualization === 'flow' && !original.some(isLine)) throw new Error('Flow requires existing LineString or MultiLineString geometry; routes are never inferred.');
  if (scalar && !original.some(isPoint)) throw new Error('Interpolation requires supplied point geometry, not polygon centroids or inferred samples.');
  if (scalar && !original.some((feature) => isPoint(feature) && numeric(feature.properties?.[field]) !== null)) throw new Error('Interpolation requires supplied points with finite numeric values in the selected field.');
  const polygonMode = visualization === 'choropleth' || visualization === 'extrusion';
  if (polygonMode && !original.some(isPolygon) && !original.some(isPoint)) throw new Error(`${VISUALIZATIONS[visualization].label} requires polygons or point data for count cells.`);
  const filtered = filterCollection(layer, context), notes = new Set();
  if (layer.source?.caveat) notes.add(layer.source.caveat);
  let title = field || 'Feature count', unit = field ? layer.units || '' : 'features';
  let geometryType = 'Point', features;
  const countGrid = visualization === 'density' || polygonMode && !original.some(isPolygon);
  if (countGrid) {
    const eligible = polygonMode ? filtered.features.filter(isPoint) : filtered.features;
    features = densityGrid(representatives(eligible, notes)); geometryType = 'Polygon';
    title = 'Feature count'; unit = 'features/cell';
    notes.add('Geographic square-grid counts (at most 24 x 24 cells), not area-normalized density or administrative regions.');
    if (field) notes.add(`Count cells do not encode the selected "${field}" values; numeric filters still use that field.`);
    if (eligible.length !== filtered.features.length) notes.add('Non-point geometry omitted from the point-count grid.');
  } else {
    let eligible = filtered.features;
    if (scalar) eligible = eligible.filter(isPoint);
    else if (polygonMode) eligible = eligible.filter(isPolygon);
    else if (visualization === 'flow') eligible = eligible.filter(isLine);
    if (eligible.length !== filtered.features.length) notes.add(`${filtered.features.length - eligible.length} features with incompatible geometry omitted.`);
    if (field) {
      const valid = eligible.filter((feature) => numeric(feature.properties?.[field]) !== null);
      if (valid.length !== eligible.length) notes.add(`${eligible.length - valid.length} features with missing/non-numeric values omitted, not treated as zero.`);
      eligible = valid;
    }
    if (scalar) {
      features = eligible.length ? interpolatedFeatures(representatives(eligible, notes), field, visualization, notes) : [];
      geometryType = visualization === 'contours' ? 'LineString' : 'Polygon';
    } else {
      features = polygonMode || visualization === 'flow' ? eligible.map((feature) => ({ ...feature, properties: { ...feature.properties } })) : representatives(eligible, notes);
      geometryType = polygonMode ? 'Polygon' : visualization === 'flow' ? 'LineString' : 'Point';
      features.forEach((feature) => { feature.properties.__value = field ? numeric(feature.properties[field]) : 1; });
    }
  }
  const data = { ...filtered, features }, metrics = metricsFor(data, '__value');
  const metricHeight = visualization === 'extrusion' && !countGrid && field && layer.units === 'm';
  for (const feature of features) {
    delete feature.sourceIndex;
    const value = feature.properties.__value;
    const weight = fraction(value, metrics.min, metrics.max);
    feature.properties.__weight = weight;
    if (visualization === 'heatmap') feature.properties.__heatWeight = metrics.min >= 0 ? metrics.max > 0 ? value / metrics.max : 0 : weight;
    feature.properties.__height = metricHeight ? Math.max(0, value) : weight * 1500;
  }
  if (visualization === 'surface' || visualization === 'extrusion') {
    notes.add(metricHeight ? 'Extrusion height uses the supplied meter field; negative heights are clamped to ground level, while original values are preserved.' : 'Height is a normalized 0-1500 visual index, not measured elevation or surveyed terrain.');
  }
  if (visualization === 'heatmap') notes.add(metrics.min >= 0
    ? 'Nonnegative heatmap values are scaled by the displayed maximum; zero values add no intensity. The legend reports source values, not smoothed intensity, absolute mass, or area-normalized density.'
    : 'Signed heatmap values use relative min-max weights, not absolute mass or area-normalized density. The legend reports source values, not smoothed intensity.');
  if (visualization === 'flow') notes.add('Only supplied line geometry is shown; no routes, movement, or direction are inferred.');
  if (!features.length) notes.add('No display geometry remains after filtering or interpolation; no observations were invented.');
  if (metrics.validCount && metrics.min === metrics.max) notes.add('Constant displayed values use the palette midpoint.');
  const caveat = [...notes].join(' ');
  return {
    data, metrics, sourceMetrics: metricsFor(filtered, field), inputCount: filtered.features.length, geometryType, caveat,
    legend: { title, unit, min: metrics.min, mid: metrics.min === null ? null : between(metrics.min, metrics.max, 0.5), max: metrics.max, colors: [...palette.colors], note: caveat },
  };
}

export function exampleCollection(template, center = [77.209, 28.6139]) {
  if (!Array.isArray(center) || center.length !== 2 || !center.every((value) => typeof value === 'number' && Number.isFinite(value)) || Math.abs(center[0]) > 180 || Math.abs(center[1]) > 90) throw new Error('Example center must be a valid [longitude, latitude] position.');
  const kind = ['infrastructure', 'logistics', 'risk', 'movement'].includes(template) ? template : 'infrastructure';
  const categories = { infrastructure: ['Illustrative site', 'Illustrative facility', 'Illustrative service'], logistics: ['Illustrative hub', 'Illustrative depot', 'Illustrative transfer'], risk: ['Scenario A', 'Scenario B', 'Scenario C'], movement: ['Illustrative path A', 'Illustrative path B', 'Illustrative path C'] }[kind];
  const latitude = Math.max(-89.85, Math.min(89.85, center[1]));
  const longitudeScale = 1 / Math.max(0.2, Math.cos(latitude * Math.PI / 180));
  const dates = ['2026-01-01', '2026-02-01', '2026-03-01'];
  const features = [];
  for (let date = 0; date < dates.length; date += 1) {
    for (let i = 0; i < 9; i += 1) {
      const lon = center[0] + ((i % 3) - 1) * 0.045 * longitudeScale;
      const lat = latitude + (Math.floor(i / 3) - 1) * 0.04;
      let geometry = { type: 'Point', coordinates: [wrapLongitude(lon), lat] };
      if (kind === 'risk') geometry = rectangleGeometry(lon - 0.016 * longitudeScale, lat - 0.014, lon + 0.016 * longitudeScale, lat + 0.014);
      if (kind === 'movement') geometry = { type: 'LineString', coordinates: [[wrapLongitude(lon - 0.015 * longitudeScale), lat - 0.01], [wrapLongitude(lon), lat + 0.005], [wrapLongitude(lon + 0.02 * longitudeScale), lat + 0.014]] };
      features.push({ type: 'Feature', id: `${kind}-${i}-${date}`, geometry, properties: {
        name: `Illustrative ${kind} ${i + 1}`, value: (i * 17 + date * 13) % 97, category: categories[i % categories.length], observedAt: dates[date], synthetic: true, source: 'Synthetic illustrative example',
      } });
    }
  }
  return normalizeCollection({ type: 'FeatureCollection', name: `${kind[0].toUpperCase()}${kind.slice(1)} example`, synthetic: true,
    source: { name: 'Illustrative example', caveat: `${SYNTHETIC_NOTE} Lines are fictional examples, not measured journeys or real fleet activity.`, attribution: 'Meridian synthetic demonstration data' },
    metadata: { synthetic: true, template: kind }, features });
}
