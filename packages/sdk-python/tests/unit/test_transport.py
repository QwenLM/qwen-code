from __future__ import annotations

import asyncio
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from qwen_code_sdk.transport import build_cli_arguments, prepare_spawn_info
from qwen_code_sdk.types import QueryOptions, TimeoutOptions

VALID_UUID = "123e4567-e89b-12d3-a456-426614174000"


class DummyProcess:
    def __init__(self) -> None:
        self.stdin = None
        self.stdout = None
        self.stderr = None
        self.returncode = 0


def test_build_cli_arguments_maps_supported_options() -> None:
    args = build_cli_arguments(
        QueryOptions(
            model="qwen3-coder",
            system_prompt="system prompt",
            append_system_prompt="append prompt",
            permission_mode="auto-edit",
            max_session_turns=7,
            core_tools=["Read", "Edit"],
            exclude_tools=["Bash(rm *)"],
            allowed_tools=["Bash(git status)"],
            auth_type="openai",
            include_partial_messages=True,
            session_id=VALID_UUID,
        )
    )

    assert args == [
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--channel=SDK",
        "--model",
        "qwen3-coder",
        "--system-prompt",
        "system prompt",
        "--append-system-prompt",
        "append prompt",
        "--approval-mode",
        "auto-edit",
        "--max-session-turns",
        "7",
        "--core-tools",
        "Read,Edit",
        "--exclude-tools",
        "Bash(rm *)",
        "--allowed-tools",
        "Bash(git status)",
        "--auth-type",
        "openai",
        "--include-partial-messages",
        "--session-id",
        VALID_UUID,
    ]


def test_cli_argument_precedence_prefers_resume_then_continue_then_session_id() -> None:
    args = build_cli_arguments(
        QueryOptions(
            resume=VALID_UUID,
            continue_session=True,
            session_id="223e4567-e89b-12d3-a456-426614174000",
        )
    )

    assert "--resume" in args
    assert "--continue" not in args
    assert "--session-id" not in args


def test_prepare_spawn_info_uses_runtime_for_python_scripts(tmp_path: Path) -> None:
    script_path = tmp_path / "fake-qwen.py"
    script_path.write_text("print('ok')\n", encoding="utf-8")

    spawn_info = prepare_spawn_info(str(script_path))

    assert spawn_info.command == sys.executable
    assert spawn_info.args == [str(script_path.resolve())]


def test_prepare_spawn_info_uses_node_for_javascript_files(tmp_path: Path) -> None:
    script_path = tmp_path / "fake-qwen.js"
    script_path.write_text("console.log('ok');\n", encoding="utf-8")

    spawn_info = prepare_spawn_info(str(script_path))

    assert spawn_info.command == "node"
    assert spawn_info.args == [str(script_path.resolve())]


def test_prepare_spawn_info_keeps_plain_command_names() -> None:
    spawn_info = prepare_spawn_info("qwen-custom")

    assert spawn_info.command == "qwen-custom"
    assert spawn_info.args == []


@pytest.mark.asyncio
async def test_transport_discards_stderr_when_debug_is_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    async def fake_create_subprocess_exec(*args: Any, **kwargs: Any) -> DummyProcess:
        captured["args"] = args
        captured["kwargs"] = kwargs
        return DummyProcess()

    monkeypatch.setattr(
        asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    transport_module = __import__(
        "qwen_code_sdk.transport",
        fromlist=["ProcessTransport"],
    )
    transport = transport_module.ProcessTransport(
        QueryOptions(timeout=TimeoutOptions())
    )

    await transport.start()

    assert captured["kwargs"]["stderr"] is subprocess.DEVNULL


def test_prepare_spawn_info_defaults_to_qwen_when_none() -> None:
    spawn_info = prepare_spawn_info(None)

    assert spawn_info.command == "qwen"
    assert spawn_info.args == []


def test_prepare_spawn_info_uses_node_for_mjs_files(tmp_path: Path) -> None:
    script_path = tmp_path / "cli.mjs"
    script_path.write_text("export default {};\n", encoding="utf-8")

    spawn_info = prepare_spawn_info(str(script_path))

    assert spawn_info.command == "node"
    assert spawn_info.args == [str(script_path.resolve())]


def test_prepare_spawn_info_uses_node_for_cjs_files(tmp_path: Path) -> None:
    script_path = tmp_path / "cli.cjs"
    script_path.write_text("module.exports = {};\n", encoding="utf-8")

    spawn_info = prepare_spawn_info(str(script_path))

    assert spawn_info.command == "node"
    assert spawn_info.args == [str(script_path.resolve())]


@pytest.mark.asyncio
async def test_transport_start_raises_after_close(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_create_subprocess_exec(*args: Any, **kwargs: Any) -> DummyProcess:
        return DummyProcess()

    monkeypatch.setattr(
        asyncio,
        "create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    transport_module = __import__(
        "qwen_code_sdk.transport",
        fromlist=["ProcessTransport"],
    )
    transport = transport_module.ProcessTransport(
        QueryOptions(timeout=TimeoutOptions())
    )
    transport._closed = True

    with pytest.raises(RuntimeError, match="Transport is closed"):
        await transport.start()


@pytest.mark.asyncio
async def test_read_messages_skips_malformed_json_lines() -> None:
    """Malformed JSON lines should be skipped, not crash the stream."""

    class FakeStdout:
        def __init__(self, lines: list[bytes]) -> None:
            self._lines = iter(lines)

        async def readline(self) -> bytes:
            return next(self._lines, b"")

    transport_module = __import__(
        "qwen_code_sdk.transport",
        fromlist=["ProcessTransport"],
    )
    transport = transport_module.ProcessTransport(
        QueryOptions(timeout=TimeoutOptions())
    )

    class FakeProcess:
        returncode = 0
        stdin = None
        stderr = None

        def __init__(self) -> None:
            self.stdout = FakeStdout([
                b'not valid json\n',
                b'{"type":"system","subtype":"init","uuid":"u","session_id":"s"}\n',
                b'also bad\n',
                b'',
            ])

        async def wait(self) -> int:
            return 0

    transport._process = FakeProcess()

    messages: list[Any] = []
    async for msg in transport.read_messages():
        messages.append(msg)

    assert len(messages) == 1
    assert messages[0]["type"] == "system"
