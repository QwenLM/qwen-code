# chat-resume.md — Resume a Saved Session

**Note**: Direct invocation (`/chat-resume name`) bypasses the router's argument parsing, locale detection, and name validation. Use `/chat -r name` instead.

1. Validate `{{name}}` (Common rules): `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`.
2. Look up ID in index (`.qwen/chat-index.json` in project root, NOT runtime base). **JSON parse error → output `"chat-index.json is malformed. Fix it manually before resuming."` and stop. Do NOT proceed.** Missing/not found → show list + "Session not found", stop.
3. **Validate loaded ID**: The ID from index must match UUID format (`^[a-fA-F0-9-]+$`, allows hyphens). If ID contains any shell metacharacters (`$`, `` ` ``, `;`, `|`, `>`, `<`, `&`, `(`, `)`, spaces), reject it: "Error: Invalid session ID from index. Aborted." — **DO NOT execute any shell command with this ID**.
4. **Get session project directory**: Read the first line of `<runtimeBase>/projects/<sanitizeCwd>/chats/<id>.jsonl`.
   - File missing → "Session file missing", stop.
   - File 0 bytes → "Session file empty (likely interrupted save). Aborted.", stop.
   - First line not valid JSON → "Session file corrupt at line 1. Aborted.", stop.
   - JSON has no `cwd` field → "Session record missing project context. Aborted.", stop.
   - Set `<projectRoot>` = the `cwd` field value from the JSON record.
   - Verify `<projectRoot>` directory exists on disk. Missing → "Error: original project directory '<projectRoot>' no longer exists. Aborted.", stop.
5. **Verify session belongs to current project**: Apply `sanitizeCwd(<projectRoot>)` and compare with current project's `<sanitizeCwd>`. If they don't match → "Error: Session belongs to another project. Aborted.", stop.

   **Limitation note**: chat-resume uses sanitizeCwd for project comparison. Both these commands and the core SessionService use `sanitizeCwd` for session directory resolution. The collision risk (e.g., `/home/a-b/c` and `/home/a/b-c` both produce `home-a-b-c`) is inherent in the sanitizeCwd algorithm itself, not a mismatch between layers.

6. **Validate projectRoot for shell safety**: <projectRoot> must match `^[a-zA-Z0-9/._-]+$` — reject any path containing characters outside this set. Reject: "Error: Session path contains unsafe characters. Aborted."
   - For Windows: also reject `^`, `%`, `\`
   - This whitelist approach prevents command injection via metacharacters like $, `, ;, |, >, <, &, (, ), ', ", \, and newlines.
7. **Execute a shell command** to launch a NEW terminal window with cd to project directory:
   - Windows (PowerShell): `start pwsh -NoExit -Command "cd '<projectRoot>'; qwen --resume <id>"`
   - Windows (CMD fallback): `start cmd /k "cd /d \"<projectRoot>\" && qwen --resume <id>"` (use if PowerShell unavailable)
   - macOS: `osascript -e "tell app \"Terminal\" to do script \"cd '$(echo "<projectRoot>" | sed "s/'/'\\\\''/g")' && qwen --resume <id>\""`
   - Linux (WSL): If platform is linux and `/proc/version` contains "Microsoft" or "WSL":
     - Convert path: Run `wslpath -w "<projectRoot>"` to get Windows path
     - Use: `cmd.exe /c "start cmd /k cd /d \"<windowsPath>\" && qwen --resume <id>"` or prefer `wt.exe -d "<windowsPath>" -- qwen.exe --resume <id>`
   - Linux (native): detect terminal with `command -v` (gnome-terminal, xterm, alacritty, kitty in order), then run: `<terminal> -- bash -c "cd '<projectRoot>' && qwen --resume <id>"`
8. Output: `Session "{{name}}" resumed in new window. (ID: <id>)`

**Runtime Base Resolution** (in priority order):

- `$QWEN_RUNTIME_DIR` (if set)
- `~/.qwen` (default fallback)

**Note**: If user has configured `advanced.runtimeOutputDir` in settings.json, sessions are stored under that path. /chat commands cannot read settings.json (credential leak risk) and will not find those sessions.

**Note**: `<sanitizeCwd>` is the project directory name derived from `sanitizeCwd(projectRoot)`, which replaces all non-alphanumeric characters with `-`. On Windows, the path is also normalized to lowercase before sanitization.
