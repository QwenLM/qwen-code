from __future__ import annotations

import threading
import time

import pytest
import qwen_code_sdk.sync_query as sync_query_module
from qwen_code_sdk import is_sdk_result_message, query_sync
from qwen_code_sdk.sync_query import SyncQuery


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
