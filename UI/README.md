# Monument Browser UI

This folder is a static HTML, CSS, and browser-JavaScript application. It has
no build step and no Node dependency.

## Run

Serve this folder from any static web host. For local development:

```powershell
python -m http.server 8080 --directory UI
```

Open `http://127.0.0.1:8080`.

The interface defaults to dark mode. Set `localStorage.theme` to `light` or
`dark` before loading the page to store a theme preference; the UI intentionally
does not expose a theme toggle.

## Local API Host

The default API is `http://127.0.0.1:8787`. Monument accepts only loopback API
origins. A local hosting page can set an alternate local port before `app.js`:

```text
window.MONUMENT_API_URL = 'http://127.0.0.1:8787';
```

Shared URLs and local storage cannot change the API origin. The Python backend
must remain bound to a loopback host.

## Shared City Links

Load and explore a city directly with URL parameters:

```text
https://ui.example.com/?city=Noida&country=India
```

`country` is optional and is included in the city lookup when present. The
misspelled `counrty` parameter is accepted for links created with that spelling.

## Location And Geography Tools

The application starts without collecting a location. `ADD MY LOCATION` asks
for browser permission and assigns that coordinate to the active route stop.
`ADD APPROX. LOCATION` explicitly requests a public IP from `api.ipify.org`
and resolves it through `ip-api.services.brahmai.in`, then assigns the
resulting approximate coordinate to the active stop. Both providers receive
the request information needed to perform that lookup. The browser locale
supplies only an initial country bias until a user chooses a location, city,
or place.

The UI loads MapLibre GL and the OpenFreeMap base style from their public CDN
and hosts; self-host those resources for production or offline deployments.

The route planner keeps the main task focused: type a start, stop, or
destination directly into its row, then arrange the ordered stops from A
through the destination. As the user types, the row offers only matching
places stored from earlier searches; it does not call an external provider.
Pressing Enter intentionally searches Serp and marks every coordinate-bearing
result from that response on the map. Selecting a result marker or suggestion
assigns it to the active stop. Plans support up to 50 stops, including repeated
stops, and can be reordered or edited before tracing. Map pins and explicit
location results can also fill the active stop. Area measurement and saved-pin
maintenance live under `More map tools` so they do not compete with routing.

The visible map workspace is intentionally session-only. On every page load,
the UI clears its previous pins, areas, route, and search-result markers before
showing a new blank map. Canonical place records remain in the local backend
solely to power the route-input suggestions and provider cache; they are not
drawn as persistent map markers.

The backend fetches a bounded, cached OSM drivable-road graph and runs
Dijkstra's distance-shortest-path search for each leg in order. Every road
segment examined before a leg destination is settled is replayed on the map,
then cleared before the full final path is drawn. One-way and basic
vehicle-access tags are respected; this is not a full turn-cost or
traffic-aware navigation model. OSRM is used only when the local OSM graph
cannot be loaded or cannot form a route. `Clear workspace` removes all
current-session pins, areas, route stops, routes, and result markers while
retaining provider place records and reusable route records.
