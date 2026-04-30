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
- **Expected format**: UUID format (`^[a-fA-F0-9-]+$`, allows hyphens for standard UUIDs like `2ea864df-ffed-444e-b472-190a8f83b552` or 8-char prefix).
- **Shell metacharacter check**: If the ID contains any of `$` `` ` `` `;` `|` `>` `<` `&` `(` `)` or spaces, **REJECT it immediately**:
  - Output: `"Error: Invalid session ID from index. Aborted."`
  - **DO NOT execute any shell command** with this ID.
- Why: A malicious or corrupt index entry could contain shell commands. This validation prevents command injection attacks.

### 4. Verify Session Belongs to Current Project (Security Critical)

- **Read the first line** of `<runtimeBase>/projects/<sanitizeCwd>/chats/<sessionId>.jsonl`
- Parse the JSON and verify the `project` field matches the current project directory.
- If mismatch: Output `"Error: Session belongs to another project. Aborted."` and stop.
- If file is missing: warn "Session file missing", stop.
- Why: Sanitized project directory names can collide between different projects. Verifying the actual project field prevents resuming a session from another project that happens to share the same sanitized directory name.

**Runtime base resolution** (in priority order):

- `$QWEN_RUNTIME_DIR` (if set)
- `$QWEN_PROJECTS_DIR` (if set)
- `~/.qwen` (default fallback)

### 5. Shell Command Escaping (Security Critical)

When executing the resume command, the session ID **MUST be properly escaped** to prevent shell injection:

| Platform | Escaping Method                                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows  | In the `-Command` argument, escape double quotes in the ID: `"` becomes `\"`. Wrap the whole command in outer double quotes.                                               |
| macOS    | In the `osascript` string, escape double quotes in the ID: `"` becomes `\"`. Use single quotes for the outer osascript string.                                             |
| Linux    | Use single quotes around the ID to prevent all expansion, except for single quotes themselves (which cannot be escaped inside single quotes — use `"'"` concat if needed). |

### 6. Launch New Window with Project Directory (Platform-Specific)

**IMPORTANT: You MUST execute a shell command to launch a NEW terminal window with cd to the project directory first. DO NOT read the .jsonl file content.**

The command must change to the project directory before launching qwen, otherwise the new terminal won't have access to the current project's sessions.

| OS            | Terminal       | Command                                                                                           |
| ------------- | -------------- | ------------------------------------------------------------------------------------------------- |
| Windows       | PowerShell     | `start pwsh -NoExit -Command "cd '<projectRoot>'; qwen --resume <escapedId>"`                     |
| Windows       | CMD (fallback) | `start cmd /k "cd /d <projectRoot> && qwen --resume <escapedId>"`                                 |
| macOS         | Terminal.app   | `osascript -e 'tell app "Terminal" to do script "cd '<projectRoot>'; qwen --resume <escapedId>"'` |
| Linux (GNOME) | gnome-terminal | `gnome-terminal -- bash -c "cd '<projectRoot>' && qwen --resume '<escapedId>'"`                   |
| Linux (other) | xterm          | `xterm -e "cd '<projectRoot>' && qwen --resume '<escapedId>'"`                                    |

**Windows fallback logic**: Try PowerShell first (`start pwsh`). If that fails (e.g., PowerShell not installed or not in PATH), fall back to CMD (`start cmd /k`). Some Windows machines don't have PowerShell available, so CMD fallback ensures compatibility.

**Linux terminal detection**: Don't hardcode `gnome-terminal`. Use `command -v` to check available terminals in order: gnome-terminal > xterm > alacritty > kitty.

**You MUST run the shell command above using your shell tool. This is the core action of the resume operation.**

- Why `--resume` instead of `--continue`: `--resume` takes a specific session ID; `--continue` resumes the most recent session. We know the exact ID, so `--resume` is precise.
- Why new window: Preserves the current session context. The user can have multiple sessions open simultaneously.
- Why cd to project directory: Session storage is project-scoped. Without cd, the new terminal starts in the user's home/default directory where the session cannot be found.

### 7. Confirm

Output: `Session "{{name}}" resumed in new window. (ID: <sessionId>)`
