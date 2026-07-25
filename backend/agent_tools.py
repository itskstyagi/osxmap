"""Validated map-domain tools exposed to the OpenAI-compatible map agent."""

from __future__ import annotations

import copy
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
    if not isinstance(value, (list, tuple)) or len(value) < 2:
        raise ServiceError(f"{label} needs valid coordinates.", 400)
    try:
        lon, lat = float(value[0]), float(value[1])
    except (TypeError, ValueError):
        raise ServiceError(f"{label} needs valid coordinates.", 400) from None
    if not math.isfinite(lon) or not math.isfinite(lat) or not -180 <= lon <= 180 or not -90 <= lat <= 90:
        raise ServiceError(f"{label} needs valid coordinates.", 400)
    return lon, lat


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
            self._register_entity(context, selected, "city")
        return context

    def execute(self, context: AgentRunContext, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        handlers = {
            "find_city": self._find_city,
            "search_places": self._search_places,
            "plan_route": self._plan_route,
            "present_map": self._present_map,
            "clear_map": self._clear_map,
            "ask_user": self._ask_user,
        }
        handler = handlers.get(name)
        if not handler:
            raise ServiceError("The requested map-agent tool is not available.", 400)
        return handler(context, arguments)

    @staticmethod
    def stage_label(name: str) -> str:
        return {
            "find_city": "Finding the right city",
            "search_places": "Searching local, OSM, and place data",
            "plan_route": "Planning a road route",
            "present_map": "Drawing the map",
            "clear_map": "Clearing the map",
            "ask_user": "Preparing a question",
        }.get(name, "Updating the map")

    def _find_city(self, context: AgentRunContext, arguments: dict[str, Any]) -> dict[str, Any]:
        query = _string(arguments.get("query"), "City query", 2)
        country = str(arguments.get("countryCode") or "")[:2].upper()
        exact = self.dependencies.resolve_city(query, country)
        candidates = [exact] if exact else self.dependencies.suggest_cities(query, country)
        locations = [self._output_entity(self._register_entity(context, item, "city")) for item in candidates[:6] if self._location(item)]
        if not locations:
            return {"locations": [], "message": "No matching city was found."}
        context.requires_presentation = True
        return {"locations": locations}

    def _search_places(self, context: AgentRunContext, arguments: dict[str, Any]) -> dict[str, Any]:
        query = _string(arguments.get("query"), "Place query", 2)
        nearby = self._entity(context, arguments.get("nearRef"), required=False)
        if nearby:
            lon, lat = self._coordinates_from_entity(nearby)
            country = str(nearby.get("countryCode") or arguments.get("countryCode") or "")[:2].upper()
        else:
            center = context.map_context.get("center")
            lon, lat = _coordinates(center, "Map center") if center else (None, None)
            country = str(arguments.get("countryCode") or context.map_context.get("countryCode") or "")[:2].upper()
        discovery = self.dependencies.search_places(query, country, lat, lon)
        results = discovery.get("results") if isinstance(discovery, dict) else None
        if not isinstance(results, list):
            raise ServiceError("The place-discovery service returned an invalid response.", 503)
        places = [self._output_entity(self._register_entity(context, item, "place")) for item in results[:20] if self._location(item)]
        if places:
            context.requires_presentation = True
        return {
            "places": places,
            "source": str(discovery.get("source") or "unknown"),
            "lookupStage": str(discovery.get("lookupStage") or "unknown"),
            "stored": bool(discovery.get("stored")),
            "fallbackReason": str(discovery.get("fallbackReason") or ""),
            "serpEligible": bool(discovery.get("serpEligible")),
        }

    def _plan_route(self, context: AgentRunContext, arguments: dict[str, Any]) -> dict[str, Any]:
        references = arguments.get("waypointRefs")
        if not isinstance(references, list) or not 2 <= len(references) <= 50:
            raise ServiceError("A route needs between two and fifty known waypoints.", 400)
        waypoints = []
        stops = []
        for reference in references:
            entity = self._entity(context, reference)
            assert entity is not None
            lon, lat = self._coordinates_from_entity(entity)
            waypoints.append([lon, lat])
            stops.append(self._output_entity(entity))
        route = self.dependencies.plan_route(waypoints, str(arguments.get("profile") or "driving"))
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
        city = self._entity(context, arguments.get("cityRef"), required=False)
        places = self._entities(context, arguments.get("placeRefs"), 20)
        route_reference = str(arguments.get("routeRef") or "")
        route_entry = context.routes.get(route_reference)
        if route_reference and not route_entry:
            raise ServiceError("The map agent referenced a route that was not planned in this request.", 400)
        persistent_refs = {str(value) for value in arguments.get("persistPlaceRefs") or []}
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

    def _clear_map(self, context: AgentRunContext, arguments: dict[str, Any]) -> dict[str, Any]:
        if arguments:
            raise ServiceError("Clear map does not accept parameters.", 400)
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
            lon, lat = float(source["lon"]), float(source["lat"])
        except (KeyError, TypeError, ValueError):
            return None
        if not math.isfinite(lon) or not math.isfinite(lat) or not -180 <= lon <= 180 or not -90 <= lat <= 90:
            return None
        name = str(source.get("name") or source.get("shortName") or "Location").strip()[:160]
        if not name:
            return None
        bbox = source.get("bbox") if isinstance(source.get("bbox"), list) and len(source["bbox"]) == 4 else [lon, lat, lon, lat]
        return {
            "id": str(source.get("id") or f"{lon:.6f},{lat:.6f}"),
            "name": name,
            "shortName": str(source.get("shortName") or name)[:160],
            "address": str(source.get("address") or "")[:240],
            "country": str(source.get("country") or "")[:120],
            "countryCode": str(source.get("countryCode") or "")[:2].upper(),
            "provider": str(source.get("provider") or "")[:80],
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
    def _map_context(value: dict[str, Any] | None) -> dict[str, Any]:
        if not isinstance(value, dict):
            return {}
        result: dict[str, Any] = {"countryCode": str(value.get("countryCode") or "")[:2].upper()}
        try:
            result["center"] = list(_coordinates(value.get("center"), "Map center"))
        except ServiceError:
            pass
        selected = AgentTools._location(value.get("selectedCity"))
        if selected:
            result["selectedCity"] = selected
        return result
