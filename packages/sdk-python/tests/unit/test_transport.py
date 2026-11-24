from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from qwen_code_sdk.transport import (
    ProcessTransport,
    _resolve_windows_command,
    build_cli_arguments,
    prepare_spawn_info,
)
from qwen_code_sdk.types import QueryOptions, TimeoutOptions

VALID_UUID = "123e4567-e89b-12d3-a456-426614174000"


class DummyProcess:
    def __init__(self) -> None:
        self.stdin = None
        self.stdout = None
        self.stderr = None
        self.returncode = 0


@pytest.mark.parametrize("command", ["qwen", "qwen.CMD"])
def test_windows_lookup_ignores_implicit_current_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, command: str
) -> None:
    trusted = tmp_path / "trusted"
    trusted.mkdir()
    shim = trusted / "qwen.CMD"
    shim.write_text("@echo trusted\n", encoding="utf-8")
    (tmp_path / "qwen.CMD").write_text("@echo decoy\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert _resolve_windows_command(command, {"PATH": str(trusted)}) == str(shim)
    with pytest.raises(FileNotFoundError):
        _resolve_windows_command(command, {"PATH": str(tmp_path / "missing")})


def test_windows_lookup_skips_shell_twins_and_unsupported_pathext(
    tmp_path: Path,
) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()
    (first / "qwen").write_text("#!/bin/sh\n", encoding="utf-8")
    (first / "qwen.JS").write_text("console.log('decoy')\n", encoding="utf-8")
    shim = second / "qwen.CMD"
    shim.write_text("@echo trusted\n", encoding="utf-8")

    assert _resolve_windows_command(
        "qwen", {"PATH": f"{first};{second}", "PATHEXT": ".JS;.CMD;.EXE"}
    ) == str(shim)


def test_windows_lookup_supports_dotted_command_names(tmp_path: Path) -> None:
    shim = tmp_path / "qwen.custom.CMD"
    shim.write_text("@echo trusted\n", encoding="utf-8")

    assert _resolve_windows_command("qwen.custom", {"PATH": str(tmp_path)}) == str(shim)


@pytest.mark.parametrize("path", [None, "", ";", '""'])
def test_windows_lookup_does_not_fall_back_to_current_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, path: str | None
) -> None:
    monkeypatch.chdir(tmp_path)
    (tmp_path / "qwen.CMD").write_text("@echo decoy\n", encoding="utf-8")

    with pytest.raises(FileNotFoundError):
        _resolve_windows_command("qwen", {} if path is None else {"PATH": path})


@pytest.mark.asyncio
async def test_windows_child_environment_is_case_insensitive(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import qwen_code_sdk.transport as transport_module

    shim = tmp_path / "qwen.CMD"
    shim.write_text("@echo trusted\n", encoding="utf-8")
    captured: dict[str, Any] = {}

    async def fake_spawn(*args: Any, **kwargs: Any) -> DummyProcess:
        captured.update(command=args[0], env=kwargs["env"])
        return DummyProcess()

    monkeypatch.setattr(transport_module.sys, "platform", "win32")
    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_spawn)
    monkeypatch.setenv("PATH", "inherited")
    monkeypatch.setenv("QWEN_TEST_VALUE", "parent")
    options = QueryOptions(
        env={"Path": "wrong", "path": str(tmp_path), "qwen_test_value": "child"}
    )
    await ProcessTransport(options).start()

    assert captured["command"] == str(shim)
    assert captured["env"]["PATH"] == str(tmp_path)
    assert captured["env"]["QWEN_TEST_VALUE"] == "child"
    assert all(key == key.upper() for key in captured["env"])


@pytest.mark.asyncio
async def test_child_environment_inherits_parent_and_applies_overrides(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    script = tmp_path / "environment_peer.py"
    script.write_text(
        "import json, os\n"
        "keys = ['QWEN_TEST_PARENT', 'QWEN_TEST_CHILD', 'QWEN_TEST_OVERRIDE', 'PATH']\n"
        "print(json.dumps({key: os.environ.get(key) for key in keys}))\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("QWEN_TEST_PARENT", "inherited")
    monkeypatch.setenv("QWEN_TEST_OVERRIDE", "parent")
    transport = ProcessTransport(
        QueryOptions(
            path_to_qwen_executable=str(script),
            env={
                "QWEN_TEST_CHILD": "child",
                "QWEN_TEST_OVERRIDE": "override",
                "PATH": "controlled-child-path",
            },
        )
    )
    try:
        await transport.start()
        messages = await asyncio.wait_for(_collect_transport_messages(transport), 10)
    finally:
        await transport.close()

    assert messages == [
        {
            "QWEN_TEST_PARENT": "inherited",
            "QWEN_TEST_CHILD": "child",
            "QWEN_TEST_OVERRIDE": "override",
            "PATH": "controlled-child-path",
        }
    ]
    assert os.environ["QWEN_TEST_OVERRIDE"] == "parent"


@pytest.mark.skipif(sys.platform != "win32", reason="Windows process tree cleanup")
@pytest.mark.parametrize("debug", [False, True])
@pytest.mark.asyncio
async def test_windows_close_stops_shim_cli_and_grandchild(
    tmp_path: Path,
    debug: bool,
) -> None:
    import ctypes

    script = tmp_path / "cli.py"
    script.write_text(
        "import json, os, subprocess, sys, time\n"
        "child = subprocess.Popen([sys.executable, '-c', "
        "'import time; time.sleep(60)'])\n"
        "print(json.dumps({'pids': [os.getpid(), child.pid]}), flush=True)\n"
        "time.sleep(60)\n",
        encoding="utf-8",
    )
    shim = tmp_path / "qwen.cmd"
    shim.write_text(f'@echo off\n"{sys.executable}" "{script}" %*\n', encoding="utf-8")
    transport = ProcessTransport(
        QueryOptions(path_to_qwen_executable=str(shim), debug=debug)
    )
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handles = []
    pids = []
    messages = transport.read_messages()
    try:
        await transport.start()
        message = await asyncio.wait_for(anext(messages), timeout=10)
        pids = message["pids"]
        handles = [kernel32.OpenProcess(0x00100000, False, pid) for pid in pids]
        assert all(handles)
        await asyncio.wait_for(transport.close(), timeout=15)
        assert all(kernel32.WaitForSingleObject(handle, 0) == 0 for handle in handles)
    finally:
        await messages.aclose()
        await transport.close()
        for pid, handle in zip(pids, handles, strict=True):
            if handle and kernel32.WaitForSingleObject(handle, 0) == 258:
                await asyncio.to_thread(
                    subprocess.run,
                    [
                        str(
                            Path(os.environ.get("SystemRoot", r"C:\Windows"))
                            / "System32"
                            / "taskkill.exe"
                        ),
                        "/PID",
                        str(pid),
                        "/T",
                        "/F",
                    ],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    check=False,
                    timeout=5,
                )
            if handle:
                kernel32.CloseHandle(handle)


@pytest.mark.asyncio
async def test_stderr_join_is_bounded_and_cancels_reader(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    wait_for = asyncio.wait_for

    async def short_wait(awaitable: Any, timeout: float | None) -> Any:
        assert timeout == 5.0
        return await wait_for(awaitable, timeout=0.01)

    monkeypatch.setattr(asyncio, "wait_for", short_wait)
    transport = ProcessTransport(QueryOptions())
    transport._process = DummyProcess()
    reader = asyncio.create_task(asyncio.sleep(60))
    transport._stderr_task = reader

    await transport.close()

    assert reader.cancelled()
    assert transport._stderr_task is None


@pytest.mark.asyncio
async def test_close_bounds_wait_after_kill(monkeypatch: pytest.MonkeyPatch) -> None:
    wait_for = asyncio.wait_for

    async def short_wait(awaitable: Any, timeout: float | None) -> Any:
        assert timeout == 5.0
        return await wait_for(awaitable, timeout=0.01)

    class HungProcess(DummyProcess):
        returncode: Any

        def __init__(self) -> None:
            super().__init__()
            self.returncode = None
            self.killed = False

        def terminate(self) -> None:
            pass

        def kill(self) -> None:
            self.killed = True

        async def wait(self) -> int:
            await asyncio.sleep(60)
            return 0

    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(asyncio, "wait_for", short_wait)
    transport = ProcessTransport(QueryOptions())
    process = HungProcess()
    transport._process = process
    reader = asyncio.create_task(asyncio.sleep(60))
    transport._stderr_task = reader

    with pytest.raises(asyncio.TimeoutError):
        await transport.close()

    assert process.killed
    assert reader.cancelled()


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


def test_build_cli_arguments_maps_all_consolidated_options() -> None:
    args = build_cli_arguments(
        QueryOptions(
            fork_session=True,
            max_tool_calls=50,
            max_subagent_depth=3,
            include_directories=["/extra/dir1", "/extra/dir2"],
            extensions=["ext1", "ext2"],
            allowed_mcp_server_names=["server1"],
            fallback_model=["qwen-plus", "qwen-turbo"],
            proxy="http://proxy:8080",
            sandbox=True,
            safe_mode=True,
            insecure=True,
            worktree=True,
            disabled_slash_commands=["/init", "/vim"],
            extra_args=["--custom-flag", "value"],
        )
    )

    assert "--fork-session" in args
    assert "--max-tool-calls" in args
    assert args[args.index("--max-tool-calls") + 1] == "50"
    assert "--max-subagent-depth" in args
    assert args[args.index("--max-subagent-depth") + 1] == "3"
    assert "--include-directories" in args
    assert args[args.index("--include-directories") + 1] == "/extra/dir1,/extra/dir2"
    assert "--extensions" in args
    assert args[args.index("--extensions") + 1] == "ext1,ext2"
    assert "--allowed-mcp-server-names" in args
    assert args[args.index("--allowed-mcp-server-names") + 1] == "server1"
    assert "--fallback-model" in args
    assert args[args.index("--fallback-model") + 1] == "qwen-plus,qwen-turbo"
    assert "--proxy" in args
    assert args[args.index("--proxy") + 1] == "http://proxy:8080"
    assert "--sandbox=true" in args
    assert "--safe-mode" in args
    assert "--insecure" in args
    assert "--worktree" in args
    assert "--disabled-slash-commands" in args
    assert args[args.index("--disabled-slash-commands") + 1] == "/init,/vim"
    assert "--custom-flag" in args
    assert args[args.index("--custom-flag") + 1] == "value"


def test_automatic_sandbox_keeps_text_extra_args_separate() -> None:
    args = build_cli_arguments(
        QueryOptions(sandbox=True, extra_args=["explain the parser"])
    )

    assert args[-2:] == ["--sandbox=true", "explain the parser"]


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


@pytest.mark.skipif(sys.platform != "win32", reason="Windows command shim discovery")
@pytest.mark.parametrize("executable", [None, "qwen", "qwen.cmd", "absolute"])
@pytest.mark.parametrize(
    "path_source", ["inherited", "PATH", "Path", "path", "PATH+Path", "Path+PATH"]
)
@pytest.mark.asyncio
async def test_transport_starts_windows_command_shim_on_path(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    executable: str | None,
    path_source: str,
) -> None:
    bin_dir = tmp_path / "npm prefix with spaces"
    bin_dir.mkdir()
    script_path = bin_dir / "fake_cli.py"
    script_path.write_text(
        "import json, os, sys\n"
        "print(json.dumps({'args': sys.argv[1:], 'path': os.environ['PATH']}))\n",
        encoding="utf-8",
    )
    shim_path = bin_dir / "qwen.cmd"
    shim_path.write_text(
        f'@echo off\n"{sys.executable}" "{script_path}" %*\n',
        encoding="utf-8",
    )
    cli_path = str(bin_dir)
    if executable == "absolute":
        executable = str(shim_path)
    env = None
    if path_source == "inherited":
        monkeypatch.setenv("PATH", cli_path)
    else:
        monkeypatch.setenv("PATH", str(tmp_path / "empty"))
        if "+" in path_source:
            first_key, last_key = path_source.split("+")
            env = {first_key: str(tmp_path / "empty"), last_key: cli_path}
        else:
            env = {path_source: cli_path}

    transport = ProcessTransport(
        QueryOptions(path_to_qwen_executable=executable, env=env, model="model name")
    )
    try:
        await transport.start()
        messages = await asyncio.wait_for(
            _collect_transport_messages(transport), timeout=10
        )
    finally:
        await transport.close()

    assert messages == [
        {
            "args": build_cli_arguments(QueryOptions(model="model name")),
            "path": cli_path,
        }
    ]


async def _collect_transport_messages(transport: ProcessTransport) -> list[Any]:
    return [message async for message in transport.read_messages()]


@pytest.mark.asyncio
async def test_transport_preserves_missing_executable_error(tmp_path: Path) -> None:
    transport = ProcessTransport(
        QueryOptions(path_to_qwen_executable=str(tmp_path / "missing-qwen"))
    )

    with pytest.raises(FileNotFoundError):
        await transport.start()


@pytest.mark.asyncio
async def test_transport_reads_stream_json_lines_larger_than_64_kib(
    tmp_path: Path,
) -> None:
    script_path = tmp_path / "large-stream-json.py"
    script_path.write_text(
        "import json\n"
        "message = {\n"
        '    "type": "user",\n'
        f'    "uuid": "{VALID_UUID}",\n'
        '    "session_id": "223e4567-e89b-12d3-a456-426614174000",\n'
        '    "parent_tool_use_id": None,\n'
        '    "message": {\n'
        '        "role": "user",\n'
        '        "content": [{\n'
        '            "type": "tool_result",\n'
        '            "tool_use_id": "test-tool-call",\n'
        '            "content": "x" * (128 * 1024),\n'
        '            "is_error": False,\n'
        "        }],\n"
        "    },\n"
        "}\n"
        "print(json.dumps(message))\n",
        encoding="utf-8",
    )

    transport_module = __import__(
        "qwen_code_sdk.transport",
        fromlist=["ProcessTransport"],
    )
    transport = transport_module.ProcessTransport(
        QueryOptions(
            path_to_qwen_executable=str(script_path),
            timeout=TimeoutOptions(),
        )
    )

    await transport.start()
    try:
        messages = [message async for message in transport.read_messages()]
    finally:
        await transport.close()

    assert len(messages) == 1
    assert messages[0]["type"] == "user"
    tool_result = messages[0]["message"]["content"][0]
    assert tool_result["type"] == "tool_result"
    assert tool_result["content"] == "x" * (128 * 1024)


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
        QueryOptions(path_to_qwen_executable=sys.executable, timeout=TimeoutOptions())
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
            self.stdout = FakeStdout(
                [
                    b"not valid json\n",
                    b'{"type":"system","subtype":"init","uuid":"u","session_id":"s"}\n',
                    b"also bad\n",
                    b"",
                ]
            )

        async def wait(self) -> int:
            return 0

    transport._process = FakeProcess()

    messages: list[Any] = []
    async for msg in transport.read_messages():
        messages.append(msg)

    assert len(messages) == 1
    assert messages[0]["type"] == "system"


@pytest.mark.asyncio
async def test_stderr_callback_exceptions_do_not_fail_transport() -> None:
    class FakeStdout:
        async def readline(self) -> bytes:
            return b""

    class FakeStderr:
        def __init__(self) -> None:
            self._lines = iter([b"error message\n", b""])

        async def readline(self) -> bytes:
            return next(self._lines, b"")

    transport_module = __import__(
        "qwen_code_sdk.transport",
        fromlist=["ProcessTransport"],
    )

    callback_calls = 0

    def stderr_callback(text: str) -> None:
        nonlocal callback_calls
        callback_calls += 1
        assert text == "error message"
        raise RuntimeError("sink failed")

    transport = transport_module.ProcessTransport(
        QueryOptions(
            stderr=stderr_callback,
            timeout=TimeoutOptions(),
        )
    )

    class FakeProcess:
        returncode = 0
        stdin = None

        def __init__(self) -> None:
            self.stdout = FakeStdout()
            self.stderr = FakeStderr()

        async def wait(self) -> int:
            return 0

    transport._process = FakeProcess()
    transport._stderr_task = asyncio.create_task(transport._forward_stderr())

    await transport.wait_for_exit()

    assert callback_calls == 1
