# chat-resume.md — Resume a Saved Session in a New Window

## What this command does

Looks up a session by its human-readable name, verifies the session file exists and belongs to the current project, then launches a new Qwen Code terminal window to resume that session.

## Why this exists

Users save sessions to switch contexts (e.g., different tasks). Resuming in a new window preserves the current session while loading the saved one in parallel.

## Steps

### 1. Validate `{{name}}`

Same rules as `chat-save.md`:

- Regex: `^[a-zA-Z0-9_.-]+$`
- Reserved: `.`, `..`, `__proto__`, `constructor`, `prototype`
- Length: ≤ 128
- Why: Consistency across all sub-commands; prevents injection at every entry point.

### 2. Look Up Session ID

- Read `.qwen/chat-index.json` (project root, NOT runtime base)
- Find the value for key `{{name}}`
- If not found: display the list of saved sessions (run `/chat -l` logic), then show a usage hint.
- Why: Users often typo session names; showing available sessions helps them correct the mistake.
- **Important**: The index is stored in the **current project's root directory**, NOT the runtime base.

### 3. Validate Loaded ID (Security Critical)

- The ID loaded from index **MUST be validated** before being used in any shell command.
- **Expected format**: UUID format (`^[a-fA-F0-9-]+$`, allows hyphens for standard UUIDs like `2ea864df-ffed-444e-b472-190a8f83b552`).
- **Shell metacharacter check**: If the ID contains any of `$` `` ` `` `;` `|` `>` `<` `&` `(` `)` or spaces, **REJECT it immediately**:
  - Output: `"Error: Invalid session ID from index. Aborted."`
  - **DO NOT execute any shell command** with this ID.
- Why: A malicious or corrupt index entry could contain shell commands. This validation prevents command injection attacks.

### 4. Get Session Project Directory (Security Critical)

- **Read the first line** of `<runtimeBase>/projects/<sanitizeCwd>/chats/<sessionId>.jsonl`
- Handle edge cases:
  - File missing → "Session file missing", stop.
  - File 0 bytes (interrupted write) → "Session file empty (likely interrupted save). Aborted.", stop.
  - First line not valid JSON (truncated) → "Session file corrupt at line 1. Aborted.", stop.
  - JSON has no `cwd` field → "Session record missing project context. Aborted.", stop.
- Set `<projectRoot>` = the `cwd` field value from the JSON record
- Verify `<projectRoot>` directory exists on disk. Missing → "Error: original project directory '<projectRoot>' no longer exists. Aborted.", stop.

### 5. Verify Session Belongs to Current Project (Security Critical)

- Apply `sanitizeCwd(<projectRoot>)` to the cwd field value
- Compare with current project's `<sanitizeCwd>`
- If they don't match → "Error: Session belongs to another project. Aborted.", stop.

**Limitation note**: chat-resume uses `sanitizeCwd()` for project comparison. The core SessionService uses SHA-256 hash (`getProjectHash()`) for all project-ownership checks. `sanitizeCwd()` is not collision-resistant — two different paths can produce the same sanitized form (e.g., `/home/a-b/c` and `/home/a/b-c` both become `home-a-b-c`). This is a known limitation of file-based commands.

**Runtime base resolution** (in priority order):

- `$QWEN_RUNTIME_DIR` (if set)
- `~/.qwen` (default fallback)

**Note**: If user has configured `advanced.runtimeOutputDir` in settings.json, sessions are stored under that path. /chat commands cannot read settings.json (credential leak risk) and will not find those sessions.

### 6. Validate projectRoot for Shell Safety (Security Critical)

Before executing any shell command, validate `<projectRoot>`:

- **POSIX platforms** (macOS, Linux): If `<projectRoot>` contains `$`, `` ` ``, `;`, `|`, `>`, `<`, `&`, `(`, `)`, or spaces → "Error: Session path contains unsafe characters. Aborted."
- **Windows**: If `<projectRoot>` contains `$`, `` ` ``, `;`, `|`, `>`, `<`, `&`, `(`, `)`, spaces, `^`, or `%` → "Error: Session path contains unsafe characters. Aborted."

Why: The session ID is validated but `<projectRoot>` from the cwd field could contain shell metacharacters (e.g., path with spaces or single quotes). Without this check, commands could fail or behave unexpectedly.

### 7. Shell Command Escaping (Security Critical)

When executing the resume command, paths **MUST be properly escaped**:

| Platform | Escaping Method                                                  |
| -------- | ---------------------------------------------------------------- | ------------------- |
| Windows  | Use double quotes around paths, escape inner quotes              |
| macOS    | Use single quotes, escape internal single quotes via `$(echo ... | sed "s/'/\\\\'/g")` |
| Linux    | Use single quotes around paths                                   |

### 8. Launch New Window with Project Directory (Platform-Specific)

**IMPORTANT: You MUST execute a shell command to launch a NEW terminal window with cd to the project directory first. DO NOT read the .jsonl file content.**

The command must change to the project directory before launching qwen, otherwise the new terminal won't have access to the current project's sessions.

| OS          | Terminal       | Command                                                                                                                                                                                                                                                                                                |
| ----------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------- |
| Windows     | PowerShell     | `start pwsh -NoExit -Command "cd '<projectRoot>'; qwen --resume <id>"`                                                                                                                                                                                                                                 |
| Windows     | CMD (fallback) | `start cmd /k "cd /d \"<projectRoot>\" && qwen --resume <id>"`                                                                                                                                                                                                                                         |
| macOS       | Terminal.app   | `osascript -e "tell app \"Terminal\" to do script \"cd '$(echo "<projectRoot>"                                                                                                                                                                                                                         | sed "s/'/\\\\'/g")' && qwen --resume <id>\""` |
| Linux       | gnome-terminal | `gnome-terminal -- bash -c "cd '<projectRoot>' && qwen --resume <id>"`                                                                                                                                                                                                                                 |
| Linux       | xterm          | `xterm -e "cd '<projectRoot>' && qwen --resume <id>"`                                                                                                                                                                                                                                                  |
| Linux (WSL) | CMD            | If platform is linux and /proc/version contains "Microsoft" or "WSL": First convert Linux path to Windows path using `wslpath -w "<projectRoot>"`, then use `cmd.exe /c "start cmd /k cd /d \"<windowsPath>\" && qwen --resume <id>"` or prefer `wt.exe -d "<windowsPath>" -- qwen.exe --resume <id>"` |

**Windows fallback logic**: Try PowerShell first (`start pwsh`). If that fails (e.g., PowerShell not installed), fall back to CMD (`start cmd /k`). Some Windows machines don't have PowerShell available, so CMD fallback ensures compatibility.

**WSL handling**: WSL users are actually on Windows. The JSONL file stores the Linux-native path (e.g., `/home/user/project`). When resuming in WSL, you must convert the path to Windows format first using `wslpath -w`, otherwise `cd /d` will fail with "The system cannot find the path specified."

**Linux terminal detection**: Use `command -v` to check available terminals in order: gnome-terminal > xterm > alacritty > kitty.

**You MUST run the shell command above using your shell tool. This is the core action of the resume operation.**

- Why `--resume` instead of `--continue`: `--resume` takes a specific session ID; `--continue` resumes the most recent session. We know the exact ID, so `--resume` is precise.
- Why new window: Preserves the current session context. The user can have multiple sessions open simultaneously.
- Why cd to project directory: Session storage is project-scoped. Without cd, the new terminal starts in the user's home/default directory where the session cannot be found.
- Why cd to projectRoot from session's cwd: The session was originally created in its own project directory. Using that cwd ensures qwen loads the correct project context.

### 9. Confirm

Output: `Session "{{name}}" resumed in new window. (ID: <sessionId>)`
