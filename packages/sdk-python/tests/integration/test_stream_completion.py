from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from typing import Any

import pytest
from qwen_code_sdk import query
from qwen_code_sdk.protocol import SDKUserMessage


@pytest.mark.asyncio
async def test_later_stream_turn_can_reply_to_permission_after_first_result(
    fake_qwen_path: str,
) -> None:
    first_result = asyncio.Event()
    permission_calls: list[str] = []

    async def prompts() -> AsyncIterator[SDKUserMessage]:
        for text in ("first prompt", "use tool in second prompt"):
            if text.startswith("use tool"):
                await first_result.wait()
            yield {
                "type": "user",
                "session_id": "",
                "message": {"role": "user", "content": text},
                "parent_tool_use_id": None,
            }

    async def allow_tool(
        name: str, payload: dict[str, Any], context: Any
    ) -> dict[str, Any]:
        permission_calls.append(name)
        return {"behavior": "allow", "updatedInput": payload}

    q = query(
        prompt=prompts(),
        options={
            "path_to_qwen_executable": fake_qwen_path,
            "can_use_tool": allow_tool,
            "timeout": {"stream_close": 1},
        },
    )
    results: list[str] = []

    async def collect() -> None:
        async for message in q:
            if message["type"] == "result":
                results.append(str(message.get("result")))
                first_result.set()

    try:
        await asyncio.wait_for(collect(), timeout=3)
    finally:
        await q.close()

    assert permission_calls == ["write_file"]
    assert results == [
        "done: first prompt",
        "tool-result: use tool in second prompt",
    ]
