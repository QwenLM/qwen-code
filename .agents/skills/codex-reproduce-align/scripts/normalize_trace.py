#!/usr/bin/env python3
"""Normalize mitm JSONL traces into a stable comparison format."""

from __future__ import annotations

import argparse
import hashlib
import json
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


def walk_tools(value: Any) -> list[dict[str, Any]]:
    tools: list[dict[str, Any]] = []
    if isinstance(value, dict):
        if "tools" in value and isinstance(value["tools"], list):
            for tool in value["tools"]:
                tools.append(summarize_tool(tool))
        if "functions" in value and isinstance(value["functions"], list):
            for fn in value["functions"]:
                tools.append(summarize_tool({"type": "function", "function": fn}))
        for child in value.values():
            tools.extend(walk_tools(child))
    elif isinstance(value, list):
        for child in value:
            tools.extend(walk_tools(child))
    return tools


def summarize_tool(tool: Any) -> dict[str, Any]:
    if not isinstance(tool, dict):
        return {"raw_type": type(tool).__name__}
    fn = tool.get("function") if isinstance(tool.get("function"), dict) else tool
    params = fn.get("parameters") if isinstance(fn, dict) else None
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
    }


def summarize_messages(value: Any) -> list[dict[str, Any]]:
    messages = None
    if isinstance(value, dict):
        if isinstance(value.get("messages"), list):
            messages = value["messages"]
        elif isinstance(value.get("input"), list):
            messages = value["input"]
    if messages is None:
        return []
    summary = []
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


def normalize(path: Path) -> dict[str, Any]:
    requests = []
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        raw = json.loads(line)
        req = raw.get("request") or {}
        resp = raw.get("response") or {}
        parsed = urlparse(req.get("url", ""))
        body = json_body(req)
        requests.append(
            {
                "method": req.get("method"),
                "url_path": parsed.path,
                "body_keys": sorted(body.keys()) if isinstance(body, dict) else [],
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
