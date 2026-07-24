# Monument Improvement Backlog

## Purpose

This document is the implementation backlog for the current Monument / City
Explorer codebase. It records every improvement identified during the
architecture, provider, UX, accessibility, security, and operations review.

Locations are evidence from the current working tree. They are not permanent
identifiers: update a row's locations when a change moves the relevant code.
This document intentionally contains no credentials or private configuration
values.

## Status And Priority

| Field | Meaning |
| --- | --- |
| Status | `Not started`, `In progress`, `Blocked`, `Done`, or `Deferred`. |
| P0 | Correctness, privacy, security, or materially misleading user behavior. Address before public deployment. |
| P1 | High-value reliability, data quality, workflow, accessibility, or production-readiness work. |
| P2 | Important hardening or product expansion after the core experience is reliable. |
| Evidence | Current behavior and source locations that establish the item. |
| Target state | The measurable outcome expected after implementation. |

## Delivery Sequence

| Phase | Scope | Backlog IDs |
| --- | --- | --- |
| 1 | Building-source correctness and transparent map status | CR-01 through CR-05, DP-01 through DP-09, UX-05 |
| 2 | Workspace integrity and core interactions | CR-06 through CR-08, UX-01 through UX-16, AX-01 through AX-10 |
| 3 | Privacy, authentication, request protection, and retention | CR-09 through CR-14, OP-01 through OP-06 |
| 4 | Provider resilience, cache correctness, deployment, and observability | DP-10 through DP-20, OP-07 through OP-12 |
| 5 | Optional product expansion | EX-01 through EX-10 |

## P0: Correctness, Privacy, And Safety

| ID | Status | Finding | Evidence and locations | Target state |
| --- | --- | --- | --- | --- |
| CR-01 | Done | Decode the geometry format returned by OpenBuildingMap. | GeoPackage/WKB and raw WKB polygons now decode alongside WKT. Regression coverage is in `backend/test_server.py`. `backend/server.py:1459-1640`, `backend/test_server.py:1-50` | Decode GeoPackage/WKB safely, or request GeoJSON/WKT from the mirror. Add fixtures proving OpenBuildingMap buildings reach the map. |
| CR-02 | Done | Report city data source and coverage truthfully. | Tile metadata now flows from API headers through the worker and is aggregated by source, freshness, failure state, and inferred-building count in the stream card. `backend/server.py:2091-2120`, `UI/tile-worker.js:9-94`, `UI/app.js:525-583`, `backend/test_server.py:45-57` | Aggregate metadata by tile. Show source mix, loaded/failed/stale tiles, truncation, and measured/derived/inferred counts. |
| CR-03 | Done | Make the height legend match rendering. | The unsupported height key was removed. Inferred buildings now use lower extrusion opacity, while their estimation method remains available in the feature popup. `UI/index.html:37-47`, `UI/app.js:238-241`, `UI/styles.css:451-545` | Remove the legend, or implement documented height-color stops. Clearly distinguish inferred height with an additional non-color cue. |
| CR-04 | Done | Correct height provenance and confidence. | Rendered features now distinguish measured, source-derived, matched, range-estimated, and inferred heights. Floor-derived and matched values render as non-authoritative and the popup displays confidence. `backend/server.py:1881-2050`, `UI/app.js:34-54`, `backend/test_server.py:59-76` | Return separate measured, source-derived, matched, and inferred labels with confidence, method, and uncertainty. Require robust footprint overlap for source matches. |
| CR-05 | Done | Enforce valid building extrusion height/base relationships. | Every height path is raised above `minHeight` when necessary, records `heightAdjustedToBase`, and discloses the adjustment in the feature popup. `backend/server.py:1775-2050`, `UI/app.js:600-635`, `backend/test_server.py:78-93` | Normalize, reject, or repair `height <= minHeight`; preserve the correction in feature provenance. |
| CR-06 | Done | Keep areas consistent when pins change. | Pin deletion now marks dependent areas invalid in SQLite and removes their stale overlays. The workspace lists every area with view, rebuild, and delete actions. `backend/server.py:579-628`, `UI/app.js:730-824`, `UI/app.js:943-1047`, `backend/test_server.py:95-116` | List areas with focus, delete, recompute, and invalid-state actions. Invalidate or clearly mark areas affected by pin changes. |
| CR-07 | Done | Prevent accidental pins while inspecting map features. | Pin mode now ignores rendered feature clicks, exposes a cancel state, supports Escape, and confirms an empty-map pin before persistence. `UI/app.js:393-402`, `UI/app.js:920-946`, `UI/app.js:1120-1138`, `UI/index.html:26-33` | Exclude interactive layer hits from pin creation. Add visible cancel, `Esc`, confirmation or undo. |
| CR-08 | Done | Validate area topology and calculate area summaries on the server. | The API now validates ring topology, hole containment, intersection, and geometry limits. It derives persisted square-metre summaries server-side. `backend/server.py:1082-1190`, `backend/server.py:2430-2450`, `backend/test_server.py:118-131` | Validate topology, ring containment, vertex count, and self-intersection. Compute trusted area values server-side. |
| CR-09 | Done | Keep the unauthenticated global workspace local-only. | The selected product scope is a single-machine workspace, not a remote multi-user service. Startup now rejects non-loopback hosts and documentation explicitly prohibits network exposure. `backend/server.py:64-75`, `backend/server.py:2500-2515`, `backend/test_server.py:133-139`, `backend/README.md:20-39` | Preserve local-only operation. Reopen this item only if remote/multi-user deployment becomes a requirement. |
| CR-10 | Done | Bound local request concurrency and provider fan-out. | A configurable semaphore now bounds all API requests and returns `503` with `Retry-After` under saturation. Regression coverage verifies the busy response. `backend/server.py:102-145`, `backend/server.py:2290-2460`, `backend/test_server.py:141-158`, `backend/.env.example:1-10` | The local-only service uses a configurable bounded request gate. Reopen for per-user quotas if remote deployment becomes a requirement. |
| CR-11 | Done | Make automatic location detection opt-in. | Startup uses locale-only country bias. Browser location and approximate IP lookup are explicit controls, and the latter discloses its providers in the UI documentation. `UI/app.js:189-202`, `UI/app.js:400-445`, `UI/index.html:26-33`, `UI/README.md:43-52` | Start with search or an explicit approximate-location action that names providers, purpose, and accuracy. |
| CR-12 | Done | Align coordinate retention with the privacy contract. | Browser-coordinate country lookup no longer reads or writes geocode cache records; coordinates persist only if a user explicitly creates a pin. `backend/server.py:1043-1058`, `backend/test_server.py:160-169`, `backend/README.md:93-96` | Update the policy and implementation: minimize, expire, or avoid location-derived cache keys. |
| CR-13 | Blocked | Rotate the configured SerpAPI secret and use deployment secret management. | A non-placeholder runtime key exists in ignored local configuration. `.gitignore:1-7`, `.env` | The existing credential must be rotated in the SerpAPI account by its owner. Do not expose the replacement in source control, logs, or this backlog. |
| CR-14 | In progress | Restrict user-controlled API origins. | `?api=`, global configuration, and local storage can set the API host; shared links can direct user data to a hostile API. `UI/config.js:1-8`, `UI/app.js:87-100` | Use deployment configuration or an explicit development-only allowlist for API overrides. |

## P1: Data Providers, Geospatial Processing, And Inference

| ID | Status | Finding | Evidence and locations | Target state |
| --- | --- | --- | --- | --- |
| DP-01 | Not started | Fall back to Overture when Overpass succeeds but returns no usable buildings. | Overture is attempted only on an OSM exception, not an empty OSM result. `backend/server.py:1675-1701` | Retain OSM POIs, but try Overture for an empty OSM-building tile. |
| DP-02 | Not started | Serve a previous OpenBuildingMap catalog during refresh failure. | The catalog lock is held during a remote call; a refresh failure discards use of an otherwise valid in-memory catalog. `backend/server.py:1523-1545` | Use stale-with-hard-limit catalog data and a single-flight refresh outside the critical path. |
| DP-03 | Not started | Prevent overlapping OpenBuildingMap source files from duplicating buildings. | All matching ancestor quadkey files are queried; IDs are filename-prefixed. `backend/server.py:1548-1569` | Select most-specific non-overlapping files and deduplicate using stable source IDs or normalized geometry. |
| DP-04 | Not started | Replace process-random fallback OpenBuildingMap identifiers. | Missing record IDs use Python `hash()`, which changes per process. `backend/server.py:1500-1519` | Use a stable digest of normalized source attributes and geometry. |
| DP-05 | Not started | Assign Overpass multipolygon holes to their containing outer ring. | Inner rings are attached to the first outer ring rather than a containing outer. `backend/server.py:1203-1246` | Use containment in a local projection and report/drop only invalid relations. |
| DP-06 | Not started | Resolve building and building-part overlap. | Parent buildings and parts are both queried and rendered without an overlap strategy. `backend/server.py:1249-1275`, `backend/server.py:1383-1388` | Prefer parts where they cover a parent, retaining uncovered parent geometry only. |
| DP-07 | Not started | Include inner rings in footprint metrics. | Area, perimeter, and centroid calculations use only outer rings. `backend/server.py:1704-1727` | Use robust geometry operations that subtract courtyard holes and produce valid metrics. |
| DP-08 | Not started | Surface source truncation and partial coverage. | OpenBuildingMap and Overture use feature limits with no response-level truncation metadata. `backend/server.py:1554-1569`, `backend/server.py:1597-1602` | Return source limits, truncation, and coverage metadata; use deterministic pagination/partitioning for dense tiles. |
| DP-09 | Not started | Refine the remote Overture circuit breaker. | One remote failure pauses Overture globally for 15 minutes regardless of failure class. `backend/server.py:1578-1635` | Track failure type/count, use bounded backoff with probes, and expose retry state. |
| DP-10 | Not started | Bound and validate upstream JSON responses. | Every provider response is fully read then decoded without size/content-type/schema bounds. `backend/server.py:783-798` | Enforce per-provider body limits and schemas before parsing; emit malformed-response metrics. |
| DP-11 | Not started | Treat corrupt raw-tile cache records as misses. | Decompression/JSON failures can occur before provider fallback is entered. `backend/server.py:325-336`, `backend/server.py:1654-1672` | Quarantine/delete corrupt entries, log safely, and refetch through the normal source chain. |
| DP-12 | Not started | Version raw-tile cache inputs. | Tile keys omit mirror URL, parser/query versions, and other transformation inputs. `backend/server.py:1646-1653` | Include source endpoint, dataset release, query/parser version, and explicit invalidation in cache identity. |
| DP-13 | Not started | Define soft and hard stale-data policy. | Stale source tiles are served after refresh failure without an exposed age or hard maximum. `backend/server.py:1669-1672`, `backend/server.py:2103-2105` | Return `dataAsOf` and stale age; distinguish soft TTL from hard expiry. |
| DP-14 | Not started | Scope local place reuse by country and map context. | Stored-place substring matching can satisfy a later request in a different geography. `backend/server.py:530-543`, `backend/server.py:973-997` | Cache/query by normalized request, country, and spatial context; rank candidates by distance. |
| DP-15 | Not started | Use an efficient place-search index. | Leading-wildcard `LIKE` cannot use the current B-tree name index efficiently. `backend/server.py:202`, `backend/server.py:530-543` | Use SQLite FTS, prefix matching, or bounded ranked search with result limits. |
| DP-16 | Not started | Restrict Serp directions fallback to supported waypoint shapes. | Multi-waypoint routes are accepted, but fallback uses only first and last coordinates. `backend/server.py:1020-1036`, `backend/server.py:1103-1128` | Reject fallback for more than two waypoints or encode all stops using supported provider semantics. |
| DP-17 | Not started | Keep approximate Serp routes out of the normal OSRM cache. | A route called temporary is persisted in `routes` and can hide later OSRM availability. `backend/server.py:1123-1143` | Keep it transient or separately cached with an explicit short TTL and approximate flag. |
| DP-18 | Not started | Replace public OSRM before production. | The default is a public demonstration service with no graph/version policy. `backend/server.py:93-96`, `backend/README.md:116-122` | Configure managed/self-hosted routing, health checks, graph version, quotas, and route expiry. |
| DP-19 | Not started | Make Nominatim and Overpass use compliant/resilient production behavior. | Nominatim uses a configurable but default development agent and hard-coded localhost referer; Overpass cooldown focuses on 429 only. `backend/server.py:76-81`, `backend/server.py:828-838`, `backend/server.py:1359-1404` | Require production identity/contact, remove invalid referer, and add retry/backoff/circuit breaking for timeout and 5xx cases. |
| DP-20 | Not started | Record and display source provenance and licensing. | The footer names broad sources but feature/tile data lacks source version, freshness, and license links. `UI/index.html:47`, `backend/server.py:1938-1948` | Attach provenance/licensing to rendered data and display appropriate attribution for active sources. |

## P1: Search, Map, And Workspace Workflows

| ID | Status | Finding | Evidence and locations | Target state |
| --- | --- | --- | --- | --- |
| UX-01 | Not started | Surface city-search failures and ambiguity. | Exact city lookup swallows every error and resolves the first Nominatim result. `UI/app.js:475-487`, `backend/server.py:841-852` | Show not-found/network/rate-limit feedback and retain credible alternatives for ambiguous input. |
| UX-02 | Not started | Prevent stale autocomplete rendering. | Suggestion responses are not tied to the initiating query and loading state references mutable controller state. `UI/app.js:429-447` | Use request IDs/query snapshots and render only the current response. |
| UX-03 | Not started | Turn city suggestions into a real accessible combobox. | Input/list lack combobox roles, active descendant, option IDs, and keyboard selection. `UI/index.html:20-24`, `UI/app.js:450-466` | Implement ARIA combobox interactions with arrows, Enter, Escape, and screen-reader announcements. |
| UX-04 | Not started | Start large-city exploration with an appropriate overview. | Location bounds exist but selection always flies to z15.5 at a single point. `backend/server.py:801-825`, `UI/app.js:500-510` | Fit the city bbox, identify downloaded detailed coverage, and offer an explicit 3D-center transition. |
| UX-05 | Not started | Explain that loaded detail is tile coverage, not whole-city coverage. | The stream state implies a city is ready after requested tiles complete. `UI/app.js:500-560` | Show detailed viewport coverage and available/failed tile areas. |
| UX-06 | Not started | Separate stored-place inspection from pin persistence. | Clicking a stored place immediately creates a durable pin. `UI/app.js:677-686`, `UI/app.js:834-845` | Show a place card with explicit Pin, Route From, Route To, and View actions. |
| UX-07 | Not started | Replace all-pins-in-creation-order area construction with an editable workflow. | Area generation uses every pin in insertion order and has no subset/reorder/preview/edit path. `UI/app.js:912-933` | Let users select/reorder pins, preview and edit geometry, name areas, and prevent duplicates. |
| UX-08 | Not started | Give routes a persistent, legible result state. | Route details exist only in a transient status message; approximate fallback uses road-like styling. `UI/app.js:951-980` | Add a route panel with endpoints, source, cache status, summary, clear action, and distinct approximate styling. |
| UX-09 | Not started | Restore expected map-control behavior. | Double click resets city rather than zooming; the 3D control has no state; no north reset exists. `UI/app.js:364-368`, `UI/app.js:1025-1031` | Preserve double-click zoom, add Recenter/North controls, and expose pitch state with `aria-pressed`. |
| UX-10 | Not started | Add POI legend and filtering. | POI markers use category colors/codes but users cannot see categories, counts, or filters. `UI/app.js:244-256` | Add collapsible legend/filter, category counts, source coverage, and collision-aware labels. |
| UX-11 | Not started | Show stored-place overlay truncation and lookup provenance. | API returns truncation but UI discards it; results compress provider state into `OSM` or `SERP`. `backend/server.py:2078-2079`, `UI/app.js:668-671`, `UI/app.js:814-829` | Show stored-place limits, cached/live state, provider, and fallback reason. |
| UX-12 | Not started | Use or remove the inert `region` tile parameter. | The worker transmits region ID, but the tile handler ignores it. `UI/tile-worker.js:42`, `backend/server.py:2091-2105` | Use region for coverage/cache context or remove it from documentation and requests. |
| UX-13 | Not started | Bound client tile memory and repeated GeoJSON work. | Every tile update rebuilds all feature data; tiles are not evicted while panning. `UI/app.js:288-291`, `UI/app.js:529-538` | Evict distant tiles, batch updates, cap retained features, and measure render/memory cost. |
| UX-14 | Not started | Improve tile failure recovery. | A retry sleep blocks the worker's serial queue and the UI has no failed-tile retry control. `UI/tile-worker.js:36-80` | Keep provider politeness but allow independent cached work; show failed coverage and controlled retry action. |
| UX-15 | Not started | Debounce stored-place viewport loading. | Every map move end triggers a bounds request. `UI/app.js:359-363`, `UI/app.js:655-675` | Debounce and require meaningful bounds/zoom change while retaining previous valid markers during refresh. |
| UX-16 | Not started | Handle MapLibre, style, WebGL, and resize failure states. | Map resize happens once and no map/CDN/WebGL error UI exists. `UI/index.html:9-12`, `UI/app.js:329-372` | Add resize observation, orientation handling, and an in-product degraded mode that preserves non-map controls. |

## P1: Accessibility And Responsive Interface

| ID | Status | Finding | Evidence and locations | Target state |
| --- | --- | --- | --- | --- |
| AX-01 | Not started | Make the geography workspace usable on short mobile screens. | The app shell cannot scroll while the expanded panel and map compete for viewport height. `UI/styles.css:29-36`, `UI/styles.css:239-306` | Use a collapsible drawer/bottom sheet with safe maximum height and independently scrollable content. |
| AX-02 | Not started | Increase touch target sizes. | Several geography and pin controls are 22-30px high. `UI/styles.css:271-285`, `UI/styles.css:393-397` | Use practical 40-44px target sizes for essential and destructive actions. |
| AX-03 | Not started | Restore visible keyboard focus. | Outlines are removed on map canvas and inputs; many controls lack focus-visible styles. `UI/styles.css:89-90`, `UI/styles.css:121-128`, `UI/styles.css:466-486` | Apply high-contrast consistent focus indicators to every interactive element. |
| AX-04 | Not started | Provide a keyboard/non-pointer feature-inspection path. | Building and POI details require pointer layer interaction. `UI/app.js:348-358`, `UI/app.js:577-639` | Add a keyboard-accessible selected-feature inspector or nearby-feature list. |
| AX-05 | Not started | Respect reduced motion in map transitions. | MapLibre transitions use `essential: true`, which can bypass user reduced-motion preference. `UI/app.js:508`, `UI/app.js:841`, `UI/app.js:904`, `UI/app.js:976` | Gate animation duration with `prefers-reduced-motion` and avoid forced map motion. |
| AX-06 | Not started | Reduce live-region announcement noise. | Tile progress updates a live stream card repeatedly. `UI/index.html:39-42`, `UI/app.js:549-560` | Announce state transitions and failures, not every count/progress update. |
| AX-07 | Not started | Improve operational text legibility. | Essential labels use 7-10px type and dense all-caps styling. `UI/styles.css:282-285`, `UI/styles.css:335-357`, `UI/styles.css:495-503` | Raise minimum font sizes, simplify typography, and preserve hierarchy. |
| AX-08 | Not started | Expose theme choice and system preference. | Theme exists in local storage but has no UI control and defaults to dark. `UI/app.js:284`, `UI/app.js:375-380`, `UI/README.md:16-18` | Add light/dark/system control and initialize from `prefers-color-scheme`. |
| AX-09 | Not started | Keep source attribution accessible on mobile. | Custom attribution is hidden below the mobile breakpoint. `UI/styles.css:717-720` | Provide concise expandable attribution/source status on all screen sizes. |
| AX-10 | Not started | Make keyboard shortcuts discoverable and cancelable. | `/`, `R`, `3`, `+`, and `-` are hidden features; there is no Escape cancellation path. `UI/app.js:998-1031` | Add shortcut help and context-safe `Esc` behavior for modes and popups. |

## P1: Operations, Storage, And Deployment

| ID | Status | Finding | Evidence and locations | Target state |
| --- | --- | --- | --- | --- |
| OP-01 | Not started | Establish automated tests and CI. | No test suite, runner configuration, or CI workflow exists. Repository root, `backend/server.py`, `UI/` | Add unit, integration, fixture, browser, and regression tests; run them in CI before merges. |
| OP-02 | Not started | Add structured privacy-safe observability. | Provider errors and handler messages use `print`; static health data lacks runtime signals. `backend/server.py:1686-1701`, `backend/server.py:1970-2025` | Emit request IDs, latency, queues, cache state, provider status, truncation, source mix, and SerpAPI usage with redaction. |
| OP-03 | Not started | Split liveness from readiness. | `/api/health` reports configuration but not actual dependencies. `backend/server.py:2031-2033` | Add non-sensitive liveness/readiness/dependency status endpoints. |
| OP-04 | Not started | Define retention and deletion. | Cache expiry is query-only; stored places/routes/provider responses/archive files have no retention lifecycle. `backend/server.py:155-177`, `backend/server.py:349-399` | Add source-specific TTLs, pruning, size budgets, workspace deletion, and documented retention. |
| OP-05 | Not started | Add SQLite maintenance, backup, and restore operations. | WAL is enabled but no checkpoint, integrity-check, backup, or restore process exists. `backend/server.py:140-149` | Add encrypted backups, restore tests, checkpoint policy, corruption handling, and capacity monitoring. |
| OP-06 | Not started | Fix pin-label and route-creation race conditions. | Pin labels use row count despite uniqueness; route lookup and insert are separate operations. `backend/server.py:212-216`, `backend/server.py:566-576`, `backend/server.py:601-623` | Use monotonic/first-free labels and atomic route upsert or single-flight creation. |
| OP-07 | Not started | Validate configuration at startup. | Environment parsing occurs during import; profile appears configurable but only `driving` is accepted. `backend/server.py:71-96`, `backend/server.py:1074-1076` | Validate values/ranges with actionable errors; remove unsupported configuration or implement it. |
| OP-08 | Not started | Make runtime deployment reproducible across supported platforms. | The bundled DuckDB binary is Windows-specific and extensions are externally assumed. `backend/server.py:87`, `backend/server.py:1587-1619` | Define supported targets, pin binary/extension versions and checksums, and provide service/container deployment guidance. |
| OP-09 | Not started | Plan explicitly for multi-instance deployment. | SQLite, queues, cooldowns, and caches are process-local. `backend/server.py:109-138`, `backend/server.py:140-149` | Enforce a documented single-node model or move shared state/rate controls to shared infrastructure. |
| OP-10 | Not started | Harden CORS and browser response policy. | A disallowed origin receives the first allowed origin instead of explicit denial; security headers are absent. `backend/server.py:1973-1994` | Reject/omit invalid CORS responses and configure CSP, content-type protection, referrer policy, and HSTS at the appropriate layer. |
| OP-11 | Not started | Pin or self-host critical frontend assets. | MapLibre comes from UNPKG and the base style from OpenFreeMap without a production delivery/fallback policy. `UI/index.html:9-12`, `UI/app.js:329-330` | Pin approved artifacts, self-host where appropriate, and define offline/degraded behavior. |
| OP-12 | Not started | Add dependency-aware data source and cost controls. | Source selection uses local config with no operator visibility or spend/availability dashboard. `backend/server.py:71-99`, `backend/server.py:1646-1701` | Add source availability, quota, cost, and operator controls without exposing sensitive configuration. |

## P2: Product Expansion

| ID | Status | Expansion | Evidence and locations | Target state |
| --- | --- | --- | --- | --- |
| EX-01 | Deferred | Add map layer and data-workbench controls. | Current layers are fixed in `UI/app.js:224-279`. | Toggle authoritative/inferred/preview buildings, places, POIs, pins, areas, routes, and expose per-layer provenance. |
| EX-02 | Deferred | Add a persistent feature inspector. | Popups are ephemeral. `UI/app.js:577-639` | Keep selected feature details, provenance, coordinates, confidence, and copy actions in a panel. |
| EX-03 | Deferred | Add editable measurement and geometry tools. | Current areas derive from pins only. `UI/app.js:912-933` | Support named/editable areas, draw/vertex tools, distance measurement, and GeoJSON interchange. |
| EX-04 | Deferred | Add multi-stop and multimodal route planning. | API validates 2-12 waypoints, UI exposes two driving pins. `backend/server.py:1020-1036`, `UI/index.html:30` | Add stops, ordering, alternatives, walking/cycling/transit when supported by a reliable provider. |
| EX-05 | Deferred | Add place-search typeahead and refinement. | Place search is submit-only. `UI/app.js:781-832` | Add suggestions, categories, viewport search, distance ranking, filtering, and pagination. |
| EX-06 | Deferred | Add saved cities, named workspaces, and explicit sharing. | Sharing covers only city/country; workspace is local/global backend state. `UI/README.md:32-60` | Add named workspaces, opt-in state sharing, and local backup/export. |
| EX-07 | Deferred | Add temporal and comparative data views. | Current cache/source version data is not exposed to users. `backend/server.py:1646-1672` | Support source-version comparisons, refresh diffs, change indicators, and height distributions after provenance work is complete. |
| EX-08 | Deferred | Add offline and low-bandwidth mode. | Map/style dependencies are remote. `UI/README.md:50-51` | Self-host assets, add reduced-detail rendering, and permit bounded city prefetching. |
| EX-09 | Deferred | Add configurable source strategy per region. | Source priority is fixed by backend configuration. `backend/server.py:1675-1701` | Let operators set source preference, regional rules, data-quality thresholds, and paid-fallback limits. |
| EX-10 | Deferred | Add an operator dashboard. | Runtime state is not surfaced beyond basic health. `backend/server.py:2031-2033` | Show provider health, cache/storage, queue/backoff, coverage, source mix, and cost indicators. |

## Required Test Coverage Before Broad Refactoring

| Area | Minimum regression cases | Primary locations |
| --- | --- | --- |
| OpenBuildingMap | WKT, GeoPackage/WKB, malformed geometry, missing IDs, overlapping catalog files, stale catalog fallback | `backend/server.py:1459-1569` |
| Source selection | Mirror success, mirror empty, OSM success/empty/failure, Overture success/failure, stale cache recovery | `backend/server.py:1646-1701` |
| Geometry | Multipolygon holes, building-part overlap, invalid polygons, courtyard metrics | `backend/server.py:1203-1321`, `backend/server.py:1704-1727` |
| Height metadata | Measured, level-derived, OSM reference, HBET, inferred, `minHeight` constraints, confidence labels | `backend/server.py:1745-1924` |
| Place lookup | Country/context isolation, local lookup ranking, canonicalization, fallback invocation | `backend/server.py:412-543`, `backend/server.py:934-997` |
| Routes | OSRM success, no route, temporary Serp fallback, multi-waypoint fallback rejection, concurrent creation | `backend/server.py:1020-1144` |
| Workspace | Pin deletion/label reuse, area invalidation, topology validation, clear semantics | `backend/server.py:561-650`, `UI/app.js:713-995` |
| Browser UX | Combobox keyboard flow, pin-mode feature clicks, reduced motion, mobile panel scrolling, failed-tile retry, source aggregation | `UI/app.js`, `UI/tile-worker.js`, `UI/styles.css` |

## Change Management Rules

| Rule | Reason |
| --- | --- |
| Preserve provider response fixtures in redacted form. | Provider behavior and geometry formats require reproducible regression coverage. |
| Update this backlog when an item changes status. | Keeps implementation order and operational risk visible. |
| Do not claim an inferred height is measured. | Height provenance is a user-facing data-quality contract. |
| Do not expose a workspace remotely before CR-09 and CR-10 are complete. | The current model has no user isolation or abuse protection. |
| Do not enable paid/provider fallbacks without quotas and observability. | SerpAPI and routing calls have external cost and availability implications. |
| Keep privacy-impacting location features opt-in and documented. | IP/browser location and durable geographic workspace data are sensitive. |
