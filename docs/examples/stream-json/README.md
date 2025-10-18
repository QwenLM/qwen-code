# Stream JSON Interaction Example

This example demonstrates how to drive the Qwen Code CLI directly via the JSON Lines protocol and provides a mock SDK client script to facilitate integration testing.

## Prerequisites

- `qwen code` is installed locally and ready to run (or run `npx tsx packages/cli/index.ts` inside the repo).
- It is recommended to enable `--include-partial-messages` to experience incremental events.

## Quick CLI Walkthrough

1. Prepare an input stream (write it to `examples/stream-json/request.jsonl`):

   ```bash
   cat <<'EOF' > examples/stream-json/request.jsonl
   {"type":"control_request","request_id":"req-init-1","request":{"subtype":"initialize","hooks":null}}
   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"请阅读 README.md 并总结三个关键特性。"}]}}
   {"type":"control_request","request_id":"req-interrupt-1","request":{"subtype":"interrupt"}}
   EOF
   ```

2. Run the CLI and pipe the JSONL into standard input. Inside the repo, `npm run qwen` is recommended (parameters for the CLI itself go after `--`):

   ```bash
   npm run qwen -- \
     --input-format stream-json \
     --output-format stream-json \
     --include-partial-messages \
     --model qwen-coder \
     < examples/stream-json/request.jsonl
   ```

3. Observe standard output: when the CLI initializes successfully, it prints `system/init`, `control_response`, and `stream_event` entries containing `thinking_delta` and `text_delta`, and finally ends with a `result` event.

> Note: If the CLI emits events like `control_request.can_use_tool`, the caller must promptly write back a `control_response`; otherwise, the process waits for the acknowledgement.

## Mock SDK Script

- Location: `docs/examples/stream-json/simple_stream_json_client.py`
- Functionality: launches a CLI subprocess, automatically completes the `initialize` handshake, sends user messages, and provides sample responses for control requests such as `can_use_tool` and `hook_callback`. Once `result` is received, the script ends the session with an `interrupt`.

Usage example:

```bash
python docs/examples/stream-json/simple_stream_json_client.py
```

By default the script launches the CLI via `npm run qwen -- …`. To replace the command, set the `QWEN_STREAM_JSON_COMMAND` environment variable, for example:

```bash
# export QWEN_STREAM_JSON_COMMAND="npm run qwen -- --input-format stream-json --output-format stream-json --include-partial-messages --model qwen-coder"
export QWEN_STREAM_JSON_COMMAND="npm run qwen -- --input-format stream-json --output-format stream-json --include-partial-messages"
python docs/examples/stream-json/simple_stream_json_client.py
```

The script exposes a `StreamJsonClient` class that can be customized with `StreamJsonClientOptions` to define commands, initialization requests, user messages, and control handlers. For example:

```python
import asyncio
import sys

sys.path.append("docs/examples/stream-json")
from simple_stream_json_client import StreamJsonClient, StreamJsonClientOptions

options = StreamJsonClientOptions(
    command=["npm", "run", "qwen", "--", "--input-format", "stream-json", "--output-format", "stream-json"],
    user_messages=[
        {
            "type": "user",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "举例说明 stream-json 协议用途"}],
            },
        }
    ],
    extra_handlers={
        # Reject sensitive tools
        "can_use_tool": lambda client, request_id, payload: client.send_control_response(
            request_id,
            success=True,
            response={"behavior": "deny", "message": "demo client blocks all tools"},
        ),
    },
)

client = StreamJsonClient(options)
asyncio.run(client.run())
```

## Automated Tests

New unit tests validate the Stream JSON functionality. Run them with:

```bash
npx vitest run \
  packages/cli/src/streamJson/writer.test.ts \
  packages/cli/src/streamJson/session.test.ts \
  packages/cli/src/nonInteractiveCli.test.ts
```

The tests cover:
- `system/init` events and session metadata
- Incremental messages (`thinking_delta`, `input_json_delta`, etc.)
- `usage` and `duration_api_ms` fields in the `result` event
- Control request bridging logic for `can_use_tool`

Following these steps quickly verifies the Stream JSON protocol’s output and control-channel behavior in the CLI.

### Sample Run Log (Excerpt)

The table below selects key log entries from the script run and annotates the showcased capabilities:

| Log Snippet | Description |
| --- | --- |
| `{"type":"control_response","request_id":"demo-init","success":true,...}`<br/>`{"type":"system","subtype":"init",...}` | Script writes back `initialize`, and the CLI outputs session metadata in the `system/init` event (control channel + system event).
| `{"type":"user","message":{"role":"user","content":"请阅读 README.md..."}}` | The client sends a `user` message to trigger a single-turn session.
| `{"type":"stream_event","event":{"type":"message_start",...}}`<br/>`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"..."}}}`<br/>`{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"input_json_delta",...}}}` | Incremental event streaming: text `text_delta` and tool input `input_json_delta`.
| `{"type":"assistant","message":{"content":[{"type":"tool_use",...}]}}`<br/>`{"type":"user","message":{"content":[{"type":"tool_result",...}]},...}` | The CLI initiates a tool call; the script writes back `tool_result`, demonstrating bridging for `can_use_tool` and tool-result propagation.
| Continuous `content_block_delta` entries printing the README summary<br/>`{"type":"assistant","message":{"content":[{"type":"text","text":"..."}]}}` | Incremental reasoning/text events align with the final complete `assistant` message.
| `{"type":"result","subtype":"session_summary","duration_api_ms":..., ...}` | The `result` event includes statistics such as `duration_api_ms` and `num_turns`.
| `{"type":"control_response","request_id":"demo-interrupt","success":true,...}` | The script sends an `interrupt` to conclude, and the CLI returns a success response.

## Manual Verification Guide

Use the following commands to manually check that the core capabilities introduced in this implementation are present:

1. **Initialization and Incremental Events** (verify that the `system/init` and `stream_event` lifecycle matches the Claude protocol)
   ```bash
   npm run qwen -- \
     --input-format stream-json \
     --output-format stream-json \
     --include-partial-messages \
     --model qwen-coder \
     < examples/stream-json/request.jsonl
   ```
   Expected output: initialization includes the complete `system/init` fields; during the assistant response, `message_start`, `content_block_start/delta/stop`, and `message_stop` events appear.

2. **Real-Time Control Channel** (verify advanced subtypes like `can_use_tool` and `hook_callback`)
   ```bash
   npm run qwen -- --input-format stream-json --output-format stream-json --model qwen-coder
   # Enter sequentially:
   {"type":"control_request","request_id":"req-init","request":{"subtype":"initialize"}}
   {"type":"user","message":{"role":"user","content":[{"type":"text","text":"请执行 ls"}]}}
   ```
   Expected output: the CLI responds to the initialization request with `control_response.success`. When a tool invocation is triggered, it sends `control_request.can_use_tool`, and hook acknowledgements surface as `system hook_callback` messages.

3. **MCP Message Bridging** (verify `mcp_message` passthrough)
   ```bash
   npm run qwen -- --input-format stream-json --output-format stream-json --model qwen-coder
   {"type":"control_request","request_id":"req-mcp","request":{"subtype":"mcp_message","server_name":"default","message":{"jsonrpc":"2.0","id":"1","method":"tools/list"}}}
   ```
   Expected output: `control_response.success` contains `mcp_response.result.tools` listing the registered MCP tools. If MCP is not configured, the structured fields in `control_response.error` can be inspected instead.

4. **Tool Result Linking** (verify `tool_result` carrying and `parent_tool_use_id`)
   ```bash
   npm run qwen -- --input-format stream-json --output-format stream-json --model qwen-coder
   {"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"demo-tool","content":[{"type":"text","text":"手动工具结果"}]}]},"parent_tool_use_id":"demo-tool"}
   ```
   Expected output: during the subsequent `runNonInteractive` call the CLI reads this `tool_result`, continues the dialog when necessary, and suppresses redundant user echoes.

These manual steps cover the advanced control requests, system initialization fields, incremental event completion, user-envelope extensions, and error semantics introduced by the remaining OpenSpec tasks.

## Automated Verification Script

To execute all of the above control-channel scenarios at once, run:

```bash
python docs/examples/stream-json/validate_stream_json_cli.py
```

The script automatically launches `qwen code`, triggers events such as `initialize`, `hook_callback`, `can_use_tool`, and `mcp_message` in sequence, prints every request/response JSON line in real time, and finally summarizes the pass/fail status of each assertion in a table. Adjust behavior with these environment variables:

- `QWEN_STREAM_JSON_COMMAND`: override the CLI launch command.
- `STREAM_JSON_VALIDATE_VERBOSE=0`: set to `0` to suppress line-by-line logging.
- `STREAM_JSON_VALIDATE_PROMPT=1`: enable the additional “user prompt triggers tool invocation” scenario (requires a usable model or proxy credentials).
- `STREAM_JSON_VALIDATE_TOOL_RESULT=1`: enable the additional scenario for the `tool_result + parent_tool_use_id` flow.
