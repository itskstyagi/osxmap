# Monument Python Backend

This is a Python 3.11+ local API server. Its map/cache HTTP layer uses the
standard library, while the agent WebSocket bridge uses one pinned dependency.
It replaces the original Express/Mongo service while retaining its user-visible
behavior:

- Nominatim city suggestions, exact lookup, and country detection.
- Rate-limited public-service access and durable TTL caches.
- OpenBuildingMap mirror ingestion for authoritative local building footprints, with Overpass and Overture/DuckDB fallback.
- Footprint-, type-, density-, and neighborhood-aware building-height estimation.
- Map-ready GeoJSON tile streaming with building geometry plus categorized public-place markers.
- OSM-first place lookup, durable local pins/areas/routes, and animated local Dijkstra driving routes over OSM road data.
- An OpenAI-compatible map agent that turns natural-language requests into validated city, place, and route map updates.

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
| `GET /api/suggest?q=&countryCode=` | Debounced city suggestions. |
| `GET /api/geocode?q=&countryCode=` | Exact city lookup. |
| `GET /api/country?lat=&lon=` | Browser coordinate or IP-country lookup. |
| `GET /api/context?lat=&lon=` | Resolve coarse geographic context with its source. |
| `GET /api/places?q=&countryCode=&lat=&lon=` | OSM-first place lookup, with local storage reuse and Serp fallback only when OSM has no usable result. |
| `GET /api/places/suggest?q=` | Local-only suggestions from previously stored places; never calls an external provider. |
| `GET /api/places/stored?west=&south=&east=&north=` | Canonical locally stored places in the visible map bounds. |
| `GET /api/workspace` | Current single-machine pins, areas, and route selection state. |
| `POST /api/pins` | Add a durable local workspace pin. |
| `POST /api/areas` | Store a validated local GeoJSON polygon. |
| `POST /api/routes` | Calculate or retrieve a local OSM-road shortest driving route. |
| `GET /api/routes/{routeId}` | Retrieve a stored OSM-road route for workspace restoration. |
| `DELETE /api/pins/{pinId}` / `DELETE /api/areas/{areaId}` | Remove a workspace addition. |
| `DELETE /api/workspace` | Clear pins, areas, and active workspace state without deleting stored place or route records. |
| `GET /api/tiles/{z}/{x}/{y}.geojson?region=&lat=&lon=` | Progressive city-building tile. |

Tile data is GeoJSON rather than FlatGeobuf because the static browser UI no
longer requires a JavaScript binary decoder. It retains the z14-only contract,
`204` empty tiles, cache/source/height response headers, raw-source caching,
and transient (never persisted) inferred heights.

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

Place lookup checks exact durable lookup results and stored place-name matches
before querying Nominatim/OSM. Only an empty OSM result consults SerpApi, and
`SERP_API_KEY` remains on the backend. Every received SerpApi JSON response
is retained in SQLite with its credential-redacted request descriptor and full
credential-redacted response body. Matching SerpApi requests are served from
that local record before an API key is required or a network call is made.
Each network-fetched SerpApi response is also archived as a credential-redacted
JSON file under `backend/logs/serpapi/`; the directory is ignored by Git.
Route-stop input uses `GET /api/places/suggest` for local-only suggestions. A
client can intentionally request `GET /api/places?...&provider=serp` to bypass
OSM-first lookup; that mode returns every coordinate-bearing Serp
`place_results` and `local_results` entry.
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
