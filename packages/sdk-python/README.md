# qwen-code-sdk

Experimental Python SDK for programmatic access to Qwen Code through the
`stream-json` protocol.

## Installation

```bash
pip install qwen-code-sdk
```

## Requirements

- Python `>=3.10`
- External `qwen` CLI installed and available in `PATH`

You can also point the SDK at an explicit CLI binary or script with
`path_to_qwen_executable`.

## Quick Start

```python
import asyncio

from qwen_code_sdk import is_sdk_result_message, query


async def main() -> None:
    result = query(
        "List the top-level packages in this repository.",
        {
            "cwd": "/path/to/project",
            "path_to_qwen_executable": "qwen",
        },
    )

    async for message in result:
        if is_sdk_result_message(message):
            print(message["result"])


asyncio.run(main())
```

## Sync API

```python
from qwen_code_sdk import query_sync


result = query_sync(
    "Say hello",
    {
        "path_to_qwen_executable": "qwen",
    },
)

for message in result:
    print(message)

result.close()
```

## Main APIs

- `query(prompt, options=None) -> Query`
- `query_sync(prompt, options=None) -> SyncQuery`
- `Query.close()`, `interrupt()`, `set_model()`, `set_permission_mode()`
- `Query.supported_commands()`, `mcp_server_status()`, `get_session_id()`

`prompt` accepts either a single `str` or an `AsyncIterable[SDKUserMessage]`
for multi-turn sessions.

## Permission Callback

```python
from qwen_code_sdk import query


async def can_use_tool(tool_name, tool_input, context):
    if tool_name == "write_file":
        return {"behavior": "deny", "message": "Writes disabled in this app"}
    return {"behavior": "allow", "updatedInput": tool_input}


result = query(
    "Create hello.txt",
    {
        "path_to_qwen_executable": "qwen",
        "can_use_tool": can_use_tool,
    },
)
```

The callback defaults to deny. If it does not return within 60 seconds, the SDK
auto-denies the tool request.

## Errors

- `ValidationError`: invalid query options or malformed session identifiers
- `ControlRequestTimeoutError`: CLI control operation exceeded timeout
- `ProcessExitError`: `qwen` exited with a non-zero code
- `AbortError`: query or control request was cancelled

## Current Scope

`0.1.x` is intentionally narrow:

- Uses external `qwen` CLI via process transport
- Targets `stream-json` parity with the TypeScript SDK core flow
- Does not yet implement ACP transport
- Does not yet embed MCP servers inside the SDK process

See [developer documentation](../../docs/developers/sdk-python.md) for more
detail.
