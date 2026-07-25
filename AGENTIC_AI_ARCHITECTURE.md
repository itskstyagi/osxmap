# Agentic AI Architecture

## Current System

Monument is a local-only, single-machine map workspace. The static MapLibre UI
posts a natural-language request to the Python API and receives agent lifecycle
events over a separate loopback WebSocket. SQLite persists workspace state,
provider caches, places, routes, and map tiles. The agent is one bounded
OpenAI-compatible tool-calling loop; it is not a multi-agent or RAG system.

The model has six domain tools only: city discovery, place discovery, routing,
map presentation, workspace clear, and clarification. It has no filesystem,
shell, SQL, arbitrary HTTP, or provider credentials. Tool-returned entity refs
are the only refs that can reach the map renderer or route planner.

## Source Of Truth Hierarchy

The system must use deterministic geographic sources for facts and use an LLM
only to interpret language and phrase a short companion response.

| Need | Authoritative path | Fallback |
| --- | --- | --- |
| City or administrative identity | Nominatim city search, then user clarification | No paid provider automatically selected by the model |
| Nearby known POI category | Local OSM records, then bounded Overpass tag query | Nominatim text search |
| Named or unknown POI | Local OSM records, then Nominatim | SerpApi only after OSM has no usable result |
| Road geometry | Bounded OSM/Overpass graph and local Dijkstra | OSRM-compatible router |
| Buildings | OpenBuildingMap mirror, OSM/Overpass, Overture | Explicit stale-cache response only |

Nominatim and Overpass are the appropriate OSM services here. The core OSM API
is an editing/data API, not a scalable geocoding or POI-discovery service.
Nominatim establishes a city identity and country context. Overpass performs a
bounded query against a finite tag taxonomy, for example `amenity=cafe` and
`tourism=museum`, near that known context. User text never becomes Overpass QL.

## Implemented Provider Policy

`lookup_places()` in `backend/server.py` is the sole discovery policy boundary.
Its current trace is:

```text
policy-versioned OSM lookup cache
-> local OpenStreetMap records, scoped by country
-> bounded Overpass category search, when the query maps to a reviewed tag
-> Nominatim text search
-> SerpApi fallback only when every OSM stage is empty
```

The result is a typed JSON-shaped discovery record:

```json
{
  "results": [],
  "source": "openstreetmap | serpapi",
  "lookupStage": "osm-category-search",
  "stored": false,
  "fallbackReason": "",
  "serpEligible": false
}
```

This provenance is returned to the UI and the agent. Cached Serp records cannot
masquerade as an OSM result or skip the OSM stages. Direct `provider=serp`
requests are rejected, so a UI or model cannot silently bypass the policy.

## Agent Control Structure

```text
browser request + trusted map context
-> bounded session run
-> model proposes tool calls
-> server validates JSON/schema/ref ownership
-> deterministic discovery/routing/workspace service
-> validated map update over loopback socket
-> browser validates before rendering
```

The agent has a per-session run limit, cancellation, socket-disconnect
cancellation, bounded history, eight tool rounds, provider-compatible optional
generation controls, and a check that a discovered city/place/route is actually
presented before the run can complete. Provider text is explicitly untrusted
data, never an instruction.

## Target Module Boundaries

The existing server is intentionally standard-library based but is large. New
work should move along these boundaries without a behavior-changing rewrite:

```text
backend/
  api/                 HTTP parsing, response policy, and endpoint wiring
  discovery/           city resolution, OSM taxonomy, source policy, ranking
  geo/                 OSM geometry, tiles, Overpass, routing, height inference
  storage/             SQLite schema, cache retention, workspace repositories
  agent/               intent protocol, run lifecycle, tools, confirmations
  providers/           Nominatim, Overpass, SerpApi, OSRM, Overture adapters
  evaluation/          fixture corpus, provider traces, deterministic assertions
```

First extract pure functions and repository/provider adapters behind tests;
keep `server.py` as composition root until each boundary is proven. Do not add
a vector database or more autonomous agents: geographic entities already have
better deterministic identifiers, spatial constraints, and source provenance.

## Delivery Plan

1. Complete the OSM-first foundation now implemented: provenance, bounded
   category taxonomy, direct-Serp removal, and regression coverage.
2. Add a short-lived pending-clarification record keyed by opaque choice IDs;
   the browser submits the ID rather than free-form text.
3. Move mutable actions to a proposal/confirmation capability. Pins and clear
   requests need a UI-issued, expiring token before persistence or deletion.
4. Extract the provider, discovery, and storage boundaries above. Add response
   size/content-type/schema limits and source-specific cache keys/retention.
5. Build a fixture-backed evaluation corpus. Measure grounded-entity rate,
   OSM-first rate, Serp fallback rate/cost, unsafe mutation attempts,
   clarification resolution, and p95 latency without relying on an LLM judge.
6. Add CI and browser coverage before broader UI or provider expansion. Do not
   expose this local workspace remotely without authentication and tenancy.
