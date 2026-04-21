from __future__ import annotations

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
