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
async def test_permission_request_passes_blocked_path_to_callback() -> None:
    transport = FakeTransport()
    captured_context: dict[str, Any] | None = None

    async def can_use_tool(
        tool_name: str,
        tool_input: dict[str, Any],
        context: dict[str, Any],
    ) -> dict[str, Any]:
        nonlocal captured_context
        assert tool_name == "write_file"
        assert tool_input["path"] == "demo.txt"
        captured_context = context
        return {"behavior": "deny", "message": "blocked"}

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
            "request_id": "incoming-2",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "write_file",
                "tool_use_id": "tool-2",
                "input": {"path": "demo.txt", "content": "hello"},
                "permission_suggestions": [],
                "blocked_path": "/tmp/demo.txt",
            },
        }
    )

    response = await _wait_for_control_response(transport, "incoming-2")

    assert captured_context is not None
    assert isinstance(captured_context["cancel_event"], asyncio.Event)
    assert captured_context["suggestions"] == []
    assert captured_context["blocked_path"] == "/tmp/demo.txt"
    assert response["response"]["subtype"] == "success"
    assert response["response"]["response"] == {
        "behavior": "deny",
        "message": "blocked",
    }
    await query.close()


@pytest.mark.asyncio
async def test_permission_request_cancelled_callback_returns_deny() -> None:
    transport = FakeTransport()

    async def can_use_tool(
        tool_name: str,
        tool_input: dict[str, Any],
        context: dict[str, Any],
    ) -> dict[str, Any]:
        assert tool_name == "write_file"
        assert tool_input["path"] == "demo.txt"
        assert isinstance(context["cancel_event"], asyncio.Event)
        raise asyncio.CancelledError()

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
            "request_id": "incoming-3",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "write_file",
                "tool_use_id": "tool-3",
                "input": {"path": "demo.txt", "content": "hello"},
                "permission_suggestions": [],
                "blocked_path": None,
            },
        }
    )

    response = await _wait_for_control_response(transport, "incoming-3")

    assert response["response"]["subtype"] == "success"
    assert response["response"]["response"] == {
        "behavior": "deny",
        "message": "Permission check failed: callback cancelled",
    }
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


@pytest.mark.asyncio
async def test_ensure_started_raises_after_close() -> None:
    transport = FakeTransport()
    query = await _start_query(transport)

    await query.close()

    with pytest.raises(RuntimeError, match="Query is closed"):
        await query.supported_commands()


@pytest.mark.asyncio
async def test_anext_after_exhaustion_raises_stop_async_iteration() -> None:
    """After the async iterator is exhausted, subsequent __anext__ calls must
    raise StopAsyncIteration immediately instead of blocking."""
    transport = FakeTransport()
    query = await _start_query(transport)

    # Deliver one assistant message, then a result to end the turn.
    transport.push(
        {
            "type": "assistant",
            "session_id": VALID_UUID,
            "message": {
                "role": "assistant",
                "content": [{"type": "text", "text": "hi"}],
            },
        }
    )
    transport.push(
        {
            "type": "result",
            "session_id": VALID_UUID,
            "result": "done",
            "is_error": False,
            "duration_ms": 10,
            "duration_api_ms": 5,
            "num_turns": 1,
        }
    )
    # Signal end of transport stream so the router finishes naturally.
    await transport.close()

    # Consume all messages until exhaustion.
    messages: list[Any] = []
    with pytest.raises(StopAsyncIteration):
        while True:
            messages.append(await query.__anext__())

    assert len(messages) >= 1

    # The iterator is now exhausted — a second call must raise immediately.
    with pytest.raises(StopAsyncIteration):
        await query.__anext__()


@pytest.mark.asyncio
async def test_initialize_failure_no_unhandled_task_exception(
    recwarn: pytest.WarningsChecker,
) -> None:
    """When _initialize fails, no 'Task exception was never retrieved' warning
    should appear — _finish_with_error already surfaces the error."""
    transport = FakeTransport()
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

    # Let the initialize request time out — this triggers _finish_with_error
    # inside _initialize.
    init_request = await _wait_for_request(transport, "initialize")
    assert init_request is not None  # init was sent

    # Don't respond to initialize — let the control-request timeout fire.
    # The error propagates through _message_queue.
    with pytest.raises(ControlRequestTimeoutError):
        await query.__anext__()

    await query.close()

    # Give the event loop a moment to report any unhandled task exceptions.
    await asyncio.sleep(0.1)

    # No "Task exception was never retrieved" warnings should have appeared.
    task_warnings = [w for w in recwarn.list if "never retrieved" in str(w.message)]
    assert task_warnings == []


@pytest.mark.asyncio
async def test_async_context_manager_closes_on_exit() -> None:
    transport = FakeTransport()
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

    async with query as q:
        assert q is query
        assert not q.is_closed()

    assert query.is_closed() is True


def test_sync_next_after_exhaustion_raises_stop_iteration() -> None:
    """After the sync iterator is exhausted, subsequent __next__ calls must
    raise StopIteration immediately instead of blocking on queue.get()."""
    from queue import Queue

    from qwen_code_sdk.sync_query import _STOP, SyncQuery

    # Build a minimal SyncQuery without spawning the real event-loop thread.
    sq = object.__new__(SyncQuery)
    sq._queue = Queue()
    sq._exhausted = False

    # Put one message then the sentinel.
    msg_payload = {
        "type": "assistant",
        "message": {"role": "assistant", "content": []},
    }
    sq._queue.put(msg_payload)
    sq._queue.put(_STOP)

    # First call returns the message.
    msg = next(sq)
    assert msg["type"] == "assistant"

    # Second call should exhaust.
    with pytest.raises(StopIteration):
        next(sq)

    # Third call must raise immediately, not block.
    with pytest.raises(StopIteration):
        next(sq)
