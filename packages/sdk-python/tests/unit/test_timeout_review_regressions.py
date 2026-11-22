from __future__ import annotations

from typing import Any

import pytest
from qwen_code_sdk import query
from qwen_code_sdk.types import TimeoutOptions


@pytest.mark.parametrize("name", ["can_use_tool", "control_request", "stream_close"])
@pytest.mark.parametrize("via_mapping", [False, True])
def test_oversized_integer_deadline_has_documented_exception(
    name: str, via_mapping: bool
) -> None:
    timeout: dict[str, Any] = {name: 10**400}
    with pytest.raises(ValueError, match=rf"timeout\.{name} must be a positive"):
        if via_mapping:
            query("hello", {"timeout": timeout})
        else:
            TimeoutOptions(**timeout)
