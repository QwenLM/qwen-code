# chat-resume.md — Resume a Saved Session

1. Validate `{{name}}` (Common rules): `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`.
2. Look up ID in index (`.qwen/chat-index.json` in project root, NOT `~/.qwen/`). Missing/not found → show list + "Session not found", stop.
3. **Validate loaded ID**: The ID from index must match the expected UUID format (32 hex chars or 8-char prefix). If ID contains any shell metacharacters (`$`, `` ` ``, `;`, `|`, `>`, `<`, `&`, `(`, `)`, spaces), reject it: "Error: Invalid session ID from index. Aborted." — **DO NOT execute any shell command with this ID**.
4. Verify `~/.qwen/projects/<sanitizeCwd>/chats/<id>.jsonl` exists. Missing → warn "Session file missing", stop.
5. **Execute a shell command** to launch a NEW terminal window. Use the shell tool to run these commands:
   - Windows: `start pwsh -NoExit -Command "qwen --resume <escaped_id>"` (escape `<id>` by replacing `"` with `\"` in the id)
   - macOS: `osascript -e 'tell app "Terminal" to do script "qwen --resume <escaped_id>"'` (escape `<id>` by replacing `"` with `\"`)
   - Linux: use `command -v` to detect terminal (gnome-terminal, xterm, alacritty, kitty in order), then run with proper quoting: `gnome-terminal -- qwen --resume '<escaped_id>'` or `xterm -e 'qwen --resume "<escaped_id>"'`
6. Output: `Session "{{name}}" resumed in new window. (ID: <id>)`

**Note**: `<sanitizeCwd>` is the project directory name derived from `sanitizeCwd(projectRoot)`, which replaces all non-alphanumeric characters with `-`. On Windows, the path is also normalized to lowercase before sanitization.
