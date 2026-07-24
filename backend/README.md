# Monument Python Backend

This is a standard-library Python 3.11+ API server. It replaces the original
Express/Mongo service while retaining its user-visible behavior:

- Nominatim city suggestions, exact lookup, and country detection.
- Rate-limited public-service access and durable TTL caches.
- OpenBuildingMap mirror ingestion for authoritative local building footprints, with Overpass and Overture/DuckDB fallback.
- Footprint-, type-, density-, and neighborhood-aware building-height estimation.
- Map-ready GeoJSON tile streaming with building geometry plus categorized public-place markers.
- OSM-first place lookup, durable local pins/areas/routes, and development-only public OSRM driving routes.

## Run

```powershell
Copy-Item .env.example .env
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

## UI Deployment

The static UI is in `../UI` and should be served locally alongside the local
API. Configure the API origin with a loopback query parameter when needed:

```text
http://127.0.0.1:8080/?api=http://127.0.0.1:8787
```

Or set `window.MONUMENT_API_URL` before loading `UI/app.js`. Do not expose this
backend on a network: it intentionally has no authentication or user accounts.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Service configuration status. |
| `GET /api/suggest?q=&countryCode=` | Debounced city suggestions. |
| `GET /api/geocode?q=&countryCode=` | Exact city lookup. |
| `GET /api/country?lat=&lon=` | Browser coordinate or IP-country lookup. |
| `GET /api/context?lat=&lon=` | Resolve coarse geographic context with its source. |
| `GET /api/places?q=&countryCode=&lat=&lon=` | OSM-first place lookup, with local storage reuse and Serp fallback only when OSM has no usable result. |
| `GET /api/places/stored?west=&south=&east=&north=` | Canonical locally stored places in the visible map bounds. |
| `GET /api/workspace` | Current single-machine pins, areas, and route selection state. |
| `POST /api/pins` | Add a durable local workspace pin. |
| `POST /api/areas` | Store a validated local GeoJSON polygon. |
| `POST /api/routes` | Calculate or retrieve an OSM driving route. |
| `GET /api/routes/{routeId}` | Retrieve a stored OSM route for workspace restoration. |
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
The database also stores normalized place data, pins, areas, route geometry,
and OSM-only route failures through additive migrations.

Places are deduplicated as they enter the local store. The first confirmed
record becomes the canonical place and alternate provider IDs map to it through
local aliases. A merge requires coordinates within 35 metres and either the
same normalized name or a conservative locality-style extension such as
`Pan Oasis` and `Pan Oasis Society`. Differently named businesses at the same
mall remain separate places.

`OSM_ROUTER_BASE_URL` defaults to the public OSRM demonstration service for
internal development. It has no production availability guarantee or pinned
graph version; production must configure a managed or self-hosted compatible
router. Only an explicit OSRM `NoRoute` can enter the optional Serp directions
fallback. That fallback is disabled by default; its complete SerpApi response
and the explicitly approximate endpoint connector are retained locally, but
they do not contribute data to OSM-review records.
