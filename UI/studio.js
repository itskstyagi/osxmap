import { PALETTES, VISUALIZATIONS, normalizeCollection, fieldsFor, boundsFor, makeLayer, filterCollection, metricsFor, renderCollection, temporalValues, exampleCollection } from './studio-data.js';

const STORAGE_KEY = 'meridian.studio.v1';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 32 * 1024 * 1024;
const MAX_LAYERS = 30;
const EMPTY = { type: 'FeatureCollection', features: [] };
const clone = (value) => JSON.parse(JSON.stringify(value));
const id = () => crypto.randomUUID();
const motion = (duration) => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : duration;
const number = (value) => Number.isFinite(value) ? value.toLocaleString(undefined, { maximumFractionDigits: 2 }) : 'Unavailable';
const numeric = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)) ? Number(value) : null;

function element(tag, text = '', className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  return node;
}

function actionButton(text, label, action, disabled = false) {
  const button = element('button', text);
  button.type = 'button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.addEventListener('click', action);
  return button;
}

function validBounds(value) {
  return Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) &&
    Math.abs(value[0]) <= 180 && Math.abs(value[2]) <= 180 && value[1] >= -90 && value[3] <= 90 && value[1] < value[3];
}

export function createWorkspace(name = 'Untitled workspace') {
  return {
    id: id(), name, description: '', createdAt: Date.now(), updatedAt: Date.now(),
    camera: null, basemap: null, theme: null, terrainEnabled: false,
    datasets: {}, layers: [], selectedLayerId: '', region: null, time: null, scope: 'viewport',
    analyses: [], insights: [], history: [], future: [],
  };
}

function snapshot(workspace) {
  const { datasets, history, future, ...state } = workspace;
  return clone({ ...state, layers: state.layers.map(({ renderError, ...layer }) => layer) });
}

export function validateWorkspace(value, validatedDatasets = null) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.layers) || !value.datasets || value.layers.length > MAX_LAYERS) throw new Error('This is not a valid Meridian workspace.');
  const workspace = createWorkspace(String(value.name || 'Imported workspace').slice(0, 80));
  if (typeof value.id === 'string' && /^[\w-]{1,80}$/.test(value.id)) workspace.id = value.id;
  workspace.description = String(value.description || '').slice(0, 500);
  const datasets = Object.entries(value.datasets);
  if (datasets.length > 60) throw new Error('A workspace can contain at most 60 retained datasets.');
  for (const [key, collection] of datasets) {
    if (!/^[\w-]{1,100}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid dataset identifier.');
    workspace.datasets[key] = validatedDatasets?.[key] || normalizeCollection(collection);
  }
  const seen = new Set();
  for (const saved of value.layers) {
    if (!saved || !/^[\w-]{1,100}$/.test(saved.id) || seen.has(saved.id) || !Object.hasOwn(workspace.datasets, saved.datasetId)) throw new Error('A saved layer has missing data or an invalid identifier.');
    seen.add(saved.id);
    const source = saved.source && typeof saved.source === 'object' ? saved.source : { name: 'Imported workspace' };
    const normalized = makeLayer(workspace.datasets[saved.datasetId], { name: String(saved.name || 'Layer').slice(0, 120), source });
    const available = fieldsFor(workspace.datasets[saved.datasetId]);
    delete normalized.data;
    workspace.layers.push({
      ...normalized, id: saved.id, datasetId: saved.datasetId,
      visualization: Object.hasOwn(VISUALIZATIONS, saved.visualization) ? saved.visualization : normalized.visualization,
      palette: Object.hasOwn(PALETTES, saved.palette) ? saved.palette : 'olive',
      opacity: Number.isFinite(saved.opacity) ? Math.max(0, Math.min(1, saved.opacity)) : .75,
      visible: saved.visible !== false, locked: saved.locked === true,
      field: available.numeric.includes(saved.field) ? saved.field : '', units: String(saved.units || '').slice(0, 60),
      timeField: available.temporal.includes(saved.timeField) ? saved.timeField : '',
      filters: {
        categoryField: available.categorical.includes(saved.filters?.categoryField) ? saved.filters.categoryField : '',
        category: ['string', 'boolean', 'number'].includes(typeof saved.filters?.category) ? saved.filters.category : '',
        min: numeric(saved.filters?.min), max: numeric(saved.filters?.max), viewport: saved.filters?.viewport === true,
      },
      scopeBounds: validBounds(saved.scopeBounds) ? saved.scopeBounds : null,
      ignoreRegion: saved.ignoreRegion === true,
    });
  }
  workspace.selectedLayerId = seen.has(value.selectedLayerId) ? value.selectedLayerId : workspace.layers[0]?.id || '';
  workspace.region = validBounds(value.region) ? value.region : null;
  workspace.scope = ['viewport', 'selection', 'layer', 'workspace'].includes(value.scope) ? value.scope : 'viewport';
  workspace.time = typeof value.time === 'string' ? value.time.slice(0, 40) : null;
  workspace.basemap = ['satellite', 'route', 'terrain'].includes(value.basemap) ? value.basemap : null;
  workspace.theme = ['dark', 'light'].includes(value.theme) ? value.theme : null;
  workspace.terrainEnabled = value.terrainEnabled === true;
  const camera = value.camera;
  if (Array.isArray(camera?.center) && camera.center.length === 2 && camera.center.every(Number.isFinite) && Math.abs(camera.center[0]) <= 180 && Math.abs(camera.center[1]) <= 85.05113 && Number.isFinite(camera.zoom)) {
    workspace.camera = { center: camera.center, zoom: Math.max(0, Math.min(22, camera.zoom)), bearing: Number.isFinite(camera.bearing) ? camera.bearing : 0, pitch: Math.max(0, Math.min(78, numeric(camera.pitch) || 0)) };
  }
  workspace.createdAt = Number.isFinite(value.createdAt) ? value.createdAt : Date.now();
  workspace.updatedAt = Number.isFinite(value.updatedAt) ? value.updatedAt : Date.now();
  for (const key of ['analyses', 'insights']) workspace[key] = Array.isArray(value[key]) ? value[key].slice(-40).filter((entry) => entry && typeof entry === 'object').map((entry) => ({
    id: String(entry.id || id()).slice(0, 100), label: String(entry.label || '').slice(0, 160), explanation: String(entry.explanation || '').slice(0, 1200),
    layerId: String(entry.layerId || '').slice(0, 100), time: numeric(entry.time) || Date.now(),
  })) : [];
  // Validate historical snapshots independently before making them actionable.
  for (const saved of Array.isArray(value.history) ? value.history.slice(-20) : []) {
    try {
      const before = validateWorkspace({ ...saved.before, datasets: workspace.datasets, history: [] }, workspace.datasets);
      const after = validateWorkspace({ ...saved.after, datasets: workspace.datasets, history: [] }, workspace.datasets);
      workspace.history.push({ label: String(saved.label || 'Workspace change').slice(0, 160), time: numeric(saved.time) || Date.now(), before: snapshot(before), after: snapshot(after) });
    } catch { /* An invalid historical entry must not corrupt the current project. */ }
  }
  return workspace;
}

export function styleLayers(layer, rendered) {
  const source = `studio-data-${layer.id}`;
  const colors = PALETTES[layer.palette]?.colors || PALETTES.olive.colors;
  const middle = colors[Math.floor(colors.length / 2)];
  const color = rendered.legend?.categorical?.length
    ? ['match', ['coalesce', ['get', '__category'], ''], ...rendered.legend.categorical.flatMap((category) => [category.value, category.color]), '#a7aca4']
    : ['interpolate', ['linear'], ['coalesce', ['get', '__weight'], .5], ...colors.flatMap((color, index) => [index / (colors.length - 1), color])];
  const opacity = layer.opacity;
  const base = { source, layout: { visibility: layer.visible ? 'visible' : 'none' } };
  const prefix = `studio-${layer.id}`;
  const types = new Set([rendered.geometryType, ...rendered.data.features.map((feature) => feature.geometry?.type)]);
  if (layer.visualization === 'heatmap') return [{
    ...base, id: `${prefix}-heat`, type: 'heatmap', paint: {
      'heatmap-weight': ['coalesce', ['get', '__heatWeight'], 0], 'heatmap-intensity': 1,
      'heatmap-radius': ['interpolate', ['linear'], ['zoom'], 5, 12, 15, 44], 'heatmap-opacity': opacity,
      'heatmap-color': ['interpolate', ['linear'], ['heatmap-density'], 0, 'rgba(0,0,0,0)', .15, colors[0], .5, middle, 1, colors.at(-1)],
    },
  }];
  if (types.has('Polygon') || types.has('MultiPolygon')) {
    const extruded = ['extrusion', 'surface'].includes(layer.visualization);
    return [{
      ...base, id: `${prefix}-fill`, type: extruded ? 'fill-extrusion' : 'fill',
      paint: extruded ? { 'fill-extrusion-color': color, 'fill-extrusion-opacity': opacity, 'fill-extrusion-height': ['max', 0, ['coalesce', ['get', '__height'], 0]], 'fill-extrusion-base': 0, 'fill-extrusion-vertical-gradient': true }
        : { 'fill-color': color, 'fill-opacity': opacity, 'fill-outline-color': middle },
    }];
  }
  if (types.has('LineString') || types.has('MultiLineString')) {
    const layers = [{ ...base, id: `${prefix}-line`, type: 'line', layout: { ...base.layout, 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': color, 'line-opacity': opacity, 'line-width': layer.visualization === 'contours' ? 1.3 : ['interpolate', ['linear'], ['coalesce', ['get', '__weight'], .5], 0, 1.5, 1, 4] } }];
    if (layer.visualization === 'flow') layers.push({ ...base, id: `${prefix}-direction`, type: 'symbol', layout: { ...base.layout, 'symbol-placement': 'line', 'symbol-spacing': 110, 'text-field': '>', 'text-font': ['Noto Sans Regular'], 'text-size': 14, 'text-rotation-alignment': 'map', 'text-keep-upright': false }, paint: { 'text-color': colors.at(-1), 'text-opacity': opacity, 'text-halo-color': '#171b18', 'text-halo-width': 1 } });
    return layers;
  }
  return [{
    ...base, id: `${prefix}-point`, type: 'circle', paint: {
      'circle-color': color, 'circle-opacity': opacity,
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 3, 15, layer.visualization === 'tactical' ? 9 : 7],
      'circle-stroke-width': layer.visualization === 'tactical' ? 2 : 1, 'circle-stroke-color': '#f0efe8', 'circle-stroke-opacity': opacity,
    },
  }];
}

export class MeridianStudio {
  constructor(app) {
    this.app = app;
    this.el = app.elements;
    this.enabled = false;
    this.projects = [];
    this.cache = new Map();
    this.tab = 'layers';
    this.pane = 'left';
    this.rightOpen = window.innerWidth > 1100;
    this.leftOpen = true;
    this.tool = '';
    this.playTimer = null;
    this.opacityBefore = null;
    this.selectionPoints = [];
    this.compareMap = null;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved?.version === 1 && Array.isArray(saved.workspaces)) {
        this.projects = saved.workspaces.slice(0, 8).map(validateWorkspace);
        this.workspace = this.projects.find((project) => project.id === saved.activeId);
      }
    } catch { this.storageWarning = 'Saved Studio data could not be read. Import a workspace backup to restore it.'; }
    if (!this.projects.length) this.projects.push(createWorkspace());
    this.workspace ||= this.projects[0];
    this.originalControls = ['.map-mode-panel', '.map-controls', '#terrain-controls'].map((selector) => {
      const node = document.querySelector(selector);
      return { node, parent: node.parentNode, next: node.nextSibling };
    });
    this.bind();
    this.moveHandler = () => {
      if (this.enabled) {
        this.captureCamera();
        clearTimeout(this.renderTimer);
        this.renderTimer = setTimeout(() => { this.renderMap(); this.renderInsights(); this.save(); }, 160);
      }
    };
    this.syncCompareHandler = () => this.syncCompare();
    this.styleHandler = () => { this.cache.clear(); this.renderMap(); };
    app.map.on('moveend', this.moveHandler);
    app.map.on('move', this.syncCompareHandler);
    app.map.on('style.load', this.styleHandler);
    this.resizeHandler = () => {
      this.syncPanels();
      this.compareMap?.resize();
      this.syncCompare();
    };
    window.addEventListener('resize', this.resizeHandler);
    this.render();
  }

  bind() {
    const on = (name, event, callback) => this.el[name]?.addEventListener(event, callback);
    on('studio-workspace-select', 'change', () => this.switchWorkspace(this.el['studio-workspace-select'].value));
    on('studio-workspace-name', 'change', () => this.mutate('Rename workspace', () => { this.workspace.name = this.el['studio-workspace-name'].value.trim().slice(0, 80) || 'Untitled workspace'; }));
    on('studio-workspace-description', 'change', () => this.mutate('Update workspace description', () => { this.workspace.description = this.el['studio-workspace-description'].value.trim().slice(0, 500); }));
    on('studio-workspace-new', 'click', () => this.newProject());
    on('studio-workspace-duplicate', 'click', () => this.newProject(true));
    on('studio-workspace-delete', 'click', () => {
      if (this.app.agentSubmitting || this.app.agentRunId || this.app.undoing) return;
      this.el['studio-delete-name'].textContent = this.workspace.name;
      this.el['studio-delete-dialog'].returnValue = '';
      this.el['studio-delete-dialog'].showModal();
    });
    on('studio-delete-dialog', 'close', () => { if (this.el['studio-delete-dialog'].returnValue === 'delete') this.deleteProject(); });
    on('studio-workspace-export', 'click', () => this.exportWorkspace());
    on('studio-workspace-import-trigger', 'click', () => this.el['studio-workspace-import'].click());
    on('studio-workspace-import', 'change', (event) => this.importWorkspace(event.target.files?.[0]));
    on('studio-import-trigger', 'click', () => this.el['studio-import'].click());
    on('studio-import', 'change', (event) => this.importDataset(event.target.files?.[0]));
    on('studio-add-map-data', 'click', () => this.addMapData(this.el['studio-map-data-kind'].value));
    document.querySelectorAll('[data-studio-template]').forEach((button) => button.addEventListener('click', () => this.addExample(button.dataset.studioTemplate)));
    document.querySelectorAll('[data-studio-tab]').forEach((button) => {
      button.addEventListener('click', () => this.setTab(button.dataset.studioTab));
      button.addEventListener('keydown', (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const tabs = ['layers', 'data', 'visualize', 'filters'];
        const index = tabs.indexOf(this.tab);
        this.setTab(tabs[event.key === 'Home' ? 0 : event.key === 'End' ? 3 : (index + (event.key === 'ArrowRight' ? 1 : 3)) % 4]);
        this.el[`studio-tab-${this.tab}`].focus();
      });
    });
    document.querySelectorAll('[data-studio-tab-target]').forEach((button) => button.addEventListener('click', () => this.setTab(button.dataset.studioTabTarget)));
    on('studio-controls-toggle', 'click', () => { this.leftOpen = !(this.leftOpen && (window.innerWidth > 900 || this.pane === 'left')); this.pane = this.leftOpen ? 'left' : ''; this.syncPanels(); });
    on('studio-insights-toggle', 'click', () => { this.rightOpen = !(this.rightOpen && (window.innerWidth > 900 || this.pane === 'right')); this.pane = this.rightOpen ? 'right' : ''; this.syncPanels(); });
    on('studio-insights-close', 'click', () => { this.rightOpen = false; this.pane = ''; this.syncPanels(); this.el['studio-insights-toggle'].focus(); });
    on('studio-inspector-close', 'click', () => this.closeInspector());
    on('studio-undo', 'click', () => this.app.undoMapAction());
    on('studio-redo', 'click', () => this.redo());
    for (const [control, property] of [['studio-visualization', 'visualization'], ['studio-value-field', 'field'], ['studio-palette', 'palette'], ['studio-time-field', 'timeField']]) {
      on(control, 'change', () => this.updateLayer({ [property]: this.el[control].value }, `Change ${property}`));
    }
    on('studio-units', 'change', () => this.updateLayer({ units: this.el['studio-units'].value.trim().slice(0, 60) }, 'Set measurement unit'));
    on('studio-category-field', 'change', () => this.updateLayer({ filters: { categoryField: this.el['studio-category-field'].value, category: '' } }, 'Change category field'));
    on('studio-opacity', 'input', () => {
      const layer = this.selectedLayer();
      if (!layer || layer.locked || this.app.agentSubmitting || this.app.agentRunId || this.app.undoing) return;
      this.opacityBefore ||= this.snapshot();
      layer.opacity = Number(this.el['studio-opacity'].value) / 100;
      this.el['studio-opacity-value'].textContent = `${Math.round(layer.opacity * 100)}%`;
      if (!this.opacityFrame) this.opacityFrame = requestAnimationFrame(() => { this.opacityFrame = null; this.renderMap(); });
    });
    on('studio-opacity', 'change', () => {
      if (!this.opacityBefore) return;
      this.commit('Adjust layer opacity', this.opacityBefore);
      this.opacityBefore = null;
    });
    on('studio-filter-category', 'change', () => this.updateLayer({ filters: { category: this.el['studio-filter-category'].value ? JSON.parse(this.el['studio-filter-category'].value) : '' } }, 'Filter category'));
    for (const key of ['min', 'max']) on(`studio-filter-${key}`, 'change', () => this.updateLayer({ filters: { [key]: numeric(this.el[`studio-filter-${key}`].value) } }, 'Filter numeric values'));
    on('studio-filter-viewport', 'change', () => this.updateLayer({ filters: { viewport: this.el['studio-filter-viewport'].checked }, scopeBounds: null }, 'Filter to current viewport'));
    on('studio-filters-reset', 'click', () => this.updateLayer({ filters: { category: '', min: null, max: null, viewport: false }, scopeBounds: null, ignoreRegion: false }, 'Reset layer filters'));
    on('studio-region-select', 'click', () => this.startTool('region'));
    on('studio-region-clear', 'click', () => this.mutate('Clear region selection', () => { this.workspace.region = null; this.workspace.scope = 'viewport'; }));
    on('studio-scope', 'change', () => {
      const scope = this.el['studio-scope'].value;
      if (scope === 'selection' && !this.workspace.region) { this.startTool('region'); this.el['studio-scope'].value = this.workspace.scope; return; }
      if (scope === 'layer' && !this.selectedLayer()) { this.status('Select a layer before using active-layer scope.', true); this.el['studio-scope'].value = this.workspace.scope; return; }
      this.workspace.scope = scope;
      this.save();
    });
    document.querySelectorAll('[data-studio-tool]').forEach((button) => button.addEventListener('click', () => button.dataset.studioTool === 'compare' ? this.startCompare() : this.startTool(button.dataset.studioTool)));
    document.querySelectorAll('[data-studio-analysis]').forEach((button) => button.addEventListener('click', () => {
      try { this.applyOperation({ action: button.dataset.studioAnalysis === 'summary' ? 'summarize' : button.dataset.studioAnalysis, layerId: this.workspace.selectedLayerId }); }
      catch (error) { this.status(error.message, true); }
    }));
    on('studio-timeline-range', 'input', () => { this.stopPlayback(); this.setTime(Number(this.el['studio-timeline-range'].value)); });
    on('studio-timeline-play', 'click', () => this.playTimer ? this.stopPlayback() : this.playTimeline());
    on('studio-compare-close', 'click', () => this.stopCompare());
    on('studio-compare-range', 'input', () => this.syncCompare());
    on('studio-annotation-dialog', 'close', () => {
      if (this.el['studio-annotation-dialog'].returnValue !== 'save' || !this.annotationPoint) return;
      const name = this.el['studio-annotation-name'].value.trim().slice(0, 120);
      if (!name) return;
      const data = { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: this.annotationPoint }, properties: { name, note: this.el['studio-annotation-note'].value.trim().slice(0, 1000) } }] };
      this.addLayer(data, { name, source: { name: 'User annotation', caveat: 'User-selected coordinate and note; not independently verified.' } });
      this.annotationPoint = null;
    });
  }

  selectedLayer() { return this.workspace.layers.find((layer) => layer.id === this.workspace.selectedLayerId); }
  hydrated(layer) { return { ...layer, data: this.workspace.datasets[layer.datasetId] }; }
  snapshot() { return snapshot(this.workspace); }
  lastAction() { return this.workspace.history.at(-1); }

  restoreSnapshot(state, { restoreCamera = true } = {}) {
    const workspace = this.projects.find((project) => project.id === state.id);
    if (!workspace) throw new Error('The original workspace is no longer available.');
    Object.assign(workspace, clone(state));
    this.workspace = workspace;
    if (restoreCamera && this.enabled) this.restoreAppearance();
    this.cache.clear();
    this.render();
    this.save();
  }

  commit(label, before) {
    this.workspace.updatedAt = Date.now();
    const history = [...this.workspace.history, { label, time: Date.now(), before, after: this.snapshot() }].slice(-20);
    if (new Blob([JSON.stringify({ meridianStudio: 1, workspace: { ...this.workspace, history, future: [] } })]).size > MAX_WORKSPACE_BYTES) throw new Error('This workspace would exceed the 32 MB backup limit. Use a separate workspace for additional data.');
    this.workspace.history = history;
    this.workspace.future = [];
    this.cache.clear();
    this.render();
    this.save();
    this.app.updateActionChip();
  }

  mutate(label, operation, { record = true } = {}) {
    if (this.app.undoing || record && (this.app.agentSubmitting || this.app.agentRunId)) {
      this.status('Wait for the current map operation to finish before editing the workspace.', true);
      return false;
    }
    const before = this.snapshot();
    const datasetIds = new Set(Object.keys(this.workspace.datasets));
    try {
      operation();
      if (record) this.commit(label, before);
      else {
        if (new Blob([JSON.stringify({ meridianStudio: 1, workspace: this.workspace })]).size > MAX_WORKSPACE_BYTES) throw new Error('This workspace would exceed its 32 MB backup limit.');
        this.workspace.updatedAt = Date.now(); this.cache.clear(); this.render(); this.save();
      }
    } catch (error) {
      Object.assign(this.workspace, before);
      for (const key of Object.keys(this.workspace.datasets)) if (!datasetIds.has(key)) delete this.workspace.datasets[key];
      this.status(error.message, true);
      this.render();
      return false;
    }
    return true;
  }

  undo() {
    if (this.app.agentSubmitting || this.app.agentRunId || this.app.undoing) return;
    const entry = this.workspace.history.pop();
    if (!entry) return this.status('There is no Studio change to undo.');
    this.workspace.future.push(entry);
    this.restoreSnapshot(entry.before);
    this.status(`Undid: ${entry.label}`);
    this.app.updateActionChip();
  }

  redo() {
    if (this.app.agentSubmitting || this.app.agentRunId || this.app.undoing) return;
    const entry = this.workspace.future.pop();
    if (!entry) return this.status('There is no Studio change to redo.');
    this.workspace.history.push(entry);
    this.restoreSnapshot(entry.after);
    this.status(`Redid: ${entry.label}`);
    this.app.updateActionChip();
  }

  discardRedo() {
    if (!this.workspace.future.length) return;
    this.workspace.future = [];
    this.renderHistory();
    this.save();
  }

  save() {
    this.el['studio-save-status'].textContent = 'Saving...';
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flushSave(), 350);
  }

  flushSave() {
    clearTimeout(this.saveTimer);
    const retained = new Set(this.workspace.layers.map((layer) => layer.datasetId));
    const snapshots = [...this.workspace.history, ...this.workspace.future].flatMap((entry) => [entry.before, entry.after]);
    snapshots.push(...(this.app.mapActions || []).map((entry) => entry.before.studio).filter((state) => state?.id === this.workspace.id));
    if (this.app.agentSnapshot?.studio?.id === this.workspace.id) snapshots.push(this.app.agentSnapshot.studio);
    for (const state of snapshots) for (const layer of state.layers || []) retained.add(layer.datasetId);
    for (const key of Object.keys(this.workspace.datasets)) if (!retained.has(key)) delete this.workspace.datasets[key];
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, activeId: this.workspace.id, workspaces: this.projects }));
      this.el['studio-save-status'].textContent = 'Saved on this device';
      this.el['studio-save-status'].classList.remove('is-error');
    } catch {
      this.el['studio-save-status'].textContent = 'Memory only. Export a backup.';
      this.el['studio-save-status'].classList.add('is-error');
    }
  }

  status(message, error = false) {
    this.el['studio-import-status'].textContent = message;
    this.el['studio-import-status'].classList.toggle('is-error', error);
    this.app.setGeoStatus(message, error);
  }

  captureCamera() {
    const map = this.app.map;
    const center = map.getCenter();
    this.workspace.camera = { center: [center.lng, center.lat], zoom: map.getZoom(), pitch: map.getPitch(), bearing: map.getBearing() };
    this.workspace.basemap = this.app.mapMode;
    this.workspace.theme = this.app.theme;
    this.workspace.terrainEnabled = this.app.terrainEnabled;
  }

  restoreAppearance() {
    if (!this.workspace.camera) return;
    const saved = { camera: clone(this.workspace.camera), basemap: this.workspace.basemap, theme: this.workspace.theme, terrain: this.workspace.terrainEnabled };
    this.restoringAppearance = true;
    try {
      if (saved.basemap) this.app.setMapMode(saved.basemap);
      if (saved.theme) this.app.setTheme(saved.theme);
      this.app.terrainEnabled = saved.terrain;
      this.app.applyTerrain();
      this.app.map.jumpTo(saved.camera);
    } finally { this.restoringAppearance = false; }
  }

  activate(enabled) {
    if (!enabled) { this.captureCamera(); this.stopPlayback(); this.stopCompare(); this.cancelTool(); this.closeInspector(); this.save(); }
    this.enabled = enabled;
    this.el['studio-shell'].hidden = !enabled;
    this.el['studio-command-context'].hidden = !enabled;
    if (enabled) {
      for (const { node } of this.originalControls) this.el['studio-map-controls'].append(node);
      if (this.workspace.camera && !this.app.agentSubmitting && !this.app.agentRunId) {
        this.restoreAppearance();
      } else this.captureCamera();
      this.leftOpen = true;
      this.pane = 'left';
      if (this.storageWarning) { this.status(this.storageWarning, true); this.storageWarning = ''; }
    } else {
      for (const { node, parent, next } of [...this.originalControls].reverse()) parent.insertBefore(node, next?.parentNode === parent ? next : null);
    }
    this.render();
    this.save();
  }

  onMapAppearanceChange() {
    if (this.enabled && !this.restoringAppearance) { this.captureCamera(); this.save(); }
  }

  setPane(pane) {
    this.pane = pane;
    if (pane === 'left') this.leftOpen = true;
    if (pane === 'right') this.rightOpen = true;
    this.syncPanels();
  }

  closePanels() { this.pane = ''; this.leftOpen = false; this.rightOpen = false; this.syncPanels(); }

  syncPanels() {
    const narrow = window.innerWidth <= 900;
    const left = this.leftOpen && (!narrow || this.pane === 'left');
    const right = this.rightOpen && (!narrow || this.pane === 'right');
    document.documentElement.dataset.studioPane = this.pane;
    this.el['studio-left-panel'].hidden = !left;
    this.el['studio-right-panel'].hidden = !right;
    this.el['studio-controls-toggle'].setAttribute('aria-expanded', String(left));
    this.el['studio-insights-toggle'].setAttribute('aria-expanded', String(right));
  }

  setTab(tab) {
    if (!['layers', 'data', 'visualize', 'filters'].includes(tab)) return;
    this.tab = tab;
    this.setPane('left');
    for (const name of ['layers', 'data', 'visualize', 'filters']) {
      this.el[`studio-panel-${name}`].hidden = tab !== name;
      this.el[`studio-tab-${name}`].setAttribute('aria-selected', String(tab === name));
      this.el[`studio-tab-${name}`].tabIndex = tab === name ? 0 : -1;
    }
  }

  setAgentBusy(active) {
    active ||= Boolean(this.app.undoing);
    this.el['studio-workspace-select'].disabled = active;
    this.el['studio-workspace-name'].disabled = active;
    this.el['studio-workspace-description'].disabled = active;
    this.el['studio-viz-settings'].disabled = active || Boolean(this.selectedLayer()?.locked);
    for (const control of ['studio-workspace-new', 'studio-workspace-duplicate', 'studio-workspace-delete', 'studio-workspace-import-trigger', 'studio-import-trigger', 'studio-add-map-data', 'studio-timeline-play', 'studio-timeline-range']) this.el[control].disabled = active;
    this.renderHistory();
  }

  newProject(duplicate = false) {
    if (this.app.agentSubmitting || this.app.agentRunId || this.app.undoing) return this.status('Wait for the active operation or stop it before changing projects.', true);
    if (this.projects.length >= 8) return this.status('This device holds eight workspaces. Export a backup and delete an unused project before adding another.', true);
    this.captureCamera();
    const project = duplicate ? clone(this.workspace) : createWorkspace();
    if (duplicate) {
      project.id = id();
      project.name = `${project.name} copy`.slice(0, 80);
      project.history = [];
      project.future = [];
      project.createdAt = Date.now();
      project.updatedAt = Date.now();
    }
    this.projects.push(project);
    this.switchWorkspace(project.id);
    this.el['studio-workspace-name'].focus();
    this.el['studio-workspace-name'].select();
  }

  deleteProject() {
    if (this.app.agentSubmitting || this.app.agentRunId || this.app.undoing) return;
    const removed = this.workspace;
    this.projects = this.projects.filter((project) => project !== removed);
    if (!this.projects.length) this.projects.push(createWorkspace());
    this.app.mapActions = (this.app.mapActions || []).filter((action) => action.before.studio?.id !== removed.id);
    this.switchWorkspace(this.projects[0].id);
    this.flushSave();
    this.status('The local Studio project was deleted. Explore pins, routes, and provider caches were not changed.');
  }

  switchWorkspace(projectId) {
    if (this.app.agentSubmitting || this.app.agentRunId || this.app.undoing) {
      this.el['studio-workspace-select'].value = this.workspace.id;
      return this.status('Wait for the active operation or stop it before changing projects.', true);
    }
    const project = this.projects.find((candidate) => candidate.id === projectId);
    if (!project || project === this.workspace) return;
    this.captureCamera();
    this.stopCompare();
    this.stopPlayback();
    this.cancelTool();
    this.closeInspector();
    this.workspace = project;
    this.cache.clear();
    if (this.enabled) this.activate(true);
    this.render();
    this.save();
    this.app.updateActionChip();
  }

  async readJsonFile(file, limit = MAX_FILE_BYTES) {
    if (!file) return null;
    if (file.size > limit) throw new Error(`Files must be smaller than ${limit / (1024 * 1024)} MB. Split large datasets between workspaces before importing.`);
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch { throw new Error('The file is not valid JSON. Export a GeoJSON FeatureCollection and try again.'); }
    return parsed;
  }

  async importDataset(file) {
    if (!file) return;
    const projectId = this.workspace.id;
    this.status('Reading and validating local GeoJSON...');
    try {
      const collection = normalizeCollection(await this.readJsonFile(file));
      if (this.workspace.id !== projectId) throw new Error('The workspace changed while reading. Import the file again in the intended project.');
      const added = this.addLayer(collection, {
        name: file.name.replace(/\.(?:geo)?json$/i, ''), units: this.el['studio-import-units'].value.trim(),
        source: { name: this.el['studio-import-source'].value.trim() || file.name, caveat: 'User-provided local GeoJSON. Source accuracy and units are not independently verified.' },
      });
      if (added) this.status(`Imported ${collection.features.length.toLocaleString()} features. Data stays on this device; export a workspace for a portable backup.`);
    } catch (error) { this.status(error.message, true); }
    finally { this.el['studio-import'].value = ''; }
  }

  async importWorkspace(file) {
    if (!file) return;
    if (this.app.agentSubmitting || this.app.agentRunId || this.app.undoing) return this.status('Finish the active operation before importing a workspace.', true);
    try {
      if (this.projects.length >= 8) throw new Error('The eight-workspace device limit has been reached.');
      const document = await this.readJsonFile(file, MAX_WORKSPACE_BYTES);
      if (document?.meridianStudio !== 1) throw new Error('This file is not a Meridian Studio workspace export.');
      const workspace = validateWorkspace(document.workspace);
      if (this.projects.some((project) => project.id === workspace.id)) { workspace.id = id(); workspace.name = `${workspace.name} imported`.slice(0, 80); workspace.history = []; }
      this.projects.push(workspace);
      this.switchWorkspace(workspace.id);
      this.status('Workspace imported. Layer settings and source notes have been restored.');
    } catch (error) { this.status(error.message, true); }
    finally { this.el['studio-workspace-import'].value = ''; }
  }

  exportWorkspace() {
    this.captureCamera();
    const blob = new Blob([JSON.stringify({ meridianStudio: 1, workspace: this.workspace })], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${this.workspace.name.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '') || 'meridian-workspace'}.meridian.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    this.status('Workspace export includes data, styles, analyses, source notes, and reversible Studio history.');
  }

  addLayer(collection, options = {}, { record = true, focus = true } = {}) {
    if (this.workspace.layers.length >= MAX_LAYERS) { this.status('A workspace can contain up to 30 layers. Remove an unused layer first.', true); return false; }
    let added;
    const changed = this.mutate(`Add ${String(options.name || 'dataset').slice(0, 100)}`, () => {
      const layer = makeLayer(collection, options);
      const datasetId = id();
      layer.id = id();
      this.workspace.datasets[datasetId] = layer.data;
      delete layer.data;
      layer.datasetId = datasetId;
      layer.scopeBounds = null;
      this.workspace.layers.unshift(layer);
      this.workspace.selectedLayerId = layer.id;
      added = layer;
      this.workspace.time = null;
    }, { record });
    if (!changed) return false;
    this.setTab('layers');
    if (focus) this.focusLayer(added);
    return true;
  }

  addExample(template) {
    const center = this.app.map.getCenter();
    const examples = {
      infrastructure: { name: 'Infrastructure / illustrative', visualization: 'extrusion', palette: 'olive' },
      logistics: { name: 'Logistics / illustrative', visualization: 'tactical', palette: 'ocean' },
      risk: { name: 'Risk index / illustrative', visualization: 'heatmap', palette: 'thermal' },
      movement: { name: 'Movement / illustrative', visualization: 'flow', palette: 'violet' },
    };
    this.addLayer(exampleCollection(template, [center.lng, center.lat]), {
      ...examples[template], source: { name: 'Meridian illustrative example', caveat: 'Demonstration only. Do not use for operational decisions.' },
      field: 'value', units: 'illustrative index', timeField: 'observedAt', filters: { categoryField: 'category' },
    });
    this.status('Illustrative example loaded. These values and locations are synthetic, not live or measured data.');
  }

  addMapData(kind) {
    let features = [];
    let source;
    let options = {};
    if (['buildings', 'roads', 'places'].includes(kind)) {
      const featureKind = { buildings: 'building', roads: 'road', places: 'poi' }[kind];
      features = [...this.app.features.values()].filter((feature) => feature.properties?.kind === featureKind).slice(0, 10000);
      source = { name: 'Loaded map features / OpenStreetMap, Overture or configured source', caveat: 'Snapshot of loaded tiles only, not a complete census. Per-feature source and height-estimation fields are retained.' };
      if (kind === 'buildings') options = { field: 'height', units: 'm', visualization: 'extrusion' };
      if (kind === 'roads') options.visualization = 'flow';
    } else if (kind === 'pins') {
      features = this.app.geo.pins.map((pin) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [pin.lon, pin.lat] }, properties: { name: pin.name, source: pin.source, label: pin.label } }));
      source = { name: 'Saved map places', caveat: 'User-saved positions. No inferred metric is attached.' };
    } else if (kind === 'areas') {
      features = this.app.geo.areas.filter((area) => !area.summary?.invalid).map((area) => ({ type: 'Feature', geometry: area.geometry, properties: { name: area.label, area: area.summary?.areaSquareMeters } }));
      source = { name: 'User-measured map areas', caveat: 'Spherical area estimate from user-selected boundaries, not a survey.' };
      options = { field: 'area', units: 'm2', visualization: 'choropleth' };
    } else if (kind === 'route' && this.app.geo.route) {
      const route = this.app.geo.route;
      features = [{ type: 'Feature', geometry: route.geometry, properties: { name: 'Current driving route', distance: route.summary?.distanceMeters, duration: route.summary?.durationSeconds, provider: route.provider } }];
      source = { name: route.provider || 'Road-network route', caveat: route.summary?.approximateGeometry ? 'Approximate endpoint connector, not road-following geometry. Not live navigation.' : 'Driving route from the configured road-network service. Duration is estimated and not traffic-aware.' };
      options = { visualization: 'flow', field: 'distance', units: 'm' };
    }
    if (!features.length) return this.status(`No ${kind} are currently loaded. Explore a location, plan a route, or import GeoJSON first.`, true);
    this.addLayer({ type: 'FeatureCollection', features }, { name: `Map ${kind} snapshot`, source, ...options });
  }

  updateLayer(patch, label) {
    const layer = this.selectedLayer();
    if (!layer) return;
    if (layer.locked) return this.status('Unlock this layer before changing its data or visual settings.', true);
    const candidate = { ...layer, ...patch, filters: { ...layer.filters, ...patch.filters } };
    if (candidate.filters.min !== null && candidate.filters.max !== null && candidate.filters.min > candidate.filters.max) {
      this.status('The minimum threshold cannot exceed the maximum.', true);
      this.renderSettings();
      return;
    }
    if (Object.hasOwn(patch, 'visualization') || Object.hasOwn(patch, 'field')) {
      try { renderCollection(this.hydrated(candidate), this.contextFor(candidate)); }
      catch (error) { this.status(error.message, true); this.renderSettings(); return; }
    }
    this.mutate(label, () => {
      Object.assign(layer, candidate);
      if (Object.hasOwn(patch, 'timeField')) this.workspace.time = null;
    });
    if (['extrusion', 'surface'].includes(candidate.visualization) && !this.app.terrainEnabled) this.app.setTerrainView(true);
  }

  contextFor(layer, override = null) {
    const bounds = this.app.map.getBounds();
    return { bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()], region: layer.ignoreRegion ? null : layer.scopeBounds || this.workspace.region, time: layer.id === this.workspace.selectedLayerId && layer.timeField ? this.workspace.time : null, ...override };
  }

  focusLayer(layer = this.selectedLayer()) {
    if (!layer) return;
    this.app.cameraInteractionRevision = (this.app.cameraInteractionRevision || 0) + 1;
    const bounds = boundsFor(this.workspace.datasets[layer.datasetId]);
    if (!bounds) return;
    const [west, south, east, north] = bounds;
    const narrow = window.innerWidth <= 900;
    this.app.map.fitBounds([[west, south], [east < west ? east + 360 : east, north]], {
      padding: narrow ? { top: 210, right: 32, bottom: Math.min(330, window.innerHeight * .4), left: 32 } : { top: 150, left: 410, right: window.innerWidth > 1200 && this.rightOpen ? 350 : 60, bottom: 160 },
      maxZoom: 15, duration: motion(450),
    });
  }

  render() {
    if (this.enabled && this.app.workspaceView === 'explore') this.el['view-title'].textContent = this.workspace.name;
    this.el['studio-workspace-select'].replaceChildren(...this.projects.map((project) => {
      const option = element('option', project.name);
      option.value = project.id;
      return option;
    }));
    this.el['studio-workspace-select'].value = this.workspace.id;
    this.el['studio-workspace-name'].value = this.workspace.name;
    this.el['studio-workspace-description'].value = this.workspace.description;
    this.el['studio-scope'].value = this.workspace.scope;
    this.renderLayers();
    this.renderSettings();
    this.renderMap();
    this.renderInsights();
    this.renderTimeline();
    this.renderHistory();
    this.syncPanels();
    for (const name of ['layers', 'data', 'visualize', 'filters']) {
      this.el[`studio-panel-${name}`].hidden = this.tab !== name;
      this.el[`studio-tab-${name}`].setAttribute('aria-selected', String(this.tab === name));
      this.el[`studio-tab-${name}`].tabIndex = this.tab === name ? 0 : -1;
    }
    this.setAgentBusy(Boolean(this.app.agentSubmitting || this.app.agentRunId));
  }

  renderLayers() {
    const list = this.el['studio-layer-list'];
    list.replaceChildren();
    this.el['studio-layer-count'].textContent = `${this.workspace.layers.length} layers`;
    if (!this.workspace.layers.length) {
      const empty = element('div', '', 'studio-empty');
      empty.append(element('strong', 'Make the map your workspace'), element('p', 'Import geographic data, capture loaded map features, or try a clearly labeled example. No analytical data is loaded by default.'), actionButton('Add data', 'Open the data library', () => this.setTab('data')));
      list.append(empty);
    }
    for (const [index, layer] of this.workspace.layers.entries()) {
      const row = element('article', '', 'studio-layer');
      row.dataset.selected = String(layer.id === this.workspace.selectedLayerId);
      const heading = element('div', '', 'studio-layer-heading');
      const visible = actionButton(layer.visible ? 'On' : 'Off', `${layer.visible ? 'Hide' : 'Show'} ${layer.name}`, () => this.mutate(`Toggle ${layer.name}`, () => { layer.visible = !layer.visible; }));
      visible.setAttribute('aria-pressed', String(layer.visible));
      const select = actionButton(layer.name, `Select ${layer.name}`, () => {
        this.workspace.selectedLayerId = layer.id;
        this.workspace.time = null;
        this.closeInspector();
        this.render();
        this.save();
      });
      select.className = 'studio-layer-select';
      select.setAttribute('aria-pressed', String(layer.id === this.workspace.selectedLayerId));
      heading.append(visible, select);
      const metadata = element('p', `${VISUALIZATIONS[layer.visualization]?.label || layer.visualization} / ${this.workspace.datasets[layer.datasetId].features.length.toLocaleString()} features${layer.locked ? ' / Locked' : ''}`, 'studio-layer-meta');
      const tools = element('div', '', 'studio-layer-tools');
      const move = (delta) => this.mutate(`Reorder ${layer.name}`, () => { const target = index + delta; [this.workspace.layers[index], this.workspace.layers[target]] = [this.workspace.layers[target], layer]; });
      tools.append(
        actionButton('Up', `Move ${layer.name} up`, () => move(-1), layer.locked || index === 0),
        actionButton('Down', `Move ${layer.name} down`, () => move(1), layer.locked || index === this.workspace.layers.length - 1),
        actionButton(layer.locked ? 'Unlock' : 'Lock', `${layer.locked ? 'Unlock' : 'Lock'} ${layer.name}`, () => this.mutate(`Change lock on ${layer.name}`, () => { layer.locked = !layer.locked; })),
        actionButton('Fit', `Fit ${layer.name} to the map`, () => this.focusLayer(layer)),
      );
      row.append(heading, metadata);
      if (layer.id === this.workspace.selectedLayerId) {
        const name = element('input', '', 'studio-layer-name');
        name.type = 'text'; name.value = layer.name; name.maxLength = 120; name.disabled = layer.locked;
        name.setAttribute('aria-label', 'Rename selected layer');
        name.addEventListener('change', () => this.updateLayer({ name: name.value.trim() || 'Unnamed layer' }, 'Rename layer'));
        tools.append(actionButton('Copy', `Duplicate ${layer.name}`, () => this.applyOperation({ action: 'duplicate', layerId: layer.id }), this.workspace.layers.length >= MAX_LAYERS), actionButton('Remove', `Remove ${layer.name}`, () => this.mutate(`Remove ${layer.name}`, () => {
          this.workspace.layers = this.workspace.layers.filter((item) => item.id !== layer.id);
          this.workspace.selectedLayerId = this.workspace.layers[0]?.id || '';
          this.closeInspector();
        }), layer.locked));
        row.append(name, tools);
      }
      list.append(row);
    }
  }

  selectOptions(control, values, value, placeholder) {
    const select = this.el[control];
    const options = placeholder === undefined ? [] : [{ value: '', label: placeholder }];
    options.push(...values.map((item) => typeof item === 'string' ? { value: item, label: item } : item));
    select.replaceChildren(...options.map((item) => { const option = element('option', item.label); option.value = item.value; return option; }));
    select.value = value || '';
  }

  renderSettings() {
    const layer = this.selectedLayer();
    this.el['studio-visualize-empty'].hidden = Boolean(layer);
    this.el['studio-viz-settings'].hidden = !layer;
    this.el['studio-viz-settings'].disabled = Boolean(layer?.locked);
    for (const name of ['studio-filter-category', 'studio-filter-min', 'studio-filter-max', 'studio-filter-viewport', 'studio-filters-reset']) this.el[name].disabled = !layer || layer.locked;
    this.el['studio-region-clear'].disabled = !this.workspace.region;
    this.el['studio-selection-note'].textContent = this.workspace.region
      ? `Selected rectangle: ${this.workspace.region.map((value) => value.toFixed(4)).join(', ')}. This region filters the displayed datasets; clear it to see all features.`
      : this.tool === 'region' ? 'Click two map corners to select a rectangle. Escape cancels.' : 'No region selected. Select two map corners to constrain the data geographically.';
    if (!layer) return;
    const available = fieldsFor(this.workspace.datasets[layer.datasetId]);
    this.el['studio-selected-name'].textContent = layer.name;
    this.el['studio-visualization'].value = layer.visualization;
    this.el['studio-palette'].value = layer.palette;
    this.el['studio-units'].value = layer.units;
    this.el['studio-opacity'].value = String(Math.round(layer.opacity * 100));
    this.el['studio-opacity-value'].textContent = `${Math.round(layer.opacity * 100)}%`;
    this.selectOptions('studio-value-field', available.numeric, layer.field, 'Feature count');
    this.selectOptions('studio-category-field', available.categorical, layer.filters.categoryField, 'No category field');
    this.selectOptions('studio-time-field', available.temporal, layer.timeField, 'No temporal field');
    const categories = layer.filters.categoryField ? [...new Set(this.workspace.datasets[layer.datasetId].features.map((feature) => feature.properties?.[layer.filters.categoryField]).filter((value) => ['string', 'number', 'boolean'].includes(typeof value)).map(JSON.stringify))].sort().slice(0, 200) : [];
    this.selectOptions('studio-filter-category', categories.map((value) => ({ value, label: String(JSON.parse(value)) })), layer.filters.category === '' ? '' : JSON.stringify(layer.filters.category), 'All categories');
    this.el['studio-filter-min'].value = layer.filters.min ?? '';
    this.el['studio-filter-max'].value = layer.filters.max ?? '';
    this.el['studio-filter-viewport'].checked = layer.filters.viewport;
    this.el['studio-filter-min'].disabled ||= !layer.field;
    this.el['studio-filter-max'].disabled ||= !layer.field;
    this.el['studio-viz-note'].textContent = `${VISUALIZATIONS[layer.visualization]?.description || ''}${layer.locked ? ' This layer is locked.' : ''} ${layer.source?.caveat || ''}`;
  }

  renderedLayer(layer) {
    const context = this.contextFor(layer);
    const key = JSON.stringify({ ...layer, opacity: undefined, visible: undefined, name: undefined, locked: undefined, renderError: undefined, context: { ...context, bounds: layer.filters.viewport ? context.bounds : null } });
    let cached = this.cache.get(layer.id);
    if (!cached || cached.key !== key) {
      cached = { key, result: renderCollection(this.hydrated(layer), context) };
      if (layer.visualization === 'flow') cached.result.legend.note += ' Arrowheads indicate coordinate order, not verified movement direction.';
      if (layer.visualization === 'tactical' && layer.filters.categoryField) {
        const field = layer.filters.categoryField;
        const values = [...new Set(this.workspace.datasets[layer.datasetId].features.map((feature) => JSON.stringify(feature.properties?.[field] ?? null)))].sort();
        const colors = PALETTES[layer.palette].colors;
        cached.result.legend.categorical = values.map((value, index) => ({ value, label: JSON.parse(value) === null ? 'Unspecified' : String(JSON.parse(value)), color: colors[index % colors.length] }));
        cached.result.legend.title = field;
        cached.result.legend.unit = 'categories';
        for (const feature of cached.result.data.features) feature.properties.__category = JSON.stringify(feature.properties?.[field] ?? null);
      }
      this.cache.set(layer.id, cached);
    }
    return cached.result;
  }

  renderMap() {
    const map = this.app.map;
    if (!map?.getStyle()?.layers || (!map.isStyleLoaded() && !map.getLayer('geo-route'))) return;
    const desired = new Set();
    const specs = [];
    for (const layer of [...this.workspace.layers].reverse()) {
      if (!this.enabled || !layer.visible) continue;
      try {
        const rendered = this.renderedLayer(layer);
        const sourceId = `studio-data-${layer.id}`;
        desired.add(sourceId);
        const source = map.getSource(sourceId);
        if (source) {
          if (this.mapData?.get(sourceId) !== rendered.data) source.setData(rendered.data);
        } else map.addSource(sourceId, { type: 'geojson', data: rendered.data, tolerance: .4 });
        this.mapData ||= new Map();
        this.mapData.set(sourceId, rendered.data);
        specs.push(...styleLayers(layer, rendered));
        layer.renderError = '';
      } catch (error) { layer.renderError = error.message; }
    }
    const required = new Set(specs.map((layer) => layer.id));
    for (const layer of [...(map.getStyle().layers || [])].reverse()) if (layer.id.startsWith('studio-') && layer.id !== 'studio-region-fill' && layer.id !== 'studio-region-line' && !required.has(layer.id)) map.removeLayer(layer.id);
    for (const sourceId of Object.keys(map.getStyle().sources || {})) if (sourceId.startsWith('studio-data-') && !desired.has(sourceId)) { map.removeSource(sourceId); this.mapData?.delete(sourceId); }
    const before = map.getLayer('geo-route-casing') ? 'geo-route-casing' : undefined;
    for (const spec of specs) {
      const existing = map.getLayer(spec.id);
      if (existing && existing.type !== spec.type) map.removeLayer(spec.id);
      if (!map.getLayer(spec.id)) map.addLayer(spec, before);
      else {
        for (const [key, value] of Object.entries(spec.paint || {})) map.setPaintProperty(spec.id, key, value);
        for (const [key, value] of Object.entries(spec.layout || {})) map.setLayoutProperty(spec.id, key, value);
        map.moveLayer(spec.id, before);
      }
    }
    this.renderRegion();
    this.renderLegend();
  }

  renderLegend() {
    const container = this.el['studio-legend'];
    container.replaceChildren();
    const layer = this.selectedLayer()?.visible ? this.selectedLayer() : this.workspace.layers.find((item) => item.visible);
    container.hidden = !this.enabled || !layer || !layer.visible;
    if (container.hidden) return;
    try {
      const result = this.renderedLayer(layer);
      const legend = result.legend;
      container.append(element('strong', layer.name), element('span', `${legend.title || layer.field || 'Feature count'} / ${legend.unit || layer.units || 'features'}`));
      if (layer.visualization === 'heatmap') container.append(element('small', 'Relative intensity. The range below describes source values, not population density.'));
      if (legend.categorical) {
        for (const category of legend.categorical.slice(0, 12)) {
          const row = element('div', '', 'studio-legend-category');
          const swatch = element('i');
          swatch.style.background = category.color;
          swatch.setAttribute('aria-hidden', 'true');
          row.append(swatch, element('span', category.label));
          container.append(row);
        }
        if (legend.categorical.length > 12) container.append(element('small', `${legend.categorical.length} categories; inspect features for all labels.`));
        container.append(element('small', 'Category colors remain stable while filtering. Inspect a marker for its text label.'));
      } else {
        const ramp = element('div', '', 'studio-legend-ramp');
        ramp.style.background = `linear-gradient(90deg, ${(legend.colors || PALETTES[layer.palette].colors).join(', ')})`;
        ramp.setAttribute('aria-hidden', 'true');
        const range = element('div', '', 'studio-legend-range');
        range.append(...[legend.min, legend.mid, legend.max].map((value) => element('span', number(value))));
        container.append(ramp, range);
        if (legend.note || result.caveat) {
          const details = element('details');
          details.append(element('summary', 'Scale & source notes'), element('small', legend.note || result.caveat));
          container.append(details);
        }
      }
      if (layer.source?.caveat?.toLowerCase().includes('synthetic')) container.append(element('small', 'Illustrative data. Not live observations.'));
      const otherLayers = this.workspace.layers.filter((item) => item.visible && item.id !== layer.id);
      if (otherLayers.length) {
        const details = element('details');
        details.append(element('summary', `${otherLayers.length} other visible layer${otherLayers.length === 1 ? '' : 's'}`));
        for (const other of otherLayers) {
          const row = element('div', '', 'studio-other-legend');
          row.append(element('strong', other.name));
          try {
            const scale = this.renderedLayer(other).legend;
            if (scale.categorical) {
              for (const category of scale.categorical) {
                const categoryRow = element('div', '', 'studio-legend-category');
                const swatch = element('i'); swatch.style.background = category.color;
                categoryRow.append(swatch, element('span', category.label)); row.append(categoryRow);
              }
            } else {
              const ramp = element('div', '', 'studio-legend-ramp'); ramp.style.background = `linear-gradient(90deg, ${scale.colors.join(', ')})`;
              row.append(element('small', `${scale.title} / ${scale.unit || 'unit not provided'}`), ramp, element('small', `${number(scale.min)} / ${number(scale.mid)} / ${number(scale.max)}`));
              if (other.visualization === 'heatmap') row.append(element('small', 'Relative intensity; range shows source values.'));
            }
          } catch (error) { row.append(element('small', error.message)); }
          details.append(row);
        }
        container.append(details);
      }
    } catch (error) { container.append(element('p', error.message)); }
  }

  renderInsights() {
    const container = this.el['studio-insights'];
    const provenance = this.el['studio-provenance'];
    container.replaceChildren();
    provenance.replaceChildren();
    const layer = this.selectedLayer();
    if (!layer) {
      container.append(element('div', 'Select a geographic dataset to see computed metrics and its provenance. Meridian does not invent missing observations.', 'studio-empty'));
      return;
    }
    try {
      const data = filterCollection(this.hydrated(layer), this.contextFor(layer));
      const metrics = metricsFor(data, layer.field);
      const grid = element('div', '', 'studio-metric-grid');
      const values = [['Matching source features', metrics.count], [layer.field ? 'Valid values' : 'Total features', layer.field ? metrics.validCount : this.workspace.datasets[layer.datasetId].features.length]];
      if (layer.field) values.push(['Median', metrics.median], ['Maximum', metrics.max]);
      for (const [label, value] of values) {
        const metric = element('div', '', 'studio-metric');
        metric.append(element('strong', number(value)), element('span', label));
        grid.append(metric);
      }
      container.append(element('h3', layer.name), grid);
      if (!metrics.count) container.append(element('p', 'No features match these filters. Clear the region, choose another observation time, or widen the thresholds.', 'studio-empty'));
      if (layer.field && metrics.histogram?.length) {
        const histogram = element('div', '', 'studio-histogram');
        histogram.setAttribute('role', 'img');
        histogram.setAttribute('aria-label', `Distribution of ${layer.field}, ${metrics.validCount} values, minimum ${number(metrics.min)}, maximum ${number(metrics.max)}`);
        const maximum = Math.max(1, ...metrics.histogram.map((bin) => bin.count));
        for (const bin of metrics.histogram) {
          const bar = element('span', '', 'studio-histogram-bar');
          bar.style.height = `${Math.max(2, bin.count / maximum * 100)}%`;
          bar.title = `${number(bin.min)} to ${number(bin.max)}: ${bin.count} features`;
          histogram.append(bar);
        }
        container.append(histogram, element('p', `${layer.field} / ${layer.units || 'unit not provided'}. Missing values are excluded from statistics.`));
      }
      if (layer.renderError) container.append(element('p', layer.renderError, 'is-error'));
      for (const insight of this.workspace.insights.filter((item) => item.layerId === layer.id).slice(-3)) {
        const card = element('article', '', 'studio-insight-card');
        card.append(element('strong', insight.label), element('p', insight.explanation));
        container.append(card);
      }
      const filters = [layer.filters.category !== '' && layer.filters.category != null ? `${layer.filters.categoryField} = ${layer.filters.category}` : '', layer.filters.min !== null ? `minimum ${layer.filters.min}` : '', layer.filters.max !== null ? `maximum ${layer.filters.max}` : '', layer.filters.viewport ? 'current viewport' : '', !layer.ignoreRegion && (this.workspace.region || layer.scopeBounds) ? 'selected geographic bounds' : '', this.contextFor(layer).time ? `time ${this.workspace.time}` : ''].filter(Boolean);
      provenance.append(element('h3', 'Provenance'), element('p', `${layer.source?.name || 'User-provided data'} > ${filters.join(', ') || 'all records'} > ${VISUALIZATIONS[layer.visualization]?.label || layer.visualization}`, 'studio-provenance-path'), element('p', layer.source?.caveat || 'Source accuracy is not independently verified.'));
      if (layer.source?.url) {
        try {
          const url = new URL(layer.source.url);
          if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) {
            const link = element('a', 'Open original data source'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; provenance.append(link);
          }
        } catch { /* Invalid source links are never rendered as executable content. */ }
      }
      if (layer.source?.attribution) provenance.append(element('p', `Attribution: ${layer.source.attribution}`));
      if (layer.source?.retrievedAt) provenance.append(element('small', `Retrieved ${layer.source.retrievedAt}. Publication date is not the population reference year.`));
      const rendered = this.renderedLayer(layer);
      const transformationNote = rendered.caveat?.replace(layer.source?.caveat || '', '').trim();
      if (transformationNote) provenance.append(element('p', transformationNote));
    } catch (error) { container.append(element('p', error.message, 'is-error')); }
  }

  renderHistory() {
    const container = this.el['studio-history'];
    container.replaceChildren();
    this.el['studio-undo'].disabled = !this.workspace.history.length && !this.app.mapActions?.length || Boolean(this.app.agentSubmitting || this.app.agentRunId || this.app.undoing);
    this.el['studio-redo'].disabled = !this.workspace.future.length || Boolean(this.app.agentSubmitting || this.app.agentRunId || this.app.undoing);
    if (!this.workspace.history.length) container.append(element('p', 'Workspace changes are reversible. Your recent history is saved with the project.', 'studio-empty'));
    for (const entry of [...this.workspace.history].reverse()) {
      const item = element('div', '', 'studio-history-entry');
      item.append(element('span', entry.label), element('time', new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
      container.append(item);
    }
  }

  agentContext() {
    const bounds = this.app.map.getBounds();
    const scope = { type: this.workspace.scope };
    const wrap = (value) => ((value + 180) % 360 + 360) % 360 - 180;
    if (scope.type === 'viewport') scope.bounds = bounds.getEast() - bounds.getWest() >= 360
      ? [-180, Math.max(-90, bounds.getSouth()), 180, Math.min(90, bounds.getNorth())]
      : [wrap(bounds.getWest()), Math.max(-90, bounds.getSouth()), wrap(bounds.getEast()), Math.min(90, bounds.getNorth())];
    if (scope.type === 'selection') scope.bounds = this.workspace.region;
    if (scope.type === 'layer') scope.layerId = this.workspace.selectedLayerId;
    const context = {
      scope,
      studio: {
        workspaceId: this.workspace.id, name: this.workspace.name, selectedLayerId: this.workspace.selectedLayerId,
        layers: [...this.workspace.layers].sort((a, b) => Number(b.id === this.workspace.selectedLayerId) - Number(a.id === this.workspace.selectedLayerId)).slice(0, 20).map((layer) => {
          const available = fieldsFor(this.workspace.datasets[layer.datasetId]);
          return {
            id: layer.id, name: layer.name, visualization: layer.visualization, field: layer.field, units: layer.units,
            featureCount: this.workspace.datasets[layer.datasetId].features.length,
            source: { name: String(layer.source?.name || 'User-provided data').slice(0, 120), caveat: String(layer.source?.caveat || '').slice(0, 400) },
            numericFields: available.numeric.filter((name) => name.length <= 128).slice(0, 16), categoricalFields: available.categorical.filter((name) => name.length <= 128).slice(0, 16), timeFields: available.temporal.filter((name) => name.length <= 128).slice(0, 16),
          };
        }),
      },
    };
    while (JSON.stringify(context).length > 16000 && context.studio.layers.length > 1) context.studio.layers.pop();
    return context;
  }

  handleInstruction(query) {
    if (!this.enabled) return false;
    const normalized = query.toLowerCase().trim().replace(/[.!]$/, '');
    if (/^(?:draw|select)(?: a)? region$/.test(normalized)) { this.startTool('region'); return true; }
    if (/^(?:add )?annotation$|^annotate$/.test(normalized)) { this.startTool('annotate'); return true; }
    const match = normalized.match(/^(?:show|use|switch to|visuali[sz]e as) (?:a )?(points|point density|density|heatmap|choropleth|contours|3d extrusion|flow|terrain surface|tactical)(?: (?:view|layer))?$/);
    const aliases = { 'point density': 'density', '3d extrusion': 'extrusion', 'terrain surface': 'surface' };
    let operation;
    if (match) operation = { action: 'visualize', visualization: aliases[match[1]] || match[1] };
    else if (/^summari[sz]e(?: (?:this|the active|selected) layer)?$/.test(normalized)) operation = { action: 'summarize' };
    else if (/^(?:find|show) (?:hotspots|high values)$/.test(normalized)) operation = { action: 'hotspots' };
    else if (/^compare(?: (?:this|the active|selected) layer)?$/.test(normalized)) operation = { action: 'compare' };
    else if (/^duplicate(?: (?:this|the active|selected) layer)?$/.test(normalized)) operation = { action: 'duplicate' };
    else return false;
    try {
      this.applyOperation({ ...operation, layerId: this.workspace.selectedLayerId, scope: this.agentContext().scope });
      this.app.showCommandResult('Studio operation applied to the map', 'Computed locally from the selected dataset and scope. Inspect the Insights rail for the source, transformation, and data caveats. The change can be undone.');
    } catch (error) { this.app.showCommandResult('The operation was not applied', error.message); }
    return true;
  }

  applyOperation(operation, { fromAgent = false } = {}) {
    if (operation.workspaceId && operation.workspaceId !== this.workspace.id) throw new Error('This operation belongs to a different workspace.');
    const layer = this.workspace.layers.find((candidate) => candidate.id === operation.layerId);
    if (!layer) throw new Error('Select or import a real dataset before running this operation.');
    if (!['visualize', 'filter', 'summarize', 'hotspots', 'compare', 'duplicate'].includes(operation.action)) throw new Error('This Studio operation is not supported.');
    if (layer.locked && ['visualize', 'filter'].includes(operation.action)) throw new Error('The target layer is locked. Unlock it before modifying it.');
    if (['duplicate', 'hotspots'].includes(operation.action) && this.workspace.layers.length >= MAX_LAYERS) throw new Error('Remove an unused layer before creating another output.');
    const available = fieldsFor(this.workspace.datasets[layer.datasetId]);
    const candidate = { ...layer, filters: { ...layer.filters } };
    if (Object.hasOwn(operation, 'field')) {
      if (operation.field && !available.numeric.includes(operation.field)) throw new Error('The requested numeric field is not present in this dataset.');
      candidate.field = operation.field;
    }
    if (operation.visualization) {
      if (!Object.hasOwn(VISUALIZATIONS, operation.visualization)) throw new Error('Unknown visualization.');
      candidate.visualization = operation.visualization;
    }
    if (operation.palette) {
      if (!Object.hasOwn(PALETTES, operation.palette)) throw new Error('Unknown analytical palette.');
      candidate.palette = operation.palette;
    }
    for (const key of ['min', 'max']) if (Object.hasOwn(operation, key)) {
      if (!candidate.field || numeric(operation[key]) === null) throw new Error('Numeric filters require a numeric dataset field and finite threshold.');
      candidate.filters[key] = Number(operation[key]);
    }
    if (operation.categoryField) {
      if (!available.categorical.includes(operation.categoryField)) throw new Error('The requested category field does not exist.');
      candidate.filters.categoryField = operation.categoryField;
    }
    if (Object.hasOwn(operation, 'category')) {
      const category = operation.category;
      if (!(typeof category === 'string' && category.length <= 160 || typeof category === 'boolean' || typeof category === 'number' && Number.isFinite(category))) throw new Error('A category must be a finite JSON scalar, with text limited to 160 characters.');
      candidate.filters.category = category;
    }
    if (candidate.filters.min !== null && candidate.filters.max !== null && candidate.filters.min > candidate.filters.max) throw new Error('The minimum threshold cannot exceed the maximum.');
    const scope = operation.scope;
    if (scope?.type === 'layer' && scope.layerId !== layer.id) throw new Error('The operation targets a layer outside the selected scope.');
    if (scope && ['viewport', 'selection'].includes(scope.type)) {
      if (!validBounds(scope.bounds)) throw new Error('Select a valid geographic region before using this scope.');
      candidate.scopeBounds = scope.bounds;
      candidate.filters.viewport = false;
      candidate.ignoreRegion = false;
    }
    if (scope?.type === 'workspace') { candidate.ignoreRegion = true; candidate.scopeBounds = null; }
    const context = this.contextFor(candidate, scope?.type === 'workspace' ? { region: null } : null);
    const filtered = filterCollection(this.hydrated(candidate), context);
    const metrics = metricsFor(filtered, candidate.field);
    if (!metrics.count) throw new Error('No dataset features match the chosen scope and filters. Widen the scope or reset filters.');
    if (operation.action === 'compare') {
      renderCollection(this.hydrated(candidate), context);
      if (!this.startCompare()) throw new Error('The reference map could not be captured. Wait for the map to load and try again.');
      this.mutate(`Compare ${layer.name}`, () => {
        this.workspace.selectedLayerId = layer.id;
        Object.assign(layer, candidate);
      }, { record: !fromAgent });
      return;
    }
    if (['visualize', 'filter'].includes(operation.action)) renderCollection(this.hydrated(candidate), context);
    let output = null;
    let explanation = '';
    if (operation.action === 'hotspots') {
      if (!candidate.field) throw new Error('Choose a numeric field before finding high-value features.');
      const values = filtered.features.map((feature) => numeric(feature.properties?.[candidate.field])).filter((value) => value !== null).sort((a, b) => a - b);
      if (!values.length) throw new Error('No numeric observations are available in this scope.');
      const threshold = values[Math.floor((values.length - 1) * .9)];
      output = { ...candidate, id: id(), name: `${layer.name} / high values`.slice(0, 120), locked: false, visible: true, filters: { ...candidate.filters, min: Math.max(candidate.filters.min ?? -Infinity, threshold) } };
      explanation = `Features at or above the observed 90th-percentile threshold (${number(threshold)} ${candidate.units || candidate.field}) in the selected scope. This is a value-based selection, not a statistically significant spatial cluster or a suitability recommendation.`;
      output.source = { ...candidate.source, caveat: `${candidate.source?.caveat || ''} ${explanation}` };
    } else if (operation.action === 'duplicate') {
      output = { ...candidate, id: id(), name: `${layer.name} / scenario`.slice(0, 120), locked: false, filters: { ...candidate.filters } };
      explanation = 'Scenario layer shares the original immutable dataset. Its filters, visibility, and visual settings can be changed independently.';
    } else if (operation.action === 'summarize') {
      explanation = `${metrics.count.toLocaleString()} features match the current scope.${candidate.field ? ` ${metrics.validCount} valid ${candidate.field} values; median ${number(metrics.median)}, minimum ${number(metrics.min)}, maximum ${number(metrics.max)} ${candidate.units || '(unit not provided)'}.` : ' No numeric metric is selected.'} ${candidate.source?.caveat || ''}`;
    }
    const changed = this.mutate(`${operation.action[0].toUpperCase()}${operation.action.slice(1)} ${layer.name}`, () => {
      this.workspace.selectedLayerId = layer.id;
      if (['visualize', 'filter'].includes(operation.action)) Object.assign(layer, candidate);
      if (output) { this.workspace.layers.unshift(output); this.workspace.selectedLayerId = output.id; }
      if (explanation) {
        const result = { id: id(), label: operation.action === 'hotspots' ? 'High-value feature selection' : operation.action === 'duplicate' ? 'Independent scenario' : 'Dataset summary', explanation, layerId: output?.id || layer.id, time: Date.now() };
        this.workspace.analyses.push(result);
        this.workspace.insights.push(result);
        this.workspace.analyses = this.workspace.analyses.slice(-40);
        this.workspace.insights = this.workspace.insights.slice(-40);
      }
    }, { record: !fromAgent });
    if (!changed) throw new Error('The operation could not be applied. The previous valid state was retained.');
    if (['extrusion', 'surface'].includes(candidate.visualization) && !this.app.terrainEnabled) this.app.setTerrainView(true);
    this.setPane('right');
    this.status(explanation || `${VISUALIZATIONS[candidate.visualization].label} applied using ${candidate.source?.name || 'the loaded dataset'}.`);
  }

  applySourcedDataset(update) {
    if (update.workspaceId && update.workspaceId !== this.workspace.id) throw new Error('The sourced dataset belongs to a different workspace.');
    if (this.workspace.layers.length >= MAX_LAYERS) throw new Error('Remove an unused layer before loading another dataset.');
    const data = normalizeCollection(update.data);
    if (!data.features.length) throw new Error('The source contains no geographic observations.');
    const scope = update.scope || { type: 'workspace' };
    if (!['workspace', 'viewport', 'selection'].includes(scope.type)) throw new Error('Choose a geographic or workspace scope before loading a new dataset.');
    if (['viewport', 'selection'].includes(scope.type) && !validBounds(scope.bounds)) throw new Error('The supplied source scope is invalid.');
    const available = fieldsFor(data);
    const field = typeof update.field === 'string' ? update.field : '';
    if (field && !available.numeric.includes(field)) throw new Error('The source does not contain the requested numeric field.');
    if (!['points', 'heatmap', 'choropleth'].includes(update.visualization) || update.visualization === 'heatmap' && !field) throw new Error('A heatmap requires a real numeric source field.');
    const layer = makeLayer(data, {
      name: String(update.name || 'Researched geographic dataset').slice(0, 120), field, units: String(update.units || '').slice(0, 60), visualization: update.visualization,
      source: update.source && typeof update.source === 'object' ? update.source : { name: 'Web source', caveat: 'Review the source and its data date before use.' }, palette: 'thermal',
    });
    layer.scopeBounds = scope.type === 'workspace' ? null : scope.bounds;
    layer.ignoreRegion = scope.type === 'workspace';
    const rendered = renderCollection(layer, { ...this.contextFor(layer), region: layer.scopeBounds, time: null });
    if (!rendered.inputCount) throw new Error('No source observations fall inside the selected scope. The scope was not silently broadened.');
    const changed = this.mutate(`Load sourced ${layer.name}`, () => {
      const datasetId = id();
      this.workspace.datasets[datasetId] = layer.data;
      delete layer.data;
      layer.datasetId = datasetId;
      this.workspace.layers.unshift(layer);
      this.workspace.selectedLayerId = layer.id;
      this.workspace.time = null;
    }, { record: false });
    if (!changed) throw new Error('The sourced dataset could not be added. The preceding valid workspace was retained.');
    this.setTab('layers');
    if (scope.type === 'workspace') this.focusLayer(layer);
    this.status(`Loaded ${rendered.inputCount.toLocaleString()} source observations. Check the source date, units, and partial-coverage caveats in Insights.`);
    return layer;
  }

  captureAgentArtifacts(update) {
    if (Array.isArray(update.places) && this.app.searchResults.length) {
      this.addLayer({ type: 'FeatureCollection', features: this.app.searchResults.map((place) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [place.lon, place.lat] }, properties: { name: place.name, provider: place.provider, address: place.address } })) }, {
        name: 'Meridian / discovered places', source: { name: 'Map agent / provider-returned places', caveat: 'Places are returned by the configured lookup providers, not generated geometry. Coverage and accuracy vary.' },
      }, { record: false, focus: false });
    }
    if (update.route && this.app.geo.route) {
      const route = this.app.geo.route;
      this.addLayer({ type: 'FeatureCollection', features: [{ type: 'Feature', geometry: route.geometry, properties: { distance: route.summary?.distanceMeters, duration: route.summary?.durationSeconds, provider: route.provider } }] }, {
        name: 'Meridian / driving route', visualization: 'flow', field: 'distance', units: 'm', source: { name: route.provider || 'Routing provider', caveat: route.summary?.approximateGeometry ? 'Approximate endpoint connector, not a road-following route.' : 'Road-network route. Driving time is estimated, not live traffic.' },
      }, { record: false, focus: false });
    }
  }

  renderTimeline() {
    const layer = this.selectedLayer();
    const values = layer?.timeField ? temporalValues(this.hydrated(layer)) : [];
    this.times = values;
    this.el['studio-timeline'].hidden = !this.enabled || values.length < 2;
    if (values.length < 2) { this.stopPlayback(); return; }
    this.el['studio-timeline-range'].max = String(values.length);
    this.el['studio-timeline-range'].value = String(this.workspace.time ? values.indexOf(this.workspace.time) + 1 : 0);
    this.el['studio-timeline-label'].textContent = this.workspace.time || 'All observations';
    this.el['studio-timeline-source'].textContent = `${layer.timeField} / ${layer.source?.name || 'imported observations'}`;
  }

  setTime(index) {
    if (this.app.agentSubmitting || this.app.agentRunId || this.app.undoing) return;
    this.workspace.time = index > 0 ? this.times[index - 1] || null : null;
    this.cache.clear();
    this.renderMap();
    this.renderInsights();
    this.renderTimeline();
    this.save();
  }

  playTimeline() {
    if (!this.times?.length) return;
    this.el['studio-timeline-play'].textContent = 'Pause';
    this.el['studio-timeline-play'].setAttribute('aria-label', 'Pause timeline');
    this.playTimer = setInterval(() => {
      const current = Number(this.el['studio-timeline-range'].value);
      if (current >= this.times.length) { this.stopPlayback(); return; }
      this.setTime(current + 1);
    }, 900);
  }

  stopPlayback() {
    clearInterval(this.playTimer);
    this.playTimer = null;
    this.el['studio-timeline-play'].textContent = 'Play';
    this.el['studio-timeline-play'].setAttribute('aria-label', 'Play timeline');
  }

  startCompare() {
    if (!this.enabled || this.app.undoing) return false;
    const map = this.app.map;
    if (!map.isStyleLoaded()) { this.status('Wait for the current map layers to finish loading before capturing a reference.', true); return false; }
    this.stopCompare();
    this.el['studio-compare-map'].hidden = false;
    const center = map.getCenter();
    try {
      this.compareMap = new window.maplibregl.Map({
        container: 'studio-compare-map', style: clone(map.getStyle()), interactive: false, attributionControl: false,
        center: [center.lng, center.lat], zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(),
        maxPitch: 78, canvasContextAttributes: { antialias: true },
      });
      this.compareMap.on('error', () => this.status('Some reference-map data could not load. The current map remains interactive.', true));
      this.compareMap.on('load', () => { this.compareMap?.resize(); this.syncCompare(); });
      this.el['studio-compare-toolbar'].hidden = false;
      this.el['studio-compare-divider'].hidden = false;
      this.el['studio-compare-label'].hidden = false;
      this.el['studio-compare-range'].value = '50';
      const selected = this.selectedLayer();
      const legend = selected ? this.renderedLayer(selected).legend : null;
      this.el['studio-compare-label'].textContent = legend ? `Reference: ${selected.name} / ${number(legend.min)}-${number(legend.max)} ${legend.unit || ''}` : 'Reference / Current';
      document.documentElement.dataset.studioCompare = 'true';
      this.syncCompare();
      if (window.innerWidth <= 900) this.closePanels();
      this.status('Reference captured on the left. Change a layer or scrub the timeline on the right; both cameras stay synchronized.');
      return true;
    } catch (error) { this.stopCompare(); this.status(`Comparison could not start: ${error.message}`, true); return false; }
  }

  syncCompare() {
    if (!this.compareMap) return;
    const current = this.app.map;
    const center = current.getCenter();
    this.compareMap.jumpTo({ center: [center.lng, center.lat], zoom: current.getZoom(), pitch: current.getPitch(), bearing: current.getBearing() });
    const split = Math.max(0, Math.min(100, Number(this.el['studio-compare-range'].value)));
    this.el['studio-compare-map'].style.clipPath = `inset(0 ${100 - split}% 0 0)`;
    this.el['studio-compare-divider'].style.left = `${split}%`;
  }

  stopCompare() {
    this.compareMap?.remove();
    this.compareMap = null;
    for (const name of ['studio-compare-map', 'studio-compare-toolbar', 'studio-compare-divider', 'studio-compare-label']) this.el[name].hidden = true;
    document.documentElement.dataset.studioCompare = 'false';
  }

  startTool(tool) {
    if (!['region', 'annotate'].includes(tool)) return;
    if (this.tool === tool) { this.cancelTool(); return; }
    this.tool = tool;
    this.selectionPoints = [];
    this.app.setPinMode(false);
    this.app.map.getCanvas().style.cursor = 'crosshair';
    this.closeInspector();
    this.closePanels();
    this.app.setInfoDrawerOpen(false);
    this.status(tool === 'region' ? 'Select two map corners. The rectangle will become your geographic filter. Press Escape to cancel.' : 'Click a location to add an annotation. Press Escape to cancel.');
    this.renderSettings();
  }

  cancelTool() {
    this.tool = '';
    this.selectionPoints = [];
    this.selectionMarker?.remove();
    this.selectionMarker = null;
    this.app.map.getCanvas().style.cursor = '';
    this.renderRegion();
  }

  handleMapClick(event) {
    if (!this.enabled || this.app.viewMode) return false;
    if (this.tool === 'region') {
      const point = [((event.lngLat.lng + 180) % 360 + 360) % 360 - 180, event.lngLat.lat];
      this.selectionPoints.push(point);
      if (this.selectionPoints.length === 1) {
        const marker = element('span', '', 'inspection-marker');
        marker.setAttribute('aria-hidden', 'true');
        this.selectionMarker = new window.maplibregl.Marker({ element: marker }).setLngLat(point).addTo(this.app.map);
        this.status('First corner selected. Click the opposite corner to apply the region filter.');
        return true;
      }
      const [first, second] = this.selectionPoints;
      const west = Math.abs(first[0] - second[0]) > 180 ? Math.max(first[0], second[0]) : Math.min(first[0], second[0]);
      const east = Math.abs(first[0] - second[0]) > 180 ? Math.min(first[0], second[0]) : Math.max(first[0], second[0]);
      const bounds = [west, Math.min(first[1], second[1]), east, Math.max(first[1], second[1])];
      if (!validBounds(bounds) || first[0] === second[0]) { this.selectionPoints.pop(); this.status('Choose a different corner to create a non-empty region.', true); return true; }
      this.cancelTool();
      this.mutate('Select geographic region', () => { this.workspace.region = bounds; this.workspace.scope = 'selection'; });
      this.setTab('filters');
      this.status('Region selected. Map layers and analytics are filtered to this geographic extent.');
      return true;
    }
    if (this.tool === 'annotate') {
      this.annotationPoint = [event.lngLat.lng, event.lngLat.lat];
      this.cancelTool();
      this.el['studio-annotation-name'].value = '';
      this.el['studio-annotation-note'].value = '';
      this.el['studio-annotation-dialog'].returnValue = '';
      this.el['studio-annotation-dialog'].showModal();
      return true;
    }
    const layers = (this.app.map.getStyle().layers || []).filter((layer) => layer.id.startsWith('studio-') && !layer.id.startsWith('studio-region-') && layer.type !== 'heatmap').map((layer) => layer.id);
    if (!layers.length) return false;
    const features = this.app.map.queryRenderedFeatures(event.point, { layers });
    if (!features.length) return false;
    this.inspectFeature(features[0], event.lngLat);
    return true;
  }

  renderRegion() {
    const map = this.app.map;
    if (!map.getStyle()?.layers || (!map.isStyleLoaded() && !map.getLayer('geo-route'))) return;
    const bounds = this.enabled ? this.workspace.region : null;
    let data = EMPTY;
    if (bounds) {
      const [west, south, east, north] = bounds;
      const polygon = (w, e) => [[[w, south], [e, south], [e, north], [w, north], [w, south]]];
      data = { type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: west <= east ? { type: 'Polygon', coordinates: polygon(west, east) } : { type: 'MultiPolygon', coordinates: [polygon(west, 180), polygon(-180, east)] } }] };
    }
    if (!map.getSource('studio-selection')) map.addSource('studio-selection', { type: 'geojson', data });
    else map.getSource('studio-selection').setData(data);
    if (!map.getLayer('studio-region-fill')) map.addLayer({ id: 'studio-region-fill', source: 'studio-selection', type: 'fill', paint: { 'fill-color': '#c7a270', 'fill-opacity': .07 } });
    if (!map.getLayer('studio-region-line')) map.addLayer({ id: 'studio-region-line', source: 'studio-selection', type: 'line', paint: { 'line-color': '#c7a270', 'line-width': 1.5, 'line-dasharray': [3, 2] } });
  }

  inspectFeature(feature, coordinate) {
    const layer = this.workspace.layers.find((item) => feature.layer.id.startsWith(`studio-${item.id}-`));
    if (!layer) return;
    this.workspace.selectedLayerId = layer.id;
    this.app.buildingPopup?.remove();
    this.app.terrainPointPopup?.remove();
    this.app.inspectedCoordinate = { lon: coordinate.lng, lat: coordinate.lat };
    this.el['studio-inspector'].hidden = false;
    this.el['studio-inspector-title'].textContent = feature.properties?.name || layer.name;
    const properties = this.el['studio-inspector-properties'];
    properties.replaceChildren();
    const entries = [['Latitude, longitude', `${coordinate.lat.toFixed(5)}, ${coordinate.lng.toFixed(5)}`], ...Object.entries(feature.properties || {}).filter(([key]) => !key.startsWith('__')).slice(0, 24), ['Source', layer.source?.name || 'Imported data']];
    for (const [name, value] of entries) {
      const row = element('div');
      row.append(element('dt', name), element('dd', value === null || value === undefined ? 'Not provided' : String(value).slice(0, 500)));
      properties.append(row);
    }
    this.renderLayers();
    this.renderSettings();
    this.renderInsights();
    this.renderLegend();
    this.setPane('right');
    this.app.updateDashboard();
  }

  closeInspector() {
    this.el['studio-inspector'].hidden = true;
    if (!this.app.terrainPointPopup) this.app.inspectedCoordinate = null;
  }

  handleEscape() {
    if (!this.enabled) return false;
    if (this.tool) { this.cancelTool(); this.status('Map selection cancelled.'); this.setPane('left'); return true; }
    if (!this.el['studio-inspector'].hidden) { this.closeInspector(); return true; }
    if (this.compareMap) { this.stopCompare(); return true; }
    return false;
  }

  destroy() {
    this.flushSave();
    clearTimeout(this.renderTimer);
    cancelAnimationFrame(this.opacityFrame);
    this.stopPlayback();
    this.stopCompare();
    this.app.map.off('moveend', this.moveHandler);
    this.app.map.off('move', this.syncCompareHandler);
    this.app.map.off('style.load', this.styleHandler);
    window.removeEventListener('resize', this.resizeHandler);
  }
}
