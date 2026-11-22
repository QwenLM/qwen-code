from __future__ import annotations

from functools import partial
from typing import Any

import pytest
from qwen_code_sdk import query
from qwen_code_sdk.types import CanUseToolContext, PermissionResult, QueryOptions


class StatefulPermission:
    def __init__(self) -> None:
        self.calls: list[str] = []

    async def __call__(
        self, name: str, payload: dict[str, Any], context: CanUseToolContext
    ) -> PermissionResult:
        assert not context["cancel_event"].is_set()
        self.calls.append(name)
        return {"behavior": "allow", "updatedInput": payload}


@pytest.mark.asyncio
@pytest.mark.parametrize("as_object", [False, True])
@pytest.mark.parametrize("as_partial", [False, True])
async def test_async_callable_permission_can_approve_tool(
    fake_qwen_path: str, as_object: bool, as_partial: bool
) -> None:
    permission = StatefulPermission()
    options: QueryOptions | dict[str, Any] = {
        "path_to_qwen_executable": fake_qwen_path,
        "can_use_tool": partial(permission) if as_partial else permission,
    }
    if as_object:
        options = QueryOptions(**options)
    async with query("use tool", options) as q:
        messages = [message async for message in q]

    assert permission.calls == ["write_file"]
    tool_result = next(m for m in messages if m["type"] == "user")
    assert tool_result["message"]["content"][0]["content"] == "ok"


@pytest.mark.parametrize("callback_option", ["can_use_tool", "stderr"])
def test_callbacks_with_unbound_keyword_only_arguments_fail_early(
    callback_option: str,
) -> None:
    async def permission(
        name: str, payload: dict[str, Any], context: CanUseToolContext, *, required: str
    ) -> PermissionResult:
        return {"behavior": "deny", "message": required}

    def stderr(text: str, *, required: str) -> None:
        pass

    callback = permission if callback_option == "can_use_tool" else stderr
    with pytest.raises(
        TypeError, match=rf"{callback_option}.*no required keyword-only arguments"
    ):
        query("hello", {callback_option: callback})
