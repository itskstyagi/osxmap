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

## Separate API Host

The default API is `http://127.0.0.1:8787`. Point the UI at another backend
host with the `api` query parameter:

```text
https://ui.example.com/?api=https://api.example.com
```

Hosting systems can instead define `window.MONUMENT_API_URL` before `app.js`
loads. The Python backend must permit the UI origin through `ALLOWED_ORIGINS`.

## Shared City Links

Load and explore a city directly with URL parameters:

```text
https://ui.example.com/?city=Noida&country=India
```

`country` is optional and is included in the city lookup when present. The
misspelled `counrty` parameter is accepted for links created with that spelling.

## Initial Location

Unless a shared-city URL is provided, the browser requests its public IP from
`api.ipify.org` and resolves the city through `ip-api.services.brahmai.in`.
The detected city is loaded directly from its returned coordinates. If either
request fails, the browser's existing country detection remains the fallback.

The UI loads MapLibre GL and the OpenFreeMap base style from their public CDN
and hosts; self-host those resources for production or offline deployments.
