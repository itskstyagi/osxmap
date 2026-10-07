# Meridian Python Backend

This is a Python 3.11+ local API server. Its map/cache HTTP layer uses the
standard library. WebSockets provides the agent bridge; Rasterio and pycountry
support bounded population/raster extraction and verified country-code lookup.
It replaces the original Express/Mongo service while retaining its user-visible
behavior:

- Nominatim city suggestions, exact lookup, and country detection.
- Rate-limited public-service access and durable TTL caches.
- OpenBuildingMap mirror ingestion for authoritative local building footprints, with Overpass and Overture/DuckDB fallback.
- Footprint-, type-, density-, and neighborhood-aware building-height estimation.
- Map-ready GeoJSON tile streaming with building geometry plus categorized public-place markers.
- OSM-first place lookup, durable local pins/areas/routes, and animated local Dijkstra driving routes over OSM road data.
- An OpenAI-compatible map agent that turns natural-language requests into validated city, place, and route map updates.
- Scoped Studio operations over already-loaded datasets and revision-guarded workspace rollback/undo.

## Run

```powershell
Copy-Item .env.example .env
python -m pip install -r ..\requirements.txt
python server.py
```

The API listens on `http://127.0.0.1:8787` by default. It creates its SQLite
cache at `backend/data/monument.db`; no database server or package installation
is required. Monument is deliberately local-only: startup rejects non-loopback
`HOST` values because this single-machine workspace has no accounts or tenant
isolation.

The server loads the root `.env` first for a direct migration from the original
project, then `backend/.env`, whose values override the root file. Explicit
shell environment variables always take precedence over both files.

## AI Map Agent

Set these backend-only variables in the root or `backend` `.env` file:

```text
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=...
MODEL_NAME=...
```

`OPENAI_BASE_URL` is an OpenAI-compatible API root. The backend sends model
requests to its `/chat/completions` endpoint; the static UI never receives the
base URL, API key, or model name.

The HTTP API listens on `PORT` and the agent event socket listens on `PORT + 1`
(defaults: `8787` and `8788`). The browser posts an agent request to
`POST /api/agent/runs` and receives progress, clarification requests, validated
map updates, errors, and cancellation events on the loopback WebSocket. Socket
origin checks allow only local browser origins even when `ALLOWED_ORIGINS=*`.

Agent requests use a fixed tool allowlist over existing city, place, route, and
workspace services. They cannot make arbitrary HTTP requests, read files, run
SQL, or receive provider credentials. Model prompts and responses are not
persisted. Agent-created pins, areas, selected-city context, and active routes
use the same local workspace store as manual controls. `clear map` is an
explicit workspace mutation that clears these items and the visible map state.

Studio adds `studio_operation` for validated visualization, filtering, summary,
high-value selection, scenario duplication, and comparison. Requests identify
an existing loaded layer and an explicit viewport, selection, layer, or workspace
scope. The service passes a bounded context inventory as data to the model and
queues a validated operation for browser-side computation; it does not claim to
have measured statistics or supply missing datasets. Categorical filters retain
JSON scalar types, including booleans.

Web research uses the existing configured SerpApi transport/cache through
`search_web` (`google`, `google_news`, or `google_scholar`). Google Maps remains in
the existing OSM-first place lookup. Search metadata is bounded and credential
redacted; citation URLs and acquisition date are separate from publication/date
of observations. Cached responses may be historical, not live/latest.
Research localization follows a resolved target city/`nearRef`, not an unrelated
map or Geo-IP country. Relevant readable sources are ranked before the result cap;
challenge-only pages and duplicate citations are excluded.

`read_web_source` accepts only opaque sources returned by search or discovered
page links. It reads bounded public HTML/text/GeoJSON/CSV, validates and pins
public DNS addresses on each request and redirect, verifies TLS hostnames, and
blocks credentials/private hosts/binary formats/oversize responses. Retrieved
text and tables are untrusted evidence, never executable instructions. No
cookies, authentication state, proxies, or arbitrary model-supplied URLs are used.

`load_web_dataset` transfers actual parsed GeoJSON or coordinate CSV to Studio.
`map_source_table` joins numeric source cells to exact provider settlement names
inside geographic scope, or using an actual source administrative-region column.
Schools/businesses/unknown POIs cannot represent a census settlement. Values
cannot be supplied or overridden by model arguments. Source tables produce
partial settlement-point heatmaps, not a continuous census population grid.
Quantitative heatmaps require original Point observations or extracted raster
cell centers; regional polygon or
shared MultiPoint totals are not redistributed. Datasets containing several
census years/dates require an actual source `timeField`/`timeValue` selection;
table joins can use `timeColumn`/`timeValue`. Source row/header/context provenance
and the selected observation are retained rather than combining populations
across years. No valid numeric observations in scope is an explicit rejection.
Data is capped to 4 MB per agent transfer and validated again in the browser.
Model context contains field/count metadata, not the transferred feature data.

`load_population(cityRef, year?)` discovers official WorldPop country metadata
and 1 km population-count GeoTIFFs, then extracts genuine cell-center values for
the verified city extent or frozen geographic scope. It does not need SerpApi.
The available collection covers 2000-2020: the default is its latest available
year, not a claim of current population. Explicit years are never silently
substituted. Observation year, resolution, units, license, and attribution travel
with the layer. A bounding-box crop is not an administrative population total.

`load_raster_dataset(sourceRef, cityRef?, band?)` also extracts numeric observations
from discovered public GeoTIFFs. Downloads are DNS-pinned and limited to 64 MiB;
decoding uses memory-only GTiff input, supported verified CRS, and at most 10,000
cells in the cropped window. NoData is masked and zero retained. Oversized crops
are rejected rather than silently sampled. PDF, authenticated portals, and
arbitrary API engines still need another supported source or reviewed extraction.

For statistical research, a unique `find_city` result immediately emits a labeled
study-extent preview. `report_limitation` requires relevant available acquisition
paths to be tried and emits citations plus the specific source issue. A
`contextOnly` limitation retains that truthful preview, never an invented heatmap.
Other earlier map mutations are rolled back when safe; rollback/conflict metadata
accompanies the event. Cancellation still restores the guarded prior state.
For omitted geographic presentation, the model gets one bounded recovery turn
to present returned references or report a limitation, not an unbounded retry.

Each run checkpoints pins, areas, and active state. Cancellation/failure restores
that checkpoint only when SQLite revision and fingerprint guards confirm there
were no intervening writes. Provider calls occur outside the short write
transactions. Reusable provider caches and stored route records are retained.
Terminal events include `rolledBack` and conflict details, or `reversible` on
successful completion/clarification. `POST /api/agent/undo` takes `sessionId` and
`runId` and returns `{workspace, undone: true}`. Tokens are single-use, bounded to
20 process-wide, expire on socket disconnect/restart, and cannot overwrite later
manual edits. Purely browser-side operations use the frontend's undo mechanism.

## Safe Tests

From the repository root:

```powershell
python -B -m backend.test_isolated
```

This runner bypasses `.env` loading, uses temporary databases, and blocks outbound
HTTP. It covers both `python backend/server.py` and module startup, public source
reader fixtures, Serp cache/engine/error handling, sourced/table-matched dataset
transfers, existing geographic services, scoped tools, additive revision
migration, CORS metadata, cancellation, concurrent writes, and owned undo. Avoid
importing `backend.server` directly merely to run tests against a real configured
workspace: module initialization opens its configured SQLite cache.

## UI Deployment

The static UI is in `../UI` and should be served locally alongside the local
API. Configure an alternate loopback origin before `app.js` when needed:

```text
window.MONUMENT_API_URL = 'http://127.0.0.1:8787';
```

Do not expose this backend on a network: it intentionally has no authentication
or user accounts.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Service configuration status. |
| `POST /api/agent/runs` | Start an AI map run for an active browser socket session. |
| `POST /api/agent/undo` | Undo an owned completed run when no later workspace edits conflict. |
| `GET /api/suggest?q=&countryCode=` | Debounced city suggestions. |
| `GET /api/geocode?q=&countryCode=` | Exact city lookup. |
| `GET /api/country?lat=&lon=` | Browser coordinate or IP-country lookup. |
| `GET /api/context?lat=&lon=` | Resolve coarse geographic context with its source. |
| `GET /api/places?q=&countryCode=&lat=&lon=` | OSM-first place lookup. Returns source, lookup stage, cache state, and fallback reason; SerpApi is considered only after OSM has no usable result. |
| `GET /api/places/suggest?q=` | Local-only suggestions from previously stored places; never calls an external provider. |
| `GET /api/places/stored?west=&south=&east=&north=` | Canonical locally stored places in the visible map bounds. |
| `GET /api/workspace` | Current single-machine pins, areas, and route selection state. |
| `POST /api/workspace/state` | Persist active route and selected-city context. |
| `POST /api/pins` | Add a durable local workspace pin. |
| `POST /api/areas` | Store a validated local GeoJSON polygon. |
| `POST /api/areas/{areaId}` | Rebuild an existing measured area. |
| `POST /api/routes` | Calculate or retrieve a local OSM-road shortest driving route. |
| `GET /api/routes/{routeId}` | Retrieve a stored OSM-road route for workspace restoration. |
| `DELETE /api/pins/{pinId}` / `DELETE /api/areas/{areaId}` | Remove a workspace addition. |
| `DELETE /api/workspace` | Clear pins, areas, and active workspace state without deleting stored place or route records. |
| `GET /api/tiles/{z}/{x}/{y}.geojson?region=&lat=&lon=` | Progressive city-building tile. |

Tile data is GeoJSON rather than FlatGeobuf because the static browser UI no
longer requires a JavaScript binary decoder. It retains the z14-only contract,
`204` empty tiles, cache/source/height response headers, raw-source caching,
and transient (never persisted) inferred heights. Tile metadata and `Retry-After`
headers are explicitly exposed to the local cross-origin browser UI.

## Data Sources

Set `OPENBUILDINGMAP_API_URL` to the base URL of a local OpenBuildingMap mirror,
such as `http://127.0.0.1:8000`, to make it the primary building-footprint
source. The backend discovers its downloaded GeoPackages through `/files`,
queries the matching quadkey on demand, and converts the returned WKT polygons
to GeoJSON. Mirror tiles have a separate seven-day cache by default; adjust it
with `OPENBUILDINGMAP_TILE_TTL_DAYS`.
`height` values in the `HBET:min-max` form are treated as an estimated storey
range, not as a measured height. The renderer uses the range midpoint unless
nearby compatible OpenBuildingMap buildings from the same community, or a
stricter same-source local cohort when no community is supplied, provide a
bounded calibration; these results remain marked as estimated.

When the mirror has no matching file or is unavailable, the backend continues
with OpenStreetMap and then Overture. OpenStreetMap place markers remain
available when mirror footprints are in use.

The same fair-use limits apply as before: public Nominatim and Overpass are for
development and light personal use. Set a real contact in `APP_USER_AGENT`.
When Overpass responds with `429`, the server pauses every new Overpass query
for at least `OVERPASS_BACKOFF_SECONDS` (120 by default) and returns a retry
delay to the UI. Existing cached tiles remain available during that pause.
The Overture fallback requires the bundled `../__duckdb/duckdb.exe` with its
`spatial` and `httpfs` extensions installed, unless `DISABLE_OVERTURE=1`.

## Geography And Routing

The browser keeps geographic context explicit: a selected place takes
precedence over consented browser coordinates, which take precedence over the
coarse IP/locale fallback. Precise browser coordinates are not written to the
database unless the user turns them into a pin.

City identity is resolved with Nominatim, the OSM geocoding/search service.
Known nearby categories such as cafes, museums, parks, pharmacies, hotels, and
fuel stations first use a bounded, reviewed-tag Overpass query around the map
context (`OSM_PLACE_SEARCH_RADIUS_METERS`, 5 km by default). Name and unknown
category search then uses Nominatim. Stored and lookup-cache results qualify as
OSM reuse only when their provenance is OpenStreetMap; prior SerpApi records
can never skip these OSM stages. Only an empty OSM result consults SerpApi, and
`SERP_API_KEY` remains on the backend. The response exposes the actual source,
lookup stage, cache state, and fallback reason so the UI and agent do not need
to infer provenance. Every received SerpApi JSON response
is retained in SQLite with its credential-redacted request descriptor and full
credential-redacted response body. Matching SerpApi requests are served from
that local record before an API key is required or a network call is made.
Each network-fetched SerpApi response is also archived as a credential-redacted
JSON file under `backend/logs/serpapi/`; the directory is ignored by Git.
Route-stop input uses `GET /api/places/suggest` for local-only suggestions.
Submitting a route-stop search uses the same server-enforced OSM-first policy;
clients cannot select SerpApi as a first source. A Serp fallback still returns
every coordinate-bearing `place_results` and `local_results` entry when both
OSM stages have no usable result.
The database also stores normalized place data, pins, areas, route geometry,
and OSM-only route failures through additive migrations.

Places are deduplicated as they enter the local store. The first confirmed
record becomes the canonical place and alternate provider IDs map to it through
local aliases. A merge requires coordinates within 35 metres and either the
same normalized name or a conservative locality-style extension such as
`Pan Oasis` and `Pan Oasis Society`. Differently named businesses at the same
mall remain separate places.

Route plans contain two to 50 ordered waypoints. The backend fetches one
bounded, cached graph of OSM ways tagged as drivable, then runs Dijkstra's
algorithm locally for each consecutive leg. It traces every directed road
segment examined before each leg destination is settled, then stores both that
trace and the resulting distance-shortest path for replay. The graph honors
one-way, `access`, `motor_vehicle`, and `motorcar` restrictions, but does not
model turn restrictions, live traffic, or road speeds; its displayed duration
is an estimate. Requests are limited to nearby pins so the public Overpass
query and the animated graph remain bounded.

`OSM_ROUTER_BASE_URL` defaults to the public OSRM demonstration service as a
fallback when the OSM graph cannot be fetched or does not connect the pins. It
has no production availability guarantee or pinned graph version; production
must configure a managed or self-hosted compatible router. Only an explicit
OSRM `NoRoute` can enter the optional Serp directions fallback. That fallback
is disabled by default; its complete SerpApi response and the explicitly
approximate endpoint connector are retained locally, but they do not
contribute data to OSM-review records.
