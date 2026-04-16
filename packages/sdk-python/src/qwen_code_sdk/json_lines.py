"""JSON lines utilities."""

from __future__ import annotations

import json
from typing import Any


def serialize_json_line(payload: Any) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n"


def parse_json_line(line: str) -> Any:
    return json.loads(line)
