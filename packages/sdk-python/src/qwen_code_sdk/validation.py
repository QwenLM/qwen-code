"""Validation helpers for query options."""

from __future__ import annotations

from collections.abc import Callable
from uuid import RFC_4122, UUID

from .errors import ValidationError
from .types import (
    QueryOptions,
    _validate_can_use_tool_callable,
    _validate_stderr_callable,
)

_VALID_PERMISSION_MODES = {"default", "plan", "auto-edit", "yolo"}
_VALID_AUTH_TYPES = {"openai", "anthropic", "qwen-oauth", "gemini", "vertex-ai"}
_VALID_EFFORTS = {"low", "medium", "high", "xhigh", "max"}


_RESERVED_CLI_FLAGS = frozenset(
    {
        "--input-format",
        "--output-format",
        "-o",
        "--channel",
        "--model",
        "-m",
        "--auth-type",
        "--fallback-model",
        "--approval-mode",
        "--yolo",
        "-y",
        "--insecure",
        "--no-insecure",
        "--core-tools",
        "--exclude-tools",
        "--allowed-tools",
        "--max-tool-calls",
        "--max-subagent-depth",
        "--resume",
        "-r",
        "--continue",
        "-c",
        "--session-id",
        "--fork-session",
        "--max-session-turns",
        "--system-prompt",
        "--append-system-prompt",
        "--include-directories",
        "--add-dir",
        "--allowed-mcp-server-names",
        "--extensions",
        "-e",
        "--proxy",
        "--sandbox",
        "--no-sandbox",
        "-s",
        "--sandbox-image",
        "--sandbox-session-id",
        "--safe-mode",
        "--no-safe-mode",
        "--worktree",
        "--no-worktree",
        "--disabled-slash-commands",
        "--include-partial-messages",
        "--chat-recording",
        "--openai-logging",
        "--openai-logging-dir",
        "--openai-base-url",
        "--openai-api-key",
        "--mcp-config",
        "--prompt",
        "-p",
        "--prompt-interactive",
        "-i",
        "--json-schema",
        "--json-fd",
        "--json-file",
        "--input-file",
    }
)


def validate_query_options(options: QueryOptions) -> None:
    if (
        options.permission_mode
        and options.permission_mode not in _VALID_PERMISSION_MODES
    ):
        raise ValidationError(
            f"Invalid permission_mode: {options.permission_mode!r}. "
            "Expected one of: default, plan, auto-edit, yolo."
        )

    if options.auth_type and options.auth_type not in _VALID_AUTH_TYPES:
        raise ValidationError(
            f"Invalid auth_type: {options.auth_type!r}. "
            "Expected one of: openai, anthropic, qwen-oauth, gemini, vertex-ai."
        )

    if options.effort and options.effort not in _VALID_EFFORTS:
        raise ValidationError(
            f"Invalid effort: {options.effort!r}. "
            "Expected one of: low, medium, high, xhigh, max."
        )

    _validate_optional_callable(options.can_use_tool, _validate_can_use_tool_callable)
    _validate_optional_callable(options.stderr, _validate_stderr_callable)

    if options.resume and options.continue_session:
        raise ValidationError(
            "Cannot use resume together with continue_session. "
            "Use continue_session for latest session "
            "or resume for a specific session ID."
        )

    if (
        options.session_id
        and (options.resume or options.continue_session)
        and not options.fork_session
    ):
        raise ValidationError(
            "Cannot use session_id with resume or continue_session. "
            "session_id starts a new session, "
            "resume/continue_session restore existing sessions."
        )

    if options.session_id:
        validate_session_id(options.session_id, "session_id")

    if options.resume:
        validate_session_id(options.resume, "resume")

    if options.fork_session and not (options.resume or options.continue_session):
        raise ValidationError(
            "fork_session requires resume or continue_session to be set"
        )

    if options.max_session_turns is not None and options.max_session_turns < -1:
        raise ValidationError("max_session_turns must be -1 or a non-negative integer")

    if (
        options.path_to_qwen_executable is not None
        and not options.path_to_qwen_executable.strip()
    ):
        raise ValidationError("path_to_qwen_executable cannot be empty")

    if options.max_tool_calls is not None and options.max_tool_calls < -1:
        raise ValidationError("max_tool_calls must be -1 or a non-negative integer")

    if options.max_subagent_depth is not None and not (
        1 <= options.max_subagent_depth <= 100
    ):
        raise ValidationError("max_subagent_depth must be between 1 and 100")

    if options.agents:
        for i, agent in enumerate(options.agents):
            for field in ("name", "description", "systemPrompt"):
                if not agent.get(field):
                    raise ValidationError(
                        f"agents[{i}] is missing required field: {field}"
                    )

    if options.mcp_servers:
        for name, config in options.mcp_servers.items():
            if not isinstance(config, dict):
                raise ValidationError(f"mcp_servers['{name}'] must be a mapping")

    if options.extra_args:
        for arg in options.extra_args:
            if not arg:
                raise ValidationError("extra_args items cannot be empty")
            flag = arg.split("=", 1)[0]
            if flag in _RESERVED_CLI_FLAGS:
                raise ValidationError(
                    f"extra_args cannot contain reserved flag: {flag}"
                )

    for field_name in (
        "include_directories",
        "extensions",
        "allowed_mcp_server_names",
        "disabled_slash_commands",
    ):
        field_value = getattr(options, field_name, None)
        if field_value:
            for item in field_value:
                if "," in str(item):
                    raise ValidationError(f"{field_name} items cannot contain commas")

    if options.fallback_model:
        for item in options.fallback_model:
            if "," in item:
                raise ValidationError("fallback_model items cannot contain commas")

    if options.fallback_model and len(options.fallback_model) > 3:
        raise ValidationError(
            "fallback_model supports a maximum of 3 models. "
            f"Got {len(options.fallback_model)}."
        )

    if options.proxy is not None and not options.proxy.strip():
        raise ValidationError("proxy cannot be empty")


def _validate_optional_callable(
    value: object,
    validator: Callable[[object, type[ValidationError]], None],
) -> None:
    if value is None:
        return
    validator(value, ValidationError)


def validate_session_id(value: str, param_name: str) -> None:
    try:
        parsed = UUID(value)
    except ValueError as exc:
        raise ValidationError(
            f"Invalid {param_name}: {value!r}. Must be a valid UUID."
        ) from exc

    if parsed.variant != RFC_4122:
        raise ValidationError(
            f"Invalid {param_name}: {value!r}. UUID variant must be RFC 4122."
        )
