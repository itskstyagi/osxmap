# Monument Browser UI

This folder is a static HTML, CSS, and browser-JavaScript application. It has
no build step and no Node dependency.

## Run

Serve this folder from any static web host. For local development:

```powershell
python -m http.server 8080 --directory UI
```

Open `http://127.0.0.1:8080`.

The interface defaults to dark mode. The toolbar theme toggle switches the
controls between light and dark and stores the preference locally. Satellite
and street cartography keep their dark appearance; terrain follows the theme.

## Local API Host

The default API is `http://127.0.0.1:8787`. Monument accepts only loopback API
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

## Map Agent And Manual Controls

The map assistant sits at the bottom of the control rail. It can find places,
construct routes, and ask a concise follow-up question. Progress, completion,
errors, and clarification choices stay beside the prompt even when manual
controls are collapsed. Detailed tool activity remains in the information
drawer. Results use backend tool responses, not invented map geometry.

City search, route planning, pins, areas, and location controls remain available
inside `Map controls`. Explore focuses search; Routes opens the planner and
street map; Workspace opens saved-pin and area tools without closing the rail
on mobile. Search suggestions support arrows, Enter, and Escape, with inline
no-result and failure feedback.

## Location And Geography Tools

At startup, the application requests the browser's public IP from
`api.ipify.org` and resolves its approximate location through
`ip-api.services.brahmai.in`. The resulting Geo-IP location becomes the map
anchor and starts the normal nearby building-data stream; it does not create a
route stop or persist the coordinate. A shared city URL takes precedence. If
the Geo-IP lookup fails, the map remains available with a locale-derived
country bias until a location is selected. `ADD MY LOCATION` still asks for
browser permission and assigns that coordinate to the active route stop.
`ADD APPROX. LOCATION` uses the same Geo-IP lookup and also assigns it to the
active route stop. Both Geo-IP providers receive the request information needed
to perform that lookup.

The UI loads MapLibre GL, the OpenFreeMap base style, and public Terrarium
elevation tiles. Selecting a city opens its 3D terrain view; the `3D` control
switches terrain and camera pitch together. Self-host these resources for
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
persisted workspace state and reset the visible map; reusable provider caches
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
