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

The application starts without collecting a location. `USE MY LOCATION` asks
for browser permission. `USE APPROX. LOCATION` explicitly requests a public IP
from `api.ipify.org` and resolves it through `ip-api.services.brahmai.in`.
Both providers receive the request information needed to perform that lookup.
The browser locale supplies only an initial country bias until a user chooses a
location, city, or place.

The UI loads MapLibre GL and the OpenFreeMap base style from their public CDN
and hosts; self-host those resources for production or offline deployments.

The geography panel keeps city search separate from place lookup. It supports
OSM-first place search, explicit browser-location use, map-click pins,
geodesic pin-area measurement, and driving-route highlights. Pins, areas, and
OSM routes are stored by the local backend for this single-machine workspace.
Canonical places previously found through OSM or SerpApi are loaded as a
separate, clickable map overlay for the current viewport.
`Clear additions` removes the visible workspace objects while retaining
provider place records and reusable OSM route records.
