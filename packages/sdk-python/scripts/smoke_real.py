#!/usr/bin/env python3
"""Run real end-to-end smoke tests against qwen CLI using qwen_code_sdk.

This script is intentionally lightweight and avoids any test doubles.
It is useful for manual verification after changing SDK runtime behavior.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import subprocess
import sys
import threading
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import asdict, dataclass
from pathlib import Path
from queue import Empty, Queue
from typing import Any, TypeVar

SDK_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = SDK_ROOT / "src"
if str(SRC_ROOT) not in sys.path:
    sys.path.insert(0, str(SRC_ROOT))

if sys.version_info >= (3, 10):  # noqa: UP036
    from qwen_code_sdk import (
        SDKUserMessage,
        SyncQuery,
        is_sdk_assistant_message,
        is_sdk_result_message,
        is_sdk_system_message,
        query,
        query_sync,
    )
    from qwen_code_sdk.transport import prepare_spawn_info

T = TypeVar("T")


@dataclass
class AsyncSingleResult:
    ok: bool
    assistant_text: str | None
    result_text: str | None
    session_id: str


@dataclass
class AsyncControlResult:
    ok: bool
    supported_commands_type: str
    saw_system_message: bool
    saw_result_message: bool
    session_id: str


@dataclass
class SyncResult:
    ok: bool
    saw_result_message: bool
    result_text: str | None
    session_id: str


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run real qwen_code_sdk smoke tests using qwen CLI",
    )
    parser.add_argument(
        "--qwen",
        default="qwen",
        help="Path or command for qwen executable (default: qwen)",
    )
    parser.add_argument(
        "--cwd",
        default=str(Path.cwd()),
        help="Working directory passed to SDK query options",
    )
    parser.add_argument(
        "--model",
        default=None,
        help="Optional model name. If set, script will call set_model(model).",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=90.0,
        help="Timeout used for control/callback/stream-close options",
    )
    parser.add_argument(
        "--json-only",
        action="store_true",
        help="Print only JSON result (no progress logs)",
    )
    return parser.parse_args()


def check_qwen_cli_available(qwen_cmd: str, timeout_seconds: float) -> str:
    spawn_info = prepare_spawn_info(qwen_cmd)
    completed = subprocess.run(
        [spawn_info.command, *spawn_info.args, "--version"],
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )
    return completed.stdout.strip()


def build_options(args: argparse.Namespace) -> dict[str, Any]:
    return {
        "cwd": args.cwd,
        "path_to_qwen_executable": args.qwen,
        "permission_mode": "yolo",
        "max_session_turns": 1,
        "timeout": {
            "control_request": args.timeout_seconds,
            "can_use_tool": args.timeout_seconds,
            "stream_close": args.timeout_seconds,
        },
    }


def extract_assistant_text(message: dict[str, Any]) -> str:
    content = message["message"].get("content", [])
    if not isinstance(content, list):
        return ""

    text_parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text_parts.append(str(block.get("text", "")))
    return "".join(text_parts)


async def run_async_single(args: argparse.Namespace) -> AsyncSingleResult:
    token = "SDK_REAL_ASYNC_OK"
    options = build_options(args)
    q = query(
        f"Reply exactly with {token}",
        options,
    )

    assistant_text: str | None = None
    result_text: str | None = None
    try:
        async for message in q:
            if is_sdk_assistant_message(message):
                assistant_text = (assistant_text or "") + extract_assistant_text(
                    message
                )
            if is_sdk_result_message(message):
                result_text = str(message.get("result", ""))
    finally:
        await q.close()

    ok = token in (assistant_text or "") and token in (result_text or "")
    return AsyncSingleResult(
        ok=ok,
        assistant_text=assistant_text,
        result_text=result_text,
        session_id=q.get_session_id(),
    )


async def run_async_controls(args: argparse.Namespace) -> AsyncControlResult:
    token = "SDK_REAL_CONTROL_OK"
    options = build_options(args)
    release_prompt = asyncio.Event()

    async def prompts() -> AsyncIterator[SDKUserMessage]:
        await release_prompt.wait()
        yield {
            "type": "user",
            "session_id": "00000000-0000-4000-8000-000000000001",
            "message": {
                "role": "user",
                "content": f"Reply exactly with {token}",
            },
            "parent_tool_use_id": None,
        }

    q = query(prompts(), options)

    supported: dict[str, Any] | None = None
    saw_system_message = False
    saw_result_message = False
    try:
        supported = await q.supported_commands()
        await q.set_permission_mode("plan")
        await q.set_permission_mode("yolo")
        if args.model:
            await q.set_model(args.model)

        release_prompt.set()
        async for message in q:
            if is_sdk_system_message(message):
                saw_system_message = True
            if is_sdk_result_message(message):
                saw_result_message = True
                break
    finally:
        await q.close()

    ok = isinstance(supported, dict) and saw_result_message
    return AsyncControlResult(
        ok=ok,
        supported_commands_type=type(supported).__name__,
        saw_system_message=saw_system_message,
        saw_result_message=saw_result_message,
        session_id=q.get_session_id(),
    )


async def run_stage(stage: str, coro: Awaitable[T], timeout_seconds: float) -> T:
    try:
        return await asyncio.wait_for(coro, timeout=timeout_seconds)
    except TimeoutError as exc:
        message = f"{stage} timed out after {timeout_seconds} seconds"
        raise TimeoutError(message) from exc


def run_sync(
    args: argparse.Namespace,
    on_query: Callable[[SyncQuery], None] | None = None,
) -> SyncResult:
    token = "SDK_REAL_SYNC_OK"
    options = build_options(args)
    q = query_sync(
        f"Reply exactly with {token}",
        options,
    )
    if on_query is not None:
        on_query(q)

    saw_result_message = False
    result_text: str | None = None
    try:
        for message in q:
            if is_sdk_result_message(message):
                saw_result_message = True
                result_text = str(message.get("result", ""))
                break
    finally:
        q.close()

    ok = saw_result_message and token in (result_text or "")
    return SyncResult(
        ok=ok,
        saw_result_message=saw_result_message,
        result_text=result_text,
        session_id=q.get_session_id(),
    )


def run_sync_with_timeout(args: argparse.Namespace) -> SyncResult:
    result_queue: Queue[SyncResult | BaseException] = Queue(maxsize=1)
    query_holder: dict[str, SyncQuery] = {}

    def remember_query(q: SyncQuery) -> None:
        query_holder["query"] = q

    def worker() -> None:
        try:
            result_queue.put(run_sync(args, on_query=remember_query))
        except BaseException as exc:
            result_queue.put(exc)

    thread = threading.Thread(
        target=worker,
        name="qwen-sdk-real-smoke-sync",
        daemon=True,
    )
    thread.start()

    try:
        item = result_queue.get(timeout=args.timeout_seconds)
    except Empty as exc:
        q = query_holder.get("query")
        if q is not None:
            q.close()
        raise TimeoutError(
            f"sync check timed out after {args.timeout_seconds} seconds"
        ) from exc

    thread.join(timeout=1.0)
    if isinstance(item, BaseException):
        raise item
    return item


def build_failure_payload(
    *,
    stage: str,
    exc: BaseException,
    qwen_version: str | None = None,
    completed: dict[str, Any] | None = None,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "ok": False,
        "stage": stage,
        "error": str(exc),
        "error_type": type(exc).__name__,
    }
    if qwen_version is not None:
        payload["qwen_version"] = qwen_version
    if completed:
        payload["completed"] = completed
    return payload


async def main() -> int:
    args = parse_args()
    if sys.version_info < (3, 10):  # noqa: UP036
        version = ".".join(str(part) for part in sys.version_info[:3])
        payload = {
            "ok": False,
            "stage": "startup",
            "error": f"Python >=3.10 is required, current version is {version}",
            "error_type": "RuntimeError",
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 2

    try:
        qwen_version = check_qwen_cli_available(args.qwen, args.timeout_seconds)
    except (subprocess.CalledProcessError, OSError, subprocess.TimeoutExpired) as exc:
        payload = build_failure_payload(stage="preflight", exc=exc)
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 2

    stage = "async single-turn check"
    completed: dict[str, Any] = {}
    try:
        if not args.json_only:
            print(f"[smoke] qwen version: {qwen_version}")
            print(f"[smoke] running {stage}...")
        async_single = await run_stage(
            stage,
            run_async_single(args),
            args.timeout_seconds,
        )
        completed["async_single"] = asdict(async_single)

        stage = "async control check"
        if not args.json_only:
            print(f"[smoke] running {stage}...")
        async_controls = await run_stage(
            stage,
            run_async_controls(args),
            args.timeout_seconds,
        )
        completed["async_controls"] = asdict(async_controls)

        stage = "sync check"
        if not args.json_only:
            print(f"[smoke] running {stage}...")
        sync_result = run_sync_with_timeout(args)
        completed["sync"] = asdict(sync_result)
    except Exception as exc:
        payload = build_failure_payload(
            stage=stage,
            exc=exc,
            qwen_version=qwen_version,
            completed=completed,
        )
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 1

    all_ok = async_single.ok and async_controls.ok and sync_result.ok
    payload = {
        "ok": all_ok,
        "qwen_version": qwen_version,
        "async_single": asdict(async_single),
        "async_controls": asdict(async_controls),
        "sync": asdict(sync_result),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if all_ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
