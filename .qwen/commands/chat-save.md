# chat-save.md — Save Current Session

1. Validate `{{name}}`: `^[a-zA-Z0-9_.-]+$`, ≤128, ≠ `.`/`..`/`__proto__`/`constructor`/`prototype`. Invalid → error, stop.
2. Read `.qwen/chat-index.json` (project root, NOT `~/.qwen/`). File not found → `{}`. **JSON parse error → output `"chat-index.json is malformed. Fix it manually before saving."` and stop. Do NOT overwrite.**
3. If `{{name}}` in index → ask "Overwrite? (yes/no)". ≠ yes → stop.
4. Session ID = **newest `.jsonl` file by modification time** in `~/.qwen/projects/<sanitizeCwd>/chats/`. The filename (without `.jsonl`) IS the session UUID. ⚠️ **IMPORTANT**: If wrong session is saved, resume the target session first, then run `/chat -s`. No .jsonl found → "No session found. Start a conversation first.", stop.
5. Add or update `{{name}}` key in existing index object. Write back (2-space indent, ensure `.qwen/` exists).
6. Output: `Saved: {{name}} → <id>` (or `Overwritten: ...`)

**Note**: `<sanitizeCwd>` is the project directory name derived from `sanitizeCwd(projectRoot)`, which replaces all non-alphanumeric characters with `-`. On Windows, the path is also normalized to lowercase before sanitization. E.g., `D:\code\my-project` → `d--code-my-project`.
