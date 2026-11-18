from __future__ import annotations

import asyncio
import contextlib
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from qwen_code_sdk import SDKUserMessage, query


@pytest.mark.asyncio
@pytest.mark.parametrize("closers", [1, 2])
async def test_close_waits_for_pending_process_start(
    tmp_path: Path, closers: int
) -> None:
    peer = tmp_path / "idle_peer.py"
    peer.write_text("import time\ntime.sleep(60)\n", encoding="utf-8")
    result = query("unused", {"path_to_qwen_executable": str(peer)})
    starter = asyncio.create_task(result.supported_commands())
    try:
        await asyncio.sleep(0)
        assert result._transport._process is None
        await asyncio.wait_for(
            asyncio.gather(*(result.close() for _ in range(closers))), timeout=10
        )
        with pytest.raises(RuntimeError, match=r"^Query is closed$"):
            await asyncio.wait_for(starter, timeout=1)
        assert result._pending_control_requests == {}

        child = result._transport._process
        assert child is not None
        assert child.returncode is not None
        assert result.is_closed()
        await result.close()
        assert child.returncode is not None
    finally:
        if not starter.done():
            starter.cancel()
        with contextlib.suppress(asyncio.CancelledError, Exception):
            await starter
        child = result._transport._process
        if child is not None and child.returncode is None:
            child.kill()
            await child.wait()
        for task in (result._router_task, result._initialize_task, result._input_task):
            if task is not None:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task


@pytest.mark.asyncio
async def test_close_before_start_does_not_launch_process(fake_qwen_path: str) -> None:
    result = query("unused", {"path_to_qwen_executable": fake_qwen_path})
    await result.close()
    await result.close()
    with pytest.raises(RuntimeError, match="Query is closed"):
        await result.supported_commands()
    assert result._transport._process is None


@pytest.mark.asyncio
async def test_close_after_process_start_failure(tmp_path: Path) -> None:
    result = query(
        "unused", {"path_to_qwen_executable": str(tmp_path / "missing-command")}
    )
    with pytest.raises(FileNotFoundError):
        await result.supported_commands()
    await asyncio.wait_for(result.close(), timeout=1)
    await result.close()
    assert result.is_closed()
    assert result._transport._process is None


@pytest.mark.asyncio
async def test_input_cleanup_can_close_an_already_closing_query(
    fake_qwen_path: str,
) -> None:
    entered = asyncio.Event()
    cleanup_finished = asyncio.Event()

    async def messages() -> AsyncIterator[SDKUserMessage]:
        try:
            entered.set()
            await asyncio.Event().wait()
            yield {"type": "user", "message": {"role": "user", "content": "unused"}}
        finally:
            await result.close()
            cleanup_finished.set()

    result = query(messages(), {"path_to_qwen_executable": fake_qwen_path})
    try:
        assert await result.supported_commands()
        await asyncio.wait_for(entered.wait(), timeout=1)
        await asyncio.wait_for(result.close(), timeout=1)
        assert cleanup_finished.is_set()
        assert result._transport._process is not None
        assert result._transport._process.returncode is not None
    finally:
        await result.close()
