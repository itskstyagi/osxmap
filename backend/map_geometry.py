"""Verified OSM city polygons and bounded, source-backed road segments."""

from __future__ import annotations

import json
import math
import re
import unicodedata
from types import MappingProxyType
from urllib.parse import urlencode, urlsplit

try:
    from .errors import ServiceError
    from .web_sources import _load_json, fetch_public_bytes, parse_web_document, validate_web_url
except ImportError:  # Supports `python backend/server.py`.
    from errors import ServiceError
    from web_sources import _load_json, fetch_public_bytes, parse_web_document, validate_web_url

MAX_RAW_BYTES = 4 * 1024 * 1024
MAX_POSITIONS = 30000
MAX_FEATURES = 1000
MAX_ROAD_AREA_KM2 = 2500
HIGHWAY_CLASSES = ("motorway", "trunk", "primary", "secondary", "tertiary", "residential",
                   "service", "unclassified", "living_street", "pedestrian", "cycleway", "footway")
OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter"
_NOMINATIM = "https://nominatim.openstreetmap.org/"
_JSON_TYPES = ("application/json", "application/geo+json", "application/geojson")
_CITY_TYPES = frozenset({"city", "town", "village", "municipality"})
_GENERAL_ROADS = frozenset({"road", "roads", "street", "streets", "highways", "all roads", "all streets", "road network"})
_SOURCE = MappingProxyType({"attribution": "OpenStreetMap contributors", "license": "ODbL 1.0"})


def validate_geometry_query(value):
    if (not isinstance(value, str) or not 1 <= len(value.strip()) <= 160
            or any(ord(char) < 32 or ord(char) == 127 or 0xD800 <= ord(char) <= 0xDFFF for char in value)
            or re.search(r"(?:https?|file|ftp|data|javascript):|www\.", value, re.I)):
        raise ServiceError("Geometry queries must be names of 1 to 160 characters, not URLs or instructions to a provider.", 400)
    normalized = " ".join(unicodedata.normalize("NFKC", value).strip().split())
    if len(normalized) > 160:
        raise ServiceError("Geometry query exceeds the 160 character limit.", 400)
    return normalized


def _osm_number(value):
    if type(value) is int or (isinstance(value, str) and re.fullmatch(r"[1-9][0-9]{0,18}", value)):
        number = int(value)
        if 0 < number < 2**63:
            return number
    return None


def _identity(value):
    identities = []
    for key in ("id", "providerId"):
        identifier = value.get(key)
        if not isinstance(identifier, str):
            continue
        match = re.fullmatch(r"(?:(?:osm|openstreetmap):)?(node|way|relation):([1-9][0-9]{0,18})", identifier)
        if match and _osm_number(match[2]):
            identities.append((match[1], int(match[2])))
        elif identifier.startswith(("osm:", "openstreetmap:", "node:", "way:", "relation:")):
            raise ServiceError("City OpenStreetMap identity is invalid.", 422)
    if "osm_type" in value or "osm_id" in value:
        kind, number = value.get("osm_type"), _osm_number(value.get("osm_id"))
        if not isinstance(kind, str) or kind not in {"node", "way", "relation"} or number is None:
            raise ServiceError("Source OpenStreetMap identity is invalid.", 422)
        identities.append((kind, number))
    if len(set(identities)) > 1:
        raise ServiceError("City OpenStreetMap identities do not match.", 422)
    return identities[0] if identities else None


def _read_json(url, fetch_bytes, timeout):
    url = validate_web_url(url)
    fetched = (fetch_bytes or fetch_public_bytes)(url, max_bytes=MAX_RAW_BYTES, timeout=timeout,
                                                 allowed_media_types=_JSON_TYPES)
    if not isinstance(fetched, dict):
        raise ServiceError("Geometry source returned an invalid response.", 502)
    if validate_web_url(fetched.get("final_url", "")) != url:
        raise ServiceError("Geometry source redirected away from its verified request.", 502)
    raw = fetched.get("raw")
    if not isinstance(raw, bytes) or not raw:
        raise ServiceError("Geometry source returned no document.", 422)
    if len(raw) > MAX_RAW_BYTES:
        raise ServiceError("Geometry source exceeds the 4 MiB limit.", 413)
    content_type = fetched.get("content_type")
    if not isinstance(content_type, str) or content_type.split(";", 1)[0].strip().lower() not in _JSON_TYPES:
        raise ServiceError("Geometry source must return JSON.", 415)
    try:
        return _load_json(raw.decode("utf-8-sig"))
    except UnicodeError:
        raise ServiceError("Geometry source JSON encoding is invalid.", 422) from None


def _validated_dataset(features, url):
    if len(features) > MAX_FEATURES:
        raise ServiceError("Geometry exceeds the 1000 feature limit.", 413)
    count, bounds = 0, [180.0, 90.0, -180.0, -90.0]
    for feature in features:
        geometry = feature["geometry"]
        levels = {"LineString": 1, "Polygon": 2, "MultiPolygon": 3}
        kind = geometry.get("type")
        if not isinstance(kind, str) or kind not in levels or geometry.get("crs") is not None:
            raise ServiceError("Geometry must be a source-backed WGS84 polygon or road line.", 422)
        stack = [(geometry.get("coordinates"), levels[kind])]
        while stack:
            value, level = stack.pop()
            if not isinstance(value, list) or not value:
                raise ServiceError("Geometry coordinates are invalid.", 422)
            if level:
                if len(value) > MAX_POSITIONS:
                    raise ServiceError("Geometry exceeds the 30000 position limit.", 413)
                stack.extend((child, level - 1) for child in value)
                continue
            count += 1
            if count > MAX_POSITIONS:
                raise ServiceError("Geometry exceeds the 30000 position limit.", 413)
            if (len(value) not in {2, 3} or any(type(number) not in {int, float} or not -1e9 < number < 1e9 for number in value)
                    or not -180 <= value[0] <= 180 or not -90 <= value[1] <= 90):
                raise ServiceError("Geometry positions must be finite WGS84 coordinates.", 422)
            bounds = [min(bounds[0], value[0]), min(bounds[1], value[1]), max(bounds[2], value[0]), max(bounds[3], value[1])]
        polygons = [geometry["coordinates"]] if kind == "Polygon" else geometry["coordinates"] if kind == "MultiPolygon" else []
        for polygon in polygons:
            for ring in polygon:
                x, y = ring[0][:2]
                # Translate before summation so near-collinear rings do not gain area through cancellation.
                area = math.fsum((a[0] - x) * (b[1] - y) - (b[0] - x) * (a[1] - y) for a, b in zip(ring, ring[1:]))
                if abs(area) <= 1e-14:
                    raise ServiceError("City polygon contains a degenerate ring.", 422)
    raw = json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False,
                     allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(raw) > MAX_RAW_BYTES:
        raise ServiceError("Geometry result exceeds the 4 MiB limit.", 413)
    dataset = parse_web_document(raw, "application/geo+json", url)["dataset"]
    return dataset, bounds if count else None, count


def _city_class(properties):
    category = properties.get("category") or properties.get("class")
    kind, address_type = properties.get("type"), properties.get("addresstype")
    if category == "boundary" and kind == "administrative" and isinstance(address_type, str) and address_type in _CITY_TYPES:
        return "administrative"
    if (category == "place" and isinstance(kind, str) and kind in _CITY_TYPES
            and (not address_type or isinstance(address_type, str) and address_type in _CITY_TYPES)):
        return "settlement"
    return None


def _matches_city(properties, name, country):
    address = properties.get("address")
    address = address if isinstance(address, dict) else {}
    names = [properties["name"]] if properties.get("name") else [address.get(key) for key in ("city", "town", "village", "municipality")]
    return (str(address.get("country_code") or "").upper() == country and _city_class(properties)
            and any(isinstance(value, str) and " ".join(unicodedata.normalize("NFKC", value).casefold().split()) == name.casefold()
                    for value in names))


def load_city_geometry(city: dict, *, fetch_bytes=None) -> dict:
    """Load the polygon for a trusted resolved city, never substitute its search bbox.

    Existing OSM identity is looked up directly. Only cities without an identity use
    an exact-name, country- and location-verified metadata search before lookup.
    Supplied Nominatim polygons are reused only with matching OSM metadata.
    Source metadata is provider-owned; caller URLs, attribution and licenses are ignored.
    """
    if not isinstance(city, dict):
        raise ServiceError("City geometry requires a resolved city.", 400)
    name = validate_geometry_query(city.get("shortName") or str(city.get("name") or "").split(",", 1)[0])
    country = city.get("countryCode")
    if not isinstance(country, str) or not re.fullmatch(r"[A-Za-z]{2}", country):
        raise ServiceError("City country code is required to verify its boundary.", 400)
    country = country.upper()
    identity = _identity(city)
    metadata = city.get("providerPayload") or city.get("properties") or city
    metadata = metadata if isinstance(metadata, dict) else {}
    supplied = metadata.get("geojson") or metadata.get("geometry") or city.get("geojson") or city.get("geometry")
    supplied_polygon = isinstance(supplied, dict) and supplied.get("type") in ("Polygon", "MultiPolygon")
    source_identity = _identity(metadata) if supplied_polygon or identity is None else None
    if source_identity is not None and (supplied_polygon or identity is None):
        if (identity is not None and identity != source_identity) or not _matches_city(metadata, name, country):
            raise ServiceError("Supplied city polygon does not match the verified city identity, country and source class.", 422)
        identity = source_identity
    if identity is None:
        lon, lat = city.get("lon"), city.get("lat")
        if type(lon) not in {int, float} or type(lat) not in {int, float} or not (-180 <= lon <= 180 and -90 <= lat <= 90):
            raise ServiceError("City without an OSM identity needs verified coordinates for boundary lookup.", 422)
        search_url = _NOMINATIM + "search?" + urlencode({"q": name, "countrycodes": country.lower(), "featuretype": "city",
            "format": "jsonv2", "addressdetails": "1", "extratags": "1", "limit": "6"})
        candidates = _read_json(search_url, fetch_bytes, 20)
        if not isinstance(candidates, list) or len(candidates) > 6:
            raise ServiceError("City metadata source returned an invalid candidate list.", 502)
        matches = set()
        for candidate in candidates:
            if not isinstance(candidate, dict) or not _matches_city(candidate, name, country):
                continue
            try:
                south, north, west, east = (float(value) for value in candidate.get("boundingbox", []))
            except (TypeError, ValueError, OverflowError):
                continue
            if -180 <= west <= lon <= east <= 180 and -90 <= south <= lat <= north <= 90:
                candidate_identity = _identity(candidate)
                if candidate_identity:
                    matches.add(candidate_identity)
        if len(matches) > 1:
            raise ServiceError("City boundary identity is ambiguous; no polygon was selected.", 409)
        if not matches:
            raise ServiceError("No exact city identity was verified for boundary lookup.", 404)
        identity = matches.pop()
    lookup_url = _NOMINATIM + "lookup?" + urlencode({"osm_ids": {"node": "N", "way": "W", "relation": "R"}[identity[0]] + str(identity[1]),
        "format": "geojson", "addressdetails": "1", "extratags": "1", "polygon_geojson": "1"})
    if not (supplied_polygon and source_identity == identity):
        payload = _read_json(lookup_url, fetch_bytes, 20)
        if not isinstance(payload, dict) or payload.get("type") != "FeatureCollection" or not isinstance(payload.get("features"), list):
            raise ServiceError("City boundary source returned invalid GeoJSON.", 422)
        if payload.get("crs") is not None:
            raise ServiceError("City boundary source must use WGS84 GeoJSON.", 422)
        if len(payload["features"]) > MAX_FEATURES:
            raise ServiceError("City boundary source exceeds the 1000 feature limit.", 413)
        if not payload["features"]:
            raise ServiceError("No city boundary polygon was returned by OpenStreetMap.", 404)
        if len(payload["features"]) != 1:
            raise ServiceError("City boundary source did not return one verified OSM entity.", 422)
        feature = payload["features"][0]
        if not isinstance(feature, dict) or feature.get("type") != "Feature" or feature.get("crs") is not None:
            raise ServiceError("City boundary source returned an invalid feature.", 422)
        metadata, supplied = feature.get("properties"), feature.get("geometry")
        if not isinstance(metadata, dict) or _identity(metadata) != identity or not _matches_city(metadata, name, country):
            raise ServiceError("City boundary source does not match the trusted OSM identity, country and city class.", 422)
    if not isinstance(supplied, dict) or supplied.get("type") not in ("Polygon", "MultiPolygon"):
        raise ServiceError("No actual city polygon is available. A bounding box is not a city boundary.", 422)
    properties = {"name": name, "kind": "city-boundary", "osmType": identity[0], "osmId": identity[1]}
    dataset, bounds, _ = _validated_dataset([{"type": "Feature", "id": f"osm:{identity[0]}:{identity[1]}",
                                             "properties": properties, "geometry": supplied}], lookup_url)
    caveat = ("Community-maintained OpenStreetMap administrative city boundary; legal or census definitions may differ."
              if _city_class(metadata) == "administrative" else
              "OpenStreetMap settlement extent, not a verified legal administrative boundary.")
    return _bounded_document({"dataset": dataset, "name": name, "bounds": bounds,
        "source": {**_SOURCE, "name": "OpenStreetMap city geometry (Nominatim)", "url": lookup_url,
                   "caveat": caveat + " Original source polygon retained, including holes; no bounding-box substitute."}})


def _road_request(query, bounds, classes):
    query = validate_geometry_query(query)
    if (not isinstance(bounds, (list, tuple)) or len(bounds) != 4
            or any(type(value) not in {int, float} or not -180 <= value <= 180 for value in bounds)):
        raise ServiceError("Road bounds must be four finite WGS84 numbers [west, south, east, north].", 400)
    west, south, east, north = bounds
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90):
        raise ServiceError("Road bounds must be nonempty; antimeridian-crossing boxes are unsupported.", 400)
    area = 6371.0088**2 * math.radians(east - west) * (math.sin(math.radians(north)) - math.sin(math.radians(south)))
    if east - west > 1 or north - south > 1 or area > MAX_ROAD_AREA_KM2:
        raise ServiceError("Road search exceeds the local 2500 square kilometer / 1 degree extent limit; request smaller bounds.", 413)
    if classes is not None and (not isinstance(classes, list) or not 1 <= len(classes) <= len(HIGHWAY_CLASSES)
                               or any(not isinstance(value, str) or value not in HIGHWAY_CLASSES for value in classes)):
        raise ServiceError("Road classes must be a nonempty list of supported OSM highway values.", 400)
    classes = [value for value in HIGHWAY_CLASSES if classes is None or value in classes]
    name = None if query.casefold() in _GENERAL_ROADS else query
    literal = "[[:space:]]+".join(re.sub(r"([\\.^$|?*+()\[\]{}])", r"\\\1", token) for token in query.split())
    pattern = "(^|[^[:alnum:]_])" + literal + "([^[:alnum:]_]|$)"
    name_filter = '["name"~' + json.dumps(pattern, ensure_ascii=False) + ',i]' if name else ""
    box = ",".join(format(float(value), ".12g") for value in (south, west, north, east))
    ql = ('[out:json][timeout:25][maxsize:4194304];\nway["highway"~"^(' + "|".join(classes) + ')$"]'
          + name_filter + "(" + box + ");\nout tags geom " + str(MAX_FEATURES + 1) + ";")
    matcher = re.compile(r"(?<!\w)" + r"\s+".join(re.escape(token) for token in query.split()) + r"(?!\w)", re.I) if name else None
    return query, [float(value) for value in bounds], classes, ql, matcher


def _clip_segment(first, second, bounds):
    west, south, east, north = bounds
    dx, dy = second[0] - first[0], second[1] - first[1]
    if abs(dx) > 180:  # Do not interpret an antimeridian edge as a line across the world.
        return None
    low, high = 0.0, 1.0
    for p, q in ((-dx, first[0] - west), (dx, east - first[0]), (-dy, first[1] - south), (dy, north - first[1])):
        if p == 0:
            if q < 0:
                return None
        elif p < 0:
            low = max(low, q / p)
        else:
            high = min(high, q / p)
        if low > high:
            return None
    points = []
    for fraction in (low, high):
        point = first if fraction == 0 else second if fraction == 1 else [first[0] + fraction * dx, first[1] + fraction * dy]
        points.append([min(east, max(west, point[0])), min(north, max(south, point[1]))])
    return points if points[0] != points[1] else None


def _clip_way(geometry, bounds):
    parts, current, previous, invalid = [], [], None, 0
    for position in geometry:
        point = ([position.get("lon"), position.get("lat")] if isinstance(position, dict) else None)
        valid = (point is not None and all(type(value) in {int, float} for value in point)
                 and -180 <= point[0] <= 180 and -90 <= point[1] <= 90)
        if valid and point == previous:
            continue
        segment = _clip_segment(previous, point, bounds) if valid and previous is not None else None
        if segment:
            # Join only at the original shared vertex inside the box, never across an outside branch.
            inside = bounds[0] <= previous[0] <= bounds[2] and bounds[1] <= previous[1] <= bounds[3]
            if current and current[-1] == segment[0] and inside:
                current.append(segment[1])
            else:
                if current:
                    parts.append(current)
                current = segment
        elif current:
            parts.append(current)
            current = []
        if not valid:
            invalid += 1
        previous = point if valid else None
    if current:
        parts.append(current)
    return parts, invalid


def load_road_geometry(query: str, bounds: list, classes: list | None = None, *, fetch_bytes=None,
                       overpass_endpoint=OVERPASS_ENDPOINT) -> dict:
    """Fetch literal named roads or allowlisted highways inside a small geographic box.

    The optional transport/endpoint are server configuration only, not tool inputs.
    Output consists of original way segments clipped at the box, with disconnected
    pieces kept separate. Caps and provider partial results never imply complete coverage.
    """
    query, bounds, classes, ql, matcher = _road_request(query, bounds, classes)
    endpoint = validate_web_url(overpass_endpoint)
    parts = urlsplit(endpoint)
    if parts.scheme != "https" or parts.path != "/api/interpreter" or parts.query or parts.port not in {None, 443}:
        raise ServiceError("Configured road source must be a public HTTPS Overpass interpreter endpoint.", 400)
    url = endpoint + "?" + urlencode({"data": ql})
    payload = _read_json(url, fetch_bytes, 30)
    if not isinstance(payload, dict) or not isinstance(payload.get("elements"), list):
        raise ServiceError("Road source returned an invalid element list.", 422)
    elements = payload["elements"]
    if len(elements) > MAX_FEATURES + 1:
        raise ServiceError("Road source exceeded the bounded element limit.", 413)
    source_positions = sum(len(element["geometry"]) for element in elements
                           if isinstance(element, dict) and isinstance(element.get("geometry"), list))
    if source_positions > MAX_POSITIONS:
        raise ServiceError("Road source exceeds the 30000 position limit; request smaller bounds. No complete coverage is claimed.", 413)
    reasons = ["provider element limit reached"] if len(elements) == MAX_FEATURES + 1 else []
    if payload.get("remark"):
        reasons.append("provider reported incomplete coverage")
    features, positions, invalid_ways, invalid_positions = [], 0, 0, 0
    for element in elements:
        if not isinstance(element, dict) or element.get("type") != "way":
            invalid_ways += 1
            continue
        tags, number, geometry = element.get("tags"), _osm_number(element.get("id")), element.get("geometry")
        if not isinstance(tags, dict) or number is None or not isinstance(geometry, list) or len(geometry) < 2:
            invalid_ways += 1
            continue
        name = " ".join(tags["name"].split())[:300] if isinstance(tags.get("name"), str) else ""
        if tags.get("highway") not in classes or (matcher and not matcher.search(name)):
            continue
        segments, invalid = _clip_way(geometry, bounds)
        invalid_positions += invalid
        for index, line in enumerate(segments):
            if len(features) >= MAX_FEATURES or positions + len(line) > MAX_POSITIONS:
                if "output geometry limit reached" not in reasons:
                    reasons.append("output geometry limit reached")
                break
            features.append({"type": "Feature", "id": f"osm:way:{number}:{index + 1}",
                "properties": {"kind": "road", "name": name, "highway": tags["highway"], "osmType": "way", "osmId": number},
                "geometry": {"type": "LineString", "coordinates": line}})
            positions += len(line)
        if "output geometry limit reached" in reasons:
            break
    if not features and reasons:
        raise ServiceError("Road source could not return usable geometry within the bounded query; request smaller bounds or retry.",
                           413 if "output geometry limit reached" in reasons else 503)
    dataset, geometry_bounds, positions = _validated_dataset(features, url)
    caveat = ("Bounding-box road search, not complete city coverage. Original OSM way segments clipped to the box; "
              "no routing, invented connections or inferred roads. Highway classes: " + ", ".join(classes) + ".")
    if reasons:
        caveat += " Coverage is truncated: " + "; ".join(reasons) + "."
    if invalid_ways or invalid_positions:
        caveat += " Invalid source ways/positions were excluded without connecting gaps."
    if not features:
        caveat += " No matching road geometry was returned."
    document = {"dataset": dataset, "name": "Roads" if matcher is None else query, "bounds": geometry_bounds or bounds,
        "source": {**_SOURCE, "name": "OpenStreetMap roads (Overpass)", "url": url, "caveat": caveat},
        "coverage": {"bounds": bounds, "highwayClasses": classes, "nameFilter": query if matcher else None,
                     "featureCount": len(features), "positionCount": positions, "sourceWayCount": len(elements),
                     "sourcePositionCount": source_positions, "truncated": bool(reasons), "truncationReasons": reasons,
                     "excludedInvalidWays": invalid_ways, "excludedInvalidPositions": invalid_positions}}
    return _bounded_document(document)


def _bounded_document(document):
    if len(json.dumps(document, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")) > MAX_RAW_BYTES:
        raise ServiceError("Geometry document exceeds the 4 MiB limit; request smaller bounds.", 413)
    return document
