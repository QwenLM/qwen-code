from __future__ import annotations

from typing import Any, cast

import pytest
from qwen_code_sdk.errors import ValidationError
from qwen_code_sdk.types import QueryOptions, TimeoutOptions
from qwen_code_sdk.validation import validate_query_options

VALID_UUID = "123e4567-e89b-12d3-a456-426614174000"


def test_rejects_resume_with_continue_session() -> None:
    with pytest.raises(ValidationError, match="resume together with continue_session"):
        validate_query_options(
            QueryOptions(
                resume=VALID_UUID,
                continue_session=True,
            )
        )


def test_rejects_session_id_with_resume() -> None:
    with pytest.raises(ValidationError, match="Cannot use session_id with resume"):
        validate_query_options(
            QueryOptions(
                session_id=VALID_UUID,
                resume="223e4567-e89b-12d3-a456-426614174000",
            )
        )


def test_rejects_invalid_session_id() -> None:
    with pytest.raises(ValidationError, match="Invalid session_id"):
        validate_query_options(QueryOptions(session_id="not-a-uuid"))


def test_rejects_invalid_resume() -> None:
    with pytest.raises(ValidationError, match="Invalid resume"):
        validate_query_options(QueryOptions(resume="not-a-uuid"))


def test_rejects_invalid_permission_mode() -> None:
    with pytest.raises(ValidationError, match="Invalid permission_mode"):
        validate_query_options(
            QueryOptions.from_mapping({"permission_mode": "unsafe-mode"})
        )


def test_rejects_invalid_auth_type() -> None:
    with pytest.raises(ValidationError, match="Invalid auth_type"):
        validate_query_options(QueryOptions.from_mapping({"auth_type": "custom"}))


def test_from_mapping_rejects_non_callable_can_use_tool() -> None:
    with pytest.raises(TypeError, match="can_use_tool must be callable"):
        QueryOptions.from_mapping({"can_use_tool": "bad"})


def test_from_mapping_rejects_non_callable_stderr() -> None:
    with pytest.raises(TypeError, match="stderr must be callable"):
        QueryOptions.from_mapping({"stderr": "bad"})


def test_validation_rejects_non_callable_can_use_tool() -> None:
    with pytest.raises(ValidationError, match="can_use_tool must be callable"):
        validate_query_options(QueryOptions(can_use_tool=cast(Any, "bad")))


def test_validation_rejects_non_callable_stderr() -> None:
    with pytest.raises(ValidationError, match="stderr must be callable"):
        validate_query_options(QueryOptions(stderr=cast(Any, "bad")))


def test_from_mapping_rejects_sync_can_use_tool() -> None:
    def can_use_tool(  # type: ignore[no-untyped-def]
        tool_name, tool_input, context
    ):
        return {"behavior": "deny", "message": "bad"}

    with pytest.raises(TypeError, match="can_use_tool must be an async callable"):
        QueryOptions.from_mapping({"can_use_tool": can_use_tool})


def test_validation_rejects_sync_can_use_tool() -> None:
    def can_use_tool(  # type: ignore[no-untyped-def]
        tool_name, tool_input, context
    ):
        return {"behavior": "deny", "message": "bad"}

    with pytest.raises(ValidationError, match="can_use_tool must be an async callable"):
        validate_query_options(QueryOptions(can_use_tool=cast(Any, can_use_tool)))


def test_from_mapping_rejects_can_use_tool_with_wrong_arity() -> None:
    async def can_use_tool(
        tool_name: str,
        tool_input: dict[str, Any],
    ) -> dict[str, str]:
        return {"behavior": "deny"}

    with pytest.raises(
        TypeError, match="can_use_tool must accept exactly 3 positional arguments"
    ):
        QueryOptions.from_mapping({"can_use_tool": can_use_tool})


def test_validation_rejects_can_use_tool_with_wrong_arity() -> None:
    async def can_use_tool(
        tool_name: str,
        tool_input: dict[str, Any],
    ) -> dict[str, str]:
        return {"behavior": "deny"}

    with pytest.raises(
        ValidationError,
        match="can_use_tool must accept exactly 3 positional arguments",
    ):
        validate_query_options(QueryOptions(can_use_tool=cast(Any, can_use_tool)))


def test_from_mapping_rejects_stderr_with_wrong_arity() -> None:
    def stderr() -> None:
        return None

    with pytest.raises(
        TypeError, match="stderr must accept exactly 1 positional argument"
    ):
        QueryOptions.from_mapping({"stderr": stderr})


def test_validation_rejects_stderr_with_wrong_arity() -> None:
    def stderr() -> None:
        return None

    with pytest.raises(
        ValidationError, match="stderr must accept exactly 1 positional argument"
    ):
        validate_query_options(QueryOptions(stderr=cast(Any, stderr)))


def test_rejects_invalid_max_session_turns() -> None:
    with pytest.raises(ValidationError, match="max_session_turns"):
        validate_query_options(QueryOptions(max_session_turns=-2))


def test_rejects_empty_qwen_executable_path() -> None:
    with pytest.raises(
        ValidationError, match="path_to_qwen_executable cannot be empty"
    ):
        validate_query_options(QueryOptions(path_to_qwen_executable="   "))


def test_timeout_rejects_non_numeric_value() -> None:
    with pytest.raises(TypeError, match=r"timeout\.can_use_tool must be a positive"):
        TimeoutOptions.from_mapping({"can_use_tool": "fast"})


def test_timeout_rejects_negative_value() -> None:
    pattern = r"timeout\.control_request must be a positive"
    with pytest.raises(ValueError, match=pattern):
        TimeoutOptions.from_mapping({"control_request": -1})


def test_timeout_rejects_boolean_value() -> None:
    with pytest.raises(TypeError, match=r"timeout\.stream_close must be a positive"):
        TimeoutOptions.from_mapping({"stream_close": True})


def test_rejects_mcp_servers() -> None:
    with pytest.raises(ValidationError, match="mcp_servers is not supported"):
        validate_query_options(
            QueryOptions(mcp_servers={"my-server": {"command": "node", "args": []}})
        )
