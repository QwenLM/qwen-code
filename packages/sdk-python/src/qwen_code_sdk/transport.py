"""Process transport for qwen CLI stream-json protocol."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
from collections.abc import AsyncIterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import ProcessExitError
from .json_lines import parse_json_line
from .types import QueryOptions


@dataclass(frozen=True)
class SpawnInfo:
    command: str
    args: list[str]


def prepare_spawn_info(path_to_qwen_executable: str | None) -> SpawnInfo:
    if path_to_qwen_executable is None:
        return SpawnInfo(command="qwen", args=[])

    spec = path_to_qwen_executable
    if os.path.sep not in spec and (
        os.path.altsep is None or os.path.altsep not in spec
    ):
        return SpawnInfo(command=spec, args=[])

    path = Path(spec).expanduser().resolve()

    suffix = path.suffix.lower()
    if suffix == ".py":
        return SpawnInfo(command=sys.executable, args=[str(path)])
    if suffix in {".js", ".mjs", ".cjs"}:
        return SpawnInfo(command="node", args=[str(path)])

    return SpawnInfo(command=str(path), args=[])


class ProcessTransport:
    def __init__(self, options: QueryOptions):
        self._options = options
        self._process: asyncio.subprocess.Process | None = None
        self._stderr_task: asyncio.Task[None] | None = None
        self._closed = False
        self._input_closed = False
        self._exit_error: Exception | None = None

    @property
    def exit_error(self) -> Exception | None:
        return self._exit_error

    @property
    def is_closed(self) -> bool:
        return self._closed

    async def start(self) -> None:
        if self._closed:
            raise RuntimeError("Transport is closed")
        if self._process is not None:
            return

        spawn_info = prepare_spawn_info(self._options.path_to_qwen_executable)
        args = [*spawn_info.args, *build_cli_arguments(self._options)]
        stderr_target = (
            asyncio.subprocess.PIPE
            if self._options.debug or self._options.stderr is not None
            else subprocess.DEVNULL
        )

        self._process = await asyncio.create_subprocess_exec(
            spawn_info.command,
            *args,
            cwd=self._options.cwd,
            env={**os.environ, **(self._options.env or {})},
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=stderr_target,
        )

        if self._options.debug or self._options.stderr is not None:
            self._stderr_task = asyncio.create_task(self._forward_stderr())

    async def _forward_stderr(self) -> None:
        if self._process is None or self._process.stderr is None:
            return

        while True:
            chunk = await self._process.stderr.readline()
            if not chunk:
                return
            text = chunk.decode("utf-8", errors="replace").rstrip("\n")
            if self._options.stderr is not None:
                self._options.stderr(text)
            elif self._options.debug:
                print(text, file=sys.stderr)

    def write(self, data: str) -> None:
        if self._closed:
            raise RuntimeError("Transport is closed")
        if self._process is None or self._process.stdin is None:
            raise RuntimeError("Transport is not started")
        if self._input_closed:
            raise RuntimeError("Transport input is already closed")

        self._process.stdin.write(data.encode("utf-8"))

    async def drain(self) -> None:
        if self._process is None or self._process.stdin is None:
            return
        await self._process.stdin.drain()

    def end_input(self) -> None:
        if self._closed or self._input_closed:
            return
        if self._process is None or self._process.stdin is None:
            return
        self._process.stdin.close()
        self._input_closed = True

    async def read_messages(self) -> AsyncIterator[Any]:
        if self._process is None or self._process.stdout is None:
            raise RuntimeError("Transport is not started")

        while True:
            line = await self._process.stdout.readline()
            if not line:
                break

            raw = line.decode("utf-8", errors="replace").strip()
            if not raw:
                continue
            try:
                yield parse_json_line(raw)
            except json.JSONDecodeError:
                continue

        await self._finalize_exit()

    async def wait_for_exit(self) -> None:
        if self._process is None:
            return
        await self._finalize_exit()

    async def _finalize_exit(self) -> None:
        if self._process is None:
            return

        return_code = self._process.returncode
        if return_code is None:
            return_code = await self._process.wait()

        if return_code != 0 and self._exit_error is None:
            self._exit_error = ProcessExitError(
                f"CLI process exited with code {return_code}"
            )

        if self._stderr_task is not None:
            await self._stderr_task
            self._stderr_task = None

    async def close(self) -> None:
        if self._closed:
            return

        self._closed = True

        if self._process is None:
            return

        if self._process.stdin is not None and not self._input_closed:
            self._process.stdin.close()
            self._input_closed = True

        if self._process.returncode is None:
            self._process.terminate()
            try:
                await asyncio.wait_for(self._process.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                self._process.kill()
                await self._process.wait()

        await self._finalize_exit()


def build_cli_arguments(options: QueryOptions) -> list[str]:
    args: list[str] = [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--channel=SDK",
    ]

    if options.model:
        args.extend(["--model", options.model])

    if options.system_prompt:
        args.extend(["--system-prompt", options.system_prompt])

    if options.append_system_prompt:
        args.extend(["--append-system-prompt", options.append_system_prompt])

    if options.permission_mode:
        args.extend(["--approval-mode", options.permission_mode])

    if options.max_session_turns is not None:
        args.extend(["--max-session-turns", str(options.max_session_turns)])

    if options.core_tools:
        args.extend(["--core-tools", ",".join(options.core_tools)])

    if options.exclude_tools:
        args.extend(["--exclude-tools", ",".join(options.exclude_tools)])

    if options.allowed_tools:
        args.extend(["--allowed-tools", ",".join(options.allowed_tools)])

    if options.auth_type:
        args.extend(["--auth-type", options.auth_type])

    if options.include_partial_messages:
        args.append("--include-partial-messages")

    if options.resume:
        args.extend(["--resume", options.resume])
    elif options.continue_session:
        args.append("--continue")
    elif options.session_id:
        args.extend(["--session-id", options.session_id])

    return args
