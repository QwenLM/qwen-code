# Shell Tool (`run_shell_command`)

This document describes the `run_shell_command` tool for Qwen Code.

## Description

Use `run_shell_command` to interact with the underlying system, run scripts, or perform command-line operations. `run_shell_command` executes a given shell command, including interactive commands that require user input (e.g., `vim`, `git rebase -i`) if the `tools.shell.enableInteractiveShell` setting is set to `true`.

On Windows, commands are executed with `cmd.exe /c`. On other platforms, they are executed with `bash -c`.

### Arguments

`run_shell_command` takes the following arguments:

- `command` (string, required): The exact shell command to execute.
- `description` (string, optional): A brief description of the command's purpose, which will be shown to the user.
- `directory` (string, optional): The directory (relative to the project root) in which to execute the command. If not provided, the command runs in the project root.
- `is_background` (boolean, optional): Whether to run the command in background. If not specified, defaults to `false` (foreground execution). Set to true for long-running processes like development servers, watchers, or daemons that should continue running without blocking further commands.

## How to use `run_shell_command` with Qwen Code

When using `run_shell_command`, the command is executed as a subprocess. Whether it runs in the background or in the foreground is controlled by the `is_background` parameter. Do not add a trailing `&` when `is_background: true`: the managed background path is itself the backgrounding mechanism, and the tool rejects the call rather than running it. The tool returns detailed information about the execution, including:

### The `is_background` Parameter

`is_background` is optional — the tool's schema requires only `command` — and when it is omitted the command runs in the foreground. The decision that has to be explicit is therefore the other one: a command that will not stop on its own must be marked `is_background: true`, because leaving it in the foreground blocks the turn until it times out.

### Background vs Foreground Execution

The tool handles background and foreground execution based on that parameter:

**Use background execution (`is_background: true`) for:**

- Long-running development servers: `npm run start`, `npm run dev`, `yarn dev`
- Build watchers: `npm run watch`, `webpack --watch`
- Database servers: `mongod`, `mysql`, `redis-server`
- Web servers: `python -m http.server`, `php -S localhost:8000`
- Any command expected to run indefinitely until manually stopped

**Use foreground execution (the default) for** commands that finish on their own, such as builds, installs, git operations, and test runs.

Reading and searching files are not foreground candidates for this tool at all: use the dedicated tools (`read_file`, `grep_search`, `glob`) instead of `cat`, `grep`, or `find`, which the tool's own description rules out.

### Execution Information

The tool returns detailed information about the execution, including:

- `Command`: The command that was executed.
- `Directory`: The directory where the command was run.
- `Stdout`: Output from the standard output stream.
- `Stderr`: Output from the standard error stream.
- `Error`: Any error message reported by the subprocess.
- `Exit Code`: The exit code of the command.
- `Signal`: The signal number if the command was terminated by a signal.
- `Background PIDs`: A list of PIDs for any background processes started.

Usage:

```bash
run_shell_command(command="Your commands.", description="Your description of the command.", directory="Your execution directory.", is_background=false)
```

**Note:** `is_background` is optional. Omitting it runs the command in the foreground, so the case that needs an explicit `true` is a command that will not stop on its own.

## `run_shell_command` examples

List files in the current directory:

```bash
run_shell_command(command="ls -la", is_background=false)
```

Run a script in a specific directory:

```bash
run_shell_command(command="./my_script.sh", directory="scripts", description="Run my custom script", is_background=false)
```

Start a background development server (recommended approach):

```bash
run_shell_command(command="npm run dev", description="Start development server in background", is_background=true)
```

Note: an explicit `&` is not a managed background mechanism. With `is_background: true` the tool rejects a bare trailing `&` before the command runs; with `is_background=false` the shell detaches the process, so the call returns without the process being tracked — it has no background task entry and `task_stop` cannot reach it. Always use `is_background=true` for a command that should run in the background.

Run a build command in foreground:

```bash
run_shell_command(command="npm run build", description="Build the project", is_background=false)
```

Start multiple background services:

```bash
run_shell_command(command="docker-compose up", description="Start all services", is_background=true)
```

## Configuration

You can configure the behavior of the `run_shell_command` tool by modifying your `settings.json` file or by using the `/settings` command in the Qwen Code.

### Enabling Interactive Commands

The `tools.shell.enableInteractiveShell` setting controls whether shell commands are executed via `node-pty` (interactive PTY) or the plain `child_process` backend. When enabled, interactive sessions such as `vim`, `git rebase -i`, and TUI programs work correctly.

When the setting is omitted, explicit one-shot prompts use `child_process`; interactive TUI, ACP, stream-json input, stdin-only, and file-input sessions use PTY. On Windows builds **<= 19041** (before Windows 10 version 2004), PTY mode falls back to `child_process` because older ConPTY implementations have known reliability issues (missing output, hangs). This matches the same cutoff used by VS Code ([microsoft/vscode#123725](https://github.com/microsoft/vscode/issues/123725)). If `node-pty` is not available at runtime, the tool also falls back to `child_process`.

To explicitly override the default, set the value in `settings.json`:

**Example `settings.json`:**

```json
{
  "tools": {
    "shell": {
      "enableInteractiveShell": true
    }
  }
}
```

### Showing Color in Output

To show color in the shell output, you need to set the `tools.shell.showColor` setting to `true`. **Note: This setting only applies when `tools.shell.enableInteractiveShell` is enabled.**

**Example `settings.json`:**

```json
{
  "tools": {
    "shell": {
      "showColor": true
    }
  }
}
```

### Setting the Pager

You can set a custom pager for the shell output by setting the `tools.shell.pager` setting. The default pager is `cat` on non-Windows platforms. No default is set on Windows. Set `tools.shell.pager` to an empty string to disable pager environment variables. **Note: This setting only applies when `tools.shell.enableInteractiveShell` is enabled.**

**Example `settings.json`:**

```json
{
  "tools": {
    "shell": {
      "pager": "less"
    }
  }
}
```

## Interactive Commands

The `run_shell_command` tool now supports interactive commands by integrating a pseudo-terminal (pty). This allows you to run commands that require real-time user input, such as text editors (`vim`, `nano`), terminal-based UIs (`htop`), and interactive version control operations (`git rebase -i`).

When an interactive command is running, you can send input to it from the Qwen Code. To focus on the interactive shell, press `ctrl+f`. The terminal output, including complex TUIs, will be rendered correctly.

## Important notes

- **Security:** Be cautious when executing commands, especially those constructed from user input, to prevent security vulnerabilities.
- **Error handling:** Check the `Stderr`, `Error`, and `Exit Code` fields to determine if a command executed successfully.
- **Background processes:** Only `is_background=true` starts a tracked background process: the tool returns immediately with the shell id and PID, and the process keeps running. A shell-level `&` does not create one — with `is_background: true` the tool rejects a bare trailing `&`, and with `is_background=false` the shell detaches the command without the tool tracking it.
- **Background execution choices:** The `is_background` parameter is optional (the schema requires only `command`); set `is_background: true` for a command that will not stop on its own, because leaving it in the foreground blocks the turn until it times out. Use `is_background` rather than shell-level `&`; it provides clearer intent and the tool manages the background execution setup.
- **Command descriptions:** When using `is_background=true`, the command description will include a `[background]` indicator to clearly show the execution mode.

## Environment Variables

When `run_shell_command` executes a command, it sets the `QWEN_CODE=1` environment variable in the subprocess's environment. This allows scripts or tools to detect if they are being run from within the CLI.

## Command Restrictions

You can restrict the commands that can be executed by the `run_shell_command` tool by using the `tools.core` and `tools.exclude` settings in your configuration file.

- `tools.core`: To restrict `run_shell_command` to a specific set of commands, add entries to the `core` list under the `tools` category in the format `run_shell_command(<command>)`. For example, `"tools": {"core": ["run_shell_command(git)"]}` will only allow `git` commands. Including the generic `run_shell_command` acts as a wildcard, allowing any command not explicitly blocked.
- `tools.exclude`: To block specific commands, add entries to the `exclude` list under the `tools` category in the format `run_shell_command(<command>)`. For example, `"tools": {"exclude": ["run_shell_command(rm)"]}` will block `rm` commands.

The validation logic is designed to be secure and flexible:

1.  **Command Chaining Disabled**: The tool automatically splits commands chained with `&&`, `||`, or `;` and validates each part separately. If any part of the chain is disallowed, the entire command is blocked.
2.  **Prefix Matching**: The tool uses prefix matching. For example, if you allow `git`, you can run `git status` or `git log`.
3.  **Blocklist Precedence**: The `tools.exclude` list is always checked first. If a command matches a blocked prefix, it will be denied, even if it also matches an allowed prefix in `tools.core`.

### Command Restriction Examples

**Allow only specific command prefixes**

To allow only `git` and `npm` commands, and block all others:

```json
{
  "tools": {
    "core": ["run_shell_command(git)", "run_shell_command(npm)"]
  }
}
```

- `git status`: Allowed
- `npm install`: Allowed
- `ls -l`: Blocked

**Block specific command prefixes**

To block `rm` and allow all other commands:

```json
{
  "tools": {
    "core": ["run_shell_command"],
    "exclude": ["run_shell_command(rm)"]
  }
}
```

- `rm -rf /`: Blocked
- `git status`: Allowed
- `npm install`: Allowed

**Blocklist takes precedence**

If a command prefix is in both `tools.core` and `tools.exclude`, it will be blocked.

```json
{
  "tools": {
    "core": ["run_shell_command(git)"],
    "exclude": ["run_shell_command(git push)"]
  }
}
```

- `git push origin main`: Blocked
- `git status`: Allowed

**Block all shell commands**

To block all shell commands, add the `run_shell_command` wildcard to `tools.exclude`:

```json
{
  "tools": {
    "exclude": ["run_shell_command"]
  }
}
```

- `ls -l`: Blocked
- `any other command`: Blocked

## Security Note for `excludeTools`

Command-specific restrictions in `excludeTools` for `run_shell_command` are based on simple string matching and can be easily bypassed. This feature is **not a security mechanism** and should not be relied upon to safely execute untrusted code. It is recommended to use `coreTools` to explicitly select commands
that can be executed.
