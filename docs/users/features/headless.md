# Headless Mode

Headless mode allows you to run Qwen Code programmatically from command line
scripts and automation tools without any interactive UI. This is ideal for
scripting, automation, CI/CD pipelines, and building AI-powered tools.

## Overview

The headless mode provides a headless interface to Qwen Code that:

- Accepts prompts via command line arguments or stdin
- Returns structured output (text or JSON)
- Supports file redirection and piping
- Enables automation and scripting workflows
- Provides consistent exit codes for error handling
- Can resume previous sessions scoped to the current project for multi-step automation

## Basic Usage

### Direct Prompts

Use the `--prompt` (or `-p`) flag to run in headless mode:

```bash
qwen --prompt "What is machine learning?"
```

### Stdin Input

Pipe input to Qwen Code from your terminal:

```bash
echo "Explain this code" | qwen
```

### Combining with File Input

Read from files and process with Qwen Code:

```bash
cat README.md | qwen --prompt "Summarize this documentation"
```

### Resume Previous Sessions (Headless)

Reuse conversation context from the current project in headless scripts:

```bash
# Continue the most recent session for this project and run a new prompt
qwen --continue -p "Run the tests again and summarize failures"

# Resume a specific session ID directly (no UI)
qwen --resume 123e4567-e89b-12d3-a456-426614174000 -p "Apply the follow-up refactor"
```

> [!note]
>
> - Session data is project-scoped JSONL under `~/.qwen/projects/<sanitized-cwd>/chats`.
> - Restores conversation history, tool outputs, and chat-compression checkpoints before sending the new prompt.

## Output Formats

Qwen Code supports multiple output formats for different use cases:

### Text Output (Default)

Standard human-readable output:

```bash
qwen -p "What is the capital of France?"
```

Response format:

```
The capital of France is Paris.
```

### JSON Output

Returns structured data as a JSON array. All messages are buffered and output together when the session completes. This format is ideal for programmatic processing and automation scripts.

The JSON output is an array of message objects. The output includes multiple message types: system messages (session initialization), assistant messages (AI responses), and result messages (execution summary).

#### Example Usage

```bash
qwen -p "What is the capital of France?" --output-format json
```

Output (at end of execution):

```json
[
  {
    "type": "system",
    "subtype": "session_start",
    "uuid": "...",
    "session_id": "...",
    "model": "qwen3-coder-plus",
    ...
  },
  {
    "type": "assistant",
    "uuid": "...",
    "session_id": "...",
    "message": {
      "id": "...",
      "type": "message",
      "role": "assistant",
      "model": "qwen3-coder-plus",
      "content": [
        {
          "type": "text",
          "text": "The capital of France is Paris."
        }
      ],
      "usage": {...}
    },
    "parent_tool_use_id": null
  },
  {
    "type": "result",
    "subtype": "success",
    "uuid": "...",
    "session_id": "...",
    "is_error": false,
    "duration_ms": 1234,
    "result": "The capital of France is Paris.",
    "usage": {...}
  }
]
```

### Stream-JSON Output

Stream-JSON format emits JSON messages immediately as they occur during execution, enabling real-time monitoring. This format uses line-delimited JSON where each message is a complete JSON object on a single line.

```bash
qwen -p "Explain TypeScript" --output-format stream-json
```

Output (streaming as events occur):

```json
{"type":"system","subtype":"session_start","uuid":"...","session_id":"..."}
{"type":"assistant","uuid":"...","session_id":"...","message":{...}}
{"type":"result","subtype":"success","uuid":"...","session_id":"..."}
```

When combined with `--include-partial-messages`, additional stream events are emitted in real-time (message_start, content_block_delta, etc.) for real-time UI updates.

```bash
qwen -p "Write a Python script" --output-format stream-json --include-partial-messages
```

### Input Format

The `--input-format` parameter controls how Qwen Code consumes input from standard input:

- **`text`** (default): Standard text input from stdin or command-line arguments
- **`stream-json`**: JSON message protocol via stdin for bidirectional communication

> **Note:** Stream-json input mode is currently under construction and is intended for SDK integration. It requires `--output-format stream-json` to be set.

### File Redirection

Save output to files or pipe to other commands:

```bash
# Save to file
qwen -p "Explain Docker" > docker-explanation.txt
qwen -p "Explain Docker" --output-format json > docker-explanation.json

# Append to file
qwen -p "Add more details" >> docker-explanation.txt

# Pipe to other tools
qwen -p "What is Kubernetes?" --output-format json | jq '.response'
qwen -p "Explain microservices" | wc -w
qwen -p "List programming languages" | grep -i "python"

# Stream-JSON output for real-time processing
qwen -p "Explain Docker" --output-format stream-json | jq '.type'
qwen -p "Write code" --output-format stream-json --include-partial-messages | jq '.event.type'
```

## Configuration Options

Key command-line options for headless usage:

| Option                       | Description                                         | Example                                                                  |
| ---------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------ |
| `--prompt`, `-p`             | Run in headless mode                                | `qwen -p "query"`                                                        |
| `--output-format`, `-o`      | Specify output format (text, json, stream-json)     | `qwen -p "query" --output-format json`                                   |
| `--input-format`             | Specify input format (text, stream-json)            | `qwen --input-format text --output-format stream-json`                   |
| `--include-partial-messages` | Include partial messages in stream-json output      | `qwen -p "query" --output-format stream-json --include-partial-messages` |
| `--debug`, `-d`              | Enable debug mode                                   | `qwen -p "query" --debug`                                                |
| `--all-files`, `-a`          | Include all files in context                        | `qwen -p "query" --all-files`                                            |
| `--include-directories`      | Include additional directories                      | `qwen -p "query" --include-directories src,docs`                         |
| `--yolo`, `-y`               | Auto-approve all actions                            | `qwen -p "query" --yolo`                                                 |
| `--approval-mode`            | Set approval mode                                   | `qwen -p "query" --approval-mode auto_edit`                              |
| `--continue`                 | Resume the most recent session for this project     | `qwen --continue -p "Pick up where we left off"`                         |
| `--resume [sessionId]`       | Resume a specific session (or choose interactively) | `qwen --resume 123e... -p "Finish the refactor"`                         |

For complete details on all available configuration options, settings files, and environment variables, see the [Configuration Guide](/users/configuration/settings).

## Examples

### Code review

```bash
cat src/auth.py | qwen -p "Review this authentication code for security issues" > security-review.txt
```

### Generate commit messages

```bash
result=$(git diff --cached | qwen -p "Write a concise commit message for these changes" --output-format json)
echo "$result" | jq -r '.response'
```

### API documentation

```bash
result=$(cat api/routes.js | qwen -p "Generate OpenAPI spec for these routes" --output-format json)
echo "$result" | jq -r '.response' > openapi.json
```

### Batch code analysis

```bash
for file in src/*.py; do
    echo "Analyzing $file..."
    result=$(cat "$file" | qwen -p "Find potential bugs and suggest improvements" --output-format json)
    echo "$result" | jq -r '.response' > "reports/$(basename "$file").analysis"
    echo "Completed analysis for $(basename "$file")" >> reports/progress.log
done
```

### PR code review

```bash
result=$(git diff origin/main...HEAD | qwen -p "Review these changes for bugs, security issues, and code quality" --output-format json)
echo "$result" | jq -r '.response' > pr-review.json
```

### Log analysis

```bash
grep "ERROR" /var/log/app.log | tail -20 | qwen -p "Analyze these errors and suggest root cause and fixes" > error-analysis.txt
```

### Release notes generation

```bash
result=$(git log --oneline v1.0.0..HEAD | qwen -p "Generate release notes from these commits" --output-format json)
response=$(echo "$result" | jq -r '.response')
echo "$response"
echo "$response" >> CHANGELOG.md
```

### Model and tool usage tracking

```bash
result=$(qwen -p "Explain this database schema" --include-directories db --output-format json)
total_tokens=$(echo "$result" | jq -r '.stats.models // {} | to_entries | map(.value.tokens.total) | add // 0')
models_used=$(echo "$result" | jq -r '.stats.models // {} | keys | join(", ") | if . == "" then "none" else . end')
tool_calls=$(echo "$result" | jq -r '.stats.tools.totalCalls // 0')
tools_used=$(echo "$result" | jq -r '.stats.tools.byName // {} | keys | join(", ") | if . == "" then "none" else . end')
echo "$(date): $total_tokens tokens, $tool_calls tool calls ($tools_used) used with models: $models_used" >> usage.log
echo "$result" | jq -r '.response' > schema-docs.md
echo "Recent usage trends:"
tail -5 usage.log
```

## Resources

- [CLI Configuration](/users/configuration/settings#command-line-arguments) - Complete configuration guide
- [Authentication](/users/configuration/settings#environment-variables-for-api-access) - Setup authentication
- [Commands](/users/reference/cli-reference) - Interactive commands reference
- [Tutorials](/users/quickstart) - Step-by-step automation guides
