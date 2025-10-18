#!/usr/bin/env python3
"""
Automated stream-json validation harness.

This script boots the Qwen Code CLI in stream-json mode and walks through a set
of control-channel scenarios to verify:
  * initialize/system metadata emission (slash commands, permission mode, etc.)
  * advanced control requests: can_use_tool, hook_callback, mcp_message
  * structured error surfaces for unsupported MCP servers

All checks are performed locally without requiring model inference. Results are
rendered as a compact table to provide a quick visual status report.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import shlex
import sys
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List

DEFAULT_COMMAND = (
    "npm run qwen -- --input-format stream-json --output-format stream-json "
    "--include-partial-messages --model qwen-coder"
)

Envelope = Dict[str, Any]
Predicate = Callable[[Envelope], bool]


def build_command() -> List[str]:
    raw = os.environ.get("QWEN_STREAM_JSON_COMMAND", DEFAULT_COMMAND)
    return shlex.split(raw)


@dataclass
class ValidationResult:
    name: str
    success: bool
    detail: str


class StreamJsonCli:
    """Thin async wrapper for interacting with the CLI subprocess."""

    def __init__(self, command: List[str], verbose: bool = True) -> None:
        self._command = command
        self._verbose = verbose
        self._process: asyncio.subprocess.Process | None = None
        self._queue: asyncio.Queue[Envelope] = asyncio.Queue()
        self._buffer: List[Envelope] = []
        self._reader_task: asyncio.Task[None] | None = None

    def _log(self, prefix: str, payload: Envelope) -> None:
        formatted = json.dumps(payload, ensure_ascii=False)
        print(f"[{prefix}] {formatted}")

    async def __aenter__(self) -> "StreamJsonCli":
        self._process = await asyncio.create_subprocess_exec(
            *self._command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        assert self._process.stdout is not None
        self._reader_task = asyncio.create_task(self._read_stdout(self._process.stdout))
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.shutdown()

    async def shutdown(self) -> None:
        if self._process is None:
            return
        try:
            await self.send(
                {
                    "type": "control_request",
                    "request_id": "validator-interrupt",
                    "request": {"subtype": "interrupt"},
                }
            )
        except Exception:
            pass
        try:
            await asyncio.wait_for(self._process.wait(), timeout=3)
        except asyncio.TimeoutError:
            self._process.kill()
        if self._reader_task:
            self._reader_task.cancel()
            with contextlib.suppress(Exception):
                await self._reader_task
        self._process = None

    async def _read_stdout(self, stdout: asyncio.StreamReader) -> None:
        while True:
            line = await stdout.readline()
            if not line:
                break
            decoded = line.decode("utf-8", errors="replace").rstrip()
            try:
                envelope = json.loads(decoded)
            except json.JSONDecodeError:
                if self._verbose:
                    print(f"[cli] {decoded}")
                continue
            if self._verbose:
                self._log("cli", envelope)
            await self._queue.put(envelope)

    async def send(self, payload: Envelope) -> None:
        if self._process is None or self._process.stdin is None:
            raise RuntimeError("CLI process not started")
        line = json.dumps(payload, ensure_ascii=False)
        if self._verbose:
            self._log("client", payload)
        self._process.stdin.write((line + "\n").encode("utf-8"))
        await self._process.stdin.drain()

    async def wait_for(self, predicate: Predicate, timeout: float, *, description: str) -> Envelope:
        deadline = time.time() + timeout

        def check_buffer() -> Envelope | None:
            for idx, envelope in enumerate(self._buffer):
                if predicate(envelope):
                    return self._buffer.pop(idx)
            return None

        match = check_buffer()
        if match:
            return match

        while True:
            remaining = deadline - time.time()
            if remaining <= 0:
                raise TimeoutError(f"Timed out waiting for {description}")
            try:
                envelope = await asyncio.wait_for(self._queue.get(), timeout=remaining)
            except asyncio.TimeoutError as exc:
                raise TimeoutError(f"Timed out waiting for {description}") from exc

            if predicate(envelope):
                return envelope
            self._buffer.append(envelope)


async def scenario_initialize(cli: StreamJsonCli) -> ValidationResult:
    print("-- client -> control_request.initialize (with hooks)")
    hooks = {
        "pre_tool": [
            {
                "matcher": None,
                "hookCallbackIds": ["validator-hook-1"],
            }
        ],
    }
    await cli.send(
        {
            "type": "control_request",
            "request_id": "validator-init",
            "request": {"subtype": "initialize", "hooks": hooks},
        }
    )

    response = await cli.wait_for(
        lambda env: env.get("type") == "control_response" and env.get("request_id") == "validator-init",
        timeout=5,
        description="control_response.initialize",
    )
    if not response.get("success"):
        return ValidationResult("Initialize / Capabilities", False, f"Unexpected failure: {response.get('error')}")

    system_event = await cli.wait_for(
        lambda env: env.get("type") == "system" and env.get("subtype") == "init",
        timeout=5,
        description="system.init",
    )
    data = system_event.get("data") or {}
    slash_commands = data.get("slash_commands") or []
    if not slash_commands:
        return ValidationResult("Initialize / Capabilities", False, "slash_commands list is empty")
    detail = f"Capabilities OK, {len(slash_commands)} slash commands discovered"
    return ValidationResult("Initialize / Capabilities", True, detail)


async def scenario_hook_callback(cli: StreamJsonCli) -> ValidationResult:
    print("-- client -> control_request.hook_callback")
    await cli.send(
        {
            "type": "control_request",
            "request_id": "validator-hook",
            "request": {
                "subtype": "hook_callback",
                "callback_id": "validator-hook-1",
            },
        }
    )
    response = await cli.wait_for(
        lambda env: env.get("type") == "control_response" and env.get("request_id") == "validator-hook",
        timeout=3,
        description="control_response.hook_callback",
    )
    if not response.get("success"):
        detail = response.get("error") or "hook callback rejected"
        return ValidationResult("hook_callback handling", False, str(detail))
    payload = response.get("response") or {}
    decision = payload.get("decision")
    return ValidationResult(
        "hook_callback handling",
        decision == "continue",
        f"decision={decision!r}",
    )


async def scenario_can_use_tool(cli: StreamJsonCli) -> ValidationResult:
    print("-- client -> control_request.can_use_tool")
    await cli.send(
        {
            "type": "control_request",
            "request_id": "validator-tool",
            "request": {
                "subtype": "can_use_tool",
                "tool_name": "edit",
                "tool_use_id": "validator-tool-1",
                "input": {"path": "README.md"},
            },
        }
    )
    response = await cli.wait_for(
        lambda env: env.get("type") == "control_response" and env.get("request_id") == "validator-tool",
        timeout=3,
        description="control_response.can_use_tool",
    )
    if not response.get("success"):
        detail = response.get("error") or "no detail"
        return ValidationResult("can_use_tool handling", False, str(detail))
    behavior = (response.get("response") or {}).get("behavior")
    return ValidationResult("can_use_tool handling", True, f"behavior={behavior}")


async def scenario_mcp_message(cli: StreamJsonCli) -> ValidationResult:
    print("-- client -> control_request.mcp_message")
    await cli.send(
        {
            "type": "control_request",
            "request_id": "validator-mcp",
            "request": {
                "subtype": "mcp_message",
                "server_name": "nonexistent-server",
                "message": {"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
            },
        }
    )
    response = await cli.wait_for(
        lambda env: env.get("type") == "control_response" and env.get("request_id") == "validator-mcp",
        timeout=3,
        description="control_response.mcp_message",
    )
    success = response.get("success", False)
    error = response.get("error")
    expected_message = "is not configured"
    if success or not isinstance(error, (str, dict)):
        return ValidationResult("mcp_message error surface", False, f"Unexpected response: {response}")
    message_text = error if isinstance(error, str) else str(error.get("message"))
    ok = expected_message in message_text
    detail = message_text if ok else f"Missing expected phrase in {message_text!r}"
    return ValidationResult("mcp_message error surface", ok, detail)


async def scenario_prompt_tool_flow(cli: StreamJsonCli) -> ValidationResult:
    print("-- client -> user message (trigger tool use)")
    await cli.send(
        {
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {"type": "text", "text": "请执行 ls 并展示结果"},
                ],
            },
        }
    )
    try:
        envelope = await cli.wait_for(
            lambda env: env.get("type") == "control_request"
            and (env.get("request") or {}).get("subtype") == "can_use_tool",
            timeout=15,
            description="control_request.can_use_tool (prompt driven)",
        )
        request_payload = envelope.get("request") or {}
        tool_name = request_payload.get("tool_name")
        return ValidationResult(
            "Prompt -> can_use_tool",
            True,
            f"received tool request for {tool_name!r}",
        )
    except TimeoutError as exc:
        return ValidationResult(
            "Prompt -> can_use_tool",
            False,
            f"no tool request observed (credentials required?): {exc}",
        )


async def scenario_tool_result_chain(cli: StreamJsonCli) -> ValidationResult:
    print("-- client -> user tool_result + parent_tool_use_id")
    await cli.send(
        {
            "type": "user",
            "message": {
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "validator-tool-2",
                        "content": [{"type": "text", "text": "模拟工具输出"}],
                        "is_error": False,
                    }
                ],
            },
            "parent_tool_use_id": "validator-tool-2",
        }
    )
    # send a follow-up hook callback to ensure the CLI remains responsive
    await cli.send(
        {
            "type": "control_request",
            "request_id": "validator-hook-followup",
            "request": {
                "subtype": "hook_callback",
                "callback_id": "validator-hook-1",
            },
        }
    )
    response = await cli.wait_for(
        lambda env: env.get("type") == "control_response"
        and env.get("request_id") == "validator-hook-followup",
        timeout=3,
        description="post-tool hook callback",
    )
    if not response.get("success"):
        return ValidationResult(
            "Tool result linkage",
            False,
            str(response.get("error") or "follow-up hook failed"),
        )
    return ValidationResult(
        "Tool result linkage",
        True,
        "follow-up hook callback succeeded",
    )


async def run_validation(verbose: bool) -> List[ValidationResult]:
    command = build_command()
    results: List[ValidationResult] = []
    async with StreamJsonCli(command, verbose=verbose) as cli:
        scenarios: list[tuple[str, Callable[[StreamJsonCli], Awaitable[ValidationResult]]]] = [
            ("Initialize / Capabilities", scenario_initialize),
            ("Hook Callback", scenario_hook_callback),
            ("Can Use Tool", scenario_can_use_tool),
            ("MCP Bridge", scenario_mcp_message),
        ]

        if os.environ.get("STREAM_JSON_VALIDATE_PROMPT") == "1":
            scenarios.append(("Prompt -> can_use_tool", scenario_prompt_tool_flow))
        if os.environ.get("STREAM_JSON_VALIDATE_TOOL_RESULT") == "1":
            scenarios.append(("Tool result linkage", scenario_tool_result_chain))

        for index, (label, scenario) in enumerate(scenarios, start=1):
            separator = f"\n===== [{index}/{len(scenarios)}] {label} ====="
            print(separator)
            try:
                result = await scenario(cli)
            except TimeoutError as exc:
                result = ValidationResult(label, False, str(exc))
            except Exception as exc:  # pragma: no cover - unexpected path
                result = ValidationResult(label, False, repr(exc))
            results.append(result)
    return results


def render_results(results: List[ValidationResult]) -> None:
    name_width = max(len(r.name) for r in results) + 2
    status_col = "Status"
    detail_col = "Detail"
    print("-" * (name_width + 40))
    print(f"{'Scenario'.ljust(name_width)}{status_col:<8}{detail_col}")
    print("-" * (name_width + 40))
    for res in results:
        status = "✅ OK" if res.success else "❌ FAIL"
        print(f"{res.name.ljust(name_width)}{status:<8}{res.detail}")
    print("-" * (name_width + 40))


async def async_main(verbose: bool) -> int:
    results = await run_validation(verbose=verbose)
    render_results(results)
    return 0 if all(r.success for r in results) else 1


def main() -> int:
    verbose = os.environ.get("STREAM_JSON_VALIDATE_VERBOSE", "1") != "0"
    try:
        return asyncio.run(async_main(verbose))
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
