# Meridian Browser UI

This folder is a static HTML, CSS, and browser-JavaScript application. It has
no build step and no Node dependency.

## Run

Serve this folder from any static web host. For local development:

```powershell
python -m http.server 8080 --bind 127.0.0.1 --directory UI
```

Open `http://127.0.0.1:8080`.

Run the dependency-free interaction regression suite with Node:

```powershell
node --test UI/app.test.cjs UI/studio-data.test.cjs UI/studio.test.cjs
```

These dependency-free tests cover Explore interactions, geographic validation,
analytics, project persistence, and undo. `UI/studio.browser.test.cjs` additionally
uses a real Edge/MapLibre renderer, fixture-backed HTTP/WebSocket responses, and
axe accessibility checks. It requires the optional `playwright-core`,
`maplibre-gl@5.24.0`, `maplibre-contour@0.0.5`, and `axe-core` packages plus an
installed Edge browser. Install these in a separate tooling directory and set
`NODE_PATH` to that directory's `node_modules` if they are not already available.
With the static server running:

```powershell
$env:MERIDIAN_UI_URL = 'http://127.0.0.1:8080'
node --test UI/studio.browser.test.cjs
```

The browser suite skips when Playwright is absent. Screen-reader behavior,
mobile virtual keyboards, and live provider reliability still need manual
validation. The application itself has no Node runtime dependency or build step.

The interface defaults to dark mode. The toolbar theme toggle switches the
controls between light and dark and stores the preference locally. Satellite
and street cartography keep their dark appearance; terrain follows the theme.

## Local API Host

The default API is `http://127.0.0.1:8787`. Meridian accepts only loopback API
origins. A local hosting page can set an alternate local port before `app.js`:

```text
window.MONUMENT_API_URL = 'http://127.0.0.1:8787';
```

Shared URLs and local storage cannot change the API origin. The Python backend
must remain bound to a loopback host.

The map agent uses a second loopback WebSocket port derived from the API port:
`ws://127.0.0.1:8788` for the default API. It carries agent progress, follow-up
questions, and validated map updates. The browser sends map-agent commands to
the backend over HTTP; it never receives an OpenAI-compatible endpoint, model
name, or API key.

## Shared City Links

Load and explore a city directly with URL parameters:

```text
https://ui.example.com/?city=Noida&country=India
```

`country` is optional and is included in the city lookup when present. The
misspelled `counrty` parameter is accepted for links created with that spelling.

## Explore And Studio

Explore preserves city search, driving routes, terrain, measured areas, saved
places, and Map Details. Studio adds a persistent operator workspace over the
same MapLibre engine. Its left rail contains Layers, Data, Visualize, and Filters;
the right rail contains feature inspection, computed metrics, provenance, and
history. Mobile uses one collapsible sheet at a time. Map camera and terrain
controls are moved into Studio, not duplicated or replaced.

Studio supports up to eight named local workspaces and 30 layers per workspace.
Import GeoJSON, capture loaded map data, or explicitly load an illustrative
example. Raw GeoJSON files stay in the browser; asking Meridian sends the prompt
and bounded map/layer metadata to the configured AI service. Metadata can include
the map extent, saved place coordinates, layer names, field names, and sources.
Do not include private data unless that service is approved for it.

Layers can be shown, hidden, renamed, reordered, locked, copied, filtered, and
removed. Point, density, heatmap, choropleth, contour, extrusion, flow, scalar
surface, and tactical displays use the supplied data. Choose a numeric field and
units where needed. Missing values are not zeros; unsupported geometry and
insufficient samples are reported instead of manufacturing a result.

- Density cells encode feature counts, not population per unit area.
- Contours/surfaces interpolate supplied points within their convex hull and
  are explicitly approximate, not DEM measurements or surveyed terrain.
- Extrusion uses physical heights only for a polygon field explicitly in `m`;
  other heights are a normalized visual index.
- Flow arrowheads follow supplied coordinate order, not inferred travel direction.
- High-value analysis selects an observed 90th-percentile subset; it is not a
  spatial-significance test or an operational suitability recommendation.
- Examples are synthetic and clearly labeled. No live population, fleet, flood,
  or risk dataset is bundled.

### Population Heatmaps

A heatmap needs geographically distributed numeric observations. A location
lookup, a valley-wide population total, a list of villages, and internet snippets
cannot establish that distribution. From Explore, `Create a heatmap of population
of Noida` resolves and outlines the study extent, loads an actual WorldPop grid,
and opens the sourced visualization in Studio without manual import. The direct
population reader does not require SerpApi. The 1 km archive covers 2000-2020;
its default is explicitly historical modeled population, not a current census.
The layer and legend expose the reference year, resolution, units, and source.

Meridian can also research alternatives using configured SerpApi Google Search,
Google News, and Google Scholar. It reads bounded public HTML/text/CSV/GeoJSON
and supported numeric GeoTIFFs, or joins actual table rows to verified settlements. Research
citations appear as clickable source links in the result and layer provenance.

For automatic research, use **Workspace** scope, or first center on Darma Valley
and select the intended geographic region. **Selected layer** scope cannot create
a new dataset. A supported source can become a heatmap without manual import:

```text
Research official population data for Darma Valley, Uttarakhand, India.
Use real geographic observations or sourced village population rows.
Create a heatmap, cite the source and reference year, and state coverage limits.
```

The agent must try relevant acquisition tools before declaring data unavailable.
If retrieval fails, a labeled study extent remains as geographic context only;
no population values are substituted. Stop and guarded rollback restore the
previous state. Study extents are not authoritative administrative boundaries.
Search snippets never become measurements. For a settlement table, exact place
names, provider settlement types, and scoped geography or source administrative
columns must agree; unknown POIs and ambiguous name matches are refused. Table
values are copied from the read source, not supplied by the language model.
Point heatmaps retain actual source locations, not polygon/MultiPoint regional
totals converted into proxy points. Multi-year datasets must select one actual
source observation; different census years are never combined into a population
layer. Original table headers, selected cells, source context, and observation
year are retained as provenance. Missing numeric values in the selected scope
are rejected rather than displayed as invented or zero observations.

Automatic raster reading validates georeferencing, retains actual pixel values,
and masks NoData. Downloads are limited to 64 MiB, crops to 10,000 source-window
cells, and agent transfers to 4 MiB. It does not silently sample oversized grids.
PDF, authenticated portals, unsupported grids, or larger extractions still need
another supported source or a reviewed GIS extraction. Manual import remains useful
for these cases:

1. Obtain a sourced population dataset for the intended year and geographic
   extent, such as a modeled population-count grid from the WorldPop data portal
   (`https://hub.worldpop.org/`) or georeferenced official census observations.
2. If the source is a GeoTIFF raster, use a GIS tool such as QGIS to clip the
   raster to the intended region, convert the clipped valid pixels to points,
   and export WGS 84 GeoJSON. Retain the numeric population field and source/year.
   Do not generate random points from a regional total.
3. In **Studio > Data**, import that GeoJSON and specify its source and units.
   For a population-count raster use estimated people per source cell, not
   people/km2 unless the original values are actually densities.
4. Select the imported layer, open **Visualize**, choose **Heatmap**, and select
   the population field. Alternatively, ask Meridian to use that exact loaded
   layer and field with **Selected layer** scope.

Heatmaps are smoothed relative-intensity displays, not a literal cell-density
map, population census, or real-time measurement. Population models retain their
source date, resolution, and uncertainty. Nonnegative numeric heatmap values are
scaled by their displayed maximum; zero observations add no intensity. Signed
fields use relative min-max weights. Darma Valley requires a deliberately
chosen region: a geocoder may return a point or administrative bounds rather
than the valley boundary. Use **Select region** or an independently sourced
boundary; do not label an entire district total as the valley's population.

Date/year fields enable a timeline for the selected layer. Comparison captures
a read-only reference map and synchronizes its camera with the current scene;
change layers or scrub time to compare. Annotations are persistent geographic
points. A two-corner rectangle sets a geographic selection/filter.

Workspaces save to this origin's localStorage, including data, source notes,
camera, layers, analyses, and 20 recent reversible Studio changes. Storage is
device/origin-specific and subject to browser quotas. If saving fails, the UI
explicitly reports memory-only state: export before closing the tab. GeoJSON
imports are bounded to 8 MB, 10,000 features, and 100,000 positions; aggregate
workspace backups are bounded to 32 MB and can be imported with the same limit.
Export/import uses portable `.meridian.json` files. Workspace deletion requires
confirmation and does not delete Explore pins, routes, or provider caches.

## Map Agent And Manual Controls

The unified search field accepts places, coordinates, and map instructions.
The Ask Meridian toggle explicitly selects agent intent. Supported local
instructions such as `show heatmap`, `summarize`, and `show 3d` do not require a
model request. Other instructions use the backend's validated tools. Studio
exposes viewport, selected-region, active-layer, and workspace scopes. The agent
receives a bounded inventory rather than raw imported feature collections.
Web research has four search calls, five source reads, and two dataset loads per
run. Public reading validates each URL/DNS/redirect, blocks private or credential
addresses, pins public IP connections, and caps bytes/time. Source text is treated
as untrusted evidence, never as system instructions. Searches and model prompts
go to the configured providers; public-source reads contact their publishers.
Serp search responses reuse the existing local credential-redacted cache, which
may contain historical results. Source publication, dataset year, search receipt,
and page-read date are kept distinct. The agent uses only reviewed engine tools,
not arbitrary provider parameters or unrestricted "all APIs" access.
If the model gathers places then stops without presenting an achievable map,
the service gives it one bounded recovery turn. It can present known references
or use `report_limitation` for missing data/tools. Limitations display visible
guidance and retire the run without substituting unrelated geography. Earlier
map mutations in that same run are rolled back when the revision guard permits.

Progress and Stop remain available while changing product modes. Detailed
results and tool activity are expandable rather than a permanent chat panel.
Agent-produced Studio operations are validated against the actual local dataset.
Cancelled/failed backend mutations roll back only if no intervening edit would
be overwritten. Completed map operations expose session-local undo; backend
undo tokens expire on disconnect/restart and refuse conflicting later edits.
Studio redo branches are invalidated when a new map operation is committed.

Route planner and Saved places are contextual tools, not top-level product
modes. Search suggestions support arrows, Enter, and Escape, with inline
no-result and failure feedback. Ctrl/Cmd+Z undoes a map action outside editable
fields; Shift+Ctrl/Cmd+Z redoes a Studio change.

## Location And Geography Tools

When neither a shared location nor a saved view is available, startup requests
the browser's public IP from
`api.ipify.org` and resolves its approximate location through
`ip-api.services.brahmai.in`. The resulting Geo-IP location becomes the map
anchor and starts the normal nearby building-data stream; it does not create a
route stop. The view center and route-stop draft are saved on this device.
A shared city URL takes precedence over a saved view. If
the Geo-IP lookup fails, the map remains available with a locale-derived
country bias until a location is selected. `ADD MY LOCATION` still asks for
browser permission and assigns that coordinate to the active route stop.
`ADD APPROX. LOCATION` uses the same Geo-IP lookup and also assigns it to the
active route stop. Both Geo-IP providers receive the request information needed
to perform that lookup.

The UI loads MapLibre GL, the OpenFreeMap base style, and public Terrarium
elevation tiles. The `3D` control switches terrain and camera pitch together;
Satellite starts flat unless depth is explicitly enabled. The compass resets
bearing without changing center or zoom. Terrain inspection marks the sampled
point, and Map Details can copy its coordinates. Self-host these resources for
production or offline deployments.

The route planner keeps the main task focused: type a start, stop, or
destination directly into its row, then arrange the ordered stops from A
through the destination. As the user types, the row offers only matching
places stored from earlier searches; it does not call an external provider.
Pressing Enter searches local and OpenStreetMap data first, then uses SerpApi
only when those OSM stages have no usable result. The status line names the
actual source and fallback reason, and every coordinate-bearing result is
marked on the map. Selecting a result marker or suggestion assigns it to the
active stop. Plans support up to 50 stops, including repeated stops, and can be
reordered or edited before tracing. Map pins and explicit location results can
also fill the active stop. Area measurement and saved-pin maintenance live
under `More map tools` so they do not compete with routing.

Pins, areas, the selected city, and the active route are restored from the
local workspace on reload. Search-result markers remain transient. `Clear
workspace` asks for confirmation before removing local additions. An
unambiguous agent request to clear the map also removes the
persisted workspace state and resets the visible map; reusable provider caches
and stored route records remain available locally.

The backend fetches a bounded, cached OSM drivable-road graph and runs
Dijkstra's distance-shortest-path search for each leg in order. Every road
segment examined before a leg destination is settled is available through the
optional `Replay calculation` action. The final route appears immediately after
calculation, with distance, estimated driving time, and source beneath the
planner. Replay can be stopped at any time. One-way and basic
vehicle-access tags are respected; this is not a full turn-cost or
traffic-aware navigation model. OSRM is used only when the local OSM graph
cannot be loaded or cannot form a route. `Clear workspace` removes all
persisted pins, areas, route stops, routes, and result markers while retaining
provider place records and reusable route records.
