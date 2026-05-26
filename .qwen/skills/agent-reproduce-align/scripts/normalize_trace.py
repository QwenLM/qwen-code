#!/usr/bin/env python3
"""Normalize mitm JSONL traces into a stable comparison format."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any
from urllib.parse import urlparse


def content_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def json_body(record: dict[str, Any]) -> Any:
    body = record.get("body") or {}
    if body.get("json") is not None:
        return body["json"]
    text = body.get("text")
    if not text:
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return {"text_hash": content_hash(text), "text_len": len(text)}


SCHEMA_KEYS = (
    "type",
    "enum",
    "const",
    "items",
    "properties",
    "required",
    "anyOf",
    "allOf",
    "oneOf",
    "additionalProperties",
    "description",
    "default",
    "examples",
    "format",
    "minimum",
    "maximum",
    "minLength",
    "maxLength",
    "pattern",
    "$ref",
    "minItems",
    "maxItems",
    "uniqueItems",
    "nullable",
)

PARITY_BODY_VALUE_KEYS = (
    "model",
    "stream",
    "temperature",
    "max_tokens",
    "max_completion_tokens",
    "tool_choice",
    "top_p",
    "top_k",
    "n",
    "stop",
    "response_format",
    "seed",
    "reasoning_effort",
    "parallel_tool_calls",
)


def normalize_schema(value: Any) -> Any:
    if isinstance(value, dict):
        normalized: dict[str, Any] = {}
        for key in SCHEMA_KEYS:
            if key not in value:
                continue
            child = value[key]
            if key == "required" and isinstance(child, list):
                normalized[key] = sorted(str(item) for item in child)
            elif key == "properties" and isinstance(child, dict):
                normalized[key] = {
                    str(name): normalize_schema(schema)
                    for name, schema in sorted(child.items())
                }
            elif key in {"anyOf", "allOf", "oneOf"} and isinstance(child, list):
                normalized[key] = [normalize_schema(item) for item in child]
            else:
                normalized[key] = normalize_schema(child)
        return normalized
    if isinstance(value, list):
        return [normalize_schema(item) for item in value]
    return value


def walk_tools(value: Any) -> list[dict[str, Any]]:
    tools: list[dict[str, Any]] = []
    if isinstance(value, dict):
        if "tools" in value and isinstance(value["tools"], list):
            for tool in value["tools"]:
                tools.append(summarize_tool(tool))
        if "functions" in value and isinstance(value["functions"], list):
            for fn in value["functions"]:
                tools.append(summarize_tool({"type": "function", "function": fn}))
    return tools


def summarize_tool(tool: Any) -> dict[str, Any]:
    if not isinstance(tool, dict):
        return {"raw_type": type(tool).__name__}
    fn = tool.get("function") if isinstance(tool.get("function"), dict) else tool
    params = None
    if isinstance(fn, dict):
        params = fn.get("parameters") or fn.get("input_schema")
    schema = normalize_schema(params) if isinstance(params, dict) else {}
    return {
        "type": tool.get("type"),
        "name": fn.get("name") if isinstance(fn, dict) else None,
        "description_hash": content_hash(fn.get("description", ""))
        if isinstance(fn, dict) and isinstance(fn.get("description"), str)
        else None,
        "required": sorted(params.get("required", []))
        if isinstance(params, dict) and isinstance(params.get("required"), list)
        else [],
        "properties": sorted(params.get("properties", {}).keys())
        if isinstance(params, dict) and isinstance(params.get("properties"), dict)
        else [],
        "schema": schema,
    }


def summarize_messages(value: Any) -> list[dict[str, Any]]:
    messages = None
    system_messages: list[Any] = []
    if isinstance(value, dict):
        # Provider conventions for the system prompt:
        # - Anthropic Messages API: top-level "system"
        # - OpenAI Responses API: top-level "instructions"
        # - Gemini / Qwen Code: top-level "systemInstruction" (camelCase)
        for key in ("system", "instructions", "systemInstruction"):
            if key in value:
                system_messages.append(value[key])
        if isinstance(value.get("messages"), list):
            messages = value["messages"]
        elif isinstance(value.get("input"), list):
            messages = value["input"]
    if messages is None:
        messages = []
    summary = []
    for system in system_messages:
        content = (
            system
            if isinstance(system, str)
            else json.dumps(system, ensure_ascii=False, sort_keys=True)
        )
        summary.append(
            {
                "role": "system",
                "content_hash": content_hash(content),
                "content_len": len(content),
            }
        )
    for item in messages:
        if not isinstance(item, dict):
            continue
        content = item.get("content", "")
        if not isinstance(content, str):
            content = json.dumps(content, ensure_ascii=False, sort_keys=True)
        summary.append(
            {
                "role": item.get("role"),
                "content_hash": content_hash(content),
                "content_len": len(content),
            }
        )
    return summary


def summarize_body_values(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        return {}
    return {key: body[key] for key in PARITY_BODY_VALUE_KEYS if key in body}


def normalize(path: Path) -> dict[str, Any]:
    requests = []
    for line_num, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError as exc:
            print(
                f"Warning: skipping malformed line {line_num} in {path}: {exc}",
                file=sys.stderr,
            )
            continue
        # Valid JSONL lines may decode to non-objects (`[]`, `"hello"`, `42`,
        # `null`); those do not have `.get()` and would crash the entire
        # normalization with an AttributeError. Skip with a warning instead.
        if not isinstance(raw, dict):
            print(
                f"Warning: skipping non-object line {line_num} in {path}",
                file=sys.stderr,
            )
            continue
        req = raw.get("request") or {}
        resp = raw.get("response") or {}
        parsed = urlparse(req.get("url", ""))
        url_path = parsed.path
        if parsed.query:
            url_path = f"{url_path}?{parsed.query}"
        body = json_body(req)
        requests.append(
            {
                "method": req.get("method"),
                "url_path": url_path,
                "body_keys": sorted(body.keys()) if isinstance(body, dict) else [],
                "body_values": summarize_body_values(body),
                "model": body.get("model") if isinstance(body, dict) else None,
                "stream": body.get("stream") if isinstance(body, dict) else None,
                "messages": summarize_messages(body),
                "tools": sorted(walk_tools(body), key=lambda item: (item.get("name") or "")),
                "response_status": resp.get("status_code") if isinstance(resp, dict) else None,
            }
        )
    return {"source": str(path), "request_count": len(requests), "requests": requests}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("trace", type=Path)
    args = parser.parse_args()
    print(json.dumps(normalize(args.trace), ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
