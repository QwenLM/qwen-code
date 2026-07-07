"""mitmproxy addon for local agent reproduction traces.

Writes JSONL records to REPRO_CAPTURE_OUT. Headers are redacted and bodies are
decoded when they look textual. Keep raw outputs local unless manually redacted.
"""

from __future__ import annotations

import base64
import json
import os
import re
import sys
import time
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

from mitmproxy import http


OUT = os.environ.get("REPRO_CAPTURE_OUT", "http.jsonl")
MAX_BODY = int(os.environ.get("REPRO_CAPTURE_MAX_BODY", "500000"))
CAPTURE_ALL = os.environ.get("REPRO_CAPTURE_ALL", "0") == "1"
SENSITIVE_HEADERS = {
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "proxy-authorization",
    "api-key",
    "x-auth-token",
    "x-session-token",
    "x-refresh-token",
    "openai-organization",
    "openai-project",
}
SENSITIVE_KEY_RE = re.compile(
    r"(?i)(api[-_]?key|authorization|cookie|password|secret|token|credential|"
    r"access[-_]?token|refresh[-_]?token|client[-_]?secret|session)"
)
TOKEN_PATTERNS = (
    (re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/=-]+"), "Bearer [REDACTED]"),
    (re.compile(r"(?i)\bbasic\s+[a-z0-9._~+/=-]+"), "Basic [REDACTED]"),
    (re.compile(r"(?i)\btoken\s+[a-z0-9._~+/=-]+"), "Token [REDACTED]"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{12,}\b"), "sk-[REDACTED]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "AKIA[REDACTED]"),
    (re.compile(r"\bAIza[0-9A-Za-z_-]{20,}\b"), "AIza[REDACTED]"),
    (re.compile(r"\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9_]{20,}\b"), "gh_[REDACTED]"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"), "github_pat_[REDACTED]"),
    (
        re.compile(
            r"-----BEGIN\s+[\w\s]+PRIVATE\s+KEY-----.*?-----END\s+[\w\s]+PRIVATE\s+KEY-----",
            re.DOTALL,
        ),
        "-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----",
    ),
)
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
        key_lower = key.lower()
        redacted[key] = (
            "[REDACTED]"
            if key_lower in SENSITIVE_HEADERS or SENSITIVE_KEY_RE.search(key_lower)
            else _redact_text(value)
        )
    return redacted


def _redact_text(text: str) -> str:
    for pattern, replacement in TOKEN_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def _redact_json(value: Any, key: str | None = None) -> Any:
    if key is not None and SENSITIVE_KEY_RE.search(key):
        return "[REDACTED]"
    if isinstance(value, dict):
        return {str(k): _redact_json(v, str(k)) for k, v in value.items()}
    if isinstance(value, list):
        return [_redact_json(item) for item in value]
    if isinstance(value, str):
        return _redact_text(value)
    return value


def _redact_url(url: str) -> str:
    parsed = urlparse(url)
    query = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        query.append((key, "[REDACTED]" if SENSITIVE_KEY_RE.search(key) else value))
    return urlunparse(parsed._replace(query=urlencode(query, doseq=True)))


def _decode(content: bytes | None) -> dict[str, Any]:
    if not content:
        return {"kind": "empty", "text": ""}
    truncated = len(content) > MAX_BODY
    content_sample = content[:MAX_BODY]
    try:
        text = content_sample.decode("utf-8")
    except UnicodeDecodeError:
        if truncated:
            text = content_sample.decode("utf-8", errors="ignore")
        else:
            return {
                "kind": "base64",
                "base64": base64.b64encode(content_sample).decode("ascii"),
                "truncated": truncated,
            }
    parsed: Any = None
    try:
        parsed = _redact_json(json.loads(text))
        redacted_text = json.dumps(parsed, ensure_ascii=False, sort_keys=True)
    except json.JSONDecodeError:
        redacted_text = _redact_text(text)
    return {
        "kind": "text",
        "text": redacted_text,
        "json": parsed,
        "truncated": truncated,
    }


def _write_record(record: dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
        with open(OUT, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
        os.chmod(os.path.abspath(OUT), 0o600)
    except Exception as exc:
        print(f"[llm_dump] FAILED to write record: {exc}", file=sys.stderr)


def _interesting(flow: http.HTTPFlow) -> bool:
    if CAPTURE_ALL:
        return True
    url = flow.request.pretty_url.lower()
    request_ctype = flow.request.headers.get("content-type", "").lower()
    response_ctype = ""
    if flow.response is not None:
        response_ctype = flow.response.headers.get("content-type", "").lower()
    return (
        any(hint in url for hint in INTERESTING_PATH_HINTS)
        or "application/json" in request_ctype
        or "application/json" in response_ctype
        or "text/event-stream" in request_ctype
        or "text/event-stream" in response_ctype
    )


def response(flow: http.HTTPFlow) -> None:
    if not _interesting(flow):
        return
    record = {
        "ts": time.time(),
        "request": {
            "method": flow.request.method,
            "url": _redact_url(flow.request.pretty_url),
            "headers": _headers(flow.request.headers),
            "body": _decode(flow.request.content),
        },
        "response": None,
    }
    if flow.response is not None:
        record["response"] = {
            "status_code": flow.response.status_code,
            "headers": _headers(flow.response.headers),
            "body": _decode(flow.response.content),
        }
    _write_record(record)
