from __future__ import annotations

import asyncio
import gc
from dataclasses import replace
from typing import Any

import pytest
from test_query_core import FakeTransport, _start_query, _wait_for


def _reply(request_id: str) -> dict[str, Any]:
    return {
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": {"commands": ["independent"]},
        },
    }


@pytest.mark.asyncio
async def test_cancelled_requests_preserve_independent_replies() -> None:
    transport = FakeTransport()
    result = await _start_query(transport)
    result._options.timeout = replace(result._options.timeout, control_request=2)
    tasks = [asyncio.create_task(result.supported_commands()) for _ in range(17)]
    try:
        await _wait_for(lambda: len(result._pending_control_requests) == 17)
        requests = list(result._pending_control_requests.items())
        for task in tasks[:-1]:
            task.cancel()
        outcomes = await asyncio.gather(*tasks[:-1], return_exceptions=True)
        assert all(isinstance(outcome, asyncio.CancelledError) for outcome in outcomes)
        assert list(result._pending_control_requests) == [requests[-1][0]]
        assert all(p.timeout_handle.cancelled() for _, p in requests[:-1])
        assert all(p.future.cancelled() for _, p in requests[:-1])
        assert not result.is_closed()

        for request_id, _ in requests[:-1]:
            transport.push(_reply(request_id))
        transport.push(_reply(requests[-1][0]))
        assert await asyncio.wait_for(tasks[-1], timeout=1) == {
            "commands": ["independent"]
        }
        assert not result._pending_control_requests

        tasks.append(asyncio.create_task(result.supported_commands()))
        await _wait_for(lambda: len(result._pending_control_requests) == 1)
        transport.push(_reply(next(iter(result._pending_control_requests))))
        assert await asyncio.wait_for(tasks[-1], timeout=1) == {
            "commands": ["independent"]
        }
        assert not result._pending_control_requests
    finally:
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await result.close()


class FailingWriteTransport(FakeTransport):
    fail_at: str | None = None

    def write(self, data: str) -> None:
        if self.fail_at == "write":
            self.fail_at = None
            raise ConnectionResetError("controlled write failure")
        super().write(data)

    async def drain(self) -> None:
        if self.fail_at == "drain":
            self.fail_at = None
            raise ConnectionResetError("controlled drain failure")


@pytest.mark.asyncio
@pytest.mark.parametrize("fail_at", ["write", "drain"])
async def test_failed_write_releases_request_without_delayed_warning(
    fail_at: str,
) -> None:
    transport = FailingWriteTransport()
    result = await _start_query(transport)
    loop = asyncio.get_running_loop()
    previous_handler = loop.get_exception_handler()
    warnings: list[dict[str, Any]] = []
    loop.set_exception_handler(lambda _loop, context: warnings.append(context))
    try:
        transport.fail_at = fail_at
        with pytest.raises(ConnectionResetError, match=f"controlled {fail_at} failure"):
            await result.supported_commands()
        assert not result._pending_control_requests
        assert not result.is_closed()
        await asyncio.sleep(0.1)
        gc.collect()
        await asyncio.sleep(0)
        assert not warnings

        task = asyncio.create_task(result.supported_commands())
        await _wait_for(lambda: len(result._pending_control_requests) == 1)
        transport.push(_reply(next(iter(result._pending_control_requests))))
        assert await task == {"commands": ["independent"]}
    finally:
        await result.close()
        loop.set_exception_handler(previous_handler)


class BlockedDrainTransport(FakeTransport):
    def __init__(self) -> None:
        super().__init__()
        self.block = False
        self.entered = asyncio.Event()
        self.release = asyncio.Event()

    async def drain(self) -> None:
        if self.block:
            self.entered.set()
            await self.release.wait()
            raise ConnectionResetError("controlled delayed drain failure")


@pytest.mark.asyncio
async def test_cancellation_while_draining_cancels_unawaited_future() -> None:
    transport = BlockedDrainTransport()
    result = await _start_query(transport)
    transport.block = True
    task = asyncio.create_task(result.supported_commands())
    try:
        await asyncio.wait_for(transport.entered.wait(), timeout=1)
        (pending,) = result._pending_control_requests.values()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        assert not result._pending_control_requests
        assert pending.timeout_handle.cancelled()
        assert pending.future.cancelled()
    finally:
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await result.close()


@pytest.mark.asyncio
async def test_timeout_during_failed_drain_does_not_leave_unhandled_exception() -> None:
    transport = BlockedDrainTransport()
    result = await _start_query(transport)
    loop = asyncio.get_running_loop()
    previous_handler = loop.get_exception_handler()
    warnings: list[dict[str, Any]] = []
    loop.set_exception_handler(lambda _loop, context: warnings.append(context))
    transport.block = True
    task = asyncio.create_task(result.supported_commands())
    try:
        await asyncio.wait_for(transport.entered.wait(), timeout=1)
        await _wait_for(lambda: not result._pending_control_requests)
        transport.release.set()
        with pytest.raises(
            ConnectionResetError, match="controlled delayed drain failure"
        ):
            await task
        task = None
        gc.collect()
        await asyncio.sleep(0)
        assert not warnings
        assert not result.is_closed()
    finally:
        transport.release.set()
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        await result.close()
        loop.set_exception_handler(previous_handler)
