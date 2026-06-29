# Python SDK

## `qwen-code-sdk`

`qwen-code-sdk` is an experimental Python SDK for Qwen Code. v1 targets the
existing `stream-json` CLI protocol and keeps the transport surface small and
testable.

## Scope

- Package name: `qwen-code-sdk`
- Import path: `qwen_code_sdk`
- Runtime requirement: Python `>=3.10`
- CLI dependency: external `qwen` executable is required in v1
- Transport scope: process transport only
- Not included in v1: ACP transport, SDK-embedded MCP servers

## Install

```bash
pip install qwen-code-sdk
```

For preview releases:

```bash
pip install --pre qwen-code-sdk
```

If `qwen` is not on `PATH`, pass `path_to_qwen_executable` explicitly.

Before writing SDK code, make sure the CLI works in the same shell:

```bash
qwen --version
```

## Quick Start

```python
import asyncio

from qwen_code_sdk import (
    is_sdk_assistant_message,
    is_sdk_result_message,
    query,
)


def extract_text(message):
    content = message.get("message", {}).get("content", [])
    if not isinstance(content, list):
        return repr(content)
    texts = [
        block.get("text", "")
        for block in content
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    return "".join(texts) if texts else "[no text content]"


def print_result(message):
    if message.get("is_error"):
        error = message.get("error") or {}
        print(f"Error: {error.get('message', 'Unknown error')}")
        return
    print(message.get("result", ""))


async def main() -> None:
    async with query(
        "Explain the repository structure.",
        {
            "cwd": "/path/to/project",
            "path_to_qwen_executable": "qwen",
        },
    ) as result:
        async for message in result:
            if is_sdk_assistant_message(message):
                print(extract_text(message))
            elif is_sdk_result_message(message):
                print_result(message)


asyncio.run(main())
```

`asyncio.run()` is appropriate for standalone scripts. If your application
already runs an event loop, such as Jupyter, FastAPI, or pytest-asyncio, call
`await main()` instead.

## Sync Usage

Use `query_sync` when your host application is not async:

```python
from qwen_code_sdk import is_sdk_result_message, query_sync


with query_sync(
    "Summarize this repository in one paragraph.",
    {
        "cwd": "/path/to/project",
        "path_to_qwen_executable": "qwen",
    },
) as result:
    for message in result:
        if is_sdk_result_message(message):
            if message.get("is_error"):
                error = message.get("error") or {}
                print(f"Error: {error.get('message', 'Unknown error')}")
            else:
                print(message.get("result", ""))
```

## API Surface

### Top-level entry points

- `query(prompt, options=None) -> Query`
- `query_sync(prompt, options=None) -> SyncQuery`

`prompt` supports either:

- `str` for single-turn requests
- `AsyncIterable[SDKUserMessage]` for multi-turn streams

### `Query`

- Async iterable over SDK messages
- `close()`
- `interrupt()`
- `set_model(model)`
- `set_permission_mode(mode)`
- `supported_commands()`
- `mcp_server_status()`
- `get_session_id()`
- `is_closed()`

### `QueryOptions`

| Option                     | Type / values                                              | Description                                                                                                     |
| -------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `cwd`                      | `str`                                                      | Working directory for the CLI process.                                                                          |
| `model`                    | `str`                                                      | Model override for this SDK session.                                                                            |
| `path_to_qwen_executable`  | `str`                                                      | `qwen`, an explicit binary path, or a `.js` CLI bundle.                                                         |
| `permission_mode`          | `default`, `plan`, `auto-edit`, `yolo`                     | Tool execution approval mode. `yolo` auto-approves all tools; use it only in trusted or sandboxed environments. |
| `can_use_tool`             | async callback                                             | Custom permission callback for tool requests.                                                                   |
| `env`                      | `dict[str, str]`                                           | Extra environment variables passed to the CLI process.                                                          |
| `system_prompt`            | `str`                                                      | Override the system prompt.                                                                                     |
| `append_system_prompt`     | `str`                                                      | Append extra instructions to the system prompt.                                                                 |
| `debug`                    | `bool`                                                     | Forward CLI stderr to stderr when no `stderr` hook exists.                                                      |
| `max_session_turns`        | `int`                                                      | Maximum turns before the CLI ends the session.                                                                  |
| `core_tools`               | `list[str]`                                                | Restrict the available tool set.                                                                                |
| `exclude_tools`            | `list[str]`                                                | Exclude matching tools.                                                                                         |
| `allowed_tools`            | `list[str]`                                                | Allow matching tools without callback approval.                                                                 |
| `auth_type`                | `openai`, `anthropic`, `qwen-oauth`, `gemini`, `vertex-ai` | Authentication mode passed to the CLI.                                                                          |
| `include_partial_messages` | `bool`                                                     | Emit partial assistant stream events.                                                                           |
| `resume`                   | UUID string                                                | Resume a known session id.                                                                                      |
| `continue_session`         | `bool`                                                     | Continue the latest CLI session.                                                                                |
| `session_id`               | UUID string                                                | Start or correlate a session with a known id.                                                                   |
| `timeout`                  | mapping                                                    | Timeouts in seconds.                                                                                            |
| `stderr`                   | callable                                                   | Receives CLI stderr lines.                                                                                      |

Use only one of `resume`, `continue_session`, or `session_id` in a request. The
SDK raises `ValidationError` if these session options are combined.

Unsupported in v1:

- `mcp_servers`

### Common Configuration

```python
options = {
    "cwd": "/path/to/project",
    "path_to_qwen_executable": "qwen",
    "model": "qwen-plus",
    "permission_mode": "plan",
    "max_session_turns": 1,
    "env": {
        "OPENAI_MODEL": "qwen-plus",
    },
    "timeout": {
        "control_request": 60,
        "can_use_tool": 60,
        "stream_close": 60,
    },
}
```

Timeout values are seconds. `env` is merged on top of the parent process
environment, so you only need to pass variables that should differ for this SDK
session. Set secrets such as `OPENAI_API_KEY` in the parent environment or a
secrets manager rather than hardcoding them in source.

## Permission Handling

When the CLI emits a `can_use_tool` control request, the SDK routes it through
`can_use_tool(tool_name, tool_input, context)`.

- Default behavior: deny
- Default timeout: 60 seconds, configurable with `timeout.can_use_tool`
- Timeout fallback: deny
- Callback exceptions: converted to deny with an error message
- Callback context: `cancel_event`, `suggestions`, and `blocked_path`
- Callback contract: `can_use_tool` must be async with 3 positional arguments;
  `stderr` must accept 1 positional string argument

Example:

```python
import asyncio
from pathlib import Path

from qwen_code_sdk import is_sdk_result_message, query

PROJECT_ROOT = Path("/path/to/project").resolve()


def project_path(tool_name, tool_input):
    key = "path" if tool_name == "list_directory" else "file_path"
    raw_path = tool_input.get(key)
    if not isinstance(raw_path, str) or not raw_path:
        return None

    resolved = (PROJECT_ROOT / raw_path).resolve()
    try:
        resolved.relative_to(PROJECT_ROOT)
    except ValueError:
        return None
    return resolved


async def can_use_tool(tool_name, tool_input, context):
    if tool_name in {"read_file", "list_directory", "write_file"}:
        resolved = project_path(tool_name, tool_input)
        if resolved is None:
            return {
                "behavior": "deny",
                "message": "Only project-local paths are allowed",
            }

        if tool_name == "write_file" and resolved.suffix != ".md":
            return {"behavior": "deny", "message": "Only .md files can be written"}

        return {"behavior": "allow", "updatedInput": tool_input}

    return {
        "behavior": "deny",
        "message": f"{tool_name} is not allowed by this application",
    }


async def main():
    async with query(
        "Update README.md with a short summary.",
        {
            "cwd": str(PROJECT_ROOT),
            "path_to_qwen_executable": "qwen",
            "can_use_tool": can_use_tool,
        },
    ) as result:
        async for message in result:
            if is_sdk_result_message(message):
                if message.get("is_error"):
                    error = message.get("error") or {}
                    print(f"Error: {error.get('message', 'Unknown error')}")
                else:
                    print(message.get("result", ""))


asyncio.run(main())
```

If you do not pass `can_use_tool`, the SDK denies permission requests by
default.

## Multi-Turn Sessions

For multi-turn sessions, pass an async iterable of `SDKUserMessage` objects:

```python
import asyncio

from qwen_code_sdk import SDKUserMessage, is_sdk_result_message, query

SESSION_ID = "123e4567-e89b-12d3-a456-426614174000"


async def prompts():
    first: SDKUserMessage = {
        "type": "user",
        "session_id": SESSION_ID,
        "message": {
            "role": "user",
            "content": "Create a concise project summary.",
        },
        "parent_tool_use_id": None,
    }
    yield first

    second: SDKUserMessage = {
        "type": "user",
        "session_id": SESSION_ID,
        "message": {
            "role": "user",
            "content": "Also list the test files.",
        },
        "parent_tool_use_id": None,
    }
    yield second


async def main():
    async with query(
        prompts(),
        {
            "cwd": "/path/to/project",
            "path_to_qwen_executable": "qwen",
            "session_id": SESSION_ID,
        },
    ) as result:
        async for message in result:
            if is_sdk_result_message(message):
                if message.get("is_error"):
                    error = message.get("error") or {}
                    print(f"Error: {error.get('message', 'Unknown error')}")
                else:
                    print(message.get("result", ""))


asyncio.run(main())
```

All messages in the async iterable must be known upfront. The SDK sends them
sequentially to the CLI but cannot feed a prior response back into the generator.
If you need conversational turn-taking, manage each turn as a separate `query()`
call.

## Runtime Controls

The returned `Query` object can control the running CLI process:

```python
import asyncio

from qwen_code_sdk import is_sdk_result_message, query


async def main():
    async with query(
        "Inspect this repository and explain the test layout.",
        {
            "cwd": "/path/to/project",
            "path_to_qwen_executable": "qwen",
        },
    ) as result:
        commands = await result.supported_commands()
        print(commands)

        await result.set_permission_mode("plan")
        await result.set_model("qwen-plus")

        async for message in result:
            if is_sdk_result_message(message):
                if message.get("is_error"):
                    error = message.get("error") or {}
                    print(f"Error: {error.get('message', 'Unknown error')}")
                else:
                    print(message.get("result", ""))


asyncio.run(main())
```

Use `interrupt()` to cancel the current operation, `close()` to clean up the
underlying process, and `get_session_id()` to persist a session id for later.

## Session Resume

```python
import asyncio

from qwen_code_sdk import is_sdk_result_message, query


async def main():
    # Resume a known session by its id.
    async with query(
        "Continue from this session.",
        {
            "path_to_qwen_executable": "qwen",
            "resume": "123e4567-e89b-12d3-a456-426614174000",
        },
    ) as known:
        async for message in known:
            if is_sdk_result_message(message):
                if message.get("is_error"):
                    error = message.get("error") or {}
                    print(f"Error: {error.get('message', 'Unknown error')}")
                else:
                    print(message.get("result", ""))


asyncio.run(main())
```

To continue the latest session instead:

```python
import asyncio

from qwen_code_sdk import is_sdk_result_message, query


async def main():
    async with query(
        "Continue the latest session.",
        {
            "path_to_qwen_executable": "qwen",
            "continue_session": True,
        },
    ) as latest:
        async for message in latest:
            if is_sdk_result_message(message):
                if message.get("is_error"):
                    error = message.get("error") or {}
                    print(f"Error: {error.get('message', 'Unknown error')}")
                else:
                    print(message.get("result", ""))


asyncio.run(main())
```

`resume` is useful when your application stores session ids. `continue_session`
delegates the selection of the latest session to the CLI.

## Error Model

- `ValidationError`: invalid options, invalid UUIDs, unsupported combinations
- `ControlRequestTimeoutError`: initialize, interrupt, or other control request
  timed out
- `ProcessExitError`: CLI exited non-zero
- `AbortError`: control request or session was cancelled

```python
from qwen_code_sdk import (
    ProcessExitError,
    ValidationError,
    is_sdk_result_message,
    query_sync,
)

try:
    with query_sync("Say hello", {"path_to_qwen_executable": "qwen"}) as result:
        for message in result:
            if is_sdk_result_message(message):
                if message.get("is_error"):
                    error = message.get("error") or {}
                    print(f"Error: {error.get('message', 'Unknown error')}")
                else:
                    print(message.get("result", ""))
except ValidationError as exc:
    print(f"Invalid SDK options: {exc}")
except ProcessExitError as exc:
    print(f"qwen exited with {exc.exit_code}: {exc}")
```

## Troubleshooting

If the SDK cannot start the CLI:

- Verify `qwen --version` works in the target environment
- Pass `path_to_qwen_executable` if your shell uses `nvm`, `pyenv`, or other
  non-standard PATH setup
- Use `debug=True` or `stderr=print` to surface CLI stderr while debugging

If session control calls time out:

- Check that the target `qwen` version supports `--input-format stream-json`
- Increase `timeout.control_request`
- Verify that no wrapper script is swallowing stdout/stderr

## Repository Integration

Repository-level helper commands:

- `npm run test:sdk:python`
- `npm run lint:sdk:python`
- `npm run typecheck:sdk:python`
- `npm run smoke:sdk:python -- --qwen qwen`

## Real E2E Smoke

For a real runtime check (actual `qwen` process + real model call), run from
the repository root. The npm helper uses `python3`, so ensure it resolves to a
Python `>=3.10` interpreter:

```bash
npm run smoke:sdk:python -- --qwen qwen
```

This script runs:

- async single-turn query
- async control flow (`supported_commands`, permission mode updates)
- sync `query_sync` query

It prints JSON and returns non-zero on failure.
