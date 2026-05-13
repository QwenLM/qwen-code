"""mitmproxy addon for local agent reproduction traces.

Writes JSONL records to REPRO_CAPTURE_OUT. Headers are redacted and bodies are
decoded when they look textual. Keep raw outputs local unless manually redacted.
"""

from __future__ import annotations

import base64
import json
import os
import time
from typing import Any

from mitmproxy import http


OUT = os.environ.get("REPRO_CAPTURE_OUT", "http.jsonl")
MAX_BODY = int(os.environ.get("REPRO_CAPTURE_MAX_BODY", "500000"))
CAPTURE_ALL = os.environ.get("REPRO_CAPTURE_ALL", "0") == "1"
SENSITIVE_HEADERS = {
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "api-key",
    "openai-organization",
    "openai-project",
}
INTERESTING_PATH_HINTS = (
    "/chat/completions",
    "/responses",
    "/v1/messages",
    "/v1beta/",
    "/generate",
    "/completions",
)


def _headers(headers: http.Headers) -> dict[str, str]:
    redacted: dict[str, str] = {}
    for key, value in headers.items():
        redacted[key] = "[REDACTED]" if key.lower() in SENSITIVE_HEADERS else value
    return redacted


def _decode(content: bytes | None) -> dict[str, Any]:
    if not content:
        return {"kind": "empty", "text": ""}
    truncated = len(content) > MAX_BODY
    content = content[:MAX_BODY]
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        return {
            "kind": "base64",
            "base64": base64.b64encode(content).decode("ascii"),
            "truncated": truncated,
        }
    parsed: Any = None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        pass
    return {"kind": "text", "text": text, "json": parsed, "truncated": truncated}


def _interesting(flow: http.HTTPFlow) -> bool:
    if CAPTURE_ALL:
        return True
    url = flow.request.pretty_url.lower()
    ctype = flow.request.headers.get("content-type", "").lower()
    return (
        any(hint in url for hint in INTERESTING_PATH_HINTS)
        or "application/json" in ctype
        or "text/event-stream" in ctype
    )


def response(flow: http.HTTPFlow) -> None:
    if not _interesting(flow):
        return
    record = {
        "ts": time.time(),
        "request": {
            "method": flow.request.method,
            "url": flow.request.pretty_url,
            "headers": _headers(flow.request.headers),
            "body": _decode(flow.request.raw_content),
        },
        "response": None,
    }
    if flow.response is not None:
        record["response"] = {
            "status_code": flow.response.status_code,
            "headers": _headers(flow.response.headers),
            "body": _decode(flow.response.raw_content),
        }
    os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
    with open(OUT, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
