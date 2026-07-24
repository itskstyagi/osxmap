"""Dedicated local WebSocket bridge for agent lifecycle events.

The HTTP API remains authoritative. This module only transports short-lived
agent status, clarification, and map-update events to a browser session.
"""

from __future__ import annotations

import asyncio
import importlib
import json
import threading
from dataclasses import dataclass
from typing import Any, Callable
from urllib.parse import urlparse

try:
    from .config import Config, is_loopback_host
except ImportError:  # Supports `python server.py` from the backend directory.
    from config import Config, is_loopback_host

try:
    serve = importlib.import_module("websockets.asyncio.server").serve
except ImportError:  # The HTTP API can still be imported before dependencies are installed.
    serve = None


MAX_MESSAGE_BYTES = 32_768


@dataclass
class SocketSession:
    session_id: str
    websocket: Any


class RealtimeHub:
    """Owns one small loopback-only WebSocket listener and browser sessions."""

    def __init__(self, config: Config) -> None:
        self.config = config
        self._sessions: dict[str, SocketSession] = {}
        self._lock = threading.RLock()
        self._loop: asyncio.AbstractEventLoop | None = None
        self._server: Any = None
        self._thread: threading.Thread | None = None
        self._ready = threading.Event()
        self._start_error: Exception | None = None
        self._message_handler: Callable[[str, dict[str, Any]], None] | None = None

    def set_message_handler(self, handler: Callable[[str, dict[str, Any]], None]) -> None:
        self._message_handler = handler

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        if serve is None:
            raise RuntimeError("Install backend requirements before starting the agent socket service.")
        self._ready.clear()
        self._start_error = None
        self._thread = threading.Thread(target=self._run, name="monument-agent-socket", daemon=True)
        self._thread.start()
        if not self._ready.wait(5):
            raise RuntimeError("The agent socket service did not start.")
        if self._start_error:
            raise RuntimeError("The agent socket service could not bind its loopback port.") from self._start_error

    def _run(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        self._loop = loop
        try:
            assert serve is not None
            self._server = loop.run_until_complete(self._create_server())
        except Exception as error:
            self._start_error = error
            self._ready.set()
            loop.close()
            return
        self._ready.set()
        loop.run_forever()
        if self._server:
            self._server.close()
            loop.run_until_complete(self._server.wait_closed())
        loop.close()

    async def _create_server(self) -> Any:
        assert serve is not None
        return await serve(self._handle_connection, self.config.host, self.config.socket_port, max_size=MAX_MESSAGE_BYTES)

    def stop(self) -> None:
        loop = self._loop
        if not loop or loop.is_closed():
            return
        future = asyncio.run_coroutine_threadsafe(self._close_all(), loop)
        try:
            future.result(timeout=3)
        except Exception:
            pass
        loop.call_soon_threadsafe(loop.stop)

    async def _close_all(self) -> None:
        with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        for session in sessions:
            try:
                await session.websocket.close(code=1001, reason="Server shutting down")
            except Exception:
                continue

    def has_session(self, session_id: str) -> bool:
        with self._lock:
            return session_id in self._sessions

    def publish(self, session_id: str, event: dict[str, Any]) -> bool:
        loop = self._loop
        if not loop or loop.is_closed() or not self.has_session(session_id):
            return False
        try:
            asyncio.run_coroutine_threadsafe(self._send(session_id, event), loop)
            return True
        except RuntimeError:
            return False

    async def _send(self, session_id: str, event: dict[str, Any]) -> None:
        with self._lock:
            session = self._sessions.get(session_id)
        if not session:
            return
        try:
            await session.websocket.send(json.dumps(event, separators=(",", ":")))
        except Exception:
            self._remove_session(session_id, session.websocket)

    def _origin_allowed(self, origin: str) -> bool:
        if not origin:
            return False
        configured = [value.strip() for value in self.config.allowed_origins.split(",") if value.strip()]
        if "*" not in configured:
            return origin in configured
        parsed = urlparse(origin)
        return parsed.scheme in {"http", "https"} and is_loopback_host(parsed.hostname or "")

    @staticmethod
    def _origin(websocket: Any) -> str:
        request = getattr(websocket, "request", None)
        headers = getattr(request, "headers", None)
        if headers is None:
            headers = getattr(websocket, "request_headers", {})
        return str(headers.get("Origin", ""))

    async def _handle_connection(self, websocket: Any, _path: str | None = None) -> None:
        if not self._origin_allowed(self._origin(websocket)):
            await websocket.close(code=1008, reason="Loopback browser origin required")
            return
        session_id = ""
        try:
            async for raw_message in websocket:
                if not isinstance(raw_message, str) or len(raw_message.encode("utf-8")) > MAX_MESSAGE_BYTES:
                    await websocket.close(code=1009, reason="Message too large")
                    return
                try:
                    message = json.loads(raw_message)
                except json.JSONDecodeError:
                    await websocket.send(json.dumps({"v": 1, "type": "error", "error": "Message must be valid JSON."}))
                    continue
                if not isinstance(message, dict):
                    await websocket.send(json.dumps({"v": 1, "type": "error", "error": "Message must be an object."}))
                    continue
                if message.get("type") == "session.open":
                    candidate = str(message.get("sessionId") or "")
                    if len(candidate) < 20 or len(candidate) > 128:
                        await websocket.send(json.dumps({"v": 1, "type": "error", "error": "Invalid browser session."}))
                        continue
                    session_id = candidate
                    self._register_session(session_id, websocket)
                    await websocket.send(json.dumps({"v": 1, "type": "session.ready", "sessionId": session_id}))
                    continue
                if message.get("type") == "ping":
                    await websocket.send(json.dumps({"v": 1, "type": "pong"}))
                    continue
                if session_id and self._message_handler:
                    self._message_handler(session_id, message)
        finally:
            if session_id:
                self._remove_session(session_id, websocket)

    def _register_session(self, session_id: str, websocket: Any) -> None:
        with self._lock:
            previous = self._sessions.get(session_id)
            self._sessions[session_id] = SocketSession(session_id, websocket)
        if previous and previous.websocket is not websocket:
            asyncio.create_task(previous.websocket.close(code=4001, reason="Session reconnected"))

    def _remove_session(self, session_id: str, websocket: Any) -> None:
        with self._lock:
            current = self._sessions.get(session_id)
            if current and current.websocket is websocket:
                self._sessions.pop(session_id, None)
