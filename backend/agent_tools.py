"""Validated map-domain tools exposed to the OpenAI-compatible map agent."""

from __future__ import annotations

import copy
import json
import math
from dataclasses import dataclass, field
from typing import Any, Callable, cast

try:
    from .errors import ServiceError
except ImportError:  # Supports `python server.py` from the backend directory.
    from errors import ServiceError


def _string(value: Any, label: str, minimum: int = 1, maximum: int = 160) -> str:
    text = str(value or "").strip()
    if not minimum <= len(text) <= maximum:
        raise ServiceError(f"{label} must be between {minimum} and {maximum} characters.", 400)
    return text


def _coordinates(value: Any, label: str) -> tuple[float, float]:
    if not isinstance(value, (list, tuple)) or len(value) < 2 or any(isinstance(item, bool) for item in value[:2]):
        raise ServiceError(f"{label} needs valid coordinates.", 400)
    try:
        lon, lat = float(value[0]), float(value[1])
    except (TypeError, ValueError, OverflowError):
        raise ServiceError(f"{label} needs valid coordinates.", 400) from None
    if not math.isfinite(lon) or not math.isfinite(lat) or not -180 <= lon <= 180 or not -90 <= lat <= 90:
        raise ServiceError(f"{label} needs valid coordinates.", 400)
    return lon, lat


def _bounds(value: Any) -> list[float] | None:
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        return None
    try:
        west, south = _coordinates(value[:2], "Bounds")
        east, north = _coordinates(value[2:], "Bounds")
    except ServiceError:
        return None
    return [west, south, east, north] if south <= north else None


def _text(value: Any, maximum: int = 160) -> str:
    return value[:maximum] if isinstance(value, str) else ""


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        return float(value) if math.isfinite(value) else None
    except OverflowError:
        return None


STUDIO_ACTIONS = ("visualize", "filter", "summarize", "hotspots", "compare", "duplicate")
STUDIO_VISUALIZATIONS = ("points", "density", "heatmap", "choropleth", "contours", "extrusion", "flow", "surface", "tactical")
STUDIO_PALETTES = ("monochrome", "olive", "thermal", "ocean", "violet")
MAX_CONTEXT_BYTES = 24_000


@dataclass(frozen=True)
class AgentDependencies:
    suggest_cities: Callable[[str, str], list[dict[str, Any]]]
    resolve_city: Callable[[str, str], dict[str, Any] | None]
    search_places: Callable[[str, str, float | None, float | None], dict[str, Any]]
    plan_route: Callable[[list[list[float]], str], dict[str, Any]]
    workspace_snapshot: Callable[[], dict[str, Any]]
    clear_workspace: Callable[[], None]
    add_pin: Callable[[str, float, float, str | None, str], dict[str, Any]]
    save_workspace_state: Callable[[dict[str, Any]], dict[str, Any]]
    capture_workspace: Callable[[], dict[str, Any]]
    mutate_workspace: Callable[[dict[str, Any], Callable[[], Any]], tuple[Any, dict[str, Any]]]
    restore_workspace: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]]


@dataclass
class AgentRunContext:
    map_context: dict[str, Any]
    entities: dict[str, dict[str, Any]] = field(default_factory=dict)
    routes: dict[str, dict[str, Any]] = field(default_factory=dict)
    next_ref: int = 1
    requires_presentation: bool = False
    presented: bool = False


AGENT_TOOL_SCHEMAS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "find_city",
            "description": "Find an exact city or return plausible city choices before changing the map.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "City and optional country."},
                    "countryCode": {"type": "string", "description": "Optional ISO country code."},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_places",
            "description": "Find businesses, landmarks, attractions, food, coffee, or other places. The backend enforces local and OpenStreetMap discovery before any SerpApi fallback.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string"},
                    "nearRef": {"type": "string", "description": "A city or place reference returned by another tool."},
                    "countryCode": {"type": "string"},
                },
                "required": ["query"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "plan_route",
            "description": "Plan a driving route through ordered known place or city references.",
            "parameters": {
                "type": "object",
                "properties": {
                    "waypointRefs": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 50},
                    "profile": {"type": "string", "enum": ["driving"]},
                },
                "required": ["waypointRefs"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "present_map",
            "description": "Draw validated tool results on the map, optionally saving explicitly selected places as workspace pins.",
            "parameters": {
                "type": "object",
                "properties": {
                    "cityRef": {"type": "string"},
                    "placeRefs": {"type": "array", "items": {"type": "string"}, "maxItems": 20},
                    "routeRef": {"type": "string"},
                    "persistPlaceRefs": {"type": "array", "items": {"type": "string"}, "maxItems": 12},
                },
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "studio_operation",
            "description": "Queue a scoped browser operation on an EXISTING loaded Studio layer. The browser validates geometry and computes results from actual data; this tool does not compute statistics or load geographic datasets.",
            "parameters": {
                "type": "object",
                "properties": {
                    "action": {"type": "string", "enum": list(STUDIO_ACTIONS)},
                    "layerId": {"type": "string"},
                    "visualization": {"type": "string", "enum": list(STUDIO_VISUALIZATIONS)},
                    "field": {"type": "string", "description": "An exact numericFields name from the loaded layer, not an invented population/risk/elevation field."},
                    "palette": {"type": "string", "enum": list(STUDIO_PALETTES)},
                    "min": {"type": "number"},
                    "max": {"type": "number"},
                    "categoryField": {"type": "string", "description": "An exact categoricalFields name from the loaded layer."},
                    "category": {"type": ["string", "number", "boolean"], "description": "Exact JSON scalar category. Preserve boolean and numeric types rather than converting them to text."},
                },
                "required": ["action", "layerId"],
                "additionalProperties": False,
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "clear_map",
            "description": "Clear the persisted workspace and all visible agent map state. Use only for an unambiguous clear request.",
            "parameters": {"type": "object", "properties": {}, "additionalProperties": False},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "ask_user",
            "description": "Ask one concise question when a required city, preference, or route decision is unknown.",
            "parameters": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "choices": {"type": "array", "items": {"type": "string"}, "minItems": 2, "maxItems": 4},
                },
                "required": ["question", "choices"],
                "additionalProperties": False,
            },
        },
    },
]


class AgentTools:
    """Executes a fixed tool allowlist and returns client-safe, bounded values."""

    def __init__(self, dependencies: AgentDependencies) -> None:
        self.dependencies = dependencies

    def new_context(self, map_context: dict[str, Any] | None) -> AgentRunContext:
        context = AgentRunContext(map_context=self._map_context(map_context))
        selected = context.map_context.get("selectedCity")
        if isinstance(selected, dict) and self._location(selected):
            context.map_context["selectedCity"] = self._output_entity(self._register_entity(context, selected, "city"))
        return context

    def execute(self, context: AgentRunContext, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        handlers = {
            "find_city": self._find_city,
            "search_places": self._search_places,
            "plan_route": self._plan_route,
            "present_map": self._present_map,
            "studio_operation": self._studio_operation,
            "clear_map": self._clear_map,
            "ask_user": self._ask_user,
        }
        handler = handlers.get(name)
        if not handler:
            raise ServiceError("The requested map-agent tool is not available.", 400)
        schema = next(tool["function"]["parameters"] for tool in AGENT_TOOL_SCHEMAS if tool["function"]["name"] == name)
        if not isinstance(arguments, dict) or set(arguments) - set(schema["properties"]) or any(key not in arguments for key in schema.get("required", [])):
            raise ServiceError("The map-agent tool received unsupported or missing parameters.", 400)
        return handler(context, arguments)

    @staticmethod
    def stage_label(name: str) -> str:
        return {
            "find_city": "Finding the right city",
            "search_places": "Searching local, OSM, and place data",
            "plan_route": "Planning a road route",
            "present_map": "Drawing the map",
            "studio_operation": "Queuing a scoped Studio operation",
            "clear_map": "Clearing the map",
            "ask_user": "Preparing a question",
        }.get(name, "Updating the map")

    def _find_city(self, context: AgentRunContext, arguments: dict[str, Any]) -> dict[str, Any]:
        bounds = self._geographic_bounds(context)
        query = _string(arguments.get("query"), "City query", 2)
        country = str(arguments.get("countryCode") or "")[:2].upper()
        exact = self.dependencies.resolve_city(query, country)
        candidates = [exact] if exact else self.dependencies.suggest_cities(query, country)
        locations = [self._output_entity(self._register_entity(context, item, "city")) for item in candidates[:6] if self._location(item) and self._inside(item, bounds)]
        if not locations:
            return {"locations": [], "message": "No matching city was found inside the requested scope." if bounds else "No matching city was found."}
        context.requires_presentation = True
        return {"locations": locations}

    def _search_places(self, context: AgentRunContext, arguments: dict[str, Any]) -> dict[str, Any]:
        bounds = self._geographic_bounds(context)
        query = _string(arguments.get("query"), "Place query", 2)
        nearby = self._entity(context, arguments.get("nearRef"), required=False)
        if nearby:
            if not self._inside(nearby, bounds):
                raise ServiceError("The search reference is outside the requested scope.", 400)
            lon, lat = self._coordinates_from_entity(nearby)
            country = str(nearby.get("countryCode") or arguments.get("countryCode") or "")[:2].upper()
        else:
            center = context.map_context.get("center")
            if bounds:
                west, south, east, north = bounds
                longitude = (west + east) / 2 if west <= east else (west + (east + 360 - west) / 2 + 180) % 360 - 180
                center = [longitude, (south + north) / 2]
            lon, lat = _coordinates(center, "Map center") if center else (None, None)
            country = str(arguments.get("countryCode") or context.map_context.get("countryCode") or "")[:2].upper()
        discovery = self.dependencies.search_places(query, country, lat, lon)
        results = discovery.get("results") if isinstance(discovery, dict) else None
        if not isinstance(results, list):
            raise ServiceError("The place-discovery service returned an invalid response.", 503)
        matches = [item for item in results[:100] if self._location(item) and self._inside(item, bounds)][:20]
        places = [self._output_entity(self._register_entity(context, item, "place")) for item in matches]
        if places:
            context.requires_presentation = True
        return {
            "places": places,
            "source": str(discovery.get("source") or "unknown"),
            "lookupStage": str(discovery.get("lookupStage") or "unknown"),
            "stored": bool(discovery.get("stored")),
            "fallbackReason": str(discovery.get("fallbackReason") or ""),
            "serpEligible": bool(discovery.get("serpEligible")),
            "scopeCaveat": "Only provider-returned points inside the scope are included; this is not exhaustive coverage." if bounds else "Provider search results are not an exhaustive dataset.",
        }

    def _plan_route(self, context: AgentRunContext, arguments: dict[str, Any]) -> dict[str, Any]:
        bounds = self._geographic_bounds(context)
        references = arguments.get("waypointRefs")
        if not isinstance(references, list) or not 2 <= len(references) <= 50:
            raise ServiceError("A route needs between two and fifty known waypoints.", 400)
        waypoints = []
        stops = []
        for reference in references:
            entity = self._entity(context, reference)
            assert entity is not None
            if not self._inside(entity, bounds):
                raise ServiceError("A route waypoint is outside the requested scope.", 400)
            lon, lat = self._coordinates_from_entity(entity)
            waypoints.append([lon, lat])
            stops.append(self._output_entity(entity))
        if arguments.get("profile", "driving") != "driving":
            raise ServiceError("Only driving routes are supported.", 400)
        route = self.dependencies.plan_route(waypoints, "driving")
        geometry = route.get("geometry") if isinstance(route, dict) else None
        coordinates = geometry.get("coordinates") if isinstance(geometry, dict) and geometry.get("type") == "LineString" else None
        if not isinstance(coordinates, list) or not 2 <= len(coordinates) <= 100_000:
            raise ServiceError("The route provider returned invalid geometry.", 503)
        previous_lon = None
        for point in coordinates:
            try:
                lon, lat = _coordinates(point, "Route")
            except ServiceError:
                raise ServiceError("The route provider returned invalid geometry.", 503) from None
            if not self._inside({"lon": lon, "lat": lat}, bounds):
                raise ServiceError("The planned route leaves the requested scope; bounded routing is not available for this route.", 400)
            if bounds:
                # In the scope's longitude frame, a wrapping segment must not cross its excluded arc.
                scoped_lon = (lon - bounds[0]) % 360
                if previous_lon is not None and abs(scoped_lon - previous_lon) > 180 and bounds[2] - bounds[0] < 360:
                    raise ServiceError("The route crosses outside the requested longitude bounds; bounded routing is not available for this route.", 400)
                previous_lon = scoped_lon
        route_ref = f"route:{route.get('id') or len(context.routes) + 1}"
        context.routes[route_ref] = {"route": route, "stops": stops}
        context.requires_presentation = True
        summary_value = route.get("summary")
        summary = cast(dict[str, Any], summary_value) if isinstance(summary_value, dict) else {}
        return {
            "routeRef": route_ref,
            "distanceMeters": summary.get("distanceMeters"),
            "durationSeconds": summary.get("durationSeconds"),
            "approximate": bool(summary.get("approximateGeometry")),
        }

    def _present_map(self, context: AgentRunContext, arguments: dict[str, Any]) -> dict[str, Any]:
        bounds = self._geographic_bounds(context)
        city = self._entity(context, arguments.get("cityRef"), required=False)
        places = self._entities(context, arguments.get("placeRefs"), 20)
        if any(not self._inside(entity, bounds) for entity in ([city] if city else []) + places):
            raise ServiceError("The map results are outside the requested scope.", 400)
        route_reference = str(arguments.get("routeRef") or "")
        route_entry = context.routes.get(route_reference)
        if route_reference and not route_entry:
            raise ServiceError("The map agent referenced a route that was not planned in this request.", 400)
        persistent = arguments.get("persistPlaceRefs", [])
        if not isinstance(persistent, list) or len(persistent) > 12:
            raise ServiceError("At most twelve selected places can be saved at once.", 400)
        persistent_refs = {str(value) for value in persistent}
        known_place_refs = {entity["ref"] for entity in places}
        if not persistent_refs.issubset(known_place_refs):
            raise ServiceError("The map agent tried to save a place that was not selected for the map.", 400)
        for entity in places:
            if entity["ref"] not in persistent_refs:
                continue
            self.dependencies.add_pin(entity["name"], entity["lat"], entity["lon"], str(entity.get("id") or "") or None, "place")
        selected_city = self._output_entity(city) if city else None
        snapshot = self.dependencies.workspace_snapshot()
        stored_state = snapshot.get("state") if isinstance(snapshot, dict) else {}
        state = dict(stored_state) if isinstance(stored_state, dict) else {}
        route = route_entry["route"] if route_entry else None
        state["context"] = {"selectedCity": selected_city} if selected_city else state.get("context", {})
        if route:
            state["routeId"] = route.get("id")
        elif "routeId" in state:
            state.pop("routeId", None)
        self.dependencies.save_workspace_state(state)
        context.presented = True
        context.requires_presentation = False
        workspace = self.dependencies.workspace_snapshot()
        update = {
            "selectedCity": selected_city,
            "places": [self._output_entity(place) for place in places],
            "routeStops": route_entry["stops"] if route_entry else [],
            "route": route,
            "workspace": workspace,
            "view": self._view_for(city, places, route),
            "clear": False,
        }
        return {"presented": True, "mapUpdate": update}

    def _studio_operation(self, context: AgentRunContext, arguments: dict[str, Any]) -> dict[str, Any]:
        studio = context.map_context.get("studio", {})
        scope = context.map_context.get("scope")
        if not scope:
            raise ServiceError("A Studio operation requires an explicit viewport, selection, layer, or workspace scope.", 400)
        if not studio.get("workspaceId"):
            raise ServiceError("Open a browser Studio workspace before requesting a dataset operation.", 400)
        layer_id = arguments.get("layerId")
        layer = next((item for item in studio.get("layers", []) if item["id"] == layer_id), None)
        if not layer:
            raise ServiceError("The requested dataset is not loaded in this Studio workspace. Load it before requesting an operation.", 400)
        if scope.get("layerId") and scope["layerId"] != layer_id:
            raise ServiceError("The requested layer is outside the selected scope.", 400)
        if arguments.get("action") not in STUDIO_ACTIONS:
            raise ServiceError("Unsupported Studio action.", 400)
        operation = {"action": arguments["action"], "layerId": layer_id, "scope": copy.deepcopy(scope), "workspaceId": studio["workspaceId"]}
        for key, allowed in (("visualization", STUDIO_VISUALIZATIONS), ("palette", STUDIO_PALETTES)):
            if key in arguments:
                if arguments[key] not in allowed:
                    raise ServiceError(f"Unsupported Studio {key}.", 400)
                operation[key] = arguments[key]
        for key, fields in (("field", "numericFields"), ("categoryField", "categoricalFields")):
            if key in arguments:
                if not isinstance(arguments[key], str) or arguments[key] not in layer[fields]:
                    raise ServiceError(f"Studio {key} must name a known {fields} field in the loaded layer.", 400)
                operation[key] = arguments[key]
        for key in ("min", "max"):
            if key in arguments:
                number = _number(arguments[key])
                if number is None or "field" not in operation:
                    raise ServiceError("Numeric filters need a finite bound and a known numeric field.", 400)
                operation[key] = number
        if "min" in operation and "max" in operation and operation["min"] > operation["max"]:
            raise ServiceError("The filter minimum cannot exceed its maximum.", 400)
        if "categoryField" in operation or "category" in arguments:
            category = arguments.get("category")
            valid_category = isinstance(category, bool) or _number(category) is not None or isinstance(category, str) and len(category) <= 160
            if "categoryField" not in operation or not valid_category:
                raise ServiceError("Category filtering needs a known categorical field and a finite JSON scalar, with text limited to 160 characters.", 400)
            operation["category"] = category
        if operation["action"] == "filter" and not any(key in operation for key in ("min", "max", "category")):
            raise ServiceError("A filter needs numeric bounds or a category; no filter was queued.", 400)
        if operation["action"] in {"visualize", "hotspots"}:
            operation.setdefault("visualization", "heatmap" if operation["action"] == "hotspots" else layer.get("visualization", "points"))
        if operation.get("visualization") in {"contours", "surface"} and "field" not in operation:
            raise ServiceError("Contours and surfaces require an explicit known numeric field; elevation data is not assumed to be loaded.", 400)
        context.presented = True
        return {
            "queued": True,
            "message": "Queued a browser operation on an existing loaded layer. The browser must validate geometry and compute scoped results from actual data; the backend has not computed any measurements.",
            "mapUpdate": {"studio": operation},
        }

    def _clear_map(self, context: AgentRunContext, arguments: dict[str, Any]) -> dict[str, Any]:
        if arguments:
            raise ServiceError("Clear map does not accept parameters.", 400)
        if context.map_context.get("scope", {}).get("type", "workspace") != "workspace":
            raise ServiceError("Clearing the map only supports workspace scope. Nothing was cleared outside the requested scope.", 400)
        self.dependencies.clear_workspace()
        context.entities.clear()
        context.routes.clear()
        context.presented = True
        context.requires_presentation = False
        return {
            "cleared": True,
            "mapUpdate": {
                "selectedCity": None,
                "places": [],
                "routeStops": [],
                "route": None,
                "workspace": {"pins": [], "areas": [], "state": {}},
                "view": None,
                "clear": True,
            },
        }

    def _ask_user(self, context: AgentRunContext, arguments: dict[str, Any]) -> dict[str, Any]:
        question = _string(arguments.get("question"), "Question", 4, 300)
        choices = arguments.get("choices")
        if not isinstance(choices, list) or not 2 <= len(choices) <= 4:
            raise ServiceError("An agent question needs two to four choices.", 400)
        safe_choices = []
        for choice in choices:
            text = _string(choice, "Question choice", 1, 80)
            if text not in safe_choices:
                safe_choices.append(text)
        if len(safe_choices) < 2:
            raise ServiceError("An agent question needs distinct choices.", 400)
        return {"question": question, "choices": safe_choices}

    def _entity(self, context: AgentRunContext, reference: Any, required: bool = True) -> dict[str, Any] | None:
        if reference in (None, "") and not required:
            return None
        entity = context.entities.get(str(reference or ""))
        if not entity:
            raise ServiceError("The map agent referenced a location that was not returned by a trusted search.", 400)
        return entity

    def _entities(self, context: AgentRunContext, references: Any, maximum: int) -> list[dict[str, Any]]:
        if references is None:
            return []
        if not isinstance(references, list) or len(references) > maximum:
            raise ServiceError("The map agent selected an invalid set of places.", 400)
        seen: set[str] = set()
        result = []
        for reference in references:
            entity = self._entity(context, reference)
            assert entity is not None
            if entity["ref"] not in seen:
                seen.add(entity["ref"])
                result.append(entity)
        return result

    def _register_entity(self, context: AgentRunContext, source: dict[str, Any], kind: str) -> dict[str, Any]:
        location = self._location(source)
        if not location:
            raise ServiceError("A map provider returned an invalid location.", 503)
        existing_ref = next((reference for reference, entity in context.entities.items() if entity.get("kind") == kind and entity.get("id") == location.get("id")), None)
        if existing_ref:
            return context.entities[existing_ref]
        reference = f"{kind}:{context.next_ref}"
        context.next_ref += 1
        entity = {"ref": reference, "kind": kind, **location}
        context.entities[reference] = entity
        return entity

    @staticmethod
    def _location(source: Any) -> dict[str, Any] | None:
        if not isinstance(source, dict):
            return None
        try:
            lon, lat = _coordinates([source["lon"], source["lat"]], "Location")
        except (KeyError, ServiceError):
            return None
        name = _text(source.get("name") or source.get("shortName") or "Location").strip()
        if not name:
            return None
        bbox = _bounds(source.get("bbox")) or [lon, lat, lon, lat]
        return {
            "id": _text(source.get("id"), 180) or f"{lon:.6f},{lat:.6f}",
            "name": name,
            "shortName": _text(source.get("shortName") or name),
            "address": _text(source.get("address"), 240),
            "country": _text(source.get("country"), 120),
            "countryCode": _text(source.get("countryCode"), 2).upper(),
            "provider": _text(source.get("provider"), 80),
            "lat": lat,
            "lon": lon,
            "bbox": bbox,
        }

    @staticmethod
    def _output_entity(entity: dict[str, Any]) -> dict[str, Any]:
        return {key: copy.deepcopy(entity.get(key)) for key in ("ref", "id", "name", "shortName", "address", "country", "countryCode", "provider", "lat", "lon", "bbox")}

    @staticmethod
    def _coordinates_from_entity(entity: dict[str, Any]) -> tuple[float, float]:
        return _coordinates([entity.get("lon"), entity.get("lat")], "Known location")

    @staticmethod
    def _view_for(city: dict[str, Any] | None, places: list[dict[str, Any]], route: dict[str, Any] | None) -> dict[str, Any] | None:
        if route and isinstance(route.get("geometry"), dict):
            coordinates = route["geometry"].get("coordinates")
            if isinstance(coordinates, list) and len(coordinates) > 1:
                valid = [point for point in coordinates if isinstance(point, list) and len(point) >= 2]
                if valid:
                    lons, lats = zip(*[(float(point[0]), float(point[1])) for point in valid])
                    return {"bounds": [min(lons), min(lats), max(lons), max(lats)]}
        location = city or (places[0] if places else None)
        return {"center": [location["lon"], location["lat"]], "zoom": 13} if location else None

    @staticmethod
    def _geographic_bounds(context: AgentRunContext) -> list[float] | None:
        scope = context.map_context.get("scope", {})
        if scope.get("type") == "layer":
            raise ServiceError("Geographic search and routing cannot operate on a browser dataset layer scope. Use studio_operation or choose a geographic scope.", 400)
        return scope.get("bounds") if scope.get("type") in {"viewport", "selection"} else None

    @staticmethod
    def _inside(entity: dict[str, Any], bounds: list[float] | None) -> bool:
        if not bounds:
            return True
        lon, lat = _coordinates([entity.get("lon"), entity.get("lat")], "Scoped location")
        west, south, east, north = bounds
        return south <= lat <= north and (west <= lon <= east if west <= east else lon >= west or lon <= east)

    @staticmethod
    def _map_context(value: dict[str, Any] | None) -> dict[str, Any]:
        if not isinstance(value, dict):
            return {}
        result: dict[str, Any] = {"countryCode": _text(value.get("countryCode"), 2).upper()}
        try:
            result["center"] = list(_coordinates(value.get("center"), "Map center"))
        except ServiceError:
            pass
        selected = AgentTools._location(value.get("selectedCity"))
        if selected:
            result["selectedCity"] = selected
        bounds = _bounds(value.get("bounds"))
        if bounds:
            result["bounds"] = bounds
        zoom = _number(value.get("zoom"))
        if zoom is not None and 0 <= zoom <= 24:
            result["zoom"] = zoom
        for key, maximum in (("pins", 20), ("routeStops", 50)):
            if not isinstance(value.get(key), list):
                continue
            result[key] = []
            for raw in value[key][:maximum]:
                point = AgentTools._location(raw)
                if point:
                    item = {name: point[name] for name in ("id", "name", "countryCode", "lon", "lat")}
                    if isinstance(raw.get("label"), str):
                        item["label"] = _text(raw["label"])
                    result[key].append(item)
        if isinstance(value.get("areas"), list):
            result["areas"] = []
            for raw in value["areas"][:8]:
                area_bounds = _bounds(raw.get("bounds")) if isinstance(raw, dict) else None
                if not area_bounds:
                    continue
                area = {"id": _text(raw.get("id"), 80), "label": _text(raw.get("label")), "bounds": area_bounds}
                size = _number(raw.get("areaSquareMeters"))
                if size is not None and size >= 0:
                    area["areaSquareMeters"] = size
                result["areas"].append(area)
        raw_studio = value.get("studio")
        if isinstance(raw_studio, dict):
            studio: dict[str, Any] = {"name": _text(raw_studio.get("name")), "layers": []}
            workspace_id = raw_studio.get("workspaceId")
            if isinstance(workspace_id, str) and 1 <= len(workspace_id) <= 180:
                studio["workspaceId"] = workspace_id
            layers = raw_studio.get("layers")
            seen = set()
            for raw in layers[:20] if isinstance(layers, list) else []:
                if not isinstance(raw, dict):
                    continue
                layer_id = raw.get("id")
                if not isinstance(layer_id, str) or not 1 <= len(layer_id) <= 180 or layer_id in seen:
                    continue
                seen.add(layer_id)
                layer: dict[str, Any] = {"id": layer_id, "name": _text(raw.get("name")), "units": _text(raw.get("units"), 64)}
                for key in ("numericFields", "categoricalFields", "timeFields"):
                    fields = raw.get(key)
                    layer[key] = list(dict.fromkeys(item for item in fields[:32] if isinstance(item, str) and 1 <= len(item) <= 128)) if isinstance(fields, list) else []
                if raw.get("visualization") in STUDIO_VISUALIZATIONS:
                    layer["visualization"] = raw["visualization"]
                if isinstance(raw.get("field"), str) and raw["field"] in layer["numericFields"] + layer["categoricalFields"] + layer["timeFields"]:
                    layer["field"] = raw["field"]
                count = _number(raw.get("featureCount"))
                if count is not None and count.is_integer() and 0 <= count <= 1_000_000_000:
                    layer["featureCount"] = int(count)
                source = raw.get("source")
                if isinstance(source, str):
                    layer["source"] = _text(source, 240)
                elif isinstance(source, dict):
                    layer["source"] = {key: _text(source[key], 240) for key in ("name", "label", "type", "attribution", "license") if isinstance(source.get(key), str)}
                    if isinstance(source.get("caveat"), str):
                        layer["source"]["caveat"] = _text(source["caveat"], 500)
                    if isinstance(source.get("synthetic"), bool):
                        layer["source"]["synthetic"] = source["synthetic"]
                studio["layers"].append(layer)
            if isinstance(raw_studio.get("selectedLayerId"), str) and raw_studio["selectedLayerId"] in seen:
                studio["selectedLayerId"] = raw_studio["selectedLayerId"]
            result["studio"] = studio
        if "scope" in value:
            raw_scope = value["scope"]
            if not isinstance(raw_scope, dict) or raw_scope.get("type") not in ("viewport", "selection", "layer", "workspace"):
                raise ServiceError("Map scope must be viewport, selection, layer, or workspace.", 400)
            scope = {"type": raw_scope["type"]}
            scope_bounds = _bounds(raw_scope.get("bounds", result.get("bounds") if scope["type"] == "viewport" else None))
            if not scope_bounds and ("bounds" in raw_scope or scope["type"] in {"viewport", "selection"}):
                raise ServiceError("Viewport and selection scopes need valid [west, south, east, north] bounds.", 400)
            if scope_bounds:
                scope["bounds"] = scope_bounds
            if "layerId" in raw_scope or scope["type"] == "layer":
                layer_id = raw_scope.get("layerId")
                if not isinstance(layer_id, str) or not any(layer["id"] == layer_id for layer in result.get("studio", {}).get("layers", [])):
                    raise ServiceError("The scoped Studio layer is not loaded in this workspace.", 400)
                scope["layerId"] = layer_id
            result["scope"] = scope
        if len(json.dumps(result, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("utf-8")) > MAX_CONTEXT_BYTES:
            raise ServiceError("Map context is too large. Send a smaller loaded-layer inventory (maximum 24000 encoded bytes).", 413)
        return result
