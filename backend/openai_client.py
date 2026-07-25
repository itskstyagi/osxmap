"""Small OpenAI-compatible Chat Completions client used by the map agent."""

from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

try:
    from .config import Config
    from .errors import ServiceError
except ImportError:  # Supports `python server.py` from the backend directory.
    from config import Config
    from errors import ServiceError


class OpenAIChatClient:
    """Calls an OpenAI-compatible /chat/completions endpoint without exposing secrets."""

    def __init__(self, config: Config) -> None:
        self.config = config

    @property
    def available(self) -> bool:
        return self.config.agent_available

    def complete(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        if not self.available:
            raise ServiceError("AI map configuration is incomplete.", 503)
        base_url = self.config.openai_base_url
        endpoint = base_url if base_url.endswith("/chat/completions") else f"{base_url}/chat/completions"
        payload = {
            "model": self.config.model_name,
            "messages": messages,
            "tools": tools,
            "tool_choice": "auto",
        }
        if self.config.agent_temperature is not None:
            payload["temperature"] = self.config.agent_temperature
        if self.config.agent_max_tokens:
            # Azure reasoning deployments commonly reject `max_tokens`; only
            # send their modern completion limit when an operator opts in.
            payload["max_completion_tokens"] = self.config.agent_max_tokens
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        if len(body) > 512_000:
            raise ServiceError("The map-agent request is too large.", 413)
        request = urllib.request.Request(
            endpoint,
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.config.openai_api_key}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=45) as response:
                raw = response.read(2_000_000)
        except urllib.error.HTTPError as error:
            detail = self._error_detail(error)
            if error.code == 429:
                raise ServiceError(f"The AI map provider is busy{detail}. Try again shortly.", 503, 15) from error
            if error.code in {401, 403}:
                raise ServiceError(f"The AI map provider rejected the configured credentials{detail}.", 503) from error
            raise ServiceError(f"The AI map provider rejected the request (HTTP {error.code}){detail}.", 503) from error
        except (urllib.error.URLError, TimeoutError) as error:
            raise ServiceError("The AI map provider is unavailable.", 503) from error
        try:
            response = json.loads(raw.decode("utf-8"))
            message = response["choices"][0]["message"]
        except (KeyError, TypeError, IndexError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise ServiceError("The AI map provider returned an invalid response.", 503) from error
        if not isinstance(message, dict):
            raise ServiceError("The AI map provider returned an invalid response.", 503)
        return message

    def _error_detail(self, error: urllib.error.HTTPError) -> str:
        """Extract a small, credential-redacted provider explanation for the local UI."""
        try:
            raw = error.read(16_384).decode("utf-8", errors="replace")
            payload = json.loads(raw)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            return ""
        value: Any = payload.get("error") if isinstance(payload, dict) else None
        if isinstance(value, dict):
            value = value.get("message") or value.get("detail") or value.get("error")
        if value is None and isinstance(payload, dict):
            value = payload.get("message") or payload.get("detail")
        if not isinstance(value, str):
            return ""
        message = " ".join(value.split())
        if self.config.openai_api_key:
            message = message.replace(self.config.openai_api_key, "[redacted]")
        return f": {message[:280]}" if message else ""
