from __future__ import annotations

import asyncio
import contextlib
import textwrap
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from qwen_code_sdk import ProcessExitError, SDKUserMessage, query


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


@pytest.mark.asyncio
async def test_rejected_initialize_does_not_send_single_turn_prompt(
    tmp_path: Path,
) -> None:
    peer = tmp_path / "reject_initialize.py"
    peer.write_text(
        textwrap.dedent(
            """
            import json
            import sys

            request = json.loads(sys.stdin.readline())
            print(json.dumps({
                "type": "control_response",
                "response": {
                    "subtype": "error",
                    "request_id": request["request_id"],
                    "error": "initialize rejected",
                },
            }), flush=True)
            sys.stdin.read()
            """
        ),
        encoding="utf-8",
    )
    result = query("unused", {"path_to_qwen_executable": str(peer)})
    try:
        with pytest.raises(RuntimeError, match=r"^initialize rejected$"):
            await asyncio.wait_for(anext(result), timeout=2)
        assert result._input_task is not None
        await asyncio.wait_for(result._input_task, timeout=2)
        assert result._input_task.exception() is None
        assert result._pending_control_requests == {}
    finally:
        await result.close()
        if result._input_task is not None:
            await asyncio.gather(result._input_task, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize("exit_code", [1, 9])
async def test_control_calls_preserve_process_exit_during_initialize(
    tmp_path: Path, exit_code: int
) -> None:
    peer = tmp_path / "failed_initialize.py"
    peer.write_text(
        f"import sys\nsys.stdin.readline()\nsys.exit({exit_code})\n",
        encoding="utf-8",
    )
    result = query("unused", {"path_to_qwen_executable": str(peer)})
    try:
        for _ in range(2):
            with pytest.raises(ProcessExitError, match=f"exited with code {exit_code}"):
                await asyncio.wait_for(result.supported_commands(), timeout=2)
        assert result.is_closed()
        assert result._pending_control_requests == {}
    finally:
        await result.close()
        if result._input_task is not None:
            await asyncio.gather(result._input_task, return_exceptions=True)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "initialized,streaming", [(False, False), (True, False), (True, True)]
)
async def test_clean_exit_fails_pending_controls_without_waiting_for_timeout(
    tmp_path: Path, initialized: bool, streaming: bool
) -> None:
    peer = tmp_path / "clean_exit.py"
    peer.write_text(
        textwrap.dedent(
            f"""
            import json
            import sys

            request = json.loads(sys.stdin.readline())
            if {initialized!r}:
                print(json.dumps({{
                    "type": "control_response",
                    "response": {{
                        "subtype": "success",
                        "request_id": request["request_id"],
                        "response": {{}},
                    }},
                }}), flush=True)
                for line in sys.stdin:
                    request = json.loads(line)
                    if request["type"] == "control_request":
                        break
            """
        ),
        encoding="utf-8",
    )
    input_started = asyncio.Event()
    input_finished = asyncio.Event()

    async def messages() -> AsyncIterator[SDKUserMessage]:
        try:
            input_started.set()
            await asyncio.Event().wait()
            yield {"type": "user", "message": {"role": "user", "content": "unused"}}
        finally:
            await result.close()
            input_finished.set()

    result = query(
        messages() if streaming else "unused",
        {
            "path_to_qwen_executable": str(peer),
            "timeout": {"control_request": 10},
        },
    )
    try:
        with pytest.raises(RuntimeError, match=r"^Query is closed$"):
            await asyncio.wait_for(result.supported_commands(), timeout=2)
        assert result.is_closed()
        assert result._pending_control_requests == {}
        if streaming:
            await asyncio.wait_for(input_started.wait(), timeout=2)
        with pytest.raises(RuntimeError, match=r"^Query is closed$"):
            await result.supported_commands()
    finally:
        await result.close()
    if streaming:
        assert input_finished.is_set()


@pytest.mark.asyncio
async def test_clean_exit_keeps_buffered_messages_readable(fake_qwen_path: str) -> None:
    result = query("hello", {"path_to_qwen_executable": fake_qwen_path})
    try:
        first = await asyncio.wait_for(anext(result), timeout=2)
        assert first["type"] == "system"
        assert result._router_task is not None
        await asyncio.wait_for(result._router_task, timeout=2)
        assert result.is_closed()
        remaining = [message async for message in result]
        assert [message["type"] for message in remaining] == ["assistant", "result"]
        assert remaining[-1]["result"] == "done: hello"
    finally:
        await result.close()
