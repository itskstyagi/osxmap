"""Asynchronous agent orchestration for the AI-powered map."""

from __future__ import annotations

import json
import threading
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

try:
    from .agent_tools import AGENT_TOOL_SCHEMAS, AgentRunContext, AgentTools
    from .errors import ServiceError
except ImportError:  # Supports `python server.py` from the backend directory.
    from agent_tools import AGENT_TOOL_SCHEMAS, AgentRunContext, AgentTools
    from errors import ServiceError


SYSTEM_PROMPT = """You are Monument Map Agent. Build trustworthy interactive maps from the user's request.

Use tools for every city, place, coordinate, and road route. Never invent a venue, coordinate, route, opening hour, rating, traffic condition, weather condition, or safety claim. Use search_places for nearby places; it already prefers local and OpenStreetMap data and automatically uses configured Serp fallback only when necessary.

Use present_map after finding results to draw them. Use plan_route only with returned trusted references. For adventurous or chaotic road trips, first find interesting detour stops, then plan a normal driving route through them; describe it as an interest-led detour, not a scenic or safety guarantee. Use ask_user only if an essential city, origin, destination, or preference is ambiguous. Use clear_map only when the user clearly asks to clear/reset the map.

Keep explanations short. The map is the primary answer."""


class AgentCancelled(Exception):
    pass


class ChatCompletionsClient(Protocol):
    @property
    def available(self) -> bool: ...

    def complete(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]: ...


class AgentEventHub(Protocol):
    def set_message_handler(self, handler: Callable[[str, dict[str, Any]], None]) -> None: ...

    def has_session(self, session_id: str) -> bool: ...

    def publish(self, session_id: str, event: dict[str, Any]) -> bool: ...


@dataclass
class AgentSession:
    history: list[dict[str, str]] = field(default_factory=list)


@dataclass
class AgentRun:
    run_id: str
    session_id: str
    cancelled: threading.Event = field(default_factory=threading.Event)


class MapAgentService:
    """Runs bounded model/tool loops and emits only validated map updates."""

    def __init__(self, client: ChatCompletionsClient, tools: AgentTools, realtime: AgentEventHub) -> None:
        self.client = client
        self.tools = tools
        self.realtime = realtime
        self._sessions: dict[str, AgentSession] = {}
        self._runs: dict[str, AgentRun] = {}
        self._lock = threading.RLock()
        self._gate = threading.BoundedSemaphore(2)
        self.realtime.set_message_handler(self.handle_socket_message)

    @property
    def available(self) -> bool:
        return self.client.available

    def start_run(self, session_id: str, message: Any, map_context: Any) -> str:
        if not self.available:
            raise ServiceError("AI map configuration is incomplete.", 503)
        if not isinstance(session_id, str) or not self.realtime.has_session(session_id):
            raise ServiceError("Connect the map-agent socket before sending a request.", 409)
        prompt = str(message or "").strip()
        if not 1 <= len(prompt) <= 2_000:
            raise ServiceError("Map requests must be between 1 and 2000 characters.", 400)
        if not self._gate.acquire(blocking=False):
            raise ServiceError("The map agent is busy. Try again shortly.", 503, 2)
        run = AgentRun(run_id=f"agent-run-{uuid.uuid4().hex}", session_id=session_id)
        with self._lock:
            self._runs[run.run_id] = run
            self._sessions.setdefault(session_id, AgentSession())
        thread = threading.Thread(target=self._run, args=(run, prompt, map_context), name=run.run_id, daemon=True)
        thread.start()
        return run.run_id

    def handle_socket_message(self, session_id: str, message: dict[str, Any]) -> None:
        if message.get("type") != "agent.cancel":
            return
        run_id = str(message.get("runId") or "")
        with self._lock:
            run = self._runs.get(run_id)
        if run and run.session_id == session_id:
            run.cancelled.set()

    def _run(self, run: AgentRun, prompt: str, raw_map_context: Any) -> None:
        try:
            self._emit(run, "agent.started")
            self._emit(run, "agent.status", stage="thinking", label="Understanding your map request")
            context = self.tools.new_context(raw_map_context if isinstance(raw_map_context, dict) else None)
            with self._lock:
                session = self._sessions.setdefault(run.session_id, AgentSession())
                history = list(session.history[-12:])
            messages: list[dict[str, Any]] = [{"role": "system", "content": SYSTEM_PROMPT}, *history, {"role": "user", "content": prompt}]
            final_message = ""
            for _ in range(8):
                self._check_cancelled(run)
                assistant = self.client.complete(messages, AGENT_TOOL_SCHEMAS)
                tool_calls = assistant.get("tool_calls")
                content = str(assistant.get("content") or "").strip()
                if not isinstance(tool_calls, list) or not tool_calls:
                    final_message = content or "Your map is ready."
                    self._remember(run.session_id, prompt, final_message)
                    self._emit(run, "agent.completed", message=final_message)
                    return
                messages.append({"role": "assistant", "content": content or None, "tool_calls": tool_calls})
                for call in tool_calls:
                    self._check_cancelled(run)
                    result = self._execute_tool(run, context, call)
                    name = str((call.get("function") or {}).get("name") or "") if isinstance(call, dict) else ""
                    if "mapUpdate" in result:
                        self._emit(run, "agent.map", update=result["mapUpdate"])
                    if name == "ask_user":
                        self._remember(run.session_id, prompt, result["question"])
                        self._emit(run, "agent.question", question=result["question"], choices=result["choices"])
                        return
                    messages.append({
                        "role": "tool",
                        "tool_call_id": str(call.get("id") or "tool-call"),
                        "content": json.dumps(self._model_tool_result(result), separators=(",", ":")),
                    })
            raise ServiceError("The map agent reached its tool limit. Please make the request more specific.", 503)
        except AgentCancelled:
            self._emit(run, "agent.cancelled")
        except ServiceError as error:
            self._emit(run, "agent.failed", error=str(error), retryAfter=error.retry_after)
        except Exception as error:
            # Preserve a useful local diagnostic without sending implementation details to the browser.
            detail = " ".join(str(error).split())[:360]
            print(f"[agent] {run.run_id} failed with {type(error).__name__}: {detail or 'no error detail'}")
            self._emit(run, "agent.failed", error="The map agent hit an internal error before it could update the map.")
        finally:
            with self._lock:
                self._runs.pop(run.run_id, None)
            self._gate.release()

    def _execute_tool(self, run: AgentRun, context: AgentRunContext, call: Any) -> dict[str, Any]:
        if not isinstance(call, dict) or not isinstance(call.get("function"), dict):
            raise ServiceError("The AI map provider requested an invalid tool call.", 503)
        function = call["function"]
        name = str(function.get("name") or "")
        try:
            arguments = json.loads(str(function.get("arguments") or "{}"))
        except json.JSONDecodeError:
            raise ServiceError("The AI map provider sent invalid tool arguments.", 503) from None
        if not isinstance(arguments, dict):
            raise ServiceError("The AI map provider sent invalid tool arguments.", 503)
        self._emit(run, "agent.status", stage=name, label=self.tools.stage_label(name))
        return self.tools.execute(context, name, arguments)

    @staticmethod
    def _model_tool_result(result: dict[str, Any]) -> dict[str, Any]:
        output = dict(result)
        output.pop("mapUpdate", None)
        return output

    def _emit(self, run: AgentRun, event_type: str, **payload: Any) -> None:
        self.realtime.publish(run.session_id, {"v": 1, "type": event_type, "runId": run.run_id, **payload})

    @staticmethod
    def _check_cancelled(run: AgentRun) -> None:
        if run.cancelled.is_set():
            raise AgentCancelled()

    def _remember(self, session_id: str, user_message: str, assistant_message: str) -> None:
        with self._lock:
            session = self._sessions.setdefault(session_id, AgentSession())
            session.history.extend([
                {"role": "user", "content": user_message},
                {"role": "assistant", "content": assistant_message},
            ])
            del session.history[:-12]
