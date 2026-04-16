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

If `qwen` is not on `PATH`, pass `path_to_qwen_executable` explicitly.

## Quick Start

```python
import asyncio

from qwen_code_sdk import is_sdk_result_message, query


async def main() -> None:
    result = query(
        "Explain the repository structure.",
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

Supported options in v1:

- `cwd`
- `model`
- `path_to_qwen_executable`
- `permission_mode`
- `can_use_tool`
- `env`
- `system_prompt`
- `append_system_prompt`
- `debug`
- `max_session_turns`
- `core_tools`
- `exclude_tools`
- `allowed_tools`
- `auth_type`
- `include_partial_messages`
- `resume`
- `continue_session`
- `session_id`
- `timeout`
- `mcp_servers`

Session argument priority is fixed as:

1. `resume`
2. `continue_session`
3. `session_id`

## Permission Handling

When the CLI emits a `can_use_tool` control request, the SDK routes it through
`can_use_tool(tool_name, tool_input, context)`.

- Default behavior: deny
- Default timeout: 60 seconds
- Timeout fallback: deny
- Callback exceptions: converted to deny with an error message

## Error Model

- `ValidationError`: invalid options, invalid UUIDs, unsupported combinations
- `ControlRequestTimeoutError`: initialize, interrupt, or other control request
  timed out
- `ProcessExitError`: CLI exited non-zero
- `AbortError`: control request or session was cancelled

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
