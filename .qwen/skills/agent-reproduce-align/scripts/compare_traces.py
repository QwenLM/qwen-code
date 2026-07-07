#!/usr/bin/env python3
"""Compare normalized reproduction traces and print actionable differences."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def load(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def tool_index(request: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {
        tool.get("name") or f"<unnamed-{idx}>": tool
        for idx, tool in enumerate(request.get("tools") or [])
    }


def tool_name_counts(request: dict[str, Any]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for idx, tool in enumerate(request.get("tools") or []):
        name = tool.get("name") or f"<unnamed-{idx}>"
        counts[name] = counts.get(name, 0) + 1
    return counts


def compare_request(idx: int, left: dict[str, Any], right: dict[str, Any]) -> list[str]:
    diffs: list[str] = []
    prefix = f"request[{idx}]"
    for key in (
        "method",
        "url_path",
        "body_keys",
        "body_values",
        "model",
        "stream",
        "response_status",
    ):
        if left.get(key) != right.get(key):
            diffs.append(f"{prefix}.{key}: {left.get(key)!r} != {right.get(key)!r}")

    left_messages = left.get("messages") or []
    right_messages = right.get("messages") or []
    left_roles = [item.get("role") for item in left_messages]
    right_roles = [item.get("role") for item in right_messages]
    if left_roles != right_roles:
        diffs.append(f"{prefix}.message_roles: {left_roles!r} != {right_roles!r}")
    # Surface count mismatches explicitly. zip() below silently truncates to the
    # shorter list, so without this diagnostic an extra trailing message
    # carrying the feature-relevant prompt / tool result would never be
    # reported (the message_roles diff alone hides which side is longer and by
    # how much, and only fires when the *prefix* roles differ at some index).
    if len(left_messages) != len(right_messages):
        diffs.append(
            f"{prefix}.message_count: {len(left_messages)} != {len(right_messages)}"
        )
    for msg_idx, (left_msg, right_msg) in enumerate(zip(left_messages, right_messages)):
        if left_msg.get("content_hash") != right_msg.get("content_hash"):
            diffs.append(
                f"{prefix}.messages[{msg_idx}].content_hash: "
                f"{left_msg.get('content_hash')!r} != "
                f"{right_msg.get('content_hash')!r}"
            )
    # Mirror the request-level missing/extra handling so the user sees the
    # actual content of trailing messages that fell off the zip().
    if len(left_messages) > len(right_messages):
        for msg_idx, message in enumerate(
            left_messages[len(right_messages) :], len(right_messages)
        ):
            diffs.append(f"{prefix}.messages[{msg_idx}].missing_in_right: {message!r}")
    elif len(right_messages) > len(left_messages):
        for msg_idx, message in enumerate(
            right_messages[len(left_messages) :], len(left_messages)
        ):
            diffs.append(f"{prefix}.messages[{msg_idx}].extra_in_right: {message!r}")

    left_tool_list = left.get("tools") or []
    right_tool_list = right.get("tools") or []
    if len(left_tool_list) != len(right_tool_list):
        diffs.append(
            f"{prefix}.tools_count: {len(left_tool_list)} != {len(right_tool_list)}"
        )
    if tool_name_counts(left) != tool_name_counts(right):
        diffs.append(
            f"{prefix}.tool_name_counts: "
            f"{tool_name_counts(left)!r} != {tool_name_counts(right)!r}"
        )
    left_tools = tool_index(left)
    right_tools = tool_index(right)
    missing = sorted(set(left_tools) - set(right_tools))
    extra = sorted(set(right_tools) - set(left_tools))
    if missing:
        diffs.append(f"{prefix}.tools_missing_in_right: {missing}")
    if extra:
        diffs.append(f"{prefix}.tools_extra_in_right: {extra}")

    for name in sorted(set(left_tools) & set(right_tools)):
        for key in ("type", "description_hash", "required", "properties", "schema"):
            if left_tools[name].get(key) != right_tools[name].get(key):
                diffs.append(
                    f"{prefix}.tool[{name}].{key}: "
                    f"{left_tools[name].get(key)!r} != {right_tools[name].get(key)!r}"
                )
    return diffs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("left", type=Path, help="Reference normalized trace")
    parser.add_argument("right", type=Path, help="Target normalized trace, usually Qwen Code")
    args = parser.parse_args()

    try:
        left = load(args.left)
        right = load(args.right)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"Failed to load normalized trace: {exc}", file=sys.stderr)
        return 2

    diffs: list[str] = []

    if left.get("request_count") != right.get("request_count"):
        diffs.append(
            f"request_count: {left.get('request_count')!r} != {right.get('request_count')!r}"
        )

    for idx, (left_req, right_req) in enumerate(
        zip(left.get("requests") or [], right.get("requests") or [])
    ):
        diffs.extend(compare_request(idx, left_req, right_req))
    left_requests = left.get("requests") or []
    right_requests = right.get("requests") or []
    if len(left_requests) > len(right_requests):
        for idx, request in enumerate(left_requests[len(right_requests) :], len(right_requests)):
            diffs.append(f"request[{idx}].missing_in_right: {request!r}")
    elif len(right_requests) > len(left_requests):
        for idx, request in enumerate(right_requests[len(left_requests) :], len(left_requests)):
            diffs.append(f"request[{idx}].extra_in_right: {request!r}")

    if not diffs:
        print("No normalized trace differences found.")
        return 0

    print("Normalized trace differences:")
    for diff in diffs:
        print(f"- {diff}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
