# SPEC-STREAMING.md: Claude-Compatible Streaming Mode for Qwen CLI

## Overview

This specification describes a Claude-compatible streaming output mode for the Qwen CLI that follows Claude's `--output-format stream-json` behavior. This feature will allow users to receive content incrementally as newline-delimited JSON objects, making it ideal for programmatic consumption and headless operations.

## Motivation

Based on research of Claude's CLI implementation, Claude uses `--output-format stream-json` to provide real-time streaming output for headless and programmatic usage. This format outputs newline-delimited JSON objects as content is generated, enabling:

1. Real-time consumption of partial results
2. Better integration with stream-processing tools
3. Lower latency for programmatic use cases
4. Compatibility with Claude-style workflows

## Specification

### New Output Format: `stream-json`

A new output format will be added that enables streaming JSON output compatible with Claude's implementation.

### CLI Option

- Extended argument: `--output-format stream-json`
- Works with `-p` flag for headless mode
- Outputs newline-delimited JSON objects as content is generated

### Output Behavior

In `stream-json` mode:

1. Each content chunk is output as a separate JSON object followed by a newline
2. Objects are emitted as soon as they arrive from the API
3. Format follows Claude's pattern for streaming JSON output
4. Each JSON object contains a status and the content or metadata

### Claude-Compatible Event Structure

The streaming output will include events similar to Claude's format:

#### Content Event

```json
{ "type": "content_block_delta", "text": "chunk of content" }
```

#### Start Event

```json
{
  "type": "message_start",
  "message": { "id": "message_id", "model": "model_name" }
}
```

#### Finish Event

```json
{
  "type": "message_stop",
  "stop_reason": "stop_turn",
  "usage": { "input_tokens": 10, "output_tokens": 25 }
}
```

#### Tool Call Event

```json
{ "type": "tool_call", "name": "tool_name", "arguments": { "param": "value" } }
```

## Implementation Details

### 1. Enum Extension

Extend the `OutputFormat` enum in `packages/core/src/output/types.ts`:

```typescript
export enum OutputFormat {
  TEXT = 'text',
  JSON = 'json',
  STREAM_JSON = 'stream-json',
}
```

### 2. CLI Parsing Update

Update the argument parser in `packages/cli/src/config/config.ts` to accept 'stream-json' as a valid choice for `--output-format`:

```typescript
.option('output-format', {
  alias: 'o',
  type: 'string',
  description: 'The format of the CLI output.',
  choices: ['text', 'json', 'stream-json'],
})
```

### 3. Non-Interactive Logic Update

Modify `packages/cli/src/nonInteractiveCli.ts` to handle the `stream-json` mode in the `runNonInteractive` function:

When `config.getOutputFormat() === OutputFormat.STREAM_JSON`:

- Each event from the response stream should be formatted as a JSON object and written to stdout with a newline
- Maintain the streaming behavior (output immediately as received)
- Include appropriate Claude-compatible event types in the JSON

### 4. Event Processing

For each event type received in the streaming response:

- `GeminiEventType.Content`: Output as `{"type": "content_block_delta", "text": "content"}`
- Message start: Output as `{"type": "message_start", ...}`
- Message finish: Output as `{"type": "message_stop", ...}`
- Tool calls: Output as `{"type": "tool_call", ...}`

## Example Usage

```bash
# Claude-compatible streaming
qwen -p "Explain quantum computing" --output-format stream-json

# Streaming piped to jq for processing
qwen -p "Generate a list" --output-format stream-json | jq -c 'select(.type == "content_block_delta") | .text'

# Processing streaming output
qwen -p "Write code" --output-format stream-json | while read line; do
  echo "Received: $line"
done
```

## Mapping from Qwen Events to Claude-Style Events

For compatibility with Claude's format, we'll map Qwen's `GeminiEventType` to Claude-style streaming events:

- `GeminiEventType.Content` → `{"type": "content_block_delta", "text": "content"}`
- `GeminiEventType.ToolCallRequest` → `{"type": "tool_call", "name": "tool_name", "arguments": {...}}`
- `GeminiEventType.Finished` → `{"type": "message_stop", "reason": "finish_reason", "usage": {...}}`
- Other events will be converted to appropriate Claude-style equivalents

## Error Handling

- Errors should be formatted as JSON objects following Claude's conventions
- Error messages remain on stderr in all formats
- The application should still exit with appropriate error codes

## Compatibility

- The stream-json mode should work with existing functionality
- Tool calls and other interactive features should continue to work
- Only the output format changes, not the core functionality

## Performance Considerations

- Stream-json mode should have low latency for content delivery
- Memory usage should be minimal since content is not buffered in a single response
- The API calls remain the same; only output formatting changes

## Validation Criteria

- Stream-json mode outputs newline-delimited JSON objects as content arrives
- Each object contains appropriate Claude-compatible event types
- Tool calls and other events are properly formatted as JSON
- All existing functionality remains intact
- Error handling works consistently with other output modes

This specification provides a roadmap for implementing a Claude-compatible streaming mode that follows the same patterns Claude uses for `--output-format stream-json`, making it suitable for programmatic consumption and headless operations.
