"""Async Query implementation for qwen_code_sdk."""

from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterable, Mapping, MutableMapping
from dataclasses import dataclass, replace
from types import TracebackType
from typing import Any, cast
from uuid import uuid4

from .errors import AbortError, ControlRequestTimeoutError
from .json_lines import serialize_json_line
from .protocol import (
    CLIControlRequest,
    CLIControlResponse,
    SDKMessage,
    SDKUserMessage,
    is_control_cancel,
    is_control_request,
    is_control_response,
    is_sdk_assistant_message,
    is_sdk_partial_assistant_message,
    is_sdk_result_message,
    is_sdk_system_message,
    is_sdk_user_message,
)
from .transport import ProcessTransport
from .types import (
    CanUseToolContext,
    PermissionDenyResult,
    QueryOptions,
    QueryOptionsDict,
)
from .validation import validate_query_options

_DONE = object()


@dataclass
class _PendingControlRequest:
    future: asyncio.Future[dict[str, Any] | None]
    cancel_event: asyncio.Event
    timeout_handle: asyncio.TimerHandle


@dataclass
class _IncomingControlRequest:
    task: asyncio.Task[None]
    cancel_event: asyncio.Event


class Query:
    def __init__(
        self,
        transport: ProcessTransport,
        options: QueryOptions,
        prompt: str | AsyncIterable[SDKUserMessage],
        session_id: str,
    ) -> None:
        self._transport = transport
        self._options = options
        self._prompt = prompt
        self._single_turn = isinstance(prompt, str)
        self._session_id = session_id
        self._session_id_locked = bool(options.resume or options.session_id)

        self._message_queue: asyncio.Queue[SDKMessage | Exception | object] = (
            asyncio.Queue()
        )
        self._closed = False
        self._started = False
        self._start_lock = asyncio.Lock()
        self._cancel_event = asyncio.Event()

        self._router_task: asyncio.Task[None] | None = None
        self._input_task: asyncio.Task[None] | None = None
        self._initialize_task: asyncio.Task[None] | None = None
        self._first_result_event = asyncio.Event()
        self._terminal_event_sent = False

        self._pending_control_requests: dict[str, _PendingControlRequest] = {}
        self._incoming_control_requests: dict[str, _IncomingControlRequest] = {}

    async def _ensure_started(self) -> None:
        if self._closed:
            raise RuntimeError("Query is closed")
        if self._started:
            return

        async with self._start_lock:
            if self._closed:
                raise RuntimeError("Query is closed")
            if self._started:
                return
            await self._transport.start()
            self._router_task = asyncio.create_task(self._message_router())
            self._initialize_task = asyncio.create_task(self._initialize())

            if self._single_turn:
                self._input_task = asyncio.create_task(self._send_single_turn_prompt())
            else:
                self._input_task = asyncio.create_task(
                    self.stream_input(self._prompt)  # type: ignore[arg-type]
                )
            self._started = True

    async def _initialize(self) -> None:
        try:
            payload: dict[str, Any] = {"hooks": None}
            if self._options.mcp_servers:
                payload["mcpServers"] = self._options.mcp_servers
            await self._send_control_request("initialize", payload)
        except Exception as exc:
            await self._finish_with_error(exc)
            raise

    async def _send_single_turn_prompt(self) -> None:
        try:
            assert isinstance(self._prompt, str)
            await self._wait_initialized()
            message: SDKUserMessage = {
                "type": "user",
                "session_id": self._session_id,
                "message": {
                    "role": "user",
                    "content": self._prompt,
                },
                "parent_tool_use_id": None,
            }

            await self._write_payload(message)
        except Exception as exc:
            await self._finish_with_error(exc)
            raise

    async def _wait_initialized(self) -> None:
        if self._initialize_task is None:
            return
        await self._initialize_task

    async def _message_router(self) -> None:
        try:
            async for message in self._transport.read_messages():
                await self._route_message(message)
                if self._closed:
                    break

            if self._closed:
                return

            if self._transport.exit_error is not None:
                await self._finish_with_error(self._transport.exit_error)
                return

            await self._finish()
        except Exception as exc:  # pragma: no cover - critical propagation path
            await self._finish_with_error(exc)

    async def _route_message(self, message: Any) -> None:
        self._maybe_update_session_id(message)

        if is_control_request(message):
            self._start_incoming_control_request(message)
            return

        if is_control_response(message):
            self._handle_control_response(message)
            return

        if is_control_cancel(message):
            self._handle_control_cancel_request(message)
            return

        if is_sdk_result_message(message):
            self._first_result_event.set()
            if self._single_turn:
                self._transport.end_input()
            await self._message_queue.put(message)
            return

        if (
            is_sdk_system_message(message)
            or is_sdk_assistant_message(message)
            or is_sdk_user_message(message)
            or is_sdk_partial_assistant_message(message)
        ):
            await self._message_queue.put(message)
            return

    def _maybe_update_session_id(self, message: Any) -> None:
        if self._session_id_locked or not isinstance(message, Mapping):
            return

        session_id = message.get("session_id")
        if isinstance(session_id, str) and session_id:
            self._session_id = session_id
            self._session_id_locked = True

    def _start_incoming_control_request(self, request: CLIControlRequest) -> None:
        request_id = request["request_id"]
        cancel_event = asyncio.Event()

        async def runner() -> None:
            try:
                await self._handle_control_request(request, cancel_event)
            except asyncio.CancelledError:
                pass
            except Exception as exc:  # pragma: no cover - fatal background path
                await self._finish_with_error(exc)
            finally:
                self._incoming_control_requests.pop(request_id, None)

        task = asyncio.create_task(runner())
        self._incoming_control_requests[request_id] = _IncomingControlRequest(
            task=task,
            cancel_event=cancel_event,
        )

    async def _handle_control_request(
        self,
        request: CLIControlRequest,
        cancel_event: asyncio.Event,
    ) -> None:
        request_id = request["request_id"]
        payload = request["request"]
        subtype = payload.get("subtype")

        try:
            if subtype == "can_use_tool":
                response = await self._handle_permission_request(
                    cast(MutableMapping[str, Any], payload),
                    cancel_event,
                )
            elif subtype == "mcp_message":
                raise RuntimeError("mcp_message is unsupported in python sdk v1")
            else:
                raise RuntimeError(f"Unknown control request subtype: {subtype}")

            if cancel_event.is_set():
                return

            await self._send_control_response(
                request_id, success=True, response=response
            )
        except Exception as exc:
            if cancel_event.is_set():
                return
            await self._send_control_response(
                request_id,
                success=False,
                response=str(exc),
            )

    async def _handle_permission_request(
        self,
        payload: MutableMapping[str, Any],
        cancel_event: asyncio.Event,
    ) -> dict[str, Any]:
        tool_name = str(payload.get("tool_name", ""))
        tool_input = payload.get("input")
        if not isinstance(tool_input, dict):
            tool_input = {}

        if self._options.can_use_tool is None:
            return {"behavior": "deny", "message": "Denied"}

        context: CanUseToolContext = {
            "cancel_event": cancel_event,
            "suggestions": payload.get("permission_suggestions"),
        }

        try:
            result = await asyncio.wait_for(
                self._options.can_use_tool(tool_name, tool_input, context),
                timeout=self._options.timeout.can_use_tool,
            )
        except asyncio.TimeoutError:
            return {
                "behavior": "deny",
                "message": "Permission request timed out",
            }
        except Exception as exc:
            return {
                "behavior": "deny",
                "message": f"Permission check failed: {exc}",
            }

        behavior = result.get("behavior")
        if behavior == "allow":
            return {
                "behavior": "allow",
                "updatedInput": result.get("updatedInput", tool_input),
            }

        deny_result = cast(PermissionDenyResult, result)
        return {
            "behavior": "deny",
            "message": deny_result.get("message", "Denied"),
            **(
                {"interrupt": deny_result["interrupt"]}
                if "interrupt" in deny_result
                else {}
            ),
        }

    def _handle_control_response(self, response: CLIControlResponse) -> None:
        payload = response["response"]
        request_id = payload["request_id"]

        pending = self._pending_control_requests.pop(request_id, None)
        if pending is None:
            return

        pending.timeout_handle.cancel()

        if payload["subtype"] == "success":
            if not pending.future.done():
                pending.future.set_result(payload.get("response"))
        else:
            error = payload.get("error", "Unknown control error")
            if isinstance(error, dict):
                error_message = str(error.get("message", "Unknown control error"))
            else:
                error_message = str(error)
            if not pending.future.done():
                pending.future.set_exception(RuntimeError(error_message))

    def _handle_control_cancel_request(self, message: Mapping[str, Any]) -> None:
        request_id = message.get("request_id")
        if not isinstance(request_id, str):
            return

        pending = self._pending_control_requests.pop(request_id, None)
        if pending is not None:
            pending.timeout_handle.cancel()
            pending.cancel_event.set()
            if not pending.future.done():
                pending.future.set_exception(
                    AbortError("Control request cancelled")
                )

        incoming = self._incoming_control_requests.get(request_id)
        if incoming is None:
            return

        incoming.cancel_event.set()
        incoming.task.cancel()

    async def _send_control_request(
        self,
        subtype: str,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any] | None:
        if self._closed:
            raise RuntimeError("Query is closed")

        if subtype != "initialize":
            await self._wait_initialized()

        request_id = str(uuid4())

        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any] | None] = loop.create_future()
        cancel_event = asyncio.Event()

        def on_timeout() -> None:
            pending = self._pending_control_requests.pop(request_id, None)
            if pending is None:
                return
            pending.cancel_event.set()
            if not pending.future.done():
                pending.future.set_exception(
                    ControlRequestTimeoutError(f"Control request timeout: {subtype}")
                )

        timeout_handle = loop.call_later(
            self._options.timeout.control_request,
            on_timeout,
        )

        self._pending_control_requests[request_id] = _PendingControlRequest(
            future=future,
            cancel_event=cancel_event,
            timeout_handle=timeout_handle,
        )

        request_payload: dict[str, Any] = {"subtype": subtype}
        if data:
            request_payload.update(data)

        payload: CLIControlRequest = {
            "type": "control_request",
            "request_id": request_id,
            "request": request_payload,
        }

        await self._write_payload(payload)
        return await future

    async def _send_control_response(
        self,
        request_id: str,
        *,
        success: bool,
        response: Any,
    ) -> None:
        payload: CLIControlResponse
        if success:
            payload = {
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": request_id,
                    "response": response,
                },
            }
        else:
            payload = {
                "type": "control_response",
                "response": {
                    "subtype": "error",
                    "request_id": request_id,
                    "error": str(response),
                },
            }

        await self._write_payload(payload)

    async def _write_payload(self, payload: Any) -> None:
        self._transport.write(serialize_json_line(payload))
        await self._transport.drain()

    async def stream_input(self, messages: AsyncIterable[SDKUserMessage]) -> None:
        try:
            if self._closed:
                raise RuntimeError("Query is closed")

            await self._wait_initialized()

            async for message in messages:
                if self._cancel_event.is_set() or self._closed:
                    break
                await self._write_payload(message)

            if not self._single_turn:
                try:
                    await asyncio.wait_for(
                        self._first_result_event.wait(),
                        timeout=self._options.timeout.stream_close,
                    )
                except asyncio.TimeoutError:
                    pass

                self._transport.end_input()
        except Exception as exc:
            await self._finish_with_error(exc)
            raise

    async def interrupt(self) -> None:
        await self._ensure_started()
        await self._send_control_request("interrupt")

    async def set_permission_mode(self, mode: str) -> None:
        await self._ensure_started()
        await self._send_control_request("set_permission_mode", {"mode": mode})

    async def set_model(self, model: str) -> None:
        await self._ensure_started()
        await self._send_control_request("set_model", {"model": model})

    async def supported_commands(self) -> dict[str, Any] | None:
        await self._ensure_started()
        return await self._send_control_request("supported_commands")

    async def mcp_server_status(self) -> dict[str, Any] | None:
        await self._ensure_started()
        return await self._send_control_request("mcp_server_status")

    def get_session_id(self) -> str:
        return self._session_id

    def is_closed(self) -> bool:
        return self._closed

    def _fail_pending_control_requests(self, error: Exception) -> None:
        for request_id, pending in list(self._pending_control_requests.items()):
            pending.timeout_handle.cancel()
            pending.cancel_event.set()
            if not pending.future.done():
                pending.future.set_exception(error)
            self._pending_control_requests.pop(request_id, None)

    async def _cancel_incoming_control_requests(self) -> None:
        current_task = asyncio.current_task()
        tasks: list[asyncio.Task[None]] = []

        for incoming in list(self._incoming_control_requests.values()):
            incoming.cancel_event.set()
            if incoming.task is current_task:
                continue
            incoming.task.cancel()
            tasks.append(incoming.task)

        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def close(self) -> None:
        if self._closed:
            return

        self._closed = True
        self._cancel_event.set()

        error = RuntimeError("Query is closed")
        self._fail_pending_control_requests(error)
        await self._cancel_incoming_control_requests()

        await self._transport.close()

        if self._input_task is not None:
            self._input_task.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._input_task

        if self._router_task is not None:
            with contextlib.suppress(Exception):
                await self._router_task

        await self._finish()

    async def _finish(self) -> None:
        if self._terminal_event_sent:
            return
        self._terminal_event_sent = True
        await self._message_queue.put(_DONE)

    async def _finish_with_error(self, exc: Exception) -> None:
        if self._terminal_event_sent:
            return
        self._closed = True
        self._terminal_event_sent = True
        self._cancel_event.set()
        self._fail_pending_control_requests(exc)
        await self._cancel_incoming_control_requests()
        await self._transport.close()
        await self._message_queue.put(exc)
        await self._message_queue.put(_DONE)

    def __aiter__(self) -> Query:
        return self

    async def __anext__(self) -> SDKMessage:
        await self._ensure_started()
        item = await self._message_queue.get()

        if item is _DONE:
            raise StopAsyncIteration

        if isinstance(item, Exception):
            raise item

        return cast(SDKMessage, item)

    async def __aenter__(self) -> Query:
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc_val: BaseException | None,
        exc_tb: TracebackType | None,
    ) -> None:
        await self.close()


def query(
    prompt: str | AsyncIterable[SDKUserMessage],
    options: QueryOptions | QueryOptionsDict | Mapping[str, Any] | None = None,
) -> Query:
    if isinstance(options, QueryOptions):
        parsed_options = replace(options)
    else:
        parsed_options = QueryOptions.from_mapping(options)

    validate_query_options(parsed_options)

    session_id = parsed_options.resume or parsed_options.session_id or str(uuid4())
    if parsed_options.resume is None and not parsed_options.continue_session:
        parsed_options.session_id = session_id

    transport = ProcessTransport(parsed_options)
    return Query(transport, parsed_options, prompt, session_id)
