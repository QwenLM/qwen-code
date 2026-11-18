from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest
from qwen_code_sdk import Query, QueryOptions, SDKUserMessage, TimeoutOptions
from test_query_core import VALID_UUID, FakeTransport, _wait_for_request


class DelayedInitializeTransport(FakeTransport):
    """Hold initialization and answer later controls without a CLI process."""

    def write(self, data: str) -> None:
        super().write(data)
        request = self.writes[-1]
        if request.get("type") != "control_request":
            return
        subtype = request["request"]["subtype"]
        if subtype != "initialize":
            self.push(
                {
                    "type": "control_response",
                    "response": {
                        "subtype": "success",
                        "request_id": request["request_id"],
                        "response": {"answered": subtype},
                    },
                }
            )


def make_query(transport: FakeTransport, prompt_kind: str) -> Query:
    async def input_messages() -> AsyncIterator[SDKUserMessage]:
        yield {
            "type": "user",
            "session_id": VALID_UUID,
            "message": {"role": "user", "content": "independent prompt"},
            "parent_tool_use_id": None,
        }

    return Query(
        transport=transport,  # type: ignore[arg-type]
        options=QueryOptions(timeout=TimeoutOptions(control_request=2.0)),
        prompt="independent prompt" if prompt_kind == "single" else input_messages(),
        session_id=VALID_UUID,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("prompt_kind", ["single", "stream"])
@pytest.mark.parametrize("cancel_waiter", [False, True])
async def test_cancelling_one_waiter_preserves_other_callers_and_input(
    prompt_kind: str, cancel_waiter: bool
) -> None:
    transport = DelayedInitializeTransport()
    result = make_query(transport, prompt_kind)
    first = asyncio.create_task(result.supported_commands())
    calls = [first]
    try:
        init = await _wait_for_request(transport, "initialize")
        independent = asyncio.create_task(result.mcp_server_status())
        calls.append(independent)
        await asyncio.sleep(0)
        assert not first.done() and not independent.done()
        if cancel_waiter:
            first.cancel()
            with pytest.raises(asyncio.CancelledError):
                await first

        transport.push(
            {
                "type": "control_response",
                "response": {
                    "subtype": "success",
                    "request_id": init["request_id"],
                    "response": {},
                },
            }
        )
        _, pending = await asyncio.wait(calls, timeout=1.0)
        assert not pending
        assert not independent.cancelled()
        assert independent.result() == {"answered": "mcp_server_status"}
        if not cancel_waiter:
            assert first.result() == {"answered": "supported_commands"}
        assert await result.get_available_models() == {
            "answered": "get_available_models"
        }
        assert sum(message.get("type") == "user" for message in transport.writes) == 1
        assert not result.is_closed() and not transport.closed
    finally:
        for call in calls:
            if not call.done():
                call.cancel()
        await asyncio.gather(*calls, return_exceptions=True)
        await result.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("prompt_kind", ["single", "stream"])
@pytest.mark.parametrize("termination", ["close", "initialization_error"])
async def test_initialization_waiters_stop_when_the_query_closes(
    prompt_kind: str, termination: str
) -> None:
    transport = DelayedInitializeTransport()
    result = make_query(transport, prompt_kind)
    call: asyncio.Task[Any] = asyncio.create_task(result.supported_commands())
    try:
        init = await _wait_for_request(transport, "initialize")
        if termination == "close":
            await result.close()
        else:
            transport.push(
                {
                    "type": "control_response",
                    "response": {
                        "subtype": "error",
                        "request_id": init["request_id"],
                        "error": "initialization rejected",
                    },
                }
            )
        assert result._input_task is not None
        _, pending = await asyncio.wait([call, result._input_task], timeout=0.2)
        assert not pending
        assert call.cancelled() or isinstance(call.exception(), RuntimeError)
        assert result._input_task.cancelled() or result._input_task.exception() is None
        assert result.is_closed() and transport.closed
        assert len(transport.writes) == 1
        assert result._initialize_task is not None and result._initialize_task.done()
    finally:
        if not call.done():
            call.cancel()
        await asyncio.gather(call, return_exceptions=True)
        await result.close()
