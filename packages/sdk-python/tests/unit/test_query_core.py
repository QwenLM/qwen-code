from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any, cast

import pytest
from qwen_code_sdk.errors import AbortError, ControlRequestTimeoutError
from qwen_code_sdk.json_lines import parse_json_line
from qwen_code_sdk.query import Query
from qwen_code_sdk.types import QueryOptions, TimeoutOptions

VALID_UUID = "123e4567-e89b-12d3-a456-426614174000"
_EOF = object()


class FakeTransport:
    def __init__(self) -> None:
        self.writes: list[dict[str, Any]] = []
        self.exit_error: Exception | None = None
        self.closed = False
        self.close_calls = 0
        self.input_closed = False
        self._queue: asyncio.Queue[dict[str, Any] | object] = asyncio.Queue()

    async def start(self) -> None:
        return None

    def write(self, data: str) -> None:
        self.writes.append(parse_json_line(data))

    async def drain(self) -> None:
        return None

    def end_input(self) -> None:
        self.input_closed = True

    async def read_messages(self):  # type: ignore[no-untyped-def]
        while True:
            item = await self._queue.get()
            if item is _EOF:
                break
            yield item

    async def close(self) -> None:
        self.closed = True
        self.close_calls += 1
        self.input_closed = True
        self._queue.put_nowait(_EOF)

    def push(self, payload: dict[str, Any]) -> None:
        self._queue.put_nowait(payload)


async def _wait_for(predicate: Callable[[], bool], timeout: float = 1.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out waiting for test condition")


async def _wait_for_request(
    transport: FakeTransport,
    subtype: str,
    timeout: float = 1.0,
) -> dict[str, Any]:
    await _wait_for(
        lambda: any(
            payload.get("type") == "control_request"
            and payload.get("request", {}).get("subtype") == subtype
            for payload in transport.writes
        ),
        timeout=timeout,
    )
    for payload in transport.writes:
        if (
            payload.get("type") == "control_request"
            and payload.get("request", {}).get("subtype") == subtype
        ):
            return payload
    raise AssertionError(f"missing control request: {subtype}")


async def _wait_for_control_response(
    transport: FakeTransport,
    request_id: str,
    timeout: float = 1.0,
) -> dict[str, Any]:
    await _wait_for(
        lambda: any(
            payload.get("type") == "control_response"
            and payload.get("response", {}).get("request_id") == request_id
            for payload in transport.writes
        ),
        timeout=timeout,
    )
    for payload in transport.writes:
        if (
            payload.get("type") == "control_response"
            and payload.get("response", {}).get("request_id") == request_id
        ):
            return payload
    raise AssertionError(f"missing control response: {request_id}")


async def _start_query(transport: FakeTransport) -> Query:
    query = Query(
        transport=transport,  # type: ignore[arg-type]
        options=QueryOptions(
            timeout=TimeoutOptions(
                can_use_tool=0.05,
                control_request=0.05,
                stream_close=0.05,
            )
        ),
        prompt="hello",
        session_id=VALID_UUID,
    )
    await query._ensure_started()

    init_request = await _wait_for_request(transport, "initialize")
    transport.push(
        {
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": init_request["request_id"],
                "response": {},
            },
        }
    )
    await _wait_for(
        lambda: any(payload.get("type") == "user" for payload in transport.writes)
    )
    return query


@pytest.mark.asyncio
async def test_unknown_control_request_returns_error_response() -> None:
    transport = FakeTransport()
    query = await _start_query(transport)

    transport.push(
        {
            "type": "control_request",
            "request_id": "unknown-1",
            "request": {
                "subtype": "something_new",
            },
        }
    )

    response = await _wait_for_control_response(transport, "unknown-1")

    assert response["response"]["subtype"] == "error"
    assert "Unknown control request subtype" in response["response"]["error"]
    await query.close()


@pytest.mark.asyncio
async def test_control_request_times_out() -> None:
    transport = FakeTransport()
    query = await _start_query(transport)

    with pytest.raises(ControlRequestTimeoutError, match="supported_commands"):
        await query.supported_commands()

    await query.close()


@pytest.mark.asyncio
async def test_control_request_cancel_propagates_abort_error() -> None:
    transport = FakeTransport()
    query = await _start_query(transport)

    task = asyncio.create_task(query.supported_commands())
    request = await _wait_for_request(transport, "supported_commands")
    transport.push(
        {
            "type": "control_cancel_request",
            "request_id": request["request_id"],
        }
    )

    with pytest.raises(AbortError, match="Control request cancelled"):
        await task

    await query.close()


@pytest.mark.asyncio
async def test_incoming_control_request_cancel_does_not_block_router() -> None:
    transport = FakeTransport()
    started = asyncio.Event()
    cancelled = asyncio.Event()
    captured_cancel_events: list[asyncio.Event] = []

    async def can_use_tool(
        tool_name: str,
        tool_input: dict[str, Any],
        context: dict[str, Any],
    ) -> dict[str, Any]:
        assert tool_name == "write_file"
        assert tool_input["path"] == "demo.txt"
        cancel_event = cast(asyncio.Event, context["cancel_event"])
        captured_cancel_events.append(cancel_event)
        started.set()
        try:
            await cancel_event.wait()
            cancelled.set()
            return {"behavior": "deny", "message": "Cancelled"}
        except asyncio.CancelledError:
            if cancel_event.is_set():
                cancelled.set()
            raise

    query = Query(
        transport=transport,  # type: ignore[arg-type]
        options=QueryOptions(
            can_use_tool=can_use_tool,
            timeout=TimeoutOptions(
                can_use_tool=1.0,
                control_request=0.2,
                stream_close=0.05,
            ),
        ),
        prompt="hello",
        session_id=VALID_UUID,
    )
    await query._ensure_started()

    init_request = await _wait_for_request(transport, "initialize")
    transport.push(
        {
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": init_request["request_id"],
                "response": {},
            },
        }
    )
    await _wait_for(
        lambda: any(payload.get("type") == "user" for payload in transport.writes)
    )

    transport.push(
        {
            "type": "control_request",
            "request_id": "incoming-1",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "write_file",
                "tool_use_id": "tool-1",
                "input": {"path": "demo.txt", "content": "hello"},
                "permission_suggestions": [],
                "blocked_path": None,
            },
        }
    )

    await _wait_for(lambda: started.is_set())
    assert captured_cancel_events[0] is not query._cancel_event

    supported_commands_task = asyncio.create_task(query.supported_commands())
    supported_request = await _wait_for_request(transport, "supported_commands")

    transport.push(
        {
            "type": "control_cancel_request",
            "request_id": "incoming-1",
        }
    )
    await _wait_for(lambda: cancelled.is_set())

    transport.push(
        {
            "type": "control_response",
            "response": {
                "subtype": "success",
                "request_id": supported_request["request_id"],
                "response": {"commands": ["supported_commands"]},
            },
        }
    )

    assert await supported_commands_task == {"commands": ["supported_commands"]}
    assert all(
        not (
            payload.get("type") == "control_response"
            and payload.get("response", {}).get("request_id") == "incoming-1"
        )
        for payload in transport.writes
    )
    await query.close()


@pytest.mark.asyncio
async def test_finish_with_error_closes_transport_and_fails_pending_requests() -> None:
    transport = FakeTransport()
    query = await _start_query(transport)

    supported_commands_task = asyncio.create_task(query.supported_commands())
    await _wait_for_request(transport, "supported_commands")

    await query._finish_with_error(RuntimeError("boom"))

    with pytest.raises(RuntimeError, match="boom"):
        await supported_commands_task

    assert query.is_closed() is True
    assert transport.closed is True
