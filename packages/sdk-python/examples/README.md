# Python SDK Examples

This directory contains examples demonstrating how to use the qwen-code Python SDK.

## Running Examples

```bash
cd packages/sdk-python
uv run python examples/<example_name>.py
```

## Examples

### simple_query.py

Basic single-turn query with the qwen-code CLI.

```bash
uv run python examples/simple_query.py
```

### multi_turn.py

Multi-turn conversation with streaming messages.

```bash
uv run python examples/multi_turn.py
```

### permission_handler.py

Custom permission callback for tool execution control.

```bash
uv run python examples/permission_handler.py
```

## Requirements

- Python >= 3.10
- qwen-code CLI installed and in PATH (or use `pathToQwenExecutable` option)
