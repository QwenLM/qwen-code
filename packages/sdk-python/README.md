# qwen-code-sdk

Experimental Python SDK for programmatic access to Qwen Code through the
`stream-json` protocol.

## Installation

```bash
pip install qwen-code-sdk
```

For preview releases, enable pre-release resolution:

```bash
pip install --pre qwen-code-sdk
```

## Requirements

- Python `>=3.10`
- External `qwen` CLI installed and available in `PATH`

You can also point the SDK at an explicit CLI binary or script with
`path_to_qwen_executable`.

Before using the SDK, verify that the CLI works in the same environment:

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


def text_from_message(message):
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
        "List the top-level packages in this repository.",
        {
            "cwd": "/path/to/project",
            "path_to_qwen_executable": "qwen",
        },
    ) as result:
        async for message in result:
            if is_sdk_assistant_message(message):
                print(text_from_message(message))
            elif is_sdk_result_message(message):
                print_result(message)


asyncio.run(main())
```

`asyncio.run()` is appropriate for standalone scripts. If your application
already runs an event loop, such as Jupyter, FastAPI, or pytest-asyncio, call
`await main()` instead.

## Sync API

```python
from qwen_code_sdk import is_sdk_result_message, query_sync


with query_sync(
    "Say hello",
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

## Main APIs

- `query(prompt, options=None) -> Query`
- `query_sync(prompt, options=None) -> SyncQuery`
- `Query.close()`, `interrupt()`, `set_model()`, `set_permission_mode()`
- `Query.supported_commands()`, `mcp_server_status()`, `get_session_id()`

`prompt` accepts either a single `str` or an `AsyncIterable[SDKUserMessage]`
for multi-turn sessions.

## Common Options

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

Common fields:

- `cwd`: working directory used by the CLI
- `path_to_qwen_executable`: `qwen`, an absolute binary path, or a `.js` CLI
  bundle
- `model`: model override for this session
- `permission_mode`: one of `default`, `plan`, `auto-edit`, or `yolo`; `yolo`
  auto-approves all tools, so use it only in trusted or sandboxed environments
- `env`: extra environment variables passed to the CLI process
- `system_prompt` / `append_system_prompt`: override or extend the system
  prompt
- `core_tools`, `exclude_tools`, `allowed_tools`: constrain tool availability
- `timeout`: seconds for control requests, permission callbacks, and stream
  close waits

`env` is merged on top of the parent process environment. Set secrets such as
`OPENAI_API_KEY` in the parent environment or a secrets manager rather than
hardcoding them in source.

## Multi-Turn Sessions

For multi-turn use cases, pass an async iterable of `SDKUserMessage` objects.
Use a stable UUID for `session_id` when you want to correlate messages:

```python
import asyncio

from qwen_code_sdk import SDKUserMessage, is_sdk_result_message, query

SESSION_ID = "123e4567-e89b-12d3-a456-426614174000"


async def prompts():
    first: SDKUserMessage = {
        "type": "user",
        "session_id": SESSION_ID,
        "message": {"role": "user", "content": "Create a short project summary."},
        "parent_tool_use_id": None,
    }
    yield first

    second: SDKUserMessage = {
        "type": "user",
        "session_id": SESSION_ID,
        "message": {"role": "user", "content": "Also list the test files."},
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

## Permission Callback

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
        "Update README.md with a one paragraph summary.",
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

The callback defaults to deny. If it does not return within
`timeout.can_use_tool` seconds, the SDK auto-denies the tool request. The
default timeout is 60 seconds.

The `context` argument includes `cancel_event`, `suggestions`, and
`blocked_path` when the CLI provides a path-specific permission target.
`can_use_tool` must be an `async def` callback accepting
`(tool_name, tool_input, context)`. `stderr` must accept a single `str`.

## Runtime Controls

Control methods can be called while a session is active:

```python
import asyncio

from qwen_code_sdk import is_sdk_result_message, query


async def main():
    async with query(
        "Inspect this project and wait for my next instruction.",
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

Use `interrupt()` to cancel the current CLI operation and `close()` to clean up
the underlying process.

## Resuming Sessions

```python
import asyncio

from qwen_code_sdk import is_sdk_result_message, query


async def main():
    # Resume a known session.
    async with query(
        "Continue from the previous state.",
        {
            "path_to_qwen_executable": "qwen",
            "resume": "123e4567-e89b-12d3-a456-426614174000",
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

To continue the latest session instead:

```python
import asyncio

from qwen_code_sdk import is_sdk_result_message, query


async def main():
    async with query(
        "Continue the last session.",
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

Use only one of `resume`, `continue_session`, or `session_id` in a request. The
SDK raises `ValidationError` if these session options are combined.

## Error Handling

- `ValidationError`: invalid query options or malformed session identifiers
- `ControlRequestTimeoutError`: CLI control operation exceeded timeout
- `ProcessExitError`: `qwen` exited with a non-zero code
- `AbortError`: query or control request was cancelled

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

## Current Scope

`0.1.x` is intentionally narrow:

- Uses external `qwen` CLI via process transport
- Targets `stream-json` parity with the TypeScript SDK core flow
- Does not yet implement ACP transport
- Does not yet embed MCP servers inside the SDK process

See [developer documentation](../../docs/developers/sdk-python.md) for more
detail.
