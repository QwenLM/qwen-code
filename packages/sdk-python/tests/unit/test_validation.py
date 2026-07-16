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


def test_rejects_fractional_max_session_turns() -> None:
    with pytest.raises(ValidationError, match="max_session_turns"):
        validate_query_options(QueryOptions(max_session_turns=cast(Any, 0.5)))


@pytest.mark.parametrize("value", [True, False])
def test_rejects_bool_max_session_turns(value: bool) -> None:
    with pytest.raises(ValidationError, match="max_session_turns"):
        validate_query_options(QueryOptions(max_session_turns=cast(Any, value)))


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


def test_rejects_invalid_max_tool_calls() -> None:
    with pytest.raises(ValidationError, match="max_tool_calls"):
        validate_query_options(QueryOptions(max_tool_calls=-2))


def test_rejects_invalid_max_subagent_depth() -> None:
    with pytest.raises(ValidationError, match="max_subagent_depth"):
        validate_query_options(QueryOptions(max_subagent_depth=0))


def test_rejects_agents_missing_required_fields() -> None:
    with pytest.raises(ValidationError, match="missing required field"):
        validate_query_options(QueryOptions(agents=[{"name": "test"}]))


def test_rejects_extra_args_with_reserved_flags() -> None:
    with pytest.raises(ValidationError, match="reserved flag"):
        validate_query_options(QueryOptions(extra_args=["--input-format"]))


@pytest.mark.parametrize(
    "flag",
    [
        "--model",
        "-m",
        "--auth-type",
        "--approval-mode",
        "--insecure",
        "--yolo",
        "-y",
        "--allowed-tools",
        "--exclude-tools",
        "--resume",
        "-r",
        "--continue",
        "-c",
        "--session-id",
        "--proxy",
        "--channel",
        "--output-format",
        "-o",
        "--openai-base-url",
        "--openai-api-key",
        "--mcp-config",
        "--prompt",
        "-p",
        "--prompt-interactive",
        "-i",
        "--add-dir",
        "--input-file",
        "--extensions",
        "-e",
        "--sandbox",
        "-s",
        "--no-sandbox",
        "--no-insecure",
        "--no-safe-mode",
        "--sandbox-image",
        "--fork-session",
        "--max-tool-calls",
        "--max-subagent-depth",
        "--max-session-turns",
        "--system-prompt",
        "--append-system-prompt",
        "--include-directories",
        "--allowed-mcp-server-names",
        "--disabled-slash-commands",
        "--include-partial-messages",
        "--chat-recording",
        "--openai-logging",
        "--openai-logging-dir",
        "--json-schema",
        "--json-fd",
        "--json-file",
    ],
)
def test_rejects_extra_args_with_security_sensitive_flags(flag: str) -> None:
    with pytest.raises(ValidationError, match="reserved flag"):
        validate_query_options(QueryOptions(extra_args=[flag]))


@pytest.mark.parametrize(
    "flag",
    [
        "--model=qwen-max",
        "--auth-type=openai",
        "--approval-mode=yolo",
        "--insecure=true",
        "--yolo=true",
        "--proxy=http://localhost:8080",
    ],
)
def test_rejects_extra_args_with_flag_value_syntax(flag: str) -> None:
    with pytest.raises(ValidationError, match="reserved flag"):
        validate_query_options(QueryOptions(extra_args=[flag]))


def test_accepts_extra_args_with_non_reserved_flags() -> None:
    validate_query_options(QueryOptions(extra_args=["--some-unknown-flag", "--value"]))


def test_rejects_fallback_model_exceeding_max() -> None:
    with pytest.raises(ValidationError, match="fallback_model supports a maximum of 3"):
        validate_query_options(QueryOptions(fallback_model=["a", "b", "c", "d"]))


def test_rejects_empty_proxy() -> None:
    with pytest.raises(ValidationError, match="proxy cannot be empty"):
        validate_query_options(QueryOptions(proxy="   "))


def test_rejects_fork_session_without_resume() -> None:
    with pytest.raises(ValidationError, match="fork_session requires resume"):
        validate_query_options(QueryOptions(fork_session=True))


def test_accepts_fork_session_with_resume() -> None:
    validate_query_options(
        QueryOptions(
            fork_session=True,
            resume="123e4567-e89b-12d3-a456-426614174000",
        )
    )


def test_rejects_invalid_effort() -> None:
    with pytest.raises(ValidationError, match="Invalid effort"):
        validate_query_options(QueryOptions(effort="invalid"))  # type: ignore[arg-type]


def test_accepts_valid_effort() -> None:
    for effort in ("low", "medium", "high", "xhigh", "max"):
        validate_query_options(QueryOptions(effort=effort))  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "field_name",
    [
        "include_directories",
        "extensions",
        "allowed_mcp_server_names",
        "disabled_slash_commands",
        "fallback_model",
    ],
)
def test_rejects_comma_in_list_fields(field_name: str) -> None:
    with pytest.raises(ValidationError, match="cannot contain commas"):
        validate_query_options(QueryOptions(**{field_name: ["valid", "invalid,comma"]}))


def test_from_mapping_parses_all_new_fields() -> None:
    opts = QueryOptions.from_mapping(
        {
            "fork_session": True,
            "resume": VALID_UUID,
            "max_tool_calls": 50,
            "max_subagent_depth": 3,
            "include_directories": ["/dir1", "/dir2"],
            "extra_args": ["--verbose"],
            "extensions": ["ext1"],
            "allowed_mcp_server_names": ["server1"],
            "fallback_model": ["model-a", "model-b"],
            "proxy": "http://proxy:8080",
            "sandbox": True,
            "safe_mode": True,
            "insecure": True,
            "worktree": True,
            "disabled_slash_commands": ["/cmd1"],
            "agents": [{"name": "a", "description": "b", "systemPrompt": "c"}],
        }
    )
    assert opts.fork_session is True
    assert opts.resume == VALID_UUID
    assert opts.max_tool_calls == 50
    assert opts.max_subagent_depth == 3
    assert opts.include_directories == ["/dir1", "/dir2"]
    assert opts.extra_args == ["--verbose"]
    assert opts.extensions == ["ext1"]
    assert opts.allowed_mcp_server_names == ["server1"]
    assert opts.fallback_model == ["model-a", "model-b"]
    assert opts.proxy == "http://proxy:8080"
    assert opts.sandbox is True
    assert opts.safe_mode is True
    assert opts.insecure is True
    assert opts.worktree is True
    assert opts.disabled_slash_commands == ["/cmd1"]
    assert opts.agents == [{"name": "a", "description": "b", "systemPrompt": "c"}]


def test_from_mapping_defaults_new_fields_to_none() -> None:
    opts = QueryOptions.from_mapping({})
    assert opts.fork_session is False
    assert opts.max_tool_calls is None
    assert opts.max_subagent_depth is None
    assert opts.include_directories is None
    assert opts.extra_args is None
    assert opts.extensions is None
    assert opts.allowed_mcp_server_names is None
    assert opts.fallback_model is None
    assert opts.proxy is None
    assert opts.sandbox is False
    assert opts.safe_mode is False
    assert opts.insecure is False
    assert opts.worktree is False
    assert opts.disabled_slash_commands is None
    assert opts.agents is None
