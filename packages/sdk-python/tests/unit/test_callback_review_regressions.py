from __future__ import annotations

import asyncio
from functools import wraps
from typing import Any

import pytest
from qwen_code_sdk import query
from qwen_code_sdk.errors import ValidationError
from qwen_code_sdk.types import QueryOptions


@pytest.mark.parametrize("option", ["can_use_tool", "stderr"])
@pytest.mark.parametrize("as_object", [False, True])
def test_wrapped_callback_validates_its_actual_call_contract(
    option: str, as_object: bool
) -> None:
    async def permission_inner(
        name: str, payload: dict[str, Any], context: Any, *, mode: str
    ) -> dict[str, Any]:
        return {"behavior": mode, "updatedInput": payload}

    @wraps(permission_inner)
    async def permission_wrapper(
        name: str, payload: dict[str, Any], context: Any
    ) -> dict[str, Any]:
        return await permission_inner(name, payload, context, mode="allow")

    seen: list[str] = []

    def stderr_inner(text: str, *, prefix: str) -> None:
        seen.append(prefix + text)

    @wraps(stderr_inner)
    def stderr_wrapper(text: str) -> None:
        stderr_inner(text, prefix="sdk: ")

    assert asyncio.run(permission_wrapper("read", {}, None))["behavior"] == "allow"
    stderr_wrapper("diagnostic")
    assert seen == ["sdk: diagnostic"]
    options: dict[str, Any] = {
        option: permission_wrapper if option == "can_use_tool" else stderr_wrapper
    }
    query("hello", QueryOptions(**options) if as_object else options)


@pytest.mark.parametrize("as_object", [False, True])
def test_class_with_async_instance_call_is_rejected(as_object: bool) -> None:
    class Handler:
        def __init__(self, *args: Any, **kwargs: Any) -> None:
            pass

        async def __call__(
            self, name: str, payload: dict[str, Any], context: Any
        ) -> dict[str, Any]:
            return {"behavior": "allow", "updatedInput": payload}

    options: dict[str, Any] = {"can_use_tool": Handler}
    with pytest.raises((TypeError, ValidationError), match="async callable"):
        query("hello", QueryOptions(**options) if as_object else options)


def test_sync_callable_instance_remains_rejected() -> None:
    class Handler:
        def __call__(
            self, name: str, payload: dict[str, Any], context: Any
        ) -> dict[str, Any]:
            return {"behavior": "allow", "updatedInput": payload}

    with pytest.raises(TypeError, match="async callable"):
        query("hello", {"can_use_tool": Handler()})


def test_async_instance_wrong_arity_remains_rejected() -> None:
    class Handler:
        async def __call__(self, name: str, payload: dict[str, Any]) -> dict[str, Any]:
            return {"behavior": "allow", "updatedInput": payload}

    with pytest.raises(TypeError, match="3 positional arguments"):
        query("hello", {"can_use_tool": Handler()})
