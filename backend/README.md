# Monument Python Backend

This is a standard-library Python 3.11+ API server. It replaces the original
Express/Mongo service while retaining its user-visible behavior:

- Nominatim city suggestions, exact lookup, and country detection.
- Rate-limited public-service access and durable TTL caches.
- OpenBuildingMap mirror ingestion for authoritative local building footprints, with Overpass and Overture/DuckDB fallback.
- Footprint-, type-, density-, and neighborhood-aware building-height estimation.
- Map-ready GeoJSON tile streaming with building geometry plus categorized public-place markers.

## Run

```powershell
Copy-Item .env.example .env
python server.py
```

The API listens on `http://127.0.0.1:8787` by default. It creates its SQLite
cache at `backend/data/monument.db`; no database server or package installation
is required. Set `HOST=0.0.0.0` only when the API must be reachable remotely.

The server loads the root `.env` first for a direct migration from the original
project, then `backend/.env`, whose values override the root file. Explicit
shell environment variables always take precedence over both files.

## UI Deployment

The static UI is in `../UI` and may be hosted anywhere. Configure the API
origin with a query parameter, for example:

```text
https://ui.example.com/?api=https://api.example.com
```

Or set `window.MONUMENT_API_URL` before loading `UI/app.js`. Set
`ALLOWED_ORIGINS` to the UI origin or origins before exposing the backend.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Service configuration status. |
| `GET /api/suggest?q=&countryCode=` | Debounced city suggestions. |
| `GET /api/geocode?q=&countryCode=` | Exact city lookup. |
| `GET /api/country?lat=&lon=` | Browser coordinate or IP-country lookup. |
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

When the mirror has no matching file or is unavailable, the backend continues
with OpenStreetMap and then Overture. OpenStreetMap place markers remain
available when mirror footprints are in use.

The same fair-use limits apply as before: public Nominatim and Overpass are for
development and light personal use. Set a real contact in `APP_USER_AGENT`.
The Overture fallback requires the bundled `../__duckdb/duckdb.exe` with its
`spatial` and `httpfs` extensions installed, unless `DISABLE_OVERTURE=1`.
