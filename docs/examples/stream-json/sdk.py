#!/usr/bin/env python3
"""Lightweight stream-json pseudo SDK for Qwen Code CLI.

This module mimics the structure of Anthropic's agent SDK examples by exposing
an easy-to-use `StreamJsonClient` class.  The client handles:

* spawning the CLI subprocess;
* sending initialization & user messages;
* dispatching control requests to pluggable handlers;
* emitting helper responses (e.g. can_use_tool, hook callbacks);
* optional auto-interrupt once a `result` envelope is observed.

The goal is to keep the transport simple and synchronous enough for demos
while illustrating how one could wrap the stream-json protocol in a SDK-like
interface.
"""

from __future__ import annotations

import asyncio
import json
import os
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Mapping, Sequence


DEFAULT_COMMAND = (
    "npm run qwen -- --input-format stream-json --output-format stream-json "
    "--include-partial-messages --model qwen-coder"
)


def _split_command(raw: str) -> list[str]:
    return raw.split()


ControlHandler = Callable[["StreamJsonClient", str, dict[str, Any]], Awaitable[None]]


@dataclass
class StreamJsonClientOptions:
    """Configuration used to bootstrap the pseudo SDK client."""

    command: Sequence[str] = field(
        default_factory=lambda: _split_command(
            os.environ.get("QWEN_STREAM_JSON_COMMAND", DEFAULT_COMMAND)
        )
    )
    initialize_request: dict[str, Any] = field(
        default_factory=lambda: {
            "type": "control_request",
            "request_id": "demo-init",
            "request": {"subtype": "initialize", "hooks": None},
        }
    )
    user_messages: Sequence[dict[str, Any]] = field(
        default_factory=lambda: [
            {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": [
                        {
                            "type": "text",
                            "text": "请阅读 README.md，概述项目目标并列出两个关键命令。",
                        }
                    ],
                },
                "options": {"temporary_model": "qwen-coder"},
            }
        ]
    )
    auto_interrupt_on_result: bool = True
    sleep_before_interrupt_ms: int | None = None
    stdout_printer: Callable[[str], None] = print
    extra_handlers: Mapping[str, ControlHandler] | None = None


class StreamJsonClient:
    """Minimal pseudo SDK around the stream-json protocol."""

    def __init__(self, options: StreamJsonClientOptions | None = None):
        self.options = options or StreamJsonClientOptions()
        self._process: asyncio.subprocess.Process | None = None

        self._handlers: dict[str, ControlHandler] = {
            **self._default_handlers(),
            **(self.options.extra_handlers or {}),
        }

    async def run(self) -> None:
        command = list(self.options.command)
        self._log(f"[spawn] {' '.join(command)}")
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        self._process = process
        assert process.stdout is not None

        reader_task = asyncio.create_task(self._read_stdout(process.stdout))

        await self._send(self.options.initialize_request)
        for message in self.options.user_messages:
            await self._send(message)

        await reader_task
        await process.wait()
        self._log(f"CLI exited with return code {process.returncode}")

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _send(self, payload: dict[str, Any]) -> None:
        assert self._process is not None and self._process.stdin is not None
        line = json.dumps(payload, ensure_ascii=False)
        self._log(f"[client] {line}")
        self._process.stdin.write((line + "\n").encode("utf-8"))
        await self._process.stdin.drain()

    async def _read_stdout(self, stdout: asyncio.StreamReader) -> None:
        while True:
            raw = await stdout.readline()
            if not raw:
                break
            decoded = raw.decode("utf-8").rstrip()
            self._log(f"[cli] {decoded}")
            try:
                envelope = json.loads(decoded)
            except json.JSONDecodeError:
                continue
            await self._handle_envelope(envelope)

    async def _handle_envelope(self, envelope: dict[str, Any]) -> None:
        envelope_type = envelope.get("type")
        if envelope_type == "control_request":
            request_id = envelope.get("request_id", "")
            payload = envelope.get("request") or {}
            subtype = payload.get("subtype")
            handler = self._handlers.get(subtype, self._handle_unknown_control)
            await handler(self, request_id, payload)
        elif envelope_type == "result" and self.options.auto_interrupt_on_result:
            if self.options.sleep_before_interrupt_ms:
                await asyncio.sleep(self.options.sleep_before_interrupt_ms / 1000)
            await self._send(
                {
                    "type": "control_request",
                    "request_id": "demo-interrupt",
                    "request": {"subtype": "interrupt"},
                }
            )

    def _default_handlers(self) -> dict[str, ControlHandler]:
        return {
            "initialize": self._handle_initialize,
            "can_use_tool": self._handle_can_use_tool,
            "hook_callback": self._handle_hook_callback,
            "mcp_message": self._handle_mcp_message,
        }

    # ------------------------------------------------------------------
    # Default control handlers
    # ------------------------------------------------------------------

    async def _handle_initialize(
        self, request_id: str, payload: dict[str, Any]
    ) -> None:
        capabilities = payload.get("capabilities") or {}
        await self.send_control_response(
            request_id,
            success=True,
            response={
                "subtype": "initialize",
                "capabilities": {
                    "can_handle_can_use_tool": True,
                    "can_handle_hook_callback": True,
                    **capabilities,
                },
            },
        )

    async def _handle_can_use_tool(
        self, request_id: str, payload: dict[str, Any]
    ) -> None:
        tool_name = payload.get("tool_name", "unknown_tool")
        await self.send_control_response(
            request_id,
            success=True,
            response={"behavior": "allow", "tool_name": tool_name},
        )

    async def _handle_hook_callback(
        self, request_id: str, payload: dict[str, Any]
    ) -> None:
        await self.send_control_response(
            request_id,
            success=True,
            response={"async": False, "decision": "continue"},
        )

    async def _handle_mcp_message(
        self, request_id: str, payload: dict[str, Any]
    ) -> None:
        await self.send_control_response(
            request_id,
            success=False,
            error="Demo client does not implement MCP forwarding.",
        )

    async def _handle_unknown_control(
        self, request_id: str, payload: dict[str, Any]
    ) -> None:
        subtype = payload.get("subtype")
        await self.send_control_response(
            request_id,
            success=False,
            error=f"Unsupported control_request subtype: {subtype}",
        )

    # ------------------------------------------------------------------
    # Misc helpers
    # ------------------------------------------------------------------

    async def send_control_response(
        self,
        request_id: str,
        *,
        success: bool,
        response: dict[str, Any] | None = None,
        error: str | dict[str, Any] | None = None,
    ) -> None:
        envelope: dict[str, Any] = {
            "type": "control_response",
            "request_id": request_id,
            "success": success,
        }
        if success:
            envelope["response"] = response or {}
        else:
            envelope["error"] = error or "Unknown error"
        await self._send(envelope)

    def _log(self, message: str) -> None:
        self.options.stdout_printer(message)


__all__ = ["StreamJsonClient", "StreamJsonClientOptions"]
