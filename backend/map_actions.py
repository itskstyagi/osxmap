"""Shared, declarative map-action validation. No engine code or arbitrary URLs."""

import json
import math
import re

try:
    from .errors import ServiceError
    from .web_sources import parse_web_document
except ImportError:
    from errors import ServiceError
    from web_sources import parse_web_document


COLORS = {
    "black": "#000000", "silver": "#c0c0c0", "gray": "#808080", "grey": "#808080",
    "white": "#ffffff", "maroon": "#800000", "red": "#ff0000", "purple": "#800080",
    "fuchsia": "#ff00ff", "magenta": "#ff00ff", "green": "#008000", "lime": "#00ff00",
    "olive": "#808000", "yellow": "#ffff00", "navy": "#000080", "blue": "#0000ff",
    "teal": "#008080", "aqua": "#00ffff", "cyan": "#00ffff", "orange": "#ffa500",
    "pink": "#ffc0cb", "brown": "#a52a2a", "gold": "#ffd700", "violet": "#ee82ee", "indigo": "#4b0082",
}
STYLE_NUMBERS = {"opacity": (0, 1), "fillOpacity": (0, 1), "lineWidth": (0, 24),
                 "pointRadius": (1, 40), "strokeWidth": (0, 10), "labelSize": (8, 32)}
STYLE_KEYS = {"color", "fillColor", "strokeColor", "labelColor", "labels", "dashArray", *STYLE_NUMBERS}
STYLE_SCHEMA = {"type": "object", "properties": {
    **{key: {"type": "string"} for key in ("color", "fillColor", "strokeColor", "labelColor")},
    **{key: {"type": "number", "minimum": low, "maximum": high} for key, (low, high) in STYLE_NUMBERS.items()},
    "labels": {"type": "boolean"}, "dashArray": {"type": "array", "items": {"type": "number"}, "maxItems": 4},
}, "additionalProperties": False}
ACTION_KEYS = {
    "style_layer": {"layerId", "style"}, "set_visibility": {"layerId", "visible"}, "remove_layer": {"layerId"},
    "clear_overlays": set(), "move_layer": {"layerId", "beforeLayerId"},
    "filter_layer": {"layerId", "field", "operator", "value"}, "fit_layer": {"layerId"},
    "set_view": {"center", "zoom", "pitch", "bearing", "bounds"}, "set_basemap": {"mode"},
    "set_terrain": {"enabled", "exaggeration"}, "set_display": {"preference", "enabled"},
}


def color(value, *, reset=False):
    if reset and value == "":
        return ""
    if not isinstance(value, str):
        raise ServiceError("A color must be #rgb, #rrggbb, or a basic CSS name such as red.", 400)
    value = value.strip().lower()
    if value in COLORS:
        return COLORS[value]
    if re.fullmatch(r"#[0-9a-f]{3}", value):
        return "#" + "".join(char * 2 for char in value[1:])
    if re.fullmatch(r"#[0-9a-f]{6}", value):
        return value
    raise ServiceError("Unsupported color. Use #rgb, #rrggbb, or a basic CSS color name; no expressions or CSS functions.", 400)


def finite(value, name, low, high):
    if type(value) not in (int, float) or not math.isfinite(value) or not low <= value <= high:
        raise ServiceError(f"{name} must be a finite number from {low} to {high}.", 400)
    return value


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}", value) or value in {"__proto__", "constructor", "prototype"}:
        raise ServiceError("A map layer ID must contain 1-64 letters, numbers, dots, underscores, colons, or hyphens.", 400)
    return value


def style(value):
    if not isinstance(value, dict) or not value or set(value) - STYLE_KEYS:
        raise ServiceError("A nonempty style object with supported color, line, point, fill, or label settings is required.", 400)
    result = {}
    for key, item in value.items():
        if key in STYLE_NUMBERS:
            result[key] = finite(item, key, *STYLE_NUMBERS[key])
        elif key in {"color", "fillColor", "strokeColor", "labelColor"}:
            result[key] = color(item)
        elif key == "labels":
            if type(item) is not bool:
                raise ServiceError("Style labels must be a boolean.", 400)
            result[key] = item
        elif key == "dashArray":
            if not isinstance(item, list) or len(item) not in (0, 2, 3, 4):
                raise ServiceError("Dash array must be empty or contain 2-4 dash lengths.", 400)
            result[key] = [finite(number, "Dash length", 0, 24) for number in item]
            if item and not any(item):
                raise ServiceError("Dash lengths must not all be zero.", 400)
    if "color" in result and "fillColor" not in result:
        result["fillColor"] = result["color"]
    return result


def positions(geometry):
    value = geometry.get("coordinates", [])

    def walk(node):
        if isinstance(node, list) and len(node) >= 2 and all(type(item) in (int, float) for item in node[:2]):
            yield node
        elif isinstance(node, list):
            for child in node:
                yield from walk(child)

    yield from walk(value)


def collection(value):
    try:
        raw = json.dumps(value, allow_nan=False, separators=(",", ":")).encode()
    except (ValueError, TypeError, RecursionError, OverflowError):
        raise ServiceError("Map geometry must be finite, bounded JSON GeoJSON.", 400) from None
    if len(raw) > 4 * 1024 * 1024:
        raise ServiceError("Map overlay geometry exceeds the 4 MiB limit.", 413)
    document = parse_web_document(raw, "application/geo+json", "https://example.org/map-overlay.geojson")
    data = document.get("dataset")
    if not data or not data["features"]:
        raise ServiceError("The map overlay must contain actual geographic features.", 422)
    for feature in data["features"]:
        if feature.get("properties") is None:
            feature["properties"] = {}
    return data


def contained(point, bounds):
    if not bounds:
        return True
    west, south, east, north = bounds
    return south <= point[1] <= north and (west <= point[0] <= east if west <= east else point[0] >= west or point[0] <= east)


def extent_contained(inner, outer):
    if not outer:
        return True
    west, south, east, north = outer
    if inner[1] < south or inner[3] > north:
        return False
    outer_span = east - west if east >= west else east - west + 360
    inner_span = inner[2] - inner[0] if inner[2] >= inner[0] else inner[2] - inner[0] + 360
    if outer_span >= 360:
        return True
    offset = (inner[0] - west) % 360
    return offset + inner_span <= outer_span + 1e-10


def validate_scope(data, bounds):
    if not bounds:
        return
    for feature in data["features"]:
        points = list(positions(feature["geometry"]))
        if any(not contained(point, bounds) for point in points):
            raise ServiceError("This full geometry leaves the frozen geographic scope. Select a scope containing it; no whole-city boundary or outside road was substituted.", 400)
        west, _, east, _ = bounds
        if west > east:
            span = (east - west) % 360
            for left, right in zip(points, points[1:]):
                if abs(((right[0] - west) % 360) - ((left[0] - west) % 360)) > 180 and span < 360:
                    raise ServiceError("Geometry crosses an excluded longitude arc outside the requested scope.", 400)


def data_bounds(data):
    points = [point for feature in data["features"] for point in positions(feature["geometry"])]
    return [min(point[0] for point in points), min(point[1] for point in points),
            max(point[0] for point in points), max(point[1] for point in points)]


def circle(center, radius):
    lon, lat = center
    radius = finite(radius, "Circle radius in meters", 1, 500000)
    if abs(lat) > 85:
        raise ServiceError("Circle drawing is supported between 85 degrees south and north.", 400)
    angular = radius / 6371008.8
    longitude, latitude = math.radians(lon), math.radians(lat)
    ring = []
    for index in range(64):
        bearing = index * 2 * math.pi / 64
        target_lat = math.asin(math.sin(latitude) * math.cos(angular) + math.cos(latitude) * math.sin(angular) * math.cos(bearing))
        target_lon = longitude + math.atan2(math.sin(bearing) * math.sin(angular) * math.cos(latitude), math.cos(angular) - math.sin(latitude) * math.sin(target_lat))
        ring.append([((math.degrees(target_lon) + 180) % 360) - 180, math.degrees(target_lat)])
    if max(point[0] for point in ring) - min(point[0] for point in ring) > 180:
        raise ServiceError("A circle crossing the antimeridian needs a reviewed split polygon; no world-spanning shape was substituted.", 400)
    return {"type": "Polygon", "coordinates": [ring + [ring[0]]]}
