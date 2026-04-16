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
