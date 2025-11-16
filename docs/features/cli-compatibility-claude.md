# Qwen Code - Claude Code CLI Compatibility

## Compatibility Overview

Qwen Code provides a Claude Code CLI compatibility layer through the `qwen-alt` alias. This compatibility layer allows Claude Code users to leverage their existing command patterns while gaining access to Qwen Code's enhanced functionality.

## Installation

The `qwen-alt` alias can be installed using the script provided with Qwen Code:

```bash
# Run the alias creation script
./scripts/create_alias.sh

# Select option 2: qwen-alt (Qwen CLI with Claude compatibility adapter)
# This will add the alias to your shell configuration file
```

Alternatively, you can create the alias manually:

```bash
# For bash/zsh
alias qwen-alt='node /path/to/qwen-code/scripts/claude-adapter.js'
```

## CLI Argument Mapping

Claude Code arguments are mapped to Qwen Code equivalents:

| Claude Code Argument                   | Qwen Code Equivalent             | Description                                         |
| -------------------------------------- | -------------------------------- | --------------------------------------------------- |
| `--print`                              | `-p` or `--print`                | Print response and exit (non-interactive mode)      |
| `-p`                                   | `-p`                             | Print response and exit (non-interactive mode)      |
| `--allowed-tools`                      | `--allowed-tools`                | Comma-separated list of tools to allow              |
| `--allowedTools`                       | `--allowed-tools`                | Comma-separated list of tools to allow              |
| `--disallowedTools`                    | `--exclude-tools`                | Comma-separated list of tools to deny               |
| `--permission-mode`                    | `--approval-mode`                | Permission mode to use for the session              |
| `--model`                              | `-m` or `--model`                | Model for the current session                       |
| `--session-id`                         | `--session-id`                   | Session identifier                                  |
| `--settings`                           | `--settings`                     | Path to settings JSON file                          |
| `--append-system-prompt`               | `--append-system-prompt`         | Append a system prompt to the default system prompt |
| `--permission-mode yolo`               | `--approval-mode yolo`           | Bypass all permission checks                        |
| `--dangerously-skip-permissions`       | `--dangerously-skip-permissions` | Bypass all permission checks                        |
| `--allow-dangerously-skip-permissions` | `--dangerously-skip-permissions` | Bypass all permission checks                        |
| `--include-directories`                | `--include-directories`          | Additional directories to allow tool access to      |
| `--continue`                           | `--continue`                     | Continue an existing session                        |
| `--resume`                             | `--resume`                       | Resume a previous session                           |
| `--output-format`                      | `--output-format`                | Output format (text, json, stream-json)             |
| `--input-format`                       | `--input-format`                 | Input format (text, stream-json)                    |
| `--mcp-config`                         | `--mcp-config`                   | MCP server configuration                            |
| `--replay-user-messages`               | `--replay-user-messages`         | Replay user messages                                |
| `--fork-session`                       | `--fork-session`                 | Fork an existing session                            |
| `--fallback-model`                     | `--fallback-model`               | Fallback model to use                               |
| `--add-dir`                            | `--add-dir`                      | Add directories to tool access                      |

## Removed Arguments

The following arguments have been removed as they were incorrect or deprecated:

| Removed Argument  | Replacement              | Reason                                   |
| ----------------- | ------------------------ | ---------------------------------------- |
| `--system-prompt` | `--append-system-prompt` | Alias was incorrect and has been removed |

## Tool Name Mapping

Claude Code tool names are mapped to Qwen Code equivalents:

| Claude Code Tool | Qwen Code Equivalent |
| ---------------- | -------------------- |
| `Write`          | `write_file`         |
| `Edit`           | `replace`            |
| `Bash`           | `run_shell_command`  |
| `Read`           | `read_file`          |
| `Grep`           | `grep`               |
| `Glob`           | `glob`               |
| `Ls`             | `ls`                 |
| `WebSearch`      | `web_search`         |
| `WebFetch`       | `web_fetch`          |
| `TodoWrite`      | `todo_write`         |
| `NotebookEdit`   | `edit_notebook`      |

## Claude-Compatible Commands

### Basic Usage

```bash
# Non-interactive mode (equivalent to Claude's -p)
qwen-alt -p "Explain this codebase"

# Interactive mode (default behavior)
qwen-alt

# Use with specific model
qwen-alt -m claude-sonnet-4-5-20250929 "Generate unit tests"
```

### Tool Permissions

```bash
# Allow specific tools
qwen-alt --allowed-tools read_file,write_file "Modify the user service"

# Use comma-separated values
qwen-alt --allowed-tools "Bash(git:*) Edit" "Perform git operations"

# Specify tools with access patterns
qwen-alt --allowed-tools "read_file(src/**/*)" "Read files from src directory"
```

### Permission Modes

```bash
# Use YOLO mode (bypass all permissions)
qwen-alt --approval-mode yolo "Perform changes without asking"

# Use specific permission mode
qwen-alt --approval-mode acceptEdits "Allow edit operations"

# Skip all permissions (for sandboxed environments)
qwen-alt --dangerously-skip-permissions "Execute without prompts"
```

### System Prompt Customization

```bash
# Append a system prompt to the default system prompt
qwen-alt --append-system-prompt "Focus on security and performance" "Analyze this code"

# Use with print mode for headless operations
qwen-alt -p --append-system-prompt "Focus on potential bugs" "Analyze security issues"
```

### Output Formats

```bash
# JSON output format
qwen-alt -p --output-format json "Generate a report"

# Streaming JSON output (for programmatic use)
qwen-alt -p --output-format stream-json "Generate content"

# Text output format (default)
qwen-alt -p --output-format text "Generate content"
```

### Input Formats

```bash
# Stream JSON input format (for programmatic input)
qwen-alt -p --input-format stream-json < input.ndjson

# Text input format (default)
qwen-alt -p --input-format text "Regular input"
```

### Additional Options

```bash
# Include specific directories for tool access
qwen-alt --add-dir /custom/path --add-dir /another/path "Work with custom paths"

# Configure additional settings
qwen-alt --settings /path/to/settings.json "Use custom settings"

# Continue a previous session
qwen-alt --continue session-id-123 "Continue session"
```

## JSON Streaming Mode

Qwen Code supports Claude-compatible JSON streaming via `--output-format stream-json`. This format outputs newline-delimited JSON objects as content is generated, ideal for programmatic consumption:

### Stream Format

Events are output as newline-delimited JSON objects:

```json
{"type": "message_start", "message": {"id": "message_id", "model": "model_name"}}
{"type": "content_block_delta", "text": "chunk of content"}
{"type": "content_block_delta", "text": "more content"}
{"type": "message_stop", "stop_reason": "stop_turn", "usage": {"input_tokens": 10, "output_tokens": 25}}
```

### Supported Event Types

- `message_start`: When message generation begins
- `content_block_delta`: When new content chunks arrive
- `message_stop`: When message generation completes
- `tool_call`: When a tool is called

### Usage Examples

```bash
# Stream output for real-time processing
qwen-alt -p "Explain quantum computing" --output-format stream-json

# Process streaming output with jq
qwen-alt -p "Generate a list" --output-format stream-json | jq -c 'select(.type == "content_block_delta") | .text'

# Process streaming output in a shell loop
qwen-alt -p "Write code" --output-format stream-json | while read line; do
  echo "Received: $line"
done
```

## Configuration

The Claude adapter uses configuration files for mapping arguments and tools:

### Argument Mappings

Argument mappings are defined in `config/claude-adapter-config.json`:

```json
{
  "argumentMappings": {
    "--print": ["-p"],
    "--allowed-tools": ["--allowed-tools"],
    "--permission-mode": ["--approval-mode"],
    "--model": ["-m"]
    // ... other mappings
  },
  "toolNameMappings": {
    "Write": "write_file",
    "Edit": "replace"
    // ... other tool mappings
  }
}
```

### Custom Mappings

You can customize the mappings by modifying the configuration file. New mappings can be added to support additional Claude Code features or custom arguments.

## Error Handling

- Arguments that don't map to Qwen Code equivalents are passed through unchanged
- Invalid arguments are handled by the underlying Qwen Code CLI
- Configuration errors are logged and default mappings are used
- The adapter preserves Claude Code's exit codes and error reporting behavior

## Advanced Usage

### MCP Integration

Manage MCP servers using Claude-compatible commands:

```bash
# Configure MCP servers
qwen-alt mcp --mcp-config /path/to/config.json
```

### Debugging

Enable debug mode to see argument transformations:

```bash
# Enable debug mode
qwen-alt --debug "Debug command"
```

## Limitations

- Not all Claude Code features may be fully supported
- Some advanced Claude Code workflows may require manual adjustments
- Custom Claude Code tools not available in Qwen Code will not function
- MCP-specific features may behave differently than in Claude Code
