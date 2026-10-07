const assert = require('node:assert/strict');
const test = require('node:test');
const { deflateSync } = require('node:zlib');
const { join } = require('node:path');

let chromium;
try { ({ chromium } = require('playwright-core')); } catch { /* Browser checks are optional; the app has no Node runtime dependencies. */ }

function flatTerrainPng() {
  const crc = (buffer) => {
    let value = 0xffffffff;
    for (const byte of buffer) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
    }
    return (value ^ 0xffffffff) >>> 0;
  };
  const chunk = (name, data) => {
    const body = Buffer.concat([Buffer.from(name), data]);
    const prefix = Buffer.alloc(4); prefix.writeUInt32BE(data.length);
    const suffix = Buffer.alloc(4); suffix.writeUInt32BE(crc(body));
    return Buffer.concat([prefix, body, suffix]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(256, 0); header.writeUInt32BE(256, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc(256 * (1 + 256 * 4));
  for (let row = 0; row < 256; row++) for (let col = 0; col < 256; col++) { const offset = row * 1025 + col * 4 + 1; pixels[offset] = 128; pixels[offset + 3] = 255; }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
}

const fixture = {
  type: 'FeatureCollection', features: [
    [77.19, 28.60, 10, 'North', '2026-01-01'], [77.24, 28.60, 20, 'South', '2026-01-01'],
    [77.19, 28.66, 40, 'North', '2026-02-01'], [77.24, 28.66, 80, 'South', '2026-02-01'],
  ].map(([lon, lat, value, category, observedAt], index) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: { name: `Test observation ${index + 1}`, value, category, observedAt } })),
};

test('Meridian Studio in a real browser and MapLibre renderer', { skip: !chromium, timeout: 180000 }, async (t) => {
  const browser = await chromium.launch({ channel: process.env.MERIDIAN_BROWSER_CHANNEL || 'msedge', headless: true, args: ['--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const errors = [];
  const styleErrors = [];
  const sockets = [];
  let agentRunSequence = 0;
  let agentRunId = '';
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && /layers\.|paint\.|expression|TypeError|ReferenceError/.test(message.text())) styleErrors.push(message.text()); });
  await page.addInitScript(() => {
    let library;
    window.__testMaps = [];
    Object.defineProperty(window, 'maplibregl', {
      configurable: true, get: () => library, set(value) {
        const Map = value.Map;
        value.Map = class extends Map { constructor(options) { super(options); window.__testMaps.push(this); } };
        library = value;
      },
    });
  });
  await page.route('https://unpkg.com/maplibre-gl@*/dist/maplibre-gl.js', (route) => route.fulfill({ path: require.resolve('maplibre-gl/dist/maplibre-gl.js'), contentType: 'application/javascript' }));
  await page.route('https://unpkg.com/maplibre-gl@*/dist/maplibre-gl.css', (route) => route.fulfill({ path: require.resolve('maplibre-gl/dist/maplibre-gl.css'), contentType: 'text/css' }));
  await page.route('https://unpkg.com/maplibre-contour@*/dist/index.min.js', (route) => route.fulfill({ path: require.resolve('maplibre-contour/dist/index.min.js'), contentType: 'application/javascript' }));
  await page.route('https://tiles.openfreemap.org/styles/positron', (route) => route.fulfill({ json: { version: 8, glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf', sources: {}, layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#1d2320' } }] } }));
  await page.route('https://elevation-tiles-prod.s3.amazonaws.com/**', (route) => route.fulfill({ body: flatTerrainPng(), contentType: 'image/png', headers: { 'Access-Control-Allow-Origin': '*' } }));
  await page.route('https://services.arcgisonline.com/**', (route) => route.request().url().includes('/query') ? route.fulfill({ json: { features: [] } }) : route.fulfill({ body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'), contentType: 'image/png' }));
  await page.route('https://api.ipify.org/**', (route) => route.fulfill({ json: { ip: '192.0.2.1' } }));
  await page.route('https://ip-api.services.brahmai.in/**', (route) => route.fulfill({ json: { data: { status: 'success', city: 'Delhi', country: 'India', countryCode: 'IN', lat: 28.63, lon: 77.21 } } }));
  await page.route('http://127.0.0.1:8787/**', (route) => {
    if (route.request().url().includes('/api/tiles/')) return route.fulfill({ status: 204 });
    if (route.request().url().includes('/api/agent/runs')) {
      agentRunId = `browser-test-run-${++agentRunSequence}`;
      return route.fulfill({ status: 202, json: { accepted: true, runId: agentRunId } });
    }
    return route.fulfill({ json: { pins: [], areas: [], state: {}, results: [] } });
  });
  await page.routeWebSocket('ws://127.0.0.1:8788/', (socket) => {
    sockets.push(socket);
    socket.onMessage((message) => {
      const data = JSON.parse(message);
      if (data.type === 'session.open') socket.send(JSON.stringify({ v: 1, type: 'session.ready', sessionId: data.sessionId }));
      if (data.type === 'agent.cancel') socket.send(JSON.stringify({ v: 1, type: 'agent.cancelled', runId: data.runId, rolledBack: true }));
    });
  });
  const ready = () => page.waitForFunction(() => window.__testMaps[0]?.getLayer('geo-route') && localStorage.getItem('meridian.explore.v1'));
  const layerType = () => page.evaluate(() => window.__testMaps[0].getStyle().layers.filter((layer) => !layer.id.startsWith('studio-region-') && /^studio-.+-(?:point|heat|fill|line)$/.test(layer.id)).map((layer) => layer.type));
  const setRange = (selector, value) => page.locator(selector).evaluate((input, next) => { input.value = String(next); input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); }, value);
  try {
    await page.goto(process.env.MERIDIAN_UI_URL || 'http://127.0.0.1:8099', { waitUntil: 'domcontentloaded' });
    await ready();
    await t.test('Explore and Studio preserve the live camera', async () => {
      const before = await page.evaluate(() => window.__testMaps[0].getCenter().toArray());
      await page.locator('button[data-product-mode="studio"]').click();
      assert.equal(await page.locator('#studio-shell').isVisible(), true);
      assert.deepEqual(await page.evaluate(() => window.__testMaps[0].getCenter().toArray()), before);
      assert.equal(await page.locator('.manual-sidebar').isVisible(), false);
      assert.equal(await page.locator('#studio-layer-list .studio-empty').count(), 1);
    });
    await t.test('Local imports create actual MapLibre sources, not mock cards', async () => {
      await page.locator('#studio-tab-data').click();
      await page.locator('#studio-import-source').fill('Browser regression fixture');
      await page.locator('#studio-import-units').fill('test units');
      await page.locator('#studio-import').setInputFiles({ name: 'observations.geojson', mimeType: 'application/geo+json', buffer: Buffer.from(JSON.stringify(fixture)) });
      await page.waitForFunction(() => document.querySelectorAll('.studio-layer').length === 1);
      assert.deepEqual(await layerType(), ['circle']);
      await page.locator('#studio-tab-visualize').click();
      await page.locator('#studio-value-field').selectOption('value');
      assert.match(await page.locator('#studio-insights').innerText(), /30/);
    });
    await t.test('Visualization presets produce renderable geographic layers', async () => {
      for (const [visualization, expected] of [['heatmap', 'heatmap'], ['density', 'fill'], ['choropleth', 'fill'], ['contours', 'line'], ['surface', 'fill-extrusion'], ['extrusion', 'fill-extrusion'], ['tactical', 'circle'], ['points', 'circle']]) {
        await page.locator('#studio-visualization').selectOption(visualization);
        assert.deepEqual(await layerType(), [expected], visualization);
      }
      await setRange('#studio-opacity', 42);
      assert.equal(await page.locator('#studio-opacity-value').innerText(), '42%');
      await page.locator('#studio-visualization').selectOption('flow');
      assert.equal(await page.locator('#studio-visualization').inputValue(), 'points');
      assert.match(await page.locator('#geo-status').innerText(), /requires existing LineString/);
    });
    await t.test('Filters, temporal observations and undo change the map data', async () => {
      await page.locator('#studio-category-field').selectOption('category');
      await page.locator('#studio-tab-filters').click();
      await page.locator('#studio-filter-category').selectOption(JSON.stringify('North'));
      assert.match(await page.locator('#studio-insights').innerText(), /2\s+Matching source features/);
      await page.locator('#studio-filters-reset').click();
      await page.locator('#studio-tab-visualize').click();
      await page.locator('#studio-time-field').selectOption('observedAt');
      await setRange('#studio-timeline-range', 1);
      assert.match(await page.locator('#studio-timeline-label').innerText(), /2026-01-01/);
      assert.match(await page.locator('#studio-insights').innerText(), /2\s+Matching source features/);
      await setRange('#studio-timeline-range', 0);
      await page.locator('#studio-visualization').selectOption('heatmap');
      await page.locator('#studio-undo').click();
      assert.equal(await page.locator('#studio-visualization').inputValue(), 'points');
      await page.locator('#studio-redo').click();
      assert.equal(await page.locator('#studio-visualization').inputValue(), 'heatmap');
    });
    await t.test('Layer duplication, locks, order and camera survive reload', async () => {
      await page.locator('#studio-tab-layers').click();
      await page.getByRole('button', { name: 'Duplicate observations', exact: true }).click();
      await page.locator('#studio-controls-toggle').click();
      await page.locator('#studio-controls-toggle').click();
      assert.equal(await page.locator('.studio-layer').count(), 2);
      await page.getByRole('button', { name: 'Lock observations / scenario', exact: true }).click();
      await page.locator('#studio-tab-visualize').click();
      assert.equal(await page.locator('#studio-visualization').isDisabled(), true);
      await page.locator('#studio-tab-layers').click();
      await page.getByRole('button', { name: 'Unlock observations / scenario', exact: true }).click();
      await page.getByRole('button', { name: 'Move observations / scenario down', exact: true }).click();
      await page.waitForFunction(() => document.getElementById('studio-save-status').textContent === 'Saved on this device');
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('meridian.studio.v1')).workspaces[0].layers.map((layer) => layer.name));
      await page.reload({ waitUntil: 'domcontentloaded' });
      await ready();
      await page.locator('button[data-product-mode="studio"]').click();
      assert.deepEqual(await page.locator('.studio-layer-select').allTextContents(), stored);
      assert.match(await page.locator('#studio-save-status').innerText(), /Saving|Saved/);
    });
    await t.test('Comparison uses a second synchronized MapLibre camera', async () => {
      await page.waitForFunction(() => window.__testMaps[0].isStyleLoaded());
      await page.locator('[data-studio-tool="compare"]').click();
      await page.waitForFunction(() => window.__testMaps.length === 2);
      await setRange('#studio-compare-range', 35);
      assert.match(await page.locator('#studio-compare-map').getAttribute('style'), /65%/);
      await page.evaluate(() => window.__testMaps[0].jumpTo({ center: [77.22, 28.64], zoom: 12, bearing: 20 }));
      assert.deepEqual(await page.evaluate(() => window.__testMaps[1].getCenter().toArray()), await page.evaluate(() => window.__testMaps[0].getCenter().toArray()));
      await page.locator('#studio-compare-close').click();
      assert.equal(await page.locator('#studio-compare-map').isVisible(), false);
    });
    await t.test('Annotations are geographic workspace objects and can be undone', async () => {
      await page.locator('[data-studio-tool="annotate"]').click();
      await page.evaluate(() => { const map = window.__testMaps[0]; const lngLat = { lng: 77.215, lat: 28.635 }; map.fire('click', { lngLat, point: map.project(lngLat) }); });
      await page.locator('#studio-annotation-name').fill('Inspection note');
      await page.locator('#studio-annotation-note').fill('Field note from regression test');
      await page.locator('#studio-annotation-dialog button[value="save"]').click();
      await page.waitForFunction(() => document.querySelectorAll('.studio-layer').length === 3);
      assert.equal(await page.locator('.studio-layer').count(), 3);
      await page.locator('#studio-undo').click();
      assert.equal(await page.locator('.studio-layer').count(), 2);
    });
    await t.test('Remote operations remain active across modes and Stop restores prior data', async () => {
      await page.locator('#search-input').fill('Analyze the selected geographic dataset in detail');
      await page.locator('#search-submit').click();
      await page.waitForFunction(() => !document.getElementById('agent-task-chip').hidden);
      const before = await page.evaluate(() => JSON.parse(localStorage.getItem('meridian.studio.v1')).workspaces[0]);
      const selected = before.layers.find((layer) => layer.id === before.selectedLayerId);
      sockets.at(-1).send(JSON.stringify({ v: 1, type: 'agent.map', runId: agentRunId, update: { studio: { action: 'visualize', layerId: selected.id, visualization: 'points', workspaceId: before.id } } }));
      await page.locator('button[data-product-mode="explore"]').click();
      assert.equal(await page.locator('#agent-task-chip').isVisible(), true);
      await page.locator('#agent-task-stop').click();
      await page.waitForFunction(() => document.getElementById('agent-task-chip').hidden);
      await page.locator('button[data-product-mode="studio"]').click();
      await page.locator('#studio-tab-visualize').click();
      assert.equal(await page.locator('#studio-visualization').inputValue(), selected.visualization);
      await page.locator('#agent-dismiss-result').click().catch(() => {});
      await page.locator('#search-input').press('Escape');
      await page.locator('button[data-product-mode="explore"]').click();
    });
    await t.test('Unavailable population data shows readable import guidance and releases agent controls', async () => {
      await page.locator('#search-input').fill('Create the heatmap of the population of Darma Valley');
      await page.locator('#search-submit').click();
      await page.waitForFunction(() => !document.getElementById('agent-task-chip').hidden);
      const before = await page.locator('.studio-layer').count();
      sockets.at(-1).send(JSON.stringify({ v: 1, type: 'agent.limitation', runId: agentRunId, reason: 'dataset_unavailable', reversible: false, message: 'No population observations are loaded. Import a sourced GeoJSON dataset in Studio > Data, then select Heatmap and its numeric population field.' }));
      await page.waitForFunction(() => document.getElementById('agent-task-chip').hidden);
      assert.equal(await page.locator('#search-input').isDisabled(), false);
      assert.equal(await page.locator('#agent-result-details').getAttribute('open'), '');
      assert.match(await page.locator('#agent-response').innerText(), /Import a sourced GeoJSON dataset/);
      assert.equal(await page.locator('.studio-layer').count(), before);
      await page.locator('#agent-dismiss-result').click();
    });
    await t.test('Animated 3D commands can undo their own camera motion', async () => {
      await page.locator('button[data-product-mode="studio"]').click();
      await page.emulateMedia({ reducedMotion: 'no-preference' });
      await page.locator('#search-input').fill('hide 3d');
      await page.locator('#search-submit').click();
      await page.waitForFunction(() => window.__testMaps[0].getPitch() < .1);
      await page.locator('#search-input').fill('show 3d');
      await page.locator('#search-submit').click();
      await page.waitForFunction(() => window.__testMaps[0].getPitch() > 59.9);
      await page.locator('#action-history-undo').click();
      await page.waitForFunction(() => window.__testMaps[0].getPitch() < .1);
      assert.match(await page.locator('#geo-status').innerText(), /Undid/);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.locator('#agent-dismiss-result').click();
    });
    await t.test('Portable exports can be imported and deleting a project requires confirmation', async () => {
      await page.locator('.studio-workspace-tools > summary').click();
      const downloadEvent = page.waitForEvent('download');
      await page.locator('#studio-workspace-export').click();
      const download = await downloadEvent;
      const contents = require('node:fs').readFileSync(await download.path());
      assert.equal(JSON.parse(contents).meridianStudio, 1);
      await page.locator('#studio-workspace-import').setInputFiles({ name: 'backup.meridian.json', mimeType: 'application/json', buffer: contents });
      await page.waitForFunction(() => document.querySelector('#studio-workspace-select').options.length === 2);
      await page.locator('#studio-workspace-delete').click();
      await page.locator('#studio-delete-dialog button[value="cancel"]').click();
      assert.equal(await page.locator('#studio-workspace-select option').count(), 2);
      await page.locator('#studio-workspace-delete').click();
      await page.locator('#studio-delete-dialog button[value="delete"]').click();
      await page.waitForFunction(() => document.querySelector('#studio-workspace-select').options.length === 1);
      assert.equal(await page.locator('.studio-layer').count(), 2);
      await page.locator('.studio-workspace-tools > summary').click();
      await page.locator('button[data-product-mode="explore"]').click();
    });
    await t.test('Responsive sheets and utilities remain within the viewport', async () => {
      for (const width of [1440, 1280, 1024, 768, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        await page.locator('button[data-product-mode="studio"]').click();
        await page.locator('#studio-controls-toggle').click();
        await page.locator('#studio-controls-toggle').click();
        for (const selector of ['.floating-toolbar', '.floating-search', '.app-actions', '#studio-left-panel']) {
          const box = await page.locator(selector).boundingBox();
          assert(box && box.x >= -1 && box.y >= -1 && box.x + box.width <= width + 1 && box.y + box.height <= 901, `${width}px ${selector}: ${JSON.stringify(box)}`);
        }
        if (width <= 900) {
          assert.equal(await page.locator('#studio-right-panel').isVisible(), false);
          await page.locator('#studio-insights-toggle').click();
          assert.equal(await page.locator('#studio-right-panel').isVisible(), true);
          assert.equal(await page.locator('#studio-left-panel').isVisible(), false);
        }
        await page.locator('button[data-product-mode="explore"]').click();
      }
    });
    await t.test('Rendered controls pass automated accessibility checks', async () => {
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.locator('button[data-product-mode="studio"]').click();
      await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
      const results = await page.evaluate(() => axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }));
      assert.deepEqual(results.violations.map((item) => ({ id: item.id, description: item.description, nodes: item.nodes.map((node) => node.target) })), []);
    });
    if (process.env.MERIDIAN_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.MERIDIAN_SCREENSHOT_DIR, 'studio-desktop.png') });
    assert.deepEqual(errors, [], 'No uncaught browser errors');
    assert.deepEqual(styleErrors, [], 'No MapLibre style or expression errors');
  } finally { await browser.close(); }
});
