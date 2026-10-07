"""Monument City Explorer API.

The HTTP API remains standard-library based; agent transport and orchestration
are isolated in dedicated backend modules.
"""

from __future__ import annotations

import copy
import functools
import hashlib
import heapq
import json
import math
import re
import signal
import sqlite3
import struct
import subprocess
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zlib
from contextlib import contextmanager
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Iterator

try:
    from .agent import MapAgentService
    from .agent_tools import AgentDependencies, AgentTools
    from .config import BACKEND_DIR, Config, is_loopback_host
    from .errors import ServiceError
    from .openai_client import OpenAIChatClient
    from .realtime import RealtimeHub
    from .web_sources import fetch_web_document, validate_web_url
except ImportError:  # Supports `python server.py` from the backend directory.
    from agent import MapAgentService
    from agent_tools import AgentDependencies, AgentTools
    from config import BACKEND_DIR, Config, is_loopback_host
    from errors import ServiceError
    from openai_client import OpenAIChatClient
    from realtime import RealtimeHub
    from web_sources import fetch_web_document, validate_web_url


EARTH_RADIUS = 6_371_008.8
TILE_ZOOM = 14
DEFAULT_HEIGHT = 9.0
NEIGHBOR_RADIUS = 150.0
MAX_TILE_PAYLOAD = 14_000_000
OPENBUILDINGMAP_CATALOG_TTL_SECONDS = 600
SERPAPI_ARCHIVE_DIR = BACKEND_DIR / "logs" / "serpapi"
CONFIG = Config()
REQUEST_GATE = threading.BoundedSemaphore(CONFIG.max_concurrent_requests)


class SerialQueue:
    """Serialize requests to public services and enforce a completion interval."""

    def __init__(self, minimum_interval_seconds: float = 0) -> None:
        self.minimum_interval_seconds = minimum_interval_seconds
        self.lock = threading.Lock()
        self.last_finished = 0.0

    def run(self, task: Callable[[], Any]) -> Any:
        with self.lock:
            wait = self.minimum_interval_seconds - (time.monotonic() - self.last_finished)
            if wait > 0:
                time.sleep(wait)
            try:
                return task()
            finally:
                self.last_finished = time.monotonic()


NOMINATIM_QUEUE = SerialQueue(1.05)
SERP_QUEUE = SerialQueue()
SERP_PLACE_QUEUE = SerialQueue()
OVERPASS_QUEUE = SerialQueue(3.0)
DUCKDB_QUEUE = SerialQueue()
OPENBUILDINGMAP_QUEUE = SerialQueue()
OPENBUILDINGMAP_CATALOG: dict[str, Any] = {"expires": 0.0, "files": []}
OPENBUILDINGMAP_CATALOG_LOCK = threading.Lock()
OVERPASS_UNAVAILABLE_UNTIL = 0.0
OVERPASS_UNAVAILABLE_LOCK = threading.Lock()


class Cache:
    def __init__(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path, check_same_thread=False)
        self.connection.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.connection.execute("PRAGMA busy_timeout = 5000")
        self.connection.execute("PRAGMA foreign_keys = ON")
        self.connection.execute("PRAGMA journal_mode = WAL")
        self._initialize()

    def _initialize(self) -> None:
        with self.lock, self.connection:
            self.connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS geocode_cache (
                  cache_key TEXT PRIMARY KEY,
                  result_json TEXT NOT NULL,
                  expires_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS suggestions_cache (
                  prefix TEXT NOT NULL,
                  country_code TEXT NOT NULL,
                  results_json TEXT NOT NULL,
                  expires_at INTEGER NOT NULL,
                  PRIMARY KEY(prefix, country_code)
                );
                CREATE TABLE IF NOT EXISTS raw_tiles (
                  source TEXT NOT NULL,
                  tile_id TEXT NOT NULL,
                  payload BLOB NOT NULL,
                  stats_json TEXT NOT NULL,
                  expires_at INTEGER NOT NULL,
                  PRIMARY KEY(source, tile_id)
                );
                CREATE INDEX IF NOT EXISTS geocode_expiry ON geocode_cache(expires_at);
                CREATE INDEX IF NOT EXISTS suggestions_expiry ON suggestions_cache(expires_at);
                CREATE INDEX IF NOT EXISTS raw_tiles_expiry ON raw_tiles(expires_at);
                """
            )
            self.connection.execute(
                "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)"
            )
            applied = {row["version"] for row in self.connection.execute("SELECT version FROM schema_migrations")}
            if 1 not in applied:
                self.connection.executescript(
                    """
                    CREATE TABLE places (
                      place_id TEXT PRIMARY KEY,
                      provider TEXT NOT NULL,
                      provider_id TEXT NOT NULL,
                      name TEXT NOT NULL,
                      normalized_name TEXT NOT NULL,
                      address TEXT NOT NULL,
                      country_code TEXT NOT NULL,
                      latitude REAL NOT NULL,
                      longitude REAL NOT NULL,
                      bbox_json TEXT NOT NULL,
                      provider_payload_json TEXT NOT NULL,
                      created_at INTEGER NOT NULL,
                      updated_at INTEGER NOT NULL
                    );
                    CREATE INDEX places_name ON places(normalized_name);
                    CREATE INDEX places_coordinates ON places(latitude, longitude);

                    CREATE TABLE place_lookups (
                      lookup_key TEXT PRIMARY KEY,
                      request_json TEXT NOT NULL,
                      results_json TEXT NOT NULL,
                      created_at INTEGER NOT NULL
                    );

                    CREATE TABLE workspace_pins (
                      pin_id TEXT PRIMARY KEY,
                      label TEXT NOT NULL UNIQUE,
                      name TEXT NOT NULL,
                      place_id TEXT,
                      latitude REAL NOT NULL,
                      longitude REAL NOT NULL,
                      source TEXT NOT NULL,
                      created_at INTEGER NOT NULL,
                      FOREIGN KEY(place_id) REFERENCES places(place_id)
                    );

                    CREATE TABLE workspace_areas (
                      area_id TEXT PRIMARY KEY,
                      label TEXT NOT NULL,
                      geometry_json TEXT NOT NULL,
                      summary_json TEXT NOT NULL,
                      created_at INTEGER NOT NULL
                    );

                    CREATE TABLE routes (
                      route_id TEXT PRIMARY KEY,
                      request_key TEXT NOT NULL UNIQUE,
                      provider TEXT NOT NULL,
                      profile TEXT NOT NULL,
                      waypoints_json TEXT NOT NULL,
                      geometry_json TEXT NOT NULL,
                      summary_json TEXT NOT NULL,
                      source_version TEXT NOT NULL,
                      created_at INTEGER NOT NULL
                    );

                    CREATE TABLE osm_route_failures (
                      request_key TEXT PRIMARY KEY,
                      profile TEXT NOT NULL,
                      waypoints_json TEXT NOT NULL,
                      reason TEXT NOT NULL,
                      created_at INTEGER NOT NULL
                    );

                    CREATE TABLE workspace_state (
                      state_key TEXT PRIMARY KEY,
                      value_json TEXT NOT NULL,
                      updated_at INTEGER NOT NULL
                    );
                    """
                )
                self.connection.execute("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)", (1, int(time.time())))
            if 2 not in applied:
                self.connection.executescript(
                    """
                    CREATE TABLE provider_responses (
                      response_id TEXT PRIMARY KEY,
                      provider TEXT NOT NULL,
                      request_key TEXT NOT NULL,
                      request_json TEXT NOT NULL,
                      response_json TEXT NOT NULL,
                      received_at INTEGER NOT NULL
                    );
                    CREATE INDEX provider_responses_request ON provider_responses(provider, request_key, received_at DESC);
                    """
                )
                self.connection.execute("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)", (2, int(time.time())))
            if 3 not in applied:
                self.connection.executescript(
                    """
                    CREATE TABLE place_aliases (
                      source_place_id TEXT PRIMARY KEY,
                      canonical_place_id TEXT NOT NULL,
                      created_at INTEGER NOT NULL,
                      FOREIGN KEY(canonical_place_id) REFERENCES places(place_id)
                    );
                    CREATE INDEX place_aliases_canonical ON place_aliases(canonical_place_id);
                    """
                )
                self.connection.execute("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)", (3, int(time.time())))
            if 4 not in applied:
                self.connection.executescript(
                    "CREATE TABLE workspace_revision (id INTEGER PRIMARY KEY CHECK(id = 1), version INTEGER NOT NULL);"
                    "INSERT INTO workspace_revision(id, version) VALUES (1, 0);"
                )
                # Track even same-value/ABA edits, including edits through another SQLite connection.
                for table in ("workspace_pins", "workspace_areas", "workspace_state"):
                    for operation in ("INSERT", "UPDATE", "DELETE"):
                        self.connection.execute(
                            f"CREATE TRIGGER {table}_{operation.lower()}_revision AFTER {operation} ON {table} "
                            "BEGIN UPDATE workspace_revision SET version = version + 1 WHERE id = 1; END"
                        )
                self.connection.execute("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)", (4, int(time.time())))
            self._deduplicate_places()

    @staticmethod
    def _expiry(days: int) -> int:
        return int(time.time()) + days * 86_400

    def get_geocode(self, key: str) -> dict[str, Any] | None:
        with self.lock:
            row = self.connection.execute(
                "SELECT result_json FROM geocode_cache WHERE cache_key = ? AND expires_at > ?", (key, int(time.time()))
            ).fetchone()
        return json.loads(row["result_json"]) if row else None

    def put_geocode(self, key: str, result: dict[str, Any]) -> None:
        with self.lock, self.connection:
            self.connection.execute(
                "INSERT INTO geocode_cache(cache_key, result_json, expires_at) VALUES (?, ?, ?) "
                "ON CONFLICT(cache_key) DO UPDATE SET result_json=excluded.result_json, expires_at=excluded.expires_at",
                (key, json.dumps(result, separators=(",", ":")), self._expiry(CONFIG.geocode_ttl_days)),
            )

    def get_suggestions(self, prefix: str, country_code: str) -> list[dict[str, Any]] | None:
        with self.lock:
            row = self.connection.execute(
                "SELECT results_json FROM suggestions_cache WHERE prefix = ? AND country_code = ? AND expires_at > ?",
                (prefix, country_code, int(time.time())),
            ).fetchone()
        return json.loads(row["results_json"]) if row else None

    def put_suggestions(self, prefix: str, country_code: str, results: list[dict[str, Any]]) -> None:
        with self.lock, self.connection:
            self.connection.execute(
                "INSERT INTO suggestions_cache(prefix, country_code, results_json, expires_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(prefix, country_code) DO UPDATE SET results_json=excluded.results_json, expires_at=excluded.expires_at",
                (prefix, country_code, json.dumps(results, separators=(",", ":")), self._expiry(CONFIG.suggestion_ttl_days)),
            )

    def get_raw_tile(self, source: str, tile_id: str) -> dict[str, Any] | None:
        with self.lock:
            row = self.connection.execute(
                "SELECT payload, stats_json, expires_at FROM raw_tiles WHERE source = ? AND tile_id = ?", (source, tile_id)
            ).fetchone()
        if not row:
            return None
        return {
            "features": json.loads(zlib.decompress(row["payload"]).decode("utf-8")),
            "stats": json.loads(row["stats_json"]),
            "fresh": row["expires_at"] > int(time.time()),
        }

    def put_raw_tile(self, source: str, tile_id: str, features: list[dict[str, Any]], stats: dict[str, int], ttl_days: int | None = None) -> None:
        encoded = json.dumps(features, separators=(",", ":")).encode("utf-8")
        if len(encoded) >= MAX_TILE_PAYLOAD:
            return
        with self.lock, self.connection:
            self.connection.execute(
                "INSERT INTO raw_tiles(source, tile_id, payload, stats_json, expires_at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(source, tile_id) DO UPDATE SET payload=excluded.payload, stats_json=excluded.stats_json, expires_at=excluded.expires_at",
                (source, tile_id, zlib.compress(encoded), json.dumps(stats, separators=(",", ":")), self._expiry(ttl_days or CONFIG.tile_ttl_days)),
            )

    def get_place_lookup(self, lookup_key: str) -> list[dict[str, Any]] | None:
        with self.lock:
            row = self.connection.execute("SELECT results_json FROM place_lookups WHERE lookup_key = ?", (lookup_key,)).fetchone()
        return self._canonicalize_places(json.loads(row["results_json"])) if row else None

    def put_place_lookup(self, lookup_key: str, request: dict[str, Any], results: list[dict[str, Any]]) -> None:
        results = self._canonicalize_places(results)
        with self.lock, self.connection:
            self.connection.execute(
                "INSERT INTO place_lookups(lookup_key, request_json, results_json, created_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(lookup_key) DO UPDATE SET request_json=excluded.request_json, results_json=excluded.results_json, created_at=excluded.created_at",
                (lookup_key, json.dumps(request, separators=(",", ":")), json.dumps(results, separators=(",", ":")), int(time.time())),
            )

    def get_provider_response(self, provider: str, request_key: str) -> Any | None:
        with self.lock:
            row = self.connection.execute(
                "SELECT response_json FROM provider_responses WHERE provider = ? AND request_key = ? "
                "ORDER BY received_at DESC, response_id DESC LIMIT 1",
                (provider, request_key),
            ).fetchone()
        return json.loads(row["response_json"]) if row else None

    def provider_received_at(self, provider: str, request_key: str) -> int | None:
        with self.lock:
            row = self.connection.execute(
                "SELECT received_at FROM provider_responses WHERE provider = ? AND request_key = ? ORDER BY received_at DESC, response_id DESC LIMIT 1",
                (provider, request_key),
            ).fetchone()
        return int(row["received_at"]) if row else None

    def put_provider_response(self, provider: str, request_key: str, request: dict[str, Any], response: Any) -> None:
        response_id = f"provider-response-{uuid.uuid4().hex}"
        received_at = int(time.time())
        safe_request = redact_provider_payload(request)
        safe_response = redact_provider_payload(response)
        with self.lock, self.connection:
            self.connection.execute(
                "INSERT INTO provider_responses(response_id, provider, request_key, request_json, response_json, received_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (
                    response_id, provider, request_key,
                    json.dumps(safe_request, separators=(",", ":")),
                    json.dumps(safe_response, separators=(",", ":")), received_at,
                ),
            )
        if provider == "serpapi":
            archive_serpapi_response(response_id, request_key, safe_request, safe_response, received_at)

    def archive_serpapi_responses(self) -> None:
        with self.lock:
            rows = self.connection.execute(
                "SELECT response_id, request_key, request_json, response_json, received_at FROM provider_responses WHERE provider = 'serpapi'"
            ).fetchall()
        for row in rows:
            archive_serpapi_response(
                row["response_id"], row["request_key"], json.loads(row["request_json"]),
                json.loads(row["response_json"]), row["received_at"],
            )

    @staticmethod
    def _place_from_row(row: sqlite3.Row, include_payload: bool = False) -> dict[str, Any]:
        place = {
            "id": row["place_id"], "provider": row["provider"], "providerId": row["provider_id"],
            "name": row["name"], "address": row["address"], "countryCode": row["country_code"],
            "lat": row["latitude"], "lon": row["longitude"], "bbox": json.loads(row["bbox_json"]),
        }
        if include_payload:
            place["providerPayload"] = json.loads(row["provider_payload_json"])
        return place

    @staticmethod
    def _same_place_name(first: str, second: str) -> bool:
        if first == second:
            return True
        shorter, longer = sorted((first, second), key=len)
        short_words = shorter.split()
        if len(short_words) < 2 or not longer.startswith(shorter + " "):
            return False
        return longer[len(shorter) + 1:].split()[0] in {
            "society", "residency", "residential", "apartment", "apartments", "housing", "enclave", "colony",
        }

    @staticmethod
    def _normalized_place_name(value: str) -> str:
        return " ".join(unicodedata.normalize("NFKC", value).strip().casefold().split())

    @classmethod
    def _same_place(cls, row: sqlite3.Row, place: dict[str, Any]) -> bool:
        if not cls._same_place_name(row["normalized_name"], cls._normalized_place_name(place["name"])):
            return False
        latitude = float(place["lat"])
        longitude = float(place["lon"])
        north_south = (float(row["latitude"]) - latitude) * 111_320
        east_west = (float(row["longitude"]) - longitude) * 111_320 * math.cos(math.radians((float(row["latitude"]) + latitude) / 2))
        return math.hypot(north_south, east_west) <= 35

    def _canonical_place(self, place_id: str, include_payload: bool = False) -> dict[str, Any] | None:
        alias = self.connection.execute(
            "SELECT canonical_place_id FROM place_aliases WHERE source_place_id = ?", (place_id,)
        ).fetchone()
        canonical_id = alias["canonical_place_id"] if alias else place_id
        row = self.connection.execute(
            "SELECT place_id, provider, provider_id, name, address, country_code, latitude, longitude, bbox_json, provider_payload_json "
            "FROM places WHERE place_id = ?", (canonical_id,)
        ).fetchone()
        return self._place_from_row(row, include_payload) if row else None

    def _nearby_place_rows(self, place: dict[str, Any]) -> list[sqlite3.Row]:
        latitude = float(place["lat"])
        longitude = float(place["lon"])
        latitude_delta = 35 / 111_320
        longitude_delta = latitude_delta / max(0.1, abs(math.cos(math.radians(latitude))))
        return self.connection.execute(
            "SELECT place_id, provider, provider_id, name, normalized_name, address, country_code, latitude, longitude, bbox_json, provider_payload_json "
            "FROM places WHERE place_id != ? AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?",
            (place["id"], latitude - latitude_delta, latitude + latitude_delta, longitude - longitude_delta, longitude + longitude_delta),
        ).fetchall()

    def _merge_place_alias(self, source_place_id: str, canonical_place_id: str) -> None:
        if source_place_id == canonical_place_id:
            return
        self.connection.execute(
            "INSERT INTO place_aliases(source_place_id, canonical_place_id, created_at) VALUES (?, ?, ?) "
            "ON CONFLICT(source_place_id) DO UPDATE SET canonical_place_id=excluded.canonical_place_id",
            (source_place_id, canonical_place_id, int(time.time())),
        )
        self.connection.execute("UPDATE workspace_pins SET place_id = ? WHERE place_id = ?", (canonical_place_id, source_place_id))
        self.connection.execute("DELETE FROM places WHERE place_id = ?", (source_place_id,))

    def _deduplicate_places(self) -> None:
        rows = self.connection.execute(
            "SELECT place_id, provider, provider_id, name, normalized_name, address, country_code, latitude, longitude, bbox_json, provider_payload_json "
            "FROM places ORDER BY created_at, place_id"
        ).fetchall()
        canonicals: list[sqlite3.Row] = []
        for row in rows:
            candidate = self._place_from_row(row)
            match = next((current for current in canonicals if self._same_place(current, candidate)), None)
            if match:
                self._merge_place_alias(row["place_id"], match["place_id"])
            else:
                canonicals.append(row)

    def _canonicalize_places(self, places: list[dict[str, Any]]) -> list[dict[str, Any]]:
        resolved: list[dict[str, Any]] = []
        seen: set[str] = set()
        with self.lock:
            for place in places:
                canonical = self._canonical_place(str(place.get("id") or "")) if isinstance(place, dict) else None
                value = canonical or place
                if not isinstance(value, dict) or not isinstance(value.get("id"), str) or value["id"] in seen:
                    continue
                seen.add(value["id"])
                resolved.append(value)
        return resolved

    def put_places(self, places: list[dict[str, Any]]) -> list[dict[str, Any]]:
        now = int(time.time())
        canonical_places: list[dict[str, Any]] = []
        seen: set[str] = set()
        with self.lock, self.connection:
            for place in places:
                canonical = self._canonical_place(place["id"], include_payload=True)
                if canonical is None:
                    match = next((row for row in self._nearby_place_rows(place) if self._same_place(row, place)), None)
                    if match:
                        self._merge_place_alias(place["id"], match["place_id"])
                        canonical = self._canonical_place(match["place_id"], include_payload=True)
                if canonical is not None:
                    if canonical["id"] not in seen:
                        seen.add(canonical["id"])
                        canonical_places.append(canonical)
                    continue
                self.connection.execute(
                    "INSERT INTO places(place_id, provider, provider_id, name, normalized_name, address, country_code, latitude, longitude, bbox_json, provider_payload_json, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(place_id) DO UPDATE SET name=excluded.name, normalized_name=excluded.normalized_name, address=excluded.address, country_code=excluded.country_code, latitude=excluded.latitude, longitude=excluded.longitude, bbox_json=excluded.bbox_json, provider_payload_json=excluded.provider_payload_json, updated_at=excluded.updated_at",
                    (
                        place["id"], place["provider"], place["providerId"], place["name"], normalize_query(place["name"]), place["address"],
                        place["countryCode"], place["lat"], place["lon"], json.dumps(place["bbox"], separators=(",", ":")),
                        json.dumps(place.get("providerPayload") or {}, separators=(",", ":")), now, now,
                    ),
                )
                if place["id"] not in seen:
                    seen.add(place["id"])
                    canonical_places.append(place)
        return canonical_places

    def get_place(self, place_id: str, include_payload: bool = False) -> dict[str, Any] | None:
        with self.lock:
            return self._canonical_place(place_id, include_payload=include_payload)

    def search_places(self, normalized_query: str, limit: int | None = None, provider: str = "", country_code: str = "", include_payload: bool = False) -> list[dict[str, Any]]:
        """Return stored places whose normalized name contains the query substring."""
        pattern = f"%{normalized_query}%"
        statement = (
            "SELECT place_id, provider, provider_id, name, address, country_code, latitude, longitude, bbox_json, provider_payload_json "
            "FROM places WHERE normalized_name LIKE ?"
        )
        parameters: list[Any] = [pattern]
        if provider:
            statement += " AND provider = ?"
            parameters.append(provider)
        if country_code:
            statement += " AND country_code = ?"
            parameters.append(country_code.upper())
        statement += " ORDER BY updated_at DESC, place_id"
        if limit is not None:
            statement += " LIMIT ?"
            parameters.append(limit)
        with self.lock:
            rows = self.connection.execute(statement, parameters).fetchall()
        return [self._place_from_row(row, include_payload=include_payload) for row in rows]

    def list_places_in_bounds(self, west: float, south: float, east: float, north: float, limit: int = 1_000) -> tuple[list[dict[str, Any]], bool]:
        base = (
            "SELECT place_id, provider, provider_id, name, address, country_code, latitude, longitude, bbox_json, provider_payload_json "
            "FROM places WHERE latitude BETWEEN ? AND ? AND "
        )
        parameters: list[Any] = [south, north]
        if west <= east:
            statement = base + "longitude BETWEEN ? AND ? ORDER BY updated_at DESC, place_id LIMIT ?"
            parameters.extend([west, east, limit + 1])
        else:
            statement = base + "(longitude >= ? OR longitude <= ?) ORDER BY updated_at DESC, place_id LIMIT ?"
            parameters.extend([west, east, limit + 1])
        with self.lock:
            rows = self.connection.execute(statement, parameters).fetchall()
        return [self._place_from_row(row) for row in rows[:limit]], len(rows) > limit

    def list_pins(self) -> list[dict[str, Any]]:
        with self.lock:
            rows = self.connection.execute("SELECT pin_id, label, name, place_id, latitude, longitude, source, created_at FROM workspace_pins ORDER BY created_at, pin_id").fetchall()
        return [{"id": row["pin_id"], "label": row["label"], "name": row["name"], "placeId": row["place_id"], "lat": row["latitude"], "lon": row["longitude"], "source": row["source"], "createdAt": row["created_at"]} for row in rows]

    def add_pin(self, name: str, lat: float, lon: float, place_id: str | None, source: str) -> dict[str, Any]:
        with self._workspace_transaction():
            count = self.connection.execute("SELECT COUNT(*) AS count FROM workspace_pins").fetchone()["count"]
            label = pin_label(count)
            pin_id = f"pin-{uuid.uuid4().hex}"
            created_at = int(time.time())
            self.connection.execute(
                "INSERT INTO workspace_pins(pin_id, label, name, place_id, latitude, longitude, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (pin_id, label, name[:160], place_id, lat, lon, source, created_at),
            )
        return {"id": pin_id, "label": label, "name": name[:160], "placeId": place_id, "lat": lat, "lon": lon, "source": source, "createdAt": created_at}

    def delete_pin(self, pin_id: str) -> bool:
        with self._workspace_transaction():
            deleted = self.connection.execute("DELETE FROM workspace_pins WHERE pin_id = ?", (pin_id,)).rowcount > 0
            if not deleted:
                return False
            rows = self.connection.execute("SELECT area_id, summary_json FROM workspace_areas").fetchall()
            for row in rows:
                try:
                    summary = json.loads(row["summary_json"])
                except (TypeError, json.JSONDecodeError):
                    summary = {}
                pin_ids = summary.get("pinIds") if isinstance(summary, dict) else []
                if isinstance(pin_ids, list) and pin_id in pin_ids:
                    summary["invalid"] = True
                    summary["invalidReason"] = "A referenced pin was removed."
                    self.connection.execute(
                        "UPDATE workspace_areas SET summary_json = ? WHERE area_id = ?",
                        (json.dumps(summary, separators=(",", ":")), row["area_id"]),
                    )
            return True

    def list_areas(self) -> list[dict[str, Any]]:
        with self.lock:
            rows = self.connection.execute("SELECT area_id, label, geometry_json, summary_json, created_at FROM workspace_areas ORDER BY created_at, area_id").fetchall()
        return [{"id": row["area_id"], "label": row["label"], "geometry": json.loads(row["geometry_json"]), "summary": json.loads(row["summary_json"]), "createdAt": row["created_at"]} for row in rows]

    def add_area(self, label: str, geometry: dict[str, Any], summary: dict[str, Any]) -> dict[str, Any]:
        area_id = f"area-{uuid.uuid4().hex}"
        created_at = int(time.time())
        with self._workspace_transaction():
            self.connection.execute(
                "INSERT INTO workspace_areas(area_id, label, geometry_json, summary_json, created_at) VALUES (?, ?, ?, ?, ?)",
                (area_id, label[:160], json.dumps(geometry, separators=(",", ":")), json.dumps(summary, separators=(",", ":")), created_at),
            )
        return {"id": area_id, "label": label[:160], "geometry": geometry, "summary": summary, "createdAt": created_at}

    def update_area(self, area_id: str, label: str, geometry: dict[str, Any], summary: dict[str, Any]) -> dict[str, Any] | None:
        with self._workspace_transaction():
            row = self.connection.execute("SELECT created_at FROM workspace_areas WHERE area_id = ?", (area_id,)).fetchone()
            if not row:
                return None
            self.connection.execute(
                "UPDATE workspace_areas SET label = ?, geometry_json = ?, summary_json = ? WHERE area_id = ?",
                (label[:160], json.dumps(geometry, separators=(",", ":")), json.dumps(summary, separators=(",", ":")), area_id),
            )
        return {"id": area_id, "label": label[:160], "geometry": geometry, "summary": summary, "createdAt": row["created_at"]}

    def delete_area(self, area_id: str) -> bool:
        with self._workspace_transaction():
            return self.connection.execute("DELETE FROM workspace_areas WHERE area_id = ?", (area_id,)).rowcount > 0

    def get_route(self, request_key: str) -> dict[str, Any] | None:
        with self.lock:
            row = self.connection.execute("SELECT route_id, provider, profile, waypoints_json, geometry_json, summary_json, source_version, created_at FROM routes WHERE request_key = ?", (request_key,)).fetchone()
        if not row:
            return None
        return {"id": row["route_id"], "provider": row["provider"], "profile": row["profile"], "waypoints": json.loads(row["waypoints_json"]), "geometry": json.loads(row["geometry_json"]), "summary": json.loads(row["summary_json"]), "sourceVersion": row["source_version"], "createdAt": row["created_at"], "stored": True}

    def get_route_by_id(self, route_id: str) -> dict[str, Any] | None:
        with self.lock:
            row = self.connection.execute("SELECT route_id, provider, profile, waypoints_json, geometry_json, summary_json, source_version, created_at FROM routes WHERE route_id = ?", (route_id,)).fetchone()
        if not row:
            return None
        return {"id": row["route_id"], "provider": row["provider"], "profile": row["profile"], "waypoints": json.loads(row["waypoints_json"]), "geometry": json.loads(row["geometry_json"]), "summary": json.loads(row["summary_json"]), "sourceVersion": row["source_version"], "createdAt": row["created_at"], "stored": True}

    def put_route(self, request_key: str, profile: str, waypoints: list[list[float]], geometry: dict[str, Any], summary: dict[str, Any], provider: str = "public-osrm", source_version: str = "unknown-public") -> dict[str, Any]:
        route_id = f"route-{uuid.uuid4().hex}"
        created_at = int(time.time())
        with self.lock, self.connection:
            self.connection.execute(
                "INSERT INTO routes(route_id, request_key, provider, profile, waypoints_json, geometry_json, summary_json, source_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (route_id, request_key, provider, profile, json.dumps(waypoints, separators=(",", ":")), json.dumps(geometry, separators=(",", ":")), json.dumps(summary, separators=(",", ":")), source_version, created_at),
            )
        return {"id": route_id, "provider": provider, "profile": profile, "waypoints": waypoints, "geometry": geometry, "summary": summary, "sourceVersion": source_version, "createdAt": created_at, "stored": False}

    def put_osm_route_failure(self, request_key: str, profile: str, waypoints: list[list[float]], reason: str) -> None:
        with self.lock, self.connection:
            self.connection.execute(
                "INSERT INTO osm_route_failures(request_key, profile, waypoints_json, reason, created_at) VALUES (?, ?, ?, ?, ?) "
                "ON CONFLICT(request_key) DO UPDATE SET reason=excluded.reason, created_at=excluded.created_at",
                (request_key, profile, json.dumps(waypoints, separators=(",", ":")), reason[:160], int(time.time())),
            )

    def get_workspace_state(self) -> dict[str, Any]:
        with self.lock:
            row = self.connection.execute("SELECT value_json FROM workspace_state WHERE state_key = 'active'").fetchone()
        return json.loads(row["value_json"]) if row else {}

    def put_workspace_state(self, value: dict[str, Any]) -> None:
        with self._workspace_transaction():
            self.connection.execute(
                "INSERT INTO workspace_state(state_key, value_json, updated_at) VALUES ('active', ?, ?) "
                "ON CONFLICT(state_key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at",
                (json.dumps(value, separators=(",", ":")), int(time.time())),
            )

    def clear_workspace(self) -> None:
        with self._workspace_transaction():
            self.connection.execute("DELETE FROM workspace_pins")
            self.connection.execute("DELETE FROM workspace_areas")
            self.connection.execute("DELETE FROM workspace_state")

    @contextmanager
    def _workspace_transaction(self, write: bool = True) -> Iterator[None]:
        """Keep checkpoint checks and local writes atomic, without locking during provider calls."""
        with self.lock:
            if self.connection.in_transaction:
                yield
            else:
                with self.connection:
                    self.connection.execute("BEGIN IMMEDIATE" if write else "BEGIN")
                    yield

    def workspace_snapshot(self) -> dict[str, Any]:
        with self._workspace_transaction(write=False):
            return {"pins": self.list_pins(), "areas": self.list_areas(), "state": self.get_workspace_state()}

    def capture_workspace(self) -> dict[str, Any]:
        with self._workspace_transaction(write=False):
            workspace = self.workspace_snapshot()
            version = self.connection.execute("SELECT version FROM workspace_revision WHERE id = 1").fetchone()["version"]
            return {"workspace": workspace, "version": version, "fingerprint": request_hash(workspace)}

    def _check_workspace(self, expected: dict[str, Any]) -> dict[str, Any]:
        current = self.capture_workspace()
        if any(current[key] != expected.get(key) for key in ("version", "fingerprint")):
            raise ServiceError("The workspace changed after the agent snapshot. Later edits were preserved; automatic restore is unsafe.", 409)
        return current

    def mutate_workspace(self, expected: dict[str, Any], mutation: Callable[[], Any]) -> tuple[Any, dict[str, Any]]:
        with self._workspace_transaction():
            self._check_workspace(expected)
            result = mutation()
            return result, self.capture_workspace()

    def restore_workspace(self, before: dict[str, Any], expected: dict[str, Any]) -> dict[str, Any]:
        """Restore an in-process checkpoint, never provider caches, places, or reusable routes."""
        try:
            with self._workspace_transaction():
                current = self._check_workspace(expected)
                workspace = before["workspace"]
                if current["workspace"] == workspace:
                    return current
                self.connection.execute("DELETE FROM workspace_pins")
                self.connection.execute("DELETE FROM workspace_areas")
                self.connection.execute("DELETE FROM workspace_state WHERE state_key = 'active'")
                for pin in workspace["pins"]:
                    self.connection.execute(
                        "INSERT INTO workspace_pins(pin_id, label, name, place_id, latitude, longitude, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                        (pin["id"], pin["label"], pin["name"], pin["placeId"], pin["lat"], pin["lon"], pin["source"], pin["createdAt"]),
                    )
                for area in workspace["areas"]:
                    self.connection.execute(
                        "INSERT INTO workspace_areas(area_id, label, geometry_json, summary_json, created_at) VALUES (?, ?, ?, ?, ?)",
                        (area["id"], area["label"], json.dumps(area["geometry"], separators=(",", ":")), json.dumps(area["summary"], separators=(",", ":")), area["createdAt"]),
                    )
                self.put_workspace_state(workspace["state"])
                return self.capture_workspace()
        except (KeyError, TypeError, sqlite3.IntegrityError) as error:
            raise ServiceError("The saved workspace can no longer be restored safely. No restore was applied.", 409) from error

    def close(self) -> None:
        with self.lock:
            self.connection.close()


CACHE = Cache(CONFIG.database_path)


def normalize_query(value: str) -> str:
    return " ".join(unicodedata.normalize("NFKC", value).strip().casefold().split())


def pin_label(index: int) -> str:
    """Return compact stable workspace labels: A..Z, AA..AZ, and so on."""
    value = index + 1
    label = ""
    while value:
        value, remainder = divmod(value - 1, 26)
        label = chr(65 + remainder) + label
    return label


def valid_coordinate(lon: Any, lat: Any) -> tuple[float, float] | None:
    try:
        longitude = float(lon)
        latitude = float(lat)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(longitude) or not math.isfinite(latitude) or not -180 <= longitude <= 180 or not -90 <= latitude <= 90:
        return None
    return longitude, latitude


def request_hash(value: dict[str, Any]) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def serp_request_key(params: dict[str, Any]) -> str:
    """Return a stable local key without ever including the SerpApi credential."""
    safe_params = {key: value for key, value in params.items() if key.lower() != "api_key"}
    if "q" in safe_params:
        safe_params["q"] = normalize_query(str(safe_params["q"]))
    return request_hash({"provider": "serpapi", "params": safe_params})


def redact_provider_payload(value: Any) -> Any:
    """Preserve useful provider data without retaining credentials in local storage."""
    if isinstance(value, str):
        if CONFIG.serp_api_key:
            value = value.replace(CONFIG.serp_api_key, "[redacted]")
        value = re.sub(r"(?i)((?:api[_-]?key|access[_-]?token|authorization|token)\s*[:=]\s*)[^\s&,;]+", r"\1[redacted]", value)
    if isinstance(value, str) and value.startswith(("http://", "https://")):
        parsed = urllib.parse.urlsplit(value)
        params = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
        safe_query = urllib.parse.urlencode([
            (name, "[redacted]" if name.lower() in {"api_key", "authorization", "token", "access_token"} else content)
            for name, content in params
        ])
        return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, parsed.path, safe_query, parsed.fragment))
    if isinstance(value, list):
        return [redact_provider_payload(item) for item in value]
    if not isinstance(value, dict):
        return value
    result: dict[str, Any] = {}
    for key, item in value.items():
        if key.lower() in {"api_key", "authorization", "token", "access_token"}:
            result[key] = "[redacted]"
            continue
        result[key] = redact_provider_payload(item)
    return result


def archive_serpapi_response(response_id: str, request_key: str, request: Any, response: Any, received_at: int) -> None:
    """Write an inspectable local archive for each network-fetched SerpApi response."""
    path = SERPAPI_ARCHIVE_DIR / f"{response_id}.json"
    if path.exists():
        return
    temporary = path.with_suffix(".tmp")
    record = {
        "responseId": response_id,
        "requestKey": request_key,
        "receivedAt": datetime.fromtimestamp(received_at, timezone.utc).isoformat(),
        "request": request,
        "response": response,
    }
    try:
        SERPAPI_ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
        temporary.replace(path)
    except OSError as error:
        print(f"[serpapi] Could not archive response {response_id}: {error}")


CACHE.archive_serpapi_responses()


def fetch_serp_response(params: dict[str, Any]) -> Any:
    """Read a complete cached SerpApi response before issuing a billable request."""
    request = {key: value for key, value in params.items() if key.lower() != "api_key"}
    key = serp_request_key(request)

    def task() -> Any:
        stored = CACHE.get_provider_response("serpapi", key)
        if stored is not None:
            validate_serp_payload(stored)
            return redact_provider_payload(stored)
        if not CONFIG.serp_api_key:
            raise ServiceError("SerpApi is not configured and this request is not stored locally.", 503)
        payload = fetch_serp_json(
            "https://serpapi.com/search.json?" + urllib.parse.urlencode({**request, "api_key": CONFIG.serp_api_key}),
        )
        validate_serp_payload(payload)
        CACHE.put_provider_response("serpapi", key, request, payload)
        return redact_provider_payload(payload)

    return SERP_QUEUE.run(task)


def validate_serp_payload(payload: Any) -> None:
    if not isinstance(payload, dict) or not isinstance(payload.get("search_metadata", {}), dict):
        raise ServiceError("SerpApi returned an invalid search response.", 503)
    error = payload.get("error")
    status = payload.get("search_metadata", {}).get("status")
    if error or status not in {None, "Success"}:
        if isinstance(error, str) and "hasn't returned any results" in error.casefold():
            return
        raise ServiceError("SerpApi could not complete this search. Check provider configuration and quota, then retry.", 503)


def fetch_serp_json(url: str) -> dict[str, Any]:
    """Read only a fixed SerpApi endpoint with bounded JSON and safe errors."""
    request = urllib.request.Request(url, headers={"Accept": "application/json", "Accept-Encoding": "identity"})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            final = urllib.parse.urlsplit(response.geturl())
            if final.scheme != "https" or final.hostname != "serpapi.com" or final.username or final.password:
                raise ServiceError("SerpApi redirected to an unsupported endpoint.", 503)
            raw = response.read(4 * 1024 * 1024 + 1)
            if len(raw) > 4 * 1024 * 1024:
                raise ServiceError("SerpApi response exceeded the 4 MB limit.", 503)
            payload = json.loads(raw.decode("utf-8"))
    except urllib.error.HTTPError as error:
        if error.code == 429:
            raise ServiceError("SerpApi is rate limiting requests.", 503, retry_after_seconds(error.headers.get("Retry-After"))) from None
        raise ServiceError(f"SerpApi returned HTTP {error.code}.", 503) from None
    except (urllib.error.URLError, OSError, UnicodeError, ValueError):
        raise ServiceError("SerpApi returned invalid data or could not be reached.", 503) from None
    if not isinstance(payload, dict):
        raise ServiceError("SerpApi returned an invalid search response.", 503)
    return payload


def search_serp_web(query: str, engine: str, country_code: str) -> dict[str, Any]:
    """Expose cited web research separately from geographic place discovery."""
    if engine not in {"google", "google_news", "google_scholar"} or not isinstance(query, str) or not 2 <= len(query.strip()) <= 500:
        raise ServiceError("Web research requires a supported engine and a query of 2-500 characters.", 400)
    params = {"engine": engine, "q": query.strip(), "hl": "en"}
    if engine != "google_scholar" and country_param(country_code):
        params["gl"] = country_param(country_code)
    if engine == "google_scholar":
        params["num"] = "8"
    request_key = serp_request_key(params)
    stored = CACHE.provider_received_at("serpapi", request_key) is not None
    payload = fetch_serp_response(params)
    validate_serp_payload(payload)
    received = CACHE.provider_received_at("serpapi", request_key)
    results: list[dict[str, Any]] = []
    seen: set[str] = set()

    def text(value: Any, maximum: int) -> str:
        value = value if isinstance(value, str) else ""
        if CONFIG.serp_api_key:
            value = value.replace(CONFIG.serp_api_key, "[redacted]")
        return re.sub(r"(?i)(?:api[_-]?key|access[_-]?token|authorization|token)\s*[:=]\s*[^\s&,;]+", "[redacted]", value)[:maximum]

    def add(item: Any, kind: str) -> None:
        if not isinstance(item, dict) or len(results) >= 8:
            return
        url = item.get("link")
        title = text(item.get("title"), 200)
        if not title or not isinstance(url, str):
            return
        try:
            url = validate_web_url(url)
        except ServiceError:
            return
        if url in seen:
            return
        seen.add(url)
        source = item.get("source")
        publisher = source.get("name", "") if isinstance(source, dict) else source
        publication = item.get("publication_info")
        date = item.get("iso_date") or item.get("date")
        results.append({
            "title": title, "url": url, "snippet": text(item.get("snippet") or item.get("description"), 1200),
            "publisher": text(publisher, 160), "date": text(date, 100), "kind": kind,
            "publication": text(publication.get("summary", "") if isinstance(publication, dict) else "", 300),
        })

    root = payload.get("news_results" if engine == "google_news" else "organic_results", [])
    if not isinstance(root, list):
        raise ServiceError("SerpApi returned an invalid web result list.", 503)
    for item in root[:40]:
        add(item, "news" if engine == "google_news" else "publication" if engine == "google_scholar" else "web")
        if engine == "google_news" and isinstance(item, dict) and isinstance(item.get("stories"), list):
            for story in item["stories"][:8]:
                add(story, "news")
    if engine == "google":
        graph = payload.get("knowledge_graph")
        if isinstance(graph, dict) and isinstance(graph.get("source"), dict):
            add({"title": graph.get("title"), "link": graph["source"].get("link"), "description": graph.get("description"), "source": graph["source"].get("name")}, "knowledge-source")
        answer = payload.get("answer_box")
        if isinstance(answer, dict):
            add(answer, "answer-source")
    return {
        "results": results, "provider": "serpapi", "engine": engine, "query": params["q"], "stored": stored,
        "retrievedAt": datetime.fromtimestamp(received, timezone.utc).isoformat() if received else None,
        "caveat": "Search snippets are discovery evidence, not verified numeric observations or a population dataset. Cached searches may be historical; publication date, dataset year, and retrieval time are distinct.",
    }


def country_param(value: str) -> str:
    return value.lower() if re.fullmatch(r"[A-Za-z]{2}", value or "") else ""


def retry_after_seconds(value: str | None, fallback: int = 60) -> int:
    try:
        return max(1, int(value or ""))
    except ValueError:
        try:
            retry_at = parsedate_to_datetime(value or "")
            if retry_at.tzinfo is None:
                retry_at = retry_at.replace(tzinfo=timezone.utc)
            return max(1, math.ceil((retry_at - datetime.now(timezone.utc)).total_seconds()))
        except (TypeError, ValueError):
            return fallback


def fetch_json(url: str, headers: dict[str, str], timeout: float, method: str = "GET", body: bytes | None = None) -> Any:
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        if error.code == 429:
            raise ServiceError(
                f"{urllib.parse.urlparse(url).netloc} is rate limiting requests.",
                503,
                retry_after_seconds(error.headers.get("Retry-After")),
            ) from error
        raise ServiceError(f"{urllib.parse.urlparse(url).netloc} returned {error.code}") from error
    except (urllib.error.URLError, TimeoutError) as error:
        reason = getattr(error, "reason", str(error))
        raise ServiceError(f"Could not reach {urllib.parse.urlparse(url).netloc}: {reason}") from error


def location_result(item: dict[str, Any]) -> dict[str, Any] | None:
    try:
        lat = float(item["lat"])
        lon = float(item["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    bbox_raw = item.get("boundingbox") or []
    try:
        south, north, west, east = (float(value) for value in bbox_raw[:4])
        bbox = [west, south, east, north]
    except (TypeError, ValueError):
        bbox = [lon - 0.03, lat - 0.03, lon + 0.03, lat + 0.03]
    address = item.get("address") or {}
    name = item.get("display_name") or ""
    short_name = item.get("name") or address.get("city") or address.get("town") or address.get("village") or name.split(",")[0]
    return {
        "id": f"{item.get('osm_type') or 'place'}:{item.get('osm_id') or f'{lat},{lon}'}",
        "name": name,
        "shortName": short_name,
        "country": address.get("country") or "",
        "countryCode": (address.get("country_code") or "").upper(),
        "lat": lat,
        "lon": lon,
        "bbox": bbox,
    }


def nominatim_search(query: str, country_code: str, limit: int) -> list[dict[str, Any]]:
    def task() -> list[dict[str, Any]]:
        params = {"q": query, "format": "jsonv2", "addressdetails": "1", "limit": str(limit), "featuretype": "city"}
        country = country_param(country_code)
        if country and "," not in query:
            params["countrycodes"] = country
        url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
        payload = fetch_json(url, {"User-Agent": CONFIG.user_agent, "Referer": "http://localhost/", "Accept": "application/json"}, 12)
        return [result for item in payload for result in [location_result(item)] if result]

    return NOMINATIM_QUEUE.run(task)


def resolve_location(query: str, country_code: str) -> dict[str, Any] | None:
    normalized = normalize_query(query)
    country = country_param(country_code)
    key = f"{normalized}|{country}"
    place_name = normalized.split(",", 1)[0].strip()
    exact = [place for place in saved_place_matches(query, country_code) if normalize_query(place["name"]) == place_name]
    if len(exact) == 1:
        result = map_location(exact[0], cached=True)
        CACHE.put_geocode(key, result)
        return result
    cached = CACHE.get_geocode(key)
    if cached:
        return {**cached, "cached": True}
    results = nominatim_search(query, country, 1)
    if not results:
        discovery = lookup_places(query, country_code, None, None)
        results = [map_location(CACHE.get_place(place["id"], include_payload=True) or place, cached=discovery["stored"]) for place in discovery["results"]]
        if not results:
            return None
    CACHE.put_geocode(key, results[0])
    return {**results[0], "cached": bool(results[0].get("cached"))}


def suggest_locations(query: str, country_code: str) -> list[dict[str, Any]]:
    prefix = normalize_query(query)
    if len(prefix) < 2:
        return []
    country = country_param(country_code)
    cached = CACHE.get_suggestions(prefix, country)
    if cached is not None:
        return cached
    results = nominatim_search(query, country, 6)
    CACHE.put_suggestions(prefix, country, results)
    return results


def resolve_agent_city(query: str, country_code: str) -> dict[str, Any] | None:
    """Return a city only when its short OSM name uniquely matches the request."""
    candidates = suggest_locations(query, country_code)
    city_name = normalize_query(query).split(",", 1)[0]
    exact = [
        candidate for candidate in candidates
        if normalize_query(str(candidate.get("shortName") or "")) == city_name
    ]
    return exact[0] if len(exact) == 1 else None


def place_from_nominatim(item: dict[str, Any]) -> dict[str, Any] | None:
    location = location_result(item)
    if not location:
        return None
    osm_type = str(item.get("osm_type") or "place")
    osm_id = str(item.get("osm_id") or f"{location['lat']:.6f},{location['lon']:.6f}")
    address = item.get("address") or {}
    name = str(item.get("name") or location["shortName"] or location["name"]).strip()
    if not name:
        return None
    return {
        "id": f"openstreetmap:{osm_type}:{osm_id}",
        "provider": "openstreetmap",
        "providerId": f"{osm_type}:{osm_id}",
        "name": name[:160],
        "address": str(item.get("display_name") or "")[:500],
        "countryCode": str(address.get("country_code") or "").upper(),
        "lat": location["lat"],
        "lon": location["lon"],
        "bbox": location["bbox"],
        "providerPayload": redact_provider_payload(item),
    }


def search_nominatim_places(query: str, country_code: str, lat: float | None, lon: float | None) -> list[dict[str, Any]]:
    def task() -> list[dict[str, Any]]:
        params = {"q": query, "format": "jsonv2", "addressdetails": "1", "limit": "8"}
        country = country_param(country_code)
        if country and "," not in query:
            params["countrycodes"] = country
        if lat is not None and lon is not None:
            # A viewbox biases relevance without excluding a query that names another city.
            params["viewbox"] = f"{lon - 0.25:.4f},{lat + 0.25:.4f},{lon + 0.25:.4f},{lat - 0.25:.4f}"
        url = "https://nominatim.openstreetmap.org/search?" + urllib.parse.urlencode(params)
        payload = fetch_json(url, {"User-Agent": CONFIG.user_agent, "Referer": "http://localhost/", "Accept": "application/json"}, 12)
        return [place for item in payload if isinstance(item, dict) for place in [place_from_nominatim(item)] if place]

    return NOMINATIM_QUEUE.run(task)


def place_from_serp(item: dict[str, Any]) -> dict[str, Any] | None:
    coordinates = item.get("gps_coordinates") or {}
    point = valid_coordinate(coordinates.get("longitude"), coordinates.get("latitude"))
    if not point:
        return None
    lon, lat = point
    place_id = str(item.get("place_id") or item.get("data_cid") or item.get("data_id") or "").strip()
    if not place_id:
        place_id = f"{lat:.6f},{lon:.6f}:{normalize_query(str(item.get('title') or 'place'))}"
    name = str(item.get("title") or "").strip()
    if not name:
        return None
    return {
        "id": f"serpapi-google-maps:{place_id}",
        "provider": "serpapi-google-maps",
        "providerId": place_id,
        "name": name[:160],
        "address": str(item.get("address") or "")[:500],
        "countryCode": str(item.get("country_code") or "").upper(),
        "lat": lat,
        "lon": lon,
        "bbox": [lon, lat, lon, lat],
        "providerPayload": redact_provider_payload(item),
    }


def search_serp_places(query: str, lat: float | None, lon: float | None, country_code: str) -> list[dict[str, Any]]:
    def task() -> list[dict[str, Any]]:
        params = {"engine": "google_maps", "type": "search", "q": query, "hl": "en"}
        if lat is not None and lon is not None:
            params["ll"] = f"@{lat:.6f},{lon:.6f},14z"
        if country_param(country_code):
            params["gl"] = country_param(country_code)
        payload = fetch_serp_response(params)
        if not isinstance(payload, dict):
            raise ServiceError("The map provider returned an invalid response.", 503)
        metadata = payload.get("search_metadata") or {}
        if not isinstance(metadata, dict) or metadata.get("status") not in {None, "Success"}:
            raise ServiceError(str(payload.get("error") or "The map provider could not resolve this place."), 503)
        candidates: list[dict[str, Any]] = []
        primary = payload.get("place_results")
        if isinstance(primary, dict):
            candidates.append(primary)
        candidates.extend(item for item in payload.get("local_results") or [] if isinstance(item, dict))
        places: list[dict[str, Any]] = []
        seen: set[str] = set()
        for candidate in candidates:
            place = place_from_serp(candidate)
            if place and place["id"] not in seen:
                seen.add(place["id"])
                places.append(place)
        return CACHE.put_places(places)

    return SERP_PLACE_QUEUE.run(task)


def public_place(place: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in place.items() if key != "providerPayload"}


def saved_place_matches(query: str, country_code: str) -> list[dict[str, Any]]:
    parts = [normalize_query(part) for part in query.split(",") if part.strip()]
    if not parts or len(parts[0]) < 2:
        return []
    country = country_param(country_code).upper() if len(parts) == 1 else ""
    matches = []
    for place in CACHE.search_places(parts[0], include_payload=True):
        if country and place.get("countryCode") and place["countryCode"].upper() != country:
            continue
        payload = place.get("providerPayload") or {}
        address = payload.get("address")
        country_name = address.get("country", "") if isinstance(address, dict) else payload.get("country", "")
        label = normalize_query(f"{place['name']} {place.get('address', '')} {country_name} {place.get('countryCode', '')}")
        if all(part in label for part in parts[1:]):
            matches.append(place)
    return sorted(matches, key=lambda place: (
        normalize_query(place["name"]) != parts[0],
        bool(country) and place.get("countryCode", "").upper() != country,
        place.get("provider") != "openstreetmap",
    ))


def map_location(place: dict[str, Any], cached: bool = False) -> dict[str, Any]:
    short_name = place["name"]
    address = str(place.get("address") or "")
    name = address if normalize_query(address).startswith(normalize_query(short_name)) else ", ".join(part for part in (short_name, address) if part)
    payload = place.get("providerPayload") or {}
    details = payload.get("address")
    country = details.get("country", "") if isinstance(details, dict) else payload.get("country", "")
    return {**public_place(place), "name": name, "shortName": short_name, "country": country, "cached": cached}


def suggest_map_locations(query: str, country_code: str) -> list[dict[str, Any]]:
    # Saved landmarks must not be hidden by a previously cached empty city search.
    saved = saved_place_matches(query, country_code)
    return [map_location(place, cached=True) for place in saved[:8]] if saved else suggest_locations(query, country_code)


PLACE_LOOKUP_POLICY_VERSION = "osm-first-v2"
# Query terms map only to a reviewed, finite OSM tag taxonomy. User text never
# becomes Overpass QL, which keeps discovery bounded and injection-free.
OSM_PLACE_TAXONOMY: tuple[tuple[tuple[str, ...], tuple[tuple[str, str], ...]], ...] = (
    (("coffee", "cafe", "cafes"), (("amenity", "cafe"),)),
    (("restaurant", "restaurants", "food", "dining"), (("amenity", "restaurant"), ("amenity", "fast_food"))),
    (("museum", "museums"), (("tourism", "museum"),)),
    (("park", "parks", "playground"), (("leisure", "park"), ("leisure", "playground"))),
    (("hotel", "hotels", "hostel", "lodging"), (("tourism", "hotel"), ("tourism", "hostel"), ("tourism", "guest_house"))),
    (("pharmacy", "pharmacies"), (("amenity", "pharmacy"),)),
    (("hospital", "hospitals", "clinic", "clinics", "doctor", "doctors"), (("amenity", "hospital"), ("amenity", "clinic"), ("amenity", "doctors"))),
    (("library", "libraries"), (("amenity", "library"),)),
    (("supermarket", "supermarkets", "grocery", "groceries"), (("shop", "supermarket"), ("shop", "convenience"))),
    (("gas", "fuel", "petrol"), (("amenity", "fuel"),)),
    (("bank", "banks", "atm"), (("amenity", "bank"), ("amenity", "atm"))),
    (("attraction", "attractions", "landmark", "landmarks"), (("tourism", "attraction"),)),
)


def osm_category_tags(query: str) -> tuple[tuple[str, str], ...]:
    normalized = normalize_query(query)
    for terms, tags in OSM_PLACE_TAXONOMY:
        if any(term in normalized for term in terms):
            return tags
    return ()


def osm_place_from_element(item: dict[str, Any], country_code: str) -> dict[str, Any] | None:
    tags = item.get("tags")
    if not isinstance(tags, dict):
        return None
    point = item.get("center") if isinstance(item.get("center"), dict) else item
    coordinates = valid_coordinate(point.get("lon"), point.get("lat")) if isinstance(point, dict) else None
    if not coordinates:
        return None
    osm_type = str(item.get("type") or "node")
    osm_id = str(item.get("id") or "").strip()
    name = str(tags.get("name") or tags.get("brand") or "").strip()
    if not osm_id or not name:
        return None
    lon, lat = coordinates
    address_parts = [
        " ".join(part for part in (str(tags.get("addr:housenumber") or "").strip(), str(tags.get("addr:street") or "").strip()) if part),
        str(tags.get("addr:city") or "").strip(),
        str(tags.get("addr:postcode") or "").strip(),
    ]
    return {
        "id": f"openstreetmap:{osm_type}:{osm_id}",
        "provider": "openstreetmap",
        "providerId": f"{osm_type}:{osm_id}",
        "name": name[:160],
        "address": ", ".join(part for part in address_parts if part)[:500],
        "countryCode": country_code.upper(),
        "lat": lat,
        "lon": lon,
        "bbox": [lon, lat, lon, lat],
        "providerPayload": {"osmType": osm_type, "osmId": osm_id, "tags": redact_provider_payload(tags)},
    }


def rank_places_by_context(places: list[dict[str, Any]], country_code: str, lat: float | None, lon: float | None) -> list[dict[str, Any]]:
    if lat is None or lon is None:
        return places
    center = [lon, lat]
    country = country_param(country_code).upper()
    return sorted(
        places,
        key=lambda place: (
            0 if not country or str(place.get("countryCode") or "").upper() == country else 1,
            distance_meters(center, [float(place["lon"]), float(place["lat"])]),
            str(place.get("name") or ""),
        ),
    )


def search_osm_category_places(query: str, country_code: str, lat: float | None, lon: float | None) -> list[dict[str, Any]]:
    """Discover known POI categories from nearby OSM elements before web search."""
    tags = osm_category_tags(query)
    if not tags or lat is None or lon is None:
        return []
    clauses = "\n".join(
        f'  nwr["{key}"="{value}"](around:{CONFIG.osm_place_search_radius_meters},{lat:.6f},{lon:.6f});'
        for key, value in tags
    )
    payload = fetch_overpass_payload(f"""[out:json][timeout:25][maxsize:8388608];
(
{clauses}
);
out center;""")
    elements = payload.get("elements")
    if not isinstance(elements, list):
        raise ServiceError("OpenStreetMap returned an invalid response.", 503)
    places: list[dict[str, Any]] = []
    seen: set[str] = set()
    for element in elements:
        place = osm_place_from_element(element, country_code) if isinstance(element, dict) else None
        if place and place["id"] not in seen:
            seen.add(place["id"])
            places.append(place)
    if places:
        CACHE.put_places(places)
    return rank_places_by_context(places, country_code, lat, lon)[:20]


def local_place_suggestions(query: str) -> list[dict[str, Any]]:
    normalized = normalize_query(query)
    return [public_place(place) for place in CACHE.search_places(normalized, limit=8)] if len(normalized) >= 2 else []


def place_discovery(results: list[dict[str, Any]], source: str, lookup_stage: str, stored: bool = False, fallback_reason: str = "", serp_eligible: bool = False) -> dict[str, Any]:
    return {
        "results": [public_place(place) for place in results],
        "source": source,
        "lookupStage": lookup_stage,
        "stored": stored,
        "fallbackReason": fallback_reason,
        "serpEligible": serp_eligible,
    }


def lookup_places(query: str, country_code: str, lat: float | None, lon: float | None) -> dict[str, Any]:
    normalized = normalize_query(query)
    if len(normalized) < 2:
        return place_discovery([], "openstreetmap", "invalid-query", stored=True)
    context = {
        "policy": PLACE_LOOKUP_POLICY_VERSION,
        "query": normalized,
        "countryCode": country_param(country_code),
        "lat": round(lat, 2) if lat is not None else None,
        "lon": round(lon, 2) if lon is not None else None,
    }
    lookup_key = request_hash(context)
    stored = CACHE.get_place_lookup(lookup_key)
    if stored is not None:
        osm_stored = [place for place in stored if place.get("provider") == "openstreetmap"]
        if osm_stored:
            return place_discovery(rank_places_by_context(osm_stored, country_code, lat, lon), "openstreetmap", "osm-lookup-cache", stored=True)
    cached_places = CACHE.search_places(normalized, provider="openstreetmap", country_code=country_param(country_code).upper())
    if cached_places:
        CACHE.put_place_lookup(lookup_key, context, cached_places)
        return place_discovery(rank_places_by_context(cached_places, country_code, lat, lon), "openstreetmap", "local-osm-cache", stored=True)
    category_places = search_osm_category_places(query, country_code, lat, lon)
    if category_places:
        CACHE.put_place_lookup(lookup_key, context, category_places)
        return place_discovery(category_places, "openstreetmap", "osm-category-search")
    places = search_nominatim_places(query, country_code, lat, lon)
    if places:
        CACHE.put_places(places)
        results = rank_places_by_context(places, country_code, lat, lon)
        CACHE.put_place_lookup(lookup_key, context, results)
        return place_discovery(results, "openstreetmap", "nominatim-search")
    fallback_reason = "no-usable-osm-result"
    saved_serp = [place for place in saved_place_matches(query, country_code) if place.get("provider") == "serpapi-google-maps"]
    if saved_serp:
        saved_serp = rank_places_by_context(saved_serp, country_code, lat, lon)[:8]
        CACHE.put_place_lookup(lookup_key, context, saved_serp)
        return place_discovery(saved_serp, "serpapi", "local-serp-cache", stored=True, fallback_reason=fallback_reason, serp_eligible=True)
    places = search_serp_places(query, lat, lon, country_code)
    CACHE.put_place_lookup(lookup_key, context, places)
    return place_discovery(places, "serpapi", "serp-fallback", fallback_reason=fallback_reason, serp_eligible=True)


def detect_country(lat: float | None, lon: float | None) -> dict[str, str]:
    if lat is not None and lon is not None and math.isfinite(lat) and math.isfinite(lon):
        def task() -> dict[str, str]:
            url = "https://nominatim.openstreetmap.org/reverse?" + urllib.parse.urlencode({"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 3})
            payload = fetch_json(url, {"User-Agent": CONFIG.user_agent, "Referer": "http://localhost/", "Accept": "application/json"}, 10)
            address = payload.get("address") or {}
            return {"country": address.get("country") or "", "countryCode": (address.get("country_code") or "").upper(), "method": "browser"}

        # Browser coordinates establish request context only; do not retain them
        # in the local geocode cache unless the user creates a pin.
        return NOMINATIM_QUEUE.run(task)
    payload = fetch_json("https://api.country.is/", {"User-Agent": CONFIG.user_agent, "Accept": "application/json"}, 5)
    return {"country": "", "countryCode": payload.get("country") or "", "method": "ip"}


MAX_ROUTE_WAYPOINTS = 50


def route_waypoints(value: Any) -> list[list[float]]:
    if not isinstance(value, list) or not 2 <= len(value) <= MAX_ROUTE_WAYPOINTS:
        raise ServiceError(f"A route needs between two and {MAX_ROUTE_WAYPOINTS} waypoints.", 400)
    points: list[list[float]] = []
    for item in value:
        if isinstance(item, dict):
            point = valid_coordinate(item.get("lon"), item.get("lat"))
        elif isinstance(item, (list, tuple)) and len(item) >= 2:
            point = valid_coordinate(item[0], item[1])
        else:
            point = None
        if not point:
            raise ServiceError("Every route waypoint needs a valid longitude and latitude.", 400)
        points.append([point[0], point[1]])
    if len({(round(lon, 7), round(lat, 7)) for lon, lat in points}) < 2:
        raise ServiceError("Route origin and destination must be different.", 400)
    return points


def valid_linestring(geometry: Any) -> dict[str, Any] | None:
    if not isinstance(geometry, dict) or geometry.get("type") != "LineString" or not isinstance(geometry.get("coordinates"), list):
        return None
    coordinates = []
    for position in geometry["coordinates"]:
        if not isinstance(position, (list, tuple)) or len(position) < 2:
            return None
        point = valid_coordinate(position[0], position[1])
        if not point:
            return None
        coordinates.append([point[0], point[1]])
    return {"type": "LineString", "coordinates": coordinates} if len(coordinates) >= 2 else None


MAX_AREA_RINGS = 128
MAX_AREA_VERTICES = 10_000


def orientation(first: list[float], second: list[float], third: list[float]) -> float:
    return (second[0] - first[0]) * (third[1] - first[1]) - (second[1] - first[1]) * (third[0] - first[0])


def point_on_segment(point: list[float], first: list[float], second: list[float]) -> bool:
    return abs(orientation(first, second, point)) < 1e-12 and min(first[0], second[0]) <= point[0] <= max(first[0], second[0]) and min(first[1], second[1]) <= point[1] <= max(first[1], second[1])


def segments_intersect(first: list[float], second: list[float], third: list[float], fourth: list[float]) -> bool:
    one, two = orientation(first, second, third), orientation(first, second, fourth)
    three, four = orientation(third, fourth, first), orientation(third, fourth, second)
    if (one > 0) != (two > 0) and (three > 0) != (four > 0):
        return True
    return (abs(one) < 1e-12 and point_on_segment(third, first, second)) or (abs(two) < 1e-12 and point_on_segment(fourth, first, second)) or (abs(three) < 1e-12 and point_on_segment(first, third, fourth)) or (abs(four) < 1e-12 and point_on_segment(second, third, fourth))


def ring_self_intersects(ring: list[list[float]]) -> bool:
    segment_count = len(ring) - 1
    for first in range(segment_count):
        for second in range(first + 1, segment_count):
            if abs(first - second) <= 1 or (first == 0 and second == segment_count - 1):
                continue
            if segments_intersect(ring[first], ring[first + 1], ring[second], ring[second + 1]):
                return True
    return False


def point_in_ring(point: list[float], ring: list[list[float]]) -> bool:
    inside = False
    for first, second in zip(ring, ring[1:]):
        if point_on_segment(point, first, second):
            return False
        if (first[1] > point[1]) != (second[1] > point[1]):
            crossing_lon = (second[0] - first[0]) * (point[1] - first[1]) / (second[1] - first[1]) + first[0]
            if point[0] < crossing_lon:
                inside = not inside
    return inside


def rings_intersect(first_ring: list[list[float]], second_ring: list[list[float]]) -> bool:
    return any(
        segments_intersect(first, second, third, fourth)
        for first, second in zip(first_ring, first_ring[1:])
        for third, fourth in zip(second_ring, second_ring[1:])
    )


def ring_area_square_meters(ring: list[list[float]]) -> float:
    total = 0.0
    for first, second in zip(ring, ring[1:]):
        delta_lon = math.radians(((second[0] - first[0] + 540) % 360) - 180)
        total += delta_lon * (2 + math.sin(math.radians(first[1])) + math.sin(math.radians(second[1])))
    return abs(total) * EARTH_RADIUS ** 2 / 2


def area_summary(geometry: dict[str, Any], submitted: Any) -> dict[str, Any]:
    rings = geometry["coordinates"]
    area = max(0.0, ring_area_square_meters(rings[0]) - sum(ring_area_square_meters(ring) for ring in rings[1:]))
    requested_pin_ids = submitted.get("pinIds") if isinstance(submitted, dict) else []
    pin_ids = [value for value in requested_pin_ids if isinstance(value, str)][:MAX_AREA_VERTICES] if isinstance(requested_pin_ids, list) else []
    return {"areaSquareMeters": area, "pinIds": pin_ids}


def valid_polygon(geometry: Any) -> dict[str, Any] | None:
    if not isinstance(geometry, dict) or geometry.get("type") != "Polygon" or not isinstance(geometry.get("coordinates"), list):
        return None
    if not 1 <= len(geometry["coordinates"]) <= MAX_AREA_RINGS:
        return None
    rings: list[list[list[float]]] = []
    vertex_count = 0
    for ring in geometry["coordinates"]:
        if not isinstance(ring, list) or len(ring) < 4:
            return None
        points = []
        for position in ring:
            if not isinstance(position, (list, tuple)) or len(position) < 2:
                return None
            point = valid_coordinate(position[0], position[1])
            if not point:
                return None
            points.append([point[0], point[1]])
        if points[0] != points[-1]:
            return None
        vertex_count += len(points) - 1
        if vertex_count > MAX_AREA_VERTICES or ring_self_intersects(points) or ring_area_square_meters(points) <= 0:
            return None
        rings.append(points)
    outer = rings[0]
    holes = rings[1:]
    for index, hole in enumerate(holes):
        if not point_in_ring(hole[0], outer) or rings_intersect(outer, hole):
            return None
        for other in holes[:index]:
            if point_in_ring(hole[0], other) or point_in_ring(other[0], hole) or rings_intersect(hole, other):
                return None
    return {"type": "Polygon", "coordinates": rings}


def osrm_route(profile: str, waypoints: list[list[float]]) -> dict[str, Any] | None:
    if profile != CONFIG.osm_router_profile or profile != "driving":
        raise ServiceError("Only the configured driving profile is available from the public OSM router.", 400)
    coordinate_path = ";".join(f"{lon:.6f},{lat:.6f}" for lon, lat in waypoints)
    params = urllib.parse.urlencode({"overview": "full", "geometries": "geojson", "steps": "true", "alternatives": "false"})
    payload = fetch_json(
        f"{CONFIG.osm_router_base_url}/route/v1/{urllib.parse.quote(profile, safe='')}/{coordinate_path}?{params}",
        {"Accept": "application/json", "User-Agent": CONFIG.user_agent}, CONFIG.osm_router_timeout_seconds,
    )
    if payload.get("code") == "NoRoute":
        return None
    if payload.get("code") != "Ok":
        raise ServiceError(str(payload.get("message") or "The OSM router could not calculate this route."), 503)
    route = (payload.get("routes") or [None])[0]
    if not isinstance(route, dict):
        raise ServiceError("The OSM router returned no route.", 503)
    geometry = valid_linestring(route.get("geometry"))
    if not geometry:
        raise ServiceError("The OSM router returned invalid route geometry.", 503)
    try:
        distance = float(route["distance"])
        duration = float(route["duration"])
    except (KeyError, TypeError, ValueError):
        raise ServiceError("The OSM router returned an invalid route summary.", 503) from None
    if not math.isfinite(distance) or not math.isfinite(duration) or distance < 0 or duration < 0:
        raise ServiceError("The OSM router returned an invalid route summary.", 503)
    return {"geometry": geometry, "summary": {"distanceMeters": distance, "durationSeconds": duration, "approximateGeometry": False, "algorithm": "osrm"}}


DRIVABLE_HIGHWAYS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential", "living_street", "service"}
ROUTE_GRAPH_MAX_NODES = 40_000
ROUTE_GRAPH_MAX_EDGES = 120_000
ROUTE_SEARCH_MAX_EDGES = 50_000


def route_distance_meters(first: list[float], second: list[float]) -> float:
    latitude = math.radians((first[1] + second[1]) / 2)
    x = math.radians(second[0] - first[0]) * math.cos(latitude)
    y = math.radians(second[1] - first[1])
    return EARTH_RADIUS * math.hypot(x, y)


def route_graph_bbox(waypoints: list[list[float]]) -> list[float] | None:
    west, south = min(point[0] for point in waypoints), min(point[1] for point in waypoints)
    east, north = max(point[0] for point in waypoints), max(point[1] for point in waypoints)
    direct_distance = max(route_distance_meters(first, second) for first in waypoints for second in waypoints)
    # Keep the graph local enough for a bounded Overpass query while leaving room
    # for a sensible detour around barriers and one-way streets.
    if direct_distance > 30_000:
        return None
    latitude_padding = min(0.08, max(0.01, (north - south) * 0.25 + 0.012))
    longitude_padding = latitude_padding / max(0.2, abs(math.cos(math.radians((south + north) / 2))))
    return [west - longitude_padding, south - latitude_padding, east + longitude_padding, north + latitude_padding]


def fetch_osm_driving_ways(bbox: list[float]) -> list[dict[str, Any]]:
    west, south, east, north = bbox
    cache_key = f"roads-v1:{west:.4f}:{south:.4f}:{east:.4f}:{north:.4f}"
    cached = CACHE.get_raw_tile("routing-osm", cache_key)
    if cached and cached["fresh"]:
        return cached["features"]

    def remaining_cooldown() -> int:
        with OVERPASS_UNAVAILABLE_LOCK:
            return max(0, math.ceil(OVERPASS_UNAVAILABLE_UNTIL - time.monotonic()))

    def pause(seconds: int) -> int:
        global OVERPASS_UNAVAILABLE_UNTIL
        with OVERPASS_UNAVAILABLE_LOCK:
            OVERPASS_UNAVAILABLE_UNTIL = max(OVERPASS_UNAVAILABLE_UNTIL, time.monotonic() + seconds)
            return max(1, math.ceil(OVERPASS_UNAVAILABLE_UNTIL - time.monotonic()))

    cooldown = remaining_cooldown()
    if cooldown:
        raise ServiceError("OpenStreetMap data is temporarily rate limited.", 503, cooldown)

    def task() -> list[dict[str, Any]]:
        query = f'''[out:json][timeout:30][maxsize:67108864];
way["highway"]({south},{west},{north},{east});
out tags geom;'''
        body = urllib.parse.urlencode({"data": query}).encode("utf-8")
        try:
            payload = fetch_json(CONFIG.overpass_endpoint, {"User-Agent": CONFIG.user_agent, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "Accept": "application/json"}, 45, "POST", body)
        except ServiceError as error:
            if not error.retry_after:
                raise
            raise ServiceError("OpenStreetMap data is temporarily rate limited.", 503, pause(max(error.retry_after, CONFIG.overpass_backoff_seconds))) from error
        return [element for element in payload.get("elements", []) if isinstance(element, dict) and element.get("type") == "way"]

    ways = OVERPASS_QUEUE.run(task)
    CACHE.put_raw_tile("routing-osm", cache_key, ways, {"featureCount": len(ways)})
    return ways


def osm_driving_graph(ways: list[dict[str, Any]]) -> tuple[list[list[float]], list[list[tuple[int, float]]]]:
    positions: list[list[float]] = []
    nodes: dict[tuple[int, int], int] = {}
    graph: list[list[tuple[int, float]]] = []

    def node_id(position: Any) -> int | None:
        if not isinstance(position, dict):
            return None
        point = valid_coordinate(position.get("lon"), position.get("lat"))
        if not point:
            return None
        key = (round(point[0] * 10_000_000), round(point[1] * 10_000_000))
        if key not in nodes:
            if len(positions) >= ROUTE_GRAPH_MAX_NODES:
                raise ServiceError("The local OSM road graph is too large to animate. Choose closer pins.", 413)
            nodes[key] = len(positions)
            positions.append([point[0], point[1]])
            graph.append([])
        return nodes[key]

    edge_count = 0
    for way in ways:
        tags = way.get("tags") or {}
        highway = str(tags.get("highway") or "")
        if highway not in DRIVABLE_HIGHWAYS or str(tags.get("access") or "").lower() in {"no", "private"}:
            continue
        if str(tags.get("motor_vehicle") or "").lower() in {"no", "private"} or str(tags.get("motorcar") or "").lower() in {"no", "private"}:
            continue
        identifiers = [node_id(position) for position in way.get("geometry") or []]
        identifiers = [identifier for identifier in identifiers if identifier is not None]
        if len(identifiers) < 2:
            continue
        oneway = str(tags.get("oneway") or "").lower()
        forward_only = oneway in {"yes", "true", "1"} or str(tags.get("junction") or "").lower() == "roundabout"
        reverse_only = oneway == "-1"
        for first, second in zip(identifiers, identifiers[1:]):
            if first == second:
                continue
            distance = route_distance_meters(positions[first], positions[second])
            if distance <= 0:
                continue
            if reverse_only:
                graph[second].append((first, distance)); edge_count += 1
            elif forward_only:
                graph[first].append((second, distance)); edge_count += 1
            else:
                graph[first].append((second, distance)); graph[second].append((first, distance)); edge_count += 2
            if edge_count > ROUTE_GRAPH_MAX_EDGES:
                raise ServiceError("The local OSM road graph is too detailed to animate. Choose closer pins.", 413)
    return positions, graph


def closest_graph_node(point: list[float], positions: list[list[float]]) -> int | None:
    if not positions:
        return None
    index = min(range(len(positions)), key=lambda candidate: route_distance_meters(point, positions[candidate]))
    return index if route_distance_meters(point, positions[index]) <= 250 else None


def dijkstra_search(positions: list[list[float]], graph: list[list[tuple[int, float]]], start: int, destination: int) -> tuple[list[list[float]], list[list[list[float]]], float] | None:
    distances = [math.inf] * len(positions)
    previous = [-1] * len(positions)
    distances[start] = 0.0
    queue: list[tuple[float, int]] = [(0.0, start)]
    explored: list[list[list[float]]] = []
    while queue:
        distance, node = heapq.heappop(queue)
        if distance != distances[node]:
            continue
        if node == destination:
            path = []
            while node >= 0:
                path.append(positions[node])
                node = previous[node]
            return list(reversed(path)), explored, distance
        for neighbor, edge_distance in graph[node]:
            explored.append([positions[node], positions[neighbor]])
            if len(explored) > ROUTE_SEARCH_MAX_EDGES:
                raise ServiceError("The OSM search examined too many roads to animate. Choose closer pins.", 413)
            candidate_distance = distance + edge_distance
            if candidate_distance < distances[neighbor]:
                distances[neighbor] = candidate_distance
                previous[neighbor] = node
                heapq.heappush(queue, (candidate_distance, neighbor))
    return None


def dijkstra_osm_route(waypoints: list[list[float]]) -> dict[str, Any] | None:
    bbox = route_graph_bbox(waypoints)
    if not bbox:
        return None
    positions, graph = osm_driving_graph(fetch_osm_driving_ways(bbox))
    if not positions:
        return None
    route_coordinates: list[list[float]] = []
    explored_edges: list[list[list[float]]] = []
    total_distance = 0.0
    for origin, destination in zip(waypoints, waypoints[1:]):
        start = closest_graph_node(origin, positions)
        end = closest_graph_node(destination, positions)
        if start is None or end is None:
            return None
        result = dijkstra_search(positions, graph, start, end)
        if not result:
            return None
        path, explored, distance = result
        for point in [origin, *path, destination]:
            if not route_coordinates or route_coordinates[-1] != point:
                route_coordinates.append(point)
        explored_edges.extend(explored)
        if len(explored_edges) > ROUTE_SEARCH_MAX_EDGES:
            raise ServiceError("The OSM search examined too many roads to animate. Choose closer pins.", 413)
        total_distance += distance + route_distance_meters(origin, positions[start]) + route_distance_meters(positions[end], destination)
    return {
        "geometry": {"type": "LineString", "coordinates": route_coordinates},
        "summary": {
            "distanceMeters": total_distance,
            "durationSeconds": total_distance / 13.89,
            "approximateGeometry": False,
            "approximateDuration": True,
            "algorithm": "dijkstra",
            "search": {"exploredEdges": explored_edges},
        },
    }


def serp_directions_fallback(waypoints: list[list[float]]) -> dict[str, Any]:
    """Return distance only; SerpApi does not document a reusable route polyline."""
    start_lon, start_lat = waypoints[0]
    end_lon, end_lat = waypoints[-1]
    params = {
        "engine": "google_maps_directions", "start_coords": f"{start_lat:.6f},{start_lon:.6f}",
        "end_coords": f"{end_lat:.6f},{end_lon:.6f}", "travel_mode": "0", "hl": "en",
    }
    payload = fetch_serp_response(params)
    if not isinstance(payload, dict):
        raise ServiceError("The fallback provider returned an invalid response.", 503)
    route = (payload.get("directions") or [None])[0]
    if not isinstance(route, dict):
        raise ServiceError("No route is available from either configured provider.", 404)
    try:
        distance = float(route["distance"])
        duration = float(route["duration"])
    except (KeyError, TypeError, ValueError):
        raise ServiceError("The fallback provider returned an invalid route summary.", 503) from None
    # Straight-line connector — SerpApi does not return a reusable road polyline.
    return {
        "id": f"temporary-serp-{uuid.uuid4().hex}", "provider": "serpapi-google-maps", "profile": "driving",
        "waypoints": waypoints, "geometry": {"type": "LineString", "coordinates": [waypoints[0], waypoints[-1]]},
        "summary": {"distanceMeters": distance, "durationSeconds": duration, "approximateGeometry": True},
        "sourceVersion": "external-temporary", "createdAt": int(time.time()),
    }


def get_route(waypoints: list[list[float]], profile: str) -> dict[str, Any]:
    if profile != CONFIG.osm_router_profile or profile != "driving":
        raise ServiceError("Only the configured driving profile is available from the local OSM route search.", 400)
    request = {"provider": "osm-dijkstra-v1", "profile": profile, "waypoints": [[round(lon, 6), round(lat, 6)] for lon, lat in waypoints]}
    key = request_hash(request)
    stored = CACHE.get_route(key)
    if stored:
        return stored
    try:
        result = dijkstra_osm_route(waypoints)
    except ServiceError as error:
        print(f"[routing] Local OSM graph search failed: {error}")
        result = None
    if result is not None:
        return CACHE.put_route(key, profile, waypoints, result["geometry"], result["summary"], provider="openstreetmap-dijkstra", source_version="overpass-driving-ways-v1")
    result = osrm_route(profile, waypoints)
    if result is not None:
        return CACHE.put_route(key, profile, waypoints, result["geometry"], result["summary"])
    CACHE.put_osm_route_failure(key, profile, waypoints, "no_route")
    if CONFIG.enable_serp_directions_fallback:
        serp = serp_directions_fallback(waypoints)
        return CACHE.put_route(key, profile, waypoints, serp["geometry"], serp["summary"], provider="serpapi-google-maps", source_version="external-temporary")
    raise ServiceError("No OSM driving route was found for these points.", 404)


def workspace_snapshot() -> dict[str, Any]:
    return CACHE.workspace_snapshot()


def safe_workspace_state(state: Any) -> dict[str, Any]:
    """Keep persisted workspace state small, map-specific, and client-safe."""
    if not isinstance(state, dict):
        raise ServiceError("Workspace state must be a JSON object.", 400)
    safe: dict[str, Any] = {}
    route_id = state.get("routeId")
    if isinstance(route_id, str) and re.fullmatch(r"route-[A-Za-z0-9]+", route_id):
        safe["routeId"] = route_id
    route_pin_ids = state.get("routePinIds")
    if isinstance(route_pin_ids, list):
        safe["routePinIds"] = [pin_id for pin_id in route_pin_ids[:MAX_ROUTE_WAYPOINTS] if isinstance(pin_id, str)]
    context = state.get("context")
    if isinstance(context, dict):
        selected = context.get("selectedCity")
        if isinstance(selected, dict):
            point = valid_coordinate(selected.get("lon"), selected.get("lat"))
            name = str(selected.get("name") or "").strip()[:160]
            if point and name:
                city = {
                    "id": str(selected.get("id") or f"city:{point[0]:.6f},{point[1]:.6f}")[:180],
                    "name": name,
                    "shortName": str(selected.get("shortName") or name)[:160],
                    "country": str(selected.get("country") or "")[:120],
                    "countryCode": country_param(str(selected.get("countryCode") or "" )).upper(),
                    "lon": point[0],
                    "lat": point[1],
                }
                bbox = selected.get("bbox")
                if isinstance(bbox, list) and len(bbox) == 4:
                    parsed_bbox = [parse_number(str(value)) for value in bbox]
                    if all(value is not None for value in parsed_bbox):
                        city["bbox"] = parsed_bbox
                safe["context"] = {"selectedCity": city}
    return safe


def save_workspace_state(state: Any) -> dict[str, Any]:
    safe = safe_workspace_state(state)
    CACHE.put_workspace_state(safe)
    return safe


REALTIME = RealtimeHub(CONFIG)
AGENT_TOOLS = AgentTools(AgentDependencies(
    suggest_cities=suggest_locations,
    resolve_city=resolve_agent_city,
    search_places=lambda query, country, lat, lon: lookup_places(query, country, lat, lon),
    plan_route=get_route,
    workspace_snapshot=workspace_snapshot,
    clear_workspace=CACHE.clear_workspace,
    add_pin=CACHE.add_pin,
    save_workspace_state=save_workspace_state,
    capture_workspace=CACHE.capture_workspace,
    mutate_workspace=CACHE.mutate_workspace,
    restore_workspace=CACHE.restore_workspace,
    search_web=search_serp_web,
    read_web_source=fetch_web_document,
))
AGENT = MapAgentService(OpenAIChatClient(CONFIG), AGENT_TOOLS, REALTIME)


def meters(value: Any) -> float:
    if not isinstance(value, (str, int, float)):
        return 0.0
    text = str(value).strip().lower()
    match = re.match(r"[-+]?\d+(?:\.\d+)?", text)
    if not match:
        return 0.0
    amount = float(match.group())
    if re.search(r"\b(ft|feet|foot)\b|\d\s*'", text):
        return amount * 0.3048
    if re.search(r"\bcm\b", text):
        return amount / 100
    if re.search(r"\b(m|meter|metre)s?\b|^[-+]?\d+(?:\.\d+)?$", text):
        return amount
    return 0.0


def estimated_level_range(value: Any) -> tuple[float, float] | None:
    if isinstance(value, (list, tuple)) and len(value) == 2:
        try:
            low, high = float(value[0]), float(value[1])
        except (TypeError, ValueError):
            return None
    elif isinstance(value, str):
        match = re.fullmatch(r"\s*HBET\s*:\s*(\d{1,3})\s*-\s*(\d{1,3})\s*", value, re.IGNORECASE)
        if not match:
            return None
        low, high = float(match.group(1)), float(match.group(2))
    else:
        return None
    return (low, high) if 0 < low <= high <= 200 else None


def close_ring(points: list[Any]) -> list[list[float]] | None:
    if len(points) < 3:
        return None
    ring = []
    for point in points:
        try:
            if isinstance(point, dict):
                ring.append([float(point["lon"]), float(point["lat"])])
            elif len(point) >= 2:
                ring.append([float(point[0]), float(point[1])])
        except (KeyError, TypeError, ValueError):
            continue
    if len(ring) < 3:
        return None
    if ring[0] != ring[-1]:
        ring.append(ring[0])
    return ring if len(ring) >= 4 else None


def join_segments(segments: list[list[list[float]]]) -> list[list[list[float]]]:
    """Join relation-member line segments into closed rings when possible."""
    pending = [segment[:] for segment in segments if len(segment) >= 2]
    rings: list[list[list[float]]] = []
    while pending:
        line = pending.pop(0)
        changed = True
        while changed and line[0] != line[-1]:
            changed = False
            for index, segment in enumerate(pending):
                if line[-1] == segment[0]:
                    line.extend(segment[1:]); pending.pop(index); changed = True; break
                if line[-1] == segment[-1]:
                    line.extend(reversed(segment[:-1])); pending.pop(index); changed = True; break
                if line[0] == segment[-1]:
                    line = segment[:-1] + line; pending.pop(index); changed = True; break
                if line[0] == segment[0]:
                    line = list(reversed(segment[1:])) + line; pending.pop(index); changed = True; break
        ring = close_ring(line)
        if ring:
            rings.append(ring)
    return rings


def element_geometry(element: dict[str, Any]) -> dict[str, Any] | None:
    element_type = element.get("type")
    if element_type == "way":
        ring = close_ring(element.get("geometry") or [])
        return {"type": "Polygon", "coordinates": [ring]} if ring else None
    if element_type != "relation":
        return None
    members = element.get("members") or []
    outer_segments = [member.get("geometry") or [] for member in members if member.get("role") != "inner"]
    inner_segments = [member.get("geometry") or [] for member in members if member.get("role") == "inner"]
    outers = join_segments(outer_segments)
    inners = join_segments(inner_segments)
    if not outers:
        return None
    polygons = [[outer] for outer in outers]
    # Overpass does not identify a containing outer for every inner segment. Keeping
    # inner rings on the first outer is preferable to discarding building holes.
    if polygons:
        polygons[0].extend(inners)
    return {"type": "Polygon", "coordinates": polygons[0]} if len(polygons) == 1 else {"type": "MultiPolygon", "coordinates": polygons}


def raw_feature(element: dict[str, Any]) -> dict[str, Any] | None:
    tags = element.get("tags") or {}
    if not (tags.get("building") or tags.get("building:part")):
        return None
    geometry = element_geometry(element)
    if not geometry:
        return None
    levels_value = tags.get("building:levels", 0)
    try:
        levels = float(levels_value)
    except (TypeError, ValueError):
        levels = 0.0
    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": {
            "sourceId": f"{element.get('type', 'way')}/{element.get('id', '')}",
            "kind": "building",
            "buildingType": str(tags.get("building") or tags.get("building:part") or "unknown"),
            "roadClass": "",
            "dataSource": "openstreetmap",
            "realHeight": meters(tags.get("height")),
            "levels": levels,
            "minHeight": meters(tags.get("min_height")),
            "name": str(tags.get("name") or "")[:160],
        },
    }


def poi_category(tags: dict[str, Any]) -> str:
    amenity = str(tags.get("amenity") or "")
    tourism = str(tags.get("tourism") or "")
    shop = str(tags.get("shop") or "")
    if amenity in {"hospital", "clinic", "doctors", "pharmacy"}:
        return "health"
    if amenity == "fuel":
        return "fuel"
    if amenity in {"school", "college", "university", "kindergarten", "library"}:
        return "education"
    if amenity in {"police", "fire_station"}:
        return "safety"
    if amenity == "bus_station":
        return "transit"
    if tourism in {"hotel", "motel", "hostel", "guest_house"}:
        return "lodging"
    if tourism in {"museum", "attraction"}:
        return "culture"
    if shop in {"supermarket", "convenience"}:
        return "shopping"
    return ""


def poi_feature(element: dict[str, Any]) -> dict[str, Any] | None:
    tags = element.get("tags") or {}
    category = poi_category(tags)
    if not category:
        return None
    point = element.get("center") or element
    try:
        coordinates = [float(point["lon"]), float(point["lat"])]
    except (KeyError, TypeError, ValueError):
        return None
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": coordinates},
        "properties": {
            "sourceId": f"{element.get('type', 'node')}/{element.get('id', '')}",
            "kind": "poi",
            "poiCategory": category,
            "name": str(tags.get("name") or tags.get("brand") or "")[:160],
            "dataSource": "openstreetmap",
        },
    }


def normalize_raw_features(features: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[str] = set()
    for feature in features:
        geometry = feature.get("geometry") or {}
        props = feature.get("properties") or {}
        if props.get("kind") == "poi":
            if geometry.get("type") != "Point":
                continue
        elif geometry.get("type") not in {"Polygon", "MultiPolygon", "LineString", "MultiLineString"}:
            continue
        level_range = estimated_level_range(props.get("estimatedLevelRange"))
        normalized = {
            "sourceId": str(props.get("sourceId") or ""), "kind": str(props.get("kind") or ""),
            "buildingType": str(props.get("buildingType") or ""), "roadClass": str(props.get("roadClass") or ""),
            "dataSource": str(props.get("dataSource") or props.get("source") or ""), "realHeight": number(props.get("realHeight")),
            "levels": number(props.get("levels")), "minHeight": number(props.get("minHeight")), "poiCategory": str(props.get("poiCategory") or ""), "name": str(props.get("name") or "")[:160],
            "estimatedLevelRange": list(level_range) if level_range else [], "community": str(props.get("community") or "")[:160],
        }
        key = f"{normalized['dataSource']}:{normalized['sourceId']}:{normalized['kind']}"
        if normalized["sourceId"] and key in seen:
            continue
        seen.add(key)
        result.append({"type": "Feature", "geometry": geometry, "properties": normalized})
    return result


def number(value: Any) -> float:
    try:
        parsed = float(value)
        return parsed if math.isfinite(parsed) else 0.0
    except (TypeError, ValueError):
        return 0.0


def overpass_cooldown_seconds() -> int:
    with OVERPASS_UNAVAILABLE_LOCK:
        return max(0, math.ceil(OVERPASS_UNAVAILABLE_UNTIL - time.monotonic()))


def pause_overpass(seconds: int) -> int:
    global OVERPASS_UNAVAILABLE_UNTIL
    with OVERPASS_UNAVAILABLE_LOCK:
        OVERPASS_UNAVAILABLE_UNTIL = max(OVERPASS_UNAVAILABLE_UNTIL, time.monotonic() + seconds)
        return max(1, math.ceil(OVERPASS_UNAVAILABLE_UNTIL - time.monotonic()))


def fetch_overpass_payload(query: str) -> dict[str, Any]:
    """Run a trusted, bounded Overpass query through the shared cooldown policy."""
    cooldown = overpass_cooldown_seconds()
    if cooldown:
        raise ServiceError("OpenStreetMap data is temporarily rate limited.", 503, cooldown)

    def task() -> dict[str, Any]:
        cooldown = overpass_cooldown_seconds()
        if cooldown:
            raise ServiceError("OpenStreetMap data is temporarily rate limited.", 503, cooldown)
        body = urllib.parse.urlencode({"data": query}).encode("utf-8")
        try:
            payload = fetch_json(
                CONFIG.overpass_endpoint,
                {"User-Agent": CONFIG.user_agent, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8", "Accept": "application/json"},
                40,
                "POST",
                body,
            )
        except ServiceError as error:
            if not error.retry_after:
                raise
            retry_after = pause_overpass(max(error.retry_after, CONFIG.overpass_backoff_seconds))
            raise ServiceError("OpenStreetMap data is temporarily rate limited.", 503, retry_after) from error
        if not isinstance(payload, dict):
            raise ServiceError("OpenStreetMap returned an invalid response.", 503)
        return payload

    return OVERPASS_QUEUE.run(task)


def fetch_overpass_features(bbox: list[float]) -> list[dict[str, Any]]:
    west, south, east, north = bbox
    query = f"""[out:json][timeout:25][maxsize:67108864];
(
  nwr[\"building\"]({south},{west},{north},{east});
  nwr[\"building:part\"]({south},{west},{north},{east});
);
out geom;
(
  nwr[\"amenity\"~\"^(hospital|clinic|doctors|pharmacy|fuel|school|college|university|kindergarten|library|police|fire_station|bus_station)$\"]({south},{west},{north},{east});
  nwr[\"tourism\"~\"^(hotel|motel|hostel|guest_house|museum|attraction)$\"]({south},{west},{north},{east});
  nwr[\"shop\"~\"^(supermarket|convenience)$\"]({south},{west},{north},{east});
);
out center;"""
    payload = fetch_overpass_payload(query)
    elements = payload.get("elements")
    if not isinstance(elements, list):
        raise ServiceError("OpenStreetMap returned an invalid response.", 503)
    return [feature for element in elements if isinstance(element, dict) for feature in (raw_feature(element), poi_feature(element)) if feature]


def tile_bbox(x: int, y: int, z: int) -> list[float]:
    size = 2 ** z
    west = x / size * 360.0 - 180.0
    east = (x + 1) / size * 360.0 - 180.0
    north = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / size))))
    south = math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * (y + 1) / size))))
    return [west, south, east, north]


def quadkey(x: int, y: int, z: int) -> str:
    digits = []
    for level in range(z, 0, -1):
        digit = 0
        bit = 1 << (level - 1)
        if x & bit: digit += 1
        if y & bit: digit += 2
        digits.append(str(digit))
    return "".join(digits)


def wkt_groups(value: str) -> list[str]:
    groups: list[str] = []
    depth = start = 0
    for index, character in enumerate(value):
        if character == "(":
            if depth == 0:
                start = index
            depth += 1
        elif character == ")":
            depth -= 1
            if depth == 0:
                groups.append(value[start:index + 1])
            elif depth < 0:
                return []
    return groups if depth == 0 else []


def wkt_ring(value: str) -> list[list[float]] | None:
    coordinates: list[list[float]] = []
    for position in value.strip().strip("()").split(","):
        try:
            lon, lat, *_ = position.strip().split()
            coordinates.append([float(lon), float(lat)])
        except (TypeError, ValueError):
            return None
    if len(coordinates) < 3:
        return None
    if coordinates[0] != coordinates[-1]:
        coordinates.append(coordinates[0])
    return coordinates if len(coordinates) >= 4 else None


def wkt_geometry(value: Any) -> dict[str, Any] | None:
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text.upper().startswith("SRID=") and ";" in text:
        text = text.split(";", 1)[1].strip()
    upper = text.upper()
    start = text.find("(")
    if start < 0 or not text.endswith(")"):
        return None
    body = text[start + 1:-1]
    if upper.startswith("POLYGON"):
        rings = [ring for group in wkt_groups(body) for ring in [wkt_ring(group)] if ring]
        return {"type": "Polygon", "coordinates": rings} if rings else None
    if upper.startswith("MULTIPOLYGON"):
        polygons = []
        for polygon in wkt_groups(body):
            rings = [ring for group in wkt_groups(polygon[1:-1]) for ring in [wkt_ring(group)] if ring]
            if rings:
                polygons.append(rings)
        return {"type": "MultiPolygon", "coordinates": polygons} if polygons else None
    return None


MAX_WKB_RINGS = 10_000
MAX_WKB_POINTS = 1_000_000


def wkb_type(type_code: int) -> tuple[int, int] | None:
    """Return a WKB base geometry type and coordinate dimension."""
    dimension = 2
    # EWKB flags are used by PostGIS and some GeoPackage exporters.
    if type_code & 0x80000000:
        dimension += 1
    if type_code & 0x40000000:
        dimension += 1
    base = type_code & 0x0FFFFFFF
    # ISO WKB represents Z/M dimensions by adding 1000/2000/3000.
    if base >= 1000:
        modifier, base = divmod(base, 1000)
        if modifier == 1:
            dimension = 3
        elif modifier == 2:
            dimension = 3
        elif modifier == 3:
            dimension = 4
        else:
            return None
    return (base, dimension) if base in {3, 6} else None


def read_wkb_geometry(data: bytes, offset: int = 0) -> tuple[dict[str, Any], int] | None:
    """Read Polygon or MultiPolygon WKB without accepting unbounded counts."""
    if offset + 5 > len(data) or data[offset] not in {0, 1}:
        return None
    byte_order = ">" if data[offset] == 0 else "<"
    try:
        type_code = struct.unpack_from(f"{byte_order}I", data, offset + 1)[0]
    except struct.error:
        return None
    geometry_type = wkb_type(type_code)
    if not geometry_type:
        return None
    base, dimension = geometry_type
    cursor = offset + 5

    def read_count() -> int | None:
        nonlocal cursor
        if cursor + 4 > len(data):
            return None
        try:
            count = struct.unpack_from(f"{byte_order}I", data, cursor)[0]
        except struct.error:
            return None
        cursor += 4
        return count

    def read_polygon() -> dict[str, Any] | None:
        nonlocal cursor
        ring_count = read_count()
        if ring_count is None or ring_count > MAX_WKB_RINGS:
            return None
        rings: list[list[list[float]]] = []
        total_points = 0
        for _ in range(ring_count):
            point_count = read_count()
            if point_count is None or point_count < 3 or point_count > MAX_WKB_POINTS - total_points:
                return None
            byte_count = point_count * dimension * 8
            if cursor + byte_count > len(data):
                return None
            ring: list[list[float]] = []
            for _ in range(point_count):
                try:
                    values = struct.unpack_from(f"{byte_order}{dimension}d", data, cursor)
                except struct.error:
                    return None
                cursor += dimension * 8
                lon, lat = values[:2]
                if not math.isfinite(lon) or not math.isfinite(lat):
                    return None
                ring.append([lon, lat])
            total_points += point_count
            if ring[0] != ring[-1]:
                ring.append(ring[0])
            rings.append(ring)
        return {"type": "Polygon", "coordinates": rings} if rings else None

    if base == 3:
        polygon = read_polygon()
        return (polygon, cursor) if polygon else None

    polygon_count = read_count()
    if polygon_count is None or polygon_count > MAX_WKB_RINGS:
        return None
    polygons: list[list[list[list[float]]]] = []
    for _ in range(polygon_count):
        child = read_wkb_geometry(data, cursor)
        if not child or child[0].get("type") != "Polygon":
            return None
        polygon, cursor = child
        polygons.append(polygon["coordinates"])
    return ({"type": "MultiPolygon", "coordinates": polygons}, cursor) if polygons else None


def binary_geometry(value: Any) -> dict[str, Any] | None:
    """Decode hexadecimal WKB and GeoPackage binary geometry into GeoJSON."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if text.lower().startswith("0x"):
        text = text[2:]
    if len(text) % 2 or not re.fullmatch(r"[0-9a-fA-F]+", text):
        return None
    try:
        data = bytes.fromhex(text)
    except ValueError:
        return None
    offset = 0
    if data.startswith(b"GP"):
        if len(data) < 8 or data[2] != 0:
            return None
        flags = data[3]
        envelope_code = (flags >> 1) & 0x07
        envelope_sizes = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
        if envelope_code not in envelope_sizes or flags & 0x10:
            return None
        offset = 8 + envelope_sizes[envelope_code]
    result = read_wkb_geometry(data, offset)
    if not result:
        return None
    geometry, end = result
    return geometry if end == len(data) else None


def encoded_geometry(value: Any) -> dict[str, Any] | None:
    return wkt_geometry(value) or binary_geometry(value)


def row_value(row: dict[str, Any], *names: str) -> Any:
    values = {str(key).lower(): value for key, value in row.items()}
    for name in names:
        if name.lower() in values and values[name.lower()] not in (None, ""):
            return values[name.lower()]
    return None


def openbuildingmap_feature(row: dict[str, Any], filename: str) -> dict[str, Any] | None:
    geometry = encoded_geometry(row_value(row, "geom", "geometry", "wkt", "geometry_wkt"))
    if not geometry:
        for value in row.values():
            geometry = encoded_geometry(value)
            if geometry:
                break
    if not geometry:
        return None
    identifier = row_value(row, "fid", "id", "building_id", "osm_id")
    height_value = row_value(row, "height", "height_m", "height_metres", "building:height")
    level_range = estimated_level_range(height_value)
    community = row_value(row, "society", "project", "project_name", "complex", "complex_name", "community", "community_name", "development")
    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": {
            "sourceId": f"{filename}:{identifier if identifier is not None else hash(json.dumps(row, sort_keys=True, default=str))}",
            "kind": "building",
            "buildingType": str(row_value(row, "building", "building_type", "type", "class", "subtype") or "unknown"),
            "roadClass": "",
            "dataSource": "openbuildingmap",
            "realHeight": meters(height_value),
            "levels": number(row_value(row, "building:levels", "building_levels", "levels", "num_floors")),
            "minHeight": meters(row_value(row, "min_height", "minheight", "building:min_height")),
            "name": str(row_value(row, "name", "building_name", "label") or "")[:160],
            "estimatedLevelRange": list(level_range) if level_range else [],
            "community": str(community or "")[:160],
        },
    }


def openbuildingmap_files() -> list[dict[str, str]]:
    if not CONFIG.openbuildingmap_api_url:
        return []
    with OPENBUILDINGMAP_CATALOG_LOCK:
        if OPENBUILDINGMAP_CATALOG["expires"] > time.monotonic():
            return list(OPENBUILDINGMAP_CATALOG["files"])
        stale_files = list(OPENBUILDINGMAP_CATALOG["files"])

    def task() -> list[dict[str, str]]:
        payload = fetch_json(f"{CONFIG.openbuildingmap_api_url}/files", {"Accept": "application/json"}, 100)
        files = []
        for item in payload.get("files", []):
            filename = str(item.get("filename") or "")
            key = str(item.get("quadkey") or "")
            if not key:
                match = re.search(r"building\.([0-3]+)\.gpkg$", filename)
                key = match.group(1) if match else ""
            if filename.endswith(".gpkg") and re.fullmatch(r"[0-3]+", key):
                files.append({"filename": filename, "quadkey": key})
        return files

    try:
        files = OPENBUILDINGMAP_QUEUE.run(task)
    except Exception:
        if stale_files:
            return stale_files
        raise
    with OPENBUILDINGMAP_CATALOG_LOCK:
        OPENBUILDINGMAP_CATALOG.update({"expires": time.monotonic() + OPENBUILDINGMAP_CATALOG_TTL_SECONDS, "files": files})
        return files


def fetch_openbuildingmap_buildings(x: int, y: int, z: int) -> list[dict[str, Any]]:
    target = quadkey(x, y, z)
    files = [item for item in openbuildingmap_files() if target.startswith(item["quadkey"])]
    if not files:
        return []
    features: list[dict[str, Any]] = []
    limit = min(CONFIG.max_buildings_per_tile, 5000)
    for item in sorted(files, key=lambda candidate: len(candidate["quadkey"]), reverse=True):
        offset = 0
        while len(features) < CONFIG.max_buildings_per_tile:
            params = urllib.parse.urlencode({"quadkey": target, "limit": min(limit, CONFIG.max_buildings_per_tile - len(features)), "offset": offset})
            filename = urllib.parse.quote(item["filename"], safe="")
            url = f"{CONFIG.openbuildingmap_api_url}/query/{filename}?{params}"
            payload = OPENBUILDINGMAP_QUEUE.run(lambda: fetch_json(url, {"Accept": "application/json"}, 20))
            rows = payload.get("rows", [])
            if not isinstance(rows, list):
                break
            features.extend(feature for row in rows if isinstance(row, dict) for feature in [openbuildingmap_feature(row, item["filename"])] if feature)
            if len(rows) < limit:
                break
            offset += len(rows)
    return features[:CONFIG.max_buildings_per_tile]


def overture_source_path() -> str:
    if CONFIG.overture_path:
        return CONFIG.overture_path.replace("\\", "/")
    return f"s3://overturemaps-us-west-2/release/{CONFIG.overture_release}/theme=buildings/type=building/*.parquet"


REMOTE_OVERTURE_UNAVAILABLE_UNTIL = 0.0


def fetch_overture_buildings(bbox: list[float]) -> list[dict[str, Any]]:
    global REMOTE_OVERTURE_UNAVAILABLE_UNTIL
    if CONFIG.disable_overture:
        return []
    if not CONFIG.overture_path and time.monotonic() < REMOTE_OVERTURE_UNAVAILABLE_UNTIL:
        raise ServiceError("Remote Overture is temporarily paused after a slow or failed query")
    if not CONFIG.duckdb_path.exists():
        raise ServiceError(f"DuckDB was not found at {CONFIG.duckdb_path}")
    west, south, east, north = bbox
    source = overture_source_path().replace("'", "''")
    sql = f"""
LOAD spatial;
LOAD httpfs;
SET s3_region='us-west-2';
SET threads=2;
SET memory_limit='768MB';
SELECT id, subtype, class, height, num_floors, min_height, ST_AsGeoJSON(geometry) AS geometry_json
FROM read_parquet('{source}', filename=true, hive_partitioning=true)
WHERE bbox.xmin <= {east} AND bbox.xmax >= {west} AND bbox.ymin <= {north} AND bbox.ymax >= {south}
  AND is_underground IS NOT TRUE
LIMIT {CONFIG.max_buildings_per_tile};
"""

    def task() -> list[dict[str, Any]]:
        global REMOTE_OVERTURE_UNAVAILABLE_UNTIL
        try:
            completed = subprocess.run(
                [str(CONFIG.duckdb_path), "-no-init", "-batch", "-jsonlines", ":memory:"], input=sql, capture_output=True,
                text=True, timeout=180 if CONFIG.overture_path else 8, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            if len(completed.stdout.encode("utf-8")) > 80_000_000:
                raise ServiceError("Overture query exceeded the local 80 MB output budget")
            if completed.returncode:
                raise ServiceError(completed.stderr.strip() or f"DuckDB exited with code {completed.returncode}")
            rows = [json.loads(line) for line in completed.stdout.splitlines() if line]
        except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, ServiceError) as error:
            if not CONFIG.overture_path:
                REMOTE_OVERTURE_UNAVAILABLE_UNTIL = time.monotonic() + 15 * 60
            raise ServiceError(str(error)) from error
        features = []
        for row in rows:
            try:
                geometry = json.loads(row["geometry_json"]) if isinstance(row.get("geometry_json"), str) else row.get("geometry_json")
                if geometry.get("type") not in {"Polygon", "MultiPolygon"}:
                    continue
                features.append({"type": "Feature", "geometry": geometry, "properties": {
                    "sourceId": str(row.get("id") or ""), "kind": "building", "buildingType": str(row.get("class") or row.get("subtype") or "unknown"),
                    "roadClass": "", "dataSource": "overture", "realHeight": number(row.get("height")),
                    "levels": number(row.get("num_floors")), "minHeight": number(row.get("min_height")),
                }})
            except (TypeError, ValueError, KeyError, json.JSONDecodeError):
                continue
        return features

    return DUCKDB_QUEUE.run(task)


def tile_stats(features: list[dict[str, Any]]) -> dict[str, int]:
    return {
        "featureCount": len(features),
        "buildingCount": sum(feature["properties"].get("kind") == "building" for feature in features),
        "poiCount": sum(feature["properties"].get("kind") == "poi" for feature in features),
    }


def get_source_tile(x: int, y: int, z: int, source: str) -> dict[str, Any]:
    key = quadkey(x, y, z)
    if source == "openbuildingmap":
        tile_id = f"obm-v2:{key}"
    elif source == "openstreetmap":
        tile_id = f"pois-v1:{key}"
    else:
        tile_id = f"{CONFIG.overture_release}:{key}"
    cached = CACHE.get_raw_tile(source, tile_id)
    if cached and cached["fresh"]:
        return {"features": cached["features"], "stats": cached["stats"], "source": source, "cached": True, "stale": False}
    try:
        bbox = tile_bbox(x, y, z)
        if source == "openbuildingmap":
            raw = fetch_openbuildingmap_buildings(x, y, z)
        elif source == "openstreetmap":
            raw = fetch_overpass_features(bbox)
        else:
            raw = fetch_overture_buildings(bbox)
        features = normalize_raw_features(raw)
        stats = tile_stats(features)
        CACHE.put_raw_tile(source, tile_id, features, stats, CONFIG.openbuildingmap_tile_ttl_days if source == "openbuildingmap" else None)
        return {"features": features, "stats": stats, "source": source, "cached": False, "stale": False}
    except Exception:
        if cached:
            return {"features": cached["features"], "stats": cached["stats"], "source": source, "cached": True, "stale": True}
        raise


def source_tile_with_fallback(x: int, y: int, z: int) -> dict[str, Any]:
    if CONFIG.openbuildingmap_api_url:
        try:
            primary = get_source_tile(x, y, z, "openbuildingmap")
            if primary["features"]:
                try:
                    reference = get_source_tile(x, y, z, "openstreetmap")
                    primary["features"].extend(feature for feature in reference["features"] if feature.get("properties", {}).get("kind") == "poi")
                    primary["calibrationFeatures"] = [feature for feature in reference["features"] if feature.get("properties", {}).get("kind") == "building"]
                    primary["cached"] = primary["cached"] and reference["cached"]
                    primary["stale"] = primary["stale"] or reference["stale"]
                except Exception as reference_error:
                    print(f"[tiles] OSM height reference failed for {quadkey(x, y, z)}: {reference_error}")
                return primary
        except Exception as mirror_error:
            print(f"[tiles] OpenBuildingMap mirror failed for {quadkey(x, y, z)}: {mirror_error}")
    try:
        osm = get_source_tile(x, y, z, "openstreetmap")
        if any(feature.get("properties", {}).get("kind") == "building" for feature in osm["features"]):
            return osm
        osm_pois = [feature for feature in osm["features"] if feature.get("properties", {}).get("kind") == "poi"]
        if not CONFIG.disable_overture:
            try:
                fallback = get_source_tile(x, y, z, "overture")
                if fallback["features"]:
                    fallback["features"].extend(osm_pois)
                    fallback["cached"] = fallback["cached"] and osm["cached"]
                    fallback["stale"] = fallback["stale"] or osm["stale"]
                    return fallback
            except Exception as overture_error:
                print(f"[tiles] Overture fallback failed for empty OSM tile {quadkey(x, y, z)}: {overture_error}")
        return osm
    except Exception as osm_error:
        if not CONFIG.disable_overture:
            try:
                fallback = get_source_tile(x, y, z, "overture")
                if fallback["features"]:
                    return fallback
            except Exception as overture_error:
                print(f"[tiles] Overture fallback failed for {quadkey(x, y, z)}: {overture_error}")
        raise ServiceError("Authoritative building enrichment is temporarily unavailable.", 503, getattr(osm_error, "retry_after", None)) from osm_error


def geometry_metrics(geometry: dict[str, Any]) -> dict[str, Any]:
    polygons = geometry["coordinates"] if geometry.get("type") == "MultiPolygon" else [geometry.get("coordinates", [])]
    area = perimeter = weighted_lon = weighted_lat = 0.0
    for polygon in polygons:
        outer = polygon[0] if polygon else []
        if len(outer) < 4:
            continue
        origin_lat = sum(point[1] for point in outer) / len(outer)
        projection = [(lon * math.pi * EARTH_RADIUS * math.cos(math.radians(origin_lat)) / 180, lat * math.pi * EARTH_RADIUS / 180) for lon, lat in outer]
        twice_area = cx = cy = 0.0
        for index in range(len(projection) - 1):
            x1, y1 = projection[index]; x2, y2 = projection[index + 1]
            cross = x1 * y2 - x2 * y1
            twice_area += cross; cx += (x1 + x2) * cross; cy += (y1 + y2) * cross
            perimeter += math.hypot(x2 - x1, y2 - y1)
        polygon_area = abs(twice_area) / 2
        if twice_area:
            center_lon = (cx / (3 * twice_area)) * 180 / (math.pi * EARTH_RADIUS * math.cos(math.radians(origin_lat)))
            center_lat = (cy / (3 * twice_area)) * 180 / (math.pi * EARTH_RADIUS)
        else:
            center_lon, center_lat = outer[len(outer) // 2]
        weight = max(polygon_area, 1)
        area += polygon_area; weighted_lon += center_lon * weight; weighted_lat += center_lat * weight
    return {"area": max(area, 1), "perimeter": max(perimeter, 1), "center": [weighted_lon / max(area, 1), weighted_lat / max(area, 1)]}


def distance_meters(first: list[float], second: list[float]) -> float:
    latitude = math.radians((first[1] + second[1]) / 2)
    x = math.radians(second[0] - first[0]) * math.cos(latitude)
    y = math.radians(second[1] - first[1])
    return EARTH_RADIUS * math.hypot(x, y)


def median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    middle = len(ordered) // 2
    return ordered[middle] if len(ordered) % 2 else (ordered[middle - 1] + ordered[middle]) / 2


def building_height_prior(building_type: str, metrics: dict[str, Any]) -> float:
    kind = building_type.lower()
    base = DEFAULT_HEIGHT
    for terms, value in [
        (("apartments", "apartment", "residential"), 14.0),
        (("office", "commercial"), 18.0),
        (("hotel",), 20.0),
        (("hospital",), 16.0),
        (("school", "college", "university"), 12.0),
        (("industrial", "warehouse", "shed", "garage"), 8.0),
        (("house", "detached", "bungalow", "hut"), 6.0),
        (("church", "mosque", "temple", "cathedral"), 14.0),
    ]:
        if any(term in kind for term in terms):
            base = value
            break
    footprint_adjustment = max(-2.0, min(14.0, math.log(max(metrics["area"], 1) / 100) * 3.2))
    return min(120.0, max(3.0, base + footprint_adjustment))


def known_height(properties: dict[str, Any]) -> tuple[float, str] | None:
    explicit = number(properties.get("realHeight"))
    if 1 < explicit < 1000:
        return explicit, "height"
    levels = number(properties.get("levels"))
    if 0 < levels < 200:
        return levels * 3.1, "levels"
    return None


def height_above_base(height: float, properties: dict[str, Any]) -> tuple[float, bool]:
    minimum = number(properties.get("minHeight")) + 0.5
    return (max(height, minimum), height < minimum)


class Grid:
    def __init__(self, entries: list[dict[str, Any]], reference_lat: float) -> None:
        self.cell_size = NEIGHBOR_RADIUS
        self.scale_x = 111_320 * max(0.2, math.cos(math.radians(reference_lat)))
        self.cells: dict[tuple[int, int], list[dict[str, Any]]] = {}
        for entry in entries:
            self.cells.setdefault(self.position(entry["metrics"]["center"]), []).append(entry)

    def position(self, center: list[float]) -> tuple[int, int]:
        return math.floor(center[0] * self.scale_x / self.cell_size), math.floor(center[1] * 110_540 / self.cell_size)

    def near(self, center: list[float]) -> list[dict[str, Any]]:
        x, y = self.position(center)
        candidates = [entry for dx in (-1, 0, 1) for dy in (-1, 0, 1) for entry in self.cells.get((x + dx, y + dy), [])]
        return [entry for entry in candidates if distance_meters(center, entry["metrics"]["center"]) <= NEIGHBOR_RADIUS]


def raw_vector(entry: dict[str, Any], known_grid: Grid, all_grid: Grid, city_center: list[float], exclude_self: bool = False) -> list[float]:
    neighbors = [candidate for candidate in known_grid.near(entry["metrics"]["center"]) if not exclude_self or candidate is not entry]
    metrics = entry["metrics"]
    return [
        math.log1p(metrics["area"]), metrics["perimeter"] / math.sqrt(metrics["area"]),
        median([neighbor["label"][0] for neighbor in neighbors]), math.log1p(distance_meters(metrics["center"], city_center)),
        math.log1p(len(all_grid.near(metrics["center"]))), math.log1p(building_height_prior(str(entry["feature"]["properties"].get("buildingType") or "unknown"), metrics)),
    ]


def fit_model(examples: list[dict[str, Any]]) -> dict[str, Any]:
    dimensions = len(examples[0]["vector"])
    means = [sum(example["vector"][index] for example in examples) / len(examples) for index in range(dimensions)]
    stddevs = [max(math.sqrt(sum((example["vector"][index] - means[index]) ** 2 for example in examples) / len(examples)), 0.001) for index in range(dimensions)]
    stride = max(1, math.ceil(len(examples) / 256))
    return {"stddevs": stddevs, "examples": examples[::stride][:256], "weights": [0.7, 0.35, 2.4, 0.5, 0.8, 0.65], "k": max(3, min(15, round(math.sqrt(len(examples))))), "sampleSize": len(examples)}


def predict(model: dict[str, Any], vector: list[float], building_type: str, prior: float) -> float:
    distances = []
    for example in model["examples"]:
        squared = 0.0 if example["buildingType"] == building_type else 1.2
        for index, value in enumerate(vector):
            delta = (value - example["vector"][index]) / model["stddevs"][index]
            squared += model["weights"][index] * delta * delta
        distances.append((math.sqrt(squared), example["height"]))
    nearest = sorted(distances)[:model["k"]]
    weighted = sum(height / max(distance, 0.05) ** 2 for distance, height in nearest)
    total = sum(1 / max(distance, 0.05) ** 2 for distance, _height in nearest)
    local_estimate = weighted / total
    local_weight = min(0.85, 0.35 + model["sampleSize"] / 120)
    return min(350, max(3, local_estimate * local_weight + prior * (1 - local_weight)))


def matching_reference(entry: dict[str, Any], references: list[dict[str, Any]]) -> tuple[float, str] | None:
    area = entry["metrics"]["area"]
    maximum_distance = min(30.0, max(8.0, math.sqrt(area) * 0.4))
    best: tuple[float, tuple[float, str]] | None = None
    for reference in references:
        reference_area = reference["metrics"]["area"]
        area_ratio = min(area, reference_area) / max(area, reference_area)
        if area_ratio < 0.45:
            continue
        distance = distance_meters(entry["metrics"]["center"], reference["metrics"]["center"])
        if distance > maximum_distance:
            continue
        score = distance / maximum_distance + (1 - area_ratio)
        if best is None or score < best[0]:
            best = (score, reference["label"])
    return best[1] if best and best[0] <= 0.75 else None


def hbet_estimate(entry: dict[str, Any], known_grid: Grid) -> tuple[float, str] | None:
    properties = entry["feature"]["properties"]
    level_range = estimated_level_range(properties.get("estimatedLevelRange"))
    if not level_range:
        return None
    low_levels, high_levels = level_range
    low_height, high_height = low_levels * 2.4, high_levels * 4.0
    source = str(properties.get("dataSource") or "")
    building_type = str(properties.get("buildingType") or "unknown").lower()
    community = normalize_query(str(properties.get("community") or ""))
    area = entry["metrics"]["area"]
    neighboring_heights = []
    for candidate in known_grid.near(entry["metrics"]["center"]):
        candidate_properties = candidate["feature"]["properties"]
        if candidate is entry or str(candidate_properties.get("dataSource") or "") != source:
            continue
        candidate_community = normalize_query(str(candidate_properties.get("community") or ""))
        distance = distance_meters(entry["metrics"]["center"], candidate["metrics"]["center"])
        if community:
            if candidate_community != community:
                continue
        elif candidate_community or distance > 80:
            continue
        candidate_type = str(candidate_properties.get("buildingType") or "unknown").lower()
        if building_type != "unknown" and candidate_type != "unknown" and candidate_type != building_type:
            continue
        area_ratio = min(area, candidate["metrics"]["area"]) / max(area, candidate["metrics"]["area"])
        if area_ratio < 0.55:
            continue
        height = candidate["label"][0]
        if low_height <= height <= high_height:
            neighboring_heights.append(height)
    if neighboring_heights:
        return min(high_height, max(low_height, median(neighboring_heights))), "hbet-range-neighbor"
    return (low_levels + high_levels) / 2 * 3.1, "hbet-range-midpoint"


def apply_heights(features: list[dict[str, Any]], city_center: list[float], calibration_features: list[dict[str, Any]] | None = None) -> tuple[list[dict[str, Any]], int]:
    output = copy.deepcopy(features)
    buildings = [feature for feature in output if feature.get("properties", {}).get("kind") == "building" and feature.get("geometry", {}).get("type") in {"Polygon", "MultiPolygon"}]
    if not buildings:
        return output, 0
    entries = [{"feature": feature, "metrics": geometry_metrics(feature["geometry"]), "label": known_height(feature["properties"])} for feature in buildings]
    calibration_entries = [
        {"feature": feature, "metrics": geometry_metrics(feature["geometry"]), "label": known_height(feature["properties"])}
        for feature in calibration_features or []
        if feature.get("properties", {}).get("kind") == "building" and feature.get("geometry", {}).get("type") in {"Polygon", "MultiPolygon"}
    ]
    reference_entries = [entry for entry in calibration_entries if entry["label"]]
    known = sorted((entry for entry in [*entries, *reference_entries] if entry["label"]), key=lambda entry: str(entry["feature"]["properties"].get("sourceId", "")))
    known_grid = Grid(known, city_center[1])
    all_grid = Grid([*entries, *calibration_entries], city_center[1])
    model = None
    if len(known) >= 3:
        examples = [{"vector": raw_vector(entry, known_grid, all_grid, city_center, True), "buildingType": str(entry["feature"]["properties"].get("buildingType") or "unknown").lower(), "height": entry["label"][0]} for entry in known]
        model = fit_model(examples)
    for entry in entries:
        properties = entry["feature"]["properties"]
        if entry["label"]:
            source = entry["label"][1]
            derived = source == "levels"
            height, adjusted_to_base = height_above_base(entry["label"][0], properties)
            properties.update({
                "height": round(height, 1), "heightSource": source,
                "heightKind": "source-derived" if derived else "measured",
                "heightConfidence": "medium" if derived else "high",
                "heightAdjustedToBase": adjusted_to_base,
                "inferred": derived,
            })
            continue
        reference = matching_reference(entry, reference_entries)
        if reference:
            height, adjusted_to_base = height_above_base(reference[0], properties)
            properties.update({
                "height": round(height, 1), "heightSource": f"osm-reference-{reference[1]}",
                "heightKind": "matched", "heightConfidence": "low", "heightAdjustedToBase": adjusted_to_base,
                "inferred": True,
            })
            continue
        hbet = hbet_estimate(entry, known_grid)
        if hbet:
            height, adjusted_to_base = height_above_base(hbet[0], properties)
            properties.update({
                "height": round(height, 1),
                "heightSource": hbet[1], "heightKind": "estimated-range",
                "heightConfidence": "medium" if hbet[1] == "hbet-range-neighbor" else "low", "heightAdjustedToBase": adjusted_to_base,
                "inferred": True,
            })
            continue
        vector = raw_vector(entry, known_grid, all_grid, city_center)
        local_median = vector[2]
        building_type = str(properties.get("buildingType") or "unknown").lower()
        prior = building_height_prior(building_type, entry["metrics"])
        if model:
            estimate = predict(model, vector, building_type, prior)
        elif local_median:
            estimate = local_median * 0.65 + prior * 0.35
        else:
            estimate = prior
        height, adjusted_to_base = height_above_base(estimate, properties)
        properties.update({
            "height": round(height, 1),
            "heightSource": "inferred", "heightKind": "inferred",
            "heightConfidence": "medium" if model else "low", "heightAdjustedToBase": adjusted_to_base,
            "inferred": True,
        })
    return output, len(known)


def render_features(features: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    seen: set[str] = set()
    for feature in features:
        geometry = feature.get("geometry") or {}
        props = feature.get("properties") or {}
        if props.get("kind") == "poi":
            if geometry.get("type") != "Point":
                continue
        elif geometry.get("type") not in {"Polygon", "MultiPolygon", "LineString", "MultiLineString"}:
            continue
        output = {
            "sourceId": str(props.get("sourceId") or ""), "kind": str(props.get("kind") or ""), "buildingType": str(props.get("buildingType") or ""),
            "roadClass": str(props.get("roadClass") or ""), "source": str(props.get("dataSource") or props.get("source") or ""),
            "height": number(props.get("height")), "minHeight": number(props.get("minHeight")), "levels": number(props.get("levels")), "heightSource": str(props.get("heightSource") or ""), "heightKind": str(props.get("heightKind") or ""), "heightConfidence": str(props.get("heightConfidence") or ""), "heightAdjustedToBase": 1 if props.get("heightAdjustedToBase") else 0, "inferred": 1 if props.get("inferred") else 0,
            "poiCategory": str(props.get("poiCategory") or ""), "name": str(props.get("name") or "")[:160], "community": str(props.get("community") or "")[:160], "estimatedLevelRange": list(estimated_level_range(props.get("estimatedLevelRange")) or ()),
        }
        key = f"{output['source']}:{output['sourceId']}:{output['kind']}"
        if output["sourceId"] and key in seen:
            continue
        seen.add(key)
        result.append({"type": "Feature", "geometry": geometry, "properties": output})
    return result


def get_tile(x: int, y: int, z: int, city_center: list[float]) -> dict[str, Any]:
    source_tile = source_tile_with_fallback(x, y, z)
    enriched, model_size = apply_heights(source_tile["features"], city_center, source_tile.get("calibrationFeatures"))
    features = render_features(enriched)
    return {"features": features, "source": source_tile["source"], "cached": source_tile["cached"], "stale": source_tile["stale"], "stats": {**tile_stats(features), "inferredCount": sum(feature["properties"]["inferred"] == 1 for feature in features), "modelSampleSize": model_size}}


def tile_response_headers(tile: dict[str, Any]) -> dict[str, str]:
    stats = tile["stats"]
    return {
        "X-Cache": "HIT" if tile["cached"] else "MISS",
        "X-Data-Source": str(tile["source"]),
        "X-Data-Stale": "1" if tile["stale"] else "0",
        "X-Height-Prediction": "transient",
        "X-Feature-Count": str(stats["featureCount"]),
        "X-Building-Count": str(stats["buildingCount"]),
        "X-Place-Count": str(stats["poiCount"]),
        "X-Inferred-Building-Count": str(stats["inferredCount"]),
        "X-Height-Model-Sample-Size": str(stats["modelSampleSize"]),
    }


def parse_number(value: str | None) -> float | None:
    try:
        parsed = float(value) if value is not None else None
        return parsed if parsed is not None and math.isfinite(parsed) else None
    except ValueError:
        return None


def limited_request(method: Callable[..., Any]) -> Callable[..., Any]:
    @functools.wraps(method)
    def wrapped(handler: Any, *args: Any, **kwargs: Any) -> Any:
        if not REQUEST_GATE.acquire(blocking=False):
            handler.send_json(503, {"error": "The local data service is busy. Try again shortly."}, {"Retry-After": "1"})
            return None
        try:
            return method(handler, *args, **kwargs)
        finally:
            REQUEST_GATE.release()

    return wrapped


class ApiHandler(BaseHTTPRequestHandler):
    server_version = "MonumentPython/1.0"

    def log_message(self, format: str, *args: Any) -> None:
        print(f"[{datetime.now(timezone.utc).isoformat()}] {self.address_string()} {format % args}")

    def cors_origin(self) -> str:
        origins = [origin.strip() for origin in CONFIG.allowed_origins.split(",") if origin.strip()]
        origin = self.headers.get("Origin", "")
        if "*" in origins:
            return "*"
        return origin if origin in origins else origins[0] if origins else ""

    def send_json(self, status: int, body: dict[str, Any] | list[Any] | None, headers: dict[str, str] | None = None) -> None:
        payload = b"" if body is None else json.dumps(body, separators=(",", ":")).encode("utf-8")
        response_headers = dict(headers or {})
        try:
            self.send_response(status)
            self.send_header("Access-Control-Allow-Origin", self.cors_origin())
            self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Expose-Headers", "X-Cache, X-Data-Source, X-Data-Stale, X-Height-Prediction, X-Feature-Count, X-Building-Count, X-Place-Count, X-Inferred-Building-Count, X-Height-Model-Sample-Size, Retry-After")
            self.send_header("Vary", "Origin")
            if body is not None:
                self.send_header("Content-Type", "application/geo+json" if response_headers.pop("geojson", None) else "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(payload)))
            for key, value in response_headers.items():
                self.send_header(key, value)
            self.end_headers()
            if payload:
                self.wfile.write(payload)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            # Browsers abort stale tile requests while the server is still fetching data.
            return

    @limited_request
    def do_OPTIONS(self) -> None:
        self.send_json(204, None)

    def read_json_body(self, maximum_bytes: int = 32_768) -> dict[str, Any]:
        try:
            length = int(self.headers.get("Content-Length") or "")
        except ValueError:
            raise ServiceError("A valid Content-Length header is required.", 400) from None
        if length < 1 or length > maximum_bytes:
            raise ServiceError(f"Request bodies must be between 1 and {maximum_bytes} bytes.", 413)
        try:
            body = json.loads(self.rfile.read(length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ServiceError("Request body must be valid JSON.", 400) from None
        if not isinstance(body, dict):
            raise ServiceError("Request body must be a JSON object.", 400)
        return body

    def handle_error(self, error: Exception) -> None:
        if isinstance(error, ServiceError):
            headers = {"Retry-After": str(error.retry_after)} if error.retry_after else None
            self.send_json(error.status, {"error": str(error)}, headers)
            return
        print(f"Unhandled API error: {error}")
        self.send_json(500, {"error": "The data service failed."})

    @limited_request
    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)
        try:
            if parsed.path == "/api/health":
                self.send_json(200, {"ok": True, "cache": "sqlite", "tileZoom": TILE_ZOOM, "overtureRelease": CONFIG.overture_release, "openBuildingMap": bool(CONFIG.openbuildingmap_api_url), "agent": {"available": AGENT.available, "socketPort": CONFIG.socket_port}, "routing": {"provider": "openstreetmap-dijkstra", "profile": CONFIG.osm_router_profile, "osrmFallback": True, "serpFallbackEnabled": CONFIG.enable_serp_directions_fallback}})
                return
            if parsed.path == "/api/suggest":
                value = query.get("q", [""])[0].strip()[:160]
                self.send_json(200, {"results": suggest_map_locations(value, query.get("countryCode", [""])[0]) if len(value) >= 2 else []})
                return
            if parsed.path == "/api/geocode":
                value = query.get("q", [""])[0].strip()[:160]
                if not value:
                    raise ServiceError("Enter a city or place name.", 400)
                result = resolve_location(value, query.get("countryCode", [""])[0])
                if not result:
                    raise ServiceError("Location not found.", 404)
                self.send_json(200, {"result": result})
                return
            if parsed.path == "/api/country":
                self.send_json(200, detect_country(parse_number(query.get("lat", [None])[0]), parse_number(query.get("lon", [None])[0])))
                return
            if parsed.path == "/api/context":
                lat = parse_number(query.get("lat", [None])[0])
                lon = parse_number(query.get("lon", [None])[0])
                if (lat is None) != (lon is None) or (lat is not None and not valid_coordinate(lon, lat)):
                    raise ServiceError("Context coordinates must include a valid longitude and latitude.", 400)
                country = detect_country(lat, lon)
                self.send_json(200, {"country": country, "precision": "browser" if lat is not None else "ip", "lat": lat, "lon": lon})
                return
            if parsed.path == "/api/places":
                value = query.get("q", [""])[0].strip()[:160]
                if len(value) < 2:
                    raise ServiceError("Enter at least two characters to find a place.", 400)
                lat = parse_number(query.get("lat", [None])[0])
                lon = parse_number(query.get("lon", [None])[0])
                if (lat is None) != (lon is None) or (lat is not None and not valid_coordinate(lon, lat)):
                    raise ServiceError("Place context coordinates must include a valid longitude and latitude.", 400)
                provider = query.get("provider", [""])[0].strip().lower()
                if provider:
                    raise ServiceError("Direct provider selection is not supported; place discovery always starts with OpenStreetMap.", 400)
                discovery = lookup_places(value, query.get("countryCode", [""])[0], lat, lon)
                self.send_json(200, discovery)
                return
            if parsed.path == "/api/places/suggest":
                value = query.get("q", [""])[0].strip()[:160]
                self.send_json(200, {"results": local_place_suggestions(value)})
                return
            if parsed.path == "/api/places/stored":
                west = parse_number(query.get("west", [None])[0])
                south = parse_number(query.get("south", [None])[0])
                east = parse_number(query.get("east", [None])[0])
                north = parse_number(query.get("north", [None])[0])
                if west is None or south is None or east is None or north is None:
                    raise ServiceError("Stored-place bounds must be valid west, south, east, and north coordinates.", 400)
                if not valid_coordinate(west, south) or not valid_coordinate(east, north) or south > north:
                    raise ServiceError("Stored-place bounds must be valid west, south, east, and north coordinates.", 400)
                places, truncated = CACHE.list_places_in_bounds(west, south, east, north)
                self.send_json(200, {"places": places, "truncated": truncated})
                return
            if parsed.path == "/api/workspace":
                self.send_json(200, workspace_snapshot())
                return
            route_match = re.fullmatch(r"/api/routes/(route-[A-Za-z0-9]+)", parsed.path)
            if route_match:
                route = CACHE.get_route_by_id(route_match.group(1))
                if not route:
                    raise ServiceError("Route not found.", 404)
                self.send_json(200, {"route": route})
                return
            match = re.fullmatch(r"/api/tiles/(\d+)/(\d+)/(\d+)\.geojson", parsed.path)
            if match:
                z, x, y = (int(value) for value in match.groups())
                maximum = 2 ** z
                if z != TILE_ZOOM or x < 0 or y < 0 or x >= maximum or y >= maximum:
                    raise ServiceError(f"Only valid z{TILE_ZOOM} tiles are supported.", 400)
                requested_lon, requested_lat = parse_number(query.get("lon", [None])[0]), parse_number(query.get("lat", [None])[0])
                if requested_lon is None or requested_lat is None:
                    bbox = tile_bbox(x, y, z)
                    city_center = [(bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2]
                else:
                    city_center = [requested_lon, requested_lat]
                tile = get_tile(x, y, z, city_center)
                headers = {**tile_response_headers(tile), "Cache-Control": "no-store"}
                self.send_json(204, None, headers) if not tile["features"] else self.send_json(200, {"type": "FeatureCollection", "features": tile["features"]}, {**headers, "geojson": "1"})
                return
            raise ServiceError("Not found.", 404)
        except Exception as error:
            self.handle_error(error)

    @limited_request
    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        try:
            body = self.read_json_body()
            if parsed.path == "/api/agent/runs":
                run_id = AGENT.start_run(str(body.get("sessionId") or ""), body.get("message"), body.get("mapContext"))
                self.send_json(202, {"accepted": True, "runId": run_id})
                return
            if parsed.path == "/api/agent/undo":
                self.send_json(200, AGENT.undo_run(body.get("sessionId"), body.get("runId")))
                return
            if parsed.path == "/api/pins":
                point = valid_coordinate(body.get("lon"), body.get("lat"))
                if not point:
                    raise ServiceError("A pin needs a valid longitude and latitude.", 400)
                name = str(body.get("name") or "Pinned location").strip()
                if not name:
                    raise ServiceError("A pin needs a name.", 400)
                source = str(body.get("source") or "map-click")
                if source not in {"map-click", "place", "browser"}:
                    raise ServiceError("Unsupported pin source.", 400)
                place_id = body.get("placeId")
                if place_id is not None and not isinstance(place_id, str):
                    raise ServiceError("Pin placeId must be a string.", 400)
                pin = CACHE.add_pin(name, point[1], point[0], place_id, source)
                self.send_json(201, {"pin": pin})
                return
            if parsed.path == "/api/areas":
                geometry = valid_polygon(body.get("geometry"))
                if not geometry:
                    raise ServiceError("An area must be a valid closed GeoJSON polygon.", 400)
                label = str(body.get("label") or "Measured area").strip()
                summary = area_summary(geometry, body.get("summary"))
                area = CACHE.add_area(label, geometry, summary)
                self.send_json(201, {"area": area})
                return
            area_match = re.fullmatch(r"/api/areas/(area-[A-Za-z0-9]+)", parsed.path)
            if area_match:
                geometry = valid_polygon(body.get("geometry"))
                if not geometry:
                    raise ServiceError("An area must be a valid closed GeoJSON polygon.", 400)
                label = str(body.get("label") or "Measured area").strip()
                summary = area_summary(geometry, body.get("summary"))
                area = CACHE.update_area(area_match.group(1), label, geometry, summary)
                if not area:
                    raise ServiceError("Area not found.", 404)
                self.send_json(200, {"area": area})
                return
            if parsed.path == "/api/routes":
                waypoints = route_waypoints(body.get("waypoints"))
                profile = str(body.get("profile") or CONFIG.osm_router_profile)
                route = get_route(waypoints, profile)
                self.send_json(200, {"route": route})
                return
            if parsed.path == "/api/workspace/state":
                self.send_json(200, {"state": save_workspace_state(body.get("state"))})
                return
            raise ServiceError("Not found.", 404)
        except Exception as error:
            self.handle_error(error)

    @limited_request
    def do_DELETE(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        try:
            if parsed.path == "/api/workspace":
                CACHE.clear_workspace()
                self.send_json(204, None)
                return
            pin_match = re.fullmatch(r"/api/pins/(pin-[A-Za-z0-9]+)", parsed.path)
            if pin_match:
                if not CACHE.delete_pin(pin_match.group(1)):
                    raise ServiceError("Pin not found.", 404)
                self.send_json(204, None)
                return
            area_match = re.fullmatch(r"/api/areas/(area-[A-Za-z0-9]+)", parsed.path)
            if area_match:
                if not CACHE.delete_area(area_match.group(1)):
                    raise ServiceError("Area not found.", 404)
                self.send_json(204, None)
                return
            raise ServiceError("Not found.", 404)
        except Exception as error:
            self.handle_error(error)


def main() -> None:
    if not is_loopback_host(CONFIG.host):
        raise SystemExit("Monument is a local-only service. HOST must be localhost, 127.0.0.1, or ::1.")
    try:
        REALTIME.start()
    except RuntimeError as error:
        raise SystemExit(str(error)) from error
    server = ThreadingHTTPServer((CONFIG.host, CONFIG.port), ApiHandler)
    print(f"Monument Python API listening at http://{CONFIG.host}:{CONFIG.port}")
    print(f"Monument agent socket listening at ws://{CONFIG.host}:{CONFIG.socket_port}")

    def shutdown(_signal: int, _frame: Any) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)
    try:
        server.serve_forever()
    finally:
        REALTIME.stop()
        server.server_close()
        CACHE.close()


if __name__ == "__main__":
    main()
