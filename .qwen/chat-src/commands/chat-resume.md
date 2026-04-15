# chat-resume.md — Resume a Saved Session in a New Window

## What this command does

Looks up a session by its human-readable name, verifies the session file exists, then launches a new Qwen Code terminal window to resume that session.

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

- Read `.qwen/chat-index.json` (project root, NOT `~/.qwen/`)
- Find the value for key `{{name}}`
- If not found: display the list of saved sessions (run `/chat -l` logic), then show a usage hint.
- Why: Users often typo session names; showing available sessions helps them correct the mistake.
- **Important**: The index is stored in the **current project's root directory**, NOT the user's home directory.

### 3. Verify Session File Exists

- Check: `~/.qwen/projects/<hash>/chats/<sessionId>.jsonl`
- If the file is missing: display saved sessions list + warn that session data may have been deleted.
- Why: The index could point to a deleted file (e.g., manual cleanup, disk corruption). We verify before attempting to resume to avoid launching a broken session.

### 4. Launch New Window (Platform-Specific)

**IMPORTANT: You MUST execute a shell command to launch a NEW terminal window. DO NOT read the .jsonl file content.**

The command to open a new terminal differs by OS. Use the OS detected in Step 1 of `chat.md`:

| OS            | Terminal       | Command                                                                       |
| ------------- | -------------- | ----------------------------------------------------------------------------- |
| Windows       | PowerShell     | `start pwsh -NoExit -Command "qwen --resume <sessionId>"`                     |
| Windows       | CMD (fallback) | `start cmd /k "qwen --resume <sessionId>"`                                    |
| macOS         | Terminal.app   | `osascript -e 'tell app "Terminal" to do script "qwen --resume <sessionId>"'` |
| Linux (GNOME) | gnome-terminal | `gnome-terminal -- qwen --resume <sessionId>`                                 |
| Linux (other) | xterm          | `xterm -e "qwen --resume <sessionId>"`                                        |

**Windows fallback logic**: Try PowerShell first (`start pwsh`). If that fails (e.g., PowerShell not installed or not in PATH), fall back to CMD (`start cmd /k`). Some Windows machines don't have PowerShell available, so CMD fallback ensures compatibility.

**Linux terminal detection**: Don't hardcode `gnome-terminal`. Use `command -v` to check available terminals:

```bash
if command -v gnome-terminal &> /dev/null; then
  gnome-terminal -- qwen --resume <sessionId>
elif command -v xterm &> /dev/null; then
  xterm -e "qwen --resume <sessionId>"
elif command -v alacritty &> /dev/null; then
  alacritty -- qwen --resume <sessionId>
elif command -v kitty &> /dev/null; then
  kitty qwen --resume <sessionId>
else
  echo "No supported terminal found. Please run manually: qwen --resume <sessionId>"
fi
```

**You MUST run the shell command above using your shell tool. This is the core action of the resume operation.**

- Why `--resume` instead of `--continue`: `--resume` takes a specific session ID; `--continue` resumes the most recent session. We know the exact ID, so `--resume` is precise.
- Why new window: Preserves the current session context. The user can have multiple sessions open simultaneously.

### 5. Confirm

Output: `Session "{{name}}" is being resumed in a new window. (ID: <sessionId>)`
