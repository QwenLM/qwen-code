from __future__ import annotations

import asyncio
import threading
import time
from collections.abc import AsyncIterator
from typing import Any

import pytest
import qwen_code_sdk.sync_query as sync_query_module
from qwen_code_sdk import Query, SDKUserMessage, is_sdk_result_message, query_sync
from qwen_code_sdk.sync_query import SyncQuery
from qwen_code_sdk.types import _SYNC_TIMEOUT_MARGIN


@pytest.mark.parametrize(
    ("method_name", "arguments"),
    [
        ("interrupt", ()),
        ("set_model", ("test-model",)),
        ("set_permission_mode", ("default",)),
        ("supported_commands", ()),
        ("mcp_server_status", ()),
    ],
)
def test_sync_controls_wait_at_timeout_ceiling(
    fake_qwen_path: str,
    monkeypatch: pytest.MonkeyPatch,
    method_name: str,
    arguments: tuple[str, ...],
) -> None:
    wait_started = threading.Event()
    caller = threading.get_ident()
    wait = threading.Condition.wait
    observed_timeouts: list[float] = []
    control = getattr(Query, method_name)

    def observe_wait(
        condition: threading.Condition, timeout: float | None = None
    ) -> bool:
        if threading.get_ident() == caller and timeout is not None and timeout > 60:
            observed_timeouts.append(timeout)
            wait_started.set()
        return wait(condition, timeout)

    async def control_after_wait(self: Query, *args: Any) -> Any:
        assert await asyncio.to_thread(wait_started.wait, 5)
        return await control(self, *args)

    async def prompts() -> AsyncIterator[SDKUserMessage]:
        yield {
            "type": "user",
            "session_id": "",
            "message": {"role": "user", "content": "keep input open"},
            "parent_tool_use_id": None,
        }
        await asyncio.Event().wait()

    monkeypatch.setattr(Query, method_name, control_after_wait)
    monkeypatch.setattr(threading.Condition, "wait", observe_wait)
    with query_sync(
        prompts(),
        {
            "path_to_qwen_executable": fake_qwen_path,
            "timeout": {
                "control_request": threading.TIMEOUT_MAX - _SYNC_TIMEOUT_MARGIN
            },
        },
    ) as result:
        response = getattr(result, method_name)(*arguments)
        if method_name == "supported_commands":
            assert response["commands"][0] == "initialize"
        elif method_name == "mcp_server_status":
            assert response == {"servers": []}
        else:
            assert response is None
    assert observed_timeouts == [threading.TIMEOUT_MAX]


def test_sync_query_single_turn(fake_qwen_path: str) -> None:
    result = query_sync(
        "hello sync",
        {
            "path_to_qwen_executable": fake_qwen_path,
        },
    )

    commands = result.supported_commands()
    messages = list(result)

    assert commands["commands"][0] == "initialize"
    assert any(
        is_sdk_result_message(message) and message["result"] == "done: hello sync"
        for message in messages
    )

    result.close()
    result.close()


def test_sync_query_bootstrap_failure_cleans_up_loop_thread(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def raising_query(*args: object, **kwargs: object) -> object:
        raise RuntimeError("bootstrap failed")

    monkeypatch.setattr(sync_query_module, "query", raising_query)

    baseline_threads = {
        thread.ident
        for thread in threading.enumerate()
        if thread.name == "qwen-sdk-sync-loop"
    }

    with pytest.raises(RuntimeError, match="bootstrap failed"):
        SyncQuery("hello")

    deadline = time.time() + 1.0
    while time.time() < deadline:
        active_threads = {
            thread.ident
            for thread in threading.enumerate()
            if thread.name == "qwen-sdk-sync-loop"
        }
        if active_threads == baseline_threads:
            break
        time.sleep(0.01)

    active_threads = {
        thread.ident
        for thread in threading.enumerate()
        if thread.name == "qwen-sdk-sync-loop"
    }
    assert active_threads == baseline_threads


def test_sync_query_context_manager(fake_qwen_path: str) -> None:
    with query_sync(
        "hello context",
        {
            "path_to_qwen_executable": fake_qwen_path,
        },
    ) as result:
        messages = list(result)
        assert any(
            is_sdk_result_message(m) and m["result"] == "done: hello context"
            for m in messages
        )

    assert result.is_closed()
