# qwen_code

Python SDK for programmatic access to qwen-code CLI.

> Note: The Qwen SDK for Python is currently a preliminary version. It is being developed by the QwenCodeCli through a highly iterative process, and its functionality may be unstable.

## Installation

```bash
pip install qwen_code
```

Or using uv:

```bash
uv add qwen_code
```

## Quick Start

```python
import asyncio
from qwen_code import create_query, CreateQueryOptions

async def main():
    # Create a query
    query = await create_query(CreateQueryOptions(
        command=["qwen-code", "sdk", "--channel=SDK"],
    ))

    # Send a message
    await query.stream_input([{
        "type": "user",
        "session_id": query.session_id,
        "message": {
            "role": "user",
            "content": "Hello, qwen-code!"
        },
        "parent_tool_use_id": None,
    }])

    # Iterate responses
    async for message in query:
        print(message)

    # Close the query
    await query.close()

if __name__ == "__main__":
    asyncio.run(main())
```

## Features

- **Async/Await API**: Modern Python async interface
- **Streaming Support**: Iterate messages as they arrive
- **Type Hints**: Full type annotations for better IDE support
- **Permission Callbacks**: Control tool execution with custom callbacks

## API Reference

### create_query

```python
async def create_query(options: CreateQueryOptions) -> Query
```

Create and initialize a Query instance.

### run_query

```python
async def run_query(
    options: CreateQueryOptions,
    messages: List[Dict[str, Any]],
) -> QueryResult
```

Convenience function to run a query and get the result.

### Query

Main class for interacting with qwen-code CLI.

**Methods:**
- `stream_input(messages)`: Send messages to the query
- `close()`: Close the query
- `set_permission_callback(callback)`: Set permission callback

**Properties:**
- `session_id`: The session ID
- `is_closed`: Whether the query is closed

## Message Types

### User Message

```python
{
    "type": "user",
    "session_id": "uuid",
    "message": {
        "role": "user",
        "content": "Your message here"
    },
    "parent_tool_use_id": None,
}
```

### Assistant Message

```python
{
    "type": "assistant",
    "uuid": "uuid",
    "session_id": "uuid",
    "message": {
        "id": "msg-id",
        "type": "message",
        "role": "assistant",
        "model": "model-name",
        "content": [...],
        "usage": {...}
    },
    "parent_tool_use_id": None,
}
```

### Result Message

```python
{
    "type": "result",
    "subtype": "success",
    "uuid": "uuid",
    "session_id": "uuid",
    "is_error": False,
    "result": "The result",
    "usage": {...},
    "duration_ms": 1500,
}
```

## Permission Callback

You can set a callback to control tool execution:

```python
from qwen_code import PermissionResult

def can_use_tool(tool_name: str, tool_input: dict, context: dict) -> PermissionResult:
    if tool_name == "read_file":
        return PermissionResult(behavior="allow")
    elif tool_name == "delete_file":
        return PermissionResult(behavior="deny", message="Cannot delete files")
    return PermissionResult(behavior="allow")

query.set_permission_callback(can_use_tool)
```

## Development

```bash
# Install dependencies
uv sync

# Run tests
uv run pytest

# Run tests with coverage
uv run pytest --cov
```
