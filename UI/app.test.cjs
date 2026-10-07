const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// Deliberately small DOM: layout, browser networking, and the constructor are not run.
class Element {
  constructor(tag = 'div', attributes = {}) {
    this.tagName = tag;
    this.attributes = { ...attributes };
    this.dataset = {};
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = value;
    }
    const classes = new Set((attributes.class || '').split(/\s+/).filter(Boolean));
    this.classList = {
      contains: (name) => classes.has(name),
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      toggle: (name, force = !classes.has(name)) => {
        if (force) classes.add(name); else classes.delete(name);
        return force;
      },
    };
    this.children = [];
    this.listeners = new Map();
    this.hidden = Object.hasOwn(attributes, 'hidden');
    this.disabled = false;
    this.value = attributes.value || '';
    this.textContent = '';
    this.style = {};
  }
  get id() { return this.attributes.id; }
  set id(value) { this.attributes.id = value; }
  get role() { return this.attributes.role; }
  set role(value) { this.attributes.role = value; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    const match = selector.match(/^([\w-]+)?(?:\[([\w-]+)(?:="([^"]*)")?\])?$/);
    return Boolean(match && (!match[1] || this.tagName === match[1]) &&
      (!match[2] || (Object.hasOwn(this.attributes, match[2]) && (match[3] === undefined || this.attributes[match[2]] === match[3]))));
  }
  querySelectorAll(selector) {
    return this.children.flatMap((child) => [ ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector) ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { return this.matches(selector) ? this : this.parent?.closest(selector) || null; }
  detach() {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
  }
  append(...children) {
    for (const child of children) {
      child.detach();
      child.parent = this;
      this.children.push(child);
    }
  }
  prepend(...children) {
    for (const child of [...children].reverse()) {
      child.detach();
      child.parent = this;
      this.children.unshift(child);
    }
  }
  after(child) {
    child.detach();
    child.parent = this.parent;
    this.parent.children.splice(this.parent.children.indexOf(this) + 1, 0, child);
  }
  replaceChildren(...children) {
    this.children.forEach((child) => { child.parent = null; });
    this.children = [];
    this.append(...children);
  }
  set innerHTML(html) { this.replaceChildren(...parseHtml(html).children); }
  addEventListener(type, callback) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(callback);
  }
  async dispatch(type) {
    for (const callback of this.listeners.get(type) || []) await callback({ target: this });
  }
  click() { return this.dispatch('click'); }
  focus(options) { this.focusOptions = options; this.focused = true; }
  scrollIntoView(options) { this.scrollOptions = options; }
  showModal() { this.open = true; this.modalCalls = (this.modalCalls || 0) + 1; }
}

function parseHtml(html) {
  const root = new Element('document');
  const stack = [root];
  const voidTags = new Set(['meta', 'link', 'input', 'br', 'img', 'hr']);
  for (const token of html.matchAll(/<\/?([a-z][\w-]*)\b([^>]*)>/gi)) {
    if (token[0].startsWith('</')) {
      if (stack.at(-1).tagName === token[1]) stack.pop();
      continue;
    }
    const attributes = Object.fromEntries([...token[2].matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((match) => [match[1], match[2] || '']));
    const element = new Element(token[1], attributes);
    stack.at(-1).append(element);
    if (!voidTags.has(token[1]) && !token[0].endsWith('/>')) stack.push(element);
  }
  return root;
}

function setup({ mobile = false } = {}) {
  const document = parseHtml(readFileSync(join(__dirname, 'index.html'), 'utf8'));
  document.getElementById = (id) => document.querySelectorAll('[id]').find((element) => element.id === id) || null;
  document.createElement = (tag) => new Element(tag);
  document.documentElement = document.querySelector('html');
  const timers = new Map();
  let timerId = 0;
  const requests = [];
  const window = {
    innerWidth: mobile ? 390 : 1280,
    matchMedia: () => ({ matches: !mobile }),
    addEventListener() {},
    clearTimeout: (id) => timers.delete(id),
    clearInterval() {},
    cancelAnimationFrame() {},
    requestAnimationFrame() { assert.fail('Route calculation must not start animation'); },
  };
  const context = vm.createContext({
    document, window, navigator: {}, AbortController, AbortSignal, URL, URLSearchParams,
    API_BASE_URL: '', AGENT_SOCKET_URL: '', apiPath: (path) => path,
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: window.clearTimeout,
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  });
  const source = readFileSync(join(__dirname, 'app.js'), 'utf8')
    .replace(/^import[^\n]*\n/, '')
    .replaceAll('import.meta.url', JSON.stringify('file:///UI/app.js'));
  vm.runInContext(`${source}\nglobalThis.CityExplorer = CityExplorer; globalThis.applyMonochrome = applyMonochrome;`, context, { filename: 'app.js' });
  const app = Object.create(context.CityExplorer.prototype);
  app.elements = Object.fromEntries(document.querySelectorAll('[id]').map((element) => [element.id, element]));
  Object.assign(app, {
    worker: {}, country: { countryCode: 'US' }, selected: null,
    suggestionIndex: -1, suggestionController: null, searchController: null,
    geo: { pins: [], areas: [], routeStops: [], route: null, routeAnimation: null, state: {}, context: {} },
    routeSubmitting: false, routeAnimationFrame: null, routeAnimationVersion: 0,
    agentActivity: { connection: 'READY', request: 'Ready', tool: 'No active tool' },
    agentSocketReady: true, agentSubmitting: false, agentRunId: '',
    updateDashboard() {}, setMapMode(mode) { this.mapMode = mode; },
    renderRegion() {}, setStream() {}, resetMapForLocation() {},
  });
  return {
    app, document, window, requests, timers, applyMonochrome: context.applyMonochrome,
    async runTimer() {
      const [id, callback] = timers.entries().next().value;
      timers.delete(id);
      return callback();
    },
  };
}

function event(key) {
  return { key, prevented: false, preventDefault() { this.prevented = true; } };
}

function buildingMap() {
  const layers = [
    { id: 'building', type: 'fill' },
    { id: 'building-3d', type: 'fill-extrusion' },
    ...['local-buildings-preview', 'local-buildings', 'local-buildings-inferred'].map((id) => ({ id, type: 'fill-extrusion' })),
    ...['local-selection', 'local-hover'].map((id) => ({ id, type: 'line' })),
  ];
  const visibility = new Map();
  return {
    visibility,
    getStyle: () => ({ layers }),
    getLayer: (id) => layers.find((layer) => layer.id === id),
    isStyleLoaded: () => true,
    setLayoutProperty: (id, property, value) => { if (property === 'visibility') visibility.set(id, value); },
    setPaintProperty() {},
    setFog() {},
  };
}

test('display controls stay outside the sidebar after UI initialization', () => {
  const { app, document } = setup({ mobile: true });
  app.bindUi();
  for (const id of ['theme-toggle', 'fullscreen-toggle']) {
    const control = document.getElementById(id);
    assert.equal(control.closest('.manual-sidebar'), null);
    assert.equal(control.closest('.app-actions').parent, document.querySelector('.app-shell'));
    assert.equal(control.listeners.get('click').length, 1);
  }
  assert.equal(document.querySelector('.workspace-nav').closest('.manual-sidebar'), document.querySelector('.manual-sidebar'));
});

test('desktop route fitting accounts for the actual widened sidebar', () => {
  const { app, document, window } = setup();
  document.querySelector('.manual-sidebar').getBoundingClientRect = () => ({ right: 426 });
  app.geo.route = { geometry: { coordinates: [[1, 2], [3, 4]] } };
  let camera;
  app.map = { fitBounds: (bounds, options) => { camera = options; } };
  const bounds = { extend() { return this; } };
  window.maplibregl = { LngLatBounds: function () { return bounds; } };
  app.focusRoute();
  assert.equal(camera.padding.left, 450);
});

test('building layers and highlights are visible in Streets and Terrain, never Satellite, across themes', () => {
  const { applyMonochrome } = setup();
  const map = buildingMap();
  for (const theme of ['dark', 'light']) {
    for (const mode of ['satellite', 'route', 'terrain', 'satellite']) {
      applyMonochrome(map, theme, mode);
      for (const layer of map.getStyle().layers) {
        assert.equal(map.visibility.get(layer.id), mode === 'satellite' ? 'none' : 'visible', `${theme}/${mode}/${layer.id}`);
      }
    }
  }
});

test('building cards lead with height, retain expandable provenance, and reject missing floor ranges', () => {
  const { app, window } = setup();
  app.map = { setFilter() {} };
  window.maplibregl = { Popup: class {
    constructor(options) { this.options = options; }
    setLngLat() { return this; }
    setDOMContent(content) { this.content = content; return this; }
    addTo() { return this; }
    on(name, callback) { this.close = callback; }
    remove() { this.removed = true; this.close(); }
  } };
  for (const [range, expected] of [
    [undefined, ''], [null, ''], [[], ''], [[3], ''], [[null, 5], ''], [[4, 2], ''],
    [['', 5], ''], [[false, 5], ''], ['broken json', ''], ['{}', ''], ['[2,5]', '2-5 levels'], [[4, 4], '4 levels'], [[1, 1], '1 level'],
  ]) {
    const previous = app.buildingPopup;
    app.showBuilding({ features: [{ properties: { render_height: 34, estimatedLevelRange: range } }], lngLat: { lat: 40.7, lng: -74 } });
    const { content, options } = app.buildingPopup;
    assert.equal(options.className, 'building-card');
    assert.equal(content.children[0].textContent, 'Building');
    assert.equal(content.children[1].textContent, 'OpenStreetMap preview');
    assert.equal(content.children[2].children[0].textContent, '34 m');
    const disclosure = content.querySelector('details');
    assert(disclosure);
    assert.equal(disclosure.getAttribute('open'), null);
    const rows = disclosure.querySelector('dl').children;
    const details = Object.fromEntries(rows.map(row => row.children.map(cell => cell.textContent)));
    assert.equal(details['Estimated floors'] || '', expected);
    assert.equal(details.Floors, undefined);
    assert.equal(details['Map coordinate'], '40.700000, -74.000000');
    assert.equal(JSON.stringify(details).includes('undefined'), false);
    if (previous) assert.equal(previous.removed, true);
  }
  app.showBuilding({ features: [{ properties: { name: '<script>not markup</script>', levels: null } }], lngLat: { lat: 0, lng: 0 } });
  assert.equal(app.buildingPopup.content.children[0].textContent, '<script>not markup</script>');
  assert.equal(app.buildingPopup.content.children[0].children.length, 0);
  assert.equal(app.buildingPopup.content.children[2].children[1].textContent, 'Height unavailable');
});

test('mode changes preserve preview loading state while restoring loaded building layers', () => {
  const { app } = setup();
  app.map = buildingMap();
  app.theme = 'dark';
  app.previewVisible = true;
  for (const mode of ['satellite', 'route', 'terrain']) {
    app.mapMode = mode;
    app.applyMapMode();
    assert.equal(app.map.visibility.get('local-buildings-preview'), mode === 'satellite' ? 'none' : 'visible');
    assert.equal(app.map.visibility.get('local-buildings'), mode === 'satellite' ? 'none' : 'visible');
    app.setPreviewVisible(false);
    app.applyMapMode();
    assert.equal(app.map.visibility.get('local-buildings-preview'), 'none');
    app.setPreviewVisible(true);
    assert.equal(app.map.visibility.get('local-buildings-preview'), mode === 'satellite' ? 'none' : 'visible');
  }
});
function respond(request, body, { ok = true, status = 200 } = {}) {
  request.resolve({ ok, status, json: async () => body });
}
function place(name, lon = 1) { return { name, shortName: name, countryCode: 'US', lon, lat: 2 }; }
function routeSetup() {
  const result = setup({ mobile: true });
  const { app } = result;
  app.geo.routeStops = [place('First'), place('Second', 3)].map((value) => ({ query: value.name, place: value, suggestions: [] }));
  const rendered = [];
  app.map = { getSource: () => ({ setData: (data) => rendered.push(data) }) };
  app.renderWorkspace = () => {};
  app.focusRoute = () => { app.routeFocused = true; };
  return { ...result, rendered };
}

test('mobile clarification stays outside collapsed controls and does not open information', async () => {
  const { app, document } = setup({ mobile: true });
  app.bindUi();
  app.handleAgentEvent({ type: 'agent.question', runId: 'run-1', question: 'Which city?', choices: ['Paris', 'London'] });
  const question = app.elements['agent-question'];
  assert.equal(app.agentQuestionOpen, true);
  assert.equal(question.classList.contains('is-hidden'), false);
  assert.equal(question.closest('.agent-panel').parent, document.querySelector('.manual-sidebar'));
  assert.equal(question.closest('.manual-controls-content'), null);
  for (let ancestor = question; ancestor; ancestor = ancestor.parent) assert.equal(ancestor.hidden, false);
  assert.equal(question.focused, true);
  assert.equal(document.getElementById('info-drawer-content').hidden, true);
  assert.equal(app.elements['toggle-info-drawer'].getAttribute('aria-expanded'), 'false');
  assert.equal(app.elements['agent-question-choices'].children.length, 2);
  await app.elements['agent-dismiss-question'].click();
  assert.equal(app.agentQuestionOpen, false);
  assert.equal(question.classList.contains('is-hidden'), true);
});

test('mobile Workspace navigation closes information and keeps controls and utilities open', async () => {
  const { app, document } = setup({ mobile: true });
  app.bindUi();
  app.setInfoDrawerOpen(true);
  assert.equal(app.manualControlsOpen, false);
  await document.querySelectorAll('button[data-workspace-view]').find((button) => button.dataset.workspaceView === 'workspace').click();
  assert.equal(app.workspaceView, 'workspace');
  assert.equal(app.manualControlsOpen, true);
  assert.equal(app.geoToolsOpen, true);
  assert.equal(document.querySelector('.utility-tools').open, true);
  assert.equal(document.getElementById('info-drawer-content').hidden, true);
  assert.equal(app.elements['toggle-manual-controls'].getAttribute('aria-expanded'), 'true');
  assert.equal(document.documentElement.dataset.sidebar, 'open');
});

test('bindUi keeps route summary and geographic status outside hidden information', () => {
  const { app, document } = setup({ mobile: true });
  app.bindUi();
  const summary = document.querySelector('.route-summary');
  assert.equal(summary.parent, app.elements['route-form'].parent);
  assert.equal(summary.closest('.info-drawer'), null);
  assert.equal(app.elements['geo-status'].parent, document.querySelector('.search-panel'));
});

test('city autocomplete exposes ARIA options, wraps arrow selection, and Enter chooses the active place', () => {
  const { app } = setup();
  const cities = [place('Paris'), place('London', 3)];
  app.renderSuggestions(cities);
  const input = app.elements['search-input'];
  const options = app.elements.suggestions.children;
  assert.equal(input.role, 'combobox');
  assert.equal(input.getAttribute('aria-controls'), app.elements.suggestions.id);
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  assert.equal(app.elements.suggestions.role, 'listbox');
  assert.equal(options[0].getAttribute('aria-selected'), 'false');
  assert.equal(options[0].tabIndex, -1);
  for (const [key, index] of [['ArrowUp', 1], ['ArrowDown', 0], ['ArrowDown', 1], ['ArrowDown', 0]]) {
    const keyEvent = event(key);
    app.handleSearchKey(keyEvent);
    assert.equal(keyEvent.prevented, true);
    assert.equal(input.getAttribute('aria-activedescendant'), options[index].id);
    assert.deepEqual(options.map((option) => option.getAttribute('aria-selected')), index ? ['false', 'true'] : ['true', 'false']);
  }
  const enter = event('Enter');
  app.handleSearchKey(enter);
  assert.equal(enter.prevented, true);
  assert.equal(app.selected, cities[0]);
  assert.equal(input.value, 'Paris');
  assert.equal(input.getAttribute('aria-expanded'), 'false');
  assert.equal(input.getAttribute('aria-activedescendant'), null);
});

test('Escape aborts autocomplete, cancels debounce, clears selection ARIA and loader', () => {
  const { app, timers } = setup();
  app.elements['search-input'].value = 'Paris';
  app.queueSuggestions();
  app.suggestionController = new AbortController();
  app.renderSuggestions([place('Paris')]);
  app.handleSearchKey(event('ArrowDown'));
  app.setLoading(true);
  app.handleSearchKey(event('Escape'));
  assert.equal(app.suggestionController.signal.aborted, true);
  assert.equal(timers.size, 0);
  assert.equal(app.elements.suggestions.children.length, 0);
  assert.equal(app.elements['search-input'].getAttribute('aria-expanded'), 'false');
  assert.equal(app.elements['search-input'].getAttribute('aria-activedescendant'), null);
  assert.equal(app.elements['search-loader'].classList.contains('is-hidden'), true);
});

test('Enter without a selected autocomplete option allows the form full search', () => {
  const { app } = setup();
  app.renderSuggestions([place('Paris')]);
  const enter = event('Enter');
  app.handleSearchKey(enter);
  assert.equal(enter.prevented, false);
  assert.equal(app.selected, null);
});

test('failed geocode displays explicit error and retry status, then clears submitting loader', async () => {
  const { app, requests } = setup();
  app.elements['search-input'].value = 'Missing place';
  const pending = app.submitSearch(event());
  assert.equal(app.elements['search-status'].textContent, 'Searching...');
  assert.equal(app.elements['search-loader'].classList.contains('is-hidden'), false);
  respond(requests[0], { error: 'Geocoder unavailable' }, { ok: false, status: 503 });
  await pending;
  assert.match(app.elements['search-status'].textContent, /Geocoder unavailable.*retry/);
  assert.equal(app.elements['search-status'].classList.contains('is-hidden'), false);
  assert.equal(app.elements['search-status'].classList.contains('is-error'), true);
  assert.equal(app.elements['search-loader'].classList.contains('is-hidden'), true);
  assert.equal(app.selected, null);
});

test('empty geocode result is not silently treated as success', async () => {
  const { app, requests } = setup();
  const pending = app.resolveSearch('Nowhere');
  respond(requests[0], {});
  await pending;
  assert.match(app.elements['search-status'].textContent, /No matching place/);
  assert.equal(app.elements['search-status'].classList.contains('is-error'), true);
});

test('a newer geocode aborts the old query and late success cannot overwrite the selected city', async () => {
  const { app, requests } = setup();
  const old = app.resolveSearch('Paris');
  const current = app.resolveSearch('London', 'GB');
  assert.equal(requests[0].options.signal.aborted, true);
  assert.match(requests[1].url, /countryCode=GB/);
  respond(requests[1], { result: place('London', 3) });
  await current;
  respond(requests[0], { result: place('Paris') });
  await old;
  assert.equal(app.selected.name, 'London');
  assert.equal(app.elements['search-status'].textContent, '');
});

test('editing a city aborts geocode; its late failure cannot replace status or stop the newer loader', async () => {
  const { app, requests, runTimer } = setup();
  const old = app.resolveSearch('Paris');
  app.elements['search-input'].value = 'London';
  app.queueSuggestions();
  assert.equal(requests[0].options.signal.aborted, true);
  const suggestions = runTimer();
  requests[0].reject(new Error('Late old failure'));
  await old;
  assert.equal(app.elements['search-status'].textContent, '');
  assert.equal(app.elements['search-loader'].classList.contains('is-hidden'), false);
  respond(requests[1], { results: [place('London')] });
  await suggestions;
  assert.equal(app.elements.suggestions.children.length, 1);
});

test('autocomplete aborts superseded requests and discards late results even when fetch ignores abort', async () => {
  const { app, requests, runTimer } = setup();
  app.elements['search-input'].value = 'Paris';
  app.queueSuggestions();
  const old = runTimer();
  app.elements['search-input'].value = 'London';
  app.queueSuggestions();
  const current = runTimer();
  assert.equal(requests[0].options.signal.aborted, true);
  respond(requests[0], { results: [place('Paris')] });
  await old;
  assert.equal(app.elements.suggestions.children.length, 0);
  assert.equal(app.elements['search-loader'].classList.contains('is-hidden'), false);
  respond(requests[1], { results: [place('London')] });
  await current;
  assert.equal(app.elements.suggestions.children[0].querySelector('strong').textContent, 'London');
  assert.equal(app.elements['search-loader'].classList.contains('is-hidden'), true);
});

test('autocomplete shows distinct empty and failed response feedback', async () => {
  const { app, requests, runTimer } = setup();
  app.elements['search-input'].value = 'Nowhere';
  app.queueSuggestions();
  const empty = runTimer();
  respond(requests[0], { results: [] });
  await empty;
  assert.match(app.elements['search-status'].textContent, /No suggestions.*Enter/);
  assert.equal(app.elements['search-status'].classList.contains('is-error'), false);
  app.queueSuggestions();
  const failed = runTimer();
  requests[1].reject(new Error('Offline'));
  await failed;
  assert.match(app.elements['search-status'].textContent, /Suggestions unavailable.*Enter/);
  assert.equal(app.elements['search-status'].classList.contains('is-error'), true);
});

test('autocomplete checks current input before applying results even without an abort', async () => {
  const { app, requests, runTimer } = setup();
  app.elements['search-input'].value = 'Paris';
  app.queueSuggestions();
  const pending = runTimer();
  app.elements['search-input'].value = 'London';
  assert.equal(requests[0].options.signal.aborted, false);
  respond(requests[0], { results: [place('Paris')] });
  await pending;
  assert.equal(app.elements.suggestions.children.length, 0);
  assert.equal(app.elements['search-input'].getAttribute('aria-expanded'), 'false');
});

test('route response renders the complete geometry immediately without animation and cleans submitting state', async () => {
  const { app, requests, rendered } = routeSetup();
  const route = { id: 'route-1', geometry: { type: 'LineString', coordinates: [[1, 2], [3, 2]] }, summary: { distanceMeters: 1200, durationSeconds: 600, search: { exploredEdges: [[[1, 2], [3, 2]]] } } };
  const pending = app.findRoute(event());
  assert.equal(app.routeSubmitting, true);
  assert.equal(app.elements['trace-route'].disabled, true);
  assert.equal(app.elements['trace-route'].textContent, 'Calculating...');
  assert.deepEqual(JSON.parse(requests[0].options.body), { profile: 'driving', waypoints: [[1, 2], [3, 2]] });
  await app.findRoute(event());
  assert.equal(requests.length, 1);
  respond(requests[0], { route });
  await pending;
  assert.equal(app.geo.route, route);
  assert.equal(app.geo.routeAnimation, null);
  assert.equal(rendered.at(-1).features.find((feature) => feature.properties.overlay === 'route').geometry, route.geometry);
  assert.equal(app.routeFocused, true);
  assert.equal(app.routeSubmitting, false);
  assert.equal(app.elements['trace-route'].disabled, false);
  assert.equal(app.elements['trace-route'].textContent, 'Trace route');
});

test('route response is discarded when stops change, and cleanup respects incomplete updated stops', async () => {
  const { app, requests, rendered } = routeSetup();
  const pending = app.findRoute(event());
  app.geo.routeStops[1].place = null;
  respond(requests[0], { route: { id: 'stale' } });
  await pending;
  assert.equal(app.geo.route, null);
  assert.equal(rendered.length, 0);
  assert.match(app.elements['geo-status'].textContent, /stops changed/);
  assert.equal(app.routeSubmitting, false);
  assert.equal(app.elements['trace-route'].disabled, true);
  assert.equal(app.elements['trace-route'].textContent, 'Trace route');
});

test('route response is discarded when the stop order changes', async () => {
  const { app, requests } = routeSetup();
  const pending = app.findRoute(event());
  app.moveRouteStop(0, 1);
  respond(requests[0], { route: { id: 'stale' } });
  await pending;
  assert.equal(app.geo.route, null);
  assert.equal(app.routeSubmitting, false);
  assert.equal(app.elements['trace-route'].disabled, false);
});

test('route response is discarded when an additional stop is added', async () => {
  const { app, requests } = routeSetup();
  const pending = app.findRoute(event());
  app.addRouteStop();
  respond(requests[0], { route: { id: 'stale' } });
  await pending;
  assert.equal(app.geo.route, null);
  assert.equal(app.routeSubmitting, false);
  assert.equal(app.elements['trace-route'].disabled, true);
  assert.match(app.elements['geo-status'].textContent, /stops changed/);
});

test('route validation rejects incomplete or identical stops without submitting a request', async () => {
  const { app, requests } = routeSetup();
  app.geo.routeStops[1].place = null;
  await app.findRoute(event());
  assert.match(app.elements['geo-status'].textContent, /every route stop/);
  app.geo.routeStops[1].place = place('Same coordinates');
  await app.findRoute(event());
  assert.match(app.elements['geo-status'].textContent, /two different places/);
  assert.equal(requests.length, 0);
  assert.equal(app.routeSubmitting, false);
});

test('route request failure reports error and restores the submit control', async () => {
  const { app, requests } = routeSetup();
  const pending = app.findRoute(event());
  requests[0].reject(new Error('Road network unavailable'));
  await pending;
  assert.equal(app.elements['geo-status'].textContent, 'Road network unavailable');
  assert.equal(app.elements['geo-status'].classList.contains('is-error'), true);
  assert.equal(app.routeSubmitting, false);
  assert.equal(app.elements['trace-route'].disabled, false);
  assert.equal(app.elements['trace-route'].textContent, 'Trace route');
});

test('clearAdditions only deletes after dialog confirmation; cancellation leaves workspace intact', async () => {
  const { app, document, requests } = setup();
  app.bindUi();
  const pins = [place('Saved pin')];
  app.geo.pins = pins;
  let clears = 0;
  app.clearWorkspaceLocal = () => { clears += 1; };
  const dialog = document.getElementById('clear-workspace-dialog');
  assert.equal(dialog.getAttribute('aria-labelledby'), 'clear-workspace-title');
  assert.equal(dialog.querySelector('form').getAttribute('method'), 'dialog');
  assert.equal(dialog.querySelectorAll('button').find((button) => button.value === 'cancel').getAttribute('autofocus'), '');
  await app.elements['clear-additions'].click();
  assert.equal(dialog.open, true);
  assert.equal(dialog.returnValue, '');
  assert.equal(requests.length, 0);
  assert.equal(app.geo.pins, pins);
  dialog.returnValue = 'cancel';
  await dialog.dispatch('close');
  assert.equal(requests.length, 0);
  assert.equal(clears, 0);
  await app.clearAdditions();
  dialog.returnValue = 'clear';
  await dialog.dispatch('close');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/workspace');
  assert.equal(requests[0].options.method, 'DELETE');
  assert.equal(clears, 0);
  respond(requests[0], {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(clears, 1);
  assert.match(app.elements['geo-status'].textContent, /were cleared/);
});

test('confirmed clear failure preserves local workspace and shows an error', async () => {
  const { app, requests } = setup();
  const pins = [place('Saved pin')];
  app.geo.pins = pins;
  app.clearWorkspaceLocal = () => assert.fail('Do not clear local state after failed deletion');
  const pending = app.clearAdditions(true);
  requests[0].reject(new Error('Workspace server unavailable'));
  await pending;
  assert.equal(app.geo.pins, pins);
  assert.equal(app.elements['geo-status'].textContent, 'Workspace server unavailable');
  assert.equal(app.elements['geo-status'].classList.contains('is-error'), true);
});
