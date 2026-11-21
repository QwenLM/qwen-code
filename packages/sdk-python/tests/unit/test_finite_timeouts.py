from __future__ import annotations

import math

import pytest
from qwen_code_sdk import query
from qwen_code_sdk.types import TimeoutOptions


@pytest.mark.parametrize("name", ["can_use_tool", "control_request", "stream_close"])
@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf])
def test_query_rejects_nonfinite_timeout(name: str, value: float) -> None:
    with pytest.raises(ValueError, match=name):
        query("hello", {"timeout": {name: value}})


@pytest.mark.parametrize("name", ["can_use_tool", "control_request", "stream_close"])
@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf, 0, -1])
def test_timeout_object_rejects_invalid_deadlines(name: str, value: float) -> None:
    with pytest.raises(ValueError, match=name):
        TimeoutOptions(**{name: value})


@pytest.mark.parametrize("value", [True, "1", None])
def test_timeout_object_rejects_nonnumeric_deadlines(value: object) -> None:
    with pytest.raises(TypeError, match="control_request"):
        TimeoutOptions(control_request=value)  # type: ignore[arg-type]


@pytest.mark.parametrize("value", [0.001, 1, 60.0])
def test_finite_positive_timeouts_remain_valid(value: float) -> None:
    options = TimeoutOptions(control_request=value)
    assert options.control_request == value
    assert TimeoutOptions.from_mapping({"control_request": value}) == options
