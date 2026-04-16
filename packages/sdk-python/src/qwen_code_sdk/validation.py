"""Validation helpers for query options."""

from __future__ import annotations

from uuid import UUID

from .errors import ValidationError
from .types import QueryOptions

_VALID_PERMISSION_MODES = {"default", "plan", "auto-edit", "yolo"}
_VALID_AUTH_TYPES = {"openai", "anthropic", "qwen-oauth", "gemini", "vertex-ai"}


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

    if options.resume and options.continue_session:
        raise ValidationError(
            "Cannot use resume together with continue_session. "
            "Use continue_session for latest session "
            "or resume for a specific session ID."
        )

    if options.session_id and (options.resume or options.continue_session):
        raise ValidationError(
            "Cannot use session_id with resume or continue_session. "
            "session_id starts a new session, "
            "resume/continue_session restore existing sessions."
        )

    if options.session_id:
        validate_session_id(options.session_id, "session_id")

    if options.resume:
        validate_session_id(options.resume, "resume")

    if options.max_session_turns is not None and options.max_session_turns < -1:
        raise ValidationError("max_session_turns must be -1 or a non-negative integer")

    if (
        options.path_to_qwen_executable is not None
        and not options.path_to_qwen_executable.strip()
    ):
        raise ValidationError("path_to_qwen_executable cannot be empty")


def validate_session_id(value: str, param_name: str) -> None:
    try:
        parsed = UUID(value)
    except ValueError as exc:
        raise ValidationError(
            f"Invalid {param_name}: {value!r}. Must be a valid UUID."
        ) from exc

    if parsed.version not in {1, 2, 3, 4, 5}:
        raise ValidationError(
            f"Invalid {param_name}: {value!r}. UUID version must be between 1 and 5."
        )

    if parsed.variant != UUID("00000000-0000-0000-8000-000000000000").variant:
        raise ValidationError(
            f"Invalid {param_name}: {value!r}. UUID variant must be RFC 4122."
        )
