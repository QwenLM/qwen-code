from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from typing import Any

import pytest
from qwen_code_sdk import (
    ProcessExitError,
    SDKUserMessage,
    is_sdk_assistant_message,
    is_sdk_partial_assistant_message,
    is_sdk_result_message,
    is_sdk_system_message,
    is_sdk_user_message,
    query,
)

CONTINUED_SESSION_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
VALID_UUID = "123e4567-e89b-12d3-a456-426614174000"
RESUME_UUID = "223e4567-e89b-12d3-a456-426614174000"


async def _collect_messages(result: Any) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    async for message in result:
        messages.append(message)
    return messages


async def _wait_for(predicate: Callable[[], bool], timeout: float = 2.0) -> None:
    loop = asyncio.get_running_loop()
    deadline = loop.time() + timeout
    while loop.time() < deadline:
        if predicate():
            return
        await asyncio.sleep(0.01)
    raise AssertionError("timed out waiting for expected SDK state")


def _tool_result_error_flag(message: dict[str, Any]) -> bool:
    content = message["message"]["content"]
    assert isinstance(content, list)
    return bool(content[0]["is_error"])


@pytest.mark.asyncio
async def test_single_turn_query(fake_qwen_path: str) -> None:
    result = query(
        "hello world",
        {
            "path_to_qwen_executable": fake_qwen_path,
        },
    )
    messages = await _collect_messages(result)

    assistant = next(
        message for message in messages if is_sdk_assistant_message(message)
    )
    final = next(message for message in messages if is_sdk_result_message(message))

    assert assistant["message"]["content"][0]["text"] == "Echo: hello world"
    assert final["result"] == "done: hello world"
    await result.close()


@pytest.mark.asyncio
async def test_include_partial_messages(fake_qwen_path: str) -> None:
    result = query(
        "stream partial",
        {
            "path_to_qwen_executable": fake_qwen_path,
            "include_partial_messages": True,
        },
    )
    messages = await _collect_messages(result)

    partial = next(
        message for message in messages if is_sdk_partial_assistant_message(message)
    )
    assert partial["event"]["type"] == "content_block_delta"
    await result.close()


@pytest.mark.asyncio
async def test_default_permission_callback_denies_tool_use(fake_qwen_path: str) -> None:
    result = query(
        "use tool now",
        {
            "path_to_qwen_executable": fake_qwen_path,
        },
    )
    messages = await _collect_messages(result)

    tool_result = next(
        message
        for message in messages
        if is_sdk_user_message(message)
        and isinstance(message["message"]["content"], list)
    )
    assert _tool_result_error_flag(tool_result) is True
    await result.close()


@pytest.mark.asyncio
async def test_permission_callback_can_allow_tool_use(fake_qwen_path: str) -> None:
    async def can_use_tool(
        tool_name: str,
        tool_input: dict[str, Any],
        context: dict[str, Any],
    ) -> dict[str, Any]:
        assert tool_name == "write_file"
        assert tool_input["path"] == "demo.txt"
        assert context["suggestions"][0]["type"] == "allow"
        return {"behavior": "allow", "updatedInput": tool_input}

    result = query(
        "create file with use tool",
        {
            "path_to_qwen_executable": fake_qwen_path,
            "can_use_tool": can_use_tool,
        },
    )
    messages = await _collect_messages(result)

    tool_result = next(
        message
        for message in messages
        if is_sdk_user_message(message)
        and isinstance(message["message"]["content"], list)
    )
    assert _tool_result_error_flag(tool_result) is False
    await result.close()


@pytest.mark.asyncio
async def test_unknown_control_requests_are_rejected(fake_qwen_path: str) -> None:
    result = query(
        "request unknown control",
        {
            "path_to_qwen_executable": fake_qwen_path,
        },
    )
    messages = await _collect_messages(result)

    final = next(message for message in messages if is_sdk_result_message(message))
    assert final["result"] == "unknown-control: request unknown control"
    await result.close()


@pytest.mark.asyncio
async def test_dynamic_controls_and_status(fake_qwen_path: str) -> None:
    release_input = asyncio.Event()

    async def prompts() -> AsyncIterator[SDKUserMessage]:
        yield {
            "type": "user",
            "session_id": VALID_UUID,
            "message": {
                "role": "user",
                "content": "first turn",
            },
            "parent_tool_use_id": None,
        }
        await release_input.wait()

    result = query(
        prompts(),
        {
            "path_to_qwen_executable": fake_qwen_path,
            "session_id": VALID_UUID,
        },
    )

    messages: list[dict[str, Any]] = []

    async def consume() -> list[dict[str, Any]]:
        async for message in result:
            messages.append(message)
        return messages

    collector = asyncio.create_task(consume())
    await _wait_for(lambda: any(is_sdk_result_message(message) for message in messages))

    assert await result.supported_commands() == {
        "commands": [
            "initialize",
            "interrupt",
            "set_model",
            "set_permission_mode",
        ]
    }
    assert await result.mcp_server_status() == {"servers": []}

    await result.set_model("new-model")
    await result.set_permission_mode("plan")
    release_input.set()
    await collector

    system_messages = [
        message for message in messages if is_sdk_system_message(message)
    ]
    assert any(message["model"] == "new-model" for message in system_messages)
    assert any(message["permission_mode"] == "plan" for message in system_messages)
    await result.close()


@pytest.mark.asyncio
async def test_session_id_resume_and_continue(fake_qwen_path: str) -> None:
    explicit = query(
        "hello explicit",
        {
            "path_to_qwen_executable": fake_qwen_path,
            "session_id": VALID_UUID,
        },
    )
    explicit_messages = await _collect_messages(explicit)
    assert explicit.get_session_id() == VALID_UUID
    assert all(message["session_id"] == VALID_UUID for message in explicit_messages)
    await explicit.close()

    resumed = query(
        "hello resume",
        {
            "path_to_qwen_executable": fake_qwen_path,
            "resume": RESUME_UUID,
        },
    )
    resumed_messages = await _collect_messages(resumed)
    assert resumed.get_session_id() == RESUME_UUID
    assert all(message["session_id"] == RESUME_UUID for message in resumed_messages)
    await resumed.close()

    continued = query(
        "hello continue",
        {
            "path_to_qwen_executable": fake_qwen_path,
            "continue_session": True,
        },
    )
    continued_messages = await _collect_messages(continued)
    assert continued.get_session_id() == CONTINUED_SESSION_ID
    assert any(
        message["session_id"] == CONTINUED_SESSION_ID for message in continued_messages
    )
    await continued.close()


@pytest.mark.asyncio
async def test_non_zero_process_exit_is_propagated(fake_qwen_path: str) -> None:
    result = query(
        "please exit nonzero",
        {
            "path_to_qwen_executable": fake_qwen_path,
        },
    )

    with pytest.raises(ProcessExitError, match="code 9"):
        await _collect_messages(result)

    await result.close()


@pytest.mark.asyncio
async def test_async_context_manager(fake_qwen_path: str) -> None:
    async with query(
        "hello context",
        {
            "path_to_qwen_executable": fake_qwen_path,
        },
    ) as result:
        messages = await _collect_messages(result)

    assert result.is_closed()
    final = next(m for m in messages if is_sdk_result_message(m))
    assert final["result"] == "done: hello context"
