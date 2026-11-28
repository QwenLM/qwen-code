from __future__ import annotations

import math
import threading

import pytest
from qwen_code_sdk import query
from qwen_code_sdk.types import _SYNC_TIMEOUT_MARGIN, TimeoutOptions


@pytest.mark.parametrize("name", ["can_use_tool", "control_request", "stream_close"])
@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf, 10**400])
def test_query_rejects_nonfinite_timeout(name: str, value: float) -> None:
    with pytest.raises(ValueError, match=rf"timeout\.{name} must be a positive"):
        query("hello", {"timeout": {name: value}})


@pytest.mark.parametrize("name", ["can_use_tool", "control_request", "stream_close"])
@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf, 0, -1, 10**400])
def test_timeout_object_rejects_invalid_deadlines(name: str, value: float) -> None:
    with pytest.raises(ValueError, match=rf"timeout\.{name} must be a positive"):
        TimeoutOptions(**{name: value})


@pytest.mark.parametrize("value", [True, "1", None])
def test_timeout_object_rejects_nonnumeric_deadlines(value: object) -> None:
    with pytest.raises(TypeError, match="control_request"):
        TimeoutOptions(control_request=value)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "value", [0.001, 1, 60.0, threading.TIMEOUT_MAX - _SYNC_TIMEOUT_MARGIN]
)
def test_finite_positive_timeouts_remain_valid(value: float) -> None:
    options = TimeoutOptions(control_request=value)
    assert options.control_request == value
    assert TimeoutOptions.from_mapping({"control_request": value}) == options


@pytest.mark.parametrize(
    "value", [10**10, threading.TIMEOUT_MAX - _SYNC_TIMEOUT_MARGIN + 1.0]
)
@pytest.mark.parametrize("via_mapping", [False, True])
def test_control_timeout_rejects_unrepresentable_sync_wait(
    value: float, via_mapping: bool
) -> None:
    with pytest.raises(ValueError, match=r"timeout\.control_request must not exceed"):
        if via_mapping:
            query("hello", {"timeout": {"control_request": value}})
        else:
            TimeoutOptions(control_request=value)


@pytest.mark.parametrize("name", ["can_use_tool", "stream_close"])
def test_async_only_timeouts_are_not_limited_by_sync_wait(name: str) -> None:
    value = threading.TIMEOUT_MAX
    options = TimeoutOptions(**{name: value})
    assert getattr(options, name) == value
    assert TimeoutOptions.from_mapping({name: value}) == options
