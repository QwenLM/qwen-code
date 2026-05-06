# chat-save.md — Save Current Session

**Note**: Direct invocation (`/chat-save name`) bypasses the router's argument parsing, locale detection, and name validation. Use `/chat -s name` instead.

1. Validate `{{name}}`: `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`. Invalid → error, stop.
2. Read `.qwen/chat-index.json` (project root, NOT runtime base). File not found → `{}`. **JSON parse error → output `"chat-index.json is malformed. Fix it manually before saving."` and stop. Do NOT overwrite.**
3. If `{{name}}` in index → ask "Overwrite? (yes/no)". ≠ yes → stop.
4. Session ID = **newest `.jsonl` file by modification time** in `<runtimeBase>/projects/<sanitizeCwd>/chats/`. The filename (without `.jsonl`) IS the session UUID. ⚠️ **IMPORTANT**: If wrong session is saved, resume the target session first, then run `/chat -s`. No .jsonl found → "No session found. Start a conversation first.", stop.
5. **Verify session belongs to current project**: Read the first line of the selected `.jsonl` file.
   - If JSON has no `cwd` field → skip verification (legacy session, allow save).
   - Apply `sanitizeCwd(<cwd>)` and compare with current project's `<sanitizeCwd>`. If they don't match → "Error: Selected session belongs to another project. Aborted. Please resume the session from its original project first.", stop.
6. Add or update `{{name}}` key in existing index object. Write back (2-space indent, ensure `.qwen/` exists).
7. Output: `Saved: {{name}} → <id>` (or `Overwritten: ...`)

**Runtime Base Resolution** (in priority order):

- `$QWEN_RUNTIME_DIR` (if set)
- `~/.qwen` (default fallback)

**Note**: If user has configured `advanced.runtimeOutputDir` in settings.json, sessions are stored under that path. /chat commands cannot read settings.json (credential leak risk) and will not find those sessions.

**Note**: `<sanitizeCwd>` is the project directory name derived from `sanitizeCwd(projectRoot)`, which replaces all non-alphanumeric characters with `-`. On Windows, the path is also normalized to lowercase before sanitization. E.g., `D:\code\my-project` → `d--code-my-project`.
