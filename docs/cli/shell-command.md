# Shell Command (`/shell`)

The `/shell` command provides a direct interface to execute shell commands within the Qwen Code CLI environment.

## Usage

```
/shell <command>
```

## Description

The `/shell` command is a convenient slash command that allows you to run any shell command directly from the Qwen Code CLI. It acts as a wrapper around the `run_shell_command` tool, making it easier to execute shell commands without needing to invoke the tool directly.

## Examples

### Basic command execution
```
/shell ls -la
```

### Running build scripts
```
/shell npm run build
```

### Git operations
```
/shell git status
```

### Directory operations
```
/shell mkdir new-folder
```

### System commands
```
/shell echo "Hello, World!"
```

## Behavior

- **Foreground execution**: All commands run in the foreground by default (not as background processes)
- **Current directory**: Commands execute in the current working directory
- **Error handling**: Uses the same error handling and output display as the underlying `run_shell_command` tool
- **Security**: Subject to the same security restrictions and command filtering as other shell tools
- **Usage message**: Shows usage information when no command is provided

## Comparison with other shell interfaces

| Interface | Usage | Background execution | Interactive |
|-----------|-------|---------------------|-------------|
| `/shell` | `/shell <command>` | No | No |
| `!` prefix | `!<command>` | No | Yes |
| `run_shell_command` tool | Via AI model | Configurable | No |

## Security considerations

The `/shell` command is subject to the same security restrictions as the `run_shell_command` tool:

- Commands may require user confirmation based on configuration
- Certain commands may be blocked by `excludeTools` configuration
- Commands are restricted by `coreTools` configuration if specified
- The `QWEN_CODE=1` environment variable is set during execution

## Implementation details

- Built as a standard slash command (`CommandKind.BUILT_IN`)
- Returns a `ToolActionReturn` that invokes `run_shell_command`
- Automatically sets `is_background: false` for all executions
- Provides descriptive messages for each command execution
