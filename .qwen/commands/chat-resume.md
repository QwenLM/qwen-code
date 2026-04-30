# chat-resume.md — Resume a Saved Session

1. Validate `{{name}}` (Common rules): `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`.
2. Look up ID in index (`.qwen/chat-index.json` in project root, NOT runtime base). Missing/not found → show list + "Session not found", stop.
3. **Validate loaded ID**: The ID from index must match UUID format (`^[a-fA-F0-9-]+$`, allows hyphens). If ID contains any shell metacharacters (`$`, `` ` ``, `;`, `|`, `>`, `<`, `&`, `(`, `)`, spaces), reject it: "Error: Invalid session ID from index. Aborted." — **DO NOT execute any shell command with this ID**.
4. **Verify session belongs to current project**: Read the first line of `<runtimeBase>/projects/<sanitizeCwd>/chats/<id>.jsonl`. Parse JSON and verify `project` field matches the current project directory. If mismatch → "Error: Session belongs to another project. Aborted." Missing file → warn "Session file missing", stop.
5. Verify `<runtimeBase>/projects/<sanitizeCwd>/chats/<id>.jsonl` exists. Missing → warn "Session file missing", stop.
6. **Execute a shell command** to launch a NEW terminal window with cd to project directory first:
   - Windows: `start pwsh -NoExit -Command "cd '<projectRoot>'; qwen --resume <escaped_id>"` (escape `<id>` by replacing `"` with `\"`)
   - macOS: `osascript -e 'tell app "Terminal" to do script "cd '<projectRoot>'; qwen --resume <escaped_id>"'` (escape `<id>` by replacing `"` with `\"`)
   - Linux: detect terminal with `command -v`, then run with proper quoting: `gnome-terminal -- bash -c "cd '<projectRoot>' && qwen --resume '<escaped_id>'"` or `xterm -e "cd '<projectRoot>' && qwen --resume '<escaped_id>'"`
7. Output: `Session "{{name}}" resumed in new window. (ID: <id>)`

**Runtime Base Resolution** (in priority order):

- `$QWEN_RUNTIME_DIR` (if set)
- `$QWEN_PROJECTS_DIR` (if set)
- `~/.qwen` (default fallback)

**Note**: `<sanitizeCwd>` is the project directory name derived from `sanitizeCwd(projectRoot)`, which replaces all non-alphanumeric characters with `-`. On Windows, the path is also normalized to lowercase before sanitization.
