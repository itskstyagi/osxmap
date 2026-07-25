"""Runtime configuration and local-only environment loading."""

from __future__ import annotations

import ipaddress
import os
from dataclasses import dataclass
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parent.parent
BACKEND_DIR = Path(__file__).resolve().parent
PROCESS_ENV_KEYS = set(os.environ)


def load_env_file(path: Path, override: bool = False) -> None:
    """Load simple KEY=VALUE files without overriding explicit process values."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if (override and key not in PROCESS_ENV_KEYS) or key not in os.environ:
            os.environ[key] = value


load_env_file(ROOT_DIR / ".env")
load_env_file(BACKEND_DIR / ".env", override=True)


def root_path(value: str, default: Path) -> Path:
    if not value:
        return default
    path = Path(value)
    return path if path.is_absolute() else (ROOT_DIR / path).resolve()


def optional_float(value: str) -> float | None:
    text = value.strip()
    if not text:
        return None
    return max(0.0, min(1.0, float(text)))


def optional_token_limit(value: str) -> int:
    text = value.strip()
    return max(0, min(2_000, int(text))) if text else 0


def is_loopback_host(value: str) -> bool:
    host = value.strip().lower().strip("[]")
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class Config:
    host: str = os.getenv("HOST", "127.0.0.1")
    port: int = int(os.getenv("PORT", "8787"))
    database_path: Path = root_path(os.getenv("DATABASE_PATH", ""), BACKEND_DIR / "data" / "monument.db")
    user_agent: str = os.getenv(
        "APP_USER_AGENT", "MonoCityExplorer/1.0 (local-development; configure a contact before public traffic)"
    )
    allowed_origins: str = os.getenv("ALLOWED_ORIGINS", "*")
    overpass_endpoint: str = os.getenv("OVERPASS_ENDPOINT", "https://overpass-api.de/api/interpreter")
    overpass_backoff_seconds: int = max(1, int(os.getenv("OVERPASS_BACKOFF_SECONDS", "120")))
    overture_release: str = os.getenv("OVERTURE_RELEASE", "2026-06-17.0")
    overture_path: str = os.getenv("OVERTURE_BUILDINGS_PATH", "")
    disable_overture: bool = os.getenv("DISABLE_OVERTURE", "0") == "1"
    openbuildingmap_api_url: str = os.getenv("OPENBUILDINGMAP_API_URL", "").rstrip("/")
    openbuildingmap_tile_ttl_days: int = int(os.getenv("OPENBUILDINGMAP_TILE_TTL_DAYS", "7"))
    duckdb_path: Path = root_path(os.getenv("DUCKDB_PATH", ""), ROOT_DIR / "__duckdb" / "duckdb.exe")
    tile_ttl_days: int = int(os.getenv("TILE_TTL_DAYS", "90"))
    geocode_ttl_days: int = int(os.getenv("GEOCODE_TTL_DAYS", "30"))
    suggestion_ttl_days: int = int(os.getenv("SUGGESTION_TTL_DAYS", "7"))
    max_buildings_per_tile: int = int(os.getenv("MAX_BUILDINGS_PER_TILE", "20000"))
    serp_api_key: str = os.getenv("SERP_API_KEY", "")
    osm_place_search_radius_meters: int = max(500, min(25_000, int(os.getenv("OSM_PLACE_SEARCH_RADIUS_METERS", "5000"))))
    osm_router_base_url: str = os.getenv("OSM_ROUTER_BASE_URL", "https://router.project-osrm.org").rstrip("/")
    osm_router_profile: str = os.getenv("OSM_ROUTER_PROFILE", "driving")
    osm_router_timeout_seconds: int = max(1, int(os.getenv("OSM_ROUTER_TIMEOUT_SECONDS", "12")))
    enable_serp_directions_fallback: bool = os.getenv("ENABLE_SERP_DIRECTIONS_FALLBACK", "0") == "1"
    max_concurrent_requests: int = max(1, int(os.getenv("MAX_CONCURRENT_REQUESTS", "8")))
    openai_base_url: str = os.getenv("OPENAI_BASE_URL", "").rstrip("/")
    openai_api_key: str = os.getenv("OPENAI_API_KEY", "")
    model_name: str = os.getenv("MODEL_NAME", "")
    # OpenAI-compatible gateways vary in which generation controls they accept.
    # Keep them opt-in so an Azure/LiteLLM deployment works with its native defaults.
    agent_max_tokens: int = optional_token_limit(os.getenv("AGENT_MAX_TOKENS", ""))
    agent_temperature: float | None = optional_float(os.getenv("AGENT_TEMPERATURE", ""))

    @property
    def socket_port(self) -> int:
        """Keep socket configuration deterministic without another secret/config key."""
        return self.port + 1

    @property
    def agent_available(self) -> bool:
        return bool(self.openai_base_url and self.openai_api_key and self.model_name)
