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
    Object.defineProperty(this, 'className', {
      get: () => [...classes].join(' '),
      set: (value) => { classes.clear(); String(value).split(/\s+/).filter(Boolean).forEach((name) => classes.add(name)); },
    });
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
  contains(element) { return this === element || this.children.some((child) => child.contains(element)); }
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
  document.createTextNode = (text) => { const node = new Element('text'); node.textContent = text; return node; };
  document.documentElement = document.querySelector('html');
  const timers = new Map();
  let timerId = 0;
  const requests = [];
  const window = {
    innerWidth: mobile ? 390 : 1280,
    innerHeight: mobile ? 844 : 1000,
    matchMedia: (query) => ({ matches: query.includes('max-width') ? mobile : !mobile, addEventListener() {} }),
    addEventListener() {},
    clearTimeout: (id) => timers.delete(id),
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearInterval() {},
    cancelAnimationFrame() {},
    requestAnimationFrame() { assert.fail('Route calculation must not start animation'); },
  };
  const context = vm.createContext({
    document, window, navigator: {}, AbortController, AbortSignal, URL, URLSearchParams,
    Element, HTMLInputElement: class extends Element {}, HTMLTextAreaElement: class extends Element {},
    API_BASE_URL: '', AGENT_SOCKET_URL: '', apiPath: (path) => path,
    setTimeout: (callback) => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: window.clearTimeout,
    fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })),
  });
  const source = readFileSync(join(__dirname, 'app.js'), 'utf8')
    .replace(/^import[^\n]*\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify('file:///UI/app.js'));
  vm.runInContext(`${source}\nglobalThis.CityExplorer = CityExplorer; globalThis.applyMonochrome = applyMonochrome; globalThis.renderAgentReply = renderAgentReply; globalThis.coordinateQuery = coordinateQuery; globalThis.mapInstruction = mapInstruction;`, context, { filename: 'app.js' });
  const app = Object.create(context.CityExplorer.prototype);
  app.elements = Object.fromEntries(document.querySelectorAll('[id]').map((element) => [element.id, element]));
  Object.assign(app, {
    theme: 'dark', mapMode: 'satellite', terrainEnabled: false, productMode: 'explore',
    worker: {}, country: { countryCode: 'US' }, selected: null,
    suggestionIndex: -1, suggestionController: null, searchController: null,
    geo: { pins: [], areas: [], routeStops: [], route: null, routeAnimation: null, state: {}, context: {} },
    routeSubmitting: false, routeAnimationFrame: null, routeAnimationVersion: 0,
    agentActivity: { connection: 'READY', request: 'Ready', tool: 'No active tool' },
    agentSocketReady: true, agentSubmitting: false, agentRunId: '',
    agentTerminalRunIds: new Set(), agentRequestSerial: 0, agentPostSerial: 0,
    workspaceView: 'explore', searchResults: [], commandMode: false, searchFocused: false,
    layerPreferences: { labels: true, buildings: true, roads: true, places: true, boundaries: true, contours: true, hillshade: true },
    routeStopTimers: new Map(), routeStopControllers: new Map(),
    updateDashboard() {}, setMapMode(mode) { this.mapMode = mode; },
    renderRegion() {}, setStream() {}, resetMapForLocation() {},
    refreshMapMetadata() {},
  });
  return {
    app, document, window, requests, timers, context, coordinateQuery: context.coordinateQuery, mapInstruction: context.mapInstruction, applyMonochrome: context.applyMonochrome, renderAgentReply: context.renderAgentReply,
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
  for (const id of ['theme-toggle', 'fullscreen-toggle', 'view-mode-toggle']) {
    const control = document.getElementById(id);
    assert.equal(control.closest('.manual-sidebar'), null);
    assert.equal(control.closest('.app-actions').parent, document.querySelector('.app-shell'));
    assert.equal(control.listeners.get('click').length, 1);
  }
  assert.equal(document.querySelector('.workspace-nav').closest('.manual-sidebar'), null);
  assert.equal(document.getElementById('search-form').closest('.manual-sidebar'), null);
  assert.equal(document.getElementById('manual-controls-content').hidden, true);
});

test('assistant replies render safe formatting without treating HTML or unsafe links as markup', () => {
  const { document, renderAgentReply } = setup();
  const response = document.getElementById('agent-response');
  renderAgentReply(response, '# Places\n\nFound **three places** with *great views* and `map data`.\nSecond line.\n\n- First place\n- Second place\n\n1. Next stop\n2. Last stop\n\n[Map](https://example.com/map) [Unsafe](javascript:alert) [Unreturned](https://unverified.example/data) [Private](http://127.0.0.1:8787/api/workspace) [Credentials](https://name:password@example.org/data)\n<script>alert(1)</script>\n\n```\n<img src=x onerror=alert(1)>\n```', ['https://example.com/map']);
  assert.equal(response.hidden, false);
  assert.equal(response.querySelectorAll('h3').length, 1);
  assert.equal(response.querySelectorAll('strong').length, 1);
  assert.equal(response.querySelectorAll('em').length, 1);
  assert.equal(response.querySelectorAll('li').length, 4);
  assert.equal(response.querySelectorAll('a').length, 1);
  assert.equal(response.querySelector('a').getAttribute('href'), 'https://example.com/map');
  assert.equal(response.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
  assert.equal(response.querySelectorAll('script').length, 0);
  assert.equal(response.querySelectorAll('img').length, 0);
  assert.equal(response.querySelector('pre').querySelector('code').textContent, '<img src=x onerror=alert(1)>\n');
});

test('completed AI replies are not truncated or overwritten by reconnect and progress statuses', () => {
  const { app, document } = setup();
  const message = `A long reply\n\n${'Map information. '.repeat(300)}THE END`;
  app.agentRunId = 'current-run';
  app.handleAgentEvent({ type: 'agent.completed', runId: 'current-run', message });
  const response = document.getElementById('agent-response');
  assert.equal(response.hidden, false);
  assert.equal(response.children[1].children[0].textContent.endsWith('THE END'), true);
  const previous = response.children[1];
  app.setAgentActivity({ connection: 'CONNECTING', request: 'Waiting for connection' });
  assert.equal(response.children[1], previous);
  app.setAgentActivity({ request: 'Request in progress', tool: 'Finding places' });
  assert.equal(response.children[1], previous);
  assert.equal(app.agentRunId, '');
  assert.equal(document.getElementById('agent-feedback').textContent, 'Request in progress');
});

test('view mode toggles accessibly without changing panel or workspace state', async () => {
  const { app, document } = setup();
  app.bindUi();
  app.setManualControlsOpen(true);
  app.setInfoDrawerOpen(true);
  app.setGeoToolsOpen(true);
  const workspace = app.geo;
  const toggle = document.getElementById('view-mode-toggle');
  await toggle.click();
  assert.equal(app.viewMode, true);
  assert.equal(document.documentElement.dataset.viewMode, 'true');
  assert.equal(toggle.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.getAttribute('aria-label'), 'Exit view mode');
  assert.equal(toggle.focused, true);
  await toggle.click();
  assert.equal(app.viewMode, false);
  assert.equal(document.documentElement.dataset.viewMode, 'false');
  assert.equal(toggle.getAttribute('aria-pressed'), 'false');
  assert.equal(app.manualControlsOpen, true);
  assert.equal(app.geoToolsOpen, true);
  assert.equal(document.getElementById('info-drawer-content').hidden, false);
  assert.equal(app.geo, workspace);
});

test('Escape exits view mode before canceling pending interactions; search restores the UI', () => {
  const { app } = setup();
  app.setViewMode(true);
  app.agentQuestionOpen = true;
  app.pinMode = true;
  app.cancelAgentRequest = () => assert.fail('Exiting view mode must not cancel the agent');
  const escape = event('Escape');
  app.handleShortcut(escape);
  assert.equal(escape.prevented, true);
  assert.equal(app.viewMode, false);
  assert.equal(app.pinMode, true);
  app.setViewMode(true);
  const search = event('/');
  app.handleShortcut(search);
  assert.equal(app.viewMode, false);
  assert.equal(app.manualControlsOpen, undefined);
  assert.equal(app.elements['search-input'].focused, true);
});

test('view mode suppresses new building and POI cards but keeps map shortcuts', () => {
  const { app } = setup();
  app.setViewMode(true);
  app.showBuilding({ features: [{ properties: { height: 34 } }] });
  app.showPoi({ features: [{ properties: { name: 'Test place' } }] });
  assert.equal(app.buildingPopup, undefined);
  app.operate = action => assert.equal(action, 'in');
  const zoom = event('+');
  app.handleShortcut(zoom);
  assert.equal(zoom.prevented, true);
  assert.equal(app.viewMode, true);
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
  app.agentSubmitting = true;
  app.handleAgentEvent({ type: 'agent.question', runId: 'run-1', question: 'Which city?', choices: ['Paris', 'London'] });
  const question = app.elements['agent-question'];
  assert.equal(app.agentQuestionOpen, true);
  assert.equal(question.classList.contains('is-hidden'), false);
  assert.equal(question.closest('.agent-panel').parent, document.querySelector('.floating-search'));
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

test('route summary and status remain on the map outside collapsed controls and metadata', () => {
  const { app, document } = setup({ mobile: true });
  app.bindUi();
  const summary = document.querySelector('.route-summary');
  assert.equal(summary.parent, document.querySelector('.map-region'));
  assert.equal(summary.closest('.info-drawer'), null);
  assert.equal(app.elements['geo-status'].parent, document.querySelector('.map-region'));
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
  assert.equal(app.elements['trace-route'].textContent, 'Plan route');
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
  assert.equal(app.elements['trace-route'].textContent, 'Plan route');
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
  assert.equal(app.elements['trace-route'].textContent, 'Plan route');
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

test('coordinate input explicitly handles decimals, hemispheres, geo URIs, and validation', () => {
  const { coordinateQuery } = setup();
  for (const query of ['37.7749, -122.4194', '37.7749 N, 122.4194 W', '37.7749\u00b0 N 122.4194\u00b0 W', 'geo:37.7749,-122.4194?z=12']) {
    const point = coordinateQuery(query);
    assert.equal(point.lat, 37.7749);
    assert.equal(point.lon, -122.4194);
  }
  assert.equal(coordinateQuery('0, 0').lat, 0);
  assert.equal(coordinateQuery('-90, 180').lon, 180);
  assert.match(coordinateQuery('91, 0').error, /latitude/);
  assert.match(coordinateQuery('0, -181').error, /longitude/);
  assert.equal(coordinateQuery('San Francisco'), null);
});

test('primary coordinate search centers and marks the map without geocoding or saving a pin', async () => {
  const { app, requests } = setup();
  let marked = 0;
  app.renderSearchResults = () => { marked += 1; };
  app.elements['search-input'].value = '0, 0';
  await app.submitSearch(event());
  assert.equal(app.selected.lat, 0);
  assert.equal(app.selected.lon, 0);
  assert.equal(app.searchResults[0], app.selected);
  assert.equal(marked, 1);
  assert.equal(requests.length, 0);
  assert.equal(app.geo.pins.length, 0);
  app.elements['search-input'].value = '91, 0';
  await app.submitSearch(event());
  assert.equal(app.elements['search-status'].classList.contains('is-error'), true);
  assert.equal(app.selected.lat, 0);
});

test('natural-language and route queries use the map agent and skip city autocomplete', async () => {
  const { app, requests, timers } = setup();
  const received = [];
  app.startAgentRequest = async (query) => { received.push(query); };
  for (const query of ['Munsiyari to Milam Glacier', 'Find camps near Darkot', 'What is this mountain?']) {
    app.elements['search-input'].value = query;
    app.queueSuggestions();
    assert.equal(timers.size, 0);
    await app.submitSearch(event());
    assert.equal(app.elements['search-submit'].getAttribute('aria-label'), 'Ask Meridian');
  }
  assert.deepEqual(received, ['Munsiyari to Milam Glacier', 'Find camps near Darkot', 'What is this mountain?']);
  assert.equal(requests.length, 0);
});

test('explicit Ask Meridian toggle uses the same search field and retains plain place search', async () => {
  const { app } = setup();
  app.setCommandMode(true);
  assert.equal(app.elements['search-command-toggle'].getAttribute('aria-pressed'), 'true');
  let instruction;
  app.startAgentRequest = async (message) => { instruction = message; };
  app.elements['search-input'].value = 'Golden Gate Bridge';
  await app.submitSearch(event());
  assert.equal(instruction, 'Golden Gate Bridge');
  app.setCommandMode(false);
  let placeQuery;
  app.resolveSearch = async (query) => { placeQuery = query; };
  await app.submitSearch(event());
  assert.equal(placeQuery, 'Golden Gate Bridge');
});

test('supported visualization instructions run locally and unsupported analysis is disclosed', async () => {
  const { app, requests } = setup();
  app.elements['search-input'].value = 'Show terrain';
  await app.submitSearch(event());
  assert.equal(app.mapMode, 'terrain');
  assert.equal(app.manualControlsOpen, true);
  assert.equal(app.elements['agent-panel'].hidden, false);
  assert.match(app.elements['agent-result-summary'].textContent, /Topographic/);
  app.elements['search-input'].value = 'Show me roads above 3000m';
  await app.submitSearch(event());
  assert.match(app.elements['agent-result-summary'].textContent, /not available/);
  assert.equal(app.elements['agent-result-details'].hidden, false);
  assert.equal(requests.length, 0);
});

test('map layer preferences persist across map modes without hiding route or search overlays', () => {
  const { app } = setup();
  const layers = [
    { id: 'road-local', type: 'line' }, { id: 'poi-label', type: 'symbol' },
    { id: 'boundary', type: 'line' }, { id: 'building', type: 'fill' },
    { id: 'local-contours', type: 'line' }, { id: 'local-contour-labels', type: 'symbol' },
    { id: 'geo-route-stop-label', type: 'symbol' }, { id: 'local-search-result-label', type: 'symbol' },
  ];
  const visibility = new Map();
  app.map = {
    getStyle: () => ({ layers }), getLayer: (id) => layers.find((layer) => layer.id === id), isStyleLoaded: () => true,
    setLayoutProperty: (id, property, value) => { if (property === 'visibility') visibility.set(id, value); }, setPaintProperty() {},
  };
  app.mapMode = 'terrain';
  app.toggleMapLayer('roads', false);
  app.toggleMapLayer('labels', false);
  app.toggleMapLayer('boundaries', false);
  app.toggleMapLayer('buildings', false);
  assert.equal(visibility.get('road-local'), 'none');
  assert.equal(visibility.get('boundary'), 'none');
  assert.equal(visibility.get('building'), 'none');
  assert.equal(visibility.get('local-contour-labels'), 'none');
  assert.equal(visibility.get('geo-route-stop-label'), undefined);
  assert.equal(visibility.get('local-search-result-label'), undefined);
  app.toggleMapLayer('roads', true);
  assert.equal(visibility.get('road-local'), 'visible');
});

test('compact controls expand contextually and the title disappears without forcing map-only mode', () => {
  const { app, document } = setup();
  app.bindUi();
  assert.equal(app.manualControlsOpen, false);
  assert.equal(app.elements['manual-controls-content'].hidden, true);
  app.setWorkspaceView('routes');
  assert.equal(app.manualControlsOpen, true);
  assert.equal(app.geoToolsOpen, true);
  assert.equal(document.documentElement.dataset.workspaceView, 'routes');
  assert.equal(document.getElementById('controls-label').textContent, 'Plan a route');
  app.setWorkspaceView('explore');
  assert.equal(app.manualControlsOpen, false);
  assert.equal(app.geoToolsOpen, false);
  app.dismissIntro();
  assert.equal(document.getElementById('view-heading').classList.contains('is-dismissed'), true);
  assert.equal(document.documentElement.dataset.uiQuiet, 'true');
  assert.equal(app.viewMode, undefined);
});

test('idle assistant has no permanent panel and cannot disable place search when disconnected', () => {
  const { app } = setup();
  app.agentSocketReady = false;
  app.renderAgentActivity();
  assert.equal(app.elements['agent-panel'].hidden, true);
  assert.equal(app.elements['search-submit'].disabled, false);
  assert.equal(app.elements['search-input'].disabled, false);
  app.agentSubmitting = true;
  app.renderAgentActivity();
  assert.equal(app.elements['agent-panel'].hidden, false);
  assert.equal(app.elements['search-submit'].disabled, true);
  assert.equal(app.elements['agent-cancel'].classList.contains('is-hidden'), false);
});

test('agent completion preserves details while rejecting late terminal or unrelated events', () => {
  const { app } = setup();
  app.agentRunId = 'run-1';
  app.agentResultSummary = '3 places on the map';
  app.handleAgentEvent({ type: 'agent.completed', runId: 'run-1', message: 'Found **three** places.' });
  assert.equal(app.elements['agent-result-summary'].textContent, '3 places on the map');
  assert.equal(app.elements['agent-result-details'].hidden, false);
  assert.equal(app.elements['agent-result-details'].open, false);
  app.applyAgentMapUpdate = () => assert.fail('A late update cannot modify the map');
  app.handleAgentEvent({ type: 'agent.map', runId: 'run-1', update: {} });
  app.handleAgentEvent({ type: 'agent.map', runId: 'unrelated', update: {} });
  app.dismissAgentResult();
  app.renderAgentActivity();
  assert.equal(app.elements['agent-panel'].hidden, true);
});

test('missing geography context does not silently bias search to zero coordinates', () => {
  const { app } = setup();
  app.geo.context = { lat: null, lon: null };
  assert.equal(app.placeContext(), null);
  app.map = { getCenter: () => ({ lat: 37.7749, lng: -122.4194 }) };
  assert.equal(app.placeContext().lat, 37.7749);
  app.geo.context = { lat: 0, lon: 0 };
  assert.equal(app.placeContext().lat, 0);
});

test('DEM sampling caps zoom, groups tiles, preserves sea level, and handles missing coverage', async () => {
  const { app } = setup();
  const calls = [];
  app.contourDem = { getDemTile: async (z, x, y) => {
    calls.push([z, x, y]);
    return { width: 1, height: 1, data: new Float32Array([0]) };
  } };
  const values = await app.sampleElevationPoints([{ lon: 0, lat: 0 }, { lon: .001, lat: -.001 }, { lon: 360, lat: 0 }, { lon: null, lat: 0 }], 20);
  assert.equal(values[0], 0);
  assert.equal(values[1], 0);
  assert.equal(values[2], 0);
  assert.equal(values[3], null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 13);
  app.contourDem.getDemTile = async () => { throw new Error('No coverage'); };
  assert.equal((await app.sampleElevationPoints([{ lon: 0, lat: 0 }], 13))[0], null);
});

test('DEM sampling wraps antimeridian coordinates and abort settles without waiting for shared tile work', async () => {
  const { app } = setup();
  assert.equal(app.metadataTilePoint({ lon: 180, lat: 0 }, 13).x, 0);
  assert.equal(app.metadataTilePoint({ lon: -180, lat: 0 }, 13).x, 0);
  assert.equal(app.metadataTilePoint({ lon: 0, lat: 90 }, 13).y, 0);
  assert.equal(app.metadataTilePoint({ lon: 0, lat: -90 }, 13).y, 8191);
  app.contourDem = { getDemTile: () => new Promise(() => {}) };
  const controller = new AbortController();
  const work = app.sampleElevationPoints([{ lon: 0, lat: 0 }], 13, controller);
  controller.abort();
  assert.equal((await work)[0], null);
});

function metadataSetup() {
  const result = setup();
  let center = { lat: 37.7749, lng: -122.4194 };
  result.app.map = {
    getCenter: () => center, getCanvas: () => ({ clientWidth: 1440, clientHeight: 1000 }),
    getZoom: () => 12, getPitch: () => 0, getBearing: () => 0, isMoving: () => false,
    getPadding: () => ({ top: 0, left: 0, bottom: 0, right: 0 }), getTerrain: () => null,
    unproject: () => center,
  };
  result.app.contourDem = { getDemTile: async () => ({ width: 1, height: 1, data: new Float32Array([42]) }) };
  result.document.getElementById('info-drawer-content').hidden = false;
  result.app.mapMetadataSequence = 1;
  return { ...result, move: (value) => { center = value; } };
}

test('elevation metadata is unexaggerated and explicitly labels a sampled range, not exact extrema', async () => {
  const { app, document } = metadataSetup();
  const snapshot = app.mapMetadataSnapshot();
  assert.equal(await app.refreshElevationMetadata(snapshot, 1), true);
  assert.equal(document.getElementById('context-center-elevation').textContent, '~42 m');
  assert.equal(document.getElementById('terrain-range-low').textContent, '~42 m');
  assert.match(document.getElementById('terrain-interval').textContent, /9\/9 points.*not exact extrema/);
  assert.match(document.getElementById('context-elevation').textContent, /Mapzen.*composite/);
});

test('camera changes reject late DEM values rather than displaying an old elevation for the new view', async () => {
  const { app, document, move } = metadataSetup();
  let complete;
  app.contourDem.getDemTile = () => new Promise((resolve) => { complete = resolve; });
  const snapshot = app.mapMetadataSnapshot();
  const work = app.refreshElevationMetadata(snapshot, 1);
  move({ lat: 10, lng: 10 });
  complete({ width: 1, height: 1, data: new Float32Array([8000]) });
  assert.equal(await work, false);
  assert.notEqual(document.getElementById('context-center-elevation').textContent, '~8,000 m');
});

test('imagery metadata uses center-footprint citations, handles dates, and stays available without DEM', async () => {
  const { app, requests, document } = metadataSetup();
  app.contourDem = null;
  const snapshot = app.mapMetadataSnapshot();
  assert.equal(snapshot.imageryLod, 13);
  const work = app.refreshImageryMetadata(snapshot, 1);
  const url = new URL(requests[0].url);
  assert.match(url.pathname, /World_Imagery\/MapServer\/4\/query/);
  assert.equal(url.searchParams.get('where'), 'MinMapLevel<=13 AND MaxMapLevel>=13');
  assert.equal(JSON.parse(url.searchParams.get('geometry')).x, -122.4194);
  requests[0].resolve({ ok: true, json: async () => ({ features: [{ attributes: { NICE_NAME: 'Verified source', SRC_DATE: 20260315, SRC_RES: .34, DrawOrder: 1 } }] }) });
  assert.equal(await work, true);
  assert.match(document.getElementById('context-imagery').textContent, /Verified source.*0.34 m.*Center footprint/);
  assert.match(document.getElementById('context-imagery-date').textContent, /2026-03-15.*center footprint only/);
  await app.refreshImageryMetadata(snapshot, 1);
  assert.equal(requests.length, 1);
});

test('imagery metadata does not invent an acquisition date when the provider omits it', async () => {
  const { app, requests, document } = metadataSetup();
  const work = app.refreshImageryMetadata(app.mapMetadataSnapshot(), 1);
  requests[0].resolve({ ok: true, json: async () => ({ features: [{ attributes: { NICE_NAME: 'TerraColor', SRC_DATE: null, SRC_DATE2: null } }] }) });
  await work;
  assert.match(document.getElementById('context-imagery-date').textContent, /Not supplied/);
});

test('long agent routes retain their destination and provider metadata when geometry is bounded', () => {
  const { app } = setup();
  const coordinates = Array.from({ length: 20001 }, (_, index) => [index / 1000, 10]);
  const route = app.agentRoute({ id: 'large', stored: true, sourceVersion: 'v1', createdAt: 123, geometry: { type: 'LineString', coordinates } });
  assert.equal(route.geometry.coordinates.length, 20000);
  assert.equal(route.geometry.coordinates.at(-1)[0], 20);
  assert.equal(route.stored, true);
  assert.equal(route.sourceVersion, 'v1');
  assert.equal(route.createdAt, 123);
});

function cacheSetup() {
  const handlers = new Map();
  const data = new Map();
  const network = [];
  const deleted = [];
  const cache = {
    match: async (request) => data.get(request.url || request)?.clone(),
    keys: async () => [...data.keys()].map((url) => new Request(url)),
    delete: async (request) => data.delete(request.url || request),
    put: async (request, value) => { data.set(request.url || request, value.clone()); },
  };
  let now = 1791360000000;
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    self: { addEventListener: (type, callback) => { handlers.set(type, callback); }, skipWaiting() {}, clients: { claim: async () => {} } },
    caches: { open: async () => cache, delete: async (name) => { deleted.push(name); return true; } },
    Date: Clock, URL, Request, Response, Headers, Uint8Array, console,
    fetch: async (request, options) => { network.push({ url: request.url, options }); return new Response('fresh tile', { headers: { 'Cache-Control': 'max-age=86400', 'Content-Type': 'image/jpeg' } }); },
  });
  vm.runInContext(readFileSync(join(__dirname, 'map-cache-worker.js'), 'utf8'), context);
  const cached = (url, age, cacheControl = 'max-age=86400') => data.set(url, new Response('cached tile', { headers: { 'X-Monument-Cached-At': String(now - age), 'X-Monument-Bytes': '11', 'Cache-Control': cacheControl } }));
  const dispatch = async (url, options = {}) => {
    let response;
    const waits = [];
    handlers.get('fetch')({ request: new Request(url, options), respondWith: (work) => { response = work; }, waitUntil: (work) => { waits.push(work); } });
    if (!response) return null;
    const result = await response;
    for (const wait of waits) await wait;
    return result;
  };
  return { context, handlers, data, network, deleted, cached, dispatch, now: (value) => { now = value; } };
}

const imageryTile = 'https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/12/1582/654';

test('satellite cache refreshes old imagery while reusing bounded fresh tiles', async () => {
  const cache = cacheSetup();
  cache.cached(imageryTile, 30 * 60 * 1000);
  assert.equal(await (await cache.dispatch(imageryTile)).text(), 'cached tile');
  assert.equal(cache.network.length, 0);
  cache.cached(imageryTile, 61 * 60 * 1000);
  assert.equal(await (await cache.dispatch(imageryTile)).text(), 'fresh tile');
  assert.equal(cache.network.length, 1);
  assert.equal(cache.network[0].options.cache, 'no-cache');
});

test('satellite cache honors shorter provider TTL and never intercepts no-store requests or citations', async () => {
  const cache = cacheSetup();
  cache.cached(imageryTile, 61 * 1000, 'max-age=60');
  await cache.dispatch(imageryTile);
  assert.equal(cache.network.length, 1);
  assert.equal(await cache.dispatch(imageryTile, { cache: 'no-store' }), null);
  assert.equal(await cache.dispatch('https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/4/query?f=json'), null);
});

test('satellite cache declines stale fallback while DEM caching remains compatible with the configured endpoint', async () => {
  const cache = cacheSetup();
  cache.context.fetch = async () => { throw new Error('Offline'); };
  cache.cached(imageryTile, 2 * 60 * 60 * 1000);
  await assert.rejects(cache.dispatch(imageryTile), /Offline/);
  const dem = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium/13/100/200.png';
  cache.cached(dem, 24 * 60 * 60 * 1000);
  assert.equal(await (await cache.dispatch(dem)).text(), 'cached tile');
});

test('rendering uses MapLibre antialiasing and preserves explicit flat Satellite view', () => {
  const { app, context, window } = setup();
  let options;
  context.ResizeObserver = class { observe() {} };
  context.requestAnimationFrame = () => 1;
  context.localStorage = { setItem() {} };
  window.maplibregl = {
    Map: class {
      constructor(value) { options = value; }
      addControl() {} on() {}
      getContainer() { return { querySelector: () => ({}) }; }
    }, AttributionControl: class {}, ScaleControl: class {},
  };
  app.terrainEnabled = false;
  app.createMap();
  assert.equal(options.canvasContextAttributes.antialias, true);
  assert.equal(options.pitch, 0);
  assert.equal(options.antialias, undefined);
  app.setMapMode = Object.getPrototypeOf(app).setMapMode;
  app.applyMapMode = () => {};
  app.setMapMode('satellite');
  assert.equal(app.terrainEnabled, false);
  app.terrainEnabled = true;
  app.setMapMode('terrain');
  assert.equal(app.terrainEnabled, true);
});

test('regional imagery is gated by the entire viewport, native zoom, pitch, and explicit preference', () => {
  const { app } = setup();
  let zoom = 11;
  let pitch = 0;
  let west = -122.7;
  const visibility = new Map();
  app.regionalImageryEnabled = true;
  app.regionalImageryActive = false;
  app.map = {
    getLayer: () => ({}), getZoom: () => zoom, getPitch: () => pitch,
    getBounds: () => ({ getWest: () => west, getSouth: () => 37.65, getEast: () => -122.2, getNorth: () => 38 }),
    setLayoutProperty: (id, property, value) => { visibility.set(id, value); },
  };
  app.updateSatelliteImagery();
  assert.equal(app.regionalImageryActive, true);
  assert.equal(visibility.get('local-regional-satellite'), 'visible');
  assert.match(app.elements['context-imagery'].textContent, /NASA.*30 m/);
  assert.match(app.elements['context-imagery-date'].textContent, /2026-09-30/);
  assert.match(app.elements['regional-imagery-note'].textContent, /Clouds.*gaps/);
  zoom = 13;
  app.updateSatelliteImagery();
  assert.equal(app.regionalImageryActive, false);
  zoom = 11;
  pitch = 45;
  app.updateSatelliteImagery();
  assert.equal(app.regionalImageryActive, false);
  pitch = 0;
  west = -123;
  app.updateSatelliteImagery();
  assert.equal(app.regionalImageryActive, false);
  west = -122.7;
  app.regionalImageryEnabled = false;
  app.updateSatelliteImagery();
  assert.equal(app.regionalImageryActive, false);
  app.regionalImageryEnabled = true;
  app.regionalImageryUnavailable = true;
  app.updateSatelliteImagery();
  assert.equal(app.regionalImageryActive, false);
  assert.match(app.elements['regional-imagery-note'].textContent, /unavailable/);
});

test('regional imagery metadata does not attach aerial citations to Sentinel pixels', async () => {
  const { app, document, requests } = metadataSetup();
  app.regionalImageryActive = true;
  assert.equal(await app.refreshImageryMetadata(app.mapMetadataSnapshot(), 1), true);
  assert.match(document.getElementById('context-imagery').textContent, /NASA.*Sentinel-2.*30 m/);
  assert.match(document.getElementById('context-imagery-date').textContent, /2026-09-30/);
  assert.equal(requests.length, 0);
  app.mapMode = 'terrain';
  assert.equal(await app.refreshImageryMetadata(app.mapMetadataSnapshot(), 1), true);
  assert.match(document.getElementById('context-imagery').textContent, /Not shown/);
  assert.equal(document.getElementById('context-imagery-date').textContent, 'Not applicable');
  assert.equal(requests.length, 0);
});

test('dated NASA scene is deliberately excluded from persistent map cache', async () => {
  const cache = cacheSetup();
  assert.equal(await cache.dispatch('https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/HLS_S30_Nadir_BRDF_Adjusted_Reflectance/default/2026-09-30/GoogleMapsCompatible_Level12/12/1582/654.png'), null);
  assert.equal(cache.network.length, 0);
});

test('Geo-IP opens at regional overview zoom while explicit searches retain close-up framing', () => {
  const { app } = setup();
  app.features = new Map(); app.tileFeatures = new Map(); app.tileMetadata = new Map(); app.loaded = new Set(); app.failed = new Set();
  app.selected = { name: 'San Francisco', lat: 37.7749, lon: -122.4194 };
  app.worker = { postMessage() {} };
  app.applyTerrain = () => {};
  app.setPreviewVisible = () => {};
  const cameras = [];
  app.map = { getSource: () => null, getLayer: () => null, jumpTo: (camera) => { cameras.push(camera); } };
  app.resetMapForLocation = Object.getPrototypeOf(app).resetMapForLocation;
  app.resetMapForLocation({ immediate: true, overview: true });
  assert.equal(cameras[0].zoom, 11);
  assert.equal(cameras[0].bearing, 0);
  app.resetMapForLocation({ immediate: true });
  assert.equal(cameras[1].zoom, 14);
});

test('dismissed map instruction failures stay dismissed after activity rerenders', () => {
  const { app } = setup();
  app.setAgentActivity({ request: 'Network unavailable', tool: 'Failed' });
  assert.equal(app.elements['agent-panel'].hidden, false);
  app.dismissAgentResult();
  app.renderAgentActivity();
  assert.equal(app.elements['agent-panel'].hidden, true);
  assert.equal(app.elements['search-input'].disabled, false);
});

test('clarification retires its run so late events cannot hijack a subsequent request', () => {
  const { app } = setup();
  app.agentRunId = 'old-run';
  app.handleAgentEvent({ type: 'agent.question', runId: 'old-run', question: 'Which city?', choices: ['Paris', 'London'] });
  assert.equal(app.agentRunId, '');
  assert.equal(app.agentQuestionOpen, true);
  app.agentSubmitting = true;
  app.handleAgentEvent({ type: 'agent.map', runId: 'old-run', update: {} });
  assert.equal(app.agentRunId, '');
  assert.equal(app.agentEventIsCurrent('new-run'), true);
});

test('socket disconnect releases unified search and preserves interruption feedback on reconnect', () => {
  const { app, window } = setup();
  class Socket {
    static OPEN = 1;
    static CONNECTING = 0;
    constructor() { this.listeners = new Map(); this.readyState = 0; }
    addEventListener(type, handler) { this.listeners.set(type, handler); }
  }
  window.WebSocket = Socket;
  app.agentReconnectAttempts = 0;
  app.agentSessionId = 'session-1';
  app.agentRunId = 'interrupted-run';
  app.connectAgentSocket();
  const socket = app.agentSocket;
  socket.listeners.get('close')();
  assert.equal(app.agentRunId, '');
  assert.equal(app.agentPostSerial, 0);
  assert.equal(app.elements['search-input'].disabled, false);
  assert.match(app.elements['agent-feedback'].textContent, /Connection interrupted/);
  app.connectAgentSocket();
  app.handleAgentSocketMessage(app.agentSocket, { data: JSON.stringify({ type: 'session.ready', sessionId: 'session-1' }) });
  assert.equal(app.agentSocketReady, true);
  assert.match(app.elements['agent-feedback'].textContent, /Connection interrupted/);
});

test('map details do not reuse the searched place name after the camera leaves its coordinate', () => {
  const { app, document, move } = metadataSetup();
  app.selected = { name: 'San Francisco', shortName: 'San Francisco', lat: 37.7749, lon: -122.4194 };
  app.updateDashboard = Object.getPrototypeOf(app).updateDashboard;
  app.updateDashboard();
  assert.equal(document.getElementById('context-place').textContent, 'San Francisco');
  move({ lat: 37.8044, lng: -122.2712 });
  app.updateDashboard();
  assert.equal(document.getElementById('context-place').textContent, 'Map center');
  assert.match(document.getElementById('context-coordinates').textContent, /37.8044/);
});

test('unified instructions submit grounded map context and render a compact map-native completion', async () => {
  const { app, requests } = setup();
  app.agentSessionId = 'session-1';
  app.elements['search-input'].value = 'Find parks near Golden Gate Bridge';
  app.map = { getCenter: () => ({ lng: -122.4783, lat: 37.8199 }), getZoom: () => 12, getBounds: () => ({ getWest: () => -122.6, getSouth: () => 37.7, getEast: () => -122.3, getNorth: () => 38 }) };
  const work = app.submitSearch(event());
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/agent/runs');
  const payload = JSON.parse(requests[0].options.body);
  assert.equal(payload.sessionId, 'session-1');
  assert.equal(payload.message, 'Find parks near Golden Gate Bridge');
  assert.equal(payload.mapContext.center[0], -122.4783);
  assert.equal(app.elements['agent-panel'].hidden, false);
  assert.equal(app.elements['search-input'].disabled, true);
  requests[0].resolve({ ok: true, json: async () => ({ accepted: true, runId: 'run-1' }) });
  await work;
  assert.equal(app.agentRunId, 'run-1');
  app.handleAgentEvent({ type: 'agent.completed', runId: 'run-1', message: 'The map is ready.' });
  assert.equal(app.elements['search-input'].disabled, false);
  assert.equal(app.elements['agent-result-summary'].textContent, 'The map is ready.');
  assert.equal(app.elements['agent-result-details'].open, false);
});

test('server undo blocks new commands and preserves edits that arrive while awaiting its response', async () => {
  const { app, requests } = setup();
  const before = app.captureMapAction();
  app.geo.pins.push({ id: 'agent-pin', name: 'Agent pin', lat: 50, lon: -3 });
  app.recordMapAction('Add agent pin', before, { serverUndo: true, runId: 'finished-run' });
  let restored = false;
  app.restoreMapAction = () => { restored = true; };
  const work = app.undoMapAction();
  assert.equal(app.undoing, true);
  assert.equal(requests[0].url, '/api/agent/undo');
  await app.startAgentRequest('Another request');
  assert.equal(requests.length, 1);
  app.geo.pins.push({ id: 'later-pin', name: 'Late manual response', lat: 51, lon: -2 });
  respond(requests[0], { undone: true, workspace: { pins: [], areas: [], state: {} } });
  await work;
  assert.equal(restored, false);
  assert.equal(app.geo.pins.length, 2);
  assert.equal(app.mapActions.length, 0);
  assert.equal(app.undoing, false);
  assert.match(app.elements['geo-status'].textContent, /Newer local map changes were kept/);
});

test('normal-motion terrain commands synchronize Studio appearance before recording their undo guard', async () => {
  const { app, window } = setup();
  window.matchMedia = () => ({ matches: false });
  app.productMode = 'studio';
  app.map = { getSource: () => ({}), setTerrain() {}, easeTo() {} };
  app.studio = {
    workspace: { id: 'project', terrainEnabled: false },
    snapshot() { return { ...this.workspace }; },
    onMapAppearanceChange() { this.workspace.terrainEnabled = app.terrainEnabled; },
    discardRedo() {}, lastAction() { return null; }, setAgentBusy() {},
  };
  const before = app.captureMapAction();
  app.setTerrainView(true);
  assert.equal(app.studio.workspace.terrainEnabled, true);
  app.recordMapAction('Show 3D', before);
  app.studio.onMapAppearanceChange();
  let restored;
  app.restoreMapAction = (value) => { restored = value; };
  await app.undoMapAction();
  assert.equal(restored.terrainEnabled, false);
  assert.equal(app.mapActions.length, 0);
});

test('a new outer map action invalidates stale Studio redo snapshots', () => {
  const { app } = setup();
  let cleared = 0;
  app.studio = { workspace: { id: 'project' }, snapshot: () => ({ id: 'project' }), discardRedo: () => { cleared++; }, lastAction: () => null, setAgentBusy() {} };
  app.recordMapAction('Agent created a layer', app.captureMapAction());
  assert.equal(cleared, 1);
});

test('late startup workspace restoration cannot replace a user-selected Studio camera', async () => {
  const { app } = setup();
  let finish;
  app.loadWorkspace = () => new Promise((resolve) => { finish = resolve; });
  app.initializeLocationFromUrl = () => assert.fail('Automatic location restore must not run after entering Studio');
  const work = app.bootstrap();
  app.productMode = 'studio';
  app.locationRevision = 1;
  finish();
  await work;
  assert.equal(app.workspaceReady, true);
});

test('late Geo-IP results cannot move a Studio workspace after initial navigation', async () => {
  const { app, requests } = setup();
  app.initializeLocationFromUrl = () => false;
  app.applyIpLocation = () => assert.fail('Late Geo-IP must not replace the active workspace');
  const work = app.initializeLocation();
  respond(requests[0], { ip: '192.0.2.1' });
  await new Promise(setImmediate);
  app.productMode = 'studio';
  app.locationRevision = 1;
  respond(requests[1], { data: { status: 'success', city: 'Test', country: 'Test', countryCode: 'US', lat: 50, lon: -3 } });
  await work;
});

test('missing population data is an actionable capability result, not a fake heatmap or retry failure', () => {
  const { app } = setup();
  app.agentRunId = 'population-run';
  app.agentResultSummary = 'Previous place results';
  app.handleAgentEvent({ type: 'agent.limitation', runId: 'population-run', reason: 'dataset_unavailable', message: 'Import sourced geographic population values in Studio > Data, then select Heatmap and the population field.' });
  assert.equal(app.agentRunId, '');
  assert.equal(app.agentSubmitting, false);
  assert.equal(app.elements['agent-panel'].hidden, false);
  assert.equal(app.elements['agent-feedback'].classList.contains('is-error'), false);
  assert.equal(app.elements['agent-result-summary'].textContent, 'A sourced geographic dataset is required');
  assert.equal(app.elements['agent-result-details'].hidden, false);
  assert.equal(app.elements['agent-result-details'].open, true);
  assert.equal(app.elements['agent-task-chip'].hidden, true);
  assert.equal(app.searchResults.length, 0);
  app.handleAgentEvent({ type: 'agent.map', runId: 'population-run', update: { clear: true } });
  assert.equal(app.agentRunId, '');
});

test('a capability limitation restores earlier mutations in the same agent run when guarded rollback succeeds', () => {
  const { app } = setup();
  app.agentRunId = 'limitation-run';
  app.agentSnapshot = app.captureMapAction();
  app.agentDidMutate = true;
  let restored;
  app.restoreMapAction = (snapshot) => { restored = snapshot; };
  app.handleAgentEvent({ type: 'agent.limitation', runId: 'limitation-run', reason: 'dataset_unavailable', message: 'No population data is loaded.', rolledBack: true });
  assert.equal(restored.geo.pins.length, 0);
  assert.equal(app.agentRunId, '');
  assert.equal(app.mapActions?.length || 0, 0);
});

test('web source citations render safe external links and reject executable or credential URLs', () => {
  const { app } = setup();
  app.renderAgentSources([
    { title: '<img src=x onerror=alert(1)>', url: 'https://example.org/census', publisher: 'Census office', date: '2011', readAt: '2026-01-01' },
    { title: 'Unsafe', url: 'javascript:alert(1)' }, { title: 'Private credential', url: 'https://name:password@example.org/data' },
  ]);
  assert.equal(app.elements['agent-sources'].hidden, false);
  const links = app.elements['agent-sources'].querySelectorAll('a');
  assert.equal(links.length, 1);
  assert.equal(links[0].href, 'https://example.org/census');
  assert.equal(links[0].textContent, '<img src=x onerror=alert(1)>');
  assert.equal(links[0].rel, 'noopener noreferrer');
  assert.equal(app.elements['agent-sources'].querySelectorAll('img').length, 0);
});

test('a sourced dataset can open Studio and browser rejection remains visible after completion', () => {
  const { app } = setup();
  const layer = { name: 'Population 2011', visualization: 'heatmap' };
  let focused = false;
  app.studio = { applySourcedDataset: () => layer, focusLayer: () => { focused = true; }, lastAction: () => null };
  app.setProductMode = (mode) => { app.productMode = mode; };
  assert.equal(app.applyAgentMapUpdate({ dataset: { data: {} } }), true);
  assert.equal(app.productMode, 'studio');
  assert.equal(focused, true);
  assert.equal(app.agentResultSummary, 'Population 2011 / sourced heatmap');
  app.studio.applySourcedDataset = () => { throw new Error('No features in scope'); };
  assert.equal(app.applyAgentMapUpdate({ dataset: { data: {} } }), false);
  app.showCommandResult(app.agentResultSummary, 'Dataset queued.');
  const text = (node) => [node.textContent, ...node.children.flatMap(text)].join(' ');
  assert.match(text(app.elements['agent-response']), /not applied.*No features in scope/);
});

test('plot, make, generate and map requests use the agent instead of city geocoding', async () => {
  const { app, requests, mapInstruction } = setup();
  const sent = [];
  app.startAgentRequest = async (query) => sent.push(query);
  app.resolveSearch = () => assert.fail('Map instructions must not be sent to the city geocoder');
  const queries = ['Plot a population heatmap of Noida', 'Make a population heatmap for Noida', 'Generate a population heatmap of Noida', 'Map the population of Noida'];
  for (const query of queries) {
    assert.equal(mapInstruction(query), true, query);
    app.elements['search-input'].value = query;
    app.queueSuggestions();
    assert.equal(app.elements['search-submit'].getAttribute('aria-label'), 'Ask Meridian');
    await app.submitSearch(event());
  }
  assert.deepEqual(sent, queries);
  assert.equal(requests.length, 0);
  for (const query of ['Noida', 'Maple Avenue', 'Plotinus Street', 'Generator Road']) assert.equal(mapInstruction(query), false, query);
});

const studyExtent = () => ({ name: 'Noida', bounds: [77.3, 28.45, 77.5, 28.7], source: { name: 'OpenStreetMap geocoder', url: 'https://www.openstreetmap.org/' }, caveat: 'Geocoded study extent, not an administrative boundary' });

function researchSetup() {
  const setupResult = setup();
  const { app } = setupResult;
  const sources = new Map();
  const layers = new Map([['geo-route', { id: 'geo-route', type: 'line' }]]);
  const fits = [];
  let camera = { center: [-3, 50], zoom: 8, bearing: 0, pitch: 0 };
  app.map = {
    getStyle: () => ({ layers: [...layers.values()], sources: Object.fromEntries(sources) }),
    isStyleLoaded: () => true, getLayer: (id) => layers.get(id), getSource: (id) => sources.get(id),
    addLayer(layer) { assert.equal(layers.has(layer.id), false); layers.set(layer.id, layer); },
    removeLayer: (id) => layers.delete(id),
    addSource(id, source) { assert.equal(sources.has(id), false); sources.set(id, { ...source, setData(data) { this.data = data; } }); },
    removeSource(id) { assert.equal([...layers.values()].some((layer) => layer.source === id), false); sources.delete(id); },
    getCenter: () => ({ lng: camera.center[0], lat: camera.center[1] }), getZoom: () => camera.zoom, getBearing: () => camera.bearing, getPitch: () => camera.pitch,
    fitBounds(bounds, options) { fits.push({ bounds, options }); camera.center = [(bounds[0][0] + bounds[1][0]) / 2, (bounds[0][1] + bounds[1][1]) / 2]; },
    jumpTo: (next) => { camera = next; },
  };
  app.applyTerrain = () => {};
  app.applyMapMode = () => {};
  return { ...setupResult, sources, layers, fits };
}

test('study extent previews are truthful polygons and preserve existing map content', () => {
  const { app, document, sources, layers, fits } = researchSetup();
  const pins = [place('Saved place')];
  app.geo.pins = pins;
  app.searchResults = [place('Earlier result')];
  const beforeGeo = JSON.stringify(app.geo);
  app.chooseLocation = () => assert.fail('A study preview must not reset map context');
  layers.set('studio-existing-heat', { id: 'studio-existing-heat', type: 'heatmap' });
  const area = studyExtent();
  assert.equal(app.applyAgentMapUpdate({ researchArea: area, view: { bounds: area.bounds } }), true);
  assert.equal(JSON.stringify(app.geo), beforeGeo);
  assert.equal(app.geo.pins, pins);
  assert.equal(app.searchResults.length, 1);
  assert.equal(app.productMode, 'explore');
  assert.equal(layers.has('studio-existing-heat'), true);
  const feature = sources.get('local-research-area').data.features[0];
  assert.equal(feature.geometry.type, 'Polygon');
  assert.equal(feature.properties.kind, 'study-extent');
  assert.equal(feature.properties.population, undefined);
  assert.equal(feature.geometry.coordinates[0].length, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(fits[0].bounds)), [[77.3, 28.45], [77.5, 28.7]]);
  assert.deepEqual(JSON.parse(JSON.stringify(layers.get('local-research-area-outline').paint['line-dasharray'])), [4, 3]);
  assert(layers.get('local-research-area-fill').paint['fill-opacity'] < .06);
  const label = document.getElementById('research-area-label');
  assert.equal(label.getAttribute('role'), 'status');
  assert.equal(label.getAttribute('aria-live'), 'polite');
  assert.equal(label.hidden, false);
  assert.match(label.querySelector('strong').textContent, /Study area.*Noida/);
  assert.match(label.querySelector('small').textContent, /not an administrative boundary/);
  assert.equal(label.querySelector('a').rel, 'noopener noreferrer');
  area.bounds[0] = 0;
  assert.equal(app.researchArea.bounds[0], 77.3, 'The preview owns a copy of its validated bounds');
});

test('study preview validation rejects malformed extents and splits antimeridian boxes', () => {
  const { app, sources, fits } = researchSetup();
  assert.equal(app.applyAgentMapUpdate({ researchArea: studyExtent() }), true);
  const original = JSON.stringify(app.researchArea);
  for (const bounds of [[NaN, 0, 1, 1], [0, 0, Infinity, 1], [null, 0, 1, 1], ['0', 0, 1, 1], [-181, 0, 1, 1], [0, -91, 1, 1], [0, 0, 181, 1], [0, 0, 1, 91], [0, 1, 1, 0], [0, 0, 0, 1], [180, 0, -180, 1], [0, 0, 1]]) {
    assert.equal(app.applyAgentMapUpdate({ researchArea: { ...studyExtent(), bounds } }), false);
    assert.equal(JSON.stringify(app.researchArea), original);
  }
  assert.equal(fits.length, 1);
  assert.equal(app.applyAgentMapUpdate({ researchArea: { ...studyExtent(), name: '' } }), false);
  assert.equal(app.applyAgentMapUpdate({ researchArea: { name: 'Dateline study', bounds: [170, -5, -175, 5] } }), true);
  const geometry = sources.get('local-research-area').data.features[0].geometry;
  assert.equal(geometry.type, 'MultiPolygon');
  assert.equal(geometry.coordinates.length, 2);
  for (const [ring] of geometry.coordinates) assert(Math.max(...ring.map((p) => p[0])) - Math.min(...ring.map((p) => p[0])) <= 10);
  assert.deepEqual(JSON.parse(JSON.stringify(fits.at(-1).bounds)), [[170, -5], [185, 5]]);
});

test('study previews replace cleanly, survive style reloads, and clear with map context', () => {
  const { app, document, sources, layers } = researchSetup();
  app.applyAgentMapUpdate({ researchArea: studyExtent() });
  app.applyAgentMapUpdate({ researchArea: { ...studyExtent(), name: '<img src=x>', source: { name: 'Unsafe source', url: 'javascript:alert(1)' } } });
  assert.equal(document.getElementById('research-area-label').querySelector('a'), null);
  assert.equal(document.getElementById('research-area-label').querySelector('img'), null);
  const data = JSON.stringify(sources.get('local-research-area').data);
  sources.clear(); layers.clear();
  app.renderResearchArea();
  assert.equal(JSON.stringify(sources.get('local-research-area').data), data);
  assert.equal(layers.size, 2);
  assert.equal(document.querySelectorAll('.research-area-label').length, 1);
  app.applyAgentMapUpdate({ researchArea: null });
  assert.equal(sources.has('local-research-area'), false);
  assert.equal(layers.size, 0);
  assert.equal(document.getElementById('research-area-label').hidden, true);
  app.applyAgentMapUpdate({ researchArea: studyExtent() });
  app.chooseLocation(place('Different context'));
  assert.equal(app.researchArea, null);
  assert.equal(sources.has('local-research-area'), false);
  app.applyAgentMapUpdate({ researchArea: studyExtent() });
  app.clearWorkspaceLocal();
  assert.equal(app.researchArea, null);
  assert.equal(sources.has('local-research-area'), false);
});

test('partial research keeps the study extent and offers local undo without inventing a dataset', async () => {
  const { app, sources } = researchSetup();
  app.agentRunId = 'research-run';
  app.agentLastMessage = 'Plot a population heatmap of Noida';
  app.agentSnapshot = app.captureMapAction();
  app.handleAgentEvent({ type: 'agent.map', runId: app.agentRunId, update: { researchArea: studyExtent() } });
  assert.equal(app.agentDidMutate, true);
  assert.match(app.elements['agent-task-label'].textContent, /Study extent shown/);
  app.handleAgentEvent({ type: 'agent.limitation', runId: app.agentRunId, reason: 'dataset_unavailable', contextOnly: true, message: 'The source could not provide a usable raster window.' });
  assert.equal(sources.has('local-research-area'), true);
  assert.equal(app.productMode, 'explore');
  assert.equal(app.searchResults.length, 0);
  assert.match(app.elements['agent-result-summary'].textContent, /Study area shown.*data unavailable/);
  assert.match(app.agentActivity.tool, /Study extent kept.*no data layer/);
  assert.equal(app.mapActions.length, 1);
  await app.undoMapAction();
  assert.equal(app.researchArea, null);
  assert.equal(sources.has('local-research-area'), false);
});

test('cancelled, failed and rolled-back runs restore preview state with the original map snapshot', () => {
  for (const terminal of [{ type: 'agent.cancelled' }, { type: 'agent.failed', error: 'Source failed' }, { type: 'agent.limitation', contextOnly: true, rolledBack: true }]) {
    const { app, sources } = researchSetup();
    app.applyAgentMapUpdate({ researchArea: { ...studyExtent(), name: 'Previous study' } });
    app.agentRunId = 'research-run';
    app.agentSnapshot = app.captureMapAction();
    const original = JSON.stringify(app.agentSnapshot.researchArea);
    app.handleAgentEvent({ type: 'agent.map', runId: app.agentRunId, update: { researchArea: studyExtent() } });
    app.handleAgentEvent({ ...terminal, runId: app.agentRunId });
    assert.equal(JSON.stringify(app.researchArea), original, terminal.type);
    assert.equal(sources.get('local-research-area').data.features[0].properties.name, 'Previous study');
    assert.equal(app.mapActions?.length || 0, 0);
  }
});

test('browser dataset rejection is not announced as an applied map update or successful completion', () => {
  const { app } = setup();
  app.studio = { applySourcedDataset() { throw new Error('No source observations in scope'); }, snapshot: () => null, lastAction: () => null, setAgentBusy() {} };
  app.agentRunId = 'rejected-run';
  app.agentSnapshot = app.captureMapAction();
  app.agentDidMutate = false;
  app.handleAgentEvent({ type: 'agent.map', runId: app.agentRunId, update: { dataset: { data: {} } } });
  assert.equal(app.productMode, 'explore');
  assert.equal(app.agentDidMutate, false);
  assert.match(app.elements['agent-task-label'].textContent, /not applied.*No source observations/);
  assert.notEqual(app.agentActivity.tool, 'Map changes applied');
  app.handleAgentEvent({ type: 'agent.completed', runId: app.agentRunId, message: 'The source heatmap was sent for display.' });
  assert.match(app.elements['agent-result-summary'].textContent, /not applied.*No source observations/);
  assert.equal(app.elements['agent-result-details'].open, true);
  assert.equal(app.agentActivity.tool, 'Map not fully applied');
  assert.equal(app.mapActions?.length || 0, 0);
});
